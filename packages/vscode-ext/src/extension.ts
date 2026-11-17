import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ChatController, DEFAULT_SETTINGS, DEFAULT_SYSTEM, describeServer, serverFingerprint, type ControllerSettings, type McpServerConfig, type PowerInfo, type UiMessage } from '@bluecheese/core';

type ToWebview = UiMessage
  | { type: 'prefill'; text: string }
  | { type: 'schema'; fields: Field[]; values: Record<string, unknown> }
  | { type: 'values'; values: Record<string, unknown> }
  | { type: 'project'; name: string; path: string; note?: string };

/** What the webview may ask for. Anything else is ignored. */
interface FromWebview {
  type: string; text?: string; key?: string; value?: unknown; on?: boolean;
  id?: string; title?: string; name?: string; enabled?: boolean; decision?: string;
}

/** One settings control in the webview, derived from the manifest so there is a single source of truth. */
interface Field {
  key: string; label: string; description: string; group: string;
  type: 'boolean' | 'string' | 'number' | 'integer' | 'array';
  /** A long text edited in a text area (the system prompt) rather than a one-line box. */
  multiline?: boolean;
  /** What an empty text means (shown as the placeholder and by "Restore default"). */
  defaultText?: string;
  /** A fixed list of choices (a drop-down), with the labels to show. */
  enum?: string[]; enumLabels?: string[];
  /** min/max as VS Code validates them (special values such as -1 included); numMin = lowest ordinary number. */
  min?: number; max?: number; step?: number; numMin?: number; numDefault?: number;
  /** Slider next to the number box: only for continuous values (marked x-slider in the manifest). */
  slider: boolean;
  /** Values that are not ordinary numbers, such as -1 = Unlimited. */
  special: { value: number; label: string }[];
  /** live: applied at once, even mid-question; question: next question; reset: next conversation (after Reset); restart: needs a restart. */
  applies: 'live' | 'question' | 'reset' | 'restart';
  /** false: not in the settings list (the control is somewhere else, e.g. the Think toggle). */
  panel: boolean;
  default: unknown;
}

const OFF: PowerInfo = { state: 'off', detail: 'Off' };

function config(): vscode.WorkspaceConfiguration { return vscode.workspace.getConfiguration('bluecheese'); }

function readSettings(): ControllerSettings {
  const c = config();
  const get = <T>(key: string, fallback: T): T => c.get<T>(key) ?? fallback;
  const D = DEFAULT_SETTINGS;
  return {
    baseUrl: get<string>('baseUrl', '') || undefined,
    runtime: {
      image: get('docker.image', 'roaster:dev'),
      socketDir: get('docker.socketDir', '/tmp/roaster'),
      basePort: get('docker.basePort', 8080),
      maxApis: get('docker.maxApis', 3),
    },
    slots: get('slots', D.slots),
    helpers: {
      enabled: get('helpers.enabled', D.helpers.enabled),
      context: get('helpers.context', D.helpers.context),
      maxSteps: get('helpers.maxSteps', D.helpers.maxSteps),
      branches: get('helpers.branches', D.helpers.branches),
    },
    profile: {
      context: get('api.context', 16384),
      maxTokens: get('api.maxTokens', 1024),
      cacheRoute: get('api.cacheRoute', true),
      routeJ: get('api.routeJ', 2),
      routeM: get('api.routeM', 12),
      routeAlpha: get('api.routeAlpha', 1),
      routeP: get('api.routeP', 0),
      slide: get('api.slide', true),
      keep: get('api.keep', 64),
    },
    maxSteps: get('maxSteps', D.maxSteps),
    observationBytes: get('observationBytes', D.observationBytes),
    maxTokens: get('answerTokens', 1500),
    temperature: get('temperature', 0.2),
    topP: get('topP', 0.95),
    topK: get('topK', 20),
    think: get('think', false),
    idleMinutes: get('idleMinutes', D.idleMinutes),
    systemPrompt: get<string>('systemPrompt', ''),
    tools: { disabled: get<string[]>('tools.disabled', []) },
    edits: { approval: get('edits.approval', D.edits.approval) },
    mcp: {
      enabled: get('mcp.enabled', D.mcp.enabled),
      approval: get('mcp.approval', D.mcp.approval),
      resultBytes: get('mcp.resultBytes', D.mcp.resultBytes),
      promptBytes: get('mcp.promptBytes', D.mcp.promptBytes),
      autoApprove: get<string[]>('mcp.autoApprove', []),
    },
    chats: {
      serverDir: get('chats.serverDir', D.chats.serverDir),
      saveContext: get('chats.saveContext', D.chats.saveContext),
      reuseSystemPrompt: get('chats.reuseSystemPrompt', D.chats.reuseSystemPrompt),
      hostDir: get<string>('chats.hostDir', '') || undefined,
    },
  };
}

const humanize = (s: string) => s.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private controller?: ChatController;
  private pendingFocus?: string;
  private fields: Field[] = [];

  constructor(
    private readonly ext: vscode.ExtensionContext,
    private readonly out: vscode.OutputChannel,
    private readonly onPower: (info: PowerInfo) => void,
  ) {
    this.fields = this.loadFields();
  }

  /** Why there is no project folder (shown to the user), when `workspaceRoot` is undefined. */
  private problem = 'Open a folder first: BlueCheese works on the project in the current workspace.';

  /** The setting "Project folder" if set, otherwise the folder open in VS Code. */
  get workspaceRoot(): string | undefined {
    const custom = (config().get<string>('projectRoot', '') ?? '').trim();
    if (custom) {
      const abs = path.resolve(custom.startsWith('~') ? path.join(os.homedir(), custom.slice(1)) : custom);
      try { if (fs.statSync(abs).isDirectory()) return abs; } catch { /* handled below */ }
      this.problem = `The "Project folder" setting points to a folder that does not exist: ${custom}`;
      return undefined;
    }
    this.problem = 'Open a folder first: BlueCheese works on the project in the current workspace.';
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** Tell the panel which folder is being analyzed. */
  postProject(): void {
    const root = this.workspaceRoot;
    this.post(root ? { type: 'project', name: path.basename(root), path: root } : { type: 'project', name: '', path: '', note: this.problem });
  }

  /** The "Project folder" setting or the open folder changed: drop the old conversation and API. */
  async rootChanged(): Promise<void> {
    const root = this.workspaceRoot;
    if (this.controller && this.controller.root !== root) {
      const old = this.controller;
      this.controller = undefined;
      await old.dispose();
      this.onPower({ state: 'off', detail: 'Off' });
      this.post({ type: 'power', info: { state: 'off', detail: 'Off' } });
      this.post({ type: 'status', text: 'The project folder changed: connection closed.' });
      this.postProject();
      if (root) this.getController()?.init(); // the other folder has its own chats
      return;
    }
    this.postProject();
  }

  get powerInfo(): PowerInfo { return this.controller?.powerInfo ?? OFF; }

  /** One controller per window, created on first use so activation stays cheap. */
  getController(): ChatController | undefined {
    const root = this.workspaceRoot;
    if (!root) { this.post({ type: 'error', text: this.problem }); return undefined; }
    this.controller ??= new ChatController(root, readSettings, (m) => {
      if (m.type === 'status' || m.type === 'error' || m.type === 'progress') this.out.appendLine(`[${m.type}] ${m.text}`);
      else if (m.type === 'power') this.out.appendLine(`[power] ${m.info.state}: ${m.info.detail}`);
      if (m.type === 'power') {
        this.onPower(m.info);
        // remembered so the next VS Code start can switch on again (see autoStart)
        if (m.info.state === 'on') void this.ext.globalState.update('bluecheese.powerOn', true);
        if (m.info.state === 'off') void this.ext.globalState.update('bluecheese.powerOn', false);
      }
      this.post(m);
    }, {
      confirmMcpServer: (name, cfg, file) => this.confirmMcp(name, cfg, file),
      addAutoApprove: (tool) => {
        const cur = config().get<string[]>('mcp.autoApprove', []);
        if (!cur.includes(tool)) void config().update('mcp.autoApprove', [...cur, tool], vscode.ConfigurationTarget.Global);
      },
      log: (l) => this.out.appendLine(`[mcp] ${l}`),
    });
    return this.controller;
  }

  peekController(): ChatController | undefined { return this.controller; }

  /**
   * An MCP server runs a command on this computer (or contacts a URL), so a config file alone is not enough:
   * the person allows each server once; a changed command, URL or environment asks again.
   */
  private async confirmMcp(name: string, cfg: McpServerConfig, file: string): Promise<boolean> {
    if (!vscode.workspace.isTrusted) {
      this.out.appendLine(`[mcp] ${name}: not started, this workspace is not trusted`);
      return false;
    }
    const fp = serverFingerprint(name, cfg), key = 'bluecheese.mcpTrusted';
    const known = this.ext.globalState.get<string[]>(key, []);
    if (known.includes(fp)) return true;
    const pick = await vscode.window.showWarningMessage(
      `BlueCheese wants to start the MCP server "${name}" (from ${file}).`,
      { modal: true, detail: `${cfg.url ? 'It will connect to' : 'It will run'}:\n${describeServer(cfg)}\n\nOnly allow servers you trust: a server can read your files and run code with your permissions.` },
      'Allow',
    );
    if (pick !== 'Allow') return false;
    await this.ext.globalState.update(key, [...known, fp].slice(-200));
    return true;
  }

  /**
   * "Run to the end": no reply limit, no tool-step limit, file changes without a prompt. Turning it on asks once (it lets the
   * model change files unattended) and remembers the old values; turning it off puts them back.
   */
  async setAutoRun(on: boolean): Promise<void> {
    const key = 'bluecheese.autoPrev', cfg = config();
    const set = async (k: string, v: unknown) => cfg.update(k, v, vscode.ConfigurationTarget.Global);
    if (on) {
      const pick = await vscode.window.showWarningMessage(
        'Run to the end?',
        { modal: true, detail: 'The model will run until it finishes: no limit on reply length or tool calls, and it will create and change files in your project WITHOUT asking. You can still press Stop at any time.\n\nThere is no undo: have the project in git first.' },
        'Turn on',
      );
      if (pick !== 'Turn on') { this.post({ type: 'values', values: this.currentValues() }); return; }
      const prev = this.ext.globalState.get<Record<string, unknown>>(key);
      if (!prev) await this.ext.globalState.update(key, { answerTokens: cfg.get('answerTokens'), maxSteps: cfg.get('maxSteps'), 'edits.approval': cfg.get('edits.approval') });
      await set('answerTokens', -1); await set('maxSteps', -1); await set('edits.approval', 'never');
    } else {
      const prev = this.ext.globalState.get<Record<string, unknown>>(key) ?? { answerTokens: 1500, maxSteps: 8, 'edits.approval': 'ask' };
      for (const k of ['answerTokens', 'maxSteps', 'edits.approval']) await set(k, prev[k] ?? undefined);
      await this.ext.globalState.update(key, undefined);
    }
  }

  /** Create the private MCP config with an example, then open it. */
  async openMcpConfig(): Promise<void> {
    const root = this.workspaceRoot;
    if (!root) { void vscode.window.showErrorMessage(this.problem); return; }
    const f = path.join(root, '.bluecheese', 'mcp.json');
    if (!fs.existsSync(f)) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const ig = path.join(root, '.bluecheese', '.gitignore');
      if (!fs.existsSync(ig)) fs.writeFileSync(ig, '*\n');
      fs.writeFileSync(f, JSON.stringify({
        mcpServers: {
          'example-filesystem': { disabled: true, command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '${workspaceFolder}'] },
          'example-remote': { disabled: true, url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${env:EXAMPLE_TOKEN}' } },
        },
      }, null, 2) + '\n');
    }
    await vscode.window.showTextDocument(vscode.Uri.file(f));
  }

  post(m: ToWebview): void { void this.view?.webview.postMessage(m); }

  prefill(text: string, focusFile?: string): void {
    this.pendingFocus = focusFile;
    this.post({ type: 'prefill', text });
  }

  /** Settings controls come from the manifest's configuration block. */
  private loadFields(): Field[] {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(this.ext.extensionPath, 'package.json'), 'utf8'));
      const props = pkg.contributes.configuration.properties as Record<string, any>;
      return Object.entries(props).map(([full, p]) => {
        const key = full.replace(/^bluecheese\./, '');
        const numeric = p.type === 'number' || p.type === 'integer';
        return {
          key, label: p['x-label'] ?? humanize(key.split('.').pop()!), description: p.description ?? '',
          group: p['x-group'] ?? 'Other', type: p.type, min: p.minimum, max: p.maximum,
          step: p['x-step'], numMin: p['x-min'], numDefault: p['x-numDefault'],
          // a slider only where the manifest asks for one: counts and sizes are typed, not dragged
          slider: numeric && p['x-slider'] === true && p.minimum !== undefined && p.maximum !== undefined,
          special: Array.isArray(p['x-special']) ? p['x-special'] : [],
          applies: p['x-applies'] ?? 'question', panel: p['x-panel'] !== false, default: p.default,
          multiline: p['x-multiline'] === true,
          enum: Array.isArray(p.enum) ? p.enum : undefined, enumLabels: p['x-enumLabels'],
          defaultText: key === 'systemPrompt' ? DEFAULT_SYSTEM : undefined,
        } as Field;
      });
    } catch (e) {
      this.out.appendLine(`[error] could not read the settings schema: ${(e as Error).message}`);
      return [];
    }
  }

  currentValues(): Record<string, unknown> {
    const c = config();
    return Object.fromEntries(this.fields.map((f) => [f.key, c.get(f.key) ?? f.default]));
  }

  sendValues(): void { this.post({ type: 'values', values: this.currentValues() }); }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(this.ext.extensionPath)] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: any) => { void this.onMessage(m); });
    view.onDidDispose(() => { this.view = undefined; });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const file = path.join(this.ext.extensionPath, 'media', 'chat.html');
    return fs.readFileSync(file, 'utf8').replaceAll('{{nonce}}', nonce).replaceAll('{{cspSource}}', webview.cspSource);
  }

  private activeFocusFile(): string | undefined {
    const root = this.workspaceRoot;
    const ed = vscode.window.activeTextEditor;
    if (!root || !ed || !config().get<boolean>('focusActiveFile', true)) return undefined;
    const rel = path.relative(root, ed.document.uri.fsPath).split(path.sep).join('/');
    return rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel;
  }

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case 'ready': {
        const root = this.workspaceRoot;
        this.post({ type: 'schema', fields: this.fields, values: this.currentValues() });
        this.postProject();
        this.post({ type: 'power', info: this.powerInfo });
        this.post({ type: 'status', text: root ? `Ready. Ask a question about ${path.basename(root)}.` : this.problem });
        if (root) this.getController()?.init();
        break;
      }
      case 'newChat': await this.getController()?.newChat(); break;
      case 'openChat': if (m.id) await this.getController()?.openChat(m.id); break;
      case 'renameChat': if (m.id && m.title) await this.getController()?.renameChat(m.id, m.title); break;
      case 'deleteChat': if (m.id) await this.getController()?.deleteChat(m.id); break;
      case 'approve': if (m.id && (m.decision === 'once' || m.decision === 'always' || m.decision === 'deny')) this.controller?.answerApproval(m.id, m.decision); break;
      case 'setTool': {
        // a tool is on unless its name is in the list
        if (!m.name) return;
        const off = new Set(config().get<string[]>('tools.disabled', []));
        if (m.enabled) off.delete(m.name); else off.add(m.name);
        await config().update('tools.disabled', [...off], vscode.ConfigurationTarget.Global);
        break;
      }
      case 'revokeAuto': {
        if (!m.name) return;
        await config().update('mcp.autoApprove', config().get<string[]>('mcp.autoApprove', []).filter((x) => x !== m.name), vscode.ConfigurationTarget.Global);
        break;
      }
      case 'autoRun': await this.setAutoRun(m.on === true); break;
      case 'mcpConfig': await this.openMcpConfig(); break;
      case 'mcpReload': await this.getController()?.reloadMcp(); break;
      case 'ask': {
        const ctl = this.getController();
        if (!ctl || !m.text) return;
        const focus = this.pendingFocus ?? this.activeFocusFile();
        this.pendingFocus = undefined;
        await ctl.ask(m.text, { focusFile: focus });
        break;
      }
      case 'stop': this.controller?.stop(); break;
      case 'power': {
        const ctl = this.getController();
        if (!ctl) return;
        if (m.on) await ctl.powerOn(); else await ctl.powerOff();
        break;
      }
      case 'restart': await this.getController()?.restart(); break;
      case 'setting': {
        // only keys declared in the manifest may be written
        if (!m.key || !this.fields.some((f) => f.key === m.key)) return;
        await config().update(m.key, m.value, vscode.ConfigurationTarget.Global);
        break;
      }
    }
  }
}

const STATUS_TEXT: Record<PowerInfo['state'], string> = {
  off: '$(circle-outline) BlueCheese: off',
  starting: '$(sync~spin) BlueCheese: starting…',
  on: '$(circle-filled) BlueCheese: on',
  stopping: '$(sync~spin) BlueCheese: stopping…',
  error: '$(error) BlueCheese: error',
};

let provider: ChatViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('BlueCheese');

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.command = 'bluecheese.togglePower';
  const showPower = (info: PowerInfo) => {
    status.text = STATUS_TEXT[info.state];
    status.tooltip = `${info.detail}\nClick to switch ${info.state === 'on' || info.state === 'starting' ? 'off' : 'on'}.`;
  };
  showPower(OFF);
  status.show();

  provider = new ChatViewProvider(context, out, showPower);
  const p = provider;

  const toggle = async () => {
    const ctl = p.getController();
    if (!ctl) return;
    const s = ctl.powerInfo.state;
    if (s === 'on' || s === 'starting') await ctl.powerOff(); else await ctl.powerOn();
  };

  context.subscriptions.push(
    out, status,
    vscode.window.registerWebviewViewProvider('bluecheese.chat', p, { webviewOptions: { retainContextWhenHidden: true } }),

    vscode.commands.registerCommand('bluecheese.focus', () => vscode.commands.executeCommand('bluecheese.chat.focus')),
    vscode.commands.registerCommand('bluecheese.togglePower', toggle),
    vscode.commands.registerCommand('bluecheese.powerOn', async () => { await p.getController()?.powerOn(); }),
    vscode.commands.registerCommand('bluecheese.powerOff', async () => { await p.peekController()?.powerOff(); }),
    vscode.commands.registerCommand('bluecheese.restart', async () => { await p.getController()?.restart(); }),

    vscode.commands.registerCommand('bluecheese.askSelection', async () => {
      const ed = vscode.window.activeTextEditor;
      const root = p.workspaceRoot;
      if (!ed || !root) return;
      const rel = path.relative(root, ed.document.uri.fsPath).split(path.sep).join('/');
      const a = ed.selection.start.line + 1;
      const b = ed.selection.end.line + 1;
      p.prefill(`Explain ${rel} lines ${a}-${b}: `, rel);
      await vscode.commands.executeCommand('bluecheese.chat.focus');
    }),

    vscode.commands.registerCommand('bluecheese.newChat', async () => { await p.getController()?.newChat(); await vscode.commands.executeCommand('bluecheese.chat.focus'); }),
    vscode.commands.registerCommand('bluecheese.openMcpConfig', () => p.openMcpConfig()),
    vscode.commands.registerCommand('bluecheese.reloadMcp', async () => { await p.getController()?.reloadMcp(); }),
    vscode.commands.registerCommand('bluecheese.stopApi', async () => { await p.peekController()?.stopApi(); }),
    vscode.commands.registerCommand('bluecheese.stopAllApis', async () => {
      const ctl = p.getController();
      if (!ctl) return;
      await ctl.stopApi({ all: true });
      void vscode.window.showInformationMessage('Stopped all BlueCheese-managed Roaster API containers.');
    }),

    vscode.workspace.onDidChangeWorkspaceFolders?.(() => { void p.rootChanged(); }),
    // settings changed in VS Code's own Settings UI show up in the panel too
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('bluecheese')) return;
      p.sendValues();
      void p.rootChanged();
      // context window, routing, sliding and helper settings reach the running conversation now: no restart
      void p.peekController()?.applySettings();
    }),
  );

  // stays on while VS Code is open: switch on again if it was on last time
  if (config().get<boolean>('autoStart', true) && context.globalState.get<boolean>('bluecheese.powerOn', false) && p.workspaceRoot) {
    const t = setTimeout(() => { void p.getController()?.powerOn(); }, 2000);
    context.subscriptions.push({ dispose: () => clearTimeout(t) });
  }
}

export async function deactivate(): Promise<void> {
  // stops what BlueCheese started (model server and API) so VS Code does not leave 10 GB locked behind
  await provider?.peekController()?.dispose();
}

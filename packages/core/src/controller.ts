/**
 * Everything a chat front-end needs, with no UI code: power (model server + API), saved chats with their context,
 * tools (built-in and MCP), one long-lived conversation, stop, and plain messages for the UI to show.
 * The VS Code extension is a thin shell around this class; so could be a terminal or a web page.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgentConversation, RoasterLLM, RoasterRuntime, runAgent, loadProjectConfig, renderToolInstructions, renderToolLine, buildSystemText,
  type AgentEvent, type AgentTool, type ApiInstance, type ApiProfile, type RuntimeConfig, type SessionConfig, type ToolSpec,
} from '@bluecheese/agent';
import { makeTools } from './tools.js';
import { makeEditTools } from './edittools.js';
import { makeChatTools } from './chattools.js';
import { HelperPool, makeExploreTool, exploreSpec } from './helpers.js';
import { ChatStore, titleFrom, type ChatContextInfo, type ChatRecord, type ChatSummary, type ChatTurn } from './chats.js';
import { McpHub, mcpAgentTool, mcpSpec, type McpServerConfig, type McpStatus, type McpToolInfo } from './mcp.js';

/** The built-in instructions, for UIs that show them next to the editable system prompt. */
export { DEFAULT_SYSTEM } from '@bluecheese/agent';

export interface ControllerSettings {
  /** Use an API that is already running instead of managing containers. */
  baseUrl?: string;
  runtime: Partial<RuntimeConfig>;
  /**
   * Slots BlueCheese may use at once: 1 for the main conversation plus `slots - 1` helpers for subtasks.
   * The model server (which you run yourself) has its own `--max-slots`; keep this at or below what you want to give us.
   */
  slots: number;
  /**
   * `maxSteps`: tool calls a helper may make per question (-1 = no limit).
   * `branches`: most questions one `explore` call may carry (0 = as many as there are slots, -1 = no limit);
   * questions beyond the number of helpers wait for a free one.
   */
  helpers: { enabled: boolean; context: number; maxSteps: number; branches: number };
  /** `context`, routing, `slide` and `keep` are applied to the running conversation when they change (no restart). */
  profile: ApiProfile;
  /** Tool calls allowed per question (-1 = no limit; 0 = answer from the code pack only). Live: also changes a question that is running. */
  maxSteps: number;
  observationBytes: number;
  /** Token limit of each reply, thinking included (-1 = no limit). Live. */
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  /** Let the model reason before each reply. Live: applies to the very next step, even in a question that is running. */
  think: boolean;
  /** Stop the API container after this many idle minutes (0 = never). The conversation context is lost with it. */
  idleMinutes: number;
  /**
   * The instructions the model is given (empty = the built-in default). The tool list is always added after it.
   * It is pinned once, when a conversation starts, so a change takes effect in the next conversation (after Reset).
   */
  systemPrompt?: string;
  /** Tools the model is not offered (built-in names, or `server__tool` for MCP tools). Takes effect in the next chat; a disabled tool is refused at once. */
  tools: { disabled: string[] };
  /** Changing files (`write_file`, `edit_file`): `ask` shows a prompt before each change, `never` lets the model change files without asking. */
  edits: { approval: 'ask' | 'never' };
  mcp: {
    enabled: boolean;
    /** `readonly-auto`: ask before every tool that is not marked read-only; `ask`: ask every time; `never`: never ask. */
    approval: 'readonly-auto' | 'ask' | 'never';
    /** Largest MCP tool result handed to the model, in bytes. */
    resultBytes: number;
    /** Room the MCP tools may take in the system prompt, in bytes. Tools that do not fit are left out (and shown as such). */
    promptBytes: number;
    /** Tools (MCP or file-changing) that may run without asking: the "Always allow" answers. */
    autoApprove: string[];
  };
  chats: {
    /** Folder ON THE MODEL SERVER'S machine (inside its container) where chat contexts are stored. */
    serverDir: string;
    /** When the model's memory of a chat is stored: after every answer, only when you leave the chat, or never (the text is always saved). */
    saveContext: 'afterEachAnswer' | 'whenLeaving' | 'never';
    /** New chats start from a stored copy of the system prompt's KV cache (one prefill, ever, until the prompt or tools change). Needs the context to be stored. */
    reuseSystemPrompt: boolean;
    /** Optional: the same folder as seen from this computer, so deleting a chat can delete its stored context too. */
    hostDir?: string;
  };
}

export const DEFAULT_SETTINGS: ControllerSettings = {
  runtime: {}, slots: 4, helpers: { enabled: true, context: 8192, maxSteps: 4, branches: 0 },
  profile: { context: 16384, maxTokens: 1024, cacheRoute: true, slide: true, keep: 64 },
  maxSteps: 8, observationBytes: 1200, think: false, idleMinutes: 0,
  tools: { disabled: [] },
  edits: { approval: 'ask' },
  mcp: { enabled: true, approval: 'readonly-auto', resultBytes: 2400, promptBytes: 3500, autoApprove: [] },
  chats: { serverDir: '/state/bluecheese', saveContext: 'afterEachAnswer', reuseSystemPrompt: true },
};

/** In the settings, a negative number means "no limit". */
export const UNLIMITED = -1;
/** A setting as a limit the agent can use: negative = Infinity. */
export const limitOf = (n: number | undefined, fallback: number): number => (n === undefined ? fallback : n < 0 ? Infinity : n);

const SESSION_KEY_LABEL: Record<string, string> = {
  contextLength: 'context window', cacheRoute: 'routing', routeJ: 'routing', routeM: 'routing', routeAlpha: 'routing', routeP: 'routing',
  slide: 'sliding', keep: 'kept tokens', slots: 'slots',
};

/** The session settings the main conversation (or a helper, with its own `contextLength`) should have. */
export function sessionConfigOf(s: ControllerSettings, contextLength: number): SessionConfig {
  const p = s.profile;
  return defined({
    contextLength, cacheRoute: p.cacheRoute, routeJ: p.routeJ, routeM: p.routeM, routeAlpha: p.routeAlpha, routeP: p.routeP,
    slide: p.slide ?? true, keep: p.keep,
  }) as SessionConfig;
}

export type PowerState = 'off' | 'starting' | 'on' | 'stopping' | 'error';
export interface PowerInfo {
  state: PowerState;
  detail: string;
  slots?: number;
  api?: string;
}

export type UiMessage =
  | { type: 'status'; text: string }
  | { type: 'progress'; text: string }
  /** Structured detail for UIs that show thinking, tool calls and helpers. `agent` 0 = the main conversation, N = helper N. */
  | { type: 'trace'; agent: number; event: AgentEvent }
  /** The main conversation's window: for a bar. `window` tokens are in RAM (of `context`), `spilled` are on SSD, `pinned` is the system prompt. */
  | { type: 'context'; window: number; context: number; pinned: number; spilled: number; position: number; sliding: boolean }
  | { type: 'answer'; text: string; truncated: boolean; seconds: number }
  | { type: 'error'; text: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'power'; info: PowerInfo }
  /** The chats of this project folder, newest first, for the sidebar. `activeId` may be a chat that has no message yet. */
  | { type: 'chats'; project: string; activeId: string; chats: ChatSummary[] }
  /** Show this chat: the whole transcript. */
  | { type: 'chat'; chat: ChatView }
  /** Every tool the model can use, where it comes from, and the MCP servers. */
  | { type: 'tools'; info: ToolsInfo }
  /** An MCP tool wants to run: the UI asks, then calls `answerApproval`. */
  | { type: 'approval'; id: string; tool: string; server: string; args: Record<string, unknown>; readOnly: boolean }
  | { type: 'approvalDone'; id: string };

export interface ChatView { id: string; title: string; turns: ChatTurn[]; ctx?: ChatContextInfo; contextSaved: boolean }

export interface ToolInfo {
  name: string; source: 'builtin' | 'mcp'; server?: string; description: string; signature: string;
  readOnly: boolean; enabled: boolean;
  /** Offered to the model. A tool that is enabled but does not fit the MCP prompt budget is not. */
  inPrompt: boolean;
  /** Times the model called it in the open chat. */
  calls: number;
  /** Runs without asking. */
  auto: boolean;
}
export interface McpServerInfo {
  name: string; status: McpStatus; error?: string; transport: 'stdio' | 'http'; target: string; file: string; tools: number; version?: string;
}
export interface ToolsInfo {
  tools: ToolInfo[]; servers: McpServerInfo[];
  mcpEnabled: boolean; approval: ControllerSettings['mcp']['approval']; editApproval: ControllerSettings['edits']['approval'];
  /** Size of the tool list in the system prompt, and the part of it MCP tools may use. */
  promptBytes: number; mcpBudget: number;
  configFiles: string[]; configErrors: string[];
}

/** What the host (VS Code, a terminal, …) provides. All optional. */
export interface ControllerHost {
  /** Ask the person before an MCP server from a config file is started. Without this, no MCP server is started. */
  confirmMcpServer?(name: string, config: McpServerConfig, file: string): Promise<boolean>;
  /** The person chose "Always allow" for a tool: remember it. */
  addAutoApprove?(tool: string): void;
  log?(line: string): void;
}

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Partial<T>;
}

export function describeEvent(e: AgentEvent): string {
  const sec = (ms: number) => (ms / 1000).toFixed(1) + 's';
  if (e.type === 'start') {
    return `${e.primed ? 'follow-up' : 'first message'}: ${e.firstPromptBytes} B (~${Math.round(e.firstPromptBytes / 3.4)} tokens)` +
      (e.carriedBytes ? `, with a recap of the earlier conversation` : '');
  }
  if (e.type === 'turn' || e.type === 'token' || e.type === 'call') return ''; // streaming detail: only for the `trace` message
  if (e.type === 'slide') {
    return `the window slid: ${e.spilledTokens} tokens are on SSD now; code shown earlier may be read again`;
  }
  const what = e.call
    ? `${e.call.name}(${JSON.stringify(e.call.args).slice(0, 70)})${e.call.repaired ? ' [repaired]' : ''} → ${e.observationBytes} B`
    : e.note ? e.note : 'answering';
  return `step ${e.n} · ${sec(e.totalMs)} · ${what}`;
}

/** The reply limit as the agent wants it: the setting, -1 = no limit, and 1500 when thinking and nothing is set. */
function tokenLimit(s: ControllerSettings): number | undefined {
  return s.maxTokens === undefined ? (s.think ? 1500 : undefined) : limitOf(s.maxTokens, 600);
}

const bytes = (t: string) => Buffer.byteLength(t, 'utf8');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const signature = (spec: ToolSpec) => Object.entries(spec.params).map(([k, p]) => `${k}${p.required === false ? '?' : ''}: ${p.type}`).join(', ');

interface PlanTool { spec: ToolSpec; source: 'builtin' | 'mcp'; server?: string; readOnly: boolean; enabled: boolean; inPrompt: boolean; mcp?: McpToolInfo }

export class ChatController {
  private runtime?: RoasterRuntime;
  private api?: ApiInstance;
  private llm?: RoasterLLM;
  private conv?: AgentConversation;
  private abort?: AbortController;
  private idle?: ReturnType<typeof setTimeout>;
  private busy = false;
  private pool?: HelperPool;
  private pendingApply = false;
  private syncing: Promise<void> = Promise.resolve();
  private lastApplyProblem = '';
  private power: PowerInfo = { state: 'off', detail: 'Off' };

  /* chats */
  private readonly store: ChatStore;
  private chat: ChatRecord;
  /** Which chat the model server's session currently holds the context of (null: none / unknown). */
  private convOwner: string | null = null;
  private snapshotDirty = false;
  private snapshotJob: Promise<void> = Promise.resolve();
  private snapshotProblem = '';
  /** System-prompt caches that could not be stored this session (do not try again on every new chat). */
  private readonly prefixBad = new Set<string>();
  private initialized = false;

  /* tools */
  private readonly hub: McpHub;
  private mcpReady: Promise<void> = Promise.resolve();
  private mcpStarted = false;
  private readonly approvals = new Map<string, (d: 'once' | 'always' | 'deny') => void>();
  private readonly autoApproved = new Set<string>();

  constructor(
    readonly root: string,
    private readonly getSettings: () => ControllerSettings,
    private readonly emit: (m: UiMessage) => void,
    private readonly host: ControllerHost = {},
  ) {
    this.store = new ChatStore(root);
    this.chat = this.store.create();
    this.hub = new McpHub({
      root,
      confirm: (name, cfg, file) => (host.confirmMcpServer ? host.confirmMcpServer(name, cfg, file) : Promise.resolve(false)),
      onChange: () => this.emitTools(),
      log: (l) => host.log?.(l),
    });
  }

  get isBusy(): boolean { return this.busy; }
  get hasApi(): boolean { return !!this.llm; }
  get powerInfo(): PowerInfo { return this.power; }
  get activeChat(): ChatRecord { return this.chat; }
  get chatStore(): ChatStore { return this.store; }

  /* --------------------------------- power --------------------------------- */

  private setPower(state: PowerState, detail: string, extra: Partial<PowerInfo> = {}): void {
    this.power = { ...this.power, state, detail, ...extra };
    this.emit({ type: 'power', info: this.power });
  }

  private getRuntime(): RoasterRuntime {
    const pc = loadProjectConfig(this.root);
    this.runtime = new RoasterRuntime({ ...pc.runtime, ...defined(this.getSettings().runtime) });
    return this.runtime;
  }

  /**
   * Connect: check that `roaster serve` (which you run yourself) has its socket, then start the API container.
   * With `baseUrl` set, only that API is used. Safe to call when already on.
   */
  async powerOn(): Promise<void> {
    if (this.power.state === 'on' || this.power.state === 'starting') return;
    const s = this.getSettings();
    this.setPower('starting', 'Looking for roaster serve…', { slots: s.slots, api: undefined });
    try {
      if (s.baseUrl) {
        const llm = await this.ensureLlm();
        this.setPower('on', `Using the API at ${llm.cfg.baseUrl} · up to ${s.slots} slots`, { api: llm.cfg.baseUrl });
      } else {
        const rt = this.getRuntime();
        if (!rt.serveSocketPresent()) {
          throw new Error(`roaster serve is not running: there is no socket at ${rt.socketPath()}. Start it first (your usual docker run … serve …, ` +
            `with the same socket folder), or change the socket folder in the settings.`);
        }
        this.setPower('starting', 'Starting the API container…');
        await this.ensureLlm();
        this.setPower('on', `API on ${this.api?.url} · up to ${s.slots} slots`, { api: this.api?.url });
      }
      void this.syncMcp();
    } catch (e) {
      await this.teardown();
      const msg = this.friendly(e as Error);
      this.setPower('error', msg);
      this.emit({ type: 'error', text: msg });
    }
  }

  /** Disconnect: save the open chat's context, stop the API container and free every slot BlueCheese holds. The model server is left alone. */
  async powerOff(): Promise<void> {
    if (this.power.state === 'off') return;
    this.stop();
    this.setPower('stopping', 'Stopping…');
    await this.queueSnapshot('leave');
    await this.teardown();
    this.setPower('off', 'Off', { api: undefined });
  }

  /** Apply changed container/Docker settings: off, then on. (Everything else is applied live, see `applySettings`.) */
  async restart(): Promise<void> { await this.powerOff(); await this.powerOn(); }

  /**
   * The settings changed: push what a running conversation can take (context window, routing, sliding, helper slots)
   * to the live sessions now. A running question is not interrupted: it picks up Think, tool limits and sampling
   * at its next step, and the session-level changes are applied the moment it ends. No restart, no lost context.
   */
  async applySettings(): Promise<void> {
    this.emitTools();
    void this.syncMcp();
    if (this.busy) { this.pendingApply = true; return; }
    await this.syncSessions();
  }

  private syncSessions(): Promise<void> {
    this.syncing = this.syncing.then(() => this.doSync()).catch(() => {}); // one at a time, in order
    return this.syncing;
  }

  private async doSync(): Promise<void> {
    if (!this.llm) return;
    const s = this.getSettings();
    const changed = new Set<string>(), problems: string[] = [];
    const take = (keys: string[]) => keys.forEach((k) => changed.add(SESSION_KEY_LABEL[k] ?? k));
    if (this.conv) {
      try {
        const r = await this.conv.applyConfig(sessionConfigOf(s, s.profile.context ?? 16384));
        take(r.changed); // `deferred` (busy or unloaded) is simply tried again at the next question
      } catch (e) { problems.push(`conversation: ${(e as Error).message}`); }
    }
    if (this.pool) {
      if (!s.helpers.enabled || s.slots < 2) { await this.pool.closeAll().catch(() => {}); this.pool = undefined; changed.add('helpers off'); }
      else {
        const r = await this.pool.configure(s.slots - 1, sessionConfigOf(s, s.helpers.context)).catch((e: Error) => ({ changed: [] as string[], problems: [e.message] }));
        take(r.changed); problems.push(...r.problems.map((m) => `helpers: ${m}`));
      }
    }
    if (changed.size) { this.emit({ type: 'status', text: `Applied without restart: ${[...changed].join(', ')}.` }); await this.reportContext(); }
    const problem = problems.join(' | ');
    if (problem && problem !== this.lastApplyProblem) {
      this.emit({ type: 'error', text: `Could not apply a setting (the conversation keeps working with the old value): ${problem}` });
    }
    this.lastApplyProblem = problem;
  }

  private async teardown(): Promise<void> {
    this.clearIdle();
    this.denyAllApprovals();
    await this.pool?.closeAll().catch(() => {});
    this.pool = undefined;
    await this.conv?.close().catch(() => {});
    this.conv = undefined; this.convOwner = null;
    await this.stopMcp();
    await this.runtime?.stopAll().catch(() => {});
    this.api = undefined; this.llm = undefined;
  }

  /** Called when the host shuts down. Saves the open chat's context (briefly), then stops what we started. */
  async dispose(): Promise<void> {
    this.stop();
    await Promise.race([this.queueSnapshot('leave'), sleep(15_000)]);
    await this.teardown();
  }

  /* ---------------------------------- chats ---------------------------------- */

  /** The panel is ready: show the chats and the tools. Safe to call again (a reloaded panel asks again). */
  init(): void {
    if (!this.initialized) {
      this.initialized = true;
      const last = this.store.activeId, rec = last ? this.store.load(last) : undefined;
      if (rec && !this.chat.turns.length) this.chat = rec;
    }
    this.emitChats(); this.emitChat(); this.emitTools();
  }

  private emitChats(): void {
    this.emit({ type: 'chats', project: path.basename(this.root), activeId: this.chat.id, chats: this.store.list() });
  }

  private view(c: ChatRecord): ChatView { return { id: c.id, title: c.title, turns: c.turns, ctx: c.ctx, contextSaved: !!c.snapshot }; }

  private emitChat(): void {
    this.emit({ type: 'chat', chat: this.view(this.chat) });
    const c = this.chat.ctx, ctx = this.getSettings().profile.context ?? 16384;
    this.emit({ type: 'context', window: c?.window ?? 0, context: c?.context ?? ctx, pinned: c?.pinned ?? 0, spilled: c?.spilled ?? 0, position: c?.position ?? 0, sliding: this.getSettings().profile.slide !== false });
  }

  private persist(): void {
    const c = this.chat, conv = this.conv;
    c.updatedAt = Date.now();
    if (conv && this.convOwner === c.id) { c.history = conv.history.slice(); c.shown = [...conv.shown.entries()].map(([f, r]) => [f, r.map((x) => [...x] as [number, number])]); }
    try { this.store.save(c); this.store.activeId = c.id; }
    catch (e) { this.emit({ type: 'error', text: `Could not save the chat: ${(e as Error).message}` }); }
  }

  /** Start a new, empty chat. The one that was open stays in the list (its context is stored first). */
  async newChat(): Promise<void> {
    if (this.busy) { this.emit({ type: 'error', text: 'Stop the current question first.' }); return; }
    if (!this.chat.turns.length) { this.emitChat(); return; }
    await this.leaveChat();
    this.chat = this.store.create();
    this.store.activeId = undefined;
    this.emitChats(); this.emitChat();
  }

  async openChat(id: string): Promise<void> {
    if (this.busy) { this.emit({ type: 'error', text: 'Stop the current question first.' }); return; }
    if (id === this.chat.id) { this.emitChat(); return; }
    const rec = this.store.exists(id) ? this.store.load(id) : undefined;
    if (!rec) { this.emit({ type: 'error', text: 'That chat could not be read.' }); this.emitChats(); return; }
    await this.leaveChat();
    this.chat = rec; this.store.activeId = rec.id;
    this.emitChats(); this.emitChat();
  }

  async renameChat(id: string, title: string): Promise<void> {
    const t = title.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!t) return;
    const rec = id === this.chat.id ? this.chat : this.store.load(id);
    if (!rec) return;
    rec.title = t;
    if (rec.turns.length) { try { this.store.save(rec); } catch (e) { this.emit({ type: 'error', text: `Could not save the chat: ${(e as Error).message}` }); } }
    this.emitChats(); if (rec.id === this.chat.id) this.emitChat();
  }

  async deleteChat(id: string): Promise<void> {
    if (this.busy && id === this.chat.id) { this.emit({ type: 'error', text: 'Stop the current question first.' }); return; }
    const rec = id === this.chat.id ? this.chat : this.store.load(id);
    this.store.delete(id);
    const dir = rec?.snapshot && this.hostSnapshotDir(id);
    let left = '';
    if (rec?.snapshot) {
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { left = rec.snapshot.path; } }
      else left = rec.snapshot.path;
    }
    if (left) this.emit({ type: 'status', text: `Chat deleted. Its stored context is still on the model server in ${left}; delete that folder to free the space (set "Context folder on this computer" to have this done for you).` });
    if (id === this.chat.id) { this.chat = this.store.create(); this.store.activeId = undefined; if (this.convOwner === id) this.convOwner = null; this.snapshotDirty = false; this.emitChat(); }
    this.emitChats();
  }

  /** `<hostDir>/<project>/<chat>` on this computer, if the setting names the folder; never anything outside it. */
  private hostSnapshotDir(id: string): string | undefined {
    const h = this.getSettings().chats.hostDir?.trim();
    if (!h) return undefined;
    const dir = path.resolve(h, this.store.projectKey, id);
    return dir.startsWith(path.resolve(h) + path.sep) ? dir : undefined;
  }

  /** The folder on the model server for a chat's stored context. */
  private serverSnapshotDir(id: string): string {
    return `${this.getSettings().chats.serverDir.trim().replace(/\/+$/, '')}/${this.store.projectKey}/${id}`;
  }

  /** Before another chat takes over the model: make sure this one's context is stored. */
  private async leaveChat(): Promise<void> { await this.queueSnapshot('leave'); }

  private queueSnapshot(when: 'answer' | 'leave'): Promise<void> {
    this.snapshotJob = this.snapshotJob.then(() => this.doSnapshot(when)).catch(() => {});
    return this.snapshotJob;
  }

  private async doSnapshot(when: 'answer' | 'leave'): Promise<void> {
    const mode = this.getSettings().chats.saveContext;
    if (mode === 'never' || !this.snapshotDirty) return;
    if (when === 'answer' && mode !== 'afterEachAnswer') return;
    const llm = this.llm, conv = this.conv, chat = this.chat;
    if (!llm || !conv || this.convOwner !== chat.id || !chat.turns.length || this.busy) return;
    const dir = this.serverSnapshotDir(chat.id);
    this.emit({ type: 'status', text: 'Saving the chat\u2019s context…' });
    let r: { status: number; data: any };
    try { r = await llm.saveSession(conv.id, dir); } catch (e) { r = { status: 0, data: (e as Error).message }; }
    if (r.status >= 200 && r.status < 300) {
      chat.snapshot = { path: dir, savedAt: Date.now(), bytes: r.data?.saved_bytes, position: r.data?.position };
      this.snapshotDirty = false; this.snapshotProblem = '';
      this.persist(); this.emitChats();
      this.emit({ type: 'status', text: `Context saved (${chat.snapshot.bytes ? Math.round(chat.snapshot.bytes / 1048576) + ' MB' : 'ok'}).` });
      return;
    }
    this.snapshotDirty = false; // do not retry on every answer; the next answer tries again
    const why = typeof r.data === 'string' ? r.data : r.data?.error?.message ?? JSON.stringify(r.data ?? '');
    const msg = `${r.status || 'error'}: ${String(why).slice(0, 160)}`;
    if (msg !== this.snapshotProblem) {
      this.snapshotProblem = msg;
      this.emit({ type: 'error', text: `Could not store this chat\u2019s context on the model server (${msg}). The chat text is saved, and the chat can continue from a short recap. ` +
        `To keep the model\u2019s own memory too, the server needs a folder it can write to: set \u201cContext folder on the server\u201d (now ${dir.replace(/\/[^/]+\/[^/]+$/, '')}) to a path inside your roaster serve container, such as one under its /state mount.` });
    }
  }

  /**
   * A new chat: instead of reading the system prompt and tool list again (~1.5k tokens, over a minute), restore a stored copy
   * of the server's KV cache for exactly this prompt. The first time, the prompt is sent alone (this is the same prefill the first
   * question would have paid) and stored for every later new chat. Any problem falls back to the normal way: the prompt
   * simply goes with the first question.
   */
  private async startWithCachedPrompt(conv: AgentConversation, systemText: string, signal?: AbortSignal): Promise<void> {
    const c = this.getSettings().chats;
    if (!c.reuseSystemPrompt || c.saveContext === 'never' || !systemText) return;
    const key = crypto.createHash('sha1').update(systemText).digest('hex').slice(0, 12);
    if (this.prefixBad.has(key)) return;
    const dir = `${c.serverDir.trim().replace(/\/+$/, '')}/${this.store.projectKey}/_prefix/${key}`;
    const llm = conv.llm, fail = (r: { status: number; data: any }) => (typeof r.data === 'string' ? r.data : r.data?.error?.message ?? `HTTP ${r.status}`);
    const r = await llm.restoreSession(conv.id, dir).catch((e: Error) => ({ status: 0, data: e.message as any }));
    if (r.status >= 200 && r.status < 300) {
      conv.adopt(r.data);
      this.emit({ type: 'status', text: `Reused the cached system prompt (${r.data?.pinned_tokens ?? r.data?.position ?? '?'} tokens): no prefill for it.` });
      return;
    }
    if (r.status !== 404 && r.status !== 400) { this.emit({ type: 'status', text: `Could not reuse the cached system prompt (${fail(r).slice(0, 100)}): sending it with the question.` }); return; }
    // nothing stored yet (or from another model): read the prompt now, store the result
    this.emit({ type: 'status', text: 'Reading the system prompt once and caching it for new chats…' });
    try { await conv.primeSystem(systemText, { signal }); }
    catch (e) { if (signal?.aborted) throw e; await conv.reset().catch(() => {}); this.prefixBad.add(key); this.emit({ type: 'status', text: `Could not cache the system prompt (${(e as Error).message.slice(0, 100)}): sending it with the question.` }); return; }
    const saved = await llm.saveSession(conv.id, dir).catch((e: Error) => ({ status: 0, data: e.message as any }));
    if (saved.status >= 200 && saved.status < 300) this.pruneOldPrefixes(key);
    else { this.prefixBad.add(key); this.emit({ type: 'status', text: `The system prompt is read, but could not be stored for other chats (${fail(saved).slice(0, 100)}); this chat uses it.` }); }
  }

  /** Only the newest cache is kept, when this computer can see the folder (the server has no delete). */
  private pruneOldPrefixes(keep: string): void {
    const h = this.getSettings().chats.hostDir?.trim();
    if (!h) return;
    const base = path.resolve(h, this.store.projectKey, '_prefix');
    try { for (const d of fs.readdirSync(base)) if (d !== keep && /^[0-9a-f]{12}$/.test(d)) fs.rmSync(path.join(base, d), { recursive: true, force: true }); } catch { /* not there: nothing to prune */ }
  }

  /**
   * Make the model server's session hold THIS chat: restore its stored context, or, when that is not possible,
   * start empty and carry a short recap of the transcript.
   */
  private async attachChat(conv: AgentConversation, systemText: string, signal?: AbortSignal): Promise<void> {
    const chat = this.chat, llm = conv.llm;
    if (this.convOwner === chat.id) return;
    await conv.ensure();
    if (!chat.turns.some((t) => t.state === 'done')) {
      if (this.convOwner !== null || conv.primed) await conv.reset();
      await this.startWithCachedPrompt(conv, systemText, signal);
      this.convOwner = chat.id;
      return;
    }
    let restored = false, why = '';
    const mode = this.getSettings().chats.saveContext;
    if (chat.snapshot && mode !== 'never') {
      const r = await llm.restoreSession(conv.id, chat.snapshot.path).catch((e: Error) => ({ status: 0, data: e.message as any }));
      if (r.status >= 200 && r.status < 300) {
        conv.adopt(r.data);
        conv.history.length = 0; conv.history.push(...chat.history);
        conv.shown.clear(); for (const [f, ranges] of chat.shown) conv.shown.set(f, ranges.map((x) => [...x] as [number, number]));
        restored = true;
        this.emit({ type: 'status', text: `Restored this chat\u2019s context (${r.data?.position ?? '?'} tokens).` });
      } else why = typeof r.data === 'string' ? r.data : r.data?.error?.message ?? `HTTP ${r.status}`;
    } else why = chat.snapshot ? 'saving contexts is switched off' : 'no stored context for this chat';
    if (!restored) {
      await conv.reset();
      conv.history.push(...chat.history);
      conv.memo = chat.history.slice(-3).map((h) => `Q: ${h.q}\nA: ${h.a}`).join('\n').slice(0, 1400);
      this.emit({ type: 'status', text: `Continuing from a short recap of this chat: its stored context could not be restored (${String(why).slice(0, 120)}).` });
    }
    this.convOwner = chat.id;
    this.snapshotDirty = false;
  }

  /* ---------------------------------- tools ---------------------------------- */

  /** Every tool there is, with whether it is on and whether it fits in the prompt. */
  private plan(): PlanTool[] {
    const s = this.getSettings(), off = new Set(s.tools?.disabled ?? []);
    const out: PlanTool[] = makeTools(this.root).map((t) => ({ spec: t.spec, source: 'builtin' as const, readOnly: true, enabled: !off.has(t.spec.name), inPrompt: true }));
    for (const t of makeChatTools(() => ({ chat: this.chat }), this.store)) out.push({ spec: t.spec, source: 'builtin', readOnly: true, enabled: !off.has(t.spec.name), inPrompt: true });
    for (const t of makeEditTools(this.root)) out.push({ spec: t.spec, source: 'builtin', readOnly: false, enabled: !off.has(t.spec.name), inPrompt: true });
    if (s.helpers.enabled && s.slots >= 2) {
      const b = s.helpers.branches ?? 0;
      const spec = exploreSpec(b === 0 ? Math.max(1, s.slots) : limitOf(b, 1));
      out.push({ spec, source: 'builtin', readOnly: true, enabled: !off.has('explore'), inPrompt: true });
    }
    if (s.mcp?.enabled) {
      let used = 0;
      for (const t of this.hub.tools) {
        const spec = mcpSpec(t), size = bytes(renderToolLine(spec)) + 1, enabled = !off.has(t.fullName);
        const fits = enabled && used + size <= s.mcp.promptBytes;
        if (fits) used += size;
        out.push({ spec, source: 'mcp', server: t.server, readOnly: !!t.readOnly, enabled, inPrompt: fits, mcp: t });
      }
    }
    return out;
  }

  /** Does this tool need the person's OK each time? Read-only built-in tools never do. */
  private needsApproval(name: string, readOnly: boolean, source: 'builtin' | 'mcp'): boolean {
    const st = this.getSettings();
    if (source === 'builtin' && readOnly) return false;
    if (this.autoApproved.has(name) || st.mcp.autoApprove?.includes(name)) return false;
    if (source === 'builtin') return st.edits?.approval !== 'never';
    if (st.mcp.approval === 'never') return false;
    return !(st.mcp.approval === 'readonly-auto' && readOnly);
  }

  private async askApproval(name: string, server: string, readOnly: boolean, args: Record<string, unknown>, signal: AbortSignal): Promise<'once' | 'always' | 'deny'> {
    const id = crypto.randomBytes(6).toString('hex');
    this.emit({ type: 'approval', id, tool: name, server, args, readOnly });
    const d = await new Promise<'once' | 'always' | 'deny'>((resolve) => {
      this.approvals.set(id, resolve);
      if (signal.aborted) return resolve('deny');
      signal.addEventListener('abort', () => resolve('deny'), { once: true });
    });
    this.approvals.delete(id);
    this.emit({ type: 'approvalDone', id });
    if (d === 'always') { this.autoApproved.add(name); this.host.addAutoApprove?.(name); this.emitTools(); }
    return d;
  }

  /** The person's answer to an `approval` message. */
  answerApproval(id: string, decision: 'once' | 'always' | 'deny'): void { this.approvals.get(id)?.(decision); }

  private denyAllApprovals(): void { for (const r of [...this.approvals.values()]) r('deny'); }

  /** Tell the UI what tools there are. Cheap; called whenever anything about them changes. */
  emitTools(): void {
    const s = this.getSettings(), plan = this.plan();
    const used = new Map<string, number>();
    for (const t of this.chat.turns) for (const c of t.tools) used.set(c.name, (used.get(c.name) ?? 0) + 1);
    const tools: ToolInfo[] = plan.map((p) => ({
      name: p.spec.name, source: p.source, server: p.server, description: p.spec.description, signature: signature(p.spec),
      readOnly: p.readOnly, enabled: p.enabled, inPrompt: p.enabled && p.inPrompt, calls: used.get(p.spec.name) ?? 0,
      auto: !this.needsApproval(p.spec.name, p.readOnly, p.source),
    }));
    const listed = plan.filter((p) => p.enabled && p.inPrompt).map((p) => p.spec);
    this.emit({
      type: 'tools',
      info: {
        tools,
        servers: this.hub.servers.map((v) => ({ name: v.name, status: v.status, error: v.error, transport: v.transport, target: v.target, file: v.file, tools: v.tools.length, version: v.version })),
        mcpEnabled: !!s.mcp?.enabled, approval: s.mcp?.approval ?? 'readonly-auto', editApproval: s.edits?.approval ?? 'ask',
        promptBytes: bytes(renderToolInstructions(listed)), mcpBudget: s.mcp?.promptBytes ?? 0,
        configFiles: this.hub.configFiles, configErrors: this.hub.configErrors,
      },
    });
  }

  /** Start or stop the MCP servers so they match the settings and the power state. */
  private syncMcp(): Promise<void> {
    const want = !!this.getSettings().mcp?.enabled && this.power.state === 'on';
    if (want && !this.mcpStarted) {
      this.mcpStarted = true;
      this.mcpReady = this.hub.start().then(() => {
        const sv = this.hub.servers.filter((x) => x.status !== 'off' && x.status !== 'disabled');
        if (sv.length) {
          const ready = sv.filter((x) => x.status === 'ready');
          this.emit({ type: 'status', text: `MCP: ${ready.length} of ${sv.length} server(s) ready, ${ready.reduce((n, x) => n + x.tools.length, 0)} tools.` });
        }
      }).catch((e: Error) => { this.emit({ type: 'error', text: `MCP: ${e.message}` }); });
    } else if (!want && this.mcpStarted) {
      this.mcpStarted = false;
      this.mcpReady = this.hub.stop();
    }
    return this.mcpReady;
  }

  private async stopMcp(): Promise<void> { this.mcpStarted = false; await this.hub.stop().catch(() => {}); this.mcpReady = Promise.resolve(); }

  /** Read the MCP config files again and reconnect (asks again about servers that were refused). */
  async reloadMcp(): Promise<void> {
    if (this.busy) { this.emit({ type: 'error', text: 'Wait for the current question to finish before reloading the MCP servers.' }); return; }
    this.mcpStarted = false;
    if (this.power.state === 'on' && this.getSettings().mcp?.enabled) { await this.syncMcp(); }
    else { this.hub.refreshConfig(); }
    this.emitTools();
  }

  /* ------------------------------- API client ------------------------------- */

  private async ensureLlm(): Promise<RoasterLLM> {
    if (this.llm) return this.llm;
    const s = this.getSettings();
    if (s.baseUrl) {
      try { this.llm = new RoasterLLM({ baseUrl: s.baseUrl, model: 'roaster' }); }
      catch (e) { throw new Error(`Setting "Use existing API at": ${(e as Error).message}`); }
      return this.llm;
    }
    const rt = this.runtime ?? this.getRuntime();
    const pc = loadProjectConfig(this.root);
    this.emit({ type: 'status', text: 'Starting the Roaster API container…' });
    const t0 = performance.now();
    this.api = await rt.start({ ...pc.profiles?.default, ...defined(s.profile) });
    this.llm = this.api.llm;
    this.emit({ type: 'status', text: `Roaster API ready on ${this.api.url} (${((performance.now() - t0) / 1000).toFixed(1)}s)` });
    return this.llm;
  }

  /* -------------------------------- questions -------------------------------- */

  async ask(text: string, opts: { focusFile?: string } = {}): Promise<void> {
    if (this.busy) { this.emit({ type: 'error', text: 'Still working on the previous question. Press Stop to cancel it.' }); return; }
    if (this.power.state === 'starting' || this.power.state === 'stopping') {
      this.emit({ type: 'error', text: 'BlueCheese is still starting or stopping. Ask again when the switch shows On.' });
      return;
    }
    if (this.power.state !== 'on') {
      await this.powerOn(); // asking while off switches it on
      if ((this.power.state as PowerState) !== 'on') return; // the error has been shown
    }
    this.busy = true;
    this.emit({ type: 'busy', busy: true });
    this.clearIdle();
    const abort = this.abort = new AbortController();
    const t0 = performance.now();
    const chat = this.chat;
    let turn: ChatTurn | undefined;
    const rate = { preTok: 0, preMs: 0, decTok: 0, decMs: 0 };
    try {
      const s = this.getSettings();
      await this.snapshotJob;                      // a context that is being stored finishes first
      const llm = await this.ensureLlm();          // restarts the API if it was stopped for being idle
      const conv = this.conv ??= new AgentConversation(llm, s.profile.context ?? 16384, sessionConfigOf(s, s.profile.context ?? 16384));
      await this.syncSessions();                   // settings changed while no question was running reach the session now
      await this.syncMcp(); await this.mcpReady;

      // tools: what is on and fits the prompt
      const plan = this.plan();
      const sourceOf = new Map(plan.map((p) => [p.spec.name, p.source === 'mcp' ? p.server ?? 'mcp' : 'builtin']));
      const runnable = new Map<string, AgentTool>(
        [...makeTools(this.root, { maxBytes: s.observationBytes, shown: conv.shown }),
          ...makeChatTools(() => ({ chat, skipTurn: turn?.id }), this.store, s.observationBytes),
          ...makeEditTools(this.root, { shown: conv.shown })].map((t) => [t.spec.name, t]));
      const helperSlots = s.helpers.enabled ? Math.max(0, s.slots - 1) : 0;
      if (helperSlots === 0) { await this.pool?.closeAll(); this.pool = undefined; }
      else if (!this.pool) this.pool = new HelperPool(llm, helperSlots, sessionConfigOf(s, s.helpers.context));
      if (this.pool) {
        // "as many questions per call as there are slots" by default; the helpers take them in turn if there are fewer of them
        const branches = () => { const t = this.getSettings(), b = t.helpers.branches ?? 0; return b === 0 ? Math.max(1, t.slots) : limitOf(b, 1); };
        runnable.set('explore', makeExploreTool({
          pool: this.pool, llm, root: this.root, observationBytes: s.observationBytes, signal: abort.signal,
          maxSteps: () => limitOf(this.getSettings().helpers.maxSteps, 4), branches,
          onEvent: (n, e) => {
            this.emit({ type: 'trace', agent: n, event: e });
            if (turn) turn.helpers = Math.max(turn.helpers ?? 0, n);
            const d = describeEvent(e);
            if (d) this.emit({ type: 'progress', text: `   ↳ helper ${n} · ${d}` });
          },
        }));
      }
      const tools: AgentTool[] = [];
      for (const p of plan) {
        if (!p.enabled || !p.inPrompt) continue;
        const declined = 'The user declined this tool call. Do not retry it: answer without it, or say what you needed.';
        if (p.source === 'builtin') {
          const r = runnable.get(p.spec.name); if (!r) continue;
          if (p.readOnly) tools.push(r);
          else tools.push({ ...r, run: async (args) => { // changes files: the person is asked first
            if (this.needsApproval(p.spec.name, false, 'builtin') && (await this.askApproval(p.spec.name, '', false, args, abort.signal)) === 'deny') return declined;
            return r.run(args);
          } });
        } else if (p.mcp) {
          const t = p.mcp;
          tools.push(mcpAgentTool(this.hub, t, p.spec, async (args) => {
            if (!this.needsApproval(t.fullName, !!t.readOnly, 'mcp')) return undefined;
            return (await this.askApproval(t.fullName, t.server, !!t.readOnly, args, abort.signal)) === 'deny' ? declined : undefined;
          }, () => abort.signal));
        }
      }
      const sig = crypto.createHash('sha1').update(tools.map((t) => renderToolLine(t.spec)).join('\n')).digest('hex').slice(0, 12);
      // the session now holds THIS chat: its stored context, a cached system prompt (new chat), or a recap
      await this.attachChat(conv, buildSystemText(s.systemPrompt?.trim() || undefined, tools.map((t) => t.spec)), abort.signal);
      if (await conv.maybeReset()) this.emit({ type: 'status', text: 'The context was getting full: reset, keeping a short recap.' });
      // a restored chat has the OLD tool list pinned in its system prompt: say what is available now
      const toolNote = conv.primed && chat.toolsSig && chat.toolsSig !== sig
        ? `The tools you can call have changed. Use only these now:\n${tools.map((t) => renderToolLine(t.spec)).join('\n')}` : undefined;
      chat.toolsSig = sig;

      // the question is saved at once; the answer is added when it arrives
      turn = { id: crypto.randomBytes(4).toString('hex'), at: Date.now(), q: text, a: '', state: 'stopped', tools: [] };
      chat.turns.push(turn);
      if (chat.turns.length === 1) chat.title = titleFrom(text);
      this.persist(); this.emitChats(); this.emitTools();

      const task = opts.focusFile ? `${text}\n(The user has ${opts.focusFile} open in the editor.)` : text;
      const res = await runAgent({
        llm, conversation: conv, task, toolNote, tools,
        system: s.systemPrompt?.trim() || undefined,
        maxSteps: limitOf(s.maxSteps, 8), maxObservationBytes: Math.max(s.observationBytes, tools.some((t) => t.meta?.source === 'mcp') ? s.mcp.resultBytes : 0) + 250,
        maxTokens: tokenLimit(s), think: s.think,
        temperature: s.temperature, topP: s.topP, topK: s.topK, signal: abort.signal,
        // read again before every step: Think, the tool limit, the reply limit and sampling can be changed mid-question
        live: () => { const t = this.getSettings(); return { maxSteps: limitOf(t.maxSteps, 8), maxTokens: tokenLimit(t), think: t.think, temperature: t.temperature, topP: t.topP, topK: t.topK }; },
        onEvent: (e) => {
          this.emit({ type: 'trace', agent: 0, event: e });
          if (e.type === 'step') {
            if (e.call && turn) turn.tools.push({ name: e.call.name, args: e.call.args, ms: Math.round(e.totalMs), source: sourceOf.get(e.call.name) ?? 'builtin', bytes: e.observationBytes, result: e.observation?.slice(0, 1500) });
            const u = e.usage ?? {}, decMs = e.totalMs - e.ttftMs;
            if ((u.prompt_tokens ?? 0) >= 30 && e.ttftMs > 0) { rate.preTok += u.prompt_tokens!; rate.preMs += e.ttftMs; }
            if ((u.completion_tokens ?? 0) >= 3 && decMs > 0) { rate.decTok += u.completion_tokens! - 1; rate.decMs += decMs; }
          }
          const d = describeEvent(e);
          if (d) this.emit({ type: 'progress', text: d });
        },
      });
      if (res.reason !== 'context_full') conv.record(text, res.answer);
      const note = res.reason === 'context_full' ? '\n\n(The context is full. Turn on sliding in the settings, start a new chat, or ask a narrower question.)' : '';
      const seconds = (performance.now() - t0) / 1000;
      turn.a = (res.answer || '(no answer)') + note; turn.truncated = res.truncated; turn.seconds = seconds; turn.state = 'done';
      const f1 = (x: number | null) => (x === null || !isFinite(x) ? '\u2013' : x.toFixed(1));
      turn.speed = `prefill ${f1(rate.preMs ? rate.preTok / (rate.preMs / 1000) : null)} \u00b7 decode ${f1(rate.decMs ? rate.decTok / (rate.decMs / 1000) : null)} tok/s \u00b7 ${seconds.toFixed(1)}s`;
      this.emit({ type: 'answer', text: turn.a, truncated: res.truncated, seconds });
      await this.reportContext();
      this.snapshotDirty = true;
    } catch (e) {
      if (abort.signal.aborted) {
        await this.conv?.syncAfterAbort().catch(() => {});
        await this.pool?.syncAfterAbort().catch(() => {});
        this.snapshotDirty = this.convOwner === chat.id;
        this.emit({ type: 'status', text: 'Stopped.' });
      } else {
        const msg = this.friendly(e as Error);
        if (turn) { turn.state = 'error'; turn.a = msg; }
        this.emit({ type: 'error', text: msg });
      }
    } finally {
      this.busy = false;
      this.abort = undefined;
      this.denyAllApprovals();
      if (turn) { this.persist(); this.emitChats(); this.emitTools(); }
      this.emit({ type: 'busy', busy: false });
      this.armIdle();
      if (this.pendingApply) { this.pendingApply = false; void this.syncSessions(); } // settings changed during the question
      void this.queueSnapshot('answer');
    }
  }

  /** Turn the API's HTTP errors into advice. */
  private friendly(e: Error): string {
    if (/invalid url/i.test(e.message)) {
      const st = this.getSettings();
      return `${e.message}: an address could not be parsed. Check the settings "Use existing API at" (now: ${JSON.stringify(st.baseUrl ?? '')}) ` +
        `and "First API port" (now: ${JSON.stringify(st.runtime.basePort ?? '')}).`;
    }
    if (/HTTP 502/.test(e.message)) return `The API container cannot reach roaster serve. Is it still running, with its socket in ${this.getSettings().runtime.socketDir ?? '/tmp/roaster'}?`;
    if (/HTTP 503/.test(e.message)) return `The model server has no free slot. BlueCheese is set to use up to ${this.getSettings().slots}; other clients may be holding the rest. Lower "Slots" or free one.`;
    return e.message;
  }

  /** Cancel the running question. The server stops generating as soon as the connection closes. */
  stop(): void { this.abort?.abort(); }

  /** Stop just the API container (and with it the session). The open chat's context is stored first. `all` also stops containers from other processes. */
  async stopApi(opts: { all?: boolean; quiet?: boolean } = {}): Promise<void> {
    this.clearIdle();
    this.stop();
    await this.queueSnapshot('leave');
    await this.pool?.closeAll().catch(() => {});
    this.pool = undefined;
    await this.conv?.close().catch(() => {});
    this.conv = undefined; this.convOwner = null;
    this.emit({ type: 'context', window: 0, context: this.getSettings().profile.context ?? 16384, pinned: 0, spilled: 0, position: 0, sliding: true });
    if (this.runtime) await this.runtime.stopAll({ all: opts.all }).catch(() => {});
    if (this.api) { this.api = undefined; this.llm = undefined; }
    if (!opts.quiet) this.emit({ type: 'status', text: 'Roaster API stopped.' });
  }

  private async reportContext(): Promise<void> {
    if (!this.conv || !this.llm) return;
    const d = (await this.llm.sessionInfo(this.conv.id).catch(() => ({ data: undefined as any }))).data;
    if (typeof d?.position !== 'number') return;
    const ctx = typeof d.context_length === 'number' ? d.context_length : this.conv.contextLength;
    const m: ChatContextInfo = { window: typeof d.window_tokens === 'number' ? d.window_tokens : Math.min(d.position, ctx), context: ctx,
      pinned: d.pinned_tokens ?? 0, spilled: d.spilled_tokens ?? 0, position: d.position };
    if (this.convOwner === this.chat.id) this.chat.ctx = m;
    this.emit({ type: 'context', ...m, sliding: this.conv.sliding });
  }

  private clearIdle() { if (this.idle) clearTimeout(this.idle); this.idle = undefined; }

  private armIdle() {
    const mins = this.getSettings().idleMinutes;
    if (!this.api || !(mins > 0)) return; // only containers we started are shut down
    this.idle = setTimeout(() => {
      if (this.busy) return;
      void this.stopApi({ quiet: true }).then(() =>
        this.emit({ type: 'status', text: `Stopped the Roaster API after ${mins} idle minutes. The chat is saved: ask again to carry on.` }));
    }, mins * 60_000);
    this.idle.unref?.();
  }
}

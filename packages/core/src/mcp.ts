/**
 * Model Context Protocol (MCP) client, with no dependencies.
 *
 * - Transports: stdio (a local command) and Streamable HTTP (a URL). The old HTTP+SSE transport is not supported.
 * - Only what a tool client needs: initialize, tools/list (with paging and list_changed), tools/call (with cancel).
 *   Server requests are answered politely (ping) or refused (sampling, roots, elicitation): BlueCheese offers none of them.
 * - Config files use the format everyone else uses, so a file you already have works:
 *     .bluecheese/mcp.json   { "mcpServers": { "name": { "command": "npx", "args": [...], "env": {...} } } }
 *     .mcp.json              the same (Claude Code)
 *     .vscode/mcp.json       { "servers": { ... } } (VS Code)
 *   A server is either `command` (+ `args`, `env`, `cwd`) or `url` (+ `headers`). Later files win over earlier ones by name.
 *   `${workspaceFolder}`, `${userHome}` and `${env:NAME}` are expanded.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentTool, ToolParam, ToolSpec } from '@bluecheese/agent';

/* --------------------------------- config --------------------------------- */

export interface McpServerConfig {
  command?: string; args?: string[]; env?: Record<string, string>; cwd?: string;
  url?: string; headers?: Record<string, string>;
  /** `true` keeps the server in the list but never starts it. */
  disabled?: boolean;
  /** Seconds a tool call may take (default 60). */
  timeout?: number;
}
export interface McpConfigEntry { config: McpServerConfig; file: string }

/** Where the servers are read from, lowest priority first. */
export const MCP_CONFIG_FILES = ['.vscode/mcp.json', '.mcp.json', '.bluecheese/mcp.json'];

function expand(v: string, root: string): string {
  return v.replace(/\$\{workspaceFolder\}/g, root).replace(/\$\{userHome\}/g, os.homedir())
    .replace(/\$\{env:([^}]+)\}/g, (_, n: string) => process.env[n] ?? '');
}
function expandCfg(c: McpServerConfig, root: string): McpServerConfig {
  const map = (o?: Record<string, string>) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, expand(String(v), root)]));
  return {
    ...c,
    command: c.command && expand(c.command, root), args: c.args?.map((a) => expand(String(a), root)),
    env: map(c.env), cwd: c.cwd && expand(c.cwd, root), url: c.url && expand(c.url, root), headers: map(c.headers),
  };
}

export function loadMcpConfig(root: string): { servers: Record<string, McpConfigEntry>; errors: string[]; files: string[] } {
  const servers: Record<string, McpConfigEntry> = {}, errors: string[] = [], files: string[] = [];
  for (const rel of MCP_CONFIG_FILES) {
    const f = path.join(root, rel);
    if (!fs.existsSync(f)) continue;
    files.push(rel);
    let j: any;
    try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { errors.push(`${rel}: ${(e as Error).message}`); continue; }
    const block = j?.mcpServers ?? j?.servers;
    if (!block || typeof block !== 'object') { errors.push(`${rel}: no "mcpServers" (or "servers") object`); continue; }
    for (const [name, raw] of Object.entries<any>(block)) {
      if (!raw || typeof raw !== 'object') { errors.push(`${rel}: "${name}" is not an object`); continue; }
      if (!raw.command && !raw.url) { errors.push(`${rel}: "${name}" needs a "command" or a "url"`); continue; }
      servers[name] = { config: expandCfg(raw as McpServerConfig, root), file: rel };
    }
  }
  return { servers, errors, files };
}

/** Identifies what a server would run: a changed command, URL or environment must be approved again. */
export function serverFingerprint(name: string, c: McpServerConfig): string {
  const canon = JSON.stringify({ name, command: c.command, args: c.args, url: c.url, cwd: c.cwd, env: c.env && Object.entries(c.env).sort(), headers: c.headers && Object.keys(c.headers).sort() });
  return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

/** What a server would run, for people to read. */
export function describeServer(c: McpServerConfig): string {
  return c.url ? c.url : [c.command, ...(c.args ?? [])].join(' ');
}

/* -------------------------------- JSON-RPC -------------------------------- */

type Msg = { jsonrpc: '2.0'; id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string; data?: unknown } };

interface Transport {
  start(onMessage: (m: Msg) => void, onClose: (err?: Error) => void): Promise<void>;
  send(m: Msg, signal?: AbortSignal): Promise<void>;
  setProtocol(v: string): void;
  close(): Promise<void>;
  /** The last bit of what the server wrote to stderr (for error messages). */
  tail(): string;
}

class StdioTransport implements Transport {
  private proc?: ChildProcess;
  private err = '';
  constructor(private readonly cfg: McpServerConfig, private readonly root: string) {}
  tail() { return this.err.trim().slice(-600); }
  setProtocol() {}

  start(onMessage: (m: Msg) => void, onClose: (err?: Error) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const c = this.cfg;
      let spawned = false;
      const proc = this.proc = spawn(c.command!, c.args ?? [], {
        cwd: c.cwd ? path.resolve(this.root, c.cwd) : this.root,
        env: { ...process.env, ...c.env }, stdio: ['pipe', 'pipe', 'pipe'],
        shell: process.platform === 'win32', windowsHide: true,
      });
      proc.on('error', (e: NodeJS.ErrnoException) => {
        const err = new Error(e.code === 'ENOENT' ? `command not found: ${c.command} (is it installed and on the PATH that VS Code sees?)` : e.message);
        if (!spawned) reject(err); else onClose(err);
      });
      proc.on('spawn', () => { spawned = true; resolve(); });
      proc.on('close', (code, sig) => onClose(new Error(`the server exited (${sig ?? 'code ' + code})${this.tail() ? ': ' + this.tail() : ''}`)));
      proc.stderr!.setEncoding('utf8');
      proc.stderr!.on('data', (d: string) => { this.err = (this.err + d).slice(-4000); });
      proc.stdin!.on('error', () => { /* the close handler reports it */ });
      let buf = '';
      proc.stdout!.setEncoding('utf8');
      proc.stdout!.on('data', (d: string) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line.startsWith('{')) { if (line) this.err = (this.err + '\n' + line).slice(-4000); continue; } // stray log line
          try { onMessage(JSON.parse(line)); } catch { this.err = (this.err + '\n' + line).slice(-4000); }
        }
      });
    });
  }
  async send(m: Msg): Promise<void> {
    const p = this.proc;
    if (!p || !p.stdin || p.stdin.destroyed) throw new Error('the server is not running');
    await new Promise<void>((res, rej) => p.stdin!.write(JSON.stringify(m) + '\n', (e) => (e ? rej(e) : res())));
  }
  async close(): Promise<void> {
    const p = this.proc; if (!p) return;
    this.proc = undefined;
    try { p.stdin?.end(); } catch { /* already closed */ }
    await new Promise<void>((resolve) => {
      if (p.exitCode !== null || p.signalCode) return resolve();
      const t1 = setTimeout(() => p.kill('SIGTERM'), 500), t2 = setTimeout(() => { p.kill('SIGKILL'); resolve(); }, 2500);
      p.once('close', () => { clearTimeout(t1); clearTimeout(t2); resolve(); });
    });
  }
}

class HttpTransport implements Transport {
  private sessionId?: string;
  private protocol?: string;
  private onMessage: (m: Msg) => void = () => {};
  constructor(private readonly cfg: McpServerConfig) {}
  tail() { return ''; }
  setProtocol(v: string) { this.protocol = v; }
  async start(onMessage: (m: Msg) => void): Promise<void> {
    this.onMessage = onMessage;
    try { new URL(this.cfg.url!); } catch { throw new Error(`"${this.cfg.url}" is not a valid URL`); }
  }
  async send(m: Msg, signal?: AbortSignal): Promise<void> {
    const res = await fetch(this.cfg.url!, {
      method: 'POST', signal,
      headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...(this.protocol ? { 'MCP-Protocol-Version': this.protocol } : {}),
        ...this.cfg.headers,
      },
      body: JSON.stringify(m),
    });
    const sid = res.headers.get('mcp-session-id'); if (sid) this.sessionId = sid;
    if (res.status === 202 || res.status === 204) { await res.body?.cancel().catch(() => {}); return; }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(res.status === 401 || res.status === 403
        ? `HTTP ${res.status}: the server wants authentication. Add an Authorization header in the config (OAuth sign-in is not supported).`
        : `HTTP ${res.status}${body ? ': ' + body : ''}`);
    }
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream') && res.body) {
      const dec = new TextDecoder(); let buf = '';
      const reader = res.body.getReader();
      const flush = (chunk: string) => {
        const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (data) { try { this.onMessage(JSON.parse(data)); } catch { /* not JSON: ignore */ } }
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) { flush(buf.slice(0, i)); buf = buf.slice(i + 2); }
      }
      if (buf.trim()) flush(buf);
    } else {
      const j = await res.json().catch(() => undefined);
      for (const x of Array.isArray(j) ? j : j ? [j] : []) this.onMessage(x);
    }
  }
  async close(): Promise<void> {
    if (!this.sessionId) return;
    const sid = this.sessionId; this.sessionId = undefined;
    await fetch(this.cfg.url!, { method: 'DELETE', headers: { 'Mcp-Session-Id': sid, ...this.cfg.headers }, signal: AbortSignal.timeout(2000) }).catch(() => {});
  }
}

/* --------------------------------- client --------------------------------- */

export interface McpTool {
  name: string; title?: string; description?: string;
  inputSchema?: { type?: string; properties?: Record<string, any>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; title?: string; destructiveHint?: boolean };
}
export interface McpCallResult { content?: any[]; structuredContent?: unknown; isError?: boolean }

const PROTOCOL = '2025-06-18';

export class McpClient {
  serverInfo?: { name?: string; version?: string };
  private transport: Transport;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closed = false;
  closeError?: Error;

  constructor(readonly name: string, readonly cfg: McpServerConfig, root: string, private readonly hooks: { onToolsChanged?: () => void; onClose?: (e?: Error) => void } = {}) {
    this.transport = cfg.url ? new HttpTransport(cfg) : new StdioTransport(cfg, root);
  }

  get stderr(): string { return this.transport.tail(); }

  private onMessage = (m: Msg) => {
    if (m.id !== undefined && (m.result !== undefined || m.error) && !m.method) {
      const p = this.pending.get(Number(m.id)); if (!p) return;
      this.pending.delete(Number(m.id));
      if (m.error) p.reject(new Error(m.error.message || `error ${m.error.code}`)); else p.resolve(m.result);
      return;
    }
    if (m.method && m.id !== undefined) { // a request from the server
      const reply = m.method === 'ping' ? { jsonrpc: '2.0' as const, id: m.id, result: {} }
        : { jsonrpc: '2.0' as const, id: m.id, error: { code: -32601, message: `BlueCheese does not support ${m.method}` } };
      void this.transport.send(reply).catch(() => {});
      return;
    }
    if (m.method === 'notifications/tools/list_changed') this.hooks.onToolsChanged?.();
  };

  private failAll(err: Error) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private request<T = any>(method: string, params: unknown, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (this.closed) return Promise.reject(this.closeError ?? new Error('the connection is closed'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const ac = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => { if (timer) clearTimeout(timer); o.signal?.removeEventListener('abort', onAbort); };
      const finish = (f: () => void) => { done(); this.pending.delete(id); f(); };
      const onAbort = () => {
        void this.transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'cancelled by the user' } }).catch(() => {});
        ac.abort(); finish(() => reject(new Error('cancelled')));
      };
      if (o.signal?.aborted) return reject(new Error('cancelled'));
      o.signal?.addEventListener('abort', onAbort, { once: true });
      if (o.timeoutMs) timer = setTimeout(() => {
        void this.transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'timeout' } }).catch(() => {});
        ac.abort(); finish(() => reject(new Error(`no answer after ${Math.round(o.timeoutMs! / 1000)}s`)));
      }, o.timeoutMs);
      this.pending.set(id, { resolve: (v) => finish(() => resolve(v)), reject: (e) => finish(() => reject(e)) });
      this.transport.send({ jsonrpc: '2.0', id, method, params }, ac.signal).catch((e: Error) => { if (this.pending.has(id)) finish(() => reject(e)); });
    });
  }

  async connect(timeoutMs = 25_000): Promise<void> {
    await this.transport.start(this.onMessage, (err) => {
      this.closed = true; this.closeError = err;
      this.failAll(err ?? new Error('the connection closed'));
      this.hooks.onClose?.(err);
    });
    const r = await this.request('initialize', {
      protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'bluecheese', version: '0.0.8' },
    }, { timeoutMs });
    this.serverInfo = r?.serverInfo;
    this.transport.setProtocol(typeof r?.protocolVersion === 'string' ? r.protocolVersion : PROTOCOL);
    await this.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async listTools(timeoutMs = 20_000): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.request<{ tools?: McpTool[]; nextCursor?: string }>('tools/list', cursor ? { cursor } : {}, { timeoutMs });
      out.push(...(r?.tools ?? []));
      cursor = r?.nextCursor; if (!cursor) break;
    }
    return out;
  }

  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    return this.request('tools/call', { name, arguments: args }, { signal, timeoutMs: (this.cfg.timeout ?? 60) * 1000 });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error('the connection is closed'));
    await this.transport.close().catch(() => {});
  }
}

/* ---------------------------- tools for the agent ---------------------------- */

export interface McpToolInfo {
  server: string; name: string;
  /** The name the model uses: `server__tool`. */
  fullName: string;
  description: string; readOnly?: boolean;
  schema: NonNullable<McpTool['inputSchema']>;
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

/** The first sentence, squeezed to `max` characters: every byte of a tool description is paid for in every conversation. */
export function shorten(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(one);
  const first = m ? m[1] : one;
  return first.length > max ? first.slice(0, max - 1).trimEnd() + '…' : first;
}

/** A JSON Schema as the small parameter list the model is shown. Objects and arrays are passed as JSON text. */
export function mcpSpec(t: McpToolInfo, descMax = 110): ToolSpec {
  const props = t.schema.properties ?? {}, required = new Set(t.schema.required ?? []);
  const params: Record<string, ToolParam> = {};
  for (const [k, p0] of Object.entries<any>(props)) {
    const p = p0 ?? {};
    let type = Array.isArray(p.type) ? p.type.find((x: string) => x !== 'null') : p.type;
    const note: string[] = [];
    if (!['string', 'number', 'integer', 'boolean'].includes(type)) { if (type === 'array' || type === 'object') note.push('JSON'); type = 'string'; }
    if (Array.isArray(p.enum) && p.enum.length) note.push('one of ' + p.enum.slice(0, 8).map(String).join('|'));
    const d = [typeof p.description === 'string' ? shorten(p.description, 60) : '', ...note].filter(Boolean).join('; ');
    params[k] = { type, ...(d ? { description: d } : {}), ...(required.has(k) ? {} : { required: false }) };
  }
  return { name: t.fullName, description: shorten(t.description || t.name, descMax), params };
}

/** Undo the "objects and arrays as JSON text" simplification before calling the server. */
function restoreArgs(schema: McpToolInfo['schema'], args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  for (const [k, p] of Object.entries<any>(schema.properties ?? {})) {
    const type = Array.isArray(p?.type) ? p.type.find((x: string) => x !== 'null') : p?.type;
    if ((type === 'array' || type === 'object') && typeof out[k] === 'string') { try { out[k] = JSON.parse(out[k] as string); } catch { /* keep the text */ } }
  }
  return out;
}

export function formatResult(r: McpCallResult): string {
  const parts: string[] = [];
  for (const c of r.content ?? []) {
    if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c?.type === 'image' || c?.type === 'audio') parts.push(`[${c.type} ${c.mimeType ?? ''}, ${Math.round(String(c.data ?? '').length * 0.75)} bytes, not shown]`);
    else if (c?.type === 'resource_link') parts.push(`[resource ${c.uri}${c.name ? ' (' + c.name + ')' : ''}]`);
    else if (c?.type === 'resource') parts.push(typeof c.resource?.text === 'string' ? c.resource.text : `[resource ${c.resource?.uri ?? ''}, binary, not shown]`);
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  const text = parts.join('\n') || '(the tool returned nothing)';
  return r.isError ? `Error from the tool: ${text}` : text;
}

/* ----------------------------------- hub ----------------------------------- */

export type McpStatus = 'off' | 'connecting' | 'ready' | 'error' | 'denied' | 'disabled';
export interface McpServerState {
  name: string; status: McpStatus; error?: string;
  transport: 'stdio' | 'http'; target: string; file: string;
  tools: McpToolInfo[]; version?: string;
}

export interface McpHubOptions {
  root: string;
  /** Ask the person once before a server from a config file is started (it runs a command or contacts a URL). */
  confirm: (name: string, config: McpServerConfig, file: string) => Promise<boolean>;
  onChange?: () => void;
  log?: (line: string) => void;
}

/** All configured servers: connects them, lists their tools, calls them. A server that fails never stops the others. */
export class McpHub {
  private states = new Map<string, McpServerState>();
  private clients = new Map<string, McpClient>();
  private errors: string[] = [];
  private files: string[] = [];
  private generation = 0;

  constructor(private readonly o: McpHubOptions) { this.read(); }

  get configErrors(): string[] { return this.errors; }
  get configFiles(): string[] { return this.files; }
  get servers(): McpServerState[] { return [...this.states.values()]; }
  get tools(): McpToolInfo[] { return this.servers.flatMap((s) => s.tools); }

  /** (Re-)read the config files; servers that are not connected are shown as off. */
  private read(): Record<string, McpConfigEntry> {
    const { servers, errors, files } = loadMcpConfig(this.o.root);
    this.errors = errors; this.files = files;
    for (const name of [...this.states.keys()]) if (!servers[name] && !this.clients.has(name)) this.states.delete(name);
    for (const [name, e] of Object.entries(servers)) {
      const cur = this.states.get(name);
      if (cur && this.clients.has(name)) continue;
      this.states.set(name, {
        name, status: e.config.disabled ? 'disabled' : 'off', transport: e.config.url ? 'http' : 'stdio',
        target: describeServer(e.config), file: e.file, tools: [],
      });
    }
    return servers;
  }

  refreshConfig(): void { this.read(); this.o.onChange?.(); }

  /** Connect every server that is not disabled and that the person allows. Resolves when all have answered or failed. */
  async start(): Promise<void> {
    const gen = ++this.generation;
    await this.stop(false);
    const servers = this.read();
    this.o.onChange?.();
    await Promise.all(Object.entries(servers).map(([name, e]) => this.startOne(gen, name, e)));
  }

  private set(name: string, patch: Partial<McpServerState>) {
    const s = this.states.get(name); if (!s) return;
    Object.assign(s, patch); this.o.onChange?.();
  }

  private async startOne(gen: number, name: string, e: McpConfigEntry): Promise<void> {
    if (e.config.disabled) { this.set(name, { status: 'disabled' }); return; }
    let allowed = false;
    try { allowed = await this.o.confirm(name, e.config, e.file); } catch { /* treated as no */ }
    if (gen !== this.generation) return;
    if (!allowed) { this.set(name, { status: 'denied', error: 'Not allowed to start. Reload the servers to be asked again.' }); return; }
    this.set(name, { status: 'connecting', error: undefined });
    const client = new McpClient(name, e.config, this.o.root, {
      onToolsChanged: () => { void this.loadTools(gen, name, client); },
      onClose: (err) => { if (gen === this.generation && this.clients.get(name) === client) { this.clients.delete(name); this.set(name, { status: 'error', error: err?.message ?? 'the connection closed', tools: [] }); } },
    });
    this.clients.set(name, client);
    try {
      await client.connect();
      if (gen !== this.generation) { await client.close(); return; }
      await this.loadTools(gen, name, client);
      this.set(name, { status: 'ready', version: client.serverInfo?.version });
      this.o.log?.(`MCP ${name}: ready, ${this.states.get(name)?.tools.length ?? 0} tools`);
    } catch (err) {
      const stderr = client.stderr;
      await client.close().catch(() => {});
      this.clients.delete(name);
      if (gen === this.generation) this.set(name, { status: 'error', error: (err as Error).message + (stderr && !(err as Error).message.includes(stderr) ? ` — ${stderr.split('\n').slice(-2).join(' ')}` : ''), tools: [] });
      this.o.log?.(`MCP ${name}: ${(err as Error).message}`);
    }
  }

  private async loadTools(gen: number, name: string, client: McpClient): Promise<void> {
    const list = await client.listTools();
    if (gen !== this.generation || this.clients.get(name) !== client) return;
    const taken = new Set(this.tools.filter((t) => t.server !== name).map((t) => t.fullName));
    const tools: McpToolInfo[] = list.map((t) => {
      let full = `${slug(name)}__${slug(t.name)}`.slice(0, 64), n = 2;
      while (taken.has(full)) full = `${`${slug(name)}__${slug(t.name)}`.slice(0, 60)}_${n++}`;
      taken.add(full);
      return {
        server: name, name: t.name, fullName: full, description: t.description || t.title || t.annotations?.title || t.name,
        readOnly: t.annotations?.readOnlyHint === true, schema: t.inputSchema ?? { type: 'object', properties: {} },
      };
    });
    this.set(name, { tools });
  }

  /** Call a tool and return its result as text for the model. */
  async call(tool: McpToolInfo, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const c = this.clients.get(tool.server);
    if (!c) throw new Error(`the MCP server "${tool.server}" is not connected`);
    return formatResult(await c.callTool(tool.name, restoreArgs(tool.schema, args), signal));
  }

  async stop(clear = true): Promise<void> {
    if (clear) this.generation++;
    const cs = [...this.clients.values()]; this.clients.clear();
    await Promise.all(cs.map((c) => c.close().catch(() => {})));
    for (const s of this.states.values()) if (s.status !== 'disabled') { s.status = 'off'; s.tools = []; s.error = undefined; }
    if (clear) this.o.onChange?.();
  }
}

/**
 * Wrap an MCP tool as an agent tool. `gate` runs first (approval): a string it returns is the result instead of a call.
 * `signal` is the running question's abort signal, so Stop also cancels a call that is in flight.
 */
export function mcpAgentTool(
  hub: McpHub, t: McpToolInfo, spec: ToolSpec,
  gate: (args: Record<string, unknown>) => Promise<string | undefined>, signal: () => AbortSignal | undefined,
): AgentTool {
  return {
    spec, meta: { source: 'mcp', server: t.server, readOnly: t.readOnly },
    run: async (args) => {
      const stop = await gate(args);
      if (stop !== undefined) return stop;
      return hub.call(t, args, signal());
    },
  };
}

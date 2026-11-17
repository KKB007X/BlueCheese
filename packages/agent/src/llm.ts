/**
 * Client for Roaster's OpenAI-compatible API (see docs/ROASTER_USAGE.md).
 *
 * Roaster-specific behaviour handled here:
 *  - whole prompt must be <= 16000 bytes (HTTP 400 otherwise) → checked client-side
 *  - HTTP 503 = no free slot → retried with backoff
 *  - `stop` sequences and native `tools` are NOT supported by the server →
 *      stop is implemented client-side by closing the connection (which frees the slot)
 *  - requests belong to a SESSION whose context (KV cache) stays on the server: a follow-up request must send
 *    only the NEW messages. Without `session`, we use a throwaway session and delete it afterwards.
 *  - a session holds one slot until deleted, so leaking sessions leads to HTTP 503
 *  - thinking is off by default in api mode; pass `think: true` to enable
 *  - reasoning arrives in delta.reasoning_content
 */

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import https from 'node:https';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface ChatOptions {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxTokens?: number;      // includes thinking tokens
  think?: boolean;
  /** Persistent session name. Omit for a throwaway session (created, used once, deleted). */
  session?: string;
  /** Empty the session's context before this request. */
  reset?: boolean;
  /** Client-side stop strings. The stop string itself is kept at the end of `content`. */
  stop?: string[];
  signal?: AbortSignal;
  onToken?: (text: string, kind: 'content' | 'reasoning') => void;
  extraBody?: Record<string, unknown>;
}

export interface ChatResult {
  session: string;
  content: string;
  reasoning: string;
  finishReason?: string;
  /** Which stop string ended generation early, if any. */
  stoppedBy?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  /** Streamed chunks that carried text; fallback when the server sends no usage. */
  chunks: number;
  promptBytes: number;
  timings: { ttftMs: number; totalMs: number };
}

export interface LLMConfig {
  baseUrl: string;          // e.g. http://127.0.0.1:8080
  model: string;            // "roaster" (echoed back; does not select a model)
  apiKey?: string;
  /** Roaster's hard limit is 16000 bytes; keep margin for its "User: " flattening. */
  maxPromptBytes?: number;  // default 15000
  /** How many times to retry HTTP 503 (no free slot). Default 6. */
  retries503?: number;
}

export function llmConfigFromEnv(): LLMConfig {
  return {
    baseUrl: (process.env.BC_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, ''),
    model: process.env.BC_MODEL ?? 'roaster',
    apiKey: process.env.BC_API_KEY,
    maxPromptBytes: process.env.BC_MAX_PROMPT_BYTES ? Number(process.env.BC_MAX_PROMPT_BYTES) : undefined,
  };
}

/**
 * Turn what a person types into the API's base address. Accepts "127.0.0.1:8080", "localhost:8080/", ":8080", "8080",
 * "http://host:8080/v1" and similar; returns e.g. "http://127.0.0.1:8080". Throws a message that says what was wrong.
 */
export function normalizeBaseUrl(raw: string): string {
  let t = String(raw ?? '').trim();
  if (!t) throw new Error('The API address is empty. Example: http://127.0.0.1:8080');
  if (/^\d{2,5}$/.test(t)) t = `127.0.0.1:${t}`;
  else if (/^:\d{2,5}(\/|$)/.test(t)) t = `127.0.0.1${t}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = `http://${t}`;
  let u: URL;
  try { u = new URL(t); }
  catch { throw new Error(`"${raw}" is not a valid API address. Example: http://127.0.0.1:8080`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`"${raw}" must start with http:// or https://. Example: http://127.0.0.1:8080`);
  if (!u.hostname) throw new Error(`"${raw}" has no host name. Example: http://127.0.0.1:8080`);
  const prefix = u.pathname.replace(/\/+$/, '').replace(/\/v1(\/chat\/completions)?$/, '');
  return `${u.protocol}//${u.host}${prefix}`;
}

/**
 * Settings of one Roaster session (USAGE.md, "Changing settings on the fly"). All optional: whatever is left out
 * keeps the value the session already has, or the `roaster api` default for a new session.
 */
export interface SessionConfig {
  contextLength?: number;   // attention window, in tokens
  cacheRoute?: boolean;
  routeJ?: number; routeM?: number; routeAlpha?: number; routeP?: number;
  slide?: boolean;          // slide the window instead of failing when it is full (server default: on)
  keep?: number;            // tokens at the start that never slide out
}

/** The same keys as the JSON body of POST /v1/sessions and PATCH /v1/sessions/{id}. */
export function sessionConfigBody(c: SessionConfig): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const put = (k: string, v: unknown) => { if (v !== undefined) o[k] = v; };
  put('context_length', c.contextLength); put('cache_route', c.cacheRoute);
  put('route_j', c.routeJ); put('route_m', c.routeM); put('route_alpha', c.routeAlpha); put('route_p', c.routeP);
  put('slide', c.slide); put('keep', c.keep);
  return o;
}

/** What GET /v1/sessions/{id} reports about the context (fields that do not exist on an older server are undefined). */
export interface SessionInfo {
  loaded?: boolean; broken?: boolean; busy?: boolean;
  position?: number;        // tokens in the whole conversation (keeps counting when the window slides)
  context_length?: number;
  window_tokens?: number;   // tokens in the window right now
  spilled_tokens?: number;  // tokens that slid out to SSD
  pinned_tokens?: number;   // tokens of the pinned system prompt
}

export class LLMHttpError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`LLM HTTP ${status}: ${body.slice(0, 300)}`);
  }
}
export class PromptTooLargeError extends Error {
  constructor(readonly bytes: number, readonly max: number) {
    super(`Prompt is ${bytes} bytes; Roaster allows at most ${max}. Shrink the context pack or history.`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function promptBytes(messages: ChatMessage[]): number {
  // Roaster flattens to "User: …\nAssistant: …"; ~16 bytes of labels per message is a safe overestimate.
  return messages.reduce((s, m) => s + Buffer.byteLength(m.content, 'utf8') + 16, 0);
}

export class RoasterLLM {
  readonly cfg: LLMConfig;
  constructor(cfg: LLMConfig) { this.cfg = { ...cfg, baseUrl: normalizeBaseUrl(cfg.baseUrl) }; }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const ephemeral = !opts.session;
    const id = opts.session ?? `bc-${randomBytes(4).toString('hex')}`;
    try { return await this.chatOnce(messages, opts, id); }
    finally { if (ephemeral) await this.deleteSession(id).catch(() => {}); }
  }

  private async chatOnce(messages: ChatMessage[], opts: ChatOptions, sessionId: string): Promise<ChatResult> {
    const maxBytes = this.cfg.maxPromptBytes ?? 15000;
    const pBytes = promptBytes(messages);
    if (pBytes > maxBytes) throw new PromptTooLargeError(pBytes, maxBytes);

    const t0 = performance.now();
    if (opts.signal?.aborted) throw new Error('aborted'); // Stop was pressed between two steps: do not send another request
    const ac = new AbortController();
    opts.signal?.addEventListener('abort', () => ac.abort(), { once: true });

    const body = JSON.stringify({
      model: this.cfg.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: opts.temperature ?? 0.2,
      top_p: opts.topP,
      top_k: opts.topK,
      max_tokens: opts.maxTokens,
      think: opts.think ?? false,
      session: sessionId,
      reset: opts.reset ? true : undefined,
      ...opts.extraBody,
    });

    // --- connect, retrying 503 (all slots busy) ---
    // node:http (not fetch): Roaster sends no response headers until the first token, and prefill can take
    // minutes, which trips undici's default 300 s headers timeout. node:http has no such timeout.
    const url = new URL(`${this.cfg.baseUrl}/v1/chat/completions`);
    const headers: Record<string, string | number> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
    };
    const post = () => new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? https : http).request(
        url, { method: 'POST', headers, signal: ac.signal }, resolve);
      req.on('error', reject);
      req.end(body);
    });
    const readAll = async (res: http.IncomingMessage) => {
      let t = '';
      for await (const c of res) t += c.toString('utf8');
      return t;
    };

    let res: http.IncomingMessage;
    const maxRetries = this.cfg.retries503 ?? 6;
    for (let attempt = 0; ; attempt++) {
      res = await post();
      if (res.statusCode === 503 && attempt < maxRetries) {
        await readAll(res).catch(() => '');
        await sleep(Math.min(4000, 400 * 2 ** attempt));
        continue;
      }
      break;
    }
    if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
      throw new LLMHttpError(res.statusCode ?? 0, await readAll(res).catch(() => ''));
    }

    // --- stream ---
    let content = '', reasoning = '', chunks = 0, ttft = -1;
    let usage: ChatResult['usage'];
    let finishReason: string | undefined;
    let stoppedBy: string | undefined;

    const dec = new TextDecoder();
    let buf = '';

    const tick = () => { chunks++; if (ttft < 0) ttft = performance.now() - t0; };
    const emitC = (t: string) => { if (t) { content += t; tick(); opts.onToken?.(t, 'content'); } };
    const emitR = (t: string) => { if (t) { reasoning += t; tick(); opts.onToken?.(t, 'reasoning'); } };
    // Fallback for a server that leaves the reasoning inline: a reply that STARTS with <think>...</think> is reasoning.
    // (Only at the very start, so an answer that merely mentions the tag is left alone.)
    let inl: 'start' | 'think' | 'done' = 'start', hold = '';
    const feed = (text: string): void => {
      if (inl === 'done') { emitC(text); return; }
      if (inl === 'start') {
        hold += text;
        const t = hold.replace(/^\s+/, '');
        if (t.length < 7 && '<think>'.startsWith(t)) return; // might still turn into <think>
        if (!t.startsWith('<think>')) { inl = 'done'; const h = hold; hold = ''; emitC(h); return; }
        inl = 'think'; hold = t.slice(7); text = '';
      } else hold += text;
      const i = hold.indexOf('</think>');
      if (i >= 0) { emitR(hold.slice(0, i)); const rest = hold.slice(i + 8).replace(/^\n+/, ''); hold = ''; inl = 'done'; emitC(rest); return; }
      let k = Math.min(7, hold.length); // keep a possible partial </think> for the next chunk
      while (k > 0 && !'</think>'.startsWith(hold.slice(hold.length - k))) k--;
      emitR(hold.slice(0, hold.length - k)); hold = hold.slice(hold.length - k);
    };

    const checkStop = (): boolean => {
      for (const s of opts.stop ?? []) {
        const i = content.indexOf(s);
        if (i >= 0) { content = content.slice(0, i + s.length); stoppedBy = s; return true; }
      }
      return false;
    };

    try {
      outer: for await (const value of res) {
        buf += dec.decode(value as Buffer, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          let j: any;
          try { j = JSON.parse(payload); } catch { continue; }
          if (j.usage) usage = j.usage;
          const choice = j.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta;
          if (!delta) continue;
          if (delta.reasoning_content) {
            if (inl === 'start') { inl = 'done'; hold = ''; } // the server separates reasoning itself
            emitR(delta.reasoning_content);
          }
          if (delta.content) {
            feed(delta.content);
            if (checkStop()) { ac.abort(); break outer; } // closing the connection frees the slot
          }
        }
      }
    } catch (e) {
      if (!stoppedBy) throw e;
    } finally {
      res.destroy();
    }

    if (hold) { if ((inl as string) === 'think') emitR(hold); else emitC(hold); hold = ''; }
    const total = performance.now() - t0;
    return {
      session: sessionId, content, reasoning, finishReason, stoppedBy, usage, chunks, promptBytes: pBytes,
      timings: { ttftMs: ttft < 0 ? total : ttft, totalMs: total },
    };
  }

  /* ---------------------------- session admin ---------------------------- */

  private api(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${this.cfg.baseUrl}${path}`);
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = (url.protocol === 'https:' ? https : http).request(url, {
        method,
        headers: {
          ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      }, (res) => {
        let t = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (t += c));
        res.on('end', () => {
          let data: any = t;
          try { data = JSON.parse(t); } catch { /* keep text */ }
          resolve({ status: res.statusCode ?? 0, data });
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  private sp = (id: string) => `/v1/sessions/${encodeURIComponent(id)}`;

  /** Create a session with its own settings (a plain number is the context length). Unset values use the api defaults. */
  createSession(id: string, config?: number | SessionConfig) {
    const c: SessionConfig = typeof config === 'number' ? { contextLength: config } : config ?? {};
    return this.api('POST', '/v1/sessions', { id, ...sessionConfigBody(c) });
  }
  /** Change settings of an IDLE session for good. 409: busy (or unloaded, for the window); 400: bad value; 500: could not resize. */
  patchSession(id: string, config: SessionConfig) {
    return this.api('PATCH', this.sp(id), sessionConfigBody(config));
  }
  /** loaded, position, context_length, window_tokens, spilled_tokens, pinned_tokens, ram_bytes, state_bytes, broken, config. */
  sessionInfo(id: string): Promise<{ status: number; data: SessionInfo & Record<string, any> }> { return this.api('GET', this.sp(id)); }
  listSessions() { return this.api('GET', '/v1/sessions'); }
  stopSession(id: string) { return this.api('POST', `${this.sp(id)}/stop`); }
  resetSession(id: string) { return this.api('POST', `${this.sp(id)}/reset`); }
  unloadSession(id: string, discard = false) { return this.api('POST', `${this.sp(id)}/unload`, discard ? { discard: true } : undefined); }
  loadSession(id: string) { return this.api('POST', `${this.sp(id)}/load`); }
  /**
   * Store the whole context (window, recurrent state, slid-out part, system prompt) in a directory ON THE SERVER'S machine
   * (inside its container). Answers with the session state plus `saved_to` and `saved_bytes`. 409: busy or empty.
   */
  saveSession(id: string, dir: string) { return this.api('POST', `${this.sp(id)}/save`, { path: dir }); }
  /**
   * Replace the context of a loaded, idle session with one stored by `saveSession` (same model only).
   * 404: nothing saved there; 400: damaged, or from another model; 409: busy or unloaded.
   */
  restoreSession(id: string, dir: string) { return this.api('POST', `${this.sp(id)}/restore`, { path: dir }); }

  /** Delete a session and free its slot. Retries while the server is still finishing a stopped request (409). */
  async deleteSession(id: string) {
    let r = { status: 0, data: undefined as any };
    for (let i = 0; i < 8; i++) {
      r = await this.api('DELETE', this.sp(id));
      if (r.status !== 409) break;
      await sleep(300);
    }
    return r;
  }
}

/**
 * Agent loop on top of a Roaster SESSION.
 *
 * The session keeps the KV cache between requests, so after the first message we only ever send the
 * NEW message: a tool result (wrapped in <tool_response>), an error note, or the next question.
 *
 * Cost model measured on the dev laptop: step ≈ 2 s + newTokens / ~7.5 tok/s + replyTokens / ~7 tok/s.
 * So: tiny system prompt, small retrieval pack, capped tool outputs, few steps, and in a conversation
 * never resend what the model has already seen.
 */
import { RoasterLLM, type ChatMessage, type SessionConfig, type SessionInfo } from './llm.js';
import { renderToolInstructions, parseToolCalls, partialArgs, stripToolBlocks, type ToolSpec } from './toolcall.js';
import { fitPrompt, truncateBytes } from './prompt.js';

export interface AgentTool {
  spec: ToolSpec;
  run(args: Record<string, unknown>): Promise<string> | string;
  /** Where the tool comes from, for UIs that list or label tools. */
  meta?: { source: 'builtin' | 'mcp'; server?: string; readOnly?: boolean };
  /**
   * The model's reply was cut off by the token limit in the middle of a call to this tool. Return what is safe to run
   * from the part that was written (and a note for the model about where it stopped), or nothing.
   */
  salvage?(raw: string): { args: Record<string, unknown>; note: string } | undefined;
}

export type AgentEvent =
  | { type: 'start'; session: string; firstPromptBytes: number; shrunk: string[]; dropped: string[]; primed: boolean; carriedBytes: number }
  | { type: 'step'; n: number; ttftMs: number; totalMs: number; contextTokens?: number;
      call?: { name: string; args: Record<string, unknown>; repaired?: boolean }; observationBytes?: number;
      /** The tool result as the model got it (already cut to the size limit). */
      observation?: string; note?: string;
      /** Was Think on for this step, and how much reasoning came back (Think on but 0 = the server sent none). */
      think?: boolean; reasoningChars?: number;
      /** As reported by the server for this request: the NEW tokens, not the total. */
      usage?: { prompt_tokens?: number; completion_tokens?: number } }
  /** The model's tool call has been read and is about to run (or wait for approval): front-ends show it at once, before the result exists. */
  | { type: 'call'; n: number; call: { name: string; args: Record<string, unknown>; repaired?: boolean } }
  /** More of the conversation slid out of the window to SSD: code we thought the model had seen is forgotten. */
  | { type: 'slide'; spilledTokens: number; windowTokens?: number }
  /** A request is about to be sent (step `n`): front-ends open a box for it. */
  | { type: 'turn'; n: number; position?: number; windowTokens?: number; contextLength?: number; pinnedTokens?: number; spilledTokens?: number }
  /** One streamed piece of the reply: the model's reasoning, or its visible output (which for a tool step is the call itself). */
  | { type: 'token'; kind: 'content' | 'reasoning'; text: string };

/** Line ranges per file that are already in the model's context (so reads never pay for them twice). */
export type ShownMap = Map<string, [number, number][]>;

/**
 * One long-lived session shared by several questions. The system prompt and tool list are sent once;
 * follow-ups cost only their own tokens. `shown` remembers which lines the model has already seen.
 */
export class AgentConversation {
  readonly id = `bc-chat-${Math.random().toString(36).slice(2, 8)}`;
  primed = false;
  readonly shown: ShownMap = new Map();
  readonly history: { q: string; a: string }[] = [];
  /** Short recap of recent Q&A, sent once after an automatic reset so the thread is not lost. */
  memo = '';
  private created = false;
  /** Attention window in tokens. Follows `applyConfig`. */
  contextLength: number;
  /** The session's settings as the server has them (or will get them when the session is created). */
  readonly config: SessionConfig;
  private spilled = 0;

  constructor(readonly llm: RoasterLLM, contextLength = 8192, config: SessionConfig = {}) {
    this.contextLength = config.contextLength ?? contextLength;
    this.config = { ...config, contextLength: this.contextLength };
  }

  /** The window slides when it is full (the server default), so the conversation never runs out of room. */
  get sliding(): boolean { return this.config.slide !== false; }

  async ensure(): Promise<void> {
    if (this.created) return;
    const r = await this.llm.createSession(this.id, this.config);
    if (r.status >= 300) throw new Error(`Could not create session: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    this.created = true;
  }

  /**
   * Change settings of this session while it lives (context window, routing, sliding). Only what differs is sent.
   * Returns what changed; `deferred` is set (and nothing changed) when the server says the session is busy or unloaded.
   * Throws, leaving the session as it was, if the server refuses (bad value, out of memory).
   */
  async applyConfig(next: SessionConfig): Promise<{ changed: (keyof SessionConfig)[]; deferred?: string }> {
    const diff: SessionConfig = {};
    const changed: (keyof SessionConfig)[] = [];
    for (const k of Object.keys(next) as (keyof SessionConfig)[]) {
      if (next[k] !== undefined && next[k] !== this.config[k]) { (diff as Record<string, unknown>)[k] = next[k]; changed.push(k); }
    }
    if (!changed.length) return { changed };
    if (this.created) {
      const r = await this.llm.patchSession(this.id, diff);
      const why = typeof r.data === 'string' ? r.data : r.data?.error?.message ?? JSON.stringify(r.data);
      if (r.status === 409) return { changed: [], deferred: String(why).slice(0, 200) };
      if (r.status >= 300) throw new Error(`HTTP ${r.status}: ${String(why).slice(0, 200)}`);
    }
    Object.assign(this.config, diff);
    if (diff.contextLength) this.contextLength = diff.contextLength;
    return { changed };
  }

  /**
   * Feed in what GET /sessions/{id} says. When more tokens have slid out to SSD, the model can no longer see the
   * oldest code we sent, so `shown` is cleared (it may be read again; the cost is time, not correctness).
   * Returns true if it cleared. (Simple on purpose: it forgets everything rather than tracking positions.)
   */
  noteWindow(info: SessionInfo | undefined): boolean {
    const sp = info?.spilled_tokens;
    if (typeof sp !== 'number') return false;
    const grew = sp > this.spilled;
    this.spilled = sp;
    if (grew) this.shown.clear();
    return grew;
  }

  /**
   * Send the system prompt alone (plus a one-word user turn and a one-token reply) so the server reads and pins it now.
   * The result can be stored with `saveSession` and restored into any new conversation: its first real message then
   * skips the system prompt's prefill. Afterwards this conversation counts as started.
   */
  async primeSystem(systemText: string, o: { signal?: AbortSignal } = {}): Promise<void> {
    await this.ensure();
    await this.llm.chat([{ role: 'system', content: systemText }, { role: 'user', content: 'Ready.' }], { session: this.id, maxTokens: 1, think: false, signal: o.signal });
    this.primed = true; this.memo = ''; this.shown.clear();
    const info = (await this.llm.sessionInfo(this.id).catch(() => ({ data: undefined as SessionInfo | undefined }))).data;
    if (info) this.adopt(info);
  }

  /**
   * The server now holds a context this object did not build (a restored snapshot): take over its numbers.
   * Nothing is cleared: what the model saw before the snapshot is still in that context.
   */
  adopt(info: SessionInfo | undefined): void {
    this.created = true;
    this.primed = (info?.position ?? 0) > 0;
    this.spilled = info?.spilled_tokens ?? 0;
    this.memo = '';
    if (typeof info?.context_length === 'number' && info.context_length > this.contextLength) this.contextLength = info.context_length;
  }

  record(question: string, answer: string): void {
    this.history.push({ q: question.slice(0, 300), a: answer.slice(0, 700) });
    if (this.history.length > 6) this.history.shift();
  }

  /** Empty the context and forget everything (manual :reset). */
  async reset(): Promise<void> {
    if (this.created) await this.llm.resetSession(this.id);
    this.primed = false;
    this.shown.clear(); this.history.length = 0; this.memo = ''; this.spilled = 0;
  }

  /**
   * Reset, carrying a short recap, if the context cannot fit a typical question any more: a first message with a
   * pack (~350 tokens), two tool results (~1200) and the answer (~600) is about `reserveTokens`.
   * Never resets while the window slides (it never runs out). Call BEFORE building the pack. Returns true if it reset.
   */
  async maybeReset(reserveTokens = 2200): Promise<boolean> {
    if (!this.created || this.sliding) return false;
    const d = (await this.llm.sessionInfo(this.id)).data;
    if (!(typeof d?.position === 'number' && d.position + reserveTokens > this.contextLength * 0.95)) return false;
    const recap = this.history.slice(-2).map((h) => `Q: ${h.q}\nA: ${h.a}`).join('\n');
    await this.reset();
    this.memo = recap.slice(0, 1400);
    return true;
  }

  /**
   * After the caller aborted a request: wait for the server to finish stopping, then re-learn what the context holds.
   * An abort during prefill rolls the request back (position 0 = nothing was kept), so the next question must
   * send the system prompt again; an abort during generation keeps the message.
   */
  async syncAfterAbort(): Promise<void> {
    if (!this.created) return;
    for (let i = 0; i < 20; i++) {
      const d = (await this.llm.sessionInfo(this.id).catch(() => ({ data: undefined as any }))).data;
      if (d && d.busy !== true && typeof d.position === 'number') {
        this.primed = d.position > 0;
        if (!this.primed) this.shown.clear();
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async close(): Promise<void> {
    if (this.created) await this.llm.deleteSession(this.id);
    this.created = false;
  }
}

export interface AgentOptions {
  llm: RoasterLLM;
  tools: AgentTool[];
  task: string;
  /** Optional extra context for the first message (first thing to be shrunk if space is short). */
  context?: string;
  /**
   * For a conversation that already has its system prompt pinned: the tool list changed since then, so say what is
   * available now (sent with this message only).
   */
  toolNote?: string;
  /** Reuse a long-lived session instead of a throwaway one. */
  conversation?: AgentConversation;
  system?: string;
  maxSteps?: number;            // successful tool calls allowed before a forced final answer (default 5; Infinity = no limit)
  maxTokens?: number;           // per reply (default 600; thinking tokens count too; Infinity = no limit)
  temperature?: number;
  topP?: number;
  topK?: number;
  /** Let the model think before each reply: slower (decode ~7 tok/s) and the reasoning stays in the context. */
  think?: boolean;
  maxObservationBytes?: number; // cap on each tool result (default 1800)
  firstTurnBytes?: number;      // cap on the first message (default 6000)
  contextLength?: number;       // throwaway session context length (default 8192)
  slide?: boolean;              // throwaway session: slide the window when full (a long-lived conversation says so itself)
  /**
   * Read before every step, so a change made while the question runs (the Think toggle, a new tool limit,
   * different sampling) applies to the next step. Only what it returns overrides the fixed options above.
   */
  live?: () => Partial<Pick<AgentOptions, 'maxSteps' | 'maxTokens' | 'think' | 'temperature' | 'topP' | 'topK'>>;
  keepSession?: boolean;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  onToken?: (t: string) => void;
}

export interface AgentResult {
  answer: string;
  steps: number;
  session: string;
  reason: 'answered' | 'max_steps' | 'context_full';
  /** The final answer hit the token limit and was cut off. */
  truncated: boolean;
  totalMs: number;
}

export const DEFAULT_SYSTEM =
  'You are a coding assistant working in the user\'s project. Answer questions about the code by reading it with tools: find the right place first ' +
  '(list_files, find_files or grep), then read_file with a small line range. Never read a whole file: use outline to see its functions and line numbers. ' +
  'To fix a file, call check_file first (or diagnostics for TypeScript): it gives the line numbers of the problems; read only a few lines around them. ' +
  'Code lines are numbered; a result may be cut off: continue with read_file start/end. Never repeat a tool call. ' +
  'To create a file use write_file. To change a file that exists use edit_file (replace one exact piece of text) or replace_lines (replace line numbers), ' +
  'sending ONLY the changed lines: never rewrite a whole file for a small change, and never send a file again just to fix a mistake in it. ' +
  'The user approves each change; afterwards say briefly what you changed. If the user refers to something said earlier that you no longer see, use search_chat. ' +
  'For casual messages and requests that are not about the code, just reply naturally. Only when asked about bugs: list the ones you can demonstrate ' +
  '(line number and a failing input); if you find none, say so; never invent problems. Make at most one tool call per message. Keep answers short unless asked for more.';

/** The system turn exactly as `runAgent` sends it with a conversation's first message (so it can also be sent, and cached, on its own). */
export function buildSystemText(system: string | undefined, specs: ToolSpec[]): string {
  return `${system ?? DEFAULT_SYSTEM}${specs.some((t) => t.name === 'explore') ? EXPLORE_HINT : ''}\n\n${renderToolInstructions(specs)}`;
}

/** Added to the system prompt when the `explore` tool (helpers with their own context) is available. */
export const EXPLORE_HINT =
  ' When answering needs reading several functions, call explore with one question per line instead of reading code yourself: ' +
  'helpers read it in their own context and return short answers.';

/** What "no limit on the reply" sends to the server: with a sliding window the reply can never run out of room. */
export const UNLIMITED_TOKENS = 1_000_000;

const FORMAT_REMINDER = 'Use exactly: <tool_call>{"name": "TOOL", "arguments": {"param": "value"}}</tool_call>, or answer directly.';

export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  const t0 = performance.now();
  const emit = o.onEvent ?? (() => {});
  const specs = o.tools.map((t) => t.spec);
  const byName = new Map(o.tools.map((t) => [t.spec.name, t]));
  const obsCap = o.maxObservationBytes ?? 1800;
  const conv = o.conversation;
  const ctxLen = conv?.contextLength ?? o.contextLength ?? 8192;
  const sliding = conv ? conv.sliding : o.slide === true;

  /** The options as they are right now: fixed ones, overridden by what `live` returns. */
  const now = () => {
    const L = o.live?.() ?? {};
    return {
      maxSteps: L.maxSteps ?? o.maxSteps ?? 5,
      maxTokens: L.maxTokens ?? o.maxTokens ?? 600,
      think: L.think ?? o.think ?? false,
      temperature: L.temperature ?? o.temperature, topP: L.topP ?? o.topP, topK: L.topK ?? o.topK,
    };
  };

  let session: string;
  if (conv) { await conv.ensure(); session = conv.id; }
  else {
    session = `bc-agent-${Math.random().toString(36).slice(2, 8)}`;
    const created = await o.llm.createSession(session, { contextLength: ctxLen, slide: o.slide });
    if (created.status >= 300) throw new Error(`Could not create session: HTTP ${created.status} ${JSON.stringify(created.data).slice(0, 200)}`);
  }

  try {
    const primed = conv?.primed ?? false;
    const memo = !primed && conv?.memo ? `Earlier in this conversation:\n${conv.memo}` : '';
    // The instructions go in a real system turn: Roaster pins it, so it stays in the window however far the window slides.
    // (A system message only counts while the context is empty, so follow-up questions do not repeat it.)
    const systemText = primed ? '' : buildSystemText(o.system, specs);
    const cap = o.firstTurnBytes ?? 6000;
    const first = fitPrompt([
      { name: 'memory', text: memo, priority: 6 },
      { name: 'tools', text: primed && o.toolNote ? o.toolNote : '', priority: 8 },
      { name: 'context', text: o.context ? `Relevant code:\n${o.context}` : '', priority: 3 },
      { name: 'task', text: `Question: ${o.task}`, priority: 9 },
    ], Math.max(1500, cap - Buffer.byteLength(systemText)));
    emit({ type: 'start', session, firstPromptBytes: first.bytes + Buffer.byteLength(systemText), shrunk: first.shrunk, dropped: first.dropped, primed, carriedBytes: Buffer.byteLength(memo) });

    let next = first.text;
    let pinnedSystem: ChatMessage | undefined = systemText ? { role: 'system', content: systemText } : undefined;
    let answer = '';
    let reason: AgentResult['reason'] = 'max_steps';
    let truncated = false;
    let steps = 0;
    let toolCalls = 0, badStreak = 0, repeatStreak = 0, forcedSent = false, retriedFinal = false;
    const seen = new Set<string>();

    for (let turn = 1; ; turn++) {
      const cur = now();
      if (turn > cur.maxSteps + 8) break; // only reachable with a finite limit
      // a failed tool call is cheap to retry, so it does not use up the tool budget, but two in a row end the loop;
      // with no limit on steps, three identical calls in a row end it too (a repeat is answered locally, so nothing else would)
      const outOfSteps = toolCalls >= cur.maxSteps, looping = repeatStreak >= 3;
      const forced = forcedSent || outOfSteps || badStreak >= 2 || looping;
      if (forced && !forcedSent) {
        next += looping && !outOfSteps
          ? '\n\nYou keep repeating the same tool call. Give your final answer now, without a tool call.'
          : '\n\nTool budget used up. Give your final answer now, without a tool call.';
        forcedSent = true;
      }

      const info = (await o.llm.sessionInfo(session)).data;
      const pos: number | undefined = typeof info?.position === 'number' ? info.position : undefined;
      if (conv?.noteWindow(info)) emit({ type: 'slide', spilledTokens: info.spilled_tokens ?? 0, windowTokens: info.window_tokens });

      let maxTokens = cur.maxTokens;
      if (sliding) {
        if (!Number.isFinite(maxTokens)) maxTokens = UNLIMITED_TOKENS;
      } else {
        const room = pos === undefined ? Infinity : ctxLen * 0.97 - pos - Buffer.byteLength(next) / 2.5;
        if (!Number.isFinite(maxTokens)) maxTokens = Math.max(64, Math.floor(Number.isFinite(room) ? room : 4096));
        else if (room < maxTokens) { reason = 'context_full'; break; }
      }

      const messages: ChatMessage[] = pinnedSystem ? [pinnedSystem, { role: 'user', content: next }] : [{ role: 'user', content: next }];
      emit({ type: 'turn', n: turn, position: pos, windowTokens: info?.window_tokens ?? pos, contextLength: info?.context_length ?? ctxLen,
             pinnedTokens: info?.pinned_tokens, spilledTokens: info?.spilled_tokens });
      const r = await o.llm.chat(messages, {
        session, maxTokens, think: cur.think, signal: o.signal,
        temperature: cur.temperature, topP: cur.topP, topK: cur.topK,
        onToken: (t, kind) => { emit({ type: 'token', kind, text: t }); if (kind === 'content') o.onToken?.(t); },
      });
      pinnedSystem = undefined; // sent once, with the first message
      if (conv) { conv.primed = true; conv.memo = ''; }
      steps = turn;
      const base = { n: turn, ttftMs: r.timings.ttftMs, totalMs: r.timings.totalMs, contextTokens: pos, usage: r.usage, think: cur.think, reasoningChars: r.reasoning.length };

      let { calls, errors } = parseToolCalls(r.content, specs);
      // The reply hit the token limit in the middle of a tool call: whatever the repair logic could read of it is incomplete
      // (a half-written file!), so nothing of it runs. Tell the model what happened and how much it may write per call.
      const cutOff = r.finishReason === 'length' && !r.stoppedBy && /<(?:tool)+[_-]?call>|<function=/.test(r.content) && !/<\/(?:tool)+[_-]?call>|<\/function>/.test(r.content);
      let salvageNote = '';
      // A call that cannot run as written (cut off, or its format is broken) may still hold work that should not be thrown away:
      // a tool that can use what was written says so, and the model is told what happened instead of producing it all again.
      if (cutOff || (!calls.length && errors.length && /<(?:tool)+[_-]?call>|<function=/.test(r.content))) {
        const pa = partialArgs(r.content), tool = pa.name ? byName.get(pa.name) : undefined, kept = tool?.salvage?.(r.content);
        if (kept && pa.name) {
          calls = [{ name: pa.name, args: kept.args, style: 'json', raw: r.content, repaired: true }];
          errors = []; salvageNote = kept.note.replace('{limit}', String(maxTokens)).replace('{lines}', String(Math.max(10, Math.floor(maxTokens / 14 / 5) * 5)));
        } else if (cutOff) {
          calls = [];
          const lines = Math.max(10, Math.floor(maxTokens / 14 / 5) * 5);
          errors = [`your reply hit the ${maxTokens}-token limit while you were writing the tool call, so it was cut off and nothing ran. ` +
            `Send a shorter call: at most about ${lines} lines of text per call (for a long file use write_file for the first part, then write_file with append=true for each next part)`];
        }
      }
      if (!forced && calls.length) {
        const call = calls[0]; // one call per step
        badStreak = 0; toolCalls++;
        let obs: string;
        emit({ type: 'call', n: base.n, call: { name: call.name, args: call.args, ...(call.repaired ? { repaired: true } : {}) } });
        const key = call.name + JSON.stringify(call.args);
        if (seen.has(key)) {
          // a repeat would cost a minute of prefill for the same text; answer it cheaply instead
          repeatStreak++;
          obs = 'You already made this exact call; its result is above (it may have been cut off). ' +
                'Use read_file with start/end to see more, or answer now.';
        } else {
          repeatStreak = 0;
          seen.add(key);
          try { obs = String(await byName.get(call.name)!.run(call.args)); }
          catch (e) { obs = `Error: ${(e as Error).message}`; }
          obs = truncateBytes(obs, obsCap);
          if (salvageNote) obs += `\n${salvageNote}`;
        }
        emit({ type: 'step', ...base, call: { name: call.name, args: call.args, ...(call.repaired ? { repaired: true } : {}) }, observationBytes: Buffer.byteLength(obs), observation: obs });
        next = `<tool_response>\n${obs}\n</tool_response>`;
        continue;
      }
      if (!forced && errors.length) {
        badStreak++;
        emit({ type: 'step', ...base, note: `bad tool call: ${errors.join('; ')}` });
        next = `Error: ${errors.join('; ')}${cutOff ? '.' : ` ${FORMAT_REMINDER}`}`;
        continue;
      }

      const text = stripToolBlocks(r.content).replace(/^\s*final answer\s*:\s*/i, '');
      if (forced && !text && !retriedFinal) {
        // the model wrote a tool call instead of an answer: one cheap, firmer nudge
        retriedFinal = true;
        emit({ type: 'step', ...base, note: 'asked for a final answer but got a tool call; asking again' });
        next = 'Write your final answer in plain text now. Do not write a tool call.';
        continue;
      }
      emit({ type: 'step', ...base });
      answer = text || '(The model did not produce a final answer. Ask again, or narrow the question.)';
      truncated = r.finishReason === 'length';
      reason = forced ? 'max_steps' : 'answered';
      break;
    }
    return { answer, steps, session, reason, truncated, totalMs: performance.now() - t0 };
  } finally {
    if (!conv && !o.keepSession) await o.llm.deleteSession(session).catch(() => {});
  }
}

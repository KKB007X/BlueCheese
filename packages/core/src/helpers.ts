/**
 * Helpers: extra conversations (slots) that do focused code reading for the main one, so the main context only
 * receives short answers instead of pages of code.
 *
 * - The main conversation takes one slot; a pool of `slots - 1` helper conversations does the subtasks.
 * - A helper keeps its context between subtasks: its instructions are sent once, and it remembers what it read.
 *   When its context is nearly full it is reset.
 * - Honest trade-off: this keeps the MAIN context small and lets you leave slots free for other work. It does not make
 *   answers faster: the model server shares its compute between slots, and each helper still has to read the code.
 */
import { AgentConversation, runAgent, type AgentEvent, type AgentTool, type RoasterLLM, type SessionConfig, type ToolSpec } from '@bluecheese/agent';
import { makeTools } from './tools.js';

export const HELPER_SYSTEM =
  'You are a code helper. Answer the question about the code in at most 6 short lines with file:line references. ' +
  'Find the code with grep or find_files, then read_file a small range. Never repeat a tool call. Code lines are numbered. ' +
  'Report only what you saw; if you did not see a whole function, say so. One tool call per message. Plain text.';

export class HelperPool {
  private all: AgentConversation[] = [];
  private free: AgentConversation[] = [];
  private waiters: ((c: AgentConversation) => void)[] = [];
  private closed = false;

  /** `size` = how many helpers may run at once; `config` = the settings every helper session gets (see `configure`). */
  constructor(private readonly llm: RoasterLLM, public size: number, public config: SessionConfig) {}

  get contextLength(): number { return this.config.contextLength ?? 8192; }

  /** How many helper conversations have been created so far (they are created on demand). */
  get created(): number { return this.all.length; }

  async acquire(): Promise<AgentConversation> {
    if (this.closed) throw new Error('The helper pool is closed.');
    const f = this.free.pop();
    if (f) return f;
    if (this.all.length < this.size) {
      const c = new AgentConversation(this.llm, this.contextLength, this.config);
      this.all.push(c);
      return c;
    }
    return new Promise((resolve) => this.waiters.push(resolve)); // every helper is busy: wait for one
  }

  release(c: AgentConversation): void {
    const w = this.waiters.shift();
    if (w) w(c); else this.free.push(c);
  }

  /**
   * Change the pool while it lives. Helpers that exist keep their conversation: their session settings are changed in
   * place (context window, routing, sliding). If the pool got smaller, idle helpers beyond the new size are closed.
   * Call only when no question is running. Returns what changed and what could not be applied.
   */
  async configure(size: number, config: SessionConfig): Promise<{ changed: string[]; problems: string[] }> {
    const changed = new Set<string>(), problems: string[] = [];
    if (size !== this.size) changed.add('slots');
    this.size = size;
    this.config = { ...config };
    const results = await Promise.all(this.all.map((c) => c.applyConfig(config).catch((e: Error) => ({ changed: [] as string[], deferred: undefined as string | undefined, error: e.message }))));
    for (const r of results) {
      for (const k of r.changed) changed.add(k);
      if ('error' in r && r.error) problems.push(r.error);
      else if (r.deferred) problems.push(r.deferred);
    }
    // close idle helpers beyond the new size (their slots go back to the server)
    while (this.all.length > this.size && this.free.length) {
      const c = this.free.pop()!;
      this.all.splice(this.all.indexOf(c), 1);
      await c.close().catch(() => {});
    }
    return { changed: [...changed], problems: [...new Set(problems)] };
  }

  /** After the user pressed Stop: re-learn what each helper's context holds. */
  async syncAfterAbort(): Promise<void> {
    await Promise.all(this.all.map((c) => c.syncAfterAbort().catch(() => {})));
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    await Promise.all(this.all.map((c) => c.close().catch(() => {})));
    this.all = []; this.free = []; this.waiters = [];
  }
}

export interface ExploreOptions {
  pool: HelperPool;
  llm: RoasterLLM;
  /** The project folder the helpers read. */
  root: string;
  /** Tool calls a helper may make per question. Infinity = no limit. A function is read for every question and every step. */
  maxSteps: number | (() => number);
  /**
   * Most questions one `explore` call may carry (the helpers take them in turn if there are fewer helpers than questions).
   * Infinity = no limit. A function is read for every call.
   */
  branches: number | (() => number);
  observationBytes: number;
  signal?: AbortSignal;
  onEvent?: (helper: number, e: AgentEvent) => void;
}

/** What the model is told about `explore` (also shown in the tool list of the UI). */
export function exploreSpec(branches: number): ToolSpec {
  return {
    name: 'explore',
    description: `Hand code-reading questions to helpers that each have their own fresh context. Returns short answers. ` +
      (Number.isFinite(branches) ? `At most ${branches} questions per call.` : 'Any number of questions per call.'),
    params: { questions: { type: 'string', description: 'one question per line' } },
  };
}

/** The `explore` tool: run each question (one per line) in its own helper conversation, concurrently. */
export function makeExploreTool(o: ExploreOptions): AgentTool {
  const num = (v: number | (() => number)) => (typeof v === 'function' ? v() : v);
  return {
    meta: { source: 'builtin', readOnly: true },
    spec: exploreSpec(num(o.branches)),
    run: async (args) => {
      const questions = String(args.questions ?? '').split('\n').map((q) => q.trim()).filter(Boolean).slice(0, Math.max(1, num(o.branches)));
      if (!questions.length) return 'Error: give at least one question, one per line.';
      const answers = await Promise.all(questions.map(async (q, i) => {
        const helper = await o.pool.acquire();
        try {
          await helper.maybeReset(1500); // a helper task is small: about 1500 tokens of headroom is enough
          const res = await runAgent({
            llm: o.llm, conversation: helper, system: HELPER_SYSTEM, task: q,
            tools: makeTools(o.root, { maxBytes: o.observationBytes, shown: helper.shown }),
            maxSteps: num(o.maxSteps), maxObservationBytes: o.observationBytes + 250, maxTokens: 350, signal: o.signal,
            live: () => ({ maxSteps: num(o.maxSteps) }),
            onEvent: (e) => o.onEvent?.(i + 1, e),
          });
          return `${i + 1}) ${q}\n${res.answer}`;
        } catch (e) {
          if (o.signal?.aborted) throw e;
          return `${i + 1}) ${q}\nThe helper failed: ${(e as Error).message}`;
        } finally {
          o.pool.release(helper);
        }
      }));
      return answers.join('\n\n');
    },
  };
}

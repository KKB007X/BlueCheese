/**
 * Saved chats of one project folder: one small JSON file per chat in <project>/.bluecheese/chats/.
 *
 * A chat has two halves:
 *  - the TRANSCRIPT (this file): what you asked, what the model answered, which tools it used. Always saved.
 *  - the CONTEXT (the model's memory of it: KV cache and recurrent state): stored by `roaster serve` in a directory on ITS
 *    machine (see `snapshot`). This is what lets a chat continue exactly where it stopped. If it is missing, the chat
 *    continues from a short recap of the transcript instead.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ChatTurnTool {
  name: string; args: Record<string, unknown>; ms: number;
  /** Where the tool came from: "builtin" or the MCP server's name. */
  source: string;
  bytes?: number; result?: string;
}
export interface ChatTurn {
  id: string; at: number; q: string; a: string;
  state: 'done' | 'stopped' | 'error';
  seconds?: number; truncated?: boolean;
  tools: ChatTurnTool[]; helpers?: number;
  /** The speed line shown under the answer. */
  speed?: string;
}
export interface ChatSnapshot { path: string; savedAt: number; bytes?: number; position?: number }
export interface ChatContextInfo { window: number; context: number; pinned: number; spilled: number; position: number }

export interface ChatRecord {
  version: 1; id: string; title: string; createdAt: number; updatedAt: number;
  turns: ChatTurn[];
  /** The last few Q&A pairs: the recap used when the saved context cannot be restored. */
  history: { q: string; a: string }[];
  /** Line ranges of files the model has already read in this chat (so it does not read them twice). */
  shown: [string, [number, number][]][];
  snapshot?: ChatSnapshot;
  ctx?: ChatContextInfo;
  /** Fingerprint of the tool list the pinned system prompt was written with. */
  toolsSig?: string;
}

export interface ChatSummary {
  id: string; title: string; createdAt: number; updatedAt: number; turns: number;
  /** Last question, for a hint under the title. */
  preview: string;
  contextSavedAt?: number; contextBytes?: number;
}

export const CHAT_ID = /^c-[a-z0-9]{6,14}-[a-z0-9]{3,8}$/;

export function newChatId(): string {
  return `c-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex').slice(0, 5)}`;
}

/** A title from the first question: one line, cut at a word. */
export function titleFrom(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= 56) return one || 'New chat';
  const cut = one.slice(0, 56), sp = cut.lastIndexOf(' ');
  return (sp > 30 ? cut.slice(0, sp) : cut) + '…';
}

export class ChatStore {
  readonly dir: string;
  /** Short, stable name of this project folder: the snapshots of all its chats live under it on the server. */
  readonly projectKey: string;

  constructor(readonly root: string) {
    this.dir = path.join(root, '.bluecheese', 'chats');
    const h = crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 8);
    this.projectKey = `${path.basename(root).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 24) || 'project'}-${h}`;
  }

  private file(id: string): string {
    if (!CHAT_ID.test(id)) throw new Error('invalid chat id');
    return path.join(this.dir, `${id}.json`);
  }

  private ensureDir(): void {
    if (fs.existsSync(this.dir)) return;
    fs.mkdirSync(this.dir, { recursive: true });
    // chats and MCP settings may hold private text: keep the whole folder out of git unless the project says otherwise
    const ig = path.join(this.root, '.bluecheese', '.gitignore');
    if (!fs.existsSync(ig)) fs.writeFileSync(ig, '*\n');
  }

  create(): ChatRecord {
    const now = Date.now();
    return { version: 1, id: newChatId(), title: 'New chat', createdAt: now, updatedAt: now, turns: [], history: [], shown: [] };
  }

  exists(id: string): boolean { try { return fs.existsSync(this.file(id)); } catch { return false; } }

  load(id: string): ChatRecord | undefined {
    try {
      const j = JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as ChatRecord;
      if (j?.version !== 1 || j.id !== id || !Array.isArray(j.turns)) return undefined;
      j.history ??= []; j.shown ??= [];
      return j;
    } catch { return undefined; }
  }

  /** Written to a temporary file first, so a crash never leaves half a chat. */
  save(rec: ChatRecord): void {
    this.ensureDir();
    const f = this.file(rec.id), tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec));
    fs.renameSync(tmp, f);
  }

  delete(id: string): boolean {
    try { fs.rmSync(this.file(id), { force: true }); return true; } catch { return false; }
  }

  summarize(r: ChatRecord): ChatSummary {
    const last = r.turns[r.turns.length - 1];
    return {
      id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt, turns: r.turns.length,
      preview: last ? last.q.replace(/\s+/g, ' ').slice(0, 80) : '',
      contextSavedAt: r.snapshot?.savedAt, contextBytes: r.snapshot?.bytes,
    };
  }

  /** Newest first. Chats that cannot be read are skipped. */
  list(): ChatSummary[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.json') && n !== '_state.json'); } catch { return []; }
    const out: ChatSummary[] = [];
    for (const n of names) {
      const id = n.slice(0, -5);
      if (!CHAT_ID.test(id)) continue;
      const r = this.load(id); if (r) out.push(this.summarize(r));
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Which chat was open last. */
  get activeId(): string | undefined {
    try { const id = JSON.parse(fs.readFileSync(path.join(this.dir, '_state.json'), 'utf8')).active; return CHAT_ID.test(id) ? id : undefined; } catch { return undefined; }
  }
  set activeId(id: string | undefined) {
    try { this.ensureDir(); fs.writeFileSync(path.join(this.dir, '_state.json'), JSON.stringify({ active: id ?? null })); } catch { /* not important */ }
  }
}

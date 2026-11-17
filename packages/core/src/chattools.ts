import type { AgentTool } from '@bluecheese/agent';
import type { ChatRecord, ChatStore } from './chats.js';

interface Seg { chat: string; label: string; text: string; order: number }

const WORD = /[\p{L}\p{N}_]{2,}/gu;

/** Everything said in a chat, piece by piece: your question, the answer, and each tool result. */
function segments(c: ChatRecord, name: string, skipTurn?: string, order = 0): Seg[] {
  const out: Seg[] = [];
  c.turns.forEach((t, i) => {
    if (t.id === skipTurn) return;
    const n = i + 1;
    out.push({ chat: name, label: `turn ${n} · you`, text: t.q, order: order + n });
    if (t.a) out.push({ chat: name, label: `turn ${n} · answer`, text: t.a, order: order + n });
    for (const tc of t.tools) {
      if (tc.result) out.push({ chat: name, label: `turn ${n} · ${tc.name}(${JSON.stringify(tc.args).slice(0, 60)}) result`, text: tc.result, order: order + n });
    }
  });
  return out;
}

function snippet(text: string, words: string[], width = 190): string {
  const low = text.toLowerCase();
  const at = Math.max(0, Math.min(...words.map((w) => low.indexOf(w)).filter((i) => i >= 0)));
  const start = Math.max(0, at - 50), end = Math.min(text.length, start + width);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

/**
 * Tools to look back in the conversation. The model's context is a window: what slid out of it is on the server's SSD as
 * tensors, which no tool can read. The saved TRANSCRIPT has everything though (questions, answers, tool results up to
 * 1.5 KB each; not the thinking), so the model can search that and read a turn again.
 */
export function makeChatTools(get: () => { chat: ChatRecord; skipTurn?: string }, store: ChatStore, maxBytes = 1200): AgentTool[] {
  const meta = { source: 'builtin' as const, readOnly: true };
  return [
    {
      meta,
      spec: {
        name: 'search_chat',
        description: 'Search what was said earlier in this conversation (also text that is no longer in your context). Returns short snippets with turn numbers.',
        params: {
          query: { type: 'string', description: 'words to look for' },
          all_chats: { type: 'boolean', description: 'also search the other saved chats of this project', required: false },
        },
      },
      run: (a) => {
        const { chat, skipTurn } = get();
        const words = [...new Set((String(a.query).toLowerCase().match(WORD) ?? []))];
        if (!words.length) return 'Error: give at least one word to search for.';
        let segs = segments(chat, 'this chat', skipTurn);
        let searched = chat.turns.length - (skipTurn ? 1 : 0);
        if (a.all_chats === true) {
          for (const s of store.list()) {
            if (s.id === chat.id) continue;
            const other = store.load(s.id); if (!other) continue;
            segs = segs.concat(segments(other, `chat "${other.title.slice(0, 40)}"`, undefined, -1e6 + other.updatedAt / 1e9));
            searched += other.turns.length;
          }
        }
        const need = Math.ceil(words.length / 2);
        const hits = segs.map((s) => { const low = s.text.toLowerCase(); return { s, n: words.filter((w) => low.includes(w)).length }; })
          .filter((h) => h.n >= need).sort((x, y) => y.n - x.n || y.s.order - x.s.order).slice(0, 6);
        if (!hits.length) return `(nothing found in ${searched} saved turn(s). The saved text has questions, answers and tool results, not the model's thinking.)`;
        let out = `${hits.length} match(es) in ${searched} turn(s). Use read_turn(turn) to read one in full.\n`;
        for (const h of hits) {
          const line = `[${a.all_chats === true ? h.s.chat + ' · ' : ''}${h.s.label}] ${snippet(h.s.text, words)}\n`;
          if (Buffer.byteLength(out + line) > maxBytes && out.includes('[')) break;
          out += line;
        }
        return out.trimEnd();
      },
    },
    {
      meta,
      spec: {
        name: 'read_turn',
        description: 'Read one earlier turn of this conversation in full: the question, the tools used and the answer.',
        params: {
          turn: { type: 'integer', description: 'turn number, as shown by search_chat' },
          offset: { type: 'integer', description: 'character to continue from, if the turn was cut off', required: false },
        },
      },
      run: (a) => {
        const { chat, skipTurn } = get();
        const t = chat.turns[Number(a.turn) - 1];
        if (!t || t.id === skipTurn) return `Error: there is no turn ${a.turn} (this chat has ${chat.turns.length - (skipTurn ? 1 : 0)} finished turn(s)).`;
        const tools = t.tools.map((c) => `- ${c.name}(${JSON.stringify(c.args).slice(0, 120)}) → ${(c.result ?? '').slice(0, 400).replace(/\s+/g, ' ')}`).join('\n');
        const full = `Turn ${a.turn}\nYou: ${t.q}\n${tools ? `Tools used:\n${tools}\n` : ''}Answer: ${t.a || '(none)'}`;
        const off = Math.max(0, Number(a.offset ?? 0));
        let end = Math.min(full.length, off + maxBytes);
        while (end > off && Buffer.byteLength(full.slice(off, end)) > maxBytes) end -= 50;
        return full.slice(off, end) + (end < full.length ? `\n… cut. Continue: read_turn(turn=${a.turn}, offset=${end})` : '');
      },
    },
  ];
}

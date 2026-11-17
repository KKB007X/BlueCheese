/**
 * Roaster rejects prompts over 16000 bytes and has no KV reuse between requests, so every
 * step is a full prefill. We assemble each step's prompt from prioritised sections and shrink
 * the lowest-priority ones first until it fits.
 */

export interface Section {
  name: string;
  text: string;
  /** Higher = more important. The lowest-priority section is shrunk or dropped first. */
  priority: number;
}

export interface FittedPrompt { text: string; bytes: number; shrunk: string[]; dropped: string[] }

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const SEP = '\n\n';

export function truncateBytes(text: string, target: number): string {
  if (bytes(text) <= target) return text;
  const note = '\n…[truncated]';
  let end = Math.max(0, Math.min(text.length, target - bytes(note)));
  while (end > 0 && bytes(text.slice(0, end)) > target - bytes(note)) end--;
  const nl = text.lastIndexOf('\n', end);
  if (nl > end * 0.6) end = nl; // prefer a line boundary
  return text.slice(0, end) + note;
}

export function fitPrompt(sections: Section[], maxBytes: number): FittedPrompt {
  const live = sections.filter((s) => s.text.trim()).map((s) => ({ ...s }));
  const shrunk = new Set<string>();
  const dropped: string[] = [];
  const total = () => live.reduce((n, s) => n + bytes(s.text), 0) + Math.max(0, live.length - 1) * SEP.length;

  while (total() > maxBytes && live.length) {
    let idx = 0;
    for (let i = 1; i < live.length; i++) if (live[i].priority < live[idx].priority) idx = i;
    const s = live[idx];
    const over = total() - maxBytes;
    const cur = bytes(s.text);
    if (cur - over >= 400) { s.text = truncateBytes(s.text, cur - over); shrunk.add(s.name); }
    else { dropped.push(s.name); live.splice(idx, 1); }
  }
  const text = live.map((s) => s.text).join(SEP);
  return { text, bytes: bytes(text), shrunk: [...shrunk], dropped };
}

/**
 * Text-based tool calling. Roaster ignores `tools`, so we describe tools in the prompt,
 * stop the stream at </tool_call>, and parse what the model wrote.
 *
 * The parser accepts both common Qwen styles so we don't have to guess which one the model prefers:
 *   JSON : <tool_call>{"name":"read_symbol","arguments":{"name":"foo"}}</tool_call>
 *   XML  : <tool_call><function=read_symbol><parameter=name>foo</parameter></function></tool_call>
 */

export interface ToolParam {
  type: 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  required?: boolean; // default true
}
export interface ToolSpec { name: string; description: string; params: Record<string, ToolParam> }
export interface ParsedToolCall { name: string; args: Record<string, unknown>; style: 'json' | 'xml'; raw: string; repaired?: boolean }

export const TOOL_STOP = ['</tool_call>'];

/** An opening / closing tool-call tag, typos included (`<tooltool_call>`, `<tool-call>`, `<toolcall>`). */
export const OPEN_TAG = /<(?:tool)+[_-]?call>/;
export const CLOSE_TAG = /<\/(?:tool)+[_-]?call>/;

/** Remove tool-call blocks (also ones closed with a stray <tool_call>) from model text. */
export const stripToolBlocks = (s: string) => s.replace(/<(?:tool)+[_-]?call>[\s\S]*?(?:<\/(?:tool)+[_-]?call>|(?=<(?:tool)+[_-]?call>)|$)/g, '').replace(/<function=[\s\S]*?(?:<\/function>|$)/g, '').replace(/<\/?(?:tool)+[_-]?call>/g, '').trim();

/** One tool as the line the model reads in the system prompt. */
export function renderToolLine(t: ToolSpec): string {
  const sig = Object.entries(t.params)
    .map(([k, p]) => `${k}${p.required === false ? '?' : ''}: ${p.type}`).join(', ');
  const notes = Object.entries(t.params).filter(([, p]) => p.description)
    .map(([k, p]) => `    ${k}: ${p.description}`).join('\n');
  return `- ${t.name}(${sig}) — ${t.description}${notes ? '\n' + notes : ''}`;
}

export function renderToolInstructions(tools: ToolSpec[]): string {
  return [
    'You can call tools. To call one, write exactly one block and then stop:',
    '<tool_call>{"name": "TOOL_NAME", "arguments": {"param": "value"}}</tool_call>',
    'The result will arrive in the next message. When you are done, answer normally with no tool_call block.',
    '',
    'Tools:',
    ...tools.map(renderToolLine),
  ].join('\n');
}

/**
 * Small models sometimes write almost-JSON: missing colons or commas, single quotes, full-width punctuation,
 * or `tool(arg="x")`. Instead of failing (a retry costs a whole step), find a known tool name and pull
 * each declared parameter out with a forgiving pattern.
 */
/**
 * Read a JSON-style string whose opening quote is just before `from`. Models often forget to escape quotes inside code, so
 * a quote only ENDS the string when what follows looks like the end of a value (`,"key":`, `}`, a closing tag, or the end of
 * the text); any other quote is taken as part of the text. Without this a call with `"hi"` inside code is silently cut short.
 */
export function scanString(s: string, from: number): { raw: string; end: number; closed: boolean } {
  const tail = /\s*(?:,\s*"[\w-]+"\s*:|\}|<\/|$)/y;
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '"') { tail.lastIndex = i + 1; if (tail.test(s)) return { raw: s.slice(from, i), end: i + 1, closed: true }; }
  }
  return { raw: s.slice(from), end: s.length, closed: false };
}

function lenient(raw: string, tools: ToolSpec[]): { name: string; args: Record<string, unknown> } | undefined {
  let best: { spec: ToolSpec; at: number } | undefined;
  for (const t of tools) {
    const at = raw.search(new RegExp(`\\b${t.name}\\b`));
    if (at >= 0 && (!best || at < best.at)) best = { spec: t, at };
  }
  if (!best) return undefined;
  const rest = raw.slice(best.at + best.spec.name.length);
  const args: Record<string, unknown> = {};
  for (const k of Object.keys(best.spec.params)) {
    const q = new RegExp(`["']?${k}["']?\\s*[:=\\uFF1A]?\\s*"`).exec(rest);   // a double-quoted string value: read it carefully
    if (q) { args[k] = unescapeJson(scanString(rest, q.index + q[0].length).raw); continue; }
    const m = new RegExp(`["']?${k}["']?\\s*[:=\\uFF1A]?\\s*('[^']*'|-?\\d+(?:\\.\\d+)?|true|false)`).exec(rest);
    if (!m) continue;
    const v = m[1];
    if (v === 'true' || v === 'false') args[k] = v === 'true';
    else if (/^-?\d/.test(v)) args[k] = Number(v);
    else if (v.startsWith('"')) { try { args[k] = JSON.parse(v); } catch { args[k] = v.slice(1, -1); } }
    else args[k] = v.slice(1, -1);
  }
  // `read_file(tetris.py)`: one bare value and one required parameter
  const required = Object.entries(best.spec.params).filter(([, p]) => p.required !== false).map(([k]) => k);
  if (!Object.keys(args).length && required.length === 1) {
    const m = /^\s*\(\s*["']?([^"'()\s,][^"'(),]*?)["']?\s*\)/.exec(rest);
    if (m) args[required[0]] = m[1];
  }
  return { name: best.spec.name, args };
}

/** Names small models use instead of the real parameter name. */
const ALIASES: Record<string, string[]> = {
  path: ['file', 'file_path', 'filepath', 'filename', 'file_name', 'pathname', 'filepath', 'name', 'target', 'fname'],
  pattern: ['query', 'regex', 'search', 'text', 'q', 'term'],
  query: ['q', 'search', 'text', 'pattern', 'term'],
  content: ['text', 'code', 'contents', 'body', 'data', 'file_content', 'source'],
  old: ['old_str', 'old_text', 'old_string', 'find', 'original', 'search', 'before'],
  new: ['new_str', 'new_text', 'new_string', 'replace', 'replacement', 'after'],
  questions: ['question', 'queries', 'query'],
  turn: ['turn_number', 'n', 'index', 'id'],
  start: ['start_line', 'from', 'line_start', 'begin'],
  end: ['end_line', 'to', 'line_end'],
};
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A required parameter is missing: look for the same thing under another name, or a single stray argument. */
function fixNames(spec: ToolSpec, args: Record<string, unknown>): { args: Record<string, unknown>; fixed: boolean } {
  const out = { ...args };
  let fixed = false;
  const missing = () => Object.entries(spec.params).filter(([k, p]) => p.required !== false && out[k] === undefined).map(([k]) => k);
  for (const want of missing()) {
    const have = Object.keys(out).find((k) => !(k in spec.params) && (ALIASES[want] ?? []).some((a) => norm(a) === norm(k)) || (!(k in spec.params) && norm(k) === norm(want)));
    if (have) { out[want] = out[have]; delete out[have]; fixed = true; }
  }
  const still = missing(), stray = Object.keys(out).filter((k) => !(k in spec.params));
  if (still.length === 1 && stray.length === 1 && typeof out[stray[0]] === spec.params[still[0]].type.replace('integer', 'number')) {
    out[still[0]] = out[stray[0]]; delete out[stray[0]]; fixed = true;
  }
  return { args: out, fixed };
}

/** What a correct call to this tool looks like. */
function example(spec: ToolSpec): string {
  const a = Object.fromEntries(Object.entries(spec.params).filter(([, p]) => p.required !== false).map(([k, p]) => [k, p.type === 'string' ? `<${k}>` : p.type === 'boolean' ? true : 1]));
  return `<tool_call>${JSON.stringify({ name: spec.name, arguments: a })}</tool_call>`;
}

function coerce(spec: ToolSpec | undefined, args: Record<string, unknown>): Record<string, unknown> {
  if (!spec) return args;
  const out: Record<string, unknown> = { ...args };
  for (const [k, p] of Object.entries(spec.params)) {
    const v = out[k];
    if (typeof v !== 'string') continue;
    if (p.type === 'number' || p.type === 'integer') { const n = Number(v); if (!Number.isNaN(n)) out[k] = n; }
    else if (p.type === 'boolean') out[k] = v.trim().toLowerCase() === 'true';
  }
  return out;
}

export function parseToolCalls(text: string, tools: ToolSpec[] = []): { calls: ParsedToolCall[]; errors: string[] } {
  const calls: ParsedToolCall[] = [];
  const errors: string[] = [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  // a block is `<tool_call>…</tool_call>`, or a bare `<function=…>…</function>` that the model wrote without the wrapper
  const re = /<(?:tool)+[_-]?call>([\s\S]*?)(?:<\/(?:tool)+[_-]?call>|(?=<(?:tool)+[_-]?call>)|$)|(<function=[\s\S]*?)(?:<\/function>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = (m[1] ?? m[2] ?? '').trim();
    if (!raw) continue;
    let name = '', args: Record<string, unknown> | undefined, style: 'json' | 'xml' = 'json', repaired = false;

    if (raw.startsWith('{')) {
      try {
        const j = JSON.parse(raw.slice(0, raw.lastIndexOf('}') + 1));
        name = j.name;
        let a = j.arguments ?? j.parameters ?? {};
        if (typeof a === 'string') a = JSON.parse(a);
        args = a;
      } catch {
        const fixed = lenient(raw, tools);
        if (!fixed) { errors.push(`Invalid tool_call JSON: ${JSON.stringify(raw.slice(0, 100))}.`); continue; }
        name = fixed.name; args = fixed.args; repaired = true;
      }
    } else {
      const f = /<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/.exec(raw);
      if (!f) {
        const fixed = lenient(raw, tools);
        if (!fixed) { errors.push(`Unrecognised tool_call: ${JSON.stringify(raw.slice(0, 100))}.`); continue; }
        name = fixed.name; args = fixed.args; repaired = true;
      } else {
        style = 'xml'; name = f[1]; args = {};
        const body = f[2].trim();
        if (body.startsWith('{')) {
          // a mix of both styles: <function=NAME>{"arguments": {...}}  (or the arguments directly)
          try {
            const j = JSON.parse(body.slice(0, body.lastIndexOf('}') + 1));
            const a = j.arguments ?? j.parameters ?? j;
            args = typeof a === 'string' ? JSON.parse(a) : a; style = 'json'; repaired = true;
          } catch { /* cut off or broken: the arguments stay empty and the caller reports it */ }
        } else {
          const pr = /<parameter=([^>\s]+)>\s*([\s\S]*?)\s*<\/parameter>/g;
          let p: RegExpExecArray | null;
          while ((p = pr.exec(f[2]))) args[p[1]] = p[2];
        }
      }
    }

    if (!name || typeof name !== 'string') { errors.push('tool_call has no name.'); continue; }
    if (tools.length && !byName.has(name)) { errors.push(`Unknown tool "${name}". Available: ${tools.map((t) => t.name).join(', ')}`); continue; }
    const spec = byName.get(name);
    let finalArgs = coerce(spec, args ?? {});
    if (spec) { const f = fixNames(spec, finalArgs); if (f.fixed) { finalArgs = coerce(spec, f.args); repaired = true; } }
    const missing = spec ? Object.entries(spec.params).filter(([k, p]) => p.required !== false && finalArgs[k] === undefined).map(([k]) => k) : [];
    if (missing.length) {
      const sent = JSON.stringify(args ?? {}).slice(0, 100);
      errors.push(`Tool "${name}" is missing argument(s): ${missing.join(', ')}. You sent ${sent}. Write it like this: ${example(spec!)}`);
      continue;
    }
    calls.push({ name, args: finalArgs, style, raw, ...(repaired ? { repaired } : {}) });
  }
  return { calls, errors };
}

/** Undo JSON string escapes in text that may end in the middle of one. */
function unescapeJson(t: string): string {
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c !== '\\') { out += c; continue; }
    const n = t[i + 1];
    if (n === undefined) break;                                   // cut off right after a backslash
    if (n === 'u') { const h = t.slice(i + 2, i + 6); if (/^[0-9a-fA-F]{4}$/.test(h)) { out += String.fromCharCode(parseInt(h, 16)); i += 5; continue; } break; }
    out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[n] ?? n; i++;
  }
  return out;
}

/**
 * What can be read of a tool call that was cut off: its name, and each argument that was written, with the one that
 * was still being written (`open`) marked. Understands the JSON, XML and mixed styles.
 */
export function partialArgs(text: string): { name?: string; args: Record<string, string | boolean | number>; open?: string } {
  let start = -1; for (const m of text.matchAll(/<(?:tool)+[_-]?call>/g)) start = m.index!;
  const body = start >= 0 ? text.slice(start) : text;
  const out: { name?: string; args: Record<string, string | boolean | number>; open?: string } = { args: {} };
  const fn = /<function=([^>\s]+)>/.exec(body);
  const jn = /"name"\s*:\s*"([\w.-]+)"/.exec(body);
  out.name = fn?.[1] ?? jn?.[1];
  if (/<parameter=/.test(body)) {
    const re = /<parameter=([^>\s]+)>([\s\S]*?)(?:<\/parameter>|$)/g; let m: RegExpExecArray | null;
    while ((m = re.exec(body))) {
      const closed = /<\/parameter>/.test(m[0]);
      out.args[m[1]] = m[2].replace(/^\n/, '').replace(closed ? /\n$/ : /$^/, '');
      if (!closed) out.open = m[1];
    }
    return out;
  }
  const keyRe = /"([\w-]+)"\s*:\s*/g; let m: RegExpExecArray | null; let pos = 0, first = true;
  while ((keyRe.lastIndex = pos, m = keyRe.exec(body))) {
    const at = m.index + m[0].length, key = m[1];
    if (body[at] === '"') {
      const v = scanString(body, at + 1);
      if (first && key === 'name' && v.raw === out.name) { first = false; pos = v.end; continue; }   // the tool's own name
      out.args[key] = unescapeJson(v.raw); if (!v.closed) out.open = key;
      pos = v.end;
    } else {
      const lit = /^(true|false|-?\d+(?:\.\d+)?)/.exec(body.slice(at));
      if (lit) out.args[key] = lit[1] === 'true' ? true : lit[1] === 'false' ? false : Number(lit[1]);
      pos = at + (lit ? lit[0].length : 0);
    }
    first = false;
  }
  return out;
}

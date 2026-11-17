import fs from 'node:fs';
import path from 'node:path';
import type { AgentTool } from '@bluecheese/agent';
import { partialArgs } from '@bluecheese/agent';
import { checkSource, formatCheck, outlineSource } from './codecheck.js';
import { writablePath } from './fsutil.js';
import type { ShownMap } from './tools.js';

const MAX_WRITE = 300_000;
/** Why `old` was not found, and what the file really has there: so the next call is a small fix, not a rewrite. */
function nearest(text: string, old: string): string {
  const file = text.replace(/\r\n/g, '\n').split('\n'), want = old.replace(/\r\n/g, '\n').split('\n');
  const show = (from: number, count: number) => file.slice(from, from + count).map((l, i) => `${from + i + 1}: ${l}`).join('\n');
  // the same lines with different indentation or spacing?
  const t = (l: string) => l.trim().replace(/\s+/g, ' ');
  const w = want.map(t);
  for (let i = 0; i + w.length <= file.length; i++) {
    if (w.every((x, k) => t(file[i + k]) === x)) return `The same lines exist at ${i + 1}-${i + w.length} but with different spacing or indentation. The file has:\n${show(i, w.length)}\nCopy that exactly, or use replace_lines(start=${i + 1}, end=${i + w.length}).`;
  }
  // the closest line to the first meaningful line of `old`
  const key = w.find((x) => x.length >= 6);
  if (key) {
    const words = (x: string) => new Set(x.toLowerCase().match(/\w+/g) ?? []), kw = words(key);
    let hit = -1, best = 0;
    file.forEach((l, i) => {
      const lw = words(l); if (!lw.size) return;
      const score = [...kw].filter((x) => lw.has(x)).length / Math.max(kw.size, lw.size);
      if (score > best) { best = score; hit = i; }
    });
    if (hit >= 0 && best >= 0.5) return `The closest text is near line ${hit + 1}:\n${show(Math.max(0, hit - 1), Math.min(5, want.length + 2))}\nCopy the exact text from there, or use replace_lines with those line numbers.`;
  }
  return 'Read the file again (read_file) and copy the text exactly, or use replace_lines with line numbers.';
}

/** After a change: what a syntax check says (and, for a new file, its outline), so the next edit can aim at the right lines. */
function feedback(abs: string, rel: string, outline: boolean): string {
  try {
    const src = fs.readFileSync(abs, 'utf8'), check = formatCheck(checkSource(rel, src), src);
    const ol = outline && !check.includes('problem(s)') && src.split('\n').length >= 60 ? `\nOutline (line numbers for read_file / replace_lines):\n${outlineSource(rel, src)}` : '';
    return check ? `\n${check}${ol}` : ol;
  } catch { return ''; }
}

const lines = (t: string) => (t === '' ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0));

/**
 * The tools that CHANGE files: `write_file` and `edit_file`. Kept apart from `makeTools` (which is read-only and is also
 * what helpers and the CLI use). The controller asks the person before each call unless they said otherwise.
 */
export function makeEditTools(root: string, opts: { shown?: ShownMap } = {}): AgentTool[] {
  root = path.resolve(root);
  const meta = { source: 'builtin' as const, readOnly: false };
  const forget = (file: string) => opts.shown?.delete(file); // line numbers changed: what the model saw is stale

  return [
    {
      meta,
      spec: {
        name: 'write_file',
        description: 'Create a new file, or replace a whole file (slow). For any change to an existing file use edit_file or replace_lines instead. Keep a call under ~80 lines: add the rest with append=true.',
        params: {
          path: { type: 'string', description: 'repo-relative path; folders are created' },
          content: { type: 'string', description: 'the full text of the file' },
          append: { type: 'boolean', description: 'add to the end of the file instead of replacing it', required: false },
        },
      },
      /**
       * The call could not be run as written (it was cut off by the reply limit, or its format was broken) but its text is
       * here: keep what was written instead of making the model produce all of it again.
       */
      salvage: (raw) => {
        const pa = partialArgs(raw), path_ = pa.args.path, content = pa.args.content;
        if (typeof path_ !== 'string' || !path_ || typeof content !== 'string' || pa.open === 'path') return undefined;
        const append = pa.args.append === true;
        if (pa.open !== 'content') {   // all of it is there: only the call's format was wrong
          if (!content.trim()) return undefined;
          return {
            args: { path: path_, content, append },
            note: `The call had a formatting problem, so its content was recovered and written as you sent it: nothing needs to be sent again. ` +
              `If something in the file is wrong, fix just that with edit_file or replace_lines. Do not rewrite the file.`,
          };
        }
        const nl = content.lastIndexOf('\n');
        if (nl < 0) return undefined;                                    // not even one complete line
        const kept = content.slice(0, nl + 1), n = lines(kept), last = kept.slice(0, -1).split('\n').pop()!.trim().slice(0, 80);
        return {
          args: { path: path_, content: kept, append, partial: true },
          note: `Your reply hit the {limit}-token limit in the middle of the call, so only the first ${n} line(s) were written (the last written line is: ${JSON.stringify(last)}). ` +
            `Do NOT start over: continue with write_file(path=${JSON.stringify(path_)}, append=true) and put the remaining lines in content, beginning with the line right after that one. Keep each call under about {lines} lines.`,
        };
      },
      run: (a) => {
        const rel = String(a.path ?? '');
        const w = writablePath(root, rel);
        if ('error' in w) return `Error: ${w.error}`;
        let content = String(a.content ?? '');
        if (Buffer.byteLength(content) > MAX_WRITE) return `Error: content is over ${MAX_WRITE / 1000} KB. Write it in parts with append=true.`;
        if (content && !content.endsWith('\n')) content += '\n';
        const existed = fs.existsSync(w.abs);
        try {
          fs.mkdirSync(path.dirname(w.abs), { recursive: true });
          if (a.append === true && existed) fs.appendFileSync(w.abs, content); else fs.writeFileSync(w.abs, content);
        } catch (e) { return `Error: could not write ${rel}: ${(e as Error).message}`; }
        const file = path.relative(root, w.abs).split(path.sep).join('/');
        forget(file);
        const total = lines(fs.readFileSync(w.abs, 'utf8'));
        if (a.append === true && existed) return `Appended ${lines(content)} line(s) to ${file} (now ${total} lines). When the whole file is written, call check_file.`;
        return `${existed ? 'Replaced' : 'Created'} ${file} (${lines(content)} lines).` +
          (existed ? ' That rewrote the whole file: for the next change use edit_file or replace_lines with just the changed lines.' : '') +
          (a.partial === true ? '' : feedback(w.abs, file, true));
      },
    },
    {
      meta,
      spec: {
        name: 'edit_file',
        description: 'Change an existing file by replacing one exact piece of text with another (send only the changed part, never the whole file). Read the file first and copy the old text exactly. If copying is hard, use replace_lines.',
        params: {
          path: { type: 'string', description: 'repo-relative path' },
          old: { type: 'string', description: 'the exact text to replace; it must occur once in the file (include enough lines to be unique)' },
          new: { type: 'string', description: 'the replacement (may be empty to delete the old text)' },
        },
      },
      run: (a) => {
        const rel = String(a.path ?? '');
        const w = writablePath(root, rel);
        if ('error' in w) return `Error: ${w.error}`;
        if (!fs.existsSync(w.abs)) return `Error: no such file: ${rel}. Use write_file to create it.`;
        let text = fs.readFileSync(w.abs, 'utf8'), from = String(a.old ?? ''), to = String(a.new ?? '');
        if (!from) return 'Error: "old" is empty. Give the exact text to replace.';
        if (text.includes('\r\n') && !from.includes('\r')) { from = from.replace(/\n/g, '\r\n'); to = to.replace(/\n/g, '\r\n'); } // keep the file's line endings
        const first = text.indexOf(from);
        if (first < 0) return `Error: the old text was not found in ${rel}. ${nearest(text, from)}`;
        if (text.indexOf(from, first + 1) >= 0) {
          const n = text.split(from).length - 1;
          return `Error: the old text occurs ${n} times in ${rel}. Add more surrounding lines so it matches once.`;
        }
        text = text.slice(0, first) + to + text.slice(first + from.length);
        try { fs.writeFileSync(w.abs, text); } catch (e) { return `Error: could not write ${rel}: ${(e as Error).message}`; }
        const file = path.relative(root, w.abs).split(path.sep).join('/');
        forget(file);
        const at = text.slice(0, first).split('\n').length;
        return `Edited ${file} at line ${at}: ${lines(from)} line(s) replaced by ${lines(to)}.${feedback(w.abs, file, false)}`;
      },
    },
    {
      meta,
      spec: {
        name: 'replace_lines',
        description: 'Replace lines start..end of a file with new text (line numbers as shown by read_file). To insert, use end = start - 1. To delete, give empty text. Send only the changed lines.',
        params: {
          path: { type: 'string', description: 'repo-relative path' },
          start: { type: 'integer', description: 'first line to replace' },
          end: { type: 'integer', description: 'last line to replace (start - 1 inserts before start)' },
          new: { type: 'string', description: 'the new text for those lines (empty deletes them)' },
        },
      },
      run: (a) => {
        const rel = String(a.path ?? '');
        const w = writablePath(root, rel);
        if ('error' in w) return `Error: ${w.error}`;
        if (!fs.existsSync(w.abs)) return `Error: no such file: ${rel}. Use write_file to create it.`;
        const raw = fs.readFileSync(w.abs, 'utf8'), crlf = raw.includes('\r\n');
        const all = raw.replace(/\r\n/g, '\n').split('\n'), trailing = all[all.length - 1] === '' ? all.pop() !== undefined : false;
        const total = all.length, start = Number(a.start), end = Number(a.end);
        if (!Number.isInteger(start) || !Number.isInteger(end)) return 'Error: start and end must be line numbers.';
        if (start < 1 || start > total + 1) return `Error: start ${start} is outside the file (it has ${total} lines).`;
        if (end < start - 1 || end > total) return `Error: end ${end} must be between ${start - 1} and ${total}.`;
        const text = String(a.new ?? '').replace(/\r\n/g, '\n'), repl = text === '' ? [] : text.replace(/\n$/, '').split('\n');
        const out = [...all.slice(0, start - 1), ...repl, ...all.slice(end)];
        const body = out.join('\n') + (trailing || raw === '' ? '\n' : '');
        try { fs.writeFileSync(w.abs, crlf ? body.replace(/\n/g, '\r\n') : body); } catch (e) { return `Error: could not write ${rel}: ${(e as Error).message}`; }
        const file = path.relative(root, w.abs).split(path.sep).join('/');
        forget(file);
        const from = Math.max(1, start - 2), to = Math.min(out.length, start - 1 + repl.length + 2);
        const view = out.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n');
        return `Replaced lines ${start}-${end} of ${file} (${end - start + 1} line(s) became ${repl.length}). Now:\n${view}${feedback(w.abs, file, false)}`;
      },
    },
  ];
}

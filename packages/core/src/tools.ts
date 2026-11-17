import fs from 'node:fs';
import path from 'node:path';
import type { AgentTool } from '@bluecheese/agent';
import { diagnose } from './diagnostics.js';
import { checkSource, formatCheck, outlineSource } from './codecheck.js';
import { insideRoot, looksText, pathMatcher, walkFiles } from './fsutil.js';

/** Lines already in the model's context, per file. Reading them again would cost minutes of prefill for nothing. */
export type ShownMap = Map<string, [number, number][]>;

function addShown(shown: ShownMap, file: string, a: number, b: number) {
  const merged = [...(shown.get(file) ?? []), [a, b] as [number, number]].sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const r of merged) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]); else out.push([...r]);
  }
  shown.set(file, out);
}

/**
 * Lines start..end of a file, minus lines the model has already seen, cut on a line boundary at maxBytes,
 * with a hint on how to continue.
 */
function windowed(root: string, file: string, start: number, end: number, maxBytes: number, shown: ShownMap): string {
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
  end = Math.min(end, lines.length);
  if (start > lines.length) return `// ${file} has only ${lines.length} lines.`;
  const seen = shown.get(file) ?? [];
  const isSeen = (n: number) => seen.some(([a, b]) => n >= a && n <= b);

  let s = start;
  while (s <= end && isSeen(s)) s++;
  if (s > end) return `// ${file}:${start}-${end}: already shown earlier in this conversation; it is in your context. Do not read it again.`;
  let e = s;
  while (e < end && !isSeen(e + 1)) e++;

  const out: string[] = [];
  let used = 0, last = s - 1;
  for (let i = s; i <= e; i++) {
    const row = `${i}: ${lines[i - 1]}`;           // numbered, so the model can cite lines and ask for exact ranges
    const b = Buffer.byteLength(row) + 1;
    if (used + b > maxBytes && out.length) break;
    out.push(row); used += b; last = i;
  }
  addShown(shown, file, s, last);

  const notes: string[] = [];
  if (s > start) notes.push(`lines ${start}-${s - 1} were already shown`);
  if (e < end) notes.push(`lines ${e + 1}-${end} were already shown`);
  let text = `// ${file}:${s}-${last}${last < e ? ` of ${e}` : ''}${notes.length ? ` (${notes.join('; ')})` : ''}\n${out.join('\n')}`;
  if (last < e) text += `\n// … cut at line ${last}. Continue: read_file(path="${file}", start=${last + 1}, end=${e})`;
  return text;
}

/** Names of the built-in tools, in the order the model reads them. */
export const BUILTIN_TOOL_NAMES = ['diagnostics', 'list_files', 'find_files', 'grep', 'outline', 'check_file', 'read_file'] as const;

/**
 * Read-only tools that work on the files of the project folder, with no index. Outputs are small on purpose:
 * every byte returned costs prefill time.
 */
export function makeTools(root: string, opts: { maxBytes?: number; shown?: ShownMap } = {}): AgentTool[] {
  root = path.resolve(root);
  const maxBytes = opts.maxBytes ?? 1200;
  const shown: ShownMap = opts.shown ?? new Map();
  const meta = { source: 'builtin' as const, readOnly: true };

  return [
    {
      meta,
      spec: {
        name: 'diagnostics', description: 'Exact type errors from the TypeScript compiler. Use first for questions about errors or bugs.',
        params: { file: { type: 'string', description: 'limit to one file', required: false } },
      },
      run: (a) => {
        const r = diagnose(root, a.file ? { file: String(a.file) } : {});
        const lines = r.diags.map((d) => `${d.file}:${d.line}:${d.col} TS${d.code} ${d.message}`);
        const note = r.hiddenMissingModules ? `\n(${r.hiddenMissingModules} "cannot find module" errors hidden: dependencies are probably not installed)` : '';
        if (!r.total) return `No type errors found${r.usedTsconfig ? ' (using tsconfig.json)' : ''}. The compiler checks types only, not logic.${note}`;
        return `${r.total} type error(s)${r.total > lines.length ? `, showing ${lines.length}` : ''}:\n${lines.join('\n')}${note}`;
      },
    },
    {
      meta,
      spec: {
        name: 'list_files', description: 'List the files and folders of the project (or of one folder). Start here to see how it is laid out.',
        params: {
          path: { type: 'string', description: 'repo-relative folder, default the project root', required: false },
          depth: { type: 'integer', description: 'how many levels to show, default 2', required: false },
        },
      },
      run: (a) => {
        const rel = String(a.path ?? '').replace(/^\.?\/?/, '').replace(/\/+$/, '');
        const abs = insideRoot(root, rel);
        if (!abs) return 'Error: path is outside the project.';
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return `Error: no such folder: ${rel || '.'}`;
        const depth = Math.min(4, Math.max(1, Number(a.depth ?? 2)));
        const files = walkFiles(root, rel);
        // fold into a tree: show folders down to `depth`, with the number of files below the ones not shown
        const prefix = rel ? rel + '/' : '';
        const shownLines: string[] = [], seenDirs = new Set<string>();
        const counts = new Map<string, number>();
        for (const f of files) {
          const parts = f.slice(prefix.length).split('/');
          for (let i = 1; i <= Math.min(parts.length - 1, depth); i++) {
            const d = parts.slice(0, i).join('/') + '/';
            counts.set(d, (counts.get(d) ?? 0) + 1);
          }
        }
        for (const f of files) {
          const parts = f.slice(prefix.length).split('/');
          if (parts.length <= depth) { shownLines.push('  '.repeat(parts.length - 1) + parts.join('/').split('/').pop()! + (parts.length > 1 ? `  (${f})` : '')); }
          else {
            const d = parts.slice(0, depth).join('/') + '/';
            if (!seenDirs.has(d)) { seenDirs.add(d); shownLines.push('  '.repeat(depth - 1) + parts[depth - 1] + `/  (${prefix}${d}, ${counts.get(d)} files)`); }
          }
        }
        const total = files.length, cap = 70;
        const out = shownLines.slice(0, cap);
        return `${rel || '.'}: ${total} file(s)\n${out.join('\n')}${shownLines.length > cap ? `\n… ${shownLines.length - cap} more entries. Pass a deeper path.` : ''}`;
      },
    },
    {
      meta,
      spec: {
        name: 'find_files', description: 'Find files by name. A plain word matches any part of the path; * and ** work as wildcards.',
        params: { pattern: { type: 'string', description: 'e.g. controller, *.test.ts, src/**/index.ts' } },
      },
      run: (a) => {
        const match = pathMatcher(String(a.pattern));
        const hits = walkFiles(root).filter(match);
        if (!hits.length) return '(no files match)';
        return hits.slice(0, 30).join('\n') + (hits.length > 30 ? `\n… ${hits.length - 30} more. Use a more specific pattern.` : '');
      },
    },
    {
      meta,
      spec: {
        name: 'grep', description: 'Search the project\'s text files for a regex or text. Returns up to 12 matching lines.',
        params: {
          pattern: { type: 'string', description: 'regex or plain text' },
          path: { type: 'string', description: 'limit to a folder or file (repo-relative)', required: false },
        },
      },
      run: (a) => {
        let re: RegExp;
        try { re = new RegExp(String(a.pattern), 'i'); } catch { re = new RegExp(String(a.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
        const sub = String(a.path ?? '').replace(/^\.?\/?/, '').replace(/\/+$/, '');
        if (sub && !insideRoot(root, sub)) return 'Error: path is outside the project.';
        const out: string[] = [];
        for (const file of walkFiles(root, sub && fs.existsSync(path.join(root, sub)) && fs.statSync(path.join(root, sub)).isDirectory() ? sub : '')) {
          if (sub && !(file === sub || file.startsWith(sub + '/'))) continue;
          const abs = path.join(root, file);
          if (!looksText(abs)) continue;
          const lines = fs.readFileSync(abs, 'utf8').split('\n');
          for (let i = 0; i < lines.length && out.length < 12; i++) {
            if (re.test(lines[i])) out.push(`${file}:${i + 1}: ${lines[i].trim().slice(0, 140)}`);
          }
          if (out.length >= 12) break;
        }
        return out.join('\n') || '(no matches)';
      },
    },
    {
      meta,
      spec: {
        name: 'read_file', description: 'Read lines of a file (at most 80 lines).',
        params: {
          path: { type: 'string', description: 'repo-relative path' },
          start: { type: 'integer', description: 'first line, default 1', required: false },
          end: { type: 'integer', description: 'last line', required: false },
        },
      },
      run: (a) => {
        const abs = insideRoot(root, String(a.path));
        if (!abs) return 'Error: path is outside the project.';
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return `Error: no such file: ${a.path}`;
        if (!looksText(abs)) return `Error: ${a.path} is not a readable text file (binary or very large).`;
        const start = Math.max(1, Number(a.start ?? 1));
        const end = Math.min(Number(a.end ?? start + 79), start + 79);
        return windowed(root, path.relative(root, abs).split(path.sep).join('/'), start, end, maxBytes, shown);
      },
    },
    {
      meta,
      spec: {
        name: 'outline', description: 'The structure of a file: its functions, classes and sections with line numbers. Use it INSTEAD of reading a whole file, then read_file just the lines you need.',
        params: { path: { type: 'string', description: 'repo-relative path' } },
      },
      run: (a) => {
        const abs = insideRoot(root, String(a.path));
        if (!abs) return 'Error: path is outside the project.';
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return `Error: no such file: ${a.path}`;
        if (!looksText(abs)) return `Error: ${a.path} is not a readable text file (binary or very large).`;
        return `${a.path}: ${outlineSource(String(a.path), fs.readFileSync(abs, 'utf8'))}`;
      },
    },
    {
      meta,
      spec: {
        name: 'check_file', description: 'Check a file for syntax errors, with line numbers (JavaScript/TypeScript, Python, JSON, HTML with inline scripts, CSS). Use it first when asked to fix a file: it tells you which lines to look at.',
        params: { path: { type: 'string', description: 'repo-relative path' } },
      },
      run: (a) => {
        const abs = insideRoot(root, String(a.path));
        if (!abs) return 'Error: path is outside the project.';
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return `Error: no such file: ${a.path}`;
        if (!looksText(abs)) return `Error: ${a.path} is not a readable text file (binary or very large).`;
        const src = fs.readFileSync(abs, 'utf8'), res = checkSource(String(a.path), src);
        if (!res.checked) return res.note ?? `Syntax checking is not available for this kind of file (${res.language}). Use outline and read_file.`;
        return formatCheck(res, src) + (res.issues.length ? '' : ' The checker finds syntax errors only, not logic errors.');
      },
    },
  ];
}

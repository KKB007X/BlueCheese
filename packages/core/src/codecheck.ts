/**
 * Cheap, deterministic feedback about a file, so the model can aim a small edit at the right lines instead of reading
 * (and rewriting) the whole thing:
 *  - `checkSource`: syntax problems with line numbers. JS/TS/JSX/TSX and the inline <script> blocks of HTML use the TypeScript
 *    parser (already bundled; nothing is run). JSON uses JSON.parse. Python uses `ast.parse` in a short-lived `python3`
 *    (parses only, writes nothing; skipped if Python is not installed). HTML and CSS get a structure check (unclosed
 *    <script>/<style>, a file that ends before </html>, unbalanced braces): the typical look of a cut-off file.
 *  - `outlineSource`: the functions, classes and sections of a file with their line ranges.
 */
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

export interface CheckIssue { line: number; col?: number; message: string }
export interface CheckResult { checked: boolean; language: string; issues: CheckIssue[]; note?: string }

const ext = (f: string) => (/\.([A-Za-z0-9]+)$/.exec(f)?.[1] ?? '').toLowerCase();

function lineAt(src: string, pos: number): number { let n = 1; for (let i = 0; i < pos && i < src.length; i++) if (src.charCodeAt(i) === 10) n++; return n; }

/** Syntax problems of JS/TS source. `lineOffset` moves the line numbers when the code sits inside an HTML file. */
function checkScript(src: string, fileName: string, lineOffset = 0): CheckIssue[] {
  const out = ts.transpileModule(src, {
    fileName, reportDiagnostics: true,
    compilerOptions: { allowJs: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, noResolve: true, isolatedModules: true },
  });
  return (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error && d.file && d.start !== undefined && d.code < 5000)
    .slice(0, 5).map((d) => {
      const lc = ts.getLineAndCharacterOfPosition(d.file!, d.start!);
      return { line: lc.line + 1 + lineOffset, col: lc.character + 1, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') };
    });
}

/** `{` against `}` outside strings and comments. */
function braceIssue(src: string, what: string, lineOffset = 0): CheckIssue | undefined {
  let depth = 0, line = 1, open = 0;
  const s = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => ' '.repeat(m.length));
  for (const c of s) { if (c === '\n') line++; else if (c === '{') { depth++; if (depth === 1) open = line; } else if (c === '}') { depth--; if (depth < 0) return { line: line + lineOffset, message: `${what}: a } with no matching {` }; } }
  return depth > 0 ? { line: open + lineOffset, message: `${what}: the { opened here is never closed (the file may be cut off)` } : undefined;
}

function checkPython(src: string): CheckResult {
  const code = 'import ast,sys\ntry:\n    ast.parse(sys.stdin.read())\nexcept SyntaxError as e:\n    print(f"{e.lineno or 1}|{e.offset or 0}|{e.msg}")\n';
  for (const bin of ['python3', 'python']) {
    const r = spawnSync(bin, ['-c', code], { input: src, encoding: 'utf8', timeout: 6000 });
    if (r.error || r.status !== 0 && !r.stdout) continue;
    const m = /^(\d+)\|(\d+)\|(.*)$/m.exec(r.stdout ?? '');
    return { checked: true, language: 'Python', issues: m ? [{ line: Number(m[1]), col: Number(m[2]) || undefined, message: m[3] }] : [] };
  }
  return { checked: false, language: 'Python', issues: [], note: 'Python is not installed here, so the file was not checked.' };
}

export function checkSource(file: string, src: string): CheckResult {
  const e = ext(file);
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts'].includes(e)) return { checked: true, language: e.startsWith('t') ? 'TypeScript' : 'JavaScript', issues: checkScript(src, file) };
  if (e === 'py') return checkPython(src);
  if (e === 'json') {
    try { JSON.parse(src); return { checked: true, language: 'JSON', issues: [] }; }
    catch (x) {
      const msg = (x as Error).message, lc = /line (\d+)/.exec(msg), pos = /position (\d+)/.exec(msg);
      return { checked: true, language: 'JSON', issues: [{ line: lc ? Number(lc[1]) : pos ? lineAt(src, Number(pos[1])) : 1, message: msg.replace(/^JSON\.parse: /, '') }] };
    }
  }
  if (e === 'css') { const b = braceIssue(src, 'CSS'); return { checked: true, language: 'CSS', issues: b ? [b] : [] }; }
  if (e === 'html' || e === 'htm') {
    const issues: CheckIssue[] = [];
    const re = /<(script|style)\b([^>]*)>/gi; let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const tag = m[1].toLowerCase(), bodyStart = m.index + m[0].length, close = src.toLowerCase().indexOf(`</${tag}>`, bodyStart);
      if (close < 0) { issues.push({ line: lineAt(src, m.index), message: `<${tag}> is never closed: the file ends inside it (it looks cut off)` }); break; }
      const body = src.slice(bodyStart, close), off = lineAt(src, bodyStart) - 1;
      if (tag === 'script') {
        const attrs = m[2], type = /type\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase() ?? '';
        if (!/\bsrc\s*=/i.test(attrs) && ['', 'module', 'text/javascript', 'application/javascript'].includes(type) && body.trim()) issues.push(...checkScript(body, 'inline.js', off));
      } else { const b = braceIssue(body, 'CSS in <style>', off); if (b) issues.push(b); }
      re.lastIndex = close;
    }
    if (/<html\b/i.test(src) && !/<\/html>/i.test(src) && !issues.some((i) => /never closed/.test(i.message))) issues.push({ line: src.split('\n').length, message: 'the file ends before </html> (it looks cut off)' });
    return { checked: true, language: 'HTML', issues: issues.slice(0, 5) };
  }
  return { checked: false, language: e || 'unknown', issues: [] };
}

/** What the model is told after a file is written or changed. Empty when the file type is not checked. */
export function formatCheck(res: CheckResult, src: string): string {
  if (!res.checked) return res.note ?? '';
  if (!res.issues.length) return `Syntax check: OK (${res.language}).`;
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const body = res.issues.slice(0, 3).map((i) => `  line ${i.line}${i.col ? ':' + i.col : ''}: ${i.message}${lines[i.line - 1] !== undefined ? `\n    ${lines[i.line - 1].trim().slice(0, 100)}` : ''}`).join('\n');
  return `Syntax check found ${res.issues.length} problem(s) in ${res.language}:\n${body}\nFix only these lines: read_file a few lines around the reported line, then replace_lines. Do not rewrite or re-read the whole file.`;
}

/* --------------------------------- outline --------------------------------- */

interface Entry { start: number; end: number; text: string }

function scriptOutline(src: string, fileName: string, off = 0): Entry[] {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.ESNext, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : undefined);
  const line = (p: number) => sf.getLineAndCharacterOfPosition(p).line + 1 + off;
  const head = (n: ts.Node) => n.getText(sf).split('\n')[0].trim().slice(0, 80);
  const out: Entry[] = [];
  const add = (n: ts.Node, text = head(n)) => out.push({ start: line(n.getStart(sf)), end: line(n.getEnd()), text });
  for (const st of sf.statements) {
    if (ts.isClassDeclaration(st)) {
      add(st);
      for (const mem of st.members) if ((ts.isMethodDeclaration(mem) || ts.isConstructorDeclaration(mem)) && mem.body) out.push({ start: line(mem.getStart(sf)), end: line(mem.getEnd()), text: '  ' + head(mem) });
    } else if (ts.isFunctionDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) add(st);
    else if (ts.isVariableStatement(st)) add(st);
  }
  return out;
}

function pythonOutline(src: string): Entry[] {
  const lines = src.split('\n'), found: { i: number; indent: number; text: string }[] = [];
  lines.forEach((l, i) => { const m = /^(\s*)(def|class|async def)\s+\w+/.exec(l); if (m) found.push({ i, indent: m[1].length, text: l.trim().replace(/:\s*$/, '').slice(0, 80) }); });
  return found.map((f, k) => {
    let end = lines.length; for (let j = k + 1; j < found.length; j++) if (found[j].indent <= f.indent) { end = found[j].i; break; }
    while (end > f.i + 1 && !lines[end - 1].trim()) end--;
    return { start: f.i + 1, end, text: '  '.repeat(Math.min(2, f.indent / 4)) + f.text };
  });
}

export function outlineSource(file: string, src: string): string {
  const e = ext(file), total = src.split('\n').length - (src.endsWith('\n') ? 1 : 0);
  let entries: Entry[] = [];
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts'].includes(e)) entries = scriptOutline(src, file);
  else if (e === 'py') entries = pythonOutline(src);
  else if (e === 'md') src.split('\n').forEach((l, i) => { if (/^#{1,4}\s/.test(l)) entries.push({ start: i + 1, end: i + 1, text: l.trim().slice(0, 80) }); });
  else if (e === 'html' || e === 'htm') {
    const re = /<(script|style|body|head)\b[^>]*>/gi; let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const tag = m[1].toLowerCase(), s = lineAt(src, m.index), close = src.toLowerCase().indexOf(`</${tag}>`, m.index);
      const eLine = close < 0 ? total : lineAt(src, close);
      entries.push({ start: s, end: eLine, text: m[0].slice(0, 60) });
      if (tag === 'script' && close >= 0 && !/\bsrc\s*=/i.test(m[0])) {
        const bodyStart = m.index + m[0].length;
        try { entries.push(...scriptOutline(src.slice(bodyStart, close), 'inline.js', lineAt(src, bodyStart) - 1).map((x) => ({ ...x, text: '  ' + x.text }))); } catch { /* not parseable: the check says so */ }
      }
      if (tag === 'script' || tag === 'style') re.lastIndex = close < 0 ? src.length : close;
    }
  }
  const shown = entries.slice(0, 40).map((x) => `${String(x.start).padStart(4)}-${x.end}  ${x.text}`);
  return `${total} lines.` + (shown.length ? `\n${shown.join('\n')}${entries.length > 40 ? `\n… ${entries.length - 40} more` : ''}` : '');
}

import ts from 'typescript';
import path from 'node:path';
import { walkFiles } from './fsutil.js';

export interface Diag { file: string; line: number; col: number; code: number; message: string; category: 'error' | 'warning' }
export interface DiagResult { diags: Diag[]; total: number; hiddenMissingModules: number; usedTsconfig: boolean }

// "Cannot find module / type definition": usually just means dependencies are not installed
const MISSING_DEPS = new Set([2307, 2688, 2792, 7016]);

/** Type errors from the TypeScript compiler, using the project's tsconfig.json when there is one. */
export function diagnose(rootInput: string, opts: { file?: string; max?: number } = {}): DiagResult {
  const root = path.resolve(rootInput);
  const cfgPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
  let options: ts.CompilerOptions; let fileNames: string[]; let usedTsconfig = false;
  if (cfgPath && path.dirname(cfgPath).startsWith(root)) {
    const read = ts.readConfigFile(cfgPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(cfgPath));
    options = { ...parsed.options, noEmit: true }; fileNames = parsed.fileNames; usedTsconfig = true;
  } else {
    options = { noEmit: true, allowJs: false, skipLibCheck: true, target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve, strict: true };
    fileNames = walkFiles(root).filter((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !f.endsWith('.d.ts')).map((f) => path.join(root, f));
  }
  const program = ts.createProgram(fileNames, options);
  const want = opts.file ? path.resolve(root, opts.file) : undefined;
  const out: Diag[] = []; let total = 0, hidden = 0;
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (!d.file || d.file.fileName.includes('node_modules')) continue;
    const abs = path.resolve(d.file.fileName);
    if (!abs.startsWith(root + path.sep) || (want && abs !== want)) continue;
    if (MISSING_DEPS.has(d.code)) { hidden++; continue; }
    total++;
    if (out.length < (opts.max ?? 15)) {
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
      out.push({
        file: path.relative(root, abs).split(path.sep).join('/'), line: line + 1, col: character + 1, code: d.code,
        message: ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 220),
        category: d.category === ts.DiagnosticCategory.Error ? 'error' : 'warning',
      });
    }
  }
  return { diags: out, total, hiddenMissingModules: hidden, usedTsconfig };
}

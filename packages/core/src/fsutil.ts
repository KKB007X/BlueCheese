import fs from 'node:fs';
import path from 'node:path';

/** Folders the file tools never look into. */
export const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.bluecheese', 'coverage', '.next', '.nuxt', '.turbo', '.cache',
  '.venv', 'venv', '__pycache__', 'target', '.gradle', '.idea',
]);

const MAX_FILES = 6000;
const MAX_FILE_BYTES = 1_000_000;

/** Is this folder one the tools should skip? Dot-folders are skipped too, except a few that matter to people. */
export function skipDir(name: string): boolean {
  return IGNORE_DIRS.has(name) || (name.startsWith('.') && !['.github', '.vscode'].includes(name));
}

/** A readable text file: not huge, no NUL byte near the start. */
export function looksText(abs: string, size?: number): boolean {
  try {
    const st = size === undefined ? fs.statSync(abs) : { size };
    if (st.size > MAX_FILE_BYTES) return false;
    const fd = fs.openSync(abs, 'r');
    try {
      const buf = Buffer.alloc(Math.min(4096, st.size));
      fs.readSync(fd, buf, 0, buf.length, 0);
      return !buf.includes(0);
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

/** Project files as repo-relative paths with forward slashes, sorted. Stops at a sane limit. */
export function walkFiles(root: string, under = ''): string[] {
  const out: string[] = [];
  const base = path.join(root, under);
  const walk = (dir: string) => {
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of ents) {
      if (out.length >= MAX_FILES) return;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (!skipDir(ent.name)) walk(abs); }
      else if (ent.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(base);
  return out;
}

/** Resolve a repo-relative path and make sure it really is inside the project (symlinks included). */
export function insideRoot(root: string, rel: string): string | undefined {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return undefined;
  try {
    const real = fs.realpathSync(abs), realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return undefined;
  } catch { /* does not exist: the caller reports that */ }
  return abs;
}

/** A simple glob (`*`, `**`, `?`) or, without wildcards, a case-insensitive substring of the path. */
export function pathMatcher(pattern: string): (p: string) => boolean {
  const pat = pattern.trim();
  if (!/[*?]/.test(pat)) { const low = pat.toLowerCase(); return (p) => p.toLowerCase().includes(low); }
  const re = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?');
  const full = new RegExp(`(?:^|/)${re}$`, 'i');
  return (p) => full.test(p);
}

/** Folders nothing may be written into, wherever they appear in the path. */
const NO_WRITE = new Set(['.git', '.bluecheese', 'node_modules']);

/**
 * Like `insideRoot`, for a file that may not exist yet: the nearest folder that does exist must really be inside the project
 * (so a symlinked folder cannot be used to write elsewhere). Returns an error message instead of a path when refused.
 */
export function writablePath(root: string, rel: string): { abs: string } | { error: string } {
  const clean = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean || clean.endsWith('/')) return { error: 'give a file path, not a folder.' };
  const abs = path.resolve(root, clean);
  if (!abs.startsWith(root + path.sep)) return { error: 'the path is outside the project.' };
  const bad = path.relative(root, abs).split(path.sep).find((p) => NO_WRITE.has(p));
  if (bad) return { error: `refusing to write inside ${bad}/.` };
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  const real = fs.realpathSync(dir), realRoot = fs.realpathSync(root);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { error: 'the path leads outside the project (a symlink).' };
  if (fs.existsSync(abs) && !fs.statSync(abs).isFile()) return { error: 'that path is a folder.' };
  return { abs };
}

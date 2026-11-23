import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';

export type ProjectKind = 'angular' | 'nextjs' | 'node' | 'unknown';

export interface ProjectInfo {
  kind: ProjectKind;
  label: string;
  scripts: Record<string, string>;
  docs: string[];
}

export function detectProject(root: string): ProjectInfo {
  const pkgFile = path.join(root, 'package.json');
  let scripts: Record<string, string> = {};
  let deps: Record<string, string> = {};
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
      scripts = pkg.scripts ?? {};
      deps = { ...pkg.dependencies, ...pkg.devDependencies };
    } catch {
      /* package.json rusak: perlakukan sebagai project tanpa script */
    }
  }
  const docs = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', 'CONTRIBUTING.md'].filter((f) => existsSync(path.join(root, f)));
  const version = (name: string) => (deps[name] ? ` ${deps[name].replace(/^[^\d]*/, '').split('.')[0]}` : '');

  if (existsSync(path.join(root, 'angular.json')) || deps['@angular/core']) {
    return { kind: 'angular', label: `Angular${version('@angular/core')}`, scripts, docs };
  }
  if (deps.next || ['next.config.js', 'next.config.mjs', 'next.config.ts'].some((f) => existsSync(path.join(root, f)))) {
    return { kind: 'nextjs', label: `Next.js${version('next')}`, scripts, docs };
  }
  if (existsSync(pkgFile)) return { kind: 'node', label: 'Node.js', scripts, docs };
  return { kind: 'unknown', label: 'tidak dikenali', scripts, docs };
}

/** Script npm yang dibutuhkan sebuah perintah `run`, atau null bila bukan perintah npm. */
export function npmScriptOf(run: string): string | null {
  const m = run.trim().match(/^npm\s+(?:run(?:-script)?\s+([\w:.-]+)|(test|start))\b/);
  return m ? (m[1] ?? m[2]) : null;
}

export async function gitDir(root: string): Promise<string | null> {
  const res = await execa('git', ['rev-parse', '--git-dir'], { cwd: root, reject: false });
  return res.exitCode === 0 ? path.resolve(root, res.stdout.trim()) : null;
}

export async function isIgnored(root: string, rel: string): Promise<boolean> {
  const res = await execa('git', ['check-ignore', '-q', rel], { cwd: root, reject: false });
  return res.exitCode === 0;
}

/**
 * Tambahkan pola ke `.git/info/exclude` (hanya lokal) atau `.gitignore` (dibagikan),
 * hanya bila belum diabaikan git.
 */
export async function ignorePaths(root: string, patterns: string[], where: 'exclude' | 'gitignore'): Promise<string[]> {
  const added: string[] = [];
  const target =
    where === 'gitignore'
      ? path.join(root, '.gitignore')
      : await gitDir(root).then((d) => (d ? path.join(d, 'info', 'exclude') : null));
  if (!target) return added;
  for (const pattern of patterns) {
    const probe = pattern.replace(/\/$/, '/x');
    if (await isIgnored(root, probe)) continue;
    added.push(pattern);
  }
  if (added.length) {
    mkdirSync(path.dirname(target), { recursive: true });
    const existing = existsSync(target) ? readFileSync(target, 'utf8') : '';
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    appendFileSync(target, `${sep}# checkpost\n${added.join('\n')}\n`);
  }
  return added;
}

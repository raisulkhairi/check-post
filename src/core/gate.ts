import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { allStages } from './discovery.js';
import { isBlockingFailure } from './scheduler.js';
import type { Pipeline, StageResult } from './types.js';

export const STATE_DIR = '.checkpost';
const LAST_RUN = 'last-run.json';

export interface GitState {
  isRepo: boolean;
  sha: string | null;
  branch: string | null;
  dirtyFiles: string[];
}

export interface LastRun {
  version: 1;
  sha: string | null;
  branch: string | null;
  definitionsHash: string;
  dirtyAtRun: string[];
  updatedAt: string;
  results: Record<string, StageResult>;
}

export interface GateResult {
  green: boolean;
  reasons: string[];
  lastRun: LastRun | null;
  git: GitState;
}

/** Path milik checkpost sendiri tidak dihitung sebagai perubahan project. */
const isOwnPath = (file: string) =>
  file.startsWith(`${STATE_DIR}/`) || file.startsWith('checkpost/') || file === '.claude/commands/checkpost.md';

export async function readGitState(cwd: string): Promise<GitState> {
  try {
    const { stdout: top } = await execa('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
    if (top.trim() !== 'true') throw new Error('not a repo');
  } catch {
    return { isRepo: false, sha: null, branch: null, dirtyFiles: [] };
  }
  const sha = await execa('git', ['rev-parse', 'HEAD'], { cwd, reject: false });
  // symbolic-ref juga bekerja di repo yang belum punya commit (rev-parse HEAD gagal di sana).
  const branch = await execa('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd, reject: false });
  const status = await execa('git', ['status', '--porcelain', '--untracked-files=all'], { cwd });
  const dirtyFiles = status.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()!)
    .filter((f) => !isOwnPath(f));
  return {
    isRepo: true,
    sha: sha.exitCode === 0 ? sha.stdout.trim() : null,
    branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
    dirtyFiles,
  };
}

/** Hash dari seluruh definisi stage, supaya edit file .md membatalkan hasil lama. */
export function definitionsHash(pipeline: Pipeline): string {
  const h = createHash('sha256');
  h.update(JSON.stringify(pipeline.config));
  for (const s of allStages(pipeline.children)) {
    h.update(s.id);
    h.update(JSON.stringify(s.config));
    h.update(s.body);
    h.update(s.context.join('\n'));
  }
  return h.digest('hex').slice(0, 16);
}

const lastRunPath = (root: string) => path.join(root, STATE_DIR, LAST_RUN);

export function readLastRun(root: string): LastRun | null {
  const file = lastRunPath(root);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as LastRun;
  } catch {
    return null;
  }
}

/**
 * Simpan hasil run. Run parsial (satu stage/grup) digabung dengan hasil sebelumnya
 * selama commit dan definisi stage masih sama.
 */
export function saveRun(pipeline: Pipeline, git: GitState, results: Record<string, StageResult>, partial: boolean): LastRun {
  const hash = definitionsHash(pipeline);
  const previous = readLastRun(pipeline.root);
  const canMerge = partial && previous && previous.sha === git.sha && previous.definitionsHash === hash;
  const record: LastRun = {
    version: 1,
    sha: git.sha,
    branch: git.branch,
    definitionsHash: hash,
    dirtyAtRun: git.dirtyFiles,
    updatedAt: new Date().toISOString(),
    results: canMerge ? { ...previous.results, ...results } : results,
  };
  mkdirSync(path.join(pipeline.root, STATE_DIR), { recursive: true });
  writeFileSync(lastRunPath(pipeline.root), JSON.stringify(record, null, 2));
  return record;
}

export async function evaluateGate(pipeline: Pipeline): Promise<GateResult> {
  const git = await readGitState(pipeline.root);
  const lastRun = readLastRun(pipeline.root);
  const reasons: string[] = [];

  if (!lastRun) {
    reasons.push('pipeline belum pernah dijalankan');
    return { green: false, reasons, lastRun, git };
  }
  if (git.isRepo && lastRun.sha !== git.sha) {
    reasons.push(`hasil terakhir untuk commit ${lastRun.sha?.slice(0, 7) ?? '?'}, HEAD sekarang ${git.sha?.slice(0, 7) ?? '?'}`);
  }
  if (lastRun.definitionsHash !== definitionsHash(pipeline)) {
    reasons.push('definisi stage berubah sejak run terakhir');
  }
  if (pipeline.config.require_clean_tree && git.isRepo) {
    if (git.dirtyFiles.length) reasons.push(`working tree kotor (${git.dirtyFiles.length} file belum di-commit)`);
    else if (lastRun.dirtyAtRun.length) reasons.push('run terakhir dilakukan saat working tree kotor');
  }
  for (const stage of allStages(pipeline.children)) {
    const r = lastRun.results[stage.id];
    if (!r) reasons.push(`stage ${stage.id} belum dijalankan`);
    else if (isBlockingFailure(r)) reasons.push(`stage ${stage.id} ${r.status === 'error' ? 'error' : 'gagal'}`);
    else if (r.status === 'skipped' || r.status === 'pending' || r.status === 'running')
      reasons.push(`stage ${stage.id} tidak selesai (${r.status})`);
  }
  return { green: reasons.length === 0, reasons, lastRun, git };
}

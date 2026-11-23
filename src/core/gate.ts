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

/** checkpost's own paths do not count as project changes. */
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
  // symbolic-ref also works in a repo with no commits (rev-parse HEAD fails there).
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

/** Hash of every stage definition, so editing a .md file invalidates old results. */
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
 * Save run results. A partial run (one stage/group) is merged into the previous results
 * as long as the commit and stage definitions are unchanged.
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
    reasons.push('pipeline has never been run');
    return { green: false, reasons, lastRun, git };
  }
  if (git.isRepo && lastRun.sha !== git.sha) {
    reasons.push(`last results are for commit ${lastRun.sha?.slice(0, 7) ?? '?'}, HEAD is now ${git.sha?.slice(0, 7) ?? '?'}`);
  }
  if (lastRun.definitionsHash !== definitionsHash(pipeline)) {
    reasons.push('stage definitions changed since the last run');
  }
  if (pipeline.config.require_clean_tree && git.isRepo) {
    if (git.dirtyFiles.length) reasons.push(`working tree is dirty (${git.dirtyFiles.length} uncommitted file${git.dirtyFiles.length === 1 ? '' : 's'})`);
    else if (lastRun.dirtyAtRun.length) reasons.push('the last run happened on a dirty working tree');
  }
  for (const stage of allStages(pipeline.children)) {
    const r = lastRun.results[stage.id];
    if (!r) reasons.push(`stage ${stage.id} has not run`);
    else if (isBlockingFailure(r)) reasons.push(`stage ${stage.id} ${r.status === 'error' ? 'errored' : 'failed'}`);
    else if (r.status === 'skipped' || r.status === 'pending' || r.status === 'running')
      reasons.push(`stage ${stage.id} did not finish (${r.status})`);
  }
  return { green: reasons.length === 0, reasons, lastRun, git };
}

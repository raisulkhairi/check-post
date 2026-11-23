import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { render } from 'ink';
import { confirm } from '@inquirer/prompts';
import pc from 'picocolors';
import { getAdapter, type Adapter } from '../core/adapters/index.js';
import { allStages, discoverPipeline, findNode } from '../core/discovery.js';
import type { PipelineEvent } from '../core/events.js';
import { evaluateGate, readGitState, saveRun, STATE_DIR, type GateResult } from '../core/gate.js';
import { ignorePaths } from '../core/project.js';
import { runPipeline } from '../core/scheduler.js';
import type { PipelineNode, StageNode } from '../core/types.js';
import { App } from '../ui/tui/App.js';
import { createPlainRenderer } from '../ui/plain.js';
import { printDefinitionError } from './shared.js';

export interface RunFlags {
  cwd: string;
  ci?: boolean;
  json?: boolean;
  yes?: boolean;
  verbose?: boolean;
}

function readUiState(root: string): { aiConfirmed?: boolean } {
  try {
    return JSON.parse(readFileSync(path.join(root, STATE_DIR, 'state.json'), 'utf8'));
  } catch {
    return {};
  }
}

function writeUiState(root: string, state: { aiConfirmed?: boolean }) {
  mkdirSync(path.join(root, STATE_DIR), { recursive: true });
  writeFileSync(path.join(root, STATE_DIR, 'state.json'), JSON.stringify(state, null, 2));
}

const stagesOf = (nodes: PipelineNode[]): StageNode[] => allStages(nodes);

export async function runCommand(target: string | undefined, flags: RunFlags): Promise<number> {
  const root = path.resolve(flags.cwd);
  let pipeline;
  try {
    pipeline = discoverPipeline(root);
  } catch (err) {
    return printDefinitionError(err);
  }

  let nodes: PipelineNode[] | undefined;
  if (target) {
    const node = findNode(pipeline.children, target);
    if (!node) {
      console.error(pc.red(`Stage or group "${target}" not found. See "checkpost list".`));
      return 2;
    }
    nodes = [node];
  }
  const selected = stagesOf(nodes ?? pipeline.children);
  const aiStages = selected.filter((s) => s.type !== 'command');
  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY && !flags.ci && !flags.json);

  let adapter: Adapter | undefined;
  if (aiStages.length) {
    try {
      adapter = getAdapter(pipeline.config.agent);
    } catch (err) {
      console.error(pc.red((err as Error).message));
      return 2;
    }
    const detected = await adapter.detect();
    if (!detected.installed) {
      console.error(pc.red(`${adapter.label} not found. Install it first: npm install -g @anthropic-ai/claude-code`));
      return 2;
    }
    const ui = readUiState(root);
    if (interactive && !flags.yes && pipeline.config.confirm_ai && !ui.aiConfirmed) {
      const ok = await confirm({
        message: `${aiStages.length} AI stage${aiStages.length === 1 ? '' : 's'} will use your ${adapter.label} quota (model: ${pipeline.config.model}, limit $${pipeline.config.max_budget_usd}/stage). Continue?`,
        default: true,
      });
      if (!ok) return 1;
      writeUiState(root, { ...ui, aiConfirmed: true });
    }
  }

  // Run state must not dirty the project's working tree.
  await ignorePaths(root, [`${STATE_DIR}/`], 'exclude');

  const git = await readGitState(root);
  const header = [
    adapter ? pipeline.config.agent : null,
    git.sha ? `${git.branch}@${git.sha.slice(0, 7)}` : null,
    path.basename(root),
  ]
    .filter(Boolean)
    .join(' · ');

  const execute = async (runNodes: PipelineNode[] | undefined, onEvent: (e: PipelineEvent) => void, signal: AbortSignal): Promise<GateResult> => {
    const gitBefore = await readGitState(root);
    const outcome = await runPipeline(pipeline, { nodes: runNodes, adapter, onEvent, signal });
    if (!signal.aborted) saveRun(pipeline, gitBefore, outcome.results, Boolean(runNodes));
    return evaluateGate(pipeline);
  };

  if (interactive) {
    let lastGate: GateResult | null = null;
    const wrapped = async (n: PipelineNode[] | undefined, onEvent: (e: PipelineEvent) => void, signal: AbortSignal) => {
      lastGate = await execute(n, onEvent, signal);
      return lastGate;
    };
    const app = render(<App pipeline={pipeline} header={header} execute={wrapped} initialNodes={nodes} />, { exitOnCtrlC: false });
    await app.waitUntilExit();
    const gate = lastGate as GateResult | null;
    return gate?.green ? 0 : 1;
  }

  // CI / non-TTY mode
  const write = flags.json ? (s: string) => process.stderr.write(s + '\n') : undefined;
  const stageMap = new Map(allStages(pipeline.children).map((s) => [s.id, s]));
  const renderer = createPlainRenderer(stageMap, { verbose: Boolean(flags.verbose), write });
  const out = write ?? ((s: string) => console.log(s));
  out(pc.bold(`Checkpost · ${header}`));
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.once('SIGINT', onSigint);
  const gate = await execute(nodes, renderer, ac.signal);
  process.off('SIGINT', onSigint);

  if (flags.json) {
    const results = gate.lastRun?.results ?? {};
    process.stdout.write(
      JSON.stringify(
        {
          gate: gate.green ? 'green' : 'red',
          reasons: gate.reasons,
          commit: gate.git.sha,
          branch: gate.git.branch,
          stages: allStages(pipeline.children).map((s) => {
            const r = results[s.id];
            return {
              id: s.id,
              status: r?.status ?? 'not-run',
              allowFailure: s.config.allow_failure,
              durationMs: r?.durationMs,
              costUsd: r?.costUsd,
              summary: r?.summary,
              error: r?.error,
              findings: r?.findings ?? [],
            };
          }),
        },
        null,
        2,
      ) + '\n',
    );
  } else {
    out('');
    if (gate.green) out(pc.green(pc.bold('✔ GATE GREEN · ok to deploy')));
    else {
      out(pc.red(pc.bold('✖ GATE RED · not ready to deploy')));
      for (const r of gate.reasons) out(pc.gray(`  • ${r}`));
    }
    const cost = Object.values(gate.lastRun?.results ?? {}).reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
    if (cost) out(pc.gray(`  AI cost: $${cost.toFixed(3)}`));
  }
  return gate.green ? 0 : 1;
}


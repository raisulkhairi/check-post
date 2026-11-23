import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { AgentError, type Adapter } from './adapters/types.js';
import type { EventSink } from './events.js';
import { runAiStage, isBlocking } from './runners/ai.js';
import { runCommand } from './runners/command.js';
import { parseDuration } from './stage-file.js';
import type { GroupNode, Pipeline, PipelineNode, StageNode, StageResult, StageStatus } from './types.js';

// Same as STATE_DIR in gate.ts (not imported, to avoid a circular import).
const STATE_DIR_NAME = '.checkpost';
const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_AI_TIMEOUT_MS = 10 * 60_000;

export interface RunOptions {
  /** Run only these nodes (stages or groups). Default: the whole pipeline. */
  nodes?: PipelineNode[];
  adapter?: Adapter;
  onEvent: EventSink;
  signal?: AbortSignal;
  runId?: string;
  stateDir?: string;
}

export interface RunOutcome {
  results: Record<string, StageResult>;
  passed: boolean;
  durationMs: number;
}

/** A stage/group blocks the pipeline when it failed and is not allow_failure. */
export const isBlockingFailure = (r: Pick<StageResult, 'status' | 'allowFailure'>) =>
  (r.status === 'failed' || r.status === 'error') && !r.allowFailure;

function stagesIn(node: PipelineNode): StageNode[] {
  return node.kind === 'stage' ? [node] : node.children.flatMap(stagesIn);
}

export async function runPipeline(pipeline: Pipeline, opts: RunOptions): Promise<RunOutcome> {
  const started = Date.now();
  const runId = opts.runId ?? new Date(started).toISOString().replace(/[:.]/g, '-');
  const logDir = path.join(opts.stateDir ?? path.join(pipeline.root, STATE_DIR_NAME), 'logs', runId);
  mkdirSync(logDir, { recursive: true });
  const results: Record<string, StageResult> = {};

  const skip = (nodes: PipelineNode[], reason: string) => {
    for (const stage of nodes.flatMap(stagesIn)) {
      const result: StageResult = {
        id: stage.id,
        status: 'skipped',
        durationMs: 0,
        findings: [],
        summary: reason,
        allowFailure: stage.config.allow_failure,
      };
      results[stage.id] = result;
      opts.onEvent({ type: 'stage:finish', id: stage.id, result });
    }
  };

  const runStage = async (stage: StageNode): Promise<StageResult> => {
    const t0 = Date.now();
    opts.onEvent({ type: 'stage:start', id: stage.id, at: t0 });
    const logFile = path.join(logDir, stage.id.replace(/\//g, '__') + '.log');
    const log: WriteStream = createWriteStream(logFile);
    const emit = (line: string) => {
      log.write(line + '\n');
      opts.onEvent({ type: 'stage:log', id: stage.id, line });
    };
    const finish = (partial: Omit<StageResult, 'id' | 'durationMs' | 'allowFailure' | 'findings'> & Partial<StageResult>) => {
      const result: StageResult = {
        id: stage.id,
        durationMs: Date.now() - t0,
        allowFailure: stage.config.allow_failure,
        findings: [],
        logFile,
        ...partial,
      };
      log.end();
      results[stage.id] = result;
      opts.onEvent({ type: 'stage:finish', id: stage.id, result });
      return result;
    };

    try {
      let command: { run: string; exitCode: number | null; output: string } | undefined;
      if (stage.type === 'command' || stage.type === 'command+ai') {
        const run = stage.config.run!;
        emit(`$ ${run}`);
        const res = await runCommand(run, {
          cwd: pipeline.root,
          timeoutMs: parseDuration(stage.config.timeout, DEFAULT_COMMAND_TIMEOUT_MS),
          signal: opts.signal,
          onLine: emit,
        });
        if (res.canceled) return finish({ status: 'skipped', summary: 'cancelled', exitCode: res.exitCode });
        if (res.timedOut) return finish({ status: 'error', error: 'timeout', exitCode: res.exitCode });
        if (stage.type === 'command') {
          return finish({
            status: res.exitCode === 0 ? 'passed' : 'failed',
            exitCode: res.exitCode,
            summary: res.exitCode === 0 ? undefined : `exit code ${res.exitCode}`,
          });
        }
        command = { run, exitCode: res.exitCode, output: res.output };
        emit(`[AI] reviewing the command result (exit code ${res.exitCode})…`);
      }

      if (!opts.adapter) throw new Error('AI stage needs an agent, but none is available');
      const outcome = await runAiStage(opts.adapter, stage, {
        cwd: pipeline.root,
        model: pipeline.config.model,
        language: pipeline.config.language,
        sensitivePaths: stage.sensitivePaths,
        maxBudgetUsd: pipeline.config.max_budget_usd,
        timeoutMs: parseDuration(stage.config.timeout, DEFAULT_AI_TIMEOUT_MS),
        signal: opts.signal,
        onLog: emit,
        command,
      });
      for (const denied of outcome.deniedReads) emit(`[AI] access blocked: ${denied}`);
      const { verdict } = outcome;
      const blocking = verdict.findings.filter((f) => isBlocking(f, stage.config.fail_on));
      emit(`[AI] ${verdict.summary}`);

      // Reasons that fail the stage beyond its findings.
      const reasons: string[] = [];
      let failed = blocking.length > 0;
      if (!verdict.complete) {
        const onIncomplete = stage.config.on_incomplete ?? pipeline.config.on_incomplete;
        const skipped = verdict.not_checked.length ? `: ${verdict.not_checked.join('; ')}` : '';
        reasons.push(`audit incomplete${onIncomplete === 'warn' ? ' (on_incomplete: warn)' : ''}${skipped}`);
        emit(`[AI] audit incomplete${skipped}`);
        if (onIncomplete === 'fail') failed = true;
      }
      if (command && stage.config.require_exit_zero && command.exitCode !== 0) {
        reasons.push(`command exited with code ${command.exitCode} (require_exit_zero)`);
        failed = true;
      }
      return finish({
        status: failed ? 'failed' : 'passed',
        exitCode: command?.exitCode,
        summary: verdict.summary,
        findings: verdict.findings,
        costUsd: outcome.costUsd,
        reasons: reasons.length ? reasons : undefined,
      });
    } catch (err) {
      const costUsd = err instanceof AgentError ? err.costUsd : undefined;
      if (opts.signal?.aborted) return finish({ status: 'skipped', summary: 'cancelled', costUsd });
      const message = (err as Error).message;
      emit(`ERROR: ${message}`);
      return finish({ status: 'error', error: message, costUsd });
    }
  };

  /** Returns true when the node ended in a blocking failure. */
  const runNode = async (node: PipelineNode, failFast: boolean): Promise<boolean> => {
    if (node.kind === 'stage') return isBlockingFailure(await runStage(node));
    return runGroup(node, node.config.fail_fast ?? failFast);
  };

  const runGroup = async (group: GroupNode, failFast: boolean): Promise<boolean> => {
    const t0 = Date.now();
    opts.onEvent({ type: 'group:start', id: group.id });
    const failed = group.config.parallel
      ? await runParallel(group.children, failFast, group.config.max_parallel ?? pipeline.config.max_parallel)
      : await runSequence(group.children, failFast);
    const status: StageStatus = failed
      ? 'failed'
      : stagesIn(group).every((s) => results[s.id]?.status === 'skipped')
        ? 'skipped'
        : 'passed';
    opts.onEvent({ type: 'group:finish', id: group.id, status, durationMs: Date.now() - t0 });
    return failed;
  };

  /** Run nodes concurrently, at most `limit` at a time, in file order. */
  const runParallel = async (nodes: PipelineNode[], failFast: boolean, limit: number): Promise<boolean> => {
    let next = 0;
    let failed = false;
    const worker = async () => {
      while (next < nodes.length) {
        const i = next++;
        if (opts.signal?.aborted) {
          skip([nodes[i]], 'cancelled');
          continue;
        }
        if (await runNode(nodes[i], failFast)) failed = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, nodes.length) }, worker));
    return failed;
  };

  const runSequence = async (nodes: PipelineNode[], failFast: boolean): Promise<boolean> => {
    let failed = false;
    for (let i = 0; i < nodes.length; i++) {
      if (opts.signal?.aborted) {
        skip(nodes.slice(i), 'cancelled');
        break;
      }
      if (await runNode(nodes[i], failFast)) {
        failed = true;
        if (failFast) {
          skip(nodes.slice(i + 1), 'skipped: an earlier stage failed');
          break;
        }
      }
    }
    return failed;
  };

  const failed = await runSequence(opts.nodes ?? pipeline.children, pipeline.config.fail_fast);
  const durationMs = Date.now() - started;
  const passed = !failed && !opts.signal?.aborted;
  opts.onEvent({ type: 'pipeline:finish', results, passed, durationMs });
  return { results, passed, durationMs };
}

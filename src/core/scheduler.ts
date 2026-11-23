import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import type { Adapter } from './adapters/types.js';
import type { EventSink } from './events.js';
import { runAiStage, isBlocking } from './runners/ai.js';
import { runCommand } from './runners/command.js';
import { parseDuration } from './stage-file.js';
import type { GroupNode, Pipeline, PipelineNode, StageNode, StageResult, StageStatus } from './types.js';

// Sama dengan STATE_DIR di gate.ts (tidak diimpor untuk menghindari import melingkar).
const STATE_DIR_NAME = '.checkpost';
const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_AI_TIMEOUT_MS = 10 * 60_000;

export interface RunOptions {
  /** Jalankan hanya node ini (stage atau grup). Default: seluruh pipeline. */
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

/** Stage/grup dianggap menghalangi pipeline bila gagal dan tidak allow_failure. */
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
        if (res.canceled) return finish({ status: 'skipped', summary: 'dibatalkan', exitCode: res.exitCode });
        if (res.timedOut) return finish({ status: 'error', error: 'timeout', exitCode: res.exitCode });
        if (stage.type === 'command') {
          return finish({
            status: res.exitCode === 0 ? 'passed' : 'failed',
            exitCode: res.exitCode,
            summary: res.exitCode === 0 ? undefined : `exit code ${res.exitCode}`,
          });
        }
        command = { run, exitCode: res.exitCode, output: res.output };
        emit(`[AI] meninjau hasil perintah (exit code ${res.exitCode})…`);
      }

      if (!opts.adapter) throw new Error('Stage AI butuh agent, tetapi agent tidak tersedia');
      const outcome = await runAiStage(opts.adapter, stage, {
        cwd: pipeline.root,
        model: pipeline.config.model,
        sensitivePaths: pipeline.config.sensitive_paths,
        maxBudgetUsd: pipeline.config.max_budget_usd,
        timeoutMs: parseDuration(stage.config.timeout, DEFAULT_AI_TIMEOUT_MS),
        signal: opts.signal,
        onLog: emit,
        command,
      });
      for (const denied of outcome.deniedReads) emit(`[AI] akses diblokir: ${denied}`);
      const blocking = outcome.verdict.findings.filter((f) => isBlocking(f, stage.config.fail_on));
      emit(`[AI] ${outcome.verdict.summary}`);
      return finish({
        status: blocking.length ? 'failed' : 'passed',
        exitCode: command?.exitCode,
        summary: outcome.verdict.summary,
        findings: outcome.verdict.findings,
        costUsd: outcome.costUsd,
      });
    } catch (err) {
      if (opts.signal?.aborted) return finish({ status: 'skipped', summary: 'dibatalkan' });
      const message = (err as Error).message;
      emit(`ERROR: ${message}`);
      return finish({ status: 'error', error: message });
    }
  };

  /** Mengembalikan true bila node berakhir dengan kegagalan yang menghalangi. */
  const runNode = async (node: PipelineNode, failFast: boolean): Promise<boolean> => {
    if (node.kind === 'stage') return isBlockingFailure(await runStage(node));
    return runGroup(node, node.config.fail_fast ?? failFast);
  };

  const runGroup = async (group: GroupNode, failFast: boolean): Promise<boolean> => {
    const t0 = Date.now();
    opts.onEvent({ type: 'group:start', id: group.id });
    const failed = group.config.parallel
      ? (await Promise.all(group.children.map((c) => runNode(c, failFast)))).some(Boolean)
      : await runSequence(group.children, failFast);
    const status: StageStatus = failed
      ? 'failed'
      : stagesIn(group).every((s) => results[s.id]?.status === 'skipped')
        ? 'skipped'
        : 'passed';
    opts.onEvent({ type: 'group:finish', id: group.id, status, durationMs: Date.now() - t0 });
    return failed;
  };

  const runSequence = async (nodes: PipelineNode[], failFast: boolean): Promise<boolean> => {
    let failed = false;
    for (let i = 0; i < nodes.length; i++) {
      if (opts.signal?.aborted) {
        skip(nodes.slice(i), 'dibatalkan');
        break;
      }
      if (await runNode(nodes[i], failFast)) {
        failed = true;
        if (failFast) {
          skip(nodes.slice(i + 1), 'dilewati: stage sebelumnya gagal');
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

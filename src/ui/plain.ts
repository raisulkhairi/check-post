import pc from 'picocolors';
import type { PipelineEvent } from '../core/events.js';
import { isBlocking } from '../core/runners/ai.js';
import type { StageNode } from '../core/types.js';
import { formatDuration, findingLocation } from './format.js';

const colorBySeverity = { critical: pc.magenta, high: pc.red, medium: pc.yellow, low: pc.cyan, info: pc.gray } as const;

/** Renderer untuk CI / non-TTY: satu baris per kejadian, log stage diberi prefix. */
export function createPlainRenderer(stages: Map<string, StageNode>, opts: { verbose: boolean; write?: (s: string) => void }) {
  const write = opts.write ?? ((s: string) => process.stdout.write(s + '\n'));
  return (e: PipelineEvent) => {
    switch (e.type) {
      case 'stage:start':
        write(pc.cyan(`▶ ${e.id}`));
        break;
      case 'stage:log':
        if (opts.verbose || e.line.startsWith('[AI]')) write(pc.dim(`  │ ${e.line}`));
        break;
      case 'stage:finish': {
        const r = e.result;
        const stage = stages.get(e.id);
        const time = formatDuration(r.durationMs);
        const cost = r.costUsd ? ` · $${r.costUsd.toFixed(3)}` : '';
        const label = `${e.id} ${pc.dim(`${time}${cost}`)}`;
        if (r.status === 'passed') write(pc.green(`✔ ${label}`));
        else if (r.status === 'skipped') write(pc.gray(`– ${e.id} (${r.summary ?? 'dilewati'})`));
        else {
          const tag = r.allowFailure ? pc.yellow(' [allow_failure]') : '';
          write(pc.red(`✖ ${label}`) + tag + (r.error ? pc.red(` · ${r.error}`) : r.summary ? pc.dim(` · ${r.summary}`) : ''));
          if (r.status === 'failed' && stage?.type === 'command' && r.logFile) write(pc.dim(`  log: ${r.logFile}`));
        }
        for (const f of r.findings) {
          const blocking = stage ? isBlocking(f, stage.config.fail_on) : false;
          const sev = colorBySeverity[f.severity](f.severity.toUpperCase().padEnd(8));
          write(`  ${blocking ? '!' : ' '} ${sev} ${findingLocation(f)}`);
          write(`             ${f.message}`);
          if (f.suggestion) write(pc.dim(`             → ${f.suggestion}`));
        }
        break;
      }
      default:
        break;
    }
  };
}

import path from 'node:path';
import pc from 'picocolors';
import { discoverPipeline } from '../core/discovery.js';
import { evaluateGate } from '../core/gate.js';
import { formatDuration } from '../ui/format.js';
import { printDefinitionError } from './shared.js';

export async function statusCommand(flags: { cwd: string; json?: boolean }): Promise<number> {
  const root = path.resolve(flags.cwd);
  let pipeline;
  try {
    pipeline = discoverPipeline(root);
  } catch (err) {
    return printDefinitionError(err);
  }
  const gate = await evaluateGate(pipeline);

  if (flags.json) {
    console.log(
      JSON.stringify(
        { gate: gate.green ? 'green' : 'red', reasons: gate.reasons, commit: gate.git.sha, lastRunAt: gate.lastRun?.updatedAt ?? null },
        null,
        2,
      ),
    );
    return gate.green ? 0 : 1;
  }

  const ref = gate.git.sha ? `${gate.git.branch}@${gate.git.sha.slice(0, 7)}` : '';
  const ago = gate.lastRun ? ` · dijalankan ${formatDuration(Date.now() - Date.parse(gate.lastRun.updatedAt))} lalu` : '';
  if (gate.green) {
    console.log(pc.green(pc.bold(`✔ GREEN · boleh deploy`)) + pc.gray(` · ${ref}${ago}`));
    return 0;
  }
  console.log(pc.red(pc.bold('✖ RED · belum boleh deploy')) + pc.gray(ref ? ` · ${ref}${ago}` : ''));
  for (const r of gate.reasons) console.log(pc.gray(`  • ${r}`));
  return 1;
}

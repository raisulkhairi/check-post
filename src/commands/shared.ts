import pc from 'picocolors';
import { DefinitionError } from '../core/stage-file.js';

/** Cetak error definisi stage dan kembalikan exit code 2; error lain dilempar ulang. */
export function printDefinitionError(err: unknown): number {
  if (err instanceof DefinitionError) {
    console.error(pc.red(pc.bold('Definisi pipeline tidak valid:')));
    for (const p of err.problems) console.error(pc.red(`  • ${p}`));
    return 2;
  }
  throw err;
}

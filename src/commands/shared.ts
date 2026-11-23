import pc from 'picocolors';
import { DefinitionError } from '../core/stage-file.js';

/** Print stage definition errors and return exit code 2; rethrow anything else. */
export function printDefinitionError(err: unknown): number {
  if (err instanceof DefinitionError) {
    console.error(pc.red(pc.bold('Invalid pipeline definition:')));
    for (const p of err.problems) console.error(pc.red(`  • ${p}`));
    return 2;
  }
  throw err;
}

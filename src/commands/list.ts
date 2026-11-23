import path from 'node:path';
import pc from 'picocolors';
import { discoverPipeline, flatten } from '../core/discovery.js';
import { typeLabel } from '../ui/format.js';
import { printDefinitionError } from './shared.js';

export function listCommand(flags: { cwd: string; json?: boolean }): number {
  const root = path.resolve(flags.cwd);
  let pipeline;
  try {
    pipeline = discoverPipeline(root);
  } catch (err) {
    return printDefinitionError(err);
  }
  const rows = flatten(pipeline.children);

  if (flags.json) {
    console.log(
      JSON.stringify(
        rows.map(({ node, depth }) => ({
          id: node.id,
          name: node.name,
          depth,
          kind: node.kind,
          type: node.kind === 'stage' ? node.type : node.config.parallel ? 'parallel' : 'sequential',
          run: node.kind === 'stage' ? node.config.run : undefined,
        })),
        null,
        2,
      ),
    );
    return 0;
  }

  const c = pipeline.config;
  console.log(pc.bold(`Checkpost · ${c.agent} (${c.model}) · fail_fast: ${c.fail_fast}`));
  let top = 0;
  for (const { node, depth } of rows) {
    const num = depth === 0 ? String(++top).padStart(2) : '  ';
    const indent = depth === 0 ? '' : '  '.repeat(depth - 1) + '├ ';
    const name = (indent + node.name).padEnd(24);
    const kind = typeLabel(node).padEnd(15);
    let detail = '';
    if (node.kind === 'stage') {
      const bits: string[] = [];
      if (node.config.run) bits.push(node.config.run);
      if (node.type !== 'command') bits.push(`fail_on: ${node.config.fail_on}`);
      if (node.config.allow_failure) bits.push('allow_failure');
      detail = bits.join(' · ');
    }
    const color = node.kind === 'group' ? pc.bold : node.type === 'command' ? (s: string) => s : pc.cyan;
    console.log(`${pc.gray(num)}  ${color(name)} ${pc.gray(kind)} ${pc.dim(detail)}`);
  }
  return 0;
}

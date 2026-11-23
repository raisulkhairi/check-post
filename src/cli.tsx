#!/usr/bin/env node
import { Command, Option } from 'commander';
import { initCommand } from './commands/init.js';
import { listCommand } from './commands/list.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';

const program = new Command();
program
  .name('checkpost')
  .description('Local CI/CD pipeline: stages are Markdown files, run by an AI CLI')
  .version('0.1.0')
  .option('-C, --cwd <dir>', 'project root', process.cwd());

const cwd = () => program.opts<{ cwd: string }>().cwd;
const finish = (code: number) => {
  process.exitCode = code;
};

program
  .command('init')
  .description('create the checkpost/ folder from a preset')
  .addOption(new Option('--preset <name>', 'stage preset').choices(['angular', 'nextjs', 'node', 'empty']))
  .addOption(new Option('--share <mode>', 'keep local only or share with the team').choices(['local', 'team']))
  .option('--no-slash-command', 'do not install the /checkpost slash command')
  .option('-y, --yes', 'use defaults without prompting')
  .option('--force', 'overwrite an existing checkpost/ folder')
  .action(async (o) => {
    const slashCommand = process.argv.includes('--no-slash-command') ? false : o.yes ? true : undefined;
    finish(await initCommand({ cwd: cwd(), preset: o.preset, share: o.share, slashCommand, yes: o.yes, force: o.force }));
  });

program
  .command('list')
  .description('show the stage order without running it')
  .option('--json', 'JSON output')
  .action((o) => finish(listCommand({ cwd: cwd(), json: o.json })));

program
  .command('run')
  .argument('[stage]', 'run a single stage or group (id or name)')
  .description('run the pipeline')
  .option('--ci', 'non-interactive mode (automatic when not a terminal)')
  .option('--json', 'print the final result as JSON on stdout')
  .option('-y, --yes', 'skip the AI usage confirmation')
  .option('-v, --verbose', 'show full command logs in CI mode')
  .action(async (stage, o) => finish(await runCommand(stage, { cwd: cwd(), ci: o.ci, json: o.json, yes: o.yes, verbose: o.verbose })));

program
  .command('status')
  .description('check the gate: GREEN (ok to deploy) or RED; exit code 0/1')
  .option('--json', 'JSON output')
  .action(async (o) => finish(await statusCommand({ cwd: cwd(), json: o.json })));

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

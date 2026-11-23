#!/usr/bin/env node
import { Command, Option } from 'commander';
import { initCommand } from './commands/init.js';
import { listCommand } from './commands/list.js';
import { runCommand } from './commands/run.js';
import { statusCommand } from './commands/status.js';

const program = new Command();
program
  .name('checkpost')
  .description('Pipeline CI/CD lokal: stage dari file Markdown, dijalankan oleh AI CLI')
  .version('0.1.0')
  .option('-C, --cwd <dir>', 'root project', process.cwd());

const cwd = () => program.opts<{ cwd: string }>().cwd;
const finish = (code: number) => {
  process.exitCode = code;
};

program
  .command('init')
  .description('buat folder checkpost/ dari preset')
  .addOption(new Option('--preset <name>', 'preset stage').choices(['angular', 'nextjs', 'node', 'empty']))
  .addOption(new Option('--share <mode>', 'simpan lokal saja atau bagikan ke tim').choices(['local', 'team']))
  .option('--no-slash-command', 'jangan pasang slash command /checkpost')
  .option('-y, --yes', 'pakai default tanpa bertanya')
  .option('--force', 'timpa folder checkpost/ yang sudah ada')
  .action(async (o) => {
    const slashCommand = process.argv.includes('--no-slash-command') ? false : o.yes ? true : undefined;
    finish(await initCommand({ cwd: cwd(), preset: o.preset, share: o.share, slashCommand, yes: o.yes, force: o.force }));
  });

program
  .command('list')
  .description('tampilkan urutan stage tanpa menjalankannya')
  .option('--json', 'output JSON')
  .action((o) => finish(listCommand({ cwd: cwd(), json: o.json })));

program
  .command('run')
  .argument('[stage]', 'jalankan satu stage atau grup saja (id atau nama)')
  .description('jalankan pipeline')
  .option('--ci', 'mode non-interaktif (otomatis bila bukan terminal)')
  .option('--json', 'cetak hasil akhir sebagai JSON di stdout')
  .option('-y, --yes', 'lewati konfirmasi pemakaian AI')
  .option('-v, --verbose', 'tampilkan seluruh log perintah di mode CI')
  .action(async (stage, o) => finish(await runCommand(stage, { cwd: cwd(), ci: o.ci, json: o.json, yes: o.yes, verbose: o.verbose })));

program
  .command('status')
  .description('cek gate: GREEN (boleh deploy) atau RED; exit code 0/1')
  .option('--json', 'output JSON')
  .action(async (o) => finish(await statusCommand({ cwd: cwd(), json: o.json })));

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkbox, confirm, select } from '@inquirer/prompts';
import pc from 'picocolors';
import { AGENTS } from '../core/adapters/index.js';
import { GROUP_FILE, PIPELINE_DIR, splitPrefix } from '../core/discovery.js';
import { STATE_DIR, readGitState } from '../core/gate.js';
import { detectProject, ignorePaths, npmScriptOf, type ProjectKind } from '../core/project.js';
import { parseMarkdown } from '../core/stage-file.js';
import { StageConfigSchema } from '../core/types.js';

const PRESETS_DIR = fileURLToPath(new URL('../../presets/', import.meta.url));
const PRESETS: Array<{ id: Exclude<ProjectKind, 'unknown'> | 'empty'; label: string }> = [
  { id: 'angular', label: 'Angular' },
  { id: 'nextjs', label: 'Next.js' },
  { id: 'node', label: 'Node.js / API' },
  { id: 'empty', label: 'Kosong (satu contoh stage)' },
];
const EXTRA_SENSITIVE: Partial<Record<ProjectKind, string[]>> = {
  angular: ['src/environments/**'],
};
const SLASH_COMMAND_PATH = '.claude/commands/checkpost.md';

export interface InitFlags {
  cwd: string;
  preset?: string;
  yes?: boolean;
  share?: 'local' | 'team';
  slashCommand?: boolean;
  force?: boolean;
}

interface PresetStage {
  rel: string; // path relatif di preset, mis. 04-security/02-xss-audit.md
  label: string;
  missingScript: string | null;
}

function presetStages(presetDir: string, scripts: Record<string, string>): PresetStage[] {
  const out: PresetStage[] = [];
  const walk = (dir: string, depth: number) => {
    for (const name of readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const rel = path.relative(presetDir, full);
      if (statSync(full).isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (name === GROUP_FILE || name === 'context.md' || !name.endsWith('.md')) continue;
      const { data, body } = parseMarkdown(readFileSync(full, 'utf8'), StageConfigSchema, rel);
      const script = data.run ? npmScriptOf(data.run) : null;
      const missingScript = script && script !== 'test' ? (scripts[script] ? null : script) : script === 'test' && !scripts.test ? 'test' : null;
      const groupName = depth > 0 ? splitPrefix(path.basename(path.dirname(full))).name + '/' : '';
      const kind = data.run ? (body ? `${data.run} + AI` : data.run) : 'AI';
      out.push({
        rel,
        label: `${groupName}${splitPrefix(name).name}  ${pc.gray(kind)}${missingScript ? pc.yellow(`  (script "${missingScript}" tidak ada)`) : ''}`,
        missingScript,
      });
    }
  };
  walk(presetDir, 0);
  return out;
}

function pipelineMd(opts: { kind: ProjectKind; context: string; docs: string[]; label: string }): string {
  const sensitive = EXTRA_SENSITIVE[opts.kind] ?? [];
  const front = [
    '---',
    'agent: claude-code',
    'model: sonnet            # model untuk stage AI (sonnet | opus | haiku)',
    'fail_fast: true          # berhenti di stage pertama yang gagal',
    'require_clean_tree: true # gate hanya green bila tidak ada perubahan belum di-commit',
    'max_budget_usd: 1        # batas biaya per stage AI',
  ];
  if (sensitive.length) {
    front.push('sensitive_paths:         # tidak boleh dibaca AI (selain .env*, .npmrc, *.pem, *.key)');
    for (const s of sensitive) front.push(`  - ${s}`);
  }
  front.push('---', '');
  const body = [`Project: ${opts.label}.`, opts.context.trim()];
  if (opts.docs.length) body.push(`Konvensi project tertulis di: ${opts.docs.join(', ')}. Baca file tersebut bila relevan.`);
  return front.join('\n') + body.join('\n\n') + '\n';
}

const SLASH_COMMAND = `---
description: Jalankan Checkpost (stage di folder checkpost/) dan ringkas hasilnya
allowed-tools: Bash(checkpost:*), Bash(npx checkpost:*)
---
Jalankan perintah berikut di root project (bisa beberapa menit):

\`\`\`
checkpost run --ci --json --yes $ARGUMENTS
\`\`\`

Output JSON ada di stdout. Lalu ringkas dalam bahasa Indonesia:
1. Status gate (GREEN = boleh deploy, RED = belum) dan alasannya.
2. Stage yang gagal beserta temuan utamanya (severity, file:baris, pesan).
3. Saran langkah berikutnya. Jangan mengubah kode kecuali diminta.
`;

export async function initCommand(flags: InitFlags): Promise<number> {
  const root = path.resolve(flags.cwd);
  const interactive = Boolean(process.stdin.isTTY && !flags.yes);
  const targetDir = path.join(root, PIPELINE_DIR);

  console.log(pc.bold('\n◆ Checkpost · setup\n'));
  if (existsSync(targetDir) && !flags.force) {
    console.error(pc.red(`  ${PIPELINE_DIR}/ sudah ada. Pakai --force untuk menimpa file preset.`));
    return 2;
  }

  const git = await readGitState(root);
  console.log(git.isRepo ? pc.green(`  ✔ Git repository (branch: ${git.branch})`) : pc.yellow('  ⚠ Bukan git repository: gate tidak bisa mengecek commit'));
  const project = detectProject(root);
  console.log(project.kind === 'unknown' ? pc.yellow('  ⚠ Jenis project tidak dikenali') : pc.green(`  ✔ Project: ${project.label}`));

  const claude = AGENTS['claude-code'].create!();
  const detected = await claude.detect();
  if (!detected.installed) {
    console.error(pc.red('  ✖ Claude Code tidak ditemukan. Install: npm install -g @anthropic-ai/claude-code, lalu jalankan "claude" sekali untuk login.'));
    return 2;
  }
  console.log(pc.green(`  ✔ AI CLI: Claude Code ${detected.version ?? ''}`));
  if (project.docs.length) console.log(pc.green(`  ✔ Dokumen konvensi: ${project.docs.join(', ')}`));
  console.log('');

  if (interactive) {
    await select({
      message: 'Pilih AI agent',
      choices: Object.entries(AGENTS).map(([id, a]) => ({
        value: id,
        name: a.available ? a.label : `${a.label} ${pc.gray('(segera)')}`,
        disabled: !a.available,
      })),
    });
  }

  const detectedPreset = PRESETS.find((p) => p.id === project.kind)?.id ?? 'empty';
  let preset = (flags.preset ?? detectedPreset) as (typeof PRESETS)[number]['id'];
  if (!PRESETS.some((p) => p.id === preset)) {
    console.error(pc.red(`  Preset "${preset}" tidak dikenal. Pilihan: ${PRESETS.map((p) => p.id).join(', ')}`));
    return 2;
  }
  if (interactive && !flags.preset) {
    preset = await select({
      message: 'Pilih preset stage',
      default: detectedPreset,
      choices: PRESETS.map((p) => ({
        value: p.id,
        name: p.id === detectedPreset && p.id !== 'empty' ? `${p.label} ${pc.green('(Recommended, terdeteksi)')}` : p.label,
      })),
    });
  }

  let chosen: string[] = [];
  let context = '';
  const presetDir = path.join(PRESETS_DIR, preset);
  if (preset !== 'empty') {
    context = readFileSync(path.join(presetDir, 'context.md'), 'utf8');
    const stages = presetStages(presetDir, project.scripts);
    chosen = stages.filter((s) => !s.missingScript).map((s) => s.rel);
    if (interactive) {
      chosen = await checkbox({
        message: 'Stage mana yang diaktifkan? (spasi = pilih, enter = lanjut)',
        choices: stages.map((s) => ({ value: s.rel, name: s.label, checked: !s.missingScript })),
        pageSize: 15,
      });
    }
  }

  let share = flags.share ?? 'local';
  if (interactive && !flags.share) {
    share = await select({
      message: 'Folder checkpost/ disimpan bagaimana?',
      choices: [
        { value: 'local' as const, name: `Hanya di komputer ini ${pc.gray('(.git/info/exclude, repo tidak berubah)')}` },
        { value: 'team' as const, name: `Bagikan ke tim ${pc.gray('(commit checkpost/, state di .gitignore)')}` },
      ],
    });
  }

  let installSlash = flags.slashCommand ?? true;
  if (interactive && flags.slashCommand === undefined) {
    installSlash = await confirm({ message: 'Pasang slash command /checkpost untuk Claude Code?', default: true });
  }

  // Tulis file
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(path.join(targetDir, 'pipeline.md'), pipelineMd({ kind: preset === 'empty' ? project.kind : preset, context, docs: project.docs, label: project.label }));
  const written = ['pipeline.md'];
  if (preset === 'empty') {
    writeFileSync(
      path.join(targetDir, '01-build.md'),
      '---\nrun: npm run build\n---\n',
    );
    written.push('01-build.md');
  }
  const groups = new Set<string>();
  for (const rel of chosen) {
    const dest = path.join(targetDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(path.join(presetDir, rel), dest);
    written.push(rel);
    const dir = path.dirname(rel);
    if (dir !== '.' && !groups.has(dir) && existsSync(path.join(presetDir, dir, GROUP_FILE))) {
      groups.add(dir);
      cpSync(path.join(presetDir, dir, GROUP_FILE), path.join(targetDir, dir, GROUP_FILE));
      written.push(path.join(dir, GROUP_FILE));
    }
  }
  if (installSlash) {
    const slash = path.join(root, SLASH_COMMAND_PATH);
    mkdirSync(path.dirname(slash), { recursive: true });
    writeFileSync(slash, SLASH_COMMAND);
  }

  const ignored: string[] = [];
  if (git.isRepo) {
    if (share === 'local') {
      const patterns = [`/${PIPELINE_DIR}/`, `/${STATE_DIR}/`];
      if (installSlash) patterns.push(`/${SLASH_COMMAND_PATH}`);
      ignored.push(...(await ignorePaths(root, patterns, 'exclude')));
    } else {
      ignored.push(...(await ignorePaths(root, [`/${STATE_DIR}/`], 'gitignore')));
    }
  }

  console.log(pc.green('\n  ✔ Dibuat:'));
  for (const f of written.sort()) console.log(pc.gray(`    ${PIPELINE_DIR}/${f.split(path.sep).join('/')}`));
  if (installSlash) console.log(pc.gray(`    ${SLASH_COMMAND_PATH}`));
  if (ignored.length) {
    const where = share === 'local' ? '.git/info/exclude' : '.gitignore';
    console.log(pc.green(`  ✔ Ditambahkan ke ${where}: ${ignored.join(', ')}`));
  }
  console.log(`
  Langkah berikutnya:
    1. Sesuaikan isi file .md di ${PIPELINE_DIR}/ (opsional)
    2. checkpost list   → cek urutan stage
    3. checkpost run    → jalankan pipeline
`);
  return 0;
}

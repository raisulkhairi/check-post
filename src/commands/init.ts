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
  { id: 'empty', label: 'Empty (one example stage)' },
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
  rel: string; // path inside the preset, e.g. 04-security/02-xss-audit.md
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
        label: `${groupName}${splitPrefix(name).name}  ${pc.gray(kind)}${missingScript ? pc.yellow(`  (no "${missingScript}" script)`) : ''}`,
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
    'model: sonnet            # model for AI stages (sonnet | opus | haiku)',
    'fail_fast: true          # stop at the first failing stage',
    'require_clean_tree: true # gate is only green with no uncommitted changes',
    'max_budget_usd: 1        # cost limit per AI stage',
    'language: English        # language of AI summaries and findings',
  ];
  if (sensitive.length) {
    front.push('sensitive_paths:         # never read by the AI (in addition to .env*, .npmrc, *.pem, *.key)');
    for (const s of sensitive) front.push(`  - ${s}`);
  }
  front.push('---', '');
  const body = [`Project: ${opts.label}.`, opts.context.trim()];
  if (opts.docs.length) body.push(`Project conventions are documented in: ${opts.docs.join(', ')}. Read them when relevant.`);
  return front.join('\n') + body.join('\n\n') + '\n';
}

const SLASH_COMMAND = `---
description: Run Checkpost (stages in checkpost/) and summarize the result
allowed-tools: Bash(checkpost:*), Bash(npx checkpost:*)
---
Run this command in the project root (it can take a few minutes):

\`\`\`
checkpost run --ci --json --yes $ARGUMENTS
\`\`\`

The JSON result is on stdout. Then summarize:
1. Gate status (GREEN = ok to deploy, RED = not yet) and why.
2. Failed stages with their main findings (severity, file:line, message).
3. Suggested next steps. Do not change code unless asked.
`;

export async function initCommand(flags: InitFlags): Promise<number> {
  const root = path.resolve(flags.cwd);
  const interactive = Boolean(process.stdin.isTTY && !flags.yes);
  const targetDir = path.join(root, PIPELINE_DIR);

  console.log(pc.bold('\n◆ Checkpost · setup\n'));
  if (existsSync(targetDir) && !flags.force) {
    console.error(pc.red(`  ${PIPELINE_DIR}/ already exists. Use --force to overwrite the preset files.`));
    return 2;
  }

  const git = await readGitState(root);
  console.log(git.isRepo ? pc.green(`  ✔ Git repository (branch: ${git.branch})`) : pc.yellow('  ⚠ Not a git repository: the gate cannot check commits'));
  const project = detectProject(root);
  console.log(project.kind === 'unknown' ? pc.yellow('  ⚠ Project type not recognized') : pc.green(`  ✔ Project: ${project.label}`));

  const claude = AGENTS['claude-code'].create!();
  const detected = await claude.detect();
  if (!detected.installed) {
    console.error(pc.red('  ✖ Claude Code not found. Install it: npm install -g @anthropic-ai/claude-code, then run "claude" once to log in.'));
    return 2;
  }
  console.log(pc.green(`  ✔ AI CLI: Claude Code ${detected.version ?? ''}`));
  if (project.docs.length) console.log(pc.green(`  ✔ Convention docs: ${project.docs.join(', ')}`));
  console.log('');

  if (interactive) {
    await select({
      message: 'Choose an AI agent',
      choices: Object.entries(AGENTS).map(([id, a]) => ({
        value: id,
        name: a.available ? a.label : `${a.label} ${pc.gray('(coming soon)')}`,
        disabled: !a.available,
      })),
    });
  }

  const detectedPreset = PRESETS.find((p) => p.id === project.kind)?.id ?? 'empty';
  let preset = (flags.preset ?? detectedPreset) as (typeof PRESETS)[number]['id'];
  if (!PRESETS.some((p) => p.id === preset)) {
    console.error(pc.red(`  Unknown preset "${preset}". Options: ${PRESETS.map((p) => p.id).join(', ')}`));
    return 2;
  }
  if (interactive && !flags.preset) {
    preset = await select({
      message: 'Choose a stage preset',
      default: detectedPreset,
      choices: PRESETS.map((p) => ({
        value: p.id,
        name: p.id === detectedPreset && p.id !== 'empty' ? `${p.label} ${pc.green('(Recommended, detected)')}` : p.label,
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
        message: 'Which stages should be enabled? (space = toggle, enter = continue)',
        choices: stages.map((s) => ({ value: s.rel, name: s.label, checked: !s.missingScript })),
        pageSize: 15,
      });
    }
  }

  let share = flags.share ?? 'local';
  if (interactive && !flags.share) {
    share = await select({
      message: 'How should the checkpost/ folder be kept?',
      choices: [
        { value: 'local' as const, name: `Only on this machine ${pc.gray('(.git/info/exclude, repo unchanged)')}` },
        { value: 'team' as const, name: `Share with the team ${pc.gray('(commit checkpost/, state in .gitignore)')}` },
      ],
    });
  }

  let installSlash = flags.slashCommand ?? true;
  if (interactive && flags.slashCommand === undefined) {
    installSlash = await confirm({ message: 'Install the /checkpost slash command for Claude Code?', default: true });
  }

  // Write files
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

  console.log(pc.green('\n  ✔ Created:'));
  for (const f of written.sort()) console.log(pc.gray(`    ${PIPELINE_DIR}/${f.split(path.sep).join('/')}`));
  if (installSlash) console.log(pc.gray(`    ${SLASH_COMMAND_PATH}`));
  if (ignored.length) {
    const where = share === 'local' ? '.git/info/exclude' : '.gitignore';
    console.log(pc.green(`  ✔ Added to ${where}: ${ignored.join(', ')}`));
  }
  console.log(`
  Next steps:
    1. Adjust the .md files in ${PIPELINE_DIR}/ (optional)
    2. checkpost list   → check the stage order
    3. checkpost run    → run the pipeline
`);
  return 0;
}

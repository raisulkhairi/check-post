# check-post

A CI/CD-style pipeline that runs on your own machine. Stages are Markdown files, and stages that need judgment are run by an AI CLI (currently Claude Code). When every stage is green, the gate says the project is ready to deploy.

```
 Checkpost · claude-code · main@a1b2c3d
 ──────────────────────────────────────────
 ✔ lint                    4.1s
 ✔ unit-test              12.4s
 ✔ build                  31.0s
 ⠹ security          (parallel)
 ├ ✔ secrets      [AI]     9.8s
 ├ ✖ xss-audit    [AI]    22.3s  2 findings (1 blocking)
 ├ ⠹ env-audit    [AI]    18.0s
 ○ code-standard  [AI]
```

## Requirements
- Node.js 22+
- [Claude Code](https://docs.claude.com/claude-code), installed and logged in (`claude`)

## Install
Use it without installing:
```bash
npx check-post init
npx check-post run
```
Or install it globally:
```bash
npm install -g check-post
```
The command is available as both `check-post` and `checkpost`.

Latest version straight from GitHub:
```bash
npx github:raisulkhairi/check-post init
```
Avoid `npm install -g github:…`: npm fails to build git packages in global mode (`tsc: not found`). For a permanent install of the GitHub version:
```bash
git clone https://github.com/raisulkhairi/check-post.git
cd check-post && npm install && npm link
```

## Getting started
Run these in the root of the project you want to check:
```bash
checkpost init      # wizard: detect the project, pick a preset and stages
checkpost list      # check the stage order
checkpost run       # run with the terminal UI
checkpost status    # GREEN/RED, exit code 0/1
```
You don't need to open `claude` first. Checkpost calls Claude Code itself for AI stages.

## Stages are Markdown files
```
checkpost/
  pipeline.md              # global config + project context for every AI stage
  01-lint.md
  02-unit-test.md
  03-build.md
  04-security/             # subfolder = group
    _group.md              # parallel: true
    01-secrets.md
    02-xss-audit.md
  05-code-standard.md
  _draft.md                # a _ or . prefix = ignored
```

**Order** follows the numeric prefix (`2-` comes before `10-`). Items without a prefix go last, alphabetically. Prefixes are not shown in the UI.

**The stage type comes from the file's content:**

| Content | Behavior | Passes when |
|---|---|---|
| `run:` only | runs the command | exit code 0 |
| body only | the body becomes the AI's instructions | no findings ≥ `fail_on` |
| `run:` + body | runs the command, then the AI reviews its output | no findings ≥ `fail_on` |

```md
---
paths: ["src/**/*.ts", "src/**/*.html"]
fail_on: high
---
# XSS audit
Look for bypassSecurityTrustHtml and [innerHTML] bindings fed with user data...
```

AI summaries and findings are written in the language set by `language:` in `pipeline.md` (default `English`).

### Frontmatter

| Field | Where | Default | Description |
|---|---|---|---|
| `run` | stage | – | shell command |
| `timeout` | stage | 15m (command), 10m (AI) | `30s`, `5m`, `1h`, or a number of seconds |
| `fail_on` | stage | `high` | `critical`, `high`, `medium`, `low`, `info` |
| `paths` | stage | – | limit the files the AI inspects |
| `require_exit_zero` | stage | `false` | `run:` + body: a non-zero exit code fails the stage whatever the AI says |
| `on_incomplete` | stage, pipeline | `fail` | `fail` or `warn` when the AI reports it could not check the whole scope |
| `allow_failure` | stage | `false` | a failure does not block the gate |
| `enabled` | stage, group | `true` | |
| `name` | stage, group | file name | display name |
| `model`, `max_budget_usd` | stage, pipeline | `sonnet`, `1` | |
| `language` | pipeline | `English` | language of AI summaries and findings |
| `parallel` | group | `false` | run the group's children concurrently |
| `max_parallel` | group, pipeline | `4` | most children of a parallel group running at the same time |
| `fail_fast` | group, pipeline | `true` | stop at the first failure |
| `require_clean_tree` | pipeline | `true` | gate is RED when there are uncommitted changes |
| `sensitive_paths` | pipeline, group, stage | `.env*`, `.npmrc`, `*.pem`, `*.key` | paths the AI must never read; a group or stage adds to the inherited list |
| `confirm_ai` | pipeline | `true` | ask once before using your AI quota |

The body of `pipeline.md` and `_group.md` is passed as context to every AI stage below it.

Helper scripts can live next to the stages in a folder that starts with `_` (for example `checkpost/_scripts/`).
It is ignored by discovery, and stages call it with `run: node checkpost/_scripts/check.mjs`.

### Deterministic checks with an AI report
When a script decides pass or fail and the AI only explains the result, set `require_exit_zero: true`:
```md
---
run: node checkpost/_scripts/sonarqube-gate.mjs
require_exit_zero: true
---
Summarize the quality gate result and list the blocking issues.
```
Without it, a `run:` + body stage passes or fails on the AI's findings alone, so the AI can overrule the exit code.

### Incomplete audits
Every AI answer says whether it covered the whole scope (`complete`) and what it skipped (`not_checked`).
An incomplete audit fails the stage by default, so a partial check never shows up as green. Use
`on_incomplete: warn` for broad, advisory stages where a best-effort answer is fine.

### Budget
`max_budget_usd` is a safety limit per AI stage, not a quality setting: Claude Code stops when it is reached and the
stage ends as `error` with the amount spent. Raise it for broad stages (`max_budget_usd: 3`), or narrow `paths`.
The check runs between turns, so the final cost can be a little above the limit.

## AI stage safety
- The AI only gets read tools (Read, Grep, Glob). It cannot change files or run commands.
- `sensitive_paths` are blocked with Claude Code permission deny rules, so a rule such as "never read nginx/.htpasswd" belongs in frontmatter, not in the stage text. Attempts to read them show up in the log as `access blocked`.
- The AI cannot run commands. If a stage needs command output (for example `npx browserslist`), put the command in `run:` and the AI gets its output.
- Claude Code runs without MCP servers, plugins, or user settings, so the context stays small and a stage costs cents, not dollars.
- The AI must answer with validated, structured JSON. An invalid answer is retried once. If it is still invalid, the stage ends as `error`, never as passed.

## Gate
`checkpost status` is only GREEN when:
- every stage passed (or is `allow_failure`),
- the results are for the same commit as `HEAD`,
- stage definitions have not changed since the run,
- the working tree is clean (turn off with `require_clean_tree: false`).

```bash
checkpost status && vercel --prod
```

## CI and scripts
```bash
checkpost run --ci            # plain output + exit code
checkpost run --ci --json     # final JSON result on stdout, logs on stderr
checkpost run security        # a single group/stage (id or name)
```
`init` can also install a `/checkpost` slash command for Claude Code.

## Repos you don't own
`checkpost init --share local` adds `checkpost/`, `.checkpost/`, and the slash command to `.git/info/exclude`. The repo itself is not changed at all.

## Development
```bash
npm install
npm test          # vitest
npm run build     # tsc → dist/
npm link          # make the checkpost command available globally from this folder
```

## License
MIT

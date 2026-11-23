import { execa } from 'execa';
import path from 'node:path';
import { killTree } from '../process.js';
import { AgentError, type Adapter, type AdapterRunOptions, type AdapterRunResult } from './types.js';

/** Turn Claude Code's error result into a message that says what to change. */
export function describeFailure(final: Record<string, unknown>, maxBudgetUsd: number | undefined, cost: number | undefined): string {
  const spent = cost !== undefined ? `$${cost.toFixed(3)}` : 'unknown';
  const turns = typeof final.num_turns === 'number' ? ` over ${final.num_turns} turns` : '';
  switch (final.subtype) {
    case 'error_max_budget_usd':
      return (
        `hit the budget limit of $${maxBudgetUsd ?? '?'} (spent ${spent}${turns}) before answering. ` +
        'Raise max_budget_usd in this stage\'s frontmatter, narrow "paths", or split the stage.'
      );
    case 'error_max_turns':
      return `reached the turn limit${turns} before answering. Narrow "paths" or split the stage.`;
    default: {
      const errors = Array.isArray(final.errors) ? final.errors.join('; ') : '';
      const detail = errors || (final.result != null ? String(final.result) : '') || String(final.subtype ?? 'unknown');
      return `Claude Code error: ${detail}`;
    }
  }
}

const READ_TOOLS = ['Read', 'Grep', 'Glob'];

/** Turn sensitive_paths globs into Claude Code permission deny rules. */
export function denyRules(globs: string[]): string[] {
  const rules: string[] = [];
  for (const glob of globs) {
    const pattern = glob.startsWith('/') || glob.startsWith('./') || glob.startsWith('**') ? glob : `./${glob}`;
    for (const tool of READ_TOOLS) rules.push(`${tool}(${pattern})`);
  }
  return rules;
}

function describeToolUse(name: string, input: Record<string, unknown>, cwd: string): string {
  const rel = (p: unknown) => (typeof p === 'string' ? path.relative(cwd, p) || p : '');
  switch (name) {
    case 'Read':
      return `reading ${rel(input.file_path)}`;
    case 'Grep':
      return `searching "${String(input.pattern ?? '')}"${input.path ? ` in ${rel(input.path)}` : ''}`;
    case 'Glob':
      return `finding files ${String(input.pattern ?? '')}`;
    default:
      return name;
  }
}

export function createClaudeCodeAdapter(bin = 'claude'): Adapter {
  return {
    id: 'claude-code',
    label: 'Claude Code',

    async detect() {
      try {
        const { stdout } = await execa(bin, ['--version'], { timeout: 15_000 });
        return { installed: true, version: stdout.trim().split(/\s+/)[0] };
      } catch {
        return { installed: false };
      }
    },

    async run(o: AdapterRunOptions): Promise<AdapterRunResult> {
      const settings = { permissions: { deny: denyRules(o.denyPaths) } };
      const args = [
        '-p',
        o.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--tools',
        READ_TOOLS.join(','),
        '--permission-mode',
        'dontAsk',
        '--no-session-persistence',
        // Minimal context: no MCP servers, plugins, or user settings. This cuts the cost
        // per stage from dollars to cents.
        '--strict-mcp-config',
        '--setting-sources',
        'project',
        '--disable-slash-commands',
        '--system-prompt',
        o.systemPrompt,
        '--settings',
        JSON.stringify(settings),
        '--json-schema',
        JSON.stringify(o.schema),
      ];
      if (o.model) args.push('--model', o.model);
      if (o.maxBudgetUsd) args.push('--max-budget-usd', String(o.maxBudgetUsd));

      const child = execa(bin, args, {
        cwd: o.cwd,
        detached: true,
        reject: false,
        stdin: 'ignore',
        lines: true,
        buffer: { stdout: false, stderr: true },
      });

      let timedOut = false;
      let canceled = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, o.timeoutMs);
      const onAbort = () => {
        canceled = true;
        killTree(child.pid);
      };
      if (o.signal?.aborted) onAbort();
      o.signal?.addEventListener('abort', onAbort, { once: true });

      let final: Record<string, unknown> | null = null;
      try {
      for await (const line of child.iterable({ from: 'stdout' })) {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(String(line));
        } catch {
          continue;
        }
        if (event.type === 'assistant') {
          const content = (event.message as { content?: Array<Record<string, unknown>> } | undefined)?.content ?? [];
          for (const block of content) {
            if (block.type === 'tool_use' && block.name !== 'StructuredOutput') {
              o.onActivity?.(describeToolUse(String(block.name), (block.input ?? {}) as Record<string, unknown>, o.cwd));
            }
          }
        } else if (event.type === 'result') {
          final = event;
        }
      }
      } catch {
        /* stream closed when the process is killed */
      }
      const done = await child;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);

      if (!final) {
        const stderr = Array.isArray(done.stderr) ? done.stderr.join('\n') : String(done.stderr ?? '');
        const reason = canceled
          ? 'cancelled'
          : timedOut
            ? `timed out after ${Math.round(o.timeoutMs / 1000)}s`
            : stderr.trim() || `claude exited with code ${done.exitCode}`;
        throw new Error(`Claude Code failed: ${reason}`);
      }
      const cost = typeof final.total_cost_usd === 'number' ? final.total_cost_usd : undefined;
      if (final.is_error) throw new AgentError(describeFailure(final, o.maxBudgetUsd, cost), cost);

      const denials = (final.permission_denials as Array<{ tool_input?: Record<string, unknown> }> | undefined) ?? [];
      return {
        output: final.structured_output ?? null,
        rawText: String(final.result ?? ''),
        costUsd: cost,
        deniedReads: denials.map((d) => {
          const target = d.tool_input?.file_path ?? d.tool_input?.path ?? d.tool_input?.pattern;
          return typeof target === 'string' ? path.relative(o.cwd, target) || target : '?';
        }),
      };
    },
  };
}

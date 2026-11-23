import { execa } from 'execa';
import path from 'node:path';
import { killTree } from '../process.js';
import type { Adapter, AdapterRunOptions, AdapterRunResult } from './types.js';

const READ_TOOLS = ['Read', 'Grep', 'Glob'];

/** Ubah glob sensitive_paths menjadi aturan permission deny Claude Code. */
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
      return `membaca ${rel(input.file_path)}`;
    case 'Grep':
      return `mencari "${String(input.pattern ?? '')}"${input.path ? ` di ${rel(input.path)}` : ''}`;
    case 'Glob':
      return `mencari file ${String(input.pattern ?? '')}`;
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
        // Konteks seminimal mungkin: tanpa MCP, plugin, dan setting user. Ini menekan biaya
        // per stage dari dolar ke sen.
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
        /* stream ditutup paksa saat proses dihentikan */
      }
      const done = await child;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);

      if (!final) {
        const stderr = Array.isArray(done.stderr) ? done.stderr.join('\n') : String(done.stderr ?? '');
        const reason = canceled
          ? 'dibatalkan'
          : timedOut
            ? `timeout setelah ${Math.round(o.timeoutMs / 1000)}s`
            : stderr.trim() || `claude keluar dengan kode ${done.exitCode}`;
        throw new Error(`Claude Code gagal: ${reason}`);
      }
      if (final.is_error) {
        throw new Error(`Claude Code error: ${String(final.result ?? final.subtype ?? 'tidak diketahui')}`);
      }

      const denials = (final.permission_denials as Array<{ tool_input?: Record<string, unknown> }> | undefined) ?? [];
      return {
        output: final.structured_output ?? null,
        rawText: String(final.result ?? ''),
        costUsd: typeof final.total_cost_usd === 'number' ? final.total_cost_usd : undefined,
        deniedReads: denials.map((d) => {
          const target = d.tool_input?.file_path ?? d.tool_input?.path ?? d.tool_input?.pattern;
          return typeof target === 'string' ? path.relative(o.cwd, target) || target : '?';
        }),
      };
    },
  };
}

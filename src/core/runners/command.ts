import { execa } from 'execa';
import { killTree } from '../process.js';

export interface CommandRunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  canceled: boolean;
}

const MAX_KEPT_OUTPUT = 200_000;

export async function runCommand(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; onLine: (line: string) => void },
): Promise<CommandRunResult> {
  // detached: the process leads its own process group, so a timeout or cancel can stop
  // every descendant (e.g. `ng test` spawning a browser), not just the shell.
  const child = execa(command, {
    shell: true,
    cwd: opts.cwd,
    detached: true,
    reject: false,
    stdin: 'ignore',
    all: true,
    lines: true,
    buffer: false,
    env: { CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
  });

  let timedOut = false;
  let canceled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child.pid);
  }, opts.timeoutMs);
  const onAbort = () => {
    canceled = true;
    killTree(child.pid);
  };
  if (opts.signal?.aborted) onAbort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  let output = '';
  try {
    for await (const line of child.iterable({ from: 'all' })) {
      const text = String(line);
      opts.onLine(text);
      output += text + '\n';
      if (output.length > MAX_KEPT_OUTPUT) output = output.slice(-MAX_KEPT_OUTPUT);
    }
  } catch {
    /* stream closed when the process is killed */
  }
  const done = await child;
  clearTimeout(timer);
  opts.signal?.removeEventListener('abort', onAbort);
  return { exitCode: done.exitCode ?? null, output, timedOut, canceled };
}

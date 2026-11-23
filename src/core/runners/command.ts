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
  // detached: proses jadi pemimpin process group, sehingga timeout/batal bisa menghentikan
  // seluruh turunannya (mis. `ng test` yang memanggil browser), bukan hanya shell-nya.
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
    /* stream ditutup paksa saat proses dihentikan */
  }
  const done = await child;
  clearTimeout(timer);
  opts.signal?.removeEventListener('abort', onAbort);
  return { exitCode: done.exitCode ?? null, output, timedOut, canceled };
}

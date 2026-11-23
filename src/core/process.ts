/** Stop a whole process group (SIGTERM, then SIGKILL if still alive). */
export function killTree(pid: number | undefined, graceMs = 3000): void {
  if (!pid) return;
  const send = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* already dead */
      }
    }
  };
  send('SIGTERM');
  setTimeout(() => send('SIGKILL'), graceMs).unref();
}

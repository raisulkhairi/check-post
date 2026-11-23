/** Hentikan seluruh process group (SIGTERM, lalu SIGKILL bila masih hidup). */
export function killTree(pid: number | undefined, graceMs = 3000): void {
  if (!pid) return;
  const send = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* sudah mati */
      }
    }
  };
  send('SIGTERM');
  setTimeout(() => send('SIGKILL'), graceMs).unref();
}

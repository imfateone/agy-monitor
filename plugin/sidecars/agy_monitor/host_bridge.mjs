/**
 * Guards sidecar stdio streams and uncaught exceptions against broken EPIPE closures.
 */
export function installEpipeGuard(proc = process) {
  const isEpipe = err => err?.code === 'EPIPE';
  for (const stream of [proc.stdout, proc.stderr]) {
    stream?.on?.('error', err => { if (!isEpipe(err)) throw err; });
  }
  const fatal = err => {
    if (isEpipe(err)) return;
    try { console.error('[agy-monitor] fatal:', err); } catch {}
    proc.exit(1);
  };
  proc.on('uncaughtException', fatal);
  proc.on('unhandledRejection', fatal);
}

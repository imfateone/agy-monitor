/**
 * Ensures local loopback hosts bypass HTTP(S)_PROXY when NODE_USE_ENV_PROXY is active
 * without clobbering any user-configured NO_PROXY entries.
 */
export function ensureLoopbackNoProxy(env = process.env) {
  const required = ['127.0.0.1', 'localhost', '::1'];
  const merge = (raw) => {
    const existing = String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
    const seen = new Set(existing.map(s => s.toLowerCase()));
    if (seen.has('*')) return existing.join(',');
    for (const host of required) {
      if (!seen.has(host)) {
        existing.push(host);
        seen.add(host);
      }
    }
    return existing.join(',');
  };
  const nextUpper = merge(env.NO_PROXY);
  env.NO_PROXY = nextUpper;
  if (Object.prototype.hasOwnProperty.call(env, 'no_proxy') && env.no_proxy !== nextUpper) {
    env.no_proxy = merge(env.no_proxy);
  }
}

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

import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installEpipeGuard } from './host_bridge.mjs';
import { startMonitorInjector } from './injector.mjs';
import { startSelfReloadWatcher } from './reload.mjs';
import { createSettingsStore } from './settings.mjs';
import { buildConversationTelemetry, createSnapshotCache, resolveLatestConversationId } from './telemetry.mjs';
import { renderSidebarHtml } from './ui.mjs';
import { createAsyncUsageStatsCollector } from './usage_stats.mjs';

const CONV_DIR = join(homedir(), '.gemini', 'antigravity', 'conversations');
const settingsStore = createSettingsStore();
const snapshotCache = createSnapshotCache(buildConversationTelemetry);
const usageStatsCollector = createAsyncUsageStatsCollector({ convDir: CONV_DIR });

let cachedQuota = { quotaGroups: [], cloudPaygo: false };
let lastQuotaAt = 0;
let quotaInFlight = null;

async function fetchQuota() {
  if (Date.now() - lastQuotaAt < 10000) return cachedQuota;
  if (quotaInFlight) return quotaInFlight;
  quotaInFlight = (async () => {
    const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
    const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    if (!lsAddr || !csrf) return cachedQuota;
    const call = method => fetch(`http://${lsAddr}/exa.language_server_pb.LanguageServerService/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrf },
      body: '{}',
      signal: AbortSignal.timeout(3000),
    });
    try {
      const res = await call('RetrieveUserQuotaSummary');
      if (res.ok) {
        const data = await res.json();
        const groups = data?.response?.groups ?? data?.groups;
        const quotaGroups = Array.isArray(groups) ? groups.map(g => ({
          displayName: g.displayName || g.label || '',
          buckets: Array.isArray(g.buckets) ? g.buckets : [],
        })) : [];
        let cloudPaygo = false;
        if (quotaGroups.length === 0) {
          try {
            const st = await call('GetUserStatus');
            if (st.ok) cloudPaygo = (await st.json())?.userStatus?.userTier?.id === 'agy-business-paygo-tier';
          } catch {}
        }
        cachedQuota = { quotaGroups, cloudPaygo };
        lastQuotaAt = Date.now();
      }
    } catch {}
    return cachedQuota;
  })();
  try { return await quotaInFlight; }
  finally { quotaInFlight = null; }
}

export const EMPTY_DATA = Object.freeze({
  session: {
    turnsCount: 0,
    stepsCount: 0,
    mainStepsCount: 0,
    subagentStepsCount: 0,
    compactionsCount: 0,
    subagentCount: 0,
    modelSec: 0,
    toolSec: 0,
    avgTtftSec: null,
    tps: null,
    model: '',
    modelId: '',
    models: [],
    modelBreakdown: [],
    isStreaming: false,
  },
  tokens: { total: 0, mainTotal: 0, subagentTotal: 0, uncached: 0, cached: 0, output: 0, thinking: 0, cacheHitPct: null },
  context: { usedTokens: 0, maxTokens: 0, usedPct: 0, categories: [], breakdownTotal: 0 },
  subagents: [],
  turns: [],
});

/**
 * Resolves telemetry per target while keeping sidebar queries isolated from
 * unfocused or empty browser pages in multi-window sessions.
 */
export function createTelemetryController({
  convDir = CONV_DIR,
  readSnapshot = (p) => snapshotCache.read(p),
  resolveLatest = (d) => resolveLatestConversationId(d),
  getQuota = fetchQuota,
  readSettings = () => settingsStore.read(),
} = {}) {
  let lastDeckConvId = '';

  return async function getTelemetry(convId, opts = false) {
    const exact = typeof opts === 'boolean' ? opts : Boolean(opts?.exact);
    const focused = typeof opts === 'object' && opts !== null ? Boolean(opts.focused) : false;
    const safeId = typeof convId === 'string' && /^[0-9a-zA-Z_-]+$/.test(convId) ? convId : '';

    let targetId = '';
    if (exact) {
      if (safeId && (focused || !lastDeckConvId)) lastDeckConvId = safeId;
      targetId = safeId;
    } else if (safeId && existsSync(join(convDir, `${safeId}.db`))) {
      targetId = safeId;
    } else if (lastDeckConvId && existsSync(join(convDir, `${lastDeckConvId}.db`))) {
      targetId = lastDeckConvId;
    } else {
      targetId = resolveLatest(convDir);
    }

    const dbPath = targetId ? join(convDir, `${targetId}.db`) : '';
    const data = dbPath && existsSync(dbPath) ? (readSnapshot(dbPath) || EMPTY_DATA) : EMPTY_DATA;
    const quota = await getQuota();
    return {
      conversationId: targetId,
      ...data,
      ...quota,
      prefs: readSettings(),
    };
  };
}

const getTelemetry = createTelemetryController();

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) installEpipeGuard();

let injector = null;
if (isMain && process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const { SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();
  const sidebarHtml = renderSidebarHtml();
  app.page('/', () => sidebarHtml);
  app.api('/api/telemetry', async (data) => ({
    ...await getTelemetry(data?.conversationId || app.config.conversationId, false),
    cdp: injector?.status?.() || { cdpState: 'unknown', matchedTurnFooters: 0 },
  }), 'GET');
  app.api('/api/usage-stats', async (data) => ({
    ...await usageStatsCollector.readStats({ forceRefresh: Boolean(data?.force === '1' || data?.force === true) }),
    prefs: settingsStore.read(),
  }), 'GET');
  app.api('/api/settings', () => settingsStore.read(), 'GET');
  app.api('/api/settings', (data) => settingsStore.update(data), 'POST');
  app.run();
}

if (isMain && (process.env.ANTIGRAVITY_LS_ADDRESS || process.env.ANTIGRAVITY_SIDECAR_WEB_PORT)) {
  injector = startMonitorInjector(getTelemetry);
  let stopping = false;
  const shutdown = async (reason) => {
    if (stopping) return;
    stopping = true;
    stopWatch();
    console.log('[agy-monitor] stopping:', reason);
    try { await Promise.allSettled([injector.stop(), usageStatsCollector.close()]); }
    finally { process.exit(0); }
  };
  const stopWatch = startSelfReloadWatcher(dirname(fileURLToPath(import.meta.url)), () => void shutdown('files changed'));
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => void shutdown(sig));
}

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { parsePbMap, parseTimestampMs } from './pb.mjs';
import { isTransientSqliteLockError, parseGenRow, stampDb } from './telemetry.mjs';

const CACHE_VERSION = 2;
const STEP_TS_FIELDS = new Set([1, 7, 8]);

export const TOKEN_TYPE_COLORS = Object.freeze({
  cached: '#3b82f6',
  uncached: '#f59e0b',
  thinking: '#a855f7',
  reply: '#10b981',
});

export const MODEL_COLOR_FAMILIES = Object.freeze({
  claude: ['#d97757', '#e8956a', '#c25b3a', '#f2b890'],
  flash: ['#38bdf8', '#06b6d4', '#0ea5e9', '#22d3ee'],
  gemini: ['#4f86f7', '#6366f1', '#818cf8', '#3b82f6', '#7c3aed', '#60a5fa'],
  orchestrator: ['#a855f7', '#c084fc', '#9333ea'],
  gpt: ['#10b981', '#14b8a6', '#34d399', '#059669', '#2dd4bf'],
  other: ['#f59e0b', '#ec4899', '#84cc16', '#f43f5e', '#eab308'],
});

export function getModelFamily(modelName) {
  const s = String(modelName || '').trim();
  if (/claude|opus|sonnet|haiku/i.test(s)) return 'claude';
  if (/gpt|codex|\bo[134]\b|openai/i.test(s)) return 'gpt';
  if (/(gemini|gemma).*(flash|lite)|\bflash\b/i.test(s)) return 'flash';
  if (/gemini|hydrogen|carbon|neon|argon|ultra|pro/i.test(s)) return 'gemini';
  if (/orchestrator/i.test(s)) return 'orchestrator';
  return 'other';
}

export function assignModelColors(modelItems) {
  const sorted = [...(modelItems || [])].map(item => (
    typeof item === 'string' ? { name: item, total: 0 } : { name: item.name || item.model || '', total: Number(item.total) || 0 }
  )).filter(x => x.name).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const used = new Set();
  const colors = {};
  for (const { name } of sorted) {
    if (colors[name]) continue;
    const family = getModelFamily(name);
    const candidates = [...MODEL_COLOR_FAMILIES[family], ...MODEL_COLOR_FAMILIES.other];
    let picked = candidates.find(c => !used.has(c));
    if (!picked) {
      const pool = MODEL_COLOR_FAMILIES[family];
      picked = pool[Object.keys(colors).length % pool.length];
    }
    used.add(picked);
    colors[name] = picked;
  }
  return colors;
}

export function getModelRate(modelName) {
  const s = String(modelName || '').trim();
  if (/claude.*opus|\bopus\b/i.test(s)) return { uncached: 5.0, cached: 0.5, output: 25.0 };
  if (/claude.*haiku|\bhaiku\b/i.test(s)) return { uncached: 1.0, cached: 0.1, output: 5.0 };
  if (/claude|sonnet/i.test(s)) return { uncached: 3.0, cached: 0.3, output: 15.0 };
  if (/flash|lite/i.test(s)) return { uncached: 0.3, cached: 0.03, output: 2.5 };
  if (/\bo[134]\b/i.test(s) && !/gemini|hydrogen|carbon|neon|argon/i.test(s)) return { uncached: 2.0, cached: 0.5, output: 8.0 };
  if (/gpt|codex|openai/i.test(s)) return { uncached: 2.0, cached: 0.2, output: 14.0 };
  if (/gemini|hydrogen|carbon|neon|argon|orchestrator/i.test(s)) return { uncached: 2.0, cached: 0.2, output: 12.0 };
  return { uncached: 2.0, cached: 0.2, output: 10.0 };
}

export function estimateModelCost(modelName, uncached, cached, output) {
  const r = getModelRate(modelName);
  const u = Math.max(0, Number(uncached) || 0);
  const c = Math.max(0, Number(cached) || 0);
  const o = Math.max(0, Number(output) || 0);
  const actualUsd = (u * r.uncached + c * r.cached + o * r.output) / 1e6;
  const noCacheUsd = ((u + c) * r.uncached + o * r.output) / 1e6;
  return {
    actualUsd,
    savedUsd: Math.max(0, noCacheUsd - actualUsd),
  };
}

export function formatLocalYmd(ms) {
  const dt = new Date(ms);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getLocalTzSignature(ms = Date.now()) {
  const dt = new Date(ms);
  const off = -dt.getTimezoneOffset();
  const envTz = process.env.TZ || '';
  let iana = '';
  try { iana = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch {}
  return `off=${off}|tz=${envTz}|iana=${iana}`;
}

function addLocalDaysYmd(ymd, deltaDays) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + deltaDays);
  return formatLocalYmd(dt.getTime());
}

function pruneHoursMap(hoursObj, keepSinceYmd) {
  const out = {};
  for (const [hk, val] of Object.entries(hoursObj || {})) {
    const sep = hk.indexOf('|');
    const ymd = sep >= 0 ? hk.slice(0, sep) : hk;
    if (ymd >= keepSinceYmd) out[hk] = val;
  }
  return out;
}

export function getClientUsageHelpersScript() {
  return [
    `const TOKEN_TYPE_COLORS = ${JSON.stringify(TOKEN_TYPE_COLORS)};`,
    `const MODEL_COLOR_FAMILIES = ${JSON.stringify(MODEL_COLOR_FAMILIES)};`,
    getModelFamily.toString(),
    assignModelColors.toString(),
    getModelRate.toString(),
    estimateModelCost.toString(),
  ].join('\n');
}

function emptyModelStat() {
  return {
    uncached: 0,
    cached: 0,
    thinking: 0,
    reply: 0,
    output: 0,
    total: 0,
    reqs: 0,
    modelSec: 0,
    ttftSum: 0,
    ttftCount: 0,
    timedOutput: 0,
    timedModelSec: 0,
  };
}

function accumulateModelStat(targetMap, modelName, gen) {
  let cur = Object.hasOwn(targetMap, modelName) ? targetMap[modelName] : null;
  if (!cur) {
    cur = emptyModelStat();
    Object.defineProperty(targetMap, modelName, { value: cur, enumerable: true, writable: true, configurable: true });
  }
  cur.uncached += gen.uncached;
  cur.cached += gen.cached;
  cur.thinking += gen.thinking;
  cur.reply += gen.reply;
  cur.output += gen.output;
  cur.total += gen.total;
  cur.reqs += gen.reqs;
  cur.modelSec += gen.modelSec;
  cur.ttftSum += gen.ttftSum;
  cur.ttftCount += gen.ttftCount;
  cur.timedOutput += gen.timedOutput;
  cur.timedModelSec += gen.timedModelSec;
}

function scanDbForUsage(dbPath) {
  const fallbackMs = statSync(dbPath).mtimeMs;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let stepRows = [];
  let genRows = [];
  try {
    let inTx = false;
    try {
      db.exec('BEGIN DEFERRED');
      inTx = true;
      const tables = new Set(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('steps','gen_metadata')").all().map(r => r.name)
      );
      if (!tables.has('gen_metadata')) {
        db.exec('COMMIT');
        return { days: {}, hours: {} };
      }
      if (tables.has('steps')) {
        stepRows = db.prepare('SELECT idx, metadata FROM steps ORDER BY idx ASC').all();
      }
      genRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
      db.exec('COMMIT');
      inTx = false;
    } catch (err) {
      if (inTx) {
        try { db.exec('ROLLBACK'); } catch {}
      }
      throw err;
    }
  } finally {
    db.close();
  }

  const stepTs = new Map();
  for (const s of stepRows) {
    if (!s.metadata) continue;
    const f = parsePbMap(Buffer.from(s.metadata), STEP_TS_FIELDS);
    const tsMs = parseTimestampMs(f.get(1)?.[0]) || parseTimestampMs(f.get(8)?.[0]) || parseTimestampMs(f.get(7)?.[0]);
    if (Number.isFinite(tsMs) && tsMs > 0) stepTs.set(s.idx, tsMs);
  }

  const days = {};
  const hours = {};
  for (const r of genRows) {
    const pg = parseGenRow(r.idx, r.data);
    if (!pg) continue;
    const uncached = pg.uncached || 0;
    const cached = pg.cached || 0;
    const output = pg.output || 0;
    const total = uncached + cached + output;
    if (total <= 0) continue;

    const thinking = Math.min(output, pg.thinking || 0);
    const reply = Math.max(0, output - thinking);
    const hasTtft = pg.ttft !== null && pg.ttft >= 0;
    const hasStream = pg.streaming !== null && pg.streaming >= 0;
    const dur = (hasTtft ? pg.ttft : 0) + (hasStream ? pg.streaming : 0);
    const modelSec = dur > 0 ? dur : 0;
    const timedOut = hasStream && pg.streaming > 0 && dur > 0 ? (pg.latestOutput || output) : 0;
    const timedSec = timedOut > 0 ? dur : 0;
    const modelName = String(pg.model || pg.modelId || 'Unknown').trim() || 'Unknown';

    let tsMs = 0;
    for (const si of pg.stepIndices) {
      if (stepTs.has(si)) {
        tsMs = stepTs.get(si);
        break;
      }
    }
    if (!tsMs && pg.lastStepIndex >= 0 && stepTs.has(pg.lastStepIndex)) {
      tsMs = stepTs.get(pg.lastStepIndex);
    }
    if (!tsMs) tsMs = fallbackMs;

    const dt = new Date(tsMs);
    const ymd = formatLocalYmd(tsMs);
    const hourKey = `${ymd}|${dt.getHours()}`;

    const entry = {
      uncached,
      cached,
      thinking,
      reply,
      output,
      total,
      reqs: 1,
      modelSec,
      ttftSum: hasTtft ? pg.ttft : 0,
      ttftCount: hasTtft ? 1 : 0,
      timedOutput: timedOut,
      timedModelSec: timedSec,
    };

    if (!days[ymd]) days[ymd] = {};
    accumulateModelStat(days[ymd], modelName, entry);

    if (!hours[hourKey]) hours[hourKey] = {};
    accumulateModelStat(hours[hourKey], modelName, entry);
  }
  return { days, hours };
}

function makeEmptyBucket() {
  return {
    uncached: 0,
    cached: 0,
    thinking: 0,
    reply: 0,
    output: 0,
    total: 0,
    reqs: 0,
    modelSec: 0,
    ttftSum: 0,
    ttftCount: 0,
    timedOutput: 0,
    timedModelSec: 0,
    byModel: {},
  };
}

function mergeBucketModels(bucket, modelMap) {
  for (const [modelName, st] of Object.entries(modelMap)) {
    bucket.uncached += st.uncached;
    bucket.cached += st.cached;
    bucket.thinking += st.thinking;
    bucket.reply += st.reply;
    bucket.output += st.output;
    bucket.total += st.total;
    bucket.reqs += st.reqs;
    bucket.modelSec += st.modelSec;
    bucket.ttftSum += st.ttftSum;
    bucket.ttftCount += st.ttftCount;
    bucket.timedOutput += st.timedOutput;
    bucket.timedModelSec += st.timedModelSec;
    accumulateModelStat(bucket.byModel, modelName, st);
  }
}

export function createUsageStatsCollector({
  convDir = join(homedir(), '.gemini', 'antigravity', 'conversations'),
  cacheFile = join(homedir(), '.gemini', 'config', 'agy-monitor', 'usage-stats-cache.json'),
} = {}) {
  let cache = { version: CACHE_VERSION, tz: '', files: {} };
  let loaded = false;

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (raw?.version === CACHE_VERSION && raw.files && typeof raw.files === 'object') {
        cache = { version: CACHE_VERSION, tz: typeof raw.tz === 'string' ? raw.tz : '', files: raw.files };
      }
    } catch {}
  }

  function persist() {
    let tmp = '';
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      tmp = `${cacheFile}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(cache), 'utf8');
      renameSync(tmp, cacheFile);
      tmp = '';
    } catch {
      if (tmp) {
        try { unlinkSync(tmp); } catch {}
      }
    }
  }

  function readStats({ nowMs = Date.now(), forceRefresh = false } = {}) {
    ensureLoaded();
    const todayYmd = formatLocalYmd(nowMs);
    const keepSinceYmd = addLocalDaysYmd(todayYmd, -7);
    const tzSig = getLocalTzSignature(nowMs);
    let dirty = false;

    if (cache.tz !== tzSig) {
      const hadTz = Boolean(cache.tz);
      if (!hadTz || Object.keys(cache.files).length > 0) dirty = true;
      cache = { version: CACHE_VERSION, tz: tzSig, files: {} };
    }

    if (!existsSync(convDir)) {
      if (dirty) persist();
      return {
        version: CACHE_VERSION,
        generatedAtMs: nowMs,
        todayYmd,
        dbCount: 0,
        days: {},
        todayHours: Array.from({ length: 24 }, (_, hour) => ({ hour, ...makeEmptyBucket() })),
      };
    }

    const dbFiles = readdirSync(convDir).filter(f => f.endsWith('.db'));
    const present = new Set(dbFiles);

    for (const key of Object.keys(cache.files)) {
      if (!present.has(key)) {
        delete cache.files[key];
        dirty = true;
      }
    }

    for (const file of dbFiles) {
      const fullPath = join(convDir, file);
      const stamp = stampDb(fullPath);
      if (!stamp) continue;
      const prev = cache.files[file];
      if (!forceRefresh && prev && prev.stamp === stamp) continue;

      try {
        const scanned = scanDbForUsage(fullPath);
        cache.files[file] = {
          stamp,
          days: scanned.days,
          hours: pruneHoursMap(scanned.hours, keepSinceYmd),
        };
        dirty = true;
      } catch (err) {
        if (isTransientSqliteLockError(err)) {
          // Keep last valid snapshot if database is temporarily locked by writer
        } else if (!prev) {
          cache.files[file] = { stamp, days: {}, hours: {} };
        }
      }
    }

    if (dirty) persist();

    const days = {};
    const todayHours = Array.from({ length: 24 }, (_, hour) => ({ hour, ...makeEmptyBucket() }));
    const todayPrefix = `${todayYmd}|`;

    for (const file of dbFiles) {
      const entry = cache.files[file];
      if (!entry) continue;
      for (const [ymd, modelMap] of Object.entries(entry.days || {})) {
        if (!days[ymd]) days[ymd] = makeEmptyBucket();
        mergeBucketModels(days[ymd], modelMap);
      }
      for (const [hk, modelMap] of Object.entries(entry.hours || {})) {
        if (!hk.startsWith(todayPrefix)) continue;
        const hr = Number(hk.slice(todayPrefix.length));
        if (hr >= 0 && hr < 24) {
          mergeBucketModels(todayHours[hr], modelMap);
        }
      }
    }

    return {
      version: CACHE_VERSION,
      generatedAtMs: nowMs,
      todayYmd,
      dbCount: dbFiles.length,
      days,
      todayHours,
    };
  }

  return { readStats };
}

export function createAsyncUsageStatsCollector({
  convDir = join(homedir(), '.gemini', 'antigravity', 'conversations'),
  cacheFile = join(homedir(), '.gemini', 'config', 'agy-monitor', 'usage-stats-cache.json'),
  staleMs = 5000,
} = {}) {
  let lastSnapshot = null;
  let lastFreshAt = 0;
  let lastTz = '';
  let worker = null;
  let nextId = 1;
  const pending = new Map();
  let inFlight = null;
  let closed = false;
  let syncFallback = null;

  function ensureWorker() {
    if (worker) return worker;
    const w = new Worker(new URL('./usage_stats_worker.mjs', import.meta.url), {
      workerData: { convDir, cacheFile },
    });
    w.on('message', (msg) => {
      const cb = pending.get(msg?.id);
      if (!cb) return;
      pending.delete(msg.id);
      if (msg.ok) cb.resolve(msg.data);
      else cb.reject(new Error(msg.error || 'usage_stats worker failed'));
    });
    const onFail = (err) => {
      if (worker === w) worker = null;
      for (const [id, cb] of pending) {
        pending.delete(id);
        cb.reject(err instanceof Error ? err : new Error(String(err || 'worker exited')));
      }
    };
    w.on('error', onFail);
    w.on('exit', (code) => {
      if (worker === w) worker = null;
      if (pending.size > 0) onFail(new Error(`usage_stats worker exited (${code})`));
    });
    worker = w;
    return w;
  }

  function runWorkerScan({ nowMs, forceRefresh }) {
    if (inFlight && !forceRefresh) return inFlight;
    const job = (async () => {
      let data;
      try {
        const w = ensureWorker();
        const id = nextId++;
        data = await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          w.postMessage({ id, nowMs, forceRefresh });
        });
      } catch (err) {
        if (closed) throw err;
        // Graceful fallback only if worker cannot be spawned in host environment
        if (!syncFallback) syncFallback = createUsageStatsCollector({ convDir, cacheFile });
        data = syncFallback.readStats({ nowMs, forceRefresh });
      }
      lastSnapshot = data;
      lastFreshAt = Date.now();
      lastTz = getLocalTzSignature(nowMs);
      return data;
    })();
    inFlight = job.finally(() => {
      if (inFlight === job) inFlight = null;
    });
    return job;
  }

  async function readStats({ nowMs = Date.now(), forceRefresh = false } = {}) {
    const todayYmd = formatLocalYmd(nowMs);
    const tzSig = getLocalTzSignature(nowMs);
    if (!forceRefresh && lastSnapshot && lastSnapshot.todayYmd === todayYmd && lastTz === tzSig) {
      if (Date.now() - lastFreshAt >= staleMs) {
        void runWorkerScan({ nowMs, forceRefresh: false }).catch(() => {});
      }
      return lastSnapshot;
    }
    return runWorkerScan({ nowMs, forceRefresh });
  }

  async function close() {
    closed = true;
    for (const [id, cb] of pending) {
      pending.delete(id);
      cb.reject(new Error('collector closed'));
    }
    const w = worker;
    worker = null;
    if (w) {
      try { await w.terminate(); } catch {}
    }
  }

  return { readStats, close };
}

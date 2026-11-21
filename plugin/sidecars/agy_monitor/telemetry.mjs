import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseDurationSec, parsePbMap, parseTimestampMs, readVarint } from './pb.mjs';

const ACTIVE_STATUSES = new Set([1, 2, 8, 9, 11]);
const NON_TOOL_STEPS = new Set([14, 15, 17, 23, 101]);
const SUBAGENT_TOOLS = new Set(['invoke_subagent', 'swarm', 'run_workflow']);
const MAX_SUBAGENT_DEPTH = 4;
const SAFE_ID_RE = /^[0-9a-zA-Z_-]+$/;
const UUID_GLOBAL_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const CATEGORY_STYLES = {
  0: { key: 'unspecified', zh: '其他', en: 'Unspecified', color: '#94a3b8' },
  1: { key: 'system', zh: '系统提示词', en: 'System Prompt', color: '#38bdf8' },
  2: { key: 'tools', zh: '工具定义', en: 'Tools', color: '#a78bfa' },
  3: { key: 'rules', zh: 'Rules', en: 'Rules', color: '#14b8a6' },
  4: { key: 'mcp', zh: 'Mcp Tools', en: 'Mcp Tools', color: '#fb923c' },
  5: { key: 'skills', zh: 'Skills', en: 'Skills', color: '#22c55e' },
  6: { key: 'subagents', zh: 'Subagents', en: 'Subagents', color: '#f472b6' },
  7: { key: 'messages', zh: '对话消息', en: 'Chat Messages', color: '#3b82f6' },
  8: { key: 'memory', zh: '记忆', en: 'Memory', color: '#84cc16' },
  9: { key: 'plugins', zh: 'Plugins', en: 'Plugins', color: '#eab308' },
};

const FALLBACK_CATEGORY_COLORS = ['#06b6d4', '#f472b6', '#22c55e', '#eab308', '#fb923c', '#14b8a6', '#84cc16', '#38bdf8'];

function fileStamp(path) {
  try {
    const s = statSync(path, { bigint: true });
    return { size: s.size, key: `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` };
  } catch {
    return null;
  }
}

function stampDb(path) {
  const db = fileStamp(path);
  if (!db || db.size === 0n) return null;
  const wal = fileStamp(`${path}-wal`);
  return `${db.key}|${wal && wal.size > 0n ? wal.key : 'no-wal'}`;
}

export function createSnapshotCache(reader) {
  const cache = new Map();
  const stampDeps = (deps) => deps.map(d => stampDb(d) || 'missing').join('||');
  return {
    read(path) {
      const primary = stampDb(path);
      if (!primary) {
        cache.delete(path);
        return null;
      }
      const hit = cache.get(path);
      if (hit && hit.primary === primary && (!hit.deps.length || stampDeps(hit.deps) === hit.depsKey)) {
        return hit.value;
      }
      const depSet = new Set();
      const trackDep = (depPath) => {
        if (depPath && depPath !== path) depSet.add(depPath);
      };
      try {
        const value = reader(path, trackDep);
        const deps = [...depSet];
        cache.delete(path);
        cache.set(path, {
          primary,
          deps,
          depsKey: deps.length ? stampDeps(deps) : '',
          value,
        });
        if (cache.size > 12) cache.delete(cache.keys().next().value);
        return value;
      } catch {
        return hit?.value ?? null;
      }
    },
  };
}

function readUsageFields(fields, confirmedZero = false) {
  const reported = confirmedZero || [2, 3, 5, 9, 10].some(k => fields.has(k));
  const val = k => fields.get(k)?.[0] || 0;
  const uncached = reported ? val(2) : 0;
  const cached = reported ? val(5) : 0;
  const totOut = val(3);
  const think = val(9);
  const reply = val(10);
  const output = reported ? (totOut || (think + reply)) : 0;
  return { reported, uncached, cached, output, think, reply };
}

export function parseGenRow(idx, rawData) {
  const data = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData || []);
  const top = parsePbMap(data);
  if (!top.has(1)) return null;

  const stepIndices = [];
  for (const val of top.get(2) || []) {
    if (typeof val === 'number') {
      stepIndices.push(val);
    } else {
      for (let off = 0; off < val.length;) {
        const [n, nextOff] = readVarint(val, off);
        stepIndices.push(n);
        off = nextOff;
      }
    }
  }

  const m1 = parsePbMap(top.get(1)[0]);
  const usageMap = parsePbMap(m1.get(4)?.[0] || Buffer.alloc(0));
  const mainUsage = readUsageFields(usageMap, false);
  const ttft = parseDurationSec(m1.get(11)?.[0]);
  const streaming = parseDurationSec(m1.get(12)?.[0]);
  const hasOutput = m1.has(4) && (usageMap.has(3) || (ttft !== null && streaming !== null));

  // Sum attempts cleanly if retries recorded token usage separately.
  const retries = m1.get(17) || [];
  let sumUncached = 0;
  let sumCached = 0;
  let sumOutput = 0;
  let sumThink = 0;
  if (retries.length > 0) {
    for (let i = 0; i < retries.length; i++) {
      const info = parsePbMap(retries[i]);
      const counters = parsePbMap(info.get(2)?.[0] || Buffer.alloc(0));
      const finalSuccess = i === retries.length - 1 && !info.get(3)?.[0]?.length && hasOutput;
      const hasRetryCounters = [2, 3, 5, 9, 10].some(k => counters.has(k));
      const u = readUsageFields(finalSuccess && !hasRetryCounters ? usageMap : counters, finalSuccess);
      sumUncached += u.uncached;
      sumCached += u.cached;
      sumOutput += u.output;
      sumThink += u.think;
    }
  } else if (mainUsage.reported || hasOutput) {
    sumUncached = mainUsage.uncached;
    sumCached = mainUsage.cached;
    sumOutput = mainUsage.output;
    sumThink = mainUsage.think;
  }

  let maxContextTokens = 0;
  let breakdown = null;
  if (m1.has(9)) {
    const m9 = parsePbMap(m1.get(9)[0]);
    if (m9.has(10)) {
      const m10 = parsePbMap(m9.get(10)[0]);
      if (m10.has(4)) maxContextTokens = m10.get(4)[0] || 0;
      if (m10.has(3)) {
        const m10_3 = parsePbMap(m10.get(3)[0]);
        const items = (m10_3.get(1) || []).map(buf => {
          const s = parsePbMap(buf);
          const id = s.get(2)?.[0] || 0;
          const rawLabel = s.get(1)?.[0]?.toString('utf8') || '';
          const tokens = s.get(4)?.[0] || 0;
          const style = CATEGORY_STYLES[id] || {
            key: `cat_${id}`,
            zh: rawLabel || `分类 ${id}`,
            en: rawLabel || `Category ${id}`,
            color: FALLBACK_CATEGORY_COLORS[Math.abs(id) % FALLBACK_CATEGORY_COLORS.length],
          };
          return { id, key: style.key, zh: style.zh, en: style.en, color: style.color, tokens };
        }).filter(item => item.tokens > 0);
        if (items.length > 0) {
          breakdown = { total: m10_3.get(2)?.[0] || items.reduce((a, b) => a + b.tokens, 0), items };
        }
      }
    }
  }

  let lastStepIndex = -1;
  if (m1.has(20)) {
    for (const kvBuf of m1.get(20)) {
      const kv = parsePbMap(kvBuf);
      const k = kv.get(1)?.[0]?.toString('utf8') || '';
      if (k === 'last_step_index' && kv.has(2)) {
        const n = Number(kv.get(2)[0].toString('utf8'));
        if (Number.isFinite(n)) lastStepIndex = n;
        break;
      }
    }
  }

  const model = m1.get(21)?.[0]?.toString('utf8') || '';
  const modelId = m1.get(19)?.[0]?.toString('utf8') || '';

  return {
    idx,
    stepIndices,
    lastStepIndex,
    contextTokens: mainUsage.uncached + mainUsage.cached,
    latestUncached: mainUsage.uncached,
    latestCached: mainUsage.cached,
    uncached: sumUncached,
    cached: sumCached,
    output: sumOutput,
    thinking: sumThink,
    latestOutput: mainUsage.output,
    ttft,
    streaming,
    maxContextTokens,
    breakdown,
    model,
    modelId,
  };
}

export function mergeIntervalsSec(intervals) {
  if (!intervals.length) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const [start, end] = sorted[i];
    const prev = merged[merged.length - 1];
    if (start <= prev[1]) prev[1] = Math.max(prev[1], end);
    else merged.push([start, end]);
  }
  return merged.reduce((sum, [a, b]) => sum + (b - a) / 1000, 0);
}

function extractToolName(metaMap) {
  const f4 = metaMap.get(4)?.[0];
  if (!f4) return '';
  return parsePbMap(f4).get(2)?.[0]?.toString('utf8') || '';
}

function addGenToModelMap(map, g) {
  const label = String(g.model || g.modelId || '').trim();
  const id = String(g.modelId || '').trim();
  if (!label && !id) return;
  const key = label || id;
  let cur = map.get(key);
  if (!cur) {
    cur = {
      model: label || id,
      modelId: id,
      reqCount: 0,
      uncached: 0,
      cached: 0,
      output: 0,
      thinking: 0,
      modelSec: 0,
      _ttftSum: 0,
      _ttftCount: 0,
      _timedOutput: 0,
      _timedModelSec: 0,
    };
    map.set(key, cur);
  } else if (!cur.modelId && id) {
    cur.modelId = id;
  }
  cur.reqCount += 1;
  cur.uncached += g.uncached;
  cur.cached += g.cached;
  cur.output += g.output;
  cur.thinking += g.thinking;
  if (g.ttft !== null && g.ttft >= 0) {
    cur._ttftSum += g.ttft;
    cur._ttftCount += 1;
  }
  if (g.ttft !== null && g.streaming !== null) {
    const dur = g.ttft + g.streaming;
    if (dur >= 0) {
      cur.modelSec += dur;
      if (g.latestOutput > 0 && dur > 0) {
        cur._timedOutput += g.latestOutput;
        cur._timedModelSec += dur;
      }
    }
  }
}

function mergeModelMaps(targetMap, srcMap) {
  if (!srcMap) return;
  for (const [key, item] of srcMap.entries()) {
    const cur = targetMap.get(key);
    if (!cur) {
      targetMap.set(key, { ...item });
    } else {
      cur.reqCount += item.reqCount;
      cur.uncached += item.uncached;
      cur.cached += item.cached;
      cur.output += item.output;
      cur.thinking += item.thinking;
      cur.modelSec += item.modelSec;
      cur._ttftSum += item._ttftSum;
      cur._ttftCount += item._ttftCount;
      cur._timedOutput += item._timedOutput;
      cur._timedModelSec += item._timedModelSec;
      if (!cur.modelId && item.modelId) cur.modelId = item.modelId;
    }
  }
}

function cloneModelMap(srcMap) {
  const copy = new Map();
  for (const [k, v] of srcMap.entries()) {
    copy.set(k, { ...v });
  }
  return copy;
}

function finalizeModelBreakdown(map) {
  return [...map.values()].map(item => {
    const total = item.uncached + item.cached + item.output;
    const promptIn = item.uncached + item.cached;
    return {
      model: item.model,
      modelId: item.modelId,
      reqCount: item.reqCount,
      total,
      tokens: total,
      uncached: item.uncached,
      cached: item.cached,
      output: item.output,
      thinking: item.thinking,
      cacheHitPct: promptIn > 0 ? (item.cached / promptIn) * 100 : null,
      modelSec: item.modelSec,
      avgTtftSec: item._ttftCount > 0 ? item._ttftSum / item._ttftCount : null,
      tps: item._timedModelSec > 0 ? item._timedOutput / item._timedModelSec : null,
    };
  });
}

function extractInvokeSubagentRefs(payloadBuf, selfIds, convDir, launchedAtStep) {
  const top = parsePbMap(payloadBuf);
  const f140Buf = top.get(140)?.[0];
  if (!f140Buf) return [];
  const f140 = parsePbMap(f140Buf);
  const refs = [];
  for (const v2 of f140.get(2) || []) {
    for (const v3 of parsePbMap(v2).get(3) || []) {
      for (const v9 of parsePbMap(v3).get(9) || []) {
        for (const v5 of parsePbMap(v9).get(5) || []) {
          const m5 = parsePbMap(v5);
          const id = (m5.get(1)?.[0]?.toString('utf8') || '').trim();
          if (!id || !SAFE_ID_RE.test(id) || selfIds.has(id)) continue;
          const role = (m5.get(2)?.[0]?.toString('utf8') || '').trim();
          const type = (m5.get(3)?.[0]?.toString('utf8') || '').trim();
          refs.push({ id, role, type, launchedAtStep });
        }
      }
    }
  }
  if (refs.length === 0) {
    const text = f140Buf.toString('utf8');
    const seen = new Set();
    for (const m of text.matchAll(UUID_GLOBAL_RE)) {
      const uuid = m[0];
      if (selfIds.has(uuid) || seen.has(uuid)) continue;
      seen.add(uuid);
      if (existsSync(join(convDir, `${uuid}.db`))) {
        refs.push({ id: uuid, role: '', type: '', launchedAtStep });
      }
    }
  }
  return refs;
}

function extractCompactionSubagentRefs(payloadBuf, selfIds) {
  const top = parsePbMap(payloadBuf);
  const f30Buf = top.get(30)?.[0];
  if (!f30Buf) return [];
  const f30 = parsePbMap(f30Buf);
  const refs = [];
  for (const entryBuf of f30.get(20) || []) {
    const entry = parsePbMap(entryBuf);
    const f4 = entry.get(4)?.[0] ? parsePbMap(entry.get(4)[0]) : null;
    const f5 = entry.get(5)?.[0] ? parsePbMap(entry.get(5)[0]) : null;
    const id = (f5?.get(1)?.[0]?.toString('utf8') || '').trim();
    if (!id || !SAFE_ID_RE.test(id) || selfIds.has(id)) continue;
    const type = (f4?.get(1)?.[0]?.toString('utf8') || '').trim();
    const role = (f4?.get(2)?.[0]?.toString('utf8') || '').trim();
    refs.push({ id, role, type, launchedAtStep: -1 });
  }
  return refs;
}

function readDbSnapshot(dbPath, { convDir, visited, includeTurns = false } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let genRows = [];
  let stepRows = [];
  let execRows = [];
  let payloadRows = [];
  const selfIds = new Set([basename(dbPath, '.db')]);
  const hasPayloadSubMap = [];
  let parsedSteps = [];
  try {
    genRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    stepRows = db.prepare('SELECT idx, step_type, status, metadata FROM steps ORDER BY idx ASC').all();
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='executor_metadata'").get()) {
      execRows = db.prepare('SELECT idx, data FROM executor_metadata ORDER BY idx ASC').all();
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='trajectory_meta'").get()) {
      for (const tm of db.prepare('SELECT trajectory_id, cascade_id FROM trajectory_meta').all()) {
        if (tm.trajectory_id) selfIds.add(String(tm.trajectory_id));
        if (tm.cascade_id) selfIds.add(String(tm.cascade_id));
      }
    }
    for (const id of selfIds) visited?.add(id);

    const hasStepPayload = db.prepare('PRAGMA table_info(steps)').all().some(c => c.name === 'step_payload');
    const subagentStepIdxs = [];
    let latestCompactionIdx = -1;

    parsedSteps = stepRows.map(s => {
      const f = parsePbMap(Buffer.from(s.metadata || []));
      const createdAtMs = parseTimestampMs(f.get(1)?.[0]);
      const completedAtMs = parseTimestampMs(f.get(8)?.[0]) || parseTimestampMs(f.get(7)?.[0]);
      const transitions = (parsePbMap(f.get(26)?.[0] || Buffer.alloc(0)).get(1) || []).map(parsePbMap);
      const terminalMs = transitions
        .filter(t => [3, 6, 7, 12].includes(t.get(1)?.[0]))
        .map(t => parseTimestampMs(t.get(2)?.[0]))
        .filter(Boolean);
      const endedAtMs = completedAtMs || (terminalMs.length ? Math.max(...terminalMs) : null);
      const toolName = s.step_type === 132 ? extractToolName(f) : '';
      if (SUBAGENT_TOOLS.has(toolName)) {
        subagentStepIdxs.push(s.idx);
      } else if (s.step_type === 23 && (s.status === 3 || s.status === 5)) {
        latestCompactionIdx = s.idx;
      }
      return {
        idx: s.idx,
        stepType: s.step_type,
        status: s.status,
        createdAtMs,
        endedAtMs,
        toolName,
      };
    });

    if (hasStepPayload) {
      const targetIdxs = [...subagentStepIdxs];
      if (latestCompactionIdx >= 0) targetIdxs.push(latestCompactionIdx);
      if (targetIdxs.length > 0) {
        const placeholders = targetIdxs.map(() => '?').join(',');
        payloadRows = db
          .prepare(`SELECT idx, step_type, step_payload FROM steps WHERE idx IN (${placeholders})`)
          .all(...targetIdxs);
        for (const r of payloadRows) {
          hasPayloadSubMap.push(r);
        }
      }
    }
  } finally {
    db.close();
  }

  const refMap = new Map();
  for (const r of hasPayloadSubMap) {
    if (!r.step_payload) continue;
    const buf = Buffer.from(r.step_payload);
    const refs = r.step_type === 23
      ? extractCompactionSubagentRefs(buf, selfIds)
      : extractInvokeSubagentRefs(buf, selfIds, convDir, r.idx);
    for (const ref of refs) {
      const prev = refMap.get(ref.id);
      if (!prev) {
        refMap.set(ref.id, ref);
      } else {
        if (prev.launchedAtStep < 0 && ref.launchedAtStep >= 0) prev.launchedAtStep = ref.launchedAtStep;
        if (!prev.role && ref.role) prev.role = ref.role;
        if (!prev.type && ref.type) prev.type = ref.type;
      }
    }
  }

  const executors = execRows.map(r => {
    const f = parsePbMap(Buffer.from(r.data || []));
    return {
      reason: f.get(1)?.[0] || 0,
      lastStepIndex: f.size ? (f.get(3)?.[0] ?? 0) : -1,
    };
  });

  const parsedGens = genRows.map(r => parseGenRow(r.idx, r.data)).filter(Boolean);
  const userSteps = parsedSteps.filter(s => s.stepType === 14 && s.status !== 11);
  const checkpointIdxs = parsedSteps.filter(s => s.stepType === 23).map(s => s.idx);
  const compactionsCount = parsedSteps.filter(s => s.stepType === 23 && (s.status === 3 || s.status === 5)).length;
  const isStreaming = parsedSteps.some(s => s.stepType !== 14 && ACTIVE_STATUSES.has(s.status));

  let uncached = 0;
  let cached = 0;
  let output = 0;
  let thinking = 0;
  let modelSec = 0;
  let timedOutput = 0;
  let timedModelSec = 0;
  let ttftSum = 0;
  let ttftCount = 0;
  let latestMaxContext = 0;
  let latestActiveContext = null;
  let latestBreakdown = null;
  let latestModel = '';
  let latestModelId = '';
  let prevContextTokens = 0;
  let lastCheckpointIdx = -1;
  const modelMap = new Map();

  for (const g of parsedGens) {
    uncached += g.uncached;
    cached += g.cached;
    output += g.output;
    thinking += g.thinking;
    addGenToModelMap(modelMap, g);

    if (g.ttft !== null && g.ttft >= 0) {
      ttftSum += g.ttft;
      ttftCount++;
    }
    if (g.ttft !== null && g.streaming !== null) {
      const dur = g.ttft + g.streaming;
      if (dur >= 0) {
        modelSec += dur;
        if (g.latestOutput > 0 && dur > 0) {
          timedOutput += g.latestOutput;
          timedModelSec += dur;
        }
      }
    }
    if (g.maxContextTokens > 0) latestMaxContext = g.maxContextTokens;

    const refIdx = g.stepIndices.length ? Math.max(...g.stepIndices) : g.lastStepIndex;
    const crossedCheckpoint = checkpointIdxs.findLast(cp => cp > lastCheckpointIdx && cp <= refIdx);
    const contextDropped = g.contextTokens > 0 && prevContextTokens > 0 && g.contextTokens < prevContextTokens * 0.7;
    if (crossedCheckpoint !== undefined || contextDropped) {
      if (crossedCheckpoint !== undefined) lastCheckpointIdx = crossedCheckpoint;
      latestBreakdown = null;
    }

    if (g.contextTokens > 0) {
      latestActiveContext = g;
      prevContextTokens = g.contextTokens;
    }
    if (g.breakdown) latestBreakdown = g.breakdown;
    if (g.model) latestModel = g.model;
    if (g.modelId) latestModelId = g.modelId;
  }

  const toolIntervals = [];
  for (const s of parsedSteps) {
    if (NON_TOOL_STEPS.has(s.stepType)) continue;
    if (s.createdAtMs && s.endedAtMs && s.endedAtMs >= s.createdAtMs) {
      toolIntervals.push([s.createdAtMs, s.endedAtMs]);
    }
  }

  let turns = [];
  if (includeTurns) {
    turns = userSteps.map((u, i) => {
      const startIdx = u.idx;
      const endIdx = i + 1 < userSteps.length ? userSteps[i + 1].idx - 1 : Infinity;
      const turnSteps = parsedSteps.filter(s => s.idx >= startIdx && s.idx <= endIdx);
      const hasActive = turnSteps.some(s => s.stepType !== 14 && ACTIVE_STATUSES.has(s.status));
      const plannerDoneSteps = turnSteps.filter(s => s.stepType === 15 && (s.status === 3 || s.status === 5));
      const hasExecutorDone = executors.some(ex => ex.lastStepIndex >= startIdx && ex.lastStepIndex <= endIdx && ![0, 7, 12].includes(ex.reason));
      const completed = !hasActive && (plannerDoneSteps.length > 0 || hasExecutorDone);
      const lastEnded = turnSteps.map(s => s.endedAtMs).filter(Boolean);
      const turnToolIntervals = [];
      for (const s of turnSteps) {
        if (NON_TOOL_STEPS.has(s.stepType)) continue;
        if (s.createdAtMs && s.endedAtMs && s.endedAtMs >= s.createdAtMs) {
          turnToolIntervals.push([s.createdAtMs, s.endedAtMs]);
        }
      }
      const turnCompactions = turnSteps.filter(s => s.stepType === 23 && (s.status === 3 || s.status === 5)).length;

      return {
        turnIndex: i,
        userStepIndex: startIdx,
        endStepIndex: endIdx,
        completed,
        hasReply: plannerDoneSteps.length > 0,
        uncached: 0,
        cached: 0,
        output: 0,
        total: 0,
        cacheHitPct: null,
        reqCount: 0,
        stepsCount: turnSteps.length,
        compactionsCount: turnCompactions,
        subagentCount: 0,
        subagentTokens: 0,
        subagentSteps: 0,
        subagents: [],
        modelSec: 0,
        toolSec: 0,
        avgTtftSec: null,
        tps: null,
        _toolIntervals: turnToolIntervals,
        _ttftSum: 0,
        _ttftCount: 0,
        _timedOutput: 0,
        _timedModelSec: 0,
        _modelMap: new Map(),
        model: '',
        modelId: '',
        models: [],
        modelBreakdown: [],
        endedAtMs: lastEnded.length ? Math.max(...lastEnded) : null,
      };
    });

    for (const g of parsedGens) {
      const refIdx = g.stepIndices.length ? Math.max(...g.stepIndices) : g.lastStepIndex;
      const turn = turns.findLast(t => t.userStepIndex <= refIdx) || turns[turns.length - 1];
      if (!turn) continue;
      turn.uncached += g.uncached;
      turn.cached += g.cached;
      turn.output += g.output;
      turn.reqCount++;
      addGenToModelMap(turn._modelMap, g);
      if (g.ttft !== null && g.ttft >= 0) {
        turn._ttftSum += g.ttft;
        turn._ttftCount++;
      }
      if (g.ttft !== null && g.streaming !== null) {
        const dur = g.ttft + g.streaming;
        if (dur >= 0) {
          turn.modelSec += dur;
          if (g.latestOutput > 0 && dur > 0) {
            turn._timedOutput += g.latestOutput;
            turn._timedModelSec += dur;
          }
        }
      }
      if (g.model) turn.model = g.model;
      if (g.modelId) turn.modelId = g.modelId;
    }
  }

  return {
    turnsCount: userSteps.length,
    stepsCount: parsedSteps.length,
    reqCount: parsedGens.length,
    compactionsCount,
    isStreaming,
    uncached,
    cached,
    output,
    thinking,
    modelSec,
    timedOutput,
    timedModelSec,
    ttftSum,
    ttftCount,
    toolIntervals,
    latestMaxContext,
    latestActiveContext,
    latestBreakdown,
    latestModel,
    latestModelId,
    modelMap,
    turns,
    subagentRefs: [...refMap.values()],
  };
}

function isTransientSqliteLockError(err) {
  if (!err) return false;
  if (err.errcode === 5 || err.errcode === 6) return true;
  const hay = [err.code, err.errstr, err.message].filter(Boolean).join(' ').toLowerCase();
  return hay.includes('sqlite_busy')
    || hay.includes('sqlite_locked')
    || hay.includes('database is locked')
    || hay.includes('database is busy');
}

function readSubagentTree(ref, { convDir, trackDep, visited, depth = 1, turnIndex = -1 }) {
  if (!ref?.id || !SAFE_ID_RE.test(ref.id) || visited.has(ref.id) || depth > MAX_SUBAGENT_DEPTH) {
    return null;
  }
  const subDbPath = join(convDir, `${ref.id}.db`);
  trackDep?.(subDbPath);
  if (!existsSync(subDbPath)) return null;
  visited.add(ref.id);

  let snap;
  try {
    snap = readDbSnapshot(subDbPath, { convDir, visited, includeTurns: false });
  } catch (err) {
    if (isTransientSqliteLockError(err)) throw err;
    return null;
  }

  const selfTotal = snap.uncached + snap.cached + snap.output;
  const selfBreakdown = finalizeModelBreakdown(snap.modelMap);
  const selfEntry = {
    id: ref.id,
    role: ref.role || ref.type || 'subagent',
    type: ref.type || 'subagent',
    depth,
    turnIndex,
    model: snap.latestModel || snap.latestModelId,
    modelId: snap.latestModelId,
    models: selfBreakdown.map(m => m.model),
    modelBreakdown: selfBreakdown,
    stepsCount: snap.stepsCount,
    totalTokens: selfTotal,
    uncached: snap.uncached,
    cached: snap.cached,
    output: snap.output,
    modelSec: snap.modelSec,
    toolSec: mergeIntervalsSec(snap.toolIntervals),
    avgTtftSec: snap.ttftCount > 0 ? snap.ttftSum / snap.ttftCount : null,
    tps: snap.timedModelSec > 0 ? snap.timedOutput / snap.timedModelSec : null,
    isStreaming: snap.isStreaming,
  };

  const aggModelMap = cloneModelMap(snap.modelMap);
  const agg = {
    stepsCount: snap.stepsCount,
    reqCount: snap.reqCount,
    uncached: snap.uncached,
    cached: snap.cached,
    output: snap.output,
    thinking: snap.thinking,
    modelSec: snap.modelSec,
    timedOutput: snap.timedOutput,
    timedModelSec: snap.timedModelSec,
    ttftSum: snap.ttftSum,
    ttftCount: snap.ttftCount,
    toolIntervals: [...snap.toolIntervals],
    isStreaming: snap.isStreaming,
    modelMap: aggModelMap,
  };
  const entries = [selfEntry];

  for (const childRef of snap.subagentRefs) {
    const childTree = readSubagentTree(childRef, {
      convDir,
      trackDep,
      visited,
      depth: depth + 1,
      turnIndex,
    });
    if (!childTree) continue;
    agg.stepsCount += childTree.agg.stepsCount;
    agg.reqCount += childTree.agg.reqCount;
    agg.uncached += childTree.agg.uncached;
    agg.cached += childTree.agg.cached;
    agg.output += childTree.agg.output;
    agg.thinking += childTree.agg.thinking;
    agg.modelSec += childTree.agg.modelSec;
    agg.timedOutput += childTree.agg.timedOutput;
    agg.timedModelSec += childTree.agg.timedModelSec;
    agg.ttftSum += childTree.agg.ttftSum;
    agg.ttftCount += childTree.agg.ttftCount;
    agg.toolIntervals.push(...childTree.agg.toolIntervals);
    if (childTree.agg.isStreaming) agg.isStreaming = true;
    mergeModelMaps(aggModelMap, childTree.agg.modelMap);
    entries.push(...childTree.entries);
  }
  return { agg, entries };
}

export function buildConversationTelemetry(dbPath, trackDep) {
  const convDir = dirname(dbPath);
  const visited = new Set();
  const main = readDbSnapshot(dbPath, { convDir, visited, includeTurns: true });

  const turns = main.turns;
  const sessionModelMap = cloneModelMap(main.modelMap);
  const allToolIntervals = [...main.toolIntervals];
  let mainStepsCount = main.stepsCount;
  let subagentStepsCount = 0;
  let totalUncached = main.uncached;
  let totalCached = main.cached;
  let totalOutput = main.output;
  let totalThinking = main.thinking;
  let modelSec = main.modelSec;
  let timedOutput = main.timedOutput;
  let timedModelSec = main.timedModelSec;
  let ttftSum = main.ttftSum;
  let ttftCount = main.ttftCount;
  let anySubagentStreaming = false;
  const allSubagents = [];

  for (const ref of main.subagentRefs) {
    const launchTurn = ref.launchedAtStep >= 0
      ? (turns.findLast(t => t.userStepIndex <= ref.launchedAtStep) || null)
      : null;
    const tree = readSubagentTree(ref, {
      convDir,
      trackDep,
      visited,
      depth: 1,
      turnIndex: launchTurn ? launchTurn.turnIndex : -1,
    });
    if (!tree) continue;

    const { agg, entries } = tree;
    const treeTokens = agg.uncached + agg.cached + agg.output;
    subagentStepsCount += agg.stepsCount;
    totalUncached += agg.uncached;
    totalCached += agg.cached;
    totalOutput += agg.output;
    totalThinking += agg.thinking;
    modelSec += agg.modelSec;
    timedOutput += agg.timedOutput;
    timedModelSec += agg.timedModelSec;
    ttftSum += agg.ttftSum;
    ttftCount += agg.ttftCount;
    allToolIntervals.push(...agg.toolIntervals);
    if (agg.isStreaming) anySubagentStreaming = true;
    mergeModelMaps(sessionModelMap, agg.modelMap);
    allSubagents.push(...entries);

    if (launchTurn) {
      launchTurn.uncached += agg.uncached;
      launchTurn.cached += agg.cached;
      launchTurn.output += agg.output;
      launchTurn.reqCount += agg.reqCount;
      launchTurn.stepsCount += agg.stepsCount;
      launchTurn.modelSec += agg.modelSec;
      launchTurn._ttftSum += agg.ttftSum;
      launchTurn._ttftCount += agg.ttftCount;
      launchTurn._timedOutput += agg.timedOutput;
      launchTurn._timedModelSec += agg.timedModelSec;
      launchTurn._toolIntervals.push(...agg.toolIntervals);
      mergeModelMaps(launchTurn._modelMap, agg.modelMap);
      launchTurn.subagentCount += entries.length;
      launchTurn.subagentTokens += treeTokens;
      launchTurn.subagentSteps += agg.stepsCount;
      for (const ent of entries) {
        launchTurn.subagents.push({
          id: ent.id,
          role: ent.role,
          type: ent.type,
          model: ent.model,
          totalTokens: ent.totalTokens,
          stepsCount: ent.stepsCount,
          isStreaming: ent.isStreaming,
        });
      }
      if (agg.isStreaming && launchTurn.turnIndex === turns.length - 1) {
        launchTurn.completed = false;
      }
    }
  }

  for (const t of turns) {
    t.total = t.uncached + t.cached + t.output;
    const promptIn = t.uncached + t.cached;
    t.cacheHitPct = promptIn > 0 ? (t.cached / promptIn) * 100 : null;
    t.toolSec = mergeIntervalsSec(t._toolIntervals);
    t.avgTtftSec = t._ttftCount > 0 ? t._ttftSum / t._ttftCount : null;
    t.tps = t._timedModelSec > 0 ? t._timedOutput / t._timedModelSec : null;
    t.modelBreakdown = finalizeModelBreakdown(t._modelMap);
    t.models = t.modelBreakdown.map(m => m.model);
    if (!t.model) t.model = t.modelBreakdown.at(-1)?.model || main.latestModel || main.latestModelId;
    if (!t.modelId) t.modelId = t.modelBreakdown.at(-1)?.modelId || main.latestModelId;
  }

  const toolSec = mergeIntervalsSec(allToolIntervals);
  const avgTtftSec = ttftCount > 0 ? ttftSum / ttftCount : null;
  const tps = timedModelSec > 0 ? timedOutput / timedModelSec : null;
  const mainTotal = main.uncached + main.cached + main.output;
  const totalTokens = totalUncached + totalCached + totalOutput;
  const subagentTotal = Math.max(0, totalTokens - mainTotal);
  const totalPromptInput = totalUncached + totalCached;
  const cacheHitPct = totalPromptInput > 0 ? (totalCached / totalPromptInput) * 100 : null;
  const sessionModelBreakdown = finalizeModelBreakdown(sessionModelMap);

  // Context breakdown reflects main conversation context window strictly
  const usedTokens = main.latestActiveContext?.contextTokens || main.latestBreakdown?.total || 0;
  const maxTokens = main.latestMaxContext;
  const usedPct = maxTokens > 0 ? Math.round((usedTokens / maxTokens) * 100) : 0;

  let contextCategories = [];
  if (main.latestBreakdown?.items?.length) {
    contextCategories = main.latestBreakdown.items;
  } else if (main.latestActiveContext && usedTokens > 0) {
    if (main.latestActiveContext.latestCached > 0) {
      contextCategories.push({ id: 7, key: 'cached', zh: '缓存读取', en: 'Cached Input', color: CATEGORY_STYLES[7].color, tokens: main.latestActiveContext.latestCached });
    }
    if (main.latestActiveContext.latestUncached > 0) {
      contextCategories.push({ id: 1, key: 'uncached', zh: '未缓存输入', en: 'Uncached Input', color: CATEGORY_STYLES[1].color, tokens: main.latestActiveContext.latestUncached });
    }
  }

  return {
    session: {
      turnsCount: main.turnsCount,
      stepsCount: mainStepsCount + subagentStepsCount,
      mainStepsCount,
      subagentStepsCount,
      compactionsCount: main.compactionsCount,
      subagentCount: allSubagents.length,
      modelSec,
      toolSec,
      avgTtftSec,
      tps,
      model: main.latestModel,
      modelId: main.latestModelId,
      models: sessionModelBreakdown.map(m => m.model),
      modelBreakdown: sessionModelBreakdown,
      isStreaming: main.isStreaming || anySubagentStreaming,
    },
    tokens: {
      total: totalTokens,
      mainTotal,
      subagentTotal,
      uncached: totalUncached,
      cached: totalCached,
      output: totalOutput,
      thinking: totalThinking,
      cacheHitPct,
    },
    context: {
      usedTokens,
      maxTokens,
      usedPct,
      categories: contextCategories,
      breakdownTotal: main.latestBreakdown?.total || usedTokens,
    },
    subagents: allSubagents,
    turns: turns.map(({ endStepIndex, _toolIntervals, _ttftSum, _ttftCount, _timedOutput, _timedModelSec, _modelMap, ...rest }) => rest),
  };
}

export function resolveLatestConversationId(convDir = join(homedir(), '.gemini', 'antigravity', 'conversations')) {
  if (!existsSync(convDir)) return '';
  const files = readdirSync(convDir)
    .filter(f => f.endsWith('.db'))
    .map(f => ({ id: basename(f, '.db'), mtimeMs: statSync(join(convDir, f)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files[0]?.id || '';
}

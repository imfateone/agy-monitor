import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseDurationSec, parsePbMap, parseTimestampMs, readVarint } from './pb.mjs';

const ACTIVE_STATUSES = new Set([1, 2, 8, 9, 11]);
const NON_TOOL_STEPS = new Set([14, 15, 17, 23, 101]);

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

export function createSnapshotCache(reader) {
  const cache = new Map();
  return {
    read(path) {
      const db = fileStamp(path);
      if (!db || db.size === 0n) {
        cache.delete(path);
        return null;
      }
      const key = `${db.key}|${fileStamp(`${path}-wal`)?.key || 'no-wal'}`;
      const hit = cache.get(path);
      if (hit?.key === key) return hit.value;
      try {
        const value = reader(path);
        cache.delete(path);
        cache.set(path, { key, value });
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

export function buildConversationTelemetry(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let genRows = [];
  let stepRows = [];
  let execRows = [];
  try {
    genRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    stepRows = db.prepare('SELECT idx, step_type, status, metadata FROM steps ORDER BY idx ASC').all();
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='executor_metadata'").get()) {
      execRows = db.prepare('SELECT idx, data FROM executor_metadata ORDER BY idx ASC').all();
    }
  } finally {
    db.close();
  }

  const parsedSteps = stepRows.map(s => {
    const f = parsePbMap(Buffer.from(s.metadata || []));
    const createdAtMs = parseTimestampMs(f.get(1)?.[0]);
    const completedAtMs = parseTimestampMs(f.get(8)?.[0]) || parseTimestampMs(f.get(7)?.[0]);
    const transitions = (parsePbMap(f.get(26)?.[0] || Buffer.alloc(0)).get(1) || []).map(parsePbMap);
    const terminalMs = transitions
      .filter(t => [3, 6, 7, 12].includes(t.get(1)?.[0]))
      .map(t => parseTimestampMs(t.get(2)?.[0]))
      .filter(Boolean);
    const endedAtMs = completedAtMs || (terminalMs.length ? Math.max(...terminalMs) : null);
    return {
      idx: s.idx,
      stepType: s.step_type,
      status: s.status,
      createdAtMs,
      endedAtMs,
    };
  });

  const executors = execRows.map(r => {
    const f = parsePbMap(Buffer.from(r.data || []));
    return {
      reason: f.get(1)?.[0] || 0,
      lastStepIndex: f.size ? (f.get(3)?.[0] ?? 0) : -1,
    };
  });

  const parsedGens = genRows.map(r => parseGenRow(r.idx, r.data)).filter(Boolean);

  // Session aggregates
  const userSteps = parsedSteps.filter(s => s.stepType === 14 && s.status !== 11);
  const turnsCount = userSteps.length;
  const stepsCount = parsedSteps.length;

  let totalUncached = 0;
  let totalCached = 0;
  let totalOutput = 0;
  let totalThinking = 0;
  let modelSec = 0;
  let timedOutput = 0;
  let timedModelSec = 0;
  let ttftSum = 0;
  let ttftCount = 0;

  const checkpointIdxs = parsedSteps.filter(s => s.stepType === 23).map(s => s.idx);
  let latestMaxContext = 0;
  let latestActiveContext = null;
  let latestBreakdown = null;
  let latestModel = '';
  let latestModelId = '';
  let prevContextTokens = 0;
  let lastCheckpointIdx = -1;

  for (const g of parsedGens) {
    totalUncached += g.uncached;
    totalCached += g.cached;
    totalOutput += g.output;
    totalThinking += g.thinking;

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

  // Tool duration: merged active intervals of tool steps (excludes user/planner/error/checkpoint)
  const toolIntervals = [];
  for (const s of parsedSteps) {
    if (NON_TOOL_STEPS.has(s.stepType)) continue;
    if (s.createdAtMs && s.endedAtMs && s.endedAtMs >= s.createdAtMs) {
      toolIntervals.push([s.createdAtMs, s.endedAtMs]);
    }
  }
  const toolSec = mergeIntervalsSec(toolIntervals);

  const avgTtftSec = ttftCount > 0 ? ttftSum / ttftCount : null;
  const tps = timedModelSec > 0 ? timedOutput / timedModelSec : null;
  const totalTokens = totalUncached + totalCached + totalOutput;
  const totalPromptInput = totalUncached + totalCached;
  const cacheHitPct = totalPromptInput > 0 ? (totalCached / totalPromptInput) * 100 : null;

  // Context breakdown
  const usedTokens = latestActiveContext?.contextTokens || latestBreakdown?.total || 0;
  const maxTokens = latestMaxContext;
  const usedPct = maxTokens > 0 ? Math.round((usedTokens / maxTokens) * 100) : 0;

  let contextCategories = [];
  if (latestBreakdown?.items?.length) {
    contextCategories = latestBreakdown.items;
  } else if (latestActiveContext && usedTokens > 0) {
    if (latestActiveContext.latestCached > 0) {
      contextCategories.push({ id: 7, key: 'cached', zh: '缓存读取', en: 'Cached Input', color: CATEGORY_STYLES[7].color, tokens: latestActiveContext.latestCached });
    }
    if (latestActiveContext.latestUncached > 0) {
      contextCategories.push({ id: 1, key: 'uncached', zh: '未缓存输入', en: 'Uncached Input', color: CATEGORY_STYLES[1].color, tokens: latestActiveContext.latestUncached });
    }
  }

  // Per-turn usage & session-stats aggregation
  const turns = userSteps.map((u, i) => {
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
      modelSec: 0,
      toolSec: mergeIntervalsSec(turnToolIntervals),
      avgTtftSec: null,
      tps: null,
      _ttftSum: 0,
      _ttftCount: 0,
      _timedOutput: 0,
      _timedModelSec: 0,
      model: '',
      modelId: '',
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

  for (const t of turns) {
    t.total = t.uncached + t.cached + t.output;
    const promptIn = t.uncached + t.cached;
    t.cacheHitPct = promptIn > 0 ? (t.cached / promptIn) * 100 : null;
    t.avgTtftSec = t._ttftCount > 0 ? t._ttftSum / t._ttftCount : null;
    t.tps = t._timedModelSec > 0 ? t._timedOutput / t._timedModelSec : null;
    if (!t.model) t.model = latestModel || latestModelId;
    if (!t.modelId) t.modelId = latestModelId;
  }

  return {
    session: {
      turnsCount,
      stepsCount,
      modelSec,
      toolSec,
      avgTtftSec,
      tps,
      model: latestModel,
      modelId: latestModelId,
      isStreaming: parsedSteps.some(s => s.stepType !== 14 && ACTIVE_STATUSES.has(s.status)),
    },
    tokens: {
      total: totalTokens,
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
      breakdownTotal: latestBreakdown?.total || usedTokens,
    },
    turns: turns.map(({ endStepIndex, _ttftSum, _ttftCount, _timedOutput, _timedModelSec, ...rest }) => rest),
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

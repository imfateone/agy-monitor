import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fmtCompact, fmtDur, fmtExact, fmtPct, fmtTps, esc } from '../sidecars/agy_monitor/pb.mjs';
import { buildConversationTelemetry, createSnapshotCache, mergeIntervalsSec, parseGenRow } from '../sidecars/agy_monitor/telemetry.mjs';
import { normalizeSettings, createSettingsStore } from '../sidecars/agy_monitor/settings.mjs';
import { buildRuntimeBundle, matchTurnBarsToCompleted, parseRelativeAgeMs } from '../sidecars/agy_monitor/injector.mjs';
import { renderSidebarHtml } from '../sidecars/agy_monitor/ui.mjs';
import { createTelemetryController, EMPTY_DATA } from '../sidecars/agy_monitor/server.mjs';
import { assignModelColors, createAsyncUsageStatsCollector, createUsageStatsCollector, estimateModelCost, formatLocalYmd } from '../sidecars/agy_monitor/usage_stats.mjs';

function varint(n) {
  const bytes = [];
  let v = BigInt(n);
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function fieldVarint(fn, val) {
  return Buffer.concat([varint((fn << 3) | 0), varint(val)]);
}

function fieldBytes(fn, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  return Buffer.concat([varint((fn << 3) | 2), varint(b.length), b]);
}

function tsPb(sec, nano = 0) {
  const sInt = Math.trunc(sec);
  const nInt = Math.round((sec - sInt) * 1e9) + nano;
  return Buffer.concat([fieldVarint(1, sInt), fieldVarint(2, nInt)]);
}

function makeUsage({ uncached = 0, cached = 0, out = 0, think = 0 } = {}) {
  return Buffer.concat([
    fieldVarint(2, uncached),
    fieldVarint(5, cached),
    fieldVarint(3, out),
    ...(think > 0 ? [fieldVarint(9, think)] : []),
    fieldVarint(10, Math.max(0, out - think)),
  ]);
}

function makeGen({ stepIdxs, uncached, cached, out, think = 0, ttftSec, streamSec, model, modelId, breakdown, retries }) {
  const usage = makeUsage({ uncached, cached, out, think });
  const m10Parts = [fieldVarint(1, uncached + cached), fieldVarint(4, 512000)];
  if (breakdown) {
    const items = breakdown.map(([id, label, tok]) =>
      fieldBytes(1, Buffer.concat([fieldBytes(1, label), fieldVarint(2, id), fieldVarint(4, tok)]))
    );
    m10Parts.push(fieldBytes(3, Buffer.concat([...items, fieldVarint(2, uncached + cached)])));
  }
  const m9 = fieldBytes(10, Buffer.concat(m10Parts));
  const m1Parts = [
    fieldBytes(4, usage),
    fieldBytes(9, m9),
    fieldBytes(11, tsPb(ttftSec)),
    fieldBytes(12, tsPb(streamSec)),
    fieldBytes(19, modelId),
    fieldBytes(21, model),
  ];
  if (Array.isArray(retries)) {
    for (const r of retries) {
      const rParts = [];
      if (r.usage) rParts.push(fieldBytes(2, makeUsage(r.usage)));
      if (r.error) rParts.push(fieldBytes(3, r.error));
      m1Parts.push(fieldBytes(17, Buffer.concat(rParts)));
    }
  }
  return Buffer.concat([
    ...stepIdxs.map(s => fieldVarint(2, s)),
    fieldBytes(1, Buffer.concat(m1Parts)),
  ]);
}

test('formatters and relative timestamp parser handle monitor display rules', () => {
  assert.equal(fmtCompact(7_389_661), '7.4M');
  assert.equal(fmtCompact(159_725), '160K');
  assert.equal(fmtCompact(8600), '8.6K');
  assert.equal(fmtCompact(1520), '1.5K');
  assert.equal(fmtExact(159_725), '159,725');
  assert.equal(fmtDur(308, false), '5 分 8 秒');
  assert.equal(fmtDur(308, true), '5m 8s');
  assert.equal(fmtDur(2.4, false), '2.4 秒');
  assert.equal(fmtPct(99.4, 1), '99.4%');
  assert.equal(fmtPct(98.0, 1), '98%');
  assert.equal(fmtTps(206.7), '207 tok/s');
  assert.equal(esc('<a&"b">'), '&lt;a&amp;&quot;b&quot;&gt;');

  assert.equal(parseRelativeAgeMs('18分钟前'), 18 * 60_000);
  assert.equal(parseRelativeAgeMs('2 小时前'), 2 * 3_600_000);
  assert.equal(parseRelativeAgeMs('5m ago'), 5 * 60_000);
  assert.equal(parseRelativeAgeMs('刚刚'), 30_000);
  assert.equal(parseRelativeAgeMs('11月6日'), null);
});

test('mergeIntervalsSec deduplicates parallel tool calls', () => {
  const sec = mergeIntervalsSec([
    [1000, 5000],
    [2000, 7000],
    [10000, 13000],
  ]);
  assert.equal(sec, 9);
});

test('buildConversationTelemetry parses session, archived turns, error exclusion, and compaction breakdown reset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-monitor-test-'));
  try {
    const dbPath = join(dir, 'conv.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
    `);

    const stepMeta = (startSec, endSec) => Buffer.concat([
      fieldBytes(1, tsPb(startSec)),
      ...(endSec ? [fieldBytes(8, tsPb(endSec))] : []),
    ]);

    // Turn 0 (steps 0..3, archived status=5, error step 17 excluded from toolSec)
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(0, 14, 5, stepMeta(1000));
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(1, 15, 5, stepMeta(1000, 1004));
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(2, 132, 5, stepMeta(1004, 1010));
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(3, 17, 5, stepMeta(1010, 1050));
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(4, 15, 5, stepMeta(1050, 1052));

    // Compaction checkpoint step (step_type=23) before Turn 1
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(5, 23, 3, stepMeta(1500, 1501));

    // Turn 1 (steps 6..7, status=3, no breakdown emitted yet after compaction)
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(6, 14, 3, stepMeta(2000));
    db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?)').run(7, 15, 3, stepMeta(2000, 2005));

    db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, makeGen({
      stepIdxs: [1], uncached: 10000, cached: 0, out: 200, ttftSec: 2, streamSec: 2,
      model: 'Gemini 4 Hydrogen (XHigh)', modelId: 'gemini-4-hydrogen',
    }));
    db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(1, makeGen({
      stepIdxs: [4], uncached: 5000, cached: 195000, out: 300, ttftSec: 1, streamSec: 3,
      model: 'Gemini 4 Hydrogen (XHigh)', modelId: 'gemini-4-hydrogen',
      breakdown: [[1, 'System Prompt', 12000], [2, 'Tools', 6000], [7, 'Chat Messages', 182000]],
    }));
    // Post-compaction generation dropped context down to 22K without writing m10.3
    db.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(2, makeGen({
      stepIdxs: [7], uncached: 2000, cached: 20000, out: 250, ttftSec: 3, streamSec: 2,
      model: 'Gemini 4 Hydrogen (XHigh)', modelId: 'gemini-4-hydrogen',
    }));
    db.close();

    const res = buildConversationTelemetry(dbPath);
    assert.equal(res.session.turnsCount, 2);
    assert.equal(res.session.stepsCount, 8);
    assert.equal(res.session.mainStepsCount, 8);
    assert.equal(res.session.subagentStepsCount, 0);
    assert.equal(res.session.compactionsCount, 1);
    assert.equal(res.session.subagentCount, 0);
    assert.equal(res.session.modelSec, 13);
    assert.equal(res.session.toolSec, 6);
    assert.equal(res.context.usedTokens, 22000);
    // Pre-compaction 200K breakdown must NOT leak into post-compaction 22K context!
    assert.equal(res.context.categories.length, 2);
    assert.equal(res.context.categories[0].key, 'cached');
    assert.equal(res.context.categories[0].tokens, 20000);
    assert.equal(res.context.categories[1].key, 'uncached');
    assert.equal(res.context.categories[1].tokens, 2000);
    assert.equal(res.context.breakdownTotal, 22000);

    assert.equal(res.turns.length, 2);
    assert.equal(res.turns[0].completed, true);
    assert.equal(res.turns[0].hasReply, true);
    assert.equal(res.turns[0].stepsCount, 6);
    assert.equal(res.turns[0].compactionsCount, 1);
    assert.equal(res.turns[0].modelSec, 8);
    assert.equal(res.turns[0].toolSec, 6);
    assert.equal(res.turns[0].avgTtftSec, 1.5);
    assert.equal(res.turns[0].tps, 100);
    assert.equal('_ttftSum' in res.turns[0], false);
    assert.equal(res.turns[1].completed, true);
    assert.equal(res.turns[1].stepsCount, 2);
    assert.equal(res.turns[1].compactionsCount, 0);
    assert.equal(res.turns[1].modelSec, 5);
    assert.equal(res.turns[1].toolSec, 0);
    assert.equal(res.turns[1].avgTtftSec, 3);
    assert.equal(res.turns[1].tps, 125);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('buildConversationTelemetry aggregates multi-model turns, nested/compaction subagents, and cache invalidation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-monitor-subagent-'));
  try {
    const mainId = '11111111-1111-4111-8111-111111111111';
    const childId = '22222222-2222-4222-8222-222222222222';
    const grandId = '33333333-3333-4333-8333-333333333333';
    const compChildId = '44444444-4444-4444-8444-444444444444';
    const swarmA = '55555555-5555-4555-8555-555555555555';
    const swarmB = '66666666-6666-4666-8666-666666666666';

    const stepMeta = (startSec, endSec, toolName = '') => Buffer.concat([
      fieldBytes(1, tsPb(startSec)),
      ...(toolName ? [fieldBytes(4, Buffer.concat([fieldBytes(1, 'call_1'), fieldBytes(2, toolName)]))] : []),
      ...(endSec ? [fieldBytes(8, tsPb(endSec))] : []),
    ]);
    const invokePayload = (id, role, type) => fieldBytes(140, fieldBytes(2, fieldBytes(3, fieldBytes(9, fieldBytes(5, Buffer.concat([
      fieldBytes(1, id),
      fieldBytes(2, role),
      fieldBytes(3, type),
    ]))))));
    const swarmMultiPayload = (ids) => fieldBytes(140, Buffer.from(ids.join(' '), 'utf8'));
    const compactionPayload = (entries) => fieldBytes(30, Buffer.concat(
      entries.map(([id, role, type]) => fieldBytes(20, Buffer.concat([
        fieldBytes(4, Buffer.concat([fieldBytes(1, type), fieldBytes(2, role)])),
        fieldBytes(5, fieldBytes(1, id)),
      ])))
    ));
    const initDb = (dbPath) => {
      const d = new DatabaseSync(dbPath);
      d.exec(`
        PRAGMA journal_mode=WAL;
        CREATE TABLE trajectory_meta (trajectory_id text PRIMARY KEY, cascade_id text);
        CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
        CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
        CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      `);
      return d;
    };

    // Grandchild DB (adds an active streaming step + cycle reference back to mainId!)
    const gDb = initDb(join(dir, `${grandId}.db`));
    gDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run('gc-traj', grandId);
    gDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(0, 15, 3, stepMeta(1006, 1008), null);
    gDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(1, 132, 1, stepMeta(1007, 1009, 'invoke_subagent'), invokePayload(mainId, 'CycleBack', 'self'));
    gDb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, makeGen({
      stepIdxs: [0], uncached: 200, cached: 800, out: 100, ttftSec: 1, streamSec: 1,
      model: 'Gemini 4 Flash', modelId: 'gemini-4-flash',
    }));
    gDb.close();

    // Child DB spawned by invoke_subagent in Turn 0; overlaps main tool interval [1004..1010] -> [1005..1012]
    const cDb = initDb(join(dir, `${childId}.db`));
    cDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run('ch-traj', childId);
    cDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(0, 15, 3, stepMeta(1005, 1007), null);
    cDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(1, 132, 3, stepMeta(1005, 1012, 'invoke_subagent'), invokePayload(grandId, 'Grand Helper', 'research'));
    cDb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, makeGen({
      stepIdxs: [0], uncached: 500, cached: 1500, out: 200, ttftSec: 2, streamSec: 2,
      model: 'Orchestrator (Neon)', modelId: 'gemini-pro-orchestrator-neon',
    }));
    cDb.close();

    // Extra subagent only recorded inside compaction step_type=23 f30.20 (no direct step_payload on launch step)
    const fDb = initDb(join(dir, `${compChildId}.db`));
    fDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run('fc-traj', compChildId);
    fDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(0, 15, 5, stepMeta(1020, 1022), null);
    fDb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, makeGen({
      stepIdxs: [0], uncached: 100, cached: 400, out: 50, ttftSec: 1, streamSec: 1,
      model: 'Gemini 4 Hydrogen (High)', modelId: 'gemini-4-hydrogen-tiered-high',
    }));
    fDb.close();

    // Two swarm workers spawned by Turn 1 (discovered via multi-UUID fallback without f140.2.3.9.5)
    for (const [wid, st, tokOut] of [[swarmA, 3, 200], [swarmB, 1, 300]]) {
      const sDb = initDb(join(dir, `${wid}.db`));
      sDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run(`sw-${wid.slice(0, 4)}`, wid);
      sDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(0, 15, st, stepMeta(2001, 2002), null);
      sDb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, makeGen({
        stepIdxs: [0], uncached: tokOut, cached: 0, out: 50, ttftSec: 1, streamSec: 1,
        model: 'Gemini 4 Flash', modelId: 'gemini-4-flash',
      }));
      sDb.close();
    }

    // Main DB: Turn 0 uses Neon x1 + Hydrogen x2, launches Child, triggers compaction checkpoint; Turn 1 after compaction launches swarm x2
    const mainPath = join(dir, `${mainId}.db`);
    const mDb = initDb(mainPath);
    mDb.prepare('INSERT INTO trajectory_meta VALUES (?, ?)').run('main-traj', mainId);
    mDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(0, 14, 3, stepMeta(1000), null);
    mDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(1, 15, 3, stepMeta(1000, 1002), null);
    mDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(2, 132, 3, stepMeta(1004, 1010, 'invoke_subagent'), invokePayload(childId, 'Code Reviewer', 'research'));
    mDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(3, 15, 3, stepMeta(1010, 1012), null);
    mDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(4, 15, 3, stepMeta(1012, 1014), null);
    mDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(5, 23, 3, stepMeta(1030, 1031), compactionPayload([
      [childId, 'Code Reviewer', 'research'],
      [compChildId, 'Art Backup', 'image-generator'],
    ]));
    mDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(6, 14, 3, stepMeta(2000), null);
    mDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(7, 15, 3, stepMeta(2000, 2003), null);
    mDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(8, 132, 3, stepMeta(2001, 2002, 'swarm'), swarmMultiPayload([swarmA, swarmB]));

    mDb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, makeGen({
      stepIdxs: [1], uncached: 10000, cached: 0, out: 200, ttftSec: 1, streamSec: 1,
      model: 'Gemini 4 Neon (XHigh)', modelId: 'gemini-4-neon',
    }));
    mDb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(1, makeGen({
      stepIdxs: [3], uncached: 1000, cached: 10000, out: 150, ttftSec: 2, streamSec: 2,
      model: 'Gemini 4 Hydrogen (XHigh)', modelId: 'gemini-4-hydrogen',
    }));
    mDb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(2, makeGen({
      stepIdxs: [4], uncached: 1000, cached: 11000, out: 250, ttftSec: 2, streamSec: 2,
      model: 'Gemini 4 Hydrogen (XHigh)', modelId: 'gemini-4-hydrogen',
    }));
    mDb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(3, makeGen({
      stepIdxs: [7], uncached: 3000, cached: 17000, out: 400, ttftSec: 1, streamSec: 2,
      model: 'Gemini 4 Hydrogen (XHigh)', modelId: 'gemini-4-hydrogen',
    }));
    mDb.close();

    const cache = createSnapshotCache(buildConversationTelemetry);
    const snap1 = cache.read(mainPath);
    assert.equal(snap1.session.compactionsCount, 1);
    assert.equal(snap1.session.subagentCount, 5); // child + grand + compChild + swarmA + swarmB
    assert.equal(snap1.session.mainStepsCount, 9);
    assert.equal(snap1.session.subagentStepsCount, 7); // 2 + 2 + 1 + 1 + 1
    assert.equal(snap1.session.stepsCount, 16);
    assert.equal(snap1.session.isStreaming, true); // propagated from grandchild & swarmB

    // Tokens roll up main + subagents while context strictly reflects main DB
    const expectedMainTok = 10200 + 11150 + 12250 + 20400; // 54,000
    const expectedSubTok = 2200 + 1100 + 550 + 250 + 350; // 4,450
    assert.equal(snap1.tokens.mainTotal, expectedMainTok);
    assert.equal(snap1.tokens.subagentTotal, expectedSubTok);
    assert.equal(snap1.tokens.total, expectedMainTok + expectedSubTok);
    assert.equal(snap1.context.usedTokens, 20000);

    // Merged tool intervals: Turn 0 [1004..1010] | [1005..1012] | [1007..1009] => 8s; Turn 1 [2001..2002] => 1s => 9s total
    assert.equal(snap1.session.toolSec, 9);

    // Turn 0 is historical (Turn 1 exists), so even if grandchild is active, Turn 0 stays completed=true!
    const t0 = snap1.turns[0];
    assert.equal(t0.compactionsCount, 1);
    assert.equal(t0.subagentCount, 2); // Child + Grandchild (compChild had launchedAtStep=-1)
    assert.equal(t0.subagentTokens, 3300);
    assert.equal(t0.subagentSteps, 4);
    assert.equal(t0.stepsCount, 10); // 6 main + 4 child/grandchild
    assert.equal(t0.completed, true);

    // Latest Turn 1 DOES wait for its active swarm worker (swarmB)
    const t1 = snap1.turns[1];
    assert.equal(t1.subagentCount, 2);
    assert.equal(t1.subagentTokens, 600);
    assert.equal(t1.completed, false);
    assert.deepEqual(
      t0.modelBreakdown.map(m => [m.model, m.reqCount]),
      [
        ['Gemini 4 Neon (XHigh)', 1],
        ['Gemini 4 Hydrogen (XHigh)', 2],
        ['Orchestrator (Neon)', 1],
        ['Gemini 4 Flash', 1],
      ],
    );
    const t0Hydrogen = t0.modelBreakdown.find(m => m.model === 'Gemini 4 Hydrogen (XHigh)');
    assert.equal(t0Hydrogen.total, 23400);
    assert.equal(t0Hydrogen.uncached, 2000);
    assert.equal(t0Hydrogen.cached, 21000);
    assert.equal(t0Hydrogen.output, 400);
    assert.ok(Math.abs(t0Hydrogen.cacheHitPct - (21000 / 23000) * 100) < 1e-9);
    assert.equal(t0Hydrogen.modelSec, 8);
    assert.equal(t0Hydrogen.avgTtftSec, 2);
    assert.equal(t0Hydrogen.tps, 100);
    assert.equal('_ttftSum' in t0Hydrogen, false);

    const sessHydrogen = snap1.session.modelBreakdown.find(m => m.model === 'Gemini 4 Hydrogen (XHigh)');
    assert.equal(sessHydrogen.reqCount, 3);
    assert.equal(sessHydrogen.total, 43800);
    assert.ok(Math.abs(sessHydrogen.cacheHitPct - (38000 / 43000) * 100) < 1e-9);
    assert.equal(sessHydrogen.modelSec, 11);
    assert.ok(Math.abs(sessHydrogen.avgTtftSec - (5 / 3)) < 1e-9);
    assert.ok(Math.abs(sessHydrogen.tps - (800 / 6)) < 1e-9);
    assert.equal(
      snap1.session.modelBreakdown.reduce((sum, m) => sum + m.total, 0),
      snap1.tokens.total,
    );

    // Cache hit returns identical ref when nothing changed
    assert.equal(cache.read(mainPath), snap1);

    // Transient SQLite lock on a child DB preserves snap1 instead of dropping/caching partial data!
    const lockDb = new DatabaseSync(join(dir, `${grandId}.db`));
    lockDb.exec('BEGIN EXCLUSIVE; UPDATE steps SET status=1 WHERE idx=0;');
    const snapDuringLock = cache.read(mainPath);
    assert.equal(snapDuringLock, snap1);
    lockDb.exec('ROLLBACK;');
    lockDb.close();

    // Once child & swarm worker finish, cache invalidates cleanly and reflects completed=true
    for (const [id, stepIdx] of [[grandId, 1], [swarmB, 0]]) {
      const wd = new DatabaseSync(join(dir, `${id}.db`));
      wd.prepare('UPDATE steps SET status=3 WHERE idx=?').run(stepIdx);
      wd.close();
    }
    const snap2 = cache.read(mainPath);
    assert.notEqual(snap2, snap1);
    assert.equal(snap2.session.isStreaming, false);
    assert.equal(snap2.turns[1].completed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('parseGenRow accumulates failed retries while preserving final active context split', () => {
  const raw = makeGen({
    stepIdxs: [3],
    uncached: 1500,
    cached: 48500,
    out: 400,
    ttftSec: 2,
    streamSec: 2,
    model: 'Gemini 4 Carbon (High)',
    modelId: 'gemini-4-carbon',
    retries: [
      { usage: { uncached: 50000, cached: 0, out: 0 }, error: 'network EOF' },
      { usage: null },
    ],
  });
  const parsed = parseGenRow(0, raw);
  assert.equal(parsed.uncached, 51500);
  assert.equal(parsed.cached, 48500);
  assert.equal(parsed.output, 400);
  assert.equal(parsed.contextTokens, 50000);
  assert.equal(parsed.latestUncached, 1500);
  assert.equal(parsed.latestCached, 48500);

  // Explicit non-empty retry counters on final attempt
  const explicitRaw = makeGen({
    stepIdxs: [4],
    uncached: 1500,
    cached: 48500,
    out: 400,
    ttftSec: 2,
    streamSec: 2,
    model: 'Gemini 4 Carbon (High)',
    modelId: 'gemini-4-carbon',
    retries: [
      { usage: { uncached: 50000, cached: 0, out: 0 }, error: 'rate limit' },
      { usage: { uncached: 2000, cached: 48500, out: 400 } },
    ],
  });
  assert.equal(parseGenRow(1, explicitRaw).uncached, 52000);

  // Every standard context category (System, MCP, Subagents, Skills, Plugins, Rules, Tools, Messages) has a distinct non-gray color
  const catRaw = makeGen({
    stepIdxs: [5], uncached: 5000, cached: 80000, out: 100, ttftSec: 1, streamSec: 1,
    model: 'Gemini 4 Hydrogen', modelId: 'gemini-4-hydrogen',
    breakdown: [
      [1, 'System Prompt', 5100],
      [4, 'Mcp Tools', 372],
      [6, 'Subagents', 2800],
      [5, 'Skills', 2800],
      [9, 'Plugins', 1600],
      [3, 'Rules', 132],
      [2, 'Tools', 8300],
      [7, 'Chat Messages', 72000],
    ],
  });
  const catColors = parseGenRow(2, catRaw).breakdown.items.map(i => i.color);
  assert.equal(new Set(catColors).size, 8);
  assert.equal(catColors.some(c => c === '#6b7280' || c === '#9ca3af'), false);
});

test('createSnapshotCache invalidates cleanly on SQLite WAL writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-monitor-wal-'));
  try {
    const dbPath = join(dir, 'wal.db');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1);');
    let loads = 0;
    const cache = createSnapshotCache(() => ++loads);
    assert.equal(cache.read(dbPath), 1);
    assert.equal(cache.read(dbPath), 1);
    db.exec('INSERT INTO t VALUES (2);');
    assert.equal(cache.read(dbPath), 2);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('createTelemetryController isolates multi-window and empty home tabs from sidebar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-monitor-ctrl-'));
  try {
    const convA = '11111111-1111-1111-1111-111111111111';
    const convB = '22222222-2222-2222-2222-222222222222';
    writeFileSync(join(dir, `${convA}.db`), 'a');
    writeFileSync(join(dir, `${convB}.db`), 'b');

    const controller = createTelemetryController({
      convDir: dir,
      readSnapshot: (p) => ({ ...EMPTY_DATA, session: { ...EMPTY_DATA.session, model: p.includes(convA) ? 'ModelA' : 'ModelB' } }),
      resolveLatest: () => convA,
      getQuota: async () => ({ quotaGroups: [], cloudPaygo: false }),
      readSettings: () => ({ language: 'zh-CN' }),
    });

    // Window A focused registers convA
    const resA = await controller(convA, { exact: true, focused: true });
    assert.equal(resA.session.model, 'ModelA');
    assert.equal(resA.conversationId, convA);

    // Window B unfocused does NOT hijack lastDeckConvId, and blank home window does NOT wipe it
    const resB = await controller(convB, { exact: true, focused: false });
    assert.equal(resB.session.model, 'ModelB');
    const resEmpty = await controller('', { exact: true, focused: false });
    assert.equal(resEmpty.session.model, '');

    // Sidebar without explicit ID stays on focused convA; explicit sidebar convB overrides deck
    const sidebarDefault = await controller('', false);
    assert.equal(sidebarDefault.session.model, 'ModelA');
    const sidebarExplicit = await controller(convB, false);
    assert.equal(sidebarExplicit.session.model, 'ModelB');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('matchTurnBarsToCompleted aligns normally at bottom and shifts when scrolled into history', () => {
  const now = 1_700_000_000_000;
  const completed = [
    { turnIndex: 0, endedAtMs: now - 3 * 3_600_000 },
    { turnIndex: 1, endedAtMs: now - 2 * 3_600_000 },
    { turnIndex: 2, endedAtMs: now - 20 * 60_000 },
    { turnIndex: 3, endedAtMs: now - 5 * 60_000 },
  ];

  const atBottom = matchTurnBarsToCompleted(
    [{ barAgeMs: 20 * 60_000 }, { barAgeMs: 5 * 60_000 }],
    completed,
    now,
  );
  assert.deepEqual(atBottom.map(p => p.turn.turnIndex), [3, 2]);

  // Scrolled up so virtualizer only keeps turns 0 and 1 rendered
  const scrolledUp = matchTurnBarsToCompleted(
    [{ barAgeMs: 3 * 3_600_000 }, { barAgeMs: 2 * 3_600_000 }],
    completed,
    now,
  );
  assert.deepEqual(scrolledUp.map(p => p.turn.turnIndex), [1, 0]);
});

test('settings store validates and persists patches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-monitor-cfg-'));
  try {
    const store = createSettingsStore(join(dir, 'settings.json'));
    assert.equal(store.read().language, 'zh-CN');
    const updated = store.update({ language: 'en', enableTurnPills: false, bogus: 123 });
    assert.equal(updated.language, 'en');
    assert.equal(updated.enableTurnPills, false);
    assert.equal('bogus' in updated, false);
    assert.equal(normalizeSettings({ language: 'fr' }).language, 'zh-CN');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('runtime bundle and sidebar HTML compile cleanly and mount outside composer', async () => {
  const bundle = buildRuntimeBundle(123456);
  assert.ok(bundle.code.includes('__agyMonitorDeck'));
  assert.equal(bundle.hash.length, 16);

  // Verify runtime bundle JS compiles cleanly inside VM and injects footer/turn DOM properly
  const makeEl = (tag = 'DIV', className = '', attrs = {}) => {
    const children = [];
    const listeners = {};
    let htmlStr = '';
    const el = {
      tagName: tag.toUpperCase(),
      className,
      style: {},
      scrollTop: 0,
      classList: {
        add(cls) { el.className = Array.from(new Set([...String(el.className || '').split(/\s+/).filter(Boolean), cls])).join(' '); },
        remove(cls) { el.className = String(el.className || '').split(/\s+/).filter(c => c && c !== cls).join(' '); },
      },
      dataset: Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5), v])),
      children,
      parentElement: null,
      shadowRoot: null,
      attributes: { ...attrs },
      get innerHTML() { return htmlStr; },
      set innerHTML(val) {
        htmlStr = String(val || '');
        children.length = 0;
        const tagRe = /<([a-zA-Z0-9-]+)([^>]*)>/g;
        let m;
        while ((m = tagRe.exec(htmlStr))) {
          if (m[1].startsWith('/')) continue;
          const attrStr = m[2];
          const clsMatch = attrStr.match(/class="([^"]*)"/);
          const parsedAttrs = {};
          for (const am of attrStr.matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)) {
            parsedAttrs[am[1]] = am[2];
          }
          const node = makeEl(m[1], clsMatch ? clsMatch[1] : '', parsedAttrs);
          node.parentElement = el;
          children.push(node);
        }
      },
      textContent: '',
      hidden: false,
      id: attrs.id || '',
      matches(sel) {
        return sel.split(',').some(s => {
          s = s.trim();
          if (s === 'button' || s === '[role="button"]') return el.tagName === 'BUTTON' || el.attributes.role === 'button';
          return false;
        });
      },
      getAttribute(k) { return el.attributes[k] ?? null; },
      setAttribute(k, v) { el.attributes[k] = String(v); if (k === 'id') el.id = String(v); },
      hasAttribute(k) { return k in el.attributes; },
      removeAttribute(k) { delete el.attributes[k]; },
      appendChild(c) { c.parentElement = el; children.push(c); return c; },
      append(...nodes) { for (const n of nodes) el.appendChild(n); },
      after(n) {
        if (!el.parentElement) return;
        const sibs = el.parentElement.children;
        const idx = sibs.indexOf(el);
        n.parentElement = el.parentElement;
        sibs.splice(idx + 1, 0, n);
      },
      insertBefore(n, ref) {
        const idx = children.indexOf(ref);
        n.parentElement = el;
        children.splice(idx >= 0 ? idx : 0, 0, n);
      },
      remove() {
        if (!el.parentElement) return;
        const sibs = el.parentElement.children;
        const idx = sibs.indexOf(el);
        if (idx >= 0) sibs.splice(idx, 1);
        el.parentElement = null;
      },
      contains(target) {
        let cur = target;
        while (cur) { if (cur === el) return true; cur = cur.parentElement; }
        return false;
      },
      closest(sel) {
        const parts = sel.split(',').map(s => s.trim());
        let cur = el;
        while (cur) {
          for (const p of parts) {
            if (p.startsWith('#') && cur.id === p.slice(1)) return cur;
            if (p.startsWith('.') && String(cur.className).split(/\s+/).includes(p.slice(1).replace(/\\/g, ''))) return cur;
            if (cur.tagName.toLowerCase() === p.toLowerCase()) return cur;
          }
          cur = cur.parentElement;
        }
        return null;
      },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      dispatchEvent(type, ev = { stopPropagation() {} }) { for (const fn of (listeners[type] || [])) fn(ev); },
      attachShadow() {
        el.shadowRoot = makeEl('SHADOW');
        el.shadowRoot.querySelector = (q) => findAll(el.shadowRoot, q)[0] || null;
        return el.shadowRoot;
      },
      getBoundingClientRect: () => el._rect || { left: 293, top: 200, width: 24, height: 24, right: 317, bottom: 224 },
      querySelector: (q) => findAll(el, q)[0] || null,
      querySelectorAll: (q) => findAll(el, q),
      get nextElementSibling() {
        const s = el.parentElement?.children || [];
        return s[s.indexOf(el) + 1] || null;
      },
    };
    return el;
  };
  const findAll = (root, sel) => {
    const out = [];
    const check = (node) => {
      if (sel === ':scope > [data-agy-turn-host]') {
        return root.children.filter(c => 'data-agy-turn-host' in c.attributes);
      }
      if (sel === ':scope > span:not([data-agy-turn-host])') {
        return root.children.filter(c => c.tagName === 'SPAN' && !('data-agy-turn-host' in c.attributes));
      }
      const walk = (n) => {
        for (const c of n.children) {
          if (sel === '.surface-composer' && String(c.className).includes('surface-composer')) out.push(c);
          else if (sel === '.agy-composer-footer' && String(c.className).includes('agy-composer-footer')) out.push(c);
          else if (sel === '.agy-composer-footer > div:first-child' && n === root && String(c.className).includes('agy-composer-footer')) {}
          else if (sel === 'button, [role="button"]' && (c.tagName === 'BUTTON' || c.attributes.role === 'button')) out.push(c);
          else if (sel === '[data-agy-turn-host]' && 'data-agy-turn-host' in c.attributes) out.push(c);
          else if (sel === '[data-agy-pad]' && 'data-agy-pad' in c.attributes) out.push(c);
          else if (sel.startsWith('[data-k="') && c.attributes['data-k'] === sel.slice(9, -2)) out.push(c);
          else if (sel.startsWith('[data-v="') && c.attributes['data-v'] === sel.slice(9, -2)) out.push(c);
          else if (sel.startsWith('.') && String(c.className).split(/\s+/).includes(sel.slice(1))) out.push(c);
          walk(c);
        }
      };
      walk(node);
      return out;
    };
    if (sel.startsWith(':scope')) return check(root);
    return check(root);
  };

  const body = makeEl('BODY');
  const outer = makeEl('DIV', 'pb-4');
  const wrap = makeEl('DIV', 'flex flex-col w-full shrink-0');
  const surface = makeEl('DIV', 'surface-composer');
  surface._rect = { left: 293, top: 728, width: 768, height: 82, right: 1061, bottom: 810 };
  const cf = makeEl('DIV', 'agy-composer-footer');
  cf._rect = { left: 293, top: 778, width: 768, height: 32, right: 1061, bottom: 810 };
  surface.appendChild(cf);
  wrap.appendChild(surface);

  // Assistant reply action bar (w-full justify-between -> d2 -> d1 -> 好的回答)
  const d3 = makeEl('DIV', 'flex w-full flex-wrap items-center justify-between');
  d3._rect = { left: 293, top: 600, width: 768, height: 24, right: 1061, bottom: 624 };
  const d2 = makeEl('DIV', 'flex min-w-0 items-center justify-end');
  const ageSpan = makeEl('SPAN', 'text-xs');
  ageSpan.textContent = '1分钟前';
  const d1 = makeEl('DIV', 'flex shrink-0 items-center');
  const goodBtn = makeEl('BUTTON', 'agy-button', { 'aria-label': '好的回答' });
  goodBtn._rect = { left: 1009, top: 600, width: 24, height: 24, right: 1033, bottom: 624 };
  d1.appendChild(goodBtn);
  d2.append(ageSpan, d1);
  d3.appendChild(d2);

  // Decoy user input undo button must be ignored
  const userStep = makeEl('DIV', 'group/user-input-step');
  const undoBtn = makeEl('BUTTON', '', { 'aria-label': 'Undo to this point' });
  userStep.appendChild(undoBtn);

  outer.append(userStep, d3, wrap);
  body.appendChild(outer);

  const byId = (id) => findAll(body, '#').concat([]) && (() => {
    let found = null;
    const scan = (n) => { for (const c of n.children) { if (c.id === id) found = c; scan(c); } };
    scan(body);
    return found;
  })();
  const ctx = vm.createContext({
    globalThis: null,
    location: { pathname: '/c/11111111-1111-1111-1111-111111111111', href: 'https://127.0.0.1:5000/c/11111111-1111-1111-1111-111111111111' },
    window: { innerWidth: 1440, innerHeight: 851 },
    document: {
      body,
      hasFocus: () => true,
      createElement: (t) => makeEl(t),
      getElementById: byId,
      addEventListener() {},
      removeEventListener() {},
      querySelector: (sel) => {
        if (sel === '.surface-composer, .agy-composer-footer > div:first-child') return findAll(body, '.surface-composer')[0] || null;
        return findAll(body, sel)[0] || null;
      },
      querySelectorAll: (sel) => findAll(body, sel),
    },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (fn) => 1,
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout,
  });
  ctx.globalThis = ctx;

  assert.equal(vm.runInContext(bundle.code, ctx), true);
  const sampleData = {
    session: {
      turnsCount: 1,
      stepsCount: 14,
      mainStepsCount: 4,
      subagentStepsCount: 10,
      compactionsCount: 2,
      subagentCount: 1,
      modelSec: 4,
      toolSec: 2,
      avgTtftSec: 1.2,
      tps: 120,
      modelBreakdown: [
        {
          model: 'Gemini 4 Neon',
          modelId: 'gemini-4-neon',
          reqCount: 1,
          total: 50000,
          tokens: 50000,
          uncached: 10000,
          cached: 39500,
          output: 500,
          cacheHitPct: 79.8,
          modelSec: 1.5,
          avgTtftSec: 1.0,
          tps: 80,
        },
        {
          model: 'Gemini 4 Hydrogen',
          modelId: 'gemini-4-hydrogen',
          reqCount: 3,
          total: 110000,
          tokens: 110000,
          uncached: 1000,
          cached: 108500,
          output: 500,
          cacheHitPct: 99.1,
          modelSec: 2.5,
          avgTtftSec: 1.3,
          tps: 140,
        },
      ],
    },
    tokens: { total: 160000, mainTotal: 150000, subagentTotal: 10000, uncached: 1000, cached: 158000, output: 1000, cacheHitPct: 99.4 },
    context: { usedTokens: 159000, maxTokens: 512000, usedPct: 31, categories: [] },
    subagents: [{ id: 'sub-1', role: 'Code Reviewer', type: 'research', model: 'Orchestrator (Neon)', stepsCount: 10, totalTokens: 10000, isStreaming: false }],
    turns: [{
      turnIndex: 0,
      completed: true,
      hasReply: true,
      total: 160000,
      cacheHitPct: 99.4,
      uncached: 1000,
      cached: 158000,
      output: 1000,
      stepsCount: 14,
      compactionsCount: 1,
      subagentCount: 1,
      subagentTokens: 10000,
      subagentSteps: 10,
      subagents: [{ id: 'sub-1', role: 'Code Reviewer', type: 'research', model: 'Orchestrator (Neon)', stepsCount: 10, totalTokens: 10000 }],
      modelSec: 4,
      toolSec: 2,
      avgTtftSec: 1.2,
      tps: 120,
      endedAtMs: Date.now() - 60_000,
      model: 'Gemini 4 Hydrogen',
      modelBreakdown: [
        {
          model: 'Gemini 4 Neon',
          modelId: 'gemini-4-neon',
          reqCount: 1,
          total: 50000,
          tokens: 50000,
          uncached: 10000,
          cached: 39500,
          output: 500,
          cacheHitPct: 79.8,
          modelSec: 1.5,
          avgTtftSec: 1.0,
          tps: 80,
        },
        {
          model: 'Gemini 4 Hydrogen',
          modelId: 'gemini-4-hydrogen',
          reqCount: 3,
          total: 110000,
          tokens: 110000,
          uncached: 1000,
          cached: 108500,
          output: 500,
          cacheHitPct: 99.1,
          modelSec: 2.5,
          avgTtftSec: 1.3,
          tps: 140,
        },
      ],
    }],
    prefs: { language: 'zh-CN', enableFooterBar: true, enableTurnPills: true },
  };
  assert.equal(ctx.__agyMonitorDeck.apply(sampleData, '/c/11111111-1111-1111-1111-111111111111', 123456), true);

  // Verify standalone footer host mounted AFTER surface-composer (outside it!)
  const footerHost = byId('agy-monitor-footer-host');
  assert.ok(footerHost);
  assert.equal(surface.contains(footerHost), false);
  assert.equal(surface.nextElementSibling, footerHost);
  assert.ok(footerHost.style.cssText.includes('padding:5px 0 0'));
  assert.equal(outer.getAttribute('data-agy-pad'), '1');
  assert.ok(byId('agy-monitor-layout-style')?.textContent?.includes('padding-bottom: 5px !important'));
  assert.equal(footerHost.shadowRoot.querySelector('[data-v="session"]').textContent, '1 轮 14 步 · 120 tok/s');
  assert.equal(footerHost.shadowRoot.querySelector('[data-v="tokens"]').textContent, '160K tok · 缓存命中 99%');
  assert.equal(footerHost.shadowRoot.querySelector('[data-v="context"]').textContent, '31%');
  const ringSpanHtml = footerHost.shadowRoot.querySelector('[data-v="ring"]').innerHTML;
  assert.ok(ringSpanHtml.includes('display:block'), 'Context ring SVG must use display:block to avoid baseline shift');
  assert.ok(footerHost.shadowRoot.children[0].textContent.includes('.agm-pill [data-v="ring"]'), 'Footer style must center ring span wrapper');
  assert.equal(ctx.__agyMonitorDeck.readState(123456).matchedTurnFooters, 1);

  // Hover opens non-pinned preview that hides on mouseleave; click pins card so leaving stays open & subtabs work
  const sessionPillBtn = footerHost.shadowRoot.querySelector('[data-k="session"]');
  sessionPillBtn.dispatchEvent('mouseenter');
  const popCard = byId('agy-monitor-popover-host')?.shadowRoot?.querySelector('.agm-card');
  assert.ok(popCard && !popCard.hidden);
  assert.equal(popCard.className.split(/\s+/).includes('pinned'), false);
  sessionPillBtn.dispatchEvent('mouseleave');
  await new Promise(r => setTimeout(r, 120));
  assert.equal(popCard.hidden, true);

  sessionPillBtn.dispatchEvent('click', { stopPropagation() {} });
  assert.equal(popCard.hidden, false);
  assert.equal(popCard.className.split(/\s+/).includes('pinned'), true);
  sessionPillBtn.dispatchEvent('mouseleave');
  await new Promise(r => setTimeout(r, 120));
  assert.equal(popCard.hidden, false);
  for (const needle of ['上下文压缩', '2 次', '子会话', '1 个 · 10 步', '分模型 (2)']) {
    assert.ok(popCard.innerHTML.includes(needle), `Missing session popover text: ${needle}`);
  }
  popCard.querySelectorAll('.agm-subtab')[1].dispatchEvent('click', { stopPropagation() {} });
  for (const needle of ['Gemini 4 Neon', '79.8%', '1.5 秒', 'Gemini 4 Hydrogen', '99.1%', '140 tok/s']) {
    assert.ok(popCard.innerHTML.includes(needle), `Missing session by-model popover text: ${needle}`);
  }

  // Click token pill (resets sub-tab to summary), then switch to "分模型 (2)" and verify live refresh preserves it
  const tokensPillBtn = footerHost.shadowRoot.querySelector('[data-k="tokens"]');
  tokensPillBtn.dispatchEvent('click', { stopPropagation() {} });
  assert.ok(popCard.innerHTML.includes('含子会话') && popCard.innerHTML.includes('10,000 tok (1 个)'));
  popCard.querySelectorAll('.agm-subtab')[1].dispatchEvent('click', { stopPropagation() {} });
  for (const needle of ['Gemini 4 Neon', '79.8%', '10,000 tok', '39,500 tok', 'Gemini 4 Hydrogen', '99.1%', '108,500 tok']) {
    assert.ok(popCard.innerHTML.includes(needle), `Missing tokens by-model popover text: ${needle}`);
  }
  assert.equal(ctx.__agyMonitorDeck.apply(sampleData, '/c/11111111-1111-1111-1111-111111111111', 123456), true);
  assert.ok(popCard.innerHTML.includes('108,500 tok'), 'Live apply() should preserve pinned tokens models sub-tab');

  // Identical or live-updated apply() preserves popCard.scrollTop cleanly; switching subtabs resets it
  popCard.scrollTop = 42;
  assert.equal(ctx.__agyMonitorDeck.apply(sampleData, '/c/11111111-1111-1111-1111-111111111111', 123456), true);
  assert.equal(popCard.scrollTop, 42);
  const updatedSample = { ...sampleData, tokens: { ...sampleData.tokens, total: 161000 } };
  assert.equal(ctx.__agyMonitorDeck.apply(updatedSample, '/c/11111111-1111-1111-1111-111111111111', 123456), true);
  assert.equal(popCard.scrollTop, 42);
  popCard.querySelectorAll('.agm-subtab')[0].dispatchEvent('click', { stopPropagation() {} });
  assert.equal(popCard.scrollTop, 0);

  // Short viewport clamp ensures top never goes below 8px
  ctx.window.innerHeight = 120;
  popCard._rect = { left: 0, top: 0, width: 280, height: 180, right: 280, bottom: 180 };
  tokensPillBtn.dispatchEvent('click', { stopPropagation() {} }); // closes pinned
  tokensPillBtn.dispatchEvent('click', { stopPropagation() {} }); // re-opens pinned in short viewport
  assert.ok(parseInt(popCard.style.top, 10) >= 8, `Expected clamped top >= 8, got ${popCard.style.top}`);
  ctx.window.innerHeight = 851;
  delete popCard._rect;

  const turnHost = findAll(d3, '[data-agy-turn-host]')[0];
  assert.ok(turnHost);
  assert.equal(turnHost.shadowRoot.querySelector('[data-v="txt"]').textContent, '用量 160K tok');

  // Click per-turn pill, verify summary + switch to per-turn "分模型 (2)" view
  const turnPillBtn = turnHost.shadowRoot.querySelector('.agm-turn-pill');
  turnPillBtn.dispatchEvent('click', { stopPropagation() {} });
  assert.ok(popCard && !popCard.hidden);
  for (const needle of ['2 个模型', 'Gemini 4 Neon', '1 次', 'Gemini 4 Hydrogen', '3 次', '子会话', '1 个 · 10K tok (10 步)', '上下文压缩', '本轮步数', '14 步', '模型用时', '4.0 秒', '工具调用用时', '2.0 秒', '首 token 平均（TTFT）', '1.2 秒', '输出速度（TPS）', '120 tok/s']) {
    assert.ok(popCard.innerHTML.includes(needle), `Missing turn popover text: ${needle}`);
  }
  popCard.querySelectorAll('.agm-subtab')[1].dispatchEvent('click', { stopPropagation() {} });
  for (const needle of ['Gemini 4 Neon', '79.8%', '80 tok/s', 'Gemini 4 Hydrogen', '99.1%', '140 tok/s']) {
    assert.ok(popCard.innerHTML.includes(needle), `Missing turn by-model popover text: ${needle}`);
  }
  assert.ok(footerHost.shadowRoot.querySelector('[data-k="context"]').style.color.includes('hsl(123,'));
  assert.ok(footerHost.shadowRoot.querySelector('[data-v="ring"]').innerHTML.includes('hsl(123,'));

  // High context usage shifts smoothly to yellow-green (hue ~84deg), never amber/red
  const highCtxData = { ...sampleData, context: { usedTokens: 496640, maxTokens: 512000, usedPct: 97, categories: [] } };
  assert.equal(ctx.__agyMonitorDeck.apply(highCtxData, '/c/11111111-1111-1111-1111-111111111111', 123456), true);
  assert.ok(footerHost.shadowRoot.querySelector('[data-k="context"]').style.color.includes('hsl(84,'));
  assert.ok(footerHost.shadowRoot.querySelector('[data-v="ring"]').innerHTML.includes('hsl(84,'));
  assert.equal(footerHost.shadowRoot.querySelector('[data-v="ring"]').innerHTML.includes('#ef4444'), false);
  assert.equal(footerHost.shadowRoot.querySelector('[data-v="ring"]').innerHTML.includes('#f59e0b'), false);

  // Verify sidebar HTML + embedded JS script compiles cleanly with zero syntax errors
  const html = renderSidebarHtml();
  assert.ok(html.includes('AGY监控'));
  assert.ok(html.includes('data-tab="usage"'));
  assert.ok(html.includes('/api/usage-stats'));
  assert.ok(html.includes('showCostEstimate'));
  assert.ok(html.includes('u-heat-4'));
  assert.ok(html.includes('Provider / Model'));
  assert.ok(html.includes('分模型'));
  assert.ok(html.includes('lastConvId'));
  assert.ok(html.includes('lastOverviewHtml'));
  assert.ok(html.includes('lastTurnsHtml'));
  assert.ok(html.includes('turnSubTabs'));
  assert.ok(html.includes('上下文压缩'));
  assert.ok(html.includes('子会话明细'));
  assert.ok(html.includes('含子会话'));
  assert.ok(html.includes('本轮步数'));
  assert.ok(html.includes('turn.modelSec'));
  assert.ok(html.includes('turn.toolSec'));
  assert.ok(html.includes('turn.avgTtftSec'));
  assert.ok(html.includes('turn.tps'));
  assert.ok(html.includes('parseQuotaBuckets'));
  assert.ok(html.includes('fmtQuotaReset'));
  assert.ok(html.includes('q-pills'));
  const scriptBody = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(scriptBody);
  new vm.Script(scriptBody);

  ctx.__agyMonitorDeck.dispose();
  assert.equal(byId('agy-monitor-layout-style'), null);
  assert.equal(outer.hasAttribute('data-agy-pad'), false);
});

test('createUsageStatsCollector splits days cleanly, avoids subagent double counting, computes cost/colors, and invalidates WAL cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-usage-test-'));
  let cDb = null;
  let mDb = null;
  let cDb2 = null;
  let aDb = null;
  try {
    const convDir = join(dir, 'convs');
    mkdirSync(convDir, { recursive: true });
    const cacheFile = join(dir, 'usage-cache.json');
    const stepMeta = (sec) => fieldBytes(1, tsPb(sec));
    const invokePayload = (id) => fieldBytes(140, fieldBytes(2, fieldBytes(3, fieldBytes(9, fieldBytes(5, fieldBytes(1, id))))));
    const nowDt = new Date();
    nowDt.setHours(10, 15, 0, 0);
    const todayMs = nowDt.getTime();
    const todaySec = Math.floor(todayMs / 1000);
    const yestSec = todaySec - 86400;
    const todayYmd = formatLocalYmd(todayMs);
    const yestYmd = formatLocalYmd(yestSec * 1000);

    const makeDb = (path) => {
      const db = new DatabaseSync(path);
      db.exec(`
        PRAGMA journal_mode=WAL;
        CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
        CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      `);
      return db;
    };

    const childId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    const mainPath = join(convDir, 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb.db');
    const childPath = join(convDir, `${childId}.db`);

    cDb = makeDb(childPath);
    cDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(0, 15, 3, stepMeta(todaySec), null);
    cDb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, makeGen({
      stepIdxs: [0], uncached: 1000, cached: 4000, out: 500, think: 200, ttftSec: 1, streamSec: 2,
      model: 'Gemini 4 Flash', modelId: 'gemini-4-flash',
    }));
    cDb.close();
    cDb = null;

    mDb = makeDb(mainPath);
    // Yesterday step + invoke_subagent step referencing childId + today step at hour 10
    mDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(0, 15, 3, stepMeta(yestSec), null);
    mDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(1, 132, 3, stepMeta(todaySec), invokePayload(childId));
    mDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(2, 15, 3, stepMeta(todaySec), null);
    mDb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, makeGen({
      stepIdxs: [0], uncached: 2000, cached: 8000, out: 1000, think: 600, ttftSec: 2, streamSec: 2,
      model: 'Claude Opus 4.6', modelId: 'claude-opus-4-6',
    }));
    mDb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(1, makeGen({
      stepIdxs: [2], uncached: 3000, cached: 7000, out: 800, think: 300, ttftSec: 1, streamSec: 3,
      model: 'Claude Opus 4.6', modelId: 'claude-opus-4-6',
    }));
    mDb.close();
    mDb = null;

    const collector = createUsageStatsCollector({ convDir, cacheFile });
    const s1 = collector.readStats({ nowMs: todayMs });
    assert.equal(s1.todayYmd, todayYmd);
    assert.equal(s1.dbCount, 2);
    // Yesterday has only main gen 0 (Claude Opus: 2000+8000+1000 = 11000)
    assert.equal(s1.days[yestYmd].total, 11000);
    assert.equal(s1.days[yestYmd].thinking, 600);
    assert.equal(s1.days[yestYmd].reply, 400);
    // Today has main gen 1 (10800) + child gen 0 (5500) = 16300, counted ONCE (no double counting!)
    assert.equal(s1.days[todayYmd].total, 16300);
    assert.equal(s1.days[todayYmd].thinking, 500);
    assert.equal(s1.days[todayYmd].reply, 800);
    assert.equal(s1.days[todayYmd].reqs, 2);
    assert.equal(s1.todayHours[10].total, 16300);
    assert.equal(s1.todayHours[11].total, 0);

    // Persisted disk cache test with fresh collector instance
    const persisted = JSON.parse(readFileSync(cacheFile, 'utf8'));
    assert.equal(Object.keys(persisted.files).length, 2);

    // Modify child WAL (keep open to keep -wal file non-empty) and verify WAL invalidation
    cDb2 = new DatabaseSync(childPath);
    cDb2.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(1, 15, 3, stepMeta(todaySec + 3600), null);
    cDb2.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(1, makeGen({
      stepIdxs: [1], uncached: 500, cached: 1500, out: 200, think: 50, ttftSec: 1, streamSec: 1,
      model: 'Gemini 4 Flash', modelId: 'gemini-4-flash',
    }));
    const s2 = createUsageStatsCollector({ convDir, cacheFile }).readStats({ nowMs: todayMs });
    assert.equal(s2.days[todayYmd].total, 18500);
    assert.equal(s2.todayHours[11].total, 2200);
    cDb2.close();
    cDb2 = null;

    // Cost estimation & collision-free model-family colors
    const opusCost = estimateModelCost('Claude Opus 4.6', 1_000_000, 1_000_000, 100_000);
    assert.ok(Math.abs(opusCost.actualUsd - 8.0) < 1e-6); // 5.0 + 0.5 + 2.5
    assert.ok(Math.abs(opusCost.savedUsd - 4.5) < 1e-6); // (1M * (5.0 - 0.5))
    const colors = assignModelColors([
      { name: 'Claude Opus 4.6', total: 500 },
      { name: 'Claude Opus 4.5', total: 300 },
      { name: 'Gemini 4 Hydrogen', total: 400 },
      { name: 'Gemini 3.8 Flash', total: 200 },
      { name: 'GPT-5.3 Codex', total: 250 },
    ]);
    assert.equal(new Set(Object.values(colors)).size, 5);
    assert.equal(colors['Claude Opus 4.6'], '#d97757');
    assert.equal(colors['GPT-5.3 Codex'], '#10b981');

    // Timezone signature change invalidates usage cache and re-buckets cleanly
    const rawCache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    assert.ok(typeof rawCache.tz === 'string' && rawCache.tz.length > 0);
    rawCache.tz = 'off=9999|tz=FakeZone|iana=FakeZone';
    writeFileSync(cacheFile, JSON.stringify(rawCache), 'utf8');
    const sTz = createUsageStatsCollector({ convDir, cacheFile }).readStats({ nowMs: todayMs });
    assert.equal(sTz.days[todayYmd].total, 18500);
    const updatedRawCache = JSON.parse(readFileSync(cacheFile, 'utf8'));
    assert.notEqual(updatedRawCache.tz, 'off=9999|tz=FakeZone|iana=FakeZone');

    // Async worker collector returns identical stats, coalesces calls, and closes cleanly
    const asyncCollector = createAsyncUsageStatsCollector({ convDir, cacheFile });
    try {
      const [a1, a2] = await Promise.all([
        asyncCollector.readStats({ nowMs: todayMs }),
        asyncCollector.readStats({ nowMs: todayMs }),
      ]);
      assert.equal(a1.days[todayYmd].total, 18500);
      assert.equal(a2.days[todayYmd].total, 18500);
    } finally {
      await asyncCollector.close();
    }

    // Pure-streaming TPS + Claude unsplit thinkingTrackedOutput + deleted-DB archive retention
    const archPath = join(convDir, 'cccccccc-3333-4333-8333-cccccccccccc.db');
    aDb = makeDb(archPath);
    aDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(0, 15, 3, stepMeta(todaySec), null);
    aDb.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)').run(1, 15, 3, stepMeta(todaySec), null);
    aDb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(0, makeGen({
      stepIdxs: [0], uncached: 100, cached: 900, out: 120, think: 0, ttftSec: 2, streamSec: 0,
      model: 'Claude Opus 5.5 (High)', modelId: 'claude-opus-5-5',
    }));
    aDb.prepare('INSERT INTO gen_metadata VALUES (?, ?)').run(1, makeGen({
      stepIdxs: [1], uncached: 100, cached: 900, out: 240, think: 40, ttftSec: 1.5, streamSec: 2.5,
      model: 'Gemini 4 Neon', modelId: 'gemini-4-neon',
    }));
    aDb.close();
    aDb = null;

    const s3 = createUsageStatsCollector({ convDir, cacheFile }).readStats({ nowMs: todayMs });
    const claudeStat = s3.days[todayYmd].byModel['Claude Opus 5.5 (High)'];
    const neonStat = s3.days[todayYmd].byModel['Gemini 4 Neon'];
    // Unsplit Claude (think=0): excluded from thinkingTrackedOutput; streamSec=0 excluded from timedOutput/timedModelSec
    assert.equal(claudeStat.thinkingTrackedOutput, 0);
    assert.equal(claudeStat.timedOutput, 0);
    assert.equal(claudeStat.timedModelSec, 0);
    // Gemini timedModelSec uses pure streaming duration (2.5), excluding TTFT (1.5)
    assert.equal(neonStat.thinkingTrackedOutput, 240);
    assert.equal(neonStat.timedOutput, 240);
    assert.ok(Math.abs(neonStat.timedModelSec - 2.5) < 1e-6);

    // Delete archPath from disk: normal refresh preserves archived history; forceRefresh clears stale deleted DB
    rmSync(archPath, { force: true });
    rmSync(`${archPath}-wal`, { force: true });
    rmSync(`${archPath}-shm`, { force: true });
    const sArch = createUsageStatsCollector({ convDir, cacheFile }).readStats({ nowMs: todayMs });
    assert.equal(sArch.days[todayYmd].byModel['Gemini 4 Neon'].total, 1240);
    assert.equal(sArch.days[todayYmd].total, 18500 + 1120 + 1240);

    const sForce = createUsageStatsCollector({ convDir, cacheFile }).readStats({ nowMs: todayMs, forceRefresh: true });
    assert.equal(sForce.days[todayYmd].byModel['Gemini 4 Neon'], undefined);
    assert.equal(sForce.days[todayYmd].total, 18500);
  } finally {
    try { cDb?.close(); } catch {}
    try { mDb?.close(); } catch {}
    try { cDb2?.close(); } catch {}
    try { aDb?.close(); } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('buildConversationTelemetry handles 200-turn 1200-step session accurately in linear time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-large-conv-'));
  let db = null;
  try {
    const dbPath = join(dir, 'large.db');
    db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, metadata BLOB, step_payload BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      BEGIN;
    `);
    const insStep = db.prepare('INSERT INTO steps VALUES (?, ?, ?, ?, ?)');
    const insGen = db.prepare('INSERT INTO gen_metadata VALUES (?, ?)');
    const baseSec = 1_760_000_000;
    let genIdx = 0;
    for (let t = 0; t < 200; t++) {
      const sBase = t * 6;
      insStep.run(sBase, 14, 3, fieldBytes(1, tsPb(baseSec + t * 10)), null);
      insStep.run(sBase + 1, 5, 3, fieldBytes(1, tsPb(baseSec + t * 10 + 1)), null);
      insStep.run(sBase + 2, 5, 3, fieldBytes(1, tsPb(baseSec + t * 10 + 2)), null);
      insStep.run(sBase + 3, 5, 3, fieldBytes(1, tsPb(baseSec + t * 10 + 3)), null);
      insStep.run(sBase + 4, 5, 3, fieldBytes(1, tsPb(baseSec + t * 10 + 4)), null);
      insStep.run(sBase + 5, 15, 3, fieldBytes(1, tsPb(baseSec + t * 10 + 5)), null);
      insGen.run(genIdx++, makeGen({ stepIdxs: [sBase + 5], uncached: 100, cached: 400, out: 50, think: 10, ttftSec: 1, streamSec: 1, model: 'Gemini 4 Flash', modelId: 'gemini-4-flash' }));
    }
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
    db.close();
    db = null;

    const snap = buildConversationTelemetry(dbPath);
    assert.equal(snap.session.turnsCount, 200);
    assert.equal(snap.session.stepsCount, 1200);
    assert.equal(snap.turns.length, 200);
    assert.equal(snap.tokens.total, 200 * 550);
    assert.equal(snap.turns[0].total, 550);
    assert.equal(snap.turns[199].total, 550);
    assert.equal(snap.turns[199].completed, true);
  } finally {
    try { db?.close(); } catch {}
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

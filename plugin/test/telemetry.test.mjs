import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fmtCompact, fmtDur, fmtExact, fmtPct, fmtTps, esc } from '../sidecars/agy_monitor/pb.mjs';
import { buildConversationTelemetry, createSnapshotCache, mergeIntervalsSec, parseGenRow } from '../sidecars/agy_monitor/telemetry.mjs';
import { normalizeSettings, createSettingsStore } from '../sidecars/agy_monitor/settings.mjs';
import { buildRuntimeBundle, matchTurnBarsToCompleted, parseRelativeAgeMs } from '../sidecars/agy_monitor/injector.mjs';
import { renderSidebarHtml } from '../sidecars/agy_monitor/ui.mjs';
import { createTelemetryController, EMPTY_DATA } from '../sidecars/agy_monitor/server.mjs';

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
  return Buffer.concat([fieldVarint(1, sec), fieldVarint(2, nano)]);
}

function makeUsage({ uncached = 0, cached = 0, out = 0 } = {}) {
  return Buffer.concat([
    fieldVarint(2, uncached),
    fieldVarint(5, cached),
    fieldVarint(3, out),
    fieldVarint(10, out),
  ]);
}

function makeGen({ stepIdxs, uncached, cached, out, ttftSec, streamSec, model, modelId, breakdown, retries }) {
  const usage = makeUsage({ uncached, cached, out });
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
    assert.equal(res.turns[0].modelSec, 8);
    assert.equal(res.turns[0].toolSec, 6);
    assert.equal(res.turns[0].avgTtftSec, 1.5);
    assert.equal(res.turns[0].tps, 62.5);
    assert.equal('_ttftSum' in res.turns[0], false);
    assert.equal(res.turns[1].completed, true);
    assert.equal(res.turns[1].stepsCount, 2);
    assert.equal(res.turns[1].modelSec, 5);
    assert.equal(res.turns[1].toolSec, 0);
    assert.equal(res.turns[1].avgTtftSec, 3);
    assert.equal(res.turns[1].tps, 50);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
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
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime bundle and sidebar HTML compile cleanly and mount outside composer', () => {
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
    session: { turnsCount: 1, stepsCount: 4, modelSec: 4, toolSec: 2, avgTtftSec: 1.2, tps: 120 },
    tokens: { total: 160000, uncached: 1000, cached: 158000, output: 1000, cacheHitPct: 99.4 },
    context: { usedTokens: 159000, maxTokens: 512000, usedPct: 31, categories: [] },
    turns: [{
      turnIndex: 0,
      completed: true,
      hasReply: true,
      total: 160000,
      cacheHitPct: 99.4,
      uncached: 1000,
      cached: 158000,
      output: 1000,
      stepsCount: 4,
      modelSec: 4,
      toolSec: 2,
      avgTtftSec: 1.2,
      tps: 120,
      endedAtMs: Date.now() - 60_000,
      model: 'Gemini 4 Hydrogen',
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
  assert.equal(footerHost.shadowRoot.querySelector('[data-v="session"]').textContent, '1 轮 4 步 · 120 tok/s');
  assert.equal(footerHost.shadowRoot.querySelector('[data-v="tokens"]').textContent, '160K tok · 缓存命中 99%');
  assert.equal(footerHost.shadowRoot.querySelector('[data-v="context"]').textContent, '31%');
  assert.equal(ctx.__agyMonitorDeck.readState(123456).matchedTurnFooters, 1);
  const turnHost = findAll(d3, '[data-agy-turn-host]')[0];
  assert.ok(turnHost);
  assert.equal(turnHost.shadowRoot.querySelector('[data-v="txt"]').textContent, '用量 160K tok');

  // Click per-turn pill and verify popover card contains both token usage and session-stats rows
  const turnPillBtn = turnHost.shadowRoot.querySelector('.agm-turn-pill');
  turnPillBtn.dispatchEvent('click', { stopPropagation() {} });
  const popCard = byId('agy-monitor-popover-host')?.shadowRoot?.querySelector('.agm-card');
  assert.ok(popCard && !popCard.hidden);
  for (const needle of ['本轮步数', '4 步', '模型用时', '4.0 秒', '工具调用用时', '2.0 秒', '首 token 平均（TTFT）', '1.2 秒', '输出速度（TPS）', '120 tok/s']) {
    assert.ok(popCard.innerHTML.includes(needle), `Missing turn popover text: ${needle}`);
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
  assert.ok(html.includes('Provider / Model'));
  assert.ok(html.includes('本轮步数'));
  assert.ok(html.includes('turn.modelSec'));
  assert.ok(html.includes('turn.toolSec'));
  assert.ok(html.includes('turn.avgTtftSec'));
  assert.ok(html.includes('turn.tps'));
  const scriptBody = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
  assert.ok(scriptBody);
  new vm.Script(scriptBody);

  ctx.__agyMonitorDeck.dispose();
  assert.equal(byId('agy-monitor-layout-style'), null);
  assert.equal(outer.hasAttribute('data-agy-pad'), false);
});

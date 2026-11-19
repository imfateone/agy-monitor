import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { getClientFormattersScript } from './pb.mjs';

const INTERVAL_MS = 1000;
const INSTANCE_TS = Date.now();
const PORT_FILE =
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort')
    : process.platform === 'win32'
      ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity', 'DevToolsActivePort')
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Antigravity', 'DevToolsActivePort');

export function parseRelativeAgeMs(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (/(刚刚|刚才|just now)/i.test(s)) return 30_000;
  if (/(昨天|yesterday)/i.test(s)) return 86_400_000;
  const m = s.match(/(\d+)\s*(秒钟前|秒前|分钟前|分前|小时前|时前|天前|s(?:ec)?\s*ago|m(?:in)?\s*ago|h(?:r|our)?\s*ago|d(?:ay)?s?\s*ago)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith('秒') || unit.startsWith('s')) return n * 1000;
  if (unit.startsWith('分') || unit.startsWith('m')) return n * 60_000;
  if (unit.startsWith('小') || unit.startsWith('时') || unit.startsWith('h')) return n * 3_600_000;
  if (unit.startsWith('天') || unit.startsWith('d')) return n * 86_400_000;
  return null;
}

export function matchTurnBarsToCompleted(entries, completed, nowMs = Date.now()) {
  if (!entries?.length || !completed?.length) return [];
  let endIdx = completed.length - 1;
  const lastBar = entries[entries.length - 1];
  const lastTurn = completed[endIdx];
  if (lastBar?.barAgeMs != null && lastTurn?.endedAtMs) {
    const defaultErr = Math.abs(Math.max(0, nowMs - lastTurn.endedAtMs) - lastBar.barAgeMs);
    const tol = Math.max(120_000, lastBar.barAgeMs * 0.45);
    if (defaultErr > tol) {
      let bestK = endIdx;
      let bestAvgErr = Infinity;
      let bestLastErr = defaultErr;
      for (let k = completed.length - 1; k >= entries.length - 1; k--) {
        let sumErr = 0;
        let checked = 0;
        let lastErr = Infinity;
        for (let i = 0; i < entries.length; i++) {
          const bar = entries[entries.length - 1 - i];
          const turn = completed[k - i];
          if (bar?.barAgeMs != null && turn?.endedAtMs) {
            const err = Math.abs(Math.max(0, nowMs - turn.endedAtMs) - bar.barAgeMs);
            if (i === 0) lastErr = err;
            sumErr += err;
            checked++;
          }
        }
        if (checked === 0) continue;
        const avgErr = sumErr / checked;
        if (avgErr < bestAvgErr) {
          bestAvgErr = avgErr;
          bestK = k;
          bestLastErr = lastErr;
        }
      }
      if (bestK !== endIdx && bestLastErr < defaultErr * 0.5 && bestLastErr <= Math.max(300_000, lastBar.barAgeMs * 0.6)) {
        endIdx = bestK;
      }
    }
  }
  const pairs = [];
  const count = Math.min(entries.length, endIdx + 1);
  for (let i = 0; i < count; i++) {
    pairs.push({
      entry: entries[entries.length - 1 - i],
      turn: completed[endIdx - i],
    });
  }
  return pairs;
}

/**
 * Self-contained browser runtime installed inside Antigravity renderer pages via CDP.
 * Renders:
 *  1) AGY Monitor 3 capsules below the composer box (Session Stats | Token Usage | Context Ring)
 *  2) Per-turn usage pill ("用量 XXX tok") in each completed assistant turn footer
 */
function installRuntime(ownerTs, codeHash) {
  if (globalThis.__agyMonitorDeck?.owner > ownerTs) return 'superseded';
  if (globalThis.__agyMonitorDeck?.owner === ownerTs && globalThis.__agyMonitorDeck?.hash === codeHash) return true;
  globalThis.__agyMonitorDeck?.dispose?.();

  const state = {
    owner: ownerTs,
    hash: codeHash,
    lastData: null,
    lastPath: location.pathname,
    matchedTurnFooters: 0,
    footerMounted: false,
  };

  const FONT_STACK = '"Source Han Sans CN", "思源黑体 CN", "Source Han Sans SC", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", Arial, sans-serif';

  const LABELS = {
    'zh-CN': {
      sessionTitle: '会话统计',
      turnsSteps: (t, s) => `${t} 轮 ${s} 步`,
      modelTime: '模型用时',
      toolTime: '工具调用用时',
      avgTtft: '首 token 平均（TTFT）',
      outputTps: '输出速度（TPS）',
      tokTitle: 'Token 用量',
      cacheHit: '缓存命中',
      cacheHitPill: (p) => `缓存命中 ${p}`,
      uncachedIn: '未缓存输入',
      cachedRead: '缓存读取',
      output: '输出',
      ctxTitle: '上下文已用',
      turnPill: (tok) => `用量 ${tok} tok`,
      turnTitle: '本轮用量',
      modelLabel: '提供方 / 模型',
    },
    en: {
      sessionTitle: 'Session Stats',
      turnsSteps: (t, s) => `${t} turns ${s} steps`,
      modelTime: 'Model time',
      toolTime: 'Tool time',
      avgTtft: 'Avg TTFT',
      outputTps: 'Output speed (TPS)',
      tokTitle: 'Token Usage',
      cacheHit: 'Cache hit',
      cacheHitPill: (p) => `Cache ${p}`,
      uncachedIn: 'Uncached input',
      cachedRead: 'Cache read',
      output: 'Output',
      ctxTitle: 'Context used',
      turnPill: (tok) => `${tok} tok`,
      turnTitle: 'Turn Usage',
      modelLabel: 'Provider / Model',
    },
  };

  function contextColor(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    // Smooth gradient from green (142deg) to yellow-green (82deg), never orange or red.
    const hue = Math.round(142 - (p / 100) * 60);
    const sat = Math.round(68 - (p / 100) * 4);
    return `light-dark(hsl(${hue}, ${sat}%, 34%), hsl(${hue}, ${sat}%, 50%))`;
  }

  function makeRingSvg(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const r = 6.2;
    const c = 2 * Math.PI * r;
    const off = c * (1 - p / 100);
    const stroke = contextColor(p);
    return `<svg class="agm-ring" viewBox="0 0 18 18" style="width:14px;height:14px;transform:rotate(-90deg);flex-shrink:0"><circle cx="9" cy="9" r="${r}" fill="none" stroke="rgba(142,142,147,0.28)" stroke-width="2.4"/><circle cx="9" cy="9" r="${r}" fill="none" stroke="currentColor" style="stroke:${stroke}" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"/></svg>`;
  }

  // Ensure shared floating popover container (fixed positioning, never clipped by overflow:hidden)
  function ensurePopoverHost() {
    let popHost = document.getElementById('agy-monitor-popover-host');
    if (!popHost) {
      popHost = document.createElement('div');
      popHost.id = 'agy-monitor-popover-host';
      popHost.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483640;';
      const shadow = popHost.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        * { box-sizing: border-box; }
        .agm-card {
          position: fixed;
          min-width: 248px;
          max-width: min(320px, calc(100vw - 16px));
          background: var(--card, light-dark(#ffffff, #1e1e22));
          color: var(--foreground, light-dark(#18181b, #f4f4f5));
          border: 1px solid var(--border, light-dark(rgba(0,0,0,0.09), rgba(255,255,255,0.12)));
          border-radius: 12px;
          padding: 12px 14px;
          box-shadow: 0 10px 30px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.06);
          font-family: ${FONT_STACK};
          font-size: 13px;
          line-height: 1.4;
          pointer-events: auto;
          font-variant-numeric: tabular-nums;
          opacity: 0;
          transform: translateY(3px);
          transition: opacity 0.12s ease, transform 0.12s ease;
        }
        .agm-card.visible { opacity: 1; transform: translateY(0); }
        .agm-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding-bottom: 9px;
          margin-bottom: 9px;
          border-bottom: 1px solid var(--border, light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.10)));
        }
        .agm-head-left {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-weight: 600;
          color: var(--foreground, light-dark(#18181b, #f4f4f5));
          white-space: nowrap;
        }
        .agm-head-left svg { width: 14px; height: 14px; color: var(--muted-foreground, #71717a); flex-shrink: 0; }
        .agm-head-right {
          font-weight: 600;
          color: var(--foreground, light-dark(#18181b, #f4f4f5));
          white-space: nowrap;
        }
        .agm-rows { display: flex; flex-direction: column; gap: 7px; }
        .agm-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
        }
        .agm-row-k {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          color: var(--muted-foreground, light-dark(#71717a, #a1a1aa));
          white-space: nowrap;
        }
        .agm-row-v {
          color: var(--foreground, light-dark(#18181b, #f4f4f5));
          font-weight: 500;
          white-space: nowrap;
          text-align: right;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 175px;
        }
        .agm-dot {
          width: 7px;
          height: 7px;
          border-radius: 2px;
          flex-shrink: 0;
        }
        .agm-ctx-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 8px;
        }
        .agm-ctx-title { color: var(--muted-foreground, light-dark(#71717a, #a1a1aa)); font-weight: 500; }
        .agm-ctx-title b { color: var(--foreground, light-dark(#18181b, #f4f4f5)); font-weight: 600; margin-left: 4px; }
        .agm-ctx-frac { color: var(--foreground, light-dark(#18181b, #f4f4f5)); font-weight: 500; white-space: nowrap; }
        .agm-bar {
          width: 100%;
          height: 5px;
          border-radius: 999px;
          background: light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.12));
          display: flex;
          gap: 1.5px;
          overflow: hidden;
          margin-bottom: 10px;
        }
        .agm-bar-seg { height: 100%; border-radius: 999px; transition: width 0.2s ease; }
      `;
      const card = document.createElement('div');
      card.className = 'agm-card';
      card.hidden = true;
      shadow.append(style, card);
      document.body.appendChild(popHost);
    }
    return popHost;
  }

  let activeAnchor = null;
  let pinnedAnchor = null;
  let hideTimer = null;

  function showCard(anchorEl, html, pin = false) {
    clearTimeout(hideTimer);
    const popHost = ensurePopoverHost();
    const card = popHost.shadowRoot.querySelector('.agm-card');
    card.innerHTML = html;
    card.hidden = false;
    card.classList.remove('visible');
    activeAnchor = anchorEl;
    if (pin) pinnedAnchor = anchorEl;

    // Position above anchor if enough room, else below; clamp horizontally.
    card.style.left = '0px';
    card.style.top = '0px';
    const rect = anchorEl.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - cr.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - cr.width - 8));
    let top = rect.top - cr.height - 8;
    if (top < 8) top = Math.min(window.innerHeight - cr.height - 8, rect.bottom + 8);
    card.style.left = Math.round(left) + 'px';
    card.style.top = Math.round(top) + 'px';
    requestAnimationFrame(() => card.classList.add('visible'));
  }

  function scheduleHide(anchorEl) {
    if (pinnedAnchor && pinnedAnchor === anchorEl) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (pinnedAnchor) return;
      const popHost = document.getElementById('agy-monitor-popover-host');
      const card = popHost?.shadowRoot?.querySelector('.agm-card');
      if (card) {
        card.classList.remove('visible');
        card.hidden = true;
      }
      activeAnchor = null;
    }, 90);
  }

  function closeCard() {
    clearTimeout(hideTimer);
    pinnedAnchor = null;
    activeAnchor = null;
    const popHost = document.getElementById('agy-monitor-popover-host');
    const card = popHost?.shadowRoot?.querySelector('.agm-card');
    if (card) {
      card.classList.remove('visible');
      card.hidden = true;
    }
  }

  function bindCardInteractions(pillEl, getHtml) {
    pillEl.addEventListener('mouseenter', () => {
      if (pinnedAnchor && pinnedAnchor !== pillEl) return;
      showCard(pillEl, getHtml(), false);
    });
    pillEl.addEventListener('mouseleave', () => scheduleHide(pillEl));
    pillEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pinnedAnchor === pillEl) {
        closeCard();
      } else {
        showCard(pillEl, getHtml(), true);
      }
    });
  }

  const onDocClick = (e) => {
    const popHost = document.getElementById('agy-monitor-popover-host');
    const path = e.composedPath();
    if (popHost && path.includes(popHost)) return;
    if (pinnedAnchor && path.includes(pinnedAnchor)) return;
    closeCard();
  };
  const onDocKey = (e) => { if (e.key === 'Escape') closeCard(); };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);

  // Build HTML for the 4 AGY Monitor cards
  function buildSessionCardHtml(d) {
    const L = LABELS[d.prefs?.language === 'en' ? 'en' : 'zh-CN'];
    const isEn = d.prefs?.language === 'en';
    const s = d.session || {};
    return `
      <div class="agm-head">
        <span class="agm-head-left">${SVG_GAUGE}<span>${L.sessionTitle}</span></span>
        <span class="agm-head-right">${esc(L.turnsSteps(s.turnsCount || 0, s.stepsCount || 0))}</span>
      </div>
      <div class="agm-rows">
        <div class="agm-row"><span class="agm-row-k">${L.modelTime}</span><span class="agm-row-v">${esc(fmtDur(s.modelSec, isEn))}</span></div>
        <div class="agm-row"><span class="agm-row-k">${L.toolTime}</span><span class="agm-row-v">${esc(fmtDur(s.toolSec, isEn))}</span></div>
        <div class="agm-row"><span class="agm-row-k">${L.avgTtft}</span><span class="agm-row-v">${esc(s.avgTtftSec != null ? fmtDur(s.avgTtftSec, isEn) : '—')}</span></div>
        <div class="agm-row"><span class="agm-row-k">${L.outputTps}</span><span class="agm-row-v">${esc(fmtTps(s.tps))}</span></div>
      </div>`;
  }

  function buildTokensCardHtml(d) {
    const L = LABELS[d.prefs?.language === 'en' ? 'en' : 'zh-CN'];
    const t = d.tokens || {};
    return `
      <div class="agm-head">
        <span class="agm-head-left">${SVG_DB}<span>${L.tokTitle}</span></span>
        <span class="agm-head-right">${fmtExact(t.total)} tok</span>
      </div>
      <div class="agm-rows">
        <div class="agm-row"><span class="agm-row-k">${L.cacheHit}</span><span class="agm-row-v">${fmtPct(t.cacheHitPct, 0)}</span></div>
        <div class="agm-row"><span class="agm-row-k">${L.uncachedIn}</span><span class="agm-row-v">${fmtExact(t.uncached)} tok</span></div>
        <div class="agm-row"><span class="agm-row-k">${L.cachedRead}</span><span class="agm-row-v">${fmtExact(t.cached)} tok</span></div>
        <div class="agm-row"><span class="agm-row-k">${L.output}</span><span class="agm-row-v">${fmtExact(t.output)} tok</span></div>
      </div>`;
  }

  function buildContextCardHtml(d) {
    const isEn = d.prefs?.language === 'en';
    const L = LABELS[isEn ? 'en' : 'zh-CN'];
    const c = d.context || {};
    const max = c.maxTokens || 0;
    const used = c.usedTokens || 0;
    const cats = Array.isArray(c.categories) ? c.categories : [];
    const catSum = cats.reduce((s, item) => s + (item.tokens || 0), 0);
    const barDenom = max > 0 ? Math.max(max, catSum) : Math.max(1, catSum);
    const segs = cats.map(item => {
      const w = Math.max(0.5, (item.tokens / barDenom) * 100);
      return `<span class="agm-bar-seg" style="width:${w.toFixed(2)}%;background:${esc(item.color)}"></span>`;
    }).join('');
    const rows = cats.map(item => `
      <div class="agm-row">
        <span class="agm-row-k"><span class="agm-dot" style="background:${esc(item.color)}"></span><span>${esc(isEn ? item.en : item.zh)}</span></span>
        <span class="agm-row-v">~${fmtCompact(item.tokens)}</span>
      </div>`).join('');
    return `
      <div class="agm-ctx-head">
        <span class="agm-ctx-title">${L.ctxTitle}<b>${c.usedPct || 0}%</b></span>
        <span class="agm-ctx-frac">~${fmtCompact(used)} / ${max > 0 ? fmtCompact(max) : '--'}</span>
      </div>
      <div class="agm-bar">${segs}</div>
      <div class="agm-rows">${rows}</div>`;
  }

  function buildTurnCardHtml(turn, prefs) {
    const L = LABELS[prefs?.language === 'en' ? 'en' : 'zh-CN'];
    return `
      <div class="agm-head">
        <span class="agm-head-left">${SVG_DB}<span>${L.turnTitle}</span></span>
        <span class="agm-head-right">${fmtExact(turn.total)} tok</span>
      </div>
      <div class="agm-rows">
        <div class="agm-row"><span class="agm-row-k">${L.modelLabel}</span><span class="agm-row-v" title="${esc(turn.model || turn.modelId)}">${esc(turn.model || turn.modelId || '—')}</span></div>
        <div class="agm-row"><span class="agm-row-k">${L.cacheHit}</span><span class="agm-row-v">${fmtPct(turn.cacheHitPct, 1)}</span></div>
        <div class="agm-row"><span class="agm-row-k">${L.uncachedIn}</span><span class="agm-row-v">${fmtExact(turn.uncached)} tok</span></div>
        <div class="agm-row"><span class="agm-row-k">${L.cachedRead}</span><span class="agm-row-v">${fmtExact(turn.cached)} tok</span></div>
        <div class="agm-row"><span class="agm-row-k">${L.output}</span><span class="agm-row-v">${fmtExact(turn.output)} tok</span></div>
      </div>`;
  }

  // Mount standalone 3-pill strip on a dedicated bottom row below the chat composer box.
  function restoreOuterPad() {
    for (const el of document.querySelectorAll('[data-agy-pad]')) {
      el.style.paddingBottom = '';
      el.removeAttribute('data-agy-pad');
    }
  }

  function renderFooterStrip(d) {
    const surfaceComposer = document.querySelector('.surface-composer');
    const composerFooter = document.querySelector('.agy-composer-footer');
    const targetParent = surfaceComposer?.parentElement || composerFooter?.parentElement;
    if (!targetParent) {
      state.footerMounted = false;
      restoreOuterPad();
      return;
    }
    state.footerMounted = true;
    const enabled = d.prefs?.enableFooterBar !== false;
    let host = document.getElementById('agy-monitor-footer-host');
    if (!enabled) {
      host?.remove();
      restoreOuterPad();
      return;
    }
    if (!host) {
      host = document.createElement('div');
      host.id = 'agy-monitor-footer-host';
      host.style.cssText = 'display:flex;align-items:center;justify-content:safe center;width:100%;padding:6px 0 0;flex-shrink:0;overflow-x:auto;scrollbar-width:none;';
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = `
        * { box-sizing: border-box; }
        .agm-strip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          margin: 0 auto;
          font-family: ${FONT_STACK};
          font-size: 12px;
          font-variant-numeric: tabular-nums;
          color: var(--muted-foreground, light-dark(#52525b, #a1a1aa));
          user-select: none;
        }
        .agm-pill {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          height: 22px;
          padding: 0 8px;
          border-radius: 7px;
          border: none;
          background: transparent;
          color: inherit;
          font: inherit;
          white-space: nowrap;
          cursor: default;
          transition: background 0.14s ease, color 0.14s ease;
        }
        .agm-pill:hover {
          background: var(--secondary, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.10)));
          color: var(--foreground, light-dark(#18181b, #f4f4f5));
        }
        .agm-pill svg { width: 13.5px; height: 13.5px; flex-shrink: 0; opacity: 0.85; }
      `;
      const strip = document.createElement('div');
      strip.className = 'agm-strip';
      strip.innerHTML = `
        <button type="button" class="agm-pill" data-k="session">${SVG_GAUGE}<span data-v="session"></span></button>
        <button type="button" class="agm-pill" data-k="tokens">${SVG_DB}<span data-v="tokens"></span></button>
        <button type="button" class="agm-pill" data-k="context"><span data-v="ring"></span><span data-v="context"></span></button>
      `;
      shadow.append(style, strip);
      bindCardInteractions(strip.querySelector('[data-k="session"]'), () => buildSessionCardHtml(state.lastData));
      bindCardInteractions(strip.querySelector('[data-k="tokens"]'), () => buildTokensCardHtml(state.lastData));
      bindCardInteractions(strip.querySelector('[data-k="context"]'), () => buildContextCardHtml(state.lastData));
    }
    const anchorNode = surfaceComposer || composerFooter;
    if (anchorNode && anchorNode.nextElementSibling !== host) {
      anchorNode.after(host);
    } else if (!targetParent.contains(host)) {
      targetParent.appendChild(host);
    }
    const outerPad = (surfaceComposer || composerFooter)?.closest?.('.pb-4');
    if (outerPad && !outerPad.hasAttribute('data-agy-pad')) {
      outerPad.setAttribute('data-agy-pad', '1');
      outerPad.style.paddingBottom = '6px';
    }

    const L = LABELS[d.prefs?.language === 'en' ? 'en' : 'zh-CN'];
    const strip = host.shadowRoot.querySelector('.agm-strip');
    const s = d.session || {};
    const t = d.tokens || {};
    const c = d.context || {};

    const sEl = strip.querySelector('[data-v="session"]');
    const sText = `${L.turnsSteps(s.turnsCount || 0, s.stepsCount || 0)} · ${fmtTps(s.tps)}`;
    if (sEl.textContent !== sText) sEl.textContent = sText;

    const tEl = strip.querySelector('[data-v="tokens"]');
    const hitStr = fmtPct(t.cacheHitPct, 0);
    const tText = `${fmtCompact(t.total)} tok · ${L.cacheHitPill(hitStr)}`;
    if (tEl.textContent !== tText) tEl.textContent = tText;

    const cPill = strip.querySelector('[data-k="context"]');
    const pct = c.usedPct || 0;
    cPill.style.color = contextColor(pct);
    const rEl = strip.querySelector('[data-v="ring"]');
    const rSvg = makeRingSvg(pct);
    if (rEl.innerHTML !== rSvg) rEl.innerHTML = rSvg;
    const cEl = strip.querySelector('[data-v="context"]');
    const cText = `${pct}%`;
    if (cEl.textContent !== cText) cEl.textContent = cText;

    // Refresh pinned popover if open on footer strip
    if (pinnedAnchor && host.shadowRoot.contains(pinnedAnchor)) {
      const k = pinnedAnchor.dataset.k;
      const html = k === 'session' ? buildSessionCardHtml(d) : k === 'tokens' ? buildTokensCardHtml(d) : buildContextCardHtml(d);
      const card = document.getElementById('agy-monitor-popover-host')?.shadowRoot?.querySelector('.agm-card');
      if (card && !card.hidden) card.innerHTML = html;
    }
  }

  // Locate completed assistant turn feedback/action bars inside the active chat pane.
  function findTurnActionBars() {
    const composerFooter = document.querySelector('.agy-composer-footer');
    const cfRect = composerFooter?.getBoundingClientRect();
    const withinChatX = (r) => !cfRect || cfRect.width <= 0 || (r.left >= cfRect.left - 80 && r.right <= cfRect.right + 120);
    const results = new Map();

    // Primary matcher: Antigravity assistant response feedback buttons (e.g. 好的回答 / Good response).
    const feedbackBtns = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const btn of feedbackBtns) {
      if (btn.closest('.agy-composer-footer, pre, code, .group\\/user-input-step, #agy-monitor-footer-host, #agy-monitor-popover-host')) continue;
      const label = [btn.getAttribute('aria-label'), btn.getAttribute('title'), btn.getAttribute('data-testid')].filter(Boolean).join(' ');
      if (!/(好的回答|Good response|Thumbs up|点赞|helpful)/i.test(label)) continue;
      const r = btn.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.width > 48 || r.height > 48) continue;
      if (!withinChatX(r)) continue;
      const d1 = btn.parentElement;
      const d2 = d1?.parentElement;
      const d3 = d2?.parentElement;
      const ageEl = d2?.querySelector(':scope > span:not([data-agy-turn-host])') || d3?.querySelector(':scope > span:not([data-agy-turn-host])');
      const barAgeMs = parseRelativeAgeMs(ageEl?.textContent);
      if (d3 && /\bw-full\b/.test(String(d3.className || '')) && /\bjustify-between\b/.test(String(d3.className || ''))) {
        if (!results.has(d3)) results.set(d3, { bar: d3, mode: 'prepend', anchor: d2, barAgeMs });
      } else if (d1 && !results.has(d1)) {
        results.set(d1, { bar: d1, mode: 'append', anchor: null, barAgeMs });
      }
    }

    // Fallback matcher if feedback labels change in future Antigravity builds.
    if (results.size === 0 && composerFooter) {
      let chatRoot = composerFooter;
      for (let i = 0; i < 20 && chatRoot.parentElement && chatRoot.parentElement !== document.body; i++) {
        const p = chatRoot.parentElement;
        const r = p.getBoundingClientRect();
        chatRoot = p;
        if (r.height > window.innerHeight * 0.55 && r.width < window.innerWidth * 0.92 && p.querySelectorAll('button').length >= 8) break;
      }
      const candidates = new Set();
      for (const btn of chatRoot.querySelectorAll('button, [role="button"]')) {
        if (btn.closest('.agy-composer-footer, pre, code, .group\\/user-input-step, #agy-monitor-footer-host, #agy-monitor-popover-host')) continue;
        const r = btn.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.width > 44 || r.height > 44 || !withinChatX(r)) continue;
        if (!btn.querySelector('svg')) continue;
        const row = btn.parentElement;
        if (!row || row.closest('.agy-composer-footer, pre, code, .group\\/user-input-step')) continue;
        const rowBtns = Array.from(row.children).filter(el => el.matches?.('button, [role="button"]') && el.querySelector('svg'));
        if (rowBtns.length === 3 || (rowBtns.length >= 2 && rowBtns.length <= 5 && r.top > 72)) {
          const rr = row.getBoundingClientRect();
          if (rr.height > 0 && rr.height <= 48 && (!cfRect || rr.bottom <= cfRect.top + 8)) {
            candidates.add(row);
          }
        }
      }
      const arr = Array.from(candidates);
      for (const el of arr) {
        if (!arr.some(other => other !== el && el.contains(other))) {
          results.set(el, { bar: el, mode: 'append', anchor: null });
        }
      }
    }

    const list = Array.from(results.values());
    list.sort((a, b) => a.bar.getBoundingClientRect().top - b.bar.getBoundingClientRect().top);
    return list;
  }

  function renderTurnPills(d) {
    if (d.prefs?.enableTurnPills === false) {
      for (const el of document.querySelectorAll('[data-agy-turn-host]')) el.remove();
      state.matchedTurnFooters = 0;
      return;
    }
    const entries = findTurnActionBars();
    state.matchedTurnFooters = entries.length;
    const completed = (d.turns || []).filter(t => t.completed && t.hasReply && t.total > 0);
    const matchedPairs = matchTurnBarsToCompleted(entries, completed);
    const L = LABELS[d.prefs?.language === 'en' ? 'en' : 'zh-CN'];

    const usedBars = new Set();
    for (const { entry, turn } of matchedPairs) {
      const { bar, mode, anchor } = entry;
      usedBars.add(bar);

      let host = bar.querySelector(':scope > [data-agy-turn-host]');
      if (!host) {
        host = document.createElement('span');
        host.setAttribute('data-agy-turn-host', '1');
        host.style.cssText = mode === 'prepend'
          ? 'display:inline-flex;align-items:center;flex-shrink:0;'
          : 'display:inline-flex;align-items:center;margin-left:6px;flex-shrink:0;';
        const shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
          .agm-turn-pill {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            height: 22px;
            padding: 0 8px;
            border-radius: 6px;
            border: 1px solid var(--border, light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.10)));
            background: var(--secondary, light-dark(rgba(0,0,0,0.035), rgba(255,255,255,0.06)));
            color: var(--muted-foreground, light-dark(#71717a, #a1a1aa));
            font-family: ${FONT_STACK};
            font-size: 12px;
            font-variant-numeric: tabular-nums;
            white-space: nowrap;
            cursor: default;
            transition: background 0.14s ease, color 0.14s ease, border-color 0.14s ease;
          }
          .agm-turn-pill:hover {
            background: var(--secondary, light-dark(rgba(0,0,0,0.07), rgba(255,255,255,0.12)));
            color: var(--foreground, light-dark(#18181b, #f4f4f5));
          }
          .agm-turn-pill svg { width: 12.5px; height: 12.5px; flex-shrink: 0; opacity: 0.85; }
        `;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'agm-turn-pill';
        btn.innerHTML = `${SVG_DB}<span data-v="txt"></span>`;
        shadow.append(style, btn);
        bindCardInteractions(btn, () => buildTurnCardHtml(host._turnData, state.lastData?.prefs));
        if (mode === 'prepend' && anchor && anchor.parentElement === bar) {
          bar.insertBefore(host, anchor);
        } else {
          bar.appendChild(host);
        }
      }
      host._turnData = turn;
      const txtEl = host.shadowRoot.querySelector('[data-v="txt"]');
      const label = L.turnPill(fmtCompact(turn.total));
      if (txtEl.textContent !== label) txtEl.textContent = label;
      if (pinnedAnchor && host.shadowRoot.contains(pinnedAnchor)) {
        const card = document.getElementById('agy-monitor-popover-host')?.shadowRoot?.querySelector('.agm-card');
        if (card && !card.hidden) card.innerHTML = buildTurnCardHtml(turn, d.prefs);
      }
    }

    for (const stale of document.querySelectorAll('[data-agy-turn-host]')) {
      if (!usedBars.has(stale.parentElement)) stale.remove();
    }
  }

  let rafId = 0;
  const scheduleRender = () => {
    if (!state.lastData || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (!state.lastData) return;
      renderFooterStrip(state.lastData);
      renderTurnPills(state.lastData);
    });
  };
  const domObs = new MutationObserver((mutations) => {
    if (!state.lastData) return;
    if (mutations.every(m => m.target?.closest?.('#agy-monitor-footer-host, #agy-monitor-popover-host, [data-agy-turn-host]'))) return;
    scheduleRender();
  });
  if (document.body) domObs.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('scroll', scheduleRender, true);

  function inspectDomSample() {
    const footerHost = document.getElementById('agy-monitor-footer-host');
    const stripEl = footerHost?.shadowRoot?.querySelector('.agm-strip');
    const fr = stripEl?.getBoundingClientRect() || footerHost?.getBoundingClientRect();
    const sc = document.querySelector('.surface-composer');
    const sr = sc?.getBoundingClientRect();
    return {
      footerOutsideComposer: !!footerHost && !!sc && !sc.contains(footerHost),
      composerCenterX: sr ? Math.round(sr.left + sr.width / 2) : null,
      stripCenterX: fr ? Math.round(fr.left + fr.width / 2) : null,
      composerRect: sr ? [Math.round(sr.left), Math.round(sr.top), Math.round(sr.width), Math.round(sr.bottom)] : null,
      footerStripRect: fr ? [Math.round(fr.left), Math.round(fr.top), Math.round(fr.width), Math.round(fr.bottom)] : null,
      winH: window.innerHeight,
      matchedTurnFooters: state.matchedTurnFooters,
      turnPillsDom: document.querySelectorAll('[data-agy-turn-host]').length,
    };
  }

  globalThis.__agyMonitorDeck = {
    owner: ownerTs,
    hash: codeHash,
    readState(expectedOwner) {
      if (state.owner > expectedOwner) return 'superseded';
      return {
        owner: state.owner,
        hash: state.hash,
        href: location.href.split('?')[0],
        path: location.pathname,
        focused: typeof document.hasFocus === 'function' ? document.hasFocus() : false,
        hasData: !!state.lastData,
        hasFooter: !!document.querySelector('.surface-composer, .agy-composer-footer > div:first-child'),
        matchedTurnFooters: state.matchedTurnFooters,
        sample: inspectDomSample(),
      };
    },
    apply(data, path, expectedOwner) {
      if (state.owner > expectedOwner) return 'superseded';
      state.lastData = data;
      state.lastPath = path;
      state.applyCalls = (state.applyCalls || 0) + 1;
      renderFooterStrip(data);
      renderTurnPills(data);
      return true;
    },
    dispose() {
      domObs.disconnect();
      document.removeEventListener('scroll', scheduleRender, true);
      if (rafId) cancelAnimationFrame(rafId);
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKey);
      document.getElementById('agy-monitor-footer-host')?.remove();
      document.getElementById('agy-monitor-popover-host')?.remove();
      for (const el of document.querySelectorAll('[data-agy-turn-host]')) el.remove();
      restoreOuterPad();
      if (globalThis.__agyMonitorDeck === this) delete globalThis.__agyMonitorDeck;
    },
  };
  return true;
}

export function buildRuntimeBundle(owner = INSTANCE_TS) {
  const sharedSource = [
    getClientFormattersScript(),
    parseRelativeAgeMs.toString(),
    matchTurnBarsToCompleted.toString(),
  ].join('\n');
  const fnSource = installRuntime.toString();
  const hash = createHash('sha256').update(sharedSource + '\n' + fnSource).digest('hex').slice(0, 16);
  const code = `(()=>{${sharedSource}\nreturn (${fnSource})(${Number(owner)}, ${JSON.stringify(hash)});})()`;
  return { code, hash };
}

export function startMonitorInjector(getPayload, options = {}) {
  const owner = options.instanceTs ?? INSTANCE_TS;
  const bundle = buildRuntimeBundle(owner);
  const sockets = new Map();
  let cachedPages = [];
  let lastListAt = 0;
  let cdpState = 'unknown';
  let matchedTurnFooters = 0;
  let stopped = false;
  let busy = false;

  const retire = (entry, id) => {
    if (entry.closed) return;
    entry.closed = true;
    for (const cb of entry.pending.values()) cb(undefined);
    entry.pending.clear();
    try { entry.ws.close(); } catch {}
    if (sockets.get(id) === entry) sockets.delete(id);
  };

  const connect = async target => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const entry = { ws, pending: new Map(), nextId: 1, lastPayload: '', lastPath: '' };
    await new Promise((resolve, reject) => {
      const fail = msg => { clearTimeout(timer); retire(entry, target.id); reject(new Error(msg)); };
      const timer = setTimeout(() => fail('ws timeout'), 3000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => fail('ws error');
    });
    if (stopped) { retire(entry, target.id); throw new Error('stopped'); }
    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(ev.data);
        const cb = entry.pending.get(msg.id);
        if (cb) { entry.pending.delete(msg.id); cb(msg); }
      } catch {}
    };
    ws.onclose = () => retire(entry, target.id);
    sockets.set(target.id, entry);
    return entry;
  };

  const evaluate = (entry, expression) => new Promise(resolve => {
    if (entry.ws.readyState !== 1) return resolve(undefined);
    const id = entry.nextId++;
    const timer = setTimeout(() => { entry.pending.delete(id); resolve(undefined); }, 3000);
    entry.pending.set(id, msg => { clearTimeout(timer); resolve(msg?.result?.result?.value); });
    try { entry.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); }
    catch { clearTimeout(timer); entry.pending.delete(id); resolve(undefined); }
  });

  const diagEnabled = Boolean(options.diagFile || process.env.AGY_MONITOR_DEBUG === '1');
  const diagPath = options.diagFile || join(homedir(), '.gemini', 'config', 'agy-monitor', 'diag.json');
  let lastDiagJson = '';
  let lastTargetSummary = [];
  const writeDiag = (pagesReport) => {
    if (!diagEnabled) return;
    try {
      const json = JSON.stringify({ updatedAt: new Date().toISOString(), pid: process.pid, owner, cdpState, matchedTurnFooters, targets: lastTargetSummary, pages: pagesReport }, null, 2);
      if (json !== lastDiagJson) {
        lastDiagJson = json;
        mkdirSync(dirname(diagPath), { recursive: true });
        writeFileSync(diagPath, json, 'utf8');
      }
    } catch {}
  };

  const listPages = async () => {
    if (cachedPages.length && Date.now() - lastListAt < 4000) return cachedPages;
    let port;
    try { port = readFileSync(options.portFile || PORT_FILE, 'utf8').split(/\r?\n/)[0].trim(); }
    catch { cdpState = 'missing'; return []; }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const targets = await res.json();
      lastTargetSummary = targets.map(t => ({ type: t.type, url: String(t.url || '').split('?')[0].slice(0, 120) }));
      cachedPages = targets.filter(t => t.type === 'page' && /^https?:\/\/127\.0\.0\.1:\d+\//.test(t.url || '') && t.webSocketDebuggerUrl);
      lastListAt = Date.now();
      cdpState = 'ok';
      const ids = new Set(cachedPages.map(t => t.id));
      for (const [id, entry] of sockets) if (!ids.has(id)) retire(entry, id);
      return cachedPages;
    } catch {
      cdpState = 'unreachable';
      return [];
    }
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    await Promise.all([...sockets].map(async ([id, entry]) => {
      try { await evaluate(entry, `globalThis.__agyMonitorDeck?.owner===${owner}&&globalThis.__agyMonitorDeck.dispose()`); }
      finally { retire(entry, id); }
    }));
  };

  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    const pagesReport = [];
    try {
      for (const target of await listPages()) {
        if (stopped) break;
        try {
          const entry = sockets.get(target.id) || await connect(target);
          let st = await evaluate(entry, `globalThis.__agyMonitorDeck?.readState(${owner})??null`);
          if (st === 'superseded') { await stop(); process.exit(0); return; }
          if (st?.owner !== owner || st.hash !== bundle.hash) {
            const installed = await evaluate(entry, bundle.code);
            if (installed === 'superseded') { await stop(); process.exit(0); return; }
            if (!installed || stopped) continue;
            entry.lastPayload = '';
            st = await evaluate(entry, `globalThis.__agyMonitorDeck?.readState(${owner})??null`);
          }
          if (!st || st.owner !== owner || !st.hasFooter) {
            pagesReport.push({ url: String(target.url || '').split('?')[0].slice(0, 120), st });
            continue;
          }
          if (Number.isFinite(st.matchedTurnFooters)) matchedTurnFooters = st.matchedTurnFooters;
          const m = String(st.path || '').match(/\/c\/([0-9a-f-]{36})/);
          const data = await getPayload(m ? m[1] : '', { exact: true, focused: !!st.focused });
          if (!data || stopped) {
            pagesReport.push({ url: String(target.url || '').split('?')[0].slice(0, 120), st });
            continue;
          }
          const json = JSON.stringify(data);
          if (entry.lastPayload !== json || entry.lastPath !== st.path || !st.hasData) {
            const ok = await evaluate(entry, `globalThis.__agyMonitorDeck?.apply(${json},${JSON.stringify(st.path)},${owner})??false`);
            if (ok === 'superseded') { await stop(); process.exit(0); return; }
            if (ok) {
              entry.lastPayload = json;
              entry.lastPath = st.path;
              st = await evaluate(entry, `globalThis.__agyMonitorDeck?.readState(${owner})??null`);
              if (Number.isFinite(st?.matchedTurnFooters)) matchedTurnFooters = st.matchedTurnFooters;
            }
          }
          pagesReport.push({ url: String(target.url || '').split('?')[0].slice(0, 120), st });
        } catch (err) {
          pagesReport.push({ url: String(target.url || '').split('?')[0].slice(0, 120), err: String(err?.message || err) });
          const entry = sockets.get(target.id);
          if (entry) retire(entry, target.id);
        }
      }
      writeDiag(pagesReport);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(tick, INTERVAL_MS);
  return {
    tick,
    stop,
    status: () => ({ cdpState, matchedTurnFooters }),
  };
}

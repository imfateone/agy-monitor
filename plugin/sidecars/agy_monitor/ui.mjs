import { getClientFormattersScript } from './pb.mjs';

export function renderSidebarHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AGY监控</title>
  <script src="/preload.js"></script>
  <style>
    * { box-sizing: border-box; }
    html, body { scrollbar-width: none; margin: 0; padding: 0; }
    html::-webkit-scrollbar, body::-webkit-scrollbar { display: none; width: 0; height: 0; }
    body {
      font-family: "Source Han Sans CN", "思源黑体 CN", "Source Han Sans SC", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", Arial, sans-serif;
      font-size: 13px;
      line-height: 1.4;
      background: var(--background, light-dark(#f8f9fa, #141416));
      color: var(--foreground, light-dark(#18181b, #f4f4f5));
      font-variant-numeric: tabular-nums;
      -webkit-font-smoothing: antialiased;
    }
    .wrap { max-width: 720px; margin: 0 auto; padding: 10px 12px 18px; }
    .nav {
      position: sticky; top: 0; z-index: 10;
      background: var(--background, light-dark(#f8f9fa, #141416));
      padding-bottom: 10px;
    }
    .tabs {
      display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
      padding: 3px; border-radius: 9px;
      background: var(--secondary, light-dark(rgba(0,0,0,0.05), rgba(255,255,255,0.07)));
      border: 1px solid var(--border, light-dark(rgba(0,0,0,0.07), rgba(255,255,255,0.09)));
    }
    .tab-btn {
      border: 0; background: transparent; color: var(--muted-foreground, light-dark(#71717a, #a1a1aa));
      font: inherit; font-size: 12.5px; font-weight: 500;
      padding: 5px 8px; border-radius: 6px; cursor: pointer;
      transition: background 0.14s ease, color 0.14s ease;
    }
    .tab-btn[aria-selected="true"] {
      background: var(--card, light-dark(#ffffff, #222227));
      color: var(--foreground, light-dark(#18181b, #f4f4f5));
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      font-weight: 600;
    }
    .view[hidden] { display: none; }
    .cards { display: flex; flex-direction: column; gap: 10px; }
    .card {
      background: var(--card, light-dark(#ffffff, #1c1c21));
      border: 1px solid var(--border, light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.10)));
      border-radius: 12px;
      padding: 12px 14px;
    }
    .card-head {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding-bottom: 8px; margin-bottom: 8px;
      border-bottom: 1px solid var(--border, light-dark(rgba(0,0,0,0.07), rgba(255,255,255,0.08)));
    }
    .card-title { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
    .card-title svg { width: 14px; height: 14px; color: var(--muted-foreground, #71717a); flex-shrink: 0; }
    .card-val { font-weight: 600; white-space: nowrap; }
    .rows { display: flex; flex-direction: column; gap: 7px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .row-k { display: inline-flex; align-items: center; gap: 7px; color: var(--muted-foreground, light-dark(#71717a, #a1a1aa)); }
    .row-v { font-weight: 500; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 65%; }
    .subrow { font-size: 12px; padding-left: 8px; gap: 10px; }
    .subrow .row-k { display: block; min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .subrow .row-v { flex-shrink: 0; max-width: none; }
    .sub-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sub-live { width: 6px; height: 6px; border-radius: 50%; background: #16a34a; flex-shrink: 0; }
    .dot { width: 7px; height: 7px; border-radius: 2px; flex-shrink: 0; }
    .divider { height: 1px; background: var(--border, light-dark(rgba(0,0,0,0.07), rgba(255,255,255,0.08))); margin: 2px 0; }
    .bar {
      width: 100%; height: 5px; border-radius: 999px;
      background: light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.12));
      display: flex; gap: 1.5px; overflow: hidden; margin-bottom: 10px;
    }
    .bar-seg { height: 100%; border-radius: 999px; transition: width 0.25s ease; }
    .status-line {
      margin-top: 10px; padding: 8px 10px; border-radius: 8px;
      background: var(--secondary, light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.05)));
      color: var(--muted-foreground, light-dark(#71717a, #a1a1aa));
      font-size: 12px; display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap;
    }
    .badge-ok { color: #16a34a; font-weight: 600; }
    .badge-warn { color: #d97706; font-weight: 600; }
    .setting-row {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 9px 0; border-bottom: 1px solid var(--border, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.07)));
    }
    .setting-row:last-child { border-bottom: 0; }
    .setting-row label { flex: 1; cursor: pointer; }
    .setting-desc { font-size: 11.5px; color: var(--muted-foreground, #71717a); margin-top: 2px; }
    input[type="checkbox"] { width: 16px; height: 16px; accent-color: #3b82f6; cursor: pointer; }
    select {
      padding: 4px 8px; border-radius: 6px;
      border: 1px solid var(--border, light-dark(rgba(0,0,0,0.14), rgba(255,255,255,0.16)));
      background: var(--card, light-dark(#fff, #222227)); color: inherit; font: inherit; font-size: 12.5px;
    }
    .empty { text-align: center; padding: 24px 12px; color: var(--muted-foreground, #71717a); }
    .subtabs {
      display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
      padding: 2px; border-radius: 7px; margin-bottom: 9px;
      background: var(--secondary, light-dark(rgba(0,0,0,0.05), rgba(255,255,255,0.07)));
      border: 1px solid var(--border, light-dark(rgba(0,0,0,0.07), rgba(255,255,255,0.09)));
    }
    .subtab-btn {
      border: 0; background: transparent; color: var(--muted-foreground, light-dark(#71717a, #a1a1aa));
      font: inherit; font-size: 12px; font-weight: 500;
      padding: 4px 8px; border-radius: 5px; cursor: pointer;
      white-space: nowrap; transition: background 0.14s ease, color 0.14s ease;
    }
    .subtab-btn[aria-selected="true"] {
      background: var(--card, light-dark(#ffffff, #26262c));
      color: var(--foreground, light-dark(#18181b, #f4f4f5));
      box-shadow: 0 1px 2px rgba(0,0,0,0.08);
      font-weight: 600;
    }
    .mblocks { display: flex; flex-direction: column; gap: 8px; }
    .mblock {
      padding: 8px 10px; border-radius: 8px;
      background: var(--secondary, light-dark(rgba(0,0,0,0.025), rgba(255,255,255,0.04)));
      border: 1px solid var(--border, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.08)));
    }
    .mhead { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 5px; }
    .mname { font-size: 12.5px; font-weight: 600; min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mstat { font-size: 11.5px; color: var(--muted-foreground, light-dark(#71717a, #a1a1aa)); white-space: nowrap; flex-shrink: 0; }
    .mbar {
      width: 100%; height: 3px; border-radius: 999px;
      background: light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.12));
      overflow: hidden; margin-bottom: 6px;
    }
    .mbar-fill { display: block; height: 100%; border-radius: 999px; background: #3b82f6; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="nav">
      <div class="tabs" role="tablist">
        <button type="button" class="tab-btn" data-tab="overview" aria-selected="true"></button>
        <button type="button" class="tab-btn" data-tab="turns" aria-selected="false"></button>
        <button type="button" class="tab-btn" data-tab="settings" aria-selected="false"></button>
      </div>
    </div>
    <div id="view-overview" class="view"></div>
    <div id="view-turns" class="view" hidden></div>
    <div id="view-settings" class="view" hidden></div>
  </div>
  <script>
    ${getClientFormattersScript()}

    const I18N = {
      'zh-CN': {
        tabOverview: '统计总览', tabTurns: '每轮明细', tabSettings: '设置',
        sessionTitle: '会话统计', turnsSteps: (t, s) => t + ' 轮 ' + s + ' 步',
        modelTime: '模型用时', toolTime: '工具调用用时', avgTtft: '首 token 平均（TTFT）', outputTps: '输出速度（TPS）',
        compactions: '上下文压缩', timesUnit: (n) => n + ' 次',
        subagents: '子会话', subagentsNone: '0 个',
        subagentsSummary: (c, s) => s > 0 ? c + ' 个 · ' + s + ' 步' : c + ' 个',
        inclSubagents: '含子会话', subagentCountUnit: (c) => c + ' 个',
        subagentTurnSummary: (c, tok, s) => c + ' 个 · ' + tok + ' tok (' + s + ' 步)',
        subagentDetailTitle: '子会话明细', subagentStepsTok: (s, tok) => s + ' 步 · ' + tok + ' tok',
        modelsCount: (n) => n + ' 个模型', reqsUnit: (n) => n + ' 次',
        subTabOverview: '总览汇总', subTabModels: (n) => '分模型 (' + n + ')', subTabTurnSummary: '本轮汇总',
        reqCountLabel: '调用次数', emptyModels: '当前会话暂无模型调用记录',
        tokTitle: 'Token 用量', cacheHit: '缓存命中', uncachedIn: '未缓存输入', cachedRead: '缓存读取', output: '输出',
        ctxTitle: '上下文已用', quotaTitle: '模型配额', cdpOk: '页面胶囊已挂载', cdpOff: '未连上页面调试端口（仅侧栏可用）',
        cdpHint: 'Antigravity 2.33+ 默认关闭调试端口：请在启动快捷方式「目标」末尾加上 --remote-debugging-port=0，完全退出后重开即可恢复底部条和每轮胶囊。',
        matchedFooters: (n) => '本页已挂载回复条：' + n + ' 条',
        turnHeader: (i) => '第 ' + (i + 1) + ' 轮', turnSteps: '本轮步数', stepsUnit: (s) => s + ' 步', modelLabel: '提供方 / 模型', emptyTurns: '当前会话暂无已完成轮次',
        optFooter: '底部监控栏三胶囊', optFooterDesc: '在聊天框下方单独一行显示 会话统计 / Token 用量 / 上下文圆环',
        optTurn: '每轮结束底部用量胶囊', optTurnDesc: '在每条 AI 回复操作栏旁显示 用量 XXX tok',
        optQuota: '在侧栏显示模型配额', optLang: '显示语言',
      },
      en: {
        tabOverview: 'Overview', tabTurns: 'Turns', tabSettings: 'Settings',
        sessionTitle: 'Session Stats', turnsSteps: (t, s) => t + ' turns ' + s + ' steps',
        modelTime: 'Model time', toolTime: 'Tool time', avgTtft: 'Avg TTFT', outputTps: 'Output speed (TPS)',
        compactions: 'Compactions', timesUnit: (n) => n + '×',
        subagents: 'Subagents', subagentsNone: '0',
        subagentsSummary: (c, s) => s > 0 ? c + ' · ' + s + ' steps' : String(c),
        inclSubagents: 'Incl. subagents', subagentCountUnit: (c) => String(c),
        subagentTurnSummary: (c, tok, s) => c + ' · ' + tok + ' tok (' + s + ' steps)',
        subagentDetailTitle: 'Subagent Sessions', subagentStepsTok: (s, tok) => s + ' steps · ' + tok + ' tok',
        modelsCount: (n) => n + ' models', reqsUnit: (n) => n + '×',
        subTabOverview: 'Summary', subTabModels: (n) => 'By Model (' + n + ')', subTabTurnSummary: 'Summary',
        reqCountLabel: 'Requests', emptyModels: 'No model usage yet',
        tokTitle: 'Token Usage', cacheHit: 'Cache hit', uncachedIn: 'Uncached input', cachedRead: 'Cache read', output: 'Output',
        ctxTitle: 'Context used', quotaTitle: 'Model Quotas', cdpOk: 'In-page pills active', cdpOff: 'Debugging port unavailable (sidebar only)',
        cdpHint: 'Antigravity 2.33+ disables the debugging port by default. Append --remote-debugging-port=0 to your shortcut Target and restart Antigravity completely to restore in-page pills.',
        matchedFooters: (n) => 'Matched turn footers: ' + n,
        turnHeader: (i) => 'Turn #' + (i + 1), turnSteps: 'Steps', stepsUnit: (s) => s + ' steps', modelLabel: 'Provider / Model', emptyTurns: 'No completed turns yet',
        optFooter: 'Composer footer 3-pill strip', optFooterDesc: 'Show Session / Token Usage / Context ring below input box',
        optTurn: 'Per-turn completion pill', optTurnDesc: 'Show token pill beside each assistant reply footer',
        optQuota: 'Show model quotas in sidebar', optLang: 'Language',
      },
    };

    let currentTab = 'overview';
    let overviewSubTab = 'summary';
    const turnSubTabs = new Map();
    let lastConvId = '';
    let lastOverviewHtml = '';
    let lastTurnsHtml = '';
    let lastData = null;

    function apiParams() {
      const sp = new URLSearchParams(window.location.search);
      const token = sp.get('token') || '';
      const convId = window.sidecar?.conversationId || sp.get('conversationId') || '';
      return { token, convId };
    }

    async function saveSetting(patch) {
      const { token } = apiParams();
      const url = '/api/settings' + (token ? '?token=' + encodeURIComponent(token) : '');
      const headers = { 'Content-Type': 'application/json', ...(token ? { 'X-Sidecar-Token': token } : {}) };
      await fetch(url, { method: 'POST', headers, body: JSON.stringify(patch) });
      await refresh();
    }

    function renderModelCardHtml(m, L, isEn) {
      const pct = m.cacheHitPct != null ? Math.max(0, Math.min(100, m.cacheHitPct)) : 0;
      return '<div class="card">'
        + '<div class="card-head"><span class="card-title" style="min-width:0;flex:1">' + SVG_DB + '<span class="sub-name" title="' + esc(m.model) + '">' + esc(m.model) + '</span></span><span class="card-val">' + fmtExact(m.total) + ' tok</span></div>'
        + '<div class="bar"><span class="bar-seg" style="width:' + pct.toFixed(1) + '%;background:#3b82f6"></span></div>'
        + '<div class="rows">'
        + '<div class="row"><span class="row-k">' + L.reqCountLabel + '</span><span class="row-v">' + esc(L.reqsUnit(m.reqCount || 0)) + '</span></div>'
        + '<div class="row"><span class="row-k">' + L.cacheHit + '</span><span class="row-v">' + fmtPct(m.cacheHitPct, 1) + '</span></div>'
        + '<div class="row"><span class="row-k">' + L.uncachedIn + '</span><span class="row-v">' + fmtExact(m.uncached) + ' tok</span></div>'
        + '<div class="row"><span class="row-k">' + L.cachedRead + '</span><span class="row-v">' + fmtExact(m.cached) + ' tok</span></div>'
        + '<div class="row"><span class="row-k">' + L.output + '</span><span class="row-v">' + fmtExact(m.output) + ' tok</span></div>'
        + '<div class="divider"></div>'
        + '<div class="row"><span class="row-k">' + L.modelTime + '</span><span class="row-v">' + esc(fmtDur(m.modelSec || 0, isEn)) + '</span></div>'
        + '<div class="row"><span class="row-k">' + L.avgTtft + '</span><span class="row-v">' + esc(m.avgTtftSec != null ? fmtDur(m.avgTtftSec, isEn) : '—') + '</span></div>'
        + '<div class="row"><span class="row-k">' + L.outputTps + '</span><span class="row-v">' + esc(fmtTps(m.tps)) + '</span></div>'
        + '</div></div>';
    }

    function renderTurnModelsBlockHtml(mb, L, isEn) {
      return '<div class="mblocks">' + mb.map(m => {
        const pct = m.cacheHitPct != null ? Math.max(0, Math.min(100, m.cacheHitPct)) : 0;
        return '<div class="mblock">'
          + '<div class="mhead"><span class="mname" title="' + esc(m.model) + '">' + esc(m.model) + '</span><span class="mstat">' + fmtCompact(m.total) + ' tok · ' + esc(L.reqsUnit(m.reqCount || 0)) + '</span></div>'
          + '<div class="mbar"><span class="mbar-fill" style="width:' + pct.toFixed(1) + '%"></span></div>'
          + '<div class="rows" style="gap:5px;font-size:12px">'
          + '<div class="row"><span class="row-k">' + L.cacheHit + '</span><span class="row-v">' + fmtPct(m.cacheHitPct, 1) + '</span></div>'
          + '<div class="row"><span class="row-k">' + L.uncachedIn + '</span><span class="row-v">' + fmtExact(m.uncached) + ' tok</span></div>'
          + '<div class="row"><span class="row-k">' + L.cachedRead + '</span><span class="row-v">' + fmtExact(m.cached) + ' tok</span></div>'
          + '<div class="row"><span class="row-k">' + L.output + '</span><span class="row-v">' + fmtExact(m.output) + ' tok</span></div>'
          + '<div class="row"><span class="row-k">' + L.modelTime + '</span><span class="row-v">' + esc(fmtDur(m.modelSec || 0, isEn)) + '</span></div>'
          + '<div class="row"><span class="row-k">' + L.avgTtft + '</span><span class="row-v">' + esc(m.avgTtftSec != null ? fmtDur(m.avgTtftSec, isEn) : '—') + '</span></div>'
          + '<div class="row"><span class="row-k">' + L.outputTps + '</span><span class="row-v">' + esc(fmtTps(m.tps)) + '</span></div>'
          + '</div></div>';
      }).join('') + '</div>';
    }

    function render(d, force = false) {
      lastData = d;
      const isEn = d.prefs?.language === 'en';
      const L = I18N[isEn ? 'en' : 'zh-CN'];
      document.querySelector('[data-tab="overview"]').textContent = L.tabOverview;
      document.querySelector('[data-tab="turns"]').textContent = L.tabTurns;
      document.querySelector('[data-tab="settings"]').textContent = L.tabSettings;

      if (d.conversationId && d.conversationId !== lastConvId) {
        lastConvId = d.conversationId;
        turnSubTabs.clear();
        lastOverviewHtml = '';
        lastTurnsHtml = '';
      }

      const s = d.session || {}, t = d.tokens || {}, c = d.context || {};
      const sessionModels = Array.isArray(s.modelBreakdown) ? s.modelBreakdown : [];
      if (overviewSubTab === 'models' && sessionModels.length === 0) overviewSubTab = 'summary';

      const settingsEl = document.getElementById('view-settings');
      if (currentTab === 'overview') {
        const cats = c.categories || [];
      const catSum = cats.reduce((a, b) => a + (b.tokens || 0), 0);
      const barDenom = c.maxTokens > 0 ? Math.max(c.maxTokens, catSum) : Math.max(1, catSum);
      const segs = cats.map(item => '<span class="bar-seg" style="width:' + Math.max(0.5, (item.tokens / barDenom) * 100).toFixed(2) + '%;background:' + esc(item.color) + '"></span>').join('');
      const catRows = cats.map(item => '<div class="row"><span class="row-k"><span class="dot" style="background:' + esc(item.color) + '"></span><span>' + esc(isEn ? item.en : item.zh) + '</span></span><span class="row-v">~' + fmtCompact(item.tokens) + '</span></div>').join('');

      let quotaHtml = '';
      if (d.prefs?.showQuotaInSidebar !== false && Array.isArray(d.quotaGroups) && d.quotaGroups.length > 0 && !d.cloudPaygo) {
        const qRows = d.quotaGroups.map(g => {
          const buckets = (g.buckets || []).map(b => Math.round((b.remainingFraction || 0) * 100) + '%').join(' / ');
          return '<div class="row"><span class="row-k">' + esc(g.displayName || g.label || 'Pool') + '</span><span class="row-v">' + esc(buckets || '—') + '</span></div>';
        }).join('');
        quotaHtml = '<div class="card"><div class="card-head"><span class="card-title">' + SVG_CTX + '<span>' + L.quotaTitle + '</span></span></div><div class="rows">' + qRows + '</div></div>';
      }

      const cdp = d.cdp || {};
      const cdpBadge = cdp.cdpState === 'ok'
        ? '<span class="badge-ok">● ' + L.cdpOk + '</span><span>' + L.matchedFooters(cdp.matchedTurnFooters || 0) + '</span>'
        : '<span class="badge-warn">● ' + L.cdpOff + '</span>' + (['missing', 'unreachable'].includes(cdp.cdpState) ? '<div style="width:100%;margin-top:4px;line-height:1.45">' + esc(L.cdpHint) + '</div>' : '');

      const overviewTabsHtml = sessionModels.length > 0
        ? '<div class="subtabs" role="tablist">'
          + '<button type="button" class="subtab-btn" data-overview-subtab="summary" aria-selected="' + (overviewSubTab !== 'models') + '">' + L.subTabOverview + '</button>'
          + '<button type="button" class="subtab-btn" data-overview-subtab="models" aria-selected="' + (overviewSubTab === 'models') + '">' + esc(L.subTabModels(sessionModels.length)) + '</button>'
          + '</div>'
        : '';

      const sessSubVal = (s.subagentCount || 0) > 0
        ? L.subagentsSummary(s.subagentCount, s.subagentStepsCount || 0)
        : L.subagentsNone;
      const tokSubRow = (t.subagentTotal || 0) > 0
        ? '<div class="divider"></div><div class="row"><span class="row-k">' + L.inclSubagents + '</span><span class="row-v">' + fmtExact(t.subagentTotal) + ' tok (' + esc(L.subagentCountUnit(s.subagentCount || 0)) + ')</span></div>'
        : '';

      let subagentsHtml = '';
      if (Array.isArray(d.subagents) && d.subagents.length > 0) {
        const saRows = d.subagents.map(sa => {
          const label = sa.role && sa.type && sa.role !== sa.type ? sa.role + ' (' + sa.type + ')' : (sa.role || sa.type || sa.id);
          const tip = (sa.model || sa.modelId || '') + ' · ' + fmtExact(sa.totalTokens || 0) + ' tok';
          const dot = sa.isStreaming ? '<span class="sub-live"></span>' : '';
          return '<div class="row" title="' + esc(tip) + '"><span class="row-k" style="min-width:0;flex:1">' + dot + '<span class="sub-name">' + esc(label) + '</span></span><span class="row-v">' + esc(L.subagentStepsTok(sa.stepsCount || 0, fmtCompact(sa.totalTokens || 0))) + '</span></div>';
        }).join('');
        subagentsHtml = '<div class="card"><div class="card-head"><span class="card-title">' + SVG_GAUGE + '<span>' + L.subagentDetailTitle + '</span></span><span class="card-val">' + esc(L.subagentCountUnit(d.subagents.length)) + ' · ' + fmtCompact(t.subagentTotal || 0) + ' tok</span></div><div class="rows">' + saRows + '</div></div>';
      }

      const summaryCardsHtml = '<div class="card"><div class="card-head"><span class="card-title">' + SVG_GAUGE + '<span>' + L.sessionTitle + '</span></span><span class="card-val">' + esc(L.turnsSteps(s.turnsCount || 0, s.stepsCount || 0)) + '</span></div><div class="rows">'
        + '<div class="row"><span class="row-k">' + L.modelTime + '</span><span class="row-v">' + esc(fmtDur(s.modelSec, isEn)) + '</span></div>'
        + '<div class="row"><span class="row-k">' + L.toolTime + '</span><span class="row-v">' + esc(fmtDur(s.toolSec, isEn)) + '</span></div>'
        + '<div class="row"><span class="row-k">' + L.avgTtft + '</span><span class="row-v">' + esc(s.avgTtftSec != null ? fmtDur(s.avgTtftSec, isEn) : '—') + '</span></div>'
        + '<div class="row"><span class="row-k">' + L.outputTps + '</span><span class="row-v">' + esc(fmtTps(s.tps)) + '</span></div>'
        + '<div class="divider"></div>'
        + '<div class="row"><span class="row-k">' + L.compactions + '</span><span class="row-v">' + esc(L.timesUnit(s.compactionsCount || 0)) + '</span></div>'
        + '<div class="row"><span class="row-k">' + L.subagents + '</span><span class="row-v">' + esc(sessSubVal) + '</span></div>'
        + '</div></div>'
        + '<div class="card"><div class="card-head"><span class="card-title">' + SVG_DB + '<span>' + L.tokTitle + '</span></span><span class="card-val">' + fmtExact(t.total) + ' tok</span></div><div class="rows">'
        + '<div class="row"><span class="row-k">' + L.cacheHit + '</span><span class="row-v">' + fmtPct(t.cacheHitPct, 0) + '</span></div>'
        + '<div class="row"><span class="row-k">' + L.uncachedIn + '</span><span class="row-v">' + fmtExact(t.uncached) + ' tok</span></div>'
        + '<div class="row"><span class="row-k">' + L.cachedRead + '</span><span class="row-v">' + fmtExact(t.cached) + ' tok</span></div>'
        + '<div class="row"><span class="row-k">' + L.output + '</span><span class="row-v">' + fmtExact(t.output) + ' tok</span></div>'
        + tokSubRow
        + '</div></div>'
        + '<div class="card"><div class="card-head"><span class="card-title">' + L.ctxTitle + ' <b>' + (c.usedPct || 0) + '%</b></span><span class="card-val">~' + fmtCompact(c.usedTokens) + ' / ' + (c.maxTokens > 0 ? fmtCompact(c.maxTokens) : '--') + '</span></div>'
        + '<div class="bar">' + segs + '</div><div class="rows">' + catRows + '</div></div>'
        + subagentsHtml
        + quotaHtml;

      const modelCardsHtml = sessionModels.length === 0
        ? '<div class="empty">' + L.emptyModels + '</div>'
        : sessionModels.map(m => renderModelCardHtml(m, L, isEn)).join('');

        const nextOverviewHtml = overviewTabsHtml
          + '<div class="cards">'
          + (overviewSubTab === 'models' ? modelCardsHtml : summaryCardsHtml)
          + '<div class="status-line">' + cdpBadge + '</div>'
          + '</div>';
        if (force || nextOverviewHtml !== lastOverviewHtml) {
          document.getElementById('view-overview').innerHTML = nextOverviewHtml;
          lastOverviewHtml = nextOverviewHtml;
        }
      }

      if (currentTab === 'turns') {
        const turns = (d.turns || []).filter(x => x.total > 0).slice().reverse();
        const nextTurnsHtml = turns.length === 0
          ? '<div class="empty">' + L.emptyTurns + '</div>'
          : '<div class="cards">' + turns.map(turn => {
            const mb = Array.isArray(turn.modelBreakdown) ? turn.modelBreakdown : [];
            const hasMulti = mb.length > 1;
            const tTab = hasMulti ? (turnSubTabs.get(turn.turnIndex) || 'summary') : 'summary';
            const turnTabsHtml = hasMulti
              ? '<div class="subtabs" role="tablist">'
                + '<button type="button" class="subtab-btn" data-turn-idx="' + turn.turnIndex + '" data-turn-subtab="summary" aria-selected="' + (tTab !== 'models') + '">' + L.subTabTurnSummary + '</button>'
                + '<button type="button" class="subtab-btn" data-turn-idx="' + turn.turnIndex + '" data-turn-subtab="models" aria-selected="' + (tTab === 'models') + '">' + esc(L.subTabModels(mb.length)) + '</button>'
                + '</div>'
              : '';
            const modelRows = hasMulti
              ? '<div class="row"><span class="row-k">' + L.modelLabel + '</span><span class="row-v">' + esc(L.modelsCount(mb.length)) + '</span></div>'
                + mb.map(m => '<div class="row subrow"><span class="row-k" title="' + esc(m.model) + '">' + esc(m.model) + '</span><span class="row-v">' + esc(L.reqsUnit(m.reqCount || 0)) + '</span></div>').join('')
              : '<div class="row"><span class="row-k">' + L.modelLabel + '</span><span class="row-v">' + esc(turn.model || turn.modelId || '—') + '</span></div>';
            const subTip = (turn.subagents || []).map(sa => (sa.role || sa.type) + ': ' + fmtExact(sa.totalTokens || 0) + ' tok (' + (sa.stepsCount || 0) + (isEn ? ' steps' : ' 步') + ')').join('\\n');
            const subRow = (turn.subagentCount || 0) > 0
              ? '<div class="row"><span class="row-k">' + L.subagents + '</span><span class="row-v" title="' + esc(subTip) + '">' + esc(L.subagentTurnSummary(turn.subagentCount, fmtCompact(turn.subagentTokens || 0), turn.subagentSteps || 0)) + '</span></div>'
              : '';
            const compRow = (turn.compactionsCount || 0) > 0
              ? '<div class="row"><span class="row-k">' + L.compactions + '</span><span class="row-v">' + esc(L.timesUnit(turn.compactionsCount)) + '</span></div>'
              : '';
            const turnBody = tTab === 'models'
              ? renderTurnModelsBlockHtml(mb, L, isEn)
              : '<div class="rows">'
                + modelRows
                + '<div class="row"><span class="row-k">' + L.cacheHit + '</span><span class="row-v">' + fmtPct(turn.cacheHitPct, 1) + '</span></div>'
                + '<div class="row"><span class="row-k">' + L.uncachedIn + '</span><span class="row-v">' + fmtExact(turn.uncached) + ' tok</span></div>'
                + '<div class="row"><span class="row-k">' + L.cachedRead + '</span><span class="row-v">' + fmtExact(turn.cached) + ' tok</span></div>'
                + '<div class="row"><span class="row-k">' + L.output + '</span><span class="row-v">' + fmtExact(turn.output) + ' tok</span></div>'
                + '<div class="divider"></div>'
                + '<div class="row"><span class="row-k">' + L.turnSteps + '</span><span class="row-v">' + esc(L.stepsUnit(turn.stepsCount || 0)) + '</span></div>'
                + subRow
                + '<div class="row"><span class="row-k">' + L.modelTime + '</span><span class="row-v">' + esc(fmtDur(turn.modelSec || 0, isEn)) + '</span></div>'
                + '<div class="row"><span class="row-k">' + L.toolTime + '</span><span class="row-v">' + esc(fmtDur(turn.toolSec || 0, isEn)) + '</span></div>'
                + '<div class="row"><span class="row-k">' + L.avgTtft + '</span><span class="row-v">' + esc(turn.avgTtftSec != null ? fmtDur(turn.avgTtftSec, isEn) : '—') + '</span></div>'
                + '<div class="row"><span class="row-k">' + L.outputTps + '</span><span class="row-v">' + esc(fmtTps(turn.tps)) + '</span></div>'
                + compRow
                + '</div>';
            return '<div class="card">'
              + '<div class="card-head"><span class="card-title">' + SVG_DB + '<span>' + esc(L.turnHeader(turn.turnIndex)) + '</span></span><span class="card-val">' + fmtExact(turn.total) + ' tok</span></div>'
              + turnTabsHtml
              + turnBody
              + '</div>';
          }).join('') + '</div>';
        if (force || nextTurnsHtml !== lastTurnsHtml) {
          document.getElementById('view-turns').innerHTML = nextTurnsHtml;
          lastTurnsHtml = nextTurnsHtml;
        }
      }

      if (!settingsEl.innerHTML) {
        const p = d.prefs || {};
        settingsEl.innerHTML = '<div class="card">'
          + '<div class="setting-row"><label for="opt-footer"><div>' + L.optFooter + '</div><div class="setting-desc">' + L.optFooterDesc + '</div></label><input id="opt-footer" type="checkbox"' + (p.enableFooterBar !== false ? ' checked' : '') + ' /></div>'
          + '<div class="setting-row"><label for="opt-turn"><div>' + L.optTurn + '</div><div class="setting-desc">' + L.optTurnDesc + '</div></label><input id="opt-turn" type="checkbox"' + (p.enableTurnPills !== false ? ' checked' : '') + ' /></div>'
          + '<div class="setting-row"><label for="opt-quota">' + L.optQuota + '</label><input id="opt-quota" type="checkbox"' + (p.showQuotaInSidebar !== false ? ' checked' : '') + ' /></div>'
          + '<div class="setting-row"><label for="opt-lang">' + L.optLang + '</label><select id="opt-lang"><option value="zh-CN"' + (p.language !== 'en' ? ' selected' : '') + '>简体中文</option><option value="en"' + (p.language === 'en' ? ' selected' : '') + '>English</option></select></div>'
          + '</div>';
        document.getElementById('opt-footer').addEventListener('change', e => saveSetting({ enableFooterBar: e.target.checked }));
        document.getElementById('opt-turn').addEventListener('change', e => saveSetting({ enableTurnPills: e.target.checked }));
        document.getElementById('opt-quota').addEventListener('change', e => saveSetting({ showQuotaInSidebar: e.target.checked }));
        document.getElementById('opt-lang').addEventListener('change', e => saveSetting({ language: e.target.value }));
      }
    }

    document.getElementById('view-overview').addEventListener('click', (e) => {
      const btn = e.target.closest('.subtab-btn[data-overview-subtab]');
      if (!btn || !lastData) return;
      overviewSubTab = btn.dataset.overviewSubtab || 'summary';
      render(lastData, true);
    });

    document.getElementById('view-turns').addEventListener('click', (e) => {
      const btn = e.target.closest('.subtab-btn[data-turn-subtab]');
      if (!btn || !lastData) return;
      const idx = Number(btn.dataset.turnIdx);
      if (Number.isFinite(idx)) {
        turnSubTabs.set(idx, btn.dataset.turnSubtab || 'summary');
        render(lastData, true);
      }
    });

    for (const btn of document.querySelectorAll('.tab-btn')) {
      btn.addEventListener('click', () => {
        currentTab = btn.dataset.tab;
        for (const b of document.querySelectorAll('.tab-btn')) b.setAttribute('aria-selected', String(b === btn));
        for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== 'view-' + currentTab;
        if (lastData) {
          if (currentTab === 'settings') document.getElementById('view-settings').innerHTML = '';
          render(lastData, true);
        }
      });
    }

    async function refresh() {
      try {
        const { token, convId } = apiParams();
        const qs = new URLSearchParams();
        if (convId) qs.set('conversationId', convId);
        if (token) qs.set('token', token);
        const url = '/api/telemetry' + (qs.toString() ? '?' + qs.toString() : '');
        const headers = token ? { 'X-Sidecar-Token': token } : {};
        const res = await fetch(url, { headers });
        const d = await res.json();
        if (!d.error) render(d);
      } catch {}
    }

    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>`;
}

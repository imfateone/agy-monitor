import { getClientFormattersScript } from './pb.mjs';
import { getClientUsageHelpersScript } from './usage_stats.mjs';

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
      display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
      padding: 3px; border-radius: 9px;
      background: var(--secondary, light-dark(rgba(0,0,0,0.05), rgba(255,255,255,0.07)));
      border: 1px solid var(--border, light-dark(rgba(0,0,0,0.07), rgba(255,255,255,0.09)));
    }
    .tab-btn {
      border: 0; background: transparent; color: var(--muted-foreground, light-dark(#71717a, #a1a1aa));
      font: inherit; font-size: 12px; font-weight: 500;
      padding: 5px 4px; border-radius: 6px; cursor: pointer; white-space: nowrap;
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
    .u-seg4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); padding: 2px; border-radius: 8px; background: var(--secondary, light-dark(rgba(0,0,0,0.05), rgba(255,255,255,0.07))); border: 1px solid var(--border, light-dark(rgba(0,0,0,0.07), rgba(255,255,255,0.09))); }
    .u-seg2 { display: inline-flex; padding: 2px; border-radius: 7px; background: var(--secondary, light-dark(rgba(0,0,0,0.05), rgba(255,255,255,0.07))); border: 1px solid var(--border, light-dark(rgba(0,0,0,0.07), rgba(255,255,255,0.09))); }
    .u-seg-btn { border: 0; background: transparent; color: var(--muted-foreground, light-dark(#71717a, #a1a1aa)); font: inherit; font-size: 11.5px; font-weight: 500; padding: 4px 8px; border-radius: 5px; cursor: pointer; white-space: nowrap; }
    .u-seg-btn[aria-selected="true"] { background: var(--card, light-dark(#ffffff, #26262c)); color: var(--foreground, light-dark(#18181b, #f4f4f5)); box-shadow: 0 1px 2px rgba(0,0,0,0.08); font-weight: 600; }
    .u-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
    .u-kpi-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; margin-bottom: 9px; }
    .u-kpi-box { padding: 7px 9px; border-radius: 8px; background: var(--secondary, light-dark(rgba(0,0,0,0.03), rgba(255,255,255,0.045))); border: 1px solid var(--border, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.08))); }
    .u-kpi-k { font-size: 11.5px; color: var(--muted-foreground, light-dark(#71717a, #a1a1aa)); }
    .u-kpi-v { font-size: 13.5px; font-weight: 600; margin-top: 2px; }
    .u-legend { display: flex; flex-wrap: wrap; gap: 5px 10px; padding-top: 8px; margin-top: 6px; border-top: 1px solid var(--border, light-dark(rgba(0,0,0,0.06), rgba(255,255,255,0.08))); font-size: 11.5px; color: var(--muted-foreground, light-dark(#71717a, #a1a1aa)); }
    .u-leg-item { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; }
    .u-cal-nav { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; font-size: 12px; }
    .u-nav-btn { border: 1px solid var(--border, light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.14))); background: var(--secondary, light-dark(rgba(0,0,0,0.04), rgba(255,255,255,0.06))); color: inherit; border-radius: 5px; padding: 2px 8px; cursor: pointer; font: inherit; font-size: 12px; }
    .u-nav-btn:disabled { opacity: 0.35; cursor: default; }
    .u-cal-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
    .u-cal-wd { text-align: center; font-size: 11.5px; color: var(--muted-foreground, light-dark(#71717a, #a1a1aa)); padding: 2px 0; }
    .u-cal-cell { height: 40px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.045); padding: 5px 3px 4px; display: flex; flex-direction: column; align-items: center; justify-content: space-between; cursor: pointer; font: inherit; color: rgba(244,244,245,0.36); background: rgba(255,255,255,0.035); transition: opacity 0.12s ease, transform 0.1s ease; }
    .u-cal-cell:hover { opacity: 0.92; }
    .u-cal-num { font-size: 10px; line-height: 1; font-weight: 500; opacity: 0.72; }
    .u-cal-val { font-size: 11px; line-height: 1; font-weight: 600; letter-spacing: -0.02em; color: rgba(161,161,170,0.65); }
    .u-heat-months { display: flex; gap: 3px; margin-left: 18px; margin-bottom: 4px; font-size: 11px; color: var(--muted-foreground, light-dark(#71717a, #a1a1aa)); }
    .u-heat-month { flex: 1; min-width: 0; white-space: nowrap; overflow: visible; }
    .u-heat-body { display: flex; gap: 4px; align-items: stretch; }
    .u-heat-days { width: 14px; flex-shrink: 0; display: flex; flex-direction: column; gap: 3px; font-size: 10.5px; color: var(--muted-foreground, light-dark(#71717a, #a1a1aa)); }
    .u-heat-days span { flex: 1; display: flex; align-items: center; }
    .u-heat-cols { flex: 1; display: flex; gap: 3px; }
    .u-heat-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .u-heat-sq { width: 100%; aspect-ratio: 1; border-radius: 3px; border: 0; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.05); padding: 0; cursor: pointer; }
    :root[data-theme="light"] .u-heat-sq { box-shadow: inset 0 0 0 1px rgba(0,0,0,0.05); }
    .u-heat-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 7px; font-size: 11px; color: var(--muted-foreground, light-dark(#71717a, #a1a1aa)); }
    .u-scale { display: inline-flex; align-items: center; gap: 3px; }
    .u-scale-sq { width: 9px; height: 9px; border-radius: 2px; border: 0; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06); }
    :root[data-theme="light"] .u-scale-sq { box-shadow: inset 0 0 0 1px rgba(0,0,0,0.06); }
    :root .u-heat-0, :root[data-theme="dark"] .u-heat-0 { background: rgba(255,255,255,0.035); border-color: rgba(255,255,255,0.045); color: rgba(244,244,245,0.36); }
    :root .u-heat-0 .u-cal-val, :root[data-theme="dark"] .u-heat-0 .u-cal-val { color: rgba(161,161,170,0.55); }
    .u-heat-1 { background: #b3deff; border-color: transparent; color: #002244; }
    .u-heat-1 .u-cal-val { color: #002244; }
    .u-heat-2 { background: #62b5ff; border-color: transparent; color: #001f40; }
    .u-heat-2 .u-cal-val { color: #001f40; }
    .u-heat-3 { background: #0e73e5; border-color: transparent; color: #ffffff; }
    .u-heat-3 .u-cal-val { color: #ffffff; }
    .u-heat-4 { background: #0052b8; border-color: transparent; color: #ffffff; }
    .u-heat-4 .u-cal-val { color: #ffffff; }
    .u-heat-5 { background: #00337a; border-color: transparent; color: #ffffff; }
    .u-heat-5 .u-cal-val { color: #ffffff; font-weight: 700; }
    :root .u-sel, :root[data-theme="dark"] .u-sel { box-shadow: 0 0 0 1.5px #ffffff, 0 0 8px rgba(14,115,229,0.55) !important; border-color: transparent !important; }
    :root[data-theme="light"] .u-heat-0 { background: rgba(0,0,0,0.035); border-color: rgba(0,0,0,0.045); color: rgba(24,24,27,0.36); }
    :root[data-theme="light"] .u-heat-0 .u-cal-val { color: #a1a1aa; }
    :root[data-theme="light"] .u-sel { box-shadow: 0 0 0 1.5px #0055cc !important; border-color: transparent !important; }
    .u-filter { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; border-radius: 8px; background: rgba(59,130,246,0.12); border: 1px solid rgba(59,130,246,0.32); font-size: 12px; }
    .u-clear-btn { border: 0; background: transparent; color: #3b82f6; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; padding: 0; }
    .u-think-bar { width: 100%; height: 6px; border-radius: 999px; background: var(--secondary, light-dark(rgba(0,0,0,0.08), rgba(255,255,255,0.10))); overflow: hidden; display: flex; margin: 4px 0; }
    .u-bar-hit { cursor: pointer; }
    .u-bar-hit:hover { opacity: 0.84; }
    .u-tip { position: fixed; z-index: 9999; pointer-events: none; min-width: 184px; max-width: 248px; padding: 8px 10px; border-radius: 9px; background: var(--card, light-dark(#ffffff, #222227)); color: var(--foreground, light-dark(#18181b, #f4f4f5)); border: 1px solid var(--border, light-dark(rgba(0,0,0,0.12), rgba(255,255,255,0.14))); box-shadow: 0 8px 24px rgba(0,0,0,0.22); font-size: 11.5px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="nav">
      <div class="tabs" role="tablist">
        <button type="button" class="tab-btn" data-tab="overview" aria-selected="true"></button>
        <button type="button" class="tab-btn" data-tab="turns" aria-selected="false"></button>
        <button type="button" class="tab-btn" data-tab="usage" aria-selected="false"></button>
        <button type="button" class="tab-btn" data-tab="settings" aria-selected="false"></button>
      </div>
    </div>
    <div id="view-overview" class="view"></div>
    <div id="view-turns" class="view" hidden></div>
    <div id="view-usage" class="view" hidden></div>
    <div id="view-settings" class="view" hidden></div>
  </div>
  <div id="u-tip" class="u-tip" hidden></div>
  <script>
    ${getClientFormattersScript()}
    ${getClientUsageHelpersScript()}

    const I18N = {
      'zh-CN': {
        tabOverview: '统计总览', tabTurns: '每轮明细', tabUsage: '用量统计', tabSettings: '设置',
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
        ctxTitle: '上下文已用', ctxEstNote: '总占用为服务端实测，分类拆解为客户端估算', quotaTitle: '模型配额', cdpOk: '页面胶囊已挂载', cdpOff: '未连上页面调试端口（仅侧栏可用）',
        cdpHint: 'Antigravity 2.33+ 默认关闭调试端口：请在启动快捷方式「目标」末尾加上 --remote-debugging-port=0，完全退出后重开即可恢复底部条和每轮胶囊。',
        matchedFooters: (n) => '本页已挂载回复条：' + n + ' 条',
        turnHeader: (i) => '第 ' + (i + 1) + ' 轮', turnSteps: '本轮步数', stepsUnit: (s) => s + ' 步', modelLabel: '提供方 / 模型', emptyTurns: '当前会话暂无已完成轮次',
        optFooter: '底部监控栏三胶囊', optFooterDesc: '在聊天框下方单独一行显示 会话统计 / Token 用量 / 上下文圆环',
        optTurn: '每轮结束底部用量胶囊', optTurnDesc: '在每条 AI 回复操作栏旁显示 用量 XXX tok',
        optQuota: '在侧栏显示模型配额', optCost: '在用量统计显示等效 API 费用估算', optCostDesc: '按公开参考单价折算花费及缓存节省金额（仅供参考）', optLang: '显示语言',
        uRangeToday: '本日', uRangeWeek: '本周', uRangeMonth: '本月', uRangeAll: '全部',
        uModeCal: '月历', uModeBar: '柱状图', uModeHeat: '热力图',
        uStackModel: '按模型', uStackType: '按构成',
        uTitleToday: '本日 24 小时用量', uTitleWeek: '本周每日用量', uTitleMonth: '本月用量', uTitleAll: '历史用量分布',
        uClearFilter: '清除筛选', uFilteredDay: (d) => '已筛选单日：' + d, uFilteredHour: (h) => '已筛选时段：' + h + ':00',
        uSummaryTitle: '汇总用量', uActiveDays: (r, d) => r + ' 次 · ' + d + ' 天',
        uThinkReply: '思考 / 正文输出', uThinkRatio: (p) => '思考占输出 ' + p + '%',
        uThinkUnsplit: '所选模型未上报思考拆分', uThinkExcl: '不含未拆分模型', uUnsplitShort: '未拆分',
        uCostLabel: '等效费用', uSavedLabel: '缓存省下', uModelsTitle: '分模型累计',
        uTypeCached: '缓存读取', uTypeUncached: '未缓存输入', uTypeThinking: '思考输出', uTypeReply: '正文输出',
        uEmpty: '该时间范围内暂无模型用量记录', uLoading: '正在统计本地会话用量…',
        uLess: '少', uMore: '多', uWeeksHint: (w) => '近 ' + w + ' 周（点击方格筛选）',
        uWeekdays: ['一', '二', '三', '四', '五', '六', '日'], uMonthTitle: (y, m) => y + ' 年 ' + m + ' 月',
      },
      en: {
        tabOverview: 'Overview', tabTurns: 'Turns', tabUsage: 'Usage', tabSettings: 'Settings',
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
        ctxTitle: 'Context used', ctxEstNote: 'Total is server-reported; breakdown is client-estimated', quotaTitle: 'Model Quotas', cdpOk: 'In-page pills active', cdpOff: 'Debugging port unavailable (sidebar only)',
        cdpHint: 'Antigravity 2.33+ disables the debugging port by default. Append --remote-debugging-port=0 to your shortcut Target and restart Antigravity completely to restore in-page pills.',
        matchedFooters: (n) => 'Matched turn footers: ' + n,
        turnHeader: (i) => 'Turn #' + (i + 1), turnSteps: 'Steps', stepsUnit: (s) => s + ' steps', modelLabel: 'Provider / Model', emptyTurns: 'No completed turns yet',
        optFooter: 'Composer footer 3-pill strip', optFooterDesc: 'Show Session / Token Usage / Context ring below input box',
        optTurn: 'Per-turn completion pill', optTurnDesc: 'Show token pill beside each assistant reply footer',
        optQuota: 'Show model quotas in sidebar', optCost: 'Show equivalent API cost in Usage', optCostDesc: 'Estimate reference USD cost and cache savings', optLang: 'Language',
        uRangeToday: 'Today', uRangeWeek: 'Week', uRangeMonth: 'Month', uRangeAll: 'All',
        uModeCal: 'Calendar', uModeBar: 'Bar', uModeHeat: 'Heatmap',
        uStackModel: 'By Model', uStackType: 'By Type',
        uTitleToday: 'Today (24h)', uTitleWeek: 'This Week (Mon-Sun)', uTitleMonth: 'Monthly Usage', uTitleAll: 'History',
        uClearFilter: 'Clear', uFilteredDay: (d) => 'Day: ' + d, uFilteredHour: (h) => 'Hour: ' + h + ':00',
        uSummaryTitle: 'Summary', uActiveDays: (r, d) => r + ' reqs · ' + d + 'd',
        uThinkReply: 'Thinking / Reply', uThinkRatio: (p) => 'Thinking ' + p + '% of output',
        uThinkUnsplit: 'Thinking split not reported by model(s)', uThinkExcl: 'excl. unsplit models', uUnsplitShort: 'unsplit',
        uCostLabel: 'Est. API Cost', uSavedLabel: 'Cache Saved', uModelsTitle: 'By Model',
        uTypeCached: 'Cached', uTypeUncached: 'Uncached', uTypeThinking: 'Thinking', uTypeReply: 'Reply',
        uEmpty: 'No usage recorded in this range', uLoading: 'Aggregating local usage stats…',
        uLess: 'Less', uMore: 'More', uWeeksHint: (w) => 'Last ' + w + ' wks (click to filter)',
        uWeekdays: ['M', 'T', 'W', 'T', 'F', 'S', 'S'], uMonthTitle: (y, m) => y + '-' + String(m).padStart(2, '0'),
      },
    };

    let currentTab = 'overview';
    let overviewSubTab = 'summary';
    const turnSubTabs = new Map();
    let lastConvId = '';
    let lastOverviewHtml = '';
    let lastTurnsHtml = '';
    let lastUsageHtml = '';
    let lastData = null;
    let lastUsageData = null;
    let usageRange = 'month';
    let usageMonthChart = 'calendar';
    let usageAllChart = 'heatmap';
    let usageStackBy = 'model';
    let usageMonthYm = '';
    let usageSelDay = '';
    let usageSelHour = -1;
    let usageTipMap = new Map();
    let activeUsageTipKey = '';
    let usageTipW = 0;
    let usageTipH = 0;
    let lastUsageSig = '';
    let lastUsagePrefsKey = '';
    let telemetryInFlight = false;
    let usageInFlight = false;

    function apiParams() {
      const sp = new URLSearchParams(window.location.search);
      const token = sp.get('token') || '';
      const convId = window.sidecar?.conversationId || sp.get('conversationId') || '';
      return { token, convId };
    }

    async function fetchWithTimeout(url, opts = {}, timeoutMs = 6000) {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      try {
        return await fetch(url, ctrl ? { ...opts, signal: ctrl.signal } : opts);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async function saveSetting(patch) {
      const { token } = apiParams();
      const headers = { 'Content-Type': 'application/json', ...(token ? { 'X-Sidecar-Token': token } : {}) };
      await fetchWithTimeout('/api/settings', { method: 'POST', headers, body: JSON.stringify(patch) }, 5000);
      await refresh(true);
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
      document.querySelector('[data-tab="usage"]').textContent = L.tabUsage;
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
        + '<div class="bar">' + segs + '</div><div class="rows">' + catRows + '</div>'
        + (cats.length > 0 ? '<div style="font-size:11px;color:var(--muted-foreground);margin-top:6px;line-height:1.4">' + esc(L.ctxEstNote) + '</div>' : '')
        + '</div>'
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
          + '<div class="setting-row"><label for="opt-cost"><div>' + L.optCost + '</div><div class="setting-desc">' + L.optCostDesc + '</div></label><input id="opt-cost" type="checkbox"' + (p.showCostEstimate !== false ? ' checked' : '') + ' /></div>'
          + '<div class="setting-row"><label for="opt-lang">' + L.optLang + '</label><select id="opt-lang"><option value="zh-CN"' + (p.language !== 'en' ? ' selected' : '') + '>简体中文</option><option value="en"' + (p.language === 'en' ? ' selected' : '') + '>English</option></select></div>'
          + '</div>';
        document.getElementById('opt-footer').addEventListener('change', e => saveSetting({ enableFooterBar: e.target.checked }));
        document.getElementById('opt-turn').addEventListener('change', e => saveSetting({ enableTurnPills: e.target.checked }));
        document.getElementById('opt-quota').addEventListener('change', e => saveSetting({ showQuotaInSidebar: e.target.checked }));
        document.getElementById('opt-cost').addEventListener('change', e => saveSetting({ showCostEstimate: e.target.checked }));
        document.getElementById('opt-lang').addEventListener('change', e => saveSetting({ language: e.target.value }));
      }
      const uPrefsKey = (d.prefs?.language === 'en' ? 'en' : 'zh') + '|' + (d.prefs?.showCostEstimate !== false ? '1' : '0');
      if (currentTab === 'usage' && lastUsageData && uPrefsKey !== lastUsagePrefsKey) renderUsage(false);
    }

    function uParseYmd(ymd) {
      const p = String(ymd || '').split('-').map(Number);
      return new Date(p[0] || 2026, (p[1] || 1) - 1, p[2] || 1);
    }
    function uFmtYmd(dt) {
      return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
    }
    function uAddDays(ymd, delta) {
      const dt = uParseYmd(ymd);
      dt.setDate(dt.getDate() + delta);
      return uFmtYmd(dt);
    }
    function uWeekdayMon0(ymd) {
      const g = uParseYmd(ymd).getDay();
      return g === 0 ? 6 : g - 1;
    }
    function uFmtUsd(v) {
      return '$' + (Number(v) || 0).toFixed(2);
    }
    function uEmptyAgg(key, label) {
      return { key, label, uncached: 0, cached: 0, thinking: 0, reply: 0, output: 0, thinkingTrackedOutput: 0, total: 0, reqs: 0, modelSec: 0, ttftSum: 0, ttftCount: 0, timedOutput: 0, timedModelSec: 0, byModel: {}, activeDays: 0 };
    }
    function uAddModelStats(target, modelName, st) {
      let cur = target[modelName];
      if (!cur) {
        cur = { uncached: 0, cached: 0, thinking: 0, reply: 0, output: 0, thinkingTrackedOutput: 0, total: 0, reqs: 0, modelSec: 0, ttftSum: 0, ttftCount: 0, timedOutput: 0, timedModelSec: 0 };
        target[modelName] = cur;
      }
      const outVal = st.output || 0;
      cur.uncached += st.uncached || 0;
      cur.cached += st.cached || 0;
      cur.thinking += st.thinking || 0;
      cur.reply += st.reply || 0;
      cur.output += outVal;
      cur.thinkingTrackedOutput += st.thinkingTrackedOutput !== undefined ? (st.thinkingTrackedOutput || 0) : outVal;
      cur.total += st.total || 0;
      cur.reqs += st.reqs || 0;
      cur.modelSec += st.modelSec || 0;
      cur.ttftSum += st.ttftSum || 0;
      cur.ttftCount += st.ttftCount || 0;
      cur.timedOutput += st.timedOutput || 0;
      cur.timedModelSec += st.timedModelSec || 0;
    }
    function uMergeInto(agg, bucket) {
      if (!bucket) return;
      if ((bucket.activeDays || 0) > 0) agg.activeDays += bucket.activeDays;
      else if ((bucket.total || 0) > 0) agg.activeDays += 1;
      const outVal = bucket.output || 0;
      agg.uncached += bucket.uncached || 0;
      agg.cached += bucket.cached || 0;
      agg.thinking += bucket.thinking || 0;
      agg.reply += bucket.reply || 0;
      agg.output += outVal;
      agg.thinkingTrackedOutput += bucket.thinkingTrackedOutput !== undefined ? (bucket.thinkingTrackedOutput || 0) : outVal;
      agg.total += bucket.total || 0;
      agg.reqs += bucket.reqs || 0;
      agg.modelSec += bucket.modelSec || 0;
      agg.ttftSum += bucket.ttftSum || 0;
      agg.ttftCount += bucket.ttftCount || 0;
      agg.timedOutput += bucket.timedOutput || 0;
      agg.timedModelSec += bucket.timedModelSec || 0;
      for (const [m, st] of Object.entries(bucket.byModel || {})) uAddModelStats(agg.byModel, m, st);
    }
    function uCalcCosts(byModel) {
      let actual = 0, saved = 0;
      for (const [m, st] of Object.entries(byModel || {})) {
        const c = estimateModelCost(m, st.uncached, st.cached, st.output);
        actual += c.actualUsd;
        saved += c.savedUsd;
      }
      return { actualUsd: actual, savedUsd: saved };
    }
    function uHeatLvl(val, maxVal) {
      if (!val || val <= 0 || maxVal <= 0) return 0;
      const r = Math.sqrt(Math.min(1, val / maxVal));
      if (r < 0.2) return 1;
      if (r < 0.4) return 2;
      if (r < 0.6) return 3;
      if (r < 0.8) return 4;
      return 5;
    }
    function renderUsageBarSvg(buckets, modelColors, L, opts) {
      const w = 330, h = opts.height || 156, pT = 16, pB = 20, pL = 36, pR = 6;
      const plotW = w - pL - pR, plotH = h - pT - pB;
      const maxVal = Math.max(1, ...buckets.map(b => b.total || 0));
      const mag = Math.pow(10, Math.floor(Math.log10(maxVal)));
      const niceMax = Math.ceil(maxVal / mag) * mag;
      const slot = plotW / Math.max(1, buckets.length);
      const barW = Math.max(4, Math.min(26, slot * 0.64));
      const grid = [0, 0.5, 1].map(f => {
        const y = pT + plotH * (1 - f);
        return '<line x1="' + pL + '" y1="' + y.toFixed(1) + '" x2="' + (w - pR) + '" y2="' + y.toFixed(1) + '" stroke="var(--border, rgba(128,128,128,0.2))" stroke-dasharray="' + (f ? '3 3' : '') + '" />'
          + '<text x="' + (pL - 4) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end" fill="var(--muted-foreground, #71717a)" font-size="10.5">' + (f ? fmtCompact(niceMax * f) : '0') + '</text>';
      }).join('');
      const typeSeries = [
        ['cached', L.uTypeCached, TOKEN_TYPE_COLORS.cached],
        ['uncached', L.uTypeUncached, TOKEN_TYPE_COLORS.uncached],
        ['thinking', L.uTypeThinking, TOKEN_TYPE_COLORS.thinking],
        ['reply', L.uTypeReply, TOKEN_TYPE_COLORS.reply],
      ];
      const modelOrder = Object.keys(modelColors);
      const bars = buckets.map((b, idx) => {
        const cx = pL + slot * idx + slot / 2;
        const x = cx - barW / 2;
        let yc = pT + plotH;
        const segs = usageStackBy === 'model'
          ? modelOrder.filter(m => (b.byModel[m]?.total || 0) > 0).map(m => ({ v: b.byModel[m].total, c: modelColors[m] }))
          : typeSeries.filter(t => (b[t[0]] || 0) > 0).map(t => ({ v: b[t[0]], c: t[2] }));
        const rects = segs.map((s, si) => {
          const bh = Math.max(1.5, (s.v / niceMax) * plotH);
          yc -= bh;
          const rx = si === segs.length - 1 ? Math.min(2.5, barW / 3) : 0;
          return '<rect x="' + x.toFixed(1) + '" y="' + yc.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + bh.toFixed(1) + '" rx="' + rx + '" fill="' + s.c + '" />';
        }).join('');
        const isSel = (opts.dayClick && usageSelDay && b.key === usageSelDay) || (opts.hourClick && usageSelHour >= 0 && Number(b.key) === usageSelHour);
        const topTxt = opts.showTop && b.total > 0
          ? '<text x="' + cx.toFixed(1) + '" y="' + Math.max(10, yc - 3).toFixed(1) + '" text-anchor="middle" fill="var(--muted-foreground, #71717a)" font-size="10">' + fmtCompact(b.total) + '</text>'
          : '';
        const showTick = opts.xStep ? (idx % opts.xStep === 0 || idx === buckets.length - 1) : true;
        const tick = showTick
          ? '<text x="' + cx.toFixed(1) + '" y="' + (h - 5) + '" text-anchor="middle" fill="' + (isSel ? '#3b82f6' : 'var(--muted-foreground, #71717a)') + '" font-weight="' + (isSel ? '700' : '400') + '" font-size="10.5">' + esc(b.label) + '</text>'
          : '';
        const selBox = isSel ? '<rect x="' + (x - 1.5).toFixed(1) + '" y="' + pT + '" width="' + (barW + 3).toFixed(1) + '" height="' + plotH + '" rx="3" fill="none" stroke="#3b82f6" stroke-width="1.4" />' : '';
        const attr = opts.dayClick ? ' data-uday="' + esc(b.key) + '"' : opts.hourClick ? ' data-uhour="' + esc(b.key) + '"' : '';
        return '<g class="u-bar-hit"' + attr + ' data-utip="' + esc(b.tipKey) + '"><rect x="' + (pL + slot * idx).toFixed(1) + '" y="' + pT + '" width="' + slot.toFixed(1) + '" height="' + (plotH + 16) + '" fill="transparent" />' + rects + selBox + topTxt + tick + '</g>';
      }).join('');
      return '<svg viewBox="0 0 ' + w + ' ' + h + '" style="width:100%;height:auto;display:block;overflow:visible">' + grid + bars + '</svg>';
    }

    function hideUsageTip() {
      const el = document.getElementById('u-tip');
      if (el) el.hidden = true;
      activeUsageTipKey = '';
    }

    function showUsageTip(tipKey, cx, cy) {
      const el = document.getElementById('u-tip');
      const b = usageTipMap.get(tipKey);
      if (!el || !b) return;
      if (tipKey !== activeUsageTipKey || el.hidden) {
        const d = lastUsageData;
        const prefs = lastData?.prefs || d?.prefs || {};
        const isEn = prefs.language === 'en';
        const L = I18N[isEn ? 'en' : 'zh-CN'];
        const pin = (b.uncached || 0) + (b.cached || 0);
        const hit = pin > 0 ? (b.cached / pin) * 100 : null;
        const showCost = prefs.showCostEstimate !== false;
        const costs = uCalcCosts(b.byModel);
        const colors = assignModelColors(Object.entries(b.byModel || {}).map(([name, st]) => ({ name, total: st.total })));
        const rows = Object.entries(b.byModel || {}).filter(([, st]) => st.total > 0).sort((a, c) => c[1].total - a[1].total).slice(0, 6)
          .map(([name, st]) => '<div class="row" style="font-size:11px"><span class="row-k"><span class="dot" style="background:' + (colors[name] || '#3b82f6') + '"></span><span style="overflow:hidden;text-overflow:ellipsis;max-width:130px">' + esc(name) + '</span></span><span class="row-v">' + fmtCompact(st.total) + '</span></div>').join('');
        const bTracked = b.thinkingTrackedOutput !== undefined ? b.thinkingTrackedOutput : (b.output || 0);
        const bUnsplit = (b.output || 0) > 0 && bTracked === 0 && (b.thinking || 0) === 0;
        const tipThinkVal = bUnsplit ? ('— / ' + fmtCompact(b.reply) + ' (' + L.uUnsplitShort + ')') : (fmtCompact(b.thinking) + ' / ' + fmtCompact(b.reply));
        el.innerHTML = '<div style="font-weight:600;display:flex;justify-content:space-between;gap:8px;padding-bottom:5px;margin-bottom:5px;border-bottom:1px solid var(--border, rgba(128,128,128,0.2))"><span>' + esc(b.tipTitle || b.label) + '</span><span>' + fmtCompact(b.total) + ' tok</span></div>'
          + (b.total <= 0 ? '<div style="color:var(--muted-foreground, #71717a)">' + L.uEmpty + '</div>'
            : '<div class="rows" style="gap:4px">'
              + '<div class="row"><span class="row-k">' + L.cacheHit + '</span><span class="row-v">' + fmtPct(hit, 1) + '</span></div>'
              + '<div class="row"><span class="row-k">' + L.uThinkReply + '</span><span class="row-v">' + esc(tipThinkVal) + '</span></div>'
              + (showCost ? '<div class="row"><span class="row-k">' + L.uCostLabel + '</span><span class="row-v">' + uFmtUsd(costs.actualUsd) + '</span></div>' : '')
              + (rows ? '<div class="divider"></div>' + rows : '')
              + '</div>');
        el.hidden = false;
        const r = el.getBoundingClientRect();
        usageTipW = r.width;
        usageTipH = r.height;
        activeUsageTipKey = tipKey;
      }
      const left = Math.max(6, Math.min(window.innerWidth - usageTipW - 6, cx + 10));
      const top = Math.max(6, Math.min(window.innerHeight - usageTipH - 6, cy - usageTipH - 10));
      el.style.left = left + 'px';
      el.style.top = top + 'px';
    }

    function renderUsage(force = false) {
      const container = document.getElementById('view-usage');
      if (!container) return;
      const prefs = lastData?.prefs || lastUsageData?.prefs || {};
      const isEn = prefs.language === 'en';
      const L = I18N[isEn ? 'en' : 'zh-CN'];
      if (!lastUsageData) {
        container.innerHTML = '<div class="empty">' + L.uLoading + '</div>';
        return;
      }
      const stats = lastUsageData;
      const todayYmd = stats.todayYmd || uFmtYmd(new Date());
      const curMonth = todayYmd.slice(0, 7);
      if (!usageMonthYm) usageMonthYm = curMonth;
      const daysObj = stats.days || {};
      const allDayKeys = Object.keys(daysObj).sort();
      const minMonth = allDayKeys[0] ? allDayKeys[0].slice(0, 7) : curMonth;
      if (usageMonthYm > curMonth) usageMonthYm = curMonth;
      if (usageMonthYm < minMonth) usageMonthYm = minMonth;
      const prefsKey = (isEn ? 'en' : 'zh') + '|' + (prefs.showCostEstimate !== false ? '1' : '0');
      const renderSig = [
        stats.generatedAtMs || 0,
        todayYmd,
        stats.dbCount || 0,
        prefsKey,
        usageRange,
        usageMonthYm,
        usageMonthChart,
        usageAllChart,
        usageStackBy,
        usageSelDay,
        usageSelHour,
      ].join('|');
      if (!force && renderSig === lastUsageSig && lastUsageHtml) return;
      lastUsageSig = renderSig;
      lastUsagePrefsKey = prefsKey;

      usageTipMap = new Map();
      const dayBucketFor = (ymd) => {
        const b = uEmptyAgg(ymd, ymd.slice(5));
        if (daysObj[ymd]) uMergeInto(b, daysObj[ymd]);
        b.tipKey = 'd:' + ymd;
        b.tipTitle = ymd + ' (' + L.uWeekdays[uWeekdayMon0(ymd)] + ')';
        usageTipMap.set(b.tipKey, b);
        return b;
      };

      let buckets = [];
      let chartTitle = L.uTitleMonth;
      let barOpts = { showTop: false, xStep: 0, dayClick: false, hourClick: false };
      if (usageRange === 'today') {
        chartTitle = L.uTitleToday;
        buckets = (stats.todayHours || []).map((hb, h) => {
          const b = uEmptyAgg(String(h), String(h).padStart(2, '0'));
          uMergeInto(b, hb);
          b.tipKey = 'h:' + h;
          b.tipTitle = todayYmd + ' ' + String(h).padStart(2, '0') + ':00';
          usageTipMap.set(b.tipKey, b);
          return b;
        });
        barOpts = { showTop: false, xStep: 4, hourClick: true };
      } else if (usageRange === 'week') {
        chartTitle = L.uTitleWeek;
        const monYmd = uAddDays(todayYmd, -uWeekdayMon0(todayYmd));
        for (let i = 0; i < 7; i++) {
          const d = uAddDays(monYmd, i);
          const b = dayBucketFor(d);
          b.label = L.uWeekdays[i];
          buckets.push(b);
        }
        barOpts = { showTop: true, xStep: 0, dayClick: true };
      } else if (usageRange === 'month') {
        chartTitle = L.uTitleMonth;
        const [yy, mm] = usageMonthYm.split('-').map(Number);
        const dim = new Date(yy, mm, 0).getDate();
        for (let d = 1; d <= dim; d++) {
          const ymd = usageMonthYm + '-' + String(d).padStart(2, '0');
          const b = dayBucketFor(ymd);
          b.label = String(d);
          buckets.push(b);
        }
        barOpts = { showTop: false, xStep: 5, dayClick: true };
      } else {
        chartTitle = L.uTitleAll;
        const monthMap = new Map();
        for (const ymd of allDayKeys) {
          dayBucketFor(ymd);
          const ym = ymd.slice(0, 7);
          if (!monthMap.has(ym)) monthMap.set(ym, uEmptyAgg(ym, ym.slice(2).replace('-', '/')));
          uMergeInto(monthMap.get(ym), daysObj[ymd]);
        }
        buckets = [...monthMap.values()].map(b => {
          b.tipKey = 'm:' + b.key;
          b.tipTitle = b.key;
          usageTipMap.set(b.tipKey, b);
          return b;
        });
        barOpts = { showTop: true, xStep: buckets.length > 8 ? 2 : 0 };
      }

      const rangeAgg = uEmptyAgg('range', 'range');
      for (const b of buckets) uMergeInto(rangeAgg, b);
      if (usageRange === 'today') rangeAgg.activeDays = rangeAgg.total > 0 ? 1 : 0;

      const selAgg = uEmptyAgg('sel', 'sel');
      if (usageRange === 'today' && usageSelHour >= 0 && buckets[usageSelHour]) {
        uMergeInto(selAgg, buckets[usageSelHour]);
      } else if (usageRange !== 'today' && usageSelDay) {
        uMergeInto(selAgg, dayBucketFor(usageSelDay));
      } else {
        uMergeInto(selAgg, rangeAgg);
      }

      const modelColors = assignModelColors(Object.entries(rangeAgg.byModel).map(([name, st]) => ({ name, total: st.total })));
      const showCost = prefs.showCostEstimate !== false;

      let chartInner = '';
      if (usageRange === 'month' && usageMonthChart === 'calendar') {
        const [yy, mm] = usageMonthYm.split('-').map(Number);
        const lead = uWeekdayMon0(usageMonthYm + '-01');
        const maxM = Math.max(0, ...buckets.map(b => b.total));
        const wds = L.uWeekdays.map(w => '<div class="u-cal-wd">' + esc(w) + '</div>').join('');
        let cells = '';
        for (let i = 0; i < lead; i++) cells += '<div></div>';
        buckets.forEach((b, idx) => {
          const lvl = uHeatLvl(b.total, maxM);
          const isSel = usageSelDay === b.key;
          cells += '<button type="button" class="u-cal-cell u-heat-' + lvl + (isSel ? ' u-sel' : '') + '" data-uday="' + esc(b.key) + '" data-utip="' + esc(b.tipKey) + '">'
            + '<span class="u-cal-num">' + (idx + 1) + '</span>'
            + '<span class="u-cal-val">' + (b.total > 0 ? fmtCompact(b.total) : '') + '</span></button>';
        });
        chartInner = '<div class="u-cal-nav"><button type="button" class="u-nav-btn" data-umonth="-1"' + (usageMonthYm <= minMonth ? ' disabled' : '') + '>&lt;</button><b>' + esc(L.uMonthTitle(yy, mm)) + '</b><button type="button" class="u-nav-btn" data-umonth="1"' + (usageMonthYm >= curMonth ? ' disabled' : '') + '>&gt;</button></div>'
          + '<div class="u-cal-grid">' + wds + cells + '</div>';
      } else if (usageRange === 'all' && usageAllChart === 'heatmap') {
        const weeks = 16;
        const endYmd = uAddDays(todayYmd, 6 - uWeekdayMon0(todayYmd));
        const startYmd = uAddDays(endYmd, -(weeks * 7 - 1));
        const allCells = [];
        let maxH = 0;
        for (let i = 0; i < weeks * 7; i++) {
          const ymd = uAddDays(startYmd, i);
          const b = dayBucketFor(ymd);
          if (b.total > maxH) maxH = b.total;
          allCells.push(b);
        }
        let prevM = '', mHtml = '', colsHtml = '';
        for (let w = 0; w < weeks; w++) {
          const col = allCells.slice(w * 7, w * 7 + 7);
          const ym = col[0].key.slice(0, 7);
          const skipLead = w === 0 && w + 1 < weeks && allCells[(w + 1) * 7].key.slice(0, 7) !== ym;
          const lbl = (!skipLead && ym !== prevM) ? (Number(ym.slice(5)) + (isEn ? '' : '月')) : '';
          prevM = ym;
          mHtml += '<span class="u-heat-month">' + esc(lbl) + '</span>';
          colsHtml += '<div class="u-heat-col">' + col.map(b => {
            const lvl = uHeatLvl(b.total, maxH);
            return '<button type="button" class="u-heat-sq u-heat-' + lvl + (usageSelDay === b.key ? ' u-sel' : '') + '" data-uday="' + esc(b.key) + '" data-utip="' + esc(b.tipKey) + '" aria-label="' + esc(b.key) + '"></button>';
          }).join('') + '</div>';
        }
        const dlbls = [L.uWeekdays[0], '', L.uWeekdays[2], '', L.uWeekdays[4], '', L.uWeekdays[6]].map(x => '<span>' + esc(x) + '</span>').join('');
        chartInner = '<div class="u-heat-months">' + mHtml + '</div>'
          + '<div class="u-heat-body"><div class="u-heat-days">' + dlbls + '</div><div class="u-heat-cols">' + colsHtml + '</div></div>'
          + '<div class="u-heat-foot"><span>' + esc(L.uWeeksHint(weeks)) + '</span><span class="u-scale"><span>' + L.uLess + '</span><span class="u-scale-sq u-heat-0"></span><span class="u-scale-sq u-heat-1"></span><span class="u-scale-sq u-heat-2"></span><span class="u-scale-sq u-heat-3"></span><span class="u-scale-sq u-heat-4"></span><span class="u-scale-sq u-heat-5"></span><span>' + L.uMore + '</span></span></div>';
      } else {
        const legendItems = usageStackBy === 'model'
          ? Object.entries(modelColors).map(([n, c]) => '<span class="u-leg-item"><span class="dot" style="background:' + c + '"></span><span>' + esc(n) + '</span></span>').join('')
          : [
              [TOKEN_TYPE_COLORS.cached, L.uTypeCached],
              [TOKEN_TYPE_COLORS.uncached, L.uTypeUncached],
              [TOKEN_TYPE_COLORS.thinking, L.uTypeThinking],
              [TOKEN_TYPE_COLORS.reply, L.uTypeReply],
            ].map(x => '<span class="u-leg-item"><span class="dot" style="background:' + x[0] + '"></span><span>' + esc(x[1]) + '</span></span>').join('');
        const stackToggle = '<div class="u-toolbar" style="margin-bottom:4px"><span style="font-size:11.5px;color:var(--muted-foreground)">' + (usageRange === 'month' ? esc(usageMonthYm) : '') + '</span><div class="u-seg2"><button type="button" class="u-seg-btn" data-ustack="model" aria-selected="' + (usageStackBy === 'model') + '">' + L.uStackModel + '</button><button type="button" class="u-seg-btn" data-ustack="type" aria-selected="' + (usageStackBy === 'type') + '">' + L.uStackType + '</button></div></div>';
        chartInner = stackToggle + renderUsageBarSvg(buckets, modelColors, L, barOpts) + (legendItems ? '<div class="u-legend">' + legendItems + '</div>' : '');
      }

      const modeSwitch = usageRange === 'month'
        ? '<div class="u-seg2"><button type="button" class="u-seg-btn" data-uchart="month:calendar" aria-selected="' + (usageMonthChart === 'calendar') + '">' + L.uModeCal + '</button><button type="button" class="u-seg-btn" data-uchart="month:bar" aria-selected="' + (usageMonthChart === 'bar') + '">' + L.uModeBar + '</button></div>'
        : usageRange === 'all'
          ? '<div class="u-seg2"><button type="button" class="u-seg-btn" data-uchart="all:heatmap" aria-selected="' + (usageAllChart === 'heatmap') + '">' + L.uModeHeat + '</button><button type="button" class="u-seg-btn" data-uchart="all:bar" aria-selected="' + (usageAllChart === 'bar') + '">' + L.uModeBar + '</button></div>'
          : '';

      const filterBanner = (usageRange === 'today' && usageSelHour >= 0)
        ? '<div class="u-filter"><span>' + esc(L.uFilteredHour(String(usageSelHour).padStart(2, '0'))) + '</span><button type="button" id="u-clear" class="u-clear-btn">' + L.uClearFilter + '</button></div>'
        : (usageRange !== 'today' && usageSelDay)
          ? '<div class="u-filter"><span>' + esc(L.uFilteredDay(usageSelDay)) + '</span><button type="button" id="u-clear" class="u-clear-btn">' + L.uClearFilter + '</button></div>'
          : '';

      const pin = selAgg.uncached + selAgg.cached;
      const hitPct = pin > 0 ? (selAgg.cached / pin) * 100 : null;
      const trackedOut = selAgg.thinkingTrackedOutput !== undefined ? selAgg.thinkingTrackedOutput : selAgg.output;
      const allUnsplit = selAgg.output > 0 && trackedOut === 0 && selAgg.thinking === 0;
      const hasUnsplit = selAgg.output > 0 && trackedOut > 0 && trackedOut < selAgg.output;
      const thinkPct = trackedOut > 0 ? Math.min(100, (selAgg.thinking / trackedOut) * 100) : 0;
      const replyPct = trackedOut > 0 ? Math.max(0, 100 - thinkPct) : (allUnsplit ? 100 : 0);
      const summaryThinkVal = allUnsplit ? ('— / ' + fmtCompact(selAgg.output) + ' (' + L.uUnsplitShort + ')') : (fmtCompact(selAgg.thinking) + ' / ' + fmtCompact(selAgg.reply));
      const summaryThinkNote = allUnsplit ? L.uThinkUnsplit : (hasUnsplit ? (L.uThinkRatio(Math.round(thinkPct)) + ' · ' + L.uThinkExcl) : L.uThinkRatio(Math.round(thinkPct)));
      const selCosts = uCalcCosts(selAgg.byModel);
      const selColors = assignModelColors(Object.entries(selAgg.byModel).map(([name, st]) => ({ name, total: st.total })));
      const selModels = Object.entries(selAgg.byModel).filter(([, st]) => st.total > 0).sort((a, c) => c[1].total - a[1].total);
      const totDenom = Math.max(1, selAgg.total);

      const modelsHtml = selModels.length === 0
        ? '<div class="empty">' + L.uEmpty + '</div>'
        : '<div class="mblocks">' + selModels.map(([name, st]) => {
            const share = (st.total / totDenom) * 100;
            const mPin = st.uncached + st.cached;
            const mHit = mPin > 0 ? (st.cached / mPin) * 100 : null;
            const mTps = st.timedModelSec > 0 ? st.timedOutput / st.timedModelSec : null;
            const mTtft = st.ttftCount > 0 ? st.ttftSum / st.ttftCount : null;
            const mCost = estimateModelCost(name, st.uncached, st.cached, st.output);
            const col = selColors[name] || '#3b82f6';
            const mTracked = st.thinkingTrackedOutput !== undefined ? st.thinkingTrackedOutput : st.output;
            const mUnsplit = (st.output || 0) > 0 && mTracked === 0 && (st.thinking || 0) === 0;
            const mThinkVal = mUnsplit ? ('— / ' + fmtCompact(st.output) + ' (' + L.uUnsplitShort + ')') : (fmtCompact(st.thinking) + ' / ' + fmtCompact(st.reply));
            return '<div class="mblock">'
              + '<div class="mhead"><span class="mname" style="display:inline-flex;align-items:center;gap:6px"><span class="dot" style="background:' + col + '"></span><span style="overflow:hidden;text-overflow:ellipsis" title="' + esc(name) + '">' + esc(name) + '</span></span><span class="mstat">' + fmtCompact(st.total) + ' · ' + share.toFixed(0) + '%</span></div>'
              + '<div class="mbar"><span class="mbar-fill" style="width:' + share.toFixed(1) + '%;background:' + col + '"></span></div>'
              + '<div class="rows" style="gap:4px;font-size:12px">'
              + '<div class="row"><span class="row-k">' + L.reqCountLabel + '</span><span class="row-v">' + esc(L.reqsUnit(st.reqs)) + '</span></div>'
              + '<div class="row"><span class="row-k">' + L.cacheHit + '</span><span class="row-v">' + fmtPct(mHit, 1) + '</span></div>'
              + '<div class="row"><span class="row-k">' + L.uncachedIn + ' / ' + L.cachedRead + '</span><span class="row-v">' + fmtCompact(st.uncached) + ' / ' + fmtCompact(st.cached) + '</span></div>'
              + '<div class="row"><span class="row-k">' + L.uThinkReply + '</span><span class="row-v">' + esc(mThinkVal) + '</span></div>'
              + '<div class="row"><span class="row-k">' + L.avgTtft + ' / TPS</span><span class="row-v">' + esc(mTtft != null ? fmtDur(mTtft, isEn) : '—') + ' · ' + esc(fmtTps(mTps)) + '</span></div>'
              + (showCost ? '<div class="row"><span class="row-k">' + L.uCostLabel + '</span><span class="row-v">' + uFmtUsd(mCost.actualUsd) + '</span></div>' : '')
              + '</div></div>';
          }).join('') + '</div>';

      const nextHtml = '<div class="cards">'
        + '<div class="u-seg4">'
        + ['today', 'week', 'month', 'all'].map(r => '<button type="button" class="u-seg-btn" data-urange="' + r + '" aria-selected="' + (usageRange === r) + '">' + L['uRange' + r[0].toUpperCase() + r.slice(1)] + '</button>').join('')
        + '</div>'
        + '<div class="card"><div class="card-head"><span class="card-title">' + SVG_CTX + '<span>' + esc(chartTitle) + '</span></span>' + modeSwitch + '</div>' + chartInner + '</div>'
        + filterBanner
        + '<div class="card">'
        + '<div class="card-head"><span class="card-title">' + SVG_DB + '<span>' + L.uSummaryTitle + '</span></span><span class="card-val">' + fmtExact(selAgg.total) + ' tok</span></div>'
        + '<div class="u-kpi-grid">'
        + '<div class="u-kpi-box"><div class="u-kpi-k">' + L.cacheHit + '</div><div class="u-kpi-v">' + fmtPct(hitPct, 1) + '</div></div>'
        + '<div class="u-kpi-box"><div class="u-kpi-k">' + L.reqCountLabel + '</div><div class="u-kpi-v">' + esc(L.uActiveDays(selAgg.reqs, selAgg.activeDays || (selAgg.total > 0 ? 1 : 0))) + '</div></div>'
        + '</div>'
        + '<div class="rows">'
        + '<div class="row"><span class="row-k">' + L.cachedRead + ' / ' + L.uncachedIn + '</span><span class="row-v">' + fmtCompact(selAgg.cached) + ' / ' + fmtCompact(selAgg.uncached) + '</span></div>'
        + '<div class="row"><span class="row-k">' + L.uThinkReply + '</span><span class="row-v">' + esc(summaryThinkVal) + '</span></div>'
        + '<div class="u-think-bar"><span style="width:' + thinkPct.toFixed(1) + '%;background:' + TOKEN_TYPE_COLORS.thinking + '"></span><span style="width:' + replyPct.toFixed(1) + '%;background:' + TOKEN_TYPE_COLORS.reply + '"></span></div>'
        + '<div style="font-size:11.5px;color:var(--muted-foreground)">' + esc(summaryThinkNote) + '</div>'
        + (showCost ? '<div class="divider"></div><div class="row"><span class="row-k">' + L.uCostLabel + '</span><span class="row-v">' + uFmtUsd(selCosts.actualUsd) + '</span></div><div class="row"><span class="row-k">' + L.uSavedLabel + '</span><span class="row-v badge-ok">' + uFmtUsd(selCosts.savedUsd) + '</span></div>' : '')
        + '</div></div>'
        + '<div class="card"><div class="card-head"><span class="card-title">' + SVG_GAUGE + '<span>' + L.uModelsTitle + '</span></span><span class="card-val">' + esc(L.modelsCount(selModels.length)) + '</span></div>' + modelsHtml + '</div>'
        + '</div>';

      if (force || nextHtml !== lastUsageHtml) {
        container.innerHTML = nextHtml;
        lastUsageHtml = nextHtml;
      }
    }

    document.getElementById('view-usage').addEventListener('click', (e) => {
      const rBtn = e.target.closest('[data-urange]');
      if (rBtn) { usageRange = rBtn.dataset.urange; usageSelDay = ''; usageSelHour = -1; hideUsageTip(); renderUsage(true); return; }
      const cBtn = e.target.closest('[data-uchart]');
      if (cBtn) {
        const parts = cBtn.dataset.uchart.split(':');
        if (parts[0] === 'month') usageMonthChart = parts[1];
        else usageAllChart = parts[1];
        hideUsageTip();
        renderUsage(true);
        return;
      }
      const sBtn = e.target.closest('[data-ustack]');
      if (sBtn) { usageStackBy = sBtn.dataset.ustack; renderUsage(true); return; }
      const mBtn = e.target.closest('[data-umonth]');
      if (mBtn && !mBtn.disabled) {
        const dt = uParseYmd((usageMonthYm || '2026-11') + '-01');
        dt.setMonth(dt.getMonth() + Number(mBtn.dataset.umonth));
        usageMonthYm = uFmtYmd(dt).slice(0, 7);
        usageSelDay = '';
        renderUsage(true);
        return;
      }
      const dBtn = e.target.closest('[data-uday]');
      if (dBtn) { const d = dBtn.dataset.uday; usageSelDay = usageSelDay === d ? '' : d; renderUsage(true); return; }
      const hBtn = e.target.closest('[data-uhour]');
      if (hBtn) { const h = Number(hBtn.dataset.uhour); usageSelHour = usageSelHour === h ? -1 : h; renderUsage(true); return; }
      if (e.target.closest('#u-clear')) { usageSelDay = ''; usageSelHour = -1; renderUsage(true); }
    });
    document.getElementById('view-usage').addEventListener('mousemove', (e) => {
      const t = e.target.closest('[data-utip]');
      if (t) showUsageTip(t.dataset.utip, e.clientX, e.clientY);
      else hideUsageTip();
    });
    document.getElementById('view-usage').addEventListener('mouseleave', hideUsageTip);

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
        hideUsageTip();
        for (const b of document.querySelectorAll('.tab-btn')) b.setAttribute('aria-selected', String(b === btn));
        for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== 'view-' + currentTab;
        if (currentTab === 'usage') {
          if (lastUsageData) renderUsage(false);
          refreshUsage(Boolean(lastUsageData?.todayYmd && lastUsageData.todayYmd !== uFmtYmd(new Date())));
        }
        if (lastData) {
          if (currentTab === 'settings') document.getElementById('view-settings').innerHTML = '';
          render(lastData, true);
        }
      });
    }

    async function refreshUsage(forceReq = false) {
      if (usageInFlight) return;
      if (!forceReq && document.hidden) return;
      usageInFlight = true;
      try {
        const { token } = apiParams();
        const url = '/api/usage-stats' + (forceReq ? '?force=1' : '');
        const headers = token ? { 'X-Sidecar-Token': token } : {};
        const res = await fetchWithTimeout(url, { headers }, 15000);
        const d = await res.json();
        if (!d.error) {
          lastUsageData = d;
          if (currentTab === 'usage') renderUsage(false);
        }
      } catch {}
      finally {
        usageInFlight = false;
      }
    }

    async function refresh(forceReq = false) {
      if (telemetryInFlight) return;
      if (!forceReq && document.hidden) return;
      telemetryInFlight = true;
      try {
        const { token, convId } = apiParams();
        const qs = new URLSearchParams();
        if (convId) qs.set('conversationId', convId);
        const url = '/api/telemetry' + (qs.toString() ? '?' + qs.toString() : '');
        const headers = token ? { 'X-Sidecar-Token': token } : {};
        const res = await fetchWithTimeout(url, { headers }, 5000);
        const d = await res.json();
        if (!d.error) render(d);
      } catch {}
      finally {
        telemetryInFlight = false;
      }
    }

    function parseRgbColor(str) {
      const s = String(str || '').trim().toLowerCase();
      if (!s.startsWith('rgb')) return null;
      const i0 = s.indexOf('('), i1 = s.indexOf(')');
      if (i0 < 0 || i1 < i0) return null;
      const nums = s.slice(i0 + 1, i1).replace(/[/,]/g, ' ').trim().split(' ').filter(Boolean).map(Number);
      if (nums.length < 3 || nums.some(n => !Number.isFinite(n))) return null;
      if (nums.length >= 4 && nums[3] === 0) return null;
      return [nums[0], nums[1], nums[2]];
    }

    function syncHostTheme() {
      const root = document.documentElement;
      const cs = getComputedStyle(document.body);
      const rs = getComputedStyle(root);
      let rgb = parseRgbColor(cs.backgroundColor) || parseRgbColor(rs.backgroundColor);
      if (!rgb) {
        const bgVar = rs.getPropertyValue('--background').trim();
        rgb = parseRgbColor(bgVar);
        if (!rgb) {
          const hx = bgVar.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
          if (hx) {
            let h = hx[1];
            if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
            rgb = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
          }
        }
      }
      const isDark = rgb
        ? (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) < 140
        : Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      const mode = isDark ? 'dark' : 'light';
      if (root.dataset.theme !== mode) root.dataset.theme = mode;
      if (root.style.colorScheme !== mode) root.style.colorScheme = mode;
    }

    syncHostTheme();
    setTimeout(syncHostTheme, 150);
    try {
      new MutationObserver(() => syncHostTheme()).observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['style', 'class', 'data-theme'],
      });
      if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncHostTheme);
      }
    } catch {}

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        refresh(true);
        if (currentTab === 'usage') refreshUsage(true);
      }
    });

    refresh(true);
    setInterval(() => refresh(false), 1000);
    setInterval(() => {
      if (currentTab !== 'usage' || document.hidden) return;
      const dayChanged = Boolean(lastUsageData?.todayYmd && lastUsageData.todayYmd !== uFmtYmd(new Date()));
      refreshUsage(dayChanged);
    }, 15000);
  </script>
</body>
</html>`;
}

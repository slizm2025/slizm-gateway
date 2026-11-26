/**
 * Slizm Gateway Admin Console Frontend
 * Pure JavaScript, no external runtime dependencies, no inline event handlers.
 */
(function () {
  "use strict";

  // --- 全局状态 ---
  const state = {
    activeView: "overview", // "overview" | "usage" | "logs" | "settings"
    // 时间范围：预设（today / 15m / 7d …）或自定义 { period: "custom", since, until }（毫秒，until 不含）
    range: { period: "today" },
    rangeHistory: [],
    rangeInfo: null,
    trendStep: "auto",
    trendStepInfo: null,
    trendModels: [],
    // 每个分桶按模型 key 建索引，绘图时不必反复查找
    trendIndex: [],
    trendHidden: new Set(),
    trendColors: new Map(),
    trendLegendKeys: null,
    trendLegendRows: [],
    trendBrush: null,
    trendSkipClick: false,
    providerFilter: "",
    trendMetric: "tokens", // "tokens" | "cost"
    isGatewayOnline: false,
    activeRequestsCount: 0,
    switchboardActiveCount: 0,
    isRestarting: false,
    isClearingLogs: false,
    overviewReqSeq: 0,
    pollTimer: null,
    liveTimer: null,
    liveBusy: false,
    liveEpoch: 0,
    liveSnapshot: null,
    liveTopologyHoldUntil: 0,
    liveTopologyHeld: [],
    liveInstanceId: null,
    inflightDisplay: new Map(),
    overviewData: null,
    autoRefresh: true,
    // 已展开的金额明细（按稳定 key 记录），轮询重绘后保持展开
    openCostKeys: new Set(),
    trendData: [],
    trendPoints: [],
    trendActiveIndex: null,
    trendPinned: false,
    trendReveal: 1,
    trendRevealFrame: null,
    trendNeedsReveal: true,
    hasRendered: false,
    theme: "system", // "light" | "dark" | "system"

    // 交换台：Agent、适配器、上游线路的数据与 DOM 引用
    switchboard: {
      lines: [],
      active: [],
      topology: [],
      retained: [],
      configured: [],
      agents: [],
      providers: [],
      selectedAgent: null,
      agentRows: [],
      rows: [],
      lineStructure: null,
      // 上游默认只列出正在被调用的模型；打开后列出全部
      showAllUpstreams: false,
      // 已展开（显示全部转换）的适配器，按入口协议记录
      openAdapters: new Set(),
      pathRows: new Map(),
      modelRows: new Map(),
      wireCache: null,
      internalWireCache: null,
      flowRequests: new Map(),
      flowRefs: [],
      flowFrame: null,
      flowScope: null
    },

    // 请求日志状态
    logs: {
      source: "out",
      errorsOnly: false,
      q: "",
      follow: true,
      pollTimer: null,
      rawLines: [],
      viewKey: null
    },

    // 基础设置草稿状态
    settings: {
      serverRevision: null,
      initialDraftJson: "",
      draft: null,
      isEditing: false,
      // 编辑器中每个可定位条目：{ el, focus, text() }，用于跳转、搜索与高亮
      anchors: { provider: [], route: [], pricing: [] }
    },

    // 路由/视图切换待确认目标
    pendingView: null
  };

  // --- DOM 元素引用 ---
  const $ = (id) => document.getElementById(id);
  const els = {
    // 头部
    statusBadge: $("gw-status-badge"),
    restartBadge: $("restart-badge"),
    metaPid: $("meta-pid"),
    metaUptime: $("meta-uptime"),
    metaActive: $("meta-active"),
    metaBaseUrl: $("meta-baseurl"),
    btnOpenRestart: $("btn-open-restart"),
    authExpiredBanner: $("auth-expired-banner"),
    btnReconnectSession: $("btn-reconnect-session"),
    overviewErrorBanner: $("overview-error-banner"),
    overviewErrorMsg: $("overview-error-msg"),

    // 导航
    navTabs: document.querySelectorAll(".nav-tab"),
    navIndicator: $("nav-indicator"),
    btnCollapseSidebar: $("btn-collapse-sidebar"),
    btnTheme: $("btn-theme"),
    themeText: $("theme-text"),
    iconTheme: $("icon-theme"),
    currentViewTitle: $("current-view-title"),
    currentViewDescription: $("current-view-description"),
    overviewFilters: $("overview-filters"),
    viewOverview: $("view-overview"),
    viewUsage: $("view-usage"),
    viewLogs: $("view-logs"),
    viewSettings: $("view-settings"),

    // 概览
    switchboard: $("switchboard"),
    sbCoreLamp: $("sb-core-lamp"),
    sbActive: $("sb-active"),
    sbCoreState: $("sb-core-state"),
    sbBaseUrl: $("sb-baseurl"),
    sbWires: $("sb-wires"),
    sbInternalWires: $("sb-internal-wires"),
    sbLines: $("sb-lines"),
    sbAgents: $("sb-agents"),
    sbAdapters: $("sb-adapters"),
    sbAdapterCount: $("sb-adapter-count"),
    sbEntryPort: $("sb-entry-port"),
    sbEntryAnchor: $("sb-entry-anchor"),
    sbExitPort: $("sb-exit-port"),
    sbExitAnchor: $("sb-exit-anchor"),
    sbUpstreamToggle: $("sb-upstream-toggle"),
    sbEmptyText: $("sb-empty-text"),
    sbAgentCount: $("sb-agent-count"),
    sbUpstreamCount: $("sb-upstream-count"),
    sbEmpty: $("sb-empty"),
    filterPeriod: $("filter-period"),
    btnTimePicker: $("btn-time-picker"),
    timePickerLabel: $("time-picker-label"),
    timePickerPanel: $("time-picker-panel"),
    timeQuick: $("time-quick"),
    rangeSince: $("range-since"),
    rangeUntil: $("range-until"),
    rangeError: $("range-error"),
    btnApplyRange: $("btn-apply-range"),
    trendStep: $("trend-step"),
    trendRangeLabel: $("trend-range-label"),
    btnTrendZoomOut: $("btn-trend-zoom-out"),
    trendLegend: $("trend-legend"),
    trendTooltipMeta: $("trend-tooltip-meta"),
    trendTooltipModels: $("trend-tooltip-models"),
    filterProvider: $("filter-provider"),
    btnRefreshOverview: $("btn-refresh-overview"),
    overviewUpdatedAt: $("overview-updated-at"),
    btnAutoRefresh: $("btn-auto-refresh"),
    iconAutoRefresh: $("icon-auto-refresh"),
    autoRefreshState: $("auto-refresh-state"),
    mRequests: $("m-requests"),
    mErrors: $("m-errors"),
    mCancelled: $("m-cancelled"),
    mCost: $("m-cost"),
    mCostSub: $("m-cost-sub"),
    mTokens: $("m-tokens"),
    mInput: $("m-input"),
    mOutput: $("m-output"),
    mCache: $("m-cache"),
    mCacheHit: $("m-cache-hit"),
    mUnreported: $("m-unreported"),
    mTpsCurrent: $("m-tps-current"),
    mTpsPeak: $("m-tps-peak"),
    mTpsAvg: $("m-tps-avg"),
    mOutputTps: $("m-output-tps"),
    trendMetricToggle: $("trend-metric-toggle"),
    trendCanvas: $("trend-canvas"),
    trendEmpty: $("trend-empty"),
    trendTooltip: $("trend-tooltip"),
    trendTooltipValue: $("trend-tooltip-value"),
    trendTooltipAdjusted: $("trend-tooltip-adjusted"),
    trendTooltipTime: $("trend-tooltip-time"),
    trendDataBody: $("trend-data-body"),
    trendDataValueHeading: $("trend-data-value-heading"),
    trendDataAdjustedHeading: $("trend-data-adjusted-heading"),
    inflightCount: $("inflight-count"),
    tableInflightBody: document.querySelector("#table-inflight tbody"),
    tableProvidersBody: document.querySelector("#table-providers tbody"),
    tableModelsBody: document.querySelector("#table-models tbody"),
    tableRecentBody: document.querySelector("#table-recent tbody"),

    // 日志
    logsSource: $("logs-source"),
    logsErrorsToggle: $("logs-errors-toggle"),
    logsSearch: $("logs-search"),
    btnToggleFollow: $("btn-toggle-follow"),
    followText: $("follow-text"),
    iconFollowStatus: $("icon-follow-status"),
    btnDownloadLogs: $("btn-download-logs"),
    btnClearLogs: $("btn-clear-logs"),
    btnRefreshLogs: $("btn-refresh-logs"),
    logsTruncatedWarning: $("logs-truncated-warning"),
    logsTerminal: $("logs-terminal"),

    // 设置
    settingsReadonly: $("settings-readonly"),
    settingsEditor: $("settings-editor"),
    btnEditSettings: $("btn-edit-settings"),
    btnCancelSettings: $("btn-cancel-settings"),
    settingsProviderCount: $("settings-provider-count"),
    settingsRouteCount: $("settings-route-count"),
    settingsDefaultRoute: $("settings-default-route"),
    settingsLogRequests: $("settings-log-requests"),
    settingsProvidersReadonly: $("settings-providers-readonly"),
    settingsRoutesReadonly: $("settings-routes-readonly"),
    settingsErrorsBanner: $("settings-errors-banner"),
    settingsErrorsList: $("settings-errors-list"),
    btnSaveSettings: $("btn-save-settings"),
    settingLogRequests: $("setting-log-requests"),
    settingDefaultRoute: $("setting-default-route"),
    btnAddProvider: $("btn-add-provider"),
    providersList: $("providers-list"),
    btnAddRoute: $("btn-add-route"),
    routesTbody: $("routes-tbody"),
    btnAddPricing: $("btn-add-pricing"),
    pricingTbody: $("pricing-tbody"),
    settingsEditorBar: $("settings-editor-bar"),
    settingsDirtyText: $("settings-dirty-text"),
    settingsJump: $("settings-jump"),
    settingsJumpProviders: $("settings-jump-providers"),
    settingsJumpRoutes: $("settings-jump-routes"),
    settingsJumpPricing: $("settings-jump-pricing"),
    settingsFilter: $("settings-filter"),
    btnExpandProviders: $("btn-expand-providers"),
    btnCollapseProviders: $("btn-collapse-providers"),
    settingsPricingReadonly: $("settings-pricing-readonly"),

    viewSubagents: $("view-subagents"),

    // 模态框
    modalClearLogs: $("modal-clear-logs"),
    modalClearLogsClose: $("modal-clear-logs-close"),
    clearLogsErrorMsg: $("clear-logs-error-msg"),
    btnCancelClearLogs: $("btn-cancel-clear-logs"),
    btnConfirmClearLogs: $("btn-confirm-clear-logs"),


    // 模态框 (系统原有)
    modalRestart: $("modal-restart"),
    modalRestartClose: $("modal-restart-close"),
    btnCancelRestart: $("btn-cancel-restart"),
    btnConfirmRestart: $("btn-confirm-restart"),
    restartErrorMsg: $("restart-error-msg"),
    modalUnsaved: $("modal-unsaved"),
    unsavedMessage: $("unsaved-message"),
    modalUnsavedClose: $("modal-unsaved-close"),
    btnUnsavedStay: $("btn-unsaved-stay"),
    btnUnsavedDiscard: $("btn-unsaved-discard"),

    // Toast
    toastContainer: $("toast-container")
  };

  // --- 通用工具函数 ---
  function showToast(message, type = "info") {
    const toast = document.createElement("div");
    toast.className = "toast" + (type === "error" ? " toast-error" : type === "success" ? " toast-success" : "");
    toast.textContent = message;
    els.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.classList.add("is-leaving");
      setTimeout(() => toast.remove(), 240);
    }, 3500);
  }

  function prefersReducedMotion() {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function readPref(key, fallback) {
    try {
      return window.localStorage?.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function writePref(key, value) {
    try {
      window.localStorage?.setItem(key, value);
    } catch {}
  }

  // 读数变化时短暂点亮（首次渲染不闪）
  function setReading(el, text) {
    const next = String(text);
    if (el.textContent === next) return;
    el.textContent = next;
    if (!state.hasRendered || prefersReducedMotion()) return;
    el.classList.remove("is-changed");
    void el.offsetWidth;
    el.classList.add("is-changed");
    setTimeout(() => el.classList.remove("is-changed"), 1500);
  }

  function spinIcon(button) {
    const icon = button.querySelector(".lucide-icon");
    if (!icon || prefersReducedMotion()) return;
    icon.classList.remove("is-spinning");
    icon.getBoundingClientRect();
    icon.classList.add("is-spinning");
    setTimeout(() => icon.classList.remove("is-spinning"), 700);
  }

  function formatNumber(num) {
    if (num === null || num === undefined) return "0";
    return Number(num).toLocaleString("en-US");
  }

  function formatUsd(amount) {
    if (amount === null || amount === undefined) return "-";
    const val = Number(amount) || 0;
    return "$" + val.toFixed(6);
  }

  // 费用单元格：主位显示原价；展开后查看倍率后的金额与计费过程。
  const PRICE_FIELDS = [["input", "输入"], ["output", "输出"], ["cacheRead", "缓存读"], ["cacheWrite", "缓存写"]];
  const TOKEN_FIELDS = { input: "inputTokens", output: "outputTokens", cacheRead: "cacheReadTokens", cacheWrite: "cacheWriteTokens" };
  function multiplierText(m) {
    return PRICE_FIELDS.map(([k, label]) => `${label}×${m?.[k] ?? 1}`).join("  ");
  }
  const formatRatio = (r) => "×" + Number(r.toFixed(Math.abs(r - 1) < 0.01 ? 4 : r >= 10 ? 1 : 2));
  function formatDiff(cost, base) {
    const diff = Number(cost) - Number(base);
    const pct = Number(base) > 0 ? ` (${diff >= 0 ? "+" : ""}${(diff / Number(base) * 100).toFixed(1)}%)` : "";
    return `${diff >= 0 ? "+" : "-"}${formatUsd(Math.abs(diff))}${pct}`;
  }
  function costLine(parent, label, value, className = "") {
    const line = document.createElement("div");
    line.className = "cost-line " + className;
    const l = document.createElement("span");
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "num-font";
    v.textContent = value;
    line.appendChild(l);
    line.appendChild(v);
    parent.appendChild(line);
  }
  // item 仅在单条请求里传入：有 unitPrice 时逐项列出 tokens × 单价 × 倍率
  // openKey：同一金额在每次重绘中保持不变的标识，用来恢复展开状态
  function setCost(parent, cost, base, multiplier, item, openKey) {
    const hasBase = cost != null && base != null && Math.abs(Number(base) - Number(cost)) > 1e-12;
    const unitPrice = item?.unitPrice;
    if (cost == null || (!hasBase && !multiplier && !unitPrice)) {
      parent.textContent = formatUsd(base ?? cost);
      return;
    }
    const details = document.createElement("details");
    details.className = "cost-detail";
    if (openKey) {
      details.open = state.openCostKeys.has(openKey);
      details.addEventListener("toggle", () => {
        if (details.open) state.openCostKeys.add(openKey);
        else state.openCostKeys.delete(openKey);
      });
    }
    const summary = document.createElement("summary");
    const amount = document.createElement("span");
    amount.textContent = formatUsd(base ?? cost);
    summary.appendChild(amount);
    if (hasBase && Number(base) > 0) {
      const ratio = Number(cost) / Number(base);
      const badge = document.createElement("span");
      badge.className = "cost-ratio " + (ratio > 1 ? "is-up" : "is-down");
      badge.textContent = formatRatio(ratio);
      badge.title = `倍率后 ${formatUsd(cost)}`;
      summary.appendChild(badge);
    }
    details.appendChild(summary);
    const body = document.createElement("div");
    body.className = "cost-detail-body";
    if (unitPrice) {
      PRICE_FIELDS.forEach(([k, label]) => {
        const tokens = Number(item[TOKEN_FIELDS[k]]) || 0;
        if (!tokens) return;
        const m = Number(multiplier?.[k] ?? 1);
        const price = Number(unitPrice[k]) || 0;
        const rate = m === 1 ? "" : ` × ${m}`;
        costLine(body, `${label} ${formatNumber(tokens)} × $${price}/M${rate}`, formatUsd(tokens * price * m / 1e6));
      });
    } else if (multiplier) {
      costLine(body, "倍率", multiplierText(multiplier));
    }
    if (base != null) costLine(body, "原价", formatUsd(base), "is-total");
    costLine(body, hasBase ? "倍率后" : "合计", formatUsd(cost), "is-total");
    if (hasBase) costLine(body, "差额", formatDiff(cost, base), Number(cost) > Number(base) ? "is-up" : "is-down");
    details.appendChild(body);
    parent.appendChild(details);
  }

  // 交换台线路上的简写金额，完整金额见用量分析
  function formatUsdShort(amount) {
    const value = Number(amount) || 0;
    if (value === 0) return "$0";
    if (value < 0.0001) return "<$0.0001";
    const digits = value >= 100 ? 0 : value >= 1 ? 2 : value >= 0.01 ? 3 : 4;
    return "$" + value.toFixed(digits);
  }

  function formatDuration(ms) {
    const value = Math.max(0, Number(ms) || 0);
    if (value < 1000) return Math.round(value) + "ms";
    if (value < 60000) return (value / 1000).toFixed(1) + "s";
    return Math.floor(value / 60000) + "m" + Math.floor((value % 60000) / 1000) + "s";
  }

  function formatTokens(count) {
    const value = Number(count) || 0;
    const units = [["B", 1e9], ["M", 1e6], ["K", 1e3]];
    for (let index = 0; index < units.length; index++) {
      const [unit, divisor] = units[index];
      if (value < divisor) continue;
      const rounded = Number((value / divisor).toFixed(2));
      if (rounded >= 1000 && index > 0) {
        return Number((value / units[index - 1][1]).toFixed(2)) + units[index - 1][0];
      }
      return rounded + unit;
    }
    return formatNumber(value);
  }

  function formatCacheHitRate(usage) {
    const input = Math.max(0, Number(usage.input) || 0);
    const read = Math.max(0, Number(usage.cacheRead) || 0);
    const write = Math.max(0, Number(usage.cacheWrite) || 0);
    const context = input + read + write;
    return context > 0 ? (read / context * 100).toFixed(1) + "%" : "—";
  }

  function formatTime(isoStr) {
    if (!isoStr) return "-";
    try {
      const d = new Date(isoStr);
      return d.toLocaleTimeString("zh-CN", { hour12: false });
    } catch {
      return isoStr;
    }
  }

  function formatUptime(seconds) {
    if (!seconds || seconds < 0) return "0s";
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor((seconds / 3600) % 24);
    const d = Math.floor(seconds / 86400);
    if (d > 0) return `${d}天 ${h}时 ${m}分`;
    if (h > 0) return `${h}时 ${m}分 ${s}秒`;
    if (m > 0) return `${m}分 ${s}秒`;
    return `${s}秒`;
  }

  // --- API 客户端封装 ---
  let reauthPromise = null;

  async function refreshLocalSession() {
    if (!reauthPromise) {
      reauthPromise = (async () => {
        try {
          const res = await fetch("/api/session", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: "{}"
          });
          return Boolean(res?.ok);
        } catch {
          return false;
        } finally {
          reauthPromise = null;
        }
      })();
    }
    return reauthPromise;
  }

  async function apiFetch(endpoint, options = {}) {
    const opts = {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      },
      ...options
    };

    let res = await fetch(endpoint, opts);
    if (res.status === 401) {
      const recovered = await refreshLocalSession();
      if (recovered) {
        els.authExpiredBanner?.classList.add("hidden");
        res = await fetch(endpoint, opts);
      }
    }
    if (res.status === 401) {
      markAuthRequired();
      throw new Error("401 Unauthorized");
    }
    if (res.ok) {
      els.authExpiredBanner?.classList.add("hidden");
    }
    return res;
  }

  function markAuthRequired() {
    state.isGatewayOnline = false;
    els.statusBadge.className = "badge badge-warning";
    els.statusBadge.title = "管理页面需要登录";
    els.statusBadge.querySelector(".badge-text").textContent = "需要登录";
    els.metaPid.textContent = "-";
    els.metaUptime.textContent = "-";
    els.metaActive.textContent = "-";
    els.metaBaseUrl.textContent = "-";
    els.sbCoreLamp.className = "sb-lamp";
    els.sbCoreState.textContent = "登录后显示线路状态";
    els.authExpiredBanner.classList.remove("hidden");
    finishBooting();
  }

  function finishBooting() {
    document.body?.classList.remove("is-booting");
  }

  // --- 主题、侧栏与导航指示条 ---
  const THEME_ORDER = ["system", "light", "dark"];
  const THEME_LABELS = { system: "跟随系统", light: "浅色", dark: "深色" };
  const THEME_ICONS = { system: "#icon-monitor", light: "#icon-sun", dark: "#icon-moon" };

  function applyTheme(preference) {
    state.theme = THEME_ORDER.includes(preference) ? preference : "system";
    const prefersDark = typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
    const resolved = state.theme === "system" ? (prefersDark ? "dark" : "light") : state.theme;
    document.documentElement?.setAttribute("data-theme", resolved);
    els.themeText.textContent = THEME_LABELS[state.theme];
    els.iconTheme.setAttribute("href", THEME_ICONS[state.theme]);
    const nextLabel = THEME_LABELS[THEME_ORDER[(THEME_ORDER.indexOf(state.theme) + 1) % THEME_ORDER.length]];
    els.btnTheme.title = `界面主题：${THEME_LABELS[state.theme]}，点击切换为${nextLabel}`;
    els.btnTheme.setAttribute("aria-label", els.btnTheme.title);
    if (state.activeView === "overview") drawTrendChart();
  }

  function applySidebarCollapsed(collapsed) {
    document.body?.classList.toggle("sidebar-collapsed", collapsed);
    const label = collapsed ? "展开侧栏" : "收起侧栏";
    els.btnCollapseSidebar.title = label;
    els.btnCollapseSidebar.setAttribute("aria-label", label);
    els.btnCollapseSidebar.setAttribute("aria-expanded", String(!collapsed));
    positionNavIndicator();
  }

  function positionNavIndicator() {
    const active = Array.from(els.navTabs).find((tab) => tab.classList.contains("active"));
    if (!active || !Number.isFinite(active.offsetTop) || !active.offsetHeight) return;
    els.navIndicator.style.height = active.offsetHeight + "px";
    els.navIndicator.style.transform = `translateY(${active.offsetTop}px)`;
    els.navIndicator.classList.add("is-ready");
  }

  // --- 认证初始化 ---
  async function initAuth() {
    const hash = window.location.hash;
    const match = hash.match(/#token=([a-f0-9]+)/i);
    if (match) {
      try {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch {}
    }
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      if (!res.ok) markAuthRequired();
    } catch {
      markAuthRequired();
    }
  }

  // --- 导航与视图切换逻辑 ---
  function isSettingsDirty() {
    if (!state.settings.draft) return false;
    // 以 _ 开头的是界面状态（展开/收起等），不算配置修改
    const persistedFields = (key, value) => key.startsWith("_") ? undefined : value;
    return JSON.stringify(state.settings.draft, persistedFields) !==
      JSON.stringify(JSON.parse(state.settings.initialDraftJson), persistedFields);
  }

  function switchView(targetView) {
    if (state.activeView === targetView) return;
    if (state.activeView === "subagents" && !window.Subagents?.leave()) return;

    if (state.activeView === "settings" && state.settings.isEditing && isSettingsDirty()) {
      state.pendingView = targetView;
      els.unsavedMessage.textContent = "基础设置中有尚未保存的修改，切换视图将放弃这些修改。确定放弃并离开吗？";
      els.btnUnsavedDiscard.textContent = "放弃更改并离开";
      els.modalUnsaved.classList.remove("hidden");
      return;
    }

    applySwitchView(targetView);
  }

  function applySwitchView(targetView) {
    if (state.activeView === "settings" && targetView !== "settings") {
      state.settings.isEditing = false;
      state.settings.draft = JSON.parse(state.settings.initialDraftJson || "null");
      renderSettingsMode();
    }
    state.activeView = targetView;
    const viewLabels = {
      overview: ["运行概览", "请求与消耗实时概况"],
      usage: ["用量分析", "按提供商、模型与请求查看消耗"],
      logs: ["请求日志", "网关输出与错误追踪"],
      settings: ["基础设置", "提供商与路由配置"],
      subagents: ["子代理编排", "配置 Claude Code 与 Codex 的委托代理角色与模型路由"]
    };
    [els.currentViewTitle.textContent, els.currentViewDescription.textContent] = viewLabels[targetView];
    els.navTabs.forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.view === targetView);
      if (tab.dataset.view === targetView) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });
    positionNavIndicator();

    els.overviewFilters.classList.toggle("hidden", targetView !== "overview" && targetView !== "usage");
    els.viewOverview.classList.toggle("hidden", targetView !== "overview");
    els.viewUsage.classList.toggle("hidden", targetView !== "usage");
    els.viewLogs.classList.toggle("hidden", targetView !== "logs");
    els.viewSettings.classList.toggle("hidden", targetView !== "settings");
    if (els.viewSubagents) els.viewSubagents.classList.toggle("hidden", targetView !== "subagents");

    // 停止/启动对应轮询
    stopPolling();
    if (targetView === "overview" || targetView === "usage") {
      if (targetView === "overview") {
        state.trendNeedsReveal = true;
        drawTrendChart();
        drawSwitchboardWires(true);
      }
      fetchOverview();
      startOverviewPolling();
    } else if (targetView === "logs") {
      fetchLogs();
      startLogsPolling();
    } else if (targetView === "settings") {
      fetchSettings();
    } else if (targetView === "subagents") {
      window.Subagents?.show();
    }
  }

  function clearLiveTopology() {
    state.liveTopologyHeld = [];
    state.liveTopologyHoldUntil = 0;
  }

  function getSnapshotTime(snapshot) {
    if (!snapshot) return 0;
    const raw = snapshot.sampledAt || snapshot.generatedAt;
    const t = raw ? Date.parse(raw) : 0;
    return Number.isFinite(t) ? t : 0;
  }

  function retainedFromSnapshot(data, online) {
    if (online === false || !Array.isArray(data.switchboardRetained)) return [];
    const sampledAt = getSnapshotTime(data);
    return data.switchboardRetained.filter((item) => {
      const finishedAt = Date.parse(item?.finishedAt);
      return Number.isFinite(finishedAt) && (!sampledAt || sampledAt - finishedAt <= 300000);
    });
  }

  // Both polling endpoints share one authoritative live sample and topology lease.
  function acceptLiveSnapshot(data, filter) {
    const previous = state.liveSnapshot;
    if (previous && previous.filter === filter && getSnapshotTime(data) < getSnapshotTime(previous)) {
      return previous;
    }
    const instanceId = data.instanceId ?? data.gateway?.instanceId;
    if ((previous && previous.filter !== filter) ||
        (instanceId && state.liveInstanceId && instanceId !== state.liveInstanceId)) {
      clearLiveTopology();
      state.inflightDisplay.clear();
    }
    if (instanceId) state.liveInstanceId = instanceId;
    const online = data.online ?? data.gateway?.online;
    const inflight = online === false ? [] : Array.isArray(data.switchboardActive) ? data.switchboardActive
      : (Array.isArray(data.inflight) ? data.inflight : []);
    const retained = retainedFromSnapshot(data, online);
    const now = Date.now();
    if (online === false) clearLiveTopology();
    else if (inflight.length) {
      state.liveTopologyHeld = inflight;
      state.liveTopologyHoldUntil = now + 5000;
    } else if (now >= state.liveTopologyHoldUntil) clearLiveTopology();
    const topology = inflight.length ? inflight : state.liveTopologyHeld;
    state.liveSnapshot = {
      sampledAt: data.sampledAt, generatedAt: data.generatedAt, instanceId, filter, online,
      activeRequests: data.activeRequests ?? data.gateway?.activeRequests ?? inflight.length,
      switchboardActiveRequests: data.switchboardActiveRequests ?? inflight.length,
      inflight, switchboardActive: inflight, switchboardTopology: topology,
      switchboardRetained: retained,
      switchboardConfigured: data.switchboardConfigured || [], liveUnknown: Boolean(data.liveUnknown),
    };
    return state.liveSnapshot;
  }

  function stopPolling() {
    stopSwitchboardFlow();
    state.liveEpoch++;
    if (state.liveTimer) clearInterval(state.liveTimer);
    state.liveTimer = null;
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    if (state.logs.pollTimer) {
      clearInterval(state.logs.pollTimer);
      state.logs.pollTimer = null;
    }
  }

  function startOverviewPolling() {
    stopPolling();
    state.pollTimer = setInterval(() => {
      if (state.activeView !== "overview" && state.activeView !== "usage") return;
      // 手动暂停、页面不可见、正在选中文字时跳过本轮，避免重绘打断查看
      if (!state.autoRefresh || document.hidden || hasTextSelection()) return;
      fetchOverview();
    }, 5000);
    state.liveTimer = setInterval(fetchSwitchboardLive, 1000);
  }

  async function fetchSwitchboardLive() {
    if (state.liveBusy || state.activeView !== "overview" || !state.autoRefresh || document.hidden) return;
    const epoch = state.liveEpoch;
    const filter = state.providerFilter;
    state.liveBusy = true;
    try {
      const res = await apiFetch("/api/switchboard/live?" + new URLSearchParams({ provider: filter }));
      if (!res.ok) throw new Error("Live status unavailable");
      const data = await res.json();
      if (epoch !== state.liveEpoch || filter !== state.providerFilter || !state.autoRefresh || document.hidden) return;
      const live = acceptLiveSnapshot(data, filter);
      renderSwitchboard({ ...(state.overviewData || {}), ...live });
      renderInflight(live.inflight);
      state.activeRequestsCount = live.activeRequests;
      state.switchboardActiveCount = live.switchboardActiveRequests;
      renderSwitchboardCore(live.online, { baseUrl: state.overviewData?.gateway?.baseUrl }, live.liveUnknown);
      updateRestartButtonState();
    } catch (error) {
      if (error.message === "401 Unauthorized") return;
      if (epoch === state.liveEpoch && filter === state.providerFilter && state.autoRefresh && !document.hidden) {
        // 404 或网络抖动时平滑降级，仅标记未知，不复活已完成请求
        const previous = state.liveSnapshot?.filter === filter ? state.liveSnapshot : null;
        const topology = previous?.inflight?.length ? previous.inflight
          : Date.now() < state.liveTopologyHoldUntil ? state.liveTopologyHeld : [];
        state.liveSnapshot = { ...previous, filter, switchboardTopology: topology, liveUnknown: true };
        renderSwitchboard({ ...(state.overviewData || {}), ...state.liveSnapshot, liveUnknown: true });
        renderInflight(state.switchboard.active || []);
        renderSwitchboardCore(false, { baseUrl: state.overviewData?.gateway?.baseUrl }, true);
        els.sbCoreState.textContent = "实时状态不可用";
      }
    } finally { state.liveBusy = false; }
  }

  function hasTextSelection() {
    const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
    return !!selection && !selection.isCollapsed && String(selection).trim() !== "";
  }

  function applyAutoRefresh(enabled) {
    state.liveEpoch++;
    state.autoRefresh = enabled;
    const label = enabled ? "暂停自动刷新" : "恢复自动刷新（每 5 秒）";
    els.btnAutoRefresh.setAttribute("aria-pressed", String(enabled));
    els.btnAutoRefresh.title = label;
    els.btnAutoRefresh.setAttribute("aria-label", label);
    els.btnAutoRefresh.classList.toggle("is-paused", !enabled);
    els.iconAutoRefresh.setAttribute("href", enabled ? "#icon-pause" : "#icon-play");
    els.autoRefreshState.textContent = enabled ? "" : "已暂停自动刷新";
  }

  function startLogsPolling() {
    stopPolling();
    if (!state.logs.follow) return;
    state.logs.pollTimer = setInterval(() => {
      if (state.activeView === "logs") {
        fetchLogs();
      }
    }, 3000);
  }

  // 页面离开前防丢失守卫
  window.addEventListener("beforeunload", (e) => {
    if (state.activeView === "settings" && state.settings.isEditing && isSettingsDirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // --- 视图 1: 运行概览 ---
  async function fetchOverview() {
    const currentSeq = ++state.overviewReqSeq;
    try {
      const p = new URLSearchParams({ period: state.range.period });
      if (state.range.period === "custom") {
        p.set("since", String(state.range.since));
        p.set("until", String(state.range.until));
      }
      if (state.trendStep !== "auto") p.set("step", state.trendStep);
      if (state.providerFilter) p.set("provider", state.providerFilter);

      const res = await apiFetch("/api/overview?" + p.toString());
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || ("HTTP " + res.status));
      }
      const data = await res.json();
      if (currentSeq !== state.overviewReqSeq) return;
      const live = acceptLiveSnapshot(data, state.providerFilter);
      data.switchboardActive = live.switchboardActive;
      data.switchboardActiveRequests = live.switchboardActiveRequests;
      data.switchboardTopology = live.switchboardTopology;
      data.switchboardRetained = live.switchboardRetained;
      data.switchboardConfigured = live.switchboardConfigured;
      data.inflight = live.inflight;
      data.liveUnknown = live.liveUnknown;
      data.gateway = { ...data.gateway, online: live.online, activeRequests: live.activeRequests };
      state.overviewData = data;
      if (els.overviewErrorBanner) els.overviewErrorBanner.classList.add("hidden");
      renderOverview(data);
    } catch (err) {
      if (currentSeq !== state.overviewReqSeq) return;
      if (err.message !== "401 Unauthorized") {
        updateGatewayStatus(false);
        if (els.overviewErrorBanner && els.overviewErrorMsg) {
          els.overviewErrorMsg.textContent = "概览加载失败: " + err.message;
          els.overviewErrorBanner.classList.remove("hidden");
        }
      }
    } finally {
      if (currentSeq === state.overviewReqSeq) finishBooting();
    }
  }

  function updateRestartButtonState() {
    const busy = state.activeRequestsCount > 0;
    const disabled = busy || state.isRestarting;
    els.btnOpenRestart.disabled = disabled;
    els.btnConfirmRestart.disabled = disabled;
    const title = busy
      ? `还有 ${state.activeRequestsCount} 个在途请求，完成后才能重启`
      : state.isRestarting ? "网关正在重启" : "重启本地网关服务";
    els.btnOpenRestart.title = title;
    els.btnConfirmRestart.title = title;
  }

  function updateGatewayStatus(online, gwMeta = {}) {
    state.isGatewayOnline = !!online;
    state.activeRequestsCount = Number(gwMeta.activeRequests) || 0;
    if (online) {
      els.statusBadge.className = "badge badge-online";
      els.statusBadge.querySelector(".badge-text").textContent = "网关运行中";
      els.metaPid.textContent = gwMeta.pid || "-";
      els.metaUptime.textContent = formatUptime(gwMeta.uptimeSec);
      els.metaActive.textContent = gwMeta.activeRequests ?? "-";
      els.metaBaseUrl.textContent = gwMeta.baseUrl || "-";
    } else {
      els.statusBadge.className = "badge badge-offline";
      els.statusBadge.querySelector(".badge-text").textContent = "网关已离线";
      els.metaPid.textContent = "-";
      els.metaUptime.textContent = "-";
      els.metaActive.textContent = "-";
      els.metaBaseUrl.textContent = "-";
    }
    renderSwitchboardCore(!!online, gwMeta);
    updateRestartButtonState();
  }

  // --- 交换台：Agent 请求源 → 线路交换台（统一入口 + 协议适配器）→ 上游线路 ---
  const SVG_NS = "http://www.w3.org/2000/svg";
  const SB_KNOWN_AGENTS = ["claudecode", "codex", "deepseek-harness"];
  const SB_AGENT_NAMES = { claudecode: "Claude Code", codex: "Codex", "deepseek-harness": "DeepSeek Harness", deepseek: "DeepSeek", gemini: "Gemini", unknown: "未识别 Agent" };
  const SB_PROTOCOL_LABELS = { messages: "Messages", responses: "Responses", "chat-completions": "Chat Completions" };
  const SB_ENDPOINTS = { messages: "/v1/messages", responses: "/v1/responses" };
  // 每个入口协议适配器能做的转换，与 server.js 选择上游协议的分支一致；配置中出现的其它组合会追加显示
  const SB_CONVERSIONS = {
    messages: ["messages", "responses", "chat-completions"],
    responses: ["responses", "messages", "chat-completions"]
  };
  // 流动虚线：每个 Agent 占一格，多个 Agent 共用一条线时各色交替出现
  const SB_FLOW_DASH = 10;
  const SB_FLOW_STEP = 48;
  const SB_FLOW_SPEED = 240;

  function renderSwitchboardCore(online, gwMeta = {}, unknown = false) {
    const active = state.switchboardActiveCount;
    setReading(els.sbActive, unknown ? "?" : online ? formatNumber(active) : "—");
    els.sbActive.classList.toggle("is-live", !unknown && online && active > 0);
    els.sbCoreLamp.className = "sb-lamp " + (unknown ? "" : !online ? "is-fault" : active > 0 ? "is-live" : "is-on");
    els.sbCoreState.textContent = unknown ? "实时状态不可用"
      : !online ? "网关离线，请求无法转发"
      : active > 0 ? "在线，正在转发" : "在线，等待请求";
    els.sbBaseUrl.textContent = gwMeta.baseUrl || "-";
    els.switchboard.classList.toggle("is-offline", !unknown && !online);
    els.switchboard.classList.toggle("is-live", !unknown && online && active > 0);
  }

  function switchboardAgentLabel(value) {
    const labels = { "claude-code": "claudecode", codex: "codex", unknown: "unknown", "deepseek-harness": "deepseek-harness", deepseek: "deepseek", gemini: "gemini" };
    return labels[value] || value || "unknown";
  }
  function switchboardAgentColor(agent) {
    return ({ claudecode: "var(--agent-claude)", codex: "var(--agent-codex)", "deepseek-harness": "var(--agent-dsh)", deepseek: "var(--agent-deepseek)", gemini: "var(--agent-gemini)" })[agent] || "var(--agent-other)";
  }
  // Agent 标识图标（24×24 描边路径）；未知 Agent 用名称首字母
  const SB_AGENT_ICONS = {
    codex: ["M8.4 3.8 4.8 5.9v4.2L2 11.8v4.3l3.7 2.1 2.7-1.6 3.6 2.1 3.6-2.1 2.7 1.6 3.7-2.1v-4.3l-2.8-1.7V5.9l-3.6-2.1L12 5.9 8.4 3.8Z", "m8.4 8 3.6 2.1L15.6 8M12 10.1v4.2m-6.3-4.2 2.7 1.7v4.8m7.2-4.8 2.7-1.7v4.8"],
    claudecode: ["m7.3 5.6 3.1 6.4-3.1 6.4M16.7 5.6 13.6 12l3.1 6.4M5 12h14"],
    "deepseek-harness": ["M4 6h7a5 5 0 0 1 0 10H4V6Zm4 3v4m7-7h5l-3 4 3 4h-5"],
    deepseek: ["M4 6h7a5 5 0 0 1 0 10H4V6Zm4 3v4m7-7h5l-3 4 3 4h-5"]
  };
  function switchboardInitials(value) {
    const parts = String(value || "?").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const text = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || "?").slice(0, 2);
    return text.toUpperCase();
  }
  function createAgentMark(agent) {
    const mark = document.createElement("span");
    mark.className = "sb-agent-mark";
    mark.setAttribute("aria-hidden", "true");
    const paths = SB_AGENT_ICONS[agent];
    if (paths && typeof document.createElementNS === "function") {
      const svg = svgNode("svg", { viewBox: "0 0 24 24", focusable: "false" });
      paths.forEach((d) => svg.appendChild(svgNode("path", { d })));
      mark.appendChild(svg);
    } else {
      mark.textContent = switchboardInitials(agent);
    }
    return mark;
  }

  function renderSwitchboard(data) {
    state.switchboard.liveUnknown = Boolean(data.liveUnknown);
    state.switchboard.active = Array.isArray(data.switchboardActive) ? data.switchboardActive : (Array.isArray(data.inflight) ? data.inflight : []);
    state.switchboard.topology = Array.isArray(data.switchboardTopology) ? data.switchboardTopology : state.switchboard.active;
    state.switchboard.retained = Array.isArray(data.switchboardRetained) ? data.switchboardRetained : [];
    state.switchboard.configured = Array.isArray(data.switchboardConfigured) ? data.switchboardConfigured : [];
    syncSwitchboardFlowRequests();
    const source = Array.isArray(data.switchboard) ? data.switchboard.map((row) => ({ ...row })) : null;
    const routeKey = (entry) => JSON.stringify([entry.clientType || "unknown", entry.provider, entry.model, entry.route || "", entry.inputProtocol || null, entry.upstreamProtocol || null, entry.adapter || null]);
    if (source) {
      const keys = new Set(source.map(routeKey));
      const visibleTopology = [...state.switchboard.topology, ...state.switchboard.retained];
      visibleTopology.forEach((entry) => {
        if (!keys.has(routeKey(entry))) { source.push({ ...entry, requests: 0 }); keys.add(routeKey(entry)); }
      });
    }
    if (source) {
      const totalRequests = source.reduce((sum, item) => sum + (Number(item.requests) || 0), 0);
      state.switchboard.lines = source.map((item) => {
        const rawClientType = String(item.clientType || "unknown");
        const clientType = switchboardAgentLabel(rawClientType);
        const provider = String(item.provider || "unknown");
        const model = String(item.model || "unknown");
        const requests = Number(item.requests) || 0;
        return {
          name: model,
          clientType,
          provider,
          model,
          route: String(item.route || ""),
          inputProtocol: item.inputProtocol || null,
          upstreamProtocol: item.upstreamProtocol || null,
          adapter: item.adapter || null,
          cacheHitRate: item.cacheHitRate,
          successRate: item.successRate,
          // 原始计数用于把同一模型的多条线路合并成准确的比率
          cacheRead: item.cacheRead,
          cacheInput: item.cacheInput,
          successes: item.successes,
          cancelled: item.cancelled,
          requests,
          errors: Number(item.errors) || 0,
          costUsd: item.costUsd,
          baseCostUsd: item.baseCostUsd,
          live: state.switchboard.active.filter((entry) => routeKey(entry) === routeKey(item)).length,
          waiting: state.switchboard.topology.some((entry) => routeKey(entry) === routeKey(item)) && state.switchboard.active.every((entry) => routeKey(entry) !== routeKey(item)),
          retained: state.switchboard.retained.some((entry) => routeKey(entry) === routeKey(item))
            && state.switchboard.topology.every((entry) => routeKey(entry) !== routeKey(item))
            && state.switchboard.active.every((entry) => routeKey(entry) !== routeKey(item)),
          avgDurationMs: item.avgDurationMs == null ? null : Number(item.avgDurationMs),
          share: totalRequests ? requests / totalRequests : 0
        };
      });
    } else {
      // 兼容旧版管理接口和没有 agent 字段的测试/缓存数据。
      const liveByProvider = new Map();
      (Array.isArray(data.inflight) ? data.inflight : []).forEach((item) => {
        const name = String(item.provider ?? "");
        liveByProvider.set(name, (liveByProvider.get(name) || 0) + 1);
      });
      const providers = Array.isArray(data.providers) ? data.providers : [];
      const totalRequests = providers.reduce((sum, item) => sum + (Number(item.requests) || 0), 0);
      state.switchboard.lines = providers.map((item) => {
        const name = String(item.name ?? "");
        const requests = Number(item.requests) || 0;
        return { name, clientType: "unknown", provider: name, model: "", requests, errors: Number(item.errors) || 0, costUsd: item.costUsd, baseCostUsd: item.baseCostUsd, live: liveByProvider.get(name) || 0, avgDurationMs: null, share: totalRequests ? requests / totalRequests : 0 };
      });
    }

    // Active requests must remain visible ahead of older, high-volume traffic.
    state.switchboard.lines.sort((a, b) => b.live - a.live || b.requests - a.requests);
    const agents = new Map();
    state.switchboard.lines.forEach((line) => {
      const key = line.clientType || "unknown";
      const current = agents.get(key) || { name: key, requests: 0, live: 0, errors: 0, routes: 0, topModel: "", topWeight: -1, durationMs: 0, timed: 0, protocols: new Set() };
      current.requests += line.requests;
      current.live += line.live;
      current.errors += line.errors;
      current.routes += 1;
      if (line.inputProtocol) current.protocols.add(line.inputProtocol);
      // 主力模型：进行中优先，其次历史请求最多
      const weight = line.live * 1e9 + line.requests;
      if (line.route && weight > current.topWeight) {
        current.topModel = line.route;
        current.topWeight = weight;
      }
      if (line.avgDurationMs != null && line.requests > 0) {
        current.durationMs += line.avgDurationMs * line.requests;
        current.timed += line.requests;
      }
      agents.set(key, current);
    });
    agents.forEach((agent) => { agent.avgDurationMs = agent.timed ? agent.durationMs / agent.timed : null; });
    if (state.switchboard.configured.length) {
      SB_KNOWN_AGENTS.forEach((name) => {
        if (!agents.has(name)) agents.set(name, { name, requests: 0, live: 0, errors: 0, routes: 0, avgDurationMs: null, protocols: new Set() });
      });
    }
    agents.forEach((agent) => {
      const routesOf = (match) => [...new Set(state.switchboard.lines.filter((line) => line.clientType === agent.name && match(line)).map((line) => line.route || "未知原始模型"))].join(" · ");
      agent.topModel = routesOf((line) => line.live > 0);
      // 刚结束、等待下一步的请求仍保留原始模型名，避免卡片在两步之间闪成“暂无请求”
      agent.waitingModel = routesOf((line) => line.waiting);
      agent.unknown = Boolean(data.liveUnknown);
    });
    // Agent 列表排序策略：优先保持稳定的拓扑顺序，避免每秒有在途请求波动时列表项上下翻滚闪烁
    state.switchboard.agents = [...agents.values()].sort((a, b) => {
      if (state.switchboard.configured.length) return a.name.localeCompare(b.name);
      return b.requests - a.requests || a.name.localeCompare(b.name);
    });
    if (!agents.has(state.switchboard.selectedAgent)) state.switchboard.selectedAgent = null;

    // 右侧按提供商归并：一张卡片列出该提供商被调用的模型，模型行上的圆点按发起的 Agent 着色
    const providers = new Map();
    const emptyProvider = (name) => ({ name, requests: 0, live: 0, waiting: false, retained: false, errors: 0, costUsd: null, baseCostUsd: null, durationMs: 0, timed: 0, routes: [], agents: [], protocols: new Set(), configuredProtocols: new Set() });
    state.switchboard.lines.forEach((line) => {
      const key = line.provider || "unknown";
      const current = providers.get(key) || emptyProvider(key);
      current.requests += line.requests;
      current.live += line.live;
      current.waiting ||= Boolean(line.waiting);
      current.retained ||= Boolean(line.retained);
      current.errors += line.errors;
      if (line.costUsd != null) current.costUsd = (current.costUsd || 0) + (Number(line.costUsd) || 0);
      if ((line.baseCostUsd ?? line.costUsd) != null) current.baseCostUsd = (current.baseCostUsd || 0) + (Number(line.baseCostUsd ?? line.costUsd) || 0);
      if (line.avgDurationMs != null && line.requests > 0) {
        current.durationMs += line.avgDurationMs * line.requests;
        current.timed += line.requests;
      }
      if (line.upstreamProtocol) current.protocols.add(line.upstreamProtocol);
      current.routes.push(line);
      if (!current.agents.includes(line.clientType)) current.agents.push(line.clientType);
      providers.set(key, current);
    });
    state.switchboard.configured.forEach((route) => {
      if (!providers.has(route.provider)) providers.set(route.provider, emptyProvider(route.provider));
      const row = providers.get(route.provider);
      if (route.upstreamProtocol) row.configuredProtocols.add(route.upstreamProtocol);
      if (!row.routes.some((r) => r.model === route.model)) row.routes.push({ model: route.model, clientType: 'unknown', requests: 0, live: 0, waiting: false, retained: false, route: route.route, inputProtocol: route.inputProtocol, upstreamProtocol: route.upstreamProtocol, adapter: route.adapter });
    });
    const providerTotal = [...providers.values()].reduce((sum, item) => sum + item.requests, 0);
    providers.forEach((provider) => {
      provider.avgDurationMs = provider.timed ? provider.durationMs / provider.timed : null;
      provider.share = providerTotal ? provider.requests / providerTotal : 0;
    });
    // 提供商线路列表排序策略：优先保持稳定的配置/名称顺序，避免 live 计数波动触发重排闪烁
    state.switchboard.providers = [...providers.values()].sort((a, b) => {
      if (state.switchboard.configured.length) return a.name.localeCompare(b.name);
      return b.requests - a.requests || a.name.localeCompare(b.name);
    });

    els.sbEmptyText.textContent = data.providers?.length ? "所选时段暂无请求" : "暂无上游线路";
    renderSwitchboardAgents();
    els.sbAgentCount.textContent = formatNumber(state.switchboard.agents.length);
    renderSwitchboardLines();
    renderSwitchboardAdapters(Boolean(data.liveUnknown));
    drawSwitchboardWires();
  }

  function switchboardAdapterKey(entry) {
    return JSON.stringify([entry.inputProtocol, entry.upstreamProtocol, entry.adapter]);
  }

  function switchboardProtocolLabel(protocol) {
    return SB_PROTOCOL_LABELS[protocol] || String(protocol || "?");
  }

  function createSwitchboardPort(direction) {
    const port = document.createElement("span");
    port.className = "sb-port sb-port-" + direction;
    port.setAttribute("aria-hidden", "true");
    return port;
  }

  // 接口圆点按正在流经的 Agent 着色；多个 Agent 同时经过时分色扇区
  function paintSwitchboardPort(port, agents) {
    const colors = agents.map(switchboardAgentColor);
    const fill = colors.length > 1
      ? "conic-gradient(" + colors.map((color, index) => color + " " + Math.round(index / colors.length * 360) + "deg " + Math.round((index + 1) / colors.length * 360) + "deg").join(", ") + ")"
      : colors[0] || "";
    port.style.setProperty("--port-fill", fill);
  }

  function setSwitchboardDots(row, host, agents) {
    const key = agents.join("|");
    if (row.agentKey === key) return;
    row.agentKey = key;
    host.replaceChildren(...agents.map((agent) => {
      const dot = document.createElement("i");
      dot.className = "sb-dot";
      dot.style.setProperty("--connection-color", switchboardAgentColor(agent));
      dot.title = agent;
      return dot;
    }));
  }

  // 按入口协议把转换路径归到各自的适配器：配置决定能走哪些转换，进行中 / 刚结束的请求决定哪些正在使用
  function switchboardAdapterGroups() {
    const sb = state.switchboard;
    const groups = new Map();
    const complete = (entry) => entry.inputProtocol && entry.upstreamProtocol && entry.adapter;
    const pathOf = (entry) => {
      const input = entry.inputProtocol;
      if (!groups.has(input)) groups.set(input, { key: input, paths: new Map(), active: [], agents: new Set() });
      const group = groups.get(input);
      const key = switchboardAdapterKey(entry);
      if (!group.paths.has(key)) group.paths.set(key, { key, inputProtocol: input, upstreamProtocol: entry.upstreamProtocol, adapter: entry.adapter, routes: new Set(), active: [], agents: new Set(), waiting: false, retained: false, configured: false });
      return group.paths.get(key);
    };
    Object.entries(SB_CONVERSIONS).forEach(([input, outputs]) => outputs.forEach((output) => {
      pathOf({ inputProtocol: input, upstreamProtocol: output, adapter: input === output ? "direct" : input + "-to-" + output });
    }));
    sb.configured.forEach((entry) => {
      if (complete(entry)) {
        const path = pathOf(entry);
        path.configured = true;
        path.routes.add((entry.route || "*") + " → " + entry.provider + " / " + (entry.model || "请求模型"));
      }
    });
    const use = (entry, stateName) => {
      if (!complete(entry)) return;
      const agent = switchboardAgentLabel(entry.clientType);
      const path = pathOf(entry);
      const group = groups.get(entry.inputProtocol);
      path.agents.add(agent);
      group.agents.add(agent);
      if (stateName === "live") {
        path.active.push(entry);
        group.active.push(entry);
      } else if (stateName === "waiting") path.waiting = true;
      else if (stateName === "retained") path.retained = true;
    };
    sb.retained.forEach((entry) => use(entry, "retained"));
    sb.topology.forEach((entry) => use(entry, "waiting"));
    sb.active.forEach((entry) => use(entry, "live"));
    const order = Object.keys(SB_CONVERSIONS);
    const rank = (key) => (order.includes(key) ? order.indexOf(key) : order.length);
    return [...groups.values()].sort((a, b) => rank(a.key) - rank(b.key) || String(a.key).localeCompare(String(b.key)));
  }

  function renderSwitchboardAdapters(unknown = false) {
    const host = els.sbAdapters;
    if (!host) return;
    const sb = state.switchboard;
    const groups = switchboardAdapterGroups();
    const visible = (path) => path.active.length || path.waiting || path.retained;
    const entries = groups.filter((group) => [...group.paths.values()].some((path) => visible(path) || (sb.showAllUpstreams && path.configured)));
    sb.adapterCache ||= new Map();
    const structure = JSON.stringify(entries.map((group) => [group.key, [...group.paths.keys()]]));
    if (sb.adapterStructure !== structure) {
      sb.adapterStructure = structure;
      sb.adapterRows = entries.map((group) => {
        const row = sb.adapterCache.get(group.key) || createSwitchboardAdapter(group.key);
        sb.adapterCache.set(group.key, row);
        const paths = [...group.paths.values()].map((path) => {
          if (!row.paths.has(path.key)) row.paths.set(path.key, createSwitchboardPath(path));
          return row.paths.get(path.key);
        });
        row.list.replaceChildren(...paths.map((path) => path.item));
        return row;
      });
      host.replaceChildren(...sb.adapterRows.map((row) => row.item));
    }
    sb.pathRows = new Map();
    entries.forEach((group, index) => {
      const row = sb.adapterRows[index];
      updateSwitchboardAdapter(row, group, unknown);
      group.paths.forEach((path) => sb.pathRows.set(path.key, row.paths.get(path.key)));
    });
    els.sbAdapterCount.textContent = formatNumber(entries.length);
    host.setAttribute("data-idle", unknown ? "实时状态不可用"
      : "暂无进行中的协议转换 · " + groups.map((group) => switchboardProtocolLabel(group.key)).join(" / ") + " 适配器待命");
  }

  function createSwitchboardAdapter(key) {
    const item = document.createElement("li");
    item.className = "sb-adapter";
    item.setAttribute("data-adapter-key", key);
    const card = document.createElement("div");
    card.className = "sb-adapter-card";
    const head = document.createElement("button");
    head.type = "button";
    head.className = "sb-adapter-head";
    head.setAttribute("aria-expanded", "false");
    const name = document.createElement("strong");
    name.className = "sb-adapter-name";
    name.textContent = switchboardProtocolLabel(key) + " 适配器";
    const endpoint = document.createElement("span");
    endpoint.className = "sb-adapter-endpoint num-font";
    endpoint.textContent = SB_ENDPOINTS[key] || "";
    const status = document.createElement("span");
    status.className = "sb-adapter-status";
    const chevron = document.createElement("span");
    chevron.className = "sb-adapter-chevron";
    chevron.setAttribute("aria-hidden", "true");
    head.append(name, endpoint, status, chevron);
    const list = document.createElement("ol");
    list.className = "sb-paths";
    card.append(head, list);
    const traffic = document.createElement("span");
    traffic.className = "sb-adapter-traffic";
    const clients = [...SB_KNOWN_AGENTS, "unknown"].map((agent) => {
      const marker = document.createElement("span");
      marker.className = "sb-adapter-client";
      marker.style.setProperty("--connection-color", switchboardAgentColor(agent));
      traffic.appendChild(marker);
      return { agent, marker };
    });
    item.append(card, traffic);
    // 展开 / 收起只影响显示：默认只露出正在使用的转换，展开后列出该适配器支持的全部转换
    head.addEventListener("click", () => {
      const open = state.switchboard.openAdapters;
      if (open.has(key)) open.delete(key);
      else open.add(key);
      renderSwitchboardAdapters(state.switchboard.liveUnknown);
      drawSwitchboardWires();
    });
    return { key, item, head, list, status, traffic, clients, paths: new Map() };
  }

  function updateSwitchboardAdapter(row, group, unknown) {
    const sb = state.switchboard;
    const open = sb.openAdapters.has(row.key);
    const muted = sb.selectedAgent && !group.agents.has(sb.selectedAgent);
    const paths = [...group.paths.values()];
    const waiting = paths.some((path) => path.waiting && !path.active.length);
    const retained = paths.some((path) => path.retained && !path.waiting && !path.active.length);
    const configuredOnly = paths.some((path) => path.configured) && !group.active.length && !waiting && !retained;
    const className = "sb-adapter" + (!unknown && group.active.length ? " is-live" : waiting ? " is-waiting" : retained ? " is-idle" : configuredOnly ? " is-configured-only" : "") + (open ? " is-open" : "") + (sb.showAllUpstreams ? " is-show-all" : "") + (muted ? " is-muted" : "");
    if (row.item.className !== className) row.item.className = className;
    row.head.setAttribute("aria-expanded", String(open));
    row.head.title = open ? "收起未使用的转换" : "展开全部 " + group.paths.size + " 种转换";
    const updateText = (element, value) => { if (element.textContent !== value) element.textContent = value; };
    updateText(row.status, unknown ? "实时状态不可用" : group.active.length ? group.active.length + " 个请求进行中" : waiting ? "等待下一步" : retained ? "没数据" : "未调用");
    let shown = 0;
    row.clients.forEach(({ agent, marker }) => {
      const count = group.active.filter((request) => {
        const client = switchboardAgentLabel(request.clientType);
        return agent === "unknown" ? !SB_KNOWN_AGENTS.includes(client) : client === agent;
      }).length;
      marker.hidden = count === 0;
      if (count) shown++;
      updateText(marker, (agent === "unknown" ? "其他" : agent) + " " + (unknown ? "?" : count));
      marker.title = agent + " · " + (unknown ? "状态未知" : count + " 个未结束请求");
    });
    row.traffic.hidden = shown === 0;
    group.paths.forEach((path) => updateSwitchboardPath(row.paths.get(path.key), path, unknown));
  }

  function createSwitchboardPath(path) {
    const item = document.createElement("li");
    item.className = "sb-path";
    item.setAttribute("data-path-key", path.key);
    const route = document.createElement("span");
    route.className = "sb-path-route num-font";
    const from = document.createElement("span");
    from.textContent = switchboardProtocolLabel(path.inputProtocol);
    const arrow = document.createElement("i");
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";
    const to = document.createElement("span");
    to.textContent = switchboardProtocolLabel(path.upstreamProtocol);
    route.append(from, arrow, to);
    const kind = document.createElement("span");
    kind.className = "sb-path-kind";
    kind.textContent = path.adapter === "direct" ? "直通" : "转换";
    const agents = document.createElement("span");
    agents.className = "sb-path-agents";
    const reading = document.createElement("span");
    reading.className = "sb-path-reading num-font";
    const inPort = createSwitchboardPort("in");
    const outPort = createSwitchboardPort("out");
    item.append(inPort, route, kind, agents, reading, outPort);
    return { key: path.key, item, inPort, outPort, agents, reading, agentKey: null };
  }

  function updateSwitchboardPath(row, path, unknown) {
    const focus = state.switchboard.selectedAgent;
    const live = !unknown && path.active.length > 0;
    const liveAgents = live ? [...new Set(path.active.map((request) => switchboardAgentLabel(request.clientType)))].sort() : [];
    const waiting = !live && path.waiting;
    const retained = !live && !waiting && path.retained;
    const muted = focus && (live || waiting || retained) && !path.agents.has(focus);
    row.item.className = "sb-path" + (live ? " is-live" : waiting ? " is-waiting" : retained ? " is-idle" : " is-configured-only") + (muted ? " is-muted" : "");
    setSwitchboardDots(row, row.agents, [...path.agents].sort());
    row.reading.textContent = unknown && (live || waiting) ? "?" : live ? formatNumber(path.active.length)
      : waiting ? "等待" : retained ? "没数据" : path.routes.size ? formatNumber(path.routes.size) + " 条路由" : "未配置";
    const routes = [...path.routes].sort();
    row.item.title = switchboardProtocolLabel(path.inputProtocol) + " → " + switchboardProtocolLabel(path.upstreamProtocol)
      + (path.adapter === "direct" ? "（直通）" : "（" + path.adapter + "）")
      + (path.agents.size ? "\n调用方：" + [...path.agents].sort().join("、") : "")
      + (routes.length ? "\n配置路由：\n" + routes.slice(0, 8).join("\n") + (routes.length > 8 ? "\n… 共 " + routes.length + " 条" : "") : "\n当前配置没有走这条转换的路由");
    paintSwitchboardPort(row.inPort, liveAgents);
    paintSwitchboardPort(row.outPort, liveAgents);
  }

  function renderSwitchboardAgents() {
    const sb = state.switchboard;
    els.sbAgents.classList.toggle("hidden", sb.agents.length === 0);
    const structure = JSON.stringify(sb.agents.map((agent) => agent.name));
    if (structure !== sb.agentStructure) {
      sb.agentStructure = structure;
      sb.agentRows = sb.agents.map(createSwitchboardAgent);
      els.sbAgents.replaceChildren(...sb.agentRows.map((row) => row.item));
    }
    sb.agents.forEach((agent, index) => {
      const row = sb.agentRows[index];
      const selected = sb.selectedAgent === agent.name;
      const muted = sb.selectedAgent && !selected;
      row.item.className = "sb-agent" + (!agent.unknown && agent.live > 0 ? " is-live" : "") + (agent.unknown ? " is-unknown" : "") + (selected ? " is-selected" : "") + (muted ? " is-muted" : "");
      row.button.setAttribute("aria-pressed", String(selected));
      const model = agent.unknown ? "" : agent.topModel || agent.waitingModel || "";
      row.model.textContent = agent.unknown ? "状态未知" : model || "暂无请求";
      row.model.className = "sb-agent-model num-font" + (!model ? " is-empty" : agent.topModel ? "" : " is-waiting");
      row.model.title = model ? (agent.topModel ? "正在请求的原始模型名：" : "刚结束、等待下一步：") + model : "";
      row.sub.textContent = [agent.name, ...[...(agent.protocols || [])].sort()].join(" · ");
      row.status.textContent = agent.unknown ? "UNKNOWN" : agent.live > 0 ? "ACTIVE" : "IDLE";
      row.count.textContent = formatNumber(agent.requests) + " 次" + (agent.avgDurationMs != null ? " · " + formatDuration(agent.avgDurationMs) : "");
      row.meta.textContent = formatNumber(agent.routes) + " 条上游 · " + (agent.unknown ? "状态未知" : agent.live ? formatNumber(agent.live) + " 进行中" : "当前空闲");
      if (agent.errors > 0) row.meta.textContent += " · " + formatNumber(agent.errors) + " 错误";
      paintSwitchboardPort(row.port, !agent.unknown && agent.live > 0 ? [agent.name] : []);
    });
  }

  function createSwitchboardAgent(agent) {
    const item = document.createElement("li");
    item.style.setProperty("--connection-color", switchboardAgentColor(agent.name));
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sb-agent-btn";
    button.setAttribute("data-agent", agent.name);
    button.title = "聚焦 " + agent.name + " 的链路";
    const head = document.createElement("span");
    head.className = "sb-agent-head";
    const name = document.createElement("strong");
    name.textContent = SB_AGENT_NAMES[agent.name] || agent.name;
    const sub = document.createElement("span");
    sub.className = "sb-agent-sub num-font";
    head.append(name, sub);
    const status = document.createElement("strong");
    status.className = "sb-agent-status num-font";
    const request = document.createElement("span");
    request.className = "sb-agent-request";
    const label = document.createElement("span");
    label.className = "sb-agent-label";
    label.textContent = "原始模型";
    const model = document.createElement("b");
    model.className = "sb-agent-model num-font";
    request.append(label, model);
    const stats = document.createElement("span");
    stats.className = "sb-agent-stats";
    const count = document.createElement("span");
    count.className = "sb-agent-count num-font";
    const meta = document.createElement("span");
    meta.className = "sb-agent-meta";
    stats.append(count, meta);
    const port = createSwitchboardPort("out");
    button.append(createAgentMark(agent.name), head, status, request, stats, port);
    item.appendChild(button);
    return { item, button, model, sub, status, count, meta, port };
  }

  function switchboardShareText(line) {
    if (!line.requests) return "0%";
    const percent = line.share * 100;
    return percent < 1 ? "<1%" : Math.round(percent) + "%";
  }

  function addSwitchboardRatio(target, numerator, denominator, rate, weight) {
    if (numerator != null && Number(denominator) > 0) {
      target[0] += Number(numerator) || 0;
      target[1] += Number(denominator);
    } else if (rate != null && weight > 0) {
      target[0] += Number(rate) * weight;
      target[1] += weight;
    }
  }

  // 同一提供商下按真实模型合并线路；called = 有进行中或刚结束、等待下一步的请求
  function switchboardProviderModels(provider) {
    const models = new Map();
    provider.routes.forEach((route) => {
      if (!route.model) return;
      if (!models.has(route.model)) {
        models.set(route.model, { key: JSON.stringify([provider.name, route.model]), model: route.model, routes: new Set(), agents: new Set(), calling: new Set(), retainedAgents: new Set(), liveAgents: new Set(), requests: 0, errors: 0, live: 0, called: false, retained: false, hit: [0, 0], ok: [0, 0] });
      }
      const model = models.get(route.model);
      const requests = Number(route.requests) || 0;
      const live = Number(route.live) || 0;
      const agent = route.clientType || "unknown";
      if (route.route) model.routes.add(route.route);
      if (requests || live || route.waiting || route.retained) model.agents.add(agent);
      if (live || route.waiting) {
        model.calling.add(agent);
        model.called = true;
      }
      if (route.retained && !live && !route.waiting) {
        model.retainedAgents.add(agent);
        model.retained = true;
      }
      if (live) model.liveAgents.add(agent);
      model.requests += requests;
      model.errors += Number(route.errors) || 0;
      model.live += live;
      addSwitchboardRatio(model.hit, route.cacheRead, route.cacheInput, route.cacheHitRate, requests);
      addSwitchboardRatio(model.ok, route.successes, requests - (Number(route.cancelled) || 0), route.successRate, requests);
    });
    const sorted = (set) => [...set].sort();
    return [...models.values()]
      .map((model) => ({ ...model, routes: sorted(model.routes), agents: sorted(model.agents), calling: sorted(model.calling), retainedAgents: sorted(model.retainedAgents), liveAgents: sorted(model.liveAgents) }))
      .sort((a, b) => a.model.localeCompare(b.model));
  }

  function renderSwitchboardLines() {
    const sb = state.switchboard;
    const hasLines = sb.providers.length > 0;
    els.sbEmpty.classList.toggle("hidden", hasLines);
    els.sbLines.classList.toggle("hidden", !hasLines);
    // 默认只保留正在被调用的模型；“显示全部”或按提供商筛选时列出该提供商的全部模型
    const cards = [];
    let hiddenAny = false;
    sb.providers.forEach((provider) => {
      const models = switchboardProviderModels(provider);
      const expanded = sb.showAllUpstreams || state.providerFilter === provider.name;
      const shown = expanded ? models : models.filter((model) => model.called || model.retained);
      if (shown.length < models.length) hiddenAny = true;
      if (shown.length || expanded || provider.live > 0) cards.push({ provider, models: shown });
      else hiddenAny = true;
    });
    if (!sb.showAllUpstreams && switchboardAdapterGroups().some((group) => [...group.paths.values()].some((path) => path.configured && !path.active.length && !path.waiting && !path.retained))) {
      hiddenAny = true;
    }
    // 卡片按提供商缓存复用，调用开始 / 结束时只增删卡片，不整棵重建
    sb.lineCache ||= new Map();
    const structure = JSON.stringify(cards.map(({ provider }) => provider.name));
    if (structure !== sb.lineStructure) {
      sb.lineStructure = structure;
      sb.rows = cards.map(({ provider }) => {
        const row = sb.lineCache.get(provider.name) || createSwitchboardLine(provider);
        sb.lineCache.set(provider.name, row);
        return row;
      });
      els.sbLines.replaceChildren(...sb.rows.map((row) => row.item));
    }
    sb.modelRows = new Map();
    const maxRequests = cards.reduce((max, card) => card.models.reduce((top, model) => Math.max(top, model.requests), max), 0);
    cards.forEach((card, index) => updateSwitchboardLine(sb.rows[index], card.provider, card.models, maxRequests));
    els.sbUpstreamCount.textContent = formatNumber(cards.reduce((sum, card) => sum + card.models.length, 0));
    els.sbLines.setAttribute("data-empty", "暂无正在调用的上游模型");
    const toggle = els.sbUpstreamToggle;
    toggle.hidden = !sb.showAllUpstreams && !hiddenAny;
    toggle.textContent = sb.showAllUpstreams ? "只看调用中" : "显示全部";
    toggle.setAttribute("aria-pressed", String(sb.showAllUpstreams));
    toggle.title = sb.showAllUpstreams ? "只显示最近调用的上游与转换路径" : "显示全部已配置的上游与转换路径";
  }

  function createSwitchboardLine(provider) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sb-line-btn";
    button.setAttribute("data-provider", provider.name);
    const logo = document.createElement("span");
    logo.className = "sb-line-logo num-font";
    logo.setAttribute("aria-hidden", "true");
    logo.textContent = switchboardInitials(provider.name);
    const body = document.createElement("span");
    body.className = "sb-line-body";
    const name = document.createElement("strong");
    name.className = "sb-line-provider";
    name.textContent = provider.name;
    const note = document.createElement("span");
    note.className = "sb-line-note";
    body.append(name, note);
    const calls = document.createElement("span");
    calls.className = "sb-line-calls";
    const head = document.createElement("span");
    head.className = "sb-line-calls-head";
    const count = document.createElement("strong");
    count.className = "num-font";
    const share = document.createElement("span");
    share.className = "sb-line-share num-font";
    head.append(count, share);
    const meta = document.createElement("span");
    meta.className = "sb-line-meta num-font";
    calls.append(head, meta);
    button.append(logo, body, calls);
    const models = document.createElement("ol");
    models.className = "sb-models";
    item.append(button, models);
    return { item, button, note, share, count, meta, models, modelRows: new Map(), modelStructure: null };
  }

  function updateSwitchboardLine(row, provider, models, maxRequests) {
    const sb = state.switchboard;
    const selectedAgent = sb.selectedAgent;
    const unknown = sb.liveUnknown;
    const live = unknown ? 0 : provider.live;
    const waiting = !unknown && !live && provider.waiting;
    const retained = !unknown && !live && !waiting && provider.retained;
    const related = !selectedAgent || provider.agents.includes(selectedAgent);
    const called = !unknown && (live > 0 || models.some((model) => model.called));
    row.item.className = "sb-line " + (unknown ? "is-unknown " : "") + (provider.requests > 0 ? "is-used" : "is-idle") + (live > 0 ? " is-live" : waiting ? " is-waiting" : retained ? " is-retained" : " is-configured-only") + (called ? " is-called" : "") + (selectedAgent && related ? " is-target" : "") + (related ? "" : " is-muted");
    const protocols = provider.protocols?.size ? provider.protocols : provider.configuredProtocols;
    row.note.textContent = [...(protocols || [])].map(switchboardProtocolLabel).join(" · ");
    setReading(row.share, switchboardShareText(provider));
    row.count.textContent = formatNumber(provider.requests) + " 次";
    const parts = [];
    if (provider.avgDurationMs != null) parts.push([formatDuration(provider.avgDurationMs), ""]);
    const rawCost = provider.baseCostUsd ?? provider.costUsd;
    if (provider.requests > 0 && rawCost != null) parts.push([formatUsdShort(rawCost), ""]);
    if (provider.errors > 0) parts.push([`${formatNumber(provider.errors)} 错误`, "sb-line-errors"]);
    if (unknown) parts.push(["状态未知", ""]);
    else if (live > 0) parts.push([`${formatNumber(live)} 进行中`, "sb-line-live"]);
    else if (waiting) parts.push(["等待下一步", ""]);
    else if (retained) parts.push(["没数据", ""]);
    if (!parts.length) parts.push(["未调用", ""]);
    row.meta.replaceChildren(...parts.map(([text, className]) => {
      const span = document.createElement("span");
      span.className = className;
      span.textContent = text;
      return span;
    }));
    const structure = JSON.stringify(models.map((model) => model.model));
    if (row.modelStructure !== structure) {
      row.modelStructure = structure;
      const items = models.map((model) => {
        if (!row.modelRows.has(model.model)) row.modelRows.set(model.model, createSwitchboardModel());
        return row.modelRows.get(model.model);
      });
      row.models.replaceChildren(...items.map((item) => item.item));
    }
    row.models.hidden = models.length === 0;
    models.forEach((model) => {
      const modelRow = row.modelRows.get(model.model);
      updateSwitchboardModel(modelRow, model, maxRequests);
      sb.modelRows.set(model.key, modelRow);
    });
    const focused = state.providerFilter === provider.name;
    row.button.setAttribute("aria-pressed", String(focused));
    row.button.title = focused ? "显示全部提供商" : `只看 ${provider.name} 的用量`;
  }

  function createSwitchboardModel() {
    const item = document.createElement("li");
    item.className = "sb-model";
    const head = document.createElement("span");
    head.className = "sb-model-head";
    const name = document.createElement("span");
    name.className = "sb-model-name num-font";
    const agents = document.createElement("span");
    agents.className = "sb-model-agents";
    const reading = document.createElement("span");
    reading.className = "sb-model-reading";
    head.append(name, agents, reading);
    const metrics = document.createElement("span");
    metrics.className = "sb-model-metrics";
    const metric = (label) => {
      const cell = document.createElement("span");
      cell.className = "sb-metric";
      const caption = document.createElement("span");
      caption.className = "sb-metric-label";
      caption.textContent = label;
      const value = document.createElement("b");
      value.className = "num-font";
      const meter = document.createElement("span");
      meter.className = "sb-meter";
      const bar = document.createElement("i");
      meter.appendChild(bar);
      cell.append(caption, value, meter);
      metrics.appendChild(cell);
      return { cell, value, bar };
    };
    const port = createSwitchboardPort("in");
    item.append(port, head, metrics);
    return { item, port, name, agents, reading, agentKey: null, key: "", cache: metric("缓存命中"), calls: metric("请求"), success: metric("成功率") };
  }

  function switchboardPercent(value) {
    if (value == null) return "—";
    return value >= 1 ? "100%" : (Math.floor(value * 1000) / 10).toFixed(1) + "%";
  }

  function switchboardTone(value, good, fair) {
    return value == null ? "is-none" : value >= good ? "is-good" : value >= fair ? "is-fair" : "is-poor";
  }

  function setSwitchboardMetric(metric, text, ratio, tone, title) {
    if (metric.value.textContent !== text) metric.value.textContent = text;
    metric.cell.className = "sb-metric " + tone;
    metric.cell.title = title;
    metric.bar.style.setProperty("--value", (ratio == null ? 0 : Math.round(Math.min(1, Math.max(0, ratio)) * 1000) / 10) + "%");
  }

  // 模型行：真实模型名 + 调用它的 Agent 圆点；缓存命中、请求、成功率按好 / 一般 / 差着色
  function updateSwitchboardModel(row, model, maxRequests) {
    const focus = state.switchboard.selectedAgent;
    const agents = model.called ? model.calling : model.retained ? model.retainedAgents : model.agents;
    const unknown = state.switchboard.liveUnknown;
    const live = unknown ? 0 : model.live;
    row.key = model.key;
    row.item.className = "sb-model" + (unknown ? " is-unknown" : live > 0 ? " is-live" : model.called ? " is-waiting" : model.retained ? " is-idle" : " is-configured-only") + (focus && !model.agents.includes(focus) ? " is-muted" : "");
    if (row.name.textContent !== model.model) row.name.textContent = model.model;
    setSwitchboardDots(row, row.agents, agents);
    row.reading.textContent = unknown ? "状态未知" : live > 0 ? formatNumber(live) + " 进行中" : model.called ? "等待下一步" : model.retained ? "没数据" : "未调用";
    row.item.title = (agents.length ? agents.join(", ") + " → " : "") + model.model + " · " + formatNumber(model.requests) + " 次"
      + (unknown ? " · 状态未知" : live > 0 ? " · " + formatNumber(live) + " 进行中" : "")
      + (model.routes.length ? "\n原始模型：" + model.routes.join(", ") : "");
    const hit = model.hit[1] > 0 ? model.hit[0] / model.hit[1] : null;
    const ok = model.ok[1] > 0 ? model.ok[0] / model.ok[1] : null;
    const failRate = model.requests ? model.errors / model.requests : 0;
    setSwitchboardMetric(row.cache, switchboardPercent(hit), hit, switchboardTone(hit, 0.6, 0.3),
      hit == null ? "暂无上报用量，无法计算缓存命中" : "缓存命中 = 缓存读取 / (普通输入 + 缓存读取 + 缓存写入)\n≥60% 好 · ≥30% 一般");
    setSwitchboardMetric(row.calls, formatNumber(model.requests), maxRequests ? Math.log1p(model.requests) / Math.log1p(maxRequests) : 0,
      !model.requests ? "is-none" : !model.errors ? "is-good" : failRate <= 0.05 ? "is-fair" : "is-poor",
      formatNumber(model.requests) + " 次请求" + (model.errors ? " · " + formatNumber(model.errors) + " 次失败" : " · 无失败") + "\n条长为相对请求量，颜色看失败占比");
    setSwitchboardMetric(row.success, switchboardPercent(ok), ok, switchboardTone(ok, 0.95, 0.7),
      ok == null ? "暂无已完成的请求" : "成功率 = 成功 / (请求 - 取消)\n≥95% 好 · ≥70% 一般");
    paintSwitchboardPort(row.port, unknown ? [] : model.liveAgents);
  }

  function svgNode(tag, attributes) {
    const node = document.createElementNS(SVG_NS, tag);
    Object.entries(attributes).forEach(([name, value]) => node.setAttribute(name, String(value)));
    return node;
  }

  function linkSwitchboardEdge(edges, key, ends, agent, live, idle = false) {
    const existing = edges.get(key);
    const edge = existing || { key, ...ends, agents: [], live: [], idle: Boolean(idle) };
    if (existing && !idle) edge.idle = false;
    if (!edge.agents.includes(agent)) edge.agents.push(agent);
    if (live && !edge.live.includes(agent)) edge.live.push(agent);
    edges.set(key, edge);
  }

  function sortSwitchboardEdges(edges) {
    edges.forEach((edge) => {
      edge.agents.sort();
      edge.live.sort();
    });
    // 空闲线垫底，等待中的居中，有流量的画在最上层
    const layer = (edge) => (edge.live.length ? 2 : edge.idle ? 0 : 1);
    return edges.sort((a, b) => layer(a) - layer(b) || String(a.key || "").localeCompare(String(b.key || "")));
  }

  // 外部画布只表达网关边界：Agent → 统一 IN，统一 OUT → 上游模型。
  function switchboardEdges() {
    const sb = state.switchboard;
    const inbound = new Map();
    const outbound = new Map();
    const agentRows = new Map(sb.agents.map((agent, index) => [agent.name, sb.agentRows[index]]));
    const add = (request, live, idle = false) => {
      const agent = switchboardAgentLabel(request.clientType);
      const agentRow = agentRows.get(agent);
      const model = sb.modelRows.get(JSON.stringify([String(request.provider || "unknown"), String(request.model || "unknown")]));
      if (agentRow) linkSwitchboardEdge(inbound, "in " + agent, { from: agentRow.port, to: els.sbEntryPort, stage: "source" }, agent, live, idle);
      if (model) linkSwitchboardEdge(outbound, "out " + model.key, { from: els.sbExitPort, to: model.port, stage: "upstream" }, agent, live, idle);
    };
    sb.retained.forEach((request) => add(request, false, true));
    sb.topology.forEach((request) => add(request, false));
    if (!sb.liveUnknown) sb.active.forEach((request) => add(request, true));
    const edges = [];
    sb.agents.forEach((agent) => {
      const row = agentRows.get(agent.name);
      if (row && ![...inbound.values()].some((edge) => edge.agents.includes(agent.name))) {
        edges.push({ key: "in idle " + agent.name, from: row.port, to: els.sbEntryPort, agents: [agent.name], live: [], idle: true });
      }
    });
    const linked = new Set([...outbound.values()].map((edge) => edge.to));
    sb.modelRows.forEach((row) => {
      if (!linked.has(row.port)) edges.push({ key: "out idle " + row.key, from: els.sbExitPort, to: row.port, agents: [], live: [], idle: true });
    });
    edges.push(...inbound.values(), ...outbound.values());
    return sortSwitchboardEdges(edges);
  }

  // 内部画布只表达协议处理：入口分配 → adapter path → 出口汇聚。
  function switchboardInternalEdges() {
    const sb = state.switchboard;
    const ingress = new Map();
    const egress = new Map();
    const add = (request, live, idle = false) => {
      const agent = switchboardAgentLabel(request.clientType);
      const pathKey = switchboardAdapterKey(request);
      const path = sb.pathRows.get(pathKey);
      if (!path) return;
      linkSwitchboardEdge(ingress, "internal-in " + pathKey,
        { from: els.sbEntryAnchor, to: path.inPort, side: "ingress", stage: "ingress", pathKey }, agent, live, idle);
      linkSwitchboardEdge(egress, "internal-out " + pathKey,
        { from: path.outPort, to: els.sbExitAnchor, side: "egress", stage: "egress", pathKey }, agent, live, idle);
    };
    sb.retained.forEach((request) => add(request, false, true));
    sb.topology.forEach((request) => add(request, false));
    if (!sb.liveUnknown) sb.active.forEach((request) => add(request, true));
    const paths = [...new Set([...ingress.values(), ...egress.values()].map((edge) => edge.pathKey))].sort();
    const laneByPath = new Map(paths.map((key, index) => [key, index % 4]));
    const edges = [...ingress.values(), ...egress.values()];
    edges.forEach((edge) => { edge.lane = laneByPath.get(edge.pathKey) || 0; });
    return sortSwitchboardEdges(edges);
  }

  function switchboardExternalPath(start, end) {
    const bend = Math.max(24, Math.abs(end.x - start.x) * 0.45);
    return "M " + start.x + " " + start.y + " C " + (start.x + bend) + " " + start.y + " " + (end.x - bend) + " " + end.y + " " + end.x + " " + end.y;
  }

  function switchboardIngressPath(start, end, lane) {
    const railX = Math.min(end.x - 12, end.x - 24 + lane * 5);
    const topY = start.y + 14;
    const turnY = end.y - 8;
    return "M " + start.x + " " + start.y
      + " V " + (topY - 5)
      + " Q " + start.x + " " + topY + " " + (start.x + 5) + " " + topY
      + " H " + (railX - 5)
      + " Q " + railX + " " + topY + " " + railX + " " + (topY + 5)
      + " V " + turnY
      + " Q " + railX + " " + end.y + " " + (railX + 8) + " " + end.y
      + " H " + end.x;
  }

  function switchboardEgressPath(start, end, lane) {
    const railX = Math.max(start.x + 12, start.x + 24 - lane * 5);
    const bottomY = end.y - 14;
    return "M " + start.x + " " + start.y
      + " H " + (railX - 8)
      + " Q " + railX + " " + start.y + " " + railX + " " + (start.y + 8)
      + " V " + (bottomY - 5)
      + " Q " + railX + " " + bottomY + " " + (railX + 5) + " " + bottomY
      + " H " + (end.x - 5)
      + " Q " + end.x + " " + bottomY + " " + end.x + " " + (bottomY + 5)
      + " V " + end.y;
  }

  function switchboardFlowNow() {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  function switchboardFlowKey(request, index) {
    return JSON.stringify([request.requestId || index, request.clientType, request.provider,
      request.model, request.route, request.inputProtocol, request.upstreamProtocol, request.adapter]);
  }

  function syncSwitchboardFlowRequests() {
    const sb = state.switchboard;
    const scope = JSON.stringify([state.providerFilter, state.liveInstanceId]);
    if (sb.flowScope !== scope) {
      sb.flowRequests.clear();
      sb.flowScope = scope;
    }
    if (sb.liveUnknown) return;
    const now = switchboardFlowNow();
    const keys = new Set();
    sb.active.forEach((request, index) => {
      const key = switchboardFlowKey(request, index);
      keys.add(key);
      if (!sb.flowRequests.has(key)) sb.flowRequests.set(key, { startedAt: now });
    });
    for (const key of sb.flowRequests.keys()) if (!keys.has(key)) sb.flowRequests.delete(key);
  }

  function stopSwitchboardFlow() {
    const sb = state.switchboard;
    if (sb.flowFrame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(sb.flowFrame);
    sb.flowFrame = null;
  }

  // A finite dash train contains only packets already emitted at the source.
  // The trailing gap is longer than the path, so SVG cannot repeat it ahead of the head.
  function switchboardPacketDashes(tracks, length, now) {
    const intervals = [];
    tracks.forEach((track) => {
      const head = Math.max(0, now - track.startedAt) * SB_FLOW_SPEED / 1000 - track.offset;
      if (head <= 0) return;
      const first = Math.max(0, Math.ceil((head - SB_FLOW_DASH - length) / SB_FLOW_STEP));
      const last = Math.floor(head / SB_FLOW_STEP);
      for (let packet = last; packet >= first; packet--) {
        const end = Math.min(length, head - packet * SB_FLOW_STEP);
        const start = Math.max(0, head - packet * SB_FLOW_STEP - SB_FLOW_DASH);
        if (end > start) intervals.push([start, end]);
      }
    });
    if (!intervals.length) return null;
    intervals.sort((a, b) => a[0] - b[0]);
    const merged = [];
    intervals.forEach(([start, end]) => {
      const previous = merged[merged.length - 1];
      if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
      else merged.push([start, end]);
    });
    const dashes = [0];
    let cursor = 0;
    merged.forEach(([start, end]) => {
      dashes.push(start - cursor, end - start);
      cursor = end;
    });
    dashes.push(length + SB_FLOW_STEP);
    return dashes.map((value) => value.toFixed(2)).join(" ");
  }

  function paintSwitchboardFlow() {
    const sb = state.switchboard;
    const animate = typeof requestAnimationFrame === "function" && !prefersReducedMotion();
    const visible = state.activeView === "overview" && !document.hidden && !sb.liveUnknown;
    const now = switchboardFlowNow();
    let flowing = false;
    sb.flowRefs.forEach((ref) => ref.flows.forEach((flow) => {
      const live = visible && ref.visible && flow.tracks.length > 0;
      const dashes = live ? (animate ? switchboardPacketDashes(flow.tracks, ref.length, now) : "none") : null;
      flow.node.style.visibility = dashes ? "visible" : "hidden";
      flow.node.style.setProperty("stroke-dasharray", dashes || "0 1000000");
      if (live) flowing = true;
    }));
    return animate && flowing;
  }

  function animateSwitchboardFlow() {
    state.switchboard.flowFrame = null;
    if (paintSwitchboardFlow()) state.switchboard.flowFrame = requestAnimationFrame(animateSwitchboardFlow);
  }

  function connectSwitchboardFlowTracks(external, internal) {
    const sb = state.switchboard;
    sb.flowRefs = [...external, ...internal];
    const refs = new Map(sb.flowRefs.map((ref) => [ref.key, ref]));
    sb.flowRefs.forEach((ref) => ref.flows.forEach((flow) => { flow.tracks = []; }));
    if (sb.liveUnknown) return;
    sb.active.forEach((request, index) => {
      const clock = sb.flowRequests.get(switchboardFlowKey(request, index));
      if (!clock) return;
      const agent = switchboardAgentLabel(request.clientType);
      const path = switchboardAdapterKey(request);
      const model = JSON.stringify([String(request.provider || "unknown"), String(request.model || "unknown")]);
      const keys = ["in " + agent, "internal-in " + path, "internal-out " + path, "out " + model];
      let offset = 0;
      let previous;
      keys.forEach((key) => {
        const ref = refs.get(key);
        if (!ref?.visible) return;
        // Include travel across the gateway ports and the adapter card between SVG segments.
        if (previous) offset += Math.hypot(ref.start.x - previous.end.x, ref.start.y - previous.end.y);
        const flow = ref.flows.find((item) => item.agent === agent);
        if (flow) flow.tracks.push({ startedAt: clock.startedAt, offset });
        offset += ref.length;
        previous = ref;
      });
    });
  }

  function drawSwitchboardWireLayer(host, edges, cacheName, pathForEdge) {
    if (!host) return [];
    const width = host.clientWidth;
    const height = host.clientHeight;
    const visibleEdges = width && height ? edges : [];
    if (!visibleEdges.length) {
      host.replaceChildren();
      state.switchboard[cacheName] = null;
      return [];
    }
    const key = JSON.stringify(visibleEdges.map((edge) => [edge.key, edge.live]));
    let cached = state.switchboard[cacheName];
    if (!cached || cached.key !== key || !host.contains(cached.svg)) {
      const svg = svgNode("svg", { focusable: "false" });
      const refs = visibleEdges.map((edge) => {
        const group = svgNode("g", { "data-edge-key": edge.key, "data-flow-stage": edge.stage || "idle" });
        const wire = svgNode("path", { class: "sb-wire" });
        group.appendChild(wire);
        const flows = edge.live.map((agent) => {
          const flow = svgNode("path", { class: "sb-flow" + (agent === "codex" ? " is-light" : ""), "data-flow-agent": agent, "stroke-dashoffset": 0 });
          flow.style.setProperty("--connection-color", switchboardAgentColor(agent));
          flow.style.visibility = "hidden";
          group.appendChild(flow);
          return { node: flow, agent, tracks: [] };
        });
        svg.appendChild(group);
        return { group, wire, flows, key: edge.key, visible: false };
      });
      cached = state.switchboard[cacheName] = { key, svg, refs };
      host.replaceChildren(svg);
    }
    cached.svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    const origin = host.getBoundingClientRect();
    const center = (element) => {
      const rect = element?.getBoundingClientRect();
      return rect && (rect.width || rect.height) ? { x: rect.left + rect.width / 2 - origin.left, y: rect.top + rect.height / 2 - origin.top } : null;
    };
    const focus = state.switchboard.selectedAgent;
    visibleEdges.forEach((edge, index) => {
      const ref = cached.refs[index];
      const start = center(edge.from);
      const end = center(edge.to);
      ref.visible = Boolean(start && end);
      ref.group.style.display = start && end ? "" : "none";
      if (!start || !end) return;
      const d = pathForEdge(edge, start, end);
      ref.start = { x: start.x + origin.left, y: start.y + origin.top };
      ref.end = { x: end.x + origin.left, y: end.y + origin.top };
      if (ref.d !== d) {
        ref.d = d;
        ref.wire.setAttribute("d", d);
        ref.flows.forEach((flow) => flow.node.setAttribute("d", d));
        ref.length = ref.wire.getTotalLength?.() || Math.max(1, Math.hypot(end.x - start.x, end.y - start.y));
      }
      const tone = edge.live.length ? " is-live" : edge.idle ? " is-idle" : " is-waiting";
      ref.group.setAttribute("class", "sb-route" + tone + (focus ? (edge.agents.includes(focus) ? " is-focus" : " is-dim") : ""));
    });
    return cached.refs;
  }

  function drawSwitchboardWires() {
    if (typeof document.createElementNS !== "function") return;
    const liveAgents = state.switchboard.liveUnknown ? []
      : [...new Set(state.switchboard.active.map((request) => switchboardAgentLabel(request.clientType)))].sort();
    [els.sbEntryPort, els.sbExitPort, els.sbEntryAnchor, els.sbExitAnchor].forEach((port) => paintSwitchboardPort(port, liveAgents));
    const external = drawSwitchboardWireLayer(els.sbWires, switchboardEdges(), "wireCache",
      (_edge, start, end) => switchboardExternalPath(start, end));
    const internal = drawSwitchboardWireLayer(els.sbInternalWires, switchboardInternalEdges(), "internalWireCache",
      (edge, start, end) => edge.side === "ingress"
        ? switchboardIngressPath(start, end, edge.lane)
        : switchboardEgressPath(start, end, edge.lane));
    connectSwitchboardFlowTracks(external, internal);
    stopSwitchboardFlow();
    animateSwitchboardFlow();
  }

  function renderOverview(data) {
    state.switchboardActiveCount = Number(data.switchboardActiveRequests ??
      (Array.isArray(data.switchboardActive) ? data.switchboardActive.length : 0)) || 0;
    updateGatewayStatus(data.gateway?.online, data.gateway || {});
    if (data.liveUnknown && data.gateway?.online) renderSwitchboardCore(true, data.gateway, true);

    // 更新时间
    if (data.generatedAt) {
      els.overviewUpdatedAt.textContent = "更新于: " + formatTime(data.generatedAt);
    }

    // 填充提供商下拉筛选列表
    if (Array.isArray(data.providerNames)) {
      const currentSelected = els.filterProvider.value;
      els.filterProvider.replaceChildren(new Option("全部提供商", ""));
      data.providerNames.forEach((name) => {
        els.filterProvider.add(new Option(String(name), String(name)));
      });
      els.filterProvider.value = data.providerNames.includes(currentSelected) ? currentSelected : "";
    }

    // 核心指标
    const t = data.total || {};
    setReading(els.mRequests, formatNumber(t.requests));
    els.mErrors.textContent = formatNumber(t.errors) + " 错误";
    els.mCancelled.textContent = formatNumber(t.cancelled) + " 取消";

    // 费用主位显示原价，展开金额细节后查看倍率后的费用。
    els.mCost.replaceChildren();
    setCost(els.mCost, t.costUsd, t.baseCostUsd, null, null, "total");
    const counts = `已计费: ${formatNumber(t.pricedRequests)} / 未计价: ${formatNumber(t.unpricedRequests)}`;
    els.mCostSub.textContent = counts;

    setReading(els.mTokens, formatTokens(t.totalTokens));
    els.mInput.textContent = formatTokens(t.input);
    els.mOutput.textContent = formatTokens(t.output);

    setReading(els.mCache, `${formatTokens(t.cacheRead)} / ${formatTokens(t.cacheWrite)}`);
    els.mCacheHit.textContent = formatCacheHitRate(t);
    els.mUnreported.textContent = formatNumber(t.unreported);
    const traffic = data.traffic?.tps;
    els.mTpsCurrent.textContent = formatRate(traffic?.current);
    els.mTpsPeak.textContent = formatRate(traffic?.peak);
    els.mTpsAvg.textContent = formatRate(traffic?.avg);
    els.mOutputTps.textContent = formatRate(t.avgOutputTokensPerSec);
    els.mOutputTps.title = "有效样本: " + formatNumber(t.outputTpsSamples);

    // 交换台线路
    renderSwitchboard(data);

    // 趋势图：筛选或视图变化后从左向右绘入，常规轮询直接重绘
    // 滑动时段每分钟都会整体左移一个桶：按时间找回刚才钉住/悬停的点，而不是沿用下标
    const activeTime = state.trendData[state.trendActiveIndex]?.time;
    state.trendData = Array.isArray(data.trend) ? data.trend : [];
    state.trendModels = Array.isArray(data.trendModels) ? data.trendModels : [];
    state.trendIndex = state.trendData.map((item) => new Map((Array.isArray(item.models) ? item.models : []).map((row) => [row.key, row])));
    state.trendStepInfo = data.trendStep || null;
    state.rangeInfo = data.range || null;
    if (state.trendActiveIndex != null) {
      const index = state.trendData.findIndex((item) => item.time === activeTime);
      state.trendActiveIndex = index >= 0 ? index : null;
      if (index < 0) state.trendPinned = false;
    }
    pruneTrendHidden();
    renderTrendHeader();
    renderTrendLegend();
    renderTrendDataTable();
    if (state.activeView === "overview") {
      if (state.trendNeedsReveal) {
        state.trendNeedsReveal = false;
        revealTrendChart();
      } else drawTrendChart();
    }

    // 进行中请求 (In-flight)
    renderInflight(data.inflight || data.switchboardActive || []);

    // 提供商明细
    renderProvidersTable(data.providers || []);

    // 模型明细
    renderModelsTable(data.models || []);

    // 最近请求历史
    renderRecentTable(data.recent || []);
    state.hasRendered = true;
  }

  function renderInflight(list) {
    const now = Date.now();
    const visibleIds = new Set();
    const stable = (item) => {
      const id = String(item.requestId || "");
      if (!id) return item;
      visibleIds.add(id);
      const serverElapsed = Math.max(0, Number(item.elapsedMs) || 0);
      const previous = state.inflightDisplay.get(id);
      const localElapsed = previous ? previous.displayedElapsedMs + Math.max(0, now - previous.observedAt) : 0;
      const elapsedMs = Math.max(serverElapsed, localElapsed);
      state.inflightDisplay.set(id, { displayedElapsedMs: elapsedMs, observedAt: now });
      return { ...item, elapsedMs };
    };
    list = (Array.isArray(list) ? list : []).map(stable);
    for (const id of state.inflightDisplay.keys()) if (!visibleIds.has(id)) state.inflightDisplay.delete(id);
    els.inflightCount.textContent = list.length;
    els.tableInflightBody.innerHTML = "";
    if (list.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 7;
      td.className = "text-center text-muted";
      td.textContent = "无活动中的请求";
      tr.appendChild(td);
      els.tableInflightBody.appendChild(tr);
      return;
    }

    list.forEach((item) => {
      const tr = document.createElement("tr");
      const tdReq = document.createElement("td");
      tdReq.className = "num-font";
      tdReq.textContent = item.requestId || "-";
      tr.appendChild(tdReq);

      const tdRoute = document.createElement("td");
      tdRoute.textContent = item.route || "-";
      tr.appendChild(tdRoute);

      const tdProv = document.createElement("td");
      tdProv.textContent = item.provider || "-";
      tr.appendChild(tdProv);

      const tdModel = document.createElement("td");
      tdModel.textContent = item.model || "-";
      tr.appendChild(tdModel);

      const tdElapsed = document.createElement("td");
      tdElapsed.className = "num-font";
      tdElapsed.textContent = formatDuration(item.elapsedMs);
      tr.appendChild(tdElapsed);

      const tdIn = document.createElement("td");
      tdIn.className = "num-font";
      tdIn.textContent = formatTokens(item.estimatedInputTokens);
      tr.appendChild(tdIn);

      const tdOut = document.createElement("td");
      tdOut.className = "num-font";
      tdOut.textContent = formatTokens(item.outputTokens);
      tr.appendChild(tdOut);

      els.tableInflightBody.appendChild(tr);
    });
  }

  function formatRate(value) {
    return Number.isFinite(value) && value >= 0 ? value.toFixed(2) + " tok/s" : "-";
  }

  function appendOutputRateCell(tr, value, samples) {
    const td = document.createElement("td");
    td.className = "num-font";
    td.textContent = formatRate(value);
    if (samples !== undefined) td.title = "有效样本: " + formatNumber(samples);
    tr.appendChild(td);
  }

  function renderProvidersTable(providers) {
    els.tableProvidersBody.innerHTML = "";
    if (providers.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 10;
      td.className = "text-center text-muted";
      td.textContent = "暂无数据";
      tr.appendChild(td);
      els.tableProvidersBody.appendChild(tr);
      return;
    }

    const maxCost = Math.max(0, ...providers.map((p) => Number(p.baseCostUsd ?? p.costUsd) || 0));
    providers.forEach((p) => {
      const tr = document.createElement("tr");
      const tdName = document.createElement("td");
      const strong = document.createElement("strong");
      strong.textContent = p.name;
      tdName.appendChild(strong);
      tr.appendChild(tdName);

      const tdReq = document.createElement("td");
      tdReq.className = "num-font";
      tdReq.textContent = formatNumber(p.requests);
      tr.appendChild(tdReq);

      const tdErr = document.createElement("td");
      tdErr.className = "num-font" + (p.errors > 0 ? " text-danger" : "");
      tdErr.textContent = formatNumber(p.errors);
      tr.appendChild(tdErr);

      const tdIn = document.createElement("td");
      tdIn.className = "num-font";
      tdIn.textContent = formatTokens(p.input);
      tr.appendChild(tdIn);

      const tdOut = document.createElement("td");
      tdOut.className = "num-font";
      tdOut.textContent = formatTokens(p.output);
      tr.appendChild(tdOut);

      const tdCache = document.createElement("td");
      tdCache.className = "num-font";
      tdCache.textContent = `${formatTokens(p.cacheRead)} / ${formatTokens(p.cacheWrite)}`;
      tr.appendChild(tdCache);

      const tdCacheHit = document.createElement("td");
      tdCacheHit.className = "num-font";
      tdCacheHit.textContent = formatCacheHitRate(p);
      tr.appendChild(tdCacheHit);

      const tdCost = document.createElement("td");
      tdCost.className = "num-font cost-cell";
      const amount = document.createElement("strong");
      setCost(amount, p.costUsd, p.baseCostUsd, null, null, "provider:" + p.name);
      tdCost.appendChild(amount);
      const track = document.createElement("span");
      track.className = "cost-track";
      track.setAttribute("aria-hidden", "true");
      const fill = document.createElement("span");
      fill.style.width = maxCost ? `${Math.max(0, Math.min(100, (Number(p.baseCostUsd ?? p.costUsd) || 0) / maxCost * 100))}%` : "0%";
      track.appendChild(fill);
      tdCost.appendChild(track);
      tr.appendChild(tdCost);

      const tdPriced = document.createElement("td");
      tdPriced.className = "num-font text-muted";
      tdPriced.textContent = `${formatNumber(p.pricedRequests)} 已计 / ${formatNumber(p.unpricedRequests)} 未计`;
      tr.appendChild(tdPriced);

      appendOutputRateCell(tr, p.avgOutputTokensPerSec, p.outputTpsSamples);
      els.tableProvidersBody.appendChild(tr);
    });
  }

  function renderModelsTable(models) {
    els.tableModelsBody.innerHTML = "";
    if (models.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 9;
      td.className = "text-center text-muted";
      td.textContent = "暂无数据";
      tr.appendChild(td);
      els.tableModelsBody.appendChild(tr);
      return;
    }

    models.forEach((m) => {
      const tr = document.createElement("tr");
      const tdName = document.createElement("td");
      const strong = document.createElement("strong");
      strong.textContent = m.name;
      tdName.appendChild(strong);
      tr.appendChild(tdName);

      const tdReq = document.createElement("td");
      tdReq.className = "num-font";
      tdReq.textContent = formatNumber(m.requests);
      tr.appendChild(tdReq);

      const tdTokens = document.createElement("td");
      tdTokens.className = "num-font text-green";
      tdTokens.textContent = formatTokens(m.totalTokens);
      tr.appendChild(tdTokens);

      const tdIn = document.createElement("td");
      tdIn.className = "num-font";
      tdIn.textContent = formatTokens(m.input);
      tr.appendChild(tdIn);

      const tdOut = document.createElement("td");
      tdOut.className = "num-font";
      tdOut.textContent = formatTokens(m.output);
      tr.appendChild(tdOut);

      const tdCacheHit = document.createElement("td");
      tdCacheHit.className = "num-font";
      tdCacheHit.textContent = formatCacheHitRate(m);
      tr.appendChild(tdCacheHit);

      const tdCost = document.createElement("td");
      tdCost.className = "num-font text-blue";
      setCost(tdCost, m.costUsd, m.baseCostUsd, null, null, "model:" + m.name);
      tr.appendChild(tdCost);

      const tdPriced = document.createElement("td");
      tdPriced.className = "num-font text-muted";
      tdPriced.textContent = `${formatNumber(m.pricedRequests)} 已计 / ${formatNumber(m.unpricedRequests)} 未计`;
      tr.appendChild(tdPriced);

      appendOutputRateCell(tr, m.avgOutputTokensPerSec, m.outputTpsSamples);
      els.tableModelsBody.appendChild(tr);
    });
  }

  function renderRecentTable(recent) {
    els.tableRecentBody.innerHTML = "";
    if (recent.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 10;
      td.className = "text-center text-muted";
      td.textContent = "暂无历史记录";
      tr.appendChild(td);
      els.tableRecentBody.appendChild(tr);
      return;
    }

    recent.forEach((item) => {
      const tr = document.createElement("tr");
      const isErr = item.status >= 400 || !!item.error;
      const tdTime = document.createElement("td");
      tdTime.className = "num-font";
      tdTime.textContent = formatTime(item.time);
      tr.appendChild(tdTime);

      const tdReq = document.createElement("td");
      tdReq.className = "num-font";
      tdReq.title = item.requestId || "";
      tdReq.textContent = (item.requestId || "-").slice(-8);
      tr.appendChild(tdReq);

      const tdRouteProv = document.createElement("td");
      tdRouteProv.textContent = (item.route || "-") + " / " + (item.provider || "-");
      tr.appendChild(tdRouteProv);

      const tdModel = document.createElement("td");
      tdModel.textContent = item.model || "-";
      tr.appendChild(tdModel);

      const tdStatus = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = isErr ? "badge badge-offline" : "badge badge-online";
      badge.textContent = String(item.status || (isErr ? "ERR" : 200));
      tdStatus.appendChild(badge);
      tr.appendChild(tdStatus);

      const tdDur = document.createElement("td");
      tdDur.className = "num-font";
      tdDur.textContent = formatDuration(item.durationMs);
      tr.appendChild(tdDur);

      const tdTokens = document.createElement("td");
      tdTokens.className = "num-font";
      tdTokens.textContent = `${formatTokens(item.inputTokens)} / ${formatTokens(item.outputTokens)} / ${formatTokens(item.cacheReadTokens)}`;
      tr.appendChild(tdTokens);

      const tdUsage = document.createElement("td");
      const badgeUsage = document.createElement("span");
      badgeUsage.className = "badge badge-info";
      badgeUsage.textContent = item.usageSource || "none";
      tdUsage.appendChild(badgeUsage);
      tr.appendChild(tdUsage);

      const tdCost = document.createElement("td");
      tdCost.className = "num-font text-blue";
      setCost(tdCost, item.costUsd, item.baseCostUsd, item.priceMultiplier, item, "recent:" + (item.requestId || item.time));
      tr.appendChild(tdCost);

      appendOutputRateCell(tr, item.outputTokensPerSec);
      els.tableRecentBody.appendChild(tr);
    });
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // --- Canvas 趋势图：按模型堆叠着色、合计折线与精确读数 ---
  const pad2 = (n) => String(n).padStart(2, "0");

  function formatTrendDate(time, compact = false, dateOnly = false) {
    const date = new Date(time);
    if (Number.isNaN(date.getTime())) return String(time || "-");
    if (dateOnly) return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
    if (compact) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  }

  // 一段时间：同一天只写一次日期；从零点到零点的整天只写日期（结束时刻不含在内）
  function formatBucketRange(start, end) {
    const a = new Date(start);
    const b = new Date(end);
    if (Number.isNaN(a.getTime())) return String(start || "-");
    if (Number.isNaN(b.getTime()) || b <= a) return formatTrendDate(a);
    const midnight = (d) => d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0;
    if (midnight(a) && midnight(b)) {
      const last = new Date(b.getTime() - 1);
      const day = formatTrendDate(a, false, true);
      return a.toDateString() === last.toDateString() ? day : `${day} – ${formatTrendDate(last, false, true)}`;
    }
    return `${formatTrendDate(a)} – ${a.toDateString() === b.toDateString() ? formatTrendDate(b, true) : formatTrendDate(b)}`;
  }

  // 粒度键（1m / 6h / 1d）的中文写法
  function stepText(key) {
    const match = /^(\d+)([mhd])$/.exec(String(key || ""));
    return match ? `${match[1]} ${{ m: "分钟", h: "小时", d: "天" }[match[2]]}` : "自动";
  }

  function compactTrendValue(value, isCost) {
    if (isCost) {
      return formatUsd(value);
    }
    return formatTokens(Math.round(value));
  }

  function formatShare(share) {
    if (!(share > 0)) return "0%";
    if (share >= 0.9995) return "100%";
    return share < 0.001 ? "<0.1%" : (share * 100).toFixed(1) + "%";
  }

  const CHART_FONT = "Bahnschrift, 'Segoe UI', 'Microsoft YaHei UI', sans-serif";
  const TREND_PALETTE = 8;
  const CHART_FALLBACK_COLORS = {
    grid: "#e6e9f0", base: "#c4cad7", text: "#697287", hover: "#a9b0c2",
    tokens: "#3346d3", cost: "#3346d3",
    tokensFill: "rgba(51, 70, 211, 0.12)", costFill: "rgba(51, 70, 211, 0.12)",
    tokensTag: "#e9ecfd", tokensTagInk: "#2535b3", costTag: "#e9ecfd", costTagInk: "#2535b3",
    pointFill: "#ffffff", total: "#3b4357",
    series: ["#3346d3", "#10a37f", "#e8862a", "#d4478b", "#7c5ce0", "#1597c9", "#a07d12", "#c6503a"],
    seriesOther: "#a3aab9"
  };

  // 画布颜色取自当前主题的 CSS 变量
  function chartColors() {
    const root = document.documentElement;
    if (!root || typeof getComputedStyle !== "function") return CHART_FALLBACK_COLORS;
    const style = getComputedStyle(root);
    const read = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    const c = CHART_FALLBACK_COLORS;
    return {
      grid: read("--chart-grid", c.grid), base: read("--chart-base", c.base),
      text: read("--chart-text", c.text), hover: read("--chart-hover", c.hover),
      tokens: read("--chart-tokens", c.tokens), cost: read("--chart-cost", c.cost),
      tokensFill: read("--chart-tokens-fill", c.tokensFill), costFill: read("--chart-cost-fill", c.costFill),
      tokensTag: read("--chart-tokens-tag", c.tokensTag), tokensTagInk: read("--chart-tokens-tag-ink", c.tokensTagInk),
      costTag: read("--chart-cost-tag", c.costTag), costTagInk: read("--chart-cost-tag-ink", c.costTagInk),
      pointFill: read("--chart-point-fill", c.pointFill), total: read("--chart-total", c.total),
      series: c.series.map((fallback, index) => read(`--chart-series-${index + 1}`, fallback)),
      seriesOther: read("--chart-series-other", c.seriesOther)
    };
  }

  // 趋势细分的各个模型：顺序沿用服务端排名（用量大的画在下层）；
  // 颜色按模型记住，轮询时排名互换也不会串色
  function trendSeries() {
    const models = state.trendModels;
    if (!models.length || !state.trendData.some((item) => Array.isArray(item.models))) return [];
    const sameName = new Map();
    models.forEach((m) => { if (!m.other) sameName.set(m.model, (sameName.get(m.model) || 0) + 1); });
    assignTrendColors(models.filter((m) => !m.other).map((m) => m.key));
    return models.map((m) => ({
      key: m.key,
      total: m,
      label: m.other ? `其他 ${formatNumber(m.count)} 个模型` : sameName.get(m.model) > 1 ? `${m.model} · ${m.provider}` : String(m.model),
      title: m.other ? "用量较小的模型合并为一组" : `${m.provider} · ${m.model}`,
      slot: m.other ? null : state.trendColors.get(m.key),
      hidden: state.trendHidden.has(m.key)
    }));
  }

  function assignTrendColors(keys) {
    const slots = state.trendColors;
    const taken = new Set();
    const pending = [];
    keys.forEach((key) => {
      const slot = slots.get(key);
      if (slot !== undefined && !taken.has(slot)) taken.add(slot);
      else pending.push(key);
    });
    pending.forEach((key, index) => {
      let slot = 0;
      while (taken.has(slot)) slot++;
      if (slot >= TREND_PALETTE) slot = index % TREND_PALETTE;
      taken.add(slot);
      slots.set(key, slot);
    });
    if (slots.size > 64) [...slots.keys()].forEach((key) => { if (!keys.includes(key)) slots.delete(key); });
  }

  function seriesColor(colors, series) {
    return series.slot == null ? colors.seriesOther : colors.series[series.slot % colors.series.length];
  }

  function seriesCssColor(series) {
    return series.slot == null ? "var(--chart-series-other)" : `var(--chart-series-${(series.slot % TREND_PALETTE) + 1})`;
  }

  function trendMetricValue(row, isCost) {
    if (!row) return 0;
    if (!isCost) return Math.max(0, Number(row.totalTokens) || 0);
    const raw = row.baseCostUsd ?? row.costUsd;
    return raw == null ? 0 : Math.max(0, Number(raw) || 0);
  }

  // 隐藏集合只保留当前还在的模型；全部被隐藏时恢复显示
  function pruneTrendHidden() {
    const keys = state.trendModels.map((m) => m.key);
    [...state.trendHidden].forEach((key) => { if (!keys.includes(key)) state.trendHidden.delete(key); });
    if (keys.length && keys.every((key) => state.trendHidden.has(key))) state.trendHidden.clear();
  }

  function renderTrendHeader() {
    const range = state.rangeInfo;
    const step = state.trendStepInfo;
    const parts = [];
    if (range?.since != null && range?.until != null) parts.push(formatBucketRange(range.since, range.until));
    if (step?.label) parts.push("每 " + step.label + (step.adjusted ? `（${stepText(step.requested)}点数过多，已自动放大）` : ""));
    els.trendRangeLabel.textContent = parts.join(" · ");
  }

  // 图例：色块 + 模型名 + 该时段合计与占比；点击隐藏/显示，双击只看这一个
  function renderTrendLegend() {
    const series = trendSeries();
    els.trendLegend.classList.toggle("hidden", series.length === 0);
    const structure = series.map((s) => s.key + "\u0001" + s.label).join("\u0002");
    if (structure !== state.trendLegendKeys) {
      state.trendLegendKeys = structure;
      state.trendLegendRows = series.map((s) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "trend-legend-item";
        button.setAttribute("data-series", s.key);
        const swatch = document.createElement("i");
        swatch.className = "trend-swatch";
        swatch.setAttribute("aria-hidden", "true");
        const name = document.createElement("span");
        name.className = "trend-legend-name";
        name.textContent = s.label;
        const reading = document.createElement("span");
        reading.className = "trend-legend-value num-font";
        button.append(swatch, name, reading);
        return { button, swatch, reading };
      });
      els.trendLegend.replaceChildren(...state.trendLegendRows.map((row) => row.button));
    }
    const isCost = state.trendMetric === "cost";
    const grand = series.reduce((sum, s) => sum + trendMetricValue(s.total, isCost), 0);
    series.forEach((s, index) => {
      const row = state.trendLegendRows[index];
      const value = trendMetricValue(s.total, isCost);
      const share = grand > 0 ? value / grand : 0;
      row.swatch.style.setProperty("--series-color", seriesCssColor(s));
      row.button.classList.toggle("is-off", s.hidden);
      row.button.setAttribute("aria-pressed", String(!s.hidden));
      row.reading.textContent = (isCost ? formatUsdShort(value) : formatTokens(value)) + " · " + formatShare(share);
      row.button.title = `${s.title}\n${isCost ? "原价 " + formatUsd(value) : formatNumber(value) + " Tokens"}（${formatShare(share)}）· 缓存命中 ${formatCacheHitRate(s.total)} · ${formatNumber(s.total.requests)} 次请求\n点击${s.hidden ? "显示" : "隐藏"}，双击只看此模型`;
    });
  }

  function toggleTrendSeries(key, solo = false) {
    const keys = state.trendModels.map((m) => m.key);
    if (solo) {
      const isolated = keys.every((k) => k === key ? !state.trendHidden.has(k) : state.trendHidden.has(k));
      state.trendHidden = new Set(isolated ? [] : keys.filter((k) => k !== key));
    } else if (state.trendHidden.has(key)) state.trendHidden.delete(key);
    else state.trendHidden.add(key);
    pruneTrendHidden();
    renderTrendLegend();
    drawTrendChart();
  }

  // 曲线从左向右绘入；无动画环境或减少动态效果时直接完整绘制
  function revealTrendChart() {
    if (typeof requestAnimationFrame !== "function" || prefersReducedMotion()) {
      state.trendReveal = 1;
      drawTrendChart();
      return;
    }
    if (state.trendRevealFrame) cancelAnimationFrame(state.trendRevealFrame);
    const start = performance.now();
    const duration = 750;
    const step = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      state.trendReveal = 1 - Math.pow(1 - progress, 3);
      drawTrendChart();
      state.trendRevealFrame = progress < 1 ? requestAnimationFrame(step) : null;
    };
    state.trendReveal = 0;
    state.trendRevealFrame = requestAnimationFrame(step);
  }

  function trendAxis(maxValue, isCost) {
    if (maxValue <= 0) return { step: isCost ? 0.0025 : 1, ticks: 4 };
    const raw = maxValue / 4;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 4, 5, 8, 10]
      .map((multiplier) => multiplier * magnitude)
      .reduce((closest, candidate) => Math.abs(candidate - raw) < Math.abs(closest - raw) ? candidate : closest);
    return { step, ticks: Math.max(4, Math.ceil(maxValue * 1.06 / step)) };
  }

  // 数据表的“模型构成”列：占比最高的三个模型
  function trendMixText(item, series, isCost) {
    const entries = (Array.isArray(item.models) ? item.models : [])
      .map((row) => [series.get(row.key)?.label ?? row.key, trendMetricValue(row, isCost)])
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((sum, [, value]) => sum + value, 0);
    if (!total) return "—";
    return entries.slice(0, 3).map(([label, value]) => `${label} ${formatShare(value / total)}`).join(" · ") +
      (entries.length > 3 ? ` 等 ${entries.length} 个` : "");
  }

  function renderTrendDataTable() {
    const isCost = state.trendMetric === "cost";
    els.trendDataValueHeading.textContent = isCost ? "原价 (USD)" : "Tokens";
    els.trendDataAdjustedHeading.classList.toggle("hidden", !isCost);
    els.trendDataBody.replaceChildren();
    if (state.trendData.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = isCost ? 6 : 5;
      cell.textContent = "暂无趋势数据";
      row.appendChild(cell);
      els.trendDataBody.appendChild(row);
      return;
    }
    const series = new Map(trendSeries().map((s) => [s.key, s]));
    state.trendData.forEach((item) => {
      const row = document.createElement("tr");
      const time = document.createElement("td");
      time.textContent = formatBucketRange(item.time, item.end);
      const value = document.createElement("td");
      value.className = "num-font";
      value.textContent = isCost
        ? (item.baseCostUsd ?? item.costUsd) == null ? "未计价" : formatUsd(item.baseCostUsd ?? item.costUsd)
        : formatTokens(item.totalTokens);
      row.append(time, value);
      if (isCost) {
        const adjusted = document.createElement("td");
        adjusted.className = "num-font";
        adjusted.textContent = item.costUsd == null ? "未计价" : formatUsd(item.costUsd);
        row.appendChild(adjusted);
      }
      const requests = document.createElement("td");
      requests.className = "num-font";
      requests.textContent = item.requests == null ? "—" : formatNumber(item.requests);
      const hit = document.createElement("td");
      hit.className = "num-font";
      hit.textContent = formatCacheHitRate(item);
      const mix = document.createElement("td");
      mix.className = "trend-mix";
      mix.textContent = trendMixText(item, series, isCost);
      row.append(requests, hit, mix);
      els.trendDataBody.appendChild(row);
    });
  }

  // 悬浮提示里逐个列出该时段的模型：用量、占比、缓存命中率与请求数
  function renderTrendTooltipModels(item, isCost) {
    const series = new Map(trendSeries().map((s) => [s.key, s]));
    const entries = (Array.isArray(item.models) ? item.models : [])
      .map((row) => ({ row, series: series.get(row.key), value: trendMetricValue(row, isCost) }))
      .filter((entry) => entry.series && (entry.value > 0 || entry.row.requests > 0))
      .sort((a, b) => b.value - a.value || b.row.requests - a.row.requests);
    els.trendTooltipModels.classList.toggle("hidden", entries.length === 0);
    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    els.trendTooltipModels.replaceChildren(...entries.map(({ row, series: s, value }) => {
      const li = document.createElement("li");
      li.className = "trend-tip-row" + (s.hidden ? " is-hidden" : "");
      const swatch = document.createElement("i");
      swatch.className = "trend-swatch";
      swatch.style.setProperty("--series-color", seriesCssColor(s));
      const cells = [
        ["trend-tip-name", s.label],
        ["trend-tip-value num-font", isCost && (row.baseCostUsd ?? row.costUsd) == null ? "未计价" : isCost ? formatUsd(value) : formatNumber(value)],
        ["trend-tip-share num-font", total > 0 ? formatShare(value / total) : "—"],
        ["trend-tip-hit num-font", "命中 " + formatCacheHitRate(row)],
        ["trend-tip-req num-font", formatNumber(row.requests) + " 次"]
      ].map(([className, text]) => {
        const span = document.createElement("span");
        span.className = className;
        span.textContent = text;
        return span;
      });
      li.append(swatch, ...cells);
      return li;
    }));
  }

  function updateTrendTooltip() {
    const point = state.trendPoints[state.trendActiveIndex];
    if (!point || point.value === null || state.trendBrush?.active) {
      els.trendTooltip.classList.add("hidden");
      els.trendTooltip.setAttribute("aria-hidden", "true");
      return;
    }
    const item = state.trendData[point.index] || {};
    const isCost = state.trendMetric === "cost";
    els.trendTooltipValue.textContent = isCost ? `原价 ${formatUsd(point.value)}` : formatNumber(point.value) + " Tokens";
    els.trendTooltipAdjusted.textContent = point.adjustedValue == null ? "" : `倍率后 ${formatUsd(point.adjustedValue)}`;
    els.trendTooltipAdjusted.classList.toggle("hidden", !els.trendTooltipAdjusted.textContent);
    // 隐藏了部分模型时，合计、命中率与请求数都只算显示中的模型
    const usage = point.usage || item;
    const meta = [];
    if (["input", "cacheRead", "cacheWrite"].some((field) => usage[field] != null)) meta.push("缓存命中 " + formatCacheHitRate(usage));
    if (usage.requests != null) meta.push(formatNumber(usage.requests) + " 次请求");
    if (point.hiddenCount) meta.push(`已隐藏 ${point.hiddenCount} 个模型`);
    els.trendTooltipMeta.textContent = meta.join(" · ");
    els.trendTooltipMeta.classList.toggle("hidden", meta.length === 0);
    renderTrendTooltipModels(item, isCost);
    els.trendTooltipTime.textContent = formatBucketRange(item.time || point.time, item.end);
    els.trendTooltip.classList.remove("hidden");
    els.trendTooltip.setAttribute("aria-hidden", "false");
    const tooltipText = [els.trendTooltipValue.textContent, els.trendTooltipAdjusted.textContent, els.trendTooltipMeta.textContent].filter(Boolean).join("，");
    els.trendCanvas.setAttribute("aria-label", `用量趋势，${els.trendTooltipTime.textContent}，${tooltipText}。使用左右方向键查看其他点，回车放大到该时段`);
    positionTrendTooltip(point);
  }

  // 提示框放在悬停线一侧，靠边时换到另一侧，纵向不超出图表
  function positionTrendTooltip(point) {
    const tip = els.trendTooltip;
    const bounds = els.trendCanvas.getBoundingClientRect();
    const width = tip.offsetWidth || 0;
    const height = tip.offsetHeight || 0;
    const gap = 14;
    let left = point.x + gap;
    if (left + width > bounds.width - 6) left = point.x - gap - width;
    if (left < 6) left = Math.max(6, Math.min(bounds.width - width - 6, point.x - width / 2));
    const top = Math.max(6, Math.min((bounds.height || 260) - height - 6, point.y - height / 2));
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  function drawTrendChart() {
    const canvas = els.trendCanvas;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const width = rect.width;
    const height = rect.height || canvas.parentElement.clientHeight || 260;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const data = state.trendData;
    const isCost = state.trendMetric === "cost";
    canvas.setAttribute("aria-label", `用量趋势，${isCost ? "费用（美元）" : "Tokens"}，${data.length} 个时间点。使用左右方向键查看各点数值，回车放大到该时段`);
    state.trendPoints = [];
    if (data.length === 0) {
      els.trendEmpty.textContent = "暂无趋势数据";
      els.trendEmpty.classList.remove("hidden");
      updateTrendTooltip();
      return;
    }

    // 显示中的模型逐桶取值；没有细分数据时只画合计
    const series = trendSeries();
    const visible = series.filter((s) => !s.hidden);
    const hiddenCount = series.length - visible.length;
    const bands = visible.map((s) => data.map((item, index) => trendMetricValue(state.trendIndex[index]?.get(s.key), isCost)));
    const values = data.map((item, index) => {
      const raw = isCost ? item.baseCostUsd ?? item.costUsd : item.totalTokens;
      if (isCost && raw == null) return null;
      return hiddenCount ? bands.reduce((sum, band) => sum + band[index], 0) : Math.max(0, Number(raw) || 0);
    });
    const available = values.filter((value) => value !== null);
    if (!available.length) {
      els.trendEmpty.textContent = "暂无已计价数据";
      els.trendEmpty.classList.remove("hidden");
      updateTrendTooltip();
      return;
    }
    els.trendEmpty.classList.add("hidden");
    const axis = trendAxis(Math.max(...available), isCost);
    const ceiling = axis.step * axis.ticks;
    const colors = chartColors();
    ctx.font = `500 11px ${CHART_FONT}`;
    const left = Math.max(44, Math.ceil(ctx.measureText(compactTrendValue(ceiling, isCost, axis.step)).width) + 17);
    const right = 16;
    const top = 32;
    const bottom = 38;
    const plotWidth = Math.max(1, width - left - right);
    const plotHeight = Math.max(1, height - top - bottom);
    const baseY = top + plotHeight;
    const yOf = (value) => baseY - value / ceiling * plotHeight;
    const times = data.map((item) => Date.parse(item.time));
    const timeScale = times.every(Number.isFinite) && Math.max(...times) > Math.min(...times);
    const firstTime = timeScale ? Math.min(...times) : 0;
    const lastTime = timeScale ? Math.max(...times) : 0;
    state.trendPoints = data.map((item, index) => {
      const point = {
        index,
        time: item.time,
        value: values[index],
        adjustedValue: item.costUsd != null ? Number(item.costUsd) : null,
        x: data.length === 1 ? left + plotWidth / 2 : left + (timeScale ? (times[index] - firstTime) / (lastTime - firstTime) : index / (data.length - 1)) * plotWidth,
        y: values[index] === null ? null : yOf(values[index])
      };
      if (hiddenCount) {
        const rows = visible.map((s) => state.trendIndex[index]?.get(s.key)).filter(Boolean);
        const sum = (field) => rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);
        const priced = rows.filter((row) => row.costUsd != null);
        point.hiddenCount = hiddenCount;
        point.usage = { input: sum("input"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), requests: sum("requests") };
        point.adjustedValue = priced.length ? priced.reduce((total, row) => total + Number(row.costUsd), 0) : null;
      }
      return point;
    });

    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let tick = 0; tick <= axis.ticks; tick++) {
      const y = baseY - tick / axis.ticks * plotHeight;
      ctx.strokeStyle = tick === 0 ? colors.base : colors.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(width - right, y);
      ctx.stroke();
      ctx.fillStyle = colors.text;
      ctx.fillText(compactTrendValue(tick * axis.step, isCost, axis.step), left - 8, y);
    }

    ctx.textBaseline = "top";
    ctx.fillStyle = colors.text;
    const labels = data.length === 1 ? 1 : Math.max(2, Math.min(7, Math.floor(plotWidth / 115) + 1));
    for (let index = 0; index < labels; index++) {
      const fraction = labels === 1 ? 0.5 : index / (labels - 1);
      const x = left + fraction * plotWidth;
      const time = timeScale ? firstTime + fraction * (lastTime - firstTime) : data[Math.round(fraction * (data.length - 1))]?.time;
      ctx.textAlign = labels === 1 ? "center" : index === 0 ? "left" : index === labels - 1 ? "right" : "center";
      ctx.fillText(formatTrendDate(time, true, timeScale && lastTime - firstTime >= 36 * 3600 * 1000), x, baseY + 11);
    }

    // 绘入进度：只裁剪数据层，坐标轴始终完整
    const revealing = state.trendReveal < 1;
    if (revealing) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, left + plotWidth * state.trendReveal + 6, height);
      ctx.clip();
    }

    const segments = [];
    state.trendPoints.forEach((point) => {
      if (point.value === null) return;
      if (point.index === 0 || state.trendPoints[point.index - 1].value === null) segments.push([]);
      segments[segments.length - 1].push(point);
    });

    // 模型色带自下而上堆叠；孤立的单个点画成一根堆叠短柱
    const stacked = visible.length > 0;
    if (stacked) {
      const lower = data.map(() => 0);
      const barWidth = Math.max(6, Math.min(18, plotWidth / data.length * 0.6));
      visible.forEach((s, bandIndex) => {
        const upper = lower.map((value, index) => value + bands[bandIndex][index]);
        const color = seriesColor(colors, s);
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        segments.forEach((segment) => {
          if (segment.length === 1) {
            const point = segment[0];
            const barHeight = yOf(lower[point.index]) - yOf(upper[point.index]);
            if (barHeight > 0) {
              ctx.globalAlpha = 0.75;
              ctx.fillRect(point.x - barWidth / 2, yOf(upper[point.index]), barWidth, barHeight);
              ctx.globalAlpha = 1;
            }
            return;
          }
          ctx.beginPath();
          segment.forEach((point, k) => k ? ctx.lineTo(point.x, yOf(upper[point.index])) : ctx.moveTo(point.x, yOf(upper[point.index])));
          for (let k = segment.length - 1; k >= 0; k--) ctx.lineTo(segment[k].x, yOf(lower[segment[k].index]));
          ctx.closePath();
          ctx.globalAlpha = 0.5;
          ctx.fill();
          ctx.globalAlpha = 0.95;
          ctx.beginPath();
          segment.forEach((point, k) => k ? ctx.lineTo(point.x, yOf(upper[point.index])) : ctx.moveTo(point.x, yOf(upper[point.index])));
          ctx.lineWidth = 1.25;
          ctx.lineJoin = "round";
          ctx.stroke();
          ctx.globalAlpha = 1;
        });
        upper.forEach((value, index) => { lower[index] = value; });
      });
    }

    // 合计折线：有模型细分时用中性色压在色带上
    const strokeColor = stacked ? colors.total : isCost ? colors.cost : colors.tokens;
    segments.forEach((segment) => {
      if (segment.length < 2) return;
      if (!stacked) {
        const gradient = ctx.createLinearGradient(0, top, 0, baseY);
        gradient.addColorStop(0, isCost ? colors.costFill : colors.tokensFill);
        gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
        ctx.beginPath();
        ctx.moveTo(segment[0].x, baseY);
        segment.forEach((point) => ctx.lineTo(point.x, point.y));
        ctx.lineTo(segment[segment.length - 1].x, baseY);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();
      }
      ctx.beginPath();
      segment.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y));
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = stacked ? 1.75 : 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
    });

    const active = state.trendPoints[state.trendActiveIndex];
    if (active && active.value !== null) {
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = colors.hover;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(active.x, top);
      ctx.lineTo(active.x, baseY);
      ctx.stroke();
      ctx.setLineDash([]);
      // 悬停时标出每条色带在该点的上沿
      let level = 0;
      visible.forEach((s, bandIndex) => {
        const value = bands[bandIndex][active.index];
        level += value;
        if (!(value > 0) || level >= active.value) return;
        ctx.beginPath();
        ctx.arc(active.x, yOf(level), 3, 0, Math.PI * 2);
        ctx.fillStyle = seriesColor(colors, s);
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = colors.pointFill;
        ctx.stroke();
      });
    }

    const candidates = state.trendPoints.filter((point) => point.value > 0 && point.index !== state.trendActiveIndex)
      .sort((a, b) => b.value - a.value);
    const occupied = [];
    ctx.font = `600 11px ${CHART_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const point of candidates) {
      if (occupied.length >= Math.max(1, Math.floor(plotWidth / 150))) break;
      const label = compactTrendValue(point.value, isCost, axis.step);
      const labelWidth = ctx.measureText(label).width + 12;
      const x = Math.max(left + labelWidth / 2, Math.min(width - right - labelWidth / 2, point.x));
      const y = Math.max(3, point.y - 25);
      if (occupied.some((box) => Math.abs(box.x - x) < (box.width + labelWidth) / 2 + 9 && Math.abs(box.y - y) < 19)) continue;
      ctx.fillStyle = isCost ? colors.costTag : colors.tokensTag;
      if (typeof ctx.roundRect === "function") {
        ctx.beginPath();
        ctx.roundRect(x - labelWidth / 2, y, labelWidth, 18, 5);
        ctx.fill();
      } else ctx.fillRect(x - labelWidth / 2, y, labelWidth, 18);
      ctx.fillStyle = isCost ? colors.costTagInk : colors.tokensTagInk;
      ctx.fillText(label, x, y + 9);
      occupied.push({ x, y, width: labelWidth });
    }

    // 点很密（细粒度、长时段）时只画当前点，避免糊成一片
    const dense = plotWidth / data.length < 7;
    state.trendPoints.forEach((point) => {
      if (point.value === null) return;
      const isActive = point.index === state.trendActiveIndex;
      if (dense && !isActive) return;
      if (isActive) {
        ctx.globalAlpha = 0.18;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 11, 0, Math.PI * 2);
        ctx.fillStyle = strokeColor;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.beginPath();
      ctx.arc(point.x, point.y, isActive ? 5 : 4, 0, Math.PI * 2);
      ctx.fillStyle = strokeColor;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = colors.pointFill;
      ctx.stroke();
    });
    if (revealing) ctx.restore();
    drawTrendBrush(ctx, { left, plotWidth, top, baseY, colors });
    updateTrendTooltip();
  }

  // 拖拽框选：半透明选区 + 将要放大到的时间段
  function drawTrendBrush(ctx, frame) {
    const brush = state.trendBrush;
    if (!brush?.active) return;
    const clamp = (x) => Math.max(frame.left, Math.min(frame.left + frame.plotWidth, x));
    const x0 = clamp(Math.min(brush.startX, brush.x));
    const x1 = clamp(Math.max(brush.startX, brush.x));
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = frame.colors.tokens;
    ctx.fillRect(x0, frame.top, Math.max(1, x1 - x0), frame.baseY - frame.top);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = frame.colors.tokens;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, frame.top);
    ctx.lineTo(x0, frame.baseY);
    ctx.moveTo(x1, frame.top);
    ctx.lineTo(x1, frame.baseY);
    ctx.stroke();
    const range = trendBrushRange(brush);
    if (!range) return;
    const label = "放大到 " + formatBucketRange(range[0], range[1]);
    ctx.font = `600 11px ${CHART_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const half = ctx.measureText(label).width / 2;
    ctx.fillStyle = frame.colors.tokensTagInk;
    ctx.fillText(label, Math.max(frame.left + half, Math.min(frame.left + frame.plotWidth - half, (x0 + x1) / 2)), frame.top - 14);
  }

  function selectTrendPoint(index) {
    if (state.trendActiveIndex === index) return;
    state.trendActiveIndex = index;
    drawTrendChart();
  }

  function trendCanvasX(clientX) {
    return clientX - els.trendCanvas.getBoundingClientRect().left;
  }

  function trendPointAt(clientX) {
    const x = trendCanvasX(clientX);
    const points = state.trendPoints.filter((point) => point.value !== null);
    return points.reduce((closest, point) => !closest || Math.abs(point.x - x) < Math.abs(closest.x - x) ? point : closest, null)?.index ?? null;
  }

  // 某个分桶的起止（毫秒，结束不含）
  function trendBucketBounds(index) {
    const item = state.trendData[index];
    const start = Date.parse(item?.time);
    const next = state.trendData[index + 1];
    const end = Date.parse(item?.end) || (next ? Date.parse(next.time) : start + (state.trendStepInfo?.ms || 3_600_000));
    return [start, end];
  }

  // 框选覆盖到的分桶；太窄没盖住任何点时取离中心最近的一个
  function trendBrushRange(brush) {
    const low = Math.min(brush.startX, brush.x);
    const high = Math.max(brush.startX, brush.x);
    let picked = state.trendPoints.filter((point) => point.x >= low && point.x <= high);
    if (!picked.length) {
      const center = (low + high) / 2;
      const nearest = state.trendPoints.reduce((closest, point) => !closest || Math.abs(point.x - center) < Math.abs(closest.x - center) ? point : closest, null);
      picked = nearest ? [nearest] : [];
    }
    if (!picked.length) return null;
    return [trendBucketBounds(picked[0].index)[0], trendBucketBounds(picked[picked.length - 1].index)[1]];
  }

  function zoomTrendTo(since, until) {
    if (!Number.isFinite(since) || !Number.isFinite(until) || until - since < 60_000) return;
    const current = state.range;
    if (current.period === "custom" && current.since === since && current.until === until) return;
    setRange({ period: "custom", since, until }, { push: true, resetStep: true });
  }

  // --- 时间范围：预设 / 自定义起止 / 放大与返回 ---
  const PERIOD_LABELS = {
    "5m": "最近 5 分钟", "15m": "最近 15 分钟", "30m": "最近 30 分钟", "1h": "最近 1 小时", "3h": "最近 3 小时",
    "6h": "最近 6 小时", "12h": "最近 12 小时", "24h": "最近 24 小时", today: "今天", yesterday: "昨天",
    "3d": "最近 3 天", "7d": "最近 7 天", "14d": "最近 14 天", "30d": "最近 30 天", "90d": "最近 90 天", all: "全部"
  };

  function rangeText(range) {
    return range.period === "custom" ? formatBucketRange(range.since, range.until) : PERIOD_LABELS[range.period] || range.period;
  }

  // datetime-local 的值按本地时间读写，精确到分钟
  function toLocalInput(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function fromLocalInput(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ""));
    return match ? new Date(+match[1], match[2] - 1, +match[3], +match[4], +match[5]).getTime() : NaN;
  }

  // push：记入“返回上一范围”；resetStep：放大后改回自动粒度，才能看到更细的分桶
  function setRange(range, { push = false, resetStep = false } = {}) {
    if (push) {
      state.rangeHistory.push({ range: state.range, step: state.trendStep });
      if (state.rangeHistory.length > 20) state.rangeHistory.shift();
    } else state.rangeHistory = [];
    if (resetStep) state.trendStep = "auto";
    state.range = range;
    state.trendActiveIndex = null;
    state.trendPinned = false;
    state.trendNeedsReveal = true;
    syncRangeControls();
    fetchOverview();
  }

  function zoomOutRange() {
    const previous = state.rangeHistory.pop();
    if (!previous) return;
    state.range = previous.range;
    state.trendStep = previous.step;
    state.trendActiveIndex = null;
    state.trendPinned = false;
    state.trendNeedsReveal = true;
    syncRangeControls();
    fetchOverview();
  }

  function syncRangeControls() {
    const period = state.range.period;
    let preset = false;
    els.filterPeriod.querySelectorAll(".seg-btn").forEach((button) => {
      const on = button.getAttribute("data-value") === period;
      preset ||= on;
      button.classList.toggle("active", on);
      button.setAttribute("aria-checked", String(on));
    });
    els.timeQuick.querySelectorAll("[data-value]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.getAttribute("data-value") === period));
    });
    els.timePickerLabel.textContent = preset ? "更多" : rangeText(state.range);
    els.btnTimePicker.classList.toggle("is-active", !preset);
    els.btnTimePicker.title = preset ? "更多时间范围与自定义时段" : `当前：${rangeText(state.range)}，点击修改`;
    els.trendStep.value = state.trendStep;
    els.btnTrendZoomOut.classList.toggle("hidden", state.rangeHistory.length === 0);
  }

  function toggleTimePicker(open = els.timePickerPanel.classList.contains("hidden")) {
    els.timePickerPanel.classList.toggle("hidden", !open);
    els.btnTimePicker.setAttribute("aria-expanded", String(open));
    if (!open) return;
    els.rangeError.classList.add("hidden");
    const custom = state.range.period === "custom";
    const since = custom ? state.range.since : state.rangeInfo?.since;
    const until = custom ? state.range.until : state.rangeInfo?.until;
    els.rangeSince.value = since ? toLocalInput(since) : "";
    els.rangeUntil.value = until ? toLocalInput(until) : "";
  }

  function applyCustomRange() {
    const since = fromLocalInput(els.rangeSince.value);
    const until = fromLocalInput(els.rangeUntil.value);
    const error = !Number.isFinite(since) || !Number.isFinite(until) ? "请填写开始和结束时间"
      : until - since < 60_000 ? "结束时间需晚于开始时间至少 1 分钟" : "";
    els.rangeError.textContent = error;
    els.rangeError.classList.toggle("hidden", !error);
    if (error) return;
    toggleTimePicker(false);
    setRange({ period: "custom", since, until }, { push: true });
  }

  // 窗口或侧栏宽度变化后重排画布、线路与导航指示条（每帧最多一次）
  let layoutFrame = null;
  function refreshLayout() {
    if (layoutFrame) return;
    const run = () => {
      layoutFrame = null;
      positionNavIndicator();
      if (state.activeView === "settings" && state.settings.isEditing) syncStickyOffset();
      if (state.activeView !== "overview") return;
      drawTrendChart();
      drawSwitchboardWires(false);
    };
    if (typeof requestAnimationFrame !== "function") return run();
    layoutFrame = requestAnimationFrame(run);
  }

  window.addEventListener("resize", refreshLayout);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopSwitchboardFlow();
    else if (state.activeView === "overview") drawSwitchboardWires();
  });
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(refreshLayout);
    observer.observe(els.sbWires);
    observer.observe(els.sbInternalWires);
    observer.observe(els.trendCanvas);
  }

  // --- 视图 2: 请求日志 ---
  async function fetchLogs() {
    try {
      const p = new URLSearchParams({
        source: state.logs.source,
        limit: "200",
        errors: state.logs.errorsOnly ? "1" : "0"
      });
      if (state.logs.q) p.set("q", state.logs.q);

      const res = await apiFetch("/api/logs?" + p.toString());
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      renderLogs(data);
    } catch (err) {
      if (err.message !== "401 Unauthorized") {
        // 请求失败
      }
    }
  }

  function appendLogText(row, text, className) {
    if (!text) return;
    const span = document.createElement("span");
    span.className = className;
    span.textContent = text;
    row.appendChild(span);
  }

  function appendLogHeader(row, text) {
    const token = /(⇒\s*[^\s·]+|@[^\s·]+|▗\[[^\]]+\]▖|◖[^◗]+◗|~\([^)]*\)><|▼\([^)]*\)▼)/g;
    let previous = 0;
    for (const match of text.matchAll(token)) {
      appendLogText(row, text.slice(previous, match.index), "log-route");
      const value = match[0];
      const kind = value.startsWith("⇒") ? "log-model"
        : value.startsWith("@") ? "log-provider"
          : value.startsWith("▗") ? "log-client-claude"
            : value.startsWith("▼") ? "log-client-gemini"
              : value.startsWith("~") ? "log-client-deepseek" : "log-client-codex";
      appendLogText(row, value, kind);
      previous = match.index + value.length;
    }
    appendLogText(row, text.slice(previous), "log-route");
  }

  function logDetailClass(text) {
    if (/^费用\s/.test(text)) return "log-cost";
    if (/^输入(?:\s|≈)/.test(text)) return "log-input";
    if (/^缓存(?:读|写)\s/.test(text)) return "log-cache";
    if (/^输出\s/.test(text)) return "log-output";
    if (/^(?:首字节|共)\s|^\d+(?:\.\d+)?(?:ms|s|m\d+s)$/.test(text)) return "log-duration";
    const status = /^(?:上游 |HTTP )?([1-5]\d{2})(?:\s|$)/.exec(text);
    if (status) return Number(status[1]) >= 400 ? "log-status-error" : Number(status[1]) >= 300 ? "log-status-warning" : "log-status-success";
    if (/错误|失败|异常:|断流/.test(text)) return "log-status-error";
    if (/重试|流未收尾|警告/.test(text)) return "log-status-warning";
    if (/^(?:direct|流式|\[[^\]]+适配\])$/.test(text)) return "log-muted";
    return "log-detail";
  }

  function renderLogLine(raw) {
    const line = String(raw ?? "");
    const row = document.createElement("span");
    const match = /^(\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?\])(\s+)(\[[^\]]+\])?(\s*)([→←✗⚠↻⊘])?(\s*)(.*)$/.exec(line);
    if (!match) {
      row.className = "log-line log-line-system";
      row.textContent = line;
      return row;
    }

    const [, time, space, id, afterId, symbol, afterSymbol, message] = match;
    const kinds = { "→": "start", "←": "success", "✗": "error", "⚠": "warning", "↻": "warning", "⊘": "cancel" };
    row.className = "log-line log-line-" + (kinds[symbol] || "system");
    appendLogText(row, time, "log-time");
    appendLogText(row, space, "log-space");
    appendLogText(row, id, "log-id");
    appendLogText(row, afterId, "log-space");
    appendLogText(row, symbol, "log-event");
    appendLogText(row, afterSymbol, "log-space");

    if (!symbol) {
      appendLogText(row, message, "log-detail");
      return row;
    }
    const parts = message.split(/( · )/);
    parts.forEach((part, index) => {
      if (index % 2) appendLogText(row, part, "log-separator");
      else if (index === 0) appendLogHeader(row, part);
      else appendLogText(row, part, logDetailClass(part));
    });
    return row;
  }

  function renderLogs(data) {
    els.logsTruncatedWarning.classList.toggle("hidden", !data.truncated);
    const lines = Array.isArray(data.lines) ? data.lines : [];
    // 同一通道与筛选条件下，上次最后一行之后的内容视为新到达
    const viewKey = [state.logs.source, state.logs.errorsOnly, state.logs.q].join("\u0001");
    const previous = state.logs.rawLines;
    let firstNew = lines.length;
    if (viewKey === state.logs.viewKey && previous.length) {
      const anchor = lines.lastIndexOf(previous[previous.length - 1]);
      if (anchor >= 0) firstNew = Math.max(anchor + 1, lines.length - 50);
    }
    state.logs.viewKey = viewKey;
    state.logs.rawLines = lines;

    els.logsTerminal.replaceChildren(...lines.map((line, index) => {
      const row = renderLogLine(line);
      if (index >= firstNew) row.className += " log-line-new";
      return row;
    }));

    // 自动跟随滚动到底部
    if (state.logs.follow) {
      els.logsTerminal.scrollTop = els.logsTerminal.scrollHeight;
    }
  }

  function downloadVisibleLogs() {
    const text = state.logs.rawLines.join("\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gateway-${state.logs.source}-${Date.now()}.log`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  // --- 视图 3: 基础设置 (Settings) ---
  function renderSettingsMode() {
    els.settingsReadonly.classList.toggle("hidden", state.settings.isEditing);
    els.settingsEditor.classList.toggle("hidden", !state.settings.isEditing);
    els.settingsErrorsBanner.classList.add("hidden");
    if (state.settings.isEditing) syncStickyOffset();
    updateSettingsDirty();
  }

  function settingsText(parent, tag, className, value) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = String(value ?? "—");
    parent.appendChild(node);
    return node;
  }

  // 只读视图里的“编辑 / 添加”按钮：data-settings-open="provider:0" / "route:new"
  function settingsOpenButton(target, label, title) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-ghost btn-compact settings-open-btn";
    button.setAttribute("data-settings-open", target);
    button.textContent = label;
    button.title = title;
    return button;
  }

  function renderSettingsReadonly(config) {
    const providers = config.providers || [];
    const routes = config.routes || [];
    els.settingsProviderCount.textContent = formatNumber(providers.length);
    els.settingsRouteCount.textContent = formatNumber(routes.length);
    els.settingsDefaultRoute.textContent = config.defaultRoute || "未设置";
    els.settingsLogRequests.textContent = config.logRequests ? "已开启" : "已关闭";

    els.settingsProvidersReadonly.replaceChildren();
    if (!providers.length) settingsText(els.settingsProvidersReadonly, "p", "settings-empty", "暂无上游提供商");
    providers.forEach((provider, index) => {
      const details = document.createElement("details");
      details.className = "settings-provider";
      const summary = document.createElement("summary");

      const headLeft = document.createElement("div");
      headLeft.className = "settings-provider-summary-left";
      settingsText(headLeft, "strong", "settings-provider-name", provider.name || "未命名提供商");
      settingsText(headLeft, "span", "settings-provider-protocol", (provider.apiType || "anthropic").toUpperCase());
      summary.appendChild(headLeft);

      const headRight = document.createElement("div");
      headRight.className = "settings-provider-summary-right";
      settingsText(headRight, "span", "settings-provider-url num-font", provider.baseUrl || "未设置地址");
      headRight.appendChild(settingsOpenButton("provider:" + index, "编辑", "直接修改提供商 " + (provider.name || "")));
      summary.appendChild(headRight);

      details.appendChild(summary);

      const body = document.createElement("div");
      body.className = "settings-provider-details";
      const fields = [
        ["客户端配置", provider.clientProfile || "auto"],
        ["API 密钥", provider.hasApiKey ? "已配置" : "未配置"],
        ["最大并发", provider.maxConcurrency],
        ["最大尝试", provider.maxAttempts],
        ["连接超时", provider.connectTimeoutMs == null ? "—" : provider.connectTimeoutMs + " ms"],
        ["请求超时", provider.requestTimeoutMs == null ? "—" : provider.requestTimeoutMs + " ms"]
      ];
      fields.forEach(([label, value]) => {
        const field = document.createElement("div");
        settingsText(field, "span", "settings-field-label", label);
        settingsText(field, "strong", "settings-field-value num-font", value);
        body.appendChild(field);
      });
      const models = Object.entries(provider.models || {});
      const mapping = document.createElement("div");
      mapping.className = "settings-model-mapping";
      settingsText(mapping, "span", "settings-field-label", "模型映射");
      if (models.length) {
        models.forEach(([alias, target]) => {
          const pair = document.createElement("div");
          settingsText(pair, "code", "", alias);
          settingsText(pair, "span", "", "→");
          settingsText(pair, "code", "", typeof target === "string" ? target : JSON.stringify(target));
          mapping.appendChild(pair);
        });
      } else settingsText(mapping, "span", "settings-empty", "无映射");
      body.appendChild(mapping);
      const multRows = readMultiplierRows(provider);
      const mult = document.createElement("div");
      mult.className = "settings-model-mapping";
      settingsText(mult, "span", "settings-field-label", "价格倍率");
      if (multRows.length) {
        multRows.forEach((row) => {
          const pair = document.createElement("div");
          settingsText(pair, "code", "", row.model === "*" ? "*（默认）" : row.model);
          settingsText(pair, "span", "num-font", multiplierText(row));
          mult.appendChild(pair);
        });
      } else settingsText(mult, "span", "settings-empty", "按原价");
      body.appendChild(mult);
      details.appendChild(body);
      els.settingsProvidersReadonly.appendChild(details);
    });

    els.settingsRoutesReadonly.replaceChildren();
    if (!routes.length) {
      const row = document.createElement("tr");
      const cell = settingsText(row, "td", "settings-empty", "暂无路由映射规则");
      cell.colSpan = 5;
      els.settingsRoutesReadonly.appendChild(row);
    }
    routes.forEach((route, index) => {
      const row = document.createElement("tr");
      [route.alias, route.provider, route.model || "原样转发", route.clientProfile || "auto"]
        .forEach((value) => settingsText(row, "td", "num-font", value));
      const action = document.createElement("td");
      action.className = "td-action";
      action.appendChild(settingsOpenButton("route:" + index, "编辑", "直接修改路由 " + (route.alias || "")));
      row.appendChild(action);
      els.settingsRoutesReadonly.appendChild(row);
    });

    els.settingsPricingReadonly.replaceChildren();
    const pricingRows = readPricingRows(config);
    if (!pricingRows.length) {
      const row = document.createElement("tr");
      const cell = settingsText(row, "td", "settings-empty", "暂无模型价格");
      cell.colSpan = 6;
      els.settingsPricingReadonly.appendChild(row);
    }
    pricingRows.forEach((price, index) => {
      const row = document.createElement("tr");
      [price.model, ...PRICE_FIELDS.map(([k]) => "$" + price[k])].forEach((value) => settingsText(row, "td", "num-font", value));
      const action = document.createElement("td");
      action.className = "td-action";
      action.appendChild(settingsOpenButton("pricing:" + index, "编辑", "直接修改 " + (price.model || "") + " 的价格"));
      row.appendChild(action);
      els.settingsPricingReadonly.appendChild(row);
    });
  }

  function leaveSettingsEditor() {
    state.settings.draft = JSON.parse(state.settings.initialDraftJson || "null");
    state.settings.isEditing = false;
    renderSettingsMode();
    if (state.settings.draft) renderSettingsReadonly(state.settings.draft);
  }


  // --- 日志清理逻辑 ---
  async function executeClearLogs() {
    if (state.isClearingLogs) return;
    state.isClearingLogs = true;
    els.btnConfirmClearLogs.disabled = true;
    els.btnConfirmClearLogs.textContent = "清空中...";
    els.clearLogsErrorMsg.classList.add("hidden");

    try {
      const res = await fetch("/api/logs/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "清理日志失败 (" + res.status + ")");
      }
      els.modalClearLogs.classList.add("hidden");
      let freedBytes = 0;
      if (Array.isArray(data.cleared)) {
        freedBytes = data.cleared.reduce((acc, f) => acc + (f.bytes || 0), 0);
      }
      const freedKb = (freedBytes / 1024).toFixed(1);
      showToast("已清空请求日志，释放 " + freedKb + " KB 空间", "info");
      await fetchLogs();
    } catch (err) {
      els.clearLogsErrorMsg.textContent = err.message;
      els.clearLogsErrorMsg.classList.remove("hidden");
    } finally {
      state.isClearingLogs = false;
      els.btnConfirmClearLogs.disabled = false;
      els.btnConfirmClearLogs.textContent = "确认清空";
    }
  }

  async function fetchSettings() {
    try {
      const res = await apiFetch("/api/settings");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      state.settings.serverRevision = data.revision;
      // 深拷贝作为工作草稿
      state.settings.draft = toSettingsDraft(data);
      state.settings.initialDraftJson = JSON.stringify(state.settings.draft);
      renderSettings(state.settings.draft);
      renderSettingsReadonly(data);
      renderSettingsMode();
    } catch (err) {
      if (err.message !== "401 Unauthorized") {
        showToast("加载设置失败: " + err.message, "error");
      }
    }
  }

  // 价格与倍率在草稿里用数组行编辑（模型名可改），保存时再转回对象
  function priceRows(obj, fill) {
    return Object.entries(obj || {}).map(([model, v]) => {
      const row = { model };
      PRICE_FIELDS.forEach(([k]) => { row[k] = v?.[k] ?? fill; });
      return row;
    });
  }
  function toSettingsDraft(data) {
    const draft = JSON.parse(JSON.stringify(data));
    draft.pricingRows = priceRows(draft.pricing, 0);
    delete draft.pricing;
    (draft.providers || []).forEach((p) => {
      p.multiplierRows = priceRows(p.priceMultipliers, 1);
      delete p.priceMultipliers;
    });
    return draft;
  }
  function rowsToObject(rows, label, errors) {
    const out = {};
    (rows || []).forEach((row, i) => {
      const model = String(row.model || "").trim();
      if (!model) { errors.push(label + " 第 " + (i + 1) + " 行缺少模型名"); return; }
      if (Object.hasOwn(out, model)) { errors.push(label + " 模型重复: " + model); return; }
      out[model] = {};
      PRICE_FIELDS.forEach(([k, name]) => {
        const n = Number(row[k]);
        if (row[k] === "" || !Number.isFinite(n) || n < 0) errors.push(label + " " + model + " 的" + name + "必须是大于等于 0 的数字");
        else out[model][k] = n;
      });
    });
    return out;
  }
  // 读取模式可能拿到服务端原始对象，也可能拿到草稿行
  const readPricingRows = (c) => c.pricingRows || priceRows(c.pricing, 0);
  const readMultiplierRows = (p) => p.multiplierRows || priceRows(p.priceMultipliers, 1);

  // 价格 / 倍率编辑表格的一行：模型名 + 四项数字 + 删除
  function priceEditRow(row, placeholder, onDelete) {
    const tr = document.createElement("tr");
    const tdModel = document.createElement("td");
    const inModel = document.createElement("input");
    inModel.type = "text";
    inModel.className = "form-input num-font";
    inModel.value = row.model || "";
    inModel.placeholder = placeholder;
    inModel.addEventListener("input", (e) => { row.model = e.target.value.trim(); });
    tdModel.appendChild(inModel);
    tr.appendChild(tdModel);
    PRICE_FIELDS.forEach(([k, name]) => {
      const td = document.createElement("td");
      const inp = document.createElement("input");
      inp.type = "number";
      inp.min = "0";
      inp.step = "any";
      inp.className = "form-input num-font";
      inp.value = row[k];
      inp.setAttribute("aria-label", name);
      inp.addEventListener("input", (e) => { row[k] = e.target.value; });
      td.appendChild(inp);
      tr.appendChild(td);
    });
    const tdAction = document.createElement("td");
    tdAction.style.textAlign = "center";
    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "btn btn-danger-outline";
    btnDel.textContent = "删除";
    btnDel.addEventListener("click", onDelete);
    tdAction.appendChild(btnDel);
    tr.appendChild(tdAction);
    return tr;
  }

  // 站点倍率行支持快捷编辑：统一倍率会同步覆盖输入、输出、缓存读、缓存写四项。
  function multiplierEditRow(row, placeholder, onDelete) {
    const tr = document.createElement("tr");
    const tdModel = document.createElement("td");
    const inModel = document.createElement("input");
    inModel.type = "text";
    inModel.className = "form-input num-font";
    inModel.value = row.model || "";
    inModel.placeholder = placeholder;
    inModel.addEventListener("input", (e) => { row.model = e.target.value.trim(); });
    tdModel.appendChild(inModel);
    tr.appendChild(tdModel);

    const fieldInputs = new Map();
    const commonValue = PRICE_FIELDS.every(([key]) => Number(row[key]) === Number(row.input)) ? row.input : "";
    const tdCommon = document.createElement("td");
    const common = document.createElement("input");
    common.type = "number";
    common.min = "0";
    common.max = "1000";
    common.step = "any";
    common.className = "form-input num-font multiplier-common-input";
    common.value = commonValue;
    common.placeholder = commonValue === "" ? "不一致" : "统一倍率";
    common.title = "填写后同步输入、输出、缓存读、缓存写四项倍率";
    common.setAttribute("aria-label", "统一倍率（同步四项）");
    common.addEventListener("input", (e) => {
      const value = e.target.value;
      PRICE_FIELDS.forEach(([key]) => {
        row[key] = value;
        const input = fieldInputs.get(key);
        if (input) input.value = value;
      });
    });
    tdCommon.appendChild(common);
    tr.appendChild(tdCommon);

    PRICE_FIELDS.forEach(([key, name]) => {
      const td = document.createElement("td");
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.max = "1000";
      input.step = "any";
      input.className = "form-input num-font";
      input.value = row[key];
      input.setAttribute("aria-label", name);
      input.addEventListener("input", (e) => {
        row[key] = e.target.value;
        common.value = multiplierUniformValue(row);
        common.placeholder = common.value === "" ? "不一致" : "统一倍率";
      });
      fieldInputs.set(key, input);
      td.appendChild(input);
      tr.appendChild(td);
    });

    const tdAction = document.createElement("td");
    tdAction.style.textAlign = "center";
    const btnDel = document.createElement("button");
    btnDel.type = "button";
    btnDel.className = "btn btn-danger-outline";
    btnDel.textContent = "删除";
    btnDel.addEventListener("click", onDelete);
    tdAction.appendChild(btnDel);
    tr.appendChild(tdAction);
    return tr;
  }

  function multiplierUniformValue(row) {
    const first = Number(row?.[PRICE_FIELDS[0][0]]);
    if (!Number.isFinite(first)) return "";
    return PRICE_FIELDS.every(([key]) => Number(row[key]) === first) ? row[PRICE_FIELDS[0][0]] : "";
  }

  function renderPricingForm(draft) {
    els.pricingTbody.replaceChildren();
    state.settings.anchors.pricing = [];
    draft.pricingRows = draft.pricingRows || [];
    const rows = draft.pricingRows;
    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = settingsText(tr, "td", "text-center text-muted", "暂无模型价格，未配置价格的模型不计费");
      td.colSpan = 6;
      els.pricingTbody.appendChild(tr);
    }
    rows.forEach((row, idx) => {
      const tr = priceEditRow(row, "上游模型 ID", () => {
        rows.splice(idx, 1);
        renderSettings(draft);
      });
      state.settings.anchors.pricing.push({ el: tr, focus: tr.children[0]?.children[0], text: () => row.model || "" });
      els.pricingTbody.appendChild(tr);
    });
  }

  function renderSettings(draft) {
    if (!draft) return;
    els.settingsErrorsBanner.classList.add("hidden");
    els.settingsErrorsList.innerHTML = "";

    // 全局选项
    els.settingLogRequests.checked = !!draft.logRequests;

    // 默认路由下拉选项
    renderDefaultRouteSelect(draft);

    // 渲染提供商表单
    renderProvidersForm(draft);

    // 渲染路由表单
    renderRoutesForm(draft);

    // 渲染模型价格表单
    renderPricingForm(draft);

    els.settingsJumpProviders.textContent = formatNumber((draft.providers || []).length);
    els.settingsJumpRoutes.textContent = formatNumber((draft.routes || []).length);
    els.settingsJumpPricing.textContent = formatNumber((draft.pricingRows || []).length);
    applySettingsFilter();
    updateSettingsDirty();
  }

  function updateSettingsDirty() {
    const dirty = state.settings.isEditing && isSettingsDirty();
    els.settingsEditorBar.classList.toggle("is-dirty", dirty);
    els.settingsDirtyText.textContent = dirty ? "有未保存的修改" : "尚未修改";
  }

  function applySettingsFilter() {
    const query = String(els.settingsFilter.value || "").trim().toLowerCase();
    Object.values(state.settings.anchors).forEach((list) => list.forEach((anchor) => {
      anchor.el.classList.toggle("is-filtered-out", !!query && !anchor.text().toLowerCase().includes(query));
    }));
  }

  // 滚动到指定条目、闪烁高亮并聚焦第一个输入框
  function focusSettingsItem(kind, index) {
    const list = state.settings.anchors[kind] || [];
    const anchor = index === "last" ? list[list.length - 1] : list[index];
    if (!anchor) return;
    if (anchor.el.classList.contains("is-filtered-out")) {
      els.settingsFilter.value = "";
      applySettingsFilter();
    }
    anchor.el.scrollIntoView?.({ block: "center", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    anchor.el.classList.remove("is-flash");
    void anchor.el.offsetWidth;
    anchor.el.classList.add("is-flash");
    anchor.focus?.focus?.({ preventScroll: true });
  }

  function newProviderDraft() {
    return {
      name: "",
      apiType: "anthropic",
      baseUrl: "https://api.anthropic.com",
      clientProfile: "auto",
      maxConcurrency: 3,
      maxAttempts: 4,
      connectTimeoutMs: 30000,
      requestTimeoutMs: 600000,
      requireKey: true,
      hasApiKey: false,
      models: {},
      multiplierRows: [],
      _isNew: true,
      _open: true
    };
  }

  // 新条目追加到对应分区末尾后，直接滚动过去并聚焦，不用再手动往下找
  function addSettingsItem(kind) {
    const draft = state.settings.draft;
    if (!draft) return;
    if (kind === "provider") {
      draft.providers = draft.providers || [];
      draft.providers.push(newProviderDraft());
    } else if (kind === "route") {
      draft.routes = draft.routes || [];
      draft.routes.push({ alias: "", provider: (draft.providers || [])[0]?.name || "", model: "", clientProfile: "auto" });
    } else if (kind === "pricing") {
      draft.pricingRows = draft.pricingRows || [];
      draft.pricingRows.push({ model: "", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    } else return;
    renderSettings(draft);
    focusSettingsItem(kind, "last");
  }

  // 只读视图的“编辑 / 添加”：进入编辑模式并直达目标条目
  function openSettingsTarget(target) {
    const draft = state.settings.draft;
    if (!draft) return;
    const [kind, which] = String(target).split(":");
    if (!state.settings.isEditing) {
      state.settings.isEditing = true;
      renderSettingsMode();
    }
    if (which === "new") {
      addSettingsItem(kind);
      return;
    }
    const index = Number(which);
    if (kind === "provider" && draft.providers?.[index]) draft.providers[index]._open = true;
    renderSettings(draft);
    focusSettingsItem(kind, index);
  }

  // 编辑栏吸顶位置要让开当前吸顶的页头（窄屏时是顶部导航）
  function syncStickyOffset() {
    if (typeof window.getComputedStyle !== "function" || !document.documentElement?.style) return;
    const stuck = [document.querySelector(".app-header"), document.querySelector(".app-sidebar")]
      .find((el) => el && window.getComputedStyle(el).position === "sticky" && el.getBoundingClientRect().width > window.innerWidth / 2);
    document.documentElement.style.setProperty("--sticky-top", (stuck ? stuck.offsetHeight : 0) + "px");
  }

  function renderDefaultRouteSelect(draft) {
    const currentVal = draft.defaultRoute || "";
    const opts = ['<option value="">(无默认路由)</option>'];
    (draft.providers || []).forEach((provider) => {
      if (provider.name) {
        opts.push(`<option value="${escapeHtml(provider.name)}">${escapeHtml(provider.name)}</option>`);
      }
    });
    els.settingDefaultRoute.innerHTML = opts.join("");
    els.settingDefaultRoute.value = currentVal;
  }

  function renderProvidersForm(draft) {
    els.providersList.innerHTML = "";
    state.settings.anchors.provider = [];
    const providers = draft.providers || [];

    if (providers.length === 0) {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "text-muted text-center";
      emptyDiv.style.padding = "16px";
      emptyDiv.textContent = "当前未配置任何上游提供商";
      els.providersList.appendChild(emptyDiv);
      return;
    }

    // 提供商多时默认只展开新建的卡片，其余收起为一行摘要，避免整页过长
    const collapseByDefault = providers.length > 2;
    providers.forEach((p, idx) => {
      if (p._open === undefined) p._open = !collapseByDefault;
      const card = document.createElement("div");
      card.className = "provider-card" + (p._open ? " is-open" : "");

      const header = document.createElement("div");
      header.className = "provider-header";

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "provider-toggle";
      toggle.setAttribute("aria-expanded", String(p._open));
      const title = document.createElement("span");
      title.className = "provider-title";
      title.textContent = p.name ? p.name : "(新提供商)";
      const summaryLine = document.createElement("span");
      summaryLine.className = "provider-summary num-font";
      const refreshSummary = () => {
        summaryLine.textContent = [(p.apiType || "anthropic").toUpperCase(), p.baseUrl || "未设置地址", Object.keys(p.models || {}).length + " 个映射"].join(" · ");
      };
      refreshSummary();
      toggle.append(title, summaryLine);
      toggle.addEventListener("click", () => {
        p._open = !p._open;
        card.classList.toggle("is-open", p._open);
        toggle.setAttribute("aria-expanded", String(p._open));
      });

      const actions = document.createElement("div");
      actions.className = "provider-actions";
      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "btn btn-danger-outline";
      btnDel.textContent = "删除";
      btnDel.title = "删除此提供商";
      btnDel.addEventListener("click", () => {
        draft.providers.splice(idx, 1);
        renderSettings(draft);
      });
      actions.appendChild(btnDel);

      header.appendChild(toggle);
      header.appendChild(actions);
      card.appendChild(header);

      const body = document.createElement("div");
      body.className = "provider-body";

      // 第一行: 名称、协议类型、客户端 Profile、Base URL
      const row1 = document.createElement("div");
      row1.className = "sub-grid";

      // 名称: 若已存在则不可修改
      const fName = createFormField("提供商名称 (ID)", "text", p.name || "", (val) => {
        p.name = val.trim();
        title.textContent = p.name || "(新提供商)";
      });
      if (p.name && !p._isNew) {
        fName.querySelector("input").disabled = true;
      }
      row1.appendChild(fName);

      // 协议类型
      const fType = createSelectField("API 协议类型", [
        { label: "Anthropic", value: "anthropic" },
        { label: "OpenAI", value: "openai" },
        { label: "Gemini", value: "gemini" }
      ], p.apiType || "anthropic", (val) => {
        p.apiType = val;
        if (val !== "openai") p.messagesTransport = "auto";
        fTransport.querySelector("select").disabled = val !== "openai";
        fTransport.querySelector("select").value = p.messagesTransport || "auto";
        refreshSummary();
      });
      row1.appendChild(fType);

      const fTransport = createSelectField("Messages 请求出口", [
        { label: "自动（GPT 优先 Responses）", value: "auto" },
        { label: "Responses", value: "responses" },
        { label: "Chat Completions", value: "chat-completions" }
      ], p.messagesTransport || "auto", (val) => { p.messagesTransport = val; });
      fTransport.querySelector("select").disabled = p.apiType !== "openai";
      row1.appendChild(fTransport);

      // 客户端 profile
      const fProfile = createSelectField("客户端 Profile", [
        { label: "auto", value: "auto" },
        { label: "claude", value: "claude" },
        { label: "codex", value: "codex" }
      ], p.clientProfile || "auto", (val) => {
        p.clientProfile = val;
      });
      row1.appendChild(fProfile);

      // Base URL
      const fUrl = createFormField("API Base URL", "text", p.baseUrl || "", (val) => {
        p.baseUrl = val.trim();
        refreshSummary();
      });
      row1.appendChild(fUrl);

      body.appendChild(row1);

      // 第二行: API Key 与数值限额
      const row2 = document.createElement("div");
      row2.className = "sub-grid";

      const keyPlaceholder = p.hasApiKey ? "(已配置密钥，留空保持不变)" : "(未配置 API 密钥)";
      const fKey = createFormField("API 密钥 (apiKey)", "password", "", (val) => {
        p.apiKey = val; // 留空则在提交时不覆盖
      }, keyPlaceholder);
      row2.appendChild(fKey);

      const fConcurrency = createFormField("最大并发数 (maxConcurrency)", "number", p.maxConcurrency ?? 3, (val) => {
        p.maxConcurrency = parseInt(val, 10) || 1;
      });
      row2.appendChild(fConcurrency);

      const fAttempts = createFormField("重试次数 (maxAttempts)", "number", p.maxAttempts ?? 4, (val) => {
        p.maxAttempts = parseInt(val, 10) || 1;
      });
      row2.appendChild(fAttempts);

      const fConnTimeout = createFormField("连接超时 (connectTimeoutMs)", "number", p.connectTimeoutMs ?? 30000, (val) => {
        p.connectTimeoutMs = parseInt(val, 10) || 30000;
      });
      row2.appendChild(fConnTimeout);

      const fReqTimeout = createFormField("请求超时 (requestTimeoutMs)", "number", p.requestTimeoutMs ?? 600000, (val) => {
        p.requestTimeoutMs = parseInt(val, 10) || 600000;
      });
      row2.appendChild(fReqTimeout);

      body.appendChild(row2);

      // 第三行: 模型映射关系 (JSON 字符串编辑)
      const modelsWrap = document.createElement("div");
      modelsWrap.className = "form-group";
      const lbl = document.createElement("label");
      lbl.className = "form-label";
      lbl.textContent = "模型别名映射 (models 映射字典 JSON)";
      const txt = document.createElement("textarea");
      txt.className = "form-textarea num-font";
      txt.rows = 3;
      txt.value = JSON.stringify(p.models || {}, null, 2);
      txt.addEventListener("change", () => {
        try {
          p.models = JSON.parse(txt.value);
          refreshSummary();
          updateSettingsDirty();
        } catch {
          showToast("模型映射 JSON 格式不合法", "error");
        }
      });
      modelsWrap.appendChild(lbl);
      modelsWrap.appendChild(txt);
      body.appendChild(modelsWrap);

      // 第四行: 站点价格倍率（逐项，默认折叠）
      p.multiplierRows = p.multiplierRows || [];
      const multWrap = document.createElement("details");
      multWrap.className = "form-group provider-multipliers";
      multWrap.open = p._multOpen === true;
      multWrap.addEventListener("toggle", () => { p._multOpen = multWrap.open; });
      const multSummary = document.createElement("summary");
      multSummary.className = "form-label";
      multSummary.textContent = "站点价格倍率（" + (p.multiplierRows.length ? p.multiplierRows.length + " 条" : "未设置，按原价") + "）";
      multWrap.appendChild(multSummary);
      settingsText(multWrap, "p", "text-muted", "在全局模型原价上逐项相乘；统一倍率可一次同步四项，模型填 * 表示该站点其余模型的默认倍率。");
      const multTableWrap = document.createElement("div");
      multTableWrap.className = "table-scroll-wrap";
      const multTable = document.createElement("table");
      multTable.className = "data-table";
      const multHead = document.createElement("thead");
      const headRow = document.createElement("tr");
      ["模型 ID（* 为默认）", "统一倍率", "输入", "输出", "缓存读", "缓存写", "操作"].forEach((h) => settingsText(headRow, "th", "", h));
      multHead.appendChild(headRow);
      multTable.appendChild(multHead);
      const multBody = document.createElement("tbody");
      p.multiplierRows.forEach((row, rIdx) => {
        multBody.appendChild(multiplierEditRow(row, "模型 ID 或 *", () => {
          p.multiplierRows.splice(rIdx, 1);
          renderSettings(draft);
        }));
      });
      multTable.appendChild(multBody);
      multTableWrap.appendChild(multTable);
      multWrap.appendChild(multTableWrap);
      const btnAddMult = document.createElement("button");
      btnAddMult.type = "button";
      btnAddMult.className = "btn btn-secondary";
      btnAddMult.textContent = "添加倍率";
      btnAddMult.addEventListener("click", () => {
        p.multiplierRows.push({ model: p.multiplierRows.some((r) => r.model === "*") ? "" : "*", input: 1, output: 1, cacheRead: 1, cacheWrite: 1 });
        p._multOpen = true;
        renderSettings(draft);
      });
      multWrap.appendChild(btnAddMult);
      body.appendChild(multWrap);

      card.appendChild(body);
      const firstInput = fName.querySelector("input");
      state.settings.anchors.provider.push({
        el: card,
        focus: firstInput && !firstInput.disabled ? firstInput : toggle,
        text: () => [p.name, p.baseUrl, p.apiType, ...Object.keys(p.models || {}), ...Object.values(p.models || {}).map(String)].join(" ")
      });
      els.providersList.appendChild(card);
    });
  }

  function renderRoutesForm(draft) {
    els.routesTbody.innerHTML = "";
    state.settings.anchors.route = [];
    const routes = draft.routes || [];

    if (routes.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "text-center text-muted";
      td.textContent = "暂无路由映射规则";
      tr.appendChild(td);
      els.routesTbody.appendChild(tr);
      return;
    }

    const providerNames = (draft.providers || []).map((p) => p.name).filter(Boolean);

    routes.forEach((r, idx) => {
      const tr = document.createElement("tr");

      // 路由别名
      const tdAlias = document.createElement("td");
      const inAlias = document.createElement("input");
      inAlias.type = "text";
      inAlias.className = "form-input num-font";
      inAlias.value = r.alias || "";
      inAlias.addEventListener("input", (e) => {
        r.alias = e.target.value.trim();
        renderDefaultRouteSelect(draft);
      });
      tdAlias.appendChild(inAlias);
      tr.appendChild(tdAlias);

      // 目标提供商
      const tdProvider = document.createElement("td");
      const selProvider = document.createElement("select");
      selProvider.className = "form-select";
      providerNames.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        if (name === r.provider) opt.selected = true;
        selProvider.appendChild(opt);
      });
      selProvider.addEventListener("change", (e) => {
        r.provider = e.target.value;
      });
      tdProvider.appendChild(selProvider);
      tr.appendChild(tdProvider);

      // 上游模型名
      const tdModel = document.createElement("td");
      const inModel = document.createElement("input");
      inModel.type = "text";
      inModel.className = "form-input num-font";
      inModel.value = r.model || "";
      inModel.placeholder = "(留空则原样转发)";
      inModel.addEventListener("input", (e) => {
        r.model = e.target.value.trim();
      });
      tdModel.appendChild(inModel);
      tr.appendChild(tdModel);

      // 客户端配置文件 Profile
      const tdProfile = document.createElement("td");
      const selProfile = document.createElement("select");
      selProfile.className = "form-select";
      ["auto", "claude", "codex"].forEach((prof) => {
        const opt = document.createElement("option");
        opt.value = prof;
        opt.textContent = prof;
        if (prof === (r.clientProfile || "auto")) opt.selected = true;
        selProfile.appendChild(opt);
      });
      selProfile.addEventListener("change", (e) => {
        r.clientProfile = e.target.value;
      });
      tdProfile.appendChild(selProfile);
      tr.appendChild(tdProfile);

      // 操作
      const tdAction = document.createElement("td");
      tdAction.style.textAlign = "center";
      const btnDel = document.createElement("button");
      btnDel.type = "button";
      btnDel.className = "btn btn-danger-outline";
      btnDel.textContent = "删除";
      btnDel.addEventListener("click", () => {
        draft.routes.splice(idx, 1);
        renderSettings(draft);
      });
      tdAction.appendChild(btnDel);
      tr.appendChild(tdAction);

      state.settings.anchors.route.push({ el: tr, focus: inAlias, text: () => [r.alias, r.provider, r.model, r.clientProfile].join(" ") });
      els.routesTbody.appendChild(tr);
    });
  }

  function createFormField(labelText, type, value, onChange, placeholder = "") {
    const wrap = document.createElement("div");
    wrap.className = "form-group";
    const lbl = document.createElement("label");
    lbl.className = "form-label";
    lbl.textContent = labelText;
    const inp = document.createElement("input");
    inp.type = type;
    inp.className = "form-input" + (type === "number" ? " num-font" : "");
    inp.value = value;
    if (placeholder) inp.placeholder = placeholder;
    inp.addEventListener("input", (e) => onChange(e.target.value));
    wrap.appendChild(lbl);
    wrap.appendChild(inp);
    return wrap;
  }

  function createSelectField(labelText, options, selectedValue, onChange) {
    const wrap = document.createElement("div");
    wrap.className = "form-group";
    const lbl = document.createElement("label");
    lbl.className = "form-label";
    lbl.textContent = labelText;
    const sel = document.createElement("select");
    sel.className = "form-select";
    options.forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === selectedValue) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", (e) => onChange(e.target.value));
    wrap.appendChild(lbl);
    wrap.appendChild(sel);
    return wrap;
  }

  // --- 保存设置与校验 ---
  async function saveSettings() {
    const draft = state.settings.draft;
    if (!draft) return;

    // 同步顶层表单字段
    draft.logRequests = els.settingLogRequests.checked;
    draft.defaultRoute = els.settingDefaultRoute.value || null;

    // 客户端初步校验
    const errors = [];
    const providerNames = new Set();
    (draft.providers || []).forEach((p, i) => {
      if (!p.name) errors.push("第 " + (i + 1) + " 个提供商缺少名称");
      else if (providerNames.has(p.name)) errors.push("提供商名称重复: " + p.name);
      else providerNames.add(p.name);

      if (!p.baseUrl) errors.push("提供商 " + (p.name || "") + " 缺少 Base URL");
    });

    (draft.routes || []).forEach((r, i) => {
      if (!r.alias) errors.push("第 " + (i + 1) + " 条路由缺少别名");
      if (!r.provider) errors.push("路由 " + (r.alias || "") + " 缺少目标提供商");
    });

    // 行 → 对象：pricing 与各提供商 priceMultipliers
    const payload = JSON.parse(JSON.stringify(draft));
    payload.pricing = rowsToObject(draft.pricingRows, "模型价格", errors);
    delete payload.pricingRows;
    (payload.providers || []).forEach((p, i) => {
      p.priceMultipliers = rowsToObject(draft.providers[i].multiplierRows, "提供商 " + (p.name || i + 1) + " 倍率", errors);
      delete p.multiplierRows;
      Object.keys(p).forEach((key) => { if (key.startsWith("_")) delete p[key]; });
    });

    if (errors.length > 0) {
      showSettingsErrors(errors);
      return;
    }

    try {
      els.btnSaveSettings.disabled = true;
      els.btnSaveSettings.textContent = "保存中...";

      const res = await apiFetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || ("HTTP " + res.status));
      }

      const updated = await res.json();
      state.settings.serverRevision = updated.revision;
      state.settings.draft.revision = updated.revision;
      state.settings.initialDraftJson = JSON.stringify(state.settings.draft);

      if (updated.reloadApplied === false) {
        els.restartBadge.classList.remove("hidden");
        const reason = updated.reloadError ? (": " + updated.reloadError) : "";
        showToast("设置已保存，但尚未确认生效" + reason, "warning");
      } else if (updated.reloadApplied === true && updated.restartRequired === true) {
        els.restartBadge.classList.remove("hidden");
        showToast("价格已生效，其他设置需重启", "info");
      } else {
        els.restartBadge.classList.add("hidden");
        showToast("设置已保存并生效", "success");
      }

      state.settings.isEditing = false;
      renderSettingsReadonly(state.settings.draft);
      renderSettingsMode();
      await fetchSettings();
    } catch (err) {
      if (err.message !== "401 Unauthorized") {
        showSettingsErrors([err.message]);
        showToast("保存失败: " + err.message, "error");
      }
    } finally {
      els.btnSaveSettings.disabled = false;
      els.btnSaveSettings.innerHTML = `<svg class="lucide-icon" viewBox="0 0 24 24"><use href="#icon-save"/></svg><span>保存配置</span>`;
    }
  }

  function showSettingsErrors(errors) {
    els.settingsErrorsBanner.classList.remove("hidden");
    els.settingsErrorsList.innerHTML = "";
    errors.forEach((e) => {
      const div = document.createElement("div");
      div.textContent = e;
      els.settingsErrorsList.appendChild(div);
    });
  }

  // --- 网关重启管理 ---
  async function restartGateway() {
    if (state.isRestarting || state.activeRequestsCount > 0) return;
    state.isRestarting = true;
    updateRestartButtonState();
    try {
      els.btnConfirmRestart.textContent = "重启中...";
      els.restartErrorMsg.classList.add("hidden");

      const res = await apiFetch("/api/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || ("HTTP " + res.status));
      }

      els.modalRestart.classList.add("hidden");
      els.restartBadge.classList.add("hidden");
      showToast("网关重启指令已发送，正在重新连接...", "success");

      // 稍后刷新概览
      setTimeout(() => {
        fetchOverview();
      }, 1500);
    } catch (err) {
      if (err.message !== "401 Unauthorized") {
        els.restartErrorMsg.textContent = err.message;
        els.restartErrorMsg.classList.remove("hidden");
      }
    } finally {
      state.isRestarting = false;
      updateRestartButtonState();
      els.btnConfirmRestart.textContent = "确认重启";
    }
  }

  // --- 事件绑定初始化 ---
  function initEvents() {
    // 导航标签点击
    els.navTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const view = tab.dataset.view;
        if (view) switchView(view);
      });
    });

    // 主题与侧栏
    els.btnTheme.addEventListener("click", () => {
      const next = THEME_ORDER[(THEME_ORDER.indexOf(state.theme) + 1) % THEME_ORDER.length];
      writePref("gateway-admin-theme", next);
      applyTheme(next);
    });
    if (typeof window.matchMedia === "function") {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
        if (state.theme === "system") applyTheme("system");
      });
    }
    els.btnCollapseSidebar.addEventListener("click", () => {
      const collapsed = !document.body?.classList.contains("sidebar-collapsed");
      writePref("gateway-admin-sidebar", collapsed ? "collapsed" : "expanded");
      applySidebarCollapsed(collapsed);
    });

    els.sbAgents.addEventListener("scroll", () => drawSwitchboardWires(), { passive: true });
    els.sbLines.addEventListener("scroll", () => drawSwitchboardWires(), { passive: true });
    els.sbAgents.addEventListener("click", (e) => {
      const button = e.target.closest?.(".sb-agent-btn");
      if (!button) return;
      const name = button.getAttribute("data-agent");
      state.switchboard.selectedAgent = state.switchboard.selectedAgent === name ? null : name;
      renderSwitchboardAgents();
      renderSwitchboardLines();
      renderSwitchboardAdapters(state.switchboard.liveUnknown);
      drawSwitchboardWires();
    });
    // 上游默认只看正在被调用的模型，可切换为显示全部
    els.sbUpstreamToggle.addEventListener("click", () => {
      state.switchboard.showAllUpstreams = !state.switchboard.showAllUpstreams;
      renderSwitchboardLines();
      renderSwitchboardAdapters(state.switchboard.liveUnknown);
      drawSwitchboardWires();
    });

    // 交换台：点一条线路只看该提供商，再点一次恢复全部
    els.sbLines.addEventListener("click", (e) => {
      const btn = e.target.closest?.(".sb-line-btn");
      if (!btn) return;
      const name = btn.getAttribute("data-provider") || "";
      state.providerFilter = state.providerFilter === name ? "" : name;
      clearLiveTopology();
      state.liveSnapshot = null;
      state.inflightDisplay.clear();
      els.filterProvider.value = state.providerFilter;
      state.trendNeedsReveal = true;
      fetchOverview();
    });
    els.sbEmpty.addEventListener("click", (e) => {
      const target = e.target.closest?.("[data-goto]");
      if (target) switchView(target.getAttribute("data-goto"));
    });

    // 概览时间范围：常用预设 / “更多”面板里的细粒度预设与自定义起止
    els.filterPeriod.addEventListener("click", (e) => {
      const btn = e.target.closest(".seg-btn");
      if (!btn) return;
      setRange({ period: btn.getAttribute("data-value") || btn.dataset?.value || "today" });
    });
    els.btnTimePicker.addEventListener("click", (e) => {
      e.stopPropagation?.();
      toggleTimePicker();
    });
    els.timeQuick.addEventListener("click", (e) => {
      const btn = e.target.closest?.("[data-value]");
      if (!btn) return;
      toggleTimePicker(false);
      setRange({ period: btn.getAttribute("data-value") });
    });
    els.btnApplyRange.addEventListener("click", applyCustomRange);
    els.timePickerPanel.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target?.tagName === "INPUT") {
        e.preventDefault();
        applyCustomRange();
      }
    });
    // 点面板外或按 Esc 收起
    document.addEventListener("click", (e) => {
      if (els.timePickerPanel.classList.contains("hidden") || e.target.closest?.("#time-picker")) return;
      toggleTimePicker(false);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || els.timePickerPanel.classList.contains("hidden")) return;
      toggleTimePicker(false);
      els.btnTimePicker.focus?.();
    });
    els.btnTrendZoomOut.addEventListener("click", zoomOutRange);
    els.trendStep.addEventListener("change", (e) => {
      state.trendStep = e.target.value || "auto";
      state.trendActiveIndex = null;
      state.trendPinned = false;
      state.trendNeedsReveal = true;
      fetchOverview();
    });

    // 提供商下拉筛选
    els.filterProvider.addEventListener("change", (e) => {
      state.providerFilter = e.target.value;
      clearLiveTopology();
      state.liveSnapshot = null;
      state.inflightDisplay.clear();
      state.trendNeedsReveal = true;
      fetchOverview();
    });

    // 手动刷新概览
    els.btnRefreshOverview.addEventListener("click", () => {
      spinIcon(els.btnRefreshOverview);
      fetchOverview();
    });
    els.btnAutoRefresh.addEventListener("click", () => {
      const enabled = !state.autoRefresh;
      writePref("gateway-admin-auto-refresh", enabled ? "on" : "off");
      applyAutoRefresh(enabled);
      if (enabled) fetchOverview();
    });
    // 切回页面或网络恢复时立即补一次刷新，不必等下一轮
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state.autoRefresh && (state.activeView === "overview" || state.activeView === "usage")) fetchOverview();
    });
    window.addEventListener("online", () => {
      if (!document.hidden && (state.activeView === "overview" || state.activeView === "usage")) fetchOverview();
    });
    els.btnReconnectSession?.addEventListener("click", async () => {
      const ok = await refreshLocalSession();
      if (!ok) {
        showToast("无法连接到本地管理服务，请确认服务正在运行", "error");
        return;
      }
      els.authExpiredBanner?.classList.add("hidden");
      showToast("已重新连接本地管理服务", "success");
      if (state.activeView === "logs") fetchLogs();
      else if (state.activeView === "settings") fetchSettings();
      else if (state.activeView === "subagents") window.Subagents?.load();
      else fetchOverview();
    });

    // 趋势图指标切换 (Tokens / Cost)
    els.trendMetricToggle.addEventListener("click", (e) => {
      const btn = e.target.closest(".seg-btn");
      if (!btn) return;
      els.trendMetricToggle.querySelectorAll(".seg-btn").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-checked", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-checked", "true");
      state.trendMetric = btn.dataset.metric;
      state.trendActiveIndex = null;
      state.trendPinned = false;
      renderTrendLegend();
      renderTrendDataTable();
      revealTrendChart();
    });

    // 图例：点击隐藏/显示某个模型，双击只看它（再双击恢复全部）
    els.trendLegend.addEventListener("click", (e) => {
      const item = e.target.closest?.("[data-series]");
      if (item) toggleTrendSeries(item.getAttribute("data-series"));
    });
    els.trendLegend.addEventListener("dblclick", (e) => {
      const item = e.target.closest?.("[data-series]");
      if (item) toggleTrendSeries(item.getAttribute("data-series"), true);
    });

    // 趋势图：悬停读数，点击钉住；按住拖动框选一段放大，双击或回车放大到该分桶
    els.trendCanvas.addEventListener("pointerdown", (event) => {
      state.trendSkipClick = false;
      if (event.pointerType === "touch" || event.button !== 0 || !state.trendPoints.length) return;
      const x = trendCanvasX(event.clientX);
      state.trendBrush = { startX: x, x, active: false };
      els.trendCanvas.setPointerCapture?.(event.pointerId);
    });
    els.trendCanvas.addEventListener("pointermove", (event) => {
      const brush = state.trendBrush;
      if (brush) {
        brush.x = trendCanvasX(event.clientX);
        if (!brush.active && Math.abs(brush.x - brush.startX) >= 6) brush.active = true;
        if (brush.active) {
          drawTrendChart();
          return;
        }
      }
      if (state.trendPinned || event.pointerType === "touch") return;
      selectTrendPoint(trendPointAt(event.clientX));
    });
    els.trendCanvas.addEventListener("pointerup", (event) => {
      const brush = state.trendBrush;
      if (!brush) return;
      state.trendBrush = null;
      els.trendCanvas.releasePointerCapture?.(event.pointerId);
      if (!brush.active) return;
      // 松开后浏览器还会补发一次 click，别把它当成“钉住”
      state.trendSkipClick = true;
      const range = trendBrushRange(brush);
      drawTrendChart();
      if (range) zoomTrendTo(range[0], range[1]);
    });
    els.trendCanvas.addEventListener("pointercancel", () => {
      if (!state.trendBrush) return;
      state.trendBrush = null;
      drawTrendChart();
    });
    els.trendCanvas.addEventListener("pointerleave", () => {
      if (!state.trendPinned && !state.trendBrush) selectTrendPoint(null);
    });
    els.trendCanvas.addEventListener("click", (event) => {
      if (state.trendSkipClick) {
        state.trendSkipClick = false;
        return;
      }
      const index = trendPointAt(event.clientX);
      if (index === null) return;
      const unpin = state.trendPinned && state.trendActiveIndex === index;
      state.trendPinned = !unpin;
      selectTrendPoint(unpin ? null : index);
    });
    els.trendCanvas.addEventListener("dblclick", (event) => {
      const index = trendPointAt(event.clientX);
      if (index !== null) zoomTrendTo(...trendBucketBounds(index));
    });
    els.trendCanvas.addEventListener("keydown", (event) => {
      const keys = ["ArrowLeft", "ArrowRight", "Home", "End", "Escape", "Enter"];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Escape") {
        state.trendPinned = false;
        selectTrendPoint(null);
        return;
      }
      if (event.key === "Enter") {
        if (state.trendActiveIndex != null) zoomTrendTo(...trendBucketBounds(state.trendActiveIndex));
        return;
      }
      const points = state.trendPoints.filter((point) => point.value !== null);
      if (!points.length) return;
      const position = points.findIndex((point) => point.index === state.trendActiveIndex);
      const next = event.key === "Home" ? 0
        : event.key === "End" ? points.length - 1
          : event.key === "ArrowRight" ? Math.min(points.length - 1, position + 1)
            : position < 0 ? points.length - 1 : Math.max(0, position - 1);
      state.trendPinned = true;
      selectTrendPoint(points[next].index);
    });

    // 日志通道切换 (out / err)
    els.logsSource.addEventListener("click", (e) => {
      const btn = e.target.closest(".seg-btn");
      if (!btn) return;
      els.logsSource.querySelectorAll(".seg-btn").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-checked", "false");
      });
      btn.classList.add("active");
      btn.setAttribute("aria-checked", "true");
      state.logs.source = btn.dataset.value;
      fetchLogs();
    });

    // 日志错误过滤勾选
    els.logsErrorsToggle.addEventListener("change", (e) => {
      state.logs.errorsOnly = e.target.checked;
      fetchLogs();
    });

    // 日志搜索框回车/输入过滤
    let searchDebounce = null;
    els.logsSearch.addEventListener("input", (e) => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        state.logs.q = e.target.value.trim();
        fetchLogs();
      }, 300);
    });

    // 切换日志自动跟踪 (Follow)
    els.btnToggleFollow.addEventListener("click", () => {
      state.logs.follow = !state.logs.follow;
      els.followText.textContent = state.logs.follow ? "跟踪中" : "已暂停";
      els.btnToggleFollow.classList.toggle("is-following", state.logs.follow);
      const iconUse = els.iconFollowStatus.querySelector("use");
      if (iconUse) {
        iconUse.setAttribute("href", state.logs.follow ? "#icon-pause" : "#icon-play");
      }
      if (state.logs.follow) {
        els.logsTerminal.scrollTop = els.logsTerminal.scrollHeight;
      }
    });

    els.btnClearLogs.addEventListener("click", () => {
      els.clearLogsErrorMsg.classList.add("hidden");
      els.modalClearLogs.classList.remove("hidden");
      els.btnCancelClearLogs.focus();
    });
    els.modalClearLogsClose.addEventListener("click", () => {
      els.modalClearLogs.classList.add("hidden");
    });
    els.btnCancelClearLogs.addEventListener("click", () => {
      els.modalClearLogs.classList.add("hidden");
    });
    els.btnConfirmClearLogs.addEventListener("click", executeClearLogs);

    // 下载/导出日志
    els.btnDownloadLogs.addEventListener("click", () => {
      downloadVisibleLogs();
    });

    // 手动刷新日志
    els.btnRefreshLogs.addEventListener("click", () => {
      spinIcon(els.btnRefreshLogs);
      fetchLogs();
    });

    // 基础设置: 添加提供商
    els.settingLogRequests.addEventListener("change", (event) => {
      if (state.settings.draft) state.settings.draft.logRequests = event.target.checked;
    });
    els.settingDefaultRoute.addEventListener("change", (event) => {
      if (state.settings.draft) state.settings.draft.defaultRoute = event.target.value || null;
    });
    // 基础设置: 添加提供商 / 路由 / 模型价格（分区顶部与末尾按钮共用），添加后直接定位到新条目
    els.btnAddProvider.addEventListener("click", () => addSettingsItem("provider"));
    els.btnAddRoute.addEventListener("click", () => addSettingsItem("route"));
    els.btnAddPricing.addEventListener("click", () => addSettingsItem("pricing"));
    els.settingsEditor.addEventListener("click", (e) => {
      const add = e.target.closest?.("[data-add]");
      if (add) addSettingsItem(add.getAttribute("data-add"));
    });
    // 任意输入都即时刷新“未保存”提示
    els.settingsEditor.addEventListener("input", updateSettingsDirty);
    els.settingsEditor.addEventListener("change", updateSettingsDirty);

    // 常驻操作栏：分区跳转与搜索
    els.settingsJump.addEventListener("click", (e) => {
      const button = e.target.closest?.("[data-jump]");
      if (!button) return;
      document.getElementById(button.getAttribute("data-jump"))?.scrollIntoView?.({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    });
    els.settingsFilter.addEventListener("input", (e) => {
      e.stopPropagation();
      applySettingsFilter();
      // 搜索提供商时自动展开命中的卡片
      const query = String(els.settingsFilter.value || "").trim();
      if (!query || !state.settings.draft) return;
      (state.settings.draft.providers || []).forEach((provider, index) => {
        const anchor = state.settings.anchors.provider[index];
        if (anchor && !anchor.el.classList.contains("is-filtered-out") && !provider._open) {
          provider._open = true;
          anchor.el.classList.add("is-open");
          anchor.el.querySelector(".provider-toggle")?.setAttribute("aria-expanded", "true");
        }
      });
    });
    els.settingsFilter.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      for (const kind of ["provider", "route", "pricing"]) {
        const index = state.settings.anchors[kind].findIndex((anchor) => !anchor.el.classList.contains("is-filtered-out"));
        if (index >= 0) return focusSettingsItem(kind, index);
      }
    });
    const setAllProvidersOpen = (open) => {
      if (!state.settings.draft) return;
      (state.settings.draft.providers || []).forEach((provider) => { provider._open = open; });
      renderSettings(state.settings.draft);
    };
    els.btnExpandProviders.addEventListener("click", () => setAllProvidersOpen(true));
    els.btnCollapseProviders.addEventListener("click", () => setAllProvidersOpen(false));

    // 只读视图：在具体条目旁点“编辑 / 添加”，直接进入编辑并定位
    els.settingsReadonly.addEventListener("click", (e) => {
      const button = e.target.closest?.("[data-settings-open]");
      if (!button) return;
      e.preventDefault();
      openSettingsTarget(button.getAttribute("data-settings-open"));
    });

    // 保存设置按钮
    els.btnEditSettings.addEventListener("click", () => {
      if (!state.settings.draft) return;
      state.settings.isEditing = true;
      renderSettingsMode();
      renderSettings(state.settings.draft);
    });
    els.btnCancelSettings.addEventListener("click", () => {
      if (isSettingsDirty()) {
        state.pendingView = "settings-readonly";
        els.unsavedMessage.textContent = "基础设置中有尚未保存的修改。确定放弃这些修改吗？";
        els.btnUnsavedDiscard.textContent = "放弃修改";
        els.modalUnsaved.classList.remove("hidden");
      } else leaveSettingsEditor();
    });
    els.btnSaveSettings.addEventListener("click", () => {
      saveSettings();
    });

    // 头部重启网关按钮打开对话框
    els.btnOpenRestart.addEventListener("click", () => {
      els.restartErrorMsg.classList.add("hidden");
      els.modalRestart.classList.remove("hidden");
      els.btnCancelRestart.focus?.();
    });

    // 关闭重启对话框
    els.modalRestartClose.addEventListener("click", () => {
      els.modalRestart.classList.add("hidden");
    });
    els.btnCancelRestart.addEventListener("click", () => {
      els.modalRestart.classList.add("hidden");
    });

    // 确认重启
    els.btnConfirmRestart.addEventListener("click", () => {
      restartGateway();
    });

    // 未保存修改确认框事件
    els.modalUnsavedClose.addEventListener("click", () => {
      els.modalUnsaved.classList.add("hidden");
      state.pendingView = null;
    });
    els.btnUnsavedStay.addEventListener("click", () => {
      els.modalUnsaved.classList.add("hidden");
      state.pendingView = null;
    });
    els.btnUnsavedDiscard.addEventListener("click", () => {
      els.modalUnsaved.classList.add("hidden");
      if (state.pendingView) {
        const next = state.pendingView;
        state.pendingView = null;
        if (next === "settings-readonly") leaveSettingsEditor();
        else {
          leaveSettingsEditor();
          applySwitchView(next);
        }
      }
    });

    // Esc 关闭对话框（未保存提示按「留在设置」处理）
    document.addEventListener?.("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!els.modalUnsaved.classList.contains("hidden")) {
        els.modalUnsaved.classList.add("hidden");
        state.pendingView = null;
      } else if (!els.modalRestart.classList.contains("hidden")) {
        els.modalRestart.classList.add("hidden");
      }
    });
  }

  // --- 启动引导 ---
  async function boot() {
    await initAuth();
    initEvents();
    window.Subagents?.init(apiFetch, showToast);
    // 默认进入运行概览并开启轮询
    applySwitchView("overview");
  }

  // 主题与侧栏偏好在首帧前应用，避免闪烁
  applyTheme(readPref("gateway-admin-theme", "system"));
  applySidebarCollapsed(readPref("gateway-admin-sidebar", "expanded") === "collapsed");
  applyAutoRefresh(readPref("gateway-admin-auto-refresh", "on") !== "off");
  syncRangeControls();

  // 当 DOM 准备完毕时启动
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const fields = ["name", "description", "model", "effort", "sandbox", "tools", "prompt"];
  let api, toast, data, tool = "claude", selected = null, draft = null, initial = "", defaults = null, initialDefaults = "";
  let busy = false, query = "", filter = "all", pendingConfirmation = null;
  const counts = { claude: null, codex: null };
  const encode = encodeURIComponent;
  const dirty = () => !!draft && JSON.stringify(draft) !== initial;
  const defaultsDirty = () => !!defaults && JSON.stringify(defaults) !== initialDefaults;
  const hasChanges = () => dirty() || defaultsDirty();
  const label = () => tool === "claude" ? "Claude Code" : "Codex";
  function node(tag, className, text) {
    const el = document.createElement(tag);
    el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function modelName(model) { return model === "inherit" ? "跟随主会话" : model || "未指定"; }
  function modelInfo(model) {
    if (model === "inherit") return "跟随主会话模型";
    if (!model && data?.defaults.model) return "全局默认 " + data.defaults.model + " · " + modelInfo(data.defaults.model);
    const route = data?.models.find((m) => m.id === model);
    if (!route) return model ? "客户端模型策略" : "全局默认 / 主会话";
    return route.provider + " · " + route.targetModel + (route.status === "ok" ? " · 检测通过" : " · " + (route.reason || "尚未检测"));
  }
  function options(select, values, value) {
    select.replaceChildren();
    for (const item of values) {
      const option = node("option", "", item.label);
      option.value = item.value;
      option.disabled = !!item.disabled && item.value !== (value || "");
      select.appendChild(option);
    }
    if (value && !values.some((item) => item.value === value)) {
      const option = node("option", "", value + " (当前配置)");
      option.value = value;
      select.appendChild(option);
    }
    select.value = value || "";
  }
  function modelOptions(select, value, allowInherit = true) {
    const values = [{ value: "", label: "未指定 (全局默认 / 主会话)" }];
    if (tool === "claude" && allowInherit) values.push({ value: "inherit", label: "跟随主会话 (inherit)" });
    for (const route of data.models) {
      if (route.id === "inherit") continue;
      values.push({ value: route.id, label: route.id + " · " + route.provider + (route.available ? "" : " (" + (route.reason || "尚未检测") + ")"), disabled: !route.available });
    }
    options(select, values, value);
  }
  function updateStatus() {
    $("subagents-save-state-text").textContent = busy ? "处理中" : !data ? "配置未读取" : hasChanges() ? "有未保存修改" : "配置已读取";
    $("subagents-save-state").classList.toggle("is-pending", hasChanges());
    $("btn-check-models").disabled = busy || !data || hasChanges();
    $("btn-new-agent").disabled = busy || !data;
    $("subagents-cab-default-select").disabled = busy || !data || !!data.defaults.error;
    $("subagents-cab-default-effort").disabled = busy || !data || !!data.defaults.error;
    $("btn-save-defaults").disabled = busy || !defaultsDirty() || !!data?.defaults.error;
    $("btn-subagent-save").disabled = busy || !draft || !selected?.editable || (!dirty() && selected?.source !== "builtin" && !selected?.isNew);
    $("btn-subagent-cancel").disabled = busy || (!dirty() && !selected?.isNew);
    $("btn-check-models-text").textContent = busy ? "处理中" : "检测模型";
  }
  function populateEditor() {
    $("sa-editor-form").classList.toggle("hidden", !draft);
    $("sa-inspector-title").textContent = draft?.name || (selected?.isNew ? "新建子代理" : "选择子代理");
    $("sa-inspector-source").textContent = selected?.file || (selected?.source === "builtin" ? "客户端内置角色 · 接管后创建用户配置" : "用户级配置");
    if (!draft) return;
    for (const field of fields) {
      const el = $("sa-field-" + field);
      if (field === "model") modelOptions(el, draft.model);
      else if (["effort", "sandbox"].includes(field)) {
        const values = field === "effort" ? ["", "minimal", "low", "medium", "high", "xhigh"] : ["", "read-only", "workspace-write", "danger-full-access"];
        options(el, values.map((v) => ({value:v, label:v || "未指定"})), draft[field]);
      } else el.value = draft[field] || "";
      el.disabled = !selected.editable || busy;
    }
    $("sa-wrap-effort").hidden = tool !== "codex";
    $("sa-wrap-sandbox").hidden = tool !== "codex";
    $("sa-wrap-tools").hidden = tool !== "claude";
    $("sa-takeover-field").hidden = selected.source === "custom";
    $("btn-mode-override").classList.toggle("active", selected.source !== "builtin");
    $("btn-mode-builtin").classList.toggle("active", selected.source === "builtin");
    $("btn-mode-override").disabled = !selected.editable || busy;
    $("btn-mode-builtin").disabled = selected.source !== "override" || busy;
    $("sa-drawer-foot-note").textContent = selected.error || "写入后由客户端重新加载配置";
    previewModel();
  }
  function previewModel() {
    $("sa-preview-model").textContent = modelName(draft?.model);
    $("sa-preview-route").textContent = modelInfo(draft?.model);
  }
  function choose(agent, ask = true) {
    if (busy || (ask && dirty() && !window.confirm("放弃当前子代理的未保存修改？"))) return;
    selected = agent;
    draft = agent ? Object.fromEntries(fields.map((field) => [field, agent[field] ?? (field === "name" || field === "description" || field === "prompt" ? "" : null)])) : null;
    initial = JSON.stringify(draft);
    populateEditor(); renderBoard(); updateStatus();
  }
  function renderBoard() {
    const board = $("subagents-board");
    board.replaceChildren();
    if (!data) return;
    const list = data.agents.filter((a) => (filter === "all" || (filter === "builtin" ? a.source === "builtin" : a.source !== "builtin"))
      && [a.name, a.description, a.model].join(" ").toLowerCase().includes(query));
    for (const agent of list) {
      const card = node("button", "sa-agent-card" + (selected?.id === agent.id ? " selected" : ""));
      card.type = "button"; card.dataset.id = agent.id;
      card.setAttribute("aria-pressed", String(selected?.id === agent.id));
      const head = node("div", "sa-card-top");
      head.append(node("strong", "sa-agent-name", agent.name));
      head.append(node("span", "sa-tag " + agent.source, agent.source === "builtin" ? "内置" : agent.source === "override" ? "覆盖内置" : "自定义"));
      card.append(head, node("p", "sa-description", agent.error || agent.description));
      const route = node("div", "sa-route");
      route.append(node("strong", "sa-model-name", modelName(agent.model)), node("small", "sa-route-detail", modelInfo(agent.model)));
      card.append(route);
      card.addEventListener("click", () => { choose(agent); if (window.innerWidth < 1100) $("subagents-inspector").scrollIntoView({ block: "start" }); });
      board.append(card);
    }
    if (!list.length) board.append(node("p", "sa-empty-result", "没有匹配的子代理"));
  }
  function accept(next, focusName) {
    data = next; counts[tool] = data.agents.length;
    defaults = { model: data.defaults.model, effort: data.defaults.effort };
    initialDefaults = JSON.stringify(defaults);
    for (const name of ["claude", "codex"]) {
      $("count-" + name).textContent = counts[name] ?? "—";
      $("tool-" + name).classList.toggle("active", tool === name);
      $("tool-" + name).setAttribute("aria-selected", String(tool === name));
    }
    $("current-view-title").textContent = label() + " 的子代理";
    $("current-view-description").textContent = "";
    $("subagents-cab-root").textContent = data.root;
    $("sa-board-subtitle").textContent = data.agents.length + " 个子代理";
    $("summary-count-override").textContent = data.agents.filter(a => a.source !== "builtin").length;
    $("summary-count-builtin").textContent = data.agents.filter(a => a.source === "builtin").length;
    $("summary-count-models").textContent = new Set(data.agents.map(a => a.model).filter(m => m && m !== "inherit")).size;
    $("subagents-cab-effort-wrap").hidden = tool !== "codex";
    modelOptions($("subagents-cab-default-select"), defaults.model, tool === "claude");
    options($("subagents-cab-default-effort"), ["", "minimal", "low", "medium", "high", "xhigh"].map(v => ({ value: v, label: v || "未指定" })), defaults.effort);
    const warnings = [...(data.warnings || [])];
    $("subagents-warning-list").textContent = warnings.join("\n");
    $("subagents-warning-banner").classList.toggle("hidden", !warnings.length);
    choose(data.agents.find(a => a.name === focusName) || data.agents[0] || null, false);
  }
  async function request(path, method, body) {
    const response = await api(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "请求失败 " + response.status);
    return result;
  }
  async function load() {
    if (busy) return;
    busy = true; populateEditor(); updateStatus();
    try {
      const result = await request("/api/subagents?tool=" + tool, "GET");
      busy = false; accept(result, selected?.name);
    } catch (error) {
      $("subagents-warning-list").textContent = "加载失败：" + error.message;
      $("subagents-warning-banner").classList.remove("hidden");
      toast(error.message, "error");
    } finally { busy = false; populateEditor(); updateStatus(); }
  }
  async function mutate(path, method, body, focusName) {
    if (busy) return;
    const pendingDefaults = defaultsDirty() && !path.endsWith('/defaults') ? { ...defaults } : null;
    busy = true; populateEditor(); updateStatus();
    try {
      const result = await request(path, method, body);
      busy = false; accept(result, focusName);
      if (pendingDefaults) {
        defaults = pendingDefaults;
        modelOptions($("subagents-cab-default-select"), defaults.model);
        $("subagents-cab-default-effort").value = defaults.effort || "";
      }
      toast("配置已写入", "success");
    } catch (error) { toast(error.message, "error"); }
    finally { busy = false; populateEditor(); updateStatus(); }
  }
  function confirmAction(kind, action) {
    pendingConfirmation = { kind, action, focus: document.activeElement };
    $("modal-subagents-" + kind).classList.remove("hidden");
    $("btn-subagents-" + kind + "-cancel").focus();
  }
  function dismissConfirmation(run) {
    const pending = pendingConfirmation;
    if (!pending) return;
    $("modal-subagents-" + pending.kind).classList.add("hidden");
    pendingConfirmation = null;
    pending.focus?.focus();
    if (run) pending.action();
  }
  function save() {
    if (!draft || busy) return;
    if (!draft.name.trim() || !draft.description.trim() || (tool === "codex" && !draft.prompt.trim())) return toast("名称、作用和指令不能为空", "error");
    const action = () => mutate("/api/subagents/" + tool + "/" + encode(selected.isNew ? draft.name.trim() : selected.id), "PUT", { ...draft, revision: selected.revision }, draft.name.trim());
    const ranks = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };
    if (tool === "codex" && draft.sandbox !== selected.sandbox && (draft.sandbox === "danger-full-access" || (ranks[draft.sandbox] ?? 1) > (ranks[selected.sandbox] ?? 1))) confirmAction("privilege", action);
    else action();
  }
  function leave() {
    if (busy) { toast("请等待当前操作完成", "info"); return false; }
    if (hasChanges() && !window.confirm("放弃子代理配置中未保存的修改？")) return false;
    draft = null; defaults = null; return true;
  }
  function init(fetcher, showToast) {
    api = fetcher; toast = showToast;
    for (const name of ["claude", "codex"]) {
      $("tool-" + name).addEventListener("click", () => {
        if (name === tool || !leave()) return;
        tool = name; selected = null; data = null;
        $("subagents-board").replaceChildren(); populateEditor(); load();
      });
    }
    for (const field of fields) {
      const el = $("sa-field-" + field);
      el.addEventListener(["model", "effort", "sandbox"].includes(field) ? "change" : "input", () => {
        if (!draft) return;
        draft[field] = ["model", "effort", "sandbox", "tools"].includes(field) ? el.value || null : el.value;
        previewModel(); updateStatus();
        const selectedCard = $("subagents-board").querySelector(".selected");
        selectedCard?.classList.toggle("is-dirty", dirty());
      });
    }
    $("sa-search-input").addEventListener("input", (e) => { query = e.target.value.trim().toLowerCase(); renderBoard(); });
    document.querySelectorAll(".sa-filter-btn").forEach(button => button.addEventListener("click", () => {
      filter = button.dataset.filter;
      document.querySelectorAll(".sa-filter-btn").forEach(b => { b.classList.toggle("active", b === button); b.setAttribute("aria-pressed", String(b === button)); });
      renderBoard();
    }));
    $("btn-new-agent").addEventListener("click", () => choose({ id: "__new__", name: "", description: "", model: null, effort: null, sandbox: null, tools: null,
      prompt: tool === "codex" ? "Complete only the delegated task and report changes and verification." : "仅完成委派的任务，报告修改与验证结果。", source: "custom", editable: true, revision: null, isNew: true }));
    $("btn-subagent-save").addEventListener("click", save);
    $("sa-editor-form").addEventListener("submit", e => { e.preventDefault(); save(); });
    $("btn-subagent-cancel").addEventListener("click", () => {
      if (dirty() && !window.confirm("放弃当前子代理的未保存修改？")) return;
      choose(selected?.isNew ? data.agents[0] : selected, false);
    });
    $("btn-mode-override").addEventListener("click", () => {
      if (selected?.source === "builtin" && selected.editable) { $("sa-field-name").focus(); toast("编辑后保存将创建用户覆盖配置", "info"); }
    });
    $("btn-mode-builtin").addEventListener("click", () => {
      if (selected?.source !== "override") return;
      confirmAction("reset", () => mutate("/api/subagents/" + tool + "/" + encode(selected.id), "DELETE", { revision: selected.revision }, selected.name));
    });
    $("subagents-cab-default-select").addEventListener("change", e => { defaults.model = e.target.value || null; updateStatus(); });
    $("subagents-cab-default-effort").addEventListener("change", e => { defaults.effort = e.target.value || null; updateStatus(); });
    $("btn-save-defaults").addEventListener("click", () => {
      if (dirty()) return toast("请先保存或放弃子代理草稿", "info");
      mutate("/api/subagents/" + tool + "/defaults", "PUT", { ...defaults, revision: data.defaults.revision }, selected?.name);
    });
    $("btn-check-models").addEventListener("click", () => confirmAction("check", async () => {
      if (busy || hasChanges()) return;
      busy = true; updateStatus();
      try {
        const result = await request("/api/subagents/" + tool + "/check-models", "POST", {});
        busy = false; accept(result, selected?.name);
        toast("检测完成：" + result.models.filter(m => m.available).length + " 条可用线路", "info");
      } catch (error) { toast(error.message, "error"); }
      finally { busy = false; updateStatus(); }
    }));
    for (const kind of ["reset", "privilege", "check"]) {
      $("btn-subagents-" + kind + "-confirm").addEventListener("click", () => dismissConfirmation(true));
      $("btn-subagents-" + kind + "-cancel").addEventListener("click", () => dismissConfirmation(false));
      $("modal-subagents-" + kind + "-close").addEventListener("click", () => dismissConfirmation(false));
    }
    document.addEventListener("keydown", event => {
      if (!pendingConfirmation) return;
      if (event.key === "Escape") { event.preventDefault(); dismissConfirmation(false); }
      if (event.key === "Tab") {
        const buttons = [...$("modal-subagents-" + pendingConfirmation.kind).querySelectorAll("button:not(:disabled)")];
        if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1).focus(); }
        else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0].focus(); }
      }
    });
    window.addEventListener("beforeunload", event => { if (hasChanges() || busy) { event.preventDefault(); event.returnValue = ""; } });
  }
  window.Subagents = { init, show: load, leave };
})();

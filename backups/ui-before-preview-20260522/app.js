let state = {
  scripts: [],
  batches: [],
  jobs: [],
  summary: null,
  pricingRules: {},
  accountBalance: null,
  owners: [],
  hasPoyoKey: false,
  hasArkKey: false
};

let uploadedImage = null;
let uploadedImages = [];
let mentionStart = -1;
const selectedJobIds = new Set();
let pendingSubmitPayload = null;
let pendingSubmitScriptId = null;
let confirmHandler = null;
let currentDetailJobId = null;
let currentUser = null;
const MINE_ONLY_STORAGE_KEY = "fyaiMineOnly";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const statusLabels = {
  draft: "草稿",
  submitting: "提交中",
  submit_failed: "提交失败",
  not_started: "等待",
  running: "生成中",
  finished: "已完成",
  failed: "失败"
};

function modelLabel(model) {
  return state.pricingRules?.[model]?.label || model;
}

function externalTaskId(job) {
  return job.arkTaskId || job.poyoTaskId || job.externalTaskId || "";
}

function categoryLabel(value) {
  return value || "未分类";
}

function ownerLabel(value) {
  return value || "未填写";
}

function usageOwnerLabel(value) {
  const owner = ownerLabel(value);
  return owner === "未填写" ? "朱浩权" : owner;
}

function safeDownloadFilename(job) {
  const extension = job.files?.find((item) => item.file_type === "video")?.format
    ? `.${job.files.find((item) => item.file_type === "video").format}`
    : ".mp4";
  const name = [
    ownerLabel(job.owner),
    categoryLabel(job.category),
    job.batchName || job.id
  ]
    .filter(Boolean)
    .join("--")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return `${name || job.id}${extension}`;
}

function failureAdvice(message = "") {
  const text = String(message || "").toLowerCase();
  if (!text) return "";
  if (text.includes("safe experience") || text.includes("inference limit") || text.includes("安心体验")) {
    return "建议：到火山方舟开通管理里关闭安心体验限制，关闭后重新提交新任务。";
  }
  if (text.includes("unauthorized") || text.includes("invalid api key") || text.includes("密钥")) {
    return "建议：打开密钥设置，重新保存对应平台的 Key。";
  }
  if (text.includes("quota") || text.includes("balance") || text.includes("余额") || text.includes("额度")) {
    return "建议：检查平台余额或免费额度，补充额度后重新提交。";
  }
  if (text.includes("content") || text.includes("safety") || text.includes("审核") || text.includes("policy")) {
    return "建议：调整提示词，减少敏感人物、暴力、仿冒或高风险描述后重试。";
  }
  if (text.includes("timeout") || text.includes("network") || text.includes("fetch")) {
    return "建议：稍后刷新任务；如果多条都失败，先确认网络和平台服务状态。";
  }
  return "建议：复制任务信息后保留失败原因，调整提示词或参数后重新提交。";
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) {
    currentUser = null;
    applyAuthState();
  }
  if (!response.ok) throw new Error(body.error || "请求失败");
  return body;
}

function applyAuthState() {
  const loggedIn = Boolean(currentUser);
  $("#authGate").hidden = loggedIn;
  $(".shell").hidden = !loggedIn;
  const sessionUser = $("#sessionUser");
  if (sessionUser) sessionUser.textContent = loggedIn ? currentUser.name || currentUser.username : "未登录";
  const accessPanel = $("#accessAdminPanel");
  if (accessPanel && (!loggedIn || currentUser.role !== "admin")) accessPanel.hidden = true;
}

async function loadSession() {
  const result = await api("/api/session");
  currentUser = result.user || null;
  applyAuthState();
  if (currentUser?.role === "admin") await loadAccessRequests();
}

async function loadState() {
  state = await api("/api/state");
  currentUser = state.currentUser || currentUser;
  applyAuthState();
  render();
}

async function loadAccessRequests() {
  if (currentUser?.role !== "admin") return;
  try {
    const result = await api("/api/access/requests");
    renderAccessRequests(result.requests || []);
  } catch (error) {
    toast(error.message);
  }
}

function renderAccessRequests(requests) {
  const list = $("#accessRequestList");
  if (!list) return;
  const pending = requests.filter((item) => item.status === "pending");
  const panel = $("#accessAdminPanel");
  if (panel) panel.hidden = pending.length === 0;
  if (!pending.length) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = pending
    .map((item) => `
      <div class="access-item">
        <div>
          <strong>${escapeHtml(item.name)} / ${escapeHtml(item.username)}</strong>
          <span>${escapeHtml(item.contact || "无备注")} · ${escapeHtml(new Date(item.createdAt).toLocaleString("zh-CN"))}</span>
        </div>
        <div class="access-actions">
          <button type="button" data-approve-request="${escapeAttribute(item.id)}">批准</button>
          <button class="secondary" type="button" data-reject-request="${escapeAttribute(item.id)}">拒绝</button>
        </div>
      </div>
    `)
    .join("");
}

async function handleAccessDecision(requestId, action) {
  try {
    await api(`/api/access/requests/${encodeURIComponent(requestId)}/${action}`, { method: "POST" });
    toast(action === "approve" ? "已批准" : "已拒绝");
    await loadAccessRequests();
    if (action === "approve") await loadState();
  } catch (error) {
    toast(error.message);
  }
}

function updateMatrixCount() {
  const scriptCount = getCurrentPrompt().prompt ? 1 : 0;
  const variants = Math.max(1, Number($("#batchForm").elements.variantsPerCombination.value || 1));
  const total = scriptCount * variants;
  $("#matrixCount").textContent = `${total} 条`;
  renderCostPreview();
}

function render() {
  const isLocalAdminPage = ["127.0.0.1", "localhost", "0.0.0.0", "::1"].includes(window.location.hostname);
  const canManageKeys = currentUser?.role === "admin" || isLocalAdminPage;
  $("#keyStatus").textContent = state.hasPoyoKey
    ? "密钥正常"
    : "未配置密钥";
  $("#configureKeyBtn").textContent = "密钥";
  // 权限优化：密钥只由本机管理员维护，部门成员不需要看到密钥入口。
  $("#configureKeyBtn").hidden = !canManageKeys;
  $("#keyStatus").hidden = !canManageKeys;
  $("#poyoKeyState").textContent = state.hasPoyoKey ? "已保存到本地" : "未保存";
  $("#arkKeyState").textContent = state.hasArkKey ? "已保存到本地" : "未保存";
  updateSubmitState();
  $("#scriptCount").textContent = `${state.scripts.length} 条`;
  renderMetrics();
  renderScriptFilters();
  renderScripts();
  renderOwnerOptions();
  renderFilters();
  renderJobDateOptions();
  renderJobs();
  renderBulkActions();
  renderPricingList();
  renderStats();
  renderUsageStats();
  renderDurationOptions();
  renderResolutionOptions();
  updateImageUi();
  updateMatrixCount();
}

function currentProvider() {
  const model = $("#batchForm")?.elements.model.value;
  return state.pricingRules?.[model]?.provider || "poyo";
}

function updateSubmitState() {
  const submitNowButton = $("#batchForm button[name='submitNow']");
  if (!submitNowButton) return;
  const provider = currentProvider();
  submitNowButton.disabled = provider === "ark" ? !state.hasArkKey : !state.hasPoyoKey;
}

function renderMetrics() {
  const statuses = state.summary?.statuses || {};
  const cards = [
    ["提示词", state.summary?.totalScripts || 0],
    ["批次", state.summary?.totalBatches || 0],
    ["任务总数", state.summary?.totalJobs || 0],
    ["账户积分", formatCredits(state.accountBalance?.credits ?? "未同步")],
    ["草稿预计", formatCredits(state.summary?.estimatedDraftCredits || 0)],
    ["已完成", statuses.finished || 0],
    ["生成中", (statuses.running || 0) + (statuses.not_started || 0) + (statuses.submitting || 0)],
    ["失败", (statuses.failed || 0) + (statuses.submit_failed || 0)]
  ];
  $("#metrics").innerHTML = cards
    .map(([label, value]) => `<div class="metric"><span>${escapeHtml(label)}</span><strong>${value}</strong></div>`)
    .join("");
}

function estimateUnitCredits({ model, duration, resolution }) {
  const rule = state.pricingRules?.[model];
  if (!rule) return null;
  if (rule.billing === "duration_tier") return rule.durations?.[String(duration)] ?? rule.durations?.[duration] ?? null;
  if (rule.billing === "resolution_per_second") {
    const rate = rule.rates?.[resolution];
    return rate ? rate * Number(duration) : null;
  }
  if (rule.billing === "flat") return rule.credits ?? null;
  return null;
}

function formatCredits(value) {
  if (value === "未同步") return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return Number.isInteger(number) ? String(number) : number.toFixed(2);
}

function renderCostPreview() {
  const form = $("#batchForm");
  if (!form || !state.pricingRules) return;
  const scriptCount = getCurrentPrompt().prompt ? 1 : 0;
  const variants = Math.max(1, Number(form.elements.variantsPerCombination.value || 1));
  const totalJobs = scriptCount * variants;
  const model = form.elements.model.value;
  const duration = Number(form.elements.duration.value);
  const resolution = form.elements.resolution.value;
  const unitCredits = estimateUnitCredits({ model, duration, resolution });
  const totalCredits = unitCredits === null ? null : unitCredits * totalJobs;
  const balance = state.accountBalance?.credits;
  const balanceText = Number.isFinite(Number(balance)) ? formatCredits(balance) : "未同步";
  const enough = totalCredits === null || !Number.isFinite(Number(balance)) || Number(balance) >= totalCredits;
  $("#costPreview").innerHTML = `
    <span class="${enough ? "" : "warn"}">预计消耗 <strong>${totalCredits === null ? "待确认" : `${formatCredits(totalCredits)} 积分`}</strong></span>
    <span>本批 ${totalJobs} 条</span>
    <span>单条 ${unitCredits === null ? "待确认" : formatCredits(unitCredits)}</span>
    <span>余额 ${balanceText}</span>
  `;
}

function renderPricingList() {
  const rows = Object.entries(state.pricingRules || {}).map(([model, rule]) => {
    let price = "";
    if (rule.billing === "duration_tier") {
      price = Object.entries(rule.durations || {}).map(([seconds, credits]) => `${seconds}s=${credits}`).join(" · ");
    } else if (rule.billing === "resolution_per_second") {
      price = Object.entries(rule.rates || {}).map(([resolution, credits]) => `${resolution}=${credits}/秒`).join(" · ");
    } else if (rule.billing === "flat") {
      price = `${rule.credits}/条`;
    }
    return `<div class="pricing-row"><strong>${escapeHtml(rule.label || model)}</strong><span>${escapeHtml(price)}</span></div>`;
  });
  $("#pricingList").innerHTML = rows.join("");
}

function renderDurationOptions() {
  const form = $("#batchForm");
  if (!form) return;
  const model = form.elements.model.value;
  const options = state.pricingRules?.[model]?.durationOptions || [4, 8, 12, 16, 20];
  const current = Number(form.elements.duration.value);
  form.elements.duration.innerHTML = options.map((seconds) => `<option value="${seconds}">${seconds}</option>`).join("");
  form.elements.duration.value = options.includes(current) ? String(current) : String(options[0]);
}

function renderResolutionOptions() {
  const form = $("#batchForm");
  if (!form) return;
  const model = form.elements.model.value;
  const options = state.pricingRules?.[model]?.resolutionOptions || ["720p", "1024p", "1080p"];
  const current = form.elements.resolution.value;
  form.elements.resolution.innerHTML = options
    .map((resolution) => `<option value="${resolution}">${resolution}</option>`)
    .join("");
  form.elements.resolution.value = options.includes(current) ? current : options[0];
}

function renderScripts() {
  const list = $("#scriptList");
  const search = String($("#scriptSearchInput")?.value || "").trim().toLowerCase();
  const category = String($("#scriptCategoryFilter")?.value || "").trim();
  const scripts = state.scripts.filter((script) => {
    if (category && categoryLabel(script.category) !== category) return false;
    if (!search) return true;
    return [script.title, script.prompt, script.category]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(search);
  });
  if (!scripts.length) {
    list.innerHTML = `<div class="empty">还没有保存的提示词</div>`;
    return;
  }
  list.innerHTML = scripts
    .map(
      (script) => `
        <article class="script-item">
          <div>
            <div class="script-title">${escapeHtml(script.title)}</div>
            <div class="script-category">${escapeHtml(categoryLabel(script.category))}</div>
            <div class="script-preview">${escapeHtml(script.prompt.slice(0, 96))}</div>
          </div>
          <button class="tiny secondary" data-use-script="${script.id}" type="button">使用</button>
          <button class="tiny danger" data-delete-script="${script.id}" type="button">删除</button>
        </article>
      `
    )
    .join("");
  $$("[data-use-script]").forEach((button) => {
    button.addEventListener("click", () => {
      const script = state.scripts.find((item) => item.id === button.dataset.useScript);
      if (!script) return;
      const form = $("#batchForm");
      form.elements.prompt.value = script.prompt;
      if (!form.elements.name.value) form.elements.name.value = script.title;
      updateMatrixCount();
      toast("已填入提示词");
    });
  });
  $$("[data-delete-script]").forEach((button) => {
    button.addEventListener("click", async () => {
      await api(`/api/scripts/${button.dataset.deleteScript}`, { method: "DELETE" });
      toast("脚本已删除");
      await loadState();
    });
  });
}

function renderScriptFilters() {
  const select = $("#scriptCategoryFilter");
  if (!select) return;
  const current = select.value;
  const categories = [...new Set(state.scripts.map((script) => categoryLabel(script.category)))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  select.innerHTML = `<option value="">全部分类</option>${categories
    .map((category) => `<option value="${escapeAttribute(category)}">${escapeHtml(category)}</option>`)
    .join("")}`;
  select.value = categories.includes(current) ? current : "";
}

function getCurrentPrompt() {
  const form = $("#batchForm");
  const prompt = String(form?.elements.prompt.value || "").trim();
  const title = String(form?.elements.name.value || "").trim() || "未命名提示词";
  return { title, prompt };
}

function getKnownOwners() {
  // 体验优化：使用人来源统一，已批准的新账号会自动进入生成页、流水筛选和积分统计。
  const owners = new Set(Array.isArray(state.owners) ? state.owners : []);
  state.jobs.forEach((job) => {
    if (job.owner) owners.add(job.owner);
  });
  state.scripts.forEach((script) => {
    if (script.owner) owners.add(script.owner);
  });
  return [...owners].filter(Boolean).sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function renderOwnerOptions() {
  const owners = getKnownOwners();
  const options = owners
    .map((owner) => `<option value="${escapeAttribute(owner)}">${escapeHtml(owner)}</option>`)
    .join("");
  const ownerSelect = $("#batchForm")?.elements.owner;
  if (ownerSelect) {
    const current = ownerSelect.value;
    ownerSelect.innerHTML = `<option value="">选择使用人</option>${options}`;
    ownerSelect.value = owners.includes(current) ? current : "";
  }
  const ownerFilter = $("#ownerFilter");
  if (ownerFilter) {
    const current = ownerFilter.value;
    ownerFilter.innerHTML = `<option value="">全部使用人</option>${options}`;
    ownerFilter.value = owners.includes(current) ? current : "";
  }
}

function renderFilters() {
  const batchFilter = $("#batchFilter");
  const current = batchFilter.value;
  batchFilter.innerHTML = `<option value="">全部批次</option>${state.batches
    .map((batch) => `<option value="${batch.id}">${escapeHtml(batch.name)}</option>`)
    .join("")}`;
  batchFilter.value = current;
}

function jobDay(job) {
  const value = job.createdAt || job.updatedAt;
  return value ? String(value).slice(0, 10) : "";
}

function renderJobDateOptions() {
  const select = $("#jobDateFilter");
  if (!select) return;
  const current = select.value;
  const dates = [...new Set(state.jobs.map(jobDay).filter(Boolean))].sort().reverse();
  select.innerHTML = `<option value="">全部日期</option>${dates
    .map((date) => `<option value="${escapeAttribute(date)}">${escapeHtml(date)}</option>`)
    .join("")}`;
  select.value = dates.includes(current) ? current : "";
}

function filteredJobs() {
  const batchId = $("#batchFilter").value;
  const status = $("#statusFilter").value;
  const owner = $("#ownerFilter").value;
  const date = $("#jobDateFilter")?.value || "";
  const search = $("#searchInput").value.trim().toLowerCase();
  const mineOnly = Boolean($("#mineOnlyToggle")?.checked);
  const myName = currentUser?.name || currentUser?.username || "";
  return state.jobs.filter((job) => {
    if (batchId && job.batchId !== batchId) return false;
    if (status && job.status !== status) return false;
    if (owner && job.owner !== owner) return false;
    if (date && jobDay(job) !== date) return false;
    if (mineOnly && ownerLabel(job.owner) !== myName) return false;
    if (!search) return true;
    const haystack = [
      job.scriptTitle,
      job.model,
      job.batchName,
      job.owner,
      job.poyoTaskId
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(search);
  });
}

function syncSelectedJobs(jobs = filteredJobs()) {
  const visibleIds = new Set(jobs.map((job) => job.id));
  for (const id of [...selectedJobIds]) {
    if (!state.jobs.some((job) => job.id === id)) selectedJobIds.delete(id);
  }
  const selectedVisibleCount = jobs.filter((job) => selectedJobIds.has(job.id)).length;
  const selectAll = $("#selectAllJobs");
  if (selectAll) {
    selectAll.checked = jobs.length > 0 && selectedVisibleCount === jobs.length;
    selectAll.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < jobs.length;
  }
  return { visibleIds, selectedVisibleCount };
}

function renderBulkActions() {
  syncSelectedJobs();
  const count = selectedJobIds.size;
  const hasSaveable = state.jobs.some((job) => selectedJobIds.has(job.id) && getJobVideoSource(job).src);
  const hasFailed = filteredJobs().some((job) => ["failed", "submit_failed"].includes(job.status));
  $("#bulkRefreshBtn").disabled = count === 0;
  $("#bulkSaveBtn").disabled = !hasSaveable;
  $("#bulkDeleteBtn").disabled = count === 0;
  $("#retryFailedBtn").disabled = !hasFailed;
}

function getJobVideoSource(job) {
  const file = (job.files || []).find((item) => item.file_type === "video") || job.files?.[0];
  const localFile = job.localFiles?.[job.localFiles.length - 1];
  return {
    file,
    localFile,
    src: localFile?.path || file?.file_url || ""
  };
}

function renderJobs() {
  const jobs = filteredJobs();
  const body = $("#jobsTable");
  syncSelectedJobs(jobs);
  if (!jobs.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty">没有匹配任务</td></tr>`;
    renderBulkActions();
    return;
  }
  body.innerHTML = jobs
    .map((job) => {
      const { file, localFile, src: previewSrc } = getJobVideoSource(job);
      const progress = Number(job.progress || 0);
      const taskId = externalTaskId(job);
      const canRefresh = Boolean(taskId) && !["finished", "failed"].includes(job.status);
      const canDownload = Boolean(previewSrc);
      const canPreview = Boolean(previewSrc);
      const showResolution = Boolean(state.pricingRules?.[job.model]?.rates);
      const errorText = job.errorMessage || job.lastRefreshError || "";
      const advice = failureAdvice(errorText);
      const canSubmit = (job.provider || state.pricingRules?.[job.model]?.provider || "poyo") === "ark"
        ? state.hasArkKey && ["draft", "submit_failed"].includes(job.status)
        : state.hasPoyoKey && ["draft", "submit_failed"].includes(job.status);
      return `
        <tr>
          <td>
            <label class="job-select-row">
              <input type="checkbox" data-select-job="${job.id}" ${selectedJobIds.has(job.id) ? "checked" : ""}>
              <span>
            <div class="job-main">${escapeHtml(job.scriptTitle)}</div>
            <div class="job-sub">${escapeHtml(ownerLabel(job.owner))} · ${escapeHtml(job.batchName)} · ${escapeHtml(categoryLabel(job.category))}</div>
              </span>
            </label>
          </td>
          <td>
            <div>${escapeHtml(modelLabel(job.model))}</div>
            <div class="job-sub">${job.duration}s · ${escapeHtml(job.aspectRatio)}${showResolution && job.resolution ? ` · ${escapeHtml(job.resolution)}` : ""}${job.imageUrls?.length || job.imageRefs?.length ? " · 参考图" : ""}${job.variantsPerCombination > 1 ? ` · 第 ${job.variantIndex}/${job.variantsPerCombination} 条` : ""}</div>
          </td>
          <td>
            <span class="badge ${escapeHtml(job.status)}">${escapeHtml(statusLabels[job.status] || job.status)}</span>
            <div class="progress"><span style="width:${Math.max(0, Math.min(100, progress))}%"></span></div>
            ${job.errorMessage ? `<div class="job-error">失败原因：${escapeHtml(job.errorMessage)}</div>` : ""}
            ${job.lastRefreshError ? `<div class="job-error">刷新失败：${escapeHtml(job.lastRefreshError)}</div>` : ""}
            ${advice ? `<div class="job-advice">${escapeHtml(advice)}</div>` : ""}
            ${taskId ? `<div class="job-sub">${escapeHtml(taskId)}</div>` : ""}
          </td>
          <td>
            <div>${formatCredits(job.actualCredits ?? job.estimatedCredits ?? "")}</div>
            <div class="job-sub">${job.actualCredits ? "实际" : "预计"}</div>
          </td>
          <td>
            <div class="row-actions">
              <button class="tiny" data-submit="${job.id}" ${canSubmit ? "" : "disabled"} type="button">提交</button>
              <button class="tiny secondary" data-refresh="${job.id}" ${canRefresh ? "" : "disabled"} type="button">刷新</button>
              <button class="tiny" data-preview="${job.id}" ${canPreview ? "" : "disabled"} type="button">预览</button>
              ${canDownload
                ? `<a class="link-button tiny secondary" href="/api/jobs/${encodeURIComponent(job.id)}/download-file" download="${escapeAttribute(safeDownloadFilename(job))}">保存</a>`
                : `<button class="tiny secondary" disabled type="button">保存</button>`}
              <details class="more-actions">
                <summary>更多</summary>
                <div>
                  <button class="tiny secondary" data-detail="${job.id}" type="button">详情</button>
                  <button class="tiny secondary" data-copy-job="${job.id}" type="button">复制</button>
                  <button class="tiny danger" data-delete-job="${job.id}" type="button">删除</button>
                </div>
              </details>
            </div>
            ${file?.file_url ? `<div class="job-sub"><a href="${escapeAttribute(file.file_url)}" target="_blank" rel="noreferrer">源视频</a></div>` : ""}
            ${localFile?.path ? `<div class="job-sub"><a href="${escapeAttribute(localFile.path)}" target="_blank" rel="noreferrer">本地文件</a></div>` : ""}
          </td>
        </tr>
      `;
    })
    .join("");

  $$("[data-select-job]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedJobIds.add(checkbox.dataset.selectJob);
      else selectedJobIds.delete(checkbox.dataset.selectJob);
      renderBulkActions();
    });
  });

  $$("[data-submit]").forEach((button) => {
    button.addEventListener("click", () => runJobAction(button, `/api/jobs/${button.dataset.submit}/submit`, "已提交"));
  });
  $$("[data-refresh]").forEach((button) => {
    button.addEventListener("click", () => runJobAction(button, `/api/jobs/${button.dataset.refresh}/refresh`, "已刷新"));
  });
  $$("[data-preview]").forEach((button) => {
    button.addEventListener("click", () => openVideoPreview(button.dataset.preview));
  });
  $$("[data-detail]").forEach((button) => {
    button.addEventListener("click", () => openJobDetail(button.dataset.detail));
  });
  $$("[data-copy-job]").forEach((button) => {
    button.addEventListener("click", () => copyJobInfo(button.dataset.copyJob));
  });
  $$("[data-delete-job]").forEach((button) => {
    button.addEventListener("click", async () => {
      const ok = await confirmAction({
        title: "删除任务",
        meta: "删除后任务记录会从列表移除。",
        rows: [["任务", state.jobs.find((job) => job.id === button.dataset.deleteJob)?.scriptTitle || button.dataset.deleteJob]],
        danger: true
      });
      if (!ok) return;
      await api(`/api/jobs/${button.dataset.deleteJob}`, { method: "DELETE" });
      toast("任务已删除");
      await loadState();
    });
  });
  renderBulkActions();
}

async function runJobAction(button, path, message) {
  button.disabled = true;
  try {
    await api(path, { method: "POST" });
    toast(message);
  } catch (error) {
    toast(error.message);
  } finally {
    await loadState();
  }
}

function confirmAction({ title, meta = "", rows = [], danger = false }) {
  return new Promise((resolve) => {
    confirmHandler = resolve;
    $("#confirmTitle").textContent = title;
    $("#confirmMeta").textContent = meta;
    $("#confirmBody").innerHTML = rows
      .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
      .join("");
    $("#confirmActionBtn").classList.toggle("danger", danger);
    $("#confirmActionBtn").textContent = danger ? "确认删除" : "确认提交";
    $("#confirmModal").hidden = false;
  });
}

function closeConfirmModal(result = false) {
  $("#confirmModal").hidden = true;
  const handler = confirmHandler;
  confirmHandler = null;
  if (handler) handler(result);
}

async function runBulkAction(action, message) {
  const ids = [...selectedJobIds];
  if (!ids.length) {
    toast("请先选择任务");
    return;
  }
  if (action === "delete") {
    const ok = await confirmAction({
      title: "批量删除任务",
      meta: "删除后这些任务记录会从列表移除。",
      rows: [["数量", `${ids.length} 条`]],
      danger: true
    });
    if (!ok) return;
  }
  try {
    await api("/api/jobs/bulk", {
      method: "POST",
      body: JSON.stringify({ action, ids })
    });
    if (action === "delete") selectedJobIds.clear();
    toast(message);
    await loadState();
  } catch (error) {
    toast(error.message);
  }
}

async function retryFailedJobs() {
  const jobs = filteredJobs().filter((job) => ["failed", "submit_failed"].includes(job.status));
  if (!jobs.length) return toast("当前筛选下没有失败任务");
  const ok = await confirmAction({
    title: "重试失败任务",
    meta: "会重新提交当前筛选下的失败任务。",
    rows: [["数量", `${jobs.length} 条`]]
  });
  if (!ok) return;
  try {
    for (const job of jobs) {
      await api(`/api/jobs/${encodeURIComponent(job.id)}/submit`, { method: "POST" });
    }
    toast(`已重试 ${jobs.length} 条失败任务`);
    await loadState();
  } catch (error) {
    toast(error.message);
    await loadState();
  }
}

function exportFilteredJobsCsv() {
  const rows = filteredJobs();
  const headers = ["使用人", "批次", "提示词", "分类", "模型", "状态", "秒数", "尺寸", "分辨率", "任务ID", "预计积分", "实际积分", "错误"];
  const escapeCsv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const lines = [
    headers.map(escapeCsv).join(","),
    ...rows.map((job) => [
      ownerLabel(job.owner),
      job.batchName,
      job.scriptTitle,
      categoryLabel(job.category),
      modelLabel(job.model),
      statusLabels[job.status] || job.status,
      job.duration,
      job.aspectRatio,
      job.resolution,
      externalTaskId(job),
      job.estimatedCredits,
      job.actualCredits,
      job.errorMessage || job.lastRefreshError || ""
    ].map(escapeCsv).join(","))
  ];
  const blob = new Blob([`\ufeff${lines.join("\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ai-tool-jobs-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast("CSV 已导出");
}

// 新增积分统计：直接复用现有任务数据，按完成任务归属到使用人和日期，不改变生成流程。
function jobUsageDate(job) {
  const sourceDate = job.status === "finished" ? job.updatedAt || job.createdAt : job.createdAt || job.updatedAt;
  return String(sourceDate || "").slice(0, 10) || "未记录";
}

function jobUsageCredits(job) {
  const hasActualCredits = job.actualCredits !== null && job.actualCredits !== undefined && job.actualCredits !== "";
  const actual = Number(job.actualCredits);
  if (hasActualCredits && Number.isFinite(actual)) return actual;
  const estimated = Number(job.estimatedCredits);
  return Number.isFinite(estimated) ? estimated : 0;
}

function isUsageJob(job) {
  const hasActualCredits = job.actualCredits !== null && job.actualCredits !== undefined && job.actualCredits !== "";
  return job.status === "finished" || Boolean(getJobVideoSource(job).src) || hasActualCredits;
}

function getUsageDates() {
  const dates = [...new Set(state.jobs.filter(isUsageJob).map(jobUsageDate))].filter(Boolean).sort().reverse();
  return dates.length ? dates : [new Date().toISOString().slice(0, 10)];
}

function usageRangeLabel(range, date) {
  if (range === "all") return "全部日期";
  if (range === "week") return "本周";
  if (range === "month") return "本月";
  return date || "指定日期";
}

function isDateInUsageRange(date, range, selectedDate) {
  if (range === "all") return true;
  if (range === "date") return date === selectedDate;
  const target = new Date(`${date}T00:00:00`);
  const now = new Date();
  if (Number.isNaN(target.getTime())) return false;
  if (range === "month") {
    return target.getFullYear() === now.getFullYear() && target.getMonth() === now.getMonth();
  }
  if (range === "week") {
    const start = new Date(now);
    const day = start.getDay() || 7;
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - day + 1);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return target >= start && target < end;
  }
  return false;
}

function syncUsageFilters() {
  const rangeSelect = $("#usageRangeFilter");
  const dateSelect = $("#usageDateFilter");
  const ownerSelect = $("#usageOwnerFilter");
  if (!dateSelect || !ownerSelect) return { date: "", owner: "" };

  const range = rangeSelect?.value || "all";
  $$("[data-usage-range]").forEach((button) => {
    button.classList.toggle("active", button.dataset.usageRange === range);
  });
  const currentDate = dateSelect.value;
  const dates = getUsageDates();
  dateSelect.innerHTML = dates.map((date) => `<option value="${date}">${date}</option>`).join("");
  dateSelect.value = dates.includes(currentDate) ? currentDate : dates[0];
  dateSelect.disabled = range !== "date";

  const currentOwner = ownerSelect.value;
  const owners = getKnownOwners();
  ownerSelect.innerHTML = `<option value="">全部使用人</option>${owners
    .map((owner) => `<option value="${escapeAttribute(owner)}">${escapeHtml(owner)}</option>`)
    .join("")}`;
  ownerSelect.value = owners.includes(currentOwner) ? currentOwner : "";

  return { range, date: dateSelect.value, owner: ownerSelect.value };
}

function getUsageRows() {
  const range = $("#usageRangeFilter")?.value || "all";
  const date = $("#usageDateFilter")?.value || getUsageDates()[0];
  const ownerFilter = $("#usageOwnerFilter")?.value || "";
  const rows = new Map();

  for (const owner of getKnownOwners()) {
    rows.set(owner, { owner, dayCount: 0, dayCredits: 0, totalCredits: 0 });
  }

  for (const job of state.jobs.filter(isUsageJob)) {
    const owner = usageOwnerLabel(job.owner);
    if (ownerFilter && owner !== ownerFilter) continue;
    const row = rows.get(owner) || { owner, dayCount: 0, dayCredits: 0, totalCredits: 0 };
    const credits = jobUsageCredits(job);
    row.totalCredits += credits;
    if (isDateInUsageRange(jobUsageDate(job), range, date)) {
      row.dayCount += 1;
      row.dayCredits += credits;
    }
    rows.set(owner, row);
  }

  return [...rows.values()]
    .filter((row) => !ownerFilter || row.owner === ownerFilter)
    .sort((a, b) => b.dayCredits - a.dayCredits || b.dayCount - a.dayCount || a.owner.localeCompare(b.owner, "zh-CN"));
}

function inferRegion(job) {
  const text = [job.batchName, job.scriptTitle, job.prompt, job.sceneName]
    .filter(Boolean)
    .join(" ");
  const regions = [
    "中国", "美国", "法国", "德国", "墨西哥", "日本", "韩国", "英国", "意大利", "西班牙",
    "俄罗斯", "泰国", "越南", "印度", "巴西", "迪拜", "中东", "欧洲", "东南亚"
  ];
  return regions.find((region) => text.includes(region)) || "未识别";
}

function getUsageBreakdown(groupBy) {
  const range = $("#usageRangeFilter")?.value || "all";
  const date = $("#usageDateFilter")?.value || getUsageDates()[0];
  const ownerFilter = $("#usageOwnerFilter")?.value || "";
  const rows = new Map();
  for (const job of state.jobs.filter(isUsageJob)) {
    if (!isDateInUsageRange(jobUsageDate(job), range, date)) continue;
    if (ownerFilter && usageOwnerLabel(job.owner) !== ownerFilter) continue;
    const key = groupBy === "region" ? inferRegion(job) : categoryLabel(job.category);
    const row = rows.get(key) || { name: key, count: 0, credits: 0 };
    row.count += 1;
    row.credits += jobUsageCredits(job);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.credits - a.credits || b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
}

function renderBreakdownCard(title, rows) {
  const maxCredits = Math.max(1, ...rows.map((row) => row.credits));
  return `
    <section class="breakdown-card">
      <h3>${escapeHtml(title)}</h3>
      <div class="breakdown-list">
        ${rows.length
          ? rows.slice(0, 8).map((row) => {
            const width = Math.max(4, Math.round((row.credits / maxCredits) * 100));
            return `
              <div class="breakdown-row">
                <div>
                  <strong>${escapeHtml(row.name)}</strong>
                  <span>${row.count} 条 · ${escapeHtml(formatCredits(row.credits))} 积分</span>
                </div>
                <i style="width:${width}%"></i>
              </div>
            `;
          }).join("")
          : `<div class="empty">暂无数据</div>`}
      </div>
    </section>
  `;
}

function getModelEfficiencyRows() {
  const range = $("#usageRangeFilter")?.value || "all";
  const date = $("#usageDateFilter")?.value || getUsageDates()[0];
  const ownerFilter = $("#usageOwnerFilter")?.value || "";
  const rows = new Map();
  for (const job of state.jobs) {
    if (!isDateInUsageRange(jobUsageDate(job), range, date)) continue;
    if (ownerFilter && usageOwnerLabel(job.owner) !== ownerFilter) continue;
    const key = modelLabel(job.model);
    const row = rows.get(key) || { name: key, count: 0, finished: 0, failed: 0, credits: 0 };
    row.count += 1;
    if (job.status === "finished") row.finished += 1;
    if (["failed", "submit_failed"].includes(job.status)) row.failed += 1;
    row.credits += jobUsageCredits(job);
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((row) => ({
      name: row.name,
      count: row.count,
      credits: row.credits,
      rate: row.finished + row.failed ? Math.round((row.finished / (row.finished + row.failed)) * 100) : 0
    }))
    .sort((a, b) => b.rate - a.rate || b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));
}

function renderEfficiencyCard(rows) {
  return `
    <section class="breakdown-card">
      <h3>模型成功率</h3>
      <div class="breakdown-list">
        ${rows.length
          ? rows.slice(0, 6).map((row) => `
            <div class="breakdown-row">
              <div>
                <strong>${escapeHtml(row.name)}</strong>
                <span>${row.count} 条 · ${row.rate || 0}%</span>
              </div>
              <i style="width:${Math.max(4, row.rate || 0)}%"></i>
            </div>
          `).join("")
          : `<div class="empty">暂无数据</div>`}
      </div>
    </section>
  `;
}

function renderUsageStats() {
  if (!$("#usageTable")) return;
  const { range, date } = syncUsageFilters();
  const rows = getUsageRows();
  const dayCount = rows.reduce((sum, row) => sum + row.dayCount, 0);
  const dayCredits = rows.reduce((sum, row) => sum + row.dayCredits, 0);
  const totalCredits = rows.reduce((sum, row) => sum + row.totalCredits, 0);
  const ownerFilter = $("#usageOwnerFilter")?.value || "";
  const dayJobs = state.jobs.filter((job) => {
    if (!isDateInUsageRange(jobUsageDate(job), range, date)) return false;
    return !ownerFilter || usageOwnerLabel(job.owner) === ownerFilter;
  });
  const decidedJobs = dayJobs.filter((job) => ["finished", "failed", "submit_failed"].includes(job.status));
  const successRate = decidedJobs.length
    ? `${Math.round((decidedJobs.filter((job) => job.status === "finished").length / decidedJobs.length) * 100)}%`
    : "暂无";

  $("#usageSummary").innerHTML = [
    ["当前日期", usageRangeLabel(range, date)],
    ["当天生成", `${dayCount} 条`],
    ["当天积分", formatCredits(dayCredits)],
    ["累计积分", formatCredits(totalCredits)],
    ["成功率", successRate]
  ]
    .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");

  const maxCredits = Math.max(1, ...rows.map((row) => row.dayCredits));
  $("#usageChart").innerHTML = rows.length
    ? rows
      .map((row, index) => {
        const height = row.dayCredits > 0 ? Math.max(6, Math.round((row.dayCredits / maxCredits) * 100)) : 0;
        return `
          <div class="usage-bar-item ${row.dayCredits > 0 ? "" : "zero"}">
            <div class="usage-bar-track">
              <span style="height:${height}%; background:${index % 2 ? "#17b7a6" : "#684cff"}"></span>
            </div>
            <strong>${escapeHtml(row.owner)}</strong>
            <em>${escapeHtml(formatCredits(row.dayCredits))}</em>
          </div>
        `;
      })
      .join("")
    : `<div class="empty">暂无积分数据</div>`;

  $("#usageBreakdowns").innerHTML = [
    renderBreakdownCard("分类汇总", getUsageBreakdown("category")),
    renderBreakdownCard("地区汇总", getUsageBreakdown("region")),
    renderEfficiencyCard(getModelEfficiencyRows())
  ].join("");

  $("#usageTable").innerHTML = rows.length
    ? rows
      .map((row) => `
        <tr>
          <td>${escapeHtml(row.owner)}</td>
          <td>${row.dayCount}</td>
          <td>${escapeHtml(formatCredits(row.dayCredits))}</td>
          <td>${escapeHtml(formatCredits(row.totalCredits))}</td>
        </tr>
      `)
      .join("")
    : `<tr><td colspan="4" class="empty">暂无积分数据</td></tr>`;
}

function exportUsageStatsCsv() {
  const range = $("#usageRangeFilter")?.value || "all";
  const date = $("#usageDateFilter")?.value || "";
  const headers = ["统计范围", "用户名", "生成条数", "消耗积分", "总积分消耗"];
  const escapeCsv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const lines = [
    headers.map(escapeCsv).join(","),
    ...getUsageRows().map((row) => [
      usageRangeLabel(range, date),
      row.owner,
      row.dayCount,
      formatCredits(row.dayCredits),
      formatCredits(row.totalCredits)
    ].map(escapeCsv).join(","))
  ];
  const blob = new Blob([`\ufeff${lines.join("\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `ai-tool-usage-${range}-${date || new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast("统计表已导出");
}

function jobInfoText(job) {
  const source = getJobVideoSource(job);
  return [
    `标题：${job.scriptTitle || ""}`,
    `使用人：${ownerLabel(job.owner)}`,
    `分类：${categoryLabel(job.category)}`,
    `批次：${job.batchName || ""}`,
    `模型：${modelLabel(job.model)}`,
    `状态：${statusLabels[job.status] || job.status}`,
    `参数：${job.duration}s / ${job.aspectRatio} / ${job.resolution || ""}`,
    `任务ID：${externalTaskId(job)}`,
    `视频：${source.src || ""}`,
    `错误：${job.errorMessage || job.lastRefreshError || ""}`,
    "",
    job.prompt || ""
  ].join("\n");
}

async function copyText(text, successMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(successMessage);
  } catch {
    toast("复制失败，请手动复制");
  }
}

async function syncWholePipeline() {
  const button = $("#syncAllBtn");
  const originalText = button?.textContent;
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "同步中";
    }
    await api("/api/jobs/refresh-active", { method: "POST" });
    try {
      const result = await api("/api/account/balance", { method: "POST" });
      state.accountBalance = result.accountBalance;
    } catch {
      // 业务链路刷新优先保证任务状态和视频链接，余额失败时仍继续刷新列表。
    }
    await loadState();
    if (currentUser?.role === "admin") await loadAccessRequests();
    toast("任务、视频链接和积分已同步");
  } catch (error) {
    toast(error.message);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function copyJobInfo(jobId) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return toast("没有找到这条任务");
  copyText(jobInfoText(job), "任务信息已复制");
}

function openJobDetail(jobId) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return toast("没有找到这条任务");
  currentDetailJobId = job.id;
  const source = getJobVideoSource(job);
  $("#jobDetailTitle").textContent = job.scriptTitle || "任务详情";
  $("#jobDetailMeta").textContent = `${modelLabel(job.model)} · ${statusLabels[job.status] || job.status}`;
  const rows = [
    ["使用人", ownerLabel(job.owner)],
    ["分类", categoryLabel(job.category)],
    ["批次", job.batchName || ""],
    ["模型", modelLabel(job.model)],
    ["状态", statusLabels[job.status] || job.status],
    ["参数", `${job.duration}s / ${job.aspectRatio}${job.resolution ? ` / ${job.resolution}` : ""}`],
    ["任务ID", externalTaskId(job) || "未提交"],
    ["预计积分", formatCredits(job.estimatedCredits ?? "")],
    ["实际积分", formatCredits(job.actualCredits ?? "")],
    ["视频链接", source.src || "暂无"],
    ["失败原因", job.errorMessage || job.lastRefreshError || "无"],
    ["处理建议", failureAdvice(job.errorMessage || job.lastRefreshError) || "无"],
    ["完整提示词", job.prompt || ""]
  ];
  $("#jobDetailBody").innerHTML = rows
    .map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`)
    .join("");
  $("#jobDetailModal").hidden = false;
}

function closeJobDetail() {
  $("#jobDetailModal").hidden = true;
  currentDetailJobId = null;
}

function openVideoPreview(jobId) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) {
    toast("没有找到这条任务");
    return;
  }
  const source = getJobVideoSource(job);
  if (!source.src) {
    toast("这条任务还没有可预览的视频");
    return;
  }

  const modal = $("#videoPreviewModal");
  const player = $("#videoPreviewPlayer");
  const title = $("#videoPreviewTitle");
  const meta = $("#videoPreviewMeta");
  const openLink = $("#videoPreviewOpen");
  const saveButton = $("#videoPreviewSave");

  modal.dataset.jobId = job.id;
  title.textContent = job.scriptTitle || "视频预览";
  const showResolution = Boolean(state.pricingRules?.[job.model]?.rates);
  meta.textContent = `${job.model} · ${job.duration}s · ${job.aspectRatio}${showResolution && job.resolution ? ` · ${job.resolution}` : ""}${job.imageUrls?.length || job.imageRefs?.length ? " · 参考图" : ""}`;
  player.src = source.src;
  player.load();
  openLink.href = source.src;
  saveButton.disabled = !source.src;
  modal.hidden = false;
}

function closeVideoPreview() {
  const modal = $("#videoPreviewModal");
  const player = $("#videoPreviewPlayer");
  player.pause();
  player.removeAttribute("src");
  player.load();
  modal.hidden = true;
  delete modal.dataset.jobId;
}

function openKeyModal() {
  $("#keyModal").hidden = false;
  setTimeout(() => $("#keyForm").elements.key.focus(), 0);
}

function closeKeyModal() {
  $("#keyModal").hidden = true;
}

function getCurrentView() {
  const hash = location.hash.replace("#", "");
  if (["jobs", "usage", "library", "keys"].includes(hash)) return hash;
  return "studio";
}

function updateViewFromHash() {
  const view = getCurrentView();
  document.body.dataset.view = view === "keys" ? "studio" : view;
  // Apple 风改版：只同步单一顶部导航的选中态，避免重复入口。
  $$(".view-tabs a").forEach((link) => {
    const target = link.getAttribute("href")?.replace("#", "") || "studio";
    const active = target === view || (view === "keys" && target === "keys");
    link.classList.toggle("active", active);
  });
  if (view === "keys") openKeyModal();
}

function renderStats() {
  const summary = makeFilteredSummary(filteredJobs());
  renderMiniTable("#byScript", summary.by("scriptTitle"));
}

function makeFilteredSummary(jobs) {
  return {
    by(field) {
      const map = new Map();
      for (const job of jobs) {
        const key = job[field] || "未填写";
        const row = map.get(key) || { key, total: 0, finished: 0, failed: 0 };
        row.total += 1;
        if (job.status === "finished") row.finished += 1;
        if (["failed", "submit_failed"].includes(job.status)) row.failed += 1;
        map.set(key, row);
      }
      return [...map.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key)).slice(0, 12);
    }
  };
}

function renderMiniTable(selector, rows) {
  const el = $(selector);
  if (!rows.length) {
    el.innerHTML = `<div class="empty">暂无</div>`;
    return;
  }
  el.innerHTML = rows
    .map(
      (row) => `
        <div class="mini-row" title="${escapeAttribute(row.key)}">
          <strong>${escapeHtml(row.key)}</strong>
          <span>${row.total}</span>
          <span>${row.finished}</span>
          <span>${row.failed}</span>
        </div>
      `
    )
    .join("");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function normalizeReferenceName(value, fallback = "图片") {
  return String(value || fallback).replace(/^@+/, "").replace(/\s+/g, "").slice(0, 20) || fallback;
}

function uniqueReferenceName(baseName, ignoreId = "") {
  const base = normalizeReferenceName(baseName, "图片");
  const used = new Set(uploadedImages.filter((image) => image.id !== ignoreId).map((image) => image.name));
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base}${index}`)) index += 1;
  return `${base}${index}`;
}

function inferReferenceRole(name = "") {
  if (/人物|人像|角色|脸|真人|女生|女人|男人|模特/.test(name)) return "person";
  if (/产品|商品|瓶|车|包|鞋|道具|物品/.test(name)) return "product";
  if (/风格|画风|色调|氛围|场景/.test(name)) return "style";
  return "reference";
}

function referenceRoleLabel(role = "reference") {
  return { person: "人物", product: "产品", style: "风格", reference: "参考" }[role] || "参考";
}

function getReferencedUploadedImages(prompt) {
  const names = [...String(prompt || "").matchAll(/@([\u4e00-\u9fa5A-Za-z0-9_\-]+)/g)]
    .map((match) => normalizeReferenceName(match[1], ""))
    .filter(Boolean);
  return uploadedImages.filter((image) => names.includes(normalizeReferenceName(image.name, "")));
}

function getReferenceCapabilities() {
  return currentModelProvider() === "ark"
    ? { maxReferenceImages: 9, message: "" }
    : { maxReferenceImages: 1, message: "当前 Sora/PoYo 接口只支持 1 张参考图" };
}

function canUploadReferenceForCurrentModel({ showToast = false } = {}) {
  const provider = currentModelProvider();
  const status = $("#uploadStatus");
  if (provider === "ark" && !state.hasArkKey) {
    const message = "Seedance 参考图需要先配置火山方舟 ARK Key";
    if (status) status.textContent = message;
    if (showToast) toast(message);
    return false;
  }
  if (provider === "poyo" && !state.hasPoyoKey) {
    const message = "Sora 参考图需要先配置 PoYo Key";
    if (status) status.textContent = message;
    if (showToast) toast(message);
    return false;
  }
  return true;
}

function updateImageUi({ busy = false } = {}) {
  const status = $("#uploadStatus");
  const previewList = $("#referencePreviewList");
  const clearButton = $("#clearImageBtn");
  const chooseButton = $("#chooseImageBtn");
  chooseButton.classList.toggle("disabled", busy);
  clearButton.disabled = busy || !uploadedImages.length;

  if (!uploadedImages.length) {
    if (busy) status.textContent = "正在上传...";
    else if (canUploadReferenceForCurrentModel()) status.textContent = "未上传图片";
    if (previewList) previewList.innerHTML = "";
    $("#batchForm").elements.imageUrl.value = "";
    return;
  }

  const capabilities = getReferenceCapabilities();
  const limitText = capabilities.maxReferenceImages < uploadedImages.length
    ? `；${capabilities.message}`
    : "";
  status.textContent = `${uploadedImages.length} 张图片已上传，可输入 @ 选择${limitText}`;
  if (previewList) {
    previewList.innerHTML = uploadedImages
      .map((image, index) => `
        <div class="reference-card" data-reference-id="${escapeAttribute(image.id)}">
          <button class="reference-thumb" type="button" data-insert-image-token="${escapeAttribute(image.id)}" title="插入 @${escapeAttribute(image.name)}">
            <img src="${escapeAttribute(image.previewDataUrl || image.file_url)}" alt="">
          </button>
          <div class="reference-fields">
            <input data-reference-name="${escapeAttribute(image.id)}" value="${escapeAttribute(image.name)}" aria-label="图片名称">
            <select data-reference-role="${escapeAttribute(image.id)}" aria-label="图片角色">
              <option value="reference" ${image.role === "reference" ? "selected" : ""}>参考</option>
              <option value="person" ${image.role === "person" ? "selected" : ""}>人物</option>
              <option value="product" ${image.role === "product" ? "selected" : ""}>产品</option>
              <option value="style" ${image.role === "style" ? "selected" : ""}>风格</option>
            </select>
          </div>
          <button class="reference-token" type="button" data-insert-image-token="${escapeAttribute(image.id)}">@${escapeHtml(image.name)}</button>
          <button class="reference-remove" type="button" data-remove-reference="${escapeAttribute(image.id)}">移除</button>
        </div>
      `)
      .join("");
    $$("[data-insert-image-token]").forEach((button) => {
      button.addEventListener("click", () => insertImageReference(button.dataset.insertImageToken));
    });
    $$("[data-reference-name]").forEach((input) => {
      input.addEventListener("change", () => {
        const image = uploadedImages.find((item) => item.id === input.dataset.referenceName);
        if (!image) return;
        const oldName = image.name;
        image.name = uniqueReferenceName(input.value, image.id);
        image.role = image.role === "reference" ? inferReferenceRole(image.name) : image.role;
        const prompt = $("#batchForm").elements.prompt;
        if (oldName && oldName !== image.name) {
          prompt.value = prompt.value.replaceAll(`@${oldName}`, `@${image.name}`);
        }
        updateImageUi();
        updateMentionMenu();
      });
    });
    $$("[data-reference-role]").forEach((select) => {
      select.addEventListener("change", () => {
        const image = uploadedImages.find((item) => item.id === select.dataset.referenceRole);
        if (!image) return;
        image.role = select.value;
        image.type = select.value;
        updateImageUi();
      });
    });
    $$("[data-remove-reference]").forEach((button) => {
      button.addEventListener("click", () => {
        uploadedImages = uploadedImages.filter((image) => image.id !== button.dataset.removeReference);
        uploadedImage = uploadedImages[uploadedImages.length - 1] || null;
        updateImageUi();
        updateMentionMenu();
      });
    });
  }
  $("#batchForm").elements.imageUrl.value = uploadedImages.map((image) => image.file_url).filter(Boolean).join(",");
}

function insertImageToken(index) {
  const image = uploadedImages[index - 1];
  insertImageReference(image?.id);
}

function insertImageReference(imageId) {
  const image = uploadedImages.find((item) => item.id === imageId);
  if (!image) return;
  const textarea = $("#batchForm").elements.prompt;
  const token = ` @${image.name} `;
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.value = `${textarea.value.slice(0, start)}${token}${textarea.value.slice(end)}`.replace(/[ \t]{3,}/g, "  ");
  const cursor = start + token.length;
  textarea.focus();
  textarea.setSelectionRange(cursor, cursor);
  hideMentionMenu();
  updateMatrixCount();
}

function getMentionQuery() {
  const textarea = $("#batchForm").elements.prompt;
  const cursor = textarea.selectionStart ?? 0;
  const before = textarea.value.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const query = before.slice(at + 1);
  if (/[\s，。,.!?！？;；:：]/.test(query)) return null;
  return { start: at, query };
}

function hideMentionMenu() {
  const menu = $("#mentionMenu");
  if (!menu) return;
  menu.hidden = true;
  menu.innerHTML = "";
  mentionStart = -1;
}

function selectMentionImage(imageId) {
  const image = uploadedImages.find((item) => item.id === imageId);
  const textarea = $("#batchForm").elements.prompt;
  if (!image || mentionStart < 0) return hideMentionMenu();
  const cursor = textarea.selectionStart ?? textarea.value.length;
  const token = `@${image.name} `;
  textarea.value = `${textarea.value.slice(0, mentionStart)}${token}${textarea.value.slice(cursor)}`;
  const nextCursor = mentionStart + token.length;
  textarea.focus();
  textarea.setSelectionRange(nextCursor, nextCursor);
  hideMentionMenu();
  updateMatrixCount();
}

function updateMentionMenu() {
  const menu = $("#mentionMenu");
  const mention = getMentionQuery();
  if (!menu || !mention || !uploadedImages.length) return hideMentionMenu();
  mentionStart = mention.start;
  const query = mention.query.toLowerCase();
  const matches = uploadedImages.filter((image) => image.name.toLowerCase().includes(query)).slice(0, 9);
  if (!matches.length) return hideMentionMenu();
  menu.innerHTML = matches.map((image) => `
    <button type="button" data-select-mention="${escapeAttribute(image.id)}">
      <img src="${escapeAttribute(image.previewDataUrl || image.file_url)}" alt="">
      <span>@${escapeHtml(image.name)}</span>
      <em>${escapeHtml(referenceRoleLabel(image.role))}</em>
    </button>
  `).join("");
  menu.hidden = false;
  $$("[data-select-mention]").forEach((button) => {
    button.addEventListener("click", () => selectMentionImage(button.dataset.selectMention));
  });
}

function currentModelProvider() {
  const model = $("#batchForm").elements.model.value;
  return state.pricingRules?.[model]?.provider === "ark" ? "ark" : "poyo";
}

async function uploadReferenceImage(file, { insertToken = true } = {}) {
  const model = $("#batchForm").elements.model.value;
  const provider = currentModelProvider();
  if (!canUploadReferenceForCurrentModel({ showToast: true })) return;
  const capabilities = getReferenceCapabilities();
  if (uploadedImages.length >= capabilities.maxReferenceImages) {
    toast(capabilities.message || `当前模型最多支持 ${capabilities.maxReferenceImages} 张参考图`);
    return;
  }
  if (!file) return;
  if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
    toast("只支持 PNG、JPEG、WebP 或 GIF");
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    toast("参考图不能超过 10MB");
    return;
  }

  try {
    updateImageUi({ busy: true });
    const dataUrl = await readFileAsDataUrl(file);
    const result = await api("/api/uploads/image", {
      method: "POST",
      body: JSON.stringify({ dataUrl, fileName: file.name, provider, model })
    });
    const index = uploadedImages.length + 1;
    const defaultNames = ["人物图", "产品图", "风格图"];
    const name = uniqueReferenceName(defaultNames[index - 1] || `图片${index}`);
    const role = inferReferenceRole(name);
    uploadedImages.push({
      id: `img_${Date.now()}_${index}`,
      name,
      role,
      type: role,
      ...result.file,
      previewDataUrl: dataUrl
    });
    uploadedImage = uploadedImages[uploadedImages.length - 1];
    updateImageUi();
    if (insertToken) insertImageReference(uploadedImage.id);
    toast(`参考图已上传：@${uploadedImage.name}`);
  } catch (error) {
    if (!uploadedImages.length) uploadedImage = null;
    updateImageUi();
    toast(error.message);
  }
}

async function saveCurrentPrompt() {
  const { title, prompt } = getCurrentPrompt();
  const defaultScene = "";
  const category = String($("#batchForm").elements.category?.value || "").trim();
  const owner = String($("#batchForm").elements.owner?.value || "").trim();
  const data = { title, prompt, defaultScene, category, owner };
  if (!prompt) {
    toast("请先填写视频提示词");
    return;
  }
  try {
    await api("/api/scripts", { method: "POST", body: JSON.stringify(data) });
    toast("提示词已保存");
    await loadState();
  } catch (error) {
    toast(error.message);
  }
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  try {
    const result = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: String(formData.get("username") || "").trim(),
        password: String(formData.get("password") || "").trim()
      })
    });
    currentUser = result.user;
    applyAuthState();
    form.reset();
    await loadState();
    if (currentUser?.role === "admin") await loadAccessRequests();
    toast("已登录");
  } catch (error) {
    toast(error.message);
  }
});

$("#applyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  try {
    await api("/api/access/apply", {
      method: "POST",
      body: JSON.stringify({
        name: String(formData.get("name") || "").trim(),
        username: String(formData.get("username") || "").trim(),
        password: String(formData.get("password") || "").trim(),
        contact: String(formData.get("contact") || "").trim()
      })
    });
    form.reset();
    toast("申请已提交，等待管理员批准");
  } catch (error) {
    toast(error.message);
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
  } catch {
    // 新增登录授权：退出失败时也清本地状态，避免界面继续显示为已登录。
  }
  currentUser = null;
  applyAuthState();
  toast("已退出");
});

$("#refreshAccessBtn").addEventListener("click", loadAccessRequests);
$("#accessRequestList").addEventListener("click", (event) => {
  const approveButton = event.target.closest("[data-approve-request]");
  if (approveButton) return handleAccessDecision(approveButton.dataset.approveRequest, "approve");
  const rejectButton = event.target.closest("[data-reject-request]");
  if (rejectButton) return handleAccessDecision(rejectButton.dataset.rejectRequest, "reject");
});

$("#savePromptBtn").addEventListener("click", saveCurrentPrompt);
$("#chooseImageBtn").addEventListener("click", (event) => {
  if (!canUploadReferenceForCurrentModel({ showToast: true })) {
    event.preventDefault();
  }
});
$("#referenceImageInput").addEventListener("change", async (event) => {
  const capabilities = getReferenceCapabilities();
  const remaining = capabilities.maxReferenceImages - uploadedImages.length;
  if (remaining <= 0) {
    toast(capabilities.message || `当前模型最多支持 ${capabilities.maxReferenceImages} 张参考图`);
    event.currentTarget.value = "";
    return;
  }
  const files = [...(event.currentTarget.files || [])].slice(0, remaining);
  for (const [index, file] of files.entries()) {
    await uploadReferenceImage(file, { insertToken: index === 0 });
  }
  event.currentTarget.value = "";
});
$("#clearImageBtn").addEventListener("click", () => {
  uploadedImage = null;
  uploadedImages = [];
  updateImageUi();
  toast("参考图已移除");
});
$("#closePreviewBtn").addEventListener("click", closeVideoPreview);
$$("[data-close-preview]").forEach((element) => {
  element.addEventListener("click", closeVideoPreview);
});
$("#closeKeyModalBtn").addEventListener("click", closeKeyModal);
$$("[data-close-key]").forEach((element) => {
  element.addEventListener("click", closeKeyModal);
});
$("#cancelConfirmBtn").addEventListener("click", () => closeConfirmModal(false));
$("#confirmActionBtn").addEventListener("click", () => closeConfirmModal(true));
$$("[data-close-confirm]").forEach((element) => {
  element.addEventListener("click", () => closeConfirmModal(false));
});
$("#closeDetailBtn").addEventListener("click", closeJobDetail);
$$("[data-close-detail]").forEach((element) => {
  element.addEventListener("click", closeJobDetail);
});
$("#copyDetailBtn").addEventListener("click", () => {
  if (currentDetailJobId) copyJobInfo(currentDetailJobId);
});
function downloadJobVideo(jobId) {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return toast("没有找到这条任务");
  const source = getJobVideoSource(job);
  if (!source.src) return toast("这条任务还没有可保存的视频");
  const link = document.createElement("a");
  link.href = `/api/jobs/${encodeURIComponent(jobId)}/download-file`;
  link.download = safeDownloadFilename(job);
  document.body.append(link);
  link.click();
  link.remove();
  toast("已开始下载");
}

function bulkDownloadSelectedVideos() {
  const jobs = [...selectedJobIds]
    .map((id) => state.jobs.find((job) => job.id === id))
    .filter(Boolean)
    .filter((job) => getJobVideoSource(job).src);
  if (!jobs.length) return toast("选中的任务里没有可保存的视频");

  jobs.forEach((job, index) => {
    setTimeout(() => {
      const link = document.createElement("a");
      link.href = `/api/jobs/${encodeURIComponent(job.id)}/download-file`;
      link.download = safeDownloadFilename(job);
      document.body.append(link);
      link.click();
      link.remove();
    }, index * 250);
  });
  toast(`已开始下载 ${jobs.length} 个视频`);
}

$("#videoPreviewSave").addEventListener("click", () => {
  const jobId = $("#videoPreviewModal").dataset.jobId;
  if (!jobId) return;
  downloadJobVideo(jobId);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#videoPreviewModal").hidden) closeVideoPreview();
  if (event.key === "Escape" && !$("#keyModal").hidden) closeKeyModal();
  if (event.key === "Escape" && !$("#confirmModal").hidden) closeConfirmModal(false);
  if (event.key === "Escape" && !$("#jobDetailModal").hidden) closeJobDetail();
});

$("#keyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const key = String(new FormData(form).get("key") || "").trim();
  try {
    await api("/api/settings/poyo-key", { method: "POST", body: JSON.stringify({ key }) });
    form.reset();
    toast("PoYo Key 已保存并更新");
    await loadState();
  } catch (error) {
    toast(error.message);
  }
});

$("#arkKeyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const key = String(new FormData(form).get("key") || "").trim();
  try {
    await api("/api/settings/ark-key", { method: "POST", body: JSON.stringify({ key }) });
    form.reset();
    toast("火山 Key 已保存并更新");
    await loadState();
  } catch (error) {
    toast(error.message);
  }
});

$("#volcAkSkForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const accessKeyId = String(formData.get("accessKeyId") || "").trim();
  const secretAccessKey = String(formData.get("secretAccessKey") || "").trim();
  try {
    await api("/api/settings/volc-aksk", {
      method: "POST",
      body: JSON.stringify({ accessKeyId, secretAccessKey })
    });
    form.reset();
    toast("火山企业 AK/SK 已保存并更新");
    await loadState();
  } catch (error) {
    toast(error.message);
  }
});

async function submitBatchPayload(payload) {
  const submitButton = payload.submitNow
    ? $("#batchForm button[name='submitNow']")
    : [...$$("#batchForm button[type='submit']")].find((button) => !button.name);
  const originalText = submitButton?.textContent;
  try {
    if (submitButton) {
      submitButton.disabled = true;
      submitButton.classList.add("loading");
      submitButton.textContent = payload.submitNow ? "提交中" : "保存中";
    }
    const result = await api("/api/batches", { method: "POST", body: JSON.stringify(payload) });
    toast(payload.submitNow ? `任务已进入队列：${result.jobs.length} 条` : `草稿已保存：${result.jobs.length} 条`);
    await loadState();
  } catch (error) {
    toast(error.message);
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.classList.remove("loading");
      submitButton.textContent = originalText;
    }
  }
}

$("#batchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitter = event.submitter;
  const form = event.currentTarget;
  const formData = new FormData(form);
  const prompt = String(formData.get("prompt") || "").trim();
  if (!prompt) {
    toast("请先填写视频提示词");
    return;
  }
  const referencedImages = getReferencedUploadedImages(prompt);
  if (uploadedImages.length && !referencedImages.length) {
    toast("已上传参考图，请在提示词里输入 @ 选择要使用的图片");
    form.elements.prompt.focus();
    return;
  }
  const owner = String(formData.get("owner") || "").trim();
  if (!owner) {
    toast("请先选择使用人");
    form.elements.owner.focus();
    return;
  }
  let scriptId = state.scripts.find((script) => script.prompt === prompt)?.id;
  if (!scriptId) {
    try {
      const created = await api("/api/scripts", {
        method: "POST",
        body: JSON.stringify({
          title: String(formData.get("name") || "").trim() || "未命名提示词",
          prompt,
          defaultScene: "",
          category: String(formData.get("category") || "").trim(),
          owner
        })
      });
      scriptId = created.script.id;
    } catch (error) {
      toast(error.message);
      return;
    }
  }
  const payload = {
    name: String(formData.get("name") || "").trim(),
    scriptIds: [scriptId],
    scenes: [],
    languages: [],
    model: formData.get("model"),
    duration: Number(formData.get("duration")),
    aspectRatio: formData.get("aspectRatio"),
    resolution: formData.get("resolution"),
    variantsPerCombination: Number(formData.get("variantsPerCombination") || 1),
    owner,
    category: String(formData.get("category") || "").trim(),
    imageUrls: referencedImages.map((image) => image.file_url).filter(Boolean),
    imageRefs: referencedImages.map((image) => ({
      provider: image.provider || (state.pricingRules?.[formData.get("model")]?.provider === "ark" ? "ark" : "poyo"),
      id: image.id || "",
      name: image.name || "",
      role: image.role || "reference",
      type: image.type || image.role || "reference",
      file_id: image.file_id || "",
      file_url: image.file_url || "",
      file_name: image.file_name || ""
    })).filter((image) => image.file_id || image.file_url),
    referenceMode: referencedImages.length && state.pricingRules?.[formData.get("model")]?.provider === "ark" ? "reference_image" : "",
    submitNow: submitter?.name === "submitNow"
  };
  if (payload.submitNow) {
    const unitCredits = estimateUnitCredits(payload);
    const totalJobs = Math.max(1, Number(payload.variantsPerCombination || 1));
    const ok = await confirmAction({
      title: "确认提交生成",
      meta: "提交后会调用对应平台生成视频，可能消耗额度。",
      rows: [
        ["模型", modelLabel(payload.model)],
        ["使用人", ownerLabel(payload.owner)],
        ["条数", `${totalJobs} 条`],
        ["参数", `${payload.duration}s / ${payload.aspectRatio} / ${payload.resolution}`],
        ["分类", categoryLabel(payload.category)],
        ["参考图", payload.imageRefs.length || payload.imageUrls.length ? "已上传" : "无"],
        ["预计积分", unitCredits === null ? "待确认" : formatCredits(unitCredits * totalJobs)]
      ]
    });
    if (!ok) return;
  }
  await submitBatchPayload(payload);
});

$("#batchForm").elements.prompt.addEventListener("input", updateMatrixCount);
$("#batchForm").elements.prompt.addEventListener("input", updateMentionMenu);
$("#batchForm").elements.prompt.addEventListener("click", updateMentionMenu);
$("#batchForm").elements.prompt.addEventListener("keyup", updateMentionMenu);
$("#batchForm").elements.prompt.addEventListener("keydown", (event) => {
  const menu = $("#mentionMenu");
  if (event.key === "Escape" && menu && !menu.hidden) {
    event.preventDefault();
    hideMentionMenu();
  }
  if (event.key === "Enter" && menu && !menu.hidden) {
    const first = menu.querySelector("[data-select-mention]");
    if (first) {
      event.preventDefault();
      selectMentionImage(first.dataset.selectMention);
    }
  }
});
$("#batchForm").elements.name.addEventListener("input", updateMatrixCount);
$("#batchForm").elements.variantsPerCombination.addEventListener("input", updateMatrixCount);
$("#batchForm").elements.model.addEventListener("change", () => {
  const provider = currentModelProvider();
  if (uploadedImages.some((image) => (image.provider || "poyo") !== provider)) {
    uploadedImage = null;
    uploadedImages = [];
    updateImageUi();
    toast(provider === "ark" ? "已切换到火山模型，请重新上传火山参考图" : "已切换到 Sora，请重新上传 PoYo 参考图");
  }
  renderDurationOptions();
  renderResolutionOptions();
  updateSubmitState();
  updateImageUi();
  renderCostPreview();
});
$("#batchForm").elements.duration.addEventListener("change", renderCostPreview);
$("#batchForm").elements.resolution.addEventListener("change", renderCostPreview);
$("#batchFilter").addEventListener("change", () => {
  renderJobs();
  renderStats();
});
$("#statusFilter").addEventListener("change", () => {
  renderJobs();
  renderStats();
});
$("#ownerFilter").addEventListener("change", () => {
  renderJobs();
  renderStats();
});
$("#jobDateFilter").addEventListener("change", () => {
  renderJobs();
  renderStats();
});
$("#usageRangeFilter").addEventListener("change", renderUsageStats);
$$("[data-usage-range]").forEach((button) => {
  button.addEventListener("click", () => {
    $("#usageRangeFilter").value = button.dataset.usageRange;
    renderUsageStats();
  });
});
$("#usageDateFilter").addEventListener("change", renderUsageStats);
$("#usageOwnerFilter").addEventListener("change", renderUsageStats);
$("#scriptSearchInput").addEventListener("input", renderScripts);
$("#scriptCategoryFilter").addEventListener("change", renderScripts);
$("#searchInput").addEventListener("input", () => {
  renderJobs();
  renderStats();
});
$("#mineOnlyToggle").checked = localStorage.getItem(MINE_ONLY_STORAGE_KEY) === "1";
$("#mineOnlyToggle").addEventListener("change", (event) => {
  localStorage.setItem(MINE_ONLY_STORAGE_KEY, event.currentTarget.checked ? "1" : "0");
  renderJobs();
  renderStats();
});
$("#selectAllJobs").addEventListener("change", (event) => {
  const jobs = filteredJobs();
  if (event.currentTarget.checked) {
    jobs.forEach((job) => selectedJobIds.add(job.id));
  } else {
    jobs.forEach((job) => selectedJobIds.delete(job.id));
  }
  renderJobs();
});
$("#bulkRefreshBtn").addEventListener("click", () => runBulkAction("refresh", "已批量刷新"));
$("#bulkSaveBtn").addEventListener("click", bulkDownloadSelectedVideos);
$("#retryFailedBtn").addEventListener("click", retryFailedJobs);
$("#selectFinishedBtn").addEventListener("click", () => {
  selectedJobIds.clear();
  filteredJobs()
    .filter((job) => getJobVideoSource(job).src)
    .forEach((job) => selectedJobIds.add(job.id));
  renderJobs();
  toast(selectedJobIds.size ? `已选择 ${selectedJobIds.size} 条可保存任务` : "当前筛选下没有已完成视频");
});
$("#bulkDeleteBtn").addEventListener("click", () => runBulkAction("delete", "已批量删除"));
$("#syncAllBtn").addEventListener("click", syncWholePipeline);
$("#exportCsvBtn").addEventListener("click", exportFilteredJobsCsv);
$("#exportUsageCsvBtn").addEventListener("click", exportUsageStatsCsv);
$("#reloadBtn").addEventListener("click", () => {
  // 体验优化：顶部“刷新”执行真正页面刷新，并自动带版本参数，避免浏览器继续显示旧布局。
  const url = new URL(window.location.href);
  url.searchParams.set("v", String(Date.now()));
  window.location.href = `${url.pathname}${url.search}${url.hash || "#studio"}`;
});
$("#configureKeyBtn").addEventListener("click", openKeyModal);
$("#syncBalanceBtn").addEventListener("click", async () => {
  try {
    const result = await api("/api/account/balance", { method: "POST" });
    state.accountBalance = result.accountBalance;
    toast(`积分已同步：${formatCredits(result.accountBalance?.credits)}`);
  } catch (error) {
    toast(error.message);
  } finally {
    await loadState();
  }
});
$("#refreshActiveBtn").addEventListener("click", async () => {
  try {
    await api("/api/jobs/refresh-active", { method: "POST" });
    toast("进行中任务已刷新");
  } catch (error) {
    toast(error.message);
  } finally {
    await loadState();
  }
});

window.addEventListener("hashchange", () => {
  updateViewFromHash();
});

async function init() {
  try {
    await loadSession();
    if (currentUser) {
      await loadState();
      updateViewFromHash();
    }
  } catch (error) {
    currentUser = null;
    applyAuthState();
    toast(error.message);
  }
}

init();

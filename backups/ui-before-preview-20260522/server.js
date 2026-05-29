import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const BASE_URL = "https://api.poyo.ai";
const ARK_BASE_URL = "https://ark.cn-beijing.volces.com";
const STORE_PATH = path.join(__dirname, "data", "store.json");
const OUTPUT_DIR = path.join(__dirname, "outputs");
const DEFAULT_OWNERS = ["朱浩权", "胡敏", "曾帆"];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

const PRICING_RULES = {
  "sora-2-official": {
    label: "Sora 2 Official",
    billing: "duration_tier",
    durationOptions: [4, 8, 12, 16, 20],
    resolutionOptions: ["720p"],
    durations: { 4: 48, 8: 96, 12: 144, 16: 192, 20: 240 },
    description: "按时长固定计费，适合常规成片"
  },
  "ark-seedance-2-pro": {
    label: "Seedance 2.0 Pro 官方",
    provider: "ark",
    modelId: "doubao-seedance-2-0-pro-260215",
    billing: "resolution_per_second",
    durationOptions: [5, 10, 15],
    resolutionOptions: ["480p", "720p", "1080p"],
    rates: { "480p": 20, "720p": 40, "1080p": 90 },
    description: "火山方舟官方直连，异步视频任务"
  },
  "ark-seedance-2-fast": {
    label: "Seedance 2.0 Fast 官方",
    provider: "ark",
    modelId: "doubao-seedance-2-0-fast-260128",
    billing: "resolution_per_second",
    durationOptions: [5, 10, 15],
    resolutionOptions: ["480p", "720p"],
    rates: { "480p": 14, "720p": 28 },
    description: "火山方舟官方快速版，适合低成本草稿迭代"
  }
};

const BALANCE_PATH_CANDIDATES = [
  "/api/user/balance",
  "/api/common/user/balance",
  "/api/common/balance",
  "/api/account/balance",
  "/api/common/account/balance",
  "/api/common/user-balance"
];

await loadLocalEnv();

function createEmptyStore() {
  return {
    version: 1,
    accountBalance: null,
    // 新增登录授权：账号、申请和会话继续保存在本地 JSON，避免为了内部工具额外上数据库。
    users: [],
    accessRequests: [],
    sessions: [],
    scripts: [],
    batches: [],
    jobs: []
  };
}

async function loadLocalEnv() {
  for (const name of [".env.local", ".env"]) {
    const filePath = path.join(__dirname, name);
    try {
      const content = await fs.readFile(filePath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const index = trimmed.indexOf("=");
        if (index === -1) continue;
        const key = trimmed.slice(0, index).trim();
        const rawValue = trimmed.slice(index + 1).trim();
        if (!process.env[key]) {
          process.env[key] = rawValue.replace(/^["']|["']$/g, "");
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function readStore() {
  try {
    const content = await fs.readFile(STORE_PATH, "utf8");
    return { ...createEmptyStore(), ...JSON.parse(content) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const store = createEmptyStore();
    await writeStore(store);
    return store;
  }
}

async function writeStore(store) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const tempPath = `${STORE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`);
  await fs.rename(tempPath, STORE_PATH);
}

async function writeLocalEnvValue(name, value) {
  const envPath = path.join(__dirname, ".env.local");
  let content = "";
  try {
    content = await fs.readFile(envPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const lines = content.split(/\r?\n/);
  let replaced = false;
  const nextLines = lines
    .filter((line, index) => !(index === lines.length - 1 && line === ""))
    .map((line) => {
      if (line.trim().startsWith(`${name}=`)) {
        replaced = true;
        return `${name}=${value}`;
      }
      return line;
    });

  if (!replaced) nextLines.push(`${name}=${value}`);
  await fs.writeFile(envPath, `${nextLines.join("\n")}\n`, { mode: 0o600 });
  process.env[name] = value;
}

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

function jsonResponse(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...headers
  });
  res.end(payload);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const nextHash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256");
  const savedHash = Buffer.from(hash, "hex");
  return savedHash.length === nextHash.length && crypto.timingSafeEqual(savedHash, nextHash);
}

function safeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    status: user.status
  };
}

function getOwnerOptions(store) {
  // 体验优化：使用人名单由“固定核心成员 + 已授权账号”统一生成，避免批准账号后还要手动改页面。
  const owners = new Set(DEFAULT_OWNERS);
  for (const user of store.users || []) {
    if (user.status !== "active") continue;
    const label = sanitizeString(user.name) || sanitizeString(user.username);
    if (label && user.role !== "admin") owners.add(label);
  }
  return [...owners].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function ensureAccessStore(store) {
  let changed = false;
  if (!Array.isArray(store.users)) {
    store.users = [];
    changed = true;
  }
  if (!Array.isArray(store.accessRequests)) {
    store.accessRequests = [];
    changed = true;
  }
  if (!Array.isArray(store.sessions)) {
    store.sessions = [];
    changed = true;
  }
  if (!store.users.length) {
    // 新增登录授权：首次启动自动生成管理员，保证本地工具不会因为没有后台账号而锁死。
    store.users.push({
      id: id("user"),
      username: "admin",
      name: "管理员",
      role: "admin",
      status: "active",
      passwordHash: hashPassword(process.env.FYAI_ADMIN_PASSWORD || "FYAI2026!"),
      createdAt: now(),
      updatedAt: now()
    });
    changed = true;
  }
  return changed;
}

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        return index === -1
          ? [decodeURIComponent(item), ""]
          : [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))];
      })
  );
}

function isLocalRequest(req) {
  const host = String(req.headers.host || "").split(":")[0];
  const remote = req.socket?.remoteAddress || "";
  return ["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(host)
    || remote === "127.0.0.1"
    || remote === "::1"
    || remote === "::ffff:127.0.0.1";
}

function getLocalAdminUser(store, req) {
  // 本机免登录：只有当前电脑用 127.0.0.1 / localhost 打开时自动进入，局域网访问仍需账号授权。
  if (!isLocalRequest(req)) return null;
  return store.users.find((item) => item.role === "admin" && item.status === "active") || store.users[0] || null;
}

function getSessionUser(store, req) {
  const localUser = getLocalAdminUser(store, req);
  if (localUser) return localUser;
  const token = parseCookies(req).fyai_session;
  if (!token) return null;
  const session = store.sessions.find((item) => item.token === token);
  if (!session || new Date(session.expiresAt).getTime() < Date.now()) return null;
  const user = store.users.find((item) => item.id === session.userId && item.status === "active");
  return user || null;
}

function createSession(store, user) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  store.sessions = store.sessions.filter((item) => item.userId !== user.id);
  store.sessions.push({ token, userId: user.id, createdAt: now(), expiresAt });
  return { token, expiresAt };
}

function sessionCookie(token, maxAge = 14 * 24 * 60 * 60) {
  return `fyai_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

function textResponse(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON body");
    error.status = 400;
    throw error;
  }
}

function requirePoyoKey() {
  const key = process.env.POYO_API_KEY;
  if (!key) {
    const error = new Error("Missing POYO_API_KEY. Put it in .env.local or start with POYO_API_KEY=...");
    error.status = 400;
    throw error;
  }
  return key;
}

function requireArkKey() {
  const key = process.env.ARK_API_KEY;
  if (!key) {
    const error = new Error("未配置火山方舟 ARK Key。请先打开平台密钥保存 ARK_API_KEY。");
    error.status = 400;
    throw error;
  }
  return key;
}

function sanitizeString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function sanitizeInt(value, allowed, fallback) {
  const number = Number(value);
  return allowed.includes(number) ? number : fallback;
}

function normalizeModel(value) {
  const allowed = Object.keys(PRICING_RULES);
  return allowed.includes(value) ? value : "sora-2-official";
}

function getModelRule(model) {
  return PRICING_RULES[model] || PRICING_RULES["sora-2-official"];
}

function getModelProvider(model) {
  return getModelRule(model).provider || "poyo";
}

function getProviderCapabilities(provider) {
  return ImageGenerationProvider[provider]?.capabilities || ImageGenerationProvider.poyo.capabilities;
}

function getExternalTaskId(job) {
  return job.arkTaskId || job.poyoTaskId || job.externalTaskId || null;
}

function explainFailure(error) {
  const message = error?.message || String(error || "未知错误");
  const lower = message.toLowerCase();
  if (error?.status === 401 || lower.includes("unauthorized") || lower.includes("invalid api key")) {
    return "密钥无效或已过期。请到平台密钥里重新保存对应平台的 Key。";
  }
  if (error?.status === 403 || lower.includes("forbidden") || lower.includes("permission")) {
    return "账号没有这个模型的调用权限，或模型服务没有开通。请在对应平台控制台确认模型权限。";
  }
  if (lower.includes("safe experience mode") || lower.includes("inference limit") || lower.includes("安心体验")) {
    return "火山方舟账号已达到安心体验模式的模型调用上限，模型服务被自动暂停。请到火山模型开通/体验模式页面调整或关闭限制后再试。";
  }
  if (error?.status === 402 || lower.includes("余额") || lower.includes("quota") || lower.includes("insufficient")) {
    return "余额或额度不足。请先检查平台余额/免费额度。";
  }
  if (error?.status === 400 || lower.includes("invalid") || lower.includes("unsupported")) {
    return `参数可能不被当前模型支持：${message}`;
  }
  if (lower.includes("fetch failed") || lower.includes("econn") || lower.includes("timeout")) {
    return "网络连接失败。请检查本机网络，或稍后重试。";
  }
  return message;
}

function estimateCredits({ model, duration, resolution }) {
  const rule = PRICING_RULES[model];
  if (!rule) return null;
  if (rule.billing === "duration_tier") return rule.durations[Number(duration)] ?? null;
  if (rule.billing === "resolution_per_second") {
    const fallbackResolution = rule.resolutionOptions?.[0] || "1024p";
    const fallbackDuration = rule.durationOptions?.[0] || 4;
    const rate = rule.rates[resolution || fallbackResolution];
    return rate ? rate * Number(duration || fallbackDuration) : null;
  }
  if (rule.billing === "flat") return rule.credits;
  return null;
}

function estimateTotalCredits(jobs) {
  return jobs.reduce((sum, job) => sum + (Number(job.estimatedCredits) || 0), 0);
}

function buildPrompt(script, scene, language, variantIndex = 1, variantsPerCombination = 1) {
  const parts = [
    script.prompt,
    scene.name ? `Scene: ${scene.name}` : "",
    scene.detail ? `Scene details: ${scene.detail}` : "",
    language.name ? `Language: ${language.name}` : "",
    language.note ? `Language notes: ${language.note}` : "",
    variantsPerCombination > 1 ? `Creative variation: ${variantIndex} of ${variantsPerCombination}. Keep the same message, but make this take visually distinct from the other variations.` : "",
    "If there is dialogue, narration, captions, or visible text, localize it into the selected language while keeping the original message."
  ];
  return parts.filter(Boolean).join("\n\n");
}

function parseLines(lines, mapper) {
  if (!Array.isArray(lines)) return [];
  return lines.map(mapper).filter(Boolean);
}

function findJob(store, jobId) {
  const job = store.jobs.find((item) => item.id === jobId);
  if (!job) {
    const error = new Error("Job not found");
    error.status = 404;
    throw error;
  }
  return job;
}

function safeDownloadName(job, extension = ".mp4") {
  const parts = [
    sanitizeString(job.owner, "未填写"),
    sanitizeString(job.category, "未分类"),
    sanitizeString(job.batchName, job.id)
  ];
  const title = parts
    .filter(Boolean)
    .join("--")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return `${title || job.id}${extension || ".mp4"}`;
}

function downloadDisposition(filename) {
  const fallback = filename
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 160) || "video.mp4";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function poyoFetch(pathname, options = {}) {
  const key = requirePoyoKey();
  const response = await fetch(`${BASE_URL}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(body?.detail || body?.message || `PoYo request failed: ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function arkFetch(pathname, options = {}) {
  const key = requireArkKey();
  const response = await fetch(`${ARK_BASE_URL}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || body?.detail || `火山方舟请求失败：${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function parseImageDataUrl(dataUrl) {
  const match = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!match) {
    const error = new Error("只支持 JPEG、PNG、WebP 或 GIF 图片");
    error.status = 400;
    throw error;
  }
  const rawBytes = Buffer.from(match[2], "base64");
  if (!rawBytes.length) {
    const error = new Error("图片文件为空");
    error.status = 400;
    throw error;
  }
  if (rawBytes.byteLength > 10 * 1024 * 1024) {
    const error = new Error("参考图不能超过 10MB");
    error.status = 400;
    throw error;
  }
  return { mimeType: match[1], rawBytes };
}

async function uploadImageToPoyo({ dataUrl, fileName }) {
  parseImageDataUrl(dataUrl);

  const response = await poyoFetch("/api/common/upload/base64", {
    method: "POST",
    body: JSON.stringify({
      base64_data: dataUrl,
      file_name: sanitizeString(fileName, "reference-image.png"),
      upload_path: "sora-reference-images"
    })
  });
  const file = response.data || {};
  if (!file.file_url) {
    const error = new Error("图片已上传，但 PoYo 没有返回可用链接");
    error.status = 502;
    throw error;
  }
  return {
    provider: "poyo",
    file_url: file.file_url,
    file_name: file.file_name || sanitizeString(fileName, "reference-image.png"),
    raw: file
  };
}

async function uploadImageToArk({ dataUrl, fileName }) {
  const { mimeType, rawBytes } = parseImageDataUrl(dataUrl);
  const form = new FormData();
  form.set("purpose", "user_data");
  form.set("file", new Blob([rawBytes], { type: mimeType }), sanitizeString(fileName, "reference-image.png"));

  const response = await fetch(`${ARK_BASE_URL}/api/v3/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireArkKey()}`
    },
    body: form
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.message || body?.detail || `火山方舟文件上传失败：${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  const file = body?.data || body || {};
  const fileId = file.id || file.file_id;
  const fileUrl = file.url || file.file_url || file.download_url || "";
  if (!fileId && !fileUrl) {
    const error = new Error("图片已上传，但火山方舟没有返回可用文件 ID");
    error.status = 502;
    throw error;
  }
  return {
    provider: "ark",
    file_id: fileId || "",
    file_url: fileUrl,
    file_name: file.filename || file.file_name || sanitizeString(fileName, "reference-image.png"),
    raw: file
  };
}

function extractBalanceValue(body) {
  const candidates = [
    body?.data?.balance,
    body?.data?.credits,
    body?.data?.credit,
    body?.data?.credits_amount,
    body?.data?.available_credits,
    body?.data?.remaining_credits,
    body?.data?.user?.balance,
    body?.data?.user?.credits,
    body?.balance,
    body?.credits,
    body?.credit,
    body?.available_credits,
    body?.remaining_credits
  ];
  for (const value of candidates) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

async function queryPoyoBalance() {
  const errors = [];
  for (const pathname of BALANCE_PATH_CANDIDATES) {
    try {
      const body = await poyoFetch(pathname);
      const balance = extractBalanceValue(body);
      if (balance !== null) {
        return {
          credits: balance,
          endpoint: pathname,
          fetchedAt: now(),
          rawShape: Object.keys(body?.data || body || {}).slice(0, 12)
        };
      }
      errors.push(`${pathname}: no balance field`);
    } catch (error) {
      errors.push(`${pathname}: ${error.status || ""} ${error.message}`.trim());
    }
  }
  const error = new Error("无法同步 PoYo 余额，请稍后重试或在 PoYo 后台确认积分。");
  error.status = 502;
  error.details = errors;
  throw error;
}

async function refreshBalanceIntoStore(store) {
  const balance = await queryPoyoBalance();
  store.accountBalance = balance;
  return balance;
}

async function checkBalanceForCredits(store, requiredCredits) {
  if (!process.env.POYO_API_KEY || !requiredCredits) return { ok: true, balance: null };
  try {
    const balance = await refreshBalanceIntoStore(store);
    if (Number.isFinite(balance.credits) && balance.credits < requiredCredits) {
      return { ok: false, balance, error: `PoYo 余额不足：当前 ${balance.credits}，本次预计 ${requiredCredits}` };
    }
    return { ok: true, balance };
  } catch (error) {
    return { ok: true, balance: null, warning: error.message };
  }
}

function buildPoyoBody(job) {
  const parsed = parsePromptReferences(job.prompt, normalizeImageRefs(job));
  const input = {
    prompt: parsed.cleanPrompt,
    duration: job.duration,
    aspect_ratio: job.aspectRatio
  };
  if (PRICING_RULES[job.model]?.rates) input.resolution = job.resolution;
  const imageUrls = parsed.references.map((item) => item.file_url).filter(Boolean);
  if (imageUrls.length) input.image_urls = imageUrls.slice(0, 1);

  return {
    model: job.model,
    input
  };
}

function mapArkStatus(status) {
  const value = String(status || "").toLowerCase();
  if (["succeeded", "success", "completed", "finished"].includes(value)) return "finished";
  if (["failed", "error", "canceled", "cancelled"].includes(value)) return "failed";
  if (["running", "processing", "generating"].includes(value)) return "running";
  if (["pending", "queued", "created", "submitted"].includes(value)) return "not_started";
  return value || "not_started";
}

function arkRatio(aspectRatio) {
  if (aspectRatio === "9:16" || aspectRatio === "16:9") return aspectRatio;
  return "16:9";
}

function inferArkImageSubjectType(prompt, tokenIndex) {
  const text = String(prompt || "");
  const token = `@图片${tokenIndex + 1}`;
  const index = text.indexOf(token);
  const near = index >= 0 ? text.slice(Math.max(0, index - 80), index + token.length + 120) : text;
  return /人物|角色|真人|人像|脸|面部|女生|女人|女孩|男性|男人|男孩|姿势|表情|穿着|发型|白人|黑人|亚洲人/.test(near)
    ? "person"
    : "";
}

function normalizeReferenceName(value, fallback) {
  return sanitizeString(value, fallback).replace(/^@+/, "").replace(/\s+/g, "");
}

function inferReferenceRole(name, prompt = "") {
  const text = `${name} ${prompt}`;
  if (/人物|人像|角色|脸|面部|真人|女孩|女生|女人|男性|男人|模特/.test(text)) return "person";
  if (/产品|商品|瓶|包|鞋|车|道具|物品/.test(text)) return "product";
  if (/风格|画风|参考|质感|色调|氛围|场景/.test(text)) return "style";
  return "reference";
}

function normalizeImageRefs(job) {
  if (Array.isArray(job.imageRefs) && job.imageRefs.length) {
    return job.imageRefs
      .map((item) => {
        if (typeof item === "string") return { provider: "ark", file_url: item };
        const name = normalizeReferenceName(item.name || item.file_name, "");
        return {
          provider: sanitizeString(item.provider, "ark"),
          id: sanitizeString(item.id),
          name,
          role: sanitizeString(item.role || item.type || inferReferenceRole(name, job.prompt)),
          type: sanitizeString(item.type || item.role || inferReferenceRole(name, job.prompt)),
          file_id: sanitizeString(item.file_id || item.fileId),
          file_url: sanitizeString(item.file_url || item.fileUrl || item.url),
          file_name: sanitizeString(item.file_name || item.fileName)
        };
      })
      .map((item, index) => ({
        ...item,
        id: item.id || `img_${index + 1}`,
        name: item.name || `图片${index + 1}`,
        role: item.role || inferReferenceRole(item.name || `图片${index + 1}`, job.prompt),
        type: item.type || item.role || "reference"
      }))
      .filter((item) => item.file_id || item.file_url)
      .slice(0, 9);
  }
  return Array.isArray(job.imageUrls)
    ? job.imageUrls.filter(Boolean).slice(0, 9).map((url, index) => ({
      provider: "ark",
      id: `img_${index + 1}`,
      name: `图片${index + 1}`,
      role: inferReferenceRole(`图片${index + 1}`, job.prompt),
      type: "reference",
      file_url: url
    }))
    : [];
}

function createReferenceLookup(imageRefs) {
  const map = new Map();
  imageRefs.forEach((ref, index) => {
    const aliases = [
      ref.name,
      `图片${index + 1}`,
      ref.id,
      ref.file_name
    ]
      .map((item) => normalizeReferenceName(item, ""))
      .filter(Boolean);
    aliases.forEach((alias) => {
      if (!map.has(alias)) map.set(alias, ref);
    });
  });
  return map;
}

function parsePromptReferences(prompt, imageRefs) {
  const lookup = createReferenceLookup(imageRefs);
  const references = [];
  const pieces = [];
  const tokenPattern = /@([\u4e00-\u9fa5A-Za-z0-9_\-]+)/g;
  let lastIndex = 0;
  let sawReferenceToken = false;

  for (const match of String(prompt || "").matchAll(tokenPattern)) {
    const name = normalizeReferenceName(match[1], "");
    const ref = lookup.get(name);
    if (!ref) continue;
    sawReferenceToken = true;
    const text = String(prompt || "").slice(lastIndex, match.index).trim();
    if (text) pieces.push({ type: "text", text });
    if (!references.some((item) => item.id === ref.id)) references.push(ref);
    pieces.push({ type: "image", ref });
    lastIndex = match.index + match[0].length;
  }

  const trailingText = String(prompt || "").slice(lastIndex).trim();
  if (sawReferenceToken && trailingText) pieces.push({ type: "text", text: trailingText });

  const selectedReferences = sawReferenceToken ? references : [];
  const cleanPrompt = sawReferenceToken
    ? String(prompt || "").replace(tokenPattern, (full, rawName) => {
      const ref = lookup.get(normalizeReferenceName(rawName, ""));
      return ref ? ref.name : full;
    })
    : String(prompt || "");

  return {
    cleanPrompt,
    pieces: sawReferenceToken ? pieces : [{ type: "text", text: cleanPrompt }],
    references: selectedReferences
  };
}

function publicReference(ref) {
  return {
    id: ref.id,
    name: ref.name,
    role: ref.role || ref.type || "reference",
    type: ref.type || ref.role || "reference",
    url: ref.file_url || "",
    file_id: ref.file_id || ""
  };
}

function createArkImageContent(ref, job, index) {
  const imageUrl = typeof ref === "string"
    ? { url: ref }
    : ref.file_id
      ? { file_id: ref.file_id }
      : { url: ref.file_url };
  const item = {
    type: "image_url",
    image_url: imageUrl,
    role: ref.role || job.referenceMode || "reference_image"
  };
  const subjectType = ref.role === "person" ? "person" : inferArkImageSubjectType(job.prompt, index);
  if (subjectType) item.subject_type = subjectType;
  return item;
}

function buildArkBody(job) {
  const rule = getModelRule(job.model);
  const content = [];
  const imageRefs = normalizeImageRefs(job);
  const parsed = parsePromptReferences(job.prompt, imageRefs);
  for (const piece of parsed.pieces) {
    if (piece.type === "text" && piece.text) content.push({ type: "text", text: piece.text });
    if (piece.type === "image") content.push(createArkImageContent(piece.ref, job, imageRefs.indexOf(piece.ref)));
  }
  if (!content.some((item) => item.type === "text")) {
    content.push({ type: "text", text: parsed.cleanPrompt.trim() || "参考上传图片生成视频。" });
  }
  return {
    model: rule.modelId || job.model,
    content,
    resolution: job.resolution,
    ratio: arkRatio(job.aspectRatio),
    duration: job.duration,
    seed: -1,
    generate_audio: false,
    watermark: false
  };
}

const ImageGenerationProvider = {
  poyo: {
    label: "PoYo / Sora 2",
    capabilities: { maxReferenceImages: 1, supportsNamedReferences: true },
    buildRequestBody: buildPoyoBody
  },
  ark: {
    label: "火山方舟 / Seedance 2.0",
    capabilities: { maxReferenceImages: 9, supportsNamedReferences: true },
    buildRequestBody: buildArkBody
  }
};

function applyArkTaskResponse(job, response) {
  const task = response?.data || response || {};
  job.arkTaskId = task.id || task.task_id || job.arkTaskId;
  job.externalTaskId = job.arkTaskId;
  job.status = mapArkStatus(task.status || job.status);
  job.progress = Number.isFinite(Number(task.progress)) ? Number(task.progress) : job.progress;
  const videoUrl = task.content?.video_url || task.output?.video_url || task.video_url || task.result?.video_url;
  if (videoUrl) {
    job.files = [{
      file_type: "video",
      file_url: videoUrl,
      format: "mp4",
      content_type: "video/mp4"
    }];
  }
  job.actualCredits = Number.isFinite(Number(task.usage?.total_tokens)) ? Number(task.usage.total_tokens) : job.actualCredits ?? null;
  job.providerResponse = response;
  const taskError = task.error?.message || task.error_message || null;
  job.errorMessage = taskError ? explainFailure(new Error(taskError)) : null;
  job.updatedAt = now();
  return job;
}

async function submitJob(store, job) {
  if (getExternalTaskId(job) && ["not_started", "running", "finished"].includes(job.status)) return job;
  const provider = job.provider || getModelProvider(job.model);
  if (provider === "ark") return submitArkJob(store, job);
  return submitPoyoJob(store, job);
}

async function submitPoyoJob(store, job) {
  job.status = "submitting";
  job.updatedAt = now();
  const response = await poyoFetch("/api/generate/submit", {
    method: "POST",
    body: JSON.stringify(ImageGenerationProvider.poyo.buildRequestBody(job))
  });
  const data = response.data || {};
  job.poyoTaskId = data.task_id || job.poyoTaskId;
  job.status = data.status || "not_started";
  job.poyoCreatedTime = data.created_time || null;
  job.providerResponse = response;
  job.errorMessage = null;
  job.updatedAt = now();
  return job;
}

async function submitArkJob(store, job) {
  job.status = "submitting";
  job.updatedAt = now();
  const response = await arkFetch("/api/v3/contents/generations/tasks", {
    method: "POST",
    body: JSON.stringify(ImageGenerationProvider.ark.buildRequestBody(job))
  });
  job.provider = "ark";
  job.poyoTaskId = null;
  applyArkTaskResponse(job, response);
  job.errorMessage = null;
  return job;
}

async function refreshJob(job) {
  const provider = job.provider || getModelProvider(job.model);
  if (provider === "ark") return refreshArkJob(job);
  return refreshPoyoJob(job);
}

async function refreshPoyoJob(job) {
  if (!job.poyoTaskId) return job;
  const response = await poyoFetch(`/api/generate/status/${encodeURIComponent(job.poyoTaskId)}`);
  const data = response.data || {};
  job.status = data.status || job.status;
  job.progress = Number.isFinite(data.progress) ? data.progress : job.progress;
  job.files = Array.isArray(data.files) ? data.files : job.files || [];
  job.errorMessage = data.error_message || null;
  job.actualCredits = Number.isFinite(Number(data.credits)) ? Number(data.credits)
    : Number.isFinite(Number(data.credit_consumption)) ? Number(data.credit_consumption)
      : Number.isFinite(Number(data.cost_credits)) ? Number(data.cost_credits)
        : job.actualCredits ?? null;
  job.poyoCreatedTime = data.created_time || job.poyoCreatedTime || null;
  job.updatedAt = now();
  return job;
}

async function refreshArkJob(job) {
  if (!job.arkTaskId && !job.externalTaskId) return job;
  const taskId = job.arkTaskId || job.externalTaskId;
  const response = await arkFetch(`/api/v3/contents/generations/tasks/${encodeURIComponent(taskId)}`);
  applyArkTaskResponse(job, response);
  return job;
}

function summarize(store) {
  const by = (field) => {
    const rows = new Map();
    for (const job of store.jobs) {
      const key = job[field] || "未填写";
      const row = rows.get(key) || { key, total: 0, finished: 0, running: 0, failed: 0, draft: 0 };
      row.total += 1;
      if (job.status === "finished") row.finished += 1;
      else if (["not_started", "running", "submitting"].includes(job.status)) row.running += 1;
      else if (["failed", "submit_failed"].includes(job.status)) row.failed += 1;
      else row.draft += 1;
      rows.set(key, row);
    }
    return [...rows.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  };

  const statuses = store.jobs.reduce((acc, job) => {
    acc[job.status] = (acc[job.status] || 0) + 1;
    return acc;
  }, {});

  return {
    totalJobs: store.jobs.length,
    totalScripts: store.scripts.length,
    totalBatches: store.batches.length,
    estimatedDraftCredits: estimateTotalCredits(store.jobs.filter((job) => job.status === "draft")),
    estimatedActiveCredits: estimateTotalCredits(store.jobs.filter((job) => ["not_started", "running", "submitting"].includes(job.status))),
    estimatedFinishedCredits: estimateTotalCredits(store.jobs.filter((job) => job.status === "finished")),
    statuses,
    byScript: by("scriptTitle"),
    byScene: by("sceneName"),
    byLanguage: by("language"),
    byBatch: by("batchName")
  };
}

async function handleApi(req, res, url) {
  const method = req.method || "GET";
  const store = await readStore();
  const accessChanged = ensureAccessStore(store);
  if (accessChanged) await writeStore(store);

  if (method === "POST" && url.pathname === "/api/poyo/webhook") {
    const payload = await readJson(req);
    const task = payload.data || {};
    const job = store.jobs.find((item) => item.poyoTaskId === task.task_id);
    if (job) {
      job.status = task.status || job.status;
      job.progress = Number.isFinite(task.progress) ? task.progress : job.progress;
      job.files = Array.isArray(task.files) ? task.files : job.files || [];
      job.actualCredits = Number.isFinite(Number(task.credits)) ? Number(task.credits)
        : Number.isFinite(Number(task.credit_consumption)) ? Number(task.credit_consumption)
          : Number.isFinite(Number(task.cost_credits)) ? Number(task.cost_credits)
            : job.actualCredits ?? null;
      job.errorMessage = task.error_message || null;
      job.updatedAt = now();
      await writeStore(store);
    }
    return jsonResponse(res, 200, { received: true });
  }

  if (method === "GET" && url.pathname === "/api/session") {
    const currentUser = getSessionUser(store, req);
    return jsonResponse(res, 200, {
      user: safeUser(currentUser),
      pendingRequests: currentUser?.role === "admin"
        ? store.accessRequests.filter((item) => item.status === "pending").length
        : 0
    });
  }

  if (method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(req);
    const username = sanitizeString(body.username);
    const password = sanitizeString(body.password);
    const user = store.users.find((item) => item.username === username && item.status === "active");
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return jsonResponse(res, 401, { error: "账号或密码不正确，或账号未授权" });
    }
    const session = createSession(store, user);
    await writeStore(store);
    return jsonResponse(res, 200, { user: safeUser(user) }, { "Set-Cookie": sessionCookie(session.token) });
  }

  if (method === "POST" && url.pathname === "/api/auth/logout") {
    const token = parseCookies(req).fyai_session;
    store.sessions = store.sessions.filter((item) => item.token !== token);
    await writeStore(store);
    return jsonResponse(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
  }

  if (method === "POST" && url.pathname === "/api/access/apply") {
    const body = await readJson(req);
    const name = sanitizeString(body.name);
    const username = sanitizeString(body.username);
    const password = sanitizeString(body.password);
    const contact = sanitizeString(body.contact);
    if (!name || !username || !password) return jsonResponse(res, 400, { error: "姓名、账号和密码都要填写" });
    if (password.length < 6) return jsonResponse(res, 400, { error: "密码至少 6 位" });
    if (store.users.some((user) => user.username === username)) return jsonResponse(res, 409, { error: "这个账号已经存在" });
    if (store.accessRequests.some((item) => item.username === username && item.status === "pending")) {
      return jsonResponse(res, 409, { error: "这个账号已经提交过申请，等待管理员批准" });
    }
    const request = {
      id: id("request"),
      name,
      username,
      contact,
      passwordHash: hashPassword(password),
      status: "pending",
      createdAt: now(),
      updatedAt: now()
    };
    store.accessRequests.unshift(request);
    await writeStore(store);
    return jsonResponse(res, 201, { ok: true });
  }

  const currentUser = getSessionUser(store, req);
  if (!currentUser) return jsonResponse(res, 401, { error: "请先登录，或提交申请等待授权" });

  if (method === "GET" && url.pathname === "/api/access/requests") {
    if (currentUser.role !== "admin") return jsonResponse(res, 403, { error: "只有管理员可以查看申请" });
    return jsonResponse(res, 200, {
      requests: store.accessRequests.map((item) => ({
        id: item.id,
        name: item.name,
        username: item.username,
        contact: item.contact,
        status: item.status,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      })),
      users: store.users.map(safeUser)
    });
  }

  if (method === "POST" && url.pathname.match(/^\/api\/access\/requests\/[^/]+\/approve$/)) {
    if (currentUser.role !== "admin") return jsonResponse(res, 403, { error: "只有管理员可以批准申请" });
    const requestId = decodeURIComponent(url.pathname.split("/")[4]);
    const request = store.accessRequests.find((item) => item.id === requestId);
    if (!request) return jsonResponse(res, 404, { error: "没有找到这条申请" });
    if (request.status !== "pending") return jsonResponse(res, 400, { error: "这条申请已经处理过" });
    if (store.users.some((user) => user.username === request.username)) {
      request.status = "rejected";
      request.updatedAt = now();
      await writeStore(store);
      return jsonResponse(res, 409, { error: "账号已存在，申请已关闭" });
    }
    const user = {
      id: id("user"),
      username: request.username,
      name: request.name,
      role: "member",
      status: "active",
      passwordHash: request.passwordHash,
      createdAt: now(),
      updatedAt: now()
    };
    request.status = "approved";
    request.approvedBy = currentUser.id;
    request.updatedAt = now();
    request.approvedAt = now();
    store.users.push(user);
    await writeStore(store);
    return jsonResponse(res, 200, { user: safeUser(user), request });
  }

  if (method === "POST" && url.pathname.match(/^\/api\/access\/requests\/[^/]+\/reject$/)) {
    if (currentUser.role !== "admin") return jsonResponse(res, 403, { error: "只有管理员可以拒绝申请" });
    const requestId = decodeURIComponent(url.pathname.split("/")[4]);
    const request = store.accessRequests.find((item) => item.id === requestId);
    if (!request) return jsonResponse(res, 404, { error: "没有找到这条申请" });
    request.status = "rejected";
    request.updatedAt = now();
    await writeStore(store);
    return jsonResponse(res, 200, { request });
  }

  if (method === "GET" && url.pathname === "/api/state") {
    return jsonResponse(res, 200, {
      currentUser: safeUser(currentUser),
      hasPoyoKey: Boolean(process.env.POYO_API_KEY),
      hasArkKey: Boolean(process.env.ARK_API_KEY),
      pricingRules: PRICING_RULES,
      accountBalance: store.accountBalance,
      owners: getOwnerOptions(store),
      scripts: store.scripts,
      batches: store.batches,
      jobs: store.jobs,
      summary: summarize(store)
    });
  }

  if (method === "GET" && url.pathname === "/api/pricing") {
    return jsonResponse(res, 200, { pricingRules: PRICING_RULES });
  }

  if (method === "POST" && url.pathname === "/api/account/balance") {
    try {
      const accountBalance = await refreshBalanceIntoStore(store);
      await writeStore(store);
      return jsonResponse(res, 200, { accountBalance });
    } catch (error) {
      return jsonResponse(res, error.status || 500, {
        error: error.message,
        details: error.details || []
      });
    }
  }

  if (method === "POST" && url.pathname === "/api/settings/poyo-key") {
    const body = await readJson(req);
    const key = sanitizeString(body.key);
    if (!key) return jsonResponse(res, 400, { error: "密钥不能为空" });
    if (key.length < 20) return jsonResponse(res, 400, { error: "密钥看起来太短，请检查后再保存" });
    await writeLocalEnvValue("POYO_API_KEY", key);
    return jsonResponse(res, 200, { ok: true, hasPoyoKey: true });
  }

  if (method === "POST" && url.pathname === "/api/settings/ark-key") {
    const body = await readJson(req);
    const key = sanitizeString(body.key);
    if (!key) return jsonResponse(res, 400, { error: "密钥不能为空" });
    if (key.length < 10) return jsonResponse(res, 400, { error: "密钥看起来太短，请检查后再保存" });
    await writeLocalEnvValue("ARK_API_KEY", key);
    return jsonResponse(res, 200, { ok: true, hasArkKey: true });
  }

  if (method === "POST" && url.pathname === "/api/settings/volc-aksk") {
    const body = await readJson(req);
    const accessKeyId = sanitizeString(body.accessKeyId);
    const secretAccessKey = sanitizeString(body.secretAccessKey);
    if (!accessKeyId || !secretAccessKey) return jsonResponse(res, 400, { error: "AK 和 SK 都要填写" });
    if (accessKeyId.length < 10 || secretAccessKey.length < 20) {
      return jsonResponse(res, 400, { error: "AK/SK 看起来太短，请检查后再保存" });
    }
    await writeLocalEnvValue("VOLC_ACCESS_KEY_ID", accessKeyId);
    await writeLocalEnvValue("VOLC_SECRET_ACCESS_KEY", secretAccessKey);
    return jsonResponse(res, 200, { ok: true, hasVolcAkSk: true });
  }

  if (method === "POST" && url.pathname === "/api/uploads/image") {
    try {
      const body = await readJson(req);
      const provider = sanitizeString(body.provider) === "ark" ? "ark" : "poyo";
      const file = provider === "ark"
        ? await uploadImageToArk({
          dataUrl: sanitizeString(body.dataUrl),
          fileName: sanitizeString(body.fileName, "reference-image.png")
        })
        : await uploadImageToPoyo({
          dataUrl: sanitizeString(body.dataUrl),
          fileName: sanitizeString(body.fileName, "reference-image.png")
        });
      return jsonResponse(res, 200, { file });
    } catch (error) {
      return jsonResponse(res, error.status || 500, { error: error.message });
    }
  }

  if (method === "POST" && url.pathname === "/api/scripts") {
    const body = await readJson(req);
    const title = sanitizeString(body.title, "未命名脚本");
    const prompt = sanitizeString(body.prompt);
    if (!prompt) return jsonResponse(res, 400, { error: "脚本内容不能为空" });
    const script = {
      id: id("script"),
      title,
      prompt,
      owner: sanitizeString(body.owner),
      category: sanitizeString(body.category),
      defaultScene: sanitizeString(body.defaultScene),
      notes: sanitizeString(body.notes),
      createdAt: now(),
      updatedAt: now()
    };
    store.scripts.unshift(script);
    await writeStore(store);
    return jsonResponse(res, 201, { script, summary: summarize(store) });
  }

  if (method === "DELETE" && url.pathname.startsWith("/api/scripts/")) {
    const scriptId = decodeURIComponent(url.pathname.split("/").pop());
    store.scripts = store.scripts.filter((script) => script.id !== scriptId);
    await writeStore(store);
    return jsonResponse(res, 200, { ok: true, summary: summarize(store) });
  }

  if (method === "POST" && url.pathname === "/api/batches") {
    const body = await readJson(req);
    const scriptIds = Array.isArray(body.scriptIds) ? body.scriptIds : [];
    const scripts = store.scripts.filter((script) => scriptIds.includes(script.id));
    if (!scripts.length) return jsonResponse(res, 400, { error: "请至少选择一个脚本" });

    const scenes = parseLines(body.scenes, (line) => {
      const value = sanitizeString(line);
      if (!value) return null;
      const [name, ...rest] = value.split("|").map((part) => part.trim());
      return { name, detail: rest.join(" | ") };
    });
    const languages = parseLines(body.languages || body.locales, (line) => {
      const value = sanitizeString(line);
      if (!value) return null;
      const [name, ...rest] = value.split("|").map((part) => part.trim());
      return { name, note: rest.join(" | ") };
    });

    const hasCustomScenes = scenes.length > 0;
    const safeLanguages = languages.length ? languages : [{ name: "", note: "" }];

    const model = normalizeModel(body.model);
    const durationOptions = PRICING_RULES[model]?.durationOptions || [4, 8, 12, 16, 20];
    const duration = sanitizeInt(body.duration, durationOptions, durationOptions[0] || 4);
    const aspectRatio = ["16:9", "9:16", "auto"].includes(body.aspectRatio) ? body.aspectRatio : "16:9";
    const resolutionOptions = PRICING_RULES[model]?.resolutionOptions || ["720p", "1024p", "1080p"];
    const resolution = resolutionOptions.includes(body.resolution) ? body.resolution : resolutionOptions[0];
    const variantsPerCombination = Math.max(1, Math.min(50, Number(body.variantsPerCombination || 1)));
    const owner = sanitizeString(body.owner);
    const category = sanitizeString(body.category);
    if (!owner) return jsonResponse(res, 400, { error: "请先选择使用人" });
    const imageRefs = Array.isArray(body.imageRefs)
      ? body.imageRefs
        .map((item, index) => {
          const name = normalizeReferenceName(item.name || item.file_name || item.fileName, `图片${index + 1}`);
          const role = sanitizeString(item.role || item.type || inferReferenceRole(name));
          return {
          provider: sanitizeString(item.provider || getModelProvider(model)),
          id: sanitizeString(item.id, `img_${index + 1}`),
          name,
          role,
          type: sanitizeString(item.type || role || "reference"),
          file_id: sanitizeString(item.file_id || item.fileId),
          file_url: sanitizeString(item.file_url || item.fileUrl || item.url),
          file_name: sanitizeString(item.file_name || item.fileName)
          };
        })
        .filter((item) => item.file_id || item.file_url)
        .slice(0, 9)
      : [];
    const imageUrls = imageRefs.length
      ? imageRefs.map((item) => item.file_url).filter(Boolean)
      : Array.isArray(body.imageUrls)
        ? body.imageUrls.map((item) => sanitizeString(item)).filter(Boolean).slice(0, 9)
        : [];
    const hasReferenceImages = imageRefs.length || imageUrls.length;
    const referenceMode = hasReferenceImages && getModelProvider(model) === "ark" ? "reference_image" : "";

    const batch = {
      id: id("batch"),
      name: sanitizeString(body.name, `批次 ${new Date().toLocaleString("zh-CN")}`),
      model,
      duration,
      aspectRatio,
      resolution,
      owner,
      category,
      referenceMode,
      variantsPerCombination,
      createdAt: now(),
      updatedAt: now()
    };

    const jobs = [];
    for (const script of scripts) {
      const scriptScenes = hasCustomScenes ? scenes : [{ name: script.defaultScene || "", detail: "" }];
      for (const scene of scriptScenes) {
        for (const language of safeLanguages) {
          for (let variantIndex = 1; variantIndex <= variantsPerCombination; variantIndex += 1) {
            jobs.push({
              id: id("job"),
              provider: getModelProvider(model),
              batchId: batch.id,
              batchName: batch.name,
              scriptId: script.id,
              scriptTitle: script.title,
              owner: owner || script.owner || "",
              category: category || script.category || "",
              sceneName: scene.name,
              sceneDetail: scene.detail,
              language: language.name,
              languageNote: language.note,
              localizationNote: language.note,
              variantIndex,
              variantsPerCombination,
              model,
              duration,
              aspectRatio,
              resolution,
              prompt: buildPrompt(script, scene, language, variantIndex, variantsPerCombination),
              status: "draft",
              progress: 0,
              poyoTaskId: null,
              files: [],
              localFiles: [],
              errorMessage: null,
              estimatedCredits: estimateCredits({ model, duration, resolution }),
              actualCredits: null,
              createdAt: now(),
              updatedAt: now()
            });
            const job = jobs[jobs.length - 1];
            const parsedReferences = parsePromptReferences(job.prompt, imageRefs);
            const capabilities = getProviderCapabilities(job.provider);
            if (parsedReferences.references.length > capabilities.maxReferenceImages) {
              return jsonResponse(res, 400, {
                error: job.provider === "poyo"
                  ? "当前 Sora/PoYo 接口只支持 1 张参考图，请只 @ 一张图片，或切换到火山 Seedance。"
                  : `当前模型最多支持 ${capabilities.maxReferenceImages} 张参考图`
              });
            }
            job.imageRefs = parsedReferences.references;
            job.imageUrls = parsedReferences.references.map((item) => item.file_url).filter(Boolean);
            job.references = parsedReferences.references.map(publicReference);
            job.referenceMode = parsedReferences.references.length && job.provider === "ark" ? "reference_image" : "";
          }
        }
      }
    }

    batch.jobCount = jobs.length;
    batch.estimatedCredits = estimateTotalCredits(jobs);
    store.batches.unshift(batch);
    store.jobs.unshift(...jobs);
    await writeStore(store);

    const provider = getModelProvider(model);
    if (body.submitNow && provider === "poyo" && !process.env.POYO_API_KEY) {
      batch.submitWarning = "未配置 PoYo Key。已创建草稿，未提交。";
      await writeStore(store);
    } else if (body.submitNow && provider === "ark" && !process.env.ARK_API_KEY) {
      batch.submitWarning = "未配置火山方舟 ARK Key。已创建草稿，未提交。";
      await writeStore(store);
    } else if (body.submitNow) {
      const balanceCheck = provider === "poyo" ? await checkBalanceForCredits(store, batch.estimatedCredits) : { ok: true };
      if (!balanceCheck.ok) {
        batch.submitWarning = balanceCheck.error;
        await writeStore(store);
        return jsonResponse(res, 402, { error: balanceCheck.error, batch, jobs, summary: summarize(store), accountBalance: balanceCheck.balance });
      }
      if (balanceCheck.warning) batch.submitWarning = balanceCheck.warning;
      for (const job of jobs) {
        try {
          await submitJob(store, job);
          await writeStore(store);
        } catch (error) {
          job.status = "submit_failed";
          job.errorMessage = explainFailure(error);
          job.updatedAt = now();
          await writeStore(store);
        }
      }
    }

    return jsonResponse(res, 201, { batch, jobs, summary: summarize(store) });
  }

  if (method === "POST" && url.pathname.match(/^\/api\/jobs\/[^/]+\/submit$/)) {
    const jobId = decodeURIComponent(url.pathname.split("/")[3]);
    const job = findJob(store, jobId);
    const provider = job.provider || getModelProvider(job.model);
    if (provider === "poyo" && !process.env.POYO_API_KEY) {
      return jsonResponse(res, 400, { error: "Missing POYO_API_KEY. 先配置 PoYo API Key，再提交真实生成。", job });
    }
    if (provider === "ark" && !process.env.ARK_API_KEY) {
      return jsonResponse(res, 400, { error: "未配置火山方舟 ARK Key。先打开平台密钥保存 ARK_API_KEY。", job });
    }
    const balanceCheck = provider === "poyo" ? await checkBalanceForCredits(store, Number(job.estimatedCredits) || 0) : { ok: true };
    if (!balanceCheck.ok) {
      await writeStore(store);
      return jsonResponse(res, 402, { error: balanceCheck.error, job, accountBalance: balanceCheck.balance });
    }
    try {
      await submitJob(store, job);
      await writeStore(store);
      return jsonResponse(res, 200, { job, summary: summarize(store) });
    } catch (error) {
      job.status = "submit_failed";
      job.errorMessage = explainFailure(error);
      job.updatedAt = now();
      await writeStore(store);
      return jsonResponse(res, error.status || 500, { error: job.errorMessage, job });
    }
  }

  if (method === "POST" && url.pathname.match(/^\/api\/batches\/[^/]+\/submit$/)) {
    const batchId = decodeURIComponent(url.pathname.split("/")[3]);
    const jobs = store.jobs.filter((job) => job.batchId === batchId && ["draft", "submit_failed"].includes(job.status));
    const needsPoyo = jobs.some((job) => (job.provider || getModelProvider(job.model)) === "poyo");
    const needsArk = jobs.some((job) => (job.provider || getModelProvider(job.model)) === "ark");
    if (needsPoyo && !process.env.POYO_API_KEY) {
      return jsonResponse(res, 400, { error: "Missing POYO_API_KEY. 先配置 PoYo API Key，再提交真实生成。" });
    }
    if (needsArk && !process.env.ARK_API_KEY) {
      return jsonResponse(res, 400, { error: "未配置火山方舟 ARK Key。先打开平台密钥保存 ARK_API_KEY。" });
    }
    const requiredCredits = estimateTotalCredits(jobs.filter((job) => (job.provider || getModelProvider(job.model)) === "poyo"));
    const balanceCheck = needsPoyo ? await checkBalanceForCredits(store, requiredCredits) : { ok: true };
    if (!balanceCheck.ok) {
      await writeStore(store);
      return jsonResponse(res, 402, { error: balanceCheck.error, jobs, summary: summarize(store), accountBalance: balanceCheck.balance });
    }
    for (const job of jobs) {
      try {
        await submitJob(store, job);
      } catch (error) {
        job.status = "submit_failed";
        job.errorMessage = explainFailure(error);
        job.updatedAt = now();
      }
      await writeStore(store);
    }
    return jsonResponse(res, 200, { jobs, summary: summarize(store) });
  }

  if (method === "POST" && url.pathname.match(/^\/api\/jobs\/[^/]+\/refresh$/)) {
    const jobId = decodeURIComponent(url.pathname.split("/")[3]);
    const job = findJob(store, jobId);
    try {
      await refreshJob(job);
      await writeStore(store);
      return jsonResponse(res, 200, { job, summary: summarize(store) });
    } catch (error) {
      return jsonResponse(res, error.status || 500, { error: error.message, job });
    }
  }

  if (method === "POST" && url.pathname === "/api/jobs/refresh-active") {
    const jobs = store.jobs.filter((job) => getExternalTaskId(job) && ["not_started", "running", "submitting"].includes(job.status));
    for (const job of jobs) {
      try {
        await refreshJob(job);
      } catch (error) {
        job.lastRefreshError = explainFailure(error);
        job.updatedAt = now();
      }
    }
    await writeStore(store);
    return jsonResponse(res, 200, { jobs, summary: summarize(store) });
  }

  if (method === "POST" && url.pathname.match(/^\/api\/jobs\/[^/]+\/download$/)) {
    const jobId = decodeURIComponent(url.pathname.split("/")[3]);
    const job = findJob(store, jobId);
    const file = (job.files || []).find((item) => item.file_type === "video") || job.files?.[0];
    if (!file?.file_url) return jsonResponse(res, 400, { error: "这条任务还没有可下载文件" });

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const response = await fetch(file.file_url);
    if (!response.ok) return jsonResponse(res, response.status, { error: `下载失败：${response.status}` });
    const arrayBuffer = await response.arrayBuffer();
    const extension = file.format ? `.${file.format}` : path.extname(new URL(file.file_url).pathname) || ".mp4";
    const filename = `${job.id}${extension}`;
    const targetPath = path.join(OUTPUT_DIR, filename);
    await fs.writeFile(targetPath, Buffer.from(arrayBuffer));
    job.localFiles = job.localFiles || [];
    job.localFiles.push({
      path: `/outputs/${filename}`,
      name: safeDownloadName(job, extension),
      savedAt: now(),
      contentType: file.content_type || response.headers.get("content-type") || null
    });
    job.updatedAt = now();
    await writeStore(store);
    return jsonResponse(res, 200, { job, summary: summarize(store) });
  }

  if (method === "GET" && url.pathname.match(/^\/api\/jobs\/[^/]+\/download-file$/)) {
    const jobId = decodeURIComponent(url.pathname.split("/")[3]);
    const job = findJob(store, jobId);
    const localFile = job.localFiles?.[job.localFiles.length - 1];
    const file = (job.files || []).find((item) => item.file_type === "video") || job.files?.[0];

    if (localFile?.path) {
      const relativePath = localFile.path.replace(/^\/+/, "");
      const localPath = path.join(__dirname, relativePath);
      if (!localPath.startsWith(OUTPUT_DIR)) return textResponse(res, 403, "Forbidden");
      const data = await fs.readFile(localPath);
      const ext = path.extname(localPath) || ".mp4";
      res.writeHead(200, {
        "Content-Type": localFile.contentType || MIME_TYPES[ext] || "application/octet-stream",
        "Content-Length": data.byteLength,
        "Content-Disposition": downloadDisposition(localFile.name || safeDownloadName(job, ext))
      });
      return res.end(data);
    }

    if (!file?.file_url) return textResponse(res, 404, "这条任务还没有可下载文件");
    const response = await fetch(file.file_url);
    if (!response.ok) return textResponse(res, response.status, `下载失败：${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const data = Buffer.from(arrayBuffer);
    const ext = file.format ? `.${file.format}` : path.extname(new URL(file.file_url).pathname) || ".mp4";
    res.writeHead(200, {
      "Content-Type": file.content_type || response.headers.get("content-type") || MIME_TYPES[ext] || "application/octet-stream",
      "Content-Length": data.byteLength,
      "Content-Disposition": downloadDisposition(safeDownloadName(job, ext))
    });
    return res.end(data);
  }

  if (method === "DELETE" && url.pathname.startsWith("/api/jobs/")) {
    const jobId = decodeURIComponent(url.pathname.split("/").pop());
    store.jobs = store.jobs.filter((job) => job.id !== jobId);
    await writeStore(store);
    return jsonResponse(res, 200, { ok: true, summary: summarize(store) });
  }

  if (method === "POST" && url.pathname === "/api/jobs/bulk") {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const action = sanitizeString(body.action);
    if (!ids.length) return jsonResponse(res, 400, { error: "请先选择任务" });
    const selected = store.jobs.filter((job) => ids.includes(job.id));
    if (action === "delete") {
      store.jobs = store.jobs.filter((job) => !ids.includes(job.id));
      await writeStore(store);
      return jsonResponse(res, 200, { ok: true, summary: summarize(store) });
    }
    if (action === "refresh") {
      for (const job of selected) {
        if (!getExternalTaskId(job)) continue;
        try {
          await refreshJob(job);
        } catch (error) {
          job.lastRefreshError = explainFailure(error);
          job.updatedAt = now();
        }
      }
      await writeStore(store);
      return jsonResponse(res, 200, { jobs: selected, summary: summarize(store) });
    }
    return jsonResponse(res, 400, { error: "不支持的批量操作" });
  }

  return jsonResponse(res, 404, { error: "Not found" });
}

async function serveStatic(res, url) {
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, safePath);
  if (!filePath.startsWith(__dirname)) return textResponse(res, 403, "Forbidden");
  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Content-Length": data.byteLength,
      // 体验优化：开发中的内部工具不缓存页面文件，避免成员刷新后还看到旧版布局。
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT") return textResponse(res, 404, "Not found");
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }
    return await serveStatic(res, url);
  } catch (error) {
    return jsonResponse(res, error.status || 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`PoYo Sora workflow running at http://${HOST}:${PORT}`);
});

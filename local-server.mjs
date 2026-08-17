import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  createWebSearchSession,
  isWebSearchDisabledRequest,
  isWebSearchRefusal,
  normalizeWebSearchQuery,
  runWebSearch as runExaWebSearch,
} from "./src/web-search.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";

const DEFAULT_SYSTEM_PROMPT = "你是一个中文 AI 助手。默认使用简体中文，回答清楚、自然、有帮助。优先给出可执行建议，少说空话。根据用户语气调整详略；适合语音朗读时使用短句。涉及医疗、药品、投资、法律等高风险内容时，只提供一般信息，提醒不能替代专业人士。若提供了【联网搜索结果】，请优先依据结果回答，不编造实时数据。不要输出思考过程。";

function env(name, fallback = "") { return String(process.env[name] ?? fallback).trim(); }
function clampMaxTokens(value, fallback = 512) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(1024, Math.max(256, safe));
}
function json(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}
function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

// --- Local-only access guard ---------------------------------------------
// This server proxies to whatever Base URL / endpoint the browser sends, which
// makes it a fetch-anything relay. The page is served from the same origin, so
// no cross-origin access is ever needed: reject anything that is not addressed
// as loopback/LAN, and reject cross-origin callers. Without this, any website
// the user visits could script fetch("http://127.0.0.1:8787/api/chat") and read
// back internal pages through the proxy.
const EXTRA_ALLOWED_HOSTS = new Set(
  env("ALLOWED_HOSTS").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
);

// Strips the port and IPv6 brackets. Apply exactly once: "::1" run through it
// twice would lose its trailing ":1" to the port pattern.
function hostOnly(value) {
  const h = String(value || "").trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : h.slice(1);
  }
  return h.replace(/:\d+$/, "");
}

// Takes an already-normalized hostname (see hostOnly).
function isLocalHostname(h) {
  if (!h) return false;
  if (EXTRA_ALLOWED_HOSTS.has(h)) return true;
  if (h === "localhost" || h === "::1" || h === "::") return true;
  if (/^127\./.test(h)) return true;
  if (h === "0.0.0.0") return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^(fc|fd)[0-9a-f]{2}:/.test(h)) return true;
  if (/^fe80:/.test(h)) return true;
  return false;
}

// Returns an error string when the request must be refused, "" when it is fine.
function checkLocalRequest(req) {
  const host = hostOnly(req.headers.host);
  // DNS-rebinding guard: a hostile domain pointed at 127.0.0.1 arrives with its
  // own name in Host, and would otherwise pass the same-origin check below.
  if (!isLocalHostname(host)) {
    return `拒绝请求：Host 头 "${req.headers.host || ""}" 不是本机/局域网地址。如果你在用隧道或自定义域名，请设置环境变量 ALLOWED_HOSTS。`;
  }
  const origin = req.headers.origin;
  if (origin) {
    if (origin === "null") return "拒绝请求：不接受 Origin: null。请从本服务页面发起请求。";
    let requestOrigin = "";
    let callerOrigin = "";
    try {
      requestOrigin = new URL(`${req.socket?.encrypted ? "https" : "http"}://${req.headers.host}`).origin;
      callerOrigin = new URL(origin).origin;
    } catch {
      return `拒绝请求：无法解析的 Origin "${origin}"。`;
    }
    if (callerOrigin !== requestOrigin) return `拒绝跨站请求：Origin "${origin}" 与本服务 "${requestOrigin}" 不同源。`;
  }
  return "";
}

// Never echo an upstream body verbatim: with a wrong or hostile endpoint it can
// be an internal page rather than a provider error. JSON error messages and
// short plain-text errors stay visible so real misconfiguration is debuggable.
function summarizeUpstreamError(status, statusText, contentType, body) {
  const head = `HTTP ${status}${statusText ? " " + statusText : ""}`.trim();
  const raw = String(body || "").trim();
  if (!raw) return head;
  try {
    const data = JSON.parse(raw);
    const msg = String(data?.error?.message || data?.message || "").trim();
    if (msg) return msg.slice(0, 500);
  } catch {}
  if (/html/i.test(String(contentType || "")) || /^</.test(raw)) {
    return `${head}（接口返回的是网页而不是 JSON，请检查 Base URL / 接口地址是否填错）`;
  }
  if (raw.length <= 200) return raw;
  return `${head}（接口返回了非 JSON 内容，共 ${raw.length} 字符）`;
}
function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
  fs.readFile(filePath, (err, data) => {
    if (err) return text(res, 404, "Not found");
    res.writeHead(200, { "content-type": types[ext] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  });
}
function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let settled = false;
    req.on("data", (c) => {
      if (settled) return;
      size += c.length;
      if (size > limit) {
        settled = true;
        const err = new Error("请求体过大");
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}
async function readJsonBody(req, limit) {
  const raw = await readBody(req, limit);
  try {
    return JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    const err = new Error("请求体不是有效的 JSON");
    err.status = 400;
    throw err;
  }
}
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!m) throw new Error("missing multipart boundary");
  const boundary = m[1] || m[2];
  const raw = buffer.toString("binary");
  const parts = raw.split("--" + boundary);
  const out = { fields: {}, file: null };
  for (const part of parts) {
    if (!part || part === "--\r\n" || part === "--") continue;
    const sep = part.indexOf("\r\n\r\n");
    if (sep < 0) continue;
    const head = part.slice(0, sep);
    let body = part.slice(sep + 4);
    if (body.endsWith("\r\n")) body = body.slice(0, -2);
    if (body.endsWith("--")) body = body.slice(0, -2);
    if (body.endsWith("\r\n")) body = body.slice(0, -2);
    const nameMatch = /name="([^"]+)"/i.exec(head);
    const fileMatch = /filename="([^"]*)"/i.exec(head);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(head);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    if (fileMatch) out.file = { field: name, filename: fileMatch[1] || "audio.webm", contentType: (typeMatch && typeMatch[1].trim()) || "application/octet-stream", buffer: Buffer.from(body, "binary") };
    else out.fields[name] = Buffer.from(body, "binary").toString("utf8");
  }
  return out;
}
function ensureV1(baseUrl) { const u = String(baseUrl || "").replace(/\/+$/, ""); if (!u) return ""; return /\/v1$/i.test(u) ? u : u + "/v1"; }
function pick(...vals) { for (const v of vals) { const s = String(v ?? "").trim(); if (s) return s; } return ""; }
function resolveCustomEndpoint(baseUrl, endpoint, fallbackPath) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const custom = String(endpoint || "").trim();
  const fallback = String(fallbackPath || "").trim().replace(/^\/+/, "");
  if (!custom) {
    if (!base) throw new Error("缺少 API Base URL");
    return fallback ? `${base}/${fallback}` : base;
  }
  if (/^https?:\/\//i.test(custom)) return custom;
  if (!base) throw new Error("相对接口地址需要配置 API Base URL");
  if (custom.startsWith("/")) return `${new URL(base).origin}${custom}`;
  return `${base}/${custom.replace(/^\/+/, "")}`;
}
function keyDiagnostic(apiKey) {
  const key = String(apiKey || "").trim();
  return {
    hasKey: Boolean(key),
    keyLength: key.length,
    keyTail: key ? key.slice(-4) : "",
    hasBearerPrefix: /^bearer\s+/i.test(key),
  };
}
function publicLlmConfig(cfg) {
  return {
    baseUrl: cfg.llm.baseUrl,
    model: cfg.llm.model,
    apiType: cfg.llm.apiType,
    endpoint: cfg.llm.endpoint,
    ...keyDiagnostic(cfg.llm.apiKey),
  };
}
function normalizeApiType(value, fallback = "auto") {
  const allowed = new Set(["auto", "custom", "openai-chat", "openai-responses", "openai-transcriptions", "openai-speech", "xiaomi-mimo"]);
  const v = String(value || "").trim();
  return allowed.has(v) ? v : fallback;
}
function resolveConfig(client = {}) {
  const llmBase = ensureV1(pick(client.llm?.baseUrl, env("LLM_BASE_URL"), "https://api.siliconflow.cn/v1"));
  const sttBase = ensureV1(pick(client.stt?.baseUrl, client.llm?.baseUrl, env("STT_BASE_URL"), llmBase));
  const ttsBase = ensureV1(pick(client.tts?.baseUrl, client.llm?.baseUrl, env("TTS_BASE_URL"), llmBase));
  return {
    // API keys come only from the browser-local config sent with each request.
    // The local/Worker server does not store or fall back to server-side API keys.
    llm: { baseUrl: llmBase, apiKey: pick(client.llm?.apiKey), model: pick(client.llm?.model, env("LLM_MODEL"), "Qwen/Qwen3.5-4B"), apiType: normalizeApiType(client.llm?.apiType, "auto"), endpoint: pick(client.llm?.endpoint) },
    stt: { baseUrl: sttBase, apiKey: pick(client.stt?.apiKey, client.llm?.apiKey), model: pick(client.stt?.model, env("STT_MODEL"), "FunAudioLLM/SenseVoiceSmall"), apiType: normalizeApiType(client.stt?.apiType, "auto"), endpoint: pick(client.stt?.endpoint) },
    tts: { baseUrl: ttsBase, apiKey: pick(client.tts?.apiKey, client.llm?.apiKey), model: pick(client.tts?.model, env("TTS_MODEL"), "FnLP/MOSS-TTSD-v0.5"), voice: pick(client.tts?.voice, env("TTS_VOICE"), "alloy"), apiType: normalizeApiType(client.tts?.apiType, "auto"), endpoint: pick(client.tts?.endpoint) },
    systemPrompt: pick(client.systemPrompt, env("SYSTEM_PROMPT"), DEFAULT_SYSTEM_PROMPT),
    maxHistoryTurns: Number(client.maxHistoryTurns || env("MAX_HISTORY_TURNS") || 12),
    maxTokens: clampMaxTokens(client.maxTokens || env("LLM_MAX_TOKENS") || 512),
    temperature: Number((client.temperature ?? env("LLM_TEMPERATURE", "0.7")) || 0.7),
    ttsEnabled: client.ttsEnabled !== false,
    toolCallingEnabled: client.toolCallingEnabled !== false,
    timeZone: pick(client.timeZone, "Asia/Hong_Kong"),
    webSearchEnabled: client.webSearchEnabled !== false && env("WEB_SEARCH_ENABLED", "true") !== "false",
  };
}
const ALLOW_PRIVATE_UPSTREAMS = env("ALLOW_PRIVATE_UPSTREAMS").toLowerCase() === "true";

function ipv4FromMappedIpv6(address) {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (dotted) return dotted;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return "";
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function isPrivateOrReservedAddress(address) {
  const value = String(address || "").toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const mapped = ipv4FromMappedIpv6(value);
  if (mapped) return isPrivateOrReservedAddress(mapped);
  const family = isIP(value);
  if (family === 4) {
    const [a, b, c] = value.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    return value === "::" || value === "::1" || /^f[cd]/.test(value) ||
      /^fe[89ab]/.test(value) || /^ff/.test(value) || /^2001:db8(?::|$)/.test(value);
  }
  return false;
}

async function resolveSafeUpstream(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl || "")); } catch { throw new Error("上游接口地址无效"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("上游接口只允许 http:// 或 https:// 地址");
  if (url.username || url.password) throw new Error("上游接口地址不能包含用户名或密码");

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname) throw new Error("上游接口地址缺少主机名");
  const localName = hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname.endsWith(".home.arpa");
  let addresses;
  if (isIP(hostname)) addresses = [{ address: hostname, family: isIP(hostname) }];
  else {
    try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
    catch (err) { throw new Error(`无法解析上游接口主机 ${hostname}: ${err.message || err}`); }
  }
  if (!addresses.length) throw new Error(`无法解析上游接口主机 ${hostname}`);
  if (!ALLOW_PRIVATE_UPSTREAMS && (localName || addresses.some((item) => isPrivateOrReservedAddress(item.address)))) {
    throw new Error("出于安全原因，供应商接口不能指向本机、局域网或保留地址。可信本地模型可显式设置 ALLOW_PRIVATE_UPSTREAMS=true");
  }
  return { url, addresses };
}

function pinnedLookup(addresses) {
  return (_hostname, options, callback) => {
    const opts = typeof options === "object" && options ? options : { family: Number(options) || 0 };
    const matching = opts.family ? addresses.filter((item) => item.family === opts.family) : addresses;
    const usable = matching.length ? matching : addresses;
    if (opts.all) return callback(null, usable);
    return callback(null, usable[0].address, usable[0].family);
  };
}

function makeAbortError(reason = "request aborted") {
  if (reason instanceof Error) return reason;
  const err = new Error(String(reason || "request aborted"));
  err.name = "AbortError";
  return err;
}

async function fetchJson(rawUrl, options = {}, timeoutMs = 45000) {
  const target = await resolveSafeUpstream(rawUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    let hardTimer = null;
    let upstreamReq = null;
    const signal = options.signal;
    const onAbort = () => {
      const err = makeAbortError(signal?.reason);
      upstreamReq?.destroy(err);
      done(reject, err);
    };
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      signal?.removeEventListener("abort", onAbort);
      fn(arg);
    };
    if (signal?.aborted) return done(reject, makeAbortError(signal.reason));
    signal?.addEventListener("abort", onAbort, { once: true });
    const u = target.url;
    const lib = u.protocol === "https:" ? https : http;
    upstreamReq = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || "GET",
      headers: options.headers || {},
      lookup: pinnedLookup(target.addresses),
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const textBody = buf.toString("utf8");
        let data = textBody;
        try { data = JSON.parse(textBody); } catch {}
        done(resolve, { ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data, raw: textBody, headers: res.headers, buffer: buf });
      });
      res.on("error", (err) => done(reject, err));
    });
    hardTimer = setTimeout(() => {
      const err = new Error("upstream timeout");
      upstreamReq.destroy(err);
      done(reject, err);
    }, timeoutMs);
    upstreamReq.on("error", (err) => done(reject, err));
    upstreamReq.on("timeout", () => {
      const err = new Error("upstream timeout");
      upstreamReq.destroy(err);
      done(reject, err);
    });
    if (options.body) upstreamReq.write(options.body);
    upstreamReq.end();
  });
}
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(makeAbortError(signal.reason));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(makeAbortError(signal.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function pickUpstreamErrorMessage(res) {
  const fromJson = String(res?.data?.error?.message || res?.data?.message || "").trim();
  if (fromJson) return fromJson.slice(0, 500);
  return summarizeUpstreamError(res?.status || "", "", res?.headers?.["content-type"], res?.raw);
}
function isTransientAuthError(status, message) {
  return Number(status) === 401 && /invalid\s+(api\s*key|token)|invalid\s+key/i.test(String(message || ""));
}
function formatLlmFailure(status, message) {
  const msg = String(message || `HTTP ${status}`).trim();
  if (isTransientAuthError(status, msg)) {
    return `LLM failed: ${msg}。如果同一 Key 马上重试可成功，通常是供应商限流或网关临时认证异常；请稍后重试或更换供应商。`;
  }
  if (Number(status) === 429) {
    return `LLM failed: ${msg}。供应商返回限流/额度不足，请稍后重试或更换模型/供应商。`;
  }
  return `LLM failed: ${msg}`;
}
async function fetchLlmWithTransientRetry(endpoint, options, timeoutMs, cfg) {
  let res = await fetchJson(endpoint, options, timeoutMs);
  const msg = pickUpstreamErrorMessage(res);
  if (!res.ok && isTransientAuthError(res.status, msg)) {
    console.log("[llm] transient auth error, retry once", { status: res.status, ...publicLlmConfig(cfg) });
    await sleep(800, options.signal);
    res = await fetchJson(endpoint, options, timeoutMs);
  }
  return res;
}
const REPLY_ONLY_INSTRUCTION = "输出要求：只输出给用户的最终回答，不要复述系统提示词、角色设定、对话记录或用户原话，不要重复回答。";
function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function withReplyOnlyInstruction(systemPrompt) {
  const prompt = String(systemPrompt || "").trim();
  if (!prompt || prompt.includes(REPLY_ONLY_INSTRUCTION)) return prompt;
  return `${prompt}\n\n${REPLY_ONLY_INSTRUCTION}`;
}
function mergeStreamText(current, incoming, cumulative = false) {
  const reply = String(current || "");
  const text = String(incoming || "").replace(/\<think>[\s\S]*?\<\/think>/gi, "");
  if (!text) return { reply, delta: "" };
  if (cumulative && text === reply) return { reply, delta: "" };
  if (reply && text.length > reply.length && text.startsWith(reply)) {
    return { reply: text, delta: text.slice(reply.length) };
  }
  if (text.length >= 12 && (text === reply || reply.endsWith(text))) {
    return { reply, delta: "" };
  }
  if (reply && text.length >= 12) {
    const maxOverlap = Math.min(reply.length, text.length);
    for (let overlap = maxOverlap; overlap >= 12; overlap -= 1) {
      if (reply.slice(-overlap) === text.slice(0, overlap)) {
        const delta = text.slice(overlap);
        return { reply: reply + delta, delta };
      }
    }
  }
  return { reply: reply + text, delta: text };
}
function extractTextContent(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    return typeof part.text === "string" ? part.text : "";
  }).join(" ").trim();
}
function sanitizeMessageContent(content) {
  if (typeof content === "string") return content.slice(0, 4000);
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content.slice(0, 8)) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text.slice(0, 4000) });
      continue;
    }
    const imageUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    if (part.type === "image_url" && typeof imageUrl === "string" && /^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(imageUrl) && imageUrl.length <= 6 * 1024 * 1024) {
      parts.push({ type: "image_url", image_url: { url: imageUrl, detail: "low" } });
    }
  }
  return parts;
}
function messageHasImage(content) {
  return Array.isArray(content) && content.some((part) => part?.type === "image_url" && (typeof part.image_url === "string" || typeof part.image_url?.url === "string"));
}
function messagesHaveVision(messages) {
  return (Array.isArray(messages) ? messages : []).some((message) => message?.role === "user" && messageHasImage(message.content));
}
function appendVisionQueryAnchor(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const lastVisionUser = [...list].reverse().find((message) => message?.role === "user" && messageHasImage(message.content));
  if (!lastVisionUser) return list;
  const query = extractTextContent(lastVisionUser.content) || "请分析上一条消息中的图片。";
  return [...list, { role: "user", content: query }];
}
function isNoUserQueryError(message) {
  return /no user query found in messages/i.test(String(message || ""));
}
function cleanAssistantReply(text, messages = []) {
  const original = String(text || "")
    .replace(/\<think>[\s\S]*?\<\/think>/gi, "")
    .replace(/<\|(?:im_start|im_end|endoftext|system|user|assistant)\|>/gi, "")
    .trim();
  if (!original) return "";
  let cleaned = original;
  const systemPrompts = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === "system" && typeof message.content === "string")
    .flatMap((message) => {
      const prompt = message.content.trim();
      const basePrompt = prompt.replace(REPLY_ONLY_INSTRUCTION, "").trim();
      return [prompt, basePrompt];
    })
    .filter((prompt) => prompt.length >= 12)
    .sort((a, b) => b.length - a.length);
  for (const prompt of new Set(systemPrompts)) cleaned = cleaned.split(prompt).join("\n");

  const lastUser = [...(Array.isArray(messages) ? messages : [])].reverse().find((message) => message?.role === "user");
  const userText = extractTextContent(lastUser?.content);
  if (userText) {
    for (const marker of [
      `用户说：“${userText}”`,
      `用户说："${userText}"`,
      `用户说：${userText}`,
      `用户：${userText}`,
      `user: ${userText}`,
    ]) cleaned = cleaned.split(marker).join("\n");
    const escapedUser = escapeRegExp(userText);
    const userEchoPattern = new RegExp(`(^|\\n)\\s*(?:用户(?:说)?|user)\\s*[:：]\\s*[“”"'‘’]*\\s*${escapedUser}\\s*[“”"'‘’]*\\s*`, "gi");
    for (let pass = 0; pass < 3; pass += 1) cleaned = cleaned.replace(userEchoPattern, "$1");
  }
  cleaned = cleaned
    .replace(/(^|\n)\s*(?:系统(?:提示|消息)?|system)\s*[:：]\s*(?=\n|$)/gi, "$1")
    .replace(/(^|\n)\s*(?:用户(?:说)?|user)\s*[:：]\s*[“”"'‘’]*\s*(?=\n|$)/gi, "$1")
    .replace(/^\s*(?:助手|assistant|小豆)\s*[:：]\s*/i, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const paragraphs = cleaned.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  cleaned = paragraphs.filter((item, index) => index === 0 || item !== paragraphs[index - 1]).join("\n\n").trim();
  const anchor = cleaned.slice(0, 48).trim();
  if (anchor.length >= 24) {
    const repeatAt = cleaned.indexOf(anchor, Math.max(80, anchor.length + 1));
    if (repeatAt >= 0) cleaned = cleaned.slice(0, repeatAt).trim();
  }
  return cleaned || original;
}
function extractChatText(data) {
  const choice = data?.choices?.[0] || {};
  const message = choice.message || choice.delta || {};
  // Only content is a user-facing reply; reasoning_content/reasoning is the model thinking process, never return it.
  const candidates = [message.content, choice.text, data?.output_text, data?.content];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.replace(/\<think>[\s\S]*?<\/think>/gi, "").trim();
    if (Array.isArray(c)) {
      const joined = c.map((p) => (typeof p === "string" ? p : p?.text || "")).join("").trim();
      const cleaned = joined.replace(/\<think>[\s\S]*?<\/think>/gi, "").trim();
      if (cleaned) return cleaned;
    }
  }
  return "";
}
// Deliberately a single kind: vision always needs Chat Completions, and every
// other case follows the configured apiType. There is no chat->responses
// fallback — a provider that rejects Chat Completions should be configured as
// "OpenAI Responses" explicitly rather than discovered by retrying.
function llmKinds(cfg, messages = []) {
  return [messagesHaveVision(messages) ? "chat" : preferredLlmKind(cfg)];
}
function chatPayloadVariants(cfg, messages, stream = false) {
  const first = buildChatPayload(cfg, messages, stream, {
    enable_thinking: false,
    chat_template_kwargs: { enable_thinking: false },
  });
  const minimal = buildChatPayload(cfg, messages, stream);
  const variants = [first, minimal];
  if (messagesHaveVision(messages)) variants.push(buildChatPayload(cfg, appendVisionQueryAnchor(messages), stream));
  return variants;
}
function payloadVariants(cfg, messages, kind, stream = false) {
  return kind === "chat"
    ? chatPayloadVariants(cfg, messages, stream)
    : cfg.webSearchEnabled
      ? [buildResponsesPayload(cfg, messages, stream), buildResponsesPayload(cfg, messages, stream, "web_search_preview"), buildResponsesPayload(cfg, messages, stream, null)]
      : [buildResponsesPayload(cfg, messages, stream, null)];
}
async function chatCompletions(cfg, messages, signal) {
  const headers = { authorization: `Bearer ${cfg.llm.apiKey}`, "content-type": "application/json" };
  console.log("[llm] config", publicLlmConfig(cfg));
  let lastErr = "LLM failed";
  for (const kind of llmKinds(cfg, messages)) {
    const endpoint = llmEndpoint(cfg, kind);
    const variants = payloadVariants(cfg, messages, kind, false);
    for (let i = 0; i < variants.length; i++) {
      const payload = variants[i];
      try {
        console.log("[llm] request", kind, cfg.llm.model, "tokens=", cfg.maxTokens, kind === "responses" ? `tool=${payload.tools?.[0]?.type}` : "");
        const res = await fetchLlmWithTransientRetry(endpoint, { method: "POST", headers, body: JSON.stringify(payload), signal }, 35000, cfg);
        if (!res.ok) {
          lastErr = formatLlmFailure(res.status, pickUpstreamErrorMessage(res));
          console.log("[llm] fail", kind, res.status, lastErr);
          if (i < variants.length - 1 && (res.status === 400 || isNoUserQueryError(lastErr))) continue;
          throw new Error(lastErr);
        }
        const textOut = cleanAssistantReply(extractLlmText(res.data, kind), messages);
        if (!textOut) {
          lastErr = `LLM returned empty content (${kind})`;
          console.log("[llm] empty content, raw=", String(res.raw || "").slice(0, 300));
          continue;
        }
        console.log("[llm] ok", kind, "chars=", textOut.length);
        return textOut;
      } catch (err) {
        lastErr = String(err.message || err);
        console.log("[llm] error", lastErr);
        throw new Error(lastErr);
      }
    }
    break;
  }
  throw new Error(lastErr);
}
const FUNCTION_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "搜索互联网。用户明确要求查找/搜索，或问题涉及天气、新闻、价格、政策、比赛、交通等实时或需核实的信息时，必须调用此工具；不要直接声称无法联网。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "简洁、完整的搜索关键词" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "查询当前日期、时间、星期和时区。",
      parameters: {
        type: "object",
        properties: { time_zone: { type: "string", description: "IANA 时区，例如 Asia/Hong_Kong、Asia/Shanghai；不填则使用用户时区" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description: "执行精确的基础数学计算，支持 + - * / % ^ 和括号。",
      parameters: {
        type: "object",
        properties: { expression: { type: "string", description: "只包含数字、运算符和括号的表达式，例如 (128+32)*0.85" } },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_reminder",
      description: "创建保存在用户浏览器本地的提醒。相对时间优先传 delay_minutes；绝对时间传带时区的 ISO 8601 due_at。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "提醒内容" },
          delay_minutes: { type: "number", description: "从现在起多少分钟后提醒" },
          due_at: { type: "string", description: "带时区的 ISO 8601 时间，例如 2026-07-26T09:00:00+08:00" },
        },
        required: ["title"],
      },
    },
  },
];
const TOOL_LABELS = {
  web_search: "联网搜索",
  get_current_time: "时间",
  calculate: "计算器",
  create_reminder: "提醒",
};
function functionToolsFor(cfg) {
  if (cfg.webSearchEnabled) return FUNCTION_TOOLS;
  return FUNCTION_TOOLS.filter((tool) => tool?.function?.name !== "web_search");
}
function mergeWebSearchUsage(current, next) {
  const query = String(next.query || "");
  const previousQueries = Array.isArray(current?.queries) ? current.queries : [];
  if (query && previousQueries.includes(query)) return current;
  const providers = Array.from(new Set([...(current ? [current.provider] : []), next.provider].filter(Boolean)));
  const titles = Array.from(new Set([...(current?.titles || []), ...(next.titles || [])])).slice(0, 6);
  return {
    used: true,
    explicit: Boolean(current?.explicit || next.explicit),
    provider: providers.join("+") || "exa",
    ok: Boolean(current?.ok || next.ok),
    count: Number(current?.count || 0) + Number(next.count || 0),
    error: [current?.error, next.error].filter(Boolean).join("; "),
    titles,
    queries: [...previousQueries, ...(query ? [query] : [])],
  };
}
function parseToolArguments(raw) {
  if (raw && typeof raw === "object") return raw;
  const text = String(raw || "").trim();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}
function normalizeToolCalls(message) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return calls.slice(0, 8).map((call, index) => ({
    id: String(call?.id || `call_${Date.now()}_${index}`),
    type: "function",
    function: {
      name: String(call?.function?.name || "").trim(),
      arguments: typeof call?.function?.arguments === "string" ? call.function.arguments : JSON.stringify(call?.function?.arguments || {}),
    },
  })).filter((call) => call.function.name);
}
function safeCalculateExpression(expression) {
  const value = String(expression || "").trim().slice(0, 200);
  if (!value || !/^[0-9+\-*/%^().\s]+$/.test(value)) throw new Error("表达式只能包含数字、基础运算符和括号");
  const normalized = value.replace(/\^/g, "**");
  const result = Function(`"use strict"; return (${normalized});`)();
  if (typeof result !== "number" || !Number.isFinite(result)) throw new Error("计算结果不是有限数字");
  return { expression: value, result };
}
function normalizeTimeZone(value, fallback = "Asia/Hong_Kong") {
  const candidate = String(value || fallback || "Asia/Hong_Kong").trim();
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback || "Asia/Hong_Kong";
  }
}
function currentTimeResult(timeZone) {
  const zone = normalizeTimeZone(timeZone);
  const now = new Date();
  return {
    iso: now.toISOString(),
    timeZone: zone,
    local: new Intl.DateTimeFormat("zh-CN", { timeZone: zone, dateStyle: "full", timeStyle: "long", hour12: false }).format(now),
  };
}
async function executeFunctionTool(cfg, call, signal, context) {
  const name = call.function.name;
  const args = parseToolArguments(call.function.arguments);
  if (name === "web_search") {
    if (!cfg.webSearchEnabled) return { content: { ok: false, error: "用户已关闭联网搜索" } };
    const query = normalizeWebSearchQuery(args.query);
    if (!query) return { content: { ok: false, error: "搜索词不能为空" } };
    const search = context
      ? await context.searchSession.execute({ query, signal })
      : await runWebSearch({ query, signal });
    const result = {
      content: { ok: search.ok, provider: search.provider, query: search.query, items: (search.items || []).slice(0, 6), error: search.error || "" },
      webSearch: { used: true, explicit: true, provider: search.provider, query: search.query, ok: search.ok, count: search.items?.length || 0, error: search.error || "", titles: (search.items || []).slice(0, 3).map((item) => item.title) },
    };
    return result;
  }
  if (name === "get_current_time") return { content: { ok: true, ...currentTimeResult(args.time_zone || cfg.timeZone) } };
  if (name === "calculate") return { content: { ok: true, ...safeCalculateExpression(args.expression) } };
  if (name === "create_reminder") {
    const title = String(args.title || "提醒").trim().slice(0, 200) || "提醒";
    const delayMinutes = Number(args.delay_minutes);
    let dueAt = "";
    if (Number.isFinite(delayMinutes) && delayMinutes >= 0) dueAt = new Date(Date.now() + Math.min(delayMinutes, 525600) * 60000).toISOString();
    else if (args.due_at) {
      const parsed = new Date(String(args.due_at));
      if (Number.isFinite(parsed.getTime())) dueAt = parsed.toISOString();
    }
    if (!dueAt) return { content: { ok: false, error: "缺少有效的 delay_minutes 或 due_at" } };
    const action = { type: "create_reminder", id: `reminder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, title, dueAt };
    return { content: { ok: true, title, dueAt, storage: "browser-local" }, action };
  }
  return { content: { ok: false, error: `未知工具: ${name}` } };
}
async function fetchChatToolStep(cfg, messages, signal, forceWebSearch = false) {
  const headers = { authorization: `Bearer ${cfg.llm.apiKey}`, "content-type": "application/json" };
  const endpoint = llmEndpoint(cfg, "chat");
  const tools = functionToolsFor(cfg);
  const toolChoice = forceWebSearch
    ? { type: "function", function: { name: "web_search" } }
    : "auto";
  const variants = chatPayloadVariants(cfg, messages, false).map((payload) => ({
    ...payload,
    tools: forceWebSearch ? tools.filter((tool) => tool?.function?.name === "web_search") : tools,
    tool_choice: toolChoice,
  }));
  let lastErr = "LLM tool call failed";
  for (let index = 0; index < variants.length; index++) {
    const res = await fetchLlmWithTransientRetry(endpoint, { method: "POST", headers, body: JSON.stringify(variants[index]), signal }, 15000, cfg);
    if (!res.ok) {
      lastErr = formatLlmFailure(res.status, pickUpstreamErrorMessage(res));
      if (index < variants.length - 1 && (res.status === 400 || isNoUserQueryError(lastErr))) continue;
      throw new Error(lastErr);
    }
    const message = res.data?.choices?.[0]?.message || {};
    return { message, text: extractTextContent(message.content), toolCalls: normalizeToolCalls(message) };
  }
  throw new Error(lastErr);
}
async function chatCompletionsWithTools(cfg, messages, signal) {
  const working = [...messages];
  const toolActions = [];
  const toolUsage = [];
  const executionContext = {
    searchSession: createWebSearchSession({ search: (options) => runWebSearch(options) }),
  };
  let webSearch = null;
  let forcedWebSearch = false;
  let refusalReply = "";
  const lastUserText = [...messages].reverse().find((message) => message.role === "user");
  const searchDisabledByUser = isWebSearchDisabledRequest(extractTextContent(lastUserText?.content));
  for (let round = 0; round < 4; round++) {
    let step;
    try {
      step = await fetchChatToolStep(cfg, working, signal, forcedWebSearch);
    } catch (err) {
      if (forcedWebSearch && refusalReply && !signal?.aborted) {
        return { reply: refusalReply, toolActions, toolUsage, webSearch };
      }
      throw err;
    }
    if (!step.toolCalls.length) {
      const reply = cleanAssistantReply(step.text, messages);
      if (!reply) {
        if (forcedWebSearch && refusalReply) return { reply: refusalReply, toolActions, toolUsage, webSearch };
        throw new Error("模型完成工具调用后没有返回文字");
      }
      if (round === 0 && !searchDisabledByUser && cfg.webSearchEnabled && isWebSearchRefusal(reply)) {
        refusalReply = reply;
        forcedWebSearch = true;
        continue;
      }
      return { reply, toolActions, toolUsage, webSearch };
    }
    forcedWebSearch = false;
    refusalReply = "";
    working.push({ role: "assistant", content: step.message.content || "", tool_calls: step.toolCalls });
    for (const call of step.toolCalls) {
      let result;
      try {
        result = await executeFunctionTool(cfg, call, signal, executionContext);
      } catch (err) {
        if (signal?.aborted || err?.name === "AbortError") throw err;
        result = { content: { ok: false, error: String(err.message || err) } };
      }
      toolUsage.push(TOOL_LABELS[call.function.name] || call.function.name);
      if (result.action) toolActions.push(result.action);
      if (result.webSearch) webSearch = mergeWebSearchUsage(webSearch, result.webSearch);
      working.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result.content) });
    }
  }
  const reply = await chatCompletions(cfg, working, signal);
  return { reply, toolActions, toolUsage, webSearch };
}
function extractResponseText(data) {
  const direct = data?.output_text || data?.text || data?.content || data?.reply;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const chunks = [];
  for (const item of data?.output || data?.response?.output || []) {
    for (const part of item?.content || []) {
      const text = part?.text || part?.delta || part?.content;
      if (typeof text === "string" && text.trim()) chunks.push(text);
    }
  }
  return chunks.join("").trim();
}
function splitSystemMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const instructions = list.filter((m) => m.role === "system").map((m) => m.content).join("\n\n").trim();
  const input = list.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
  return { instructions, input };
}
function buildChatPayload(cfg, messages, stream = false, extra = {}) {
  return { model: cfg.llm.model, messages, temperature: cfg.temperature, max_tokens: cfg.maxTokens, stream, ...extra };
}
function buildResponsesPayload(cfg, messages, stream = false, toolType = "web_search") {
  const { instructions, input } = splitSystemMessages(messages);
  const payload = { model: cfg.llm.model, input, temperature: cfg.temperature, max_output_tokens: cfg.maxTokens, stream };
  if (toolType) {
    payload.tools = [{ type: toolType }];
    payload.tool_choice = "auto";
  }
  if (instructions) payload.instructions = instructions;
  return payload;
}
function llmEndpoint(cfg, kind) {
  const fallbackPath = kind === "responses" ? "responses" : "chat/completions";
  if (normalizeApiType(cfg.llm.apiType, "auto") === "custom") {
    if (!cfg.llm.endpoint) throw new Error("缺少自定义 LLM 接口地址");
    return resolveCustomEndpoint(cfg.llm.baseUrl, cfg.llm.endpoint, fallbackPath);
  }
  return resolveCustomEndpoint(cfg.llm.baseUrl, "", fallbackPath);
}
function preferredLlmKind(cfg) {
  return normalizeApiType(cfg.llm.apiType, "auto") === "openai-responses" ? "responses" : "chat";
}
function buildLlmPayload(cfg, messages, kind, stream = false) {
  return kind === "responses" ? buildResponsesPayload(cfg, messages, stream) : buildChatPayload(cfg, messages, stream);
}
function extractLlmText(data, kind) {
  return kind === "responses" ? extractResponseText(data) : extractChatText(data);
}
async function readFetchError(res) {
  const textBody = await res.text().catch(() => "");
  return summarizeUpstreamError(res.status, res.statusText, res.headers?.get?.("content-type"), textBody);
}
function extractStreamDelta(data, kind, eventName = "") {
  if (!data || typeof data !== "object") return "";
  const type = String(data.type || eventName || "");
  if (data.error) throw new Error(String(data.error.message || data.error || "LLM stream error"));
  if (kind === "responses") {
    if (/output_text\.delta|output_text_delta/i.test(type) && typeof data.delta === "string") return data.delta;
    if (/response\.completed/i.test(type)) return "";
    if (typeof data.delta === "string" && /output|text|delta/i.test(type)) return data.delta;
    if (typeof data.text === "string" && /output|text/i.test(type)) return data.text;
    return "";
  }
  const choice = data.choices?.[0] || {};
  const delta = choice.delta || choice.message || {};
  const content = delta.content ?? choice.text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => typeof p === "string" ? p : p?.text || "").join("");
  return "";
}
function parseSseBlock(block) {
  let eventName = "message";
  const dataLines = [];
  for (const rawLine of String(block || "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) eventName = line.slice(6).trim() || "message";
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    else if (line.trimStart().startsWith("{")) dataLines.push(line.trim());
  }
  return { eventName, dataText: dataLines.join("\n").trim() };
}
function readStreamChunkWithTimeout(reader, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("LLM stream timeout waiting for output")), timeoutMs);
    reader.read().then(
      (result) => { clearTimeout(timer); resolve(result); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
async function readLlmStreamResponse(res, kind, onDelta) {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const data = await res.json().catch(() => null);
    const textOut = extractLlmText(data, kind);
    if (textOut) onDelta(textOut);
    return textOut;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  let reply = "";
  const applyDelta = (delta, cumulative = false) => {
    if (!delta) return;
    const merged = mergeStreamText(reply, delta, cumulative);
    reply = merged.reply;
    if (merged.delta) onDelta(merged.delta, reply);
  };
  const handleBlock = (block) => {
    const { eventName, dataText } = parseSseBlock(block);
    if (!dataText || dataText === "[DONE]") return;
    try {
      const data = JSON.parse(dataText);
      const choice = data?.choices?.[0] || {};
      const cumulative = kind === "chat" && Boolean(choice.message) && !choice.delta;
      applyDelta(extractStreamDelta(data, kind, eventName), cumulative);
      if (/response\.completed/i.test(String(data?.type || eventName || "")) && !reply) {
        const finalText = extractResponseText(data.response || data);
        applyDelta(finalText);
      }
    } catch (err) {
      if (dataText.startsWith("{")) throw err;
      applyDelta(dataText);
    }
  };
  try {
    while (true) {
      const { done, value } = await readStreamChunkWithTimeout(reader, reply ? 20000 : 15000);
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      raw = (raw + chunk).slice(-1024 * 1024);
      buffer += chunk.replace(/\r\n/g, "\n");
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleBlock(block);
      }
    }
    const tail = decoder.decode();
    if (tail) buffer += tail;
    if (buffer.trim()) handleBlock(buffer);
  } catch (err) {
    err.partial = reply;
    throw err;
  }
  if (!reply && raw.trim()) {
    try {
      const data = JSON.parse(raw.trim());
      const finalText = extractLlmText(data, kind);
      applyDelta(finalText);
    } catch {}
  }
  return reply.trim();
}
async function fetchLlmStreamOnce(rawUrl, options, timeoutMs) {
  const target = await resolveSafeUpstream(rawUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let upstreamReq = null;
    const signal = options.signal;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      const err = makeAbortError(signal?.reason);
      upstreamReq?.destroy(err);
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const u = target.url;
    const lib = u.protocol === "https:" ? https : http;
    upstreamReq = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || "GET",
      headers: options.headers || {},
      lookup: pinnedLookup(target.addresses),
      timeout: timeoutMs,
    }, (upstreamRes) => {
      clearTimeout(timer);
      const headers = new Headers();
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) if (item != null) headers.append(name, String(item));
      }
      const emptyBody = upstreamRes.statusCode === 204 || upstreamRes.statusCode === 304;
      const response = new Response(emptyBody ? null : Readable.toWeb(upstreamRes), {
        status: upstreamRes.statusCode || 502,
        statusText: upstreamRes.statusMessage || "",
        headers,
      });
      settled = true;
      upstreamRes.once("close", cleanup);
      resolve(response);
    });
    timer = setTimeout(() => {
      const err = new Error("upstream timeout");
      upstreamReq.destroy(err);
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    }, timeoutMs);
    upstreamReq.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
    if (options.body) upstreamReq.write(options.body);
    upstreamReq.end();
  });
}
async function streamChatCompletions(cfg, messages, onDelta, signal) {
  const headers = { authorization: `Bearer ${cfg.llm.apiKey}`, "content-type": "application/json" };
  console.log("[llm] config", publicLlmConfig(cfg));
  let lastErr = "LLM failed";
  for (const kind of llmKinds(cfg, messages)) {
    const endpoint = llmEndpoint(cfg, kind);
    const variants = payloadVariants(cfg, messages, kind, true);
    for (let i = 0; i < variants.length; i++) {
      const payload = variants[i];
      try {
        console.log("[llm] stream", kind, cfg.llm.model, "tokens=", cfg.maxTokens);
        let res = await fetchLlmStreamOnce(endpoint, { method: "POST", headers, body: JSON.stringify(payload), signal }, 15000);
        if (!res.ok) {
          let errText = await readFetchError(res);
          if (isTransientAuthError(res.status, errText)) {
            console.log("[llm] transient stream auth error, retry once", { status: res.status, ...publicLlmConfig(cfg) });
            await sleep(800, signal);
            res = await fetchLlmStreamOnce(endpoint, { method: "POST", headers, body: JSON.stringify(payload), signal }, 15000);
            if (!res.ok) errText = await readFetchError(res);
          }
          if (!res.ok) {
            lastErr = formatLlmFailure(res.status, errText);
            console.log("[llm] stream fail", kind, res.status, lastErr);
            if (i < variants.length - 1 && (res.status === 400 || isNoUserQueryError(lastErr))) continue;
            throw new Error(lastErr);
          }
        }
        const reply = await readLlmStreamResponse(res, kind, onDelta);
        const cleanedReply = cleanAssistantReply(reply, messages);
        if (cleanedReply) {
          console.log("[llm] stream ok", kind, "chars=", cleanedReply.length);
          return cleanedReply;
        }
        lastErr = `LLM stream returned empty content (${kind})`;
      } catch (err) {
        if (err?.partial) err.partial = cleanAssistantReply(err.partial, messages);
        lastErr = String(err.message || err);
        console.log("[llm] stream error", lastErr);
        throw err;
      }
    }
    break;
  }
  throw new Error(lastErr);
}
async function safeSearchFetch(rawUrl, options) {
  const result = await fetchJson(rawUrl, options, 10000);
  const headers = new Headers();
  for (const [name, value] of Object.entries(result.headers || {})) {
    for (const item of Array.isArray(value) ? value : [value]) if (item != null) headers.append(name, String(item));
  }
  return new Response(result.buffer, { status: result.status || 502, headers });
}
async function runWebSearch(options = {}) {
  return runExaWebSearch({ ...options, fetchImpl: safeSearchFetch });
}
function sanitizeMessages(messages, systemPrompt, maxTurns) {
  const rest = (messages || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ role: m.role, content: sanitizeMessageContent(m.content) }))
    .filter((m) => typeof m.content === "string" ? Boolean(m.content.trim()) : m.content.length > 0);
  const keep = Math.max(2, (maxTurns || 12) * 2);
  return [{ role: "system", content: withReplyOnlyInstruction(systemPrompt) }, ...rest.slice(-keep)];
}
async function prepareChat(body, signal) {
  if (signal?.aborted) throw makeAbortError(signal.reason);
  const cfg = resolveConfig(body.config || {});
  if (!cfg.llm.apiKey) { const e = new Error("缺少 API Key：请在本地配置填写"); e.status = 401; throw e; }
  let messages = Array.isArray(body.messages) ? body.messages : [];
  if (body.message) messages = [...messages, { role: "user", content: String(body.message) }];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const userText = extractTextContent(lastUser?.content);
  if (!userText) { const e = new Error("请输入消息"); e.status = 400; throw e; }
  let systemPrompt = cfg.systemPrompt;
  const hasVision = messagesHaveVision(messages);
  const useFunctionTools = !hasVision && cfg.toolCallingEnabled && preferredLlmKind(cfg) === "chat";
  if (useFunctionTools) {
    const now = currentTimeResult(cfg.timeZone);
    const searchInstruction = cfg.webSearchEnabled
      ? "你具备 web_search。用户明确要求查找/搜索，或回答依赖实时、最新、天气等外部信息时，必须先调用 web_search；query 由你根据用户问题生成。不要声称自己无法联网。"
      : "联网搜索未启用，不要假装已经执行搜索。";
    systemPrompt = `${systemPrompt}\n\n当前用户时区：${now.timeZone}。当前日期时间：${now.local}（${now.iso}）。${searchInstruction}需要计算、时间或提醒时调用对应函数工具，不要假装已经执行工具。`;
  }
  if (signal?.aborted) throw makeAbortError(signal.reason);
  const finalMessages = sanitizeMessages(messages, systemPrompt, cfg.maxHistoryTurns);
  return { cfg, useFunctionTools, finalMessages };
}
async function handleChat(body, signal) {
  const prepared = await prepareChat(body, signal);
  if (prepared.useFunctionTools) {
    const result = await chatCompletionsWithTools(prepared.cfg, prepared.finalMessages, signal);
    return { ok: true, reply: result.reply, model: prepared.cfg.llm.model, ttsEnabled: prepared.cfg.ttsEnabled, webSearch: result.webSearch, toolActions: result.toolActions, toolUsage: result.toolUsage };
  }
  const reply = await chatCompletions(prepared.cfg, prepared.finalMessages, signal);
  return { ok: true, reply, model: prepared.cfg.llm.model, ttsEnabled: prepared.cfg.ttsEnabled, webSearch: null };
}
function writeSse(res, event, data) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
async function handleChatStream(body, res, signal) {
  const prepared = await prepareChat(body, signal);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
  });
  let reply = "";
  writeSse(res, "ready", { ok: true });
  try {
    let doneWebSearch = null;
    let doneToolActions = [];
    let doneToolUsage = [];
    if (prepared.useFunctionTools) {
      const result = await chatCompletionsWithTools(prepared.cfg, prepared.finalMessages, signal);
      reply = result.reply;
      doneWebSearch = result.webSearch;
      doneToolActions = result.toolActions;
      doneToolUsage = result.toolUsage;
      writeSse(res, "delta", { text: reply });
    } else if (messagesHaveVision(prepared.finalMessages)) {
      reply = await chatCompletions(prepared.cfg, prepared.finalMessages, signal);
      writeSse(res, "delta", { text: reply });
    } else {
      reply = await streamChatCompletions(prepared.cfg, prepared.finalMessages, (text) => writeSse(res, "delta", { text }), signal);
    }
    writeSse(res, "done", { ok: true, reply, model: prepared.cfg.llm.model, ttsEnabled: prepared.cfg.ttsEnabled, webSearch: doneWebSearch, toolActions: doneToolActions, toolUsage: doneToolUsage });
  } catch (err) {
    if (!signal?.aborted) writeSse(res, "error", { error: String(err.message || err), partial: err.partial || reply || "" });
  } finally {
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}
function pickTranscript(data) {
  for (const c of [data?.text, data?.result, data?.transcript, data?.data?.text]) if (typeof c === "string" && c.trim()) return c.trim();
  return "";
}
async function transcribe(cfg, file, signal) {
  const isCustom = normalizeApiType(cfg.stt.apiType, "auto") === "custom";
  if (isCustom && !cfg.stt.endpoint) throw new Error("缺少自定义语音识别接口地址");
  const endpoint = resolveCustomEndpoint(cfg.stt.baseUrl, isCustom ? cfg.stt.endpoint : "", "audio/transcriptions");
  const models = Array.from(new Set([cfg.stt.model, "FunAudioLLM/SenseVoiceSmall", "TeleAI/TeleSpeechASR"].filter(Boolean)));
  let lastErr = "语音识别没有返回文字";
  for (const model of models) {
    for (const withLang of [true, false]) {
      const boundary = "----parentchat" + Date.now();
      const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`, "utf8");
      const mid = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n` + (withLang ? `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nzh\r\n` : "") + `--${boundary}--\r\n`, "utf8");
      const body = Buffer.concat([pre, file.buffer, mid]);
      try {
        const res = await fetchJson(endpoint, { method: "POST", headers: { authorization: `Bearer ${cfg.stt.apiKey}`, "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) }, body, signal }, 60000);
        if (!res.ok) { lastErr = pickUpstreamErrorMessage(res); continue; }
        const textOut = pickTranscript(res.data);
        if (textOut) return { text: textOut, model };
        lastErr = "语音识别没有返回文字";
      } catch (err) {
        if (signal?.aborted) throw err;
        lastErr = String(err.message || err);
      }
    }
  }
  throw new Error(lastErr);
}
function isMimoTts(cfg) {
  const apiType = normalizeApiType(cfg.tts.apiType, "auto");
  if (apiType === "xiaomi-mimo") return true;
  if (apiType === "openai-speech" || apiType === "custom") return false;
  const host = (() => { try { return new URL(cfg.tts.baseUrl).hostname.toLowerCase(); } catch { return ""; } })();
  return host.includes("xiaomimimo.com") || /^mimo-v\d/i.test(String(cfg.tts.model || ""));
}
function normalizeMimoVoice(voice) {
  const v = String(voice || "").trim();
  if (!v || v === "alloy" || v === "default") return "mimo_default";
  return v;
}
function base64ToBuffer(data) {
  const raw = String(data || "").replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
  if (!raw) return null;
  return Buffer.from(raw, "base64");
}
async function synthesizeMimo(cfg, inputText, signal) {
  const payload = JSON.stringify({
    model: cfg.tts.model,
    messages: [{ role: "assistant", content: String(inputText || "").slice(0, 800) }],
    audio: { format: "wav", voice: normalizeMimoVoice(cfg.tts.voice) },
  });
  const res = await fetchJson(cfg.tts.baseUrl + "/chat/completions", {
    method: "POST",
    headers: {
      "api-key": cfg.tts.apiKey,
      authorization: `Bearer ${cfg.tts.apiKey}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
    },
    body: payload,
    signal,
  }, 60000);
  if (!res.ok) throw new Error(`小米 MiMo TTS: ${pickUpstreamErrorMessage(res)}`);
  const audioData = res.data?.choices?.[0]?.message?.audio?.data || res.data?.audio?.data || res.data?.data;
  const buffer = base64ToBuffer(audioData);
  if (!buffer?.length) throw new Error("小米 MiMo TTS 没有返回音频数据");
  return { buffer, contentType: "audio/wav" };
}
async function synthesizeOpenAiSpeech(cfg, inputText, signal) {
  const isCustom = normalizeApiType(cfg.tts.apiType, "auto") === "custom";
  if (isCustom && !cfg.tts.endpoint) throw new Error("缺少自定义 TTS 接口地址");
  const endpoint = resolveCustomEndpoint(cfg.tts.baseUrl, isCustom ? cfg.tts.endpoint : "", "audio/speech");
  const payload = JSON.stringify({
    model: cfg.tts.model,
    voice: cfg.tts.voice || "alloy",
    input: String(inputText || "").slice(0, 800),
    response_format: "mp3",
  });
  const res = await fetchJson(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.tts.apiKey}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
    },
    body: payload,
    signal,
  }, 60000);
  if (!res.ok) throw new Error(pickUpstreamErrorMessage(res));
  return { buffer: res.buffer, contentType: res.headers?.["content-type"] || "audio/mpeg" };
}
async function synthesize(cfg, inputText, signal) {
  if (isMimoTts(cfg)) return synthesizeMimo(cfg, inputText, signal);
  return synthesizeOpenAiSpeech(cfg, inputText, signal);
}
function createSilentWav(durationMs = 250) {
  const sampleRate = 16000;
  const samples = Math.max(1, Math.round(sampleRate * durationMs / 1000));
  const dataSize = samples * 2;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataSize, 40);
  return wav;
}
async function testTranscription(cfg, signal) {
  if (!cfg.stt.apiKey) throw new Error("缺少语音识别 API Key");
  if (!cfg.stt.baseUrl) throw new Error("缺少语音识别 Base URL");
  if (!cfg.stt.model) throw new Error("缺少语音识别 Model");
  const isCustom = normalizeApiType(cfg.stt.apiType, "auto") === "custom";
  if (isCustom && !cfg.stt.endpoint) throw new Error("缺少自定义语音识别接口地址");
  const endpoint = resolveCustomEndpoint(cfg.stt.baseUrl, isCustom ? cfg.stt.endpoint : "", "audio/transcriptions");
  const boundary = "----voicecalltest" + Date.now();
  const wav = createSilentWav();
  const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="connection-test.wav"\r\nContent-Type: audio/wav\r\n\r\n`, "utf8");
  const tail = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${cfg.stt.model}\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n--${boundary}--\r\n`, "utf8");
  const body = Buffer.concat([pre, wav, tail]);
  const result = await fetchJson(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.stt.apiKey}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": String(body.length),
    },
    body,
    signal,
  }, 30000);
  if (!result.ok) throw new Error(pickUpstreamErrorMessage(result));
  return { text: pickTranscript(result.data), bytes: wav.length };
}
async function testProviders(cfg, signal) {
  const result = {
    ok: false,
    llm: { baseUrl: cfg.llm.baseUrl, model: cfg.llm.model, apiType: cfg.llm.apiType, endpoint: cfg.llm.endpoint, hasKey: Boolean(cfg.llm.apiKey) },
    stt: { baseUrl: cfg.stt.baseUrl, model: cfg.stt.model, apiType: cfg.stt.apiType, endpoint: cfg.stt.endpoint, hasKey: Boolean(cfg.stt.apiKey) },
    tts: { ...publicTtsConfig(cfg), enabled: cfg.ttsEnabled },
    llmTest: { ok: false },
    sttTest: { ok: false },
    ttsTest: { ok: false },
  };
  const failures = [];

  try {
    if (!cfg.llm.apiKey) throw new Error("缺少大模型 API Key");
    const reply = await chatCompletions(
      { ...cfg, maxTokens: 256 },
      [{ role: "system", content: "你是测试助手，只回复：连接成功。" }, { role: "user", content: "ping" }],
      signal,
    );
    result.llmTest = { ok: true, reply };
  } catch (err) {
    if (signal?.aborted) throw err;
    const error = String(err.message || err);
    result.llmTest = { ok: false, error };
    failures.push(`LLM：${error}`);
  }

  try {
    const stt = await testTranscription(cfg, signal);
    result.sttTest = { ok: true, text: stt.text, bytes: stt.bytes };
  } catch (err) {
    if (signal?.aborted) throw err;
    const error = String(err.message || err);
    result.sttTest = { ok: false, error };
    failures.push(`STT：${error}`);
  }

  if (!cfg.ttsEnabled) {
    result.ttsTest = { ok: true, skipped: true, reason: "在线 TTS 已关闭" };
  } else {
    try {
      if (!cfg.tts.apiKey) throw new Error("缺少语音合成 API Key");
      const audio = await synthesize(cfg, "连接测试", signal);
      if (!audio.buffer?.length) throw new Error("语音合成没有返回音频数据");
      result.ttsTest = { ok: true, bytes: audio.buffer.length, contentType: audio.contentType };
    } catch (err) {
      if (signal?.aborted) throw err;
      const error = String(err.message || err);
      result.ttsTest = { ok: false, error };
      failures.push(`TTS：${error}`);
    }
  }

  result.ok = failures.length === 0;
  if (failures.length) result.error = failures.join("；");
  return result;
}
function publicTtsConfig(cfg) {
  return { baseUrl: cfg.tts.baseUrl, model: cfg.tts.model, voice: cfg.tts.voice, apiType: cfg.tts.apiType, endpoint: cfg.tts.endpoint, hasKey: Boolean(cfg.tts.apiKey) };
}
function formatTtsError(err) {
  const msg = String(err?.message || err || "").trim();
  return msg ? `TTS 请求失败：${msg}` : "TTS 请求失败";
}

function watchClientDisconnect(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort(makeAbortError("client disconnected"));
  };
  const onClose = () => { if (!res.writableEnded) abort(); };
  req.once("aborted", abort);
  res.once("close", onClose);
  return {
    signal: controller.signal,
    cleanup() {
      req.removeListener("aborted", abort);
      res.removeListener("close", onClose);
    },
  };
}

const requestHandler = async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = url.pathname;
    if (pathname.startsWith("/api/")) {
      const refusal = checkLocalRequest(req);
      if (refusal) {
        console.log("[guard] blocked", req.method, pathname, "host=", req.headers.host, "origin=", req.headers.origin || "-");
        return json(res, 403, { ok: false, error: refusal });
      }
    }
    if (req.method === "OPTIONS") { res.writeHead(204, { "cache-control": "no-store" }); return res.end(); }
    if (pathname === "/api/health") return json(res, 200, { ok: true, service: "ai-voice-call-local", time: new Date().toISOString(), secure: Boolean(req.socket && req.socket.encrypted) });
    if (pathname === "/api/defaults" && req.method === "GET") return json(res, 200, { ok: true, defaults: { llm: { baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen3.5-4B", apiType: "auto", endpoint: "" }, stt: { baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/SenseVoiceSmall", apiType: "auto", endpoint: "" }, tts: { baseUrl: "https://api.siliconflow.cn/v1", model: "FnLP/MOSS-TTSD-v0.5", voice: "alloy", apiType: "auto", endpoint: "" }, systemPromptPreset: "general", systemPrompt: DEFAULT_SYSTEM_PROMPT, maxHistoryTurns: 12, maxTokens: 512, temperature: 0.7, ttsEnabled: true, browserTtsFallback: true, autoSpeak: true, toolCallingEnabled: true, webSearchEnabled: true } });
    if (pathname === "/api/chat/stream" && req.method === "POST") {
      const client = watchClientDisconnect(req, res);
      try {
        const body = await readJsonBody(req);
        const started = Date.now();
        console.log("[chat:stream] in", (body.messages || []).length, "msgs, search=", body.config?.webSearchEnabled);
        await handleChatStream(body, res, client.signal);
        console.log("[chat:stream] out in", Date.now() - started, "ms");
        return;
      } catch (err) {
        console.log("[chat:stream] fail:", err.message || err);
        if (client.signal.aborted) return;
        if (!res.headersSent) return json(res, err.status || 500, { ok: false, error: String(err.message || err) });
        try { writeSse(res, "error", { error: String(err.message || err) }); res.end(); } catch {}
        return;
      } finally {
        client.cleanup();
      }
    }
    if (pathname === "/api/chat" && req.method === "POST") {
      const client = watchClientDisconnect(req, res);
      try {
        const body = await readJsonBody(req);
        const started = Date.now();
        console.log("[chat] in", (body.messages || []).length, "msgs, search=", body.config?.webSearchEnabled);
        const out = await handleChat(body, client.signal);
        console.log("[chat] out ok in", Date.now() - started, "ms");
        return json(res, 200, out);
      } catch (err) {
        console.log("[chat] out fail:", err.message || err);
        if (client.signal.aborted) return;
        throw err;
      } finally {
        client.cleanup();
      }
    }
    if (pathname === "/api/test" && req.method === "POST") {
      const client = watchClientDisconnect(req, res);
      try {
        const body = await readJsonBody(req);
        const result = await testProviders(resolveConfig(body.config || {}), client.signal);
        return json(res, result.ok ? 200 : 502, result);
      } finally {
        client.cleanup();
      }
    }
    if (pathname === "/api/search" && req.method === "POST") {
      const body = await readJsonBody(req); const q = String(body.query || body.q || "").trim();
      if (!q) return json(res, 400, { ok: false, error: "missing query" });
      const client = watchClientDisconnect(req, res);
      try {
        return json(res, 200, await runWebSearch({ query: q, signal: client.signal }));
      } finally {
        client.cleanup();
      }
    }
    if (pathname === "/api/asr" && req.method === "POST") {
      const client = watchClientDisconnect(req, res);
      try {
        const raw = await readBody(req); const parsed = parseMultipart(raw, req.headers["content-type"]);
        if (!parsed.file) return json(res, 400, { ok: false, error: "missing audio file" });
        let clientConfig = {};
        const headerCfg = req.headers["x-client-config"];
        try {
          if (headerCfg) { const s = String(headerCfg); clientConfig = s.trim().startsWith("{") ? JSON.parse(s) : JSON.parse(Buffer.from(s, "base64").toString("utf8")); }
          else if (parsed.fields.config) clientConfig = JSON.parse(parsed.fields.config);
        } catch {
          return json(res, 400, { ok: false, error: "config 不是有效的 JSON" });
        }
        const cfg = resolveConfig(clientConfig);
        if (!cfg.stt.apiKey) return json(res, 401, { ok: false, error: "缺少语音识别 API Key" });
        const result = await transcribe(cfg, parsed.file, client.signal);
        return json(res, 200, { ok: true, text: result.text, model: result.model, bytes: parsed.file.buffer.length });
      } finally {
        client.cleanup();
      }
    }
    if (pathname === "/api/tts" && req.method === "POST") {
      const client = watchClientDisconnect(req, res);
      try {
        const body = await readJsonBody(req); const cfg = resolveConfig(body.config || {});
        const textInput = String(body.text || "").trim();
        if (!textInput) return json(res, 400, { ok: false, error: "缺少要合成的文字" });
        if (cfg.ttsEnabled === false) return json(res, 400, { ok: false, error: "在线 TTS 已关闭" });
        if (!cfg.tts.baseUrl) return json(res, 400, { ok: false, error: "缺少 TTS Base URL", tts: publicTtsConfig(cfg) });
        if (!cfg.tts.model) return json(res, 400, { ok: false, error: "缺少 TTS Model", tts: publicTtsConfig(cfg) });
        if (!cfg.tts.apiKey) return json(res, 401, { ok: false, error: "缺少 TTS API Key", tts: publicTtsConfig(cfg) });
        try {
          const audio = await synthesize(cfg, textInput, client.signal);
          res.writeHead(200, { "content-type": audio.contentType || "audio/mpeg", "cache-control": "no-store" });
          return res.end(audio.buffer);
        } catch (err) {
          if (client.signal.aborted) return;
          const error = formatTtsError(err);
          console.log("[tts] fail", publicTtsConfig(cfg), err?.message || err);
          return json(res, 502, { ok: false, error, tts: publicTtsConfig(cfg) });
        }
      } finally {
        client.cleanup();
      }
    }
    let reqPath = decodeURIComponent(pathname); if (reqPath === "/") reqPath = "/index.html";
    const safe = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(PUBLIC_DIR, safe);
    if (!filePath.startsWith(PUBLIC_DIR)) return text(res, 403, "forbidden");
    return sendFile(res, filePath);
  } catch (err) {
    if (res.destroyed || res.writableEnded) return;
    return json(res, err.status || 500, { ok: false, error: String(err.message || err) });
  }
}
const httpServer = http.createServer(requestHandler);

httpServer.listen(PORT, HOST, () => {
  console.log("========================================");
  console.log(" AI语音通话 LOCAL server is running");
  console.log("========================================");
  console.log("PC: http://127.0.0.1:" + PORT);
  if (HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1") console.log("提示：当前监听 " + HOST + "，服务可能对局域网开放。");
  console.log("手机端请使用已部署的 Cloudflare HTTPS 地址。");
  console.log("");
  console.log("Keep this window open. Press Ctrl+C to stop.");
});

httpServer.on("error", (err) => {
  console.error("Server failed:", err.message);
  if (err.code === "EADDRINUSE") console.error("Port " + PORT + " in use. Close old window / rerun starter.");
  process.exit(1);
});

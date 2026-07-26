import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";

const DEFAULT_SYSTEM_PROMPT = "你是一个中文 AI 助手。默认使用简体中文，回答清楚、自然、有帮助。优先给出可执行建议，少说空话。根据用户语气调整详略；适合语音朗读时使用短句。涉及医疗、药品、投资、法律等高风险内容时，只提供一般信息，提醒不能替代专业人士。若提供了【联网搜索结果】，请优先依据结果回答，不编造实时数据。不要输出思考过程。";

function env(name, fallback = "") { return String(process.env[name] ?? fallback).trim(); }
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
  if (origin && origin !== "null") {
    let originHost = "";
    // URL.host drops nothing: it keeps the port and, for IPv6, the brackets
    // ("[::1]:8787"). Run it through the same hostOnly() as the Host header so
    // both sides are normalized identically.
    try { originHost = hostOnly(new URL(origin).host); } catch { return `拒绝请求：无法解析的 Origin "${origin}"。`; }
    if (originHost !== host) return `拒绝跨站请求：Origin "${origin}" 与本服务 "${host}" 不同源。`;
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
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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
    maxTokens: Math.max(Number(client.maxTokens || env("LLM_MAX_TOKENS") || 512), 256),
    temperature: Number((client.temperature ?? env("LLM_TEMPERATURE", "0.7")) || 0.7),
    ttsEnabled: client.ttsEnabled !== false,
    toolCallingEnabled: client.toolCallingEnabled !== false,
    timeZone: pick(client.timeZone, "Asia/Hong_Kong"),
    webSearchEnabled: client.webSearchEnabled !== false && env("WEB_SEARCH_ENABLED", "true") !== "false",
    searchProvider: pick(client.searchProvider, env("SEARCH_PROVIDER"), "auto"),
    searchApiKey: pick(client.searchApiKey),
    searchBaseUrl: pick(client.searchBaseUrl, env("SEARCH_BASE_URL")),
  };
}
function fetchJson(url, options = {}, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      fn(arg);
    };
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || "GET",
      headers: options.headers || {},
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
    const hardTimer = setTimeout(() => {
      req.destroy();
      done(reject, new Error("upstream timeout"));
    }, timeoutMs);
    req.on("error", (err) => done(reject, err));
    req.on("timeout", () => {
      req.destroy();
      done(reject, new Error("upstream timeout"));
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
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
    await sleep(800);
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
    : [buildResponsesPayload(cfg, messages, stream), buildResponsesPayload(cfg, messages, stream, "web_search_preview")];
}
async function chatCompletions(cfg, messages) {
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
        const res = await fetchLlmWithTransientRetry(endpoint, { method: "POST", headers, body: JSON.stringify(payload) }, 35000, cfg);
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
      description: "搜索互联网中的最新信息。适合新闻、价格、政策、比赛、交通、产品资料等需要实时或可核实来源的问题。",
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
      name: "get_weather",
      description: "查询某个城市或地区的当前天气与短期预报。",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "城市或地区，例如香港、深圳、北京市朝阳区" },
          date: { type: "string", description: "可选，今天、明天、后天或具体日期" },
        },
        required: ["location"],
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
  get_weather: "天气",
  get_current_time: "时间",
  calculate: "计算器",
  create_reminder: "提醒",
};
function shouldUseFunctionTools(text) {
  const value = cleanSearchText(text);
  if (!value) return false;
  if (/提醒|闹钟|到时叫我|记得叫我|分钟后|小时后/.test(value)) return true;
  if (/几点|现在时间|当前时间|日期|几号|星期几|今天星期/.test(value)) return true;
  if (/计算|算一下|等于多少|[0-9][0-9\s.+\-*/%^()]{2,}/.test(value)) return true;
  return false;
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
async function executeFunctionTool(cfg, call) {
  const name = call.function.name;
  const args = parseToolArguments(call.function.arguments);
  if (name === "web_search") {
    if (!cfg.webSearchEnabled) return { content: { ok: false, error: "用户已关闭联网搜索" } };
    const query = String(args.query || "").trim().slice(0, 160);
    const search = await runWebSearch({ query, provider: cfg.searchProvider, apiKey: cfg.searchApiKey, baseUrl: cfg.searchBaseUrl });
    return {
      content: { ok: search.ok, provider: search.provider, query: search.query, items: (search.items || []).slice(0, 6), error: search.error || "" },
      webSearch: { used: true, explicit: true, provider: search.provider, ok: search.ok, count: search.items?.length || 0, error: search.error || "", titles: (search.items || []).slice(0, 3).map((item) => item.title) },
    };
  }
  if (name === "get_weather") {
    if (!cfg.webSearchEnabled) return { content: { ok: false, error: "用户已关闭联网搜索" } };
    const location = String(args.location || "").trim().slice(0, 80);
    const date = String(args.date || "").trim().slice(0, 40);
    const search = await runWebSearch({ query: `${location} ${date} 天气`.trim(), provider: "weather", apiKey: cfg.searchApiKey, baseUrl: cfg.searchBaseUrl });
    return {
      content: { ok: search.ok, location, date, items: (search.items || []).slice(0, 4), error: search.error || "" },
      webSearch: { used: true, explicit: true, provider: search.provider, ok: search.ok, count: search.items?.length || 0, error: search.error || "", titles: (search.items || []).slice(0, 3).map((item) => item.title) },
    };
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
async function fetchChatToolStep(cfg, messages) {
  const headers = { authorization: `Bearer ${cfg.llm.apiKey}`, "content-type": "application/json" };
  const endpoint = llmEndpoint(cfg, "chat");
  const variants = chatPayloadVariants(cfg, messages, false).map((payload) => ({ ...payload, tools: FUNCTION_TOOLS, tool_choice: "auto" }));
  let lastErr = "LLM tool call failed";
  for (let index = 0; index < variants.length; index++) {
    const res = await fetchLlmWithTransientRetry(endpoint, { method: "POST", headers, body: JSON.stringify(variants[index]) }, 15000, cfg);
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
async function chatCompletionsWithTools(cfg, messages) {
  const working = [...messages];
  const toolActions = [];
  const toolUsage = [];
  let webSearch = null;
  for (let round = 0; round < 4; round++) {
    const step = await fetchChatToolStep(cfg, working);
    if (!step.toolCalls.length) {
      const reply = cleanAssistantReply(step.text, messages);
      if (!reply) throw new Error("模型完成工具调用后没有返回文字");
      return { reply, toolActions, toolUsage, webSearch };
    }
    working.push({ role: "assistant", content: step.message.content || "", tool_calls: step.toolCalls });
    for (const call of step.toolCalls) {
      let result;
      try {
        result = await executeFunctionTool(cfg, call);
      } catch (err) {
        result = { content: { ok: false, error: String(err.message || err) } };
      }
      toolUsage.push(TOOL_LABELS[call.function.name] || call.function.name);
      if (result.action) toolActions.push(result.action);
      if (result.webSearch) webSearch = result.webSearch;
      working.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result.content) });
    }
  }
  const reply = await chatCompletions(cfg, working);
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
  const payload = { model: cfg.llm.model, input, temperature: cfg.temperature, max_output_tokens: cfg.maxTokens, stream, tools: [{ type: toolType }] };
  payload.tool_choice = "auto";
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
async function fetchLlmStreamOnce(endpoint, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(endpoint, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function streamChatCompletions(cfg, messages, onDelta) {
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
        let res = await fetchLlmStreamOnce(endpoint, { method: "POST", headers, body: JSON.stringify(payload) }, 15000);
        if (!res.ok) {
          let errText = await readFetchError(res);
          if (isTransientAuthError(res.status, errText)) {
            console.log("[llm] transient stream auth error, retry once", { status: res.status, ...publicLlmConfig(cfg) });
            await sleep(800);
            res = await fetchLlmStreamOnce(endpoint, { method: "POST", headers, body: JSON.stringify(payload) }, 15000);
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
function cleanSearchText(text) { return String(text || "").replace(/\s+/g, " ").trim(); }
function truncateSearchText(text, max = 180) {
  const t = cleanSearchText(text);
  return t.length > max ? t.slice(0, max) + "…" : t;
}
// Topics that on their own imply a live-data lookup.
const REALTIME_KEYS = [
  "天气", "气温", "下雨", "下雪", "台风", "空气质量", "新闻", "头条", "热点", "热搜",
  "股价", "股票", "行情", "汇率", "油价", "金价", "黄金", "白银", "银价", "比特币", "btc", "eth",
  "比分", "赛程", "谁赢了", "开奖", "中奖", "航班", "火车", "高铁", "路况", "限行",
  "放假", "门票", "影讯", "房价", "疫情", "多少钱", "票价",
  "weather", "news", "stock", "price",
];

// Words that only imply a lookup when paired with a topic — "今天" on its own
// also matches "今天我有点累", which must not cost a search round-trip.
const TIME_HINT_KEYS = ["今天", "今日", "现在", "最新", "实时", "目前", "当前", "刚刚", "最近", "本周", "本月", "今年", "几点", "日期", "today"];

// Personal / conversational turns never auto-search, even phrased as questions.
// "最近怎么样" reads as a time hint plus "怎么样" below, so the small-talk
// phrasings of it have to be listed here explicitly.
const CHITCHAT_RE =
  /(你好|您好|你是谁|你叫什么|讲个|故事|笑话|陪我|聊天|聊聊|闲聊|解闷|谢谢|再见|辛苦|心情|想你|安慰|鼓励|帮我写|帮我改|翻译|总结|解释|代码|提醒|闹钟|我想|我要|怎么办|你觉得|你认为|你能|你会|好不好|行不行|你怎么样|过得怎么样|最近怎么样)/;

function shouldAutoSearch(q) {
  const s = cleanSearchText(q);
  if (s.length < 2) return false;
  const lower = s.toLowerCase();
  if (isExplicitSearchRequest(s)) return true;

  // An unambiguous live-data topic is enough on its own.
  if (REALTIME_KEYS.some((k) => lower.includes(k.toLowerCase()))) return true;

  // Everything below is a weak signal, so conversational turns opt out first.
  if (CHITCHAT_RE.test(s)) return false;

  if (TIME_HINT_KEYS.some((k) => lower.includes(k.toLowerCase())) && /(多少|价格|情况|怎么样|排名|结果|数据|行情|榜)/.test(s)) {
    return true;
  }

  // Third-party facts, whether or not they carry a question particle:
  // "谁得了冠军" yes, "你能帮我吗" no. A bare question particle is not enough
  // on its own — it has to be asking about something outside this conversation.
  const asksThirdPartyFact = /(哪里|哪个|哪家|谁|何时|几号|多少钱|排名|在哪|怎么去)/.test(s);
  if (/[?？]$/.test(s) || /(吗|呢|啥)/.test(s) || asksThirdPartyFact) {
    if (/^(我|我们|咱|咱们|你|你们)/.test(s)) return false;
    if (asksThirdPartyFact) return true;
  }
  return false;
}
function stripSearchCommandWords(text) {
  let q = cleanSearchText(text);
  q = q.replace(/^(请|麻烦|帮我|你帮我|给我|可以帮我)?\s*(联网|上网|网上|百度|谷歌|google)?\s*(搜一下|搜索一下|搜索|查一下|查一查|查询一下|查询|查查|搜搜|看一下|看看)\s*/i, "");
  q = q.replace(/^(请|麻烦|帮我|你帮我|给我|可以帮我)?\s*(搜|查)\s*/i, "");
  q = q.replace(/^(一下|一下一下)\s*/, "");
  return cleanSearchText(q).replace(/^[，,。.!！?？：:\s]+|[，,。.!！?？：:\s]+$/g, "");
}
function isExplicitSearchRequest(q) {
  const s = cleanSearchText(q);
  return [/搜一下/, /搜索/, /帮我搜/, /查一下/, /查一查/, /帮我查/, /联网/, /网上/, /上网/, /百度/, /谷歌/i, /google/i].some((re) => re.test(s));
}
function directSearchReply(search) {
  if (!search?.ok || !search.items?.length) return "";
  if (search.provider === "weather") {
    const first = search.items[0];
    const place = String(search.query || "").trim();
    return `查到了，${place || "天气"}：${first.snippet}`;
  }
  return "";
}
function normalizeSearchQuery(query) {
  let q = stripSearchCommandWords(query).slice(0, 120);
  if (!q) q = cleanSearchText(query).slice(0, 120);
  // 兼容语音识别把“天气”漏成“天”的情况：例如“北京今天的天。”
  q = q.replace(/(今天|今日|明天|后天)的天[。.!！?？]*$/g, "$1的天气");
  q = q.replace(/(今天|今日|明天|后天)天[。.!！?？]*$/g, "$1天气");
  if (/天气|气温|下雨|下雪|降雨|降雪|空气质量|台风|雾霾/.test(q)) return `${q} 实时天气 天气预报 气温 降水`;
  if (/黄金|金价/.test(q)) return `${q} 今日 实时 金价 人民币 国际金价`;
  if (/白银|银价/.test(q)) return `${q} 今日 实时 银价`;
  if (/比特币|btc/i.test(q)) return `${q} 今日 实时 价格`;
  return q;
}
function isWeatherQuery(query) {
  return /天气|气温|下雨|下雪|降雨|降雪|空气质量|台风|雾霾|weather/i.test(String(query || ""));
}
function isRealtimeQuery(userText) {
  const q = cleanSearchText(userText);
  if (!q) return false;
  if (isWeatherQuery(q)) return true;
  return /新闻|头条|热点|热搜|最新|实时|股价|股票行情|行情|价格|汇率|油价|金价|银价|黄金|白银|比特币|btc|eth|比分|赛程|航班|火车|高铁|路况|限行|放假|门票|影讯|开奖|疫情/i.test(q);
}
function normalizeWeatherSpeech(text) {
  return cleanSearchText(text)
    .replace(/(今天|今日|明天|后天)的天[。.!！?？]*$/g, "$1的天气")
    .replace(/(今天|今日|明天|后天)天[。.!！?？]*$/g, "$1天气");
}
function extractWeatherLocation(query) {
  let q = normalizeWeatherSpeech(stripSearchCommandWords(query));
  q = q.replace(/(今天|今日|明天|后天|现在|当前|实时|最近|这会儿|此刻)/g, "");
  q = q.replace(/(的)?(天气预报|天气|气温|温度|下雨吗|会下雨吗|下雨|下雪吗|会下雪吗|下雪|降雨|降雪|空气质量|台风|雾霾|预报)/g, "");
  q = q.replace(/(怎么样|如何|怎样|多少|几度|有雨吗|冷不冷|热不热)/g, "");
  q = q.replace(/[，,。.!！?？：:\s]/g, "").replace(/(?:呢|呀|啊|吧|嘛|吗|么)+$/g, "").trim();
  q = q.replace(/^(嗯|哦|噢|喔|啊|额|呃|那|那么|还有|再查查|再看看|查查|看看|查|搜|搜搜|换成|改成|换|到|去)+/g, "").trim();
  return q.slice(0, 40);
}
function extractWeatherTiming(query) {
  return String(query || "").match(/后天|明天|今天|今日/)?.[0] || "";
}
function isClearlyNotWeatherLocation(rawText, location) {
  const raw = cleanSearchText(rawText);
  const value = String(location || "").trim();
  const text = `${raw} ${value}`;
  if (/^(这里|那里|这边|那边|本地|附近|谢谢|多谢|好的|好啦|知道了|明白了|不用了|不用|算了|可以|行吧|行了|为什么|怎么了|是吗|真的|没事|没问题)$/.test(value)) return true;
  if (/^(我|我们|咱|咱们|你|你们|他|他们|她|她们|它|它们)/.test(value)) return true;
  if (/(聊天|聊聊|闲聊|说话|讲故事|故事|笑话|解闷|陪我|解释|翻译|总结|代码|图片|照片|语音|音乐|播放|打开|关闭|设置|提醒|闹钟|教我|学习|继续|停止|开始)/.test(text)) return true;
  if (/(为什么|怎么|如何|能不能|可不可以|要不要|需要|想要|我要|帮我|麻烦|请你)/.test(text)) return true;
  return false;
}
function isLikelyWeatherFollowupLocation(rawText, location) {
  const raw = cleanSearchText(rawText);
  const value = String(location || "").trim();
  if (!raw || raw.length > 30 || value.length < 2) return false;
  if (isClearlyNotWeatherLocation(rawText, value)) return false;
  if (!/^[\p{Script=Han}A-Za-z·\-\s]+$/u.test(value)) return false;
  return true;
}
function contextualSearchIntent(messages) {
  const userTexts = (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === "user")
    .map((message) => extractTextContent(message.content))
    .filter(Boolean);
  const current = userTexts.at(-1) || "";
  if (!current) return "";
  const previousTexts = userTexts.slice(0, -1);
  let weatherAnchorIndex = -1;
  for (let index = previousTexts.length - 1; index >= 0; index -= 1) {
    if (isWeatherQuery(previousTexts[index])) {
      weatherAnchorIndex = index;
      break;
    }
  }
  if (weatherAnchorIndex < 0) return current;

  const currentLocation = extractWeatherLocation(current);
  const currentTiming = extractWeatherTiming(current);
  const weatherAnchor = previousTexts[weatherAnchorIndex];
  let previousTiming = extractWeatherTiming(weatherAnchor);
  let previousLocation = extractWeatherLocation(weatherAnchor);
  for (const followup of previousTexts.slice(weatherAnchorIndex + 1)) {
    const followupLocation = extractWeatherLocation(followup);
    const followupTiming = extractWeatherTiming(followup);
    if (isLikelyWeatherFollowupLocation(followup, followupLocation)) {
      previousLocation = followupLocation;
      if (followupTiming) previousTiming = followupTiming;
      continue;
    }
    if (followupTiming) {
      previousTiming = followupTiming;
      continue;
    }
    return current;
  }

  if (isWeatherQuery(current)) {
    if (!currentLocation && previousLocation) return `${previousLocation} ${currentTiming || previousTiming} 天气`.replace(/\s+/g, " ").trim();
    return current;
  }
  if (isLikelyWeatherFollowupLocation(current, currentLocation)) {
    return `${currentLocation} ${currentTiming || previousTiming} 天气`.replace(/\s+/g, " ").trim();
  }
  if (currentTiming) {
    return `${previousLocation ? `${previousLocation} ` : ""}${currentTiming} 天气`.replace(/\s+/g, " ").trim();
  }
  return current;
}
function pickWeatherDesc(current) {
  const raw = current?.lang_zh?.[0]?.value || current?.weatherDesc?.[0]?.value || "";
  const key = String(raw).trim().toLowerCase();
  const map = { sunny: "晴", clear: "晴", "partly cloudy": "局部多云", cloudy: "多云", overcast: "阴", mist: "薄雾", fog: "雾", haze: "霾", "smoky haze": "烟霾", "light rain": "小雨", "moderate rain": "中雨", "heavy rain": "大雨" };
  return map[key] || raw;
}
async function searchWeather(query) {
  const location = extractWeatherLocation(query);
  if (!location) return { ok: false, provider: "weather", query, items: [], error: "missing location" };
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1&lang=zh`;
  const res = await fetchJson(url, { method: "GET", headers: { accept: "application/json", "user-agent": "ai-voice-call/0.1" } }, 7000);
  if (!res.ok) return { ok: false, provider: "weather", query: location, items: [], error: `HTTP ${res.status}` };
  const data = res.data || {};
  const current = data.current_condition?.[0] || {};
  const dayIndex = /后天/.test(query) ? 2 : /明天/.test(query) ? 1 : 0;
  const dayLabel = dayIndex === 2 ? "后天" : dayIndex === 1 ? "明天" : "今日";
  const today = data.weather?.[dayIndex] || data.weather?.[0] || {};
  const area = data.nearest_area?.[0]?.areaName?.[0]?.value || location;
  if (!current.temp_C && !today.maxtempC) return { ok: false, provider: "weather", query: location, items: [], error: "empty weather" };
  const desc = pickWeatherDesc(current);
  const rainChances = (today.hourly || []).map((h) => Number(h.chanceofrain || 0)).filter((n) => Number.isFinite(n));
  const maxRain = rainChances.length ? Math.max(...rainChances) : null;
  const parts = [];
  if (dayIndex === 0 && desc) parts.push(`天气 ${desc}`);
  if (dayIndex === 0 && current.temp_C) parts.push(`当前 ${current.temp_C}℃`);
  if (dayIndex === 0 && current.FeelsLikeC) parts.push(`体感 ${current.FeelsLikeC}℃`);
  if (today.mintempC || today.maxtempC) parts.push(`${dayLabel} ${today.mintempC || "?"}-${today.maxtempC || "?"}℃`);
  if (current.humidity) parts.push(`湿度 ${current.humidity}%`);
  if (current.windspeedKmph) parts.push(`风速 ${current.windspeedKmph}km/h`);
  if (maxRain != null) parts.push(`${dayLabel}最高降雨概率约 ${maxRain}%`);
  if (today.uvIndex) parts.push(`UV ${today.uvIndex}`);
  return {
    ok: true,
    provider: "weather",
    query: location,
    items: [{
      title: `${area}天气`,
      snippet: `${parts.join("，")}。数据来自 wttr.in / WorldWeatherOnline，可能与本地官方气象略有差异。`,
      url: `https://wttr.in/${encodeURIComponent(location)}`
    }]
  };
}
function decodeXmlSearch(text) {
  return cleanSearchText(String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'"));
}
async function searchBingRss(query) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&format=rss`;
  const res = await fetchJson(url, { method: "GET", headers: { accept: "application/rss+xml, application/xml, text/xml", "user-agent": "Mozilla/5.0 ai-voice-call/0.1" } }, 7000);
  if (!res.ok) return { ok: false, provider: "bing-rss", query, items: [], error: `HTTP ${res.status}` };
  const xml = String(res.raw || "");
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  const items = [];
  for (const block of blocks.slice(0, 6)) {
    const title = decodeXmlSearch(/<title>([\s\S]*?)<\/title>/i.exec(block)?.[1] || "结果");
    const snippet = decodeXmlSearch(/<description>([\s\S]*?)<\/description>/i.exec(block)?.[1] || "").replace(/<[^>]+>/g, "");
    const link = decodeXmlSearch(/<link>([\s\S]*?)<\/link>/i.exec(block)?.[1] || "");
    if (!title && !snippet) continue;
    items.push({ title: truncateSearchText(title, 80), snippet: truncateSearchText(snippet, 220), url: link });
  }
  return { ok: items.length > 0, provider: "bing-rss", query, items };
}
async function searchDuckDuckGo(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetchJson(url, { method: "GET", headers: { accept: "application/json", "user-agent": "ai-voice-call/0.1" } }, 7000);
  if (!res.ok) return { ok: false, provider: "duckduckgo", query, items: [], error: `HTTP ${res.status}` };
  const items = [];
  const data = res.data || {};
  if (data.AbstractText) items.push({ title: cleanSearchText(data.Heading || "摘要"), snippet: truncateSearchText(data.AbstractText, 240), url: data.AbstractURL || "" });
  for (const t of data.RelatedTopics || []) {
    const list = t.Topics || [t];
    for (const x of list) {
      if (!x?.Text) continue;
      const text = cleanSearchText(x.Text);
      items.push({ title: truncateSearchText(text.split(" - ")[0] || text, 40), snippet: truncateSearchText(text, 180), url: x.FirstURL || "" });
      if (items.length >= 5) break;
    }
    if (items.length >= 5) break;
  }
  return { ok: items.length > 0, provider: "duckduckgo", query, items: items.slice(0, 5) };
}
async function searchSearx(query, baseUrl = "https://searx.be") {
  const root = String(baseUrl || "https://searx.be").replace(/\/+$/, "");
  const url = `${root}/search?q=${encodeURIComponent(query)}&format=json&language=zh-CN`;
  const res = await fetchJson(url, { method: "GET", headers: { accept: "application/json", "user-agent": "ai-voice-call/0.1" } }, 7000);
  if (!res.ok) return { ok: false, provider: "searxng", query, items: [], error: `HTTP ${res.status}` };
  const results = Array.isArray(res.data?.results) ? res.data.results : [];
  const items = results.slice(0, 6).map((r) => ({ title: cleanSearchText(r.title || "结果"), snippet: truncateSearchText(r.content || r.snippet || "", 200), url: r.url || "" })).filter((x) => x.title || x.snippet);
  return { ok: items.length > 0, provider: "searxng", query, items };
}
async function searchSerper(query, apiKey) {
  const res = await fetchJson("https://google.serper.dev/search", { method: "POST", headers: { "content-type": "application/json", "x-api-key": apiKey }, body: JSON.stringify({ q: query, gl: "cn", hl: "zh-cn", num: 5 }) }, 7000);
  if (!res.ok) return { ok: false, provider: "serper", query, items: [], error: String(res.raw || `HTTP ${res.status}`).slice(0, 200) };
  const items = [];
  if (res.data?.answerBox?.answer || res.data?.answerBox?.snippet) items.push({ title: cleanSearchText(res.data.answerBox.title || "直达答案"), snippet: truncateSearchText(res.data.answerBox.answer || res.data.answerBox.snippet || "", 240), url: res.data.answerBox.link || "" });
  for (const r of res.data?.organic || []) items.push({ title: cleanSearchText(r.title || "结果"), snippet: truncateSearchText(r.snippet || "", 200), url: r.link || "" });
  return { ok: items.length > 0, provider: "serper", query, items: items.slice(0, 6) };
}
async function searchTavily(query, apiKey) {
  const res = await fetchJson("https://api.tavily.com/search", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ query, search_depth: "basic", max_results: 5, include_answer: true }) }, 7000);
  if (!res.ok) return { ok: false, provider: "tavily", query, items: [], error: String(res.raw || `HTTP ${res.status}`).slice(0, 200) };
  const items = [];
  if (res.data?.answer) items.push({ title: "综合摘要", snippet: truncateSearchText(res.data.answer, 260), url: "" });
  for (const r of res.data?.results || []) items.push({ title: cleanSearchText(r.title || "结果"), snippet: truncateSearchText(r.content || "", 200), url: r.url || "" });
  return { ok: items.length > 0, provider: "tavily", query, items: items.slice(0, 6) };
}
async function runWebSearch({ query, provider = "auto", apiKey = "", baseUrl = "" } = {}) {
  const rawQuery = String(query || "");
  const q = normalizeSearchQuery(rawQuery);
  const p = String(provider || "auto").toLowerCase();
  const key = String(apiKey || "").trim();
  const candidates = [];
  if ((p === "auto" || p === "weather") && (isWeatherQuery(rawQuery) || isWeatherQuery(q))) candidates.push(() => searchWeather(rawQuery));
  if (p === "tavily" && key) candidates.push(() => searchTavily(q, key));
  if (p === "serper" && key) candidates.push(() => searchSerper(q, key));
  if (p === "searxng") candidates.push(() => searchSearx(q, baseUrl || "https://searx.be"));
  if (p === "bing" || p === "bing-rss") candidates.push(() => searchBingRss(q));
  if (p === "duckduckgo") candidates.push(() => searchDuckDuckGo(q));
  if (p === "auto") {
    if (key) {
      // Key formats are not reliably distinguishable, so try the likely provider
      // first and fall through to the other one instead of failing on a bad guess.
      const ordered = /^tvly-/i.test(key)
        ? [() => searchTavily(q, key), () => searchSerper(q, key)]
        : [() => searchSerper(q, key), () => searchTavily(q, key)];
      candidates.push(...ordered);
    }
    candidates.push(() => searchBingRss(q));
    candidates.push(() => searchSearx(q, baseUrl || "https://searx.be"));
    candidates.push(() => searchDuckDuckGo(q));
  }
  // A configured provider that is missing its key still falls back to the free
  // ones rather than returning "no provider configured".
  if (!candidates.length) {
    candidates.push(() => searchBingRss(q));
    candidates.push(() => searchSearx(q, baseUrl || "https://searx.be"));
    candidates.push(() => searchDuckDuckGo(q));
  }
  let last = { ok: false, provider: p, query: q, items: [], error: "no provider responded" };
  for (const fn of candidates) {
    try {
      const result = await fn();
      last = result;
      if (result.ok && result.items?.length) return result;
    } catch (err) {
      last = { ok: false, provider: "error", query: q, items: [], error: String(err.message || err) };
    }
  }
  return last;
}
function formatSearchContext(result) {
  if (!result?.items?.length) return `【联网搜索】已尝试查询“${result?.query || ""}”，但没有拿到可用结果（来源: ${result?.provider || "none"}${result?.error ? "，错误: " + result.error : ""}）。如果用户问题依赖最新信息，请直接说明暂时查不到，不要编造实时数据，也不要说“联网搜索功能没开放”。`;
  const lines = result.items.map((it, i) => `${i + 1}. ${it.title}\n   ${it.snippet}${it.url ? " 链接:" + it.url : ""}`);
  return [`【联网搜索结果】查询: ${result.query}（来源: ${result.provider}）`, ...lines, "请先判断搜索结果是否真的相关；相关才引用，不相关就说明暂时查不到。用简体中文、短句回答。不要编造具体数字或实时结论。"].join("\n");
}
function sanitizeMessages(messages, systemPrompt, maxTurns) {
  const rest = (messages || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ role: m.role, content: sanitizeMessageContent(m.content) }))
    .filter((m) => typeof m.content === "string" ? Boolean(m.content.trim()) : m.content.length > 0);
  const keep = Math.max(2, (maxTurns || 12) * 2);
  return [{ role: "system", content: withReplyOnlyInstruction(systemPrompt) }, ...rest.slice(-keep)];
}
function looksLikeNoWebReply(text) {
  const s = cleanSearchText(text);
  if (!s) return false;
  return /(不能|无法|没有|未能).{0,10}(联网|上网|搜索|实时|查询|访问互联网)|没有.{0,10}(实时|联网|最新).{0,10}(数据|信息|能力)|不确定.{0,16}(天气|价格|新闻|当前|现在|实时|最新)|无法.{0,16}(获取|查询|访问).{0,16}(天气|实时|最新|网络|互联网)|作为(一个)?(AI|人工智能).{0,20}(不能|无法).{0,10}(联网|访问互联网|获取实时)/i.test(s);
}
async function fallbackServerSearchAnswer(cfg, messages, userText, explicitSearch) {
  const search = await runWebSearch({ query: userText, provider: cfg.searchProvider, apiKey: cfg.searchApiKey, baseUrl: cfg.searchBaseUrl });
  console.log("[search:fallback]", search.provider, "ok=", search.ok, "count=", search.items?.length || 0, search.error || "");
  const webSearch = { used: true, explicit: explicitSearch, provider: `fallback-${search.provider}`, ok: search.ok, count: search.items.length, error: search.error || "", titles: search.items.slice(0, 3).map((x) => x.title) };
  const directReply = directSearchReply(search);
  if (directReply) return { reply: directReply, webSearch };
  const systemPrompt = `${cfg.systemPrompt}

${formatSearchContext(search)}

重要：上面就是服务端已经获取到的联网结果。请直接基于这些结果回答。不能再说“我不能联网”“没有实时联网”“无法获取实时数据”。`;
  const finalMessages = sanitizeMessages(messages, systemPrompt, cfg.maxHistoryTurns);
  const reply = await chatCompletions(cfg, finalMessages);
  return { reply, webSearch };
}
async function prepareChat(body) {
  const cfg = resolveConfig(body.config || {});
  if (!cfg.llm.apiKey) { const e = new Error("缺少 API Key：请在本地配置填写"); e.status = 401; throw e; }
  let messages = Array.isArray(body.messages) ? body.messages : [];
  if (body.message) messages = [...messages, { role: "user", content: String(body.message) }];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const userText = extractTextContent(lastUser?.content);
  if (!userText) { const e = new Error("请输入消息"); e.status = 400; throw e; }
  const intentText = contextualSearchIntent(messages);
  let systemPrompt = cfg.systemPrompt;
  let directReply = "";
  const explicitSearch = isExplicitSearchRequest(intentText) || isExplicitSearchRequest(userText);
  const weatherIntent = isWeatherQuery(intentText);
  const realtimeIntent = isRealtimeQuery(intentText);
  const autoSearchIntent = shouldAutoSearch(intentText);
  const serverSearchIntent = realtimeIntent || explicitSearch || (cfg.webSearchEnabled && autoSearchIntent);
  const hasVision = messagesHaveVision(messages);
  const useResponsesTools = !hasVision && !serverSearchIntent && preferredLlmKind(cfg) === "responses";
  const useFunctionTools = !serverSearchIntent && cfg.toolCallingEnabled && preferredLlmKind(cfg) === "chat" && shouldUseFunctionTools(intentText);
  if (useFunctionTools) {
    const now = currentTimeResult(cfg.timeZone);
    systemPrompt = `${systemPrompt}\n\n当前用户时区：${now.timeZone}。当前日期时间：${now.local}（${now.iso}）。需要计算、时间或提醒时，请优先调用提供的函数工具，不要假装已经执行工具。`;
  }
  let webSearch = useResponsesTools ? { used: true, explicit: explicitSearch, provider: "responses-tools", ok: true, count: 0, error: "", titles: [] } : null;
  const weatherLocation = weatherIntent ? extractWeatherLocation(intentText) : "";
  if (weatherIntent && !weatherLocation) {
    directReply = cfg.webSearchEnabled
      ? "你想查哪个城市的天气？请告诉我城市，例如“杭州天气”。"
      : "你想查哪个城市的天气？另外，“启用联网搜索”当前已关闭；打开后我才能查询实时天气，我不会猜温度或降雨概率。";
    webSearch = { used: false, explicit: explicitSearch, provider: "weather", ok: false, count: 0, error: "missing location", titles: [] };
  } else if ((realtimeIntent || explicitSearch) && !cfg.webSearchEnabled) {
    directReply = weatherIntent
      ? "联网搜索当前已关闭，我不能可靠查询实时天气，也不会猜温度或降雨概率。请先打开“启用联网搜索”。"
      : "联网搜索当前已关闭，我不能可靠查询实时数据，也不会凭空编造。请先打开“启用联网搜索”。";
    webSearch = { used: false, explicit: explicitSearch, provider: "disabled", ok: false, count: 0, error: "web search disabled", titles: [] };
  }
  const wantSearch = !directReply && !useResponsesTools && !useFunctionTools && cfg.webSearchEnabled && (realtimeIntent || explicitSearch || autoSearchIntent);
  if (wantSearch) {
    try {
      const search = await runWebSearch({ query: intentText, provider: weatherIntent ? "weather" : cfg.searchProvider, apiKey: cfg.searchApiKey, baseUrl: cfg.searchBaseUrl });
      console.log("[search]", search.provider, "ok=", search.ok, "count=", search.items?.length || 0, search.error || "");
      webSearch = { used: true, explicit: explicitSearch, provider: search.provider, ok: search.ok, count: search.items.length, error: search.error || "", titles: search.items.slice(0, 3).map((x) => x.title) };
      directReply = directSearchReply(search);
      if (!directReply && !search.ok && (realtimeIntent || explicitSearch)) {
        directReply = weatherIntent
          ? `我暂时没查到${weatherLocation || "该城市"}的可靠实时天气，不能给你编温度或降雨概率。请稍后重试。`
          : "我暂时没查到可靠的实时信息，不会凭空编造数据。请稍后重试。";
      } else if (!directReply) {
        systemPrompt = `${cfg.systemPrompt}\n\n${formatSearchContext(search)}\n\n重要：上面就是服务端已经获取到的联网结果。不能再说“我不能联网”“无法直接联网”“联网搜索没开放”，也不能补充搜索结果里没有的实时数字。`;
      }
    } catch (err) {
      webSearch = { used: true, explicit: explicitSearch, provider: "timeout", ok: false, count: 0, error: String(err.message || err), titles: [] };
      if (realtimeIntent || explicitSearch) {
        directReply = weatherIntent
          ? `我暂时没查到${weatherLocation || "该城市"}的可靠实时天气，不能给你编温度或降雨概率。请稍后重试。`
          : "我暂时没查到可靠的实时信息，不会凭空编造数据。请稍后重试。";
      } else {
        systemPrompt = `${cfg.systemPrompt}\n\n【联网搜索】暂时不可用。请简要回答并明确说明无法核实；不要编造实时数据。`;
      }
    }
  }
  const finalMessages = sanitizeMessages(messages, systemPrompt, cfg.maxHistoryTurns);
  return { cfg, messages, userText, intentText, explicitSearch, useResponsesTools, useFunctionTools, finalMessages, webSearch, directReply };
}
async function handleChat(body) {
  const prepared = await prepareChat(body);
  if (prepared.directReply) return { ok: true, reply: prepared.directReply, model: prepared.cfg.llm.model, ttsEnabled: prepared.cfg.ttsEnabled, webSearch: prepared.webSearch };
  if (prepared.useFunctionTools) {
    const result = await chatCompletionsWithTools(prepared.cfg, prepared.finalMessages);
    return { ok: true, reply: result.reply, model: prepared.cfg.llm.model, ttsEnabled: prepared.cfg.ttsEnabled, webSearch: result.webSearch, toolActions: result.toolActions, toolUsage: result.toolUsage };
  }
  const reply = await chatCompletions(prepared.cfg, prepared.finalMessages);
  if (prepared.useResponsesTools && shouldAutoSearch(prepared.intentText) && looksLikeNoWebReply(reply)) {
    const fallback = await fallbackServerSearchAnswer(prepared.cfg, prepared.messages, prepared.intentText, prepared.explicitSearch);
    return { ok: true, reply: fallback.reply, model: prepared.cfg.llm.model, ttsEnabled: prepared.cfg.ttsEnabled, webSearch: fallback.webSearch };
  }
  return { ok: true, reply, model: prepared.cfg.llm.model, ttsEnabled: prepared.cfg.ttsEnabled, webSearch: prepared.webSearch };
}
function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
async function handleChatStream(body, res) {
  const prepared = await prepareChat(body);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
  });
  let reply = "";
  writeSse(res, "ready", { ok: true });
  try {
    let doneWebSearch = prepared.webSearch;
    let doneToolActions = [];
    let doneToolUsage = [];
    if (prepared.directReply) {
      reply = prepared.directReply;
      writeSse(res, "delta", { text: reply });
    } else if (prepared.useFunctionTools) {
      const result = await chatCompletionsWithTools(prepared.cfg, prepared.finalMessages);
      reply = result.reply;
      doneWebSearch = result.webSearch;
      doneToolActions = result.toolActions;
      doneToolUsage = result.toolUsage;
      writeSse(res, "delta", { text: reply });
    } else if (prepared.useResponsesTools && shouldAutoSearch(prepared.intentText)) {
      reply = await chatCompletions(prepared.cfg, prepared.finalMessages);
      if (looksLikeNoWebReply(reply)) {
        const fallback = await fallbackServerSearchAnswer(prepared.cfg, prepared.messages, prepared.intentText, prepared.explicitSearch);
        reply = fallback.reply;
        doneWebSearch = fallback.webSearch;
      }
      writeSse(res, "delta", { text: reply });
    } else if (messagesHaveVision(prepared.finalMessages)) {
      reply = await chatCompletions(prepared.cfg, prepared.finalMessages);
      writeSse(res, "delta", { text: reply });
    } else {
      reply = await streamChatCompletions(prepared.cfg, prepared.finalMessages, (text) => writeSse(res, "delta", { text }));
    }
    writeSse(res, "done", { ok: true, reply, model: prepared.cfg.llm.model, ttsEnabled: prepared.cfg.ttsEnabled, webSearch: doneWebSearch, toolActions: doneToolActions, toolUsage: doneToolUsage });
  } catch (err) {
    writeSse(res, "error", { error: String(err.message || err), partial: err.partial || reply || "" });
  } finally {
    res.end();
  }
}
function pickTranscript(data) {
  for (const c of [data?.text, data?.result, data?.transcript, data?.data?.text]) if (typeof c === "string" && c.trim()) return c.trim();
  return "";
}
async function transcribe(cfg, file) {
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
        const res = await fetchJson(endpoint, { method: "POST", headers: { authorization: `Bearer ${cfg.stt.apiKey}`, "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) }, body }, 60000);
        if (!res.ok) { lastErr = pickUpstreamErrorMessage(res); continue; }
        const textOut = pickTranscript(res.data);
        if (textOut) return { text: textOut, model };
        lastErr = "语音识别没有返回文字";
      } catch (err) { lastErr = String(err.message || err); }
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
async function synthesizeMimo(cfg, inputText) {
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
  }, 60000);
  if (!res.ok) throw new Error(`小米 MiMo TTS: ${pickUpstreamErrorMessage(res)}`);
  const audioData = res.data?.choices?.[0]?.message?.audio?.data || res.data?.audio?.data || res.data?.data;
  const buffer = base64ToBuffer(audioData);
  if (!buffer?.length) throw new Error("小米 MiMo TTS 没有返回音频数据");
  return { buffer, contentType: "audio/wav" };
}
async function synthesizeOpenAiSpeech(cfg, inputText) {
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
  }, 60000);
  if (!res.ok) throw new Error(pickUpstreamErrorMessage(res));
  return { buffer: res.buffer, contentType: res.headers?.["content-type"] || "audio/mpeg" };
}
async function synthesize(cfg, inputText) {
  if (isMimoTts(cfg)) return synthesizeMimo(cfg, inputText);
  return synthesizeOpenAiSpeech(cfg, inputText);
}
function publicTtsConfig(cfg) {
  return { baseUrl: cfg.tts.baseUrl, model: cfg.tts.model, voice: cfg.tts.voice, apiType: cfg.tts.apiType, endpoint: cfg.tts.endpoint, hasKey: Boolean(cfg.tts.apiKey) };
}
function formatTtsError(err) {
  const msg = String(err?.message || err || "").trim();
  return msg ? `TTS 请求失败：${msg}` : "TTS 请求失败";
}
function printLan() {
  const nets = networkInterfaces();
  console.log("Open on phone (same WiFi):");
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      const family = String(net.family);
      if ((family === "IPv4" || family === "4") && !net.internal) console.log(`- ${name}: http://${net.address}:${PORT}`);
    }
  }
  console.log(`PC local: http://127.0.0.1:${PORT}`);
}

function printLanHttps(port) {
  const nets = networkInterfaces();
  const ips = [];
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n && (n.family === "IPv4" || n.family === 4) && !n.internal) ips.push(n.address);
    }
  }
  if (!ips.length) {
    console.log("  https://127.0.0.1:" + port);
    return;
  }
  for (const ip of ips) console.log("  https://" + ip + ":" + port);
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
    if (pathname === "/api/defaults" && req.method === "GET") return json(res, 200, { ok: true, defaults: { llm: { baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen3.5-4B", apiType: "auto", endpoint: "" }, stt: { baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/SenseVoiceSmall", apiType: "auto", endpoint: "" }, tts: { baseUrl: "https://api.siliconflow.cn/v1", model: "FnLP/MOSS-TTSD-v0.5", voice: "alloy", apiType: "auto", endpoint: "" }, systemPromptPreset: "general", systemPrompt: DEFAULT_SYSTEM_PROMPT, maxHistoryTurns: 12, maxTokens: 512, temperature: 0.7, ttsEnabled: true, browserTtsFallback: true, autoSpeak: true, toolCallingEnabled: true, webSearchEnabled: true, searchProvider: "auto" } });
    if (pathname === "/api/chat/stream" && req.method === "POST") {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString("utf8") || "{}");
      const started = Date.now();
      console.log("[chat:stream] in", (body.messages || []).length, "msgs, search=", body.config?.webSearchEnabled);
      try {
        await handleChatStream(body, res);
        console.log("[chat:stream] out in", Date.now() - started, "ms");
        return;
      } catch (err) {
        console.log("[chat:stream] fail in", Date.now() - started, "ms:", err.message || err);
        if (!res.headersSent) return json(res, err.status || 500, { ok: false, error: String(err.message || err) });
        try { writeSse(res, "error", { error: String(err.message || err) }); res.end(); } catch {}
        return;
      }
    }
    if (pathname === "/api/chat" && req.method === "POST") {
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString("utf8") || "{}");
      const started = Date.now();
      console.log("[chat] in", (body.messages || []).length, "msgs, search=", body.config?.webSearchEnabled);
      try {
        const out = await handleChat(body);
        console.log("[chat] out ok in", Date.now() - started, "ms");
        return json(res, 200, out);
      } catch (err) {
        console.log("[chat] out fail in", Date.now() - started, "ms:", err.message || err);
        throw err;
      }
    }
    if (pathname === "/api/test" && req.method === "POST") {
      const raw = await readBody(req); const body = JSON.parse(raw.toString("utf8") || "{}"); const cfg = resolveConfig(body.config || {});
      if (!cfg.llm.apiKey) return json(res, 401, { ok: false, error: "未配置 API Key" });
      const reply = await chatCompletions(cfg, [{ role: "system", content: "你是测试助手，只回复：连接成功。" }, { role: "user", content: "ping" }]);
      return json(res, 200, { ok: true, llmTest: { ok: true, reply }, llm: { model: cfg.llm.model, baseUrl: cfg.llm.baseUrl, apiType: cfg.llm.apiType, endpoint: cfg.llm.endpoint, hasKey: true } });
    }
    if (pathname === "/api/search" && req.method === "POST") {
      const raw = await readBody(req); const body = JSON.parse(raw.toString("utf8") || "{}"); const q = String(body.query || body.q || "").trim();
      if (!q) return json(res, 400, { ok: false, error: "missing query" });
      return json(res, 200, await runWebSearch({ query: q, provider: body.provider || body.searchProvider || "auto", apiKey: body.apiKey || "", baseUrl: body.baseUrl || "" }));
    }
    if (pathname === "/api/asr" && req.method === "POST") {
      const raw = await readBody(req); const parsed = parseMultipart(raw, req.headers["content-type"]);
      if (!parsed.file) return json(res, 400, { ok: false, error: "missing audio file" });
      let clientConfig = {};
      const headerCfg = req.headers["x-client-config"];
      if (headerCfg) { try { const s = String(headerCfg); clientConfig = s.trim().startsWith("{") ? JSON.parse(s) : JSON.parse(Buffer.from(s, "base64").toString("utf8")); } catch {} }
      else if (parsed.fields.config) { try { clientConfig = JSON.parse(parsed.fields.config); } catch {} }
      const cfg = resolveConfig(clientConfig);
      if (!cfg.stt.apiKey) return json(res, 401, { ok: false, error: "缺少语音识别 API Key" });
      const result = await transcribe(cfg, parsed.file);
      return json(res, 200, { ok: true, text: result.text, model: result.model, bytes: parsed.file.buffer.length });
    }
    if (pathname === "/api/tts" && req.method === "POST") {
      const raw = await readBody(req); const body = JSON.parse(raw.toString("utf8") || "{}"); const cfg = resolveConfig(body.config || {});
      const textInput = String(body.text || "").trim();
      if (!textInput) return json(res, 400, { ok: false, error: "缺少要合成的文字" });
      if (cfg.ttsEnabled === false) return json(res, 400, { ok: false, error: "在线 TTS 已关闭" });
      if (!cfg.tts.baseUrl) return json(res, 400, { ok: false, error: "缺少 TTS Base URL", tts: publicTtsConfig(cfg) });
      if (!cfg.tts.model) return json(res, 400, { ok: false, error: "缺少 TTS Model", tts: publicTtsConfig(cfg) });
      if (!cfg.tts.apiKey) return json(res, 401, { ok: false, error: "缺少 TTS API Key", tts: publicTtsConfig(cfg) });
      try {
        const audio = await synthesize(cfg, textInput);
        res.writeHead(200, { "content-type": audio.contentType || "audio/mpeg", "cache-control": "no-store" });
        return res.end(audio.buffer);
      } catch (err) {
        const error = formatTtsError(err);
        console.log("[tts] fail", publicTtsConfig(cfg), err?.message || err);
        return json(res, 502, { ok: false, error, tts: publicTtsConfig(cfg) });
      }
    }
    let reqPath = decodeURIComponent(pathname); if (reqPath === "/") reqPath = "/index.html";
    const safe = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(PUBLIC_DIR, safe);
    if (!filePath.startsWith(PUBLIC_DIR)) return text(res, 403, "forbidden");
    return sendFile(res, filePath);
  } catch (err) {
    return json(res, err.status || 500, { ok: false, error: String(err.message || err) });
  }
}

function loadLocalCerts() {
  const keyPath = path.join(__dirname, ".certs", "key.pem");
  const certPath = path.join(__dirname, ".certs", "cert.pem");
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) return null;
  try {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  } catch {
    return null;
  }
}

const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8788);
const httpServer = http.createServer(requestHandler);
const certs = loadLocalCerts();
let httpsServer = null;
if (certs) httpsServer = https.createServer(certs, requestHandler);

httpServer.listen(PORT, HOST, () => {
  console.log("========================================");
  console.log(" AI语音通话 LOCAL server is running");
  console.log("========================================");
  printLan();
  console.log("");
  console.log("PC (可录音):     http://127.0.0.1:" + PORT);
  if (httpsServer) {
    console.log("手机请优先用 HTTPS（麦克风需要安全环境）:");
    printLanHttps(HTTPS_PORT);
    console.log("首次打开若提示不安全，点“继续访问/高级”。");
    console.log("微信里请点右上角 ... -> 在浏览器打开");
  } else {
    console.log("未找到 .certs 证书，手机端 HTTP 通常无法录音。");
  }
  console.log("");
  console.log("Keep this window open. Press Ctrl+C to stop.");
});

if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, HOST, () => {
    console.log("HTTPS listening on " + HTTPS_PORT);
  });
  httpsServer.on("error", (err) => {
    console.error("HTTPS failed:", err.message);
    if (err.code === "EADDRINUSE") console.error("HTTPS port " + HTTPS_PORT + " in use");
  });
}

httpServer.on("error", (err) => {
  console.error("Server failed:", err.message);
  if (err.code === "EADDRINUSE") console.error("Port " + PORT + " in use. Close old window / rerun starter.");
  process.exit(1);
});

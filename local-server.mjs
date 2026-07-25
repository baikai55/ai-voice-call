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
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(data));
}
function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(body);
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
    ...keyDiagnostic(cfg.llm.apiKey),
  };
}
function normalizeApiType(value, fallback = "auto") {
  const allowed = new Set(["auto", "openai-chat", "openai-responses", "openai-transcriptions", "openai-speech", "xiaomi-mimo"]);
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
    llm: { baseUrl: llmBase, apiKey: pick(client.llm?.apiKey), model: pick(client.llm?.model, env("LLM_MODEL"), "Qwen/Qwen3.5-4B"), apiType: normalizeApiType(client.llm?.apiType, "auto") },
    stt: { baseUrl: sttBase, apiKey: pick(client.stt?.apiKey, client.llm?.apiKey), model: pick(client.stt?.model, env("STT_MODEL"), "FunAudioLLM/SenseVoiceSmall"), apiType: normalizeApiType(client.stt?.apiType, "auto") },
    tts: { baseUrl: ttsBase, apiKey: pick(client.tts?.apiKey, client.llm?.apiKey), model: pick(client.tts?.model, env("TTS_MODEL"), "FnLP/MOSS-TTSD-v0.5"), voice: pick(client.tts?.voice, env("TTS_VOICE"), "alloy"), apiType: normalizeApiType(client.tts?.apiType, "auto") },
    systemPrompt: pick(client.systemPrompt, env("SYSTEM_PROMPT"), DEFAULT_SYSTEM_PROMPT),
    maxHistoryTurns: Number(client.maxHistoryTurns || env("MAX_HISTORY_TURNS") || 12),
    maxTokens: Math.max(Number(client.maxTokens || env("LLM_MAX_TOKENS") || 512), 256),
    temperature: Number((client.temperature ?? env("LLM_TEMPERATURE", "0.7")) || 0.7),
    ttsEnabled: client.ttsEnabled !== false,
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
function pickLlmErrorMessage(res) {
  return String(res?.data?.error?.message || res?.data?.message || res?.raw?.slice?.(0, 300) || `HTTP ${res?.status || ""}`).trim();
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
  const msg = pickLlmErrorMessage(res);
  if (!res.ok && isTransientAuthError(res.status, msg)) {
    console.log("[llm] transient auth error, retry once", { status: res.status, ...publicLlmConfig(cfg) });
    await sleep(800);
    res = await fetchJson(endpoint, options, timeoutMs);
  }
  return res;
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
function llmKinds(cfg) {
  return [preferredLlmKind(cfg)];
}
function chatPayloadVariants(cfg, messages, stream = false) {
  const first = buildChatPayload(cfg, messages, stream, {
    enable_thinking: false,
    thinking_budget: 0,
    chat_template_kwargs: { enable_thinking: false },
  });
  const minimal = buildChatPayload(cfg, messages, stream);
  return [first, minimal];
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
  for (const kind of llmKinds(cfg)) {
    let fallbackToNextKind = false;
    const endpoint = llmEndpoint(cfg, kind);
    const variants = payloadVariants(cfg, messages, kind, false);
    for (let i = 0; i < variants.length; i++) {
      const payload = variants[i];
      try {
        console.log("[llm] request", kind, cfg.llm.model, "tokens=", cfg.maxTokens, kind === "responses" ? `tool=${payload.tools?.[0]?.type}` : "");
        const res = await fetchLlmWithTransientRetry(endpoint, { method: "POST", headers, body: JSON.stringify(payload) }, 35000, cfg);
        if (!res.ok) {
          lastErr = formatLlmFailure(res.status, pickLlmErrorMessage(res));
          console.log("[llm] fail", kind, res.status, lastErr);
          if (kind === "chat" && shouldFallbackToResponses(cfg, res.status)) { fallbackToNextKind = true; break; }
          if (res.status === 400 && i < variants.length - 1) continue;
          throw new Error(lastErr);
        }
        const textOut = extractLlmText(res.data, kind);
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
    if (fallbackToNextKind) continue;
    break;
  }
  throw new Error(lastErr);
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
  return `${cfg.llm.baseUrl}/${kind === "responses" ? "responses" : "chat/completions"}`;
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
function shouldFallbackToResponses(cfg, status) {
  return false;
}
async function readFetchError(res) {
  const textBody = await res.text().catch(() => "");
  if (!textBody) return `${res.status} ${res.statusText || ""}`.trim();
  try {
    const data = JSON.parse(textBody);
    return String(data?.error?.message || data?.message || textBody.slice(0, 500)).trim();
  } catch {
    return textBody.slice(0, 500).trim();
  }
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
  const applyDelta = (delta) => {
    if (!delta) return;
    const cleaned = String(delta).replace(/\<think>[\s\S]*?\<\/think>/gi, "");
    if (!cleaned) return;
    reply += cleaned;
    onDelta(cleaned, reply);
  };
  const handleBlock = (block) => {
    const { eventName, dataText } = parseSseBlock(block);
    if (!dataText || dataText === "[DONE]") return;
    try {
      const data = JSON.parse(dataText);
      applyDelta(extractStreamDelta(data, kind, eventName));
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
      const { done, value } = await reader.read();
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
  for (const kind of llmKinds(cfg)) {
    let fallbackToNextKind = false;
    const endpoint = llmEndpoint(cfg, kind);
    const variants = payloadVariants(cfg, messages, kind, true);
    for (let i = 0; i < variants.length; i++) {
      const payload = variants[i];
      try {
        console.log("[llm] stream", kind, cfg.llm.model, "tokens=", cfg.maxTokens);
        let res = await fetchLlmStreamOnce(endpoint, { method: "POST", headers, body: JSON.stringify(payload) }, 90000);
        if (!res.ok) {
          let errText = await readFetchError(res);
          if (isTransientAuthError(res.status, errText)) {
            console.log("[llm] transient stream auth error, retry once", { status: res.status, ...publicLlmConfig(cfg) });
            await sleep(800);
            res = await fetchLlmStreamOnce(endpoint, { method: "POST", headers, body: JSON.stringify(payload) }, 90000);
            if (!res.ok) errText = await readFetchError(res);
          }
          if (!res.ok) {
            lastErr = formatLlmFailure(res.status, errText);
            console.log("[llm] stream fail", kind, res.status, lastErr);
            if (kind === "chat" && shouldFallbackToResponses(cfg, res.status)) { fallbackToNextKind = true; break; }
            if (res.status === 400 && i < variants.length - 1) continue;
            throw new Error(lastErr);
          }
        }
        const reply = await readLlmStreamResponse(res, kind, onDelta);
        if (reply) {
          console.log("[llm] stream ok", kind, "chars=", reply.length);
          return reply;
        }
        lastErr = `LLM stream returned empty content (${kind})`;
      } catch (err) {
        lastErr = String(err.message || err);
        console.log("[llm] stream error", lastErr);
        throw err;
      }
    }
    if (fallbackToNextKind) continue;
    break;
  }
  throw new Error(lastErr);
}
function cleanSearchText(text) { return String(text || "").replace(/\s+/g, " ").trim(); }
function truncateSearchText(text, max = 180) {
  const t = cleanSearchText(text);
  return t.length > max ? t.slice(0, max) + "…" : t;
}
function shouldAutoSearch(q) {
  const s = cleanSearchText(q);
  if (s.length < 2) return false;
  const casualOrCreative = ["你好", "你是谁", "讲个", "故事", "笑话", "陪我", "聊天", "解闷", "今天过得怎么样", "最近怎么样", "心情", "想你", "安慰", "鼓励"];
  if (casualOrCreative.some((k) => s.includes(k))) return false;
  const explicit = [/搜一下/, /搜索/, /帮我搜/, /查一下/, /查一查/, /帮我查/, /联网/, /网上/, /上网/, /百度/, /谷歌/i, /google/i];
  if (explicit.some((re) => re.test(s))) return true;
  const keys = ["天气", "气温", "下雨", "下雪", "台风", "空气质量", "新闻", "头条", "热点", "热搜", "最新", "最近", "刚刚", "目前", "现在", "当前", "今天", "今日", "本周", "本月", "今年", "股价", "股票", "行情", "价格", "多少钱", "汇率", "油价", "金价", "黄金", "白银", "比特币", "btc", "eth", "美元", "港币", "人民币", "比分", "赛程", "谁赢了", "开奖", "中奖", "航班", "火车", "高铁", "路况", "限行", "放假", "门票", "影讯"];
  const lower = s.toLowerCase();
  return keys.some((k) => lower.includes(k.toLowerCase()));
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
  q = q.replace(/[，,。.!！?？：:\s]/g, "").trim();
  return q.slice(0, 40);
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
    if (key) candidates.push(() => key.startsWith("tvly-") ? searchTavily(q, key) : searchSerper(q, key));
    candidates.push(() => searchBingRss(q));
    candidates.push(() => searchSearx(q, baseUrl || "https://searx.be"));
    candidates.push(() => searchDuckDuckGo(q));
  }
  if (!candidates.length) return { ok: false, provider: p, query: q, items: [], error: "no provider configured" };
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
  const rest = (messages || []).filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
  const keep = Math.max(2, (maxTurns || 12) * 2);
  return [{ role: "system", content: systemPrompt }, ...rest.slice(-keep)];
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
  const userText = String(lastUser?.content || "").trim();
  if (!userText) { const e = new Error("请输入消息"); e.status = 400; throw e; }
  let systemPrompt = cfg.systemPrompt;
  let directReply = "";
  const explicitSearch = isExplicitSearchRequest(userText);
  const useResponsesTools = preferredLlmKind(cfg) === "responses";
  let webSearch = useResponsesTools ? { used: true, explicit: explicitSearch, provider: "responses-tools", ok: true, count: 0, error: "", titles: [] } : null;
  const wantSearch = !useResponsesTools && shouldAutoSearch(userText) && (cfg.webSearchEnabled || explicitSearch);
  if (wantSearch) {
    try {
      const search = await runWebSearch({ query: userText, provider: cfg.searchProvider, apiKey: cfg.searchApiKey, baseUrl: cfg.searchBaseUrl });
      console.log("[search]", search.provider, "ok=", search.ok, "count=", search.items?.length || 0, search.error || "");
      webSearch = { used: true, explicit: explicitSearch, provider: search.provider, ok: search.ok, count: search.items.length, error: search.error || "", titles: search.items.slice(0, 3).map((x) => x.title) };
      directReply = directSearchReply(search);
      if (!directReply) systemPrompt = `${cfg.systemPrompt}\n\n${formatSearchContext(search)}\n\n重要：上面就是服务端已经获取到的联网结果。不能再说“我不能联网”“无法直接联网”“联网搜索没开放”。`;
    } catch (err) {
      webSearch = { used: true, explicit: explicitSearch, provider: "timeout", ok: false, count: 0, error: String(err.message || err), titles: [] };
      systemPrompt = `${cfg.systemPrompt}\n\n【联网搜索】暂时不可用。请简要回答并说明实时信息可能不准。不要说“联网搜索功能没开放”。`;
    }
  }
  const finalMessages = sanitizeMessages(messages, systemPrompt, cfg.maxHistoryTurns);
  return { cfg, messages, userText, explicitSearch, useResponsesTools, finalMessages, webSearch, directReply };
}
async function handleChat(body) {
  const prepared = await prepareChat(body);
  if (prepared.directReply) return { ok: true, reply: prepared.directReply, model: prepared.cfg.llm.model, ttsEnabled: prepared.cfg.ttsEnabled, webSearch: prepared.webSearch };
  const reply = await chatCompletions(prepared.cfg, prepared.finalMessages);
  if (prepared.useResponsesTools && shouldAutoSearch(prepared.userText) && looksLikeNoWebReply(reply)) {
    const fallback = await fallbackServerSearchAnswer(prepared.cfg, prepared.messages, prepared.userText, prepared.explicitSearch);
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
    "access-control-allow-origin": "*",
    "x-accel-buffering": "no",
  });
  let reply = "";
  try {
    let doneWebSearch = prepared.webSearch;
    if (prepared.directReply) {
      reply = prepared.directReply;
      writeSse(res, "delta", { text: reply });
    } else if (prepared.useResponsesTools && shouldAutoSearch(prepared.userText)) {
      reply = await chatCompletions(prepared.cfg, prepared.finalMessages);
      if (looksLikeNoWebReply(reply)) {
        const fallback = await fallbackServerSearchAnswer(prepared.cfg, prepared.messages, prepared.userText, prepared.explicitSearch);
        reply = fallback.reply;
        doneWebSearch = fallback.webSearch;
      }
      writeSse(res, "delta", { text: reply });
    } else {
      reply = await streamChatCompletions(prepared.cfg, prepared.finalMessages, (text) => writeSse(res, "delta", { text }));
    }
    writeSse(res, "done", { ok: true, reply, model: prepared.cfg.llm.model, ttsEnabled: prepared.cfg.ttsEnabled, webSearch: doneWebSearch });
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
  const models = Array.from(new Set([cfg.stt.model, "FunAudioLLM/SenseVoiceSmall", "TeleAI/TeleSpeechASR"].filter(Boolean)));
  let lastErr = "语音识别没有返回文字";
  for (const model of models) {
    for (const withLang of [true, false]) {
      const boundary = "----parentchat" + Date.now();
      const pre = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`, "utf8");
      const mid = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n` + (withLang ? `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nzh\r\n` : "") + `--${boundary}--\r\n`, "utf8");
      const body = Buffer.concat([pre, file.buffer, mid]);
      try {
        const res = await fetchJson(cfg.stt.baseUrl + "/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${cfg.stt.apiKey}`, "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) }, body }, 60000);
        if (!res.ok) { lastErr = res.data?.error?.message || res.raw?.slice?.(0, 200) || `HTTP ${res.status}`; continue; }
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
  if (apiType === "openai-speech") return false;
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
  if (!res.ok) throw new Error(res.data?.error?.message || res.raw?.slice?.(0, 200) || `MiMo TTS HTTP ${res.status}`);
  const audioData = res.data?.choices?.[0]?.message?.audio?.data || res.data?.audio?.data || res.data?.data;
  const buffer = base64ToBuffer(audioData);
  if (!buffer?.length) throw new Error("小米 MiMo TTS 没有返回音频数据");
  return { buffer, contentType: "audio/wav" };
}
async function synthesizeOpenAiSpeech(cfg, inputText) {
  const payload = JSON.stringify({
    model: cfg.tts.model,
    voice: cfg.tts.voice || "alloy",
    input: String(inputText || "").slice(0, 800),
    response_format: "mp3",
  });
  const res = await fetchJson(cfg.tts.baseUrl + "/audio/speech", {
    method: "POST",
    headers: {
      authorization: `Bearer ${cfg.tts.apiKey}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
    },
    body: payload,
  }, 60000);
  if (!res.ok) throw new Error(res.data?.error?.message || res.raw?.slice?.(0, 200) || `TTS HTTP ${res.status}`);
  return { buffer: res.buffer, contentType: res.headers?.["content-type"] || "audio/mpeg" };
}
async function synthesize(cfg, inputText) {
  if (isMimoTts(cfg)) return synthesizeMimo(cfg, inputText);
  return synthesizeOpenAiSpeech(cfg, inputText);
}
function publicTtsConfig(cfg) {
  return { baseUrl: cfg.tts.baseUrl, model: cfg.tts.model, voice: cfg.tts.voice, apiType: cfg.tts.apiType, hasKey: Boolean(cfg.tts.apiKey) };
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
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,x-client-config,authorization" }); return res.end(); }
    if (pathname === "/api/health") return json(res, 200, { ok: true, service: "ai-voice-call-local", time: new Date().toISOString(), secure: Boolean(req.socket && req.socket.encrypted) });
    if (pathname === "/api/defaults" && req.method === "GET") return json(res, 200, { ok: true, defaults: { llm: { baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen3.5-4B", apiType: "auto" }, stt: { baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/SenseVoiceSmall", apiType: "auto" }, tts: { baseUrl: "https://api.siliconflow.cn/v1", model: "FnLP/MOSS-TTSD-v0.5", voice: "alloy", apiType: "auto" }, systemPromptPreset: "general", systemPrompt: DEFAULT_SYSTEM_PROMPT, maxHistoryTurns: 12, maxTokens: 512, temperature: 0.7, ttsEnabled: true, browserTtsFallback: true, autoSpeak: true, webSearchEnabled: true, searchProvider: "auto" } });
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
      return json(res, 200, { ok: true, llmTest: { ok: true, reply }, llm: { model: cfg.llm.model, baseUrl: cfg.llm.baseUrl, apiType: cfg.llm.apiType, hasKey: true } });
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
        res.writeHead(200, { "content-type": audio.contentType || "audio/mpeg", "cache-control": "no-store", "access-control-allow-origin": "*" });
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

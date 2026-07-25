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
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
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
function resolveConfig(client = {}) {
  const llmBase = ensureV1(pick(client.llm?.baseUrl, env("LLM_BASE_URL"), "https://api.siliconflow.cn/v1"));
  const sttBase = ensureV1(pick(client.stt?.baseUrl, client.llm?.baseUrl, env("STT_BASE_URL"), llmBase));
  const ttsBase = ensureV1(pick(client.tts?.baseUrl, client.llm?.baseUrl, env("TTS_BASE_URL"), llmBase));
  return {
    // API keys come only from the browser-local config sent with each request.
    // The local/Worker server does not store or fall back to server-side API keys.
    llm: { baseUrl: llmBase, apiKey: pick(client.llm?.apiKey), model: pick(client.llm?.model, env("LLM_MODEL"), "Qwen/Qwen3.5-4B") },
    stt: { baseUrl: sttBase, apiKey: pick(client.stt?.apiKey, client.llm?.apiKey), model: pick(client.stt?.model, env("STT_MODEL"), "FunAudioLLM/SenseVoiceSmall") },
    tts: { baseUrl: ttsBase, apiKey: pick(client.tts?.apiKey, client.llm?.apiKey), model: pick(client.tts?.model, env("TTS_MODEL"), "FnLP/MOSS-TTSD-v0.5"), voice: pick(client.tts?.voice, env("TTS_VOICE"), "alloy") },
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
async function chatCompletions(cfg, messages) {
  const endpoint = cfg.llm.baseUrl + "/chat/completions";
  const headers = { authorization: `Bearer ${cfg.llm.apiKey}`, "content-type": "application/json" };
  const base = { model: cfg.llm.model, messages, temperature: cfg.temperature, max_tokens: cfg.maxTokens, stream: false };
  // plain first: some gateways hang/reject unknown thinking fields
  const variants = [
    base,
    { ...base, enable_thinking: false, thinking_budget: 0, chat_template_kwargs: { enable_thinking: false } },
  ];
  let lastErr = "LLM failed";
  for (const payload of variants) {
    try {
      console.log("[llm] request", cfg.llm.model, "tokens=", cfg.maxTokens);
      const res = await fetchJson(endpoint, { method: "POST", headers, body: JSON.stringify(payload) }, 35000);
      if (!res.ok) {
        lastErr = "LLM failed: " + (res.data?.error?.message || res.raw?.slice?.(0, 300) || `HTTP ${res.status}`);
        console.log("[llm] fail", res.status, lastErr);
        if (res.status !== 400) break;
        continue;
      }
      const textOut = extractChatText(res.data);
      if (!textOut) {
        lastErr = "LLM returned empty content";
        console.log("[llm] empty content, raw=", String(res.raw || "").slice(0, 300));
        continue;
      }
      console.log("[llm] ok, chars=", textOut.length);
      return textOut;
    } catch (err) {
      lastErr = String(err.message || err);
      console.log("[llm] error", lastErr);
    }
  }
  throw new Error(lastErr);
}
function shouldAutoSearch(q) {
  const s = String(q || "").trim();
  if (!s) return false;
  const keys = ["天气","新闻","今天","今日","最新","股价","油价","汇率","热点","热搜","查一下","搜索","下雨","气温","限行","几点"];
  if (keys.some((k) => s.includes(k))) return true;
  if (/[?？]$/.test(s) && !/(你好|故事|陪我|解闷)/.test(s)) return true;
  return false;
}
async function searchDuckDuckGo(query) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetchJson(url, { method: "GET", headers: { accept: "application/json" } }, 8000);
  const items = [];
  const data = res.data || {};
  if (data.AbstractText) items.push({ title: data.Heading || "摘要", snippet: String(data.AbstractText).slice(0, 240), url: data.AbstractURL || "" });
  for (const t of data.RelatedTopics || []) {
    const list = t.Topics || [t];
    for (const x of list) {
      if (!x?.Text) continue;
      items.push({ title: String(x.Text).split(" - ")[0].slice(0, 40), snippet: String(x.Text).slice(0, 180), url: x.FirstURL || "" });
      if (items.length >= 5) break;
    }
    if (items.length >= 5) break;
  }
  return { ok: items.length > 0, provider: "duckduckgo", query, items };
}
function formatSearchContext(result) {
  if (!result?.items?.length) return `【联网搜索】未找到可靠结果（${result?.provider || "none"}）。请谨慎回答并说明可能过时。`;
  const lines = result.items.map((it, i) => `${i + 1}. ${it.title}\n   ${it.snippet}${it.url ? " 链接:" + it.url : ""}`);
  return [`【联网搜索结果】查询: ${result.query}（${result.provider}）`, ...lines, "请依据以上结果用简体中文短句回答，不要编造数字。"].join("\n");
}
function sanitizeMessages(messages, systemPrompt, maxTurns) {
  const rest = (messages || []).filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
  const keep = Math.max(2, (maxTurns || 12) * 2);
  return [{ role: "system", content: systemPrompt }, ...rest.slice(-keep)];
}
async function handleChat(body) {
  const cfg = resolveConfig(body.config || {});
  if (!cfg.llm.apiKey) { const e = new Error("缺少 API Key：请在本地配置填写"); e.status = 401; throw e; }
  let messages = Array.isArray(body.messages) ? body.messages : [];
  if (body.message) messages = [...messages, { role: "user", content: String(body.message) }];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const userText = String(lastUser?.content || "").trim();
  if (!userText) { const e = new Error("请输入消息"); e.status = 400; throw e; }
  let systemPrompt = cfg.systemPrompt;
  let webSearch = null;
  if (cfg.webSearchEnabled && shouldAutoSearch(userText)) {
    try {
      const search = await searchDuckDuckGo(userText);
      systemPrompt = `${cfg.systemPrompt}\n\n${formatSearchContext(search)}`;
      webSearch = { used: true, provider: search.provider, ok: search.ok, count: search.items.length, error: "", titles: search.items.slice(0, 3).map((x) => x.title) };
    } catch (err) {
      webSearch = { used: true, provider: "timeout", ok: false, count: 0, error: String(err.message || err), titles: [] };
      systemPrompt = `${cfg.systemPrompt}\n\n【联网搜索】暂时不可用。请简要回答并说明实时信息可能不准。`;
    }
  }
  const finalMessages = sanitizeMessages(messages, systemPrompt, cfg.maxHistoryTurns);
  const reply = await chatCompletions(cfg, finalMessages);
  return { ok: true, reply, model: cfg.llm.model, ttsEnabled: cfg.ttsEnabled, webSearch };
}
function pickTranscript(data) {
  for (const c of [data?.text, data?.result, data?.transcript, data?.data?.text]) if (typeof c === "string" && c.trim()) return c.trim();
  return "";
}
async function transcribe(cfg, file) {
  const models = Array.from(new Set([cfg.stt.model, "FunAudioLLM/SenseVoiceSmall", "TeleAI/TeleSpeechASR"].filter(Boolean)));
  let lastErr = "ASR returned empty text";
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
        lastErr = "ASR returned empty text";
      } catch (err) { lastErr = String(err.message || err); }
    }
  }
  throw new Error(lastErr);
}
async function synthesize(cfg, inputText) {
  const res = await fetchJson(cfg.tts.baseUrl + "/audio/speech", { method: "POST", headers: { authorization: `Bearer ${cfg.tts.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: cfg.tts.model, voice: cfg.tts.voice || "alloy", input: String(inputText || "").slice(0, 800), response_format: "mp3" }) }, 60000);
  if (!res.ok) throw new Error(res.data?.error?.message || res.raw?.slice?.(0, 200) || `TTS HTTP ${res.status}`);
  return res.buffer;
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
    if (pathname === "/api/defaults" && req.method === "GET") return json(res, 200, { ok: true, defaults: { llm: { baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen3.5-4B" }, stt: { baseUrl: "https://api.siliconflow.cn/v1", model: "FunAudioLLM/SenseVoiceSmall" }, tts: { baseUrl: "https://api.siliconflow.cn/v1", model: "FnLP/MOSS-TTSD-v0.5", voice: "alloy" }, systemPromptPreset: "general", systemPrompt: DEFAULT_SYSTEM_PROMPT, maxHistoryTurns: 12, maxTokens: 512, temperature: 0.7, ttsEnabled: true, browserTtsFallback: true, autoSpeak: true, webSearchEnabled: true, searchProvider: "auto" } });
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
      return json(res, 200, { ok: true, llmTest: { ok: true, reply }, llm: { model: cfg.llm.model, baseUrl: cfg.llm.baseUrl, hasKey: true } });
    }
    if (pathname === "/api/search" && req.method === "POST") {
      const raw = await readBody(req); const body = JSON.parse(raw.toString("utf8") || "{}"); const q = String(body.query || body.q || "").trim();
      if (!q) return json(res, 400, { ok: false, error: "missing query" });
      return json(res, 200, await searchDuckDuckGo(q));
    }
    if (pathname === "/api/asr" && req.method === "POST") {
      const raw = await readBody(req); const parsed = parseMultipart(raw, req.headers["content-type"]);
      if (!parsed.file) return json(res, 400, { ok: false, error: "missing audio file" });
      let clientConfig = {};
      const headerCfg = req.headers["x-client-config"];
      if (headerCfg) { try { const s = String(headerCfg); clientConfig = s.trim().startsWith("{") ? JSON.parse(s) : JSON.parse(Buffer.from(s, "base64").toString("utf8")); } catch {} }
      else if (parsed.fields.config) { try { clientConfig = JSON.parse(parsed.fields.config); } catch {} }
      const cfg = resolveConfig(clientConfig);
      if (!cfg.stt.apiKey) return json(res, 401, { ok: false, error: "缺少 STT API Key" });
      const result = await transcribe(cfg, parsed.file);
      return json(res, 200, { ok: true, text: result.text, model: result.model, bytes: parsed.file.buffer.length });
    }
    if (pathname === "/api/tts" && req.method === "POST") {
      const raw = await readBody(req); const body = JSON.parse(raw.toString("utf8") || "{}"); const cfg = resolveConfig(body.config || {});
      if (!cfg.tts.apiKey) return json(res, 401, { ok: false, error: "缺少 TTS API Key" });
      const audio = await synthesize(cfg, body.text || "");
      res.writeHead(200, { "content-type": "audio/mpeg", "cache-control": "no-store", "access-control-allow-origin": "*" });
      return res.end(audio);
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

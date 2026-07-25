/**
 * AI语音通话 - Cloudflare Worker
 * - Local browser config (import/export) preferred
 * - Server secrets only as fallback
 * - Never log API keys
 */

import { formatSearchContext, runWebSearch, shouldAutoSearch } from "./search";

export interface Env {
  ASSETS: Fetcher;
  LLM_BASE_URL?: string;
  STT_BASE_URL?: string;
  TTS_BASE_URL?: string;
  LLM_MODEL?: string;
  STT_MODEL?: string;
  TTS_MODEL?: string;
  TTS_VOICE?: string;
  TTS_ENABLED?: string;
  BROWSER_TTS_FALLBACK?: string;
  MAX_HISTORY_TURNS?: string;
  LLM_MAX_TOKENS?: string;
  LLM_TEMPERATURE?: string;
  SYSTEM_PROMPT?: string;
  WEB_SEARCH_ENABLED?: string;
  SEARCH_PROVIDER?: string;
  SEARCH_BASE_URL?: string;
}

type Role = "system" | "user" | "assistant";

interface ChatMessage {
  role: Role;
  content: string;
}

interface ClientProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  voice?: string;
}

interface ClientConfig {
  llm?: ClientProviderConfig;
  stt?: ClientProviderConfig;
  tts?: ClientProviderConfig;
  systemPromptPreset?: string;
  systemPrompt?: string;
  maxHistoryTurns?: number;
  maxTokens?: number;
  temperature?: number;
  ttsEnabled?: boolean;
  webSearchEnabled?: boolean;
  searchProvider?: string; // auto | duckduckgo | searxng | tavily | serper
  searchApiKey?: string;
  searchBaseUrl?: string;
}

interface ChatRequestBody {
  message?: string;
  messages?: ChatMessage[];
  config?: ClientConfig;
  speak?: boolean;
}

const DEFAULT_SYSTEM_PROMPT =
  "你是一个中文 AI 助手。默认使用简体中文，回答清楚、自然、有帮助。优先给出可执行建议，少说空话。根据用户语气调整详略；适合语音朗读时使用短句。涉及医疗、药品、投资、法律等高风险内容时，只提供一般信息，提醒不能替代专业人士。若提供了【联网搜索结果】，请优先依据结果回答，不编造实时数据。不要输出思考过程。";

function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function badRequest(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

function asBool(v: string | boolean | undefined, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (v == null || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).trim().toLowerCase());
}

function asNumber(v: string | number | undefined, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function pickKey(...keys: Array<string | undefined>): string {
  for (const key of keys) {
    const v = (key || "").trim();
    if (v) return v;
  }
  return "";
}

function pickUrl(...urls: Array<string | undefined>): string {
  for (const url of urls) {
    const v = (url || "").trim();
    if (v) return trimSlash(v);
  }
  return "";
}

function ensureV1(baseUrl: string): string {
  const u = trimSlash(baseUrl);
  if (!u) return "";
  if (/\/v1$/i.test(u)) return u;
  return `${u}/v1`;
}

function sanitizeMessages(messages: ChatMessage[], systemPrompt: string, maxTurns: number): ChatMessage[] {
  const cleaned = (messages || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant" || m.role === "system") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

  const withoutSystem = cleaned.filter((m) => m.role !== "system");
  const keep = Math.max(2, maxTurns * 2);
  const trimmed = withoutSystem.slice(-keep);
  return [{ role: "system", content: systemPrompt }, ...trimmed];
}

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `${res.status} ${res.statusText}`;
    try {
      const data = JSON.parse(text) as any;
      return data?.error?.message || data?.message || text.slice(0, 500);
    } catch {
      return text.slice(0, 500);
    }
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

function publicConfig(env: Env) {
  return {
    ok: true,
    defaults: {
      llm: {
        baseUrl: env.LLM_BASE_URL || "https://api.siliconflow.cn/v1",
        model: env.LLM_MODEL || "Qwen/Qwen3.5-4B",
      },
      stt: {
        baseUrl: env.STT_BASE_URL || env.LLM_BASE_URL || "https://api.siliconflow.cn/v1",
        model: env.STT_MODEL || "FunAudioLLM/SenseVoiceSmall",
      },
      tts: {
        baseUrl: env.TTS_BASE_URL || env.LLM_BASE_URL || "https://api.siliconflow.cn/v1",
        model: env.TTS_MODEL || "FnLP/MOSS-TTSD-v0.5",
        voice: env.TTS_VOICE || "alloy",
      },
      systemPrompt: env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
      maxHistoryTurns: asNumber(env.MAX_HISTORY_TURNS, 12),
      maxTokens: asNumber(env.LLM_MAX_TOKENS, 512),
      temperature: asNumber(env.LLM_TEMPERATURE, 0.7),
      ttsEnabled: asBool(env.TTS_ENABLED, true),
      browserTtsFallback: asBool(env.BROWSER_TTS_FALLBACK, true),
      autoSpeak: true,
      webSearchEnabled: asBool(env.WEB_SEARCH_ENABLED, true),
      systemPromptPreset: "general",
      searchProvider: env.SEARCH_PROVIDER || "auto",
    },
  };
}

function resolveProviders(env: Env, config?: ClientConfig) {
  const llmBase = ensureV1(
    pickUrl(config?.llm?.baseUrl, env.LLM_BASE_URL, "https://api.siliconflow.cn/v1"),
  );
  const sttBase = ensureV1(
    pickUrl(config?.stt?.baseUrl, config?.llm?.baseUrl, env.STT_BASE_URL, env.LLM_BASE_URL, llmBase),
  );
  const ttsBase = ensureV1(
    pickUrl(config?.tts?.baseUrl, config?.llm?.baseUrl, env.TTS_BASE_URL, env.LLM_BASE_URL, llmBase),
  );

  // API keys are intentionally accepted only from the browser-local config per request.
  // Do not fall back to server-side secrets: this app keeps user configuration local.
  const llmKey = pickKey(config?.llm?.apiKey);
  const sttKey = pickKey(config?.stt?.apiKey, config?.llm?.apiKey);
  const ttsKey = pickKey(config?.tts?.apiKey, config?.llm?.apiKey);

  return {
    llm: {
      baseUrl: llmBase,
      apiKey: llmKey,
      model: (config?.llm?.model || env.LLM_MODEL || "Qwen/Qwen3.5-4B").trim(),
    },
    stt: {
      baseUrl: sttBase,
      apiKey: sttKey,
      model: (config?.stt?.model || env.STT_MODEL || "FunAudioLLM/SenseVoiceSmall").trim(),
    },
    tts: {
      baseUrl: ttsBase,
      apiKey: ttsKey,
      model: (config?.tts?.model || env.TTS_MODEL || "FnLP/MOSS-TTSD-v0.5").trim(),
      voice: (config?.tts?.voice || env.TTS_VOICE || "alloy").trim(),
    },
    systemPromptPreset: (config?.systemPromptPreset || "general").trim(),
    systemPrompt: (config?.systemPrompt || env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT).trim(),
    maxHistoryTurns: asNumber(config?.maxHistoryTurns ?? env.MAX_HISTORY_TURNS, 12),
    maxTokens: asNumber(config?.maxTokens ?? env.LLM_MAX_TOKENS, 512),
    temperature: asNumber(config?.temperature ?? env.LLM_TEMPERATURE, 0.7),
    ttsEnabled: config?.ttsEnabled ?? asBool(env.TTS_ENABLED, true),
    webSearchEnabled: config?.webSearchEnabled ?? asBool(env.WEB_SEARCH_ENABLED, true),
    searchProvider: (config?.searchProvider || env.SEARCH_PROVIDER || "auto").trim(),
    searchApiKey: (config?.searchApiKey || "").trim(),
    searchBaseUrl: (config?.searchBaseUrl || env.SEARCH_BASE_URL || "").trim(),
  };
}

function extractTextContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p.text === "string") return p.text;
          if (typeof p.content === "string") return p.content;
        }
        return "";
      })
      .join("")
      .trim();
  }
  if (typeof content === "object") {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text.trim();
    if (typeof obj.content === "string") return obj.content.trim();
  }
  return "";
}

function stripThinking(text: string): string {
  let out = text.trim();
  // common think wrappers
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  out = out.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
  // if model dumped analysis + final answer markers
  const markers = ["最终回答：", "最终答案：", "答：", "Answer:", "Final answer:"];
  for (const m of markers) {
    const idx = out.lastIndexOf(m);
    if (idx >= 0) {
      out = out.slice(idx + m.length).trim();
      break;
    }
  }
  return out.trim();
}

function extractChatText(data: any): string {
  const choice = data?.choices?.[0] || {};
  const message = choice.message || choice.delta || {};

  // Only the normal content field is the user-facing reply.
  // reasoning_content / reasoning / thought are the model-internal chain-of-thought:
  // before this fix, when content was empty we wrongly grabbed the last paragraph of
  // reasoning_content and returned it as the answer, leaking the thinking process to parents.
  const content = extractTextContent(message.content);
  if (content) return stripThinking(content);

  const alt = extractTextContent(choice.text ?? data?.output_text ?? data?.content ?? data?.reply);
  return alt ? stripThinking(alt) : "";
}

function looksLikeQwenThinkingModel(model: string): boolean {
  const m = model.toLowerCase();
  return m.includes("qwen3") || m.includes("qwen/qwen3") || m.includes("qwq");
}

async function chatCompletions(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
): Promise<string> {
  // For parent chat we want final spoken answer, not chain-of-thought.
  // Qwen3.5 on SiliconFlow defaults to thinking and may put text only in reasoning_content.
  const safeMaxTokens = Math.max(maxTokens || 0, 512);

  const payload: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens: safeMaxTokens,
    stream: false,
    // SiliconFlow / Qwen3 knobs (ignored by gateways that don't support them)
    enable_thinking: false,
    thinking_budget: 0,
    chat_template_kwargs: {
      enable_thinking: false,
    },
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    // Some providers reject unknown fields; retry with minimal OpenAI payload
    const errText = await readError(res);
    if (res.status === 400 || /unknown|invalid|unexpected/i.test(errText)) {
      const retry = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: safeMaxTokens,
          stream: false,
        }),
      });
      if (!retry.ok) {
        throw new Error(`LLM failed: ${await readError(retry)}`);
      }
      const retryData = (await retry.json()) as any;
      const retryText = extractChatText(retryData);
      if (!retryText) {
        const finish = retryData?.choices?.[0]?.finish_reason;
        const preview = JSON.stringify(retryData?.choices?.[0] || retryData).slice(0, 400);
        throw new Error(
          `LLM returned empty content after retry (finish_reason=${finish || "unknown"}). raw=${preview}`,
        );
      }
      return retryText;
    }
    throw new Error(`LLM failed: ${errText}`);
  }

  const data = (await res.json()) as any;
  const text = extractChatText(data);
  if (!text) {
    const finish = data?.choices?.[0]?.finish_reason;
    const preview = JSON.stringify(data?.choices?.[0] || data).slice(0, 400);
    const hint = looksLikeQwenThinkingModel(model)
      ? " 这很像 Qwen3 思考模式：答案在 reasoning_content，且 max_tokens 被思考占满。已尝试关闭 thinking；可再把最大回复长度调到 512+，或换非 thinking 模型。"
      : "";
    throw new Error(
      `LLM returned empty content (finish_reason=${finish || "unknown"}).${hint} raw=${preview}`,
    );
  }
  return text;
}
function pickTranscript(data: any): string {
  const candidates = [
    data?.text,
    data?.result,
    data?.transcript,
    data?.data?.text,
    data?.output?.text,
    Array.isArray(data?.text) ? data.text.join("") : "",
    Array.isArray(data?.results)
      ? data.results.map((r: any) => r?.text || r?.transcript || "").join("")
      : "",
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}

async function transcribeOnce(
  baseUrl: string,
  apiKey: string,
  model: string,
  file: File,
  withLanguage: boolean,
): Promise<{ text: string; raw: any; status: number; error?: string }> {
  const name = file.name || "speech.wav";
  const form = new FormData();
  form.append("file", file, name);
  form.append("model", model);
  form.append("response_format", "json");
  if (withLanguage) form.append("language", "zh");

  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const rawText = await res.text();
  let raw: any = rawText;
  try { raw = JSON.parse(rawText); } catch {}

  if (!res.ok) {
    const msg = typeof raw === "object"
      ? (raw?.error?.message || raw?.message || rawText.slice(0, 300))
      : String(rawText).slice(0, 300);
    return { text: "", raw, status: res.status, error: msg };
  }

  return { text: pickTranscript(raw), raw, status: res.status };
}

async function transcribe(
  baseUrl: string,
  apiKey: string,
  model: string,
  file: File,
): Promise<string> {
  const models = Array.from(
    new Set(
      [
        model,
        "FunAudioLLM/SenseVoiceSmall",
        "TeleAI/TeleSpeechASR",
      ].filter(Boolean),
    ),
  );

  const attempts: Array<Record<string, unknown>> = [];

  for (const m of models) {
    for (const withLanguage of [true, false]) {
      const result = await transcribeOnce(baseUrl, apiKey, m, file, withLanguage);
      attempts.push({
        model: m,
        withLanguage,
        status: result.status,
        text: result.text,
        error: result.error || "",
      });
      if (result.text) return result.text;
    }
  }

  const preview = JSON.stringify(attempts).slice(0, 500);
  throw new Error(`ASR returned empty text. attempts=${preview}`);
}
async function synthesize(
  baseUrl: string,
  apiKey: string,
  model: string,
  voice: string,
  input: string,
): Promise<Response> {
  const res = await fetch(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      voice,
      input,
      response_format: "mp3",
    }),
  });

  if (!res.ok) {
    throw new Error(`TTS failed: ${await readError(res)}`);
  }

  const contentType = res.headers.get("content-type") || "audio/mpeg";
  const buf = await res.arrayBuffer();
  return new Response(buf, {
    status: 200,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
    },
  });
}

function parseClientConfig(raw: unknown): ClientConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return raw as ClientConfig;
}

async function handleChat(req: Request, env: Env): Promise<Response> {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return badRequest("Invalid JSON body");
  }

  const clientCfg = parseClientConfig(body.config);
  const cfg = resolveProviders(env, clientCfg);
  if (!cfg.llm.apiKey) {
    return badRequest("缺少 API Key：请在页面「本地配置」里填写，或设置服务器密钥", 401);
  }
  if (!cfg.llm.baseUrl) {
    return badRequest("缺少 LLM Base URL");
  }

  let messages = Array.isArray(body.messages) ? body.messages : [];
  const single = (body.message || "").trim();
  if (single) {
    messages = [...messages, { role: "user", content: single }];
  }
  if (!messages.some((m) => m.role === "user" && m.content.trim())) {
    return badRequest("请输入消息");
  }

  const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content.trim());
  const userText = (lastUser?.content || "").trim();

  let searchMeta: Record<string, unknown> | null = null;
  let systemPrompt = cfg.systemPrompt;
  const wantSearch = Boolean(cfg.webSearchEnabled) && shouldAutoSearch(userText);

  if (wantSearch) {
    const search = await runWebSearch({
      query: userText,
      provider: cfg.searchProvider,
      apiKey: cfg.searchApiKey,
      baseUrl: cfg.searchBaseUrl,
    });
    systemPrompt = `${cfg.systemPrompt}

${formatSearchContext(search)}`;
    searchMeta = {
      used: true,
      provider: search.provider,
      ok: search.ok,
      count: search.items.length,
      error: search.error || "",
      titles: search.items.slice(0, 3).map((x: { title: string }) => x.title),
    };
  }

  const finalMessages = sanitizeMessages(messages, systemPrompt, cfg.maxHistoryTurns);
  const reply = await chatCompletions(
    cfg.llm.baseUrl,
    cfg.llm.apiKey,
    cfg.llm.model,
    finalMessages,
    cfg.maxTokens,
    cfg.temperature,
  );

  return json({
    ok: true,
    reply,
    model: cfg.llm.model,
    ttsEnabled: cfg.ttsEnabled,
    webSearch: searchMeta,
  });
}

function decodeClientConfigHeader(text: string): ClientConfig {
  const raw = text.trim();
  if (raw.startsWith("{")) return JSON.parse(raw) as ClientConfig;
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const jsonText = new TextDecoder().decode(bytes);
  return JSON.parse(jsonText) as ClientConfig;
}

function parseConfigFromRequest(req: Request, form?: FormData): ClientConfig | undefined {
  const headerRaw = req.headers.get("x-client-config") || req.headers.get("X-Client-Config");
  if (headerRaw && headerRaw.trim()) {
    try {
      return decodeClientConfigHeader(headerRaw);
    } catch {
      // fall through
    }
  }
  if (form) {
    const rawConfig = form.get("config");
    if (typeof rawConfig === "string" && rawConfig.trim()) {
      try {
        return JSON.parse(rawConfig) as ClientConfig;
      } catch {
        throw new Error("invalid config JSON");
      }
    }
  }
  return undefined;
}

async function handleAsr(req: Request, env: Env): Promise<Response> {
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return badRequest("ASR expects multipart/form-data");
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err: any) {
    return badRequest(`无法读取录音数据: ${String(err?.message || err)}`);
  }

  const file = form.get("file") || form.get("audio");
  if (!(file instanceof File)) {
    return badRequest("missing audio file");
  }
  if (file.size < 64) {
    return badRequest("录音太短，请按住多说一会儿");
  }

  let clientConfig: ClientConfig | undefined;
  try {
    clientConfig = parseConfigFromRequest(req, form);
  } catch (err: any) {
    return badRequest(String(err?.message || err));
  }

  const cfg = resolveProviders(env, clientConfig);
  if (!cfg.stt.apiKey) {
    return badRequest("缺少 STT API Key：请在本地配置中填写", 401);
  }
  if (!cfg.stt.baseUrl) {
    return badRequest("缺少 STT Base URL");
  }

  try {
    const text = await transcribe(cfg.stt.baseUrl, cfg.stt.apiKey, cfg.stt.model, file);
    return json({ ok: true, text, model: cfg.stt.model, bytes: file.size });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message || err) }, 502);
  }
}

async function handleTts(req: Request, env: Env): Promise<Response> {
  let body: { text?: string; config?: ClientConfig };
  try {
    body = (await req.json()) as { text?: string; config?: ClientConfig };
  } catch {
    return badRequest("Invalid JSON body");
  }

  const text = (body.text || "").trim();
  if (!text) return badRequest("missing text");

  const cfg = resolveProviders(env, parseClientConfig(body.config));
  if (!cfg.ttsEnabled) {
    return badRequest("TTS disabled", 400);
  }
  if (!cfg.tts.apiKey) {
    return badRequest("缺少 TTS API Key：请在本地配置中填写", 401);
  }

  return synthesize(cfg.tts.baseUrl, cfg.tts.apiKey, cfg.tts.model, cfg.tts.voice, text.slice(0, 800));
}

async function handleTest(req: Request, env: Env): Promise<Response> {
  let body: { config?: ClientConfig } = {};
  try {
    body = (await req.json()) as { config?: ClientConfig };
  } catch {
    // empty body ok
  }

  const cfg = resolveProviders(env, parseClientConfig(body.config));
  const result: Record<string, unknown> = {
    ok: true,
    llm: { baseUrl: cfg.llm.baseUrl, model: cfg.llm.model, hasKey: Boolean(cfg.llm.apiKey) },
    stt: { baseUrl: cfg.stt.baseUrl, model: cfg.stt.model, hasKey: Boolean(cfg.stt.apiKey) },
    tts: { baseUrl: cfg.tts.baseUrl, model: cfg.tts.model, voice: cfg.tts.voice, hasKey: Boolean(cfg.tts.apiKey) },
  };

  if (!cfg.llm.apiKey) {
    return json({ ...result, ok: false, error: "未配置 API Key" }, 401);
  }

  try {
    const reply = await chatCompletions(
      cfg.llm.baseUrl,
      cfg.llm.apiKey,
      cfg.llm.model,
      [
        { role: "system", content: "你是测试助手，只回复：连接成功。" },
        { role: "user", content: "ping" },
      ],
      20,
      0,
    );
    result.llmTest = { ok: true, reply };
  } catch (err: any) {
    return json({ ...result, ok: false, llmTest: { ok: false, error: String(err?.message || err) } }, 502);
  }

  return json(result);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health") {
        return json({ ok: true, service: "ai-voice-call", time: new Date().toISOString() });
      }

      if (url.pathname === "/api/defaults" && request.method === "GET") {
        return json(publicConfig(env));
      }

      if (url.pathname === "/api/chat" && request.method === "POST") {
        return await handleChat(request, env);
      }

      if (url.pathname === "/api/asr" && request.method === "POST") {
        return await handleAsr(request, env);
      }

      if (url.pathname === "/api/tts" && request.method === "POST") {
        return await handleTts(request, env);
      }

      if (url.pathname === "/api/test" && request.method === "POST") {
        return await handleTest(request, env);
      }

      if (url.pathname === "/api/search" && request.method === "POST") {
        let body: any = {};
        try { body = await request.json(); } catch {}
        const clientCfg = parseClientConfig(body.config);
        const cfg = resolveProviders(env, clientCfg);
        const query = String(body.query || body.q || "").trim();
        if (!query) return badRequest("missing query");
        const search = await runWebSearch({
          query,
          provider: body.provider || cfg.searchProvider,
          apiKey: body.apiKey || cfg.searchApiKey,
          baseUrl: body.baseUrl || cfg.searchBaseUrl,
        });
        return json(search);
      }

      if (url.pathname.startsWith("/api/")) {
        return badRequest("Not found", 404);
      }

      return env.ASSETS.fetch(request);
    } catch (err: any) {
      return json({ ok: false, error: String(err?.message || err) }, 500);
    }
  },
};

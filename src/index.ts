/**
 * AI语音通话 - Cloudflare Worker
 * - Local browser config (import/export) preferred
 * - Server secrets only as fallback
 * - Never log API keys
 */

import { extractWeatherLocation, formatSearchContext, isExplicitSearchRequest, isRealtimeQuery, isWeatherQuery, runWebSearch, shouldAutoSearch } from "./search";

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

type Role = "system" | "user" | "assistant" | "tool";

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } };

interface FunctionToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: Role;
  content: string | ChatContentPart[];
  tool_calls?: FunctionToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ClientProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  voice?: string;
  apiType?: string;
  endpoint?: string;
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
  toolCallingEnabled?: boolean;
  timeZone?: string;
  webSearchEnabled?: boolean;
  searchProvider?: string; // auto | bing-rss | duckduckgo | searxng | tavily | serper
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

function resolveCustomEndpoint(baseUrl: string, endpoint: string | undefined, fallbackPath: string): string {
  const base = trimSlash((baseUrl || "").trim());
  const custom = (endpoint || "").trim();
  const fallback = (fallbackPath || "").trim().replace(/^\/+/, "");
  if (!custom) {
    if (!base) throw new Error("缺少 API Base URL");
    return fallback ? `${base}/${fallback}` : base;
  }
  if (/^https?:\/\//i.test(custom)) return custom;
  if (!base) throw new Error("相对接口地址需要配置 API Base URL");
  if (custom.startsWith("/")) return `${new URL(base).origin}${custom}`;
  return `${base}/${custom.replace(/^\/+/, "")}`;
}

function normalizeApiType(value: string | undefined, fallback = "auto"): string {
  const allowed = new Set(["auto", "custom", "openai-chat", "openai-responses", "openai-transcriptions", "openai-speech", "xiaomi-mimo"]);
  const v = (value || "").trim();
  return allowed.has(v) ? v : fallback;
}

function keyDiagnostic(apiKey: string | undefined) {
  const key = (apiKey || "").trim();
  return {
    hasKey: Boolean(key),
    keyLength: key.length,
    keyTail: key ? key.slice(-4) : "",
    hasBearerPrefix: /^bearer\s+/i.test(key),
  };
}

function publicLlmConfig(baseUrl: string, model: string, apiType: string | undefined, apiKey: string, endpoint = "") {
  return {
    baseUrl,
    model,
    apiType: normalizeApiType(apiType, "auto"),
    endpoint,
    ...keyDiagnostic(apiKey),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientAuthError(status: number, message: string) {
  return status === 401 && /invalid\s+(api\s*key|token)|invalid\s+key/i.test(message || "");
}

function formatLlmFailure(status: number, message: string) {
  const msg = (message || `HTTP ${status}`).trim();
  if (isTransientAuthError(status, msg)) {
    return `LLM failed: ${msg}。如果同一 Key 马上重试可成功，通常是供应商限流或网关临时认证异常；请稍后重试或更换供应商。`;
  }
  if (status === 429) {
    return `LLM failed: ${msg}。供应商返回限流/额度不足，请稍后重试或更换模型/供应商。`;
  }
  return `LLM failed: ${msg}`;
}

async function fetchLlmEndpointWithTransientRetry(
  endpointUrl: string,
  apiKey: string,
  endpointPath: string,
  payload: Record<string, unknown>,
  diag: ReturnType<typeof publicLlmConfig>,
  timeoutMs = 0,
): Promise<{ res: Response; errText: string }> {
  const doFetch = async () => {
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      return await fetch(endpointUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  let res = await doFetch();
  if (res.ok) return { res, errText: "" };
  let errText = await readError(res);
  if (isTransientAuthError(res.status, errText)) {
    console.log("[llm] transient auth error, retry once", { status: res.status, endpointPath, ...diag });
    await sleep(800);
    res = await doFetch();
    if (res.ok) return { res, errText: "" };
    errText = await readError(res);
  }
  return { res, errText };
}

async function fetchChatCompletionWithTransientRetry(
  baseUrl: string,
  apiKey: string,
  payload: Record<string, unknown>,
  diag: ReturnType<typeof publicLlmConfig>,
): Promise<{ res: Response; errText: string }> {
  return fetchLlmEndpointWithTransientRetry(`${baseUrl}/chat/completions`, apiKey, "chat/completions", payload, diag);
}
function ensureV1(baseUrl: string): string {
  const u = trimSlash(baseUrl);
  if (!u) return "";
  if (/\/v1$/i.test(u)) return u;
  return `${u}/v1`;
}

function sanitizeMessages(messages: ChatMessage[], systemPrompt: string, maxTurns: number): ChatMessage[] {
  const cleaned = (messages || [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant" || m.role === "system"))
    .map((m) => ({ role: m.role, content: sanitizeMessageContent(m.content) }))
    .filter((m) => typeof m.content === "string" ? Boolean(m.content.trim()) : m.content.length > 0);

  const withoutSystem = cleaned.filter((m) => m.role !== "system");
  const keep = Math.max(2, maxTurns * 2);
  const trimmed = withoutSystem.slice(-keep);
  return [{ role: "system", content: withReplyOnlyInstruction(systemPrompt) }, ...trimmed];
}

// Never echo an upstream body verbatim: with a wrong or hostile endpoint it can
// be an arbitrary page rather than a provider error. JSON error messages and
// short plain-text errors stay visible so real misconfiguration is debuggable.
function summarizeUpstreamError(status: number | string, statusText: string, contentType: string | null, body: string): string {
  const head = `HTTP ${status}${statusText ? " " + statusText : ""}`.trim();
  const raw = String(body || "").trim();
  if (!raw) return head;
  try {
    const data = JSON.parse(raw) as any;
    const msg = String(data?.error?.message || data?.message || "").trim();
    if (msg) return msg.slice(0, 500);
  } catch {}
  if (/html/i.test(String(contentType || "")) || /^</.test(raw)) {
    return `${head}（接口返回的是网页而不是 JSON，请检查 Base URL / 接口地址是否填错）`;
  }
  if (raw.length <= 200) return raw;
  return `${head}（接口返回了非 JSON 内容，共 ${raw.length} 字符）`;
}

async function readError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return summarizeUpstreamError(res.status, res.statusText, res.headers.get("content-type"), text);
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
        apiType: "auto",
        endpoint: "",
      },
      stt: {
        baseUrl: env.STT_BASE_URL || env.LLM_BASE_URL || "https://api.siliconflow.cn/v1",
        model: env.STT_MODEL || "FunAudioLLM/SenseVoiceSmall",
        apiType: "auto",
        endpoint: "",
      },
      tts: {
        baseUrl: env.TTS_BASE_URL || env.LLM_BASE_URL || "https://api.siliconflow.cn/v1",
        model: env.TTS_MODEL || "FnLP/MOSS-TTSD-v0.5",
        voice: env.TTS_VOICE || "alloy",
        apiType: "auto",
        endpoint: "",
      },
      systemPrompt: env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
      maxHistoryTurns: asNumber(env.MAX_HISTORY_TURNS, 12),
      maxTokens: asNumber(env.LLM_MAX_TOKENS, 512),
      temperature: asNumber(env.LLM_TEMPERATURE, 0.7),
      ttsEnabled: asBool(env.TTS_ENABLED, true),
      browserTtsFallback: asBool(env.BROWSER_TTS_FALLBACK, true),
      autoSpeak: true,
      toolCallingEnabled: true,
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
      apiType: normalizeApiType(config?.llm?.apiType),
      endpoint: (config?.llm?.endpoint || "").trim(),
    },
    stt: {
      baseUrl: sttBase,
      apiKey: sttKey,
      model: (config?.stt?.model || env.STT_MODEL || "FunAudioLLM/SenseVoiceSmall").trim(),
      apiType: normalizeApiType(config?.stt?.apiType),
      endpoint: (config?.stt?.endpoint || "").trim(),
    },
    tts: {
      baseUrl: ttsBase,
      apiKey: ttsKey,
      model: (config?.tts?.model || env.TTS_MODEL || "FnLP/MOSS-TTSD-v0.5").trim(),
      voice: (config?.tts?.voice || env.TTS_VOICE || "alloy").trim(),
      apiType: normalizeApiType(config?.tts?.apiType),
      endpoint: (config?.tts?.endpoint || "").trim(),
    },
    systemPromptPreset: (config?.systemPromptPreset || "general").trim(),
    systemPrompt: (config?.systemPrompt || env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT).trim(),
    maxHistoryTurns: asNumber(config?.maxHistoryTurns ?? env.MAX_HISTORY_TURNS, 12),
    maxTokens: asNumber(config?.maxTokens ?? env.LLM_MAX_TOKENS, 512),
    temperature: asNumber(config?.temperature ?? env.LLM_TEMPERATURE, 0.7),
    ttsEnabled: config?.ttsEnabled ?? asBool(env.TTS_ENABLED, true),
    toolCallingEnabled: config?.toolCallingEnabled !== false,
    timeZone: (config?.timeZone || "Asia/Hong_Kong").trim(),
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

function sanitizeMessageContent(content: unknown): string | ChatContentPart[] {
  if (typeof content === "string") return content.slice(0, 4000);
  if (!Array.isArray(content)) return "";
  const parts: ChatContentPart[] = [];
  for (const raw of content.slice(0, 8)) {
    if (!raw || typeof raw !== "object") continue;
    const part = raw as Record<string, any>;
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

function messageHasImage(content: unknown): boolean {
  return Array.isArray(content) && content.some((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const part = raw as Record<string, any>;
    return part.type === "image_url" && (typeof part.image_url === "string" || typeof part.image_url?.url === "string");
  });
}

function messagesHaveVision(messages: ChatMessage[]): boolean {
  return (Array.isArray(messages) ? messages : []).some((message) => message?.role === "user" && messageHasImage(message.content));
}

function appendVisionQueryAnchor(messages: ChatMessage[]): ChatMessage[] {
  const list = Array.isArray(messages) ? messages : [];
  const lastVisionUser = [...list].reverse().find((message) => message?.role === "user" && messageHasImage(message.content));
  if (!lastVisionUser) return list;
  const query = extractTextContent(lastVisionUser.content) || "请分析上一条消息中的图片。";
  return [...list, { role: "user", content: query }];
}

function isNoUserQueryError(message: unknown): boolean {
  return /no user query found in messages/i.test(String(message || ""));
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


type LlmKind = "chat" | "responses";

const REPLY_ONLY_INSTRUCTION = "输出要求：只输出给用户的最终回答，不要复述系统提示词、角色设定、对话记录或用户原话，不要重复回答。";

function escapeRegExp(value: string): string {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function withReplyOnlyInstruction(systemPrompt: string): string {
  const prompt = String(systemPrompt || "").trim();
  if (!prompt || prompt.includes(REPLY_ONLY_INSTRUCTION)) return prompt;
  return `${prompt}\n\n${REPLY_ONLY_INSTRUCTION}`;
}

function mergeStreamText(current: string, incoming: string, cumulative = false): { reply: string; delta: string } {
  const reply = String(current || "");
  const text = String(incoming || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
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

function cleanAssistantReply(text: string, messages: ChatMessage[] = []): string {
  const original = String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\|(?:im_start|im_end|endoftext|system|user|assistant)\|>/gi, "")
    .trim();
  if (!original) return "";
  let cleaned = original;
  const systemPrompts = messages
    .filter((message) => message?.role === "system")
    .flatMap((message) => {
      const prompt = extractTextContent(message.content);
      const basePrompt = prompt.replace(REPLY_ONLY_INSTRUCTION, "").trim();
      return [prompt, basePrompt];
    })
    .filter((prompt) => prompt.length >= 12)
    .sort((a, b) => b.length - a.length);
  for (const prompt of new Set(systemPrompts)) cleaned = cleaned.split(prompt).join("\n");

  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
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

function preferredLlmKind(apiType = "auto"): LlmKind {
  return normalizeApiType(apiType, "auto") === "openai-responses" ? "responses" : "chat";
}

// Deliberately a single kind: vision always needs Chat Completions, and every
// other case follows the configured apiType. There is no chat->responses
// fallback — a provider that rejects Chat Completions should be configured as
// "OpenAI Responses" explicitly rather than discovered by retrying.
function llmKinds(apiType = "auto", messages: ChatMessage[] = []): LlmKind[] {
  return [messagesHaveVision(messages) ? "chat" : preferredLlmKind(apiType)];
}

function splitSystemMessages(messages: ChatMessage[]): { instructions: string; input: ChatMessage[] } {
  const list = Array.isArray(messages) ? messages : [];
  const instructions = list
    .filter((m) => m.role === "system")
    .map((m) => extractTextContent(m.content))
    .join("\n\n")
    .trim();
  const input = list
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  return { instructions, input };
}

function buildChatPayload(
  model: string,
  messages: ChatMessage[],
  safeMaxTokens: number,
  temperature: number,
  stream = false,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { model, messages, temperature, max_tokens: safeMaxTokens, stream, ...extra };
}

function buildResponsesPayload(
  model: string,
  messages: ChatMessage[],
  safeMaxTokens: number,
  temperature: number,
  stream = false,
  toolType = "web_search",
): Record<string, unknown> {
  const { instructions, input } = splitSystemMessages(messages);
  const payload: Record<string, unknown> = {
    model,
    input,
    temperature,
    max_output_tokens: safeMaxTokens,
    stream,
    tools: [{ type: toolType }],
    tool_choice: "auto",
  };
  if (instructions) payload.instructions = instructions;
  return payload;
}

function payloadVariants(
  kind: LlmKind,
  model: string,
  messages: ChatMessage[],
  safeMaxTokens: number,
  temperature: number,
  stream = false,
): Record<string, unknown>[] {
  if (kind === "responses") return [
    buildResponsesPayload(model, messages, safeMaxTokens, temperature, stream),
    buildResponsesPayload(model, messages, safeMaxTokens, temperature, stream, "web_search_preview"),
  ];
  return [
    buildChatPayload(model, messages, safeMaxTokens, temperature, stream, {
      // SiliconFlow / Qwen3 knobs (ignored by gateways that don't support them)
      enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false },
    }),
    buildChatPayload(model, messages, safeMaxTokens, temperature, stream),
    ...(messagesHaveVision(messages)
      ? [buildChatPayload(model, appendVisionQueryAnchor(messages), safeMaxTokens, temperature, stream)]
      : []),
  ];
}

function endpointPath(kind: LlmKind): string {
  return kind === "responses" ? "responses" : "chat/completions";
}

function llmEndpoint(baseUrl: string, apiType: string | undefined, endpoint: string | undefined, kind: LlmKind): string {
  const fallbackPath = endpointPath(kind);
  if (normalizeApiType(apiType, "auto") === "custom") {
    if (!(endpoint || "").trim()) throw new Error("缺少自定义 LLM 接口地址");
    return resolveCustomEndpoint(baseUrl, endpoint, fallbackPath);
  }
  return resolveCustomEndpoint(baseUrl, "", fallbackPath);
}

function extractResponseText(data: any): string {
  const direct = extractTextContent(data?.output_text ?? data?.text ?? data?.content ?? data?.reply);
  if (direct) return stripThinking(direct);

  const output = Array.isArray(data?.output)
    ? data.output
    : Array.isArray(data?.response?.output)
      ? data.response.output
      : [];
  const chunks: string[] = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      const text = extractTextContent(part?.text ?? part?.delta ?? part?.content);
      if (text) chunks.push(text);
    }
  }
  return stripThinking(chunks.join(""));
}

function extractLlmText(data: any, kind: LlmKind): string {
  return kind === "responses" ? extractResponseText(data) : extractChatText(data);
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
  apiType = "auto",
  endpoint = "",
): Promise<string> {
  const safeMaxTokens = Math.max(maxTokens || 0, 512);
  const diag = publicLlmConfig(baseUrl, model, apiType, apiKey, endpoint);
  console.log("[llm] config", diag);
  let lastErr = "LLM failed";

  for (const kind of llmKinds(apiType, messages)) {
    const variants = payloadVariants(kind, model, messages, safeMaxTokens, temperature, false);
    for (let i = 0; i < variants.length; i++) {
      const payload = variants[i];
      console.log("[llm] request", kind, model, "tokens=", safeMaxTokens, kind === "responses" ? `tool=${(payload.tools as any)?.[0]?.type}` : "");
      const first = await fetchLlmEndpointWithTransientRetry(llmEndpoint(baseUrl, apiType, endpoint, kind), apiKey, endpointPath(kind), payload, diag);
      const res = first.res;
      if (!res.ok) {
        lastErr = formatLlmFailure(res.status, first.errText);
        console.log("[llm] fail", kind, res.status, lastErr);
        if (i < variants.length - 1 && (res.status === 400 || isNoUserQueryError(lastErr))) continue;
        throw new Error(lastErr);
      }

      const data = (await res.json()) as any;
      const text = cleanAssistantReply(extractLlmText(data, kind), messages);
      if (text) return text;

      // The body of a 200 that yielded no text stays in the log only: with a
      // wrong endpoint it is whatever that URL returned, not a provider reply.
      const preview = JSON.stringify(kind === "chat" ? (data?.choices?.[0] || data) : (data?.output || data)).slice(0, 400);
      const finish = data?.choices?.[0]?.finish_reason;
      const hint = kind === "chat" && looksLikeQwenThinkingModel(model)
        ? " 这很像 Qwen3 思考模式：答案在 reasoning_content，且 max_tokens 被思考占满。已尝试关闭 thinking；可再把最大回复长度调到 512+，或换非 thinking 模型。"
        : "";
      lastErr = kind === "chat"
        ? `LLM returned empty content (finish_reason=${finish || "unknown"}).${hint} 若反复出现，请检查 Base URL / 接口地址是否指向真正的模型接口。`
        : `LLM returned empty content (responses). 若反复出现，请检查 Base URL / 接口地址是否指向真正的模型接口。`;
      console.log("[llm] empty", kind, preview);
    }
    break;
  }
  throw new Error(lastErr);
}

const FUNCTION_TOOLS: Array<Record<string, unknown>> = [
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

const TOOL_LABELS: Record<string, string> = {
  web_search: "联网搜索",
  get_weather: "天气",
  get_current_time: "时间",
  calculate: "计算器",
  create_reminder: "提醒",
};

function shouldUseFunctionTools(text: string): boolean {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return false;
  if (/提醒|闹钟|到时叫我|记得叫我|分钟后|小时后/.test(value)) return true;
  if (/几点|现在时间|当前时间|日期|几号|星期几|今天星期/.test(value)) return true;
  if (/计算|算一下|等于多少|[0-9][0-9\s.+\-*/%^()]{2,}/.test(value)) return true;
  return false;
}

function parseToolArguments(raw: unknown): Record<string, any> {
  if (raw && typeof raw === "object") return raw as Record<string, any>;
  const text = String(raw || "").trim();
  if (!text) return {};
  try { return JSON.parse(text) as Record<string, any>; } catch { return {}; }
}

function normalizeToolCalls(message: any): FunctionToolCall[] {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return calls.slice(0, 8).map((call: any, index: number) => ({
    id: String(call?.id || `call_${Date.now()}_${index}`),
    type: "function" as const,
    function: {
      name: String(call?.function?.name || "").trim(),
      arguments: typeof call?.function?.arguments === "string" ? call.function.arguments : JSON.stringify(call?.function?.arguments || {}),
    },
  })).filter((call: FunctionToolCall) => call.function.name);
}

function safeCalculateExpression(expression: unknown): { expression: string; result: number } {
  const value = String(expression || "").trim().slice(0, 200);
  if (!value || !/^[0-9+\-*/%^().\s]+$/.test(value)) throw new Error("表达式只能包含数字、基础运算符和括号");
  const normalized = value.replace(/\^/g, "**");
  const result = Function(`"use strict"; return (${normalized});`)();
  if (typeof result !== "number" || !Number.isFinite(result)) throw new Error("计算结果不是有限数字");
  return { expression: value, result };
}

function normalizeTimeZone(value: unknown, fallback = "Asia/Hong_Kong"): string {
  const candidate = String(value || fallback || "Asia/Hong_Kong").trim();
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return fallback || "Asia/Hong_Kong";
  }
}

function currentTimeResult(timeZone: unknown): { iso: string; timeZone: string; local: string } {
  const zone = normalizeTimeZone(timeZone);
  const now = new Date();
  return {
    iso: now.toISOString(),
    timeZone: zone,
    local: new Intl.DateTimeFormat("zh-CN", { timeZone: zone, dateStyle: "full", timeStyle: "long", hour12: false }).format(now),
  };
}

type ToolExecution = {
  content: Record<string, unknown>;
  webSearch?: Record<string, unknown>;
  action?: Record<string, unknown>;
};

async function executeFunctionTool(cfg: ReturnType<typeof resolveProviders>, call: FunctionToolCall): Promise<ToolExecution> {
  const name = call.function.name;
  const args = parseToolArguments(call.function.arguments);
  if (name === "web_search") {
    if (!cfg.webSearchEnabled) return { content: { ok: false, error: "用户已关闭联网搜索" } };
    const query = String(args.query || "").trim().slice(0, 160);
    const search = await runWebSearch({ query, provider: cfg.searchProvider, apiKey: cfg.searchApiKey, baseUrl: cfg.searchBaseUrl });
    return {
      content: { ok: search.ok, provider: search.provider, query: search.query, items: search.items.slice(0, 6), error: search.error || "" },
      webSearch: { used: true, explicit: true, provider: search.provider, ok: search.ok, count: search.items.length, error: search.error || "", titles: search.items.slice(0, 3).map((item) => item.title) },
    };
  }
  if (name === "get_weather") {
    if (!cfg.webSearchEnabled) return { content: { ok: false, error: "用户已关闭联网搜索" } };
    const location = String(args.location || "").trim().slice(0, 80);
    const date = String(args.date || "").trim().slice(0, 40);
    const search = await runWebSearch({ query: `${location} ${date} 天气`.trim(), provider: "weather", apiKey: cfg.searchApiKey, baseUrl: cfg.searchBaseUrl });
    return {
      content: { ok: search.ok, location, date, items: search.items.slice(0, 4), error: search.error || "" },
      webSearch: { used: true, explicit: true, provider: search.provider, ok: search.ok, count: search.items.length, error: search.error || "", titles: search.items.slice(0, 3).map((item) => item.title) },
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

async function fetchChatToolStep(
  cfg: ReturnType<typeof resolveProviders>,
  messages: ChatMessage[],
): Promise<{ message: any; text: string; toolCalls: FunctionToolCall[] }> {
  const safeMaxTokens = Math.max(cfg.maxTokens || 0, 512);
  const diag = publicLlmConfig(cfg.llm.baseUrl, cfg.llm.model, cfg.llm.apiType, cfg.llm.apiKey, cfg.llm.endpoint);
  const variants = payloadVariants("chat", cfg.llm.model, messages, safeMaxTokens, cfg.temperature, false)
    .map((payload) => ({ ...payload, tools: FUNCTION_TOOLS, tool_choice: "auto" }));
  let lastErr = "LLM tool call failed";
  for (let index = 0; index < variants.length; index++) {
    const first = await fetchLlmEndpointWithTransientRetry(
      llmEndpoint(cfg.llm.baseUrl, cfg.llm.apiType, cfg.llm.endpoint, "chat"),
      cfg.llm.apiKey,
      "chat/completions",
      variants[index],
      diag,
      15000,
    );
    if (!first.res.ok) {
      lastErr = formatLlmFailure(first.res.status, first.errText);
      if (index < variants.length - 1 && (first.res.status === 400 || isNoUserQueryError(lastErr))) continue;
      throw new Error(lastErr);
    }
    const data = await first.res.json() as any;
    const message = data?.choices?.[0]?.message || {};
    return { message, text: extractTextContent(message.content), toolCalls: normalizeToolCalls(message) };
  }
  throw new Error(lastErr);
}

async function chatCompletionsWithTools(
  cfg: ReturnType<typeof resolveProviders>,
  messages: ChatMessage[],
): Promise<{ reply: string; toolActions: Record<string, unknown>[]; toolUsage: string[]; webSearch: Record<string, unknown> | null }> {
  const working: ChatMessage[] = [...messages];
  const toolActions: Record<string, unknown>[] = [];
  const toolUsage: string[] = [];
  let webSearch: Record<string, unknown> | null = null;
  for (let round = 0; round < 4; round++) {
    const step = await fetchChatToolStep(cfg, working);
    if (!step.toolCalls.length) {
      const reply = cleanAssistantReply(step.text, messages);
      if (!reply) throw new Error("模型完成工具调用后没有返回文字");
      return { reply, toolActions, toolUsage, webSearch };
    }
    working.push({ role: "assistant", content: step.message.content || "", tool_calls: step.toolCalls });
    for (const call of step.toolCalls) {
      let result: ToolExecution;
      try {
        result = await executeFunctionTool(cfg, call);
      } catch (err: any) {
        result = { content: { ok: false, error: String(err?.message || err) } };
      }
      toolUsage.push(TOOL_LABELS[call.function.name] || call.function.name);
      if (result.action) toolActions.push(result.action);
      if (result.webSearch) webSearch = result.webSearch;
      working.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: JSON.stringify(result.content) });
    }
  }
  const reply = await chatCompletions(
    cfg.llm.baseUrl,
    cfg.llm.apiKey,
    cfg.llm.model,
    working,
    cfg.maxTokens,
    cfg.temperature,
    cfg.llm.apiType,
    cfg.llm.endpoint,
  );
  return { reply, toolActions, toolUsage, webSearch };
}

function extractStreamDelta(data: any, kind: LlmKind, eventName = ""): string {
  if (!data || typeof data !== "object") return "";
  if (data.error) throw new Error(String(data.error.message || data.error || "LLM stream error"));
  const type = String(data.type || eventName || "");
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
  if (Array.isArray(content)) return content.map((part) => typeof part === "string" ? part : (part?.text || part?.content || "")).join("");
  return "";
}

function parseSseBlock(block: string): { eventName: string; dataText: string } {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const rawLine of String(block || "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) eventName = line.slice(6).trim() || "message";
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    else if (line.trimStart().startsWith("{")) dataLines.push(line.trim());
  }
  return { eventName, dataText: dataLines.join("\n").trim() };
}

function readStreamChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("LLM stream timeout waiting for output")), timeoutMs);
    reader.read().then(
      (result) => { clearTimeout(timer); resolve(result); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function fetchLlmStreamOnce(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readLlmStreamResponse(res: Response, kind: LlmKind, onDelta: (text: string) => void): Promise<string> {
  if (!res.body) {
    const data = (await res.json().catch(() => null)) as any;
    const text = extractLlmText(data, kind);
    if (text) onDelta(text);
    return text;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  let reply = "";
  const applyDelta = (delta: string, cumulative = false) => {
    const merged = mergeStreamText(reply, delta, cumulative);
    reply = merged.reply;
    if (merged.delta) onDelta(merged.delta);
  };
  const handleBlock = (block: string) => {
    const { eventName, dataText } = parseSseBlock(block);
    if (!dataText || dataText === "[DONE]") return;
    try {
      const data = JSON.parse(dataText) as any;
      const choice = data?.choices?.[0] || {};
      const cumulative = kind === "chat" && Boolean(choice.message) && !choice.delta;
      applyDelta(extractStreamDelta(data, kind, eventName), cumulative);
      if (/response\.completed/i.test(String(data?.type || eventName || "")) && !reply) {
        applyDelta(extractResponseText(data.response || data));
      }
    } catch (err) {
      if (dataText.startsWith("{")) throw err;
      applyDelta(dataText);
    }
  };
  while (true) {
    const { done, value } = await readStreamChunkWithTimeout(reader, reply ? 20000 : 15000);
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    raw = (raw + chunk).slice(-1024 * 1024);
    buffer += chunk.replace(/\r\n/g, "\n");
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      handleBlock(block);
    }
  }
  const tail = decoder.decode();
  if (tail) buffer += tail;
  if (buffer.trim()) handleBlock(buffer);
  if (!reply && raw.trim()) {
    try {
      const data = JSON.parse(raw.trim()) as any;
      applyDelta(extractLlmText(data, kind));
    } catch {}
  }
  return reply.trim();
}

async function streamChatCompletions(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
  apiType: string,
  endpoint: string,
  onDelta: (text: string) => void,
): Promise<string> {
  const safeMaxTokens = Math.max(maxTokens || 0, 512);
  const diag = publicLlmConfig(baseUrl, model, apiType, apiKey, endpoint);
  console.log("[llm] config", diag);
  let lastErr = "LLM failed";

  for (const kind of llmKinds(apiType, messages)) {
    const variants = payloadVariants(kind, model, messages, safeMaxTokens, temperature, true);
    for (let i = 0; i < variants.length; i++) {
      const payload = variants[i];
      const endpointUrl = llmEndpoint(baseUrl, apiType, endpoint, kind);
      console.log("[llm] stream", kind, model, "tokens=", safeMaxTokens);
      let res = await fetchLlmStreamOnce(endpointUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      }, 15000);
      if (!res.ok) {
        let errText = await readError(res);
        if (isTransientAuthError(res.status, errText)) {
          console.log("[llm] transient stream auth error, retry once", { status: res.status, endpointPath: endpointPath(kind), ...diag });
          await sleep(800);
          res = await fetchLlmStreamOnce(endpointUrl, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify(payload),
          }, 15000);
          if (!res.ok) errText = await readError(res);
        }
        if (!res.ok) {
          lastErr = formatLlmFailure(res.status, errText);
          console.log("[llm] stream fail", kind, res.status, lastErr);
          if (i < variants.length - 1 && (res.status === 400 || isNoUserQueryError(lastErr))) continue;
          throw new Error(lastErr);
        }
      }
      try {
        const text = cleanAssistantReply(await readLlmStreamResponse(res, kind, onDelta), messages);
        if (text) return text;
      } catch (err: any) {
        if (err?.partial) err.partial = cleanAssistantReply(err.partial, messages);
        throw err;
      }
      lastErr = `LLM stream returned empty content (${kind})`;
    }
    break;
  }
  throw new Error(lastErr);
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
  endpointUrl: string,
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

  const res = await fetch(endpointUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const rawText = await res.text();
  let raw: any = rawText;
  try { raw = JSON.parse(rawText); } catch {}

  if (!res.ok) {
    return { text: "", raw, status: res.status, error: summarizeUpstreamError(res.status, res.statusText, res.headers.get("content-type"), rawText) };
  }

  return { text: pickTranscript(raw), raw, status: res.status };
}

async function transcribe(
  baseUrl: string,
  apiKey: string,
  model: string,
  file: File,
  apiType = "auto",
  endpoint = "",
): Promise<string> {
  const isCustom = normalizeApiType(apiType, "auto") === "custom";
  if (isCustom && !endpoint.trim()) throw new Error("缺少自定义语音识别接口地址");
  const endpointUrl = resolveCustomEndpoint(baseUrl, isCustom ? endpoint : "", "audio/transcriptions");
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
      const result = await transcribeOnce(endpointUrl, apiKey, m, file, withLanguage);
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
  throw new Error(`语音识别没有返回文字. attempts=${preview}`);
}
function isMimoTts(baseUrl: string, model: string, apiType = "auto"): boolean {
  const normalized = normalizeApiType(apiType);
  if (normalized === "xiaomi-mimo") return true;
  if (normalized === "openai-speech" || normalized === "custom") return false;
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    // ignore invalid URL; normal validation will report it later
  }
  return host.includes("xiaomimimo.com") || /^mimo-v\d/i.test(model || "");
}

function normalizeMimoVoice(voice: string): string {
  const v = (voice || "").trim();
  if (!v || v === "alloy" || v === "default") return "mimo_default";
  return v;
}

function base64ToBytes(data: unknown): Uint8Array | null {
  const raw = String(data || "").replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
  if (!raw) return null;
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function synthesizeMimo(
  baseUrl: string,
  apiKey: string,
  model: string,
  voice: string,
  input: string,
): Promise<Response> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "assistant", content: input }],
      audio: { format: "wav", voice: normalizeMimoVoice(voice) },
    }),
  });

  if (!res.ok) {
    throw new Error(await readError(res));
  }

  const data = await res.json() as any;
  const audioData = data?.choices?.[0]?.message?.audio?.data || data?.audio?.data || data?.data;
  const bytes = base64ToBytes(audioData);
  if (!bytes?.length) throw new Error("小米 MiMo TTS 没有返回音频数据");
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": "audio/wav",
      "cache-control": "no-store",
    },
  });
}

async function synthesizeOpenAiSpeech(
  baseUrl: string,
  apiKey: string,
  model: string,
  voice: string,
  input: string,
  endpoint = "",
): Promise<Response> {
  const res = await fetch(resolveCustomEndpoint(baseUrl, endpoint, "audio/speech"), {
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
    throw new Error(await readError(res));
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

async function synthesize(
  baseUrl: string,
  apiKey: string,
  model: string,
  voice: string,
  input: string,
  apiType = "auto",
  endpoint = "",
): Promise<Response> {
  if (isMimoTts(baseUrl, model, apiType)) return synthesizeMimo(baseUrl, apiKey, model, voice, input);
  const isCustom = normalizeApiType(apiType, "auto") === "custom";
  if (isCustom && !endpoint.trim()) throw new Error("缺少自定义 TTS 接口地址");
  return synthesizeOpenAiSpeech(baseUrl, apiKey, model, voice, input, isCustom ? endpoint : "");
}

function parseClientConfig(raw: unknown): ClientConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  return raw as ClientConfig;
}

function directSearchReply(search: any): string {
  if (!search?.ok || !Array.isArray(search.items) || !search.items.length) return "";
  if (search.provider === "weather") {
    const place = String(search.query || "").trim();
    const first = search.items[0];
    return `${place || "天气"}查到了：${first.snippet}`;
  }
  return "";
}

function extractWeatherTiming(query: string): string {
  return String(query || "").match(/后天|明天|今天|今日/)?.[0] || "";
}

function isClearlyNotWeatherLocation(rawText: string, location: string): boolean {
  const raw = String(rawText || "").replace(/\s+/g, " ").trim();
  const value = String(location || "").trim();
  const text = `${raw} ${value}`;
  if (/^(这里|那里|这边|那边|本地|附近|谢谢|多谢|好的|好啦|知道了|明白了|不用了|不用|算了|可以|行吧|行了|为什么|怎么了|是吗|真的|没事|没问题)$/.test(value)) return true;
  if (/^(我|我们|咱|咱们|你|你们|他|他们|她|她们|它|它们)/.test(value)) return true;
  if (/(聊天|聊聊|闲聊|说话|讲故事|故事|笑话|解闷|陪我|解释|翻译|总结|代码|图片|照片|语音|音乐|播放|打开|关闭|设置|提醒|闹钟|教我|学习|继续|停止|开始)/.test(text)) return true;
  if (/(为什么|怎么|如何|能不能|可不可以|要不要|需要|想要|我要|帮我|麻烦|请你)/.test(text)) return true;
  return false;
}

function isLikelyWeatherFollowupLocation(rawText: string, location: string): boolean {
  const raw = String(rawText || "").replace(/\s+/g, " ").trim();
  const value = String(location || "").trim();
  if (!raw || raw.length > 30 || value.length < 2) return false;
  if (isClearlyNotWeatherLocation(rawText, value)) return false;
  if (!/^[\p{Script=Han}A-Za-z·\-\s]+$/u.test(value)) return false;
  return true;
}

function contextualSearchIntent(messages: ChatMessage[]): string {
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

function looksLikeNoWebReply(text: string): boolean {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return false;
  return /(不能|无法|没有|未能).{0,10}(联网|上网|搜索|实时|查询|访问互联网)|没有.{0,10}(实时|联网|最新).{0,10}(数据|信息|能力)|不确定.{0,16}(天气|价格|新闻|当前|现在|实时|最新)|无法.{0,16}(获取|查询|访问).{0,16}(天气|实时|最新|网络|互联网)|作为(一个)?(AI|人工智能).{0,20}(不能|无法).{0,10}(联网|访问互联网|获取实时)/i.test(s);
}

async function fallbackServerSearchAnswer(
  cfg: ReturnType<typeof resolveProviders>,
  messages: ChatMessage[],
  userText: string,
  explicitSearch: boolean,
): Promise<{ reply: string; webSearch: Record<string, unknown> }> {
  const search = await runWebSearch({
    query: userText,
    provider: cfg.searchProvider,
    apiKey: cfg.searchApiKey,
    baseUrl: cfg.searchBaseUrl,
  });
  console.log("[search:fallback]", search.provider, "ok=", search.ok, "count=", search.items?.length || 0, search.error || "");
  const webSearch = {
    used: true,
    explicit: explicitSearch,
    provider: `fallback-${search.provider}`,
    ok: search.ok,
    count: search.items.length,
    error: search.error || "",
    titles: search.items.slice(0, 3).map((x: { title: string }) => x.title),
  };
  const directReply = directSearchReply(search);
  if (directReply) return { reply: directReply, webSearch };

  const systemPrompt = `${cfg.systemPrompt}

${formatSearchContext(search)}

重要：上面就是服务端已经获取到的联网结果。请直接基于这些结果回答。不能再说“我不能联网”“没有实时联网”“无法获取实时数据”。`;
  const finalMessages = sanitizeMessages(messages, systemPrompt, cfg.maxHistoryTurns);
  const reply = await chatCompletions(
    cfg.llm.baseUrl,
    cfg.llm.apiKey,
    cfg.llm.model,
    finalMessages,
    cfg.maxTokens,
    cfg.temperature,
    cfg.llm.apiType,
    cfg.llm.endpoint,
  );
  return { reply, webSearch };
}

type PreparedChat = {
  cfg: ReturnType<typeof resolveProviders>;
  messages: ChatMessage[];
  userText: string;
  intentText: string;
  explicitSearch: boolean;
  useResponsesTools: boolean;
  useFunctionTools: boolean;
  finalMessages: ChatMessage[];
  webSearch: Record<string, unknown> | null;
  directReply: string;
};

async function prepareChat(body: ChatRequestBody, env: Env): Promise<PreparedChat | Response> {
  const clientCfg = parseClientConfig(body.config);
  const cfg = resolveProviders(env, clientCfg);
  if (!cfg.llm.apiKey) return badRequest("缺少 API Key：请在页面「本地配置」里填写", 401);
  if (!cfg.llm.baseUrl) return badRequest("缺少 LLM Base URL");

  let messages = Array.isArray(body.messages) ? body.messages : [];
  const single = (body.message || "").trim();
  if (single) messages = [...messages, { role: "user", content: single }];
  if (!messages.some((m) => m.role === "user" && extractTextContent(m.content))) return badRequest("请输入消息");

  const lastUser = [...messages].reverse().find((m) => m.role === "user" && extractTextContent(m.content));
  const userText = extractTextContent(lastUser?.content);
  const intentText = contextualSearchIntent(messages);

  let systemPrompt = cfg.systemPrompt;
  let directReply = "";
  const explicitSearch = isExplicitSearchRequest(intentText) || isExplicitSearchRequest(userText);
  const weatherIntent = isWeatherQuery(intentText);
  const realtimeIntent = isRealtimeQuery(intentText);
  const autoSearchIntent = shouldAutoSearch(intentText);
  const serverSearchIntent = realtimeIntent || explicitSearch || (Boolean(cfg.webSearchEnabled) && autoSearchIntent);
  const hasVision = messagesHaveVision(messages);
  const useResponsesTools = !hasVision && !serverSearchIntent && preferredLlmKind(cfg.llm.apiType) === "responses";
  const useFunctionTools = !serverSearchIntent && cfg.toolCallingEnabled && preferredLlmKind(cfg.llm.apiType) === "chat" && shouldUseFunctionTools(intentText);
  if (useFunctionTools) {
    const now = currentTimeResult(cfg.timeZone);
    systemPrompt = `${systemPrompt}\n\n当前用户时区：${now.timeZone}。当前日期时间：${now.local}（${now.iso}）。需要计算、时间或提醒时，请优先调用提供的函数工具，不要假装已经执行工具。`;
  }
  let webSearch: Record<string, unknown> | null = useResponsesTools
    ? { used: true, explicit: explicitSearch, provider: "responses-tools", ok: true, count: 0, error: "", titles: [] }
    : null;
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
  const wantSearch = !directReply && !useResponsesTools && !useFunctionTools && Boolean(cfg.webSearchEnabled) && (realtimeIntent || explicitSearch || autoSearchIntent);

  if (wantSearch) {
    try {
      const search = await runWebSearch({
        query: intentText,
        provider: weatherIntent ? "weather" : cfg.searchProvider,
        apiKey: cfg.searchApiKey,
        baseUrl: cfg.searchBaseUrl,
      });
      webSearch = {
        used: true,
        explicit: explicitSearch,
        provider: search.provider,
        ok: search.ok,
        count: search.items.length,
        error: search.error || "",
        titles: search.items.slice(0, 3).map((x: { title: string }) => x.title),
      };
      directReply = directSearchReply(search);
      if (!directReply && !search.ok && (realtimeIntent || explicitSearch)) {
        directReply = weatherIntent
          ? `我暂时没查到${weatherLocation || "该城市"}的可靠实时天气，不能给你编温度或降雨概率。请稍后重试。`
          : "我暂时没查到可靠的实时信息，不会凭空编造数据。请稍后重试。";
      } else if (!directReply) {
        systemPrompt = `${cfg.systemPrompt}\n\n${formatSearchContext(search)}\n\n重要：上面就是服务端已经获取到的联网结果。不能再说“我不能联网”“无法直接联网”“联网搜索没开放”，也不能补充搜索结果里没有的实时数字。`;
      }
    } catch (err: any) {
      webSearch = { used: true, explicit: explicitSearch, provider: "timeout", ok: false, count: 0, error: String(err?.message || err), titles: [] };
      if (realtimeIntent || explicitSearch) {
        directReply = weatherIntent
          ? `我暂时没查到${weatherLocation || "该城市"}的可靠实时天气，不能给你编温度或降雨概率。请稍后重试。`
          : "我暂时没查到可靠的实时信息，不会凭空编造数据。请稍后重试。";
      } else {
        systemPrompt = `${cfg.systemPrompt}\n\n【联网搜索】暂时不可用。请简要回答并明确说明无法核实；不要编造实时数据。`;
      }
    }
  }

  return {
    cfg,
    messages,
    userText,
    intentText,
    explicitSearch,
    useResponsesTools,
    useFunctionTools,
    finalMessages: sanitizeMessages(messages, systemPrompt, cfg.maxHistoryTurns),
    webSearch,
    directReply,
  };
}

async function handleChat(req: Request, env: Env): Promise<Response> {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return badRequest("Invalid JSON body");
  }

  const prepared = await prepareChat(body, env);
  if (prepared instanceof Response) return prepared;
  if (prepared.directReply) {
    return json({ ok: true, reply: prepared.directReply, model: prepared.cfg.llm.model, ttsEnabled: prepared.cfg.ttsEnabled, webSearch: prepared.webSearch });
  }
  if (prepared.useFunctionTools) {
    const result = await chatCompletionsWithTools(prepared.cfg, prepared.finalMessages);
    return json({ ok: true, reply: result.reply, model: prepared.cfg.llm.model, ttsEnabled: prepared.cfg.ttsEnabled, webSearch: result.webSearch, toolActions: result.toolActions, toolUsage: result.toolUsage });
  }
  const reply = await chatCompletions(
    prepared.cfg.llm.baseUrl,
    prepared.cfg.llm.apiKey,
    prepared.cfg.llm.model,
    prepared.finalMessages,
    prepared.cfg.maxTokens,
    prepared.cfg.temperature,
    prepared.cfg.llm.apiType,
    prepared.cfg.llm.endpoint,
  );
  if (prepared.useResponsesTools && shouldAutoSearch(prepared.intentText) && looksLikeNoWebReply(reply)) {
    const fallback = await fallbackServerSearchAnswer(prepared.cfg, prepared.messages, prepared.intentText, prepared.explicitSearch);
    return json({ ok: true, reply: fallback.reply, model: prepared.cfg.llm.model, ttsEnabled: prepared.cfg.ttsEnabled, webSearch: fallback.webSearch });
  }

  return json({ ok: true, reply, model: prepared.cfg.llm.model, ttsEnabled: prepared.cfg.ttsEnabled, webSearch: prepared.webSearch });
}

function encodeSse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleChatStream(req: Request, env: Env): Promise<Response> {
  let body: ChatRequestBody;
  try {
    body = (await req.json()) as ChatRequestBody;
  } catch {
    return badRequest("Invalid JSON body");
  }

  const prepared = await prepareChat(body, env);
  if (prepared instanceof Response) return prepared;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let reply = "";
      let doneWebSearch = prepared.webSearch;
      let doneToolActions: Record<string, unknown>[] = [];
      let doneToolUsage: string[] = [];
      try {
        controller.enqueue(encodeSse("ready", { ok: true }));
        if (prepared.directReply) {
          reply = prepared.directReply;
          controller.enqueue(encodeSse("delta", { text: reply }));
        } else if (prepared.useFunctionTools) {
          const result = await chatCompletionsWithTools(prepared.cfg, prepared.finalMessages);
          reply = result.reply;
          doneWebSearch = result.webSearch;
          doneToolActions = result.toolActions;
          doneToolUsage = result.toolUsage;
          controller.enqueue(encodeSse("delta", { text: reply }));
        } else if (prepared.useResponsesTools && shouldAutoSearch(prepared.intentText)) {
          reply = await chatCompletions(
            prepared.cfg.llm.baseUrl,
            prepared.cfg.llm.apiKey,
            prepared.cfg.llm.model,
            prepared.finalMessages,
            prepared.cfg.maxTokens,
            prepared.cfg.temperature,
            prepared.cfg.llm.apiType,
            prepared.cfg.llm.endpoint,
          );
          if (looksLikeNoWebReply(reply)) {
            const fallback = await fallbackServerSearchAnswer(prepared.cfg, prepared.messages, prepared.intentText, prepared.explicitSearch);
            reply = fallback.reply;
            doneWebSearch = fallback.webSearch;
          }
          controller.enqueue(encodeSse("delta", { text: reply }));
        } else if (messagesHaveVision(prepared.finalMessages)) {
          reply = await chatCompletions(
            prepared.cfg.llm.baseUrl,
            prepared.cfg.llm.apiKey,
            prepared.cfg.llm.model,
            prepared.finalMessages,
            prepared.cfg.maxTokens,
            prepared.cfg.temperature,
            prepared.cfg.llm.apiType,
            prepared.cfg.llm.endpoint,
          );
          controller.enqueue(encodeSse("delta", { text: reply }));
        } else {
          reply = await streamChatCompletions(
            prepared.cfg.llm.baseUrl,
            prepared.cfg.llm.apiKey,
            prepared.cfg.llm.model,
            prepared.finalMessages,
            prepared.cfg.maxTokens,
            prepared.cfg.temperature,
            prepared.cfg.llm.apiType,
            prepared.cfg.llm.endpoint,
            (text) => {
              reply += text;
              controller.enqueue(encodeSse("delta", { text }));
            },
          );
        }
        controller.enqueue(encodeSse("done", { ok: true, reply, model: prepared.cfg.llm.model, ttsEnabled: prepared.cfg.ttsEnabled, webSearch: doneWebSearch, toolActions: doneToolActions, toolUsage: doneToolUsage }));
      } catch (err: any) {
        controller.enqueue(encodeSse("error", { error: String(err?.message || err), partial: reply }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}



function decodeClientConfigHeader(raw: string): ClientConfig | undefined {
  const text = String(raw || "").trim();
  if (!text) return undefined;
  if (text.startsWith("{")) return JSON.parse(text) as ClientConfig;
  const bin = atob(text);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as ClientConfig;
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
    return badRequest("语音识别接口需要 multipart/form-data");
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
    return badRequest("缺少语音识别 API Key：请在本地配置中填写", 401);
  }
  if (!cfg.stt.baseUrl) {
    return badRequest("缺少语音识别 Base URL");
  }

  try {
    const text = await transcribe(cfg.stt.baseUrl, cfg.stt.apiKey, cfg.stt.model, file, cfg.stt.apiType, cfg.stt.endpoint);
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
  if (!cfg.tts.baseUrl) {
    return json({ ok: false, error: "缺少 TTS Base URL", tts: { baseUrl: cfg.tts.baseUrl, model: cfg.tts.model, voice: cfg.tts.voice, apiType: cfg.tts.apiType, endpoint: cfg.tts.endpoint, hasKey: Boolean(cfg.tts.apiKey) } }, 400);
  }
  if (!cfg.tts.model) {
    return json({ ok: false, error: "缺少 TTS Model", tts: { baseUrl: cfg.tts.baseUrl, model: cfg.tts.model, voice: cfg.tts.voice, apiType: cfg.tts.apiType, endpoint: cfg.tts.endpoint, hasKey: Boolean(cfg.tts.apiKey) } }, 400);
  }
  if (!cfg.tts.apiKey) {
    return json({ ok: false, error: "缺少 TTS API Key：请在本地配置中填写", tts: { baseUrl: cfg.tts.baseUrl, model: cfg.tts.model, voice: cfg.tts.voice, apiType: cfg.tts.apiType, endpoint: cfg.tts.endpoint, hasKey: false } }, 401);
  }

  try {
    return await synthesize(cfg.tts.baseUrl, cfg.tts.apiKey, cfg.tts.model, cfg.tts.voice, text.slice(0, 800), cfg.tts.apiType, cfg.tts.endpoint);
  } catch (err: any) {
    const message = String(err?.message || err || "").trim();
    return json({
      ok: false,
      error: message ? `TTS 请求失败：${message}` : "TTS 请求失败",
      tts: { baseUrl: cfg.tts.baseUrl, model: cfg.tts.model, voice: cfg.tts.voice, apiType: cfg.tts.apiType, endpoint: cfg.tts.endpoint, hasKey: true },
    }, 502);
  }
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
    llm: { baseUrl: cfg.llm.baseUrl, model: cfg.llm.model, apiType: cfg.llm.apiType, endpoint: cfg.llm.endpoint, hasKey: Boolean(cfg.llm.apiKey) },
    stt: { baseUrl: cfg.stt.baseUrl, model: cfg.stt.model, apiType: cfg.stt.apiType, endpoint: cfg.stt.endpoint, hasKey: Boolean(cfg.stt.apiKey) },
    tts: { baseUrl: cfg.tts.baseUrl, model: cfg.tts.model, voice: cfg.tts.voice, apiType: cfg.tts.apiType, endpoint: cfg.tts.endpoint, hasKey: Boolean(cfg.tts.apiKey) },
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
      cfg.llm.apiType,
      cfg.llm.endpoint,
    );
    result.llmTest = { ok: true, reply };
  } catch (err: any) {
    return json({ ...result, ok: false, llmTest: { ok: false, error: String(err?.message || err) } }, 502);
  }

  return json(result);
}

// The API proxies to whatever Base URL / endpoint the browser sends, so it must
// never be callable from another site. The page is served from this same origin,
// so a cross-origin Origin header only ever means someone else's page is driving
// the proxy. No CORS headers are emitted anywhere, by design.
function crossOriginRefusal(request: Request, url: URL): string {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return "";
  let originHost = "";
  try { originHost = new URL(origin).host; } catch { return `拒绝请求：无法解析的 Origin "${origin}"。`; }
  if (originHost !== url.host) return `拒绝跨站请求：Origin "${origin}" 与本服务 "${url.host}" 不同源。`;
  return "";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/")) {
        const refusal = crossOriginRefusal(request, url);
        if (refusal) return json({ ok: false, error: refusal }, 403);
      }

      if (url.pathname === "/api/health") {
        return json({ ok: true, service: "ai-voice-call", time: new Date().toISOString() });
      }

      if (url.pathname === "/api/defaults" && request.method === "GET") {
        return json(publicConfig(env));
      }

      if (url.pathname === "/api/chat/stream" && request.method === "POST") {
        return await handleChatStream(request, env);
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

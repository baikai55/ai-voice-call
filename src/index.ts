/**
 * AI语音通话 - Cloudflare Worker
 * - Local browser config (import/export) preferred
 * - Server secrets only as fallback
 * - Never log API keys
 */

import { formatSearchContext, isExplicitSearchRequest, runWebSearch, shouldAutoSearch } from "./search";

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
): Promise<{ res: Response; errText: string }> {
  const doFetch = () => fetch(endpointUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

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
    .filter((m) => m && (m.role === "user" || m.role === "assistant" || m.role === "system") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

  const withoutSystem = cleaned.filter((m) => m.role !== "system");
  const keep = Math.max(2, maxTurns * 2);
  const trimmed = withoutSystem.slice(-keep);
  return [{ role: "system", content: withReplyOnlyInstruction(systemPrompt) }, ...trimmed];
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
    .filter((message) => message?.role === "system" && typeof message.content === "string")
    .flatMap((message) => {
      const prompt = message.content.trim();
      const basePrompt = prompt.replace(REPLY_ONLY_INSTRUCTION, "").trim();
      return [prompt, basePrompt];
    })
    .filter((prompt) => prompt.length >= 12)
    .sort((a, b) => b.length - a.length);
  for (const prompt of new Set(systemPrompts)) cleaned = cleaned.split(prompt).join("\n");

  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  const userText = String(lastUser?.content || "").trim();
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

function llmKinds(apiType = "auto"): LlmKind[] {
  return [preferredLlmKind(apiType)];
}

function shouldFallbackToResponses(apiType: string | undefined, status: number): boolean {
  return false;
}

function splitSystemMessages(messages: ChatMessage[]): { instructions: string; input: ChatMessage[] } {
  const list = Array.isArray(messages) ? messages : [];
  const instructions = list
    .filter((m) => m.role === "system")
    .map((m) => m.content)
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
      thinking_budget: 0,
      chat_template_kwargs: { enable_thinking: false },
    }),
    buildChatPayload(model, messages, safeMaxTokens, temperature, stream),
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

  for (const kind of llmKinds(apiType)) {
    let fallbackToNextKind = false;
    const variants = payloadVariants(kind, model, messages, safeMaxTokens, temperature, false);
    for (let i = 0; i < variants.length; i++) {
      const payload = variants[i];
      console.log("[llm] request", kind, model, "tokens=", safeMaxTokens, kind === "responses" ? `tool=${(payload.tools as any)?.[0]?.type}` : "");
      const first = await fetchLlmEndpointWithTransientRetry(llmEndpoint(baseUrl, apiType, endpoint, kind), apiKey, endpointPath(kind), payload, diag);
      const res = first.res;
      if (!res.ok) {
        lastErr = formatLlmFailure(res.status, first.errText);
        console.log("[llm] fail", kind, res.status, lastErr);
        if (kind === "chat" && shouldFallbackToResponses(apiType, res.status)) { fallbackToNextKind = true; break; }
        if (res.status === 400 && i < variants.length - 1) continue;
        throw new Error(lastErr);
      }

      const data = (await res.json()) as any;
      const text = cleanAssistantReply(extractLlmText(data, kind), messages);
      if (text) return text;

      const preview = JSON.stringify(kind === "chat" ? (data?.choices?.[0] || data) : (data?.output || data)).slice(0, 400);
      const finish = data?.choices?.[0]?.finish_reason;
      const hint = kind === "chat" && looksLikeQwenThinkingModel(model)
        ? " 这很像 Qwen3 思考模式：答案在 reasoning_content，且 max_tokens 被思考占满。已尝试关闭 thinking；可再把最大回复长度调到 512+，或换非 thinking 模型。"
        : "";
      lastErr = kind === "chat"
        ? `LLM returned empty content (finish_reason=${finish || "unknown"}).${hint} raw=${preview}`
        : `LLM returned empty content (responses). raw=${preview}`;
      console.log("[llm] empty", kind, preview);
    }
    if (fallbackToNextKind) continue;
    break;
  }
  throw new Error(lastErr);
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
    const { done, value } = await reader.read();
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

  for (const kind of llmKinds(apiType)) {
    let fallbackToNextKind = false;
    const variants = payloadVariants(kind, model, messages, safeMaxTokens, temperature, true);
    for (let i = 0; i < variants.length; i++) {
      const payload = variants[i];
      const endpointUrl = llmEndpoint(baseUrl, apiType, endpoint, kind);
      console.log("[llm] stream", kind, model, "tokens=", safeMaxTokens);
      let res = await fetch(endpointUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        let errText = await readError(res);
        if (isTransientAuthError(res.status, errText)) {
          console.log("[llm] transient stream auth error, retry once", { status: res.status, endpointPath: endpointPath(kind), ...diag });
          await sleep(800);
          res = await fetch(endpointUrl, {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!res.ok) errText = await readError(res);
        }
        if (!res.ok) {
          lastErr = formatLlmFailure(res.status, errText);
          console.log("[llm] stream fail", kind, res.status, lastErr);
          if (kind === "chat" && shouldFallbackToResponses(apiType, res.status)) { fallbackToNextKind = true; break; }
          if (res.status === 400 && i < variants.length - 1) continue;
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
    if (fallbackToNextKind) continue;
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
  explicitSearch: boolean;
  useResponsesTools: boolean;
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
  if (!messages.some((m) => m.role === "user" && m.content.trim())) return badRequest("请输入消息");

  const lastUser = [...messages].reverse().find((m) => m.role === "user" && m.content.trim());
  const userText = (lastUser?.content || "").trim();

  let systemPrompt = cfg.systemPrompt;
  let directReply = "";
  const explicitSearch = isExplicitSearchRequest(userText);
  const useResponsesTools = preferredLlmKind(cfg.llm.apiType) === "responses";
  let webSearch: Record<string, unknown> | null = useResponsesTools
    ? { used: true, explicit: explicitSearch, provider: "responses-tools", ok: true, count: 0, error: "", titles: [] }
    : null;
  const wantSearch = !useResponsesTools && shouldAutoSearch(userText) && (Boolean(cfg.webSearchEnabled) || explicitSearch);

  if (wantSearch) {
    const search = await runWebSearch({
      query: userText,
      provider: cfg.searchProvider,
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
    if (!directReply) {
      systemPrompt = `${cfg.systemPrompt}\n\n${formatSearchContext(search)}\n\n重要：上面就是服务端已经获取到的联网结果。不能再说“我不能联网”“无法直接联网”“联网搜索没开放”。`;
    }
  }

  return {
    cfg,
    messages,
    userText,
    explicitSearch,
    useResponsesTools,
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
  if (prepared.useResponsesTools && shouldAutoSearch(prepared.userText) && looksLikeNoWebReply(reply)) {
    const fallback = await fallbackServerSearchAnswer(prepared.cfg, prepared.messages, prepared.userText, prepared.explicitSearch);
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
      try {
        if (prepared.directReply) {
          reply = prepared.directReply;
          controller.enqueue(encodeSse("delta", { text: reply }));
        } else if (prepared.useResponsesTools && shouldAutoSearch(prepared.userText)) {
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
            const fallback = await fallbackServerSearchAnswer(prepared.cfg, prepared.messages, prepared.userText, prepared.explicitSearch);
            reply = fallback.reply;
            doneWebSearch = fallback.webSearch;
          }
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
        controller.enqueue(encodeSse("done", { ok: true, reply, model: prepared.cfg.llm.model, ttsEnabled: prepared.cfg.ttsEnabled, webSearch: doneWebSearch }));
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

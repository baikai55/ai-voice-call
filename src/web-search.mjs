const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const DEFAULT_TIMEOUT_MS = 8000;

/**
 * @typedef {{ title: string, snippet: string, url?: string, source?: string }} SearchItem
 * @typedef {{ ok: boolean, query: string, items: SearchItem[], provider: string, error?: string }} SearchResult
 */

/** @param {unknown} value */
export function normalizeWebSearchQuery(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** @param {unknown} value */
export function isWebSearchRefusal(value) {
  const text = cleanText(value);
  if (!text) return false;
  return /(?:^|[。！？!?]\s*)(?:(?:很?抱歉[，,\s]*)?(?:我|本助手|当前助手)|很?抱歉[，,\s]*)(?:目前|当前|暂时)?(?:无法|不能|未能|没有办法).{0,16}(?:联网|上网|访问互联网|访问网络|搜索网络|获取实时|查询实时|获取最新|查询最新|获取|查询|访问|搜索).{0,24}(?:实时|最新|当前|天气|新闻|价格|信息|数据)?/i.test(text)
    || /(?:^|[.!?]\s*)(?:sorry[,\s]*)?(?:i|this assistant)(?:'m| am)?\s+(?:cannot|can't|am unable to).{0,40}(?:browse|search|access).{0,24}(?:web|internet|real-time|latest)/i.test(text);
}

/** @param {unknown} value */
export function isWebSearchDisabledRequest(value) {
  const text = cleanText(value);
  return /(?:不要|别|不用|无需|不需要|不必|请勿|禁止).{0,8}(?:联网|上网|搜索|查询|查找|搜|查)|(?:联网|上网|搜索|查询).{0,8}(?:不要|别|不用|无需|不需要|不必)|(?:离线|不联网)(?:回答|回复|解释)?/i.test(text)
    || /\b(?:do not|don't|without)\b.{0,16}(?:browse|search|internet|web)|\boffline\b/i.test(text);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(value, max = 320) {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function abortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error(String(reason || "request aborted"));
  error.name = "AbortError";
  return error;
}

async function fetchTextWithTimeout(url, init, timeoutMs, signal, fetchImpl) {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) throw abortError(signal.reason);
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("web search timeout")), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { response, text };
  } catch (error) {
    if (signal?.aborted) throw abortError(signal.reason);
    if (controller.signal.aborted) throw abortError(controller.signal.reason || "web search timeout");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

function parseSsePayload(text) {
  const payloads = [];
  for (const block of String(text || "").split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try { payloads.push(JSON.parse(data)); } catch {}
  }
  for (let index = payloads.length - 1; index >= 0; index -= 1) {
    const payload = payloads[index];
    if (payload && (Object.hasOwn(payload, "result") || Object.hasOwn(payload, "error"))) return payload;
  }
  return payloads.at(-1) || null;
}

function parseMcpPayload(text) {
  const body = String(text || "").trim();
  if (!body) return null;
  try { return JSON.parse(body); } catch {}
  return parseSsePayload(body);
}

function itemFromObject(value) {
  if (!value || typeof value !== "object") return null;
  const title = cleanText(value.title || value.name || "搜索结果");
  const snippet = truncate(value.text || value.highlights?.join?.(" ") || value.content || value.snippet || value.description || "");
  const url = cleanText(value.url || value.link || "");
  if (!title && !snippet) return null;
  return { title: title || "搜索结果", snippet, url, source: "exa" };
}

function structuredItems(value) {
  const results = Array.isArray(value)
    ? value
    : Array.isArray(value?.results)
      ? value.results
      : Array.isArray(value?.data)
        ? value.data
        : [];
  return results.map(itemFromObject).filter(Boolean);
}

function parseExaText(text) {
  const body = String(text || "").trim();
  if (!body) return [];
  try {
    const parsed = JSON.parse(body);
    const items = structuredItems(parsed);
    if (items.length) return items;
  } catch {}

  const chunks = body.split(/\r?\n\s*---+\s*\r?\n(?=\s*Title:)/i);
  const items = [];
  for (const chunk of chunks) {
    const title = /^Title:\s*(.+)$/im.exec(chunk)?.[1] || "";
    const url = /^URL:\s*(\S+)$/im.exec(chunk)?.[1] || "";
    const detail = /^(?:Highlights|Text):\s*\r?\n?([\s\S]*)$/im.exec(chunk)?.[1] || "";
    if (!title && !detail) continue;
    items.push({
      title: cleanText(title || "搜索结果"),
      snippet: truncate(detail),
      url: cleanText(url),
      source: "exa",
    });
  }
  return items;
}

function dedupeItems(items) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const normalizedUrl = String(item.url || "").toLowerCase().replace(/#.*$/, "").replace(/\/$/, "");
    const key = normalizedUrl || `${item.title}\n${item.snippet}`.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
    if (unique.length >= 6) break;
  }
  return unique;
}

function exaItems(payload) {
  const result = payload?.result;
  const direct = structuredItems(result?.structuredContent || result);
  if (direct.length) return dedupeItems(direct);
  const items = [];
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (block?.type === "text" || typeof block?.text === "string") items.push(...parseExaText(block.text));
  }
  return dedupeItems(items);
}

/**
 * @param {{
 *   query?: unknown,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 * }} [options]
 * @returns {Promise<SearchResult>}
 */
export async function runWebSearch({
  query,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedQuery = normalizeWebSearchQuery(query);
  if (!normalizedQuery) return { ok: false, query: "", items: [], provider: "exa", error: "empty query" };
  if (typeof fetchImpl !== "function") return { ok: false, query: normalizedQuery, items: [], provider: "exa", error: "fetch unavailable" };

  try {
    const { response, text: raw } = await fetchTextWithTimeout(EXA_MCP_URL, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "web_search_exa",
          arguments: {
            query: normalizedQuery,
            numResults: 5,
            type: "auto",
            livecrawl: "fallback",
            contextMaxCharacters: 6000,
          },
        },
      }),
    }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), signal, fetchImpl);
    if (!response.ok) return { ok: false, query: normalizedQuery, items: [], provider: "exa", error: `HTTP ${response.status}: ${truncate(raw, 180)}` };
    const payload = parseMcpPayload(raw);
    if (!payload) return { ok: false, query: normalizedQuery, items: [], provider: "exa", error: "invalid MCP response" };
    if (payload.error) return { ok: false, query: normalizedQuery, items: [], provider: "exa", error: cleanText(payload.error.message || payload.error) };
    const items = exaItems(payload);
    return {
      ok: items.length > 0,
      query: normalizedQuery,
      items,
      provider: "exa",
      ...(items.length ? {} : { error: "empty search result" }),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, query: normalizedQuery, items: [], provider: "exa", error: cleanText(error?.message || error) };
  }
}

/**
 * @param {{ search?: typeof runWebSearch, maxSearches?: number }} [options]
 */
export function createWebSearchSession({ search = runWebSearch, maxSearches = 2 } = {}) {
  const cache = new Map();
  let searchCount = 0;
  return {
    async execute(options = {}) {
      const query = normalizeWebSearchQuery(options.query);
      if (!query) return { ok: false, query: "", items: [], provider: "exa", error: "empty query" };
      if (cache.has(query)) return await cache.get(query);
      if (searchCount >= maxSearches) {
        return { ok: false, query, items: [], provider: "exa", error: "本次回答最多执行两次联网搜索" };
      }
      searchCount += 1;
      const pending = Promise.resolve().then(() => search({ ...options, query }));
      cache.set(query, pending);
      return await pending;
    },
  };
}

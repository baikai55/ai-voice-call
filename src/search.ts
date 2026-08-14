// 意图判定全部来自 src/intent.mjs，本地服务也引同一份，避免两边分头修改后跑偏。
import { cleanText, extractWeatherLocation, isWeatherLookupRequest, normalizeSearchQuery } from "./intent.mjs";

export {
  contextualSearchIntentFromTexts,
  extractWeatherLocation,
  extractWeatherTiming,
  isExplicitSearchRequest,
  isLikelyWeatherFollowupLocation,
  isPlausiblePlaceName,
  isRealtimeQuery,
  isWeatherLookupRequest,
  isWeatherQuery,
  shouldAutoSearch,
  shouldUseFunctionTools,
} from "./intent.mjs";

export type SearchItem = {
  title: string;
  snippet: string;
  url?: string;
  source?: string;
};

export type SearchResult = {
  ok: boolean;
  query: string;
  items: SearchItem[];
  provider: string;
  error?: string;
};

function clean(text: string): string {
  return cleanText(text);
}

const SEARCH_TIMEOUT_MS = 7000;

function assertSafeSearchUrl(rawUrl: string): string {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("搜索接口地址无效"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("搜索接口只允许 http:// 或 https:// 地址");
  if (url.username || url.password) throw new Error("搜索接口地址不能包含用户名或密码");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) {
    throw new Error("搜索接口不能指向本机或局域网地址");
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b, c, d] = ipv4.slice(1).map(Number);
    const blocked = [a, b, c, d].some((part) => part < 0 || part > 255) || a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
    if (blocked) throw new Error("搜索接口不能指向本机、局域网或保留地址");
  }
  if (host === "::" || host === "::1" || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || /^ff/.test(host) || /^2001:db8(?::|$)/.test(host)) {
    throw new Error("搜索接口不能指向本机、局域网或保留地址");
  }
  return url.toString();
}

async function fetchWithTimeout(rawUrl: string, init: RequestInit, ms = SEARCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(assertSafeSearchUrl(rawUrl), { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function truncate(text: string, max = 180): string {
  const t = clean(text);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function pickWeatherDesc(current: any): string {
  const raw = current?.lang_zh?.[0]?.value || current?.weatherDesc?.[0]?.value || "";
  const key = String(raw).trim().toLowerCase();
  const map: Record<string, string> = { sunny: "晴", clear: "晴", "partly cloudy": "局部多云", cloudy: "多云", overcast: "阴", mist: "薄雾", fog: "雾", haze: "霾", "smoky haze": "烟霾", "light rain": "小雨", "moderate rain": "中雨", "heavy rain": "大雨" };
  return map[key] || raw;
}
async function searchWeather(query: string): Promise<SearchResult> {
  const location = extractWeatherLocation(query);
  if (!location) return { ok: false, provider: "weather", query, items: [], error: "missing location" };
  const url = `https://wttr.in/${encodeURIComponent(location)}?format=j1&lang=zh`;
  const res = await fetchWithTimeout(url, { headers: { accept: "application/json", "user-agent": "ai-voice-call/0.1" } });
  if (!res.ok) return { ok: false, provider: "weather", query: location, items: [], error: `HTTP ${res.status}` };
  const data = await res.json() as any;
  const current = data?.current_condition?.[0] || {};
  const dayIndex = /后天/.test(query) ? 2 : /明天/.test(query) ? 1 : 0;
  const dayLabel = dayIndex === 2 ? "后天" : dayIndex === 1 ? "明天" : "今日";
  const today = data?.weather?.[dayIndex] || data?.weather?.[0] || {};
  const area = data?.nearest_area?.[0]?.areaName?.[0]?.value || location;
  if (!current.temp_C && !today.maxtempC) return { ok: false, provider: "weather", query: location, items: [], error: "empty weather" };
  const desc = pickWeatherDesc(current);
  const rainChances = (today.hourly || []).map((h: any) => Number(h.chanceofrain || 0)).filter((n: number) => Number.isFinite(n));
  const maxRain = rainChances.length ? Math.max(...rainChances) : null;
  const parts: string[] = [];
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
      url: `https://wttr.in/${encodeURIComponent(location)}`,
      source: "weather",
    }],
  };
}

function decodeXml(text: string): string {
  return clean(String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'"));
}

async function searchBingRss(query: string): Promise<SearchResult> {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&format=rss`;
  const res = await fetchWithTimeout(url, {
    headers: { accept: "application/rss+xml, application/xml, text/xml", "user-agent": "Mozilla/5.0 ai-voice-call/0.1" },
  });
  if (!res.ok) return { ok: false, query, items: [], provider: "bing-rss", error: `HTTP ${res.status}` };
  const xml = await res.text();
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  const items: SearchItem[] = [];
  for (const block of blocks.slice(0, 6)) {
    const title = decodeXml(/<title>([\s\S]*?)<\/title>/i.exec(block)?.[1] || "结果");
    const snippet = decodeXml(/<description>([\s\S]*?)<\/description>/i.exec(block)?.[1] || "").replace(/<[^>]+>/g, "");
    const link = decodeXml(/<link>([\s\S]*?)<\/link>/i.exec(block)?.[1] || "");
    if (!title && !snippet) continue;
    items.push({ title: truncate(title, 80), snippet: truncate(snippet, 220), url: link, source: "bing-rss" });
  }
  return { ok: items.length > 0, query, items, provider: "bing-rss" };
}

async function searchDuckDuckGo(query: string): Promise<SearchResult> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetchWithTimeout(url, {
    headers: { accept: "application/json", "user-agent": "ai-voice-call/0.1" },
  });
  if (!res.ok) {
    return { ok: false, query, items: [], provider: "duckduckgo", error: `HTTP ${res.status}` };
  }
  const data = (await res.json()) as any;
  const items: SearchItem[] = [];

  if (data?.AbstractText) {
    items.push({
      title: clean(data.Heading || "摘要"),
      snippet: truncate(data.AbstractText, 240),
      url: data.AbstractURL || "",
      source: "duckduckgo-abstract",
    });
  }
  const related = Array.isArray(data?.RelatedTopics) ? data.RelatedTopics : [];
  for (const raw of related) {
    const topic = raw?.Topics ? null : raw;
    const list = raw?.Topics || (topic ? [topic] : []);
    for (const t of list) {
      const text = clean(t?.Text || "");
      if (!text) continue;
      items.push({
        title: truncate(text.split(" - ")[0] || text, 40),
        snippet: truncate(text, 180),
        url: t?.FirstURL || "",
        source: "duckduckgo-related",
      });
      if (items.length >= 5) break;
    }
    if (items.length >= 5) break;
  }

  return { ok: items.length > 0, query, items: items.slice(0, 5), provider: "duckduckgo" };
}

async function searchSearx(query: string, baseUrl: string): Promise<SearchResult> {
  const root = baseUrl.replace(/\/+$/, "");
  const url = `${root}/search?q=${encodeURIComponent(query)}&format=json&language=zh-CN`;
  const res = await fetchWithTimeout(url, {
    headers: { accept: "application/json", "user-agent": "ai-voice-call/0.1" },
  });
  if (!res.ok) {
    return { ok: false, query, items: [], provider: "searxng", error: `HTTP ${res.status}` };
  }
  const data = (await res.json()) as any;
  const results = Array.isArray(data?.results) ? data.results : [];
  const items: SearchItem[] = results.slice(0, 5).map((r: any) => ({
    title: clean(r.title || "结果"),
    snippet: truncate(r.content || r.snippet || "", 200),
    url: r.url || "",
    source: "searxng",
  })).filter((x: SearchItem) => x.title || x.snippet);

  return { ok: items.length > 0, query, items, provider: "searxng" };
}

async function searchTavily(query: string, apiKey: string): Promise<SearchResult> {
  const res = await fetchWithTimeout("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: "basic",
      include_answer: true,
      max_results: 5,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    return { ok: false, query, items: [], provider: "tavily", error: err.slice(0, 200) };
  }
  const data = (await res.json()) as any;
  const items: SearchItem[] = [];
  if (data?.answer) {
    items.push({ title: "综合摘要", snippet: truncate(data.answer, 260), source: "tavily-answer" });
  }
  for (const r of data?.results || []) {
    items.push({
      title: clean(r.title || "结果"),
      snippet: truncate(r.content || "", 200),
      url: r.url || "",
      source: "tavily",
    });
  }
  return { ok: items.length > 0, query, items: items.slice(0, 6), provider: "tavily" };
}

async function searchSerper(query: string, apiKey: string): Promise<SearchResult> {
  const res = await fetchWithTimeout("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ q: query, gl: "cn", hl: "zh-cn", num: 5 }),
  });
  if (!res.ok) {
    const err = await res.text();
    return { ok: false, query, items: [], provider: "serper", error: err.slice(0, 200) };
  }
  const data = (await res.json()) as any;
  const items: SearchItem[] = [];
  if (data?.answerBox?.answer || data?.answerBox?.snippet) {
    items.push({
      title: clean(data.answerBox.title || "直达答案"),
      snippet: truncate(data.answerBox.answer || data.answerBox.snippet || "", 240),
      url: data.answerBox.link || "",
      source: "serper-answer",
    });
  }
  for (const r of data?.organic || []) {
    items.push({
      title: clean(r.title || "结果"),
      snippet: truncate(r.snippet || "", 200),
      url: r.link || "",
      source: "serper",
    });
  }
  return { ok: items.length > 0, query, items: items.slice(0, 6), provider: "serper" };
}

export async function runWebSearch(opts: {
  query: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
}): Promise<SearchResult> {
  const rawQuery = String(opts.query || "");
  const query = normalizeSearchQuery(rawQuery);
  if (!query) return { ok: false, query: "", items: [], provider: "none", error: "empty query" };

  const provider = (opts.provider || "auto").toLowerCase();
  const key = (opts.apiKey || "").trim();
  const baseUrl = (opts.baseUrl || "").trim();

  const candidates: Array<() => Promise<SearchResult>> = [];
  if ((provider === "auto" || provider === "weather") && (isWeatherLookupRequest(rawQuery) || isWeatherLookupRequest(query))) candidates.push(() => searchWeather(rawQuery));

  if (provider === "tavily" && key) candidates.push(() => searchTavily(query, key));
  if (provider === "serper" && key) candidates.push(() => searchSerper(query, key));
  if (provider === "searxng") candidates.push(() => searchSearx(query, baseUrl || "https://searx.be"));
  if (provider === "bing" || provider === "bing-rss") candidates.push(() => searchBingRss(query));
  if (provider === "duckduckgo") candidates.push(() => searchDuckDuckGo(query));

  if (provider === "auto") {
    if (key) {
      // Key formats are not reliably distinguishable, so try the likely provider
      // first and fall through to the other one instead of failing on a bad guess.
      const ordered = /^tvly-/i.test(key)
        ? [() => searchTavily(query, key), () => searchSerper(query, key)]
        : [() => searchSerper(query, key), () => searchTavily(query, key)];
      candidates.push(...ordered);
    }
    candidates.push(() => searchBingRss(query));
    candidates.push(() => searchSearx(query, baseUrl || "https://searx.be"));
    candidates.push(() => searchDuckDuckGo(query));
  }

  // A configured provider that is missing its key still falls back to the free
  // ones rather than returning "no provider configured".
  if (candidates.length === 0) {
    candidates.push(() => searchBingRss(query));
    candidates.push(() => searchSearx(query, baseUrl || "https://searx.be"));
    candidates.push(() => searchDuckDuckGo(query));
  }

  // Sequential, in preference order. Racing them in parallel let a fast free
  // provider beat the user's configured (paid, higher quality) one.
  let last: SearchResult = {
    ok: false,
    query,
    items: [],
    provider: provider || "auto",
    error: "no provider responded",
  };
  for (const fn of candidates) {
    try {
      const result = await fn();
      last = result;
      if (result.ok && result.items.length) return result;
    } catch (err: any) {
      last = { ok: false, query, items: [], provider: "error", error: String(err?.message || err) };
    }
  }
  return last;
}

export function formatSearchContext(result: SearchResult): string {
  if (!result.items.length) {
    return `【联网搜索】已尝试查询“${result.query}”，但没有拿到可用结果（provider=${result.provider}${result.error ? ", " + result.error : ""}）。如果问题依赖最新信息，请直接说明暂时查不到；不要编造实时数据，也不要说“联网搜索功能没开放”。`;
  }
  const lines = result.items.map((it, i) => {
    const link = it.url ? ` 链接: ${it.url}` : "";
    return `${i + 1}. ${it.title}\n   ${it.snippet}${link}`;
  });
  return [
    `【联网搜索结果】查询: ${result.query}（来源: ${result.provider}）`,
    ...lines,
    "请优先依据以上结果，用简体中文、短句回答父母用户。不要编造具体数字；若结果不足请明确说不确定。",
  ].join("\n");
}

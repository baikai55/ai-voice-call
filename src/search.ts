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
  return String(text || "").replace(/\s+/g, " ").trim();
}

const SEARCH_TIMEOUT_MS = 7000;

async function fetchWithTimeout(url: string, init: RequestInit, ms = SEARCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function truncate(text: string, max = 180): string {
  const t = clean(text);
  return t.length > max ? `${t.slice(0, max)}…` : t;
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

export function shouldAutoSearch(userText: string): boolean {
  const q = clean(userText);
  if (!q) return false;
  if (q.length < 2) return false;
  const lower = q.toLowerCase();
  if (isExplicitSearchRequest(q)) return true;

  // An unambiguous live-data topic is enough on its own.
  if (REALTIME_KEYS.some((k) => lower.includes(k.toLowerCase()))) return true;

  // Everything below is a weak signal, so conversational turns opt out first.
  if (CHITCHAT_RE.test(q)) return false;

  if (TIME_HINT_KEYS.some((k) => lower.includes(k.toLowerCase())) && /(多少|价格|情况|怎么样|排名|结果|数据|行情|榜)/.test(q)) {
    return true;
  }

  // Third-party facts, whether or not they carry a question particle:
  // "谁得了冠军" yes, "你能帮我吗" no. A bare question particle is not enough
  // on its own — it has to be asking about something outside this conversation.
  const asksThirdPartyFact = /(哪里|哪个|哪家|谁|何时|几号|多少钱|排名|在哪|怎么去)/.test(q);
  if (/[?？]$/.test(q) || /(吗|呢|啥)/.test(q) || asksThirdPartyFact) {
    if (/^(我|我们|咱|咱们|你|你们)/.test(q)) return false;
    if (asksThirdPartyFact) return true;
  }
  return false;
}


export function isExplicitSearchRequest(userText: string): boolean {
  const q = clean(userText);
  return [/搜一下/, /搜索/, /帮我搜/, /查一下/, /查一查/, /帮我查/, /联网/, /网上/, /上网/, /百度/, /谷歌/i, /google/i].some((re) => re.test(q));
}

function stripSearchCommandWords(text: string): string {
  let q = clean(text);
  q = q.replace(/^(请|麻烦|帮我|你帮我|给我|可以帮我)?\s*(联网|上网|网上|百度|谷歌|google)?\s*(搜一下|搜索一下|搜索|查一下|查一查|查询一下|查询|查查|搜搜|看一下|看看)\s*/i, "");
  q = q.replace(/^(请|麻烦|帮我|你帮我|给我|可以帮我)?\s*(搜|查)\s*/i, "");
  q = q.replace(/^(一下|一下一下)\s*/, "");
  return clean(q).replace(/^[，,。.!！?？：:\s]+|[，,。.!！?？：:\s]+$/g, "");
}

function normalizeSearchQuery(userText: string): string {
  let q = stripSearchCommandWords(userText).slice(0, 120);
  if (!q) q = clean(userText).slice(0, 120);
  q = q.replace(/(今天|今日|明天|后天)的天[。.!！?？]*$/g, "$1的天气");
  q = q.replace(/(今天|今日|明天|后天)天[。.!！?？]*$/g, "$1天气");
  if (/天气|气温|下雨|下雪|降雨|降雪|空气质量|台风|雾霾/.test(q)) return `${q} 实时天气 天气预报 气温 降水`;
  if (/黄金|金价/.test(q)) return `${q} 今日 实时 金价 人民币 国际金价`;
  if (/白银|银价/.test(q)) return `${q} 今日 实时 银价`;
  if (/比特币|btc/i.test(q)) return `${q} 今日 实时 价格`;
  return q;
}
export function isWeatherQuery(query: string): boolean {
  return /天气|气温|下雨|下雪|降雨|降雪|空气质量|台风|雾霾|weather/i.test(String(query || ""));
}

export function isRealtimeQuery(userText: string): boolean {
  const q = clean(userText);
  if (!q) return false;
  if (isWeatherQuery(q)) return true;
  return /新闻|头条|热点|热搜|最新|实时|股价|股票行情|行情|价格|汇率|油价|金价|银价|黄金|白银|比特币|btc|eth|比分|赛程|航班|火车|高铁|路况|限行|放假|门票|影讯|开奖|疫情/i.test(q);
}
function normalizeWeatherSpeech(text: string): string {
  return clean(text)
    .replace(/(今天|今日|明天|后天)的天[。.!！?？]*$/g, "$1的天气")
    .replace(/(今天|今日|明天|后天)天[。.!！?？]*$/g, "$1天气");
}
export function extractWeatherLocation(query: string): string {
  let q = normalizeWeatherSpeech(stripSearchCommandWords(query));
  q = q.replace(/(今天|今日|明天|后天|现在|当前|实时|最近|这会儿|此刻)/g, "");
  q = q.replace(/(的)?(天气预报|天气|气温|温度|下雨吗|会下雨吗|下雨|下雪吗|会下雪吗|下雪|降雨|降雪|空气质量|台风|雾霾|预报)/g, "");
  q = q.replace(/(怎么样|如何|怎样|多少|几度|有雨吗|冷不冷|热不热)/g, "");
  q = q.replace(/[，,。.!！?？：:\s]/g, "").replace(/(?:呢|呀|啊|吧|嘛|吗|么)+$/g, "").trim();
  q = q.replace(/^(嗯|哦|噢|喔|啊|额|呃|那|那么|还有|再查查|再看看|查查|看看|查|搜|搜搜|换成|改成|换|到|去)+/g, "").trim();
  return q.slice(0, 40);
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
  if ((provider === "auto" || provider === "weather") && (isWeatherQuery(rawQuery) || isWeatherQuery(query))) candidates.push(() => searchWeather(rawQuery));

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

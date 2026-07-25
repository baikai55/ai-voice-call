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

export function shouldAutoSearch(userText: string): boolean {
  const q = clean(userText);
  if (!q) return false;
  if (q.length < 2) return false;

  const keys = [
    "天气", "气温", "下雨", "下雪", "新闻", "头条", "今天", "今日", "现在", "最新",
    "股价", "油价", "房价", "汇率", "黄金", "比分", "赛程", "几点", "日期", "放假",
    "开奖", "疫情", "航班", "火车", "高铁", "路况", "限行", "查询", "搜索", "搜一下",
    "什么情况", "怎么样了", "热点", "热搜", "谁赢了", "多少钱",
    "weather", "news", "today", "price", "stock",
  ];
  if (keys.some((k) => q.includes(k))) return true;

  // question-like
  if (/[?？]$/.test(q) || /(吗|呢|啥|多少|哪里|哪个|谁|何时|几号)/.test(q)) {
    // avoid pure chitchat
    if (!/(你好|你是谁|讲个|故事|陪我|聊天|解闷)/.test(q)) return true;
  }
  return false;
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
  const query = clean(opts.query).slice(0, 120);
  if (!query) return { ok: false, query: "", items: [], provider: "none", error: "empty query" };

  const provider = (opts.provider || "auto").toLowerCase();
  const key = (opts.apiKey || "").trim();
  const baseUrl = (opts.baseUrl || "").trim();

  const candidates: Array<() => Promise<SearchResult>> = [];

  if (provider === "tavily" && key) candidates.push(() => searchTavily(query, key));
  if (provider === "serper" && key) candidates.push(() => searchSerper(query, key));
  if (provider === "searxng") candidates.push(() => searchSearx(query, baseUrl || "https://searx.be"));
  if (provider === "duckduckgo") candidates.push(() => searchDuckDuckGo(query));

  if (provider === "auto") {
    if (key) {
      // heuristic: tavily keys often start with tvly-, otherwise try serper first
      if (key.startsWith("tvly-")) candidates.push(() => searchTavily(query, key));
      else candidates.push(() => searchSerper(query, key));
    }
    candidates.push(() => searchDuckDuckGo(query));
    candidates.push(() => searchSearx(query, baseUrl || "https://searx.be"));
  }

  if (candidates.length === 0) {
    return { ok: false, query, items: [], provider: provider || "auto", error: "no provider configured" };
  }

  // Run candidates in parallel so one slow/blocked provider cannot stall the reply.
  // Resolve on the first usable result; otherwise settle with the last outcome.
  return await new Promise<SearchResult>((resolve) => {
    let pending = candidates.length;
    let last: SearchResult = {
      ok: false,
      query,
      items: [],
      provider: provider || "auto",
      error: "no provider responded",
    };
    for (const fn of candidates) {
      fn()
        .then((result) => {
          last = result;
          if (result.ok && result.items.length) resolve(result);
        })
        .catch((err: any) => {
          last = { ok: false, query, items: [], provider: "error", error: String(err?.message || err) };
        })
        .finally(() => {
          pending -= 1;
          if (pending === 0) resolve(last);
        });
    }
  });
}

export function formatSearchContext(result: SearchResult): string {
  if (!result.items.length) {
    return `【联网搜索】未找到与“${result.query}”相关的可靠结果（provider=${result.provider}${result.error ? ", " + result.error : ""}）。请基于常识谨慎回答，并说明信息可能过时。`;
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

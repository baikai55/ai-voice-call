// 意图判定的唯一实现。Worker（src/index.ts、src/search.ts）和本地服务
// （local-server.mjs）都从这里引入，避免两边各写一套后逐渐跑偏 —— 之前
// “感觉潮潮的”被当成城市名，就是因为只修了其中一边。
//
// 总原则：
// 1. 只有明确的查询信号才联网，闲聊和教学类问法一律走普通对话；
// 2. 抽出来的城市必须通过正向校验，像地名才用，不像就当没抽到；
// 3. 判断不确定时回到普通聊天或追问，绝不拿猜出来的实体去拼提示语。

export function cleanText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 明确的搜索指令
// ---------------------------------------------------------------------------

// “搜索算法”“查询语句”这类是在聊技术名词，不是让我去搜。
const SEARCH_AS_NOUN_RE =
  /^(?:搜索|查询|检索|联网|上网)(?:算法|功能|框|引擎|结果|排名|优化|技术|服务|接口|模块|流程|方式|方法|逻辑|条件|语句|语法|性能|体验|历史|记录|原理|入门|教程)/;

const NO_SEARCH_RE = /(?:不要|别|不用|无需|不想|没必要).{0,8}(?:搜|查|联网|上网)/;

export function isExplicitSearchRequest(userText) {
  const q = cleanText(userText);
  if (!q || NO_SEARCH_RE.test(q)) return false;
  const explicitCommand = /搜一下|搜索一下|查一下|查一查|查询一下|查查|搜搜|帮我搜|帮我查/.test(q);
  if (!explicitCommand && SEARCH_AS_NOUN_RE.test(q)) return false;
  return explicitCommand ||
    /^(?:请|麻烦|帮我|你帮我|给我|可以帮我|能不能帮我)?\s*(?:联网|上网|网上|百度|谷歌|google)?\s*(?:搜|查|找)(?:一下|一查|查查|搜搜)?(?:\s|[，,：:]|$)/i.test(q) ||
    /(?:请|麻烦|帮我|你帮我|给我|可以帮我).{0,8}(?:搜|查)(?:一下|一查|查查|搜搜)?/.test(q) ||
    /(?:联网|上网|网上)(?:搜|查|找)/.test(q) ||
    /(?:百度|谷歌|google)(?:一下|搜索|查)/i.test(q);
}

export function stripSearchCommandWords(text) {
  let q = cleanText(text);
  q = q.replace(/^(请|麻烦|帮我|你帮我|给我|可以帮我)?\s*(联网|上网|网上|百度|谷歌|google)?\s*(搜一下|搜索一下|搜索|查一下|查一查|查询一下|查询|查查|搜搜|看一下|看看)\s*/i, "");
  q = q.replace(/^(请|麻烦|帮我|你帮我|给我|可以帮我)?\s*(搜|查)\s*/i, "");
  q = q.replace(/^(一下|一下一下)\s*/, "");
  return cleanText(q).replace(/^[，,。.!！?？：:\s]+|[，,。.!！?？：:\s]+$/g, "");
}

// ---------------------------------------------------------------------------
// 实时话题
// ---------------------------------------------------------------------------

const LIVE_TOPIC_RE = /新闻|头条|热点|热搜|股价|股票|行情|汇率|油价|金价|黄金|白银|银价|比特币|btc|eth|比分|赛程|开奖|中奖|航班|火车|高铁|路况|限行|放假|门票|影讯|房价|疫情|票价|stock|price|news/i;
const LIVE_TEMPORAL_RE = /今天|今日|现在|当前|实时|最新|目前|刚刚|现价|报价|开盘|收盘|涨跌|比分|赛果|排名|结果|状态|延误|取消|时刻表|放假安排|进展|消息/;
const LIVE_HARD_SIGNAL_RE = /今天|今日|现在|当前|实时|最新|目前|刚刚|报价|现价|开盘|收盘|涨跌|比分|赛果|排名|结果|状态|延误|取消|时刻表|放假安排|票价|多少钱|价格|汇率|行情|热搜|头条|进展|消息/;

// “学习股票”“比特币是什么”是在问知识，不是要行情。
const EDUCATIONAL_RE = /讲个|笑话|故事|学习|学学|入门|教程|原理|什么是|是什么|区别|怎么形成|如何形成|解释|说明|写一篇|写个|改写|翻译|总结|代码|算法|变量|数据库|接口|专业|概念|历史|影响|风险|建议|定义|意思|机制|规则|怎么买|怎么用/;

// 只跟话题搭配时才算查询信号 ——“今天”单独出现也可能是“今天我有点累”。
const TIME_HINT_KEYS = ["今天", "今日", "现在", "最新", "实时", "目前", "当前", "刚刚", "最近", "本周", "本月", "今年", "几点", "日期", "today"];

// 个人化、对话式的句子一律不自动联网，哪怕带问号。
const CHITCHAT_RE =
  /(你好|您好|你是谁|你叫什么|讲个|故事|笑话|陪我|聊天|聊聊|闲聊|解闷|谢谢|再见|辛苦|心情|想你|安慰|鼓励|帮我写|帮我改|翻译|总结|解释|代码|提醒|闹钟|我想|我要|怎么办|你觉得|你认为|你能|你会|好不好|行不行|你怎么样|过得怎么样|最近怎么样)/;

export function isRealtimeQuery(userText) {
  const q = cleanText(userText);
  if (!q) return false;
  if (isWeatherQuery(q)) return isWeatherLookupRequest(q);
  if (!LIVE_TOPIC_RE.test(q)) return false;
  // 教学类问法只有同时带时间信号才算实时查询：“学习股票”不查，“今天股票行情”查。
  if (EDUCATIONAL_RE.test(q) && !LIVE_TEMPORAL_RE.test(q)) return false;
  if (LIVE_HARD_SIGNAL_RE.test(q)) return true;
  return /(怎么样|多少|价格|行情|排名|结果|状态|进展|消息|情况|预报|哪些|哪个|谁|何时|票价|时刻表|安排)/.test(q);
}

export function shouldAutoSearch(userText) {
  const q = cleanText(userText);
  if (q.length < 2) return false;
  if (isExplicitSearchRequest(q)) return true;

  // “今天几号”“现在几点”该走时间工具，不该联网 —— 之前会因为“几号”被
  // 当成第三方事实去搜索，反而把时间工具挤掉。
  if (TIME_ASK_RE.test(q) && !LIVE_TOPIC_RE.test(q)) return false;

  // 天气词在日常对话里太常见，“今天下雨了”是闲聊不是查询。
  if (isWeatherQuery(q)) return isWeatherLookupRequest(q);

  // 下面都是弱信号，所以先让对话式的句子退出。
  if (CHITCHAT_RE.test(q) && !LIVE_TEMPORAL_RE.test(q)) return false;

  if (isRealtimeQuery(q)) return true;

  if (TIME_HINT_KEYS.some((k) => q.toLowerCase().includes(k.toLowerCase())) && LIVE_TOPIC_RE.test(q) && /(多少|价格|情况|怎么样|排名|结果|数据|行情|榜)/.test(q)) {
    return true;
  }

  // 问的是对话之外的第三方事实才查：“谁得了冠军”查，“你能帮我吗”不查。
  const asksThirdPartyFact = /(哪里|哪个|哪家|谁|何时|几号|多少钱|排名|在哪|怎么去)/.test(q);
  if (/[?？]$/.test(q) || /(吗|呢|啥)/.test(q) || asksThirdPartyFact) {
    if (/^(我|我们|咱|咱们|你|你们)/.test(q)) return false;
    if (asksThirdPartyFact) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 天气
// ---------------------------------------------------------------------------

export function isWeatherQuery(query) {
  return /天气|气温|下雨|下雪|降雨|降雪|空气质量|台风|雾霾|weather/i.test(String(query || ""));
}

export function normalizeWeatherSpeech(text) {
  return cleanText(text)
    .replace(/(今天|今日|明天|后天)的天[。.!！?？]*$/g, "$1的天气")
    .replace(/(今天|今日|明天|后天)天[。.!！?？]*$/g, "$1天气");
}

// 描述天气的感受，不是在要数据。
const WEATHER_OBSERVATION_RE = /(潮潮|湿漉|闷热|凉飕飕|冻死|热死|冷死)|(感觉|觉得|好像|有点|真|太|好)(?:.{0,4})?(潮|湿|闷|冷|热|凉|干|晒)|(下雨|下雪|降温|升温|放晴|转晴)(?:了|啦)/;

export function isWeatherLookupRequest(query) {
  const q = normalizeWeatherSpeech(cleanText(query));
  if (!isWeatherQuery(q)) return false;
  if (isExplicitSearchRequest(q)) return true;
  if (/(天气预报|实时天气|最新天气|台风.{0,8}(最新|路径|预报|消息)|雨.{0,4}(什么时候|几点).{0,2}(停|下))/.test(q)) return true;
  if (/(天气|气温|温度|空气质量|台风|雾霾).{0,6}(怎么样|如何|怎样|多少|几度|什么情况|好吗|吗|么|呢)/.test(q)) return true;
  if (/(会不会|还会|会|有没有|是否).{0,6}(下雨|下雪|降雨|降雪)|(下雨|下雪|降雨|降雪).{0,4}(吗|么|没有|多久|什么时候|几点)/.test(q)) return true;

  // 上面几条都没命中，就只剩“杭州天气”这种短句了；带感受描述的直接排除。
  if (WEATHER_OBSERVATION_RE.test(q)) return false;
  const concise = q.replace(/[，,。.!！?？：:\s]/g, "");
  return concise.length <= 24 && /^(?:今天|今日|明天|后天|现在)?(?:的)?(?:[\p{Script=Han}A-Za-z·-]{1,16})?(?:天气|天气预报|气温|温度|空气质量|台风|雾霾)$/u.test(concise);
}

const WEATHER_TIME_SOURCE = [
  "今天下午", "今天晚上", "今天早上", "今天中午", "明天早上", "明天中午", "明天下午", "明天晚上",
  "大前天", "大后天", "昨天", "前天", "今天", "今日", "明天", "后天",
  "这个周末", "本周末", "周末", "未来几天", "未来一周", "未来三天", "接下来几天",
  "这几天", "这两天", "近几天", "这段时间", "最近", "本周", "这周", "下周", "本月", "这个月",
  "早上", "上午", "中午", "下午", "傍晚", "晚上", "夜里", "半夜", "白天",
  "现在", "当前", "此刻", "这会儿", "一会儿", "待会", "稍后", "实时",
].join("|");
const WEATHER_TIME_STRIP_RE = new RegExp(`(?:${WEATHER_TIME_SOURCE})`, "g");
const WEATHER_TIME_TEST_RE = new RegExp(`(?:${WEATHER_TIME_SOURCE})`);

const WEATHER_TOPIC_STRIP_RE = /(的)?(天气预报|天气情况|天气|气温|温度|下雨吗|会下雨吗|下雨|下雪吗|会下雪吗|下雪|降雨|降雪|空气质量|空气|台风|雾霾|预报|紫外线|湿度|风力|weather|forecast)/gi;
const WEATHER_ASK_STRIP_RE = /(怎么样|如何|怎样|多少度|多少|几度|有雨吗|有雨|冷不冷|热不热|好不好|适不适合|情况|指数|数据)/g;

// “这里/附近”不是能查的地名，得回头追问。
const GENERIC_PLACE_RE = /^(这里|那里|这边|那边|本地|附近|周边|家里|外面|屋里|路上|当地|我这里|我们这里|你那里|咱这里|全国|全球|世界|各地)$/;

// 减法剩下来的残渣里若还带这些词，说明剩的不是地名。后半段是多轮里常见的
// 短回应 ——“没事”“还行”“几号”都只有两个字，形状上和“北京”没区别，只能列出来挡。
const PLACE_BLOCK_RE = /(感觉|觉得|有点|好像|外面|屋里|潮潮|潮湿|湿漉|闷热|凉快|舒服|难受|适合|出门|带伞|雨伞|指数|情况|数据|消息|新闻|房价|股票|行情|路况|机票|车票|景点|美食|地铁|穿|衣服|口罩|需要|要不要|应该|能不能|为什么|怎么|如何|多少|几度|注意|提醒|告诉|知道|想问|请问|帮我|麻烦|请你|我想|想要|谢谢|多谢|再见|拜拜|好的|好啦|知道了|明白了|不用|算了|继续|停止|开始|聊天|聊聊|闲聊|说话|故事|笑话|解闷|陪我|解释|翻译|总结|代码|图片|照片|语音|音乐|播放|打开|关闭|设置|闹钟|教我|学习|没事|没问题|可以|行了|行吧|好吧|还行|挺好|不错|厉害|为啥|怎么了|是吗|真的|明白|清楚|收到|晓得|随便|无所谓|几号|几点|星期几|周几|日期|时间)/;

// 地名必须长这样才用。这是正向校验：不像地名就当没抽到，而不是把残渣发出去查。
export function isPlausiblePlaceName(value) {
  const v = cleanText(value);
  if (v.length < 2 || v.length > 15) return false;
  if (GENERIC_PLACE_RE.test(v)) return false;
  if (PLACE_BLOCK_RE.test(v)) return false;
  if (WEATHER_TIME_TEST_RE.test(v)) return false;
  if (/^(我|我们|咱|咱们|你|你们|他|他们|她|她们|它|它们)/.test(v)) return false;
  // “上海的房价”这种减完还剩一截的，地名里几乎不会带“的”。
  if (/的/.test(v)) return false;
  // “再见啦”“出来了”这类语气收尾也不是地名。
  if (/(?:了|啦|着|吧|呢|嘛|哦|呀|啊)$/.test(v)) return false;
  if (/[0-9０-９]/.test(v)) return false;
  if (/^[\p{Script=Han}]{2,12}$/u.test(v)) return true;
  if (/^[\p{Script=Han}A-Za-z·]{2,12}(?:市|省|区|县|州|镇|乡|旗|盟|岛|港|湾|自治区|自治州|特别行政区)$/u.test(v)) return true;
  if (/^[A-Za-z][A-Za-z'·\- ]{1,24}$/.test(v)) return true;
  return false;
}

export function extractWeatherLocation(query) {
  let q = normalizeWeatherSpeech(stripSearchCommandWords(query));
  q = q.replace(WEATHER_TIME_STRIP_RE, "");
  q = q.replace(WEATHER_TOPIC_STRIP_RE, "");
  q = q.replace(WEATHER_ASK_STRIP_RE, "");
  q = q.replace(/[，,。.!！?？：:\s]/g, "").replace(/(?:呢|呀|啊|吧|嘛|吗|么)+$/g, "").trim();
  q = q.replace(/^(嗯|哦|噢|喔|啊|哎|唉|额|呃|那|那么|还有|再查查|再看看|查查|看看|查|搜|搜搜|换成|改成|换|到|去)+/g, "").trim();
  // “上海热”“哈尔滨冷不冷”减完会剩个形容词尾巴。
  q = q.replace(/(?:热|冷|凉|暖|干|湿|好|差|晒)+$/g, "").trim();
  if (!q) return "";
  // 一句话里两个城市，猜哪个都可能错，交给追问。
  if (/(和|与|跟|以及|、)/.test(q)) return "";
  if (!isPlausiblePlaceName(q)) return "";
  return q.slice(0, 40);
}

export function extractWeatherTiming(query) {
  return String(query || "").match(/后天|明天|今天|今日/)?.[0] || "";
}

export function isLikelyWeatherFollowupLocation(rawText, location) {
  const raw = cleanText(rawText);
  const value = cleanText(location);
  if (!raw || raw.length > 30 || value.length < 2) return false;
  // 追问句里带这些词就不是在报城市名。
  if (/(为什么|怎么|如何|能不能|可不可以|要不要|需要|想要|我要|帮我|麻烦|请你)/.test(raw)) return false;
  return isPlausiblePlaceName(value);
}

// 只补时间的跟进句必须是“明天呢”这种纯时间追问；“今天几号啊”只是碰巧
// 带了个“今天”，不能拿它去接上一轮的城市。
const TIMING_ONLY_FOLLOWUP_RE = /^(?:那|那么|还有|再|换成|改成|换|到|去)?\s*(?:今天|今日|明天|后天|大后天|周末|这周|下周)\s*(?:的)?\s*(?:呢|吧|啊|呀)?\s*(?:天气|天气预报|气温|温度)?\s*[?？。.!！]*$/;

// 多轮里把“那北京呢”补成“北京 天气”。传入的是按顺序排列的用户发言文本。
export function contextualSearchIntentFromTexts(userTexts) {
  const texts = (Array.isArray(userTexts) ? userTexts : []).map((t) => cleanText(t)).filter(Boolean);
  const current = texts.at(-1) || "";
  if (!current) return "";
  const previousTexts = texts.slice(0, -1);
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
  if (currentTiming && TIMING_ONLY_FOLLOWUP_RE.test(current)) {
    return `${previousLocation ? `${previousLocation} ` : ""}${currentTiming} 天气`.replace(/\s+/g, " ").trim();
  }
  return current;
}

export function normalizeSearchQuery(userText) {
  let q = stripSearchCommandWords(userText).slice(0, 120);
  if (!q) q = cleanText(userText).slice(0, 120);
  // 兼容语音识别把“天气”漏成“天”的情况：例如“北京今天的天。”
  q = q.replace(/(今天|今日|明天|后天)的天[。.!！?？]*$/g, "$1的天气");
  q = q.replace(/(今天|今日|明天|后天)天[。.!！?？]*$/g, "$1天气");
  if (/天气|气温|下雨|下雪|降雨|降雪|空气质量|台风|雾霾/.test(q)) return `${q} 实时天气 天气预报 气温 降水`;
  if (/黄金|金价/.test(q)) return `${q} 今日 实时 金价 人民币 国际金价`;
  if (/白银|银价/.test(q)) return `${q} 今日 实时 银价`;
  if (/比特币|btc/i.test(q)) return `${q} 今日 实时 价格`;
  return q;
}

// ---------------------------------------------------------------------------
// 函数工具（时间 / 计算器 / 提醒）
// ---------------------------------------------------------------------------

// 名词出现 ≠ 要用工具：“计算机怎么入门”“日期格式怎么写”是在问知识。
const TOOL_TOPIC_RE = /(计算机|电脑|编程|程序|代码|算法|函数|语法|格式|入门|教程|原理|什么是|是什么|区别|定义|概念|专业|课程|学习|学学|怎么写|怎么用|怎么学|发展|历史)/;

const REMINDER_ASK_RE = /(提醒我|提醒一下|叫醒我|到时叫我|记得叫我|别忘了提醒|设(?:一个|个)?(?:闹钟|提醒)|定(?:一个|个)?(?:闹钟|提醒)|[0-9０-９一二两三四五六七八九十几半]{1,4}\s*(?:分钟|小时|天|周)后)/;
const TIME_ASK_RE = /(现在几点|几点了|现在.{0,2}时间|当前时间|今天几号|明天几号|今天是几号|今天.{0,2}(?:星期|周)几|今天是星期几|星期几了|周几了|今天.{0,3}日期|现在.{0,3}日期)/;
const CALC_ASK_RE = /(算一下|算算|计算一下|帮我算|帮忙算|等于多少|等于几|得多少|一共多少|加起来|乘以|除以|平方|开方|百分之)/;
const ARITHMETIC_RE = /[0-9０-９][0-9０-９\s.,]*[+\-*/%^×÷加减乘除][0-9０-９\s.,]*[0-9０-９]/;

export function shouldUseFunctionTools(text) {
  const value = cleanText(text);
  if (!value) return false;
  if (REMINDER_ASK_RE.test(value)) return true;
  if (TIME_ASK_RE.test(value)) return true;
  // 真的写了算式就直接用工具；只是句子里带“算/计算”字样的，先排除教学问法。
  if (ARITHMETIC_RE.test(value)) return true;
  if (CALC_ASK_RE.test(value)) return !TOOL_TOPIC_RE.test(value);
  return false;
}

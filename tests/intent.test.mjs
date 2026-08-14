// 易误判语料回归。直接测 src/intent.mjs —— Worker 和本地服务都用这一份，
// 所以这里全绿就等于两边行为一致，不会再出现“只修好一边”的情况。
import assert from "node:assert/strict";
import test from "node:test";

import {
  contextualSearchIntentFromTexts,
  extractWeatherLocation,
  isExplicitSearchRequest,
  isWeatherLookupRequest,
  shouldAutoSearch,
  shouldUseFunctionTools,
} from "../src/intent.mjs";

function check(cases, fn, expected, label) {
  const wrong = cases.filter((input) => fn(input) !== expected);
  assert.deepEqual(wrong, [], `${label} 期望 ${expected}，但这些没通过：${JSON.stringify(wrong, null, 2)}`);
}

test("闲聊和描述性的句子不联网", () => {
  check([
    "今天下雨了，感觉潮潮的",
    "哎，今天天气下雨了，感觉潮潮的。",
    "外面下雪了，好冷啊",
    "今天天气真好",
    "你最近怎么样",
    "今天过得怎么样",
    "我今天有点累",
    "陪我聊聊天吧",
    "谢谢你，辛苦了",
  ], shouldAutoSearch, false, "闲聊");
});

test("教学和名词类问法不联网", () => {
  check([
    "我想学新闻专业",
    "我想学习股票投资",
    "讲个比特币的笑话",
    "比特币的原理是什么",
    "黄金是什么元素",
    "股票是什么意思",
    "房价这个词是什么意思",
    "汇率是怎么形成的",
    "搜索算法是什么原理",
    "搜索算法怎么优化",
    "查询语句怎么写",
    "帮我翻译一句话",
  ], shouldAutoSearch, false, "教学类");
});

test("明确说了不要搜就不搜", () => {
  check([
    "别联网了，就随便聊聊",
    "不用查，你自己说说看",
    "不要搜索，直接回答",
  ], isExplicitSearchRequest, false, "拒绝联网");

  check([
    "搜索算法",
    "搜索功能怎么用",
    "查询数据库的语法",
    "联网功能是什么",
  ], isExplicitSearchRequest, false, "技术名词");

  check([
    "帮我查一下杭州天气",
    "搜一下今天的新闻",
    "百度一下杭州亚运会",
    "联网查一下油价",
  ], isExplicitSearchRequest, true, "明确指令");
});

test("真正的实时问题要联网", () => {
  check([
    "杭州天气怎么样",
    "北京今天天气",
    "上海明天会下雨吗",
    "今天黄金多少钱一克",
    "现在比特币价格多少",
    "帮我查一下今天的新闻",
    "最新的油价是多少",
    "今天股市行情怎么样",
  ], shouldAutoSearch, true, "实时查询");
});

test("天气：只有问数据才算查询", () => {
  check([
    "杭州天气怎么样",
    "北京今天的天气",
    "上海明天会下雨吗",
    "深圳今天气温多少度",
    "香港天气",
  ], isWeatherLookupRequest, true, "天气查询");

  check([
    "今天下雨了，感觉潮潮的",
    "外面下雪了，好冷啊",
    "下雨天我心情不好",
  ], isWeatherLookupRequest, false, "天气感受");
});

test("城市必须像地名才用，抽不准就当没抽到", () => {
  const shouldExtract = {
    "杭州天气怎么样": "杭州",
    "北京今天的天气": "北京",
    "北京今天的天。": "北京",
    "上海明天会下雨吗": "上海",
    "深圳今天气温多少度": "深圳",
    "深圳的空气质量指数": "深圳",
    "郑州这两天天气": "郑州",
    "北京昨天天气怎么样": "北京",
    "上海天气热吗": "上海",
    "香港天气": "香港",
    "Tokyo weather": "Tokyo",
  };
  for (const [input, expected] of Object.entries(shouldExtract)) {
    assert.equal(extractWeatherLocation(input), expected, `“${input}”应抽出 ${expected}`);
  }

  // 抽不出可信城市时返回空串，上层会追问，而不是拿残渣去查。
  check([
    "今天天气怎么样",
    "这里天气怎么样",
    "附近会下雨吗",
    "我们这里的天气",
    "杭州和上海天气",
    "外面下雨了",
    "感觉潮潮的",
    "谢谢你",
    "天气适合出门吗",
    "明天要带伞吗",
    "再见啦",
    "国庆放假安排出来了",
    "帮我算下利息",
  ], (input) => extractWeatherLocation(input), "", "无法确定城市");
});

test("问日期时间走时间工具，不该联网", () => {
  check(["今天几号", "今天几号啊", "现在几点了", "今天星期几"], shouldAutoSearch, false, "日期时间");
  check(["今天几号", "现在几点了", "今天星期几"], shouldUseFunctionTools, true, "日期时间");
  // 带上实时话题时仍然要联网。
  assert.equal(shouldAutoSearch("国庆几号放假，安排出来了吗"), true, "放假安排仍需联网");
});

test("多轮里不会把感受和客套当成新城市", () => {
  assert.equal(
    contextualSearchIntentFromTexts(["杭州天气怎么样？", "感觉潮潮的。"]),
    "感觉潮潮的。",
    "感受句应原样进普通对话",
  );
  assert.equal(
    contextualSearchIntentFromTexts(["杭州天气怎么样？", "谢谢你"]),
    "谢谢你",
    "客套话不是城市",
  );
  assert.equal(
    contextualSearchIntentFromTexts(["杭州天气怎么样？", "那北京呢"]),
    "北京 天气",
    "换城市要跟得上",
  );
  assert.equal(
    contextualSearchIntentFromTexts(["杭州天气怎么样？", "明天呢"]),
    "杭州 明天 天气",
    "只换时间要沿用上一个城市",
  );
  // 两个字的短回应和城市名形状一样，必须挡住，否则会去查“没事”的天气。
  for (const reply of ["没事", "还行", "可以", "行了", "真的", "厉害", "今天几号啊", "再见啦"]) {
    assert.equal(
      contextualSearchIntentFromTexts(["杭州天气怎么样？", reply]),
      reply,
      `“${reply}”不该被当成新城市`,
    );
  }
});

test("函数工具：名词出现不等于要调工具", () => {
  check([
    "计算机怎么入门",
    "我学过计算机",
    "日期格式怎么写",
    "算法的时间复杂度是多少",
    "闹钟坏了怎么修",
    "12345是什么意思",
    "会计专业要学什么",
  ], shouldUseFunctionTools, false, "只是提到名词");

  check([
    "现在几点了",
    "今天几号",
    "今天星期几",
    "帮我算一下 128 乘以 7",
    "3+5等于多少",
    "提醒我十分钟后喝水",
    "二十分钟后叫我",
  ], shouldUseFunctionTools, true, "真的要用工具");
});

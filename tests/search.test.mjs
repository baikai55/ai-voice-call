import assert from "node:assert/strict";
import test from "node:test";

import { createWebSearchSession, normalizeWebSearchQuery, runWebSearch } from "../src/web-search.mjs";

function sseResult(text) {
  const payload = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } };
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

test("web_search query only applies Unicode, whitespace, and length normalization", () => {
  assert.equal(normalizeWebSearchQuery("  香港\n天气　怎么样  "), "香港 天气 怎么样");
  assert.equal(normalizeWebSearchQuery("ＡＢＣ btc 金价"), "ABC btc 金价");
  assert.doesNotMatch(normalizeWebSearchQuery("香港天气"), /实时天气|天气预报|气温|降水/);
  assert.equal(normalizeWebSearchQuery("x".repeat(200)).length, 160);
});

test("web_search sends the Exa MCP tool call and parses SSE in original order", async () => {
  let capturedUrl = "";
  let capturedInit;
  const fetchImpl = async (url, init) => {
    capturedUrl = String(url);
    capturedInit = init;
    return sseResult([
      "Title: 第一条",
      "URL: https://example.com/one",
      "Highlights:",
      "第一条内容",
      "",
      "---",
      "",
      "Title: 重复链接",
      "URL: https://example.com/one/",
      "Highlights:",
      "重复内容",
      "",
      "---",
      "",
      "Title: 第二条",
      "URL: https://example.com/two",
      "Highlights:",
      "第二条内容",
    ].join("\n"));
  };

  const result = await runWebSearch({ query: "  香港\n天气  ", fetchImpl });
  assert.equal(capturedUrl, "https://mcp.exa.ai/mcp");
  assert.equal(capturedInit.method, "POST");
  assert.match(capturedInit.headers.accept, /text\/event-stream/);
  const body = JSON.parse(capturedInit.body);
  assert.equal(body.method, "tools/call");
  assert.equal(body.params.name, "web_search_exa");
  assert.equal(body.params.arguments.query, "香港 天气");
  assert.equal(result.ok, true);
  assert.equal(result.provider, "exa");
  assert.deepEqual(result.items.map((item) => item.title), ["第一条", "第二条"]);
});

test("web_search keeps the RPC result when later SSE events are only notifications", async () => {
  const resultPayload = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: 结果\nURL: https://example.com/result\nHighlights:\n有效内容" }] } };
  const notification = { jsonrpc: "2.0", method: "notifications/message", params: { message: "done" } };
  const fetchImpl = async () => new Response([
    `event: message\ndata: ${JSON.stringify(resultPayload)}`,
    `event: message\ndata: ${JSON.stringify(notification)}`,
    "",
  ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
  const result = await runWebSearch({ query: "测试", fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.items[0].title, "结果");
});

test("web_search parses JSON structured results", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      structuredContent: {
        results: [
          { title: "甲", url: "https://example.com/a", text: "内容甲" },
          { title: "乙", url: "https://example.com/b", highlights: ["内容", "乙"] },
        ],
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
  const result = await runWebSearch({ query: "测试", fetchImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((item) => item.snippet), ["内容甲", "内容 乙"]);
});

test("web_search enforces its timeout and propagates caller cancellation", async () => {
  const hangingFetch = (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
  const timedOut = await runWebSearch({ query: "超时", timeoutMs: 20, fetchImpl: hangingFetch });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error, /timeout/i);

  const controller = new AbortController();
  const pending = runWebSearch({ query: "取消", timeoutMs: 1000, signal: controller.signal, fetchImpl: hangingFetch });
  controller.abort(new Error("caller canceled"));
  await assert.rejects(pending, /caller canceled/);
});

test("web_search timeout and cancellation also cover a stalled response body", async () => {
  const stalledBodyFetch = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init.signal.addEventListener("abort", () => controller.error(init.signal.reason), { once: true });
    },
  }), { status: 200 });

  const timedOut = await runWebSearch({ query: "正文超时", timeoutMs: 20, fetchImpl: stalledBodyFetch });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.error, /timeout/i);

  const controller = new AbortController();
  const pending = runWebSearch({ query: "正文取消", timeoutMs: 1000, signal: controller.signal, fetchImpl: stalledBodyFetch });
  controller.abort(new Error("body canceled"));
  await assert.rejects(pending, /body canceled/);
});

test("a tool session reuses duplicate queries and executes at most two searches", async () => {
  const calls = [];
  const session = createWebSearchSession({
    search: async ({ query }) => {
      calls.push(query);
      return { ok: true, query, provider: "exa", items: [{ title: query, snippet: "ok" }] };
    },
  });
  const first = await session.execute({ query: "  香港\n天气 " });
  const duplicate = await session.execute({ query: "香港 天气" });
  const second = await session.execute({ query: "深圳天气" });
  const limited = await session.execute({ query: "广州天气" });
  assert.equal(first, duplicate);
  assert.equal(second.ok, true);
  assert.equal(limited.ok, false);
  assert.match(limited.error, /最多执行两次/);
  assert.deepEqual(calls, ["香港 天气", "深圳天气"]);
});

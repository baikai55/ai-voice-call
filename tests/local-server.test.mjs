import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startApp(extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(PROJECT_DIR, "local-server.mjs")], {
    cwd: PROJECT_DIR,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`local server exited early (${child.exitCode})\n${logs}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    const response = await fetch(`${baseUrl}/api/health`);
    if (!response.ok) throw new Error(`health returned ${response.status}`);
  } catch (err) {
    child.kill();
    throw new Error(`local server did not start: ${err.message}\n${logs}`);
  }
  return {
    baseUrl,
    logs: () => logs,
    async stop() {
      if (child.exitCode == null) child.kill();
      if (child.exitCode == null) await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
    },
  };
}

async function startMockProvider() {
  const calls = { llm: 0, stt: 0, tts: 0, chatPayloads: [] };
  const sockets = new Set();
  let closeStream;
  const upstreamClosed = new Promise((resolve) => { closeStream = resolve; });
  let streamClosed = false;
  const markStreamClosed = () => {
    if (streamClosed) return;
    streamClosed = true;
    closeStream();
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://provider.test");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    if (url.pathname === "/v1/chat/completions") {
      calls.llm += 1;
      const payload = JSON.parse(body.toString("utf8") || "{}");
      calls.chatPayloads.push(payload);
      if (payload.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"开"}}]}\n\n');
        const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 100);
        const closed = () => { clearInterval(keepAlive); markStreamClosed(); };
        req.once("aborted", closed);
        res.once("close", closed);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }));
      return;
    }
    if (url.pathname === "/v1/audio/transcriptions") {
      calls.stt += 1;
      assert.match(String(req.headers["content-type"] || ""), /^multipart\/form-data; boundary=/i);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "" }));
      return;
    }
    if (url.pathname === "/v1/audio/speech") {
      calls.tts += 1;
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end(Buffer.from("ID3connection-test"));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    calls,
    upstreamClosed,
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function providerConfig(baseUrl, overrides = {}) {
  return {
    llm: { baseUrl, apiKey: "test-llm-key", model: "mock-chat", apiType: "openai-chat" },
    stt: { baseUrl, apiKey: "test-stt-key", model: "mock-stt", apiType: "openai-transcriptions" },
    tts: { baseUrl, apiKey: "test-tts-key", model: "mock-tts", voice: "alloy", apiType: "openai-speech" },
    maxTokens: 256,
    webSearchEnabled: false,
    toolCallingEnabled: false,
    ttsEnabled: true,
    ...overrides,
  };
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

test("local server security, provider tests, token bounds, and cancellation", async (t) => {
  const provider = await startMockProvider();
  const guardedApp = await startApp();
  const testApp = await startApp({ ALLOW_PRIVATE_UPSTREAMS: "true" });
  t.after(async () => {
    await Promise.all([guardedApp.stop(), testApp.stop()]);
    await provider.stop();
  });

  await t.test("health and exact Origin checks", async () => {
    const health = await fetch(`${guardedApp.baseUrl}/api/health`);
    assert.equal(health.status, 200);

    const sameOrigin = await fetch(`${guardedApp.baseUrl}/api/health`, { headers: { origin: guardedApp.baseUrl } });
    assert.equal(sameOrigin.status, 200);

    const nullOrigin = await fetch(`${guardedApp.baseUrl}/api/health`, { headers: { origin: "null" } });
    assert.equal(nullOrigin.status, 403);

    const otherOrigin = await fetch(`${guardedApp.baseUrl}/api/health`, { headers: { origin: "http://127.0.0.1:1" } });
    assert.equal(otherOrigin.status, 403);
  });

  await t.test("malformed JSON returns 400", async () => {
    const response = await fetch(`${guardedApp.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /JSON/);
  });

  await t.test("private upstreams are blocked by default", async () => {
    const before = { ...provider.calls };
    const { response, data } = await postJson(`${guardedApp.baseUrl}/api/test`, { config: providerConfig(provider.baseUrl) });
    assert.equal(response.status, 502);
    assert.equal(data.ok, false);
    assert.match(data.error, /不能指向本机、局域网|安全原因/);
    assert.equal(provider.calls.llm, before.llm);
    assert.equal(provider.calls.stt, before.stt);
    assert.equal(provider.calls.tts, before.tts);
  });

  await t.test("connection test reaches LLM, STT, and TTS", async () => {
    const { response, data } = await postJson(`${testApp.baseUrl}/api/test`, { config: providerConfig(provider.baseUrl) });
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.llmTest.ok, true);
    assert.equal(data.sttTest.ok, true);
    assert.equal(data.ttsTest.ok, true);
    assert.ok(provider.calls.llm >= 1);
    assert.ok(provider.calls.stt >= 1);
    assert.ok(provider.calls.tts >= 1);
  });

  await t.test("256 max tokens reaches the provider unchanged", async () => {
    const { response, data } = await postJson(`${testApp.baseUrl}/api/chat`, {
      message: "你好",
      config: providerConfig(provider.baseUrl, { maxTokens: 256, ttsEnabled: false }),
    });
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(provider.calls.chatPayloads.at(-1).max_tokens, 256);
  });

  await t.test("weather observations stay in normal conversation", async () => {
    const before = provider.calls.llm;
    const message = "哎，今天天气下雨了，感觉潮潮的。";
    const { response, data } = await postJson(`${testApp.baseUrl}/api/chat`, {
      message,
      config: providerConfig(provider.baseUrl, { webSearchEnabled: true, ttsEnabled: false }),
    });
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.reply, "连接成功");
    assert.equal(provider.calls.llm, before + 1);
    assert.equal(provider.calls.chatPayloads.at(-1).messages.at(-1).content, message);
    assert.doesNotMatch(data.reply, /可靠实时天气|哎了感觉潮潮的/);
  });

  await t.test("an actual weather question without a city asks for one", async () => {
    const before = provider.calls.llm;
    const { response, data } = await postJson(`${testApp.baseUrl}/api/chat`, {
      message: "今天天气怎么样？",
      config: providerConfig(provider.baseUrl, { webSearchEnabled: true, ttsEnabled: false }),
    });
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.match(data.reply, /哪个城市/);
    assert.equal(provider.calls.llm, before);
  });

  await t.test("weather descriptions are not treated as a follow-up city", async () => {
    const before = provider.calls.llm;
    const { response, data } = await postJson(`${testApp.baseUrl}/api/chat`, {
      messages: [
        { role: "user", content: "杭州天气怎么样？" },
        { role: "assistant", content: "杭州今天有雨。" },
        { role: "user", content: "感觉潮潮的。" },
      ],
      config: providerConfig(provider.baseUrl, { webSearchEnabled: true, ttsEnabled: false }),
    });
    assert.equal(response.status, 200);
    assert.equal(data.reply, "连接成功");
    assert.equal(provider.calls.llm, before + 1);
    assert.equal(provider.calls.chatPayloads.at(-1).messages.at(-1).content, "感觉潮潮的。");
  });

  await t.test("canceling the browser stream closes the provider stream", async () => {
    const controller = new AbortController();
    const response = await fetch(`${testApp.baseUrl}/api/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "请流式回答", config: providerConfig(provider.baseUrl, { ttsEnabled: false }) }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    await reader.read();
    controller.abort();
    await Promise.race([
      provider.upstreamClosed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("provider stream was not canceled")), 3000)),
    ]);
  });
});

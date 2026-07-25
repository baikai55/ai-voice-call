# AI语音通话 (ai-voice-call)

大字号中文 AI 语音/文字聊天应用：适合日常聊天、工作助理、学习辅导、长辈友好等场景。支持免按住连续语音通话、按住说话、自动朗读、本地配置、导入/导出配置，可本地运行，也可部署到 Cloudflare Workers + Assets。

## 核心原则

- **聊天数据存本地**：对话历史保存在当前浏览器 IndexedDB。
- **配置存本地**：供应商（Base URL / API Key）、模型名、搜索 Key、人设模板等保存在当前浏览器本地。
- **服务端不保存配置和数据**：本地 Node 服务 / Cloudflare Worker 只做静态资源托管和 API 代理，不持久化聊天记录，不保存 API Key。
- **换设备需重新配置或导入配置 JSON**；清除浏览器数据会清掉本地配置和历史。

## 功能

- 文字聊天
- 一键语音通话：自动收音、检测停顿、识别并发送，AI 朗读结束后继续聆听
- 按住说话（语音识别 STT/ASR）
- 自动朗读（TTS，失败可回退浏览器语音）
- 场景模板下拉：通用助手、陪伴聊天、长辈友好、工作助理、学习辅导、简洁模式、自定义
- 本地配置保存、导入、导出
- IndexedDB 本地历史对话
- 可选联网搜索：天气、新闻、今天、最新、价格等实时问题会先搜索再回答

## 快速开始

### 1. 安装

```powershell
cd H:\github\ai-voice-call
npm install
```

### 2. 本地启动（推荐）

双击：

```text
一键启动.cmd
```

或命令行：

```powershell
npm run dev
```

浏览器打开：

- 电脑：`http://127.0.0.1:8787`
- 手机同一 WiFi：看启动窗口打印的 `http://192.168.x.x:8787`

自检：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/health
```

也可以双击 `检查服务.cmd`。

> 说明：手机浏览器录音通常更依赖 HTTPS。如果局域网 HTTP 下麦克风不可用，建议用 Cloudflare HTTPS 地址，或使用项目里的本地证书脚本配置 HTTPS。


### 手机隐藏浏览器地址栏

普通手机浏览器标签页里，网页不能强制隐藏系统地址栏/工具栏。项目已支持 PWA：手机访问 HTTPS 域名后，点浏览器菜单里的 **添加到主屏幕 / 安装应用**，以后从桌面图标打开，就会以独立应用模式运行，地址栏基本不会显示。

### 3. 填写本地配置

点右上角 **设置 / 本地配置**，先进入 **供应商**：

1. **新增供应商**：填写名称、Base URL、API Key（同一平台只填一次）
2. **大模型 LLM**：选择模型供应商 + 聊天 Model + 接口类型
3. **语音识别 STT/ASR**：选择语音识别供应商（可“跟随大模型”）+ 语音识别 Model + 接口类型
4. **语音合成 TTS**：选择语音合成供应商（可“跟随大模型”）+ TTS Model + Voice / 音色 + 接口类型

| 项 | 推荐值 |
|---|---|
| 供应商 Base URL | 按供应商填写，例如 `https://api.siliconflow.cn/v1` |
| 供应商 API Key | 你的模型平台 Key，保存在当前浏览器本地 |
| LLM Model | 按供应商可用模型填写 |
| 语音识别 STT/ASR Model | 按供应商可用语音识别模型填写 |
| TTS Model | 按供应商可用语音合成模型填写 |
| Voice / 音色 | 可从下拉选预置音色，也可以直接输入服务商支持的自定义 voice id |
| 接口类型 | LLM 一般选 `自动识别` 或明确选择 `OpenAI Chat Completions` / `OpenAI Responses`。小米 `mimo-v2.5-tts` 可选 `小米 MiMo TTS`；OpenAI 兼容语音合成选 `OpenAI Speech API`。三类服务也都支持 `自定义接口地址` |

可以分别定义 3 个供应商（LLM / 语音识别 / TTS 各一个），也可以共用同一个。语音识别 / TTS 选“跟随大模型”时，自动使用大模型对应供应商的 Base URL 和 Key。

选择 `自定义接口地址` 后，只覆盖最终请求 URL，请求和响应格式仍需兼容对应的 OpenAI 接口：LLM 使用 Chat Completions，STT 使用 Audio Transcriptions 的 `multipart/form-data`，TTS 使用 Speech API 的 JSON。地址支持三种写法：

- 完整 `http://` / `https://` URL：直接使用
- 以 `/` 开头：从供应商域名根路径拼接，例如 Base URL 为 `https://example.com/v1`，填写 `/api/chat` 后请求 `https://example.com/api/chat`
- 其它相对路径：追加到供应商 Base URL，例如填写 `chat/completions` 后请求 `https://example.com/v1/chat/completions`

聊天接口已支持流式输出：前端优先请求 `/api/chat/stream`，后端会代理供应商的 `/v1/chat/completions` 或 `/v1/responses` 流；如果流式在输出前失败，会自动回退到原来的 `/api/chat` 非流式请求。TTS 仍等完整回复生成后再朗读。

小米 MiMo TTS 供应商示例：Base URL 填 `https://api.xiaomimimo.com/v1`，TTS Model 填 `mimo-v2.5-tts`，TTS 接口类型选 `小米 MiMo TTS`（或保持 `自动识别`）。Voice / 音色可选 `mimo_default`、`冰糖`、`茉莉`、`苏打`、`白桦`、`Mia`、`Chloe`、`Milo`、`Dean`，也可以直接输入服务商支持的自定义 voice id。Voice 留空或填 `alloy` 时会自动按小米接口转成 `mimo_default`。

LLM / STT / TTS 模型使用下拉框选择。展开下拉框后可以输入任意服务商模型 ID 并点击 **添加**；自定义模型的 `×` 删除按钮位于对应下拉选项右侧，不占用设置表单布局。自定义模型列表会随配置一起导入、导出。

然后：

1. 点 **保存到本地**
2. 点 **测试连接**
3. 开始聊天

### 4. 开始语音通话

点击页面右上角的绿色电话按钮即可接通：

1. 浏览器首次使用时允许麦克风权限。
2. 直接说话，无需一直按住按钮。
3. 自然停顿约 1 秒后，应用会自动结束本轮收音并发送识别结果。
4. AI 回复并朗读完毕后，会自动重新打开麦克风等待下一轮。
5. 通话界面可随时静音或挂断；切换页面到后台时会自动挂断并释放麦克风。

语音通话采用轮流说话模式：AI 朗读时暂停收音，避免扬声器回声被再次识别。它是与 AI 的连续语音对话，不是用户之间的 WebRTC 真人通话。

## 推荐默认值

| 配置项 | 默认值 | 说明 |
|---|---:|---|
| 场景模板 | 通用助手 |   |
| 历史轮数 `maxHistoryTurns` | `12` | 保留最近上下文，避免请求过长 |
| 最大回复长度 `maxTokens` | `512` | 默认适合语音朗读；需要更详细可在 UI 调到 800/1024 |
| 温度 `temperature` | `0.7` | 自然但不太发散 |
| 自动朗读 `autoSpeak` | `true` | 语音聊天默认开启 |
| TTS `ttsEnabled` | `true` | 优先使用服务端 TTS |
| 浏览器朗读兜底 | `true` | TTS 接口失败时仍可朗读 |
| 联网搜索 | `true` | 实时问题自动搜索 |
| 搜索提供方 | `auto` | 不填 Key 也可先用免费搜索 |

`maxTokens` 不建议默认设太大。这个应用偏语音/聊天，512 通常足够；过大会增加延迟、成本和朗读时长。

## 场景模板与自定义人设

在「本地配置 -> 对话」中选择：

- 通用助手
- 陪伴聊天
- 长辈友好
- 工作助理
- 学习辅导
- 简洁模式
- 自定义

选择模板后会自动填入「系统人设」。你可以继续手动改，修改后会按「自定义」保存。

## 导入 / 导出配置

在「本地配置」面板：

- **导出配置**：完整 JSON，含 Key，仅自己保存。
- **导出（不含Key）**：可分享模型、地址、人设和默认值，不含密钥。
- **导入配置**：选择之前导出的 JSON。

示例文件：

- `config/api.local.example.json`

### 配置文件格式

```json
{
  "app": "ai-voice-call",
  "version": 3,
  "apiProviders": [
    {
      "id": "provider_default",
      "name": "默认供应商",
      "baseUrl": "https://api.siliconflow.cn/v1",
      "apiKey": "sk-xxx"
    }
  ],
  "customModels": {
    "llm": ["your-org/your-chat-model"],
    "stt": ["your-org/your-stt-model"],
    "tts": ["your-org/your-tts-model"]
  },
  "llm": {
    "providerId": "provider_default",
    "model": "Qwen/Qwen3.5-4B",
    "apiType": "auto",
    "endpoint": ""
  },
  "stt": {
    "providerId": "",
    "model": "FunAudioLLM/SenseVoiceSmall",
    "apiType": "auto",
    "endpoint": ""
  },
  "tts": {
    "providerId": "",
    "model": "FnLP/MOSS-TTSD-v0.5",
    "voice": "alloy",
    "apiType": "auto",
    "endpoint": ""
  },
  "systemPromptPreset": "general",
  "systemPrompt": "你是一个中文 AI 助手...",
  "maxHistoryTurns": 12,
  "maxTokens": 512,
  "temperature": 0.7,
  "ttsEnabled": true,
  "browserTtsFallback": true,
  "autoSpeak": true,
  "webSearchEnabled": true,
  "searchProvider": "auto",
  "searchApiKey": "",
  "searchBaseUrl": ""
}
```

## 部署到 Cloudflare

```powershell
npm install
npx wrangler login
npm run deploy
```

部署后仍然在网页「本地配置」里填写 API Key。不要把用户 API Key 配成 Cloudflare Secret；本项目设计为配置和数据都保存在用户浏览器本地。

## 接口

- `GET /api/health`
- `GET /api/defaults`
- `POST /api/chat`
- `POST /api/chat/stream`
- `POST /api/asr`
- `POST /api/tts`
- `POST /api/test`
- `POST /api/search`

前端请求会带上浏览器本地 config；服务端只代理请求，不持久化配置或对话。

## 目录

```text
H:\github\ai-voice-call  src\index.ts          Worker 后端
  src\search.ts         联网搜索
  public\index.html     页面
  public\app.js         前端逻辑
  public\db.js          IndexedDB 存储
  public\styles.css
  config\api.local.example.json
  local-server.mjs      本地 Node 服务
  wrangler.toml
  package.json
  README.md
```

## 注意

1. 不要把 API Key 发给任何人，不要提交真实 Key。
2. 导出的“完整配置”等同于密码本，别发到网上或群里。
3. 免费模型和免费搜索可能限流或不稳定。
4. TTS 模型名以平台实际可用为准；不行就先开「浏览器朗读」。
5. 如果 Key 暴露过，请去模型平台轮换 Key。

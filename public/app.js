import {
  listConversations,
  getConversation,
  putConversation,
  deleteConversation,
  getMeta,
  setMeta,
  getAppConfig,
  setAppConfig,
  hasAppConfig,
  createConversationRecord,
  deriveTitle,
  migrateLegacyDatabaseIfNeeded,
} from "./db.js";

const STORAGE_KEY = "ai-voice-call.config.v1";
const HISTORY_KEY = "ai-voice-call.history.v1";
const INSTALL_TIP_DISMISS_KEY = "ai-voice-call.installTip.dismissed.v1";
const LEGACY_STORAGE_KEYS = [
  "ai-voice-call.config.v1", // current first
  "parent-chat-cf.config.v1",
];
const LEGACY_HISTORY_KEYS = [
  "ai-voice-call.history.v1",
  "parent-chat-cf.history.v1",
];

const SYSTEM_PROMPT_PRESETS = {
  general: {
    label: "通用助手",
    prompt:
      "你是一个中文 AI 助手。默认使用简体中文，回答清楚、自然、有帮助。优先给出可执行建议，少说空话。根据用户语气调整详略；适合语音朗读时使用短句。涉及医疗、药品、投资、法律等高风险内容时，只提供一般信息，提醒不能替代专业人士。若提供了【联网搜索结果】，请优先依据结果回答，不编造实时数据。不要输出思考过程。",
  },
  companion: {
    label: "陪伴聊天",
    prompt:
      "你是一个温和耐心的中文陪伴聊天助手。先接住用户情绪，再给简短回应或建议。语气自然、真诚，像可靠的朋友。默认简体中文，适合语音朗读，少用术语，不列很长清单。涉及医疗、药品、投资、法律等高风险内容时，只提供一般信息，并建议咨询专业人士。不要输出思考过程。",
  },
  parent: {
    label: "长辈友好",
    prompt:
      "你是一个适合陪伴中国长辈的中文聊天助手。说话温柔、耐心，像晚辈。默认简体中文，短句，一次只说清楚一件事。先接住情绪，再给建议。少用术语。回答控制在80到150字。涉及医疗、药品、投资、法律时只给一般性参考，明确说明不能替代专业人士，并建议询问家人或正规机构。不要输出思考过程，不要列很长清单。",
  },
  work: {
    label: "工作助理",
    prompt:
      "你是一个高效的中文工作助理。默认简体中文，回答结构清楚、结论先行，必要时给步骤、清单或模板。优先帮助用户推进任务，减少空话。不了解的信息要说明不确定；涉及实时信息时，如果提供了【联网搜索结果】，请优先依据结果回答。不要输出思考过程。",
  },
  study: {
    label: "学习辅导",
    prompt:
      "你是一个耐心的中文学习辅导助手。默认简体中文，先用简单语言解释核心概念，再给例子和练习建议。不要直接堆答案，尽量引导用户理解。根据用户水平调整难度。涉及事实或实时资料时保持谨慎，不确定就说明。不要输出思考过程。",
  },
  concise: {
    label: "简洁模式",
    prompt:
      "你是一个简洁直接的中文助手。默认简体中文。优先给结论和最少必要步骤，避免长篇解释，除非用户要求详细说明。涉及医疗、药品、投资、法律等高风险内容时，只提供一般信息并提醒咨询专业人士。不要输出思考过程。",
  },
};

function inferPromptPreset(prompt, preferred = "general") {
  const text = String(prompt || "").trim();
  if (!text) return preferred in SYSTEM_PROMPT_PRESETS ? preferred : "general";
  for (const [key, item] of Object.entries(SYSTEM_PROMPT_PRESETS)) {
    if (text === item.prompt) return key;
  }
  return "custom";
}

const DEFAULT_PROVIDER_ID = "provider_default";

const TTS_VOICE_PRESETS = [
  "mimo_default",
  "冰糖",
  "茉莉",
  "苏打",
  "白桦",
  "Mia",
  "Chloe",
  "Milo",
  "Dean",
  "alloy",
];

function setTtsVoiceFormValue(voice) {
  const f = el.fields;
  const value = String(voice || "").trim() || DEFAULTS.tts.voice;
  if (!f.ttsVoicePreset || !f.ttsVoice) {
    if (f.ttsVoice) f.ttsVoice.value = value;
    return;
  }
  if (TTS_VOICE_PRESETS.includes(value)) {
    f.ttsVoicePreset.value = value;
    f.ttsVoice.value = value;
    f.ttsVoice.classList.add("hidden");
    return;
  }
  f.ttsVoicePreset.value = "custom";
  f.ttsVoice.value = value;
  f.ttsVoice.classList.remove("hidden");
}

function syncTtsVoiceCustomInput(focus = false) {
  const f = el.fields;
  if (!f.ttsVoicePreset || !f.ttsVoice) return;
  if (f.ttsVoicePreset.value === "custom") {
    if (TTS_VOICE_PRESETS.includes(f.ttsVoice.value.trim())) f.ttsVoice.value = "";
    f.ttsVoice.classList.remove("hidden");
    if (focus) f.ttsVoice.focus();
    return;
  }
  f.ttsVoice.value = f.ttsVoicePreset.value;
  f.ttsVoice.classList.add("hidden");
}

function readTtsVoiceFormValue() {
  const f = el.fields;
  if (!f.ttsVoicePreset) return f.ttsVoice?.value.trim() || "";
  return f.ttsVoicePreset.value === "custom"
    ? f.ttsVoice?.value.trim() || ""
    : f.ttsVoicePreset.value;
}

function createProviderId() {
  return `provider_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeProvider(partial = {}) {
  return {
    id: String(partial?.id || createProviderId()),
    name: String(partial?.name || "未命名供应商").trim() || "未命名供应商",
    baseUrl: String(partial?.baseUrl || "").trim(),
    apiKey: String(partial?.apiKey || "").trim(),
  };
}

function defaultApiProviders() {
  return [
    makeProvider({
      id: DEFAULT_PROVIDER_ID,
      name: "默认供应商",
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKey: "",
    }),
  ];
}

const DEFAULTS = {
  apiProviders: defaultApiProviders(),
  llm: {
    providerId: DEFAULT_PROVIDER_ID,
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: "",
    model: "Qwen/Qwen3.5-4B",
    apiType: "auto",
  },
  stt: {
    providerId: "",
    baseUrl: "",
    apiKey: "",
    model: "FunAudioLLM/SenseVoiceSmall",
    apiType: "auto",
  },
  tts: {
    providerId: "",
    baseUrl: "",
    apiKey: "",
    model: "FnLP/MOSS-TTSD-v0.5",
    voice: "alloy",
    apiType: "auto",
  },
  systemPromptPreset: "general",
  systemPrompt: SYSTEM_PROMPT_PRESETS.general.prompt,
  maxHistoryTurns: 12,
  maxTokens: 512,
  temperature: 0.7,
  ttsEnabled: true,
  browserTtsFallback: true,
  autoSpeak: true,
  webSearchEnabled: true,
  searchProvider: "auto",
  searchApiKey: "",
  searchBaseUrl: "",
};

const el = {
  chat: document.getElementById("chat"),
  input: document.getElementById("input"),
  status: document.getElementById("status"),
  btnSend: document.getElementById("btnSend"),
  btnHold: document.getElementById("btnHold"),
  btnVoice: document.getElementById("btnVoice"),
  btnNewChat: document.getElementById("btnNewChat"),
  btnHistory: document.getElementById("btnHistory"),
  chatTitle: document.getElementById("chatTitle"),
  chatSub: document.getElementById("chatSub"),
  historyModal: document.getElementById("historyModal"),
  historyList: document.getElementById("historyList"),
  btnCloseHistory: document.getElementById("btnCloseHistory"),
  btnNewChatFromHistory: document.getElementById("btnNewChatFromHistory"),
  btnSettings: document.getElementById("btnSettings"),
  settingsModal: document.getElementById("settingsModal"),
  btnCloseSettings: document.getElementById("btnCloseSettings"),
  btnSaveSettings: document.getElementById("btnSaveSettings"),
  btnTest: document.getElementById("btnTest"),
  btnExport: document.getElementById("btnExport"),
  btnExportSafe: document.getElementById("btnExportSafe"),
  btnImport: document.getElementById("btnImport"),
  btnReset: document.getElementById("btnReset"),
  importFile: document.getElementById("importFile"),
  settingsStatus: document.getElementById("settingsStatus"),
  installTip: document.getElementById("installTip"),
  btnInstallApp: document.getElementById("btnInstallApp"),
  btnInstallDismiss: document.getElementById("btnInstallDismiss"),
  fields: {
    apiProviderPicker: document.getElementById("apiProviderPicker"),
    apiProviderList: document.getElementById("apiProviderList"),
    providerEditor: document.getElementById("providerEditor"),
    providerEditId: document.getElementById("providerEditId"),
    providerName: document.getElementById("providerName"),
    providerBaseUrl: document.getElementById("providerBaseUrl"),
    providerApiKey: document.getElementById("providerApiKey"),
    btnAddProvider: document.getElementById("btnAddProvider"),
    btnEditSelectedProvider: document.getElementById("btnEditSelectedProvider"),
    btnDeleteSelectedProvider: document.getElementById("btnDeleteSelectedProvider"),
    btnSaveProvider: document.getElementById("btnSaveProvider"),
    btnCancelProvider: document.getElementById("btnCancelProvider"),
    llmProviderId: document.getElementById("llmProviderId"),
    llmModel: document.getElementById("llmModel"),
    llmApiType: document.getElementById("llmApiType"),
    sttProviderId: document.getElementById("sttProviderId"),
    sttModel: document.getElementById("sttModel"),
    sttApiType: document.getElementById("sttApiType"),
    ttsProviderId: document.getElementById("ttsProviderId"),
    ttsModel: document.getElementById("ttsModel"),
    ttsVoicePreset: document.getElementById("ttsVoicePreset"),
    ttsVoice: document.getElementById("ttsVoice"),
    ttsApiType: document.getElementById("ttsApiType"),
    systemPromptPreset: document.getElementById("systemPromptPreset"),
    systemPrompt: document.getElementById("systemPrompt"),
    maxHistoryTurns: document.getElementById("maxHistoryTurns"),
    maxTokens: document.getElementById("maxTokens"),
    temperature: document.getElementById("temperature"),
    ttsEnabled: document.getElementById("ttsEnabled"),
    browserTtsFallback: document.getElementById("browserTtsFallback"),
    autoSpeak: document.getElementById("autoSpeak"),
    webSearchEnabled: document.getElementById("webSearchEnabled"),
    searchProvider: document.getElementById("searchProvider"),
    searchApiKey: document.getElementById("searchApiKey"),
    searchBaseUrl: document.getElementById("searchBaseUrl"),
  },
};

let config = structuredClone(DEFAULTS);
let currentConversationId = null;
let messages = [];
let busy = false;
let mediaRecorder = null;
let recordChunks = [];
let recording = false;
let serverDefaults = null;
let providersDraft = defaultApiProviders();
let selectedProviderDraftId = DEFAULT_PROVIDER_ID;
let providerEditorMode = ""; // "" | "add" | "edit"

let browserRec = null;
let browserTranscript = "";
let browserUsing = false;
let holdActive = false;
let holdGeneration = 0;
let restartTimer = null;

function deepMerge(base, patch) {
  const out = { ...base, ...patch };
  out.llm = { ...base.llm, ...(patch?.llm || {}) };
  out.stt = { ...base.stt, ...(patch?.stt || {}) };
  out.tts = { ...base.tts, ...(patch?.tts || {}) };
  if (Array.isArray(patch?.apiProviders)) {
    out.apiProviders = patch.apiProviders.map((item) => makeProvider(item));
  } else if (Array.isArray(base.apiProviders)) {
    out.apiProviders = base.apiProviders.map((item) => makeProvider(item));
  } else {
    out.apiProviders = defaultApiProviders();
  }
  return out;
}

function findProviderById(list, id) {
  if (!id) return null;
  return (list || []).find((item) => item.id === id) || null;
}

function ensureProviderList(list) {
  const cleaned = (Array.isArray(list) ? list : [])
    .map((item) => makeProvider(item))
    .filter((item) => item.id);
  if (!cleaned.length) return defaultApiProviders();
  const seen = new Set();
  const unique = [];
  for (const item of cleaned) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  return unique;
}

function resolveServiceProvider(apiProviders, providerId, fallbackId = "") {
  return (
    findProviderById(apiProviders, providerId) ||
    findProviderById(apiProviders, fallbackId) ||
    apiProviders[0] ||
    makeProvider({
      id: DEFAULT_PROVIDER_ID,
      name: "默认供应商",
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKey: "",
    })
  );
}

function serviceProviderDiffers(service = {}, llmBaseUrl = "", llmApiKey = "") {
  const baseUrl = String(service?.baseUrl || "").trim();
  const apiKey = String(service?.apiKey || "").trim();
  return Boolean((baseUrl && baseUrl !== llmBaseUrl) || (apiKey && apiKey !== llmApiKey));
}

function providerFromLegacyConfig(raw = {}) {
  if (Array.isArray(raw.apiProviders) && raw.apiProviders.length) {
    return {
      apiProviders: ensureProviderList(raw.apiProviders),
      llmProviderId: raw.llm?.providerId || DEFAULT_PROVIDER_ID,
      sttProviderId: raw.stt?.providerId || "",
      ttsProviderId: raw.tts?.providerId || "",
    };
  }

  const llmBaseUrl = String(raw.llm?.baseUrl || DEFAULTS.llm.baseUrl || "").trim();
  const llmApiKey = String(raw.llm?.apiKey || "").trim();
  const apiProviders = [
    makeProvider({
      id: DEFAULT_PROVIDER_ID,
      name: "大模型供应商",
      baseUrl: llmBaseUrl,
      apiKey: llmApiKey,
    }),
  ];

  let sttProviderId = "";
  if (serviceProviderDiffers(raw.stt, llmBaseUrl, llmApiKey)) {
    sttProviderId = "provider_stt_legacy";
    apiProviders.push(makeProvider({
      id: sttProviderId,
      name: "语音识别供应商",
      baseUrl: String(raw.stt?.baseUrl || llmBaseUrl).trim(),
      apiKey: String(raw.stt?.apiKey || "").trim(),
    }));
  }

  let ttsProviderId = "";
  if (serviceProviderDiffers(raw.tts, llmBaseUrl, llmApiKey)) {
    ttsProviderId = "provider_tts_legacy";
    apiProviders.push(makeProvider({
      id: ttsProviderId,
      name: "语音合成供应商",
      baseUrl: String(raw.tts?.baseUrl || llmBaseUrl).trim(),
      apiKey: String(raw.tts?.apiKey || "").trim(),
    }));
  }

  return { apiProviders, llmProviderId: DEFAULT_PROVIDER_ID, sttProviderId, ttsProviderId };
}

function syncResolvedCredentials(configLike) {
  const out = configLike;
  out.apiProviders = ensureProviderList(out.apiProviders);
  const llmProvider = resolveServiceProvider(out.apiProviders, out.llm?.providerId, DEFAULT_PROVIDER_ID);
  out.llm = {
    ...(out.llm || {}),
    providerId: llmProvider.id,
    baseUrl: llmProvider.baseUrl,
    apiKey: llmProvider.apiKey,
    model: String(out.llm?.model || DEFAULTS.llm.model).trim() || DEFAULTS.llm.model,
    apiType: normalizeApiType(out.llm?.apiType, DEFAULTS.llm.apiType),
  };

  const sttSelected = String(out.stt?.providerId || "").trim();
  if (sttSelected && findProviderById(out.apiProviders, sttSelected)) {
    const sttProvider = findProviderById(out.apiProviders, sttSelected);
    out.stt = {
      ...(out.stt || {}),
      providerId: sttProvider.id,
      baseUrl: sttProvider.baseUrl,
      apiKey: sttProvider.apiKey,
      model: String(out.stt?.model || DEFAULTS.stt.model).trim() || DEFAULTS.stt.model,
      apiType: normalizeApiType(out.stt?.apiType, DEFAULTS.stt.apiType),
    };
  } else {
    out.stt = {
      ...(out.stt || {}),
      providerId: "",
      baseUrl: "",
      apiKey: "",
      model: String(out.stt?.model || DEFAULTS.stt.model).trim() || DEFAULTS.stt.model,
      apiType: normalizeApiType(out.stt?.apiType, DEFAULTS.stt.apiType),
    };
  }

  const ttsSelected = String(out.tts?.providerId || "").trim();
  if (ttsSelected && findProviderById(out.apiProviders, ttsSelected)) {
    const ttsProvider = findProviderById(out.apiProviders, ttsSelected);
    out.tts = {
      ...(out.tts || {}),
      providerId: ttsProvider.id,
      baseUrl: ttsProvider.baseUrl,
      apiKey: ttsProvider.apiKey,
      model: String(out.tts?.model || DEFAULTS.tts.model).trim() || DEFAULTS.tts.model,
      voice: String(out.tts?.voice || DEFAULTS.tts.voice).trim() || DEFAULTS.tts.voice,
      apiType: normalizeApiType(out.tts?.apiType, DEFAULTS.tts.apiType),
    };
  } else {
    out.tts = {
      ...(out.tts || {}),
      providerId: "",
      baseUrl: "",
      apiKey: "",
      model: String(out.tts?.model || DEFAULTS.tts.model).trim() || DEFAULTS.tts.model,
      voice: String(out.tts?.voice || DEFAULTS.tts.voice).trim() || DEFAULTS.tts.voice,
      apiType: normalizeApiType(out.tts?.apiType, DEFAULTS.tts.apiType),
    };
  }

  return out;
}
function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function normalizeApiType(value, fallback = "auto") {
  const allowed = new Set(["auto", "openai-chat", "openai-responses", "openai-transcriptions", "openai-speech", "xiaomi-mimo"]);
  const v = String(value || "").trim();
  return allowed.has(v) ? v : fallback;
}

function normalizeConfig(next) {
  const raw = next || {};
  const legacyProviders = providerFromLegacyConfig(raw);
  const out = deepMerge(DEFAULTS, {
    ...raw,
    apiProviders: legacyProviders.apiProviders,
    llm: {
      providerId: raw.llm?.providerId || legacyProviders.llmProviderId || DEFAULT_PROVIDER_ID,
      model: raw.llm?.model,
      apiType: normalizeApiType(raw.llm?.apiType, DEFAULTS.llm.apiType),
    },
    stt: {
      providerId: raw.stt?.providerId || legacyProviders.sttProviderId || "",
      model: raw.stt?.model,
      apiType: normalizeApiType(raw.stt?.apiType, DEFAULTS.stt.apiType),
    },
    tts: {
      providerId: raw.tts?.providerId || legacyProviders.ttsProviderId || "",
      model: raw.tts?.model,
      voice: raw.tts?.voice,
      apiType: normalizeApiType(raw.tts?.apiType, DEFAULTS.tts.apiType),
    },
  });
  out.systemPrompt = String(out.systemPrompt || "").trim() || SYSTEM_PROMPT_PRESETS.general.prompt;
  out.systemPromptPreset = inferPromptPreset(out.systemPrompt, out.systemPromptPreset || "general");
  out.maxHistoryTurns = clampNumber(out.maxHistoryTurns, 12, 2, 30);
  out.maxTokens = clampNumber(out.maxTokens, 512, 256, 1024);
  out.temperature = clampNumber(out.temperature, 0.7, 0, 1.5);
  delete out.providers;
  return syncResolvedCredentials(out);
}

function loadLegacyConfig() {
  const keys = Array.from(new Set([STORAGE_KEY, ...LEGACY_STORAGE_KEYS]));
  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return { value: parsed, key };
      }
    } catch {}
  }
  return null;
}

async function loadConfigFromStore() {
  let saved = null;
  try {
    saved = await getAppConfig();
  } catch (err) {
    console.warn("读取 IndexedDB 配置失败", err);
  }

  if (!saved) {
    const legacy = loadLegacyConfig();
    if (legacy) {
      saved = legacy.value;
      try {
        await setAppConfig(legacy.value);
        for (const key of new Set([STORAGE_KEY, ...LEGACY_STORAGE_KEYS, legacy.key])) {
          try { localStorage.removeItem(key); } catch {}
        }
      } catch (err) {
        console.warn("迁移配置到 IndexedDB 失败，仍使用内存配置", err);
      }
    }
  }

  config = normalizeConfig(saved || {});
  return config;
}

async function saveConfig(next) {
  config = normalizeConfig(next || config);
  try {
    await setAppConfig(config);
  } catch (err) {
    console.warn("保存配置失败", err);
    setSettingsStatus(`保存配置失败：${err.message || err}`);
    throw err;
  }
  return config;
}

function loadLegacyHistory() {
  const keys = Array.from(new Set([HISTORY_KEY, ...LEGACY_HISTORY_KEYS]));
  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        // clean all legacy history keys after successful read by caller
        loadLegacyHistory._usedKey = key;
        return arr;
      }
    } catch {}
  }
  return [];
}

function clearLegacyHistoryKeys() {
  for (const key of new Set([HISTORY_KEY, ...LEGACY_HISTORY_KEYS, loadLegacyHistory._usedKey].filter(Boolean))) {
    try { localStorage.removeItem(key); } catch {}
  }
}

function updateHeaderTitle(title) {
  if (el.chatTitle) el.chatTitle.textContent = title || "AI语音通话";
  if (el.chatSub) el.chatSub.textContent = "配置与对话都保存在本机数据库";
}

function syncVoiceToggle() {
  const on = Boolean(config.autoSpeak);
  if (!el.btnVoice) return;
  el.btnVoice.classList.toggle("on", on);
  el.btnVoice.setAttribute("aria-pressed", on ? "true" : "false");
  el.btnVoice.title = on ? "语音朗读：开（点击关闭）" : "语音朗读：关（点击开启）";
  el.btnVoice.setAttribute("aria-label", on ? "关闭语音朗读" : "开启语音朗读");
}

async function setAutoSpeak(on) {
  config.autoSpeak = Boolean(on);
  // 打开语音时确保服务端 TTS 开关也开着；关闭只停自动朗读，不影响其它设置
  if (config.autoSpeak && !config.ttsEnabled && !config.browserTtsFallback) {
    config.ttsEnabled = true;
    config.browserTtsFallback = true;
  }
  await saveConfig(config);
  if (el.fields?.autoSpeak) el.fields.autoSpeak.checked = config.autoSpeak;
  if (el.fields?.ttsEnabled) el.fields.ttsEnabled.checked = config.ttsEnabled;
  if (el.fields?.browserTtsFallback) el.fields.browserTtsFallback.checked = config.browserTtsFallback;
  syncVoiceToggle();
}


async function persistCurrentConversation() {
  if (!currentConversationId) return;
  const title = deriveTitle(messages);
  const existing = await getConversation(currentConversationId);
  const now = Date.now();
  await putConversation({
    id: currentConversationId,
    title,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    messages: messages.slice(-200),
  });
  updateHeaderTitle(title);
}

async function saveHistory() {
  try {
    await persistCurrentConversation();
  } catch (err) {
    console.warn("保存对话失败", err);
    setStatus(`保存对话失败：${err.message || err}`);
  }
}

async function openConversation(id) {
  const conv = await getConversation(id);
  if (!conv) throw new Error("找不到该对话");
  currentConversationId = conv.id;
  messages = Array.isArray(conv.messages) ? conv.messages : [];
  await setMeta("currentId", currentConversationId);
  updateHeaderTitle(conv.title || deriveTitle(messages));
  renderChat();
}

async function startNewConversation({ force = false } = {}) {
  if (!force && messages.length === 0 && currentConversationId) {
    updateHeaderTitle("新对话");
    renderChat();
    setStatus("已在新对话中");
    return currentConversationId;
  }
  const conv = createConversationRecord([]);
  await putConversation(conv);
  currentConversationId = conv.id;
  messages = [];
  await setMeta("currentId", currentConversationId);
  updateHeaderTitle(conv.title);
  renderChat();
  setStatus("已开始新对话");
  return currentConversationId;
}

async function ensureConversationReady() {
  if (currentConversationId) return currentConversationId;
  return startNewConversation({ force: true });
}

function formatConvTime(ts) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

async function renderHistoryList() {
  if (!el.historyList) return;
  const list = await listConversations();
  el.historyList.innerHTML = "";
  if (!list.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = "还没有历史对话，点「新对话」开始吧。";
    el.historyList.appendChild(empty);
    return;
  }

  for (const item of list) {
    const row = document.createElement("div");
    row.className = "history-item" + (item.id === currentConversationId ? " active" : "");
    row.dataset.id = item.id;

    const main = document.createElement("button");
    main.type = "button";
    main.className = "history-main";
    main.innerHTML = `
      <strong>${escapeHtml(item.title || "新对话")}</strong>
      <span>${escapeHtml(formatConvTime(item.updatedAt))} · ${Array.isArray(item.messages) ? item.messages.length : 0} 条</span>
    `;
    main.addEventListener("click", async () => {
      try {
        await openConversation(item.id);
        closeHistory();
        setStatus("已切换对话");
      } catch (err) {
        setStatus(`打开失败：${err.message || err}`);
      }
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "history-del";
    del.title = "删除对话";
    del.setAttribute("aria-label", "删除对话");
    del.textContent = "删除";
    del.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!window.confirm("确定删除这段对话吗？")) return;
      try {
        await deleteConversation(item.id);
        if (currentConversationId === item.id) {
          const rest = await listConversations();
          if (rest[0]) await openConversation(rest[0].id);
          else await startNewConversation({ force: true });
        }
        await renderHistoryList();
        setStatus("对话已删除");
      } catch (err) {
        setStatus(`删除失败：${err.message || err}`);
      }
    });

    row.appendChild(main);
    row.appendChild(del);
    el.historyList.appendChild(row);
  }
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function openHistory() {
  if (!el.historyModal) return;
  el.historyModal.classList.remove("hidden");
  renderHistoryList().catch((err) => setStatus(`读取历史失败：${err.message || err}`));
}

function closeHistory() {
  if (!el.historyModal) return;
  el.historyModal.classList.add("hidden");
}

async function initConversationStore() {
  // migrate one-time from localStorage history
  const legacy = loadLegacyHistory();
  let list = await listConversations();
  if (!list.length && legacy.length) {
    const conv = createConversationRecord(legacy.slice(-200));
    conv.title = deriveTitle(conv.messages);
    await putConversation(conv);
    await setMeta("currentId", conv.id);
    clearLegacyHistoryKeys();
    list = [conv];
  }

  let currentId = await getMeta("currentId", null);
  if (currentId) {
    const exists = await getConversation(currentId);
    if (!exists) currentId = null;
  }
  if (!currentId) {
    if (list[0]) currentId = list[0].id;
    else {
      const conv = createConversationRecord([]);
      await putConversation(conv);
      currentId = conv.id;
      list = [conv];
    }
    await setMeta("currentId", currentId);
  }

  currentConversationId = currentId;
  const current = await getConversation(currentId);
  messages = Array.isArray(current?.messages) ? current.messages : [];
  updateHeaderTitle(current?.title || deriveTitle(messages));
}

function setStatus(text) {
  el.status.textContent = text || "";
}

function setSettingsStatus(text) {
  el.settingsStatus.textContent = text || "";
}

function closeAllMsgActions() {
  el.chat.querySelectorAll(".msg-row.active").forEach((row) => row.classList.remove("active"));
}

function appendMessage(role, content, index = null) {
  if (role === "system") {
    const div = document.createElement("div");
    div.className = "msg system";
    div.textContent = content;
    el.chat.appendChild(div);
    el.chat.scrollTop = el.chat.scrollHeight;
    return div;
  }

  const row = document.createElement("div");
  row.className = `msg-row ${role}`;
  if (index != null) row.dataset.index = String(index);

  const bubble = document.createElement("div");
  bubble.className = `msg ${role}`;
  bubble.textContent = content;

  const actions = document.createElement("div");
  actions.className = "msg-actions";
  actions.innerHTML = `
    <button type="button" class="msg-act" data-act="retry" title="重试" aria-label="重试">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 6V3L8 7l4 4V8c2.76 0 5 2.24 5 5a5 5 0 0 1-8.9 3.1l-1.46 1.46A7 7 0 0 0 19 13c0-3.87-3.13-7-7-7zm-5 7c0-1.18.41-2.26 1.1-3.1L6.64 8.44A7 7 0 0 0 12 20v3l4-4-4-4v3a5 5 0 0 1-5-5z"/></svg>
    </button>
    <button type="button" class="msg-act" data-act="delete" title="删除" aria-label="删除">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v9h-2V9zm4 0h2v9h-2V9zM7 9h2v9H7V9zm-1 12h12a1 1 0 0 0 1-1V8H5v12a1 1 0 0 0 1 1z"/></svg>
    </button>
    <button type="button" class="msg-act" data-act="copy" title="复制" aria-label="复制">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 4h10a2 2 0 0 1 2 2v10h-2V6H8V4zm-2 4h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2zm0 2v10h10V10H6z"/></svg>
      <span class="msg-act-label">复制</span>
    </button>
  `;

  row.appendChild(bubble);
  row.appendChild(actions);
  el.chat.appendChild(row);
  el.chat.scrollTop = el.chat.scrollHeight;
  return row;
}

function renderChat() {
  el.chat.innerHTML = "";
  appendMessage("system", "你好，我是小豆，你的 AI 语音通话助手。可以打字，也可以按住麦克风说话。");
  messages.forEach((m, index) => {
    if (m.role === "user" || m.role === "assistant") appendMessage(m.role, m.content, index);
  });
}

async function copyMessageText(text) {
  const value = String(text || "");
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
    } else {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setStatus("已复制");
  } catch (err) {
    setStatus(`复制失败：${err.message || err}`);
  }
}

async function deleteMessageAt(index) {
  if (index < 0 || index >= messages.length) return;
  if (busy) {
    setStatus("正在处理，请稍后再删");
    return;
  }
  messages.splice(index, 1);
  await saveHistory();
  renderChat();
  setStatus("已删除消息");
}

async function retryMessageAt(index) {
  if (busy) {
    setStatus("正在处理，请稍后再试");
    return;
  }
  if (index < 0 || index >= messages.length) return;
  const item = messages[index];
  if (!item) return;

  if (item.role === "user") {
    const content = String(item.content || "").trim();
    messages = messages.slice(0, index);
    await saveHistory();
    renderChat();
    await sendText(content);
    return;
  }

  if (item.role === "assistant") {
    messages = messages.slice(0, index);
    await saveHistory();
    renderChat();
    await regenerateAssistant();
  }
}


async function requestChatJson(requestMessages) {
  const controller = new AbortController();
  const chatTimer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: requestMessages, config: apiConfigPayload() }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const reply = String(data.reply || "").trim();
    if (!reply) throw new Error("模型没有返回文字，请换模型或稍后再试");
    return { reply, webSearch: data.webSearch || null };
  } finally {
    clearTimeout(chatTimer);
  }
}

function parseSseEventBlock(block) {
  let eventName = "message";
  const dataLines = [];
  for (const rawLine of String(block || "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) eventName = line.slice(6).trim() || "message";
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  return { eventName, dataText: dataLines.join("\n").trim() };
}

function assistantBubble(row) {
  return row?.querySelector?.(".msg.assistant") || row;
}

function setAssistantText(row, text) {
  const bubble = assistantBubble(row);
  if (bubble) bubble.textContent = text || "…";
  el.chat.scrollTop = el.chat.scrollHeight;
}

async function requestChatStreamWithFallback(requestMessages, row) {
  let reply = "";
  let webSearch = null;
  let sawDelta = false;
  const controller = new AbortController();
  const chatTimer = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: requestMessages, config: apiConfigPayload() }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { beforeDelta: true });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const handleBlock = (block) => {
      const { eventName, dataText } = parseSseEventBlock(block);
      if (!dataText || dataText === "[DONE]") return;
      let data = {};
      try { data = JSON.parse(dataText); } catch { data = { text: dataText }; }
      if (eventName === "delta") {
        const text = String(data.text || "");
        if (text) {
          sawDelta = true;
          reply += text;
          setAssistantText(row, reply);
        }
        return;
      }
      if (eventName === "done") {
        if (data.reply) {
          reply = String(data.reply || "").trim();
          setAssistantText(row, reply);
        }
        webSearch = data.webSearch || null;
        return;
      }
      if (eventName === "error") {
        const err = new Error(data.error || "流式生成失败");
        err.partial = data.partial || reply;
        throw err;
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx2;
      while ((idx2 = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx2);
        buffer = buffer.slice(idx2 + 2);
        handleBlock(block);
      }
    }
    const tail = decoder.decode();
    if (tail) buffer += tail;
    if (buffer.trim()) handleBlock(buffer);
    reply = reply.trim();
    if (!reply) throw Object.assign(new Error("模型没有返回文字，请换模型或稍后再试"), { beforeDelta: !sawDelta });
    return { reply, webSearch, streamed: true };
  } catch (err) {
    if (sawDelta || err.partial) {
      err.partial = String(err.partial || reply || "").trim();
      throw err;
    }
    console.warn("stream chat failed before output; fallback to /api/chat", err);
    const data = await requestChatJson(requestMessages);
    setAssistantText(row, data.reply);
    return { ...data, streamed: false };
  } finally {
    clearTimeout(chatTimer);
  }
}

function removeAssistantPlaceholder(row, index) {
  if (Number.isInteger(index) && messages[index]?.role === "assistant" && !messages[index].content) {
    messages.splice(index, 1);
  }
  row?.remove?.();
}

async function regenerateAssistant() {
  if (busy) return;
  if (!config.llm.apiKey) {
    openSettings();
    setSettingsStatus("请先填写本地 API Key");
    return;
  }
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    setStatus("没有可重试的用户消息");
    return;
  }

  busy = true;
  el.btnSend.disabled = true;
  el.btnHold.disabled = true;
  setStatus("正在重新生成…");

  const requestMessages = messages.slice();
  const assistantIndex = messages.length;
  messages.push({ role: "assistant", content: "" });
  const row = appendMessage("assistant", "…", assistantIndex);

  try {
    const data = await requestChatStreamWithFallback(requestMessages, row);
    messages[assistantIndex].content = data.reply;
    await saveHistory();
    let speakResult = { mode: "off" };
    if (config.autoSpeak) {
      setStatus("正在朗读…");
      speakResult = await speakText(data.reply);
    }
    setStatus(readyStatusAfterSpeak(speakResult));
  } catch (err) {
    const partial = String(err.partial || "").trim();
    if (partial) {
      messages[assistantIndex].content = partial;
      setAssistantText(row, partial);
      await saveHistory();
      setStatus(`生成中断：${explainFetchError(err)}`);
    } else {
      removeAssistantPlaceholder(row, assistantIndex);
      setStatus(`重试失败：${explainFetchError(err)}`);
    }
  } finally {
    busy = false;
    el.btnSend.disabled = false;
    el.btnHold.disabled = false;
  }
}

function resolveRuntimeService(service, role) {
  const list = ensureProviderList(config.apiProviders);
  const llmProvider = resolveServiceProvider(list, config.llm?.providerId, DEFAULT_PROVIDER_ID);
  const selectedId = String(service?.providerId || "").trim();
  const provider = role === "llm"
    ? llmProvider
    : (selectedId ? resolveServiceProvider(list, selectedId, llmProvider.id) : llmProvider);
  const payload = {
    baseUrl: provider.baseUrl || llmProvider.baseUrl || "",
    apiKey: provider.apiKey || llmProvider.apiKey || "",
    model: String(service?.model || "").trim(),
    apiType: normalizeApiType(service?.apiType),
  };
  if (role === "tts") payload.voice = String(service?.voice || "alloy").trim() || "alloy";
  return payload;
}

function readLiveSearchSettings() {
  const f = el.fields || {};
  return {
    webSearchEnabled: f.webSearchEnabled ? f.webSearchEnabled.checked : Boolean(config.webSearchEnabled),
    searchProvider: f.searchProvider ? (f.searchProvider.value || "auto") : (config.searchProvider || "auto"),
    searchApiKey: f.searchApiKey ? f.searchApiKey.value.trim() : (config.searchApiKey || ""),
    searchBaseUrl: f.searchBaseUrl ? f.searchBaseUrl.value.trim() : (config.searchBaseUrl || ""),
  };
}

function applyLiveSearchSettings({ persist = false, quiet = true } = {}) {
  const next = readLiveSearchSettings();
  config = normalizeConfig({ ...config, ...next });
  if (persist) {
    saveConfig(config)
      .then(() => {
        if (!quiet) setSettingsStatus("搜索设置已保存并立即生效");
      })
      .catch((err) => {
        setSettingsStatus(`搜索设置保存失败：${err.message || err}`);
      });
  }
  return next;
}

function apiConfigPayload() {
  // 搜索开关容易被误会：这里直接读取设置面板当前值，哪怕还没点「保存到本地」也会对下一次对话生效。
  const liveSearch = readLiveSearchSettings();
  const runtimeConfig = normalizeConfig({ ...config, ...liveSearch });
  const llm = resolveRuntimeService(runtimeConfig.llm, "llm");
  const stt = resolveRuntimeService(runtimeConfig.stt, "stt");
  const tts = resolveRuntimeService(runtimeConfig.tts, "tts");
  return {
    llm,
    stt,
    tts,
    apiProviders: ensureProviderList(runtimeConfig.apiProviders).map((item) => ({
      id: item.id,
      name: item.name,
      baseUrl: item.baseUrl,
    })),
    systemPromptPreset: runtimeConfig.systemPromptPreset || inferPromptPreset(runtimeConfig.systemPrompt),
    systemPrompt: runtimeConfig.systemPrompt,
    maxHistoryTurns: Number(runtimeConfig.maxHistoryTurns) || 12,
    maxTokens: clampNumber(runtimeConfig.maxTokens, 512, 256, 1024),
    temperature: Number(runtimeConfig.temperature) || 0.7,
    ttsEnabled: Boolean(runtimeConfig.ttsEnabled),
    webSearchEnabled: Boolean(liveSearch.webSearchEnabled),
    searchProvider: liveSearch.searchProvider || "auto",
    searchApiKey: liveSearch.searchApiKey || "",
    searchBaseUrl: liveSearch.searchBaseUrl || "",
  };
}

function fillProviderSelect(selectEl, selectedId, { allowFollow = false } = {}) {
  if (!selectEl) return;
  const list = ensureProviderList(providersDraft);
  const current = String(selectedId || "");
  const options = [];
  if (allowFollow) {
    options.push(`<option value="">跟随大模型</option>`);
  }
  for (const item of list) {
    options.push(`<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`);
  }
  selectEl.innerHTML = options.join("") || `<option value="">暂无供应商</option>`;
  if (current && list.some((item) => item.id === current)) {
    selectEl.value = current;
  } else if (allowFollow) {
    selectEl.value = "";
  } else if (list[0]) {
    selectEl.value = list[0].id;
  } else {
    selectEl.value = "";
  }
}

function usedProviderTags(providerId) {
  const tags = [];
  if (el.fields.llmProviderId?.value === providerId) tags.push("LLM");
  if (el.fields.sttProviderId?.value === providerId) tags.push("语音识别");
  if (el.fields.ttsProviderId?.value === providerId) tags.push("TTS");
  return tags;
}

function syncProviderPicker(list) {
  const picker = el.fields.apiProviderPicker;
  if (!picker) return null;
  if (!list.length) {
    picker.innerHTML = `<option value="">暂无供应商</option>`;
    picker.value = "";
    selectedProviderDraftId = "";
    picker.disabled = true;
    return null;
  }
  picker.disabled = false;
  if (!findProviderById(list, selectedProviderDraftId)) {
    selectedProviderDraftId = list[0].id;
  }
  picker.innerHTML = list.map((item) => {
    const keyState = item.apiKey ? "已填 Key" : "未填 Key";
    return `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${keyState}</option>`;
  }).join("");
  picker.value = selectedProviderDraftId;
  return findProviderById(list, selectedProviderDraftId) || list[0];
}

function selectedProviderDraft() {
  const list = ensureProviderList(providersDraft);
  providersDraft = list;
  return syncProviderPicker(list);
}

function renderProviderList() {
  const box = el.fields.apiProviderList;
  if (!box) return;
  const list = ensureProviderList(providersDraft);
  providersDraft = list;
  const item = syncProviderPicker(list);
  if (!item) {
    box.innerHTML = `<div class="provider-empty">还没有供应商。先点「新增供应商」，填写 Base URL 和 API Key。</div>`;
    return;
  }
  const tags = usedProviderTags(item.id);
  const tagHtml = [
    item.apiKey
      ? `<span class="provider-tag ok">Key 已填</span>`
      : `<span class="provider-tag warn">Key 未填</span>`,
    ...tags.map((tag) => `<span class="provider-tag">${escapeHtml(tag)}</span>`),
  ].join("");
  const editing = providerEditorMode === "edit" && el.fields.providerEditId?.value === item.id;
  box.innerHTML = `
    <div class="provider-item provider-item-selected${editing ? " active" : ""}" data-provider-id="${escapeHtml(item.id)}">
      <div class="provider-item-main">
        <div class="provider-item-title">${escapeHtml(item.name)}</div>
        <div class="provider-item-meta">${escapeHtml(item.baseUrl || "未填写 Base URL")}</div>
        <div class="provider-item-tags">${tagHtml}</div>
      </div>
    </div>
  `;
}

function refreshProviderSelects(selected = {}) {
  fillProviderSelect(el.fields.llmProviderId, selected.llm ?? el.fields.llmProviderId?.value ?? config.llm.providerId, { allowFollow: false });
  fillProviderSelect(el.fields.sttProviderId, selected.stt ?? el.fields.sttProviderId?.value ?? config.stt.providerId, { allowFollow: true });
  fillProviderSelect(el.fields.ttsProviderId, selected.tts ?? el.fields.ttsProviderId?.value ?? config.tts.providerId, { allowFollow: true });
  renderProviderList();
}

function closeProviderEditor() {
  providerEditorMode = "";
  if (el.fields.providerEditor) el.fields.providerEditor.classList.add("hidden");
  if (el.fields.providerEditId) el.fields.providerEditId.value = "";
  if (el.fields.providerName) el.fields.providerName.value = "";
  if (el.fields.providerBaseUrl) el.fields.providerBaseUrl.value = "";
  if (el.fields.providerApiKey) {
    el.fields.providerApiKey.value = "";
    el.fields.providerApiKey.type = "password";
  }
  const eye = document.querySelector('[data-eye-for="providerApiKey"]');
  if (eye) {
    eye.textContent = "👁";
    eye.setAttribute("aria-pressed", "false");
    eye.title = "显示密钥";
  }
  renderProviderList();
}

function openProviderEditor(provider = null) {
  if (!el.fields.providerEditor) return;
  if (provider?.id) selectedProviderDraftId = provider.id;
  providerEditorMode = provider ? "edit" : "add";
  el.fields.providerEditor.classList.remove("hidden");
  el.fields.providerEditId.value = provider?.id || "";
  el.fields.providerName.value = provider?.name || "";
  el.fields.providerBaseUrl.value = provider?.baseUrl || "https://api.siliconflow.cn/v1";
  el.fields.providerApiKey.value = provider?.apiKey || "";
  el.fields.providerName.focus();
  renderProviderList();
}

function saveProviderEditor() {
  const name = el.fields.providerName?.value.trim() || "未命名供应商";
  const baseUrl = el.fields.providerBaseUrl?.value.trim() || "";
  const apiKey = el.fields.providerApiKey?.value.trim() || "";
  if (!baseUrl) {
    setSettingsStatus("请填写供应商 Base URL");
    el.fields.providerBaseUrl?.focus();
    return false;
  }
  const editId = el.fields.providerEditId?.value || "";
  if (editId) {
    providersDraft = ensureProviderList(providersDraft).map((item) => (
      item.id === editId ? makeProvider({ id: editId, name, baseUrl, apiKey }) : item
    ));
    selectedProviderDraftId = editId;
  } else {
    const provider = makeProvider({ name, baseUrl, apiKey });
    providersDraft = [
      ...ensureProviderList(providersDraft),
      provider,
    ];
    selectedProviderDraftId = provider.id;
  }
  closeProviderEditor();
  refreshProviderSelects();
  setSettingsStatus("供应商已更新，记得点底部「保存到本地」");
  return true;
}

function deleteProvider(providerId) {
  const list = ensureProviderList(providersDraft);
  if (list.length <= 1) {
    setSettingsStatus("至少保留一个供应商");
    return;
  }
  const target = findProviderById(list, providerId);
  if (!target) return;
  if (!confirm(`确定删除供应商「${target.name}」？`)) return;
  providersDraft = list.filter((item) => item.id !== providerId);
  if (selectedProviderDraftId === providerId) {
    selectedProviderDraftId = providersDraft[0]?.id || "";
  }
  if (el.fields.llmProviderId?.value === providerId) {
    el.fields.llmProviderId.value = providersDraft[0]?.id || "";
  }
  if (el.fields.sttProviderId?.value === providerId) {
    el.fields.sttProviderId.value = "";
  }
  if (el.fields.ttsProviderId?.value === providerId) {
    el.fields.ttsProviderId.value = "";
  }
  if (el.fields.providerEditId?.value === providerId) closeProviderEditor();
  refreshProviderSelects();
  setSettingsStatus("供应商已删除，记得点底部「保存到本地」");
}

function fillSettingsForm() {
  const f = el.fields;
  providersDraft = ensureProviderList(config.apiProviders);
  selectedProviderDraftId = findProviderById(providersDraft, selectedProviderDraftId)?.id
    || findProviderById(providersDraft, config.llm.providerId)?.id
    || providersDraft[0]?.id
    || "";
  closeProviderEditor();
  refreshProviderSelects({
    llm: config.llm.providerId,
    stt: config.stt.providerId,
    tts: config.tts.providerId,
  });
  f.llmModel.value = config.llm.model || "";
  if (f.llmApiType) f.llmApiType.value = normalizeApiType(config.llm.apiType, DEFAULTS.llm.apiType);
  f.sttModel.value = config.stt.model || "";
  if (f.sttApiType) f.sttApiType.value = normalizeApiType(config.stt.apiType, DEFAULTS.stt.apiType);
  f.ttsModel.value = config.tts.model || "";
  setTtsVoiceFormValue(config.tts.voice || "");
  if (f.ttsApiType) f.ttsApiType.value = normalizeApiType(config.tts.apiType, DEFAULTS.tts.apiType);
  const promptPreset = inferPromptPreset(config.systemPrompt, config.systemPromptPreset || "general");
  if (f.systemPromptPreset) f.systemPromptPreset.value = promptPreset;
  f.systemPrompt.value = config.systemPrompt || SYSTEM_PROMPT_PRESETS.general.prompt;
  f.maxHistoryTurns.value = config.maxHistoryTurns ?? 12;
  f.maxTokens.value = config.maxTokens ?? 512;
  f.temperature.value = config.temperature ?? 0.7;
  f.ttsEnabled.checked = Boolean(config.ttsEnabled);
  f.browserTtsFallback.checked = Boolean(config.browserTtsFallback);
  f.autoSpeak.checked = Boolean(config.autoSpeak);
  syncVoiceToggle();
  if (f.webSearchEnabled) f.webSearchEnabled.checked = config.webSearchEnabled !== false;
  if (f.searchProvider) f.searchProvider.value = config.searchProvider || "auto";
  if (f.searchApiKey) f.searchApiKey.value = config.searchApiKey || "";
  if (f.searchBaseUrl) f.searchBaseUrl.value = config.searchBaseUrl || "";
}

function readSettingsForm() {
  const f = el.fields;
  const apiProviders = ensureProviderList(providersDraft);
  const llmProviderId = String(f.llmProviderId?.value || apiProviders[0]?.id || DEFAULT_PROVIDER_ID);
  return deepMerge(DEFAULTS, {
    apiProviders,
    llm: {
      providerId: llmProviderId,
      model: f.llmModel.value.trim(),
      apiType: normalizeApiType(f.llmApiType?.value, DEFAULTS.llm.apiType),
    },
    stt: {
      providerId: String(f.sttProviderId?.value || ""),
      model: f.sttModel.value.trim(),
      apiType: normalizeApiType(f.sttApiType?.value, DEFAULTS.stt.apiType),
    },
    tts: {
      providerId: String(f.ttsProviderId?.value || ""),
      model: f.ttsModel.value.trim(),
      voice: readTtsVoiceFormValue(),
      apiType: normalizeApiType(f.ttsApiType?.value, DEFAULTS.tts.apiType),
    },
    systemPromptPreset: inferPromptPreset(f.systemPrompt.value, f.systemPromptPreset?.value || "general"),
    systemPrompt: f.systemPrompt.value.trim() || SYSTEM_PROMPT_PRESETS.general.prompt,
    maxHistoryTurns: Number(f.maxHistoryTurns.value || 12),
    maxTokens: clampNumber(f.maxTokens.value, 512, 256, 1024),
    temperature: Number(f.temperature.value || 0.7),
    ttsEnabled: f.ttsEnabled.checked,
    browserTtsFallback: f.browserTtsFallback.checked,
    autoSpeak: f.autoSpeak.checked,
    webSearchEnabled: f.webSearchEnabled ? f.webSearchEnabled.checked : true,
    searchProvider: f.searchProvider ? (f.searchProvider.value || "auto") : "auto",
    searchApiKey: f.searchApiKey ? f.searchApiKey.value.trim() : "",
    searchBaseUrl: f.searchBaseUrl ? f.searchBaseUrl.value.trim() : "",
  });
}

function switchSettingsTab(tabName) {
  const name = tabName || "providers";
  document.querySelectorAll(".settings-tab").forEach((btn) => {
    const active = btn.getAttribute("data-tab") === name;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".settings-panel").forEach((panel) => {
    const active = panel.getAttribute("data-panel") === name;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
}

function openSettings() {
  fillSettingsForm();
  switchSettingsTab("providers");
  el.settingsModal.classList.remove("hidden");
  setSettingsStatus("配置保存在本机 IndexedDB，可导入/导出。");
}

function closeSettings() {
  el.settingsModal.classList.add("hidden");
}

async function exportConfig(includeKeys = true) {
  // 导出前先读表单，避免“填了 Key 但没点保存”导致导出空 Key
  const draft = readSettingsForm();
  if (includeKeys) {
    await saveConfig(draft);
    fillSettingsForm();
  }
  const data = structuredClone(includeKeys ? config : draft);
  data.exportedAt = new Date().toISOString();
  data.app = "ai-voice-call";
  data.version = 1;
  if (!includeKeys) {
    data.apiProviders = ensureProviderList(data.apiProviders).map((item) => ({
      ...item,
      apiKey: "",
    }));
    data.llm = { ...(data.llm || {}), apiKey: "" };
    data.stt = { ...(data.stt || {}), apiKey: "" };
    data.tts = { ...(data.tts || {}), apiKey: "" };
    data.searchApiKey = "";
  }
  const hasKey = Boolean(
    (data.apiProviders || []).some((item) => item?.apiKey) ||
    data.llm?.apiKey ||
    data.stt?.apiKey ||
    data.tts?.apiKey ||
    data.searchApiKey
  );
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = URL.createObjectURL(blob);
  a.download = includeKeys
    ? `ai-voice-call-config-full-${stamp}.json`
    : `ai-voice-call-config-nokey-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  if (includeKeys) {
    setSettingsStatus(hasKey
      ? "已导出完整配置（含 Key）。文件请自己保管，不要发到网上"
      : "已导出，但 Key 仍是空的：请先在表单填写 API Key 再导出");
  } else {
    setSettingsStatus("已导出配置（不含 Key）");
  }
}

async function importConfigFile(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  const incoming = parsed.llm || parsed.stt || parsed.tts ? parsed : parsed.config;
  if (!incoming || typeof incoming !== "object") throw new Error("未识别的配置文件");
  await saveConfig(incoming);
  fillSettingsForm();
  setSettingsStatus("导入成功，已保存到本机数据库");
  setStatus(config.llm.apiKey ? "本地配置已就绪" : "请填写 API Key");
}

async function testConnection() {
  const draft = normalizeConfig(readSettingsForm());
  setSettingsStatus("测试中…");
  const res = await fetch("/api/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      config: {
        llm: {
          baseUrl: draft.llm.baseUrl,
          apiKey: draft.llm.apiKey,
          model: draft.llm.model,
          apiType: draft.llm.apiType,
        },
        stt: {
          baseUrl: draft.stt.baseUrl || draft.llm.baseUrl,
          apiKey: draft.stt.apiKey || draft.llm.apiKey,
          model: draft.stt.model,
          apiType: draft.stt.apiType,
        },
        tts: {
          baseUrl: draft.tts.baseUrl || draft.llm.baseUrl,
          apiKey: draft.tts.apiKey || draft.llm.apiKey,
          model: draft.tts.model,
          voice: draft.tts.voice,
          apiType: draft.tts.apiType,
        },
        systemPrompt: draft.systemPrompt,
        maxTokens: draft.maxTokens,
        temperature: draft.temperature,
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data.error || data?.llmTest?.error || `HTTP ${res.status}`);
  }
  setSettingsStatus(`连接成功：${data.llmTest?.reply || "OK"}（模型 ${data.llm?.model || draft.llm.model}）`);
}

function explainFetchError(err) {
  const msg = String(err?.message || err || "");
  const name = String(err?.name || "");
  if (name === "AbortError" || /aborted|timeout|timed out/i.test(msg)) {
    return "等待超时。可能是模型太慢、联网搜索卡住，或本地服务无响应。请重试，或在本地配置里先关掉联网搜索";
  }
  if (/failed to fetch/i.test(msg) || /networkerror/i.test(msg) || /load failed/i.test(msg)) {
    return "连不上本地服务。请双击一键启动.cmd，确认服务已启动；电脑用 http://127.0.0.1:8787，手机录音请用 https://电脑IP:8788";
  }
  return msg;
}


function isWeChatBrowser() {
  return /MicroMessenger/i.test(navigator.userAgent || "");
}

function isInsecureContext() {
  // 手机用 http://192.168.x.x 时通常不是安全环境，麦克风会被禁用
  if (typeof window.isSecureContext === "boolean") return !window.isSecureContext;
  return location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1";
}

function ensureMediaDevices() {
  if (!navigator.mediaDevices) navigator.mediaDevices = {};
  if (typeof navigator.mediaDevices.getUserMedia === "function") return true;
  const legacy = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia;
  if (!legacy) return false;
  navigator.mediaDevices.getUserMedia = (constraints) => new Promise((resolve, reject) => {
    legacy.call(navigator, constraints, resolve, reject);
  });
  return true;
}

function micUnsupportedHint() {
  const wechat = isWeChatBrowser();
  const insecure = isInsecureContext();
  if (wechat && insecure) {
    return "微信内用 HTTP 不能录音。请：1) 右上角···→在浏览器打开 2) 地址改成 https://你的电脑IP:8788";
  }
  if (wechat) {
    return "微信内置浏览器录音受限。请点右上角···→在浏览器打开后再按住说话";
  }
  if (insecure) {
    return "当前是 HTTP 局域网地址，浏览器禁止麦克风。请用 https://电脑IP:8788 打开（首次点继续访问）";
  }
  return "当前浏览器不支持录音，请用系统浏览器（Chrome/Safari）打开";
}

function micPermissionHint(err) {
  const name = err?.name || "";
  const msg = String(err?.message || err || "");
  if (name === "NotAllowedError" || /permission|denied|not allowed/i.test(msg)) {
    return isWeChatBrowser()
      ? "麦克风权限被拒绝。请在浏览器打开，并允许麦克风权限"
      : "麦克风权限被拒绝，请在浏览器设置里允许麦克风";
  }
  if (name === "NotFoundError") return "未找到麦克风设备";
  if (name === "NotReadableError") return "麦克风被占用，请关闭其他录音应用";
  if (isInsecureContext() || !ensureMediaDevices()) return micUnsupportedHint();
  return "无法开麦：" + msg;
}

function supportsBrowserSpeech() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function pickRecorderMime() {
  const list = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  if (!window.MediaRecorder?.isTypeSupported) return "";
  return list.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

function clearRestartTimer() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function setHoldingUI(on) {
  if (on) {
    el.btnHold.classList.add("recording");
    el.btnHold.setAttribute("aria-pressed", "true");
    el.btnHold.title = "松开结束";
  } else {
    el.btnHold.classList.remove("recording");
    el.btnHold.setAttribute("aria-pressed", "false");
    el.btnHold.title = "按住说话";
  }
}

function createBrowserSpeech() {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = "zh-CN";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  return rec;
}

function bindBrowserSpeechHandlers(rec) {
  rec.onresult = (event) => {
    let interim = "";
    let finalText = "";
    for (let i = 0; i < event.results.length; i += 1) {
      const piece = event.results[i][0]?.transcript || "";
      if (event.results[i].isFinal) finalText += piece;
      else interim += piece;
    }
    if (finalText.trim()) {
      browserTranscript = `${browserTranscript} ${finalText}`.replace(/\s+/g, " ").trim();
    }
    const live = (browserTranscript || interim || "").trim();
    if (live) setStatus(`听到：${live}`);
  };

  rec.onerror = (event) => {
    const err = event?.error || "speech error";
    if (err === "no-speech" || err === "aborted" || err === "speech-too-short") return;
    if (err === "not-allowed") {
      holdActive = false;
      browserUsing = false;
      recording = false;
      setHoldingUI(false);
      setStatus("请允许浏览器使用麦克风");
      return;
    }
    setStatus(`浏览器识别提示：${err}`);
  };

  rec.onend = () => {
    // Browser may auto-stop on pause. If still holding, restart.
    if (holdActive && browserUsing) {
      clearRestartTimer();
      restartTimer = setTimeout(() => {
        if (!holdActive || !browserUsing) return;
        try {
          browserRec = createBrowserSpeech();
          if (!browserRec) return;
          bindBrowserSpeechHandlers(browserRec);
          browserRec.start();
          setStatus((browserTranscript ? `听到：${browserTranscript}；` : "") + "继续说…");
        } catch {
          clearRestartTimer();
          restartTimer = setTimeout(() => {
            if (!holdActive || !browserUsing) return;
            try {
              browserRec = createBrowserSpeech();
              if (!browserRec) return;
              bindBrowserSpeechHandlers(browserRec);
              browserRec.start();
            } catch {}
          }, 220);
        }
      }, 140);
      return;
    }
    browserUsing = false;
    browserRec = null;
    recording = false;
    setHoldingUI(false);
  };
}

async function finishBrowserSpeechAndSend() {
  const text = (browserTranscript || "").trim();
  browserTranscript = "";
  if (!text) {
    setStatus("没听清，请按住多说一会儿，说完再松开");
    return;
  }
  setStatus("识别到：" + text);
  await sendText(text);
}

function browserSpeak(text) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window)) {
      resolve(false);
      return;
    }
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "zh-CN";
    utter.rate = 0.95;
    utter.onend = () => resolve(true);
    utter.onerror = () => resolve(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  });
}

async function speakText(text) {
  if (!config.autoSpeak) return { mode: "off" };
  let onlineError = "";
  if (config.ttsEnabled) {
    try {
      const controller = new AbortController();
      const ttsTimer = setTimeout(() => controller.abort(), 20000);
      let res;
      try {
        res = await fetch("/api/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, config: apiConfigPayload() }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(ttsTimer);
      }
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
        audio.addEventListener("error", () => URL.revokeObjectURL(url), { once: true });
        await audio.play();
        return { mode: "online" };
      }
      const data = await res.json().catch(() => ({}));
      onlineError = data.error || `HTTP ${res.status}`;
      console.warn("在线 TTS 失败", { status: res.status, ...data });
    } catch (err) {
      onlineError = err && err.name === "AbortError" ? "TTS 请求超时" : explainFetchError(err);
      console.warn("在线 TTS 失败", err);
    }
  }
  if (config.browserTtsFallback) {
    const ok = await browserSpeak(text);
    if (onlineError) return { mode: ok ? "browser" : "browser-failed", error: onlineError };
    return { mode: ok ? "browser" : "browser-failed" };
  }
  if (onlineError) return { mode: "failed", error: onlineError };
  return { mode: "skipped" };
}

function readyStatusAfterSpeak(result) {
  if (result?.mode === "browser" && result.error) return `在线 TTS 失败，已用浏览器朗读：${result.error}`;
  if (result?.mode === "browser-failed" && result.error) return `在线 TTS 失败，浏览器朗读也失败：${result.error}`;
  if (result?.mode === "browser-failed") return "浏览器朗读失败，请检查系统语音设置";
  if (result?.mode === "failed") return `朗读失败：${result.error || "未知错误"}`;
  return "";
}

async function sendText(text) {
  const content = (text || "").trim();
  if (!content || busy) return;
  if (!config.llm.apiKey) {
    openSettings();
    setSettingsStatus("请先填写本地 API Key");
    return;
  }

  busy = true;
  el.btnSend.disabled = true;
  el.btnHold.disabled = true;
  await ensureConversationReady();
  messages.push({ role: "user", content });
  appendMessage("user", content, messages.length - 1);
  el.input.value = "";
  await saveHistory();
  setStatus("正在思考…");

  const requestMessages = messages.slice();
  const assistantIndex = messages.length;
  messages.push({ role: "assistant", content: "" });
  const row = appendMessage("assistant", "…", assistantIndex);

  try {
    const data = await requestChatStreamWithFallback(requestMessages, row);
    messages[assistantIndex].content = data.reply;
    await saveHistory();
    if (data.webSearch && data.webSearch.used) {
      const ws = data.webSearch;
      const flag = ws.ok ? `已联网(${ws.provider}, ${ws.count}条)` : `联网无结果(${ws.provider})`;
      setStatus(flag + "，可以继续聊");
    } else {
      setStatus("可以继续聊");
    }
    let speakResult = { mode: "off" };
    if (config.autoSpeak) {
      setStatus("正在朗读…");
      speakResult = await speakText(data.reply);
    }
    setStatus(readyStatusAfterSpeak(speakResult));
  } catch (err) {
    const partial = String(err.partial || "").trim();
    if (partial) {
      messages[assistantIndex].content = partial;
      setAssistantText(row, partial);
      await saveHistory();
      setStatus(`生成中断：${explainFetchError(err)}`);
    } else {
      removeAssistantPlaceholder(row, assistantIndex);
      setStatus(`发送失败：${explainFetchError(err)}`);
    }
  } finally {
    busy = false;
    el.btnSend.disabled = false;
    el.btnHold.disabled = false;
  }
}

let pcmChunks = [];
let pcmContext = null;
let pcmSource = null;
let pcmProcessor = null;
let pcmStream = null;
let pcmSampleRate = 16000;

function flattenPcm(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function floatTo16kWav(float32, inputRate) {
  const targetRate = 16000;
  const ratio = inputRate / targetRate;
  const newLen = Math.max(1, Math.floor(float32.length / ratio));
  const down = new Float32Array(newLen);
  for (let i = 0; i < newLen; i += 1) {
    down[i] = float32[Math.min(float32.length - 1, Math.floor(i * ratio))];
  }
  const buffer = new ArrayBuffer(44 + down.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + down.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, down.length * 2, true);
  let offset = 44;
  for (let i = 0; i < down.length; i += 1) {
    let s = Math.max(-1, Math.min(1, down[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function startPcmCapture() {
  if (!ensureMediaDevices()) throw new Error(micUnsupportedHint());
  pcmStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  pcmContext = new AudioCtx();
  pcmSampleRate = pcmContext.sampleRate;
  pcmSource = pcmContext.createMediaStreamSource(pcmStream);
  pcmProcessor = pcmContext.createScriptProcessor(4096, 1, 1);
  pcmChunks = [];
  pcmProcessor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    pcmChunks.push(new Float32Array(input));
  };
  pcmSource.connect(pcmProcessor);
  pcmProcessor.connect(pcmContext.destination);
}

function stopPcmCapture() {
  try { pcmProcessor && pcmProcessor.disconnect(); } catch {}
  try { pcmSource && pcmSource.disconnect(); } catch {}
  try { pcmStream && pcmStream.getTracks().forEach((t) => t.stop()); } catch {}
  try { pcmContext && pcmContext.close(); } catch {}
  const samples = flattenPcm(pcmChunks);
  const blob = floatTo16kWav(samples, pcmSampleRate || 48000);
  pcmProcessor = null;
  pcmSource = null;
  pcmStream = null;
  pcmContext = null;
  pcmChunks = [];
  return blob;
}
function hasSttKey() {
  return Boolean((config.stt.apiKey || config.llm.apiKey || "").trim());
}

function preferServerAsr() {
  return hasSttKey();
}

async function blobToWav(blob) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return blob;
  const ctx = new AudioCtx();
  try {
    const arr = await blob.arrayBuffer();
    const audioBuf = await ctx.decodeAudioData(arr.slice(0));
    const samples = audioBuf.numberOfChannels > 1 ? mixToMono(audioBuf) : audioBuf.getChannelData(0);
    return new Blob([encodeWav(samples, audioBuf.sampleRate)], { type: "audio/wav" });
  } finally {
    try { await ctx.close(); } catch {}
  }
}

function mixToMono(audioBuf) {
  const len = audioBuf.length;
  const mono = new Float32Array(len);
  const ch = audioBuf.numberOfChannels;
  for (let c = 0; c < ch; c++) {
    const data = audioBuf.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += data[i] / ch;
  }
  return mono;
}

function encodeWav(samples, sampleRate) {
  const targetRate = 16000;
  const ratio = sampleRate / targetRate;
  const newLen = Math.max(1, Math.floor(samples.length / ratio));
  const down = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) down[i] = samples[Math.min(samples.length - 1, Math.floor(i * ratio))];
  const buffer = new ArrayBuffer(44 + down.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + down.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, down.length * 2, true);
  let offset = 44;
  for (let i = 0; i < down.length; i++) {
    let s = Math.max(-1, Math.min(1, down[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

let holdStartedAt = 0;
const MIN_HOLD_MS = 1000;

async function startRecording(gen = holdGeneration) {
  if (busy || holdActive || recording) return;
  if (preferServerAsr()) {
    if (isInsecureContext() || !ensureMediaDevices()) {
      setStatus(micUnsupportedHint());
      document.body.classList.remove("holding-mic");
      return;
    }
    try {
      await startPcmCapture();
      if (gen !== holdGeneration) {
        try { stopPcmCapture(); } catch {}
        holdActive = false;
        recording = false;
        setHoldingUI(false);
        document.body.classList.remove("holding-mic");
        return;
      }
      holdActive = true;
      recording = true;
      holdStartedAt = Date.now();
      browserUsing = false;
      mediaRecorder = null;
      setHoldingUI(true);
      setStatus("正在录音…靠近麦克风，至少说1秒，说完再松开");
      return;
    } catch (err) {
      holdActive = false;
      recording = false;
      setHoldingUI(false);
      document.body.classList.remove("holding-mic");
      setStatus(micPermissionHint(err));
    }
  }
  if (gen !== holdGeneration) {
    setHoldingUI(false);
    document.body.classList.remove("holding-mic");
    return;
  }
  if (supportsBrowserSpeech()) {
    try {
      browserTranscript = "";
      browserUsing = true;
      holdActive = true;
      recording = true;
      holdStartedAt = Date.now();
      clearRestartTimer();
      browserRec = createBrowserSpeech();
      if (!browserRec) throw new Error("no speech api");
      if (gen !== holdGeneration) {
        try { browserRec.abort && browserRec.abort(); } catch {}
        browserRec = null;
        browserUsing = false;
        holdActive = false;
        recording = false;
        setHoldingUI(false);
        document.body.classList.remove("holding-mic");
        return;
      }
      bindBrowserSpeechHandlers(browserRec);
      browserRec.start();
      setHoldingUI(true);
      setStatus("正在听你说…（浏览器识别备选）说完再松开");
      return;
    } catch {
      browserUsing = false;
      holdActive = false;
      recording = false;
      browserRec = null;
      setHoldingUI(false);
      document.body.classList.remove("holding-mic");
      setStatus("无法开始语音识别，请检查麦克风权限和 API Key");
    }
  } else {
    document.body.classList.remove("holding-mic");
    setStatus("当前环境无法语音识别，请先配置 API");
  }
}

async function stopRecording() {
  document.body.classList.remove("holding-mic");
  if (!holdActive && !recording) {
    setHoldingUI(false);
    return;
  }
  const heldMs = Date.now() - (holdStartedAt || Date.now());
  holdActive = false;
  clearRestartTimer();
  setHoldingUI(false);

  if (browserUsing) {
    const rec = browserRec;
    browserUsing = false;
    recording = false;
    try { rec && rec.stop(); } catch {}
    browserRec = null;
    if (heldMs < MIN_HOLD_MS) {
      browserTranscript = "";
      setStatus("按住时间太短，请按住至少1秒再说话");
      return;
    }
    setTimeout(() => { finishBrowserSpeechAndSend(); }, 250);
    return;
  }

  if (pcmContext || pcmStream || pcmProcessor) {
    if (heldMs < MIN_HOLD_MS) {
      try { stopPcmCapture(); } catch {}
      recording = false;
      setStatus("按住时间太短，请按住至少1秒");
      return;
    }
    let blob;
    try { blob = stopPcmCapture(); }
    catch (err) {
      recording = false;
      setStatus("录音结束失败：" + (err.message || err));
      return;
    }
    recording = false;
    await handleRecordedAudio(blob);
    return;
  }

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    if (heldMs < MIN_HOLD_MS) setStatus("按住时间太短，请按住至少1秒");
    try {
      try { mediaRecorder.requestData(); } catch {}
      mediaRecorder.stop();
    } catch { recording = false; }
  } else {
    recording = false;
  }
}

async function handleRecordedAudio(blob) {
  const heldMs = Date.now() - (holdStartedAt || Date.now());
  if (!blob || blob.size < 1500 || heldMs < MIN_HOLD_MS) {
    setStatus("没录到有效声音。请靠近麦克风，按住至少1秒，大声说完再松开");
    return;
  }
  if (!hasSttKey()) {
    openSettings();
    setSettingsStatus("服务器识别需要 API Key，请先填写本地配置");
    return;
  }
  if (blob.size < 4000) {
    setStatus("声音太小或太短。请靠近麦克风，再说大声一点");
    return;
  }

  busy = true;
  el.btnSend.disabled = true;
  el.btnHold.disabled = true;
  setStatus("正在识别… (" + Math.round(blob.size / 1024) + "KB)");
  try {
    let uploadBlob = blob;
    let filename = "speech.wav";
    if (!(blob.type && blob.type.includes("wav"))) {
      try {
        setStatus("正在处理录音…");
        uploadBlob = await blobToWav(blob);
        filename = "speech.wav";
      } catch {
        const ext = blob.type.includes("mp4") ? "mp4" : blob.type.includes("ogg") ? "ogg" : "webm";
        filename = "speech." + ext;
        uploadBlob = blob;
      }
    }
    const form = new FormData();
    form.append("file", uploadBlob, filename);
    const cfg = apiConfigPayload();
    if (!cfg.stt.model || cfg.stt.model.includes("TeleSpeech")) {
      cfg.stt.model = "FunAudioLLM/SenseVoiceSmall";
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    let res;
    try {
      res = await fetch("/api/asr", {
        method: "POST",
        body: form,
        headers: {
          "x-client-config": btoa(unescape(encodeURIComponent(JSON.stringify(cfg)))),
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || ("HTTP " + res.status));
    const text = String(data.text || "").trim();
    if (!text) {
      setStatus("没有识别出文字。请靠近麦克风大声说，并确认语音识别模型为 FunAudioLLM/SenseVoiceSmall");
      return;
    }
    setStatus("识别到：" + text);
    busy = false;
    el.btnSend.disabled = false;
    el.btnHold.disabled = false;
    await sendText(text);
  } catch (err) {
    const msg = err && err.name === "AbortError" ? "识别超时，请再试一次" : explainFetchError(err);
    setStatus("识别失败：" + msg);
  } finally {
    busy = false;
    el.btnSend.disabled = false;
    el.btnHold.disabled = false;
  }
}


function bindMessageActions() {
  if (bindMessageActions._done || !el.chat) return;
  bindMessageActions._done = true;

  el.chat.addEventListener("click", async (e) => {
    const actBtn = e.target.closest(".msg-act");
    const row = e.target.closest(".msg-row");
    if (actBtn && row) {
      e.preventDefault();
      e.stopPropagation();
      const act = actBtn.getAttribute("data-act");
      const index = Number(row.dataset.index);
      if (!Number.isFinite(index)) return;
      const item = messages[index];
      if (!item) return;

      if (act === "copy") {
        await copyMessageText(item.content);
        actBtn.classList.add("done");
        const label = actBtn.querySelector(".msg-act-label");
        if (label) {
          const old = label.textContent;
          label.textContent = "已复制";
          setTimeout(() => {
            label.textContent = old || "复制";
            actBtn.classList.remove("done");
          }, 1200);
        }
        return;
      }
      if (act === "delete") {
        closeAllMsgActions();
        await deleteMessageAt(index);
        return;
      }
      if (act === "retry") {
        closeAllMsgActions();
        await retryMessageAt(index);
        return;
      }
      return;
    }

    if (row && (e.target.closest(".msg") || e.target === row)) {
      const isHoverDevice = window.matchMedia && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
      if (isHoverDevice) return;
      e.preventDefault();
      const open = row.classList.contains("active");
      closeAllMsgActions();
      if (!open) row.classList.add("active");
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".msg-row")) closeAllMsgActions();
  });
}

function bindSecretEyes() {
  if (bindSecretEyes._done) return;
  bindSecretEyes._done = true;
  document.querySelectorAll("[data-eye-for]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-eye-for");
      const input = id ? document.getElementById(id) : null;
      if (!input) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      btn.textContent = show ? "🙈" : "👁";
      btn.setAttribute("aria-pressed", show ? "true" : "false");
      btn.title = show ? "隐藏密钥" : "显示密钥";
      btn.setAttribute("aria-label", show ? "隐藏密钥" : "显示密钥");
    });
  });
}
async function initDefaults() {
  try {
    const res = await fetch("/api/defaults");
    const data = await res.json();
    serverDefaults = data?.defaults || null;
    if (serverDefaults && !(await hasAppConfig())) {
      config = normalizeConfig({
        apiProviders: [
          makeProvider({
            id: DEFAULT_PROVIDER_ID,
            name: "默认供应商",
            baseUrl: serverDefaults.llm?.baseUrl || "https://api.siliconflow.cn/v1",
            apiKey: "",
          }),
        ],
        llm: {
          providerId: DEFAULT_PROVIDER_ID,
          model: serverDefaults.llm?.model,
          apiType: serverDefaults.llm?.apiType || DEFAULTS.llm.apiType,
        },
        stt: {
          providerId: "",
          model: serverDefaults.stt?.model,
          apiType: serverDefaults.stt?.apiType || DEFAULTS.stt.apiType,
        },
        tts: {
          providerId: "",
          model: serverDefaults.tts?.model,
          voice: serverDefaults.tts?.voice,
          apiType: serverDefaults.tts?.apiType || DEFAULTS.tts.apiType,
        },
        systemPromptPreset: serverDefaults.systemPromptPreset || inferPromptPreset(serverDefaults.systemPrompt),
        systemPrompt: serverDefaults.systemPrompt,
        maxHistoryTurns: serverDefaults.maxHistoryTurns,
        maxTokens: serverDefaults.maxTokens,
        temperature: serverDefaults.temperature,
        ttsEnabled: serverDefaults.ttsEnabled,
        browserTtsFallback: serverDefaults.browserTtsFallback,
        webSearchEnabled: serverDefaults.webSearchEnabled,
        searchProvider: serverDefaults.searchProvider,
      });
    }
  } catch {}

  if (!config.llm.apiKey) {
    setStatus(supportsBrowserSpeech()
      ? "可先按住说话。聊天回复仍需在右上角填写 API"
      : "请先点右上角「设置」填写 API");
  } else if (isInsecureContext()) {
    setStatus(isWeChatBrowser()
      ? "微信HTTP不能录音：···→在浏览器打开，并用 https://电脑IP:8788"
      : "当前HTTP不能录音，请用 https://电脑IP:8788（手机录音需要HTTPS）");
  } else {
    setStatus("按住说话（服务器识别）。靠近麦克风，至少 1 秒，说完再松开");
  }
}

// events
function clearDomSelection() {
  try {
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
  } catch {}
}
function isHoldingTalk() {
  return holdActive || recording;
}

el.btnSend.addEventListener("click", (e) => {
  if (isHoldingTalk()) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  sendText(el.input.value);
});

el.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (isHoldingTalk()) return;
    sendText(el.input.value);
  }
});

async function handleNewChatClick(e) {
  if (e) {
    e.preventDefault();
    e.stopPropagation();
  }
  if (isHoldingTalk()) {
    setStatus("正在录音中，请先松开再操作");
    return;
  }
  if (messages.length && !window.confirm("开始新对话？当前对话会保留在历史里。")) return;
  try {
    await startNewConversation({ force: true });
  } catch (err) {
    setStatus(`新建失败：${err.message || err}`);
  }
}

if (el.btnNewChat) el.btnNewChat.addEventListener("click", handleNewChatClick);
if (el.btnNewChatFromHistory) {
  el.btnNewChatFromHistory.addEventListener("click", async (e) => {
    await handleNewChatClick(e);
    closeHistory();
  });
}
if (el.btnHistory) {
  el.btnHistory.addEventListener("click", (e) => {
    if (isHoldingTalk()) {
      e.preventDefault();
      e.stopPropagation();
      setStatus("正在录音中，请先松开再打开历史");
      return;
    }
    openHistory();
  });
}
if (el.btnCloseHistory) el.btnCloseHistory.addEventListener("click", closeHistory);
if (el.historyModal) {
  el.historyModal.addEventListener("click", (e) => {
    if (e.target === el.historyModal) closeHistory();
  });
}

if (el.btnVoice) el.btnVoice.addEventListener("click", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (isHoldingTalk()) {
    setStatus("正在录音中，请先松开再操作");
    return;
  }
  try {
    const next = !config.autoSpeak;
    await setAutoSpeak(next);
    setStatus(next ? "已开启语音朗读" : "已关闭语音，仅文字聊天");
  } catch (err) {
    setStatus(`切换语音失败：${err.message || err}`);
  }
});

if (el.fields?.ttsVoicePreset) {
  el.fields.ttsVoicePreset.addEventListener("change", () => syncTtsVoiceCustomInput(true));
}
// settings switches also update header voice icon
["autoSpeak", "ttsEnabled", "browserTtsFallback"].forEach((key) => {
  const input = el.fields?.[key];
  if (!input) return;
  input.addEventListener("change", () => {
    // live preview only; still need 保存到本地
    if (key === "autoSpeak") {
      config.autoSpeak = input.checked;
      syncVoiceToggle();
    }
  });
});

// Prompt preset dropdown fills the editable prompt; manual edits become 自定义.
if (el.fields?.systemPromptPreset && el.fields?.systemPrompt) {
  el.fields.systemPromptPreset.addEventListener("change", () => {
    const key = el.fields.systemPromptPreset.value;
    if (key === "custom") {
      el.fields.systemPrompt.focus();
      return;
    }
    const preset = SYSTEM_PROMPT_PRESETS[key] || SYSTEM_PROMPT_PRESETS.general;
    el.fields.systemPrompt.value = preset.prompt;
  });
  el.fields.systemPrompt.addEventListener("input", () => {
    const key = el.fields.systemPromptPreset.value;
    if (key !== "custom" && el.fields.systemPrompt.value.trim() !== SYSTEM_PROMPT_PRESETS[key]?.prompt) {
      el.fields.systemPromptPreset.value = "custom";
    }
  });
}


el.btnSettings.addEventListener("click", (e) => {
  if (isHoldingTalk()) {
    e.preventDefault();
    e.stopPropagation();
    setStatus("正在录音中，请先松开再打开配置");
    return;
  }
  openSettings();
});

el.btnCloseSettings.addEventListener("click", closeSettings);
document.querySelectorAll(".settings-tab").forEach((btn) => {
  btn.addEventListener("click", () => switchSettingsTab(btn.getAttribute("data-tab")));
});
el.settingsModal.addEventListener("click", (e) => {
  if (e.target === el.settingsModal) closeSettings();
});

el.fields.btnAddProvider?.addEventListener("click", () => openProviderEditor(null));
el.fields.btnEditSelectedProvider?.addEventListener("click", () => {
  const provider = selectedProviderDraft();
  if (provider) openProviderEditor(provider);
});
el.fields.btnDeleteSelectedProvider?.addEventListener("click", () => {
  const provider = selectedProviderDraft();
  if (provider) deleteProvider(provider.id);
});
el.fields.btnSaveProvider?.addEventListener("click", () => saveProviderEditor());
el.fields.btnCancelProvider?.addEventListener("click", () => closeProviderEditor());
el.fields.apiProviderPicker?.addEventListener("change", () => {
  selectedProviderDraftId = el.fields.apiProviderPicker.value;
  if (providerEditorMode === "edit") closeProviderEditor();
  renderProviderList();
});
el.fields.llmProviderId?.addEventListener("change", () => renderProviderList());
el.fields.sttProviderId?.addEventListener("change", () => renderProviderList());
el.fields.ttsProviderId?.addEventListener("change", () => renderProviderList());

["webSearchEnabled", "searchProvider", "searchApiKey", "searchBaseUrl"].forEach((key) => {
  const input = el.fields?.[key];
  if (!input) return;
  const eventName = input.tagName === "SELECT" || input.type === "checkbox" ? "change" : "input";
  input.addEventListener(eventName, () => {
    applyLiveSearchSettings({ persist: key === "webSearchEnabled" || key === "searchProvider", quiet: false });
  });
});

el.btnSaveSettings.addEventListener("click", async () => {
  try {
    if (providerEditorMode) {
      const ok = saveProviderEditor();
      if (!ok) return;
    }
    await saveConfig(readSettingsForm());
    syncVoiceToggle();
    setSettingsStatus("已保存到本机数据库");
    setStatus(config.llm.apiKey ? "本地配置已更新" : "请填写 API Key");
  } catch (err) {
    setSettingsStatus(`保存失败：${err.message || err}`);
  }
});

el.btnTest.addEventListener("click", async () => {
  try { await testConnection(); }
  catch (err) { setSettingsStatus(`测试失败：${err.message || err}`); }
});

el.btnExport.addEventListener("click", () => exportConfig(true));
el.btnExportSafe.addEventListener("click", () => exportConfig(false));
el.btnImport.addEventListener("click", () => el.importFile.click());
el.importFile.addEventListener("change", async () => {
  const file = el.importFile.files?.[0];
  el.importFile.value = "";
  if (!file) return;
  try { await importConfigFile(file); }
  catch (err) { setSettingsStatus(`导入失败：${err.message || err}`); }
});

el.btnReset.addEventListener("click", () => {
  const keepProviders = ensureProviderList(config.apiProviders);
  config = normalizeConfig({
    apiProviders: keepProviders,
    llm: {
      providerId: keepProviders[0]?.id || DEFAULT_PROVIDER_ID,
      model: serverDefaults?.llm?.model || DEFAULTS.llm.model,
      apiType: serverDefaults?.llm?.apiType || DEFAULTS.llm.apiType,
    },
    stt: {
      providerId: "",
      model: serverDefaults?.stt?.model || DEFAULTS.stt.model,
      apiType: serverDefaults?.stt?.apiType || DEFAULTS.stt.apiType,
    },
    tts: {
      providerId: "",
      model: serverDefaults?.tts?.model || DEFAULTS.tts.model,
      voice: serverDefaults?.tts?.voice || DEFAULTS.tts.voice,
      apiType: serverDefaults?.tts?.apiType || DEFAULTS.tts.apiType,
    },
    systemPromptPreset: serverDefaults?.systemPromptPreset || DEFAULTS.systemPromptPreset,
    systemPrompt: serverDefaults?.systemPrompt || DEFAULTS.systemPrompt,
    maxHistoryTurns: serverDefaults?.maxHistoryTurns ?? DEFAULTS.maxHistoryTurns,
    maxTokens: serverDefaults?.maxTokens ?? DEFAULTS.maxTokens,
    temperature: serverDefaults?.temperature ?? DEFAULTS.temperature,
    ttsEnabled: serverDefaults?.ttsEnabled ?? DEFAULTS.ttsEnabled,
    browserTtsFallback: serverDefaults?.browserTtsFallback ?? DEFAULTS.browserTtsFallback,
    autoSpeak: DEFAULTS.autoSpeak,
    webSearchEnabled: serverDefaults?.webSearchEnabled ?? DEFAULTS.webSearchEnabled,
    searchProvider: serverDefaults?.searchProvider || DEFAULTS.searchProvider,
  });
  fillSettingsForm();
  setSettingsStatus("已恢复默认（保留当前供应商列表和 Key）");
});

document.querySelectorAll(".quick [data-q]").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    if (isHoldingTalk()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    sendText(btn.getAttribute("data-q"));
  });
});

// ===== 按住说话：只录音，不锁输入，不用 pointer capture =====
let holdPointerId = null;
let holdListenersBound = false;

function endHold() {
  const shouldStop = holdActive || recording || browserUsing || pcmStream || pcmProcessor || pcmContext;
  holdGeneration += 1;
  holdPointerId = null;
  document.body.classList.remove("holding-mic");
  if (shouldStop) stopRecording();
  else setHoldingUI(false);
}

function onHoldPointerUp(e) {
  if (holdPointerId != null && e && e.pointerId != null && e.pointerId !== holdPointerId) return;
  endHold();
}

function bindHoldListenersOnce() {
  if (holdListenersBound) return;
  holdListenersBound = true;
  window.addEventListener("pointerup", onHoldPointerUp, { passive: true });
  window.addEventListener("pointercancel", onHoldPointerUp, { passive: true });
  window.addEventListener("blur", () => {
    if (holdActive || recording || holdPointerId != null) endHold();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && (holdActive || recording || holdPointerId != null)) endHold();
  });
}

el.btnHold.addEventListener("pointerdown", (e) => {
  if (e.button != null && e.button !== 0) return;
  // 关键：不 setPointerCapture / 不 preventDefault / 不加页面点击锁
  bindHoldListenersOnce();
  if (busy) {
    setStatus("正在处理，请稍等…");
    return;
  }
  if (holdActive || recording) return;

  holdGeneration += 1;
  const gen = holdGeneration;
  holdPointerId = e.pointerId;
  document.body.classList.add("holding-mic");
  setStatus("正在听你说…说完再松开");
  startRecording(gen);
}, { passive: true });

el.btnHold.addEventListener("pointerup", onHoldPointerUp, { passive: true });
el.btnHold.addEventListener("pointercancel", onHoldPointerUp, { passive: true });
el.btnHold.addEventListener("contextmenu", (e) => e.preventDefault());

// 无 PointerEvent 老环境
el.btnHold.addEventListener("touchstart", (e) => {
  if (window.PointerEvent) return;
  e.preventDefault();
  bindHoldListenersOnce();
  if (busy || holdActive || recording) return;
  holdGeneration += 1;
  const gen = holdGeneration;
  holdPointerId = 1;
  document.body.classList.add("holding-mic");
  setStatus("正在听你说…说完再松开");
  startRecording(gen);
}, { passive: false });

el.btnHold.addEventListener("touchend", (e) => {
  if (window.PointerEvent) return;
  e.preventDefault();
  endHold();
}, { passive: false });

el.btnHold.addEventListener("touchcancel", () => {
  if (window.PointerEvent) return;
  endHold();
}, { passive: false });


function autosizeInput() {
  const ta = el.input;
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
}
if (el.input) el.input.addEventListener("input", autosizeInput);

function isStandaloneApp() {
  return Boolean(
    window.matchMedia?.("(display-mode: standalone)")?.matches ||
    window.matchMedia?.("(display-mode: fullscreen)")?.matches ||
    window.navigator.standalone === true
  );
}

function isMobileLike() {
  return Boolean(
    window.matchMedia?.("(max-width: 760px)")?.matches ||
    window.matchMedia?.("(pointer: coarse)")?.matches ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "")
  );
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const isLocalhost = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  if (location.protocol !== "https:" && !isLocalhost) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.debug("[pwa] service worker skipped", err);
    });
  });
}

function setupInstallTip() {
  const tip = el.installTip;
  if (!tip) return;

  let deferredInstallPrompt = null;
  const dismissed = () => localStorage.getItem(INSTALL_TIP_DISMISS_KEY) === "1";
  const shouldShow = () => isMobileLike() && !isStandaloneApp() && !dismissed();
  const show = () => {
    if (shouldShow()) tip.classList.remove("hidden");
  };
  const hide = () => tip.classList.add("hidden");
  const dismiss = () => {
    localStorage.setItem(INSTALL_TIP_DISMISS_KEY, "1");
    hide();
  };

  el.btnInstallDismiss?.addEventListener("click", dismiss);
  el.btnInstallApp?.addEventListener("click", async () => {
    if (!deferredInstallPrompt) {
      setStatus("请点浏览器菜单，选择“添加到主屏幕/安装应用”");
      return;
    }
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    try {
      promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === "accepted") dismiss();
      else if (el.btnInstallApp) el.btnInstallApp.hidden = true;
    } catch {
      setStatus("请点浏览器菜单，选择“添加到主屏幕/安装应用”");
    }
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (el.btnInstallApp) el.btnInstallApp.hidden = false;
    show();
  });
  window.addEventListener("appinstalled", dismiss);

  setTimeout(show, 1200);
}
registerServiceWorker();
setupInstallTip();

bindSecretEyes();
bindMessageActions();

async function boot() {
  try {
    await migrateLegacyDatabaseIfNeeded();
    await loadConfigFromStore();
    await initConversationStore();
  } catch (err) {
    console.error(err);
    setStatus(`本地数据库初始化失败：${err.message || err}`);
  }
  syncVoiceToggle();
  renderChat();
  await initDefaults();
  syncVoiceToggle();
}
boot();

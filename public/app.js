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

const BUILTIN_MODELS = {
  llm: ["Qwen/Qwen3.5-4B", "Qwen/Qwen3-8B"],
  stt: ["FunAudioLLM/SenseVoiceSmall"],
  tts: ["FnLP/MOSS-TTSD-v0.5", "mimo-v2.5-tts"],
};

const MODEL_CAPABILITIES = {
  "Qwen/Qwen3.5-4B": { tools: true, vision: true, context: "256K" },
  "Qwen/Qwen3-8B": { tools: true, vision: false, context: "128K" },
};

const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_EDGE = 1600;
const REMINDERS_KEY = "ai-voice-call.reminders.v1";

const MODEL_KIND_LABELS = {
  llm: "大模型",
  stt: "语音识别模型",
  tts: "语音合成模型",
};

function normalizeModelId(value) {
  return String(value || "").replace(/[\r\n\t]/g, "").trim().slice(0, 256);
}

function normalizeCustomModels(value) {
  const raw = value && typeof value === "object" ? value : {};
  const result = {};
  for (const kind of Object.keys(BUILTIN_MODELS)) {
    const seen = new Set();
    result[kind] = [];
    for (const item of Array.isArray(raw[kind]) ? raw[kind] : []) {
      const modelId = normalizeModelId(item);
      if (!modelId || seen.has(modelId) || BUILTIN_MODELS[kind].includes(modelId)) continue;
      seen.add(modelId);
      result[kind].push(modelId);
      if (result[kind].length >= 50) break;
    }
  }
  return result;
}

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
  customModels: normalizeCustomModels(),
  llm: {
    providerId: DEFAULT_PROVIDER_ID,
    baseUrl: "https://api.siliconflow.cn/v1",
    apiKey: "",
    model: "Qwen/Qwen3.5-4B",
    apiType: "auto",
    endpoint: "",
  },
  stt: {
    providerId: "",
    baseUrl: "",
    apiKey: "",
    model: "FunAudioLLM/SenseVoiceSmall",
    apiType: "auto",
    endpoint: "",
  },
  tts: {
    providerId: "",
    baseUrl: "",
    apiKey: "",
    model: "FnLP/MOSS-TTSD-v0.5",
    voice: "alloy",
    apiType: "auto",
    endpoint: "",
  },
  systemPromptPreset: "general",
  systemPrompt: SYSTEM_PROMPT_PRESETS.general.prompt,
  maxHistoryTurns: 12,
  maxTokens: 512,
  temperature: 0.7,
  ttsEnabled: true,
  browserTtsFallback: true,
  autoSpeak: true,
  toolCallingEnabled: true,
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
  btnStop: document.getElementById("btnStop"),
  btnAttach: document.getElementById("btnAttach"),
  imageInput: document.getElementById("imageInput"),
  imagePreview: document.getElementById("imagePreview"),
  imagePreviewImg: document.getElementById("imagePreviewImg"),
  imagePreviewName: document.getElementById("imagePreviewName"),
  btnRemoveImage: document.getElementById("btnRemoveImage"),
  btnHold: document.getElementById("btnHold"),
  btnCall: document.getElementById("btnCall"),
  btnVoice: document.getElementById("btnVoice"),
  callPanel: document.getElementById("callPanel"),
  callVisualStage: document.getElementById("callVisualStage"),
  callOrb: document.getElementById("callOrb"),
  callCameraPreview: document.getElementById("callCameraPreview"),
  callCameraVideo: document.getElementById("callCameraVideo"),
  callStatus: document.getElementById("callStatus"),
  callTranscript: document.getElementById("callTranscript"),
  callTimer: document.getElementById("callTimer"),
  btnCallMute: document.getElementById("btnCallMute"),
  callMuteLabel: document.getElementById("callMuteLabel"),
  btnCallCamera: document.getElementById("btnCallCamera"),
  callCameraLabel: document.getElementById("callCameraLabel"),
  btnCallIdentify: document.getElementById("btnCallIdentify"),
  btnCallCameraFlip: document.getElementById("btnCallCameraFlip"),
  btnHangup: document.getElementById("btnHangup"),
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
    llmModelTrigger: document.getElementById("llmModelTrigger"),
    llmModelSelected: document.getElementById("llmModelSelected"),
    llmModelMenu: document.getElementById("llmModelMenu"),
    llmModelList: document.getElementById("llmModelList"),
    btnAddLlmModel: document.getElementById("btnAddLlmModel"),
    llmApiType: document.getElementById("llmApiType"),
    llmCustomEndpointField: document.getElementById("llmCustomEndpointField"),
    llmCustomEndpoint: document.getElementById("llmCustomEndpoint"),
    sttProviderId: document.getElementById("sttProviderId"),
    sttModel: document.getElementById("sttModel"),
    sttModelTrigger: document.getElementById("sttModelTrigger"),
    sttModelSelected: document.getElementById("sttModelSelected"),
    sttModelMenu: document.getElementById("sttModelMenu"),
    sttModelList: document.getElementById("sttModelList"),
    btnAddSttModel: document.getElementById("btnAddSttModel"),
    sttApiType: document.getElementById("sttApiType"),
    sttCustomEndpointField: document.getElementById("sttCustomEndpointField"),
    sttCustomEndpoint: document.getElementById("sttCustomEndpoint"),
    ttsProviderId: document.getElementById("ttsProviderId"),
    ttsModel: document.getElementById("ttsModel"),
    ttsModelTrigger: document.getElementById("ttsModelTrigger"),
    ttsModelSelected: document.getElementById("ttsModelSelected"),
    ttsModelMenu: document.getElementById("ttsModelMenu"),
    ttsModelList: document.getElementById("ttsModelList"),
    btnAddTtsModel: document.getElementById("btnAddTtsModel"),
    ttsVoicePreset: document.getElementById("ttsVoicePreset"),
    ttsVoice: document.getElementById("ttsVoice"),
    ttsApiType: document.getElementById("ttsApiType"),
    ttsCustomEndpointField: document.getElementById("ttsCustomEndpointField"),
    ttsCustomEndpoint: document.getElementById("ttsCustomEndpoint"),
    systemPromptPreset: document.getElementById("systemPromptPreset"),
    systemPrompt: document.getElementById("systemPrompt"),
    maxHistoryTurns: document.getElementById("maxHistoryTurns"),
    maxTokens: document.getElementById("maxTokens"),
    temperature: document.getElementById("temperature"),
    llmCapabilityHint: document.getElementById("llmCapabilityHint"),
    ttsEnabled: document.getElementById("ttsEnabled"),
    browserTtsFallback: document.getElementById("browserTtsFallback"),
    autoSpeak: document.getElementById("autoSpeak"),
    toolCallingEnabled: document.getElementById("toolCallingEnabled"),
    webSearchEnabled: document.getElementById("webSearchEnabled"),
    searchProvider: document.getElementById("searchProvider"),
    searchApiKey: document.getElementById("searchApiKey"),
    searchBaseUrl: document.getElementById("searchBaseUrl"),
  },
};

let config = structuredClone(DEFAULTS);
let settingsFormInitialized = false;
let currentConversationId = null;
let messages = [];
let busy = false;
let mediaRecorder = null;
let recordChunks = [];
let recording = false;
let serverDefaults = null;
let providersDraft = defaultApiProviders();
let customModelsDraft = normalizeCustomModels();
let selectedProviderDraftId = DEFAULT_PROVIDER_ID;
let providerEditorMode = ""; // "" | "add" | "edit"
let pendingImage = null;

let browserRec = null;
let browserTranscript = "";
let browserUsing = false;
let holdActive = false;
let holdGeneration = 0;
let restartTimer = null;

let callActive = false;
let callMuted = false;
let callGeneration = 0;
let callStartedAt = 0;
let callTimerId = null;
let callListenTimer = null;
let callCapture = null;
let callSessionAbort = null;
let callCameraStream = null;
let callCameraFacingMode = "environment";
let callCameraBusy = false;
let callCameraAnalyzing = false;
let activeSpeechAudio = null;
let activeSpeechStop = null;
let browserSpeechStop = null;
let activeSpeechController = null;
let activeChatRequest = null;

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
  out.customModels = normalizeCustomModels(patch?.customModels ?? base.customModels);
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
    endpoint: String(out.llm?.endpoint || "").trim(),
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
      endpoint: String(out.stt?.endpoint || "").trim(),
    };
  } else {
    out.stt = {
      ...(out.stt || {}),
      providerId: "",
      baseUrl: "",
      apiKey: "",
      model: String(out.stt?.model || DEFAULTS.stt.model).trim() || DEFAULTS.stt.model,
      apiType: normalizeApiType(out.stt?.apiType, DEFAULTS.stt.apiType),
      endpoint: String(out.stt?.endpoint || "").trim(),
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
      endpoint: String(out.tts?.endpoint || "").trim(),
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
      endpoint: String(out.tts?.endpoint || "").trim(),
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
  const allowed = new Set(["auto", "custom", "openai-chat", "openai-responses", "openai-transcriptions", "openai-speech", "xiaomi-mimo"]);
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
      endpoint: String(raw.llm?.endpoint || "").trim(),
    },
    stt: {
      providerId: raw.stt?.providerId || legacyProviders.sttProviderId || "",
      model: raw.stt?.model,
      apiType: normalizeApiType(raw.stt?.apiType, DEFAULTS.stt.apiType),
      endpoint: String(raw.stt?.endpoint || "").trim(),
    },
    tts: {
      providerId: raw.tts?.providerId || legacyProviders.ttsProviderId || "",
      model: raw.tts?.model,
      voice: raw.tts?.voice,
      apiType: normalizeApiType(raw.tts?.apiType, DEFAULTS.tts.apiType),
      endpoint: String(raw.tts?.endpoint || "").trim(),
    },
  });
  out.systemPrompt = String(out.systemPrompt || "").trim() || SYSTEM_PROMPT_PRESETS.general.prompt;
  out.llm.model = normalizeModelId(out.llm.model) || DEFAULTS.llm.model;
  out.stt.model = normalizeModelId(out.stt.model) || DEFAULTS.stt.model;
  out.tts.model = normalizeModelId(out.tts.model) || DEFAULTS.tts.model;
  out.customModels = normalizeCustomModels(out.customModels);
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
  if (!config.autoSpeak) stopActiveSpeech();
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

function messageText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .join(" ")
    .trim();
}

function messageImages(content) {
  if (!Array.isArray(content)) return [];
  return content
    .map((part) => {
      if (!part || typeof part !== "object" || part.type !== "image_url") return "";
      if (typeof part.image_url === "string") return part.image_url;
      return typeof part.image_url?.url === "string" ? part.image_url.url : "";
    })
    .filter((url) => /^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(url));
}

function buildUserContent(text, image = null) {
  const value = String(text || "").trim();
  if (!image?.url) return value;
  return [
    { type: "image_url", image_url: { url: image.url, detail: "low" } },
    { type: "text", text: value || "请描述并分析这张图片。" },
  ];
}

function modelCapabilities(modelId = config.llm?.model) {
  return MODEL_CAPABILITIES[normalizeModelId(modelId)] || null;
}

function modelSupportsVision(modelId = config.llm?.model) {
  return modelCapabilities(modelId)?.vision !== false;
}

function syncLlmCapabilityHint(modelId = el.fields?.llmModel?.value || config.llm?.model) {
  const hint = el.fields?.llmCapabilityHint;
  if (!hint) return;
  const caps = modelCapabilities(modelId);
  if (!caps) {
    hint.textContent = "自定义模型的 Tools / 视觉能力由供应商决定。";
    return;
  }
  hint.textContent = `能力：Tools ${caps.tools ? "支持" : "不支持"} · 视觉 ${caps.vision ? "支持" : "不支持"} · 上下文 ${caps.context}`;
}

function syncImagePreview() {
  const visible = Boolean(pendingImage?.url);
  el.imagePreview?.classList.toggle("hidden", !visible);
  if (visible) {
    if (el.imagePreviewImg) el.imagePreviewImg.src = pendingImage.url;
    if (el.imagePreviewName) el.imagePreviewName.textContent = pendingImage.name || "待发送图片";
  } else if (el.imagePreviewImg) {
    el.imagePreviewImg.removeAttribute("src");
  }
}

function clearPendingImage() {
  pendingImage = null;
  if (el.imageInput) el.imageInput.value = "";
  syncImagePreview();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("浏览器无法解析这张图片"));
    image.src = dataUrl;
  });
}

function canvasToDataUrl(canvas, type = "image/jpeg", quality = 0.84) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("图片压缩失败"));
        return;
      }
      fileToDataUrl(blob).then(resolve, reject);
    }, type, quality);
  });
}

async function prepareImageFile(file) {
  if (!file || !String(file.type || "").startsWith("image/")) throw new Error("请选择 JPG、PNG、WebP 或 GIF 图片");
  if (file.size > MAX_IMAGE_FILE_BYTES) throw new Error("图片不能超过 10MB");
  const originalUrl = await fileToDataUrl(file);
  const image = await loadImage(originalUrl);
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
  if (scale === 1 && file.size <= 1.5 * 1024 * 1024) return { name: file.name || "图片", url: originalUrl };

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持图片压缩");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return { name: file.name || "图片", url: await canvasToDataUrl(canvas) };
}

async function selectImageFile(file) {
  if (!modelSupportsVision()) {
    setStatus(`${config.llm.model} 不支持视觉输入，请切换到 Qwen/Qwen3.5-4B`);
    return;
  }
  setStatus("正在处理图片…");
  pendingImage = await prepareImageFile(file);
  syncImagePreview();
  setStatus("图片已添加，可以输入问题后发送");
}

function readLocalReminders() {
  try {
    const value = JSON.parse(localStorage.getItem(REMINDERS_KEY) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeLocalReminders(reminders) {
  localStorage.setItem(REMINDERS_KEY, JSON.stringify(reminders.slice(-200)));
}

async function applyToolActions(actions) {
  const reminders = readLocalReminders();
  let created = 0;
  for (const action of Array.isArray(actions) ? actions : []) {
    if (action?.type !== "create_reminder") continue;
    const dueAt = new Date(action.dueAt);
    if (!Number.isFinite(dueAt.getTime())) continue;
    reminders.push({
      id: action.id || `reminder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: String(action.title || "提醒").slice(0, 200),
      dueAt: dueAt.toISOString(),
      createdAt: new Date().toISOString(),
      notified: false,
    });
    created += 1;
  }
  if (created) {
    writeLocalReminders(reminders);
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    checkDueReminders();
  }
  return created;
}

function showReminder(reminder) {
  const title = String(reminder.title || "提醒");
  if ("Notification" in window && Notification.permission === "granted") {
    try { new Notification("小豆提醒", { body: title, icon: "/icon-192.png" }); } catch {}
  }
  appendMessage("system", `提醒：${title}`);
  setStatus(`提醒：${title}`);
  if (config.autoSpeak) browserSpeak(`提醒你：${title}`).catch(() => {});
}

function checkDueReminders() {
  const reminders = readLocalReminders();
  const now = Date.now();
  let changed = false;
  for (const reminder of reminders) {
    if (reminder.notified) continue;
    const dueTime = new Date(reminder.dueAt).getTime();
    if (!Number.isFinite(dueTime) || dueTime > now) continue;
    reminder.notified = true;
    changed = true;
    showReminder(reminder);
  }
  if (changed) writeLocalReminders(reminders);
}

function syncInteractionState() {
  const composerLocked = busy || callActive;
  if (el.btnSend) el.btnSend.disabled = composerLocked;
  if (el.btnHold) el.btnHold.disabled = composerLocked;
  if (el.btnAttach) el.btnAttach.disabled = composerLocked;
  if (el.input) el.input.disabled = callActive;
  if (el.btnCall) el.btnCall.disabled = busy && !callActive;
  syncCallCameraUi();
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
  const images = messageImages(content);
  if (images.length) {
    const imageWrap = document.createElement("div");
    imageWrap.className = "msg-images";
    for (const url of images) {
      const image = document.createElement("img");
      image.className = "msg-image";
      image.src = url;
      image.alt = "用户发送的图片";
      image.loading = "lazy";
      imageWrap.appendChild(image);
    }
    bubble.appendChild(imageWrap);
  }
  const textNode = document.createElement("div");
  textNode.className = "msg-text";
  textNode.textContent = messageText(content);
  bubble.appendChild(textNode);

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
  appendMessage("system", "你好，我是小豆。点右上角电话可以连续语音通话，也可以打字或按住麦克风说话。");
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
    const content = messageText(item.content);
    const imageUrl = messageImages(item.content)[0] || "";
    messages = messages.slice(0, index);
    await saveHistory();
    renderChat();
    await sendText(content, { image: imageUrl ? { name: "重发图片", url: imageUrl } : null });
    return;
  }

  if (item.role === "assistant") {
    messages = messages.slice(0, index);
    await saveHistory();
    renderChat();
    await regenerateAssistant();
  }
}


function escapeReplyRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mergeAssistantStreamText(current, incoming) {
  const reply = String(current || "");
  const text = String(incoming || "").replace(/<think>[\s\S]*?<\/think>/gi, "");
  if (!text) return { reply, delta: "" };
  if (reply && text.length > reply.length && text.startsWith(reply)) {
    return { reply: text, delta: text.slice(reply.length) };
  }
  if (text.length >= 12 && (text === reply || reply.endsWith(text))) return { reply, delta: "" };
  if (reply && text.length >= 12) {
    const maxOverlap = Math.min(reply.length, text.length);
    for (let overlap = maxOverlap; overlap >= 12; overlap -= 1) {
      if (reply.slice(-overlap) === text.slice(0, overlap)) {
        const delta = text.slice(overlap);
        return { reply: reply + delta, delta };
      }
    }
  }
  return { reply: reply + text, delta: text };
}

function cleanClientAssistantReply(text, requestMessages = []) {
  const original = String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\|(?:im_start|im_end|endoftext|system|user|assistant)\|>/gi, "")
    .trim();
  if (!original) return "";
  let cleaned = original;
  const prompts = [config.systemPrompt]
    .map((prompt) => String(prompt || "").trim())
    .filter((prompt) => prompt.length >= 12);
  for (const prompt of prompts) cleaned = cleaned.split(prompt).join("\n");

  const lastUser = [...requestMessages].reverse().find((message) => message?.role === "user");
  const userText = messageText(lastUser?.content);
  if (userText) {
    for (const marker of [
      `用户说：“${userText}”`,
      `用户说："${userText}"`,
      `用户说：${userText}`,
      `用户：${userText}`,
      `user: ${userText}`,
    ]) cleaned = cleaned.split(marker).join("\n");
    const escapedUser = escapeReplyRegExp(userText);
    const userEchoPattern = new RegExp(`(^|\\n)\\s*(?:用户(?:说)?|user)\\s*[:：]\\s*[“”"'‘’]*\\s*${escapedUser}\\s*[“”"'‘’]*\\s*`, "gi");
    for (let pass = 0; pass < 3; pass += 1) cleaned = cleaned.replace(userEchoPattern, "$1");
  }
  cleaned = cleaned
    .replace(/(^|\n)\s*(?:系统(?:提示|消息)?|system)\s*[:：]\s*(?=\n|$)/gi, "$1")
    .replace(/(^|\n)\s*(?:用户(?:说)?|user)\s*[:：]\s*[“”"'‘’]*\s*(?=\n|$)/gi, "$1")
    .replace(/^\s*(?:助手|assistant|小豆)\s*[:：]\s*/i, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const paragraphs = cleaned.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  cleaned = paragraphs.filter((item, index) => index === 0 || item !== paragraphs[index - 1]).join("\n\n").trim();
  const anchor = cleaned.slice(0, 48).trim();
  if (anchor.length >= 24) {
    const repeatAt = cleaned.indexOf(anchor, Math.max(80, anchor.length + 1));
    if (repeatAt >= 0) cleaned = cleaned.slice(0, repeatAt).trim();
  }
  return cleaned || original;
}

async function requestChatJson(requestMessages, signal = null) {
  const controller = new AbortController();
  const chatTimer = setTimeout(() => controller.abort(), 60000);
  const abortFromSession = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abortFromSession, { once: true });
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: requestMessages, config: apiConfigPayload() }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const reply = cleanClientAssistantReply(data.reply, requestMessages);
    if (!reply) throw new Error("模型没有返回文字，请换模型或稍后再试");
    return { reply, webSearch: data.webSearch || null, toolActions: data.toolActions || [], toolUsage: data.toolUsage || [] };
  } finally {
    clearTimeout(chatTimer);
    signal?.removeEventListener("abort", abortFromSession);
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
  return row?.querySelector?.(".msg.assistant .msg-text") || row?.querySelector?.(".msg.assistant") || row;
}

function setAssistantText(row, text) {
  const bubble = assistantBubble(row);
  if (bubble) bubble.textContent = text || "…";
  el.chat.scrollTop = el.chat.scrollHeight;
}

async function requestChatStreamWithFallback(requestMessages, row, signal = null) {
  let reply = "";
  let webSearch = null;
  let toolActions = [];
  let toolUsage = [];
  let sawDelta = false;
  const controller = new AbortController();
  const chatTimer = setTimeout(() => controller.abort(), 120000);
  let outputTimer = setTimeout(() => controller.abort(), 18000);
  const clearOutputTimer = () => {
    if (!outputTimer) return;
    clearTimeout(outputTimer);
    outputTimer = null;
  };
  const abortFromSession = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abortFromSession, { once: true });
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
          clearOutputTimer();
          const merged = mergeAssistantStreamText(reply, text);
          reply = merged.reply;
          if (merged.delta) {
            sawDelta = true;
            setAssistantText(row, reply);
          }
        }
        return;
      }
      if (eventName === "done") {
        clearOutputTimer();
        if (data.reply) {
          reply = cleanClientAssistantReply(data.reply, requestMessages);
          setAssistantText(row, reply);
        }
        webSearch = data.webSearch || null;
        toolActions = Array.isArray(data.toolActions) ? data.toolActions : [];
        toolUsage = Array.isArray(data.toolUsage) ? data.toolUsage : [];
        return;
      }
      if (eventName === "error") {
        clearOutputTimer();
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
    reply = cleanClientAssistantReply(reply, requestMessages);
    if (!reply) throw Object.assign(new Error("模型没有返回文字，请换模型或稍后再试"), { beforeDelta: !sawDelta });
    return { reply, webSearch, toolActions, toolUsage, streamed: true };
  } catch (err) {
    if (signal?.aborted) {
      err.partial = cleanClientAssistantReply(err.partial || reply || "", requestMessages);
      throw err;
    }
    if (sawDelta || err.partial) {
      err.partial = cleanClientAssistantReply(err.partial || reply || "", requestMessages);
      throw err;
    }
    console.warn("stream chat failed before output; fallback to /api/chat", err);
    const data = await requestChatJson(requestMessages, signal);
    setAssistantText(row, data.reply);
    return { ...data, streamed: false };
  } finally {
    clearOutputTimer();
    clearTimeout(chatTimer);
    signal?.removeEventListener("abort", abortFromSession);
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
  syncInteractionState();
  setStatus("正在重新生成…");

  const requestMessages = messages.slice();
  const assistantIndex = messages.length;
  messages.push({ role: "assistant", content: "" });
  const row = appendMessage("assistant", "…", assistantIndex);
  const chatRequest = beginChatGeneration();

  try {
    const data = await requestChatStreamWithFallback(requestMessages, row, chatRequest.controller.signal);
    finishChatGeneration(chatRequest);
    messages[assistantIndex].content = data.reply;
    await saveHistory();
    await applyToolActions(data.toolActions || []);
    let speakResult = { mode: "off" };
    if (config.autoSpeak) {
      setStatus("正在朗读…");
      speakResult = await speakText(data.reply);
    }
    setStatus(readyStatusAfterSpeak(speakResult));
  } catch (err) {
    const stoppedByUser = chatRequest.userStopped;
    const partial = String(err.partial || "").trim();
    if (partial) {
      messages[assistantIndex].content = partial;
      setAssistantText(row, partial);
      await saveHistory();
      setStatus(stoppedByUser ? "已停止生成，已保留当前内容" : `生成中断：${explainFetchError(err)}`);
    } else {
      removeAssistantPlaceholder(row, assistantIndex);
      setStatus(stoppedByUser ? "已停止生成" : `重试失败：${explainFetchError(err)}`);
    }
  } finally {
    finishChatGeneration(chatRequest);
    busy = false;
    syncInteractionState();
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
    endpoint: String(service?.endpoint || "").trim(),
  };
  if (role === "tts") payload.voice = String(service?.voice || "alloy").trim() || "alloy";
  return payload;
}

function readLiveSearchSettings() {
  const f = el.fields || {};
  const useForm = settingsFormInitialized;
  return {
    toolCallingEnabled: useForm && f.toolCallingEnabled ? f.toolCallingEnabled.checked : config.toolCallingEnabled !== false,
    webSearchEnabled: useForm && f.webSearchEnabled ? f.webSearchEnabled.checked : config.webSearchEnabled !== false,
    searchProvider: useForm && f.searchProvider ? (f.searchProvider.value || "auto") : (config.searchProvider || "auto"),
    searchApiKey: useForm && f.searchApiKey ? f.searchApiKey.value.trim() : (config.searchApiKey || ""),
    searchBaseUrl: useForm && f.searchBaseUrl ? f.searchBaseUrl.value.trim() : (config.searchBaseUrl || ""),
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
    toolCallingEnabled: runtimeConfig.toolCallingEnabled !== false,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Hong_Kong",
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

function modelField(kind) {
  return el.fields?.[`${kind}Model`] || null;
}

function modelTrigger(kind) {
  return el.fields?.[`${kind}ModelTrigger`] || null;
}

function modelSelected(kind) {
  return el.fields?.[`${kind}ModelSelected`] || null;
}

function modelMenu(kind) {
  return el.fields?.[`${kind}ModelMenu`] || null;
}

function modelList(kind) {
  return el.fields?.[`${kind}ModelList`] || null;
}

function renderModelManager(kind) {
  const input = modelField(kind);
  const selected = modelSelected(kind);
  const list = modelList(kind);
  if (!input || !selected || !list || !BUILTIN_MODELS[kind]) return;
  const custom = customModelsDraft[kind] || [];
  const current = normalizeModelId(input.value);
  const choices = [...new Set([current, ...BUILTIN_MODELS[kind], ...custom].filter(Boolean))];
  selected.textContent = current || "请选择模型";
  selected.title = current;
  list.innerHTML = choices.map((modelId) => {
    const removable = custom.includes(modelId);
    const active = modelId === current;
    return `
    <div class="model-option-row${active ? " active" : ""}" title="${escapeHtml(modelId)}">
      <button class="model-option-select" type="button" role="option" aria-selected="${active ? "true" : "false"}" data-model-kind="${kind}" data-model-value="${escapeHtml(modelId)}">${escapeHtml(modelId)}</button>
      ${removable ? `<button class="model-option-remove" type="button" data-remove-model-kind="${kind}" data-model-value="${escapeHtml(modelId)}" aria-label="删除 ${escapeHtml(modelId)}">×</button>` : ""}
    </div>`;
  }).join("");
  if (kind === "llm") syncLlmCapabilityHint(current);
}

function closeAllModelMenus(exceptKind = "") {
  for (const kind of Object.keys(BUILTIN_MODELS)) {
    if (kind === exceptKind) continue;
    modelMenu(kind)?.classList.add("hidden");
    modelTrigger(kind)?.setAttribute("aria-expanded", "false");
  }
}

function setModelMenuOpen(kind, open) {
  const menu = modelMenu(kind);
  const trigger = modelTrigger(kind);
  if (!menu || !trigger) return;
  if (open) {
    closeAllModelMenus(kind);
    renderModelManager(kind);
    menu.classList.remove("hidden");
    trigger.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => {
      const input = modelField(kind);
      input?.focus();
      input?.select();
    });
    return;
  }
  menu.classList.add("hidden");
  trigger.setAttribute("aria-expanded", "false");
}

function toggleModelMenu(kind) {
  const menu = modelMenu(kind);
  if (!menu) return;
  setModelMenuOpen(kind, menu.classList.contains("hidden"));
}

function renderAllModelManagers() {
  for (const kind of Object.keys(BUILTIN_MODELS)) renderModelManager(kind);
}

function addCustomModel(kind) {
  const input = modelField(kind);
  if (!input || !BUILTIN_MODELS[kind]) return;
  const rawValue = String(input.value || "").trim();
  const modelId = normalizeModelId(rawValue);
  if (!modelId) {
    setSettingsStatus(`请先填写${MODEL_KIND_LABELS[kind]} ID`);
    input.focus();
    return;
  }
  if (rawValue.length > 256) {
    setSettingsStatus("模型 ID 不能超过 256 个字符");
    input.focus();
    return;
  }
  if (BUILTIN_MODELS[kind].includes(modelId)) {
    input.value = modelId;
    renderModelManager(kind);
    setSettingsStatus(`${modelId} 已是内置常用模型，可直接选择`);
    return;
  }
  const custom = customModelsDraft[kind] || [];
  if (custom.includes(modelId)) {
    input.value = modelId;
    renderModelManager(kind);
    setSettingsStatus(`${modelId} 已经在常用模型列表中`);
    return;
  }
  if (custom.length >= 50) {
    setSettingsStatus("每类最多添加 50 个自定义模型，请先删除不再使用的项");
    return;
  }
  customModelsDraft[kind] = [...custom, modelId];
  input.value = modelId;
  renderModelManager(kind);
  setSettingsStatus(`已添加 ${modelId}，点击底部“保存到本地”后永久保存`);
}

function removeCustomModel(kind, modelId) {
  if (!BUILTIN_MODELS[kind]) return;
  customModelsDraft[kind] = (customModelsDraft[kind] || []).filter((item) => item !== modelId);
  const input = modelField(kind);
  if (input && normalizeModelId(input.value) === modelId) {
    input.value = BUILTIN_MODELS[kind][0] || "";
  }
  renderModelManager(kind);
  setSettingsStatus(`已从常用列表删除 ${modelId}`);
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

function syncCustomEndpointFields() {
  for (const kind of ["llm", "stt", "tts"]) {
    const apiType = el.fields?.[`${kind}ApiType`];
    const field = el.fields?.[`${kind}CustomEndpointField`];
    if (!field) continue;
    field.classList.toggle("hidden", apiType?.value !== "custom");
  }
}

function fillSettingsForm() {
  const f = el.fields;
  providersDraft = ensureProviderList(config.apiProviders);
  customModelsDraft = normalizeCustomModels(config.customModels);
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
  if (f.llmCustomEndpoint) f.llmCustomEndpoint.value = config.llm.endpoint || "";
  f.sttModel.value = config.stt.model || "";
  if (f.sttApiType) f.sttApiType.value = normalizeApiType(config.stt.apiType, DEFAULTS.stt.apiType);
  if (f.sttCustomEndpoint) f.sttCustomEndpoint.value = config.stt.endpoint || "";
  f.ttsModel.value = config.tts.model || "";
  renderAllModelManagers();
  setTtsVoiceFormValue(config.tts.voice || "");
  if (f.ttsApiType) f.ttsApiType.value = normalizeApiType(config.tts.apiType, DEFAULTS.tts.apiType);
  if (f.ttsCustomEndpoint) f.ttsCustomEndpoint.value = config.tts.endpoint || "";
  syncCustomEndpointFields();
  const promptPreset = inferPromptPreset(config.systemPrompt, config.systemPromptPreset || "general");
  if (f.systemPromptPreset) f.systemPromptPreset.value = promptPreset;
  f.systemPrompt.value = config.systemPrompt || SYSTEM_PROMPT_PRESETS.general.prompt;
  f.maxHistoryTurns.value = config.maxHistoryTurns ?? 12;
  f.maxTokens.value = config.maxTokens ?? 512;
  f.temperature.value = config.temperature ?? 0.7;
  f.ttsEnabled.checked = Boolean(config.ttsEnabled);
  f.browserTtsFallback.checked = Boolean(config.browserTtsFallback);
  f.autoSpeak.checked = Boolean(config.autoSpeak);
  if (f.toolCallingEnabled) f.toolCallingEnabled.checked = config.toolCallingEnabled !== false;
  syncVoiceToggle();
  if (f.webSearchEnabled) f.webSearchEnabled.checked = config.webSearchEnabled !== false;
  if (f.searchProvider) f.searchProvider.value = config.searchProvider || "auto";
  if (f.searchApiKey) f.searchApiKey.value = config.searchApiKey || "";
  if (f.searchBaseUrl) f.searchBaseUrl.value = config.searchBaseUrl || "";
  syncLlmCapabilityHint(config.llm.model);
  settingsFormInitialized = true;
}

function readSettingsForm() {
  const f = el.fields;
  const apiProviders = ensureProviderList(providersDraft);
  const llmProviderId = String(f.llmProviderId?.value || apiProviders[0]?.id || DEFAULT_PROVIDER_ID);
  return deepMerge(DEFAULTS, {
    apiProviders,
    customModels: normalizeCustomModels(customModelsDraft),
    llm: {
      providerId: llmProviderId,
      model: f.llmModel.value.trim(),
      apiType: normalizeApiType(f.llmApiType?.value, DEFAULTS.llm.apiType),
      endpoint: String(f.llmCustomEndpoint?.value || "").trim(),
    },
    stt: {
      providerId: String(f.sttProviderId?.value || ""),
      model: f.sttModel.value.trim(),
      apiType: normalizeApiType(f.sttApiType?.value, DEFAULTS.stt.apiType),
      endpoint: String(f.sttCustomEndpoint?.value || "").trim(),
    },
    tts: {
      providerId: String(f.ttsProviderId?.value || ""),
      model: f.ttsModel.value.trim(),
      voice: readTtsVoiceFormValue(),
      apiType: normalizeApiType(f.ttsApiType?.value, DEFAULTS.tts.apiType),
      endpoint: String(f.ttsCustomEndpoint?.value || "").trim(),
    },
    systemPromptPreset: inferPromptPreset(f.systemPrompt.value, f.systemPromptPreset?.value || "general"),
    systemPrompt: f.systemPrompt.value.trim() || SYSTEM_PROMPT_PRESETS.general.prompt,
    maxHistoryTurns: Number(f.maxHistoryTurns.value || 12),
    maxTokens: clampNumber(f.maxTokens.value, 512, 256, 1024),
    temperature: Number(f.temperature.value || 0.7),
    ttsEnabled: f.ttsEnabled.checked,
    browserTtsFallback: f.browserTtsFallback.checked,
    autoSpeak: f.autoSpeak.checked,
    toolCallingEnabled: f.toolCallingEnabled ? f.toolCallingEnabled.checked : true,
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
  closeAllModelMenus();
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
          endpoint: draft.llm.endpoint,
        },
        stt: {
          baseUrl: draft.stt.baseUrl || draft.llm.baseUrl,
          apiKey: draft.stt.apiKey || draft.llm.apiKey,
          model: draft.stt.model,
          apiType: draft.stt.apiType,
          endpoint: draft.stt.endpoint,
        },
        tts: {
          baseUrl: draft.tts.baseUrl || draft.llm.baseUrl,
          apiKey: draft.tts.apiKey || draft.llm.apiKey,
          model: draft.tts.model,
          voice: draft.tts.voice,
          apiType: draft.tts.apiType,
          endpoint: draft.tts.endpoint,
        },
        systemPrompt: draft.systemPrompt,
        maxTokens: draft.maxTokens,
        temperature: draft.temperature,
        ttsEnabled: draft.ttsEnabled,
      },
    }),
  });
  const data = await res.json().catch(() => ({}));
  const testSummary = [
    ["LLM", data.llmTest],
    ["STT", data.sttTest],
    ["TTS", data.ttsTest],
  ].map(([label, test]) => {
    if (test?.skipped) return `${label} 已跳过`;
    if (test?.ok) return `${label} 成功`;
    const detail = String(test?.error || "未完成").slice(0, 160);
    return `${label} 失败（${detail}）`;
  }).join("；");
  if (!res.ok || !data.ok) {
    throw new Error(testSummary || data.error || `HTTP ${res.status}`);
  }
  setSettingsStatus(`连接测试完成：${testSummary}`);
}

function explainFetchError(err) {
  const msg = String(err?.message || err || "");
  const name = String(err?.name || "");
  if (name === "AbortError" || /aborted|timeout|timed out/i.test(msg)) {
    return "等待超时。可能是模型太慢、联网搜索卡住，或本地服务无响应。请重试，或在本地配置里先关掉联网搜索";
  }
  if (/failed to fetch/i.test(msg) || /networkerror/i.test(msg) || /load failed/i.test(msg)) {
    return "连不上服务。本地使用请确认一键启动.cmd 正在运行；手机录音请打开已部署的 Cloudflare HTTPS 地址";
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
    return "微信内用 HTTP 不能录音。请点右上角···→在浏览器打开，并访问已部署的 Cloudflare HTTPS 地址";
  }
  if (wechat) {
    return "微信内置浏览器录音受限。请点右上角···→在浏览器打开后再按住说话";
  }
  if (insecure) {
    return "当前 HTTP 地址不能使用麦克风，请改用已部署的 Cloudflare HTTPS 地址";
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

function cameraPermissionHint(err) {
  const name = err?.name || "";
  const msg = String(err?.message || err || "");
  if (name === "NotAllowedError" || /permission|denied|not allowed/i.test(msg)) {
    return isWeChatBrowser()
      ? "摄像头权限被拒绝。请在系统浏览器打开，并允许摄像头权限"
      : "摄像头权限被拒绝，请在浏览器设置里允许摄像头";
  }
  if (name === "NotFoundError") return "未找到可用摄像头";
  if (name === "NotReadableError") return "摄像头被占用，请关闭其他相机或视频应用";
  if (name === "OverconstrainedError") return "当前设备不支持所选摄像头，请尝试切换镜头";
  if (isInsecureContext()) return "当前地址不能使用摄像头，请改用已部署的 Cloudflare HTTPS 地址";
  if (!ensureMediaDevices()) return "当前浏览器不支持摄像头，请使用 Chrome 或 Safari";
  return "无法打开摄像头：" + msg;
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

function syncStopControl() {
  const generatingText = Boolean(activeChatRequest);
  const showStop = Boolean(generatingText || activeSpeechController) && !callActive;
  el.btnStop?.classList.toggle("hidden", !showStop);
  el.btnSend?.classList.toggle("hidden", showStop);
  if (el.btnStop) {
    const label = generatingText ? "停止生成" : "停止朗读";
    el.btnStop.title = label;
    el.btnStop.setAttribute("aria-label", label);
  }
}

function beginChatGeneration(parentSignal = null) {
  const controller = new AbortController();
  const request = {
    controller,
    parentSignal,
    userStopped: false,
    finished: false,
    abortFromParent: null,
  };
  request.abortFromParent = () => {
    controller.abort();
    if (activeChatRequest === request) activeChatRequest = null;
    syncStopControl();
  };
  activeChatRequest = request;
  if (parentSignal?.aborted) request.abortFromParent();
  else parentSignal?.addEventListener("abort", request.abortFromParent, { once: true });
  syncStopControl();
  return request;
}

function finishChatGeneration(request) {
  if (!request || request.finished) return;
  request.finished = true;
  request.parentSignal?.removeEventListener("abort", request.abortFromParent);
  if (activeChatRequest === request) activeChatRequest = null;
  syncStopControl();
}

function stopActiveTextGeneration() {
  const request = activeChatRequest;
  if (!request) return false;
  request.userStopped = true;
  request.controller.abort();
  activeChatRequest = null;
  syncStopControl();
  return true;
}

function stopActiveSpeech() {
  const hadActiveSpeech = Boolean(activeSpeechController || activeSpeechStop || browserSpeechStop);
  activeSpeechController?.abort();
  activeSpeechController = null;
  if (activeSpeechStop) activeSpeechStop();
  activeSpeechStop = null;
  activeSpeechAudio = null;
  if (browserSpeechStop) browserSpeechStop();
  browserSpeechStop = null;
  try { window.speechSynthesis?.cancel(); } catch {}
  syncStopControl();
  return hadActiveSpeech;
}

function browserSpeak(text, { signal = null } = {}) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window) || signal?.aborted) {
      resolve(false);
      return;
    }
    let settled = false;
    const utter = new SpeechSynthesisUtterance(text);
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (browserSpeechStop === stop) browserSpeechStop = null;
      resolve(ok);
    };
    const stop = () => {
      try { window.speechSynthesis.cancel(); } catch {}
      finish(false);
    };
    const onAbort = () => stop();
    utter.lang = "zh-CN";
    utter.rate = 0.95;
    utter.onend = () => finish(true);
    utter.onerror = () => finish(false);
    browserSpeechStop = stop;
    signal?.addEventListener("abort", onAbort, { once: true });
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  });
}

function playAudioBlobToEnd(blob, { signal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("语音播放已停止", "AbortError"));
      return;
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    let settled = false;
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      URL.revokeObjectURL(url);
      if (activeSpeechAudio === audio) activeSpeechAudio = null;
      if (activeSpeechStop === stop) activeSpeechStop = null;
    };
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      try { audio.pause(); } catch {}
      cleanup();
      if (error) reject(error);
      else resolve(true);
    };
    const onEnded = () => finish();
    const onError = () => finish(new Error("音频播放失败"));
    const onAbort = () => finish(new DOMException("语音播放已停止", "AbortError"));
    const stop = () => onAbort();
    activeSpeechAudio = audio;
    activeSpeechStop = stop;
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    audio.play().catch(onError);
  });
}

async function speakText(text, { force = false, signal = null } = {}) {
  if (!force && !config.autoSpeak) return { mode: "off" };
  if (signal?.aborted) return { mode: "stopped" };
  stopActiveSpeech();
  const speechController = new AbortController();
  const abortFromCaller = () => speechController.abort();
  const speechSignal = speechController.signal;
  activeSpeechController = speechController;
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  syncStopControl();

  try {
    let onlineError = "";
    if (config.ttsEnabled) {
      try {
        const controller = new AbortController();
        const ttsTimer = setTimeout(() => controller.abort(), 20000);
        const abortFromSpeech = () => controller.abort();
        speechSignal.addEventListener("abort", abortFromSpeech, { once: true });
        try {
          const res = await fetch("/api/tts", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text, config: apiConfigPayload() }),
            signal: controller.signal,
          });
          if (speechSignal.aborted) return { mode: "stopped" };
          if (res.ok) {
            const blob = await res.blob();
            if (speechSignal.aborted) return { mode: "stopped" };
            await playAudioBlobToEnd(blob, { signal: speechSignal });
            return { mode: "online" };
          }
          const data = await res.json().catch(() => ({}));
          onlineError = data.error || `HTTP ${res.status}`;
          console.warn("在线 TTS 失败", { status: res.status, ...data });
        } finally {
          clearTimeout(ttsTimer);
          speechSignal.removeEventListener("abort", abortFromSpeech);
        }
      } catch (err) {
        if (speechSignal.aborted) return { mode: "stopped" };
        onlineError = err && err.name === "AbortError" ? "TTS 请求超时" : explainFetchError(err);
        console.warn("在线 TTS 失败", err);
      }
    }
    if (config.browserTtsFallback || force) {
      const ok = await browserSpeak(text, { signal: speechSignal });
      if (speechSignal.aborted) return { mode: "stopped" };
      if (onlineError) return { mode: ok ? "browser" : "browser-failed", error: onlineError };
      return { mode: ok ? "browser" : "browser-failed" };
    }
    if (onlineError) return { mode: "failed", error: onlineError };
    return { mode: "skipped" };
  } finally {
    signal?.removeEventListener("abort", abortFromCaller);
    if (activeSpeechController === speechController) activeSpeechController = null;
    syncStopControl();
  }
}

function readyStatusAfterSpeak(result) {
  if (result?.mode === "stopped") return "已停止朗读";
  if (result?.mode === "browser" && result.error) return `在线 TTS 失败，已用浏览器朗读：${result.error}`;
  if (result?.mode === "browser-failed" && result.error) return `在线 TTS 失败，浏览器朗读也失败：${result.error}`;
  if (result?.mode === "browser-failed") return "浏览器朗读失败，请检查系统语音设置";
  if (result?.mode === "failed") return `朗读失败：${result.error || "未知错误"}`;
  return "";
}

async function sendText(text, options = {}) {
  const content = (text || "").trim();
  const image = options.image || pendingImage;
  if ((!content && !image?.url) || busy) return false;
  const callMode = options.callMode === true;
  const sessionGeneration = Number(options.callGeneration || 0);
  const sessionSignal = callMode ? callSessionAbort?.signal : null;
  const callStillActive = () => !callMode || (callActive && callGeneration === sessionGeneration);
  if (!config.llm.apiKey) {
    openSettings();
    setSettingsStatus("请先填写本地 API Key");
    return false;
  }
  if (image?.url && !modelSupportsVision()) {
    setStatus(`${config.llm.model} 不支持视觉输入，请切换到 Qwen/Qwen3.5-4B`);
    return false;
  }

  busy = true;
  syncInteractionState();
  await ensureConversationReady();
  const userContent = buildUserContent(content, image);
  messages.push({ role: "user", content: userContent });
  appendMessage("user", userContent, messages.length - 1);
  el.input.value = "";
  if (image === pendingImage) clearPendingImage();
  await saveHistory();
  setStatus("正在思考…");

  const requestMessages = messages.slice();
  const assistantIndex = messages.length;
  messages.push({ role: "assistant", content: "" });
  const row = appendMessage("assistant", "…", assistantIndex);
  let succeeded = false;
  const chatRequest = beginChatGeneration(sessionSignal);

  try {
    if (callMode && callStillActive()) setCallStatus("AI 正在思考…", "thinking");
    const data = await requestChatStreamWithFallback(
      requestMessages,
      row,
      chatRequest.controller.signal,
    );
    finishChatGeneration(chatRequest);
    messages[assistantIndex].content = data.reply;
    await saveHistory();
    await applyToolActions(data.toolActions || []);
    if (callMode && callStillActive()) setCallTranscript(`AI：${data.reply}`);
    if (!callMode || callStillActive()) {
      if (data.webSearch && data.webSearch.used) {
        const ws = data.webSearch;
        const flag = ws.ok ? `已联网(${ws.provider}, ${ws.count}条)` : `联网无结果(${ws.provider})`;
        setStatus(flag + "，可以继续聊");
      } else if (data.toolUsage?.length) {
        setStatus(`已调用工具：${data.toolUsage.join("、")}`);
      } else {
        setStatus("可以继续聊");
      }
    }
    let speakResult = { mode: "off" };
    if ((config.autoSpeak || callMode) && callStillActive()) {
      setStatus("正在朗读…");
      if (callMode) setCallStatus("AI 正在说话…", "speaking");
      speakResult = await speakText(data.reply, {
        force: callMode,
        signal: sessionSignal,
      });
    }
    if (callMode && callStillActive()) {
      const speakStatus = readyStatusAfterSpeak(speakResult);
      if (speakStatus) setCallTranscript(speakStatus);
      setCallStatus(callMuted ? "麦克风已静音" : "准备继续聆听…", callMuted ? "muted" : "connecting");
      setStatus("语音通话中");
    } else if (!callMode) {
      setStatus(readyStatusAfterSpeak(speakResult));
    }
    succeeded = true;
  } catch (err) {
    if (callMode && !callStillActive()) {
      removeAssistantPlaceholder(row, assistantIndex);
      await saveHistory();
      return false;
    }
    const stoppedByUser = chatRequest.userStopped;
    const partial = String(err.partial || "").trim();
    if (partial) {
      messages[assistantIndex].content = partial;
      setAssistantText(row, partial);
      await saveHistory();
      setStatus(stoppedByUser ? "已停止生成，已保留当前内容" : `生成中断：${explainFetchError(err)}`);
    } else {
      removeAssistantPlaceholder(row, assistantIndex);
      setStatus(stoppedByUser ? "已停止生成" : `发送失败：${explainFetchError(err)}`);
    }
    if (callMode && callStillActive()) {
      setCallStatus("回复失败，准备重试聆听", "error");
      setCallTranscript(explainFetchError(err));
    }
  } finally {
    finishChatGeneration(chatRequest);
    busy = false;
    syncInteractionState();
    if (callMode && callStillActive() && !callMuted) scheduleCallListening(sessionGeneration, 450);
  }
  return succeeded;
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

function setCallStatus(text, phase = "connecting") {
  if (el.callStatus) el.callStatus.textContent = text || "";
  if (el.callPanel) el.callPanel.dataset.phase = phase;
}

function setCallTranscript(text) {
  if (el.callTranscript) el.callTranscript.textContent = text || "";
}

function setCallLevel(level) {
  if (!el.callPanel) return;
  const normalized = Math.max(0, Math.min(1, Number(level) || 0));
  el.callPanel.style.setProperty("--call-level", normalized.toFixed(3));
}

function syncCallCameraUi() {
  const cameraOn = Boolean(callCameraStream);
  const visionSupported = modelSupportsVision();
  if (el.callOrb) el.callOrb.hidden = cameraOn;
  if (el.callCameraPreview) {
    el.callCameraPreview.hidden = !cameraOn;
    el.callCameraPreview.classList.toggle("front-facing", cameraOn && callCameraFacingMode === "user");
  }
  if (el.btnCallCamera) {
    el.btnCallCamera.classList.toggle("camera-on", cameraOn);
    el.btnCallCamera.setAttribute("aria-pressed", cameraOn ? "true" : "false");
    el.btnCallCamera.setAttribute("aria-label", cameraOn ? "关闭摄像头" : "打开摄像头");
    el.btnCallCamera.disabled = !callActive || callCameraBusy || (!cameraOn && busy);
  }
  if (el.callCameraLabel) el.callCameraLabel.textContent = cameraOn ? "关闭相机" : "摄像头";
  if (el.btnCallIdentify) {
    el.btnCallIdentify.disabled = !callActive || !cameraOn || !visionSupported || busy || callCameraBusy || callCameraAnalyzing;
  }
  if (el.btnCallCameraFlip) {
    el.btnCallCameraFlip.disabled = !callActive || !cameraOn || busy || callCameraBusy || callCameraAnalyzing;
  }
}

function waitForCallCameraReady(video, timeoutMs = 5000) {
  if (video?.videoWidth && video?.videoHeight && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (!video) {
      reject(new Error("找不到摄像头预览组件"));
      return;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("canplay", onReady);
      fn(value);
    };
    const onReady = () => {
      if (video.videoWidth && video.videoHeight) finish(resolve);
    };
    const timer = setTimeout(() => finish(reject, new Error("摄像头画面准备超时")), timeoutMs);
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("canplay", onReady);
  });
}

async function requestCallCameraStream(facingMode) {
  const constraints = {
    audio: false,
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  };
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (err?.name !== "OverconstrainedError") throw err;
    return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
  }
}

function stopCallCamera({ quiet = false } = {}) {
  const stream = callCameraStream;
  callCameraStream = null;
  if (stream) {
    try { stream.getTracks().forEach((track) => track.stop()); } catch {}
  }
  if (el.callCameraVideo) {
    try { el.callCameraVideo.pause(); } catch {}
    el.callCameraVideo.srcObject = null;
  }
  syncCallCameraUi();
  if (!quiet && callActive) {
    setCallStatus(callMuted ? "麦克风已静音" : "请说话，我在听", callMuted ? "muted" : "hearing");
    setCallTranscript("摄像头已关闭，语音通话仍在继续");
  }
}

async function openCallCamera(facingMode = callCameraFacingMode) {
  if (!callActive || callCameraBusy) return false;
  if (!modelSupportsVision()) {
    const message = `${config.llm.model} 不支持视觉输入，请切换到 Qwen/Qwen3.5-4B`;
    setCallStatus("当前模型不能识别画面", "error");
    setCallTranscript(message);
    setStatus(message);
    return false;
  }
  if (isInsecureContext() || !ensureMediaDevices()) {
    const message = cameraPermissionHint(new Error("camera unavailable"));
    setCallStatus("无法打开摄像头", "error");
    setCallTranscript(message);
    setStatus(message);
    return false;
  }

  const resumeListening = !callMuted && !busy;
  clearCallListenTimer();
  closeCallCapture({ discard: true });
  callCameraBusy = true;
  syncCallCameraUi();
  setCallStatus("正在打开摄像头…", "connecting");
  setCallTranscript(facingMode === "user" ? "正在切换到前置摄像头" : "正在切换到后置摄像头");
  stopCallCamera({ quiet: true });
  let stream = null;
  try {
    stream = await requestCallCameraStream(facingMode);
    if (!callActive) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }
    callCameraStream = stream;
    const track = stream.getVideoTracks()[0];
    const actualFacing = String(track?.getSettings?.().facingMode || facingMode);
    callCameraFacingMode = actualFacing === "user" ? "user" : facingMode;
    if (el.callCameraVideo) {
      el.callCameraVideo.srcObject = stream;
      try { await el.callCameraVideo.play(); } catch {}
      await waitForCallCameraReady(el.callCameraVideo);
    }
    track?.addEventListener?.("ended", () => {
      if (callCameraStream !== stream) return;
      stopCallCamera({ quiet: true });
      if (callActive) {
        setCallStatus("摄像头已停止", "error");
        setCallTranscript("摄像头可能被系统或其他应用关闭");
      }
    });
    syncCallCameraUi();
    setCallStatus(callMuted ? "麦克风已静音" : "请说话，我在听", callMuted ? "muted" : "hearing");
    setCallTranscript("摄像头已开启。按“识别”，或直接说“看看这个是什么”");
    return true;
  } catch (err) {
    if (stream) {
      try { stream.getTracks().forEach((track) => track.stop()); } catch {}
    }
    callCameraStream = null;
    const message = cameraPermissionHint(err);
    setCallStatus("无法打开摄像头", "error");
    setCallTranscript(message);
    setStatus(message);
    return false;
  } finally {
    callCameraBusy = false;
    syncCallCameraUi();
    if (resumeListening && callActive && !callMuted && !busy && !callCapture) {
      scheduleCallListening(callGeneration, 350);
    }
  }
}

async function toggleCallCamera() {
  if (!callActive || callCameraBusy) return;
  if (callCameraStream) {
    stopCallCamera();
    return;
  }
  await openCallCamera(callCameraFacingMode || "environment");
}

async function flipCallCamera() {
  if (!callActive || !callCameraStream || callCameraBusy || busy) return;
  const nextFacing = callCameraFacingMode === "user" ? "environment" : "user";
  await openCallCamera(nextFacing);
}

async function captureCallCameraFrame() {
  const video = el.callCameraVideo;
  if (!callCameraStream || !video) throw new Error("请先打开摄像头");
  await waitForCallCameraReady(video);
  const sourceWidth = Number(video.videoWidth || 0);
  const sourceHeight = Number(video.videoHeight || 0);
  if (!sourceWidth || !sourceHeight) throw new Error("摄像头暂时没有可用画面");
  const scale = Math.min(1, 1280 / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持摄像头截帧");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return {
    name: `摄像头画面-${new Date().toLocaleTimeString("zh-CN", { hour12: false })}.jpg`,
    url: await canvasToDataUrl(canvas, "image/jpeg", 0.78),
  };
}

function isCallVisualRequest(text) {
  const value = String(text || "").replace(/\s+/g, "").trim();
  if (!value) return false;
  return /(这是什么|这是谁|上面写了什么|读一下上面的字|识别一下|认一下这个)|(看看|看一下|看下|帮我看).{0,10}(这个|画面|镜头|摄像头|东西|物品|文字|上面|手里|眼前|面前)/.test(value);
}

async function analyzeCallCamera(prompt = "", generation = callGeneration) {
  if (!callActive || callGeneration !== generation || busy || callCameraAnalyzing) return false;
  if (!modelSupportsVision()) {
    const message = `${config.llm.model} 不支持视觉输入，请切换到 Qwen/Qwen3.5-4B`;
    setCallStatus("当前模型不能识别画面", "error");
    setCallTranscript(message);
    return false;
  }
  if (!callCameraStream) {
    setCallStatus("请先打开摄像头", "error");
    setCallTranscript("点下方“摄像头”，允许权限后再识别画面");
    return false;
  }

  clearCallListenTimer();
  closeCallCapture({ discard: true });
  callCameraAnalyzing = true;
  syncCallCameraUi();
  setCallStatus("正在截取画面…", "thinking");
  setCallTranscript("请保持摄像头稳定");
  let handedToChat = false;
  try {
    const image = await captureCallCameraFrame();
    if (!callActive || callGeneration !== generation) return false;
    callCameraAnalyzing = false;
    syncCallCameraUi();
    setCallStatus("AI 正在识别画面…", "thinking");
    setCallTranscript("正在分析物体、文字和界面");
    const query = String(prompt || "").trim() || "请识别摄像头当前画面中的物体、文字或界面，并用适合语音播报的简短中文回答。";
    handedToChat = true;
    return await sendText(query, { image, callMode: true, callGeneration: generation });
  } catch (err) {
    if (!callActive || callGeneration !== generation) return false;
    setCallStatus("画面识别失败", "error");
    setCallTranscript(explainFetchError(err));
    return false;
  } finally {
    callCameraAnalyzing = false;
    syncCallCameraUi();
    if (!handedToChat && callActive && callGeneration === generation && !callMuted && !busy && !callCapture) {
      scheduleCallListening(generation, 650);
    }
  }
}

function formatCallDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function updateCallTimer() {
  if (!el.callTimer) return;
  el.callTimer.textContent = formatCallDuration((Date.now() - callStartedAt) / 1000);
}

function clearCallListenTimer() {
  if (callListenTimer) clearTimeout(callListenTimer);
  callListenTimer = null;
}

function closeCallCapture({ discard = false } = {}) {
  const capture = callCapture;
  callCapture = null;
  if (!capture) return null;
  capture.closed = true;
  try { capture.processor.disconnect(); } catch {}
  try { capture.source.disconnect(); } catch {}
  try { capture.stream.getTracks().forEach((track) => track.stop()); } catch {}
  try { capture.context.close(); } catch {}
  setCallLevel(0);
  if (discard || !capture.speechDetected || !capture.chunks.length) return null;
  return new Blob([floatTo16kWav(flattenPcm(capture.chunks), capture.sampleRate)], { type: "audio/wav" });
}

async function transcribeCallAudio(blob, generation) {
  if (!callActive || callGeneration !== generation) return;
  if (!blob || blob.size < 3000) {
    scheduleCallListening(generation, 250);
    return;
  }
  busy = true;
  syncInteractionState();
  setCallStatus("正在识别…", "thinking");
  setCallTranscript("正在整理你刚才说的话");
  let handedToChat = false;
  try {
    const form = new FormData();
    form.append("file", blob, "call-speech.wav");
    const cfg = apiConfigPayload();
    if (!cfg.stt.model || cfg.stt.model.includes("TeleSpeech")) {
      cfg.stt.model = "FunAudioLLM/SenseVoiceSmall";
    }
    const controller = new AbortController();
    const sessionSignal = callSessionAbort?.signal;
    const abortFromSession = () => controller.abort();
    if (sessionSignal?.aborted) controller.abort();
    else sessionSignal?.addEventListener("abort", abortFromSession, { once: true });
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
      sessionSignal?.removeEventListener("abort", abortFromSession);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const text = String(data.text || "").trim();
    if (!callActive || callGeneration !== generation) return;
    if (!text) {
      setCallStatus("没听清，请再说一次", "connecting");
      setCallTranscript("请靠近麦克风，声音稍微大一点");
      return;
    }
    setCallTranscript(`你：${text}`);
    busy = false;
    syncInteractionState();
    if (isCallVisualRequest(text)) {
      if (!callCameraStream) {
        const notice = "摄像头还没有打开。请点下方的摄像头按钮，允许权限后再让我看。";
        setCallStatus("请先打开摄像头", "error");
        setCallTranscript(notice);
        try {
          await speakText(notice, { force: true, signal: callSessionAbort?.signal });
        } catch {}
        return;
      }
      handedToChat = true;
      await analyzeCallCamera(text, generation);
      return;
    }
    handedToChat = true;
    await sendText(text, { callMode: true, callGeneration: generation });
  } catch (err) {
    if (!callActive || callGeneration !== generation) return;
    const message = err?.name === "AbortError" ? "识别已停止" : explainFetchError(err);
    setCallStatus("识别失败，准备重试", "error");
    setCallTranscript(message);
  } finally {
    if (busy) {
      busy = false;
      syncInteractionState();
    }
    if (!handedToChat && callActive && callGeneration === generation && !callMuted && !callCapture && !busy) {
      scheduleCallListening(generation, 650);
    }
  }
}

async function startCallListening(generation) {
  if (!callActive || callGeneration !== generation || callMuted || busy || callCapture) return;
  if (!ensureMediaDevices()) throw new Error(micUnsupportedHint());
  setCallStatus("请说话，我在听", "hearing");
  setCallTranscript("停顿约 1 秒后会自动发送");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });
  if (!callActive || callGeneration !== generation || callMuted) {
    stream.getTracks().forEach((track) => track.stop());
    return;
  }
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const context = new AudioCtx();
  if (context.state === "suspended") await context.resume();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const capture = {
    stream,
    context,
    source,
    processor,
    sampleRate: context.sampleRate,
    chunks: [],
    preRoll: [],
    speechDetected: false,
    speechFrames: 0,
    noiseFloor: .004,
    startedAt: Date.now(),
    speechStartedAt: 0,
    lastVoiceAt: 0,
    closed: false,
  };
  callCapture = capture;
  processor.onaudioprocess = (event) => {
    if (capture.closed || callCapture !== capture) return;
    const input = event.inputBuffer.getChannelData(0);
    const chunk = new Float32Array(input);
    let energy = 0;
    for (let index = 0; index < input.length; index += 1) energy += input[index] * input[index];
    const rms = Math.sqrt(energy / input.length);
    setCallLevel(Math.min(1, rms * 12));
    const now = Date.now();

    if (!capture.speechDetected) {
      capture.preRoll.push(chunk);
      if (capture.preRoll.length > 8) capture.preRoll.shift();
      if (rms < .03) capture.noiseFloor = capture.noiseFloor * .92 + rms * .08;
      const startThreshold = Math.max(.016, capture.noiseFloor * 2.8);
      capture.speechFrames = rms >= startThreshold ? capture.speechFrames + 1 : 0;
      if (capture.speechFrames >= 2) {
        capture.speechDetected = true;
        capture.speechStartedAt = now;
        capture.lastVoiceAt = now;
        capture.chunks.push(...capture.preRoll);
        capture.preRoll = [];
        setCallStatus("听到你说话了…", "hearing");
        setCallTranscript("说完后自然停顿即可");
      }
      return;
    }

    capture.chunks.push(chunk);
    const sustainThreshold = Math.max(.01, capture.noiseFloor * 1.8);
    if (rms >= sustainThreshold) capture.lastVoiceAt = now;
    const speechMs = now - (capture.lastVoiceAt || capture.startedAt);
    const totalMs = now - (capture.speechStartedAt || now);
    if ((speechMs >= 1050 && totalMs >= 1200) || totalMs >= 20000) {
      const blob = closeCallCapture();
      transcribeCallAudio(blob, generation);
    }
  };
  source.connect(processor);
  processor.connect(context.destination);
}

function scheduleCallListening(generation = callGeneration, delay = 0) {
  clearCallListenTimer();
  if (!callActive || callGeneration !== generation || callMuted) return;
  callListenTimer = setTimeout(async () => {
    callListenTimer = null;
    if (!callActive || callGeneration !== generation || callMuted || busy || callCapture) return;
    try {
      await startCallListening(generation);
    } catch (err) {
      if (!callActive || callGeneration !== generation) return;
      const message = micPermissionHint(err);
      endVoiceCall("通话未接通");
      setStatus(`无法开始通话：${message}`);
    }
  }, delay);
}

async function startVoiceCall() {
  if (callActive || busy || isHoldingTalk()) return;
  if (!config.llm.apiKey || !hasSttKey()) {
    openSettings();
    setSettingsStatus("语音通话需要大模型和语音识别 API Key");
    return;
  }
  if (isInsecureContext() || !ensureMediaDevices()) {
    setStatus(micUnsupportedHint());
    return;
  }
  await ensureConversationReady();
  stopCallCamera({ quiet: true });
  callCameraFacingMode = "environment";
  callCameraBusy = false;
  callCameraAnalyzing = false;
  callActive = true;
  callMuted = false;
  callGeneration += 1;
  callStartedAt = Date.now();
  callSessionAbort = new AbortController();
  document.body.classList.add("in-call");
  el.callPanel?.classList.remove("hidden");
  el.btnCall?.classList.add("active");
  el.btnCall?.setAttribute("aria-pressed", "true");
  if (el.btnCall) {
    el.btnCall.title = "挂断语音通话";
    el.btnCall.setAttribute("aria-label", "挂断语音通话");
  }
  el.btnCallMute?.classList.remove("muted");
  el.btnCallMute?.setAttribute("aria-pressed", "false");
  if (el.callMuteLabel) el.callMuteLabel.textContent = "静音";
  if (el.callTimer) el.callTimer.textContent = "00:00";
  syncCallCameraUi();
  callTimerId = setInterval(updateCallTimer, 1000);
  syncInteractionState();
  setStatus("语音通话中");
  setCallStatus("正在接通…", "connecting");
  setCallTranscript("接通后直接说话，也可以打开摄像头识别物品。");
  scheduleCallListening(callGeneration, 250);
}

function endVoiceCall(reason = "通话已结束") {
  if (!callActive && el.callPanel?.classList.contains("hidden")) return;
  const duration = callStartedAt ? formatCallDuration((Date.now() - callStartedAt) / 1000) : "00:00";
  callActive = false;
  callMuted = false;
  callGeneration += 1;
  clearCallListenTimer();
  if (callTimerId) clearInterval(callTimerId);
  callTimerId = null;
  callSessionAbort?.abort();
  callSessionAbort = null;
  closeCallCapture({ discard: true });
  callCameraBusy = false;
  callCameraAnalyzing = false;
  stopCallCamera({ quiet: true });
  stopActiveSpeech();
  document.body.classList.remove("in-call");
  el.callPanel?.classList.add("hidden");
  el.btnCall?.classList.remove("active");
  el.btnCall?.setAttribute("aria-pressed", "false");
  if (el.btnCall) {
    el.btnCall.title = "开始语音通话";
    el.btnCall.setAttribute("aria-label", "开始语音通话");
  }
  syncInteractionState();
  setStatus(`${reason}，时长 ${duration}`);
}

function toggleCallMute() {
  if (!callActive) return;
  callMuted = !callMuted;
  el.btnCallMute?.classList.toggle("muted", callMuted);
  el.btnCallMute?.setAttribute("aria-pressed", callMuted ? "true" : "false");
  if (el.callMuteLabel) el.callMuteLabel.textContent = callMuted ? "取消静音" : "静音";
  if (callMuted) {
    clearCallListenTimer();
    closeCallCapture({ discard: true });
    setCallStatus("麦克风已静音", "muted");
    setCallTranscript("取消静音后可继续说话");
  } else {
    setCallStatus("正在恢复麦克风…", "connecting");
    scheduleCallListening(callGeneration, 150);
  }
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
  syncInteractionState();
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
    syncInteractionState();
    await sendText(text);
  } catch (err) {
    const msg = err && err.name === "AbortError" ? "识别超时，请再试一次" : explainFetchError(err);
    setStatus("识别失败：" + msg);
  } finally {
    busy = false;
    syncInteractionState();
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
        await copyMessageText(messageText(item.content));
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
          endpoint: serverDefaults.llm?.endpoint || "",
        },
        stt: {
          providerId: "",
          model: serverDefaults.stt?.model,
          apiType: serverDefaults.stt?.apiType || DEFAULTS.stt.apiType,
          endpoint: serverDefaults.stt?.endpoint || "",
        },
        tts: {
          providerId: "",
          model: serverDefaults.tts?.model,
          voice: serverDefaults.tts?.voice,
          apiType: serverDefaults.tts?.apiType || DEFAULTS.tts.apiType,
          endpoint: serverDefaults.tts?.endpoint || "",
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
      ? "微信 HTTP 不能录音：请在系统浏览器打开已部署的 Cloudflare HTTPS 地址"
      : "当前 HTTP 地址不能录音，请使用已部署的 Cloudflare HTTPS 地址");
  } else {
    setStatus("点右上角电话可连续通话；也可按住麦克风说话");
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

if (el.btnCall) {
  el.btnCall.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (callActive) {
      endVoiceCall();
      return;
    }
    try {
      await startVoiceCall();
    } catch (err) {
      endVoiceCall("通话未接通");
      setStatus(`无法开始通话：${micPermissionHint(err)}`);
    }
  });
}
el.btnHangup?.addEventListener("click", () => endVoiceCall());
el.btnCallMute?.addEventListener("click", toggleCallMute);
el.btnCallCamera?.addEventListener("click", async () => {
  await toggleCallCamera();
});
el.btnCallCameraFlip?.addEventListener("click", async () => {
  await flipCallCamera();
});
el.btnCallIdentify?.addEventListener("click", async () => {
  await analyzeCallCamera("请识别摄像头当前画面中的物体、文字或界面，并用适合语音播报的简短中文回答。", callGeneration);
});

el.btnSend.addEventListener("click", (e) => {
  if (isHoldingTalk()) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  sendText(el.input.value);
});

el.btnStop?.addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  const stoppedText = stopActiveTextGeneration();
  const stoppedSpeech = stopActiveSpeech();
  if (stoppedText) setStatus("正在停止生成…");
  else if (stoppedSpeech) setStatus("已停止朗读");
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
["llmApiType", "sttApiType", "ttsApiType"].forEach((key) => {
  el.fields?.[key]?.addEventListener("change", syncCustomEndpointFields);
});

for (const kind of Object.keys(BUILTIN_MODELS)) {
  const kindName = `${kind[0].toUpperCase()}${kind.slice(1)}`;
  const addButton = el.fields?.[`btnAdd${kindName}Model`];
  const input = modelField(kind);
  const list = modelList(kind);
  const trigger = modelTrigger(kind);
  trigger?.addEventListener("click", () => toggleModelMenu(kind));
  addButton?.addEventListener("click", () => addCustomModel(kind));
  input?.addEventListener("input", () => renderModelManager(kind));
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addCustomModel(kind);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setModelMenuOpen(kind, false);
      trigger?.focus();
    }
  });
  list?.addEventListener("click", (event) => {
    event.stopPropagation();
    const removeButton = event.target.closest("[data-remove-model-kind][data-model-value]");
    if (removeButton) {
      removeCustomModel(kind, removeButton.getAttribute("data-model-value") || "");
      return;
    }
    const valueButton = event.target.closest("[data-model-kind][data-model-value]");
    if (valueButton) {
      input.value = valueButton.getAttribute("data-model-value") || "";
      renderModelManager(kind);
      setModelMenuOpen(kind, false);
      trigger?.focus();
      setSettingsStatus(`已选择 ${input.value}，点击底部“保存到本地”后生效`);
    }
  });
}

document.addEventListener("click", (event) => {
  if (!event.target.closest("[data-model-picker]")) closeAllModelMenus();
});

["toolCallingEnabled", "webSearchEnabled", "searchProvider", "searchApiKey", "searchBaseUrl"].forEach((key) => {
  const input = el.fields?.[key];
  if (!input) return;
  const eventName = input.tagName === "SELECT" || input.type === "checkbox" ? "change" : "input";
  input.addEventListener(eventName, () => {
    applyLiveSearchSettings({ persist: key === "toolCallingEnabled" || key === "webSearchEnabled" || key === "searchProvider", quiet: false });
  });
});

el.btnAttach?.addEventListener("click", () => el.imageInput?.click());
el.btnRemoveImage?.addEventListener("click", clearPendingImage);
el.imageInput?.addEventListener("change", async () => {
  const file = el.imageInput.files?.[0];
  if (!file) return;
  try {
    await selectImageFile(file);
  } catch (err) {
    clearPendingImage();
    setStatus(`图片添加失败：${err.message || err}`);
  }
});
el.input?.addEventListener("paste", async (event) => {
  const file = [...(event.clipboardData?.files || [])].find((item) => String(item.type || "").startsWith("image/"));
  if (!file) return;
  event.preventDefault();
  try {
    await selectImageFile(file);
  } catch (err) {
    clearPendingImage();
    setStatus(`图片粘贴失败：${err.message || err}`);
  }
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
  const keepCustomModels = normalizeCustomModels(config.customModels);
  config = normalizeConfig({
    apiProviders: keepProviders,
    customModels: keepCustomModels,
    llm: {
      providerId: keepProviders[0]?.id || DEFAULT_PROVIDER_ID,
      model: serverDefaults?.llm?.model || DEFAULTS.llm.model,
      apiType: serverDefaults?.llm?.apiType || DEFAULTS.llm.apiType,
      endpoint: serverDefaults?.llm?.endpoint || DEFAULTS.llm.endpoint,
    },
    stt: {
      providerId: "",
      model: serverDefaults?.stt?.model || DEFAULTS.stt.model,
      apiType: serverDefaults?.stt?.apiType || DEFAULTS.stt.apiType,
      endpoint: serverDefaults?.stt?.endpoint || DEFAULTS.stt.endpoint,
    },
    tts: {
      providerId: "",
      model: serverDefaults?.tts?.model || DEFAULTS.tts.model,
      voice: serverDefaults?.tts?.voice || DEFAULTS.tts.voice,
      apiType: serverDefaults?.tts?.apiType || DEFAULTS.tts.apiType,
      endpoint: serverDefaults?.tts?.endpoint || DEFAULTS.tts.endpoint,
    },
    systemPromptPreset: serverDefaults?.systemPromptPreset || DEFAULTS.systemPromptPreset,
    systemPrompt: serverDefaults?.systemPrompt || DEFAULTS.systemPrompt,
    maxHistoryTurns: serverDefaults?.maxHistoryTurns ?? DEFAULTS.maxHistoryTurns,
    maxTokens: serverDefaults?.maxTokens ?? DEFAULTS.maxTokens,
    temperature: serverDefaults?.temperature ?? DEFAULTS.temperature,
    ttsEnabled: serverDefaults?.ttsEnabled ?? DEFAULTS.ttsEnabled,
    browserTtsFallback: serverDefaults?.browserTtsFallback ?? DEFAULTS.browserTtsFallback,
    autoSpeak: DEFAULTS.autoSpeak,
    toolCallingEnabled: serverDefaults?.toolCallingEnabled ?? DEFAULTS.toolCallingEnabled,
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
    if (document.hidden && callActive) endVoiceCall("页面进入后台，通话已结束");
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

window.addEventListener("pagehide", () => {
  if (callActive) endVoiceCall("通话已结束");
  else stopActiveSpeech();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && callActive) endVoiceCall();
});

bindSecretEyes();
bindMessageActions();

async function boot() {
  try {
    await migrateLegacyDatabaseIfNeeded();
    await loadConfigFromStore();
    fillSettingsForm();
    await initConversationStore();
  } catch (err) {
    console.error(err);
    setStatus(`本地数据库初始化失败：${err.message || err}`);
  }
  syncVoiceToggle();
  syncInteractionState();
  renderChat();
  await initDefaults();
  fillSettingsForm();
  syncVoiceToggle();
  checkDueReminders();
  setInterval(checkDueReminders, 15000);
}
boot();

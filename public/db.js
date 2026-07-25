/**
 * IndexedDB storage for AI语音通话.
 * - Current DB: ai-voice-call
 * - Migrates once from legacy DB / localStorage keys
 */
const DB_NAME = "ai-voice-call";
const DB_VERSION = 1;
const LEGACY_DB_NAMES = ["parent-chat-cf"];
const STORE_CONV = "conversations";
const STORE_META = "meta";

const META_CONFIG = "appConfig";
const META_CURRENT_ID = "currentId";
const META_MIGRATED = "migratedFromLegacy";

function openNamedDb(name, version = DB_VERSION) {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(name, version);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CONV)) {
        const store = db.createObjectStore(STORE_CONV, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error(`打开数据库失败: ${name}`));
  });
}

function openDb() {
  return openNamedDb(DB_NAME, DB_VERSION);
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB 事务失败"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB 事务中止"));
  });
}

function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB 请求失败"));
  });
}

let dbPromise = null;
function getDb() {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

export async function getMeta(key, fallback = null) {
  const db = await getDb();
  const tx = db.transaction(STORE_META, "readonly");
  const row = await reqDone(tx.objectStore(STORE_META).get(key));
  await txDone(tx);
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  const db = await getDb();
  const tx = db.transaction(STORE_META, "readwrite");
  tx.objectStore(STORE_META).put({ key, value });
  await txDone(tx);
}

export async function getAppConfig() {
  return getMeta(META_CONFIG, null);
}

export async function setAppConfig(config) {
  await setMeta(META_CONFIG, config);
  return config;
}

export async function hasAppConfig() {
  const cfg = await getAppConfig();
  return Boolean(cfg && typeof cfg === "object");
}

export async function listConversations() {
  const db = await getDb();
  const tx = db.transaction(STORE_CONV, "readonly");
  const rows = await reqDone(tx.objectStore(STORE_CONV).getAll());
  await txDone(tx);
  return (rows || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function getConversation(id) {
  if (!id) return null;
  const db = await getDb();
  const tx = db.transaction(STORE_CONV, "readonly");
  const row = await reqDone(tx.objectStore(STORE_CONV).get(id));
  await txDone(tx);
  return row || null;
}

export async function putConversation(conv) {
  const db = await getDb();
  const tx = db.transaction(STORE_CONV, "readwrite");
  tx.objectStore(STORE_CONV).put(conv);
  await txDone(tx);
  return conv;
}

export async function deleteConversation(id) {
  const db = await getDb();
  const tx = db.transaction(STORE_CONV, "readwrite");
  tx.objectStore(STORE_CONV).delete(id);
  await txDone(tx);
}

export function createConversationRecord(messages = []) {
  const now = Date.now();
  return {
    id: (crypto.randomUUID && crypto.randomUUID()) || `c_${now}_${Math.random().toString(36).slice(2, 8)}`,
    title: "新对话",
    createdAt: now,
    updatedAt: now,
    messages: Array.isArray(messages) ? messages : [],
  };
}

export function deriveTitle(messages) {
  const first = (messages || []).find((m) => m.role === "user" && messageText(m.content));
  if (!first) return "新对话";
  return (messageText(first.content) || "图片对话").replace(/\s+/g, " ").trim().slice(0, 24);
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

async function readAllFromLegacyDb(name) {
  let db;
  try {
    db = await openNamedDb(name, DB_VERSION);
  } catch {
    return null;
  }
  try {
    const hasConv = db.objectStoreNames.contains(STORE_CONV);
    const hasMeta = db.objectStoreNames.contains(STORE_META);
    let conversations = [];
    let metaRows = [];
    if (hasConv) {
      const tx = db.transaction(STORE_CONV, "readonly");
      conversations = (await reqDone(tx.objectStore(STORE_CONV).getAll())) || [];
      await txDone(tx);
    }
    if (hasMeta) {
      const tx = db.transaction(STORE_META, "readonly");
      metaRows = (await reqDone(tx.objectStore(STORE_META).getAll())) || [];
      await txDone(tx);
    }
    return { conversations, metaRows };
  } catch {
    return null;
  } finally {
    try { db.close(); } catch {}
  }
}

/**
 * If current DB is empty, copy from legacy IndexedDB names once.
 */
export async function migrateLegacyDatabaseIfNeeded() {
  const already = await getMeta(META_MIGRATED, false);
  if (already) return { migrated: false, reason: "already" };

  const existingConvs = await listConversations();
  const existingCfg = await getAppConfig();
  if ((existingConvs && existingConvs.length) || existingCfg) {
    await setMeta(META_MIGRATED, { at: Date.now(), source: "current-not-empty" });
    return { migrated: false, reason: "current-not-empty" };
  }

  for (const legacyName of LEGACY_DB_NAMES) {
    const legacy = await readAllFromLegacyDb(legacyName);
    if (!legacy) continue;
    const hasData = (legacy.conversations && legacy.conversations.length) || (legacy.metaRows && legacy.metaRows.length);
    if (!hasData) continue;

    const db = await getDb();
    const tx = db.transaction([STORE_CONV, STORE_META], "readwrite");
    const convStore = tx.objectStore(STORE_CONV);
    const metaStore = tx.objectStore(STORE_META);
    for (const conv of legacy.conversations || []) {
      if (conv && conv.id) convStore.put(conv);
    }
    for (const row of legacy.metaRows || []) {
      if (row && row.key != null) metaStore.put(row);
    }
    metaStore.put({ key: META_MIGRATED, value: { at: Date.now(), source: legacyName } });
    await txDone(tx);
    return { migrated: true, source: legacyName, conversations: (legacy.conversations || []).length };
  }

  await setMeta(META_MIGRATED, { at: Date.now(), source: "none" });
  return { migrated: false, reason: "no-legacy" };
}

export { META_CONFIG, META_CURRENT_ID, DB_NAME, LEGACY_DB_NAMES };

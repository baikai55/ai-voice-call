self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// 先不做离线缓存，避免接口或旧前端被缓存。注册它主要用于满足 PWA 安装能力。
self.addEventListener("fetch", () => {});

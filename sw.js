/* 서비스워커 — 웹 버전을 인터넷 없이도 열 수 있게 화면 파일을 저장해 둠
 * 전략: 화면 파일은 "인터넷 먼저, 안 되면 저장본" → 업데이트가 바로 반영됨
 * API 요청(공공데이터·Gemini)은 저장하지 않음 */
const CACHE = "pick-me-up-v3";
const SHELL = [
  "./", "./index.html", "./style.css", "./app.js", "./scoring.js", "./manifest.webmanifest",
  "./fonts/Galmuri11.woff2", "./fonts/Galmuri11-Bold.woff2", "./fonts/Galmuri14.woff2",
  "./icons/icon-192.png", "./icons/favicon-32.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;  // 외부 API 는 그대로 통과
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match("./index.html")))
  );
});

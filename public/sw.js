const CACHE_NAME = "lek-varroascan-v2";

function getBasePath() {
  const scope = new URL(self.registration.scope);
  const path = scope.pathname.endsWith("/") ? scope.pathname.slice(0, -1) : scope.pathname;
  return path;
}

self.addEventListener("install", (event) => {
  const basePath = getBasePath();
  const urlsToCache = [`${basePath}/`, `${basePath}/manifest.webmanifest`, `${basePath}/icon.svg`];
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(async () => {
          const basePath = getBasePath();
          const cached = await caches.match(`${basePath}/`);
          if (cached) return cached;
          return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
        }),
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request)),
  );
});

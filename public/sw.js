const CACHE_NAME = "lek-varroascan-v3";

function getBasePath() {
  const scope = new URL(self.registration.scope);
  const path = scope.pathname.endsWith("/") ? scope.pathname.slice(0, -1) : scope.pathname;
  return path;
}

self.addEventListener("install", (event) => {
  const basePath = getBasePath();
  const urlsToCache = [
    `${basePath}/`,
    `${basePath}/manifest.webmanifest`,
    `${basePath}/icon.svg`,
  ];
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
      (async () => {
        try {
          const response = await fetch(request);
          const basePath = getBasePath();
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(`${basePath}/`, copy));
          return response;
        } catch {
          const basePath = getBasePath();
          const cached = await caches.match(`${basePath}/`);
          if (cached) return cached;
          return new Response("Offline", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          });
        }
      })(),
    );
    return;
  }

  const basePath = getBasePath();
  const pathname = url.pathname;
  const isNextStatic =
    pathname.startsWith(`${basePath}/_next/`) || pathname.startsWith("/_next/");
  const isPrecached =
    pathname === `${basePath}/manifest.webmanifest` ||
    pathname === `${basePath}/icon.svg`;

  if (isNextStatic || isPrecached) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          const copy = response.clone();
          void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        });
      }),
    );
    return;
  }

  event.respondWith(fetch(request).catch(() => caches.match(request)));
});

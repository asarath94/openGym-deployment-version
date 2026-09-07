/* openGym service worker — runtime caching.
   Media (exercise images/videos) is cache-first.
   Everything else is network-first with offline fallback.

   Exercise media is served from the pinned jsDelivr copy of:
   hasaneyldrm/exercises-dataset

   The media paths are:
     /images/
     /videos/
*/

const CACHE = "opengym-rt-v1";

const MEDIA_CDN_ORIGIN = "https://cdn.jsdelivr.net";

const MEDIA_CDN_PATHS = [
  "/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/images/",
  "/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd/videos/",
];

function isExerciseMedia(url) {
  // Existing same-origin media support.
  if (
    url.origin === location.origin &&
    (url.pathname.includes("/img/") || url.pathname.includes("/gif/"))
  ) {
    return true;
  }

  // External jsDelivr exercise media.
  if (url.origin !== MEDIA_CDN_ORIGIN) {
    return false;
  }

  return MEDIA_CDN_PATHS.some((path) => url.pathname.startsWith(path));
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("push", (e) => {
  const data = e.data ? e.data.json() : {};

  e.waitUntil(
    self.registration.showNotification(data.title || "openGym", {
      body: data.body || "",
      icon: "icon-512.png",
      badge: "icon-180.png",
      tag: data.tag || "opengym",
      renotify: true,
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();

  e.waitUntil(
    self.clients
      .matchAll({
        type: "window",
      })
      .then((clients) => {
        const c = clients.find((c) => "focus" in c);

        return c ? c.focus() : self.clients.openWindow("./");
      }),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  if (e.request.method !== "GET") {
    return;
  }

  /*
   * API requests are never intercepted or cached.
   */
  if (url.origin === location.origin && url.pathname.startsWith("/api/")) {
    return;
  }

  /*
   * Exercise media:
   *
   *   local /img/ and /gif/
   *   OR
   *   trusted jsDelivr /images/ and /videos/
   *
   * Use cache-first because these assets are version-pinned
   * and therefore effectively immutable.
   */
  if (isExerciseMedia(url)) {
    e.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(e.request).then((hit) => {
          if (hit) {
            return hit;
          }

          return fetch(e.request).then((res) => {
            /*
             * Cross-origin image/video requests may produce an opaque
             * response (status 0). That is still usable by the browser
             * and can be stored with Cache.put().
             *
             * Cache successful normal responses and opaque media responses,
             * but do not cache actual HTTP errors.
             */
            if (res.ok || res.type === "opaque") {
              return cache.put(e.request, res.clone()).then(() => res);
            }

            return res;
          });
        }),
      ),
    );

    return;
  }

  /*
   * Everything else must remain same-origin.
   *
   * This prevents the service worker from becoming a generic
   * cross-origin request interceptor.
   */
  if (url.origin !== location.origin) {
    return;
  }

  /*
   * Normal application requests:
   * network-first, then cached response,
   * then index.html as the final offline fallback.
   */
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          caches.open(CACHE).then((cache) => cache.put(e.request, res.clone()));
        }

        return res;
      })
      .catch(() =>
        caches
          .match(e.request)
          .then((hit) => hit || caches.match("index.html")),
      ),
  );
});

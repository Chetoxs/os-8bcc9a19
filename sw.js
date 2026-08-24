// ОСЬ · service worker. SPEC обещает офлайн — значит, оболочка обязана лежать
// в кэше ДО первого офлайн-запуска (аудит №4, PWA-P1: раньше install был пуст,
// и первый запуск без сети давал белый экран).
//
// Четыре кэша с разными сроками жизни:
//   shell  — HTML, entry-бандл, стили: precache при установке;
//   runtime — остальная статика: stale-while-revalidate;
//   media  — голос, арт, файлы шрифтов: вечно, вне номера сборки;
//   model  — 21 МБ MediaPipe: отдельно, чтобы не сносить его при обновлении.

// База берётся из ОБЛАСТИ самого воркера, а не зашивается. На своём домене
// это «/», на бесплатном хостинге — «/os/», и все сверки путей ниже обязаны
// считать от неё: иначе startsWith("/voice/") никогда не совпадёт, озвучка
// и модель позы потеряют свои ветки кэша, а сбоя при этом не будет — просто
// перестанет работать половина.
// Считаем от АДРЕСА самого скрипта, а не от self.registration: на первом
// исполнении воркера обращение к registration роняет его целиком, и браузер
// сообщает об этом невнятным «ошибка при загрузке скрипта» — регистрация
// молча не проходит, офлайна нет, а в консоли ни строки о причине.
// Скрипт всегда лежит в корне своей области, значит его папка и есть база.
const BASE = new URL("./", self.location).pathname.replace(/\/+$/, "");
const at = (p) => BASE + p;

const BUILD = "1.75.0-mt7cm5c9";
const SHELL = `os-shell-${BUILD}`;
const RUNTIME = `os-runtime-${BUILD}`;
const MODEL = "os-model-v1"; // версия модели меняется руками, не сборкой
// Имя этого кэша не содержит BUILD, и в этом весь смысл. Записи голоса названы
// по отпечатку содержимого (одно имя — один байт-в-байт файл), фото упражнений
// и woff2 не меняются вовсе. Пока они лежали в кэшах с номером сборки, activate
// сносил их при КАЖДОМ обновлении, и человек шёл в зал докачивать ~2 МБ — а без
// сети дух молчал и фото упражнений исчезали.
// Версию поднимают руками, как у модели: если файл когда-нибудь подменят под
// тем же именем, только это и заставит кэш забыть старое.
const MEDIA = "os-media-v1";
const PRECACHE = ["/os-8bcc9a19/","/os-8bcc9a19/index.html","/os-8bcc9a19/manifest.webmanifest","/os-8bcc9a19/fonts/fonts.css","/os-8bcc9a19/assets/index-Cov5ALDH.css","/os-8bcc9a19/assets/react-DZRUXSPQ.js","/os-8bcc9a19/assets/index-DojaSPtM.js","/os-8bcc9a19/assets/measureCva-dVgQoISH.js"];

/**
 * Что живёт вечно. `fonts.css` сюда не попадает намеренно: имя у него
 * постоянное, содержимое меняется со сборкой, и он лежит в precache оболочки.
 * pack.json тоже исключён — это манифест, ему положено быть свежим.
 */
const isMedia = (p) =>
  p.startsWith(at("/voice/"))
    ? !p.endsWith(".json")
    : p.startsWith("/art/") || (p.startsWith("/fonts/") && p.endsWith(".woff2"));

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))
      .then(() => undefined)
  );
  // skipWaiting не вызываем: открытая сессия не должна подменяться под руками —
  // новая версия ставится по кнопке «Обновить» (аудит №4, PWA-P4)
});

self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== SHELL && k !== RUNTIME && k !== MODEL && k !== MEDIA).map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

const putSafe = async (cacheName, request, response) => {
  try {
    const c = await caches.open(cacheName);
    await c.put(request, response);
  } catch {
    /* нет места — работаем без кэша, но не падаем */
  }
};


/**
 * Ответ на запрос с диапазоном, собранный из кэша.
 *
 * Медиа-элемент почти всегда начинает с «Range: bytes=0-1», чтобы узнать
 * длину. Если отдать ему полный ответ 200 вместо 206, Safari просто
 * отказывается воспроизводить — молча, без ошибки в консоли. Именно так
 * записанный голос духа не зазвучал бы на айфоне, хотя файлы лежат в кэше
 * и подпись в настройках говорит «Говорит записанный голос».
 *
 * Файлы озвучки по пятнадцать килобайт, поэтому режем в памяти без затей.
 */
async function rangeFromCache(request, cacheName) {
  // Кэш называем поимённо: caches.match без имени идёт по всем кэшам в порядке
  // создания и может отдать копию из кэша прошлой сборки вместо вечной.
  const hit = await caches.match(request, { ignoreVary: true, cacheName });
  const res = hit || (await fetch(request).then((r) => (r.ok ? (putSafe(cacheName, request, r.clone()), r) : null)).catch(() => null));
  if (!res) return Response.error();
  const buf = await res.arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(request.headers.get("range") || "");
  const start = m && m[1] ? Number(m[1]) : 0;
  const end = m && m[2] ? Math.min(Number(m[2]), buf.byteLength - 1) : buf.byteLength - 1;
  if (!(start >= 0 && start <= end && end < buf.byteLength)) {
    return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${buf.byteLength}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "application/octet-stream",
      "Content-Range": `bytes ${start}-${end}/${buf.byteLength}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET" || !request.url.startsWith(self.location.origin)) return;
  const url = new URL(request.url);

  // Навигация: сеть свежее, кэш надёжнее. ignoreSearch — чтобы шорткаты
  // вида /?tab=workout не мимо кэша
  // Запрос с диапазоном — только 206, иначе Safari не проиграет медиа
  if (request.headers.has("range")) {
    e.respondWith(rangeFromCache(request, isMedia(url.pathname) ? MEDIA : RUNTIME));
    return;
  }

  if (request.mode === "navigate") {
    e.respondWith(
      fetch(request)
        .then((res) => {
          putSafe(SHELL, at("/") || "/", res.clone());
          return res;
        })
        .catch(async () => {
          // Оболочка лежит только в SHELL — ищем там, а не по всем кэшам подряд
          const hit = await caches.match(request, { ignoreSearch: true, cacheName: SHELL });
          return hit || (await caches.match("/", { cacheName: SHELL })) || Response.error();
        })
    );
    return;
  }

  // Модель позы: 21 МБ — свой кэш, cache-first навсегда
  if (url.pathname.startsWith(at("/mediapipe/"))) {
    e.respondWith(
      caches.match(request, { cacheName: MODEL }).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            putSafe(MODEL, request, res.clone());
            return res;
          })
      )
    );
    return;
  }

  // Манифест озвучки — сеть впереди: имя постоянное, список реплик меняется со
  // сборкой. Копию всё равно держим: без неё дух в зале без сети замолкает,
  // хотя все записи лежат в кэше рядом.
  if (url.pathname.startsWith(at("/voice/")) && url.pathname.endsWith(".json")) {
    e.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) putSafe(MEDIA, request, res.clone());
          return res;
        })
        .catch(async () => (await caches.match(request, { cacheName: MEDIA })) || Response.error())
    );
    return;
  }

  // Вечное: голос, арт, шрифты. Кладём только удачные ответы — кэш без номера
  // сборки не забудет 404 сам, и одна промашка сети замолчала бы форму навсегда
  if (isMedia(url.pathname)) {
    e.respondWith(
      caches.match(request, { cacheName: MEDIA }).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) putSafe(MEDIA, request, res.clone());
            return res;
          })
      )
    );
    return;
  }

  // Хэшированные ассеты Vite неизменяемы — cache-first
  if (url.pathname.startsWith(at("/assets/")) || url.pathname.startsWith(at("/fonts/"))) {
    e.respondWith(
      caches.match(request, { cacheName: SHELL }).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            putSafe(SHELL, request, res.clone());
            return res;
          })
      )
    );
    return;
  }

  // Остальное — stale-while-revalidate: мгновенно из кэша, обновление в фоне.
  // Здесь имя кэша НЕ указываем намеренно: сюда попадает и manifest.webmanifest,
  // который лежит в precache оболочки, а не в runtime.
  e.respondWith(
    caches.match(request).then((hit) => {
      const fresh = fetch(request)
        .then((res) => {
          putSafe(RUNTIME, request, res.clone());
          return res;
        })
        .catch(() => hit);
      return hit || fresh;
    })
  );
});

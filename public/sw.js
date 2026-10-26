/* Premier ERP — service worker.
 *
 * What this is for: an inspector on a remote site opens the app and it
 * opens, with no internet, because everything it needs to run was put on
 * the machine the last time there was a connection.
 *
 * __BUILD__ is replaced by the server with an id derived from the bytes of
 * the files below, so it changes exactly when they do and not otherwise.
 * A redeploy of identical files is not an update.
 *
 * Three rules this file keeps, each for a reason that costs real work if
 * it is broken:
 *
 *   It never answers an API request. Everything under /api and /sync goes
 *   to the network untouched. A cached reply would show an inspector a
 *   work order that has since changed, and - far worse - could let the
 *   outbox believe a record was accepted when nothing was sent.
 *
 *   It never installs itself over a running app. A new build waits, and is
 *   activated only when the app asks it to, which the app only offers when
 *   the server says that build has been released. Nobody loses a
 *   half-typed report to a background update.
 *
 *   It caches only GET. A POST is somebody's work going somewhere; it is
 *   not ours to replay.
 */
const BUILD = '__BUILD__';
const CACHE = 'premier-erp-' + BUILD;

/* Everything needed to open the app and print a report with no network.
   pdf-lib is here although the page loads it lazily - it is only needed
   when a report has a document to merge, which is exactly the thing an
   inspector does on site - and so is the logo, which is fetched at
   runtime rather than embedded. */
const SHELL = [
  '/',
  '/index.html',
  '/ir-drawings.js',
  '/pdf-lib.min.js',
  '/ptis-logo.png',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
];

/* The web fonts the page asks Google for. Without them the app still
   works, so a failure here must never fail the install - but with them it
   looks like itself on a site with no signal, which is worth one request. */
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    /* One at a time, and tolerated individually: addAll rejects the whole
       install if any single request fails, which would leave a machine
       with no offline copy at all because one icon was missing. */
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'reload' });
        if (res && res.ok) await cache.put(url, res.clone());
      } catch (err) { /* recorded by its absence; the fetch handler copes */ }
    }));
    // No skipWaiting: see the note at the top. This build waits to be asked.
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter((n) => n.startsWith('premier-erp-') && n !== CACHE)
      .map((n) => caches.delete(n)));
    /* Take over the open pages. Only reached once the app has asked for
       this build, so it is not a surprise to anybody. */
    await self.clients.claim();
  })());
});

/* The app asks for this build when the person clicks Apply. */
self.addEventListener('message', (e) => {
  const msg = e.data || {};
  if (msg.type === 'activate') self.skipWaiting();
  if (msg.type === 'build' && e.source) e.source.postMessage({ type: 'build', build: BUILD });
});

function isApi(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/sync/');
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // not ours to replay

  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  /* Never, under any circumstance, from the cache. */
  if (isApi(url)) return;

  if (FONT_HOSTS.indexOf(url.hostname) >= 0) {
    e.respondWith(cacheFirst(req, true));
    return;
  }

  if (url.origin !== self.location.origin) return;  // somebody else's business

  /* Opening the app: the installed build, straight from the machine. It is
     the build until the person asks for another one, so there is nothing
     to check with the network first - and this is what makes it open at
     all on a rig. */
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = (await cache.match('/index.html')) || (await cache.match('/'));
      if (hit) return hit;
      try { return await fetch(req); }
      catch (err) {
        return new Response(
          '<!doctype html><meta charset="utf-8"><title>Premier ERP</title>' +
          '<body style="font:15px system-ui;padding:40px;max-width:34em;margin:auto">' +
          '<h2>Not installed yet</h2><p>This machine has no offline copy of the app, ' +
          'and there is no connection to fetch one. Connect once, let the page finish ' +
          'loading, and it will open without internet after that.</p>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
      }
    })());
    return;
  }

  e.respondWith(cacheFirst(req, true));
});

/* What is on the machine, or else the network - and what the network gives
   is kept for next time. The installed build does not change underneath
   the person, so there is no revalidation here by design. */
async function cacheFirst(req, store) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  /* An opaque cross-origin response (the font files) has no readable
     status; it is still worth keeping, and a bad one costs a retry. */
  if (store && res && (res.ok || res.type === 'opaque')) {
    try { await cache.put(req, res.clone()); } catch (err) { /* over quota */ }
  }
  return res;
}

/* Trade CRM service worker: caches ONLY the app shell (code, styles, icons) so the app opens offline.
 *
 * Safety rules (do not loosen):
 *  - Only same-origin GET requests for files on the SHELL list below are ever cached.
 *  - Supabase (API, auth, storage, RPC) is a different origin, so it is never touched or cached.
 *  - doc.html (customer quote/invoice pages), lead-form.html (and its submissions), photos and any
 *    request with an Authorization header are passed straight to the network, never cached.
 *  - Shell files are fetched network-first, so when online you always get the newest files;
 *    the cache is only the offline fallback.
 * Releasing a new version: change VERSION. Old caches are deleted on activate, and the open app
 * shows "Update available - Reload".
 */
const VERSION = 'v2.1.0';
const CACHE = 'trade-crm-shell-' + VERSION;
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'config.js', 'js/logic.js', 'js/store.js',
  'vendor/supabase.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'
];
const SCOPE = new URL(self.registration.scope);
const SHELL_PATHS = new Set(SHELL.map(p => new URL(p, SCOPE).pathname));
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', event => {
  // cache: 'reload' skips the browser HTTP cache so a new version gets truly fresh files
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(p => new Request(p, { cache: 'reload' })))));
  // No automatic skipWaiting on updates: the page asks the user first (see app.js). First install activates immediately anyway.
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('trade-crm-shell-') && k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isShellRequest(req) {
  if (req.method !== 'GET') return false;
  const url = new URL(req.url);
  if (url.origin !== SCOPE.origin) return false;                 // Supabase & anything external: never
  if (req.headers.has('authorization')) return false;
  if (req.mode === 'navigate') return url.pathname === SCOPE.pathname || url.pathname === new URL('index.html', SCOPE).pathname;
  return SHELL_PATHS.has(url.pathname) && !url.search;            // exact shell files only
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  const key = req.mode === 'navigate' ? new URL('index.html', SCOPE).href : req.url;
  let timer;
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), NETWORK_TIMEOUT_MS); })
    ]);
    clearTimeout(timer);
    if (res && res.ok && res.type === 'basic') cache.put(key, res.clone());
    return res;
  } catch (e) {
    clearTimeout(timer);
    const hit = await cache.match(key, { ignoreSearch: req.mode === 'navigate' });
    if (hit) return hit;
    throw e;
  }
}

self.addEventListener('fetch', event => {
  if (!isShellRequest(event.request)) return;   // not ours: browser handles it normally, nothing cached
  event.respondWith(networkFirst(event.request));
});

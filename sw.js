// Service worker: aplikacja działa offline (np. na iPhonie z ekranu początkowego).
// Pliki aplikacji: najpierw sieć, w razie braku – pamięć podręczna. API zawsze z sieci.
const CACHE = 'analiza-v13';
const PRECACHE = [
  './', 'index.html', 'style.css', 'app.js', 'engine.js', 'classify.js', 'pgn.js', 'db-worker.js',
  'manifest.webmanifest', 'icon-180.png', 'favicon.png', 'logo.png', 'icon-192.png', 'icon-512.png',
  'data/openings.json', 'data/pieces.json',
  'vendor/chess.js', 'vendor/chessground/chessground.js', 'vendor/chessground/chessground.base.css',
  'vendor/stockfish/stockfish-19-lite-single.js', 'vendor/stockfish/stockfish-19-lite-single.wasm',
  'board/brown.png', 'store.js', 'pgn-tree.js', 'train.js', 'fx.js', 'study.js', 'cat.png', 'play.js', 'profile.js', 'home.js', 'charts.js', 'material.js', 'vendor/motion.js', 'vendor/anime.esm.min.js', 'vendor/peerjs.min.js', 'data/book.json', 'vendor/anime.esm.min.js',
  ...['wP', 'wN', 'wB', 'wR', 'wQ', 'wK', 'bP', 'bN', 'bB', 'bR', 'bQ', 'bK'].map((p) => `piece/cburnett/${p}.svg`),
  ...['Move', 'Capture', 'Check', 'Checkmate', 'Error', 'Confirmation', 'GenericNotify'].map((s) => `sound/standard/${s}.mp3`),
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE).catch(() => {})).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return r;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});

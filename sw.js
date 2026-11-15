// Service worker Shakkusti: aplikacja działa offline (np. na iPhonie z ekranu początkowego).
// Pliki aplikacji: najpierw sieć, w razie braku – pamięć podręczna. API zawsze z sieci.
const CACHE = 'shakkusti-mwh4hsi8';
const PRECACHE = ['./', ...["app.js","board/brown.png","bots/cat-0.png","bots/cat-1.png","bots/cat-10.png","bots/cat-11.png","bots/cat-12.png","bots/cat-13.png","bots/cat-14.png","bots/cat-15.png","bots/cat-2.png","bots/cat-3.png","bots/cat-4.png","bots/cat-5.png","bots/cat-6.png","bots/cat-7.png","bots/cat-8.png","bots/cat-9.png","cat.png","charts.js","classify.js","data/book.json","data/openings.json","data/pieces.json","db-worker.js","engine.js","favicon.png","fx.js","home.js","icon-180.png","icon-192.png","icon-512.png","icons.js","index.html","logo.png","manifest.webmanifest","material.js","pgn-tree.js","pgn.js","piece/cburnett/bB.svg","piece/cburnett/bK.svg","piece/cburnett/bN.svg","piece/cburnett/bP.svg","piece/cburnett/bQ.svg","piece/cburnett/bR.svg","piece/cburnett/wB.svg","piece/cburnett/wK.svg","piece/cburnett/wN.svg","piece/cburnett/wP.svg","piece/cburnett/wQ.svg","piece/cburnett/wR.svg","play.js","profile.js","sound/standard/Capture.mp3","sound/standard/Check.mp3","sound/standard/Checkmate.mp3","sound/standard/Confirmation.mp3","sound/standard/Error.mp3","sound/standard/GenericNotify.mp3","sound/standard/Move.mp3","store.js","study.js","style.css","train.js","vendor/anime.esm.min.js","vendor/chess.js","vendor/chessground/anim.js","vendor/chessground/api.js","vendor/chessground/autoPieces.js","vendor/chessground/board.js","vendor/chessground/chessground.base.css","vendor/chessground/chessground.brown.css","vendor/chessground/chessground.cburnett.css","vendor/chessground/chessground.js","vendor/chessground/chessground.min.js","vendor/chessground/config.js","vendor/chessground/drag.js","vendor/chessground/draw.js","vendor/chessground/drop.js","vendor/chessground/events.js","vendor/chessground/explosion.js","vendor/chessground/fen.js","vendor/chessground/premove.js","vendor/chessground/render.js","vendor/chessground/state.js","vendor/chessground/svg.js","vendor/chessground/sync.js","vendor/chessground/types.js","vendor/chessground/util.js","vendor/chessground/wrap.js","vendor/motion.js","vendor/peerjs.min.js","vendor/stockfish/stockfish-19-lite-single.js","vendor/stockfish/stockfish-19-lite-single.wasm"]];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u)))).then(() => self.skipWaiting()));
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

import { Chessground } from './vendor/chessground/chessground.js';
import { Chess } from './vendor/chess.js';
import { Engine, listEngines, WASM_ID } from './engine.js';
import * as C from './classify.js';
import { splitGames, buildGame, gameFromFen, parseHeaders } from './pgn.js';
import { idb } from './store.js';
import * as fx from './fx.js';
import { initTraining, onShowTab, addMistakesFromReview, drills, openPuzzles, repDue, repCoverFen, startDrill } from './train.js';
import { initHome, renderHome, miniBoard } from './home.js';
import { initStudy, onShowStudyTab, catSays, setStudySub } from './study.js';
import { initPlay, onShowPlayTab, quickPlay, playBots, playCareer, playFriend } from './play.js';
import { initProfile, profile, saveProfile, lichessToken, lichessUser, avatarHtml, markActive, streak, pushRating, ratingHistory } from './profile.js';

// ---------- narzędzia ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const epd = (fen) => fen.split(' ').slice(0, 4).join(' ');
const store = {
  get(k, d) { try { const v = localStorage.getItem('ca.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ca.' + k, JSON.stringify(v)); } catch {} },
};
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}
const ROLES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const BOARDS = ['brown.png', 'wood4.jpg', 'wood.jpg', 'wood2.jpg', 'wood3.jpg', 'maple.jpg', 'maple2.jpg', 'horsey.jpg', 'leather.jpg', 'blue.png', 'blue2.jpg', 'blue3.jpg', 'blue-marble.jpg', 'canvas2.jpg', 'green.png', 'green-plastic.png', 'marble.jpg', 'grey.jpg', 'metal.jpg', 'olive.jpg', 'ic.png', 'purple.png', 'purple-diag.png', 'pink-pyramid.png', 'ncf-board.png', 'svg/newspaper.svg'];

// ---------- dźwięki (lichess) ----------
// Dźwięki przez Web Audio: odblokowanie przy pierwszym kliknięciu/dotyku (iPhone, autoplay),
// wstępnie zdekodowane bufory = brak opóźnień i blokad przy ruchach przeciwnika.
const sound = {
  set: store.get('soundSet', 'standard'),
  vol: store.get('soundVol', 0.7),
  ctx: null,
  buffers: new Map(),
  loading: new Map(),
  ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    return this.ctx;
  },
  load(name) {
    const url = `sound/${this.set}/${name}.mp3`;
    if (this.buffers.has(url)) return Promise.resolve(this.buffers.get(url));
    if (!this.loading.has(url)) {
      const ctx = this.ensureCtx();
      if (!ctx) return Promise.resolve(null);
      this.loading.set(url, fetch(url).then((r) => r.arrayBuffer()).then((b) => new Promise((res, rej) => { const pr = ctx.decodeAudioData(b, res, rej); pr?.catch?.(() => {}); }))
        .then((buf) => { this.buffers.set(url, buf); return buf; }).catch(() => null));
    }
    return this.loading.get(url);
  },
  preload() { for (const n of ['Move', 'Capture', 'Check', 'Checkmate', 'Error', 'Confirmation', 'GenericNotify']) this.load(n); },
  async play(name) {
    if (this.set === 'off' || this.vol <= 0) return;
    const ctx = this.ensureCtx();
    if (!ctx) { const a = new Audio(`sound/${this.set}/${name}.mp3`); a.volume = this.vol; a.play().catch(() => {}); return; }
    const buf = await this.load(name);
    if (!buf) return;
    const src = ctx.createBufferSource();
    const gain = ctx.createGain();
    gain.gain.value = this.vol;
    src.buffer = buf;
    src.connect(gain).connect(ctx.destination);
    src.start();
  },
  forSan(san) {
    if (!san) return;
    if (san.includes('#')) this.play('Checkmate');
    else if (san.includes('+')) this.play('Check');
    else if (san.includes('x')) this.play('Capture');
    else this.play('Move');
  },
};
// pierwsza interakcja odblokowuje dźwięk (wymóg przeglądarek, szczególnie Safari na iPhonie)
for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
  window.addEventListener(ev, () => { sound.ensureCtx(); sound.preload(); }, { once: true, passive: true });
}
let lastSoundFen = null;
let muteNextSound = true;

// ---------- stan ----------
const S = {
  server: false,
  game: gameFromFen(new Chess().fen()),
  ply: 0,
  explore: null, // {base, moves:[{san,uci,fen,from,to}], idx}
  evals: [],
  review: null,
  reviewing: false,
  orientation: 'white',
  openings: {},
  pieces: {},
  live: { lines: [], fen: null, depth: 0 },
  retry: null,
  playing: null,
  trees: { mytree: null, mydb: null },
  treeGames: { mytree: [], mydb: [] },
  explorerSrc: store.get('explorerSrc', 'masters'),
  treeColor: 'w',
  settings: {
    pieceSet: store.get('pieceSet', 'cburnett'),
    board: store.get('board', 'brown.png'),
    coords: store.get('coords', true),
    arrow: store.get('arrow', true),
    badges: store.get('badges', true),
  },
};

const liveEngine = new Engine('live');
const reviewEngine = new Engine('review');
liveEngine.onError = reviewEngine.onError = (e) => toast('Silnik: ' + e, 4000);

// ---------- dostęp do API (proxy na serwerze lub bezpośrednio) ----------
const DIRECT = { lichess: 'https://lichess.org', explorer: 'https://explorer.lichess.ovh', chesscom: 'https://api.chess.com' };
function apiFetch(target, path, accept) {
  const headers = {};
  if (accept) headers.Accept = accept;
  if (S.server) return fetch(`/api/proxy/${target}/${path}`, { headers });
  const tok = store.get('lichessToken', '');
  if (tok && target !== 'chesscom') headers.Authorization = 'Bearer ' + tok;
  return fetch(`${DIRECT[target]}/${path}`, { headers });
}

// ---------- pozycje ----------
const posFen = (ply) => (ply === 0 ? S.game.startFen : S.game.moves[ply - 1].fenAfter);
function curFen() {
  if (S.explore) return S.explore.idx ? S.explore.moves[S.explore.idx - 1].fen : posFen(S.explore.base);
  return posFen(S.ply);
}
function curLastMove() {
  if (S.explore && S.explore.idx) return S.explore.moves[S.explore.idx - 1];
  const ply = S.explore ? S.explore.base : S.ply;
  return ply > 0 ? S.game.moves[ply - 1] : null;
}
function dests(chess) {
  const d = new Map();
  for (const m of chess.moves({ verbose: true })) {
    if (!d.has(m.from)) d.set(m.from, []);
    d.get(m.from).push(m.to);
  }
  return d;
}

// ---------- szachownica ----------
const cg = Chessground($('board'), {
  fen: S.game.startFen,
  orientation: 'white',
  coordinates: true,
  animation: { enabled: true, duration: 160 },
  highlight: { lastMove: true, check: true },
  movable: { free: false, color: 'white', showDests: true, events: { after: onUserMove } },
  premovable: { enabled: false },
  draggable: { enabled: true, showGhost: true },
  drawable: { enabled: true, visible: true },
});

function pieceUrl(set, key) {
  const f = S.pieces[set]?.[key];
  return f ? `piece/${set}/${f}` : `piece/cburnett/${key}.svg`;
}
function applyPieceSet() {
  const set = S.settings.pieceSet;
  let css = '';
  for (const c of ['w', 'b']) for (const [r, role] of Object.entries(ROLES)) {
    css += `.cg-wrap piece.${role}.${c === 'w' ? 'white' : 'black'}, .mini piece.${role}.${c === 'w' ? 'white' : 'black'}{background-image:url('${pieceUrl(set, c + r.toUpperCase())}')}\n`;
  }
  $('piece-style').textContent = css;
}
function applyBoard() {
  $('board-style').textContent = `cg-board{background-image:url('board/${S.settings.board}')}`;
  document.body.classList.toggle('no-coords', !S.settings.coords);
}

// Ikony ocen – rysowane wektorowo (24×24), bez znaków z czcionek, żeby wyglądały ostro wszędzie.
const ICON_GLYPHS = {
  // otwarta książka: dwie strony + grzbiet
  book: '<path d="M12 8.2C10.3 6.9 8 6.4 5.6 6.7v10.2c2.4-.3 4.7.2 6.4 1.4 1.7-1.2 4-1.7 6.4-1.4V6.7c-2.4-.3-4.7.2-6.4 1.5z" fill="#fff"/><path d="M12 8.4v9.6" stroke="currentColor" stroke-width="1.3"/>',
  // kciuk w górę
  thumb: '<path d="M7 11.2h2.1v6.6H7zM10.3 17.8V11.4l2.9-4.5c.4-.6 1.4-.3 1.4.5v2.8h2.7c.8 0 1.4.8 1.2 1.6l-1.1 4.9c-.2.7-.8 1.1-1.5 1.1z" fill="#fff"/>',
  star: '<path d="M12 5.6l1.95 4.1 4.45.55-3.27 3.08.84 4.42L12 15.6l-3.97 2.15.84-4.42L5.6 10.25l4.45-.55z" fill="#fff"/>',
  check: '<path d="M7.4 12.4l3 3 6.2-6.4" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  x: '<path d="M8.6 8.6l6.8 6.8M15.4 8.6l-6.8 6.8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>',
};
const GLYPH_OF = { best: 'star', excellent: 'thumb', good: 'check', book: 'book', miss: 'x' };
function iconInner(cls) {
  const k = C.CLASSES[cls];
  const name = GLYPH_OF[cls];
  let g;
  if (name) g = ICON_GLYPHS[name];
  else {
    const t = k.glyph;
    const two = t.length > 1;
    g = `<text x="12" y="${two ? 16.1 : 16.9}" text-anchor="middle" font-size="${two ? 10.5 : 13.5}" font-weight="800" letter-spacing="${two ? -0.6 : 0}" fill="#fff" font-family="Segoe UI,Roboto,Arial,sans-serif">${esc(t)}</text>`;
  }
  return `<g color="${k.color}"><circle cx="12" cy="12" r="11.5" fill="${k.color}"/><circle cx="12" cy="12" r="11.5" fill="none" stroke="#000" stroke-opacity=".12"/>${g}</g>`;
}
/** Ikona oceny na polu szachownicy (prawy górny róg). */
function badgeSvg(cls) {
  return `<svg x="69" y="-7" width="38" height="38" viewBox="-2 -2 28 28" overflow="visible"><circle cx="12" cy="13.2" r="12.6" fill="#000" opacity=".28"/><g class="bpop"><circle cx="12" cy="12" r="12.9" fill="#fff"/>${iconInner(cls)}</g></svg>`;
}
function badgeHtml(cls, size = 18) {
  return `<svg class="badge" width="${size}" height="${size}" viewBox="0 0 24 24"><title>${C.CLASSES[cls].label}</title>${iconInner(cls)}</svg>`;
}

function updateBoard() {
  if (S.editor) return;
  const T = S.train;
  const fen = T ? T.fen : curFen();
  const chess = new Chess(fen);
  const turn = chess.turn() === 'w' ? 'white' : 'black';
  const lm = T ? (T.lastMove ? { from: T.lastMove[0], to: T.lastMove[1] } : null) : curLastMove();
  // tryb partii: gracz ma stały kolor – poza swoim ruchem może planować premove'y (także łańcuch)
  const player = T?.playerColor;
  const myTurn = !player || player === turn;
  const q = T?.premoves || [];
  // ustawiamy pozycję tylko gdy naprawdę się zmieniła – inaczej bierki „skaczą” przy każdym odświeżeniu
  const boardKey = fen + '|' + JSON.stringify(q) + '|' + (T ? 't' : 'a');
  const fenChanged = boardKey !== updateBoard.key;
  updateBoard.key = boardKey;
  cg.set({
    ...(fenChanged ? { fen } : {}),
    orientation: T?.orientation || S.orientation,
    turnColor: turn,
    check: chess.inCheck() ? turn : false,
    lastMove: lm ? [lm.from, lm.to] : undefined,
    movable: { color: chess.isGameOver() || T?.locked ? undefined : (player || turn), dests: myTurn ? dests(chess) : new Map() },
    premovable: { enabled: !!player && !T?.locked, showDests: true, castle: true, events: { set: (o, d) => T?.onPremove?.(o, d) } },
  });
  // wizualnie zastosuj zaplanowane premove'y i podświetl ich pola
  const hl = new Map();
  for (const [o, d] of fenChanged ? q : []) {
    const pc = cg.state.pieces.get(o);
    if (!pc) continue;
    const diff = new Map([[o, undefined], [d, pc.role === 'pawn' && (d[1] === '8' || d[1] === '1') ? { ...pc, role: 'queen' } : pc]]);
    cg.setPieces(diff);
    hl.set(o, 'premove-q'); hl.set(d, 'premove-q');
  }
  if (fenChanged) cg.set({ highlight: { custom: hl } });
  drawShapes();
}
// prawy klik na planszy anuluje zaplanowane premove'y
$('board').addEventListener('contextmenu', (e) => { if (S.train?.premoves?.length) { e.preventDefault(); S.train.onPremoveCancel?.(); } });

function drawShapes() {
  if (S.editor || document.querySelector('.app').hidden) { cg.setAutoShapes([]); return; }
  if (S.train) { cg.setAutoShapes(S.train.shapes || []); return; }
  const shapes = [];
  const fen = curFen();
  const cur = currentMoveReview();
  if (S.settings.badges && cur?.r) shapes.push({ orig: cur.mv.to, customSvg: { html: badgeSvg(cur.r.cls) } });
  if (S.settings.arrow) {
    const ev = getEval(fen);
    if (ev?.pv?.length) shapes.push({ orig: ev.pv[0].slice(0, 2), dest: ev.pv[0].slice(2, 4), brush: 'paleBlue' });
    // zielona strzałka: co było najlepsze zamiast ocenionego błędu
    if (cur?.r && !cur.r.isBest && C.ERROR_CLASSES.includes(cur.r.cls)) {
      const best = getEval(cur.mv.fenBefore)?.best;
      if (best) shapes.push({ orig: best.slice(0, 2), dest: best.slice(2, 4), brush: 'green' });
    }
  }
  cg.setAutoShapes(shapes);
}

// ---------- oceny pozycji (cache) i ocena dowolnego ruchu ----------
const evalCache = new Map(); // fen -> {cp, mate, pv, best, second, depth}
function cacheEval(fen, ev) {
  const old = evalCache.get(fen);
  if (!old || (ev.depth || 0) >= (old.depth || 0)) evalCache.set(fen, ev);
}
function linesToEv(lines) {
  const [a, b] = lines;
  return { cp: a.cp, mate: a.mate, pv: a.pv, best: a.pv[0], depth: a.depth, second: b ? { cp: b.cp, mate: b.mate } : null };
}
function getEval(fen) { return terminalEval(fen) || evalCache.get(fen) || null; }
const minDepth = () => ($('review-engine').value === 'lc0' ? 1 : 10);

// dodatkowy silnik do szybkiej oceny pozycji, których jeszcze nie policzono
const auxEngine = new Engine('aux');
const auxQueue = new Set();
let auxBusy = false;
function ensureEval(fen) {
  const ev = getEval(fen);
  if ((ev && (ev.depth >= minDepth() || terminalEval(fen))) || auxQueue.has(fen)) return;
  auxQueue.add(fen);
  runAux();
}
async function runAux() {
  if (auxBusy) return;
  auxBusy = true;
  while (auxQueue.size) {
    const fen = [...auxQueue].pop();
    auxQueue.delete(fen);
    if ((getEval(fen)?.depth || 0) >= minDepth()) continue;
    const id = $('review-engine').value;
    try {
      await auxEngine.setEngine(id);
      const res = await auxEngine.analyse(fen, id === 'lc0' ? { multipv: 2, nodes: 800 } : { multipv: 2, depth: id === WASM_ID ? 12 : 16 });
      if (res?.lines.length) cacheEval(fen, linesToEv(res.lines));
    } catch {}
    render();
  }
  auxBusy = false;
}

const classCache = new Map();
/** Ocena ruchu prowadzącego do bieżącej pozycji – z raportu albo liczona na żywo (np. Twój ruch w wariancie). */
function currentMoveReview() {
  let mv;
  if (S.explore && S.explore.idx > 0) {
    const i = S.explore.idx - 1;
    const n = S.explore.moves[i];
    mv = { ...n, fenBefore: i ? S.explore.moves[i - 1].fen : posFen(S.explore.base), fenAfter: n.fen };
  } else if (!S.explore && S.ply > 0) {
    mv = S.game.moves[S.ply - 1];
    if (S.review?.[S.ply - 1]) return { mv, r: S.review[S.ply - 1], own: false };
  } else return null;
  const before = getEval(mv.fenBefore);
  const after = getEval(mv.fenAfter);
  const okB = before && before.pv?.length && before.depth >= minDepth();
  const okA = after && (terminalEval(mv.fenAfter) || after.depth >= minDepth());
  if (!okB) ensureEval(mv.fenBefore);
  if (!okA) ensureEval(mv.fenAfter);
  if (!okB || !okA) return { mv, r: null, pending: true, own: !!S.explore };
  const key = `${mv.fenBefore}|${mv.uci}|${before.depth}|${after.depth ?? 't'}`;
  let r = classCache.get(key);
  if (!r) {
    r = C.classifyGame({ moves: [mv] }, [before, after], S.openings)[0];
    classCache.set(key, r);
  }
  return { mv, r, own: !!S.explore };
}

// ---------- ruchy użytkownika ----------
let promoResolve = null;
function choosePromotion(color) {
  const box = $('promo');
  box.innerHTML = '';
  for (const r of ['q', 'n', 'r', 'b']) {
    const b = document.createElement('button');
    b.style.backgroundImage = `url('${pieceUrl(S.settings.pieceSet, color + r.toUpperCase())}')`;
    b.onclick = () => { box.hidden = true; promoResolve(r); };
    box.appendChild(b);
  }
  box.hidden = false;
  return new Promise((res) => (promoResolve = res));
}

async function onUserMove(orig, dest) {
  if (S.editor) { syncEditorFen(); return; }
  const chess = new Chess(S.train ? S.train.fen : curFen());
  const piece = chess.get(orig);
  let promotion;
  if (piece?.type === 'p' && (dest[1] === '8' || dest[1] === '1')) promotion = await choosePromotion(piece.color);
  playUci(orig + dest + (promotion || ''));
}

/** Zagranie ruchu UCI w bieżącej pozycji (główna linia albo wariant). */
function playUci(uci, opts = {}) {
  if (S.train) {
    const c = new Chess(S.train.fen);
    let tm;
    try { tm = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) }); } catch { updateBoard.key = null; updateBoard(); return false; }
    updateBoard.key = null;
    S.train.onMove?.(tm.from + tm.to + (tm.promotion || ''), tm, c.fen());
    return true;
  }
  const fen = curFen();
  const chess = new Chess(fen);
  let m;
  try { m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) }); } catch { updateBoard.key = null; updateBoard(); return false; }
  const full = m.from + m.to + (m.promotion || '');
  if (S.retry && !opts.silent) { handleRetry(full, chess.fen(), m); return true; }
  if (!S.explore && S.game.moves[S.ply]?.uci === full) {
    S.ply++;
  } else if (!S.explore && S.ply === S.game.moves.length && !S.review) {
    // dopisywanie ruchów do własnej (nieprzeanalizowanej) partii
    S.game.moves.push({ san: m.san, uci: full, color: m.color, from: m.from, to: m.to, piece: m.piece, captured: m.captured, fenBefore: fen, fenAfter: chess.fen() });
    S.ply++;
    S.evals.length = Math.min(S.evals.length, S.ply);
  } else {
    const node = { san: m.san, uci: full, fen: chess.fen(), from: m.from, to: m.to, color: m.color, piece: m.piece, captured: m.captured };
    if (!S.explore) S.explore = { base: S.ply, moves: [node], idx: 1 };
    else if (S.explore.moves[S.explore.idx]?.uci === full) S.explore.idx++;
    else { S.explore.moves.length = S.explore.idx; S.explore.moves.push(node); S.explore.idx++; }
  }
  if (!opts.noRender) render();
  return true;
}
function playLine(ucis) { for (const u of ucis) if (!playUci(u, { noRender: true, silent: true })) break; render(); }

function returnToGame() {
  if (!S.explore) return;
  S.ply = S.explore.base;
  S.explore = null;
  S.retry = null;
  render();
}

// ---------- nawigacja ----------
function go(delta) {
  if (S.explore) {
    const n = S.explore.idx + delta;
    if (n < 0) { returnToGame(); return; }
    S.explore.idx = Math.min(S.explore.moves.length, n);
  } else S.ply = Math.max(0, Math.min(S.game.moves.length, S.ply + delta));
  render();
}
function goTo(ply) { S.explore = null; S.retry = null; S.ply = Math.max(0, Math.min(S.game.moves.length, ply)); render(); }

// ---------- renderowanie ----------
let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    const f = curFen();
    if (f !== lastSoundFen) {
      if (!muteNextSound) sound.forSan(curLastMove()?.san);
      muteNextSound = false;
      lastSoundFen = f;
    }
    updateBoard();
    renderEvalBar();
    renderMoves();
    renderCoach();
    renderVariationBanner();
    renderPlayers();
    renderGraphCursor();
    renderOpeningName();
    scheduleExplorer();
    startLive();
    $('btn-lichess').href = 'https://lichess.org/analysis/standard/' + curFen().replace(/ /g, '_');
  }, 0);
}

function currentEval() {
  return getEval(curFen());
}
function renderEvalBar() {
  const ev = S.train?.hideEval ? null : currentEval();
  const wp = ev ? C.winPct(ev) : 50;
  $('evalbar-white').style.height = wp + '%';
  const bar = $('evalbar');
  bar.classList.toggle('flipped', S.orientation === 'black');
  bar.classList.toggle('white-adv', wp >= 50);
  bar.classList.toggle('black-adv', wp < 50);
  $('evalbar-text').textContent = ev ? C.formatEval(ev).replace('+', '') : '';
}

function renderPlayers() {
  const h = S.game.headers;
  const w = `${esc(h.White || 'Białe')} <small>${esc(h.WhiteElo || '')}</small>`;
  const b = `${esc(h.Black || 'Czarne')} <small>${esc(h.BlackElo || '')}</small>`;
  $('strip-game').textContent = `${h.White || 'Białe'} – ${h.Black || 'Czarne'}${h.Date && !h.Date.startsWith('?') ? ' · ' + h.Date : ''}`;
  $('strip-mode').textContent = S.train ? 'Tryb: trening' : S.explore ? 'Tryb: wariant' : S.review ? 'Tryb: raport' : 'Tryb: analiza';
  $('player-top').innerHTML = S.orientation === 'white' ? '♚ ' + b : '♔ ' + w;
  $('player-bottom').innerHTML = S.orientation === 'white' ? '♔ ' + w : '♚ ' + b;
}


function variationHtml() {
  const e = S.explore;
  let html = '<div class="variation">';
  const baseChess = new Chess(posFen(e.base));
  let moveNo = baseChess.moveNumber();
  let white = baseChess.turn() === 'w';
  e.moves.forEach((m, i) => {
    if (white) html += `<span class="muted">${moveNo}.</span>`;
    else if (i === 0) html += `<span class="muted">${moveNo}…</span>`;
    html += `<span class="vm${i + 1 === e.idx ? ' cur' : ''}" data-vi="${i + 1}">${esc(m.san)}</span> `;
    if (!white) moveNo++;
    white = !white;
  });
  return html + ' <button class="btn" data-act="return" style="padding:2px 8px;font-size:12px">↩ partia</button></div>';
}

function renderMoves() {
  const moves = S.game.moves;
  let html = '';
  const firstBlack = moves[0]?.color === 'b';
  const startNo = new Chess(S.game.startFen).moveNumber();
  let i = 0;
  let no = startNo;
  const exploreRowAfter = S.explore ? S.explore.base : -1;
  let pendingVar = S.explore && S.explore.base === 0;
  if (pendingVar) { html += variationHtml(); pendingVar = false; }
  while (i < moves.length) {
    let row = `<div class="mrow"><span class="mno">${no}.</span>`;
    const cells = [];
    if (i === 0 && firstBlack) cells.push('<span></span>');
    while (cells.length < 2 && i < moves.length) {
      const m = moves[i];
      const r = S.review?.[i];
      const ev = S.evals[i + 1];
      cells.push(`<span class="mv${!S.explore && S.ply === i + 1 ? ' cur' : ''}" data-ply="${i + 1}"><span>${r ? badgeHtml(r.cls) : ''} ${esc(m.san)}</span><span class="ev">${ev ? C.formatEval(ev) : ''}</span></span>`);
      i++;
      if (i === exploreRowAfter) pendingVar = true;
    }
    row += cells.join('') + '</div>';
    html += row;
    if (pendingVar) { html += variationHtml(); pendingVar = false; }
    no++;
  }
  if (S.game.headers.Result && S.game.headers.Result !== '*') html += `<div class="result-line">${esc(S.game.headers.Result)}</div>`;
  for (const id of ['moves', 'moves-analysis']) {
    const el = $(id);
    el.innerHTML = html;
    const cur = el.querySelector('.mv.cur, .vm.cur');
    if (cur && el.offsetParent) cur.scrollIntoView({ block: 'nearest' });
  }
}
for (const id of ['moves', 'moves-analysis']) {
  $(id).addEventListener('click', (e) => {
    const p = e.target.closest('[data-ply]');
    if (p) return goTo(+p.dataset.ply);
    const v = e.target.closest('[data-vi]');
    if (v) { S.explore.idx = +v.dataset.vi; render(); return; }
    if (e.target.closest('[data-act="return"]')) returnToGame();
  });
}

function renderVariationBanner() {
  const b = $('variation-banner');
  if (S.retry) {
    b.hidden = false;
    $('variation-text').textContent = 'Tryb „Spróbuj ponownie”: znajdź lepszy ruch.';
  } else if (S.explore) {
    b.hidden = false;
    const base = S.explore.base;
    const no = Math.floor(base / 2) + 1;
    $('variation-text').textContent = `Analizujesz wariant od ruchu ${no}${base % 2 ? '…' : '.'} – partia czeka.`;
  } else b.hidden = true;
}

// ---------- coach (opis ruchu) ----------
const COACH_IDS = ['coach', 'coach-analysis'];
function setCoach(html, color) {
  for (const id of COACH_IDS) {
    const box = $(id);
    if (!html) { box.hidden = true; continue; }
    box.hidden = false;
    box.style.setProperty('--mood', color);
    box.innerHTML = catSays(html);
  }
}
function renderCoach() {
  if (S.retry) {
    setCoach(`<div><div class="c-title">Spróbuj ponownie</div><div class="c-text">${esc(S.retry.msg || 'Znajdź lepszy ruch w tej pozycji.')}</div>
      <div class="c-actions"><button class="btn" data-c="showbest">Pokaż rozwiązanie</button><button class="btn" data-c="exit">Zakończ</button></div></div>`, '#7c5cd6');
    return;
  }
  const cur = currentMoveReview();
  if (!cur) return setCoach(null);
  if (!cur.r) {
    return setCoach(`<div><div class="c-title">${esc(cur.mv.san)}</div><div class="c-text">Silnik ocenia ruch…</div></div>`, '#555');
  }
  const { r, mv } = cur;
  const k = C.CLASSES[r.cls];
  const who = cur.own ? 'Twój ruch ' : '';
  let text = r.text || '';
  if (r.cls === 'best') text = 'Najlepszy ruch według silnika.';
  if (r.cls === 'great') text = 'Jedyny ruch, który utrzymuje ocenę – inne wyraźnie przegrywały.';
  if (r.cls === 'brilliant') text = 'Świetna ofiara! Oddajesz materiał, a pozycja zostaje dobra.';
  if (r.cls === 'excellent') text = r.bestSan ? `Prawie najlepszy. Silnik wolał ${r.bestSan}.` : 'Prawie najlepszy ruch.';
  if (r.cls === 'good') text = r.bestSan ? `Solidny ruch. Najlepsze było ${r.bestSan}.` : 'Solidny ruch.';
  if (r.cls === 'book') text = `Teoria debiutu: ${r.text}`;
  const acts = [];
  if (r.bestSan && !r.isBest) acts.push('<button class="btn primary" data-c="best">Pokaż najlepszy</button>');
  if (r.punishSan) acts.push('<button class="btn" data-c="punish">Pokaż kontrę</button>');
  if (!cur.own && S.review && C.ERROR_CLASSES.includes(r.cls)) acts.push('<button class="btn" data-c="retry">Spróbuj ponownie</button>');
  if (!cur.own && S.review) acts.push('<button class="btn" data-c="next">Następny błąd ▸</button>');
  if (cur.own) acts.push('<button class="btn" data-c="exit">↩ Wróć do partii</button>');
  const line = r.bestLine && !r.isBest ? `<div class="c-line">Najlepsza linia: ${esc(r.bestLine.join(' '))}</div>` : '';
  const evAfter = getEval(mv.fenAfter);
  setCoach(`${badgeHtml(r.cls, 30)}<div><div class="c-title">${esc(who + mv.san)} <span style="color:${k.color}">– ${k.label}</span> <span class="c-eval">${esc(C.formatEval(evAfter))}</span></div><div class="c-text">${esc(text)}</div>${line}
    <div class="c-line">Szansa wygranej: ${r.wpB.toFixed(0)}% → ${r.wpA.toFixed(0)}% · dokładność ruchu ${r.acc.toFixed(0)}%</div>
    <div class="c-actions">${acts.join('')}</div></div>`, k.color);
}
for (const id of COACH_IDS) $(id).addEventListener('click', (e) => {
  const b = e.target.closest('[data-c]');
  if (!b) return;
  const c = b.dataset.c;
  const cur = currentMoveReview();
  if (c === 'best' && cur) {
    const best = getEval(cur.mv.fenBefore)?.best;
    if (!best) return;
    if (S.explore) S.explore.idx--;
    else S.ply--;
    if (S.explore && S.explore.idx === 0 && !S.explore.moves.length) S.explore = null;
    playLine([best]);
  } else if (c === 'punish' && cur) {
    const pv = getEval(cur.mv.fenAfter)?.pv;
    if (pv?.length) playLine(pv.slice(0, 1));
  } else if (c === 'retry') {
    const ply = S.ply - 1;
    S.ply = ply; S.explore = null;
    S.retry = { ply, msg: `Pozycja przed ${S.game.moves[ply].san}. Znajdź lepszy ruch.` };
    render();
  } else if (c === 'next') nextMistake();
  else if (c === 'exit') { S.retry = null; returnToGame(); render(); }
  else if (c === 'showbest') {
    const ply = S.retry.ply;
    const ev = S.evals[ply];
    S.retry = null; S.explore = null; S.ply = ply;
    if (ev?.pv) playLine(ev.pv.slice(0, 1));
  }
});

async function handleRetry(uci, fenAfter, m) {
  const ply = S.retry.ply;
  const before = S.evals[ply];
  const color = m.color;
  if (before?.best === uci) {
    S.retry = null;
    toast('✓ Tak! To najlepszy ruch.');
    sound.play('Confirmation');
    S.explore = { base: ply, moves: [{ san: m.san, uci, fen: fenAfter, from: m.from, to: m.to }], idx: 1 };
    render();
    return;
  }
  // pokaż ruch i oceń go silnikiem
  S.explore = { base: ply, moves: [{ san: m.san, uci, fen: fenAfter, from: m.from, to: m.to }], idx: 1 };
  S.retry.msg = `Sprawdzam ${m.san}…`;
  render();
  const id = $('review-engine').value;
  await reviewEngine.setEngine(id);
  const res = await reviewEngine.analyse(fenAfter, id === 'lc0' ? { nodes: 800 } : { depth: id === WASM_ID ? 12 : 16 });
  if (!S.retry) return;
  const after = res?.lines[0];
  const loss = after ? C.povWin(before, color) - C.povWin(after, color) : 100;
  if (loss < 3) {
    S.retry = null;
    toast(`✓ ${m.san} też jest dobre!`);
    sound.play('Confirmation');
    render();
  } else {
    S.retry.msg = `${m.san} to nie to (${C.formatEval(after)}). Spróbuj jeszcze.`;
    sound.play('Error');
    setTimeout(() => { if (S.retry) { S.explore = null; S.ply = ply; render(); } }, 900);
    render();
  }
}

function nextMistake(cls) {
  if (!S.review) return;
  const want = cls ? [cls] : C.ERROR_CLASSES;
  const n = S.review.length;
  for (let k = 1; k <= n; k++) {
    const i = (S.ply - 1 + k) % n;
    if (S.review[i] && want.includes(S.review[i].cls)) return goTo(i + 1);
  }
  toast('Brak takich ruchów.');
}

// ---------- wykres ----------
const GRAPH_TIP = $('graph-tip');
function renderGraph() {
  const el = $('graph');
  const n = S.game.moves.length;
  if (!n || !S.evals.length) { el.innerHTML = ''; el.appendChild(GRAPH_TIP); return; }
  const W = el.clientWidth || 400, H = el.clientHeight || 110;
  const x = (i) => (i / n) * W;
  const y = (ev) => H - (C.winPct(ev) / 100) * H;
  let d = `M0,${H} `;
  let last = H / 2;
  for (let i = 0; i <= n; i++) {
    const ev = S.evals[i];
    if (ev) last = y(ev);
    d += `L${x(i).toFixed(1)},${last.toFixed(1)} `;
  }
  d += `L${W},${H} Z`;
  let marks = '';
  if (S.review) S.review.forEach((r, i) => {
    if (!r || !['blunder', 'mistake', 'miss', 'brilliant', 'great', 'inaccuracy'].includes(r.cls)) return;
    const ev = S.evals[i + 1];
    if (ev) marks += `<circle cx="${x(i + 1)}" cy="${y(ev)}" r="4" fill="${C.CLASSES[r.cls].color}" stroke="#222"/>`;
  });
  const grid = [0.25, 0.75].map((f) => `<line x1="0" x2="${W}" y1="${H * f}" y2="${H * f}" stroke="#ffffff10"/>`).join('');
  const line = d.replace(/^M0,[\d.]+ L/, 'M').replace(/ ?L[\d.]+,[\d.]+ Z$/, '');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}">${grid}<path d="${d}" fill="#ecebf1" fill-opacity=".92"/><path d="${line}" fill="none" stroke="#b9a2ff" stroke-width="1.4" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="#8b5cf6" stroke-opacity=".55" stroke-dasharray="3 4"/>${marks}<line id="graph-cursor" x1="0" x2="0" y1="0" y2="${H}" stroke="#8b5cf6" stroke-width="2"/></svg>`;
  el.appendChild(GRAPH_TIP);
  renderGraphCursor();
}
function renderGraphCursor() {
  const l = document.getElementById('graph-cursor');
  if (!l) return;
  const n = S.game.moves.length || 1;
  const W = $('graph').clientWidth || 400;
  const ply = S.explore ? S.explore.base : S.ply;
  l.setAttribute('x1', (ply / n) * W); l.setAttribute('x2', (ply / n) * W);
}
$('graph').addEventListener('mousemove', (e) => {
  const n = S.game.moves.length;
  const tip = GRAPH_TIP;
  if (!n || !S.evals.length) { tip.hidden = true; return; }
  const rect = $('graph').getBoundingClientRect();
  const ply = Math.max(1, Math.min(n, Math.round(((e.clientX - rect.left) / rect.width) * n)));
  const m = S.game.moves[ply - 1];
  const ev = S.evals[ply];
  const r = S.review?.[ply - 1];
  tip.hidden = false;
  tip.style.left = Math.max(60, Math.min(rect.width - 60, e.clientX - rect.left)) + 'px';
  tip.innerHTML = `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '…'} ${esc(m.san)} <span style="color:var(--muted)">${ev ? C.formatEval(ev) : ''}</span>${r ? ` <span style="color:${C.CLASSES[r.cls].color}">${C.CLASSES[r.cls].label}</span>` : ''}`;
});
$('graph').addEventListener('mouseleave', () => (GRAPH_TIP.hidden = true));
$('graph').addEventListener('click', (e) => {
  const rect = $('graph').getBoundingClientRect();
  goTo(Math.round(((e.clientX - rect.left) / rect.width) * S.game.moves.length));
});
window.addEventListener('resize', () => renderGraph());

function renderReportSummary() {
  const h = S.game.headers;
  const acc = (c) => (S.review ? C.gameAccuracy(S.review, c, S.game.moves) : null);
  const aw = acc('w'), ab = acc('b');
  const fmt = (v) => (v === null ? '–' : v.toFixed(1));
  let html = `<tr class="players"><td></td><td>${esc(h.White || 'Białe')}<small>${esc(h.WhiteElo || '')}</small></td><td></td><td>${esc(h.Black || 'Czarne')}<small>${esc(h.BlackElo || '')}</small></td></tr>
    <tr class="acc-row"><td class="lbl">Dokładność</td><td><span class="score-box w">${fmt(aw)}</span></td><td></td><td><span class="score-box b">${fmt(ab)}</span></td></tr>
    <tr class="sep"><td colspan="4"></td></tr>`;
  for (const cls of C.CLASS_ORDER) {
    const cnt = { w: 0, b: 0 };
    S.review?.forEach((r, i) => r?.cls === cls && cnt[S.game.moves[i].color]++);
    const k = C.CLASSES[cls];
    html += `<tr class="cls-row" data-cls="${cls}"><td class="lbl">${k.label}</td><td style="color:${k.color}">${S.review ? cnt.w : '–'}</td><td>${badgeHtml(cls, 22)}</td><td style="color:${k.color}">${S.review ? cnt.b : '–'}</td></tr>`;
  }
  const rw = C.estimateRating(aw), rb = C.estimateRating(ab);
  html += `<tr class="sep"><td colspan="4"></td></tr>
    ${S.game.official ? `<tr class="acc-row official"><td class="lbl">Dokładność wg chess.com</td><td>${S.game.official.white?.toFixed(1) ?? '–'}</td><td></td><td>${S.game.official.black?.toFixed(1) ?? '–'}</td></tr>` : ''}
    <tr class="acc-row"><td class="lbl">Ranking na podstawie partii</td><td><span class="score-box w">${rw ?? '–'}</span></td><td></td><td><span class="score-box b">${rb ?? '–'}</span></td></tr>`;
  if (S.review) html += `<tr><td colspan="4" class="add-mk"><button class="btn" data-mk="w">Błędy białych → zadania</button> <button class="btn" data-mk="b">Błędy czarnych → zadania</button></td></tr>`;
  $('summary').innerHTML = html;
  renderGraph();
}
$('summary').addEventListener('click', (e) => {
  const mk = e.target.closest('[data-mk]')?.dataset.mk;
  if (mk) { autoAddMistakes([mk]).then(() => {}); return; }
  const tr = e.target.closest('tr[data-cls]');
  if (tr) nextMistake(tr.dataset.cls);
});

// ---------- analiza partii ----------
function terminalEval(fen) {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { cp: null, mate: 0, mateWinner: c.turn() === 'w' ? 'b' : 'w', pv: [] };
  if (c.isGameOver()) return { cp: 0, mate: null, pv: [] };
  return null;
}

async function runReview() {
  if (S.reviewing) { await reviewEngine.stop(); S.reviewing = false; return; }
  const n = S.game.moves.length;
  if (!n) { toast('Najpierw wczytaj partię (zakładka Import).'); return; }
  const id = $('review-engine').value;
  const depth = +$('review-depth').value || 18;
  const nodes = +$('review-nodes').value || 4000;
  S.reviewing = true;
  S.review = null;
  S.evals = [];
  $('btn-review').textContent = 'Zatrzymaj';
  $('review-progress').hidden = false;
  try {
    await reviewEngine.setEngine(id);
    const t0 = performance.now();
    for (let i = 0; i <= n; i++) {
      if (!S.reviewing) break;
      const fen = posFen(i);
      let ev = terminalEval(fen);
      if (!ev) {
        const res = await reviewEngine.analyse(fen, id === 'lc0' ? { multipv: 2, nodes } : { multipv: 2, depth });
        if (!res || !res.lines.length) { if (!S.reviewing) break; ev = { cp: 0, mate: null, pv: [] }; }
        else {
          const [a, b] = res.lines;
          ev = { cp: a.cp, mate: a.mate, pv: a.pv, best: res.bestmove || a.pv[0], depth: a.depth, second: b ? { cp: b.cp, mate: b.mate } : null };
        }
      }
      S.evals[i] = ev;
      if (ev.depth) cacheEval(fen, ev);
      const pct = ((i + 1) / (n + 1)) * 100;
      const eta = ((performance.now() - t0) / (i + 1)) * (n - i) / 1000;
      $('review-progress-bar').style.width = pct + '%';
      $('review-progress-text').textContent = `Analiza ${i}/${n} · ~${Math.ceil(eta)} s`;
      if (i % 4 === 0) { renderGraph(); renderEvalBar(); }
    }
    if (S.evals.length === n + 1) {
      S.review = C.classifyGame(S.game, S.evals, S.openings);
      toast('Analiza gotowa');
      autoAddMistakes();
      sound.play('GenericNotify');
    }
  } catch (e) {
    toast('Błąd analizy: ' + (e.message || e), 4000);
  }
  S.reviewing = false;
  $('btn-review').textContent = 'Analizuj partię';
  $('review-progress').hidden = true;
  renderReportSummary();
  if (S.review) {
    for (const b of document.querySelectorAll('#summary .score-box')) { const v = parseFloat(b.textContent); if (!isNaN(v)) fx.countUp(b, v, b.textContent.includes('.') ? 1 : 0); }
    fx.enter(document.querySelectorAll('#summary tr'), { step: 22 });
  }
  render();
}
$('btn-review').onclick = runReview;

// błędy z partii → zadania „Moje błędy” (dla gracza, którego nazwę znamy)
async function autoAddMistakes(colors) {
  if (!colors) {
    const names = ['ccUser', 'liUser', 'treeUser', 'tuUser'].map((k) => String(store.get(k, '')).toLowerCase()).filter(Boolean);
    const h = S.game.headers;
    colors = [];
    if (names.includes((h.White || '').toLowerCase())) colors.push('w');
    if (names.includes((h.Black || '').toLowerCase())) colors.push('b');
  }
  if (!colors.length || !S.review) return;
  const n = await addMistakesFromReview(S.game, S.evals, S.review, colors);
  if (n) toast(`Dodano ${n} zadań do „Trening → Moje błędy”.`, 3000);
}

// ---------- analiza na żywo ----------
let liveTimer = null;
function startLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => {
    if (S.train) { liveEngine.stop(); S.live.fen = null; return; }
    const fen = curFen();
    if (!$('live-on').checked) { liveEngine.stop(); return; }
    if (S.live.fen === fen) return;
    const term = terminalEval(fen);
    S.live = { lines: [], fen, running: true };
    if (term) {
      S.live.running = false;
      $('lines').innerHTML = `<div class="line">${term.mate === 0 ? 'Mat' : 'Remis'}</div>`;
      liveEngine.stop();
      return;
    }
    const id = $('live-engine').value;
    try { await liveEngine.setEngine(id); } catch { $('live-status').textContent = 'Nie można połączyć z silnikiem'; return; }
    const mpv = +$('live-multipv').value;
    let raf = false;
    const res = await liveEngine.analyse(fen, id === 'lc0' ? { multipv: mpv } : { multipv: mpv, depth: id === WASM_ID ? 22 : 40 }, (lines) => {
      if (S.live.fen !== fen) return;
      S.live.lines = lines;
      if (lines[0]?.pv?.length) cacheEval(fen, linesToEv(lines));
      if (!raf) { raf = true; setTimeout(() => { raf = false; renderLive(); renderEvalBar(); drawShapes(); renderCoach(); }, 120); }
    });
    if (res && S.live.fen === fen) { S.live.running = false; renderLive(true); }
  }, 120);
}

function renderLive(done) {
  const fen = S.live.fen;
  if (!fen) return;
  const lines = S.live.lines;
  const top = lines[0];
  const name = $('live-engine').selectedOptions[0]?.textContent || '';
  $('strip-engine').textContent = top ? `Silnik: ${name.replace(/\s*\(.*\)/, '')} · gł. ${top.depth}` : `Silnik: ${name.replace(/\s*\(.*\)/, '')} · liczę…`;
  $('live-status').textContent = top ? `depth=${top.depth} | ${name.replace(/\s*\(.*\)/, '')}` : 'liczę…';
  let html = '';
  for (const l of lines) {
    if (!l) continue;
    const { steps } = C.playLine(fen, l.pv, 14);
    const c = new Chess(fen);
    let no = c.moveNumber(), white = c.turn() === 'w';
    let pv = '';
    steps.forEach((s, i) => {
      if (white) pv += `<em class="muted">${no}.</em>`;
      else if (i === 0) pv += `<em class="muted">${no}…</em>`;
      pv += `<span data-n="${i + 1}">${figurine(s.san, s.move.color)}</span> `;
      if (!white) no++;
      white = !white;
    });
    const wp = C.winPct(l);
    html += `<div class="line" data-pv="${l.pv.join(' ')}"><span class="score ${wp >= 50 ? 'w' : 'b'}">${C.formatEval(l)}</span><span class="pv">${pv}</span><span class="chev">›</span></div>`;
  }
  $('lines').innerHTML = html;
}
$('lines').addEventListener('click', (e) => {
  const line = e.target.closest('[data-pv]');
  if (!line) return;
  const n = +(e.target.closest('[data-n]')?.dataset.n || 1);
  playLine(line.dataset.pv.split(' ').slice(0, n));
});
$('live-on').onchange = () => { S.live.fen = null; if (!$('live-on').checked) { liveEngine.stop(); $('lines').innerHTML = ''; S.live.lines = []; } render(); };
$('live-engine').onchange = () => { store.set('liveEngine', $('live-engine').value); S.live.fen = null; render(); };
$('live-multipv').onchange = () => { S.live.fen = null; render(); };
$('review-engine').onchange = () => { store.set('reviewEngine', $('review-engine').value); syncReviewInputs(); };
function syncReviewInputs() {
  const id = $('review-engine').value;
  $('review-nodes-wrap').hidden = id !== 'lc0';
  $('review-depth-wrap').hidden = id === 'lc0';
  if (id === WASM_ID && +$('review-depth').value > 14) $('review-depth').value = 12;
}

// ---------- otwarcia ----------
function renderOpeningName() {
  let name = null;
  const fens = [];
  if (S.explore) for (let i = S.explore.idx; i >= 1; i--) fens.push(S.explore.moves[i - 1].fen);
  for (let p = S.explore ? S.explore.base : S.ply; p >= 0; p--) fens.push(posFen(p));
  for (const f of fens) { const o = S.openings[epd(f)]; if (o) { name = o; break; } }
  $('opening-name').innerHTML = name ? `<small>${esc(name.e)}</small>${esc(name.n)}` : '<span class="muted">Pozycja spoza bazy otwarć</span>';
  $('engine-opening').innerHTML = name ? `◎ <b>${esc(name.e)}</b> ${esc(name.n)}` : (curFen() === new Chess().fen() ? '◎ <span class="muted">Pozycja początkowa</span>' : '◎ <span class="muted">Pozycja spoza książki debiutów</span>');
  if (!$('an-book').hidden) renderBook();
}

const SPEEDS = ['bullet', 'blitz', 'rapid', 'classical', 'correspondence'];
const RATINGS = [1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500];
const exState = { speeds: store.get('exSpeeds', ['blitz', 'rapid', 'classical']), ratings: store.get('exRatings', [1600, 1800, 2000, 2200, 2500]) };
function renderChips() {
  $('speeds').innerHTML = SPEEDS.map((s) => `<button data-s="${s}" class="${exState.speeds.includes(s) ? 'on' : ''}">${s}</button>`).join('');
  $('ratings').innerHTML = RATINGS.map((r) => `<button data-r="${r}" class="${exState.ratings.includes(r) ? 'on' : ''}">${r}</button>`).join('');
}
$('speeds').onclick = (e) => { const s = e.target.dataset.s; if (!s) return; exState.speeds = exState.speeds.includes(s) ? exState.speeds.filter((x) => x !== s) : [...exState.speeds, s]; store.set('exSpeeds', exState.speeds); renderChips(); scheduleExplorer(true); };
$('ratings').onclick = (e) => { const r = +e.target.dataset.r; if (!r) return; exState.ratings = exState.ratings.includes(r) ? exState.ratings.filter((x) => x !== r) : [...exState.ratings, r]; store.set('exRatings', exState.ratings); renderChips(); scheduleExplorer(true); };

function setExplorerSrc(src) {
  S.explorerSrc = src;
  store.set('explorerSrc', src);
  for (const b of $('explorer-source').children) b.classList.toggle('active', b.dataset.src === src);
  $('opts-lichess').hidden = src !== 'lichess';
  $('opts-mytree').hidden = src !== 'mytree';
  $('opts-mydb').hidden = src !== 'mydb';
  scheduleExplorer(true);
}
$('explorer-source').onclick = (e) => { const s = e.target.dataset.src; if (s) setExplorerSrc(s); };
$('tree-color').onclick = (e) => {
  const c = e.target.dataset.c; if (!c) return;
  S.treeColor = c;
  for (const b of $('tree-color').children) b.classList.toggle('active', b.dataset.c === c);
  scheduleExplorer(true);
};

const exCache = new Map();
let exTimer = null, exLastKey = '';
function scheduleExplorer(force) {
  if ($('tab-openings').hidden) return;
  const key = S.explorerSrc + '|' + curFen() + '|' + S.treeColor;
  if (!force && key === exLastKey) return;
  exLastKey = key;
  clearTimeout(exTimer);
  exTimer = setTimeout(loadExplorer, 250);
}

async function loadExplorer() {
  const fen = curFen();
  const src = S.explorerSrc;
  const box = $('explorer');
  if (src === 'mytree' || src === 'mydb') return renderLocalTree(src, fen);
  let path;
  if (src === 'masters') path = `masters?fen=${encodeURIComponent(fen)}&moves=15&topGames=10`;
  else path = `lichess?variant=standard&fen=${encodeURIComponent(fen)}&moves=15&topGames=0&recentGames=8&speeds=${exState.speeds.join(',')}&ratings=${exState.ratings.join(',')}`;
  let data = exCache.get(path);
  if (!data) {
    box.innerHTML = '<p class="muted">Ładowanie…</p>';
    try {
      const r = await apiFetch('explorer', path, 'application/json');
      if (r.status === 401) { box.innerHTML = '<p class="muted">Eksplorator lichess wymaga tokenu. Dodaj go w <b>Ustawieniach</b> (darmowy, bez uprawnień). Bez tokenu działa „Moje partie” i „Baza PGN”.</p>'; return; }
      if (r.status === 429) { box.innerHTML = '<p class="muted">Za dużo zapytań do lichess – odczekaj minutę.</p>'; return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
      exCache.set(path, data);
    } catch (e) { box.innerHTML = `<p class="muted">Nie udało się pobrać danych (${esc(e.message)}).</p>`; return; }
  }
  if (fen !== curFen()) return;
  const moves = data.moves.map((m) => ({ san: m.san, uci: m.uci, w: m.white, d: m.draws, b: m.black, avg: m.averageRating }));
  let extra = '';
  const games = [...(data.topGames || []), ...(data.recentGames || [])];
  if (games.length) {
    extra = '<div class="games"><h3>Partie</h3>' + games.map((g) => `<div class="mv-row" data-gid="${g.id}" data-src="${src}" style="cursor:pointer">${esc(g.white.name)} (${g.white.rating}) – ${esc(g.black.name)} (${g.black.rating}) · <b>${g.winner === 'white' ? '1-0' : g.winner === 'black' ? '0-1' : '½-½'}</b> · ${g.year || g.month || ''}</div>`).join('') + '</div>';
  }
  renderExplorerTable(moves, extra);
}

function renderLocalTree(src, fen) {
  const tree = S.trees[src];
  const box = $('explorer');
  if (!tree) { box.innerHTML = `<p class="muted">${src === 'mydb' ? 'Wczytaj plik PGN z bazą.' : 'Wpisz nazwę użytkownika i kliknij „Zbuduj”.'}</p>`; return; }
  const t = src === 'mytree' ? tree[S.treeColor] : tree.all;
  const node = t[epd(fen)];
  if (!node) { box.innerHTML = '<p class="muted">Brak partii w tej pozycji.</p>'; return; }
  const moves = Object.entries(node.m).map(([san, v]) => ({ san, uci: v.u, w: v.s[0], d: v.s[1], b: v.s[2] }));
  const games = S.treeGames[src];
  const extra = '<div class="games"><h3>Partie w tej pozycji</h3>' + node.g.slice(-25).reverse().map((gi) => {
    const g = games[gi];
    return `<div class="mv-row" data-local="${src}" data-gi="${gi}" style="cursor:pointer">${esc(g.w)}${g.we ? ' (' + esc(g.we) + ')' : ''} – ${esc(g.b)}${g.be ? ' (' + esc(g.be) + ')' : ''} · <b>${esc(g.r)}</b> · ${esc(g.d)} ${esc(g.ev)}</div>`;
  }).join('') + '</div>';
  renderExplorerTable(moves, extra);
}

function renderExplorerTable(moves, extra = '') {
  moves.sort((a, b) => b.w + b.d + b.b - (a.w + a.d + a.b));
  const total = moves.reduce((s, m) => s + m.w + m.d + m.b, 0);
  const next = !S.explore ? S.game.moves[S.ply]?.uci : null;
  const pct = (x, n) => (n ? (x / n) * 100 : 0);
  let html = '<table><tr><th>Ruch</th><th class="num">Partie</th><th>Białe / Remis / Czarne</th></tr>';
  for (const m of moves) {
    const n = m.w + m.d + m.b;
    const w = pct(m.w, n), d = pct(m.d, n), b = pct(m.b, n);
    html += `<tr class="mv-row${m.uci === next ? ' played' : ''}" data-uci="${m.uci}"><td class="san">${esc(m.san)}</td><td class="num">${n.toLocaleString('pl')} <small>${pct(n, total).toFixed(0)}%</small></td>
      <td><div class="wdl"><div class="w" style="width:${w}%">${w >= 12 ? w.toFixed(0) + '%' : ''}</div><div class="d" style="width:${d}%">${d >= 12 ? d.toFixed(0) + '%' : ''}</div><div class="l" style="width:${b}%">${b >= 12 ? b.toFixed(0) + '%' : ''}</div></div></td></tr>`;
  }
  if (!moves.length) html += '<tr><td colspan="3" class="muted">Brak partii w tej pozycji.</td></tr>';
  $('explorer').innerHTML = html + '</table>' + extra;
}
$('explorer').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-uci]');
  if (row) return playUci(row.dataset.uci);
  const lg = e.target.closest('[data-gi]');
  if (lg) { const g = S.treeGames[lg.dataset.local][+lg.dataset.gi]; return loadPgnText(g.pgn, { review: false }); }
  const og = e.target.closest('[data-gid]');
  if (og) {
    const path = og.dataset.src === 'masters' ? `masters/pgn/${og.dataset.gid}` : null;
    try {
      const r = path ? await apiFetch('explorer', path, 'application/x-chess-pgn') : await apiFetch('lichess', `game/export/${og.dataset.gid}`, 'application/x-chess-pgn');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      loadPgnText(await r.text(), { review: false });
    } catch (err) { toast('Nie udało się pobrać partii: ' + err.message); }
  }
});

// ---------- drzewka z partii (worker) ----------
function buildTree(payload, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker('db-worker.js', { type: 'module' });
    w.onmessage = (e) => {
      if (e.data.progress !== undefined) onProgress?.(e.data.progress);
      if (e.data.done) { w.terminate(); resolve(e.data); }
    };
    w.onerror = (e) => { w.terminate(); reject(e); };
    w.postMessage(payload);
  });
}

export async function fetchUserPgns(site, user, limit, onStatus, { clocks = false } = {}) {
  const pgns = [];
  if (!limit || limit === 'all') limit = Infinity;
  if (site === 'lichess') {
    onStatus('Pobieram partie z lichess… (przy wszystkich partiach może to chwilę potrwać)');
    const max = Number.isFinite(limit) ? `max=${limit}&` : '';
    const r = await apiFetch('lichess', `api/games/user/${encodeURIComponent(user)}?${max}clocks=${clocks}&evals=false&opening=true`, 'application/x-chess-pgn');
    if (!r.ok) throw new Error('lichess HTTP ' + r.status);
    pgns.push(...splitGames(await r.text()));
  } else {
    const r = await apiFetch('chesscom', `pub/player/${encodeURIComponent(user.toLowerCase())}/games/archives`);
    if (!r.ok) throw new Error('chess.com HTTP ' + r.status);
    const archives = (await r.json()).archives.reverse();
    for (const url of archives) {
      if (pgns.length >= limit) break;
      onStatus(`Pobieram ${url.split('/').slice(-2).join('/')} (${pgns.length} partii)…`);
      const rr = await apiFetch('chesscom', url.replace('https://api.chess.com/', ''));
      if (!rr.ok) continue;
      const games = (await rr.json()).games.filter((g) => g.rules === 'chess' && g.pgn).reverse();
      for (const g of games) { if (pgns.length < limit) pgns.push(g.pgn); }
    }
  }
  return pgns;
}

$('btn-tree').onclick = async () => {
  const site = $('tree-site').value, user = $('tree-user').value.trim();
  if (!user) return toast('Wpisz nazwę użytkownika');
  store.set('treeUser', user); store.set('treeSite', site);
  const status = (t) => ($('tree-status').textContent = t);
  try {
    const lim = $('tree-limit').value;
    const pgns = await fetchUserPgns(site, user, lim === 'all' ? Infinity : +lim, status);
    status(`Buduję drzewko z ${pgns.length} partii…`);
    const res = await buildTree({ pgns, user, maxPlies: 30 }, (p) => status(`Buduję drzewko… ${(p * 100).toFixed(0)}%`));
    S.trees.mytree = res.trees;
    S.treeGames.mytree = res.games;
    status(`Gotowe: ${pgns.length} partii gracza ${user}.`);
    scheduleExplorer(true);
  } catch (e) { status('Błąd: ' + e.message); }
};

// ---------- wiele baz PGN (zapisane w przeglądarce) ----------
const CB_FORMATS = /\.(2?cb[hvgatsjkpm]|2l[cgi]d|cbv|cbz|ctg)$/i;
async function refreshDbList(select) {
  const names = (await idb.keys('db:')).map((k) => k.slice(3)).sort();
  const sel = $('db-list');
  sel.innerHTML = '<option value="">– wybierz bazę –</option>' + (names.length > 1 ? '<option value="*">★ Wszystkie bazy razem</option>' : '') + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  if (select !== undefined) sel.value = select;
  return names;
}
$('db-file').onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  let last = null;
  for (const f of files) {
    if (CB_FORMATS.test(f.name)) {
      toast(`${f.name}: to plik ChessBase – wyeksportuj bazę do PGN (Plik → Eksport → PGN) i wczytaj .pgn.`, 6000);
      continue;
    }
    const text = await f.text();
    const name = f.name.replace(/\.(pgn|txt)$/i, '');
    await idb.set('db:' + name, text);
    last = name;
  }
  if (last) { await refreshDbList(last); openDb(last); }
};
$('db-list').onchange = () => openDb($('db-list').value);
$('db-del').onclick = async () => {
  const n = $('db-list').value;
  if (!n || n === '*') return;
  if (!confirm(`Usunąć bazę „${n}” z przeglądarki? (plik na dysku zostaje)`)) return;
  await idb.del('db:' + n);
  S.trees.mydb = null;
  await refreshDbList('');
  $('db-status').textContent = 'Baza usunięta.';
  scheduleExplorer(true);
};
async function openDb(name) {
  if (!name) return;
  let text;
  if (name === '*') {
    const keys = await idb.keys('db:');
    text = (await Promise.all(keys.map((k) => idb.get(k)))).join('\n\n');
  } else text = await idb.get('db:' + name);
  if (text) await loadDatabase(text, name === '*' ? 'wszystkie bazy' : name);
}

async function loadDatabase(text, name) {
  const status = (t) => ($('db-status').textContent = t);
  status(`Czytam ${name}…`);
  try {
    const res = await buildTree({ text, maxPlies: +$('db-plies').value }, (p) => status(`Indeksuję ${name}… ${(p * 100).toFixed(0)}%`));
    S.trees.mydb = res.trees;
    S.treeGames.mydb = res.games;
    status(`Baza „${name}”: ${res.games.length.toLocaleString('pl')} partii.`);
    setExplorerSrc('mydb');
    showTab('openings');
  } catch (err) { status('Błąd: ' + (err.message || err)); }
}

// ---------- import ----------
function setGame(game) {
  if (S.game?.moves?.length) store.set('prevPgn', exportPgn());
  reviewEngine.stop();
  S.reviewing = false;
  S.game = game;
  S.ply = 0;
  S.explore = null;
  S.retry = null;
  S.evals = [];
  S.review = null;
  S.live.fen = null;
  lastSoundFen = game.startFen;
  const h = game.headers;
  const me = (store.get('ccUser', '') || store.get('liUser', '')).toLowerCase();
  S.orientation = me && (h.Black || '').toLowerCase() === me ? 'black' : 'white';
  renderReportSummary();
  render();
}

function loadPgnText(text, { review, official } = {}) {
  text = text.trim();
  if (!text) return;
  if (/^([rnbqkpRNBQKP1-8]+\/){7}[rnbqkpRNBQKP1-8]+\s+[wb]/.test(text)) {
    try { setGame(gameFromFen(text)); showTab('analysis'); } catch { toast('Niepoprawny FEN'); }
    return;
  }
  const games = splitGames(text);
  if (games.length > 1) {
    if (games.length > 200) {
      toast(`To baza (${games.length} partii) – zapisuję jako bazę PGN.`);
      idb.set('db:wklejona baza', text).then(() => refreshDbList('wklejona baza'));
      loadDatabase(text, 'wklejona baza');
      return;
    }
    showGameList(games.map((pgn) => ({ pgn, h: parseHeaders(pgn) })), 'Partie z PGN');
    return;
  }
  const g = buildGame(games[0]);
  g.official = official || null;
  if (!g.moves.length && !g.headers.FEN) { toast('Nie rozpoznano partii'); return; }
  setGame(g);
  if (review ?? $('auto-review').checked) { showTab('report'); runReview(); } else showTab('report');
}

$('btn-load-pgn').onclick = () => loadPgnText($('pgn-input').value);
$('pgn-file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const text = await f.text();
  e.target.value = '';
  loadPgnText(text);
};

function showGameList(items, title, user) {
  const u = (user || '').toLowerCase();
  $('import-status').textContent = `${title}: ${items.length}`;
  $('game-list').innerHTML = items.map((it, i) => {
    const h = it.h;
    let cls = 'draw', res = h.Result || '*';
    if (u) {
      const isW = (h.White || '').toLowerCase() === u;
      if (res === '1-0') cls = isW ? 'win' : 'loss';
      else if (res === '0-1') cls = isW ? 'loss' : 'win';
    }
    const extra = [h.TimeControl ? fmtTc(h.TimeControl) : '', h.Date || h.UTCDate || '', h.ECO || '', (h.Opening || '').slice(0, 40)].filter(Boolean).join(' · ');
    return `<div class="game-item" data-i="${i}"><div>${esc(h.White)} <small class="muted">${esc(h.WhiteElo || '')}</small> – ${esc(h.Black)} <small class="muted">${esc(h.BlackElo || '')}</small></div><div class="res ${cls}">${esc(res)}</div><div class="meta">${esc(extra)}</div></div>`;
  }).join('');
  $('game-list').onclick = (e) => {
    const it = e.target.closest('[data-i]');
    if (it) loadPgnText(items[+it.dataset.i].pgn, { official: items[+it.dataset.i].acc });
  };
}
function fmtTc(tc) {
  const [base, inc] = tc.split('+');
  if (!+base) return tc;
  return `${+base >= 60 ? Math.round(base / 60) + ' min' : base + ' s'}${inc ? ' +' + inc : ''}`;
}

$('btn-li').onclick = async () => {
  const v = $('li-user').value.trim();
  if (!v) return;
  const st = $('import-status');
  const m = v.match(/lichess\.org\/([a-zA-Z0-9]{8})/);
  try {
    if (m) {
      st.textContent = 'Pobieram partię…';
      const r = await apiFetch('lichess', `game/export/${m[1]}?clocks=false&evals=false`, 'application/x-chess-pgn');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      st.textContent = '';
      return loadPgnText(await r.text());
    }
    store.set('liUser', v);
    st.textContent = 'Pobieram listę partii…';
    const r = await apiFetch('lichess', `api/games/user/${encodeURIComponent(v)}?max=40&clocks=false&evals=false&opening=true`, 'application/x-chess-pgn');
    if (!r.ok) throw new Error(r.status === 404 ? 'nie ma takiego gracza' : 'HTTP ' + r.status);
    const games = splitGames(await r.text()).map((pgn) => ({ pgn, h: parseHeaders(pgn) }));
    showGameList(games, `Lichess – ${v}`, v);
  } catch (e) { st.textContent = 'Błąd: ' + e.message; }
};

let ccArchives = [];
$('btn-cc').onclick = async () => {
  const u = $('cc-user').value.trim().toLowerCase();
  if (!u) return;
  const st = $('import-status');
  try {
    if (store.get('ccUser', '') !== u || !ccArchives.length) {
      st.textContent = 'Pobieram archiwa…';
      const r = await apiFetch('chesscom', `pub/player/${encodeURIComponent(u)}/games/archives`);
      if (!r.ok) throw new Error(r.status === 404 ? 'nie ma takiego gracza' : 'HTTP ' + r.status);
      ccArchives = (await r.json()).archives.reverse();
      store.set('ccUser', u);
      $('cc-month').innerHTML = ccArchives.map((a, i) => `<option value="${i}">${a.split('/').slice(-2).reverse().join('.')}</option>`).join('');
    }
    const url = ccArchives[+$('cc-month').value || 0];
    if (!url) throw new Error('brak partii');
    st.textContent = 'Pobieram partie…';
    const r = await apiFetch('chesscom', url.replace('https://api.chess.com/', ''));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const games = (await r.json()).games.filter((g) => g.pgn && g.rules === 'chess').reverse().map((g) => ({ pgn: g.pgn, h: parseHeaders(g.pgn), acc: g.accuracies }));
    showGameList(games, `Chess.com – ${u}`, u);
  } catch (e) { st.textContent = 'Błąd: ' + e.message; }
};
$('cc-month').onchange = () => ccArchives.length && $('btn-cc').click();
$('cc-user').oninput = () => { ccArchives = []; $('cc-month').innerHTML = ''; };

// ---------- eksport ----------
function exportPgn() {
  const h = { Event: '?', Site: '?', Date: '????.??.??', Round: '?', White: '?', Black: '?', Result: '*', ...S.game.headers };
  const keys = ['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result', ...Object.keys(h).filter((k) => !['Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result'].includes(k))];
  let out = keys.map((k) => `[${k} "${String(h[k]).replace(/"/g, '\\"')}"]`).join('\n') + '\n\n';
  const c = new Chess(S.game.startFen);
  let no = c.moveNumber();
  const parts = [];
  S.game.moves.forEach((m, i) => {
    if (m.color === 'w') parts.push(`${no}.`);
    else if (i === 0) parts.push(`${no}...`);
    const r = S.review?.[i];
    parts.push(m.san + (r && C.CLASSES[r.cls].nag ? ' ' + C.CLASSES[r.cls].nag : ''));
    const ev = S.evals[i + 1];
    const com = [];
    if (ev) com.push(`[%eval ${ev.mate !== null && ev.mate !== undefined ? '#' + ev.mate : ((ev.cp ?? 0) / 100).toFixed(2)}]`);
    if (r && !['best', 'book', 'excellent', 'good'].includes(r.cls)) com.push(`${C.CLASSES[r.cls].label}. ${r.text}`);
    if (com.length) parts.push(`{ ${com.join(' ').replace(/[{}]/g, '')} }`);
    if (m.color === 'b') no++;
  });
  parts.push(h.Result);
  let line = '';
  for (const p of parts) {
    if ((line + ' ' + p).length > 79) { out += line.trim() + '\n'; line = ''; }
    line += ' ' + p;
  }
  return out + line.trim() + '\n';
}
$('btn-download').onclick = () => {
  const h = S.game.headers;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([exportPgn()], { type: 'application/x-chess-pgn' }));
  a.download = `${(h.White || 'biale')}-${(h.Black || 'czarne')}-${(h.Date || '').replace(/\./g, '-')}.pgn`.replace(/[^\w.\-]+/g, '_');
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); toast(`Skopiowano ${what}`); }
  catch { prompt(`Skopiuj ${what}:`, text); }
}
$('btn-copy-pgn').onclick = () => copy(exportPgn(), 'PGN');
$('btn-copy-fen').onclick = () => copy(curFen(), 'FEN');

// ---------- przyciski / klawiatura ----------
$('nav-first').onclick = () => (S.explore ? ((S.explore.idx = 0), render()) : goTo(0));
$('nav-prev').onclick = () => go(-1);
$('nav-next').onclick = () => go(1);
$('nav-last').onclick = () => (S.explore ? ((S.explore.idx = S.explore.moves.length), render()) : goTo(S.game.moves.length));
$('nav-play').onclick = () => {
  if (S.playing) { clearInterval(S.playing); S.playing = null; $('nav-play').textContent = '▶'; return; }
  $('nav-play').textContent = '❚❚';
  S.playing = setInterval(() => {
    const end = S.explore ? S.explore.idx >= S.explore.moves.length : S.ply >= S.game.moves.length;
    if (end) { $('nav-play').click(); return; }
    go(1);
  }, 1000);
};
$('btn-return').onclick = () => { S.retry = null; returnToGame(); };
$('btn-flip').onclick = () => { S.orientation = S.orientation === 'white' ? 'black' : 'white'; render(); };
$('btn-new').onclick = () => { setGame(gameFromFen(new Chess().fen())); showTab('analysis'); };
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if (S.train?.onKey?.(e.key)) { e.preventDefault(); return; }
  if (e.key === 'ArrowLeft') { go(-1); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { go(1); e.preventDefault(); }
  else if (e.key === 'Home') $('nav-first').click();
  else if (e.key === 'End') $('nav-last').click();
  else if (e.key === 'Escape') { S.retry = null; returnToGame(); }
  else if (e.key === 'f') $('btn-flip').click();
});
// przewijanie kółkiem nad szachownicą
$('board').addEventListener('wheel', (e) => { e.preventDefault(); go(e.deltaY > 0 ? 1 : -1); }, { passive: false });

// ---------- zakładki ----------
const PAGE_TITLES = { home: 'Start', play: 'Graj', puzzles: 'Zadania', study: 'Ucz się', train: 'Trener', analysis: 'Analiza', report: 'Przegląd partii', openings: 'Otwarcia', import: 'Import', settings: 'Ustawienia' };
function showTab(name) {
  document.querySelector('.app').hidden = name === 'home';
  $('page-title').textContent = PAGE_TITLES[name] || '';
  if (name === 'home') renderHome(HOME_API);
  store.set('lastTab', name);
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const t of document.querySelectorAll('.tab')) t.hidden = t.id !== 'tab-' + name;
  if (name === 'openings') scheduleExplorer(true);
  if (name === 'report') renderGraph();
  renderMoves();
  if (S.editor && name !== 'analysis') closeEditor();
  if (S.train) { S.train = null; render(); }
  onShowTab(name);
  onShowStudyTab(name);
  onShowPlayTab(name);
  if (name !== 'home') fx.enter(document.querySelectorAll(`#tab-${name} > *`), { step: 30, dist: 6 });
}
let HOME_API = null;
document.querySelector('.tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); };

// ---------- ustawienia ----------
function renderSettings() {
  $('piece-grid').innerHTML = Object.keys(S.pieces).sort().map((s) =>
    `<button data-set="${s}" class="${s === S.settings.pieceSet ? 'on' : ''}" style="background-image:url('${pieceUrl(s, 'wN')}')" title="${s}"><span>${s}</span></button>`).join('');
  $('board-grid').innerHTML = BOARDS.map((b) =>
    `<button data-board="${b}" class="${b === S.settings.board ? 'on' : ''}" style="background-image:url('board/${b}')" title="${b}"><span>${b.replace(/\..*$/, '').replace('svg/', '')}</span></button>`).join('');
  $('opt-coords').checked = S.settings.coords;
  $('opt-arrow').checked = S.settings.arrow;
  $('opt-badges').checked = S.settings.badges;
}
$('piece-grid').onclick = (e) => {
  const b = e.target.closest('[data-set]'); if (!b) return;
  S.settings.pieceSet = b.dataset.set; store.set('pieceSet', b.dataset.set); applyPieceSet(); renderSettings();
};
$('board-grid').onclick = (e) => {
  const b = e.target.closest('[data-board]'); if (!b) return;
  S.settings.board = b.dataset.board; store.set('board', b.dataset.board); applyBoard(); renderSettings();
};
for (const [id, key] of [['opt-coords', 'coords'], ['opt-arrow', 'arrow'], ['opt-badges', 'badges']]) {
  $(id).onchange = () => { S.settings[key] = $(id).checked; store.set(key, $(id).checked); applyBoard(); drawShapes(); };
}
$('btn-token').onclick = async () => {
  const tok = $('li-token').value.trim();
  if (S.server) {
    const r = await fetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lichessToken: tok }) });
    const j = await r.json();
    $('token-status').textContent = j.hasLichessToken ? '✓ Token zapisany na serwerze.' : 'Token usunięty.';
  } else {
    store.set('lichessToken', tok);
    $('token-status').textContent = tok ? '✓ Token zapisany w przeglądarce.' : 'Token usunięty.';
  }
  $('li-token').value = '';
  exCache.clear();
  scheduleExplorer(true);
};

$('snd-set').onchange = () => { sound.set = $('snd-set').value; store.set('soundSet', sound.set); sound.buffers.clear(); sound.loading.clear(); sound.preload(); sound.play('Move'); };
$('snd-vol').oninput = () => { sound.vol = +$('snd-vol').value; store.set('soundVol', sound.vol); };
$('snd-test').onclick = () => { const seq = ['Move', 'Capture', 'Check', 'Checkmate']; seq.forEach((n, i) => setTimeout(() => sound.play(n), i * 450)); };

// ---------- figurki ----------
const FIG = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘' };
function figurine(san) {
  const p = san[0];
  return FIG[p] ? `<i class="fig">${FIG[p]}</i>${esc(san.slice(1))}` : esc(san);
}

// ---------- zakładka Analiza: podzakładki ----------
function setAnSub(sub) {
  for (const b of $('an-sub').children) b.classList.toggle('active', b.dataset.sub === sub);
  for (const id of ['engine', 'menu', 'book', 'editor']) $('an-' + id).hidden = id !== sub;
  if (sub !== 'editor' && S.editor) closeEditor();
  if (sub === 'book') renderBook();
  if (sub === 'menu') { $('an-search').hidden = true; $('an-saved').hidden = true; }
  fx.enter(document.querySelectorAll(`#an-${sub} > *`), { step: 25 });
}
$('an-sub').onclick = (e) => { const s = e.target.dataset.sub; if (s) setAnSub(s); };

async function loadAny(text) {
  text = text.trim();
  if (!text) return;
  if (/lichess\.org\/study\//.test(text)) { showTab('study'); $('study-url').value = text; $('study-import').click(); return; }
  if (/lichess\.org\/[a-zA-Z0-9]{8}/.test(text)) { $('li-user').value = text; $('btn-li').click(); showTab('report'); return; }
  loadPgnText(text, { review: false });
  goTo(S.game.moves.length);
  showTab('analysis');
  setAnSub('engine');
}
$('an-load').onclick = $('an-paste-go').onclick = () => loadAny($('an-paste').value);
$('an-paste').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadAny($('an-paste').value); });
$('an-prev').onclick = () => { const p = store.get('prevPgn', ''); if (!p) return toast('Brak poprzedniej partii.'); loadPgnText(p, { review: false }); showTab('analysis'); setAnSub('engine'); };
document.querySelector('#an-menu .menu-list').onclick = (e) => {
  const m = e.target.closest('[data-m]')?.dataset.m;
  if (!m) return;
  if (m === 'editor') openEditor();
  if (m === 'new') { setGame(gameFromFen(new Chess().fen())); setAnSub('engine'); }
  if (m === 'collections') { setExplorerSrc('mydb'); showTab('openings'); }
  if (m === 'search') { $('an-search').hidden = false; $('an-saved').hidden = true; $('an-search-q').focus(); }
  if (m === 'book') setAnSub('book');
  if (m === 'saved') { $('an-saved').hidden = false; $('an-search').hidden = true; renderSaved(); }
  if (m === 'play') showTab('play');
};

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-save]')) $('btn-save').click();
  const g2 = e.target.closest('[data-go2], .sb-icons [data-go]');
  if (!g2) return;
  const go = g2.dataset.go2 || g2.dataset.go;
  if (go === 'saved') { showTab('analysis'); setAnSub('menu'); $('an-saved').hidden = false; $('an-search').hidden = true; renderSaved(); }
  else showTab(go);
});
// zapisane analizy
$('btn-save').onclick = async () => {
  if (!S.game.moves.length) return toast('Nie ma czego zapisać.');
  const h = S.game.headers;
  const name = prompt('Nazwa analizy:', `${h.White || 'Białe'} – ${h.Black || 'Czarne'}${h.Date ? ' ' + h.Date : ''}`);
  if (name === null) return;
  const id = Date.now().toString(36);
  await idb.set('saved:' + id, { id, name: name || 'Analiza', date: new Date().toISOString().slice(0, 10), pgn: exportPgn() });
  sound.play('Confirmation');
  toast('Zapisano w „Analiza → Menu → Zapisane analizy”.');
};
async function renderSaved() {
  const keys = await idb.keys('saved:');
  const items = (await Promise.all(keys.map((k) => idb.get(k)))).filter(Boolean).sort((a, b) => b.id.localeCompare(a.id));
  $('an-saved-list').innerHTML = items.length ? items.map((it) => `<div class="rep-item" data-sv="${it.id}"><div><b>${esc(it.name)}</b> <span class="muted">${esc(it.date)}</span></div><div class="rep-btns"><button class="btn primary" data-a="open">Otwórz</button><button class="btn" data-a="del">✕</button></div></div>`).join('')
    : '<p class="muted">Brak zapisanych analiz. Użyj ♥ pod szachownicą, żeby zapisać bieżącą partię.</p>';
}
$('an-saved-list').onclick = async (e) => {
  const id = e.target.closest('[data-sv]')?.dataset.sv; const a = e.target.closest('[data-a]')?.dataset.a;
  if (!id || !a) return;
  const it = await idb.get('saved:' + id);
  if (a === 'open') { loadPgnText(it.pgn, { review: false }); showTab('analysis'); setAnSub('engine'); }
  if (a === 'del' && confirm(`Usunąć „${it.name}”?`)) { await idb.del('saved:' + id); renderSaved(); }
};

// wyszukiwanie w bazach
$('an-search-go').onclick = async () => {
  const q = $('an-search-q').value.trim().toLowerCase();
  if (!q) return;
  const st = $('an-search-status');
  st.textContent = 'Szukam…';
  const results = [];
  const sources = [...(await idb.keys('db:')), ...(await idb.keys('saved:'))];
  for (const k of sources) {
    const v = await idb.get(k);
    const text = typeof v === 'string' ? v : v?.pgn || '';
    for (const pgn of splitGames(text)) {
      const h = parseHeaders(pgn);
      const hay = [h.White, h.Black, h.Event, h.Opening, h.ECO, h.Site, h.Date].join(' ').toLowerCase();
      if (hay.includes(q)) results.push({ pgn, h });
      if (results.length >= 200) break;
    }
    if (results.length >= 200) break;
  }
  st.textContent = results.length ? `Znaleziono ${results.length}${results.length >= 200 ? '+' : ''} partii.` : 'Nic nie znaleziono (szukam w bazach PGN i zapisanych analizach).';
  const list = $('an-search-list');
  list.innerHTML = results.map((it, i) => `<div class="game-item" data-i="${i}"><div>${esc(it.h.White)} – ${esc(it.h.Black)}</div><div class="res">${esc(it.h.Result || '*')}</div><div class="meta">${esc([it.h.Date, it.h.ECO, it.h.Event].filter(Boolean).join(' · '))}</div></div>`).join('');
  list.onclick = (ev) => { const it = ev.target.closest('[data-i]'); if (it) { loadPgnText(results[+it.dataset.i].pgn, { review: false }); showTab('analysis'); setAnSub('engine'); } };
};

// ---------- edytor pozycji ----------
const ED_PIECES = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP'];
function renderPalette() {
  $('ed-palette').innerHTML = ['hand', ...ED_PIECES, 'trash'].map((p) => {
    const on = (S.editor?.sel || 'hand') === p;
    if (p === 'hand') return `<button data-p="hand" class="${on ? 'on' : ''}" title="Przesuwanie">✋</button>`;
    if (p === 'trash') return `<button data-p="trash" class="${on ? 'on' : ''}" title="Gumka">⌫</button>`;
    return `<button data-p="${p}" class="${on ? 'on' : ''}" style="background-image:url('${pieceUrl(S.settings.pieceSet, p)}')"></button>`;
  }).join('');
}
function syncEditorFen() {
  if (!S.editor) return;
  const board = cg.getFen();
  const castle = (board.split('/')[7].startsWith('R') && board.split('/')[7].slice(4, 5) === 'K' ? '' : '');
  void castle;
  const rows = board.split('/');
  const r1 = rows[7].replace(/\d/g, (d) => '.'.repeat(+d)), r8 = rows[0].replace(/\d/g, (d) => '.'.repeat(+d));
  let c = '';
  if (r1[4] === 'K' && r1[7] === 'R') c += 'K';
  if (r1[4] === 'K' && r1[0] === 'R') c += 'Q';
  if (r8[4] === 'k' && r8[7] === 'r') c += 'k';
  if (r8[4] === 'k' && r8[0] === 'r') c += 'q';
  $('ed-fen').value = `${board} ${$('ed-turn').value} ${c || '-'} - 0 1`;
}
function openEditor(fen) {
  if (S.train) { S.train = null; }
  S.editor = { sel: 'hand' };
  setAnSub('editor');
  S.editor = { sel: 'hand' };
  const f = fen || curFen();
  $('ed-turn').value = f.split(' ')[1] || 'w';
  cg.set({
    fen: f, lastMove: undefined, check: false, orientation: S.orientation,
    movable: { free: true, color: 'both', dests: undefined, showDests: false },
    draggable: { deleteOnDropOff: true },
    events: {
      change: syncEditorFen,
      select: (key) => {
        const sel = S.editor?.sel;
        if (!sel || sel === 'hand') return;
        const m = new Map();
        m.set(key, sel === 'trash' ? undefined : { color: sel[0] === 'w' ? 'white' : 'black', role: ROLES[sel[1].toLowerCase()] });
        cg.setPieces(m);
        cg.selectSquare(null);
        syncEditorFen();
      },
    },
  });
  cg.setAutoShapes([]);
  renderPalette();
  syncEditorFen();
}
function closeEditor() {
  S.editor = null;
  updateBoard.key = null;
  cg.set({ movable: { free: false, showDests: true }, draggable: { deleteOnDropOff: false }, events: { change: undefined, select: undefined } });
  render();
}
$('ed-palette').onclick = (e) => { const p = e.target.closest('[data-p]')?.dataset.p; if (p && S.editor) { S.editor.sel = p; renderPalette(); } };
$('ed-turn').onchange = syncEditorFen;
$('ed-fen').addEventListener('change', () => { try { const c = new Chess($('ed-fen').value); cg.set({ fen: c.fen() }); } catch { toast('Niepoprawny FEN'); } });
$('an-editor').addEventListener('click', (e) => {
  const a = e.target.closest('[data-ed]')?.dataset.ed;
  if (!a) return;
  if (a === 'start') { cg.set({ fen: new Chess().fen() }); $('ed-turn').value = 'w'; syncEditorFen(); }
  if (a === 'clear') { cg.set({ fen: '8/8/8/8/8/8/8/8' }); syncEditorFen(); }
  if (a === 'flip') { cg.toggleOrientation(); S.orientation = cg.state.orientation; }
  if (a === 'cancel') { closeEditor(); setAnSub('menu'); }
  if (a === 'done') {
    const fen = $('ed-fen').value;
    let ok = true;
    try { new Chess(fen); } catch (err) { ok = false; toast('Ta pozycja jest niepoprawna: ' + (err.message || '').replace('Invalid FEN: ', ''), 4500); }
    if (!ok) return;
    closeEditor();
    setGame(gameFromFen(fen));
    setAnSub('engine');
  }
});

// ---------- książeczka debiutów ----------
let BOOK = null;
async function loadBook() { if (!BOOK) BOOK = await fetch('data/book.json').then((r) => r.json()); return BOOK; }
async function renderBook() {
  const book = await loadBook();
  const fen = curFen();
  const key = epd(fen);
  const named = S.openings[key];
  let deepest = null;
  for (let p = S.explore ? S.explore.base : S.ply; p >= 0 && !deepest; p--) deepest = S.openings[epd(posFen(p))];
  const cur = named || deepest;
  $('book-cur').innerHTML = cur ? `<span class="pill accent">${esc(cur.e)}</span><div class="book-name">${esc(cur.n)}</div>${named ? '' : '<div class="muted">Wyszedłeś już z książki – pokazuję ostatnie znane otwarcie.</div>'}` : '<div class="book-name">Pozycja początkowa</div>';
  const sans = (book.tree[key] || '').split(' ').filter(Boolean);
  const rows = sans.map((san) => {
    const c = new Chess(fen);
    let m; try { m = c.move(san); } catch { return ''; }
    const after = S.openings[epd(c.fen())];
    // najgłębsza nazwa w dalszej linii
    let hint = after;
    if (!hint) {
      const line = book.list.find((l) => l[2].startsWith(movesSoFar().concat(san).join(' ')));
      if (line) hint = { e: line[0], n: line[1] };
    }
    return `<button class="book-move" data-uci="${m.from + m.to + (m.promotion || '')}"><b>${figurine(m.san)}</b><span>${hint ? esc(hint.n) : ''}</span><small>${hint ? esc(hint.e) : ''}</small></button>`;
  }).join('');
  $('book-moves').innerHTML = rows || '<p class="muted">Brak dalszych ruchów książkowych w tej pozycji.</p>';
  renderBookList();
}
function movesSoFar() {
  const base = S.explore ? S.explore.base : S.ply;
  const arr = S.game.moves.slice(0, base).map((m) => m.san);
  if (S.explore) arr.push(...S.explore.moves.slice(0, S.explore.idx).map((m) => m.san));
  return arr;
}
$('book-moves').onclick = (e) => { const b = e.target.closest('[data-uci]'); if (b) playUci(b.dataset.uci); };
function renderBookList() {
  if (!BOOK) return;
  const q = $('book-q').value.trim().toLowerCase();
  const fam = new Map();
  for (const [eco, name, pgn] of BOOK.list) {
    if (q && !(name.toLowerCase().includes(q) || eco.toLowerCase().startsWith(q))) continue;
    const f = name.split(':')[0];
    if (!fam.has(f)) fam.set(f, []);
    fam.get(f).push([eco, name, pgn]);
  }
  const fams = [...fam.entries()].slice(0, q ? 60 : 400);
  $('book-list').innerHTML = fams.map(([f, items]) => `<details ${q ? 'open' : ''}><summary><b>${esc(f)}</b> <span class="muted">${items[0][0]} · ${items.length}</span></summary>
    ${items.slice(0, 80).map((it) => `<div class="book-item" data-pgn="${esc(it[2])}"><span class="pill">${esc(it[0])}</span> ${esc(it[1].split(': ')[1] || it[1])}<small class="mono">${esc(it[2])}</small></div>`).join('')}</details>`).join('');
}
let bookQT = null;
$('book-q').oninput = () => { clearTimeout(bookQT); bookQT = setTimeout(renderBookList, 200); };
$('book-list').onclick = (e) => {
  const it = e.target.closest('[data-pgn]');
  if (!it) return;
  setGame(buildGame(it.dataset.pgn));
  S.ply = S.game.moves.length;
  render();
};

// ---------- start ----------
async function init() {
  const [pieces, openings, engines] = await Promise.all([
    fetch('data/pieces.json').then((r) => r.json()),
    fetch('data/openings.json').then((r) => r.json()),
    listEngines(),
  ]);
  S.pieces = pieces;
  S.openings = openings;
  S.server = engines.some((e) => e.id !== WASM_ID) || (await fetch('/api/config').then((r) => r.ok).catch(() => false));
  if (S.server) {
    const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
    $('token-status').textContent = cfg.hasLichessToken ? '✓ Token jest zapisany.' : 'Brak tokenu.';
  } else $('token-status').textContent = store.get('lichessToken', '') ? '✓ Token jest zapisany.' : 'Brak tokenu.';
  if (!pieces[S.settings.pieceSet]) S.settings.pieceSet = 'cburnett';

  const opts = engines.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
  $('live-engine').innerHTML = opts;
  $('review-engine').innerHTML = opts;
  const pick = (sel, saved) => { if (saved && engines.some((e) => e.id === saved)) $(sel).value = saved; };
  pick('live-engine', store.get('liveEngine'));
  pick('review-engine', store.get('reviewEngine'));
  syncReviewInputs();

  $('snd-set').value = sound.set;
  $('snd-vol').value = sound.vol;
  $('tree-user').value = store.get('treeUser', '');
  $('tree-site').value = store.get('treeSite', 'chesscom');
  $('cc-user').value = store.get('ccUser', '');
  $('li-user').value = store.get('liUser', '');

  applyPieceSet();
  applyBoard();
  renderSettings();
  renderChips();
  setExplorerSrc(S.explorerSrc);
  refreshDbList().catch(() => {});
  initTraining({
    S, render, sound, toast, badgeHtml, store, fetchUserPgns, terminalEval, catSays, showTab, markActive, pushRating,
    miniBoard: (fen, o) => miniBoard(fen, o),
    openings: () => S.openings,
    engineId: () => $('review-engine').value,
    loadPgnText: (t) => { S.train = null; loadPgnText(t, { review: false }); },
  });
  HOME_API = {
    store, profile, avatarHtml, streak, apiFetch, showTab, pushRating, ratingHistory, reviewPgn: (pgn) => { loadPgnText(pgn, { review: true }); showTab('report'); },
    pieceUrl: (k) => pieceUrl(S.settings.pieceSet, k), repDue, repCoverFen, quickPlay, playBots, playCareer, playFriend, openPuzzles,
    openDrills: (id) => { showTab('study'); setStudySub('drills'); if (id) startDrill(id, 'learn'); },
  };
  initHome(HOME_API);
  initProfile({ store, toast, sound, showTab });
  initPlay({
    S, render, sound, toast, store, catSays, profile, saveProfile, lichessToken, lichessUser, avatarHtml, markActive, showTab, cg, pushRating,
    reviewPgn: (pgn) => { loadPgnText(pgn, { review: true }); showTab('report'); },
  });
  initStudy({
    S, render, sound, toast, store, apiFetch, drills,
    loadPgnText: (t) => { S.train = null; loadPgnText(t, { review: false }); showTab('analysis'); },
  });
  renderReportSummary();
  render();
  if (!new URLSearchParams(location.search).get('join')) showTab('home');
}
init();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

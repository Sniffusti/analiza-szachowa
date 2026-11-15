// Graj: boty-kotki, Kariera (rosnący ranking), własny ranking silnika, gra online (link dla znajomego
// i matchmaking przez PeerJS – bez serwera), partie na lichess (Board API po zalogowaniu).
import { Chess } from './vendor/chess.js';
import { Engine } from './engine.js';
import { idb } from './store.js';
import * as fx from './fx.js';
import { materialHtml } from './material.js';

let A;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const engine = new Engine('play');

// ---------------------------------------------------------------- boty-kotki
export const BOTS = [
  { name: 'Kłębuszek', elo: 250, cat: 0, say: 'Miau! Dopiero uczę się, jak chodzi skoczek…' },
  { name: 'Puszek', elo: 400, cat: 1, say: 'Lubię gonić bierki jak kłębek wełny.' },
  { name: 'Psotka', elo: 550, cat: 2, say: 'Czasem coś zostawię bez obrony. Złap to!' },
  { name: 'Mruczek', elo: 700, cat: 3, say: 'Mrr… zagrajmy spokojnie.' },
  { name: 'Figa', elo: 850, cat: 4, say: 'Znam już kilka pułapek debiutowych!' },
  { name: 'Rudzik', elo: 1000, cat: 5, say: 'Nie oddam ci tak łatwo hetmana.' },
  { name: 'Miłka', elo: 1150, cat: 6, say: 'Lubię rozwinąć figury i zrobić roszadę.' },
  { name: 'Zefir', elo: 1300, cat: 7, say: 'Liczę na dwa ruchy do przodu. Uważaj.' },
  { name: 'Tygrysek', elo: 1450, cat: 8, say: 'Atakuję króla przy każdej okazji!' },
  { name: 'Sierściuch', elo: 1600, cat: 9, say: 'Widzę widełki, zanim ty je zobaczysz.' },
  { name: 'Kicia Mistrzyni', elo: 1800, cat: 10, say: 'Gram jak mocny klubowicz. Powodzenia!' },
  { name: 'Szary Kardynał', elo: 2000, cat: 11, say: 'Pozycja to moja specjalność.' },
  { name: 'Cień', elo: 2200, cat: 12, say: 'Nie zauważysz, kiedy przegrasz.' },
  { name: 'Złoty Lew', elo: 2400, cat: 13, say: 'Mistrzowski poziom. Daj z siebie wszystko.' },
  { name: 'Pantera', elo: 2650, cat: 14, say: 'Arcymistrzowska precyzja. Mrrrau.' },
  { name: 'Arcykot', elo: 2900, cat: 15, say: 'Najsilniejszy kot w okolicy. Spróbuj mnie pokonać!' },
];
const GROUPS = [['Początkujący', 0, 4], ['Średniozaawansowany', 4, 8], ['Zaawansowany', 8, 12], ['Mistrz', 12, 16]];
const botAva = (b) => `bots/cat-${b.cat}.png`;
function botForElo(elo) { return BOTS.reduce((a, b) => (Math.abs(b.elo - elo) < Math.abs(a.elo - elo) ? b : a)); }
const RANKS = [[0, 'Kociak'], [1000, 'Łowca myszy'], [1400, 'Kot podwórkowy'], [1800, 'Tygrys'], [2200, 'Lew'], [2600, 'Arcykot']];
export function rankOf(r) { let n = RANKS[0][1]; for (const [min, name] of RANKS) if (r >= min) n = name; return n; }
export function categoryOf(tcStr) {
  const base = +String(tcStr).split('+')[0] || 0, inc = +String(tcStr).split('+')[1] || 0;
  const t = base * 60 + inc * 40;
  return !base ? 'bez zegara' : t < 180 ? 'bullet' : t < 600 ? 'blitz' : 'rapid';
}

const G = { chess: null, color: 'w', on: false, mode: null, clocks: null, timer: null, last: null, inc: 0 };

// ---------------------------------------------------------------- wspólne
/** Pozycja po `ply` półruchach (do przeglądania w trakcie partii). */
function positionAt(ply) {
  const hist = G.chess.history({ verbose: true });
  const c = new Chess(hist[0]?.before || G.chess.fen());
  let last = null;
  for (let i = 0; i < ply; i++) last = c.move(hist[i].san);
  return { fen: c.fen(), last: last ? [last.from, last.to] : null };
}
function onKey(key) {
  if (!G.chess) return false;
  const n = G.chess.history().length;
  let v = G.viewPly ?? n;
  if (key === 'ArrowLeft') v = Math.max(0, v - 1);
  else if (key === 'ArrowRight') v = Math.min(n, v + 1);
  else if (key === 'Home') v = 0;
  else if (key === 'End') v = n;
  else return false;
  G.viewPly = v >= n ? null : v;
  if (G.viewPly !== null) { const pos = positionAt(v); const san = G.chess.history()[v - 1]; if (san) A.sound.forSan(san); }
  renderMoveList(); view();
  return true;
}
function view() {
  const live = G.on && G.mode !== 'review';
  const browsing = G.viewPly !== null && G.viewPly !== undefined && G.viewPly < G.chess.history().length;
  const pos = browsing ? positionAt(G.viewPly) : null;
  A.S.train = {
    fen: browsing ? pos.fen : G.chess.fen(), lastMove: browsing ? pos.last : G.last, orientation: G.color === 'w' ? 'white' : 'black', hideEval: true, shapes: [], onMove: onUserMove,
    onKey, locked: browsing,
    players: G.headers,
    playerColor: live ? (G.color === 'w' ? 'white' : 'black') : undefined,
    premoves: live && !browsing ? G.queue || [] : [],
    onPremove: (o, d) => { (G.queue ||= []).push([o, d]); A.cg.cancelPremove(); view(); },
    onPremoveCancel: () => { G.queue = []; view(); },
  };
  A.render();
}
/** Po ruchu przeciwnika: wykonaj pierwszy zaplanowany premove (jeśli legalny), resztę zostaw w kolejce. */
function runPremove() {
  if (!G.on || !G.queue?.length || G.chess.turn() !== G.color) return false;
  const [o, d] = G.queue.shift();
  const piece = G.chess.get(o);
  const promo = piece?.type === 'p' && (d[1] === '8' || d[1] === '1') ? 'q' : '';
  const ok = G.chess.moves({ verbose: true }).some((m) => m.from === o && m.to === d);
  if (!ok) { G.queue = []; view(); return false; }
  setTimeout(() => onUserMove(o + d + promo), 30);
  return true;
}
function fmtClock(ms) {
  if (ms === null || ms === undefined) return '–';
  const s = Math.max(0, ms) / 1000;
  if (s < 20) return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function playerRow(side) {
  const me = side === G.color;
  const p = A.profile();
  const name = me ? (p.name || 'Ty') : G.oppName;
  const ava = me ? A.avatarHtml(p, 30) : `<img class="ava" src="${G.oppAva || 'cat.png'}" width="30" height="30" alt="" onerror="this.src='cat.png'">`;
  const rating = me ? G.myRating : G.oppRating;
  const turn = G.on && G.chess.turn() === side;
  return `<div class="clock ${me ? 'me' : ''} ${turn ? 'run' : ''}"><span class="who">${ava}<span>${esc(name)} <small class="mono">${rating ?? ''}</small>${materialHtml(G.chess.fen(), side)}</span></span><b>${G.clocks ? fmtClock(G.clocks[side]) : ''}</b></div>`;
}
function renderClocks() {
  const opp = G.color === 'w' ? 'b' : 'w';
  $('play-clocks').hidden = false;
  $('play-clocks').innerHTML = playerRow(opp) + playerRow(G.color);
}
function startTimer() {
  clearInterval(G.timer);
  if (!G.clocks) return;
  let lastT = performance.now();
  G.timer = setInterval(() => {
    const now = performance.now();
    if (G.on && G.chess.history().length >= (G.mode === 'online' || G.mode === 'lichess' ? 2 : 0)) {
      const t = G.chess.turn();
      G.clocks[t] -= now - lastT;
      if (G.clocks[t] <= 0) {
        G.clocks[t] = 0;
        if (G.mode === 'online' && t === G.color) send({ t: 'flag' });
        if (G.mode !== 'lichess' && (G.mode !== 'online' || t === G.color)) endGame(t === G.color ? 'loss' : 'win', 'Na czas');
      }
    }
    lastT = now;
    renderClocks();
  }, 100);
}
function pgnOf(result) {
  const start = G.chess.history({ verbose: true })[0]?.before;
  const c = new Chess(start || undefined);
  for (const san of G.chess.history()) c.move(san);
  const h = G.headers;
  c.setHeader('Event', h.Event); c.setHeader('Site', h.Site || 'Analiza');
  c.setHeader('Date', new Date().toISOString().slice(0, 10).replace(/-/g, '.'));
  c.setHeader('White', h.White); c.setHeader('Black', h.Black);
  if (h.WhiteElo) c.setHeader('WhiteElo', String(h.WhiteElo));
  if (h.BlackElo) c.setHeader('BlackElo', String(h.BlackElo));
  if (G.tc && G.tc !== '0') c.setHeader('TimeControl', String(+G.tc.split('+')[0] * 60) + '+' + (+G.tc.split('+')[1] || 0));
  c.setHeader('Result', result);
  return c.pgn();
}
function renderMoveList() {
  const h = G.chess.history();
  let html = '';
  const cur = G.viewPly ?? h.length;
  const cell = (i) => (h[i] ? `<span class="mv${i + 1 === cur ? ' cur' : ''}" data-ply="${i + 1}">${esc(h[i])}</span>` : '<span class="mv"></span>');
  for (let i = 0; i < h.length; i += 2) html += `<div class="mrow"><span class="mno">${i / 2 + 1}.</span>${cell(i)}${cell(i + 1)}</div>`;
  $('play-moves').innerHTML = html;
  ($('play-moves').querySelector('.mv.cur') || $('play-moves').lastElementChild)?.scrollIntoView({ block: 'nearest' });
}
// ---------------------------------------------------------------- czat (online P2P i lichess)
const CHAT = [];
function addChat(who, text, mine, system) {
  text = String(text || '').slice(0, 200);
  if (!text) return;
  CHAT.push({ who, text, mine, system });
  const log = $('chat-log');
  log.insertAdjacentHTML('beforeend', `<div class="cm ${mine ? 'mine' : ''} ${system ? 'sys' : ''}">${system ? '' : `<b>${esc(who)}</b>`}<span>${esc(text)}</span></div>`);
  log.scrollTop = log.scrollHeight;
  if (!mine && !system) { A.sound.play('GenericNotify'); fx.pop(log.lastElementChild); }
}
async function sendChat(text) {
  text = text.trim();
  if (!text || !G.chess) return;
  if (G.mode === 'online') send({ t: 'chat', text });
  else if (G.mode === 'lichess') {
    const r = await liFetch(`/api/board/game/${G.liId}/chat`, { method: 'POST', body: new URLSearchParams({ room: 'player', text }) });
    if (!r.ok) { A.toast('Lichess nie przyjął wiadomości.'); return; }
    return; // lichess odeśle wiadomość w strumieniu (chatLine)
  } else return;
  addChat(A.profile().name || 'Ty', text, true);
}
function resetChat(on) {
  CHAT.length = 0;
  $('chat-log').innerHTML = '';
  $('play-chat').hidden = !on;
  if (on) addChat('', 'Czat z przeciwnikiem – bądź miły 🙂', false, true);
}

function beginGame({ mode, color, tc, oppName, oppAva, oppRating, myRating, event, elo, fen }) {
  const [base, inc] = String(tc || '0').split('+').map(Number);
  Object.assign(G, {
    chess: new Chess(fen || undefined), color, on: true, mode, last: null, tc: String(tc || '0'), queue: [], pendingUci: null, viewPly: null,
    clocks: base ? { w: base * 60000, b: base * 60000 } : null, inc: (inc || 0) * 1000,
    oppName, oppAva, oppRating, myRating, elo,
  });
  const me = A.profile().name || 'Ty';
  G.headers = { Event: event, White: color === 'w' ? me : oppName, Black: color === 'b' ? me : oppName, WhiteElo: color === 'w' ? myRating : oppRating, BlackElo: color === 'b' ? myRating : oppRating };
  $('play-setup').hidden = true; $('play-game').hidden = false; $('play-result').hidden = true;
  document.body.classList.remove('setup-open');
  $('play-takeback').hidden = mode !== 'bot' && mode !== 'custom';
  $('play-draw').hidden = false; $('play-resign').hidden = false;
  resetChat(mode === 'online' || mode === 'lichess');
  $('play-title').textContent = event;
  A.sound.play('GenericNotify');
  renderMoveList(); startTimer(); renderClocks(); view();
}
function afterMove() {
  G.viewPly = null;
  renderMoveList(); renderClocks(); view();
  const c = G.chess;
  if (c.isCheckmate()) return endGame(c.turn() === G.color ? 'loss' : 'win', 'Mat');
  if (c.isStalemate()) return endGame('draw', 'Pat');
  if (c.isThreefoldRepetition()) return endGame('draw', 'Trzykrotne powtórzenie');
  if (c.isInsufficientMaterial()) return endGame('draw', 'Za mało materiału');
  if (c.isDraw()) return endGame('draw', 'Zasada 50 ruchów');
  if ((G.mode === 'bot' || G.mode === 'career' || G.mode === 'custom') && c.turn() !== G.color) engineMove();
}
async function onUserMove(uci) {
  if (G.viewPly !== null && G.viewPly !== undefined) { G.viewPly = null; renderMoveList(); view(); return; }
  if (!G.on) { view(); return; }
  if (G.chess.turn() !== G.color) { view(); return; }
  if (G.mode === 'lichess') return lichessMove(uci);
  const mv = G.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  if (G.clocks) G.clocks[mv.color] += G.inc;
  G.last = [mv.from, mv.to];
  A.sound.forSan(mv.san);
  if (G.mode === 'online') send({ t: 'move', uci, clocks: G.clocks });
  afterMove();
}

// ---------------------------------------------------------------- silnik
async function configureEngine(elo) {
  const id = $('play-engine').value;
  await engine.setEngine(id);
  if (id === 'lc0') return { nodes: Math.max(1, Math.round((elo - 600) / 6)) };
  if (elo >= 1320) {
    engine._send('setoption name Skill Level value 20');
    engine._send('setoption name UCI_LimitStrength value true');
    engine._send(`setoption name UCI_Elo value ${Math.min(3190, elo)}`);
    return { movetime: 250 + Math.min(900, (elo - 1300) / 2) };
  }
  engine._send('setoption name UCI_LimitStrength value false');
  engine._send(`setoption name Skill Level value ${Math.max(0, Math.round(((elo - 250) / 1070) * 4))}`);
  return { depth: Math.max(1, Math.round(1 + (elo - 250) / 230)), blunder: Math.max(0, (1320 - elo) / 2400) };
}
async function engineMove() {
  if (!G.on || G.chess.turn() === G.color) return;
  const t0 = performance.now();
  let uci = null;
  if (G.engOpts.blunder && Math.random() < G.engOpts.blunder) {
    const ms = G.chess.moves({ verbose: true });
    const m = ms[Math.floor(Math.random() * ms.length)];
    uci = m.from + m.to + (m.promotion || '');
  } else {
    const res = await engine.analyse(G.chess.fen(), { depth: G.engOpts.depth, movetime: G.engOpts.movetime, nodes: G.engOpts.nodes });
    uci = res?.bestmove || res?.lines[0]?.pv?.[0];
  }
  const think = performance.now() - t0;
  if (think < 400) await sleep(400 - think);
  if (!G.on || !uci) return;
  const m = G.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  if (G.clocks) G.clocks[m.color] += G.inc;
  G.last = [m.from, m.to];
  A.sound.forSan(m.san);
  afterMove();
  runPremove();
}
function pickColor(v) { return v === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : v; }
async function startBotGame(bot, opts = {}) {
  const color = opts.color || pickColor($('bot-color').value);
  const p = A.profile();
  const mode = opts.mode || 'bot';
  G.engOpts = await configureEngine(bot.elo);
  G.lastSetup = { kind: mode, bot, color };
  beginGame({
    mode, color, tc: opts.tc ?? $('bot-tc').value, oppName: bot.name, oppAva: botAva(bot), oppRating: bot.elo, elo: bot.elo,
    myRating: mode === 'career' ? p.career.rating : p.rating, event: mode === 'career' ? `Kariera: ${bot.name} (${bot.elo})` : `${bot.name} (${bot.elo})`,
    fen: opts.fen,
  });
  if (G.chess.turn() !== color) engineMove();
}

// ---------------------------------------------------------------- koniec partii
async function endGame(res, reason) {
  if (!G.on) return;
  G.on = false;
  G.queue = [];
  clearInterval(G.timer);
  engine.stop();
  const result = res === 'draw' ? '1/2-1/2' : (res === 'win') === (G.color === 'w') ? '1-0' : '0-1';
  G.pgn = pgnOf(result);
  const score = res === 'win' ? 1 : res === 'draw' ? 0.5 : 0;
  const p = A.profile();
  let delta = 0, label = '';
  const elo = (mine, opp, k) => Math.round(k * (score - 1 / (1 + 10 ** ((opp - mine) / 400))));
  if (G.mode === 'bot' || G.mode === 'custom') { delta = elo(p.rating, G.elo, 24); p.rating += delta; label = 'Ranking z botami'; }
  if (G.mode === 'career') {
    delta = elo(p.career.rating, G.elo, 40); p.career.rating = Math.max(100, p.career.rating + delta);
    p.career.games++; if (res === 'win') p.career.wins++; p.career.best = Math.max(p.career.best, p.career.rating);
    label = `Kariera · ${rankOf(p.career.rating)}`;
  }
  if (G.mode === 'online') {
    const cat = categoryOf(G.tc);
    if (p.ratings[cat] !== undefined) { delta = elo(p.ratings[cat], G.oppRating || 1200, 32); p.ratings[cat] += delta; label = `Ranking ${cat}`; }
  }
  p.games = (p.games || 0) + 1;
  if (G.mode === 'bot' || G.mode === 'custom') A.pushRating('bots', p.rating);
  if (G.mode === 'career') A.pushRating('career', p.career.rating);
  if (G.mode === 'online' && p.ratings[categoryOf(G.tc)] !== undefined) A.pushRating(categoryOf(G.tc), p.ratings[categoryOf(G.tc)]);
  A.markActive();
  A.saveProfile(p);
  const games = (await idb.get('games')) || [];
  games.unshift({ id: Date.now().toString(36), date: new Date().toISOString().slice(0, 10), mode: G.mode, white: G.headers.White, black: G.headers.Black, result, tc: G.tc, pgn: G.pgn, me: G.color });
  await idb.set('games', games.slice(0, 300));
  A.sound.play(res === 'win' ? 'Confirmation' : res === 'loss' ? 'Error' : 'GenericNotify');
  for (const id of ['play-takeback', 'play-draw', 'play-resign']) $(id).hidden = true;
  showResult(res, reason, delta, label);
  renderClocks(); view();
}
function showResult(res, reason, delta, label) {
  const t = res === 'win' ? 'Wygrałeś!' : res === 'loss' ? 'Przegrałeś' : 'Remis';
  const say = res === 'win' ? 'Świetna wygrana! Przejrzyjmy ją razem, ruch po ruchu.' : res === 'loss' ? 'Nie poddawaj się – zobaczmy, gdzie partia się odwróciła.' : 'Wyrównana walka! Sprawdźmy kluczowe momenty.';
  const p = A.profile();
  const val = G.mode === 'career' ? p.career.rating : G.mode === 'online' ? p.ratings[categoryOf(G.tc)] : p.rating;
  $('play-result').hidden = false;
  $('play-result').innerHTML = `<div class="result-card">
    <div class="rc-title">${res === 'win' ? '🏆 ' : ''}${t}</div><div class="muted">${esc(reason)}</div>
    ${label ? `<div class="rc-rating"><b class="mono">${val}</b> <span class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : ''}${delta}</span><small>${esc(label)}</small></div>` : ''}
    ${A.catSays(say)}
    <button class="btn primary big" data-r="review">★ Przegląd partii</button>
    <div class="row"><button class="btn" data-r="new">Nowa partia</button><button class="btn" data-r="rematch">Rewanż</button></div>
  </div>`;
  fx.pop($('play-result').firstElementChild);
}

// ---------------------------------------------------------------- online (PeerJS)
const PREFIX = 'analiza-szachy-v1';
const NET = { peer: null, conn: null, role: null };
function loadPeer() {
  if (window.Peer) return Promise.resolve();
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'vendor/peerjs.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}
function send(msg) { try { NET.conn?.open && NET.conn.send(msg); } catch {} }
function netStatus(html) { $('online-status').innerHTML = html; }
function closeNet() { try { NET.conn?.close(); } catch {} try { NET.peer?.destroy(); } catch {} NET.peer = NET.conn = null; }
function openPeer(id) {
  return new Promise((resolve, reject) => {
    const peer = id ? new window.Peer(id, { debug: 0 }) : new window.Peer({ debug: 0 });
    const to = setTimeout(() => reject(new Error('timeout')), 12000);
    peer.on('open', () => { clearTimeout(to); resolve(peer); });
    peer.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}
function tryConnect(peer, id, ms = 3000) {
  return new Promise((resolve) => {
    const conn = peer.connect(id, { reliable: true });
    const to = setTimeout(() => { try { conn.close(); } catch {} resolve(null); }, ms);
    conn.on('open', () => { clearTimeout(to); resolve(conn); });
    conn.on('error', () => { clearTimeout(to); resolve(null); });
    peer.once?.('error', () => { clearTimeout(to); resolve(null); });
  });
}
function hello() {
  const p = A.profile();
  return { t: 'hello', name: p.name || 'Gracz', rating: p.ratings[categoryOf(NET.tc)] ?? 1200, tc: NET.tc };
}
function wire(conn, isHost) {
  NET.conn = conn;
  conn.on('data', (m) => onNet(m, isHost));
  conn.on('close', () => { if (G.on && G.mode === 'online') endGame('win', 'Przeciwnik opuścił partię'); netStatus('Połączenie zamknięte.'); });
  conn.send(hello());
}
function onNet(m, isHost) {
  if (m.t === 'hello') {
    NET.opp = m;
    if (isHost) {
      const myColor = Math.random() < 0.5 ? 'w' : 'b';
      send({ t: 'start', yourColor: myColor === 'w' ? 'b' : 'w', tc: NET.tc });
      startOnline(myColor, NET.tc);
    }
  } else if (m.t === 'start') {
    startOnline(m.yourColor, m.tc);
  } else if (m.t === 'move' && G.mode === 'online' && G.on) {
    const mv = G.chess.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
    if (m.clocks && G.clocks) G.clocks = m.clocks;
    G.last = [mv.from, mv.to];
    A.sound.forSan(mv.san);
    afterMove();
    runPremove();
  } else if (m.t === 'resign') endGame('win', 'Przeciwnik się poddał');
  else if (m.t === 'flag') endGame('win', 'Przeciwnikowi skończył się czas');
  else if (m.t === 'draw?') { if (confirm('Przeciwnik proponuje remis. Przyjąć?')) { send({ t: 'draw!' }); endGame('draw', 'Remis za zgodą'); } }
  else if (m.t === 'draw!') endGame('draw', 'Remis za zgodą');
  else if (m.t === 'chat') addChat(NET.opp?.name || 'Przeciwnik', m.text, false);
  else if (m.t === 'rematch?') { if (confirm('Przeciwnik chce rewanżu. Grać?')) send(hello()); }
}
function startOnline(color, tc) {
  const o = NET.opp || {};
  const p = A.profile();
  beginGame({ mode: 'online', color, tc, oppName: o.name || 'Przeciwnik', oppAva: 'cat.png', oppRating: o.rating, myRating: p.ratings[categoryOf(tc)], event: `Online ${tc.replace('+', ' + ')} (${categoryOf(tc)})` });
}
async function hostFriend() {
  NET.tc = $('online-tc').value;
  netStatus('Tworzę pokój…');
  closeNet();
  try {
    await loadPeer();
    const id = `${PREFIX}-g-${Math.random().toString(36).slice(2, 10)}`;
    NET.peer = await openPeer(id);
    const link = `${location.origin}${location.pathname}?join=${id.slice(PREFIX.length + 3)}&tc=${encodeURIComponent(NET.tc)}`;
    netStatus(`Wyślij ten link znajomemu – gra zacznie się, gdy go otworzy:<div class="link-box"><input class="mono" readonly value="${esc(link)}"><button class="btn" id="copy-link">Kopiuj</button></div><span class="muted">Strona musi być otwarta pod tym samym adresem (najlepiej wersja z internetu).</span>`);
    $('copy-link').onclick = async () => { try { await navigator.clipboard.writeText(link); A.toast('Skopiowano link.'); } catch { prompt('Skopiuj link:', link); } };
    NET.peer.on('connection', (conn) => conn.on('open', () => { netStatus('Znajomy dołączył!'); wire(conn, true); }));
  } catch (e) { netStatus('Nie udało się utworzyć pokoju: ' + esc(e.type || e.message)); }
}
async function joinFriend(short, tc) {
  NET.tc = tc || '10+0';
  A.showTab('play'); setPlaySub('online');
  netStatus('Łączę z pokojem znajomego…');
  closeNet();
  try {
    await loadPeer();
    NET.peer = await openPeer();
    const conn = await tryConnect(NET.peer, `${PREFIX}-g-${short}`, 8000);
    if (!conn) return netStatus('Nie mogę połączyć – pokój nie istnieje albo znajomy zamknął stronę.');
    netStatus('Połączono!');
    wire(conn, false);
  } catch (e) { netStatus('Błąd połączenia: ' + esc(e.type || e.message)); }
}
async function matchmake() {
  NET.tc = $('online-tc').value;
  const key = NET.tc.replace('+', '-');
  closeNet();
  netStatus(`Szukam przeciwnika ${NET.tc.replace('+', ' + ')}… <button class="btn" id="mm-cancel">Anuluj</button>`);
  $('mm-cancel').onclick = () => { closeNet(); netStatus('Anulowano.'); };
  try {
    await loadPeer();
    // 1) spróbuj dołączyć do czekającego gracza
    const me = await openPeer();
    NET.peer = me;
    for (let k = 0; k < 6; k++) {
      if (NET.peer !== me) return;
      const conn = await tryConnect(me, `${PREFIX}-lobby-${key}-${k}`, 2500);
      if (conn) { netStatus('Znaleziono przeciwnika!'); wire(conn, false); return; }
    }
    // 2) nikt nie czeka – zajmij wolne miejsce w poczekalni i czekaj
    me.destroy();
    for (let k = 0; k < 6; k++) {
      try {
        const host = await openPeer(`${PREFIX}-lobby-${key}-${k}`);
        NET.peer = host;
        netStatus(`Czekam na przeciwnika ${NET.tc.replace('+', ' + ')}… (możesz też wysłać komuś link) <button class="btn" id="mm-cancel">Anuluj</button>`);
        $('mm-cancel').onclick = () => { closeNet(); netStatus('Anulowano.'); };
        host.on('connection', (conn) => {
          if (NET.conn) { conn.on('open', () => conn.close()); return; }
          conn.on('open', () => { netStatus('Znaleziono przeciwnika!'); wire(conn, true); });
        });
        return;
      } catch (e) { if (e.type !== 'unavailable-id') throw e; }
    }
    netStatus('Poczekalnia jest pełna – spróbuj za chwilę.');
  } catch (e) { netStatus('Błąd: ' + esc(e.type || e.message)); }
}

// ---------------------------------------------------------------- lichess (Board API)
const LI = 'https://lichess.org';
async function liFetch(path, opts = {}) { return fetch(LI + path, { ...opts, headers: { Authorization: 'Bearer ' + A.lichessToken(), ...(opts.headers || {}) } }); }
async function* ndjson(resp, signal) {
  const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (!signal?.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) { try { yield JSON.parse(line); } catch {} } }
  }
}
function liStatus(t) { $('li-play-status').innerHTML = t; }
async function lichessStart(kind) {
  if (!A.lichessToken()) { liStatus('Najpierw zaloguj się przez lichess (Ustawienia → Konto).'); return; }
  const [t, inc] = $('li-tc').value.split('+').map(Number);
  const ctrl = new AbortController(); G.liAbort?.abort(); G.liAbort = ctrl;
  liStatus('Łączę z lichess…');
  const ev = await liFetch('/api/stream/event', { signal: ctrl.signal });
  if (!ev.ok) { liStatus(`Lichess odmówił (${ev.status}). Zaloguj się ponownie przez lichess.`); return; }
  (async () => { for await (const e of ndjson(ev, ctrl.signal)) if (e.type === 'gameStart') { runLichessGame(e.game.gameId || e.game.id, ctrl); break; } })().catch(() => {});
  try {
    const clock = { 'clock.limit': String(t * 60), 'clock.increment': String(inc || 0), color: $('li-color').value };
    if (kind === 'ai') {
      const r = await liFetch('/api/challenge/ai', { method: 'POST', body: new URLSearchParams({ level: $('li-ai').value, ...clock }), signal: ctrl.signal });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
      liStatus('Startuje partia z komputerem lichess…');
    } else if (kind === 'friend') {
      const user = $('li-friend').value.trim(); if (!user) return liStatus('Wpisz nick przeciwnika.');
      const r = await liFetch('/api/challenge/' + encodeURIComponent(user), { method: 'POST', body: new URLSearchParams({ ...clock, rated: 'false' }), signal: ctrl.signal });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
      liStatus(`Wyzwanie wysłane do ${esc(user)} – czekam…`);
    } else {
      liStatus(`Szukam przeciwnika na lichess (${t}+${inc || 0})… <button class="btn" id="li-cancel">Anuluj</button>`);
      $('li-cancel').onclick = () => { ctrl.abort(); liStatus('Anulowano.'); };
      liFetch('/api/board/seek', { method: 'POST', body: new URLSearchParams({ time: String(t), increment: String(inc || 0), rated: $('li-rated').checked ? 'true' : 'false', variant: 'standard' }), signal: ctrl.signal })
        .then(async (r) => { if (!r.ok) liStatus('Lichess: ' + esc((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status)); }).catch(() => {});
    }
  } catch (e) { liStatus('Błąd: ' + esc(e.message)); }
}
async function runLichessGame(id, ctrl) {
  const r = await liFetch(`/api/board/game/stream/${id}`, { signal: ctrl.signal });
  if (!r.ok) { liStatus('Nie mogę połączyć z partią.'); return; }
  for await (const e of ndjson(r, ctrl.signal)) {
    if (e.type === 'chatLine') {
      if (e.room === 'player') {
        const me = (await A.lichessUser()).toLowerCase();
        const mine = (e.username || '').toLowerCase() === me;
        addChat(mine ? (A.profile().name || 'Ty') : e.username, e.text, mine, e.username === 'lichess');
      }
      continue;
    }
    let state = e;
    if (e.type === 'gameFull') {
      const me = (await A.lichessUser()).toLowerCase();
      const color = e.white.id === me ? 'w' : 'b';
      const opp = color === 'w' ? e.black : e.white;
      beginGame({ mode: 'lichess', color, tc: '0', oppName: opp.name || (opp.aiLevel ? `Stockfish ${opp.aiLevel}` : 'Przeciwnik'), oppAva: 'cat.png', oppRating: opp.rating, myRating: (color === 'w' ? e.white : e.black).rating, event: 'Partia na lichess' });
      G.headers.Site = 'https://lichess.org/' + id;
      G.liId = id;
      $('play-title').innerHTML = `Lichess vs ${esc(G.oppName)} <a href="https://lichess.org/${id}" target="_blank" rel="noopener">↗</a>`;
      state = e.state;
    }
    if (state.type === 'gameState') {
      const prevMoves = G.chess.history({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ''));
      const srv = (state.moves || '').split(' ').filter(Boolean);
      const same = srv.length === prevMoves.length && srv.every((u, i) => u === prevMoves[i]);
      if (!same) {
        G.chess = new Chess();
        let last = null;
        for (const u of srv) last = G.chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
        G.last = last ? [last.from, last.to] : null;
        // dźwięk tylko dla nowego ruchu przeciwnika (własny już zagrał)
        if (last && srv.length > prevMoves.length && last.color !== G.color) A.sound.forSan(last.san);
      }
      G.clocks = { w: state.wtime, b: state.btime };
      renderMoveList(); renderClocks(); view();
      if (!same && G.chess.turn() === G.color) runPremove();
      if (state.status && !['started', 'created'].includes(state.status)) {
        const res = !state.winner ? 'draw' : state.winner === (G.color === 'w' ? 'white' : 'black') ? 'win' : 'loss';
        endGame(res, { mate: 'Mat', resign: 'Poddanie', outoftime: 'Na czas', draw: 'Remis', stalemate: 'Pat', aborted: 'Przerwana' }[state.status] || state.status);
        break;
      }
    }
  }
}
async function lichessMove(uci) {
  let mv;
  try { mv = G.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { view(); return; }
  G.last = [mv.from, mv.to];
  G.pendingUci = uci;
  A.sound.forSan(mv.san);
  renderMoveList(); renderClocks(); view();
  const r = await liFetch(`/api/board/game/${G.liId}/move/${uci}`, { method: 'POST' });
  if (!r.ok) {
    A.sound.play('Error'); A.toast('Lichess odrzucił ruch.');
    G.chess.undo(); G.pendingUci = null; G.queue = []; renderMoveList(); view();
  }
}

// ---------------------------------------------------------------- UI
let selectedBot = BOTS[4];
function renderBots() {
  const b = selectedBot;
  $('bot-preview').innerHTML = `<div class="bot-hero"><img src="${botAva(b)}" alt="" onerror="this.src='cat.png'"><div class="bubble">${esc(b.say)}</div></div><div class="bot-name">${esc(b.name)} <span class="mono">${b.elo}</span></div>`;
  $('bot-cats').innerHTML = GROUPS.map(([g, a, z]) => `<div class="bot-group"><div class="bg-head"><b>${g}</b><small>${z - a} boty</small></div>
    <div class="bot-grid">${BOTS.slice(a, z).map((bt) => `<button class="bot ${bt === b ? 'on' : ''}" data-bot="${BOTS.indexOf(bt)}" title="${esc(bt.name)} ${bt.elo}"><img src="${botAva(bt)}" alt="" onerror="this.src='cat.png'"><span>${bt.elo}</span></button>`).join('')}</div></div>`).join('');
}
function renderCareer() {
  const p = A.profile();
  const c = p.career;
  const opp = { ...botForElo(c.rating), elo: c.rating };
  const next = RANKS.find(([min]) => min > c.rating);
  const prev = [...RANKS].reverse().find(([min]) => min <= c.rating);
  const pct = next ? ((c.rating - prev[0]) / (next[0] - prev[0])) * 100 : 100;
  $('career-box').innerHTML = `<div class="career-top"><div><small class="eyebrow" style="margin:0">Twoja ranga</small><div class="career-rank">${esc(rankOf(c.rating))}</div></div><div class="career-rating mono">${c.rating}</div></div>
    <div class="bar"><div style="width:${pct}%"></div></div>
    <div class="muted">${next ? `Do rangi „${next[1]}” brakuje ${next[0] - c.rating} pkt.` : 'Najwyższa ranga!'} · partie ${c.games} · wygrane ${c.wins} · rekord ${c.best}</div>
    <div class="career-opp"><img src="${botAva(opp)}" alt=""><div>${A.catSays(`Następny rywal: <b>${esc(opp.name)}</b> grający na Twoim poziomie (${c.rating}). Wygrywaj, żeby awansować – każdy kolejny przeciwnik będzie silniejszy!`)}</div></div>`;
}
function setPlaySub(s) {
  if (!G.on) showSetup();
  for (const b of $('play-sub').children) b.classList.toggle('active', b.dataset.sub === s);
  for (const id of ['bots', 'career', 'online', 'lichess', 'engine']) $('play-' + id + '-pane').hidden = id !== s;
  if (s === 'career') renderCareer();
  if (s === 'online') renderOnlineRatings();
  A.store.set('playSub', s);
}
function renderOnlineRatings() {
  const r = A.profile().ratings;
  $('online-ratings').innerHTML = `<span class="pill accent">Bullet ${r.bullet}</span><span class="pill accent">Blitz ${r.blitz}</span><span class="pill accent">Rapid ${r.rapid}</span>`;
}
function showSetup() {
  document.body.classList.add('setup-open');
  $('play-setup').hidden = false; $('play-game').hidden = true; $('play-result').hidden = true;
  if (G.chess && !G.on) { G.chess = null; A.S.train = null; A.render(); }
}
export function onShowPlayTab(name) {
  if (name !== 'play') return;
  if (G.on && G.chess) view();      // trwająca partia – wróć do niej
  else showSetup();                  // zakończona – od razu wybór nowej gry
}
export function initPlay(api) {
  A = api;
  const sel = $('play-engine');
  sel.innerHTML = $('review-engine').innerHTML;
  sel.value = A.store.get('playEngine', sel.value);
  sel.onchange = () => A.store.set('playEngine', sel.value);
  const eloL = (v) => `${v} · ${v < 800 ? 'początkujący' : v < 1200 ? 'amator' : v < 1600 ? 'klubowy' : v < 2000 ? 'mocny klubowy' : v < 2400 ? 'mistrz' : 'arcymistrz'}`;
  $('play-elo').value = A.store.get('playElo', 1200);
  $('play-elo-l').textContent = eloL(+$('play-elo').value);
  $('play-elo').oninput = () => { $('play-elo-l').textContent = eloL(+$('play-elo').value); A.store.set('playElo', +$('play-elo').value); };
  $('play-sub').onclick = (e) => { const s = e.target.dataset.sub; if (s) setPlaySub(s); };
  $('bot-cats').onclick = (e) => { const b = e.target.closest('[data-bot]'); if (b) { selectedBot = BOTS[+b.dataset.bot]; A.store.set('bot', +b.dataset.bot); renderBots(); } };
  $('bot-start').onclick = () => startBotGame(selectedBot);
  $('career-start').onclick = () => { const c = A.profile().career; startBotGame({ ...botForElo(c.rating), elo: c.rating }, { mode: 'career', tc: $('career-tc').value, color: pickColor('r') }); };
  $('play-moves').onclick = (e) => {
    const m = e.target.closest('[data-ply]'); if (!m || !G.chess) return;
    const n = G.chess.history().length, v = +m.dataset.ply;
    G.viewPly = v >= n ? null : v;
    renderMoveList(); view();
  };
  $('chat-form').onsubmit = (e) => { e.preventDefault(); sendChat($('chat-input').value); $('chat-input').value = ''; };
  $('chat-quick').onclick = (e) => { const b = e.target.closest('button'); if (b) sendChat(b.textContent); };
  $('play-start').onclick = () => { const elo = +$('play-elo').value; startBotGame({ ...botForElo(elo), name: `Stockfish ${elo}`, elo }, { mode: 'custom', color: pickColor($('play-color').value), tc: $('play-tc').value }); };
  $('online-friend').onclick = hostFriend;
  $('online-seek').onclick = matchmake;
  $('play-resign').onclick = async () => {
    if (!G.on || !confirm('Poddać partię?')) return;
    if (G.mode === 'lichess') { await liFetch(`/api/board/game/${G.liId}/resign`, { method: 'POST' }); return; }
    if (G.mode === 'online') send({ t: 'resign' });
    endGame('loss', 'Poddanie');
  };
  $('play-draw').onclick = () => { if (G.on && G.mode === 'online') { send({ t: 'draw?' }); A.toast('Zaproponowano remis.'); } else if (G.on) A.toast('Bot nie przyjmuje remisów 😺'); };
  $('play-takeback').onclick = () => {
    if (!G.on || !['bot', 'custom'].includes(G.mode)) return;
    G.chess.undo(); if (G.chess.turn() !== G.color) G.chess.undo();
    const h = G.chess.history({ verbose: true }); const l = h[h.length - 1];
    G.last = l ? [l.from, l.to] : null;
    renderMoveList(); view();
  };
  $('play-result').addEventListener('click', (e) => {
    const r = e.target.closest('[data-r]')?.dataset.r;
    if (!r) return;
    if (r === 'review') { A.S.train = null; A.reviewPgn(G.pgn); }
    if (r === 'new') { showSetup(); closeNet(); if (G.mode === 'career') renderCareer(); }
    if (r === 'rematch') {
      if (G.mode === 'online') { send({ t: 'rematch?' }); A.toast('Wysłano propozycję rewanżu.'); }
      else if (G.mode === 'lichess') lichessStart('ai');
      else if (G.lastSetup) startBotGame(G.lastSetup.bot, { mode: G.lastSetup.kind, color: G.lastSetup.color === 'w' ? 'b' : 'w', tc: G.tc });
    }
  });
  for (const b of document.querySelectorAll('[data-li]')) b.onclick = () => lichessStart(b.dataset.li);
  selectedBot = BOTS[A.store.get('bot', 4)] || BOTS[4];
  renderBots();
  setPlaySub(A.store.get('playSub', 'bots'));
  const q = new URLSearchParams(location.search);
  if (q.get('join')) { const j = q.get('join'), tc = q.get('tc'); history.replaceState(null, '', location.pathname); joinFriend(j, tc); }
}
/** „Graj od tej pozycji”: gracz prowadzi stronę, która jest na ruchu, przeciwnik = wybrany bot. */
export function playFromFen(fen) {
  try { new Chess(fen); } catch { return A.toast('Niepoprawna pozycja.'); }
  const c = new Chess(fen);
  if (c.isGameOver()) return A.toast('W tej pozycji partia jest już zakończona.');
  A.showTab('play'); setPlaySub('bots');
  startBotGame(selectedBot, { color: c.turn(), tc: '0', fen });
}
export function quickPlay(tc) { A.showTab('play'); setPlaySub('online'); $('online-tc').value = tc; matchmake(); }
export function playBots() { A.showTab('play'); setPlaySub('bots'); }
export function playCareer() { A.showTab('play'); setPlaySub('career'); }
export function playFriend() { A.showTab('play'); setPlaySub('online'); }

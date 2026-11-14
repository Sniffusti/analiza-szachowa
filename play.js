// Graj: partia z silnikiem (wybór rankingu) oraz partie na lichess (Board API, logowanie przez lichess).
import { Chess } from './vendor/chess.js';
import { Engine, WASM_ID } from './engine.js';
import * as fx from './fx.js';

let A;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const engine = new Engine('play');

const G = { chess: null, color: 'w', on: false, mode: null, clocks: null, timer: null, last: null, inc: 0, lichess: null };

// ---------------------------------------------------------------- wspólne
function view(extra = {}) {
  A.S.train = {
    fen: G.chess.fen(), lastMove: G.last, orientation: G.color === 'w' ? 'white' : 'black',
    hideEval: true, shapes: [], onMove: onUserMove, ...extra,
  };
  A.render();
}
function fmtClock(ms) {
  if (ms === null || ms === undefined) return '–';
  const s = Math.max(0, ms) / 1000;
  if (s < 20) return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function renderClocks() {
  const box = $('play-clocks');
  if (!G.clocks) { box.hidden = true; return; }
  box.hidden = false;
  const turn = G.chess.turn();
  const me = G.color, opp = me === 'w' ? 'b' : 'w';
  box.innerHTML = `<div class="clock ${turn === opp && G.on ? 'run' : ''}"><span>${esc(G.oppName)}</span><b>${fmtClock(G.clocks[opp])}</b></div>
    <div class="clock me ${turn === me && G.on ? 'run' : ''}"><span>${esc(A.profile().name || 'Ty')}</span><b>${fmtClock(G.clocks[me])}</b></div>`;
}
function startTimer() {
  clearInterval(G.timer);
  if (!G.clocks || G.mode !== 'engine') return;
  let lastT = performance.now();
  G.timer = setInterval(() => {
    const now = performance.now();
    if (G.on) {
      const t = G.chess.turn();
      G.clocks[t] -= now - lastT;
      if (G.clocks[t] <= 0) { G.clocks[t] = 0; endGame(t === G.color ? 'loss' : 'win', 'Na czas'); }
    }
    lastT = now;
    renderClocks();
  }, 100);
}
function movesSan() { return G.chess.history(); }
function pgnOf(result) {
  const h = G.headers;
  const c = new Chess();
  for (const san of movesSan()) c.move(san);
  c.setHeader('Event', h.Event); c.setHeader('Site', h.Site || 'Analiza');
  c.setHeader('Date', new Date().toISOString().slice(0, 10).replace(/-/g, '.'));
  c.setHeader('White', h.White); c.setHeader('Black', h.Black);
  if (h.WhiteElo) c.setHeader('WhiteElo', String(h.WhiteElo));
  if (h.BlackElo) c.setHeader('BlackElo', String(h.BlackElo));
  c.setHeader('Result', result);
  return c.pgn();
}
function renderMoveList() {
  const h = movesSan();
  let html = '';
  for (let i = 0; i < h.length; i += 2) html += `<div class="mrow"><span class="mno">${i / 2 + 1}.</span><span class="mv">${esc(h[i])}</span><span class="mv">${esc(h[i + 1] || '')}</span></div>`;
  $('play-moves').innerHTML = html;
  $('play-moves').lastElementChild?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------- partia z silnikiem
function eloLabel(v) {
  const n = +v;
  const lvl = n < 800 ? 'początkujący' : n < 1200 ? 'amator' : n < 1600 ? 'klubowy' : n < 2000 ? 'mocny klubowy' : n < 2400 ? 'mistrz' : 'arcymistrz';
  return `${n} · ${lvl}`;
}
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
  const skill = Math.max(0, Math.round(((elo - 400) / 920) * 4));
  engine._send(`setoption name Skill Level value ${skill}`);
  return { depth: Math.max(1, Math.round(1 + (elo - 400) / 230)), blunder: Math.max(0, (1320 - elo) / 2600) };
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
  if (think < 350) await sleep(350 - think);
  if (!G.on || !uci) return;
  const m = G.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  if (G.clocks) G.clocks[m.color] += G.inc;
  G.last = [m.from, m.to];
  A.sound.forSan(m.san);
  afterMove();
}
function afterMove() {
  renderMoveList();
  renderClocks();
  view();
  const c = G.chess;
  if (c.isCheckmate()) return endGame(c.turn() === G.color ? 'loss' : 'win', 'Mat');
  if (c.isStalemate()) return endGame('draw', 'Pat');
  if (c.isThreefoldRepetition()) return endGame('draw', 'Trzykrotne powtórzenie');
  if (c.isInsufficientMaterial()) return endGame('draw', 'Za mało materiału');
  if (c.isDraw()) return endGame('draw', 'Zasada 50 ruchów');
  if (G.mode === 'engine' && c.turn() !== G.color) engineMove();
}
async function onUserMove(uci, m) {
  if (!G.on || G.chess.turn() !== G.color) { view(); return; }
  if (G.mode === 'lichess') return lichessMove(uci);
  const mv = G.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  if (G.clocks) G.clocks[mv.color] += G.inc;
  G.last = [mv.from, mv.to];
  A.sound.forSan(mv.san);
  afterMove();
}
async function startEngineGame(sameAsBefore) {
  const elo = +$('play-elo').value;
  let color = $('play-color').value;
  if (sameAsBefore && G.lastColor) color = G.lastColor === 'w' ? 'b' : 'w';
  if (color === 'r') color = Math.random() < 0.5 ? 'w' : 'b';
  const [base, inc] = $('play-tc').value.split('+').map(Number);
  Object.assign(G, {
    chess: new Chess(), color, lastColor: color, on: true, mode: 'engine', last: null,
    clocks: base ? { w: base * 60000, b: base * 60000 } : null, inc: (inc || 0) * 1000,
    oppName: `Stockfish ${elo}`, elo,
  });
  const me = A.profile().name || 'Ty';
  G.headers = { Event: `Partia z silnikiem (${elo})`, White: color === 'w' ? me : G.oppName, Black: color === 'b' ? me : G.oppName, WhiteElo: color === 'w' ? A.profile().rating : elo, BlackElo: color === 'b' ? A.profile().rating : elo };
  G.engOpts = await configureEngine(elo);
  $('play-setup').hidden = true; $('play-game').hidden = false; $('play-result').hidden = true;
  $('play-title').textContent = `Ty vs ${G.oppName}`;
  A.sound.play('GenericNotify');
  renderMoveList(); startTimer(); renderClocks(); view();
  if (color === 'b') engineMove();
}
function endGame(res, reason) {
  if (!G.on) return;
  G.on = false;
  clearInterval(G.timer);
  engine.stop();
  const result = res === 'draw' ? '1/2-1/2' : (res === 'win') === (G.color === 'w') ? '1-0' : '0-1';
  G.pgn = pgnOf(result);
  let delta = 0;
  if (G.mode === 'engine') {
    const p = A.profile();
    const exp = 1 / (1 + 10 ** ((G.elo - p.rating) / 400));
    delta = Math.round(32 * ((res === 'win' ? 1 : res === 'draw' ? 0.5 : 0) - exp));
    p.rating += delta; p.games = (p.games || 0) + 1;
    A.saveProfile(p);
  }
  A.sound.play(res === 'win' ? 'Confirmation' : res === 'loss' ? 'Error' : 'GenericNotify');
  showResult(res, reason, delta);
  renderClocks(); view();
}
function showResult(res, reason, delta) {
  const t = res === 'win' ? 'Wygrałeś!' : res === 'loss' ? 'Przegrałeś' : 'Remis';
  const say = res === 'win' ? 'Świetna wygrana! Przejrzyjmy ją razem, ruch po ruchu.' : res === 'loss' ? 'Nie poddawaj się – zobaczmy, gdzie partia się odwróciła.' : 'Wyrównana walka! Sprawdźmy kluczowe momenty.';
  const p = A.profile();
  $('play-result').hidden = false;
  $('play-result').innerHTML = `<div class="result-card">
    <div class="rc-title">${res === 'win' ? '🏆 ' : ''}${t}</div><div class="muted">${esc(reason)}</div>
    ${G.mode === 'engine' ? `<div class="rc-rating"><b class="mono">${p.rating}</b> <span class="${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : ''}${delta}</span><small>Twój ranking z silnikiem</small></div>` : ''}
    ${A.catSays(say)}
    <button class="btn primary big" data-r="review">★ Przegląd partii</button>
    <div class="row"><button class="btn" data-r="new">Nowa partia</button><button class="btn" data-r="rematch">Rewanż</button></div>
  </div>`;
  fx.pop($('play-result').firstElementChild);
}

// ---------------------------------------------------------------- lichess (Board API)
const LI = 'https://lichess.org';
function token() { return A.lichessToken(); }
async function liFetch(path, opts = {}) {
  return fetch(LI + path, { ...opts, headers: { Authorization: 'Bearer ' + token(), ...(opts.headers || {}) } });
}
async function* ndjson(resp, signal) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (!signal?.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (line) { try { yield JSON.parse(line); } catch {} }
    }
  }
}
function liStatus(t) { $('li-play-status').innerHTML = t; }

async function lichessStart(kind) {
  if (!token()) { liStatus('Najpierw zaloguj się przez lichess (Ustawienia → Konto).'); return; }
  const [t, inc] = $('li-tc').value.split('+').map(Number);
  const ctrl = new AbortController();
  G.liAbort?.abort(); G.liAbort = ctrl;
  liStatus('Łączę z lichess…');
  // nasłuch zdarzeń konta – gameStart
  const ev = await liFetch('/api/stream/event', { signal: ctrl.signal });
  if (!ev.ok) { liStatus(`Lichess odmówił (${ev.status}). Zaloguj się ponownie przez lichess – potrzebne uprawnienie do gry.`); return; }
  (async () => {
    for await (const e of ndjson(ev, ctrl.signal)) {
      if (e.type === 'gameStart') { runLichessGame(e.game.gameId || e.game.id, ctrl); break; }
    }
  })().catch(() => {});
  try {
    if (kind === 'ai') {
      const body = new URLSearchParams({ level: $('li-ai').value, 'clock.limit': String(t * 60), 'clock.increment': String(inc || 0), color: $('li-color').value });
      const r = await liFetch('/api/challenge/ai', { method: 'POST', body, signal: ctrl.signal });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
      liStatus('Startuje partia z Stockfishem lichess…');
    } else if (kind === 'friend') {
      const user = $('li-friend').value.trim();
      if (!user) return liStatus('Wpisz nick przeciwnika.');
      const body = new URLSearchParams({ 'clock.limit': String(t * 60), 'clock.increment': String(inc || 0), color: $('li-color').value, rated: 'false' });
      const r = await liFetch('/api/challenge/' + encodeURIComponent(user), { method: 'POST', body, signal: ctrl.signal });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status);
      liStatus(`Wyzwanie wysłane do ${esc(user)} – czekam na akceptację…`);
    } else {
      liStatus(`Szukam przeciwnika (${t}+${inc || 0})… <button class="btn" id="li-cancel">Anuluj</button>`);
      $('li-cancel').onclick = () => { ctrl.abort(); liStatus('Anulowano.'); };
      const body = new URLSearchParams({ time: String(t), increment: String(inc || 0), rated: $('li-rated').checked ? 'true' : 'false', variant: 'standard' });
      liFetch('/api/board/seek', { method: 'POST', body, signal: ctrl.signal }).then(async (r) => {
        if (!r.ok) liStatus('Lichess: ' + esc((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status) + ' (Board API pozwala na tempo rapid i wolniejsze).');
      }).catch(() => {});
    }
  } catch (e) { liStatus('Błąd: ' + esc(e.message)); }
}

async function runLichessGame(id, ctrl) {
  const r = await liFetch(`/api/board/game/stream/${id}`, { signal: ctrl.signal });
  if (!r.ok) { liStatus('Nie mogę połączyć z partią.'); return; }
  G.mode = 'lichess'; G.liId = id; G.on = true;
  $('play-setup').hidden = true; $('play-game').hidden = false; $('play-result').hidden = true;
  A.sound.play('GenericNotify');
  for await (const e of ndjson(r, ctrl.signal)) {
    let state = e;
    if (e.type === 'gameFull') {
      const me = (await A.lichessUser()).toLowerCase();
      G.color = e.white.id === me ? 'w' : 'b';
      const opp = G.color === 'w' ? e.black : e.white;
      G.oppName = opp.name || opp.id || (opp.aiLevel ? `Stockfish poziom ${opp.aiLevel}` : 'Przeciwnik');
      G.headers = { Event: 'Partia na lichess', Site: 'https://lichess.org/' + id, White: e.white.name || e.white.id || 'AI', Black: e.black.name || e.black.id || 'AI', WhiteElo: e.white.rating, BlackElo: e.black.rating };
      $('play-title').innerHTML = `Lichess: Ty vs ${esc(G.oppName)} <a href="https://lichess.org/${id}" target="_blank" rel="noopener">↗</a>`;
      state = e.state;
    }
    if (state.type === 'gameState') {
      const prevLen = G.chess ? G.chess.history().length : 0;
      G.chess = new Chess();
      let last = null;
      for (const u of (state.moves || '').split(' ').filter(Boolean)) last = G.chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      G.last = last ? [last.from, last.to] : null;
      if (last && G.chess.history().length > prevLen) A.sound.forSan(last.san);
      G.clocks = { w: state.wtime, b: state.btime };
      renderMoveList(); renderClocks(); view();
      if (state.status && state.status !== 'started' && state.status !== 'created') {
        const res = !state.winner ? 'draw' : state.winner === (G.color === 'w' ? 'white' : 'black') ? 'win' : 'loss';
        const reasons = { mate: 'Mat', resign: 'Poddanie', outoftime: 'Na czas', draw: 'Remis', stalemate: 'Pat', timeout: 'Opuszczenie partii', aborted: 'Przerwana' };
        endGame(res, reasons[state.status] || state.status);
        break;
      }
    }
  }
}
async function lichessMove(uci) {
  view(); // cofnij do stanu z serwera, prawdziwy ruch przyjdzie strumieniem
  const r = await liFetch(`/api/board/game/${G.liId}/move/${uci}`, { method: 'POST' });
  if (!r.ok) { A.sound.play('Error'); A.toast('Lichess odrzucił ruch.'); }
}

// ---------------------------------------------------------------- UI
export function onShowPlayTab(name) {
  if (name === 'play' && G.chess) view();
}
export function initPlay(api) {
  A = api;
  const sel = $('play-engine');
  sel.innerHTML = $('review-engine').innerHTML;
  sel.value = A.store.get('playEngine', sel.value);
  $('play-elo').value = A.store.get('playElo', 1200);
  $('play-elo-l').textContent = eloLabel($('play-elo').value);
  $('play-elo').oninput = () => { $('play-elo-l').textContent = eloLabel($('play-elo').value); A.store.set('playElo', +$('play-elo').value); };
  sel.onchange = () => A.store.set('playEngine', sel.value);
  $('play-sub').onclick = (e) => {
    const s = e.target.dataset.sub; if (!s) return;
    for (const b of $('play-sub').children) b.classList.toggle('active', b.dataset.sub === s);
    $('play-engine-pane').hidden = s !== 'engine'; $('play-lichess-pane').hidden = s !== 'lichess';
  };
  $('play-start').onclick = () => startEngineGame(false);
  $('play-resign').onclick = async () => {
    if (!G.on || !confirm('Poddać partię?')) return;
    if (G.mode === 'lichess') { await liFetch(`/api/board/game/${G.liId}/resign`, { method: 'POST' }); return; }
    endGame('loss', 'Poddanie');
  };
  $('play-takeback').onclick = () => {
    if (!G.on || G.mode !== 'engine') return;
    G.chess.undo(); if (G.chess.turn() !== G.color) G.chess.undo();
    const h = G.chess.history({ verbose: true }); const l = h[h.length - 1];
    G.last = l ? [l.from, l.to] : null;
    renderMoveList(); view();
  };
  $('play-result').addEventListener('click', (e) => {
    const r = e.target.closest('[data-r]')?.dataset.r;
    if (!r) return;
    if (r === 'review') { A.S.train = null; A.reviewPgn(G.pgn); }
    if (r === 'new') { $('play-setup').hidden = false; $('play-game').hidden = true; G.chess = null; A.S.train = null; A.render(); }
    if (r === 'rematch') { if (G.mode === 'engine') startEngineGame(true); else lichessStart('ai'); }
  });
  for (const b of document.querySelectorAll('[data-li]')) b.onclick = () => lichessStart(b.dataset.li);
}

// Funkcje w stylu ChessBase: przygotowanie do przeciwnika, zgadnij ruch, szukanie pozycji/struktury/materiału,
// raport otwarcia z baz PGN (i lichess).
import { Chess } from './vendor/chess.js';
import { idb } from './store.js';
import { splitGames, parseHeaders, mainlineSans, buildGame } from './pgn.js';
import { Engine, WASM_ID } from './engine.js';
import * as C from './classify.js';
import * as fx from './fx.js';

let A;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const epd = (f) => f.split(' ').slice(0, 4).join(' ');
const tick = () => new Promise((r) => setTimeout(r, 0));
const pct = (x) => (x == null || isNaN(x) ? '–' : Math.round(x) + '%');
const FIG = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘' };
const fig = (san) => (FIG[san[0]] ? FIG[san[0]] + esc(san.slice(1)) : esc(san));

function setSub(sub) {
  for (const b of $('base-sub').children) b.classList.toggle('active', b.dataset.sub === sub);
  for (const p of document.querySelectorAll('.base-pane')) p.hidden = p.id !== 'base-' + sub;
  A.store.set('baseSub', sub);
  if (sub === 'search' || sub === 'report') refreshPosInfo();
}
export function onShowBaseTab(name) {
  if (name === 'base') { refreshPosInfo(); if (GM.on && !$('base-guess').hidden) gmView(); }
}

// ================================================================ 1. Przygotowanie do przeciwnika
async function prepare() {
  const site = $('op-site').value, user = $('op-user').value.trim();
  if (!user) return A.toast('Wpisz nick przeciwnika.');
  const st = (t) => ($('op-status').textContent = t);
  const box = $('op-report');
  box.innerHTML = '';
  try {
    const pgns = await A.fetchUserPgns(site, user, +$('op-count').value, st);
    st(`Analizuję ${pgns.length} partii…`);
    const u = user.toLowerCase();
    const side = { w: { n: 0, s: 0, ops: {}, first: {} }, b: { n: 0, s: 0, ops: {}, first: {} } };
    const speeds = {};
    let plies = 0, n = 0;
    for (const pgn of pgns) {
      const h = parseHeaders(pgn);
      const color = (h.White || '').toLowerCase() === u ? 'w' : (h.Black || '').toLowerCase() === u ? 'b' : null;
      if (!color) continue;
      const score = h.Result === '1/2-1/2' ? 0.5 : (h.Result === '1-0') === (color === 'w') ? 1 : 0;
      const sans = mainlineSans(pgn);
      const c = new Chess();
      let name = null;
      for (const san of sans.slice(0, 24)) { try { c.move(san, { strict: false }); } catch { break; } const o = A.openings()[epd(c.fen())]; if (o) name = o; }
      const S = side[color];
      S.n++; S.s += score;
      const key = name ? name.n.split(':')[0] : 'Inne';
      const op = S.ops[key] || (S.ops[key] = { n: 0, s: 0, eco: name?.e || '', full: {}, line: sans.slice(0, 8).join(' ') });
      op.n++; op.s += score;
      if (name) op.full[name.n] = (op.full[name.n] || 0) + 1;
      // pierwszy ruch / odpowiedź na 1.e4, 1.d4
      const k = color === 'w' ? `1.${sans[0]}` : `1.${sans[0]} ${sans[1] || ''}`;
      S.first[k] = (S.first[k] || 0) + 1;
      const sp = h.TimeControl ? (/\//.test(h.TimeControl) ? 'daily' : (+h.TimeControl.split('+')[0] < 180 ? 'bullet' : +h.TimeControl.split('+')[0] < 600 ? 'blitz' : 'rapid')) : '?';
      (speeds[sp] ||= { n: 0, s: 0 }); speeds[sp].n++; speeds[sp].s += score;
      plies += sans.length; n++;
      if (n % 50 === 0) { st(`Analizuję… ${n}/${pgns.length}`); await tick(); }
    }
    if (!n) { st('Nie znalazłem partii tego gracza.'); return; }
    const colBox = (c, label) => {
      const S = side[c];
      const ops = Object.entries(S.ops).sort((a, b) => b[1].n - a[1].n).slice(0, 10);
      const weak = Object.entries(S.ops).filter(([, o]) => o.n >= 3).sort((a, b) => a[1].s / a[1].n - b[1].s / b[1].n)[0];
      const firsts = Object.entries(S.first).sort((a, b) => b[1] - a[1]).slice(0, 5);
      return `<div class="hcard"><h4>${label} <span class="muted">· ${S.n} partii · wynik ${pct((S.s / Math.max(1, S.n)) * 100)}</span></h4>
        <div class="op-first">${firsts.map(([k, v]) => `<span class="pill">${esc(k)} · ${v}</span>`).join('')}</div>
        <table class="tu-table ops"><tr><th>Otwarcie</th><th>Partie</th><th>Wynik</th></tr>
        ${ops.map(([k, o]) => `<tr class="${weak && weak[0] === k ? 'worst' : ''}" title="${esc(Object.keys(o.full).slice(0, 3).join(' | '))}"><td>${esc(o.eco)} ${esc(k)}</td><td>${o.n}</td><td>${pct((o.s / o.n) * 100)}</td></tr>`).join('')}</table>
        ${weak ? `<p class="muted" style="margin-top:8px">Najsłabiej gra: <b>${esc(weak[0])}</b> (${pct((weak[1].s / weak[1].n) * 100)} w ${weak[1].n} partiach) – warto celować w to otwarcie.</p>` : ''}</div>`;
    };
    box.innerHTML = `
      <div class="tu-cards">
        <div class="tu-card"><small>Partie</small><b>${n}</b><span>${esc(user)}</span></div>
        <div class="tu-card"><small>Wynik białymi</small><b>${pct((side.w.s / Math.max(1, side.w.n)) * 100)}</b><span>${side.w.n} partii</span></div>
        <div class="tu-card"><small>Wynik czarnymi</small><b>${pct((side.b.s / Math.max(1, side.b.n)) * 100)}</b><span>${side.b.n} partii</span></div>
        <div class="tu-card"><small>Śr. długość</small><b>${Math.round(plies / n / 2)}</b><span>ruchów</span></div>
      </div>
      <div class="op-cols">${colBox('w', 'Gra białymi')}${colBox('b', 'Gra czarnymi')}</div>
      <div class="hcard"><h4>Tempo</h4><div class="op-first">${Object.entries(speeds).map(([k, v]) => `<span class="pill">${k}: ${v.n} partii · ${pct((v.s / v.n) * 100)}</span>`).join('')}</div></div>
      <div class="row"><button class="btn primary" id="op-tree">Otwórz drzewko otwarć przeciwnika</button><button class="btn" id="op-drill">Drill: jego linie jako mój repertuar</button></div>`;
    $('op-tree').onclick = () => A.openOpponentTree(pgns, user);
    $('op-drill').onclick = () => A.drillFromPgns(pgns, user);
    st(`Gotowe: ${n} partii gracza ${user}.`);
    fx.enter(box.querySelectorAll('.tu-card, .hcard'), { step: 30 });
  } catch (e) { st('Błąd: ' + e.message); }
}

// ================================================================ 2. Zgadnij ruch
const GM = { on: false };
const quick = new Engine('guess');
async function quickEval(fen) {
  const id = A.engineId();
  await quick.setEngine(id);
  const res = await quick.analyse(fen, id === 'lc0' ? { nodes: 500 } : { depth: id === WASM_ID ? 11 : 14 });
  return res?.lines[0] || null;
}
async function pickGame(src) {
  if (src === 'current') {
    const g = A.S.game;
    if (!g.moves.length) throw new Error('w analizie nie ma wczytanej partii');
    return { pgn: null, game: g };
  }
  if (src === 'db') {
    const keys = await idb.keys('db:');
    if (!keys.length) throw new Error('nie masz baz PGN (Otwarcia → Baza PGN)');
    const text = await idb.get(keys[Math.floor(Math.random() * keys.length)]);
    const games = splitGames(text).filter((p) => mainlineSans(p).length > 30);
    if (!games.length) throw new Error('brak dłuższych partii w bazie');
    return { game: buildGame(games[Math.floor(Math.random() * games.length)]) };
  }
  const gms = ['DrNykterstein', 'Firouzja2003', 'nihalsarin2004', 'Zhigalko_Sergei', 'penguingim1', 'Msb2'];
  const who = gms[Math.floor(Math.random() * gms.length)];
  const r = await fetch(`https://lichess.org/api/games/user/${who}?max=30&rated=true&perfType=blitz,rapid,classical`, { headers: { Accept: 'application/x-chess-pgn' } });
  if (!r.ok) throw new Error('lichess HTTP ' + r.status);
  const games = splitGames(await r.text()).filter((p) => mainlineSans(p).length > 40);
  if (!games.length) throw new Error('brak partii');
  return { game: buildGame(games[Math.floor(Math.random() * games.length)]) };
}
async function startGuess() {
  $('gm-box').innerHTML = '<p class="muted">Wybieram partię…</p>';
  let g;
  try { g = (await pickGame($('gm-src').value)).game; } catch (e) { $('gm-box').innerHTML = `<p class="muted">Nie udało się: ${esc(e.message)}</p>`; return; }
  let color = $('gm-color').value;
  if (color === 'auto') {
    const me = (A.profile().name || '').toLowerCase();
    color = (g.headers.Black || '').toLowerCase() === me ? 'b' : 'w';
  }
  Object.assign(GM, { on: true, g, color, ply: Math.min(g.moves.length, +$('gm-skip').value || 0), score: 0, max: 0, hits: 0, tries: 0, last: null, shapes: [] });
  // dojdź do pierwszego ruchu gracza
  while (GM.ply < g.moves.length && g.moves[GM.ply].color !== color) GM.ply++;
  gmRender('Zgadnij ruch, który zagrał ' + (color === 'w' ? (g.headers.White || 'biały') : (g.headers.Black || 'czarny')) + '.');
}
function gmFen() { return GM.ply === 0 ? GM.g.startFen : GM.g.moves[GM.ply - 1].fenAfter; }
function gmView() {
  const lm = GM.ply > 0 ? GM.g.moves[GM.ply - 1] : null;
  A.S.train = { fen: gmFen(), lastMove: lm ? [lm.from, lm.to] : null, orientation: GM.color === 'w' ? 'white' : 'black', hideEval: true, shapes: GM.shapes, onMove: gmMove, playerColor: GM.color === 'w' ? 'white' : 'black' };
  A.render();
}
function gmRender(msg, cls = '') {
  const h = GM.g.headers;
  const mno = Math.floor(GM.ply / 2) + 1;
  $('gm-box').innerHTML = `<div class="pz-head"><div class="pz-title">${esc(h.White || '?')} – ${esc(h.Black || '?')} <span class="muted">${esc(h.Event || '')} ${esc(h.Date || '')}</span></div></div>
    <div class="rush-head"><div class="rush-stat"><small>Punkty</small><b class="num">${GM.score}/${GM.max}</b></div><div class="rush-stat"><small>Trafione</small><b class="num">${GM.hits}/${GM.tries}</b></div><div class="rush-stat"><small>Ruch</small><b class="num">${mno}</b></div></div>
    <div class="pz-status ${cls}">${msg}</div>
    <div class="row"><button class="btn" id="gm-hint">Podpowiedź (bierka)</button><button class="btn" id="gm-skipmove">Pokaż ruch</button><button class="btn" id="gm-analyse">Analizuj partię</button></div>
    <p class="muted">3 pkt – ruch z partii · 2 pkt – równie dobry według silnika · 1 pkt – niewiele gorszy.</p>`;
  $('gm-hint').onclick = () => { const m = GM.g.moves[GM.ply]; if (!m) return; GM.shapes = [{ orig: m.from, brush: 'green' }]; gmView(); };
  $('gm-skipmove').onclick = () => gmAdvance(null);
  $('gm-analyse').onclick = () => { GM.on = false; A.S.train = null; A.loadGame(GM.g); };
  gmView();
}
async function gmMove(uci, m, fenAfter) {
  if (!GM.on) return;
  const real = GM.g.moves[GM.ply];
  if (!real) return gmEnd();
  GM.tries++; GM.max += 3;
  if (uci === real.uci) { GM.score += 3; GM.hits++; A.sound.forSan(real.san); return gmAdvance(`✓ Tak! ${fig(real.san)} – +3`, 'ok'); }
  // ocena silnikiem: czy ruch był równie dobry
  GM.shapes = []; A.S.train.fen = fenAfter; A.S.train.lastMove = [m.from, m.to]; A.render();
  $('gm-box').querySelector('.pz-status').textContent = 'Sprawdzam Twój ruch…';
  const before = await quickEval(gmFen());
  const after = await quickEval(fenAfter);
  let pts = 0;
  if (before && after) {
    const loss = C.povWin(before, GM.color) - C.povWin(after, GM.color);
    pts = loss < 1.5 ? 2 : loss < 5 ? 1 : 0;
  }
  GM.score += pts;
  A.sound.play(pts ? 'Confirmation' : 'Error');
  GM.shapes = [{ orig: real.from, dest: real.to, brush: 'green' }, { orig: m.from, dest: m.to, brush: 'red' }];
  gmAdvance(`${pts ? '≈' : '✕'} Twój ${fig(m.san)} ${pts ? `– równie dobry (+${pts})` : '– słabszy'}. W partii: <b>${fig(real.san)}</b>`, pts ? '' : 'bad', true);
}
function gmAdvance(msg, cls, keepShapes) {
  const real = GM.g.moves[GM.ply];
  if (!real) return gmEnd();
  GM.ply++;
  // ruch przeciwnika z partii
  if (GM.ply < GM.g.moves.length && GM.g.moves[GM.ply].color !== GM.color) { A.sound.forSan(GM.g.moves[GM.ply].san); GM.ply++; }
  if (!keepShapes) GM.shapes = [];
  if (GM.ply >= GM.g.moves.length) return gmEnd(msg);
  gmRender(msg || `W partii: ${fig(real.san)}`, cls);
  if (keepShapes) setTimeout(() => { if (GM.on) { GM.shapes = []; gmView(); } }, 1600);
}
function gmEnd(msg) {
  GM.on = false;
  const p = GM.max ? Math.round((GM.score / GM.max) * 100) : 0;
  $('gm-box').innerHTML = `<div class="result-card"><div class="rc-title">Koniec partii</div><div class="rc-rating"><b class="num">${GM.score}/${GM.max}</b><small>${p}% punktów · trafione ${GM.hits}/${GM.tries}</small></div>${A.catSays(p >= 70 ? 'Grasz jak autor tej partii! 🏆' : p >= 40 ? 'Nieźle! Zobacz w analizie, gdzie się różniliście.' : 'Trudna partia – przejrzyj ją w analizie.')}<div class="row"><button class="btn primary" id="gm-again">Następna partia</button><button class="btn" id="gm-an">Analizuj</button></div></div>`;
  $('gm-again').onclick = startGuess;
  const g = GM.g;
  $('gm-an').onclick = () => { A.S.train = null; A.loadGame(g); };
  if (msg) A.toast(msg.replace(/<[^>]+>/g, ''));
  A.S.train = null; A.render();
}

// ================================================================ 3. Szukanie pozycji / struktury / materiału + 4. raport
function pawnSet(fen) {
  const rows = fen.split(' ')[0].split('/');
  const s = new Set();
  rows.forEach((r, y) => { let x = 0; for (const ch of r) { if (/\d/.test(ch)) x += +ch; else { if (ch === 'P' || ch === 'p') s.add(ch + x + y); x++; } } });
  return s;
}
function materialSig(fen) {
  const b = fen.split(' ')[0];
  const cnt = (ch) => (b.match(new RegExp(ch, 'g')) || []).length;
  return ['Q', 'R', 'B', 'N', 'P', 'q', 'r', 'b', 'n', 'p'].map(cnt).join(',');
}
function sigLabel(fen) {
  const b = fen.split(' ')[0];
  const side = (up) => ['K', 'Q', 'R', 'B', 'N', 'P'].map((p) => (p === 'K' ? 'K' : p.repeat((b.match(new RegExp(up ? p : p.toLowerCase(), 'g')) || []).length))).join('');
  return `${side(true)} vs ${side(false)}`;
}
function refreshPosInfo() {
  const fen = A.curFen();
  if ($('sp-pos')) $('sp-pos').innerHTML = `${A.miniBoard(fen, { flip: A.S.orientation === 'black' })}<div><b>Pozycja z szachownicy</b><div class="muted">${esc(A.openings()[epd(fen)]?.n || '')}</div><div class="muted">Materiał: ${esc(sigLabel(fen))}</div><div class="muted">Pionki: ${pawnSet(fen).size}</div></div>`;
  if ($('rp-pos')) $('rp-pos').innerHTML = $('sp-pos')?.innerHTML || '';
}
async function scanDbs(fen, mode, onProgress, wantReport) {
  const keys = await idb.keys('db:');
  if (!keys.length) throw new Error('nie masz baz PGN – dodaj je w Otwarcia → Baza PGN');
  const target = epd(fen);
  const tPawns = pawnSet(fen), tMat = materialSig(fen);
  const results = [];
  const rep = { n: 0, w: 0, d: 0, b: 0, moves: {}, games: [], lines: {} };
  let scanned = 0;
  for (const k of keys) {
    const text = await idb.get(k);
    for (const pgn of splitGames(text)) {
      scanned++;
      const sans = mainlineSans(pgn);
      const h = parseHeaders(pgn);
      const c = new Chess(h.SetUp === '1' && h.FEN ? h.FEN : undefined);
      for (let i = 0; i <= sans.length; i++) {
        const f = c.fen();
        let hit = false;
        if (mode === 'exact') hit = epd(f) === target;
        else if (mode === 'material') hit = materialSig(f) === tMat;
        else if (mode === 'pawns') {
          const ps = pawnSet(f);
          if (ps.size >= 6 && Math.abs(ps.size - tPawns.size) <= 2) {
            let inter = 0; for (const x of ps) if (tPawns.has(x)) inter++;
            hit = inter / (ps.size + tPawns.size - inter) >= 0.8;
          }
        }
        if (hit) {
          results.push({ pgn, h, ply: i });
          if (wantReport) {
            rep.n++;
            const res = h.Result; if (res === '1-0') rep.w++; else if (res === '0-1') rep.b++; else if (res === '1/2-1/2') rep.d++;
            const nx = sans[i];
            if (nx) {
              const mv = rep.moves[nx] || (rep.moves[nx] = { n: 0, w: 0, d: 0, b: 0, elo: [] });
              mv.n++; if (res === '1-0') mv.w++; else if (res === '0-1') mv.b++; else if (res === '1/2-1/2') mv.d++;
              const e = (+h.WhiteElo || 0) + (+h.BlackElo || 0); if (e) mv.elo.push(e / 2);
              const line = sans.slice(i, i + 10).join(' ');
              rep.lines[line] = (rep.lines[line] || 0) + 1;
            }
            rep.games.push({ pgn, h, ply: i, elo: ((+h.WhiteElo || 0) + (+h.BlackElo || 0)) / 2 });
          }
          break;
        }
        if (i < sans.length) { try { c.move(sans[i], { strict: false }); } catch { break; } }
        if (mode === 'exact' && i > 60) break;
      }
      if (results.length >= 300 && !wantReport) return { results, scanned, rep };
      if (scanned % 40 === 0) { onProgress(scanned); await tick(); }
    }
  }
  return { results, scanned, rep };
}
async function runSearch() {
  const mode = $('sp-mode').value;
  const st = (t) => ($('sp-status').textContent = t);
  st('Szukam…');
  try {
    const { results, scanned } = await scanDbs(A.curFen(), mode, (n) => st(`Szukam… przejrzano ${n} partii`));
    st(`Znaleziono ${results.length}${results.length >= 300 ? '+' : ''} partii (przejrzano ${scanned}).`);
    $('sp-list').innerHTML = results.slice(0, 300).map((r, i) => `<div class="game-item" data-i="${i}"><div>${esc(r.h.White)} – ${esc(r.h.Black)}</div><div class="res">${esc(r.h.Result || '*')}</div><div class="meta">${esc([r.h.Date, r.h.Event, r.h.ECO, 'ruch ' + (Math.floor(r.ply / 2) + 1)].filter(Boolean).join(' · '))}</div></div>`).join('');
    $('sp-list').onclick = (e) => { const it = e.target.closest('[data-i]'); if (it) { const r = results[+it.dataset.i]; A.loadGame(buildGame(r.pgn), r.ply); } };
  } catch (e) { st('Błąd: ' + e.message); }
}
async function runReport() {
  const fen = A.curFen();
  const st = (t) => ($('rp-status').textContent = t);
  const box = $('rp-report');
  box.innerHTML = '';
  st('Tworzę raport…');
  let rep = null, scanned = 0;
  try { ({ rep, scanned } = await scanDbs(fen, 'exact', (n) => st(`Przeglądam bazy… ${n} partii`), true)); } catch (e) { st(e.message); }
  let masters = null;
  try { const r = await A.apiFetch('explorer', `masters?fen=${encodeURIComponent(fen)}&moves=8&topGames=5`, 'application/json'); if (r.ok) masters = await r.json(); } catch {}
  const turn = fen.split(' ')[1];
  const scoreFor = (m) => { const n = m.w + m.d + m.b; return n ? ((turn === 'w' ? m.w : m.b) + m.d / 2) / n * 100 : null; };
  const name = A.openings()[epd(fen)];
  let html = `<div class="hcard"><h4>${name ? `<span class="pill accent">${esc(name.e)}</span> ${esc(name.n)}` : 'Raport pozycji'}</h4>`;
  if (rep && rep.n) {
    const mv = Object.entries(rep.moves).sort((a, b) => b[1].n - a[1].n);
    const lines = Object.entries(rep.lines).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const top = rep.games.sort((a, b) => b.elo - a.elo).slice(0, 6);
    html += `<p class="muted">Twoje bazy: <b>${rep.n}</b> partii z tą pozycją (przejrzano ${scanned}) · białe ${pct((rep.w / rep.n) * 100)} · remis ${pct((rep.d / rep.n) * 100)} · czarne ${pct((rep.b / rep.n) * 100)}</p>
      <table class="tu-table ops"><tr><th>Ruch</th><th>Partie</th><th>Wynik dla strony na ruchu</th><th>Śr. ranking</th></tr>
      ${mv.map(([san, m]) => `<tr class="mv-row" data-san="${esc(san)}"><td><b>${fig(san)}</b></td><td>${m.n}</td><td>${pct(scoreFor(m))}</td><td>${m.elo.length ? Math.round(m.elo.reduce((a, b) => a + b, 0) / m.elo.length) : '–'}</td></tr>`).join('')}</table>
      <h3>Główne kontynuacje</h3>${lines.map(([l, n]) => `<div class="rp-line"><span class="mono">${esc(l)}</span> <span class="muted">· ${n}×</span></div>`).join('')}
      <h3>Najmocniejsze partie</h3><div class="game-list">${top.map((g, i) => `<div class="game-item" data-g="${i}"><div>${esc(g.h.White)} (${esc(g.h.WhiteElo || '?')}) – ${esc(g.h.Black)} (${esc(g.h.BlackElo || '?')})</div><div class="res">${esc(g.h.Result)}</div><div class="meta">${esc([g.h.Event, g.h.Date].filter(Boolean).join(' · '))}</div></div>`).join('')}</div>`;
    setTimeout(() => {
      box.querySelectorAll('[data-g]').forEach((el) => (el.onclick = () => { const g = top[+el.dataset.g]; A.loadGame(buildGame(g.pgn), g.ply); }));
    });
  } else html += '<p class="muted">W Twoich bazach PGN nie ma tej pozycji.</p>';
  if (masters?.moves?.length) {
    const n = masters.white + masters.draws + masters.black;
    html += `<h3>Partie mistrzów (lichess) · ${n.toLocaleString('pl')}</h3><table class="tu-table ops"><tr><th>Ruch</th><th>Partie</th><th>Wynik dla strony na ruchu</th><th>Śr. ranking</th></tr>
      ${masters.moves.map((m) => `<tr class="mv-row" data-san="${esc(m.san)}"><td><b>${fig(m.san)}</b></td><td>${(m.white + m.draws + m.black).toLocaleString('pl')}</td><td>${pct(scoreFor({ w: m.white, d: m.draws, b: m.black }))}</td><td>${m.averageRating || '–'}</td></tr>`).join('')}</table>`;
  }
  html += '</div>';
  box.innerHTML = html;
  box.onclick = (e) => { const r = e.target.closest('[data-san]'); if (r) { A.playSan(r.dataset.san); refreshPosInfo(); } };
  st('Gotowe. Kliknij ruch w tabeli, żeby go zagrać na szachownicy.');
  fx.enter(box.querySelectorAll('tr, .rp-line, .game-item'), { step: 12 });
}

export function initChessbase(api) {
  A = api;
  $('base-sub').onclick = (e) => { const s = e.target.dataset.sub; if (s) setSub(s); };
  $('op-run').onclick = prepare;
  $('op-user').addEventListener('keydown', (e) => { if (e.key === 'Enter') prepare(); });
  $('gm-start').onclick = startGuess;
  $('sp-run').onclick = runSearch;
  $('rp-run').onclick = runReport;
  setSub(A.store.get('baseSub', 'opponent'));
}
export function guessActive() { return GM.on; }

// Trening: zadania z lichess (motywy / losowe), zadania z własnych błędów, drille debiutowe, trener (jak Lichess Tutor).
import { Chess } from './vendor/chess.js';
import { idb } from './store.js';
import { treeFromPgn, addGameToTree, epd, countLines } from './pgn-tree.js';
import { splitGames, parseHeaders, buildGame } from './pgn.js';
import * as C from './classify.js';
import { Engine, WASM_ID } from './engine.js';
import * as fx from './fx.js';

let A; // API aplikacji (app.js)
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400000;
const START = new Chess().fen();

export const THEMES = [
  ['mix', 'Losowe'], ['mateIn1', 'Mat w 1'], ['mateIn2', 'Mat w 2'], ['mateIn3', 'Mat w 3'], ['mate', 'Mat'],
  ['fork', 'Widełki'], ['pin', 'Związanie'], ['skewer', 'Przeszycie'], ['hangingPiece', 'Wisząca figura'],
  ['discoveredAttack', 'Odsłonięty atak'], ['doubleCheck', 'Podwójny szach'], ['sacrifice', 'Poświęcenie'],
  ['deflection', 'Odciągnięcie'], ['attraction', 'Przyciągnięcie'], ['clearance', 'Oczyszczenie'],
  ['interference', 'Przesłonięcie'], ['intermezzo', 'Ruch pośredni'], ['xRayAttack', 'Atak rentgenowski'],
  ['trappedPiece', 'Pułapka na figurę'], ['capturingDefender', 'Zbicie obrońcy'], ['quietMove', 'Cichy ruch'],
  ['defensiveMove', 'Obrona'], ['zugzwang', 'Zugzwang'], ['exposedKing', 'Odsłonięty król'],
  ['kingsideAttack', 'Atak na skrzydle królewskim'], ['queensideAttack', 'Atak na skrzydle hetmańskim'],
  ['backRankMate', 'Mat na ostatniej linii'], ['smotheredMate', 'Mat zduszony'], ['anastasiaMate', 'Mat Anastazji'],
  ['arabianMate', 'Mat arabski'], ['bodenMate', 'Mat Bodena'], ['hookMate', 'Mat hakiem'], ['dovetailMate', 'Mat jaskółczy ogon'],
  ['promotion', 'Promocja'], ['underPromotion', 'Słaba promocja'], ['advancedPawn', 'Zaawansowany pionek'],
  ['enPassant', 'Bicie w przelocie'], ['castling', 'Roszada'],
  ['opening', 'Debiut'], ['middlegame', 'Gra środkowa'], ['endgame', 'Końcówka'],
  ['rookEndgame', 'Końcówka wieżowa'], ['pawnEndgame', 'Końcówka pionkowa'], ['queenEndgame', 'Końcówka hetmańska'],
  ['bishopEndgame', 'Końcówka gońcowa'], ['knightEndgame', 'Końcówka skoczkowa'],
  ['oneMove', 'Jeden ruch'], ['short', 'Krótkie'], ['long', 'Długie'], ['veryLong', 'Bardzo długie'],
  ['crushing', 'Miażdżąca przewaga'], ['advantage', 'Przewaga'], ['equality', 'Wyrównanie'],
];
const THEME_PL = Object.fromEntries(THEMES);

// ---------------------------------------------------------------- plansza treningowa
function show(view) {
  A.S.train = { hideEval: true, shapes: [], ...view };
  A.render();
}
function playOn(fen, uci) {
  const c = new Chess(fen);
  const m = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  return { fen: c.fen(), m, chess: c };
}
let current = null; // aktywne ćwiczenie {kind, resume()}

export function onShowTab(name) {
  if (name === 'puzzles' && current?.kind === 'puzzle') current.resume();
  if (name === 'puzzles' && !current && !$('train-pzhome').hidden) renderPzHome();
  if (name === 'train') renderTutorReport();
}
/** Wejście z zewnątrz (strona główna): otwiera Zadania w danym trybie. */
export function openPuzzles(mode) {
  A.showTab('puzzles');
  if (mode === 'daily') { setSub('puzzles'); return runDaily(); }
  setSub(mode);
  if (mode === 'puzzles' && !current) nextLichessPuzzle();
  if (mode === 'mistakes') nextMistake();
}
async function runDaily() {
  const box = $('pz-box');
  box.innerHTML = '<p class="muted">Pobieram zadanie dnia…</p>';
  let data;
  try {
    const c = A.store.get('daily', null);
    data = c && c.key === new Date().toISOString().slice(0, 10) ? c.data : await (await fetch('https://lichess.org/api/puzzle/daily', { headers: { Accept: 'application/json' } })).json();
  } catch (e) { box.innerHTML = `<p class="muted">Brak połączenia (${esc(e.message)}).</p>`; return; }
  const c = new Chess(); let last = null;
  for (const san of data.game.pgn.split(' ')) { try { last = c.move(san); } catch { break; } }
  runPuzzle({ fen: c.fen(), sol: data.puzzle.solution, lastMove: last ? [last.from, last.to] : null,
    title: `★ Zadanie dnia · ranking ${data.puzzle.rating}`, onDone(ok) { if (ok) A.markActive?.(); }, next: nextLichessPuzzle }, 'pz-box');
}

// ---------------------------------------------------------------- kafelki zadań
const TILE_THEMES = [['mateIn1', '♚', 'Mat w 1'], ['mateIn2', '♛', 'Mat w 2'], ['fork', '⑂', 'Widełki'], ['pin', '📌', 'Związanie'], ['skewer', '➶', 'Przeszycie'], ['hangingPiece', '◌', 'Wisząca figura'],
  ['discoveredAttack', '⇄', 'Odsłonięty atak'], ['sacrifice', '✶', 'Poświęcenie'], ['backRankMate', '▁', 'Mat na ostatniej linii'], ['promotion', '♕', 'Promocja'], ['endgame', '♔', 'Końcówka'], ['defensiveMove', '⛨', 'Obrona']];
async function renderPzHome() {
  const s = pzStats();
  const mistakes = await getMistakes();
  const due = mistakes.filter((m) => m.due <= Date.now()).length;
  const best = A.store.get('rushBest', {});
  $('train-pzhome').innerHTML = `
    <div class="pz-hero">
      <div><small class="eyebrow" style="margin:0">Ranking zadań</small><div class="pz-big mono">${s.rating}</div><div class="muted">rozwiązane ${s.solved} · nieudane ${s.failed} · seria ${s.streak}</div></div>
      <button class="btn primary big" data-pz="puzzles" style="width:auto;padding:12px 26px">Rozwiązuj zadania</button>
    </div>
    <div class="pz-tiles">
      <button class="pz-tile t1" data-pz="puzzles"><b>✦</b><span>Zadania</span><small>z rankingiem ${s.rating}</small></button>
      <button class="pz-tile t2" data-pz="rush"><b>⚡</b><span>Puzzle Rush</span><small>rekord ${Math.max(best['3'] || 0, best['5'] || 0, best.survival || 0)}</small></button>
      <button class="pz-tile t3" data-pz="mistakes"><b>✕</b><span>Moje błędy</span><small>${due} do powtórki</small></button>
      <button class="pz-tile t4" data-pz="daily"><b>★</b><span>Zadanie dnia</span><small>codziennie nowe</small></button>
    </div>
    <h3>Motywy</h3>
    <div class="theme-tiles">${TILE_THEMES.map(([k, g, n]) => `<button class="theme-tile" data-theme="${k}"><b>${g}</b><span>${n}</span></button>`).join('')}
      <button class="theme-tile" data-pz="puzzles"><b>⋯</b><span>Wszystkie motywy</span></button></div>`;
  fx.enter($('train-pzhome').querySelectorAll('.pz-hero, .pz-tile, .theme-tile'), { step: 22 });
}

export const drills = {
  show() { renderRepList(); if (current?.kind === 'drill' && !$('drill-box').hidden) current.resume(); },
};

function setSub(sub) {
  for (const b of $('train-sub').children) b.classList.toggle('active', b.dataset.sub === sub);
  for (const p of document.querySelectorAll('#tab-puzzles .train-pane')) p.hidden = p.id !== 'train-' + sub;
  A.store.set('trainSub', sub);
  if (sub === 'pzhome') renderPzHome();
  if (sub === 'mistakes') refreshMistakesInfo();
  if (sub === 'rush') rushUi();
  if (sub === 'tutor') renderTutorReport();
}

// ---------------------------------------------------------------- zadania (wspólne)
const PZ = { stats: null };
function pzStats() {
  if (!PZ.stats) PZ.stats = A.store.get('puzzleStats', { rating: 1500, solved: 0, failed: 0, streak: 0 });
  return PZ.stats;
}
function savePzStats() { A.store.set('puzzleStats', PZ.stats); }

/** Uniwersalny przebieg zadania. p = {fen, sol:[uci], lastMove, title, info, source, onDone(ok), checkAlt(uci, fenAfter)} */
function runPuzzle(p, boxId) {
  const box = $(boxId);
  const color = new Chess(p.fen).turn();
  const st = { fen: p.fen, idx: 0, failed: false, done: false, lastMove: p.lastMove, hint: 0 };
  const orientation = color === 'w' ? 'white' : 'black';
  const status = (html, cls = '') => {
    const el = box.querySelector('.pz-status');
    el.className = 'pz-status ' + cls;
    el.innerHTML = html;
    if (cls === 'bad') fx.shake(el); else if (cls === 'ok') fx.pop(el);
  };
  box.innerHTML = `<div class="pz-head"><div class="pz-title">${p.title}</div><div class="pz-info">${p.info || ''}</div></div>
    <div class="pz-status">${color === 'w' ? '⚪ Białe' : '⚫ Czarne'} – znajdź najlepszy ruch.</div>
    <div class="row pz-actions">
      <button class="btn" data-a="hint">Podpowiedź</button>
      <button class="btn" data-a="solution">Rozwiązanie</button>
      <button class="btn" data-a="analyse">Analizuj</button>
      <button class="btn primary" data-a="next">Następne ▸</button>
    </div>`;
  const view = () => show({
    fen: st.fen, lastMove: st.lastMove, orientation,
    shapes: st.hintShape ? [st.hintShape] : [],
    onMove: onMove,
  });
  async function finish(ok) {
    st.done = true;
    if (p.rush) { status(ok ? '✓ Dobrze!' : '✕ Błąd', ok ? 'ok' : 'bad'); p.onDone?.(ok); view(); if (p.next) setTimeout(p.next, ok ? 450 : 1100); return; }
    if (ok && !st.failed) { status('✓ Rozwiązane!', 'ok'); A.sound.play('Confirmation'); }
    else if (ok) status('✓ Rozwiązane (z błędem po drodze).', 'ok');
    else status('Rozwiązanie pokazane.', 'bad');
    p.onDone?.(ok && !st.failed);
    view();
  }
  async function opponentMove() {
    await sleep(380);
    if (st.done || current?.st !== st) return;
    const u = p.sol[st.idx];
    const r = playOn(st.fen, u);
    st.fen = r.fen; st.lastMove = [r.m.from, r.m.to]; st.idx++;
    A.sound.forSan(r.m.san);
    view();
  }
  async function onMove(uci, m, fenAfter) {
    if (st.done) { // po zakończeniu – swobodna analiza
      st.fen = fenAfter; st.lastMove = [m.from, m.to]; A.sound.forSan(m.san); view(); return;
    }
    const expected = p.sol[st.idx];
    const mate = new Chess(fenAfter).isCheckmate();
    let ok = uci === expected || (mate && st.idx === p.sol.length - 1);
    if (!ok && p.checkAlt) {
      st.fen = fenAfter; st.lastMove = [m.from, m.to]; view();
      status('Sprawdzam ruch…');
      ok = await p.checkAlt(uci, fenAfter, st.idx);
      if (ok) {
        A.sound.forSan(m.san);
        status(`✓ ${esc(m.san)} też jest bardzo dobre!`, 'ok');
        return finish(true);
      }
    }
    if (ok) {
      st.fen = fenAfter; st.lastMove = [m.from, m.to]; st.idx++; st.hintShape = null;
      A.sound.forSan(m.san);
      if (st.idx >= p.sol.length) return finish(true);
      status('✓ Dobrze, dalej…', 'ok');
      view();
      return opponentMove();
    }
    // błąd
    st.failed = true;
    A.sound.play('Error');
    if (p.rush) { st.fen = fenAfter; st.lastMove = [m.from, m.to]; return finish(false); }
    const prevFen = st.fen, prevLast = st.lastMove;
    st.fen = fenAfter; st.lastMove = [m.from, m.to]; view();
    status(`✕ ${esc(m.san)} to nie to. Spróbuj jeszcze.`, 'bad');
    await sleep(650);
    if (current?.st !== st) return;
    st.fen = prevFen; st.lastMove = prevLast; view();
  }
  box.querySelector('.pz-actions').onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'hint' && !st.done) {
      const u = p.sol[st.idx];
      st.failed = true;
      st.hintShape = { orig: u.slice(0, 2), brush: 'green' };
      status('Podpowiedź: ruszasz figurą z zaznaczonego pola.');
      view();
    } else if (a === 'solution' && !st.done) {
      st.failed = true;
      while (st.idx < p.sol.length) {
        const r = playOn(st.fen, p.sol[st.idx]);
        st.fen = r.fen; st.lastMove = [r.m.from, r.m.to]; st.idx++;
        A.sound.forSan(r.m.san); view();
        await sleep(650);
      }
      finish(false);
    } else if (a === 'analyse') {
      A.S.train = null;
      A.loadPgnText(p.fen);
    } else if (a === 'next') p.next?.();
  };
  current = { kind: 'puzzle', st, resume: view };
  if (p.rush) box.querySelector('.pz-actions').hidden = true;
  fx.enter(box.children, { step: 40 });
  view();
}

// ---------------------------------------------------------------- zadania z lichess
async function nextLichessPuzzle() {
  const theme = $('pz-theme').value;
  const diff = $('pz-diff').value;
  A.store.set('pzTheme', theme); A.store.set('pzDiff', diff);
  const box = $('pz-box');
  box.innerHTML = '<p class="muted">Pobieram zadanie z lichess…</p>';
  let data;
  try {
    const r = await fetch(`https://lichess.org/api/puzzle/next?angle=${encodeURIComponent(theme)}&difficulty=${diff}`, { headers: { Accept: 'application/json' } });
    if (r.status === 429) throw new Error('za dużo zapytań – odczekaj minutę');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    data = await r.json();
  } catch (e) { box.innerHTML = `<p class="muted">Nie udało się pobrać zadania (${esc(e.message)}).</p>`; return; }
  const c = new Chess();
  let last = null;
  for (const san of data.game.pgn.split(' ')) { try { last = c.move(san); } catch { break; } }
  const st = pzStats();
  const pr = data.puzzle.rating;
  const themes = data.puzzle.themes.map((t) => THEME_PL[t] || t).join(' · ');
  runPuzzle({
    fen: c.fen(), sol: data.puzzle.solution, lastMove: last ? [last.from, last.to] : null,
    title: `Zadanie <a href="https://lichess.org/training/${data.puzzle.id}" target="_blank" rel="noopener">#${data.puzzle.id}</a> · ranking ${pr}`,
    info: `<details><summary>Pokaż motywy</summary><div class="pz-tags">${data.puzzle.themes.map((t) => `<span class="pill">${esc(THEME_PL[t] || t)}</span>`).join('')}</div></details>`,
    onDone(ok) {
      const exp = 1 / (1 + 10 ** ((pr - st.rating) / 400));
      st.rating = Math.round(st.rating + 24 * ((ok ? 1 : 0) - exp));
      if (ok) { st.solved++; st.streak++; } else { st.failed++; st.streak = 0; }
      savePzStats(); renderPzStats(); A.pushRating?.('puzzle', st.rating); if (ok) A.markActive?.();
    },
    next: nextLichessPuzzle,
  }, 'pz-box');
}
function renderPzStats() {
  const s = pzStats();
  $('pz-stats').innerHTML = `<span class="pill accent">Ranking ${s.rating}</span><span class="pill">Rozwiązane ${s.solved}</span><span class="pill">Nieudane ${s.failed}</span><span class="pill">Seria ${s.streak}</span>`;
}

// ---------------------------------------------------------------- Puzzle Rush
const RU = { on: false };
function rushDiff() { const s = RU.score; return s < 4 ? 'easiest' : s < 9 ? 'easier' : s < 15 ? 'normal' : s < 23 ? 'harder' : 'hardest'; }
async function fetchPuzzle(diff) {
  const r = await fetch(`https://lichess.org/api/puzzle/next?angle=mix&difficulty=${diff}`, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
function rushUi() {
  $('rush-score').textContent = RU.score ?? 0;
  $('rush-strikes').innerHTML = [0, 1, 2].map((i) => `<span class="${i < (RU.strikes || 0) ? 'x' : ''}">${i < (RU.strikes || 0) ? '✕' : '○'}</span>`).join('');
  const best = A.store.get('rushBest', {});
  $('rush-best').textContent = `Rekordy: 3 min – ${best['3'] || 0} · 5 min – ${best['5'] || 0} · przetrwanie – ${best.survival || 0}`;
}
async function startRush(mode) {
  clearInterval(RU.timer);
  Object.assign(RU, { on: true, mode, score: 0, strikes: 0, end: mode === 'survival' ? null : Date.now() + (+mode) * 60000, next: null });
  $('rush-start-row').hidden = true;
  rushUi();
  RU.timer = setInterval(() => {
    if (!RU.end) { $('rush-time').textContent = '∞'; return; }
    const left = Math.max(0, RU.end - Date.now());
    $('rush-time').textContent = `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, '0')}`;
    if (!left) endRush('Koniec czasu!');
  }, 250);
  RU.next = fetchPuzzle(rushDiff());
  nextRush();
}
async function nextRush() {
  if (!RU.on) return;
  let data;
  try { data = await RU.next; } catch (e) { $('rush-box').innerHTML = `<p class="muted">Nie udało się pobrać zadania (${esc(e.message)}).</p>`; return endRush('Błąd połączenia'); }
  if (!RU.on) return;
  RU.next = fetchPuzzle(rushDiff()).catch((e) => { throw e; });
  const c = new Chess();
  let last = null;
  for (const san of data.game.pgn.split(' ')) { try { last = c.move(san); } catch { break; } }
  runPuzzle({
    fen: c.fen(), sol: data.puzzle.solution, lastMove: last ? [last.from, last.to] : null, rush: true,
    title: `Zadanie ${RU.score + RU.strikes + 1} · ranking ${data.puzzle.rating}`,
    onDone(ok) {
      if (ok) RU.score++; else RU.strikes++;
      rushUi();
      if (RU.strikes >= 3) endRush('Trzy błędy!');
    },
    next: () => RU.on && nextRush(),
  }, 'rush-box');
}
function endRush(why) {
  if (!RU.on) return;
  RU.on = false;
  clearInterval(RU.timer);
  const best = A.store.get('rushBest', {});
  const rec = RU.score > (best[RU.mode] || 0);
  if (rec) { best[RU.mode] = RU.score; A.store.set('rushBest', best); }
  A.sound.play(rec ? 'Confirmation' : 'GenericNotify');
  $('rush-box').innerHTML = `<div class="result-card"><div class="rc-title">${esc(why)}</div><div class="rc-rating"><b class="mono">${RU.score}</b><small>rozwiązanych zadań${rec ? ' – nowy rekord! 🏆' : ''}</small></div>
    ${A.catSays ? A.catSays(rec ? 'Nowy rekord! Tak trzymaj!' : 'Dobra robota! Spróbujesz pobić rekord?') : ''}</div>`;
  $('rush-start-row').hidden = false;
  current = null; A.S.train = null; A.render();
  rushUi();
}

// ---------------------------------------------------------------- zadania z własnych błędów
async function getMistakes() { return (await idb.get('mistakes')) || []; }
async function saveMistakes(list) { await idb.set('mistakes', list); }

/** Dodaje błędy z przeanalizowanej partii jako zadania. colors – tablica 'w'/'b'. Zwraca liczbę nowych. */
export async function addMistakesFromReview(game, evals, review, colors) {
  const list = await getMistakes();
  const ids = new Set(list.map((m) => m.id));
  const h = game.headers || {};
  let added = 0;
  review.forEach((r, i) => {
    const mv = game.moves[i];
    if (!r || !colors.includes(mv.color) || !C.ERROR_CLASSES.includes(r.cls)) return;
    const before = evals[i];
    if (!before?.pv?.length) return;
    const tactical = /mat|wygrywa|widełki|wisząc|zabiera/.test(r.text || '');
    let sol = before.pv.slice(0, tactical ? 3 : 1);
    if (sol.length % 2 === 0) sol = sol.slice(0, sol.length - 1);
    const id = epd(mv.fenBefore) + '|' + mv.uci;
    if (ids.has(id)) return;
    ids.add(id);
    list.push({
      id, fen: mv.fenBefore, sol, played: mv.san, cls: r.cls, text: r.text || '',
      ev: { cp: before.cp, mate: before.mate }, color: mv.color,
      game: { w: h.White || '?', b: h.Black || '?', d: h.Date || h.UTCDate || '', link: h.Link || (h.Site?.startsWith('http') ? h.Site : '') },
      added: Date.now(), due: Date.now(), streak: 0,
    });
    added++;
  });
  if (added) await saveMistakes(list);
  return added;
}

const auxEngine = new Engine('trainaux');
async function quickEval(fen) {
  const id = A.engineId();
  await auxEngine.setEngine(id);
  const res = await auxEngine.analyse(fen, id === 'lc0' ? { nodes: 600 } : { depth: id === WASM_ID ? 11 : 15 });
  return res?.lines[0] || null;
}

async function refreshMistakesInfo() {
  const list = await getMistakes();
  const due = list.filter((m) => m.due <= Date.now()).length;
  const learned = list.filter((m) => m.streak >= 3).length;
  $('mk-info').innerHTML = list.length
    ? `Zadań z Twoich błędów: <b>${list.length}</b> · do powtórki teraz: <b>${due}</b> · opanowane: ${learned}`
    : 'Brak zadań. Przeanalizuj swoją partię (Raport) albo użyj zakładki <b>Trener</b> – Twoje błędy trafią tutaj automatycznie.';
}

async function nextMistake() {
  const list = await getMistakes();
  const box = $('mk-box');
  if (!list.length) { box.innerHTML = ''; refreshMistakesInfo(); return; }
  const now = Date.now();
  const due = list.filter((m) => m.due <= now).sort((a, b) => a.due - b.due);
  const pool = due.length ? due.slice(0, 5) : list;
  const item = pool[Math.floor(Math.random() * pool.length)];
  const k = C.CLASSES[item.cls];
  const g = item.game;
  runPuzzle({
    fen: item.fen, sol: item.sol,
    title: `${A.badgeHtml(item.cls, 20)} W partii zagrałeś <b>${esc(item.played)}</b> – ${k.label}`,
    info: `${esc(g.w)} – ${esc(g.b)} ${esc(g.d)} ${g.link ? `· <a href="${esc(g.link)}" target="_blank" rel="noopener">partia</a>` : ''}<br><span class="muted">Znajdź lepszy ruch.</span>`,
    async checkAlt(uci, fenAfter, idx) {
      if (idx !== 0) return false;
      const after = await quickEval(fenAfter);
      if (!after) return false;
      return C.povWin(item.ev, item.color) - C.povWin(after, item.color) < 3;
    },
    async onDone(ok) {
      const all = await getMistakes();
      const it = all.find((m) => m.id === item.id);
      if (!it) return;
      if (ok) { it.streak++; it.due = Date.now() + [1, 3, 7, 14, 30, 60, 120][Math.min(it.streak - 1, 6)] * DAY; }
      else { it.streak = 0; it.due = Date.now() + 10 * 60000; }
      await saveMistakes(all);
      refreshMistakesInfo();
    },
    next: nextMistake,
  }, 'mk-box');
  refreshMistakesInfo();
}

// ---------------------------------------------------------------- drille debiutowe
async function repList() {
  const keys = await idb.keys('rep:');
  return (await Promise.all(keys.map((k) => idb.get(k)))).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}
function repProgress(rep) {
  let total = 0, learned = 0;
  const now = Date.now();
  for (const [key, moves] of Object.entries(rep.tree)) {
    if (key.split(' ')[1] !== rep.color || !Object.keys(moves).length) continue;
    total++;
    const s = rep.stats[key];
    if (s && s.ok > 0 && s.due > now) learned++;
  }
  return { total, learned };
}
/** Liczba pozycji do powtórki (już ćwiczone, termin minął) – do kafelków i strony głównej. */
export function repDue(rep) {
  const now = Date.now(); let n = 0;
  for (const [key, moves] of Object.entries(rep.tree)) {
    if (key.split(' ')[1] !== rep.color || !Object.keys(moves).length) continue;
    const s = rep.stats[key];
    if (s && s.ok + s.bad > 0 && s.due <= now) n++;
  }
  return n;
}
/** Pozycja „okładki”: koniec głównej linii (maks. 10 półruchów). */
export function repCoverFen(rep) {
  let fen = START;
  for (let i = 0; i < 10; i++) {
    const node = rep.tree[epd(fen)];
    const u = node && Object.values(node)[0];
    if (!u) break;
    try { fen = playOn(fen, u).fen; } catch { break; }
  }
  return fen;
}
async function renderRepList() {
  const reps = await repList();
  $('rep-list').innerHTML = reps.length ? reps.map((r) => {
    const p = repProgress(r);
    const due = repDue(r);
    const seen = Object.keys(r.stats).length;
    const pct = p.total ? Math.round((p.learned / p.total) * 100) : 0;
    const pctSeen = p.total ? Math.min(100, Math.round((seen / p.total) * 100)) : 0;
    return `<div class="course" data-id="${r.id}">
      <div class="course-cover">${A.miniBoard(repCoverFen(r), { flip: r.color === 'b' })}</div>
      <div class="course-body">
        <div class="course-title">${esc(r.name)} <span class="pill">${r.color === 'w' ? '⚪ białe' : '⚫ czarne'}</span></div>
        <div class="course-prog">
          <div><small class="mono">${Math.min(seen, p.total)} / ${p.total} pozycji poznanych</small><div class="bar"><div style="width:${pctSeen}%;background:#6aa8ff"></div></div></div>
          <div><small class="mono">${p.learned} / ${p.total} opanowanych · ${r.lines} linii</small><div class="bar"><div style="width:${pct}%"></div></div></div>
        </div>
      </div>
      <div class="course-btns">
        <button class="btn review ${due ? '' : 'off'}" data-r="review">Powtórka${due ? `<span class="due">${due}</span>` : ''}</button>
        <button class="btn primary" data-r="learn">Ucz się</button>
        <div class="course-more">
          <label class="icon-btn" title="Dodaj warianty z pliku PGN">＋PGN<input type="file" accept=".pgn,.txt" multiple hidden data-r="add"></label>
          <button class="icon-btn" data-r="del" title="Usuń drill">✕</button>
        </div>
      </div></div>`;
  }).join('') : '<p class="muted">Nie masz jeszcze żadnego drilla. Utwórz go poniżej, np. z pliku PGN z wariantami (eksport z ChessBase, studium lichess).</p>';
}

async function createRep() {
  const name = $('rep-name').value.trim() || 'Mój repertuar';
  const color = $('rep-color').value;
  let text = $('rep-pgn').value.trim();
  for (const f of $('rep-file').files) text += '\n\n' + (await f.text());
  if ($('rep-from-game').checked) {
    const g = A.S.game;
    const sans = g.moves.map((m) => m.san);
    if (A.S.explore) {
      sans.length = A.S.explore.base;
      sans.push(...A.S.explore.moves.map((m) => m.san));
    }
    text += '\n\n' + sans.join(' ');
  }
  if (!text.trim()) return A.toast('Dodaj plik PGN, wklej warianty albo zaznacz „bieżąca partia”.');
  const { tree, moves, games } = treeFromPgn(text);
  if (!moves) return A.toast('Nie znalazłem ruchów w tym PGN.');
  const rep = { id: Date.now().toString(36), name, color, tree, stats: {}, lines: countLines(tree), created: Date.now() };
  await idb.set('rep:' + rep.id, rep);
  $('rep-pgn').value = ''; $('rep-file').value = ''; $('rep-name').value = '';
  A.toast(`Utworzono drill „${name}”: ${games} partii/rozdziałów, ${rep.lines} linii.`);
  renderRepList();
}

const DR = {};
function needScore(rep, fen, depth, memo) {
  const key = epd(fen);
  if (memo.has(key)) return memo.get(key);
  const node = rep.tree[key];
  if (!node || depth > 40 || !Object.keys(node).length) return 0;
  memo.set(key, 0);
  let score = 0;
  const turn = key.split(' ')[1];
  if (turn === rep.color) {
    const s = rep.stats[key];
    score += !s ? 2 : s.bad * 3 + (s.due <= Date.now() ? 1.5 : 0) + 0.1;
  }
  for (const uci of Object.values(node)) {
    try { score += needScore(rep, playOn(fen, uci).fen, depth + 1, memo) * 0.9; } catch {}
  }
  memo.set(key, score);
  return score;
}

export async function startDrill(id, mode) {
  const rep = await idb.get('rep:' + id);
  if (!rep) return;
  mode = mode || DR.mode || 'review';
  Object.assign(DR, { rep, mode, fen: START, last: null, errs: 0, line: (DR.rep?.id === id ? DR.line : 0) + 1, wrongNow: 0, waiting: false });
  $('drill-box').hidden = false;
  drillStatus(`${mode === 'learn' ? 'Nauka' : 'Powtórka'} · linia ${DR.line}. Graj ${rep.color === 'w' ? 'białymi' : 'czarnymi'} według „${esc(rep.name)}”.`);
  current = { kind: 'drill', resume: drillView };
  drillStep();
}
function drillStatus(html, cls = '') {
  const el = $('drill-status'); el.className = 'pz-status ' + cls; el.innerHTML = html;
  if (cls === 'bad') fx.shake(el); else if (cls === 'ok') fx.pop(el);
}
function drillView(shapes = []) {
  show({ fen: DR.fen, lastMove: DR.last, orientation: DR.rep.color === 'w' ? 'white' : 'black', shapes, onMove: drillMove });
}
async function drillStep() {
  const node = DR.rep.tree[epd(DR.fen)];
  if (!node || !Object.keys(node).length) return drillLineDone();
  const turn = DR.fen.split(' ')[1];
  if (turn === DR.rep.color) {
    DR.wrongNow = 0;
    const st = DR.rep.stats[epd(DR.fen)];
    if (DR.mode === 'learn' && (!st || !st.ok)) {
      DR.wrongNow = 1; // podpowiedź = ruch nie liczy się jako opanowany za pierwszym razem
      drillStatus(`Nowa pozycja – zagraj zaznaczony ruch: <b>${esc(Object.keys(node).join(', '))}</b>`);
      drillView(Object.values(node).map((u) => ({ orig: u.slice(0, 2), dest: u.slice(2, 4), brush: 'blue' })));
      return;
    }
    drillView(); return;
  }
  drillView();
  await sleep(420);
  const entries = Object.entries(node);
  const memo = new Map();
  const weights = entries.map(([, u]) => { try { return 0.3 + needScore(DR.rep, playOn(DR.fen, u).fen, 0, memo); } catch { return 0; } });
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  let pick = entries[0];
  for (let i = 0; i < entries.length; i++) { r -= weights[i]; if (r <= 0) { pick = entries[i]; break; } }
  const res = playOn(DR.fen, pick[1]);
  DR.fen = res.fen; DR.last = [res.m.from, res.m.to];
  A.sound.forSan(res.m.san);
  drillStep();
}
async function drillMove(uci, m, fenAfter) {
  const key = epd(DR.fen);
  const node = DR.rep.tree[key] || {};
  const ok = Object.values(node).includes(uci);
  const s = DR.rep.stats[key] || (DR.rep.stats[key] = { ok: 0, bad: 0, due: 0 });
  if (ok) {
    if (!DR.wrongNow) { s.ok++; s.due = Date.now() + [1, 2, 4, 8, 16, 32][Math.min(s.ok - 1, 5)] * DAY; s.bad = Math.max(0, s.bad - 1); }
    DR.fen = fenAfter; DR.last = [m.from, m.to];
    A.sound.forSan(m.san);
    drillStatus(`✓ ${esc(m.san)}`, 'ok');
    idb.set('rep:' + DR.rep.id, DR.rep);
    return drillStep();
  }
  DR.wrongNow++; DR.errs++;
  s.bad++; s.due = 0;
  idb.set('rep:' + DR.rep.id, DR.rep);
  A.sound.play('Error');
  const sans = Object.keys(node);
  const prev = { fen: DR.fen, last: DR.last };
  DR.fen = fenAfter; DR.last = [m.from, m.to]; drillView();
  await sleep(600);
  DR.fen = prev.fen; DR.last = prev.last;
  const arrows = DR.wrongNow >= 2 ? Object.values(node).map((u) => ({ orig: u.slice(0, 2), dest: u.slice(2, 4), brush: 'green' })) : [];
  drillStatus(DR.wrongNow >= 2 ? `✕ W repertuarze: <b>${esc(sans.join(', '))}</b> – zagraj to.` : `✕ ${esc(m.san)} nie jest w repertuarze. Spróbuj jeszcze.`, 'bad');
  drillView(arrows);
}
function drillLineDone() {
  A.sound.play(DR.errs ? 'GenericNotify' : 'Confirmation');
  drillStatus(DR.errs ? `Koniec linii – błędy: ${DR.errs}. Następna linia za chwilę…` : '✓ Linia bez błędu! Następna za chwilę…', DR.errs ? '' : 'ok');
  drillView();
  renderRepList();
  const id = DR.rep.id;
  setTimeout(() => { if (current?.kind === 'drill' && DR.rep?.id === id && !$('tab-study').hidden && !$('study-drills').hidden) startDrill(id); }, 1600);
}

// ---------------------------------------------------------------- trener (jak Lichess Tutor)
const tutorEngine = new Engine('tutor');
const TU = { running: false };
function speedOf(tc) {
  if (!tc || tc === '-') return 'classical';
  if (tc.includes('/')) return 'daily';
  const [b, inc] = tc.split('+').map(Number);
  const t = (b || 0) + 40 * (inc || 0);
  return t < 180 ? 'bullet' : t < 480 ? 'blitz' : t < 1500 ? 'rapid' : 'classical';
}
function clocksOf(pgn) {
  const out = [];
  const re = /\[%clk (\d+):(\d+):(\d+(?:\.\d+)?)\]/g;
  let m;
  while ((m = re.exec(pgn))) out.push(+m[1] * 3600 + +m[2] * 60 + +m[3]);
  return out;
}
function phaseOf(fen, ply) {
  const board = fen.split(' ')[0];
  const pieces = (board.match(/[nbrqNBRQ]/g) || []).length;
  if (pieces <= 6) return 'end';
  return ply < 20 ? 'open' : 'mid';
}

async function analyseGameForTutor(pgn, user, depth) {
  const g = buildGame(pgn);
  const h = g.headers;
  const u = user.toLowerCase();
  const color = (h.White || '').toLowerCase() === u ? 'w' : (h.Black || '').toLowerCase() === u ? 'b' : null;
  if (!color || g.moves.length < 6) return null;
  const id = A.engineId();
  await tutorEngine.setEngine(id);
  const evals = [];
  for (let i = 0; i <= g.moves.length; i++) {
    if (!TU.running) return null;
    const fen = i ? g.moves[i - 1].fenAfter : g.startFen;
    const term = A.terminalEval(fen);
    if (term) { evals[i] = term; continue; }
    const res = await tutorEngine.analyse(fen, id === 'lc0' ? { multipv: 2, nodes: 400 } : { multipv: 2, depth });
    if (!res?.lines.length) { if (!TU.running) return null; evals[i] = { cp: 0, mate: null, pv: [] }; continue; }
    const [a, b] = res.lines;
    evals[i] = { cp: a.cp, mate: a.mate, pv: a.pv, best: res.bestmove || a.pv[0], depth: a.depth, second: b ? { cp: b.cp, mate: b.mate } : null };
  }
  const review = C.classifyGame(g, evals, A.openings());
  await addMistakesFromReview(g, evals, review, [color]);
  const clocks = clocksOf(pgn);
  const base = +((h.TimeControl || '').split('+')[0]) || 0;
  const res = h.Result === '1-0' ? (color === 'w' ? 'win' : 'loss') : h.Result === '0-1' ? (color === 'b' ? 'win' : 'loss') : 'draw';
  const counts = {};
  const phase = { open: [0, 0], mid: [0, 0], end: [0, 0] };
  const errs = [];
  let maxWp = 0, minWp = 100;
  let opening = null;
  review.forEach((r, i) => {
    const mv = g.moves[i];
    const on = A.openings()[epd(mv.fenAfter)];
    if (on) opening = on;
    if (!r || mv.color !== color) return;
    counts[r.cls] = (counts[r.cls] || 0) + 1;
    const ph = phaseOf(mv.fenBefore, i);
    phase[ph][0] += r.acc; phase[ph][1]++;
    maxWp = Math.max(maxWp, r.wpB); minWp = Math.min(minWp, r.wpB);
    if (C.ERROR_CLASSES.includes(r.cls)) {
      const clock = clocks.length >= g.moves.length ? clocks[i] : null;
      errs.push({ cls: r.cls, ph, clock, low: clock !== null && clock < Math.max(15, Math.min(60, base * 0.1)), text: r.text || '', ply: i });
    }
  });
  const acc = C.gameAccuracy(review, color, g.moves);
  const oppAcc = C.gameAccuracy(review, color === 'w' ? 'b' : 'w', g.moves);
  return {
    date: (h.UTCDate || h.Date || '').replace(/\./g, '-'), color, res, speed: speedOf(h.TimeControl),
    opening: opening ? opening.n.split(':')[0] : 'Inne', openingFull: opening?.n || '', eco: h.ECO || opening?.e || '',
    acc, oppAcc, counts, phase, errs, wonPos: maxWp >= 85, lostPos: minWp <= 15,
    white: h.White, black: h.Black, link: h.Link || (h.Site?.startsWith('http') ? h.Site : ''),
    elo: color === 'w' ? +h.WhiteElo || null : +h.BlackElo || null, moves: g.moves.length,
  };
}

async function runTutor() {
  if (TU.running) { TU.running = false; tutorEngine.stop(); return; }
  const site = $('tu-site').value, user = $('tu-user').value.trim();
  if (!user) return A.toast('Wpisz nazwę użytkownika');
  A.store.set('tuUser', user); A.store.set('tuSite', site);
  const count = $('tu-count').value === 'all' ? Infinity : +$('tu-count').value;
  const speed = $('tu-speed').value;
  const depth = +$('tu-depth').value || 12;
  const st = (t) => ($('tu-status').textContent = t);
  TU.running = true;
  $('tu-run').textContent = 'Zatrzymaj';
  $('tu-progress').hidden = false;
  try {
    const fetchN = speed === 'all' ? count : Math.min(Infinity, count * 4);
    let pgns = await A.fetchUserPgns(site, user, fetchN, st, { clocks: true });
    if (speed !== 'all') pgns = pgns.filter((p) => speedOf(parseHeaders(p).TimeControl) === speed);
    pgns = pgns.slice(0, count);
    const key = 'tutor:' + site + ':' + user.toLowerCase();
    const cache = (await idb.get(key)) || {};
    let done = 0;
    const t0 = performance.now();
    let fresh = 0;
    for (const pgn of pgns) {
      if (!TU.running) break;
      const h = parseHeaders(pgn);
      const gid = h.Link || h.Site + '|' + (h.UTCDate || h.Date) + '|' + (h.UTCTime || '') + '|' + h.White + '|' + h.Black;
      if (!cache[gid]) {
        const sum = await analyseGameForTutor(pgn, user, depth);
        if (!TU.running) break;
        if (sum) { cache[gid] = sum; fresh++; await idb.set(key, cache); }
      }
      done++;
      const per = fresh ? (performance.now() - t0) / fresh : 0;
      $('tu-bar').style.width = (done / pgns.length) * 100 + '%';
      st(`Przeanalizowano ${done}/${pgns.length} partii${per ? ` · ~${Math.ceil((per * (pgns.length - done)) / 60000)} min do końca` : ''}`);
      if (fresh && fresh % 5 === 0) renderTutorReport();
    }
    st(TU.running ? `Gotowe: ${done} partii.` : `Zatrzymano po ${done} partiach (wyniki zapisane – możesz wznowić).`);
  } catch (e) { st('Błąd: ' + e.message); }
  TU.running = false;
  $('tu-run').textContent = 'Analizuj moje partie';
  $('tu-progress').hidden = true;
  renderTutorReport();
  refreshMistakesInfo();
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pct = (x) => (x === null || isNaN(x) ? '–' : Math.round(x) + '%');
const f1 = (x) => (x === null || isNaN(x) ? '–' : x.toFixed(1));

async function renderTutorReport() {
  const site = $('tu-site').value, user = $('tu-user').value.trim();
  const box = $('tu-report');
  if (!user) { box.innerHTML = ''; return; }
  const cache = (await idb.get('tutor:' + site + ':' + user.toLowerCase())) || {};
  const speed = $('tu-speed').value;
  const games = Object.values(cache).filter((g) => speed === 'all' || g.speed === speed).sort((a, b) => b.date.localeCompare(a.date));
  if (!games.length) { box.innerHTML = '<p class="muted">Brak przeanalizowanych partii. Kliknij „Analizuj moje partie”.</p>'; return; }
  const n = games.length;
  const wins = games.filter((g) => g.res === 'win').length, draws = games.filter((g) => g.res === 'draw').length;
  const accAll = avg(games.map((g) => g.acc).filter((x) => x !== null));
  const byColor = (c) => games.filter((g) => g.color === c);
  const score = (gs) => (gs.length ? ((gs.filter((g) => g.res === 'win').length + 0.5 * gs.filter((g) => g.res === 'draw').length) / gs.length) * 100 : null);
  const phaseAcc = (ph) => { let s = 0, k = 0; for (const g of games) { s += g.phase[ph][0]; k += g.phase[ph][1]; } return k ? s / k : null; };
  const per = (cls) => games.reduce((s, g) => s + (g.counts[cls] || 0), 0) / n;
  const allErrs = games.flatMap((g) => g.errs);
  const hangs = allErrs.filter((e) => /zostawia|zabiera/.test(e.text)).length;
  const missedMates = allErrs.filter((e) => e.cls === 'miss' && /mat w/.test(e.text)).length;
  const missedForks = allErrs.filter((e) => e.cls === 'miss' && /widełki/.test(e.text)).length;
  const missedMaterial = allErrs.filter((e) => e.cls === 'miss' && /wygrywa materiał|wiszącej/.test(e.text)).length;
  const withClock = allErrs.filter((e) => e.clock !== null);
  const lowShare = withClock.length ? (withClock.filter((e) => e.low).length / withClock.length) * 100 : null;
  const wonPos = games.filter((g) => g.wonPos);
  const wasted = wonPos.filter((g) => g.res !== 'win').length;
  const lostPos = games.filter((g) => g.lostPos);
  const saved = lostPos.filter((g) => g.res !== 'loss').length;
  const elos = games.map((g) => g.elo).filter(Boolean);
  // otwarcia
  const ops = {};
  for (const g of games) {
    const k = (g.color === 'w' ? '⚪ ' : '⚫ ') + g.opening;
    (ops[k] ||= []).push(g);
  }
  const opRows = Object.entries(ops).filter(([, gs]) => gs.length >= 2).map(([k, gs]) => ({
    k, n: gs.length, score: score(gs), acc: avg(gs.map((g) => g.acc).filter((x) => x !== null)),
    err: gs.reduce((s, g) => s + g.errs.length, 0) / gs.length,
  })).sort((a, b) => b.n - a.n).slice(0, 14);
  const worstOp = [...opRows].filter((o) => o.n >= 3).sort((a, b) => (a.score + a.acc) - (b.score + b.acc))[0];

  // plan
  const plan = [];
  const ph = { open: phaseAcc('open'), mid: phaseAcc('mid'), end: phaseAcc('end') };
  if (hangs / n >= 0.5) plan.push(['Często zostawiasz figury bez obrony lub dajesz je zabrać.', 'hangingPiece']);
  if (missedForks >= Math.max(2, n * 0.1)) plan.push(['Przegapiasz widełki.', 'fork']);
  if (missedMates >= Math.max(2, n * 0.08)) plan.push(['Przegapiasz maty.', 'mateIn2']);
  if (missedMaterial >= Math.max(3, n * 0.15)) plan.push(['Nie zabierasz materiału, który przeciwnik zostawił.', 'hangingPiece']);
  if (ph.end !== null && ph.mid !== null && ph.end < ph.mid - 5) plan.push(['W końcówkach grasz słabiej niż w grze środkowej.', 'endgame']);
  if (ph.open !== null && ph.mid !== null && ph.open < ph.mid - 5) plan.push(['Najwięcej tracisz w debiucie – zrób drill swoich otwarć.', 'opening']);
  if (wonPos.length >= 3 && wasted / wonPos.length > 0.3) plan.push([`Nie wygrywasz ${Math.round((wasted / wonPos.length) * 100)}% wygranych pozycji – ćwicz realizację przewagi.`, 'crushing']);
  if (lowShare !== null && lowShare > 35) plan.push([`${Math.round(lowShare)}% Twoich błędów pada w niedoczasie – graj szybciej w debiucie albo wybieraj dłuższe tempo.`, null]);
  if (worstOp) plan.push([`Najsłabiej idzie Ci: ${worstOp.k} (wynik ${pct(worstOp.score)}, dokładność ${f1(worstOp.acc)}).`, null]);
  if (!plan.length) plan.push(['Brak wyraźnej słabości – trenuj mieszane zadania.', 'mix']);

  const bar = (v, color = 'var(--accent)') => `<div class="bar"><div style="width:${Math.max(0, Math.min(100, v ?? 0))}%;background:${color}"></div></div>`;
  box.innerHTML = `
    <div class="tu-cards">
      <div class="tu-card"><small>Partie</small><b>${n}</b><span>${wins}W / ${draws}R / ${n - wins - draws}P</span></div>
      <div class="tu-card"><small>Dokładność</small><b>${f1(accAll)}</b><span>białe ${f1(avg(byColor('w').map((g) => g.acc).filter((x) => x !== null)))} · czarne ${f1(avg(byColor('b').map((g) => g.acc).filter((x) => x !== null)))}</span></div>
      <div class="tu-card"><small>Ranking</small><b>${elos.length ? Math.round(avg(elos)) : '–'}</b><span>z partii: ~${C.estimateRating(accAll) ?? '–'}</span></div>
      <div class="tu-card"><small>Wynik</small><b>${pct(score(games))}</b><span>białe ${pct(score(byColor('w')))} · czarne ${pct(score(byColor('b')))}</span></div>
    </div>
    <h3>Plan treningowy</h3>
    <div class="tu-plan">${plan.map(([t, theme]) => `<div class="tu-plan-row"><span>${esc(t)}</span>${theme ? `<button class="btn" data-theme="${theme}">Zadania: ${esc(THEME_PL[theme] || theme)}</button>` : ''}</div>`).join('')}
      <div class="tu-plan-row"><span>Twoje błędy z tych partii czekają jako zadania.</span><button class="btn primary" data-go="mistakes">Ćwicz moje błędy</button></div></div>
    <h3>Gdzie tracisz (błędy wg fazy)</h3>
    ${(() => {
      const byPh = { open: 0, mid: 0, end: 0 };
      for (const e of allErrs) byPh[e.ph]++;
      const tot = allErrs.length || 1;
      const cols = { open: '#b9a2ff', mid: '#8b5cf6', end: '#5b3fb0' };
      const names = { open: 'Debiut', mid: 'Gra środkowa', end: 'Końcówka' };
      return `<div class="card"><div class="stack">${Object.keys(byPh).map((k) => `<div style="width:${(byPh[k] / tot) * 100}%;background:${cols[k]}"></div>`).join('')}</div>
        <div class="legend">${Object.keys(byPh).map((k) => `<span><i style="background:${cols[k]}"></i>${names[k]}<b>${byPh[k]} · ${Math.round((byPh[k] / tot) * 100)}%</b></span>`).join('')}</div></div>`;
    })()}
    <h3>Fazy partii (dokładność)</h3>
    <table class="tu-table">
      <tr><td>Debiut</td><td>${bar(ph.open)}</td><td>${f1(ph.open)}</td></tr>
      <tr><td>Gra środkowa</td><td>${bar(ph.mid)}</td><td>${f1(ph.mid)}</td></tr>
      <tr><td>Końcówka</td><td>${bar(ph.end)}</td><td>${f1(ph.end)}</td></tr>
    </table>
    <h3>Błędy na partię</h3>
    <table class="tu-table">
      ${['blunder', 'mistake', 'miss', 'inaccuracy'].map((c) => `<tr><td>${A.badgeHtml(c, 18)} ${C.CLASSES[c].label}</td><td>${bar((per(c) / 4) * 100, C.CLASSES[c].color)}</td><td>${per(c).toFixed(2)}</td></tr>`).join('')}
    </table>
    <h3>Motywy i sytuacje</h3>
    <table class="tu-table">
      <tr><td>Oddane figury (podstawki)</td><td colspan="2">${hangs} (${(hangs / n).toFixed(2)} na partię)</td></tr>
      <tr><td>Przegapione maty</td><td colspan="2">${missedMates}</td></tr>
      <tr><td>Przegapione widełki</td><td colspan="2">${missedForks}</td></tr>
      <tr><td>Niezabrany materiał</td><td colspan="2">${missedMaterial}</td></tr>
      <tr><td>Błędy w niedoczasie</td><td colspan="2">${lowShare === null ? 'brak danych o zegarze' : pct(lowShare) + ' błędów'}</td></tr>
      <tr><td>Wygrane pozycje (≥85%)</td><td colspan="2">${wonPos.length} partii · zmarnowane ${wasted}</td></tr>
      <tr><td>Przegrane pozycje (≤15%)</td><td colspan="2">${lostPos.length} partii · uratowane ${saved}</td></tr>
    </table>
    <h3>Otwarcia</h3>
    <table class="tu-table ops"><tr><th>Otwarcie</th><th>Partie</th><th>Wynik</th><th>Dokł.</th><th>Błędy/p.</th></tr>
      ${opRows.map((o) => `<tr class="${o === worstOp ? 'worst' : ''}"><td>${esc(o.k)}</td><td>${o.n}</td><td>${pct(o.score)}</td><td>${f1(o.acc)}</td><td>${o.err.toFixed(1)}</td></tr>`).join('')}
    </table>
    <h3>Ostatnie partie</h3>
    <div class="tu-games">${games.slice(0, 30).map((g) => `<div class="tu-game"><span class="res ${g.res}">${g.res === 'win' ? 'W' : g.res === 'loss' ? 'P' : 'R'}</span><span>${esc(g.white)} – ${esc(g.black)}</span><span class="muted">${esc(g.opening)}</span><span class="muted">${f1(g.acc)}</span>${g.link ? `<a href="${esc(g.link)}" target="_blank" rel="noopener">↗</a>` : '<span></span>'}</div>`).join('')}</div>
    <p class="muted" style="margin-top:14px">Porównanie z innymi graczami o tym samym rankingu nie jest dostępne (lichess nie udostępnia tych danych publicznie). Wyniki dotyczą tempa: ${$('tu-speed').selectedOptions[0].textContent}.</p>`;
  for (const b of box.querySelectorAll('.tu-card b')) {
    const t = b.textContent; const v = parseFloat(t);
    if (!isNaN(v)) fx.countUp(b, v, t.includes('.') ? 1 : 0, { suffix: t.endsWith('%') ? '%' : '' });
  }
  fx.enter(box.querySelectorAll('.tu-card, h3, .tu-plan-row, .card, .tu-table tr'), { step: 18 });
  fx.grow(box.querySelectorAll('.bar > div, .stack > div'));
}

// ---------------------------------------------------------------- inicjalizacja
export function initTraining(api) {
  A = api;
  $('pz-theme').innerHTML = THEMES.map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  $('pz-theme').value = A.store.get('pzTheme', 'mix');
  $('pz-diff').value = A.store.get('pzDiff', 'normal');
  $('train-sub').onclick = (e) => { const s = e.target.dataset.sub; if (s) setSub(s); };
  $('pz-start').onclick = nextLichessPuzzle;
  $('train-pzhome').addEventListener('click', (e) => {
    const t = e.target.closest('[data-theme]')?.dataset.theme;
    if (t) { $('pz-theme').value = t; setSub('puzzles'); nextLichessPuzzle(); return; }
    const m = e.target.closest('[data-pz]')?.dataset.pz;
    if (m) openPuzzles(m);
  });
  for (const b of document.querySelectorAll('[data-rush]')) b.onclick = () => startRush(b.dataset.rush);
  $('mk-start').onclick = nextMistake;
  $('mk-clear').onclick = async () => {
    if (!confirm('Usunąć wszystkie zadania z Twoich błędów?')) return;
    await saveMistakes([]); $('mk-box').innerHTML = ''; refreshMistakesInfo();
  };
  $('rep-create').onclick = createRep;
  // wybór pliku od razu tworzy drill (nazwa z pliku, jeśli pusta)
  $('rep-file').onchange = async () => {
    const files = [...$('rep-file').files];
    if (!files.length) return;
    if (!$('rep-name').value.trim()) {
      const h = parseHeaders(await files[0].text());
      $('rep-name').value = h.StudyName || (h.Event && h.Event !== '?' ? h.Event.split(': ')[0] : '') || files[0].name.replace(/\.(pgn|txt)$/i, '');
    }
    $('rep-file-status').textContent = `Wczytuję: ${files.map((f) => f.name).join(', ')}…`;
    await createRep();
    $('rep-file-status').textContent = '';
  };
  $('rep-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-r]');
    const id = e.target.closest('[data-id]')?.dataset.id;
    if (!b || !id || b.dataset.r === 'add') return;
    if (b.dataset.r === 'drill' || b.dataset.r === 'review') { DR.line = 0; startDrill(id, 'review'); }
    if (b.dataset.r === 'learn') { DR.line = 0; startDrill(id, 'learn'); }
    if (b.dataset.r === 'del') {
      const rep = await idb.get('rep:' + id);
      if (confirm(`Usunąć drill „${rep?.name}”?`)) { await idb.del('rep:' + id); renderRepList(); }
    }
  });
  $('rep-list').addEventListener('change', async (e) => {
    if (e.target.dataset.r !== 'add') return;
    const id = e.target.closest('[data-id]').dataset.id;
    const rep = await idb.get('rep:' + id);
    let added = 0;
    for (const f of e.target.files) for (const g of splitGames(await f.text())) added += addGameToTree(g, rep.tree);
    rep.lines = countLines(rep.tree);
    await idb.set('rep:' + id, rep);
    A.toast(`Dodano ${added} ruchów do „${rep.name}”.`);
    renderRepList();
  });
  $('drill-hint').onclick = () => {
    const node = DR.rep?.tree[epd(DR.fen)];
    if (!node) return;
    DR.wrongNow = Math.max(DR.wrongNow, 1);
    drillView(Object.values(node).map((u) => ({ orig: u.slice(0, 2), dest: u.slice(2, 4), brush: 'green' })));
  };
  $('drill-restart').onclick = () => DR.rep && startDrill(DR.rep.id);
  $('drill-stop').onclick = () => { $('drill-box').hidden = true; current = null; A.S.train = null; A.render(); };
  $('tu-user').value = A.store.get('tuUser', A.store.get('ccUser', '') || A.store.get('treeUser', ''));
  $('tu-site').value = A.store.get('tuSite', 'chesscom');
  $('tu-run').onclick = runTutor;
  for (const id of ['tu-site', 'tu-user', 'tu-speed']) $(id).addEventListener('change', renderTutorReport);
  $('tu-report').addEventListener('click', (e) => {
    const t = e.target.closest('[data-theme]')?.dataset.theme;
    if (t) { A.showTab('puzzles'); $('pz-theme').value = t; setSub('puzzles'); nextLichessPuzzle(); }
    if (e.target.closest('[data-go="mistakes"]')) { A.showTab('puzzles'); setSub('mistakes'); nextMistake(); }
  });
  renderPzStats();
  setSub((['pzhome', 'puzzles', 'rush', 'mistakes'].includes(A.store.get('trainSub', 'pzhome')) ? A.store.get('trainSub', 'pzhome') : 'pzhome'));
}

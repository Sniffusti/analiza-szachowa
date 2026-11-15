// Ułatwienia jak na lichess/chess.com: wyszukiwarka poleceń (Ctrl+K), skróty („?”), udostępnianie
// partii linkiem, tryb Zen, ustawienia planszy, trening współrzędnych.
import { icon } from './icons.js';
import * as fx from './fx.js';

let A;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l');

// ---------------------------------------------------------------- wyszukiwarka poleceń
function commands() {
  const go = (tab, fn) => () => { A.showTab(tab); fn?.(); };
  return [
    ['Start – strona główna', 'home dom', go('home')],
    ['Graj z botem', 'kot boty silnik', () => A.play.bots()],
    ['Kariera z silnikiem', 'ranking awans', () => A.play.career()],
    ['Graj online / ze znajomym', 'link matchmaking przeciwnik', () => A.play.friend()],
    ['Graj na lichess', 'lichess seek', go('play', () => document.querySelector('#play-sub [data-sub=lichess]')?.click())],
    ['Graj od tej pozycji (z botem)', 'kontynuuj silnik pozycja', () => A.playFromPosition()],
    ['Zadania z rankingiem', 'puzzle taktyka', () => A.openPuzzles('puzzles')],
    ['Puzzle Rush', 'czas szybkie', () => A.openPuzzles('rush')],
    ['Puzzle Streak (seria)', 'seria bez błędu', () => A.openPuzzles('rush', 'streak')],
    ['Zadanie dnia', 'daily', () => A.openPuzzles('daily')],
    ['Moje błędy – zadania', 'bledy powtorka', () => A.openPuzzles('mistakes')],
    ['Trening współrzędnych', 'pola wspolrzedne coordinates', () => startCoords()],
    ['Trener – analiza moich partii', 'tutor statystyki', go('train')],
    ['Drille debiutowe', 'repertuar kurs', () => A.openDrills()],
    ['Opracowania (studia lichess)', 'study komentarze', go('study')],
    ['Nowa analiza', 'pusta plansza', () => A.newAnalysis()],
    ['Wczytaj PGN / FEN', 'import wklej', go('analysis', () => A.anSub('menu'))],
    ['Ustaw pozycję (edytor)', 'edytor fen', () => A.editor()],
    ['Książeczka debiutów', 'otwarcia ksiazka', go('analysis', () => A.anSub('book'))],
    ['Eksplorator otwarć', 'mistrzowie lichess baza', go('openings')],
    ['Przegląd partii (raport)', 'review dokladnosc', go('report')],
    ['Analizuj partię silnikiem', 'review raport', go('report', () => $('btn-review').click())],
    ['Pokaż zagrożenie przeciwnika', 'threat x', () => A.threat()],
    ['Import z chess.com / lichess', 'pobierz partie', go('import')],
    ['Zapisz analizę', 'serce zapis', () => $('btn-save').click()],
    ['Udostępnij partię linkiem', 'link share wyslij', () => sharePgn()],
    ['Obróć szachownicę', 'flip', () => $('btn-flip').click()],
    ['Tryb Zen (sama szachownica)', 'skupienie zen', () => toggleZen()],
    ['Ustawienia – bierki i plansza', 'wyglad', go('settings')],
    ['Profil i konto', 'konto avatar lichess', go('settings')],
    ['Skróty klawiszowe', 'pomoc klawiatura', () => shortcuts()],
  ];
}
let sel = 0;
function openPalette() {
  const box = $('palette');
  box.hidden = false;
  $('pal-q').value = '';
  renderPalette();
  $('pal-q').focus();
  fx.pop(box.firstElementChild);
}
function closePalette() { $('palette').hidden = true; }
function renderPalette() {
  const q = norm($('pal-q').value.trim());
  const list = commands().filter(([l, k]) => !q || norm(l + ' ' + k).includes(q));
  sel = Math.min(sel, Math.max(0, list.length - 1));
  $('pal-list').innerHTML = list.map(([l], i) => `<button class="pal-item ${i === sel ? 'on' : ''}" data-i="${i}">${esc(l)}</button>`).join('') || '<div class="muted" style="padding:10px">Nic nie znaleziono.</div>';
  $('pal-list').onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) { closePalette(); list[+b.dataset.i][2](); } };
  $('pal-q').onkeydown = (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(list.length - 1, sel + 1); renderPalette(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); renderPalette(); e.preventDefault(); }
    else if (e.key === 'Enter' && list[sel]) { closePalette(); list[sel][2](); }
    else if (e.key === 'Escape') closePalette();
  };
}

function shortcuts() {
  const rows = [['Ctrl + K', 'Wyszukiwarka – przejdź gdziekolwiek'], ['← →', 'Poprzedni / następny ruch'], ['Home / End', 'Początek / koniec partii'], ['F', 'Obróć szachownicę'], ['X', 'Pokaż zagrożenie przeciwnika'], ['A', 'Strzałka najlepszego ruchu – włącz / wyłącz'], ['Z', 'Tryb Zen (sama szachownica)'], ['Esc', 'Wróć z wariantu do partii'], ['Prawy klik', 'Strzałki i kółka na planszy; w partii anuluje premove'], ['?', 'Ta lista skrótów']];
  $('modal').hidden = false;
  $('modal-body').innerHTML = `<h3 style="margin-top:0">Skróty klawiszowe</h3><table class="keys">${rows.map(([k, d]) => `<tr><td><kbd>${esc(k)}</kbd></td><td>${esc(d)}</td></tr>`).join('')}</table>`;
}

// ---------------------------------------------------------------- udostępnianie partii linkiem
function b64(s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64(s) { return decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))); }
async function sharePgn() {
  const pgn = A.exportPgn().replace(/\{[^}]*\}/g, '').replace(/\s+\$\d+/g, '').replace(/[ \t]+/g, ' ');
  const url = `${location.origin}${location.pathname}#pgn=${b64(pgn)}`;
  try { await navigator.clipboard.writeText(url); A.toast('Skopiowano link do partii – wyślij go komuś.'); } catch { prompt('Skopiuj link:', url); }
}
function loadFromHash() {
  const m = location.hash.match(/#pgn=([\w-]+)/);
  if (!m) return false;
  try { A.loadPgn(unb64(m[1])); history.replaceState(null, '', location.pathname); return true; } catch { return false; }
}

// ---------------------------------------------------------------- tryb Zen i ustawienia planszy
function toggleZen(on) {
  const z = on ?? !document.body.classList.contains('zen');
  document.body.classList.toggle('zen', z);
  A.store.set('zen', z);
  window.dispatchEvent(new Event('resize'));
}
function applyBoardPrefs() {
  const p = A.store.get('boardPrefs', { size: 100, dests: true, anim: 160 });
  document.documentElement.style.setProperty('--board-scale', p.size / 100);
  A.cg.set({ movable: { showDests: p.dests }, premovable: { showDests: p.dests }, animation: { enabled: p.anim > 0, duration: p.anim } });
  $('bp-size').value = p.size; $('bp-dests').checked = p.dests; $('bp-anim').value = String(p.anim);
}
function saveBoardPrefs() {
  A.store.set('boardPrefs', { size: +$('bp-size').value, dests: $('bp-dests').checked, anim: +$('bp-anim').value });
  applyBoardPrefs();
  window.dispatchEvent(new Event('resize'));
}

// ---------------------------------------------------------------- trening współrzędnych (jak lichess „Coordinates”)
const CO = { on: false };
const SQ = () => 'abcdefgh'[Math.floor(Math.random() * 8)] + (1 + Math.floor(Math.random() * 8));
function startCoords() {
  A.showTab('puzzles');
  A.openPuzzles('coords');
  coordsUi();
}
function coordsUi() {
  const best = A.store.get('coordsBest', { white: 0, black: 0 });
  $('coords-box').innerHTML = `<div class="coords-hero"><div class="coords-target" id="coords-target">?</div>
    <div class="rush-head" style="grid-template-columns:repeat(2,1fr)"><div class="rush-stat"><small>Wynik</small><b class="num" id="coords-score">0</b></div><div class="rush-stat"><small>Czas</small><b class="num" id="coords-time">0:30</b></div></div></div>
    <div class="row"><select id="coords-color"><option value="white">Od strony białych</option><option value="black">Od strony czarnych</option><option value="random">Losowo</option></select><button class="btn primary" id="coords-start">Start (30 s)</button></div>
    <p class="muted">Klikaj na szachownicy pole, które się wyświetla. Współrzędne na planszy są ukryte. Rekord: białe ${best.white} · czarne ${best.black}</p>`;
  $('coords-start').onclick = runCoords;
}
function runCoords() {
  let orient = $('coords-color').value;
  if (orient === 'random') orient = Math.random() < 0.5 ? 'white' : 'black';
  Object.assign(CO, { on: true, score: 0, target: SQ(), end: Date.now() + 30000, orient });
  document.body.classList.add('no-coords-train');
  A.S.train = { fen: '8/8/8/8/8/8/8/8 w - - 0 1', orientation: orient, hideEval: true, shapes: [], locked: true };
  A.render();
  A.cg.set({ events: { select: onCoordClick } });
  $('coords-target').textContent = CO.target;
  clearInterval(CO.timer);
  CO.timer = setInterval(() => {
    const left = Math.max(0, CO.end - Date.now());
    $('coords-time').textContent = `0:${String(Math.ceil(left / 1000)).padStart(2, '0')}`;
    if (!left) stopCoords();
  }, 200);
}
function onCoordClick(key) {
  if (!CO.on) return;
  A.cg.selectSquare(null);
  const ok = key === CO.target;
  A.S.train.shapes = [{ orig: key, brush: ok ? 'green' : 'red' }];
  A.render();
  if (ok) { CO.score++; $('coords-score').textContent = CO.score; A.sound.play('Move'); CO.target = SQ(); $('coords-target').textContent = CO.target; fx.pop($('coords-target')); }
  else { A.sound.play('Error'); fx.shake($('coords-target')); }
}
function stopCoords() {
  if (!CO.on) return;
  CO.on = false;
  clearInterval(CO.timer);
  document.body.classList.remove('no-coords-train');
  A.cg.set({ events: { select: undefined } });
  const best = A.store.get('coordsBest', { white: 0, black: 0 });
  const rec = CO.score > (best[CO.orient] || 0);
  if (rec) { best[CO.orient] = CO.score; A.store.set('coordsBest', best); }
  A.sound.play(rec ? 'Confirmation' : 'GenericNotify');
  A.toast(`Koniec! Wynik: ${CO.score}${rec ? ' – nowy rekord 🏆' : ''}`);
  A.S.train = null; A.render();
  coordsUi();
}
export function onShowExtrasTab(name) { if (name !== 'puzzles' && CO.on) stopCoords(); }

// ---------------------------------------------------------------- start
export function initExtras(api) {
  A = api;
  document.body.insertAdjacentHTML('beforeend', `
    <div class="overlay" id="palette" hidden><div class="pal-box"><div class="pal-in">${icon('analysis', 20)}<input id="pal-q" placeholder="Czego szukasz? np. bot, zadania, drill, pozycja…" autocomplete="off"></div><div class="pal-list" id="pal-list"></div><div class="pal-foot muted">↑↓ wybór · Enter otwiera · Esc zamyka · <b>?</b> skróty</div></div></div>
    <div class="overlay" id="modal" hidden><div class="pal-box"><div id="modal-body"></div><button class="btn" id="modal-close" style="margin-top:12px">Zamknij</button></div></div>`);
  $('palette').onclick = (e) => { if (e.target.id === 'palette') closePalette(); };
  $('modal').onclick = (e) => { if (e.target.id === 'modal' || e.target.id === 'modal-close') $('modal').hidden = true; };
  $('pal-q').oninput = () => { sel = 0; renderPalette(); };
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); $('palette').hidden ? openPalette() : closePalette(); return; }
    if (e.target.matches?.('input, textarea, select')) return;
    if (e.key === '?') { shortcuts(); }
    else if (e.key === 'z' || e.key === 'Z') toggleZen();
    else if (e.key === 'x' || e.key === 'X') A.threat();
    else if ((e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.metaKey) A.toggleArrow?.();
    else if (e.key === 'Escape') { closePalette(); $('modal').hidden = true; if (document.body.classList.contains('zen')) toggleZen(false); }
  });
  $('sb-search').onclick = openPalette;
  for (const id of ['bp-size', 'bp-dests', 'bp-anim']) $(id).addEventListener('input', saveBoardPrefs);
  applyBoardPrefs();
  if (A.store.get('zen', false)) toggleZen(true);
  $('btn-share').onclick = sharePgn;
  $('train-sub').addEventListener('click', (e) => {
    const sub = e.target.dataset.sub; if (!sub) return;
    if (sub === 'coords') coordsUi(); else if (CO.on) stopCoords();
  });
  return { loadFromHash, sharePgn, startCoords };
}

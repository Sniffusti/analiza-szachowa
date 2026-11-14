// Opracowania (jak „studies” na lichess): rozdziały z wariantami, komentarzami i strzałkami,
// import z lichess / PGN, edycja komentarzy, kotek mówiący komentarze w dymku.
import { Chess } from './vendor/chess.js';
import { idb } from './store.js';
import { splitGames, parseHeaders } from './pgn.js';
import { treeFromPgn, countLines } from './pgn-tree.js';
import * as fx from './fx.js';

let A;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const NAG = { 1: '!', 2: '?', 3: '!!', 4: '??', 5: '!?', 6: '?!', 10: '=', 13: '∞', 14: '⩲', 15: '⩱', 16: '±', 17: '∓', 18: '+−', 19: '−+' };
const BRUSH = { G: 'green', R: 'red', Y: 'yellow', B: 'blue' };

// ---------------------------------------------------------------- PGN ⇄ drzewo
let nextId = 1;
function tokenize(body) {
  const out = [];
  const re = /\{([^}]*)\}|;([^\n]*)|(\()|(\))|\$(\d+)|([^\s(){};]+)/g;
  let m;
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) out.push({ c: m[1] });
    else if (m[2] !== undefined) out.push({ c: m[2] });
    else if (m[3]) out.push({ o: 1 });
    else if (m[4]) out.push({ x: 1 });
    else if (m[5]) out.push({ n: +m[5] });
    else out.push({ t: m[6] });
  }
  return out;
}
export function parseChapter(pgn) {
  const headers = parseHeaders(pgn);
  const startFen = headers.FEN || new Chess().fen();
  const root = { id: nextId++, fen: startFen, children: [], comment: '', nags: [], parent: null };
  const body = pgn.replace(/^\s*\[.*\]\s*$/gm, '');
  let cur = root;
  const stack = [];
  for (const tk of tokenize(body)) {
    if (tk.c !== undefined) { cur.comment = (cur.comment ? cur.comment + ' ' : '') + tk.c.trim(); continue; }
    if (tk.o) { stack.push(cur); cur = cur.parent || cur; continue; }
    if (tk.x) { cur = stack.pop() || cur; continue; }
    if (tk.n !== undefined) { cur.nags.push(tk.n); continue; }
    let t = tk.t.replace(/^\d+\.(\.\.)?/, '');
    if (!t || /^(1-0|0-1|1\/2-1\/2|\*|\d+\.+)$/.test(t)) continue;
    const suf = t.match(/[!?]+$/)?.[0];
    t = t.replace(/[!?]+$/, '');
    const c = new Chess(cur.fen);
    let m;
    try { m = c.move(t, { strict: false }); } catch { continue; }
    const node = addChild(cur, m, c.fen());
    if (suf) { const k = Object.entries(NAG).find(([, v]) => v === suf)?.[0]; if (k) node.nags.push(+k); }
    cur = node;
  }
  return { headers, root };
}
function addChild(parent, m, fen) {
  const uci = m.from + m.to + (m.promotion || '');
  let node = parent.children.find((n) => n.uci === uci);
  if (!node) {
    node = { id: nextId++, san: m.san, uci, from: m.from, to: m.to, fen, children: [], comment: '', nags: [], parent };
    parent.children.push(node);
  }
  return node;
}
function moveNo(fen) { const f = fen.split(' '); return { n: +f[5], w: f[1] === 'w' }; }
function moveStr(parent, node, force) {
  const { n, w } = moveNo(parent.fen);
  const nags = node.nags.map((k) => '$' + k).join(' ');
  return (w ? `${n}. ` : force ? `${n}... ` : '') + node.san + (nags ? ' ' + nags : '') + (node.comment ? ` { ${node.comment.replace(/[{}]/g, '')} }` : '');
}
function writeFrom(node, out, force) {
  if (!node.children.length) return;
  const [main, ...vars] = node.children;
  out.push(moveStr(node, main, force));
  for (const v of vars) {
    const sub = [moveStr(node, v, true)];
    writeFrom(v, sub, false);
    out.push('(' + sub.join(' ') + ')');
  }
  writeFrom(main, out, vars.length > 0);
}
export function chapterToPgn(ch) {
  const h = { Event: ch.name, Result: '*', ...ch.headers, ChapterName: ch.name };
  let s = Object.entries(h).map(([k, v]) => `[${k} "${String(v).replace(/"/g, '\\"')}"]`).join('\n') + '\n\n';
  const out = [];
  if (ch.root.comment) out.push(`{ ${ch.root.comment.replace(/[{}]/g, '')} }`);
  writeFrom(ch.root, out, true);
  out.push(h.Result || '*');
  return s + out.join(' ') + '\n';
}
const studyToPgn = (st) => st.chapters.map(chapterToPgn).join('\n');

// komentarz: tekst bez znaczników + kształty
function parseComment(c = '') {
  const shapes = [];
  for (const m of c.matchAll(/\[%cal ([^\]]+)\]/g)) for (const a of m[1].split(',')) {
    const t = a.trim(); if (t.length >= 5) shapes.push({ orig: t.slice(1, 3), dest: t.slice(3, 5), brush: BRUSH[t[0]] || 'green' });
  }
  for (const m of c.matchAll(/\[%csl ([^\]]+)\]/g)) for (const a of m[1].split(',')) {
    const t = a.trim(); if (t.length >= 3) shapes.push({ orig: t.slice(1, 3), brush: BRUSH[t[0]] || 'green' });
  }
  const text = c.replace(/\[%[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
  return { text, shapes };
}

// ---------------------------------------------------------------- zapis
function serialize(st) {
  return { id: st.id, name: st.name, created: st.created, pgns: st.chapters.map(chapterToPgn) };
}
function deserialize(raw) {
  return {
    id: raw.id, name: raw.name, created: raw.created,
    chapters: raw.pgns.map((p) => {
      const { headers, root } = parseChapter(p);
      return { name: headers.ChapterName || (headers.Event || 'Rozdział').split(': ').pop(), headers, root };
    }),
  };
}
async function saveStudy(st) { await idb.set('study:' + st.id, serialize(st)); }
async function studies() {
  const keys = await idb.keys('study:');
  return (await Promise.all(keys.map((k) => idb.get(k)))).filter(Boolean).sort((a, b) => b.created - a.created);
}

function studyFromPgnText(text, fallbackName) {
  const games = splitGames(text).filter((g) => g.trim());
  const chapters = games.map((g, i) => {
    const { headers, root } = parseChapter(g);
    const ev = headers.Event && headers.Event !== '?' ? headers.Event : '';
    const name = headers.ChapterName || (ev.includes(': ') ? ev.split(': ').slice(1).join(': ') : ev) || (headers.White && headers.White !== '?' ? `${headers.White} – ${headers.Black}` : `Rozdział ${i + 1}`);
    return { name, headers, root };
  });
  const h0 = chapters[0]?.headers || {};
  const name = h0.StudyName || (h0.Event?.includes(': ') ? h0.Event.split(': ')[0] : '') || fallbackName || 'Opracowanie';
  return { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, created: Date.now(), chapters };
}

// ---------------------------------------------------------------- widok opracowania
const V = { st: null, ch: 0, node: null, editing: false };

function orientation() {
  const h = V.st.chapters[V.ch].headers;
  return (h.Orientation || '').toLowerCase() === 'black' ? 'black' : 'white';
}
function showBoard() {
  if (!V.st || $('tab-study').hidden || $('study-studies').hidden) return;
  const n = V.node;
  show({ fen: n.fen, lastMove: n.from ? [n.from, n.to] : null, orientation: orientation(), shapes: parseComment(n.comment).shapes, onMove, onKey });
}
function show(view) { A.S.train = { hideEval: true, ...view }; A.render(); }

function onMove(uci, m, fenAfter) {
  V.node = addChild(V.node, m, fenAfter);
  A.sound.forSan(m.san);
  saveStudy(V.st);
  renderStudy();
}
function onKey(key) {
  if (!V.st) return false;
  if (key === 'ArrowLeft' && V.node.parent) { V.node = V.node.parent; renderStudy(); return true; }
  if (key === 'ArrowRight' && V.node.children[0]) { V.node = V.node.children[0]; A.sound.forSan(V.node.san); renderStudy(); return true; }
  if (key === 'Home') { V.node = V.st.chapters[V.ch].root; renderStudy(); return true; }
  if (key === 'End') { while (V.node.children[0]) V.node = V.node.children[0]; renderStudy(); return true; }
  return false;
}

/** Kotek z dymkiem – wspólny element (opracowania i raport). */
export function catSays(html, { mood = '' } = {}) {
  return `<div class="cat-says ${mood}"><img class="cat-ava" src="cat.png" alt=""><div class="bubble">${html}</div></div>`;
}

function treeHtml(ch) {
  const out = [];
  const cls = (n) => 'sm' + (n === V.node ? ' cur' : '');
  const label = (parent, n, force) => {
    const { n: no, w } = moveNo(parent.fen);
    const num = w ? `<i>${no}.</i>` : force ? `<i>${no}…</i>` : '';
    const nag = n.nags.map((k) => NAG[k] || '').join('');
    const com = parseComment(n.comment).text;
    return `${num}<span class="${cls(n)}" data-id="${n.id}">${esc(n.san)}${nag ? `<b>${esc(nag)}</b>` : ''}</span>${com ? `<span class="scom">${esc(com.length > 120 ? com.slice(0, 117) + '…' : com)}</span>` : ''}`;
  };
  const walk = (node, force, depth) => {
    if (!node.children.length) return '';
    const [main, ...vars] = node.children;
    let s = label(node, main, force) + ' ';
    for (const v of vars) s += `<span class="svar d${Math.min(depth, 3)}">(${label(node, v, true)} ${walk(v, false, depth + 1)})</span> `;
    return s + walk(main, vars.length > 0, depth);
  };
  out.push(walk(ch.root, true, 1));
  return out.join('');
}
function findNode(root, id) {
  const st = [root];
  while (st.length) { const n = st.pop(); if (n.id === id) return n; st.push(...n.children); }
  return null;
}

function renderStudy() {
  const box = $('study-view');
  if (!V.st) { box.hidden = true; $('study-home').hidden = false; return; }
  box.hidden = false; $('study-home').hidden = true;
  const ch = V.st.chapters[V.ch];
  const { text } = parseComment(V.node.comment);
  const intro = V.node === ch.root;
  const say = V.editing
    ? `<textarea id="sv-com" rows="3" placeholder="Twój komentarz do tej pozycji… (strzałki: [%cal Ge2e4])">${esc(V.node.comment)}</textarea>
       <div class="row"><button class="btn primary" id="sv-save">Zapisz</button><button class="btn" id="sv-cancel">Anuluj</button></div>`
    : text ? esc(text)
      : intro ? `<span class="muted">Rozdział „${esc(ch.name)}”. Przesuwaj bierki albo klikaj ruchy poniżej. Strzałki ← → też działają.</span>`
        : `<span class="muted">Brak komentarza do ${esc(V.node.san)}. Kliknij „Komentarz”, żeby dodać swój.</span>`;
  $('sv-title').innerHTML = `${esc(V.st.name)} <span>/ ${esc(ch.name)}</span>`;
  $('sv-chapters').innerHTML = V.st.chapters.map((c, i) => `<option value="${i}" ${i === V.ch ? 'selected' : ''}>${i + 1}. ${esc(c.name)}</option>`).join('');
  $('sv-cat').innerHTML = catSays(say);
  $('sv-tree').innerHTML = treeHtml(ch) || '<span class="muted">Brak ruchów – zagraj pierwszy ruch na szachownicy.</span>';
  $('sv-tree').querySelector('.sm.cur')?.scrollIntoView({ block: 'nearest' });
  if (V.editing) {
    $('sv-com').focus();
    $('sv-save').onclick = async () => { V.node.comment = $('sv-com').value.trim(); V.editing = false; await saveStudy(V.st); A.sound.play('Confirmation'); renderStudy(); };
    $('sv-cancel').onclick = () => { V.editing = false; renderStudy(); };
  }
  showBoard();
}

async function openStudy(id, chapter = 0) {
  const raw = await idb.get('study:' + id);
  if (!raw) return;
  V.st = deserialize(raw); V.ch = chapter; V.node = V.st.chapters[chapter].root; V.editing = false;
  A.store.set('openStudy', id);
  renderStudy();
  fx.enter($('study-view').children, { step: 40 });
}

async function renderStudyList() {
  const list = await studies();
  $('study-list').innerHTML = list.length ? list.map((s) => `<div class="rep-item" data-sid="${s.id}">
      <div><b>${esc(s.name)}</b> <span class="muted">${s.pgns.length} rozdz.</span></div>
      <div class="rep-btns"><button class="btn primary" data-s="open">Otwórz</button><button class="btn" data-s="drill" title="Zrób drill z tego opracowania">Drill</button><button class="btn" data-s="pgn" title="Pobierz PGN">PGN</button><button class="btn" data-s="del" title="Usuń">✕</button></div></div>`).join('')
    : '<p class="muted">Nie masz jeszcze opracowań. Zaimportuj opracowanie z lichess (link), wczytaj PGN albo utwórz nowe z bieżącej partii.</p>';
}

async function importLichess() {
  const v = $('study-url').value.trim();
  const m = v.match(/study\/([a-zA-Z0-9]{8})(?:\/([a-zA-Z0-9]{8}))?/);
  if (!m) return A.toast('Wklej link do opracowania lichess, np. https://lichess.org/study/abcd1234');
  const st = $('study-status');
  st.textContent = 'Pobieram opracowanie z lichess…';
  try {
    const path = m[2] ? `api/study/${m[1]}/${m[2]}.pgn` : `api/study/${m[1]}.pgn`;
    const r = await A.apiFetch('lichess', `${path}?comments=true&variations=true&clocks=false&orientation=true`, 'application/x-chess-pgn');
    if (r.status === 404 || r.status === 403 || r.status === 401) throw new Error('opracowanie jest prywatne albo nie istnieje (prywatne wymagają tokenu w Ustawieniach)');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const study = studyFromPgnText(await r.text(), 'Opracowanie lichess');
    if (!study.chapters.length) throw new Error('puste opracowanie');
    study.source = v;
    await idb.set('study:' + study.id, serialize(study));
    st.textContent = `Zaimportowano „${study.name}”: ${study.chapters.length} rozdziałów.`;
    $('study-url').value = '';
    renderStudyList();
    openStudy(study.id);
  } catch (e) { st.textContent = 'Błąd: ' + e.message; }
}

async function importFiles(files) {
  let last = null;
  for (const f of files) {
    const study = studyFromPgnText(await f.text(), f.name.replace(/\.(pgn|txt)$/i, ''));
    if (!study.chapters.length) { A.toast(`${f.name}: nie znalazłem partii.`); continue; }
    if (study.name === 'Opracowanie') study.name = f.name.replace(/\.(pgn|txt)$/i, '');
    await idb.set('study:' + study.id, serialize(study));
    last = study.id;
    $('study-status').textContent = `Wczytano „${study.name}”: ${study.chapters.length} rozdziałów.`;
  }
  renderStudyList();
  if (last) openStudy(last);
}

async function newFromGame() {
  const g = A.S.game;
  let pgn = `[Event "${(g.headers.White || 'Nowe') + ' – ' + (g.headers.Black || 'opracowanie')}"]\n`;
  if (g.headers.FEN) pgn += `[SetUp "1"]\n[FEN "${g.headers.FEN}"]\n`;
  pgn += '\n' + g.moves.map((m) => m.san).join(' ');
  const study = studyFromPgnText(pgn, 'Moje opracowanie');
  study.name = $('study-newname').value.trim() || 'Moje opracowanie';
  await idb.set('study:' + study.id, serialize(study));
  $('study-newname').value = '';
  renderStudyList();
  openStudy(study.id);
}

function setStudySub(sub) {
  for (const b of $('study-sub').children) b.classList.toggle('active', b.dataset.sub === sub);
  $('study-studies').hidden = sub !== 'studies';
  $('study-drills').hidden = sub !== 'drills';
  A.store.set('studySub', sub);
  A.S.train = null;
  if (sub === 'studies') { renderStudyList(); if (V.st) showBoard(); else A.render(); }
  else { A.drills.show(); }
}

export function onShowStudyTab(name) {
  if (name !== 'study') return;
  if (!$('study-studies').hidden) { renderStudyList(); if (V.st) showBoard(); }
  else A.drills.show();
}

export function initStudy(api) {
  A = api;
  $('study-sub').onclick = (e) => { const s = e.target.dataset.sub; if (s) setStudySub(s); };
  $('study-import').onclick = importLichess;
  $('study-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') importLichess(); });
  $('study-file').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; importFiles(f); };
  $('study-new').onclick = newFromGame;
  $('study-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-s]'); const id = e.target.closest('[data-sid]')?.dataset.sid;
    if (!b || !id) return;
    const raw = await idb.get('study:' + id);
    if (b.dataset.s === 'open') openStudy(id);
    if (b.dataset.s === 'del' && confirm(`Usunąć opracowanie „${raw.name}”?`)) { await idb.del('study:' + id); if (V.st?.id === id) V.st = null; renderStudyList(); renderStudy(); }
    if (b.dataset.s === 'pgn') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([raw.pgns.join('\n')], { type: 'application/x-chess-pgn' }));
      a.download = raw.name.replace(/[^\w\-ąćęłńóśźżĄĆĘŁŃÓŚŹŻ ]+/g, '_') + '.pgn';
      a.click();
    }
    if (b.dataset.s === 'drill') {
      const color = confirm(`Drill z „${raw.name}”: grasz BIAŁYMI? (OK = białe, Anuluj = czarne)`) ? 'w' : 'b';
      const { tree } = treeFromPgn(raw.pgns.join('\n\n'));
      const rep = { id: Date.now().toString(36), name: raw.name, color, tree, stats: {}, lines: countLines(tree), created: Date.now() };
      await idb.set('rep:' + rep.id, rep);
      A.toast(`Utworzono drill „${raw.name}” (${rep.lines} linii).`);
      setStudySub('drills');
    }
  });
  $('sv-chapters').onchange = () => { V.ch = +$('sv-chapters').value; V.node = V.st.chapters[V.ch].root; V.editing = false; renderStudy(); };
  $('sv-tree').addEventListener('click', (e) => {
    const id = +e.target.closest('[data-id]')?.dataset.id;
    if (!id) return;
    const n = findNode(V.st.chapters[V.ch].root, id);
    if (n) { V.node = n; V.editing = false; A.sound.forSan(n.san); renderStudy(); }
  });
  $('sv-nav').onclick = (e) => {
    const a = e.target.closest('[data-n]')?.dataset.n;
    if (!a) return;
    if (a === 'first') onKey('Home'); if (a === 'prev') onKey('ArrowLeft'); if (a === 'next') onKey('ArrowRight'); if (a === 'last') onKey('End');
    if (a === 'comment') { V.editing = true; renderStudy(); }
    if (a === 'delete' && V.node.parent && confirm(`Usunąć ${V.node.san} i wszystkie dalsze ruchy?`)) {
      const p = V.node.parent; p.children = p.children.filter((c) => c !== V.node); V.node = p; saveStudy(V.st); renderStudy();
    }
    if (a === 'promote' && V.node.parent) {
      const p = V.node.parent; p.children = [V.node, ...p.children.filter((c) => c !== V.node)]; saveStudy(V.st); renderStudy();
    }
    if (a === 'analyse') { A.S.train = null; A.loadPgnText(chapterToPgn(V.st.chapters[V.ch])); }
    if (a === 'close') { V.st = null; A.S.train = null; A.store.set('openStudy', ''); renderStudy(); renderStudyList(); A.render(); }
  };
  setStudySub(A.store.get('studySub', 'studies'));
  const open = A.store.get('openStudy', '');
  if (open) idb.get('study:' + open).then((raw) => { if (raw) { V.st = deserialize(raw); V.ch = 0; V.node = V.st.chapters[0].root; renderStudy(); A.S.train = null; A.render(); } });
}

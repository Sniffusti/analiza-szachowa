// Strona główna w stylu chess.com: szybka gra, zadania, nauka, ostatnia partia, zadanie dnia, historia.
import { Chess } from './vendor/chess.js';
import { idb } from './store.js';
import * as fx from './fx.js';

let A;
export function initHome(api) { A = api; }
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Mała statyczna szachownica (miniatura) z bierkami z wybranego zestawu. */
export function miniBoard(fen, { flip = false, size = '' } = {}) {
  const rows = fen.split(' ')[0].split('/');
  let cells = '';
  const grid = rows.map((r) => r.replace(/\d/g, (d) => '.'.repeat(+d)).split(''));
  const order = flip ? [...grid].reverse().map((r) => [...r].reverse()) : grid;
  order.forEach((row, y) => row.forEach((ch, x) => {
    const dark = (x + y) % 2 === 1;
    const piece = ch === '.' ? '' : (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toUpperCase();
    cells += `<i class="${dark ? 'd' : 'l'}">${piece ? `<img src="${A.pieceUrl(piece)}" alt="">` : ''}</i>`;
  }));
  return `<div class="mini ${size}">${cells}</div>`;
}

async function dailyPuzzle() {
  const key = new Date().toISOString().slice(0, 10);
  const c = A.store.get('daily', null);
  if (c && c.key === key) return c.data;
  const r = await fetch('https://lichess.org/api/puzzle/daily', { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const data = await r.json();
  A.store.set('daily', { key, data });
  return data;
}
function fenOfPuzzle(d) {
  const ch = new Chess();
  for (const san of d.game.pgn.split(' ')) { try { ch.move(san); } catch { break; } }
  return ch.fen();
}

export async function renderHome(api) {
  A = api;
  const el = document.getElementById('tab-home');
  const p = A.profile();
  const pz = A.store.get('puzzleStats', { rating: 1500, solved: 0, streak: 0 });
  const games = (await idb.get('games')) || [];
  const mistakes = (await idb.get('mistakes')) || [];
  const dueMistakes = mistakes.filter((m) => m.due <= Date.now()).length;
  const reps = (await Promise.all((await idb.keys('rep:')).map((k) => idb.get(k)))).filter(Boolean);
  const rep = reps.map((r) => ({ r, due: A.repDue(r) })).sort((a, b) => b.due - a.due)[0];
  const last = games[0];
  const streak = A.streak();
  let lastFen = new Chess().fen();
  if (last) { try { const c = new Chess(); c.loadPgn(last.pgn); lastFen = c.fen(); } catch {} }
  const days = new Set(A.store.get('activeDays', []));
  const week = [...Array(7)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() - 6 + i); return { k: d.toISOString().slice(0, 10), l: 'NPWŚCPS'[d.getDay()] }; });

  el.innerHTML = `
  <div class="home">
    <div class="home-head">
      <div class="hh-user">${A.avatarHtml(p, 40)}<div><b>${esc(p.name || 'Gość')}</b><small>${p.name ? `Blitz ${p.ratings.blitz} · Rapid ${p.ratings.rapid} · Bullet ${p.ratings.bullet}` : '<a href="#" data-h="profile">Utwórz konto</a>, żeby śledzić postępy'}</small></div></div>
      <div class="hh-streak">🔥 <b>${streak}</b> ${streak === 1 ? 'dzień' : 'dni'}</div>
    </div>
    <div class="home-grid">
      <section class="hcard play-card">
        <h4>Graj online</h4>
        <div class="tc-row">${['1+0', '3+0', '10+0'].map((t) => `<button class="tc ${t === A.store.get('homeTc', '10+0') ? 'on' : ''}" data-tc="${t}">${t.split('+')[0]} min</button>`).join('')}</div>
        <button class="btn primary big" data-h="quick">Rozpocznij partię</button>
        <button class="hbtn" data-h="bots"><img src="bots/cat-4.png" alt="">Graj z botami</button>
        <button class="hbtn" data-h="career"><img src="cat.png" alt="">Kariera <small class="mono">${p.career.rating}</small></button>
        <button class="hbtn" data-h="friend"><span class="hi">🔗</span>Graj ze znajomym</button>
      </section>
      <section class="hcard tile">
        ${miniBoard('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4')}
        <div class="tile-meta"><span class="pill accent">✦ ${pz.rating}</span><small>rozwiązane ${pz.solved} · seria ${pz.streak}</small></div>
        <button class="btn" data-h="puzzles">Rozwiązuj zadania</button>
      </section>
      <section class="hcard tile">
        ${rep ? miniBoard(A.repCoverFen(rep.r), { flip: rep.r.color === 'b' }) : miniBoard(new Chess().fen())}
        <div class="tile-meta"><span class="pill">❏ ${rep ? esc(rep.r.name) : 'Brak drilli'}</span><small>${rep ? `${rep.due} do powtórki` : 'Dodaj repertuar z PGN'}</small></div>
        <button class="btn" data-h="learn">${rep ? 'Następna lekcja' : 'Ucz się'}</button>
      </section>
      <section class="hcard tile">
        ${miniBoard(lastFen, { flip: last?.me === 'b' })}
        <div class="tile-meta"><span class="pill">${last ? esc(last.white + ' – ' + last.black) : 'Brak partii'}</span><small>${last ? `${esc(last.result)} · ${esc(last.date)}` : 'Zagraj pierwszą partię'}</small></div>
        <button class="btn" data-h="lastgame" ${last ? '' : 'disabled'}>Sprawdź partię</button>
      </section>
      <section class="hcard daily" id="home-daily"><h4>Zadanie dnia</h4><div class="muted">Ładuję…</div></section>
      <section class="hcard side">
        <h4>${streak} dni serii</h4>
        <div class="week">${week.map((d) => `<div><small>${d.l}</small><span class="${days.has(d.k) ? 'on' : ''}">${days.has(d.k) ? '✓' : ''}</span></div>`).join('')}</div>
        <h4 style="margin-top:14px">Moje błędy</h4>
        <div class="muted">${mistakes.length} zadań z Twoich partii · ${dueMistakes} do powtórki</div>
        <button class="btn" data-h="mistakes" style="margin-top:8px;width:100%">Ćwicz błędy</button>
        <h4 style="margin-top:14px">Rankingi zewnętrzne</h4>
        <div class="ext-ratings" id="ext-ratings"><span class="muted">${p.chesscom || p.lichess ? 'Ładuję…' : 'Podaj nicki w profilu.'}</span></div>
      </section>
      <section class="hcard history">
        <h4>Historia partii</h4>
        ${games.length ? `<table class="hist"><tr><th>Gracze</th><th>Wynik</th><th>Tempo</th><th>Data</th><th></th></tr>
          ${games.slice(0, 12).map((g, i) => {
            const won = (g.result === '1-0' && g.me === 'w') || (g.result === '0-1' && g.me === 'b');
            const lost = (g.result === '1-0' && g.me === 'b') || (g.result === '0-1' && g.me === 'w');
            return `<tr><td>${esc(g.white)}<br>${esc(g.black)}</td><td><span class="rs ${won ? 'w' : lost ? 'l' : 'd'}">${won ? '+' : lost ? '−' : '='}</span> ${esc(g.result)}</td><td class="mono">${g.tc === '0' ? '∞' : esc(g.tc)}</td><td class="mono">${esc(g.date)}</td><td><button class="btn" data-g="${i}">Przegląd</button></td></tr>`;
          }).join('')}</table>` : '<p class="muted">Tu pojawią się Twoje partie z botami, kariery i online.</p>'}
      </section>
    </div>
  </div>`;

  el.onclick = (e) => {
    const tc = e.target.closest('[data-tc]');
    if (tc) { A.store.set('homeTc', tc.dataset.tc); for (const b of el.querySelectorAll('[data-tc]')) b.classList.toggle('on', b === tc); return; }
    const g = e.target.closest('[data-g]');
    if (g) return A.reviewPgn(games[+g.dataset.g].pgn);
    const h = e.target.closest('[data-h]')?.dataset.h;
    if (!h) return;
    e.preventDefault();
    if (h === 'quick') A.quickPlay(A.store.get('homeTc', '10+0'));
    if (h === 'bots') A.playBots();
    if (h === 'career') A.playCareer();
    if (h === 'friend') A.playFriend();
    if (h === 'puzzles') A.openPuzzles('puzzles');
    if (h === 'mistakes') A.openPuzzles('mistakes');
    if (h === 'learn') A.openDrills(rep?.r.id);
    if (h === 'lastgame' && last) A.reviewPgn(last.pgn);
    if (h === 'profile') A.showTab('settings');
    if (h === 'daily') A.openPuzzles('daily');
  };
  fx.enter(el.querySelectorAll('.hcard, .home-head'), { step: 40 });

  dailyPuzzle().then((d) => {
    const box = document.getElementById('home-daily');
    if (!box) return;
    const fen = fenOfPuzzle(d);
    box.innerHTML = `<h4>Zadanie dnia</h4>${miniBoard(fen, { flip: fen.split(' ')[1] === 'b' })}<div class="tile-meta"><span class="pill accent">✦ ${d.puzzle.rating}</span><small>${(d.puzzle.themes || []).slice(0, 2).join(' · ')}</small></div><button class="btn primary" data-h="daily">Rozwiąż zadanie dnia</button>`;
  }).catch(() => { const box = document.getElementById('home-daily'); if (box) box.innerHTML = '<h4>Zadanie dnia</h4><p class="muted">Brak połączenia z lichess.</p>'; });

  extRatings(p).catch(() => {});
}

async function extRatings(p) {
  const box = document.getElementById('ext-ratings');
  if (!box || !(p.chesscom || p.lichess)) return;
  const key = new Date().toISOString().slice(0, 13);
  let c = A.store.get('extRatings', null);
  if (!c || c.key !== key || c.user !== p.chesscom + '|' + p.lichess) {
    const out = {};
    if (p.chesscom) {
      try {
        const r = await A.apiFetch('chesscom', `pub/player/${encodeURIComponent(p.chesscom.toLowerCase())}/stats`);
        const j = await r.json();
        out.chesscom = { bullet: j.chess_bullet?.last?.rating, blitz: j.chess_blitz?.last?.rating, rapid: j.chess_rapid?.last?.rating, puzzle: j.tactics?.highest?.rating };
      } catch {}
    }
    if (p.lichess) {
      try {
        const r = await fetch(`https://lichess.org/api/user/${encodeURIComponent(p.lichess)}`);
        const j = await r.json();
        out.lichess = { bullet: j.perfs?.bullet?.rating, blitz: j.perfs?.blitz?.rating, rapid: j.perfs?.rapid?.rating, puzzle: j.perfs?.puzzle?.rating };
      } catch {}
    }
    c = { key, user: p.chesscom + '|' + p.lichess, out };
    A.store.set('extRatings', c);
  }
  const row = (name, o) => o ? `<div class="er"><b>${name}</b>${['bullet', 'blitz', 'rapid', 'puzzle'].map((k) => `<span><small>${k === 'puzzle' ? 'zadania' : k}</small>${o[k] ?? '–'}</span>`).join('')}</div>` : '';
  box.innerHTML = row('chess.com', c.out.chesscom) + row('lichess', c.out.lichess) || '<span class="muted">Brak danych.</span>';
}

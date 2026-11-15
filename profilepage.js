// Strona profilu jak na chess.com: nagłówek, rankingi, ostatnie partie z chess.com / lichess, statystyki.
import { Chess } from './vendor/chess.js';
import { icon } from './icons.js';
import { miniBoard } from './home.js';
import * as fx from './fx.js';

let A;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SPEED_ICON = { bullet: 'bullet', blitz: 'blitz', rapid: 'rapid', classical: 'rapid', daily: 'daily', correspondence: 'daily' };
const SPEED_PL = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Szybkie', classical: 'Klasyczne', daily: 'Dzienne', correspondence: 'Dzienne' };
let games = [];
let src = null;

async function chesscomGames(user) {
  const u = user.toLowerCase();
  const arch = (await (await A.apiFetch('chesscom', `pub/player/${encodeURIComponent(u)}/games/archives`)).json()).archives || [];
  const out = [];
  for (const url of arch.reverse()) {
    if (out.length >= 40) break;
    const j = await (await A.apiFetch('chesscom', url.replace('https://api.chess.com/', ''))).json();
    for (const g of (j.games || []).reverse()) {
      if (g.rules !== 'chess' || out.length >= 40) continue;
      const meWhite = g.white.username.toLowerCase() === u;
      const myRes = (meWhite ? g.white : g.black).result;
      const res = myRes === 'win' ? 'win' : ['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'].includes(myRes) ? 'draw' : 'loss';
      const moves = (g.pgn.match(/\s\d+\.\s/g) || []).length;
      out.push({
        speed: g.time_class, tc: g.time_control, white: g.white.username, black: g.black.username, wr: g.white.rating, br: g.black.rating,
        res, meWhite, accW: g.accuracies?.white, accB: g.accuracies?.black, moves, date: new Date(g.end_time * 1000), pgn: g.pgn, url: g.url, fen: g.fen,
      });
    }
  }
  return out;
}
async function lichessGames(user) {
  const tok = A.lichessToken();
  const path = `api/games/user/${encodeURIComponent(user)}?max=40&pgnInJson=true&accuracy=true&opening=true`;
  const r = tok ? await fetch('https://lichess.org/' + path, { headers: { Accept: 'application/x-ndjson', Authorization: 'Bearer ' + tok } })
    : await A.apiFetch('lichess', path, 'application/x-ndjson');
  if (!r.ok) throw new Error(r.status === 404 ? 'lichess pokazuje Twoje partie tylko po zalogowaniu (Ustawienia → Konto → Zaloguj przez lichess)' : 'HTTP ' + r.status);
  const text = await r.text();
  const u = user.toLowerCase();
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((g) => {
    const w = g.players.white, b = g.players.black;
    const meWhite = (w.user?.id || '') === u;
    const res = !g.winner ? 'draw' : (g.winner === 'white') === meWhite ? 'win' : 'loss';
    let fen = null;
    try { const c = new Chess(); for (const m of (g.moves || '').split(' ').filter(Boolean)) c.move(m); fen = c.fen(); } catch {}
    return {
      speed: g.speed, tc: g.clock ? `${g.clock.initial}+${g.clock.increment}` : '', white: w.user?.name || (w.aiLevel ? `Stockfish ${w.aiLevel}` : '?'), black: b.user?.name || (b.aiLevel ? `Stockfish ${b.aiLevel}` : '?'),
      wr: w.rating, br: b.rating, res, meWhite, accW: w.analysis?.accuracy, accB: b.analysis?.accuracy,
      moves: Math.ceil((g.moves || '').split(' ').filter(Boolean).length / 2), date: new Date(g.createdAt), pgn: g.pgn, url: 'https://lichess.org/' + g.id, fen, opening: g.opening?.name,
    };
  });
}

function fmtTc(tc) {
  if (!tc) return '';
  if (tc.includes('/')) return 'dzienne';
  const [b, i] = tc.split('+').map(Number);
  return `${b >= 60 ? Math.round(b / 60) + ' min' : b + ' s'}${i ? ' +' + i : ''}`;
}
function gamesTable(list) {
  if (!list.length) return '<p class="muted">Brak partii.</p>';
  return `<table class="pp-games"><tr><th></th><th>Gracze</th><th>Wynik</th><th>Dokładność</th><th>Ruchy</th><th>Data</th><th></th></tr>
    ${list.map((g, i) => {
      const myW = g.meWhite;
      const sym = g.res === 'win' ? '+' : g.res === 'loss' ? '−' : '=';
      return `<tr>
        <td class="pp-sp"><span class="ic">${icon(SPEED_ICON[g.speed] || 'rapid', 22)}</span><small>${esc(fmtTc(g.tc))}</small></td>
        <td class="pp-pl"><div><i class="sq w"></i><b>${esc(g.white)}</b> <span class="muted">(${g.wr ?? '?'})</span></div><div><i class="sq b"></i><b>${esc(g.black)}</b> <span class="muted">(${g.br ?? '?'})</span></div>${g.opening ? `<small class="muted">${esc(g.opening)}</small>` : ''}</td>
        <td class="pp-res"><div class="num">${g.res === 'draw' ? '½<br>½' : (g.res === 'win') === myW ? '1<br>0' : '0<br>1'}</div><span class="rs ${g.res === 'win' ? 'w' : g.res === 'loss' ? 'l' : 'd'}">${sym}</span></td>
        <td class="pp-acc num">${g.accW != null ? `<div>${g.accW.toFixed ? g.accW.toFixed(1) : g.accW}</div><div>${g.accB?.toFixed ? g.accB.toFixed(1) : g.accB ?? ''}</div>` : '<button class="btn small" data-rev="' + i + '">Przegląd</button>'}</td>
        <td class="num">${g.moves}</td>
        <td class="num">${g.date.toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
        <td><button class="btn small" data-rev="${i}">Przegląd</button> <a class="icon-btn" href="${esc(g.url)}" target="_blank" rel="noopener" title="Otwórz na stronie">↗</a></td></tr>`;
    }).join('')}</table>`;
}
function statsHtml(list) {
  const by = {};
  for (const g of list) { const k = SPEED_PL[g.speed] || g.speed; (by[k] ||= { w: 0, d: 0, l: 0, acc: [] }); by[k][g.res[0]]++; const a = g.meWhite ? g.accW : g.accB; if (a != null) by[k].acc.push(+a); }
  const rows = Object.entries(by);
  if (!rows.length) return '<p class="muted">Brak danych.</p>';
  return `<div class="pp-stats">${rows.map(([k, v]) => {
    const n = v.w + v.d + v.l;
    const acc = v.acc.length ? (v.acc.reduce((a, b) => a + b, 0) / v.acc.length).toFixed(1) : '–';
    return `<div class="rcard"><div class="rc-top"><div><small>${esc(k)}</small><b class="num">${n}</b></div><span class="muted" style="margin-left:auto">partii</span></div>
      <div class="stack" style="margin-top:10px"><div style="width:${(v.w / n) * 100}%;background:#81b64c"></div><div style="width:${(v.d / n) * 100}%;background:#8f8c84"></div><div style="width:${(v.l / n) * 100}%;background:#e5533d"></div></div>
      <div class="legend"><span>Wygrane<b>${v.w}</b></span><span>Remisy<b>${v.d}</b></span><span>Porażki<b>${v.l}</b></span><span>Dokładność<b>${acc}</b></span></div></div>`;
  }).join('')}</div><p class="muted">Statystyki z ostatnich ${list.length} partii.</p>`;
}

async function loadGames(which) {
  const p = A.profile();
  src = which;
  A.store.set('ppSrc', which);
  A.renderRatingsInto($('pp-ratings'), which);
  for (const b of document.querySelectorAll('#pp-src button')) b.classList.toggle('on', b.dataset.src === which);
  const box = $('pp-games');
  const user = which === 'chesscom' ? p.chesscom : p.lichess;
  if (!user) { box.innerHTML = `<p class="muted">Wpisz nick z ${which === 'chesscom' ? 'chess.com' : 'lichess'} w <a href="#" data-pp="edit">edycji profilu</a>.</p>`; return; }
  box.innerHTML = '<p class="muted">Pobieram ostatnie partie…</p>';
  try {
    games = which === 'chesscom' ? await chesscomGames(user) : await lichessGames(user);
    renderSub(A.store.get('ppSub', 'overview'));
  } catch (e) { box.innerHTML = `<p class="muted">Nie udało się pobrać partii: ${esc(e.message)}</p>`; }
}
function renderSub(sub) {
  A.store.set('ppSub', sub);
  for (const b of document.querySelectorAll('#pp-tabs button')) b.classList.toggle('active', b.dataset.sub === sub);
  const box = $('pp-games');
  if (sub === 'stats') box.innerHTML = statsHtml(games);
  else if (sub === 'games') box.innerHTML = gamesTable(games);
  else {
    const last = games[0];
    box.innerHTML = (last?.fen ? `<div class="pp-last">${miniBoard(last.fen, { flip: !last.meWhite })}<div><b>Ostatnia partia</b><div class="muted">${esc(last.white)} – ${esc(last.black)} · ${last.res === 'win' ? 'wygrana' : last.res === 'loss' ? 'porażka' : 'remis'}</div><button class="btn primary" data-rev="0" style="margin-top:8px">Przegląd partii</button></div></div>` : '')
      + `<h3>Historia partii</h3>` + gamesTable(games.slice(0, 10));
  }
  fx.enter(box.querySelectorAll('tr, .rcard, .pp-last'), { step: 18 });
}

export async function renderProfilePage(api) {
  A = api;
  const el = $('tab-profile');
  const p = A.profile();
  let cc = null;
  if (p.chesscom) {
    try { cc = await (await A.apiFetch('chesscom', `pub/player/${encodeURIComponent(p.chesscom.toLowerCase())}`)).json(); } catch {}
  }
  const joined = cc?.joined ? new Date(cc.joined * 1000).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' }) : (p.created ? new Date(p.created).toLocaleDateString('pl-PL') : '');
  el.innerHTML = `<div class="home">
    <div class="pp-head hcard">
      <div class="pp-ava">${p.avatar ? `<img src="${p.avatar}" alt="">` : cc?.avatar ? `<img src="${esc(cc.avatar)}" alt="">` : A.avatarHtml(p, 120)}</div>
      <div class="pp-info">
        <div class="pp-name">${esc(p.name || cc?.username || 'Gość')}</div>
        ${cc?.location ? `<div class="muted">📍 ${esc(cc.location)}</div>` : ''}
        <div class="pp-meta">${joined ? `<span>Dołączył: <b>${esc(joined)}</b></span>` : ''}<span>🔥 <b>${A.streak()}</b> dni serii</span><span>Partie tutaj: <b>${p.games || 0}</b></span>
          ${p.chesscom ? `<a href="https://www.chess.com/member/${esc(p.chesscom)}" target="_blank" rel="noopener">chess.com ↗</a>` : ''}${p.lichess ? `<a href="https://lichess.org/@/${esc(p.lichess)}" target="_blank" rel="noopener">lichess ↗</a>` : ''}</div>
      </div>
      <button class="btn" data-pp="edit">Edytuj profil</button>
    </div>
    <div class="pp-tabs" id="pp-tabs"><button data-sub="overview">Przegląd</button><button data-sub="games">Partie</button><button data-sub="stats">Statystyki</button>
      <div class="rating-src" id="pp-src" style="margin-left:auto"><button data-src="chesscom">chess.com</button><button data-src="lichess">lichess</button></div></div>
    <div id="pp-ratings"></div>
    <div class="hcard" id="pp-games"></div>
  </div>`;
  el.onclick = (e) => {
    const t = e.target.closest('[data-sub]'); if (t && t.closest('#pp-tabs')) return renderSub(t.dataset.sub);
    const s = e.target.closest('[data-src]'); if (s) return loadGames(s.dataset.src);
    const r = e.target.closest('[data-rev]'); if (r) return A.reviewPgn(games[+r.dataset.rev].pgn);
    if (e.target.closest('[data-pp="edit"]')) { e.preventDefault(); A.showTab('settings'); }
  };
  fx.enter(el.querySelectorAll('.pp-head, .pp-tabs'), { step: 40 });
  loadGames(A.store.get('ppSrc', p.chesscom ? 'chesscom' : 'lichess'));
}

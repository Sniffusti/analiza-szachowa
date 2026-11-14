// Web Worker: buduje drzewko otwarć z wielu partii PGN (baza z ChessBase, partie z chess.com/lichess).
import { Chess } from './vendor/chess.js';
import { splitGames, parseHeaders, mainlineSans } from './pgn.js';

const epd = (fen) => fen.split(' ').slice(0, 4).join(' ');

onmessage = (e) => {
  const { text, pgns, maxPlies = 30, user = null, maxGames = Infinity } = e.data;
  const list = pgns || splitGames(text || '');
  const trees = { all: {}, w: {}, b: {} };
  const games = [];
  const total = Math.min(list.length, maxGames);
  for (let gi = 0; gi < total; gi++) {
    const pgn = list[gi];
    const h = parseHeaders(pgn);
    const res = h.Result === '1-0' ? 0 : h.Result === '0-1' ? 2 : h.Result === '1/2-1/2' ? 1 : -1;
    let userColor = null;
    if (user) {
      const u = user.toLowerCase();
      if ((h.White || '').toLowerCase() === u) userColor = 'w';
      else if ((h.Black || '').toLowerCase() === u) userColor = 'b';
    }
    const tree = user ? (userColor ? trees[userColor] : null) : trees.all;
    games.push({
      w: h.White || '?', b: h.Black || '?', we: h.WhiteElo || '', be: h.BlackElo || '',
      r: h.Result || '*', d: (h.Date || h.UTCDate || '').replace(/\?+/g, ''), ev: h.Event || '', pgn,
    });
    if (!tree) continue;
    const c = new Chess(h.SetUp === '1' && h.FEN ? h.FEN : undefined);
    const sans = mainlineSans(pgn);
    for (let i = 0; i < Math.min(maxPlies, sans.length); i++) {
      const key = epd(c.fen());
      let m;
      try { m = c.move(sans[i], { strict: false }); } catch { break; }
      const node = tree[key] || (tree[key] = { m: {}, g: [] });
      const mv = node.m[m.san] || (node.m[m.san] = { u: m.from + m.to + (m.promotion || ''), s: [0, 0, 0] });
      if (res >= 0) mv.s[res]++;
      if (node.g.length < 40) node.g.push(gi);
    }
    if (gi % 300 === 0) postMessage({ progress: gi / total });
  }
  postMessage({ done: true, trees, games });
};

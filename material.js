// Zbite bierki i przewaga materiału (jak na chess.com / lichess).
const START = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const ROLE = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen' };

/** Zwraca dla każdego koloru: listę zbitych bierek przeciwnika i przewagę punktową. */
export function material(fen) {
  const board = fen.split(' ')[0];
  const cnt = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const ch of board) {
    const t = ch.toLowerCase();
    if (!(t in VAL)) continue;
    cnt[ch === t ? 'b' : 'w'][t]++;
  }
  const score = (c) => Object.entries(cnt[c]).reduce((s, [t, n]) => s + n * VAL[t], 0);
  const diff = score('w') - score('b');
  // zbite przez białe = brakujące czarne (promocje mogą dać ujemne – wtedy 0)
  const captured = (by) => {
    const opp = by === 'w' ? 'b' : 'w';
    const out = [];
    for (const t of ['p', 'n', 'b', 'r', 'q']) for (let i = 0; i < Math.max(0, START[t] - cnt[opp][t]); i++) out.push(t);
    return out;
  };
  return { w: { captured: captured('w'), plus: diff > 0 ? diff : 0 }, b: { captured: captured('b'), plus: diff < 0 ? -diff : 0 } };
}

/** HTML: zbite bierki przeciwnika (grupami) + „+N” dla strony z przewagą. */
export function materialHtml(fen, color) {
  const m = material(fen)[color];
  const oppColor = color === 'w' ? 'black' : 'white';
  let html = '';
  let prev = null;
  for (const t of m.captured) {
    html += `<piece class="${ROLE[t]} ${oppColor}${prev && prev !== t ? ' gap' : ''}"></piece>`;
    prev = t;
  }
  return `<span class="mat">${html}${m.plus ? `<b>+${m.plus}</b>` : ''}</span>`;
}

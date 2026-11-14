// Parser PGN z wariantami → drzewo repertuaru {epd: {san: uci}} (do drilli debiutowych).
import { Chess } from './vendor/chess.js';
import { splitGames, parseHeaders } from './pgn.js';

export const epd = (fen) => fen.split(' ').slice(0, 4).join(' ');

function tokenize(body) {
  const out = [];
  const re = /\{[^}]*\}|;[^\n]*|\(|\)|\$\d+|[^\s(){};]+/g;
  let m;
  while ((m = re.exec(body))) {
    const t = m[0];
    if (t[0] === '{' || t[0] === ';' || t[0] === '$') continue;
    out.push(t);
  }
  return out;
}

/** Dodaje wszystkie ruchy (z wariantami) jednej partii do drzewa. Zwraca liczbę dodanych ruchów. */
export function addGameToTree(pgn, tree) {
  const h = parseHeaders(pgn);
  const startFen = h.SetUp === '1' && h.FEN ? h.FEN : new Chess().fen();
  const body = pgn.replace(/^\s*\[.*\]\s*$/gm, '');
  const tokens = tokenize(body);
  let added = 0;
  // stos: każda pozycja = {fen (przed ostatnim ruchem), cur (po)}
  let prevFen = startFen; // pozycja przed ostatnim zagranym ruchem
  let curFen = startFen;
  const stack = [];
  for (const raw of tokens) {
    if (raw === '(') { stack.push({ prevFen, curFen }); curFen = prevFen; continue; }
    if (raw === ')') { const s = stack.pop(); if (s) { prevFen = s.prevFen; curFen = s.curFen; } continue; }
    const t = raw.replace(/^\d+\.(\.\.)?/, '').replace(/[!?]+$/, '');
    if (!t || /^(1-0|0-1|1\/2-1\/2|\*|\d+\.+)$/.test(t)) continue;
    const c = new Chess(curFen);
    let m;
    try { m = c.move(t, { strict: false }); } catch { continue; }
    const key = epd(curFen);
    const node = tree[key] || (tree[key] = {});
    if (!node[m.san]) { node[m.san] = m.from + m.to + (m.promotion || ''); added++; }
    prevFen = curFen;
    curFen = c.fen();
  }
  return added;
}

export function treeFromPgn(text) {
  const tree = {};
  let moves = 0, games = 0;
  for (const g of splitGames(text)) { moves += addGameToTree(g, tree); games++; }
  return { tree, moves, games };
}

/** Liczba końcówek linii (liści) w drzewie od pozycji startowej. */
export function countLines(tree, fen = new Chess().fen(), seen = new Set()) {
  const key = epd(fen);
  if (seen.has(key)) return 0;
  const node = tree[key];
  if (!node || !Object.keys(node).length) return 1;
  seen.add(key);
  let n = 0;
  for (const uci of Object.values(node)) {
    const c = new Chess(fen);
    try { c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { continue; }
    n += countLines(tree, c.fen(), seen);
  }
  seen.delete(key);
  return n;
}

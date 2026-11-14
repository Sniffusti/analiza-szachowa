// Lekki parser PGN (szybszy niż loadPgn przy dużych bazach, np. eksport z ChessBase).
import { Chess } from './vendor/chess.js';

/** Dzieli tekst z wieloma partiami na osobne PGN-y. */
export function splitGames(text) {
  const lines = text.replace(/\r/g, '').replace(/^﻿/, '').split('\n');
  const games = [];
  let cur = [];
  let inMoves = false;
  for (const line of lines) {
    const isHeader = /^\s*\[\w+\s+".*"\]\s*$/.test(line);
    if (isHeader && inMoves) {
      if (cur.join('').trim()) games.push(cur.join('\n'));
      cur = [];
      inMoves = false;
    }
    if (!isHeader && line.trim()) inMoves = true;
    cur.push(line);
  }
  if (cur.join('').trim()) games.push(cur.join('\n'));
  return games;
}

export function parseHeaders(pgn) {
  const h = {};
  const re = /^\s*\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]/gm;
  let m;
  while ((m = re.exec(pgn))) h[m[1]] = m[2].replace(/\\"/g, '"');
  return h;
}

/** Zwraca listę SAN głównej linii (bez komentarzy, wariantów, NAG). */
export function mainlineSans(pgn) {
  let body = pgn.replace(/^\s*\[.*\]\s*$/gm, '');
  body = body.replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ');
  // usuń warianty (zagnieżdżone nawiasy)
  let out = '', depth = 0;
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out
    .replace(/\$\d+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^\d+\.(\.\.)?/, '').replace(/[!?]+$/, ''))
    .filter((t) => t && !/^(1-0|0-1|1\/2-1\/2|\*|\d+\.+)$/.test(t));
}

/** Pełna partia do analizy. */
export function buildGame(pgn) {
  const headers = parseHeaders(pgn);
  const startFen = headers.SetUp === '1' && headers.FEN ? headers.FEN : new Chess().fen();
  const c = new Chess(startFen);
  const moves = [];
  for (const san of mainlineSans(pgn)) {
    const fenBefore = c.fen();
    let m;
    try { m = c.move(san, { strict: false }); } catch { break; }
    moves.push({
      san: m.san, uci: m.from + m.to + (m.promotion || ''), color: m.color, from: m.from, to: m.to,
      piece: m.piece, captured: m.captured, fenBefore, fenAfter: c.fen(),
    });
  }
  return { headers, startFen, moves };
}

export function gameFromFen(fen) {
  const c = new Chess(fen); // rzuca wyjątek, gdy FEN niepoprawny
  return { headers: { SetUp: '1', FEN: c.fen() }, startFen: c.fen(), moves: [] };
}

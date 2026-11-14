// Ocena ruchów w stylu "Game Review".
// Kluczowa różnica, o którą chodziło:
//  * BLUNDER / POMYŁKA / NIEDOKŁADNOŚĆ – Twój ruch sam coś psuje: przeciwnik ma odpowiedź,
//    która wygrywa materiał, matuje albo pozycja się wyraźnie odwraca ("podstawka").
//  * PRZEGAPIONA WYGRANA / NIEDOPATRZENIE – Twój ruch niczego nie oddaje, ale miałeś
//    taktyczny motyw (mat, wygranie materiału, widełki...), którego nie zauważyłeś.
import { Chess } from './vendor/chess.js';

// Nazwy, kolejność i kolory jak w „Przeglądzie partii” na chess.com (PL).
export const CLASSES = {
  brilliant:  { label: 'Genialny',      glyph: '!!', color: '#26c2a3', nag: '$3' },
  great:      { label: 'Wspaniały',     glyph: '!',  color: '#749bbf', nag: '$1' },
  book:       { label: 'Książkowy',     glyph: 'book', color: '#d5a47d', nag: '' },
  best:       { label: 'Najlepszy',     glyph: '★',  color: '#81b64c', nag: '' },
  excellent:  { label: 'Bardzo dobry',  glyph: 'thumb', color: '#81b64c', nag: '' },
  good:       { label: 'Dobry',         glyph: '✓',  color: '#95b776', nag: '' },
  inaccuracy: { label: 'Niedokładność', glyph: '?!', color: '#f7c631', nag: '$6' },
  mistake:    { label: 'Błąd',          glyph: '?',  color: '#ffa459', nag: '$2' },
  miss:       { label: 'Przeoczenie',   glyph: '✕',  color: '#ff7769', nag: '$2' },
  blunder:    { label: 'Poważny błąd',  glyph: '??', color: '#fa412d', nag: '$4' },
};
export const CLASS_ORDER = ['brilliant', 'great', 'book', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'miss', 'blunder'];
export const ERROR_CLASSES = ['inaccuracy', 'mistake', 'miss', 'blunder'];

// Parametry oceny (dopasowane do „Przeglądu partii” z chess.com).
export const P = {
  k: 0.00368208,      // nachylenie krzywej szansy wygranej
  bestTol: 0,         // „Najlepszy” tylko dla ruchu silnika
  exc: 1.5, good: 3.5, inacc: 9, mistake: 20,
  bookPlies: 10, bookLoss: 5,
  greatGap: 20, greatSecondMax: 55,
  missWinB: 80, missWinA: 70, missLoss: 10,
  accK: 0.07, harmW: 0.5,
};
export function setParams(o) { Object.assign(P, o); }

export const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const NAMES = { p: 'pionka', n: 'skoczka', b: 'gońca', r: 'wieżę', q: 'hetmana', k: 'króla' };
const NAMES_NOM = { p: 'pionek', n: 'skoczek', b: 'goniec', r: 'wieża', q: 'hetman', k: 'król' };

/** Szansa wygranej (0-100) z perspektywy białych – wzór lichess. */
export function winPct(ev) {
  if (!ev) return 50;
  if (ev.mate !== null && ev.mate !== undefined) return ev.mate > 0 ? 100 : ev.mate < 0 ? 0 : (ev.mateWinner === 'w' ? 100 : ev.mateWinner === 'b' ? 0 : 50);
  const cp = Math.max(-1000, Math.min(1000, ev.cp ?? 0));
  return 50 + 50 * (2 / (1 + Math.exp(-P.k * cp)) - 1);
}
export const povWin = (ev, color) => (color === 'w' ? winPct(ev) : 100 - winPct(ev));

export function moveAccuracy(loss) {
  // krzywa ostrzejsza niż na lichess – wyniki bliższe dokładności z chess.com
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-P.accK * loss) - 3.1669));
}

export function formatEval(ev) {
  if (!ev) return '';
  if (ev.mate !== null && ev.mate !== undefined) {
    if (ev.mate === 0) return ev.mateWinner === 'w' ? '1-0' : ev.mateWinner === 'b' ? '0-1' : '½';
    return (ev.mate > 0 ? '+M' : '-M') + Math.abs(ev.mate);
  }
  const v = (ev.cp ?? 0) / 100;
  return (v > 0 ? '+' : '') + v.toFixed(Math.abs(v) >= 10 ? 0 : 1);
}

export function material(chess, color) {
  let s = 0;
  for (const row of chess.board()) for (const sq of row) if (sq && sq.color === color) s += VALUES[sq.type];
  return s;
}
const balance = (chess, color) => material(chess, color) - material(chess, color === 'w' ? 'b' : 'w');

/** Przebieg linii UCI; zwraca [{san, before, after, move}] */
export function playLine(fen, ucis, max = 99) {
  const c = new Chess(fen);
  const out = [];
  for (const u of ucis.slice(0, max)) {
    try {
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      out.push({ san: m.san, move: m, fen: c.fen() });
    } catch { break; }
  }
  return { chess: c, steps: out };
}

/** Zmiana bilansu materiału dla `color` po zagraniu `plies` ruchów linii (liczone po pełnych wymianach). */
function materialSwing(fen, pv, color, plies = 6) {
  const start = new Chess(fen);
  const b0 = balance(start, color);
  const { steps } = playLine(fen, pv, plies);
  if (!steps.length) return 0;
  // bierzemy najgorszy/najlepszy wynik po "spokojnych" punktach – po ruchu strony, która zaczyna linię, bez wiszącego odbicia
  let n = steps.length;
  // jeśli ostatni ruch linii był biciem, a odbicie się nie zmieściło – nie liczymy go
  if (steps[n - 1].move.captured && n > 1) n--;
  return balance(new Chess(steps[n - 1].fen), color) - b0;
}

function lowestAttacker(chess, square, byColor) {
  const sqs = chess.attackers(square, byColor);
  let best = 99;
  for (const s of sqs) best = Math.min(best, VALUES[chess.get(s).type] || 0.5);
  return sqs.length ? best : null;
}

/** Figury strony `color`, które wiszą (atakowane i niebronione albo atakowane przez tańszą figurę). */
export function hangingPieces(chess, color) {
  const opp = color === 'w' ? 'b' : 'w';
  const res = [];
  for (const row of chess.board()) for (const p of row) {
    if (!p || p.color !== color || p.type === 'k') continue;
    const low = lowestAttacker(chess, p.square, opp);
    if (low === null) continue;
    const defended = chess.attackers(p.square, color).length > 0;
    if (!defended || low < VALUES[p.type]) res.push(p);
  }
  return res.sort((a, b) => VALUES[b.type] - VALUES[a.type]);
}

/** Opis motywu taktycznego zagrania `uci` w pozycji `fen` z kontynuacją `pv`. */
export function describeMotif(fen, pv, ev) {
  const c = new Chess(fen);
  const color = c.turn();
  const opp = color === 'w' ? 'b' : 'w';
  const parts = [];
  let tactical = false;
  const mover = color;
  if (ev && ev.mate !== null && ev.mate !== undefined && ev.mate !== 0 && (ev.mate > 0) === (mover === 'w')) {
    parts.push(`mat w ${Math.abs(ev.mate)}`);
    tactical = true;
  }
  let m;
  try { m = c.move({ from: pv[0].slice(0, 2), to: pv[0].slice(2, 4), promotion: pv[0][4] }); } catch { return { text: '', tactical: false }; }
  if (m.promotion) { parts.push('promocja'); tactical = true; }
  if (m.captured) {
    const before = new Chess(fen);
    const defended = before.attackers(m.to, opp).length > 0;
    if (!defended) { parts.push(`bicie wiszącej figury (${NAMES[m.captured]})`); tactical = true; }
    else if (VALUES[m.captured] > VALUES[m.piece]) { parts.push(`bicie ${NAMES[m.captured]} tańszą figurą`); tactical = true; }
  }
  // widełki / podwójny atak
  const targets = [];
  for (const row of c.board()) for (const p of row) {
    if (!p || p.color !== opp) continue;
    if (!c.attackers(p.square, color).includes(m.to)) continue;
    const defended = c.attackers(p.square, opp).length > 0;
    if (p.type === 'k' || VALUES[p.type] > VALUES[m.piece] || (!defended && VALUES[p.type] >= 3)) targets.push(p);
  }
  if (targets.length >= 2 && !(lowestAttacker(c, m.to, opp) !== null && lowestAttacker(c, m.to, opp) <= VALUES[m.piece] && c.attackers(m.to, color).length === 0)) {
    parts.push(`widełki: ${NAMES_NOM[m.piece]} atakuje ${targets.map((t) => (t.type === 'k' ? 'króla' : NAMES[t.type]) + ' ' + t.square).join(' i ')}`);
    tactical = true;
  } else if (c.inCheck()) parts.push('szach');
  const swing = materialSwing(fen, pv, color, 6);
  if (swing >= 2) { parts.push(`wygrywa materiał (+${swing})`); tactical = true; }
  return { text: parts.join(', '), tactical, swing };
}

const epd = (fen) => fen.split(' ').slice(0, 4).join(' ');

/**
 * Klasyfikacja wszystkich ruchów partii.
 * game.moves[i] = {san, uci, color, fenBefore, fenAfter}
 * evals[i] = ocena pozycji przed ruchem i (perspektywa białych) {cp, mate, best, pv, second}
 */
export function classifyGame(game, evals, openings) {
  const out = [];
  let inBook = true;
  for (let i = 0; i < game.moves.length; i++) {
    const mv = game.moves[i];
    const before = evals[i], after = evals[i + 1];
    if (!before || !after) { out.push(null); continue; }
    const color = mv.color;
    const opp = color === 'w' ? 'b' : 'w';
    const wpB = povWin(before, color);
    const wpA = povWin(after, color);
    const isBest = before.best === mv.uci;
    let loss = isBest ? 0 : Math.max(0, wpB - wpA);
    const acc = moveAccuracy(loss);
    const r = { cls: 'good', loss, acc, wpB, wpA, isBest, text: '', bestSan: null, bestLine: null, punishSan: null };

    if (!isBest && before.pv?.length) {
      const pl = playLine(mv.fenBefore, before.pv, 8);
      r.bestSan = pl.steps[0]?.san;
      r.bestLine = pl.steps.map((s) => s.san);
    }

    // 1. Książka: pozycja z bazy otwarć albo spokojny ruch w pierwszych półruchach, dopóki trwa teoria
    const named = openings[epd(mv.fenAfter)];
    const f = mv.fenBefore.split(' ');
    const ply = (+f[5] - 1) * 2 + (f[1] === 'b' ? 1 : 0);
    const quietTheory = ply < P.bookPlies && loss < P.bookLoss && wpA > 35 && wpA < 65 && !mv.captured;
    if (inBook && ((named && ply < 30 && loss < 15) || quietTheory)) {
      r.cls = 'book';
      r.text = named ? named.n : 'Znany ruch debiutowy.';
      out.push(r);
      continue;
    }
    inBook = false;

    // 2. Czy ruch daje się ukarać? (podstawka / przegrany materiał / mat / załamanie pozycji)
    const afterChess = new Chess(mv.fenAfter);
    let punish = null;
    if (after.pv?.length) {
      const swing = materialSwing(mv.fenAfter, after.pv, opp, 6); // zysk przeciwnika = strata gracza
      const oppMate = after.mate !== null && after.mate !== undefined && after.mate !== 0 && (after.mate > 0) === (opp === 'w');
      const ownMateBefore = before.mate !== null && before.mate !== undefined && (before.mate > 0) === (opp === 'w');
      const collapse = wpA < 30 && wpB >= 45;
      if (swing >= 2 || (oppMate && !ownMateBefore) || collapse) {
        const reply = playLine(mv.fenAfter, after.pv, 6);
        r.punishSan = reply.steps[0]?.san;
        r.punishLine = reply.steps.map((s) => s.san);
        const hang = hangingPieces(afterChess, color)[0];
        const why = [];
        const first = reply.steps[0]?.move;
        if (oppMate) why.push(`przeciwnik ma mata w ${Math.abs(after.mate)}`);
        else if (first?.captured && swing >= 2) why.push(`przeciwnik zabiera ${NAMES[first.captured]} na ${first.to} i wygrywa materiał (−${swing})`);
        else if (hang && swing >= 2) why.push(`zostawia ${NAMES[hang.type]} na ${hang.square} bez obrony`);
        else if (swing >= 2) why.push(`przeciwnik wygrywa materiał (−${swing})`);
        else why.push('pozycja się załamuje');
        punish = { swing, oppMate, text: why.join(', ') };
      }
    }

    // 3. Motyw, który dawał najlepszy ruch
    const bestMotif = !isBest && before.pv?.length ? describeMotif(mv.fenBefore, before.pv, before) : null;
    const prev = i > 0 ? game.moves[i - 1] : null;
    const obviousRecapture = !!(prev?.captured && mv.captured && prev.to === mv.to);

    if (isBest || loss < P.bestTol) {
      r.cls = 'best';
      // Świetny (!): jedyny dobry ruch – np. ten daje +4, a każdy inny najwyżej ~0.00 albo minus
      const second = before.second;
      if (isBest && second && !obviousRecapture) {
        const wpSecond = povWin(second, color);
        if (wpB - wpSecond >= P.greatGap && wpSecond <= P.greatSecondMax && wpA >= 45) r.cls = 'great';
      }
      if (isSacrifice(mv, after) && wpA >= 45 && wpB < 97) r.cls = 'brilliant';
    } else if (loss < P.exc) {
      r.cls = isSacrifice(mv, after) && wpA >= 50 && wpB < 97 ? 'brilliant' : 'excellent';
    } else if (loss < P.good) {
      r.cls = 'good';
    } else if (!punish && (bestMotif?.tactical || (wpB >= P.missWinB && wpA < P.missWinA && loss >= P.missLoss))) {
      // Przeoczenie: Twój ruch niczego nie oddaje, ale przegapiłeś motyw albo wygraną
      r.cls = 'miss';
      r.missWin = wpB >= P.missWinB && wpA < P.missWinA;
      const what = bestMotif?.text ? ` – ${bestMotif.text}` : '';
      r.text = `${r.missWin ? 'Przegapiona wygrana' : 'Przeoczony motyw'}: ${r.bestSan}${what}. Twój ruch niczego nie oddaje, ale tę szansę przegapiłeś.`;
    } else if (loss < P.inacc) r.cls = 'inaccuracy';
    else if (loss < P.mistake) r.cls = 'mistake';
    else r.cls = 'blunder';

    if (['inaccuracy', 'mistake', 'blunder'].includes(r.cls)) {
      if (punish) r.text = `Po ${r.punishSan ?? '…'} ${punish.text}.`;
      else r.text = 'Słabszy ruch – bez straty materiału, ale pozycja się pogarsza.';
      if (bestMotif?.text) r.text += ` Lepsze było ${r.bestSan} (${bestMotif.text}).`;
      else if (r.bestSan) r.text += ` Lepsze było ${r.bestSan}.`;
    }
    out.push(r);
  }
  return out;
}

/** Poświęcenie: ruszona figura (≥ skoczek) stoi na polu bitym i przeciwnik może ją zabić z zyskiem. */
function isSacrifice(mv, after) {
  const c = new Chess(mv.fenAfter);
  const p = c.get(mv.to);
  if (!p || p.type === 'p' || p.type === 'k') return false;
  const opp = p.color === 'w' ? 'b' : 'w';
  const low = lowestAttacker(c, mv.to, opp);
  if (low === null) return false;
  const captured = mv.captured ? VALUES[mv.captured] : 0;
  const defended = c.attackers(mv.to, p.color).length > 0;
  const loses = !defended ? VALUES[p.type] - captured : VALUES[p.type] - low - captured;
  if (loses < 2) return false;
  // pozycja po ruchu nadal dobra mimo straty materiału => prawdziwa ofiara
  return true;
}

export function gameAccuracy(review, color, moves) {
  const accs = review.filter((r, i) => r && moves[i].color === color).map((r) => r.acc);
  if (!accs.length) return null;
  const mean = accs.reduce((a, b) => a + b, 0) / accs.length;
  const harm = accs.length / accs.reduce((a, b) => a + 1 / Math.max(b, 5), 0);
  return (1 - P.harmW) * mean + P.harmW * harm;
}

/** Przybliżony „ranking na podstawie partii” z dokładności (kalibracja na przykładach z chess.com). */
export function estimateRating(acc) {
  if (acc === null || acc === undefined) return null;
  return Math.round(Math.max(100, Math.min(3200, 950 + 55.5 * (acc - 63.4))) / 50) * 50;
}

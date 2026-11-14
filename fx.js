// Animacje: Motion (motion.dev) – sprężyste wejścia, rysowanie wykresów; anime.js – liczniki i potrząśnięcia.
// Zabezpieczenie: po chwili elementy zawsze wracają do stanu końcowego (gdy karta w tle wstrzyma klatki).
import { animate as aAnimate } from './vendor/anime.esm.min.js';

const M = () => globalThis.Motion;
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const list = (t) => (typeof t === 'string' ? [...document.querySelectorAll(t)] : t?.length !== undefined ? [...t] : t ? [t] : []);
const settle = (els, props, ms) => setTimeout(() => { for (const el of els) for (const p of props) el.style[p] = ''; }, ms);

/** Wejście elementów: sprężyna z lekkim uniesieniem i kolejnym opóźnieniem (Motion). */
export function enter(targets, { delay = 0, step = 30, dist = 10 } = {}) {
  const els = list(targets);
  if (!els.length || reduce()) return;
  if (M()) {
    M().animate(els, { opacity: [0, 1], transform: [`translateY(${dist}px) scale(.985)`, 'translateY(0) scale(1)'] },
      { type: 'spring', stiffness: 260, damping: 24, delay: M().stagger(step / 1000, { startDelay: delay / 1000 }) });
  } else {
    aAnimate(els, { opacity: [0, 1], translateY: [dist, 0], duration: 420, delay: (_, i) => delay + i * step, ease: 'outCubic' });
  }
  settle(els, ['opacity', 'transform'], 700 + delay + step * els.length);
}

/** Licznik od 0 do wartości (anime.js). */
export function countUp(el, to, decimals = 0, { suffix = '' } = {}) {
  if (!el || to === null || to === undefined || isNaN(to)) return;
  const final = to.toFixed(decimals) + suffix;
  if (reduce()) { el.textContent = final; return; }
  const o = { v: 0 };
  const a = aAnimate(o, { v: to, duration: 900, ease: 'outExpo', onUpdate: () => { el.textContent = o.v.toFixed(decimals) + suffix; } });
  setTimeout(() => { a.pause?.(); el.textContent = final; }, 1300);
}

/** Potrząśnięcie (zły ruch). */
export function shake(el) {
  if (!el || reduce()) return;
  aAnimate(el, { translateX: [0, -7, 7, -5, 5, -2, 0], duration: 420, ease: 'inOutSine' });
  settle([el], ['transform'], 800);
}

/** „Pyknięcie” – sprężyste powiększenie (Motion). */
export function pop(el) {
  if (!el || reduce()) return;
  if (M()) M().animate(el, { transform: ['scale(.94)', 'scale(1)'], opacity: [0.5, 1] }, { type: 'spring', stiffness: 420, damping: 18 });
  settle([el], ['transform', 'opacity'], 800);
}

/** Paski rosnące od zera. */
export function grow(targets) {
  const els = list(targets);
  if (!els.length || reduce()) return;
  for (const el of els) {
    const w = el.style.width;
    el.style.width = '0%';
    if (M()) M().animate(el, { width: ['0%', w] }, { duration: 0.8, delay: 0.08, ease: [0.22, 1, 0.36, 1] });
    else aAnimate(el, { width: w, duration: 800, ease: 'outCubic' });
    setTimeout(() => { el.style.width = w; }, 1300);
  }
}

/** Rysowanie linii wykresu (Motion: pathLength przez dasharray). */
export function drawPaths(targets) {
  const els = list(targets);
  if (!els.length || reduce()) return;
  for (const p of els) {
    const len = p.getTotalLength?.() || 0;
    if (!len) continue;
    p.style.strokeDasharray = `${len}`;
    p.style.strokeDashoffset = `${len}`;
    if (M()) M().animate(p, { strokeDashoffset: [len, 0] }, { duration: 1.1, ease: [0.22, 1, 0.36, 1] });
    setTimeout(() => { p.style.strokeDasharray = ''; p.style.strokeDashoffset = ''; }, 1500);
  }
}

// Animacje interfejsu (anime.js). Szanują „ogranicz ruch” w systemie.
// Każda animacja ma zabezpieczenie: jeśli przeglądarka wstrzyma klatki (karta w tle),
// po chwili elementy i tak wracają do stanu końcowego – nic nie zostaje ukryte.
import { animate, stagger } from './vendor/anime.esm.min.js';

const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const list = (t) => (typeof t === 'string' ? [...document.querySelectorAll(t)] : t?.length !== undefined ? [...t] : t ? [t] : []);

/** Płynne wejście elementów (lekko od dołu, kolejno). */
export function enter(targets, { delay = 0, step = 28, dist = 8 } = {}) {
  const els = list(targets);
  if (!els.length || reduce()) return;
  const anim = animate(els, { opacity: [0, 1], translateY: [dist, 0], duration: 420, delay: stagger(step, { start: delay }), ease: 'outCubic' });
  setTimeout(() => {
    anim.pause?.();
    for (const el of els) { el.style.opacity = ''; el.style.transform = ''; }
  }, 420 + delay + step * els.length + 400);
}

/** Licznik od 0 do wartości (liczby w kartach i wynikach). */
export function countUp(el, to, decimals = 0, { suffix = '' } = {}) {
  if (!el || to === null || to === undefined || isNaN(to)) return;
  const final = to.toFixed(decimals) + suffix;
  if (reduce()) { el.textContent = final; return; }
  const o = { v: 0 };
  const anim = animate(o, { v: to, duration: 900, ease: 'outExpo', onUpdate: () => { el.textContent = o.v.toFixed(decimals) + suffix; } });
  setTimeout(() => { anim.pause?.(); el.textContent = final; }, 1300);
}

/** Potrząśnięcie (zły ruch w zadaniu). */
export function shake(el) {
  if (!el || reduce()) return;
  const anim = animate(el, { translateX: [0, -7, 7, -5, 5, -2, 0], duration: 420, ease: 'inOutSine' });
  setTimeout(() => { anim.pause?.(); el.style.transform = ''; }, 800);
}

/** Krótkie „pyknięcie” (dobry ruch, rozwiązane zadanie). */
export function pop(el) {
  if (!el || reduce()) return;
  const anim = animate(el, { scale: [0.96, 1], opacity: [0.4, 1], duration: 360, ease: 'outBack(2)' });
  setTimeout(() => { anim.pause?.(); el.style.transform = ''; el.style.opacity = ''; }, 800);
}

/** Paski rosnące od zera (szerokość w %). */
export function grow(targets) {
  const els = list(targets);
  if (!els.length || reduce()) return;
  for (const el of els) {
    const w = el.style.width;
    el.style.width = '0%';
    const anim = animate(el, { width: w, duration: 800, delay: 80, ease: 'outCubic' });
    setTimeout(() => { anim.pause?.(); el.style.width = w; }, 1300);
  }
}

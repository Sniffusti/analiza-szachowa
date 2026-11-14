// Małe wykresy (w stylu shadcn charts): linia + delikatne wypełnienie, siatka, podpowiedź po najechaniu.
import * as fx from './fx.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let uid = 0;

/** points: [{t: ms, v: number}] */
export function areaChart(points, { w = 260, h = 64, color = '#8f6cf2', pad = 4 } = {}) {
  if (!points || points.length < 2) {
    const v = points?.[0]?.v;
    points = [{ t: Date.now() - 1, v: v ?? 0 }, { t: Date.now(), v: v ?? 0 }];
  }
  const vs = points.map((p) => p.v);
  let min = Math.min(...vs), max = Math.max(...vs);
  if (max - min < 20) { const m = (max + min) / 2; min = m - 10; max = m + 10; }
  const x = (i) => pad + (i / (points.length - 1)) * (w - pad * 2);
  const y = (v) => pad + (1 - (v - min) / (max - min)) * (h - pad * 2);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${h} L${x(0).toFixed(1)},${h} Z`;
  const id = 'c' + uid++;
  const data = esc(JSON.stringify(points.map((p) => [p.t, p.v])));
  return `<svg class="chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" data-pts="${data}" data-w="${w}" data-pad="${pad}" id="${id}">
    <line x1="0" x2="${w}" y1="${h * 0.33}" y2="${h * 0.33}" class="grid"/><line x1="0" x2="${w}" y1="${h * 0.66}" y2="${h * 0.66}" class="grid"/>
    <path d="${area}" fill="${color}" fill-opacity=".16"/>
    <path class="ln" d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <line class="cur" x1="0" x2="0" y1="0" y2="${h}" hidden/>
  </svg>`;
}

/** Karty rankingów jak w statystykach chess.com. items: {icon, color, label, rating, delta, history, sub} */
export function ratingCards(items) {
  return `<div class="rating-cards">${items.map((it) => {
    const d = it.delta;
    return `<div class="rcard" style="--c:${it.color}">
      <div class="rc-top"><span class="rc-ico">${it.icon}</span><div><small>${esc(it.label)}</small><b class="num">${it.rating ?? '–'}</b></div>
        ${d ? `<span class="rc-delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '↑' : '↓'} ${Math.abs(d)}</span>` : ''}</div>
      ${areaChart(it.history, { color: it.color })}
      <div class="rc-tip" hidden></div>
    </div>`;
  }).join('')}</div>`;
}

/** Podpowiedzi po najechaniu i animacja rysowania – wywołaj po wstawieniu HTML. */
export function bindCharts(root) {
  fx.drawPaths(root.querySelectorAll('.chart .ln'));
  for (const svg of root.querySelectorAll('.chart')) {
    const pts = JSON.parse(svg.dataset.pts);
    const card = svg.closest('.rcard');
    const tip = card?.querySelector('.rc-tip');
    const cur = svg.querySelector('.cur');
    svg.onmousemove = (e) => {
      const r = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(pts.length - 1, Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1))));
      const w = +svg.dataset.w, pad = +svg.dataset.pad;
      const xx = pad + (i / Math.max(1, pts.length - 1)) * (w - pad * 2);
      cur.setAttribute('x1', xx); cur.setAttribute('x2', xx); cur.hidden = false;
      if (tip) {
        tip.hidden = false;
        tip.textContent = `${new Date(pts[i][0]).toLocaleDateString('pl-PL')} · ${pts[i][1]}`;
      }
    };
    svg.onmouseleave = () => { cur.hidden = true; if (tip) tip.hidden = true; };
  }
}

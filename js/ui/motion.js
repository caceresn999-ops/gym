import {number} from '../engine.js';
import {$, $$, esc, signed} from './common.js';

export const canMove = () => !document.hidden && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const format = (value, decimals, sign) => sign ? signed(value) : number(value, decimals);
export const count = (value, decimals = 0, sign = false) => value == null ? '—'
  : '<span data-count="' + value + '" data-decimals="' + decimals + '" data-sign="' + Number(sign) + '">'
    + esc(format(value, decimals, sign)) + '</span>';

export function animateCounts(root) {
  const nodes = $$('[data-count]', root);
  if (!nodes.length || !canMove()) return;
  const draw = progress => {
    for (const node of nodes) node.textContent = format(Number(node.dataset.count) * progress, Number(node.dataset.decimals), node.dataset.sign === '1');
  };
  const start = performance.now();
  let frame;
  const finish = () => {
    clearTimeout(timeout);
    cancelAnimationFrame(frame);
    document.removeEventListener('visibilitychange', finish);
    draw(1);
  };
  const tick = now => {
    const elapsed = Math.min(1, (now - start) / 540);
    if (!canMove() || elapsed === 1) return finish();
    draw(1 - (1 - elapsed) ** 3);
    frame = requestAnimationFrame(tick);
  };
  const timeout = setTimeout(finish, 600);
  document.addEventListener('visibilitychange', finish, {once: true});
  draw(0);
  frame = requestAnimationFrame(tick);
}

export function ring(done, total, kind) {
  const progress = total ? Math.min(1, Math.max(0, done / total)) : 0;
  const id = 'ring-' + kind;
  return '<svg viewBox="0 0 92 92" aria-hidden="true"><defs><linearGradient id="' + id + '">'
    + '<stop class="ember-stop"/><stop offset="1" class="gold-stop"/></linearGradient></defs>'
    + '<circle class="ring-track" cx="46" cy="46" r="38"/><circle class="ring-fill ' + (kind === 'rest' ? 'rest-progress' : 'week-progress')
    + '" cx="46" cy="46" r="38" pathLength="1" stroke="url(#' + id + ')" style="--offset:' + (1 - progress) + '"/></svg>';
}

let activeBurst;
export function burst(anchor, count = 55) {
  if (!canMove()) return;
  activeBurst?.();
  const canvas = document.createElement('canvas');
  canvas.className = 'fx';
  canvas.setAttribute('aria-hidden', 'true');
  const rect = anchor?.getBoundingClientRect();
  const width = innerWidth, height = innerHeight, density = Math.min(2, devicePixelRatio || 1);
  canvas.width = width * density;
  canvas.height = height * density;
  const paint = canvas.getContext('2d');
  if (!paint) return;
  paint.scale(density, density);
  const x = rect ? rect.left + rect.width / 2 : width / 2;
  const y = rect ? rect.top + rect.height / 2 : height * .58;
  const style = getComputedStyle(document.documentElement);
  const colors = ['--ember', '--orange', '--gold'].map(token => style.getPropertyValue(token));
  const particles = Array.from({length: count}, (_, i) => {
    const dir = Math.random() * 2 * Math.PI, power = 2 + Math.random() * (anchor ? 5 : 11);
    return {x, y, vx: Math.cos(dir) * power, vy: Math.sin(dir) * power - 4, size: 1 + Math.random() * 3, color: colors[i % colors.length]};
  });
  const dialog = $('#sheet');
  (dialog?.open ? dialog : document.body).append(canvas);
  const start = performance.now();
  let frame;
  const clear = () => {
    cancelAnimationFrame(frame);
    clearTimeout(timeout);
    canvas.remove();
    if (activeBurst === clear) activeBurst = null;
  };
  const draw = now => {
    const step = (now - start) / 16;
    if (!canMove() || step > 38) return clear();
    paint.clearRect(0, 0, width, height);
    paint.globalAlpha = Math.max(0, 1 - step / 38);
    for (const p of particles) {
      paint.fillStyle = p.color;
      paint.beginPath();
      paint.arc(p.x + p.vx * step, p.y + p.vy * step + .08 * step ** 2, p.size, 0, Math.PI * 2);
      paint.fill();
    }
    frame = requestAnimationFrame(draw);
  };
  activeBurst = clear;
  const timeout = setTimeout(clear, 660);
  frame = requestAnimationFrame(draw);
}

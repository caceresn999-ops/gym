import {muscles, number, plural} from '../engine.js';
import {gaps} from '../metrics.js';
import {esc} from './common.js';

const views = [{label: 'Frente', x: 0, compactBox: '32 3 104 198'},
  {label: 'Espalda', x: 168, compactBox: '200 3 104 222'}];
const stops = [[0, '--d0'], [.25, '--d1'], [.5, '--d2'], [.75, '--d3'], [.99, '--d4']];
export let doseColor;
let geometry = [];
let instance = 0;

export async function loadPlate(style = getComputedStyle(document.documentElement)) {
  doseColor = createDoseColor(token => style.getPropertyValue(token));
  const response = await fetch(new URL('../../assets/bodymap.svg', import.meta.url));
  if (!response.ok) throw Error('No se pudo cargar el mapa muscular. Vuelve a abrir Gym.');
  const svg = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
  const paths = [...svg.querySelectorAll('path[id]')];
  if (!Object.keys(muscles).every(key => paths.some(path => path.id === 'm-' + key))) {
    throw Error('No se pudo leer el mapa muscular.');
  }
  // The source combines some front and back polygons under one muscle ID.
  geometry = views.map(({x}) => paths.flatMap(path => {
    const polygons = path.getAttribute('d').match(/M[^M]+/g)
      .filter(polygon => {
        const firstX = Number(/^M([\d.]+)/.exec(polygon)[1]);
        return firstX >= x && firstX < x + 168;
      });
    if (!polygons.length) return [];
    const d = polygons.join(' ');
    const top = Math.min(...[...d.matchAll(/[ML][\d.]+,([\d.]+)/g)].map(([, y]) => Number(y)));
    return [{id: path.id, key: path.id.startsWith('m-') ? path.id.slice(2) : '', d, top}];
  }));
  const tops = geometry.flat().filter(shape => shape.key).map(shape => shape.top);
  const first = Math.min(...tops), last = Math.max(...tops);
  for (const shape of geometry.flat()) {
    if (shape.key) shape.delay = Math.round((shape.top - first) / (last - first) * 280);
  }
}

function hexToOklch(hex) {
  const [red, green, blue] = [1, 3, 5].map(index => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
  });
  // OKLab uses cube-root LMS values. Convert its a and b axes to chroma and hue.
  const l = Math.cbrt(.4122214708 * red + .5363325363 * green + .0514459929 * blue);
  const m = Math.cbrt(.2119034982 * red + .6806995451 * green + .1073969566 * blue);
  const s = Math.cbrt(.0883024619 * red + .2817188376 * green + .6299787005 * blue);
  const lightness = .2104542553 * l + .793617785 * m - .0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + .4505937099 * s;
  const b = .0259040371 * l + .7827717662 * m - .808675766 * s;
  return [lightness, Math.hypot(a, b), Math.atan2(b, a)];
}

function oklchToHex(lightness, chroma, hue) {
  const a = chroma * Math.cos(hue), b = chroma * Math.sin(hue);
  const l = (lightness + .3963377774 * a + .2158037573 * b) ** 3;
  const m = (lightness - .1055613458 * a - .0638541728 * b) ** 3;
  const s = (lightness - .0894841775 * a - 1.291485548 * b) ** 3;
  const channels = [
    4.0767416621 * l - 3.3077115913 * m + .2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - .3413193965 * s,
    -.0041960863 * l - .7034186147 * m + 1.707614701 * s
  ];
  return '#' + channels.map(linear => {
    const clipped = Math.max(0, Math.min(1, linear));
    const channel = clipped <= .0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - .055;
    return Math.round(channel * 255).toString(16).padStart(2, '0');
  }).join('');
}

export function createDoseColor(readToken) {
  const ramp = stops.map(([ratio, token]) => {
    const hex = readToken(token).trim();
    return {ratio, hex, lch: hexToOklch(hex)};
  });
  const full = readToken('--d-full').trim();
  return (done = 0, target = 0) => {
    if (done <= 0) return ramp[0].hex;
    if (!target || done >= target) return full;
    const ratio = done / target;
    const next = ramp.findIndex(stop => stop.ratio >= ratio);
    if (next === -1) return ramp.at(-1).hex;
    const end = ramp[next];
    if (ratio === end.ratio) return end.hex;
    const start = ramp[next - 1];
    const weight = (ratio - start.ratio) / (end.ratio - start.ratio);
    const [l1, c1, h1] = start.lch, [l2, c2, h2] = end.lch;
    const hueDelta = (h2 - h1 + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    return oklchToHex(l1 + (l2 - l1) * weight, c1 + (c2 - c1) * weight, h1 + hueDelta * weight);
  };
}

export function figure(done = {}, targets = {}, {emphasize, labels = false, compact = false} = {}) {
  const prefix = 'body-' + (++instance) + '-';
  return '<div class="body-figures">' + views.map(({label, x, compactBox}, side) => {
    const shapes = geometry[side] ?? [];
    return '<div class="body-view">' + (labels ? '<span class="body-label">' + label + '</span>' : '')
      + '<svg class="body-figure" viewBox="' + (compact ? compactBox : x + ' 0 168 230') + '" role="img" aria-label="' + label + '">'
      + shapes.map(({id, key, d, delay}) => {
        const muted = key && emphasize && !emphasize.has(key);
        const fill = key ? doseColor(muted ? 0 : done[key], targets[key]) : 'var(--s3)';
        return '<path id="' + prefix + side + '-' + id + '"'
          + (key ? ' class="body-region' + (muted ? ' body-region-muted' : '') + '" data-muscle="' + key + '"'
            + ' style="--dose-delay:' + delay + 'ms"' : ' class="body-neutral"')
          + ' d="' + d + '" fill="' + fill + '"/>';
      }).join('')
      + '</svg></div>';
  }).join('') + '</div>';
}

const outlineTimers = new WeakMap();

export function animatePlate(root, done, targets, changed) {
  const all = [...root.querySelectorAll('.body-region:not(.body-region-muted)')];
  const regions = all.filter(region => changed.includes(region.dataset.muscle));
  clearTimeout(outlineTimers.get(root));
  for (const region of all) region.classList.remove('dose-outline');
  for (const region of regions) {
    const key = region.dataset.muscle;
    region.classList.remove('dose-pulse');
    region.setAttribute('fill', doseColor(done[key], targets[key]));
    region.classList.add('dose-outline');
    region.parentNode.append(region);
  }
  outlineTimers.set(root, setTimeout(() => {
    for (const region of regions) region.classList.remove('dose-outline');
  }, 600));
  if (!regions.length || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  root.getBoundingClientRect();
  for (const region of regions) region.classList.add('dose-pulse');
}

export function plate({done, targets, total, goal, withGaps = true, flat = false, footer}) {
  const ranked = withGaps ? gaps(done, targets).slice(0, 3) : [];
  return '<figure class="' + (flat ? 'dose-flat' : 'panel dose-panel') + '">' + figure(done, targets, {labels: true})
    + '<div class="dose-ramp" aria-label="Dosis de 0 a la meta"><span>0</span><i aria-hidden="true"></i><span>meta</span></div>'
    + (ranked.length ? '<ol class="dose-gaps">' + ranked.map(({key, done, target}, i) =>
      '<li><button type="button" class="chip gap-chip" data-gap="' + key + '" aria-pressed="false">'
      + '<span class="gap-number" aria-hidden="true">' + (i + 1) + '</span><span>' + muscles[key] + '</span><span class="gap-count">'
      + number(done) + '/' + number(target) + '</span></button></li>').join('') + '</ol>' : '')
    + (footer ? '<figcaption class="dose-caption">' + esc(footer) + '</figcaption>'
      : '<figcaption class="dose-caption">' + (total ? 'Esta semana · ' + number(total)
        + (goal ? ' de ' + number(goal) : '') + ' ' + plural(goal || total, 'serie') : 'Aún no hay series esta semana') + '</figcaption>')
    + '</figure>';
}

export function bindPlate(root) {
  for (const panel of root.querySelectorAll('.dose-panel')) {
    const buttons = panel.querySelectorAll('[data-gap]');
    for (const button of buttons) button.addEventListener('click', () => {
      const key = button.getAttribute('aria-pressed') === 'true' ? null : button.dataset.gap;
      for (const item of buttons) item.setAttribute('aria-pressed', String(item.dataset.gap === key));
      for (const region of panel.querySelectorAll('[data-muscle]')) {
        const selected = region.dataset.muscle === key;
        region.classList.toggle('body-highlight', selected);
        if (selected) region.parentNode.append(region);
      }
    });
  }
}

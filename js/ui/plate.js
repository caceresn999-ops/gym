import {muscles} from '../engine.js';

const views = [{label: 'Frente', x: 0}, {label: 'Espalda', x: 168}];
const doseStops = [[0, '--line'], [1 / 3, '--d1'], [2 / 3, '--ember'], [1, '--gold']];
const recoveryStops = [[0, '--d1'], [.5, '--ember'], [1, '--gold']];
export let doseColor;
let recoveryColor;
let geometry = [];
let instance = 0;

export async function loadPlate(style = getComputedStyle(document.documentElement)) {
  doseColor = createDoseColor(token => style.getPropertyValue(token));
  recoveryColor = createDoseColor(token => style.getPropertyValue(token), recoveryStops);
  const response = await fetch(new URL('../../assets/bodymap.svg', import.meta.url));
  if (!response.ok) throw Error('No se pudo cargar el mapa muscular. Vuelve a abrir Forja.');
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
    return [{id: path.id, key: path.id.startsWith('m-') ? path.id.slice(2) : '', d: polygons.join(' ')}];
  }));
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

export function createDoseColor(readToken, stops = doseStops) {
  const ramp = stops.map(([ratio, token]) => {
    const hex = readToken(token).trim();
    return {ratio, hex, lch: hexToOklch(hex)};
  });
  const full = ramp.at(-1).hex;
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

export function figure(done = {}, targets = {}, {labels = false, recovering = false} = {}) {
  const prefix = 'body-' + (++instance) + '-';
  const color = recovering ? recoveryColor : doseColor;
  return '<div class="body-figures">' + views.map(({label, x}, side) => {
    const shapes = geometry[side] ?? [];
    return '<div class="body-view">' + (labels ? '<span class="body-label">' + label + '</span>' : '')
      + '<svg class="body-figure" viewBox="' + x + ' 0 168 230" role="img" aria-label="' + label + '">'
      + shapes.map(({id, key, d}) => '<path id="' + prefix + side + '-' + id + '"'
        + (key ? ' class="body-region" data-muscle="' + key + '"' : ' class="body-neutral"')
        + ' d="' + d + '" fill="' + (key ? color(done[key], targets[key]) : 'var(--s3)') + '"/>').join('')
      + '</svg></div>';
  }).join('') + '</div>';
}

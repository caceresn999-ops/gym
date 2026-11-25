import {isHard, muscles, number, quantity} from '../engine.js';
import {weekContext} from '../coach.js';
import {dose, gaps, latestStrength, localDate, records, recovery, strengthSeries, strengthTrend, weeklySessions} from '../metrics.js';
import {$, byId, dateText, esc, loadText, machineText, on, signed, title} from './common.js';
import {count} from './motion.js';
import {figure} from './plate.js';

const shortDate = date => dateText(date, {day: 'numeric', month: 'short'});
const formats = {strength: '1RM est.', weight: 'Peso máx.', volume: 'Volumen'};
let chartId = 0;
const last = rows => rows.at(-1);
const changeTone = value => value == null || Math.abs(value) < .05 ? 'flat' : value > 0 ? 'up' : 'down';
const change = (value, unit) => value == null ? '—' : signed(value) + unit;
const segment = (options, selected, action) => '<div class="seg" style="--segments:' + options.length + ';--selected:'
  + Math.max(0, options.findIndex(([key]) => key === selected)) + '"><span class="sind" aria-hidden="true"></span>'
  + options.map(([key, name]) => '<button ' + action + '="' + key + '" aria-pressed="' + (key === selected) + '">' + esc(name) + '</button>').join('') + '</div>';
const points = (values, width, padding, bottom, range) => {
  const lo = Math.min(...values), hi = Math.max(...values);
  return values.map((value, index) => [padding + index * (width - 2 * padding) / Math.max(1, values.length - 1),
    bottom - (hi === lo ? .5 : (value - lo) / (hi - lo)) * range]);
};

function spark(values) {
  const xy = points(values, 64, 1, 25, 22);
  return '<svg class="spark" viewBox="0 0 64 28" aria-hidden="true"><polyline pathLength="1" points="' + xy.map(row => row.join(',')).join(' ')
    + '"/>' + (xy.length === 1 ? '<circle cx="' + xy[0][0] + '" cy="' + xy[0][1] + '" r="2"/>' : '') + '</svg>';
}

function exerciseList(ctx) {
  const rows = latestStrength(ctx.data.sets, ctx.data.sessions);
  const workout = weekContext(ctx.data, ctx.now());
  const target = workout.plan?.planned || workout.program?.sessionsPerWeek || 5;
  const weeks = weeklySessions(ctx.data.sessions, ctx.now(), 12), max = Math.max(1, target, ...weeks.map(row => row.value));
  // Constancia: average of the last 4 complete weeks, a goal line, and tap-a-bar details.
  const complete = weeks.slice(-5, -1), average = complete.reduce((sum, row) => sum + row.value, 0) / complete.length;
  const detail = weeks.map(week => {
    const to = localDate(new Date(new Date(week.date + 'T12:00').getTime() + 7 * 864e5));
    const names = ctx.data.sessions.filter(row => row.end && !row.deleted && row.date >= week.date && row.date < to)
      .sort((a, b) => a.start - b.start).map(row => row.dayName || 'Entreno');
    return 'Semana del ' + shortDate(week.date) + ': ' + quantity(week.value, 'entreno') + (names.length ? ' · ' + names.join(', ') : '');
  });
  const selected = Math.max(0, weeks.map(row => row.value > 0).lastIndexOf(true));
  return '<div class="card week-bars"><div class="row"><b>Constancia</b><small class="muted">últimas 12 semanas</small></div>'
    + '<div class="wb-head"><b>' + count(average, 1) + '</b><span>entrenos por semana<br><small>promedio de las últimas 4 · meta '
    + target + '</small></span></div>'
    + '<div class="bars" style="--goal:' + target / max * 100 + '%"><i class="goal" aria-hidden="true"><em>meta ' + target + '</em></i>'
    + weeks.map((week, index) => '<button type="button" class="' + (week.value ? (week.value >= target ? 'hit' : '') : 'zero')
      + (index === selected ? ' on' : '') + (index === weeks.length - 1 ? ' now' : '') + '" data-week-bar="' + index + '" style="--bar:' + Math.max(4, week.value / max * 100)
      + '%;--delay:' + index * 16 + 'ms" aria-label="' + esc(detail[index]) + '">' + (week.value ? '<b>' + week.value + '</b>' : '') + '<small>'
      + (index % 3 === 2 || index === 11 ? Number(week.date.slice(-2)) + '/' + Number(week.date.slice(5, 7)) : '') + '</small></button>').join('')
    + '</div><p class="wb-detail" data-week-detail>' + esc(detail[selected]) + '</p>'
    + '<script type="application/json" data-week-details>' + JSON.stringify(detail).replace(/</g, '\\u003c') + '</script></div>'
    + '<h2>Tus ejercicios</h2>' + (rows.length ? '<div class="list">' + rows.map(({point, same}) => {
      const name = byId(ctx.data.exercises, point.set.exerciseId)?.name ?? 'Ejercicio';
      const delta = strengthTrend(same, 12, ctx.now());
      return '<a class="li" href="#progreso/ejercicio/' + encodeURIComponent(point.set.exerciseId) + '" data-lift="' + esc(point.set.exerciseId)
        + '"><div class="grow"><div class="name">' + esc(name) + '</div><div class="meta">' + number(point.value)
        + (point.bodyweight ? ' reps' : ' ' + esc(point.set.unit) + ' · 1RM est.') + '</div></div>'
        + spark(same.slice(-10).map(row => row.value)) + '<span class="pill ' + changeTone(delta) + '" aria-label="Cambio en 12 semanas">'
        + change(delta, point.bodyweight ? ' rep' : '%') + '</span></a>';
    }).join('') + '</div>' : '<p class="muted">Registra series para ver tu progreso.</p>');
}

function musclesView(ctx, recovering) {
  const {targets} = weekContext(ctx.data, ctx.now());
  // With nothing logged this week yet, show the last week that has training instead of a blank body.
  let {done} = dose(ctx.data.sets, ctx.data.exercises, ctx.data.sessions, ctx.now());
  let weekLabel = 'Esta semana';
  for (let back = 1; back <= 8 && !Object.values(done).some(value => value > 0); back++) {
    const when = new Date(+ctx.now() - back * 7 * 864e5);
    done = dose(ctx.data.sets, ctx.data.exercises, ctx.data.sessions, when).done;
    weekLabel = back === 1 ? 'Semana pasada' : 'Semana del ' + shortDate(localDate(new Date(+when - ((when.getDay() + 6) % 7) * 864e5)));
  }
  const recovered = recovery(ctx.data.sets, ctx.data.exercises, ctx.now());
  const keys = Object.keys(muscles);
  const map = recovering ? figure(Object.fromEntries(keys.map(key => [key, recovered[key].recovered])), Object.fromEntries(keys.map(key => [key, 1])),
    {labels: true, recovering: true}) : figure(done, targets, {labels: true});
  const ready = keys.filter(key => recovered[key].recovered === 1);
  const rest = keys.filter(key => recovered[key].recovered < 1).sort((a, b) => recovered[b].remaining - recovered[a].remaining);
  return segment([['semana', weekLabel], ['recuperacion', 'Recuperación']], recovering ? 'recuperacion' : 'semana', 'data-muscles')
    + '<div class="card bodywrap">' + map + '<div class="legend' + (recovering ? ' recovery-legend' : '') + '"><span>'
    + (recovering ? 'Recuperándose' : '0 series') + '</span><i></i><span>' + (recovering ? 'Listo' : 'Meta') + '</span></div></div>'
    + (recovering ? '<h2>Listo para entrenar</h2><p class="muted">' + (ready.map(key => muscles[key]).join(' · ') || '—')
      + '</p><h2>Recuperándose</h2><p class="muted">' + (rest.map(key => muscles[key] + ' (falta ~' + Math.ceil(recovered[key].remaining) + ' h)').join(' · ') || '—') + '</p>'
      : '<h2>Lo que más falta</h2><div class="card">' + (gaps(done, targets).map(row => '<div class="mrow"><span>' + muscles[row.key]
        + '</span><span class="mtrack"><i style="--bar:' + Math.min(100, row.done / row.target * 100) + '%"></i></span><small>'
        + number(row.done) + '/' + number(row.target) + '</small></div>').join('')
      || '<p class="muted">' + (Object.keys(targets).length ? 'Cumpliste las metas de la semana.' : 'Activa un programa con metas semanales.') + '</p>') + '</div>');
}

export function chartView(rows, label, unit, mark = false) {
  if (!rows.length) return '<p class="muted">Sin registros.</p>';
  const xy = points(rows.map(row => row.value), 340, 9, 175, 115);
  const path = xy.reduce((d, [x, y], i) => {
    if (!i) return 'M' + x + ' ' + y;
    const [x0, y0] = xy[i - 1], mid = (x0 + x) / 2;
    return d + ' C' + mid + ' ' + y0 + ' ' + mid + ' ' + y + ' ' + x + ' ' + y;
  }, '');
  const bestIndex = rows.reduce((best, item, i) => item.value > rows[best].value ? i : best, 0);
  const [prX, prY] = xy[bestIndex];
  const id = 'chart-fill-' + ++chartId;
  return '<div class="chart"><div class="tip"><span data-plot-value>' + number(last(rows).value) + (unit ? ' ' + esc(unit) : '')
    + '</span><small>' + esc(label) + ' · <span data-plot-date>' + esc(shortDate(last(rows).date)) + '</span></small></div>'
    + '<svg viewBox="0 0 340 200" role="img" aria-label="' + esc(label) + '" data-plot>'
    + '<defs><linearGradient id="' + id + '" x2="0" y2="1"><stop class="ember-stop" stop-opacity=".32"/><stop class="ember-stop" offset="1" stop-opacity="0"/></linearGradient></defs>'
    + '<path class="chart-area" fill="url(#' + id + ')" d="' + path + ' L' + last(xy)[0] + ' 175 L9 175Z"/>'
    + '<path class="chart-line" pathLength="1" d="' + path + '"/>'
    + (mark ? '<circle class="chart-pr" cx="' + prX + '" cy="' + prY + '" r="4"/><text class="chart-pr" x="' + Math.min(323, Math.max(17, prX))
      + '" y="' + (prY - 9) + '" text-anchor="middle">PR</text>' : '')
    + '<line data-cursor y1="55" y2="176" visibility="hidden"/><circle data-dot r="4" visibility="hidden"/>'
    + '<text x="9" y="195">' + esc(shortDate(rows[0].date)) + '</text><text x="331" y="195" text-anchor="end">'
    + esc(shortDate(last(rows).date)) + '</text></svg></div>';
}

function recordCards(ctx, data, names, lift) {
  return names.map(machineId => {
    const record = records(data, lift, machineId);
    if (!record.reps) return '';
    const unit = record.reps.set.unit;
    const row = (label, item, suffix) => '<div class="pr"><span>' + label + '<small class="muted">' + esc(shortDate(item.date))
      + ' · ' + esc(loadText(item.set.weight, unit)) + ' × ' + item.set.reps + '</small></span><strong>' + number(item.value) + suffix + '</strong></div>';
    const machine = byId(ctx.data.machines, machineId);
    const name = machine ? machineText(ctx.data, machine, machine.kind === 'peso-corporal') : record.weight.value === 0 ? 'Peso corporal' : 'Sin máquina';
    return '<section class="card record-card"><h3>' + esc(name) + '</h3>'
      + (record.e1rm.value > 0 ? row('Mejor 1RM est.', record.e1rm, ' ' + esc(unit)) : '')
      + row('Peso máximo', record.weight, ' ' + esc(unit)) + row('Volumen de sesión', record.volume, ' ' + esc(unit))
      + row('Más reps', record.reps, ' reps')
      + '<details><summary>Máximo por repeticiones</summary><table><thead><tr><th>Reps</th><th>Peso</th><th>Fecha</th></tr></thead><tbody>'
      + record.repMax.map(entry => '<tr><td>' + entry.reps + '</td><td>' + esc(loadText(entry.value, unit)) + '</td><td>'
        + esc(shortDate(entry.date)) + '</td></tr>').join('') + '</tbody></table></details></section>';
  }).join('');
}

function detailData(ctx, id) {
  const series = strengthSeries(ctx.data.sets, ctx.data.sessions).filter(point => point.set.exerciseId === id);
  if (!series.length) return null;
  const machineIds = [...new Set(series.toReversed().map(point => point.set.machineId ?? null))];
  const machineId = machineIds[Math.max(0, machineIds.findIndex(key => String(key ?? '') === ctx.liftMachine))];
  const current = series.filter(point => (point.set.machineId ?? null) === machineId);
  const sessions = new Set(series.map(point => point.session.id));
  const sets = ctx.data.sets.filter(set => isHard(set) && set.exerciseId === id && sessions.has(set.sessionId));
  const machineSets = Map.groupBy(sets.filter(set => (set.machineId ?? null) === machineId), set => set.sessionId);
  const bodyweight = last(current).bodyweight, unit = last(current).set.unit;
  const metric = Object.hasOwn(formats, ctx.liftMetric) ? ctx.liftMetric : 'strength';
  const labels = {...formats, strength: bodyweight ? 'Reps' : formats.strength};
  const rows = current.map(point => {
    const work = machineSets.get(point.session.id) ?? [];
    return {date: point.date, value: metric === 'weight' ? Math.max(0, ...work.map(set => set.weight))
      : metric === 'volume' ? work.reduce((total, set) => total + set.weight * set.reps, 0) : point.value, session: point.session, sets: work};
  });
  return {machineIds, machineId, current, sets, bodyweight, unit, metric, labels, rows, machineSets,
    chartUnit: metric === 'strength' && bodyweight ? 'reps' : unit};
}

function detailView(ctx, id) {
  const work = detailData(ctx, id);
  if (!work) return '<a class="back" href="#progreso">‹ Progreso</a><p class="muted">Sin series registradas.</p>';
  const {machineIds, machineId, current, sets, bodyweight, unit, metric, labels, rows, chartUnit, machineSets} = work;
  const weight = Math.max(0, ...[...machineSets.values()].flatMap(group => group.map(row => row.weight)));
  return '<a class="back" href="#progreso">‹ Progreso</a><h1 class="detail-title">' + esc(byId(ctx.data.exercises, id)?.name ?? 'Ejercicio') + '</h1>'
    + (machineIds.length > 1 ? '<label class="label lift-machine">Máquina<select data-lift-machine>' + machineIds.map(key => '<option value="'
      + esc(key ?? '') + '"' + (key === machineId ? ' selected' : '') + '>' + esc(machineText(ctx.data, byId(ctx.data.machines, key), !key && bodyweight))
      + '</option>').join('') + '</select></label>' : '')
    + '<div class="kpis"><div><b>' + count(Math.max(...current.map(point => point.value)), 1) + '</b><small>' + labels.strength + '</small></div>'
    + '<div><b>' + (bodyweight && !weight ? 'PC' : count(weight, 1)) + '</b><small>Peso máx.' + (weight ? ' · ' + esc(unit) : '') + '</small></div>'
    + '<div><b>' + count(current.length) + '</b><small>Sesiones</small></div></div>'
    + segment(Object.entries(labels), metric, 'data-metric') + '<div class="card chart-card">' + chartView(rows, labels[metric], chartUnit, true)
    + '</div><h2>Récords</h2>' + recordCards(ctx, sets, machineIds, id)
    + '<h2>Historial</h2><div class="list">' + rows.toReversed().map(row => '<a class="li" href="#historial/' + encodeURIComponent(row.session.id)
      + '"><div class="grow"><div class="name">' + esc(shortDate(row.date)) + '</div></div><span class="muted small">'
      + row.sets.map(set => esc(loadText(set.weight, set.unit, false)) + '×' + set.reps).join(' · ') + '</span></a>').join('') + '</div>';
}

export function progressView(ctx) {
  if (ctx.subroute === 'ejercicio') return detailView(ctx, ctx.routeArg);
  const muscle = ['musculos', 'recuperacion', 'hipertrofia'].includes(ctx.subroute);
  return title(ctx, 'Progreso') + segment([['ejercicios', 'Ejercicios'], ['musculos', 'Músculos']], muscle ? 'musculos' : 'ejercicios', 'data-progress')
    + (muscle ? musclesView(ctx, ctx.subroute === 'recuperacion') : exerciseList(ctx));
}

export function bindProgress(ctx) {
  const root = ctx.root;
  on(root, '[data-progress]', node => ctx.go('progreso/' + node.dataset.progress));
  on(root, '[data-muscles]', node => ctx.go('progreso/' + (node.dataset.muscles === 'recuperacion' ? 'recuperacion' : 'musculos')));
  on(root, '[data-week-bar]', node => {
    const details = JSON.parse($('[data-week-details]', root)?.textContent || '[]');
    for (const bar of root.querySelectorAll('[data-week-bar]')) bar.classList.toggle('on', bar === node);
    const out = $('[data-week-detail]', root);
    if (out) { out.textContent = details[Number(node.dataset.weekBar)] ?? ''; out.classList.remove('flash'); void out.offsetWidth; out.classList.add('flash'); }
  });
  on(root, '[data-lift]', () => { ctx.liftMachine = undefined; ctx.liftMetric = undefined; });
  on(root, '[data-lift-machine]', node => { ctx.liftMachine = node.value; ctx.render(); }, 'change');
  on(root, '[data-metric]', node => { ctx.liftMetric = node.dataset.metric; ctx.render(); });
  const svg = $('[data-plot]', root);
  if (!svg || ctx.subroute !== 'ejercicio') return;
  const {rows, chartUnit} = detailData(ctx, ctx.routeArg);
  const xy = points(rows.map(row => row.value), 340, 9, 175, 115);
  const scrub = event => {
    const rect = svg.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width * 340;
    const index = Math.min(rows.length - 1, Math.max(0, Math.round((x - 9) / 322 * (rows.length - 1))));
    const cursor = $('[data-cursor]', svg), dot = $('[data-dot]', svg);
    cursor.setAttribute('x1', xy[index][0]); cursor.setAttribute('x2', xy[index][0]);
    dot.setAttribute('cx', xy[index][0]); dot.setAttribute('cy', xy[index][1]);
    cursor.setAttribute('visibility', 'visible'); dot.setAttribute('visibility', 'visible');
    $('[data-plot-value]', root).textContent = number(rows[index].value) + (chartUnit ? ' ' + chartUnit : '');
    $('[data-plot-date]', root).textContent = shortDate(rows[index].date);
  };
  svg.addEventListener('pointerdown', scrub);
  svg.addEventListener('pointermove', scrub);
}

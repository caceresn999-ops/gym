import {uuid} from '../db.js';
import {muscles, number, quantity} from '../engine.js';
import {plannedWeek, weekContext, weekId} from '../coach.js';
import {addDays, asDate, dose, gaps, interpolatedWeight, isoWeek, latestStrength, localDate, monday, recentRecord, streak, strengthSeries, strengthTrend, weeklySessions, weighIns, weightRate} from '../metrics.js';
import {$, activeProgram, bodySheet, byId, closeSheet, dateText, esc, field, formSheet, icon, iconButton, loadText, machineText, on, phaseName, requiredNumber, routine,
  select, sheet, signed, techniqueName, techniques, timestampInput, title} from './common.js';
import {bindPlate, doseColor, plate} from './plate.js';
import {summaryHistory} from './coach-ui.js';

const sections = {fuerza: 'Fuerza', hipertrofia: 'Hipertrofia', tamano: 'Tamaño', constancia: 'Constancia', historial: 'Historial'};
const days = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const measureNames = {waist: 'Cintura', arm: 'Brazo', chest: 'Pecho', thigh: 'Muslo'};
const prefs = {lift: null, relative: false, weekOffset: 0, monthOffset: 0};
const change = (value, weeks, unit) => {
  const flat = value != null && Math.abs(value) < .05;
  const tone = flat ? 'subtle' : value < 0 ? 'warning' : value == null ? 'muted' : 'gain';
  return '<span class="' + tone + '">' + weeks + ' sem: '
    + (value == null ? '—' : flat ? '=' : esc(signed(value)) + ' ' + unit) + '</span>';
};
const estimate = (value, unit) => number(value, unit === 'pila' || value >= 100 ? 0 : 1);
const strengthText = (point, relative = false) => {
  if (point.bodyweight) return number(point.value, 0)
    + ' reps' + (point.set.weight ? ' · +' + loadText(point.set.weight, point.set.unit) : '');
  return relative ? number(point.value, 2) + ' × PC' : estimate(point.value, point.set.unit) + ' ' + point.set.unit;
};

function lineChart(series, label, unit, {height = 144, records = false, relative = false, marks = []} = {}) {
  const usable = series.map(group => ({...group, points: group.points.filter(point => point.value != null && Number.isFinite(point.value))}));
  const points = usable.flatMap(group => group.points);
  if (!points.length) return '<p class="empty">Aún no hay datos para esta gráfica.</p>';
  const width = 340, left = 38, right = 8, top = 12, bottom = 24;
  const dates = points.map(point => +(asDate(point.date)));
  const from = Math.min(...dates), to = Math.max(...dates);
  const low = Math.min(...points.map(point => point.value)), high = Math.max(...points.map(point => point.value));
  const padding = Math.max((high - low) * .1, Math.abs(high) * .004, .1);
  const min = low - padding, max = high + padding;
  const x = date => left + (from === to ? .5 : (asDate(date) - from) / (to - from)) * (width - left - right);
  const y = value => top + (max - value) / (max - min) * (height - top - bottom);
  const axisUnit = records && points.every(point => point.set.unit === 'pila') ? 'pila' : unit;
  const rules = [max, (max + min) / 2, min].map(value => '<line class="grid" x1="' + left + '" x2="' + (width - right) + '" y1="' + y(value)
    + '" y2="' + y(value) + '"/><text x="0" y="' + (y(value) + 3) + '">'
    + esc(records && !relative ? estimate(value, axisUnit) : number(value, 2)) + '</text>').join('');
  const lines = usable.map(group => (group.points.length > 1 ? '<polyline class="' + (group.kind ?? 'line') + '" pathLength="1" points="'
    + group.points.map(point => x(point.date) + ',' + y(point.value)).join(' ') + '"/>' : '') + (group.kind === 'mean' ? '' : group.points.map(point =>
    '<circle class="point' + (records && point.record ? ' pr' : '') + '" cx="' + x(point.date) + '" cy="' + y(point.value) + '" r="3"><title>'
    + esc(dateText(point.date) + ' · ' + (records ? strengthText(point, relative) : number(point.value, 2) + ' ' + unit)
      + (point.recentRecord && records ? ' · Récord' : '')) + '</title></circle>').join(''))).join('');
  const marksSVG = marks.filter(mark => +asDate(mark.date) >= from && +asDate(mark.date) <= to).map(mark => {
    const location = x(mark.date);
    const end = location > 236;
    return '<line class="tick" x1="' + location + '" x2="' + location + '" y1="' + (height - bottom) + '" y2="' + (height - bottom - 7) + '"/>'
      + '<text x="' + (location + (end ? -3 : 3)) + '" y="' + (height - bottom - 7) + '"' + (end ? ' text-anchor="end"' : '') + '>'
      + esc(mark.label.length > 16 ? mark.label.slice(0, 15) + '…' : mark.label) + '<title>' + esc(mark.label) + '</title></text>';
  }).join('');
  return '<svg class="chart" viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + esc(label) + '">'
    + rules + lines + marksSVG + '<text x="' + left + '" y="' + (height - 4) + '">' + esc(dateText(from, {day: 'numeric', month: 'short'})) + '</text>'
    + (to === from ? '' : '<text x="' + (width - right) + '" y="' + (height - 4) + '" text-anchor="end">' + esc(dateText(to, {day: 'numeric', month: 'short'})) + '</text>') + '</svg>';
}

export function machineSegments(points) {
  const result = [];
  for (const point of points) {
    const last = result.at(-1);
    if (!last || last.machineId !== point.set.machineId) result.push({machineId: point.set.machineId, points: [point]});
    else last.points.push(point);
  }
  return result;
}

function machineName(data, id, exerciseName, bodyweight = false) {
  const machine = byId(data.machines, id);
  if (bodyweight) return machineText(data, machine, true);
  if (machine?.name == null) return 'Peso corporal / sin máquina';
  if (machine.name === exerciseName) {
    return [byId(data.gyms, machine.gymId)?.name, machine.unit].filter(Boolean).join(' · ');
  }
  return machine.name;
}

function strength(ctx) {
  const now = ctx.now();
  if (prefs.lift && !byId(ctx.data.exercises, prefs.lift)) prefs.lift = null;
  if (prefs.lift) {
    const exercise = byId(ctx.data.exercises, prefs.lift);
    const own = strengthSeries(ctx.data.sets.filter(set => set.exerciseId === exercise.id), ctx.data.sessions);
    const bodyweight = own.some(point => point.bodyweight);
    const relative = !bodyweight && prefs.relative;
    const segments = machineSegments(own).map(group => ({...group, points: group.points.map(point => {
      const weight = interpolatedWeight(ctx.data.body, point.set.ts ? localDate(point.set.ts) : point.date);
      return {...point, value: relative ? weight ? point.value / weight : null : point.value, recentRecord: recentRecord(point, now)};
    })}));
    const label = bodyweight ? 'Mejores repeticiones por sesión' : relative ? 'e1RM relativo al peso corporal' : 'e1RM por máquina';
    return '<section class="stack"><button type="button" class="link-button" data-strength-back>' + icon('arrow-left', true) + ' Ejercicios</button>'
      + '<h2>' + esc(exercise.name) + '</h2>' + (bodyweight ? '' : '<div class="segment" aria-label="Escala de fuerza">'
        + '<button type="button" data-relative="0" aria-pressed="' + !relative + '">Absoluto</button>'
        + '<button type="button" data-relative="1" aria-pressed="' + relative + '">Relativo al peso</button></div>')
      + '<figure class="panel stack"><figcaption>' + esc(label) + '</figcaption>'
      + lineChart(segments, label, '', {records: true, relative,
        marks: segments.slice(1).map(group => ({date: group.points[0].date, label: machineName(ctx.data, group.machineId, undefined, bodyweight)}))})
      + '<div class="plot-legend">' + segments.map(group => '<span>' + esc(machineName(ctx.data, group.machineId, undefined, bodyweight))
        + (relative || bodyweight ? '' : ' (' + esc(group.points[0].set.unit) + ')') + ' · desde '
        + esc(dateText(group.points[0].date, {day: 'numeric', month: 'short'})) + '</span>').join('') + '</div></figure>'
      + (relative && !weighIns(ctx.data.body).length ? '<button type="button" data-weigh>Registrar peso corporal</button>' : '')
      + '<h3>Últimas sesiones</h3><table class="data-table"><thead><tr><th>Fecha</th><th>Mejor serie</th><th>' + (bodyweight ? 'Reps' : 'e1RM') + '</th></tr></thead><tbody>'
      + segments.flatMap(group => group.points).slice(-10).reverse().map(point => {
        return '<tr><td>' + esc(dateText(point.date, {day: 'numeric', month: 'short'})) + '</td><td>'
          + esc(bodyweight ? 'PC' + (point.set.weight ? ' +' + loadText(point.set.weight, point.set.unit) : '') : loadText(point.set.weight, point.set.unit))
          + ' × ' + point.set.reps + '<br><small class="muted">' + esc(machineName(ctx.data, point.set.machineId, undefined, bodyweight)) + '</small></td>'
          + '<td><strong class="fuerza">' + (point.value == null ? '—' : esc(strengthText(point, relative))) + '</strong>'
          + (point.recentRecord ? '<br><small class="record">Récord</small>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></section>';
  }
  const latest = latestStrength(ctx.data.sets, ctx.data.sessions);
  if (!latest.length) return '<p class="empty">Registra una serie para ver tu fuerza por ejercicio y máquina.</p>';
  return '<ul class="plain-list">' + latest.map(({point, same}) => {
    const id = point.set.exerciseId, unit = point.bodyweight ? 'reps' : '%';
    const name = byId(ctx.data.exercises, id)?.name;
    return '<li><button type="button" class="list-button strength-row" data-lift="' + esc(id) + '">'
      + '<span class="strength-name"><strong>' + esc(name) + '</strong><br><small class="muted">'
      + esc(machineName(ctx.data, point.set.machineId, name, point.bodyweight || byId(ctx.data.exercises, id)?.bodyweight)) + '</small></span>'
      + '<span class="strength-value"><strong class="fuerza">' + esc(strengthText(point)) + '</strong>'
      + (recentRecord(point, now) ? '<small class="record">Récord</small>' : '') + '</span>'
      + '<small class="strength-deltas">' + change(strengthTrend(same, 4, now), 4, unit) + ' · '
      + change(strengthTrend(same, 12, now), 12, unit) + '</small>'
      + icon('chevron-right', true) + '</button></li>';
  }).join('') + '</ul>';
}

function hypertrophy(ctx) {
  const date = addDays(ctx.now(), prefs.weekOffset * 7), program = activeProgram(ctx.data);
  const {targets, targetRows} = weekContext(ctx.data, date, program, {historical: prefs.weekOffset < 0});
  const {done, total, frequency} = dose(ctx.data.sets, ctx.data.exercises, ctx.data.sessions, date);
  const deficits = gaps(done, targets);
  return '<div class="stack-lg"><div class="row">' + iconButton('chevron-left', 'Semana anterior', 'data-week="-1"')
    + '<strong>Semana ' + isoWeek(date) + ' · ' + date.getFullYear() + '</strong>'
    + iconButton('chevron-right', 'Semana siguiente', 'data-week="1"' + (!prefs.weekOffset ? ' disabled' : '')) + '</div>'
    + plate({done, targets, total})
    + '<section class="section"><h2>Series por músculo</h2><table class="data-table muscle-table"><thead><tr><th>Músculo</th><th>Hechas / meta / rango</th>'
    + '<th>Días</th><th scope="col" aria-label="Cambio de meta">Δ</th></tr></thead><tbody>' + Object.entries(muscles).map(([key, name], index) => {
      const value = done[key] ?? 0, target = targets[key] ?? 0, cap = Math.max(20, value, target);
      const row = targetRows[key], change = row?.delta ? signed(row.delta) : '0';
      return '<tr><td>' + name + '</td><td><strong class="hipertrofia">' + number(value) + '</strong> / ' + (target || '—')
        + ' / 10–20<div class="bar-track" aria-hidden="true"><span style="width:' + value / cap * 100 + '%;background:' + doseColor(value, target)
        + ';--bar-delay:' + Math.min(240, index * 30) + 'ms"></span>'
        + (target ? '<i style="left:' + Math.min(99.5, target / cap * 100) + '%"></i>' : '') + '</div></td><td>' + quantity(frequency[key] ?? 0, 'día') + '</td>'
        + '<td>' + (row ? '<button type="button" class="link-button volume-delta" data-volume-muscle="' + key + '" aria-label="'
          + esc(name + ' · ' + change + ' · ' + row.reasons.join(' · ')) + '">' + change + '</button>' : '—') + '</td></tr>';
    }).join('') + '</tbody></table></section><section class="section"><h2>Brechas</h2>'
    + (deficits.length ? '<ul class="plain-list">' + deficits.map(row => '<li class="row"><span>' + muscles[row.key] + '</span><span>'
      + quantity(row.gap, 'serie') + '</span></li>').join('') + '</ul>' : '<p class="muted">' + (program ? 'Al día con las metas registradas.' : 'Activa un programa con metas semanales para ver las brechas.') + '</p>')
    + '</section></div>';
}

function size(ctx) {
  const today = localDate(ctx.now()), from = localDate(addDays(monday(today), -25 * 7));
  const body = weighIns(ctx.data.body).filter(row => row.date >= from && row.date <= today);
  const weeks = new Map();
  for (const row of body) {
    const key = localDate(monday(row.date));
    (weeks.get(key) ?? weeks.set(key, []).get(key)).push(row);
  }
  const mean = [...weeks.values()].map(rows => ({date: rows[Math.floor(rows.length / 2)].date, value: rows.reduce((sum, row) => sum + row.weight, 0) / rows.length}));
  const rate = weightRate(ctx.data.body, today), last = body.at(-1);
  const phase = [...ctx.data.phases].filter(row => row.start <= today).sort((a, b) => b.start.localeCompare(a.start))[0];
  const guide = {volumen: 'El ritmo positivo describe una subida de peso.', deficit: 'El ritmo negativo describe una bajada de peso.', mantenimiento: 'Un ritmo cercano a cero describe estabilidad.'};
  return '<div class="stack-lg"><section class="section"><div class="row wrap"><h2>Peso corporal</h2><button type="button" data-weigh>Registrar peso</button></div>'
    + '<figure class="panel stack"><figcaption>Últimas 26 semanas</figcaption>' + lineChart([
      {points: body.map(row => ({date: row.date, value: row.weight}))}, {kind: 'mean', points: mean}], 'Peso corporal y media semanal', 'kg')
    + '<div class="plot-legend"><span>Pesajes</span><span class="tamano">Media semanal</span></div></figure>'
    + '<p class="muted">Ritmo de las últimas 4 semanas: ' + (rate == null ? 'faltan pesajes para calcularlo.'
      : '<strong class="tamano">' + esc(signed(rate)) + ' kg/mes · ' + esc(signed(rate / last.weight * 100)) + ' % del peso/mes</strong>') + '</p>'
    + (phase ? '<p>Fase: ' + phaseName(phase.kind) + ' desde ' + esc(dateText(phase.start, {day: 'numeric', month: 'short'})) + '</p>'
      + '<p class="caption muted">' + guide[phase.kind] + '</p>' : '<p class="muted">Fase sin registrar.</p>') + '</section>'
    + '<section class="section"><div class="row wrap"><h2>Medidas</h2><button type="button" data-measures>Registrar medidas</button></div>'
    + Object.entries(measureNames).map(([key, name]) => '<figure class="stack"><figcaption><strong>' + name + '</strong> <small class="muted">cm</small></figcaption>'
      + lineChart([{points: ctx.data.body.filter(row => row[key] > 0).sort((a, b) => a.date.localeCompare(b.date))
        .map(row => ({date: row.date, value: row[key]}))}], name, 'cm', {height: 92}) + '</figure>').join('') + '</section></div>';
}

function bars(weeks, target) {
  const max = Math.max(1, target, ...weeks.map(week => week.value)), width = 338, height = 118, left = 17, bottom = 94;
  const y = n => bottom - n / max * 85;
  const step = (width - left) / weeks.length;
  return '<svg class="chart" viewBox="0 0 338 118" role="img" aria-label="Sesiones por semana y meta del programa">'
    + '<line class="grid" x1="' + left + '" y1="' + bottom + '" x2="' + width + '" y2="' + bottom + '"/>'
    + weeks.map(({date, value}, i) => '<rect class="bar" x="' + (left + i * step + 1) + '" y="' + y(value) + '" width="' + (step - 3)
      + '" height="' + (bottom - y(value)) + '"><title>' + esc(dateText(date) + ': ' + quantity(value, 'sesión', 'sesiones')) + '</title></rect>').join('')
    + (target ? '<line class="tick" x1="' + left + '" y1="' + y(target) + '" x2="' + width + '" y2="' + y(target) + '"/>'
      + '<text x="1" y="' + (y(target) + 3) + '">' + target + '</text>' : '')
    + '<text x="' + left + '" y="111">Semana ' + isoWeek(weeks[0].date)
    + '</text><text x="' + width + '" y="111" text-anchor="end">Semana ' + isoWeek(weeks.at(-1).date) + '</text></svg>';
}

function consistency(ctx) {
  const now = ctx.now(), completed = ctx.data.sessions.filter(row => row.end);
  const target = activeProgram(ctx.data)?.sessionsPerWeek ?? 0;
  const weeks = weeklySessions(completed, now);
  const first = new Date(now.getFullYear(), now.getMonth() + prefs.monthOffset, 1);
  const offset = (first.getDay() + 6) % 7, length = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const percentage = count => {
    const recent = weeks.slice(-count);
    const planned = recent.reduce((total, week) => total + (plannedWeek(weekId(week.date), ctx.data)?.planned ?? target), 0);
    return planned ? number(recent.reduce((total, week) => total + week.value, 0) / planned * 100) + ' %' : '—';
  };
  const cells = Array.from({length: offset}, () => '<span aria-hidden="true"></span>').join('') + Array.from({length,}, (_, i) => {
    const date = localDate(addDays(first, i)), sessions = completed.filter(row => row.date === date);
    if (!sessions.length) return '<span>' + (i + 1) + '</span>';
    return '<button class="trained" type="button" data-calendar="' + date + '" aria-label="' + esc(dateText(date) + ' · ' + sessions.map(row => routine(row, ctx.data)).join(', ')) + '">'
      + (i + 1) + sessions.map(row => '<span class="calendar-name">' + esc(routine(row, ctx.data)) + '</span>').join('') + '</button>';
  }).join('');
  return '<div class="stack-lg"><section class="section"><h2>Sesiones por semana</h2><figure class="panel stack"><figcaption>Últimas 26 semanas'
    + (target ? ' · meta base ' + target : '') + '</figcaption>' + bars(weeks, target) + '</figure>'
    + '<div class="row wrap"><span>4 semanas <strong class="constancia">' + percentage(4) + '</strong></span><span>12 semanas <strong class="constancia">' + percentage(12)
    + '</strong></span><span>Racha <strong class="constancia">' + streak(completed, now) + ' sem</strong></span></div>'
    + (!target ? '<p class="muted">Activa un programa para calcular la adherencia.</p>' : '') + '</section>'
    + '<section class="section"><div class="row">' + iconButton('chevron-left', 'Mes anterior', 'data-month="-1"') + '<h2>'
    + esc(dateText(first, {month: 'long', year: 'numeric'})) + '</h2>' + iconButton('chevron-right', 'Mes siguiente', 'data-month="1"') + '</div>'
    + '<div class="calendar">' + days.map(day => '<span class="weekday">' + day + '</span>').join('') + cells + '</div></section>'
    + summaryHistory(ctx) + '</div>';
}

function sessionList(ctx, sessions) {
  return '<ul class="plain-list">' + sessions.map(row => {
    const sets = ctx.data.sets.filter(set => set.sessionId === row.id && set.type !== 'warmup');
    const count = new Map();
    for (const set of sets) count.set(set.exerciseId, (count.get(set.exerciseId) ?? 0) + 1);
    const list = [...count].slice(0, 3).map(([id, total]) => total + '× ' + (byId(ctx.data.exercises, id)?.name ?? 'Ejercicio')).join(' · ');
    return '<li><button type="button" class="row list-button" data-history-session="' + esc(row.id) + '"><span><strong>' + esc(dateText(row.date, {weekday: 'short', day: 'numeric'}))
      + ' · ' + esc(routine(row, ctx.data)) + ' · ' + Math.max(0, Math.round((row.end - row.start) / 60000)) + ' min</strong><br>'
      + '<small class="muted">' + esc(list || 'Sin series registradas') + (count.size > 3 ? ' …' : '') + '</small></span>' + icon('chevron-right', true)
      + '</button></li>';
  }).join('') + '</ul>';
}

function history(ctx) {
  const groups = new Map();
  for (const row of ctx.data.sessions.filter(row => row.end).sort((a, b) => b.start - a.start)) {
    const month = row.date.slice(0, 7);
    (groups.get(month) ?? groups.set(month, []).get(month)).push(row);
  }
  return '<div class="stack-lg"><button type="button" data-manual>Entrada manual</button>'
    + (groups.size ? [...groups.values()].map(rows => '<section class="section"><h2>' + esc(dateText(rows[0].date, {month: 'long', year: 'numeric'})) + '</h2>'
      + sessionList(ctx, rows) + '</section>').join('') : '<p class="empty">Aquí aparecerán tus sesiones guardadas.</p>') + '</div>';
}

function editSet(ctx, session, set = null) {
  const exercises = ctx.data.exercises;
  if (!exercises.length) return sheet('Añadir serie', '<p>Crea el ejercicio en Programa y luego vuelve a la sesión.</p><p><a href="#programa" data-go-library>Ir a Programa</a></p>',
    root => on(root, '[data-go-library]', closeSheet));
  const id = set?.exerciseId ?? exercises[0].id;
  const machine = set?.machineId ?? (!set ? exercises[0].defaultMachineId : null);
  formSheet(set ? 'Editar serie' : 'Añadir serie',
    select('Ejercicio', 'exerciseId', exercises.map(row => [row.id, row.name]), id)
    + select('Máquina', 'machineId', [['', 'Sin máquina'], ...ctx.data.machines.map(row => [row.id, machineText(ctx.data, row)])], machine)
    + '<div class="cols">' + field('Peso', 'weight', set?.weight ?? 0, 'inputmode="decimal" required')
    + field('Repeticiones / segundos', 'reps', set?.reps, 'inputmode="numeric" required')
    + select('RIR', 'rir', [['', 'Sin dato'], [0, '0'], [1, '1'], [2, '2'], [3, '3+']], set?.rir)
    + select('Tipo', 'type', Object.entries(techniques), set?.type ?? 'working') + '</div>'
    + field('Hora de la serie', 'ts', timestampInput(set?.ts ?? session.start), 'type="datetime-local" required'),
  async values => {
    const machine = byId(ctx.data.machines, values.machineId);
    const reps = requiredNumber(values.reps, 'las repeticiones', 1);
    if (!Number.isInteger(reps)) throw Error('Usa un número entero de repeticiones o segundos.');
    await ctx.save([['sets', {id: set?.id, sessionId: session.id, slotIndex: set?.slotIndex ?? 0,
      setIndex: set?.setIndex ?? ctx.data.sets.filter(row => row.sessionId === session.id).length,
      exerciseId: values.exerciseId, machineId: machine?.id ?? null, weight: requiredNumber(values.weight, 'el peso'),
      unit: machine?.unit ?? 'kg', reps, rir: values.rir === '' ? null : Number(values.rir), type: values.type, ts: +new Date(values.ts), record: false}]]);
    sessionDetail(ctx, session.id);
  });
}

function sessionDetail(ctx, id) {
  const session = byId(ctx.data.sessions, id);
  if (!session) return;
  const sets = ctx.data.sets.filter(row => row.sessionId === id).sort((a, b) => a.ts - b.ts);
  const remove = async set => {
    await ctx.save([['sets', {id: set.id, deleted: true}]]);
    sessionDetail(ctx, id);
    ctx.notice('Serie eliminada.', false, {label: 'Deshacer', duration: 5000, action: async () => {
      await ctx.save([['sets', {...set, deleted: false}]]);
      if ($('#sheet').open) sessionDetail(ctx, id);
    }});
  };
  sheet(routine(session, ctx.data), '<div class="stack"><p class="muted">' + esc(dateText(session.date)) + ' · ' + Math.round((session.end - session.start) / 60000)
    + ' min</p>' + (session.notes ? '<p>' + esc(session.notes) + '</p>' : '') + '<button type="button" data-add-set>Añadir serie</button>'
    + (sets.length ? '<ul class="plain-list">' + sets.map(set => '<li class="swipe-row row" data-swipe="' + esc(set.id) + '"><button type="button" class="list-button" data-edit="'
      + esc(set.id) + '"><strong>' + esc(byId(ctx.data.exercises, set.exerciseId)?.name ?? 'Ejercicio') + '</strong><br><small class="muted">'
      + esc(loadText(set.weight, set.unit)) + ' × ' + set.reps + ' · ' + esc(techniqueName(set.type)) + '</small></button>'
      + iconButton('trash-2', 'Eliminar serie', 'data-delete="' + esc(set.id) + '"') + '</li>').join('') + '</ul>'
      : '<p class="empty">Sin series registradas.</p>') + '</div>', root => {
    on(root, '[data-add-set]', () => editSet(ctx, session));
    on(root, '[data-edit]', node => editSet(ctx, session, byId(sets, node.dataset.edit)));
    on(root, '[data-delete]', node => remove(byId(sets, node.dataset.delete)));
    for (const node of root.querySelectorAll('[data-swipe]')) {
      let x, y, suppress = false;
      node.addEventListener('pointerdown', event => { x = event.clientX; y = event.clientY; suppress = false; });
      on(node, '[data-edit]', (_, event) => { if (suppress) event.preventDefault(); }, 'pointercancel');
      node.addEventListener('click', event => { if (suppress) event.stopImmediatePropagation(); }, true);
      node.addEventListener('pointerup', event => {
        if (x - event.clientX > 44 && Math.abs(y - event.clientY) < 36 && !suppress) {
          suppress = true;
          remove(byId(sets, node.dataset.swipe)).catch(error => ctx.notice(error.message, true));
        }
      });
    }
  });
}

function manualSession(ctx) {
  const today = localDate(ctx.now());
  formSheet('Entrada manual', field('Nombre de la rutina', 'dayName', '', 'required')
    + field('Fecha', 'date', today, 'type="date" required max="' + today + '"')
    + '<div class="cols">' + field('Hora de inicio', 'start', '18:00', 'type="time" required')
    + field('Duración (min)', 'minutes', 45, 'type="number" min="1" max="1440" required') + '</div>'
    + field('Notas', 'notes'), async values => {
    const name = values.dayName.trim();
    if (!name) throw Error('Escribe el nombre de la rutina.');
    const id = uuid(), start = +new Date(values.date + 'T' + values.start), end = start + Number(values.minutes) * 60000;
    if (!Number.isFinite(start) || start > +ctx.now()) throw Error('Elige una fecha y hora que ya hayan pasado.');
    await ctx.save([['sessions', {id, date: values.date, start, end, programId: null, week: null, dayIndex: null,
      bodyweight: interpolatedWeight(ctx.data.body, values.date), notes: values.notes, dayName: name, manual: true}]], {newSession: true});
    sessionDetail(ctx, id);
  });
}

export function progressView(ctx) {
  const key = Object.hasOwn(sections, ctx.subroute) ? ctx.subroute : 'fuerza';
  return title(ctx, 'Progreso') + '<nav class="segment progress-segments" aria-label="Secciones de progreso">'
    + '<span class="segment-indicator" aria-hidden="true"></span>' + Object.entries(sections).map(([route, name]) =>
    '<a href="#progreso/' + route + '" data-section="' + route + '"' + (route === key ? ' aria-current="page"' : '') + '>' + name + '</a>').join('') + '</nav>'
    + '<div class="progress-' + key + '"' + (ctx.progressMotion ? ' data-progress-motion' : '') + '>'
    + ({fuerza: strength, hipertrofia: hypertrophy, tamano: size, constancia: consistency, historial: history})[key](ctx) + '</div>';
}

function positionIndicator(root, previous) {
  const nav = $('.progress-segments', root);
  const indicator = $('.segment-indicator', nav);
  const selected = $('[aria-current]', nav);
  const prior = [...nav.querySelectorAll('[data-section]')].find(link => link.dataset.section === previous);
  function position() {
    const {offsetLeft, offsetWidth} = selected;
    if (!offsetWidth) return;
    indicator.style.left = offsetLeft + 'px';
    indicator.style.width = offsetWidth + 'px';
    indicator.style.setProperty('--section-color', getComputedStyle(selected).getPropertyValue('--section-color'));
    nav.dataset.indicator = '';
  }
  position();
  if (prior && prior !== selected && selected.offsetWidth) {
    indicator.style.setProperty('--indicator-shift', prior.offsetLeft - selected.offsetLeft + 'px');
    indicator.style.setProperty('--indicator-scale', prior.offsetWidth / selected.offsetWidth);
    indicator.style.setProperty('--previous-section-color', getComputedStyle(prior).getPropertyValue('--section-color'));
    indicator.classList.add('segment-slide');
    indicator.addEventListener('animationend', () => indicator.classList.remove('segment-slide'), {once: true});
  }
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(position);
    observer.observe(selected);
    observer.observe(nav);
    root.addEventListener('gym-before-render', () => observer.disconnect(), {once: true});
    document.fonts?.ready.then(() => { if (nav.isConnected) position(); });
  }
}

export function bindProgress(ctx) {
  const root = ctx.root;
  positionIndicator(root, ctx.previousProgressSection);
  bindPlate(root);
  on(root, '[data-lift]', row => { prefs.lift = row.dataset.lift; prefs.relative = false; ctx.render({replayProgress: true}); window.scrollTo(0, 0); });
  on(root, '[data-strength-back]', () => { prefs.lift = null; ctx.render(); });
  on(root, '[data-relative]', row => { prefs.relative = row.dataset.relative === '1'; ctx.render({replayProgress: true}); });
  on(root, '[data-week]', row => { prefs.weekOffset += Number(row.dataset.week); ctx.render({replayProgress: true}); });
  on(root, '[data-volume-muscle]', node => {
    const key = node.dataset.volumeMuscle;
    const date = addDays(ctx.now(), prefs.weekOffset * 7);
    const {targetRows} = weekContext(ctx.data, date, activeProgram(ctx.data), {historical: prefs.weekOffset < 0});
    const row = targetRows[key];
    if (row) sheet('Meta de ' + muscles[key].toLowerCase(), '<div class="stack"><p>' + quantity(row.sets, 'serie')
      + ' · ' + (row.delta ? signed(row.delta) : 'Sin cambio') + '</p><p class="muted">' + esc(row.reasons.join(' · ')) + '</p></div>');
  });
  on(root, '[data-month]', row => { prefs.monthOffset += Number(row.dataset.month); ctx.render(); });
  on(root, '[data-weigh]', () => bodySheet(ctx));
  on(root, '[data-measures]', () => bodySheet(ctx, true));
  on(root, '[data-manual]', () => manualSession(ctx));
  on(root, '[data-history-session]', node => sessionDetail(ctx, node.dataset.historySession));
  on(root, '[data-calendar]', node => sheet(dateText(node.dataset.calendar), sessionList(ctx,
    ctx.data.sessions.filter(row => row.end && row.date === node.dataset.calendar)),
  sheetRoot => on(sheetRoot, '[data-history-session]', entry => sessionDetail(ctx, entry.dataset.historySession))));
}

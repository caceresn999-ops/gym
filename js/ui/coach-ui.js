import {localDate} from '../metrics.js';
import {option} from '../db.js';
import {muscles, number, quantity} from '../engine.js';
import {buildWeekPlan, coachSettings, completedWeek, feedbackId, feedbackPositions, musclePerformance, programWeekAt,
  proposalForWeek, sessionAppDeload, targetId, weekContext, weekId, weekStart, weekSummary} from '../coach.js';
import {$, $$, activeProgram, activeSession, byId, closeSheet, dateText, esc, formSheet, icon, on, phaseName, signed} from './common.js';
import {bindPlate, plate} from './plate.js';

const weekNumber = id => Number(id.slice(6));
const dayMonth = value => dateText(value, {day: 'numeric', month: 'short'});
export const summaryTitle = id => 'Resumen de la semana ' + weekNumber(id);
export const anchorWeek = (date, programId, programWeek) => option('programWeekAnchor', {isoWeek: weekId(date), programId, programWeek});

export function changeWeekPlan(ctx, id = weekId(ctx.now())) {
  const now = ctx.now(), date = weekId(now) === id ? now : weekStart(id);
  const state = weekContext(ctx.data, date);
  if (!state.week) return;
  const selected = state.storedPlan?.daysAvailable ?? state.defaultDays;
  formSheet('¿Cuántos días puedes entrenar esta semana?',
    (weekId(now) === id ? '' : '<p class="muted">Semana ' + weekNumber(id) + ' · ' + esc(dayMonth(date)) + '</p>')
    + '<div class="plan-days" role="group" aria-label="Días disponibles">' + [3, 4, 5, 6].map(count =>
      '<label><input type="radio" name="daysAvailable" value="' + count + '"' + (selected === count ? ' checked' : '')
      + '><span>' + quantity(count, 'día') + '</span></label>').join('') + '</div>',
    async values => {
      const daysAvailable = Number(values.daysAvailable);
      if (![3, 4, 5, 6].includes(daysAvailable)) throw Error('Elige entre 3 y 6 días.');
      const latest = weekContext(ctx.data, date);
      if (!latest.week || latest.program.id !== state.program.id) throw Error('El programa cambió. Abre de nuevo el plan semanal.');
      const plan = buildWeekPlan({data: ctx.data, program: latest.program, week: latest.week, id, daysAvailable,
        from: date, targets: latest.targetRows, previous: latest.storedPlan});
      await ctx.save([['weekPlans', plan], option('selectedDay', null)]);
      closeSheet();
    }, 'Guardar plan');
}

export async function rescueWeek(ctx) {
  const now = ctx.now(), state = weekContext(ctx.data, now);
  if (!state.missed) return;
  const plan = buildWeekPlan({data: ctx.data, program: state.program, week: state.week, id: state.id,
    daysAvailable: state.plan.daysAvailable, from: now, targets: state.targetRows, previous: state.storedPlan, rescue: true});
  await ctx.save([['weekPlans', plan], option('selectedDay', null)]);
  ctx.notice('Semana reorganizada.');
}

export function proposalCard(ctx, state) {
  if (state.decision || !state.week) return '';
  const reasons = proposalForWeek(state.id, ctx.data, state.program, state.original, localDate(ctx.now()));
  return reasons.length ? '<section class="deload-card stack"><h2>Toca descarga</h2>' + reasonsList(reasons)
    + '<div class="actions"><button type="button" data-deload="accepted">Hacer descarga esta semana</button>'
    + '<button type="button" data-deload="dismissed">Ahora no</button></div></section>' : '';
}

export async function decideDeload(ctx, decision, session = null) {
  const program = session && byId(ctx.data.programs, session.programId);
  const date = program ? session.date : ctx.now();
  const state = weekContext(ctx.data, date, program || undefined);
  if (state.original?.kind !== 'normal' || state.decision === decision || state.decision === 'accepted') return;
  if (program && state.week.n !== session.week) throw Error('La semana del programa cambió. Revisa el plan en Hoy.');
  const key = 'deload:' + state.plan.id;
  const changes = [option(key, decision)];
  if (decision === 'accepted') {
    const data = {...ctx.data, options: {...ctx.data.options, [key]: decision}};
    const updated = weekContext(data, date, program || undefined);
    if (state.storedPlan) changes.push(['weekPlans', updated.plan]);
    const active = session ?? activeSession(ctx.data);
    if (active?.programId === updated.program.id && active.week === updated.week.n
      && (active.isoWeek ?? weekId(active.date)) === updated.id) {
      changes.push(['sessions', {id: active.id, kind: updated.week.kind, appDeload: updated.week.appDeload,
        targets: updated.targets, slots: active.slots.map(slot => slot.archived ? slot : {
          ...slot, sets: slot.sets - (slot.addedSets ?? 0), addedSets: 0, volumeReason: []
        })}]);
    }
  }
  await ctx.save(changes);
}

export async function maintainCoach(ctx) {
  const data = ctx.data, now = ctx.now(), program = activeProgram(data), id = weekId(now);
  if (!program) return;
  const current = programWeekAt(data, program, id);
  const anchor = data.options.programWeekAnchor;
  const changes = [];
  if (anchor?.programId !== program.id) changes.push(anchorWeek(now, program.id, current.n));
  const state = weekContext(data, now, program);
  const {autoVolume, mrv} = coachSettings(data.options);
  for (const [muscle, row] of Object.entries(state.targetRows)) {
    const key = targetId(id, program.id, state.week.n, muscle);
    const previous = data.volumeTargets.find(item => item.id === key);
    const record = {id: key, isoWeek: id, programId: program.id, programWeek: state.week.n, muscle,
      sets: row.sets, base: row.base, delta: row.delta, reasons: row.reasons, recovery: !!row.recovery,
      kind: state.week.kind, enabled: autoVolume, mrv: mrv[muscle]};
    if (!previous || Object.entries(record).some(([field, value]) => JSON.stringify(previous[field]) !== JSON.stringify(value))) {
      changes.push(['volumeTargets', record]);
    }
  }
  if (state.storedPlan && state.plan !== state.storedPlan) changes.push(['weekPlans', state.plan]);
  if (changes.length) await ctx.save(changes, {render: false});
}

const feedbackLabels = {
  soreness: {sano: 'Sano hace días', justo: 'Justo a tiempo', adolorido: 'Aún adolorido'},
  pump: {poco: 'Poco', bien: 'Bien', mucho: 'Mucho'}
};
const pluralMuscles = new Set(['aductores', 'biceps', 'cuadriceps', 'gluteo', 'isquios', 'triceps']);

export function feedbackMarkup(data, session, slot, positions, field) {
  const place = field === 'soreness' ? 'first' : 'last';
  return Object.entries(positions).filter(([, position]) => position[place] === slot.key).map(([key, position]) => {
    const row = byId(data.feedback ?? [], feedbackId(session.id, key));
    const name = muscles[key].toLowerCase();
    const article = key === 'espalda-media' ? 'la' : key === 'pantorrilla' ? 'las' : pluralMuscles.has(key) ? 'los' : 'el';
    const label = field === 'soreness' ? '¿Cómo ' + (article === 'los' || article === 'las' ? 'llegaron ' : 'llegó ') + article + ' ' + name + '?'
      : 'Bombeo ' + (article === 'el' ? 'del ' : 'de ' + article + ' ') + name;
    return '<fieldset class="feedback-row" data-feedback-muscle="' + key + '" data-feedback-field="' + field + '"'
      + (field === 'pump' && !position.ready ? ' hidden' : '') + '><legend>' + esc(label) + '</legend>'
      + '<div class="actions">' + Object.entries(feedbackLabels[field]).map(([value, text]) =>
        '<button type="button" data-feedback-value="' + value + '" aria-pressed="' + (row?.[field] === value) + '">' + text + '</button>').join('')
      + '</div></fieldset>';
  }).join('');
}

export function bindFeedback(ctx, session) {
  for (const panel of $$('[data-feedback-muscle]', ctx.root)) {
    const {feedbackMuscle: muscle, feedbackField: field} = panel.dataset;
    if (!Object.hasOwn(feedbackLabels, field)) continue;
    on(panel, '[data-feedback-value]', async node => {
      const value = node.dataset.feedbackValue, buttons = $$('[data-feedback-value]', panel);
      if (node.getAttribute('aria-pressed') === 'true') return;
      for (const button of buttons) button.disabled = true;
      try {
        await ctx.save([['feedback', {id: feedbackId(session.id, muscle), sessionId: session.id, muscle,
          [field]: value, performance: musclePerformance(session, ctx.data)[muscle] ?? null}]], {render: false});
        for (const button of buttons) button.setAttribute('aria-pressed', String(button === node));
      } finally {
        for (const button of buttons) button.disabled = false;
      }
    });
  }
}

export function refreshPump(ctx, session) {
  const panels = $$('[data-feedback-field="pump"]', ctx.root);
  if (!panels.length) return;
  const positions = feedbackPositions(session, ctx.data.exercises, ctx.data.sets, sessionAppDeload(session, ctx.data));
  for (const panel of panels) panel.hidden = !positions[panel.dataset.feedbackMuscle]?.ready;
}

export function finishFeedback(data, session) {
  const rows = (data.feedback ?? []).filter(row => row.sessionId === session.id);
  if (!rows.length) return [];
  const performance = musclePerformance(session, data);
  return rows.map(row => ['feedback', {id: row.id, performance: performance[row.muscle] ?? null}]);
}

export function slotReasons(slot) {
  return (slot.reason ? '<small class="chip slot-reason">' + esc(slot.reason) + '</small>' : '')
    + (slot.addedSets ? '<small class="slot-rp"><span class="chip">' + (slot.addedSets > 0 ? '+' : '−') + quantity(Math.abs(slot.addedSets), 'serie')
      + ' · RP</span> <span class="muted">' + esc(slot.volumeReason?.join(' · ')) + '</span></small>' : '');
}

const reasonsList = reasons => '<ul class="reason-list">' + reasons.map(reason => '<li>' + esc(reason) + '</li>').join('') + '</ul>';
const delta = (value, label, pluralLabel) => (value > 0 ? '+' : '−') + quantity(Math.abs(value), label, pluralLabel);
const liftName = (lift, data) => [byId(data.exercises, lift.exerciseId)?.name ?? 'Ejercicio',
  byId(data.machines, lift.machineId)?.name ?? 'Sin máquina'].join(' · ');

export function weeklyCard(id) {
  return '<a class="panel row weekly-card" href="#resumen/' + id + '"><strong>' + summaryTitle(id) + '</strong>' + icon('chevron-right', true) + '</a>';
}

export function summaryHistory(ctx) {
  const current = weekId(ctx.now());
  const ids = [...new Set([...ctx.data.sessions.filter(row => row.end && !row.deleted).map(row => weekId(row.date)),
    ...(ctx.data.weekPlans ?? []).filter(row => !row.deleted).map(row => row.isoWeek)])].filter(id => id < current).sort().reverse();
  return '<section class="section"><h2>Resúmenes semanales</h2>' + (ids.length ? '<ul class="plain-list">' + ids.map(id =>
    '<li><a class="row list-button summary-link" href="#resumen/' + id + '"><span>' + summaryTitle(id)
      + '<small class="muted"> · ' + id.slice(0, 4) + '</small></span>' + icon('chevron-right', true) + '</a></li>').join('')
    + '</ul>' : '<p class="muted">Aquí aparecerán los resúmenes de semanas anteriores.</p>') + '</section>';
}

export function summaryView(ctx) {
  const back = ctx.summaryBack === 'progreso' ? '#progreso/constancia' : '#hoy';
  const requested = ctx.subroute;
  const id = /^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/.test(requested) && requested <= weekId(ctx.now()) ? requested : weekId(ctx.now());
  const summary = weekSummary(id, ctx.data);
  const {start, end, count, planned, average, weightChange, rate, phase} = summary;
  const firstDate = start.slice(0, 7) === end.slice(0, 7) ? Number(start.slice(-2)) : dayMonth(start);
  const expected = {volumen: 'subida', deficit: 'bajada', mantenimiento: 'estabilidad'};
  const range = firstDate + '–' + dayMonth(end);
  const adherence = (planned ? count + ' de ' : '') + quantity(planned || count, 'sesión', 'sesiones');
  const currentDay = localDate(ctx.now());
  return '<div class="stack-lg weekly-summary"><header class="stack"><a class="row summary-back" href="' + back + '">'
    + icon('chevron-left', true) + '<span>Volver</span></a><h1>Semana ' + weekNumber(id) + '</h1>'
    + '<p class="caption muted">' + esc(range) + ' · <strong class="constancia">' + adherence + '</strong></p></header>'
    + plate({done: summary.done, targets: summary.targets, total: summary.total, footer: quantity(summary.total, 'serie efectiva', 'series efectivas')})
    + '<section class="section"><h2>Progreso</h2>' + (summary.gains.length ? '<ul class="plain-list">' + summary.gains.map(lift =>
      '<li class="row summary-line"><span>' + esc(liftName(lift, ctx.data)) + '</span><strong class="fuerza">' + esc(signed(lift.delta) + ' ' + (lift.unit ?? 'kg') + ' e1RM') + '</strong></li>').join('') + '</ul>'
      : '<p class="muted">Sin ganancias de e1RM comparables.</p>')
    + (summary.stalls.length ? '<ul class="plain-list">' + summary.stalls.map(lift => '<li class="row summary-line"><span>'
      + esc(liftName(lift, ctx.data)) + '</span><strong class="warning">Estancado</strong></li>').join('') + '</ul>' : '') + '</section>'
    + '<section class="section"><h2>Volumen para la próxima semana</h2>'
    + (summary.changes.length ? '<ul class="plain-list">' + summary.changes.map(([key, row]) => '<li class="summary-line"><strong>'
      + muscles[key] + ' <span class="hipertrofia">' + delta(row.delta, 'serie') + '</span></strong><p class="caption muted">' + esc(row.reasons.join(' · ')) + '</p></li>').join('') + '</ul>'
      : '<p class="muted">Las metas semanales se mantienen.</p>')
    + (summary.proposal.length ? '<div><strong class="warning">Toca descarga</strong>' + reasonsList(summary.proposal) + '</div>' : '') + '</section>'
    + '<section class="section"><h2>Peso corporal</h2><p>' + (average == null ? 'Sin pesajes esta semana.'
      : '<strong class="tamano">' + number(average, 1, 1) + ' kg de media</strong>'
        + (weightChange == null ? '' : ' · ' + signed(weightChange) + ' kg frente a la semana pasada')) + '</p>'
    + '<p class="muted">' + (rate == null ? 'Faltan pesajes para el ritmo de 28 días.' : 'Ritmo de 28 días: ' + signed(rate) + ' kg/mes')
    + (phase ? ' · Fase de ' + phaseName(phase) + ', objetivo de ' + expected[phase] : '') + '</p></section>'
    + '<section class="section"><h2>Próxima semana</h2><p>' + esc(summary.sentence) + '</p>'
    + (activeProgram(ctx.data) && summary.next >= weekId(currentDay) ? '<button type="button" class="primary full" data-plan-next="' + summary.next
      + '">Planear la próxima semana</button>' : '') + '</section></div>';
}

export function bindSummary(ctx) {
  bindPlate(ctx.root);
  on(ctx.root, '[data-plan-next]', node => changeWeekPlan(ctx, node.dataset.planNext));
}

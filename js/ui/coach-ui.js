import {localDate} from '../metrics.js';
import {option} from '../db.js';
import {muscles} from '../engine.js';
import {buildWeekPlan, coachSettings, mesocycle, musclePerformance, programWeekAt,
  proposalForWeek, targetId, weekContext, weekId, weekStart} from '../coach.js';
import {$, $$, activeProgram, activeSession, byId, closeSheet, dateText, esc, formSheet, icon, on, phaseName, signed} from './common.js';

const weekNumber = id => Number(id.slice(6));
const dayMonth = value => dateText(value, {day: 'numeric', month: 'short'});
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
  const preview = daysAvailable => {
    const plan = buildWeekPlan({data: ctx.data, program: state.program, week: state.week, id, daysAvailable,
      from: date, targets: state.targetRows, previous: state.storedPlan});
    $('[data-plan-preview]', dialog).innerHTML = '<div class="plan">' + plan.plan.map((day, i) =>
      '<span>' + (i + 1) + '. ' + esc(day.name) + '</span>').join('') + '</div>'
      + (plan.dropped.length ? '<p class="muted">Fuera esta semana: ' + plan.dropped.map(slot =>
        esc(byId(ctx.data.exercises, slot.exerciseId)?.name ?? 'Ejercicio')).join(', ') + '</p>' : '');
  };
  on(dialog, '[name=daysAvailable]', input => preview(Number(input.value)), 'change');
  preview(selected);
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
  return reasons.length ? '<button type="button" class="alert warn" data-deload-open><span class="ic2">'
    + icon('pause') + '</span><div><b>Tu cuerpo pide descarga</b><span>' + esc(reasons[0]) + '</span></div><span class="chev">›</span></button>' : '';
}

export function openDeload(ctx) {
  const state = weekContext(ctx.data, ctx.now());
  const reasons = proposalForWeek(state.id, ctx.data, state.program, state.original, localDate(ctx.now()));
  sheet('Tu cuerpo pide descarga', reasonsList(reasons) + '<div class="stack"><button class="primary" data-deload="accepted">Hacer descarga esta semana</button>'
    + '<button data-deload="dismissed">Ahora no</button></div>', root => on(root, '[data-deload]', async node => {
    for (const button of $$('[data-deload]', root)) button.disabled = true;
    try { await decideDeload(ctx, node.dataset.deload); closeSheet(); }
    finally { for (const button of $$('[data-deload]', root)) button.disabled = false; }
  }));
}

export function cycleView(ctx, program = activeProgram(ctx.data)) {
  if (!program) return '<p class="muted">Sin programa activo.</p>';
  const cycle = mesocycle(program, ctx.data, weekId(ctx.now()));
  const blocks = Map.groupBy(cycle.weeks, (week, index) => week.block ?? Math.floor(index / 6) + 1);
  const next = cycle.weeks.find(row => row.n >= cycle.current && row.kind === 'deload');
  const current = cycle.weeks.find(row => row.n === cycle.current);
  return '<section class="card cycle"><p class="muted">Semana ' + cycle.current + ' de ' + cycle.weeks.length + '</p>'
    + '<div class="cycle-blocks">' + [...blocks].map(([block, rows]) =>
      '<div class="cycle-block" style="--weeks:' + rows.length + '"><small>Bloque ' + esc(block) + '</small><div>'
      + rows.map(week => '<div class="cycle-week"><b class="' + (week.complete ? 'complete ' : '') + (week.n === cycle.current ? 'current' : '')
        + '" title="' + (week.kind === 'intro' ? 'Introducción' : week.kind === 'deload' ? 'Descarga' : 'Semana ' + week.n) + '">' + week.n + '</b>'
        + '<small>' + (week.kind === 'intro' ? 'I' : week.kind === 'deload' ? 'D' : '?') + '</small></div>').join('') + '</div></div>').join('') + '</div>'
    + '<p class="muted small">I · Introducción &nbsp; D · Descarga</p>'
    + '<p>Próxima descarga: ' + (next ? 'semana ' + next.n : 'sin fecha') + '</p><p class="muted">'
    + (cycle.phase ? 'Fase de ' + phaseName(cycle.phase) : 'Sin fase registrada') + (cycle.rate == null ? '' : ' ? ' + signed(cycle.rate) + ' kg/mes') + '</p>'
    + '<h3>RIR, series y sesiones por semana</h3><table class="cycle-table"><thead><tr><th>Semana</th><th>RIR</th><th>Series</th><th>Sesiones</th></tr></thead><tbody>'
    + cycle.weeks.map(week => '<tr' + (week === current ? ' aria-current="step"' : '') + '><td>' + week.n + '</td><td>'
      + (week.rir.map(rir => rir === 3 ? '3+' : rir).join(' / ') || '?') + '</td><td>' + week.sets + '</td><td>'
      + week.done + ' de ' + week.planned + '</td></tr>').join('') + '</tbody></table></section>';
}

export function openCycle(ctx) {
  sheet('Mesociclo', cycleView(ctx));
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

export function finishFeedback(data, session) {
  const rows = (data.feedback ?? []).filter(row => row.sessionId === session.id);
  if (!rows.length) return [];
  const performance = musclePerformance(session, data);
  return rows.map(row => ['feedback', {id: row.id, performance: performance[row.muscle] ?? null}]);
}

function reasonsList(reasons) {
  return '<ul class="reason-list">' + reasons.map(reason => '<li>' + esc(reason) + '</li>').join('') + '</ul>';
}

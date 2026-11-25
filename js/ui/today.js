import {option} from '../db.js';
import {number, plural, quantity} from '../engine.js';
import {completedWeek, summaryVisible, weekContext, workingSets} from '../coach.js';
import {addDays, dose, latestStrength, localDate, monday, strengthTrend, weightRate} from '../metrics.js';
import {nextSessionNumber} from '../db.js';
import {activeSession, bodySheet, byId, clock, dateText, disclosure, esc, icon, lastBody, loadText, on, prescribed, sample, signed} from './common.js';
import {bindPlate, plate} from './plate.js';
import {chooseDay, slotContext, startSession} from './training.js';
import {changeWeekPlan, decideDeload, proposalCard, rescueWeek, slotReasons, weeklyCard} from './coach-ui.js';

const days = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const setsWeek = state => state.plan?.plan.reduce((total, day) =>
  total + day.slots.reduce((count, slot) => count + workingSets(slot, day.appDeload ?? state.week.appDeload), 0), 0) ?? 0;

function preview(ctx, slot, week) {
  const {exercise, machine, last, next, repMax} = slotContext(ctx.data, slot, week.kind, week.appDeload);
  const previous = last.filter(set => set.type === 'working').map(set => loadText(set.weight, set.unit, false) + ' × ' + set.reps).join(', ');
  return '<div class="today-exercise"><div><strong>' + esc(exercise?.name ?? 'Ejercicio') + '</strong><small class="muted">'
    + esc(prescribed({...slot, repMax, sets: next.setCount, rir: next.rir})) + ' · '
    + (previous ? 'últ. ' + esc(previous) : 'Sin series previas en esta máquina') + '</small>' + slotReasons(slot) + '</div>'
    + '<div class="today-load"><b>' + (next.load === 0 ? number(next.reps) + ' <small>' + plural(next.reps, 'rep') + '</small>'
      : esc(loadText(next.load, machine?.unit, false)) + (next.load > 0 && machine ? ' <small>' + esc(machine.unit) + '</small>' : '')) + '</b>'
    + '<span class="chip">' + esc(next.chip) + '</span></div></div>';
}

function pillars(data, today, weight, count, target) {
  const changes = latestStrength(data.sets, data.sessions).filter(({point}) => !point.bodyweight)
    .map(({same}) => strengthTrend(same, 12, today)).filter(value => value !== null).sort((a, b) => a - b);
  const middle = Math.floor(changes.length / 2);
  const median = changes.length % 2 ? changes[middle] : (changes[middle - 1] + changes[middle]) / 2;
  return '<div class="pillar-strip">'
    + pillar('fuerza', '<span>Fuerza · 12 sem</span><span class="pillar-short">Fuerza 12 sem</span>', changes.length ? median : null, '%')
    + pillar('tamano', 'Peso corporal', weight ?? null, ' kg')
    + pillar('constancia', 'Semana', count, ' / ' + (target || '—')) + '</div>';
}

function pillarNumber(key, value) {
  if (key === 'fuerza') return signed(value);
  return key === 'tamano' ? number(value, 1, 1) : number(value, 0);
}

function pillar(key, label, value, suffix) {
  const formatted = value == null ? '—' : pillarNumber(key, value);
  const reserve = value != null && key === 'fuerza'
    ? (value < 0 ? '−' : '+') + number(Math.abs(value), 1, 1) : formatted;
  return '<a href="#progreso/' + key + '"><small>' + label + '</small><strong class="' + key + '" aria-label="'
    + formatted + (value == null ? '' : suffix) + '">' + (value == null ? formatted
    : '<span class="pillar-number" aria-hidden="true"><span class="pillar-width">' + reserve
    + '</span><span data-pillar="' + key + '" data-value="' + value + '">' + formatted + '</span></span>' + suffix)
    + '</strong></a>';
}

function countEase(elapsed) {
  // Find the curve parameter for elapsed time on cubic-bezier(.16,1,.3,1).
  let low = 0, high = 1;
  for (let i = 0; i < 10; i++) {
    const t = (low + high) / 2, rest = 1 - t;
    const x = 3 * t * rest * (.16 * rest + .3 * t) + t ** 3;
    if (x < elapsed) low = t;
    else high = t;
  }
  return 1 - (1 - (low + high) / 2) ** 3;
}

function countPillars(root) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  if (document.hidden || reduced.matches) return;
  const values = [...root.querySelectorAll('[data-pillar]')];
  function draw(progress) {
    for (const node of values) node.textContent = pillarNumber(node.dataset.pillar, Number(node.dataset.value) * progress);
  }
  let frame;
  function finish() {
    cancelAnimationFrame(frame);
    draw(1);
    root.removeEventListener('gym-before-render', finish);
    document.removeEventListener('visibilitychange', finish);
    reduced.removeEventListener('change', finish);
  }
  draw(0);
  const start = performance.now();
  function tick(now) {
    const elapsed = Math.min(1, (now - start) / 500);
    if (elapsed >= 1) return finish();
    draw(countEase(elapsed));
    frame = requestAnimationFrame(tick);
  }
  root.addEventListener('gym-before-render', finish);
  document.addEventListener('visibilitychange', finish);
  reduced.addEventListener('change', finish);
  frame = requestAnimationFrame(tick);
}

export function todayView(ctx) {
  const now = ctx.now(), today = localDate(now), data = ctx.data, session = activeSession(data), state = weekContext(data, now);
  const {program, week, plan, pending = []} = state;
  const selected = data.options.selectedDay;
  const day = (selected && (selected.isoWeek ?? state.id) === state.id && selected.programId === program?.id && selected.week === week?.n
    ? pending.find(item => item.dayIndex === selected.index) : null) ?? pending[0];
  const {done, total} = dose(data.sets, data.exercises, data.sessions, today);
  const last = lastBody(data), rate = weightRate(data.body, today);
  const start = monday(today);
  const weekSessions = completedWeek(state.id, data.sessions);
  const target = state.storedPlan ? plan.planned : program?.sessionsPerWeek ?? 0;
  const date = dateText(today);
  const showSummary = (program || weekSessions.length) && summaryVisible(now, state.storedPlan && plan, weekSessions, target);
  const changePlan = '<button type="button" class="link-button" data-change-plan>Cambiar</button>';
  const rescue = state.missed ? '<div class="row wrap week-rescue"><p class="warning">'
    + (state.daysLeft === 1 ? 'Te queda ' : 'Te quedan ') + quantity(state.daysLeft, 'día') + ' esta semana</p>'
    + '<button type="button" data-rescue>Reorganizar</button></div>' : '';
  const dropped = plan?.dropped.length ? '<details class="dropped-week">' + disclosure('Fuera esta semana (' + plan.dropped.length + ')')
    + '<ul class="plain-list">' + plan.dropped.map(item => '<li><strong>' + esc(byId(data.exercises, item.exerciseId)?.name ?? 'Ejercicio')
      + '</strong><small class="muted">' + esc(item.reason) + '</small></li>').join('') + '</ul></details>' : '';
  return '<header class="screen-heading today-heading"><h1>Hoy</h1><div class="today-meta"><p>' + esc(date[0].toUpperCase() + date.slice(1))
    + ' · Sesión ' + nextSessionNumber(data) + '</p>' + sample(ctx) + '</div></header>'
    + (showSummary ? weeklyCard(state.id) : '')
    + plate({done, targets: state.targets, total, goal: setsWeek(state)})
    + pillars(data, today, last?.weight, weekSessions.length, target)
    + proposalCard(ctx, state)
    + '<section class="today-card">'
    + (program ? '<div class="row today-program-heading"><h2>' + esc(day?.name ?? 'Semana completada') + '</h2>' + changePlan + '</div><p class="caption muted">'
      + (day ? esc(program.name) + ' · semana ' + week.n + ' · día ' + (day.dayIndex + 1) + ' · ' : '')
      + 'Semana de ' + quantity(plan.daysAvailable, 'día') + '</p>'
      + (week.kind === 'deload' ? '<p class="caption warning">Semana de descarga' + (week.appDeload ? ' · RIR 2–3' : '') + '</p>' : '')
      + (week.kind === 'intro' ? '<p class="caption muted">Semana de introducción</p>' : '')
      + rescue + (day?.slots.slice(0, 3).map(slot => preview(ctx, slot, week)).join('') ?? '')
      + (session ? '<a class="primary today-start start-link" href="#entrenar">Volver a la sesión · <span data-elapsed>'
        + clock((+now - session.start) / 1000) + '</span></a>'
        : day ? '<button class="primary full today-start" data-start="' + day.dayIndex + '">Empezar · ' + quantity(day.slots.length, 'ejercicio') + '</button>' : '')
      + (pending.length > 1 ? '<button type="button" class="link-button" data-other-day>Elegir otro día</button>' : '') + dropped
      : '<h2>Sin programa activo</h2><button class="primary full today-start" data-import-program>Importar programa</button>') + '</section>'
    + '<div class="today-strips"><section class="section"><div class="row wrap"><p>' + (last
      ? 'Peso corporal <strong>' + esc(number(last.weight, 1, 1)) + ' kg</strong>' + (rate == null ? '' : ' · ' + esc(signed(rate)) + ' kg/mes')
      : 'Peso corporal · sin registros') + '</p>'
      + (!last || last.date < localDate(addDays(today, -7)) ? '<button class="link-button" data-weigh>Pesarme hoy</button>' : '') + '</div></section>'
    + '<section class="section"><div class="row"><h3>Esta semana</h3><span class="muted">' + weekSessions.length
    + (target ? ' de ' + target : '') + ' ' + plural(target || weekSessions.length, 'sesión', 'sesiones') + '</span></div><div class="week-cells">' + days.map((label, i) => {
      const date = localDate(addDays(start, i));
      const dayDone = weekSessions.some(row => row.date === date), planned = !dayDone && pending.some(day => day.date === date);
      return '<div class="week-cell ' + (dayDone ? 'done' : planned ? 'planned' : '') + '" aria-label="' + label + ': '
        + (dayDone ? 'entrenado' : planned ? 'planeado' : 'descanso') + '"><span>' + label + '</span>'
        + icon(dayDone ? 'check' : planned ? 'circle' : 'minus', true) + '</div>';
    }).join('') + '</div></section></div>';
}

export function bindToday(ctx) {
  bindPlate(ctx.root);
  if (ctx.root.dataset.todayMotion === 'first') countPillars(ctx.root);
  on(ctx.root, '[data-start]', async node => {
    node.disabled = true;
    try { await startSession(ctx, Number(node.dataset.start)); }
    finally { node.disabled = false; }
  });
  on(ctx.root, '[data-other-day]', () => {
    const {id, program, week} = weekContext(ctx.data, ctx.now());
    chooseDay(ctx, index => ctx.save([option('selectedDay', {isoWeek: id, programId: program.id, week: week.n, index})]));
  });
  on(ctx.root, '[data-change-plan]', () => changeWeekPlan(ctx));
  on(ctx.root, '[data-rescue]', async node => {
    node.disabled = true;
    try { await rescueWeek(ctx); } finally { node.disabled = false; }
  });
  on(ctx.root, '[data-deload]', async node => {
    const buttons = [...node.parentNode.querySelectorAll('[data-deload]')];
    for (const button of buttons) button.disabled = true;
    try { await decideDeload(ctx, node.dataset.deload); }
    finally { for (const button of buttons) button.disabled = false; }
  });
  on(ctx.root, '[data-weigh]', () => bodySheet(ctx));
  on(ctx.root, '[data-import-program]', () => ctx.pickProgram());
}

import {option} from '../db.js';
import {muscles, number, quantity} from '../engine.js';
import {completedWeek, summaryVisible, weekContext, workingSets} from '../coach.js';
import {addDays, localDate, medianStrength, monday, recovery, streak} from '../metrics.js';
import {activeSession, byId, dateText, esc, icon, lastBody, on, routine, sample} from './common.js';
import {changeWeekPlan, openCycle, openDeload, proposalCard, rescueWeek} from './coach-ui.js';
import {chooseDay, startSession} from './training.js';
import {openPeriodStory, openWeekStory} from './story.js';
import {count, ring} from './motion.js';

const labels = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
export const planChips = (days, pending) => '<div class="plan">' + days.map((item, i) => '<span'
  + (item.dayIndex === pending ? ' class="next"' : '') + '>' + (i + 1) + '. ' + esc(item.name) + '</span>').join('') + '</div>';

function alert(button, symbol, title, copy) {
  return '<button class="alert" ' + button + '><span class="ic2">' + icon(symbol) + '</span><div><b>' + esc(title)
    + '</b><span>' + esc(copy) + '</span></div><span class="chev">›</span></button>';
}

function lastWorkout(data) {
  const last = data.sessions.filter(row => row.end && !row.deleted).sort((a, b) => b.start - a.start)[0];
  if (!last) return '<p class="muted">Aquí verás tu último entreno.</p>';
  const groups = Map.groupBy(data.sets.filter(set => !set.deleted && set.sessionId === last.id && set.type !== 'warmup'), set => set.exerciseId);
  return '<a class="card feed" href="#historial/' + encodeURIComponent(last.id) + '"><div class="row"><b class="t">'
    + esc(routine(last, data)) + '</b><span class="muted small">' + esc(dateText(last.date)) + ' · ' + Math.round((last.end - last.start) / 60000)
    + ' min</span></div>' + (groups.size ? '<ul>' + [...groups].slice(0, 4).map(([id, sets]) => '<li><em>' + sets.length
      + '×</em>' + esc(byId(data.exercises, id)?.name ?? 'Ejercicio') + '</li>').join('') + '</ul>' : '') + '</a>';
}

function workoutCard(ctx, state, day, session) {
  if (!state.program) return '<section class="today"><h3>Tu próximo entreno</h3>'
    + '<button class="go" data-import-program>Importar programa</button></section>';
  const {program, week} = state;
  const tag = '<button class="tag" data-cycle>' + esc(program.name) + ' · Semana ' + week.n + ' de ' + program.weeks.length
    + (day ? ' · Día ' + (day.dayIndex + 1) : '') + '</button>';
  const cta = session ? '<a class="go" href="#entrenar">Volver al entreno</a>'
    : day ? '<button class="go" data-start="' + day.dayIndex + '">' + icon('play') + 'Empezar entreno</button>' : '';
  if (!day) return '<section class="today">' + tag + '<h3>Semana completada</h3>' + cta + '</section>';
  const sets = day.slots.reduce((total, slot) => total + workingSets(slot, week.appDeload), 0);
  const minutes = Math.max(5, Math.round(day.slots.reduce((total, slot) => {
    const rest = slot.restMin != null && slot.restMax != null ? (slot.restMin + slot.restMax) / 2 : (ctx.data.options.defaultRest ?? 90) / 60;
    return total + workingSets(slot, week.appDeload) * (rest + 1.4) + (slot.warmups ?? 0);
  }, 0) / 5) * 5);
  const moved = Map.groupBy(day.slots.filter(slot => slot.reason?.startsWith('movido de ')), slot => slot.reason.slice(10));
  const recovered = recovery(ctx.data.sets, ctx.data.exercises, ctx.now());
  const primary = [...new Set(day.slots.flatMap(slot => Object.entries(slot.muscles ?? byId(ctx.data.exercises, slot.exerciseId)?.muscles ?? {})
    .filter(([, weight]) => weight === 1).map(([key]) => key)))];
  const orphans = primary.filter(key => recovered[key]?.recovered < .7).sort((a, b) => recovered[a].recovered - recovered[b].recovered);
  const muscle = orphans[0];
  return '<section class="today">' + tag + '<h3>' + esc(day.name) + '</h3><div class="meta">' + quantity(day.slots.length, 'ejercicio')
    + ' · ' + quantity(sets, 'serie') + ' · ~' + minutes + ' min</div>'
    + (week.kind === 'normal' ? '' : '<p class="meta">' + (week.kind === 'deload' ? 'Semana de descarga' : 'Semana de introducción') + '</p>')
    + (muscle ? '<p class="recovery-note">' + muscles[muscle] + ' aún recuperándose (~' + Math.ceil(recovered[muscle].remaining) + ' h)</p>' : '')
    + '<div class="chips">' + day.slots.slice(0, 4).map(slot => '<span>' + esc(byId(ctx.data.exercises, slot.exerciseId)?.name ?? 'Ejercicio') + '</span>').join('')
    + (day.slots.length > 4 ? '<span>+' + (day.slots.length - 4) + '</span>' : '')
    + [...moved].map(([name, slots]) => '<span>+' + slots.length + ' de ' + esc(name) + '</span>').join('') + '</div>'
    + cta + (state.pending.length > 1 ? '<button class="other-day" data-other-day>Elegir otro día</button>' : '') + '</section>';
}

export function todayView(ctx) {
  const now = ctx.now(), today = localDate(now), data = ctx.data, session = activeSession(data), state = weekContext(data, now);
  const {program, week, plan, pending = []} = state;
  const selection = data.options.selectedDay;
  const day = (selection && (selection.isoWeek ?? state.id) === state.id && selection.programId === program?.id && selection.week === week?.n
    ? pending.find(item => item.dayIndex === selection.index) : null) ?? pending[0];
  const thisWeek = completedWeek(state.id, data.sessions).filter(row => row.date <= today);
  const target = plan?.planned ?? 0, start = monday(today), recent = streak(data.sessions, now);
  const year = now.getFullYear(), month = now.getMonth(), dayOfMonth = now.getDate();
  const yearCount = data.sessions.filter(row => row.end && !row.deleted && row.date.startsWith(String(year)) && row.date <= today).length;
  const strength = medianStrength(data.sets, data.sessions, 12, today), weight = lastBody(data)?.weight;
  const weekly = (program || thisWeek.length) && summaryVisible(now, state.storedPlan && plan, thisWeek, target);
  const canShowMonthly = dayOfMonth <= 3;
  const yearEnd = month === 11 && dayOfMonth >= 20, yearStart = month === 0 && dayOfMonth <= 10;
  return '<div class="top"><div class="brand"><img class="logo" src="./icons/forja.svg" alt="">Forja</div>'
    + '<div class="streak">' + icon('flame') + (recent ? quantity(recent, 'semana') : 'Retoma hoy') + '</div></div>'
    + '<div class="greeting"><p class="hello">' + esc(dateText(today, {weekday: 'long', day: 'numeric', month: 'long'}))
    + '</p><h1>Vamos, ' + esc(data.options.name?.trim() || 'Nicolás') + '</h1>' + sample(ctx) + '</div>'
    + (weekly ? alert('data-week-story', 'flame', 'Tu semana ' + Number(state.id.slice(6)) + ' en Forja', quantity(thisWeek.length, 'entreno') + ' · Mira el resumen') : '')
    + proposalCard(ctx, state)
    + (state.missed ? alert('data-rescue', 'calendar-days', 'Reorganizar', 'Ajusta el plan a los días que quedan.') : '')
    + (canShowMonthly ? alert('data-period="month"', 'calendar-days', 'Tu resumen del mes', 'Mira cómo entrenaste el mes pasado.') : '')
    + (yearEnd || yearStart ? alert('data-period="year" data-previous="' + Number(yearStart) + '"', 'flame', 'Tu año en Forja', 'Mira tus entrenos y récords.') : '')
    + workoutCard(ctx, state, day, session)
    + '<section><div class="weekhead"><h2>Esta semana</h2>' + (week ? '<button class="daysbtn" data-change-plan>'
      + icon('calendar-days') + quantity(plan.daysAvailable, 'día') + '</button>' : '') + '</div>'
    + '<div class="card"><div class="weekwrap"><div class="ring">' + ring(thisWeek.length, target, 'week') + '<b><span>'
    + count(thisWeek.length) + '<small>' + (target ? 'de ' + target : 'entrenos') + '</small></span></b></div>'
    + '<div class="days">' + labels.map((label, i) => {
      const date = localDate(addDays(start, i)), trained = thisWeek.some(row => row.date === date);
      return '<div>' + label + '<i class="' + (date === today ? 'now ' : '') + (trained ? 'trained' : '') + '"'
        + (date === today ? ' aria-current="date"' : '') + (trained ? ' aria-label="Entrenado"' : '') + '>'
        + (trained ? icon('check', true) : Number(date.slice(-2))) + '</i></div>';
    }).join('') + '</div></div>' + planChips(plan?.plan ?? [], day?.dayIndex) + '</div></section>'
    + '<div class="stat3 home-stats"><a class="card" href="#progreso"><b class="' + (strength > 0 ? 'up' : strength < 0 ? 'down' : '') + '">'
    + count(strength, 1, true) + (strength == null ? '' : '%') + '</b><small>Fuerza · 12 sem</small></a>'
    + '<a class="card" href="#perfil/peso"><b>' + count(weight, 1) + (weight ? ' kg' : '') + '</b><small>Peso corporal</small></a>'
    + '<a class="card" href="#historial"><b>' + count(yearCount) + '</b><small>Entrenos del año</small></a></div>'
    + '<section><h2>Último entreno</h2>' + lastWorkout(data) + '</section>';
}

export function bindToday(ctx) {
  const root = ctx.root;
  on(root, '[data-start]', async node => {
    node.disabled = true;
    try { await startSession(ctx, Number(node.dataset.start)); }
    finally { node.disabled = false; }
  });
  on(root, '[data-other-day]', () => {
    const {id, program, week} = weekContext(ctx.data, ctx.now());
    chooseDay(ctx, index => ctx.save([option('selectedDay', {isoWeek: id, programId: program.id, week: week.n, index})]));
  });
  on(root, '[data-change-plan]', () => changeWeekPlan(ctx));
  on(root, '[data-rescue]', () => rescueWeek(ctx));
  on(root, '[data-deload-open]', () => openDeload(ctx));
  on(root, '[data-cycle]', () => openCycle(ctx));
  on(root, '[data-week-story]', () => openWeekStory(ctx));
  on(root, '[data-period]', node => openPeriodStory(ctx, node.dataset.period, node.dataset.period === 'month' || node.dataset.previous === '1'));
  on(root, '[data-import-program]', () => ctx.pickProgram());
}

import {muscles, number, quantity} from '../engine.js';
import {periodSummary, weekId, weekSummary} from '../coach.js';
import {localDate} from '../metrics.js';
import {$, byId, closeSheet, dateText, esc, loadText, on, sheet, signed} from './common.js';
import {changeWeekPlan} from './coach-ui.js';

const dayMonth = date => dateText(date, {day: 'numeric', month: 'short'});
const month = date => dateText(date, {month: 'long', year: 'numeric'});
const lift = (ctx, id) => byId(ctx.data.exercises, id)?.name ?? 'Ejercicio';
const line = (name, metric) => [name, metric];
const slide = (title, copy = '', rows = [], action = '') => ({title, copy, rows, action});
const noRecords = 'Sigue sumando sesiones.';
const gains = (ctx, rows, max) => rows.slice(0, max).map(row => line(lift(ctx, row.exerciseId), signed(row.percent) + '%'));
const doses = rows => rows.map(row => line(muscles[row.key], quantity(row.sets, 'serie')));
const recordLines = (ctx, rows) => rows.toReversed().slice(0, 5).map(({set}) =>
  line(lift(ctx, set.exerciseId), loadText(set.weight, set.unit) + ' × ' + set.reps));

export function openWeekStory(ctx, id = weekId(ctx.now())) {
  const report = weekSummary(id, ctx.data);
  const name = 'Semana ' + Number(id.slice(6)) + ' · ' + dayMonth(report.start) + '–' + dayMonth(report.end);
  story(name, [
    slide(report.count + (report.planned ? ' de ' + report.planned : '') + ' entrenos', report.sentence),
    slide(quantity(report.records, 'récord'), report.records ? 'Forjaste nuevas marcas.' : noRecords, recordLines(ctx, report.recordPoints)),
    slide('Lo que más falta', report.deficits.length ? '' : 'Sin músculos por debajo de la meta.', report.deficits.map(row =>
      line(muscles[row.key], number(row.done) + ' / ' + number(row.target)))),
    slide('Ajuste de volumen', report.changes.length ? '' : 'Mantén el volumen.', report.changes.map(([key, row]) =>
      line(muscles[key], signed(row.delta) + ' series'))),
    slide(report.average == null ? 'Peso corporal' : number(report.average) + ' kg', report.weightChange == null
      ? 'Promedio semanal' : signed(report.weightChange) + ' kg frente a la semana pasada'),
    slide('Próxima semana', report.sentence, [], report.next >= weekId(ctx.now()) && ctx.data.programs.some(row => row.active) ? 'Planear mis días' : '')
  ], () => changeWeekPlan(ctx, report.next));
}

function periodBounds(now, kind, previous) {
  const date = new Date(now);
  let year = date.getFullYear(), index = date.getMonth();
  if (kind === 'year') {
    if (previous) year--;
    return [year + '-01-01', year + '-12-31'];
  }
  const from = new Date(year, index - Number(previous), 1);
  return [localDate(from), localDate(new Date(from.getFullYear(), from.getMonth() + 1, 0))];
}

export function openPeriodStory(ctx, kind, previous = false) {
  const [from, end] = periodBounds(ctx.now(), kind, previous);
  const now = localDate(ctx.now());
  const report = periodSummary(ctx.data, from, end < now ? end : now);
  const name = kind === 'year' ? from.slice(0, 4) + ' en Forja' : month(from) + ' en Forja';
  const total = slide(quantity(report.count, 'entreno'), quantity(report.minutes, 'minuto') + ' forjando.',
    kind === 'month' ? [line('Mes anterior', report.previousCount + ' entrenos · ' + report.previousMinutes + ' min')] : []);
  const recordSlide = slide(quantity(report.records.length, 'récord'), report.records.length ? '' : noRecords, recordLines(ctx, report.records));
  const gainSlide = slide('Subiste la fuerza', report.gains.length ? '' : 'Faltan marcas comparables.', gains(ctx, report.gains, kind === 'year' ? 5 : 3));
  const high = report.trained[0], low = report.trained.at(-1);
  story(name, kind === 'year' ? [
    total, slide('El mejor mes', report.bestMonth ? month(report.bestMonth.month + '-01') + ' · ' + quantity(report.bestMonth.count, 'entreno') : 'Sin entrenos registrados.'),
    recordSlide, gainSlide, slide('Peso corporal', report.weightChange == null ? 'Faltan pesajes para comparar.' : signed(report.weightChange) + ' kg en el año'),
    slide('Tu ejercicio del año', report.favorite ? lift(ctx, report.favorite.exerciseId) + ' · ' + quantity(report.favorite.sessions, 'entreno') : 'Sin series registradas.')
  ] : [
    total, recordSlide, gainSlide, slide('Músculos del mes', high.sets ? 'Más trabajado · ' + muscles[high.key] + '. Menos trabajado · ' + muscles[low.key] + '.' : 'Sin series efectivas.', high.sets ? doses([high, low]) : []),
    slide('La serie más pesada', report.heaviest ? lift(ctx, report.heaviest.exerciseId) + ' · ' + loadText(report.heaviest.weight, report.heaviest.unit) + ' × ' + report.heaviest.reps : 'Sin series registradas con peso.'),
    slide(quantity(report.consistentWeeks, 'semana'), 'Con 3 entrenos o más.')
  ]);
}

function story(name, slides, onAction) {
  let index = 0, timer;
  const dialog = sheet(name, '<div class="story-bg"></div><div class="bars2" aria-hidden="true"></div>'
    + '<div data-slide class="slide" aria-live="polite"></div><button class="tapl" data-prev aria-label="Anterior"></button>'
    + '<button class="tapr" data-next aria-label="Siguiente"></button>', root => {
    root.classList.add('story');
    const show = () => {
      clearTimeout(timer);
      const current = slides[index];
      $('.bars2', root).innerHTML = slides.map((_, i) => '<span class="' + (i < index ? 'seen' : i === index ? 'cur' : '') + '"><i></i></span>').join('');
      $('[data-slide]', root).innerHTML = '<p class="k">' + esc(name) + '</p><h3 class="h">' + esc(current.title) + '</h3><p class="p">'
        + esc(current.copy) + '</p><div class="list2">' + current.rows.map(([label, value]) =>
          '<div><span>' + esc(label) + '</span><strong>' + esc(value) + '</strong></div>').join('') + '</div>'
        + (current.action ? '<button class="primary" data-story-action>' + esc(current.action) + '</button>' : '');
      on(root, '[data-story-action]', () => { clearTimeout(timer); onAction?.(); });
      if (!current.action) timer = setTimeout(moveNext, 5000);
    };
    const moveNext = () => { if (index + 1 === slides.length) closeSheet(); else { index++; show(); } };
    const moveBack = () => { index = Math.max(0, index - 1); show(); };
    const keyboard = event => {
      if (event.key === 'ArrowLeft') moveBack();
      if (event.key === 'ArrowRight') moveNext();
    };
    root.addEventListener('keydown', keyboard);
    const cleanup = () => {
      clearTimeout(timer);
      root.removeEventListener('keydown', keyboard);
      root.removeEventListener('close', cleanup);
      root.removeEventListener('forja-sheet-replace', cleanup);
      root.classList.remove('story');
    };
    root.addEventListener('close', cleanup, {once: true});
    root.addEventListener('forja-sheet-replace', cleanup, {once: true});
    on(root, '[data-next]', moveNext);
    on(root, '[data-prev]', moveBack);
    show();
  });
  $('[data-close]', dialog)?.focus();
}

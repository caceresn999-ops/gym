import {number} from '../engine.js';
import {programWeekAt, weekId} from '../coach.js';
import {weighIns, weightRate} from '../metrics.js';
import {activeProgram, bodySheet, dateText, esc, icon, on, signed, title} from './common.js';
import {bindProgram, programView} from './program-ui.js';
import {chartView} from './progress.js';
import {openPeriodStory} from './story.js';

const pages = {programa: 'Programa', peso: 'Peso corporal', medidas: 'Medidas', gimnasios: 'Gimnasios y máquinas',
  biblioteca: 'Biblioteca de ejercicios', ajustes: 'Ajustes', acerca: 'Acerca de'};
const measures = {waist: 'Cintura', arm: 'Brazo', chest: 'Pecho', thigh: 'Muslo'};
const back = '<a href="#perfil" class="back">‹ Perfil</a>';
const row = (href, badge, name, meta = '') => '<a class="li" href="#perfil/' + href + '"><span class="ic" aria-hidden="true">' + badge
  + '</span><div class="grow"><div class="name">' + name + '</div>' + (meta ? '<div class="meta">' + esc(meta) + '</div>' : '')
  + '</div><span class="chev">›</span></a>';

export function profileView(ctx) {
  const data = ctx.data, program = activeProgram(data), week = program && programWeekAt(data, program, weekId(ctx.now()));
  const weights = weighIns(data.body), weight = weights.at(-1), rate = weightRate(data.body, ctx.now());
  const section = ctx.subroute;
  if (!Object.hasOwn(pages, section)) {
    return title(ctx, 'Perfil') + '<div class="list">'
      + row('programa', icon('book-open'), pages.programa, program ? program.name + ' · Semana ' + week.n + ' de ' + program.weeks.length : 'Sin programa activo')
      + row('peso', 'kg', pages.peso, weight ? number(weight.weight, 1, 1) + ' kg' + (rate == null ? '' : ' · ' + signed(rate) + ' kg/mes') : 'Sin pesajes')
      + row('medidas', 'cm', pages.medidas, 'Cintura, brazo, pecho, muslo')
      + row('gimnasios', icon('dumbbell'), pages.gimnasios)
      + row('biblioteca', icon('list'), pages.biblioteca)
      + row('ajustes', icon('settings'), pages.ajustes, 'Sincronización, descanso, volumen')
      + row('acerca', '<img class="mini-logo" src="./icons/forja.svg" alt="">', pages.acerca, 'Forja')
      + '</div><h2>Resúmenes</h2><div class="list"><button class="li" data-annual><span class="ic">' + icon('flame')
      + '</span><strong class="grow">Resumen anual</strong><span class="chev">›</span></button></div>';
  }
  const top = back + title(ctx, pages[section]);
  if (section === 'peso') return top + '<button class="primary full" data-weigh>Registrar peso</button>'
    + '<div class="card body-card">' + chartView(weights.map(row => ({date: row.date, value: row.weight})), 'Peso corporal', 'kg')
    + (rate == null ? '' : '<p class="muted">Ritmo de 28 días · ' + signed(rate) + ' kg/mes</p>') + '</div>'
    + (weights.length ? '<h2>Historial</h2><div class="list">' + weights.toReversed().map(row =>
      '<div class="li"><span class="grow">' + esc(dateText(row.date)) + (row.estimado ? ' · estimado' : '') + '</span>'
      + '<strong>' + number(row.weight, 1, 1) + ' kg</strong></div>').join('') + '</div>' : '');
  if (section === 'medidas') return top + '<button class="primary full" data-measures>Registrar medidas</button>'
    + Object.entries(measures).map(([key, name]) => '<h2>' + name + '</h2><div class="card">' + chartView(data.body.filter(row => row[key] > 0)
      .sort((a, b) => a.date.localeCompare(b.date)).map(row => ({date: row.date, value: row[key]})), name, 'cm') + '</div>').join('');
  if (section === 'acerca') return top + '<div class="card stack"><div class="brand"><img class="logo" src="./icons/forja.svg" alt="">Forja</div>'
    + '<p class="muted">Registra tus series y revisa tu progreso. Tu historial se guarda en este dispositivo. Puedes activar la sincronización en Ajustes.</p></div>';
  return top + programView(ctx);
}

export function bindProfile(ctx) {
  on(ctx.root, '[data-weigh]', () => bodySheet(ctx));
  on(ctx.root, '[data-measures]', () => bodySheet(ctx, true));
  on(ctx.root, '[data-annual]', () => openPeriodStory(ctx, 'year'));
  if (['programa', 'gimnasios', 'biblioteca', 'ajustes'].includes(ctx.subroute)) bindProgram(ctx);
}

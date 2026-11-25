import {localDate, asDate} from '../metrics.js';
import {muscles, range, rirRange, number} from '../engine.js';

const replacements = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => replacements[char]);
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const icon = (name, small = false) => '<svg class="icon' + (small ? ' small' : '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
export const disclosure = (content, extra = '') => '<summary' + extra + '><span>' + content + '</span>' + icon('chevron-right', true) + '</summary>';
export const iconButton = (name, label, attrs = '') => '<button type="button" class="icon-button" aria-label="' + esc(label) + '" ' + attrs + '>' + icon(name) + '</button>';
export const sample = ctx => ctx.mode ? '<span class="chip mock-caption">Datos de ejemplo</span>' : '';
export const title = (ctx, name, right = '') => '<header class="screen-heading"><h1>' + esc(name) + '</h1>' + right + '</header>' + sample(ctx);
export const loadText = (weight, unit, showUnit = true) => weight == null ? '—' : weight === 0 ? 'PC'
  : number(weight, unit === 'pila' ? 0 : 2) + (unit && showUnit ? ' ' + unit : '');
export const timeText = ms => new Intl.DateTimeFormat('es-VE', {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(new Date(ms));
export const dateText = (date, opts = {weekday: 'short', day: 'numeric', month: 'short'}) => new Intl.DateTimeFormat('es-VE', opts).format(asDate(date)).replaceAll('.', '').replace(' de ', ' ').replace(', ', ' ');
export const timestampInput = timestamp => localDate(timestamp) + 'T' + timeText(timestamp);
export const clock = seconds => {
  const s = Math.max(0, Math.floor(seconds));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
export const signed = value => (value >= 0 ? '+' : '−') + number(Math.abs(value));
export const activeProgram = data => data.programs.find(row => row.active);
export const currentWeek = (data, program = activeProgram(data)) => program?.weeks.find(row => row.n === data.options.activeWeek) ?? program?.weeks[0];
export const activeSession = data => data.sessions.filter(row => !row.end).sort((a, b) => b.start - a.start)[0];
export const lastBody = data => data.body.filter(row => row.weight > 0).sort((a, b) => b.date.localeCompare(a.date))[0];
export const byId = (list, id) => list.find(item => item.id === id);
export const routine = (session, data) => session.dayName
  || byId(data.programs, session.programId)?.weeks.find(week => week.n === session.week)?.days[session.dayIndex]?.name || 'Entrenamiento';
export const kindName = kind => ({intro: 'Introducción', deload: 'Descarga', normal: 'Normal'})[kind] ?? 'Normal';
export const phaseName = kind => ({volumen: 'volumen', deficit: 'déficit', mantenimiento: 'mantenimiento'})[kind] ?? '';
export const techniques = {working: 'Normal', warmup: 'Calentamiento', drop: 'Drop', parcial: 'Parcial', myo: 'Myo-reps', aguante: 'Aguante estático'};
export const techniqueName = key => techniques[key === 'parciales' ? 'parcial' : key];
export const prescribed = slot => slot.sets + ' × ' + range(slot.repMin, slot.repMax) + ' · RIR ' + (rirRange(slot) || '0');

export function machineText(data, machine, bodyweight = false) {
  if (bodyweight) {
    const gym = byId(data.gyms, machine?.gymId)?.name;
    return gym ? gym + ' · peso corporal' : 'Peso corporal';
  }
  if (!machine) return 'Elegir máquina';
  return [byId(data.gyms, machine.gymId)?.name, machine.name, machine.unit === 'pila' ? 'pila (' + number(machine.increment) + ')' : machine.unit].filter(Boolean).join(' · ');
}

export function on(root, selector, listener, event = 'click') {
  for (const node of $$(selector, root)) {
    node.addEventListener(event, async e => {
      try { await listener(node, e); }
      catch (error) { document.dispatchEvent(new CustomEvent('gym-error', {detail: error})); }
    });
  }
}

let closingSheet;

export function sheet(name, content, bind) {
  const dialog = $('#sheet');
  closingSheet = null;
  delete dialog.dataset.closing;
  dialog.innerHTML = '<header class="row sheet-heading"><h2 id="sheet-title">' + esc(name) + '</h2>'
    + iconButton('x', 'Cerrar', 'data-close') + '</header>' + content;
  on(dialog, '[data-close]', closeSheet);
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  bind?.(dialog);
  return dialog;
}
export function closeSheet() {
  const dialog = $('#sheet');
  if (!dialog.open || Object.hasOwn(dialog.dataset, 'closing')) return;
  if (document.hidden) return dialog.close();
  dialog.dataset.closing = '';
  const exit = dialog.getAnimations?.().find(animation => animation.animationName === 'sheet-out');
  if (!exit) return dialog.close();
  closingSheet = exit;
  const finish = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    if (closingSheet === exit) {
      closingSheet = null;
      dialog.close();
    }
  };
  const onVisibility = () => { if (document.hidden) finish(); };
  document.addEventListener('visibilitychange', onVisibility);
  exit.finished.then(finish, finish);
}
export function formSheet(name, fields, save, action = 'Guardar') {
  return sheet(name, '<form class="stack">' + fields + '<button class="primary full">' + esc(action) + '</button></form>', root => {
    on(root, 'form', async (form, event) => {
      event.preventDefault();
      const button = $('button[type=submit], button:not([type])', form);
      if (button) button.disabled = true;
      try { await save(Object.fromEntries(new FormData(form))); }
      finally { if (button) button.disabled = false; }
    }, 'submit');
  });
}
export const field = (label, name, value = '', attrs = '') => '<label class="label">' + esc(label) + '<input name="' + esc(name) + '" value="' + esc(value) + '" ' + attrs + '></label>';
export const select = (label, name, choices, value) => '<label class="label">' + esc(label) + '<select name="' + esc(name) + '">' + choices
  .map(([key, item]) => '<option value="' + esc(key) + '"' + (String(key) === String(value ?? '') ? ' selected' : '') + '>' + esc(item) + '</option>').join('') + '</select></label>';
export const checkbox = (label, name, checked) => '<label class="toggle"><input type="checkbox" name="' + esc(name) + '"' + (checked ? ' checked' : '') + '> ' + esc(label) + '</label>';
export const decimal = value => String(value ?? '').trim() === '' ? null : Number(String(value).replace(',', '.'));
export const requiredNumber = (value, label, min = 0) => {
  const parsed = decimal(value);
  if (parsed === null || !Number.isFinite(parsed) || parsed < min) throw Error('Revisa ' + label + ' e ingresa un número válido.');
  return parsed;
};

export function muscleFields(values, prefix = 'muscle-') {
  return '<div class="muscle-picks">' + Object.entries(muscles).map(([key, name]) =>
    '<fieldset class="muscle-group"><legend>' + name + '</legend><div class="actions">' + [[0, 'Sin asignar'], [1, 'Principal'], [.5, 'Secundario']].map(([value, label]) =>
      '<label class="muscle-choice"><input type="radio" name="' + prefix + key + '" value="' + value + '"'
      + ((values[key] ?? 0) === value ? ' checked' : '') + '><span class="chip">' + label + '</span></label>').join('')
    + '</div></fieldset>').join('') + '</div>';
}
export const readMuscles = (values, prefix = 'muscle-') => Object.fromEntries(Object.keys(muscles)
  .map(key => [key, Number(values[prefix + key])]).filter(([, value]) => value === 1 || value === .5));

export function bodySheet(ctx, measurement = false, session = null) {
  const today = localDate(ctx.now()), last = lastBody(ctx.data);
  const fields = measurement
    ? ['Cintura', 'Brazo', 'Pecho', 'Muslo'].map((label, i) => field(label + ' (cm)', ['waist', 'arm', 'chest', 'thigh'][i],
      ctx.data.body.find(row => row.date === today)?.[['waist', 'arm', 'chest', 'thigh'][i]], 'inputmode="decimal"')).join('')
    : field('Peso corporal (kg)', 'weight', session?.bodyweight ?? last?.weight, 'inputmode="decimal" required');
  formSheet(measurement ? 'Registrar medidas' : 'Peso corporal',
    (session ? '' : field('Fecha', 'date', today, 'type="date" required max="' + today + '"')) + fields, async values => {
      const date = session?.date ?? values.date;
      const existing = ctx.data.body.find(row => row.date === date);
      const body = {id: existing?.id, date};
      for (const [key, value] of Object.entries(values)) {
        if (key !== 'date' && String(value).trim()) body[key] = requiredNumber(value, key === 'weight' ? 'el peso' : 'las medidas', .01);
      }
      if (Object.keys(body).length < 3) throw Error('Ingresa al menos una medida para guardarla.');
      const changes = [['body', body]];
      if (session) changes.push(['sessions', {id: session.id, bodyweight: body.weight}]);
      await ctx.save(changes);
      closeSheet();
    });
}

export function downloadCsv(name, records, columns) {
  const cell = value => {
    let text = value == null ? '' : String(value);
    if (typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const content = [columns.join(','), ...records.map(row => columns.map(key => cell(row[key])).join(','))].join('\r\n');
  downloadFile(name, '\uFEFF' + content, 'text/csv;charset=utf-8');
}

export function downloadFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

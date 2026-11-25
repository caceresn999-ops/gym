import {option} from '../db.js';
import {exportSnapshot, restoreChanges} from '../db.js';
import {muscles, number, quantity} from '../engine.js';
import {coachSettings, programWeekAt, weekId, workingSets} from '../coach.js';
import {localDate} from '../metrics.js';
import {prepareProgram, programResumeChanges} from '../program.js';
import {$, activeProgram, byId, checkbox, closeSheet, dateText, decimal, disclosure, downloadCsv, downloadFile, esc, field, formSheet, icon, kindName,
  machineText, on, phaseName, prescribed, requiredNumber, select, sheet, timeText} from './common.js';
import {exerciseEditor, gymEditor, machineEditor} from './library.js';
import {anchorWeek, cycleView} from './coach-ui.js';

let editor = null, editorWeek = 0;
const types = [['normal', 'Normal'], ['intro', 'Introducción'], ['deload', 'Descarga']];
const defaultSlot = exerciseId => ({exerciseId, substitutes: [], warmups: 0, sets: 2, repMin: 6, repMax: 8, rir: [1, 0],
  restMin: 1, restMax: 2, technique: null, notes: ''});
const initialProgram = data => ({name: '', sessionsPerWeek: 3, targets: {}, weeks: [{n: 1, kind: 'normal', days: [
  {name: 'Día 1', slots: [defaultSlot(data.exercises[0]?.id ?? '')]}
]}]});

export function pickProgram(ctx) {
  sheet('Importar programa', '<form class="stack"><label class="label">Plantilla JSON<input name="program" type="file" accept=".json,application/json" required></label>'
    + '<button type="submit" class="primary">Importar y activar</button></form>', root => on(root, 'form', async (form, event) => {
    event.preventDefault();
    const input = $('[name="program"]', root);
    let source;
    try { source = JSON.parse(await input.files[0].text()); }
    catch { throw Error('No se pudo leer la plantilla. Selecciona un JSON válido.'); }
    const {program, changes} = prepareProgram(source, ctx.data);
    const exercises = [...ctx.data.exercises, ...changes.filter(([entity]) => entity === 'exercises').map(([, row]) => row)];
    const position = source.resume ? programResumeChanges(program, source.resume, {...ctx.data, exercises})
      : selectWeek(ctx, program, program.weeks[0].n);
    await ctx.save([...changes, ...position]);
    closeSheet();
    ctx.notice('Programa importado y activado.');
  }, 'submit'));
}

const selectWeek = (ctx, program, n) => [option('activeWeek', n), anchorWeek(ctx.now(), program.id, n), option('selectedDay', null)];

function weekPicker(ctx, program, week) {
  sheet('Cambiar semana', '<ul class="plain-list">' + program.weeks.map(row => '<li><button type="button" class="list-button row" data-new-week="'
    + row.n + '"><span>Semana ' + row.n + ' · ' + kindName(row.kind) + '</span>' + (row.n === week.n ? icon('check', true) : '') + '</button></li>').join('') + '</ul>',
  root => on(root, '[data-new-week]', async node => { await ctx.save(selectWeek(ctx, program, Number(node.dataset.newWeek))); closeSheet(); }));
}

function phaseEditor(ctx, phase) {
  formSheet('Fase', select('Fase', 'kind', [['volumen', 'Volumen'], ['deficit', 'Déficit'], ['mantenimiento', 'Mantenimiento']], phase?.kind ?? 'mantenimiento')
    + field('Desde', 'start', phase?.start ?? localDate(ctx.now()), 'type="date" required'), async values => {
    const existing = ctx.data.phases.find(row => row.start === values.start);
    await ctx.save([['phases', {id: existing?.id ?? (phase && values.start <= phase.start ? phase.id : undefined), kind: values.kind, start: values.start}]]);
    closeSheet();
  });
}

function slotFields(ctx, slot, day, index) {
  const prefix = 's-' + day + '-' + index + '-';
  const choices = [['', 'Elige un ejercicio'], ...ctx.data.exercises.map(row => [row.id, row.name])];
  const subs = new Set(slot.substitutes ?? []);
  return '<details>' + disclosure(esc(byId(ctx.data.exercises, slot.exerciseId)?.name ?? 'Ejercicio ' + (index + 1))) + '<div class="stack">'
    + select('Ejercicio', prefix + 'exerciseId', choices, slot.exerciseId)
    + '<div class="cols">' + field('Series', prefix + 'sets', slot.sets, 'type="number" min="1" max="25" required')
    + field('Calentamientos', prefix + 'warmups', slot.warmups, 'type="number" min="0" max="20" required')
    + field('Reps mínimas', prefix + 'repMin', slot.repMin, 'type="number" min="1" required')
    + field('Reps máximas', prefix + 'repMax', slot.repMax, 'type="number" min="1" required')
    + field('Descanso mín. (min)', prefix + 'restMin', slot.restMin, 'inputmode="decimal"')
    + field('Descanso máx. (min)', prefix + 'restMax', slot.restMax, 'inputmode="decimal"') + '</div>'
    + field('RIR por serie (ej. 1, 0)', prefix + 'rir', slot.rir.join(', '), 'required')
    + select('Técnica de última serie', prefix + 'technique', [['', 'Ninguna'], ['drop', 'Drop'], ['parciales', 'Parciales'], ['myo', 'Myo-reps'], ['aguante', 'Aguante estático']], slot.technique)
    + field('Notas', prefix + 'notes', slot.notes)
    + '<details>' + disclosure('Sustitutos') + ctx.data.exercises.map(row => checkbox(row.name, prefix + 'sub-' + row.id, subs.has(row.id))).join('') + '</details>'
    + '<button type="button" data-remove-slot="' + day + ',' + index + '">Quitar ejercicio del día</button></div></details>';
}

function editView(ctx) {
  const week = editor.weeks[editorWeek];
  return '<form class="stack-lg program-editor" data-program-editor><div class="row wrap"><h2>' + (editor.id ? 'Editar programa' : 'Crear programa') + '</h2>'
    + '<button type="button" data-cancel-editor>Cancelar</button></div><section class="stack">'
    + field('Nombre', 'name', editor.name, 'required') + field('Sesiones por semana', 'sessionsPerWeek', editor.sessionsPerWeek, 'type="number" min="1" max="21" required')
    + '<details>' + disclosure('Metas semanales por músculo') + '<div class="cols">'
    + Object.entries(muscles).map(([key, name]) => field(name, 'target-' + key, editor.targets[key] ?? 0, 'inputmode="decimal"')).join('') + '</div></details></section>'
    + '<section class="section"><div class="row wrap"><h2>Semanas</h2><button type="button" data-add-week>Duplicar semana</button></div>'
    + select('Semana en edición', 'editWeek', editor.weeks.map((row, i) => [i, 'Semana ' + row.n]), editorWeek)
    + select('Tipo de semana', 'kind', types, week.kind)
    + (editor.weeks.length > 1 ? '<button type="button" data-remove-week>Quitar semana</button>' : '') + '</section>'
    + '<section class="section"><div class="row wrap"><h2>Días</h2><button type="button" data-new-exercise>Nuevo ejercicio en la biblioteca</button></div>'
    + week.days.map((day, i) => '<div class="editor-item stack">' + field('Nombre del día', 'day-' + i, day.name, 'required')
      + day.slots.map((slot, j) => slotFields(ctx, slot, i, j)).join('')
      + '<div class="actions"><button type="button" data-add-slot="' + i + '">Añadir ejercicio</button>'
      + (week.days.length > 1 ? '<button type="button" data-remove-day="' + i + '">Quitar día</button>' : '') + '</div></div>').join('')
    + '<button type="button" data-add-day>Añadir día</button></section>'
    + '<button type="submit" class="primary">Guardar y activar programa</button></form>';
}

function storeEditor(form) {
  const values = Object.fromEntries(new FormData(form));
  editor.name = values.name;
  editor.sessionsPerWeek = values.sessionsPerWeek;
  editor.targets = Object.fromEntries(Object.keys(muscles).map(key => [key, decimal(values['target-' + key]) ?? 0]));
  const week = editor.weeks[editorWeek];
  week.kind = values.kind;
  week.days.forEach((day, i) => {
    day.name = values['day-' + i];
    day.slots.forEach((slot, j) => {
      const key = 's-' + i + '-' + j + '-';
      for (const field of ['exerciseId', 'sets', 'warmups', 'repMin', 'repMax', 'technique', 'notes']) slot[field] = values[key + field];
      for (const field of ['restMin', 'restMax']) slot[field] = decimal(values[key + field]);
      slot.rir = values[key + 'rir'].split(/[\s,;]+/).filter(Boolean).map(value => value === '3+' ? 3 : Number(value));
      slot.substitutes = Object.keys(values).filter(name => name.startsWith(key + 'sub-')).map(name => name.slice((key + 'sub-').length));
    });
  });
  return week;
}

function bindEditor(ctx) {
  const form = $('[data-program-editor]', ctx.root);
  const action = (selector, fn, type = 'click') => on(form, selector, async node => {
    const week = storeEditor(form);
    await fn(week, node);
    ctx.render();
  }, type);
  action('[data-add-week]', week => {
    editor.weeks.push({...structuredClone(week), n: Math.max(...editor.weeks.map(row => row.n)) + 1}); editorWeek = editor.weeks.length - 1;
  });
  action('[data-remove-week]', () => { editor.weeks.splice(editorWeek, 1); editorWeek = Math.max(0, editorWeek - 1); });
  action('[name="editWeek"]', (_, node) => { editorWeek = Number(node.value); }, 'change');
  action('[data-add-day]', week => week.days.push({name: 'Día ' + (week.days.length + 1), slots: [defaultSlot(ctx.data.exercises[0]?.id ?? '')]}));
  action('[data-remove-day]', (week, node) => week.days.splice(Number(node.dataset.removeDay), 1));
  action('[data-add-slot]', (week, node) => week.days[Number(node.dataset.addSlot)].slots.push(defaultSlot(ctx.data.exercises[0]?.id ?? '')));
  action('[data-remove-slot]', (week, node) => {
    const [i, j] = node.dataset.removeSlot.split(',').map(Number);
    week.days[i].slots.splice(j, 1);
  });
  on(form, '[data-new-exercise]', () => {
    storeEditor(form);
    exerciseEditor(ctx, null, exercise => {
      const blank = editor.weeks[editorWeek].days.flatMap(day => day.slots).find(slot => !slot.exerciseId);
      if (blank) blank.exerciseId = exercise.id;
      closeSheet();
      ctx.render();
    });
  });
  on(form, '[data-cancel-editor]', () => { editor = null; ctx.render(); });
  on(ctx.root, '[data-program-editor]', async (_, event) => {
    event.preventDefault();
    storeEditor(form);
    const {program, changes} = prepareProgram(editor, ctx.data);
    await ctx.save([...changes, ...selectWeek(ctx, program, program.weeks[editorWeek].n)], {render: false});
    editor = null;
    ctx.render();
    ctx.notice('Programa guardado.');
  }, 'submit');
}

function exerciseList(ctx) {
  const assigned = row => Number(Object.keys(row.muscles ?? {}).length > 0);
  const sorted = [...ctx.data.exercises].sort((a, b) => assigned(a) - assigned(b) || a.name.localeCompare(b.name));
  return '<div class="stack"><button type="button" data-ex-add>Nuevo ejercicio</button>'
    + (sorted.length ? '<ul class="plain-list">' + sorted.map(row => '<li><button type="button" class="list-button row" data-ex-edit="' + esc(row.id)
      + '"><span><strong>' + esc(row.name) + '</strong><br><small class="muted">' + (Object.entries(row.muscles ?? {}).map(([key, weight]) =>
      muscles[key] + (weight === .5 ? ' (sec.)' : '')).join(' · ') || 'Sin músculos asignados') + '</small></span>' + icon('chevron-right', true) + '</button></li>').join('') + '</ul>'
      : '<p class="empty">Los ejercicios aparecen aquí después de importar un historial o programa.</p>') + '</div>';
}

function settings(ctx) {
  const options = ctx.data.options;
  const coach = coachSettings(options);
  return '<section class="section" id="ajustes"><form class="stack" data-settings>'
    + field('Nombre', 'name', options.name ?? 'Nicolás', 'autocomplete="given-name"')
    + field('URL de sincronización', 'syncUrl', options.syncUrl, 'type="url" inputmode="url" autocomplete="off"')
    + field('Token', 'syncToken', options.syncToken, 'type="password" autocomplete="off"')
    + field('Descanso predeterminado (s)', 'defaultRest', options.defaultRest ?? 90, 'type="number" min="0" max="3600" required')
    + checkbox('Mantener pantalla encendida', 'keepAwake', options.keepAwake !== false)
    + checkbox('Sonido al terminar el descanso', 'sound', options.sound !== false)
    + checkbox('Volumen autorregulado', 'autoVolume', coach.autoVolume)
    + field('Tope de series de trabajo por sesión', 'sessionSetCap', coach.sessionSetCap, 'type="number" min="1" step="1" required')
    + field('Tope de series efectivas por músculo y sesión', 'muscleSessionCap', coach.muscleSessionCap, 'type="number" min="1" step=".5" required')
    + '<details>' + disclosure('Máximo volumen recuperable (MRV)') + '<div class="cols">'
    + Object.entries(muscles).map(([key, name]) => field(name, 'mrv-' + key, coach.mrv[key], 'type="number" min="2" step="1" required')).join('') + '</div></details>'
    + '<button type="submit">Guardar ajustes</button></form>'
    + '<p class="muted" data-sync-status>Última sincronización: ' + (options.lastSync ? esc(dateText(options.lastSync) + ' · ' + timeText(options.lastSync)) : '—')
    + ' · ' + ctx.data.pending + ' pendientes</p><div class="actions"><button type="button" data-sync>Sincronizar ahora</button>'
    + '<button type="button" data-restore>Restaurar desde Google</button><button type="button" data-export>Exportar CSV</button>'
    + '<button type="button" data-backup>Exportar copia de datos</button><button type="button" data-import-backup>Restaurar copia de datos</button>'
    + '<button type="button" data-import-history>Importar historial (Setgraph)</button></div></section>';
}

function gymsView(ctx) {
    + '<section class="section"><h2>Gimnasios y máquinas</h2><div class="actions"><button type="button" data-new-gym>Nuevo gimnasio</button>'
    + '<button type="button" data-new-machine>Nueva máquina</button></div><ul class="plain-list">'
    + ctx.data.gyms.map(gym => '<li><button type="button" class="list-button" data-gym-edit="' + esc(gym.id) + '"><strong>' + esc(gym.name)
      + '</strong> <small class="muted">Editar gimnasio</small></button><ul class="plain-list">' + ctx.data.machines.filter(row => row.gymId === gym.id).map(row =>
      '<li><button type="button" class="list-button row" data-machine-edit="' + esc(row.id) + '"><span>' + esc(row.name) + '<br><small class="muted">'
        + esc(row.unit) + ' · salto ' + number(row.increment) + ' · ' + number(row.min ?? 0) + (row.max == null ? ' en adelante' : '–' + number(row.max)) + '</small></span>'
        + icon('chevron-right', true) + '</button></li>').join('') + '</ul></li>').join('')
    + '</ul></section>';
}

export function programView(ctx) {
  const program = activeProgram(ctx.data), week = programWeekAt(ctx.data, program, weekId(ctx.now()));
  const phase = [...ctx.data.phases].sort((a, b) => b.start.localeCompare(a.start))[0];
  if (ctx.subroute === 'ajustes') return settings(ctx);
  if (ctx.subroute === 'gimnasios') return gymsView(ctx);
  if (ctx.subroute === 'biblioteca') return exerciseList(ctx);
  if (editor) return editView(ctx);
  return '<div class="stack-lg">' + cycleView(ctx, program) + '<section class="section">' + (program
    ? '<h2>' + esc(program.name) + '</h2><p class="muted">Bloque ' + (week.n <= 6 ? '1' : '2') + ' · Semana ' + week.n + ' de ' + program.weeks.length
      + (week.kind !== 'normal' ? ' · ' + kindName(week.kind) : '') + '</p><div class="actions"><button type="button" data-change-week>Cambiar semana</button>'
      + '<button type="button" data-edit-program>Editar programa</button></div><ul class="plain-list">' + week.days.map(day =>
      '<li><details>' + disclosure(esc(day.name) + '<small class="muted">' + quantity(day.slots.length, 'ejercicio') + ' · '
        + quantity(day.slots.reduce((sum, slot) => sum + workingSets(slot), 0), 'serie') + '</small>', ' class="program-day"')
        + '<ul class="plain-list">' + day.slots.map(slot => '<li class="row"><span>'
        + esc(byId(ctx.data.exercises, slot.exerciseId)?.name) + '</span><small class="muted">' + esc(prescribed(slot)) + '</small></li>').join('') + '</ul></details></li>').join('') + '</ul>'
    : '<h2>Sin programa activo</h2><p class="muted">Importa una plantilla o crea tu rutina.</p>')
    + '<div class="actions"><button type="button" data-import-program>Importar programa</button><button type="button" data-create-program>Crear programa</button></div>'
    + (ctx.data.programs.some(row => !row.active) ? '<details>' + disclosure('Otros programas') + '<ul class="plain-list">'
      + ctx.data.programs.filter(row => !row.active).map(row => '<li><button type="button" class="list-button" data-activate="' + esc(row.id) + '">Activar ' + esc(row.name) + '</button></li>').join('') + '</ul></details>' : '')
    + '</section><section class="section"><div class="row"><h2>Fase</h2><button type="button" data-phase>' + (phase ? 'Cambiar fase' : 'Registrar fase') + '</button></div>'
    + '<p class="muted">' + (phase ? phaseName(phase.kind) + ' desde ' + esc(dateText(phase.start, {day: 'numeric', month: 'short', year: 'numeric'})) : 'Sin fase registrada') + '</p></section>' + '</div>';
}

export function bindProgram(ctx) {
  if (editor && ctx.subroute === 'programa') return bindEditor(ctx);
  const root = ctx.root, program = activeProgram(ctx.data), week = programWeekAt(ctx.data, program, weekId(ctx.now()));
  on(root, '[data-change-week]', () => weekPicker(ctx, program, week));
  on(root, '[data-import-program]', () => pickProgram(ctx));
  on(root, '[data-create-program]', () => { editor = initialProgram(ctx.data); editorWeek = 0; ctx.render(); window.scrollTo(0, 0); });
  on(root, '[data-edit-program]', () => { editor = structuredClone(program); editorWeek = program.weeks.indexOf(week); ctx.render(); window.scrollTo(0, 0); });
  on(root, '[data-activate]', async node => {
    const row = byId(ctx.data.programs, node.dataset.activate);
    await ctx.save([...ctx.data.programs.map(item => ['programs', {id: item.id, active: item.id === row.id}]),
      ...selectWeek(ctx, row, row.weeks[0].n)]);
  });
  on(root, '[data-phase]', () => phaseEditor(ctx, [...ctx.data.phases].sort((a,b) => b.start.localeCompare(a.start))[0]));
  on(root, '[data-ex-add]', () => exerciseEditor(ctx));
  on(root, '[data-ex-edit]', node => exerciseEditor(ctx, byId(ctx.data.exercises, node.dataset.exEdit)));
  on(root, '[data-new-gym]', () => gymEditor(ctx));
  on(root, '[data-gym-edit]', node => gymEditor(ctx, byId(ctx.data.gyms, node.dataset.gymEdit)));
  on(root, '[data-new-machine]', () => machineEditor(ctx));
  on(root, '[data-machine-edit]', node => machineEditor(ctx, byId(ctx.data.machines, node.dataset.machineEdit)));
  on(root, '[data-settings]', async (form, event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    if (values.syncUrl && !/^https:\/\//i.test(values.syncUrl)) throw Error('Usa la URL HTTPS del servicio de sincronización.');
    const mrv = Object.fromEntries(Object.keys(muscles).map(key => [key, requiredNumber(values['mrv-' + key], 'el MRV de ' + muscles[key], 2)]));
    await ctx.save([option('name', values.name.trim()), option('syncUrl', values.syncUrl.trim()), option('syncToken', values.syncToken.trim()),
      option('defaultRest', requiredNumber(values.defaultRest, 'el descanso')), option('keepAwake', !!values.keepAwake), option('sound', !!values.sound),
      option('autoVolume', !!values.autoVolume), option('mrv', mrv),
      option('sessionSetCap', requiredNumber(values.sessionSetCap, 'el tope por sesión', 1)),
      option('muscleSessionCap', requiredNumber(values.muscleSessionCap, 'el tope muscular', 1))]);
    ctx.notice('Ajustes guardados.');
  }, 'submit');
  on(root, '[data-sync]', () => ctx.syncNow());
  on(root, '[data-restore]', () => ctx.restore());
  on(root, '[data-backup]', async () => downloadFile('forja-copia.json', JSON.stringify(exportSnapshot(await ctx.backupData()), null, 2), 'application/json;charset=utf-8'));
  on(root, '[data-import-backup]', () => importBackup(ctx));
  on(root, '[data-import-history]', () => ctx.startImport());
  on(root, '[data-export]', () => sheet('Exportar CSV', '<div class="stack"><button type="button" data-file="sets">Descargar series</button>'
    + '<button type="button" data-file="sessions">Descargar sesiones</button></div>', dialog => {
    on(dialog, '[data-file]', node => {
      if (node.dataset.file === 'sets') downloadCsv('forja-series.csv', ctx.data.sets.map(row => ({...row,
        exercise: byId(ctx.data.exercises, row.exerciseId)?.name, machine: byId(ctx.data.machines, row.machineId)?.name})),
      ['id', 'sessionId', 'exerciseId', 'exercise', 'machineId', 'machine', 'weight', 'unit', 'reps', 'rir', 'type', 'ts']);
      else downloadCsv('forja-sesiones.csv', ctx.data.sessions, ['id', 'n', 'date', 'start', 'end', 'dayName', 'bodyweight', 'notes', 'manual']);
    });
  }));
}

function importBackup(ctx) {
  sheet('Restaurar copia de datos', '<form class="stack"><p class="muted">Se incorporarán los registros nuevos y las versiones más recientes.</p>'
    + '<label class="label">Copia de Forja<input type="file" accept=".json,application/json" name="backup" required></label>'
    + '<button type="submit" class="primary">Restaurar</button></form>', dialog => on(dialog, 'form', async (form, event) => {
    event.preventDefault();
    const submit = $('button[type=submit]', form);
    submit.disabled = true;
    try {
      let copy;
      try { copy = JSON.parse(await $('[name=backup]', form).files[0].text()); }
      catch { throw Error('No se pudo leer el archivo. Elige una copia JSON exportada desde Forja.'); }
      if (copy?.version !== 2 || !Array.isArray(copy.rows)) throw Error('El archivo no es una copia de Forja compatible.');
      const changes = restoreChanges(copy.rows);
      if (changes.length !== copy.rows.length) throw Error('La copia contiene registros inválidos. Exporta una copia nueva desde Forja.');
      await ctx.save(changes, {remote: true});
      closeSheet();
      ctx.notice('Copia restaurada.');
    } finally { submit.disabled = false; }
  }, 'submit'));
}

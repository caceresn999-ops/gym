import {option} from '../db.js';
import {plural, quantity} from '../engine.js';
import {discoverMappings, importChanges, importStats, noteGym, parseSessions, parseSetgraph} from '../import.js';
import {$, closeSheet, dateText, decimal, disclosure, esc, field, muscleFields, on, readMuscles, requiredNumber, select, sheet, title} from './common.js';
import {figure} from './plate.js';

export function welcomeView(ctx) {
  return '<section class="welcome stack-lg">' + title(ctx, 'Gym') + '<div class="panel">' + figure() + '</div>'
    + '<div class="stack"><p class="muted">Importa tu historial para consultar tus entrenamientos anteriores.</p>'
    + '<button type="button" class="primary full" data-welcome-import>Importar historial de Setgraph</button>'
    + '<button type="button" class="full" data-welcome-skip>Empezar sin historial</button>'
    + '<button type="button" class="link-button" data-welcome-restore>Restaurar desde Google</button></div></section>';
}

export function bindWelcome(ctx) {
  on(ctx.root, '[data-welcome-import]', () => startImport(ctx));
  on(ctx.root, '[data-welcome-skip]', async node => {
    node.disabled = true;
    try { await ctx.save([option('onboarded', true)]); ctx.go('hoy'); }
    finally { node.disabled = false; }
  });
  on(ctx.root, '[data-welcome-restore]', () => ctx.restore(true));
}

const nav = label => '<div class="cols"><button type="button" data-back>Atrás</button><button type="submit" class="primary">' + label + '</button></div>';

export function startImport(ctx) {
  let rows, metadata, exercises, machines;
  let defaultGym = 'Titanium', gyms = {};
  const exclusions = new Set();
  const fileStep = () => sheet('Importar historial de Setgraph',
    '<form class="stack"><label class="label">CSV de series<input type="file" name="sets" accept=".csv,text/csv" required></label>'
    + '<label class="label">CSV de sesiones (opcional)<input type="file" name="sessions" accept=".csv,text/csv"></label>'
    + '<button type="submit" class="primary">Leer archivos</button></form>', root => {
    on(root, 'form', async (form, event) => {
      event.preventDefault();
      const setFile = $('[name="sets"]', form).files[0], sessionFile = $('[name="sessions"]', form).files[0];
      const button = $('button[type=submit]', form);
      button.disabled = true;
      try {
        rows = parseSetgraph(await setFile.text());
        metadata = parseSessions(sessionFile ? await sessionFile.text() : '');
        if (!rows.length) throw Error('El archivo no tiene series con fecha y ejercicio. Verifica la exportación.');
        exercises = discoverMappings(rows).exercises;
        for (const name of exercises.keys()) {
          const saved = ctx.data.exercises.find(row => row.name.toLowerCase() === name.toLowerCase());
          if (saved) exercises.set(name, {...saved.muscles});
        }
        exclusions.clear();
        for (const item of rows.filter(row => row.suspicious)) exclusions.add(item.index);
        exerciseStep();
      } finally { button.disabled = false; }
    }, 'submit');
  });

  function step(name, content, previous, next, label = 'Continuar') {
    return sheet(name, '<form class="stack">' + content + nav(label) + '</form>', root => {
      on(root, '[data-back]', previous);
      on(root, 'form', async (form, event) => {
        event.preventDefault();
        const submit = $('button[type=submit]', form);
        submit.disabled = true;
        try { await next(Object.fromEntries(new FormData(form))); }
        finally { submit.disabled = false; }
      }, 'submit');
    });
  }

  function exerciseStep() {
    const ordered = [...exercises].sort(([an, a], [bn, b]) =>
      Number(Object.keys(a).length > 0) - Number(Object.keys(b).length > 0) || an.localeCompare(bn));
    step('Ejercicios y músculos', '<p class="muted">Revisa los músculos. Los ejercicios sin asignar aparecen primero.</p>'
      + ordered.map(([name, values], i) => '<details class="editor-item">' + disclosure(esc(name)
        + (!Object.keys(values).length ? ' · Sin músculos asignados' : ''))
        + muscleFields(values, 'm' + i + '-') + '</details>').join(''), fileStep, values => {
      ordered.forEach(([name], i) => exercises.set(name, readMuscles(values, 'm' + i + '-')));
      gymStep();
    });
  }

  function gymStep() {
    const preset = new Set(['Titanium', 'VAC', 'SPORT', ...ctx.data.gyms.map(row => row.name), defaultGym]);
    const hints = [...new Set(rows.map(row => row.note).filter(note => noteGym(note, '') !== ''))].sort();
    step('Gimnasio', '<p class="muted">Las notas con VAC, SPORT o Port se asignan a esos gimnasios. Puedes ajustar cada nota aquí.</p>'
      + field('Gimnasio predeterminado', 'defaultGym', defaultGym, 'required')
      + hints.map((note, i) => select(note, 'g-' + i, [...preset].map(name => [name, name]), gyms[note] ?? noteGym(note, defaultGym))).join(''),
    exerciseStep, values => {
      defaultGym = values.defaultGym.trim();
      if (!defaultGym) throw Error('Ingresa un gimnasio predeterminado.');
      gyms = Object.fromEntries(hints.map((note, i) => [note, values['g-' + i]]));
      const discovered = discoverMappings(rows, defaultGym, gyms).machines;
      for (const [key, value] of discovered) {
        const previous = machines?.get(key);
        if (previous) discovered.set(key, {...previous, flagged: value.flagged});
      }
      machines = discovered;
      machineStep();
    });
  }

  function machineStep() {
    const ordered = [...machines].sort(([, a], [, b]) => Number(b.flagged > 0) - Number(a.flagged > 0)
      || a.exercise.localeCompare(b.exercise) || a.gym.localeCompare(b.gym));
    const unitChoices = [['kg', 'kg'], ['lb', 'lb'], ['pila', 'pila']];
    step('Máquinas y unidades', '<p class="muted">Confirma la máquina y su unidad para cada ejercicio y gimnasio.</p>'
      + ordered.map(([, row], i) => '<details class="editor-item">' + disclosure(esc(row.exercise + ' · ' + row.gym)
        + (row.flagged ? ' <span class="warning">· probablemente libras (' + row.flagged + ')</span>' : '')) + '<div class="stack">'
        + field('Nombre de la máquina', 'name-' + i, row.name, 'required') + select('Unidad', 'unit-' + i, unitChoices, row.unit)
        + '<div class="cols">' + field('Incremento', 'inc-' + i, row.increment, 'inputmode="decimal" required')
        + field('Mínimo', 'min-' + i, row.min, 'inputmode="decimal" required')
        + field('Máximo', 'max-' + i, row.max, 'inputmode="decimal" placeholder="Sin tope"') + '</div></div></details>').join(''),
    gymStep, values => {
      for (const [[key, row], i] of ordered.map((item, i) => [item, i])) {
        const min = requiredNumber(values['min-' + i], 'el mínimo'), max = decimal(values['max-' + i]);
        const name = values['name-' + i].trim();
        if (!name || max != null && (!Number.isFinite(max) || max < min)) throw Error('Revisa el nombre y los límites de ' + row.exercise + '.');
        machines.set(key, {...row, name, min, max, unit: values['unit-' + i], increment: requiredNumber(values['inc-' + i], 'el incremento', .000001)});
      }
      repsStep();
    });
  }

  function repsStep() {
    const flagged = rows.filter(row => row.suspicious);
    step('Repeticiones por revisar', '<p class="muted">' + (flagged.length ? 'Las series de más de 30 repeticiones pueden ser errores. Desmarca «Excluir» para conservarlas.'
      : 'No hay series de más de 30 repeticiones.') + '</p>'
      + flagged.map(row => '<label class="toggle"><input type="checkbox" name="skip-' + row.index + '"' + (exclusions.has(row.index) ? ' checked' : '') + '>'
        + '<span>Excluir ' + esc(row.exercise) + ' · ' + esc(dateText(row.date)) + ' · ' + row.reps + ' reps</span></label>').join(''),
    machineStep, values => {
      exclusions.clear();
      flagged.forEach(row => { if (values['skip-' + row.index]) exclusions.add(row.index); });
      summaryStep();
    });
  }

  function summaryStep() {
    const all = importStats(rows), filtered = rows.filter(row => !exclusions.has(row.index));
    const dates = [all.first, all.last].map((date, i) => dateText(date, i ? {day: 'numeric', month: 'short', year: 'numeric'} : {day: 'numeric', month: 'short'})).join('–');
    step('Resumen de importación', '<p>' + quantity(all.sets, 'serie') + ' · ' + quantity(all.days, 'día') + ' · ' + esc(dates) + '</p>'
      + (exclusions.size ? '<p class="muted">' + plural(filtered.length, 'Se guardará ', 'Se guardarán ') + quantity(filtered.length, 'serie')
        + '. ' + exclusions.size + ' ' + plural(exclusions.size, 'marcada', 'marcadas') + ' para excluir.</p>' : '')
      + (metadata.length ? '<p class="muted">' + quantity(metadata.length, 'sesión', 'sesiones') + ' en el archivo adicional.</p>' : ''), repsStep, async () => {
      await ctx.save([...importChanges(ctx.data, filtered, metadata, {defaultGym, gyms, exercises, machines}), option('onboarded', true)]);
      closeSheet();
      ctx.go('hoy');
      ctx.notice('Historial importado.');
    }, 'Guardar');
  }
  fileStep();
}

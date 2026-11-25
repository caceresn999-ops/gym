import {weekId} from '../coach.js';
import {uuid} from '../db.js';
import {quantity} from '../engine.js';
import {interpolatedWeight, localDate} from '../metrics.js';
import {$, byId, closeSheet, dateText, esc, field, formSheet, iconButton, loadText, machineText, on, requiredNumber,
  routine, select, sheet, techniqueName, techniques, timestampInput, title} from './common.js';
import {openPeriodStory, openWeekStory} from './story.js';

export function historyView(ctx) {
  const groups = Map.groupBy(ctx.data.sessions.filter(row => row.end && !row.deleted).sort((a, b) => b.start - a.start), row => row.date.slice(0, 7));
  const counts = Map.groupBy(ctx.data.sets.filter(row => !row.deleted), row => row.sessionId);
  return title(ctx, 'Historial') + '<div class="actions history-actions"><button data-period="month">Resumen del mes</button>'
    + '<button data-period="year">Resumen anual</button><button data-week-history>Semanas</button><button data-manual>Entrada manual</button></div>'
    + ([...groups].map(([, rows]) => '<section><h2 class="month">' + esc(dateText(rows[0].date, {month: 'short', year: 'numeric'}))
      + ' · ' + quantity(rows.length, 'entreno') + '</h2><div class="list">' + rows.map(row => {
        const name = routine(row, ctx.data);
        const badge = name === 'Entreno' ? '··' : name.split(/[\s/]+/).map(word => word[0]).join('').slice(0, 2).toUpperCase().padEnd(2, name[1]?.toUpperCase() || '·');
        const duration = Math.max(0, Math.round((row.end - row.start) / 60000));
        return '<button class="li" data-history-session="' + esc(row.id) + '"><span class="ic" aria-hidden="true">' + esc(badge)
          + '</span><div class="grow"><div class="name">' + esc(name) + '</div><div class="meta">' + esc(dateText(row.date))
          + ' · ' + duration + ' min · ' + quantity(counts.get(row.id)?.length ?? 0, 'serie')
          + '</div></div><span class="chev">›</span></button>';
      }).join('') + '</div></section>').join('') || '<p class="muted">Aquí aparecerán tus entrenos.</p>');
}

export function bindHistory(ctx) {
  on(ctx.root, '[data-history-session]', node => sessionDetail(ctx, node.dataset.historySession));
  on(ctx.root, '[data-manual]', () => manualSession(ctx));
  on(ctx.root, '[data-week-history]', () => {
    const groups = Map.groupBy(ctx.data.sessions.filter(row => row.end && !row.deleted), row => weekId(row.date));
    const keys = [...new Set([...groups.keys(), ...ctx.data.weekPlans.map(row => row.isoWeek)])].sort().reverse();
    sheet('Resúmenes semanales', keys.length ? '<div class="list">' + keys.map(id => '<button class="li row" data-week="'
      + esc(id) + '"><strong>Semana ' + Number(id.slice(6)) + ' · ' + esc(id.slice(0, 4)) + '</strong><small class="muted">'
      + quantity(groups.get(id)?.length ?? 0, 'entreno') + '</small></button>').join('') + '</div>' : '<p class="muted">Sin entrenos registrados.</p>',
    root => on(root, '[data-week]', node => openWeekStory(ctx, node.dataset.week)));
  });
  on(ctx.root, '[data-period]', node => openPeriodStory(ctx, node.dataset.period));
  if (ctx.subroute && !$('#sheet').open) {
    let id;
    try { id = decodeURIComponent(ctx.subroute); } catch { return; }
    history.replaceState(null, '', '#historial');
    sessionDetail(ctx, id);
  }
}

function editSet(ctx, session, set = null) {
  const exercises = ctx.data.exercises;
  if (!exercises.length) return sheet('Añadir serie', '<p>Crea el ejercicio en Programa y luego vuelve a la sesión.</p><p><a href="#perfil/biblioteca" data-go-library>Ir a la Biblioteca</a></p>',
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
    + field('Notas', 'notes', set?.notes) + field('Hora de la serie', 'ts', timestampInput(set?.ts ?? session.start), 'type="datetime-local" required'),
  async values => {
    const machine = byId(ctx.data.machines, values.machineId);
    const reps = requiredNumber(values.reps, 'las repeticiones', 1);
    if (!Number.isInteger(reps)) throw Error('Usa un número entero de repeticiones o segundos.');
    await ctx.save([['sets', {id: set?.id, sessionId: session.id, slotIndex: set?.slotIndex ?? 0,
      setIndex: set?.setIndex ?? ctx.data.sets.filter(row => row.sessionId === session.id).length,
      exerciseId: values.exerciseId, machineId: machine?.id ?? null, weight: requiredNumber(values.weight, 'el peso'),
      unit: machine?.unit ?? 'kg', reps, rir: values.rir === '' ? null : Number(values.rir), type: values.type, notes: values.notes.trim(), ts: +new Date(values.ts), record: false}]]);
    sessionDetail(ctx, session.id);
  });
}

export function sessionDetail(ctx, id) {
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
    + ' min</p><div class="actions"><button data-edit-session>Editar entreno</button><button data-delete-session>Eliminar entreno</button></div>' + (session.notes ? '<p>' + esc(session.notes) + '</p>' : '') + '<button type="button" data-add-set>Añadir serie</button>'
    + (sets.length ? '<ul class="plain-list">' + sets.map(set => '<li class="swipe-row row" data-swipe="' + esc(set.id) + '"><button type="button" class="list-button" data-edit="'
      + esc(set.id) + '"><strong>' + esc(byId(ctx.data.exercises, set.exerciseId)?.name ?? 'Ejercicio') + '</strong><br><small class="muted">'
      + esc(loadText(set.weight, set.unit)) + ' × ' + set.reps + ' · ' + esc(techniqueName(set.type)) + (set.notes ? ' · ' + esc(set.notes) : '') + '</small></button>'
      + iconButton('trash-2', 'Eliminar serie', 'data-delete="' + esc(set.id) + '"') + '</li>').join('') + '</ul>'
      : '<p class="empty">Sin series registradas.</p>') + '</div>', root => {
    on(root, '[data-edit-session]', () => formSheet('Editar entreno',
      field('Nombre', 'dayName', routine(session, ctx.data), 'required') + field('Notas', 'notes', session.notes), async values => {
        const dayName = values.dayName.trim();
        if (!dayName) throw Error('Escribe el nombre del entreno.');
        await ctx.save([['sessions', {id, dayName, notes: values.notes.trim()}]]);
        sessionDetail(ctx, id);
      }));
    on(root, '[data-delete-session]', () => sheet('¿Eliminar entreno?', '<div class="stack"><button data-confirm-delete>Eliminar entreno y series</button>'
      + '<button data-cancel-delete>Volver</button></div>', dialog => {
      on(dialog, '[data-cancel-delete]', () => sessionDetail(ctx, id));
      on(dialog, '[data-confirm-delete]', async button => {
        button.disabled = true;
        try {
          const feedback = (ctx.data.feedback ?? []).filter(row => row.sessionId === id);
          await ctx.save([['sessions', {id, deleted: true}], ...sets.map(set => ['sets', {id: set.id, deleted: true}]),
            ...feedback.map(row => ['feedback', {id: row.id, deleted: true}])]);
          closeSheet();
        } finally { button.disabled = false; }
      });
    }));
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


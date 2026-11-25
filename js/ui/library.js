import {machineKind} from '../engine.js';
import {uuid} from '../db.js';
import {exerciseDefaults, exerciseDisplayName, muscleDefaults} from '../import.js';
import {byId, closeSheet, decimal, disclosure, esc, field, formSheet, machineText, muscleFields, on, readMuscles, requiredNumber, select, sheet} from './common.js';

export function gymEditor(ctx, gym = null, saved = null) {
  formSheet(gym ? 'Editar gimnasio' : 'Nuevo gimnasio', field('Nombre', 'name', gym?.name, 'required'), async values => {
    const name = values.name.trim();
    if (!name) throw Error('Escribe el nombre del gimnasio.');
    if (ctx.data.gyms.some(row => row.id !== gym?.id && row.name.toLowerCase() === name.toLowerCase())) throw Error('Ya existe ese gimnasio. Selecciónalo en la lista.');
    const row = {id: gym?.id ?? uuid(), name};
    await ctx.save([['gyms', row]], {render: !saved});
    if (saved) await saved(row);
    else closeSheet();
  });
}

export function machineEditor(ctx, machine = null, saved = null, gymId = null) {
  if (!ctx.data.gyms.length) return gymEditor(ctx, null, gym => machineEditor(ctx, machine, saved, gym.id));
  formSheet(machine ? 'Editar máquina' : 'Nueva máquina',
    field('Nombre de la máquina', 'name', machine?.name, 'required')
    + select('Gimnasio', 'gymId', ctx.data.gyms.map(row => [row.id, row.name]), machine?.gymId ?? gymId)
    + select('Unidad', 'unit', [['kg', 'kg'], ['lb', 'lb'], ['pila', 'pila']], machine?.unit ?? 'kg')
    + select('Tipo', 'kind', [['barra', 'Barra'], ['mancuerna', 'Mancuerna'], ['maquina', 'Máquina'],
      ['polea', 'Polea'], ['peso-corporal', 'Peso corporal']], machine?.kind ?? machineKind(machine?.name, machine?.unit))
    + field('Peso de la barra (kg)', 'barWeight', machine?.barWeight, 'inputmode="decimal" placeholder="20"')
    + '<div class="cols">' + field('Incremento', 'increment', machine?.increment ?? 2.5, 'inputmode="decimal" required')
    + field('Mínimo', 'min', machine?.min ?? 0, 'inputmode="decimal" required')
    + field('Máximo', 'max', machine?.max, 'inputmode="decimal" placeholder="Sin tope"') + '</div>',
  async values => {
    const name = values.name.trim();
    if (!name) throw Error('Escribe el nombre de la máquina.');
    const min = requiredNumber(values.min, 'el mínimo'), max = decimal(values.max);
    if (max != null && (!Number.isFinite(max) || max < min)) throw Error('Revisa el máximo. Debe ser igual o mayor que el mínimo.');
    const row = {id: machine?.id ?? uuid(), name, gymId: values.gymId, unit: values.unit,
      kind: values.kind, barWeight: values.kind === 'barra' ? requiredNumber(values.barWeight || 20, 'el peso de la barra', .01) : null,
      increment: requiredNumber(values.increment, 'el incremento', .000001), min, max};
    if (machine && machine.unit !== row.unit && ctx.data.sets.some(set => set.machineId === machine.id)) {
      const replacement = {...row, id: uuid()};
      const references = ctx.data.exercises.filter(ex => ex.defaultMachineId === machine.id)
        .map(ex => ['exercises', {id: ex.id, defaultMachineId: replacement.id}]);
      await ctx.save([['machines', replacement], ...references], {render: !saved});
      ctx.notice('Se creó un perfil con la unidad nueva. El historial conserva la unidad original.');
      if (saved) await saved(replacement);
      else closeSheet();
      return;
    }
    await ctx.save([['machines', row]], {render: !saved});
    if (saved) await saved(row);
    else closeSheet();
  });
}

export function machinePicker(ctx, exercise, selected, apply) {
  const rows = [...ctx.data.machines].sort((a, b) => (b.id === selected) - (a.id === selected)
    || (b.id === exercise?.defaultMachineId) - (a.id === exercise?.defaultMachineId) || a.name.localeCompare(b.name));
  sheet('Elegir máquina', '<div class="stack"><button type="button" data-new>Nueva máquina</button>'
    + '<ul class="plain-list"><li><button type="button" class="list-button" data-machine="">Peso corporal / sin máquina</button></li>'
    + rows.map(row => '<li><button type="button" class="list-button" data-machine="' + esc(row.id) + '">' + esc(machineText(ctx.data, row)) + '</button></li>').join('') + '</ul></div>',
  root => {
    on(root, '[data-machine]', async node => { await apply(byId(ctx.data.machines, node.dataset.machine) ?? null); closeSheet(); });
    on(root, '[data-new]', () => machineEditor(ctx, null, async row => { await apply(row); closeSheet(); }));
  });
}

export function exerciseEditor(ctx, exercise = null, saved = null) {
  const substitutes = new Set(exercise?.substitutes ?? []);
  const defaults = exercise ? '' : '<datalist id="exercise-defaults">'
    + exerciseDefaults.map(name => '<option value="' + esc(name) + '"></option>').join('') + '</datalist>';
  formSheet(exercise ? 'Editar ejercicio' : 'Nuevo ejercicio',
    field('Nombre', 'name', exercise?.name, 'required placeholder="Incline Barbell Press"' + (exercise ? '' : ' list="exercise-defaults"'))
    + defaults + select('Máquina predeterminada', 'defaultMachineId',
      [['', 'Sin máquina'], ...ctx.data.machines.map(row => [row.id, machineText(ctx.data, row)])], exercise?.defaultMachineId)
    + '<h3>Músculos</h3>' + muscleFields(exercise?.muscles ?? {})
    + '<details>' + disclosure('Sustitutos') + ctx.data.exercises.filter(row => row.id !== exercise?.id).map(row =>
      '<label class="toggle"><input type="checkbox" name="sub-' + esc(row.id) + '"' + (substitutes.has(row.id) ? ' checked' : '') + '> ' + esc(row.name) + '</label>').join('') + '</details>',
  async values => {
    const entered = values.name.trim();
    const name = exercise ? entered : exerciseDisplayName(entered);
    if (!name) throw Error('Escribe el nombre del ejercicio.');
    if (name !== exercise?.name && ctx.data.exercises.some(row => row.id !== exercise?.id && row.name.toLowerCase() === name.toLowerCase())) {
      throw Error('Ese ejercicio ya existe. Búscalo por nombre en la biblioteca.');
    }
    const muscles = readMuscles(values);
    const row = {id: exercise?.id ?? uuid(), name, muscles: !exercise && !Object.keys(muscles).length ? muscleDefaults(name) : muscles,
      defaultMachineId: values.defaultMachineId || null, substitutes: Object.keys(values).filter(key => key.startsWith('sub-')).map(key => key.slice(4))};
    await ctx.save([['exercises', row]], {render: !saved});
    if (saved) await saved(row);
    else closeSheet();
  });
}

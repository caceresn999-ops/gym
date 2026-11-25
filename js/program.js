import {option, uuid} from './db.js';
import {weekContext, weekId} from './coach.js';
import {muscles} from './engine.js';
import {exerciseDisplayName, muscleDefaults} from './import.js';

const nonempty = (value, message) => {
  if (typeof value !== 'string' || !value.trim()) throw Error(message);
  return value.trim();
};
const integer = (value, min, max, label) => {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) throw Error('Revisa ' + label + ' del programa.');
  return numeric;
};
const rest = (value, fallback, label) => {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 60) throw Error('Revisa ' + label + ' del programa.');
  return number;
};

export function prepareProgram(source, data, makeId = uuid) {
  if (!source || typeof source !== 'object' || !Array.isArray(source.weeks) || !source.weeks.length) {
    throw Error('El JSON debe incluir semanas, días y ejercicios. Revisa el archivo e inténtalo de nuevo.');
  }
  const name = nonempty(source.name, 'El programa necesita un nombre.');
  const changes = [];
  const exercises = [...data.exercises];
  function resolveExercise(ref) {
    const value = nonempty(ref, 'Un ejercicio del programa no tiene nombre o identificador.');
    const name = exerciseDisplayName(value);
    const existing = exercises.find(row => row.id === value || row.name === value)
      ?? exercises.find(row => row.name.toLowerCase() === value.toLowerCase())
      ?? exercises.find(row => row.name === name);
    if (existing) return existing.id;
    if (/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value)) {
      throw Error('Hay un ejercicio con identificador desconocido. Usa su nombre en el JSON o agrégalo a la biblioteca.');
    }
    const row = {id: makeId('exercises', name), name, muscles: muscleDefaults(value), defaultMachineId: null, substitutes: []};
    exercises.push(row);
    changes.push(['exercises', row]);
    return row.id;
  }
  const weekNumbers = new Set();
  const weeks = source.weeks.map((week, w) => {
    const n = integer(week.n ?? w + 1, 1, 520, 'el número de semana');
    if (weekNumbers.has(n)) throw Error('Se repite la semana ' + n + '. Usa un número distinto para cada semana.');
    weekNumbers.add(n);
    const kind = week.kind ?? 'normal';
    if (!['intro', 'normal', 'deload'].includes(kind)) throw Error('El tipo de semana debe ser normal, intro o deload.');
    if (!Array.isArray(week.days) || !week.days.length) throw Error('La semana ' + n + ' necesita al menos un día.');
    const days = week.days.map(day => {
      if (!Array.isArray(day.slots) || !day.slots.length) throw Error('Cada día debe tener al menos un ejercicio.');
      return {name: nonempty(day.name, 'Cada día necesita un nombre.'), slots: day.slots.map(slot => {
        const exerciseId = resolveExercise(slot.exerciseId);
        const sets = integer(slot.sets, 1, 25, 'las series');
        const repMin = integer(slot.repMin, 1, 200, 'las repeticiones mínimas');
        const repMax = integer(slot.repMax, repMin, 200, 'las repeticiones máximas');
        const warmups = integer(slot.warmups ?? 0, 0, 20, 'el calentamiento');
        const restMin = rest(slot.restMin, null, 'el descanso mínimo');
        const restMax = rest(slot.restMax, restMin, 'el descanso máximo');
        if (restMin != null && restMax < restMin) throw Error('El descanso máximo debe ser igual o mayor que el mínimo.');
        const technique = slot.technique || null;
        if (![null, 'drop', 'parciales', 'myo', 'aguante'].includes(technique)) throw Error('La técnica de última serie del programa no es válida.');
        const rir = (Array.isArray(slot.rir) && slot.rir.length ? slot.rir : [0]).map(value => integer(value, 0, 3, 'el RIR'));
        return {exerciseId, substitutes: Array.isArray(slot.substitutes) ? [...new Set(slot.substitutes.map(resolveExercise))].filter(id => id !== exerciseId) : [],
          warmups, sets, repMin, repMax, rir, restMin, restMax, technique, notes: typeof slot.notes === 'string' ? slot.notes : ''};
      })};
    });
    return {n, kind, days};
  }).sort((a, b) => a.n - b.n);
  const targets = {};
  for (const key of Object.keys(muscles)) {
    const value = Number(source.targets?.[key] ?? 0);
    if (!Number.isFinite(value) || value < 0) throw Error('Revisa la meta de ' + muscles[key] + '.');
    if (value) targets[key] = value;
  }
  const sessionsPerWeek = integer(source.sessionsPerWeek ?? Math.min(7, weeks[0].days.length), 1, 21, 'las sesiones por semana');
  const resume = source.resume;
  if (resume && (!/^\d{4}-\d{2}-\d{2}$/.test(resume.date) || !Number.isFinite(Date.parse(resume.date)) || !weekNumbers.has(resume.week))) {
    throw Error('Revisa la fecha y la semana de reanudación del programa.');
  }
  const stableId = resume && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(source.id);
  const id = stableId || data.programs.some(row => row.id === source.id) ? source.id : makeId('programs', name);
  const program = {id, name, active: true, weeks, targets, sessionsPerWeek};
  return {program, changes: [...changes, ...data.programs.filter(row => row.active && row.id !== id)
    .map(row => ['programs', {id: row.id, active: false}]), ['programs', program]]};
}

export function programResumeChanges(program, {date, week}, data) {
  const programWeekAnchor = {programId: program.id, isoWeek: weekId(date), programWeek: week};
  const options = {...data.options, activeWeek: week, programWeekAnchor};
  const state = weekContext({...data, options}, date, program);
  return [option('activeWeek', week), option('programWeekAnchor', programWeekAnchor), option('selectedDay', null),
    ['weekPlans', state.storedPlan ?? state.plan]];
}
export function coachingNote(notes) {
  return (notes ?? '').replace(/(Nombre|Calentamiento|T[eé?]cnica) en el PDF:[^.]*\.?/g, '').trim();
}


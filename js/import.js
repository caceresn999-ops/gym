import {uuid} from './db.js';
import {localDate} from './metrics.js';

const dictionary = new Map();
const library = new Set();
function define(muscles, ...entries) {
  for (const entry of entries) {
    const [name, ...aliases] = entry.split('|');
    library.add(name);
    for (const alias of [name, ...aliases]) dictionary.set(alias.toLowerCase(), {name, muscles});
  }
}
define({'espalda-media': 1, dorsal: .5, biceps: .5},
  'Chest-Supported Row|Chest Supported Rows', 'High Row', 'T-Bar Row|T Bar Row', 'Seated Cable Row|Overgrip Cable Row');
define({dorsal: 1, biceps: .5}, 'Lat Pulldown', 'Cross-Body Lat Pulldown|Cross Body Lat Pulldown',
  'Close-Grip Lat Pulldown|Cable Close Grip Pulldown', 'Assisted Wide-Grip Pull-Up|Assisted Pull Ups Wide',
  'Straight-Bar Lat Prayer|Straight Bar Lat Prayer', 'Pull-Up', 'Pull-Up (Wide Grip)');
define({pecho: 1, 'deltoide-ant': .5, triceps: .5},
  'Incline Barbell Press|Incline Barbell Bench Press|Barbell Incline Press',
  'Low-Incline Smith Machine Press|Smith Machine Incline Bench Press', 'Incline Dumbbell Press', 'Machine Chest Press|Chest Press Machine');
define({pecho: 1}, 'Pec Deck|Machine Pec Fly', 'Dumbbell Fly|Dumbell Fly', 'Cable Flye');
define({pecho: 1, triceps: .5}, 'Assisted Dip');
define({'deltoide-ant': 1, triceps: .5}, 'Machine Shoulder Press', 'Dumbbell Shoulder Press');
define({'deltoide-lat': 1}, 'Cable Lateral Raise|Cable Lateral Raises', 'Machine Lateral Raise',
  'Dumbbell Lateral Raise', 'Single-Arm Dumbbell Lateral Raise|One Arm Dumbell Lateral Raise');
define({'deltoide-lat': 1, trapecio: .5}, 'Incline Y Raise', 'Cable Y-Raise', 'Incline DB Y-Raise');
define({'deltoide-post': 1}, 'Cable Reverse Fly');
define({'deltoide-post': 1, 'espalda-media': .5}, 'Cable Face Pull');
define({trapecio: 1}, 'Barbell Shrug', 'Kelso Shrug|Kelso Shrugs');
define({biceps: 1}, 'Preacher Curl|Preacher Curls', 'Bayesian Cable Curl|Bayesia Curl',
  'Incline Dumbbell Curl|Incline Dumbell Curl', 'Dumbbell Curl|Dumbell Curl');
define({biceps: 1, antebrazo: .5}, 'Hammer Curl|Hammer Curls', 'Reverse Zottman Curl|Inverse Zottman Curl',
  'Reverse Curl', 'Standing Cable Curl');
define({triceps: 1}, 'Overhead Cable Triceps Extension|Overhead Triceps Extension',
  'Cable Triceps Pushdown|Tricep Pushdown', 'Dumbbell Triceps Kickback|Kick Back Tricep', 'Cable Triceps Kickback|Cable Tricep Kickback');
define({antebrazo: 1}, 'Wrist Curl', 'Wrist Extension');
define({cuadriceps: 1}, 'Leg Extension');
define({cuadriceps: 1, gluteo: .5}, 'Hack Squat', 'Leg Press', 'Smith Machine Squat|Smith Squat',
  'Belt Squat|Belt Squats', 'Machine Lunge|Lunge Machine', 'Goblet Squat');
define({isquios: 1}, 'Seated Leg Curl', 'Lying Leg Curl');
define({isquios: 1, gluteo: .5}, 'Romanian Deadlift|Standing RDL', 'Dumbbell Romanian Deadlift');
define({gluteo: 1}, 'Hip Thrust|Hip Thrusts', 'Machine Hip Abduction|Hip Abduction Machine');
define({pantorrilla: 1}, 'Leg Press Calf Raise|Leg Press Calf Push Away', 'Standing Calf Raise');
define({abdomen: 1}, 'Cable Crunch', 'Dynamic Plank', 'Dragon Flag');
define({antebrazo: 1}, 'Dead Hang');
const exerciseEntry = name => dictionary.get(name.trim().toLowerCase());
export const exerciseDefaults = [...library].sort((a, b) => a.localeCompare(b, 'en'));
export const exerciseDisplayName = name => exerciseEntry(name)?.name ?? name;
export const muscleDefaults = name => ({...exerciseEntry(name)?.muscles});

export function csvRows(source) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted || !cell) quoted = !quoted;
      else cell += char;
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      row.push(cell);
      cell = '';
      if (char !== ',') {
        if (row.some(Boolean)) rows.push(row);
        row = [];
        if (char === '\r' && source[i + 1] === '\n') i++;
      }
    } else cell += char;
  }
  if (quoted) throw Error('Quedó una comilla abierta en el CSV. Exporta el archivo otra vez e inténtalo de nuevo.');
  row.push(cell);
  if (row.some(Boolean)) rows.push(row);
  const headers = (rows.shift() ?? []).map(value => value.replace(/^\uFEFF/, '').trim());
  return {headers, records: rows.map(values => Object.fromEntries(headers.map((key, i) => [key, values[i] ?? ''])))};
}

const timestamp = (value, offset = '') => +new Date(value.trim().replace(' ', 'T') + (value.trim() ? offset : ''));
const positive = value => Math.max(0, Number(value) || 0);
export const noteGym = (note, fallback = 'Titanium') => /vac/i.test(note) ? 'VAC' : /sport|port/i.test(note) ? 'SPORT' : fallback;
export const machineKey = (exercise, gym) => JSON.stringify([exercise, gym]);
const fractionalLb = (kg, lb) => {
  const pounds = lb || kg / .453592;
  return Math.abs(kg * 100 - Math.round(kg * 100)) > .0001 && Math.abs(pounds * 2 - Math.round(pounds * 2)) < .015;
};

export function parseSetgraph(source, offset = '') {
  const {headers, records} = csvRows(source);
  if (!['Exercise', 'Date', 'Repetitions', 'Weight (kg)'].every(key => headers.includes(key))) {
    throw Error('El CSV no tiene las columnas de series de Setgraph. Selecciona la exportación de series.');
  }
  return records.map((row, index) => {
    const ts = timestamp(row.Date, offset);
    const exercise = row.Exercise.trim();
    if (!exercise || !Number.isFinite(ts)) return null;
    const kg = positive(row['Weight (kg)']), lb = positive(row['Weight (lb)']);
    const reps = Math.trunc(positive(row.Repetitions));
    return {index, exercise, ts, date: offset ? row.Date.trim().slice(0, 10) : localDate(ts), kg, lb, reps, note: row.Note ?? '',
      label: row.Label ?? '', fractional: fractionalLb(kg, lb), suspicious: reps > 30};
  }).filter(Boolean);
}

export function parseSessions(source, offset = '') {
  if (!source) return [];
  const {headers, records} = csvRows(source);
  if (!['Start Date', 'End Date'].every(key => headers.includes(key))) {
    throw Error('El CSV no tiene las columnas de sesiones. Selecciona la exportación de sesiones o déjala vacía.');
  }
  return records.map((row, index) => {
      if (row['Activity Type'] && !/strength|training|fuerza/i.test(row['Activity Type'])) return null;
      const start = timestamp(row['Start Date'], offset);
      if (!Number.isFinite(start)) return null;
      const end = timestamp(row['End Date'], offset);
      return {index, date: offset ? row['Start Date'].trim().slice(0, 10) : localDate(start), start, end: Number.isFinite(end) ? end : start + positive(row['Duration (seconds)']) * 1000,
        source: row.Source ?? '', notes: row.Notes ?? '', dayName: row['Workout Name'] || row['Routine'] || row.Source || 'Entrenamiento'};
    }).filter(Boolean);
}

export function groupBySession(rows) {
  const sessions = [];
  for (const row of [...rows].sort((a, b) => a.ts - b.ts || a.index - b.index)) {
    const current = sessions.at(-1);
    if (!current || current.date !== row.date || row.ts - current.sets.at(-1).ts > 10800000) {
      sessions.push({date: row.date, start: row.ts, end: row.ts, sets: [row]});
    } else {
      current.end = row.ts;
      current.sets.push(row);
    }
  }
  return sessions;
}

export function importStats(rows) {
  const dates = [...new Set(rows.map(row => row.date))].sort();
  return {sets: rows.length, days: dates.length, first: dates[0], last: dates.at(-1)};
}

export function discoverMappings(rows, defaultGym = 'Titanium', gyms = {}) {
  const exercises = new Map(), machines = new Map();
  for (const row of rows) {
    const gym = gyms[row.note] ?? noteGym(row.note, defaultGym);
    if (!exercises.has(row.exercise)) exercises.set(row.exercise, muscleDefaults(row.exercise));
    const key = machineKey(row.exercise, gym);
    if (!machines.has(key)) machines.set(key, {name: row.exercise, exercise: row.exercise, gym, unit: 'kg', increment: 2.5, min: 0, max: null, flagged: 0});
    if (row.fractional) machines.get(key).flagged++;
  }
  return {exercises, machines};
}

export function importChanges(data, rows, metadata, mapping, makeId = uuid) {
  const changes = [], exercises = new Map(), machines = new Map();
  const gymByName = new Map(data.gyms.map(gym => [gym.name.toLowerCase(), gym.id]));
  for (const [key, machine] of mapping.machines) {
    const gymName = machine.gym.toLowerCase();
    if (!gymByName.has(gymName)) {
      const id = makeId('gyms', gymName);
      gymByName.set(gymName, id);
      changes.push(['gyms', {id, name: machine.gym}]);
    }
    const gymId = gymByName.get(gymName);
    const old = data.machines.find(row => row.name === machine.name && row.gymId === gymId && row.unit === machine.unit);
    const record = {id: old?.id ?? makeId('machines', key), gymId, name: machine.name, unit: machine.unit,
      increment: machine.increment, min: machine.min, max: machine.max};
    machines.set(key, record);
    if (!old) changes.push(['machines', record]);
  }
  for (const [name, muscles] of mapping.exercises) {
    const old = data.exercises.find(row => row.name === name);
    const id = old?.id ?? makeId('exercises', name);
    exercises.set(name, id);
    const preferred = machines.get(machineKey(name, mapping.defaultGym)) ?? [...machines.values()].find(machine => machine.name === name);
    changes.push(['exercises', {id, name, muscles, defaultMachineId: old?.defaultMachineId || preferred?.id || null, substitutes: old?.substitutes ?? []}]);
  }
  const groups = groupBySession(rows);
  const free = new Set(metadata.filter(row => !/repcount/i.test(row.source)));
  for (const group of groups) {
    const choices = [...free].filter(row => row.date === group.date && row.end + 10800000 >= group.start && row.start - 10800000 <= group.end);
    const match = choices.sort((a, b) => Math.abs(a.start - group.start) - Math.abs(b.start - group.start))[0];
    if (match) {
      free.delete(match);
      Object.assign(group, {start: match.start, end: match.end, notes: match.notes, dayName: match.notes || match.dayName,
        sourceKey: match.sourceKey});
    }
  }
  const manual = metadata.filter(row => /repcount/i.test(row.source) || free.has(row));
  const entries = [...groups, ...manual].sort((a, b) => a.start - b.start);
  const existing = new Map(data.sessions.filter(row => row.importKey).map(row => [row.importKey, row]));
  let n = Math.max(0, ...data.sessions.map(row => row.n || 0));
  for (const group of entries) {
    const importKey = [group.date, group.sets?.[0].ts ?? group.start, group.source ?? 'series'].join('|');
    const current = existing.get(importKey);
    const id = current?.id ?? makeId('sessions', group.sourceKey ?? group.sets?.[0].sourceKey ?? importKey);
    changes.push(['sessions', {id, n: current?.n ?? ++n, date: group.date, start: group.start, end: group.end, importKey,
      dayName: group.dayName || 'Entrenamiento', notes: group.notes || '', programId: null, week: null, dayIndex: null,
      bodyweight: null, manual: !group.sets}]);
    const indices = new Map();
    const already = new Map(data.sets.filter(set => set.sessionId === id && set.importKey).map(set => [set.importKey, set]));
    for (const row of group.sets ?? []) {
      const gym = mapping.gyms[row.note] ?? noteGym(row.note, mapping.defaultGym);
      const key = row.machineKey ?? machineKey(row.exercise, gym), machine = machines.get(key);
      if (!indices.has(key)) indices.set(key, {slot: indices.size, sets: 0});
      const slot = indices.get(key);
      const setIndex = slot.sets++;
      const unit = machine?.unit ?? 'kg';
      const setKey = [row.ts, row.exercise, setIndex].join('|');
      changes.push(['sets', {id: already.get(setKey)?.id ?? makeId('sets', row.sourceKey ?? setKey), importKey: setKey, sessionId: id, exerciseId: exercises.get(row.exercise),
        machineId: machine?.id ?? null, slotIndex: slot.slot, setIndex, weight: unit === 'lb' ? Number((row.lb || row.kg / .453592).toFixed(3)) : row.kg,
        unit, reps: row.reps, rir: null, type: /warm|calent/i.test(row.label) ? 'warmup' : 'working',
        ts: row.ts, notes: row.note}]);
    }
  }
  return changes;
}

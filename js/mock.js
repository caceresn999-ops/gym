import {option, resetMock, uuid, write} from './db.js';
import {buildWeekPlan, feedbackId, targetId, weekContext, weekId} from './coach.js';
import {addDays, localDate, monday} from './metrics.js';

export const modes = ['first-run', 'empty', 'typical', 'offline', 'deload', 'pr', 'stall', 'long-names', 'pila-max', 'semana-4', 'rp', 'domingo'];
const base = +new Date(2026, 10, 24, 18, 30, 0);
const sunday = +new Date(2026, 10, 29, 12);
const hour = 3600000, day = 24 * hour;
const insert = (changes, entity, fields) => {
  const id = uuid();
  changes.push([entity, {id, ...fields}]);
  return id;
};

export const mockDate = mode => new Date(['rp', 'domingo'].includes(mode) ? sunday : base);
export const mockNow = (seededAt, mode) => new Date(+mockDate(mode) + Date.now() - (seededAt ?? Date.now()));

export async function seedMock(db, mode, current) {
  if (current.mockMode === 'v7:' + mode) return;
  await resetMock(db);
  await write(db, mockRecords(mode, Date.now()), {queue: false});
}

export function mockRecords(mode, seededAt) {
  const changes = [option('mockMode', 'v7:' + mode), option('mockSeedAt', seededAt), option('onboarded', mode !== 'first-run')];
  if (mode === 'first-run' || mode === 'empty') return changes;
  const gymId = insert(changes, 'gyms', {name: 'Gimnasio Central'});
  const gear = (name, unit, increment, max = null) => insert(changes, 'machines', {gymId, name, unit, increment, min: 0, max});
  const bench = gear('Barra olímpica', 'kg', 2.5), otherBench = gear('Banco guiado', 'kg', 5);
  const pec = gear('Pec Deck', 'pila', 5, mode === 'pila-max' ? 190 : 230), cable = gear('Polea doble', 'kg', 2.5);
  const long = mode === 'long-names';
  const exercise = (name, muscles, machine = null) => insert(changes, 'exercises', {name, muscles, defaultMachineId: machine, substitutes: []});
  const press = exercise(long ? 'Low-Incline Barbell Press With a Pause at the Bottom' : 'Incline Barbell Press',
    {pecho: 1, triceps: .5, 'deltoide-ant': .5}, bench);
  const fly = exercise(long ? 'Pec Deck With Lengthened Partials on the Last Set' : 'Pec Deck', {pecho: 1}, pec);
  const pull = exercise('Pull-Up', {dorsal: 1, biceps: .5});
  const lateral = exercise('Cable Lateral Raise', {'deltoide-lat': 1}, cable);
  const face = exercise('Cable Face Pull', {'deltoide-post': 1, 'espalda-media': .5}, cable);
  const curls = exercise('Standing Cable Curl', {biceps: 1, antebrazo: .5}, cable);
  const bottom = exercise('Goblet Squat', {cuadriceps: 1, gluteo: .5}, bench);
  const calves = exercise('Standing Calf Raise', {pantorrilla: 1}, bench);
  const core = exercise('Dynamic Plank', {abdomen: 1});
  const row = exercise('Seated Cable Row', {'espalda-media': 1, dorsal: .5, biceps: .5}, cable);
  const hinge = exercise('Dumbbell Romanian Deadlift', {isquios: 1, gluteo: .5}, bench);
  const slot = (exerciseId, sets = 2, substitutes = []) => ({exerciseId, sets, substitutes, warmups: sets > 1 ? 2 : 0,
    repMin: exerciseId === fly || exerciseId === pull ? 8 : 6, repMax: exerciseId === fly || exerciseId === pull ? 10 : 8,
    rir: sets === 1 ? [0] : [1, 0], restMin: 1, restMax: 2, technique: exerciseId === fly ? 'parciales' : null, notes: ''});
  const days = [
    {name: 'Upper 1',
      slots: [slot(press, 2, [fly]), slot(fly, 1, [press]), slot(pull), slot(lateral), slot(face), slot(curls), slot(row), slot(core, 1)]},
    {name: 'Lower 1', slots: [slot(bottom, 3), slot(hinge, 3), slot(calves, 3), slot(curls, 2)]},
    {name: 'Upper 2', slots: [slot(press, 3), slot(row, 3), slot(face, 3), slot(core, 2)]},
    {name: 'Lower 2', slots: [slot(bottom, 3), slot(hinge, 3), slot(calves, 3), slot(core, 2)]},
    {name: 'Arms/Delts', slots: [slot(pull, 3), slot(press, 3), slot(face, 3), slot(lateral, 4)]}
  ];
  const targets = {pecho: 6, 'deltoide-ant': 4, 'deltoide-lat': 5, 'deltoide-post': 2, dorsal: 7,
    'espalda-media': 8, biceps: 3, triceps: 4, antebrazo: 3, abdomen: 3, cuadriceps: 8, gluteo: 5, isquios: 3, pantorrilla: 4};
  if (mode === 'typical') Object.assign(targets, {dorsal: 5, gluteo: 9});
  if (mode === 'semana-4') {
    days[0] = {name: 'Upper 1', slots: [slot(press), slot(pull)]};
    days[4].slots = [slot(curls, 3), slot(lateral), slot(face, 3), slot(fly, 3)];
    changes.push(option('sessionSetCap', 12));
  }
  const weeks = Array.from({length: 12}, (_, i) => ({n: i + 1, kind: i === 0 ? 'intro' : i === 6 ? 'deload' : 'normal', days}));
  const programId = insert(changes, 'programs', {name: 'Min-Max', active: true, weeks, targets, sessionsPerWeek: 5});
  changes.push(option('activeWeek', mode === 'deload' ? 7 : 3), option('lastSessionNumber', 220));
  const now = mockDate(mode), iso = weekId(now);
  changes.push(option('programWeekAnchor', {isoWeek: iso, programId, programWeek: mode === 'deload' ? 7 : 3}));
  insert(changes, 'phases', {kind: 'volumen', start: '2026-01-14'});
  for (const [back, weight] of [[174, 91], [126, 92.1], [87, 93], [45, 94.4], [27, 95.5], [16, 96.1], [1, 97]]) {
    insert(changes, 'body', {date: localDate(base - day * back), weight});
  }
  const log = (sessionId, ts, ex, machineId, weight, reps, setIndex, extra = {}) => insert(changes, 'sets', {
    sessionId, exerciseId: ex, machineId, slotIndex: 0, setIndex, weight, unit: machineId === pec ? 'pila' : 'kg',
    reps, type: 'working', rir: null, ts, ...extra});
  function completed(n, ts, name, entries, manual = false, extra = {}) {
    const duration = (45 + (n * 13) % 51) * 60000;
    const id = insert(changes, 'sessions', {n, date: localDate(ts), start: ts, end: ts + duration, programId: null, week: null, dayIndex: null,
      bodyweight: null, dayName: name, notes: '', manual, ...extra});
    entries.forEach(([ex, machine, weight, reps], i) => log(id, ts + i * 60000, ex, machine, weight, reps,
      entries.slice(0, i).filter(row => row[0] === ex && row[1] === machine).length));
    return id;
  }
  completed(200, base - 150 * day, 'RepCount', [], true);
  if (mode === 'typical') {
    for (let week = 0; week < 12; week++) {
      completed(181 + week, base - (91 - 7 * week) * day, days[0].name, [
        [fly, pec, 175 + 5 * Math.floor(week / 2), 9],
        [pull, null, 0, 6 + Math.floor(week / 3)],
        [row, cable, week >= 10 ? 50 : 42.5 + 2.5 * Math.floor(week / 4), 8],
        [lateral, cable, week < 4 ? 7.5 : 10, 8],
        [face, cable, week < 4 ? 17.5 : 20, 8],
        [curls, cable, week < 4 ? 12.5 : 15, 8],
        [hinge, bench, week < 4 ? 30 : 35, 8]
      ]);
    }
  }
  const stallPress = [[press, bench, 85, 7], [press, bench, 85, 7]];
  const stallBaseline = [...stallPress, [fly, pec, 205, 9], [pull, null, 0, 10], [row, cable, 50, 8],
    [lateral, cable, 10, 9], [face, cable, 20, 8], [curls, cable, 15, 8]];
  completed(205, base - 87 * day, days[0].name, mode === 'stall' ? stallBaseline : [[press, bench, 68, 8]]);
  completed(210, base - 59 * day, days[0].name, [[press, otherBench, 63, 8]]);
  completed(211, base - 51 * day, days[0].name, [[press, otherBench, 65, 8]]);
  completed(213, base - 36 * day, days[0].name, mode === 'stall' ? stallBaseline : [[press, bench, 75, 8]]);
  completed(215, base - 26 * day, days[2].name, mode === 'stall' ? stallPress : [[press, bench, 77.5, 8]]);
  completed(216, base - 15 * day, days[2].name, mode === 'stall' ? stallPress : [[press, bench, 82.5, 8]]);
  completed(217, base - 7 * day, days[0].name, [...(mode === 'stall' ? stallPress : [[press, bench, 85, 8], [press, bench, 85, 8]]),
    [fly, pec, mode === 'pila-max' ? 190 : 205, mode === 'pila-max' ? 10 : 9], [pull, null, 0, 10], [pull, null, 0, 9]]);
  if (mode === 'typical') {
    completed(220, base - 25 * hour, days[0].name, [
      [press, bench, 85, 8], [press, bench, 85, 8], [row, cable, 50, 8], [row, cable, 50, 8], [lateral, cable, 10, 8],
      [row, cable, 50, 8], [row, cable, 50, 8], [lateral, cable, 10, 9], [hinge, bench, 35, 8], [hinge, bench, 35, 8],
      [face, cable, 20, 8], [curls, cable, 15, 8], [hinge, bench, 35, 8], [hinge, bench, 35, 8]]);
  } else {
    completed(220, base - 25 * hour, mode === 'domingo' ? days[0].name : days[2].name, [
      [row, cable, 50, 8], [row, cable, 50, 8], [row, cable, 50, 7], [lateral, cable, 10, 8], [lateral, cable, 10, 8],
      [row, cable, 50, 8], [row, cable, 50, 8], [row, cable, 50, 8], [lateral, cable, 10, 8], [lateral, cable, 10, 9],
      [face, cable, 20, 8], [face, cable, 20, 8], [curls, cable, 15, 8], [curls, cable, 15, 8]], false,
    mode === 'domingo' ? {programId, week: 3, dayIndex: 0} : {});
  }
  const addFeedback = (sessionId, muscle, soreness, pump, performance) =>
    changes.push(['feedback', {id: feedbackId(sessionId, muscle), sessionId, muscle, soreness, pump, performance}]);
  if (mode === 'rp') {
    const prior = completed(218, base - 5 * day, days[2].name, [[press, bench, 78, 8], [pull, null, 0, 7]]);
    addFeedback(prior, 'pecho', 'adolorido', 'bien', 'baja');
    addFeedback(prior, 'dorsal', 'adolorido', 'bien', 'baja');
    const recent = completed(221, +now - 2 * day, days[2].name, [
      [press, bench, 86, 8], [press, bench, 86, 8], [press, bench, 86, 7], [press, bench, 86, 7],
      [pull, null, 0, 11], [pull, null, 0, 10], [pull, null, 0, 9], [pull, null, 0, 8]]);
    addFeedback(recent, 'pecho', 'sano', 'poco', 'sube');
    addFeedback(recent, 'dorsal', 'sano', 'poco', 'sube');
  }
  const program = changes.find(([entity]) => entity === 'programs')[1];
  const currentData = () => ({
    ...Object.fromEntries(['sessions', 'sets', 'feedback', 'exercises', 'body', 'phases', 'weekPlans', 'volumeTargets'].map(entity =>
      [entity, changes.filter(([name]) => name === entity).map(([, row]) => row)])),
    programs: [program], options: Object.fromEntries(changes.filter(([entity]) => entity === 'settings').map(([, row]) => [row.key, row.value]))
  });
  let planned;
  if (['semana-4', 'rp', 'domingo'].includes(mode)) {
    const data = currentData(), state = weekContext(data, now);
    planned = buildWeekPlan({data: {...data, sessions: data.sessions.filter(row => weekId(row.date) !== iso || row.programId !== programId)},
      program, week: state.week, id: iso, daysAvailable: mode === 'semana-4' ? 4 : 5,
      from: mode === 'semana-4' ? now : monday(now), targets: state.targetRows});
    changes.push(['weekPlans', planned]);
    for (const [muscle, row] of Object.entries(state.targetRows)) {
      changes.push(['volumeTargets', {id: targetId(iso, programId, 3, muscle), isoWeek: iso, programId, programWeek: 3, muscle,
        ...row, kind: 'normal', enabled: true, mrv: 20}]);
    }
  }
  if (mode === 'domingo') {
    const date = offset => +addDays(now, offset);
    const alignment = dayIndex => ({programId, week: 3, dayIndex});
    const midweek = completed(221, date(-4), days[1].name, [[bottom, bench, 42.5, 8], [hinge, bench, 38, 8], [calves, bench, 35, 10]], false, alignment(1));
    addFeedback(midweek, 'isquios', 'justo', 'poco', 'igual');
    const upper = completed(222, date(-2), days[2].name, [[press, bench, 92.5, 8], [row, cable, 50, 8], [pull, null, 0, 11]], false, alignment(2));
    addFeedback(upper, 'pecho', 'sano', 'bien', 'sube');
    completed(223, date(-1), days[3].name, [[hinge, bench, 38, 8], [bottom, bench, 45, 8], [row, cable, 50, 8]], false, alignment(3));
    for (const [offset, weight] of [[-8, 96.6], [-4, 96.9], [-1, 97.2]]) {
      insert(changes, 'body', {date: localDate(date(offset)), weight});
    }
  }
  if (['offline', 'pr', 'stall', 'pila-max', 'rp'].includes(mode)) {
    const start = +now - 34 * 60000;
    const dayPlan = planned?.plan[0] ?? days[0];
    const slots = dayPlan.slots.map(item => ({...item, key: uuid(), machineId: changes.find(([, row]) => row.id === item.exerciseId)[1].defaultMachineId}));
    const session = insert(changes, 'sessions', {n: mode === 'rp' ? 222 : 221, date: localDate(start), start, end: null, programId, week: 3, dayIndex: 0,
      bodyweight: 97, dayName: days[0].name, notes: '', manual: false, kind: 'normal', slots,
      ...(mode === 'rp' ? {targets: weekContext(currentData(), now).targets} : {})});
    if (mode === 'pr') log(session, start + 2 * 60000, press, bench, 90, 8, 0, {slotId: slots[0].key, record: true, rir: 1});
    if (mode === 'rp') {
      const lateralSlot = slots.find(item => item.exerciseId === lateral);
      for (let i = 0; i < lateralSlot.sets; i++) log(session, start + (i + 1) * 60000, lateral, cable, 10, 8, i, {slotId: lateralSlot.key});
    }
  }
  return changes;
}

export const mockRoute = mode => ['offline', 'pr', 'stall', 'pila-max', 'rp'].includes(mode) ? 'entrenar' : 'hoy';

import {bestSet, bodyweightSet, compareStrength, e1rm, isHard, muscles, prescription, stallStep, strengthValue} from './engine.js';

export function localDate(input = new Date()) {
  const date = new Date(input);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

export const asDate = input => new Date(typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input) ? input + 'T12:00:00' : input);
export function addDays(input, days) {
  const date = asDate(input);
  date.setDate(date.getDate() + days);
  return date;
}
export function monday(input) {
  const date = asDate(input);
  date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  date.setHours(0, 0, 0, 0);
  return date;
}
export function isoWeek(input) {
  const thursday = addDays(monday(input), 3);
  const first = monday(thursday.getFullYear() + '-01-04');
  const days = Math.round((thursday - first) / 86400000);
  return Math.floor(days / 7) + 1;
}

export function dose(sets, exercises, sessions, week = null) {
  const lookup = new Map(exercises.map(exercise => [exercise.id, exercise.muscles]));
  const start = week == null ? null : localDate(monday(week));
  const end = week == null ? null : localDate(addDays(monday(week), 7));
  const dates = new Map(sessions.filter(row => !row.deleted && (!start || row.date >= start && row.date < end)).map(row => [row.id, row.date]));
  const done = {}, days = {};
  let total = 0;
  for (const set of sets) {
    if (!isHard(set) || !dates.has(set.sessionId)) continue;
    total++;
    for (const [key, credit] of Object.entries(lookup.get(set.exerciseId) ?? {})) {
      done[key] = (done[key] ?? 0) + credit;
      (days[key] ??= new Set()).add(dates.get(set.sessionId));
    }
  }
  return {done, total, frequency: Object.fromEntries(Object.entries(days).map(([key, values]) => [key, values.size]))};
}

export const gaps = (done, targets) => Object.keys(muscles).map(key => ({
  key, done: done[key] ?? 0, target: targets[key] ?? 0, gap: (targets[key] ?? 0) - (done[key] ?? 0)
})).filter(row => row.gap > 0).sort((a, b) => b.gap - a.gap);

export const weighIns = rows => rows.filter(row => !row.deleted && row.weight > 0).sort((a, b) => a.date.localeCompare(b.date));
export function interpolatedWeight(rows, date) {
  const points = weighIns(rows);
  if (!points.length) return null;
  const right = points.findIndex(point => point.date >= date);
  if (right === 0) return points[0].weight;
  if (right === -1) return points.at(-1).weight;
  const a = points[right - 1], b = points[right];
  const ratio = (asDate(date) - asDate(a.date)) / (asDate(b.date) - asDate(a.date));
  return a.weight + ratio * (b.weight - a.weight);
}
export function weightRate(rows, until = new Date()) {
  const first = addDays(until, -28);
  const points = weighIns(rows).filter(row => row.date >= localDate(first) && row.date <= localDate(asDate(until)))
    .map(row => [(asDate(row.date) - first) / 86400000, row.weight]);
  if (points.length < 2) return null;
  const x = points.reduce((sum, point) => sum + point[0], 0) / points.length;
  const y = points.reduce((sum, point) => sum + point[1], 0) / points.length;
  const variance = points.reduce((sum, [day]) => sum + (day - x) ** 2, 0);
  return variance ? 30 * points.reduce((sum, [day, value]) => sum + (day - x) * (value - y), 0) / variance : null;
}

export function weeklySessions(sessions, date, count = 26) {
  const start = monday(date);
  return Array.from({length: count}, (_, index) => {
    const from = localDate(addDays(start, 7 * (index - count + 1)));
    const to = localDate(addDays(from, 7));
    return {date: from, value: sessions.filter(row => row.end && !row.deleted && row.date >= from && row.date < to).length};
  });
}
export function adherence(sessions, target, date, weeks) {
  return target ? weeklySessions(sessions, date, weeks).reduce((total, week) => total + week.value, 0) / (target * weeks) : null;
}
export function streak(sessions, date) {
  const visited = new Set(sessions.filter(row => row.end && !row.deleted && row.date <= localDate(asDate(date)))
    .map(row => localDate(monday(row.date))));
  let cursor = monday(date);
  if (!visited.has(localDate(cursor))) cursor = addDays(cursor, -7);
  let count = 0;
  while (visited.has(localDate(cursor))) {
    count++;
    cursor = addDays(cursor, -7);
  }
  return count;
}

export function records(sets, exerciseId, machineId) {
  const rows = sets.filter(set => isHard(set) && set.reps > 0 && set.exerciseId === exerciseId
    && (set.machineId ?? null) === (machineId ?? null)).sort((a, b) => a.ts - b.ts);
  const max = (items, valueFor) => items.reduce((best, item) => {
    const value = valueFor(item);
    return !best || value > best.value + 1e-9 ? {value, ...item} : best;
  }, null);
  const items = rows.map(set => ({set, date: set.date ?? localDate(set.ts)}));
  const volumes = new Map();
  for (const row of items) {
    const {sessionId, weight, reps} = row.set;
    if (!volumes.has(sessionId)) volumes.set(sessionId, {...row, sessionId, volume: 0});
    volumes.get(sessionId).volume += weight * reps;
  }
  return {
    e1rm: max(items, ({set}) => e1rm(set.weight, set.reps)),
    weight: max(items, ({set}) => set.weight),
    volume: max([...volumes.values()], row => row.volume),
    reps: max(items, ({set}) => set.reps),
    repMax: Array.from({length: 15}, (_, index) => index + 1).flatMap(reps => {
      const best = max(items.filter(row => row.set.reps >= reps), ({set}) => set.weight);
      return best ? [{...best, reps}] : [];
    })
  };
}

export function recovery(sets, exercises, now) {
  const result = {}, byMuscle = {};
  const weights = new Map(exercises.map(row => [row.id, row.muscles]));
  for (const set of sets) {
    if (!isHard(set) || set.reps <= 0 || !Number.isFinite(set.ts) || set.ts > +asDate(now)) continue;
    for (const [muscle, credit] of Object.entries(weights.get(set.exerciseId) ?? {})) {
      if (credit <= 0) continue;
      const sessions = byMuscle[muscle] ??= new Map();
      const entry = sessions.get(set.sessionId) ?? {at: 0, sets: 0};
      entry.at = Math.max(entry.at, set.ts);
      entry.sets += credit;
      sessions.set(set.sessionId, entry);
    }
  }
  for (const muscle of Object.keys(muscles)) {
    const latest = [...(byMuscle[muscle]?.values() ?? [])].sort((a, b) => b.at - a.at)[0];
    const window = !latest ? 0 : latest.sets <= 4 ? 48 : latest.sets <= 8 ? 72 : 96;
    const hours = latest ? Math.max(0, (+asDate(now) - latest.at) / 3600000) : 0;
    result[muscle] = {...latest, window, recovered: window ? Math.min(1, hours / window) : 1,
      remaining: Math.max(0, window - hours)};
  }
  return result;
}

export function medianStrength(sets, sessions, weeks, date) {
  const through = localDate(asDate(date));
  const changes = latestStrength(sets, sessions.filter(row => row.date <= through)).filter(({point}) => !point.bodyweight)
    .map(({same}) => strengthTrend(same, weeks, date)).filter(value => value != null).sort((a, b) => a - b);
  const mid = Math.floor(changes.length / 2);
  return changes.length % 2 ? changes[mid] : changes.length ? (changes[mid - 1] + changes[mid]) / 2 : null;
}

export function strengthSeries(sets, sessions) {
  const completed = new Map(sessions.filter(session => session.end && !session.deleted).map(session => [session.id, session]));
  const groups = new Map();
  const bodyweightLifts = new Set();
  for (const set of sets) {
    if (!isHard(set) || !completed.has(set.sessionId) || set.reps <= 0) continue;
    if (bodyweightSet(set)) bodyweightLifts.add(set.exerciseId);
    const key = JSON.stringify([set.exerciseId, set.machineId, set.sessionId]);
    (groups.get(key) ?? groups.set(key, []).get(key)).push(set);
  }
  const points = [...groups.values()].map(group => {
    const bodyweight = bodyweightLifts.has(group[0].exerciseId);
    const set = bestSet(group, bodyweight), session = completed.get(set.sessionId);
    return {set, session, date: session.date, bodyweight, value: strengthValue(set, bodyweight)};
  }).sort((a, b) => +new Date(a.session.start) - +new Date(b.session.start) || a.set.ts - b.set.ts);
  const best = new Map();
  for (const point of points) {
    const key = JSON.stringify([point.set.exerciseId, point.set.machineId]);
    const previous = best.get(key);
    point.record = !previous || compareStrength(point.set, previous, point.bodyweight) > 1e-9;
    if (point.record) best.set(key, point.set);
  }
  return points;
}

export function strengthTrend(points, weeks, date) {
  const cutoff = localDate(addDays(date, -7 * weeks));
  const baseline = points.findLast(point => point.date <= cutoff);
  const latest = points.at(-1);
  if (!baseline?.value || baseline === latest) return null;
  return latest.bodyweight ? latest.value - baseline.value : (latest.value / baseline.value - 1) * 100;
}

export function latestStrength(sets, sessions) {
  const history = new Map(), latest = new Map();
  for (const point of strengthSeries(sets, sessions)) {
    const {exerciseId, machineId} = point.set;
    const key = JSON.stringify([exerciseId, machineId]);
    const same = history.get(key) ?? [];
    same.push(point);
    history.set(key, same);
    latest.set(exerciseId, {point, same});
  }
  return [...latest.values()].sort((a, b) => b.point.session.start - a.point.session.start);
}

export function recentRecord(point, now) {
  const at = point.set.ts ?? +asDate(point.date);
  return point.record && at >= +addDays(now, -7) && at <= +asDate(now);
}

export function liftStall(history, slot, machine) {
  if (!slot) return null;
  const bodyweight = history.some(group => group.sets.some(bodyweightSet));
  const points = history.flatMap(({session, sets}) => {
    const set = bestSet(sets, bodyweight);
    return set ? [{session, sets, value: strengthValue(set, bodyweight)}] : [];
  });
  if (points.length < 3 || prescription(slot, points.at(-1).sets, machine).rule === 2) return null;
  let length = 1;
  for (let index = points.length - 1; index > 0; index--) {
    const current = points[index], previous = points[index - 1];
    if (current.value > previous.value + 1e-9 || !failedProgression(previous.sets, current.sets, slot, machine)) break;
    length++;
  }
  const step = stallStep(length);
  return step ? {step, since: points.at(-length).session.id} : null;
}

function failedProgression(previous, current, slot, machine) {
  const working = sets => sets.filter(set => !set.deleted && !set.parentId && set.type === 'working' && set.reps > 0);
  const byIndex = sets => new Map(working(sets).map((set, index) => [set.setIndex ?? index, set]));
  const before = byIndex(previous), after = byIndex(current);
  if ([...after].some(([index, set]) => before.has(index) && set.weight > before.get(index).weight && set.reps < slot.repMin)) return true;
  const {rule, targets} = prescription(slot, previous, machine);
  if (![3, 4, 5].includes(rule)) return false;
  return targets.some((target, index) => {
    const last = before.get(index), attempt = after.get(index);
    return last && attempt?.weight === target.weight && target.reps > last.reps && attempt.reps < target.reps;
  });
}

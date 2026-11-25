export const muscles = {
  pecho: 'Pecho', 'deltoide-ant': 'Deltoide anterior', 'deltoide-lat': 'Deltoide lateral',
  'deltoide-post': 'Deltoide posterior', biceps: 'Bíceps', triceps: 'Tríceps',
  antebrazo: 'Antebrazo', abdomen: 'Abdomen', dorsal: 'Dorsal', 'espalda-media': 'Espalda media',
  trapecio: 'Trapecio', gluteo: 'Glúteos', cuadriceps: 'Cuádriceps', isquios: 'Isquios',
  aductores: 'Aductores', pantorrilla: 'Pantorrillas'
};

export const number = (value, places = 1, minimum = 0) => new Intl.NumberFormat('es-VE', {
  maximumFractionDigits: places, minimumFractionDigits: minimum, useGrouping: 'always'
}).format(value);
export const plural = (count, singular, multiple = singular + 's') => count === 1 ? singular : multiple;
export const quantity = (count, singular, multiple) => number(count) + ' ' + plural(count, singular, multiple);

export const e1rm = (weight, reps) => weight * (1 + Math.min(reps, 15) / 30);
export const isHard = set => !set.deleted && ['working', 'drop', 'parcial', 'myo'].includes(set.type)
  && (set.rir == null || set.rir <= 3);
export const strengthValue = (set, bodyweight) => bodyweight ? set.reps : e1rm(set.weight, set.reps);
export const bodyweightSet = set => isHard(set) && set.reps > 0 && set.weight === 0;
export const compareStrength = (set, best, bodyweight) => strengthValue(set, bodyweight) - strengthValue(best, bodyweight)
  || (bodyweight ? set.weight - best.weight : 0);
export const bestSet = (sets, bodyweight = false) => sets.filter(set => isHard(set) && set.reps > 0)
  .reduce((best, set) => !best || compareStrength(set, best, bodyweight) > 0 ? set : best, null);

export function workingHistory(sets, sessions, exerciseId, machineId) {
  const completed = new Map(sessions.filter(row => row.end && !row.deleted).map(row => [row.id, row]));
  const groups = new Map();
  for (const set of sets) {
    if (set.deleted || set.exerciseId !== exerciseId || set.machineId !== machineId || !completed.has(set.sessionId)) continue;
    const group = groups.get(set.sessionId) ?? {session: completed.get(set.sessionId), sets: []};
    group.sets.push(set);
    groups.set(set.sessionId, group);
  }
  return [...groups.values()].sort((a, b) => +new Date(a.session.start) - +new Date(b.session.start))
    .map(group => ({...group, sets: group.sets.sort((a, b) => a.setIndex - b.setIndex || a.ts - b.ts)}));
}

export function stallLength(values) {
  let start = values.length - 1;
  while (start > 0 && values[start] <= values[start - 1] + 1e-9) start--;
  return values.length - Math.max(0, start);
}

export const stalled = values => stallLength(values) >= 3;
export const stallStep = length => length < 3 ? null
  : ['range', 'technique', 'substitute', 'deload'][Math.min(3, Math.floor((length - 3) / 2))];

export function beatLast(set, previous) {
  if (!previous || previous.deleted || set.type === 'aguante' || previous.type === 'aguante'
    || set.setIndex !== previous.setIndex || set.exerciseId !== previous.exerciseId
    || set.machineId !== previous.machineId || set.unit !== previous.unit) return null;
  if (set.weight === previous.weight && set.reps > previous.reps) {
    return '+' + quantity(set.reps - previous.reps, 'rep');
  }
  if (set.weight > previous.weight && set.reps >= previous.reps) {
    return '+' + number(set.weight - previous.weight, 3) + ' ' + set.unit;
  }
  return null;
}

export const range = (min, max) => min === max ? String(min) : min + '–' + max;
export const rirRange = slot => [...new Set(slot.rir ?? [0])].map(value => value === 3 ? '3+' : value).join('–');
export const workingSets = (slot, appDeload = false) => Math.max(0, slot.sets - Number(appDeload === true));

export function prescription(slot, history, machine, kind = 'normal', appDeload = false) {
  const working = history.filter(set => !set.deleted && !set.parentId && set.type === 'working' && set.reps > 0);
  const byIndex = new Map();
  for (const [index, set] of working.entries()) {
    const key = set.setIndex ?? index;
    if (!byIndex.has(key)) byIndex.set(key, set);
  }
  const load = working.at(-1)?.weight ?? null;
  const {repMin, repMax} = slot;
  const increment = machine?.increment || 0;
  const unit = machine?.unit ?? 'kg';
  const setCount = workingSets(slot, appDeload);
  const previous = Array.from({length: setCount}, (_, index) => byIndex.get(index));
  const base = {load, reps: repMax, setCount, rir: slot.rir ?? [0], rule: 1, chip: 'elige peso',
    reason: 'Elige un peso para ' + range(repMin, repMax) + ' reps · RIR ' + rirRange(slot)};
  const result = (fields = {}, target = () => ({})) => {
    const next = {...base, ...fields};
    return {...next, targets: previous.map((last, index) => ({
      weight: next.load, reps: next.reps, rir: next.rir[index] ?? next.rir.at(-1) ?? 0, ...target(last, index)
    }))};
  };
  if (kind !== 'normal' || appDeload) return result({rule: 6, rir: appDeload ? [3, 2] : base.rir,
    chip: kind === 'deload' || appDeload ? 'descarga' : 'intro',
    reason: (kind === 'deload' || appDeload ? 'Semana de descarga' : 'Semana de introducción')
      + (appDeload ? ' · una serie menos' : '') + ' · mantén la carga si ya la tienes · RIR '
      + (appDeload ? '2–3' : rirRange(slot))}, last => ({weight: last?.weight ?? load}));
  if (load == null || !setCount) return result();
  if (machine?.max != null && load >= machine.max) {
    return result({rule: 4, reps: repMax + 1, chip: 'más reps', reason: 'Tope de pila. Suma reps.'},
      last => ({reps: last?.weight === load ? last.reps + 1 : repMin}));
  }
  const next = Math.min(machine?.max ?? Infinity, Number((load + increment).toFixed(6)));
  const best = bestSet(working);
  if (next > load && previous.every(set => set?.reps >= repMax)) {
    if (best && 30 * (e1rm(best.weight, best.reps) / next - 1) + 1e-9 < repMin) {
      return result({rule: 3, reps: repMax + 2, chip: 'más reps',
        reason: 'El siguiente salto te sacaría del rango. Mantén el peso y apunta a ' + (repMax + 2) + ' reps.'},
      last => ({weight: last?.weight ?? load}));
    }
    const jump = '+' + number(next - load, 3) + ' ' + unit;
    return result({load: next, reps: repMin, rule: 2, chip: jump,
      reason: 'Llegaste al tope (' + repMax + ') en ' + (slot.sets === 1 ? 'la única serie' : 'todas las series') + ' → ' + jump});
  }
  const missed = previous.findIndex(set => set && set.reps < repMax);
  const missing = previous.indexOf(undefined);
  const index = missed >= 0 ? missed : missing >= 0 ? missing : setCount - 1;
  const reps = previous[index] ? previous[index].reps + 1 : repMin;
  return result({load: previous[index]?.weight ?? load, rule: 5, reps, chip: 'más reps',
    reason: 'Suma una rep en la serie ' + (index + 1)}, (last, i) => ({
    weight: last?.weight ?? load, reps: i === index ? reps : last?.reps ?? repMin
  }));
}

export function stepLoad(value, direction, machine) {
  return Math.max(machine?.min ?? 0, Math.min(machine?.max ?? Infinity,
    Number(((value ?? 0) + direction * (machine?.increment || 1)).toFixed(6))));
}

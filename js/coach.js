import {isHard, muscles, number, plural, quantity, workingHistory, workingSets} from './engine.js';
import {addDays, asDate, dose, gaps, isoWeek, liftStall, localDate, monday, strengthSeries, weighIns, weightRate} from './metrics.js';

export {workingSets};
export const defaultMRV = 20;
export const coachSettings = (options = {}) => ({
  autoVolume: options.autoVolume !== false,
  sessionSetCap: options.sessionSetCap ?? 24,
  muscleSessionCap: options.muscleSessionCap ?? 10,
  mrv: Object.fromEntries(Object.keys(muscles).map(key => [key, options.mrv?.[key] ?? defaultMRV]))
});
export const weekId = date => addDays(monday(date), 3).getFullYear() + '-W' + String(isoWeek(date)).padStart(2, '0');
export const weekStart = id => addDays(monday(id.slice(0, 4) + '-01-04'), (Number(id.slice(6)) - 1) * 7);
export const shiftWeek = (id, offset) => weekId(addDays(weekStart(id), 7 * offset));
export const planId = (id, programId, programWeek) => [programId, id, programWeek].join(':');
export const feedbackId = (sessionId, muscle) => [sessionId, muscle].join(':');
export const targetId = (id, programId, programWeek, muscle) => [planId(id, programId, programWeek), muscle].join(':');

const primary = weights => Object.keys(weights).filter(key => weights[key] === 1);
const lower = new Set(['gluteo', 'cuadriceps', 'isquios', 'aductores', 'pantorrilla']);
const group = name => {
  if (/\b(upper|torso|arms?|delts?|brazos?|hombros?|superior(?:es)?)\b/i.test(name)) return 'upper';
  if (/\b(lower|legs?|piernas?|inferior(?:es)?)\b/i.test(name)) return 'lower';
  return '';
};
const weightsFor = (slot, exercises) => slot.muscles ?? exercises.get(slot.exerciseId)?.muscles ?? {};
export function sessionAppDeload(session, data) {
  if (session.appDeload != null) return session.appDeload;
  if (session.kind !== 'deload') return false;
  const week = data.programs.find(row => row.id === session.programId)?.weeks.find(row => row.n === session.week);
  return week?.kind === 'normal'
    && data.options['deload:' + planId(session.isoWeek ?? weekId(session.date), session.programId, session.week)] === 'accepted';
}
const originId = ({dayIndex, slotIndex}) => dayIndex + ':' + slotIndex;
const targetNumber = entry => typeof entry === 'number' ? entry : entry?.sets ?? 0;
function groupBy(items, keyFor) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFor(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

export function planWeek(programWeek, daysAvailable, targets = {}, doneThisWeek = {}, caps = {}) {
  const {sessionSetCap = 24, muscleSessionCap = 10, exercises = []} = caps;
  const catalog = new Map(exercises.map(exercise => [exercise.id, exercise]));
  const doneDays = new Set(doneThisWeek.dayIndices ?? []);
  const doneOrigins = new Set(doneThisWeek.origins ?? []);
  const days = programWeek.days.map((day, dayIndex) => ({dayIndex, name: day.name,
    slots: day.slots.map((slot, slotIndex) => ({addedSets: 0, reason: '', ...slot, origin: slot.origin ?? {dayIndex, slotIndex}}))
      .filter(slot => workingSets(slot, programWeek.appDeload) > 0 && !doneOrigins.has(originId(slot.origin)))}))
    .filter(day => !doneDays.has(day.dayIndex) && day.slots.length);
  const budget = Math.max(0, daysAvailable - (doneThisWeek.dayCount ?? doneDays.size));
  if (budget >= days.length) return {plan: days, dropped: []};

  const anchors = days.slice(0, budget).map(day => ({...day, slots: [], total: 0, dose: {},
    muscleKeys: new Set(day.slots.flatMap(slot => Object.keys(weightsFor(slot, catalog))))}));
  const ranked = days.flatMap((day, order) => day.slots.map(slot => {
    const weights = weightsFor(slot, catalog), keys = Object.keys(weights);
    const main = primary(weights).length ? primary(weights) : keys;
    const ratios = main.map(key => {
      const target = targetNumber(targets[key]);
      return {key, ratio: target ? (target - (doneThisWeek.sets?.[key] ?? 0)) / target : 1};
    }).sort((a, b) => b.ratio - a.ratio);
    const focus = ratios[0];
    return {slot, day, order, weights, sets: workingSets(slot, programWeek.appDeload), focus,
      met: !!focus && focus.ratio <= 0, compound: keys.length >= 2};
  }));
  const priority = (a, b) => Number(b.met) - Number(a.met) || Number(a.compound) - Number(b.compound)
    || (a.focus?.ratio ?? 1) - (b.focus?.ratio ?? 1);
  const rejected = [];
  // Fill scarce capacity with the highest priorities first, breaking ties in program order.
  for (const item of ranked.toSorted((a, b) => priority(b, a))) {
    const {slot, day, order, weights, sets} = item;
    const keys = Object.keys(weights);
    const named = group(day.name);
    const side = named || (keys.length && keys.every(key => lower.has(key)) ? 'lower'
      : keys.length && keys.every(key => !lower.has(key)) ? 'upper' : '');
    const fixed = anchors[order];
    const matching = side ? anchors.filter(anchor => group(anchor.name) === side) : [];
    const neutral = side ? anchors.filter(anchor => !group(anchor.name)) : [];
    const candidates = fixed ? [fixed] : matching.length ? [...matching, ...neutral] : anchors;
    const overlap = anchor => keys.filter(key => anchor.muscleKeys.has(key)).length;
    const ordered = candidates.toSorted((a, b) => (matching.length && !fixed
      ? Number(!group(a.name)) - Number(!group(b.name)) || overlap(a) - overlap(b) : 0) || a.total - b.total);
    const fitsTotal = ordered.filter(anchor => anchor.total + sets <= sessionSetCap);
    const chosen = fitsTotal.find(anchor => keys.every(key => (anchor.dose[key] ?? 0) + weights[key] * sets <= muscleSessionCap));
    if (!chosen) {
      rejected.push({...item, reason: item.met ? (muscles[item.focus.key] ?? item.focus.key) + ' ya en meta'
        : !anchors.length ? 'Sin días disponibles'
        : !fitsTotal.length ? 'No cabe con el tope de ' + quantity(sessionSetCap, 'serie') + ' por sesión'
        : 'No cabe con el tope de ' + quantity(muscleSessionCap, 'serie') + ' por músculo'});
      continue;
    }
    chosen.total += sets;
    for (const key of keys) {
      chosen.dose[key] = (chosen.dose[key] ?? 0) + weights[key] * sets;
      chosen.muscleKeys.add(key);
    }
    chosen.slots.push(fixed ? slot : {...slot, reason: 'movido de ' + day.name});
  }
  return {
    plan: anchors.filter(day => day.slots.length).map(({dayIndex, name, slots}) => ({
      dayIndex, name, slots: slots.sort((a, b) => a.origin.dayIndex - b.origin.dayIndex || a.origin.slotIndex - b.origin.slotIndex)
    })),
    dropped: rejected.sort(priority).map(({slot, focus, reason}) => ({exerciseId: slot.exerciseId, muscle: focus?.key ?? null, reason}))
  };
}

const worst = (values, order) => order.find(value => values.includes(value));
const pumpOrder = ['poco', 'bien', 'mucho'];
const performanceOrder = ['baja', 'igual', 'sube'];

function recoveryRule(rows) {
  const soreness = worst(rows.map(row => row.soreness), ['adolorido', 'justo', 'sano']);
  const performance = worst(rows.map(row => row.performance), performanceOrder);
  const pumps = rows.map(row => pumpOrder.indexOf(row.pump)).filter(index => index >= 0).sort();
  const pump = pumps.length ? pumpOrder[Math.floor((pumps[Math.floor((pumps.length - 1) / 2)] + pumps[Math.floor(pumps.length / 2)]) / 2)] : null;
  if (!soreness || !performance) return [0, 'Faltan datos de recuperación o rendimiento'];
  if (soreness === 'adolorido') return performance === 'baja' ? [-2, 'Llegó adolorido y bajó el rendimiento', true] : [-1, 'Llegó adolorido'];
  if (performance === 'baja') return soreness === 'justo'
    ? [-1, 'Llegó justo y bajó el rendimiento'] : [0, 'Llegó sano y bajó el rendimiento. Revisa la técnica.'];
  if (!pump) return [0, 'Falta registrar el bombeo'];
  if (soreness === 'justo') return pump === 'poco' ? [1, 'Llegó justo, rindió y tuvo poco bombeo']
    : [0, 'Llegó justo, rindió y tuvo ' + (pump === 'mucho' ? 'mucho' : 'buen') + ' bombeo'];
  return pump === 'poco' ? [2, 'Llegó sano, rindió y tuvo poco bombeo'] : [1, 'Llegó sano y rindió'];
}

export function nextTargets(base, current, feedbackThisWeek, doneLastWeek, mrv = {}, {kind = 'normal', enabled = true} = {}) {
  let increasesLeft = 8;
  const grouped = groupBy(feedbackThisWeek.filter(row => !row.deleted), row => row.muscle);
  return Object.fromEntries(Object.entries(base).filter(([, value]) => value > 0).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
    const previous = targetNumber(current[key]) || value;
    if (kind !== 'normal' || !enabled) {
      return [key, {sets: value, base: value, delta: value - previous,
        reasons: [kind === 'deload' ? 'Semana de descarga. Se usa la meta base.' : kind === 'intro'
          ? 'Semana de introducción. Se usa la meta base.' : 'Volumen autorregulado desactivado. Se usa la meta base.']}];
    }
    const rows = grouped.get(key);
    if (!rows?.length) return [key, {sets: previous, base: value, delta: 0, reasons: [...new Set([
      ...(previous !== value ? current[key]?.reasons ?? [] : []), 'Sin feedback esta semana. Se mantiene la meta.'
    ])]}];
    const [change, reason, recovery] = recoveryRule(rows);
    const done = doneLastWeek[key] ?? 0;
    const belowThreshold = done < .8 * previous;
    const min = Math.max(2, value - 2), max = Math.max(min, mrv[key] ?? defaultMRV);
    const requested = previous + (belowThreshold ? Math.min(change, 0) : change);
    const clamped = Math.min(max, Math.max(min, requested));
    const sets = Math.min(clamped, previous + (belowThreshold ? 0 : increasesLeft));
    increasesLeft -= Math.max(0, sets - previous);
    const reasons = [belowThreshold && sets === previous && (change > 0 || clamped > previous)
      ? 'No se completó la meta (' + number(done) + ' de ' + number(previous) + '): se mantiene' : reason];
    if (requested < min) reasons.push('Mínimo de ' + quantity(min, 'serie'));
    if (requested > max) reasons.push('MRV de ' + quantity(max, 'serie'));
    if (!belowThreshold && clamped > sets) reasons.push('Tope semanal de +8 series');
    return [key, {sets, base: value, delta: sets - previous, reasons, ...(recovery ? {recovery: true} : {})}];
  }));
}

export function adjustSlots(week, targets, exercises) {
  const catalog = new Map(exercises.map(row => [row.id, row]));
  const slots = week.days.map((day, dayIndex) => day.slots.map((slot, slotIndex) => ({
    ...slot, origin: {dayIndex, slotIndex}, addedSets: 0
  })));
  const flat = slots.flat().map(slot => ({slot, weights: weightsFor(slot, catalog)}));
  flat.sort((a, b) => Object.keys(a.weights).length - Object.keys(b.weights).length);
  const remaining = Object.fromEntries(Object.entries(targets).map(([key, {sets, base}]) => [key, week.kind === 'normal' ? sets - base : 0]));
  for (const [key, target] of Object.entries(targets)) {
    for (const {slot, weights} of flat) {
      if (!remaining[key] || weights[key] !== 1) continue;
      const sign = Math.sign(remaining[key]);
      if (slot.addedSets && Math.sign(slot.addedSets) !== sign) continue;
      const adjustment = Math.min(Math.floor(Math.abs(remaining[key])), 2 - Math.abs(slot.addedSets), sign < 0 ? slot.sets : Infinity);
      if (!adjustment) continue;
      slot.sets += sign * adjustment;
      slot.addedSets += sign * adjustment;
      slot.volumeReason = [...new Set([...(slot.volumeReason ?? []), ...target.reasons])];
      for (const [muscle, credit] of Object.entries(weights)) {
        if (Math.sign(remaining[muscle]) !== sign) continue;
        remaining[muscle] = sign * Math.max(0, Math.abs(remaining[muscle]) - adjustment * credit);
      }
    }
  }
  return {...week, days: week.days.map((day, index) => ({...day, slots: slots[index]}))};
}

const liftKey = set => JSON.stringify([set.exerciseId, set.machineId ?? null]);
const percentChange = (current, previous) => (current / previous - 1) * 100;
export const performanceLevel = change => change > .5 + 1e-9 ? 'sube' : change < -1 - 1e-9 ? 'baja' : 'igual';

export function sessionPerformance(session, data) {
  const eligible = data.sets.filter(set => !set.deleted);
  const previousSessions = data.sessions.filter(row => row.end && !row.deleted && row.start < session.start);
  const points = strengthSeries(eligible, [...previousSessions, {...session, end: session.end ?? session.start + 1}]);
  const history = new Map(), results = [];
  for (const point of points) {
    const key = liftKey(point.set);
    const previous = history.get(key);
    if (point.session.id === session.id) {
      if (previous?.value > 0) {
        const change = percentChange(point.value, previous.value);
        results.push({exerciseId: point.set.exerciseId, machineId: point.set.machineId ?? null, change, performance: performanceLevel(change)});
      }
    } else history.set(key, point);
  }
  return results;
}

export function musclePerformance(session, data) {
  const catalog = new Map(data.exercises.map(row => [row.id, row]));
  const best = {};
  for (const result of sessionPerformance(session, data)) {
    for (const key of primary(catalog.get(result.exerciseId)?.muscles ?? {})) {
      best[key] = Math.max(best[key] ?? -Infinity, result.change);
    }
  }
  return Object.fromEntries(Object.entries(best).map(([key, change]) => [key, performanceLevel(change)]));
}

export function feedbackPositions(session, exercises, sets, appDeload = session.appDeload) {
  const catalog = new Map(exercises.map(row => [row.id, row]));
  const logged = groupBy(sets.filter(set => !set.deleted && set.sessionId === session.id && !set.parentId && set.type !== 'warmup'), set => set.slotId);
  const positions = {};
  for (const slot of session.slots) {
    const expected = slot.archived ? 0 : workingSets(slot, appDeload);
    if (!expected) continue;
    for (const key of primary(weightsFor(slot, catalog))) {
      const position = positions[key] ??= {first: slot.key, last: slot.key, ready: true};
      position.last = slot.key;
      const counted = new Set((logged.get(slot.key) ?? []).filter(set => set.setIndex < expected).map(set => set.setIndex)).size;
      position.ready &&= counted >= expected;
    }
  }
  return positions;
}

export function deloadProposal(recovery, performances, lastWeek = false) {
  const reasons = [];
  if (recovery.length >= 2) reasons.push('Recuperación comprometida en ' + recovery.map(key => muscles[key] ?? key).join(', '));
  const lower = performances.filter(result => result.performance === 'baja').length;
  if (lower / performances.length > .3) reasons.push(number(100 * lower / performances.length, 0)
    + ' % de las comparaciones bajaron en las últimas dos sesiones (' + lower + ' de ' + performances.length + ')');
  if (lastWeek) reasons.push('Última semana del mesociclo');
  return reasons;
}

export function programWeekAt(data, program, id) {
  if (!program) return null;
  const anchor = data.options.programWeekAnchor;
  const selected = Math.max(0, program.weeks.findIndex(row => row.n === (anchor?.programId === program.id ? anchor.programWeek : data.options.activeWeek)));
  if (anchor?.programId !== program.id || id < anchor.isoWeek) return program.weeks[selected];
  const elapsed = Math.round((weekStart(id) - weekStart(anchor.isoWeek)) / (7 * 86400000));
  return program.weeks[Math.min(program.weeks.length - 1, selected + elapsed)];
}

export const completedWeek = (id, sessions) => sessions.filter(row => row.end && !row.deleted && weekId(row.date) === id);
export function weekFeedback(id, data) {
  const sessions = completedWeek(id, data.sessions);
  const byId = new Map(sessions.map(row => [row.id, row]));
  const computed = new Map();
  return (data.feedback ?? []).filter(row => !row.deleted && byId.has(row.sessionId)).map(row => {
    if (!computed.has(row.sessionId)) computed.set(row.sessionId, musclePerformance(byId.get(row.sessionId), data));
    return {...row, performance: computed.get(row.sessionId)[row.muscle] ?? row.performance};
  });
}

export function volumeForWeek(id, data, program, week, previousTargets, historical = false) {
  if (!program || !week) return {};
  const settings = coachSettings(data.options);
  const stored = (data.volumeTargets ?? []).filter(row => !row.deleted && row.isoWeek === id
    && row.programId === program.id && row.programWeek === week.n);
  if (stored.length && (historical || (stored.length === Object.values(program.targets).filter(value => value > 0).length
    && stored.every(row => row.base === program.targets[row.muscle] && row.enabled === settings.autoVolume && row.kind === week.kind
      && row.mrv === settings.mrv[row.muscle])))) return Object.fromEntries(stored.map(row => [row.muscle, row]));
  const past = (data.volumeTargets ?? []).filter(row => !row.deleted && row.programId === program.id && row.isoWeek < id)
    .sort((a, b) => a.isoWeek.localeCompare(b.isoWeek) || (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
  const previous = previousTargets ?? Object.fromEntries(past.map(row => [row.muscle, row]));
  const lastWeek = shiftWeek(id, -1);
  const {done} = dose(data.sets, data.exercises, completedWeek(lastWeek, data.sessions), weekStart(lastWeek));
  return nextTargets(program.targets, previous, weekFeedback(lastWeek, data), done, settings.mrv,
    {kind: week.kind, enabled: settings.autoVolume});
}

function doneForPlan(data, id, program, week) {
  const sessions = completedWeek(id, data.sessions);
  const aligned = sessions.filter(row => row.programId === program.id && row.week === week.n && Number.isInteger(row.dayIndex));
  return {
    dayIndices: [...new Set(aligned.map(row => row.dayIndex))],
    origins: aligned.flatMap(row => (row.slots ?? []).filter(slot => slot.origin).map(slot => originId(slot.origin))),
    sets: dose(data.sets, data.exercises, sessions, weekStart(id)).done
  };
}

export function buildWeekPlan({data, program, week, id, daysAvailable, from, targets, previous, rescue = false}) {
  const done = doneForPlan(data, id, program, week);
  const offset = Math.max(0, (asDate(from).getDay() + 6) % 7);
  const remaining = 7 - offset;
  const budget = Math.min(daysAvailable, done.dayIndices.length + remaining);
  const caps = coachSettings(data.options);
  const result = planWeek(adjustSlots(week, targets, data.exercises), budget, targets, done, {...caps, exercises: data.exercises});
  const start = weekStart(id);
  const plan = result.plan.map((day, i) => ({...day, date: localDate(addDays(start, offset + Math.min(remaining - 1, Math.floor(i * remaining / result.plan.length))))}));
  const completed = (previous?.plan ?? []).filter(day => done.dayIndices.includes(day.dayIndex)).map(day => ({
    ...day, kind: day.kind ?? previous.kind,
    appDeload: day.appDeload ?? previous.appDeload ?? (week.appDeload && (day.kind ?? previous.kind) === 'deload')
  }));
  return {id: planId(id, program.id, week.n), isoWeek: id, programId: program.id, programWeek: week.n, kind: week.kind,
    appDeload: !!week.appDeload, daysAvailable, plan: [...completed, ...plan], dropped: result.dropped, planned: done.dayIndices.length + plan.length,
    rescued: rescue || !!previous?.rescued, createdAt: previous?.createdAt ?? +asDate(from),
    basis: JSON.stringify([week.kind, !!week.appDeload, caps.sessionSetCap, caps.muscleSessionCap, program.updatedAt ?? 0,
      Object.entries(targets).map(([key, row]) => [key, row.sets, row.reasons]).sort()])};
}

export function plannedWeek(id, data) {
  return (data.weekPlans ?? []).filter(row => row.isoWeek === id && !row.deleted)
    .toSorted((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))[0];
}

export function weekContext(data, date, program = data.programs.find(row => row.active), {historical = false} = {}) {
  const id = weekId(date);
  const archived = historical ? plannedWeek(id, data) : null;
  if (archived) program = data.programs.find(row => row.id === archived.programId) ?? program;
  const original = program?.weeks.find(row => row.n === archived?.programWeek) ?? programWeekAt(data, program, id);
  if (!original) return {id, targets: {}, targetRows: {}, daysLeft: 7 - (asDate(date).getDay() + 6) % 7};
  const key = planId(id, program.id, original.n);
  const storedPlan = (data.weekPlans ?? []).find(row => row.id === key && !row.deleted);
  const decision = data.options['deload:' + key];
  const appDeload = original.kind === 'normal' && (archived?.appDeload ?? (decision === 'accepted'));
  const week = {...original, kind: appDeload ? 'deload' : original.kind, appDeload};
  const targetRows = volumeForWeek(id, data, program, week, undefined, historical);
  const targets = Object.fromEntries(Object.entries(targetRows).map(([muscle, row]) => [muscle, row.sets]));
  const done = doneForPlan(data, id, program, week);
  const preferred = Math.max(3, Math.min(6, program.sessionsPerWeek));
  const start = weekStart(id);
  const from = storedPlan?.plan.find(day => !done.dayIndices.includes(day.dayIndex))?.date ?? date;
  const built = buildWeekPlan({data, program, week, id, daysAvailable: storedPlan?.daysAvailable ?? preferred,
    from, targets: targetRows, previous: storedPlan});
  const plan = storedPlan?.basis === built.basis ? storedPlan : built;
  const pending = plan.plan.filter(day => !done.dayIndices.includes(day.dayIndex));
  return {id, program, week, original, decision, targetRows, targets, done,
    plan, pending, storedPlan, daysLeft: 7 - (asDate(date).getDay() + 6) % 7,
    missed: !!storedPlan && pending.some(day => day.date < localDate(asDate(date))), defaultDays: preferred, start};
}

export function proposalForWeek(id, data, program, week, through = localDate(addDays(weekStart(id), 6))) {
  if (!program || week?.kind !== 'normal' || !coachSettings(data.options).autoVolume) return [];
  const recovery = [id, shiftWeek(id, -1)].map(key => {
    const feedback = weekFeedback(key, data).filter(row => data.sessions.some(session => session.id === row.sessionId && session.date <= through));
    return [...groupBy(feedback, row => row.muscle)].filter(([, rows]) => recoveryRule(rows)[2]).map(([muscle]) => muscle);
  }).sort((a, b) => b.length - a.length)[0];
  const recent = data.sessions.filter(row => row.end && !row.deleted && row.date <= through)
    .toSorted((a, b) => b.start - a.start).slice(0, 2);
  return deloadProposal(recovery, recent.flatMap(session => sessionPerformance(session, data)), program.weeks.at(-1)?.n === week.n);
}

export function summaryVisible(date, plan, sessions, planned) {
  if (asDate(date).getDay() === 0) return true;
  const completed = completedWeek(weekId(date), sessions).filter(row => row.date <= localDate(asDate(date)));
  const last = plan?.plan.at(-1);
  if (!last) return !plan && planned > 0 && completed.length >= planned;
  return completed.some(row => row.dayIndex === last.dayIndex && row.programId === plan.programId && row.week === plan.programWeek);
}

export function summarySentence(count, planned, deficits, records) {
  if (planned && count >= planned) return 'Buena semana. ' + count + ' de ' + quantity(planned, 'sesión', 'sesiones') + ' y ' + quantity(records, 'récord', 'récords') + '.';
  if (planned && count / planned < .5) return 'Completaste ' + count + ' de ' + quantity(planned, 'sesión', 'sesiones')
    + '. Elige cuántos días tienes para la próxima semana.';
  if (deficits.length) {
    const top = deficits.slice(0, 2);
    const achieved = top.reduce((total, row) => total + row.done, 0) / top.reduce((total, row) => total + row.target, 0);
    return 'Prioriza ' + top.map(row => muscles[row.key].toLowerCase()).join(' y ') + '. ' + plural(top.length, 'Quedó', 'Quedaron') + ' en ' + number(achieved * 100, 0) + ' % de la meta.';
  }
  return 'Mantén las metas y elige los días que puedas entrenar la próxima semana.';
}

export function weekSummary(id, data) {
  const start = weekStart(id), end = localDate(addDays(start, 6));
  const sessions = completedWeek(id, data.sessions);
  const plan = plannedWeek(id, data);
  const program = data.programs.find(row => row.id === plan?.programId) ?? data.programs.find(row => row.active);
  const week = program?.weeks.find(row => row.n === plan?.programWeek) ?? programWeekAt(data, program, id);
  const kind = week?.kind === 'normal' && (plan?.appDeload ?? (data.options['deload:' + planId(id, program?.id, week.n)] === 'accepted'))
    ? 'deload' : week?.kind;
  const planned = plan?.planned ?? program?.sessionsPerWeek ?? 0;
  const previousTargets = volumeForWeek(id, data, program, week && {...week, kind}, undefined, true);
  const targets = Object.fromEntries(Object.entries(previousTargets).map(([key, row]) => [key, row.sets]));
  const {done, total} = dose(data.sets, data.exercises, sessions, start);
  const deficits = gaps(done, targets).slice(0, 3);
  const sessionIds = new Set(sessions.map(row => row.id));
  const lifts = groupBy(strengthSeries(data.sets, data.sessions.filter(row => row.date <= end)), point => liftKey(point.set));
  const plannedSlots = [...(plan?.plan ?? []), ...(week?.days ?? [])].flatMap(day => day.slots);
  const gains = [], stalls = [], recordPoints = [];
  for (const points of lifts.values()) {
    const first = points.findIndex(point => sessionIds.has(point.session.id));
    if (first < 0) continue;
    const recent = points.slice(first);
    const prior = points[first - 1];
    const lift = {exerciseId: points[0].set.exerciseId, machineId: points[0].set.machineId ?? null, unit: points[0].set.unit};
    recordPoints.push(...recent.filter((point, index) => first + index > 0 && point.record));
    const fallback = plannedSlots.find(slot => slot.exerciseId === lift.exerciseId);
    const machine = data.machines?.find(row => row.id === lift.machineId);
    const history = workingHistory(data.sets, points.map(point => point.session), lift.exerciseId, lift.machineId);
    if (recent.some(point => {
      if ((point.session.kind && point.session.kind !== 'normal') || point.session.appDeload) return false;
      const slot = point.session.slots?.find(row => row.key === point.set.slotId) ?? fallback;
      if (!slot) return false;
      const index = history.findIndex(group => group.session.id === point.session.id);
      return liftStall(history.slice(0, index + 1), slot, machine) && !liftStall(history.slice(0, index), slot, machine);
    })) stalls.push(lift);
    if (!prior?.value || recent[0].bodyweight) continue;
    const value = Math.max(...recent.map(point => point.value));
    if (value > prior.value) gains.push({...lift, delta: value - prior.value, percent: percentChange(value, prior.value)});
  }
  const next = shiftWeek(id, 1);
  const nextWeek = programWeekAt(data, program, next);
  const nextKind = nextWeek?.kind === 'normal' && data.options['deload:' + planId(next, program?.id, nextWeek.n)] === 'accepted'
    ? 'deload' : nextWeek?.kind;
  const nextVolume = volumeForWeek(next, data, program, nextWeek && {...nextWeek, kind: nextKind}, previousTargets, true);
  const changes = Object.entries(nextVolume).filter(([, row]) => row.delta !== 0);
  const weights = weighIns(data.body);
  const mean = key => {
    const rows = weights.filter(row => weekId(row.date) === key);
    return rows.length ? rows.reduce((sum, row) => sum + row.weight, 0) / rows.length : null;
  };
  const average = mean(id), last = mean(shiftWeek(id, -1));
  const records = recordPoints.length;
  return {id, start: localDate(start), end, count: sessions.length, planned, done, total, targets, deficits, records,
    recordPoints: recordPoints.sort((a, b) => a.set.ts - b.set.ts),
    gains: gains.sort((a, b) => b.percent - a.percent).slice(0, 3), stalls, changes, next,
    proposal: proposalForWeek(id, data, program, week), average, weightChange: average != null && last != null ? average - last : null,
    rate: weightRate(weights, end), phase: data.phases.filter(row => row.start <= end && !row.deleted).toSorted((a, b) => b.start.localeCompare(a.start))[0]?.kind,
    sentence: summarySentence(sessions.length, planned, deficits, records)};
}

export function mesocycle(program, data, isoWeek) {
  const current = programWeekAt(data, program, isoWeek);
  const anchor = data.options.programWeekAnchor;
  const anchored = anchor?.programId === program.id;
  const baseWeek = anchored ? anchor.isoWeek : isoWeek;
  const baseIndex = program.weeks.findIndex(week => week.n === (anchored ? anchor.programWeek : current.n));
  const phase = (data.phases ?? []).filter(row => !row.deleted && row.start <= localDate(addDays(weekStart(isoWeek), 6)))
    .toSorted((a, b) => b.start.localeCompare(a.start))[0];
  return {
    current: current.n, phase: phase?.kind, rate: weightRate(data.body ?? [], addDays(weekStart(isoWeek), 6)),
    weeks: program.weeks.map((week, index) => {
      const id = shiftWeek(baseWeek, index - baseIndex);
      const plan = (data.weekPlans ?? []).find(row => row.id === planId(id, program.id, week.n) && !row.deleted);
      const kind = plan?.kind ?? (data.options['deload:' + planId(id, program.id, week.n)] === 'accepted' ? 'deload' : week.kind);
      const slots = week.days.flatMap(day => day.slots);
      const done = data.sessions.filter(row => row.end && !row.deleted && row.programId === program.id && row.week === week.n);
      return {n: week.n, isoWeek: id, kind, block: week.block, rir: [...new Set(slots.flatMap(slot => slot.rir ?? []))].sort((a, b) => b - a),
        sets: slots.reduce((total, slot) => total + slot.sets, 0), done: done.length, planned: plan?.planned ?? week.days.length,
        complete: week.n < current.n || done.length >= (plan?.planned ?? week.days.length)};
    })
  };
}

export function periodSummary(data, from, to) {
  const priorTo = localDate(addDays(from, -1));
  const monthSpan = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
  const prior = asDate(from);
  prior.setDate(1);
  prior.setMonth(prior.getMonth() - monthSpan);
  const sessions = data.sessions.filter(row => row.end && !row.deleted && row.date <= to);
  const current = sessions.filter(row => row.date >= from);
  const previous = sessions.filter(row => row.date >= localDate(prior) && row.date <= priorTo);
  const ids = new Set(current.map(row => row.id));
  const minutes = rows => Math.round(rows.reduce((total, row) => total + Math.max(0, row.end - row.start), 0) / 60000);
  const lifts = groupBy(strengthSeries(data.sets, sessions), point => liftKey(point.set));
  const gains = [], records = [];
  for (const points of lifts.values()) {
    const inside = points.filter(point => ids.has(point.session.id));
    if (!inside.length) continue;
    const first = points.indexOf(inside[0]);
    records.push(...inside.filter((point, index) => first + index > 0 && point.record));
    const baseline = points[first - 1] ?? inside[0];
    const best = inside.reduce((a, b) => b.value > a.value ? b : a);
    if (!best.bodyweight && baseline.value > 0 && best.value > baseline.value) {
      gains.push({exerciseId: best.set.exerciseId, machineId: best.set.machineId, unit: best.set.unit,
        percent: percentChange(best.value, baseline.value), delta: best.value - baseline.value});
    }
  }
  const {done} = dose(data.sets, data.exercises, current);
  const trained = Object.keys(muscles).map(key => ({key, sets: done[key] ?? 0})).sort((a, b) => b.sets - a.sets);
  const hardSets = data.sets.filter(set => ids.has(set.sessionId) && isHard(set) && set.reps > 0);
  const kilograms = set => set.weight * (set.unit === 'lb' ? .45359237 : 1);
  const heaviest = hardSets.filter(set => ['kg', 'lb'].includes(set.unit) && set.weight > 0).sort((a, b) => kilograms(b) - kilograms(a))[0];
  const bestMonth = [...groupBy(current, row => row.date.slice(0, 7))].sort((a, b) => b[1].length - a[1].length)[0];
  const favorite = [...groupBy(hardSets, row => row.exerciseId)].map(([exerciseId, sets]) => ({
    exerciseId, sessions: new Set(sets.map(set => set.sessionId)).size, sets: sets.length
  })).sort((a, b) => b.sessions - a.sessions || b.sets - a.sets)[0];
  const weights = weighIns(data.body ?? []).filter(row => row.date >= from && row.date <= to);
  return {from, to, count: current.length, minutes: minutes(current), previousCount: previous.length, previousMinutes: minutes(previous),
    records: records.sort((a, b) => a.set.ts - b.set.ts), gains: gains.sort((a, b) => b.percent - a.percent), trained, heaviest, favorite,
    consistentWeeks: [...groupBy(current, row => weekId(row.date)).values()].filter(rows => rows.length >= 3).length,
    bestMonth: bestMonth && {month: bestMonth[0], count: bestMonth[1].length},
    weightChange: weights.length >= 2 ? weights.at(-1).weight - weights[0].weight : null};
}

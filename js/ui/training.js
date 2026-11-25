import {option, uuid} from '../db.js';
import {beatLast, bestSet, bodyweightSet, isHard, machineKind, muscles, number, plates, plural, prescription, strengthValue, warmups, workingHistory} from '../engine.js';
import {feedbackId, feedbackPositions, sessionAppDeload, weekContext, weekId, weekSummary} from '../coach.js';
import {liftStall, localDate} from '../metrics.js';
import {$, $$, activeSession, bodySheet, byId, clock, closeSheet, dateText, decimal, disclosure, esc, field, formSheet, icon, iconButton, lastBody,
  loadText, machineText, on, routine, sample, sheet, signed, techniqueName, techniques, title} from './common.js';
import {exerciseEditor, machinePicker} from './library.js';
import {decideDeload, finishFeedback} from './coach-ui.js';
import {animateCounts, burst, count, ring} from './motion.js';
import {coachingNote} from '../program.js';

const rowDrafts = new Map();
const pendingRows = new Map();
const finishing = new Set();
const warmupLoads = new Map();
const progressCache = new WeakMap();

let audio, wakeLock, wakeRequest, keyboardInput, holdTimer, lastRestAlarm;
const sheetTypes = ['working', 'drop', 'parcial', 'myo', 'aguante'];
const specialChild = new Set(['drop', 'myo', 'aguante']);

function warmupRamp(load, slot, machine, bodyweight) {
  const bar = machine?.kind === 'barra' ? machine.barWeight ?? 20 : 0;
  return warmups(load, slot.warmups, machine?.increment, bodyweight ? 'peso-corporal' : machine?.unit,
    Math.max(machine?.min ?? 0, bar));
}

export function slotContext(data, slot, kind = 'normal', appDeload = false) {
  const exercise = byId(data.exercises, slot.exerciseId);
  const equipment = byId(data.machines, slot.machineId === undefined ? exercise?.defaultMachineId : slot.machineId) ?? null;
  const history = workingHistory(data.sets, data.sessions, slot.exerciseId, equipment?.id ?? null);
  const last = history.at(-1)?.sets ?? [];
  const bodyweight = equipment?.kind === 'peso-corporal' || !!exercise?.bodyweight || history.some(group => group.sets.some(bodyweightSet));
  // The seed's observed maximum on a bodyweight station is not a limit on added load.
  const bodyweightStation = equipment && exercise?.bodyweight && equipment.name === exercise.name;
  const machine = equipment && {...equipment, kind: equipment.kind ?? machineKind(equipment.name, equipment.unit, bodyweight),
    max: bodyweight && (bodyweightStation || equipment.max === 0) ? null : equipment.max};
  const stall = kind === 'normal' && !appDeload ? liftStall(history, slot, machine) : null;
  const stallKey = 'stall:' + JSON.stringify([slot.exerciseId, machine?.id ?? null]);
  const stored = data.options[stallKey];
  const applied = stall && stored?.since === stall.since ? stored : {};
  const technique = slot.technique ?? 'aguante';
  const repMax = slot.repMax + (applied.range ? 2 : 0);
  const next = prescription({...slot, repMax}, last, machine, kind, appDeload);
  return {exercise, machine, bodyweight, history, last, next,
    ramp: warmupRamp(next.targets[0]?.weight ?? next.load, slot, machine, bodyweight),
    stall: next.rule === 2 ? null : stall, stallKey, applied, technique, repMax, appDeload};
}

const sessionSlot = (data, session, slot) => slotContext(data, slot, session.kind, sessionAppDeload(session, data));

function createSlots(data, day) {
  return day.slots.map(slot => ({
    ...slot, key: uuid(), machineId: slot.machineId === undefined ? byId(data.exercises, slot.exerciseId)?.defaultMachineId ?? null : slot.machineId
  }));
}

export async function startSession(ctx, dayIndex = null) {
  const existing = activeSession(ctx.data);
  if (existing) return ctx.go('entrenar');
  const {program, week, id, pending, targets} = weekContext(ctx.data, ctx.now());
  const day = dayIndex == null ? pending?.[0] : pending?.find(row => row.dayIndex === dayIndex);
  if (!day?.slots.length) throw Error('Este día no tiene ejercicios. Agrégalos en Programa.');
  const start = +ctx.now();
  const session = {id: uuid(), date: localDate(start), start, end: null, programId: program.id, week: week.n,
    dayIndex: day.dayIndex, bodyweight: lastBody(ctx.data)?.weight ?? null, notes: '', manual: false, dayName: day.name, kind: week.kind, isoWeek: id, targets,
    slots: createSlots(ctx.data, day), appDeload: week.appDeload};
  rowDrafts.clear();
  warmupLoads.clear();
  await ctx.save([['sessions', session], option('draftUI', null)], {render: false, newSession: true});
  ctx.go('entrenar');
  updateWakeLock(ctx);
}

export function chooseDay(ctx, choose, selected) {
  const {pending = [], week} = weekContext(ctx.data, ctx.now());
  sheet('Elegir día', pending.length ? '<ul class="plain-list">' + pending.map(day =>
    '<li><button class="list-button row" data-day="' + day.dayIndex + '"><span>' + esc(day.name) + (day.dayIndex === selected ? ' · seleccionado' : '') + '</span>'
    + '<small class="muted">' + quantity(day.slots.length, 'ejercicio') + '</small></button></li>').join('') + '</ul>'
    : week ? '<p>Completaste los días del plan semanal.</p>' : '<p>Importa o crea un programa en Perfil · Programa.</p>',
  root => on(root, '[data-day]', async node => { await choose(Number(node.dataset.day)); closeSheet(); }));
}

function sessionRows(ctx, session) {
  return ctx.data.sets.filter(row => row.sessionId === session.id);
}

function draftRow(session, slot, info, index, type, child = false) {
  const key = [session.id, slot.key, child ? 'child' : type, index].join(':');
  if (!rowDrafts.has(key)) {
    rowDrafts.set(key, {key, slotKey: slot.key, index, type, child, id: uuid()});
  }
  const draft = rowDrafts.get(key);
  draft.bodyweight = info.bodyweight;
  const comparable = row => row.setIndex === index && (child ? row.parentId && row.type === type
    : !row.parentId && (type === 'warmup' ? row.type === type : row.type === 'working' || row.type === 'parcial'));
  const source = info.last.find(comparable);
  const warm = type === 'warmup' ? info.ramp[index] : null;
  const target = warm ?? (!child && type !== 'warmup' ? info.next.targets[index] ?? info.next.targets.at(-1) : null);
  const load = (target ? target.weight : source?.weight ?? info.next.load) ?? (info.bodyweight ? 0 : null);
  draft.percent = warm?.percent;
  draft.source = source;
  draft.target = target;
  if (draft.appDeload !== info.appDeload) {
    draft.appDeload = info.appDeload;
    draft.rirEdited = false;
  }
  if (!draft.weightEdited) draft.weight = load == null ? null : Math.max(info.machine?.min ?? 0, load);
  if (!draft.repsEdited) draft.reps = target?.reps ?? source?.reps ?? (type === 'warmup' ? slot.repMin : info.next.reps);
  if (!draft.rirEdited) draft.rir = type === 'warmup' ? null : target?.rir ?? info.next.rir[index] ?? info.next.rir.at(-1) ?? 0;
  return draft;
}

function visibleRows(slot, session, info, logged, type) {
  const rows = [];
  const planned = type === 'warmup' ? info.ramp.length : info.next.setCount + (slot.extraSets ?? 0);
  if (slot.archived) return logged.filter(row => row.type === type || type === 'working' && row.type !== 'warmup')
    .map(row => ({draft: draftRow(session, slot, info, row.setIndex, row.type, !!row.parentId), set: row}));
  const count = logged.reduce((last, row) => !row.parentId && (row.type === 'warmup') === (type === 'warmup')
    ? Math.max(last, row.setIndex + 1) : last, planned);
  for (let index = 0; index < count; index++) {
    const set = logged.find(row => !row.parentId && row.setIndex === index && (row.type === 'warmup') === (type === 'warmup'));
    if (index >= planned && !set) continue;
    const draft = draftRow(session, slot, info, index, type);
    const child = logged.find(row => set && row.parentId === set.id);
    const childKey = [session.id, slot.key, 'child', index].join(':');
    const automatic = type === 'working' && index === info.next.setCount - 1 && info.applied.technique;
    if (!set && !draft.typeEdited && !!automatic !== !!draft.automaticTechnique) {
      const technique = info.technique === 'parciales' ? 'parcial' : info.technique;
      applySetType(session, slot, info, draft, automatic ? technique : 'working');
      draft.automaticTechnique = automatic;
    }
    rows.push({draft, set});
    if (child || rowDrafts.has(childKey)) {
      const extra = draftRow(session, slot, info, index, child?.type ?? rowDrafts.get(childKey).type, true);
      if (extra.type === 'drop' && !extra.weightEdited) extra.weight = stepLoad(set?.weight ?? draft.weight, -1, info.machine);
      rows.push({draft: extra, set: child});
    }
  }
  return rows;
}

const weightInput = (value, bodyweight) => bodyweight && String(value).trim().toUpperCase() === 'PC' ? 0 : decimal(value);
const logInputText = (value, bodyweight) => value == null ? '' : bodyweight && decimal(value) === 0 ? 'PC' : String(value).replace('.', ',');

function valueField(field, saved, row, label) {
  const source = saved ?? row;
  const display = logInputText(source[field], field === 'weight' && row.bodyweight);
  return '<input inputmode="' + (field === 'weight' ? 'decimal' : 'numeric') + '" autocomplete="off" aria-label="' + label
    + '" value="' + esc(display) + '" placeholder="' + label + '" data-log-input="' + field + '" class="'
    + (isGhost(row, field, saved) ? 'ghost' : '') + '"' + (saved ? ' disabled' : '') + '>';
}

const isGhost = (row, field, saved) => !saved && !!row && (row.target?.[field] != null || !!row.source) && !row[field + 'Edited'];

function rowHTML(draft, set, barbell) {
  const source = set ?? draft;
  const label = source.type === 'warmup' ? 'Calentamiento' : techniqueName(source.type);
  const index = draft.child ? '+' : draft.percent != null ? draft.percent + '%' : draft.index + 1;
  return '<tr class="setrow' + (set ? ' done' : '') + '" data-row="' + esc(draft.key) + '"><td>'
    + (set || draft.type === 'warmup' ? index : '<button type="button" data-type aria-label="Serie ' + index + ' · ' + esc(label) + '">' + index + '</button>')
    + '</td><td class="prev">'
    + (draft.source ? esc(loadText(draft.source.weight, draft.source.unit, false)) + ' × ' + draft.source.reps
      : draft.percent != null ? 'Ligera' : '—') + '</td>'
    + '<td>' + (barbell ? '<div class="weight-cell">' : '') + valueField('weight', set, draft, 'peso')
    + (barbell ? iconButton('disc', 'Calculadora de discos', 'data-plates') + '</div>' : '') + '</td>'
    + '<td>' + valueField('reps', set, draft, source.type === 'aguante' ? 'segundos' : 'reps') + '</td>'
    + '<td><button type="button" class="chk set-check" data-check aria-pressed="' + Boolean(set) + '" aria-label="'
    + (set ? 'Desmarcar' : 'Registrar') + ' serie ' + (draft.index + 1) + '" data-set-id="' + esc(set?.id)
    + '">' + icon('check') + '<span class="prbadge" data-row-pr' + (set?.record ? '' : ' hidden') + '>PR</span></button></td></tr>';
}

const presetHint = {
  range: 'Amplía el rango en 2 reps', technique: 'Aplica la técnica en la última serie',
  substitute: 'Cambia de ejercicio', deload: 'Haz una descarga'
};

function followNotes(data, session, slot, exercise) {
  const past = new Map(data.sessions.filter(row => !row.deleted && row.end && row.id !== session.id).map(row => [row.id, row]));
  const clean = note => typeof note === 'string' && note.trim() && !/^(?:máquina|maquina|machine)[.!]?$/iu.test(note.trim()) ? note.trim() : '';
  const notes = data.sets.filter(row => !row.deleted && row.exerciseId === exercise?.id && past.has(row.sessionId))
    .flatMap(row => {
      const prior = past.get(row.sessionId);
      const own = clean(row.notes);
      const general = clean(prior.notes);
      return own ? [{text: own, at: row.ts, start: prior.start, date: prior.date}]
        : general ? [{text: general, at: prior.start, start: prior.start, date: prior.date}] : [];
    }).sort((a, b) => b.start - a.start || b.at - a.at)[0];
  const template = byId(data.programs, session.programId)?.weeks.find(row => row.n === session.week)
    ?.days[slot.origin?.dayIndex ?? session.dayIndex]?.slots[slot.origin?.slotIndex];
  const technique = coachingNote(slot.notes || template?.notes);
  const lines = [exercise?.pinnedNote, notes && notes.text + ' · ' + dateText(notes.date, {day: 'numeric', month: 'short'}),
    technique && 'Técnica: ' + technique].filter(Boolean);
  return '<div class="follow-notes">' + (lines.length ? '<details>' + disclosure(esc(lines.join(' · '))) + '<p>'
    + lines.map(esc).join('<br>') + '</p></details>' : '') + (exercise ? '<button type="button" class="link-button" data-pin-note>'
      + (exercise.pinnedNote ? 'Editar nota' : '+ Nota') + '</button>' : '') + '</div>';
}

function slotHTML(ctx, session, slot, logged) {
  const info = sessionSlot(ctx.data, session, slot);
  const {exercise, machine, next, stall, applied, bodyweight} = info;
  const warmupLoad = warmupLoads.get(slot.key);
  if (warmupLoad != null) info.ramp = warmupRamp(warmupLoad, slot, machine, bodyweight);
  const moved = slot.reason?.startsWith('movido de ') ? slot.reason : '';
  const hint = next.rule === 2 ? '↑ Sube a ' + loadText(next.load, machine?.unit)
    : next.rule === 5 ? (bodyweight ? 'Peso corporal' : 'Mismo peso') + ' · +1 rep'
      : next.reason;
  const warm = visibleRows(slot, session, info, logged, 'warmup');
  const rows = visibleRows(slot, session, info, logged, 'working');
  const barbell = machine?.unit === 'kg' && machine.kind === 'barra';
  const table = (rows, working) => '<table class="sets-table' + (barbell ? ' barbell' : '') + '"' + (working ? ' data-working-sets' : '')
    + '><thead><tr><th scope="col">Serie</th><th scope="col">Anterior</th><th scope="col">'
    + (machine?.unit === 'pila' ? 'Pila' : machine?.unit === 'lb' ? 'LB' : 'KG')
    + '</th><th scope="col">Reps</th><th scope="col" aria-label="Registrar">✓</th></tr></thead><tbody>'
    + rows.map(({draft, set}) => rowHTML(draft, set, barbell)).join('') + '</tbody></table>';
  return '<article class="ex slot" data-slot="' + esc(slot.key) + '"><h2>' + esc(exercise?.name ?? 'Ejercicio')
    + (moved ? '<span class="moved">' + esc(moved) + '</span>' : '') + '</h2>'
    + (slot.archived ? '' : '<div class="hint' + (stall ? ' stall' : '') + '">'
      + (stall ? '<b>' + presetHint[stall.step] + '</b>' + (applied[stall.step] ? ' · Aplicado' : '<button type="button" data-stall>Aplicar</button>')
        : esc(hint)) + '</div>')
    + followNotes(ctx.data, session, slot, exercise)
    + (warm.length ? '<details class="warmups">' + disclosure('Calentamiento (' + warm.length + ')') + table(warm, false)
      + (!slot.archived ? '<button data-warmup-calc>Recalcular con la carga de trabajo</button>' : '') + '</details>'
      : !slot.archived && (slot.warmups || bodyweight) ? '<details class="warmups">' + disclosure('Calentamiento') + '<p class="muted">'
        + (bodyweight ? '1–2 series ligeras' : 'Escribe la carga de trabajo.') + '</p>'
        + (bodyweight ? '' : '<button data-warmup-calc>Calcular calentamiento</button>') + '</details>' : '')
    + table(rows, true)
    + (slot.archived ? '' : '<button class="add" data-add-series>+ Añadir serie</button><details class="exercise-options">'
      + disclosure('Opciones del ejercicio') + '<div class="actions"><button type="button" data-pick-machine>' + esc(machineText(ctx.data, machine, bodyweight))
      + '</button><button type="button" data-substitute>Sustituir</button></div></details>') + '</article>';
}

function counts(data, session) {
  const cached = progressCache.get(data);
  if (cached?.session === session) return cached.counts;
  const done = data.sets.filter(set => !set.deleted && set.sessionId === session.id && !set.parentId && set.type !== 'warmup').length;
  const total = session.slots.reduce((sum, slot) => sum + (slot.archived
    ? data.sets.filter(set => set.sessionId === session.id && set.slotId === slot.key && !set.deleted && !set.parentId && set.type !== 'warmup').length
    : sessionSlot(data, session, slot).next.setCount + (slot.extraSets ?? 0)), 0);
  const result = {done, total};
  progressCache.set(data, {session, counts: result});
  return result;
}

export function trainingView(ctx) {
  const session = activeSession(ctx.data);
  if (!session) {
    const {week, pending = []} = weekContext(ctx.data, ctx.now());
    return title(ctx, 'Entrenar') + '<div class="section"><p class="muted">No hay un entreno activo.</p>'
      + (pending.length ? '<button class="primary" data-choose>Elegir día</button>'
        : week ? '<a class="back" href="#hoy">Ver plan semanal</a>' : '<a class="back" href="#perfil/programa">Importar o crear un programa</a>') + '</div>';
  }
  const groups = Map.groupBy(sessionRows(ctx, session), set => set.slotId);
  const {done, total} = counts(ctx.data, session);
  return '<div class="training"><header class="wbar"><div class="wrow">'
    + iconButton('chevron-down', 'Minimizar entreno', 'data-minimize') + '<div class="wt"><b>' + esc(routine(session, ctx.data))
    + '</b><small><span data-elapsed>' + clock((+ctx.now() - session.start) / 1000) + '</span> · <span data-training-count>' + done + ' de ' + total
    + '</span> series</small></div><button type="button" class="fin" data-finish>Terminar</button></div>'
    + '<div class="prog"><i data-training-progress style="--progress:' + (total ? Math.min(1, done / total) : 0) + '"></i></div>'
    + '<span class="caption muted" data-offline' + (ctx.mode === 'offline' ? '' : ' hidden') + '>Pendiente de sincronizar</span>'
    + sample(ctx) + '</header>'
    + session.slots.map(slot => slotHTML(ctx, session, slot, groups.get(slot.key) ?? [])).join('')
    + '<footer class="training-footer actions"><button data-session-menu>Opciones del entreno</button><button data-body>PC'
    + (session.bodyweight ? ' ' + number(session.bodyweight) + ' kg' : ' · registrar') + '</button>'
    + '<button class="discard" data-discard>Descartar entreno</button></footer></div>';
}

function ensureAudio(ctx) {
  if (ctx.data.options.sound === false) return;
  const Audio = window.AudioContext ?? window.webkitAudioContext;
  if (!Audio) return;
  try {
    audio ??= new Audio();
    if (audio.state === 'suspended') audio.resume().catch(() => {});
  } catch { /* A platform may disable audio. */ }
}

function alarm(ctx) {
  navigator.vibrate?.(180);
  if (ctx.data.options.sound === false || audio?.state !== 'running') return;
  const tone = audio.createOscillator(), gain = audio.createGain(), now = audio.currentTime;
  tone.frequency.value = 680;
  gain.gain.setValueAtTime(.16, now);
  gain.gain.exponentialRampToValueAtTime(.001, now + .24);
  tone.connect(gain).connect(audio.destination);
  tone.start(now);
  tone.stop(now + .26);
}

export function updateWakeLock(ctx) {
  const awake = activeSession(ctx.data) && ctx.data.options.keepAwake !== false && !document.hidden;
  if (!awake) {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  } else if (navigator.wakeLock && (!wakeLock || wakeLock.released) && !wakeRequest) {
    wakeRequest = navigator.wakeLock.request('screen').then(lock => { wakeLock = lock; }).catch(() => {}).finally(() => {
      wakeRequest = null;
      if (!activeSession(ctx.data) || ctx.data.options.keepAwake === false || document.hidden) updateWakeLock(ctx);
    });
  }
}

async function changeRest(ctx, rest) {
  await ctx.save([option('draftUI', rest)], {render: false});
  renderDock(ctx);
}

function leaveRest(restRoot) {
  const bar = restRoot.firstElementChild;
  if (!bar || Object.hasOwn(bar.dataset, 'leaving')) return;
  if (document.hidden) return bar.remove();
  bar.dataset.leaving = '';
  bar.inert = true;
  const exit = bar.getAnimations?.().find(animation => animation.animationName === 'rest-out');
  if (exit) exit.finished.then(() => bar.remove(), () => bar.remove());
  else bar.remove();
}

export function renderDock(ctx) {
  const session = activeSession(ctx.data);
  const restRoot = $('#rest-dock'), capsule = $('#session-capsule');
  const rest = ctx.data.options.draftUI;
  const hasRest = session && rest?.sessionId === session.id && rest.restUntil > +ctx.now() && ctx.route === 'entrenar';
  document.body.toggleAttribute('data-training', !!session && ctx.route === 'entrenar');
  capsule.innerHTML = session && ctx.route !== 'entrenar' ? '<a href="#entrenar" class="dock-bar capsule">'
    + '<strong>' + esc(routine(session, ctx.data)) + '</strong> · <span data-elapsed>' + clock((+ctx.now() - session.start) / 1000)
    + '</span> · <span data-capsule-count></span>' + icon('chevron-right', true) + '</a>' : '';
  if (!hasRest) leaveRest(restRoot);
  else if (!restRoot.firstElementChild || Object.hasOwn(restRoot.firstElementChild.dataset, 'leaving')) {
    restRoot.innerHTML = '<div class="dock-bar rest-bar"><span class="rring">' + ring(1, 1, 'rest')
      + '</span><div class="rclock"><b data-rest-clock></b><small>Descanso</small></div><div class="rest-actions">'
      + '<button type="button" data-rest="-15" aria-label="Quitar 15 segundos">−15</button><button type="button" data-rest="15" aria-label="Añadir 15 segundos">+15</button>'
      + '<button type="button" data-rest="skip">Saltar</button></div></div>';
    on(restRoot, '[data-rest]', node => {
      const rest = ctx.data.options.draftUI;
      if (!rest || node.dataset.rest === 'skip') return changeRest(ctx, null);
      const restUntil = rest.restUntil + Number(node.dataset.rest) * 1000;
      if (restUntil <= +ctx.now()) { alarm(ctx); return changeRest(ctx, null); }
      return changeRest(ctx, {...rest, restUntil});
    });
  }
  tickTraining(ctx);
}

export function tickTraining(ctx) {
  const session = activeSession(ctx.data);
  if (!session) return;
  const now = +ctx.now();
  for (const node of $$('[data-elapsed]')) node.textContent = clock((now - session.start) / 1000);
  const offline = $('[data-offline]');
  // Round 9: no sync noise while training. Only a real offline state with sync configured (or the offline mock).
  const syncOn = !!(ctx.data.options.syncUrl && ctx.data.options.syncToken);
  if (offline) offline.hidden = !(ctx.mode === 'offline' || (syncOn && navigator.onLine === false));
  const counter = $('[data-training-count]') ?? $('[data-capsule-count]');
  if (counter) {
    const {done, total} = counts(ctx.data, session);
    const label = done + ' de ' + total;
    if (counter.textContent !== label) counter.textContent = label;
    $('[data-training-progress]')?.style.setProperty('--progress', total ? Math.min(1, done / total) : 0);
  }
  const rest = ctx.data.options.draftUI;
  if (rest?.sessionId !== session.id || !rest.restUntil) return;
  const countdown = $('[data-rest-clock]');
  if (countdown) countdown.textContent = clock(Math.ceil((rest.restUntil - now) / 1000));
  const progress = $('.rest-progress');
  if (progress) {
    const duration = Math.max(1, rest.restUntil - (rest.restStarted ?? rest.restUntil - (ctx.data.options.defaultRest ?? 90) * 1000));
    progress.style.setProperty('--offset', 1 - Math.min(1, Math.max(0, (rest.restUntil - now) / duration)));
  }
  if (rest.restUntil <= now && rest.restUntil !== lastRestAlarm) {
    lastRestAlarm = rest.restUntil;
    alarm(ctx);
    leaveRest($('#rest-dock'));
    ctx.save([option('draftUI', null)], {render: false}).catch(error => ctx.notice(error.message, true));
  }
}

function updateRowDisplay(root, set) {
  const button = $('[data-check]', root);
  if (!button) return;
  button.setAttribute('aria-pressed', String(!!set));
  button.setAttribute('aria-label', (set ? 'Desmarcar' : 'Registrar') + ' serie');
  button.dataset.setId = set?.id ?? '';
  root.classList.toggle('done', !!set);
  $('[data-row-pr]', root).hidden = !set?.record;
  const draft = rowDrafts.get(root.dataset.row);
  for (const input of $$('[data-log-input]', root)) {
    const field = input.dataset.logInput;
    if (set) input.value = logInputText(set[field], field === 'weight' && draft.bodyweight);
    input.classList.toggle('ghost', isGhost(draft, field, set));
  }
  for (const node of $$('[data-step], [data-rir]', root)) node.disabled = !!set;
}

function checkRow(ctx, root, session, slot, keepKeyboard = false) {
  const draft = rowDrafts.get(root.dataset.row);
  const active = activeSession(ctx.data);
  if (!draft || pendingRows.has(draft.key) || finishing.has(session.id) || active?.id !== session.id) return;
  if (!active.rpRecoveryDone && ctx.data.options.autoVolume !== false && !sessionRows(ctx, session).length) return getSoreness(ctx, session);
  const pending = saveRow(ctx, root, session, slot, draft, keepKeyboard).finally(() => pendingRows.delete(draft.key));
  pendingRows.set(draft.key, {sessionId: session.id, pending});
  return pending;
}

async function saveRow(ctx, root, session, slot, draft, keepKeyboard) {
  const checked = $('[data-check]', root);
  const existing = byId(ctx.data.sets, checked.dataset.setId);
  checked.disabled = true;
  try {
    const {machine} = sessionSlot(ctx.data, session, slot);
    let set = null;
    if (existing) {
      const children = sessionRows(ctx, session).filter(row => row.parentId === existing.id);
      await ctx.save([existing, ...children].map(row => ['sets', {id: row.id, deleted: true}]), {render: false});
      if (children.length) ctx.render();
    } else {
      const weight = requiredLog(weightInput($('[data-log-input="weight"]', root).value, draft.bodyweight), 'el peso');
      const reps = requiredLog(decimal($('[data-log-input="reps"]', root).value), 'las repeticiones', 1);
      if (!Number.isInteger(reps)) throw Error('Usa un número entero de repeticiones o segundos.');
      if (machine && (weight < (machine.min ?? 0) || weight > (machine.max ?? Infinity))) throw Error('El peso está fuera del rango de la máquina. Revisa el mínimo y el máximo.');
      const parent = draft.child ? sessionRows(ctx, session).find(row => row.slotId === slot.key && row.setIndex === draft.index && !row.parentId) : null;
      if (draft.child && !parent) throw Error('Registra la serie principal para guardar la serie extra.');
      ensureAudio(ctx);
      const now = +ctx.now();
      set = {id: draft.id, sessionId: session.id, exerciseId: slot.exerciseId, machineId: machine?.id ?? null, slotId: slot.key,
        slotIndex: session.slots.indexOf(slot), setIndex: draft.index, weight, unit: machine?.unit ?? 'kg', reps, type: draft.type,
        rir: draft.rir, ts: now, parentId: parent?.id ?? null};
      const history = ctx.data.sets.filter(row => row.exerciseId === set.exerciseId);
      const bodyweight = draft.bodyweight || bodyweightSet(set) || history.some(bodyweightSet);
      const candidate = bestSet(history.filter(row => row.machineId === set.machineId), bodyweight);
      set.record = isHard(set) && !!candidate && strengthValue(set, bodyweight) > strengthValue(candidate, bodyweight) + 1e-9;
      set.beatLast = !!beatLast(set, draft.source);
      const seconds = slot.restMin != null && slot.restMax != null ? (slot.restMin + slot.restMax) * 30 : (ctx.data.options.defaultRest ?? 90);
      await ctx.save([['sets', set], option('draftUI', {sessionId: session.id, restStarted: now, restUntil: now + seconds * 1000})], {render: false});
      draft.id = set.id;
      if (!keepKeyboard) for (const input of $$('[data-log-input]', root)) input.disabled = true;
      if (!navigator.onLine || ctx.mode === 'offline') ctx.notice('Sin conexión: se guardó en el teléfono y se sincroniza al volver la señal.');
    }
    if (!set) for (const input of $$('[data-log-input]', root)) {
      const field = input.dataset.logInput;
      const parse = field === 'weight' ? value => weightInput(value, draft.bodyweight) : decimal;
      if (parse(input.value) !== parse(draft[field])) {
        draft[field] = input.value;
        draft[field + 'Edited'] = true;
      }
      input.disabled = false;
    }
    updateRowDisplay(root, set);
    if (set?.record) burst(checked, 26);
    renderDock(ctx);
  } finally {
    checked.disabled = false;
  }
}

function requiredLog(value, label, min = 0) {
  if (value == null || !Number.isFinite(value) || value < min) throw Error('Revisa ' + label + ' antes de marcar la serie.');
  return value;
}

function setType(ctx, session, slot, root) {
  const row = rowDrafts.get(root.dataset.row);
  if (!row || row.type === 'warmup' || $('[data-check]', root)?.dataset.setId) return;
  sheet('Tipo de serie', '<ul class="plain-list">' + sheetTypes.map(type => '<li><button type="button" class="list-button" data-kind="' + type + '">'
    + techniques[type] + '</button></li>').join('') + '</ul>', dialog => on(dialog, '[data-kind]', node => {
    row.typeEdited = true;
    applySetType(session, slot, sessionSlot(ctx.data, session, slot), row, node.dataset.kind);
    closeSheet();
    ctx.render();
  }));
}

function applySetType(session, slot, info, row, type) {
  if (row.child) row.type = type;
  else if (specialChild.has(type)) {
    row.type = 'working';
    const child = draftRow(session, slot, info, row.index, type, true);
    if (!child.typeEdited) child.type = type;
  } else {
    row.type = type;
    rowDrafts.delete([session.id, slot.key, 'child', row.index].join(':'));
  }
}

async function updateSlots(ctx, session, slots, fields = {}) {
  await ctx.save([['sessions', {id: session.id, slots, ...fields}]]);
}

function substitutes(data, slot) {
  const exercise = byId(data.exercises, slot.exerciseId);
  const ids = new Set([...(slot.substitutes ?? []), ...(exercise?.substitutes ?? [])]);
  return [...ids].flatMap(id => {
    const row = byId(data.exercises, id);
    return row && id !== slot.exerciseId ? [row] : [];
  });
}

function substitute(ctx, session, slot, choice) {
  const apply = async row => {
    const already = sessionRows(ctx, session).some(set => set.slotId === slot.key);
    const slots = session.slots.flatMap(item => item !== slot ? [item] : [
      ...(already ? [{...item, archived: true}] : []),
      {...item, key: uuid(), exerciseId: row.id, machineId: row.defaultMachineId ?? null}
    ]);
    await updateSlots(ctx, session, slots);
    closeSheet();
  };
  if (choice) return apply(choice);
  const list = (options, name) => sheet(name, '<div class="stack"><button type="button" data-other>Otro</button><ul class="plain-list">'
    + options.map(row => '<li><button type="button" data-ex="' + esc(row.id) + '" class="list-button">' + esc(row.name) + '</button></li>').join('') + '</ul></div>',
  root => {
    on(root, '[data-ex]', node => apply(byId(ctx.data.exercises, node.dataset.ex)));
    on(root, '[data-other]', node => node.textContent === 'Nuevo ejercicio' ? exerciseEditor(ctx, null, apply)
      : list(ctx.data.exercises.filter(row => row.id !== slot.exerciseId), 'Otro ejercicio').querySelector('[data-other]').replaceChildren('Nuevo ejercicio'));
  });
  list(substitutes(ctx.data, slot), 'Sustituir ejercicio');
}

function stallSheet(ctx, session, slot) {
  const {stall, stallKey, applied, technique} = sessionSlot(ctx.data, session, slot);
  if (!stall) return;
  const {step, since} = stall;
  const alternative = step === 'substitute' ? substitutes(ctx.data, slot)[0] : null;
  const label = {range: 'Ampliar el rango en 2 reps', technique: 'Última serie: ' + techniqueName(technique),
    substitute: alternative ? 'Cambiar a ' + alternative.name : 'Elegir sustituto', deload: 'Hacer descarga esta semana'}[step];
  sheet('Estancado', '<div class="stack"><p>El rendimiento sigue estancado en esta máquina.</p>'
    + (applied[step] ? '<p class="muted">Prueba el ajuste en tus próximas sesiones.</p>'
      : '<button type="button" data-stall-apply>' + esc(label) + '</button>') + '</div>', root =>
    on(root, '[data-stall-apply]', async button => {
      button.disabled = true;
      try {
        if (step === 'substitute') return await substitute(ctx, session, slot, alternative);
        if (step === 'deload') await decideDeload(ctx, 'accepted', session);
        else await ctx.save([option(stallKey, {...applied, since, [step]: true})]);
        closeSheet();
      } finally { button.disabled = false; }
    }));
}

async function discard(ctx, session) {
  const sets = sessionRows(ctx, session);
  const feedback = (ctx.data.feedback ?? []).filter(row => row.sessionId === session.id);
  await ctx.save([['sessions', {id: session.id, deleted: true}], ...sets.map(row => ['sets', {id: row.id, deleted: true}]),
    ...feedback.map(row => ['feedback', {id: row.id, deleted: true}]), option('draftUI', null)], {render: false});
  closeSheet();
  rowDrafts.clear();
  warmupLoads.clear();
  ctx.go('hoy');
  updateWakeLock(ctx);
}

export const discardable = (session, now, sets) => now - session.start < 60000 || !sets.length;

async function withSessionFinish(ctx, session, action) {
  if (finishing.has(session.id)) return;
  finishing.add(session.id);
  try {
    const writes = [...pendingRows.values()].filter(row => row.sessionId === session.id).map(row => row.pending);
    const results = await Promise.allSettled(writes);
    if (results.some(result => result.status === 'rejected')) return;
    await ctx.reload();
    if (activeSession(ctx.data)?.id === session.id) await action();
  } finally {
    finishing.delete(session.id);
  }
}

const recoveryChoices = [['sano', 'Recuperado'], ['justo', 'Justo'], ['adolorido', 'Adolorido']];
const pumpChoices = [['poco', 'Poco'], ['bien', 'Bien'], ['mucho', 'Mucho']];

function feedbackSheet(ctx, session, field) {
  if (ctx.data.options.autoVolume === false) return Promise.resolve([]);
  const soreness = field === 'soreness';
  const groups = Object.keys(feedbackPositions(session, ctx.data.exercises, ctx.data.sets, sessionAppDeload(session, ctx.data)));
  if (!groups.length) return Promise.resolve([]);
  const choices = soreness ? recoveryChoices : pumpChoices;
  const rows = ctx.data.feedback?.filter(row => row.sessionId === session.id && !row.deleted) ?? [];
  const selected = new Map(groups.flatMap(muscle => {
    const value = rows.find(row => row.muscle === muscle)?.[field];
    return value ? [[muscle, value]] : [];
  }));
  return new Promise(resolve => {
    const title = soreness ? '¿Cómo llegan hoy?' : '¿Qué tal el bombeo?';
    sheet(title, groups.map(muscle => '<div class="rp"><b>' + muscles[muscle] + '</b><div class="opts" role="group" aria-label="' + muscles[muscle] + '">'
      + choices.map(([key, label]) => '<button type="button" data-muscle="' + muscle + '" data-feedback="' + key
        + '" aria-pressed="' + (selected.get(muscle) === key) + '">' + label + '</button>').join('') + '</div></div>').join('')
      + '<div class="stack feedback-actions"><button class="primary" data-apply-feedback>' + (soreness ? 'Empezar' : 'Continuar')
      + '</button><button data-skip-feedback>Saltar</button></div>', root => {
      const cancelled = () => resolve(null);
      root.addEventListener('close', cancelled, {once: true});
      const finish = value => { root.removeEventListener('close', cancelled); resolve(value); };
      on(root, '[data-feedback]', node => {
        selected.set(node.dataset.muscle, node.dataset.feedback);
        for (const button of $$('[data-muscle="' + node.dataset.muscle + '"]', root)) button.setAttribute('aria-pressed', String(button === node));
      });
      on(root, '[data-skip-feedback]', () => finish([]));
      on(root, '[data-apply-feedback]', () => finish([...selected].map(([muscle, value]) => ({
        ...rows.find(row => row.muscle === muscle), id: feedbackId(session.id, muscle), sessionId: session.id, muscle, [field]: value
      }))));
    });
  });
}

async function getSoreness(ctx, session) {
  if (finishing.has(session.id) || ctx.data.options.autoVolume === false || session.rpRecoveryDone || sessionRows(ctx, session).length) return;
  finishing.add(session.id);
  try {
    const rows = await feedbackSheet(ctx, session, 'soreness');
    if (rows === null) return;
    await ctx.save([['sessions', {id: session.id, rpRecoveryDone: true}], ...rows.map(row => ['feedback', row])], {render: false});
    closeSheet();
  } finally { finishing.delete(session.id); }
}

function finish(ctx, session) {
  const now = +ctx.now();
  return withSessionFinish(ctx, session, () => finishSummary(ctx, activeSession(ctx.data), now));
}

async function finishSummary(ctx, session, now) {
  const sets = sessionRows(ctx, session);
  if (discardable(session, now, sets)) return discard(ctx, session);
  const pump = await feedbackSheet(ctx, session, 'pump');
  if (pump === null) return;
  const feedback = new Map((ctx.data.feedback ?? []).map(row => [row.id, row]));
  for (const row of pump) feedback.set(row.id, row);
  const projected = {...ctx.data, feedback: [...feedback.values()],
    sessions: ctx.data.sessions.map(row => row.id === session.id ? {...row, end: now} : row)};
  const changes = ctx.data.options.autoVolume === false ? [] : weekSummary(weekId(session.date), projected).changes;
  const performed = sets.filter(isHard);
  const records = [...Map.groupBy(performed.filter(set => set.record), row => row.exerciseId).values()].map(rows => rows.at(-1));
  const volume = performed.reduce((sum, set) => sum + set.weight * set.reps * (set.unit === 'lb' ? .45359237 : set.unit === 'kg' ? 1 : 0), 0);
  const mins = Math.round((now - session.start) / 60000);
  const title = records.length ? '¡' + records.length + ' ' + plural(records.length, 'récord forjado', 'récords forjados') + '!' : '¡Entreno forjado!';
  let saving;
  const dialog = sheet(title, '<div class="finish-glow"></div><div class="sumg"><div><b>' + count(mins) + '</b><small>minutos</small></div>'
    + '<div><b>' + count(performed.length) + '</b><small>series</small></div><div><b>' + count(volume) + '</b><small>volumen · kg</small></div></div>'
    + records.map(set => '<div class="pr"><span>' + esc(byId(ctx.data.exercises, set.exerciseId)?.name) + '<small class="muted">'
      + esc(loadText(set.weight, set.unit)) +  ' × ' + set.reps + '</small></span><span class="pill gold">Nuevo récord</span></div>').join('')
    + '<h3>Próxima semana</h3>' + (changes.length ? changes.map(([key, row]) => '<div class="pr"><span>' + muscles[key] + '</span><span class="pill '
      + (row.delta > 0 ? 'up' : 'down') + '" title="' + esc(row.reasons.join(' · ')) + '">' + signed(row.delta) + ' series</span></div>').join('')
      : '<p class="muted">' + (ctx.data.options.autoVolume === false ? 'Volumen autorregulado desactivado.' : 'Mantén el volumen.') + '</p>')
    + '<div class="stack finish-actions"><button class="primary" data-save-session>Guardar entreno</button><button data-back>Volver</button></div>',
  root => {
    on(root, '[data-back]', closeSheet);
    on(root, '[data-save-session]', async node => {
      node.disabled = true;
      try {
        const performance = new Map(finishFeedback(projected, session).map(([, row]) => [row.id, row.performance]));
        const final = [...feedback.values()].filter(row => row.sessionId === session.id && !row.deleted)
          .map(row => ['feedback', {...row, performance: performance.get(row.id) ?? null}]);
        saving = ctx.save([['sessions', {id: session.id, end: now}], ...final, option('draftUI', null)], {render: false});
        await saving;
        rowDrafts.clear();
        warmupLoads.clear();
        closeSheet();
        ctx.go('hoy');
        updateWakeLock(ctx);
        ctx.notice('Entreno guardado.');
      } finally { node.disabled = false; }
    });
  });
  animateCounts(dialog);
  burst(null, records.length ? 110 : 55);
  await new Promise(resolve => dialog.addEventListener('close', resolve, {once: true}));
  await saving?.catch(() => {});
}

function discardConfirmation(ctx, session) {
  sheet('¿Descartar entreno?', '<div class="stack"><p>Se descartarán las series de este entreno.</p>'
    + '<button type="button" data-discard-now>Descartar entreno</button><button type="button" data-back>Volver</button></div>', dialog => {
    on(dialog, '[data-discard-now]', () => withSessionFinish(ctx, session, () => discard(ctx, session)));
    on(dialog, '[data-back]', closeSheet);
  });
}

function sessionMenu(ctx, session) {
  const reorder = () => {
    const slots = [...session.slots];
    const show = () => sheet('Reordenar ejercicios', '<ol class="plain-list">' + slots.map((slot, i) => '<li class="row"><span>'
      + esc(byId(ctx.data.exercises, slot.exerciseId)?.name) + '</span><div class="actions">'
      + iconButton('chevron-left', 'Mover antes', 'data-order="' + i + ',-1"' + (i === 0 ? ' disabled' : ''))
      + iconButton('chevron-right', 'Mover después', 'data-order="' + i + ',1"' + (i === slots.length - 1 ? ' disabled' : '')) + '</div></li>').join('')
      + '</ol><button type="button" class="primary full" data-save-order>Guardar orden</button>', root => {
      on(root, '[data-order]', node => {
        const [i, direction] = node.dataset.order.split(',').map(Number);
        [slots[i], slots[i + direction]] = [slots[i + direction], slots[i]];
        show();
      });
      on(root, '[data-save-order]', async () => { await updateSlots(ctx, session, slots); closeSheet(); });
    });
    show();
  };
  sheet('Opciones de la sesión', '<div class="stack"><button type="button" data-reorder>Reordenar</button>'
    + '<button type="button" data-change-day>Cambiar día</button><button type="button" data-discard>Terminar sin guardar</button></div>',
  root => {
    on(root, '[data-reorder]', reorder);
    on(root, '[data-change-day]', () => chooseDay(ctx, async index => {
      const {id, program, week, pending, targets} = weekContext(ctx.data, ctx.now());
      const day = pending?.find(row => row.dayIndex === index);
      if (!day) throw Error('El día ya no está en el plan. Vuelve a elegir.');
      const registered = new Set(sessionRows(ctx, session).map(set => set.slotId));
      const preserved = session.slots.filter(slot => registered.has(slot.key)).map(slot => ({...slot, archived: true}));
      await updateSlots(ctx, session, [...preserved, ...createSlots(ctx.data, day)],
        {dayName: day.name, dayIndex: index, kind: week.kind, appDeload: week.appDeload, programId: program.id, week: week.n, isoWeek: id, targets});
    }, session.dayIndex));
    on(root, '[data-discard]', () => discardConfirmation(ctx, session));
  });
}

function setKeyboard(input) {
  keyboardInput = input;
  const dock = $('#keyboard-dock');
  dock.hidden = !input;
  document.body.toggleAttribute('data-keyboard', !!input);
  positionKeyboard();
}

function positionKeyboard() {
  const viewport = window.visualViewport;
  const offset = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
  document.documentElement.style.setProperty('--keyboard-inset', offset + 'px');
}

export function bindKeyboard(ctx) {
  const dock = $('#keyboard-dock');
  dock.innerHTML = iconButton('arrow-left', 'Campo anterior', 'data-key="-1"') + iconButton('arrow-right', 'Campo siguiente', 'data-key="1"')
    + iconButton('check', 'Registrar y pasar a la siguiente serie', 'data-key="check"');
  dock.addEventListener('pointerdown', event => event.preventDefault());
  dock.addEventListener('mousedown', event => event.preventDefault());
  on(dock, '[data-key]', async button => {
    const from = keyboardInput;
    const session = activeSession(ctx.data);
    if (!from || !session) return;
    const root = from.closest('[data-row]'), parent = from.closest('[data-slot]');
    const inputs = $$('[data-log-input]:not(:disabled)', ctx.root).filter(node => node.getClientRects().length && !node.closest('[inert]'));
    const index = inputs.indexOf(from);
    if (button.dataset.key !== 'check') return inputs[index + Number(button.dataset.key)]?.focus();
    const next = inputs.slice(index + 1).find(node => node.closest('[data-row]') !== root);
    // Safari requires focus to move inside the original tap event.
    next?.focus();
    try {
      await checkRow(ctx, root, session, session.slots.find(slot => slot.key === parent.dataset.slot), true);
      if ($('[data-check]', root).dataset.setId) {
        if (!next) { from.blur(); setKeyboard(null); }
        for (const field of $$('[data-log-input]', root)) field.disabled = true;
      }
    } catch (error) {
      from.focus();
      throw error;
    }
  });
  window.visualViewport?.addEventListener('resize', positionKeyboard);
  window.visualViewport?.addEventListener('scroll', positionKeyboard);
}

function pickRir(ctx, row, draft) {
  const active = activeSession(ctx.data);
  if (!active || finishing.has(active.id)) return;
  const set = byId(ctx.data.sets, $('[data-check]', row)?.dataset.setId);
  sheet('RIR · Reps en reserva', '<div class="rir-options">' + [0, 1, 2, 3].map(value => '<button data-rir="' + value
    + '" aria-pressed="' + ((set?.rir ?? draft.rir) === value) + '">' + (value === 3 ? '3+' : value) + '</button>').join('') + '</div>',
  root => on(root, '[data-rir]', async node => {
    draft.rir = Number(node.dataset.rir);
    draft.rirEdited = true;
    if (set) await ctx.save([['sets', {id: set.id, rir: draft.rir}]], {render: false});
    closeSheet();
  }));
}

function plateSheet(ctx, machine, planned) {
  const bar = machine.barWeight ?? 20;
  const total = planned ?? bar;
  const result = plates(total, bar);
  const colors = {25: 'red', 20: 'blue', 15: 'yellow', 10: 'green', 5: 'white', 2.5: 'red-small', 1.25: 'silver'};
  const discs = result.perSide.flatMap(({weight, count}) => Array.from({length: Math.min(count, 12)}, () =>
    '<span class="disc ' + colors[weight] + '">' + number(weight, 2) + '</span>')).join('');
  sheet('Calculadora de discos', '<div class="stack"><p><strong>' + number(total, 2) + ' kg</strong> · Barra de ' + number(bar, 2)
    + ' kg</p><h3>Discos por lado</h3><div class="discs" aria-hidden="true">' + discs + '</div>'
    + '<p class="muted">' + (result.perSide.map(({weight, count}) => count + ' × ' + number(weight, 2) + ' kg').join(' · ') || 'Sin discos') + '</p>'
    + (result.remainder ? '<p>Sobra: ' + number(result.remainder, 2) + ' kg</p>' : '')
    + '<button data-edit-bar>Peso de la barra</button></div>', root => on(root, '[data-edit-bar]', () =>
    formSheet('Peso de la barra', field('kg', 'barWeight', bar, 'type="number" min="0.01" step="0.01" required'), async values => {
      const barWeight = requiredLog(decimal(values.barWeight), 'el peso de la barra', .01);
      await ctx.save([['machines', {id: machine.id, kind: 'barra', barWeight}]]);
      plateSheet(ctx, {...machine, barWeight}, planned);
    })));
}

export function bindTraining(ctx) {
  const root = ctx.root, session = activeSession(ctx.data);
  if (keyboardInput && !keyboardInput.isConnected) setKeyboard(null);
  if (!session) {
    on(root, '[data-choose]', () => chooseDay(ctx, index => startSession(ctx, index)));
    return;
  }
  on(root, '[data-body]', () => bodySheet(ctx, false, session));
  on(root, '[data-finish]', () => finish(ctx, session));
  on(root, '[data-session-menu]', () => sessionMenu(ctx, session));
  on(root, '[data-minimize]', () => ctx.go(ctx.trainingBack || 'hoy'));
  on(root, '[data-discard]', () => discardConfirmation(ctx, session));
  getSoreness(ctx, session).catch(error => ctx.notice(error.message, true));
  for (const article of $$('[data-slot]', root)) {
    const slot = session.slots.find(row => row.key === article.dataset.slot);
    const {exercise, machine} = sessionSlot(ctx.data, session, slot);
    on(article, '[data-add-series]', node => {
      if (finishing.has(session.id)) return;
      node.disabled = true;
      const latest = activeSession(ctx.data);
      return updateSlots(ctx, latest, latest.slots.map(row => row.key === slot.key ? {...row, extraSets: (row.extraSets ?? 0) + 1} : row))
        .finally(() => { node.disabled = false; });
    });
    on(article, '[data-warmup-calc]', () => {
      const input = $('[data-working-sets] [data-log-input="weight"]', article);
      warmupLoads.set(slot.key, requiredLog(decimal(input?.value), 'la carga de trabajo', .01));
      ctx.render();
      const updated = $$('[data-slot]', ctx.root).find(node => node.dataset.slot === slot.key);
      $('.warmups', updated).open = true;
    });
    on(article, '[data-pin-note]', () => {
      const save = async pinnedNote => {
        await ctx.save([['exercises', {id: exercise.id, pinnedNote}]]);
        closeSheet();
      };
      const dialog = formSheet('Notas que te siguen', field('Nota fija', 'pinnedNote', exercise?.pinnedNote, 'maxlength="500"')
        + (exercise.pinnedNote ? '<button type="button" data-remove-note>Quitar nota</button>' : ''), values => save(values.pinnedNote.trim()));
      on(dialog, '[data-remove-note]', () => save(''));
    });
    on(article, '[data-plates]', node => {
      const input = $('[data-log-input="weight"]', node.closest('td'));
      const weight = decimal(input?.value);
      return plateSheet(ctx, machine, weight);
    });
    on(article, '[data-pick-machine]', () => machinePicker(ctx, exercise, machine?.id, async selected => {
      for (const [key, draft] of rowDrafts) if (draft.slotKey === slot.key) rowDrafts.delete(key);
      await updateSlots(ctx, session, session.slots.map(row => row === slot ? {...row, machineId: selected?.id ?? null} : row));
    }));
    on(article, '[data-substitute]', () => substitute(ctx, session, slot));
    on(article, '[data-stall]', () => stallSheet(ctx, session, slot));
    for (const node of $$('[data-row]', article)) {
      const draft = rowDrafts.get(node.dataset.row);
      on(node, '[data-type]', () => setType(ctx, session, slot, node));
      const check = $('[data-check]', node);
      let held = false;
      if (draft.type !== 'warmup') {
        check?.addEventListener('contextmenu', event => {
          event.preventDefault();
          clearTimeout(holdTimer);
          held = true;
          pickRir(ctx, node, draft);
        });
        check?.addEventListener('pointerdown', () => {
          held = false;
          holdTimer = setTimeout(() => { held = true; pickRir(ctx, node, draft); }, 500);
        });
        for (const event of ['pointerup', 'pointercancel', 'pointerleave']) check?.addEventListener(event, () => clearTimeout(holdTimer));
      }
      on(node, '[data-check]', () => {
        if (held) { held = false; return; }
        return checkRow(ctx, node, session, slot);
      });
      for (const input of $$('[data-log-input]', node)) {
        input.addEventListener('focus', () => {
          if (input.dataset.logInput === 'weight' && input.value === 'PC') input.select();
          setKeyboard(input);
        });
        input.addEventListener('blur', event => {
          if (!event.relatedTarget?.matches('[data-log-input], [data-key]')) setKeyboard(null);
        });
        input.addEventListener('input', () => {
          draft[input.dataset.logInput] = input.dataset.logInput === 'weight' && weightInput(input.value, draft.bodyweight) === 0 ? 0 : input.value;
          draft[input.dataset.logInput + 'Edited'] = true;
          input.classList.remove('ghost');
        });
      }
    }
  }
}

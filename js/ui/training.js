import {option, uuid} from '../db.js';
import {beatLast, bestSet, bodyweightSet, compareStrength, isHard, muscles, number, plural, prescription, quantity, stepLoad, workingHistory} from '../engine.js';
import {feedbackPositions, sessionAppDeload, weekContext} from '../coach.js';
import {dose, liftStall, localDate} from '../metrics.js';
import {$, $$, activeSession, bodySheet, byId, clock, closeSheet, decimal, disclosure, esc, icon, iconButton, lastBody,
  loadText, machineText, on, prescribed, sample, sheet, techniqueName, techniques, timeText, title} from './common.js';
import {exerciseEditor, machinePicker} from './library.js';
import {animatePlate, figure, plate} from './plate.js';
import {bindFeedback, decideDeload, feedbackMarkup, finishFeedback, refreshPump, slotReasons} from './coach-ui.js';

const rowDrafts = new Map();
const pendingRows = new Map();
const finishing = new Set();
const expandedSlots = new Set();
const beatTimers = new WeakMap();
let audio, wakeLock, wakeRequest, keyboardInput, holdTimer, lastRestAlarm;
const sheetTypes = ['working', 'drop', 'parcial', 'myo', 'aguante'];
const specialChild = new Set(['drop', 'myo', 'aguante']);

export function slotContext(data, slot, kind = 'normal', appDeload = false) {
  const exercise = byId(data.exercises, slot.exerciseId);
  const equipment = byId(data.machines, slot.machineId === undefined ? exercise?.defaultMachineId : slot.machineId) ?? null;
  const history = workingHistory(data.sets, data.sessions, slot.exerciseId, equipment?.id ?? null);
  const last = history.at(-1)?.sets ?? [];
  const bodyweight = !!exercise?.bodyweight || history.some(group => group.sets.some(bodyweightSet));
  // The seed's observed maximum on a bodyweight station is not a limit on added load.
  const bodyweightStation = equipment && exercise?.bodyweight && equipment.name === exercise.name;
  const machine = bodyweight && (bodyweightStation || equipment?.max === 0) ? {...equipment, max: null} : equipment;
  const stall = kind === 'normal' && !appDeload ? liftStall(history, slot, machine) : null;
  const stallKey = 'stall:' + JSON.stringify([slot.exerciseId, machine?.id ?? null]);
  const stored = data.options[stallKey];
  const applied = stall && stored?.since === stall.since ? stored : {};
  const technique = slot.technique ?? 'aguante';
  const repMax = slot.repMax + (applied.range ? 2 : 0);
  const next = prescription({...slot, repMax}, last, machine, kind, appDeload);
  return {exercise, machine, bodyweight, history, last, next,
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
  expandedSlots.clear();
  await ctx.save([['sessions', session], option('draftUI', null)], {render: false, newSession: true});
  ctx.go('entrenar');
  updateWakeLock(ctx);
}

export function chooseDay(ctx, choose, selected) {
  const {pending = [], week} = weekContext(ctx.data, ctx.now());
  sheet('Elegir día', pending.length ? '<ul class="plain-list">' + pending.map(day =>
    '<li><button class="list-button row" data-day="' + day.dayIndex + '"><span>' + esc(day.name) + (day.dayIndex === selected ? ' · seleccionado' : '') + '</span>'
    + '<small class="muted">' + quantity(day.slots.length, 'ejercicio') + '</small></button></li>').join('') + '</ul>'
    : week ? '<p>Completaste los días del plan semanal.</p>' : '<p>Importa o crea un programa desde la pestaña Programa.</p>',
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
  const source = info.history.findLast(group => group.sets.some(comparable))?.sets.find(comparable);
  const target = !child && type !== 'warmup' ? info.next.targets[index] : null;
  const load = (target ? target.weight : source?.weight ?? info.next.load) ?? (info.bodyweight ? 0 : null);
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
  const planned = type === 'warmup' ? slot.warmups : info.next.setCount;
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
    const automatic = type === 'working' && index === planned - 1 && info.applied.technique;
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
  const ghost = isGhost(row, field, saved);
  const display = logInputText(source[field], field === 'weight' && row.bodyweight);
  const disabled = saved ? ' disabled' : '';
  return '<div class="set-value">' + iconButton('minus', 'Bajar ' + label, 'data-step="-1" data-value="' + field + '"' + disabled)
    + '<input inputmode="decimal" autocomplete="off" aria-label="' + label + '" value="' + esc(display) + '" placeholder="' + label
    + '" data-log-input="' + field + '" class="' + (ghost ? 'ghost' : '') + '"' + disabled + '>'
    + iconButton('plus', 'Subir ' + label, 'data-step="1" data-value="' + field + '"' + disabled) + '</div>';
}

const isGhost = (row, field, saved) => !saved && !!row && (row.target?.[field] != null || !!row.source) && !row[field + 'Edited'];

function rowHTML(draft, set) {
  const source = set ?? draft;
  const type = source.type === 'warmup' ? 'Calentamiento' : techniqueName(source.type);
  return '<div class="setrow' + (draft.child ? ' set-child' : '') + '" data-row="' + esc(draft.key) + '"><div class="setrow-head">'
    + '<span class="caption muted">' + (draft.child ? 'Serie extra' : 'Serie ' + (draft.index + 1)) + '</span>'
    + (draft.source ? '<span class="caption muted last-set">últ. ' + esc(loadText(draft.source.weight, draft.source.unit, false)) + ' × ' + draft.source.reps
      + '<span class="caption beat-last" data-beat-last role="status"' + (set?.beatLast ? ' data-earned aria-label="Superaste la última"' : '') + '></span></span>' : '')
    + '<span class="record caption" data-row-pr' + (set?.record ? '' : ' hidden') + '>Récord</span>'
    + (set ? '<span class="caption muted">' + esc(type) + '</span>' : '<button type="button" data-type aria-label="Tipo de serie: ' + esc(type) + '">' + esc(type) + '</button>')
    + '</div><div class="set-values">' + valueField('weight', set, draft, 'peso')
    + valueField('reps', set, draft, source.type === 'aguante' ? 'segundos' : 'reps') + '</div>'
    + '<button type="button" class="icon-button set-check" data-check aria-pressed="' + Boolean(set) + '" aria-label="'
    + (set ? 'Desmarcar' : 'Registrar') + ' serie ' + (draft.index + 1) + '" data-set-id="' + esc(set?.id) + '">' + icon('check') + '</button>'
    + (draft.type === 'warmup' ? '' : '<div class="rir-picks"><span class="caption muted">RIR</span>' + [0, 1, 2, 3].map(rir =>
      '<button type="button" data-rir="' + rir + '" aria-label="RIR ' + (rir === 3 ? '3 o más' : rir) + '" aria-pressed="' + (source.rir === rir) + '"'
      + (set ? ' disabled' : '') + '>' + (rir === 3 ? '3+' : rir) + '</button>').join('') + '</div>') + '</div>';
}

function slotHTML(ctx, session, slot, logged, positions) {
  const info = sessionSlot(ctx.data, session, slot);
  const name = info.exercise?.name ?? 'Ejercicio';
  const {machine, next} = info;
  const rest = slot.restMin != null && slot.restMax != null
    ? (slot.restMin === slot.restMax ? number(slot.restMin) : number(slot.restMin) + '–' + number(slot.restMax)) + ' min'
    : (ctx.data.options.defaultRest ?? 90) + ' s';
  const warmups = visibleRows(slot, session, info, logged, 'warmup');
  const rows = visibleRows(slot, session, info, logged, 'working');
  const complete = !slot.archived && rows.length > 0 && rows.every(row => row.set);
  const collapsed = complete && !expandedSlots.has(slot.key);
  const suggestion = (next.load != null ? 'Hoy ' + loadText(next.load, machine?.unit) + ' × ' + next.reps + ' · ' : '') + next.reason;
  const equipment = machineText(ctx.data, machine, info.bodyweight);
  const gym = byId(ctx.data.gyms, machine?.gymId)?.name;
  return '<article class="panel slot stack" data-slot="' + esc(slot.key) + '"><h2 class="slot-name">' + esc(name) + '</h2>'
    + '<div class="row slot-machine-row"><button type="button" class="chip machine" data-pick-machine aria-label="' + esc(equipment) + '"'
    + (slot.archived ? ' disabled' : '') + '>'
    + (gym ? '<span class="machine-gym">' + esc(gym) + ' · </span><span class="machine-name">' + esc(equipment.slice(gym.length + 3)) + '</span>' : esc(equipment)) + '</button>'
    + (slot.archived ? '' : '<button type="button" class="link-button" data-substitute>Sustituir</button>') + '</div>'
    + '<p class="caption muted">' + esc(prescribed({...slot, repMax: info.repMax, sets: next.setCount, rir: next.rir})) + ' · descanso ' + esc(rest)
    + (info.applied.technique || session.week > 7 && slot.technique
      ? ' · última serie: ' + esc(techniqueName(info.technique).toLowerCase()) : '') + '</p>'
    + (slot.archived ? '' : '<p class="suggestion">' + esc(suggestion) + '</p>')
    + slotReasons(slot)
    + (slot.notes ? '<p class="caption muted">' + esc(slot.notes) + '</p>' : '')
    + (info.stall && !slot.archived ? '<div><button type="button" class="chip warning" data-stall>Estancado</button></div>' : '')
    + '<div class="slot-sets" id="sets-' + esc(slot.key) + '"' + (collapsed ? ' data-collapsed inert' : '') + '><div class="slot-sets-inner">'
    + (warmups.length ? '<details>' + disclosure('Calentamiento (' + warmups.length + ')') + warmups.map(({draft, set}) => rowHTML(draft, set)).join('') + '</details>' : '')
    + feedbackMarkup(ctx.data, session, slot, positions, 'soreness')
    + '<div data-working-sets>' + rows.map(({draft, set}) => rowHTML(draft, set)).join('') + '</div></div></div>'
    + feedbackMarkup(ctx.data, session, slot, positions, 'pump')
    + (slot.archived ? '' : '<button type="button" class="link-button slot-toggle" data-toggle-sets aria-controls="sets-' + esc(slot.key)
      + '" aria-expanded="' + !collapsed + '"' + (complete ? '' : ' hidden') + '><span data-toggle-label>'
      + (collapsed ? 'Ver series registradas' : 'Ocultar series') + '</span> <span class="record" data-slot-record'
      + (collapsed && logged.some(row => row.record) ? '' : ' hidden') + '>Récord</span></button>') + '</article>';
}

function showSets(article, complete, collapsed) {
  const toggle = $('[data-toggle-sets]', article);
  if (!toggle) return;
  const sets = $('.slot-sets', article);
  toggle.hidden = !complete;
  toggle.setAttribute('aria-expanded', String(!collapsed));
  $('[data-toggle-label]', toggle).textContent = collapsed ? 'Ver series registradas' : 'Ocultar series';
  $('[data-slot-record]', toggle).hidden = !collapsed || !$$('[data-row-pr]', sets).some(chip => !chip.hidden);
  if (collapsed && sets.contains(document.activeElement)) toggle.focus({preventScroll: true});
  sets.toggleAttribute('data-collapsed', collapsed);
  sets.inert = collapsed;
}

function sessionDose(ctx, session) {
  return dose(sessionRows(ctx, session), ctx.data.exercises, [session]);
}
const sessionTargets = (ctx, session) => session.targets ?? byId(ctx.data.programs, session.programId)?.targets ?? {};

export function trainingView(ctx) {
  const session = activeSession(ctx.data);
  if (!session) {
    const {week, pending = []} = weekContext(ctx.data, ctx.now());
    return title(ctx, 'Entrenar') + '<div class="section"><p class="muted">No hay una sesión activa.</p>'
      + (pending.length ? '<button class="primary" data-choose>Elegir día</button>'
        : week ? '<a href="#hoy">Ver plan semanal</a>' : '<a href="#programa">Importar o crear un programa</a>') + '</div>';
  }
  const groups = sessionRows(ctx, session);
  const positions = ctx.data.options.autoVolume === false ? {} : feedbackPositions(session, ctx.data.exercises, groups, sessionAppDeload(session, ctx.data));
  const emphasize = new Set(session.slots.flatMap(slot => Object.keys(byId(ctx.data.exercises, slot.exerciseId)?.muscles ?? {})));
  const {total} = sessionDose(ctx, session);
  const {done} = dose(ctx.data.sets, ctx.data.exercises, ctx.data.sessions, session.date);
  return '<div class="training"><header class="session-header"><div class="row session-heading"><h1>' + esc(session.dayName) + '</h1>'
    + '<div class="session-actions"><button type="button" data-finish>Terminar</button>'
    + iconButton('more-horizontal', 'Opciones de la sesión', 'data-session-menu') + '</div></div>'
    + '<div class="session-meta"><span>Sesión Nº ' + session.n + ' · ' + timeText(session.start) + ' · <span data-elapsed></span></span>'
    + '<button type="button" class="link-button" data-body>PC ' + (session.bodyweight ? number(session.bodyweight) + ' kg' : '· registrar') + '</button>'
    + '<span data-offline aria-label="Pendiente de sincronizar" title="Pendiente de sincronizar">' + icon('cloud-off', true) + '</span></div>'
    + '<div class="panel mini-body" data-mini>' + figure(done, sessionTargets(ctx, session), {emphasize, compact: true})
    + '<div>' + sample(ctx) + '<p class="caption muted"><span data-mini-total>' + quantity(total, 'serie efectiva', 'series efectivas') + '</span> de hoy</p></div></div></header>'
    + session.slots.map(slot => slotHTML(ctx, session, slot, groups.filter(set => set.slotId === slot.key), positions)).join('') + '</div>';
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
  capsule.innerHTML = session && ctx.route !== 'entrenar' ? '<a href="#entrenar" class="dock-bar capsule">Sesión Nº '
    + session.n + ' · <span data-elapsed></span> · Volver</a>' : '';
  if (!hasRest) leaveRest(restRoot);
  else if (!restRoot.firstElementChild || Object.hasOwn(restRoot.firstElementChild.dataset, 'leaving')) {
    restRoot.innerHTML = '<div class="dock-bar"><span class="rest-clock" data-rest-clock aria-label="Tiempo de descanso"></span><div class="rest-actions">'
      + '<button type="button" data-rest="-15" aria-label="Quitar 15 segundos">−15 s</button><button type="button" data-rest="15" aria-label="Añadir 15 segundos">+15 s</button>'
      + '<button type="button" data-rest="skip">Saltar</button></div><span class="rest-progress" aria-hidden="true"></span></div>';
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
  if (offline) offline.hidden = !(ctx.data.pending || !navigator.onLine || ctx.mode === 'offline');
  const rest = ctx.data.options.draftUI;
  if (rest?.sessionId !== session.id || !rest.restUntil) return;
  const countdown = $('[data-rest-clock]');
  if (countdown) countdown.textContent = clock(Math.ceil((rest.restUntil - now) / 1000));
  const progress = $('.rest-progress');
  if (progress && !document.hidden) {
    const duration = Math.max(1, rest.restUntil - (rest.restStarted ?? rest.restUntil - (ctx.data.options.defaultRest ?? 90) * 1000));
    progress.style.transform = 'scaleX(' + Math.min(1, Math.max(0, (rest.restUntil - now) / duration)) + ')';
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
  $('[data-row-pr]', root).hidden = !set?.record;
  const draft = rowDrafts.get(root.dataset.row);
  for (const input of $$('[data-log-input]', root)) {
    const field = input.dataset.logInput;
    if (set) input.value = logInputText(set[field], field === 'weight' && draft.bodyweight);
    input.classList.toggle('ghost', isGhost(draft, field, set));
  }
  for (const node of $$('[data-step], [data-rir]', root)) node.disabled = !!set;
}

function showBeatLast(root, label) {
  const marker = $('[data-beat-last]', root);
  if (!marker) return;
  clearTimeout(beatTimers.get(marker));
  marker.toggleAttribute('data-earned', !!label);
  marker.textContent = label ?? '';
  marker.removeAttribute('aria-label');
  if (!label) return;
  beatTimers.set(marker, setTimeout(() => {
    marker.textContent = '';
    marker.setAttribute('aria-label', 'Superaste la última');
    const article = root.closest('[data-slot]');
    if (article?.isConnected) updateSlotCompletion(article);
  }, 600));
}

function updateSlotCompletion(article) {
  const checks = $$('[data-working-sets] [data-check]', article);
  const complete = checks.length > 0 && checks.every(button => button.dataset.setId);
  const key = article.dataset.slot;
  const showingGain = $$('[data-beat-last]', article).some(marker => marker.textContent);
  if (!complete) expandedSlots.delete(key);
  showSets(article, complete, complete && !showingGain && !expandedSlots.has(key));
}

function checkRow(ctx, root, session, slot, keepKeyboard = false) {
  const draft = rowDrafts.get(root.dataset.row);
  if (!draft || pendingRows.has(draft.key) || finishing.has(session.id) || activeSession(ctx.data)?.id !== session.id) return;
  const pending = saveRow(ctx, root, session, slot, draft, keepKeyboard).finally(() => pendingRows.delete(draft.key));
  pendingRows.set(draft.key, {sessionId: session.id, pending});
  return pending;
}

async function saveRow(ctx, root, session, slot, draft, keepKeyboard) {
  const checked = $('[data-check]', root);
  const existing = byId(ctx.data.sets, checked.dataset.setId);
  checked.disabled = true;
  try {
    const {machine, exercise} = sessionSlot(ctx.data, session, slot);
    const changed = Object.keys(exercise?.muscles ?? {});
    let set = null, gain = null;
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
      set.record = isHard(set) && !!candidate && compareStrength(set, candidate, bodyweight) > 1e-9;
      gain = beatLast(set, draft.source);
      set.beatLast = !!gain;
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
    showBeatLast(root, gain);
    const article = root.closest('[data-slot]');
    if (article?.isConnected) updateSlotCompletion(article);
    const {total} = sessionDose(ctx, session);
    const mini = $('[data-mini]');
    if (mini) {
      if (isHard(set ?? existing)) {
        const {done} = dose(ctx.data.sets, ctx.data.exercises, ctx.data.sessions, session.date);
        animatePlate(mini, done, sessionTargets(ctx, session), changed);
      }
      $('[data-mini-total]', mini).textContent = quantity(total, 'serie efectiva', 'series efectivas');
      if (set) mini.dataset.lastSet = set.id;
    }
    refreshPump(ctx, session);
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
  expandedSlots.clear();
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

function finish(ctx, session) {
  const now = +ctx.now();
  return withSessionFinish(ctx, session, () => finishSummary(ctx, activeSession(ctx.data), now));
}

async function finishSummary(ctx, session, now) {
  const sets = sessionRows(ctx, session);
  if (discardable(session, now, sets)) return discard(ctx, session);
  const {done, total} = sessionDose(ctx, session), targets = sessionTargets(ctx, session);
  const weekly = dose(ctx.data.sets, ctx.data.exercises, ctx.data.sessions, session.date);
  const records = sets.filter(set => set.record);
  const counts = session.slots.filter(slot => !slot.archived).reduce((sum, slot) => sum + sessionSlot(ctx.data, session, slot).next.setCount, 0);
  const performed = sets.filter(set => !set.parentId && set.type !== 'warmup').length;
  let saving;
  const dialog = sheet('Resumen de la sesión', '<div class="stack">'
    + plate({done, targets, total, goal: counts, withGaps: false, flat: true, footer: performed + ' de ' + counts + ' ' + plural(counts, 'serie prescrita', 'series prescritas')})
    + (records.length ? '<section class="section"><h3>Récords</h3><ul class="plain-list">' + records.map(set =>
      '<li class="record">' + esc(byId(ctx.data.exercises, set.exerciseId)?.name) + ' · ' + esc(loadText(set.weight, set.unit)) + ' × ' + set.reps + '</li>').join('') + '</ul></section>' : '')
    + '<section class="section"><h3>Aporte semanal</h3><ul class="plain-list">' + Object.keys(done).map(key => '<li>'
      + muscles[key] + ' ' + number(weekly.done[key]) + ' / ' + number(targets[key] ?? 0) + ' esta semana · +' + number(done[key]) + '</li>').join('') + '</ul></section>'
    + '<div class="cols"><button type="button" data-back>Volver</button><button type="button" class="primary" data-save-session>Guardar</button></div></div>',
  root => {
    on(root, '[data-back]', closeSheet);
    on(root, '[data-save-session]', async node => {
      node.disabled = true;
      try {
        saving = ctx.save([['sessions', {id: session.id, end: now}], ...finishFeedback(ctx.data, session), option('draftUI', null)], {render: false});
        await saving;
        rowDrafts.clear();
        expandedSlots.clear();
        closeSheet();
        ctx.go('hoy');
        updateWakeLock(ctx);
        ctx.notice('Sesión guardada.');
      } finally { node.disabled = false; }
    });
  });
  await new Promise(resolve => dialog.addEventListener('close', resolve, {once: true}));
  await saving?.catch(() => {});
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
    on(root, '[data-discard]', () => sheet('Terminar sin guardar', '<div class="stack"><p>Se descartarán las series de esta sesión.</p>'
      + '<button type="button" data-discard-now>Descartar sesión</button><button type="button" data-back>Volver</button></div>', dialog => {
      on(dialog, '[data-discard-now]', () => withSessionFinish(ctx, session, () => discard(ctx, session)));
      on(dialog, '[data-back]', closeSheet);
    }));
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
  bindFeedback(ctx, session);
  for (const article of $$('[data-slot]', root)) {
    const slot = session.slots.find(row => row.key === article.dataset.slot);
    const {exercise, machine} = sessionSlot(ctx.data, session, slot);
    on(article, '[data-toggle-sets]', button => {
      const collapse = button.getAttribute('aria-expanded') === 'true';
      if (collapse) expandedSlots.delete(slot.key);
      else expandedSlots.add(slot.key);
      showSets(article, true, collapse);
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
      node.addEventListener('contextmenu', event => { event.preventDefault(); setType(ctx, session, slot, node); });
      node.addEventListener('pointerdown', event => {
        if (event.target.closest('button,input')) return;
        holdTimer = setTimeout(() => setType(ctx, session, slot, node), 550);
      });
      for (const event of ['pointerup', 'pointercancel', 'pointerleave']) node.addEventListener(event, () => clearTimeout(holdTimer));
      on(node, '[data-check]', () => checkRow(ctx, node, session, slot));
      on(node, '[data-rir]', button => {
        draft.rir = Number(button.dataset.rir);
        draft.rirEdited = true;
        for (const pick of $$('[data-rir]', node)) pick.setAttribute('aria-pressed', String(pick === button));
      });
      on(node, '[data-step]', button => {
        const field = button.dataset.value, input = $('[data-log-input="' + field + '"]', node);
        const value = field === 'weight' ? weightInput(input.value, draft.bodyweight) : decimal(input.value);
        const direction = Number(button.dataset.step);
        draft[field] = field === 'weight' ? stepLoad(value, direction, machine) : Math.max(1, (value ?? 0) + direction);
        draft[field + 'Edited'] = true;
        input.value = logInputText(draft[field], field === 'weight' && draft.bodyweight);
        input.classList.remove('ghost');
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

import {openDB, option, snapshot, write} from './db.js';
import {modes, mockNow, mockRoute, seedMock} from './mock.js';
import {planId, programWeekAt, weekId} from './coach.js';
import {localDate} from './metrics.js';
import {loadInitialHistory} from './history.js';
import {createSync, restoreFromGoogle} from './sync.js';
import {$, activeProgram, activeSession, closeSheet, dateText, esc, field, formSheet, icon, on, timeText} from './ui/common.js';
import {bindSummary, changeWeekPlan, maintainCoach, summaryView} from './ui/coach-ui.js';
import {bindWelcome, startImport, welcomeView} from './ui/import-wizard.js';
import {loadPlate} from './ui/plate.js';
import {bindProgram, pickProgram, programView} from './ui/program-ui.js';
import {bindProgress, progressView} from './ui/progress.js';
import {bindToday, todayView} from './ui/today.js';
import {bindKeyboard, bindTraining, renderDock, tickTraining, trainingView, updateWakeLock} from './ui/training.js';

const tabs = [
  ['hoy', 'Hoy', 'calendar-days', 'hoy'],
  ['entrenar', 'Entrenar', 'dumbbell', 'entrenar'],
  ['progreso', 'Progreso', 'line-chart', 'progreso/fuerza'],
  ['programa', 'Programa', 'book-open', 'programa']
];

const screens = {hoy: [todayView, bindToday], entrenar: [trainingView, bindTraining], progreso: [progressView, bindProgress],
  programa: [programView, bindProgram], resumen: [summaryView, bindSummary]};
const query = new URLSearchParams(location.search).get('mock');
const mode = modes.includes(query) ? query : null;
const root = $('#screen');
const noticeRoot = $('#notice');
let noticeTimer;

function notify(message, warning = false, secondary = null) {
  clearTimeout(noticeTimer);
  const dialog = $('#sheet');
  (dialog.open && !Object.hasOwn(dialog.dataset, 'closing') ? dialog : document.body).append(noticeRoot);
  noticeRoot.classList.toggle('warning', warning);
  noticeRoot.innerHTML = '<span>' + esc(message) + '</span>' + (secondary ? '<button type="button" data-toast>' + esc(secondary.label) + '</button>' : '');
  noticeRoot.hidden = false;
  on(noticeRoot, '[data-toast]', async node => {
    node.disabled = true;
    try { await secondary.action(); noticeRoot.hidden = true; }
    finally { node.disabled = false; }
  });
  noticeTimer = setTimeout(() => { noticeRoot.hidden = true; }, secondary?.duration ?? 4800);
}

async function loadIcons() {
  const response = await fetch(new URL('../icons/lucide.svg', import.meta.url));
  if (!response.ok) throw Error('No se pudieron cargar los iconos. Vuelve a abrir Gym.');
  $('#sprite').innerHTML = await response.text();
}

async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  const [db] = await Promise.all([openDB(!!mode), loadPlate(), loadIcons()]);
  let initial = await snapshot(db);
  const historyLoaded = await loadInitialHistory(db, initial, mode);
  if (mode) {
    await seedMock(db, mode, initial.options);
    initial = await snapshot(db);
  } else if (historyLoaded || !initial.sessions.length && !initial.sets.length && !Object.hasOwn(initial.options, 'onboarded')) {
    initial = await snapshot(db);
  }
  const nav = $('#tabs');
  let sync;
  let seenToday = false;
  let transition;
  let calendarDay, coaching, coachQueued = false;
  const prompted = new Set();
  function updateCoach() {
    if (mode || activeSession(ctx.data) || !ctx.data.options.onboarded) return;
    const program = activeProgram(ctx.data);
    if (!program) return;
    const id = weekId(ctx.now()), week = programWeekAt(ctx.data, program, id);
    const key = planId(id, program.id, week.n);
    if (!$('#sheet').open && !prompted.has(key) && !ctx.data.weekPlans.some(row => row.id === key)) {
      prompted.add(key);
      changeWeekPlan(ctx, id);
    }
    if (coaching) { coachQueued = true; return; }
    coaching = maintainCoach(ctx).catch(error => notify(error.message, true)).finally(() => {
      coaching = null;
      if (coachQueued) { coachQueued = false; updateCoach(); }
    });
  }
  const ctx = {
    root, mode, data: initial, route: 'hoy', subroute: '',
    now: () => mode ? mockNow(ctx.data.options.mockSeedAt, mode) : new Date(),
    notice: notify,
    backupData: () => snapshot(db, {includeDeleted: true}),
    async reload() { this.data = await snapshot(db); },
    go(route) {
      if (location.hash === '#' + route) this.render();
      else location.hash = route;
    },
    async save(changes, {render = true, remote = false, newSession = false} = {}) {
      const syncChanged = !mode && changes.some(([entity, row]) => entity === 'settings'
        && ['syncUrl', 'syncToken'].includes(row.key) && this.data.options[row.key] !== row.value);
      if (syncChanged) changes = [...changes, option('programRestoreChecked', false)];
      await write(db, changes, {queue: !mode, remote, newSession});
      await this.reload();
      if (render) this.render();
      if (syncChanged) sync?.reconnect().catch(() => {});
      else if (!mode && this.data.pending) sync?.trigger().catch(() => {});
    },
    render({replayProgress = false} = {}) {
      const previousRoute = root.dataset.route;
      this.previousProgressSection = $('[data-section][aria-current]', root)?.dataset.section;
      root.dispatchEvent(new Event('gym-before-render'));
      const [route, subroute] = (location.hash.slice(1) || (mode ? mockRoute(mode) : 'hoy')).split('/');
      this.route = Object.hasOwn(screens, route) ? route : 'hoy';
      this.subroute = subroute ?? '';
      if (this.route === 'resumen' && previousRoute !== 'resumen') this.summaryBack = previousRoute === 'progreso' ? 'progreso' : 'hoy';
      calendarDay = localDate(this.now());
      const onboarded = !!this.data.options.onboarded;
      nav.hidden = !onboarded;
      nav.innerHTML = onboarded ? tabs.map(([key, name, symbol, href]) => '<a href="#' + href + '"'
        + ((this.route === 'resumen' ? this.summaryBack : this.route) === key ? ' aria-current="page"' : '')
        + '>' + icon(symbol) + '<span>' + name + '</span></a>').join('') : '';
      root.dataset.route = onboarded ? this.route : 'bienvenida';
      delete root.dataset.todayMotion;
      if (root.dataset.route === 'hoy' && previousRoute !== 'hoy') {
        if (!document.hidden) root.dataset.todayMotion = seenToday ? 'return' : 'first';
        seenToday = true;
      }
      this.progressMotion = !document.hidden && (replayProgress || this.route === 'progreso'
        && (previousRoute !== this.route || this.previousProgressSection !== (subroute || 'fuerza')));
      const [view, bind] = onboarded ? screens[this.route] : [welcomeView, bindWelcome];
      root.innerHTML = view(this);
      bind(this);
      if (!activeSession(this.data) || this.route !== 'entrenar') {
        $('#keyboard-dock').hidden = true;
        document.body.removeAttribute('data-keyboard');
      }
      renderDock(this);
      updateWakeLock(this);
      updateCoach();
    },
    pickProgram: () => pickProgram(ctx),
    startImport: () => startImport(ctx),
    async syncNow() {
      if (mode) return notify('Sincronización desactivada en los datos de ejemplo.');
      const result = await sync.trigger(true);
      if (syncError) throw Error(syncError);
      if (!result?.programName) notify('Sincronización al día.');
    },
    async restore(fromWelcome = false) {
      if (mode) return notify('Restauración desactivada en los datos de ejemplo.');
      const perform = async cfg => {
        const count = await restoreFromGoogle(db, cfg);
        if (fromWelcome) await ctx.save([option('syncUrl', cfg.syncUrl.trim()), option('syncToken', cfg.syncToken.trim())], {render: false});
        else ctx.data = await snapshot(db);
        closeSheet();
        ctx.render();
        notify(count ? 'Datos restaurados desde Google.' : 'La hoja está vacía. Puedes importar el historial o comenzar una sesión.');
      };
      if (fromWelcome || !ctx.data.options.syncUrl || !ctx.data.options.syncToken) {
        formSheet('Restaurar desde Google', field('URL de sincronización', 'syncUrl', ctx.data.options.syncUrl, 'type="url" required')
          + field('Token', 'syncToken', '', 'type="password" required'), async values => {
          if (!fromWelcome) {
            await restoreFromGoogle(db, values);
            await ctx.save([option('syncUrl', values.syncUrl.trim()), option('syncToken', values.syncToken.trim())]);
            closeSheet();
            notify('Restauración completada.');
          } else await perform(values);
        }, 'Restaurar');
      } else await perform(ctx.data.options);
    }
  };
  let syncError = '';
  if (!mode) {
    sync = createSync(db, () => ctx.data.options, async (error = '', programName = '') => {
      syncError = error;
      ctx.data = await snapshot(db);
      if (programName) {
        ctx.render();
        notify('Programa ' + programName + ' cargado desde Google');
      }
      const status = $('[data-sync-status]');
      if (status) {
        const last = ctx.data.options.lastSync;
        status.classList.toggle('warning', !!error);
        status.textContent = 'Última sincronización: ' + (last ? dateText(last) + ' · ' + timeText(last) : '—')
          + ' · ' + ctx.data.pending + ' pendientes' + (error ? ' · ' + error : '');
      }
      tickTraining(ctx);
    });
  }
  $('#sheet').addEventListener('close', () => {
    if (noticeRoot.parentNode === $('#sheet')) { noticeRoot.hidden = true; document.body.append(noticeRoot); }
    updateCoach();
  });
  $('#sheet').addEventListener('cancel', event => { event.preventDefault(); closeSheet(); });
  document.addEventListener('gym-error', event => notify(event.detail?.message || 'No se pudo completar la acción. Intenta de nuevo.', true));
  window.addEventListener('hashchange', () => {
    const current = tabs.findIndex(([key]) => key === ctx.route);
    const target = tabs.findIndex(([key]) => key === location.hash.slice(1).split('/')[0]);
    const render = () => { ctx.render(); window.scrollTo(0, 0); };
    transition?.skipTransition();
    if (document.hidden || typeof document.startViewTransition !== 'function' || !ctx.data.options.onboarded
      || target < 0 || current === target) return render();
    document.documentElement.dataset.tabDirection = target > current ? 'forward' : 'back';
    transition = document.startViewTransition(render);
    const running = transition;
    // Skipped transitions reject ready, but still perform the render.
    running.ready.catch(() => {});
    const clear = () => {
      if (transition !== running) return;
      transition = null;
      delete document.documentElement.dataset.tabDirection;
    };
    running.finished.then(clear, clear);
  });
  function updateCalendar() {
    if (calendarDay && localDate(ctx.now()) !== calendarDay && !activeSession(ctx.data) && !$('#sheet').open) ctx.render();
  }
  function updateVisibility() {
    document.documentElement.toggleAttribute('data-motion-hidden', document.hidden);
    if (document.hidden) transition?.skipTransition();
    updateWakeLock(ctx);
    if (!document.hidden) { updateCalendar(); tickTraining(ctx); }
  }
  document.addEventListener('visibilitychange', updateVisibility);
  window.addEventListener('offline', () => tickTraining(ctx));
  window.addEventListener('online', () => tickTraining(ctx));
  bindKeyboard(ctx);
  updateVisibility();
  ctx.render();
  if (historyLoaded === true) notify('Historial cargado: 1.084 series desde ene 2026');
  sync?.trigger().catch(() => {});
  setInterval(() => tickTraining(ctx), 250);
  setInterval(() => { if (!document.hidden) updateCalendar(); }, 10000);
}

start().catch(error => {
  root.innerHTML = '<h1>Gym</h1><p class="warning">' + esc(error.message || 'No se pudo abrir la app.') + '</p>'
    + '<p>Vuelve a cargar Gym. En el primer acceso se necesita conexión para descargar la app.</p>'
    + '<button type="button" data-reload>Volver a cargar</button>';
  on(root, '[data-reload]', () => location.reload());
});

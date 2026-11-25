import {acknowledge, countPrograms, option, pending, restoreChanges, write} from './db.js';

const online = () => navigator.onLine !== false;

function config(options) {
  if (!options.syncUrl || !options.syncToken) throw Error('Completa la URL y el token en Ajustes para sincronizar con Google.');
  let url;
  try { url = new URL(options.syncUrl); }
  catch { throw Error('La URL de sincronización no es válida. Revisa Ajustes.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('Usa la URL HTTPS del servicio de sincronización.');
  if ([...url.searchParams.keys()].some(key => key.toLowerCase() === 'token')) {
    throw Error('Quita el token de la URL y guárdalo en su campo de Ajustes.');
  }
  return {url, token: options.syncToken};
}

async function request(url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, {...init, signal: controller.signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'});
    const result = await response.json();
    if (result.error === 'unauthorized' || response.status === 401) throw Error('Google rechazó el token. Revísalo en Ajustes y vuelve a sincronizar.');
    if (!response.ok || !result.ok) throw Error('Google no pudo guardar los cambios. Intenta sincronizar de nuevo.');
    return result;
  } catch (error) {
    if (error instanceof SyntaxError) throw Error('Google no devolvió datos de Gym. Revisa la URL y el acceso de la implementación.');
    if (error instanceof TypeError || error.name === 'AbortError') throw Error('No se pudo conectar con Google. Los cambios siguen en el teléfono. Intenta de nuevo al volver la señal.');
    throw error;
  } finally { clearTimeout(timeout); }
}

export function createSync(db, getOptions, refresh) {
  let busy, timeout, failures = 0, nextAttempt = 0;
  async function run(force) {
    if (!online()) {
      if (force) throw Error('Sin conexión: se guardó en el teléfono y se sincroniza al volver la señal.');
      return;
    }
    const options = getOptions();
    if (!force && (!options.syncUrl || !options.syncToken || Date.now() < nextAttempt)) return;
    const sameCredentials = () => {
      const current = getOptions();
      return current.syncUrl === options.syncUrl && current.syncToken === options.syncToken;
    };
    let count = 0, programName = '', restored = false;
    try {
      const {url, token} = config(options);
      if ((!options.programRestoreChecked || force) && !await countPrograms(db)) {
        const changes = await fetchRestore(options, 0);
        if (!sameCredentials()) return;
        const written = await write(db, changes, {queue: false, remote: true, ifNoProgram: true});
        if (!sameCredentials()) return;
        const programs = changes.filter(([entity, row]) => entity === 'programs' && !row.deleted).map(([, row]) => row);
        const applied = programs.filter(row => written.some(record => record.id === row.id));
        programName = (applied.find(row => row.active) ?? applied[0])?.name ?? '';
        await write(db, [option('programRestoreChecked', true), option('lastSync', Date.now()), option('onboarded', true)], {queue: false});
        restored = true;
        if (programName) await refresh('', programName);
      }
      while (online()) {
        const batch = await pending(db, 200);
        if (!sameCredentials()) return;
        if (!batch.length) break;
        const result = await request(url, {method: 'POST', headers: {'Content-Type': 'text/plain'}, body: JSON.stringify({token, ops: batch})});
        if (!Array.isArray(result.acked) || !batch.some(row => result.acked.includes(row.id))) {
          throw Error('Google no confirmó los cambios. Vuelve a sincronizar desde Ajustes.');
        }
        await acknowledge(db, batch, result.acked);
        count += batch.filter(row => result.acked.includes(row.id)).length;
      }
      if (force && !count && !restored) await request(url, {method: 'POST', headers: {'Content-Type': 'text/plain'}, body: JSON.stringify({token, ops: []})});
      if (!sameCredentials()) return;
      if (!restored && (force || count)) await write(db, [option('lastSync', Date.now())], {queue: false});
      failures = 0;
      nextAttempt = 0;
      await refresh();
      return {count, programName};
    } catch (error) {
      if (!sameCredentials()) return;
      failures++;
      const delay = Math.min(300000, 1000 * 2 ** Math.min(failures, 10));
      nextAttempt = Date.now() + delay;
      clearTimeout(timeout);
      timeout = setTimeout(() => trigger().catch(() => {}), delay);
      await refresh(error.message);
      if (force) throw error;
    }
  }
  const trigger = (force = false) => {
    if (!busy) busy = run(force).finally(() => { busy = null; });
    return busy;
  };
  const reconnect = () => {
    const restart = () => {
      clearTimeout(timeout);
      nextAttempt = 0;
      return trigger();
    };
    return busy ? busy.then(restart, restart) : restart();
  };
  const onlineHandler = () => { reconnect().catch(() => {}); };
  window.addEventListener('online', onlineHandler);
  const visibleHandler = () => { if (!document.hidden) trigger().catch(() => {}); };
  document.addEventListener('visibilitychange', visibleHandler);
  setInterval(visibleHandler, 60000);
  return {trigger, reconnect};
}

async function fetchRestore(options, since) {
  if (!online()) throw Error('Sin conexión. Vuelve a conectarte para restaurar desde Google.');
  const {url, token} = config(options);
  const result = await request(url, {
    method: 'POST', headers: {'Content-Type': 'text/plain'}, body: JSON.stringify({token, action: 'restore', since})
  });
  if (!Array.isArray(result.rows)) throw Error('Google no envió las filas de Gym. Revisa la implementación y vuelve a intentarlo.');
  return restoreChanges(result.rows);
}

export async function restoreFromGoogle(db, options, since = 0) {
  const changes = await fetchRestore(options, since);
  await write(db, changes, {queue: false, remote: true});
  await write(db, [option('lastSync', Date.now()), option('onboarded', true), option('programRestoreChecked', true)], {queue: false});
  return changes.length;
}

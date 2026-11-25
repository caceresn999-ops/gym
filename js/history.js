import {seedHistory} from './db.js';

export async function loadInitialHistory(db, data, mock) {
  if (mock) return false;
  let history;
  try {
    const response = await fetch(new URL('../seed/history.json', import.meta.url));
    if (!response.ok) throw Error();
    history = await response.json();
  } catch {
    if (data.sessions.length || data.sets.length || Object.hasOwn(data.options, 'onboarded')) return false;
    throw Error('No se pudo cargar el historial. Vuelve a abrir Gym.');
  }
  if (history.version <= (data.options.seedVersion ?? 0)) return false;
  return seedHistory(db, history);
}

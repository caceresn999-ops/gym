export const entities = ['gyms', 'machines', 'exercises', 'programs', 'phases', 'sessions', 'sets', 'body', 'settings', 'weekPlans', 'feedback', 'volumeTargets'];
export const uuid = () => {
  if (globalThis.crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
};

function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const complete = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = resolve;
  transaction.onabort = () => reject(transaction.error ?? Error('No se guardaron los cambios.'));
});

export async function openDB(mock = false) {
  const request = indexedDB.open(mock ? 'gym-mock' : 'gym', 2);
  request.onupgradeneeded = () => {
    const db = request.result;
    for (const name of entities) {
      if (db.objectStoreNames.contains(name)) continue;
      const store = db.createObjectStore(name, {keyPath: 'id'});
      if (name === 'sets') store.createIndex('sessionId', 'sessionId');
      if (name === 'settings') store.createIndex('key', 'key', {unique: true});
    }
    if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', {keyPath: ['entity', 'id']});
  };
  const db = await result(request);
  db.onversionchange = () => db.close();
  return db;
}

export async function snapshot(db, {includeDeleted = false} = {}) {
  const tx = db.transaction([...entities, 'outbox']);
  const rows = await Promise.all([...entities, 'outbox'].map(name => result(tx.objectStore(name).getAll())));
  const data = Object.fromEntries(entities.map((name, index) => [name, includeDeleted ? rows[index] : rows[index].filter(row => !row.deleted)]));
  data.options = Object.fromEntries(data.settings.filter(row => !row.deleted).map(({key, value}) => [key, value]));
  data.pending = rows.at(-1).length;
  return data;
}

export const localKeys = new Set(['syncUrl', 'syncToken', 'lastSync', 'onboarded', 'seedVersion', 'programRestoreChecked', 'mockMode', 'mockSeedAt', 'draftUI']);
export const isPortable = (entity, row) => entities.includes(entity) && row && typeof row.id === 'string'
  && !(entity === 'settings' && localKeys.has(row.key));

export function exportSnapshot(data) {
  return {version: 2, rows: entities.flatMap(entity => data[entity].filter(row => isPortable(entity, row)).map(payload => ({entity, payload})))};
}

export function restoreChanges(rows) {
  return rows.filter(row => row && isPortable(row.entity, row.payload) && Number.isFinite(row.payload.updatedAt))
    .map(({entity, payload}) => [entity, payload]);
}

// Read the previous version inside the write transaction so concurrent tabs use monotone timestamps.
export async function write(db, changes, {queue = true, remote = false, ifNoProgram = false, newSession = false} = {}) {
  if (!changes.length) return [];
  const stores = new Set(changes.map(([name]) => name));
  if (ifNoProgram) stores.add('programs');
  if (newSession) stores.add('settings');
  const tx = db.transaction([...stores, 'outbox'], 'readwrite');
  const done = complete(tx);
  const written = [];
  try {
    if (ifNoProgram && await result(tx.objectStore('programs').count())) {
      await done;
      return written;
    }
    if (newSession) {
      const session = changes.find(([entity]) => entity === 'sessions')[1];
      const [sessions, counter] = await Promise.all([result(tx.objectStore('sessions').getAll()),
        result(tx.objectStore('settings').index('key').get('lastSessionNumber'))]);
      if (!session.end && sessions.some(row => !row.end && !row.deleted)) {
        await done;
        return written;
      }
      const n = nextSessionNumber({sessions: sessions.filter(row => !row.deleted), options: {lastSessionNumber: counter?.value}});
      changes = changes.map(([entity, row]) => [entity, row === session ? {...row, n} : row]);
      changes.push(option('lastSessionNumber', n));
    }
    for (const [entity, value] of changes) {
      const store = tx.objectStore(entity);
      const id = value.id ?? uuid();
      const byKey = entity === 'settings' && value.key;
      if (remote && byKey && localKeys.has(value.key)) continue;
      const previous = await result(byKey ? store.index('key').get(value.key) : store.get(id));
      if (remote && (!value.id || !Number.isFinite(value.updatedAt) || previous?.updatedAt >= value.updatedAt)) continue;
      const row = remote ? {...value} : {
        ...previous, deleted: false, ...value, id: previous?.id ?? id,
        updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1)
      };
      if (remote && previous) {
        if (previous.id !== row.id) store.delete(previous.id);
        tx.objectStore('outbox').delete([entity, previous.id]);
      }
      store.put(row);
      if (queue && !(byKey && localKeys.has(value.key))) {
        tx.objectStore('outbox').put({entity, id: row.id, op: row.deleted ? 'delete' : 'upsert', payload: row});
      }
      written.push(row);
    }
  } catch (error) {
    try { tx.abort(); } catch { /* The transaction already aborted. */ }
    await done.catch(() => {});
    throw error;
  }
  await done;
  return written;
}

export const option = (key, value) => ['settings', {key, value}];
export const nextSessionNumber = data => Math.max(data.options.lastSessionNumber ?? 0, ...data.sessions.map(row => row.n || 0)) + 1;

export function countPrograms(db) {
  return result(db.transaction('programs').objectStore('programs').count());
}

function seedContent({updatedAt, ...row}) {
  return JSON.stringify(row);
}

export async function seedHistory(db, history) {
  const stores = ['gyms', 'machines', 'exercises', 'sessions', 'sets', 'body'];
  const tx = db.transaction([...stores, 'settings', 'outbox'], 'readwrite');
  const done = complete(tx);
  try {
    const settings = tx.objectStore('settings');
    const index = settings.index('key');
    const existing = await Promise.all([result(tx.objectStore('sessions').count()), result(tx.objectStore('sets').count()),
      result(index.get('onboarded'))]);
    const saved = await result(index.get('seedVersion'));
    const first = !saved && !existing.some(Boolean);
    if (!Number.isInteger(history.version) || history.version <= (saved?.value ?? 0)) {
      await done;
      return false;
    }
    const previousTimes = new Set(Object.entries(history.previousVersions ?? {})
      .filter(([version]) => !saved || Number(version) <= saved.value).map(([, time]) => time));
    const toWrite = [];
    const sessionsWithSets = new Set();
    let seeded = !!saved;
    for (const entity of stores) {
      const present = new Map((await result(tx.objectStore(entity).getAll())).map(row => [row.id, row]));
      if (entity === 'sets' && !first) {
        for (const set of present.values()) if (!set.deleted) sessionsWithSets.add(set.sessionId);
      }
      const additions = new Set(Object.entries(history.additions ?? {}).filter(([version]) => Number(version) > (saved?.value ?? 1))
        .flatMap(([, entities]) => entities[entity] ?? []));
      const rows = entity === 'sessions' && !first ? [...history.sessions, ...(history.retiredSessions ?? [])] : history[entity];
      for (const payload of rows) {
        const local = present.get(payload.id);
        if (!local) {
          if (first || additions.has(payload.id)) toWrite.push([entity, payload]);
          continue;
        }
        if (first) continue;
        if (local.updatedAt === payload.updatedAt && seedContent(local) === seedContent(payload)) seeded = true;
        if (!previousTimes.has(local.updatedAt)) continue;
        seeded = true;
        if (local.deleted || local.updatedAt >= payload.updatedAt) continue;
        if (seedContent(local) !== seedContent(payload)) toWrite.push([entity, payload]);
      }
    }
    if (!first && !seeded) {
      await done;
      return false;
    }
    const outbox = tx.objectStore('outbox');
    for (const [entity, payload] of toWrite) {
      if (entity === 'sessions' && payload.deleted && sessionsWithSets.has(payload.id)) continue;
      tx.objectStore(entity).put(payload);
      outbox.put({entity, id: payload.id, op: payload.deleted ? 'delete' : 'upsert', payload});
    }
    const now = Date.now();
    settings.put({id: saved?.id ?? uuid(), key: 'seedVersion', value: history.version, updatedAt: now, deleted: false});
    if (first) settings.add({id: uuid(), key: 'onboarded', value: true, updatedAt: now, deleted: false});
    await done;
    return first ? true : 'updated';
  } catch (error) {
    try { tx.abort(); } catch { /* The transaction already aborted. */ }
    await done.catch(() => {});
    throw error;
  }
}

export function pending(db, limit = 200) {
  return result(db.transaction('outbox').objectStore('outbox').getAll(null, limit));
}

export async function acknowledge(db, batch, ids) {
  const confirmed = new Set(ids);
  const tx = db.transaction('outbox', 'readwrite');
  const done = complete(tx);
  const store = tx.objectStore('outbox');
  for (const sent of batch) {
    if (!confirmed.has(sent.id)) continue;
    const key = [sent.entity, sent.id];
    const current = await result(store.get(key));
    if (current?.payload.updatedAt === sent.payload.updatedAt) store.delete(key);
  }
  await done;
}

export async function resetMock(db) {
  if (db.name !== 'gym-mock') throw Error('Base de ejemplos no disponible.');
  const tx = db.transaction([...entities, 'outbox'], 'readwrite');
  const done = complete(tx);
  for (const name of [...entities, 'outbox']) tx.objectStore(name).clear();
  await done;
}

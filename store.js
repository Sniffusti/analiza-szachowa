// Prosty magazyn klucz → wartość w IndexedDB (bazy PGN, drille, zadania, wyniki trenera).
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open('analiza-szachowa', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction('kv', mode);
    const st = t.objectStore('kv');
    const r = fn(st);
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  }));
}
export const idb = {
  get: (k) => tx('readonly', (s) => s.get(k)),
  set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
  del: (k) => tx('readwrite', (s) => s.delete(k)),
  async keys(prefix = '') {
    const all = await tx('readonly', (s) => s.getAllKeys());
    return (all || []).filter((k) => String(k).startsWith(prefix));
  },
};

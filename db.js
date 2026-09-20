import { DEFAULT_SETTINGS, validateMedicine, validateSettings, photoIDs } from './core.js';
export const DB_NAME = 'home-medicine';
let connection;
export function openDB() {
  if (connection) return Promise.resolve(connection);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('medicines', { keyPath: 'id' });
      db.createObjectStore('photos', { keyPath: 'id' });
      db.createObjectStore('settings');
      db.createObjectStore('meta');
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('请关闭其他药箱页面，再重新打开。'));
    request.onsuccess = () => {
      connection = request.result;
      connection.onversionchange = () => { connection.close(); connection = null; };
      resolve(connection);
    };
  });
}
export function closeDB() { connection?.close(); connection = null; }
const read = request => new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const completed = tx => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error ?? new Error('保存失败。')); tx.onabort = () => reject(tx.error ?? new Error('操作未保存，原数据保持不变。')); });
// ArrayBuffer storage avoids WebKit Blob persistence failures. Public APIs still return Blobs.
const hydratedPhoto = photo => photo ? { ...photo, blob: photo.blob || new Blob([photo.bytes], { type: photo.type }) } : null;
async function storedPhoto(photo) {
  const { blob, bytes: _oldBytes, ...metadata } = photo;
  return { ...metadata, type: blob.type, bytes: await blob.arrayBuffer() };
}
export async function snapshot({ includePhotos = false } = {}) {
  const db = await openDB();
  const tx = db.transaction(['medicines', 'photos', 'settings', 'meta'], 'readonly');
  const done = completed(tx);
  const records = read(tx.objectStore('medicines').getAll());
  const settings = read(tx.objectStore('settings').get('app'));
  const revision = read(tx.objectStore('meta').get('revision'));
  const photos = includePhotos ? read(tx.objectStore('photos').getAll()) : Promise.resolve([]);
  const values = await Promise.all([records, settings, revision, photos, done]);
  return { medicines: values[0], settings: { ...DEFAULT_SETTINGS, ...values[1] }, revision: values[2] ?? 0, photos: values[3].map(hydratedPhoto) };
}
export async function getPhoto(id) {
  if (!id) return null;
  const db = await openDB();
  return hydratedPhoto(await read(db.transaction('photos').objectStore('photos').get(id)));
}
function mutation(db, operation) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['medicines', 'photos', 'settings', 'meta'], 'readwrite');
    let failure, output;
    const fail = error => { failure = error; tx.abort(); };
    tx.oncomplete = () => resolve(output);
    tx.onerror = tx.onabort = () => reject(failure ?? tx.error ?? new Error('未能保存，请检查设备剩余空间。'));
    // All work inside the transaction is synchronous or triggered by IDB callbacks.
    try { operation(tx, fail, value => { output = value; }); } catch (error) { fail(error); }
  });
}
function bump(tx, dirty = true) {
  const meta = tx.objectStore('meta');
  const get = meta.get('revision');
  get.onsuccess = () => meta.put((get.result ?? 0) + 1, 'revision');
  if (dirty) {
    const store = tx.objectStore('settings');
    const current = store.get('app');
    current.onsuccess = () => {
      const settings = { ...DEFAULT_SETTINGS, ...current.result };
      settings.changesSinceBackup += 1;
      store.put(settings, 'app');
    };
  }
}
export async function saveMedicine(record, newPhotos = [], expectedUpdatedAt = null) {
  validateMedicine(record);
  const wanted = new Set(photoIDs(record));
  for (const photo of newPhotos) {
    if (!wanted.has(photo.id) || photo.medicineId !== record.id || !(photo.blob instanceof Blob) || !photo.blob.size) throw new Error('照片数据无效。');
  }
  const preparedPhotos = await Promise.all(newPhotos.map(storedPhoto));
  const db = await openDB();
  return mutation(db, (tx, fail) => {
    const records = tx.objectStore('medicines'), photos = tx.objectStore('photos');
    const current = records.get(record.id);
    current.onsuccess = () => {
      const old = current.result;
      if ((old?.updatedAt ?? null) !== expectedUpdatedAt) { fail(new Error('记录已在其他页面修改，请返回后重新打开，避免覆盖。')); return; }
      const supplied = new Map(newPhotos.map(photo => [photo.id, photo]));
      for (const id of wanted) {
        const existing = photos.get(id);
        existing.onsuccess = () => {
          if (existing.result && existing.result.medicineId !== record.id) { fail(new Error('照片归属不正确。')); return; }
          if (!existing.result && !supplied.has(id)) fail(new Error('照片缺失，未保存。请重新选择照片。'));
        };
      }
      for (const id of old ? photoIDs(old) : []) if (!wanted.has(id)) photos.delete(id);
      for (const photo of preparedPhotos) photos.put(photo);
      records.put(record);
      bump(tx);
    };
  });
}
export async function deleteMedicine(id, expectedUpdatedAt) {
  const db = await openDB();
  return mutation(db, (tx, fail) => {
    const records = tx.objectStore('medicines'), photos = tx.objectStore('photos');
    const request = records.get(id);
    request.onsuccess = () => {
      const record = request.result;
      if (!record) return;
      if (record.updatedAt !== expectedUpdatedAt) { fail(new Error('记录已改变，请重新打开后再删除。')); return; }
      for (const photoId of photoIDs(record)) photos.delete(photoId);
      records.delete(id);
      bump(tx);
    };
  });
}
export async function saveSettings(patch) {
  const db = await openDB();
  return mutation(db, tx => {
    const store = tx.objectStore('settings'), request = store.get('app');
    request.onsuccess = () => { store.put(validateSettings({ ...DEFAULT_SETTINGS, ...request.result, ...patch }), 'app'); bump(tx, false); };
  });
}
export async function markBackup(revision, date) {
  const db = await openDB();
  return mutation(db, tx => {
    const request = tx.objectStore('meta').get('revision');
    request.onsuccess = () => {
      if ((request.result ?? 0) !== revision) return; // Concurrent edits were not included in this backup.
      const store = tx.objectStore('settings'), get = store.get('app');
      get.onsuccess = () => store.put({ ...DEFAULT_SETTINGS, ...get.result, lastBackupAt: date, changesSinceBackup: 0 }, 'app');
    };
  });
}
export async function restoreSnapshot(backup, mode, expectedRevision) {
  if (!['merge', 'replace'].includes(mode)) throw new Error('恢复方式无效。');
  const preparedPhotos = new Map((await Promise.all(backup.photos.map(storedPhoto))).map(p => [p.id, p]));
  const db = await openDB();
  return mutation(db, (tx, fail, output) => {
    const revision = tx.objectStore('meta').get('revision');
    revision.onsuccess = () => {
      if ((revision.result ?? 0) !== expectedRevision) { fail(new Error('当前药箱已发生变化，请重新选择备份并确认。')); return; }
      const records = tx.objectStore('medicines'), photos = tx.objectStore('photos');
      const readAll = records.getAll();
      readAll.onsuccess = () => {
        const existing = new Set(readAll.result.map(m => m.id));
        if (mode === 'replace') { records.clear(); photos.clear(); }
        let added = 0;
        for (const original of backup.medicines) {
          if (mode === 'merge' && existing.has(original.id)) continue;
          const record = structuredClone(original);
          for (const oldID of photoIDs(original)) {
            const source = preparedPhotos.get(oldID);
            if (!source) { fail(new Error('备份缺少照片，未恢复。')); return; }
            const id = mode === 'merge' ? crypto.randomUUID() : oldID;
            if (record.boxPhotoId === oldID) record.boxPhotoId = id;
            record.instructionPhotoIds = record.instructionPhotoIds.map(value => value === oldID ? id : value);
            photos.put({ ...source, id, medicineId: record.id });
          }
          records.put(record);
          added++;
        }
        if (mode === 'replace' || existing.size === 0) tx.objectStore('settings').put(backup.settings, 'app');
        bump(tx);
        output({ added, skipped: backup.medicines.length - added });
      };
    };
  });
}

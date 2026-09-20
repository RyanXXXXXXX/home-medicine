import { validateMedicine, validateSettings, photoIDs } from './core.js';
const MAX_BYTES = 250 * 1024 * 1024;
async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function blobBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(binary);
}
function decodedBlob(photo) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(photo.type) || typeof photo.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(photo.base64)) throw new Error('备份中的照片格式无效。');
  const binary = atob(photo.base64);
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  const webp = String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (!bytes.length || !({ 'image/jpeg': jpeg, 'image/png': png, 'image/webp': webp }[photo.type])) throw new Error('照片内容损坏，未恢复。');
  return new Blob([bytes], { type: photo.type });
}
export async function createBackup(snapshot) {
  const payload = {
    exportedAt: new Date().toISOString(), medicines: snapshot.medicines, settings: snapshot.settings,
    photos: await Promise.all(snapshot.photos.map(async photo => ({ id: photo.id, medicineId: photo.medicineId,
      type: photo.blob.type, width: photo.width, height: photo.height, base64: await blobBase64(photo.blob) })))
  };
  const content = JSON.stringify(payload);
  const envelope = { format: 'home-medicine-backup', version: 1, sha256: await sha256(content), payload: content };
  const blob = new Blob([JSON.stringify(envelope)], { type: 'application/json' });
  if (blob.size > MAX_BYTES) throw new Error('备份超过当前版本的 250 MB 上限，请先减少过大的照片。');
  return { blob, exportedAt: payload.exportedAt };
}
export async function parseBackup(file) {
  if (file.size > MAX_BYTES) throw new Error('备份超过 250 MB，无法导入。');
  let envelope;
  try { envelope = JSON.parse(await file.text()); } catch { throw new Error('无法读取备份，请选择家里有药导出的备份文件。'); }
  if (envelope.format !== 'home-medicine-backup' || envelope.version !== 1 || typeof envelope.payload !== 'string') throw new Error('备份格式或版本不支持。');
  if (await sha256(envelope.payload) !== envelope.sha256) throw new Error('备份完整性校验失败，文件可能已损坏。');
  const payload = JSON.parse(envelope.payload);
  if (!Array.isArray(payload.medicines) || !Array.isArray(payload.photos) || typeof payload.exportedAt !== 'string' || !Number.isFinite(Date.parse(payload.exportedAt))) throw new Error('备份内容不完整。');
  const ids = new Set(), referenced = new Map();
  for (const medicine of payload.medicines) {
    validateMedicine(medicine);
    if (ids.has(medicine.id)) throw new Error('备份包含重复药品编号。');
    ids.add(medicine.id);
    for (const photoID of photoIDs(medicine)) {
      if (referenced.has(photoID)) throw new Error('备份包含重复照片引用。');
      referenced.set(photoID, medicine.id);
    }
  }
  const photos = [], found = new Set();
  for (const photo of payload.photos) {
    if (!photo || typeof photo.id !== 'string' || referenced.get(photo.id) !== photo.medicineId || found.has(photo.id)) throw new Error('照片与药品不对应，未恢复。');
    found.add(photo.id);
    photos.push({ id: photo.id, medicineId: photo.medicineId, blob: decodedBlob(photo), width: photo.width, height: photo.height });
  }
  if (found.size !== referenced.size) throw new Error('备份缺少照片，未恢复。');
  return { medicines: payload.medicines, photos, settings: validateSettings(payload.settings), exportedAt: payload.exportedAt };
}

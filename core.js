export const TEXT_FIELDS = ['name', 'specification', 'quantityUnit', 'location', 'purpose', 'ingredients', 'indications', 'dosage', 'contraindications', 'precautions', 'instructionText'];
export const DEFAULT_SETTINGS = Object.freeze({ reminders: true, reminderDays: [90, 30, 7, 0], lastBackupAt: null, changesSinceBackup: 0 });
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const [y, m, d] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && y <= 2200 && parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
}
export function expirationDate(value, monthOnly = false) {
  if (monthOnly) {
    if (!/^\d{4}-\d{2}$/.test(value ?? '') || +value.slice(5) < 1 || +value.slice(5) > 12) throw new Error('请选择有效期月份。');
    const [year, month] = value.split('-').map(Number);
    value = `${value}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`;
  }
  if (!validDate(value)) throw new Error('请填写有效的有效期。');
  return value;
}
export function dayDifference(date, now = new Date()) {
  // UTC arithmetic on local calendar components avoids DST and timezone date shifts.
  const today = localDate(now);
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}
export function expiry(date, now = new Date()) {
  const days = dayDifference(date, now);
  const status = days < 0 ? 'expired' : days <= 7 ? 'week' : days <= 30 ? 'month' : days <= 90 ? 'quarter' : 'normal';
  const label = { expired: '已过期', week: '7天内到期', month: '30天内到期', quarter: '90天内到期', normal: '有效期内' }[status];
  return { days, status, label, remaining: days < 0 ? `已过期 ${-days} 天` : days === 0 ? '今天到期' : `还有 ${days} 天到期` };
}
export function formatDate(date, monthOnly = false) {
  const [y, m, d] = date.split('-');
  return `${y}年${m}月${monthOnly ? '' : `${d}日`}`;
}
export function newMedicine(source = {}) {
  const record = { id: crypto.randomUUID(), quantity: 1, quantityUnit: '盒', expirationDate: '', expirationMonthOnly: false,
    boxPhotoId: null, instructionPhotoIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isArchived: false, archivedAt: null };
  for (const field of TEXT_FIELDS) if (!(field in record)) record[field] = '';
  return { ...record, ...source };
}
export function validateMedicine(record) {
  if (!record || typeof record !== 'object' || typeof record.id !== 'string' || !/^[\w-]{8,80}$/.test(record.id)) throw new Error('药品编号无效。');
  for (const field of TEXT_FIELDS) if (typeof record[field] !== 'string' || record[field].length > 100000) throw new Error(`药品字段无效：${field}`);
  if (!record.name.trim() || record.name.length > 160) throw new Error('请填写药名（最多160字）。');
  if (!Number.isInteger(record.quantity) || record.quantity < 0 || record.quantity > 99999) throw new Error('数量请填写 0 至 99999 的整数。');
  if (!validDate(record.expirationDate)) throw new Error('有效期无效。');
  if (typeof record.isArchived !== 'boolean' || typeof record.expirationMonthOnly !== 'boolean') throw new Error('药品状态无效。');
  for (const key of ['createdAt', 'updatedAt']) if (typeof record[key] !== 'string' || !Number.isFinite(Date.parse(record[key]))) throw new Error('药品记录时间无效。');
  if (record.archivedAt !== null && (typeof record.archivedAt !== 'string' || !Number.isFinite(Date.parse(record.archivedAt)))) throw new Error('归档时间无效。');
  if (!Array.isArray(record.instructionPhotoIds) || !record.instructionPhotoIds.every(id => typeof id === 'string') ||
      (record.boxPhotoId !== null && typeof record.boxPhotoId !== 'string')) throw new Error('照片引用无效。');
  const ids = photoIDs(record);
  if (new Set(ids).size !== ids.length) throw new Error('照片引用重复。');
  return record;
}
export function photoIDs(record) { return [record.boxPhotoId, ...record.instructionPhotoIds].filter(Boolean); }
export function validateSettings(input) {
  if (!input || typeof input.reminders !== 'boolean' || !Array.isArray(input.reminderDays) ||
      !input.reminderDays.every(d => [90, 30, 7, 0].includes(d)) ||
      !Number.isInteger(input.changesSinceBackup) || input.changesSinceBackup < 0 ||
      (input.lastBackupAt !== null && (typeof input.lastBackupAt !== 'string' || !Number.isFinite(Date.parse(input.lastBackupAt))))) throw new Error('备份设置无效。');
  return { reminders: input.reminders, reminderDays: [...new Set(input.reminderDays)], lastBackupAt: input.lastBackupAt, changesSinceBackup: input.changesSinceBackup };
}

// This table maps words, never symptoms to medicines or diagnoses.
export const SYNONYMS = [
  ['头疼', '头痛'], ['拉肚子', '腹泻'], ['鼻子堵', '鼻塞'], ['流鼻水', '流鼻涕'],
  ['嗓子疼', '喉咙痛', '咽痛'], ['发烧', '发热'], ['烧心', '胃灼热', '反酸'],
  ['胃疼', '胃痛', '上腹痛'], ['嘴角裂了', '嘴角裂', '口角', '皮肤裂口'],
  ['伤口消毒', '消毒', '皮肤创面'], ['咳嗽'], ['感冒'], ['打喷嚏'], ['恶心'], ['呕吐'], ['便秘'], ['牙疼', '牙痛']
];
const DANGER = ['胸痛', '胸口痛', '胸口疼', '胸疼', '呼吸困难', '喘不过气', '喘不上气', '意识异常', '意识不清', '昏迷', '晕倒', '严重过敏', '大量出血', '血流不止', '严重腹痛', '剧烈腹痛', '肚子疼得厉害', '喉头水肿'];
const normalize = text => text.normalize('NFKC').toLowerCase().replace(/\s/g, '');
function evidence(text, terms, prevention) {
  for (const sentence of text.split(/[。；;\n！？!?]/)) {
    const normalized = normalize(sentence);
    if (!normalized || /不|无|非|禁|忌|慎|勿|避免|尚未|未证实|咨询|就医/.test(normalized)) continue;
    if (prevention && !normalized.includes('预防')) continue;
    if (terms.some(term => term.length >= 2 && normalized.includes(term))) return sentence.trim();
  }
  return null;
}
function indicationSection(text) {
  const header = /【(?:适应症|功能主治)】|(?:适应症|功能主治)[：:]/.exec(text);
  if (!header) return '';
  return text.slice(header.index + header[0].length).split(/【|用法用量|禁忌|注意事项|不良反应|药理|贮藏|成分/)[0];
}
export function searchMedicines(query, medicines, now = new Date()) {
  const q = normalize(query.trim());
  if (!q) return { matches: [], warning: null };
  if (DANGER.some(word => q.includes(word))) return { matches: [], warning: '这个描述不适合仅根据家庭药箱自行选择药物。如症状明显或持续，请及时寻求专业医疗帮助；情况紧急时请联系当地急救服务。' };
  const prevention = /预防|快感冒|要感冒|防止|避免/.test(q);
  const stripped = q.replace(/^(帮我找一下|帮我找|找一下|我想找|找)/, '').replace(/[，。！？!?]/g, '');
  const groups = SYNONYMS.filter(group => group.some(term => q.includes(term)));
  const direct = groups.flat().filter(term => q.includes(term));
  const mapped = groups.flat().filter(term => !direct.includes(term));
  const matches = [];
  for (const medicine of medicines.filter(m => !m.isArchived)) {
    let score = 0, reason = '';
    const name = normalize(medicine.name);
    if (!prevention && stripped.length >= 2 && (name.includes(stripped) || (name.length >= 2 && q.includes(name)))) {
      score = 500; reason = `药品名称包含「${medicine.name}」。`;
    } else {
      const sources = [[medicine.indications, '已录入说明书适应症', 400], [medicine.purpose, '已录入用途 / 备注', 300]];
      for (const [text, label, priority] of sources) {
        const excerpt = evidence(text, [stripped, ...direct], prevention);
        if (excerpt) { score = priority; reason = `${label}：${excerpt}`; break; }
      }
      if (!score) for (const [text, label] of sources) {
        const excerpt = evidence(text, mapped, prevention);
        if (excerpt) { score = 200; reason = `同义词匹配 · ${label}：${excerpt}`; break; }
      }
      if (!score) {
        const excerpt = evidence(indicationSection(medicine.instructionText), [stripped, ...direct, ...mapped], prevention);
        if (excerpt) { score = 100; reason = `说明书全文的适应症 / 功能主治段落：${excerpt}`; }
      }
    }
    if (score) matches.push({ medicine, score, reason, expired: expiry(medicine.expirationDate, now).days < 0 });
  }
  matches.sort((a, b) => Number(a.expired) - Number(b.expired) || b.score - a.score || a.medicine.expirationDate.localeCompare(b.medicine.expirationDate) || a.medicine.id.localeCompare(b.medicine.id));
  return { matches, warning: null };
}

export function reminderSummary(medicines, settings, now = new Date()) {
  if (!settings.reminders) return [];
  const active = medicines.filter(m => !m.isArchived);
  const expired = active.filter(m => expiry(m.expirationDate, now).days < 0).length;
  const selected = [...settings.reminderDays].sort((a, b) => a - b);
  const summaries = expired ? [`${expired} 种药已过期，请及时整理`] : [];
  for (const max of selected) {
    const count = active.filter(m => { const d = expiry(m.expirationDate, now).days; return d >= 0 && d <= max; }).length;
    if (count) { summaries.push(max === 0 ? `${count} 种药今天到期` : `${count} 种药将在 ${max} 天内到期`); break; }
  }
  return summaries;
}

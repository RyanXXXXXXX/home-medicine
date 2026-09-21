import { validDate } from './core.js';

export const BOX_FIELDS = [['药品名称', 'name'], ['通用名', 'genericName'], ['规格', 'specification'], ['包装数量', 'packaging'], ['生产厂家', 'manufacturer'], ['批准文号', 'approvalNumber'], ['生产日期', 'productionDate'], ['有效期 / 失效日期', 'expirationInput']];
export const LEAFLET_FIELDS = [['主要成分', 'ingredients'], ['适应症 / 用途', 'indications'], ['用法用量', 'dosage'], ['禁忌', 'contraindications'], ['注意事项', 'precautions']];
const clean = text => String(text || '').normalize('NFKC').replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1').replace(/[ \t]+/g, ' ').trim();
// Confidence is a filter, never a claim of accuracy. A low-confidence word invalidates
// the entire candidate, including negations and units; nothing is silently dropped.
export function reliable(line, threshold = 80) {
  return Number.isFinite(line.confidence) && line.confidence >= threshold &&
    (!line.words?.length || line.words.every(w => !/[\p{L}\p{N}]/u.test(w.text) || (Number.isFinite(w.confidence) && w.confidence >= 65)));
}
export function ocrLines(data) {
  return (data.blocks || []).flatMap(b => (b.paragraphs || []).flatMap(p => (p.lines || []).map(l => ({
    text: clean(l.text), confidence: l.confidence, words: l.words,
    bbox: l.bbox, height: l.bbox ? l.bbox.y1 - l.bbox.y0 : 0
  }))));
}

export function readPrintedDate(text) {
  const value = clean(text);
  const monthYear = /^(\d{1,2})\s*[./-]\s*((?:19|20|21)\d{2})$/.exec(value);
  if (monthYear) { const date = `${monthYear[2]}-${monthYear[1].padStart(2,'0')}`; return validDate(`${date}-01`) ? date : ''; }
  // No duration arithmetic, two-digit-year guesses, batch numbers, or ambiguous DD/MM dates.
  const found = [...value.matchAll(/(?<!\d)((?:19|20|21)\d{2})(?:\s*[年./-]\s*(\d{1,2})(?:\s*[月./-]\s*(\d{1,2})\s*日?)?\s*月?|(\d{2})(\d{2})?)(?!\d)/g)];
  if (found.length !== 1) return '';
  const m = found[0], year = m[1], month = (m[2] || m[4]).padStart(2, '0'), day = m[3] || m[5];
  if (!day) return validDate(`${year}-${month}-01`) ? `${year}-${month}` : '';
  const result = `${year}-${month}-${day.padStart(2, '0')}`;
  return validDate(result) ? result : '';
}
// Review choices only: these never become confidence-qualified auto-fill fields.
export function reviewCandidates(text) {
  const names = new Set(), specs = new Set();
  for (const raw of String(text || '').split('\n')) {
    const line = clean(raw);
    if (/^[\u3400-\u9fff]{2,28}(?:片|胶囊|颗粒|口服液|注射液|乳膏|软膏|丸|散|合剂|糖浆)$/.test(line)) names.add(line);
    for (const match of line.matchAll(/(?<![\w.])(\d+(?:\.\d+)?\s*(?:mg|ml|g|毫克|毫升|克))(?![a-z])/gi)) specs.add(match[1]);
  }
  return { name: [...names].slice(0,3), specification: [...specs].slice(0,3) };
}
const labels = [
  ['genericName', /^(?:通用名称|通用名)\s*[：:]?\s*(.*)$/],
  ['name', /^(?:药品名称|药品名|商品名称|商品名|中文名称)\s*[：:]?\s*(.*)$/],
  ['specification', /^规格\s*[：:]?\s*(.*)$/],
  ['packaging', /^包装(?:数量)?\s*[：:]?\s*(.*)$/],
  ['manufacturer', /^(?:生产企业|生产厂家|制造商|企业名称|生产单位)\s*[：:]?\s*(.*)$/],
  ['approvalNumber', /^批准文号\s*[：:]?\s*(.*)$/],
  ['productionDate', /^(?:生产日期|制造日期|MFG(?:\s*DATE)?|MFD)\s*[：:.]?\s*(.*)$/i],
  ['expirationInput', /^(?:有效期至|有效期到|失效日期|失效期|有效期|EXP(?:IRY)?(?:\s*DATE)?)\s*[：:.]?\s*(.*)$/i]
];
const debracket = text => text.replace(/[【\[（(]([^】\]）)]+)[】\]）)]\s*[：:]?/g, '$1:');
export function parseBox(lines) {
  lines = lines.map(l => ({ ...l, text: debracket(clean(l.text)) })).filter(l => l.text);
  const candidates = new Map();
  const offer = (key, value) => { if (value) { const values = candidates.get(key) || new Set(); values.add(value); candidates.set(key, values); } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [key, regex] of labels) {
      const match = regex.exec(line.text);
      if (!match || !reliable(line)) continue;
      let value = match[1].trim();
      if (!value && lines[i + 1] && reliable(lines[i + 1]) && !labels.some(([, r]) => r.test(lines[i + 1].text))) value = lines[i + 1].text;
      if (key.endsWith('Date') || key === 'expirationInput') value = readPrintedDate(value);
      else if (key === 'approvalNumber') value = /^(国药准字[HJZSBF]\d{8})$/i.exec(value.replace(/\s/g, ''))?.[1] || '';
      else if (['name', 'genericName'].includes(key) && (!/[\u3400-\u9fff]/.test(value) || value.length > 60 || /[:：]/.test(value))) value = '';
      offer(key, value);
    }
    if (reliable(line, 88)) {
      if (/^\d+(?:\.\d+)?\s*(?:mg|g|ml|毫克|克|毫升)$/i.test(line.text)) offer('specification', line.text);
      offer('approvalNumber', /^(国药准字[HJZSBF]\d{8})$/i.exec(line.text.replace(/\s/g, ''))?.[1]);
      if (!candidates.has('specification') && /^\d+(?:\.\d+)?\s*(?:mg|g|ml|毫克|克|毫升)\s*[×xX*]\s*\d+\s*(?:片|粒|袋|支|瓶)(?:\s*[×xX*]\s*\d+\s*(?:板|瓶|盒|袋))?$/i.test(line.text)) offer('specification', line.text);
    }
  }
  const fields = Object.fromEntries(BOX_FIELDS.map(([, key]) => [key, candidates.get(key)?.size === 1 ? [...candidates.get(key)][0] : '']));
  if (!candidates.has('name') && fields.genericName) fields.name = fields.genericName;
  if (!candidates.has('name') && !fields.name) {
    const names = lines.filter(l => reliable(l, 90) && /^[\u3400-\u9fff]{2,28}(?:片|胶囊|颗粒|口服液|滴眼液|软膏|乳膏|丸|散|合剂|糖浆|注射液)$/.test(l.text));
    const unique = [...new Set(names.map(l => l.text))];
    if (unique.length === 1) fields.name = unique[0];
  }
  return fields;
}
const headings = { 成分: 'ingredients', 主要成分: 'ingredients', 适应症: 'indications', 功能主治: 'indications', 用法用量: 'dosage', 禁忌: 'contraindications', 注意事项: 'precautions' };
const knownHeading = /^(成分|主要成分|适应症|功能主治|用法用量|禁忌|注意事项|不良反应|药物相互作用|贮藏|储藏|规格|包装|有效期|批准文号|生产企业|药品名称|药理毒理|药代动力学|儿童用药|老年用药|孕妇及哺乳期妇女用药)\s*[:：]\s*(.*)$/;
export function parseLeaflet(pages) {
  const sections = new Map(); let key = null;
  for (const page of pages) {
    if (page.error) { if (key) sections.get(key).bad = true; key = null; continue; }
    for (const original of page.lines || []) {
      const text = clean(original.text), line = debracket(text);
      const heading = knownHeading.exec(line);
      if (heading || /^[【\[][^】\]]+[】\]]/.test(text)) {
        key = heading && reliable(original) ? headings[heading[1]] : null;
        if (key) {
          const section = sections.get(key) || { text: [], bad: false };
          // Duplicate sections (e.g. front/back from different medicines) require manual review.
          if (section.text.length) section.bad = true;
          sections.set(key, section);
          if (heading[2]) section.text.push(heading[2]);
        }
      } else if (key && text && !/^第?\s*\d+\s*页|^\d+$/.test(text)) {
        const section = sections.get(key); section.text.push(text);
        if (!reliable(original)) section.bad = true;
      }
    }
  }
  return Object.fromEntries(LEAFLET_FIELDS.map(([, name]) => { const s = sections.get(name); return [name, s && !s.bad ? s.text.join('\n') : '']; }));
}

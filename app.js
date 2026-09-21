import { TEXT_FIELDS, newMedicine, expiry, formatDate, expirationDate, searchMedicines, reminderSummary, photoIDs, localDate } from './core.js';
import { snapshot, getPhoto, saveMedicine, deleteMedicine, saveSettings, markBackup, restoreSnapshot } from './db.js';
import { compressPhoto } from './photos.js';
import { createBackup, parseBackup } from './backup.js';
import { scanPicker, scanAndReview } from './ocr-ui.js';

const app = document.querySelector('#app');
const state = { medicines: [], settings: {}, revision: 0, route: 'home', query: '', id: null, draft: null, pendingPhotos: new Map(), objectURLs: [], busy: false, offlineReady: false, backup: null };
const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  back: '<path d="m14 5-7 7 7 7"/>', chevron: '<path d="m9 5 7 7-7 7"/>', pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', warning: '<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3v.1"/>',
  archive: '<path d="M4 8h16v13H4zM3 3h18v5H3zM9 12h6"/>', download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>', shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  bell: '<path d="M6 10a6 6 0 0 1 12 0v5l2 3H4l2-3ZM10 21h4"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  check: '<path d="m5 12 4 4L19 6"/>', photo: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m3 17 6-6 4 4 3-3 5 5"/><circle cx="15" cy="8" r="1.5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>', home: '<path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8"/>'
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.info}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const active = () => state.medicines.filter(m => !m.isArchived).sort((a, b) => a.expirationDate.localeCompare(b.expirationDate) || a.name.localeCompare(b.name));
function toast(text) {
  const node = document.querySelector('#toast'); node.textContent = text; node.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.hidden = true; }, 4500);
}
function revokeURLs() { state.objectURLs.forEach(URL.revokeObjectURL); state.objectURLs = []; }
function photoURL(blob) { const url = URL.createObjectURL(blob); state.objectURLs.push(url); return url; }
function nav(title, back = 'home', right = '') { return `<header class="nav"><button class="back" data-action="navigate" data-route="${back}" aria-label="返回">${icon('back')}返回</button><h1>${title}</h1>${right || '<span class="icon-button" aria-hidden="true"></span>'}</header>`; }
function statusHTML(record) { const status = expiry(record.expirationDate); return `<span class="status ${status.status}">${icon(status.days < 0 ? 'warning' : 'clock')}${esc(status.remaining)}</span>`; }
function medicineCard(record, reason = '') {
  return `<button class="medicine-card ${expiry(record.expirationDate).days < 0 ? 'expired-card' : ''}" data-action="detail" data-id="${esc(record.id)}">
  <div class="card-head"><div><h3>${esc(record.name)}</h3>${record.specification ? `<p class="spec">${esc(record.specification)}</p>` : ''}</div><span class="quantity-tag">${record.quantity}${esc(record.quantityUnit)}</span></div>
  <p class="expiration">有效期：${formatDate(record.expirationDate, record.expirationMonthOnly)}</p>
  <div class="card-bottom">${statusHTML(record)}<span class="location">${icon('pin')}${esc(record.location || '未填写位置')}</span></div>
  ${reason ? `<p class="match-reason"><strong>为什么匹配</strong><br>${esc(reason)}</p>` : ''}</button>`;
}
function needsBackup() { return state.medicines.length && (!state.settings.lastBackupAt || state.settings.changesSinceBackup >= 5 || Date.now() - Date.parse(state.settings.lastBackupAt) > 30 * 86400000); }
function home() {
  return `<main class="shell"><header class="topline"><div><p class="eyebrow">每一盒，都有着落</p><h1>家里有药</h1></div><button class="icon-button" data-action="navigate" data-route="settings" aria-label="更多">${icon('more')}</button></header>
  <label class="search">${icon('search')}<input id="search" type="search" aria-label="搜索药品或症状" placeholder="哪里不舒服？或者找什么药？" value="${esc(state.query)}" autocomplete="off"><button data-action="clear-search" aria-label="清空搜索" ${state.query ? '' : 'hidden'}>${icon('close')}</button></label>
  <div id="home-results">${homeResults()}</div>
  <button class="floating-add" data-action="add">${icon('plus')}添加药品</button></main>`;
}
function homeResults() {
  const medicines = active();
  if (state.query.trim()) {
    const result = searchMedicines(state.query, state.medicines);
    if (result.warning) return `<div class="notice error">${icon('warning')}<p>${esc(result.warning)}</p></div>`;
    if (!result.matches.length) return `<div class="empty">${icon('search')}<h2>暂时没有找到</h2><p>家中暂未找到说明书用途明确匹配的药品。可以换个药名，或补充药品的适应症。</p></div>`;
    const valid = result.matches.filter(m => !m.expired), expired = result.matches.filter(m => m.expired);
    return `${valid.length ? `<div class="section-heading"><h2>家中可能相关</h2><span>${valid.length}种</span></div>${valid.map(m => medicineCard(m.medicine, m.reason)).join('')}` : ''}
    ${expired.length ? `<div class="section-heading"><h2 class="danger">已过期 · 不建议使用</h2></div><p class="notice error">家中存在相关药品，但已经过期，不建议使用。</p>${expired.map(m => medicineCard(m.medicine, m.reason)).join('')}` : ''}
    <p class="footer-note">只查找你录入的药品，不作诊断或用药建议。</p>`;
  }
  const reminders = reminderSummary(state.medicines, state.settings);
  return `${reminders.length ? `<div class="notice warning">${icon('clock')}<div>${reminders.map(text => `<p>${esc(text)}</p>`).join('')}</div></div>` : ''}
  <div class="section-heading"><h2>我的药箱</h2><span>${medicines.length}种药品</span></div>
  ${medicines.length ? medicines.map(m => medicineCard(m)).join('') : `<div class="empty"><img src="./icons/icon.svg" alt="家庭药箱"><h2>家里的药，心里有数</h2><p>记下药名和有效期。下次需要时，知道有什么、放在哪。</p><button class="primary" data-action="add">添加第一盒药</button></div>`}
  ${needsBackup() ? '<p class="footer-note">药箱数据仅保存在本机，建议定期备份。<br><button class="text-button" data-action="navigate" data-route="settings">去备份药箱</button></p>' : ''}`;
}
async function refresh() { const data = await snapshot(); Object.assign(state, data); }
let renderVersion = 0;
function render() {
  revokeURLs(); renderVersion++;
  const views = { home, settings, history: historyView, detail, editor, restore: restoreView, privacy };
  app.innerHTML = (views[state.route] || home)();
  hydratePhotos(renderVersion);
  if (state.route === 'settings') updateStorage();
}
async function navigate(route, id = null, push = true) {
  if (state.busy) return;
  if (state.route === 'editor' && state.draft && route !== 'editor') {
    if (!await confirmAction('放弃此次修改？', '未保存的内容和新选择的照片会被丢弃。', '放弃修改', true)) return;
    state.draft = null; state.pendingPhotos.clear();
  }
  state.route = route; state.id = id;
  if (push) history.pushState({ route, id }, '', `#${route}${id ? `/${id}` : ''}`);
  render(); window.scrollTo(0, 0);
}
function field(label, name, value = '', { type = 'text', required = false, multiline = false, hint = '' } = {}) {
  return `<label class="field"><span>${label}${required ? ' <span class="muted">*</span>' : ''}</span>${multiline ? `<textarea name="${name}" rows="3" maxlength="100000">${esc(value)}</textarea>` : `<input name="${name}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''} ${name === 'name' ? 'maxlength="160"' : ''} ${type === 'number' ? 'min="0" max="99999" step="1" inputmode="numeric"' : ''}>`}${hint ? `<span class="hint">${hint}</span>` : ''}</label>`;
}
function editor() {
  const draft = state.draft;
  if (!draft) return home();
  const title = state.restock ? '重新加入药箱' : state.expectedUpdatedAt ? '编辑药品' : '添加药品';
  return `<main class="shell">${nav(title, state.editorBack.route, '<button class="text-button" type="submit" form="medicine-form">保存</button>')}
  <form id="medicine-form" novalidate>
  <div id="form-error" class="error-banner" role="alert" hidden></div>
  <section class="group"><button class="secondary full" type="button" data-action="scan-open" data-kind="box">${icon('photo')} 扫描药盒</button><p class="small muted">本机中文识别，拍照或选图后逐项确认；不上传照片。</p>
  ${['box', 'instruction'].map(kind => `<input class="visually-hidden" type="file" id="ocr-file-${kind}" data-ocr-kind="${kind}" accept="image/*" ${kind === 'instruction' ? 'multiple' : ''} tabindex="-1" aria-label="扫描${kind === 'box' ? '药盒' : '说明书'}相册"><input class="visually-hidden" type="file" id="ocr-camera-${kind}" data-ocr-kind="${kind}" accept="image/*" capture="environment" tabindex="-1" aria-label="扫描${kind === 'box' ? '药盒' : '说明书'}拍照">`).join('')}</section>
  ${state.restock ? `<p class="notice">已沿用「${esc(draft.name)}」的说明书和照片。填写新数量、有效期即可；原历史记录会保留。</p>` : ''}
  <section class="group">${field('药品名称', 'name', draft.name, { required: true })}
  <label class="switch-row"><span>药盒仅标注月份</span><input type="checkbox" name="expirationMonthOnly" ${draft.expirationMonthOnly ? 'checked' : ''}></label>
  ${field('有效期', 'expirationInput', state.expirationInput, { type: draft.expirationMonthOnly ? 'month' : 'date', required: true, hint: draft.expirationMonthOnly ? '按该月最后一天计算到期时间。' : '按照药盒印刷的有效期填写。' })}</section>
  <section class="group">${field('规格', 'specification', draft.specification, { hint: '例如 0.2g × 12片' })}
  <div class="field-row">${field('数量', 'quantity', draft.quantity, { type: 'number' })}${field('单位', 'quantityUnit', draft.quantityUnit)}</div>
  ${field('存放位置', 'location', draft.location)}<div class="chips">${['客厅药箱', '卧室', '冰箱', '旅行药包'].map(value => `<button type="button" class="chip" data-action="location" data-location="${value}">${value}</button>`).join('')}</div>
  <hr class="divider">${field('用途 / 备注', 'purpose', draft.purpose, { multiline: true, hint: '“还有半管”等描述也可以记在这里。' })}</section>
  <section class="group">${field('适应症 / 用途', 'indications', draft.indications, { multiline: true, hint: '请按说明书填写。症状搜索以这些文字为依据，不确定时留空。' })}</section>
  ${editorPhotos('box', '药盒照片', draft.boxPhotoId ? [draft.boxPhotoId] : [])}
  ${editorPhotos('instruction', '说明书照片', draft.instructionPhotoIds)}
  <section class="group"><details><summary>更多药盒信息</summary>${[['通用名','genericName'],['包装数量','packaging'],['生产厂家','manufacturer'],['批准文号','approvalNumber'],['生产日期','productionDate']].map(([label,name]) => field(label,name,draft[name])).join('')}</details></section>
  <section class="group"><details><summary>更多说明书信息</summary>${[['主要成分', 'ingredients'], ['用法用量', 'dosage'], ['禁忌', 'contraindications'], ['注意事项', 'precautions'], ['说明书文字（可粘贴）', 'instructionText']].map(([label, name]) => field(label, name, draft[name], { multiline: true })).join('')}<p class="small muted">识别文字必须对照说明书确认，可随时手动修改。</p></details></section>
  <button class="primary full" type="submit">保存药品</button></form></main>`;
}
function editorPhotos(kind, title, ids) {
  return `<section class="group"><h2>${title}${kind === 'instruction' ? ' <span class="muted small">可多张</span>' : ''}</h2>
  <div class="photo-buttons"><button type="button" data-action="choose-photo" data-kind="${kind}">${icon('photo')} 选择照片</button><button type="button" data-action="take-photo" data-kind="${kind}">${icon('plus')} 拍摄照片</button></div>
  ${kind === 'instruction' ? `<div class="photo-buttons"><button type="button" data-action="scan-open" data-kind="instruction">扫描说明书（可多页）</button>${ids.length ? '<button type="button" data-action="scan-existing">识别已有说明书照片</button>' : ''}</div>` : ''}
  <input class="visually-hidden" type="file" id="file-${kind}" data-photo-kind="${kind}" accept="image/*" ${kind === 'instruction' ? 'multiple' : ''} tabindex="-1" aria-label="选择${title}">
  <input class="visually-hidden" type="file" id="camera-${kind}" data-photo-kind="${kind}" accept="image/*" capture="environment" tabindex="-1" aria-label="拍摄${title}">
  <div class="photo-grid">${ids.map((id, index) => `<div class="photo-item"><button type="button" data-action="view-photo" data-photo-id="${esc(id)}"><img data-photo="${esc(id)}" alt="${title} ${index + 1}"></button><button type="button" class="remove-photo" data-action="remove-photo" data-photo-id="${esc(id)}">移除</button></div>`).join('')}</div>
  <p class="small muted">${kind === 'instruction' ? '保存清晰照片，支持放大查看。压缩后请检查小字是否清楚。' : '照片会适度压缩，只保存在本机。'}</p></section>`;
}
function detail() {
  const record = state.medicines.find(m => m.id === state.id);
  if (!record) return `<main class="shell">${nav('药品详情')}<div class="empty"><h2>这盒药已不在药箱中</h2></div></main>`;
  return `<main class="shell">${nav('药品详情', record.isArchived ? 'history' : 'home', '<button class="text-button" data-action="edit">编辑</button>')}
  <section class="group"><h2 class="detail-title">${esc(record.name)}</h2><p class="muted">${esc(record.specification)}</p>
  ${record.isArchived ? '<p class="notice">已用完 · 历史药品</p>' : ''}
  ${record.boxPhotoId ? `<button class="full" data-action="view-photo" data-photo-id="${esc(record.boxPhotoId)}"><img class="hero-photo" data-photo="${esc(record.boxPhotoId)}" alt="药盒照片"></button>` : ''}
  <div class="detail-meta"><div class="line"><span class="muted">有效期</span><span>${formatDate(record.expirationDate, record.expirationMonthOnly)}</span></div>${statusHTML(record)}
  ${record.expirationMonthOnly ? '<p class="small muted">按标注月份的最后一天计算。</p>' : ''}
  <p class="location">${icon('pin')}${esc(record.location || '未填写位置')}</p></div>
  <hr class="divider"><div class="quantity-line"><span>剩余数量</span><div class="counter">${!record.isArchived ? '<button data-action="quantity-minus" aria-label="减少数量">−</button>' : ''}<strong>${record.quantity}${esc(record.quantityUnit)}</strong>${!record.isArchived ? '<button data-action="quantity-plus" aria-label="增加数量">＋</button>' : ''}</div></div></section>
  ${[['通用名','genericName'],['包装数量','packaging'],['生产厂家','manufacturer'],['批准文号','approvalNumber'],['生产日期','productionDate'],['用途 / 备注', 'purpose'], ['主要成分', 'ingredients'], ['适应症 / 用途', 'indications'], ['用法用量', 'dosage'], ['禁忌', 'contraindications'], ['注意事项', 'precautions']].filter(([, name]) => record[name]?.trim()).map(([label, name]) => `<section class="group"><h2>${label}</h2><p class="prose">${esc(record[name])}</p></section>`).join('')}
  ${record.instructionPhotoIds.length ? `<section class="group"><h2>说明书原图 <span class="small muted">${record.instructionPhotoIds.length}张</span></h2><div class="photo-grid">${record.instructionPhotoIds.map((id, i) => `<div class="photo-item"><button data-action="view-photo" data-photo-id="${esc(id)}"><img data-photo="${esc(id)}" alt="说明书第${i + 1}张"></button></div>`).join('')}</div><p class="small muted">点击查看；双指缩放或点按放大。</p></section>` : ''}
  ${record.instructionText ? `<section class="group"><h2>说明书文字</h2><p class="prose">${esc(record.instructionText)}</p></section>` : ''}
  ${!record.indications && !record.purpose ? '<p class="notice">补充说明书适应症 / 用途后，就能通过症状查找这盒药。</p>' : ''}
  <section class="group"><button class="secondary full" data-action="${record.isArchived ? 'restock' : 'archive'}">${record.isArchived ? '重新加入药箱' : '用完了'}</button><button class="text-button danger full" data-action="delete">删除药品</button></section></main>`;
}
function historyView() {
  const records = state.medicines.filter(m => m.isArchived).sort((a, b) => (b.archivedAt || '').localeCompare(a.archivedAt || ''));
  return `<main class="shell">${nav('历史药品', 'settings')}<p class="muted small">说明书和照片都留着，下次补货更省事。</p><div class="section-heading"><h2>以前家里有过</h2><span>${records.length}种</span></div>${records.length ? records.map(m => medicineCard(m)).join('') : '<div class="empty"><h2>还没有历史药品</h2><p>点击详情页中的“用完了”，就会保存在这里。</p></div>'}</main>`;
}
function menuRow(action, title, subtitle, glyph, route = '') { return `<button class="menu-row" data-action="${action}" ${route ? `data-route="${route}"` : ''}>${icon(glyph)}<span class="row-copy"><strong>${title}</strong>${subtitle ? `<small>${subtitle}</small>` : ''}</span>${icon('chevron')}</button>`; }
function settings() {
  return `<main class="shell">${nav('更多')}<section class="group"><h2>我的药箱</h2>${menuRow('navigate', '历史药品', `${state.medicines.filter(m => m.isArchived).length}种已用完的药`, 'archive', 'history')}</section>
  <section class="group"><h2>到期提醒</h2><label class="switch-row"><span>App 内到期提醒</span><input type="checkbox" id="reminders-enabled" ${state.settings.reminders ? 'checked' : ''}></label>
  ${state.settings.reminders ? [90, 30, 7, 0].map(day => `<label class="switch-row"><span>${day ? `到期前 ${day} 天` : '到期当天'}</span><input type="checkbox" data-reminder-day="${day}" ${state.settings.reminderDays.includes(day) ? 'checked' : ''}></label>`).join('') : ''}
  <p class="small muted">在打开药箱时查看提醒。当前版本不发送后台或系统通知。</p></section>
  <section class="group"><h2>备份与恢复</h2>${menuRow('export', '备份药箱', '包含全部药品、历史记录、文字、设置和照片', 'download')}${menuRow('choose-backup', '恢复药箱', '先检查备份，再确认恢复', 'upload')}
  <input class="visually-hidden" type="file" id="backup-file" accept=".json,application/json" aria-label="选择备份文件" tabindex="-1">
  ${state.exportFile ? `<div class="notice"><div><p>备份已准备好，请保存到文件。</p><button class="primary" data-action="save-backup">保存备份文件</button></div></div>` : ''}
  <p class="backup-info">药箱数据仅保存在本机，建议定期备份。${state.settings.lastBackupAt ? `<br>上次导出：${new Date(state.settings.lastBackupAt).toLocaleString('zh-CN')}<br>导出后请确认文件已保存。` : '<br>还没有导出过备份。'}<br>备份不加密，请保存到可信位置。清除网站数据、卸载或更换手机前，请先备份。</p></section>
  <section class="group">${menuRow('navigate', '数据与隐私', '本机保存，无账号，无数据上传', 'shield', 'privacy')}<div class="status-line">${icon(state.offlineReady ? 'check' : 'clock')}<span id="offline-status">${offlineLabel()}</span></div><p id="storage-status" class="small muted"></p></section>
  <section class="group"><h2>添加到 iPhone 主屏幕</h2><p class="small muted">在 Safari 打开此网址，点“分享” → “添加到主屏幕”。然后从主屏幕打开一次，看到“离线资源已就绪”后即可离线使用。</p><p class="small muted">建议先添加到主屏幕，再开始录入。浏览器与主屏幕 App、不同网址之间的数据可能不互通，可通过备份迁移。</p></section>
  <p class="footer-note">家里有药 · 1.1.1<br>只记家里的药，不作诊断。</p></main>`;
}
function privacy() { return `<main class="shell">${nav('数据与隐私', 'settings')}<section class="group"><h2>数据留在你的设备</h2><p class="prose">你的药品、说明书和照片默认保存在本设备，不会上传到服务器。

网页托管只提供程序资源。我们没有账号、服务器数据库、广告或行为追踪，也不连接在线 AI。

药品和照片使用浏览器本地数据库保存。系统可能清理网站数据，因此仍需要定期备份。更换设备或托管地址前，先在旧药箱导出，再到新药箱恢复。

备份文件包含全部药箱数据，不加密。只有你主动选择分享或保存到云盘时，文件才会交给所选目标。</p></section><section class="group"><h2>搜索的边界</h2><p class="prose">只依据你录入的药名、适应症、用途和说明书查找，不诊断疾病、不生成用药方案。请核对原始说明书、禁忌和注意事项；不确定时咨询医生或药师。

照片会在本机压缩后保存，详情页显示的是保存后的完整照片。说明书建议分多张近距离拍摄，以便看清小字。</p></section></main>`; }
function restoreView() {
  if (!state.backup) return settings();
  const backup = state.backup;
  return `<main class="shell">${nav('检查备份', 'settings')}<section class="group"><h2>准备恢复药箱</h2><p class="small muted">备份时间：${new Date(backup.exportedAt).toLocaleString('zh-CN')}</p>
  <div class="restore-summary"><div><span>当前药品（含历史）</span><strong>${state.medicines.length}</strong></div><div><span>备份药品（含历史）</span><strong>${backup.medicines.length}</strong></div></div>
  <p class="small muted">备份包含 ${backup.medicines.filter(m => m.isArchived).length} 条历史记录、${backup.photos.length} 张照片，以及说明书文字和设置。</p>
  <label class="choice"><input type="radio" name="restore-mode" value="merge" checked><span>合并到当前药箱<small>仅增加新记录，重复记录跳过，保留当前设置。当前为空时恢复备份设置。</small></span></label>
  <label class="choice"><input type="radio" name="restore-mode" value="replace"><span>完整替换当前药箱<small>用备份中的药品、照片和设置覆盖当前内容。会再次确认。</small></span></label>
  <button class="primary full" data-action="restore">确认恢复</button><p class="backup-info">恢复会作为一次完整操作保存，失败不会留下半份药箱。</p></section></main>`;
}
async function startEditor(record = null, restock = false) {
  state.editorBack = { route: state.route, id: state.id };
  state.pendingPhotos.clear();
  state.restock = restock;
  state.expectedUpdatedAt = record && !restock ? record.updatedAt : null;
  state.draft = record ? structuredClone(record) : newMedicine();
  if (restock) {
    state.draft.id = crypto.randomUUID(); state.draft.quantity = 1; state.draft.expirationDate = '';
    state.draft.isArchived = false; state.draft.archivedAt = null;
    state.draft.createdAt = state.draft.updatedAt = new Date().toISOString();
    for (const oldID of photoIDs(record)) {
      const photo = await getPhoto(oldID);
      if (!photo) throw new Error('原记录的照片缺失，请先检查原记录。');
      const copy = { ...photo, id: crypto.randomUUID(), medicineId: state.draft.id };
      state.pendingPhotos.set(copy.id, copy);
      if (state.draft.boxPhotoId === oldID) state.draft.boxPhotoId = copy.id;
      state.draft.instructionPhotoIds = state.draft.instructionPhotoIds.map(id => id === oldID ? copy.id : id);
    }
  }
  state.expirationInput = state.draft.expirationMonthOnly ? state.draft.expirationDate.slice(0, 7) : state.draft.expirationDate;
  await navigate('editor');
}
async function hydratePhotos(version) {
  await Promise.all([...app.querySelectorAll('[data-photo]')].map(async image => {
    try {
      const photo = state.pendingPhotos.get(image.dataset.photo) || await getPhoto(image.dataset.photo);
      if (version !== renderVersion) return;
      if (photo) image.src = photoURL(photo.blob);
      else image.alt = '照片暂时无法读取';
    } catch { image.alt = '照片暂时无法读取'; }
  }));
}
function setBusy(busy) { state.busy = busy; app.querySelectorAll('button,input,textarea,select').forEach(node => { node.disabled = busy; }); }
function showError(error) {
  const message = error.name === 'QuotaExceededError' ? '设备可用空间不足，本次未保存。请释放空间后重试；原数据保留。' : error.message || '操作未完成，请重试。';
  const banner = document.querySelector('#form-error');
  if (banner) { banner.textContent = message; banner.hidden = false; banner.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  else toast(message);
}
function confirmAction(title, description, action = '确认', destructive = false) {
  return new Promise(resolve => {
    const dialog = document.querySelector('#confirm-dialog');
    dialog.innerHTML = `<h2 id="confirm-title">${esc(title)}</h2><p>${esc(description)}</p><form method="dialog" class="actions"><button value="cancel" class="secondary" autofocus>取消</button><button value="confirm" class="${destructive ? 'destructive' : 'primary'}">${esc(action)}</button></form>`;
    dialog.returnValue = 'cancel';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('home-medicine-changes') : null;
function changed() { channel?.postMessage({ changed: true }); }
async function saveDraft() {
  if (state.busy || !state.draft) return;
  const draft = structuredClone(state.draft);
  draft.name = draft.name.trim(); draft.location = draft.location.trim();
  draft.expirationDate = expirationDate(state.expirationInput, draft.expirationMonthOnly);
  if (draft.quantity < 1 && !draft.isArchived) throw new Error('当前药箱的数量请至少填 1；用完后可在详情页归档。');
  draft.updatedAt = new Date().toISOString();
  setBusy(true);
  try {
    const wanted = new Set(photoIDs(draft));
    await saveMedicine(draft, [...state.pendingPhotos.values()].filter(p => wanted.has(p.id)), state.expectedUpdatedAt);
    state.draft = null; state.pendingPhotos.clear(); state.restock = false;
    await refresh(); changed(); setBusy(false);
    await navigate('detail', draft.id); toast('已保存到本机');
    navigator.storage?.persist?.().catch(() => {});
  } finally { setBusy(false); }
}
async function addPhotoFiles(files, kind) {
  if (!state.draft || !files.length || state.busy) return;
  setBusy(true); toast('正在处理照片…');
  let added = 0;
  try {
    for (const file of kind === 'box' ? [...files].slice(0, 1) : files) {
      const photo = { ...await compressPhoto(file, kind), medicineId: state.draft.id };
      if (kind === 'box') {
        state.pendingPhotos.delete(state.draft.boxPhotoId);
        state.draft.boxPhotoId = photo.id;
      } else state.draft.instructionPhotoIds.push(photo.id);
      state.pendingPhotos.set(photo.id, photo); added++;
    }
    render(); toast(`已处理 ${added} 张照片，保存药品后生效`);
  } catch (error) { render(); showError(new Error(`${error.message}${added ? ` 已处理的 ${added} 张照片仍保留。` : ''}`)); }
  finally { setBusy(false); }
}
async function scanFiles(files, kind, existing = false) {
  if (!state.draft || !files.length || state.busy) return;
  if (files.length > 8) throw new Error('每次最多识别 8 张照片，请分批选择。');
  setBusy(true);
  try {
    const result = await scanAndReview(files, kind, { ...state.draft, expirationInput: state.expirationInput }, { existing });
    if (!result) return;
    const { expirationInput, ...fields } = result.fields;
    // Prepare every photo first so cancellation/failure cannot partly overwrite the draft.
    const photos = [];
    if (result.keepPhotos) for (const file of files) photos.push({ ...await compressPhoto(file, kind), medicineId: state.draft.id });
    Object.assign(state.draft, fields);
    if (expirationInput) { state.expirationInput = expirationInput; state.draft.expirationMonthOnly = expirationInput.length === 7; }
    for (const photo of photos) {
      if (kind === 'box') { state.pendingPhotos.delete(state.draft.boxPhotoId); state.draft.boxPhotoId = photo.id; }
      else state.draft.instructionPhotoIds.push(photo.id);
      state.pendingPhotos.set(photo.id, photo);
    }
    render(); toast('已填入草稿，请核对后保存药品');
  } finally { setBusy(false); }
}
async function updateRecord(record, patch) {
  setBusy(true);
  try { await saveMedicine({ ...record, ...patch, updatedAt: new Date().toISOString() }, [], record.updatedAt); await refresh(); changed(); render(); }
  finally { setBusy(false); }
}
async function archiveRecord(record) {
  if (!await confirmAction('这盒药用完了吗？', '会移入历史药品，保留说明书和照片。', '用完了')) return;
  await updateRecord(record, { isArchived: true, quantity: 0, archivedAt: new Date().toISOString() });
  await navigate('home'); toast('已移入历史药品');
}
async function removeRecord(record) {
  if (!await confirmAction('确定删除这盒药吗？', '该药品、说明书和对应照片会从本机彻底删除。', '删除', true)) return;
  setBusy(true);
  try { await deleteMedicine(record.id, record.updatedAt); await refresh(); changed(); setBusy(false); await navigate(record.isArchived ? 'history' : 'home'); toast('药品和对应照片已删除'); }
  finally { setBusy(false); }
}
let galleryURLs = [];
async function openGallery(selectedID) {
  const record = state.draft || state.medicines.find(m => m.id === state.id);
  if (!record) return;
  const ids = selectedID === record.boxPhotoId ? [selectedID] : record.instructionPhotoIds;
  const photos = await Promise.all(ids.map(async id => state.pendingPhotos.get(id) || await getPhoto(id)));
  if (photos.some(p => !p)) throw new Error('照片缺失，无法打开。');
  galleryURLs = photos.map(p => URL.createObjectURL(p.blob));
  let index = Math.max(0, ids.indexOf(selectedID));
  const dialog = document.querySelector('#photo-dialog');
  const paint = () => {
    dialog.innerHTML = `<header class="photo-toolbar"><strong>${index + 1} / ${ids.length}</strong><button id="close-gallery" aria-label="关闭照片">完成</button></header><div class="photo-viewport"><img src="${galleryURLs[index]}" alt="说明书或药盒照片"></div><footer class="photo-controls"><button id="previous-photo" ${index === 0 ? 'disabled' : ''}>上一张</button><button id="zoom-photo">放大 / 还原</button><button id="next-photo" ${index === ids.length - 1 ? 'disabled' : ''}>下一张</button></footer>`;
    dialog.querySelector('#close-gallery').onclick = () => dialog.close();
    dialog.querySelector('#previous-photo').onclick = () => { index--; paint(); };
    dialog.querySelector('#next-photo').onclick = () => { index++; paint(); };
    const zoom = () => dialog.querySelector('.photo-viewport').classList.toggle('zoomed');
    dialog.querySelector('#zoom-photo').onclick = zoom;
    dialog.querySelector('img').ondblclick = zoom;
  };
  paint();
  dialog.addEventListener('close', () => { galleryURLs.forEach(URL.revokeObjectURL); galleryURLs = []; dialog.innerHTML = ''; }, { once: true });
  dialog.showModal();
}
async function exportBackup() {
  setBusy(true); toast('正在准备完整备份…');
  try {
    const data = await snapshot({ includePhotos: true });
    const backup = await createBackup(data);
    state.exportFile = { ...backup, revision: data.revision, name: `家里有药-${localDate()}.medicine-backup.json` };
    render();
  } finally { setBusy(false); }
}
async function saveBackupFile() {
  const backup = state.exportFile;
  if (!backup) return;
  const file = new File([backup.blob], backup.name, { type: 'application/json' });
  try {
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: '家里有药完整备份' });
    else {
      const url = URL.createObjectURL(file), link = document.createElement('a');
      link.href = url; link.download = backup.name; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    await markBackup(backup.revision, backup.exportedAt);
    state.exportFile = null; await refresh(); render(); toast('已导出，请确认备份文件已保存');
  } catch (error) { if (error.name !== 'AbortError') throw error; }
}
async function importBackup(file) {
  if (!file) return;
  setBusy(true); toast('正在检查备份完整性…');
  try {
    const backup = await parseBackup(file);
    // Decode each image before offering recovery, so corrupt image payloads cannot enter the store.
    for (const photo of backup.photos) {
      const url = URL.createObjectURL(photo.blob), image = new Image(); image.src = url;
      try { await image.decode(); } catch { throw new Error('备份中有损坏的照片，未恢复任何数据。'); }
      finally { URL.revokeObjectURL(url); }
    }
    await refresh(); state.restoreRevision = state.revision; state.backup = backup;
    setBusy(false); await navigate('restore');
  } finally { setBusy(false); }
}
async function confirmRestore() {
  const mode = document.querySelector('[name="restore-mode"]:checked').value;
  if (mode === 'replace' && !await confirmAction('确定覆盖当前药箱吗？', `当前 ${state.medicines.length} 条药品记录及照片将被备份中的 ${state.backup.medicines.length} 条替换。建议先导出当前药箱备份。`, '覆盖并恢复', true)) return;
  setBusy(true);
  try {
    const result = await restoreSnapshot(state.backup, mode, state.restoreRevision);
    state.backup = null; await refresh(); changed(); setBusy(false); await navigate('home');
    toast(`恢复完成：${result.added} 条记录${result.skipped ? `，跳过 ${result.skipped} 条重复记录` : ''}`);
  } finally { setBusy(false); }
}
function offlineLabel() { return state.offlineReady ? '离线资源已就绪' : '离线资源尚未就绪，请保持联网打开一次'; }
async function updateStorage() {
  try {
    const estimate = await navigator.storage?.estimate?.();
    const node = document.querySelector('#storage-status');
    if (node && estimate?.usage !== undefined) node.textContent = `此网站约占 ${(estimate.usage / 1024 / 1024).toFixed(1)} MB（含程序缓存与照片）`;
  } catch { /* Optional browser capability. */ }
}
app.addEventListener('input', event => {
  if (event.target.id === 'search') { state.query = event.target.value; document.querySelector('#home-results').innerHTML = homeResults(); document.querySelector('[data-action="clear-search"]').hidden = !state.query; }
  if (state.draft && event.target.name) {
    const target = event.target;
    if (target.name === 'expirationInput') state.expirationInput = target.value;
    else if (target.name === 'quantity') state.draft.quantity = target.value === '' ? NaN : Number(target.value);
    else if (TEXT_FIELDS.includes(target.name)) state.draft[target.name] = target.value;
  }
});
app.addEventListener('change', async event => {
  const target = event.target;
  try {
    if (target.dataset.ocrKind) { const files = [...target.files]; target.value = ''; await scanFiles(files, target.dataset.ocrKind); }
    else if (target.dataset.photoKind) await addPhotoFiles([...target.files], target.dataset.photoKind);
    else if (target.id === 'backup-file') await importBackup(target.files[0]);
    else if (target.name === 'expirationMonthOnly' && state.draft) {
      state.draft.expirationMonthOnly = target.checked;
      state.expirationInput = target.checked ? state.expirationInput.slice(0, 7) : state.expirationInput ? expirationDate(state.expirationInput, true) : '';
      render();
    } else if (target.id === 'reminders-enabled') {
      await saveSettings({ reminders: target.checked }); await refresh(); changed(); render();
    } else if (target.dataset.reminderDay !== undefined) {
      const days = new Set(state.settings.reminderDays), day = Number(target.dataset.reminderDay);
      target.checked ? days.add(day) : days.delete(day);
      await saveSettings({ reminderDays: [...days] }); await refresh(); changed();
    }
  } catch (error) { showError(error); }
});
app.addEventListener('submit', async event => {
  if (event.target.id !== 'medicine-form') return;
  event.preventDefault();
  try { await saveDraft(); } catch (error) { showError(error); }
});
app.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button || state.busy) return;
  const { action, route, id, kind, photoId } = button.dataset;
  const record = state.medicines.find(m => m.id === state.id);
  try {
    switch (action) {
      case 'scan-open': scanPicker(kind); break;
      case 'scan-existing': {
        const files = [];
        for (const photoID of state.draft.instructionPhotoIds) { const photo = state.pendingPhotos.get(photoID) || await getPhoto(photoID); if (photo) files.push(photo.blob); }
        await scanFiles(files, 'instruction', true); break;
      }
      case 'clear-search': state.query = ''; render(); document.querySelector('#search').focus(); break;
      case 'navigate': await navigate(route, route === state.editorBack?.route ? state.editorBack?.id : null); break;
      case 'detail': await navigate('detail', id); break;
      case 'add': await startEditor(); break;
      case 'edit': await startEditor(record); break;
      case 'restock': await startEditor(record, true); break;
      case 'location': state.draft.location = button.dataset.location; app.querySelector('[name="location"]').value = state.draft.location; break;
      case 'choose-photo': document.querySelector(`#file-${kind}`).click(); break;
      case 'take-photo': document.querySelector(`#camera-${kind}`).click(); break;
      case 'remove-photo':
        state.pendingPhotos.delete(photoId);
        if (state.draft.boxPhotoId === photoId) state.draft.boxPhotoId = null;
        state.draft.instructionPhotoIds = state.draft.instructionPhotoIds.filter(value => value !== photoId); render(); break;
      case 'view-photo': await openGallery(photoId); break;
      case 'quantity-plus': if (record.quantity < 99999) await updateRecord(record, { quantity: record.quantity + 1 }); break;
      case 'quantity-minus': if (record.quantity <= 1) await archiveRecord(record); else await updateRecord(record, { quantity: record.quantity - 1 }); break;
      case 'archive': await archiveRecord(record); break;
      case 'delete': await removeRecord(record); break;
      case 'export': await exportBackup(); break;
      case 'save-backup': await saveBackupFile(); break;
      case 'choose-backup': document.querySelector('#backup-file').click(); break;
      case 'restore': await confirmRestore(); break;
    }
  } catch (error) { showError(error); }
});
history.replaceState({ route: 'home', id: null }, '', '#home');
window.addEventListener('popstate', async event => {
  if (state.busy || document.querySelector('#ocr-dialog[open]')) { history.pushState({ route: state.route, id: state.id }, '', `#${state.route}`); return; }
  const target = event.state || { route: 'home', id: null };
  if (state.route === 'editor' && state.draft) {
    if (!await confirmAction('放弃此次修改？', '返回后，未保存的修改会被丢弃。', '放弃修改', true)) { history.pushState({ route: state.route, id: state.id }, '', '#editor'); return; }
    state.draft = null; state.pendingPhotos.clear();
  }
  state.route = target.route === 'editor' ? 'home' : target.route;
  state.id = target.id; render();
});
window.addEventListener('beforeunload', event => { if (state.draft || state.busy) { event.preventDefault(); event.returnValue = ''; } });
async function foregroundRefresh() {
  if (state.draft || state.busy || document.querySelector('dialog[open]')) return;
  try { await refresh(); render(); } catch (error) { showError(error); }
}
channel?.addEventListener('message', foregroundRefresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) foregroundRefresh(); });
setInterval(() => { if (!document.hidden && !state.draft && !state.busy && state.route === 'home') document.querySelector('#home-results').innerHTML = homeResults(); }, 60000);
async function prepareOffline() {
  if (!('serviceWorker' in navigator) || !isSecureContext) return;
  try {
    await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    state.offlineReady = true;
    const label = document.querySelector('#offline-status'); if (label) label.textContent = offlineLabel();
  } catch { state.offlineReady = false; }
}
try { await refresh(); render(); } catch (error) { app.innerHTML = `<main class="shell"><h1>暂时无法打开药箱</h1><p class="error-banner">${esc(error.message)}</p><p>本地数据未被清除。请关闭其他药箱页面后重试，并检查设备剩余空间。</p><button class="primary" id="retry">重试</button></main>`; document.querySelector('#retry').onclick = () => location.reload(); }
prepareOffline();

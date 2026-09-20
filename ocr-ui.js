import { BOX_FIELDS, LEAFLET_FIELDS, parseBox, parseLeaflet, readPrintedDate } from './ocr-parser.js';
import { recognizePhotos } from './ocr.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function dialog() {
  let node = document.querySelector('#ocr-dialog');
  if (!node) { node = document.createElement('dialog'); node.id = 'ocr-dialog'; node.className = 'ocr-dialog'; document.body.append(node); }
  return node;
}
export function scanPicker(kind) {
  const node = dialog();
  node.innerHTML = `<h2>扫描${kind === 'box' ? '药盒' : '说明书'}</h2><p>尽量拍正、避开反光，让文字充满画面。照片和识别结果仅在本机处理。</p><div class="actions"><button data-source="camera" class="primary">拍照识别</button><button data-source="file" class="secondary">从相册选择</button><button data-source="cancel">取消</button></div>`;
  node.onclick = event => {
    const source = event.target.closest('[data-source]')?.dataset.source;
    if (!source) return;
    node.close(); if (source !== 'cancel') document.querySelector(`#ocr-${source}-${kind}`).click();
  };
  node.showModal();
}
export async function scanAndReview(files, kind, current, { existing = false } = {}) {
  const node = dialog(), controller = new AbortController();
  node.onclick = null;
  node.innerHTML = '<h2>本地识别中</h2><p id="ocr-progress" role="status">正在准备照片…</p><p class="small muted">首次需联网缓存识别组件，之后可离线扫描。最多一次 8 张，复杂照片可能需要较长时间。</p><button id="ocr-cancel" class="secondary">取消识别</button>';
  const cancel = () => { controller.abort(); node.close(); };
  node.oncancel = event => { event.preventDefault(); cancel(); };
  node.querySelector('#ocr-cancel').onclick = cancel;
  node.showModal();
  let pages;
  try {
    pages = await recognizePhotos(files, { signal: controller.signal, progress: text => { const label = node.querySelector('#ocr-progress'); if (label) label.textContent = text; } });
  } catch (error) {
    if (controller.signal.aborted) return null;
    pages = [{ lines: [], text: '', error: error?.message || '识别失败，请重试或手动填写。' }];
  }
  if (controller.signal.aborted) return null;
  const fields = kind === 'box' ? parseBox(pages.flatMap(p => p.lines)) : parseLeaflet(pages);
  const definitions = kind === 'box' ? BOX_FIELDS : LEAFLET_FIELDS;
  const success = Object.values(fields).some(Boolean);
  if (success) { try { navigator.vibrate?.(35); } catch { /* Optional; iPhone Safari may not expose vibration. */ } }
  const errors = pages.map((p, i) => p.error ? `第 ${i + 1} 张：${p.error}` : '').filter(Boolean);
  if (pages.length < files.length) errors.push('剩余照片尚未识别，可分批重试。');
  const urls = files.map(file => URL.createObjectURL(file));
  node.innerHTML = `<h2>确认识别结果</h2><p role="status">${success ? '识别完成，请逐项对照原图。' : '未取得可靠结果，请重拍或手动填写。'}</p><p class="small muted">低置信度字段留空；不会推算有效期。只填入勾选字段，最后仍需点击“保存药品”。</p>
    ${errors.map(text => `<p class="notice error">${esc(text)}</p>`).join('')}
    <details><summary>查看本次原图（${files.length} 张）</summary>${urls.map((url,i) => `<img class="ocr-original" src="${url}" alt="扫描原图 ${i + 1}">`).join('')}</details>
    <form id="ocr-review-form" novalidate>${definitions.map(([label, name]) => {
      const previous = current[name] || '', value = fields[name] || '';
      return `<section class="ocr-field"><label class="switch-row"><span>${label}</span><input type="checkbox" name="apply-${name}" aria-label="填入${label}" ${!previous && value ? 'checked' : ''}></label>
      ${kind === 'instruction' ? `<textarea name="${name}" rows="3" aria-label="${label}" maxlength="100000">${esc(value)}</textarea>` : `<input name="${name}" aria-label="${label}" value="${esc(value)}" maxlength="${name === 'name' ? 160 : 1000}">`}
      ${previous ? `<p class="small muted">原填写：${esc(previous.slice(0, 150))}。勾选后替换。</p>` : ''}
      ${name === 'expirationInput' || name === 'productionDate' ? '<p class="small muted">YYYY-MM-DD 或 YYYY-MM；“有效期24个月”不能作为失效日期。</p>' : ''}</section>`;
    }).join('')}
    ${!existing ? '<label class="switch-row"><span>保留本次原图到药品照片</span><input type="checkbox" name="keepPhotos" checked></label>' : ''}
    <details><summary>查看 OCR 原始文字（可能有误）</summary><pre class="ocr-raw">${esc(pages.map((p,i)=>`第 ${i+1} 张\n${p.text}`).join('\n\n'))}</pre></details>
    <p id="ocr-error" role="alert" class="error-banner" hidden></p>
    <div class="actions"><button type="button" id="ocr-discard" class="secondary">取消，保留原填写</button><button class="primary" type="submit">确认并填入</button></div></form>`;
  return new Promise(resolve => {
    const done = result => { node.close(); urls.forEach(URL.revokeObjectURL); node.innerHTML = ''; node.oncancel = null; resolve(result); };
    node.oncancel = event => { event.preventDefault(); done(null); };
    node.querySelector('#ocr-discard').onclick = () => done(null);
    const form = node.querySelector('form');
    form.oninput = event => { const checkbox = form.elements[`apply-${event.target.name}`]; if (checkbox) checkbox.checked = true; };
    form.onsubmit = event => {
      event.preventDefault(); const values = new FormData(form), result = {};
      for (const [, name] of definitions) {
        const value = String(values.get(name) || '').trim();
        if (values.has(`apply-${name}`) && value) {
          if ((name === 'expirationInput' || name === 'productionDate') && readPrintedDate(value) !== value) {
            const error = node.querySelector('#ocr-error'); error.hidden = false; error.textContent = '请核对日期，填写 YYYY-MM-DD 或 YYYY-MM。'; return;
          }
          result[name] = value;
        }
      }
      done({ fields: result, keepPhotos: values.has('keepPhotos') });
    };
  });
}

import { compressPhoto } from './photos.js';
import { ocrLines, reliable } from './ocr-parser.js';

export function ocrFailure(error, stage = 'engine') {
  if (error?.code) return error;
  const detail = String(error?.message || error || '');
  const code = /chi_sim/.test(detail) ? 'model-zh' : /eng\.traineddata/.test(detail) ? 'model-en' : stage;
  const labels = { engine: 'OCR 引擎加载失败', core: 'OCR WASM 加载或初始化失败', 'model-zh': '中文模型加载失败', 'model-en': '英文模型加载失败', initialize: 'OCR 模型初始化失败', decode: '图片解码失败', recognize: 'OCR 执行失败', timeout: 'OCR 执行超时' };
  const result = new Error(`${labels[code] || labels.engine}（${code}）。${/timeout/i.test(detail) ? '等待超时；' : ''}可重试或手动填写。`);
  result.code = code; return result;
}

// Use the pinned worker's message protocol directly. The upstream createWorker
// promise can swallow initialization/runtime failures and hide its Worker until
// initialization finishes, preventing reliable cancellation on WebKit.
function localWorker(progress) {
  const native = new Worker(new URL('./ocr-worker.js', import.meta.url));
  const pending = new Map(); let sequence = 0, dead = false, stage = 'engine';
  const fail = error => { for (const job of pending.values()) job.reject(ocrFailure(error, job.stage)); pending.clear(); };
  native.onerror = event => { event.preventDefault(); fail(event.message); };
  native.onmessageerror = () => fail('Worker message decode failed');
  native.onmessage = ({ data: message }) => {
    if (message.status === 'fatal') { fail(message.data); return; }
    const job = pending.get(message.jobId);
    if (message.status === 'progress') {
      if (message.data?.status === 'recognizing text') progress(`正在识别 · ${Math.round(message.data.progress * 100)}%`);
      return;
    }
    if (!job) return;
    pending.delete(message.jobId);
    if (message.status === 'resolve') job.resolve({ data: message.data });
    else job.reject(ocrFailure(message.data, job.stage));
  };
  const run = (action, payload, nextStage = stage) => {
    stage = nextStage;
    if (dead) return Promise.reject(ocrFailure('Worker stopped', stage));
    const jobId = `ocr-${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(jobId, { resolve, reject, stage });
      try { native.postMessage({ workerId: 'local-ocr', jobId, action, payload }); }
      catch (error) { pending.delete(jobId); reject(ocrFailure(error, stage)); }
    });
  };
  return {
    async initialize(bounded) {
      const base = new URL('./vendor/ocr/', import.meta.url).href;
      progress('正在加载 OCR 引擎 / WASM…');
      await bounded(run('load', { options: { lstmOnly: true, corePath: base, logging: false } }, 'core'));
      for (const [lang, label] of [['chi_sim', '中文'], ['eng', '英文']]) {
        progress(`正在加载${label}模型…`);
        await bounded(run('loadLanguage', { langs: [lang], options: { langPath: base.replace(/\/$/, ''), gzip: true, cacheMethod: 'none', lstmOnly: true } }, lang === 'chi_sim' ? 'model-zh' : 'model-en'));
      }
      progress('正在初始化 OCR 模型…');
      await bounded(run('initialize', { langs: ['chi_sim', 'eng'], oem: 1, config: {} }, 'initialize'));
    },
    setParameters: params => run('setParameters', { params }, 'recognize'),
    recognize: (image, options = {}, output = { text: true, blocks: true }) => run('recognize', { image, options, output }, 'recognize'),
    terminate() { dead = true; native.terminate(); fail('Worker stopped'); },
    get stage() { return stage; }
  };
}

async function retryChineseLines(worker, blob, lines, bounded, signal) {
  const candidates = lines.filter(l => !reliable(l) && l.bbox && /[\u3400-\u9fff]/.test(l.text))
    .sort((a,b) => Number(/名称|通用名|商品名/.test(b.text)) - Number(/名称|通用名|商品名/.test(a.text))).slice(0,16);
  if (!candidates.length) return [];
  const readings = [];
  const url = URL.createObjectURL(blob), image = new Image(); image.src = url;
  try {
    await image.decode(); await worker.setParameters({ tessedit_pageseg_mode: '7' });
    for (const line of candidates) {
      for (const height of [32, 40, 48]) {
        if (signal?.aborted) throw new Error('已取消识别。');
        const {x0,y0,x1,y1} = line.bbox, margin=5;
        const x=Math.max(0,x0-margin), y=Math.max(0,y0-margin);
        const width=Math.min(image.naturalWidth-x,x1-x+margin), h=Math.min(image.naturalHeight-y,y1-y+margin);
        if (width<=0 || h<=0 || width/h>90) continue;
        const scale=height/Math.max(1,y1-y0), canvas=document.createElement('canvas');
        canvas.width=Math.ceil(width*scale)+32; canvas.height=Math.ceil(h*scale)+32;
        const context=canvas.getContext('2d'); context.fillStyle='#fff'; context.fillRect(0,0,canvas.width,canvas.height);
        context.drawImage(image,x,y,width,h,16,16,width*scale,h*scale);
        const cropped=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
        const {data}=await bounded(worker.recognize(new Uint8Array(await cropped.arrayBuffer()),{}, {text:true,blocks:true}));
        const improved=ocrLines(data);
        readings.push(...improved.map(l => l.text).filter(Boolean));
        // No dictionary correction. Only replace with another measured, high-confidence reading.
        if(improved.length===1 && reliable(improved[0])) { Object.assign(line,improved[0]); break; }
      }
    }
    return [...new Set(readings)];
  } finally { URL.revokeObjectURL(url); if (!signal?.aborted) await bounded(worker.setParameters({ tessedit_pageseg_mode: '3' })); }
}
async function normalizeTextScale(blob, data, worker, bounded) {
  const heights=ocrLines(data).filter(l=>/[\u3400-\u9fff]/.test(l.text)).map(l=>l.height).filter(h=>h>0).sort((a,b)=>a-b);
  const median=heights[Math.floor(heights.length/2)];
  if(!median || (median>=26 && median<=38) || Math.abs(data.rotateRadians || 0)>0.01) return {blob,data};
  const url=URL.createObjectURL(blob), img=new Image(); img.src=url;
  try {
    await img.decode(); const scale=Math.min(2,32/median), canvas=document.createElement('canvas');
    canvas.width=Math.round(img.naturalWidth*scale); canvas.height=Math.round(img.naturalHeight*scale);
    if(canvas.width*canvas.height>4000000) return {blob,data};
    canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
    const normalized=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    const rerun=await bounded(worker.recognize(new Uint8Array(await normalized.arrayBuffer()),{}, {text:true,blocks:true}));
    // Whole-page reading preserves layout and avoids concatenating unrelated column fragments.
    const quality=value=>ocrLines(value).filter(l=>reliable(l)).length;
    return quality(rerun.data)>quality(data) ? {blob:normalized,data:rerun.data} : {blob,data};
  } finally {URL.revokeObjectURL(url);}
}

export async function recognizePhotos(files, { signal, progress = () => {}, kind = 'box' } = {}) {
  if (!files.length || files.length > 8) throw new Error('每次请选择 1 至 8 张照片，可分批继续识别。');
  let worker, timer, pageNumber = 0, stopped = false, failWorker;
  const interrupted = new Promise((_, reject) => { failWorker = reject; });
  // Attach a handler immediately, including during image decode and worker initialization.
  interrupted.catch(() => {});
  const stop = () => { stopped = true; worker?.terminate(); failWorker(new Error('已取消识别，原填写内容保留。')); };
  signal?.addEventListener('abort', stop, { once: true });
  const bounded = promise => {
    clearTimeout(timer); timer = setTimeout(() => { failWorker(ocrFailure('timeout', worker?.stage || 'engine')); worker?.terminate(); }, 120000);
    return Promise.race([promise, interrupted]).finally(() => clearTimeout(timer));
  };
  const pages = [];
  try {
    if (signal?.aborted) throw new Error('已取消识别。');
    worker = localWorker(progress);
    await worker.initialize(bounded);
    await bounded(worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' }));
    for (const file of files) {
      pageNumber++;
      if (signal?.aborted) throw new Error('已取消识别。');
      let result, stage = 'decode';
      try {
        // Keep text legible for OCR; stored box previews retain the existing compression policy.
        progress(`正在解码第 ${pageNumber} / ${files.length} 张图片…`);
        const image = await bounded(compressPhoto(file, 'instruction', 2000));
        const bytes = new Uint8Array(await image.blob.arrayBuffer());
        stage = 'recognize'; progress(`OCR 引擎已就绪，正在识别第 ${pageNumber} / ${files.length} 张…`);
        const initial = await bounded(worker.recognize(bytes, { rotateAuto: kind === 'instruction' }, { text: true, blocks: true }));
        result = { lines: ocrLines(initial.data), text: String(initial.data.text || ''), error: null };
        const {data,blob}=await normalizeTextScale(image.blob,initial.data,worker,bounded);
        const lines = ocrLines(data);
        result.lines = lines;
        if (data.text?.trim()) result.text = data.text;
        if (!data.rotateRadians || Math.abs(data.rotateRadians) < 0.01) {
          const readings = await retryChineseLines(worker, blob, lines, bounded, signal);
          if (readings.length) result.text += `\n局部复核读数（可能有误，请对照原图）：\n${readings.join('\n')}`;
        }
        if (!result.text.trim()) result.text = lines.map(l => l.text).join('\n');
        result.error = !result.text.trim() ? '识别结果为空（empty）：引擎已执行，但未返回文字。' : null;
        pages.push(result);
      } catch (error) {
        if (signal?.aborted) throw error;
        const failure = ocrFailure(error, stage);
        // An optional refinement failure must not erase a successful first pass.
        pages.push(result ? { ...result, warning: `二次识别未完成，已保留首次原文。${failure.message}` } : { lines: [], text: '', error: failure.message });
        // Decode errors can be skipped, worker errors must not strand the remaining pages.
        if (stage !== 'decode') break;
      }
    }
    return pages;
  } catch (error) {
    // Worker script failures can reject with a string or undefined in WebKit.
    throw ocrFailure(error, worker?.stage || 'engine');
  } finally { clearTimeout(timer); stopped = true; signal?.removeEventListener('abort', stop); await worker?.terminate(); }
}

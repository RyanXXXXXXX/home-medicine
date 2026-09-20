import { compressPhoto } from './photos.js';
import { ocrLines, reliable } from './ocr-parser.js';

async function retryChineseLines(worker, blob, lines, bounded, signal) {
  const candidates = lines.filter(l => !reliable(l) && l.bbox && /[\u3400-\u9fff]/.test(l.text))
    .sort((a,b) => Number(/名称|通用名|商品名/.test(b.text)) - Number(/名称|通用名|商品名/.test(a.text))).slice(0,16);
  if (!candidates.length) return;
  const url = URL.createObjectURL(blob), image = new Image(); image.src = url;
  try {
    await image.decode(); await worker.setParameters({ tessedit_pageseg_mode: '7' });
    for (const line of candidates) {
      for (const height of [32, 40]) {
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
        // No dictionary correction. Only replace with another measured, high-confidence reading.
        if(improved.length===1 && reliable(improved[0])) { Object.assign(line,improved[0]); break; }
      }
    }
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
    if(canvas.width*canvas.height>12000000) return {blob,data};
    canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);
    const normalized=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    const rerun=await bounded(worker.recognize(new Uint8Array(await normalized.arrayBuffer()),{}, {text:true,blocks:true}));
    // Whole-page reading preserves layout and avoids concatenating unrelated column fragments.
    const quality=value=>ocrLines(value).filter(l=>reliable(l)).length;
    return quality(rerun.data)>quality(data) ? {blob:normalized,data:rerun.data} : {blob,data};
  } finally {URL.revokeObjectURL(url);}
}

export async function recognizePhotos(files, { signal, progress = () => {} } = {}) {
  if (!files.length || files.length > 8) throw new Error('每次请选择 1 至 8 张照片，可分批继续识别。');
  let worker, timer, pageNumber = 0, stopped = false, failWorker;
  const interrupted = new Promise((_, reject) => { failWorker = reject; });
  // Attach a handler immediately, including during image decode and worker initialization.
  interrupted.catch(() => {});
  const stop = () => { stopped = true; worker?.terminate(); failWorker(new Error('已取消识别，原填写内容保留。')); };
  signal?.addEventListener('abort', stop, { once: true });
  const bounded = promise => {
    clearTimeout(timer); timer = setTimeout(() => { worker?.terminate(); failWorker(new Error('识别超时，请分张拍摄或手动填写。')); }, 120000);
    return Promise.race([promise, interrupted]).finally(() => clearTimeout(timer));
  };
  const pages = [];
  try {
    if (signal?.aborted) throw new Error('已取消识别。');
    await import('./vendor/ocr/tesseract.min.js');
    progress('正在启动本地中文识别…');
    const initializing = globalThis.Tesseract.createWorker(['chi_sim', 'eng'], 1, {
      workerPath: new URL('./ocr-worker.js', import.meta.url).href,
      corePath: new URL('./vendor/ocr/', import.meta.url).href,
      langPath: new URL('./vendor/ocr/', import.meta.url).href,
      workerBlobURL: false, gzip: true, cacheMethod: 'none',
      logger: event => { if (event.status === 'recognizing text') progress(`正在识别第 ${pageNumber} / ${files.length} 张 · ${Math.round(event.progress * 100)}%`); },
      errorHandler: () => failWorker(new Error('本地识别引擎无法启动，请联网完成离线准备，或手动填写。'))
    });
    initializing.then(value => { worker = value; if (stopped) value.terminate(); }, () => {});
    worker = await bounded(initializing);
    await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
    for (const file of files) {
      pageNumber++;
      if (signal?.aborted) throw new Error('已取消识别。');
      try {
        // Keep text legible for OCR; stored box previews retain the existing compression policy.
        const image = await compressPhoto(file, 'instruction');
        const bytes = new Uint8Array(await image.blob.arrayBuffer());
        const initial = await bounded(worker.recognize(bytes, { rotateAuto: true }, { text: true, blocks: true }));
        const {data,blob}=await normalizeTextScale(image.blob,initial.data,worker,bounded);
        const lines = ocrLines(data);
        if (!data.rotateRadians || Math.abs(data.rotateRadians) < 0.01) await retryChineseLines(worker, blob, lines, bounded, signal);
        pages.push({ lines, text: lines.map(l=>l.text).join('\n'), error: !lines.length ? '未识别出清晰文字' : null });
      } catch (error) {
        if (signal?.aborted) throw error;
        pages.push({ lines: [], text: '', error: '本页识别失败，请重拍或手动填写' });
        // Decode errors can be skipped, worker errors must not strand the remaining pages.
        if (error?.message?.includes('超时') || error?.message?.includes('引擎')) break;
      }
    }
    return pages;
  } catch (error) {
    // Worker script failures can reject with a string or undefined in WebKit.
    throw error instanceof Error ? error : new Error('本地识别引擎未能加载，请重试或手动填写。');
  } finally { clearTimeout(timer); stopped = true; signal?.removeEventListener('abort', stop); await worker?.terminate(); }
}

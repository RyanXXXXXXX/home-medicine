export async function compressPhoto(file, kind, maxDimension) {
  if (!file || file.size > 40 * 1024 * 1024) throw new Error('单张照片请小于 40 MB。');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try { await image.decode(); } catch { throw new Error('此照片无法读取。请使用 JPEG、PNG 或设备相机照片；HEIC 不兼容时请先转为 JPEG。'); }
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 100_000_000) throw new Error('照片尺寸过大或无法读取。');
    const limit = maxDimension || (kind === 'instruction' ? 3000 : 1600);
    const ratio = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('设备暂时无法处理照片，请重试。');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', kind === 'instruction' ? 0.9 : 0.84));
    if (!blob) throw new Error('照片压缩失败，请重试。');
    // Keep a smaller source when it is already in a safe, browser-readable format.
    const useOriginal = ratio === 1 && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) && file.size < blob.size;
    return { id: crypto.randomUUID(), blob: useOriginal ? file.slice(0, file.size, file.type) : blob, width: canvas.width, height: canvas.height };
  } finally { URL.revokeObjectURL(url); }
}

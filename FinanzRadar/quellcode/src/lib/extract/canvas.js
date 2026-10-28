// Canvas-Hilfen für Rendern, Bildvorverarbeitung und Vorschauen. Werden nur im Browser aufgerufen.
export const THUMB_WIDTH = 360;

/** Weißes Canvas mit gerundeter Größe. */
export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

/** Graustufen + Kontrastspreizung (1 %–99 % Perzentil). Verändert das Canvas in place. */
export function enhanceCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const y = Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
    d[i] = d[i + 1] = d[i + 2] = y;
    hist[y]++;
  }
  const total = w * h;
  const percentile = (p) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * p) return v; }
    return 255;
  };
  const lo = percentile(0.01), hi = percentile(0.99);
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / span));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Canvas-Speicher sofort freigeben (statt auf die Garbage Collection zu warten) */
export function releaseCanvas(canvas) {
  if (canvas) { canvas.width = 0; canvas.height = 0; }
}

/**
 * Bitmap für OCR aufbereiten: bei Breite < minWidth hochskalieren (max. 3x), bei sehr großen Fotos (> maxSide Pixel
 * an der langen Kante) verkleinern – 12-Megapixel-Fotos brauchen sonst Minuten und Hunderte MB. Dann Graustufen/Kontrast.
 */
export function imageToOcrCanvas(bmp, minWidth = 1000, maxSide = 3200) {
  const long = Math.max(bmp.width, bmp.height);
  const k = long > maxSide ? maxSide / long : bmp.width < minWidth ? Math.min(3, minWidth / bmp.width) : 1;
  const canvas = makeCanvas(bmp.width * k, bmp.height * k);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  enhanceCanvas(canvas);
  return { canvas, unit: canvas.width / bmp.width };
}

/** Kleine JPEG-Vorschau einer Bitmap, max. THUMB_WIDTH Pixel breit. */
export function thumbnailBlob(bmp) {
  const w = Math.min(THUMB_WIDTH, bmp.width);
  const h = Math.round((bmp.height * w) / bmp.width);
  const canvas = makeCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  return canvasToBlob(canvas, 'image/jpeg', 0.75);
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.75) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Vorschau konnte nicht erzeugt werden'))), type, quality);
  });
}

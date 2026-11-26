/**
 * Price-label OCR, entirely in this browser.
 * All executable code and language models are served from this site's origin.
 * Photo pixels are passed only to local dedicated workers, never to fetch/XHR.
 * Tesseract.js / core 7.0.0; model provenance: vendor/ocr/PROVENANCE.json.
 */

const WORKER_URL = new URL('./vendor/ocr/label-worker.js', import.meta.url);
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 100_000_000;
const MAX_EDGE = 2600;
const TIMEOUT_MS = 120_000;
let activeJob = false;

function aborted() {
  return new DOMException('사진 읽기를 취소했습니다.', 'AbortError');
}

function checkSignal(signal) {
  if (signal?.aborted) throw aborted();
}

function progressReporter(onProgress) {
  let last = 0;
  return (status, progress) => {
    const next = Number.isFinite(progress) ? progress : last;
    last = Math.max(last, Math.min(1, Math.max(0, next)));
    if (typeof onProgress === 'function') {
      // A UI callback must not break or leave an OCR worker running.
      try { onProgress({status, progress:last}); } catch { /* UI owns its errors. */ }
    }
  };
}

function canvasBlob(canvas, signal) {
  checkSignal(signal);
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({type:'image/png'});
  }
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(blob => {
        if (signal?.aborted) reject(aborted());
        else if (blob) resolve(blob);
        else reject(new Error('사진을 읽을 수 없습니다. JPG 또는 PNG 사진으로 다시 시도해 주세요.'));
      }, 'image/png');
    } catch (error) {
      reject(new Error('사진을 처리할 수 없습니다. 기기에 저장된 사진을 선택해 주세요.', {cause:error}));
    }
  });
}

async function decodeBlob(blob, signal) {
  checkSignal(signal);
  if (blob.size === 0 || blob.size > MAX_FILE_BYTES) {
    throw new Error('사진 파일은 0바이트보다 크고 30MB 이하여야 합니다.');
  }
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob, {imageOrientation:'from-image'});
      if (signal?.aborted) { bitmap.close(); throw aborted(); }
      return {image:bitmap, width:bitmap.width, height:bitmap.height, close:()=>bitmap.close()};
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      // Safari may decode a photo through <img> even when createImageBitmap fails.
    }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    let settled = false;
    const clean = () => {
      signal?.removeEventListener('abort', cancel);
      img.onload = null;
      img.onerror = null;
      URL.revokeObjectURL(url);
    };
    const cancel = () => {
      if (settled) return;
      settled = true;
      clean();
      img.src = '';
      reject(aborted());
    };
    img.onload = () => {
      if (settled) return;
      settled = true;
      clean();
      resolve({image:img,width:img.naturalWidth,height:img.naturalHeight,close:()=>{img.src='';}});
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      clean();
      reject(new Error('이 사진 형식을 읽을 수 없습니다. JPG·PNG로 저장하거나 화면 캡처로 다시 시도해 주세요.'));
    };
    signal?.addEventListener('abort', cancel, {once:true});
    if (signal?.aborted) cancel();
    else img.src = url;
  });
}

async function prepareImage(input, signal) {
  let decoded;
  const isCanvas = typeof HTMLCanvasElement !== 'undefined' && input instanceof HTMLCanvasElement;
  const isOffscreen = typeof OffscreenCanvas !== 'undefined' && input instanceof OffscreenCanvas;
  if (isCanvas || isOffscreen) {
    decoded = {image:input,width:input.width,height:input.height,close:()=>{}};
  } else if (input instanceof Blob) {
    decoded = await decodeBlob(input, signal);
  } else {
    // Deliberately reject URL strings: recognition never downloads a user's photo.
    throw new TypeError('기기에 저장된 사진 파일 또는 잘라낸 사진을 선택해 주세요.');
  }
  try {
    checkSignal(signal);
    const {width,height} = decoded;
    if (!(width > 0 && height > 0) || width * height > MAX_SOURCE_PIXELS) {
      throw new Error('사진 크기를 확인해 주세요. 가격표 부분을 잘라 다시 선택하면 더 잘 읽을 수 있습니다.');
    }
    const longest = Math.max(width,height);
    const scale = longest > MAX_EDGE ? MAX_EDGE/longest : Math.min(2,Math.max(1,1400/longest));
    const w = Math.max(1,Math.round(width*scale));
    const h = Math.max(1,Math.round(height*scale));
    const padding = 20;
    const canvas = document.createElement('canvas');
    canvas.width = w + padding*2;
    canvas.height = h + padding*2;
    const context = canvas.getContext('2d', {alpha:false});
    if (!context) throw new Error('이 브라우저에서 사진을 처리할 수 없습니다. 최신 Safari 또는 Chrome에서 다시 시도해 주세요.');
    context.fillStyle = '#ffffff';
    context.fillRect(0,0,canvas.width,canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(decoded.image,padding,padding,w,h);
    const blob = await canvasBlob(canvas,signal);
    checkSignal(signal);
    const result = {blob,imageWidth:canvas.width,imageHeight:canvas.height};
    canvas.width = 1;
    canvas.height = 1;
    return result;
  } finally {
    decoded.close();
  }
}

/**
 * @param {Blob|HTMLCanvasElement|OffscreenCanvas} imageBlobOrCanvas
 * @param {{onProgress?:(value:{status:string,progress:number})=>void, signal?:AbortSignal}} options
 * @returns {Promise<{text:string,confidence:number,blocks:Array,imageWidth:number,imageHeight:number}>}
 * Confidence is Tesseract's estimate on a 0–100 scale, not a verified probability.
 * Blocks use coordinates in the internally scaled, padded image.
 */
export async function recognizePriceLabel(imageBlobOrCanvas, {onProgress,signal}={}) {
  checkSignal(signal);
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') {
    throw new Error('이 브라우저에서 사진 읽기를 지원하지 않습니다. 최신 Safari 또는 Chrome에서 열어 주세요.');
  }
  if (activeJob) throw new Error('다른 사진을 읽고 있습니다. 취소하거나 완료될 때까지 기다려 주세요.');
  activeJob = true;
  const report = progressReporter(onProgress);
  let worker;
  try {
    report('사진 준비 중',0);
    const prepared = await prepareImage(imageBlobOrCanvas,signal);
    checkSignal(signal);
    report('사진 읽기 도구 준비 중',0.04);
    return await new Promise((resolve,reject) => {
      let done = false;
      let timeout;
      const finish = (error,result) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', cancel);
        if (worker) {
          worker.onmessage = null;
          worker.onerror = null;
          worker.onmessageerror = null;
          worker.terminate();
        }
        if (error) reject(error); else resolve(result);
      };
      const cancel = () => finish(aborted());
      signal?.addEventListener('abort', cancel, {once:true});
      if (signal?.aborted) { cancel(); return; }
      try {
        worker = new Worker(WORKER_URL, {name:'unitcart-price-label-ocr'});
      } catch (error) {
        finish(new Error('사진 읽기 도구를 시작하지 못했습니다. 페이지를 새로 고침한 뒤 다시 시도해 주세요.', {cause:error}));
        return;
      }
      worker.onmessage = ({data}) => {
        if (done || !data) return;
        if (data.type === 'progress') report(data.status,data.progress);
        else if (data.type === 'result') {
          report('사진 읽기 완료',1);
          finish(null,{
            text: typeof data.text === 'string' ? data.text : '',
            confidence: Number.isFinite(data.confidence) ? Math.min(100,Math.max(0,data.confidence)) : 0,
            blocks: Array.isArray(data.blocks) ? data.blocks : [],
            imageWidth:prepared.imageWidth,
            imageHeight:prepared.imageHeight,
          });
        } else if (data.type === 'error') {
          finish(new Error(data.message || '사진을 읽지 못했습니다. 가격표를 선명하게 찍어 다시 시도해 주세요.'));
        }
      };
      worker.onerror = event => {
        event.preventDefault();
        finish(new Error('사진 읽기 도구를 불러오지 못했습니다. 인터넷 연결을 확인한 뒤 새로 고침해 주세요.'));
      };
      worker.onmessageerror = () => finish(new Error('사진 처리 결과를 받지 못했습니다. 다른 사진으로 다시 시도해 주세요.'));
      timeout = setTimeout(() => finish(new Error('사진 읽기에 시간이 오래 걸립니다. 가격표만 잘라 더 작은 사진으로 다시 시도해 주세요.')),TIMEOUT_MS);
      try { worker.postMessage({type:'recognize',image:prepared.blob}); }
      catch (error) { finish(new Error('사진을 처리할 수 없습니다. 다른 사진으로 다시 시도해 주세요.', {cause:error})); }
    });
  } finally {
    if (worker) worker.terminate();
    activeJob = false;
  }
}

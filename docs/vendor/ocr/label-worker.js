/* Unitcart's OCR supervisor. Third-party bundles remain unmodified.
 * This worker is created only when a user asks to read a photo. Its child worker
 * can be stopped even during initialization by terminating this supervisor.
 */
'use strict';

let started = false;
let ocr;
let recognitionPass = 0;
const base = new URL('.', self.location.href);

function progress(message) {
  const value = Number.isFinite(message.progress) ? message.progress : 0;
  const stages = {
    'loading tesseract core':['사진 읽기 도구 준비 중',0.06,0.12],
    'initializing tesseract':['사진 읽기 도구 준비 중',0.12,0.18],
    'loading language traineddata':['한국어·영어 읽기 준비 중',0.18,0.34],
    'initializing api':['사진 읽기 준비 중',0.34,0.4],
    'recognizing text':recognitionPass === 0
      ? ['상품명과 가격 읽는 중',0.4,0.69]
      : ['작은 글자와 가격 다시 확인 중',0.7,0.98],
  };
  const stage = stages[message.status];
  if (stage) self.postMessage({type:'progress',status:stage[0],progress:stage[1]+Math.max(0,Math.min(1,value))*(stage[2]-stage[1])});
}

const text = value => typeof value === 'string' ? value : '';
const confidence = value => Number.isFinite(value) ? Math.max(0,Math.min(100,value)) : 0;
function bbox(value) {
  if (!value) return null;
  return {x0:Number(value.x0)||0,y0:Number(value.y0)||0,x1:Number(value.x1)||0,y1:Number(value.y1)||0};
}
function words(list) {
  return (list||[]).map(word=>({text:text(word.text),confidence:confidence(word.confidence),bbox:bbox(word.bbox)}));
}
function blocks(list) {
  return (list||[]).map(block=>({
    text:text(block.text),confidence:confidence(block.confidence),bbox:bbox(block.bbox),
    paragraphs:(block.paragraphs||[]).map(paragraph=>({
      text:text(paragraph.text),confidence:confidence(paragraph.confidence),bbox:bbox(paragraph.bbox),
      lines:(paragraph.lines||[]).map(line=>({
        text:text(line.text),confidence:confidence(line.confidence),bbox:bbox(line.bbox),words:words(line.words),
      })),
    })),
  }));
}
function area(box) {
  return box ? Math.max(0,box.x1-box.x0)*Math.max(0,box.y1-box.y0) : 0;
}
function intersection(a,b) {
  if (!a || !b) return 0;
  return Math.max(0,Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0))*Math.max(0,Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0));
}
function allLines(list) {
  return list.flatMap(block=>block.paragraphs.flatMap(paragraph=>paragraph.lines));
}
function mergeReadings(primary,secondary) {
  const result = blocks(primary.blocks);
  const alternatives = allLines(blocks(secondary.blocks));
  const lines = allLines(result);
  for (const line of lines) {
    // Use another actual reading only for the same region and a clearly higher
    // recognition score. No price or product-name text is guessed or synthesized.
    const candidates = alternatives.filter(other=>{
      const hit = intersection(line.bbox,other.bbox);
      const union = area(line.bbox)+area(other.bbox)-hit;
      return union > 0 && hit/union >= 0.6 && other.confidence >= line.confidence+8;
    }).sort((a,b)=>b.confidence-a.confidence);
    if (candidates[0]) Object.assign(line,candidates[0]);
  }
  const duplicate = new Set(lines.filter(line=>lines.some(other=>{
    if (line === other || !area(line.bbox)) return false;
    return area(other.bbox) > area(line.bbox)*1.35
      && intersection(line.bbox,other.bbox)/area(line.bbox) > 0.85
      && other.confidence >= line.confidence+3;
  })));
  for (const block of result) {
    for (const paragraph of block.paragraphs) {
      paragraph.lines = paragraph.lines.filter(line=>!duplicate.has(line));
      paragraph.text = paragraph.lines.map(line=>line.text.trim()).filter(Boolean).join('\n');
    }
    block.text = block.paragraphs.map(paragraph=>paragraph.text).filter(Boolean).join('\n');
  }
  const joined = result.map(block=>block.text).filter(Boolean).join('\n\n');
  if (!joined.trim() && secondary.text?.trim()) return {text:secondary.text,confidence:confidence(secondary.confidence),blocks:blocks(secondary.blocks)};
  return {text:joined||text(primary.text),confidence:confidence(primary.confidence),blocks:result};
}

self.onmessage = async ({data}) => {
  if (started || data?.type !== 'recognize') return;
  started = true;
  try {
    if (!(data.image instanceof Blob)) throw new Error('사진 파일을 확인해 주세요.');
    importScripts(new URL('tesseract.min.js',base).href);
    ocr = await Tesseract.createWorker(['kor','eng'], Tesseract.OEM.LSTM_ONLY, {
      workerPath:new URL('worker.min.js',base).href,
      corePath:new URL('core',base).href,
      langPath:new URL('lang',base).href,
      gzip:false,
      workerBlobURL:false,
      cacheMethod:'none',
      logger:progress,
      errorHandler:error=>self.postMessage({type:'error',message:'사진 읽기 도구에 오류가 발생했습니다. 페이지를 새로 고침해 다시 시도해 주세요.',detail:String(error).slice(0,300)}),
    });
    await ocr.setParameters({
      tessedit_pageseg_mode:Tesseract.PSM.SINGLE_BLOCK,
      preserve_interword_spaces:'1',
      user_defined_dpi:'300',
    });
    const {data:primary} = await ocr.recognize(data.image,{rotateAuto:false},{text:true,blocks:true});
    recognitionPass = 1;
    await ocr.setParameters({tessedit_pageseg_mode:Tesseract.PSM.SPARSE_TEXT});
    const {data:secondary} = await ocr.recognize(data.image,{rotateAuto:false},{text:true,blocks:true});
    const response = {type:'result',...mergeReadings(primary,secondary)};
    await ocr.terminate();
    ocr = null;
    self.postMessage(response);
  } catch (error) {
    if (ocr) { try { await ocr.terminate(); } catch { /* Supervisor will be terminated. */ } }
    self.postMessage({type:'error',message:'사진을 읽지 못했습니다. 가격표를 똑바로 선명하게 찍어 다시 시도해 주세요.',detail:String(error?.message||error).slice(0,300)});
  }
};

import {parsePriceLabel} from './label-parser.js';
import {readRetailBarcodes} from './barcode.js';

const MAX_BYTES=20*1024*1024,MAX_EDGE=2200;
const camera='<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 7h4l2-3h6l2 3h4v14H3z"/><circle cx="12" cy="13" r="4"/></svg>';

/** Images stay in memory. Only confirmed product fields are saved by the app. */
export function openPhotoImport({dialog,onRecognized}) {
  let canvas=null,original=null,controller=null,busy=false,closed=false,loadId=0,cropMode=false,start=null,selection=null;
  const events=new AbortController();
  dialog.innerHTML=`<div class="dialog-header"><h2>가격표 사진으로 등록</h2><button type="button" class="icon-button" data-action="close-dialog" aria-label="닫기">✕</button></div>
    <div class="dialog-body photo-body">
      <div class="photo-steps"><b>1 사진 선택</b><span>2 영역 선택</span><span>3 인식 · 기록</span></div>
      <p class="small muted">상품명과 묶음 판매가가 보이게 찍어 주세요. 같은 사진에 바코드가 있으면 함께 읽습니다.</p>
      <div class="photo-pickers"><label class="button primary photo-picker">${camera}사진 촬영<input type="file" accept="image/*" capture="environment" id="photo-camera" aria-label="가격표 사진 촬영"></label><label class="button photo-picker">사진 선택<input type="file" accept="image/*" id="photo-file" aria-label="저장된 가격표 사진 선택"></label></div>
      <div class="photo-workspace hidden" id="photo-workspace">
        <div class="photo-stage" id="photo-stage"><canvas id="photo-canvas" aria-label="선택한 가격표 사진"></canvas><div id="photo-selection" class="photo-selection hidden"></div></div>
        <div class="photo-tools"><button class="button slim" type="button" id="photo-rotate">90° 회전</button><button class="button slim" type="button" id="photo-crop" aria-pressed="false">가격표 영역 선택</button><button class="button slim hidden" type="button" id="photo-apply-crop">선택 영역 인식</button><button class="text-button" type="button" id="photo-reset">원본으로</button></div>
        <p class="meta" id="photo-crop-help">글자가 작으면 가격표 부분만 선택해서 다시 읽어 보세요.</p>
        <div class="photo-progress" role="status" aria-live="polite"><span id="photo-status">사진을 준비합니다.</span><progress id="photo-progress" max="1" value="0" aria-label="글자 인식 진행률"></progress></div>
        <div class="actions"><button class="button primary" type="button" id="photo-read">사진 전체 인식</button><button class="button hidden" type="button" id="photo-stop">인식 중단</button></div>
      </div>
      <p class="form-error" id="photo-error" role="alert"></p>
      <div class="photo-privacy"><b>사진은 기기 안에서 처리해요.</b><br>처음 읽을 때 인식 파일을 불러와 시간이 걸릴 수 있어요. 사진은 저장하거나 외부로 전송하지 않습니다. 최대 20MB.</div>
      <details class="photo-text-fallback"><summary>사진 없이 가격표 글자 붙여넣기</summary><textarea id="photo-text" aria-label="가격표 텍스트" maxlength="12000" placeholder="제품명, 용량, 가격을 붙여넣으세요"></textarea><button class="button slim" id="photo-parse-text" type="button">글자로 입력란 채우기</button></details>
      <p class="small muted" style="margin-top:16px">읽은 값은 저장 전에 확인합니다. 등록한 상품이면 같은 가격 이력에 이어서 기록할 수 있어요.</p>
    </div><div class="dialog-footer"><button type="button" class="button" data-action="close-dialog">닫기</button></div>`;
  const el=id=>dialog.querySelector('#'+id);
  const listen=(target,type,handler)=>target.addEventListener(type,handler,{signal:events.signal});
  const error=message=>{el('photo-error').textContent=message;};
  const status=(message,progress=0)=>{el('photo-status').textContent=message;el('photo-progress').value=Math.max(0,Math.min(1,progress));};
  function clean(){if(closed)return;closed=true;++loadId;controller?.abort();events.abort();canvas=null;original=null;}
  listen(dialog,'close',clean);
  function setBusy(value){busy=value;dialog.querySelector('.photo-body').setAttribute('aria-busy',String(value));for(const id of ['photo-rotate','photo-crop','photo-apply-crop','photo-reset','photo-read','photo-file','photo-camera','photo-parse-text'])el(id).disabled=value;el('photo-stop').classList.toggle('hidden',!value);}
  function clearSelection(){selection=null;start=null;el('photo-selection').classList.add('hidden');el('photo-apply-crop').classList.add('hidden');}
  function setCrop(value){cropMode=value;clearSelection();el('photo-crop').setAttribute('aria-pressed',String(value));el('photo-stage').classList.toggle('cropping',value);el('photo-crop-help').textContent=value?'사진 위를 드래그해 제품명과 가격이 들어간 영역을 선택하세요.':'글자가 작으면 가격표 부분만 선택해서 다시 읽어 보세요.';}
  function showCanvas(){const view=el('photo-canvas');view.width=canvas.width;view.height=canvas.height;view.getContext('2d').drawImage(canvas,0,0);el('photo-workspace').classList.remove('hidden');clearSelection();}
  function finish(text, confidence=null, options={}) {
    if(closed)return;
    const draft=parsePriceLabel(text,options);
    draft.rawText=text.slice(0,12000);
    draft.confidence=confidence;
    draft.photoPreview=canvas?preview(canvas):'';
    clean();
    onRecognized(draft);
  }

  async function recognize() {
    if(!canvas || busy || closed)return;
    error('');
    setCrop(false);
    setBusy(true);
    controller=new AbortController();
    const {signal}=controller;
    status('가격표 글자와 바코드를 읽고 있어요…');
    try {
      const {recognizePriceLabel}=await import('./ocr-engine.js');
      if(closed || signal.aborted)return;
      const [ocr,codes]=await Promise.allSettled([
        recognizePriceLabel(canvas,{signal,onProgress:({status:stage,progress})=>{
          if(!closed)status(stage||'가격표 글자를 읽고 있어요…',progress);
        }}),
        readRetailBarcodes(canvas),
      ]);
      if(closed)return;
      if(signal.aborted){status('인식을 중단했습니다.');return;}
      const barcodes=codes.status==='fulfilled'?codes.value:[];
      const result=ocr.status==='fulfilled'?ocr.value:null;
      if(!result?.text.trim()&&!barcodes.length) {
        if(ocr.status==='rejected')throw ocr.reason;
        error('상품명이나 바코드를 읽지 못했어요. 사진에서 가격표 영역을 선택하거나 직접 입력해 주세요.');
        status('가격표를 다시 확인해 주세요.');
        return;
      }
      finish(result?.text||'',result?.confidence??null,{photo:true,blocks:result?.blocks||[],barcodes});
    }catch(err){
      if(closed)return;
      error(err.message||'가격표를 읽지 못했습니다. 사진을 다시 선택해 주세요.');
      status('사진 읽기 실패');
    }finally{
      if(!closed){setBusy(false);controller=null;}
    }
  }
  async function choose(file){
    if(!file||busy)return;const current=++loadId;error('');
    if(file.size>MAX_BYTES){error('사진은 20MB 이하로 선택해 주세요.');return;}
    if(file.type&&!file.type.startsWith('image/')){error('JPG, PNG 등 사진 파일을 선택해 주세요.');return;}
    setBusy(true);
    try{const decoded=await decodeImage(file);if(closed||current!==loadId){decoded.close?.();return;}original=fitCanvas(decoded);decoded.close?.();canvas=cloneCanvas(original);showCanvas();setCrop(true);status('가격표 부분을 선택하거나 사진 전체를 인식하세요.');}
    catch{if(!closed)error('이 사진 형식을 열지 못했어요. JPG·PNG 사진이나 가격표 스크린샷으로 다시 선택해 주세요.');}
    finally{if(!closed)setBusy(false);}
  }
  for(const id of ['photo-file','photo-camera'])listen(el(id),'change',e=>{const file=e.target.files?.[0];e.target.value='';choose(file);});
  listen(el('photo-read'),'click',recognize);
  listen(el('photo-stop'),'click',()=>controller?.abort());
  listen(el('photo-rotate'),'click',()=>{if(!canvas||busy)return;const next=document.createElement('canvas');next.width=canvas.height;next.height=canvas.width;const ctx=next.getContext('2d');ctx.translate(next.width,0);ctx.rotate(Math.PI/2);ctx.drawImage(canvas,0,0);canvas=next;setCrop(false);showCanvas();status('사진을 회전했습니다. 다시 읽기를 눌러 주세요.');});
  listen(el('photo-reset'),'click',()=>{if(!original||busy)return;canvas=cloneCanvas(original);setCrop(false);showCanvas();status('원본 사진으로 돌아왔습니다.');});
  listen(el('photo-crop'),'click',()=>setCrop(!cropMode));
  const point=e=>{const r=el('photo-canvas').getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};};
  function paintSelection(){if(!selection)return;const box=el('photo-selection');Object.assign(box.style,{left:selection.x*100+'%',top:selection.y*100+'%',width:selection.w*100+'%',height:selection.h*100+'%'});box.classList.remove('hidden');}
  listen(el('photo-canvas'),'pointerdown',e=>{if(!cropMode||busy)return;e.preventDefault();start=point(e);el('photo-canvas').setPointerCapture(e.pointerId);});
  listen(el('photo-canvas'),'pointermove',e=>{if(!start)return;const p=point(e);selection={x:Math.min(start.x,p.x),y:Math.min(start.y,p.y),w:Math.abs(p.x-start.x),h:Math.abs(p.y-start.y)};paintSelection();});
  listen(el('photo-canvas'),'pointerup',()=>{start=null;if(selection&&selection.w>.03&&selection.h>.03)el('photo-apply-crop').classList.remove('hidden');else clearSelection();});
  listen(el('photo-canvas'),'pointercancel',clearSelection);
  listen(el('photo-apply-crop'),'click',()=>{if(!selection||busy)return;const next=document.createElement('canvas');next.width=Math.max(1,Math.round(canvas.width*selection.w));next.height=Math.max(1,Math.round(canvas.height*selection.h));next.getContext('2d').drawImage(canvas,canvas.width*selection.x,canvas.height*selection.y,canvas.width*selection.w,canvas.height*selection.h,0,0,next.width,next.height);canvas=next;setCrop(false);showCanvas();recognize();});
  listen(el('photo-parse-text'),'click',()=>{const text=el('photo-text').value.trim();if(text.length<3){error('제품명과 가격이 있는 글자를 입력해 주세요.');return;}finish(text);});
  if(!dialog.open)dialog.showModal();
}

/** Read a second photo of the package without replacing the shelf-label draft. */
export async function readBarcodePhoto(file) {
  if(!file || (file.type && !file.type.startsWith('image/')))throw new Error('바코드가 찍힌 사진을 선택해 주세요.');
  if(file.size>MAX_BYTES)throw new Error('20MB 이하의 사진을 선택해 주세요.');
  let image;
  try{
    image=await decodeImage(file);
  }catch{
    throw new Error('사진을 열 수 없습니다. JPG나 PNG로 다시 선택해 주세요.');
  }
  let codes;
  try{
    codes=await readRetailBarcodes(fitCanvas(image));
  }finally{
    image.close?.();
  }
  if(codes.length>1)throw new Error('여러 바코드가 보입니다. 해당 상품의 바코드 하나만 찍어 주세요.');
  if(!codes.length)throw new Error('바코드를 읽지 못했습니다. 줄무늬와 양쪽 여백을 포함해 다시 찍거나 아래 숫자를 직접 입력하세요.');
  return codes[0];
}

async function decodeImage(file){if(typeof createImageBitmap==='function'){try{return await createImageBitmap(file,{imageOrientation:'from-image'});}catch{}}const url=URL.createObjectURL(file);try{return await new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve(image);image.onerror=reject;image.src=url;});}finally{URL.revokeObjectURL(url);}}
function fitCanvas(image){const w=image.width||image.naturalWidth,h=image.height||image.naturalHeight;if(!w||!h||w*h>100_000_000)throw new Error('사진 크기를 확인해 주세요.');const scale=Math.min(1,MAX_EDGE/Math.max(w,h)),out=document.createElement('canvas');out.width=Math.round(w*scale);out.height=Math.round(h*scale);const ctx=out.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,out.width,out.height);ctx.drawImage(image,0,0,out.width,out.height);return out;}
function cloneCanvas(source){const copy=document.createElement('canvas');copy.width=source.width;copy.height=source.height;copy.getContext('2d').drawImage(source,0,0);return copy;}
function preview(source){const scale=Math.min(1,1000/Math.max(source.width,source.height)),small=document.createElement('canvas');small.width=Math.round(source.width*scale);small.height=Math.round(source.height*scale);small.getContext('2d').drawImage(source,0,0,small.width,small.height);return small.toDataURL('image/jpeg',.75);}

import {today} from './core.js';
import {saveOnlinePrice} from './household-api.js';
import {parseShoppingListing} from './household-shopping.js';

const el = id => document.getElementById(id);
const numericFields = {price:'price',pieces:'count',shipping:'shipping'};
const norm = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/gu,'');
const marketName = {naver:'네이버',coupang:'쿠팡'};

export function linkMarket(raw) {
  try {
    const u=new URL(raw);
    if (u.protocol!=='https:' || u.username || u.password || u.port) return '';
    if (/^(?:(?:www\.|m\.|link\.)?coupang\.com|coupa\.ng)$/.test(u.hostname)) return 'coupang';
    if (/^(?:naver\.me|(?:m\.)?(?:smartstore|brand)\.naver\.com|(?:m\.|search\.|msearch\.)?shopping\.naver\.com)$/.test(u.hostname)) return 'naver';
  } catch { /* Pasted share text can contain more than just a URL. */ }
  return '';
}

export function sharedListing(text, richUrl='', richTitle='') {
  const content=String(text || '').slice(0,16000);
  const links=(content.match(/https:\/\/[^\s<>"']+/gi)||[]).map(s=>s.replace(/[\]).,，。〉》]+$/u,''));
  if (!links.length && richUrl) links.push(richUrl);
  const candidates=[...new Set(links.filter(link=>linkMarket(link)))];
  if (candidates.length!==1) return null;
  const url=candidates[0];
  const parsed=parseShoppingListing(content);
  const lines=content.replace(url,'').replace(/쿠팡을?\s*추천합니다[!. ]*/gu,'').split(/[\n\r]+/u)
    .map(s=>s.trim()).filter(s=>s && !/^(?:https?:|네이버\s*쇼핑$|쿠팡$|공유하기$|무료\s*배송|로켓배송$|(?:총\s*수량|총\s*개수|구성|배송[비료]|판매가|상품\s*(?:가격|금액|가)|\d[\d,]*\s*원))/u.test(s));
  const title=lines.length===1 && /[\p{L}]/u.test(lines[0]) ? lines[0] : (richUrl===url ? richTitle : '');
  return {market:linkMarket(url),url,title:String(title||'').replace(/\s+/gu,' ').trim().slice(0,200),...parsed};
}

export function matchesOffer(row, product) {
  if (!product) return false;
  if (row.parent && row.parent===product.parent) return true;
  if (row.itemNo && product.itemNo && row.itemNo!==product.itemNo ||
      row.barcode && product.barcode && row.barcode!==product.barcode) return false;
  if (row.itemNo && row.itemNo===product.itemNo || row.barcode && row.barcode===product.barcode) return true;
  return Boolean(norm(product.product) && norm(product.product)===norm(row.product) &&
    (!product.pack || !row.pack || norm(product.pack)===norm(row.pack)));
}

// The rows arrive newest first. Prefer an exact Costco association when
// equally named products were sold in different packs.
export function preferredOffer(rows, product) {
  const matched=rows.filter(row=>matchesOffer(row,product));
  const exact=matched.find(row=>row.parent && row.parent===product.parent) ||
    matched.find(row=>row.itemNo && row.itemNo===product.itemNo || row.barcode && row.barcode===product.barcode) ||
    matched.find(row=>row.pack && norm(row.pack)===norm(product.pack));
  if (exact) return exact;
  const packs=new Set(matched.map(row=>norm(row.pack)).filter(Boolean));
  return packs.size>1 ? null : matched[0] || null;
}

export function clipboardListing(data) {
  if (!data) return null;
  const text=data.getData('text/plain') || data.getData('text/uri-list');
  const plain=sharedListing(text);
  if (plain?.title) return plain;
  let href='',title='';
  const html=data.getData('text/html');
  if (html) {
    const template=document.createElement('template');
    template.innerHTML=html.slice(0,32000);
    const anchors=[...template.content.querySelectorAll('a[href]')].filter(a=>linkMarket(a.getAttribute('href')));
    if (anchors.length===1) {
      href=anchors[0].getAttribute('href');
      const label=anchors[0].textContent.trim();
      if (label && !/^https?:|^상품\s*보기$|^링크$/i.test(label)) title=label;
    }
  }
  return href || title ? sharedListing(text,href,title) : plain;
}

function element(tag, text, className) {
  const node=document.createElement(tag);
  if (text) node.textContent=text;
  if (className) node.className=className;
  return node;
}

export function initOnlineRecords({context, costcoRows, epoch, active, onAuthError, onWrite, update, openProduct, showMarket, amount}) {
  let rows=[], states={}, historyLimit=25, readError='';
  const ctl=(id,key)=>el(id+'-'+key);
  const ids=Object.keys(marketName);
  const fresh=()=>({selected:null,explicit:false,dirty:false,busy:false,skipRecall:false,retry:null,newId:crypto.randomUUID(),inputUrl:'',listSignature:null});
  const number=(id,key)=>ctl(id,key).value.trim()==='' ? null : Number(ctl(id,key).value);
  const say=(id,msg='',error=false)=>{
    const out=ctl(id,'status'); out.textContent=msg; out.classList.toggle('error',error);
  };
  function enable(id) {
    const s=states[id];
    for (const key of ['url','title','price','count','shipping','day','read','save','new','text']) ctl(id,key).disabled=s.busy;
    el('parse-'+id).disabled=s.busy;
    ctl(id,'save').textContent=s.selected?'수정 저장':'온라인 가격 저장';
    ctl(id,'new').hidden=!s.selected;
  }
  function fill(id,row,explicit=false) {
    const s=states[id];
    s.selected=row; s.inputUrl=row.url; s.explicit=explicit; s.dirty=false; s.skipRecall=false; s.retry=null;
    for (const key of ['url','title','day']) ctl(id,key).value=row[key]||'';
    for (const [key,input] of Object.entries(numericFields)) ctl(id,input).value=row[key]??'';
    enable(id);
  }
  function clearOne(id,skipRecall=false) {
    states[id]=fresh();
    states[id].skipRecall=skipRecall;
    for (const key of ['url','title','price','count','shipping','text']) ctl(id,key).value='';
    ctl(id,'paste-box').open=false; ctl(id,'parse-msg').textContent='';
    ctl(id,'day').value=today(); ctl(id,'saved').replaceChildren();
    enable(id); say(id);
  }
  function reset() { for (const id of ids) clearOne(id); }
  function bodyFor(id) {
    return {...context(),market:id,url:ctl(id,'url').value.trim(),title:ctl(id,'title').value.trim(),
      day:ctl(id,'day').value || today(),price:number(id,'price'),pieces:number(id,'count'),shipping:number(id,'shipping')};
  }
  function commitLocal(row) {
    rows=[row,...rows.filter(r=>r.id!==row.id)];
    onWrite();
    renderHistory();
  }
  function select(row,fromHistory) {
    if (fromHistory && openProduct(row)===false) return;
    const id=row.market;
    if (states[id].busy) return;
    showMarket(id); fill(id,row,true);
    say(id,row.day+' 기록을 수정 중이에요.');
    update();
    ctl(id,'url').scrollIntoView({block:'center'});
  }
  function display(row,fromHistory,parent) {
    const box=element('div','','hh-saved-offer'), info=element('div'), buttons=element('div','','hh-offer-actions');
    const product=parent?.product || row.product;
    info.append(element('strong',(fromHistory?marketName[row.market]+' · ':'')+(row.title || product || row.itemNo || row.barcode || '상품 링크')),
      element('small',[row.day,fromHistory?product:'',row.price==null?'가격 확인 필요':amount(row.price),
        row.pieces!=null?row.pieces+'개':'',row.shipping!=null?'배송비 '+amount(row.shipping):''].filter(Boolean).join(' · '),'hh-meta'));
    if (row.url && linkMarket(row.url)===row.market) {
      const a=element('a','상품 열기','hh-link'); a.href=row.url; a.target='_blank'; a.rel='noopener noreferrer'; buttons.append(a);
    }
    const edit=element('button','수정','hh-link'); edit.type='button';
    edit.setAttribute('aria-label',(row.title||row.product||'저장된 상품')+' '+marketName[row.market]+' 가격 수정');
    edit.addEventListener('click',()=>select(row,fromHistory)); buttons.append(edit);
    box.append(info,buttons); return box;
  }
  function ordered(a,b) { return b.day.localeCompare(a.day) || b.updated.localeCompare(a.updated); }
  function renderHistory() {
    const q=norm(el('history-query').value);
    const parents=new Map(costcoRows().map(r=>[r.submission,r]));
    const hits=rows.filter(r=>{
      if (!q) return true;
      const parent=parents.get(r.parent);
      return [r.product,r.title,r.pack,r.itemNo,r.barcode,marketName[r.market],parent?.product,parent?.itemNo,parent?.barcode]
        .some(v=>norm(v).includes(q));
    }).sort(ordered);
    const box=el('offer-history'); box.replaceChildren(...hits.slice(0,historyLimit).map(r=>display(r,true,parents.get(r.parent))));
    if (!hits.length) box.append(element('p',readError || (q?'일치하는 온라인 기록이 없어요.':'저장한 온라인 상품과 가격이 여기에 표시돼요.'),'hh-empty'));
    el('more-offers').hidden=hits.length<=historyLimit;
  }
  function syncProduct() {
    const d=context();
    const hits=rows.filter(r=>matchesOffer(r,d)).sort(ordered);
    for (const id of ids) {
      const s=states[id], list=hits.filter(r=>r.market===id);
      if (!s.dirty && !s.busy && !s.skipRecall) {
        const latest=(s.selected && list.find(r=>r.id===s.selected.id)) || (!s.explicit && preferredOffer(list,d));
        if (latest && (!s.selected || s.selected.version!==latest.version)) {
          fill(id,latest,s.explicit); say(id,latest.day+'에 저장한 가격이에요.');
        } else if (!latest && s.selected && !s.explicit) clearOne(id);
      }
      const state=states[id], signature=list.map(r=>r.version).join('|');
      if (state.listSignature!==signature) {
        ctl(id,'saved').replaceChildren(...list.map(r=>display(r,false)));
        state.listSignature=signature;
      }
    }
  }
  async function persist(id,data,selected,importing) {
    const s=states[id];
    if (s.busy) return;
    if (!active()) return;
    if (!data.product && !data.itemNo && !data.barcode && !data.title && !data.url) {
      say(id,'상품명이나 상품 링크를 입력하세요.',true); return;
    }
    if (!data.url && data.price==null) { say(id,'상품 링크나 판매가를 입력하세요.',true); return; }
    for (const [key,input] of Object.entries(numericFields)) {
      if (!ctl(id,input).validity.valid || data[key]!=null && (!Number.isSafeInteger(data[key]) || data[key]>(1e9) || data[key]<(key==='shipping'?0:1))) {
        say(id,'판매가·묶음 개수·배송비를 확인하세요.',true); return;
      }
    }
    if (selected?.parent) data.parent=selected.parent;
    const stamp=epoch(), version=selected?.version || '', signature=JSON.stringify([data,selected?.id,version,importing]);
    if (s.retry?.signature!==signature)
      s.retry={signature,row:{...data,id:selected?.id || s.newId,op:crypto.randomUUID()}};
    s.busy=true; enable(id);
    say(id,importing?'링크를 저장하고 상품 정보를 읽는 중이에요.':'공동 가격표에 저장하고 있어요.');
    try {
      const result=await saveOnlinePrice(s.retry.row,version,importing);
      if (!active() || stamp!==epoch()) return;
      const row=importing?result.row:result;
      commitLocal(row);
      if (states[id]===s) {
        fill(id,row,false);
        say(id,importing?result.message:selected?'수정한 가격을 공동 기록에 저장했어요.':'온라인 가격을 공동 기록에 저장했어요.');
      }
      update();
    } catch (err) {
      if (stamp!==epoch() || onAuthError(err) || states[id]!==s) return;
      const message=err.code==='INPUT' && err.message.includes('지원하지 않는') ? '구글 시트의 Apps Script를 온라인 가격 저장 버전으로 배포해 주세요.' : err.message;
      say(id,message || '저장을 확인하지 못했어요. 같은 내용으로 다시 시도하세요.',true);
    } finally {
      if (states[id]===s) { s.busy=false; enable(id); }
    }
  }
  function importLink(origin,clip) {
    if (!clip) { say(origin,'네이버 또는 쿠팡 상품 링크를 붙여넣으세요.',true); return; }
    const id=clip.market;
    showMarket(id);
    const s=states[id];
    if (s.busy) return;
    const prior=s.selected, data=bodyFor(id);
    const same=prior && (clip.url===prior.url || clip.url===prior.resolved);
    const target=prior && (s.explicit || same && prior.day===today()) ? prior : null;
    // A different option or a new day's observation must never inherit the previous quoted price.
    const freshLink=prior ? !same || !target : s.inputUrl && s.inputUrl!==clip.url;
    if (freshLink) {
      data.title=''; data.price=null; data.pieces=null; data.shipping=null;
      if (!target) data.day=today();
    }
    if (!target && (prior || s.inputUrl && s.inputUrl!==clip.url)) s.newId=crypto.randomUUID();
    s.selected=target; s.skipRecall=!target;
    data.url=clip.url;
    for (const key of ['title','price','pieces','shipping']) if (clip[key]!=null && clip[key]!=='') data[key]=clip[key];
    ctl(id,'url').value=data.url; ctl(id,'title').value=data.title; ctl(id,'day').value=data.day;
    for (const [key,field] of Object.entries(numericFields)) ctl(id,field).value=data[key]??'';
    s.inputUrl=data.url; s.dirty=true;
    update();
    void persist(id,data,target,true);
  }
  for (const id of ids) {
    for (const key of ['url','title','price','count','shipping','day','text'])
      ctl(id,key).addEventListener('input',()=>{ states[id].dirty=true; });
    ctl(id,'url').addEventListener('paste',event=>{
      const clip=clipboardListing(event.clipboardData);
      if (!clip) return;
      event.preventDefault(); importLink(id,clip);
    });
    ctl(id,'url').addEventListener('input',event=>{
      if (event.inputType==='insertFromPaste') importLink(id,sharedListing(ctl(id,'url').value));
    });
    ctl(id,'text').addEventListener('paste',event=>{
      const clip=clipboardListing(event.clipboardData);
      if (clip) { event.preventDefault(); importLink(id,clip); }
    });
    ctl(id,'read').addEventListener('click',()=>importLink(id,sharedListing(ctl(id,'url').value)));
    ctl(id,'url').addEventListener('keydown',event=>{
      if (event.key==='Enter') { event.preventDefault(); importLink(id,sharedListing(ctl(id,'url').value)); }
    });
    ctl(id,'save').addEventListener('click',()=>{
      const data=bodyFor(id);
      if (data.url && linkMarket(data.url)!==id) { say(id,'이 쇼핑몰의 상품 링크를 넣거나 ‘링크 읽기’를 누르세요.',true); return; }
      if (data.url && data.url!==states[id].inputUrl) { importLink(id,sharedListing(data.url)); return; }
      void persist(id,data,states[id].selected,false);
    });
    ctl(id,'new').addEventListener('click',()=>{clearOne(id,true); update(); ctl(id,'url').focus();});
  }
  el('history-query').addEventListener('input',()=>{historyLimit=25; renderHistory();});
  el('more-offers').addEventListener('click',()=>{historyLimit+=25; renderHistory();});
  reset();
  return {reset,syncProduct,importLink,renderHistory,markDirty(id){states[id].dirty=true;},
    replace(next,msg=''){rows=next; readError=msg;},
    clear(){rows=[]; historyLimit=25; readError=''; reset(); renderHistory();}};
}

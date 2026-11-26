// 한눈단가 · 네이버·쿠팡 온라인 가격 저장
function setupOnlineOffers() {
  const book = SpreadsheetApp.getActiveSpreadsheet(), store = store_();
  if (!book || book.getId() !== store.getProperty(PREFIX+'book')) fail_('SETUP','공동 가격표 시트에서 먼저 setup을 실행하세요.');
  locked_(function(){ openOffers_(store,true); });
}

const TAB = '공동가격이력';
const ORIGINAL_HEAD = ['상품명','판매처·매장','포장 규격','총수량','단위','가격(원)','등록 시각','저장 요청 ID'];
const HEAD = ORIGINAL_HEAD.concat(['코스트코 상품번호','바코드','가격 확인일','구매일','낱개 수']);
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const KEY = /^[0-9a-f]{64}$/;
const PREFIX = 'household.v2.';
const SESSION_PREFIX = PREFIX + 'session.';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const REMEMBERED_SESSION = 'remembered';
const FIELDS = ['product','shop','pack','quantity','unit','price','itemNo','barcode','observedOn','purchasedOn','pieceCount'];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('가격표 관리')
    .addItem('온라인 가격 저장 준비', 'setupOnlineOffers')
    .addItem('공동 비밀번호 설정/변경', 'showPasswordDialog')
    .addItem('가격 인하 이메일 켜기', 'enableDropMail')
    .addItem('가격 인하 이메일 끄기', 'disableDropMail')
    .addToUi();
}

function showPasswordDialog() {
  const html = HtmlService.createHtmlOutput(
    '<meta charset="utf-8"><style>body{font:14px sans-serif;color:#253c36}label,input,button{display:block;margin:10px 0}input{width:95%;padding:8px}button{padding:7px 16px}</style>'
    + '<form id="form"><label for="pw">가족과 공유할 비밀번호 (8자 이상)</label>'
    + '<input id="pw" type="password" minlength="8" maxlength="200" autocomplete="new-password" required>'
    + '<label for="confirm">비밀번호 확인</label><input id="confirm" type="password" autocomplete="new-password" required>'
    + '<button id="save">저장</button><p role="status" id="status"></p></form>'
    + '<script>document.getElementById("form").onsubmit=function(e){e.preventDefault();const pw=document.getElementById("pw"),msg=document.getElementById("status"),btn=document.getElementById("save");'
    + 'if(pw.value!==document.getElementById("confirm").value){msg.textContent="입력한 두 비밀번호가 다릅니다.";return;}btn.disabled=true;'
    + 'google.script.run.withSuccessHandler(function(){google.script.host.close();}).withFailureHandler(function(err){msg.textContent=err.message;btn.disabled=false;}).setHouseholdPassword(pw.value);};</script>'
  );
  SpreadsheetApp.getUi().showModalDialog(html.setWidth(370).setHeight(260), '공동 비밀번호 설정');
}

function store_() { return PropertiesService.getScriptProperties(); }

function locked_(action) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return action(); } finally { lock.releaseLock(); }
}

function hash_(value) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8));
}

function equal_(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let diff = 0;
  for (let i=0;i<left.length;i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function fail_(code, message) {
  const e = new Error(message);
  e.publicCode = code;
  throw e;
}

function setup() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  if (!book) throw new Error('가격표로 사용할 구글 시트에서 확장 프로그램 → Apps Script를 여세요.');
  locked_(function() {
    const sheet = book.getSheetByName(TAB) || book.insertSheet(TAB);
    if (sheet.getMaxColumns() < HEAD.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), HEAD.length - sheet.getMaxColumns());
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1,1,1,HEAD.length).setValues([HEAD]);
      sheet.setFrozenRows(1);
    } else {
      const titles = sheet.getRange(1,1,1,HEAD.length).getValues()[0];
      const incompatible = HEAD.some((expected,i) => titles[i] !== expected && (i < ORIGINAL_HEAD.length || titles[i] !== ''));
      if (incompatible) throw new Error('공동가격이력의 기존 1행 제목과 I~M열을 확인하세요. 기존 자료를 덮어쓰지 않았습니다.');
      const dataRows = sheet.getLastRow()-1;
      if (dataRows>0 && HEAD.slice(8).some((_,i) => titles[i+8] === '' && !sheet.getRange(2,i+9,dataRows,1).isBlank()))
        throw new Error('공동가격이력의 I~M열에서 제목 없는 기존 데이터를 찾았습니다. 해당 열을 다른 위치로 옮긴 뒤 다시 실행하세요.');
      sheet.getRange(1,9,1,HEAD.length-8).setValues([HEAD.slice(8)]);
    }
    const store = store_();
    store.setProperties({[PREFIX+'book']:book.getId(),[PREFIX+'tab']:String(sheet.getSheetId())});
    // Old invite deployments in this project used book/tab for anonymous reads.
    store.deleteProperty('book');
    store.deleteProperty('tab');
    for (const key of Object.keys(store.getProperties())) {
      if (key.startsWith('writer.sha256.')) store.deleteProperty(key);
    }
  });
}

function setHouseholdPassword(password) {
  // This function is called only by the sheet editor's modal. There is no
  // public HTML service or web RPC that exposes this management function.
  if (!SpreadsheetApp.getActiveSpreadsheet()) throw new Error('시트에서 비밀번호를 설정하세요.');
  if (typeof password !== 'string' || password.length < 8 || password.length > 200 || !password.trim())
    throw new Error('비밀번호는 8~200자로 입력하세요.');
  locked_(function() {
    const store = store_();
    const epoch = Utilities.getUuid();
    store.setProperties({[PREFIX+'epoch']:epoch,[PREFIX+'password']:hash_(epoch+'\n'+password)});
    for (const key of Object.keys(store.getProperties())) {
      if (key.startsWith(SESSION_PREFIX) || key === PREFIX+'attempts') store.deleteProperty(key);
    }
  });
}

function sessionKey_(token) {
  if (typeof token !== 'string' || !KEY.test(token)) fail_('AUTH','공동 비밀번호로 다시 로그인하세요.');
  return SESSION_PREFIX + hash_(token);
}

// Finite sessions, including earlier installations, store their expiration as a decimal timestamp.
function validSession_(value, now) {
  return value === REMEMBERED_SESSION ||
    (typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > now);
}

function login_(store, body) {
  const epoch = store.getProperty(PREFIX+'epoch');
  const digest = store.getProperty(PREFIX+'password');
  if (!epoch || !digest || !store.getProperty(PREFIX+'book')) fail_('SETUP','시트에서 setup을 실행하고 공동 비밀번호를 설정하세요.');
  const key = sessionKey_(body.token);
  const now = Date.now();
  const attempts = JSON.parse(store.getProperty(PREFIX+'attempts') || '{}');
  if (attempts.until > now && attempts.count >= 12) fail_('WAIT','비밀번호 입력 시도가 많습니다. 5분 후 다시 시도하세요.');
  if (typeof body.password !== 'string' || body.password.length > 200 || !equal_(hash_(epoch+'\n'+body.password),digest)) {
    const active = attempts.until > now;
    store.setProperty(PREFIX+'attempts',JSON.stringify({until:active ? attempts.until : now+300000, count:active ? attempts.count+1 : 1}));
    fail_('PASSWORD','공동 비밀번호를 확인하세요.');
  }
  store.deleteProperty(PREFIX+'attempts');
  const props = store.getProperties();
  for (const key of Object.keys(props)) {
    if (key.startsWith(SESSION_PREFIX) && !validSession_(props[key],now)) store.deleteProperty(key);
  }
  const expires = body.remember === true ? null : now+SESSION_MS;
  store.setProperty(key,expires === null ? REMEMBERED_SESSION : String(expires));
  return {expires};
}

function openSheet_(store) {
  const book = store.getProperty(PREFIX+'book'), tab = store.getProperty(PREFIX+'tab');
  if (!book || !tab) fail_('SETUP','가격표 운영자가 구글 시트에서 setup을 실행해야 합니다.');
  const sheet = SpreadsheetApp.openById(book).getSheetById(Number(tab));
  if (!sheet || sheet.getMaxColumns()<HEAD.length ||
      JSON.stringify(sheet.getRange(1,1,1,HEAD.length).getValues()[0]) !== JSON.stringify(HEAD))
    fail_('SETUP','공동가격이력 탭과 첫 행의 열 제목을 확인하세요.');
  return sheet;
}

function kst_(date) { return Utilities.formatDate(date,'Asia/Seoul','yyyy-MM-dd'); }

function text_(value, limit, label) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u001f\u007f]/.test(value))
    fail_('INPUT',label+' 값을 확인하세요.');
  return value.trim();
}

function day_(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail_('INPUT','날짜를 확인하세요.');
  const d = new Date(value+'T00:00:00Z');
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0,10) !== value) fail_('INPUT','날짜를 확인하세요.');
  return value;
}

function parse_(input) {
  if (!input || typeof input.submission !== 'string' || !ID.test(input.submission)) fail_('INPUT','저장 요청 번호를 확인하세요.');
  const row = {
    submission:input.submission, product:text_(input.product,140,'상품명'),
    shop:text_(input.shop,140,'매장') || '코스트코', pack:text_(input.pack,140,'포장 규격'), price:input.price,
    quantity:input.quantity === '' || input.quantity == null ? null : input.quantity,
    unit:text_(input.unit,8,'단위'), pieceCount:input.pieceCount === '' || input.pieceCount == null ? null : input.pieceCount,
    itemNo:text_(input.itemNo,32,'상품번호'), barcode:text_(input.barcode,80,'바코드'),
    observedOn:day_(input.observedOn), purchasedOn:day_(input.purchasedOn)
  };
  if (!row.product || !Number.isSafeInteger(row.price) || row.price<=0 || row.price>1e9)
    fail_('INPUT','상품명과 포장 전체 판매가(원)를 확인하세요.');
  if (row.quantity === null) row.unit = '';
  else if (!Number.isFinite(row.quantity) || row.quantity<=0 || row.quantity>1e9 ||
      !['개','매','g','kg','mL','L','m'].includes(row.unit) || (['개','매'].includes(row.unit) && !Number.isInteger(row.quantity)))
    fail_('INPUT','총수량과 단위를 확인하세요.');
  if (row.pieceCount !== null && (!Number.isInteger(row.pieceCount) || row.pieceCount<=0 || row.pieceCount>1e9))
    fail_('INPUT','낱개 수는 1 이상의 정수로 입력하세요.');
  if (row.unit === '개') {
    if (row.pieceCount !== null && row.pieceCount !== row.quantity) fail_('INPUT','총 개수와 낱개 수가 다릅니다.');
    row.pieceCount = row.quantity;
  }
  return row;
}

function rowData_(n, values) {
  const [product,shop,pack,quantity,unit,price,date,submission,itemNo,barcode,observedOn,purchasedOn,count] = values;
  if (!ID.test(String(submission)) || !(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  function sheetDay(value) { return value instanceof Date ? kst_(value) : String(value || ''); }
  return {seq:n,submission:String(submission),product:String(product),shop:String(shop),pack:String(pack),
    quantity:quantity === '' ? null : quantity,unit:String(unit),price, saved_at:date.toISOString(),
    itemNo:String(itemNo || ''),barcode:String(barcode || ''),observedOn:sheetDay(observedOn)||kst_(date),
    purchasedOn:sheetDay(purchasedOn),pieceCount:count === '' || count == null ? (unit === '개' ? quantity : null) : count};
}

function findSaved_(sheet, id) {
  const last = sheet.getLastRow();
  if (last<2) return null;
  const cell = sheet.getRange(2,8,last-1,1).createTextFinder(id).matchEntireCell(true).matchCase(true).findNext();
  return cell ? rowData_(cell.getRow(),sheet.getRange(cell.getRow(),1,1,HEAD.length).getValues()[0]) : null;
}

function append_(sheet,row) {
  const previous = findSaved_(sheet,row.submission);
  if (!row.observedOn) row.observedOn = previous ? previous.observedOn : kst_(new Date());
  if (previous) {
    if (!FIELDS.every(key => previous[key] === row[key])) fail_('DUPLICATE','같은 저장 번호로 다른 가격이 이미 등록됐습니다.');
    return previous;
  }
  const n = sheet.getLastRow()+1, now = new Date();
  if (n>sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(),100);
  const literal = s => SpreadsheetApp.newRichTextValue().setText(s).build();
  sheet.getRange(n,1,1,3).setRichTextValues([[row.product,row.shop,row.pack].map(literal)]);
  sheet.getRange(n,9,1,4).setNumberFormat('@').setRichTextValues([[row.itemNo,row.barcode,row.observedOn,row.purchasedOn].map(literal)]);
  sheet.getRange(n,13).setValue(row.pieceCount === null ? '' : row.pieceCount);
  sheet.getRange(n,7).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  SpreadsheetApp.flush();
  // The UUID commits the row. Partially written rows are ignored by all readers.
  sheet.getRange(n,4,1,5).setValues([[row.quantity === null ? '' : row.quantity,row.unit,row.price,now,row.submission]]);
  SpreadsheetApp.flush();
  return Object.assign({},row,{seq:n,saved_at:now.toISOString()});
}

function list_(sheet,before) {
  const cursor = before == null ? Number.MAX_SAFE_INTEGER : before;
  if (!Number.isSafeInteger(cursor) || cursor<2) fail_('INPUT','이전 기록 위치를 확인하세요.');
  const end = Math.min(cursor-1,sheet.getLastRow());
  const start = Math.max(2,end-19);
  const rows = end < start ? [] : sheet.getRange(start,1,end-start+1,HEAD.length).getValues()
    .map((values,i)=>rowData_(start+i,values)).filter(Boolean).reverse();
  return {rows,next:start>2 ? start : null};
}

// Apps Script V8 has no browser URL or DOM parser. Only recognized merchant
// detail/share routes can be requested, including on each redirect.
function shopTarget_(raw) {
  if (typeof raw!=='string' || raw.length>2000 || /[\s\\<>"\x00-\x1f\x7f]/.test(raw)) return null;
  const m=raw.match(/^https:\/\/([a-z0-9.-]+)(\/[^?#]*)(?:\?([^#]*))?(?:#.*)?$/i);
  if (!m || /(?:^|\/)\.{1,2}(?:\/|$)|%(?:2e|2f|5c|00|0a|0d)/i.test(m[2])) return null;
  const host=m[1].toLowerCase(), path=m[2].replace(/\/$/,''), qs=m[3]||'';
  const base='https://'+host+path;
  if (host==='naver.me' && /^\/[a-z0-9_-]+$/i.test(path) ||
      host==='shopping.naver.com' && /^\/(?:bridge\/link|link(?:\/[a-z0-9_-]+)?)$/i.test(path))
    return {market:'naver',kind:'share',url:base+(qs?'?'+qs:'')};
  if (host==='link.coupang.com' && /^\/(?:a\/[a-z0-9_-]+|re\/[a-z0-9_-]+)$/i.test(path) ||
      host==='coupa.ng' && /^\/[a-z0-9_-]+$/i.test(path))
    return {market:'coupang',kind:'share',url:base+(qs?'?'+qs:'')};
  let market,sku,origin,route,kind='detail';
  const cp=path.match(/^\/(?:vp|vm)\/products\/([1-9]\d*)$/);
  const ns=path.match(/^\/([a-z0-9_%.-]+)\/products\/([1-9]\d*)$/i);
  const win=path.match(/^\/(?:window-products\/[a-z0-9_-]+|ns\/products)\/([1-9]\d*)$/i);
  const catalog=path.match(/^\/(?:catalog|ns\/catalog)\/([1-9]\d*)$/);
  if (/^(?:www\.|m\.)?coupang\.com$/.test(host) && cp) {
    market='coupang'; sku=cp[1]; origin='www.coupang.com'; route='/vp/products/'+sku;
  } else if (/^(?:m\.)?(?:smartstore|brand)\.naver\.com$/.test(host) && ns) {
    market='naver'; sku=ns[2]; origin=host.replace(/^m\./,''); route=path;
  } else if (/^(?:m\.|search\.|msearch\.)?shopping\.naver\.com$/.test(host) && (win || catalog)) {
    market='naver'; sku=(win||catalog)[1]; origin=host; route=path; kind=catalog?'catalog':'detail';
  } else return null;
  const options={};
  for (const pair of qs.split('&')) {
    const split=pair.indexOf('=');
    if (split<=0) continue;
    const name=pair.slice(0,split), value=pair.slice(split+1);
    const isOption=market==='coupang' ? /^(?:itemId|vendorItemId)$/.test(name) : /^(?:option|variant|sku)[a-z0-9_]*$/i.test(name);
    if (!isOption) continue;
    if (Object.prototype.hasOwnProperty.call(options,name) || !/^[\w%.,+-]{1,240}$/.test(value) ||
        (market==='coupang' && !/^[1-9]\d*$/.test(value))) return null;
    options[name]=value;
  }
  const selected=Object.keys(options).sort().map(k=>k+'='+options[k]).join('&');
  return {market,sku,kind,options,route,origin,url:'https://'+origin+route+(selected?'?'+selected:'')};
}

function absoluteShopUrl_(raw,base) {
  if (typeof raw!=='string') return '';
  const value=raw.trim().replace(/&amp;/gi,'&');
  if (value.startsWith('//')) return 'https:'+value;
  if (value.startsWith('/')) return base.match(/^https:\/\/[^/]+/)[0]+value;
  if (value.startsWith('?')) return base.split('?')[0]+value;
  return value;
}

function htmlText_(value) {
  if (typeof value !== 'string') return '';
  const chars={amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '};
  return value.replace(/<[^>]*>/g,' ').replace(/&(amp|quot|apos|lt|gt|nbsp|#\d+|#x[0-9a-f]+);/gi,(all,key)=>{
    if (key[0]!=='#') return chars[key.toLowerCase()]||all;
    const n=key[1].toLowerCase()==='x' ? parseInt(key.slice(2),16) : Number(key.slice(1));
    return n>=32 && n<=0x10ffff ? String.fromCodePoint(n) : ' ';
  }).replace(/[\s\u0000-\u001f\u007f]+/g,' ').trim();
}

function attributes_(tag) {
  const obj=Object.create(null);
  const pair=/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+))/g;
  let m; while ((m=pair.exec(tag))) obj[m[1].toLowerCase()]=m[2]??m[3]??m[4];
  return obj;
}

function sameDetail_(target,raw,strict) {
  const other=shopTarget_(absoluteShopUrl_(raw,target.url));
  if (!other || target.market!==other.market || target.sku!==other.sku || target.route!==other.route ||
      target.origin!==other.origin) return false;
  return Object.keys(target.options).every(k=>other.options[k]===target.options[k] || (!strict && other.options[k]===undefined));
}

function onlyValue_(arr) {
  const vals=Array.from(new Set(arr));
  return vals.length===1 ? vals[0] : null;
}

function metadataWon_(value,minimum) {
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.0+)?$/.test(String(value??'').trim())) return null;
  const n=Number(String(value).replace(/,/g,''));
  return Number.isSafeInteger(n) && n>=minimum && n<=1e9 ? n : null;
}

function pieceHint_(title,product) {
  const explicit=product && product.numberOfItems;
  if (explicit!=null) return metadataWon_(explicit,1);
  // Keep a single labelled pack count. Unit prices, variants and multipacks
  // with several different count bases need the shopper's choice.
  if (/[~∼/+]|랜덤|선택|옵션|개당|병당|팩당/.test(title)) return null;
  const matches=Array.from(title.matchAll(/(?:^|[^\d.,])([1-9]\d{0,5})\s*(?:개입|병입|개|병|캔|봉|롤|팩|매|입)(?=$|[\s,()[\]×xX])/gu));
  if (matches.length!==1 || /\d\s*(?:개|병|팩|봉|매)?\s*[x×*]\s*\d/i.test(title)) return null;
  return Number(matches[0][1]);
}

function schemaType_(node,t) {
  return node && [].concat(node['@type']||[]).some(v=>typeof v==='string' && v.replace(/^https?:\/\/schema\.org\//i,'')===t);
}

function shippingFee_(values) {
  const rates=[].concat(values||[]);
  if (!rates.length) return null;
  return onlyValue_(rates.map(entry=>{
    if (!entry || entry.shippingConditions || entry.doesNotShip || entry.eligibleTransactionVolume ||
        entry.validForMemberTier || entry.shippingRateSettings || entry.weight || entry.orderValue) return null;
    const area=entry.shippingDestination;
    if (area && (area.addressCountry!=='KR' || Object.keys(area).some(k=>k!=='@type' && k!=='addressCountry'))) return null;
    const rate=entry.shippingRate;
    if (!rate || rate.currency!=='KRW' || Object.keys(rate).some(k=>!['@type','currency','value'].includes(k))) return null;
    return metadataWon_(rate.value,0);
  }));
}

function shopMetadata_(html,target) {
  const meta=Object.create(null), products=[];
  let canonical='';
  const head=(html.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i)||[])[1] || html.slice(0,150000);
  for (const [tag] of head.matchAll(/<(?:meta|link)\b[^>]{1,5000}>/gi)) {
    const a=attributes_(tag), k=(a.property||a.name||'').toLowerCase();
    if (k && a.content!==undefined) (meta[k]||(meta[k]=[])).push(htmlText_(a.content));
    if (a.rel==='canonical' && a.href) canonical=htmlText_(a.href);
  }
  function add(node,depth) {
    if (!node || typeof node!=='object' || depth>6 || products.length>60) return;
    if (Array.isArray(node)) { node.forEach(n=>add(n,depth+1)); return; }
    if (schemaType_(node,'Product')) products.push(node);
    if (node['@graph']) add(node['@graph'],depth+1);
    if (node.mainEntity) add(node.mainEntity,depth+1);
  }
  for (const [,attrs,json] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if ((attributes_(attrs).type||'').toLowerCase().split(';')[0]!=='application/ld+json') continue;
    try { add(JSON.parse(json),0); } catch (_) { /* Some pages contain multiple independent snippets. */ }
  }
  const pageLink=onlyValue_(meta['og:url']||[])||canonical;
  const pageMatches=pageLink ? sameDetail_(target,pageLink,false) : true;
  const optionKeys=Object.keys(target.options);
  const selectedPage=pageMatches && (!optionKeys.length || (pageLink && sameDetail_(target,pageLink,true)));
  const guessTitle=pageMatches && (pageLink || (meta['og:type']||[]).some(t=>/product/i.test(t))) ? onlyValue_(meta['og:title']||[]) : '';
  const titles=[], amounts=[], fees=[];
  let ambiguous=false;
  for(const p of products) {
    const pl=p.url || p['@id'];
    if (pl && !sameDetail_(target,pl,false)) continue;
    if (!pl && String(p.productID||p.sku||'')!==target.sku && (!pageMatches || products.length!==1)) continue;
    if (p.name) titles.push(htmlText_(p.name));
    if (p.hasVariant || p.isVariantOf && !optionKeys.length) ambiguous=true;
    const offers=[].concat(p.offers||[]);
    if (offers.length>1 && !optionKeys.length) ambiguous=true;
    for(const o of offers) {
      if (schemaType_(o,'AggregateOffer')) { ambiguous=true; continue; }
      if (!schemaType_(o,'Offer')) continue;
      if (o.url && !sameDetail_(target,o.url,false)) continue;
      const source=o.url || pl;
      const identifies=source ? sameDetail_(target,source,true) : selectedPage;
      if (!identifies || (offers.length>1 && !o.url)) continue;
      const specs=[].concat(o.priceSpecification||[]);
      const expired=['priceValidUntil','validThrough','availabilityEnds','validFrom','availabilityStarts'].some(key=>{
        if (!o[key]) return false;
        const end=key!=='validFrom' && key!=='availabilityStarts';
        const value=String(o[key]);
        const t=Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value+(end?'T23:59:59+09:00':'T00:00:00+09:00') : value);
        return !Number.isFinite(t) || (end ? t<Date.now() : t>Date.now());
      });
      if (o.priceCurrency!=='KRW' || expired || o.validForMemberTier || o.eligibleQuantity ||
          o.availability && !/(?:^|\/)(?:InStock|LimitedAvailability)$/.test(o.availability) ||
          specs.some(s=>s && (s.validForMemberTier || s.eligibleQuantity || s.eligibleTransactionVolume))) {
        ambiguous=true; continue;
      }
      amounts.push(metadataWon_(o.price,1));
      fees.push(shippingFee_(o.shippingDetails));
    }
  }
  const title=(onlyValue_(titles)||guessTitle||'').slice(0,200);
  const suggestsOptions=target.market==='naver' && /"optionUsable"\s*:\s*true|"optionCombinations"\s*:\s*\[\s*\{/.test(html);
  const result={title,pieces:null,price:null,shipping:null};
  if (!title || !pageMatches || target.kind==='catalog' || ambiguous || suggestsOptions || new Set(titles).size>1 ||
      /out.?of.?stock|sold.?out|품절/i.test((meta['product:availability']||[]).join(' '))) return result;
  if (amounts.length || selectedPage) result.pieces=pieceHint_(title,products.length===1?products[0]:null);
  const ogCurrency=onlyValue_(meta['product:price:currency']||meta['og:price:currency']||[]);
  const ogPrices=meta['product:price:amount']||meta['og:price:amount']||[];
  if (selectedPage && pageLink && ogCurrency==='KRW' && ogPrices.length)
    amounts.push(...ogPrices.map(n=>metadataWon_(n,1)));
  result.price=onlyValue_(amounts);
  if (result.price!==null) result.shipping=onlyValue_(fees);
  return result;
}

function inspectOffer_(url) {
  let target=shopTarget_(url);
  const market=target.market, seen=new Set(), deadline=Date.now()+18000;
  for(let hop=0;hop<5;hop++) {
    if (Date.now()>=deadline || seen.has(target.url)) break;
    seen.add(target.url);
    let response;
    try {
      response=UrlFetchApp.fetch(target.url,{method:'get',followRedirects:false,muteHttpExceptions:true,
        timeoutSeconds:Math.max(1,Math.min(7,Math.ceil((deadline-Date.now())/1000))),
        headers:{Accept:'text/html,application/xhtml+xml','Accept-Language':'ko-KR,ko;q=0.9'}});
    } catch (_) { break; }
    const status=response.getResponseCode(), headers=response.getAllHeaders();
    const header=k=>{const key=Object.keys(headers).find(name=>name.toLowerCase()===k); return key?String(headers[key]):'';};
    let redirect;
    if ([301,302,303,307,308].includes(status)) redirect=header('location');
    else {
      if (status!==200 || !/text\/html|application\/xhtml\+xml/i.test(header('content-type')) || Number(header('content-length'))>5e6) break;
      const html=response.getContentText();
      if (html.length>5e6) break;
      if (target.kind!=='share') return {url:target.url,fields:shopMetadata_(html,target)};
      // Some official short links use an HTML refresh instead of an HTTP redirect.
      for(const [tag] of html.slice(0,80000).matchAll(/<(?:meta|link)\b[^>]+>/gi)) {
        const a=attributes_(tag);
        const detail=a.rel==='canonical' ? a.href : ['og:url','al:web:url'].includes(a.property) ? a.content : '';
        if (detail) {
          const next=shopTarget_(absoluteShopUrl_(detail,target.url));
          if (!redirect && next && next.market===market && next.kind!=='share') redirect=next.url;
        }
        if ((a['http-equiv']||'').toLowerCase()==='refresh') {
          const match=(a.content||'').match(/^\s*\d+\s*;\s*url\s*=\s*(.+?)\s*$/i);
          if (match) { redirect=match[1]; break; }
        }
      }
    }
    const next=shopTarget_(absoluteShopUrl_(redirect,target.url));
    if (!next || next.market!==market || target.kind!=='share' && !sameDetail_(target,next.url,true)) break;
    target=next;
  }
  return null;
}

const OFFER_TAB = '온라인가격이력';
const OFFER_HEADERS = ['코스트코 상품명','쇼핑몰','온라인 상품명·옵션','상품 링크','판매가(원)','묶음 개수','배송비(원)','가격 확인일','코스트코 상품번호','바코드','코스트코 포장 규격','연결 기록 ID','온라인 기록 ID','수정 시각','저장 요청 ID','확인한 상품 주소'];
const MARKET_NAMES = {naver:'네이버',coupang:'쿠팡'};

function openOffers_(store, create) {
  const bookId = store.getProperty(PREFIX+'book');
  if (!bookId) fail_('SETUP','먼저 구글 시트에서 setup을 실행하세요.');
  const book = SpreadsheetApp.openById(bookId);
  let sheet = book.getSheetByName(OFFER_TAB);
  if (!sheet && create) sheet = book.insertSheet(OFFER_TAB);
  if (!sheet) return null;
  if (sheet.getLastRow() === 0 && create) {
    if (sheet.getMaxColumns() < OFFER_HEADERS.length)
      sheet.insertColumnsAfter(sheet.getMaxColumns(),OFFER_HEADERS.length-sheet.getMaxColumns());
    sheet.getRange(1,1,1,OFFER_HEADERS.length).setValues([OFFER_HEADERS]);
    sheet.setFrozenRows(1);
  }
  if (!sheet.getLastRow()) return null;
  if (sheet.getMaxColumns() < OFFER_HEADERS.length ||
      JSON.stringify(sheet.getRange(1,1,1,OFFER_HEADERS.length).getValues()[0]) !== JSON.stringify(OFFER_HEADERS))
    fail_('SETUP','온라인가격이력 탭의 첫 행 제목을 확인하세요.');
  return sheet;
}

function offerFromCells_(cells) {
  const [product,shop,title,url,price,pieces,shipping,day,itemNo,barcode,pack,parent,id,updated,op,resolved] = cells;
  if (!ID.test(String(id))) return null;
  const market = shop === '쿠팡' ? 'coupang' : shop === '네이버' ? 'naver' : '';
  if (!market) return null;
  const row = {id:String(id),market,product:String(product),title:String(title||''),url:String(url||''),
    price:price===''?null:price,pieces:pieces===''?null:pieces,shipping:shipping===''?null:shipping,
    day:day instanceof Date?kst_(day):String(day),itemNo:String(itemNo ?? ''),barcode:String(barcode ?? ''),
    pack:String(pack||''),parent:String(parent||''),updated:updated instanceof Date?updated.toISOString():String(updated),
    op:String(op||''),resolved:String(resolved||'')};
  row.version = hash_(JSON.stringify(row));
  return row;
}

function offerAt_(sheet, pos) {
  return offerFromCells_(sheet.getRange(pos,1,1,OFFER_HEADERS.length).getValues()[0]);
}

function findOffer_(sheet,id) {
  const last=sheet.getLastRow();
  if (last < 2) return null;
  const cell=sheet.getRange(2,13,last-1,1).createTextFinder(id).matchEntireCell(true).matchCase(true).findNext();
  if (!cell) return null;
  const pos=cell.getRow();
  return {pos,row:offerAt_(sheet,pos)};
}

function listOffers_(store,before) {
  const sheet=openOffers_(store,false), last=sheet ? sheet.getLastRow() : 0;
  const cursor = before == null ? last+1 : before;
  if (!Number.isSafeInteger(cursor) || cursor<1) fail_('INPUT','온라인 기록 위치를 확인하세요.');
  const end=Math.min(last,cursor-1), start=Math.max(2,end-9);
  const rows=end<start ? [] : sheet.getRange(start,1,end-start+1,OFFER_HEADERS.length).getValues()
    .map(offerFromCells_).filter(Boolean).reverse();
  return {rows,next:start>2?start:null};
}

function offerNumber_(value,min,label) {
  if (value == null || value === '') return null;
  if (!Number.isSafeInteger(value) || value<min || value>1e9) fail_('INPUT',label+' 값을 확인하세요.');
  return value;
}

function readOfferInput_(input) {
  if (!input || !ID.test(input.id) || !ID.test(input.op)) fail_('INPUT','온라인 기록 번호를 확인하세요.');
  const target=input.url ? shopTarget_(input.url) : null;
  if (input.url && !target) fail_('INPUT','네이버 또는 쿠팡 상품의 상세 주소나 공유 링크를 넣어 주세요.');
  const market=target ? target.market : input.market;
  if (market!=='naver' && market!=='coupang') fail_('INPUT','쇼핑몰을 확인하세요.');
  const row={id:input.id,op:input.op,market,product:text_(input.product,140,'코스트코 상품명'),
    parent:text_(input.parent,36,'연결 기록'),itemNo:text_(input.itemNo,32,'상품번호'),barcode:text_(input.barcode,80,'바코드'),
    pack:text_(input.pack,140,'규격'),title:text_(input.title,200,'온라인 상품명'),url:target ? target.url : '',
    resolved:'',day:day_(input.day)||kst_(new Date()),price:offerNumber_(input.price,1,'판매가'),
    pieces:offerNumber_(input.pieces,1,'묶음 개수'),shipping:offerNumber_(input.shipping,0,'배송비')};
  if (row.parent && !ID.test(row.parent)) fail_('INPUT','연결 기록 번호를 확인하세요.');
  if (!row.url && !row.product && !row.title && !row.itemNo && !row.barcode) fail_('INPUT','상품명이나 상품 링크를 입력하세요.');
  if (!row.url && row.price===null) fail_('INPUT','저장할 상품 링크나 판매가를 입력하세요.');
  return row;
}

function sheetLiteral_(s) { return typeof s === 'string' && /^[=']/.test(s) ? "'"+s : s; }

function writeOffer_(sheet,pos,row) {
  if (pos>sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(),100);
  const blank = value => value == null ? '' : value;
  const ts=new Date();
  const cells=[row.product,MARKET_NAMES[row.market],row.title,row.url,blank(row.price),blank(row.pieces),blank(row.shipping),
    row.day,row.itemNo,row.barcode,row.pack,row.parent,row.id,ts,row.op,row.resolved];
  sheet.getRange(pos,1,1,4).setNumberFormat('@');
  sheet.getRange(pos,8,1,6).setNumberFormat('@');
  sheet.getRange(pos,14).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.getRange(pos,15,1,2).setNumberFormat('@');
  sheet.getRange(pos,1,1,cells.length).setValues([cells.map(sheetLiteral_)]);
  SpreadsheetApp.flush();
  return offerAt_(sheet,pos);
}

function sameOfferProduct_(a,b) {
  if (a.itemNo && b.itemNo && a.itemNo!==b.itemNo || a.barcode && b.barcode && a.barcode!==b.barcode) return false;
  if (a.parent && a.parent===b.parent || a.itemNo && a.itemNo===b.itemNo || a.barcode && a.barcode===b.barcode) return true;
  const norm=s=>s.normalize('NFKC').toLowerCase().replace(/\s+/g,'');
  if (!a.product && !b.product && !a.itemNo && !b.itemNo && !a.barcode && !b.barcode) return true;
  return !!a.product && norm(a.product)===norm(b.product) && norm(a.pack)===norm(b.pack);
}

function sameDayOffer_(sheet,row) {
  const last=sheet.getLastRow();
  if (last<2 || !row.url) return null;
  for (const col of [4,16]) {
    const hits=sheet.getRange(2,col,last-1,1).createTextFinder(row.url).matchEntireCell(true).matchCase(true).findAll();
    for (const cell of hits) {
      const old=offerAt_(sheet,cell.getRow());
      if (old && old.market===row.market && old.day===row.day && sameOfferProduct_(old,row)) return old;
    }
  }
  return null;
}

function storeOffer_(store,body,importing) {
  const row=readOfferInput_(body.row), sheet=openOffers_(store,true);
  if (importing && row.title && row.pieces==null) row.pieces=pieceHint_(row.title,null);
  if (importing && !row.url) fail_('INPUT','상품 링크를 입력하세요.');
  const found=findOffer_(sheet,row.id);
  if (found) {
    if (found.row.op===row.op) return found.row;
    if (body.version!==found.row.version) fail_('CONFLICT','다른 기기에서 수정했어요. 공동 기록을 새로고침하고 다시 열어 주세요.');
    if (found.row.market!==row.market) fail_('INPUT','다른 쇼핑몰은 새 가격으로 등록하세요.');
    if (row.url===found.row.url) row.resolved=found.row.resolved;
  } else {
    if (body.version) fail_('CONFLICT','수정할 기록이 없어졌어요. 공동 기록을 새로고침하세요.');
    if (importing) {
      const existing=sameDayOffer_(sheet,row);
      if (existing) {
        // A richer share from the same day may complete an earlier link-only record.
        let changed=false;
        for (const key of ['title','price','pieces','shipping']) {
          if ((existing[key]==='' || existing[key]==null) && row[key]!=null && row[key]!=='') {
            existing[key]=row[key]; changed=true;
          }
        }
        if (!changed) return existing;
        existing.op=row.op;
        return writeOffer_(sheet,findOffer_(sheet,existing.id).pos,existing);
      }
    }
  }
  return writeOffer_(sheet,found ? found.pos : sheet.getLastRow()+1,row);
}

function updateCostco_(store,body) {
  const sheet=openSheet_(store), row=parse_(body.row), old=findSaved_(sheet,row.submission);
  if (!old) fail_('CONFLICT','이 기록을 찾지 못했어요. 공동 기록을 새로고침하세요.');
  if (FIELDS.every(key=>old[key]===row[key])) return old;
  if (!body.original || body.original.submission!==row.submission || !FIELDS.every(key=>old[key]===body.original[key]))
    fail_('CONFLICT','다른 기기에서 수정했어요. 공동 기록을 새로고침하고 다시 열어 주세요.');
  const n=old.seq;
  const values=[row.product,row.shop,row.pack,row.quantity??'',row.unit,row.price,new Date(old.saved_at),row.submission,
    row.itemNo,row.barcode,row.observedOn,row.purchasedOn,row.pieceCount??''];
  sheet.getRange(n,1,1,3).setNumberFormat('@');
  sheet.getRange(n,9,1,4).setNumberFormat('@');
  sheet.getRange(n,1,1,values.length).setValues([values.map(sheetLiteral_)]);
  SpreadsheetApp.flush();
  return rowData_(n,sheet.getRange(n,1,1,HEAD.length).getValues()[0]);
}

function requireSession_(store, body) {
  const key = sessionKey_(body.token);
  const value = store.getProperty(key);
  if (!validSession_(value,Date.now())) {
    if (value !== null) store.deleteProperty(key);
    fail_('AUTH','로그인이 만료됐습니다. 공동 비밀번호를 다시 입력하세요.');
  }
  return key;
}

function dispatch_(store, body) {
  if (body.action === 'login') return login_(store,body);
  const key = requireSession_(store,body);
  if (body.action === 'logout') { store.deleteProperty(key); return {}; }
  if (body.action === 'list') {
    const page=list_(openSheet_(store),body.before);
    if (body.includeOffers === true && body.before == null) {
      try { page.offers=listOffers_(store,null); }
      catch (err) { page.offersError=err.publicCode ? err.message : '온라인 기록을 불러오지 못했어요.'; }
    }
    return page;
  }
  if (body.action === 'listOffers') return listOffers_(store,body.before);
  if (body.action === 'saveOffer') return storeOffer_(store,body,false);
  if (body.action === 'updatePrice') return updateCostco_(store,body);
  if (body.action === 'save') return append_(openSheet_(store),parse_(body.row));
  fail_('INPUT','지원하지 않는 요청입니다.');
}

function output_(value, callback) {
  const json = JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  if (/^hnReply_[a-f0-9]{32}$/.test(callback || ''))
    return ContentService.createTextOutput(callback+'('+json+');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function reply_(body, action) {
  const store=store_(), cache=CacheService.getScriptCache();
  let reply;
  try { reply={ok:true,data:action(store)}; }
  catch (err) { reply={ok:false,code:err.publicCode || 'SERVER',message:err.publicCode ? err.message : '시트에 접근하지 못했어요. 배포 권한을 확인하고 다시 시도하세요.'}; }
  cache.put('reply:'+hash_(body.ticket),JSON.stringify({epoch:store.getProperty(PREFIX+'epoch'),reply}),90);
  return output_({accepted:true});
}

function importOfferPost_(body) {
  let initial, info;
  try {
    // Commit the link first. Other family members can use the sheet while the merchant responds.
    initial=locked_(function() {
      const store=store_();
      requireSession_(store,body);
      return storeOffer_(store,body,true);
    });
    try { info=inspectOffer_(initial.url); } catch (_) { info=null; }
  } catch (err) { return locked_(()=>reply_(body,()=>{throw err;})); }
  return locked_(()=>reply_(body,store=>{
    requireSession_(store,body);
    const sheet=openOffers_(store,true), found=findOffer_(sheet,initial.id);
    if (!found) fail_('CONFLICT','저장 중에 기록이 삭제됐어요. 공동 기록을 새로고침하세요.');
    const row=found.row;
    if (row.version!==initial.version) return {row,message:'다른 곳에서 수정한 최신 값을 표시했어요.'};
    let changed=false;
    if (info) {
      for (const field of ['title','price','pieces','shipping']) {
        const value=info.fields[field];
        if ((row[field]==='' || row[field]==null) && value!=null && value!=='') {
          row[field]=value; changed=true;
        }
      }
      if (info.url!==row.resolved) { row.resolved=info.url; changed=true; }
    }
    const saved=changed ? writeOffer_(sheet,found.pos,row) : row;
    const missing=[['price','판매가'],['pieces','묶음 개수'],['shipping','배송비']].filter(([key])=>saved[key]==null).map(([,name])=>name);
    const message=missing.length ? '공동 기록에 링크를 저장했어요. '+missing.join('·')+'를 확인해 입력하세요.' : '공동 기록에 상품 링크와 가격을 저장했어요.';
    return {row:saved,message};
  }));
}

function doPost(e) {
  if (!e || !e.postData || !e.postData.contents || e.postData.contents.length>16384) return output_({ok:false});
  let body;
  try { body=JSON.parse(e.postData.contents); } catch (_) { return output_({ok:false}); }
  if (!body || typeof body.ticket!=='string' || !KEY.test(body.ticket)) return output_({ok:false});
  if (body.action==='importOffer') return importOfferPost_(body);
  return locked_(()=>reply_(body,store=>dispatch_(store,body)));
}

function doGet(e) {
  const args=(e && e.parameter) || {};
  if (args.auth === 'household-v2') return output_({service:'household-v2',loginRequired:true},args.callback);
  if (!KEY.test(args.ticket || '') || !/^hnReply_[a-f0-9]{32}$/.test(args.callback || ''))
    return output_({service:'household-v2',loginRequired:true});
  return locked_(function() {
    const cache = CacheService.getScriptCache(), key = 'reply:'+hash_(args.ticket);
    const item = cache.get(key);
    if (!item) return output_({pending:true},args.callback);
    cache.remove(key);
    const entry = JSON.parse(item);
    if (entry.epoch !== store_().getProperty(PREFIX+'epoch'))
      return output_({ok:false,code:'AUTH',message:'공동 비밀번호가 변경됐습니다. 다시 로그인하세요.'},args.callback);
    return output_(entry.reply,args.callback);
  });
}

// === Generated price-drop mail: scripts/build-price-mail.mjs ===

var householdMailPricing_ = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // <stdin>
  var stdin_exports = {};
  __export(stdin_exports, {
    priceMatchAlerts: () => priceMatchAlerts
  });

  // docs/barcode.js
  function normalizeGtin(raw) {
    if (typeof raw !== "string") return "";
    const digits = raw.trim().replace(/[ -]/g, "");
    if (!/^(?:\d{8}|\d{12,14})$/.test(digits) || /^0+$/.test(digits)) return "";
    let sum = 0;
    let weight = 3;
    for (let i = digits.length - 2; i >= 0; i--) {
      sum += Number(digits[i]) * weight;
      weight = 4 - weight;
    }
    return (10 - sum % 10) % 10 === Number(digits[digits.length - 1]) ? digits : "";
  }
  var L_WIDTHS = ["3211", "2221", "2122", "1411", "1132", "1231", "1114", "1312", "1213", "3112"];
  var leftPatterns = L_WIDTHS.map((widths, digit) => ({ widths: Array.from(widths, Number), digit, parity: "L" }));
  var allPatterns = [...leftPatterns, ...leftPatterns.map(({ widths, digit }) => ({ widths: [...widths].reverse(), digit, parity: "G" }))];

  // docs/household-prices.js
  function koreanDay(time) {
    return new Date(time + 9 * 60 * 60 * 1e3).toISOString().slice(0, 10);
  }
  function text(value) {
    return String(value ?? "").normalize("NFKC").trim().toLowerCase();
  }
  function number(value) {
    if (typeof value !== "string" && typeof value !== "number" || String(value).trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  function count(value) {
    const n = number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  }
  function itemNumber(row) {
    return text(row.itemNo).replace(/^#\s*/, "");
  }
  function barcode(row) {
    const valid = normalizeGtin(String(row.barcode ?? ""));
    return valid ? valid.padStart(14, "0") : "";
  }
  function identity(left, right) {
    const leftItem = itemNumber(left), rightItem = itemNumber(right);
    const leftCode = barcode(left), rightCode = barcode(right);
    if (leftItem && rightItem && leftItem !== rightItem) return "conflict";
    if (leftCode && rightCode && leftCode !== rightCode) return "conflict";
    if (leftCode && leftCode === rightCode || leftItem && leftItem === rightItem) return "identified";
    return "unknown";
  }
  function day(value) {
    const s = String(value ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
    const n = Date.parse(s + "T00:00:00Z");
    return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === s ? s : "";
  }
  function stamp(row) {
    const time = Date.parse(row.saved_at ?? "");
    const registeredDay = Number.isFinite(time) ? koreanDay(time) : "";
    const eventDay = day(row.purchasedOn || row.observedOn || registeredDay);
    return { day: eventDay, time: registeredDay === eventDay && eventDay ? time : null };
  }
  function newestFirst(left, right) {
    const a = stamp(left), b = stamp(right);
    return b.day.localeCompare(a.day) || (b.time ?? 0) - (a.time ?? 0) || (number(right.seq) ?? 0) - (number(left.seq) ?? 0);
  }
  function after(later, earlier) {
    if (!later.day || !earlier.day) return false;
    if (later.day !== earlier.day) return later.day > earlier.day;
    return later.time !== null && earlier.time !== null && later.time > earlier.time;
  }
  function sameEntry(a, b) {
    if (a === b) return true;
    if (a.submission && b.submission) return a.submission === b.submission;
    return a.seq != null && a.seq === b.seq && Boolean(a.saved_at) && a.saved_at === b.saved_at;
  }
  function storeName(shop) {
    return text(shop).replace(/\s+/g, "").replace(/^(?:코스트코(?:코리아|홀세일)?|costco(?:wholesale)?)/, "").replace(/점$/, "");
  }
  function namedStore(shop) {
    const name = storeName(shop);
    return name && !["매장", "매장명", "지점", "오프라인", "온라인", "온라인몰", "본", "미상", "기타"].includes(name) && !/온라인|쇼핑몰|이마트|트레이더스|쿠팡|네이버|홈플러스|롯데마트/.test(name);
  }
  function pack(row) {
    return text(row.pack).replace(/\s+/g, "").replace(/[×✕*]/g, "x");
  }
  function quantity(row) {
    const amount = number(row.quantity);
    const unit = text(row.unit);
    if (!(amount > 0)) return null;
    switch (unit) {
      case "kg":
        return ["g", amount * 1e3];
      case "l":
        return ["ml", amount * 1e3];
      case "g":
      case "ml":
      case "개":
      case "매":
      case "m":
        return [unit, amount];
      default:
        return null;
    }
  }
  function comparable(a, b) {
    if (!text(a.shop) || !text(b.shop) || storeName(a.shop) !== storeName(b.shop)) return false;
    const ap = pack(a), bp = pack(b);
    if (ap && bp && ap !== bp) return false;
    const qa = quantity(a), qb = quantity(b);
    if (qa && qb && (qa[0] !== qb[0] || Math.abs(qa[1] - qb[1]) > 1e-6)) return false;
    const pa = count(a.pieceCount), pb = count(b.pieceCount);
    if (pa !== null && pb !== null && pa !== pb) return false;
    if (ap && ap === bp) return true;
    return Boolean(barcode(a) && barcode(a) === barcode(b) && (qa && qb || pa !== null && pb !== null));
  }
  function identityKeys(row) {
    const keys = [];
    const item = itemNumber(row), gtin = barcode(row);
    if (item) keys.push("item:" + item);
    if (gtin) keys.push("gtin:" + gtin);
    return keys;
  }
  function priceMatchAlerts(rows) {
    const asOf = koreanDay(Date.now());
    const byId = /* @__PURE__ */ new Map();
    const indexed = [];
    const purchases = [];
    const seen = /* @__PURE__ */ new Set();
    for (const row of rows) {
      if (row.submission && seen.has(row.submission)) continue;
      if (row.submission) seen.add(row.submission);
      const date = stamp(row);
      if (!(number(row.price) > 0) || !date.day || date.day > asOf || !namedStore(row.shop)) continue;
      const keys = identityKeys(row);
      if (!keys.length || text(row.barcode) && !barcode(row)) continue;
      const candidate = { row, date, keys: keys.map((key) => storeName(row.shop) + "|" + key) };
      indexed.push(candidate);
      if (day(row.purchasedOn)) purchases.push(candidate);
    }
    const byDate = (a, b) => b.date.day.localeCompare(a.date.day) || (b.date.time ?? 0) - (a.date.time ?? 0) || (number(b.row.seq) ?? 0) - (number(a.row.seq) ?? 0);
    for (const candidate of indexed.sort(byDate)) {
      for (const key of candidate.keys) {
        if (!byId.has(key)) byId.set(key, []);
        byId.get(key).push(candidate);
      }
    }
    const alerts = [];
    for (const { row: purchase, date: bought, keys } of purchases) {
      const latestDay = /* @__PURE__ */ new Set();
      let latestDate = "";
      for (const key of keys) {
        for (const option of byId.get(key)) {
          const { row, date } = option;
          if (date.day < latestDate || date.day < bought.day) break;
          if (sameEntry(row, purchase) || !after(date, bought) || identity(row, purchase) !== "identified" || !comparable(row, purchase)) continue;
          if (date.day > latestDate) {
            latestDate = date.day;
            latestDay.clear();
          }
          latestDay.add(option);
        }
      }
      if (!latestDay.size) continue;
      const later = [...latestDay].sort(byDate);
      const latest = later[0];
      const uncertain = later.some(({ date, row }) => date.day === latest.date.day && (date.time === null || date.time === latest.date.time) && number(row.price) !== number(latest.row.price));
      if (uncertain) continue;
      const saving = number(purchase.price) - number(latest.row.price);
      if (saving <= 0) continue;
      const purchaseId = purchase.submission || [keys[0], purchase.seq, purchase.saved_at, purchase.purchasedOn, purchase.price].join("|");
      alerts.push({ key: purchaseId + ":" + latest.row.price, purchase, offer: latest.row, saving });
    }
    return alerts.sort((a, b) => newestFirst(a.offer, b.offer) || newestFirst(a.purchase, b.purchase));
  }
  return __toCommonJS(stdin_exports);
})();

// The sheet owner explicitly enables this trigger in the spreadsheet menu.
// No public web operation invokes the mail feature.
const MAIL_CONFIG = PREFIX + 'dropMail';
const MAIL_LOW = PREFIX + 'dropMail.low.';
const MAIL_HANDLER = 'checkHouseholdPriceDrops';

function mailAddress_(user) {
  return user ? String(user.getEmail() || '').trim().toLowerCase() : '';
}

function ownerForMail_(book) {
  const owner = book && mailAddress_(book.getOwner());
  const current = mailAddress_(Session.getEffectiveUser());
  if (!owner || current !== owner)
    throw new Error('이 메뉴는 스프레드시트를 소유한 구글 계정에서 사용할 수 있어요.');
  return owner;
}

function allMailRows_(sheet) {
  const rows = [];
  const last = sheet.getLastRow();
  for (let start = 2; start <= last; start += 500) {
    const values = sheet.getRange(start, 1, Math.min(500, last - start + 1), HEAD.length).getValues();
    for (let i = 0; i < values.length; i++) {
      const row = rowData_(start + i, values[i]);
      if (row) rows.push(row);
    }
  }
  return rows;
}

function mailTriggers_() {
  return ScriptApp.getProjectTriggers().filter(trigger => trigger.getHandlerFunction() === MAIL_HANDLER);
}

function mailPriceMarks_(alerts) {
  const values = {};
  for (const alert of alerts) {
    if (alert.purchase.submission) values[MAIL_LOW + alert.purchase.submission] = String(alert.offer.price);
  }
  return values;
}

function clearMailMarks_(store) {
  for (const key of Object.keys(store.getProperties())) {
    if (key.startsWith(MAIL_LOW)) store.deleteProperty(key);
  }
}

function enableDropMail() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  const email = ownerForMail_(book);
  const ui = SpreadsheetApp.getUi();
  const ok = ui.alert('가격 인하 이메일 켜기',
    '매시간 가족이 등록한 가격을 확인하고 새 인하 기록이 있으면 ' + email + ' 주소로 알려드려요. 켤까요?',
    ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;
  MailApp.getRemainingDailyQuota();
  locked_(function () {
    const store = store_();
    const sheet = openSheet_(store);
    if (sheet.getParent().getId() !== book.getId()) throw new Error('가격표 시트에서 setup을 실행한 뒤 다시 켜 주세요.');
    const raw = store.getProperty(MAIL_CONFIG);
    const existing = raw ? JSON.parse(raw) : null;
    const ownedTriggers = mailTriggers_();
    const matching = existing && ownedTriggers.find(t => t.getUniqueId() === existing.triggerId);
    if (matching && existing.email === email) return;
    const previousOwner = !existing || existing.email !== email;
    const config = {email, since: previousOwner ? Date.now() : existing.since};
    if (previousOwner) {
      clearMailMarks_(store);
      // Existing candidates remain visible in the site; mail starts at enrollment.
      const baseline = mailPriceMarks_(householdMailPricing_.priceMatchAlerts(allMailRows_(sheet)));
      if (Object.keys(baseline).length) store.setProperties(baseline);
    }
    const trigger = ownedTriggers[0] || ScriptApp.newTrigger(MAIL_HANDLER).timeBased().everyHours(1).create();
    config.triggerId = trigger.getUniqueId();
    store.setProperty(MAIL_CONFIG, JSON.stringify(config));
    for (const other of ownedTriggers.slice(1)) ScriptApp.deleteTrigger(other);
  });
  ui.alert('가격 인하 이메일을 켰어요.');
}

function disableDropMail() {
  ownerForMail_(SpreadsheetApp.getActiveSpreadsheet());
  locked_(function () {
    const store = store_();
    store.deleteProperty(MAIL_CONFIG);
    for (const trigger of mailTriggers_()) ScriptApp.deleteTrigger(trigger);
    clearMailMarks_(store);
  });
  SpreadsheetApp.getUi().alert('가격 인하 이메일을 껐어요.');
}

function checkHouseholdPriceDrops(event) {
  if (!event || !event.triggerUid) return;
  locked_(function () {
    const store = store_();
    const settings = store.getProperty(MAIL_CONFIG);
    if (!settings) return;
    const config = JSON.parse(settings);
    if (String(event.triggerUid) !== config.triggerId || mailAddress_(Session.getEffectiveUser()) !== config.email) return;
    const sheet = openSheet_(store);
    const book = sheet.getParent();
    if (mailAddress_(book.getOwner()) !== config.email) return;
    const known = store.getProperties();
    const rows = allMailRows_(sheet);
    const candidates = householdMailPricing_.priceMatchAlerts(rows).filter(alert => {
      const previous = known[MAIL_LOW + alert.purchase.submission];
      return alert.purchase.submission && Date.parse(alert.offer.saved_at) > config.since &&
        (previous == null || Number(alert.offer.price) < Number(previous));
    }).slice(0, 20);
    if (!candidates.length || MailApp.getRemainingDailyQuota() < 1) return;

    const lines = ['공동 가격표에 구매가보다 낮은 가격이 등록됐어요.', ''];
    for (const {purchase, offer, saving} of candidates) {
      lines.push(purchase.product + ' · ' + purchase.shop + ' · ' + purchase.pack);
      lines.push('구매 ' + purchase.purchasedOn + '  ' + purchase.price.toLocaleString('ko-KR') + '원');
      lines.push('가격 확인 ' + (offer.purchasedOn || offer.observedOn) + '  ' + offer.price.toLocaleString('ko-KR') +
        '원 · 차액 ' + saving.toLocaleString('ko-KR') + '원', '');
    }
    lines.push('영수증을 준비해 구매 매장에 가격 조정 가능 여부를 문의하세요.', book.getUrl());
    // MailApp provides no idempotency key. Reserve each new low before sending:
    // a repeated trigger must not send a second copy following an uncertain delivery.
    store.setProperties(mailPriceMarks_(candidates));
    MailApp.sendEmail(config.email, '한눈단가 · 구매가보다 낮아진 가격 ' + candidates.length + '건', lines.join('\n'));
  });
}

// === End of generated price-drop mail ===


/**
 * Shared, dependency-free price-history rules for the browser and the Worker.
 *
 * All stored dates are ISO datetimes. A source represents one exact pack/option
 * sold at one location or product URL. Changing that identity requires a new ID.
 * Observations are append-only; a deletedAt tombstone is the only permitted edit.
 * No function in this module fetches a price or treats an OCR match as confirmed.
 *
 * historySeries returns chronological, non-deleted observation objects with
 * {total, unitPrice, productUnitPrice, issues} appended. sourceSummary returns
 * {latest, previous, lowest, changePercent, targetReached, count}; latest and
 * previous include incomplete observations, so an older valid price is never
 * presented as a newly confirmed price. A null unitPrice cannot trigger a target.
 */

export const TRACKING_UNITS = ['개', '100g', '100mL', 'm'];
export const TRACKING_LIMITS = Object.freeze({items:100, sources:400, observations:20000});
export const DELIVERY_TYPES = Object.freeze(['로켓배송', '로켓프레시', '판매자로켓', '일반배송', '미확인']);
const PLATFORMS = ['코스트코', '네이버', '쿠팡'];
const METHODS = ['photo', 'manual', 'migration'];
const STOCK = ['있음', '품절', '미확인'];
const MAX_NUMBER = 1e12;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const factor = unit => unit === '100g' || unit === '100mL' ? 100 : 1;
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_NUMBER;
const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_NUMBER;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };

export function emptyState() {
  return {schemaVersion:2, items:[], sources:[], observations:[]};
}

function text(value, label, max=500, required=false) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || value.length > max) fail(`${label} 형식 또는 길이를 확인해 주세요.`);
  const result = value.trim();
  if (required && !result) fail(`${label}을(를) 입력해 주세요.`);
  return result;
}

function id(value, label='기록 ID') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9가-힣_-]{1,160}$/.test(value)) fail(`${label} 형식을 확인해 주세요.`);
  return value;
}

function numeric(value, label, {nullable=false, zero=false}={}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (!(zero ? nonnegative(value) : positive(value))) fail(`${label}에는 ${zero?'0 이상의':'0보다 큰'} 유한한 숫자를 입력해 주세요.`);
  return value;
}

function validIso(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  if (!match || +match[2] > 23 || +match[3] > 59 || +match[4] > 59) return false;
  const day = Date.parse(match[1]+'T00:00:00Z');
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0,10) !== match[1]) return false;
  if (match[5] !== 'Z') {
    const [hours,minutes] = match[5].slice(1).split(':').map(Number);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return false;
  }
  return Number.isFinite(Date.parse(value));
}

function date(value, label, now=Date.now()) {
  if (!validIso(value)) fail(`${label}에 올바른 날짜와 시각을 입력해 주세요.`);
  if (Date.parse(value) > now + FUTURE_TOLERANCE_MS) fail(`${label}은(는) 미래일 수 없습니다.`);
  return new Date(value).toISOString();
}

function externalUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048) return '';
  try {
    const url = new URL(value);
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.href;
  } catch { return ''; }
}

/** Only exact SmartStore/Brand Store product pages; search/catalog/redirect links are not identities. */
export function canonicalNaverUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    const hosts = new Map([
      ['smartstore.naver.com','smartstore.naver.com'],
      ['m.smartstore.naver.com','smartstore.naver.com'],
      ['brand.naver.com','brand.naver.com'],
      ['m.brand.naver.com','brand.naver.com']
    ]);
    const host = hosts.get(url.hostname);
    const match = url.pathname.match(/^\/([^/]+)\/products\/([1-9]\d*)\/?$/);
    if (!host || !match) return '';
    const store = decodeURIComponent(match[1]);
    if (!store || /[\s/\\?#\u0000-\u001f\u007f]/u.test(store) || ['.','..'].includes(store)) return '';
    return `https://${host}/${encodeURIComponent(store)}/products/${match[2]}`;
  } catch { return ''; }
}

/** Exact Coupang product/option URLs; shortlinks and search pages are not identities. */
export function canonicalCoupangUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    if (!['www.coupang.com', 'm.coupang.com', 'coupang.com'].includes(url.hostname)) return '';
    const match = url.pathname.match(/^\/(?:vp|vm)\/products\/([1-9]\d*)\/?$/);
    if (!match) return '';
    const variants = new URLSearchParams();
    for (const key of ['itemId', 'vendorItemId']) {
      const values = url.searchParams.getAll(key);
      if (values.length > 1 || values.length === 1 && !/^[1-9]\d*$/.test(values[0])) return '';
      if (values.length) variants.set(key, values[0]);
    }
    const query = variants.toString();
    return `https://www.coupang.com/vp/products/${match[1]}${query ? '?'+query : ''}`;
  } catch { return ''; }
}

/** Lower is preferred. Unknown types are retained in history but never recommended. */
export function deliveryRank(value) {
  const delivery = typeof value === 'string' ? value : value?.delivery;
  return delivery === '로켓배송' || delivery === '로켓프레시' ? 1
    : delivery === '판매자로켓' ? 2 : delivery === '일반배송' ? 3 : 4;
}

function normalizedDelivery(value, platform) {
  if (platform !== '쿠팡') return '해당없음';
  if (value === undefined || value === null || value === '') return '미확인';
  if (!DELIVERY_TYPES.includes(value)) fail('쿠팡 배송 유형을 확인해 주세요.');
  return value;
}

const exactText = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('ko-KR');

export function sourceIdentity(source) {
  return JSON.stringify([
    source.itemId,
    source.platform,
    source.platform === '네이버' ? canonicalNaverUrl(source.url)
      : source.platform === '쿠팡' ? canonicalCoupangUrl(source.url) : externalUrl(source.url),
    exactText(source.seller),
    exactText(source.store),
    exactText(source.variant),
    source.quantity,
    source.unit
  ]);
}

export function normalizeName(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('ko-KR').replace(/[^\p{L}\p{N}]/gu,'');
}

function bigrams(value) {
  if (value.length < 2) return new Set(value ? [value] : []);
  const result = new Set();
  for (let i=0; i<value.length-1; i++) result.add(value.slice(i,i+2));
  return result;
}

/** Ranked review candidates, never an automatic assignment. Returns [{item, score, reason}]. */
export function candidateItems(items, draft={}) {
  const name = normalizeName(draft.name), sku = normalizeName(draft.sku);
  if (!name && !sku) return [];
  const tokens = bigrams(name);
  return items.filter(item=>!item.archived).map(item=>{
    const existing = normalizeName(item.name);
    if (sku && normalizeName(item.sku) === sku) return {item,score:1,reason:'상품번호 일치 · 규격 확인 필요'};
    if (name && existing === name) return {item,score:1,reason:'상품명 일치 · 규격 확인 필요'};
    const other = bigrams(existing);
    const overlap = [...tokens].filter(token=>other.has(token)).length;
    const score = tokens.size+other.size ? 2*overlap/(tokens.size+other.size) : 0;
    return {item,score,reason:'비슷한 상품명 · 직접 선택 필요'};
  }).filter(candidate=>candidate.score>=0.42)
    .sort((a,b)=>b.score-a.score || String(a.item.id).localeCompare(String(b.item.id)))
    .slice(0,5);
}

export function observationMetrics(observation) {
  const issues=[];
  if (!positive(observation.price)) issues.push('상품가격 확인');
  if (!positive(observation.quantity)) issues.push('총량 확인');
  if (!TRACKING_UNITS.includes(observation.unit)) issues.push('비교단위 확인');
  if (!nonnegative(observation.shipping)) issues.push('배송비 미확인');
  const discount = observation.discount ?? 0;
  if (!nonnegative(discount) || (positive(observation.price) && discount >= observation.price)) issues.push('할인금액 확인');
  if (observation.stock !== '있음') issues.push(observation.stock === '품절' ? '품절' : '재고 미확인');
  if (observation.deletedAt) issues.push('삭제한 기록');
  const amountValid = positive(observation.price) && nonnegative(discount) && discount < observation.price;
  const productTotal = amountValid ? observation.price-discount : null;
  const total = productTotal!==null && nonnegative(observation.shipping) ? productTotal+observation.shipping : null;
  const productUnitPrice = productTotal!==null && positive(observation.quantity) && TRACKING_UNITS.includes(observation.unit)
    ? productTotal/observation.quantity*factor(observation.unit) : null;
  const calculated = total!==null && positive(observation.quantity) && TRACKING_UNITS.includes(observation.unit)
    ? total/observation.quantity*factor(observation.unit) : null;
  if (productUnitPrice!==null && !Number.isFinite(productUnitPrice) || calculated!==null && !Number.isFinite(calculated)) issues.push('단가 계산 범위 초과');
  return {
    total:Number.isFinite(total)?total:null,
    unitPrice:issues.length===0 && Number.isFinite(calculated) && calculated>0 ? calculated:null,
    productUnitPrice:Number.isFinite(productUnitPrice)?productUnitPrice:null,
    issues
  };
}

export function validateState(raw) {
  if (!plainObject(raw) || raw.schemaVersion!==2 || !Array.isArray(raw.items) || !Array.isArray(raw.sources) || !Array.isArray(raw.observations)) fail('한눈단가 가격 기록 형식(version 2)을 확인해 주세요.');
  for (const [key,limit] of Object.entries(TRACKING_LIMITS)) {
    if (raw[key].length > limit) fail(`저장 한도(${key}: ${limit}개)를 넘었습니다.`);
  }
  const now=Date.now(), itemIds=new Set(), sourceIds=new Set(), observationIds=new Set();
  const items=raw.items.map(item=>{
    if (!plainObject(item)) fail('상품 정보를 확인해 주세요.');
    const itemId=id(item.id,'상품 ID');
    if (itemIds.has(itemId)) fail('같은 상품 ID가 두 번 들어 있습니다.');
    itemIds.add(itemId);
    if (!TRACKING_UNITS.includes(item.unit)) fail('상품 비교단위를 확인해 주세요.');
    const createdAt=date(item.createdAt,'상품 등록일',now), updatedAt=date(item.updatedAt,'상품 수정일',now);
    if (updatedAt < createdAt) fail('상품 수정일이 등록일보다 빠릅니다.');
    return {id:itemId,name:text(item.name,'상품명',200,true),brand:text(item.brand,'브랜드',200),variant:text(item.variant,'상품 규격',500),category:text(item.category,'분류',100)||'기타',unit:item.unit,sku:text(item.sku,'상품번호',100),favorite:item.favorite===true,archived:item.archived===true,createdAt,updatedAt};
  });
  const itemsById=new Map(items.map(item=>[item.id,item]));
  const sources=raw.sources.map(source=>{
    if (!plainObject(source)) fail('판매처 정보를 확인해 주세요.');
    const sourceId=id(source.id,'판매처 ID'), itemId=id(source.itemId,'연결 상품 ID');
    if (sourceIds.has(sourceId)) fail('같은 판매처 ID가 두 번 들어 있습니다.');
    sourceIds.add(sourceId);
    const item=itemsById.get(itemId);
    if (!item) fail('판매처와 연결된 상품이 없습니다.');
    if (!PLATFORMS.includes(source.platform)) fail('판매 플랫폼을 확인해 주세요.');
    if (source.unit!==item.unit) fail('판매처와 상품의 비교단위가 다릅니다.');
    const urlText=text(source.url,'상품 링크',2048), evidenceText=text(source.evidenceUrl,'공식몰 근거 링크',2048);
    const url=source.platform==='네이버'?canonicalNaverUrl(urlText):source.platform==='쿠팡'?canonicalCoupangUrl(urlText):externalUrl(urlText);
    if (urlText && !url) fail('유효한 상품 링크를 입력해 주세요. 네이버는 스마트스토어·브랜드스토어, 쿠팡은 개별 상품의 전체 주소가 필요합니다.');
    if (source.platform==='네이버' && (!url || source.official!==true || !externalUrl(evidenceText))) fail('네이버 공식몰 확인과 근거 링크, 개별 상품 주소가 필요합니다.');
    if (source.platform==='쿠팡' && !url) fail('쿠팡 상품 주소를 입력해 주세요.');
    if (evidenceText && !externalUrl(evidenceText)) fail('공식몰 근거 링크를 확인해 주세요.');
    const createdAt=date(source.createdAt,'판매처 등록일',now), updatedAt=date(source.updatedAt,'판매처 수정일',now);
    if (updatedAt < createdAt) fail('판매처 수정일이 등록일보다 빠릅니다.');
    return {id:sourceId,itemId,platform:source.platform,seller:text(source.seller,'판매처명',200),store:text(source.store,'매장명',200),url,variant:text(source.variant,'선택 옵션',500),quantity:numeric(source.quantity,'총량'),unit:source.unit,delivery:normalizedDelivery(source.delivery,source.platform),official:source.official===true,evidenceUrl:evidenceText?externalUrl(evidenceText):'',targetUnitPrice:numeric(source.targetUnitPrice,'목표 단가',{nullable:true}),archived:source.archived===true,createdAt,updatedAt};
  });
  const sourcesById=new Map(sources.map(source=>[source.id,source]));
  const observations=raw.observations.map(observation=>{
    if (!plainObject(observation)) fail('가격 기록을 확인해 주세요.');
    const observationId=id(observation.id,'가격 기록 ID'), sourceId=id(observation.sourceId,'연결 판매처 ID'), itemId=id(observation.itemId,'연결 상품 ID');
    if (observationIds.has(observationId)) fail('같은 가격 기록 ID가 두 번 들어 있습니다.');
    observationIds.add(observationId);
    const source=sourcesById.get(sourceId);
    if (!source || source.itemId!==itemId) fail('가격 기록과 연결된 상품·판매처가 다릅니다.');
    if (observation.quantity!==source.quantity || observation.unit!==source.unit) fail('총량·옵션이 바뀌면 새 판매처 조건으로 등록해 주세요. 기존 가격 이력에 다른 규격을 섞을 수 없습니다.');
    if (!METHODS.includes(observation.method)) fail('가격 기록 방식을 확인해 주세요.');
    if (!STOCK.includes(observation.stock)) fail('가격 기록의 재고 상태를 확인해 주세요.');
    const price=numeric(observation.price,'상품가격'), discount=numeric(observation.discount??0,'할인액',{zero:true}), quantity=numeric(observation.quantity,'기록 총량');
    const shipping=numeric(observation.shipping,'배송비',{nullable:true,zero:true});
    if (discount>=price) fail('할인액은 상품가격보다 작아야 합니다.');
    if (!Number.isFinite(price/quantity*factor(observation.unit))) fail('단가 계산 범위를 넘었습니다. 가격과 총량을 확인해 주세요.');
    const observedAt=date(observation.observedAt,'가격 확인일',now), createdAt=date(observation.createdAt,'가격 기록일',now);
    if (Date.parse(observedAt)>Date.parse(createdAt)+FUTURE_TOLERANCE_MS) fail('가격 확인일이 기록일보다 늦습니다.');
    const deletedAt=observation.deletedAt==null?null:date(observation.deletedAt,'가격 삭제일',now);
    if (deletedAt && deletedAt<createdAt) fail('가격 삭제일이 기록일보다 빠릅니다.');
    // Missing legacy snapshots are unknown, even when today's source default is Rocket.
    const delivery=normalizedDelivery(observation.delivery,source.platform);
    return {id:observationId,sourceId,itemId,price,shipping,discount,quantity,unit:observation.unit,delivery,observedAt,createdAt,method:observation.method,stock:observation.stock,note:text(observation.note,'가격 메모',2000),deletedAt};
  });
  return {schemaVersion:2,items,sources,observations};
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (plainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stableValue(value[key])]));
  return value;
}
const same = (a,b) => JSON.stringify(stableValue(a))===JSON.stringify(stableValue(b));

/** Merge offline/device snapshots; no observation edits or source-identity changes. */
export function mergeStates(left, right) {
  const a=validateState(left), b=validateState(right);
  const merged=emptyState();
  for (const kind of ['items','sources']) {
    const map=new Map(a[kind].map(row=>[row.id,row]));
    for (const row of b[kind]) {
      const previous=map.get(row.id);
      if (!previous) { map.set(row.id,row); continue; }
      if (kind==='sources' && sourceIdentity(previous)!==sourceIdentity(row)) fail('같은 판매처 ID의 상품·옵션·총량이 달라 병합하지 않았습니다. 새 판매처 조건으로 등록해 주세요.');
      if (kind==='items' && previous.unit!==row.unit && [...a.sources,...b.sources].some(source=>source.itemId===row.id)) fail('가격 이력이 있는 상품의 비교단위를 바꿀 수 없습니다. 새 상품으로 등록해 주세요.');
      if (previous.updatedAt===row.updatedAt && !same(previous,row)) fail('같은 시각에 서로 다르게 수정된 상품 또는 판매처가 있습니다. 최신 기록을 확인해 주세요.');
      if (row.updatedAt>previous.updatedAt) map.set(row.id,row);
    }
    merged[kind]=[...map.values()];
  }
  const observations=new Map(a.observations.map(row=>[row.id,row]));
  for (const row of b.observations) {
    const previous=observations.get(row.id);
    if (!previous) { observations.set(row.id,row); continue; }
    const {deletedAt:aDeleted,...aContent}=previous;
    const {deletedAt:bDeleted,...bContent}=row;
    if (!same(aContent,bContent)) fail('같은 가격 기록 ID의 내용이 달라 병합하지 않았습니다. 수정한 가격은 새 기록으로 추가해 주세요.');
    observations.set(row.id,{...previous,deletedAt:[aDeleted,bDeleted].filter(Boolean).sort().at(-1)||null});
  }
  merged.observations=[...observations.values()];
  return validateState(merged);
}

export function historySeries(source, observations) {
  return observations.filter(observation=>observation.sourceId===source.id && observation.itemId===source.itemId && !observation.deletedAt)
    .sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt) || Date.parse(a.createdAt)-Date.parse(b.createdAt) || String(a.id).localeCompare(String(b.id)))
    .map(observation=>{
      const metrics=observationMetrics(observation);
      if (observation.quantity!==source.quantity || observation.unit!==source.unit) metrics.issues.push('추적 조건과 다른 규격');
      if (source.platform==='네이버' && (!source.official || !externalUrl(source.evidenceUrl) || !canonicalNaverUrl(source.url))) metrics.issues.push('공식몰 또는 상품 링크 미확인');
      if (source.platform==='쿠팡' && !canonicalCoupangUrl(source.url)) metrics.issues.push('쿠팡 상품 링크 미확인');
      if (metrics.issues.length) metrics.unitPrice=null;
      return {...observation,...metrics};
    });
}

export function sourceSummary(source, observations) {
  const series=historySeries(source,observations);
  const latest=series.at(-1)||null, previous=series.at(-2)||null;
  const valid=series.filter(observation=>observation.unitPrice!==null);
  const lowest=valid.reduce((result,observation)=>!result||observation.unitPrice<result.unitPrice?observation:result,null);
  const changePercent=latest?.unitPrice!=null && previous?.unitPrice!=null
    ? (latest.unitPrice-previous.unitPrice)/previous.unitPrice*100 : null;
  const targetReached=positive(source.targetUnitPrice) && latest?.unitPrice!=null && latest.unitPrice<=source.targetUnitPrice;
  return {latest,previous,lowest,changePercent,targetReached,count:series.length};
}

/**
 * Compare one item's latest confirmed prices. Different packs can share a unit,
 * but different items/units must be compared separately. The full observations
 * array may include other items; only observations for supplied sources apply.
 * Coupang's representative respects delivery preference before price. Its
 * absolute lowest known-delivery price is returned separately as coupangLowest.
 */
export function compareTrackedSources(sources, observations) {
  if (!Array.isArray(sources) || !Array.isArray(observations)) fail('비교할 판매처와 가격 기록을 확인해 주세요.');
  const result={costco:null,naver:null,coupang:null,coupangLowest:null,lowest:null};
  if (!sources.length) return result;
  const first=sources[0], byId=new Map();
  if (!plainObject(first) || !first.itemId || !TRACKING_UNITS.includes(first.unit)) fail('비교할 상품과 단위를 확인해 주세요.');
  for (const source of sources) {
    if (!plainObject(source) || source.itemId!==first.itemId || source.unit!==first.unit) fail('다른 상품이나 비교단위를 한 번에 비교할 수 없습니다.');
    if (!source.id || byId.has(source.id) || !PLATFORMS.includes(source.platform)) fail('비교할 판매처 정보를 확인해 주세요.');
    byId.set(source.id,source);
  }
  for (const observation of observations) {
    if (!plainObject(observation)) fail('비교할 가격 기록을 확인해 주세요.');
    const source=byId.get(observation.sourceId);
    if (source && (observation.itemId!==source.itemId || observation.unit!==source.unit)) fail('다른 상품이나 비교단위의 가격 기록이 섞여 있습니다.');
  }
  const byPrice=(a,b)=>a.observation.unitPrice-b.observation.unitPrice
    || Date.parse(b.observation.observedAt)-Date.parse(a.observation.observedAt)
    || String(a.source.id).localeCompare(String(b.source.id));
  const candidates=sources.filter(source=>!source.archived).map(source=>({source,observation:sourceSummary(source,observations).latest}))
    .filter(candidate=>Number.isFinite(candidate.observation?.unitPrice) && candidate.observation.unitPrice>0);
  const cheapest=values=>values.sort(byPrice)[0]||null;
  result.costco=cheapest(candidates.filter(candidate=>candidate.source.platform==='코스트코'));
  result.naver=cheapest(candidates.filter(candidate=>candidate.source.platform==='네이버'));
  const coupang=candidates.filter(candidate=>candidate.source.platform==='쿠팡' && deliveryRank(candidate.observation)<4);
  result.coupangLowest=cheapest([...coupang]);
  result.coupang=coupang.sort((a,b)=>deliveryRank(a.observation)-deliveryRank(b.observation)||byPrice(a,b))[0]||null;
  result.lowest=cheapest([result.costco,result.naver,result.coupang].filter(Boolean));
  return result;
}

function legacyDate(value) {
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const iso=value+'T00:00:00+09:00';
  if (!validIso(iso) || Date.parse(iso)>Date.now()) return null;
  return new Date(iso).toISOString();
}

/** Import only actual legacy observations, never fabricate a historical series. */
export function migrateLegacy(raw) {
  if (!plainObject(raw) || raw.schemaVersion!==1 || !Array.isArray(raw.products) || !Array.isArray(raw.offers)) fail('이전 한눈단가(version 1) 기록인지 확인해 주세요.');
  if (raw.products.length>100 || raw.offers.length>400) fail('이전 기록의 상품·판매가 한도를 넘었습니다.');
  const state=emptyState(), mapping=new Map(), now=new Date().toISOString();
  for (const product of raw.products) {
    if (product.isExample!==false || !TRACKING_UNITS.includes(product.unit) || !String(product.name||'').trim()) continue;
    try { id(product.id); } catch { continue; }
    const itemId='legacy-item-'+product.id;
    if (mapping.has(product.id)) continue;
    const observedAt=legacyDate(product.verifiedAt), createdAt=observedAt||now;
    const item={id:itemId,name:String(product.name).slice(0,200),brand:'',variant:String(product.spec||'').slice(0,500),category:String(product.category||'기타').slice(0,100),unit:product.unit,sku:'',favorite:true,archived:false,createdAt,updatedAt:createdAt};
    state.items.push(item); mapping.set(product.id,item);
    if (!positive(product.costcoPrice) || !positive(product.costcoQuantity) || !observedAt) continue;
    const calculated=product.costcoPrice/product.costcoQuantity*factor(product.unit);
    if (!Number.isFinite(calculated) || positive(product.costcoUnitPrice)&&Math.abs(product.costcoUnitPrice-calculated)>1.0000001) continue;
    const source={id:'legacy-costco-'+product.id,itemId,platform:'코스트코',seller:'코스트코',store:'기존 기록 · 매장 미지정',url:'',variant:item.variant,quantity:product.costcoQuantity,unit:item.unit,official:false,evidenceUrl:'',targetUnitPrice:null,archived:false,createdAt,updatedAt:createdAt};
    state.sources.push(source);
    state.observations.push({id:'legacy-costco-observation-'+product.id,sourceId:source.id,itemId,price:product.costcoPrice,shipping:0,discount:0,quantity:source.quantity,unit:source.unit,observedAt,createdAt:observedAt,method:'migration',stock:'있음',note:('이전 버전의 마지막 저장 가격입니다. 확인 시각은 기록되지 않았습니다. '+String(product.note||'')).slice(0,2000),deletedAt:null});
  }
  for (const offer of raw.offers) {
    const item=mapping.get(offer.productId);
    if (!item || offer.isExample!==false || offer.match!=='동일' || offer.verified!==true || offer.stock!=='있음' || offer.unit!==item.unit || !['네이버','쿠팡'].includes(offer.platform)) continue;
    try { id(offer.id); } catch { continue; }
    if (state.sources.some(source=>source.id==='legacy-online-'+offer.id)) continue;
    const observedAt=legacyDate(offer.verifiedAt), discount=offer.discount??0;
    if (!observedAt || !positive(offer.price) || !positive(offer.quantity) || !nonnegative(discount) || discount>=offer.price || discount>0&&offer.discountConfirmed!==true || offer.shipping!==null&&offer.shipping!==undefined&&!nonnegative(offer.shipping)) continue;
    const url=offer.platform==='네이버'?canonicalNaverUrl(offer.url):canonicalCoupangUrl(offer.url);
    if (!url || offer.platform==='네이버'&&(!offer.official || !externalUrl(offer.officialEvidenceUrl))) continue;
    const delivery=normalizedDelivery(DELIVERY_TYPES.includes(offer.delivery)?offer.delivery:undefined,offer.platform);
    const source={id:'legacy-online-'+offer.id,itemId:item.id,platform:offer.platform,seller:String(offer.seller||'').slice(0,200),store:'',url,variant:String(offer.name||item.variant||item.name).slice(0,500),quantity:offer.quantity,unit:offer.unit,delivery,official:offer.platform==='네이버'&&offer.official===true,evidenceUrl:offer.platform==='네이버'?externalUrl(offer.officialEvidenceUrl):'',targetUnitPrice:null,archived:false,createdAt:observedAt,updatedAt:observedAt};
    state.sources.push(source);
    state.observations.push({id:'legacy-online-observation-'+offer.id,sourceId:source.id,itemId:item.id,price:offer.price,shipping:offer.shipping??null,discount,quantity:source.quantity,unit:source.unit,delivery,observedAt,createdAt:observedAt,method:'migration',stock:'있음',note:('이전 버전의 마지막 저장 가격입니다. 확인 시각은 기록되지 않았습니다. '+String(offer.note||'')).slice(0,2000),deletedAt:null});
  }
  return validateState(state);
}

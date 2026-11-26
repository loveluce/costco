export const UNITS = ['개','100g','100mL','m'];
export const DELIVERIES = ['로켓배송','로켓프레시','판매자로켓','일반배송','해당없음'];
export const factor = unit => unit === '100g' || unit === '100mL' ? 100 : 1;
export const rawUnit = unit => ({'개':'개','100g':'g','100mL':'mL','m':'m'}[unit] || '개');
export const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export const number = value => value === '' || value === null || value === undefined ? null : Number(value);
export const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
export const nonnegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function safeUrl(value) { try { const u=new URL(String(value)); return ['https:','http:'].includes(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } }
export function ageDays(value, now=today()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value||'')) return null;
  const ms=Date.parse(value+'T00:00:00Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0,10)!==value) return null;
  return Math.floor((Date.parse(now+'T00:00:00Z')-ms)/86400000);
}
function dateIssue(value,maxAge,now) { const age=ageDays(value,now); return age===null ? '확인일 필요' : age<0 ? '미래 확인일' : age>maxAge ? '가격 재확인' : ''; }
export function costco(p,settings,now=today()) {
  const calculated=positive(p.costcoPrice)&&positive(p.costcoQuantity) ? p.costcoPrice/p.costcoQuantity*factor(p.unit) : null;
  const entered=positive(p.costcoUnitPrice) ? p.costcoUnitPrice : null;
  const unitPrice=entered??calculated;
  const issues=[];
  if(!UNITS.includes(p.unit)) issues.push('비교단위 확인');
  if(!positive(unitPrice)) issues.push('코스트코 가격 필요');
  if(entered!==null&&calculated!==null&&Math.abs(entered-calculated)>1.0000001) issues.push('총액·직접단가 불일치');
  const di=dateIssue(p.verifiedAt,settings.maxAgeDays,now); if(di)issues.push(di);
  return {id:'costco-'+p.id,platform:'코스트코',seller:'코스트코 입력가',name:p.name,unit:p.unit,unitPrice,total:p.costcoPrice,quantity:p.costcoQuantity,verifiedAt:p.verifiedAt,issues,eligible:issues.length===0,isCostco:true};
}
export function assess(o,p,settings,now=today()) {
  const issues=[];
  if(!p) return {...o,issues:['상품 없음'],eligible:false,unitPrice:null,total:null};
  if(o.isExample!==p.isExample) issues.push('예시·실제 혼합');
  if(!['쿠팡','네이버'].includes(o.platform)) issues.push('플랫폼 확인');
  if(!['동일','유사'].includes(o.match))issues.push('일치유형 확인');
  if(!UNITS.includes(o.unit)||o.unit!==p.unit)issues.push('비교단위 다름');
  if(!positive(o.quantity))issues.push('총량 필요');
  if(!positive(o.price))issues.push('상품가격 필요');
  if(!nonnegative(o.shipping))issues.push('배송비 미확인');
  const discount=o.discount??0;
  if(!nonnegative(discount))issues.push('할인금액 확인');
  if(discount>0&&!o.discountConfirmed)issues.push('할인 적용 미확인');
  const total=positive(o.price)&&nonnegative(o.shipping)&&nonnegative(discount) ? o.price+o.shipping-discount : null;
  if(total!==null&&!positive(total))issues.push('결제금액 확인');
  if(o.stock!=='있음')issues.push(o.stock==='품절'?'품절':'재고 미확인');
  if(!o.verified)issues.push('가격·옵션 미확인');
  if(!safeUrl(o.url))issues.push('상품링크 필요');
  if(o.platform==='네이버'&&(!o.official||!safeUrl(o.officialEvidenceUrl)))issues.push('공식몰 미확인');
  if(o.platform==='쿠팡'&&!DELIVERIES.slice(0,4).includes(o.delivery))issues.push('배송유형 확인');
  const di=dateIssue(o.verifiedAt,settings.maxAgeDays,now);if(di)issues.push(di);
  const unitPrice=positive(total)&&positive(o.quantity)&&UNITS.includes(o.unit) ? total/o.quantity*factor(o.unit):null;
  if(unitPrice!==null&&!positive(unitPrice))issues.push('단가 계산 범위 초과');
  return {...o,total,unitPrice,issues,eligible:issues.length===0};
}
export function deliveryRank(o) { return ['로켓배송','로켓프레시'].includes(o.delivery)?1:o.delivery==='판매자로켓'?2:3; }
const cheapest = list => [...list].sort((a,b)=>a.unitPrice-b.unitPrice)[0] || null;
export function compare(p,offers,settings,now=today()) {
  const base=costco(p,settings,now);
  const rows=offers.filter(o=>o.productId===p.id&&o.isExample===p.isExample).map(o=>assess(o,p,settings,now));
  const exact=rows.filter(o=>o.eligible&&o.match==='동일');
  const similar=rows.filter(o=>o.eligible&&o.match==='유사');
  const coupang=exact.filter(o=>o.platform==='쿠팡');
  const preferredCoupang=[...coupang].sort((a,b)=>deliveryRank(a)-deliveryRank(b)||a.unitPrice-b.unitPrice)[0]||null;
  const naver=cheapest(exact.filter(o=>o.platform==='네이버'));
  const onlinePreferred=cheapest([preferredCoupang,naver].filter(Boolean));
  const recommended=base.eligible&&exact.length ? cheapest([base,preferredCoupang,naver].filter(Boolean)) : null;
  const lowest=cheapest([...(base.eligible?[base]:[]),...exact]);
  const saving=recommended&&base.eligible?(base.unitPrice-recommended.unitPrice)/base.unitPrice*100:null;
  return {base,rows,exact,similar,preferredCoupang,naver,onlinePreferred,recommended,lowest,similarLowest:cheapest(similar),saving};
}
export function searchLinks(p,similar=false) {
  const name=String(p.name||'').trim(),query=String(p.query||'').trim();
  const q=(similar&&p.category&&p.category!=='기타'?String(p.category).trim():query||name)||name;
  return {coupang:'https://www.coupang.com/np/search?q='+encodeURIComponent(q),naver:'https://search.naver.com/search.naver?query='+encodeURIComponent(q),naverOfficial:'https://search.naver.com/search.naver?query='+encodeURIComponent(q+' 공식')};
}
export function exampleData() {
  const date=today(), product=(id,name,spec,unit,price,qty,category)=>({id,name,spec,query:name,unit,costcoPrice:price,costcoQuantity:qty,costcoUnitPrice:null,verifiedAt:date,isExample:true,note:'가상 예시입니다. 실제 시세·판매처가 아닙니다.',category});
  const products=[product('demo-01','프레시 주방세제','가상 브랜드 · 레몬향 · 1L × 3개','100mL',15990,3000,'주방·세탁'),product('demo-02','데일리 3겹 화장지','가상 브랜드 · 30m × 30롤 · 동일 폭/겹수','m',18990,900,'화장지·물티슈'),product('demo-03','소프트 아기 물티슈','가상 브랜드 · 80매 × 10팩 · 동일 원단/평량','개',19990,800,'육아용품')];
  products.forEach((p,i)=>p.query=['주방세제 1L','3겹 화장지 30m','아기 물티슈 80매'][i]);
  const offer=(id,p,platform,price,qty,delivery,extra={})=>({id,productId:p.id,platform,seller:platform==='쿠팡'?'예시 판매처':'예시 브랜드 공식몰',name:p.name,match:'동일',unit:p.unit,quantity:qty,price,shipping:0,discount:0,discountConfirmed:false,delivery,official:platform==='네이버',officialEvidenceUrl:platform==='네이버'?'https://ads.naver.com/help/faq/1036':'',url:searchLinks(p)[platform==='쿠팡'?'coupang':'naver'],verifiedAt:date,stock:'있음',verified:true,isExample:true,note:'계산 설명용 가상 가격. 링크는 검색 안내입니다.',...extra});
  const offers=[offer('demo-o1',products[0],'쿠팡',12900,2000,'로켓배송',{discount:1000,discountConfirmed:true}),offer('demo-o2',products[0],'네이버',14900,3000,'해당없음'),offer('demo-o3',products[0],'쿠팡',12900,3000,'일반배송'),offer('demo-o4',products[0],'쿠팡',11970,3000,'판매자로켓',{match:'유사',name:'그린랩 주방세제 · 가상 유사제품'}),offer('demo-o5',products[0],'네이버',9900,3000,'해당없음',{official:false,officialEvidenceUrl:'',shipping:null,verified:false}),offer('demo-o6',products[1],'쿠팡',20990,900,'로켓배송'),offer('demo-o7',products[1],'네이버',18900,900,'해당없음',{shipping:3000}),offer('demo-o8',products[2],'쿠팡',17990,800,'로켓배송'),offer('demo-o9',products[2],'네이버',17500,800,'해당없음')];
  return {schemaVersion:1,settings:{mode:'예시',maxAgeDays:7},products,offers};
}
export function validateImport(data) {
  if(!data||data.schemaVersion!==1||!Array.isArray(data.products)||!Array.isArray(data.offers))throw new Error('한눈단가 JSON 형식(version 1)인지 확인해 주세요.');
  if(data.products.length>100||data.offers.length>400)throw new Error('한 번에 상품 100개, 판매가 400개까지 가져올 수 있습니다.');
  const ids=new Set(),offerIds=new Set();
  const text=(v,max=500)=>typeof v==='string'?v.slice(0,max):'';
  const num=(v)=>v===null||v===undefined||v===''?null:typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1e12?v:(()=>{throw new Error('가격과 수량에는 0 이상의 숫자를 사용해 주세요.');})();
  const validId=(id)=>typeof id==='string'&&/^[A-Za-z0-9가-힣_-]{1,100}$/.test(id);
  const products=data.products.map(p=>{
    if(!validId(p.id)||ids.has(p.id)||!text(p.name)||!UNITS.includes(p.unit)||typeof p.isExample!=='boolean')throw new Error('상품 ID, 이름, 비교단위 또는 예시 구분을 확인해 주세요.');ids.add(p.id);
    return {id:p.id,name:text(p.name),spec:text(p.spec),query:text(p.query),unit:p.unit,costcoPrice:num(p.costcoPrice),costcoQuantity:num(p.costcoQuantity),costcoUnitPrice:num(p.costcoUnitPrice),verifiedAt:text(p.verifiedAt,10),isExample:p.isExample,note:text(p.note,2000),category:text(p.category)||'기타'};
  });
  const offers=data.offers.map(o=>{
    if(!validId(o.id)||offerIds.has(o.id)||!ids.has(o.productId)||!['쿠팡','네이버'].includes(o.platform)||!['동일','유사'].includes(o.match)||!UNITS.includes(o.unit)||!DELIVERIES.includes(o.delivery)||!['있음','품절','미확인'].includes(o.stock)||typeof o.isExample!=='boolean')throw new Error('판매가 ID·상품 연결·선택값을 확인해 주세요.');offerIds.add(o.id);
    if(products.find(p=>p.id===o.productId).isExample!==o.isExample)throw new Error('예시 상품에 실제 판매가를 연결할 수 없습니다.');
    for(const key of ['url','officialEvidenceUrl'])if(o[key]&&!safeUrl(o[key]))throw new Error('상품·근거 링크는 http 또는 https 주소여야 합니다.');
    return {id:o.id,productId:o.productId,platform:o.platform,seller:text(o.seller),name:text(o.name),match:o.match,unit:o.unit,quantity:num(o.quantity),price:num(o.price),shipping:num(o.shipping),discount:num(o.discount),discountConfirmed:o.discountConfirmed===true,delivery:o.delivery,official:o.official===true,officialEvidenceUrl:text(o.officialEvidenceUrl,2048),url:text(o.url,2048),verifiedAt:text(o.verifiedAt,10),stock:o.stock,verified:o.verified===true,isExample:o.isExample,note:text(o.note,2000)};
  });
  return {schemaVersion:1,products,offers,settings:{mode:data.settings?.mode==='실제'?'실제':'예시',maxAgeDays:Number.isInteger(data.settings?.maxAgeDays)&&data.settings.maxAgeDays>0&&data.settings.maxAgeDays<=365?data.settings.maxAgeDays:7}};
}
export function mergeData(current,incoming,update=false) {
  const products=[...current.products], offers=[...current.offers];let added=0,updated=0,skipped=0;
  for(const [items,target] of [[incoming.products,products],[incoming.offers,offers]])for(const item of items){const i=target.findIndex(x=>x.id===item.id);if(i<0){target.push(item);added++;}else if(update){target[i]=item;updated++;}else skipped++;}
  if(products.length>100||offers.length>400)throw new Error('저장 한도(상품 100개 / 판매가 400개)를 넘었습니다. 예시를 삭제하거나 기록을 정리해 주세요.');
  for(const o of offers){const p=products.find(p=>p.id===o.productId);if(!p||p.isExample!==o.isExample)throw new Error('기존 상품과 가져오는 가격의 예시 구분이 충돌합니다.');}
  return {data:{...current,products,offers},added,updated,skipped};
}
export function csvCell(v){let s=String(v??'');if(/^[\s]*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}

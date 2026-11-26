// Conservative shelf-label extraction. All returned values are review candidates.
const NUM = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)`;
const UNIT = String.raw`(?:밀리리터|킬로그램|미터|리터|그램|캡슐|sheets?|pieces?|counts?|rolls?|packs?|pcs|ct|ea|mL|kg|cm|L|g|m|매|개입|개|입|정|롤|팩|봉|병|통|세트|박스)`;
const META = /상품\s*(?:번호|코드)|품목\s*번호|품번|바코드|회원\s*번호|\b(?:ITEM(?:\s*(?:NO|NUMBER))?|SKU|UPC|EAN|BARCODE)\b/i;
const NOISE = /가상\s*OCR|테스트\s*가격표|실제\s*판매가격\s*아님|행사\s*기간|유통\s*기한|제조\s*일자|유효\s*기간|\b(?:EXPIRY|VALID\s*(?:UNTIL|THROUGH)|EXPIRATION)\b/i;
const SALE = /쿠폰\s*적용\s*(?:가격|가)|할인\s*후\s*(?:가격|가)|최종\s*(?:가격|가)|행사\s*(?:가격|가)|할인\s*(?:가격|가)|특가|회원\s*할인가|\b(?:SALE\s*PRICE|NOW|DISCOUNTED\s*PRICE)\b/ig;
const REGULAR = /정상\s*(?:가격|가)|정가|기존\s*(?:가격|가)|\b(?:REGULAR(?:\s*PRICE)?|REG\.?\s*PRICE|WAS)\b/ig;
const SAVING = /할인\s*(?:금액|액)|즉시\s*할인|쿠폰\s*(?:할인|금액)|절약|(?:^|\s)할인(?:\s|$)|\b(?:SAVE|SAVINGS|DISCOUNT|COUPON|OFF)\b/ig;
const TOTAL = /판매\s*(?:가격|가)|결제\s*(?:금액|가격|가)|구매\s*(?:가격|가)|상품\s*(?:가격|가)|\b(?:OUR\s*PRICE|PRICE)\b|가격/ig;
const HAS_PRICE_TAG = /판매\s*(?:가격|가)|정상\s*(?:가격|가)|행사\s*(?:가격|가)|최종\s*(?:가격|가)|할인\s*(?:가격|가)|정가|특가|\b(?:PRICE|NOW|WAS)\b/i;
const PACK_UNITS = /^(?:롤|팩|봉|병|통|세트|박스|rolls?|packs?)$/i;
const numeric = value => Number(String(value).replaceAll(',', ''));
const close = (a,b) => Math.abs(a-b) <= Math.max(1e-6,Math.abs(a)*1e-8);
const unique = values => [...new Set(values)];

function measurement(value, unit) {
  const n = numeric(value), u = String(unit||'').toLowerCase();
  if (!Number.isFinite(n) || n <= 0 || n > 1e12) return null;
  if (/^(ml|밀리리터)$/.test(u)) return {unit:'100mL',quantity:n,pack:false};
  if (/^(l|리터)$/.test(u)) return {unit:'100mL',quantity:n*1000,pack:false};
  if (/^(g|그램)$/.test(u)) return {unit:'100g',quantity:n,pack:false};
  if (/^(kg|킬로그램)$/.test(u)) return {unit:'100g',quantity:n*1000,pack:false};
  if (/^(m|미터)$/.test(u)) return {unit:'m',quantity:n,pack:false};
  if (u==='cm') return {unit:'m',quantity:n/100,pack:false};
  if (u && Number.isInteger(n)) return {unit:'개',quantity:n,pack:PACK_UNITS.test(u)};
  return null;
}

function perUnitMarkers(line) {
  const result=[];
  const patterns=[
    new RegExp(`(${NUM})?\\s*(${UNIT})\\s*(?:당|기준)`, 'ig'),
    new RegExp(`(?:\\bper\\s*|/)(${NUM})?\\s*(${UNIT})(?![A-Za-z])`, 'ig')
  ];
  for(const re of patterns) for(const m of line.matchAll(re)) {
    const measure=measurement(m[1]||1,m[2]);
    if(measure) result.push({...measure,start:m.index,end:m.index+m[0].length});
  }
  if(/\beach\b/i.test(line)) {
    const m=/\beach\b/i.exec(line);
    result.push({unit:'개',quantity:1,start:m.index,end:m.index+m[0].length,pack:false});
  }
  return result.sort((a,b)=>a.start-b.start);
}

function tagBefore(text) {
  const matches=[];
  for(const [kind,re] of [['sale',SALE],['regular',REGULAR],['saving',SAVING],['total',TOTAL]]) {
    re.lastIndex=0;
    for(const m of text.matchAll(re)) matches.push({kind,index:m.index,end:m.index+m[0].length});
  }
  // A generic PRICE inside SALE PRICE must not override its more specific label.
  const filtered=matches.filter(m=>!matches.some(other=>other!==m&&other.index<=m.index&&other.end>=m.end&&other.kind!=='total'&&m.kind==='total'));
  filtered.sort((a,b)=>b.index-a.index || (a.kind==='sale'?-1:1));
  return filtered[0]?.kind||null;
}

function collectPrices(lines,warnings) {
  const candidates=[], excludedSavings=[];
  const splitLines=new Set();
  for(let i=0;i<lines.length-1;i++) {
    if(/^\d{1,3}$/.test(lines[i])&&/^\d{3}\s*(?:원)?$/.test(lines[i+1])&&(HAS_PRICE_TAG.test(lines[i-1]||'')||i===0)) {
      splitLines.add(i);splitLines.add(i+1);
      warnings.push('큰 가격 숫자가 여러 줄로 나뉘어 있습니다. 합쳐 추정하지 않았으니 판매가를 직접 확인해 주세요.');
    }
  }
  for(let lineIndex=0;lineIndex<lines.length;lineIndex++) {
    const line=lines[lineIndex], previous=lines[lineIndex-1]||'';
    if(NOISE.test(line)||splitLines.has(lineIndex))continue;
    if(/[$€£¥]|\b(?:USD|EUR|JPY|CNY|RMB)\b/i.test(line)) {
      warnings.push('외화 표시가 있습니다. 원화로 자동 변환하지 않았습니다.');continue;
    }
    const dateRanges=[...line.matchAll(/\b(?:19|20)\d{2}[.\/-](?:0?[1-9]|1[0-2])[.\/-](?:0?[1-9]|[12]\d|3[01])\b|\b(?:0?[1-9]|1[0-2])[\/-](?:0?[1-9]|[12]\d|3[01])\b/g)].map(m=>[m.index,m.index+m[0].length]);
    const markers=perUnitMarkers(line);
    const previousMarkers=perUnitMarkers(previous);
    const previousLabel=/^[^\d]*$/.test(previous)&&!!tagBefore(previous);
    const tokens=[];
    for(const m of line.matchAll(new RegExp(NUM,'g'))) {
      const start=m.index,end=start+m[0].length,before=line.slice(0,start),after=line.slice(end),amount=numeric(m[0]);
      if(!Number.isFinite(amount)||amount<=0||amount>1e12)continue;
      if(/[\d,.]$/.test(before)||/^[,.]\d/.test(after)||(/^[A-Za-z]/.test(after)&&!/^KRW\b/i.test(after)))continue;
      if(dateRanges.some(([a,b])=>start>=a&&start<b))continue;
      if(new RegExp(`^\\s*(?:${UNIT}|%)(?![A-Za-z])`,'i').test(after))continue;
      if(/[A-Za-z0-9]$/.test(before)&&!/(?:KRW|가격|가|원)\s*$/i.test(before))continue;
      if(markers.some(u=>start>=u.start&&start<u.end))continue;
      const explicitCurrency=/[₩￦]\s*$|\bKRW\s*$/i.test(before)||/^\s*(?:원|KRW)\b/i.test(after)||/^\s*원/.test(after);
      const comma=m[0].includes(',');
      if(META.test(line)&&!explicitCurrency)continue;
      if(META.test(previous)&&/^\d[\d,]*$/.test(line))continue;
      if(!explicitCurrency&&!comma&&!tagBefore(line)&&!previousLabel&&!markers.length&&!previousMarkers.length)continue;
      if(!explicitCurrency&&!comma&&/^\d+$/.test(line)&&!previousLabel&&!previousMarkers.length)continue;
      tokens.push({start,end,amount,explicitCurrency,raw:m[0]});
    }
    tokens.forEach((token,index)=>{
      const left=line.slice(index?tokens[index-1].end:0,token.start);
      const right=line.slice(token.end,tokens[index+1]?.start??line.length);
      const preceding=markers.filter(m=>m.end<=token.start&&!tokens.some(t=>t.start>m.end&&t.end<=token.start));
      const following=markers.filter(m=>m.start>=token.end&&!tokens.some(t=>t.start>m.end));
      let per=preceding.at(-1)||following[0]||null;
      if(!per&&tokens.length===1&&previousMarkers.length&&!new RegExp(NUM).test(previous.replace(new RegExp(`${NUM}\\s*${UNIT}`,'ig'),'')))per=previousMarkers.at(-1);
      const unitLabel=/단위\s*가격|단가|\bUNIT\s*PRICE\b/i.test(line)||(/단위\s*가격|단가|\bUNIT\s*PRICE\b/i.test(previous)&&tokens.length===1);
      let kind=tagBefore(left)||((previousLabel||/할인|SAVE|COUPON/i.test(previous)&&!new RegExp(NUM).test(previous))?tagBefore(previous):null);
      const suffixSaving=/^\s*(?:원|KRW)?\s*(?:할인|절약|쿠폰|OFF|SAVINGS?)(?!가)/i.test(right);
      if(/[-−]\s*$/.test(left)||kind==='saving'||suffixSaving) {excludedSavings.push(token.amount);return;}
      if(per||unitLabel) kind='unit';
      else if(!kind)kind='total';
      const label=(previousLabel?previous+' · ':'')+line;
      candidates.push({amount:token.amount,label:label.slice(0,180),kind,explicit:!!tagBefore(left)||previousLabel,per});
    });
  }
  if(excludedSavings.length)warnings.push('할인액·쿠폰 절약액은 판매가 후보에서 제외했습니다. 실제 결제 가격과 적용 조건을 확인하세요.');
  return candidates.filter((c,i,a)=>a.findIndex(x=>x.amount===c.amount&&x.kind===c.kind&&x.per?.unit===c.per?.unit&&x.per?.quantity===c.per?.quantity)===i);
}

function extractQuantity(lines,warnings) {
  const usable=lines.filter(l=>!META.test(l)&&!NOISE.test(l)).map(l=>{
    const markers=perUnitMarkers(l);return markers.length?l.slice(0,markers[0].start):l;
  }).join('\n').replace(/\b3M(?=\s+[A-Za-z가-힣])/g,'');
  const candidates=[],consumed=[];
  const add=(m,kind,start,end)=>{if(m&&m.quantity>0&&m.quantity<=1e12)candidates.push({...m,kind,start,end});};
  const overlap=(a,b)=>consumed.some(([x,y])=>a<y&&b>x);
  const term=`(${NUM})\\s*(${UNIT})?`;
  const chainRe=new RegExp(`${term}(?:\\s*[x×*]\\s*${term}){1,3}`,'ig');
  for(const m of usable.matchAll(chainRe)) {
    const terms=[...m[0].matchAll(new RegExp(term,'ig'))].map(t=>({value:numeric(t[1]),measure:measurement(t[1],t[2])}));
    const physical=terms.filter(t=>t.measure&&t.measure.unit!=='개');
    let result=null;
    if(physical.length>1)warnings.push('여러 길이·용량이 곱해진 규격이 있습니다. 포장 수량인지 가로·세로 치수인지 직접 확인하세요.');
    else if(physical.length===1) {
      const base=physical[0];const others=terms.filter(t=>t!==base);
      if(others.every(t=>Number.isInteger(t.value)&&t.value>0))result={unit:base.measure.unit,quantity:base.measure.quantity*others.reduce((n,t)=>n*t.value,1),pack:false};
    } else if(terms.some(t=>t.measure)&&terms.every(t=>Number.isInteger(t.value)&&t.value>0))result={unit:'개',quantity:terms.reduce((n,t)=>n*t.value,1),pack:terms.every(t=>!t.measure||t.measure.pack)};
    consumed.push([m.index,m.index+m[0].length]);add(result,'pack',m.index,m.index+m[0].length);
  }
  const totalRe=new RegExp(`(?:총(?:량|수량)?|전체\\s*용량|내용량|\\bTOTAL|\\bNET(?:\\s*(?:WT\\.?|WEIGHT|CONTENTS))?)\\s*[:=]?\\s*(${NUM})\\s*(${UNIT})(?![A-Za-z])`,'ig');
  for(const m of usable.matchAll(totalRe)) {add(measurement(m[1],m[2]),'explicit',m.index,m.index+m[0].length);consumed.push([m.index,m.index+m[0].length]);}
  const singles=[...usable.matchAll(new RegExp(`(${NUM})\\s*(${UNIT})(?![A-Za-z])`,'ig'))].map(m=>({...measurement(m[1],m[2]),start:m.index,end:m.index+m[0].length})).filter(m=>m.unit&&!overlap(m.start,m.end));
  const paired=new Set();
  for(let i=0;i<singles.length-1;i++) {
    const a=singles[i],b=singles[i+1],gap=usable.slice(a.end,b.start);
    if(paired.has(i)||paired.has(i+1)||gap.length>12||!/^\s*[·,(]?\s*$/.test(gap))continue;
    if(a.pack!==b.pack||(a.unit==='개')!==(b.unit==='개')) {
      const base=a.unit!=='개'?a:b.unit!=='개'?b:a.pack?b:a,pack=base===a?b:a;
      if(Number.isInteger(pack.quantity)){add({unit:base.unit,quantity:base.quantity*pack.quantity,pack:false},'pack',a.start,b.end);paired.add(i);paired.add(i+1);}
    }
  }
  singles.forEach((s,i)=>{if(!paired.has(i))add(s,'single',s.start,s.end);});
  const dedup=candidates.filter((c,i,a)=>a.findIndex(x=>x.unit===c.unit&&close(x.quantity,c.quantity))===i);
  if(!dedup.length)return {unit:null,quantity:null};
  const explicit=candidates.filter(c=>c.kind==='explicit');
  const preferred=explicit[0]||dedup[0];
  if(dedup.some(c=>c.unit!==preferred.unit||!close(c.quantity,preferred.quantity))) {
    warnings.push('수량·총량 후보가 서로 다릅니다. 구성과 총수량을 확인한 뒤 직접 선택하세요.');return {unit:null,quantity:null};
  }
  if(preferred.pack)warnings.push('팩·롤 등 포장 개수가 읽혔습니다. 개당 비교를 할지 매수·길이로 비교할지 확인하세요.');
  return {unit:preferred.unit,quantity:preferred.quantity};
}

function extractNameAndSpec(lines) {
  const quantityRe=new RegExp(`${NUM}\\s*${UNIT}(?![A-Za-z])`,'i');
  const specs=lines.filter(l=>!META.test(l)&&!NOISE.test(l)&&!HAS_PRICE_TAG.test(l)&&!perUnitMarkers(l).length&&!/원|[₩$]/.test(l)&&(quantityRe.test(l)||/무향|레몬향|라벤더|규격|향:|색상|무색|유향/i.test(l)));
  const names=lines.filter(l=>{
    if(META.test(l)||NOISE.test(l)||HAS_PRICE_TAG.test(l)||perUnitMarkers(l).length||/할인|쿠폰|절약|단가|단위가격|SAVINGS?|DISCOUNT/i.test(l))return false;
    if(/^(?:COSTCO(?:\s*WHOLESALE)?|코스트코|WHOLESALE|회원전용|부가세포함)$/i.test(l))return false;
    if(/원|[₩$]/.test(l)||!/[가-힣A-Za-z]{2}/.test(l))return false;
    if(/^(?:총|내용량|NET\b|TOTAL\b|무향|레몬향|라벤더|규격|색상)/i.test(l))return false;
    const removed=l.replace(new RegExp(`${NUM}\\s*${UNIT}`,'ig'),'').replace(/[\d\s×x*.,():·/-]/g,'');
    return /[가-힣A-Za-z]{2}/.test(removed);
  });
  const name=names.slice(0,3).join(' ').replace(/^상품명\s*[:：]?\s*/,'').trim().slice(0,500);
  return {name,query:name,spec:specs.slice(0,4).join(' · ').slice(0,500)};
}

/** Extract reviewable Korean/English Costco label values; never fetches or saves. */
export function parsePriceLabel(text) {
  const warnings=[];
  const raw=typeof text==='string'?text:'';
  if(raw.length>40000)warnings.push('텍스트가 길어 앞부분만 분석했습니다. 한 상품의 가격표로 범위를 좁혀 주세요.');
  const normalized=raw.slice(0,40000).normalize('NFKC').replaceAll('\r','\n').replace(/[ℓ]/g,'L').replace(/[−–]/g,'-').replace(/(\d),\s+(\d{3})/g,'$1,$2');
  const lines=normalized.split('\n').map(l=>l.replace(/[\t ]+/g,' ').trim()).filter(Boolean);
  const candidates=collectPrices(lines,warnings),quantity=extractQuantity(lines,warnings),identity=extractNameAndSpec(lines);
  const totals=candidates.filter(c=>c.kind!=='unit');
  const sales=totals.filter(c=>c.kind==='sale');
  const explicitTotals=totals.filter(c=>c.kind==='total'&&c.explicit);
  let costcoPrice=null;
  if(unique(totals.map(c=>c.amount)).length===1)costcoPrice=totals[0].amount;
  else if(sales.length&&unique(sales.map(c=>c.amount)).length===1&&!explicitTotals.some(c=>c.amount!==sales[0].amount))costcoPrice=sales[0].amount;
  else if(!sales.length&&explicitTotals.length&&unique(explicitTotals.map(c=>c.amount)).length===1)costcoPrice=explicitTotals[0].amount;
  if(costcoPrice===null&&totals.length>1)warnings.push('판매가격이 여러 개 읽혔습니다. 정상가·행사가·적용 조건을 보고 실제 구매가를 선택하세요.');
  if(!totals.length)warnings.push('신뢰할 수 있는 묶음 판매가격을 찾지 못했습니다. 상품번호·날짜·단가를 판매가로 사용하지 마세요.');
  if(sales.length)warnings.push('행사·할인가가 읽혔습니다. 할인 적용 조건과 행사 기간을 확인하세요.');
  let unit=quantity.unit,costcoUnitPrice=null;
  const unitPrices=candidates.filter(c=>c.kind==='unit'&&c.per).map(c=>({unit:c.per.unit,amount:c.amount*((c.per.unit==='100g'||c.per.unit==='100mL'?100:1)/c.per.quantity)}));
  if(unitPrices.length) {
    const allowed=unit?unitPrices.filter(u=>u.unit===unit):unitPrices;
    if(allowed.length&&allowed.every(u=>u.unit===allowed[0].unit&&close(u.amount,allowed[0].amount))) {unit=unit||allowed[0].unit;costcoUnitPrice=allowed[0].amount;}
    else warnings.push('표시 단가의 기준 단위가 다르거나 단가 후보가 여러 개입니다. 직접 확인하세요.');
  }
  if(quantity.quantity===null)warnings.push('묶음 전체의 총수량을 확정하지 못했습니다. 매수·용량·개수를 직접 확인하세요.');
  if(!identity.name)warnings.push('제품명을 읽지 못했습니다. 브랜드와 정확한 제품명을 입력하세요.');
  if(costcoPrice!==null&&quantity.quantity!==null&&costcoUnitPrice!==null) {
    const calculated=costcoPrice/quantity.quantity*(unit==='100g'||unit==='100mL'?100:1);
    if(Math.abs(calculated-costcoUnitPrice)>Math.max(1,calculated*.02))warnings.push('판매가·총수량으로 계산한 단가와 표시 단가가 다릅니다. 규격이나 할인 전 단가인지 확인하세요.');
  }
  return {...identity,unit,costcoPrice,costcoQuantity:quantity.quantity,costcoUnitPrice,
    priceCandidates:candidates.map(({amount,label,kind})=>({amount,label,kind})),warnings:unique(warnings)};
}

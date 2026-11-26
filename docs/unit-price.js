/**
 * Unit-price helpers for shop labels and manual entry.
 * Quantity extraction is a SUGGESTION, not an authoritative parse of a product label.
 * All prices are KRW. The raw quantity uses 개, g, mL or m based on unit.
 */
import {factor,rawUnit} from './core.js';

const packUnits='개|입|봉|봉지|팩|통|병|상자|박스|세트|묶음|롤|캔|포|개입';
const pieceUnits='매입|장입|캡슐입|정입|개입|매|장|개|캡슐|정|알|롤|포|입';
const number='(\\d+(?:\\.\\d+)?)';
const packRe=new RegExp(`^\\s*(?:[x×*]\\s*)?${number}\\s*(?:${packUnits}|${pieceUnits})(?![가-힣a-zA-Z])`,'i');
const crossRe=new RegExp(`^\\s*[x×*]\\s*${number}(?![\\d.a-zA-Z가-힣])`,'i');
function clean(spec) {
  return String(spec||'').replace(/(?<=\d),(?=\d{3}(?!\d))/g,'').replace(/\s+/g,' ').trim();
}
function multiplier(text) {
  const m=text.match(packRe)||text.match(crossRe);
  if(!m) return /^\s*[x×*]\s*\d/i.test(text)?null:1;
  // Do not silently ignore another nested package or an incompatible measure.
  if(/^\s*[x×*]\s*\d/i.test(text.slice(m[0].length))) return null;
  return Number(m[1]);
}
function meaningful(n){return Number.isFinite(n)&&n>0&&n<=1e9?n:null;}
function precedingMultiplier(prefix) {
  const pattern=new RegExp(`${number}\\s*(?:${packUnits})?\\s*[x×*]\\s*$`,'i');
  const m=prefix.match(pattern);
  if(m&&/[x×*]\s*$/i.test(prefix.slice(0,m.index))) return null;
  return m?Number(m[1]):1;
}

function packageMultiplier(prefix,suffix) {
  const before=precedingMultiplier(prefix),after=multiplier(suffix);
  return before===null||after===null?null:before*after;
}

export function suggestQuantity(spec,unit) {
  const text=clean(spec);
  if(!text) return null;
  // Mixed sets and ranges require confirmation instead of guessing one component.
  if(/[+＋~～]/.test(text)||/\d\s*[-–—]\s*\d/.test(text)) return null;
  let n=null;
  if(unit==='100g'||unit==='100mL'||unit==='m') {
    const target=unit==='100g'?'(kg|g)':unit==='100mL'?'(ml|mL|l|L)':'(m|미터)';
    const rex=new RegExp(`${number}\\s*${target}(?![a-zA-Z가-힣])`,unit==='m'?'g':'gi');
    const m=rex.exec(text);
    if(!m||rex.exec(text)) return null;
    const size=Number(m[1]);
    const measure=m[2].toLowerCase();
    const conversion=unit==='100g'?(measure==='kg'?1000:1):unit==='100mL'?(measure==='l'?1000:1):1;
    const rest=text.slice(m.index+m[0].length);
    n=size*conversion*packageMultiplier(text.slice(0,m.index),rest);
    // Also accept e.g. "30m 30롤" and "500mL 3개"; but not arbitrary numbers.
    return meaningful(n);
  }
  if(unit!=='개') return null;
  const piece=new RegExp(`${number}\\s*(?:${pieceUnits})(?![가-힣a-zA-Z])`,'i').exec(text);
  if(piece) {
    const rest=text.slice(piece.index+piece[0].length);
    n=Number(piece[1])*packageMultiplier(text.slice(0,piece.index),rest);
    return meaningful(n);
  }
  // Bottle/pack count when comparing per physical item, e.g. "500mL × 3병".
  const pack=new RegExp(`${number}\\s*(?:${packUnits})(?![가-힣a-zA-Z])`,'gi');
  let match,last=null,total=1;
  while((match=pack.exec(text))) {
    if(last&&!/^\s*[x×*]\s*$/i.test(text.slice(last.index+last[0].length,match.index))) return null;
    total*=Number(match[1]);
    last=match;
  }
  return last?meaningful(total):null;
}

/** Quote with a separate product-only unit price and checkout price. */
export function calculateUnitPrices({price,quantity,unit,shipping=null,discount=0}) {
  const p=Number(price),q=Number(quantity),d=Number(discount);
  const valid=price!==null&&price!==undefined&&price!==''&&quantity!==null&&quantity!==undefined&&quantity!=='' && Number.isFinite(p)&&p>0&&Number.isFinite(q)&&q>0&&Number.isFinite(d)&&d>=0&&d<p;
  if(!valid||!['개','100g','100mL','m'].includes(unit)) return {productUnitPrice:null,finalUnitPrice:null,productTotal:null,checkoutTotal:null};
  const productTotal=p-d;
  const productUnitPrice=productTotal/q*factor(unit);
  const shippingKnown=shipping!==null&&shipping!==undefined&&String(shipping).trim()!==''&&Number.isFinite(Number(shipping))&&Number(shipping)>=0;
  const checkoutTotal=shippingKnown?productTotal+Number(shipping):null;
  const finalUnitPrice=checkoutTotal===null?null:checkoutTotal/q*factor(unit);
  return {productUnitPrice,finalUnitPrice,productTotal,checkoutTotal};
}

export function unitPriceCaption(unit){return unit==='개'?'1개당':unit==='m'?'1m당':`${unit}당`;}
export function rawQuantityCaption(quantity,unit){return `${quantity}${rawUnit(unit)}`;}

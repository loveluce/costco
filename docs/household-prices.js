import {normalizeGtin} from './barcode.js';

// Current Korean shelf prices and receipts use UTC+09:00. ISO output is the
// same in browsers and in the spreadsheet's independently configured timezone.
function koreanDay(time) {
  return new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function text(value) {
  return String(value ?? '').normalize('NFKC').trim().toLowerCase();
}

function number(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function count(value) {
  const n = number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function perPiece(price, pieceCount) {
  const amount = number(price);
  const pieces = count(pieceCount);
  return amount > 0 && pieces !== null ? amount / pieces : null;
}

export function naverComparison(costcoPrice, costcoCount, naverPrice, naverCount, shipping) {
  const costcoPerPiece = perPiece(costcoPrice, costcoCount);
  const fee = number(shipping);
  const price = number(naverPrice);
  const naverPerPiece = fee !== null && fee >= 0 && price > 0 ? perPiece(price + fee, naverCount) : null;
  const savingPerPiece = costcoPerPiece !== null && naverPerPiece !== null ? naverPerPiece - costcoPerPiece : null;
  return {costcoPerPiece, naverPerPiece, savingPerPiece};
}

function productName(row) {
  return text(row.product).replace(/\s+/g, '');
}

function itemNumber(row) {
  return text(row.itemNo).replace(/^#\s*/, '');
}

function barcode(row) {
  const valid = normalizeGtin(String(row.barcode ?? ''));
  return valid ? valid.padStart(14, '0') : '';
}

// A conflicting identifier takes precedence over a matching name or another identifier.
function identity(left, right) {
  const leftItem = itemNumber(left), rightItem = itemNumber(right);
  const leftCode = barcode(left), rightCode = barcode(right);
  if (leftItem && rightItem && leftItem !== rightItem) return 'conflict';
  if (leftCode && rightCode && leftCode !== rightCode) return 'conflict';
  if ((leftCode && leftCode === rightCode) || (leftItem && leftItem === rightItem)) return 'identified';
  return 'unknown';
}

function day(value) {
  const s = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const n = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === s ? s : '';
}

function stamp(row) {
  const time = Date.parse(row.saved_at ?? '');
  const registeredDay = Number.isFinite(time) ? koreanDay(time) : '';
  const eventDay = day(row.purchasedOn || row.observedOn || registeredDay);
  return {day: eventDay, time: registeredDay === eventDay && eventDay ? time : null};
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

function searchableName(row, query) {
  const name = productName(row);
  return query.split(/\s+/u).filter(Boolean).every(token => name.includes(token));
}

// Text search lists candidates across all stores and package variants. The object form also
// uses the identifiers scanned from the current price label and rejects conflicting IDs.
export function searchHistory(rows, query = '') {
  const draft = typeof query === 'object' && query !== null ? query : null;
  const q = text(draft ? draft.product : query);
  const id = q.replace(/^#\s*/, '');
  const gtin = draft || !q ? '' : barcode({barcode: q});
  const hits = rows.filter(row => {
    if (draft) {
      const match = identity(row, draft);
      if (match !== 'unknown') return match === 'identified';
      return Boolean(q && searchableName(row, q));
    }
    return !q || itemNumber(row) === id || (gtin && barcode(row) === gtin) || searchableName(row, q);
  });
  return hits.sort(newestFirst);
}

function storeName(shop) {
  return text(shop).replace(/\s+/g, '').replace(/^(?:코스트코(?:코리아|홀세일)?|costco(?:wholesale)?)/, '').replace(/점$/, '');
}

function namedStore(shop) {
  const name = storeName(shop);
  return name && !['매장','매장명','지점','오프라인','온라인','온라인몰','본','미상','기타'].includes(name) &&
    !/온라인|쇼핑몰|이마트|트레이더스|쿠팡|네이버|홈플러스|롯데마트/.test(name);
}

function pack(row) {
  return text(row.pack).replace(/\s+/g, '').replace(/[×✕*]/g, 'x');
}

function quantity(row) {
  const amount = number(row.quantity);
  const unit = text(row.unit);
  if (!(amount > 0)) return null;
  switch (unit) {
    case 'kg': return ['g', amount * 1000];
    case 'l': return ['ml', amount * 1000];
    case 'g': case 'ml': case '개': case '매': case 'm': return [unit, amount];
    default: return null;
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
  // A shared GTIN plus a matching recorded amount can identify the package
  // when someone entered only the count and left the package description blank.
  return Boolean(barcode(a) && barcode(a) === barcode(b) && ((qa && qb) || (pa !== null && pb !== null)));
}

export function previousPrices(rows, draft) {
  if (!draft) return [];
  const reference = stamp(draft);
  return rows.filter(row => {
    if (sameEntry(row, draft) || !(number(row.price) > 0) || !comparable(row, draft)) return false;
    const match = identity(row, draft);
    if (match === 'conflict') return false;
    if (match === 'unknown' && (!productName(draft) || productName(row) !== productName(draft))) return false;
    const date = stamp(row);
    if (reference.day && (date.day > reference.day || (date.day === reference.day && reference.time !== null && date.time !== null && date.time >= reference.time))) return false;
    return Boolean(date.day);
  }).sort(newestFirst);
}

function identityKeys(row) {
  const keys = [];
  const item = itemNumber(row), gtin = barcode(row);
  if (item) keys.push('item:' + item);
  if (gtin) keys.push('gtin:' + gtin);
  return keys;
}

// Alerts compare the latest known offer at the purchase branch. Historical low prices stop
// generating alerts when a newer comparable observation records a higher price.
export function priceMatchAlerts(rows) {
  const asOf = koreanDay(Date.now());
  const byId = new Map();
  const indexed = [];
  const purchases = [];
  const seen = new Set();
  for (const row of rows) {
    if (row.submission && seen.has(row.submission)) continue;
    if (row.submission) seen.add(row.submission);
    const date = stamp(row);
    if (!(number(row.price) > 0) || !date.day || date.day > asOf || !namedStore(row.shop)) continue;
    const keys = identityKeys(row);
    if (!keys.length || (text(row.barcode) && !barcode(row))) continue;
    const candidate = {row, date, keys: keys.map(key => storeName(row.shop) + '|' + key)};
    indexed.push(candidate);
    if (day(row.purchasedOn)) purchases.push(candidate);
  }
  const byDate = (a, b) => b.date.day.localeCompare(a.date.day) || (b.date.time ?? 0) - (a.date.time ?? 0) ||
    (number(b.row.seq) ?? 0) - (number(a.row.seq) ?? 0);
  for (const candidate of indexed.sort(byDate)) {
    for (const key of candidate.keys) {
      if (!byId.has(key)) byId.set(key, []);
      byId.get(key).push(candidate);
    }
  }
  const alerts = [];
  for (const {row: purchase, date: bought, keys} of purchases) {
    const latestDay = new Set();
    let latestDate = '';
    for (const key of keys) {
      for (const option of byId.get(key)) {
        const {row, date} = option;
        // Every index is date-sorted. Older entries cannot supersede a confirmed
        // price at this branch; still examine ties and the other identifier.
        if (date.day < latestDate || date.day < bought.day) break;
        if (sameEntry(row, purchase) || !after(date, bought) ||
            identity(row, purchase) !== 'identified' || !comparable(row, purchase)) continue;
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
    const uncertain = later.some(({date, row}) => date.day === latest.date.day &&
      (date.time === null || date.time === latest.date.time) && number(row.price) !== number(latest.row.price));
    if (uncertain) continue;
    const saving = number(purchase.price) - number(latest.row.price);
    if (saving <= 0) continue;
    const purchaseId = purchase.submission || [keys[0], purchase.seq, purchase.saved_at, purchase.purchasedOn, purchase.price].join('|');
    alerts.push({key: purchaseId + ':' + latest.row.price, purchase, offer: latest.row, saving});
  }
  return alerts.sort((a,b) => newestFirst(a.offer, b.offer) || newestFirst(a.purchase, b.purchase));
}

import { searchLinks } from './core.js';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => value.toLocaleString('ko-KR', {maximumFractionDigits: 2}) + '원';
const clock = value => new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}).format(new Date(value));
const timeOnly = value => new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul', hour:'2-digit', minute:'2-digit'}).format(new Date(value));
const safeSource = value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      /^(?:(?:www\.|m\.)?coupang\.com|(?:www\.)?xixi\.co\.kr|(?:www\.)?kurly\.com|(?:www\.)?costco\.co\.kr|(?:m\.)?(?:brand|smartstore)\.naver\.com)$/.test(url.hostname) ? url.href : '';
  } catch { return ''; }
};
export const freshReading = (row, now = Date.now()) => {
  const last = row.history.at(-1);
  if (!row.active || row.error || !last || !row.lastAttempt || last.method !== 'collector' || last.time !== row.lastAttempt) return null;
  const age = now - Date.parse(last.time);
  return age >= 0 && age <= 36 * 3600000 ? last : null;
};
const unitPrice = (row, price) => price / row.quantity * (['mL','g'].includes(row.unit) ? 100 : 1);
const unitLabel = row => (['mL','g'].includes(row.unit) ? '100' : '1') + row.unit;
const shopName = shop => shop === '코스트코' ? '코스트코 온라인몰' : shop;
function status(row, reading) {
  if (row.error) return '수집 실패';
  if (!row.lastAttempt) return '첫 자동 수집 대기';
  return reading ? '수집 완료' : '갱신 대기';
}

function sourceEntry(row, reading, bestPrice, comparableCount) {
  const eligible = !!reading && comparableCount > 1 && bestPrice === unitPrice(row, reading.price);
  const last = row.history.at(-1);
  const url = safeSource(row.url);
  return `<tr><td><strong>${escapeHtml(shopName(row.shop))}</strong>${url ? `<a class="public-product-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">상품 페이지</a>` : ''}<a class="public-product-link" href="${escapeHtml(searchLinks({name:row.name}).naver)}" target="_self" rel="noopener noreferrer">네이버에서 검색</a></td>
    <td>${escapeHtml(row.pack)}</td><td><strong>${reading ? money(reading.price) : '—'}</strong>
    ${!reading && last ? `<small>이전 ${money(last.price)} · ${escapeHtml(last.day)}</small>` : ''}</td>
    <td>${reading ? money(unitPrice(row, reading.price)) + ' / ' + unitLabel(row) : '—'}${eligible ? '<small class="price-down">비교 최저</small>' : ''}</td>
    <td>${status(row, reading)}${row.lastAttempt ? `<small>${clock(row.lastAttempt)}</small>` : ''}${row.error ? `<small>${escapeHtml(row.error)}</small>` : ''}</td></tr>`;
}

function observations(rows) {
  const history = rows.flatMap(row => row.history.map(point => ({row, point})))
    .sort((a, b) => (b.point.time || b.point.day).localeCompare(a.point.time || a.point.day));
  if (!history.length) return '';
  return `<details class="public-history"><summary>확인한 가격 이력 ${history.length}건</summary><div class="history-table-wrap"><table class="history-table"><thead><tr><th>확인일</th><th>상품 · 판매처</th><th>상품가격</th><th>단가</th></tr></thead><tbody>
    ${history.map(({row, point}) => `<tr><td>${point.time ? escapeHtml(point.day) + ' ' + timeOnly(point.time) : escapeHtml(point.day)}
      <small>${point.method === 'collector' ? '자동 수집' : '초기 공식 페이지 확인'}</small></td><td>${escapeHtml(row.name)}<small>${escapeHtml(shopName(row.shop))} · ${escapeHtml(row.pack)}</small></td>
      <td>${money(point.price)}</td><td>${money(unitPrice(row, point.price))} / ${unitLabel(row)}</td></tr>`).join('')}
    </tbody></table></div></details>`;
}

export function onlinePanel(feed, failure = false) {
  let body;
  if (failure) body = '<p role="alert">수집 결과를 불러오지 못했습니다. 페이지를 새로고침해 주세요.</p>';
  else if (!feed) body = '<p role="status">쇼핑몰 가격을 불러오는 중입니다.</p>';
  else {
    const groups = new Map();
    for (const row of feed.offers.filter(row => row.active)) {
      const key = JSON.stringify([row.name, row.unit]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const countFresh = rows => rows.filter(row => freshReading(row)).length;
    const ordered = [...groups.values()].sort((a,b) => countFresh(b) - countFresh(a));
    body = ordered.map(rows => {
      rows.sort((a,b) => {
        const first=freshReading(a), second=freshReading(b);
        if (first && second) return unitPrice(a,first.price) - unitPrice(b,second.price);
        return Number(Boolean(second)) - Number(Boolean(first));
      });
      const readings = rows.map(row => freshReading(row));
      const valid = rows.flatMap((row, i) => readings[i] ? [unitPrice(row, readings[i].price)] : []);
      return `<div class="public-group"><h3>${escapeHtml(rows[0].name)}</h3>
        <div class="history-table-wrap"><table class="history-table"><thead><tr><th>판매처</th><th>포장</th><th>수집 상품가격</th><th>비교 단가</th><th>최근 조회</th></tr></thead>
        <tbody>${rows.map((row, i) => sourceEntry(row, readings[i], Math.min(...valid), valid.length)).join('')}</tbody></table></div></div>`;
    }).join('') || '<p>공개 수집 목록에 등록한 상품이 없습니다.</p>';
    body += observations(feed.offers);
  }
  return `<section class="panel public-prices" id="online-price-panel"><div class="section-heading"><div><h2>쇼핑몰 자동 수집 가격</h2><p>같은 상품의 온라인 표시가격을 포장 총량으로 나눴습니다. 추가 배송비·개인 쿠폰은 계산에서 제외합니다.</p></div></div>${body}</section>`;
}

export async function getOnlineFeed() {
  const result = await fetch(new URL('./public-prices.json', import.meta.url), {cache:'no-store'});
  if (!result.ok) throw new Error('가격 파일을 열지 못했습니다.');
  const feed = await result.json();
  if (feed.version !== 1 || !Array.isArray(feed.offers)) throw new Error('가격 파일의 형식을 확인해 주세요.');
  return feed;
}

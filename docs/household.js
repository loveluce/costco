import {isConfigured, hasSession, login, logout, listPrices, listOnlinePrices, savePrice, updatePrice} from './household-api.js';
import {openPhotoImport} from './photo-import.js';
import {normalizeGtin} from './barcode.js';
import {today} from './core.js';
import {naverComparison as compareOffer, perPiece, previousPrices, priceMatchAlerts, searchHistory} from './household-prices.js';
import {naverShoppingUrl, naverSearchUrl, parseNaverListing} from './household-naver.js';
import {coupangSearchUrl, parseCoupangListing} from './household-shopping.js';
import {initLegacyImport} from './legacy-import.js';

import {initOnlineRecords, clipboardListing, sharedListing} from './online-records.js';

const markets = [
  {id:'naver',name:'네이버',search:naverShoppingUrl,parse:parseNaverListing},
  {id:'coupang',name:'쿠팡',search:coupangSearchUrl,parse:parseCoupangListing},
];

const el = id => document.getElementById(id);
const record = el('record');
const field = name => record.elements.namedItem(name);
const numberInput = input => input.value.trim() === '' ? null : Number(input.value);
const currency = new Intl.NumberFormat('ko-KR', {maximumFractionDigits:2});
const amount = value => value == null || !Number.isFinite(value) ? '—' : currency.format(value) + '원';
const kstDay = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'});
const displayDay = row => row.purchasedOn || row.observedOn || (row.saved_at ? kstDay.format(new Date(row.saved_at)) : '');
const rowsPerPage = 25;
let rows = [], alertItems = [], resultsFor = null, historyLimit = rowsPerPage;
let epoch = 0, revision = 0, view = 'lookup', active = false, saving = false;
let lastLoad = 0, loadPromise = null, importMounted = false;
let retry = null, savedSignature = '', photoDraft = false;
let previewUUID = crypto.randomUUID();
let editingCostco = null, selectedParent = '', customSearch = null, typingLookup = false;
const online = initOnlineRecords({
  context:offerContext, costcoRows:()=>rows, epoch:()=>epoch, active:()=>active, onAuthError:sessionError,
  onWrite:()=>{ revision++; loadPromise=null; lastLoad=0; void loadRows(true); },
  openProduct:openOfferProduct, update:updateComparisons, showMarket, amount
});

function offerContext() {
  const d=draftValues();
  return {product:d.product,pack:d.pack,itemNo:d.itemNo,barcode:d.barcode,parent:selectedParent || previewUUID};
}

function node(tag, txt = '', cls = '') {
  const n = document.createElement(tag);
  if (txt) n.textContent = txt;
  if (cls) n.className = cls;
  return n;
}
function status(id, message = '', error = false) {
  const target = el(id);
  target.textContent = message;
  target.classList.toggle('error', error);
}
function showView(which, scroll = true) {
  if (!['lookup','history','alerts'].includes(which)) return;
  view = which;
  for (const name of ['lookup','history','alerts']) el(name).hidden = name !== which;
  el('nav').querySelectorAll('button').forEach(btn => {
    if (btn.dataset.view === which) btn.setAttribute('aria-current','page');
    else btn.removeAttribute('aria-current');
  });
  if (scroll) window.scrollTo({top:0,behavior:'auto'});
}
function authScreen(message = '') {
  active = false; epoch++; revision++; loadPromise = null; saving = false; lastLoad = 0;
  rows = []; alertItems = []; resultsFor = null; importMounted = false;
  online.clear();
  if (el('photo-dialog').open) el('photo-dialog').close();
  el('photo-dialog').replaceChildren();
  for (const id of ['unit-value','home-alert','nav-count','match-count','purchase-hint']) el(id).textContent = '';
  setSearchLink('naver-fallback','');
  for (const element of record.elements) element.disabled = false;
  for (const id of ['recent','matches','history-list','alert-list','previous','preview-alert','shops','legacy-content']) el(id).replaceChildren();
  el('workspace').hidden = el('exit').hidden = el('nav').hidden = el('legacy-import').hidden = true;
  el('lock').hidden = false;
  el('online-setup-help').hidden = true;
  el('pass').value = ''; el('remember').checked = el('remember').defaultChecked; el('query').value = ''; el('history-query').value = '';
  historyLimit = rowsPerPage;
  updateShortcuts();
  clearDraft();
  status('lookup-msg'); status('sync-msg'); status('login-msg',message);
}
function sessionError(err) {
  if (err?.code !== 'AUTH') return false;
  logout();
  authScreen('다시 입장하려면 공동 비밀번호를 입력하세요.');
  return true;
}
async function enter() {
  epoch++; active = true;
  el('lock').hidden = true;
  el('nav').hidden = el('exit').hidden = el('workspace').hidden = false;
  showView('lookup', false);
  await loadRows(true);
}
el('login').addEventListener('submit', async event => {
  event.preventDefault();
  if (!isConfigured()) return;
  const btn = el('login-btn'); btn.disabled = true;
  status('login-msg','비밀번호를 확인하고 있어요.');
  try {
    await login(el('pass').value, el('remember').checked);
    el('pass').value = '';
    await enter();
  } catch (err) {
    status('login-msg', err.message || '입장하지 못했어요. 비밀번호와 연결 상태를 확인하세요.', true);
  } finally { btn.disabled = false; }
});
el('exit').addEventListener('click', () => { logout(); authScreen(); el('pass').focus(); });
window.addEventListener('household-session-ended', () => {
  if (active) authScreen('공동 가격표에서 로그아웃됐어요. 다시 입장하세요.');
});
document.querySelectorAll('[data-view]').forEach(btn => btn.addEventListener('click', () => { showView(btn.dataset.view); refreshIfDue(); }));
document.querySelectorAll('[data-reload]').forEach(btn => btn.addEventListener('click', () => loadRows(true)));

async function loadRows(force = false) {
  if (!active) return;
  if (!hasSession()) { sessionError({code:'AUTH'}); return; }
  if (loadPromise && !force) return loadPromise;
  const stamp = epoch, request = ++revision;
  const current = () => active && stamp === epoch && request === revision;
  status('sync-msg','공동 가격 기록을 불러오고 있어요.');
  const promise = (async () => {
    try {
      const all = [], allOffers = [], seenCursors = new Set();
      let cursor = null, offerPage, onlineError='';
      do {
        const page = await listPrices(cursor);
        if (!current()) return;
        if (cursor==null) {
          offerPage=page.offers; onlineError=page.offersError || '';
          const oldServer=!offerPage && !onlineError;
          el('online-setup-help').hidden=!oldServer;
          if (oldServer) onlineError='연결된 구글 시트 웹 앱이 이전 버전이에요. 온라인 가격을 저장하려면 Apps Script를 업데이트하세요.';
        }
        all.push(...page.rows);
        cursor = page.next;
        if (cursor != null) {
          if (seenCursors.has(cursor)) throw new Error('가격 기록의 다음 페이지를 읽지 못했어요.');
          seenCursors.add(cursor);
        }
      } while (cursor != null);
      if (offerPage) {
        try {
          const offerCursors=new Set();
          while (offerPage) {
            allOffers.push(...offerPage.rows);
            if (offerPage.next==null) break;
            if (offerCursors.has(offerPage.next)) throw new Error('온라인 기록 페이지를 읽지 못했어요.');
            offerCursors.add(offerPage.next);
            offerPage=await listOnlinePrices(offerPage.next);
            if (!current()) return;
          }
          online.replace(allOffers);
        } catch (err) {
          if (err.code==='AUTH') throw err;
          onlineError=err.message;
        }
      } else if (onlineError) online.replace([],onlineError);
      rows = all; lastLoad = Date.now();
      if (!importMounted) {
        initLegacyImport({onImported: () => loadRows(true), isAuthorized: () => active && hasSession()});
        importMounted = true;
      }
      redraw(); status('sync-msg',onlineError,Boolean(onlineError));
    } catch (err) {
      if (current() && !sessionError(err)) status('sync-msg',err.message || '가격 이력을 불러오지 못했어요. 새로고침해 주세요.',true);
    } finally { if (current()) loadPromise = null; }
  })();
  loadPromise = promise;
  return promise;
}
function refreshIfDue() {
  if (active && !hasSession()) { sessionError({code:'AUTH'}); return; }
  if (active && !saving && !document.hidden && Date.now() - lastLoad > 60000) loadRows();
}
document.addEventListener('visibilitychange', refreshIfDue);
window.addEventListener('pageshow', refreshIfDue);
setInterval(refreshIfDue,60000);

function draftValues() {
  const pieces = numberInput(field('pieceCount'));
  let quantity = numberInput(field('quantity')), unit = field('unit').value;
  if (pieces > 0 && quantity == null && !unit) { quantity = pieces; unit = '개'; }
  const day = field('day').value;
  return {
    product: field('product').value.trim(), shop:field('shop').value.trim(), pack:field('pack').value.trim(),
    itemNo:field('itemNo').value.trim(), barcode:field('barcode').value.trim(),
    price:numberInput(field('price')), pieceCount:pieces ?? (unit === '개' ? quantity : null),
    quantity, unit, observedOn:day, purchasedOn:field('kind').value === 'purchased' ? day : ''
  };
}
function draftRow() {
  const values = draftValues();
  const submission = editingCostco?.submission || (savedSignature && retry?.signature === JSON.stringify(values) ? retry.submission : previewUUID);
  return {...values,submission,saved_at:new Date().toISOString()};
}
function setSearchLink(id, url) {
  const link = el(id);
  link.hidden = !url;
  if (url) link.href = url;
  else link.removeAttribute('href');
}
function shoppingQuery(draft) {
  return (customSearch ?? (draft.product || draft.barcode || draft.itemNo || '')).trim();
}
function updateShortcuts() {
  const query = !active ? '' : typingLookup || el('product-work').hidden ? el('query').value.trim() : shoppingQuery(draftValues());
  el('online-shortcuts').hidden = !query;
  for (const market of markets) setSearchLink('lookup-'+market.id, market.search(query));
}
function pasteQuickOffer(clip, typed) {
  if (!active || saving || !clip) return false;
  if (el('product-work').hidden || typingLookup) {
    const product=typed && !typed.includes('https://') ? typed.trim().slice(0,140) : '';
    openDraft({product}); resultsFor=null; el('query').value=product;
  }
  typingLookup=false;
  showView('lookup',false); showMarket(clip.market); updateComparisons();
  online.importLink(clip.market,clip);
  el(clip.market+'-url').scrollIntoView({block:'center'});
  return true;
}
el('query').addEventListener('paste',event=>{
  if (pasteQuickOffer(clipboardListing(event.clipboardData),el('query').value)) event.preventDefault();
});
el('query').addEventListener('input', event => {
  if (event.inputType==='insertFromPaste' && pasteQuickOffer(sharedListing(el('query').value),'')) return;
  typingLookup=true; updateShortcuts();
});
el('market-query').addEventListener('input', () => {
  customSearch=el('market-query').value; typingLookup=false; updateComparisons();
});
el('market-query').addEventListener('blur', () => {
  if (customSearch!==null && !customSearch.trim()) { customSearch=null; updateComparisons(); }
});

function showMarket(id) {
  for (const market of markets) {
    const selected = market.id === id;
    const tab = el('market-tab-'+market.id);
    tab.setAttribute('aria-selected',String(selected));
    tab.tabIndex = selected ? 0 : -1;
    el(market.id+'-card').hidden = !selected;
  }
}
for (const [i,market] of markets.entries()) {
  const tab = el('market-tab-'+market.id);
  tab.addEventListener('click',() => showMarket(market.id));
  tab.addEventListener('keydown',event => {
    const steps = {ArrowLeft:-1, ArrowRight:1, Home:-i, End:markets.length-1-i};
    const step = steps[event.key];
    if (typeof step !== 'number') return;
    event.preventDefault();
    const next = markets[(i+step+markets.length)%markets.length].id;
    showMarket(next);
    el('market-tab-'+next).focus();
  });
}
document.querySelectorAll('[data-market-jump]').forEach(link => link.addEventListener('click',() => showMarket(link.dataset.marketJump)));
function clearMarketQuotes() {
  for (const {id} of markets) {
    for (const key of ['price','count','shipping','text']) el(id+'-'+key).value = '';
    el(id+'-paste-box').open = false;
    el(id+'-parse-msg').textContent = '';
    el(id+'-unit').textContent = '—';
    el(id+'-result').textContent = '';
    setSearchLink(id+'-search','');
  }
  el('online-summary').hidden = true;
  el('online-summary-list').replaceChildren();
  el('online-summary-text').textContent = '';
}
function clearDraft() {
  online.reset();
  editingCostco=null; selectedParent=''; customSearch=null; typingLookup=false;
  el('market-query').value='';
  el('entry-heading').textContent='상품과 가격';
  el('save').textContent='코스트코 가격 저장';
  record.reset(); field('day').value = today(); field('day').max = today();
  el('day-label').textContent = '가격 확인일';
  el('quantity-detail').open = false;
  el('printed').textContent = ''; el('printed').hidden = true; el('barcode-status').textContent = '';
  savedSignature = ''; retry = null; previewUUID = crypto.randomUUID(); photoDraft = false;
  clearMarketQuotes(); showMarket('naver'); status('save-msg');
  el('product-work').hidden = el('matches-panel').hidden = true;
  el('welcome').hidden = false;
}
function openDraft(values = {}) {
  clearDraft(); el('welcome').hidden = true; el('product-work').hidden = false;
  for (const [key,value] of Object.entries(values)) if (field(key)) field(key).value = value ?? '';
  el('quantity-detail').open = Boolean(field('unit').value || field('quantity').value);
}
function editCostco(row) {
  if (saving) return;
  openDraft({...row,kind:row.purchasedOn?'purchased':'observed',day:row.purchasedOn||row.observedOn});
  editingCostco=row; selectedParent=row.submission; resultsFor=null;
  el('entry-heading').textContent='코스트코 기록 수정'; el('save').textContent='수정 저장';
  el('query').value=row.product; showView('lookup'); updateComparisons();
  el('entry-card').scrollIntoView({block:'start'});
}
function openOfferProduct(offer) {
  if (saving || !active) return false;
  const parent=rows.find(r=>r.submission===offer.parent);
  if (parent) { selectRow(parent); return; }
  openDraft({product:offer.product,pack:offer.pack,itemNo:offer.itemNo,barcode:offer.barcode});
  selectedParent=offer.parent; resultsFor=null; el('query').value=offer.product;
  if (!offer.product && offer.title) { customSearch=offer.title; el('market-query').value=offer.title; }
  showView('lookup'); updateComparisons();
}
function recordButton(row, action) {
  const btn = node('button','','hh-row'); btn.type = 'button';
  const title = node('span','','hh-row-text'), end = node('span','','hh-row-cost');
  title.append(node('b',row.product),node('small',[row.shop,row.pack,displayDay(row),row.purchasedOn ? '실제 구매' : '가격 확인'].filter(Boolean).join(' · ')));
  if (row.itemNo || row.barcode) title.append(node('small',[row.itemNo && '상품번호 '+row.itemNo,row.barcode && '바코드 '+row.barcode].filter(Boolean).join(' · ')));
  end.append(node('b',amount(row.price)));
  const pp = perPiece(row.price,row.pieceCount ?? (row.unit === '개' ? row.quantity : null));
  if (pp != null) end.append(node('small','개당 '+amount(pp)));
  btn.append(title,end);
  btn.addEventListener('click', () => action(row));
  return btn;
}
function renderRows(id, records, empty, action, limit = records.length) {
  const container = el(id);
  container.replaceChildren();
  if (!records.length) { container.append(node('p',empty,'hh-empty')); return; }
  for (const row of records.slice(0,limit)) {
    const pick=recordButton(row,action);
    if (id!=='history-list') { container.append(pick); continue; }
    const wrapper=node('div','','hh-edit-row'), edit=node('button','수정','hh-link');
    edit.type='button'; edit.setAttribute('aria-label',row.product+' 매장 기록 수정');
    edit.addEventListener('click',()=>editCostco(row));
    wrapper.append(pick,edit); container.append(wrapper);
  }
}
function selectRow(row, fromScan = false) {
  if (saving) return;
  const keys = ['product','shop','pack','itemNo','barcode','pieceCount','quantity','unit'];
  const values = Object.fromEntries(keys.map(key => [key, row[key]]));
  if (fromScan && photoDraft) {
    for (const key of keys) {
      if (!field(key).value && values[key] != null) field(key).value = values[key];
    }
    el('quantity-detail').open = Boolean(field('unit').value);
    status('lookup-msg','빈 항목에 이전 기록을 채웠어요. 현재 가격표와 매장·규격이 같은지 확인하세요.');
    photoDraft = false;
  } else {
    openDraft(values);
    status('lookup-msg','이 상품의 이전 기록을 불러왔어요. 새 가격을 기록할 때는 현재 판매가를 입력하세요.');
  }
  selectedParent=row.submission;
  resultsFor = null; el('matches-panel').hidden = true;
  el('query').value = field('product').value;
  showView('lookup');
  updateComparisons();
  el('product-work').scrollIntoView({block:'start'});
}
function showMatches() {
  if (!resultsFor) { el('matches-panel').hidden = true; return; }
  const hits = searchHistory(rows,resultsFor);
  const distinct = new Map();
  for (const row of hits) {
    const key = JSON.stringify([row.product,row.itemNo,row.barcode,row.shop,row.pack,row.quantity,row.unit,row.pieceCount]);
    if (!distinct.has(key)) distinct.set(key,row);
  }
  const candidates = [...distinct.values()];
  renderRows('matches',candidates,'일치하는 공동 기록이 없어요. 아래에서 상품을 확인하고 첫 가격을 등록하세요.',row => selectRow(row,true));
  el('matches-panel').hidden = false; el('match-count').textContent = candidates.length+'개';
}
function search() {
  if (saving) return;
  const query = el('query').value.trim();
  if (!query) { status('lookup-msg','상품명, 상품번호 또는 바코드를 입력하세요.',true); el('query').focus(); return; }
  if (pasteQuickOffer(sharedListing(query),'')) return;
  const digits = /^#?\d+$/.test(query);
  const gtin = digits ? normalizeGtin(query) : '';
  openDraft(digits ? (gtin ? {barcode:gtin} : {itemNo:query.replace(/^#/,'')}) : {product:query});
  const hits = searchHistory(rows,query);
  function sameListing(a,b) {
    return ['product','shop','pack','itemNo','barcode','quantity','unit','pieceCount'].every(key => (a[key] ?? '') === (b[key] ?? ''));
  }
  const first = hits[0];
  const tidy = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu,'').toLowerCase();
  if (first && hits.every(row => sameListing(row,first)) &&
      (tidy(query) === tidy(first.product) || query.replace(/^#/,'') === first.itemNo || (!!gtin && gtin === first.barcode))) {
    selectRow(first); return;
  }
  resultsFor = query; showMatches();
  status('lookup-msg'); updateComparisons();
}
el('lookup-form').addEventListener('submit', event => { event.preventDefault(); search(); });
el('open-online').addEventListener('click', () => {
  if (!active || saving) return;
  if (el('product-work').hidden || typingLookup) {
    if (el('query').value.trim()) search();
    else { resultsFor=null; openDraft(); updateComparisons(); }
  }
  const id=el('coupang-card').hidden ? 'naver' : 'coupang';
  el(id+'-url').focus();
  el('market-card').scrollIntoView({block:'start'});
});
function manual() {
  if (saving) return;
  resultsFor = null; openDraft(); el('query').value = '';
  status('lookup-msg'); updateComparisons(); field('product').focus();
}
el('manual').addEventListener('click', manual);
el('clear').addEventListener('click',manual);
el('photo-dialog').addEventListener('click', e => { if (e.target.closest('[data-action="close-dialog"]')) el('photo-dialog').close(); });
el('photo').addEventListener('click', () => {
  if (saving) return;
  openPhotoImport({dialog:el('photo-dialog'),onRecognized(draft) {
    el('photo-dialog').close();
    if (!active || !hasSession()) { sessionError({code:'AUTH'}); return; }
    const unit = draft.rawUnit || ({'100g':'g','100mL':'mL','개':'개','m':'m'})[draft.unit] || '';
    openDraft({
      product:draft.name,pack:draft.spec,itemNo:draft.sku,barcode:draft.barcode,price:draft.costcoPrice,
      pieceCount:draft.pieceCount,quantity:draft.costcoQuantity,unit:draft.costcoQuantity ? unit : ''
    });
    photoDraft = true;
    const row = draftValues();
    resultsFor = row.product || row.itemNo || row.barcode ? row : null;
    el('query').value = row.product || row.itemNo || row.barcode;
    const printed = draft.printedUnitPrice;
    if (printed && Number.isFinite(printed.amount)) {
      el('printed').hidden = false;
      el('printed').textContent = '가격표에 인쇄된 단가: '+amount(printed.amount)+(printed.basis ? ' / '+printed.basis : '')+'.';
    }
    const warnings = Array.isArray(draft.warnings) ? draft.warnings.join(' ') : '';
    status('lookup-msg', [draft.costcoPrice ? '읽은 판매가와 포장 개수를 확인하세요.' : '한 팩 판매가를 직접 확인해 입력하세요.',warnings].filter(Boolean).join(' '));
    showMatches(); updateComparisons();
  }});
});

el('barcode-photo').addEventListener('change', async event => {
  const input = event.target;
  const file = input.files?.[0];
  input.value = '';
  if (!file || saving) return;
  const draftId = previewUUID, stamp = epoch;
  const current = () => active && stamp === epoch && draftId === previewUUID;
  el('barcode-status').textContent = '제품 바코드를 읽고 있어요.';
  input.disabled = true;
  try {
    const {readBarcodePhoto} = await import('./photo-import.js');
    const barcode = await readBarcodePhoto(file);
    if (!current()) return;
    field('barcode').value = barcode;
    el('barcode-status').textContent = '바코드를 읽었어요. 포장에 적힌 숫자와 맞는지 확인하세요.';
    resultsFor = draftValues(); photoDraft = true; savedSignature = '';
    showMatches(); updateComparisons();
  } catch (err) {
    if (current()) el('barcode-status').textContent = err.message || '바코드를 읽지 못했어요. 포장에 적힌 숫자를 직접 입력하세요.';
  } finally { input.disabled = false; }
});

function displayAlert(alert) {
  const {purchase,offer,saving} = alert;
  const box = node('article','','hh-alert');
  box.append(node('b',purchase.product),node('p','한 팩 '+amount(saving)+' 인하','drop'),
    node('p','구매 '+displayDay(purchase)+' · '+amount(purchase.price)+' → 확인 '+displayDay(offer)+' · '+amount(offer.price)),
    node('small',[purchase.shop,purchase.pack,purchase.itemNo && '상품번호 '+purchase.itemNo,purchase.barcode && '바코드 '+purchase.barcode].filter(Boolean).join(' · ')));
  return box;
}
function updateAlerts() {
  alertItems = priceMatchAlerts(rows);
  const badge = el('nav-count'), home = el('home-alert'), list = el('alert-list');
  badge.hidden = home.hidden = !alertItems.length;
  badge.textContent = alertItems.length;
  home.textContent = '구매 후 가격이 내려간 기록 '+alertItems.length+'건 · 차액 문의할 상품 보기 →';
  list.replaceChildren();
  if (alertItems.length) list.append(...alertItems.map(displayAlert));
  else list.append(node('p','현재 차액 문의 후보가 없어요. 구매할 때 ‘실제 구매’를 선택하고 매장·상품번호 또는 바코드·포장 규격과 수량을 기록해 두세요.','hh-empty'));
}
function updateComparisons() {
  if (el('product-work').hidden) return;
  const draft = draftRow();
  const previous = previousPrices(rows,draft);
  const last = previous[0];
  const purchased = field('kind').value === 'purchased';
  el('day-label').textContent = purchased ? '구매일' : '가격 확인일';
  el('purchase-hint').textContent = purchased ?
    '가격 인하 알림을 받으려면 구매 지점, 상품번호 또는 바코드, 포장 규격과 수량을 함께 기록하세요.' : '';
  el('unit-value').textContent = amount(perPiece(draft.price,draft.pieceCount));
  const panel = el('previous'); panel.replaceChildren();
  if (!last) panel.append(node('p','같은 매장·상품·포장 규격과 수량의 기록을 찾으면 이전 판매가를 표시해요.','hh-empty'));
  else {
    if (draft.price > 0) {
      const change = draft.price - last.price;
      panel.append(node('p',change === 0 ? '직전 기록과 같은 가격' : '직전보다 한 팩 '+amount(Math.abs(change))+' '+(change < 0 ? '인하' : '인상'),'hh-delta'));
    }
    for (const row of previous.slice(0,4)) {
      const line = node('div','','hh-row');
      const value = node('span','','hh-row-cost');
      value.append(node('b', amount(row.price)));
      const each = perPiece(row.price, row.pieceCount ?? (row.unit === '개' ? row.quantity : null));
      if (each != null) value.append(node('small','개당 '+amount(each)));
      line.append(node('span',[displayDay(row),row.purchasedOn ? '구매' : '가격 확인'].join(' · '),'hh-meta'),value);
      panel.append(line);
    }
  }
  const notice = el('preview-alert'); notice.replaceChildren();
  if (draft.price > 0 && (draft.itemNo || draft.barcode) && last && !savedSignature) {
    const candidate = priceMatchAlerts([...searchHistory(rows,draft),draft]).find(a =>
      a.offer.submission === draft.submission || a.purchase.submission === draft.submission);
    if (candidate) {
      const n = node('div','','hh-callout');
      n.append(node('b','프라이스 매치 문의 후보'),displayAlert(candidate),
        node('small','구매 영수증을 준비해 해당 매장에 차액 조정 가능 여부를 확인하세요.'));
      notice.append(n);
    }
  }

  const query = shoppingQuery(draft);
  if (customSearch===null && el('market-query').value!==query) el('market-query').value=query;
  online.syncProduct();
  setSearchLink('naver-fallback',naverSearchUrl(query));
  updateShortcuts();
  const reference = draft.price > 0 ? draft : last;
  const refCount = reference?.pieceCount ?? (reference?.unit === '개' ? reference.quantity : null);
  const costcoUnit = perPiece(reference?.price,refCount);
  const costcoLabel = reference === draft ? '입력한 코스트코' : (last ? displayDay(last)+' 코스트코 기록' : '코스트코');
  const onlineUnits = [];
  for (const {id,name,search} of markets) {
    setSearchLink(id+'-search',search(query));
    const offer = compareOffer(reference?.price,refCount,numberInput(el(id+'-price')),
      numberInput(el(id+'-count')),numberInput(el(id+'-shipping')));
    const unit = offer.naverPerPiece;
    el(id+'-unit').textContent = amount(unit);
    const basis = costcoUnit == null ? '' : costcoLabel+' 개당 '+amount(costcoUnit);
    const diff = offer.savingPerPiece;
    let message = '';
    if (diff === 0) message = '두 곳의 개당 가격이 같아요.';
    else if (diff != null) message = (diff > 0 ? '코스트코가' : name+(id === 'coupang' ? '이' : '가'))+' 개당 '+amount(Math.abs(diff))+' 저렴해요.';
    el(id+'-result').textContent = [basis,message].filter(Boolean).join(' · ');
    if (unit != null) onlineUnits.push({label:name,unit});
  }
  renderQuoteSummary(costcoLabel,costcoUnit,onlineUnits);
  el('save').disabled = saving || (savedSignature !== '' && savedSignature === JSON.stringify(draftValues()));
}
record.addEventListener('input', event => {
  if (event.target===field('product')) {
    customSearch=null; typingLookup=false;
    el('query').value=field('product').value;
    if (photoDraft && resultsFor) { resultsFor=draftValues(); showMatches(); }
  }
  status('save-msg');
  if (retry?.signature !== JSON.stringify(draftValues())) { savedSignature = ''; }
  updateComparisons();
});
record.addEventListener('change', updateComparisons);
function renderQuoteSummary(costcoLabel,costcoUnit,onlineUnits) {
  const panel = el('online-summary'), list = el('online-summary-list');
  panel.hidden = onlineUnits.length < 2;
  list.replaceChildren();
  if (panel.hidden) return;
  const quotes = costcoUnit == null ? onlineUnits : [{label:costcoLabel,unit:costcoUnit},...onlineUnits];
  for (const {label,unit} of quotes) {
    const row = node('div');
    row.append(node('dt',label),node('dd',amount(unit)));
    list.append(row);
  }
  const [naver,coupang] = onlineUnits;
  const diff = naver.unit-coupang.unit;
  el('online-summary-text').textContent = diff === 0 ? '두 온라인 상품의 배송비 포함 개당 가격이 같아요.' :
    (diff > 0 ? '쿠팡이' : '네이버가')+' 개당 '+amount(Math.abs(diff))+' 저렴해요.';
}
for (const {id,parse} of markets) {
  for (const key of ['price','count','shipping']) el(id+'-'+key).addEventListener('input',updateComparisons);
  el('parse-'+id).addEventListener('click', () => {
    const data = parse(el(id+'-text').value);
    online.markDirty(id);
    for (const [key,input] of [['price','price'],['pieces','count'],['shipping','shipping']])
      el(id+'-'+input).value = data[key] ?? '';
    const labels = [['price','상품 가격'],['pieces','묶음 개수'],['shipping','배송비']];
    const missing = labels.filter(([key]) => data[key] == null).map(([,label]) => label);
    el(id+'-parse-msg').textContent = missing.length ? missing.join('·')+'를 직접 확인해 입력하세요.' : '읽은 상품 가격·개수·배송비를 확인하세요.';
    updateComparisons();
  });
}

function renderHistory() {
  const hits = searchHistory(rows,el('history-query').value);
  renderRows('history-list',hits,el('history-query').value.trim() ? '검색 결과가 없어요.' : '가족이 가격을 저장하면 이곳에 표시돼요.', row => selectRow(row),historyLimit);
  el('more-history').hidden = hits.length <= historyLimit;
}
function redraw() {
  online.renderHistory();
  renderRows('recent',searchHistory(rows,''),'아직 저장한 가격이 없어요.',row => selectRow(row),4);
  const stores = [...new Set(rows.map(row => row.shop).filter(Boolean))].sort();
  el('shops').replaceChildren(...stores.map(name => { const opt = node('option'); opt.value = name; return opt; }));
  renderHistory(); updateAlerts(); showMatches(); updateComparisons();
}
el('history-query').addEventListener('input', () => { historyLimit = rowsPerPage; renderHistory(); });
el('more-history').addEventListener('click', () => { historyLimit += rowsPerPage; renderHistory(); });

record.addEventListener('submit', async event => {
  event.preventDefault();
  if (!active || !hasSession()) { sessionError({code:'AUTH'}); return; }
  if (saving || !record.reportValidity()) return;
  const data = draftValues();
  if (editingCostco?.purchasedOn && data.purchasedOn && editingCostco.observedOn!==editingCostco.purchasedOn)
    data.observedOn=editingCostco.observedOn;
  if (data.barcode && !normalizeGtin(data.barcode)) {
    status('save-msg','바코드 숫자와 길이를 확인하세요. 코스트코 상품번호는 왼쪽 상품번호 칸에 입력하세요.',true);
    field('barcode').focus(); return;
  }
  if (data.quantity != null && !data.unit || data.unit && !(data.quantity > 0)) {
    el('quantity-detail').open = true;
    status('save-msg','총수량과 단위를 함께 입력하세요.',true); return;
  }
  if (data.unit === '개' && data.pieceCount != null && data.quantity !== data.pieceCount) {
    status('save-msg','총수량 단위가 개일 때는 한 팩에 든 개수와 총수량을 동일하게 입력하세요.',true); return;
  }
  const sig = JSON.stringify(data);
  if (sig === savedSignature) return;
  if (retry?.signature !== sig) {
    const existing=Boolean(retry) || rows.some(r=>r.submission===previewUUID);
    retry = {signature:sig,submission:editingCostco?.submission || (existing?crypto.randomUUID():previewUUID)};
  }
  const token = epoch, submission = retry.submission;
  saving = true; el('save').disabled = true;
  const controls = [...record.elements].filter(x => !x.disabled);
  for (const control of controls) control.disabled = true;
  status('save-msg','공동 가격표에 저장하고 있어요.');
  try {
    const editing=editingCostco;
    const input={...data,submission};
    const saved = editing ? await updatePrice(input,editing) : await savePrice(input);
    if (epoch !== token || !active) return;
    revision++; loadPromise = null;
    rows = [saved,...rows.filter(row => row.submission !== submission)];
    savedSignature = sig;
    if (editing) editingCostco=saved;
    selectedParent=saved.submission;
    redraw();
    status('save-msg',editing ? '기존 코스트코 기록을 수정했어요.' : '공동 가격표에 저장했어요. 가족이 ‘공동 기록’에서 볼 수 있어요.');
    loadRows(true);
  } catch (err) {
    if (epoch === token && !sessionError(err)) status('save-msg',err.message || '저장을 확인하지 못했어요. 같은 내용으로 다시 시도하세요.',true);
  } finally {
    if (epoch === token) {
      for (const control of controls) control.disabled = false;
      saving = false;
      updateComparisons();
    }
  }
});
authScreen();
if (!isConfigured()) {
  el('login').hidden = true;
  status('login-msg','운영자가 구글 시트 웹 앱을 연결하면 가격표를 열 수 있어요.');
} else if (hasSession()) {
  enter().catch(err => { if (!sessionError(err)) { logout(); authScreen('가격표를 열지 못했어요. 다시 입장하세요.'); } });
}

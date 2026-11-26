import { SHARED_API } from './app-config.js';
import { readPrices, supportsInvites, writePrice } from './shared-store.js';
import { searchLinks } from './core.js';
import { openPhotoImport } from './photo-import.js';

const el = id => document.getElementById(id);
const form = el('entry');
const field = name => form.elements.namedItem(name);
const names = new Set();
const money = new Intl.NumberFormat('ko-KR',{maximumFractionDigits:2});
const clock = new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Seoul'});
let next = null, reading = 0, retry = null;
let canRegister = false, saving = false;
function node(tag, text) {
  const result = document.createElement(tag);
  result.textContent = text;
  return result;
}
function entry(row) {
  const article = document.createElement('article');
  const amount = node('strong',money.format(row.price)+'원');
  amount.className = 'price';
  const per = ['mL','g'].includes(row.unit) ? 100 : 1;
  const time = node('time',clock.format(new Date(row.saved_at))+' 등록');
  const again = node('button','새 가격 입력');
  again.className = 'button slim';
  again.onclick = () => {
    if (form.querySelector('fieldset').disabled) return;
    for (const key of ['product','shop','pack','unit','quantity']) field(key).value = row[key];
    field('price').value = '';
    field('price').focus();
  };
  const link = node('a','네이버에서 검색');
  link.href = searchLinks({name:row.product}).naver;
  link.target = '_self'; link.rel = 'noopener noreferrer';
  article.append(node('strong',row.product),amount,node('span',row.shop+' · '+row.pack),
    node('span',per+row.unit+'당 '+money.format(row.price*per/row.quantity)+'원'),time);
  if (canRegister) article.append(again);
  article.append(link);
  return article;
}
async function load(older=false) {
  const id = ++reading;
  el('more').disabled = true;
  el('read-msg').textContent = '가격 이력을 읽는 중…';
  try {
    const data = await readPrices(older ? next : null);
    if (id !== reading) return;
    if (!older) { el('history').replaceChildren(); names.clear(); el('products').replaceChildren(); }
    for (const row of data.rows) {
      el('history').append(entry(row));
      if (!names.has(row.product)) {
        names.add(row.product);
        const option = document.createElement('option'); option.value = row.product; el('products').append(option);
      }
    }
    next = data.next;
    el('more').hidden = !next;
    el('read-msg').textContent = el('history').childElementCount ? '' : '아직 공동 가격 기록이 없어요.';
  } catch {
    if (id === reading) el('read-msg').textContent = '가격 이력을 불러오지 못했어요. 새로고침으로 다시 시도하세요.';
  } finally { if (id === reading) el('more').disabled = false; }
}
form.onsubmit = async event => {
  event.preventDefault();
  const controls = form.querySelector('fieldset');
  if (controls.disabled || !canRegister || saving) return;
  const inviteCode = el('invite-code').value.trim();
  const values = Object.fromEntries(new FormData(form));
  values.quantity = Number(values.quantity);
  values.price = Number(values.price);
  const signature = JSON.stringify(values);
  // A new code represents a different contributor. Bind retries to the same code and payload.
  if (retry?.signature !== signature || retry.inviteCode !== inviteCode) {
    retry = {signature,inviteCode,submission:crypto.randomUUID()};
  }
  saving = true;
  controls.disabled = true;
  el('save-msg').textContent = '공동 가격 저장 중…';
  try {
    await writePrice({...values,submission:retry.submission},inviteCode);
    retry = null;
    field('price').value = '';
    el('save-msg').textContent = '공동 가격표에 저장했어요.';
    await load();
  } catch (err) {
    el('save-msg').textContent = '저장 완료를 확인하지 못했어요. '+err.message+' 같은 내용으로 다시 시도할 수 있어요.';
  } finally {
    saving = false;
    controls.disabled = !canRegister;
  }
};
const dialog = el('editor');
dialog.onclick = event => { if (event.target.closest('[data-action="close-dialog"]')) dialog.close(); };
el('photo').onclick = () => openPhotoImport({dialog,onRecognized(draft) {
  dialog.close();
  field('product').value = draft.name || '';
  field('pack').value = draft.spec || '';
  field('quantity').value = draft.costcoQuantity || '';
  field('unit').value = ({'100mL':'mL','100g':'g','m':'m','개':'개'})[draft.unit] || '개';
  field('price').value = draft.costcoPrice || '';
  field('shop').value = '';
  el('save-msg').textContent = '판매처를 입력하고 인식된 값을 확인한 뒤 저장하세요.';
  field('shop').focus();
}});
async function refresh() {
  el('refresh').disabled = true;
  try {
    canRegister = await supportsInvites();
    el('access-msg').textContent = canRegister ? '' : '현재 조회만 가능해요. 운영자가 초대코드용 웹 앱을 연결하면 가격을 등록할 수 있어요.';
  } catch {
    canRegister = false;
    el('access-msg').textContent = '등록 권한을 확인하지 못했어요. 연결 상태를 확인하고 새로고침해 주세요.';
  }
  form.hidden = !canRegister;
  form.querySelector('fieldset').disabled = saving || !canRegister;
  await load();
  el('refresh').disabled = false;
}
if (SHARED_API) {
  el('refresh').onclick = refresh;
  el('more').onclick = () => load(true);
  refresh();
} else {
  el('access-msg').textContent = '운영자가 초대코드용 웹 앱을 연결하면 가격을 등록할 수 있어요.';
  el('refresh').disabled = true;
  el('read-msg').textContent = '운영자가 공동 저장 서버 주소를 연결하면 사용할 수 있어요.';
}

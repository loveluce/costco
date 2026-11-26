import {migrateLegacy, validateState} from './tracker-core.js';
import {savePrice} from './household-api.js';

const dayInKorea = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function legacyPrices(state) {
  const items = new Map(state.items.map(item => [item.id, item]));
  const sources = new Map(state.sources.map(source => [source.id, source]));
  const result = [];
  for (const observation of state.observations) {
    const item = items.get(observation.itemId);
    const source = sources.get(observation.sourceId);
    if (!item || !source || item.archived || source.archived || source.platform !== '코스트코' ||
        observation.deletedAt || observation.stock === '품절') continue;
    if (observation.price == null) continue;
    const price = observation.price - (observation.discount || 0);
    if (!Number.isSafeInteger(price) || price <= 0 || price > 1e9) continue;
    const unit = {'100g':'g', '100mL':'mL', '개':'개', 'm':'m'}[observation.unit];
    // The old tracker stored weight in grams and volume in mL even when the display unit was 100 g/mL.
    const quantity = observation.quantity;
    if (!unit || !(quantity > 0) || quantity > 1e9) continue;
    const row = {
      product:item.name, shop:source.store || source.seller || '코스트코',
      pack:source.variant || item.variant || '', itemNo:item.sku || '', barcode:'',
      unit, quantity, pieceCount:unit === '개' ? quantity : null, price,
      observedOn:dayInKorea.format(new Date(observation.observedAt)), purchasedOn:'',
    };
    result.push({key:observation.id, row});
  }
  return result;
}

async function submissionId(key) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode('한눈단가:코스트코-이전기록:' + key)));
  bytes[6] = (bytes[6] & 15) | 0x80;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = Array.from(bytes.slice(0,16), b => b.toString(16).padStart(2,'0')).join('');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}

export function initLegacyImport({onImported, isAuthorized}) {
  const box = document.getElementById('legacy-import');
  const content = document.getElementById('legacy-content');
  if (!box || !content || !isAuthorized()) return;
  const suffix = ':' + new URL('.',import.meta.url).pathname;
  const observations = new Map();
  const backups = [];
  let problem = false;
  for (const [key,decode] of [['unitcart.v1',migrateLegacy],['unitcart.tracker.v2',validateState]]) {
    try {
      const raw = localStorage.getItem(key + suffix);
      if (!raw) continue;
      backups.push({key,raw});
      for (const item of legacyPrices(decode(JSON.parse(raw)))) observations.set(item.key,item);
    } catch { problem = true; }
  }
  box.hidden = backups.length === 0;
  if (box.hidden || content.childElementCount) return;
  const description = document.createElement('p');
  description.textContent = '가족과 공유할 항목을 선택하세요. 가져온 가격은 해당 날짜의 매장 확인가로 기록됩니다.';
  const fields = document.createElement('fieldset');
  const choices = [];
  for (const item of [...observations.values()].sort((a,b)=>b.row.observedOn.localeCompare(a.row.observedOn))) {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    label.append(checkbox,document.createTextNode(' '+item.row.observedOn+' · '+item.row.product+' · '+item.row.shop+' · '+item.row.price.toLocaleString('ko-KR')+'원'));
    fields.append(label);
    choices.push({checkbox,item});
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '선택한 가격을 가족과 공유';
  const status = document.createElement('p');
  status.setAttribute('role','status');
  if (!choices.length) status.textContent = '가져올 코스트코 가격이 없습니다.';
  if (problem) status.textContent += ' 일부 예전 기록을 읽을 수 없어 원본 백업을 제공합니다.';
  fields.hidden = button.hidden = !choices.length;
  button.onclick = async () => {
    if (!isAuthorized() || button.disabled) return;
    const selected = choices.filter(x => x.checkbox.checked && !x.checkbox.disabled);
    if (!selected.length) { status.textContent = '먼저 가져올 기록을 선택하세요.'; return; }
    button.disabled = fields.disabled = true;
    let count = 0;
    try {
      for (const {item,checkbox} of selected) {
        if (!isAuthorized() || !button.isConnected) throw new Error('다시 로그인하세요.');
        await savePrice({...item.row,submission:await submissionId(item.key)});
        checkbox.checked = false;
        checkbox.disabled = true;
        count++;
        status.textContent = count+' / '+selected.length+'건 저장됨';
      }
    } catch (error) { status.textContent = count+'건 저장됨. '+error.message; }
    finally { button.disabled = fields.disabled = false; if (count && isAuthorized() && button.isConnected) await onImported(); }
  };
  content.replaceChildren(description,fields,button,status);
  for (const {key,raw} of backups) {
    const download = document.createElement('button');
    download.type='button'; download.textContent = key.includes('tracker') ? '예전 내 기록 원본 백업' : '예전 비교표 원본 백업';
    download.onclick = () => {
      const url = URL.createObjectURL(new Blob([raw],{type:'application/json'}));
      const link = document.createElement('a');
      link.href=url; link.download=key+'-backup.json'; link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    content.append(download);
  }
}

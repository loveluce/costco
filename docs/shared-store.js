import { SHARED_API } from './app-config.js';

function endpoint() {
  const url = new URL(SHARED_API);
  if (url.origin === 'https://script.google.com') {
    if (url.username || url.password || url.search || url.hash ||
        !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec\/?$/.test(url.pathname)) {
      throw new Error('Apps Script에서 복사한 웹 앱 /exec 주소를 확인하세요.');
    }
    return {url, sheets:true};
  }
  return {url:new URL('/prices',url),sheets:false};
}

async function json(url) {
  const response = await fetch(url,{cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(18000)});
  const data = await response.json();
  if (!response.ok) throw new Error('공동 가격 이력을 읽지 못했어요.');
  return data;
}

// Only public price data, a public capability check, or a random receipt ID uses JSONP.
function sheetRead(base, params) {
  return new Promise((resolve,reject) => {
    const url = new URL(base);
    const key = 'hnPrices_'+crypto.randomUUID().replaceAll('-','');
    for (const [name,value] of Object.entries(params)) url.searchParams.set(name,value);
    url.searchParams.set('callback',key);
    const script = document.createElement('script');
    const cleanup = () => { clearTimeout(timer); delete window[key]; script.remove(); };
    const fail = () => { cleanup(); reject(new Error('구글 시트 연결을 확인하세요.')); };
    const timer = setTimeout(fail,20000);
    window[key] = result => {
      if (!result || result.error) { fail(); return; }
      cleanup();
      resolve(result);
    };
    script.onerror = fail;
    script.src = url.href;
    document.head.append(script);
  });
}

export async function readPrices(before) {
  const {url,sheets} = endpoint();
  if (sheets) return sheetRead(url,before ? {before} : {});
  if (before) url.searchParams.set('before',before);
  return json(url);
}

export async function supportsInvites() {
  const {url,sheets} = endpoint();
  if (!sheets) return false;
  const response = await sheetRead(url,{auth:'mode'});
  return response.writeAuth === 'invite-v1';
}

export async function writePrice(row, inviteCode) {
  if (typeof inviteCode !== 'string' || !/^HN-[a-f0-9]{64}$/i.test(inviteCode.trim())) {
    throw new Error('운영자에게 받은 초대코드 전체를 입력하세요.');
  }
  // Recheck before every submission so an old or unprotected backend never receives a code.
  if (!(await supportsInvites())) {
    throw new Error('운영자가 초대코드용 구글 웹 앱을 연결해야 가격을 등록할 수 있어요.');
  }
  const {url} = endpoint();
  const {submission,product,shop,pack,quantity,unit,price} = row;
  const record = {submission,product:product.trim(),shop:shop.trim(),pack:pack.trim(),quantity,unit,price};
  if (!record.product || !record.shop || !record.pack || (['개','매'].includes(unit) && !Number.isInteger(quantity)))
    throw new Error('상품명·판매처·규격과 수량을 확인하세요.');
  const body = JSON.stringify({...record,inviteCode:inviteCode.trim()});
  // The POST is opaque. Confirm the exact submission by its public receipt ID.
  try {
    await fetch(url,{method:'POST',mode:'no-cors',credentials:'omit',redirect:'manual',body,
      headers:{'Content-Type':'text/plain;charset=UTF-8'},signal:AbortSignal.timeout(25000)});
  } catch { /* A timeout may occur after the sheet already committed the row. */ }
  for (let attempt=0; attempt<3; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve,1000*attempt));
    const {record:saved} = await sheetRead(url,{receipt:submission});
    if (saved) {
      if (!['product','shop','pack','quantity','unit','price'].every(field => saved[field] === record[field]))
        throw new Error('입력한 값과 저장된 값이 달라요. 공동 가격 이력을 확인하세요.');
      return {seq:saved.seq};
    }
  }
  throw new Error('초대코드가 유효한지, 구글 시트에 연결되어 있는지 확인해 주세요.');
}

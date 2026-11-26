import {SHARED_API} from './app-config.js';

// The deployment URL is public. Only an authenticated Apps Script POST can
// produce a one-time response. Passwords and session tokens stay in the POST.
const STORAGE_KEY = 'hannoondanga.household.session.v2';
const DEVICE_KEY = STORAGE_KEY+'.device:'+SHARED_API;
const TIMEOUT_MS = 18000;
const MAX_SESSION_MS = 7*24*60*60*1000;
let logoutVersion = 0;
let channel = null;
let memorySession = null;
let pendingSave = null;

function endpoint() {
  try {
    const url = new URL(SHARED_API);
    if (url.origin === 'https://script.google.com' && !url.username && !url.password &&
        !url.search && !url.hash && /^\/macros\/s\/[A-Za-z0-9_-]+\/exec\/?$/.test(url.pathname)) return url;
  } catch { /* Unconfigured deployments show the setup message. */ }
  return null;
}

export function isConfigured() { return endpoint() !== null; }

function error(code, message) { return Object.assign(new Error(message),{code}); }

function storageKey(area) { return area === 'localStorage' ? DEVICE_KEY : STORAGE_KEY; }

function stored(area) {
  try {
    const saved = JSON.parse(window[area].getItem(storageKey(area)));
    return saved?.endpoint === SHARED_API ? saved : null;
  } catch { return null; }
}

function savedSessions() {
  const unique = new Map();
  for (const saved of [memorySession,stored('sessionStorage'),stored('localStorage')]) {
    if (saved) unique.set(saved.token,saved);
  }
  return [...unique.values()];
}

function forget(saved) {
  if (memorySession?.token === saved.token) { memorySession = null; pendingSave = null; }
  for (const area of ['sessionStorage','localStorage']) {
    if (stored(area)?.token === saved.token) {
      try { window[area].removeItem(storageKey(area)); } catch { /* Storage unavailable. */ }
    }
  }
}

function reportEnd() { window.dispatchEvent?.(new Event('household-session-ended')); }

function expire(saved) {
  const wasActive = memorySession?.token === saved.token;
  forget(saved);
  // Only a display identifier travels between tabs. The bearer token stays private.
  channel?.postMessage({type:'expired',id:saved.id ?? saved.expires});
  if (wasActive) reportEnd();
}

function isCurrent(saved, now) {
  return (saved.remember === true && saved.expires === null) ||
    (Number.isFinite(saved.expires) && saved.expires > now);
}

function canRemember() {
  const key = DEVICE_KEY + '.probe';
  try {
    localStorage.setItem(key,'1');
    localStorage.removeItem(key);
    return true;
  } catch { return false; }
}

function session() {
  if (memorySession?.remember && stored('localStorage')?.token !== memorySession.token) {
    forget(memorySession);
    reportEnd();
    return null;
  }
  for (const saved of [memorySession,stored('sessionStorage'),stored('localStorage')]) {
    if (!saved) continue;
    if (typeof saved.token !== 'string' || !/^[a-f0-9]{64}$/.test(saved.token) || !isCurrent(saved,Date.now())) {
      expire(saved);
      continue;
    }
    memorySession = saved;
    return saved;
  }
  return null;
}

function endSessions(until, notify) {
  const wasActive = memorySession;
  const ended = savedSessions().filter(saved => (saved.issued || 0) <= until);
  for (const saved of ended) forget(saved);
  if (notify && wasActive && !memorySession) reportEnd();
  return Promise.all(ended.map(saved=>call('logout',{token:saved.token}).catch(()=>{})));
}

if (typeof window !== 'undefined' && window.addEventListener) {
  if (typeof window.BroadcastChannel === 'function') {
    try { channel = new BroadcastChannel(DEVICE_KEY); } catch { /* Storage events still cover remembered logins. */ }
  }
  channel?.addEventListener('message',event=>{
    if (event.data?.type === 'logout' && Number.isFinite(event.data.at)) {
      logoutVersion++;
      void endSessions(event.data.at,true);
    } else if (event.data?.type === 'expired' && memorySession && (memorySession.id ?? memorySession.expires) === event.data.id) {
      forget(memorySession);
      reportEnd();
    }
  });
  window.addEventListener('storage',event=>{
    if (memorySession?.remember && (event.key === DEVICE_KEY || event.key === null) &&
        stored('localStorage')?.token !== memorySession.token) {
      forget(memorySession);
      reportEnd();
    }
  });
}

export function hasSession() { return !!session(); }

function randomKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
}

function readReply(base, args) {
  return new Promise((resolve,reject) => {
    const callback = 'hnReply_'+randomKey().slice(0,32);
    const url = new URL(base);
    for (const [name,value] of Object.entries({...args,callback})) url.searchParams.set(name,value);
    const script = document.createElement('script');
    const cleanup = () => { clearTimeout(timer); delete window[callback]; script.remove(); };
    const fail = () => { cleanup(); reject(error('NETWORK','공동 가격표에 연결하지 못했습니다. 배포한 웹 앱 주소와 접근 권한을 확인하세요.')); };
    const timer = setTimeout(fail,TIMEOUT_MS);
    window[callback] = data => { cleanup(); resolve(data); };
    script.onerror = fail;
    script.onload = () => { if (window[callback]) fail(); };
    script.referrerPolicy = 'no-referrer';
    script.src = url.href;
    document.head.append(script);
  });
}

async function call(action, fields) {
  const base = endpoint();
  if (!base) throw error('SETUP','운영자가 웹 앱 /exec 주소를 연결해야 합니다.');
  const ticket = randomKey();
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),25000);
  try {
    await fetch(base,{method:'POST',credentials:'omit',mode:'no-cors',redirect:'follow',
      referrerPolicy:'no-referrer', headers:{'Content-Type':'text/plain;charset=UTF-8'},
      body:JSON.stringify({action,ticket,...fields}), signal:controller.signal});
  } catch { /* The request may already have committed; check its private reply. */ }
  finally { clearTimeout(timer); }

  for (let i=0;i<4;i++) {
    if (i) await new Promise(resolve=>setTimeout(resolve,600*i));
    const reply = await readReply(base,{ticket});
    if (reply?.pending) continue;
    if (reply?.ok === true) return reply.data;
    if (reply?.code === 'AUTH') {
      const expired = savedSessions().find(saved=>saved.token === fields.token);
      if (expired) expire(expired);
    }
    throw error(reply?.code || 'SERVER',reply?.message || '공동 가격표의 응답을 확인하지 못했습니다.');
  }
  throw error('NETWORK','응답을 확인하지 못했습니다. 같은 내용으로 다시 시도하세요.');
}

export async function login(password, remember=false) {
  const startingVersion = logoutVersion;
  const base = endpoint();
  if (!base) throw error('SETUP','운영자가 웹 앱 /exec 주소를 연결해야 합니다.');
  if (typeof password !== 'string' || !password) throw error('PASSWORD','공동 비밀번호를 입력하세요.');
  let mode;
  try { mode = await readReply(base,{auth:'household-v2'}); }
  catch { throw error('SETUP','공동 비밀번호용 웹 앱을 찾지 못했습니다. Apps Script의 새 버전을 배포하고 /exec 주소를 확인하세요.'); }
  if (mode?.service !== 'household-v2' || mode.loginRequired !== true)
    throw error('SETUP','Apps Script를 공동 비밀번호 버전으로 배포하세요.');
  const token = randomKey();
  const device = remember === true && canRemember();
  const result = await call('login',{password,token,remember:device});
  if (startingVersion !== logoutVersion) {
    void call('logout',{token}).catch(()=>{});
    throw error('AUTH','다른 탭에서 로그아웃했습니다. 다시 입장하세요.');
  }
  const now = Date.now();
  if (!result || !isCurrent({remember:device,expires:result.expires},now)) {
    void call('logout',{token}).catch(()=>{});
    throw error('AUTH','만료된 로그인입니다. 다시 입장하세요.');
  }
  for (const old of savedSessions()) {
    forget(old);
    void call('logout',{token:old.token}).catch(()=>{});
  }
  const expires = result.expires === null ? null : Math.min(result.expires,now+MAX_SESSION_MS);
  const saved = {id:crypto.randomUUID(),token,issued:now,expires,endpoint:SHARED_API,remember:device};
  if (device) {
    try { localStorage.setItem(DEVICE_KEY,JSON.stringify(saved)); }
    catch {
      // Storage availability can change during sign-in. Use a finite tab session in that case.
      void call('logout',{token}).catch(()=>{});
      return login(password,false);
    }
  } else {
    try { sessionStorage.setItem(STORAGE_KEY,JSON.stringify(saved)); } catch { /* Memory lasts until reload. */ }
  }
  memorySession = saved;
}

export function logout() {
  logoutVersion++;
  const at = Date.now();
  channel?.postMessage({type:'logout',at});
  return endSessions(at,false);
}

function currentToken() {
  const saved = session();
  if (!saved) throw error('AUTH','공동 비밀번호로 로그인하세요.');
  return saved.token;
}

export function listPrices(before=null) {
  return call('list',{token:currentToken(),before});
}

export async function savePrice(input) {
  const token = currentToken();
  const signature = JSON.stringify(input);
  if (!pendingSave || pendingSave.signature !== signature)
    pendingSave = {signature, submission:input.submission || crypto.randomUUID()};
  const request = pendingSave;
  const saved = await call('save',{token,row:{...input,submission:request.submission}});
  if (pendingSave === request) pendingSave = null;
  return saved;
}

// 구글 시트 > 확장 프로그램 > Apps Script에 붙여 넣고 setup을 한 번 실행하세요.
const TAB = '공동가격이력';
const HEAD = ['상품명','판매처·매장','포장 규격','총수량','단위','가격(원)','등록 시각','저장 요청 ID'];
const ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const FIELDS = ['product','shop','pack','quantity','unit','price'];

const INVITE_PREFIX = 'writer.sha256.';
const INVITE_FORMAT = /^HN-[0-9a-f]{64}$/;

function onOpen() {
  SpreadsheetApp.getUi().createMenu('가격표 관리')
    .addItem('초대코드 발급', 'issueInvite')
    .addItem('초대코드 폐기', 'revokeInvite')
    .addToUi();
}

// These menu actions are available in the spreadsheet editor. The web app
// exposes only the explicit operations in doGet and doPost below.
function promptLabel_(ui, title) {
  const answer = ui.prompt(title, '이 사람에게 사용할 별칭을 입력하세요 (1~40자).', ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return null;
  const label = answer.getResponseText().normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!label || label.length > 40 || /[\u0000-\u001f\u007f]/.test(label))
    throw new Error('별칭을 1~40자로 입력하세요.');
  return label;
}

function inviteKey_(code) {
  if (typeof code !== 'string') throw new Error('유효한 초대코드가 필요합니다.');
  const trimmed = code.trim();
  if (!INVITE_FORMAT.test(trimmed)) throw new Error('유효한 초대코드가 필요합니다.');
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, trimmed, Utilities.Charset.UTF_8);
  return INVITE_PREFIX + Utilities.base64EncodeWebSafe(hash);
}

function updateInvite_(label, issue) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const store = PropertiesService.getScriptProperties();
    const properties = store.getProperties();
    const existing = Object.keys(properties).find(key => key.startsWith(INVITE_PREFIX) && properties[key] === label);
    if (!issue) {
      if (!existing) throw new Error('이 별칭으로 사용 중인 코드가 없습니다.');
      store.deleteProperty(existing);
      return;
    }
    if (existing) throw new Error('이미 발급된 별칭입니다. 새 코드가 필요하면 이전 코드를 먼저 폐기하세요.');
    const code = 'HN-' + (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase();
    const key = inviteKey_(code);
    if (properties[key]) throw new Error('초대코드를 다시 발급해 주세요.');
    store.setProperty(key, label);
    return code;
  } finally { lock.releaseLock(); }
}

function issueInvite() {
  const ui = SpreadsheetApp.getUi();
  try {
    const label = promptLabel_(ui, '초대코드 발급');
    if (label === null) return;
    const code = updateInvite_(label, true);
    ui.alert('초대코드 발급 완료', label + '에게 아래 코드를 개인적으로 전달하세요. 이 창을 닫으면 같은 코드를 다시 볼 수 없습니다.\n\n' + code, ui.ButtonSet.OK);
  } catch (err) { ui.alert(err.message); }
}

function revokeInvite() {
  const ui = SpreadsheetApp.getUi();
  try {
    const label = promptLabel_(ui, '초대코드 폐기');
    if (label === null) return;
    if (ui.alert('초대코드 폐기', label + '의 등록 권한을 해제할까요?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
    updateInvite_(label, false);
    ui.alert(label + '의 초대코드를 폐기했습니다.');
  } catch (err) { ui.alert(err.message); }
}

function setup() {
  const book = SpreadsheetApp.getActiveSpreadsheet();
  if (!book) throw new Error('가격을 저장할 구글 시트의 확장 프로그램 메뉴에서 실행하세요.');
  let sheet = book.getSheetByName(TAB);
  if (!sheet) sheet = book.insertSheet(TAB);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1,1,1,HEAD.length).setValues([HEAD]);
    sheet.setFrozenRows(1);
  }
  checkHeader_(sheet);
  PropertiesService.getScriptProperties().setProperties({book:book.getId(), tab:String(sheet.getSheetId())});
}

function checkHeader_(sheet) {
  if (!sheet || JSON.stringify(sheet.getRange(1,1,1,HEAD.length).getValues()[0]) !== JSON.stringify(HEAD))
    throw new Error('공동가격이력 탭의 첫 행과 setup 설정을 확인하세요.');
}

function openSheet_() {
  const store = PropertiesService.getScriptProperties();
  const book = store.getProperty('book');
  const tab = store.getProperty('tab');
  if (!book || !tab) throw new Error('운영자가 먼저 setup을 실행해야 합니다.');
  const sheet = SpreadsheetApp.openById(book).getSheetById(Number(tab));
  checkHeader_(sheet);
  return sheet;
}

function parse_(row) {
  if (!row || typeof row.submission !== 'string' || !ID.test(row.submission)) throw new Error('잘못된 저장 요청입니다.');
  for (const key of ['product','shop','pack']) {
    if (typeof row[key] !== 'string' || !row[key].trim() || row[key].length > 140) throw new Error('상품명·판매처·규격을 확인하세요.');
    row[key] = row[key].trim();
  }
  if (!['개','매','g','mL','m'].includes(row.unit) || !Number.isFinite(row.quantity) ||
      row.quantity < 0.001 || row.quantity > 1e9 || (['개','매'].includes(row.unit) && !Number.isInteger(row.quantity)) ||
      !Number.isSafeInteger(row.price) || row.price < 1 || row.price > 1e9) throw new Error('총수량·단위·가격을 확인하세요.');
  return row;
}

function rowData_(n,values) {
  const [product,shop,pack,quantity,unit,price,date,receipt] = values;
  if (!ID.test(receipt) || !(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  return {seq:n,product:String(product),shop:String(shop),pack:String(pack),quantity,unit,price,saved_at:date.toISOString()};
}

function receipt_(sheet,uuid) {
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const cell = sheet.getRange(2,8,last-1,1).createTextFinder(uuid).matchEntireCell(true).matchCase(true).findNext();
  if (!cell) return null;
  const n = cell.getRow();
  return rowData_(n,sheet.getRange(n,1,1,8).getValues()[0]);
}

function append_(row) {
  const key = inviteKey_(row.inviteCode);
  const store = PropertiesService.getScriptProperties();
  if (!store.getProperty(key)) throw new Error('유효한 초대코드가 필요합니다.');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // Revocation and writes use the same lock. Recheck after obtaining it.
    if (!store.getProperty(key)) throw new Error('유효한 초대코드가 필요합니다.');
    const sheet = openSheet_();
    const previous = receipt_(sheet,row.submission);
    if (previous) {
      if (!FIELDS.every(key => previous[key] === row[key])) throw new Error('이미 사용한 저장 요청입니다.');
      return previous.seq;
    }
    const last = sheet.getLastRow();
    // An interrupted write may have left only its text cells. Reuse that uncommitted row.
    const n = last > 1 && sheet.getRange(last,8).isBlank() ? last : last+1;
    if (n > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(),100);
    const text = [row.product,row.shop,row.pack].map(value => SpreadsheetApp.newRichTextValue().setText(value).build());
    sheet.getRange(n,1,1,3).setRichTextValues([text]);
    sheet.getRange(n,7).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    SpreadsheetApp.flush();
    sheet.getRange(n,4,1,5).setValues([[row.quantity,row.unit,row.price,new Date(),row.submission]]);
    SpreadsheetApp.flush();
    return n;
  } finally { lock.releaseLock(); }
}

function doPost(e) {
  let reply;
  try {
    if (!e.postData || e.postData.length > 4096 || e.postData.contents.length > 4096) throw new Error('입력을 확인하세요.');
    reply = {seq:append_(parse_(JSON.parse(e.postData.contents)))};
  } catch (_) { reply = {error:'저장하지 못했어요. 초대코드·입력값·서버 설정을 확인하세요.'}; }
  return ContentService.createTextOutput(JSON.stringify(reply)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const args = e.parameter || {};
  let reply;
  try {
    if (args.auth === 'mode') {
      reply = {writeAuth:'invite-v1'};
    } else if (args.receipt) {
      if (!ID.test(args.receipt)) throw new Error();
      reply = {record:receipt_(openSheet_(),args.receipt)};
    } else {
      const before = Number(args.before || Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(before) || before < 2) throw new Error();
      const sheet = openSheet_();
      const end = Math.min(before-1,sheet.getLastRow());
      const start = Math.max(2,end-49);
      const rows = end < start ? [] : sheet.getRange(start,1,end-start+1,8).getValues()
        .map((values,index) => rowData_(start+index,values)).filter(Boolean).reverse();
      reply = {rows,next:start>2 ? start : null};
    }
  } catch (_) { reply = {error:'공동 가격 시트를 읽지 못했어요. 배포 권한과 setup을 확인하세요.'}; }
  const json = JSON.stringify(reply).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  if (/^hnPrices_[a-f0-9]{32}$/.test(args.callback || ''))
    return ContentService.createTextOutput(args.callback+'('+json+');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

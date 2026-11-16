/**
 * 豆豆貼 DOU DOU － 線上訂單接收（Google Apps Script）
 *
 * 綁定在 Google 試算表上使用（擴充功能 → Apps Script），部署為「網頁應用程式」。
 * 前端以 POST（Content-Type: text/plain）送出 JSON，本程式會：
 *   1. 驗證欄位與取餐方式
 *   2. 依「商品」工作表的價格在伺服器端重算金額（不信任前端金額）
 *   3. 以鎖定機制產生流水訂單編號，寫入「訂單」與「訂單明細」
 *   4. 防止同一筆訂單重複送出，並可寄送 Email 通知店家
 *
 * 安裝步驟請見 docs/google-sheet-setup.md
 */

const SHEET_ORDERS = '訂單';
const SHEET_ITEMS = '訂單明細';
const SHEET_PRODUCTS = '商品';

const ORDER_HEADERS = ['訂單編號', '建立時間', '狀態', '取餐方式', '門市', '姓名', '電話', '地址', '商品數量', '小計', '運費', '總計', '備註', '來源'];
const ITEM_HEADERS = ['訂單編號', '商品ID', '商品名稱', '單價', '數量', '小計'];
const PRODUCT_HEADERS = ['商品ID', '商品名稱', '分類', '單價', '單位', '販售中'];

const STATUSES = ['新訂單', '製作中', '可取餐', '已出貨', '已完成', '已取消'];
const FULFILLMENT = { dine: '內用', takeout: '外帶自取', delivery: '冷凍宅配' };
const STORES = ['中山旗艦店（示範）', '信義店（示範）'];

// 與網站 products 同步的預設商品（初始化時寫入「商品」工作表，之後以工作表為準）
const DEFAULT_PRODUCTS = [
  ['p1', '招牌鮮肉鍋貼', 'pot', 85, '10 顆', true],
  ['p2', '韭香鮮肉鍋貼', 'pot', 90, '10 顆', true],
  ['p3', '椒麻鮮肉鍋貼', 'pot', 100, '10 顆', true],
  ['d1', '高麗菜鮮肉水餃', 'dum', 85, '10 顆', true],
  ['d2', '鮮蝦豬肉水餃', 'dum', 130, '10 顆', true],
  ['s1', '暖心酸辣湯', 'soup', 45, '碗', true],
  ['s2', '冷泡烏龍茶', 'soup', 40, '杯', true],
  ['a1', '清爽涼拌小黃瓜', 'side', 40, '份', true],
  ['a2', '當季蔬菜小品', 'side', 45, '份', true],
  ['gift', '招牌招財鍋貼禮盒', 'gift', 680, '50 入／盒', true]
];

const FREE_SHIPPING_THRESHOLD = 1200;
const SHIPPING_FEE = 160;
const MAX_QTY_PER_ITEM = 99;

/* ───────────────────────── 網頁應用程式入口 ───────────────────────── */

function doGet() {
  return json_({ ok: true, service: 'doudou-orders', time: new Date().toISOString() });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    return json_(createOrder_(body));
  } catch (err) {
    if (!err.userMessage) console.error(err);
    return json_({ ok: false, error: err.userMessage || '系統忙碌中，請稍後再試。' });
  }
}

/* ───────────────────────── 建立訂單 ───────────────────────── */

function createOrder_(body) {
  // 機器人蜜罐欄位：真人不會填
  if (body.website) return { ok: true, orderNo: 'DD-IGNORED' };

  const name = clean_(body.name, 40);
  const phone = clean_(body.phone, 10);
  const fulfillment = String(body.fulfillment || '');
  const store = clean_(body.store, 40);
  const address = clean_(body.address, 150);
  const note = clean_(body.note, 200);
  const clientId = clean_(body.clientId, 64);

  if (!name) fail_('請填寫聯絡姓名。');
  if (!/^09\d{8}$/.test(phone)) fail_('請填寫 09 開頭的 10 位手機號碼。');
  if (!FULFILLMENT[fulfillment]) fail_('取餐方式不正確。');
  if (fulfillment === 'delivery' && !address) fail_('冷凍宅配請填寫地址。');
  if (fulfillment !== 'delivery' && STORES.indexOf(store) < 0) fail_('請選擇門市。');
  if (!Array.isArray(body.items) || !body.items.length) fail_('購物車是空的。');

  // 重複送出：同一個 clientId 在 10 分鐘內直接回傳原訂單
  const cache = CacheService.getScriptCache();
  if (clientId) {
    const prev = cache.get('cid:' + clientId);
    if (prev) return JSON.parse(prev);
  }

  // 以工作表價格重算
  const catalog = loadCatalog_();
  const merged = {};
  body.items.forEach(it => {
    const id = String(it && it.id || '');
    const qty = Math.floor(Number(it && it.qty));
    const p = catalog[id];
    if (!p || !p.active) fail_('有商品已下架或不存在，請重新整理頁面。');
    if (!(qty >= 1 && qty <= MAX_QTY_PER_ITEM)) fail_('商品數量不正確。');
    merged[id] = (merged[id] || 0) + qty;
  });
  const ids = Object.keys(merged);
  const hasGift = ids.some(id => catalog[id].cat === 'gift');
  if (hasGift && ids.length > 1) fail_('現做餐點與冷凍禮盒須分開結帳。');
  if (hasGift !== (fulfillment === 'delivery')) fail_('商品與取餐方式不相符。');

  let subtotal = 0, count = 0;
  const lines = ids.map(id => {
    const p = catalog[id], qty = merged[id], sum = p.price * qty;
    subtotal += sum; count += qty;
    return { id, name: p.name, price: p.price, qty, sum };
  });
  const shipping = hasGift && subtotal < FREE_SHIPPING_THRESHOLD ? SHIPPING_FEE : 0;
  const total = subtotal + shipping;

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  let orderNo, now;
  try {
    if (clientId) { // 鎖內再檢查一次，避免同時送出兩次
      const prev = cache.get('cid:' + clientId);
      if (prev) return JSON.parse(prev);
    }
    const ss = SpreadsheetApp.getActive();
    const orders = ensureSheet_(ss, SHEET_ORDERS, ORDER_HEADERS);
    const items = ensureSheet_(ss, SHEET_ITEMS, ITEM_HEADERS);
    now = new Date();
    orderNo = nextOrderNo_(now);
    orders.appendRow([
      orderNo, now, STATUSES[0], FULFILLMENT[fulfillment],
      fulfillment === 'delivery' ? '' : store,
      name, "'" + phone, fulfillment === 'delivery' ? address : '',
      count, subtotal, shipping, total, note, 'web'
    ]);
    applyStatusValidation_(orders, orders.getLastRow());
    const rows = lines.map(l => [orderNo, l.id, l.name, l.price, l.qty, l.sum]);
    items.getRange(items.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  const result = { ok: true, orderNo, subtotal, shipping, total, count };
  if (clientId) cache.put('cid:' + clientId, JSON.stringify(result), 600);

  notify_({ orderNo, now, fulfillment: FULFILLMENT[fulfillment], store, name, phone, address, note, lines, subtotal, shipping, total });
  return result;
}

/* ───────────────────────── 工具函式 ───────────────────────── */

function nextOrderNo_(now) {
  const tz = Session.getScriptTimeZone() || 'Asia/Taipei';
  const day = Utilities.formatDate(now, tz, 'yyyyMMdd');
  const props = PropertiesService.getScriptProperties();
  const key = 'seq:' + day;
  const seq = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(seq));
  return 'DD-' + day + '-' + ('000' + seq).slice(-3);
}

function loadCatalog_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ensureSheet_(ss, SHEET_PRODUCTS, PRODUCT_HEADERS);
  if (sh.getLastRow() < 2) seedProducts_(sh);
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, PRODUCT_HEADERS.length).getValues();
  const catalog = {};
  values.forEach(r => {
    const id = String(r[0]).trim();
    if (!id) return;
    catalog[id] = { name: String(r[1]), cat: String(r[2]), price: Number(r[3]) || 0, active: r[5] === true || String(r[5]).toUpperCase() === 'TRUE' };
  });
  return catalog;
}

function seedProducts_(sh) {
  sh.getRange(2, 1, DEFAULT_PRODUCTS.length, PRODUCT_HEADERS.length).setValues(DEFAULT_PRODUCTS);
  sh.getRange(2, 6, DEFAULT_PRODUCTS.length, 1).insertCheckboxes();
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#382e25').setFontColor('#f5f2eb');
    sh.setFrozenRows(1);
  }
  return sh;
}

function applyStatusValidation_(sh, row) {
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).build();
  sh.getRange(row, 3).setDataValidation(rule);
}

function notify_(o) {
  const to = PropertiesService.getScriptProperties().getProperty('NOTIFY_EMAIL');
  if (!to) return;
  try {
    const items = o.lines.map(l => `・${l.name} × ${l.qty}　NT$ ${l.sum}`).join('\n');
    const where = o.fulfillment === '冷凍宅配' ? `地址：${o.address}` : `門市：${o.store}`;
    MailApp.sendEmail(to, `【豆豆貼新訂單】${o.orderNo}｜NT$ ${o.total}`,
      `訂單編號：${o.orderNo}\n時間：${o.now}\n取餐方式：${o.fulfillment}\n${where}\n姓名：${o.name}\n電話：${o.phone}\n\n${items}\n\n小計：NT$ ${o.subtotal}\n運費：NT$ ${o.shipping}\n總計：NT$ ${o.total}${o.note ? '\n備註：' + o.note : ''}`);
  } catch (err) {
    console.error('通知信寄送失敗', err);
  }
}

function clean_(v, max) {
  // 去除前後空白、控制字元，並避免以 = + - @ 開頭被試算表當成公式
  let s = String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}

function fail_(msg) {
  const err = new Error(msg);
  err.userMessage = msg;
  throw err;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ───────────────────────── 試算表選單與管理功能 ───────────────────────── */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('豆豆貼')
    .addItem('初始化工作表', 'setup')
    .addItem('設定通知 Email', 'setNotifyEmail')
    .addSeparator()
    .addItem('今日訂單摘要', 'showTodaySummary')
    .addItem('建立一筆測試訂單', 'createTestOrder')
    .addToUi();
}

/** 建立三個工作表並寫入預設商品。可重複執行，不會覆蓋既有資料。 */
function setup() {
  const ss = SpreadsheetApp.getActive();
  const orders = ensureSheet_(ss, SHEET_ORDERS, ORDER_HEADERS);
  ensureSheet_(ss, SHEET_ITEMS, ITEM_HEADERS);
  const products = ensureSheet_(ss, SHEET_PRODUCTS, PRODUCT_HEADERS);
  if (products.getLastRow() < 2) seedProducts_(products);
  orders.getRange('B:B').setNumberFormat('yyyy/mm/dd hh:mm');
  orders.getRange('J:L').setNumberFormat('"NT$ "#,##0');
  const sheet1 = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (sheet1 && sheet1.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sheet1);
  SpreadsheetApp.getUi && toast_('工作表已就緒：訂單、訂單明細、商品');
}

function setNotifyEmail() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('新訂單通知', '輸入要接收通知的 Email（留空則關閉通知）：', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const v = res.getResponseText().trim();
  const props = PropertiesService.getScriptProperties();
  if (v) props.setProperty('NOTIFY_EMAIL', v); else props.deleteProperty('NOTIFY_EMAIL');
  toast_(v ? '已設定通知：' + v : '已關閉 Email 通知');
}

function showTodaySummary() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_ORDERS);
  const tz = Session.getScriptTimeZone() || 'Asia/Taipei';
  const today = Utilities.formatDate(new Date(), tz, 'yyyyMMdd');
  let n = 0, sum = 0, cancelled = 0;
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, ORDER_HEADERS.length).getValues().forEach(r => {
      if (String(r[0]).indexOf('DD-' + today) !== 0) return;
      if (r[2] === '已取消') { cancelled++; return; }
      n++; sum += Number(r[11]) || 0;
    });
  }
  SpreadsheetApp.getUi().alert(`今日訂單：${n} 筆\n營業額：NT$ ${sum.toLocaleString()}\n已取消：${cancelled} 筆`);
}

function createTestOrder() {
  const r = createOrder_({
    name: '測試顧客', phone: '0912345678', fulfillment: 'takeout', store: STORES[0],
    items: [{ id: 'p1', qty: 2 }, { id: 's1', qty: 1 }], note: '測試訂單，可刪除', clientId: 'test-' + Date.now()
  });
  toast_('已建立測試訂單 ' + r.orderNo);
}

function toast_(msg) {
  try { SpreadsheetApp.getActive().toast(msg, '豆豆貼', 5); } catch (e) { console.log(msg); }
}

/* FB Group Post Cleaner – side panel: giao diện + điều phối. */
'use strict';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

const STORE_KEY = 'fbpc_state_v1';
const DEFAULT_SETTINGS = {
  dryRun: true, verify: true, delayMin: 5, delayMax: 8,
  longPause: false, longPauseMin: 3, longPauseEvery: 20,
};

const STATUS_TEXT = {
  pending: 'Chưa xóa',
  processing: 'Đang xử lý',
  deleted: 'Đã xóa',
  dryok: 'Chạy thử OK',
  error: 'Lỗi',
  gone: 'Không còn tồn tại',
  nolink: 'Không có link',
};
const UNSELECTABLE = new Set(['nolink', 'deleted', 'gone']);

let state = { posts: [], settings: { ...DEFAULT_SETTINGS }, tabId: null };
const ui = { search: '', filter: 'all' };
let scanning = null; // { tabId }
let run = null; // { stop, paused, ... }
const confirmStage = new Set();

// ------------------------------------------------------------------ tiện ích
const norm = (s) => String(s == null ? '' : s).normalize('NFC').replace(/\s+/g, ' ').trim();
// bỏ dấu câu, hoa/thường và cả dấu tiếng Việt (gõ "ban meo" vẫn tìm ra "Bán mèo")
const searchKey = (s) => norm(s).toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '').replace(/đ/g, 'd')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const isFb = (url) => /^https:\/\/([a-z0-9-]+\.)*facebook\.com\//i.test(url || '');
const clock = () => new Date().toLocaleTimeString('vi-VN', { hour12: false });

function setStatus(el, text, cls = '') {
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

function log(text, cls = '') {
  const li = document.createElement('li');
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = clock();
  const m = document.createElement('span');
  if (cls) m.className = cls;
  m.textContent = text;
  li.append(t, m);
  const ol = $('log');
  ol.append(li);
  while (ol.children.length > 400) ol.firstChild.remove();
  ol.scrollTop = ol.scrollHeight;
}

function confirmModal(text, okLabel = 'Đồng ý') {
  return new Promise((resolve) => {
    const d = $('modal');
    $('modalText').textContent = text;
    $('modalOk').textContent = okLabel;
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
    d.showModal();
  });
}

function showBanner(reason) {
  $('bannerText').textContent = ' ' + (reason || '');
  $('banner').hidden = false;
  $('banner').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ------------------------------------------------------------------ lưu trữ
let saveTimer = null;
function save(now = false) {
  clearTimeout(saveTimer);
  const doSave = () => chrome.storage.local.set({ [STORE_KEY]: state }).catch((e) => console.warn(e));
  if (now) return doSave();
  saveTimer = setTimeout(doSave, 300);
}

async function load() {
  const got = await chrome.storage.local.get(STORE_KEY);
  const s = got[STORE_KEY];
  if (s) {
    state.posts = Array.isArray(s.posts) ? s.posts : [];
    state.settings = { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
    state.tabId = s.tabId || null;
  }
  // panel bị đóng giữa chừng -> trả về "Chưa xóa"
  let fixed = false;
  for (const p of state.posts) {
    if (p.status === 'processing') { p.status = 'pending'; p.note = ''; fixed = true; }
  }
  if (fixed) save(true);
}

// ------------------------------------------------------------------ tab Facebook
async function getFbTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && isFb(active.url)) return active;
  if (state.tabId) {
    try {
      const t = await chrome.tabs.get(state.tabId);
      if (t && isFb(t.url)) return t;
    } catch (_) { /* tab đã đóng */ }
  }
  const tabs = await chrome.tabs.query({ url: 'https://*.facebook.com/*', currentWindow: true });
  return tabs[0] || null;
}

function rememberTab(tabId) {
  if (state.tabId !== tabId) { state.tabId = tabId; save(); }
}

function sendToTab(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, { ...msg, __fbpc: true });
}

async function ensureContent(tabId) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await sendToTab(tabId, { type: 'ping' });
      if (r && r.ok) return true;
    } catch (_) { /* chưa có content script */ }
    if (i === 1 || i === 4) {
      try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); } catch (_) {}
    }
    await sleep(500);
  }
  throw new Error('Không kết nối được với trang Facebook (hãy tải lại tab).');
}

/** Điều hướng tab và chờ tải xong (status complete). */
function navigate(tabId, url, timeout = 45000) {
  return new Promise((resolve, reject) => {
    let started = false;
    const finish = (fn, v) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpd);
      chrome.tabs.onRemoved.removeListener(onRem);
      fn(v);
    };
    const onUpd = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') started = true;
      if (info.status === 'complete' && started) finish(resolve, 'complete');
    };
    const onRem = (id) => { if (id === tabId) finish(reject, new Error('Tab Facebook đã bị đóng.')); };
    const timer = setTimeout(() => finish(resolve, 'timeout'), timeout);
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.onRemoved.addListener(onRem);
    chrome.tabs.update(tabId, { url }).catch((e) => finish(reject, e));
  });
}

function urlBlockReason(url) {
  if (/\/checkpoint/i.test(url || '')) return 'Facebook chuyển tới trang checkpoint.';
  if (/facebook\.com\/(login|login\.php)(\/|\?|$)/i.test(url || '')) return 'Bị chuyển về trang đăng nhập.';
  return null;
}

// ------------------------------------------------------------------ bước 1
async function openLog() {
  const st = $('openStatus');
  try {
    setStatus(st, 'Đang tìm tab Facebook…');
    let tab = await getFbTab();
    if (!tab) {
      tab = await chrome.tabs.create({ url: 'https://www.facebook.com/', active: true });
      await navigateWait(tab.id);
    }
    rememberTab(tab.id);
    await chrome.tabs.update(tab.id, { active: true });
    await ensureContent(tab.id);
    const { uid } = await sendToTab(tab.id, { type: 'getUid' });
    if (!uid) { setStatus(st, 'Không lấy được UID – bạn đã đăng nhập Facebook trên tab này chưa?', 'err'); return; }
    const url = `https://www.facebook.com/${uid}/allactivity?activity_history=false&category_key=GROUPPOSTS&manage_mode=false&should_load_landing_page=false`;
    setStatus(st, 'Đang mở nhật ký…');
    await navigate(tab.id, url);
    setStatus(st, 'Đã mở nhật ký. Sang bước 2 để quét.', 'ok');
  } catch (e) {
    setStatus(st, 'Lỗi: ' + e.message, 'err');
  }
}

function navigateWait(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    const t = setTimeout(done, timeout);
    function done() { clearTimeout(t); chrome.tabs.onUpdated.removeListener(l); resolve(); }
    function l(id, info) { if (id === tabId && info.status === 'complete') done(); }
    chrome.tabs.onUpdated.addListener(l);
  });
}

// ------------------------------------------------------------------ bước 2
function mergePosts(items) {
  const byId = new Map(state.posts.map((p) => [p.id, p]));
  let added = 0;
  for (const it of items) {
    const old = byId.get(it.id);
    if (old) {
      for (const k of ['groupName', 'snippet', 'date', 'time', 'url', 'groupId', 'postId']) {
        if (!old[k] && it[k]) old[k] = it[k];
      }
    } else {
      const p = { ...it, selected: false, note: it.status === 'nolink' ? 'Không lấy được link từ nút "Xem"' : '' };
      state.posts.push(p);
      byId.set(p.id, p);
      added++;
    }
  }
  return added;
}

async function startScan() {
  if (run) return;
  const st = $('scanStatus');
  let tab;
  try {
    tab = await getFbTab();
    if (!tab) { setStatus(st, 'Không thấy tab Facebook. Làm bước 1 trước.', 'err'); return; }
    rememberTab(tab.id);
    if (!/allactivity/i.test(tab.url || '')) {
      setStatus(st, 'Tab hiện tại không phải trang Nhật ký hoạt động. Làm bước 1 trước.', 'err');
      return;
    }
    await ensureContent(tab.id);
  } catch (e) { setStatus(st, 'Lỗi: ' + e.message, 'err'); return; }

  scanning = { tabId: tab.id, added: 0 };
  $('btnScan').disabled = true;
  $('btnStopScan').disabled = false;
  $('btnRun').disabled = true;
  setStatus(st, 'Đang quét… (giữ tab Facebook hiển thị)');
  let res;
  try {
    res = await sendToTab(tab.id, { type: 'startScan' });
  } catch (e) {
    res = { error: 'Mất kết nối với trang trong lúc quét: ' + e.message };
  }
  const added = scanning.added;
  scanning = null;
  $('btnScan').disabled = false;
  $('btnStopScan').disabled = true;
  $('btnRun').disabled = false;
  save(true);
  render();

  if (!res || res.error) { setStatus(st, (res && res.error) || 'Lỗi không rõ', 'err'); return; }
  if (res.blocked) { showBanner(res.blocked); setStatus(st, 'Đã dừng quét: ' + res.blocked, 'err'); return; }
  const parts = [`${res.stopped ? 'Đã dừng' : 'Quét xong'}: tìm thấy ${res.found} bài đăng, bỏ qua ${res.skipped} bình luận/hoạt động khác`];
  if (res.nolink) parts.push(`${res.nolink} bài không có link`);
  parts.push(`thêm mới ${added} bài vào danh sách`);
  setStatus(st, parts.join(', ') + '.', res.nolink ? 'err' : 'ok');
}

async function stopScan() {
  if (!scanning) return;
  try { await sendToTab(scanning.tabId, { type: 'stopScan' }); } catch (_) {}
  setStatus($('scanStatus'), 'Đang dừng…');
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.__fbpcEvent) return;
  if (msg.type === 'scanProgress' && scanning && sender.tab && sender.tab.id === scanning.tabId) {
    if (msg.items && msg.items.length) {
      scanning.added += mergePosts(msg.items);
      save();
      render();
    }
    setStatus($('scanStatus'),
      `Đang quét… Tìm thấy ${msg.found} bài đăng, bỏ qua ${msg.skipped} bình luận` +
      (msg.loading ? ' (đang tải thêm)' : msg.idle ? ` (chờ mục mới ${msg.idle}/5)` : ''));
  }
  if (msg.type === 'deleteStage' && msg.stage === 'confirmClicked') confirmStage.add(msg.id);
});

async function runDiagnose() {
  const msgEl = $('diagMsg');
  try {
    const tab = await getFbTab();
    if (!tab) throw new Error('Không thấy tab Facebook.');
    await ensureContent(tab.id);
    const d = await sendToTab(tab.id, { type: 'diagnose' });
    const json = JSON.stringify(d, null, 2);
    $('diagBox').hidden = false;
    $('diagOut').value = json;
    await copyText(json);
    setStatus(msgEl, 'Đã sao chép vào clipboard.', 'ok');
  } catch (e) {
    $('diagBox').hidden = false;
    setStatus(msgEl, 'Lỗi: ' + e.message, 'err');
  }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch (_) {}
  const ta = $('diagOut');
  ta.focus();
  ta.select();
  document.execCommand('copy');
}

// ------------------------------------------------------------------ bước 3
function matchesFilter(p) {
  switch (ui.filter) {
    case 'pending': return p.status === 'pending' || p.status === 'dryok' || p.status === 'processing';
    case 'deleted': return p.status === 'deleted';
    case 'error': return p.status === 'error';
    default: return true;
  }
}

function visiblePosts() {
  const q = searchKey(ui.search);
  return state.posts.filter((p) => matchesFilter(p) && (!q || searchKey(p.groupName + ' ' + p.snippet).includes(q)));
}

function rowFor(p) {
  const row = document.createElement('div');
  row.className = 'item';
  row.dataset.id = p.id;
  row.setAttribute('role', 'listitem');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  const box = document.createElement('div');
  box.style.minWidth = '0';
  const g = document.createElement('div'); g.className = 'g';
  const s = document.createElement('div'); s.className = 's';
  const m = document.createElement('div'); m.className = 'm';
  const note = document.createElement('div'); note.className = 'note';
  box.append(g, s, m, note);
  row.append(cb, box);
  fillRow(row, p);
  return row;
}

function fillRow(row, p) {
  const [cb, box] = row.children;
  const [g, s, m, note] = box.children;
  const disabled = UNSELECTABLE.has(p.status);
  cb.checked = !!p.selected && !disabled;
  cb.disabled = disabled;
  row.classList.toggle('sel', cb.checked);
  row.classList.toggle('disabled', disabled);
  g.textContent = p.groupName || '(không rõ nhóm)';
  g.title = g.textContent;
  s.textContent = p.snippet || '(không có chữ)';
  m.textContent = '';
  const badge = document.createElement('span');
  badge.className = 'badge b-' + p.status;
  badge.textContent = STATUS_TEXT[p.status] || p.status;
  const when = document.createElement('span');
  when.textContent = [p.date, p.time].filter(Boolean).join(' · ');
  m.append(badge, when);
  if (p.url) {
    const a = document.createElement('a');
    a.href = p.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = p.url.replace('https://www.facebook.com', '');
    a.title = 'Mở bài trong tab mới để tự kiểm tra';
    m.append(a);
  }
  note.textContent = (p.status === 'error' || p.status === 'nolink' || p.status === 'gone') ? (p.note || '') : '';
  note.hidden = !note.textContent;
}

function render() {
  const list = $('list');
  const vis = visiblePosts();
  const frag = document.createDocumentFragment();
  for (const p of vis) frag.append(rowFor(p));
  list.replaceChildren(frag);
  updateCounters(vis.length);
}

function updateRow(p) {
  const row = $('list').querySelector(`.item[data-id="${CSS.escape(p.id)}"]`);
  if (row) fillRow(row, p);
  updateCounters();
}

function updateCounters(visCount) {
  if (visCount == null) visCount = visiblePosts().length;
  const total = state.posts.length;
  const sel = state.posts.filter((p) => p.selected && !UNSELECTABLE.has(p.status)).length;
  const del = state.posts.filter((p) => p.status === 'deleted').length;
  $('counters').textContent = `Hiển thị ${visCount} / ${total} bài · Đã chọn ${sel} · Đã xóa ${del}`;
  const nl = state.posts.filter((p) => p.status === 'nolink').length;
  const w = $('nolinkWarn');
  w.hidden = !nl;
  w.textContent = nl ? `${nl} bài không lấy được link nên không thể xóa. Hãy bấm "Chẩn đoán trang hiện tại" ở bước 2 (trên trang nhật ký) và gửi kết quả cho người phát triển.` : '';
  updateRunButton();
}

function updateRunButton() {
  if (run) return;
  const dry = state.settings.dryRun;
  const n = runnablePosts(dry).length;
  $('btnRun').textContent = dry ? `Bắt đầu chạy thử (${n})` : `Bắt đầu xóa (${n})`;
  $('btnRun').classList.toggle('danger', !dry);
  $('btnRun').classList.toggle('primary', dry);
}

function onListClick(e) {
  const row = e.target.closest('.item');
  if (!row || e.target.closest('a')) return;
  const p = state.posts.find((x) => x.id === row.dataset.id);
  if (!p || UNSELECTABLE.has(p.status)) return;
  if (e.target.tagName === 'INPUT') p.selected = e.target.checked;
  else p.selected = !p.selected;
  fillRow(row, p);
  updateCounters();
  save();
}

function selectVisible(val) {
  const vis = val ? visiblePosts() : state.posts;
  for (const p of vis) if (!UNSELECTABLE.has(p.status)) p.selected = val;
  save();
  render();
}

function exportCsv() {
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [['Trạng thái', 'Nhóm', 'Ngày', 'Giờ', 'Nội dung', 'Link', 'Ghi chú']];
  for (const p of state.posts) {
    rows.push([STATUS_TEXT[p.status] || p.status, p.groupName, p.date, p.time, p.snippet, p.url, p.note]);
  }
  const csv = '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  a.href = URL.createObjectURL(blob);
  a.download = `fb-group-posts-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function clearList() {
  if (run || scanning) return;
  if (!state.posts.length) return;
  const ok = await confirmModal(`Xóa toàn bộ ${state.posts.length} bài khỏi danh sách của công cụ?\n(Chỉ xóa danh sách, không đụng tới bài trên Facebook.)`, 'Xóa danh sách');
  if (!ok) return;
  state.posts = [];
  save(true);
  render();
}

// ------------------------------------------------------------------ bước 4
function readSettings() {
  const s = state.settings;
  s.dryRun = $('optDry').checked;
  s.verify = $('optVerify').checked;
  let mn = Math.max(2, Number($('optMin').value) || DEFAULT_SETTINGS.delayMin);
  let mx = Math.max(2, Number($('optMax').value) || DEFAULT_SETTINGS.delayMax);
  if (mx < mn) mx = mn;
  s.delayMin = mn; s.delayMax = mx;
  s.longPause = $('optLong').checked;
  s.longPauseMin = Math.max(1, Number($('optLongMin').value) || DEFAULT_SETTINGS.longPauseMin);
  s.longPauseEvery = Math.max(1, Math.floor(Number($('optLongEvery').value) || DEFAULT_SETTINGS.longPauseEvery));
  save();
  updateRunButton();
}

function writeSettings() {
  const s = state.settings;
  $('optDry').checked = s.dryRun;
  $('optVerify').checked = s.verify;
  $('optMin').value = s.delayMin;
  $('optMax').value = s.delayMax;
  $('optLong').checked = s.longPause;
  $('optLongMin').value = s.longPauseMin;
  $('optLongEvery').value = s.longPauseEvery;
}

function runnablePosts(dry) {
  return state.posts.filter((p) => p.selected && p.url && !UNSELECTABLE.has(p.status) && (dry || p.status !== 'deleted'));
}

function setRunUi(active) {
  $('btnRun').disabled = active;
  $('btnPause').disabled = !active;
  $('btnStop').disabled = !active;
  $('btnScan').disabled = active;
  $('btnOpenLog').disabled = active;
  $('btnClear').disabled = active;
  for (const id of ['optDry', 'optVerify']) $(id).disabled = active;
  $('btnPause').textContent = 'Tạm dừng';
}

function setProgress(done, total) {
  $('progBar').style.width = total ? (100 * done / total).toFixed(1) + '%' : '0';
}

async function waitWhilePaused() {
  while (run && run.paused && !run.stop) await sleep(250);
}

/** Đếm ngược (dừng được, tạm dừng được). */
async function countdown(seconds, label) {
  let remain = seconds * 1000;
  let last = Date.now();
  while (remain > 0 && run && !run.stop) {
    await sleep(200);
    const now = Date.now();
    if (!run.paused) remain -= now - last;
    last = now;
    const secs = Math.max(0, Math.ceil(remain / 1000));
    const mm = Math.floor(secs / 60), ss = secs % 60;
    $('runStatus').textContent = `${run.done}/${run.total} bài · ${label} ${mm ? mm + ' phút ' : ''}${ss} giây${run.paused ? ' (đang tạm dừng)' : ''}`;
  }
}

async function processOne(tabId, p, dry, verify) {
  confirmStage.delete(p.id);
  await navigate(tabId, p.url);
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch (_) { throw new Error('Tab Facebook đã bị đóng.'); }
  const urlBlock = urlBlockReason(tab.url);
  if (urlBlock) return { status: 'blocked', reason: urlBlock };
  if (!tab.active && !run.warnedBg) {
    run.warnedBg = true;
    log('Tab Facebook đang ở chế độ nền – Chrome có thể làm chậm thao tác. Nên để tab hiển thị.', 'warn');
  }
  await sleep(rand(1200, 2000));
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) log(`Trang tải lại giữa chừng, thử lại (${attempt}/2)…`, 'warn');
    await waitTabSettled(tabId);
    try { tab = await chrome.tabs.get(tabId); } catch (_) { throw new Error('Tab Facebook đã bị đóng.'); }
    const blk = urlBlockReason(tab.url);
    if (blk) return { status: 'blocked', reason: blk };
    await ensureContent(tabId);
    try {
      return await sendToTab(tabId, { type: 'deletePost', post: p, dryRun: dry, verify });
    } catch (e) {
      lastErr = e;
      // đã bấm "Xóa" rồi thì KHÔNG thử lại
      if (confirmStage.has(p.id)) {
        return { status: 'deleted', note: 'Đã bấm "Xóa" nhưng trang tải lại trước khi xác nhận – hãy mở link kiểm tra.' };
      }
      await sleep(rand(1500, 2500));
    }
  }
  return { status: 'error', reason: 'Mất kết nối với trang: ' + (lastErr && lastErr.message) };
}

/** Chờ tab ở trạng thái "complete" liên tục ~1,2 giây (Facebook đôi khi chuyển hướng/tải lại sau khi tải xong). */
async function waitTabSettled(tabId, timeout = 30000) {
  const end = Date.now() + timeout;
  let stableSince = 0;
  while (Date.now() < end) {
    let t;
    try { t = await chrome.tabs.get(tabId); } catch (_) { throw new Error('Tab Facebook đã bị đóng.'); }
    if (t.status === 'complete') {
      if (!stableSince) stableSince = Date.now();
      if (Date.now() - stableSince >= 1200) return;
    } else {
      stableSince = 0;
    }
    await sleep(200);
  }
}

async function startRun() {
  if (run || scanning) return;
  readSettings();
  const s = { ...state.settings };
  const queue = runnablePosts(s.dryRun);
  if (!queue.length) { setStatus($('runStatus'), 'Chưa chọn bài nào (bài có link, chưa xóa).', 'err'); return; }
  if (!s.dryRun) {
    const ok = await confirmModal(`Xóa VĨNH VIỄN ${queue.length} bài viết? Không thể hoàn tác.`, 'Xóa vĩnh viễn');
    if (!ok) return;
  }
  const tab = await getFbTab();
  if (!tab) { setStatus($('runStatus'), 'Không thấy tab Facebook. Hãy mở facebook.com trong cửa sổ này.', 'err'); return; }
  rememberTab(tab.id);
  try { await chrome.tabs.update(tab.id, { active: true }); } catch (_) {}

  run = { stop: false, paused: false, total: queue.length, done: 0, consecErr: 0, ok: 0, fail: 0, warnedBg: false };
  $('banner').hidden = true;
  setRunUi(true);
  setProgress(0, run.total);
  log(`Bắt đầu ${s.dryRun ? 'CHẠY THỬ' : 'XÓA'} ${run.total} bài (giãn cách ${s.delayMin}–${s.delayMax} giây).`);

  let stopReason = '';
  for (let i = 0; i < queue.length; i++) {
    await waitWhilePaused();
    if (run.stop) { stopReason = 'Người dùng bấm Dừng.'; break; }
    const p = queue[i];
    p.status = 'processing';
    p.note = '';
    updateRow(p);
    save();
    $('runStatus').textContent = `${run.done}/${run.total} bài · Đang xử lý: ${p.groupName || p.url}`;

    let res;
    try {
      res = await processOne(tab.id, p, s.dryRun, s.verify);
    } catch (e) {
      p.status = 'pending';
      updateRow(p);
      stopReason = e.message;
      log(e.message, 'err');
      break;
    }
    res = res || { status: 'error', reason: 'Không có phản hồi' };
    const name = p.groupName || p.id;
    let emergency = false;
    switch (res.status) {
      case 'deleted':
        p.status = 'deleted'; p.note = res.note || ''; p.selected = false;
        run.ok++; run.consecErr = 0;
        log(`Đã xóa: ${name}${res.note ? ' – ' + res.note : ''}`, 'ok');
        break;
      case 'dryok':
        p.status = 'dryok'; p.note = '';
        run.ok++; run.consecErr = 0;
        log(`Chạy thử OK: ${name} (thấy "Xóa bài viết"${res.verifiedBy && res.verifiedBy !== 'off' ? ', khớp theo ' + res.verifiedBy : ''})`, 'ok');
        break;
      case 'gone':
        p.status = 'gone'; p.note = 'Nội dung này hiện không hiển thị'; p.selected = false;
        log(`Không còn tồn tại, bỏ qua: ${name}`, 'warn');
        break;
      case 'blocked':
        p.status = 'error';
        p.note = 'Bị chặn: ' + (res.reason || '') + (res.maybeDeleted ? ' – có thể đã xóa, hãy mở link kiểm tra' : '');
        emergency = true;
        log('DỪNG KHẨN CẤP: ' + (res.reason || 'Facebook đang hạn chế'), 'err');
        break;
      default:
        p.status = 'error'; p.note = res.reason || res.error || 'Lỗi không rõ';
        run.fail++; run.consecErr++;
        log(`Lỗi: ${name} – ${p.note}`, 'err');
    }
    run.done++;
    updateRow(p);
    save();
    setProgress(run.done, run.total);

    if (emergency) { stopReason = 'Dừng khẩn cấp: ' + (res.reason || ''); showBanner(res.reason); break; }
    if (run.consecErr >= 3) { stopReason = 'Tự dừng sau 3 lỗi liên tiếp.'; log(stopReason, 'err'); break; }
    if (run.stop) { stopReason = 'Người dùng bấm Dừng.'; break; }

    if (i < queue.length - 1) {
      if (s.longPause && run.done % s.longPauseEvery === 0) {
        log(`Nghỉ dài ${s.longPauseMin} phút sau ${run.done} bài.`);
        await countdown(s.longPauseMin * 60, 'Nghỉ dài, còn');
      } else {
        await countdown(rand(s.delayMin, s.delayMax), 'Bài tiếp theo sau');
      }
    }
  }

  const summary = `${s.dryRun ? 'Chạy thử' : 'Xóa'} xong ${run.done}/${run.total} bài: ${run.ok} thành công, ${run.fail} lỗi.` + (stopReason ? ' ' + stopReason : '');
  log(summary, run.fail || stopReason ? 'warn' : 'ok');
  $('runStatus').textContent = summary;
  run = null;
  setRunUi(false);
  save(true);
  render();
}

function togglePause() {
  if (!run) return;
  run.paused = !run.paused;
  $('btnPause').textContent = run.paused ? 'Tiếp tục' : 'Tạm dừng';
  log(run.paused ? 'Tạm dừng (sẽ dừng sau bài đang xử lý).' : 'Tiếp tục.');
}

function stopRun() {
  if (!run) return;
  run.stop = true;
  run.paused = false;
  $('btnStop').disabled = true;
  log('Đang dừng sau bài hiện tại…');
}

// ------------------------------------------------------------------ khởi tạo
async function init() {
  await load();
  writeSettings();
  render();

  $('btnOpenLog').addEventListener('click', openLog);
  $('btnScan').addEventListener('click', startScan);
  $('btnStopScan').addEventListener('click', stopScan);
  $('btnDiag').addEventListener('click', runDiagnose);
  $('btnCopyDiag').addEventListener('click', async () => {
    await copyText($('diagOut').value);
    setStatus($('diagMsg'), 'Đã sao chép vào clipboard.', 'ok');
  });
  $('bannerClose').addEventListener('click', () => { $('banner').hidden = true; });

  let searchTimer = null;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { ui.search = e.target.value; render(); }, 150);
  });
  $('statusFilter').addEventListener('change', (e) => { ui.filter = e.target.value; render(); });
  $('btnSelectAll').addEventListener('click', () => selectVisible(true));
  $('btnSelectNone').addEventListener('click', () => selectVisible(false));
  $('btnCsv').addEventListener('click', exportCsv);
  $('btnClear').addEventListener('click', clearList);
  $('list').addEventListener('click', onListClick);

  for (const id of ['optDry', 'optVerify', 'optMin', 'optMax', 'optLong', 'optLongMin', 'optLongEvery']) {
    $(id).addEventListener('change', () => { readSettings(); writeSettings(); });
  }
  $('btnRun').addEventListener('click', startRun);
  $('btnPause').addEventListener('click', togglePause);
  $('btnStop').addEventListener('click', stopRun);

  // đóng panel giữa chừng: trả bài đang xử lý về "Chưa xóa"
  window.addEventListener('pagehide', () => {
    let changed = false;
    for (const p of state.posts) if (p.status === 'processing') { p.status = 'pending'; changed = true; }
    if (changed || saveTimer) chrome.storage.local.set({ [STORE_KEY]: state });
  });
}

init();

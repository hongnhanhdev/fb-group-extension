// Kiểm thử tự động bằng Chrome headless qua DevTools Protocol (không cần cài gói npm).
// Chạy:  node tests/run-tests.mjs   (đặt CHROME_PATH nếu Chrome không ở chỗ mặc định)
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const CHROME = CANDIDATES.find((p) => existsSync(p));
if (!CHROME) { console.error('Không tìm thấy Chrome. Đặt biến CHROME_PATH.'); process.exit(2); }

const PORT = 9300 + Math.floor(Math.random() * 500);
const profile = mkdtempSync(join(tmpdir(), 'fbpc-test-'));
const proc = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1200,900',
  '--allow-file-access-from-files', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map();
const listeners = [];

async function connect() {
  let info;
  for (let i = 0; i < 60; i++) {
    try { info = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); break; } catch { await sleep(250); }
  }
  const page = info.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    else if (m.method) for (const l of listeners) l(m);
  };
  await cdp('Page.enable');
  await cdp('Runtime.enable');
}

function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

async function nav(url) {
  const loaded = new Promise((r) => { const l = (m) => { if (m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(l), 1); r(); } }; listeners.push(l); });
  await cdp('Page.navigate', { url });
  await loaded;
}

async function evaluate(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

const fileUrl = (name, q = '') => pathToFileURL(join(HERE, name)).href + q;

// ------------------------------------------------------------------ khung kiểm thử
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

async function testUrls() {
  console.log('\n[1] Chuẩn hoá link');
  await nav(fileUrl('activity-log.html'));
  const r = await evaluate(`(() => {
    const p = window.__FBPC._t.parsePostUrl;
    return [
      p('https://www.facebook.com/groups/111/permalink/9001/?__cft__[0]=AZ&__tn__=%2CO'),
      p('https://www.facebook.com/groups/abc.def/posts/9002?ref=share'),
      p('https://www.facebook.com/groups/444/?multi_permalinks=9004,9010&ref=share'),
      p('https://www.facebook.com/permalink.php?story_fbid=9005&id=555&__cft__[0]=z'),
      p('https://www.facebook.com/groups/444/'),
      p('https://l.facebook.com/l.php?u=' + encodeURIComponent('https://www.facebook.com/groups/1/permalink/2/')),
    ];
  })()`);
  check('/permalink/ + bỏ __cft__/__tn__', r[0]?.url === 'https://www.facebook.com/groups/111/permalink/9001/', r[0]);
  check('/posts/ → /permalink/', r[1]?.url === 'https://www.facebook.com/groups/abc.def/permalink/9002/', r[1]);
  check('multi_permalinks', r[2]?.groupId === '444' && r[2]?.postId === '9004', r[2]);
  check('permalink.php?story_fbid', r[3]?.url === 'https://www.facebook.com/groups/555/permalink/9005/', r[3]);
  check('link nhóm không phải bài → null', r[4] === null, r[4]);
  check('l.php chuyển hướng', r[5]?.postId === '2', r[5]);
}

async function testScan() {
  console.log('\n[2] Quét nhật ký (mất khoảng 20–30 giây)');
  await nav(fileUrl('activity-log.html'));
  const r = await evaluate(`(async () => {
    const items = []; let progress = 0;
    window.addEventListener('fbpc-event', (e) => { if (e.detail.type === 'scanProgress') { progress++; items.push(...e.detail.items); } });
    const res = await window.__FBPC.handle({ type: 'startScan' });
    return { res, items, progress, expect: window.__EXPECT };
  })()`);
  const { res, items, expect } = r;
  const withLink = items.filter((i) => i.status === 'pending').map((i) => i.id).sort();
  check('đúng các bài đăng có link', JSON.stringify(withLink) === JSON.stringify([...expect.posts].sort()), withLink);
  check('1 bài "Không có link"', items.filter((i) => i.status === 'nolink').length === expect.nolink, items.filter((i) => i.status === 'nolink'));
  check('bỏ qua đúng số bình luận/hoạt động khác (4)',res.skipped === expect.skipped, res);
  check('đếm found = 6 (đã loại trùng)', res.found === 6, res.found);
  check('có báo tiến độ trực tiếp', r.progress >= 3, r.progress);
  check('link không còn tham số theo dõi', items.every((i) => !i.url || /^https:\/\/www\.facebook\.com\/groups\/[^/]+\/permalink\/[^/]+\/$/.test(i.url)), items.map((i) => i.url));
  const a = items.find((i) => i.id === '111_9001') || {};
  check('bài 9001: nhóm/ngày/giờ/nội dung', a.groupName === 'Hội yêu mèo' && a.date === '2 Tháng 10, 2026' && a.time === '17:55' && a.snippet === 'Bán mèo con giá rẻ, ai cần liên hệ mình nhé!', a);
  const b = items.find((i) => i.id === 'choducu_9002') || {};
  check('bài 9002: nhóm riêng tư, nội dung', b.groupName === 'Chợ đồ cũ Hà Nội' && b.snippet.startsWith('Thanh lý tủ lạnh') && b.time === '09:12', b);
  const c = items.find((i) => i.id === '111_9003') || {};
  check('bài không chữ, ngày chỉ có 1 mục', c.date === '30 Tháng 9, 2026' && c.snippet === '' && c.groupName === 'Hội yêu mèo', c);
  const d = items.find((i) => i.id === '444_9004') || {};
  check('bài tải thêm khi cuộn có ngày đúng', d.date === '28 Tháng 9, 2026' && d.groupName === 'Phượt Việt Nam', d);
  const n = items.find((i) => i.status === 'nolink') || {};
  check('bài không link vẫn có nhóm + ngày', n.groupName === 'Hội lập trình viên' && n.date === '1 Tháng 10, 2026', n);
  check('không dừng vì chặn', !res.blocked, res.blocked);
}

const POST = { id: '111_9001', groupId: '111', postId: '9001', groupName: 'Hội yêu mèo', snippet: 'Bán mèo con giá rẻ, ai cần liên hệ mình nhé!' };

async function del(mode, opts) {
  await nav(fileUrl('post.html', '?mode=' + mode));
  return evaluate(`(async () => {
    const res = await window.__FBPC.handle({ type: 'deletePost', post: ${JSON.stringify(POST)}, dryRun: ${!!opts.dryRun}, verify: ${opts.verify !== false} });
    await new Promise((r) => setTimeout(r, 300));
    return { res, log: window.__log };
  })()`);
}

async function testDelete() {
  console.log('\n[3] Xóa bài trên trang bài viết');
  let r = await del('ok', { dryRun: true });
  check('chạy thử: dryok, không xóa gì', r.res.status === 'dryok' && !r.log.some((x) => x.startsWith('DELETED')), r);
  check('chạy thử: menu đúng bài trong hộp thoại', !r.log.some((x) => /:555[56]$/.test(x)), r.log);

  r = await del('ok', {});
  check('xóa thật: deleted đúng bài 9001', r.res.status === 'deleted' && r.log.includes('DELETED:9001') && r.log.filter((x) => x.startsWith('DELETED')).length === 1, r);
  check('không báo chặn nhầm vì chữ trong hộp thoại bài', r.res.status !== 'blocked', r.res);
  check('khớp theo link chứa postId', r.res.verifiedBy === 'link', r.res);

  r = await del('nolabel', { dryRun: true });
  check('nút "…" khác nhãn: chạy thử nhận theo cấu trúc', r.res.status === 'dryok' && /cấu trúc/.test(r.res.verifiedBy) && !r.log.includes('COMMENT_MENU'), r);
  r = await del('nolabel', {});
  check('nút "…" khác nhãn: xóa đúng bài, không đụng bình luận/bài nền', r.res.status === 'deleted' && r.log.includes('DELETED:9001') && r.log.filter((x) => x.startsWith('DELETED')).length === 1 && !r.log.includes('COMMENT_MENU'), r);

  r = await del('nolinkmatch', {});
  check('khớp theo nội dung khi không có link', r.res.status === 'deleted' && r.res.verifiedBy === 'content', r.res);

  r = await del('mismatch', {});
  check('nội dung không khớp → lỗi, không xóa', r.res.status === 'error' && /Nội dung không khớp/.test(r.res.reason) && !r.log.some((x) => x.startsWith('DELETED')), r);

  r = await del('gone', {});
  check('bài không còn tồn tại → gone', r.res.status === 'gone', r.res);

  r = await del('blocked', {});
  check('cảnh báo "tạm thời bị chặn" sau xác nhận → blocked', r.res.status === 'blocked' && /tạm thời bị chặn/i.test(r.res.reason), r.res);

  r = await del('nodelete', {});
  check('menu không có "Xóa bài viết" → lỗi kèm danh sách menu', r.res.status === 'error' && Array.isArray(r.res.menuItems) && r.res.menuItems.includes('Lưu bài viết'), r.res);

  console.log('  (2 trường hợp không có hộp thoại – mỗi cái chờ 10 giây)');
  r = await del('nodialog', { verify: false });
  check('không hộp thoại + tắt kiểm tra: vẫn bắt buộc kiểm tra, xóa đúng bài', r.res.status === 'deleted' && r.log.includes('DELETED:9001') && !r.log.some((x) => /DELETED:555/.test(x)), r);

  r = await del('nodialog-mismatch', { verify: false });
  check('không hộp thoại + không khớp → lỗi, không xóa', r.res.status === 'error' && !r.log.some((x) => x.startsWith('DELETED')), r);
}

async function testSidepanel() {
  console.log('\n[4] Side panel (giả lập chrome.* API)');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__store = {};
    window.chrome = {
      storage: { local: {
        get: async (k) => ({ [k]: window.__store[k] }),
        set: async (o) => { Object.assign(window.__store, JSON.parse(JSON.stringify(o))); },
      } },
      runtime: { onMessage: { addListener() {} } },
      tabs: { query: async () => [], get: async () => ({}), onUpdated: { addListener() {}, removeListener() {} }, onRemoved: { addListener() {}, removeListener() {} } },
      scripting: {},
    };
    window.__store['fbpc_state_v1'] = { posts: [
      { id: '1_1', groupName: 'Hội yêu mèo', snippet: 'Bán mèo con, giá rẻ!', date: '2 Tháng 10, 2026', time: '17:55', url: 'https://www.facebook.com/groups/1/permalink/1/', status: 'processing', selected: true },
      { id: '1_2', groupName: 'Chợ đồ cũ', snippet: 'Thanh lý "tủ lạnh"', date: '1 Tháng 10, 2026', time: '09:00', url: 'https://www.facebook.com/groups/1/permalink/2/', status: 'deleted', selected: false },
      { id: 'nolink_x', groupName: 'Nhóm X', snippet: 'abc', date: '', time: '', url: '', status: 'nolink', selected: false },
    ], settings: {} };
  ` });
  await nav(pathToFileURL(join(HERE, '..', 'sidepanel.html')).href);
  await sleep(500);
  const r = await evaluate(`(async () => {
    const out = {};
    out.rows = document.querySelectorAll('#list .item').length;
    out.firstBadge = document.querySelector('#list .item .badge').textContent;
    out.counters = document.getElementById('counters').textContent;
    out.nolinkWarn = !document.getElementById('nolinkWarn').hidden;
    out.nolinkDisabled = document.querySelector('.item[data-id="nolink_x"] input').disabled;
    const s = document.getElementById('search'); s.value = 'BAN MEO'; s.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 300));
    out.searchRows = document.querySelectorAll('#list .item').length;
    s.value = ''; s.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 300));
    const f = document.getElementById('statusFilter'); f.value = 'deleted'; f.dispatchEvent(new Event('change'));
    out.deletedRows = document.querySelectorAll('#list .item').length;
    f.value = 'all'; f.dispatchEvent(new Event('change'));
    document.querySelector('.item[data-id="1_1"] .g').click();
    out.afterToggle = document.getElementById('counters').textContent;
    document.getElementById('btnSelectAll').click();
    out.afterSelectAll = document.getElementById('counters').textContent;
    out.runLabel = document.getElementById('btnRun').textContent;
    out.dryChecked = document.getElementById('optDry').checked;
    await new Promise((r) => setTimeout(r, 400));
    out.saved = window.__store['fbpc_state_v1'].posts.map((p) => p.status + ':' + p.selected);
    return out;
  })()`);
  check('hiển thị 3 dòng', r.rows === 3, r);
  check('bài "Đang xử lý" khi mở lại → "Chưa xóa"', r.firstBadge === 'Chưa xóa', r.firstBadge);
  check('bộ đếm', /Hiển thị 3 \/ 3 bài · Đã chọn 1 · Đã xóa 1/.test(r.counters), r.counters);
  check('cảnh báo không có link + không cho chọn', r.nolinkWarn && r.nolinkDisabled, r);
  check('tìm kiếm bỏ qua dấu câu/hoa thường', r.searchRows === 1, r.searchRows);
  check('lọc "Đã xóa"', r.deletedRows === 1, r.deletedRows);
  check('bấm vào dòng để bỏ tick', /Đã chọn 0/.test(r.afterToggle), r.afterToggle);
  check('chọn tất cả chỉ chọn bài chọn được', /Đã chọn 1/.test(r.afterSelectAll), r.afterSelectAll);
  check('chạy thử bật mặc định', r.dryChecked && /chạy thử \(1\)/i.test(r.runLabel), r);
  check('đã lưu vào storage', r.saved[0] === 'pending:true', r.saved);
}

try {
  await connect();
  await testUrls();
  await testScan();
  await testDelete();
  await testSidepanel();
} catch (e) {
  fail++;
  console.error('LỖI:', e);
} finally {
  console.log(`\nKết quả: ${pass} đạt, ${fail} không đạt`);
  try { ws?.close(); } catch {}
  proc.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}

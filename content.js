/*
 * FB Group Post Cleaner – content script.
 * Chạy trên https://*.facebook.com/*. Chỉ dựa vào chữ hiển thị, role và aria-label
 * (Facebook mã hoá class CSS). Không gọi API nội bộ, không đọc/gửi cookie hay token
 * (chỉ đọc c_user để biết UID dựng URL nhật ký).
 *
 * Khi nạp bằng thẻ <script> trong trang mô phỏng (không có chrome.runtime) thì
 * dùng được qua window.__FBPC.handle(msg) để kiểm thử.
 */
(() => {
  'use strict';
  if (window.__FBPC && window.__FBPC.version) return; // đã nạp rồi

  const VERSION = '1.0.0';
  const HAS_RUNTIME = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);

  // ---------------------------------------------------------------- tiện ích chữ
  const norm = (s) => String(s == null ? '' : s).normalize('NFC').replace(/[\s ​‎‏]+/g, ' ').trim();

  // "Xoá" và "Xóa" là 2 chuỗi khác nhau kể cả sau NFC -> đưa về một kiểu bỏ dấu.
  const TONE_FIX = [
    [/oá/g, 'óa'], [/oà/g, 'òa'], [/oả/g, 'ỏa'], [/oã/g, 'õa'], [/oạ/g, 'ọa'],
    [/oé/g, 'óe'], [/oè/g, 'òe'], [/oẻ/g, 'ỏe'], [/oẽ/g, 'õe'], [/oẹ/g, 'ọe'],
    [/uý/g, 'úy'], [/uỳ/g, 'ùy'], [/uỷ/g, 'ủy'], [/uỹ/g, 'ũy'], [/uỵ/g, 'ụy'],
  ];
  function canon(s) {
    let t = norm(s).toLowerCase();
    for (const [re, r] of TONE_FIX) t = t.replace(re, r);
    return t;
  }
  const alnum = (s) => canon(s).replace(/[^\p{L}\p{N}]+/gu, '');

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => Math.round(a + Math.random() * (b - a));

  // ---------------------------------------------------------------- nhãn VI / EN
  const VIEW_LABELS = ['xem', 'view'];
  const POSTED_VERBS = ['đã đăng trong', 'posted in'];
  const COMMENT_VERBS = ['đã bình luận', 'đã trả lời', 'đã phản hồi', 'commented on', 'replied to'];
  const ACTION_LABELS = ['hành động với bài viết này', 'actions for this post'].map(canon);
  const DELETE_ITEM = ['xóa bài viết', 'delete post'].map(canon);
  const CONFIRM_BTN = ['xóa', 'delete'].map(canon);
  const CONFIRM_TITLES = ['xóa bài viết?', 'delete post?'].map(canon);
  const GONE_TEXTS = [
    'nội dung này hiện không hiển thị',
    'this content isn\'t available',
    'this content isn’t available',
  ].map(canon);
  const BLOCK_TEXTS = [
    'tạm thời bị chặn', 'quá nhanh', 'tạm thời bị hạn chế', 'xác nhận danh tính', 'đã bị khóa',
    'temporarily blocked', 'too fast', 'we limit how often', 'confirm your identity',
  ].map(canon);
  const PRIVACY_WORDS = [
    'nhóm công khai', 'nhóm riêng tư', 'public group', 'private group',
    'công khai', 'riêng tư', 'public', 'private', 'chỉ mình tôi', 'only me', 'bạn bè', 'friends',
    'đã ẩn khỏi trang cá nhân', 'hidden from profile',
  ].map(canon);
  const LOADING_LABELS = ['đang tải...', 'đang tải…', 'đang tải', 'loading...', 'loading…', 'loading'];

  const TIME_RE = /^(\d{1,2}:\d{2})(\s?[ap]\.?m\.?)?$/i;
  const MONTHS_EN = 'january|february|march|april|may|june|july|august|september|october|november|december';
  const DATE_RES = [
    /^(?:ngày\s+)?\d{1,2}\s+tháng\s+\d{1,2}(?:,?\s+(?:năm\s+)?\d{4})?$/iu,
    new RegExp(`^(?:${MONTHS_EN})\\s+\\d{1,2}(?:,\\s*\\d{4})?$`, 'i'),
    new RegExp(`^\\d{1,2}\\s+(?:${MONTHS_EN})(?:,?\\s+\\d{4})?$`, 'i'),
    /^(hôm nay|hôm qua|today|yesterday)$/iu,
  ];

  function isDateLabel(t) {
    t = norm(t);
    if (t.length < 4 || t.length > 40) return false;
    return DATE_RES.some((re) => re.test(t));
  }

  function resolveDateLabel(t) {
    const c = canon(t);
    const fmt = (d) => `${d.getDate()} Tháng ${d.getMonth() + 1}, ${d.getFullYear()}`;
    if (c === 'hôm nay' || c === 'today') return fmt(new Date());
    if (c === 'hôm qua' || c === 'yesterday') return fmt(new Date(Date.now() - 864e5));
    return norm(t);
  }

  // ---------------------------------------------------------------- DOM
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  }

  function textOf(el) {
    if (!el) return '';
    return el.innerText != null ? el.innerText : el.textContent || '';
  }

  const label = (el) => canon(el.getAttribute && el.getAttribute('aria-label'));

  /** Loại phần tử nằm trong phần tử khác cũng có mặt trong danh sách (giữ cái ngoài cùng). */
  function outermost(list) {
    const set = new Set(list);
    return list.filter((el) => {
      for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
      return true;
    });
  }

  async function waitFor(fn, timeout = 5000, step = 250) {
    const end = Date.now() + timeout;
    for (;;) {
      let v;
      try { v = fn(); } catch (_) { v = null; }
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(step);
    }
  }

  /** Click mô phỏng người thật: cuộn tới, pointerover → mousedown → mouseup → click tại toạ độ ngẫu nhiên. */
  async function humanClick(el) {
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (_) { el.scrollIntoView(); }
    await sleep(rand(180, 420));
    const r = el.getBoundingClientRect();
    const x = r.left + r.width * (0.25 + Math.random() * 0.5);
    const y = r.top + r.height * (0.25 + Math.random() * 0.5);
    let t = document.elementFromPoint(x, y);
    if (!t || !(t === el || el.contains(t))) t = el;
    const base = {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, screenX: x + (window.screenX || 0), screenY: y + (window.screenY || 0), button: 0,
    };
    const ptr = { pointerId: 1, pointerType: 'mouse', isPrimary: true };
    const fire = (type, extra = {}) => {
      const isPtr = type.startsWith('pointer');
      const Ctor = isPtr && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      t.dispatchEvent(new Ctor(type, { ...base, ...(isPtr ? ptr : {}), ...extra }));
    };
    fire('pointerover');
    fire('mouseover');
    await sleep(rand(30, 90));
    fire('pointerdown', { buttons: 1 });
    fire('mousedown', { buttons: 1 });
    await sleep(rand(50, 140));
    fire('pointerup');
    fire('mouseup');
    fire('click', { detail: 1 });
    await sleep(rand(250, 600));
  }

  function pressEscape() {
    const target = document.activeElement || document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true,
    }));
  }

  // ---------------------------------------------------------------- tìm văn bản trên trang (bỏ script/style)
  function pageHasText(phrases, root = document.body) {
    if (!root) return null;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return NodeFilter.FILTER_REJECT;
        return n.nodeValue.length > 3 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let n;
    while ((n = w.nextNode())) {
      const c = canon(n.nodeValue);
      for (const ph of phrases) if (c.includes(ph)) return n.parentElement;
    }
    return null;
  }

  // ---------------------------------------------------------------- UID
  function getUid() {
    const m = document.cookie.match(/(?:^|;\s*)c_user=(\d+)/);
    if (m) return m[1];
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent;
      if (!t || t.length > 2e6) continue;
      const mm = t.match(/"USER_ID":"(\d{5,})"/) || t.match(/"actorID":"(\d{5,})"/);
      if (mm && mm[1] !== '0') return mm[1];
    }
    return null;
  }

  // ---------------------------------------------------------------- chặn / checkpoint
  function isLoginPage() {
    const p = location.pathname;
    if (/^\/(login|login\.php)(\/|$)/i.test(p) || /^\/recover\//i.test(p)) return true;
    const pass = document.querySelector('form input[name="pass"]');
    return !!(pass && !/(?:^|;\s*)c_user=/.test(document.cookie) && isVisible(pass));
  }

  /**
   * Trả về lý do nếu thấy dấu hiệu bị chặn/checkpoint, ngược lại null.
   * Không quét hộp thoại/vùng đang chứa bài viết (có nút "Hành động với bài viết này").
   */
  function detectBlock() {
    if (/\/checkpoint/i.test(location.href)) return 'Facebook chuyển tới trang checkpoint (' + location.pathname + ')';
    if (isLoginPage()) return 'Bị chuyển về trang đăng nhập';
    // vùng chứa bài viết: hộp thoại có nút hành động (hoặc chính khung bài nếu không có hộp thoại)
    const postZones = findActionButtons().map((b) => b.closest('[role="dialog"]') || b.parentElement || b);
    const els = document.querySelectorAll('[role="dialog"],[role="alertdialog"],[role="alert"],[role="status"],[aria-live]');
    for (const el of els) {
      if (postZones.some((z) => z.contains(el) || el.contains(z))) continue;
      if (!isVisible(el)) continue;
      const t = canon(textOf(el));
      if (!t) continue;
      for (const ph of BLOCK_TEXTS) {
        if (t.includes(ph)) return 'Facebook cảnh báo: "' + norm(textOf(el)).slice(0, 160) + '"';
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- liên kết bài viết
  const TRACK_PARAMS = new Set([
    'ref', 'refid', 'fref', 'hc_ref', 'hc_location', 'eid', '_rdr', 'paipv', 'mibextid', 'rdid',
    'share_url', 'comment_tracking', 'notif_id', 'notif_t', 'sfnsn', 'extid', 'locale', 'acontext',
    'av', 'source', 'set', 'idorvanity', 'sk', 'action_history', 'tn', 'tn_',
  ]);

  function cleanUrl(u) {
    for (const k of [...u.searchParams.keys()]) {
      if (k.startsWith('__') || TRACK_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k);
    }
    u.hash = '';
    return u;
  }

  function buildPost(groupId, postId) {
    let g = groupId, p = postId;
    try { g = decodeURIComponent(g); } catch (_) {}
    try { p = decodeURIComponent(p); } catch (_) {}
    if (!g || !p) return null;
    return {
      groupId: g,
      postId: p,
      url: `https://www.facebook.com/groups/${encodeURIComponent(g)}/permalink/${encodeURIComponent(p)}/`,
    };
  }

  /** Chuẩn hoá link bài về /groups/{groupId}/permalink/{postId}/. */
  function parsePostUrl(href) {
    if (!href) return null;
    let u;
    try { u = new URL(href, location.href); } catch (_) { return null; }
    // l.facebook.com/l.php?u=...
    if (/\/l\.php$/i.test(u.pathname) && u.searchParams.get('u')) return parsePostUrl(u.searchParams.get('u'));
    cleanUrl(u);
    const path = u.pathname.replace(/\/+$/, '');
    let m;
    if ((m = path.match(/^\/groups\/([^/]+)\/(?:permalink|posts)\/([^/]+)/i))) return buildPost(m[1], m[2]);
    const mp = u.searchParams.get('multi_permalinks');
    if (mp && (m = path.match(/^\/groups\/([^/]+)$/i))) return buildPost(m[1], mp.split(',')[0]);
    if (/\/(permalink|story)\.php$/i.test(path)) {
      const sid = u.searchParams.get('story_fbid');
      const id = u.searchParams.get('id');
      if (sid && id) return buildPost(id, sid);
    }
    return null;
  }

  // ---------------------------------------------------------------- nhật ký hoạt động
  function findViewButtons(root = document) {
    const out = [];
    for (const el of root.querySelectorAll('a, [role="link"], [role="button"]')) {
      const t = canon(el.textContent);
      if (VIEW_LABELS.includes(t) || (t === '' && VIEW_LABELS.includes(label(el)))) out.push(el);
    }
    return outermost(out);
  }

  function hrefOf(btn) {
    const a = (btn.tagName === 'A' && btn.hasAttribute('href') ? btn : null) || btn.closest('a[href]') || btn.querySelector('a[href]');
    const h = a && a.getAttribute('href');
    if (!h || h === '#' || /^javascript:/i.test(h)) return null;
    try { return new URL(h, location.href).href; } catch (_) { return null; }
  }

  const STOP_ROLES = new Set(['main', 'navigation', 'banner', 'complementary', 'feed']);

  /** Khung mục = tổ tiên cao nhất chỉ chứa đúng 1 nút "Xem". */
  function computeFrames(buttons, dateHeaders = []) {
    const counts = new Map();
    const bump = (el) => {
      for (let p = el; p && p !== document.documentElement; p = p.parentElement) counts.set(p, (counts.get(p) || 0) + 1);
    };
    for (const b of buttons) bump(b);
    // đếm tiêu đề ngày để không trèo lên vùng chứa nhiều ngày
    const dcounts = new Map();
    for (const h of dateHeaders) {
      for (let p = h; p && p !== document.documentElement; p = p.parentElement) dcounts.set(p, (dcounts.get(p) || 0) + 1);
    }
    return buttons.map((b) => {
      let f = b;
      for (let p = b.parentElement; p && p !== document.body; p = p.parentElement) {
        if (counts.get(p) !== 1) break;
        if ((dcounts.get(p) || 0) > 1) break;
        const role = p.getAttribute('role');
        if (role && STOP_ROLES.has(role)) break;
        f = p;
      }
      return f;
    });
  }

  function findDateHeaders() {
    const res = [];
    if (!document.body) return res;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const v = n.nodeValue;
      if (!v || v.length < 4 || v.length > 60) continue;
      const t = norm(v);
      if (!isDateLabel(t)) continue;
      const el = n.parentElement;
      if (!el || norm(el.textContent) !== t) continue;
      if (res[res.length - 1] === el) continue;
      res.push(el);
    }
    return res;
  }

  /** Tiêu đề ngày gần nhất phía trên nút (danh sách headers đã theo thứ tự tài liệu). */
  function dateFor(btn, headers) {
    let lo = 0, hi = headers.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (headers[mid].compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING) { best = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return best >= 0 ? resolveDateLabel(headers[best].textContent) : '';
  }

  function isMetaLine(line) {
    const tokens = norm(line).split(/\s*[·•]\s*/).filter(Boolean);
    if (!tokens.length) return true;
    return tokens.every((tk) => {
      const c = canon(tk);
      return PRIVACY_WORDS.includes(c) || TIME_RE.test(tk) || VIEW_LABELS.includes(c) || isDateLabel(tk) || /^[.…·•]+$/.test(tk);
    });
  }

  function timeIn(line) {
    for (const tk of norm(line).split(/\s*[·•]\s*/)) if (TIME_RE.test(tk)) return tk;
    return '';
  }

  /** Phân tích một mục nhật ký. */
  function parseEntry(btn, frame, headers) {
    const lines = textOf(frame).split(/\n+/).map(norm).filter(Boolean);
    let titleIdx = -1, kind = 'other';
    for (let i = 0; i < lines.length; i++) {
      const c = canon(lines[i]);
      if (POSTED_VERBS.some((v) => c.includes(v))) { titleIdx = i; kind = 'post'; break; }
      if (COMMENT_VERBS.some((v) => c.includes(v))) { titleIdx = i; kind = 'comment'; break; }
    }
    const res = { kind, title: titleIdx >= 0 ? lines[titleIdx] : (lines[0] || '') };
    if (kind !== 'post') return res;

    const gm = lines[titleIdx].match(/(?:đã đăng trong|posted in)\s+(.+?)\s*\.?\s*$/iu);
    res.groupName = gm ? gm[1] : '';

    let time = '';
    const body = [];
    for (const line of lines.slice(titleIdx + 1)) {
      const t = timeIn(line);
      if (t && !time) time = t;
      if (isMetaLine(line)) continue;
      body.push(line);
    }
    res.snippet = body.join(' ').slice(0, 300);
    res.time = time;
    res.date = dateFor(btn, headers);
    res.href = hrefOf(btn);
    res.link = parsePostUrl(res.href);
    return res;
  }

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  function isLoading() {
    for (const el of document.querySelectorAll('[role="progressbar"],[aria-busy="true"],[data-visualcompletion="loading-state"]')) {
      if (isVisible(el)) return true;
    }
    for (const el of document.querySelectorAll('[aria-label]')) {
      if (LOADING_LABELS.includes(label(el)) && isVisible(el)) return true;
    }
    return false;
  }

  let scanState = null;

  function collectNew(st) {
    const buttons = findViewButtons();
    const headers = findDateHeaders();
    const frames = computeFrames(buttons, headers);
    const newPosts = [];
    let newEntries = 0;
    buttons.forEach((btn, i) => {
      if (st.seen.has(btn)) return;
      st.seen.add(btn);
      newEntries++;
      const e = parseEntry(btn, frames[i], headers);
      if (e.kind !== 'post') { st.skipped++; return; }
      let item;
      if (e.link) {
        item = {
          id: `${e.link.groupId}_${e.link.postId}`, groupId: e.link.groupId, postId: e.link.postId,
          url: e.link.url, status: 'pending',
        };
      } else {
        item = {
          id: 'nolink_' + hashStr([e.groupName, e.date, e.time, e.snippet].join('|')),
          groupId: '', postId: '', url: '', status: 'nolink', rawHref: e.href || '',
        };
      }
      Object.assign(item, { groupName: e.groupName, snippet: e.snippet, date: e.date, time: e.time });
      if (st.ids.has(item.id)) return;
      st.ids.add(item.id);
      st.found++;
      if (!e.link) st.nolink++;
      newPosts.push(item);
    });
    return { newPosts, newEntries, totalButtons: buttons.length };
  }

  function scrollDown() {
    const se = document.scrollingElement || document.documentElement;
    const btns = findViewButtons();
    const last = btns[btns.length - 1];
    if (last) { try { last.scrollIntoView({ block: 'end', behavior: 'instant' }); } catch (_) { last.scrollIntoView(false); } }
    se.scrollTo(0, se.scrollHeight);
    window.dispatchEvent(new Event('scroll'));
  }

  async function scan() {
    if (scanState && scanState.running) return { error: 'Đang quét rồi.' };
    const st = scanState = { running: true, stop: false, seen: new WeakSet(), ids: new Set(), found: 0, skipped: 0, nolink: 0 };
    let idle = 0, round = 0, blocked = null;
    try {
      while (!st.stop) {
        round++;
        blocked = detectBlock();
        if (blocked) break;
        const { newPosts, newEntries, totalButtons } = collectNew(st);
        const loading = isLoading();
        if (newEntries > 0) idle = 0;
        else if (!loading) idle++;
        report({
          type: 'scanProgress', items: newPosts, found: st.found, skipped: st.skipped, nolink: st.nolink,
          round, idle, loading, totalButtons,
        });
        if (idle >= 5) break;
        scrollDown();
        const wait = rand(1200, 2200);
        const end = Date.now() + wait;
        while (Date.now() < end && !st.stop) await sleep(150);
      }
      if (!blocked) {
        // vòng cuối – lấy nốt mục vừa tải
        const { newPosts } = collectNew(st);
        if (newPosts.length) report({ type: 'scanProgress', items: newPosts, found: st.found, skipped: st.skipped, nolink: st.nolink, round, idle });
      }
    } finally {
      st.running = false;
    }
    const result = { type: 'scanDone', found: st.found, skipped: st.skipped, nolink: st.nolink, stopped: st.stop, blocked, rounds: round };
    report(result);
    return result;
  }

  // ---------------------------------------------------------------- trang bài viết
  /** Nút "…" có nhãn đúng "Hành động với bài viết này" / "Actions for this post". */
  function findLabeledActionButtons() {
    const out = [];
    for (const el of document.querySelectorAll('[aria-label]')) {
      if (ACTION_LABELS.includes(label(el))) out.push(el);
    }
    return outermost(out);
  }

  const COMMENT_HINT = /bình luận|comment|phản hồi|reply/;

  /** Hộp thoại trông như hộp thoại bài viết (có link nhóm/bài hoặc article), không phải hộp xác nhận. */
  function looksLikePostDialog(d) {
    return !!d.querySelector('[role="article"], a[href*="/groups/"], a[href*="/posts/"], a[href*="/permalink"], a[href*="story_fbid"]');
  }

  /**
   * Dự phòng khi Facebook đổi aria-label: trong hộp thoại bài viết, lấy nút menu đầu tiên
   * không có chữ (nút "…" ở đầu bài). Bỏ qua nút "…" của bình luận.
   */
  function fallbackMenuButton(dialog) {
    const ok = (b) => isVisible(b) && !norm(b.textContent) && !COMMENT_HINT.test(label(b)) && !b.closest('[role="menu"]');
    const tiers = [
      '[role="button"][aria-haspopup="menu"]',
      '[role="button"][aria-haspopup="true"]',
      '[role="button"][aria-expanded]',
    ];
    for (const sel of tiers) {
      const b = [...dialog.querySelectorAll(sel)].find(ok);
      if (b) return b;
    }
    return null;
  }

  /** Nút "…" của bài: theo nhãn, cộng dự phòng cho hộp thoại bài viết không có nút đúng nhãn. */
  function findActionButtons() {
    const labeled = findLabeledActionButtons();
    const out = [...labeled];
    for (const d of document.querySelectorAll('[role="dialog"]')) {
      if (labeled.some((b) => d.contains(b))) continue;
      if (!isVisible(d) || !looksLikePostDialog(d)) continue;
      const b = fallbackMenuButton(d);
      if (b) { b.__fbpcFallback = true; out.push(b); }
    }
    return out;
  }

  function visibleDialogs() {
    return [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')].filter(isVisible);
  }

  /** Khung bài: trong hộp thoại thì là hộp thoại; ngoài ra là tổ tiên cao nhất chỉ chứa 1 nút hành động. */
  function postFrame(btn, allBtns) {
    const dlg = btn.closest('[role="dialog"]');
    if (dlg) return dlg;
    let f = btn;
    for (let p = btn.parentElement; p && p !== document.body; p = p.parentElement) {
      if (allBtns.filter((b) => p.contains(b)).length > 1) break;
      const role = p.getAttribute('role');
      if (role && STOP_ROLES.has(role) && role !== 'feed' && f !== btn) break;
      f = p;
    }
    return f;
  }

  function verifyFrame(frame, post) {
    const pid = String(post.postId || '');
    if (pid.length >= 4) {
      for (const a of frame.querySelectorAll('a[href]')) {
        const h = a.getAttribute('href') || '';
        if (h.includes('/' + pid) || h.includes('=' + pid)) return { ok: true, by: 'link' };
      }
    }
    const ft = alnum(textOf(frame));
    const key = alnum(post.snippet || '').slice(0, 30);
    if (key) {
      if (ft.includes(key)) {
        if (key.length >= 5) return { ok: true, by: 'content' };
        if (post.groupName && ft.includes(alnum(post.groupName))) return { ok: true, by: 'content+group' };
      }
      return { ok: false };
    }
    if (post.groupName && ft.includes(alnum(post.groupName))) return { ok: true, by: 'group' };
    return { ok: false };
  }

  function visibleMenuItems() {
    const menus = [...document.querySelectorAll('[role="menu"]')].filter(isVisible);
    let items = [];
    for (const m of menus) items.push(...m.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]'));
    if (!items.length) items = [...document.querySelectorAll('[role="menuitem"]')];
    return items.filter(isVisible);
  }

  async function closeMenu(actionBtn) {
    pressEscape();
    await sleep(rand(300, 600));
    if (visibleMenuItems().length && actionBtn && actionBtn.isConnected) {
      await humanClick(actionBtn);
    }
  }

  function findConfirmDialog(postDialog) {
    for (const d of visibleDialogs()) {
      if (d === postDialog || (postDialog && d.contains(postDialog))) continue;
      if (findActionButtons().some((b) => d.contains(b))) continue;
      const btn = [...d.querySelectorAll('[role="button"],button')].find((b) => {
        const t = canon(b.textContent);
        return isVisible(b) && (CONFIRM_BTN.includes(t) || (!t && CONFIRM_BTN.includes(label(b))));
      });
      if (btn) return { dialog: d, button: btn };
      // tiêu đề "Xóa bài viết?" nhưng nút chưa hiện
      if (CONFIRM_TITLES.some((x) => canon(textOf(d)).includes(x))) continue;
    }
    return null;
  }

  function isGone() {
    return !!pageHasText(GONE_TEXTS);
  }

  async function deletePost({ post, dryRun, verify }) {
    if (!post) return { status: 'error', reason: 'Thiếu dữ liệu bài' };
    let block = detectBlock();
    if (block) return { status: 'blocked', reason: block };

    // 1) chờ hộp thoại bài viết có nút "Hành động với bài viết này"
    let candidates = null, inDialog = true;
    const found = await waitFor(() => {
      if (isGone()) return 'gone';
      const b = detectBlock();
      if (b) { block = b; return 'blocked'; }
      const inD = findActionButtons().filter((x) => x.closest('[role="dialog"]') && isVisible(x));
      return inD.length ? inD : null;
    }, 10000, 300);
    if (found === 'gone') return { status: 'gone', reason: 'Nội dung này hiện không hiển thị' };
    if (found === 'blocked') return { status: 'blocked', reason: block };
    if (Array.isArray(found)) {
      candidates = found;
    } else {
      if (isGone()) return { status: 'gone', reason: 'Nội dung này hiện không hiển thị' };
      candidates = findActionButtons().filter(isVisible);
      inDialog = false;
      if (!candidates.length) return { status: 'error', reason: 'Không tìm thấy nút "Hành động với bài viết này" sau 10 giây' };
    }

    // 2) kiểm tra đúng bài (bắt buộc nếu bài không nằm trong hộp thoại)
    const all = findActionButtons();
    const mustVerify = verify !== false || !inDialog;
    let target = null, verifiedBy = 'off';
    // ưu tiên hộp thoại trên cùng (mở sau cùng)
    const ordered = inDialog ? [...candidates].reverse() : candidates;
    for (const b of ordered) {
      const frame = postFrame(b, all);
      if (!mustVerify) { target = { btn: b, frame }; break; }
      const v = verifyFrame(frame, post);
      if (v.ok) { target = { btn: b, frame }; verifiedBy = v.by; break; }
    }
    if (!target) {
      return { status: 'error', reason: 'Nội dung không khớp' + (inDialog ? '' : ' (bài không nằm trong hộp thoại)'), inDialog };
    }
    const postDialog = target.btn.closest('[role="dialog"]');
    if (target.btn.__fbpcFallback) verifiedBy += ' (nút "…" nhận theo cấu trúc)';

    // 3) mở menu "…"
    await humanClick(target.btn);
    let items = await waitFor(() => { const it = visibleMenuItems(); return it.length ? it : null; }, 5000, 250);
    if (!items) {
      await humanClick(target.btn); // thử lại một lần
      items = await waitFor(() => { const it = visibleMenuItems(); return it.length ? it : null; }, 4000, 250);
    }
    if (!items) return { status: 'error', reason: 'Không mở được menu "…" của bài', inDialog, verifiedBy };
    // chờ menu hiện đủ (đôi khi mục tải dần)
    await sleep(rand(300, 600));
    items = visibleMenuItems();
    const menuTexts = items.map((i) => norm(textOf(i)).split('\n')[0]).filter(Boolean);
    const delItem = items.find((i) => {
      const t = canon(textOf(i));
      return DELETE_ITEM.some((d) => t === d || t.startsWith(d));
    });

    block = detectBlock();
    if (block) { await closeMenu(target.btn); return { status: 'blocked', reason: block }; }

    if (!delItem) {
      await closeMenu(target.btn);
      return { status: 'error', reason: 'Không có mục "Xóa bài viết" (menu: ' + menuTexts.join(' | ') + ')', menuItems: menuTexts, inDialog, verifiedBy };
    }

    if (dryRun) {
      await closeMenu(target.btn);
      return { status: 'dryok', reason: 'Thấy mục "Xóa bài viết" – không xóa (chạy thử)', menuItems: menuTexts, inDialog, verifiedBy };
    }

    // 4) bấm "Xóa bài viết" → hộp thoại xác nhận → "Xóa"
    await humanClick(delItem);
    const conf = await waitFor(() => findConfirmDialog(postDialog) || (detectBlock() ? 'blocked' : null), 8000, 250);
    if (conf === 'blocked') return { status: 'blocked', reason: detectBlock() };
    if (!conf) return { status: 'error', reason: 'Không thấy hộp thoại xác nhận "Xóa bài viết?"', inDialog, verifiedBy };
    await sleep(rand(400, 900));
    await humanClick(conf.button);
    report({ type: 'deleteStage', id: post.id, stage: 'confirmClicked' });

    const closed = await waitFor(() => (!conf.dialog.isConnected || !isVisible(conf.dialog) ? true : (detectBlock() ? 'blocked' : null)), 15000, 250);
    if (closed === 'blocked') return { status: 'blocked', reason: detectBlock(), maybeDeleted: true };
    if (!closed) return { status: 'error', reason: 'Hộp thoại xác nhận không đóng sau 15 giây', inDialog, verifiedBy };

    await sleep(rand(800, 1500));
    block = detectBlock();
    if (block) return { status: 'blocked', reason: block, maybeDeleted: true };
    return { status: 'deleted', inDialog, verifiedBy };
  }

  // ---------------------------------------------------------------- chẩn đoán
  function diagnose() {
    const buttons = findViewButtons();
    const headers = findDateHeaders();
    const frames = computeFrames(buttons, headers);
    const samples = buttons.slice(0, 3).map((b, i) => {
      const f = frames[i];
      const e = parseEntry(b, f, headers);
      return {
        viewButton: { tag: b.tagName.toLowerCase(), role: b.getAttribute('role'), href: b.getAttribute('href') || (b.closest('a[href]') || {}).href || null },
        frameTag: f.tagName.toLowerCase(),
        frameText: norm(textOf(f)).slice(0, 600),
        ariaLabels: [...f.querySelectorAll('[aria-label]')].map((x) => x.getAttribute('aria-label')).slice(0, 25),
        parsed: { kind: e.kind, title: e.title, groupName: e.groupName, date: e.date, time: e.time, snippet: e.snippet, link: e.link },
      };
    });
    const action = findActionButtons();
    return {
      tool: 'FB Group Post Cleaner ' + VERSION,
      time: new Date().toISOString(),
      url: location.href,
      lang: document.documentElement.lang || '',
      viewButtons: buttons.length,
      dateHeaders: headers.length,
      dateHeaderSamples: headers.slice(0, 5).map((h) => norm(h.textContent)),
      loading: isLoading(),
      samples,
      actionButtons: action.length,
      actionButtonsInDialog: action.filter((b) => b.closest('[role="dialog"]')).length,
      dialogs: visibleDialogs().map((d) => ({
        role: d.getAttribute('role'),
        ariaLabel: d.getAttribute('aria-label'),
        text: norm(textOf(d)).slice(0, 300),
        hasActionButton: action.some((b) => d.contains(b)),
        looksLikePost: looksLikePostDialog(d),
        iconButtons: [...d.querySelectorAll('[role="button"]')]
          .filter((b) => isVisible(b) && !norm(b.textContent))
          .slice(0, 25)
          .map((b) => ({
            ariaLabel: b.getAttribute('aria-label'),
            haspopup: b.getAttribute('aria-haspopup'),
            expanded: b.getAttribute('aria-expanded'),
            chosen: action.includes(b),
          })),
      })),
      labeledActionButtons: findLabeledActionButtons().length,
      fallbackActionButtons: action.filter((b) => b.__fbpcFallback).length,
      menuItems: visibleMenuItems().map((i) => norm(textOf(i))),
      gone: isGone(),
      block: detectBlock(),
    };
  }

  // ---------------------------------------------------------------- giao tiếp
  function report(msg) {
    if (HAS_RUNTIME) {
      try { chrome.runtime.sendMessage({ ...msg, __fbpcEvent: true }).catch(() => {}); } catch (_) {}
    } else {
      try { window.dispatchEvent(new CustomEvent('fbpc-event', { detail: msg })); } catch (_) {}
    }
  }

  async function handle(msg) {
    switch (msg && msg.type) {
      case 'ping': return { ok: true, version: VERSION, url: location.href };
      case 'getUid': return { uid: getUid() };
      case 'startScan': return scan();
      case 'stopScan': if (scanState) scanState.stop = true; return { ok: true };
      case 'deletePost': return deletePost(msg);
      case 'checkBlock': return { block: detectBlock(), gone: isGone(), url: location.href };
      case 'diagnose': return diagnose();
      default: return { error: 'Lệnh không hợp lệ: ' + (msg && msg.type) };
    }
  }

  window.__FBPC = {
    version: VERSION,
    handle,
    _t: { norm, canon, alnum, parsePostUrl, isDateLabel, findViewButtons, findActionButtons, detectBlock, verifyFrame },
  };

  if (HAS_RUNTIME) {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || !msg.__fbpc) return false;
      handle(msg).then(sendResponse, (e) => sendResponse({ error: String((e && e.message) || e) }));
      return true;
    });
  }
})();

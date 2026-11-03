'use strict';

// ============================================================
// ตัวแทน window.api สำหรับเปิดแอปผ่านเว็บเบราว์เซอร์
// ชื่อคำสั่งชุดเดียวกับ src/main/preload.js ทุกตัว → POST /api/call/<channel>
// เหตุการณ์สด (snapshot/tick/ผลออร์เดอร์/ปิดอัตโนมัติ/เข้าอัตโนมัติ) → SSE /api/events
// ในแอป Electron มี window.api จาก preload อยู่แล้ว = ไฟล์นี้ไม่ทำอะไร
// ============================================================
(function () {
  if (window.api) return;
  window.GS_WEB = true;

  const toLogin = () => { location.href = '/login'; };
  async function call(channel, ...args) {
    let res;
    try {
      res = await fetch('/api/call/' + encodeURIComponent(channel), {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-gs-web': '1' },
        body: JSON.stringify({ args }),
      });
    } catch (e) { throw new Error('เชื่อมต่อเครื่องหลักไม่ได้ — ตรวจว่าแอปบนเครื่องเปิดอยู่'); }
    if (res.status === 401) { toLogin(); throw new Error('ต้องล็อกอินใหม่'); }
    let j = null;
    try { j = await res.json(); } catch { void 0; }
    if (!res.ok || !j || !j.ok) throw new Error((j && j.reason) || ('เครื่องหลักตอบ ' + res.status));
    return j.result;
  }
  const onlyOnHost = (what) => () => Promise.reject(new Error(`${what} ทำได้บนเครื่องหลักเท่านั้น`));

  // ---------- ข้อมูลสด ----------
  const listeners = {};
  const on = (ch) => (cb) => { (listeners[ch] = listeners[ch] || []).push(cb); };
  let es = null;
  function connect() {
    es = new EventSource('/api/events');
    for (const ch of ['snapshot', 'tick', 'order-result', 'auto-close', 'auto-enter']) {
      es.addEventListener(ch, (ev) => {
        let data = null;
        try { data = JSON.parse(ev.data); } catch { return; }
        for (const cb of listeners[ch] || []) { try { cb(data); } catch (e) { console.error(e); } }
      });
    }
    es.onerror = async () => {
      // หลุด: ถ้าเพราะ session หมด → ไปหน้าล็อกอิน • ถ้าเน็ต/เครื่องหลักหลุด EventSource ต่อใหม่เอง
      try { const r = await fetch('/api/call/get-web-url', { method: 'POST', headers: { 'x-gs-web': '1', 'content-type': 'application/json' }, body: '{}' }); if (r.status === 401) toLogin(); } catch { void 0; }
    };
  }

  window.api = {
    getState: () => call('get-state'),
    getSettings: () => call('get-settings'),
    saveSettings: (partial) => call('save-settings', partial),
    listPlugins: () => call('list-plugins'),
    togglePlugin: (id, enabled) => call('toggle-plugin', { id, enabled }),
    reloadPlugins: () => call('reload-plugins'),
    refreshNow: () => call('refresh-now'),
    openPluginsDir: onlyOnHost('เปิดโฟลเดอร์ plugin'),
    installEa: () => call('install-ea'),
    eaStatus: () => call('ea-status'),
    sendOrder: (req) => call('send-order', req),
    closePosition: (ticket) => call('close-position', ticket),
    modifyPosition: (req) => call('modify-position', req),
    sendPending: (req) => call('send-pending', req),
    cancelPending: (ticket) => call('cancel-pending', ticket),
    modifyPending: (req) => call('modify-pending', req),
    getWebUrl: () => call('get-web-url'),
    closeAll: () => call('close-all'),
    pickBridgeFile: onlyOnHost('เลือกไฟล์ bridge'),
    reportError: (msg, stack) => call('client-error', { msg: String(msg).slice(0, 500), stack: String(stack || '').slice(0, 2000) }).catch(() => {}),
    getRoundHistory: () => call('get-round-history'),
    openHistoryWindow: () => { window.open('/history.html', '_blank', 'noopener'); return Promise.resolve(true); },
    webAccessGet: () => Promise.resolve({ web: true }),
    webAccessSet: onlyOnHost('ตั้งค่าเว็บ/รหัสผ่าน'),
    webAccessLogoutAll: onlyOnHost('ออกจากระบบทุกเครื่อง'),
    tunnelStart: onlyOnHost('เปิด tunnel'),
    tunnelStop: onlyOnHost('ปิด tunnel'),
    pagesSetup: onlyOnHost('ตั้งลิงก์ถาวร'),
    tgGet: () => Promise.resolve(null),
    tgSet: onlyOnHost('ตั้งค่า Telegram'),
    tgDetect: onlyOnHost('หา chat id'),
    tgTest: onlyOnHost('ส่งทดสอบ Telegram'),
    onSnapshot: on('snapshot'),
    onOrderResult: on('order-result'),
    onAutoClose: on('auto-close'),
    onAutoEnter: on('auto-enter'),
    onTick: on('tick'),
  };
  connect();

  // ปุ่มออกจากระบบ (มุมล่างซ้าย — เฉพาะหน้าเว็บ)
  window.addEventListener('DOMContentLoaded', () => {
    // การ์ดตั้งค่าเฉพาะเครื่องหลัก (Telegram / แผงระยะไกล) ไม่แสดงบนเว็บ
    for (const id of ['tg-card', 'webctl-card']) { const el = document.getElementById(id); if (el) el.hidden = true; }
    const b = document.createElement('button');
    b.textContent = 'ออกจากระบบเว็บ';
    b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:99;padding:6px 12px;border-radius:8px;border:1px solid var(--line,#2a2f3a);background:var(--surface-2,#14171f);color:var(--muted,#9aa0ab);font-size:12px;cursor:pointer';
    b.onclick = async () => { try { await fetch('/api/logout', { method: 'POST' }); } catch { void 0; } toLogin(); };
    document.body.appendChild(b);
  });
})();

'use strict';

// ============================================================
// แจ้งเตือนผ่าน LINE Messaging API (push)
//   - token (Channel access token) + userId อยู่ไฟล์แยก line.json (สิทธิ์ 600) — ไม่อยู่ใน settings
//   - ใช้ประเภทเหตุการณ์ชุดเดียวกับ Telegram (EVENTS จาก telegram.js)
//   - คิวส่งทีละข้อความ ห่างกัน ≥1.4 วิ • ล้มเหลว 3 ครั้ง = ทิ้งข้อความนั้น
// ============================================================

const fs = require('fs');
const { EVENTS } = require('./telegram');

const API = 'https://api.line.me/v2/bot';
const USER_RE = /^U[0-9a-f]{32}$/i;
const GROUP_RE = /^C[0-9a-f]{32}$/i;
// token ของ LINE: สตริงยาว (~200+) ไม่ควรเดากวน — ตรวจหลวม: ยาว ≥ 40 ตัว ไม่มีช่องว่าง/ขึ้นบรรทัด
const TOKEN_RE = /^[A-Za-z0-9_\-+/=.:]{40,300}$/;

function createLine({ file, logger = () => {}, fetchImpl = (...a) => fetch(...a) } = {}) {
  let cfg = { enabled: false, token: '', userId: '', events: {} };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { void 0; }
  const save = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const on = (ev) => (cfg.events && ev in cfg.events ? cfg.events[ev] === true : !!(EVENTS[ev] && EVENTS[ev].def));
  const ready = () => cfg.enabled === true && TOKEN_RE.test(cfg.token || '') && (USER_RE.test(cfg.userId || '') || GROUP_RE.test(cfg.userId || ''));

  async function push(text, token = cfg.token) {
    let res;
    try {
      res = await fetchImpl(`${API}/message/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ to: cfg.userId, messages: [{ type: 'text', text: String(text).slice(0, 4800) }] }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new Error(`ติดต่อ LINE ไม่ได้ (${(e.cause && (e.cause.code || e.cause.message)) || e.message}) — ตรวจอินเทอร์เน็ต`);
    }
    if (!(res.status === 200 || res.status === 204)) {
      let j = null, msg = '';
      try { j = await res.json(); msg = (j && j.message) || ''; } catch { void 0; }
      const err = new Error(msg || `LINE ตอบ ${res.status}`);
      err.status = res.status;
      if (res.status === 401) err.hint = 'token ไม่ถูก/หมดอายุ — ได้จาก LINE Developers Console → Messaging API → Channel access token (long-lived)';
      if (res.status === 400) err.hint = 'userId ไม่ถูกต้อง — ต้องขึ้นต้น U + 32 ตัวอักษร (ได้จากเว็บหน้า developer เมื่อ follow OA หรือ webhook event)';
      throw err;
    }
    return true;
  }

  // ---------- คิวส่ง ----------
  const queue = [];
  let busy = false, failStreak = 0;
  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const item = queue[0];
      try {
        await push(item.text);
        queue.shift(); failStreak = 0;
        await new Promise((r) => setTimeout(r, 1400)); // LINE rate limit กันหลัง
      } catch (err) {
        item.tries = (item.tries || 0) + 1;
        if (item.tries >= 3) {
          queue.shift();
          failStreak++;
          if (failStreak === 1 || failStreak % 20 === 0) logger('line', `ส่ง LINE ไม่ได้: ${err.message}`, 'warn');
          if (err.hint && failStreak === 1) logger('line', err.hint, 'warn');
        } else await new Promise((r) => setTimeout(r, 3000 * item.tries));
      }
    }
    busy = false;
  }

  return {
    EVENTS,
    notify(ev, text) {
      if (!ready() || !on(ev)) return false;
      if (queue.length > 50) queue.splice(0, queue.length - 50);
      queue.push({ text: String(text) }); // LINE รอได้ถึง 5000 ตัว
      pump();
      return true;
    },
    view() {
      return {
        enabled: cfg.enabled === true, userId: cfg.userId || '',
        tokenSet: !!cfg.token, tokenHint: cfg.token ? cfg.token.slice(0, 6) + '•••' + cfg.token.slice(-4) : '',
        events: Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [k, { label: v.label, on: on(k) }])),
      };
    },
    set(p = {}) {
      if (typeof p.token === 'string' && p.token.trim()) {
        const t = p.token.trim();
        if (!TOKEN_RE.test(t)) throw new Error('token ไม่ถูกรูปแบบ — ต้องเป็น Channel access token (ยาวอย่างน้อย 40 ตัวอักษร)');
        cfg.token = t;
      }
      if (typeof p.userId === 'string') {
        const u = p.userId.trim();
        if (u && !(USER_RE.test(u) || GROUP_RE.test(u))) throw new Error('userId ต้องเป็น U… หรือ C… + ตัวเลข/ตัวอักษรรวม 33 ตัว (เช่น U1234567890abcdef1234567890abcdef)');
        cfg.userId = u;
      }
      if (typeof p.enabled === 'boolean') {
        if (p.enabled && !(TOKEN_RE.test(cfg.token || '') && cfg.userId)) throw new Error('ใส่ token และ userId ก่อนเปิดแจ้งเตือน');
        cfg.enabled = p.enabled;
      }
      if (p.events && typeof p.events === 'object') {
        cfg.events = { ...(cfg.events || {}) };
        for (const [k, v] of Object.entries(p.events)) if (k in EVENTS) cfg.events[k] = v === true;
      }
      save();
      return this.view();
    },
    async test() {
      if (!TOKEN_RE.test(cfg.token || '') || !(cfg.userId)) throw new Error('ใส่ token และ userId ก่อน');
      await push('✅ GoldSignal: ทดสอบแจ้งเตือน LINE สำเร็จ');
      return true;
    },
  };
}

module.exports = { createLine, TOKEN_RE };
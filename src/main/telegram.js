'use strict';

// ============================================================
// แจ้งเตือนผ่าน Telegram bot
//   - token/chat id เก็บแยกใน telegram.json (สิทธิ์ 600) — ไม่อยู่ใน settings จึงไม่หลุดไปหน้าเว็บ
//   - คิวส่งทีละข้อความ ห่างกัน ≥1.1 วิ • โดน 429 = รอตาม retry_after แล้วส่งต่อ • ล้มเหลว 3 ครั้ง = ทิ้งข้อความนั้น
//   - เปิด/ปิดแยกได้ทีละประเภทเหตุการณ์
// ============================================================

const fs = require('fs');

const EVENTS = {
  realOpen: { label: 'ไม้จริงเข้าแล้ว', def: true },
  realClose: { label: 'ไม้จริงปิด (TP / SL / ปิดเอง / ปิดอัตโนมัติ) + กำไร/ขาดทุน', def: true },
  autoTrade: { label: 'เข้าไม้อัตโนมัติ / ปิดรวบ / ตัดขาดทุน', def: true },
  orderFail: { label: 'คำสั่งล้มเหลว / ถูกด่านความเสี่ยงปฏิเสธ', def: true },
  pending: { label: 'คำสั่งรอ: วางแล้ว / ยกเลิก', def: true },
  signal: { label: 'สัญญาณผ่านทุกด่าน', def: true },
  virtual: { label: 'ไม้เสมือน เปิด/ปิด', def: false },
  system: { label: 'ระบบ: MT5 หลุด/กลับมา • tunnel ล่ม', def: true },
};
const API = 'https://api.telegram.org';
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;

function createTelegram({ file, logger = () => {}, fetchImpl = (...a) => fetch(...a) } = {}) {
  let cfg = { enabled: false, token: '', chatId: '', events: {} };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { void 0; }
  const save = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const on = (ev) => (cfg.events && ev in cfg.events ? cfg.events[ev] === true : !!(EVENTS[ev] && EVENTS[ev].def));
  const ready = () => cfg.enabled === true && TOKEN_RE.test(cfg.token || '') && String(cfg.chatId || '').length > 0;

  async function api(method, body, token = cfg.token) {
    let res;
    try {
      res = await fetchImpl(`${API}/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new Error(`ติดต่อ Telegram ไม่ได้ (${(e.cause && (e.cause.code || e.cause.message)) || e.message}) — ตรวจอินเทอร์เน็ต`);
    }
    let j = null;
    try { j = await res.json(); } catch { void 0; }
    if (!j || !j.ok) {
      const err = new Error((j && j.description) || `Telegram ตอบ ${res.status}`);
      err.retryAfter = j && j.parameters && j.parameters.retry_after;
      err.status = res.status;
      throw err;
    }
    return j.result;
  }

  // ---------- คิวส่ง ----------
  const queue = [];
  let detecting = false;
  let busy = false, failStreak = 0;
  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const item = queue[0];
      try {
        await api('sendMessage', { chat_id: cfg.chatId, text: item.text, disable_web_page_preview: true });
        queue.shift(); failStreak = 0;
        await new Promise((r) => setTimeout(r, 1100));
      } catch (err) {
        if (err.retryAfter) { await new Promise((r) => setTimeout(r, (err.retryAfter + 1) * 1000)); continue; }
        item.tries = (item.tries || 0) + 1;
        if (item.tries >= 3) {
          queue.shift();
          failStreak++;
          if (failStreak === 1 || failStreak % 20 === 0) logger('telegram', `ส่ง Telegram ไม่ได้: ${err.message}`, 'warn');
        } else await new Promise((r) => setTimeout(r, 3000 * item.tries));
      }
    }
    busy = false;
  }

  return {
    EVENTS,
    // ส่งตามประเภทเหตุการณ์ (ปิดอยู่/ยังตั้งไม่ครบ = เงียบ)
    notify(ev, text) {
      if (!ready() || !on(ev)) return false;
      if (queue.length > 50) queue.splice(0, queue.length - 50); // ค้างนาน (เน็ตหลุด) = เก็บแค่ 50 ข้อความล่าสุด
      queue.push({ text: String(text).slice(0, 3900) });
      pump();
      return true;
    },
    // สำหรับหน้าตั้งค่า: token ไม่ส่งกลับเต็ม
    view() {
      return {
        enabled: cfg.enabled === true, chatId: cfg.chatId || '',
        tokenSet: !!cfg.token, tokenHint: cfg.token ? cfg.token.split(':')[0] + ':•••' + cfg.token.slice(-4) : '',
        events: Object.fromEntries(Object.entries(EVENTS).map(([k, v]) => [k, { label: v.label, on: on(k) }])),
      };
    },
    set(p = {}) {
      if (typeof p.token === 'string' && p.token.trim()) {
        const t = p.token.trim();
        if (!TOKEN_RE.test(t)) throw new Error('token ไม่ถูกรูปแบบ (ได้จาก @BotFather เช่น 123456789:AA...)');
        cfg.token = t;
      }
      if (typeof p.chatId === 'string' || typeof p.chatId === 'number') {
        const c = String(p.chatId).trim();
        if (c && !/^-?\d{3,20}$|^@[A-Za-z0-9_]{5,}$/.test(c)) throw new Error('chat id ต้องเป็นตัวเลข (หรือ @ชื่อช่อง)');
        cfg.chatId = c;
      }
      if (typeof p.enabled === 'boolean') {
        if (p.enabled && !(TOKEN_RE.test(cfg.token || '') && cfg.chatId)) throw new Error('ใส่ token และ chat id ก่อนเปิดแจ้งเตือน');
        cfg.enabled = p.enabled;
      }
      if (p.events && typeof p.events === 'object') {
        cfg.events = { ...(cfg.events || {}) };
        for (const [k, v] of Object.entries(p.events)) if (k in EVENTS) cfg.events[k] = v === true;
      }
      save();
      return this.view();
    },
    // หา chat id: ผู้ใช้ส่งข้อความหา bot ก่อน แล้วอ่านจาก getUpdates
    async detectChat(token) {
      const t = (token && token.trim()) || cfg.token;
      if (!TOKEN_RE.test(t || '')) throw new Error('ใส่ token ให้ถูกก่อน');
      if (detecting) throw new Error('กำลังหา chat id อยู่ — รอสักครู่');
      detecting = true;
      let me, ups;
      try {
        me = await api('getMe', {}, t);
        // 409 Conflict = มี getUpdates อื่นของ token นี้ค้างอยู่ (กดซ้ำ/โปรแกรมอื่น) → รอแล้วลองใหม่ 3 ครั้ง
        for (let i = 0; ; i++) {
          try { ups = await api('getUpdates', { limit: 50, timeout: 0 }, t); break; }
          catch (err) {
            if (!/Conflict/i.test(err.message) || i >= 3) {
              if (/Conflict/i.test(err.message)) throw new Error('มีโปรแกรมอื่นใช้ bot token นี้ดึงข้อความอยู่ (409) — ปิดโปรแกรม/บอทตัวอื่นที่ใช้ token นี้ หรือสร้าง bot ใหม่ แล้วลองอีกครั้ง');
              if (/webhook/i.test(err.message)) throw new Error('bot นี้ตั้ง webhook ไว้ — ใส่ chat id เอง หรือลบ webhook ก่อน');
              throw err;
            }
            await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
          }
        }
      } finally { detecting = false; }
      const chats = [];
      for (const u of ups.reverse()) {
        const m = u.message || u.channel_post || u.my_chat_member;
        const c = m && m.chat;
        if (c && !chats.some((x) => x.id === c.id)) chats.push({ id: String(c.id), name: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || String(c.id), type: c.type });
      }
      return { bot: me.username, chats };
    },
    async test() {
      if (!TOKEN_RE.test(cfg.token || '') || !cfg.chatId) throw new Error('ใส่ token และ chat id ก่อน');
      await api('sendMessage', { chat_id: cfg.chatId, text: '✅ GoldSignal: ทดสอบแจ้งเตือน Telegram สำเร็จ', disable_web_page_preview: true });
      return true;
    },
  };
}

module.exports = { createTelegram, EVENTS, TOKEN_RE };

'use strict';

// ============================================================
// สิทธิ์เข้าเว็บควบคุมเต็ม (กดซื้อ/ขาย/ปิดไม้จริงได้)
//   - รหัสผ่านเก็บเป็น scrypt hash + salt (ไม่เก็บตัวรหัส) ในไฟล์ web-auth.json แยกจาก settings
//     (หน้าเว็บแก้ไฟล์นี้ไม่ได้ — ตั้ง/เปลี่ยนรหัส/เปิดรับเครื่องอื่น ทำได้จากแอปบนเครื่องเท่านั้น)
//   - session = token สุ่ม 32 ไบต์ อายุ 7 วัน เก็บในหน่วยความจำ (ปิดแอป = ต้องล็อกอินใหม่)
//   - ใส่รหัสผิด 5 ครั้งใน 15 นาที ต่อ IP = ล็อก 15 นาที
// ============================================================

const crypto = require('crypto');
const fs = require('fs');

const SESSION_TTL_MS = 7 * 24 * 3600_000;
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_MAX = 5;
const MIN_PASSWORD = 8;

function createWebAuth(file) {
  let data = { hash: null, salt: null, remote: false, opts: {} };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { void 0; }
  const sessions = new Map(); // token → { exp, ip }
  const fails = new Map();    // ip → [ts...]

  const save = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const hashOf = (pw, salt) => crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32).toString('hex');

  return {
    MIN_PASSWORD,
    hasPassword: () => !!(data.hash && data.salt),
    isRemote: () => data.remote === true && !!data.hash,
    setPassword(pw) {
      if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw new Error(`รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัวอักษร`);
      data.salt = crypto.randomBytes(16).toString('hex');
      data.hash = hashOf(pw, data.salt);
      sessions.clear(); // เปลี่ยนรหัส = เตะทุกเครื่องออก
      save();
    },
    setRemote(on) { data.remote = on === true; save(); },
    // ค่าตั้ง tunnel / GitHub Pages — อยู่ไฟล์นี้เพื่อให้หน้าเว็บแก้ไม่ได้
    opts: () => ({ ...(data.opts || {}) }),
    setOpts(partial) { data.opts = { ...(data.opts || {}), ...partial }; save(); },
    // ตรวจรหัส: คืน { ok, token } หรือ { ok:false, reason, locked }
    login(pw, ip) {
      const now = Date.now();
      const list = (fails.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
      if (list.length >= FAIL_MAX) return { ok: false, locked: true, reason: 'ใส่รหัสผิดหลายครั้ง — รอ 15 นาทีแล้วลองใหม่' };
      if (!data.hash) return { ok: false, reason: 'ยังไม่ได้ตั้งรหัสผ่าน — ตั้งในแอปบนเครื่องก่อน (แท็บ MT5 → เว็บควบคุมเต็ม)' };
      const a = Buffer.from(hashOf(pw, data.salt), 'hex'), b = Buffer.from(data.hash, 'hex');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        list.push(now); fails.set(ip, list);
        return { ok: false, reason: `รหัสไม่ถูกต้อง (เหลือ ${FAIL_MAX - list.length} ครั้ง)` };
      }
      fails.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, { exp: now + SESSION_TTL_MS, ip });
      return { ok: true, token };
    },
    check(token) {
      if (!token || typeof token !== 'string') return false;
      const s = sessions.get(token);
      if (!s) return false;
      if (Date.now() > s.exp) { sessions.delete(token); return false; }
      return true;
    },
    logout(token) { sessions.delete(token); },
    logoutAll() { sessions.clear(); },
    sessionCount() { const now = Date.now(); for (const [k, s] of sessions) if (now > s.exp) sessions.delete(k); return sessions.size; },
  };
}

module.exports = { createWebAuth, MIN_PASSWORD };

'use strict';

// ============================================================
// สิทธิ์เข้าเว็บควบคุมเต็ม (กดซื้อ/ขาย/ปิดไม้จริงได้)
//   - รหัสผ่านเก็บเป็น scrypt hash + salt (ไม่เก็บตัวรหัส) ในไฟล์ web-auth.json แยกจาก settings
//     (หน้าเว็บแก้ไฟล์นี้ไม่ได้ — ตั้ง/เปลี่ยนรหัส/เปิดรับเครื่องอื่น ทำได้จากแอปบนเครื่องเท่านั้น)
//   - session = token สุ่ม 32 ไบต์ อายุ 7 วัน เก็บในหน่วยความจำ (ปิดแอป = ต้องล็อกอินใหม่)
//   - ใส่รหัสผิด 5 ครั้งใน 15 นาที ต่อ IP = ล็อก 15 นาที
//   - ผิดรวมทุก IP เกิน 30 ครั้งใน 10 นาที = พักรับล็อกอินจากเครื่องอื่น 60 วิ (กันสลับ IP ไล่เดารหัส)
//   - ตรวจรหัสด้วย scrypt แบบ async (ไม่บล็อกวงหลักของแอป) + จำกัดงานตรวจพร้อมกัน
// ============================================================

const crypto = require('crypto');
const fs = require('fs');

const SESSION_TTL_MS = 7 * 24 * 3600_000;
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_MAX = 5;
const MIN_PASSWORD = 8;
const FAIL_IPS_MAX = 500;            // จำนวน IP ที่จำไว้สูงสุด (เกิน = ทิ้งตัวที่ไม่ได้แตะนานสุด)
const GLOBAL_WINDOW_MS = 10 * 60_000;
const GLOBAL_FAIL_MAX = 30;
const GLOBAL_LOCK_MS = 60_000;
const VERIFY_MAX_INFLIGHT = 4;       // = ขนาด threadpool ปกติของ libuv

function createWebAuth(file) {
  let data = { hash: null, salt: null, remote: false, opts: {} };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { void 0; }
  const sessions = new Map(); // token → { exp, ip }
  const fails = new Map();    // ip → [ts...] (เรียงตามการแตะล่าสุด — ตัวแรก = เก่าสุด)
  let globalFails = [];       // เวลาที่ใส่รหัสผิดจากเครื่องอื่น รวมทุก IP
  let globalLockUntil = 0;
  let verifying = 0;

  const save = () => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const hashOf = (pw, salt) => crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32).toString('hex');
  const hashOfAsync = (pw, salt) => new Promise((resolve, reject) => {
    crypto.scrypt(String(pw), Buffer.from(salt, 'hex'), 32, (err, key) => (err ? reject(err) : resolve(key)));
  });
  const noteFail = (ip, list, now, local) => {
    list.push(now);
    fails.delete(ip); fails.set(ip, list);
    while (fails.size > FAIL_IPS_MAX) fails.delete(fails.keys().next().value);
    if (local) return;
    globalFails = globalFails.filter((t) => now - t < GLOBAL_WINDOW_MS);
    globalFails.push(now);
    if (globalFails.length > GLOBAL_FAIL_MAX) globalLockUntil = now + GLOBAL_LOCK_MS;
  };

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
    setRemote(on) {
      data.remote = on === true;
      if (!data.remote) sessions.clear(); // ปิดรับเครื่องอื่น = เตะทุกเครื่องออก (session เดิมใช้ต่อไม่ได้เมื่อเปิดใหม่)
      save();
    },
    // ค่าตั้ง tunnel / GitHub Pages — อยู่ไฟล์นี้เพื่อให้หน้าเว็บแก้ไม่ได้
    opts: () => ({ ...(data.opts || {}) }),
    setOpts(partial) { data.opts = { ...(data.opts || {}), ...partial }; save(); },
    // ตรวจรหัส (async): คืน { ok, token } หรือ { ok:false, reason, locked }
    // opts.local = คำขอจากเครื่องนี้จริง (loopback ไม่ผ่าน tunnel) → ไม่โดนตัวจำกัดรวมทุก IP (ยังนับต่อ IP ตามเดิม)
    async login(pw, ip, opts = null) {
      const local = !!(opts && opts.local);
      const now = Date.now();
      const list = (fails.get(ip) || []).filter((t) => now - t < FAIL_WINDOW_MS);
      if (list.length >= FAIL_MAX) return { ok: false, locked: true, reason: 'ใส่รหัสผิดหลายครั้ง — รอ 15 นาทีแล้วลองใหม่' };
      if (!local && now < globalLockUntil) return { ok: false, locked: true, reason: 'มีการใส่รหัสผิดจำนวนมาก — พักรับล็อกอิน 1 นาที แล้วลองใหม่' };
      if (!data.hash) return { ok: false, reason: 'ยังไม่ได้ตั้งรหัสผ่าน — ตั้งในแอปบนเครื่องก่อน (แท็บ MT5 → เว็บควบคุมเต็ม)' };
      if (verifying >= VERIFY_MAX_INFLIGHT) return { ok: false, locked: true, reason: 'มีคำขอล็อกอินเข้ามามาก — รอสักครู่แล้วลองใหม่' };
      const salt = data.salt, want = data.hash;
      let a;
      verifying++;
      try { a = await hashOfAsync(pw, salt); } finally { verifying--; }
      const b = Buffer.from(want, 'hex');
      // รหัสถูกเปลี่ยนระหว่างรอตรวจ = ถือว่าไม่ผ่าน (ไม่ออก session ให้รหัสเก่า)
      if (want !== data.hash || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        // นับจากรายการล่าสุด (มีคำขอจาก IP เดียวกันตรวจพร้อมกันได้)
        const t = Date.now();
        const cur = (fails.get(ip) || []).filter((x) => t - x < FAIL_WINDOW_MS);
        noteFail(ip, cur, t, local);
        return { ok: false, reason: `รหัสไม่ถูกต้อง (เหลือ ${Math.max(0, FAIL_MAX - cur.length)} ครั้ง)` };
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
    clearSessions() { sessions.clear(); },
    failIpCount: () => fails.size,
    sessionCount() { const now = Date.now(); for (const [k, s] of sessions) if (now > s.exp) sessions.delete(k); return sessions.size; },
  };
}

module.exports = { createWebAuth, MIN_PASSWORD };

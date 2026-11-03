'use strict';

// ============================================================
// เว็บ GoldSignal — ใช้งานได้เหมือนแอปทุกอย่างผ่านเบราว์เซอร์ (เมื่อส่ง handlers + auth มา)
//   - ทุกหน้า/ทุก API ต้องล็อกอินด้วยรหัสผ่าน (ตั้งในแอปบนเครื่องเท่านั้น)
//   - ปิด "รับเครื่องอื่น" = ฟังเฉพาะ 127.0.0.1 • เปิด = ฟัง 0.0.0.0 (ใช้ผ่าน Tailscale/Cloudflare Tunnel)
//   - เรียกคำสั่งชุดเดียวกับแอป (POST /api/call/<channel>) • ข้อมูลสดผ่าน SSE (/api/events)
//   - คำสั่งที่เปิดหน้าต่าง/ไฟล์บนเครื่อง และคำสั่งจัดการรหัสเว็บ = ห้ามเรียกจากเว็บ
//   - /api/snapshot.json แบบไม่ล็อกอิน เปิดให้เฉพาะเครื่องนี้ (loopback) เหมือนเดิม (ดูอย่างเดียว)
//   - ผ่าน tunnel (cloudflared/ngrok/Tailscale Funnel) คำขอมาจาก 127.0.0.1 แต่มี header ส่งต่อ → นับเป็นเครื่องอื่นเสมอ
//   - port 8008 (+ ไล่ไปจนถึง 8019 ถ้าชน)
// ============================================================

const http = require('http');
const path = require('path');
const fs = require('fs');

const BASE_PORT = 8008;
const MAX_TRIES = 12;
const MAX_BODY = 256 * 1024;
const COOKIE = 'gs_sess';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const SEC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
const FWD_HEADERS = ['x-forwarded-for', 'cf-connecting-ip', 'forwarded', 'x-real-ip', 'tailscale-funnel-request', 'ngrok-trace-id'];
// "เครื่องนี้จริง" = มาจาก loopback + ไม่มี header ส่งต่อจาก tunnel + Host เป็น localhost
function whoIs(req) {
  const sock = req.socket.remoteAddress || '';
  const forwarded = FWD_HEADERS.some((h) => req.headers[h] != null);
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  const local = isLoopback(sock) && !forwarded && (host === 'localhost' || host === '127.0.0.1' || host === '[::1]');
  const fwdIp = String(req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim();
  const ip = isLoopback(sock) && fwdIp ? fwdIp : sock;
  const https = String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
  return { local, ip: ip.slice(0, 64), https };
}
const cookieOf = (req, name) => {
  const m = String(req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
};
const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body ใหญ่เกิน')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

function startWebServer({ port = BASE_PORT, getSnapshot, logger = () => {}, handlers = null, auth = null, rendererDir = null, blocked = new Set() } = {}) {
  const full = !!(handlers && auth && rendererDir);
  const clients = new Set(); // SSE
  const send = (res, code, body, type = TYPES['.json'], extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, ...SEC_HEADERS, ...extra });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    try {
      const { local, ip, https } = whoIs(req);
      // อ่าน body ก่อนตอบเสมอ (ตอบก่อนอ่านจบ = เบราว์เซอร์บางตัวโดน connection reset)
      const body = req.method === 'POST' ? await readBody(req) : '';
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      // เปิดรับเครื่องอื่นไว้ แต่ผู้ใช้ปิดสวิตช์ภายหลัง → ปฏิเสธจนกว่าจะ rebind
      if (!local && !(full && auth.isRemote())) return send(res, 403, 'ปิดการเข้าจากเครื่องอื่นอยู่', 'text/plain; charset=utf-8');

      if (p === '/api/snapshot.json' && local) {
        const snap = typeof getSnapshot === 'function' ? getSnapshot() : null;
        return send(res, 200, snap ? { ok: true, ...snap } : { ok: false, msg: 'ยังไม่มีข้อมูล — รอรอบวิเคราะห์แรก' });
      }
      if (!full) return send(res, 404, 'not found', 'text/plain');

      // ---------- ล็อกอิน ----------
      if (p === '/login' && req.method === 'GET') return send(res, 200, loginHtml(auth.hasPassword()), TYPES['.html']);
      if (p === '/api/login' && req.method === 'POST') {
        let pw = '';
        try { pw = String(JSON.parse(body).password || ''); } catch { return send(res, 400, { ok: false, reason: 'ข้อมูลไม่ถูกต้อง' }); }
        const r = auth.login(pw, ip);
        if (!r.ok) { logger('web', `ล็อกอินเว็บไม่สำเร็จจาก ${ip}: ${r.reason}`, 'warn'); return send(res, r.locked ? 429 : 401, { ok: false, reason: r.reason }); }
        logger('web', `ล็อกอินเว็บสำเร็จจาก ${ip}`);
        return send(res, 200, { ok: true }, TYPES['.json'], { 'Set-Cookie': `${COOKIE}=${r.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}${https ? '; Secure' : ''}` });
      }
      const token = cookieOf(req, COOKIE);
      const authed = auth.check(token);
      if (p === '/api/logout' && req.method === 'POST') {
        auth.logout(token);
        return send(res, 200, { ok: true }, TYPES['.json'], { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      }
      if (!authed) {
        if (p.startsWith('/api/')) return send(res, 401, { ok: false, reason: 'ต้องล็อกอิน' });
        res.writeHead(302, { Location: '/login', ...SEC_HEADERS }); return res.end();
      }

      // ---------- ข้อมูลสด (SSE) ----------
      if (p === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', ...SEC_HEADERS });
        res.write('retry: 3000\n\n');
        const c = { res, token };
        clients.add(c);
        const snap = typeof getSnapshot === 'function' ? getSnapshot() : null;
        if (snap) res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { void 0; } }, 20_000);
        req.on('close', () => { clearInterval(ping); clients.delete(c); });
        return;
      }
      // ---------- เรียกคำสั่งชุดเดียวกับแอป ----------
      if (p.startsWith('/api/call/') && req.method === 'POST') {
        // กัน CSRF: ต้องมี header เฉพาะ (ฟอร์มข้ามเว็บใส่ไม่ได้) + cookie SameSite=Strict
        if (req.headers['x-gs-web'] !== '1') return send(res, 403, { ok: false, reason: 'ต้องเรียกจากหน้าเว็บ GoldSignal' });
        const ch = decodeURIComponent(p.slice('/api/call/'.length));
        const fn = handlers.get(ch);
        if (!fn || blocked.has(ch)) return send(res, 404, { ok: false, reason: `คำสั่ง ${ch} ใช้จากเว็บไม่ได้` });
        let args = [];
        try { const j = JSON.parse(body || '{}'); args = Array.isArray(j.args) ? j.args : []; } catch { return send(res, 400, { ok: false, reason: 'ข้อมูลไม่ถูกต้อง' }); }
        if (['send-order', 'send-pending', 'close-position', 'close-all', 'modify-position', 'modify-pending', 'cancel-pending'].includes(ch)) logger('web', `คำสั่ง ${ch} จากเว็บ (${local ? 'เครื่องนี้' : ip})`);
        const result = await fn({ sender: null, web: true }, ...args);
        return send(res, 200, { ok: true, result: result === undefined ? null : result });
      }
      // ---------- ไฟล์หน้าแอป (เฉพาะในโฟลเดอร์ renderer) ----------
      if (req.method === 'GET') {
        const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
        const abs = path.resolve(rendererDir, rel);
        if (!abs.startsWith(path.resolve(rendererDir) + path.sep) || !TYPES[path.extname(abs)] || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, 'not found', 'text/plain');
        let body = fs.readFileSync(abs);
        if (rel === 'index.html' || rel === 'history.html') {
          // หน้าเว็บ: ตัวแทน window.api ก่อนสคริปต์แอป + viewport จริงตามเครื่อง (มือถือเลย์เอาต์มือถือ ไม่หย่อนทั้งหน้า)
          body = body.toString('utf8')
            .replace('<head>', '<head>\n  <meta name="viewport" content="width=device-width, initial-scale=1" />')
            .replace(/<script src="(app|history)\.js"><\/script>/, '<script src="web-api.js"></script>\n  $&');
        }
        return send(res, 200, body, TYPES[path.extname(abs)]);
      }
      return send(res, 404, 'not found', 'text/plain');
    } catch (err) {
      try { send(res, 500, { ok: false, reason: err.message }); } catch { void 0; }
      logger('web', `เว็บล้ม: ${err.message}`, 'warn');
    }
  });

  let actualPort = port;
  let host = full && auth.isRemote() ? '0.0.0.0' : '127.0.0.1';
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  const describe = () => (host === '0.0.0.0' ? 'ควบคุมเต็ม • รับเครื่องอื่น' : full ? 'ควบคุมเต็ม • เฉพาะเครื่องนี้' : 'ดูเท่านั้น • เฉพาะเครื่องนี้');
  let started = false;
  function listen() {
    server.listen(actualPort, host, () => {
      if (started) return;
      started = true;
      const url = `http://localhost:${actualPort}`;
      logger('web', `เว็บ GoldSignal (${describe()}) เปิดที่: ${url}`);
      resolve({ server, url, port: actualPort, broadcast, setRemote });
    });
  }
  // พอร์ตชน (ตอนเริ่ม) = ไล่พอร์ตถัดไป • หลังเริ่มแล้วผิดพลาด = แค่บันทึก
  server.on('error', (err) => {
    if (started) { logger('web', `เว็บผิดพลาด: ${err.message}`, 'warn'); return; }
    if (actualPort < BASE_PORT + MAX_TRIES) { actualPort += 1; listen(); }
    else { logger('web', 'เปิดเว็บไม่ได้ (พอร์ตเต็ม 8008-8019) — แอปเดิมทำงานปกติต่อ', 'warn'); resolve(null); }
  });
  // ส่งเหตุการณ์ชุดเดียวกับที่ส่งหน้าต่างแอป ให้ทุกเบราว์เซอร์ที่ล็อกอินอยู่
  function broadcast(channel, payload) {
    if (!clients.size) return;
    const msg = `event: ${channel}\ndata: ${JSON.stringify(payload === undefined ? null : payload)}\n\n`;
    for (const c of clients) {
      if (!auth.check(c.token)) { try { c.res.end(); } catch { void 0; } clients.delete(c); continue; }
      try { c.res.write(msg); } catch { clients.delete(c); }
    }
  }
  // เปิด/ปิดรับเครื่องอื่น: ฟังใหม่ที่พอร์ตเดิม (0.0.0.0 ↔ 127.0.0.1)
  function setRemote(on) {
    const want = on ? '0.0.0.0' : '127.0.0.1';
    if (want === host) return Promise.resolve();
    host = want;
    for (const c of clients) { try { c.res.end(); } catch { void 0; } }
    clients.clear();
    return new Promise((r) => server.close(() => { server.listen(actualPort, host, () => { logger('web', `เว็บ GoldSignal เปลี่ยนเป็น: ${describe()}`); r(); }); }));
  }
  listen();
  return promise;
}

function loginHtml(hasPassword) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GoldSignal — เข้าสู่ระบบ</title>
<style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#07080b;color:#f2f0ea;font-family:-apple-system,"Sukhumvit Set","Noto Sans Thai",sans-serif}
.box{width:min(360px,calc(100vw - 32px));background:#14171f;border:1px solid #2a2f3a;border-radius:14px;padding:24px}
h1{font-size:19px;margin:0 0 4px;color:#e8c46a}p{color:#9aa0ab;font-size:13px;margin:0 0 16px}
input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:9px;border:1px solid #2a2f3a;background:#0d0f14;color:#f2f0ea;font-size:15px}
input:focus{outline:none;border-color:#e8c46a}button{margin-top:12px;width:100%;padding:11px;border:0;border-radius:9px;background:#e8c46a;color:#1a1406;font-weight:700;font-size:15px;cursor:pointer}
.err{color:#ff8896;font-size:13px;min-height:18px;margin-top:10px}
</style></head><body><form class="box" id="f">
<h1>GoldSignal</h1><p>${hasPassword ? 'ใส่รหัสผ่านเว็บที่ตั้งไว้ในแอป' : 'ยังไม่ได้ตั้งรหัสผ่าน — เปิดแอปบนเครื่อง → แท็บ MT5 → เว็บควบคุมเต็ม → ตั้งรหัส'}</p>
<input type="password" id="pw" autocomplete="current-password" placeholder="รหัสผ่าน" autofocus>
<button type="submit">เข้าสู่ระบบ</button><div class="err" id="e"></div></form>
<script>
document.getElementById('f').addEventListener('submit',async(ev)=>{ev.preventDefault();const e=document.getElementById('e');e.textContent='';
try{const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
const j=await r.json();if(j.ok)location.href='/';else e.textContent=j.reason||'เข้าไม่ได้';}catch(x){e.textContent='เชื่อมต่อไม่ได้: '+x.message;}});
</script></body></html>`;
}

module.exports = { startWebServer, BASE_PORT };

// ---------- เลน push ขึ้นเซิร์ฟเวอร์ระยะไกล (แบบ A): ส่ง snapshot ทุก 5 วิ เมื่อตั้ง URL+token ----------
function startRemotePush({ getUrl, getToken, getSnapshot, logger = () => {}, intervalMs = 5000 } = {}) {
  let failStreak = 0, okStreak = 0;
  const tick = async () => {
    const urlStr = (getUrl() || '').trim();
    const token = (getToken() || '').trim();
    const snap = await Promise.resolve(getSnapshot ? getSnapshot() : null);
    if (!urlStr || !token || !snap) return;
    try {
      const base = urlStr.replace(/\/+$/, '');
      const pushUrl = /\/push$/.test(base) ? base : base + '/push';
      const res = await fetch(pushUrl, {
        method: 'POST',
        headers: { 'x-gs-token': token, 'content-type': 'application/json' },
        body: JSON.stringify(snap),
      });
      if (!res.ok) throw new Error('ตอบ ' + res.status);
      okStreak++; failStreak = 0;
      if (okStreak === 10) logger('push', `ส่งขึ้นเว็บระยะไกลปกติ (ทุก ${Math.round(intervalMs / 1000)} วิ)`);
    } catch (err) {
      failStreak++;
      if (failStreak === 1 || failStreak % 60 === 0) logger('push', `push ขึ้นเว็บระยะไกลไม่ได้ (${err.message}) — ตรวจ URL/รหัส หรือเซิร์ฟเวอร์ตอบ`, 'warn');
    }
  };
  const timer = setInterval(tick, intervalMs);
  return { stop: () => clearInterval(timer) };
}

module.exports.startRemotePush = startRemotePush;
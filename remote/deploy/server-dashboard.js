'use strict';

// ============================================================
// GoldSignal Remote Dashboard — ฝั่ง SERVER (อิสระ 0 dependency)
//   - รับ push จากเครื่อง Mac (แอป GoldSignal) — ต้องแนบ header x-gs-token
//   - เปิดดูจากทุกที่: / เรียกด้วย ?key=TOKEN (หรือ cookie จากครั้งแรก)
//   - ไม่มี endpoint ส่งคำสั่ง — โหมดดูเท่านั้นเช่นเดิม
// ใช้: GS_TOKEN=<รหัสลับ> GS_PORT=7779 node server-dashboard.js
//      (require เพื่อทดสอบ = เรียก createRemoteServer({ port: 0, token }))
// ============================================================

const http = require('http');
const path = require('path');
const fs = require('fs');

let dashCache = null;
function dashHtml(file) {
  if (!dashCache) dashCache = fs.readFileSync(file, 'utf8');
  return dashCache;
}

function tokenOk(req, token, url) {
  const q = url.searchParams.get('key');
  if (q && q === token) return true;
  const m = /(?:^|;\s*)gskey=([^\s;]+)/.exec(req.headers.cookie || '');
  return !!(m && m[1] === token);
}

function createRemoteServer({ port = 7779, token, dashFile = path.join(__dirname, 'remote-dashboard.html') } = {}) {
  if (!token || typeof token !== 'string') throw new Error('ต้องมี token (รหัสลับ)');
  let snap = null, snapAt = 0, pushes = 0;
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname === '/push' && (req.method === 'POST' || req.method === 'PUT')) {
        if (req.headers['x-gs-token'] !== token) { res.writeHead(401).end('bad token'); return; }
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 12_000_000) req.destroy(); });
        req.on('end', () => {
          try { snap = JSON.parse(body); snapAt = Date.now(); pushes++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); }
          catch { res.writeHead(400).end('bad json'); }
        });
        return;
      }
      if (url.pathname === '/api/snapshot.json' || url.pathname === '/snapshot.json') {
        if (!tokenOk(req, token, url)) { res.writeHead(401); res.end('ใส่ ?key=TOKEN ท้าย URL'); return; }
        const out = snap ? { ...snap, serverAgeSec: Math.round((Date.now() - snapAt) / 1000) } : { ok: false, msg: 'ยังไม่มี push จากเครื่อง Mac' };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(out));
        return;
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        if (!tokenOk(req, token, url)) {
          res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('ป้องกันไว้: ใส่ ?key=TOKEN ท้ายลิงก์ (ตัวอย่าง: http://<host>:' + port + '/?key=รหัสของคุณ)');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': `gskey=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000` });
        res.end(dashHtml(dashFile));
        return;
      }
      if (url.pathname === '/api/push-stats.json') {
        if (!tokenOk(req, token, url)) { res.writeHead(401).end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pushes, snapAt, has: !!snap }));
        return;
      }
      res.writeHead(404).end('not found');
    } catch (err) {
      try { res.writeHead(500).end('error'); } catch { void 0; }
    }
  });
  return { server, stats: () => ({ pushes, snapAt, has: !!snap }), start: () => new Promise((r) => server.listen(port, '0.0.0.0', () => r({ port: server.address().port || port }))) };
}

if (require.main === module) {
  const PORT = Number(process.env.GS_PORT) || 7779;
  const TOKEN = String(process.env.GS_TOKEN || '');
  if (!TOKEN) { console.error('ตั้ง GS_TOKEN ก่อน: GS_TOKEN=รหัสลับ node server-dashboard.js'); process.exit(1); }
  const { server } = createRemoteServer({ port: PORT, token: TOKEN });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`GoldSignal remote dashboard ทำงานที่ 0.0.0.0:${PORT}`);
    console.log(`  ดูเว็บ:     http://<IP-เซิร์ฟเวอร์>:${PORT}/?key=${TOKEN.slice(0, 4)}***`);
    console.log(`  ฝั่งแอป push: http://<IP-เซิร์ฟเวอร์>:${PORT}/push`);
  });
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

module.exports = { createRemoteServer };
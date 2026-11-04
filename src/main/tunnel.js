'use strict';

// ============================================================
// Tunnel เปิดแผงเว็บ (port 8008) ออกอินเทอร์เน็ตแบบ https
//   cloudflared : quick tunnel → https://xxxx.trycloudflare.com (เปลี่ยนทุกครั้งที่เริ่มใหม่)
//   ngrok       : https://xxxx.ngrok-free.app (ต้องตั้ง authtoken ใน ngrok ก่อน)
//   tailscale   : Funnel → https://<เครื่อง>.<tailnet>.ts.net (ถาวร ต้องเปิด Funnel ใน tailnet)
// แอปจาก Finder ไม่มี PATH ของ Homebrew → หาโปรแกรมจากพาธมาตรฐานเอง
// ============================================================

const fs = require('fs');
const { spawn, execFile } = require('child_process');

const BIN = {
  cloudflared: ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'],
  ngrok: ['/opt/homebrew/bin/ngrok', '/usr/local/bin/ngrok'],
  tailscale: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'],
};
const findBin = (name) => (BIN[name] || []).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
const run = (bin, args, timeout = 20_000) => new Promise((resolve) => {
  execFile(bin, args, { timeout }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || ''), err: String(stderr || '') }));
});

function createTunnel({ logger = () => {}, onUrl = () => {}, stateFile = null } = {}) {
  let child = null, provider = null, port = null, url = null, state = 'off', msg = '', stopping = false, retry = 0, retryTimer = null, adopted = false;
  // สถานะ daemon ลงไฟล์: pid + url ล่าสุด — แอปปิด/อัปเดตใหม่ = adopt ลิงก์เดิมกลับมา (1033 หาย)
  const saveState = () => {
    if (!stateFile || !url || !provider || !child?.pid) return;
    try { fs.writeFileSync(stateFile, JSON.stringify({ provider, pid: child.pid, url, port, ts: Date.now() })); } catch { void 0; }
  };
  const clearState = () => { if (stateFile) try { fs.unlinkSync(stateFile); } catch { void 0; } };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const setUrl = (u) => {
    if (u && u !== url) {
      url = u; state = 'on'; msg = ''; retry = 0;
      logger('tunnel', `เปิด tunnel ${provider} แล้ว: ${u}${adopted ? ' (นำกลับใช้จากรอบก่อนได้)' : ''}`);
      if (child?.pid) saveState();
      onUrl(u, provider);
    }
  };
  const fail = (m) => { state = 'error'; msg = m; logger('tunnel', `tunnel ${provider}: ${m}`, 'warn'); };

  function spawnWatch(bin, args, parse) {
    child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const pid = () => (child && child.pid) || 0;
    const feed = (buf) => {
      for (const line of String(buf).split('\n')) {
        const u = parse(line);
        if (u) { setUrl(u); if (pid()) saveState(); }
        else if (/ERR|error|failed|authtoken/i.test(line) && state !== 'on') msg = line.trim().slice(0, 200);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('exit', (code) => {
      child = null;
      clearState();
      if (stopping) return;
      url = null;
      // หลุด = เริ่มใหม่เอง (หน่วง 5 → 60 วิ) — cloudflared ได้ URL ใหม่ → onUrl อัปเดตลิงก์ถาวรให้
      retry++;
      const wait = Math.min(60, 5 * retry);
      fail(`โปรแกรมปิดไป (code ${code})${msg ? ' — ' + msg : ''} • ลองใหม่ใน ${wait} วิ`);
      retryTimer = setTimeout(() => { if (!stopping) startInner(); }, wait * 1000);
    });
  }

  async function startInner() {
    state = 'starting'; msg = '';
    const bin = findBin(provider);
    if (!bin) return fail(`ไม่พบโปรแกรม ${provider} (ติดตั้งด้วย brew install ${provider === 'tailscale' ? '--cask tailscale' : provider})`);
    if (provider === 'cloudflared') {
      // --protocol http2: เอา HTTP/2 (TCP) แทน QUIC ที่ท้ายเน็ตองค์กร/บ้านหลายร่างบล็อก UDP → ป่องแสดให้ 530 อย่างเดียว
      return spawnWatch(bin, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://localhost:${port}`], (l) => (l.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/) || [])[0]);
    }
    if (provider === 'ngrok') {
      return spawnWatch(bin, ['http', String(port), '--log', 'stdout', '--log-format', 'json'], (l) => {
        try { const j = JSON.parse(l); return j.url && /^https:/.test(j.url) ? j.url : null; } catch { return null; }
      });
    }
    if (provider === 'tailscale') {
      const r = await run(bin, ['funnel', '--bg', String(port)]);
      if (r.code !== 0) return fail(`เปิด Funnel ไม่ได้ — ${(r.err || r.out).trim().slice(0, 200) || 'ตรวจว่า Tailscale ล็อกอินอยู่และเปิด Funnel ใน tailnet แล้ว'}`);
      const s = await run(bin, ['status', '--json']);
      try {
        const dns = JSON.parse(s.out).Self.DNSName.replace(/\.$/, '');
        return setUrl(`https://${dns}`);
      } catch { return fail('อ่านชื่อเครื่อง Tailscale ไม่ได้'); }
    }
    return fail('ไม่รู้จักผู้ให้บริการ tunnel');
  }

  return {
    available: () => Object.fromEntries(Object.keys(BIN).map((k) => [k, !!findBin(k)])),
    status: () => ({ provider, state, url, msg, adopted }),
    // บูต: พยายามดึง tunnel เก่าที่ยังรันอยู่ (จาก update/ปิดหน้าต่างล่าสุด) — ได้ = ลิงก์เดิมไม่ตาย
    async adopt(prt, preferred) {
      if (!stateFile || state === 'on') return this.status();
      try {
        const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (s && alive(s.pid) && Number(s.port) === Number(prt)) {
          provider = s.provider; port = Number(prt); url = s.url; state = 'on'; adopted = true; msg = ''; retry = 0;
          logger('tunnel', `ดึง tunnel เดิมคืนมาแล้ว (${s.provider}, pid ${s.pid}) — ลิงก์เดิมใช้ต่อได้ทันที: ${s.url}`);
          onUrl(s.url, provider);
          return this.status();
        }
        clearState();   // ตายแล้ว/พอร์ตลิบ = ขยะ — ล้างทิ้ง
      } catch { void 0; }
      if (preferred && provider !== preferred) { /* ยังไม่เปิด — ให้ start ปกติ */ }
      return this.status();
    },
    async start(p, prt) {
      await this.stop();
      provider = p; port = prt; stopping = false; retry = 0; adopted = false;
      await startInner();
      return this.status();
    },
    async stop(opts = null) {
      // opts.linger = ตอนแอปออก (before-quit): ไม่ฆ่า cloudflared — daemon คาบหอยไปต่อทั้งชับ update → ลิงก์เดิมใช้ต่อ
      if (!(opts && opts.linger)) {
        stopping = true;
        clearTimeout(retryTimer);
        if (child) { try { child.kill('SIGTERM'); } catch { void 0; } child = null; }
        else if (adopted && provider === 'tailscale') { const bin = findBin('tailscale'); if (bin) await run(bin, ['funnel', 'reset']); }
        else if (state === 'on' && url && provider !== 'tailscale') {
          // adopt จากรอบก่อน (สาย pid ไฟล์เดียว): อ่าน pid ล่าสุดจาก state แล้วฆ่าเชียแรงตอนกดปิดเอง
          try {
            const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            if (s && alive(s.pid)) { process.kill(s.pid, 'SIGTERM'); await new Promise((r) => setTimeout(r, 500)); if (alive(s.pid)) { try { process.kill(s.pid, 'SIGKILL'); } catch { void 0; } } }
          } catch { void 0; }
        }
        clearState();
        if (state !== 'off' && !(opts && opts.linger)) logger('tunnel', 'ปิด tunnel แล้ว');
      }
      state = 'off'; url = null; msg = ''; stopping = false; adopted = false;
      return this.status();
    },
  };
}

module.exports = { createTunnel, findBin };

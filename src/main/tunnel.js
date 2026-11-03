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

function createTunnel({ logger = () => {}, onUrl = () => {} } = {}) {
  let child = null, provider = null, port = null, url = null, state = 'off', msg = '', stopping = false, retry = 0, retryTimer = null;
  const setUrl = (u) => { if (u && u !== url) { url = u; state = 'on'; msg = ''; retry = 0; logger('tunnel', `เปิด tunnel ${provider} แล้ว: ${u}`); onUrl(u, provider); } };
  const fail = (m) => { state = 'error'; msg = m; logger('tunnel', `tunnel ${provider}: ${m}`, 'warn'); };

  function spawnWatch(bin, args, parse) {
    child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const feed = (buf) => { for (const line of String(buf).split('\n')) { const u = parse(line); if (u) setUrl(u); else if (/ERR|error|failed|authtoken/i.test(line) && state !== 'on') msg = line.trim().slice(0, 200); } };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('exit', (code) => {
      child = null;
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
      return spawnWatch(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], (l) => (l.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/) || [])[0]);
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
    status: () => ({ provider, state, url, msg }),
    async start(p, prt) {
      await this.stop();
      provider = p; port = prt; stopping = false; retry = 0;
      await startInner();
      return this.status();
    },
    async stop() {
      stopping = true;
      clearTimeout(retryTimer);
      if (child) { try { child.kill('SIGTERM'); } catch { void 0; } child = null; }
      if (provider === 'tailscale' && state === 'on') { const bin = findBin('tailscale'); if (bin) await run(bin, ['funnel', 'reset']); }
      if (state !== 'off') logger('tunnel', 'ปิด tunnel แล้ว');
      state = 'off'; url = null; msg = '';
      return this.status();
    },
  };
}

module.exports = { createTunnel, findBin };

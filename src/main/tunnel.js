'use strict';

// ============================================================
// Tunnel เปิดแผงเว็บ (port 8008) ออกอินเทอร์เน็ตแบบ https
//   cloudflared : quick tunnel → https://xxxx.trycloudflare.com (เปลี่ยนทุกครั้งที่เริ่มใหม่)
//   ngrok       : https://xxxx.ngrok-free.app (ต้องตั้ง authtoken ใน ngrok ก่อน)
//   tailscale   : Funnel → https://<เครื่อง>.<tailnet>.ts.net (ถาวร ต้องเปิด Funnel ใน tailnet)
// แอปจาก Finder ไม่มี PATH ของ Homebrew → หาโปรแกรมจากพาธมาตรฐานเอง
// ============================================================

const fs = require('fs');
const { spawn: spawnReal, execFile, execFileSync } = require('child_process');

const BIN = {
  cloudflared: ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'],
  ngrok: ['/opt/homebrew/bin/ngrok', '/usr/local/bin/ngrok'],
  tailscale: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'],
};
const findBinReal = (name) => (BIN[name] || []).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
const runReal = (bin, args, timeout = 20_000) => new Promise((resolve) => {
  execFile(bin, args, { timeout }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: String(stdout || ''), err: String(stderr || '') }));
});

// _deps (ไม่บังคับ — ใช้ในเทสต์): แทน findBin / run / spawn ได้ • ไม่ส่ง = ใช้ของจริง
function createTunnel({ logger = () => {}, onUrl = () => {}, stateFile = null, _deps = null } = {}) {
  const findBin = (_deps && _deps.findBin) || findBinReal;
  const run = (_deps && _deps.run) || runReal;
  const spawn = (_deps && _deps.spawn) || spawnReal;
  let gen = 0; // เพิ่มทุกครั้งที่สั่งปิดเอง — งานเปิดที่ค้างอยู่รู้ว่าถูกยกเลิกแล้ว
  let child = null, provider = null, port = null, url = null, state = 'off', msg = '', stopping = false, retry = 0, retryTimer = null, adopted = false;
  // สถานะ daemon ลงไฟล์: pid + url ล่าสุด — แอปปิด/อัปเดตใหม่ = adopt ลิงก์เดิมกลับมา (1033 หาย)
  const saveState = () => {
    if (!stateFile || !url || !provider || !child?.pid) return;
    try { fs.writeFileSync(stateFile, JSON.stringify({ provider, pid: child.pid, url, port, ts: Date.now() })); } catch { void 0; }
  };
  const clearState = () => { if (stateFile) try { fs.unlinkSync(stateFile); } catch { void 0; } };
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  // pid ยังเป็นโปรแกรม tunnel ของเราจริงไหม (กัน macOS เอา pid เดิมไปให้โปรแกรมอื่นแล้วเราไปฆ่าผิดตัว)
  const isTunnelPid = (pid, prov) => {
    if (!(Number(pid) > 1) || !alive(pid) || !BIN[prov]) return false;
    try { return String(execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { timeout: 3000 })).trim().split('/').pop() === prov; }
    catch { return false; }
  };
  let adoptedPid = 0, healthTimer = null;
  // tunnel ที่ adopt มาไม่มี child ให้ฟัง exit → ตรวจทุก 15 วิ ตายแล้ว = เปิดใหม่ (ได้ URL ใหม่ → ลิงก์ถาวรอัปเดตเอง)
  const watchAdopted = () => {
    clearInterval(healthTimer);
    healthTimer = setInterval(() => {
      if (!adopted || stopping || state !== 'on' || provider === 'tailscale') return;
      if (isTunnelPid(adoptedPid, provider)) return;
      clearInterval(healthTimer);
      logger('tunnel', `tunnel ${provider} ที่ดึงคืนมา (pid ${adoptedPid}) หยุดทำงานแล้ว — เปิดใหม่`, 'warn');
      adopted = false; adoptedPid = 0; url = null; clearState();
      startInner();
    }, 15_000);
  };
  const setUrl = (u) => {
    if (u && u !== url) {
      url = u; state = 'on'; msg = ''; retry = 0;
      logger('tunnel', `เปิด tunnel ${provider} แล้ว: ${u}${adopted ? ' (นำกลับใช้จากรอบก่อนได้)' : ''}`);
      if (child?.pid) saveState();
      onUrl(u, provider);
      healthStart();
    }
  };
  const fail = (m) => { state = 'error'; msg = m; logger('tunnel', `tunnel ${provider}: ${m}`, 'warn'); };
  // ---------- ตรวจสุขภาวะช่องทางจริงทุก 60 วิ ----------
  // daemon มีชีวิต ≠ ช่องทางสด (trycloudflare/ngrok ตายเงียบ อยู่ข้ามเซสชัน) — ทดสอบ fetch URL ตัวเอง
  // ล้ม 2 ครั้งติด = kill daemon → วง retry เดิมเปิดใหม่ให้ลิงก์ใหม่ → onUrl อัปเดตลิงก์ถาวรเอง (ซ่อมตัวเองโดยไม่ต้องมีคน)
  let healthTimer = null, healthFails = 0, healthGen = -1;
  const healthCheck = async () => {
    if (stopping || gen !== healthGen || !url || (provider !== 'cloudflared' && provider !== 'ngrok')) return;
    try {
      const ac = AbortSignal.timeout ? AbortSignal.timeout(7000) : undefined;
      const res = await fetch(url, { redirect: 'follow', signal: ac });
      if (res.status > 0) healthFails = 0; else healthFails++;
    } catch { healthFails++; }
    if (healthFails >= 2 && child) {
      logger('tunnel', `ตรวจ tunnel ${url} ล้ม ${healthFails} ครั้งติด — รีสตาร์ต daemon ขอลิงก์ใหม่`, 'warn');
      healthFails = 0;
      try { child.kill('SIGTERM'); } catch { void 0; }
    }
  };
  const healthStart = () => {
    clearInterval(healthTimer); healthTimer = null;
    healthGen = gen; healthFails = 0;
    if (!url) return;
    healthTimer = setInterval(() => { healthCheck().catch(() => void 0); }, 60_000);
    healthCheck().catch(() => void 0);
  };
  const healthStop = () => { clearInterval(healthTimer); healthTimer = null; };

  function spawnWatch(bin, args, parse) {
    const me = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child = me;
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
    // เปิดโปรแกรมไม่ได้ (ไฟล์หาย/ไม่มีสิทธิ์รัน) — ไม่มี 'exit' ตามมา → เดิมค้างที่ "starting" ตลอด
    child.on('error', (err) => {
      if (child !== me) return;
      child = null;
      clearState();
      if (stopping) return;
      url = null;
      fail(`เปิดโปรแกรม ${provider} ไม่ได้ (${(err && (err.code || err.message)) || 'ไม่ทราบสาเหตุ'})`);
    });
    child.on('exit', (code) => {
      // ตัวที่ถูกสั่งปิด/ถูกแทนแล้ว = ไม่ต้องเริ่มใหม่ (เดิม stop() คืน stopping=false ก่อน exit มาถึง
      // → exit คิดว่าล่มเอง → spawn ตัวที่สองซ้อน = cloudflared กำพร้าค้าง + ลิงก์เก่ายังเปิดอยู่)
      if (child !== me) return;
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
      const myGen = gen;
      const r = await run(bin, ['funnel', '--bg', String(port)]);
      // ถูกสั่งปิดระหว่างรอ funnel เปิด = ต้องปิด funnel ที่เพิ่งเปิดด้วย (ไม่งั้นหน้าจอบอกปิดแต่ยังเปิดสาธารณะ)
      // (state ไม่ใช่ off = มีการสั่งเปิดรอบใหม่แล้ว funnel เป็นของรอบนั้น — ไม่แตะ)
      if (myGen !== gen) { if (r.code === 0 && state === 'off') await run(bin, ['funnel', 'reset']); return undefined; }
      if (r.code !== 0) return fail(`เปิด Funnel ไม่ได้ — ${(r.err || r.out).trim().slice(0, 200) || 'ตรวจว่า Tailscale ล็อกอินอยู่และเปิด Funnel ใน tailnet แล้ว'}`);
      const s = await run(bin, ['status', '--json']);
      try {
        const dns = JSON.parse(s.out).Self.DNSName.replace(/\.$/, '');
        if (myGen !== gen) { if (state === 'off') await run(bin, ['funnel', 'reset']); return undefined; }
        return setUrl(`https://${dns}`);
      } catch { return fail('อ่านชื่อเครื่อง Tailscale ไม่ได้'); }
    }
    return fail('ไม่รู้จักผู้ให้บริการ tunnel');
  }

  // หา tunnel กำพร้าของแอปนี้: ชื่อโปรแกรม + args ชี้พอร์ตแผงของเรา + ppid 1 (แอปตัวที่เปิดมันปิดไปแล้ว)
  // ไม่แตะ tunnel ของโปรแกรมอื่น (พอร์ตอื่น / พ่อแม่ยังอยู่)
  function findOrphans(prt, keepPid = 0) {
    let out = '';
    try { out = String(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,args='], { timeout: 5000 })); } catch { return []; }
    const sig = new RegExp(`/(cloudflared|ngrok)\\s.*(localhost|127\\.0\\.0\\.1):${Number(prt)}(\\s|$)|/ngrok\\s+http\\s+${Number(prt)}(\\s|$)`);
    return out.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
      .filter((m) => Number(m[2]) === 1 && Number(m[1]) !== Number(keepPid) && sig.test(m[3]))
      .map((m) => Number(m[1]));
  }
  function reapOrphans(prt, keepPid = 0) {
    const pids = findOrphans(prt, keepPid);
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { void 0; } }
    if (pids.length) logger('tunnel', `ปิด tunnel กำพร้าที่ค้างจากรอบก่อน ${pids.length} ตัว (pid ${pids.join(', ')}) — ลิงก์เก่าเหล่านั้นใช้ไม่ได้แล้ว`, 'warn');
    return pids;
  }

  return {
    findOrphans,
    reapOrphans,
    available: () => Object.fromEntries(Object.keys(BIN).map((k) => [k, !!findBin(k)])),
    status: () => ({ provider, state, url, msg, adopted }),
    // บูต: พยายามดึง tunnel เก่าที่ยังรันอยู่ (จาก update/ปิดหน้าต่างล่าสุด) — ได้ = ลิงก์เดิมไม่ตาย
    async adopt(prt, preferred) {
      if (!stateFile || state === 'on') return this.status();
      try {
        const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        const pidOk = s && s.provider === 'tailscale' ? true : s && isTunnelPid(s.pid, s.provider);
        if (s && pidOk && Number(s.port) === Number(prt) && /^https:\/\//.test(String(s.url || ''))) {
          provider = s.provider; port = Number(prt); url = s.url; state = 'on'; adopted = true; msg = ''; retry = 0;
          adoptedPid = Number(s.pid) || 0;
          watchAdopted();
          reapOrphans(prt, adoptedPid);
          logger('tunnel', `ดึง tunnel เดิมคืนมาแล้ว (${s.provider}, pid ${s.pid}) — ลิงก์เดิมใช้ต่อได้ทันที: ${s.url}`);
          onUrl(s.url, provider);
          return this.status();
        }
        clearState();   // ตายแล้ว/ชี้ผิดตัว = ขยะ — ล้างทิ้ง
      } catch { void 0; }
      reapOrphans(prt); // ไม่มีตัวให้ adopt = ตัวค้างทั้งหมดเป็นกำพร้า
      return this.status();
    },
    async start(p, prt) {
      await this.stop();
      healthStop();
      reapOrphans(prt);
      provider = p; port = prt; stopping = false; retry = 0; adopted = false;
      await startInner();
      return this.status();
    },
    async stop(opts = null) {
      // opts.linger = ตอนแอปออก (before-quit): ไม่ฆ่า cloudflared — daemon คาบหอยไปต่อทั้งชับ update → ลิงก์เดิมใช้ต่อ
      if (!(opts && opts.linger)) {
        stopping = true;
        gen++;
        clearTimeout(retryTimer);
        healthStop();
        if (child) { const c = child; child = null; try { c.kill('SIGTERM'); } catch { void 0; } }
        // tailscale ไม่มี child/pid ให้ฆ่า: funnel --bg ค้างอยู่ใน tailscaled → สั่งปิดเอง = reset เสมอ
        // (เดิม reset เฉพาะตอน adopted → เปิดจากรอบนี้แล้วกดปิด = หน้าจอบอกปิด แต่แผงยังเปิดสาธารณะ)
        else if (provider === 'tailscale' && state !== 'off') {
          const bin = findBin('tailscale');
          const r = bin ? await run(bin, ['funnel', 'reset']) : null;
          if (!r || r.code !== 0) logger('tunnel', `ปิด Tailscale Funnel ไม่สำเร็จ — ตรวจเองด้วยคำสั่ง tailscale funnel status${r ? ' (' + ((r.err || r.out).trim().slice(0, 160) || 'code ' + r.code) + ')' : ' (ไม่พบโปรแกรม tailscale)'}`, 'warn');
        }
        else if (state === 'on' && url && provider !== 'tailscale') {
          // adopt จากรอบก่อน (สาย pid ไฟล์เดียว): อ่าน pid ล่าสุดจาก state แล้วฆ่าเชียแรงตอนกดปิดเอง
          try {
            const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            if (s && isTunnelPid(s.pid, provider)) { process.kill(s.pid, 'SIGTERM'); await new Promise((r) => setTimeout(r, 500)); if (isTunnelPid(s.pid, provider)) { try { process.kill(s.pid, 'SIGKILL'); } catch { void 0; } } }
          } catch { void 0; }
        }
        clearState();
        if (state !== 'off' && !(opts && opts.linger)) logger('tunnel', 'ปิด tunnel แล้ว');
      }
      clearInterval(healthTimer);
      state = 'off'; url = null; msg = ''; stopping = false; adopted = false; adoptedPid = 0;
      return this.status();
    },
  };
}

module.exports = { createTunnel, findBin: findBinReal };

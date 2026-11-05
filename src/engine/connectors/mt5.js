'use strict';

// ============================================================
// MT5 Connector — อ่านข้อมูลจากไฟล์ bridge ที่ EA ใน MT5 เขียนทิ้งไว้
// EA: mt5-ea/JsonBridgeEA.mq5 (ผู้ใช้ติดตั้งใน MT5 เอง ดู README)
// ไฟล์ JSON มีรูปแบบ:
// { "t": <unix sec>, "symbol": "XAUUSD", "digits": 2,
//   "candles": { "M1": [[t,o,h,l,c,v],...], "M5": [...], "M15": [...], "H1": [...] } }
// ============================================================

const fs = require('fs');
const path = require('path');
const os = require('os');

const BRIDGE_FILENAME = 'goldsignal_bridge.json';
const MAX_FILE_AGE_MS = 60_000;  // ไฟล์ต้องสดกว่า 1 นาที มิฉะนั้นถือว่า EA หยุดทำงาน
const CMD_TTL_SEC = 15;          // คำสั่งที่ EA ไม่หยิบภายใน 15 วิ = หมดอายุ (กันไม้เก่าไปเข้าตอน MT5 เปิดใหม่)
const FX_TTL_MS = 15 * 60_000;   // อัตราแลกเปลี่ยนสกุลบัญชี → USD (สำรองเมื่อ EA ไม่ส่ง tickValue)

// หา Wine + MetaEditor จากแอป MetaTrader ใน /Applications (สำหรับคอมไพล์ EA แทนผู้ใช้)
function findWine() {
  let apps = [];
  try { apps = fs.readdirSync('/Applications').filter((n) => n.endsWith('.app') && /metatrader/i.test(n)); } catch { return null; }
  for (const a of apps) {
    const base = path.join('/Applications', a, 'Contents', 'SharedSupport', 'wine');
    const wine = path.join(base, 'bin', 'wine64');
    if (fs.existsSync(wine)) {
      const lib = path.join(base, 'lib'), libExt = path.join(base, 'lib', 'external');
      return { wine, app: a, dyld: fs.existsSync(libExt) ? `${lib}:${libExt}` : lib };
    }
  }
  return null;
}

// คอมไพล์ JsonBridgeEA.mq5 → .ex5 ด้วย metaeditor64.exe บน wine (headless, ต้องมีไฟล์ใน expertsDir แล้ว)
async function compileEA(expertsDir, logger = () => {}) {
  const fe = findWine();
  if (!fe) return { ok: false, msg: 'ไม่พบโปรแกรม MetaTrader (Wine) ใน /Applications — เปิด MetaTrader 5 ก่อนแล้วลองอีกครั้ง' };
  const prefix = process.env.WINEPREFIX || path.join(os.homedir(), 'Library', 'Application Support', 'net.metaquotes.wine.metatrader5');
  // หา metaeditor64.exe ใน prefix (พาธมาตรฐาน: Program Files/MetaTrader 5)
  const exeCandidates = ['MetaTrader 5', 'MetaTrader 5 (broker)'];
  let exeWin = null;
  for (const d of exeCandidates) {
    if (fs.existsSync(path.join(prefix, 'drive_c', 'Program Files', d, 'metaeditor64.exe'))) {
      exeWin = `C:\\Program Files\\${d}\\metaeditor64.exe`;
      break;
    }
  }
  if (!exeWin) return { ok: false, msg: 'ไม่พบ metaeditor64.exe ใน ' + prefix + '/drive_c/Program Files/*' };
  const logName = 'GS-compile.log';
  const { execFile } = require('child_process');
  // async: เดิม execFileSync บล็อก main process ทั้งก้อน (ราคาสด/ผลออร์เดอร์หยุดระหว่างคอมไพล์)
  const exitCode = await new Promise((resolve) => {
    execFile(fe.wine, [exeWin, '/compile:JsonBridgeEA.mq5', `/log:${logName}`], {
      cwd: expertsDir,
      env: { ...process.env, WINEPREFIX: prefix, DYLD_LIBRARY_PATH: fe.dyld },
      timeout: 120_000,
    }, (err) => resolve(err ? (err.code != null ? err.code : null) : 0));
  });
  const ex5 = fs.existsSync(path.join(expertsDir, 'JsonBridgeEA.ex5'));
  logger('mt5', `คอมไพล์ EA: ${ex5 ? 'สำเร็จ' : 'ไม่สำเร็จ'} (exit ${exitCode ?? '?'})`);
  // parse ผลลัพธ์จาก log (MetaEditor เขียน UTF-16LE — ตัดตัวอักษรศูนย์ทิ้งให้อ่านได้)
  let summary = '';
  try {
    const raw = fs.readFileSync(path.join(expertsDir, logName));
    const text = raw.toString('utf16le').replace(/\0/g, '');
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    summary = lines.slice(-2).join(' • ').replace(/\s+/g, ' ');
  } catch { void 0; }
  if (!ex5 && summary) logger('mt5', 'compile log: ' + summary, 'warn');
  return { ok: ex5, msg: ex5 ? 'คอมไพล์ .ex5 สำเร็จ' : `คอมไพล์ล้มเหลว — ${summary || 'ลองใน MetaEditor (F7) แล้วบอกข้อความ error'}` };
}

// ตรวจล็อตปิดบางส่วนตามสเปกโบรก (ก่อนเขียนคำสั่ง closepart): > 0 • ทวีคูณ volStep • ≥ volMin • < ขนาดไม้ • เหลือ ≥ volMin
// คืน { ok: true, volume } (ปัดเป็นทศนิยมตาม step — กันเลขทศนิยมลอยในบรรทัด CMD) หรือ { ok: false, reason }
function checkPartialVolume({ volume, posVolume, volMin, volStep } = {}) {
  const v = Number(volume), pv = Number(posVolume);
  if (!Number.isFinite(v) || v <= 0) return { ok: false, reason: 'ใส่จำนวนล็อตที่จะปิดให้ถูกต้อง (ต้องมากกว่า 0)' };
  if (!Number.isFinite(pv) || pv <= 0) return { ok: false, reason: 'ไม่รู้ขนาดไม้ปัจจุบัน — รอข้อมูลจาก MT5 แล้วลองใหม่' };
  const step = Number(volStep) > 0 ? Number(volStep) : 0.01;
  const min = Number(volMin) > 0 ? Number(volMin) : step;
  const dec = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  const k = v / step;
  if (Math.abs(k - Math.round(k)) > 1e-6) return { ok: false, reason: `ล็อตต้องเป็นทวีคูณของ ${step} (โบรกรับทีละ ${step} ล็อต)` };
  const vol = Number((Math.round(k) * step).toFixed(dec));
  if (vol < min - 1e-9) return { ok: false, reason: `ปิดได้ขั้นต่ำ ${min} ล็อต` };
  if (vol >= pv - 1e-9) return { ok: false, reason: `ล็อตที่ปิดต้องน้อยกว่าขนาดไม้ (${pv} ล็อต) — ปิดทั้งไม้ให้ใช้ปุ่มปิด` };
  const remain = Number((pv - vol).toFixed(dec));
  if (remain < min - 1e-9) return { ok: false, reason: `ปิดแล้วต้องเหลือไม้อย่างน้อย ${min} ล็อต (จะเหลือ ${remain})` };
  return { ok: true, volume: vol, remain };
}

// ค้นหาโฟลเดอร์ MQL5/Experts ของ MetaTrader ในเครื่อง (สำหรับติดตั้ง EA ให้ผู้ใช้โดยอัตโนมัติ)
function findMql5ExpertsDir() {
  const bases = MT5Connector.candidateDirs();
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    let budget = 4000;
    const stack = [base];
    while (stack.length && budget-- > 0) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const p = path.join(dir, e.name);
        if (e.name === 'MQL5') {
          const experts = path.join(p, 'Experts');
          if (fs.existsSync(experts) && fs.statSync(experts).isDirectory()) return experts;
        }
        if (!e.name.startsWith('.')) stack.push(p);
      }
    }
  }
  return null;
}

class MT5Connector {
  constructor({ logger = () => {} } = {}) {
    this.id = 'mt5';
    this.label = 'MT5 Terminal';
    this.logger = logger;
    this.status = { state: 'searching', msg: 'กำลังค้นหาไฟล์ bridge จาก MT5...' };
    this.bridgePath = null;
    this.latest = null;   // { candles, price, ts, symbol, meta }
    this.lastMtime = 0;
    this.scanTimer = null;
    this.pending = new Map();   // id → { side, lot, sl, tp } คำสั่งที่ส่งแล้วยังไม่ได้ผล
    this.seenResults = new Set();
    this.resultsSeeded = false; // ผลเก่าในไฟล์ตอนเปิดแอป = ไม่นับเป็นผลใหม่ (กัน toast ซ้ำ 32 รายการ)
    this.lastGoodAt = 0;        // เวลาที่อ่าน bridge สำเร็จล่าสุด (ใช้ตัดสินว่าข้อมูลบัญชี/ราคาเชื่อได้)
    this.fx = null;             // { cur, rate, at } สำรองจาก Yahoo
    this._fxBusy = false;
  }

  start() {
    this._scan();
    this.scanTimer = setInterval(() => this._scan(), 30_000); // สแกนซ้ำเบา ๆ ทุก 30 วิ
  }

  stop() {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = null;
  }

  // ที่ตั้งไฟล์: override จาก settings ได้ (/MT5 bridge path)
  static candidateDirs() {
    return [
      path.join(os.homedir(), 'Library', 'Application Support', 'net.metaquotes.wine.metatrader5'),
      path.join(os.homedir(), 'Library', 'Application Support', 'com.metaquotes.metatrader5'),
      path.join(os.homedir(), 'Library', 'Application Support', 'MetaTrader 5'),
      path.join(os.homedir(), 'winapp'),
      path.join(os.homedir(), 'MetaTrader 5'),
    ];
  }

  _scan(overridePath = this.settingsOverride) {
    // ผู้ใช้เลือกไฟล์ใหม่ระหว่างรัน = สลับทันที (เดิมยึดไฟล์แรกที่เจอจนรีสตาร์ท คำสั่งจึงไปผิดเทอร์มินัลได้)
    if (overridePath && overridePath !== this.bridgePath && fs.existsSync(overridePath)) {
      this._switchBridge(overridePath);
      this.logger('mt5', `ใช้ไฟล์ bridge ที่เลือก: ${overridePath}`);
    }
    // เจอแล้วและยังอยู่ = จบ ไม่ต้องเดินไฟล์ซ้ำ (โฟลเดอร์ MT5 ใหญ่มาก)
    if (this.bridgePath && fs.existsSync(this.bridgePath)) { this.settingsOverride = overridePath; return; }
    let found = this.bridgePath;
    // 1) ผู้ใช้ระบุเอง = ชนะเสมอ
    if (overridePath && fs.existsSync(overridePath)) found = overridePath;
    // เดินโฟลเดอร์ MT5 (หลายพันโฟลเดอร์ แบบ sync) ไม่เกินทุก 30 วิ — เดิมเดินทุกรอบวิเคราะห์ตอนยังไม่เจอไฟล์ = main process กระตุก
    else if (Date.now() - (this._lastWalk || 0) < 30_000) { this.settingsOverride = overridePath; return; }
    else {
      this._lastWalk = Date.now();
      // 2) ค้นหาแบบจำกัดงบในโฟลเดอร์ MT5 ที่รู้จัก
      outer:
      for (const base of MT5Connector.candidateDirs()) {
        if (!fs.existsSync(base)) continue;
        let budget = 4000;
        const stack = [base];
        while (stack.length && budget-- > 0) {
          const dir = stack.pop();
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
          for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isFile() && e.name === BRIDGE_FILENAME) { found = p; break outer; }
            if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'Logs' && e.name !== 'cache' && e.name !== 'Profiles') stack.push(p);
          }
        }
      }
      // 3) โฟลเดอร์สาธารณะ (ทางเลือกให้ผู้ใช้คัดลอกเองได้)
      const pub = path.join(os.homedir(), 'Documents', 'GoldSignal', BRIDGE_FILENAME);
      if (!found && fs.existsSync(pub)) found = pub;
    }
    if (found !== this.bridgePath) {
      this._switchBridge(found);
      if (found) this.logger('mt5', `พบไฟล์ bridge: ${found}`);
    }
    if (!found) {
      this.status = { state: 'no-bridge', msg: 'ยังไม่พบไฟล์ bridge จาก MT5 (ติดตั้ง EA ตามคู่มือ หรือเลือก bridge path เอง)' };
    }
    this.settingsOverride = overridePath;
  }

  setBridgePath(p) { this.settingsOverride = p || null; this._scan(); }

  // เปลี่ยนเทอร์มินัล: ถอนคำสั่งค้างจากเครื่องเดิม (ไม่ให้ไปโผล่เครื่องใหม่) + ล้างผลเก่า + ดูโฟลเดอร์ใหม่
  _switchBridge(next) {
    if (this.bridgePath && this.pending.size) {
      this.pending.clear();
      try { this.writeCommands(); } catch { void 0; }
    }
    this.pending.clear();
    this.seenResults = new Set();
    this.resultsSeeded = false;
    this.bridgePath = next;
    this.latest = null;
    this.lastGoodAt = 0;
    if (this._watchHandler) { this.unwatch(); this.watch(this._watchHandler); }
  }

  // โฟลเดอร์ไฟล์คำสั่ง/ผลลัพธ์ = โฟลเดอร์เดียวกับไฟล์ bridge (MQL5/Files)
  commandsDir() { return this.bridgePath ? path.dirname(this.bridgePath) : null; }

  // id เพิ่มขึ้นเสมอ (EA จำ id ล่าสุดที่ทำแล้ว แล้วข้าม id ที่น้อยกว่า — เดิมสุ่มท้ายเลข
  // ส่งหลายคำสั่งในมิลลิวินาทีเดียวกัน id อาจถอยหลัง แล้วคำสั่งถัดไปถูกข้ามเงียบ ๆ)
  nextId() {
    this._lastId = Math.max(Date.now() * 1000, (this._lastId || 0) + 1);
    return this._lastId;
  }

  // เขียนไฟล์คำสั่งทบทวนจากคิว pending (เขียน .tmp → เปลี่ยนชื่อ กันอ่านครึ่งไฟล์)
  writeCommands() {
    const dir = this.commandsDir();
    if (!dir) throw new Error('ยังไม่เชื่อม MT5 (ไม่พบโฟลเดอร์ bridge)');
    // exp = เวลาหมดอายุ (unix GMT) — EA v1.4 ปฏิเสธคำสั่งเกินเวลา; EA รุ่นเก่าข้าม key นี้ได้ปกติ
    const lines = [...this.pending.entries()].map(([i, c]) =>
      `CMD id=${i} action=${c.action} side=${c.side} lot=${c.lot} price=${c.entry || 0} sl=${c.sl} tp=${c.tp} ticket=${c.ticket || 0} exp=${c.exp} comment=GoldSignal`);
    fs.writeFileSync(path.join(dir, 'goldsignal_commands.txt.tmp'), lines.join('\r\n') + '\r\n', 'utf8');
    fs.renameSync(path.join(dir, 'goldsignal_commands.txt.tmp'), path.join(dir, 'goldsignal_commands.txt'));
  }

  // เพิ่มคำสั่งเข้าคิวแล้วเขียนไฟล์ — เขียนไม่สำเร็จต้องถอนออกจากคิว
  // (เดิมค้างในคิว: ผู้ใช้เห็น "ส่งไม่ได้" แล้วกดซ้ำ → ไฟล์มีสองคำสั่ง → EA เปิดไม้ซ้ำ)
  _enqueue(cmd) {
    const id = this.nextId();
    const sentAt = Date.now();
    this.pending.set(id, { ...cmd, sentAt, exp: Math.floor(sentAt / 1000) + CMD_TTL_SEC });
    try { this.writeCommands(); } catch (err) { this.pending.delete(id); throw err; }
    return id;
  }

  // ถอนคำสั่งที่ EA ไม่หยิบภายในเวลา ออกจากคิวและไฟล์ — คืนรายการที่หมดอายุ
  expirePending(now = Date.now()) {
    const expired = [];
    for (const [id, c] of this.pending.entries()) {
      // EA รับคำสั่งได้ถึงวินาที exp → แอปถือว่าหมดอายุเมื่อเลย exp ไปแล้ว 2 วิ (กันสองฝั่งเห็นต่างกัน)
      if (now / 1000 > c.exp + 2) { this.pending.delete(id); expired.push({ id, ...c }); }
    }
    if (expired.length) { try { this.writeCommands(); } catch { void 0; } }
    return expired;
  }

  // ส่งคำสั่งให้ EA (EA ต้องเปิด InpAllowOrders + ปุ่ม AutoTrading)
  sendOrder({ side, lot, sl, tp }) {
    const id = this._enqueue({ action: 'open', side, lot, sl, tp, ticket: 0 });
    this.logger('mt5', `ส่งคำสั่ง id=${id} ${side} ล็อต ${lot} sl=${sl} tp=${tp}`);
    return { id };
  }

  requestClose(ticket) {
    const id = this._enqueue({ action: 'close', side: '-', lot: 0, sl: 0, tp: 0, ticket });
    this.logger('mt5', `ส่งคำสั่งปิดไม้ ticket=${ticket} (id=${id})`);
    return { id };
  }

  // ปิดบางส่วน (ปิดครึ่ง) — ต้องมี EA v1.9 (action closepart, lot = ล็อตที่จะปิด) • ตรวจล็อตด้วย checkPartialVolume ก่อนเรียก
  requestClosePartial(ticket, volume) {
    const id = this._enqueue({ action: 'closepart', side: '-', lot: volume, sl: 0, tp: 0, ticket });
    this.logger('mt5', `ส่งคำสั่งปิดบางส่วน ticket=${ticket} ล็อต ${volume} (id=${id})`);
    return { id };
  }

  // ปิดหลายไม้ในครั้งเดียว: เข้าคิวทั้งหมดแล้วเขียนไฟล์รอบเดียว — เขียนไม่สำเร็จ = ถอนทั้งชุด
  requestCloseAll(tickets) {
    const ids = [];
    for (const ticket of tickets) {
      const id = this.nextId();
      const sentAt = Date.now();
      this.pending.set(id, { action: 'close', side: '-', lot: 0, sl: 0, tp: 0, ticket, sentAt, exp: Math.floor(sentAt / 1000) + CMD_TTL_SEC });
      ids.push(id);
    }
    try { this.writeCommands(); } catch (err) { for (const id of ids) this.pending.delete(id); throw err; }
    this.logger('mt5', `ส่งคำสั่งปิดทุกไม้ ${ids.length} ไม้ (tickets ${tickets.join(', ')})`);
    return { ids };
  }

  requestModify(ticket, sl, tp) {
    const id = this._enqueue({ action: 'modify', side: '-', lot: 0, sl, tp, ticket });
    this.logger('mt5', `ส่งคำสั่งแก้ไม้ ticket=${ticket} sl=${sl} tp=${tp || '-'} (id=${id})`);
    return { id };
  }

  // แก้คำสั่งรอ (ราคาเข้า/SL/TP) — ต้องมี EA v1.8 (action pmodify)
  requestModifyPending(ticket, entry, sl, tp) {
    const id = this._enqueue({ action: 'pmodify', side: '-', lot: 0, entry, sl, tp, ticket });
    this.logger('mt5', `ส่งคำสั่งแก้ไม้รอ ticket=${ticket} ราคา=${entry} sl=${sl} tp=${tp || '-'} (id=${id})`);
    return { id };
  }

  // วางคำสั่งรอล่วงหน้า (limit/stop) — ราคา trigger (entry) + SL/TP คุมไม้ตั้งแต่วาง
  sendPending({ side, ptype, lot, entry, sl, tp }) {
    const id = this._enqueue({ action: ptype === 'stop' ? 'stop' : 'limit', side, lot, entry, sl, tp, ticket: 0 });
    this.logger('mt5', `วางคำสั่งรอ id=${id} ${side.toUpperCase()} ${ptype.toUpperCase()} ล็อต ${lot} ที่ ${entry} • SL ${sl} • TP ${tp || '-'}`);
    return { id };
  }

  // ยกเลิกคำสั่งรอ (ลบ order ที่ยังไม่ trigger จาก MT5)
  requestCancelPending(ticket) {
    return { id: this._enqueue({ action: 'cancel', side: '-', lot: 0, sl: 0, tp: 0, ticket }) };
  }

  // ข้อมูลจาก bridge สดพอจะใช้ตัดสินส่งไม้จริงไหม (อ่านสำเร็จภายใน maxAgeMs)
  isLive(maxAgeMs = 15_000) { return this.status.state === 'ok' && Date.now() - this.lastGoodAt < maxAgeMs; }

  // อ่านไฟล์ราคาสดจิ๋ว (EA เขียนตามทิคโบรกเกอร์) — วัดความสดจากเวลาไฟล์จริง (ไม่ใช่เวลาเซิร์ฟเวอร์ที่ต่างเขต)
  pollQuotes() {
    const dir = this.commandsDir();
    if (!dir) return null;
    const f = path.join(dir, 'goldsignal_quotes.txt');
    let raw = null, mtimeMs = 0;
    try {
      const st = fs.statSync(f);
      if (Date.now() - st.mtimeMs > 6000) return null;
      raw = fs.readFileSync(f, 'utf8');
      mtimeMs = st.mtimeMs;
    } catch { return null; }
    const line = raw.split(/\r?\n/).find((l) => l.startsWith('Q '));
    if (!line) return null;
    const obj = {};
    for (const p of line.slice(2).trim().split(' ')) {
      const eq = p.indexOf('=');
      if (eq >= 0) obj[p.slice(0, eq)] = p.slice(eq + 1);
    }
    return {
      bid: Number(obj.bid), ask: Number(obj.ask), digits: Number(obj.digits) || 2,
      spread: Number(obj.spread) || null, t: mtimeMs, source: 'mt5',
      equity: Number(obj.eq) || null, balance: Number(obj.bal) || null,
      connected: obj.conn == null ? true : obj.conn === '1',   // EA รุ่นก่อนไม่มี conn = ถือว่าเชื่อม
      fresh: Number(obj.bid) > 0 && obj.conn !== '0',
    };
  }

  // อ่านผลการทำงานของ EA → คืนเฉพาะรายการใหม่
  pollResults() {
    const dir = this.commandsDir();
    if (!dir) return [];
    const f = path.join(dir, 'goldsignal_results.txt');
    let raw;
    try { raw = fs.readFileSync(f, 'utf8'); } catch { return []; }
    const out = [];
    const seeding = !this.resultsSeeded;
    this.resultsSeeded = true;
    for (const line of raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
      if (!line.startsWith('RES ')) continue;
      const obj = {};
      const msgAt = line.indexOf(' msg=');
      const head = msgAt >= 0 ? line.slice(4, msgAt) : line.slice(4);
      for (const p of head.trim().split(' ')) {
        const eq = p.indexOf('=');
        if (eq < 0) continue;
        obj[p.slice(0, eq)] = p.slice(eq + 1);
      }
      if (msgAt >= 0) obj.msg = line.slice(msgAt + 5).trim();
      const id = Number(obj.id);
      if (!id || this.seenResults.has(id)) continue;
      // ล้างความจำเกิน 500 → เก็บเฉพาะ id ที่ยังอยู่ในไฟล์ (เดิม clear ทั้งหมด = ผลเก่า 32 รายการเด้งซ้ำ)
      if (this.seenResults.size > 500) this.seenResults = new Set(raw.split(/\r?\n/).map((l) => Number((l.match(/id=(\d+)/) || [])[1])).filter(Boolean));
      this.seenResults.add(id);
      if (seeding && !this.pending.has(id)) continue; // ผลเก่าจากรอบก่อนเปิดแอป
      const cmd = this.pending.get(id) || null;
      this.pending.delete(id);
      // ts จาก EA เป็นเวลาเซิร์ฟเวอร์โบรกเกอร์ → แปลงเป็นเวลาเครื่องด้วย offset เดียวกับ bridge
      out.push({ id, ts: Number(obj.ts) > 0 ? Number(obj.ts) * 1000 - (this.tzFix || 0) : Date.now(), status: obj.status, retcode: Number(obj.retcode) || 0, ticket: Number(obj.ticket) || 0, price: Number(obj.price) || 0, msg: obj.msg || '', cmd });
    }
    return out;
  }

  // เหตุการณ์ไฟล์ bridge เปลี่ยน → แจ้งผู้ฟัง ('quotes' | 'bridge' | 'results') แบบไม่รอโพล
  watch(handler) {
    if (this._watcher || this._watchTimer) return; // มีอยู่แล้ว / กำลังรอเริ่ม
    this._watchHandler = handler;
    const start = () => {
      this._watchTimer = null;
      if (this._watcher) return;
      const dir = this.commandsDir();
      if (!dir) { this._watchTimer = setTimeout(start, 5000); return; }
      try {
        this._watcher = fs.watch(dir, { persistent: false }, (_ev, fname) => {
          const f = String(fname || '');
          if (f.endsWith('.tmp')) return; // EA เขียน .tmp แล้ว rename — สนใจเฉพาะไฟล์จริง (ไม่อ่านซ้ำ 2 ครั้งต่อการเขียน)
          if (f.startsWith('goldsignal_quotes')) handler('quotes');
          else if (f.startsWith('goldsignal_bridge')) handler('bridge');
          else if (f.startsWith('goldsignal_results')) handler('results');
          else if (f.startsWith('goldsignal_commands')) handler('commands');
        });
        this._watcher.on('error', () => { try { this._watcher.close(); } catch { void 0; } this._watcher = null; this._watchTimer = setTimeout(start, 10_000); });
      } catch { this._watchTimer = setTimeout(start, 10_000); }
    };
    start();
  }
  unwatch() {
    if (this._watchTimer) clearTimeout(this._watchTimer);
    this._watchTimer = null;
    try { if (this._watcher) this._watcher.close(); } catch { void 0; }
    this._watcher = null;
  }

  // พร้อมใช้ = มีไฟล์ และไฟล์ยังสด (เดิมแค่มีไฟล์ — EA ปิดแล้วโหมดอัตโนมัติก็ยังวิเคราะห์แท่งค้าง ไม่สลับไปข้อมูลฟรี)
  available() {
    if (!this.bridgePath) return false;
    try { return Date.now() - fs.statSync(this.bridgePath).mtimeMs < MAX_FILE_AGE_MS; } catch { return false; }
  }

  // อัตราแลกเปลี่ยน (สกุลบัญชีต่อ 1 USD): 1) จาก EA (tickValue/tickSize/contractSize = แม่นที่สุด)
  // 2) USD = 1  3) Yahoo `${cur}=X` (ดึงเบื้องหลัง เก็บ 15 นาที)  ไม่รู้ = null → ระบบไม่ใช้ทุนจาก MT5
  _usdRate(cur, spec) {
    if (spec && spec.tickValue > 0 && spec.tickSize > 0 && spec.contractSize > 0) return spec.tickValue / (spec.tickSize * spec.contractSize);
    if (!cur || cur === 'USD') return 1;
    const fresh = this.fx && this.fx.cur === cur && Date.now() - this.fx.at < FX_TTL_MS;
    if (!fresh && !this._fxBusy && Date.now() - (this._fxFailAt || 0) > 60_000) {
      this._fxBusy = true;
      const { fetchUsdRate } = require('./yahoo');
      fetchUsdRate(cur)
        .then((rate) => { this.fx = { cur, rate, at: Date.now() }; this.logger('mt5', `อัตราแลกเปลี่ยน 1 USD = ${rate} ${cur} (Yahoo)`); })
        .catch((err) => { this._fxFailAt = Date.now(); this.logger('mt5', `ดึงอัตราแลกเปลี่ยน ${cur} ไม่ได้: ${err.message}`, 'warn'); })
        .finally(() => { this._fxBusy = false; });
    }
    return this.fx && this.fx.cur === cur ? this.fx.rate : null;
  }

  // อ่านไฟล์ bridge → แปลงเป็น candles เวลาปกติ {t,o,h,l,c,v}
  fetch() {
    this._scan();
    if (!this.bridgePath) throw new Error(this.status.msg);
    let raw, stale = false;
    try {
      const st = fs.statSync(this.bridgePath);
      this.lastMtime = st.mtimeMs;
      stale = Date.now() - st.mtimeMs > MAX_FILE_AGE_MS;
      raw = fs.readFileSync(this.bridgePath, 'utf8');
    } catch (err) {
      throw new Error(`อ่านไฟล์ bridge ไม่ได้: ${err.message}`);
    }
    if (stale) {
      this.status = { state: 'stale', msg: 'ไฟล์ bridge ไม่อัปเดตแล้ว (EA อาจหยุดทำงาน/MT5 ปิดอยู่)' };
      throw new Error(this.status.msg); // ห้ามวิเคราะห์/ส่งไม้จากข้อมูลค้าง — โหมดอัตโนมัติจะสลับไปข้อมูลฟรีเอง
    }
    let json;
    try { json = JSON.parse(raw); } catch {
      // โดนจับขณะเขียนอยู่ — ใช้ข้อมูลรอบก่อนได้ไม่เกิน 10 วิ; นานกว่านั้น = ไฟล์เสีย (เช่น EA รุ่นเก่าเขียน JSON ผิด)
      if (this.latest && Date.now() - this.lastGoodAt < 10_000) return this.latest;
      this.status = { state: 'parse-error', msg: 'ไฟล์ bridge อ่านไม่ได้ (JSON เสีย) — ติดตั้ง EA เวอร์ชันล่าสุดจากแท็บ MT5' };
      throw new Error(this.status.msg);
    }
    // เขตเวลาโบรเกอร์ → เวลาจริงของเครื่อง: broker `t` เป็นเวลาเทียบเครื่องโบรเกอร์
    // (วัด offset จาก snapshot ล่าสุด; ต้องอยู่ในกรอบ ±15 ชม. จึงถือว่าเชื่อถือได้)
    const brokerTs = Number(json.t) * 1000;
    const tzFix = Number(json.gmt) > 0 && Number(json.srv) > 0
      ? (Number(json.srv) - Number(json.gmt)) * 1000
      : Number.isFinite(brokerTs) && Math.abs(brokerTs - Date.now()) < 15 * 3600_000 ? brokerTs - Date.now() : 0;
    this.tzFix = tzFix;
    const meta = {
      bid: Number(json.bid) || null,
      ask: Number(json.ask) || null,
      digits: Number(json.digits) || 2,
      spreadPts: Number(json.spreadPts) || null,
      positions: Array.isArray(json.positions)
        ? json.positions.map((p) => ({
            ticket: p.ticket, type: p.type === 'buy' ? 'buy' : 'sell',
            volume: Number(p.volume), open: Number(p.open), sl: Number(p.sl),
            tp: Number(p.tp), profit: Number(p.profit),
          })).filter((p) => Number.isFinite(p.ticket))
        : [],
      // ประวัติไม้จริงที่ปิดแล้ว (จาก deal ปิดในบัญชี — ครอบคลุม TP/SL/ปิดมือ)
      // null = EA รุ่นเก่าไม่ส่งประวัติ (ต่างจาก [] = ส่งแล้วแต่ยังไม่มีไม้ปิด)
      history: Array.isArray(json.history)
        ? json.history.filter((h) => h && h.pid).map((h) => ({
            pid: Number(h.pid), type: h.type === 'buy' ? 'buy' : 'sell',
            volume: Number(h.volume) || 0, open: Number(h.open) || 0,
            close: Number(h.close) || 0, profit: Number(h.profit) || 0,
            reason: String(h.reason || 'manual'),
            time: Number(h.time) > 0 ? Number(h.time) * 1000 - tzFix : null,
          }))
        : null,
      // คำสั่งรอ (pending limit/stop ที่ตั้งไว้ยังไม่ trigger) — null = EA รุ่นเก่าไม่ส่ง
      pendings: Array.isArray(json.pendings)
        ? json.pendings.filter((h) => h && h.ticket).map((h) => ({
            ticket: Number(h.ticket) || 0, type: String(h.type || ''),
            volume: Number(h.volume) || 0, open: Number(h.open) || 0,
            sl: Number(h.sl) || 0, tp: Number(h.tp) || 0,
          }))
        : null,
      // เวอร์ชัน EA (รองรับ pendings ตั้งแต่ 1.7) — เกตให้แอปบอก "อัปเดต EA ก่อน" ได้ตรง
      ea: String(json.ea || ''),
      // สเปกสัญลักษณ์จาก EA v1.4 (ไม่มี = null → ใช้ค่ามาตรฐาน 100 oz/ล็อต)
      spec: Number(json.contractSize) > 0 ? {
        contractSize: Number(json.contractSize), tickValue: Number(json.tickValue) || 0, tickSize: Number(json.tickSize) || 0,
        volMin: Number(json.volMin) || 0.01, volStep: Number(json.volStep) || 0.01,
      } : null,
      account: json.account ? {
        login: Number(json.account.login) || null,
        name: String(json.account.name || ''), server: String(json.account.server || ''),
        currency: String(json.account.currency || 'USD').toUpperCase().slice(0, 6),
        balance: Number(json.account.balance) || 0, equity: Number(json.account.equity) || 0,
        margin: Number(json.account.margin) || 0, marginFree: Number(json.account.marginFree) || 0,
        leverage: Number(json.account.leverage) || null,
        ordersAllowed: json.account.ordersAllowed === true,
        algoTrading: json.account.algoTrading === true,
      } : null,
    };
    // ทุนเป็น USD สำหรับคิดความเสี่ยง (เดิมเอายอดสกุลบัญชีมาใช้ตรง ๆ — บัญชี THB เพดาน 2% หลวมไป ~33 เท่า)
    if (meta.account) {
      const rate = this._usdRate(meta.account.currency, meta.spec);
      meta.account.usdRate = rate;
      meta.account.equityUSD = rate ? meta.account.equity / rate : null;
      meta.account.balanceUSD = rate ? meta.account.balance / rate : null;
    }
    const candles = {};
    for (const tfk of ['M1', 'M5', 'M15', 'H1']) {
      const rows = json.candles && json.candles[tfk];
      if (!Array.isArray(rows)) continue;
      candles[tfk] = rows
        .map((r) => Array.isArray(r) ? { t: r[0], o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] } : r)
        .filter((c) => c && Number.isFinite(c.t) && Number.isFinite(c.c))
        .sort((a, b) => a.t - b.t);
    }
    if (!candles.M5 || candles.M5.length < 30) {
      if (this.latest) return this.latest;
      throw new Error('ข้อมูลในไฟล์ bridge ยังน้อยเกินไป — รอ EA ส่งข้อมูลเพิ่ม');
    }
    const price = meta.bid || (candles.M5 ? candles.M5[candles.M5.length - 1].c : null);
    this.latest = { source: this.id, symbol: json.symbol || 'XAUUSD', price, ts: Date.now(), candles, meta };
    this.lastGoodAt = Date.now();
    this.status = { state: 'ok', msg: `เชื่อมต่อ MT5 แล้ว (${path.basename(path.dirname(path.dirname(this.bridgePath)))})` };
    return this.latest;
  }
}

module.exports = { MT5Connector, BRIDGE_FILENAME, findMql5ExpertsDir, compileEA, findWine, checkPartialVolume };
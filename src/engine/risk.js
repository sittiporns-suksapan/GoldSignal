'use strict';

const ind = require('./indicators');

// ============================================================
// กฎความเสี่ยงถาวร (HARD RULES) — ล็อคไว้ในโค้ด ปิดไม่ได้ด้วย settings หรือ plugin
// 1. ทุกสัญญาณต้องมี SL ฝั่งถูกทิศ มิฉะนั้นถูกทิ้ง
// 2. ขนาดล็อตคำนวณจาก % ความเสี่ยงของทุน และห้ามเกิน 2% ต่อไม้
// 3. RR (Take Profit เทียบ Stop Loss) ห้ามต่ำกว่าเกณฑ์ (ค่าตั้งต้น 1.5)
// 4. ล็อตขั้นต่ำ 0.01 — ถ้าพื้นที่ SL ทำให้ต้องใช้ล็อตผิดปกติ สัญญาณถูกปฏิเสธ
// ============================================================

const HARD_MAX_RISK_PCT = 2.0;   // เพดานสัมบูรณ์
const HARD_MIN_RR = 1.0;         // RR ต่ำสุดสัมบูรณ์ (ส่วนใหญ่ตั้ง 1.5)
const MIN_LOT = 0.01;
const OVERCAP_MAX_PCT = 10;      // แก้ SL/คำสั่งรอแบบยืนยันเกินเพดาน: ค่าตั้งต้นของเพดานสัมบูรณ์ (ผู้ใช้ยกได้ 10–50%)
const OZ_PER_LOT = 100;          // XAUUSD มาตรฐาน: 1 ล็อต = 100 ออนซ์ ($1 ต่อ ล็อต = $100)

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

// ทำสัญญาณดิบให้สมบูรณ์/ปฏิเสธถ้าโครงสร้างผิด
function normalizeSignal(raw, price) {
  if (!raw || typeof raw !== 'object') return null;
  let side = String(raw.side || '').toLowerCase();
  if (side === 'long') side = 'buy';
  if (side === 'short' || side === 'sell') side = 'sell';
  if (side !== 'buy' && side !== 'sell') return null;
  const entry = Number.isFinite(raw.entry) ? raw.entry : price;
  const sl = Number(raw.sl);
  if (!Number.isFinite(entry) || !Number.isFinite(sl) || entry <= 0 || sl <= 0) return null;
  if (side === 'buy' && sl >= entry) return null;
  if (side === 'sell' && sl <= entry) return null;
  let tp = Number(raw.tp);
  let autoTp = false;
  if (!Number.isFinite(tp) || tp <= 0) {
    // ถ้าไม่ได้กำหนด TP ให้ใช้ RR = 2 (สัดส่วนปลอดภัยเริ่มต้น)
    tp = side === 'buy' ? entry + 2 * (entry - sl) : entry - 2 * (sl - entry);
    autoTp = true;
  }
  if (side === 'buy' && tp <= entry) return null;
  if (side === 'sell' && tp >= entry) return null;
  const confidence = clamp(Math.round(Number(raw.confidence) || 0), 0, 100);
  return {
    side, entry: ind.round(entry, 2), sl: ind.round(sl, 2), tp: ind.round(tp, 2),
    confidence, autoTp,
    reason: String(raw.reason || '-').slice(0, 300),
  };
}

// เพดานต่อกลุ่มคำสั่ง: ปรับได้ 2–10% (default 2%) — อัตโนมัติ = autoRiskMaxPct • ปุ่มกดเอง = manualRiskMaxPct
// (เดิมล็อก 2% ตายทุกชั้น — รุ่นปรับยืดหยุ่น: ผู้ใช้ยกได้เอง ระบบแค่บีบกรอบ + ให้เหตุผลทุกครั้ง)
function autoCapPct(settings = {}) {
  return clamp(Number(settings.autoRiskMaxPct) || HARD_MAX_RISK_PCT, HARD_MAX_RISK_PCT, 10);
}
function manualCapPct(settings = {}) {
  return clamp(Number(settings.manualRiskMaxPct) || HARD_MAX_RISK_PCT, HARD_MAX_RISK_PCT, 100);
}
function jointCapPct(settings = {}) {   // คำสั่งที่มาทางใดทางหนึ่งใช้เพดานกว้างกว่า (ผู้ใช้เลือกทั้งคู่เอง)
  return Math.max(autoCapPct(settings), manualCapPct(settings));
}
// เพดานสัมบูรณ์ของการแก้ SL/คำสั่งรอแบบกดเอง: default 10% — ผู้ใช้ยกได้ถึง 100% ของทุน (ยืนยันทุกครั้งตามเดิม)
function absOvercapPct(settings = {}) {
  return clamp(Number(settings.modifyAbsMaxPct) || OVERCAP_MAX_PCT, OVERCAP_MAX_PCT, 100);
}

// คำนวณขนาดล็อตตาม % ความเสี่ยง
function calcPosition({ equity, riskPct, entry, sl, ozPerLot = OZ_PER_LOT, settings }) {
  const cap = settings ? autoCapPct(settings) : HARD_MAX_RISK_PCT;
  const eff = clamp(riskPct, 0.05, cap);
  const riskUSD = (equity * eff) / 100;
  const slDist = Math.abs(entry - sl);
  const usdPerDollarPerLot = ozPerLot; // ราคาขยับ $1 => กำไร/ขาดทุน $100 ต่อ 1 ล็อต
  const lotRaw = slDist > 0 ? riskUSD / (slDist * usdPerDollarPerLot) : 0;
  // +1e-9 กันปัดผิดจากทศนิยมลอยตัว (เช่น 0.29 → 0.28) — ยังปัดลงเสมอ (ด้านปลอดภัย)
  return { effRiskPct: eff, riskUSD, slDist, lotRaw, lot: Math.floor(lotRaw * 100 + 1e-9) / 100 };
}

// ผ่านด่านกฎทีละข้อ สัญญาณที่ไม่ผ่านจะถูกเก็บเป็น "สาเหตุการปฏิเสธ"
function evaluateSignal(sig, settings) {
  const equity = Number(settings.equity) || 0;
  const ozPerLot = Number(settings.ozPerLot) || OZ_PER_LOT;
  const minRR = Math.max(HARD_MIN_RR, Number(settings.minRR) || 1.5);
  const minConf = Math.max(0, Number(settings.minConfidence) || 60);
  const pos = calcPosition({ equity, riskPct: settings.riskPct, entry: sig.entry, sl: sig.sl, ozPerLot, settings });
  const rr = Math.abs(sig.tp - sig.entry) / Math.abs(sig.entry - sig.sl);
  const metrics = { rr: ind.round(rr, 2), riskUSD: ind.round(pos.riskUSD, 2), lot: pos.lot, slDist: ind.round(pos.slDist, 2), effRiskPct: pos.effRiskPct };
  const out = { ...sig, metrics, pass: true, reject: null };

  const reject = (why) => { out.pass = false; out.reject = why; return out; };

  if (equity <= 0) return reject('ยังไม่ได้ตั้งทุน (ตั้งได้ในแท็บสัญญาณ)');
  if (!Number.isFinite(rr) || rr < minRR) return reject(`RR ${ind.round(rr, 2)} ต่ำกว่าเกณฑ์ที่ตั้งไว้ ${minRR}`);
  if (sig.confidence < minConf) return reject(`ความมั่นใจ ${sig.confidence}% ต่ำกว่าเกณฑ์ ${minConf}%`);
  if (!(pos.lot >= MIN_LOT)) return reject('พื้นที่ SL กว้างเกินไป — ล็อตขั้นต่ำ 0.01 ทำให้ความเสี่ยงต่อไม้เกินที่ตั้งไว้ จึงปฏิเสธ');
  return out;
}

// คะแนนความเสี่ยงของไม้ (ยิ่งต่ำยิ่งปลอดภัยกว่า) — ใช้หา "ไม้เสี่ยงน้อยที่สุดของรอบ"
// องค์ประกอบ: ระยะ SL ยิ่งกว้างยิ่งเสี่ยง (40) • RR ยิ่งต่ำกว่า 2.5 ยิ่งเสี่ยง (20)
//   • ความมั่นใจยิ่งต่ำยิ่งเสี่ยง (20) • ช่วงเวลาตลาดยิ่งไม่ดียิ่งเสี่ยง (20)
const SESS_PENALTY = { best: 0, good: 5, ok: 10, avoid: 18, closed: 20 };
function riskScore(sig, sessionQuality = 'good') {
  let score = 0;
  const slDist = Math.abs(Number(sig.entry) - Number(sig.sl));
  score += clamp((slDist / (Number(sig.entry) || 1)) * 5000, 0, 40);
  const rr = sig.metrics && Number.isFinite(sig.metrics.rr) ? sig.metrics.rr : null;
  if (Number.isFinite(rr)) score += clamp((2.5 - rr) * 8, 0, 20);
  score += clamp((80 - Number(sig.confidence || 0)) * 0.4, 0, 20);
  score += SESS_PENALTY[sessionQuality] != null ? SESS_PENALTY[sessionQuality] : 10;
  return ind.round(score, 1);
}

// ---------- ตรวจคำสั่งซื้อขายจริงจากปุ่มในแอป (กันเหนียว 3 ชั้น) ----------
// จุดต่างจากสัญญาณ: ผู้ใช้เป็นผู้ตัดสินใจ — เราบังคับเฉพาะของแข็ง:
//  SL ห้ามลบ • เพดานเสี่ยงตามกลุ่ม: auto=autoRiskMaxPct, ปุ่มกด/เว็บ/Telegram=manualRiskMaxPct (2–10%) • ทุกไม้มีเหตุผลกรองพร้อมแสดง
function validateManualOrder({ side, lot, entry, sl, tp, settings, manualToday = 0, signalsToday = 0, auto = false, allowOverCap = false }) {
  const equity = Number(settings.equity) || 0;
  const ozPerLot = Number(settings.ozPerLot) || OZ_PER_LOT;   // ขนาดสัญญาจริงของโบรกเกอร์ (จาก EA) ถ้ามี
  const base = { pass: false, reason: null, warn: null, metrics: {} };
  if (settings.realOrdersEnabled !== true) return { ...base, reason: 'สวิตช์ "อนุญาตส่งออร์เดอร์จริง" ยังปิดอยู่ — เปิดที่การ์ดคำสั่งเทรด' };
  if (!Number.isFinite(entry) || entry <= 0) return { ...base, reason: 'ยังไม่มีราคาสดจาก MT5 (bid/ask) — เชื่อม MT5 ก่อน' };
  if (!['buy', 'sell'].includes(side)) return { ...base, reason: 'ขอบฝั่งซื้อ/อนุญาตให้เข้าไม้ไม่ถูกต้อง' };
  if (!Number.isFinite(sl) || sl <= 0) return { ...base, reason: 'ต้องระบุ Stop Loss (บังคับทุกไม้)' };
  if (side === 'buy' && sl >= entry) return { ...base, reason: 'SL ของไม้ซื้อต้องอยู่ต่ำกว่าราคาเข้า' };
  if (side === 'sell' && sl <= entry) return { ...base, reason: 'SL ของไม้ขายต้องอยู่สูงกว่าราคาเข้า' };
  if (Number.isFinite(tp) && tp > 0 && (side === 'buy' ? tp <= entry : tp >= entry)) return { ...base, reason: `TP ของไม้${side === 'buy' ? 'ซื้อต้องอยู่สูงกว่า' : 'ขายต้องอยู่ต่ำกว่า'}ราคาเข้า` };
  if (!Number.isFinite(lot) || lot < MIN_LOT) return { ...base, reason: 'ล็อตน้อยกว่าขั้นต่ำ 0.01' };
  // โบรกเกอร์ที่ล็อตขั้นต่ำสูงกว่า: EA จะปัดขึ้นจนเสี่ยงเกินที่คิด → ปฏิเสธตั้งแต่ตรงนี้
  if (Number(settings.volMin) > 0 && lot < Number(settings.volMin) - 1e-9) return { ...base, reason: `ล็อตต่ำกว่าขั้นต่ำของโบรกเกอร์ (${settings.volMin})` };

  const slDist = Math.abs(entry - sl);
  const riskUSD = lot * slDist * ozPerLot;
  // เพดานตามกลุ่มผู้ร้อง: ระบบส่งเอง (auto-enter/สัญญาณ) = เพดานอัตโนมัติ • มือ/เว็บ/Telegram ปุ่มกด = เพดานปุ่มกด
  const capPct = auto ? autoCapPct(settings) : manualCapPct(settings);
  const groupTxt = auto ? 'อัตโนมัติ' : 'ปุ่มกดเอง';
  const hardMax = (equity * capPct) / 100;
  if (equity <= 0) return { ...base, reason: 'ยังไม่ได้ตั้งทุน (แท็บตั้งค่า)' };
  // เกินเพดานกลุ่ม: auto = ปฏิเสธเสมอ • ปุ่มกด/เว็บ/Telegram มือ = allowOverCap ผ่านได้ (ผู้ใช้ยืนยันเห็นเตือนก่อน)
  if (riskUSD > hardMax * 1.001) {
    if (auto || !allowOverCap) return {
      ...base,
      overCap: true,
      reason: `ไม้นี้เสี่ยง $${ind.round(riskUSD, 2)} = ${ind.round(riskUSD / Math.max(equity, 1) * 100, 1)}% ของทุน ($${ind.round(equity, 0)}) เกินเพดาน${groupTxt} ${capPct}% ($${ind.round(hardMax, 2)}) — ลดล็อต/SL ใกล้ขึ้น หรือยืนยันเกินเพดานเอง`,
      metrics: { riskUSD: ind.round(riskUSD, 2), hardMax: ind.round(hardMax, 2), slDist: ind.round(slDist, 2) },
    };
  }

  const rrBase = Number.isFinite(tp) && tp > 0 ? Math.abs(tp - entry) / Math.abs(entry - sl) : null;
  let warn = null;
  if (riskUSD > hardMax * 1.001) warn = `⚠ เสี่ยงเกินเพดาน${groupTxt} (${capPct}%) — ผู้ใช้ยืนยันเกินเพดานเอง`;
  if (Number.isFinite(rrBase) && rrBase < Math.max(HARD_MIN_RR, Number(settings.minRR) || 1.5)) {
    warn = (warn ? warn + ' • ' : '') + `RR แผนนี้ 1:${ind.round(rrBase, 2)} ต่ำกว่าเกณฑ์ของระบบสัญญาณ (${settings.minRR}) — พิจารณา TP ให้ไกลขึ้น`;
  }

  const max = Number(settings.maxSignalsPerDay) || 0;
  if (max > 0 && signalsToday + manualToday >= max) {
    return { ...base, reason: `ครบโควตา ${max} ไม้ต่อวัน (สัญญาณ + คำสั่งจริงนับรวมกัน)`, metrics: { riskUSD: ind.round(riskUSD, 2) } };
  }

  return {
    pass: true, reason: null, warn,
    metrics: {
      riskUSD: ind.round(riskUSD, 2), slDist: ind.round(slDist, 2),
      rr: rrBase != null ? ind.round(rrBase, 2) : null, lot,
    },
  };
}

// แก้ SL/TP ของไม้ที่เปิดอยู่: SL ห้ามลบ + ต้องอยู่ฝั่งถูกของราคาปิดปัจจุบัน + ขาดทุนที่ SL ใหม่ไม่เกินเพดาน 2%
// (ยกเว้นการขยับที่ลดความเสี่ยงลงจากเดิม — เลื่อน SL เข้าใกล้ต้องทำได้เสมอ)
function validateModify({ side, open, volume, curSl = 0, sl, tp, market, settings, allowOverCap = false }) {
  const equity = Number(settings.equity) || 0;
  const ozPerLot = Number(settings.ozPerLot) || OZ_PER_LOT;
  const base = { pass: false, reason: null, metrics: {} };
  if (settings.realOrdersEnabled !== true) return { ...base, reason: 'สวิตช์ "อนุญาตส่งออร์เดอร์จริง" ยังปิดอยู่ — เปิดที่การ์ดคำสั่งเทรด' };
  if (!['buy', 'sell'].includes(side)) return { ...base, reason: 'ฝั่งของไม้ไม่ถูกต้อง' };
  if (!Number.isFinite(market) || market <= 0) return { ...base, reason: 'ยังไม่มีราคาสดจาก MT5 — เชื่อม MT5 ก่อน' };
  if (!Number.isFinite(sl) || sl <= 0) return { ...base, reason: 'ต้องมี Stop Loss (ห้ามลบ SL)' };
  if (side === 'buy' && sl >= market) return { ...base, reason: `SL ของไม้ซื้อต้องต่ำกว่าราคาปัจจุบัน (BID ${market.toFixed(2)})` };
  if (side === 'sell' && sl <= market) return { ...base, reason: `SL ของไม้ขายต้องสูงกว่าราคาปัจจุบัน (ASK ${market.toFixed(2)})` };
  if (Number.isFinite(tp) && tp > 0 && (side === 'buy' ? tp <= market : tp >= market)) return { ...base, reason: `TP ของไม้${side === 'buy' ? 'ซื้อต้องสูงกว่า' : 'ขายต้องต่ำกว่า'}ราคาปัจจุบัน (${market.toFixed(2)})` };
  if (equity <= 0) return { ...base, reason: 'ยังไม่ได้ตั้งทุน (แท็บตั้งค่า)' };
  // ขาดทุนถ้าโดน SL วัดจากราคาเข้า (SL เลยจุดเข้าไปฝั่งกำไร = ล็อกกำไร เสี่ยง 0)
  const lossAt = (s) => (s > 0 ? Math.max(0, side === 'buy' ? open - s : s - open) * volume * ozPerLot : Infinity);
  const riskUSD = lossAt(sl);
  const curRisk = lossAt(Number(curSl) || 0);
  const capPctMod = jointCapPct(settings);
  const hardMax = (equity * capPctMod) / 100;
  const metrics = { riskUSD: ind.round(riskUSD, 2), hardMax: ind.round(hardMax, 2) };
  // เพดานสัมบูรณ์ (ผู้ใช้ตั้งได้): ยืนยันแล้วก็ห้ามเกิน; ตรวจก่อน เพื่อไม่ถามยืนยันในเคสที่ยังไงก็ไม่ผ่าน
  const absPct = absOvercapPct(settings);
  const absMax = (equity * absPct) / 100;
  if (riskUSD > absMax * 1.001 && riskUSD > curRisk + 1e-9) return {
    ...base, metrics,
    reason: `SL ใหม่เสี่ยง $${ind.round(riskUSD, 2)} เกินเพดานสูงสุด ${absPct}% ของทุน ($${ind.round(absMax, 2)}) — แก้ไม่ได้แม้ยืนยัน ขยับ SL ใกล้ขึ้น (ยกเพดานได้ในแท็บตั้งค่า)`,
  };
  // เกินเพดานที่ตั้ง: ผู้ใช้กดยืนยันเอง (allowOverCap) = แก้ได้ — SL ยังบังคับและต้องอยู่ฝั่งถูกเสมอ
  if (riskUSD > hardMax * 1.001 && riskUSD > curRisk + 1e-9 && !allowOverCap) return {
    ...base, metrics, overCap: true,
    reason: `SL ใหม่เสี่ยง $${ind.round(riskUSD, 2)} เกินเพดาน ${capPctMod}% ของทุน ($${ind.round(hardMax, 2)}) — ขยับ SL ใกล้ขึ้น`,
  };
  return { pass: true, reason: null, metrics };
}

// แก้คำสั่งรอ (limit/stop): ราคาเข้าต้องถูกทิศตามชนิด + SL บังคับฝั่งถูกของราคาเข้า + เพดาน 2%
// (ยกเว้นการแก้ที่ลดความเสี่ยงลงจากเดิม)
function validatePendingModify({ side, ptype, volume, entry, sl, tp, curEntry = 0, curSl = 0, market, settings, allowOverCap = false }) {
  const equity = Number(settings.equity) || 0;
  const ozPerLot = Number(settings.ozPerLot) || OZ_PER_LOT;
  const base = { pass: false, reason: null, metrics: {} };
  if (settings.realOrdersEnabled !== true) return { ...base, reason: 'สวิตช์ "อนุญาตส่งออร์เดอร์จริง" ยังปิดอยู่ — เปิดที่การ์ดคำสั่งเทรด' };
  if (!['buy', 'sell'].includes(side) || !['limit', 'stop'].includes(ptype)) return { ...base, reason: 'ชนิดคำสั่งรอไม่รองรับ' };
  if (!Number.isFinite(market) || market <= 0) return { ...base, reason: 'ยังไม่มีราคาสดจาก MT5 — เชื่อม MT5 ก่อน' };
  if (!Number.isFinite(entry) || entry <= 0) return { ...base, reason: 'ใส่ราคาเข้าของคำสั่งรอ' };
  const name = `${side.toUpperCase()} ${ptype.toUpperCase()}`;
  const above = (side === 'buy') === (ptype === 'stop'); // BUY STOP / SELL LIMIT ต้องอยู่เหนือตลาด
  if (above ? !(entry > market) : !(entry < market)) return { ...base, reason: `${name} ต้องตั้งราคา${above ? 'สูง' : 'ต่ำ'}กว่าตลาดปัจจุบัน (ตอนนี้ ${market.toFixed(2)})` };
  if (!Number.isFinite(sl) || sl <= 0) return { ...base, reason: 'ต้องมี Stop Loss (ห้ามลบ SL)' };
  if (side === 'buy' ? sl >= entry : sl <= entry) return { ...base, reason: `SL ของไม้${side === 'buy' ? 'ซื้อต้องต่ำกว่า' : 'ขายต้องสูงกว่า'}ราคาเข้า` };
  if (Number.isFinite(tp) && tp > 0 && (side === 'buy' ? tp <= entry : tp >= entry)) return { ...base, reason: `TP ของไม้${side === 'buy' ? 'ซื้อต้องสูงกว่า' : 'ขายต้องต่ำกว่า'}ราคาเข้า` };
  if (equity <= 0) return { ...base, reason: 'ยังไม่ได้ตั้งทุน (แท็บตั้งค่า)' };
  const riskUSD = Math.abs(entry - sl) * volume * ozPerLot;
  const curRisk = curEntry > 0 && curSl > 0 ? Math.abs(curEntry - curSl) * volume * ozPerLot : Infinity;
  const capPctPend = jointCapPct(settings);
  const hardMax = (equity * capPctPend) / 100;
  const rr = Number.isFinite(tp) && tp > 0 ? ind.round(Math.abs(tp - entry) / Math.abs(entry - sl), 2) : null;
  const metrics = { riskUSD: ind.round(riskUSD, 2), hardMax: ind.round(hardMax, 2), rr };
  const absPctPend = absOvercapPct(settings);
  const absMax = (equity * absPctPend) / 100;
  if (riskUSD > absMax * 1.001 && riskUSD > curRisk + 1e-9) return {
    ...base, metrics,
    reason: `คำสั่งรอนี้เสี่ยง $${ind.round(riskUSD, 2)} เกินเพดานสูงสุด ${absPctPend}% ของทุน ($${ind.round(absMax, 2)}) — แก้ไม่ได้แม้ยืนยัน ขยับ SL ใกล้ขึ้น (ยกเพดานได้ในแท็บตั้งค่า)`,
  };
  if (riskUSD > hardMax * 1.001 && riskUSD > curRisk + 1e-9 && !allowOverCap) return {
    ...base, metrics, overCap: true,
    reason: `คำสั่งรอนี้เสี่ยง $${ind.round(riskUSD, 2)} เกินเพดาน ${capPctPend}% ของทุน ($${ind.round(hardMax, 2)}) — ขยับ SL ใกล้ขึ้น`,
  };
  return { pass: true, reason: null, metrics };
}

module.exports = {
  HARD_MAX_RISK_PCT, HARD_MIN_RR, MIN_LOT, OZ_PER_LOT,
  clamp, normalizeSignal, calcPosition, evaluateSignal, validateManualOrder, validateModify, validatePendingModify, riskScore,
  autoCapPct, manualCapPct, jointCapPct, absOvercapPct,
};
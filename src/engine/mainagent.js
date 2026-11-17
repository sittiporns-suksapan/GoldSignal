'use strict';

// ============================================================
// MainAgent — เอเจนต์หลักตัวเดียวที่ตัดสินใจเข้าไม้เอง (สวิตช์ mainAgent)
//   - อินพุต: สัญญาณที่ผ่านทุกเกตของรอบ (ความเสี่ยง/มติสภา/โควตา/คูลดาวน์) + % โอกาสคาดการณ์ (opp)
//   - ตัดสินด้วย "คาดหวังกำไรต่อไม้" (Expectancy, หน่วย R): EV = p×RR − (1−p) − ต้นทุน
//   - p ไม่เชื่อ % ระบบตรง ๆ (backtest: มติ 70% ชนะจริงแค่ ~30%) → ปรับเทียบด้วยผลจริง:
//     ทุกสัญญาณที่ประเมิน (เข้าหรือไม่เข้า) ถูกติดตามเป็น "ไม้เงา" จนจบ TP/SL/4 ชม. แล้วนับชนะ/แพ้
//     p = (% ระบบ × 5 + ชนะจริง) / (5 + จำนวนไม้เงาที่จบ) — ยิ่งมีข้อมูล ยิ่งเชื่อผลจริง
//     (backtest 60 วัน: น้ำหนัก 20 = เรียนช้า ขาดทุนช่วงเรียน −13R • น้ำหนัก 5 = −6.6R → ใช้ 5)
//   - ถือไม้เสมือนของตัวเองได้ทีละ 1 ไม้ → ผลเก็บใน main-agent.json
//   - ส่งไม้จริงตามไม้เสมือนทันทีเมื่อผู้ใช้เปิดสวิตช์ mainAgentReal (เกตส่งออร์เดอร์เดิมใน main.js ยังทำงาน)
//   ไฟล์นี้คำนวณอย่างเดียว — การส่งออร์เดอร์จริงอยู่ที่ main.js ผ่าน sendOrderReq (เกตชุดเดิมทุกชั้น)
// ============================================================

const fs = require('fs');

const PRIOR_N = 5;           // น้ำหนักของ % ระบบ เทียบเท่าไม้จริง 5 ไม้
const COST_R = 0.1;          // shortcut: ต้นทุน spread+slippage คงที่ 0.1R — เปลี่ยนเป็นค่าจริงต่อไม้เมื่อสัญญาณมี spread
const MAX_HOLD_MS = 4 * 3600_000;
const HISTORY_MAX = 300;
const SHADOW_MAX = 40;

const round2 = (n) => Math.round(n * 100) / 100;
const rrOf = (s) => {
  const risk = Math.abs(Number(s.entry) - Number(s.sl));
  return risk > 0 && Number(s.tp) > 0 ? Math.abs(Number(s.tp) - Number(s.entry)) / risk : 0;
};

// สูตรกลาง (ใช้ทั้งแอปและ backtest): % ระบบ + ผลจริง (ชนะ w จาก n) → p, EV
function expectedR({ opp, rr, wins = 0, n = 0 }) {
  const prior = Math.max(0.01, Math.min(0.99, (Number(opp) || 0) / 100));
  const p = (prior * PRIOR_N + wins) / (PRIOR_N + n);
  return { p: Math.round(p * 100), rr: round2(rr), ev: round2(p * rr - (1 - p) - COST_R) };
}

function summarize(rows) {
  const n = rows.length;
  const rs = rows.map((t) => (typeof t === 'number' ? t : t.r));
  const sumR = rs.reduce((a, r) => a + r, 0);
  const wins = rs.filter((r) => r > 0);
  const gw = wins.reduce((a, r) => a + r, 0);
  const gl = Math.abs(rs.filter((r) => r <= 0).reduce((a, r) => a + r, 0));
  return { n, wins: wins.length, winRate: n ? Math.round((wins.length / n) * 100) : null, sumR: round2(sumR), expectancy: n ? round2(sumR / n) : null, pf: gl > 0 ? round2(gw / gl) : null };
}

// ราคาล่าสุดตัดสินไม้ (จริง/เงา) — คืน { exit, result, r } หรือ null
function resolve(t, price, now) {
  const dir = t.side === 'buy' ? 1 : -1;
  let exit = null, result = null;
  if (t.tp > 0 && dir * (price - t.tp) >= 0) { exit = t.tp; result = 'TP'; }
  else if (dir * (price - t.sl) <= 0) { exit = t.sl; result = 'SL'; }
  else if (now - t.openedAt > MAX_HOLD_MS) { exit = price; result = 'TIME'; }
  return result ? { exit: round2(exit), result, r: round2((dir * (exit - t.entry)) / Math.abs(t.entry - t.sl)) } : null;
}

class MainAgent {
  constructor({ storePath = null, logger = () => {} } = {}) {
    this.storePath = storePath;
    this.logger = logger;
    this.open = null;       // ไม้เสมือนของเอเจนต์ (ทีละ 1)
    this.history = [];      // ไม้เสมือนของเอเจนต์ที่จบแล้ว
    this.shadow = [];       // ไม้เงาของทุกสัญญาณที่ประเมิน (ยังไม่จบ)
    this.learned = [];      // R ของไม้เงาที่จบแล้ว → ใช้ปรับเทียบ p
    this.lastDecision = null;
    this.load();
  }

  load() {
    if (!this.storePath) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      this.history = Array.isArray(j.history) ? j.history.slice(-HISTORY_MAX) : [];
      this.learned = Array.isArray(j.learned) ? j.learned.filter(Number.isFinite).slice(-HISTORY_MAX) : [];
      this.shadow = Array.isArray(j.shadow) ? j.shadow.slice(-SHADOW_MAX) : [];
      this.open = j.open && j.open.side ? j.open : null;
    } catch { void 0; }
  }

  save() {
    if (!this.storePath) return;
    try {
      fs.writeFileSync(this.storePath + '.tmp', JSON.stringify({ history: this.history, learned: this.learned, shadow: this.shadow, open: this.open }), 'utf8');
      fs.renameSync(this.storePath + '.tmp', this.storePath);
    } catch (e) { this.logger('agent', `บันทึกสมุดเอเจนต์หลักล้ม: ${e.message}`, 'warn'); }
  }

  expectedR(sig) {
    return expectedR({ opp: sig.opp, rr: rrOf(sig), wins: this.learned.filter((r) => r > 0).length, n: this.learned.length });
  }

  _track(s, now, source) {
    const key = `${s.plugin || '?'}|${s.side}|${Math.round(Number(s.entry))}`;
    if (this.shadow.some((x) => x.key === key)) return;
    this.shadow.push({ key, side: s.side, entry: Number(s.entry), sl: Number(s.sl), tp: Number(s.tp) || 0, openedAt: now, source });
    if (this.shadow.length > SHADOW_MAX) this.shadow = this.shadow.slice(-SHADOW_MAX);
  }

  // เลือกไม้ EV สูงสุดของรอบ — คืนไม้เสมือนที่เปิดใหม่ หรือ null
  decide(signals, { minEV = 0.2, now = Date.now(), source = null } = {}) {
    // held ที่ notChosen = ผ่านเกตครบแต่ไม่ใช่ไม้ที่โหมดเลือก (engine กรองโควตา/หยุดข่าวมาแล้ว)
    const cands = (signals || []).filter((s) => (!s.held || s.notChosen) && Number(s.sl) > 0 && rrOf(s) > 0);
    for (const s of cands) this._track(s, now, source);
    if (this.open) { this.lastDecision = { ts: now, action: 'hold', why: 'ถือไม้เสมือนอยู่ 1 ไม้ — รอจบก่อน' }; return null; }
    if (!cands.length) { this.lastDecision = { ts: now, action: 'wait', why: 'ไม่มีสัญญาณผ่านทุกเกตในรอบนี้' }; return null; }
    let best = null;
    for (const s of cands) {
      const e = this.expectedR(s);
      if (!best || e.ev > best.e.ev) best = { s, e };
    }
    const { s, e } = best;
    if (e.ev < minEV) {
      this.lastDecision = { ts: now, action: 'skip', why: `ไม้ดีสุด ${s.side.toUpperCase()} คาดหวัง ${e.ev}R < เกณฑ์ ${minEV}R (p ${e.p}% • RR ${e.rr})` };
      this.save();
      return null;
    }
    this.open = {
      id: `ma-${now}-${s.side}`, side: s.side, entry: Number(s.entry), sl: Number(s.sl), tp: Number(s.tp) || 0,
      lot: Number(s.metrics && s.metrics.lot) || 0.01, plugin: s.plugin || '?', opp: Math.round(Number(s.opp) || 0),
      p: e.p, rr: e.rr, ev: e.ev, openedAt: now, source,
    };
    this.lastDecision = { ts: now, action: 'enter', why: `เข้า ${s.side.toUpperCase()} คาดหวัง ${e.ev}R (p ${e.p}% • RR ${e.rr})` };
    this.save();
    return this.open;
  }

  // ตรวจไม้ของเอเจนต์ + ไม้เงาด้วยราคาล่าสุด — คืนไม้ของเอเจนต์ที่จบ (หรือ null)
  update(price, now = Date.now(), source = null) {
    if (!Number.isFinite(price)) return null;
    const same = (t) => !(t.source && source && t.source !== source);   // ไม่ตัดสินด้วยราคาคนละตลาด
    let dirty = false;
    const rest = [];
    for (const t of this.shadow) {
      const x = same(t) ? resolve(t, price, now) : null;
      if (x) { this.learned.push(x.r); dirty = true; } else rest.push(t);
    }
    this.shadow = rest;
    if (this.learned.length > HISTORY_MAX) this.learned = this.learned.slice(-HISTORY_MAX);
    let done = null;
    const x = this.open && same(this.open) ? resolve(this.open, price, now) : null;
    if (x) {
      done = { ...this.open, ...x, closedAt: now };
      this.history.push(done);
      if (this.history.length > HISTORY_MAX) this.history = this.history.slice(-HISTORY_MAX);
      this.open = null;
      dirty = true;
    }
    if (dirty) this.save();
    return done;
  }

  snapshot() {
    const h = this.history, mid = Math.floor(h.length / 2);
    return {
      open: this.open, last: this.lastDecision, recent: h.slice(-10),
      stats: { all: summarize(h), firstHalf: summarize(h.slice(0, mid)), secondHalf: summarize(h.slice(mid)), calib: summarize(this.learned) },
    };
  }
}

module.exports = { MainAgent, expectedR, summarize, resolve, rrOf, COST_R, PRIOR_N };

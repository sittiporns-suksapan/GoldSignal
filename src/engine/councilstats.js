'use strict';

// ============================================================
// CouncilStats — สมุดผลงานของ "สภา" ทั้งคณะ (ต่างจาก SkillBook ที่วัดรายเอเจนต์)
//   - จดมติทุกรอบ: ทิศ + ความมั่นใจ + จำนวนผู้เห็นพ้อง
//   - จด "เกือบมีมติ" (side=none แต่ข้อมูลเอนชัด ๆ) เป็นตัวเงา — ใช้รู้ว่าถ้าสภาใจกว่านี้จะถูกไหม
//   - หลัง 30 นาที ตรวจราคา: ชนะ = เดินตามทิศ ≥ +0.5×ATR • แพ้ = ย้อน ≤ −0.5×ATR (เกณฑ์เดียวกับ SkillBook)
//   - คะแนนรวม + แยกตามช่วงความมั่นใจ (band) → ใช้ปรับความมั่นใจของมติใหม่
//     สภาช่วงไหนแม่นจริง = เชื่อหนักขึ้น / ล่าช้างแม่นต่ำ = ลดความมั่นใจลง (calibration อัตโนมัติ)
//   - เก็บดิสก์ (userData/council-stats.json) — รีเซ็ตแอปผลสะสมไม่หาย
// ============================================================

const fs = require('fs');
const path = require('path');
const { HIT_THRESHOLD_RATIO, EVAL_DELAY_MS } = require('./skillbook');

const RING_MAX = 64;
const MIN_SAMPLES = 10;              // อย่างน้อยก่อนเริ่มปรับ
const LEAN_NET = 30;                 // เกือบมีมติ = |net| ≥ 30 แต่ไม่ผ่านเกณฑ์จริง
const BANDS = [
  { min: 50, max: 62, name: '50-62%' },
  { min: 63, max: 69, name: '63-69%' },
  { min: 70, max: 79, name: '70-79%' },
  { min: 80, max: 95, name: '80-95%' },
];

class CouncilStats {
  constructor({ storePath, logger = () => {} } = {}) {
    this.storePath = storePath || null;
    this.logger = logger;
    this.pending = [];      // {kind:'verdict'|'lean', side, entry, atr, conf, agree, dueAt}
    this.stats = { verdict: { w: 0, l: 0, ring: [] }, lean: { w: 0, l: 0, ring: [] }, bands: {} };
    this._dirty = false;
    this.load();
  }

  load() {
    if (!this.storePath || !fs.existsSync(this.storePath)) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      this.stats = {
        verdict: jsonGroup(j.verdict), lean: jsonGroup(j.lean), bands: {},
      };
      for (const [k, v] of Object.entries(j.bands || {})) this.stats.bands[k] = jsonGroup(v);
    } catch (e) { this.logger('council', `โหลดสถิติสภาล้มเหลว: ${e.message}`, 'warn'); }
  }

  save() {
    if (!this.storePath || !this._dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(this.storePath + '.tmp', JSON.stringify(this.stats), 'utf8');
      fs.renameSync(this.storePath + '.tmp', this.storePath);
      this._dirty = false;
    } catch (e) { this.logger('council', `บันทึกสถิติสภาล้ม: ${e.message}`, 'warn'); }
  }

  // จดมติแต่ละรอบ — verdict จาก runCouncil (side may be 'none'); กันซ้ำต่อบาร์ 5 นาที (tick 10 วิ มิฉะนั้นสถิติล่มด้วยตัวเดิมนับถม)
  open(verdict, price, atrRef, now) {
    if (!verdict || !Number.isFinite(price) || price <= 0) return;
    if (!Number.isFinite(atrRef) || atrRef <= 0) return;
    const bar = Math.floor(now / 300_000);
    const seen = new Set(this.pending.filter((p) => p.bar === bar).map((p) => p.kind + '|' + p.side));
    const push = (kind, side, conf, agree) => {
      if (seen.has(kind + '|' + side)) return;          // บาร์เดียวกัน ทิศเดียวกัน = ตัวเดียว
      seen.add(kind + '|' + side);
      this.pending.push({
        bar, kind, side, entry: price, atr: atrRef, conf, agree,
        net: verdict.net != null ? verdict.net : null, dueAt: now + EVAL_DELAY_MS,
      });
      if (this.pending.length > 300) this.pending = this.pending.slice(-240);
    };
    if (verdict.side === 'buy' || verdict.side === 'sell') push('verdict', verdict.side, verdict.confidence, verdict.agree || 0);
    else if (Number.isFinite(Number(verdict.net)) && Math.abs(Number(verdict.net)) >= LEAN_NET) {
      const side = Number(verdict.net) > 0 ? 'buy' : 'sell';   // เอนแท้ ๆ ตาม net (แม้ agree ไม่ถึงโควตา)
      push('lean', side, Math.min(69, Math.round(Math.abs(Number(verdict.net)))), verdict.agree || 0);
    }
  }

  processTick(price, now) {
    const rest = [], out = [];
    for (const p of this.pending) {
      if (now < p.dueAt) { rest.push(p); continue; }
      const dir = p.side === 'buy' ? 1 : -1;
      const move = dir * (price - p.entry);
      const win = move >= +HIT_THRESHOLD_RATIO * p.atr;
      const loss = move <= -HIT_THRESHOLD_RATIO * p.atr;
      const v = win ? 1 : loss ? -1 : 0;
      this._record(p.kind, p.conf, v);
      out.push({ kind: p.kind, side: p.side, conf: p.conf, result: win ? 'won' : loss ? 'lost' : 'neutral' });
      if (v !== 0) this._dirty = true;
    }
    this.pending = rest;
    if (out.length) this.save();
    return out;
  }

  bandKey(conf) {
    const c = Math.max(0, Math.min(95, Number(conf) || 0));
    for (const b of BANDS) if (c >= b.min && c <= b.max) return b.name;
    return null;
  }

  _record(kind, conf, v) {
    this._rec(this.stats[kind], v);
    const key = this.bandKey(conf);
    if (key && kind === 'verdict') this._rec(this.stats.bands[key] || (this.stats.bands[key] = { w: 0, l: 0, ring: [] }), v);
  }

  _rec(g, v) {
    if (v > 0) { g.w++; g.ring.push(1); }
    else if (v < 0) { g.l++; g.ring.push(-1); }
    if (g.ring.length > RING_MAX) g.ring = g.ring.slice(-RING_MAX);
    this._dirty = true;
  }

  summary(g) {
    const ring = (g && g.ring) || [];
    const n = ring.filter((x) => x !== 0).length;
    const w = ring.filter((x) => x === 1).length;
    if (n < MIN_SAMPLES) return { n, hit: null, grade: 'กำลังสะสม' };
    const hit = w / n;
    const grade = hit >= 0.65 ? 'แม่น' : hit >= 0.52 ? 'พอใช้' : 'ต้องปรับ';
    return { n, hit, grade, allW: (g && g.w) || 0, allL: (g && g.l) || 0 };
  }

  // กินผลจาก "ไม้จำลองที่ปิด" — ตัวอย่างเรียนรู้เข้มข้นกว่าตรวจ 30 นาที: TP=ชนะ SL=แพ้ TIME=ดูกำไรลอยตัว
  observeTrade(c, win) {
    const v = win === 1 ? 1 : win === -1 ? -1 : 0;
    this._record('verdict', c && c.confidence, v);
    this.save();
    return true;
  }

  // ตัวคูณปรับความมั่นใจของมติใหม่ (แม่นสูง = 1.0-1.15, ต่ำ = 0.85-1.0) — ยังไม่มีตัวเลขพอ = 1.0
  calibration(conf) {
    const s = this.bandSummary(conf);
    if (!s || s.hit == null) return { factor: 1, note: null };
    const factor = Math.max(0.8, Math.min(1.15, 0.55 + s.hit));
    return { factor, note: `สภาช่วง s=${Math.round(s.hit * 100)}% (n=${s.n}) → ×${factor.toFixed(2)}` };
  }

  bandSummary(conf) {
    const key = this.bandKey(conf);
    if (!key || !this.stats.bands[key]) return null;
    return this.summary(this.stats.bands[key]);
  }

  snapshot() {
    const bands = BANDS.map((b) => ({ ...(this.summary(this.stats.bands[b.name]) || { n: 0, hit: null }), band: b.name }));
    return {
      verdict: this.summary(this.stats.verdict),
      lean: this.summary(this.stats.lean),
      bands,
      pending: this.pending.length,
    };
  }
}

function jsonGroup(j) {
  return { w: Math.max(0, Number(j && j.w) | 0), l: Math.max(0, Number(j && j.l) | 0), ring: (j && Array.isArray(j.ring) ? j.ring : []).filter((x) => x === 1 || x === -1).slice(-RING_MAX) };
}

module.exports = { CouncilStats, BANDS, LEAN_NET };
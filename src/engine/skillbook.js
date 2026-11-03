'use strict';

// ============================================================
// SkillBook — สมุดปูมสกิลของเอเจนต์: วัดว่า "แต่ละคนเก่งด้านตัวเองแค่ไหน"
// กลไก: ทุกโหวตที่มั่นใจ ≥50% ถูกจดไว้ → หลัง 30 นาที ตรวจราคา:
//   ชนะ = ราคาเดินตามโหวต ≥ +0.5×ATR ก่อนจะย้อน ≥ −0.5×ATR
//   แพ้ = ย้อนตามข้าคั้นก่อนไปหน้า
//   เงียบ = ไร้ตัวเลขที่ชัด (ไม่นับ)
// น้ำหนักในสภา = ฐาน × (0.6 + 0.9×อัตราชนะ) → เก่งจริงจึงมีสจนในสภา
// เก็บสถิติลงดิสก์ (userData/agent-skills.json) ให้รุ่มเริ่มใหม่ไม่โหนสร้างใหม่
// ============================================================

const fs = require('fs');
const path = require('path');

const HIT_THRESHOLD_RATIO = 0.5;   // ราคาต้องเดิน ≥ 0.5×ATR ถือว่ามีทิศ
const EVAL_DELAY_MS = 30 * 60_000;
const RING_MAX = 32;
const MIN_SAMPLES = 8;

class SkillBook {
  constructor({ storePath, logger = () => {} } = {}) {
    this.storePath = storePath || null;
    this.logger = logger;
    this.pending = [];            // {agent, side, entry, atr, dueAt}
    this.stats = {};              // agent → { w: 0, l: 0, ring: [1|-1...], streak... }
    this._dirty = false;
    this.load();
  }

  load() {
    if (!this.storePath || !fs.existsSync(this.storePath)) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      for (const [agent, s] of Object.entries(j)) {
        this.stats[agent] = { w: s.w | 0, l: s.l | 0, ring: (s.ring || []).slice(-RING_MAX) };
      }
    } catch (e) { this.logger('skills', `โหลดสมุดสกิลล้มเหลว: ${e.message}`, 'warn'); }
  }

  save() {
    if (!this.storePath || !this._dirty) return;
    try {
      const dir = path.dirname(this.storePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.storePath + '.tmp', JSON.stringify(this.stats, null, 0), 'utf8');
      fs.renameSync(this.storePath + '.tmp', this.storePath);
      this._dirty = false;
    } catch (e) { this.logger('skills', `บานทึกสกิลล้ม: ${e.message}`, 'warn'); }
  }

  // จดโหวต (เฉพาะที่คุยจริง: conf ≥ 50 + มีทิศ)
  openVote(agentId, side, price, atrRef, now) {
    if (!['buy', 'sell'].includes(side) || !Number.isFinite(price) || price <= 0) return;
    if (!Number.isFinite(atrRef) || atrRef <= 0) return;
    const bar = Math.floor(now / 300_000);
    if (this.pending.some((p) => p.agent === agentId && p.bar === bar)) return;
    this.pending.push({ bar, agent: agentId, side, entry: price, atr: atrRef, dueAt: now + EVAL_DELAY_MS });
    if (this.pending.length > 400) this.pending = this.pending.slice(-300);
  }

  // ตรวจผลที่ถึงกำหนด — คืนรายการ {"agent", "result"}
  processTick(price, now) {
    const out = [];
    const rest = [];
    for (const p of this.pending) {
      if (now < p.dueAt) { rest.push(p); continue; }
      const dir = p.side === 'buy' ? 1 : -1;
      const move = dir * (price - p.entry);
      const win = move >= +HIT_THRESHOLD_RATIO * p.atr;
      const loss = move <= -HIT_THRESHOLD_RATIO * p.atr;
      let result = 'neutral';
      if (win) result = 'won';
      else if (loss) result = 'lost';
      // ชนะ/แพ้อย่างน้อยหนึ่ง = ตัดสินว่าเดินหน้าหรือถอยก่อน — ที่นี่เก็บมุมเดียว: ทิศสุทธิเทียบเกณฑ์
      this._record(p.agent, win ? 1 : loss ? -1 : 0);
      out.push({ agent: p.agent, result });
    }
    this.pending = rest;
    if (out.length) this.save();
    return out;
  }

  _record(agent, v) {
    const s = this.stats[agent] || (this.stats[agent] = { w: 0, l: 0, ring: [] });
    if (v > 0) { s.w++; s.ring.push(1); }
    else if (v < 0) { s.l++; s.ring.push(-1); }
    if (s.ring.length > RING_MAX) s.ring = s.ring.slice(-RING_MAX);
    this._dirty = true;
  }

  // สรุปสกิลต่อเอเจนต์: hit rate จากตัวเล็กล่าสุด (ring) เป็นหลัก
  summary(agentId) {
    const s = this.stats[agentId];
    if (!s) return { n: 0, hit: null, grade: 'ใหม่' };
    const ring = s.ring || [];
    const w = ring.filter((x) => x === 1).length;
    const l = ring.filter((x) => x === -1).length;
    const n = ring.length;
    if (n < MIN_SAMPLES) return { n, hit: null, grade: 'กำลังสะสมผลงาน' };
    const hit = w / (w + l);
    const grade = hit >= 0.68 ? 'ยอดเยี่ยม' : hit >= 0.56 ? 'เก่ง' : hit >= 0.46 ? 'พอใช้' : 'ต้องปรับ';
    return { n, hit, grade, allW: s.w, allL: s.l };
  }

  // คูณเพิ่มน้ำหนักสภา: 0.6 (พังซีก) … 1.5 (เก่งสุด) — มีผลเฉพาะเมื่อผ่านการวัด
  weightFactor(agentId) {
    const s = this.summary(agentId);
    if (s.hit == null) return 1;
    return 0.6 + 0.9 * s.hit;
  }

  all() {
    const out = {};
    for (const agent of ['trend', 'momentum', 'reversion', 'structure', 'regime', 'session', 'confluence']) {
      out[agent] = this.summary(agent);
      out[agent].factor = this.weightFactor(agent);
    }
    return out;
  }
}

module.exports = { SkillBook, HIT_THRESHOLD_RATIO, EVAL_DELAY_MS };
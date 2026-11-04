'use strict';

// ============================================================
// Agent Council v3 — ทีมเอเจนต์ที่ "เก่งเฉพาะด้าน" แบบพิสูจน์ด้วยข้อมูล
// ทุกกฎในไฟล์นี้ผ่านการวัดย้อนหลังทอง 5m 60 วัน (ไม่มี lookahead) แยกครึ่งแรก/ครึ่งหลัง
// และเก็บเฉพาะสัญญาณที่ทำผลบวกทั้งสองครึ่ง — สัญญาณที่วัดแล้วติดลบถูกถอดออก
// (เช่น CHoCH ไล่ทิศใหม่, ไล่โมเมนตัม, ซื้อย่อ EMA, เด้งแนวรับเปล่า ๆ)
//
// โครงทีม 2 ฝ่าย:
//   ฝ่ายสัญญาณ (โหวตทิศ): เทรนด์ • โครงสร้างแท่ง • ดีดกลับ • โมเมนตัม
//   ฝ่ายบริบท (ไม่โหวตทิศ): สภาพตลาด • ช่วงเวลา • ระดับราคา
//     → ปรับน้ำหนักฝ่ายสัญญาณตามสถานการณ์ (adjust) + สิทธิ์ยับยั้งเพดานความมั่นใจ (cap)
// น้ำหนักจริงในสภา = ฐาน × ผลงานจริงจาก SkillBook (0.6–1.5) × ตัวปรับจากฝ่ายบริบท
// ============================================================

const ind = require('./indicators');
const sessions = require('./sessions');

const OPPOSING_FILTER_CONF = 55; // สวนสภาเมื่อสภามั่นใจเท่านี้ขึ้นไป = กรองทิ้ง
const NET_THRESHOLD = 18;        // คะแนนรวมเกินนี้ถึงเรียก "มีทิศ"
const ER_RANGE = 0.35;           // Efficiency Ratio ≤ นี้ = ตลาดออกข้าง (การสวนได้ผล)

// ---------- เครื่องมือเฉพาะสายอาชีพ ----------
// ยศตำแหน่งราคาใน Bollinger (%B: 0=ขอบล่าง, 1=ขอบบน, <0 / >1 = หลุดแบนด์)
function bbPctB(close, bb) {
  if (!bb || !Number.isFinite(bb.upper) || bb.upper === bb.lower) return 0.5;
  return (close - bb.lower) / (bb.upper - bb.lower);
}

// Kaufman Efficiency Ratio: ระยะสุทธิ ÷ ระยะเดินจริง (1 = วิ่งทางเดียว, ~0 = แกว่งในกรอบ)
function efficiencyRatio(candles, n = 20) {
  if (!candles || candles.length < n + 1) return null;
  const cl = candles.map((c) => c.c);
  const k = cl.length;
  let path = 0;
  for (let i = k - n; i < k; i++) path += Math.abs(cl[i] - cl[i - 1]);
  return path > 0 ? Math.abs(cl[k - 1] - cl[k - 1 - n]) / path : 0;
}

// โครงสร้างจุดกลับตัว (swing): HH/HL = บันไดขึ้น, LH/LL = บันไดลง
function structureState(candles, w = 3) {
  if (!candles || candles.length < 20) return null;
  const s = ind.swings(candles, w);
  const hs = s.highs, ls = s.lows;
  if (hs.length < 2 || ls.length < 2) return null;
  const lastH = hs[hs.length - 1], prevH = hs[hs.length - 2];
  const lastL = ls[ls.length - 1], prevL = ls[ls.length - 2];
  const hh = lastH > prevH, hl = lastL > prevL, lh = lastH < prevH, ll = lastL < prevL;
  const dir = hh && hl ? 'buy' : lh && ll ? 'sell' : 'none';
  return { hh, hl, lh, ll, dir, lastH, lastL };
}

// แท่ง M5 ปิดหลุดขอบ Bollinger แล้วแท่งล่าสุดปิดกลับเข้ามาในแบนด์ = แรงยืดถูกปฏิเสธ
function bandReentry(candles) {
  if (!candles || candles.length < 25) return 'none';
  const cl = candles.map((c) => c.c);
  const bb = ind.bollinger(cl, 20, 2);
  const n = cl.length;
  if (bb.lower[n - 2] == null || bb.lower[n - 1] == null) return 'none';
  if (cl[n - 2] < bb.lower[n - 2] && cl[n - 1] > bb.lower[n - 1]) return 'buy';
  if (cl[n - 2] > bb.upper[n - 2] && cl[n - 1] < bb.upper[n - 1]) return 'sell';
  return 'none';
}

// เปอร์เซ็นไทล์ของ ATR ปัจจุบันเทียบประวัติ (ฝ่ายสภาพตลาดใช้)
function atrPercentile(candles, n = 200) {
  const arr = ind.atr(candles, 14).filter(Number.isFinite);
  if (arr.length < 30) return null;
  const seg = arr.slice(-n);
  const cur = seg[seg.length - 1];
  const below = seg.filter((v) => v <= cur).length;
  return { pct: Math.round((below / seg.length) * 100), cur };
}

const sideTh = (s) => (s === 'buy' ? 'ซื้อ' : 'ขาย');
const opp = (s) => (s === 'buy' ? 'sell' : 'buy');

// ---------- เอเจนต์ 7 คน ----------
const AGENTS = [
  {
    id: 'trend', name: 'เอเจนต์เทรนด์', weight: 1.2,
    specialty: 'เทรนด์ที่เทรดได้จริง: EMA H1+M15 ทางเดียวกัน และโครงสร้าง M15 ยืนยัน — วัดความสะอาดเทรนด์ด้วย Efficiency Ratio',
    analyze(ctx) {
      const a = ctx.analysis;
      const m15 = a.tf && a.tf.M15, h1 = a.tf && a.tf.H1;
      if (!m15 || !h1 || !ctx.candles.M15 || ctx.candles.M15.length < 60) return { side: 'none', conf: 0, reason: 'ยังไม่มีข้อมูลสองไทม์เฟรม' };
      const dirH1 = h1.ema20 > h1.ema50 ? 'buy' : 'sell';
      const dirM15 = m15.ema20 > m15.ema50 ? 'buy' : 'sell';
      if (dirH1 !== dirM15) return { side: 'none', conf: 0, reason: `EMA H1 ชี้${sideTh(dirH1)} แต่ M15 ชี้${sideTh(dirM15)} — ยังไม่ใช่เทรนด์ที่เทรดได้` };
      const st = structureState(ctx.candles.M15.slice(-150));
      if (!st || st.dir !== dirM15) return { side: 'none', conf: 0, reason: `EMA ชี้${sideTh(dirM15)} แต่โครงสร้าง M15 ยังไม่ยืนยัน — ไม่ไล่ (วัดแล้ว EMA อย่างเดียวไม่มีความได้เปรียบ)` };
      const er = efficiencyRatio(ctx.candles.M15, 20) || 0;
      const stH1 = structureState((ctx.candles.H1 || []).slice(-120));
      let conf = 56 + Math.min(8, er * 16) + (stH1 && stH1.dir === dirM15 ? 4 : 0);
      const stretch = ((ctx.price - m15.ema20) / (m15.atr || 1)) * (dirM15 === 'buy' ? 1 : -1);
      const out = { side: dirM15, conf: 0, reason: '' };
      if (stretch > 2.5) {
        conf -= 8;
        out.cap = 60; out.capSide = dirM15;
        out.capReason = `ราคายืดห่าง EMA20 ${ind.round(stretch, 1)}×ATR — ปลายคลื่น อย่าไล่${sideTh(dirM15)}`;
      }
      out.conf = Math.min(70, conf);
      out.skillNote = er > 0.45 ? 'เทรนด์สะอาด (ER สูง) — ความได้เปรียบสูงสุดของสายนี้' : null;
      out.reason = `เทรนด์${dirM15 === 'buy' ? 'ขึ้น' : 'ลง'}ครบ 3 ชั้น: EMA H1+M15 + โครงสร้าง ${dirM15 === 'buy' ? 'HH+HL' : 'LH+LL'} (ER ${ind.round(er, 2)})`;
      return out;
    },
  },
  {
    id: 'momentum', name: 'เอเจนต์โมเมนตัม', weight: 0.7,
    specialty: 'อ่านความเร็วราคา: แรงวิ่งที่ยืดเกิน ATR มักคืนกำไร — ไม่ไล่แท่ง (ไล่โมเมนตัมวัดแล้วติดลบ)',
    analyze(ctx) {
      const c5 = ctx.candles.M5;
      const m5 = ctx.analysis.tf && ctx.analysis.tf.M5;
      if (!m5 || !c5 || c5.length < 40 || !m5.atr) return { side: 'none', conf: 0, reason: 'ข้อมูลไม่พอ' };
      const n = c5.length;
      const roc = c5[n - 1].c - c5[n - 9].c;
      const k = Math.abs(roc) / m5.atr;
      if (k < 1.0) return { side: 'none', conf: 0, reason: `ความเร็วปกติ (${ind.round(k, 2)}×ATR ใน 40 นาที)` };
      const b1 = c5[n - 1], b2 = c5[n - 2];
      const decel = Math.abs(b1.c - b1.o) < Math.abs(b2.c - b2.o) * 0.6;
      const side = roc > 0 ? 'sell' : 'buy';
      return {
        side, conf: Math.min(60, 52 + (decel ? 4 : 0) + Math.min(4, (k - 1) * 4)),
        skillNote: decel ? 'แท่งล่าสุดเล็กลง = แรงเริ่มเบรก' : null,
        reason: `ราคา${roc > 0 ? 'พุ่ง' : 'ดิ่ง'} ${ind.round(k, 1)}×ATR ใน 40 นาที${decel ? ' และเริ่มเบรก' : ''} — มักคืนกำไรบางส่วน`,
      };
    },
  },
  {
    id: 'reversion', name: 'เอเจนต์ดีดกลับ', weight: 1.4,
    specialty: 'จังหวะสวนที่วัดแล้วได้ผล: แท่งหลุดแบนด์แล้วกลับเข้า (M5) / %B M15 หลุดขอบ / RSI สุดขั้ว ในตลาดออกข้าง + สิทธิ์ยับยั้งการไล่ราคา',
    analyze(ctx) {
      const a = ctx.analysis, m5 = a.tf && a.tf.M5, m15 = a.tf && a.tf.M15;
      if (!m5 || !m15 || !ctx.candles.M5) return { side: 'none', conf: 0, reason: 'ข้อมูลไม่พอ' };
      const er = efficiencyRatio(ctx.candles.M15, 20);
      const ranging = er != null && er <= ER_RANGE;
      const st = structureState((ctx.candles.M15 || []).slice(-150));
      const re = bandReentry(ctx.candles.M5);
      if (re !== 'none') {
        const withSt = st && st.dir === re;
        return {
          side: re, conf: 74 + (withSt ? 6 : 0),
          skillNote: withSt ? 'สวนกลับเข้าแบนด์ตามทิศโครงสร้าง — ชุดที่แม่นที่สุดของสายนี้' : 'ราคาหลุดแบนด์แล้วถูกปฏิเสธ',
          reason: `แท่ง M5 ปิดหลุดขอบ${re === 'buy' ? 'ล่าง' : 'บน'} Bollinger แล้วปิดกลับเข้า — แรงยืดถูกปฏิเสธ${withSt ? ' (ตรงทิศโครงสร้าง M15)' : ''}`,
        };
      }
      const pb = bbPctB(a.price, m15.bb);
      if (ranging && (pb < 0 || pb > 1)) {
        const side = pb < 0 ? 'buy' : 'sell';
        return { side, conf: 66, skillNote: 'ตลาดออกข้าง + หลุดขอบแบนด์ M15', reason: `ตลาดแกว่งในกรอบ (ER ${ind.round(er, 2)}) และราคาหลุดขอบ${side === 'buy' ? 'ล่าง' : 'บน'} M15 (%B ${ind.round(pb, 2)})` };
      }
      if (ranging && (m5.rsi < 30 || m5.rsi > 70)) {
        const side = m5.rsi < 30 ? 'buy' : 'sell';
        return { side, conf: 62, reason: `ตลาดออกข้าง (ER ${ind.round(er, 2)}) + RSI M5 ${ind.round(m5.rsi, 1)} สุดขั้ว` };
      }
      const out = { side: 'none', conf: 0, reason: ranging ? 'ตลาดออกข้างแต่ราคายังไม่ยืดถึงขอบ' : `ตลาดวิ่งทางเดียว (ER ${er != null ? ind.round(er, 2) : '-'}) — ยังไม่ใช่จังหวะสวน` };
      if (a.bias === 'bull' && m5.rsi > 78) { out.cap = 58; out.capSide = 'buy'; out.capReason = `RSI ${ind.round(m5.rsi, 1)} ยืดมากบนเทรนด์ขึ้น — รอย่อก่อน อย่าไล่ซื้อ`; }
      if (a.bias === 'bear' && m5.rsi < 22) { out.cap = 58; out.capSide = 'sell'; out.capReason = `RSI ${ind.round(m5.rsi, 1)} ยืดมากบนเทรนด์ลง — รอเด้งก่อน อย่าไล่ขาย`; }
      return out;
    },
  },
  {
    id: 'structure', name: 'เอเจนต์โครงสร้างแท่ง', weight: 1.3,
    specialty: 'Market Structure M15: บันได HH+HL / LH+LL และจับการทะลุหลอก (ทะลุสวนโครงแล้วมักกลับ — การไล่ CHoCH วัดแล้วติดลบ)',
    analyze(ctx) {
      const c15 = ctx.candles.M15;
      if (!c15 || c15.length < 60) return { side: 'none', conf: 0, reason: 'ข้อมูล M15 ไม่พอ' };
      const st = structureState(c15.slice(-150));
      if (!st) return { side: 'none', conf: 0, reason: 'ยังไม่มีจุดกลับตัวพอ' };
      if (st.dir === 'none') return { side: 'none', conf: 0, reason: 'โครงสลับ (ไม่เป็นบันได) — รอให้โครงชัด' };
      const px = ctx.price;
      const fake = st.dir === 'sell' ? px > st.lastH : px < st.lastL;
      const stH1 = structureState((ctx.candles.H1 || []).slice(-120));
      const h1Agree = stH1 && stH1.dir === st.dir;
      if (fake) {
        return {
          side: st.dir, conf: 64 + (h1Agree ? 4 : 0),
          skillNote: 'ทะลุสวนโครงสร้าง = มักเป็นการกวาด stop แล้วกลับ',
          reason: `โครงยัง${st.dir === 'buy' ? 'ขึ้น (HH+HL)' : 'ลง (LH+LL)'} แต่ราคาทะลุ${st.dir === 'buy' ? 'จุดต่ำ' : 'จุดสูง'}ล่าสุดสวนทาง — คาดทะลุหลอกแล้วกลับ`,
        };
      }
      return {
        side: st.dir, conf: 58 + (h1Agree ? 5 : 0),
        skillNote: h1Agree ? 'โครง M15 ตรงกับ H1' : null,
        reason: `บันได${st.dir === 'buy' ? 'ขึ้น HH+HL' : 'ลง LH+LL'} บน M15${h1Agree ? ' + H1 ทางเดียวกัน' : ''}`,
      };
    },
  },
  {
    id: 'regime', name: 'เอเจนต์สภาพตลาด', weight: 0.8,
    specialty: 'จัดระบอบตลาด (วิ่งทางเดียว vs ออกข้าง ด้วย ER + ความผันผวนด้วยเปอร์เซ็นไทล์ ATR) แล้วสั่งปรับน้ำหนักเพื่อนให้ตรงสนาม',
    analyze(ctx) {
      const c15 = ctx.candles.M15;
      if (!c15 || c15.length < 90) return { side: 'none', conf: 0, reason: 'ยังไม่มีค่าผันผวนพอ' };
      const ap = atrPercentile(c15, 200);
      if (!ap) return { side: 'none', conf: 0, reason: 'ประวัติผันผวนยังน้อย' };
      if (ap.pct <= 15) return { side: 'none', conf: 0, cap: 48, capBoth: true, reason: `ตลาดเงียบผิดปกติ (ATR ต่ำกว่า ${100 - ap.pct}% ของ 200 แท่ง) — สเปรดกินกำไร หลอนง่าย` };
      const er = efficiencyRatio(c15, 20) || 0;
      const trending = er > ER_RANGE;
      const adjust = trending
        ? { trend: 1.25, structure: 1.1, reversion: 0.8, momentum: 0.8 }
        : { reversion: 1.25, momentum: 1.15, trend: 0.8 };
      if (ap.pct < 50) adjust.structure = (adjust.structure || 1) * 1.1; // โครงสร้างแม่นขึ้นตอนผันผวนต่ำ
      const out = {
        side: 'none', conf: 0, adjust,
        reason: `${trending ? 'ตลาดวิ่งทางเดียว' : 'ตลาดออกข้าง'} (ER ${ind.round(er, 2)}) • ATR ${ap.pct} เปอร์เซ็นไทล์ — ${trending ? 'ดันน้ำหนักเทรนด์/โครงสร้าง' : 'ดันน้ำหนักดีดกลับ'}`,
      };
      if (ap.pct >= 88) { out.cap = 55; out.capBoth = true; out.capReason = `ผันผวนสูงมาก (ATR ${ap.pct} เปอร์เซ็นไทล์) — ลดความมั่นใจ ล็อตเท่าเดิมเสี่ยงเท่าเดิมแต่สวิงหลอนกว่า`; }
      return out;
    },
  },
  {
    id: 'session', name: 'เอเจนต์ช่วงเวลา', weight: 0.7,
    specialty: 'รู้ว่าแต่ละเซสชันเล่นแบบไหนได้ผล: ลอนดอนวิ่งทางเดียว (งดสวน) • ทับ NY ใช้ได้ทุกสาย • ดึก/บ่าย NY โครงสร้างหลอก',
    analyze(ctx) {
      const now = ctx.now || Date.now();
      const s = sessions.evaluate(now);
      if (s.closed) return { side: 'none', conf: 0, cap: 45, capBoth: true, reason: 'ตลาดปิดสุดสัปดาห์' };
      const playbook = {
        london: { adjust: { reversion: 0.5, momentum: 0.6, structure: 1.15 }, note: 'ลอนดอนมักวิ่งทางเดียว — ลดน้ำหนักสายสวน เพิ่มโครงสร้าง' },
        overlap: { adjust: { reversion: 1.1, structure: 1.1 }, note: 'ช่วงทับลอนดอน+NY — ทุกสายใช้ได้' },
        'ny-afternoon': { adjust: { structure: 0.6 }, note: 'บ่าย NY โครงสร้างหลอกบ่อย — ลดน้ำหนักโครงสร้าง' },
        'asia-evening': { adjust: { structure: 0.6 }, note: 'ช่วงเงียบ — โครงสร้างหลอกบ่อย' },
      }[s.id];
      const out = { side: 'none', conf: 0, adjust: playbook ? playbook.adjust : undefined };
      if (s.quality === 'avoid') { out.cap = 72; out.capBoth = true; out.capReason = `${s.label}: ${s.riskNote || 'ช่วงเวลาไม่แนะนำ'}`; }
      // ชั่วโมงแรกหลังเปิดตามเวลาท้องถิ่นจริง (รองรับเวลาออมแสง)
      if (minutesSinceLocal(now, 'Europe/London', 8, 0) < 60) { out.cap = 60; out.capBoth = true; out.capReason = 'ลอนดอนเพิ่งเปิด 1 ชม. — แรงแรกเปิดเสี่ยงหลอก (รอให้ตั้งตัว)'; }
      else if (minutesSinceLocal(now, 'America/New_York', 9, 30) < 60) { out.cap = 64; out.capBoth = true; out.capReason = 'ชั่วโมงแรกตลาดหุ้น NY เปิด (09:30 นิวยอร์ก) — ราคาสวิงแรง'; }
      out.reason = `${s.label}: ${playbook ? playbook.note : `สภาพคล่องตามเซสชัน (คุณภาพ ${s.quality})`}`;
      return out;
    },
  },
  {
    id: 'confluence', name: 'เอเจนต์ระดับราคา', weight: 0.9,
    specialty: 'อ่านแนวรับ/ต้าน M15+H1: วัดแล้วแนวที่ราคากดชนในระยะ 0.5×ATR มักถูกเจาะ — มติที่วิ่งชนแนวใกล้จึงได้แรงเสริม (ไม่ใช่ห้ามไล่แบบเดิม)',
    analyze(ctx) {
      const a = ctx.analysis, m15 = a.tf && a.tf.M15;
      if (!m15 || !Number.isFinite(m15.atr) || !ctx.price) return { side: 'none', conf: 0, reason: 'ข้อมูลไม่พอ' };
      const atr = m15.atr, px = ctx.price;
      const sup = (a.levels.supports || [])[0], res = (a.levels.resistances || [])[0];
      const fmt = (x) => ind.round(x, 2);
      const boost = [];
      if (res && res - px < atr * 0.5) boost.push({ side: 'buy', by: 6, reason: `แรงซื้อกดชนแนวต้าน ${fmt(res)} (ห่าง ${ind.round((res - px) / atr, 2)}×ATR) — แนวใกล้แบบนี้มักแตก` });
      if (sup && px - sup < atr * 0.5) boost.push({ side: 'sell', by: 6, reason: `แรงขายกดชนแนวรับ ${fmt(sup)} (ห่าง ${ind.round((px - sup) / atr, 2)}×ATR) — แนวใกล้แบบนี้มักแตก` });
      const parts = [];
      if (sup) parts.push(`รับ ${fmt(sup)} (${ind.round((px - sup) / atr, 1)}×ATR)`);
      if (res) parts.push(`ต้าน ${fmt(res)} (${ind.round((res - px) / atr, 1)}×ATR)`);
      return { side: 'none', conf: 0, boost, reason: parts.length ? parts.join(' • ') : 'ไม่มีระดับราคาใกล้ตัว' };
    },
  },
];

// นาทีที่ผ่านไปนับจากเวลาเปิด (h:m) ตามเวลาท้องถิ่นของ timeZone วันเดียวกัน — ยังไม่ถึง/ข้ามวัน = Infinity
function minutesSinceLocal(now, timeZone, h, m) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const diff = get('hour') * 60 + get('minute') - (h * 60 + m);
  return diff >= 0 ? diff : Infinity;
}

// ---------- ประธานสภา (น้ำหนัก × สกิลของเอเจนต์เอง) ----------
function runCouncil(ctx, settings = {}) {
  // สวิตช์เปิด/ปิดรายเอเจนต์: settings.councilAgents = { id: true|false } — ค่าที่ไม่ได้พูดถึง = เปิด
  const agentSwitch = settings.councilAgents && typeof settings.councilAgents === 'object' ? settings.councilAgents : {};
  const enabledCount = AGENTS.filter((a) => agentSwitch[a.id] !== false).length;
  // คิวรัมยึดตามตั้งค่า — แต่ถ้าเปิดเอเจนต์น้อยกว่าโควตา ลดลงเท่าจำนวนที่เปิด (อย่างน้อย 1 คน จึงออกมติได้)
  const quorumNeed = Math.max(1, Math.min(Math.max(2, Math.min(6, Number(settings.councilQuorum) || 3)), Math.max(1, enabledCount)));
  const skills = ctx.skills || {};
  const votes = [];
  for (const agent of AGENTS) {
    if (agentSwitch[agent.id] === false) {
      // ปิดอยู่: ไม่วิเคราะห์ ไม่โหวต ไม่มี cap/boost/adjust — คงแถวไว้ให้ UI โชว์สวิตช์
      votes.push({ id: agent.id, name: agent.name, weight: agent.weight, off: true, side: 'none', conf: 0, reason: 'ปิดอยู่ (สวิตช์รายเอเจนต์)', skillFactor: 1, skillGrade: 'ปิด', skillHit: null, skillN: 0 });
      continue;
    }
    let v;
    try { v = agent.analyze(ctx); }
    catch (e) { v = { side: 'none', conf: 0, reason: 'เอเจนต์พัง: ' + e.message }; }
    const sk = skills[agent.id] || { n: 0, hit: null, grade: 'ใหม่', factor: 1 };
    votes.push({
      id: agent.id, name: agent.name,
      weight: agent.weight, skillFactor: sk.factor,
      skillGrade: sk.grade, skillHit: sk.hit, skillN: sk.n,
      ...v,
      off: false,
    });
  }
  // ตัวปรับน้ำหนักจากฝ่ายบริบท (สภาพตลาด/ช่วงเวลา) — คูณกันเมื่อหลายคนสั่ง
  const adjust = {};
  for (const v of votes) {
    if (!v.adjust || typeof v.adjust !== 'object') continue;
    for (const [id, f] of Object.entries(v.adjust)) if (Number.isFinite(f) && f > 0) adjust[id] = (adjust[id] || 1) * f;
  }
  // น้ำหนักจริง = ฐาน × ผลงานตัวเอง (0.6-1.5) × ตัวปรับตามสนาม
  const effWeight = (v) => v.weight * (Number.isFinite(v.skillFactor) ? v.skillFactor : 1) * (adjust[v.id] || 1);
  const dir = votes.filter((v) => v.side === 'buy' || v.side === 'sell');
  let verdict = { side: 'none', confidence: 0, net: 0, agree: 0, quorumNeed };
  if (dir.length) {
    const wSum = dir.reduce((s, v) => s + effWeight(v), 0);
    const net = dir.reduce((s, v) => s + effWeight(v) * (v.side === 'buy' ? 1 : -1) * (v.conf || 0), 0) / wSum;
    let side = net >= NET_THRESHOLD ? 'buy' : net <= -NET_THRESHOLD ? 'sell' : 'none';
    let agree = side === 'none' ? 0 : votes.filter((v) => v.side === side).length;
    if (side !== 'none' && agree < quorumNeed) side = 'none';
    if (side !== 'none') {
      const agreeBonus = Math.min(12, Math.max(0, agree - 2) * 4);
      verdict = { side, confidence: Math.min(95, Math.round(Math.abs(net)) + agreeBonus), net: Math.round(net, 1), agree, quorumNeed };
    } else {
      verdict = { side: 'none', confidence: Math.min(70, Math.round(Math.abs(net))), net: Math.round(net, 1), agree: dir.length, quorumNeed };
    }
  }
  // แรงเสริมจากบริบท (เช่น มติวิ่งชนแนวใกล้ที่มักแตก) — ใช้ก่อนเพดาน เพดานยังเป็นคำขาด
  const boosts = [];
  if (verdict.side !== 'none') {
    for (const v of votes) {
      for (const b of Array.isArray(v.boost) ? v.boost : []) {
        if (b && b.side === verdict.side && Number.isFinite(b.by)) { verdict.confidence = Math.min(95, verdict.confidence + b.by); boosts.push(b.reason); }
      }
    }
  }
  verdict.boosts = boosts;
  // สิทธิ์ยับยั้ง/เพดาน
  const caps = [];
  for (const v of votes) {
    if (v.cap == null) continue;
    if ((v.capBoth || v.side === verdict.side || v.capSide === verdict.side) && verdict.side !== 'none') {
      verdict.confidence = Math.min(verdict.confidence, v.cap);
      caps.push(v.capReason || v.reason);
    } else if ((v.capBoth || v.reason) && verdict.side === 'none') {
      caps.push(v.capReason || v.reason);
    }
  }
  verdict.caps = caps;
  // ปรับความมั่นใจด้วยสถิติผลจริงของสภา (council-stats): ช่วงความมั่นใจไหนแม่นจริง = เชื่อหนักขึ้น / แม่นต่ำ = ลดลง
  const cal = ctx.councilCal && ctx.councilCal.calibration ? ctx.councilCal.calibration(verdict.confidence) : null;
  if (cal && verdict.side !== 'none' && cal.factor !== 1 && Number.isFinite(cal.factor)) {
    const before = verdict.confidence;
    verdict.confidence = Math.max(0, Math.min(95, Math.round(verdict.confidence * cal.factor)));
    verdict.calibrated = { before, factor: cal.factor, note: cal.note };
  }
  verdict.adjust = adjust;
  verdict.votes = votes.map(({ id, name, side, conf, reason, skillNote, skillGrade, skillHit, skillN, off }) => ({
    id, name, side, conf: Math.round(conf || 0), reason: String(reason || ''), skillNote: skillNote || null, off: !!off,
    skill: { grade: skillGrade, hit: skillHit, n: skillN },
    weightAdj: adjust[id] ? Math.round(adjust[id] * 100) / 100 : 1,
  }));
  return verdict;
}

// ---------- ด่านตรวจสัญญาณผ่านมติสภา (เหมือนเดิม) ----------
function gateSignal(sig, verdict, settings = {}) {
  const enabled = settings.councilEnabled !== false;
  const strict = enabled && settings.councilStrict !== false;
  if (!enabled) return { ok: true, info: { councilConf: 0, note: 'ทีมเอเจนต์ถูกปิด' } };
  if (!verdict || verdict.side === 'none') {
    if (strict) return { ok: false, reason: `โหมดเข้ม — ทีมเอเจนต์ยังไม่มีมติชัดพอ (ต้องเห็นพ้อง ≥ ${settings.councilQuorum || 3} คน จึงอนุญาต)` };
    return { ok: true, info: { councilConf: verdict ? Math.max(0, verdict.confidence) : 0, note: 'สภายังไม่มีมติชัด' } };
  }
  if (sig.side === verdict.side) return { ok: true, info: { councilConf: verdict.confidence, note: `สภาเห็นด้วย ${verdict.agree}/${verdict.quorumNeed}+ เอเจนต์` } };
  if (verdict.confidence >= OPPOSING_FILTER_CONF) return { ok: false, reason: `ทีมเอเจนต์ยับไปอีกฝั่ง (${verdict.agree} เอเจนต์โหวต${verdict.side === 'buy' ? 'ซื้อ' : 'ขาย'} มั่นใจ ${verdict.confidence}%)` };
  if (strict) return { ok: false, reason: `โหมดเข้ม — สภาค่อนไปอีกฝั่ง (${verdict.confidence}%) จึงไม่อนุญาต` };
  return { ok: true, info: { councilConf: verdict.confidence, note: 'สภาค่อนข้างเชียร์อีกฝั่งแต่ไม่แน่นพอที่จะยับ' } };
}

module.exports = { AGENTS, runCouncil, gateSignal, OPPOSING_FILTER_CONF, NET_THRESHOLD, efficiencyRatio, structureState, bandReentry };
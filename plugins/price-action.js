'use strict';

// ============================================================
// กลยุทธ์: อ่านกราฟแบบเทรดเดอร์ (Price Action) — กฎชุดเดียวที่ใช้ร่วม:
//   แอป (plugin นี้) • scripts/chart-read.js (skill gold-chart-trader ของ Claude) • backtest
// ขั้นตอน: เทรนด์ H1 → เทรนด์ M15 → แนวรับ/ต้านจาก swing H1+M15 (รวมระดับใกล้กัน นับครั้งที่แตะ)
//          → แท่ง M15 ที่ปิดแล้วล่าสุด: pin bar / engulfing ที่แนว → แผน เข้า/SL/TP
// ใช้เฉพาะแท่งที่ปิดแล้ว (แท่งสุดท้ายของแต่ละไทม์เฟรมคือแท่งที่กำลังก่อตัว) — ไม่มี lookahead
// กฎอยู่ในไฟล์นี้ทั้งหมด: แอปที่ build แล้ววางโฟลเดอร์ plugins ไว้นอก app.asar จึง require โค้ดใน src ไม่ได้
//   → รับ ind (ตัวชี้วัด) จากผู้เรียกแทน
// ============================================================

function rules(ind) {
  const trendOf = (candles) => {
    if (!candles || candles.length < 60) return 'unknown';
    const cl = ind.closes(candles);
    const e20 = ind.lastNum(ind.ema(cl, 20)), e50 = ind.lastNum(ind.ema(cl, 50)), c = cl[cl.length - 1];
    if (!Number.isFinite(e20) || !Number.isFinite(e50)) return 'unknown';
    if (c > e20 && e20 > e50) return 'up';
    if (c < e20 && e20 < e50) return 'down';
    return 'side';
  };

  // แนวรับ/ต้าน: swing H1 (น้ำหนัก 2) + M15 (น้ำหนัก 1) รวมระดับที่ห่างกัน ≤ 0.35×ATR(M15)
  function keyLevels(tfs, price, atr) {
    const pts = [];
    for (const [k, w] of [['H1', 2], ['M15', 1]]) {
      const c = tfs[k];
      if (!c || c.length < 20) continue;
      const s = ind.swings(c.slice(-160, -1), 3);
      for (const v of [...s.highs, ...s.lows]) pts.push({ v, w });
    }
    pts.sort((a, b) => a.v - b.v);
    const tol = 0.35 * atr, levels = [];
    for (const p of pts) {
      const last = levels[levels.length - 1];
      // เทียบค่ากลางกลุ่ม (ไม่ต่อโซ่จนกลุ่มกว้างเกิน)
      if (last && p.v - last.sum / last.wt <= tol) { last.sum += p.v * p.w; last.wt += p.w; last.hi = p.v; last.touches++; }
      else levels.push({ sum: p.v * p.w, wt: p.w, hi: p.v, touches: 1 });
    }
    const out = levels.map((l) => ({ price: ind.round(l.sum / l.wt, 2), strength: l.wt, touches: l.touches }));
    return {
      supports: out.filter((l) => l.price < price).sort((a, b) => b.price - a.price).slice(0, 4),
      resistances: out.filter((l) => l.price > price).sort((a, b) => a.price - b.price).slice(0, 4),
      all: out,
    };
  }

  // รูปแท่งของแท่งที่ปิดแล้ว b (prev = แท่งก่อนหน้า)
  function candlePattern(b, prev) {
    const range = b.h - b.l;
    if (!(range > 0)) return { name: 'doji', side: 'none' };
    const body = Math.abs(b.c - b.o), up = b.h - Math.max(b.o, b.c), dn = Math.min(b.o, b.c) - b.l;
    if (dn >= 2 * body && dn >= 0.55 * range) return { name: 'pin bar ขาขึ้น (ไส้ล่างยาว)', side: 'buy', wickEnd: b.l };
    if (up >= 2 * body && up >= 0.55 * range) return { name: 'pin bar ขาลง (ไส้บนยาว)', side: 'sell', wickEnd: b.h };
    if (prev) {
      const pb = Math.abs(prev.c - prev.o);
      if (b.c > b.o && prev.c < prev.o && b.c >= prev.o && b.o <= prev.c && body > pb) return { name: 'bullish engulfing', side: 'buy', wickEnd: Math.min(b.l, prev.l) };
      if (b.c < b.o && prev.c > prev.o && b.c <= prev.o && b.o >= prev.c && body > pb) return { name: 'bearish engulfing', side: 'sell', wickEnd: Math.max(b.h, prev.h) };
      if (b.h <= prev.h && b.l >= prev.l) return { name: 'inside bar', side: 'none' };
    }
    if (body / range < 0.15) return { name: 'doji', side: 'none' };
    return { name: b.c > b.o ? 'แท่งเขียวธรรมดา' : 'แท่งแดงธรรมดา', side: 'none' };
  }

  // อ่านกราฟทั้งชุด → ข้อมูลสรุป (ใช้แสดงผล/ตัดสินใจ)
  function readChart(tfs, price) {
    const m15 = tfs.M15, m5 = tfs.M5;
    if (!m15 || m15.length < 60 || !Number.isFinite(price)) return null;
    const atr = ind.lastNum(ind.atr(m15.slice(0, -1), 14));
    if (!(atr > 0)) return null;
    const closed = m15[m15.length - 2], prev = m15[m15.length - 3];
    const rsi = ind.lastNum(ind.rsi(ind.closes(m15.slice(0, -1)), 14));
    const lv = keyLevels(tfs, price, atr);
    const pat = candlePattern(closed, prev);
    // แนวที่แท่งปิดล่าสุดไปแตะ (ไส้ถึงแนว ≤ 0.3×ATR)
    const near = (side) => lv.all
      .filter((l) => (side === 'buy' ? Math.abs(closed.l - l.price) <= 0.3 * atr && closed.c > l.price : Math.abs(closed.h - l.price) <= 0.3 * atr && closed.c < l.price))
      .sort((a, b) => b.strength - a.strength)[0] || null;
    return {
      price, atr: ind.round(atr, 2), rsiM15: Number.isFinite(rsi) ? ind.round(rsi, 1) : null,
      trend: { H1: trendOf(tfs.H1), M15: trendOf(m15), M5: trendOf(m5) },
      levels: { supports: lv.supports, resistances: lv.resistances },
      lastClosedM15: { t: closed.t, o: closed.o, h: closed.h, l: closed.l, c: closed.c, pattern: pat.name, patternSide: pat.side },
      touched: pat.side === 'none' ? null : near(pat.side),
      _pat: pat, _lv: lv,
    };
  }

  // กฎเข้าไม้: ทิศตามเทรนด์ H1 (M15 ไม่สวน) + รูปแท่งกลับตัวทิศเดียวกันที่แนว (แตะ ≥ 2 ครั้ง หรือแนว H1)
  // SL = เลยปลายไส้ 0.25×ATR • TP = แนวฝั่งตรงข้ามถัดไป (ต้อง RR ≥ 1.5) ไม่มีแนว = 2R
  function planTrade(chart, { minRR = 1.5 } = {}) {
    if (!chart) return { side: 'none', why: 'ข้อมูลไม่พอ' };
    const { trend, _pat: pat, touched, atr, price } = chart;
    const dir = trend.H1 === 'up' ? 'buy' : trend.H1 === 'down' ? 'sell' : null;
    if (!dir) return { side: 'none', why: `H1 ไม่มีเทรนด์ชัด (${trend.H1}) — ไม่เทรด` };
    if ((dir === 'buy' && trend.M15 === 'down') || (dir === 'sell' && trend.M15 === 'up')) return { side: 'none', why: `M15 สวน H1 (${trend.M15}) — รอ` };
    if (pat.side !== dir) return { side: 'none', why: `รอแท่งกลับตัวฝั่ง${dir === 'buy' ? 'ซื้อ' : 'ขาย'}ที่แนว (แท่งล่าสุด: ${pat.name})` };
    if (!touched || !(touched.touches >= 2 || touched.strength >= 2)) return { side: 'none', why: `${pat.name} แต่ไม่ได้อยู่ที่แนวสำคัญ — ข้าม` };
    const sl = ind.round(dir === 'buy' ? pat.wickEnd - 0.25 * atr : pat.wickEnd + 0.25 * atr, 2);
    const risk = Math.abs(price - sl);
    if (!(risk > 0.3 * atr) || risk > 3 * atr) return { side: 'none', why: 'ระยะ SL ไม่เหมาะ (แคบ/กว้างเกิน)' };
    const opp = (dir === 'buy' ? chart.levels.resistances : chart.levels.supports).find((l) => Math.abs(l.price - price) >= minRR * risk);
    const tp = ind.round(opp ? opp.price : dir === 'buy' ? price + 2 * risk : price - 2 * risk, 2);
    const rr = ind.round(Math.abs(tp - price) / risk, 2);
    const conf = Math.min(85, 60 + (touched.strength >= 2 ? 8 : 0) + Math.min(3, touched.touches) * 3 + (trend.M15 === trend.H1 ? 5 : 0));
    return {
      side: dir, entry: ind.round(price, 2), sl, tp, rr, confidence: conf,
      why: `H1 ${trend.H1} • M15 ${trend.M15} • ${pat.name} ที่แนว ${touched.price} (แตะ ${touched.touches} ครั้ง) • TP ${opp ? 'แนวถัดไป' : '2R'} RR ${rr}`,
    };
  }

  return { readChart, planTrade, candlePattern, keyLevels, trendOf };
}

module.exports = {
  id: 'price-action',
  name: 'อ่านกราฟ Price Action',
  description: 'ตามเทรนด์ H1 • รอแท่ง M15 กลับตัว (pin bar / engulfing) ที่แนวรับ-ต้านที่แตะหลายครั้ง • SL เลยไส้ • TP แนวถัดไป',
  rules,

  strategy({ candles, price, ind }) {
    const pa = rules(ind);
    const plan = pa.planTrade(pa.readChart(candles || {}, price));
    if (plan.side === 'none') return null;
    return { side: plan.side, entry: plan.entry, sl: plan.sl, tp: plan.tp, confidence: plan.confidence, reason: plan.why };
  },
};

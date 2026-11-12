'use strict';

// กลยุทธ์ 2: บีบแบนด์แล้วทะลุ (Bollinger Squeeze Breakout)
// M15 บีบแบนด์แคบ (เปอร์เซ็นไทล์ bandwidth < 30) แล้ว M5 ปิดทะลุขอบ
// ทิศทางต้องไม่สวนเทรนด์ H1 — สัญญาณออกตอนแตกเท่านั้น ไม่เดาล่วงหน้า

module.exports = {
  id: 'bb-squeeze-breakout',
  name: 'บีบแบนด์ทะลุ (Squeeze Breakout)',
  description: 'แบนด์บีบตัวแคบมากบน M15 แล้วราคาปิดทะลุขอบบน/ล่างบน M5 เข้าตามแรงแตก พร้อม SL ที่ขอบตรงข้าม',

  strategy({ analysis, candles, price, ind, settings, digits }) {
    if (!analysis || !price || !candles.M15 || candles.M15.length < 90 || !candles.M5 || candles.M5.length < 70) return null;
    // ระยะจุด SL/TP ที่ผู้ใช้ตั้ง = ใช้ก่อนเสมอ (เท่ากัน/ต่างกันได้)
    const pt = Math.pow(10, -(Number(digits ?? (settings && settings.digits)) || 2));
    const userSl = Number(settings && settings.slDistPts) > 0 ? Number(settings.slDistPts) * pt : null;
    const userTp = Number(settings && settings.tpDistPts) > 0 ? Number(settings.tpDistPts) * pt : null;

    const cl15 = ind.closes(candles.M15);
    const bb = ind.bollinger(cl15, 20, 2);
    const bw = ind.lastNum(bb.bw);
    const bwPct = ind.bandwidthPercentile(bb.bw, 100);
    const mid = ind.lastNum(bb.mid), up = ind.lastNum(bb.upper), lo = ind.lastNum(bb.lower);
    const cl5 = ind.closes(candles.M5);
    const last5 = cl5[cl5.length - 1];
    const atrV = ind.lastNum(ind.atr(candles.M5, 14));
    if (!Number.isFinite(mid) || !Number.isFinite(up) || !Number.isFinite(lo) || !Number.isFinite(atrV)) return null;
    if (bwPct == null || bwPct > 30) {
      // เมื่อแบนด์กำลังบีบ → บอกระบบว่า "ใกล้มีโอกาส" ผ่าน reason แบบไม่ยิง (return null มี watch)
      if (bwPct != null && bwPct < 15 && analysis.tf && analysis.tf.M15 && analysis.tf.M15.squeeze) {
        return { side: 'buy', entry: up, sl: lo, tp: up + (up - lo) * 2, confidence: 0, reason: `แบนด์บีบตัวแคบมาก (bw ${ind.round(bw, 2)}% เปอร์เซ็นไทล์ ${ind.round(bwPct, 0)}) — เฝ้ารอการแตก อย่าเข้าก่อนปิดทะลุขอบ`, watchOnly: true };
      }
      return null;
    }

    const range = up - lo;
    if (range <= 0 || atrV <= 0) return null;
    let conf = 62;
    if (last5 > up && analysis.trendH1 !== 'down') {
      if (userSl != null) {
        const sl = price - userSl;
        const tp = userTp != null ? price + userTp : price + 1.8 * userSl;
        return { side: 'buy', entry: price, sl, tp, confidence: Math.min(conf, 90), distUser: true, reason: `แบนด์เพิ่งบีบตัว (เปอร์เซ็นไทล์ ${ind.round(bwPct, 0)}) แล้ว M5 ปิดทะลุขอบบน ${ind.round(up, 2)} • SL/TP ตามค่าตั้งจุด` };
      }
      const sl = mid - range * 0.15;
      if (price - sl < atrV) return null;
      const tp = price + 1.8 * (price - sl);
      if (analysis.bias === 'bull') conf += 12;
      if (bw < (bb.mid.filter(Number.isFinite).reduce((s, v) => s + v, 0) / Math.max(1, bb.mid.filter(Number.isFinite).length)) * 0.4) conf += 5;
      return { side: 'buy', entry: price, sl, tp, confidence: Math.min(conf, 90), reason: `แบนด์เพิ่งบีบตัว (เปอร์เซ็นไทล์ ${ind.round(bwPct, 0)}) แล้ว M5 ปิดทะลุขอบบน ${ind.round(up, 2)} — แรงแตกทิศเดียวกับเทรนด์` };
    }
    if (last5 < lo && analysis.trendH1 !== 'up') {
      if (userSl != null) {
        const sl = price + userSl;
        const tp = userTp != null ? price - userTp : price - 1.8 * userSl;
        return { side: 'sell', entry: price, sl, tp, confidence: Math.min(conf, 90), reason: `แบนด์เพิ่งบีบตัว (เปอร์เซ็นไทล์ ${ind.round(bwPct, 0)}) แล้ว M5 ปิดทะลุขอบล่าง ${ind.round(lo, 2)} • SL/TP ตามค่าตั้งจุด` };
      }
      const sl = mid + range * 0.15;
      if (sl - price < atrV) return null;
      const tp = price - 1.8 * (sl - price);
      if (analysis.bias === 'bear') conf += 12;
      return { side: 'sell', entry: price, sl, tp, confidence: Math.min(conf, 90), reason: `แบนด์เพิ่งบีบตัว (เปอร์เซ็นไทล์ ${ind.round(bwPct, 0)}) แล้ว M5 ปิดทะลุขอบล่าง ${ind.round(lo, 2)} — แรงแตกทิศเดียวกับเทรนด์` };
    }
    return null;
  },
};
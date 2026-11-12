'use strict';

// กลยุทธ์ 3: โมเมนตัมหักเข้าเทรนด์ (Momentum Ignition)
// M5: EMA9 ตัดขึ้น/ลง EMA21 ไหม่ใน 2 แท่งล่าสุด + แรงราคา + H1 ไม่สวน + ตลาดไม่เงียบ
// จับจังหวะที่เทรนด์ "เพิ่งเริ่ม" พร้อม SL หลังจุดตัด

module.exports = {
  id: 'momentum-ignition',
  name: 'โมเมนตัมหักเข้าเทรนด์ (Momentum Ignition)',
  description: 'EMA9 ตัด EMA21 ใหม่บน M5 พร้อมแท่งแรงและ H1 ไม่สวน เข้าตามทิศตัด SL หลังจุดตัด',

  strategy({ analysis, candles, price, ind, settings, digits }) {
    if (!analysis || !price || !candles.M5 || candles.M5.length < 70) return null;
    if (analysis.trendH1 === 'unknown') return null;
    const pt = Math.pow(10, -(Number(digits ?? (settings && settings.digits)) || 2));
    const userSl = Number(settings && settings.slDistPts) > 0 ? Number(settings.slDistPts) * pt : null;
    const userTp = Number(settings && settings.tpDistPts) > 0 ? Number(settings.tpDistPts) * pt : null;
    const cl = ind.closes(candles.M5);
    const e9 = ind.ema(cl, 9), e21 = ind.ema(cl, 21);
    const n = cl.length;
    const a = e9[n - 1], b = e21[n - 1];
    const a1 = e9[n - 2], b1 = e21[n - 2];
    const a2 = e9[n - 3], b2 = e21[n - 3];
    if (![a, b, a1, b1, a2, b2].every(Number.isFinite)) return null;
    const atrV = ind.lastNum(ind.atr(candles.M5, 14));
    if (!Number.isFinite(atrV) || atrV <= 0) return null;
    const atrPct = (atrV / price) * 100;
    if (atrPct < 0.04) return null; // ช่วงตลาดเข้าฝั่งเงียบมาก ไม่ทำ

    const crossedUp = a2 <= b2 && a1 <= b1 && a > b;
    const crossedDown = a2 >= b2 && a1 >= b1 && a < b;
    const last = candles.M5[candles.M5.length - 1];
    const body = Math.abs(last.c - last.o);

    if (crossedUp && analysis.trendH1 !== 'down' && last.c > b && body >= atrV * 0.45) {
      if (userSl != null) {
        const sl = price - userSl;
        const tp = userTp != null ? price + userTp : price + 1.8 * userSl;
        return { side: 'buy', entry: price, sl, tp, confidence: 68 + (analysis.bias === 'bull' ? 10 : 0), distUser: true, reason: 'EMA9 ตัดขึ้น EMA21 ใหม่ (M5) • SL/TP ตามค่าตั้งจุด' };
      }
      const sl = Math.min(b, last.l) - 1.2 * atrV;
      if (price - sl < atrV * 0.8) return null;
      const tp = price + 1.8 * (price - sl);
      let conf = 64 + (analysis.bias === 'bull' ? 10 : 0);
      if (body > atrV) conf += 6;
      return { side: 'buy', entry: price, sl, tp, confidence: Math.min(conf, 92), reason: `EMA9 ตัดขึ้น EMA21 ใหม่ (M5) แท่งแรงขนาด ${ind.round(body, 2)} ระดับราคา ${ind.round(price, 2)}` };
    }
    if (crossedDown && analysis.trendH1 !== 'up' && last.c < b && body >= atrV * 0.45) {
      if (userSl != null) {
        const sl = price + userSl;
        const tp = userTp != null ? price - userTp : price - 1.8 * userSl;
        return { side: 'sell', entry: price, sl, tp, confidence: 68 + (analysis.bias === 'bear' ? 10 : 0), reason: 'EMA9 ตัดลง EMA21 ใหม่ (M5) • SL/TP ตามค่าตั้งจุด' };
      }
      const sl = Math.max(b, last.h) + 1.2 * atrV;
      if (sl - price < atrV * 0.8) return null;
      const tp = price - 1.8 * (sl - price);
      let conf = 64 + (analysis.bias === 'bear' ? 10 : 0);
      if (body > atrV) conf += 6;
      return { side: 'sell', entry: price, sl, tp, confidence: Math.min(conf, 92), reason: `EMA9 ตัดลง EMA21 ใหม่ (M5) แท่งแรงขนาด ${ind.round(body, 2)} ระดับราคา ${ind.round(price, 2)}` };
    }
    return null;
  },
};
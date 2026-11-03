'use strict';

// กลยุทธ์ 1: ดีดกลับตามเทรนด์ (Pullback Trend)
// เทรนด์ขึ้น: H1 และ M15 อ้อนขึ้น → รอ M5 ดีดลงเข้า EMA20 + RSI เย็น → เข้า buy
// เทรนด์ลง: กลับข้างเงื่อนไขให้เป็น sell — ชอบเทรนด์มากกว่าเก็งขายบน

module.exports = {
  id: 'pullback-trend',
  name: 'ดีดกลับตามเทรนด์ (Pullback Trend)',
  description: 'รอราคาดีดเข้า EMA20 ฝั่ง M5 ในเทรนด์ที่ H1/M15 ตกลงกัน แล้วเข้าตามทิศเทรนด์ พร้อม SL หลังจังหวะดีด',

  strategy({ analysis, candles, price, ind }) {
    if (!analysis || analysis.bias === 'neutral' || !price) return null;
    if (!candles.M5 || candles.M5.length < 70) return null;
    const side = analysis.bias === 'bull' ? 'buy' : 'sell';
    const cl = ind.closes(candles.M5);
    const rsiV = ind.lastNum(ind.rsi(cl, 14));
    const e20 = ind.lastNum(ind.ema(cl, 20));
    const atrV = ind.lastNum(ind.atr(candles.M5, 14));
    const last = candles.M5[candles.M5.length - 1];
    if (!Number.isFinite(rsiV) || !Number.isFinite(e20) || !Number.isFinite(atrV) || atrV <= 0) return null;

    let conf = 60;
    if (side === 'buy') {
      if (analysis.trendM15 !== 'up') return null;
      const touched = last.c >= e20 && last.l <= e20 + atrV * 0.85; // ถือบน EMA20 + แท่งล่าสุดดีดลงใกล้พอ
      if (!touched || rsiV > 52) return null;
      if (rsiV < 34) conf += 12;
      else if (rsiV < 45) conf += 8;
      const entry = price;
      const sl = Math.min(last.l, e20) - 1.2 * atrV;
      if (entry - sl < atrV * 0.8) return null; // SL แคบไปเวอร์
      const tp = entry + 2 * (entry - sl);
      return { side: 'buy', entry, sl, tp, confidence: Math.min(conf + (analysis.trendH1 === 'up' ? 10 : 0), 92), reason: `เทรนด์ขึ้นชัด (H1:${analysis.trendH1}/M15:${analysis.trendM15}) ราคาดีดใกล้ EMA20 ระดับ ${ind.round(e20, 2)} RSI ${ind.round(rsiV, 1)}` };
    }
    // side === 'sell' — สมมาตร
    if (analysis.trendM15 !== 'down') return null;
    const touched = last.c <= e20 && last.h >= e20 - atrV * 0.85;
    if (!touched || rsiV < 48) return null;
    if (rsiV > 66) conf += 12;
    else if (rsiV > 55) conf += 8;
    const entry = price;
    const sl = Math.max(last.h, e20) + 1.2 * atrV;
    if (sl - entry < atrV * 0.8) return null;
    const tp = entry - 2 * (sl - entry);
    return { side: 'sell', entry, sl, tp, confidence: Math.min(conf + (analysis.trendH1 === 'down' ? 10 : 0), 92), reason: `เทรนด์ลงชัด (H1:${analysis.trendH1}/M15:${analysis.trendM15}) ราคาเด้งใกล้ EMA20 ระดับ ${ind.round(e20, 2)} RSI ${ind.round(rsiV, 1)}` };
  },
};
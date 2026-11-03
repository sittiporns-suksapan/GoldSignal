'use strict';

const ind = require('./indicators');

// วิเคราะห์ไทม์เฟรมเดียว → ตัวเลขที่ใช้ร่วมกันทั้งระบบ
function analyzeTimeframe(candles) {
  if (!Array.isArray(candles) || candles.length < 55) return null;
  const cl = ind.closes(candles);
  const ema20 = ind.lastNum(ind.ema(cl, 20));
  const ema50 = ind.lastNum(ind.ema(cl, 50));
  const ema20Prev = ind.lastNum(ind.ema(cl, 20).slice(0, -6)) ?? ema20;
  const rsiV = ind.lastNum(ind.rsi(cl, 14));
  const atrV = ind.lastNum(ind.atr(candles, 14));
  const bb = ind.bollinger(cl, 20, 2);
  const bbM = ind.lastNum(bb.mid), bbU = ind.lastNum(bb.upper), bbL = ind.lastNum(bb.lower);
  const bwPct = ind.bandwidthPercentile(bb.bw, 100);
  const close = cl[cl.length - 1];
  const atrPct = atrV ? (atrV / close) * 100 : null;
  // ทิศทาง: EMA20 เทียบ EMA50 + ความชันเทียบ ATR
  const slope = ema20 - ema20Prev;
  const slopeTh = atrV ? atrV * 0.15 : 0;
  let trend = 'flat';
  if (ema20 > ema50 && slope > slopeTh * 0.3) trend = 'up';
  else if (ema20 < ema50 && slope < -slopeTh * 0.3) trend = 'down';
  return {
    close, ema20, ema50, rsi: rsiV, atr: atrV, atrPct,
    bb: { mid: bbM, upper: bbU, lower: bbL },
    squeeze: bwPct != null && bwPct < 25, bwPct, trend,
    candles: candles.length,
  };
}

// วิเคราะห์หลายไทม์เฟรม (M1,M5,M15,H1) → ภาพรวมตลาด
function analyzeMarket(multiTf) {
  const tf = {};
  for (const key of ['H1', 'M15', 'M5', 'M1']) {
    const a = analyzeTimeframe(multiTf[key]);
    if (a) tf[key] = a;
  }
  const h1 = tf.H1, m15 = tf.M15, m5 = tf.M5;
  let bias = 'neutral';
  if (h1 && m15) {
    if (h1.trend === 'up' && m15.trend !== 'down') bias = 'bull';
    else if (h1.trend === 'down' && m15.trend !== 'up') bias = 'bear';
  } else if (m15) {
    bias = m15.trend === 'up' ? 'bull' : m15.trend === 'down' ? 'bear' : 'neutral';
  }
  // แนวรับ/แนวต้านจากจุดกวีนดั่ง ใกล้ราคาปัจจุบัน
  const price = m5 ? m5.close : h1 ? h1.close : null;
  const levels = { supports: [], resistances: [] };
  if (price != null) {
    const sw = [];
    for (const key of ['M15', 'H1']) {
      if (!multiTf[key]) continue;
      const s = ind.swings(multiTf[key], 3);
      for (const h of s.highs) sw.push({ price: h, type: 'r' });
      for (const l of s.lows) sw.push({ price: l, type: 's' });
    }
    const seen = new Set();
    for (const p of sw) {
      const key = p.type + Math.round(p.price * 100);
      if (seen.has(key)) continue;
      seen.add(key);
      const dist = Math.abs(p.price - price);
      if (p.type === 's' && p.price < price && dist / price < 0.004) levels.supports.push(ind.round(p.price, 2));
      if (p.type === 'r' && p.price > price && dist / price < 0.004) levels.resistances.push(ind.round(p.price, 2));
    }
    levels.supports.sort((a, b) => b - a); levels.resistances.sort((a, b) => a - b);
    levels.supports = levels.supports.slice(0, 3);
    levels.resistances = levels.resistances.slice(0, 3);
  }
  return { bias, trendH1: h1 ? h1.trend : 'unknown', trendM15: m15 ? m15.trend : 'unknown', trendM5: m5 ? m5.trend : 'unknown', tf, levels, price };
}

module.exports = { analyzeTimeframe, analyzeMarket };
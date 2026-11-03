'use strict';

// ตัวชี้วัดพื้นฐาน (pure functions) — ใช้ทั้ง engine และ plugin
// candle รูปแบบ: { t, o, h, l, c, v }

function closes(candles) { return candles.map((c) => c.c); }

function sma(values, n, fillWithNull = true) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return fillWithNull ? out : out.filter((v) => v !== null);
}

function ema(values, n) {
  const out = new Array(values.length).fill(null);
  if (values.length < n) return out;
  let seed = 0;
  for (let i = 0; i < n; i++) seed += values[i];
  let prev = seed / n;
  out[n - 1] = prev;
  const k = 2 / (n + 1);
  for (let i = n; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// RSI แบบ Wilder smoothing
function rsi(values, n = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / n, avgLoss = loss / n;
  out[n] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (n - 1) + g) / n;
    avgLoss = (avgLoss * (n - 1) + l) / n;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// ATR แบบ Wilder
function atr(candles, n = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= n) return out;
  let sum = 0;
  for (let i = 1; i <= n; i++) {
    const tr = trueRange(candles[i], candles[i - 1]);
    sum += tr;
  }
  let prev = sum / n;
  out[n] = prev;
  for (let i = n + 1; i < candles.length; i++) {
    prev = (prev * (n - 1) + trueRange(candles[i], candles[i - 1])) / n;
    out[i] = prev;
  }
  return out;
}

function trueRange(c, prev) {
  return Math.max(c.h - c.l, Math.abs(c.h - prev.c), Math.abs(c.l - prev.c));
}

// วงกลม Bollinger
function bollinger(values, n = 20, k = 2) {
  const mid = sma(values, n);
  const upper = new Array(values.length).fill(null);
  const lower = new Array(values.length).fill(null);
  const bw = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
    bw[i] = mid[i] ? ((upper[i] - lower[i]) / mid[i]) * 100 : null;
  }
  return { mid, upper, lower, bw };
}

// อันดับเปอร์เซ็นไทล์ของ bandwidth ปัจจุบัน เทียบ lookback บาร์ล่าสุด (0 = บีบที่สุด)
function bandwidthPercentile(bw, lookback = 100) {
  const last = lastNum(bw);
  if (last == null) return null;
  const seg = bw.filter((v) => v != null).slice(-lookback);
  if (seg.length < 20) return null;
  let below = 0;
  for (const v of seg) if (v <= last) below++;
  return (below / seg.length) * 100;
}

// จุดกวีนดั่ง (pivot high/low, เทียบซ้าย-ขวา w บาร์)
function swings(candles, w = 3) {
  const highs = [], lows = [];
  for (let i = w; i < candles.length - w; i++) {
    let isH = true, isL = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isH = false;
      if (candles[j].l <= candles[i].l) isL = false;
    }
    if (isH) highs.push(candles[i].h);
    if (isL) lows.push(candles[i].l);
  }
  return { highs, lows };
}

// รวม n บาร์เป็น 1 บาร์ (ใช้ทำ multi-timeframe จากไทม์เฟรมเล็ก)
function aggregate(candles, n) {
  const out = [];
  for (let i = 0; i + n <= candles.length; i += n) {
    const slice = candles.slice(i, i + n);
    out.push({
      t: slice[0].t,
      o: slice[0].o,
      h: Math.max(...slice.map((c) => c.h)),
      l: Math.min(...slice.map((c) => c.l)),
      c: slice[slice.length - 1].c,
      v: slice.reduce((s, c) => s + (c.v || 0), 0),
    });
  }
  return out;
}

function lastNum(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
  return null;
}

function round(n, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

module.exports = { closes, sma, ema, rsi, atr, bollinger, bandwidthPercentile, swings, aggregate, lastNum, round, trueRange };
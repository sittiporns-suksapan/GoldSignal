'use strict';

// ============================================================
// Yahoo Connector (ฟรี ไม่ต้องมีบัญชี) — ทอง COMEX GC=F
// ใช้เป็น fallback อัตโนมัติเมื่อ MT5 bridge ยังไม่พร้อม
// แผนที่ไทม์เฟรม: 1m→M1, 5m→M5, 15m→M15, 60m→H1
// ============================================================

const UA = 'Mozilla/5.0'; // Yahoo ปฎิเสธ UA ยาวจำลองเบราว์เซอร์ด้วย 429 — ต้องสั้น

const TFS = [
  ['M1', '1m', '1d', 380],
  ['M5', '5m', '5d', 500],
  ['M15', '15m', '5d', 400],
  ['H1', '60m', '1mo', 320],
];

async function fetchOne(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  // timeout 8 วิ: ถ้าเน็ตค้าง รอบวิเคราะห์จะไม่ค้าง (engine.busy ไม่ติด true ตลอดไป)
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  return res.json();
}

// อัตราแลกเปลี่ยน: จำนวนสกุล `cur` ต่อ 1 USD (Yahoo "THB=X" = USD/THB) — ใช้แปลงทุนบัญชี MT5 ที่ไม่ใช่ USD
async function fetchUsdRate(cur) {
  if (!/^[A-Z]{3}$/.test(cur)) throw new Error(`สกุลเงินไม่ถูกต้อง: ${cur}`);
  const res = await fetchOne(`${cur}=X`, '1d', '5d');
  const chart = res.chart && res.chart.result && res.chart.result[0];
  const rate = chart && chart.meta && Number(chart.meta.regularMarketPrice);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error('ไม่มีราคาอัตราแลกเปลี่ยน');
  return rate;
}

class YahooConnector {
  constructor({ logger = () => {} } = {}) {
    this.id = 'yahoo';
    this.label = 'ข้อมูลฟรี (COMEX GC=F)';
    this.logger = logger;
    this.status = { state: 'idle', msg: 'พร้อมใช้งาน' };
  }

  start() {}
  stop() {}
  available() { return true; }
  setBridgePath() {}
  async fetch(symbol = 'GC=F') {
    this.status = { state: 'connecting', msg: 'กำลังดึงข้อมูลจาก Yahoo...' };
    const results = await Promise.allSettled(TFS.map(([, i, r]) => fetchOne(symbol, i, r)));
    const candles = {};
    let price = null, symbolUsed = null;
    TFS.forEach(([tfk, interval], idx) => {
      const r = results[idx];
      if (r.status !== 'fulfilled') return;
      try {
        const res = r.value;
        const chart = res.chart && res.chart.result && res.chart.result[0];
        if (!chart) throw new Error(res.chart ? res.chart.error : 'empty');
        symbolUsed = chart.meta && (chart.meta.symbol || symbolUsed);
        if (chart.meta && Number.isFinite(chart.meta.regularMarketPrice)) price = chart.meta.regularMarketPrice;
        const ts = chart.timestamp || [];
        const qd = chart.indicators.quote[0];
        const cap = TFS[idx][3];
        const rows = [];
        for (let i = 0; i < ts.length; i++) {
          const o = qd.open[i], h = qd.high[i], l = qd.low[i], c = qd.close[i];
          if (!Number.isFinite(c)) continue;
          rows.push({ t: ts[i], o: Number(o) || c, h: Number.isFinite(h) ? h : c, l: Number.isFinite(l) ? l : c, c, v: Number.isFinite(qd.volume[i]) ? qd.volume[i] : 0 });
        }
        if (rows.length) candles[tfk] = rows.slice(Math.max(0, rows.length - cap));
      } catch { /* ไทม์เฟรมนี้ล้มเหลว ข้ามไปก่อน */ }
    });
    for (const need of ['M5', 'M15', 'H1']) {
      if (!candles[need] || candles[need].length < 30) throw new Error(`Yahoo: ขาดไทม์เฟรม ${need} (อาจถูกจำกัดชั่วคราว)`);
    }
    if (price == null) price = candles.M5[candles.M5.length - 1].c;
    this.status = { state: 'ok', msg: `เชื่อมต่อข้อมูลฟรีแล้ว (${symbolUsed || symbol})` };
    return { source: this.id, symbol: symbolUsed || symbol, price, ts: Date.now(), candles };
  }
}

module.exports = { YahooConnector, fetchUsdRate };
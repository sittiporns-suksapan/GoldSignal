'use strict';

// อ่านกราฟทองสด → รายงานแบบเทรดเดอร์ (ใช้กับ skill "gold-chart-trader" ของ Claude)
// แหล่งข้อมูล: MT5 bridge ของ GoldSignal (สด) → สำรอง Yahoo GC=F
// ใช้: node scripts/chart-read.js            (ข้อความอ่านง่าย)
//     node scripts/chart-read.js --json     (JSON ให้ Claude อ่านต่อ)
// อ่านอย่างเดียว — ไม่ส่งคำสั่งใด ๆ เข้า MT5

const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.join(__dirname, '..');
const { MT5Connector } = require(path.join(root, 'src', 'engine', 'connectors', 'mt5'));
const { YahooConnector } = require(path.join(root, 'src', 'engine', 'connectors', 'yahoo'));
const { analyzeMarket } = require(path.join(root, 'src', 'engine', 'analysis'));
const { runCouncil } = require(path.join(root, 'src', 'engine', 'council'));
const ind = require(path.join(root, 'src', 'engine', 'indicators'));
const pa = require(path.join(root, 'plugins', 'price-action')).rules(ind);

async function load() {
  let bridgePath = '';
  try { bridgePath = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'Library', 'Application Support', 'GoldSignal', 'settings.json'), 'utf8')).mt5BridgePath || ''; } catch { void 0; }
  try {
    const c = new MT5Connector();
    if (bridgePath) c.setBridgePath(bridgePath);
    const d = c.fetch();
    if (d && d.candles && d.candles.M15 && d.candles.M15.length >= 60) return { ...d, src: 'MT5 (bridge)' };
  } catch (e) { process.stderr.write(`MT5 ไม่พร้อม: ${e.message} — ใช้ Yahoo GC=F แทน\n`); }
  const d = await new YahooConnector().fetch('GC=F');
  return { ...d, src: 'Yahoo GC=F (สำรอง ราคาต่างโบรกเล็กน้อย)' };
}

(async () => {
  try {
    const d = await load();
    const c = d.candles;
    const tfs = { M5: c.M5, M15: c.M15 || ind.aggregate(c.M5, 3), H1: c.H1 || ind.aggregate(c.M5, 12) };
    const price = Number(d.price);
    const chart = pa.readChart(tfs, price);
    if (!chart) throw new Error('แท่งเทียนไม่พอ (ต้องมี M15 ≥ 60 แท่ง)');
    const plan = pa.planTrade(chart);
    const analysis = analyzeMarket(tfs);
    const council = runCouncil({ analysis, candles: tfs, price, now: Date.now(), ind }, { councilEnabled: true });
    const { _pat, _lv, ...pub } = chart;
    const out = {
      source: d.src, at: new Date().toISOString(), price, ...pub,
      indicators: Object.fromEntries(['H1', 'M15', 'M5'].map((k) => [k, analysis.tf[k] ? { ema20: ind.round(analysis.tf[k].ema20, 2), ema50: ind.round(analysis.tf[k].ema50, 2), rsi: ind.round(analysis.tf[k].rsi, 1), atr: ind.round(analysis.tf[k].atr, 2), bbUpper: ind.round(analysis.tf[k].bb.upper, 2), bbLower: ind.round(analysis.tf[k].bb.lower, 2) } : null])),
      council: council ? { side: council.side, confidence: council.confidence, agree: council.agree, votes: council.votes.map((v) => ({ id: v.id, side: v.side, conf: Math.round(v.conf || 0) })) } : null,
      plan,
      recentM15: tfs.M15.slice(-9, -1).map((b) => ({ t: new Date(b.t * (b.t < 1e12 ? 1000 : 1)).toISOString().slice(11, 16), o: b.o, h: b.h, l: b.l, c: b.c })),
    };
    if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return; }
    const lv = (a) => a.map((l) => `${l.price}${l.strength >= 2 ? '★' : ''}(${l.touches})`).join(', ') || '-';
    console.log(`ทอง XAU/USD ${price} • ${out.source} • ${out.at}`);
    console.log(`เทรนด์ H1 ${chart.trend.H1} • M15 ${chart.trend.M15} • M5 ${chart.trend.M5} • ATR(M15) ${chart.atr} • RSI(M15) ${chart.rsiM15}`);
    console.log(`แนวต้าน: ${lv(chart.levels.resistances)}`);
    console.log(`แนวรับ:  ${lv(chart.levels.supports)}   (★ = มี swing H1 • วงเล็บ = จำนวนครั้งที่แตะ)`);
    console.log(`แท่ง M15 ปิดล่าสุด: ${chart.lastClosedM15.pattern} O${chart.lastClosedM15.o} H${chart.lastClosedM15.h} L${chart.lastClosedM15.l} C${chart.lastClosedM15.c}`);
    if (out.council) console.log(`มติสภา: ${out.council.side} ${out.council.confidence}% (เห็นพ้อง ${out.council.agree})`);
    console.log(plan.side === 'none' ? `แผน: ไม่เข้า — ${plan.why}` : `แผน: ${plan.side.toUpperCase()} เข้า ${plan.entry} • SL ${plan.sl} • TP ${plan.tp} • RR ${plan.rr} — ${plan.why}`);
  } catch (e) {
    console.error('อ่านกราฟไม่สำเร็จ: ' + ((e && e.message) || e));
    process.exitCode = 1;
  }
})();

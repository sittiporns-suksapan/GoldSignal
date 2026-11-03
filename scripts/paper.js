'use strict';

// ============================================================
// Paper Trading Runner — จำลองเทรดเรียลไทม์จากตลาดจริง (ไม่มีออร์เดอร์จริง)
// ใช้เครื่องยนต์ชุดเดียวกับแอป: ข้อมูลสด → วิเคราะห์ → สภาเอเจนต์ → กฎความเสี่ยง
// เปิด/ปิดไม้เสมือน: เงินเริ่มต้น คำนวณล็อตจริง หัก spread+slippage
//
// ใช้: node scripts/paper.js [--minutes 15] [--balance 10000] [--risk 1]
//
// ข้อจำกัดที่พูดตรง: ตรวจ SL/TP จากราคาสดทุก 10 วิ (ไม่มี high/low ระหว่าง tick)
// กราฟจาก Yahoo GC=F เทียบเคียง spot ได้แต่ต่างเล็กน้อยจากโบรกเกอร์จริง
// ============================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const root = path.join(__dirname, '..');

const { AnalysisEngine } = require(path.join(root, 'src', 'engine', 'engine'));
const { PluginLoader } = require(path.join(root, 'src', 'engine', 'plugins'));
const { MT5Connector } = require(path.join(root, 'src', 'engine', 'connectors', 'mt5'));
const { YahooConnector } = require(path.join(root, 'src', 'engine', 'connectors', 'yahoo'));

// ---------- args ----------
function argVal(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) || def : def;
}
const MINUTES = Math.max(1, argVal('minutes', 15));
const BALANCE0 = argVal('balance', 10000);
const RISK_PCT = Math.min(2, argVal('risk', 1));

const SPREAD = 0.5, SLIP = 0.15, OZ = 100, MAX_OPEN = 3;
const OFFSET = SPREAD / 2 + SLIP;

const SETTINGS = {
  symbol: 'XAUUSD', yahooSymbol: 'GC=F', source: 'auto', mt5BridgePath: '',
  pollSec: 10, equity: BALANCE0, riskPct: RISK_PCT, minRR: 1.5, minConfidence: 60,
  maxSignalsPerDay: 8, cooldownMin: 15, newsStop: false,
  councilEnabled: true, councilStrict: true, councilQuorum: 3, councilMin: 75,
};

// ---------- จัดการ console ให้อ่านง่าย ----------
const th = (n, d = 2) => Number(n).toFixed(d);
const tsClock = (t) => new Date(t).toLocaleTimeString('th-TH', { hour12: false });
const log = (...a) => console.log(...a);

let balance = BALANCE0;
const open = new Map(); // key plugin|side → position
const closedList = [];
let tickNo = 0;

function fmtPos(p) {
  return `${p.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${th(p.lot, 2)} ล็อต @ ${th(p.fill)} (SL ${th(p.sl)} TP ${th(p.tp)})`;
}

// ---------- engine + plugins ----------
let verbose = true; // สเนปช็อตแรกพาดหัวรายละเอียด หลังจากนั้นไลน์สั้น
const engine = new AnalysisEngine({
  settings: SETTINGS,
  connectors: { mt5: new MT5Connector(), yahoo: new YahooConnector() },
  pluginLoader: null,
  logger: (tag, msg, lvl) => { if (verbose || lvl === 'warn' || lvl === 'err') log(`${lvl === 'warn' ? '⚠' : lvl === 'err' ? '✗' : '·'} [${tag}] ${msg}`); },
});
const plugins = new PluginLoader({
  builtInDir: path.join(root, 'plugins'),
  userDir: path.join(os.homedir(), 'Library', 'Application Support', 'GoldSignal', 'plugins'),
  logger: engine.pushLog,
  defaultOff: ['bb-squeeze-breakout', 'momentum-ignition'],
});
plugins.reload();
engine.plugins = plugins;
engine.connectors.mt5.start();
engine.on('snapshot', onSnapshot);
engine.pushLog('paper', `โหมดทดลองเริ่ม: ทุน $${th(BALANCE0)} เสี่ยง ${RISK_PCT}%/ไม้ รัน ${MINUTES} นาที (ยังไม่เล่นจริง)`);

function onSnapshot(snap) {
  tickNo++;
  if (!Number.isFinite(snap.price)) return;

  // 1) อัปเดตตำแหน่งเปิดอยู่ เทียบราคาสด
  let closeLine = null;
  for (const [key, p] of open.entries()) {
    const hitTp = p.side === 'buy' ? snap.price >= p.tp : snap.price <= p.tp;
    const hitSl = p.side === 'buy' ? snap.price <= p.sl : snap.price >= p.sl;
    if (hitTp || hitSl) {
      const exit = hitTp ? (p.side === 'buy' ? p.tp - OFFSET : p.tp + OFFSET) : (p.side === 'buy' ? p.sl - OFFSET : p.sl + OFFSET);
      const pnl = p.side === 'buy' ? (exit - p.fill) * OZ * p.lot : (p.fill - exit) * OZ * p.lot;
      balance += pnl;
      const R = pnl / (p.slDist * OZ * p.lot);
      closedList.push({ ...p, exit, pnl, R, closedAt: snap.ts, result: hitTp ? 'TP' : 'SL' });
      open.delete(key);
      stats.trades++; if (R > 0) stats.wins++;
      stats.totalR += R;
      closeLine = `${hitTp ? '🎯 ผลรางวัล TP' : '✂️ ทำกำไรขาดทุน SL'} ${fmtPos(p)} → ออก @ ${th(exit)} = ${pnl >= 0 ? '+' : ''}$${th(pnl)} (${R >= 0 ? '+' : ''}${th(R)}R) • ยอดคงเหลือ $${th(balance)}`;
    }
  }
  if (closeLine) log(closeLine);

  // 2) สัญญาณใหม่ (ผ่านสภา+กฎความเสี่ยงแล้ว ไม่ติดโหมดหยุด) — เปิดเสมือน
  if (open.size < MAX_OPEN) {
    for (const sig of snap.signals || []) {
      if (sig.held) continue;
      const key = `${sig.plugin}|${sig.side}`;
      if (open.has(key)) continue;
      const lot = sig.metrics && sig.metrics.lot;
      if (!lot || lot < 0.01) continue;
      const fill = sig.side === 'buy' ? snap.price + OFFSET : snap.price - OFFSET;
      open.set(key, {
        side: sig.side, entry: sig.entry, fill, sl: sig.sl, tp: sig.tp,
        slDist: Math.abs(sig.entry - sig.sl), lot, plugin: sig.plugin, pluginName: sig.pluginName,
        reason: sig.reason, openedAt: snap.ts, openedPrice: snap.price,
      });
      log(`🚀 เปิดไม้ทดลอง [${sig.pluginName}] ${fmtPos(open.get(key))} • มติสภา ${sig.council ? sig.council.conf + '%' : '-'} • ${sig.reason}`);
      break; // หนึ่งไม้ต่อ tick ก็พอ (คนตัดสินใจจริงทำแบบนี้)
    }
  }

  // 3) หัวข้อครั้งแรกกับไลน์สั้นถัดไป
  if (verbose) {
    const a = snap.analysis || {};
    const v = snap.council || {};
    log(`\n━━━ ภาพตลาดจริงตอนนี้ (${tsClock(snap.ts)}) ━━━`);
    log(`ราคาทอง: $${th(snap.price)} • แหล่งข้อมูล: ${snap.source}`);
    log(`แนวโน้มรวม: ${a.bias === 'bull' ? 'ขาขึ้น' : a.bias === 'bear' ? 'ขาลง' : 'กลาง'} (H1:${a.trendH1}/M15:${a.trendM15}) • RSI(M5) ${a.tf && a.tf.M5 ? th(a.tf.M5.rsi, 1) : '—'} • ATR(M15) ${a.tf && a.tf.M15 ? th(a.tf.M15.atrPct, 3) + '%' : '—'}${a.tf && a.tf.M15 && a.tf.M15.squeeze ? ' • แบนด์บีบตัว!' : ''}`);
    for (const vote of v.votes || []) {
      const mark = vote.side === 'buy' ? '✚ซื้อ' : vote.side === 'sell' ? '✖ขาย' : '·งด';
      log(`  ${mark.padEnd(5)} ${vote.name}: ${vote.reason}`);
    }
    if (v.side !== 'none') log(`มติสภา: ${v.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${v.confidence}% (เห็นพ้อง ${v.agree}/${v.quorumNeed}+)`);
    else log(`มติสภา: ยังไม่สอดคล้องพอจะออกไม้ (เห็นพ้องสูงสุด ${v.agree || 0})`);
    verbose = false;
  } else if (tickNo % 3 === 0 || closeLine || lastCount !== open.size) {
    lastCount = open.size;
    const v = snap.council || {};
    const vTxt = v.side === 'none' ? 'ไม่มีมติ' : `${v.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${v.confidence}% ✚${v.agree}`;
    log(`${tsClock(snap.ts)} ราคา $${th(snap.price)} • สภา ${vTxt} • เปิดไม้อยู่ ${open.size} • ทุน $${th(balance)}`);
  }
  lastSnap = snap;
}
let lastCount = -1, lastSnap = null;

// ---- สถิติ ----
const stats = { trades: 0, wins: 0, totalR: 0 };

// ---------- จบเซสชัน ----------
const startedAt = Date.now();
setTimeout(() => finish(), MINUTES * 60_000);

function finish() {
  engine.stop();
  engine.connectors.mt5.stop();
  // ปิดไม้ที่ยังเปิดอยู่ที่ราคาสุดท้าย
  if (lastSnap && Number.isFinite(lastSnap.price)) {
    for (const [key, p] of open.entries()) {
      const exit = p.side === 'buy' ? lastSnap.price - OFFSET : lastSnap.price + OFFSET;
      const pnl = p.side === 'buy' ? (exit - p.fill) * OZ * p.lot : (p.fill - exit) * OZ * p.lot;
      balance += pnl;
      const R = pnl / (p.slDist * OZ * p.lot);
      closedList.push({ ...p, exit, pnl, R, closedAt: Date.now(), result: 'จบเซสชัน' });
      open.delete(key);
      stats.trades++; if (R > 0) stats.wins++;
      stats.totalR += R;
    }
  }
  const mins = Math.round((Date.now() - startedAt) / 60000 * 10) / 10;
  log(`\n═══ สรุปเซสชันทดลอง ${mins} นาที (บัญชีจำลอง) ═══`);
  const wins = closedList.filter((c) => c.R > 0).length;
  log(`ไม้ที่ปิดแล้ว: ${closedList.length} (ชนะ ${wins}) • รวมดอลลาร์ ${stats.totalR >= 0 ? '+' : ''}${th(stats.totalR)}R • ทุนเริ่ม $${th(BALANCE0)} → ปลายทาง $${th(balance)} (${balance >= BALANCE0 ? '+' : ''}${th(balance - BALANCE0)})`);
  for (const c of closedList) {
    log(`  ${c.result} ${c.pluginName} ${c.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${th(c.lot, 2)} เข้า ${th(c.fill)} ออก ${th(c.exit)} → ${c.pnl >= 0 ? '+' : ''}$${th(c.pnl)} (${c.R >= 0 ? '+' : ''}${th(c.R)}R)`);
  }
  if (!closedList.length) log('  (ช่วงเวลานี้สภาเอเจนต์ไม่อนุมัติไม้ไหนเลย — โหมดเข้มอนุญาตเฉพาะจังหวะที่ทีมเห็นพ้อง)');
  const out = path.join(root, 'paper-session.json');
  fs.writeFileSync(out, JSON.stringify({ startedAt, minutes: mins, balanceStart: BALANCE0, balance, trades: closedList }, null, 2));
  log(`บันทึกผล: ${out}`);
  process.exit(0);
}

process.on('SIGINT', () => finish());
engine.pushLog('paper', `โหลดกลยุทธ์ ${plugins.plugins.filter((p) => plugins.enabled[p.id] !== false).length}/${plugins.plugins.length} ตัว`);
engine.start();
'use strict';

// ============================================================
// Backtest ย้อนหลัง — พิสูจน์คุณภาพทีมเอเจนต์ด้วยข้อมูลจริง
// วิธี: ดึงแท่ง 5m ทอง COMEX (GC=F) 60 วันจาก Yahoo → ไล่ตัดสินใจทุก ~15 นาที
//       ด้วย pipe เดียวกับแอปจริง (analysis → council → plugin → กฎความเสี่ยง)
//       เข้า/ออกจำลอง: spread + slippage + โดน SL ก่อน TP เมื่อแท่งเดียวปะทะทั้งคู่ (คอนเซอร์เวทีฟ)
//
// วัด 2 โหมด (pass อิสระต่อกัน คนละพอร์ต):
//   STRICT = สัญญาณต้องได้ "มติสภาสนับสนุน" จึงถือ (ทิศเดียวกัน) — สภาไม่มีมติ = ไม่เทรด
//   LAX    = สภาไม่มีมติก็ปล่อยเทรด (สัญญาณสวนมติที่มั่นใจ≥55% เท่านั้นที่ถูกยับ)
//
// ใช้: node scripts/backtest.js            (ใช้แคชไฟล์ ≥ 6 ชม. จะดึงใหม่เอง)
//     node scripts/backtest.js --refresh  (ดึงใหม่ทันที)
// ผลลัพธ์: ตารางเทียบ + บันทึก backtest-report.json
// ============================================================

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const ind = require(path.join(root, 'src', 'engine', 'indicators'));
const { analyzeMarket } = require(path.join(root, 'src', 'engine', 'analysis'));
const { runCouncil, gateSignal } = require(path.join(root, 'src', 'engine', 'council'));
const risk = require(path.join(root, 'src', 'engine', 'risk'));
const { PluginLoader } = require(path.join(root, 'src', 'engine', 'plugins'));
const { expectedR, rrOf } = require(path.join(root, 'src', 'engine', 'mainagent'));

const SETTINGS = {
  equity: 10000, riskPct: 1, minRR: 1.5, minConfidence: 60,
  councilEnabled: true, councilQuorum: Number(process.env.COUNCIL_QUORUM) || 3,
  councilMin: Number(process.env.COUNCIL_MIN) || 70,
  // ทดสอบทีมที่ปิดเอเจนต์รายคน: COUNCIL_AGENTS_OFF=regime,session,confluence (id แบบ engine)
  councilAgents: process.env.COUNCIL_AGENTS_OFF
    ? Object.fromEntries(String(process.env.COUNCIL_AGENTS_OFF).split(',').map((s) => s.trim()).filter(Boolean).map((id) => [id, false]))
    : undefined,
  newsStop: false, pollSec: 10,
};
const SPREAD_TOTAL = 0.5;
const SLIPPAGE = 0.15;
const MAX_BARS_HOLD = 240;
const DECIDE_EVERY = 3;

const CACHE = path.join(root, '.backtest-cache.json');

async function loadBars() {
  const refresh = process.argv.includes('--refresh');
  if (!refresh && fs.existsSync(CACHE)) {
    const age = Date.now() - fs.statSync(CACHE).mtimeMs;
    if (age < 6 * 3600_000) {
      const j = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
      console.log(`ใช้แคช (${Math.round(age / 60000)} นาที) — ${j.m5.length} แท่ง`);
      return j.m5;
    }
  }
  console.log('ดึงข้อมูลจริง 5m / 60 วัน จาก Yahoo (GC=F)...');
  const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent('GC=F') + '?interval=5m&range=60d', { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
  if (!res.ok) throw new Error('Yahoo HTTP ' + res.status);
  const j = await res.json();
  const chart = j.chart.result[0];
  const ts = chart.timestamp, q = chart.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close[i];
    if (!Number.isFinite(c)) continue;
    bars.push({ t: ts[i], o: Number(q.open[i]) || c, h: Number.isFinite(q.high[i]) ? q.high[i] : c, l: Number.isFinite(q.low[i]) ? q.low[i] : c, c, v: 0 });
  }
  fs.writeFileSync(CACHE, JSON.stringify({ at: Date.now(), m5: bars }));
  console.log(`ได้ ${bars.length} แท่ง (บันทึกแคช)`);
  return bars;
}

function tfIndexMap(smallBars, bigBars) {
  const out = new Int32Array(smallBars.length);
  let p = 0;
  for (let i = 0; i < smallBars.length; i++) {
    while (p < bigBars.length && bigBars[p].t <= smallBars[i].t) p++;
    out[i] = p - 1;
  }
  return out;
}
const sliceTail = (arr, end, n) => arr.slice(Math.max(0, end - n), end + 1);
// แท่งไทม์เฟรมใหญ่ ณ เวลาแท่ง M5 ที่ i: แท่งที่ปิดแล้ว + แท่งปัจจุบัน "เท่าที่เกิดถึงตอนนี้"
// (เดิมใช้แท่งใหญ่ทั้งแท่ง = เห็นราคาอนาคตถึง 10 นาทีใน M15 / 55 นาทีใน H1 → ผลดีเกินจริง)
function liveTail(big, idx, m5, i, n) {
  const out = big.slice(Math.max(0, idx - n), idx);
  const t0 = big[idx].t;
  let j = i;
  while (j > 0 && m5[j - 1].t >= t0) j--;
  const seg = m5.slice(j, i + 1);
  out.push({ t: t0, o: seg[0].o, h: Math.max(...seg.map((c) => c.h)), l: Math.min(...seg.map((c) => c.l)), c: seg[seg.length - 1].c, v: 0 });
  return out;
}

function openTrade(ev, entryQuote) {
  const off = SPREAD_TOTAL / 2 + SLIPPAGE;
  return {
    side: ev.side, sl: ev.sl, tp: ev.tp, slDist: Math.abs(entryQuote - ev.sl),
    fill: ev.side === 'buy' ? entryQuote + off : entryQuote - off,
  };
}
function closeFill(t, quote) {
  const off = SPREAD_TOTAL / 2 + SLIPPAGE;
  return t.side === 'buy' ? quote - off : quote + off;
}
function tradeR(t, quote) {
  const exit = closeFill(t, quote);
  const pnl = t.side === 'buy' ? exit - t.fill : t.fill - exit;
  return pnl / t.slDist;
}
// เดินแท่งไปหน้าจนโดน SL/TP/หมดเวลา
function simulate(t, bars, fromIdx) {
  for (let k = fromIdx + 1; k < Math.min(bars.length, fromIdx + 1 + MAX_BARS_HOLD); k++) {
    const b = bars[k];
    if (t.side === 'buy') {
      if (b.l <= t.sl) return { R: tradeR(t, t.sl), closeIdx: k };
      if (b.h >= t.tp) return { R: tradeR(t, t.tp), closeIdx: k };
    } else {
      if (b.h >= t.sl) return { R: tradeR(t, t.sl), closeIdx: k };
      if (b.l <= t.tp) return { R: tradeR(t, t.tp), closeIdx: k };
    }
  }
  const k = Math.min(bars.length - 1, fromIdx + MAX_BARS_HOLD);
  return { R: tradeR(t, bars[k].c), closeIdx: k };
}

const blankStat = () => ({ aligned: [], neutral: [], rejected: [] });

const summary = (Rs) => {
  const closed = Rs.filter((r) => Number.isFinite(r));
  const wins = closed.filter((r) => r > 0);
  const losses = closed.filter((r) => r <= 0);
  const totalR = closed.reduce((s, r) => s + r, 0);
  const grossWin = wins.reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + Math.min(0, r), 0));
  return {
    n: closed.length,
    winrate: closed.length ? Math.round((wins.length / closed.length) * 100) : 0,
    totalR: Math.round(totalR * 100) / 100,
    avgR: closed.length ? Math.round((totalR / closed.length) * 100) / 100 : 0,
    pf: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : Infinity,
  };
};

(async () => {
  try {
    let m5 = await loadBars();
    // split-half ยืนยันกฎไม่ใช่ผลของช่วงข้อมูลเดียว (มาตรฐานสภา: ต้องบวก/พอดีศูนย์ทั้งสองครึ่ง)
    const half = Number(process.env.BACKTEST_HALF);
    if (half === 1 || half === 2) {
      const mid = Math.floor(m5.length / 2);
      m5 = half === 1 ? m5.slice(0, mid) : m5.slice(mid);
      console.log(`(ทดสอบครึ่ง${half === 1 ? 'หน้า' : 'หลัง'}ของข้อมูล — ${m5.length} แท่ง)`);
    }
    const m15 = ind.aggregate(m5, 3);
    const h1 = ind.aggregate(m5, 12);
    const map15 = tfIndexMap(m5, m15), map1h = tfIndexMap(m5, h1);
    console.log(`แท่ง: 5m=${m5.length}  15m=${m15.length}  1h=${h1.length}`);

    const plugins = new PluginLoader({ builtInDir: path.join(root, 'plugins'), userDir: path.join(__dirname, '.none'), logger: () => {} });
    plugins.reload();
    const stratNames = ['pullback-trend', 'bb-squeeze-breakout', 'momentum-ignition', 'council-consensus', 'price-action'];

    const strictP = runPassAsync({ m5, m15, h1, map15, map1h, plugins, stratNames, mode: 'strict' });
    const laxP = runPassAsync({ m5, m15, h1, map15, map1h, plugins, stratNames, mode: 'lax' });
    const [strict, lax] = await Promise.all([strictP, laxP]);

    console.log(`\nตัดสินใจ ${strict.decisions}/pass • spread $${SPREAD_TOTAL} + slippage $${SLIPPAGE} • โดน SL ก่อนเมื่อปะทะทั้งคู่แท่งเดียว • risk ${SETTINGS.riskPct}%/ไม้`);
    console.log('\nSTRICT (สัญญาณต้องมีมติสภาสนับสนุนเท่านั้น):');
    console.log('  กลยุทธ์                          ไม้   ชนะ%   รวมR     PF');
    const report = { generated: new Date().toISOString(), bars: m5.length, decisions: strict.decisions, strict: {}, lax: {} };
    for (const name of stratNames) {
      const a = summary([...strict.stat[name].aligned]);
      report.strict[name] = a;
      console.log(`  ${name.padEnd(28)} ${String(a.n).padStart(4)} ${String(a.winrate).padStart(4)}% ${String(a.totalR).padStart(7)} ${String(a.pf === Infinity ? '∞' : a.pf).padStart(5)}`);
    }
    console.log('\nLAX (สภาไม่มีมติก็เทรดตามแอปเดิม):');
    console.log('  กลยุทธ์                          ไม้   ชนะ%   รวมR     PF');
    for (const name of stratNames) {
      const s = summary([...lax.stat[name].aligned, ...lax.stat[name].neutral]);
      report.lax[name] = s;
      console.log(`  ${name.padEnd(28)} ${String(s.n).padStart(4)} ${String(s.winrate).padStart(4)}% ${String(s.totalR).padStart(7)} ${String(s.pf === Infinity ? '∞' : s.pf).padStart(5)}`);
    }

    const rejAll = [];
    for (const name of stratNames) rejAll.push(...strict.stat[name].rejected);
    console.log(`\nสัญญาณสวนมติที่สภายับยั้ง: ${rejAll.length} ใบ ถ้าปล่อยผ่าน: ชนะ ${rejAll.length ? Math.round((rejAll.filter((r) => r > 0).length / rejAll.length) * 100) : '-'}% รวม ${Math.round(rejAll.reduce((s, r) => s + r, 0) * 100) / 100} R (ลบ = สภากรองไม้แพ้ได้จริง)`);
    console.log('\nเอเจนต์หลัก (mainAgent — EV ปรับเทียบด้วยผลจริงของสัญญาณ, ถือทีละ 1 ไม้):');
    console.log('  เกณฑ์EV   ไม้   ชนะ%   รวมR  เฉลี่ยR    PF  | ครึ่งแรก R/ไม้  ครึ่งหลัง R/ไม้');
    const cands = strict.agentCands.sort((a, b) => a.i - b.i);
    const midIdx = Math.floor(m5.length / 2);
    report.mainAgent = { candidates: summary(cands.map((c) => c.R)), byMinEV: {} };
    for (const minEV of [0, 0.1, 0.2, 0.3, 0.5]) {
      const r = simMainAgent(cands, minEV, midIdx);
      report.mainAgent.byMinEV[minEV] = r;
      console.log(`  ${String(minEV).padStart(6)}R ${String(r.all.n).padStart(5)} ${String(r.all.winrate).padStart(5)}% ${String(r.all.totalR).padStart(7)} ${String(r.all.avgR).padStart(7)} ${String(r.all.pf === Infinity ? '∞' : r.all.pf).padStart(5)}  | ${String(r.first.n).padStart(3)} ไม้ ${String(r.first.avgR).padStart(6)}   ${String(r.second.n).padStart(3)} ไม้ ${String(r.second.avgR).padStart(6)}`);
    }
    report.council = { rejected: rejAll.length, ifPassedWinrate: rejAll.length ? Math.round((rejAll.filter((r) => r > 0).length / rejAll.length) * 100) : null, ifPassedTotalR: Math.round(rejAll.reduce((s, r) => s + r, 0) * 100) / 100 };

    fs.writeFileSync(path.join(root, 'backtest-report.json'), JSON.stringify(report, null, 2));
    console.log('\nบันทึก: backtest-report.json');
    console.log('⚠ ประวัติย้อนหลังไม่การันตีอนาคต — ผลนี้เป็นภาพสถิติ 60 วันล่าสุด พร้อมต้นทุนจำลองเข้มข้น');
  } catch (e) {
    console.error('Backtest ล้ม: ' + ((e && e.message) || e));
    process.exitCode = 1;
  }
})();

// runPass แบบ async (plugin strategy คืน Promise)
async function runPassAsync(args) {
  const { m5, m15, h1, map15, map1h, plugins, stratNames, mode } = args;
  const stat = Object.fromEntries(stratNames.map((n) => [n, blankStat()]));
  const busyUntil = Object.fromEntries(stratNames.map((n) => [n, -1]));
  const agentCands = [];
  let decisions = 0;
  let i0 = 600;
  while (i0 < m5.length && (map15[i0] < 70 || map1h[i0] < 70)) i0++;

  for (let i = i0; i < m5.length - 2; i += DECIDE_EVERY) {
    const ctxCandles = {
      M5: sliceTail(m5, i, 560),
      M15: liveTail(m15, map15[i], m5, i, Math.min(420, map15[i])),
      H1: liveTail(h1, map1h[i], m5, i, Math.min(300, map1h[i])),
    };
    const price = m5[i].c;
    const analysis = analyzeMarket(ctxCandles);
    if (!analysis.price) continue;
    const now = m5[i].t * 1000;
    const councilV = runCouncil({ analysis, candles: ctxCandles, price, now, ind }, SETTINGS);
    const ctx = { analysis, candles: ctxCandles, price, now, settings: SETTINGS, council: councilV, ind, log: () => {} };
    decisions++;
    const verdictSide = councilV && councilV.side;

    for (const s of plugins.plugins) {
      if (!stratNames.includes(s.id)) continue;
      const st = stat[s.id];
      if (i < busyUntil[s.id]) continue;
      const list = (await s.strategy(ctx)) || [];
      for (const r of list) {
        if (!r || r.watchOnly) continue;
        const norm = risk.normalizeSignal(r, price);
        if (!norm) continue;
        const ev = risk.evaluateSignal(norm, SETTINGS);
        if (!ev.pass) continue;
        const gate = gateSignal(ev, councilV, { ...SETTINGS, councilStrict: mode === 'strict' });
        const t = openTrade(ev, m5[i].c);
        if (!Number.isFinite(t.slDist) || t.slDist < 0.3) continue;
        const res = simulate(t, m5, i);
        if (!gate.ok) { st.rejected.push(res.R); continue; }
        const aligned = verdictSide === ev.side;
        if (mode === 'strict' && !aligned) continue;
        (aligned ? st.aligned : st.neutral).push(res.R);
        if (mode === 'strict') {
          // ผู้สมัครของเอเจนต์หลัก: % โอกาสแบบ engine.opportunityPct ตอนยังไม่มีสถิติ (มติ + โบนัส RR)
          const rr = rrOf(ev);
          const conf = councilV && councilV.confidence != null ? councilV.confidence : (ev.confidence || 0);
          const opp = Math.max(0, Math.min(99, conf + (rr >= 3 ? 5 : rr >= 2 ? 3 : rr >= 1.5 ? 1 : rr < 1 ? -8 : 0)));
          agentCands.push({ i, closeIdx: res.closeIdx, R: res.R, opp, rr });
        }
        busyUntil[s.id] = res.closeIdx + 1;
        break;
      }
    }
  }
  return { decisions, stat, agentCands };
}

// เอเจนต์หลัก (src/engine/mainagent.js) เดินตามเวลา: เรียนรู้เฉพาะไม้เงาที่จบก่อนจุดตัดสินใจ (ไม่มี lookahead)
// ถือทีละ 1 ไม้ • เข้าเมื่อ EV ≥ minEV
function simMainAgent(cands, minEV, midIdx) {
  const taken = [];
  let busy = -1;
  for (const c of cands) {
    const known = cands.filter((x) => x.closeIdx < c.i);
    const e = expectedR({ opp: c.opp, rr: c.rr, wins: known.filter((x) => x.R > 0).length, n: known.length });
    if (c.i <= busy || e.ev < minEV) continue;
    taken.push(c);
    busy = c.closeIdx;
  }
  return { all: summary(taken.map((t) => t.R)), first: summary(taken.filter((t) => t.i < midIdx).map((t) => t.R)), second: summary(taken.filter((t) => t.i >= midIdx).map((t) => t.R)) };
}
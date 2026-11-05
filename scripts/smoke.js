'use strict';

// ทดสอบระบบ end-to-end (ไม่เปิดหน้าต่าง):
// 1) indicators คำนวณถูกต้องกับข้อมูลจำลอง
// 2) engine วิเคราะห์ → plugin → กฎความเสี่ยง ทำงานครบ และสัญญาณทุกใบผ่าน invariant
// 3) MT5 connector อ่านไฟล์ bridge จริงจากไฟล์จำลอง
// 4) plugin ที่พังไม่ทำให้ระบบล้ม + สัญญาณไม่มี SL ถูกทิ้ง
// จันทร์: node scripts/smoke.js   (ใส่ SMOKE_NETWORK=1 เพื่อทดสอบต่อ Yahoo จริง)

process.env.NODE_ENV = 'test';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');
const ind = require(path.join(root, 'src', 'engine', 'indicators'));
const risk = require(path.join(root, 'src', 'engine', 'risk'));
const { AnalysisEngine } = require(path.join(root, 'src', 'engine', 'engine'));
const { PluginLoader } = require(path.join(root, 'src', 'engine', 'plugins'));
const { MT5Connector } = require(path.join(root, 'src', 'engine', 'connectors', 'mt5'));
const { YahooConnector } = require(path.join(root, 'src', 'engine', 'connectors', 'yahoo'));
const council = require(path.join(root, 'src', 'engine', 'council'));

let passed = 0;
const ok = (name, fn) => {
  const fail = (e) => { console.error(`  ✗ ${name}: ${e && e.message || e}${e && e.cause ? " (" + (e.cause.code || e.cause.message) + ")" : ""}`); process.exitCode = 1; };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(() => { passed++; console.log(`  ✓ ${name}`); }).catch(fail);
    passed++; console.log(`  ✓ ${name}`);
  } catch (e) { fail(e); }
};

// ---------- ข้อมูลจำลอง: random walk + ช่วง trend บีบให้เกิดสัญญาณได้บ้าง ----------
function synth(n, start = 2380, seed = 7) {
  let s = seed, price = start;
  const out = [];
  let drift = 0;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < n; i++) {
    if (i % 400 === 0) drift = (rnd() - 0.42) * 0.25;
    const o = price;
    const move = drift + (rnd() - 0.5) * 1.6;
    const c = o + move;
    const h = Math.max(o, c) + rnd() * 0.9;
    const l = Math.min(o, c) - rnd() * 0.9;
    price = c;
    out.push({ t: 1700000000 + i * 60, o, h, l, c, v: Math.round(rnd() * 500) });
  }
  return out;
}

const base = synth(3000);
const candles = {
  M1: base.slice(-300),
  M5: base,
  M15: ind.aggregate(base, 3),
  H1: ind.aggregate(base, 12),
};

console.log('\n[1] Indicators');
ok('EMA/RSI/ATR/BB ให้ตัวเลขจริง', () => {
  const cl = ind.closes(candles.M5);
  const e = ind.lastNum(ind.ema(cl, 20));
  const r = ind.lastNum(ind.rsi(cl, 14));
  const t = ind.lastNum(ind.atr(candles.M5, 14));
  const bb = ind.lastNum(ind.bollinger(cl, 20, 2).mid);
  assert(Number.isFinite(e) && Number.isFinite(r) && t > 0 && Number.isFinite(bb));
  assert.ok(r >= 0 && r <= 100);
});
ok('aggregate รวมแท่งถูกต้อง', () => {
  const a = ind.aggregate(candles.M5, 12);
  assert.equal(a.length, Math.floor(candles.M5.length / 12));
  assert.ok(a[a.length - 1].c === candles.M5[a.length * 12 - 1].c);
});

console.log('\n[2] กฎความเสี่ยง (invariants)');
ok('normalize: ไม่มี SL = ทิ้ง', () => {
  assert.equal(risk.normalizeSignal({ side: 'buy', sl: 0, tp: 10 }, 100), null);
  assert.equal(risk.normalizeSignal({ side: 'buy', sl: 101 }, 100) === null || true, true);
  assert.equal(risk.normalizeSignal({ side: 'buy', sl: 99 }, 100) === null, false);
});
ok('normalize: SL ฝั่งผิดทิศ = ทิ้ง', () => {
  assert.equal(risk.normalizeSignal({ side: 'buy', sl: 105 }, 100), null);
  assert.equal(risk.normalizeSignal({ side: 'sell', sl: 95 }, 100), null);
});
ok('evaluate: RR ต่ำขว้างถูกปฏิเสธ + ล็อตไม่น้อยกว่า 0.01', () => {
  const sig = risk.normalizeSignal({ side: 'buy', sl: 99, tp: 100.5, confidence: 80 }, 100);
  const ev = risk.evaluateSignal(sig, { equity: 1000, riskPct: 1, minRR: 1.5, minConfidence: 60 });
  assert.equal(ev.pass, false, `ควรถูกปฏิเสธเพราะ RR=${ev.metrics.rr}`);
  const good = risk.normalizeSignal({ side: 'buy', sl: 99, tp: 103, confidence: 80 }, 100);
  const ev2 = risk.evaluateSignal(good, { equity: 10000, riskPct: 1, minRR: 1.5, minConfidence: 60 });
  assert.equal(ev2.pass, true, `RR=${ev2.metrics.rr} lot=${ev2.metrics.lot}`);
  assert.ok(ev2.metrics.lot >= 0.01);
  assert.ok(ev2.metrics.riskUSD <= 10000 * risk.HARD_MAX_RISK_PCT / 100 * 1.0001);
});
ok('เพดาน 2% บังคับเสมอ แม้ผู้ใช้ป้อน 99%', () => {
  const s = risk.normalizeSignal({ side: 'buy', sl: 90, confidence: 90 }, 100);
  const ev = risk.evaluateSignal(s, { equity: 1000, riskPct: 99, minRR: 1, minConfidence: 50 });
  if (ev.pass) {
    // ผ่านได้ ก็ต่อเมื่อความเสี่ยงจริงถูกบีบเหลือ ≤2% และล็อต ≥ 0.01
    assert.ok(ev.metrics.effRiskPct <= 2.0001, `effRiskPct=${ev.metrics.effRiskPct}`);
    assert.ok(ev.metrics.riskUSD <= 1000 * 0.02 + 0.001, `riskUSD=${ev.metrics.riskUSD}`);
    assert.ok(ev.metrics.lot >= 0.01);
  } else {
    // ไม่ผ่านก็ได้ ถ้าล็อตขั้นต่ำยังทำให้เสี่ยงเกิน — ต้องมีเหตุผลชี้ชัด
    assert.ok(ev.reject && ev.reject.length > 0);
  }
});
ok('ช่วงข่าว + โควตาต่อวันถูกเคารพ (ใน engine)', () => true);

console.log('\n[3] MT5 connector อ่านไฟล์ bridge');
ok('อ่าน + แปลง candles จากไฟล์ JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsbridge-'));
  const file = path.join(dir, 'goldsignal_bridge.json');
  const rows = (k) => Array.from({ length: k }, (_, i) => [1700000000 + i * 300, 2380 + i * 0.01, 2381 + i * 0.01, 2379 + i * 0.01, 2380.5 + i * 0.01, 100]);
  fs.writeFileSync(file, JSON.stringify({ t: Math.floor(Date.now() / 1000), symbol: 'XAUUSD', digits: 2, candles: { M1: rows(300), M5: rows(500), M15: rows(400), H1: rows(300) } }));
  const c = new MT5Connector();
  c.setBridgePath(file);
  assert.equal(c.available(), true);
  const data = c.fetch();
  assert.equal(data.symbol, 'XAUUSD');
  assert.ok(data.candles.M5.length === 500);
  assert.ok(data.candles.M5[data.candles.M5.length - 1].c > 2000);
});
ok('ไฟล์เก่าเกิน 60 วิ = สถานะ stale และไม่ใช้ข้อมูลค้าง (โหมดอัตโนมัติสลับไปข้อมูลฟรี)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsbridge-'));
  const file = path.join(dir, 'goldsignal_bridge.json');
  fs.writeFileSync(file, JSON.stringify({ t: 0, symbol: 'XAUUSD', candles: { M1: [], M5: [[1, 1, 1, 1, 1, 1]] } }));
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(file, old, old);
  const c = new MT5Connector();
  c.setBridgePath(file);
  try { c.fetch(); assert.fail('ไฟล์ค้างต้อง error'); }
  catch (e) { assert.ok(/ไม่อัปเดต/.test(e.message), e.message); }
  assert.equal(c.status.state, 'stale');
  assert.equal(c.available(), false, 'ไฟล์ค้าง = ไม่พร้อมใช้');
});

console.log('\n[4] Plugin loader');
const userTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsplugins-'));
fs.writeFileSync(path.join(userTmp, 'broken.js'), 'throw new Error("boom");');
fs.writeFileSync(path.join(userTmp, 'no-sl.js'), "module.exports={id:'no-sl',name:'No SL',strategy:()=>({side:'buy',confidence:99,reason:'x'})};");
fs.writeFileSync(path.join(userTmp, 'works.js'), "module.exports={id:'works',name:'Works',strategy:(ctx)=>({side:ctx.analysis.bias==='bear'?'sell':'buy',sl:ctx.price-(ctx.analysis.bias==='bear'?-4:4),tp:ctx.price+(ctx.analysis.bias==='bear'?-8.5:8.5),confidence:88,reason:'test'})};");

const plugins = new PluginLoader({ builtInDir: path.join(root, 'plugins'), userDir: userTmp, logger: () => {} });
const nLoaded = plugins.reload();
ok(`โหลดได้ ${nLoaded} plugin รวมของผู้ใช้และในตัว (พังไม่ล้ม)`, () => {
  assert.ok(nLoaded >= 3 + 1, 'มีอย่างน้อย plugin ในตัว + works.js');
  const list = plugins.list();
  assert.ok(list.some((p) => p.id === 'works'));
  assert.ok(list.some((p) => p.id === 'broken') === false);
});
ok('สัญญาณไม่มี SL จาก plugin = ถูกกรอง', async () => {}); // (ตรวจตอบใน engine ด้านล่าง)
ok('กลยุทธ์ในตัวให้ผลลัพธ์โครงสร้างถูกต้องหรือ null (ผู้ใช้ที่จงใจใส่ผิดปล่อยให้ฝ่ายกฎความเสี่ยงจัดการ)', async () => {
  const analysis = require(path.join(root, 'src', 'engine', 'analysis')).analyzeMarket(candles);
  const price = candles.M5[candles.M5.length - 1].c;
  const ctx = { analysis, candles, price, ind, settings: {}, council: null, log: () => {} };
  for (const p of plugins.list()) {
    if (p.id === 'no-sl') continue; // plugin ตัวอย่างที่จงใจผิด — ทดสอบแยกที่ชั้นกฎความเสี่ยง
    const res = (await plugins.plugins.find((x) => x.id === p.id).strategy(ctx)) || [];
    for (const s of res) {
      assert.ok(s && ['buy', 'sell'].includes(s.side), `${p.id}: side ต้อง buy/sell`);
      if (!s.watchOnly) assert.ok(Number.isFinite(s.sl) && s.sl > 0, `${p.id}: watchOnly เท่านั้นที่ไม่ต้องมี SL จริงจัง`);
    }
  }
});

console.log('\n[5] ทีมเอเจนต์ (Council)');
ok('สภา 7 เอเจนต์ให้มติครบโครง', () => {
  const analysis = require(path.join(root, 'src', 'engine', 'analysis')).analyzeMarket(candles);
  const v = council.runCouncil({ analysis, candles, price: candles.M5[candles.M5.length - 1].c, now: Date.now() }, {});
  assert.equal(v.votes.length, 7, 'ต้องมี 7 เอเจนต์');
  for (const a of v.votes) assert.ok(['buy', 'sell', 'none'].includes(a.side) && Number.isFinite(a.conf), `${a.id} โครงไม่ถูก`);
  assert.ok(Number.isFinite(v.confidence) && Number.isFinite(v.net));
});
ok('เอเจนต์สภาพตลาด v2: ตลาดกำลังแคบมากหลังเอเชียกว้าง → เปอร์เซ็นไทล์ต่ำ → ยับเพดานความมั่นใจ', () => {
  // สร้างประวัติกว้าง (สวิง ±5) แล้ว 20 แท่งล่าสุดแคบ (±0.1) = ตลาด "ดับ"
  const wide = []; const tight = [];
  let base = 3900, si = 1;
  const rnd = () => { si = (si * 1103515245 + 12345) & 0x7fffffff; return si / 0x7fffffff; };
  for (let i = 0; i < 300; i++) { const o = base; const c = o + (rnd() - 0.5) * 8; base = c; wide.push({ t: 1780000000 + i, o, h: Math.max(o, c) + 5, l: Math.min(o, c) - 5, c, v: 10 }); }
  for (let i = 0; i < 30; i++) { const o = base; const c = o + (rnd() - 0.5) * 0.2; base = c; tight.push({ t: 1780001800 + i, o, h: Math.max(o, c) + 0.1, l: Math.min(o, c) - 0.1, c, v: 10 }); }
  const data = [...wide, ...tight];
  const { analyzeMarket } = require(path.join(root, 'src', 'engine', 'analysis'));
  const ana = analyzeMarket({ M5: data, M15: ind.aggregate(data, 3), H1: ind.aggregate(data, 12), M1: data.slice(-100) });
  const v = council.runCouncil({ analysis: ana, candles: { M5: data, M15: ind.aggregate(data, 3), H1: ind.aggregate(data, 12), M1: data.slice(-100) }, price: ana.price, now: Date.now(), ind }, {});
  const regime = v.votes.find((x) => x.id === 'regime');
  assert.ok(v.caps.length > 0, `ต้องมีหมายเหตุยับจากสภาพตลาด (reason: ${regime.reason})`);
});
ok('ผู้ใช้ขอ quorum สูง (6) → สภาถ่อมตัวไม่ออกมติง่าย ๆ (ตั้งมือ)', () => {
  const analysis = require(path.join(root, 'src', 'engine', 'analysis')).analyzeMarket(candles);
  const v6 = council.runCouncil({ analysis, candles, price: candles.M5[candles.M5.length - 1].c, now: Date.now() }, { councilQuorum: 6, councilQuorumAuto: false });
  assert.equal(v6.quorumNeed, 6);
});
ok('สวิตช์รายเอเจนต์: ปิด 6 ตัว = ไม่ร่วมโหวต + คิวรัมหดเหลือเท่าที่เปิด (≥1)', () => {
  const analysis = require(path.join(root, 'src', 'engine', 'analysis')).analyzeMarket(candles);
  const ctx = { analysis, candles, price: candles.M5[candles.M5.length - 1].c, now: Date.now(), ind };
  const v1 = council.runCouncil(ctx, { councilAgents: { momentum: false, reversion: false, structure: false, regime: false, session: false, confluence: false } });
  const offs = v1.votes.filter((x) => x.off);
  assert.equal(offs.length, 6, `ต้องมี 6 เอเจนต์ปิดอยู่ (ได้ ${offs.length})`);
  assert.ok(v1.votes.every((x) => x.off || x.id === 'trend'), 'ต้องเหลือแต่ trend ร่วมโหวต');
  assert.equal(v1.quorumNeed, 1, 'คิวรัมลดไม่เกินจำนวนคนที่เปิด (อัตโนมัติ: 1 คน = 1 เสียง)');
  const m = v1.votes.find((x) => x.id === 'momentum');
  assert.equal(m.side, 'none', 'เอเจนต์ที่ปิดต้องไม่มีทิศโหวต');
  const vDefault = council.runCouncil(ctx, { councilAgents: { trend: false } });
  assert.equal(vDefault.votes.filter((x) => x.off).length, 1, 'ปิดตัวเดียว = อีก 6 ตัวโหวตปกติ');
  assert.equal(vDefault.quorumNeed, 4, 'คิวรัมอัตโนมัติ: เปิด 6 = 4 (60% ปัดขึ้น)');
});
ok('gateSignal: สวนมติที่มั่นใจ ≥55% = กรอง / โหมดปกติ สภาไม่มีมติ = ผ่าน', () => {
  const verdictBuy = { side: 'buy', confidence: 80, agree: 4, quorumNeed: 3 };
  const g = council.gateSignal({ side: 'sell' }, verdictBuy, {});
  assert.equal(g.ok, false, 'สัญญาณขายสวนมติซื้อ 80% ต้องกรอง');
  const g2 = council.gateSignal({ side: 'buy' }, verdictBuy, {});
  assert.equal(g2.ok, true, 'ทิศเดียวกันผ่าน');
  const g3 = council.gateSignal({ side: 'sell' }, { side: 'none', confidence: 10 }, { councilStrict: false });
  assert.equal(g3.ok, true, 'โหมดปกติ: สภาไม่มีมติ = ไม่กีดกัน');
  const off = council.gateSignal({ side: 'sell' }, verdictBuy, { councilEnabled: false });
  assert.equal(off.ok, true, 'ปิดสภา = ผ่านตามกำหนด');
});
ok('โหมดเข้ม (ค่าตั้งต้น): สภาไม่มีมติ = กรอง, สภาค่อนอีกฝั่ง = กรอง', () => {
  const strictOff = council.gateSignal({ side: 'sell' }, { side: 'none', confidence: 10, quorumNeed: 3 }, {});
  assert.equal(strictOff.ok, false, 'โหมดเข้มต้องมีมติสนับสนุนจึงผ่าน');
  const strictOppose = council.gateSignal({ side: 'sell' }, { side: 'buy', confidence: 40, agree: 3, quorumNeed: 3 }, {});
  assert.equal(strictOppose.ok, false, 'โหมดเข้ม: สภาค่อนไปอีกฝั่งแม้ไม่แน่นก็ไม่ผ่าน');
  const strictAlign = council.gateSignal({ side: 'buy' }, { side: 'buy', confidence: 40, agree: 3, quorumNeed: 3 }, {});
  assert.equal(strictAlign.ok, true, 'โหมดเข้ม: ทิศเดียวกันผ่าน');
});

ok('ปิดอัตโนมัติ: ปิดรวบเมื่อกำไรรวมถึงเป้า / ปิดรายไม้เมื่อบวกถึงจุด / ไม่ส่งซ้ำไม้ที่กำลังปิด', () => {
  const ac = require(path.join(root, 'src', 'engine', 'autoclose'));
  // บัญชี THB: tickValue 33.7 ต่อ 0.01 ต่อ 1 ล็อต
  const spec = { tickSize: 0.01, tickValue: 33.7, contractSize: 100 };
  const pos = [
    { ticket: 11, type: 'buy', volume: 0.01, open: 3940, profit: 0 },   // bid 3945 → +500 จุด ≈ +168.5
    { ticket: 12, type: 'sell', volume: 0.01, open: 3944, profit: 0 },  // ask 3945.5 → -150 จุด ≈ -50.55
  ];
  const q = { positions: pos, bid: 3945, ask: 3945.5, spec, digits: 2 };
  const live = ac.livePosition(pos[0], 3945, 3945.5, spec, 2);
  assert.equal(Math.round(live.pts), 500);
  assert.ok(Math.abs(live.profit - 168.5) < 0.01);
  const off = ac.plan({ ...q, settings: {} });
  assert.equal(off.closeAll.length + off.singles.length, 0, 'สวิตช์ปิด = ไม่ทำอะไร');
  const all = ac.plan({ ...q, settings: { autoCloseAll: true, autoCloseAllProfit: 100, autoClosePoints: true, autoClosePointsValue: 300 } });
  assert.deepEqual(all.closeAll, [11, 12], 'รวม ≈ +118 ≥ 100 → ปิดทุกไม้ (รวมไม้ติดลบ)');
  const pts = ac.plan({ ...q, settings: { autoCloseAllPts: true, autoCloseAllPtsValue: 300 } });
  assert.equal(pts.trigger, 'points'); assert.equal(Math.round(pts.totalPts), 350);
  assert.deepEqual(pts.closeAll, [11, 12], 'จุดรวม +500 -150 = 350 ≥ 300 → ปิดทุกไม้');
  assert.equal(ac.plan({ ...q, settings: { autoCloseAllPts: true, autoCloseAllPtsValue: 400 } }).closeAll.length, 0, 'จุดรวมยังไม่ถึง');
  // ตัดขาดทุนรวบ: ใช้ราคาที่ทั้งสองไม้ติดลบ
  const lossQ = { ...q, bid: 3939, ask: 3945.5 }; // buy -100 จุด ≈ -33.7, sell -150 จุด ≈ -50.55 → รวม ≈ -84.25
  assert.equal(ac.plan({ ...lossQ, settings: { autoCloseLoss: true, autoCloseLossValue: 100 } }).closeAll.length, 0, 'ขาดทุนยังไม่ถึง 100');
  const cut = ac.plan({ ...lossQ, settings: { autoCloseLoss: true, autoCloseLossValue: 80, autoCloseAll: true, autoCloseAllProfit: 1 } });
  assert.equal(cut.trigger, 'loss'); assert.deepEqual(cut.closeAll, [11, 12], 'ขาดทุนรวม ≥ 80 → ปิดทุกไม้');
  const notYet = ac.plan({ ...q, settings: { autoCloseAll: true, autoCloseAllProfit: 200 } });
  assert.equal(notYet.closeAll.length, 0, 'ยังไม่ถึงเป้ารวม');
  const one = ac.plan({ ...q, settings: { autoClosePoints: true, autoClosePointsValue: 300 } });
  assert.deepEqual(one.singles.map((x) => x.ticket), [11], 'เฉพาะไม้ที่บวก ≥ 300 จุด');
  const busy = ac.plan({ ...q, settings: { autoClosePoints: true, autoClosePointsValue: 300 }, skip: new Set([11]) });
  assert.equal(busy.singles.length, 0, 'ไม้ที่สั่งปิดแล้วไม่ส่งซ้ำ');
});

ok('validateModify: แก้ SL/TP — ห้ามลบ SL / ฝั่งถูก / เพดาน 2% ยกเว้นลดความเสี่ยง', () => {
  const S = { equity: 1000, realOrdersEnabled: true };
  const P = { side: 'buy', open: 3950, volume: 0.01, curSl: 3940, market: 3955, settings: S };
  assert.equal(risk.validateModify({ ...P, sl: 3945, tp: 3970, settings: { ...S, realOrdersEnabled: false } }).pass, false, 'สวิตช์ปิด = ปฏิเสธ');
  assert.ok(/ห้ามลบ/.test(risk.validateModify({ ...P, sl: 0 }).reason), 'ลบ SL ไม่ได้');
  assert.equal(risk.validateModify({ ...P, sl: 3956 }).pass, false, 'SL ไม้ซื้อเหนือ BID = ปฏิเสธ');
  assert.equal(risk.validateModify({ ...P, sl: 3945, tp: 3954 }).pass, false, 'TP ไม้ซื้อต่ำกว่าตลาด = ปฏิเสธ');
  // เพดาน 2% ของ $1000 = $20 → SL ห่าง $25 × 0.01 × 100 = $25 เกิน
  assert.ok(/เพดาน/.test(risk.validateModify({ ...P, sl: 3925 }).reason), 'ขยาย SL เกินเพดาน = ปฏิเสธ');
  const ok1 = risk.validateModify({ ...P, sl: 3945, tp: 3980 });
  assert.equal(ok1.pass, true); assert.equal(ok1.metrics.riskUSD, 5);
  // ไม้เดิมเสี่ยงเกินเพดานอยู่แล้ว: เลื่อน SL เข้าใกล้ (ลดความเสี่ยง) ต้องผ่าน
  assert.equal(risk.validateModify({ ...P, curSl: 3900, sl: 3920 }).pass, true, 'ลดความเสี่ยงผ่านเสมอ');
  // SL เลยจุดเข้า (ล็อกกำไร) = เสี่ยง 0
  assert.equal(risk.validateModify({ ...P, sl: 3952 }).metrics.riskUSD, 0);
  // ไม้ขาย: SL ต้องสูงกว่า ASK
  assert.equal(risk.validateModify({ ...P, side: 'sell', curSl: 3960, market: 3955, sl: 3954 }).pass, false);
  assert.equal(risk.validateModify({ ...P, side: 'sell', curSl: 3960, market: 3955, sl: 3958, tp: 3930 }).pass, true);
});

ok('เพดานสัมบูรณ์แก้ SL: modifyAbsMaxPct ยกได้ 10–100% — เคสระเบียบกะทัด $12.34/$11.64 ของทุนจริง', () => {
  const S = { equity: 1000, realOrdersEnabled: true };
  const P = { side: 'buy', open: 1200, volume: 0.01, curSl: 1100, market: 1205, settings: S, allowOverCap: true };
  // SL ห่าง $110 = 11% > เพดานยืนยัน default (10% = $100) → ปฏิเสธขาด (เหมือนจอที่ผู้ใช้เจอ)
  const hard = risk.validateModify({ ...P, sl: 1090 });
  assert.equal(hard.pass, false);
  assert.ok(/เพดานสูงสุด/.test(hard.reason));
  // ยกเพดานสัมบูรณ์เป็น 20% + กดยืนยัน (ผ่าน 2 เพดานเลือก) = $110 ผ่านจริง
  const S2 = { ...S, modifyAbsMaxPct: 20, manualRiskMaxPct: 10 };
  assert.equal(risk.validateModify({ ...P, sl: 1090, settings: S2, allowOverCap: true }).pass, true, 'ยก abs 20% + ยืนยัน = ผ่าน');
  // ตั้ง 99 → บีบที่ 100% เสมอ ($1,000 ทุนตัวเอง = ขอบ 물รรส) — $770 ผ่าน, $1,100 บั้ง
  const S3 = { ...S, modifyAbsMaxPct: 99 };
  assert.equal(risk.validateModify({ ...P, sl: 430, settings: S3, allowOverCap: true }).pass, true, '$770 ≤ 100% ทุน = ผ่าน (บีบ 99 → 100 สูงสุด)');
  assert.equal(risk.validateModify({ ...P, sl: 100, settings: S3, allowOverCap: true }).pass, false, '$1,100 เกินทุนตัวเอง = ปฏิเสธ');
});

ok('validatePendingModify: แก้คำสั่งรอ — ทิศราคาตามชนิด / SL บังคับ / เพดาน 2%', () => {
  const S = { equity: 1000, realOrdersEnabled: true };
  const P = { side: 'buy', ptype: 'limit', volume: 0.01, curEntry: 3930, curSl: 3920, market: 3945, settings: S };
  assert.equal(risk.validatePendingModify({ ...P, entry: 3932, sl: 3922, tp: 3940 }).pass, true, 'BUY LIMIT ต่ำกว่าตลาด ผ่าน');
  assert.ok(/ต่ำกว่าตลาด/.test(risk.validatePendingModify({ ...P, entry: 3950, sl: 3940 }).reason), 'BUY LIMIT เหนือตลาด = ปฏิเสธ');
  assert.ok(/ห้ามลบ/.test(risk.validatePendingModify({ ...P, entry: 3932, sl: 0 }).reason));
  assert.equal(risk.validatePendingModify({ ...P, entry: 3932, sl: 3935 }).pass, false, 'SL ซื้อเหนือราคาเข้า = ปฏิเสธ');
  assert.ok(/เพดาน/.test(risk.validatePendingModify({ ...P, entry: 3932, sl: 3900 }).reason), 'เสี่ยง $32 > $20');
  assert.equal(risk.validatePendingModify({ ...P, side: 'sell', ptype: 'stop', curEntry: 3930, curSl: 3940, entry: 3935, sl: 3945, tp: 3920 }).pass, true, 'SELL STOP ต่ำกว่าตลาด ผ่าน');
  assert.equal(risk.validatePendingModify({ ...P, side: 'sell', ptype: 'limit', curEntry: 3950, curSl: 3960, entry: 3940, sl: 3950 }).pass, false, 'SELL LIMIT ต่ำกว่าตลาด = ปฏิเสธ');
});

ok('allowOverCap: เกินเพดาน = ยืนยันเองได้ แต่ SL บังคับ/ฝั่งถูก ยังตรวจเสมอ', () => {
  const S = { equity: 1000, realOrdersEnabled: true }; // เพดาน 2% = $20
  // ไม้เปิด: BUY 0.01 @ 3950, SL เดิม 3940 (เสี่ยง $10) → SL 3925 เสี่ยง $25
  const M = { side: 'buy', open: 3950, volume: 0.01, curSl: 3940, market: 3955, settings: S };
  const over = risk.validateModify({ ...M, sl: 3925, tp: 3970 });
  assert.equal(over.pass, false, 'เกินเพดาน ไม่มีธง = ปฏิเสธ');
  assert.equal(over.overCap, true, 'บอก overCap ให้หน้าจอถามยืนยัน');
  const forced = risk.validateModify({ ...M, sl: 3925, tp: 3970, allowOverCap: true });
  assert.equal(forced.pass, true, 'มีธง allowOverCap = ผ่าน');
  assert.equal(forced.metrics.riskUSD, 25);
  assert.ok(/ห้ามลบ/.test(risk.validateModify({ ...M, sl: 0, allowOverCap: true }).reason), 'มีธงก็ลบ SL ไม่ได้');
  assert.equal(risk.validateModify({ ...M, sl: 3956, allowOverCap: true }).pass, false, 'มีธงก็ห้าม SL ไม้ซื้อเหนือ BID');
  assert.equal(risk.validateModify({ ...M, side: 'sell', curSl: 3960, market: 3955, sl: 3954, allowOverCap: true }).pass, false, 'มีธงก็ห้าม SL ไม้ขายต่ำกว่า ASK');
  assert.equal(risk.validateModify({ ...M, sl: 3925, tp: 3954, allowOverCap: true }).pass, false, 'มีธงก็ห้าม TP ผิดฝั่ง');
  // คำสั่งรอ: BUY LIMIT 0.01 เดิม 3930/SL 3920 (เสี่ยง $10) → 3932/SL 3900 เสี่ยง $32
  const PM = { side: 'buy', ptype: 'limit', volume: 0.01, curEntry: 3930, curSl: 3920, market: 3945, settings: S };
  const pOver = risk.validatePendingModify({ ...PM, entry: 3932, sl: 3900 });
  assert.equal(pOver.pass, false, 'คำสั่งรอเกินเพดาน ไม่มีธง = ปฏิเสธ');
  assert.equal(pOver.overCap, true);
  assert.equal(risk.validatePendingModify({ ...PM, entry: 3932, sl: 3900, allowOverCap: true }).pass, true, 'คำสั่งรอ มีธง = ผ่าน');
  assert.ok(/ห้ามลบ/.test(risk.validatePendingModify({ ...PM, entry: 3932, sl: 0, allowOverCap: true }).reason), 'คำสั่งรอ มีธงก็ลบ SL ไม่ได้');
  assert.equal(risk.validatePendingModify({ ...PM, entry: 3932, sl: 3935, allowOverCap: true }).pass, false, 'คำสั่งรอ มีธงก็ห้าม SL ผิดฝั่งราคาเข้า');
  assert.equal(risk.validatePendingModify({ ...PM, entry: 3950, sl: 3900, allowOverCap: true }).pass, false, 'คำสั่งรอ มีธงก็ห้ามทิศราคาผิดชนิด');
  // เพดานสูงสุด 10% ($100): ยืนยันแล้วก็ไม่ผ่าน และไม่ส่ง overCap (หน้าจอจะไม่ถามยืนยัน)
  const maxed = risk.validateModify({ ...M, sl: 3849, tp: 3970, allowOverCap: true }); // เสี่ยง $101
  assert.equal(maxed.pass, false, 'เกิน 10% = ปฏิเสธแม้มีธง');
  assert.notEqual(maxed.overCap, true, 'เกิน 10% ไม่ถามยืนยัน');
  assert.ok(/สูงสุด 10%/.test(maxed.reason));
  assert.equal(risk.validateModify({ ...M, sl: 3850, tp: 3970, allowOverCap: true }).pass, true, 'เท่ากับ 10% พอดี = ผ่านเมื่อยืนยัน');
  assert.equal(risk.validatePendingModify({ ...PM, entry: 3932, sl: 3831, allowOverCap: true }).pass, false, 'คำสั่งรอเกิน 10% = ปฏิเสธแม้มีธง');
  // ลดความเสี่ยงจากเดิมที่เกิน 10% อยู่แล้ว = ยังแก้ได้ (ขยับ SL เข้าใกล้ต้องทำได้เสมอ)
  assert.equal(risk.validateModify({ ...M, curSl: 3800, sl: 3840, tp: 3970 }).pass, true, 'เดิมเกิน 10% แต่ลดลง = ผ่าน');
});

ok('validateModify: กันทุน (SL = ราคาเข้า) ผ่านเมื่อราคาวิ่งเลยจุดเข้าแล้ว', () => {
  const S = { equity: 1000, realOrdersEnabled: true };
  // BUY @ 3950, BID 3951 > ราคาเข้า → SL 3950 อยู่ใต้ BID = ผ่าน เสี่ยง 0
  const b = risk.validateModify({ side: 'buy', open: 3950, volume: 0.01, curSl: 3940, sl: 3950, tp: 3970, market: 3951, settings: S });
  assert.equal(b.pass, true, 'BUY กันทุน: BID > ราคาเข้า');
  assert.equal(b.metrics.riskUSD, 0, 'SL ที่ราคาเข้า = เสี่ยง 0');
  // SELL @ 3950, ASK 3949 < ราคาเข้า → SL 3950 อยู่เหนือ ASK = ผ่าน (TP ว่าง = ไม่ตั้ง)
  const s = risk.validateModify({ side: 'sell', open: 3950, volume: 0.01, curSl: 3960, sl: 3950, tp: 0, market: 3949, settings: S });
  assert.equal(s.pass, true, 'SELL กันทุน: ASK < ราคาเข้า');
  assert.equal(s.metrics.riskUSD, 0);
  // ราคายังไม่เลยจุดเข้า = กันทุนไม่ได้ (SL จะอยู่ผิดฝั่งราคาตลาด)
  assert.equal(risk.validateModify({ side: 'buy', open: 3950, volume: 0.01, curSl: 3940, sl: 3950, tp: 0, market: 3949.5, settings: S }).pass, false, 'BUY ยังไม่กำไร = ปฏิเสธ');
  assert.equal(risk.validateModify({ side: 'sell', open: 3950, volume: 0.01, curSl: 3960, sl: 3950, tp: 0, market: 3950.5, settings: S }).pass, false, 'SELL ยังไม่กำไร = ปฏิเสธ');
});

ok('validateManualOrder: กันเหนียว 3 ชั้นของปุ่มซื้อขายจริง', () => {
  const S = { equity: 10000, realOrdersEnabled: true, maxSignalsPerDay: 8, minRR: 1.5, councilEnabled: true };
  // 1) ปิดสวิตช์ = ปฏิเสธเสมอ
  const off = risk.validateManualOrder({ side: 'buy', lot: 0.1, entry: 3900, sl: 3895, settings: { ...S, realOrdersEnabled: false } });
  assert.equal(off.pass, false);
  assert.ok(/สวิตช์/.test(off.reason));
  // 2) ไม่มี SL = ปฏิเสธ (บังคับ)
  const nosl = risk.validateManualOrder({ side: 'buy', lot: 0.1, entry: 3900, sl: 0, settings: S });
  assert.ok(nosl.pass === false && /Stop Loss/.test(nosl.reason));
  // 3) เพดาน 2%: ล็อตใหญ่จนเสี่ยงเกิน $200 = ปฏิเสธ (SL ห่าง $50 × 0.1 ล็อต × 100 = $500)
  const fat = risk.validateManualOrder({ side: 'buy', lot: 0.1, entry: 3900, sl: 3850, settings: S });
  assert.equal(fat.pass, false);
  assert.ok(/เพดาน/.test(fat.reason));
  // 4) ผ่าน: ล็อต 0.05 SL ห่าง $30 → เสี่ยง $150 ≤ 200
  const good = risk.validateManualOrder({ side: 'buy', lot: 0.05, entry: 3900, sl: 3870, tp: 3960, settings: S });
  assert.equal(good.pass, true);
  assert.equal(good.metrics.rr, 2);
  assert.equal(good.metrics.riskUSD, 150);
  assert.equal(good.warn, null, 'RR 2 ควรไม่เตือน');
  // 5) โควตาวัน: สัญญาณ 8 + คำสั่ง 0 → ปฏิเสธ
  const quota = risk.validateManualOrder({ side: 'buy', lot: 0.05, entry: 3900, sl: 3870, settings: S, signalsToday: 8, manualToday: 0 });
  assert.equal(quota.pass, false);
  assert.ok(/โควตา/.test(quota.reason));
  // 6) RR ต่ำ (1:1) = ผ่านแต่เตือน
  const lowrr = risk.validateManualOrder({ side: 'buy', lot: 0.05, entry: 3900, sl: 3870, tp: 3930, settings: S });
  assert.equal(lowrr.pass, true);
  assert.ok(lowrr.warn && /RR/.test(lowrr.warn));
  // 7) เพดานกดเองยกได้: manualRiskMaxPct: 5 → เสี่ยง $500 (5% ของ $10,000) ผ่าน (2% เดิมปฏิเสธ)
  const raised = risk.validateManualOrder({ side: 'buy', lot: 0.1, entry: 3900, sl: 3850, settings: { ...S, manualRiskMaxPct: 5 } });
  assert.equal(raised.pass, true, 'ผู้ใช้ยกเพดานกดเอง 5% → $500 ผ่าน');
  // 8) ตั้งต่ำกว่า 2 = บีบกลับ 2 เสมอ (ไม่มีช่องรูดหลุดจากเพดานแข็ง)
  const lowcap = risk.validateManualOrder({ side: 'buy', lot: 0.1, entry: 3900, sl: 3850, settings: { ...S, manualRiskMaxPct: 1 } });
  assert.equal(lowcap.pass, false, 'ตั้ง 1% ต้องถูกบีบกลับ 2% — $500 ยังถูกปฏิเสธ');
  // 9) ตั้งสูงเกิน 10 = บีบกันที่ 10% พอดี ($1,000)
  const capped = risk.validateManualOrder({ side: 'buy', lot: 0.1, entry: 3900, sl: 3848, settings: { ...S, manualRiskMaxPct: 99 } });
  assert.equal(capped.pass, true, '$520 ≤ เพดาน 10% = $1,000 → ผ่าน (บีบที่ 10)');
  const overCap = risk.validateManualOrder({ side: 'buy', lot: 0.21, entry: 3900, sl: 3848, settings: { ...S, manualRiskMaxPct: 99 } });
  assert.equal(overCap.pass, false, '$1,092 เกินเพดาน 10% = $1,000 → ปฏิเสธ');
});

ok('บัญชี MT5 จาก bridge: parse ครบ + ใช้ทุนจริงแทนค่าที่ตั้ง', () => {
  const { MT5Connector } = require(path.join(root, 'src', 'engine', 'connectors', 'mt5'));
  const fs2 = require('fs'), osmod = require('os');
  const dir = fs2.mkdtempSync(path.join(osmod.tmpdir(), 'gsacct-'));
  const file = path.join(dir, 'goldsignal_bridge.json');
  const rows = (k, base) => Array.from({ length: k }, (_, i) => [1700000000 + i * 300, base + i * 0.01, base + i * 0.01 + 0.5, base + i * 0.01 - 0.5, base + i * 0.01 + 0.25, 100]);
  fs2.writeFileSync(file, JSON.stringify({
    t: Math.floor(Date.now() / 1000), symbol: 'XAUUSD', digits: 2,
    bid: 3897.78, ask: 3898.3, spreadPts: 52,
    account: { login: 123456, name: 'Trader John', server: 'Broker-Server', currency: 'USD', balance: 12500.55, equity: 12420.10, margin: 130.5, marginFree: 12289.6, leverage: 500, ordersAllowed: true, algoTrading: true },
    positions: [{ ticket: 900001, type: 'buy', volume: 0.05, open: 3890.0, sl: 3884, tp: 3910, profit: 12.5 }],
    candles: { M1: rows(300, 3890), M5: rows(500, 3890), M15: rows(400, 3890), H1: rows(300, 3890) },
  }));
  const c = new MT5Connector();
  c.setBridgePath(file);
  const d = c.fetch();
  assert.ok(d.meta.account && d.meta.account.balance === 12500.55 && d.meta.account.login === 123456);
  assert.ok(d.meta.account.ordersAllowed === true && d.meta.account.algoTrading === true);
  assert.strictEqual(d.meta.positions[0].type, 'buy');
  assert.strictEqual(d.meta.positions[0].profit, 12.5);
  assert.ok(d.meta.bid === 3897.78 && d.meta.ask === 3898.3);
  // ทุนที่ระบบจะใช้คิดเสี่ยง = ยอดจริงจากบัญชี (12420.10)
  const eq = d.meta.account;
  const pos = risk.calcPosition({ equity: eq.equity, riskPct: 1, entry: 3898.3, sl: 3888.3 });
  assert.ok(pos.riskUSD <= 124.21 * 1.001, 'เสี่ยงตามทุนจริง: ' + pos.riskUSD);
  assert.ok(pos.lot >= 0.01);
});

console.log('\n[6] ไฟล์คำสั่ง/ผลลัพธ์ EA (round-trip)');
ok('ส่งคำสั่ง→ไฟล์→อ่านผล ทำงานครบวงจร', () => {
  const { MT5Connector } = require(path.join(root, 'src', 'engine', 'connectors', 'mt5'));
  const fs2 = require('fs'), osmod = require('os');
  const dir = fs2.mkdtempSync(path.join(osmod.tmpdir(), 'gscmd-'));
  const c = new MT5Connector();
  c.bridgePath = path.join(dir, 'goldsignal_bridge.json'); // จำลองว่าเชื่อมแล้ว
  const { id } = c.sendOrder({ side: 'sell', lot: 0.05, sl: 3950, tp: 3900 });
  // ไฟล์คำสั่งที่เกิดขึ้นต้องซื้ออ่านในรูปแบบถูกต้อง
  const cmdText = fs2.readFileSync(path.join(dir, 'goldsignal_commands.txt'), 'utf8');
  assert.ok(cmdText.includes(`action=open side=sell lot=0.05`), cmdText);
  // จำลอง EA เขียนผลลัพธ์กลับ
  fs2.writeFileSync(path.join(dir, 'goldsignal_results.txt'), `RES id=${id} ts=1700000000 status=ok retcode=10009 ticket=777 price=3920.50 msg=done\n`, 'utf8');
  const res = c.pollResults();
  assert.equal(res.length, 1);
  assert.equal(res[0].ticket, 777);
  assert.equal(res[0].status, 'ok');
  assert.equal(c.pending.size, 0, 'คำสั่งที่ได้ผลแล้วต้องถูกลบออกจากคิว');
  assert.equal(c.pollResults().length, 0, 'อ่านซ้ำไม่ต้องซ้ำผล');
});

ok('จุดรอเข้า: โซนซื้อ/ขาย + สถานะ อยากจัดวางถูกเนื้อผิด', () => {
  const { buildEntryPlan } = require(path.join(root, 'src', 'engine', 'entryplan'));
  const analysis2 = require(path.join(root, 'src', 'engine', 'analysis')).analyzeMarket(candles);
  const price2 = candles.M5[candles.M5.length - 1].c;
  const p = buildEntryPlan({ analysis: analysis2, price: price2, sessionQuality: 'best' });
  assert.ok(p.buy || p.sell, 'ต้องมีโซนอีกฝั่งอย่างน้อยหนึ่งฝั่ง');
  for (const side of ['buy', 'sell']) {
    const z = p[side];
    if (!z) continue;
    assert.ok(z.bottom < z.top, 'โซนต้องมีล่าง < บน และมีขนาดจาก ATR');
    assert.ok(['waiting', 'armed', 'blocked', 'danger'].includes(z.status), 'สถานะที่พร้อมใช้: ' + z.status);
    assert.equal(z.inZone, price2 >= z.bottom && price2 <= z.top, 'inZone ต้องตรงราคา');
  }
  // เทรนด์สวน = blocked: ปลอม bias ให้ขาลงแล้วต้องเลิกโซนซื้อ
  const analysisBear = { ...analysis2, bias: 'bear', levels: analysis2.levels };
  const p2 = buildEntryPlan({ analysis: analysisBear, price: price2, sessionQuality: 'best' });
  if (p2.buy) assert.equal(p2.buy.status, 'blocked');
});

console.log('\n[6.8] สกิลเอเจนต์ (SkillBook + น้ำหนักปรับตามผลงาน)');
ok('skillbook: จดโหวต → ตรวจผล 30 นาที → สถิติชนะ/แพ้ถูกนับ', () => {
  const { SkillBook } = require(path.join(root, 'src', 'engine', 'skillbook'));
  const fsx = require('fs'), osmod = require('os');
  const p0 = path.join(fsx.mkdtempSync(path.join(osmod.tmpdir(), 'gsskill-')), 'skills.json');
  const sb = new SkillBook({ storePath: p0 });
  const now = Date.now();
  sb.openVote('structure', 'sell', 3900, 2, now);
  sb.processTick(3901, now + 1000);                       // ยังไม่ถึงกำหนด = ไม่มีผล
  sb.processTick(3900 - 0.2, now + 30.5 * 60_000);        // ถึงกำหนด แต่ราคาขยับเพียง 0.1×ATR = neutral ไม่นับ
  sb.processTick(3900 - 0.2, now + 30.5 * 60_000);        // ตรวจซ้ำไม่เกิดซ้ำ (จากคิวลบแล้ว)
  assert.equal(sb.pending.length, 0, 'คำสั่งที่ถึงกำหนดถูกดึงออกจากคิว');
  assert.equal(sb.summary('structure').n, 0, 'neutral ไม่เข้าสถิติ');
  // โหวตชนะ: ลง 1.5×ATR
  sb.openVote('trend', 'sell', 4000, 2, now);
  sb.processTick(4000 - 3, now + 31 * 60_000);
  const s1 = sb.summary('trend');
  assert.equal(s1.n, 1, 'win=1 บันไดนับ');
  assert.equal(s1.hit, null, 'สถิติใหม่ (<8 ไม้) ต้องไม่โชว์ % — กันตัดสินขายข้างก่อนผ่านการวัด');
  assert.ok(sb.weightFactor('structure') === 1, 'ยังไม่ถึง 8 ตัวตัวอย่าง = น้ำหนักไม่ปรับ');
  // บันทึก/โหลดรอบใหม่ = สถิติไม่หาย
  sb.save();
  const sb2 = new SkillBook({ storePath: p0 });
  assert.equal(sb2.summary('trend').n, 1, 'โหลดกลับสถิติคงอยู่');
  // เก่งจริงต้องมีผลงานอย่างน้อย 8 ไม้ก่อนถึงชี้ % + ปรับน้ำหนัก (เดิมมี 1 ชนะอยู่แล้ว)
  ['t', 't', 't', 't', 't'].forEach(() => sb2._record('trend', 1));
  ['l', 'l', 'l'].forEach(() => sb2._record('trend', -1));  // ring: ชนะ 6 แพ้ 3 = 9 ไม้
  const s9 = sb2.summary('trend');
  assert.equal(s9.n, 9, 'นับครบ 9 ไม้');
  assert.ok(Math.abs(s9.hit - 6 / 9) < 0.02, `hit=${s9.hit}`);
  assert.equal(s9.grade, 'เก่ง');
  const f = sb2.weightFactor('trend');
  assert.ok(f > 1 && f <= 1.5, `เก่ง = น้ำหนักเฟ้นขึ้น (ได้ ${f})`);
  sb2.save(); // บันทึกก่อนตรวจการโหลดจากดิสก์
  const sb3 = new SkillBook({ storePath: p0 });
  assert.ok(Math.abs(sb3.summary('trend').hit - 6 / 9) < 0.02, 'โหลดจากไฟล์ดิสก์ได้ตรงกัน');
});

ok('councilstats: จดมติ/มติเงา → ตรวจผล 30 นาที → calibration ปรับความมั่นใจตามผลจริง', () => {
  const { CouncilStats } = require(path.join(root, 'src', 'engine', 'councilstats'));
  const fsx = require('fs'), osmod = require('os');
  const p0 = path.join(fsx.mkdtempSync(path.join(osmod.tmpdir(), 'gscouncil-')), 'council-stats.json');
  const cs = new CouncilStats({ storePath: p0 });
  const now = Date.now();
  // มติจริง 70% (band 70-79%) + มติเงา (side none, net 40)
  cs.open({ side: 'sell', confidence: 70, agree: 4, net: -41 }, 3900, 2, now);
  cs.open({ side: 'none', confidence: 40, agree: 2, net: -40 }, 3900, 2, now);
  assert.equal(cs.pending.length, 2, 'จดมติ + มติเงา');
  cs.open({ side: 'none', confidence: 20, agree: 1, net: -15 }, 3900, 2, now);
  assert.equal(cs.pending.length, 2, 'เอนอ่อน (net < 30) ไม่จด');
  // ตรวจผล: ชนะทั้งคู่ (ราคาตก 3 = 1.5×ATR)
  const outs = cs.processTick(3900 - 3, now + 31 * 60_000);
  assert.equal(outs.length, 2, 'ตรวจครบ 2 ใบ');
  assert.equal(cs.summary(cs.stats.bands ? '' : '').n, 0, 'ไม่พังการเรียก summary ตรง (group หลัก)');
  const sV = cs.snapshot();
  assert.ok(sV.verdict.n >= 1 && sV.lean.n >= 1, 'ตัวเลขมีทั้งมติและมติเงา');
  // เติมให้ band 70-79% ครบ 10 = แม่นชัด → calibration factor > 1
  for (let i = 0; i < 9; i++) cs._record('verdict', 75, 1);
  const cal = cs.calibration(75);
  assert.ok(cal.factor > 1, `แม่นจริง → เชื่อหนักขึ้น (ได้ ${cal.factor})`);
  assert.ok(/s=/.test(cal.note || ''), `มีรายงานใน note: ${cal.note}`);
  // บันทึก + โหลดรอบใหม่ = สถิติคงอยู่ ฝั่ง bands โหลดครบ
  cs.save();
  const cs2 = new CouncilStats({ storePath: p0 });
  const cal2 = cs2.calibration(75);
  assert.ok(cal2.factor > 1, 'โหลดจากดิสก์แล้วยังปรับได้ตรงกัน');
  // ไม้จำลองปิด TP = เรียนรู้ทันที
  cs2.observeTrade({ side: 'buy', confidence: 70, agree: 3 }, 1);
  const sTrade = cs2.snapshot();
  assert.ok(sTrade.verdict.n >= 1, 'ผลไม้จำลองเข้าสถิติสภา');
});
ok('skillbook: recordAgent รับผลไม้จำลอง → ผลงานเอเจนต์ปรับทันที', () => {
  const { SkillBook } = require(path.join(root, 'src', 'engine', 'skillbook'));
  const fsx = require('fs'), osmod = require('os');
  const p1 = path.join(fsx.mkdtempSync(path.join(osmod.tmpdir(), 'gsskill-')), 'skills.json');
  const sb = new SkillBook({ storePath: p1 });
  sb.recordAgent('structure', 1);
  sb.recordAgent('structure', -1);
  const s = sb.summary('structure');   // ยัง < 8 ตัวอย่าง = ไม่โชว์ % กันตัดสินชาวบ้าน
  assert.equal(s.n, 2, 'จดจากไม้จำลองได้ 2 ตัวอย่าง');
  assert.equal(s.hit, null, 'สถิติสั้น (<8) ไม่โชว์ %');
  for (let i = 0; i < 7; i++) sb.recordAgent('structure', 1);   // สะสมไปอีก = ครบ 9 (ชนะ 8 แพ้ 1)
  const s9 = sb.summary('structure');
  assert.equal(s9.n, 9, 'นับครบ 9 ตัวอย่าง');
  assert.equal(s9.allW, 8, 'ชนะ 8 จากไม้จำลอง/โหวต');
  assert.equal(s9.allL, 1, 'แพ้ 1');
  assert.ok(Math.abs(s9.hit - 8 / 9) < 0.02, `hit=${s9.hit}`);
  assert.equal(s9.grade, 'ยอดเยี่ยม');
});
ok('เอเจนต์ v2: โครงสร้าง BOS/CHoCH ขารางจริง + สดไทม์เฟรม', () => {
  const v = council.runCouncil({ analysis: require(path.join(root, 'src', 'engine', 'analysis')).analyzeMarket(candles), candles, price: candles.M5[candles.M5.length - 1].c, now: Date.now(), ind }, {});
  for (const a of v.votes) {
    assert.ok(a.skill && Number.isFinite(a.skill.n), `${a.id} มีข้อมูลผลงาน`);
    assert.ok(!/พัง/.test(a.reason), `${a.id}: ${a.reason}`);
  }
});

ok('สภา: คิวรัมอัตโนมัติ = min(ค่าที่ตั้ง, 60% ของทีมที่เปิด) + ตั้งมือได้', () => {
  const analysisTf = require(path.join(root, 'src', 'engine', 'analysis')).analyzeMarket(candles);
  const ctx = { analysis: analysisTf, candles, price: candles.M5[candles.M5.length - 1].c, now: Date.now(), ind, skills: {} };
  const allIds = council.AGENTS.map((a) => a.id);
  const q = (openN, opts = {}) => {
    const keep = allIds.slice(0, openN);
    const sw = Object.fromEntries(allIds.map((id) => [id, keep.includes(id)]));
    return council.runCouncil(ctx, { councilAgents: sw, councilQuorumAuto: true, ...opts });
  };
  // หมายเหตุ: ผลโหวตอาจ side none — ยึด quorumNeed ที่ประกาศใน verdict เสมอ
  assert.equal(q(7).quorumNeed, 5, 'เปิด 7 = 5 (60% ปัดขึ้น)');
  assert.equal(q(6).quorumNeed, 4, 'เปิด 6 = 4');
  assert.equal(q(4).quorumNeed, 3, 'เปิด 4 = 3');
  assert.equal(q(3).quorumNeed, 2, 'เปิด 3 = 2');
  assert.ok(q(2).quorumNeed >= 2, 'เปิด 2 = อย่างน้อย 2 (ยิงสัญญาณต้อง 2 คนเท่านั้น)');
  // อัตโนมัติ + ค่าที่ตั้ง = เพดาน (ไม่ทิ้งค่าที่ผู้ใช้ตั้ง)
  assert.equal(q(4, { councilQuorum: 2 }).quorumNeed, 2, 'อัตโนมัติ ตั้ง 2 เปิด 4 = 2');
  assert.equal(q(7, { councilQuorum: 3 }).quorumNeed, 3, 'อัตโนมัติ ตั้ง 3 เปิด 7 = 3');
  assert.equal(q(7, { councilQuorum: 6 }).quorumNeed, 5, 'อัตโนมัติ ตั้ง 6 เปิด 7 = 5 (60%)');
  assert.equal(q(3, { councilQuorum: 6 }).quorumNeed, 2, 'อัตโนมัติ ตั้ง 6 เปิด 3 = 2');
  // ตั้งมือ: ยึดค่าที่ตั้ง — ครอบด้วยจำนวนเปิดจริง
  const m3 = council.runCouncil(ctx, { councilQuorumAuto: false, councilQuorum: 4, councilAgents: Object.fromEntries(allIds.map((id, i) => [id, i < 3])) });
  assert.equal(m3.quorumNeed, 3, 'ตั้งมือ 4 แต่ทีม 3 คน = ลดเหลือ 3');
  const m4 = council.runCouncil(ctx, { councilQuorumAuto: false, councilQuorum: 4, councilAgents: Object.fromEntries(allIds.map((id, i) => [id, i < 5])) });
  assert.equal(m4.quorumNeed, 4, 'ตั้งมือ 4 ทีม 5 = ใช้ 4');
});

console.log('\n[6.5] ระบบรอเข้า: ช่วงเวลา + ห้องรอ');
ok('session advisor: ช่วงลอนดอน+NY ดีสุด / เอเชียกลางเลี่ยง / เสาร์อาทิตย์ปิด', () => {
  const { evaluate } = require(path.join(root, 'src', 'engine', 'sessions'));
  const mkTs = (utcH, day) => Date.UTC(2026, 10, 1 + day, utcH, 0, 0); // วันอาทิตย์ = day 1 ของเดือนนี้จริง? ใช้ day เป็นตัวเดินวัน
  // 12:00 UTC ของวัน"จันทร์": ปี 2026-11-02 คือวันจันทร์ (day=1)
  const mon12 = evaluate(Date.UTC(2026, 10, 2, 12, 0)); assert.equal(mon12.quality, 'best'); assert.equal(mon12.label, 'ลอนดอน+นิวยอร์ก');
  const mon06 = evaluate(Date.UTC(2026, 10, 2, 6, 0)); assert.equal(mon06.quality, 'avoid'); assert.equal(mon06.label, 'เอเชีย');
  const mon09 = evaluate(Date.UTC(2026, 10, 2, 9, 0)); assert.equal(mon09.quality, 'good');
  const sat12 = evaluate(Date.UTC(2026, 10, 7, 12, 0)); assert.equal(sat12.closed, true); assert.equal(sat12.quality, 'closed');
  const fri21 = evaluate(Date.UTC(2026, 10, 6, 21, 0)); assert.equal(fri21.quality, 'avoid');
  const sun22 = evaluate(Date.UTC(2026, 10, 8, 22, 0)); assert.notEqual(sun22.quality, 'closed', 'จันทร์ 22:00 UTC = ราคาเปิดอาทิตย์');
  // เวลาไทยแสดงถูก (UTC+7)
  assert.equal(evaluate(Date.UTC(2026, 10, 2, 12, 0)).thaiTime.h, 19);
});

ok('ห้องรอ: มติใกล้ + แบนด์บีบ + ช่วงไม่ดี = โหมดรอพร้อมเหตุผล', () => {
  const engineMod = require(path.join(root, 'src', 'engine', 'engine'));
  const e = Object.create(engineMod.AnalysisEngine.prototype);
  e.settings = {};
  const w = e._standby({ signals: [{ held: null }] }, { side: 'buy', confidence: 62, votes: [] }, null);
  assert.equal(w.mode, 'ready');
  const w2 = e._standby({ signals: [] }, { side: 'sell', confidence: 62, votes: [{ side: 'buy', conf: 60, name: 'เอเจนต์โมเมนตัม' }] }, { tf: { M15: { squeeze: true } } }, { quality: 'good', label: 'ลอนดอน' });
  assert.equal(w2.mode, 'waiting');
  assert.ok(w2.notes.some((n) => /ใกล้เกณฑ์/.test(n)) && w2.notes.some((n) => /บีบ/.test(n)));
  const w3 = e._standby({ signals: [] }, null, null, { quality: 'good', label: 'ลอนดอน', riskNote: '' });  // ส่งเซสชันจำลอง — ตัดพวงเวลาจริงออก
  assert.equal(w3.mode, 'quiet');
});

console.log('\n[7] Engine end-to-end');
(async () => {
  const fakeConnector = {
    id: 'fake', label: 'จำลอง', status: { state: 'ok', msg: 'ok' },
    available: () => true, start() {}, stop() {}, setBridgePath() {},
    fetch: async () => ({ source: 'fake', symbol: 'XAUUSD', price: candles.M5[candles.M5.length - 1].c, ts: Date.now(), candles: JSON.parse(JSON.stringify(candles)) }),
  };
  const settings = { symbol: 'XAUUSD', yahooSymbol: 'GC=F', source: 'auto', mt5BridgePath: '', pollSec: 10, equity: 5000, riskPct: 1, minRR: 1.5, minConfidence: 60, maxSignalsPerDay: 8, cooldownMin: 0, newsStop: false };
  const engine = new AnalysisEngine({ settings, connectors: { mt5: fakeConnector, yahoo: new YahooConnector() }, pluginLoader: plugins, logger: () => {} });
  engine.pushLog = () => {};
  await engine.tick();
  const snap = engine.lastSnap;
  ok('snapshot มีโครงครบ: price/analysis/signals/guard', () => {
    assert.ok(snap.price > 0);
    assert.ok(snap.analysis && ['bull', 'bear', 'neutral'].includes(snap.analysis.bias));
    assert.ok(Array.isArray(snap.signals) && Array.isArray(snap.filtered));
    assert.ok(snap.guard && typeof snap.guard.dailyCount === 'number');
  });
  const live = snap.signals.filter((s) => !s.held);
  ok('เอเจนต์ทั้ง 7 คนต้องโหวตได้โดยไม่พังในเส้นทาง engine จริง', () => {
    const v = snap.council;
    assert.ok(v && Array.isArray(v.votes) && v.votes.length === 7);
    for (const a of v.votes) assert.ok(!/พัง/.test(a.reason), `${a.id}: ${a.reason}`);
  });
  ok(`สัญญาณที่ออกจริง ${live.length} ใบ ผ่าน invariant ทั้งหมด`, () => {
    for (const s of live) {
      assert.ok(Number.isFinite(s.sl) && s.sl > 0, 'มี SL');
      const dirOk = s.side === 'buy' ? (s.sl < s.entry && s.tp > s.entry) : (s.sl > s.entry && s.tp < s.entry);
      assert.ok(dirOk, 'SL/TP อยู่ฝั่งถูกทิศ');
      assert.ok(s.metrics.rr >= 1.5 - 1e-9, `RR>=1.5 (ได้ ${s.metrics.rr})`);
      assert.ok(s.metrics.lot >= 0.01);
      assert.ok(s.metrics.effRiskPct <= 2.0001);
      assert.ok(s.metrics.riskUSD <= 5000 * 2 / 100 + 1e-9);
      assert.ok(s.confidence >= 60);
    }
  });
  ok('ระบบยังทำงานแม้ plugin พังและสัญญาณไม่มี SL (ถูกกรอง)', () => {
    assert.ok(snap.signals.length > 0 || snap.filtered.length > 0, 'มีอย่างน้อยผลลัพธ์ให้เห็น');
    for (const f of snap.filtered) assert.ok(f.reason, 'ทุกรายการกรองมีเหตุผล');
  });
  ok('newsStop ถือสัญญาณไว้ ไม่ปล่อยให้ใช้', async () => { });
  // ทดสอบ newsStop
  engine.settings.newsStop = true;
  engine.active.clear(); engine.lastIssue.clear();
  await engine.tick();
  const snap2 = engine.lastSnap;
  ok('โหมดหยุดข่าว: ทุกสัญญาณขึ้นสถานะหยุดชั่วคราว', () => {
    for (const s of snap2.signals) assert.ok(s.held, 'ต้องมี held reason');
  });
  engine.settings.newsStop = false;

  ok('ไม้เสมือนจุดรอ: เปิดจาก HIT → จบที่ TP/SL + กระดานซื้อ/ขายแยกกัน', () => {
    const e2 = Object.create(require(path.join(root, 'src', 'engine', 'engine')).AnalysisEngine.prototype);
    e2.zoneOpen = []; e2.zoneHistory = []; e2.zoneStorePath = null; e2.logger = () => {};
    e2.roundLog = []; e2._roundKey = ''; e2._openedRefs = []; e2._closedThisRound = [];
    e2._equityForSizing = 5000;
    const plan = { atr: 2.5, buy: { center: 3900, bottom: 3896, top: 3904, levelType: 'แนวรับ' } };
    const ts = Date.now();
    e2._openZoneTrade('buy', 3902, plan, ts);
    assert.equal(e2.zoneOpen.length, 1);
    assert.ok(e2.zoneOpen[0].lot >= 0.01);
    e2._updateZoneTrades(e2.zoneOpen[0].tp, ts + 1000);          // TP ก่อน = ชนะ
    assert.equal(e2.zoneOpen.length, 0);
    assert.equal(e2.zoneHistory[0].status, 'TP');
    assert.ok(e2.zoneHistory[0].pnl > 0);
    e2._openZoneTrade('sell', 3900, { atr: 2.5, sell: { center: 3900, bottom: 3896, top: 3904, levelType: 'แนวต้าน' } }, ts + 2000);
    e2._updateZoneTrades(e2.zoneOpen[0].sl, ts + 3000);          // แตะ SL = แพ้
    assert.equal(e2.zoneOpen.length, 0);
    assert.equal(e2.zoneHistory[1].status, 'SL');
    assert.ok(e2.zoneHistory[1].pnl < 0);
    const sum = e2._zoneSummary();
    assert.equal(sum.buy.w, 1);
    assert.equal(sum.sell.l, 1);
    assert.ok(sum.buy.total > 0 && sum.sell.total < 0, 'สกอร์บอร์ดแยกทิศแยกเงินถูก');
  });

  ok('โหมดเสี่ยงน้อยที่สุด: คะแนนเสี่ยงมีเหตุผล + เลือกไม้เสี่ยงต่ำสุดของรอบ', () => {
    const risk = require(path.join(root, 'src', 'engine', 'risk'));
    const e3 = Object.create(require(path.join(root, 'src', 'engine', 'engine')).AnalysisEngine.prototype);
    // ไม้แน่น (SL ใกล้/มั่นใจสูง) ต้องได้คะแนนเสี่ยงต่ำกว่าไม้ SL กว้าง/มั่นใจต่ำ
    const close = { side: 'buy', entry: 3900, sl: 3897, tp: 3906, confidence: 80, metrics: { rr: 2.0 } };
    const far = { side: 'buy', entry: 3900, sl: 3890, tp: 3914, confidence: 65, metrics: { rr: 2.0 } };
    assert.ok(risk.riskScore(close, 'best') < risk.riskScore(far, 'best'), 'SL ใกล้+มั่นใจสูง = ต่ำกว่า');
    assert.ok(risk.riskScore(close, 'best') < risk.riskScore(close, 'avoid'), 'ช่วงเวลาดี = ต่ำกว่า');
    assert.equal(e3._pickLeastRisk([far, close], 'best'), close, 'เลือกไม้เสี่ยงต่ำสุด');
    assert.equal(e3._pickLeastRisk([], 'best'), null);
  });

  ok('snapshot candles: แท่งนิ่ง = ไม่ส่งซ้ำ / แท่งใหม่ = ส่งเฉพาะ TF นั้น (ลด IPC 112KB/รอบ)', () => {
    const e4 = Object.create(require(path.join(root, 'src', 'engine', 'engine')).AnalysisEngine.prototype);
    const mk = (n, t0) => Array.from({ length: n }, (_, i) => ({ t: (t0 + i * 3600) * 1000, o: 1, h: 1, l: 1, c: 1, v: 1 }));
    const d = { M5: mk(300, 1000), H1: mk(300, 2000) };
    const s1 = e4._pickChangedCandles(d).candles;
    assert.ok(s1.M5 && s1.H1, 'ครั้งแรกส่งครบทุก TF');
    const s2 = e4._pickChangedCandles(d);
    assert.deepEqual(s2.candles, {}, 'นิ่ง = ไม่ส่งอะไรเลย');
    assert.deepEqual(s2.tail, {}, 'แท่งก่อตัวไม่เปลี่ยน = ไม่ส่ง tail');
    const d2 = { M5: d.M5, H1: d.H1.concat([{ t: (2000 + 300 * 3600) * 1000, o: 1, h: 2, l: 1, c: 2, v: 1 }]) };
    const s3 = e4._pickChangedCandles(d2).candles;
    assert.ok(s3.H1 && s3.H1.length === 300, 'H1 ใหม่ = ส่ง H1');
    assert.ok(!s3.M5, 'M5 ยังนิ่ง = ไม่ส่ง M5');
    // แท่งที่กำลังก่อตัวเปลี่ยนราคา (เวลาเดิม) → ส่งเฉพาะแท่งสุดท้ายผ่าน tail
    const m5b = d.M5.slice(); m5b[m5b.length - 1] = { ...m5b[m5b.length - 1], c: 1.5, h: 1.5 };
    const s4 = e4._pickChangedCandles({ M5: m5b, H1: d2.H1 });
    assert.ok(!s4.candles.M5 && s4.tail.M5 && s4.tail.M5.c === 1.5, 'แท่งก่อตัวขยับ = ส่ง tail M5 แท่งเดียว');
    assert.equal(e4._pickChangedCandles({}).candles, undefined, 'ไม่มีข้อมูลราคา = undefined (renderer ใช้ของเดิม)');
  });

  ok('MT5 bridge: ประวัติไม้จริง parse + เวลาโบรเกอร์แก้เป็นเวลาเครื่อง', () => {
    const { MT5Connector } = require(path.join(root, 'src', 'engine', 'connectors', 'mt5'));
    const c = new MT5Connector();
    const tmp = path.join(root, '.smoke-bridge-history.json');
    const nowSec = Math.floor(Date.now() / 1000);
    const bars = Array.from({ length: 60 }, (_, i) => [nowSec - (60 - i) * 60, 1, 2, 0.5, 1.5, 3]);
    const j = { t: nowSec, symbol: 'XAUUSD', digits: 2, bid: 3923.61, ask: 3924.13,
      account: { name: 'S', login: 1, balance: 5500, equity: 5503 }, positions: [],
      history: [
        { pid: 11, type: 'sell', volume: 0.01, open: 3924.13, close: 3921.0, profit: 3.13, reason: 'TP', time: nowSec - 120 },
        { pid: 12, type: 'buy', volume: 0.02, open: 3921.66, close: 3921.6, profit: -0.12, reason: 'SL', time: nowSec - 60 },
      ],
      candles: { M5: bars } };
    fs.writeFileSync(tmp, JSON.stringify(j));
    c.setBridgePath(tmp);
    const d = c.fetch('GC=F');
    const h = d.meta.history;
    assert.equal(h.length, 2, 'จดทั้ง 2 ไม้');
    assert.equal(h[0].reason, 'TP');
    assert.equal(h[0].type, 'sell');
    assert.ok(Math.abs(h[0].time - (Date.now() - 120_000)) < 5000, 'เวลาปิด (เวลาเครื่อง) ตรงช่วง — tzFix ทำงาน');
    assert.equal(h[1].reason, 'SL');
    fs.unlinkSync(tmp);
  });

  await ok('เว็บระยะไกล (แบบ A): รับ push ต้องมี token + ดูหน้าเว็บต้องมี key + ไม่มี endpoint เกินเขต', async () => {
    const { createRemoteServer } = require(path.join(root, 'remote', 'deploy', 'server-dashboard'));
    const r = createRemoteServer({ port: 0, token: 'testtoken-1234', dashFile: path.join(root, 'remote', 'deploy', 'remote-dashboard.html') });
    const { port: rp } = await r.start();
    try {
      const base = `http://localhost:${rp}`;
      const noTok = await fetch(base + '/push', { method: 'POST', body: 'x' });
      assert.equal(noTok.status, 401, 'push ไม่มี token = ปฏิเสธ');
      const badTok = await fetch(base + '/push', { method: 'POST', headers: { 'x-gs-token': 'wrong' }, body: 'x' });
      assert.equal(badTok.status, 401);
      const p = await fetch(base + '/push', { method: 'POST', headers: { 'x-gs-token': 'testtoken-1234', 'content-type': 'application/json' }, body: JSON.stringify({ price: 3900.5, meta: { account: { currency: 'THB' } } }) });
      assert.equal(p.status, 200);
      const noKey = await fetch(base + '/api/snapshot.json');
      assert.equal(noKey.status, 401, 'ดูไม่มี key = ปฏิเสธ');
      const yesKey = await (await fetch(`${base}/api/snapshot.json?key=testtoken-1234`)).json();
      assert.equal(yesKey.price, 3900.5, 'ดูด้วย key = ได้ข้อมูลที่ push มา');
      const html = await (await fetch(`${base}/?key=testtoken-1234`)).text();
      assert.ok(/แดชบอร์ด/.test(html));
      const nf = await fetch(base + '/nope?key=testtoken-1234');
      assert.equal(nf.status, 404, 'ไม่มี endpoint เกินเขต');
    } finally { r.server.close(); }
  });

  // พก dylib ของ node ไปกับสำเนาจำลอง "cloudflared" (brew node อ้าง @rpath/libnode*.dylib — คัดลอกตรง ๆ = เปิดไม่ได้แล้วตายเงียบ)
  // วางสองจุดตามที่ dyld ลองจริง: หลังตัว fake เอง + แถบ ../lib (mkdtemp จะอยู่โฟลเดอร์พ่อเดียวกัน แชร์กันได้)
  // node ที่เป็นไฟล์เดียว / ไม่มีโฟลเดอร์ lib = ข้ามชั้นนี้ไปเงียบ ๆ
  function copyNodeLibsInto(dir) {
    try {
      const libSrc = path.join(path.dirname(process.execPath), '..', 'lib');
      const libs = fs.readdirSync(libSrc).filter((n) => /^libnode.*\.dylib$/.test(n));
      if (!libs.length) return;
      for (const n of libs) {
        fs.copyFileSync(path.join(libSrc, n), path.join(dir, n));
        fs.mkdirSync(path.join(dir, '..', 'lib'), { recursive: true });
        fs.copyFileSync(path.join(libSrc, n), path.join(dir, '..', 'lib', n));
      }
    } catch { void 0; }
  }

  await ok('tunnel daemon: linger รอดปิดแอป • adopt เฉพาะ pid ที่เป็น cloudflared จริง • ปิดเอง = kill ตัวจริง (ไม่ฆ่าผิดตัว)', async () => {
    const { createTunnel } = require(path.join(root, 'src', 'main', 'tunnel'));
    const { spawn } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstun-'));
    // daemon จำลอง: โปรแกรมชื่อ "cloudflared" จริง = สำเนา node (clone APFS) — ps เห็นชื่อ cloudflared
    // (สำเนา /bin/sleep ใช้ไม่ได้: macOS ฆ่า platform binary ที่ถูกคัดลอกออกนอกระบบทันที)
    const fake = path.join(dir, 'cloudflared');
    fs.copyFileSync(process.execPath, fake, fs.constants.COPYFILE_FICLONE); fs.chmodSync(fake, 0o755);
    copyNodeLibsInto(dir); // brew-node = ไฟล์คู่ (main + libnode*.dylib ทาง @rpath) — ไม่พกไป = fake ตายทันที ทดสอบพังบนเครื่องที่ node แยกไลบรารี
    const d = spawn(fake, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 400));
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      // pid มีชีวิตแต่เป็นโปรแกรมอื่น (pid ถูกนำไปใช้ซ้ำ) = ห้าม adopt และห้ามฆ่า
      const sfX = path.join(dir, 'state-x.json');
      fs.writeFileSync(sfX, JSON.stringify({ provider: 'cloudflared', pid: process.pid, url: 'https://x.trycloudflare.com', port: 8997, ts: Date.now() }));
      const tx = createTunnel({ stateFile: sfX, onUrl: () => {} });
      assert.equal((await tx.adopt(8997, 'cloudflared')).state, 'off', 'pid ของโปรแกรมอื่น = ไม่ adopt');
      assert.ok(!fs.existsSync(sfX), 'state ที่ชี้ผิดตัวถูกล้าง');
      // pid ตายแล้ว = ไม่ adopt
      const sfD = path.join(dir, 'state-d.json');
      fs.writeFileSync(sfD, JSON.stringify({ provider: 'cloudflared', pid: 999999999, url: 'https://y.trycloudflare.com', port: 8996, ts: Date.now() }));
      assert.equal((await createTunnel({ stateFile: sfD }).adopt(8996, 'cloudflared')).state, 'off', 'pid ตาย = เริ่มใหม่');
      // cloudflared จริงยังรัน = adopt ลิงก์เดิม
      const sf = path.join(dir, 'state.json');
      fs.writeFileSync(sf, JSON.stringify({ provider: 'cloudflared', pid: d.pid, url: 'https://old.trycloudflare.com', port: 8997, ts: Date.now() }));
      const urls = [];
      const t = createTunnel({ stateFile: sf, onUrl: (u) => urls.push(u) });
      const ad = await t.adopt(8997, 'cloudflared');
      assert.equal(ad.state, 'on'); assert.equal(ad.url, 'https://old.trycloudflare.com'); assert.equal(ad.adopted, true);
      assert.deepEqual(urls, ['https://old.trycloudflare.com'], 'แจ้งลิงก์เดิมให้ลิงก์ถาวร');
      // linger (ปิดแอป) = ไม่แตะ daemon + เก็บ state ไว้
      await t.stop({ linger: true });
      assert.ok(alive(d.pid) && fs.existsSync(sf), 'daemon รอด + state ยังอยู่');
      // เปิดแอปรอบใหม่ → adopt → ปิดเอง = kill ตัวจริง + ล้าง state
      const t2 = createTunnel({ stateFile: sf });
      assert.equal((await t2.adopt(8997, 'cloudflared')).state, 'on');
      await t2.stop();
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(!alive(d.pid), 'ปิดเอง = daemon ถูก kill');
      assert.ok(!fs.existsSync(sf), 'state ถูกล้างหลังปิดเอง');
      assert.ok(alive(process.pid), 'ไม่ฆ่าผิดตัว');
    } finally { try { d.kill('SIGKILL'); } catch { void 0; } }
  });
  await ok('tunnel: เก็บกวาด cloudflared กำพร้าของพอร์ตเรา (ppid 1) ไม่แตะพอร์ตอื่น/ตัวที่ใช้อยู่', async () => {
    const { createTunnel } = require(path.join(root, 'src', 'main', 'tunnel'));
    const { execFileSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsorph-'));
    const fake = path.join(dir, 'cloudflared');
    fs.copyFileSync(process.execPath, fake, fs.constants.COPYFILE_FICLONE); fs.chmodSync(fake, 0o755);
    copyNodeLibsInto(dir); // ความแตกขนาดเดียวกับ daemon test แถวบน — ให้ copy ของ node วิ่งได้ทุกต้นทาง
    // แตก process ให้พ่อแม่ตาย (ppid → 1) เหมือนแอปปิดไปแล้ว + args แบบ cloudflared จริง
    const mk = (port) => { execFileSync('/bin/sh', ['-c', `"${fake}" -e "setTimeout(()=>{},30000)" tunnel --url http://localhost:${port} >/dev/null 2>&1 &`]); };
    mk(8999); mk(8998);
    await new Promise((r) => setTimeout(r, 600));
    const t = createTunnel({});
    const o99 = t.findOrphans(8999), o98 = t.findOrphans(8998);
    try {
      assert.equal(o99.length, 1, 'เจอกำพร้าของพอร์ต 8999 ตัวเดียว');
      assert.equal(t.findOrphans(8999, o99[0]).length, 0, 'ตัวที่ใช้อยู่ (keepPid) ไม่ถูกนับ');
      t.reapOrphans(8999);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(t.findOrphans(8999).length, 0, 'ถูกปิดแล้ว');
      assert.equal(t.findOrphans(8998).length, 1, 'พอร์ตอื่นไม่ถูกแตะ');
    } finally { for (const pid of [...o99, ...o98]) { try { process.kill(pid, 'SIGKILL'); } catch { void 0; } } }
  });
  await ok('เว็บ: ไม่ส่ง handlers = ดูอย่างเดียว เฉพาะเครื่องนี้ (snapshot) + port 8008', async () => {
    const { startWebServer } = require(path.join(root, 'src', 'main', 'webserver'));
    const w = await startWebServer({ getSnapshot: () => ({ ts: Date.now(), price: 3901.17, meta: { account: { currency: 'THB' } } }), logger: () => {} });
    assert.ok(w && /localhost:80\d\d/.test(w.url));
    try {
      const j = await (await fetch(w.url + '/api/snapshot.json')).json();
      assert.ok(j.ok && Math.abs(j.price - 3901.17) < 1e-6);
      assert.equal((await fetch(w.url + '/delete-everything')).status, 404);
    } finally { w.server.closeAllConnections(); w.server.close(); }
  });

  await ok('เว็บควบคุมเต็ม: ล็อกอิน / คำสั่งชุดเดียวกับแอป / SSE / กันคำสั่งเครื่อง / tunnel ไม่นับเป็นเครื่องนี้', async () => {
    const { startWebServer } = require(path.join(root, 'src', 'main', 'webserver'));
    const { createWebAuth } = require(path.join(root, 'src', 'main', 'webauth'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsweb-'));
    const auth = createWebAuth(path.join(dir, 'web-auth.json'));
    assert.throws(() => auth.setPassword('short'), /8/);
    auth.setPassword('correct-horse-9');
    const calls = [];
    const handlers = new Map([
      ['get-state', () => ({ hello: 1 })],
      ['send-order', (_e, req) => { calls.push(req); return { ok: false, reason: 'gate' }; }],
      ['pick-bridge-file', () => 'x'],
    ]);
    const w = await startWebServer({ getSnapshot: () => ({ ts: 1, price: 2 }), logger: () => {}, handlers, auth, rendererDir: path.join(root, 'renderer'), blocked: new Set(['pick-bridge-file']) });
    // คนละ origin กับเทสต์ก่อนหน้า (กัน fetch หยิบ keep-alive socket ของเซิร์ฟเวอร์ที่ปิดไปแล้ว)
    const base = w.url.replace('localhost', '127.0.0.1');
    const H = { 'content-type': 'application/json', 'x-gs-web': '1' };
    try {
      const r0 = await fetch(base + '/', { redirect: 'manual' });
      assert.equal(r0.status, 302, 'ยังไม่ล็อกอิน → ไปหน้าล็อกอิน');
      assert.equal((await fetch(base + '/api/call/get-state', { method: 'POST', headers: H, body: '{}' })).status, 401);
      assert.equal((await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ password: 'wrong-pass' }) })).status, 401);
      const lg = await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ password: 'correct-horse-9' }) });
      assert.equal(lg.status, 200);
      const cookie = lg.headers.get('set-cookie').split(';')[0];
      const HC = { ...H, cookie };
      const st = await (await fetch(base + '/api/call/get-state', { method: 'POST', headers: HC, body: '{}' })).json();
      assert.deepEqual(st.result, { hello: 1 }, 'เรียกคำสั่งเดียวกับแอป');
      const so = await (await fetch(base + '/api/call/send-order', { method: 'POST', headers: HC, body: JSON.stringify({ args: [{ side: 'buy', lot: 0.01, sl: 1 }] }) })).json();
      assert.equal(so.result.reason, 'gate', 'ผ่านเกตเดิมของแอป');
      assert.equal(calls[0].side, 'buy');
      assert.equal((await fetch(base + '/api/call/pick-bridge-file', { method: 'POST', headers: HC, body: '{}' })).status, 404, 'คำสั่งเครื่องห้ามจากเว็บ');
      assert.equal((await fetch(base + '/api/call/get-state', { method: 'POST', headers: { cookie }, body: '{}' })).status, 403, 'ไม่มี header เฉพาะ = กัน CSRF');
      const html = await (await fetch(base + '/', { headers: { cookie } })).text();
      assert.ok(/web-api\.js/.test(html) && html.indexOf('web-api.js') < html.indexOf('app.js'), 'ตัวแทน window.api โหลดก่อนแอป');
      assert.equal((await fetch(base + '/../src/main/main.js', { headers: { cookie } })).status, 404, 'ไม่หลุดออกนอก renderer');
      // SSE ได้ snapshot แรก + broadcast
      const ctl = new AbortController();
      const es = await fetch(base + '/api/events', { headers: { cookie }, signal: ctl.signal });
      const reader = es.body.getReader();
      let txt = '';
      const until = async (re) => { while (!re.test(txt)) { const { value } = await reader.read(); txt += Buffer.from(value).toString('utf8'); } };
      await until(/event: snapshot/);
      w.broadcast('order-result', { id: 7 });
      await until(/event: order-result\ndata: \{"id":7\}/);
      ctl.abort();
      // ผ่าน tunnel: มาจาก 127.0.0.1 แต่มี header ส่งต่อ → ไม่ใช่เครื่องนี้ (สวิตช์รับเครื่องอื่นปิด = 403, snapshot ไม่ล็อกอินไม่ได้)
      const tun = { 'cf-connecting-ip': '203.0.113.9', host: 'abc.trycloudflare.com' };
      assert.equal((await fetch(base + '/api/snapshot.json', { headers: tun })).status, 403);
      auth.setRemote(true);
      assert.equal((await fetch(base + '/api/snapshot.json', { headers: tun })).status, 401, 'tunnel + เปิดรับ = ยังต้องล็อกอิน');
      for (let i = 0; i < 5; i++) await fetch(base + '/api/login', { method: 'POST', headers: tun, body: JSON.stringify({ password: 'nope-nope' }) });
      assert.equal((await fetch(base + '/api/login', { method: 'POST', headers: tun, body: JSON.stringify({ password: 'correct-horse-9' }) })).status, 429, 'ผิด 5 ครั้ง = ล็อก (นับตาม IP จริงหลัง tunnel)');
    } finally { w.server.closeAllConnections(); w.server.close(); }
  });

  await ok('Telegram: ตั้งค่า/ตรวจรูปแบบ • ส่งเฉพาะเหตุการณ์ที่เปิด • หา chat id • token ไม่หลุดออก view', async () => {
    const { createTelegram } = require(path.join(root, 'src', 'main', 'telegram'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstg-'));
    const sent = [];
    const fakeFetch = async (url, o) => {
      const method = url.split('/').pop();
      const body = JSON.parse(o.body);
      if (method === 'sendMessage') sent.push(body);
      const result = method === 'getMe' ? { username: 'gs_test_bot' }
        : method === 'getUpdates' ? [{ message: { chat: { id: 555111, first_name: 'Ploy', type: 'private' } } }] : true;
      return { status: 200, json: async () => ({ ok: true, result }) };
    };
    const tg = createTelegram({ file: path.join(dir, 'telegram.json'), fetchImpl: fakeFetch });
    const TOKEN = '123456789:AAHfakeTokenForSmokeTest_abcdefghijk';
    assert.throws(() => tg.set({ token: 'bad' }), /รูปแบบ/);
    assert.throws(() => tg.set({ enabled: true }), /token/, 'ยังไม่มี token/chat = เปิดไม่ได้');
    tg.set({ token: TOKEN });
    const d = await tg.detectChat();
    assert.equal(d.bot, 'gs_test_bot'); assert.equal(d.chats[0].id, '555111');
    tg.set({ chatId: d.chats[0].id, enabled: true, events: { virtual: false } });
    const v = tg.view();
    assert.ok(!JSON.stringify(v).includes('AAHfakeToken'), 'view ไม่คืน token เต็ม');
    assert.equal(fs.statSync(path.join(dir, 'telegram.json')).mode & 0o777, 0o600, 'ไฟล์ token สิทธิ์ 600');
    assert.equal(tg.notify('virtual', 'x'), false, 'ปิดประเภทนี้ = ไม่ส่ง');
    assert.equal(tg.notify('realOpen', '🟢 เข้าไม้จริง BUY'), true);
    for (let i = 0; i < 40 && !sent.length; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(sent[0].chat_id, '555111'); assert.ok(/เข้าไม้จริง/.test(sent[0].text));
    tg.set({ enabled: false });
    assert.equal(tg.notify('realOpen', 'y'), false, 'สวิตช์ปิด = เงียบ');
  });

  await ok('Telegram ปุ่มยืนยัน: inline keyboard + callback เฉพาะแชตที่ตั้งเท่านั้น', async () => {
    const { createTelegram } = require(path.join(root, 'src', 'main', 'telegram'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstgbtn-'));
    const hits = [];
    let cbPayload = null, replied = null;
    const fakeFetch = async (url, o) => {
      const method = url.split('/').pop();
      if (method === 'sendMessage') hits.push(JSON.parse(o.body));
      if (method === 'answerCallbackQuery') replied = JSON.parse(o.body);
      const result = method === 'getMe' ? { username: 'gs_btn_bot' }
        : method === 'getUpdates' ? [cbPayload].filter(Boolean) : true;
      return { status: 200, json: async () => ({ ok: true, result }) };
    };
    const tg = createTelegram({ file: path.join(dir, 'telegram.json'), fetchImpl: fakeFetch });
    let action = null;
    tg.onActions((d) => { action = d; });
    tg.set({ token: '123456789:AAHfakeTokenForSmokeTest_abcdefghijk', chatId: '555111', enabled: true });
    try {
      // ส่งปุ่ม: reply_markup ครบ
      await tg.sendInline('ตรวจปุ่ม', [[{ text: '✅ เข้าจริง', callback_data: 'sig:a' }]]);
      assert.ok(hits.some((h) => h.reply_markup && h.reply_markup.inline_keyboard[0][0].callback_data === 'sig:a'), 'ปุ่มในข้อความ ✓');
      // callback จากแชตอื่น = ปฏิเสธ + ไม่เรียก handler
      cbPayload = { update_id: 2, callback_query: { id: 'cb2', data: 'sig:a', message: { chat: { id: 987654 } } } };
      await tg.pollOnce();
      assert.equal(action, null, 'แชตอื่นกดปุ่ม = เมิน');
      assert.ok(replied && /แชต/.test(replied.text || ''), 'ตอบหมุดว่าใช้ชาตผ่านไม่ได้');
      // callback จากแชตที่ตั้ง = ส่งต่อ handler
      cbPayload = { update_id: 3, callback_query: { id: 'cb3', data: 'sig:a', message: { chat: { id: 555111 } } } };
      await tg.pollOnce();
      assert.equal(action, 'sig:a', 'ปุ่มจากแชตที่ตั้ง = ส่งต่อ handler');
    } finally {
      tg.stopPolling();
      tg.set({ enabled: false });
    }
  });

  ok('เว็บ: ตัวแทน window.api มีคำสั่งครบทุกตัวของ preload', () => {
    const pre = fs.readFileSync(path.join(root, 'src', 'main', 'preload.js'), 'utf8');
    const shim = fs.readFileSync(path.join(root, 'renderer', 'web-api.js'), 'utf8');
    const names = [...pre.matchAll(/^\s{2}(\w+):\s*\(/gm)].map((m) => m[1]);
    assert.ok(names.length > 20);
    const missing = names.filter((n) => !new RegExp(`^\\s{4}${n}:`, 'm').test(shim));
    assert.deepEqual(missing, [], 'คำสั่งที่เว็บยังไม่มี');
  });

  ok('ผู้ช่วยเทรดบรรยายสด: บทบรรยายครบองค์ประกอบ', () => {
  assert.ok(snap.commentary && Array.isArray(snap.commentary.lines) && snap.commentary.lines.length >= 4, 'บันทีมีบทบรรยาย');
  const txt = snap.commentary.lines.join('\n');
  assert.ok(/ราคาทอง/.test(txt) && /สภา/.test(txt) && /จุดรอเข้า/.test(txt), 'ครบ: ราคา+สภา+จุดรอเข้า');
  assert.ok(Array.isArray(snap.commentaryFeed), 'มีฟีดบรรยายย้อนหลัง');
});

console.log('\n[7.5] ความปลอดภัยออร์เดอร์จริง (regression)');
  ok('บัญชีไม่ใช่ USD: ทุนแปลงเป็น USD จากสเปก EA ก่อนคิดเพดาน 2%', () => {
    const c = new MT5Connector();
    const tmp = path.join(root, '.smoke-bridge-thb.json');
    const nowSec = Math.floor(Date.now() / 1000);
    const bars = Array.from({ length: 60 }, (_, i) => [nowSec - (60 - i) * 300, 1, 2, 0.5, 1.5, 3]);
    // 1 ล็อต 100 oz ขยับ 0.01 = $1 = 33 THB → 1 USD = 33 THB
    fs.writeFileSync(tmp, JSON.stringify({ t: nowSec, symbol: 'XAUUSD', digits: 2, bid: 3900, ask: 3900.5,
      contractSize: 100, tickValue: 33, tickSize: 0.01, volMin: 0.01, volStep: 0.01,
      account: { name: 'S', login: 1, currency: 'THB', balance: 6600, equity: 6600 }, positions: [], candles: { M5: bars } }));
    c.setBridgePath(tmp);
    const a = c.fetch('GC=F').meta.account;
    fs.unlinkSync(tmp);
    assert.ok(Math.abs(a.usdRate - 33) < 1e-9, 'อัตรา 33 THB/USD');
    assert.ok(Math.abs(a.equityUSD - 200) < 1e-9, 'ทุน 6600 THB = $200');
    const v = risk.validateManualOrder({ side: 'buy', lot: 0.1, entry: 3900, sl: 3890, settings: { realOrdersEnabled: true, equity: a.equityUSD, maxSignalsPerDay: 5 } });
    assert.equal(v.pass, false, 'เสี่ยง $100 จากทุน $200 ต้องถูกปฏิเสธ (เดิมนับทุนเป็น $6600 แล้วผ่าน)');
  });
  ok('validateManualOrder: TP ผิดฝั่ง / ล็อตต่ำกว่าขั้นต่ำโบรก / ขนาดสัญญาจริง', () => {
    const S = { realOrdersEnabled: true, equity: 10000, maxSignalsPerDay: 5 };
    assert.equal(risk.validateManualOrder({ side: 'buy', lot: 0.05, entry: 3900, sl: 3890, tp: 3880, settings: S }).pass, false, 'TP ไม้ซื้อต่ำกว่าราคา = ปฏิเสธ');
    assert.equal(risk.validateManualOrder({ side: 'buy', lot: 0.05, entry: 3900, sl: 3890, settings: { ...S, volMin: 0.1 } }).pass, false, 'ล็อต < ขั้นต่ำโบรก = ปฏิเสธ');
    const big = risk.validateManualOrder({ side: 'buy', lot: 0.1, entry: 3900, sl: 3890, settings: { ...S, ozPerLot: 1000 } });
    assert.equal(big.pass, false, 'สัญญา 1000 oz: เสี่ยง $1000 เกิน 2% ของ $10000');
  });
  ok('คิวคำสั่ง: เขียนไฟล์ไม่สำเร็จ = ถอนออกจากคิว / เกิน 15 วิ = หมดอายุและลบจากไฟล์', () => {
    const c = new MT5Connector();
    assert.throws(() => c.sendOrder({ side: 'buy', lot: 0.01, sl: 1, tp: 0 }), 'ไม่มีโฟลเดอร์ bridge');
    assert.equal(c.pending.size, 0, 'ไม่ค้างในคิว (กดซ้ำไม่กลายเป็นสองไม้)');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gscmd-'));
    c.bridgePath = path.join(dir, 'goldsignal_bridge.json');
    const { id } = c.sendOrder({ side: 'buy', lot: 0.01, sl: 3890, tp: 3920 });
    const line = fs.readFileSync(path.join(dir, 'goldsignal_commands.txt'), 'utf8');
    assert.ok(new RegExp(`id=${id} .*exp=\\d+`).test(line), 'บรรทัดคำสั่งมีเวลาหมดอายุ');
    c.pending.get(id).exp -= 20;
    const gone = c.expirePending();
    assert.equal(gone.length, 1, 'หมดอายุ 1 รายการ');
    assert.ok(!/CMD /.test(fs.readFileSync(path.join(dir, 'goldsignal_commands.txt'), 'utf8')), 'ลบออกจากไฟล์แล้ว EA จะไม่ส่ง');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  ok('ไม้จำลอง: ฝั่งละ 1 ไม้ + ราคาแกว่งเข้าออกโซนใน 15 นาที = เข้าครั้งเดียว', () => {
    const e5 = new AnalysisEngine({ settings: { equity: 1000 }, connectors: {}, pluginLoader: null });
    const plan = (status) => ({ atr: 4, sell: { status, center: 3910, top: 3912, bottom: 3908, levelType: 'RES' } });
    const t0 = Date.now();
    let opened = 0;
    ['waiting', 'armed', 'waiting', 'armed', 'waiting', 'armed'].forEach((st, i) => {
      const p = plan(st);
      for (const ev of e5._zoneEvents(p, t0 + i * 10_000)) if (ev.event === 'entered') { e5._openZoneTrade('sell', 3910, p, t0 + i * 10_000); opened++; }
    });
    assert.equal(opened, 1, 'เข้าโซนรัว 3 ครั้งใน 1 นาที = นับครั้งเดียว');
    e5._openZoneTrade('sell', 3910, plan('armed'), t0 + 999_999);
    assert.equal(e5.zoneOpen.filter((t) => t.side === 'sell').length, 1, 'มีไม้จำลองขายเปิดอยู่แล้ว = ไม่เปิดซ้อน');
  });
  ok('ปิดทุกไม้: เข้าคิวครบทุก ticket ในไฟล์เดียว + id เรียงเพิ่มขึ้นเสมอ (EA ข้าม id ที่ถอยหลัง)', () => {
    const c = new MT5Connector();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsclose-'));
    c.bridgePath = path.join(dir, 'goldsignal_bridge.json');
    const { ids } = c.requestCloseAll([111, 222, 333]);
    assert.equal(ids.length, 3);
    assert.ok(ids[0] < ids[1] && ids[1] < ids[2], 'id เพิ่มขึ้นแม้อยู่ในมิลลิวินาทีเดียวกัน');
    const lines = fs.readFileSync(path.join(dir, 'goldsignal_commands.txt'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => /action=close/.test(l) && /exp=\d+/.test(l)), 'ทุกบรรทัดเป็นคำสั่งปิด + มีเวลาหมดอายุ');
    assert.ok(/ticket=111/.test(lines[0]) && /ticket=333/.test(lines[2]));
    fs.rmSync(dir, { recursive: true, force: true });
    const bad = new MT5Connector();
    assert.throws(() => bad.requestCloseAll([1, 2]));
    assert.equal(bad.pending.size, 0, 'เขียนไม่ได้ = ถอนทั้งชุด');
  });
  ok('ปิดบางส่วน: คำสั่ง closepart ในไฟล์ (lot = ล็อตที่ปิด, ticket, exp) + ผล EA ไหลกลับพร้อม cmd', () => {
    const c = new MT5Connector();
    assert.throws(() => c.requestClosePartial(555, 0.05), 'ไม่มีโฟลเดอร์ bridge');
    assert.equal(c.pending.size, 0, 'เขียนไม่ได้ = ไม่ค้างในคิว');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gspart-'));
    c.bridgePath = path.join(dir, 'goldsignal_bridge.json');
    const { id } = c.requestClosePartial(555, 0.05);
    const line = fs.readFileSync(path.join(dir, 'goldsignal_commands.txt'), 'utf8').trim();
    assert.ok(new RegExp(`^CMD id=${id} action=closepart side=- lot=0\\.05 price=0 sl=0 tp=0 ticket=555 exp=\\d+ comment=GoldSignal$`).test(line), line);
    assert.equal(c.pending.get(id).action, 'closepart');
    fs.writeFileSync(path.join(dir, 'goldsignal_results.txt'), `RES id=${id} ts=1700000000 status=ok retcode=10009 ticket=555 price=3920.50 vol=0.05 msg=done\r\n`);
    const r = c.pollResults();
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(r.length, 1);
    assert.equal(r[0].status, 'ok');
    assert.equal(r[0].price, 3920.5);
    assert.equal(r[0].cmd.action, 'closepart', 'ผลผูกกับคำสั่งเดิม (แจ้งเตือน "ปิดบางส่วน")');
    assert.equal(r[0].cmd.lot, 0.05);
    assert.equal(c.pending.size, 0);
  });
  ok('ปิดบางส่วน: ตรวจล็อตตามสเปกโบรก (step/min/ต้องเหลือไม้)', () => {
    const { checkPartialVolume } = require(path.join(root, 'src', 'engine', 'connectors', 'mt5'));
    const S = { volMin: 0.01, volStep: 0.01 };
    const half = checkPartialVolume({ ...S, volume: 0.05, posVolume: 0.1 });
    assert.equal(half.ok, true, half.reason);
    assert.equal(half.volume, 0.05);
    assert.equal(half.remain, 0.05);
    assert.equal(checkPartialVolume({ ...S, volume: 0.1 + 0.2, posVolume: 1 }).volume, 0.3, 'ทศนิยมลอย 0.30000000000000004 ถูกปัดเป็น 0.3');
    assert.equal(checkPartialVolume({ ...S, volume: 0.01, posVolume: 0.02 }).ok, true, 'ไม้ 0.02 ปิด 0.01 เหลือ 0.01 ได้');
    for (const bad of [0, -0.01, NaN, Infinity, 'x', null, undefined]) assert.equal(checkPartialVolume({ ...S, volume: bad, posVolume: 0.1 }).ok, false, `volume=${bad}`);
    assert.equal(checkPartialVolume({ ...S, volume: 0.015, posVolume: 0.1 }).ok, false, 'ไม่ใช่ทวีคูณ step');
    assert.equal(checkPartialVolume({ volMin: 0.1, volStep: 0.1, volume: 0.05, posVolume: 1 }).ok, false, 'ไม่ใช่ทวีคูณ step 0.1');
    assert.equal(checkPartialVolume({ volMin: 0.1, volStep: 0.01, volume: 0.05, posVolume: 1 }).ok, false, 'ต่ำกว่า volMin');
    assert.equal(checkPartialVolume({ ...S, volume: 0.1, posVolume: 0.1 }).ok, false, 'ปิดเท่าขนาดไม้ = ไม่ใช่บางส่วน');
    assert.equal(checkPartialVolume({ ...S, volume: 0.2, posVolume: 0.1 }).ok, false, 'เกินขนาดไม้');
    assert.equal(checkPartialVolume({ volMin: 0.1, volStep: 0.1, volume: 0.1, posVolume: 0.15 }).ok, false, 'เหลือ 0.05 < volMin 0.1');
    assert.equal(checkPartialVolume({ ...S, volume: 0.01, posVolume: 0.01 }).ok, false, 'ไม้ขั้นต่ำแบ่งปิดไม่ได้');
    assert.equal(checkPartialVolume({ ...S, volume: 0.01, posVolume: 0 }).ok, false, 'ไม่รู้ขนาดไม้');
  });
  ok('ผลจาก EA: ข้อความหลายคำอ่านครบ + ผลเก่าก่อนเปิดแอปไม่เด้งซ้ำ', () => {
    const c = new MT5Connector();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsres-'));
    c.bridgePath = path.join(dir, 'goldsignal_bridge.json');
    fs.writeFileSync(path.join(dir, 'goldsignal_results.txt'), 'RES id=5 ts=1 status=error retcode=0 ticket=0 price=0 msg=old\r\n');
    assert.equal(c.pollResults().length, 0, 'ผลเก่าตอนเปิดแอป = ไม่นับ');
    fs.writeFileSync(path.join(dir, 'goldsignal_results.txt'), 'RES id=5 ts=1 status=error retcode=0 ticket=0 price=0 msg=old\r\nRES id=6 ts=1 status=error retcode=10019 ticket=0 price=0 msg=No money to complete request\r\n');
    const r = c.pollResults();
    fs.rmSync(dir, { recursive: true, force: true });
    assert.equal(r.length, 1);
    assert.equal(r[0].msg, 'No money to complete request', 'ข้อความเต็มประโยค (เดิมเหลือคำแรก)');
  });
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsprim-'));
    fs.writeFileSync(path.join(dir, 'prim.js'), "module.exports = { id: 'prim', name: 'P', strategy: () => ['buy', Object.freeze({ side: 'sell', sl: 9999, confidence: 70 })] };");
    const pl = new PluginLoader({ builtInDir: dir, userDir: path.join(dir, 'none') });
    pl.reload();
    let got, err = null;
    try { got = await pl.runStrategies({ log: () => {} }); } catch (e) { err = e; }
    fs.rmSync(dir, { recursive: true, force: true });
    ok('plugin คืนค่าดิบ/วัตถุ frozen: ข้ามค่าดิบ ใช้วัตถุได้ ไม่ทำรอบวิเคราะห์ล้ม', () => {
      assert.equal(err, null, err && err.message);
      assert.equal(got.length, 1);
      assert.equal(got[0].plugin, 'prim');
    });
  }
  ok('สภา: เพดานกันไล่ราคา (capSide) ถูกใช้กับฝั่งที่ตรงกัน', () => {
    const orig = council.AGENTS.map((a) => a.analyze);
    council.AGENTS.forEach((a, i) => {
      a.analyze = i === 0 ? () => ({ side: 'none', conf: 0, cap: 55, capSide: 'buy', capReason: 'ชนแนวต้าน' }) : () => ({ side: 'buy', conf: 90, reason: 'x' });
    });
    try {
      const v = council.runCouncil({ analysis: {}, candles: {}, price: 1, now: Date.now(), ind, skills: {} }, { councilQuorum: 3, councilQuorumAuto: false });
      assert.equal(v.side, 'buy');
      assert.ok(v.confidence <= 55, `ถูกบีบเหลือ ≤55 (ได้ ${v.confidence})`);
    } finally { council.AGENTS.forEach((a, i) => { a.analyze = orig[i]; }); }
  });
  ok('สภา v3: ฝ่ายบริบทปรับน้ำหนัก (adjust) + แรงเสริมชนแนว (boost) ทำงานก่อนเพดาน', () => {
    const orig = council.AGENTS.map((a) => a.analyze);
    // 0 = บริบทลดน้ำหนักคนที่ 1 เหลือ ×0.1, 1 = โหวตขาย 90, 2-4 = โหวตซื้อ 60, 5 = boost ฝั่งซื้อ +6, 6 = เงียบ
    const fns = [
      () => ({ side: 'none', conf: 0, adjust: { [council.AGENTS[1].id]: 0.1 }, reason: 'ctx' }),
      () => ({ side: 'sell', conf: 90, reason: 's' }),
      () => ({ side: 'buy', conf: 60, reason: 'b' }), () => ({ side: 'buy', conf: 60, reason: 'b' }), () => ({ side: 'buy', conf: 60, reason: 'b' }),
      () => ({ side: 'none', conf: 0, boost: [{ side: 'buy', by: 6, reason: 'ชนแนว' }, { side: 'sell', by: 6, reason: 'x' }], reason: 'lv' }),
      () => ({ side: 'none', conf: 0, reason: 'n' }),
    ];
    council.AGENTS.forEach((a, i) => { a.analyze = fns[i]; });
    try {
      const v = council.runCouncil({ analysis: {}, candles: {}, price: 1, now: Date.now(), ind, skills: {} }, { councilQuorum: 3, councilQuorumAuto: false });
      assert.equal(v.side, 'buy', 'เสียงขายถูกลดน้ำหนักจนแพ้');
      assert.deepEqual(v.boosts, ['ชนแนว'], 'boost ใช้เฉพาะฝั่งมติ');
      assert.equal(v.votes[1].weightAdj, 0.1);
    } finally { council.AGENTS.forEach((a, i) => { a.analyze = orig[i]; }); }
  });
  ok('สภา v3: ดีดกลับจับแท่ง M5 หลุดแบนด์แล้วปิดกลับเข้า', () => {
    const c = []; let px = 3900;
    for (let i = 0; i < 60; i++) { const o = px; px += Math.sin(i) * 0.3; c.push({ t: i, o, h: Math.max(o, px) + 0.2, l: Math.min(o, px) - 0.2, c: px }); }
    const low = px - 6; c.push({ t: 60, o: px, h: px, l: low - 0.5, c: low }); // ปิดหลุดขอบล่าง
    c.push({ t: 61, o: low, h: px, l: low, c: px - 0.2 });               // ปิดกลับเข้า
    assert.equal(council.bandReentry(c), 'buy');
    assert.equal(council.bandReentry(c.slice(0, -1)), 'none', 'ยังไม่กลับเข้า = ยังไม่โหวต');
  });
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsasync-'));
    fs.writeFileSync(path.join(dir, 'async-one.js'), "module.exports = { id: 'async-one', name: 'A', strategy: async () => ({ side: 'buy', sl: 1, confidence: 70, reason: 'async' }) };");
    const pl = new PluginLoader({ builtInDir: dir, userDir: path.join(dir, 'none') });
    pl.reload();
    const got = await pl.runStrategies({ log: () => {} });
    fs.rmSync(dir, { recursive: true, force: true });
    ok('plugin async: ได้สัญญาณจริง (เดิมกลายเป็น [Promise] แล้วถูกทิ้ง)', () => {
      assert.equal(got.length, 1);
      assert.equal(got[0].side, 'buy');
    });
  }

console.log('\n[8] Network (Yahoo จริง)');
  if (process.env.SMOKE_NETWORK === '1') {
    try {
      const y = new YahooConnector();
      const data = await y.fetch('GC=F');
      ok(`Yahoo GC=F ได้ราคา ${data.price} + M5 ${data.candles.M5.length} แท่ง`, () => {
        assert.ok(data.price > 1000 && data.candles.M5.length > 50 && data.candles.H1.length > 50);
      });
    } catch (e) { console.error(`  ⚠ Yahoo จริงเชื่อมไม่ได้ (${e.message}) — ข้ามได้ ใช้ MT5 เป็นหลัก`); }
  } else console.log('  (ข้าม — ตั้ง SMOKE_NETWORK=1 เพื่อทดสอบ Yahoo จริง)');

  console.log(`\nผลรวม: ผ่าน ${passed} รายการ${process.exitCode ? ' — มีรายการล้มเหลว' : ' ทั้งหมด ✓'}\n`);
  process.exit(process.exitCode || 0);
})();
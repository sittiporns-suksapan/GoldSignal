'use strict';
/* GoldSignal renderer — รับ snapshot ผ่าน window.api (preload) */

const $ = (id) => document.getElementById(id);
// ข้อความจาก plugin/log/MT5 ต้อง escape ก่อนใส่ innerHTML เสมอ (plugin ของผู้ใช้เขียนอะไรมาก็ได้)
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (ch) => ESC[ch]);
const store = {
  get(k, def) { try { return localStorage.getItem(k) || def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { void 0; } },
};

let chartM = null, candleSeries = null, ema20Series = null, ema50Series = null;
let lastSnap = null;
let appSettings = null;    // ค่าตั้งที่โหลดจาก main (sync ทุกครั้งที่บันทึก) — ใช้ตัดสินโหมดยืนยันอัตโนมัติ
let candStore = {};        // แท่งเทียนรวมทุกไทม์เฟรม (engine ส่งเฉพาะ TF ที่มีแท่งใหม่ — เติมทับที่นี่)
let zoneLines = [];       // ราคาโซนปลอดภัยที่วาดอยู่บนชาร์ต
let zoneKey = '';         // วาดเส้นโซนใหม่เฉพาะเมื่อระดับราคาเปลี่ยน (ลดงาน DOM/canvas ทุกรอบ)
let chartKey = '';        // setData ใหม่เฉพาะเมื่อแท่งเปลี่ยน
let chartBars = [];       // แท่งที่แสดงอยู่ (สำหรับอัปเดตแท่งสุดท้ายแบบสด)
let ZC = { up: '#2bc48a', down: '#f0616d', gold: '#d9b46a', warn: '#e8b84a' }; // สีโซน (อ่านจาก CSS ตอน initChart)
// '#rrggbb' + ความโปร่ง → rgba() ให้เส้นโซนใช้สีชุดเดียวกับธีม
const alpha = (hex, a) => { const n = parseInt(hex.replace('#', ''), 16); return Number.isFinite(n) ? `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})` : hex; };

function ema(values, n) {
  const out = new Array(values.length).fill(null);
  if (values.length < n) return out;
  let seed = 0;
  for (let i = 0; i < n; i++) seed += values[i];
  let prev = seed / n;
  out[n - 1] = prev;
  const k = 2 / (n + 1);
  for (let i = n; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}

// รวมแท่งเล็กเป็นใหญ่ตามขอบเวลาจริง (M30/H4/D1) — เดิมนับทีละ n แท่ง ทำให้แท่งเหลื่อมเวลาเมื่อมีช่องว่างตลาดปิด
function aggregate(candles, bucketSec) {
  const out = [];
  let cur = null;
  for (const c of candles) {
    const t = Math.floor(c.t / bucketSec) * bucketSec;
    if (!cur || cur.t !== t) {
      cur = { t, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v || 0 };
      out.push(cur);
    } else {
      if (c.h > cur.h) cur.h = c.h;
      if (c.l < cur.l) cur.l = c.l;
      cur.c = c.c;
      cur.v += c.v || 0;
    }
  }
  return out;
}

let currentTf = store.get('gsTf', 'M5');
// ข้อมูลแท่งต่อไทม์เฟรมจริงที่ได้จาก snapshot
function dataForTf(candlesByTf, tf) {
  if (!candlesByTf) return [];
  if (tf === 'M30') return aggregate(candlesByTf.M5 || [], 1800);
  if (tf === 'H4') return aggregate(candlesByTf.H1 || [], 4 * 3600);
  if (tf === 'D1') return aggregate(candlesByTf.H1 || [], 86400);
  return candlesByTf[tf] || [];
}
const r2 = (n, d = 2) => Number.isFinite(n) ? n.toFixed(d) : '—';

/* ---------- tabs (จำแท็บล่าสุดไว้) ---------- */
function showTab(name) {
  if (!$('tab-' + name)) name = 'home';
  document.querySelectorAll('#tabs button').forEach((x) => {
    const on = x.dataset.tab === name;
    x.classList.toggle('active', on);
    x.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.id === 'tab-' + name));
  store.set('gsTab', name);
  if (lastSnap) renderDeferred(lastSnap); // ส่วนที่ข้ามไว้ตอนซ่อน — วาดทันทีเมื่อเปิดดู
}

// ส่วนที่มองไม่เห็น (แท็บอื่น / กล่องพับ) ไม่ต้องสร้าง DOM ใหม่ทุกรอบ — วาดเมื่อเปิดดูเท่านั้น
const isOpen = (id) => { const el = $(id); return !!el && el.open; };
const tabActive = (name) => { const el = $('tab-' + name); return !!el && el.classList.contains('active'); };
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------- chart ---------- */
// ช่องว่างขวาแท่งล่าสุดสำหรับป้ายเส้นระดับ (พิกเซล — แปลงเป็นจำนวนแท่งตามระยะห่างแท่งที่ซูมอยู่)
const LABEL_GAP_PX = 150;
// พอดีจอ + ช่องว่างขวาให้ป้าย (ตั้งช่วงเองแทน fitContent ที่ทับช่องว่างทิ้ง)
function fitWithGap() {
  if (!chartM || !chartBars.length) return;
  const ts = chartM.timeScale();
  const n = chartBars.length, w = Math.max(LABEL_GAP_PX + 50, ts.width());
  const gap = Math.ceil((LABEL_GAP_PX * n) / (w - LABEL_GAP_PX));
  ts.setVisibleLogicalRange({ from: 0, to: n - 1 + gap });
}
// ตามแท่งล่าสุด: คงระดับซูมเดิม แล้วเลื่อนให้แท่งล่าสุดอยู่ซ้ายของช่องว่างป้าย
function followLatest() {
  if (!chartM || !chartBars.length) return;
  const ts = chartM.timeScale();
  const r = ts.getVisibleLogicalRange();
  if (!r) { fitWithGap(); return; }
  const span = Math.max(10, r.to - r.from);
  const gap = Math.ceil(LABEL_GAP_PX / Math.max(0.5, ts.width() / span));
  const to = chartBars.length - 1 + gap;
  ts.setVisibleLogicalRange({ from: to - span, to });
}

function initChart() {
  const LC = window.LightweightCharts;
  if (!LC) { // ไม่พบไลบรารี — ไม่ทำชาร์ต แต่ปล่อยข้อมูล/สัญญาณอื่นทำงานต่อ (defense-in-depth)
    $('chart').innerHTML = '<div class="empty">ชาร์ตไม่พร้อม (ไฟล์ vendor หาย) — ระบบสัญญาณยังทำงานปกติ</div>';
    updateChart = () => {};
    return;
  }
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const up = css('--up'), down = css('--down');
  ZC = { up, down, gold: css('--gold'), warn: css('--warn') };
  const cross = { color: 'rgba(217,180,106,0.45)', width: 1, style: LC.LineStyle.Dashed, labelBackgroundColor: '#3a3020' };
  chartM = LC.createChart($('chart'), {
    autoSize: true, // ResizeObserver ในตัว — ตามขนาดกล่องเองทั้งตอนย่อหน้าต่างและสลับแท็บ
    layout: { background: { color: 'transparent' }, textColor: css('--muted'), fontSize: 11, fontFamily: css('--font-num'), attributionLogo: false },
    grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
    rightPriceScale: { borderColor: css('--line') },
    timeScale: { borderColor: css('--line'), timeVisible: true, secondsVisible: false },
    crosshair: { mode: LC.CrosshairMode.Normal, vertLine: cross, horzLine: cross },
  });
  const add = (type, legacy, opts) => (chartM.addSeries ? chartM.addSeries(LC[type], opts) : chartM[legacy](opts));
  candleSeries = add('CandlestickSeries', 'addCandlestickSeries', { upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down });
  ema20Series = add('LineSeries', 'addLineSeries', { color: css('--gold-hi'), lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
  ema50Series = add('LineSeries', 'addLineSeries', { color: css('--accent'), lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
}

function updateChart(candlesByTf, { fit = false } = {}) {
  if (!chartM || !candlesByTf) return;
  const candles = dataForTf(candlesByTf, currentTf);
  if (!Array.isArray(candles) || !candles.length) return;
  // ข้อมูลเท่าเดิม (รอบวิเคราะห์ที่แท่งยังไม่เปลี่ยน) → ไม่ต้อง setData ใหม่ทั้งก้อน; tick สดอัปเดตแท่งสุดท้ายให้อยู่แล้ว
  const lastC = candles[candles.length - 1];
  const key = `${currentTf}|${candles.length}|${candles[0].t}|${lastC.t}|${lastC.c}`;
  if (!fit && key === chartKey) { drawZones(lastSnap); return; }
  chartKey = key;
  $('chart-sub').textContent = `${currentTf} • ${candles.length} แท่ง`;
  const bars = candles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c }));
  // เก็บช่วงเวลาที่ผู้ใช้กำลังดู → อัปเดตข้อมูลแล้ววางกลับตรงเดิม (ซูมไม่หลุดระหว่างสตรีม)
  const before = chartBars.length ? chartM.timeScale().getVisibleRange() : null;
  const lastOldT = chartBars.length ? chartBars[chartBars.length - 1].time : null;
  const atRight = before && lastOldT != null && Number(before.to) >= Number(lastOldT) - 1.5; // ดูอยู่ขอบขวา = อยากตามราคา
  chartBars = bars;
  candleSeries.setData(bars);
  const cl = candles.map((c) => c.c);
  const toLine = (arr) => bars.map((b, i) => arr[i] != null ? ({ time: b.time, value: arr[i] }) : null).filter(Boolean).slice(1);
  ema20Series.setData(toLine(ema(cl, 20)));
  ema50Series.setData(toLine(ema(cl, 50)));
  try {
    if (fit || !before) fitWithGap();
    else if (atRight) followLatest(); // อยู่ขอบขวา = วิ่งตามเทียนใหม่ (คงช่องว่างป้าย)
    else chartM.timeScale().setVisibleRange(before);         // ดูอยู่ช่วงกลาง/ซูมอยู่ = คงมุมเดิมเป๊ะ
  } catch { void 0; }
  drawZones(lastSnap);
}

// ---------- โซนปลอดภัยบนกราฟ ----------
// แนวรับ = เขียว (จุดยืนเหมาะซื้อ) • แนวต้าน = ทอง (จุดเหมาะขาย) • โซนห้ามไล่ราคา = แดง (ต้านระยะใกล้ท่อราคา)
function drawZones(snap) {
  if (!chartM || !candleSeries) return;
  const a = snap && snap.analysis;
  const atr = a && a.tf && a.tf.M15 && Number.isFinite(a.tf.M15.atr) ? a.tf.M15.atr : ((a && a.price) || (snap && snap.price) || 0) * 0.0008;
  const plan = snap && snap.entryPlan;
  const bb0 = a && a.tf && a.tf.M15 && a.tf.M15.bb;
  // ระดับเดิม + สถานะใกล้แนวต้านเดิม = ไม่ต้องลบ/สร้างเส้นใหม่
  const near = a && a.levels ? (a.levels.resistances || []).map((r) => Math.abs(r - snap.price) <= atr * 0.35 ? 1 : 0).join('') : '';
  const key = showLines && a && a.levels && snap.price ? JSON.stringify([a.levels, near, plan && plan.buy && [plan.buy.bottom, plan.buy.top], plan && plan.sell && [plan.sell.bottom, plan.sell.top], bb0 && [bb0.upper, bb0.lower]]) : '';
  if (key === zoneKey) return;
  zoneKey = key;
  for (const l of zoneLines) { try { candleSeries.removePriceLine(l); } catch { void 0; } }
  zoneLines = [];
  if (!key) return;
  // ป้ายบนเส้น + ราคาบนแกน (เหมือนเดิม) — ป้ายอยู่ขอบขวาตรงช่องว่าง LABEL_GAP_PX จึงไม่บังแท่งเทียน
  const line = (price, color, style, title, width = 1) => zoneLines.push(candleSeries.createPriceLine({ price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title }));
  const LS = LightweightCharts.LineStyle;
  for (const sup of a.levels.supports || []) line(sup, ZC.up, LS.Dashed, 'SUP');
  for (const res of a.levels.resistances || []) {
    const nearDanger = Math.abs(res - snap.price) <= atr * 0.35;
    line(res, nearDanger ? ZC.down : ZC.gold, LS.Dashed, nearDanger ? '❗NO ENTRY' : 'RES', nearDanger ? 2 : 1);
  }
  // โซนจุดรอเข้า: ขอบบน/ล่าง
  if (plan && plan.buy) { line(plan.buy.top, alpha(ZC.up, 0.85), LS.Solid, 'BUY ZONE TOP'); line(plan.buy.bottom, alpha(ZC.up, 0.85), LS.Solid, 'BUY ZONE BOT'); }
  if (plan && plan.sell) { line(plan.sell.top, alpha(ZC.gold, 0.85), LS.Solid, 'SELL ZONE TOP'); line(plan.sell.bottom, alpha(ZC.gold, 0.85), LS.Solid, 'SELL ZONE BOT'); }
}

/* ---------- บันไดราคา: ทุกระดับสำคัญเรียงจากบนลงล่าง + แถวราคาตอนนี้ + ระยะห่างสด ---------- */
function renderLadder(snap, livePrice) {
  if (!showLadder) return;
  const box = $('ladder');
  const a = snap && snap.analysis;
  const price = Number.isFinite(livePrice) ? livePrice : snap && snap.price;
  if (!a || !a.levels || !Number.isFinite(price)) { box.innerHTML = '<div class="empty sm">รอข้อมูลระดับราคา…</div>'; return; }
  const atr = a.tf && a.tf.M15 && Number.isFinite(a.tf.M15.atr) ? a.tf.M15.atr : price * 0.0008;
  const plan = snap.entryPlan || {};
  const st = { armed: 'ราคาในโซน', waiting: 'รอ', blocked: 'ยกเลิก', danger: 'ห้ามเข้า' };
  const rows = [];
  for (const r of a.levels.resistances || []) {
    const danger = Math.abs(r - price) <= atr * 0.35;
    rows.push({ p: r, cls: danger ? 'danger' : 'res', name: danger ? 'ใกล้ต้าน — ห้ามไล่' : 'แนวต้าน', txt: fmtD(r, 2) });
  }
  for (const s of a.levels.supports || []) rows.push({ p: s, cls: 'sup', name: 'แนวรับ', txt: fmtD(s, 2) });
  for (const side of ['sell', 'buy']) {
    const z = plan[side];
    if (!z) continue;
    const inZone = price >= z.bottom && price <= z.top;
    rows.push({ p: (z.top + z.bottom) / 2, cls: side === 'sell' ? 'zsell' : 'zbuy', name: side === 'sell' ? 'โซนขาย' : 'โซนซื้อ', txt: `${fmtD(z.bottom, 2)}–${fmtD(z.top, 2)}`, chip: inZone ? '' : st[z.status] || '', chipCls: z.status, zone: z });
  }
  // เรียงตามราคา (โซนใช้ราคากลาง) แล้วแทรกแถว "ราคาตอนนี้" ตามตำแหน่งจริง
  rows.push({ p: price, now: true });
  rows.sort((x, y) => y.p - x.p || (x.zone ? -1 : 1));
  const dist = (r) => {
    if (r.zone) { const z = r.zone; return price > z.top ? z.top - price : price < z.bottom ? z.bottom - price : 0; }
    return r.p - price;
  };
  box.innerHTML = rows.map((r) => {
    if (r.now) return `<div class="lad-row now"><span class="lad-name">ราคาตอนนี้</span><b class="lad-px">${fmtD(price, 2)}</b></div>`;
    const d = dist(r);
    return `<div class="lad-row ${r.cls}"><i class="lad-bar"></i><span class="lad-name">${r.name}${r.chip ? ` <em class="lad-chip ${r.chipCls}">${r.chip}</em>` : ''}</span>` +
      `<b class="lad-px">${r.txt}</b><span class="lad-d${d === 0 ? ' in' : ''}">${d === 0 ? 'ราคาอยู่ในโซน' : (d > 0 ? '+' : '−') + fmtD(Math.abs(d), 2)}</span></div>`;
  }).join('');
}

// ปุ่ม "เส้น": แสดง/ซ่อนเส้นระดับบนชาร์ต • ปุ่ม "แผง": แสดง/ซ่อนบันไดราคา (จำค่าไว้ทั้งคู่)
let showLines = store.get('gsLines', '1') === '1';
let showLadder = store.get('gsLadder', '0') === '1'; // ค่าเริ่มต้น: ซ่อน (ป้ายอยู่บนเส้นขวามือแล้ว — ชาร์ตกว้างสุด)
function syncLinesBtn() {
  $('z-lines').classList.toggle('active', showLines);
  $('z-ladder').classList.toggle('active', showLadder);
  $('chart-body').classList.toggle('no-ladder', !showLadder);
}

// ---------- toolbar ซูม (ปุ่มลัด: ชัวร์กว่าล้อเมาส์) ----------
function wireZoom() {
  const curSpacing = () => {
    const w = chartM.timeScale().width();
    return chartBars.length ? w / Math.max(1, chartBars.length) : 8;
  };
  $('z-in').addEventListener('click', () => chartM.timeScale().applyOptions({ barSpacing: Math.min(90, curSpacing() * 1.35) }));
  $('z-out').addEventListener('click', () => chartM.timeScale().applyOptions({ barSpacing: Math.max(1.5, curSpacing() * 0.72) }));
  $('z-fit').addEventListener('click', fitWithGap);
  $('z-live').addEventListener('click', followLatest);
  syncLinesBtn();
  $('z-lines').addEventListener('click', () => {
    showLines = !showLines;
    store.set('gsLines', showLines ? '1' : '0');
    syncLinesBtn();
    zoneKey = '__force__';
    drawZones(lastSnap);
  });
  $('z-ladder').addEventListener('click', () => {
    showLadder = !showLadder;
    store.set('gsLadder', showLadder ? '1' : '0');
    syncLinesBtn();
    if (lastSnap) renderLadder(lastSnap);
    setTimeout(fitWithGap, 80); // ชาร์ตกว้าง/แคบลงแล้ว — จัดแท่งให้เต็มกรอบใหม่ (คงช่องว่างป้าย)
  });
}

// แถบเลือกไทม์เฟรม (แบบ MT5)
document.querySelectorAll('#tf-buttons button').forEach((b) => {
  if (b.dataset.tf === currentTf) { document.querySelectorAll('#tf-buttons button').forEach((x) => x.classList.remove('active')); b.classList.add('active'); }
  b.addEventListener('click', () => {
    currentTf = b.dataset.tf;
    store.set('gsTf', currentTf);
    document.querySelectorAll('#tf-buttons button').forEach((x) => x.classList.toggle('active', x === b));
    if (lastSnap) updateChart(candStore, { fit: true }); // เปลี่ยนไทม์เฟรม = พอดีจอครั้งเดียว แล้วคงมุมมองไปเรื่อย ๆ
  });
});

/* ---------- render helpers ---------- */
function fmtTs(t) { return new Date(t).toLocaleTimeString('th-TH', { hour12: false }); }

function renderTicker(snap) {
  if (snap.price == null) { $('price').textContent = '—'; return; }
  $('price').textContent = r2(snap.price);
  const prev = snap.prevPrice;
  const d = prev != null ? snap.price - prev : null;
  const el = $('price-delta');
  if (d == null || Math.abs(d) < 1e-9) { el.textContent = prev != null ? 'ทรงตัว' : ''; el.className = 'delta'; }
  else { el.textContent = (d > 0 ? '▲ +' : '▼ ') + r2(d); el.className = 'delta ' + (d > 0 ? 'up' : 'down'); }
}

function badgeFor(statuses, sourceSel) {
  const el = $('conn-badge');
  const mt5 = statuses && statuses.mt5, y = statuses && statuses.yahoo;
  let state = 'err', msg = 'ไม่มีข้อมูล';
  const okY = y && y.state === 'ok', okM = mt5 && mt5.state === 'ok';
  if (okM) { state = 'ok'; msg = 'MT5' + (sourceSel === 'auto' ? ' (อัตโนมัติ)' : ''); }
  else if (okY) { state = 'warn'; msg = 'ข้อมูลฟรี COMEX'; }
  else if (mt5 && (mt5.state === 'no-bridge' || mt5.state === 'searching')) { state = 'err'; msg = 'รอ bridge จาก MT5 (ลาก EA บนชาร์ต)'; }
  else if (mt5 && mt5.state === 'stale') { state = 'err'; msg = 'bridge MT5 หยุดอัปเดต (EA อาจปิด)'; }
  el.className = 'badge ' + (state === 'ok' ? 'ok' : state === 'warn' ? 'warn' : 'err');
  el.textContent = msg;
  el.title = `${mt5 ? 'MT5: ' + mt5.msg : ''}\n${y ? 'ฟรี: ' + y.msg : ''}`;
  $('source-sel').value = sourceSel;
}

function renderMarket(a) {
  const el = $('market');
  if (!a || !a.price) { el.innerHTML = '<div class="empty">รอข้อมูล...</div>'; return; }
  const tf = a.tf || {};
  const chip = (tr) => tr === 'up' ? '<span class="chip up">ขึ้น</span>' : tr === 'down' ? '<span class="chip down">ลง</span>' : '<span class="chip">ออกข้าง</span>';
  const biasTxt = a.bias === 'bull' ? '<span class="chip up">ขาขึ้น</span>' : a.bias === 'bear' ? '<span class="chip down">ขาลง</span>' : '<span class="chip">กลาง</span>';
  const rsi = tf.M5 ? r2(tf.M5.rsi, 1) : '—';
  const atr = tf.M15 && tf.M15.atrPct ? r2(tf.M15.atrPct, 3) + '%' : '—';
  const squeeze = tf.M15 && tf.M15.squeeze ? '<span class="chip gold">บีบตัว! รอแตก</span>' : '<span class="chip">ปกติ</span>';
  const lv = (arr, label) => `${label}: ${arr && arr.length ? arr.map((v) => r2(v)).join(' · ') : '—'}`;
  el.innerHTML = `
    <div class="rowc"><span>แนวโน้มรวม (H1+M15)</span>${biasTxt}</div>
    <div class="rowc"><span>เทรนด์ H1 / M15</span>${chip(a.trendH1)} ${chip(a.trendM15)}</div>
    <div class="rowc"><span>RSI (M5)</span><b>${rsi}</b></div>
    <div class="rowc"><span>ความผันผวน ATR (M15)</span><b>${atr}</b></div>
    <div class="rowc"><span>Bollinger Squeeze (M15)</span>${squeeze}</div>
    <div class="rowc"><span>${lv(a.levels.supports, 'แนวรับ')}</span></div>
    <div class="rowc"><span>${lv(a.levels.resistances, 'แนวต้าน')}</span></div>`;
}

function renderGuards(g, s) {
  $('guards').innerHTML = `
    <div class="grow"><span>สัญญาณใช้แล้ววันนี้</span><b>${g.dailyCount} / ${g.maxPerDay}</b></div>
    <div class="grow"><span>โหมดหยุดช่วงข่าว</span><b>${g.newsStop ? '✔ เปิด (ไม่ส่งสัญญาณใหม่)' : 'ปิด'}</b></div>
    <div class="grow"><span>สัญญาณที่ยังมีชีวิต</span><b>${g.activeCount}</b></div>
    <div class="grow"><span>เพดานความเสี่ยง/ไม้</span><b>≤ ${r2(s.riskPct, 2)}% (บังคับ ≤2%)</b></div>
    <div class="grow"><span>RR ขั้นต่ำที่ยอมรับ</span><b>≥ ${r2(s.minRR, 1)}</b></div>`;
}

function signalCard(sig) {
  const m = sig.metrics || {};
  const conf = Math.max(0, Math.min(100, sig.confidence));
  return `
  <div class="signal ${sig.side}">
    <div class="sig-top">
      <span class="side ${sig.side}">${sig.side === 'buy' ? 'ซื้อ BUY' : 'ขาย SELL'}</span>
      <span class="muted small">${esc(sig.pluginName || sig.plugin)}</span>
      ${sig.held ? `<span class="held">⏸ ${esc(sig.held)}</span>` : '<span class="held ready">✔ พร้อมใช้</span>'}
      <span class="sig-price">@ ${r2(sig.entry)}</span>
    </div>
    <div class="sig-grid">
      <div class="sig-cell"><small>Stop Loss</small><b class="down">${r2(sig.sl)}</b></div>
      <div class="sig-cell"><small>Take Profit</small><b class="up">${r2(sig.tp)}</b></div>
      <div class="sig-cell"><small>ล็อตแนะนำ</small><b>${m.lot != null ? m.lot.toFixed(2) : '—'}</b></div>
      <div class="sig-cell"><small>เงินเสี่ยงจริง</small><b>$${m.riskUSD != null ? r2(m.riskUSD) : '—'}</b></div>
      <div class="sig-cell"><small>RR</small><b>${m.rr != null ? '1:' + r2(m.rr) : '—'}</b></div>
      <div class="sig-cell"><small>ระยะ SL</small><b>$${m.slDist != null ? r2(m.slDist) : '—'}</b></div>
      <div class="sig-cell"><small>คะแนนเสี่ยง</small><b>${sig.riskScore != null ? sig.riskScore : '—'} <small class="muted">ต่ำ=ปลอดภัยกว่า</small></b></div>
    </div>
    <div class="confbar"><div style="width:${conf}%"></div></div>
    <div class="sig-meta">ความมั่นใจ ${conf}% • เวลา ${fmtTs(sig.ts)}${sig.autoTp ? ' • TP คำนวณอัตโนมัติที่ R:R 2:1' : ''}${sig.council && sig.council.conf != null ? ` • ทีมเอเจนต์ ${sig.council.conf}% (${esc(sig.council.note)})` : ''}</div>
    <div class="reason">${esc(sig.reason)}</div>
  </div>`;
}

// ตอนไม่มีสัญญาณ: บอกเหตุผลจริงของรอบนี้ + เตือนถ้าทุนเล็กเกินจนสัญญาณจะถูกปฏิเสธเสมอ
function noSignalHtml(snap) {
  const f = (snap.filtered || []).find((x) => !/^👀/.test(String(x.reason)));
  const notes = (snap.standby && snap.standby.notes) || [];
  const why = f ? `ล่าสุดถูกกรอง: ${f.reason}` : notes[0] || 'ยังไม่มีกลยุทธ์ไหนเจอจังหวะเข้าตามเงื่อนไข';
  const eq = Number(snap.guard && snap.guard.equityUsed) || 0;
  const riskPct = Number(snap.risk && snap.risk.riskPct) || 1;
  const atr = snap.analysis && snap.analysis.tf && snap.analysis.tf.M15 && snap.analysis.tf.M15.atr;
  const oz = (snap.meta && snap.meta.spec && snap.meta.spec.contractSize) || 100;
  const budget = (eq * riskPct) / 100;
  const minRisk = Number.isFinite(atr) ? atr * 0.01 * oz : null; // 0.01 ล็อต กับ SL ระยะ 1 ATR(M15)
  const small = minRisk != null && budget > 0 && budget < minRisk
    ? `<div class="nosig-cap">⚠ ทุนที่ใช้คิด $${fmtD(eq, 0)} × ${fmtD(riskPct, 2)}% = เสี่ยงได้ $${fmtD(budget, 2)}/ไม้ แต่ 0.01 ล็อตกับ SL แค่ 1 ATR ($${fmtD(atr, 2)}) ก็เสี่ยง $${fmtD(minRisk, 2)} แล้ว — สัญญาณที่เจอจะถูกปฏิเสธเพราะ SL กว้างเกินทุน</div>`
    : '';
  return `<div class="empty nosig"><b>ยังไม่มีสัญญาณที่เข้าได้</b><span>${esc(why)}</span></div>${small}`;
}

function renderSignals(snap) {
  const box = $('signals');
  const list = (snap.signals || []).slice(0, 8);
  $('signals-count').textContent = list.length ? `${list.length} โอกาส` : '';
  box.innerHTML = list.length ? list.map(signalCard).join('') : noSignalHtml(snap);
  const f = $('filtered');
  f.innerHTML = (snap.filtered || []).length
    ? snap.filtered.map((x) => `<div class="frow"><b>${esc(x.plugin)}</b> — ${esc(x.reason)}</div>`).join('')
    : '<div class="empty">ไม่มี</div>';
}

/* ---------- ไม้จริง: ประวัติเข้าจริง + สรุปแต่ละไม้ + รวมรายวัน (จาก deal ปิดของ MT5) ---------- */
function renderRealHistory(meta) {
  const box = $('realhist');
  if (!box) return;
  if (!meta) {
    box.innerHTML = '<div class="empty sm">ยังไม่เชื่อม MT5 — ประวัติไม้จริงมาจากบัญชี MT5 (ลาก JsonBridgeEA ลงชาร์ตทอง)</div>';
    return;
  }
  if (!Array.isArray(meta.history)) {
    box.innerHTML = `<div class="data-alert"><b>EA บนชาร์ต MT5 ยังเป็นรุ่นเก่า — จึงยังไม่ส่งประวัติไม้จริงมา</b><br>
      ใน MetaTrader 5: Navigator → Experts → <b>GoldSignal → JsonBridgeEA</b> ลากวางบนชาร์ตทอง (แทนตัวเดิม) → กด OK → รอ 5 วิ ประวัติจะขึ้นที่นี่ทันที</div>`;
    return;
  }
  const rows = meta.history.slice(0, 20);   // EA ส่งใหม่สุดก่อนอยู่แล้ว
  // คีย์วันแบบ yyyy-mm-dd เรียงได้ถูก (เดิม dd/mm/yyyy เรียงตามตัวอักษร: 30/10 ขึ้นก่อน 02/11)
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const dayLabel = (k) => { const [y, m, d] = k.split('-'); return `${d}/${m}/${y}`; };
  const stamp = (t) => { const d = new Date(t); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const todayKey = dayKey(Date.now());
  const byDay = new Map();
  for (const h of meta.history) {
    if (!Number.isFinite(h.time)) continue;
    const k = dayKey(h.time);
    const g = byDay.get(k) || { n: 0, w: 0, l: 0, total: 0 };
    g.n++;
    if (h.profit > 0) g.w++; else if (h.profit < 0) g.l++;
    g.total += h.profit;
    byDay.set(k, g);
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 7)
    .map(([k, g]) => `<div class="rh-day"><span class="d">${k === todayKey ? 'วันนี้ ' : ''}${dayLabel(k)}</span><span>${g.n} ไม้ • ชนะ <b>${g.w}</b> • แพ้ <b>${g.l}</b> • สุทธิ <b class="${g.total >= 0 ? 'up' : 'down'}">${money(g.total, acctCur, true)}</b></span></div>`)
    .join('');
  // กระดานไม้จริงแยกซ้าย/ขวาของตัวปุ่ม (เหมือนกระดานไม้เสมือน): สกอร์บอร์ดฝั่งละอัน + เปิดอยู่ + ปิดล่าสุด
  const positions = Array.isArray(meta.positions) ? meta.positions : [];
  const reasonTh = { TP: 'TP', SL: 'SL', SO: 'Stop out', manual: 'ปิดเอง' };
  const board = (s) => {
    const perSide = rows.filter((t) => t.type === s);
    const w = perSide.filter((t) => t.profit > 0).length;
    const l = perSide.filter((t) => t.profit < 0).length;
    const total = perSide.reduce((sum, t) => sum + (Number.isFinite(t.profit) ? t.profit : 0), 0);
    const open = positions.filter((p) => p.type === s);
    const lines = [
      ...open.map((p) => `<div class="zh-line"><span class="t">เปิดอยู่</span><span>${s === 'buy' ? 'BUY' : 'SELL'} ${fmtD(p.volume, 2)} ล็อต @ ${fmtD(p.open)} → TP ${fmtD(p.tp)}</span><span class="res open ${p.profit >= 0 ? 'up' : 'down'}">${money(p.profit, acctCur, true)}${(() => { const px = s === 'buy' ? Number(meta.bid) : Number(meta.ask); if (!Number.isFinite(px)) return ''; const d = (s === 'buy' ? px - p.open : p.open - px) / Math.pow(10, -(meta.digits || 2)); return ` (${d >= 0 ? '+' : ''}${Math.round(d)} จุด)`; })()}</span></div>`),
      ...perSide.slice(0, 12).map((h) => {
        const pl = h.profit;
        const cls = h.reason === 'TP' ? 'TP' : h.reason === 'SL' ? 'SL' : pl === 0 ? 'open' : 'manual';
        return `<div class="zh-line"><span class="t">${Number.isFinite(h.time) ? stamp(h.time) : '—'}</span><span>${h.type === 'buy' ? 'BUY' : 'SELL'} ${fmtD(h.volume, 2)} ล็อต ${fmtD(h.open, 2)} → ${fmtD(h.close, 2)}</span><span class="res ${cls}">${(reasonTh[h.reason] || h.reason)} ${money(pl, acctCur, true)}</span></div>`;
      }),
    ];
    return `<div class="zh-side ${s}"><h5>${s === 'buy' ? 'ไม้จริงซื้อ (BUY)' : 'ไม้จริงขาย (SELL)'}</h5>
      <div class="zh-score">ชนะ <b>${w}</b> • แพ้ <b>${l}</b> • รวม <b class="${total >= 0 ? 'up' : 'down'}">${money(total, acctCur, true)}</b></div>
      <div class="zh-rows">${lines.length ? lines.join('') : '<div class="empty sm">ยังไม่มี — เข้าไม้จริงฝั่งนี้แล้วจะเริ่มจด</div>'}</div></div>`;
  };
  box.innerHTML =
    `<div class="zh">` + board('sell') + board('buy') +
    `<div class="zh-side zh-rounds"><h5>สรุปรายวัน (ทุกฝั่ง)</h5><div class="rh-days">${days || '<div class="empty sm">ยังไม่มีไม้ที่ปิดแล้ว</div>'}</div></div>` +
    `</div>`;
}

/* ---------- คำสั่งรอล่วงหน้า (pending limit/stop) ---------- */
function pendParts(kind) {
  const [side, ptype] = kind.split('-');
  return { side, ptype };
}

// SL/TP อัตโนมัติจากราคาที่จะรอ (เหมือนกฎไม้สด: ATR 1.8 / 4.5 — แต่ยึดราคาเข้า ไม่ใช่ราคาตอนกด)
// กันเหนียว: ระยะ SL เกินเพดาน 2% ของทุนจริง = ตีเข้าเดิมเอง (ไม้ "อัตโนมัติ" ต้องผ่านเกตได้จริงเสมอ)
function pendStops(kind, entry, snap) {
  const { side, ptype } = pendParts(kind);
  const meta = (snap && snap.meta) || {};
  let atrv = snap && snap.analysis && snap.analysis.tf && snap.analysis.tf.M15 && Number.isFinite(snap.analysis.tf.M15.atr)
    ? snap.analysis.tf.M15.atr : (Number.isFinite(entry) ? entry * 0.0008 : null);
  if (!Number.isFinite(entry) || !Number.isFinite(atrv)) return null;
  const lot = Number($('p-lot').value) || 0.01;
  const oz = (meta.spec && meta.spec.contractSize) || 100;
  const eqUSD = (meta.account && Number.isFinite(meta.account.equityUSD) && meta.account.equityUSD > 0) ? meta.account.equityUSD : (Number((snap && snap.risk && snap.risk.equity)) || 0);
  const maxDist = eqUSD > 0 ? (eqUSD * 0.02) / (lot * oz) : Infinity;
  if (atrv * 1.8 > maxDist) atrv = maxDist / 1.8;
  const dir = side === 'buy' ? 1 : -1;
  const d = meta.digits || 2;
  const read = (id, auto) => ($(id).value.trim() !== '' ? Number($(id).value) : Number(auto.toFixed(d)));
  return {
    sl: read('p-sl', side === 'buy' ? entry - atrv * 1.8 : entry + atrv * 1.8),
    tp: read('p-tp', side === 'buy' ? entry + atrv * 4.5 : entry - atrv * 4.5),
    side, ptype,
  };
}

function tryPending() {
  const kind = $('p-kind').value;
  const entry = Number($('p-entry').value);
  const lot = Number($('p-lot').value);
  if (!lastSnap || !lastSnap.meta || !Number.isFinite(lastSnap.meta.bid)) { toast('ต้องเชื่อม MT5 ก่อน — ราคา bid/ask ยังไม่มา', 'err'); return; }
  if (!Number.isFinite(entry) || entry <= 0) { toast('ใส่ราคาเข้าก่อน (ราคาที่จะรอ)', 'err'); return; }
  if (!Number.isFinite(lot) || lot <= 0) { toast('ล็อตไม่ถูกต้อง', 'err'); return; }
  const st = pendStops(kind, entry, lastSnap);
  if (!st || !Number.isFinite(st.sl) || st.sl <= 0) { toast('SL ยังไม่ถูกต้อง — ใส่ SL เองหรือราคาเข้าให้ถูก', 'err'); return; }
  const meta = lastSnap.meta || {};
  const px = st.side === 'buy' ? meta.ask : meta.bid;
  let hint = '';
  if (Number.isFinite(px)) {
    const g = lastSnap.guard || {};
    const bad = (st.ptype === 'limit' && st.side === 'buy' && !(entry < px))
      || (st.ptype === 'limit' && st.side === 'sell' && !(entry > px))
      || (st.ptype === 'stop' && st.side === 'buy' && !(entry > px))
      || (st.ptype === 'stop' && st.side === 'sell' && !(entry < px));
    const oz = (meta.spec && meta.spec.contractSize) || 100;
    const riskUSD = Math.abs(entry - st.sl) * lot * oz;
    $('pend-hint').innerHTML = `<span class="${bad ? 'down' : 'muted'}">ตอนนี้: ${fmtD(px)} </span>• เสี่ยงถ้าแตะ SL: <b>$${fmtD(riskUSD, 2)}</b> / เพดาน $${fmtD(((meta.account && meta.account.equityUSD) || (lastSnap.risk && lastSnap.risk.equity) || 0) * 0.02, 2)} • R:R 1:${fmtD(Math.abs((Number(st.tp) || entry) - entry) / (Math.abs(entry - st.sl) || 1e-9), 2)}${bad ? ' <b class="down">— ทิศราคาผิดตามชนิดที่เลือก (รายละเอียดเมื่อกด)</b>' : ''}`;
    hint = bad ? 'ทิศผิด' : 'ok';
  }
  openConfirmPending({ kind, entry, lot, sl: st.sl, tp: st.tp });
}

function openConfirmPending(req) {
  const { side, ptype } = pendParts(req.kind);
  const meta = lastSnap && lastSnap.meta ? lastSnap.meta : {};
  const digits = meta.digits || 2;
  const oz = (meta.spec && meta.spec.contractSize) || 100;
  const riskUSD = Math.abs(req.entry - req.sl) * req.lot * oz;
  $('mbox').innerHTML = `
    <h3>ยืนยันวางคำสั่งรอ — ${side === 'buy' ? 'BUY' : 'SELL'} ${ptype.toUpperCase()}</h3>
    <div class="mline"><span>ราคาเข้า (รอ trigger)</span><b>${fmtD(req.entry, digits)}</b></div>
    <div class="mline"><span>ล็อต</span><b>${fmtD(req.lot, 2)}</b></div>
    <div class="mline"><span>Stop Loss</span><b class="down">${fmtD(req.sl, digits)}</b></div>
    ${Number(req.tp) > 0 ? `<div class="mline"><span>Take Profit</span><b class="up">${fmtD(req.tp, digits)}</b></div>` : '<div class="mwarn">⚠ ไม่มี TP — ต้องปิดไม้เองด้วยมือ</div>'}
    <div class="mline"><span>เงินเสี่ยงถ้าแตะ SL</span><b class="gold">$${fmtD(riskUSD, 2)}</b></div>
    <div class="mwarn">⚠ กดยืนยัน = วางคำสั่งรอบน MT5 — เมื่อราคาถึง ระบบจะเปิดไม้เองพร้อม SL/TP ตามนี้ (โควตานับเป็น 1 ไม้)</div>
    <div class="merr" id="m-err"></div>
    <div class="mbtns">
      <button class="mcancel" id="m-cancel">ยกเลิก</button>
      <button class="mgo ${side}" id="m-go">วางคำสั่งรอจริง</button>
    </div>`;
  $('modal').classList.add('show');
  $('m-cancel').focus();
  $('m-cancel').addEventListener('click', closeModal);
  $('m-go').addEventListener('click', async () => {
    $('m-go').disabled = true;
    $('m-go').textContent = 'กำลังวาง...';
    try {
      const r = await window.api.sendPending({ side, ptype, lot: req.lot, entry: req.entry, sl: req.sl, tp: req.tp });
      if (r.ok) { closeModal(); toast(`⏱ วางคำสั่งรอแล้ว (id ${r.id}) — รอราคา trigger (เห็นในรายการคำสั่งรอ)`, 'ok'); setTimeout(() => window.api.refreshNow(), 1500); }
      else { $('m-err').textContent = '✗ ' + (r.reason || 'วางไม่ได้'); $('m-go').disabled = false; $('m-go').textContent = 'วางคำสั่งรอจริง'; }
    } catch (e) { $('m-err').textContent = '✗ ผิดพลาด: ' + e.message; $('m-go').disabled = false; $('m-go').textContent = 'วางคำสั่งรอจริง'; }
  });
}

// แก้คำสั่งรอ: ระหว่างแก้ไม่วาดรายการใหม่ (กันช่องกรอกถูกล้างทุกรอบ snapshot)
let editingPending = null;
function renderPendings(snap) {
  const box = $('pend-list');
  if (!box) return;
  const list = (snap.meta && Array.isArray(snap.meta.pendings)) ? snap.meta.pendings : null;
  if (editingPending != null && list && list.some((p) => Number(p.ticket) === editingPending)) return;
  editingPending = null;
  if (list === null) {
    box.innerHTML = '<div class="empty sm">ใช้ได้เมื่อ EA v1.7 อยู่บนชาร์ต — แท็บ MT5 → ติดตั้ง EA ให้ฉันเอง</div>';
    return;
  }
  if (!list.length) { box.innerHTML = '<div class="empty sm">ไม่มีคำสั่งรออยู่</div>'; return; }
  const label = { buylimit: 'BUY LIMIT', selllimit: 'SELL LIMIT', buystop: 'BUY STOP', sellstop: 'SELL STOP', other: 'ORDER' };
  const m = snap.meta;
  box.innerHTML = list.map((p) => {
    let dist = '';
    if (Number.isFinite(m.bid) && p.open) {
      const d = p.type.includes('buy') ? m.bid - p.open : p.open - m.bid;
      dist = ` • ${d >= 0 ? 'ใกล้แล้ว' : 'ห่าง'} $${fmtD(Math.abs(d), 2)}`;
    }
    const editable = p.type !== 'other';
    return `<div class="pend-line" data-t="${p.ticket}"><span style="font-weight:700">${label[p.type] || p.type}</span><span class="pend-info">ล็อต ${fmtD(p.volume, 2)} • ราคา ${fmtD(p.open)} • SL ${fmtD(p.sl)} • TP ${Number(p.tp) ? fmtD(p.tp) : '—'}</span><span class="muted">${dist}</span><span class="pend-act">${editable ? `<button class="pedit-p" data-t="${p.ticket}">แก้</button> ` : ''}<button class="pcancel" data-t="${p.ticket}">ยกเลิก</button></span></div>`;
  }).join('');
  if (closingTicketsPending.size) {
    box.querySelectorAll('.pcancel').forEach((b) => { if (closingTicketsPending.has(Number(b.dataset.t))) { b.disabled = true; b.textContent = 'กำลังยกเลิก...'; } });
  }
  box.querySelectorAll('.pcancel').forEach((b) => b.addEventListener('click', () => cancelPending(Number(b.dataset.t))));
  box.querySelectorAll('.pedit-p').forEach((b) => b.addEventListener('click', () => startEditPending(list.find((p) => Number(p.ticket) === Number(b.dataset.t)))));
}

function startEditPending(p) {
  if (!p) return;
  const row = $('pend-list').querySelector(`.pend-line[data-t="${CSS.escape(String(p.ticket))}"]`);
  if (!row) return;
  editingPending = Number(p.ticket);
  const val = (n) => (Number(n) ? Number(n).toFixed(2) : '');
  row.querySelector('.pend-info').innerHTML = `ล็อต ${fmtD(p.volume, 2)} • ราคา <input class="pin" type="number" step="0.01" data-k="entry" value="${val(p.open)}"> • SL <input class="pin" type="number" step="0.01" data-k="sl" value="${val(p.sl)}"> • TP <input class="pin" type="number" step="0.01" data-k="tp" value="${val(p.tp)}" placeholder="ว่าง = ไม่มี">`;
  row.querySelector('.pend-act').innerHTML = '<button class="psave">บันทึก</button> <button class="pcancel-edit">ยกเลิกแก้</button>';
  const done = () => { editingPending = null; if (lastSnap) renderPendings(lastSnap); };
  row.querySelector('.pcancel-edit').addEventListener('click', done);
  const save = async () => {
    const get = (k) => Number(row.querySelector(`[data-k="${k}"]`).value);
    const btn = row.querySelector('.psave');
    const same = (x, y) => Math.abs((Number(x) || 0) - (Number(y) || 0)) < 0.005;
    if (same(get('entry'), p.open) && same(get('sl'), p.sl) && same(get('tp'), p.tp)) { toast('ไม่มีการเปลี่ยนแปลง — แก้ราคา/SL/TP ก่อนกดบันทึก'); return; }
    btn.disabled = true; btn.textContent = 'กำลังส่ง…';
    try {
      const r = await window.api.modifyPending({ ticket: p.ticket, entry: get('entry'), sl: get('sl'), tp: get('tp') || 0 });
      if (r.ok) { toast(`📤 ส่งคำสั่งแก้คำสั่งรอ #${p.ticket} แล้ว (เสี่ยง $${r.metrics.riskUSD}) — รอผลจาก MT5...`, 'ok'); done(); setTimeout(() => window.api.refreshNow(), 1500); return; }
      toast('✗ แก้ไม่ได้: ' + (r.reason || 'ไม่ทราบสาเหตุ'), 'err');
    } catch (e) { toast('✗ แก้ไม่ได้: ' + e.message, 'err'); }
    btn.disabled = false; btn.textContent = 'บันทึก';
  };
  row.querySelector('.psave').addEventListener('click', save);
  row.querySelectorAll('.pin').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { e.stopPropagation(); done(); } }));
  row.querySelector('[data-k="entry"]').focus();
}

const closingTicketsPending = new Set();
// ปุ่ม ⛶ ขยายการ์ดคำสั่งรอเต็มจอ / Esc = ย่อกลับ
$('pend-max').addEventListener('click', () => {
  const el = $('pend-card');
  const max = !el.classList.contains('max');
  el.classList.toggle('max', max);
  $('pend-max').textContent = max ? '↘ ย่อ' : '⛶';
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('pend-card') && $('pend-card').classList.contains('max') && !$('modal').classList.contains('show')) {
    $('pend-card').classList.remove('max');
    $('pend-max').textContent = '⛶';
  }
});
async function cancelPending(ticket) {
  closingTicketsPending.add(ticket);
  if (lastSnap) renderPendings(lastSnap);
  const r = await window.api.cancelPending(ticket);
  if (!r.ok) { toast('ยกเลิกไม่ได้: ' + (r.reason || 'ส่งไม่ได้'), 'err'); }
  else toast(`⏱ ส่งคำสั่งยกเลิกไม้รอ #${ticket} — รอ MT5 ลบ (จะหายจากรายการ)`, 'ok');
  setTimeout(() => { closingTicketsPending.delete(ticket); window.api.refreshNow(); }, 1500);
}

function renderLogs(snap) {
  $('logs').innerHTML = (snap.logs || []).slice().reverse().map((l) => `<div class="logline ${l.lvl}"><span class="t">${fmtTs(l.t)}</span><span class="tag">${esc(l.tag)}</span><span>${esc(l.msg)}</span></div>`).join('') || '<div class="empty">ยังไม่มีบันทึก</div>';
}

/* ---------- trading (คำสั่งซื้อขายจริงผ่าน MT5, กันเหนียว 3 ชั้น) ---------- */
function toast(msg, cls = '') {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + cls;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 8000);
}

const fmtD = (n, d) => Number.isFinite(n) ? n.toFixed(d) : '—';
// เงินตามสกุลบัญชี MT5: USD = $1,234.56 • สกุลอื่น = 1,234.56 THB (เดิมขึ้น $ ทุกสกุล ทำให้เข้าใจผิด)
let acctCur = 'USD';
function money(v, cur = acctCur, signed = false) {
  if (!Number.isFinite(v)) return '—';
  const sign = signed ? (v > 0 ? '+' : v < 0 ? '-' : '') : (v < 0 ? '-' : '');
  const n = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return !cur || cur === 'USD' ? `${sign}$${n}` : `${sign}${n} ${cur}`;
}

// SL/TP ของฝั่งที่จะกด: ช่องที่ผู้ใช้กรอก = ใช้ค่านั้น, ช่องว่าง = ATR(M15)×1.8 / ×4.5 จากราคาฝั่งนั้น
function stopsFor(side, snap) {
  const meta = (snap && snap.meta) || {};
  const px = side === 'buy' ? meta.ask : meta.bid;
  if (!Number.isFinite(px)) return null;
  const m15 = snap.analysis && snap.analysis.tf && snap.analysis.tf.M15;
  let atr = m15 && Number.isFinite(m15.atr) && m15.atr > 0 ? m15.atr : px * 0.0008;
  const dir = side === 'buy' ? 1 : -1;
  const d = meta.digits || 2;
  // "อัตโนมัติ" ต้องให้ไม้ที่ผ่านเกตได้จริง: ระยะ SL เกินเพดานเงิน (2% ทุนจริง) = ตีเข้าเดิม (สมดุล: ไม้แน่น + TP คงเดิม)
  const lot = Number($('t-lot').value) || 0.01;
  const oz = (meta.spec && meta.spec.contractSize) || 100;
  const eqUSD = (meta.account && Number.isFinite(meta.account.equityUSD) && meta.account.equityUSD > 0) ? meta.account.equityUSD : (Number((snap && snap.risk && snap.risk.equity)) || 0);
  const maxDist = eqUSD > 0 ? (eqUSD * 0.02) / (lot * oz) : Infinity;
  if (atr * 1.8 > maxDist) atr = maxDist / 1.8;
  const read = (id, auto) => ($(id).value.trim() !== '' ? Number($(id).value) : Number(auto.toFixed(d)));
  return { sl: read('t-sl', px - dir * atr * 1.8), tp: read('t-tp', px + dir * atr * 4.5), px };
}

function renderTradePanel(snap) {
  const meta = snap.meta || {};
  const live = Number.isFinite(meta.bid) && Number.isFinite(meta.ask);
  const s = snap.risk || {};
  const quota = snap.guard || {};
  const d = meta.digits || 2;
  const acct = meta.account || snap.account || null;
  if (acct && acct.currency) acctCur = acct.currency;
  const eqLive = acct && Number.isFinite(acct.equityUSD) && acct.equityUSD > 0 ? acct.equityUSD : null;
  const eqUsed = eqLive || (Number(s.equity) || 0);
  $('t-bid').textContent = live ? meta.bid.toFixed(d) : '—';
  $('t-ask').textContent = live ? meta.ask.toFixed(d) : '—';
  // SL/TP ว่าง = คิดให้อัตโนมัติตามฝั่งที่กด (เดิมเติม SL ฝั่งซื้อไว้ช่องเดียว กด SELL แล้ว SL อยู่ผิดฝั่ง)
  const lotVal = Number($('t-lot').value);
  const riskOf = (side) => {
    if (!live || !Number.isFinite(lotVal)) return null;
    const st = stopsFor(side, snap);
    return st && Number.isFinite(st.sl) ? (side === 'buy' ? meta.ask - st.sl : st.sl - meta.bid) : null;
  };
  const riskBuy = riskOf('buy'), riskSell = riskOf('sell');
  const capUSD = eqUsed * 0.02;   // เพดาน 2% จากทุนจริง (ถ้าเชื่อม MT5) หรือทุนที่ตั้ง
  const oz = (meta.spec && meta.spec.contractSize) || 100;
  const rb = riskBuy != null && riskBuy > 0 ? (riskBuy * lotVal * oz) : null;
  const rs = riskSell != null && riskSell > 0 ? (riskSell * lotVal * oz) : null;
  // สถานะสวิตช์จากฝั่ง MT5 จริง (EA + AutoTrading)
  const gateTxt = live && !meta.spec
    ? '⚠ EA ใน MT5 รุ่นเก่า ส่งไม้ไม่ได้ — แท็บ MT5 → ติดตั้ง EA แล้วลากลงชาร์ตใหม่'
    : acct
    ? (acct.ordersAllowed && acct.algoTrading ? 'ส่งไม้พร้อม ✓' : `ส่งไม้ยังไม่พร้อม (AllowOrders: ${acct.ordersAllowed ? '✓' : '✗'} • AutoTrading: ${acct.algoTrading ? '✓' : '✗'})`)
    : '—';
  $('t-info').textContent = live
    ? `เสี่ยง/ไม้: ซื้อ $${rb != null ? fmtD(rb, 2) : '—'} • ขาย $${rs != null ? fmtD(rs, 2) : '—'} / เพดาน $${fmtD(capUSD, 2)} (2% ของ ${eqLive ? `ทุนจริง ≈ $${fmtD(eqUsed, 0)}${acctCur !== 'USD' ? ` แปลงจาก ${acctCur}` : ''}` : `ทุนที่ตั้ง $${fmtD(eqUsed, 0)}`}) • โควตา ${(quota.dailyCount || 0) + (quota.manualCount || 0)}/${quota.maxPerDay} • ${gateTxt}`
    : 'ส่งออร์เดอร์จริงใช้ได้เมื่อเชื่อม MT5 (ราคา bid/ask มาจากโบรกเกอร์ของคุณ — ลาก EA JsonBridgeEA ลงชาร์ตทองแล้วรอ 5 วิ)';
  // บัญชีจริงแถวล่าง (ทุนจริง/ทุนสุทธิ/กำไรลอยตัว/มาร์จิ้น)
  const acctLine = $('acct-line');
  if (acct && Number.isFinite(acct.balance)) {
    const floatPnl = acct.equity - acct.balance;
    acctLine.innerHTML = `<span>${esc(acct.name || 'บัญชี')} #${esc(acct.login)} @ ${esc(acct.server)}</span>` +
      `<span>ทุน <b>${money(acct.balance)}</b></span>` +
      `<span>สุทธิ <b class="${floatPnl >= 0 ? 'up' : 'down'}">${money(acct.equity)}</b></span>` +
      `<span>ลอยตัว <b class="${floatPnl >= 0 ? 'up' : 'down'}">${money(floatPnl, acctCur, true)}</b></span>` +
      `<span>มาร์จิ้นคงเหลือ <b>${money(acct.marginFree)}</b></span>`;
  } else {
    acctLine.textContent = 'ข้อมูลบัญชีจริงจะโชว์เมื่อ EA v1.6 ลงชาร์ตแล้ว (ลากใหม่ใน MT5)';
  }
}

// ขาดทุนลอยตัวรวมเกินเท่านี้ (% ของทุน) = ปุ่มปิดทุกไม้เรืองเตือน "ควรพิจารณาหยุด" (ไม่ปิดเอง — ผู้ใช้ตัดสินใจ)
const STOP_HINT_PCT = 2;
function renderCloseAll(meta, list) {
  const row = $('closeall-row');
  row.hidden = !list.length;
  if (!list.length) return;
  const acct = meta && meta.account;
  const pnl = list.reduce((s, p) => s + (Number(p.profit) || 0), 0);
  const pct = acct && acct.balance > 0 ? (pnl / acct.balance) * 100 : null;
  const alert = pct != null && pct <= -STOP_HINT_PCT;
  row.classList.toggle('alert', alert);
  const busy = list.every((p) => isClosing(p.ticket));
  $('btn-close-all').disabled = busy;
  $('btn-close-all').textContent = busy ? 'กำลังปิด…' : `ปิดทุกไม้ (${list.length})`;
  $('closeall-hint').innerHTML = `ลอยตัวรวม <b class="${pnl >= 0 ? 'up' : 'down'}">${money(pnl, acctCur, true)}</b>${pct != null ? ` (${pct >= 0 ? '+' : ''}${fmtD(pct, 2)}% ของทุน)` : ''}` +
    (alert ? ` — <b class="down">⚠ ขาดทุนเกิน ${STOP_HINT_PCT}% ของทุน: ถึงจุดควรพิจารณาหยุด</b>` : '');
}

// แก้ SL/TP: ระหว่างแก้ไม่วาดตารางใหม่ (กันช่องกรอกถูกล้างทุกรอบ snapshot)
let editingTicket = null;
function renderPositions(meta) {
  const list = (meta && meta.positions) || [];
  const box = $('positions');
  renderCloseAll(meta, list);
  renderAutoClose(meta, list);
  if (editingTicket != null && list.some((p) => Number(p.ticket) === editingTicket)) return;
  editingTicket = null;
  if (!list.length) { box.innerHTML = '<div class="empty">ไม่มีออร์เดอร์ที่เปิดอยู่ (XAUUSD)</div>'; return; }
  box.innerHTML = '<table><tr><th>ฝั่ง</th><th>ล็อต</th><th>เข้า</th><th>SL</th><th>TP</th><th>กำไร/ขาดทุน</th><th></th></tr>' +
    list.map((p) => `<tr data-row="${esc(p.ticket)}">
      <td class="ptype ${p.type}">${p.type === 'buy' ? 'ซื้อ' : 'ขาย'}</td>
      <td>${Number(p.volume).toFixed(2)}</td><td>${fmtD(p.open, 2)}</td><td class="c-sl">${Number(p.sl) ? fmtD(p.sl, 2) : '—'}</td><td class="c-tp">${Number(p.tp) ? fmtD(p.tp, 2) : '—'}</td>
      <td class="${p.profit >= 0 ? 'up' : 'down'}">${money(p.profit, acctCur, true)}</td>
      <td class="c-act"><button class="pclose pedit" data-ticket="${esc(p.ticket)}"${isClosing(p.ticket) ? ' disabled' : ''}>แก้</button> <button class="pclose" data-ticket="${esc(p.ticket)}"${isClosing(p.ticket) ? ' disabled' : ''}>${isClosing(p.ticket) ? 'กำลังปิด…' : 'ปิด'}</button></td>
    </tr>`).join('');
  box.querySelectorAll('.pclose:not(.pedit)').forEach((b) => b.addEventListener('click', () => closeNow([Number(b.dataset.ticket)])));
  box.querySelectorAll('.pedit').forEach((b) => b.addEventListener('click', () => startEdit(list.find((p) => Number(p.ticket) === Number(b.dataset.ticket)))));
}

function startEdit(p) {
  if (!p) return;
  const row = $('positions').querySelector(`tr[data-row="${CSS.escape(String(p.ticket))}"]`);
  if (!row) return;
  editingTicket = Number(p.ticket);
  const val = (n) => (Number(n) ? Number(n).toFixed(2) : '');
  row.querySelector('.c-sl').innerHTML = `<input class="pin" type="number" step="0.01" data-k="sl" value="${val(p.sl)}" placeholder="SL">`;
  row.querySelector('.c-tp').innerHTML = `<input class="pin" type="number" step="0.01" data-k="tp" value="${val(p.tp)}" placeholder="TP (ว่าง = ไม่มี)">`;
  row.querySelector('.c-act').innerHTML = '<button class="pclose psave">บันทึก</button> <button class="pclose pcancel">ยกเลิก</button>';
  const done = () => { editingTicket = null; if (lastSnap) renderPositions(lastSnap.meta); };
  row.querySelector('.pcancel').addEventListener('click', done);
  const save = async () => {
    const sl = Number(row.querySelector('[data-k="sl"]').value);
    const tp = Number(row.querySelector('[data-k="tp"]').value) || 0;
    const btn = row.querySelector('.psave');
    const same = (x, y) => Math.abs((Number(x) || 0) - (Number(y) || 0)) < 0.005;
    if (same(sl, p.sl) && same(tp, p.tp)) { toast('ไม่มีการเปลี่ยนแปลง — แก้ SL/TP ก่อนกดบันทึก'); return; }
    btn.disabled = true; btn.textContent = 'กำลังส่ง…';
    try {
      const r = await window.api.modifyPosition({ ticket: p.ticket, sl, tp });
      if (r.ok) { toast(`📤 ส่งคำสั่งแก้ไม้ #${p.ticket} แล้ว (เสี่ยง $${r.metrics.riskUSD}) — รอผลจาก MT5...`, 'ok'); done(); return; }
      toast('✗ แก้ไม่ได้: ' + (r.reason || 'ไม่ทราบสาเหตุ'), 'err');
    } catch (e) { toast('✗ แก้ไม่ได้: ' + e.message, 'err'); }
    btn.disabled = false; btn.textContent = 'บันทึก';
  };
  row.querySelector('.psave').addEventListener('click', save);
  row.querySelectorAll('.pin').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') done(); }));
  row.querySelector('[data-k="sl"]').focus();
}

/* ---------- ปิดไม้ทันที (ไม่มีหน้ายืนยัน — ผู้ใช้เลือกให้เร็วทันตลาด) ----------
   กันกดซ้ำ: ไม้ที่กำลังปิดจำไว้ 20 วิ ปุ่มของไม้นั้นกดไม่ได้จนกว่าจะปิดเสร็จ/คำสั่งหมดอายุ */
const closingTickets = new Map(); // ticket → เวลาที่กด
const isClosing = (t) => { const at = closingTickets.get(Number(t)); return at != null && Date.now() - at < 20_000; };
async function closeNow(tickets) {
  const todo = tickets.filter((t) => !isClosing(t));
  if (!todo.length) return;
  todo.forEach((t) => closingTickets.set(Number(t), Date.now()));
  if (lastSnap) { renderPositions(lastSnap.meta); }
  try {
    const all = tickets.length > 1;
    const r = all ? await window.api.closeAll() : await window.api.closePosition(todo[0]);
    if (r.ok) {
      toast(all ? `📤 ส่งคำสั่งปิด ${r.count} ไม้แล้ว — รอผลจาก MT5...` : `📤 ส่งคำสั่งปิดไม้ #${todo[0]} แล้ว — รอผลจาก MT5...`, 'ok');
      setTimeout(() => window.api.refreshNow(), 1200);
      return;
    }
    toast('✗ ปิดไม่ได้: ' + (r.reason || 'ไม่ทราบสาเหตุ'), 'err');
  } catch (e) { toast('✗ ปิดไม่ได้: ' + e.message, 'err'); }
  todo.forEach((t) => closingTickets.delete(Number(t)));
  if (lastSnap) renderPositions(lastSnap.meta);
}

function closeModal() {
  $('modal').classList.remove('show');
  // ปิดหน้ายืนยัน = สิ้นสุดคำเชิญของไม้นี้ และจำไว้ว่าไม่ต้องเด้งไม้เดิมซ้ำ (เดิม Esc แล้วเด้งกลับทุกรอบวิเคราะห์)
  if (autoPrompt) {
    if (autoDismissed.size > 200) autoDismissed.clear();
    autoDismissed.add(autoPrompt.id);
  }
  autoPrompt = null;
}

/* ---------- สวิตช์ "เข้าอัตโนมัติ" (autoEnter) — 2 โหมด ----------
   เปิด  = ระบบเข้าไม้เองทันทีที่ผ่านทุกเกต (มติสภา+เสี่ยงน้อยสุด+โควตา+เพดาน 2%+SL บังคับ)
           → คำสั่งยังวิ่งผ่าน send-order เดิม (กันเหนียวตรวจซ้ำทุกชั้นก่อนถึง MT5)
   ปิด  = ระบบเด้งหน้ายืนยันรอกด + ยกเลิกคำเชิญเองเมื่อราคาทะลุ SL/TP / ถูกยึด / เกิน 15 นาที */
let autoPrompt = null; // { key, id, sig, at }
const autoDismissed = new Set(); // id ไม้ที่จัดการแล้ว (เชิญแล้ว/เข้าแล้ว — กันทำซ้ำ)
const sigId = (x) => `${x.plugin || '?'}|${x.side}|${x.ts || ''}`;

function autoEnterTick(snap) {
  const cfg = appSettings || {};
  if (cfg.realOrdersEnabled !== true) return;

  /* ---- โหมดยืนยัน (สวิตช์ปิด): เด้งหน้ายืนยันรอกด ---- */
  if (cfg.autoEnter !== true) {
    if (autoPrompt) {
      const stillOpen = $('modal').classList.contains('show');
      if (!stillOpen) { autoPrompt = null; return; }
      const sig = autoPrompt.sig;
      const meta = snap.meta || {};
      const px = sig.side === 'buy' ? meta.ask : meta.bid;
      const tpHit = Number(sig.tp) > 0 && (sig.side === 'buy' ? px >= sig.tp : px <= sig.tp); // ไม่มี TP = ไม่นับ (เดิม tp=0 ทำให้ยกเลิกทันที)
      const crossed = Number.isFinite(px) && ((sig.side === 'buy' ? px <= sig.sl : px >= sig.sl) || tpHit);
      const nowHeld = (snap.signals || []).some((x) => `${x.plugin || '?'}|${x.side}` === autoPrompt.key && x.held);
      const staleTime = Date.now() - autoPrompt.at > 15 * 60_000;
      if (crossed || nowHeld || staleTime || cfg.realOrdersEnabled !== true) {
        const why = crossed ? 'ราคาทะลุจุด SL/TP ของโอกาส — ไม่ให้ส่งไม้ตามราคาเก่า'
          : nowHeld ? 'เกตความเสี่ยงกลับมายึดไม้นี้ (โควตา/สภา/หยุดข่าว เปลี่ยน)'
          : staleTime ? 'เกินเวลารอ 15 นาที — ราคาอาจเก่าเกิน' : 'โหมดส่งจริงถูกปิด';
        closeModal();
        toast(`⏹ ยกเลิกคำเชิญยืนยันเอง — ${why}`, 'err');
        return;
      }
      return;
    }
    if ($('modal').classList.contains('show')) return;
    const approved = (snap.signals || []).filter((x) => !x.held && !autoDismissed.has(sigId(x)));
    if (!approved.length) return;
    const sig = approved[0];
    if (!Number.isFinite(sig.sl) || sig.sl <= 0) return;
    const lot = Math.max(0.01, Number(sig.metrics && sig.metrics.lot) || 0.01);
    autoPrompt = { key: `${sig.plugin || '?'}|${sig.side}`, id: sigId(sig), sig, at: Date.now() };
    openConfirm({ action: sig.side, lot, sl: sig.sl, tp: sig.tp || 0 });
    const c = sig.council && sig.council.conf != null ? ` • มติสภา ${sig.council.conf}%` : (snap.council ? ` • มติสภา ${snap.council.confidence}%` : '');
    toast(`🤖 เชิญยืนยัน: ไม้${sig.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${sig.side === 'buy' ? 'BUY' : 'SELL'} ผ่านทุกเกต${c} — รอคุณกดส่ง/ยกเลิก`, 'ok');
    return;
  }

  /* ---- โหมดเข้าอัตโนมัติ (สวิตช์เปิด): main process ส่งเอง (ทำงานแม้ปิดหน้าต่าง) — หน้านี้แค่แจ้งผล ---- */
}
// Esc / คลิกพื้นหลัง = ปิด modal
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });

// modal ยืนยันแบบ 2 ชั้นสำหรับเปิดไม้ — กดซื้อ/ขาย = เปิด, กดยืนยัน = ส่งจริง (การปิดไม้ไม่ผ่านหน้านี้)
function openConfirm(req) {
  const meta = lastSnap && lastSnap.meta ? lastSnap.meta : {};
  const g = lastSnap && lastSnap.guard ? lastSnap.guard : {};
  const v = lastSnap && lastSnap.council ? lastSnap.council : null;
  const digits = meta.digits || 2;
  const buy = req.action === 'buy';
  const entry = buy ? meta.ask : meta.bid;
  const sl = Number(req.sl), tp = Number(req.tp) || 0, lot = Number(req.lot);
  const slDist = Math.abs(entry - sl);
  const oz = (meta.spec && meta.spec.contractSize) || 100;
  const riskUSD = lot * slDist * oz;
  // เพดาน 2% จากทุน USD — เตือนก่อนกด (ฝั่ง main ปฏิเสธอยู่แล้ว แต่ผู้ใช้ควรรู้ตั้งแต่หน้านี้)
  const acct = meta.account;
  const capEq = acct && acct.equityUSD > 0 ? acct.equityUSD : Number(lastSnap && lastSnap.risk && lastSnap.risk.equity) || 0;
  const cap = capEq * 0.02;
  const overCap = cap > 0 && riskUSD > cap * 1.001;
  const goTxt = buy ? 'ส่งไม้ซื้อจริง' : 'ส่งไม้ขายจริง';
  const councilLine = v && v.side !== 'none'
    ? `<div class="mline"><span>มติสภา</span><b>${v.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${v.confidence}% (เห็นพ้อง ${v.agree})</b></div>`
    : '<div class="mline"><span>มติสภา</span><b>ยังไม่มีมติชัด</b></div>';
  $('mbox').innerHTML = `
    <h3>${buy ? 'ยืนยันส่งไม้ซื้อ (BUY)' : 'ยืนยันส่งไม้ขาย (SELL)'}</h3>
    <div class="mline"><span>ราคา (${buy ? 'ASK' : 'BID'})</span><b>${fmtD(entry, digits)}</b></div>
    <div class="mline"><span>ล็อต</span><b>${fmtD(lot, 2)}</b></div>
    <div class="mline"><span>Stop Loss</span><b class="down">${fmtD(sl, digits)}</b></div>
    ${tp ? `<div class="mline"><span>Take Profit</span><b class="up">${fmtD(tp, digits)}</b></div>` : ''}
    <div class="mline"><span>เงินเสี่ยงถ้าแตะ SL</span><b class="gold">$${fmtD(riskUSD, 2)}</b></div>
    ${tp ? `<div class="mline"><span>R:R</span><b>1:${fmtD(Math.abs(tp - entry) / (slDist || 1e-9), 2)}</b></div>` : ''}
    ${councilLine}
    ${overCap ? `<div class="merr">✗ เสี่ยง $${fmtD(riskUSD, 2)} เกินเพดาน 2% ของทุน ($${fmtD(cap, 2)}) — ระบบจะปฏิเสธ: ลดล็อตหรือขยับ SL ให้ใกล้ขึ้น</div>` : ''}
    ${g.newsStop ? '<div class="mwarn">⚠ โหมดหยุดช่วงข่าวเปิดอยู่ — ไม้นี้มาจากความตั้งใจของคุณ ไม่ใช่สัญญาณระบบ</div>' : ''}
    ${!tp ? '<div class="mwarn">⚠ ไม่มี TP — ต้องปิดไม้เองด้วยมือ</div>' : ''}
    <div class="mwarn">⚠ กดยืนยัน = ลำดับ MARKET จะไปบัญชี MT5 ของคุณทันที</div>
    <div class="merr" id="m-err"></div>
    <div class="mbtns">
      <button class="mcancel" id="m-cancel">ยกเลิก</button>
      <button class="mgo ${buy ? 'buy' : 'sell'}" id="m-go">${goTxt}</button>
    </div>`;
  $('modal').classList.add('show');
  $('m-cancel').focus(); // ปุ่มที่โฟกัสก่อน = ยกเลิก (กด Enter พลาดไม่ส่งไม้)
  $('m-cancel').addEventListener('click', closeModal);
  $('m-go').addEventListener('click', async () => {
    $('m-go').disabled = true;
    $('m-go').textContent = 'กำลังส่ง...';
    try {
      const r = await window.api.sendOrder({ side: buy ? 'buy' : 'sell', lot, sl, tp });
      if (r.ok) {
        closeModal();
        toast(`📤 ส่งคำสั่งแล้ว (id ${r.id}) — รอผลจาก MT5...`, 'ok');
        setTimeout(() => window.api.refreshNow(), 1500);
      } else {
        $('m-err').textContent = '✗ ' + (r.reason || 'ส่งไม่ได้');
        $('m-go').disabled = false;
        $('m-go').textContent = goTxt;
      }
    } catch (e) {
      $('m-err').textContent = '✗ ผิดพลาด: ' + e.message;
      $('m-go').disabled = false;
      $('m-go').textContent = goTxt;
    }
  });
}

$('t-real').addEventListener('change', async (e) => {
  const on = e.target.checked;
  if (on) {
    if (!confirm('เปิดโหมดส่งออร์เดอร์จริง?\n\n1) ใน MT5: ตั้ง "AllowOrders = true" ในหน้าต่างตั้งค่า EA + เปิดปุ่ม AutoTrading ให้เขียว\n2) ทุกไม้จะเข้าบัญชีจริง: SL บังคับ, เพดานเสี่ยง 2% ต่อไม้, โควตา/วัน, มติสภาต่าง = แยง\n\nยืนยันเปิด?')) {
      e.target.checked = false; return;
    }
  }
  try { await window.api.saveSettings({ realOrdersEnabled: on }); } catch (err) { e.target.checked = !on; toast('บันทึกไม่สำเร็จ: ' + err.message, 'err'); return; }
  if (appSettings) appSettings.realOrdersEnabled = on;
  toast(on ? '🔓 เปิดโหมดส่งจริง — กดซื้อ/ขายคราวนี้เข้าบัญชีจริง' : '🔒 ปิดโหมดส่งจริง แล้ว (ปุ่มจะถูกกันไม่ให้ส่ง)', on ? 'ok' : '');
});

// สวิตช์ "เข้าอัตโนมัติ" บนการ์ด: เปิด = ระบบเข้าไม้เองเมื่อผ่านทุกเกต • ปิด = ระบบเด้งหน้ายืนยันรอกด
$('t-auto').addEventListener('change', async (e) => {
  const on = e.target.checked;
  try { await window.api.saveSettings({ autoEnter: on }); } catch (err) { e.target.checked = !on; toast('บันทึกไม่สำเร็จ: ' + err.message, 'err'); return; }
  if (appSettings) appSettings.autoEnter = on;
  toast(on
    ? '🤖 เข้าอัตโนมัติเปิด — ไม้ที่ผ่านทุกเกต (สภา70%+เสี่ยงน้อยสุด+โควตา+2%ของทุนจริง+SLบังคับ) ระบบจะส่งเองทันที'
    : '✋ เข้าอัตโนมัติปิด — ระบบจะเด้งหน้ายืนยันรอคุณกดทุกไม้ (ไม่ส่งเอง)', on ? 'ok' : '');
});

/* ---------- ปิดอัตโนมัติเพื่อเซฟกำไร (ฝั่ง main ตัดสินทุกทิค — หน้านี้แค่ตั้งค่า + โชว์ระยะถึงเป้า) ---------- */
function renderAutoClose(meta, list) {
  $('ac-cur').textContent = acctCur || '';
  $('ac-loss-cur').textContent = acctCur || '';
  const digits = (meta && meta.digits) || 2;
  const pts = Number($('ac-pts-v').value);
  $('ac-pts-px').textContent = pts > 0 ? `(= ราคา ${(pts * Math.pow(10, -digits)).toFixed(digits)})` : '';
  const allPts = Number($('ac-allpts-v').value);
  $('ac-allpts-px').textContent = allPts > 0 ? `(= ราคา ${(allPts * Math.pow(10, -digits)).toFixed(digits)})` : '';
  const st = $('ac-status');
  if (!list.length) { st.textContent = 'ไม่มีไม้ที่เปิดอยู่'; return; }
  const total = list.reduce((s, p) => s + (Number(p.profit) || 0), 0);
  const bid = meta && Number(meta.bid), ask = meta && Number(meta.ask);
  const ptsOf = (p) => (p.type === 'buy' ? bid - p.open : p.open - ask) / Math.pow(10, -digits);
  const live = Number.isFinite(bid) && Number.isFinite(ask);
  const best = live ? Math.max(...list.map(ptsOf)) : null;
  const sumPts = live ? list.reduce((s, p) => s + ptsOf(p), 0) : null;
  const parts = [`กำไรรวมตอนนี้ ${money(total, acctCur, true)}`];
  if ($('ac-all').checked) parts[0] += ` / เป้า ${fmtD(Number($('ac-all-v').value), 2)} ${acctCur || ''}`;
  if ($('ac-loss').checked) parts[0] += ` / ตัดขาดทุนที่ -${fmtD(Number($('ac-loss-v').value), 2)} ${acctCur || ''}`;
  if (sumPts != null) parts.push(`จุดรวม ${sumPts >= 0 ? '+' : ''}${Math.round(sumPts)} จุด${$('ac-allpts').checked ? ` / เป้า ${allPts} จุด` : ''}`);
  if (best != null) parts.push(`ไม้ที่บวกมากสุด ${best >= 0 ? '+' : ''}${Math.round(best)} จุด${$('ac-pts').checked ? ` / เป้า ${pts} จุด` : ''}`);
  st.innerHTML = parts.map(esc).join(' • ');
}

async function saveAutoClose(partial, okMsg) {
  try {
    const clean = await window.api.saveSettings(partial);
    if (appSettings) Object.assign(appSettings, clean);
    if (okMsg) toast(okMsg, 'ok');
    return clean;
  } catch (err) { toast('บันทึกไม่สำเร็จ: ' + err.message, 'err'); return null; }
}
function bindAutoClose(swId, valId, key, valKey, label, unit) {
  $(swId).addEventListener('change', async (e) => {
    const on = e.target.checked;
    const v = Number($(valId).value);
    if (on && !(v > 0)) { e.target.checked = false; toast(`ใส่เป้า${label}ก่อน (มากกว่า 0)`, 'err'); return; }
    if (on && !confirm(`เปิด${label}อัตโนมัติ?\n\nเมื่อถึง ${v} ${unit()} ระบบจะส่งคำสั่งปิดไม้จริงใน MT5 ทันที (ไม่ถามซ้ำ)\nต้องเปิด MT5 + EA บนชาร์ตไว้ แอปต้องเปิดอยู่`)) { e.target.checked = false; return; }
    const r = await saveAutoClose({ [key]: on, [valKey]: v }, on ? `🔒 เปิด${label}: ปิดเมื่อถึง ${v} ${unit()}` : `ปิด${label}อัตโนมัติแล้ว`);
    if (!r) e.target.checked = !on;
    if (lastSnap) renderPositions(lastSnap.meta);
  });
  $(valId).addEventListener('change', async () => {
    const v = Number($(valId).value);
    if (!(v > 0)) { toast('เป้าต้องมากกว่า 0', 'err'); $(valId).value = appSettings ? appSettings[valKey] : ''; return; }
    const r = await saveAutoClose({ [valKey]: v }, $(swId).checked ? `ตั้งเป้า${label}ใหม่: ${v} ${unit()}` : null);
    if (r) $(valId).value = r[valKey];
    if (lastSnap) renderPositions(lastSnap.meta);
  });
}
bindAutoClose('ac-all', 'ac-all-v', 'autoCloseAll', 'autoCloseAllProfit', 'ปิดรวบ', () => acctCur || '');
bindAutoClose('ac-loss', 'ac-loss-v', 'autoCloseLoss', 'autoCloseLossValue', 'ตัดขาดทุนรวบ', () => `${acctCur || ''} (ขาดทุนรวม)`);
bindAutoClose('ac-allpts', 'ac-allpts-v', 'autoCloseAllPts', 'autoCloseAllPtsValue', 'ปิดรวบตามจุด', () => 'จุด');
bindAutoClose('ac-pts', 'ac-pts-v', 'autoClosePoints', 'autoClosePointsValue', 'ปิดรายไม้', () => 'จุด');
window.api.onAutoEnter((r) => { toast('🤖 ' + r.msg, r.ok ? 'ok' : 'err'); if (r.ok) setTimeout(() => window.api.refreshNow(), 1500); });
window.api.onAutoClose((r) => { toast('🔒 ' + r.msg, 'ok'); setTimeout(() => window.api.refreshNow(), 1500); });

// ปุ่มฉุกเฉิน: กดครั้งเดียวปิดทุกไม้ทันที
$('btn-close-all').addEventListener('click', () => {
  const list = (lastSnap && lastSnap.meta && lastSnap.meta.positions) || [];
  if (!list.length) { toast('ไม่มีไม้ที่เปิดอยู่', ''); return; }
  closeNow(list.map((p) => Number(p.ticket)));
});

$('t-buy').addEventListener('click', () => tryTrade('buy'));
$('t-sell').addEventListener('click', () => tryTrade('sell'));
$('p-go').addEventListener('click', () => tryPending());

function tryTrade(side) {
  if (!lastSnap || !lastSnap.meta || !Number.isFinite(lastSnap.meta.bid)) { toast('ต้องเชื่อม MT5 ก่อน — ราคา bid/ask ยังไม่มา (ลาก EA ลงชาร์ตแล้วรอ 5 วิ)', 'err'); return; }
  const lot = Number($('t-lot').value);
  const st = stopsFor(side, lastSnap);
  const sl = st ? st.sl : NaN, tp = st ? st.tp : 0;
  if (!Number.isFinite(lot) || lot <= 0) { toast('ล็อตไม่ถูกต้อง', 'err'); return; }
  if (!Number.isFinite(sl) || sl <= 0) { toast('ต้องระบุ SL — บังคับทุกไม้', 'err'); return; }
  const buy = side === 'buy';
  if (buy ? sl >= st.px : sl <= st.px) { toast(`SL ต้องอยู่${buy ? 'ต่ำกว่า' : 'สูงกว่า'}ราคา ${buy ? 'ASK' : 'BID'} สำหรับไม้${buy ? 'ซื้อ' : 'ขาย'} — ล้างช่อง SL เพื่อให้คิดอัตโนมัติ`, 'err'); return; }
  if (tp > 0 && (buy ? tp <= st.px : tp >= st.px)) { toast(`TP ต้องอยู่${buy ? 'สูงกว่า' : 'ต่ำกว่า'}ราคา สำหรับไม้${buy ? 'ซื้อ' : 'ขาย'} — ล้างช่อง TP เพื่อให้คิดอัตโนมัติ`, 'err'); return; }
  openConfirm({ action: side, side, lot, sl, tp: Number.isFinite(tp) ? tp : 0 });
}

window.api.onOrderResult((r) => {
  const isClose = r.cmd && r.cmd.action === 'close';
  const isModify = r.cmd && (r.cmd.action === 'modify' || r.cmd.action === 'pmodify');
  if (isClose && r.status !== 'ok') { closingTickets.delete(Number(r.cmd.ticket)); if (lastSnap) renderPositions(lastSnap.meta); }
  toast(r.status === 'ok'
    ? isModify ? `✅ แก้${r.cmd.action === 'pmodify' ? 'คำสั่งรอ' : ' SL/TP ไม้'} #${r.cmd.ticket} แล้ว`
    : isClose ? `✅ ปิดไม้ #${r.ticket} แล้ว${Number.isFinite(r.price) && r.price ? ' @ ' + r.price.toFixed(2) : ''}`
    : `✅ MT5 รับไม้แล้ว — ticket ${r.ticket}${Number.isFinite(r.price) && r.price ? ' @ ' + r.price.toFixed(2) : ''}`
    : r.status === 'stale'
    ? `⏳ ${r.msg}`
    : `❌ MT5 ปฏิเสธ: ${r.msg} (retcode ${r.retcode})`, r.status === 'ok' ? 'ok' : r.status === 'stale' ? '' : 'err');
  if (r.status === 'ok') setTimeout(() => window.api.refreshNow(), 800);
});

// ---------- เลนเรียลไทม์ (ราคาวิ่งทุก ~1 วิ เหมือน MT5) ----------
window.api.onTick((q) => {
  if (!q || !Number.isFinite(q.bid)) return;
  const d = q.digits || 2;
  const bidEl = $('t-bid'), askEl = $('t-ask'), priceEl = $('price');
  const oldBid = bidEl._v, oldAsk = askEl._v;
  bidEl.textContent = q.bid.toFixed(d);
  askEl.textContent = q.ask.toFixed(d);
  bidEl._v = q.bid; askEl._v = q.ask;
  // ตัวเลขกระพริบตามทิศ (เหมือน MT5) — ใช้ animation รีสตาร์ทได้ ไม่ต้องตั้ง timer ต่อทิค
  const blink = (el, now, before) => {
    if (!Number.isFinite(before) || now === before) return;
    el.classList.remove('flash-up', 'flash-down');
    void el.offsetWidth;
    el.classList.add(now > before ? 'flash-up' : 'flash-down');
  };
  blink(bidEl, q.bid, oldBid);
  blink(askEl, q.ask, oldAsk);
  const sameFeed = !lastSnap || lastSnap.dataSource === 'mt5';
  if (sameFeed) {
    priceEl.textContent = q.bid.toFixed(d);
    blink(priceEl, q.bid, oldBid);
  }
  // เงินจริงวิ่งสด (ทุนสุทธิ/ทุน จาก MT5 ทุกทิค)
  if (Number.isFinite(q.equity)) {
    const line = $('acct-line');
    if (line && line.children.length >= 5) {
      const b2 = line.children[1].querySelector('b'), e2 = line.children[2].querySelector('b'), f2 = line.children[3].querySelector('b');
      const floatPnl = q.equity - q.balance;
      const cls = floatPnl >= 0 ? 'up' : 'down';
      b2.textContent = money(q.balance);
      e2.textContent = money(q.equity);
      e2.className = cls;
      f2.textContent = money(floatPnl, acctCur, true);
      f2.className = cls;
    }
  }
  if (!sameFeed) return;
  const el = $('price-delta');
  if (Number.isFinite(oldBid) && oldBid !== q.bid) { el.textContent = (q.bid > oldBid ? '▲ ' : '▼ ') + fmtD(Math.abs(q.bid - oldBid), d); el.className = 'delta ' + (q.bid > oldBid ? 'up' : 'down'); }
  // แท่งสุดท้ายของชาร์ตขยับสด (bars เก็บรูปแบบ lightweight-charts: open/high/low/close — เดิมใช้ h/l/c ทำให้ได้ NaN)
  if (chartBars.length && candleSeries) {
    const i = chartBars.length - 1, last = chartBars[i];
    chartBars[i] = { ...last, high: Math.max(last.high, q.bid), low: Math.min(last.low, q.bid), close: q.bid };
    try { candleSeries.update(chartBars[i]); } catch { void 0; }
  }
  // ระยะห่างจากจุดรอเข้า + บันไดราคา — วิ่งสด
  if (lastSnap && lastSnap.entryPlan) renderEntryPlan(lastSnap, q.bid);
  if (lastSnap) renderLadder(lastSnap, q.bid);
});

/* ---------- trading (จบ) ---------- */

/* ---------- จุดรอเข้า: การ์ด + ระยะห่างสด ---------- */
// โครงการ์ด rebuild เฉพาะเมื่อโซน/สถานะเปลี่ยน — ทิคสดแค่เติมระยะที่ span (กันกระตุกถ้า tick ถี่)
let epKey = '';
function renderEntryPlan(snap, freshPrice) {
  const p = snap.entryPlan;
  const box = $('entryplan');
  if (!p) return;
  const price = freshPrice != null ? freshPrice : snap.price;
  const chipTxt = { armed: 'HIT!', waiting: 'WAIT', blocked: 'CANCELLED', danger: 'NO ENTRY' };
  const sides = ['buy', 'sell'];
  const planKey = JSON.stringify(sides.map((s) => p[s] ? [p[s].bottom, p[s].top, p[s].center, p[s].levelType, p[s].status, p[s].statusTxt] : null));
  const have = box.querySelector('.ezrow');
  const distTxt = (side) => {
    const z = p[side];
    if (!z || !Number.isFinite(price)) return '—';
    const dist = side === 'buy'
      ? (price > z.top ? price - z.top : (price < z.bottom ? z.bottom - price : 0))
      : (price < z.bottom ? z.bottom - price : (price > z.top ? price - z.top : 0));
    return (z.status === 'armed' || dist === 0) ? 'Price in zone' : `Distance $${fmtD(dist, 2)}`;
  };
  if (planKey !== epKey || !have) {
    epKey = planKey;
    $('ep-atr').textContent = p.atr ? `ความกว้างโซน ±${p.atr} (ATR)` : '';
    const rows = [];
    for (const side of sides) {
      const z = p[side];
      if (!z) continue;
      rows.push(`
      <div class="ezrow ${side}" data-side="${side}">
        <div class="eztop">
          <span class="ezside">${side === 'buy' ? 'BUY ZONE' : 'SELL ZONE'}</span>
          <span class="ezzone">${fmtD(z.bottom, 2)} – ${fmtD(z.top, 2)} · ${esc(z.levelType)}</span>
          <span class="ezprice">${fmtD(z.center, 2)}</span>
        </div>
        <div class="ezstatus">
          <span class="chip ${z.status}">${chipTxt[z.status] || z.status}</span>
          <span class="ezdist">${distTxt(side)}</span>
        </div>
        <div class="muted small">${esc(z.statusTxt)}</div>
      </div>`);
    }
    box.innerHTML = rows.length ? rows.join('') : '<div class="empty">ยังไม่มีจุดรอเข้าชัดเจน — ระบบจะแจ้งเมื่อโซนรับ/ต้านเกิดใกล้ราคา</div>';
    return;
  }
  // รอบนิ่ง: ระยะสดเฉพาะข้อความ (ไม่แตะ DOM โครง)
  for (const side of sides) {
    const row = box.querySelector(`.ezrow[data-side="${side}"]`);
    if (!row) continue;
    const span = row.querySelector('.ezdist');
    const txt = distTxt(side);
    if (span && span.textContent !== txt) span.textContent = txt;
  }
}

/* ---------- commentary ---------- */
function renderCommentary(snap) {
  const c = snap.commentary;
  if (c && Array.isArray(c.lines)) {
    $('commentary').innerHTML = c.lines.map((l) => `<div>${esc(l)}</div>`).join('');
    $('commentary-ts').textContent = `อัปเดต ${fmtTs(c.ts)}`;
  }
}
function renderCommentaryFeed(snap) {
  const feed = (snap.commentaryFeed || []).slice().reverse();
  $('commentary-feed').innerHTML = feed.map((e, i) => (i === 0 ? '' :
    `<div class="cline">${(e.lines || []).map((l) => `<span class="t">${fmtTs(e.ts)}</span>${esc(l)}`).join('<br>')}</div>`)).join('') || '<div class="empty sm">ยังไม่มีประวัติ</div>';
}

/* ---------- ประวัติจุดรอเข้า: กระดานซื้อ/ขายแยกกัน ---------- */
function renderZoneHistory(snap) {
  const box = $('zonehist');
  if (!box) return;
  const s = snap.zoneSummary || { buy: {}, sell: {} };
  const renderSide = (side) => {
    const rows = (snap.zoneHistory || []).filter((t) => t.side === side).slice(-12).reverse();
    const openRows = (snap.zoneOpen || []).filter((t) => t.side === side);
    // ลอยตัวสดของไม้เสมือน: ซื้อปิดที่ BID / ขายปิดที่ ASK (สูตรเดียวกับตอนจบ: ระยะ × 100 oz × ล็อต)
    const m = snap.meta || {};
    const pt = Math.pow(10, -(m.digits || 2));
    const liveOf = (t) => {
      const px = t.side === 'buy' ? Number(m.bid) : Number(m.ask);
      if (!Number.isFinite(px) || !(px > 0)) return null;
      const d = t.side === 'buy' ? px - t.entry : t.entry - px;
      return { pnl: d * 100 * (Number(t.lot) || 0.01), pts: d / pt };
    };
    const floatSum = openRows.reduce((sum, t) => { const l = liveOf(t); return sum + (l ? l.pnl : 0); }, 0);
    const sc = s[side] || {};
    const score = `ชนะ <b>${sc.w || 0}</b> • แพ้ <b>${sc.l || 0}</b> • หมดเวลา ${sc.time || 0} • รวม <b class="${(sc.total || 0) >= 0 ? 'up' : 'down'}">${(sc.total || 0) >= 0 ? '+' : ''}$${fmtD(sc.total || 0, 2)}</b>` +
      (openRows.length ? ` • ลอยตัว <b class="${floatSum >= 0 ? 'up' : 'down'}">${floatSum >= 0 ? '+' : '-'}$${fmtD(Math.abs(floatSum), 2)}</b>` : '');
    const lines = [
      ...openRows.map((t) => `<div class="zh-line"><span class="t">เปิดอยู่</span><span>${t.side === 'buy' ? 'BUY' : 'SELL'} ${fmtD(t.entry, 2)} • SL ${fmtD(t.sl, 2)} • TP ${fmtD(t.tp, 2)}</span>${(() => { const l = liveOf(t); return l ? `<span class="res open ${l.pnl >= 0 ? 'up' : 'down'}">${l.pnl >= 0 ? '+' : '-'}$${fmtD(Math.abs(l.pnl), 2)} (${l.pts >= 0 ? '+' : ''}${Math.round(l.pts)} จุด)</span>` : '<span class="res open">เปิด</span>'; })()}</div>`),
      ...rows.map((t) => `<div class="zh-line"><span class="t">${fmtTs(t.closedAt || t.openedAt)}</span><span>${t.side === 'buy' ? 'BUY' : 'SELL'} ${fmtD(t.entry, 2)} → ${fmtD(t.exit != null ? t.exit : 0, 2)}</span><span class="res ${t.status || ''}">${t.status || '-'} ${t.pnl != null ? (t.pnl >= 0 ? '+' : '') + fmtD(t.pnl, 2) : ''}</span></div>`),
    ];
    return `<div class="zh-side ${side}"><h5>${side === 'buy' ? 'ไม้จำลองซื้อ (BUY)' : 'ไม้จำลองขาย (SELL)'}</h5>
      <div class="zh-score">${score}</div>
      <div class="zh-rows">${lines.length ? lines.join('') : '<div class="empty sm">ยังไม่มี — ราคาแตะจุดรอเข้าฝั่งนี้แล้วจะเริ่มจด</div>'}</div></div>`;
  };
  const rounds = (snap.roundLog || []).slice(-12).reverse().map((r) =>
    `<div class="zh-line"><span class="t">${fmtTs(r.ts)}</span><span class="zact">${esc(r.action)}</span></div><div class="zdetail">${esc(r.detail)}</div>`).join('');
  box.innerHTML = renderSide('sell') + renderSide('buy') +
    `<div class="zh-side zh-rounds"><h5>ประวัติรอบ — ลงไม้ไหน <button class="zh-all" data-open-history title="เปิดหน้าต่างใหม่ ดูประวัติรอบทั้งหมด">ดูทั้งหมด ↗</button></h5><div class="zh-rows roundlines">${rounds || '<div class="empty sm">ยังไม่มีรอบที่เปลี่ยนสถานะ</div>'}</div></div>`;
}

// ปุ่ม "ดูทั้งหมด" อยู่ในกล่องที่วาดใหม่ทุกรอบ → ผูกที่ document ครั้งเดียว
document.addEventListener('click', (e) => { if (e.target.closest('[data-open-history]')) window.api.openHistoryWindow(); });

/* ---------- แผงระยะไกล (เว็บควบคุมเต็ม) — ตั้งค่าได้เฉพาะในแอปบนเครื่อง ---------- */
const openOrCopy = (u) => {
  if (/^https:\/\//.test(u)) { window.open(u, '_blank'); return; }
  try { navigator.clipboard.writeText(u); toast('คัดลอกแล้ว: ' + u, 'ok'); } catch { toast(u); }
};
const linkHtml = (u) => `<a data-wc-link="${esc(u)}">${esc(u)}</a>`;
async function renderWebCtl() {
  const card = $('webctl-card');
  if (!card) return;
  if (window.GS_WEB) { card.hidden = true; return; }
  let w;
  try { w = await window.api.webAccessGet(); } catch { return; }
  $('wc-pw-st').textContent = w.hasPassword ? '✓ ตั้งรหัสแล้ว (เปลี่ยนได้ — ทุกเครื่องจะถูกออกจากระบบ)' : 'ยังไม่ได้ตั้งรหัส — เว็บยังเข้าไม่ได้';
  $('wc-remote').checked = !!w.remote;
  $('wc-addrs').innerHTML = w.remote
    ? (w.addresses.length ? w.addresses.map((a) => `${esc(a.kind)}: ${linkHtml(a.url)}`).join('<br>') : 'ไม่พบเครือข่าย (ต่อ Wi-Fi หรือเปิด Tailscale)')
    : 'ตอนนี้เข้าได้เฉพาะเครื่องนี้';
  const av = w.tunnelAvailable || {};
  for (const o of $('wc-prov').options) o.disabled = !av[o.value];
  const t = w.tunnel || {};
  if (t.provider && document.activeElement !== $('wc-prov')) $('wc-prov').value = t.provider;
  $('wc-tun-st').innerHTML = t.state === 'on' ? `🟢 ${esc(t.provider)}: ${linkHtml(t.url)}`
    : t.state === 'starting' ? `⏳ กำลังเปิด ${esc(t.provider)}…`
    : t.state === 'error' ? `🔴 ${esc(t.msg || 'เปิดไม่ได้')}` : 'ปิดอยู่';
  if (document.activeElement !== $('wc-repo') && w.pagesRepo) $('wc-repo').value = w.pagesRepo;
  $('wc-pages-st').innerHTML = !w.ghAvailable ? 'ต้องติดตั้ง GitHub CLI ก่อน: brew install gh แล้ว gh auth login'
    : w.pagesUrl ? `ลิงก์ถาวร: ${linkHtml(w.pagesUrl)} (อัปเดตที่อยู่ให้เองทุกครั้งที่ tunnel เปลี่ยน — GitHub ใช้เวลา ~1 นาที)` : 'ยังไม่ได้ตั้ง';
  $('wc-sess').textContent = `เครื่องที่ล็อกอินเว็บอยู่: ${w.sessions}`;
}
document.addEventListener('click', (e) => { const a = e.target.closest('[data-wc-link]'); if (a) openOrCopy(a.dataset.wcLink); });
if ($('webctl-card')) {
  const wrap = (fn) => async () => { try { await fn(); } catch (err) { toast('✗ ' + err.message, 'err'); } renderWebCtl(); };
  $('wc-pw-save').addEventListener('click', wrap(async () => {
    const pw = $('wc-pw').value;
    if (pw.length < 8) throw new Error('รหัสต้องยาวอย่างน้อย 8 ตัวอักษร');
    await window.api.webAccessSet({ password: pw });
    $('wc-pw').value = '';
    toast('🔑 บันทึกรหัสเว็บแล้ว', 'ok');
  }));
  $('wc-remote').addEventListener('change', wrap(async () => {
    const on = $('wc-remote').checked;
    if (on && !confirm('เปิดให้เข้าเว็บควบคุมเต็มจากนอกเครื่องนี้?\n\nใครรู้ที่อยู่ + รหัส จะกดซื้อ/ขาย/ปิดไม้จริงได้')) { $('wc-remote').checked = false; return; }
    await window.api.webAccessSet({ remote: on });
  }));
  $('wc-tun-on').addEventListener('click', wrap(async () => {
    if (!confirm(`เปิด tunnel (${$('wc-prov').value}) ให้แผงออกอินเทอร์เน็ต?\n\nใครก็เปิดหน้าล็อกอินได้ — ป้องกันด้วยรหัสเว็บเท่านั้น`)) return;
    await window.api.tunnelStart($('wc-prov').value);
    toast('⏳ กำลังเปิด tunnel…', 'ok');
    setTimeout(renderWebCtl, 4000);
  }));
  $('wc-tun-off').addEventListener('click', wrap(async () => { await window.api.tunnelStop(); toast('ปิด tunnel แล้ว', 'ok'); }));
  $('wc-pages').addEventListener('click', wrap(async () => {
    const repo = $('wc-repo').value.trim();
    if (!confirm(`ตั้งลิงก์ถาวรที่ GitHub repo "${repo}"?\n\nถ้ายังไม่มี จะสร้าง repo แบบ public (GitHub Pages ฟรีต้อง public)\nไฟล์ในนั้นมีแค่หน้าเปิดแผง + ที่อยู่ tunnel ล่าสุด ไม่มีรหัสหรือข้อมูลบัญชี`)) return;
    toast('⏳ กำลังตั้ง GitHub Pages…', 'ok');
    const r = await window.api.pagesSetup(repo);
    toast('🔗 ลิงก์ถาวร: ' + r.url + ' (GitHub เปิดหน้าใช้เวลา 1–2 นาที)', 'ok');
  }));
  $('wc-logout-all').addEventListener('click', wrap(async () => { await window.api.webAccessLogoutAll(); toast('ออกจากระบบเว็บทุกเครื่องแล้ว', 'ok'); }));
  renderWebCtl();
  setInterval(renderWebCtl, 5000);
}

/* ---------- snapshot flow ---------- */
function renderDataAlert(snap) {
  const el = $('data-alert');
  if (snap.price == null) {
    const mt5 = snap.connectorStatuses && snap.connectorStatuses.mt5;
    const noBridge = mt5 && (mt5.state === 'no-bridge' || mt5.state === 'searching' || mt5.state === 'stale');
    el.style.display = 'block';
    el.innerHTML = noBridge
      ? `<b>รอข้อมูลจาก MT5</b> — ยังไม่พบไฟล์ bridge จาก MT5 (EA ยังไม่รันอยู่บนชาร์ตทอง)<br>
         ลาก <b>JsonBridgeEA</b> บนชาร์ตทองใน MetaTrader 5 แล้วรอ 5 วิ หรือสลับแหล่งข้อมูลเป็น <b>อัตโนมัติ (MT5 → ฟรี)</b> ด้านบนขวาเพื่อใช้ราคาฟรี COMEX ชั่วคราว`
      : `<b>${esc(snap.error || 'ไม่มีข้อมูล')}</b> — รอบถัดไปจะลองใหม่อัตโนมัติ (อาจเป็นช่วงตลาดปิดหรือเชื่อมช้า)`;
  } else {
    const mt5 = snap.connectorStatuses && snap.connectorStatuses.mt5;
    const broken = mt5 && mt5.state === 'parse-error';
    el.style.display = broken ? 'block' : 'none';
    if (broken) el.innerHTML = `<b>${esc(mt5.msg)}</b>`;
  }
}

// ส่วนที่ซ่อนอยู่: วาดเฉพาะตอนมองเห็น (แท็บเปิด / กล่องพับถูกกางออก)
function renderDeferred(snap) {
  renderHistory(snap);
  if (isOpen('commentary-more')) renderCommentaryFeed(snap);
  if (tabActive('logs')) renderLogs(snap);
  if (tabActive('mt5')) renderMT5(snap);
}
$('commentary-more').addEventListener('toggle', () => { if (lastSnap) renderDeferred(lastSnap); });

/* ---------- การ์ดประวัติการเทรด: แท็บไม้จริง / ไม้จำลอง (วาดเฉพาะแท็บที่เปิด) ---------- */
let histTab = store.get('gsHist', 'real');
function showHist(name) {
  histTab = name === 'sim' ? 'sim' : 'real';
  store.set('gsHist', histTab);
  document.querySelectorAll('#hist-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.h === histTab));
  $('hist-real').hidden = histTab !== 'real';
  $('hist-sim').hidden = histTab !== 'sim';
  if (lastSnap) renderHistory(lastSnap);
}
document.querySelectorAll('#hist-tabs button').forEach((b) => b.addEventListener('click', () => showHist(b.dataset.h)));
function renderHistory(snap) {
  const real = snap.meta && Array.isArray(snap.meta.history) ? snap.meta.history.length : 0;
  const sim = (snap.zoneHistory || []).length + (snap.zoneOpen || []).length;
  $('hist-real-n').textContent = real ? String(real) : '';
  $('hist-sim-n').textContent = sim ? String(sim) : '';
  if (histTab === 'real') renderRealHistory(snap.meta); else renderZoneHistory(snap);
}
showHist(histTab);

/* ---------- แถบตัวเลขหลัก (KPI) — สรุปสิ่งที่ต้องรู้ในแวบเดียว ---------- */
function setKpi(id, text, cls = '') { const el = $(id); el.textContent = text; el.className = cls; }
function renderKpis(snap) {
  const a = snap.analysis;
  const bias = a && a.bias;
  setKpi('kpi-bias', bias === 'bull' ? 'ขาขึ้น ▲' : bias === 'bear' ? 'ขาลง ▼' : a ? 'ออกข้าง' : '—', bias === 'bull' ? 'up' : bias === 'bear' ? 'down' : '');
  const c = snap.council;
  if (!c) setKpi('kpi-council', 'ปิดอยู่');
  else if (c.side === 'none') setKpi('kpi-council', `ไม่มีมติ • ${Math.max(0, c.confidence)}%`);
  else setKpi('kpi-council', `${c.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${c.confidence}% • ${c.agree} เสียง`, c.side === 'buy' ? 'up' : 'down');
  const g = snap.guard || {};
  const used = (g.dailyCount || 0) + (g.manualCount || 0);
  setKpi('kpi-quota', g.maxPerDay ? `${used} / ${g.maxPerDay} ไม้` : '—', g.maxPerDay && used >= g.maxPerDay ? 'down' : '');
  const acct = (snap.meta && snap.meta.account) || snap.account;
  if (acct && Number.isFinite(acct.equity)) {
    const fl = acct.equity - (Number(acct.balance) || acct.equity);
    const usd = acct.currency && acct.currency !== 'USD' && Number.isFinite(acct.equityUSD) ? ` ≈ $${fmtD(acct.equityUSD, 0)}` : '';
    setKpi('kpi-equity', `${money(acct.equity, acct.currency)}${usd}`, fl > 0 ? 'up' : fl < 0 ? 'down' : 'gold');
  } else {
    setKpi('kpi-equity', snap.risk && snap.risk.equity ? `$${fmtD(Number(snap.risk.equity), 0)} (ตั้งค่า)` : '—');
  }
}

function applySnapshot(snap, first) {
  if (!snap) return;
  try {
    lastSnap = snap;
    if (snap.candles && Object.keys(snap.candles).length) Object.assign(candStore, snap.candles);
    // แท่งที่กำลังก่อตัว: แทนแท่งสุดท้าย (เวลาเดียวกัน) หรือต่อท้าย (แท่งใหม่)
    for (const [tf, bar] of Object.entries(snap.candleTail || {})) {
      const arr = candStore[tf];
      if (!arr || !arr.length || !bar) continue;
      const last = arr[arr.length - 1];
      if (last.t === bar.t) arr[arr.length - 1] = bar; else if (bar.t > last.t) arr.push(bar);
    }
    renderTicker(snap);
    renderStandby(snap.standby, snap.session);
    renderCommentary(snap);
    renderDataAlert(snap);
    renderSession(snap);
    renderEntryPlan(snap);
    renderTradePanel(snap);
    autoEnterTick(snap);
    renderPositions(snap.meta);
    renderPendings(snap);
    badgeFor(snap.connectorStatuses, (snap.risk && snap.risk.source) || $('source-sel').value);
    renderMarket(snap.analysis);
    renderGuards(snap.guard, snap.risk || {});
    renderSignals(snap);
    renderCouncil(snap.council, snap.error);
    renderKpis(snap);
    renderLadder(snap);
    renderDeferred(snap);
    updateChart(candStore);
  } catch (err) {
    // บันทึกผิดพลาดหน้าจอจริงลง log — ไดรกรรมห้ามเงียบ
    console.error('applySnapshot ล้ม:', err);
    window.api && window.api.reportError && window.api.reportError('applySnapshot: ' + (err && err.message), err && err.stack);
  }
}

async function loadSettingsToForm() {
  const s = await window.api.getSettings();
  $('s-equity').value = s.equity;
  $('s-riskpct').value = s.riskPct;
  $('s-minrr').value = s.minRR;
  $('s-minconf').value = s.minConfidence;
  $('s-maxday').value = s.maxSignalsPerDay;
  $('s-cooldown').value = s.cooldownMin;
  $('s-poll').value = s.pollSec;
  $('s-newsstop').checked = !!s.newsStop;
  $('s-notify').checked = s.notifySignal !== false;
  $('s-autostart').checked = !!s.autoStart;
  $('s-leastrisk').checked = s.leastRisk !== false;
  $('s-webpush-url').value = s.remoteDashboardUrl || '';
  $('s-webpush-token').value = s.remoteDashboardToken || '';
  $('t-auto').checked = !!s.autoEnter;
  $('t-real').checked = !!s.realOrdersEnabled;
  $('ac-all').checked = !!s.autoCloseAll;
  $('ac-all-v').value = s.autoCloseAllProfit;
  $('ac-loss').checked = !!s.autoCloseLoss;
  $('ac-loss-v').value = s.autoCloseLossValue;
  $('ac-allpts').checked = !!s.autoCloseAllPts;
  $('ac-allpts-v').value = s.autoCloseAllPtsValue;
  $('ac-pts').checked = !!s.autoClosePoints;
  $('ac-pts-v').value = s.autoClosePointsValue;
  $('s-councilon').checked = s.councilEnabled !== false;
  $('s-councilstrict').checked = s.councilStrict !== false;
  $('s-quorum').value = s.councilQuorum;
  $('s-councilmin').value = s.councilMin;
  $('source-sel').value = s.source;
  $('bridge-path').textContent = s.mt5BridgePath ? 'ไฟล์: ' + s.mt5BridgePath : '';
  updateCalcExample(s);
  appSettings = s;
  // ช่อง "ดูผ่านเว็บเบราว์เซอร์" — คลิกแล้วเปิดใน browser จริง
  try {
    const wu = await window.api.getWebUrl();
    const a = $('web-url');
    if (wu) { a.textContent = wu; a.onclick = (e) => { e.preventDefault(); openOrCopy(wu); }; }
    else a.textContent = 'เปิดไม่ได้ (ดู log แท็บ บันทึก)';
  } catch { void 0; }
  return s;
}

function updateCalcExample(s) {
  $('calc-example').innerHTML = `
    ทุน $${r2(s.equity, 0)} • เสี่ยง ${r2(s.riskPct, 2)}% ต่อไม้ → <b>สัญญาณ 1 ไม้ขาดทุนไม่เกิน $${r2((s.equity * s.riskPct) / 100, 2)}</b><br>
    ตัวอย่าง: SL ห่าง $8.00 → ล็อตแนะนำ = ${((s.equity * s.riskPct) / 100 / (8 * 100)).toFixed(2)} ล็อต (XAUUSD 100 oz/ล็อต)`;
}

$('form-risk').addEventListener('submit', async (e) => {
  e.preventDefault();
  const partial = {
    equity: Number($('s-equity').value),
    riskPct: Number($('s-riskpct').value),
    minRR: Number($('s-minrr').value),
    minConfidence: Number($('s-minconf').value),
    maxSignalsPerDay: Number($('s-maxday').value),
    cooldownMin: Number($('s-cooldown').value),
    pollSec: Number($('s-poll').value),
    newsStop: $('s-newsstop').checked,
    notifySignal: $('s-notify').checked,
    autoStart: $('s-autostart').checked,
    leastRisk: $('s-leastrisk').checked,
    autoEnter: $('t-auto').checked,
    remoteDashboardUrl: $('s-webpush-url').value.trim(),
    remoteDashboardToken: $('s-webpush-token').value.trim(),
    councilEnabled: $('s-councilon').checked,
    councilStrict: $('s-councilstrict').checked,
    councilQuorum: Number($('s-quorum').value),
    councilMin: Number($('s-councilmin').value),
    source: $('source-sel').value,
  };
  const btn = e.submitter || $('form-risk').querySelector('button[type=submit]');
  if (btn) btn.disabled = true;
  try {
    const s = await window.api.saveSettings(partial);
    updateCalcExample(s);
    $('source-sel').value = s.source;
    toast('💾 บันทึกการตั้งค่าแล้ว — ค่าที่เกินเพดานถูกปรับให้อยู่ในกรอบปลอดภัยอัตโนมัติ', 'ok');
    loadSettingsToForm(); // แสดงค่าที่ระบบบีบจริงกลับในฟอร์ม
  } catch (err) {
    toast('บันทึกไม่สำเร็จ: ' + err.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
});

$('source-sel').addEventListener('change', async (e) => {
  await window.api.saveSettings({ source: e.target.value });
  window.api.refreshNow();
});

$('btn-refresh').addEventListener('click', () => { $('conn-badge').textContent = 'กำลังอัปเดต...'; window.api.refreshNow(); });

/* ---------- plugins tab ---------- */
async function renderPlugins() {
  let list;
  try { list = await window.api.listPlugins(); } catch { list = []; }
  $('plugins-list').innerHTML = list.length ? list.map((p, i) => `
    <div class="plugin">
      <span class="ptag">${esc(p.source)}</span>
      <div><div class="pname">${esc(p.name)}</div><div class="pdesc">${esc(p.description)}</div></div>
      <span class="spacer"></span>
      <span class="ptag">${esc(String(p.file || '').split(/[\\/]/).pop())}</span>
      <label class="switch"><input type="checkbox" data-plugin-id="${esc(p.id)}" ${p.enabledByDefault ? 'checked' : ''}><span></span></label>
    </div>`).join('') : '<div class="empty">ยังไม่มี plugin</div>';
  $('plugins-list').querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', async () => { await window.api.togglePlugin(cb.dataset.pluginId, cb.checked); await renderPlugins(); });
  });
}
// โหลดใหม่ = อ่านไฟล์ plugin จากดิสก์อีกรอบ (เดิมแค่ดึงรายการเก่า ไฟล์ที่เพิ่งสร้างจึงไม่โผล่)
$('btn-reload-plugins').addEventListener('click', async () => {
  try { await window.api.reloadPlugins(); toast('↻ โหลด plugin ใหม่จากโฟลเดอร์แล้ว', 'ok'); } catch (err) { toast('โหลด plugin ไม่สำเร็จ: ' + err.message, 'err'); }
  await renderPlugins();
});
$('btn-open-user-plugins').addEventListener('click', () => window.api.openPluginsDir('user'));
$('btn-open-builtin-plugins').addEventListener('click', () => window.api.openPluginsDir('builtin'));

/* ---------- mt5 tab ---------- */
$('btn-pick-bridge').addEventListener('click', async () => {
  const p = await window.api.pickBridgeFile();
  if (p) { $('bridge-path').textContent = 'ไฟล์: ' + p; window.api.refreshNow(); }
});

$('btn-install-ea').addEventListener('click', async () => {
  $('ea-install-result').textContent = '⏳ กำลังติดตั้งและคอมไพล์ (ใช้เวลาไม่กี่วินาที)...';
  const r = await window.api.installEa();
  $('ea-install-result').textContent = r.ok ? '✔ ' + r.msg : '✗ ' + r.msg;
  $('ea-install-result').className = 'small ' + (r.ok ? 'up' : 'down');
  await checkEa();
});

// ตรวจสถานะติดตั้ง EA 3 ชั้น: วางไฟล์ → คอมไพล์ → EA ทำงาน
async function checkEa() {
  const s = await window.api.eaStatus();
  const steps = [
    { ok: s.mq5, title: '1. ไฟล์ JsonBridgeEA.mq5 วางใน Experts/GoldSignal แล้ว', hint: s.mq5 ? 'เรียบร้อย' : 'กดปุ่ม "ติดตั้ง EA ให้ฉันเอง" ก่อน' },
    { ok: s.ex5, title: '2. คอมไพล์เป็น .ex5 แล้ว', hint: s.ex5 ? 'เรียบร้อย (แอปคือผู้คอมไพล์ให้อัตโนมัติ)' : 'กดปุ่ม "ติดตั้ง EA ให้ฉันเอง" — แอปจะคอมไพล์ให้ หรือกด F7 ใน MetaEditor เอง' },
    { ok: s.bridge, title: '3. EA ทำงานอยู่บนชาร์ต (มีไฟล์ bridge สด)', hint: s.bridge ? 'พาธ: ' + s.bridgePath : 'ลาก EA ใน Navigator (Refresh ก่อนถ้ายังไม่เห็น) ไปบนชาร์ตทอง → OK → รอ 5 วิ' },
  ];
  $('ea-checklist').innerHTML = steps.map((x) => `<div class="step ${x.ok ? 'ok' : 'todo'}">${x.ok ? '✔' : '○'} <span>${esc(x.title)}<small>${esc(x.hint)}</small></span></div>`).join('');
  return s;
}
$('btn-check-ea').addEventListener('click', checkEa);
// เช็คให้อัตโนมัติเมื่อเปิดแท็บ MT5 ทุกครั้ง
document.querySelector('#tabs button[data-tab="mt5"]').addEventListener('click', () => setTimeout(checkEa, 300));

function renderMT5(snap) {
  const st = snap.connectorStatuses && snap.connectorStatuses.mt5;
  if (!st) return;
  const cls = st.state === 'ok' ? 'ok' : 'warn';
  const old = st.state === 'ok' && snap.meta && !snap.meta.spec
    ? '<div class="data-alert" style="margin-top:12px"><b>EA ใน MT5 เป็นรุ่นเก่า</b> — ดูราคา/สัญญาณได้ แต่ส่งคำสั่งซื้อขายไม่ได้ กด "ติดตั้ง EA ให้ฉันเอง" แล้วลาก JsonBridgeEA ลงชาร์ตทองใหม่ 1 ครั้ง (v1.6)</div>'
    : '';
  $('mt5-status').innerHTML = `<span class="badge ${cls}">${esc(st.msg)}</span>${old}`;
}

/* ---------- council ---------- */
/* ---------- ระบบรอเข้า: แถบสถานะ + ช่วงเวลาแนะนำ ---------- */
function renderStandby(st, session) {
  const chip = $('sb-chip');
  const st2 = st || { mode: 'quiet', notes: [] };
  const map = { ready: ['🎯 SIGNAL READY', 'ready'], waiting: ['⏳ WAITING FOR ENTRY', 'waiting'], quiet: ['SCANNING…', 'quiet'] };
  const [txt, cls] = map[st2.mode] || map.quiet;
  chip.textContent = txt;
  chip.className = 'sb-chip ' + cls;
  $('sb-notes').textContent = (st2.notes || []).join('  •  ') || '';
  const s = session;
  if (s) {
    const qTxt = { best: 'ดีที่สุด', good: 'ดี', ok: 'พอใช้', avoid: 'ไม่แนะนำ', closed: 'ตลาดปิด' };
    $('sb-session').innerHTML = `🕐 ${esc(s.label)} <span class="badge ${s.quality === 'best' ? 'ok' : s.quality === 'good' || s.quality === 'ok' ? 'warn' : 'err'}">${qTxt[s.quality] || ''}</span>`;
    $('sb-session').title = s.advice || '';
  }
}

function renderSession(snap) {
  const segs = (snap.sessionWindows ? snap.sessionWindows.map((w) => ({ qs: w.utcStart, qe: w.utcEnd, label: w.th, q: w.quality, advice: w.advice })) : null);
  const list = segs || [
    { qs: 21, qe: 23, label: 'เอเชียค่ำ', q: 'avoid' },
    { qs: 23, qe: 7, label: 'เอเชีย', q: 'avoid' },
    { qs: 7, qe: 12, label: 'ลอนดอน', q: 'good' },
    { qs: 12, qe: 17, label: 'ลอนดอน+NY', q: 'best' },
    { qs: 17, qe: 21, label: 'NY บ่าย', q: 'ok' },
  ];
  const tl = $('session-timeline');
  tl.innerHTML = list.map((s) => {
    const span = s.qs > s.qe ? 24 - s.qs + s.qe : s.qe - s.qs;
    return `<div class="seg q-${s.q}" style="width:${(span / 24) * 100}%" title="${esc(s.label)}: ${esc(s.advice)}">${esc(s.label)}</div>`;
  }).join('') + `<div class="nowmark" id="tl-now" style="left:0%"></div>`;
  updateNowMark();
  const sess = snap.session;
  if (sess) {
    const h = sess.thaiTime.h, m = sess.thaiTime.m;
    const mins = snap.sessionToBest;
    $('session-now').innerHTML = `ตอนนี้ ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} (ไทย) — <b>${esc(sess.label)}</b>: ${esc(sess.advice)}<br><span class="muted small">${esc(sess.riskNote)}${mins != null && sess.quality !== 'best' ? ` • ถึงช่วงดีสุดอีก ${Math.floor(mins / 60)} ชม. ${mins % 60} นาที` : sess.quality === 'best' ? ' • คุณอยู่ช่วงดีสุดของวันแล้ว!' : ''}</span>`;
  }
}

function updateNowMark() {
  const mark = $('tl-now');
  if (!mark) return;
  const d = new Date();
  const thai = (d.getUTCHours() + 7) % 24 + d.getUTCMinutes() / 60;
  mark.style.left = `${(thai / 24) * 100}%`;
}
setInterval(updateNowMark, 20_000);

/* ---------- council ---------- */
function renderCouncil(c, error) {
  if (!c) {
    $('council-verdict').className = 'badge';
    $('council-verdict').textContent = error ? 'ไม่มีข้อมูลรอบนี้' : 'ปิดอยู่';
    $('council-agents').innerHTML = error ? '<div class="empty">รอบนี้ไม่ได้ข้อมูลราคา — รอรอบถัดไป</div>' : '<div class="empty">ตั้งค่าเปิดในแท็บตั้งค่าความเสี่ยง</div>';
    return;
  }
  const v = $('council-verdict');
  if (c.side === 'none') { v.className = 'badge'; v.textContent = `ไม่มีมติ (${Math.max(0, c.confidence)}%)`; }
  else { v.className = 'badge ' + (c.side === 'buy' ? 'ok' : 'err'); v.textContent = `${c.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${c.confidence}% • เห็นพ้อง ${c.agree}/${c.quorumNeed}+`; }
  const rows = (c.votes || []).map((a) => {
    const cls = a.side === 'buy' ? 'vbuy' : a.side === 'sell' ? 'vsell' : 'vnone';
    const txt = a.side === 'buy' ? `ซื้อ ${a.conf}%` : a.side === 'sell' ? `ขาย ${a.conf}%` : '—';
    const sk = a.skill || {};
    const skTxt = sk.hit != null ? `${a.name.split('เอเจนต์')[1] || ''}: ผลงาน ${sk.grade} ${Math.round(sk.hit * 100)}% (${sk.n} ไม้)` : (sk.grade === 'ใหม่' ? 'เพิ่งรับหน้าที่ — ยังไม่ผ่านการตรวจผลงาน' : `${sk.grade} (${sk.n})`);
    // ตัวปรับน้ำหนักจากฝ่ายบริบท (สภาพตลาด/ช่วงเวลา) — โชว์เมื่อไม่ใช่ ×1
    const adj = Number.isFinite(a.weightAdj) && Math.abs(a.weightAdj - 1) > 0.01 ? ` • น้ำหนักตามสนาม ×${a.weightAdj.toFixed(2)}` : '';
    return `<div class="cagent" title="${esc(a.reason)}${a.skillNote ? ' | ' + esc(a.skillNote) : ''}"><span class="cname">${esc(a.name)}</span><span class="${cls}">${txt}</span><span class="creason">${esc(a.reason)}</span></div><div class="cagent-skill">${esc(skTxt)}${esc(adj)}${a.skillNote ? ' • ' + esc(a.skillNote) : ''}</div>`;
  }).join('');
  $('council-agents').innerHTML = rows +
    (c.boosts && c.boosts.length ? `<div class="council-note boost">➕ ${esc(c.boosts.map(String).join(' | '))}</div>` : '') +
    (c.caps && c.caps.length ? `<div class="council-note">⚠ ${esc(c.caps.map(String).join(' | '))}</div>` : '');
}

/* ---------- boot ---------- */
(function watchErrors() {
  window.addEventListener('error', (e) => window.api.reportError(e.message, e.error && e.error.stack));
  window.addEventListener('unhandledrejection', (e) => window.api.reportError('promise: ' + (e.reason && (e.reason.message || e.reason)), e.reason && e.reason.stack));
})();

(async function boot() {
  showTab(store.get('gsTab', 'home'));
  initChart();
  if (chartM) wireZoom();
  await loadSettingsToForm();
  await renderPlugins();
  const initial = await window.api.getState();
  if (initial) applySnapshot(initial, true);
  window.api.onSnapshot((snap) => applySnapshot(snap, false));
  window.api.refreshNow();
})();
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
let lastBarLive = null;   // OHLC แท่งสุดท้าย (paintTick ขยับให้ด้วย update() — ไม่แตะสเกล)
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
  wirePriceScaleLock();
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
  // ข้อมูลแท่งเท่าเดิม (แม้ราคาปิดแท่งสุดท้ายวิ่ง) → ไม่ยิง setData รัวทุกทิค (setData = สเกลราคาถูกรีฟิต = ซูมคุณหาย)
  // ทางชาร์ตหายใจเอง: paintTick อัปเดตแท่งสุดท้ายด้วย update() ที่คงสเกลเดิม
  const lastC = candles[candles.length - 1];
  const key = `${currentTf}|${candles.length}|${candles[0].t}|${lastC.t}`;
  if (!fit && key === chartKey) { drawZones(lastSnap); return; }
  chartKey = key;
  $('chart-sub').textContent = `${currentTf} • ${candles.length} แท่ง`;
  const bars = candles.map((c) => ({ time: c.t, open: c.o, high: c.h, low: c.l, close: c.c }));
  // เก็บช่วงเวลาที่ผู้ใช้กำลังดู → อัปเดตข้อมูลแล้ววางกลับตรงเดิม (ซูมไม่หลุดระหว่างสตรีม)
  const before = chartBars.length ? chartM.timeScale().getVisibleRange() : null;
  const lastOldT = chartBars.length ? chartBars[chartBars.length - 1].time : null;
  const atRight = before && lastOldT != null && Number(before.to) >= Number(lastOldT) - 1.5; // ดูอยู่ขอบขวา = อยากตามราคา
  chartBars = bars;
  lastBarLive = { t: lastC.t, o: lastC.o, h: lastC.h, l: lastC.l, c: lastC.c };
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
  // memo บันไดราคา: ระดับ/ราคา/สถานะเดิมทั้งหมด = ไม่พิมพ์ DOM ซ้ำ (ราคาวิ่งทุกวิ — ข้ามเขียนบ่อย ๆ ทุกทิค)
  const ladderKey = rows.map((r) => (r.now ? 'now' : `${r.p}${r.chip || ''}${fmtD(dist(r), 2)}`)).join('•');
  renderOnce('ladder', ladderKey, box, rows.map((r) => {
    if (r.now) return `<div class="lad-row now"><span class="lad-name">ราคาตอนนี้</span><b class="lad-px">${fmtD(price, 2)}</b></div>`;
    const d = dist(r);
    return `<div class="lad-row ${r.cls}"><i class="lad-bar"></i><span class="lad-name">${r.name}${r.chip ? ` <em class="lad-chip ${r.chipCls}">${r.chip}</em>` : ''}</span>` +
      `<b class="lad-px">${r.txt}</b><span class="lad-d${d === 0 ? ' in' : ''}">${d === 0 ? 'ราคาอยู่ในโซน' : (d > 0 ? '+' : '−') + fmtD(Math.abs(d), 2)}</span></div>`;
  }).join(''));
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
// ลากแกนราคา (แถบขวาของชาร์ต) = ผู้ใช้ซูมราคาเอง → ล็อก autoScale ปิดถาวร (setData ใหม่จะไม่รีฟิตราคา = ซูมคงอยู่)
// ปลดล็อก = ปุ่ม "ฟิต" (z-fit): กลับ autoScale + จัดกรอบใหม่
let priceScaleLocked = false;
function wirePriceScaleLock() {
  const el = $('chart');
  const strip = (e) => {
    const r = el.getBoundingClientRect();
    return r.width - (e.clientX - r.left) <= 76; // ช่วงแถบแกนราคาขวา (รวมป้ายราคา)
  };
  el.addEventListener('pointerdown', (e) => {
    if (priceScaleLocked || !candleSeries || !strip(e)) return;
    let touched = 0;
    const onMove = (ev) => { if (++touched >= 2) { finish(true); } };
    const finish = (lock) => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', finish);
      el.removeEventListener('pointercancel', finish);
      if (lock && touched >= 2) { priceScaleLocked = true; candleSeries.priceScale().applyOptions({ autoScale: false }); }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
  });
  // ปุ่ม "ฟิต" = ปลดล็อกกลับ autoScale + จัดเต็มกรอบ
  $('z-fit').addEventListener('click', () => {
    if (priceScaleLocked && candleSeries) { priceScaleLocked = false; candleSeries.priceScale().applyOptions({ autoScale: true }); }
    fitWithGap();
  });
}
function wireZoom() {
  const curSpacing = () => {
    const w = chartM.timeScale().width();
    return chartBars.length ? w / Math.max(1, chartBars.length) : 8;
  };
  $('z-in').addEventListener('click', () => chartM.timeScale().applyOptions({ barSpacing: Math.min(90, curSpacing() * 1.35) }));
  $('z-out').addEventListener('click', () => chartM.timeScale().applyOptions({ barSpacing: Math.max(1.5, curSpacing() * 0.72) }));
  $('z-fit').addEventListener('click', fitWithGap);
  // ขยายชาร์ตเต็มหน้าต่าง (กว้าง+สูงเต็มโปรแกรม) • Esc / กดซ้ำ = ย่อกลับ — autoSize ปรับขนาดชาร์ตเอง
  // ย้ายการ์ดชาร์ตไปไว้ใต้ <body> ตอนขยาย (กล่องแม่มี backdrop-filter ทำให้ position:fixed ไม่เต็มจอ)
  const chartHome = document.createComment('chart-card-home');
  $('chart-card').before(chartHome);
  const setChartMax = (on) => {
    const card = $('chart-card');
    if (on) document.body.appendChild(card); else chartHome.after(card);
    document.body.classList.toggle('chart-max', on);
    $('z-max').classList.toggle('on', on);
    $('z-max').textContent = on ? '✕ ย่อ' : '⛶ ขยาย';
    setTimeout(fitWithGap, 60);
  };
  $('z-max').addEventListener('click', () => setChartMax(!document.body.classList.contains('chart-max')));
  // Esc ขณะหน้ายืนยันเปิด = ปิดแค่หน้ายืนยัน (ไม่ย่อชาร์ต) — ผูกแบบ capture ให้เช็กก่อนตัวปิด modal (ผูกไว้ก่อน wireZoom) จะซ่อน #modal
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.body.classList.contains('chart-max') && !($('pend-card') && $('pend-card').classList.contains('max')) && !$('modal').classList.contains('show')) setChartMax(false); }, true);
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
  const autoMax = (Number(snap.risk && snap.risk.autoRiskMaxPct) || 2);
  const effPct = Math.min(riskPct, autoMax);
  const budget = (eq * effPct) / 100;
  const minRisk = Number.isFinite(atr) ? atr * 0.01 * oz : null; // 0.01 ล็อต กับ SL ระยะ 1 ATR(M15)
  const small = minRisk != null && budget > 0 && budget < minRisk
    ? `<div class="nosig-cap">⚠ ทุนที่ใช้คิด $${fmtD(eq, 0)} × ${fmtD(effPct, 2)}% = เสี่ยงได้ $${fmtD(budget, 2)}/ไม้ (ตั้ง "เพดานอัตโนมัติ ${fmtD(autoMax, 1)}%") แต่ 0.01 ล็อตกับ SL แค่ 1 ATR ($${fmtD(atr, 2)}) ก็เสี่ยง $${fmtD(minRisk, 2)} แล้ว — เพดานอัตโนมัติที่จะออกไม้ได้ต้อง ≥ $${fmtD(atr, 2)} (ตั้งได้ 2–100%: 100 = โค้งไม่ตัด — ที่แท็บความเสี่ยง) • ทางออก: (1) เพิ่มทุนจริง (2) กดเองด้วยเพดานปุ่มกด (3) ยอมข้ามรอบ</div>`
    : '';
  let last = null;
  try { last = JSON.parse(localStorage.getItem('gs.lastSignal') || 'null'); } catch { last = null; }
  const lastHtml = last && Number.isFinite(Number(last.entry))
    ? `<div class="last-signal">
         <div class="ls-head">⏱ โอกาสล่าสุด <span class="muted small">${esc(last.pluginName || '')}</span></div>
         <div class="sig-grid">
           <div class="sig-cell"><small>เข้าตอน</small><b>${fmtTs(last.ts)}</b></div>
           <div class="sig-cell"><small>ฝั่ง</small><b class="${last.side === 'buy' ? 'up' : 'down'}">${last.side === 'buy' ? 'ซื้อ BUY' : 'ขาย SELL'}</b></div>
           <div class="sig-cell"><small>ราคาเข้า</small><b>${r2(last.entry)}</b></div>
           <div class="sig-cell"><small>Stop Loss</small><b class="down">${r2(last.sl)}</b></div>
           <div class="sig-cell"><small>Take Profit</small><b class="up">${r2(last.tp)}</b></div>
           <div class="sig-cell"><small>ความมั่นใจ</small><b>${Math.min(100, Math.max(0, Number(last.confidence) | 0))}%</b></div>
         </div>
       </div>`
    : '';
  // จังหวะไม้จำลองล่าสุด + มติสภา ณ ไม้เปิด (แยกให้ดู: โซนแตะเมื่อไร สภาตัดสินกี่ %)
  const vSim = [
    ...(snap.zoneOpen || []),
    ...(snap.zoneHistory || []),
  ].filter((t) => t && t.councilAtOpen).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))[0];
  const simHtml = vSim
    ? `<div class="last-signal sim">
         <div class="ls-head">🧪 ไม้จำลองล่าสุด — มติสภา ณ ไม้เปิด <span class="muted small">${esc(vSim.levelType || '')} ${fmtD(vSim.zone, 2)}</span></div>
         <div class="sig-grid">
           <div class="sig-cell"><small>เปิดตอน</small><b>${fmtTs(vSim.openedAt)}</b></div>
           <div class="sig-cell"><small>ฝั่ง</small><b class="${vSim.side === 'buy' ? 'up' : 'down'}">${vSim.side === 'buy' ? 'ซื้อ BUY' : 'ขาย SELL'}</b></div>
           <div class="sig-cell"><small>ราคาเข้า</small><b>${fmtD(vSim.entry, 2)}</b></div>
           <div class="sig-cell"><small>SL / TP</small><b>${fmtD(vSim.sl, 2)} / ${fmtD(vSim.tp, 2)}</b></div>
           <div class="sig-cell"><small>สภา ณ เปิดไม้</small><b class="${vSim.councilAtOpen.side === 'none' ? '' : (vSim.councilAtOpen.side === 'buy' ? 'up' : 'down')}">${vSim.councilAtOpen.side === 'none' ? `ไม่มีมติ ${vSim.councilAtOpen.confidence}%` : `${vSim.councilAtOpen.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${vSim.councilAtOpen.confidence}%`}</b></div>
           <div class="sig-cell"><small>ผ่านไม้จริง</small><b>${(vSim.councilAtOpen.side !== 'none' && vSim.councilAtOpen.side === vSim.side) ? 'ผ่านสภา ✓' : vSim.councilAtOpen.side === 'none' ? 'ไม่ผ่าน (ไม่มีมติ)' : 'ไม่ผ่าน (สภาสวน)'}</b></div>
         </div>
       </div>`
    : '';
  return `${simHtml}${lastHtml}<div class="empty nosig"><b>ยังไม่มีสัญญาณที่เข้าได้</b><span>${esc(why)}</span></div>${small}`;
}

function renderSignals(snap) {
  const box = $('signals');
  const list = (snap.signals || []).slice(0, 8);
  $('signals-count').textContent = list.length ? `${list.length} โอกาส` : '';
  // จำโอกาสล่าสุดไว้โชว์ในหน้ายังไม่มีสัญญาณ ("ของล่าสุด")
  if (list.length) {
    const s = list[0], m = s.metrics || {};
    try { localStorage.setItem('gs.lastSignal', JSON.stringify({ side: s.side, entry: s.entry, sl: s.sl, tp: s.tp, confidence: s.confidence, ts: s.ts, pluginName: s.pluginName || s.plugin, lot: m.lot, rr: m.rr })); } catch { void 0; }
  }
  // key ระดับรายการ: จำนวนเดิมแต่มีดใหม่ (คนละสัญญาณ) ต้องวาดใหม่เสมอ
  const sKey = list.map((x) => `${x.ts || ''}|${x.side}|${x.entry}|${x.confidence}`).join('•');
  // หน้าว่าง ("ยังไม่มีสัญญาณ") เนื้อหาคำอธิบายเปลี่ยนได้ทุกอย่าง (standby/filtered/ไม้จำลองใหม่) — รวมใน key
  const emptyKey = [
    (snap.filtered || []).slice(0, 2).map((x) => String(x.reason).slice(0, 30)).join('|'),
    ((snap.standby && snap.standby.notes) || [])[0] || '',
    (snap.zoneOpen || []).map((t) => t.openedAt).join(','),
    (snap.zoneHistory || []).slice(-1)[0] && (snap.zoneHistory || []).slice(-1)[0].closedAt || '',
  ].join('§');
  renderOnce('signals', `s[${sKey || 'empty'}${emptyKey}]`, box, list.length ? list.map(signalCard).join('') : noSignalHtml(snap));
  const f = $('filtered');
  const flist = snap.filtered || [];
  renderOnce('filtered', `f[${flist.map((x) => String(x.reason).slice(0, 40)).join('|')}]`, f,
    flist.length ? flist.map((x) => `<div class="frow"><b>${esc(x.plugin)}</b> — ${esc(x.reason)}</div>`).join('') : '<div class="empty">ไม่มี</div>');
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
        const signCls = pl >= 0 ? 'up' : 'down';
        return `<div class="zh-line"><span class="t">${Number.isFinite(h.time) ? stamp(h.time) : '—'}</span><span>${h.type === 'buy' ? 'BUY' : 'SELL'} ${fmtD(h.volume, 2)} ล็อต ${fmtD(h.open, 2)} → ${fmtD(h.close, 2)}</span><span class="res ${cls}">${esc(reasonTh[h.reason] || h.reason)} <b class="sig ${signCls}">${money(pl, acctCur, true)}</b></span></div>`;
      }),
    ];
    return `<div class="zh-side ${s}"><h5>${s === 'buy' ? 'ไม้จริงซื้อ (BUY)' : 'ไม้จริงขาย (SELL)'}</h5>
      <div class="zh-score">ชนะ <b>${w}</b> • แพ้ <b>${l}</b> • รวม <b class="${total >= 0 ? 'up' : 'down'}">${money(total, acctCur, true)}</b></div>
      <div class="zh-rows">${lines.length ? lines.join('') : '<div class="empty sm">ยังไม่มี — เข้าไม้จริงฝั่งนี้แล้วจะเริ่มจด</div>'}</div></div>`;
  };
  // จำ scrollTop ของแต่ละตู้ (เรียงเดิมเสมอ: ขาย • ซื้อ • สรุปรายวัน) — วาดใหม่ทุก snapshot แต่ห้ามเด้งกลับขึ้นบนเอง
  const scrolled = [...box.querySelectorAll('.zh-rows, .rh-days')].map((el) => el.scrollTop);
  box.innerHTML =
    `<div class="zh">` + board('sell') + board('buy') +
    `<div class="zh-side zh-rounds"><h5>สรุปรายวัน (ทุกฝั่ง)</h5><div class="rh-days">${days || '<div class="empty sm">ยังไม่มีไม้ที่ปิดแล้ว</div>'}</div></div>` +
    `</div>`;
  [...box.querySelectorAll('.zh-rows, .rh-days')].forEach((el, i) => {
    const v = scrolled[i];
    if (v != null && v > 0) el.scrollTop = v;
  });
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
  // เพดานผ่านเกตจริงตามที่ผู้ใช้ตั้ง (manualRiskMaxPct — ไม่ใช่ 2% แข็งเดิม)
  const capPct = clampPct(snap);
  const maxDist = eqUSD > 0 ? (eqUSD * capPct) / (lot * oz) : Infinity;
  if (atrv * 1.8 > maxDist) atrv = maxDist / 1.8;
  const dir = side === 'buy' ? 1 : -1;
  const d = meta.digits || 2;
  const pt = pointOf(d);
  // ระยะที่ผู้ใช้ตั้งถาวรใน settings (จุด) เป็นทางเลือกก่อน ATR อัตโนมัติ
  const setPts = (snap.risk && snap.risk) || {};
  const slPts = Number(setPts.slDistPts) > 0 ? Number(setPts.slDistPts) : null;
  const tpPts = Number(setPts.tpDistPts) > 0 ? Number(setPts.tpDistPts) : null;
  const read = (id, auto) => ($(id).value.trim() !== '' ? Number($(id).value) : Number(auto.toFixed(d)));
  return {
    sl: read('p-sl', side === 'buy' ? entry - (slPts != null ? slPts * pt : atrv * 1.8) : entry + (slPts != null ? slPts * pt : atrv * 1.8)),
    tp: read('p-tp', side === 'buy' ? entry + (tpPts != null ? tpPts * pt : atrv * 4.5) : entry - (tpPts != null ? tpPts * pt : atrv * 4.5)),
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
    const capP = Math.max(2, Math.min(100, Number(lastSnap.risk && lastSnap.risk.manualRiskMaxPct) || 2));
    const riskUSD = Math.abs(entry - st.sl) * lot * oz;
    $('pend-hint').innerHTML = `<span class="${bad ? 'down' : 'muted'}">ตอนนี้: ${fmtD(px)} </span>• เสี่ยงถ้าแตะ SL: <b>$${fmtD(riskUSD, 2)}</b> / เพดานปุ่มกด $${fmtD((((meta.account && meta.account.equityUSD) || (lastSnap.risk && lastSnap.risk.equity) || 0) * capP) / 100, 2)} (${fmtD(capP, 1)}%) • R:R 1:${fmtD(Math.abs((Number(st.tp) || entry) - entry) / (Math.abs(entry - st.sl) || 1e-9), 2)}${bad ? ' <b class="down">— ทิศราคาผิดตามชนิดที่เลือก (รายละเอียดเมื่อกด)</b>' : ''}`;
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
  // เพดานปุ่มกดเอง — เกิน = แสดงเหตุผล + ปิดปุ่ม (ตรงกับที่ main จะปฏิเสธ)
  const capEq = (meta.account && meta.account.equityUSD > 0 ? meta.account.equityUSD : (Number(lastSnap && lastSnap.risk && lastSnap.risk.equity) || 0));
  const capPctP = Math.max(2, Math.min(100, Number(lastSnap && lastSnap.risk && lastSnap.risk.manualRiskMaxPct) || 2));
  const capP2 = capEq * capPctP / 100;
  const overP = capP2 > 0 && riskUSD > capP2 * 1.001;
  $('mbox').innerHTML = `
    <h3>ยืนยันวางคำสั่งรอ — ${side === 'buy' ? 'BUY' : 'SELL'} ${ptype.toUpperCase()}</h3>
    <div class="mline"><span>ราคาเข้า (รอ trigger)</span><b>${fmtD(req.entry, digits)}</b></div>
    <div class="mline"><span>ล็อต</span><b>${fmtD(req.lot, 2)}</b></div>
    <div class="mline"><span>Stop Loss</span><b class="down">${fmtD(req.sl, digits)}</b></div>
    ${Number(req.tp) > 0 ? `<div class="mline"><span>Take Profit</span><b class="up">${fmtD(req.tp, digits)}</b></div>` : '<div class="mwarn">⚠ ไม่มี TP — ต้องปิดไม้เองด้วยมือ</div>'}
    <div class="mline"><span>เงินเสี่ยงถ้าแตะ SL</span><b class="gold">$${fmtD(riskUSD, 2)}</b></div>
    ${overP ? `<div class="mwarn">⚠ เสี่ยง $${fmtD(riskUSD, 2)} = ${fmtD(capEq > 0 ? riskUSD / capEq * 100 : 0, 1)}% ของทุน — เกินเพดานกลางที่ตั้ง (${fmtD(capPctP, 1)}% = $${fmtD(capP2, 2)}) — คุณยืนยันด้วยตัวเอง</div>` : ''}
    <div class="mwarn">⚠ กดยืนยัน = วางคำสั่งรอบน MT5 — เมื่อราคาถึง ระบบจะเปิดไม้เองพร้อม SL/TP ตามนี้ (โควตานับเป็น 1 ไม้)</div>
    <div class="merr" id="m-err"></div>
    <div class="mbtns">
      <button class="mcancel" id="m-cancel">ยกเลิก</button>
      <button class="mgo ${side}" id="m-go">${overP ? 'ส่งแม้เกินเพดาน (ยืนยันเอง)' : 'วางคำสั่งรอจริง'}</button>
    </div>`;
  $('modal').classList.add('show');
  $('m-cancel').focus();
  // ผูกปุ่มยกเลิก "เสมอ" (กดออกได้ทุกสถานะ) — ปุ่มวางปิดเฉพาะเมื่อเกินเพดาน
  $('m-cancel').addEventListener('click', closeModal);
  // เกินเพดานกลาง = ปุ่มยังกดได้ (ผู้ใช้ยืนยันเอง — รอบแรก main คืน overCap → confirm อีกชั้น → ส่งแบบ allowOverCap)
  $('m-go').addEventListener('click', async () => {
    $('m-go').disabled = true;
    $('m-go').textContent = 'กำลังวาง...';
    try {
      let r = await window.api.sendPending({ side, ptype, lot: req.lot, entry: req.entry, sl: req.sl, tp: req.tp });
      if (!r.ok && r.overCap) {
        if (confirm(`เสี่ยง $${fmtD(riskUSD, 2)} เกินเพดานปุ่มกด (${fmtD(capPctP, 1)}% = $${fmtD(capP2, 2)})\n\nวางคำสั่งรอทั้งที่เกินเพดาน — ยืนยันเอง?`)) {
          r = await window.api.sendPending({ side, ptype, lot: req.lot, entry: req.entry, sl: req.sl, tp: req.tp, allowOverCap: true });
        }
      }
      if (r.ok) { closeModal(); toast(`⏱ วางคำสั่งรอแล้ว (id ${r.id}) — รอราคา trigger (เห็นในรายการคำสั่งรอ)`, 'ok'); setTimeout(() => window.api.refreshNow(), 1500); }
      else if (!$('m-err').textContent) { $('m-err').textContent = '✗ ' + (r.reason || 'วางไม่ได้'); $('m-go').disabled = false; $('m-go').textContent = 'วางคำสั่งรอจริง'; }
      else { $('m-go').disabled = false; $('m-go').textContent = 'วางคำสั่งรอจริง'; }
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
    return `<div class="pend-line" data-t="${p.ticket}"><span style="font-weight:700">${label[p.type] || p.type}</span><span class="pend-info">ล็อต ${fmtD(p.volume, 2)} • ราคา ${fmtD(p.open)} • SL ${fmtD(p.sl)} • TP ${Number(p.tp) ? fmtD(p.tp) : '—'}</span><span class="muted">${dist}</span><span class="pend-act">${editable ? `<button class="pedit-p picon" data-t="${p.ticket}" title="แก้คำสั่งรอ" aria-label="แก้คำสั่งรอ #${p.ticket}"><svg class="ic"><use href="#i-edit" /></svg></button> ` : ''}<button class="pcancel picon" data-t="${p.ticket}" title="ยกเลิกคำสั่งรอ" aria-label="ยกเลิกคำสั่งรอ #${p.ticket}"><svg class="ic"><use href="#i-trash" /></svg></button></span></div>`;
  }).join('');
  if (closingTicketsPending.size) {
    box.querySelectorAll('.pcancel').forEach((b) => { if (closingTicketsPending.has(Number(b.dataset.t))) { b.disabled = true; b.title = 'กำลังยกเลิก...'; } });
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
  row.querySelector('.pend-info').innerHTML = `ล็อต ${fmtD(p.volume, 2)} • ราคา <input class="pin" type="number" inputmode="decimal" step="0.01" data-k="entry" value="${val(p.open)}"> • SL <input class="pin" type="number" inputmode="decimal" step="0.01" data-k="sl" value="${val(p.sl)}"> • TP <input class="pin" type="number" inputmode="decimal" step="0.01" data-k="tp" value="${val(p.tp)}" placeholder="ว่าง = ไม่มี">`;
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
      const req = { ticket: p.ticket, entry: get('entry'), sl: get('sl'), tp: get('tp') || 0 };
      let r = await window.api.modifyPending(req);
      // เกินเพดาน = กดแก้เองยืนยันได้ (กฎ SL บังคับ/ฝั่งถูก ยังตรวจที่ main เหมือนเดิม)
      if (!r.ok && r.overCap && confirm(`${r.reason}\n\nยืนยันแก้คำสั่งรอ #${p.ticket} ทั้งที่เกินเพดาน?`)) r = await window.api.modifyPending({ ...req, allowOverCap: true });
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
// ปุ่ม ⛶ ขยายการ์ดคำสั่งรอเต็มจอ / Esc = ย่อกลับ / ลากหัวการ์ดเพื่อย้ายได้
$('pend-max').addEventListener('click', () => {
  const el = $('pend-card');
  const max = !el.classList.contains('max');
  el.classList.toggle('max', max);
  $('pend-max').textContent = max ? '↘ ย่อ' : '⛶';
  if (max) setupPendDrag();
  else { el.style.left = ''; el.style.top = ''; el.style.transform = ''; }
});
// ลากการ์ดขยายด้วยหัวการ์ด (pointer events — ได้ทั้งเมาส์/สัมผัส)
function setupPendDrag() {
  const el = $('pend-card'), head = el && el.querySelector('.pend-head');
  if (!el || !head || head.dataset.drag === '1') return;
  head.dataset.drag = '1';
  head.style.cursor = 'grab'; head.style.userSelect = 'none';
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  const onDown = (e) => {
    if (dragging) return;
    if (e.target.closest('#pend-max')) return; // ปุ่มย่อไม่ลาก
    const r = el.getBoundingClientRect();
    ox = r.left; oy = r.top;
    sx = e.clientX; sy = e.clientY;
    dragging = true;
    el.style.transform = 'none';
    el.style.left = `${Math.round(ox)}px`; el.style.top = `${Math.round(oy)}px`;
    el.classList.add('dragging');
    try { head.setPointerCapture(e.pointerId); } catch { void 0; }
  };
  const onMove = (e) => {
    if (!dragging) return;
    const vw = window.innerWidth, vh = window.innerHeight, r = el.getBoundingClientRect();
    const nx = Math.min(Math.max(20 - r.width + 80, ox + e.clientX - sx), vw - 84);
    const ny = Math.min(Math.max(4, oy + e.clientY - sy), vh - 56);
    el.style.left = `${Math.round(nx)}px`; el.style.top = `${Math.round(ny)}px`;
  };
  const onUp = () => { dragging = false; el.classList.remove('dragging'); };
  head.addEventListener('pointerdown', onDown);
  head.addEventListener('pointermove', onMove);
  head.addEventListener('pointerup', onUp);
  head.addEventListener('pointercancel', onUp);
}
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

// ดับเบิลคลิกบนชาร์ต (รวมเส้นราคาด้านขวา) = เปิด "คำสั่งรอล่วงหน้า" + กรอกครบทุกช่องจากจุดที่คลิก
// กติกา: จุดที่คลิกอยู่บนเส้นราคาตลาด = SELL LIMIT • ล่างเส้น = BUY LIMIT • SL/TP = ATR(M15) ×1.8 / ×4.5 ตามฝั่ง
function chartPriceFromEvent(ev) {
  if (!chartM || !candleSeries) return NaN;
  const box = $('chart').getBoundingClientRect();
  if (!box.width) return NaN;
  try { const p = candleSeries.coordinateToPrice(ev.clientY - box.top); return Number.isFinite(Number(p)) ? Number(p) : NaN; } catch { return NaN; }
}
function openPendingAt(ev) {
  const snap = lastSnap, meta = (snap && snap.meta) || {};
  if (!Number.isFinite(Number(meta.bid))) { toast('ยังไม่มีราคาสด — รอบถัดไปแล้วลองใหม่', 'err'); return; }
  const px = chartPriceFromEvent(ev);
  if (!Number.isFinite(px)) return;
  const d = meta.digits || 2;
  const bid = Number(meta.bid), ask = Number(meta.ask), mid = (bid + ask) / 2;
  const side = px >= mid ? 'sell' : 'buy';
  const m15 = snap.analysis && snap.analysis.tf && snap.analysis.tf.M15;
  const atr = (m15 && Number.isFinite(m15.atr) && m15.atr > 0) ? Number(m15.atr) : mid * 0.0008;
  const entry = Number(px.toFixed(d));
  // SL ให้ผ่านเกตจริง: ระยะ SL จำกัดตามเพดานปุ่มกด/ล็อต (ถ้า ATR กว้างเกิน = บีบ, TP ยึด RR 2.5 ตามระยะใหม่)
  const lot = Math.max(0.01, Number($('p-lot').value) || 0.01);
  const capPct = clampPct(snap);
  const eqReal = (meta.account && Number.isFinite(meta.account.equityUSD)) ? meta.account.equityUSD : (Number(snap.risk && snap.risk.equity) || 0);
  const maxSlDist = eqReal > 0 ? (eqReal * capPct) / (lot * 100) : Infinity;
  const slDist = Math.min(atr * 1.8, maxSlDist);
  const riskTxt = slDist < atr * 1.8 ? ` (บีบ SL ตามเพดาน ${capPct}% — เดิม $${fmtD(atr * 1.8, 2)})` : '';
  const sl = side === 'buy' ? entry - slDist : entry + slDist;
  const tp = side === 'buy' ? entry + slDist * 2.5 : entry - slDist * 2.5;
  $('p-kind').value = `${side}-limit`;
  $('p-entry').value = entry;
  $('p-sl').value = Number(sl.toFixed(d));
  $('p-tp').value = Number(tp.toFixed(d));
  // ตั้งค่าตรงไม่ยิง event → อัปเดตป้าย/ปุ่มลัดราคาเข้าเอง (ราคาจากชาร์ต ไม่ใช่จากปุ่มลัด)
  pendEntryPick = null;
  syncPendKind();
  syncPendChips(true);
  const el = $('pend-card');
  el.classList.add('max'); $('pend-max').textContent = '↘ ย่อ';
  setupPendDrag();
  try { el.scrollIntoView({ block: 'nearest' }); } catch { void 0; }
  toast(`📋 ${side === 'buy' ? 'BUY LIMIT — ราคาอยู่ล่างเส้น' : 'SELL LIMIT — ราคาอยู่บนเส้น'} @ ${entry.toFixed(d)} • SL ${Number(sl.toFixed(d))} • TP ${Number(tp.toFixed(d))}${riskTxt} — ตรวจแล้วกด "วางคำสั่งรอ"`, 'ok');
}
$('chart').addEventListener('dblclick', (e) => { e.preventDefault(); openPendingAt(e); });

function renderLogs(snap) {
  $('logs').innerHTML = (snap.logs || []).slice().reverse().map((l) => `<div class="logline ${l.lvl}"><span class="t">${fmtTs(l.t)}</span><span class="tag">${esc(l.tag)}</span><span>${esc(l.msg)}</span></div>`).join('') || '<div class="empty">ยังไม่มีบันทึก</div>';
}

/* ---------- trading (คำสั่งซื้อขายจริงผ่าน MT5, กันเหนียว 3 ชั้น) ---------- */
function toast(msg, cls = '', ms = 8000) {
  const box = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + cls;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
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

// โหมดช่อง SL/TP ที่ว่าง (ปุ่มลัดใต้ช่อง): null = อัตโนมัติ ATR • ตัวเลข = ระยะจุดจากราคาฝั่งที่กด • 'none' = ไม่ตั้ง TP
// อยู่ในตัวแปรโมดูล (renderTradePanel วาดใหม่ทุก snapshot) — ค้างจนผู้ใช้เปลี่ยนเอง ไม่บันทึกข้ามการเปิดแอป
const stopPts = { sl: null, tp: null };
const STOP_INPUT = { sl: 't-sl', tp: 't-tp' };
const pointOf = (d) => Math.pow(10, -(d || 2));
// SL/TP ของฝั่งที่จะกด: ช่องที่ผู้ใช้กรอก = ใช้ค่านั้น, ช่องว่าง = ระยะจุดที่เลือก หรือ ATR(M15)×1.8 / ×4.5 จากราคาฝั่งนั้น
function stopsFor(side, snap) {
  const meta = (snap && snap.meta) || {};
  // ราคาฝั่งที่กด = ทิคสด (ตัวเลขบนปุ่ม BUY/SELL) • ไม่มีทิค = ราคาจาก snapshot (ช้ากว่าได้หลายวิ)
  const lq = snap === lastSnap ? liveQuote() : null;
  const px = lq ? (side === 'buy' ? lq.ask : lq.bid) : (side === 'buy' ? meta.ask : meta.bid);
  if (!Number.isFinite(px)) return null;
  const m15 = snap.analysis && snap.analysis.tf && snap.analysis.tf.M15;
  let atr = m15 && Number.isFinite(m15.atr) && m15.atr > 0 ? m15.atr : px * 0.0008;
  const dir = side === 'buy' ? 1 : -1;
  const d = meta.digits || 2;
  // "อัตโนมัติ" ต้องให้ไม้ที่ผ่านเกตได้จริง: ระยะ SL เกินเพดานเงิน (2% ทุนจริง) = ตีเข้าเดิม (สมดุล: ไม้แน่น + TP คงเดิม)
  const lot = Number($('t-lot').value) || 0.01;
  const oz = (meta.spec && meta.spec.contractSize) || 100;
  const eqUSD = (meta.account && Number.isFinite(meta.account.equityUSD) && meta.account.equityUSD > 0) ? meta.account.equityUSD : (Number((snap && snap.risk && snap.risk.equity)) || 0);
  // เพดานของปุ่มกด (manualRiskMaxPct) — ช่อง ATR แนะนำ SL ที่ผ่านเกตได้จริงตามเพดานที่ผู้ใช้ตั้ง
  const capPct = clampPct(snap);
  const maxDist = eqUSD > 0 ? (eqUSD * capPct) / (lot * oz) / 100 : Infinity;
  if (atr * 1.8 > maxDist) atr = maxDist / 1.8;
  const pt = pointOf(d);
  const rUsr = (snap && snap.risk) || {};
  const uSl = Number(rUsr.slDistPts), uTp = Number(rUsr.tpDistPts);
  const read = (k, auto) => {
    const el = $(STOP_INPUT[k]);
    if (el.value.trim() !== '') return Number(el.value);
    const m = stopPts[k];
    if (k === 'tp' && m === 'none') return 0; // ไม่ตั้ง TP
    if (typeof m === 'number' && m > 0) return Number((k === 'sl' ? px - dir * m * pt : px + dir * m * pt).toFixed(d));
    return Number(auto.toFixed(d));
  };
  return {
    sl: read('sl', uSl > 0 ? px - dir * uSl * pt : px - dir * atr * 1.8),
    tp: read('tp', uTp > 0 ? px + dir * uTp * pt : px + dir * atr * 4.5),
    px,
  };
}

// เพดาน % ตามกลุ่มคำสั่ง (ผู้ใช้ตั้ง 2–100; 100 = ไม่มีดัก) — ใช้ตรวจ hint ปุ่มกดเอง
function clampPct(snap) {
  const r = (snap && snap.risk) || {};
  return Math.max(2, Math.min(100, Number(r.manualRiskMaxPct) || 2));
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
  // ตัวเลขบนปุ่ม = ราคาเดียวกับที่ stopsFor/หน้ายืนยันใช้ (ทิคสด ถ้ามี) — snapshot ไม่ทับด้วยราคาที่ช้ากว่า
  const lq = live && snap === lastSnap ? liveQuote() : null;
  $('t-bid').textContent = live ? (lq ? lq.bid : meta.bid).toFixed(d) : '—';
  $('t-ask').textContent = live ? (lq ? lq.ask : meta.ask).toFixed(d) : '—';
  // SL/TP ว่าง = คิดให้อัตโนมัติตามฝั่งที่กด (เดิมเติม SL ฝั่งซื้อไว้ช่องเดียว กด SELL แล้ว SL อยู่ผิดฝั่ง)
  const lotVal = Number($('t-lot').value);
  const riskOf = (side) => {
    if (!live || !Number.isFinite(lotVal)) return null;
    const st = stopsFor(side, snap);
    return st && Number.isFinite(st.sl) ? (side === 'buy' ? st.px - st.sl : st.sl - st.px) : null;
  };
  const riskBuy = riskOf('buy'), riskSell = riskOf('sell');
  const capPct = clampPct(snap);
  const capUSD = eqUsed * capPct / 100;   // เพดานปุ่มกดเอง (จากทุนจริงเมื่อเชื่อม MT5 หรือทุนที่ตั้ง)
  const oz = (meta.spec && meta.spec.contractSize) || 100;
  const rb = riskBuy != null && riskBuy > 0 ? (riskBuy * lotVal * oz) : null;
  const rs = riskSell != null && riskSell > 0 ? (riskSell * lotVal * oz) : null;
  // hint ช่อง SL/TP: แสดงราคาที่ระบบจะตั้งให้จริง ตามฝั่งที่จะกด (กรอกเองได้เสมอ) — เขียนที่นี่ที่เดียว (วาดทับทุก snapshot)
  const sB = live ? stopsFor('buy', snap) : null, sS = live ? stopsFor('sell', snap) : null;
  const both = !!(sB && sS);
  const pt = pointOf(d);
  const stopHint = (k) => {
    const el = $(STOP_INPUT[k]);
    const lbl = k === 'sl' ? 'SL' : 'TP';
    const m = stopPts[k];
    if (el.value.trim() !== '') {
      const v = Number(el.value);
      return k === 'tp' && v === 0 ? 'ใส่ 0 = ไม่ตั้ง TP — ต้องปิดไม้เอง' : `ใช้ราคาที่กรอก${Number.isFinite(v) ? ` <b>${v.toFixed(d)}</b>` : ''}`;
    }
    if (k === 'tp' && m === 'none') return 'ไม่ตั้ง TP — ต้องปิดไม้เอง';
    if (typeof m === 'number') {
      const usd = Number.isFinite(lotVal) && lotVal > 0 ? m * pt * lotVal * oz : null;
      return `ระยะ ${m} จุด${usd != null ? ` ($${fmtD(usd, 2)} ที่ล็อตนี้)` : ''}` +
        (both ? ` • ซื้อ → ${lbl} <b>${sB[k].toFixed(d)}</b> • ขาย → ${lbl} <b>${sS[k].toFixed(d)}</b>` : '');
    }
    if (!both) return k === 'sl' ? 'ว่าง = อัตโนมัติ' : 'ว่าง = อัตโนมัติ • ใส่ 0 = ไม่ตั้ง TP';
    return k === 'sl'
      ? `กรอกเองได้ • ซื้อ → <b>${sB.sl.toFixed(d)}</b> ขาย → <b>${sS.sl.toFixed(d)}</b>`
      : `ซื้อ → <b>${sB.tp.toFixed(d)}</b> ขาย → <b>${sS.tp.toFixed(d)}</b> • ใส่ 0 = ไม่ตั้ง TP`;
  };
  $('t-sl-hint').innerHTML = stopHint('sl');
  $('t-tp-hint').innerHTML = stopHint('tp');
  $('t-spread').textContent = live ? String(Math.round((meta.ask - meta.bid) * Math.pow(10, d))) : '—';
  syncLotChips(meta);
  syncPendChips(live);
  // สถานะสวิตช์จากฝั่ง MT5 จริง (EA + AutoTrading)
  const gateTxt = live && !meta.spec
    ? '⚠ EA ใน MT5 รุ่นเก่า ส่งไม้ไม่ได้ — แท็บ MT5 → ติดตั้ง EA แล้วลากลงชาร์ตใหม่'
    : acct
    ? (acct.ordersAllowed && acct.algoTrading ? 'ส่งไม้พร้อม ✓' : `ส่งไม้ยังไม่พร้อม (AllowOrders: ${acct.ordersAllowed ? '✓' : '✗'} • AutoTrading: ${acct.algoTrading ? '✓' : '✗'})`)
    : '—';
  $('t-info').textContent = live
    ? `เสี่ยง/ไม้: ซื้อ $${rb != null ? fmtD(rb, 2) : '—'} • ขาย $${rs != null ? fmtD(rs, 2) : '—'} / เพดานปุ่มกด $${fmtD(capUSD, 2)} (${fmtD(capPct, 1)}% ของ ${eqLive ? `ทุนจริง ≈ $${fmtD(eqUsed, 0)}${acctCur !== 'USD' ? ` แปลงจาก ${acctCur}` : ''}` : `ทุนที่ตั้ง $${fmtD(eqUsed, 0)}`}) • โควตา ${(quota.dailyCount || 0) + (quota.manualCount || 0)}/${quota.maxPerDay} • ${gateTxt}`
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

/* ---------- ปุ่มลัดแผงส่งคำสั่ง: ล็อตด่วน / ระยะ SL-TP (จุด) / คัดลอกราคา / ราคาเข้าคำสั่งรอ ----------
   ทุกปุ่มแค่ "กรอกช่อง" — ยังต้องกด BUY/SELL/วางคำสั่งรอ + หน้ายืนยันเดิมเสมอ (ไม่ข้าม tryTrade/เกต) */
const setAttrIf = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };
// ราคาสด: ทิคล่าสุดที่ paintTick จดไว้ (_v) — ใช้เฉพาะตอน snapshot ยังมี bid/ask (MT5 หลุด = ไม่มีราคา)
// ทิคเก่าเกิน 30 วิ (เช่น MT5 เพิ่งกลับมาเชื่อม ยังไม่มีทิคใหม่) = ใช้ราคา snapshot แทน
const TICK_FRESH_MS = 30_000;
function liveQuote() {
  const m = (lastSnap && lastSnap.meta) || {};
  if (!Number.isFinite(m.bid) || !Number.isFinite(m.ask)) return null;
  const bEl = $('t-bid'), aEl = $('t-ask');
  const fresh = Number.isFinite(bEl._v) && Number.isFinite(aEl._v) && Date.now() - (bEl._at || 0) < TICK_FRESH_MS;
  return fresh ? { bid: bEl._v, ask: aEl._v, d: m.digits || 2 } : { bid: m.bid, ask: m.ask, d: m.digits || 2 };
}

function syncStopChips(k) {
  const typed = $(STOP_INPUT[k]).value.trim() !== '';
  const m = stopPts[k];
  document.querySelectorAll(`.qchip[data-stop="${k}"]`).forEach((c) => {
    const v = c.dataset.pts;
    const on = !typed && (v === '' ? m == null : v === 'none' ? m === 'none' : Number(v) === m);
    setAttrIf(c, 'aria-pressed', on ? 'true' : 'false');
  });
}
document.querySelectorAll('.qchip[data-stop]').forEach((c) => c.addEventListener('click', () => {
  const k = c.dataset.stop, v = c.dataset.pts;
  stopPts[k] = v === '' ? null : v === 'none' ? 'none' : Number(v);
  const el = $(STOP_INPUT[k]);
  el.value = '';
  el.placeholder = stopPts[k] == null ? 'อัตโนมัติ' : stopPts[k] === 'none' ? 'ไม่ตั้ง TP' : `ระยะ ${stopPts[k]} จุด`;
  syncStopChips(k);
  if (lastSnap) renderTradePanel(lastSnap);
}));
// พิมพ์ราคาเอง = เลิกโหมดจุด (ปุ่มลัดดับ) • ลบจนว่าง = กลับเป็นอัตโนมัติ
for (const k of ['sl', 'tp']) {
  $(STOP_INPUT[k]).addEventListener('input', () => {
    if (stopPts[k] != null) { stopPts[k] = null; $(STOP_INPUT[k]).placeholder = 'อัตโนมัติ'; }
    syncStopChips(k);
    if (lastSnap) renderTradePanel(lastSnap);
  });
}

// ล็อตด่วน: ปุ่มที่ต่ำกว่าล็อตขั้นต่ำของโบรกเกอร์ = aria-disabled (กดแล้วบอกเหตุผล)
function syncLotChips(meta) {
  const v = Number($('t-lot').value);
  const spec = (meta && meta.spec) || {};
  const vmin = Number(spec.volMin) > 0 ? Number(spec.volMin) : 0.01;
  document.querySelectorAll('#t-lot-chips .qchip[data-lot]').forEach((c) => {
    const lot = Number(c.dataset.lot);
    setAttrIf(c, 'aria-pressed', Math.abs(lot - v) < 1e-9 ? 'true' : 'false');
    if (lot < vmin - 1e-9) { setAttrIf(c, 'aria-disabled', 'true'); c.title = `ต่ำกว่าล็อตขั้นต่ำของโบรกเกอร์ (${vmin})`; }
    else if (c.hasAttribute('aria-disabled')) { c.removeAttribute('aria-disabled'); c.title = ''; }
  });
}
document.querySelectorAll('#t-lot-chips .qchip[data-lot]').forEach((c) => c.addEventListener('click', () => {
  if (c.getAttribute('aria-disabled') === 'true') { toast(c.title || 'ใช้ล็อตนี้ไม่ได้', 'err'); return; }
  $('t-lot').value = Number(c.dataset.lot).toFixed(2);
  $('t-lot').dispatchEvent(new Event('input', { bubbles: true }));
}));
$('t-lot').addEventListener('input', () => {
  syncLotChips(lastSnap && lastSnap.meta);
  if (lastSnap) renderTradePanel(lastSnap);
});

// คัดลอก Bid/Ask (ปุ่มแยก — ไม่ผูกที่ตัวเลขในปุ่ม BUY/SELL กันกดพลาด)
document.querySelectorAll('.qcopy[data-copy]').forEach((b) => b.addEventListener('click', () => {
  const q = liveQuote();
  const k = b.dataset.copy === 'ask' ? 'ask' : 'bid';
  if (!q || !Number.isFinite(q[k])) { toast('ต้องเชื่อม MT5 ก่อน — ราคา bid/ask ยังไม่มา', 'err'); return; }
  copyText(q[k].toFixed(q.d), k === 'ask' ? 'Ask' : 'Bid');
}));
$('price').addEventListener('click', () => {
  const v = Number($('price').textContent);
  if (!Number.isFinite(v) || v <= 0) return;
  copyText(v.toFixed(priceDigits()), 'ราคา');
});

// คำสั่งรอ: ราคาเข้า = ราคาตลาด ± จุด ตามชนิด (BUY LIMIT ใต้ ASK • SELL LIMIT เหนือ BID • BUY STOP เหนือ ASK • SELL STOP ใต้ BID)
const PEND_DIR = {
  'buy-limit': { base: 'ask', sign: -1 }, 'sell-limit': { base: 'bid', sign: 1 },
  'buy-stop': { base: 'ask', sign: 1 }, 'sell-stop': { base: 'bid', sign: -1 },
};
let pendEntryPick = null; // { pts, value } ที่ปุ่มลัดกรอกล่าสุด — ช่องยังเท่าค่านี้ = เปลี่ยนชนิดแล้วคิดใหม่ให้
function syncPendKind() {
  const dir = PEND_DIR[$('p-kind').value] || PEND_DIR['buy-limit'];
  const sg = dir.sign < 0 ? '−' : '+';
  $('p-entry-base').textContent = `ราคาเข้า = ${dir.base.toUpperCase()}`;
  document.querySelectorAll('#p-entry-chips .qchip[data-pts]').forEach((c) => {
    c.textContent = `${sg}${c.dataset.pts}`;
    c.title = `ราคาเข้า = ${dir.base.toUpperCase()} ${sg} ${c.dataset.pts} จุด (อิงราคาตอนกด)`;
  });
}
function syncPendChips(live) {
  document.querySelectorAll('#p-entry-chips .qchip[data-pts]').forEach((c) => {
    if (live) { if (c.hasAttribute('aria-disabled')) c.removeAttribute('aria-disabled'); }
    else setAttrIf(c, 'aria-disabled', 'true');
    setAttrIf(c, 'aria-pressed', pendEntryPick && Number(c.dataset.pts) === pendEntryPick.pts ? 'true' : 'false');
  });
}
function fillPendEntry(pts) {
  const q = liveQuote();
  const dir = PEND_DIR[$('p-kind').value] || PEND_DIR['buy-limit'];
  if (!q || !Number.isFinite(q[dir.base])) { toast('ต้องเชื่อม MT5 ก่อน', 'err'); return false; }
  const base = q[dir.base];
  const value = (base + dir.sign * pts * pointOf(q.d)).toFixed(q.d);
  pendEntryPick = { pts, value };
  $('p-entry').value = value;
  $('p-entry').dispatchEvent(new Event('input', { bubbles: true }));
  syncPendChips(true);
  $('pend-hint').innerHTML = `ราคาเข้า <b>${value}</b> = ${dir.base.toUpperCase()} ${base.toFixed(q.d)} ${dir.sign < 0 ? '−' : '+'} ${pts} จุด • อิงราคาตอนกด`;
  return true;
}
document.querySelectorAll('#p-entry-chips .qchip[data-pts]').forEach((c) => c.addEventListener('click', () => {
  if (c.getAttribute('aria-disabled') === 'true') { toast('ต้องเชื่อม MT5 ก่อน', 'err'); return; }
  fillPendEntry(Number(c.dataset.pts));
}));
$('p-kind').addEventListener('change', () => {
  syncPendKind();
  // ช่องราคาเข้ายังเป็นค่าจากปุ่มลัด = คิดใหม่ตามทิศของชนิดใหม่ (ระยะจุดเดิม)
  if (pendEntryPick && $('p-entry').value === pendEntryPick.value && liveQuote()) fillPendEntry(pendEntryPick.pts);
});
$('p-entry').addEventListener('input', () => {
  if (!pendEntryPick || $('p-entry').value === pendEntryPick.value) return;
  pendEntryPick = null;
  syncPendChips(!!liveQuote());
});
syncPendKind();

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

/* ---------- กันทุน (SL → ราคาเข้า) / ปิดครึ่ง ต่อไม้ ---------- */
const BE_MIN_PTS = 100; // ต้องกำไรอย่างน้อยเท่านี้ (จุด) ก่อนกันทุนได้ — กัน SL ชิดราคาจนโดนเด้งออกทันที
// เทียบเวอร์ชัน EA (ตรรกะเดียวกับ eaBelow ใน src/main/main.js) — ว่าง/อ่านไม่ได้ = ถือว่าเก่ากว่า
const eaBelow = (have, need) => {
  const a = String(have || '').split('.').map(Number), b = String(need).split('.').map(Number);
  if (!a.length || a.some((x) => !Number.isFinite(x))) return true;
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x < y; }
  return false;
};
// กันกดซ้ำต่อไม้ (เหมือน closingTickets: หมดอายุ 20 วิ) — ปลดเร็วเมื่อ snapshot เห็นผลแล้ว (SL/ล็อตเปลี่ยน) หรือ MT5 ปฏิเสธ
const rowBusy = new Map(); // ticket → { at, kind: 'be'|'half', sl, vol }
function rowBusyOf(p) {
  const t = Number(p.ticket), b = rowBusy.get(t);
  if (!b) return null;
  const landed = b.kind === 'half' ? Math.abs(Number(p.volume) - b.vol) > 1e-9 : Math.abs((Number(p.sl) || 0) - b.sl) > 1e-9;
  if (Date.now() - b.at >= 20_000 || landed) { rowBusy.delete(t); return null; }
  return b;
}
function beState(p, meta) {
  const d = meta.digits || 2, pt = pointOf(d);
  const open = Number(p.open), sl = Number(p.sl) || 0, buy = p.type === 'buy';
  if (buy ? (sl > 0 && sl >= open - pt / 2) : (sl > 0 && sl <= open + pt / 2)) return { done: true, reason: `กันทุนแล้ว — SL ${fmtD(sl, d)} อยู่ที่ราคาเข้าหรือดีกว่า` };
  const q = liveQuote() || meta;
  const mkt = Number(buy ? q.bid : q.ask);
  if (!Number.isFinite(mkt) || mkt <= 0 || !Number.isFinite(open) || open <= 0) return { reason: 'ยังไม่มีราคาสด — ต้องเชื่อม MT5 ก่อน' };
  const gain = Math.floor((buy ? mkt - open : open - mkt) / pt + 1e-6);
  if (gain < BE_MIN_PTS) return { reason: `ต้องกำไรอย่างน้อย ${BE_MIN_PTS} จุดก่อนกันทุน (ตอนนี้ ${gain >= 0 ? '+' : ''}${gain} จุด)`, gain, mkt };
  return { ok: true, gain, mkt, side: buy ? 'BID' : 'ASK', title: `เลื่อน SL ไปที่ราคาเข้า ${fmtD(open, d)} (ตอนนี้ +${gain} จุด)` };
}
function halfState(p, meta) {
  const spec = meta.spec || {};
  const vmin = Number(spec.volMin) > 0 ? Number(spec.volMin) : 0.01;
  const vstep = Number(spec.volStep) > 0 ? Number(spec.volStep) : 0.01;
  const vol = Number(p.volume);
  const dec = Math.max(2, (String(vstep).split('.')[1] || '').length);
  const half = Number((Math.floor(vol / 2 / vstep + 1e-9) * vstep).toFixed(dec)); // ปัดลงตามขั้นล็อต
  const rest = Number((vol - half).toFixed(dec));
  if (!(half >= vmin - 1e-9) || !(rest >= vmin - 1e-9)) return { reason: `ล็อต ${fmtD(vol, 2)} แบ่งครึ่งไม่ได้ (ขั้นต่ำ ${vmin} ล็อต)` };
  if (typeof window.api.closePartial !== 'function') return { reason: 'แอปรุ่นนี้ยังไม่รองรับปิดครึ่ง — อัปเดตแอปก่อน' };
  if (eaBelow(meta.ea, '1.9')) return { reason: `ต้องใช้ EA v1.9 ขึ้นไป (ตอนนี้ v${meta.ea || '?'}) — แท็บ MT5 → ติดตั้ง EA ให้ฉันเอง แล้วลากลงชาร์ตใหม่` };
  return { ok: true, half, rest, dec, title: `ปิด ${fmtD(half, 2)} ล็อต เหลือ ${fmtD(rest, 2)} ล็อต` };
}
// ใช้ไม้/ราคาล่าสุดตอนกด (ตารางอาจวาดไว้ก่อนหน้า ~1 snapshot)
const freshPos = (p) => {
  const mm = (lastSnap && lastSnap.meta) || {};
  return { p: (mm.positions || []).find((x) => Number(x.ticket) === Number(p.ticket)) || p, m: mm };
};
async function breakEvenNow(p0, m0) {
  const { p, m } = freshPos(p0);
  const meta = m.digits ? m : m0;
  const st = beState(p, meta);
  if (!st.ok) { toast(st.reason, st.done ? 'ok' : 'err'); return; }
  const d = meta.digits || 2, t = Number(p.ticket), open = Number(p.open);
  const oldSl = Number(p.sl) ? fmtD(Number(p.sl), d) : 'ไม่มี';
  if (!confirm(`กันทุนไม้ #${t}?\n${String(p.type).toUpperCase()} ${fmtD(Number(p.volume), 2)} ล็อต @ ${fmtD(open, d)}\nSL: ${oldSl} → ${fmtD(open, d)} (ราคาเข้า)\nตอนนี้ ${st.side} ${fmtD(st.mkt, d)} (+${st.gain} จุด)\nถ้าราคากลับมาแตะ = ปิดเสมอตัว (ไม่รวมคอมมิชชัน/สว็อป)`)) return;
  rowBusy.set(t, { at: Date.now(), kind: 'be', sl: Number(p.sl) || 0, vol: Number(p.volume) });
  if (lastSnap) renderPositions(lastSnap.meta);
  try {
    const r = await window.api.modifyPosition({ ticket: p.ticket, sl: open, tp: Number(p.tp) || 0 });
    if (r.ok) { toast(`📤 ส่งคำสั่งกันทุนไม้ #${t} แล้ว (SL → ${fmtD(open, d)}) — รอผลจาก MT5...`, 'ok'); setTimeout(() => window.api.refreshNow(), 1200); return; }
    toast('✗ กันทุนไม่ได้: ' + (r.reason || 'ไม่ทราบสาเหตุ'), 'err');
  } catch (e) { toast('✗ กันทุนไม่ได้: ' + e.message, 'err'); }
  rowBusy.delete(t);
  if (lastSnap) renderPositions(lastSnap.meta);
}
async function closeHalfNow(p0, m0) {
  const { p, m } = freshPos(p0);
  const meta = m.digits ? m : m0;
  const st = halfState(p, meta);
  if (!st.ok) { toast(st.reason, 'err'); return; }
  const t = Number(p.ticket);
  const pl = Number.isFinite(Number(p.profit)) ? money(Number(p.profit), acctCur, true) : '—';
  if (!confirm(`ปิดครึ่งไม้ #${t} ที่ราคาตลาดตอนนี้?\n${String(p.type).toUpperCase()} ${fmtD(Number(p.volume), 2)} ล็อต @ ${fmtD(Number(p.open), meta.digits || 2)} • ลอยตัว ${pl}\nปิด ${fmtD(st.half, 2)} ล็อต → เหลือ ${fmtD(st.rest, 2)} ล็อต (SL/TP เดิม)`)) return;
  rowBusy.set(t, { at: Date.now(), kind: 'half', sl: Number(p.sl) || 0, vol: Number(p.volume) });
  if (lastSnap) renderPositions(lastSnap.meta);
  try {
    const r = await window.api.closePartial({ ticket: t, volume: st.half });
    if (r && r.ok) { toast(`📤 ส่งคำสั่งปิดครึ่งไม้ #${t} (${fmtD(st.half, 2)} ล็อต) แล้ว — รอผลจาก MT5...`, 'ok'); setTimeout(() => window.api.refreshNow(), 1200); return; }
    toast('✗ ปิดไม่ได้: ' + ((r && r.reason) || 'ไม่ทราบสาเหตุ'), 'err');
  } catch (e) { toast('✗ ปิดไม่ได้: ' + e.message, 'err'); }
  rowBusy.delete(t);
  if (lastSnap) renderPositions(lastSnap.meta);
}
// คลิกช่องราคาเข้า/SL/TP ในตาราง = คัดลอก (ผูกครั้งเดียว — ตารางวาดใหม่ทุก snapshot) • ข้ามปุ่ม/ช่องกรอก/แถวที่กำลังแก้
$('positions').addEventListener('click', (e) => {
  if (e.target.closest('input, button')) return;
  const cell = e.target.closest('td.copyable[data-copy]');
  if (!cell) return;
  const tr = cell.closest('tr');
  if (tr && editingTicket != null && Number(tr.dataset.row) === editingTicket) return;
  copyText(cell.dataset.copy, cell.dataset.label || '');
});

// แก้ SL/TP: ระหว่างแก้ไม่วาดตารางใหม่ (กันช่องกรอกถูกล้างทุกรอบ snapshot)
let editingTicket = null;
function renderPositions(meta) {
  const list = (meta && meta.positions) || [];
  const box = $('positions');
  renderCloseAll(meta, list);
  renderAutoClose(meta, list);
  if (editingTicket != null && list.some((p) => Number(p.ticket) === editingTicket)) return;
  editingTicket = null;
  if (!list.length) { rowBusy.clear(); box.innerHTML = '<div class="empty">ไม่มีออร์เดอร์ที่เปิดอยู่ (XAUUSD)</div>'; return; }
  for (const t of rowBusy.keys()) if (!list.some((p) => Number(p.ticket) === t)) rowBusy.delete(t);
  const m = meta || {};
  const d = m.digits || 2;
  // ปุ่มกันทุน/ปิดครึ่ง: ใช้ไม่ได้ = aria-disabled + data-why (กดแล้วบอกเหตุผล) • กำลังส่ง = disabled ทั้งแถว
  const actBtns = (p, lock, busy) => {
    const tk = esc(p.ticket);
    const be = beState(p, m), half = halfState(p, m);
    const beTxt = busy && busy.kind === 'be' ? 'กำลังส่ง…' : be.done ? 'กันทุนแล้ว' : 'กันทุน';
    const hfTxt = busy && busy.kind === 'half' ? 'กำลังส่ง…' : 'ปิดครึ่ง';
    const attrs = (st, kind) => lock
      ? ` disabled${busy && busy.kind === kind ? ' aria-busy="true"' : ''}`
      : st.ok ? ` title="${esc(st.title || '')}"` : ` aria-disabled="true" title="${esc(st.reason)}" data-why="${esc(st.reason)}"`;
    return `<button class="pact pbe${be.done ? ' is-done' : ''}" data-ticket="${tk}"${attrs(be, 'be')}>${beTxt}</button>` +
      `<button class="pact phalf" data-ticket="${tk}"${attrs(half, 'half')}>${hfTxt}</button>`;
  };
  // ช่องราคาเข้า/SL/TP คลิกคัดลอกได้ (ตัวฟังผูกที่ #positions ครั้งเดียว — ดูด้านล่าง)
  const cp = (cls, v, label) => (Number(v)
    ? `class="${cls} copyable" data-copy="${Number(v).toFixed(d)}" data-label="${label}" title="คลิกเพื่อคัดลอก"`
    : `class="${cls}"`);
  box.innerHTML = '<table><tr><th>ฝั่ง</th><th>ล็อต</th><th>เข้า</th><th>SL</th><th>TP</th><th>กำไร/ขาดทุน</th><th></th></tr>' +
    list.map((p) => {
      const busy = rowBusyOf(p);
      const lock = isClosing(p.ticket) || !!busy;
      return `<tr data-row="${esc(p.ticket)}">
      <td class="ptype ${p.type}">${p.type === 'buy' ? 'ซื้อ' : 'ขาย'}</td>
      <td>${Number(p.volume).toFixed(2)}</td><td ${cp('c-open', p.open, 'ราคาเข้า')}>${fmtD(p.open, 2)}</td><td ${cp('c-sl', p.sl, 'SL')}>${Number(p.sl) ? fmtD(p.sl, 2) : '—'}</td><td ${cp('c-tp', p.tp, 'TP')}>${Number(p.tp) ? fmtD(p.tp, 2) : '—'}</td>
      <td class="${p.profit >= 0 ? 'up' : 'down'}">${money(p.profit, acctCur, true)}</td>
      <td class="c-act"><div class="pacts">${actBtns(p, lock, busy)}<button class="pclose pedit" data-ticket="${esc(p.ticket)}"${lock ? ' disabled' : ''}>แก้</button> <button class="pclose" data-ticket="${esc(p.ticket)}"${lock ? ' disabled' : ''}>${isClosing(p.ticket) ? 'กำลังปิด…' : 'ปิด'}</button></div></td>
    </tr>`;
    }).join('');
  // กันทุน / ปิดครึ่ง — aria-disabled = แจ้งเหตุผล ไม่ส่งอะไร
  box.querySelectorAll('.pact').forEach((b) => b.addEventListener('click', () => {
    if (b.getAttribute('aria-disabled') === 'true') { toast(b.dataset.why || b.title || 'ใช้ไม่ได้ตอนนี้', b.classList.contains('is-done') ? 'ok' : 'err'); return; }
    const p = list.find((x) => Number(x.ticket) === Number(b.dataset.ticket));
    if (!p) return;
    if (b.classList.contains('pbe')) breakEvenNow(p, m); else closeHalfNow(p, m);
  }));
  // ปิดรายไม้: ยืนยันก่อนส่ง (ปุ่มเล็ก กดพลาดง่ายบนมือถือ)
  box.querySelectorAll('.pclose:not(.pedit)').forEach((b) => b.addEventListener('click', () => {
    const p = list.find((x) => Number(x.ticket) === Number(b.dataset.ticket));
    const pl = p && Number.isFinite(Number(p.profit)) ? ` • ลอยตัว ${money(Number(p.profit), acctCur)}` : '';
    const what = p ? `${String(p.type).toUpperCase()} ${fmtD(Number(p.volume), 2)} ล็อต @ ${fmtD(Number(p.open), 2)}${pl}` : '';
    if (!confirm(`ปิดไม้ #${b.dataset.ticket} ที่ราคาตลาดตอนนี้?\n${what}`)) return;
    closeNow([Number(b.dataset.ticket)]);
  }));
  box.querySelectorAll('.pedit').forEach((b) => b.addEventListener('click', () => startEdit(list.find((p) => Number(p.ticket) === Number(b.dataset.ticket)))));
}

function startEdit(p) {
  if (!p) return;
  const row = $('positions').querySelector(`tr[data-row="${CSS.escape(String(p.ticket))}"]`);
  if (!row) return;
  editingTicket = Number(p.ticket);
  const val = (n) => (Number(n) ? Number(n).toFixed(2) : '');
  row.querySelector('.c-sl').innerHTML = `<input class="pin" type="number" inputmode="decimal" step="0.01" data-k="sl" value="${val(p.sl)}" placeholder="SL">`;
  row.querySelector('.c-tp').innerHTML = `<input class="pin" type="number" inputmode="decimal" step="0.01" data-k="tp" value="${val(p.tp)}" placeholder="TP (ว่าง = ไม่มี)">`;
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
      let r = await window.api.modifyPosition({ ticket: p.ticket, sl, tp });
      if (!r.ok && r.overCap && confirm(`${r.reason}\n\nยืนยันแก้ SL/TP ไม้ #${p.ticket} ทั้งที่เกินเพดาน?`)) r = await window.api.modifyPosition({ ticket: p.ticket, sl, tp, allowOverCap: true });
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
  // ราคาเดียวกับที่ใช้คิด SL/TP ตอนกด (req.px จาก stopsFor) — ล็อกไว้ตั้งแต่เปิดหน้านี้ ตัวเลขที่เห็น = ที่ส่ง
  const lq = liveQuote();
  const entry = Number.isFinite(req.px) ? req.px : lq ? (buy ? lq.ask : lq.bid) : (buy ? meta.ask : meta.bid);
  const sl = Number(req.sl), tp = Number(req.tp) || 0, lot = Number(req.lot);
  const slDist = Math.abs(entry - sl);
  const oz = (meta.spec && meta.spec.contractSize) || 100;
  const riskUSD = lot * slDist * oz;
  // เพดานปุ่มกดเอง (manualRiskMaxPct) — เตือนก่อนกด + ปุ่มส่งจริงปิดตายเมื่อเกิน (ฝั่ง main ปฏิเสธอยู่แล้ว ผู้ใช้รู้ตั้งแต่หน้านี้)
  const acct = meta.account;
  const capEq = acct && acct.equityUSD > 0 ? acct.equityUSD : Number(lastSnap && lastSnap.risk && lastSnap.risk.equity) || 0;
  const capPctC = Math.max(2, Math.min(100, Number((lastSnap && lastSnap.risk && lastSnap.risk.manualRiskMaxPct) || (appSettings && appSettings.manualRiskMaxPct)) || 2));
  const cap = capEq * capPctC / 100;
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
    ${overCap ? `<div class="mwarn">⚠ เสี่ยง $${fmtD(riskUSD, 2)} = ${fmtD(capEq > 0 ? riskUSD / capEq * 100 : 0, 1)}% ของทุน — เกินเพดานกลาง (${fmtD(capPctC, 1)}% = $${fmtD(cap, 2)}) — ส่งได้ถ้าคุณยืนยัน</div>` : ''}
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
  // เกินเพดานกลาง = ปุ่มยังกดได้ (ผู้ใช้ยืนยันเอง) — เกตจริงอยู่ฝั่ง main (เพดานของผู้ใช้)
  if (overCap) $('m-go').textContent = 'ส่งแม้เกินเพดาน (ยืนยันเอง)';
  $('m-go').addEventListener('click', async () => {
    $('m-go').disabled = true;
    $('m-go').textContent = 'กำลังส่ง...';
    try {
      let r = await window.api.sendOrder({ side: buy ? 'buy' : 'sell', lot, sl, tp });
      if (!r.ok && r.overCap) {
        if (confirm(`เสี่ยง $${fmtD(riskUSD, 2)} เกินเพดานปุ่มกด (${fmtD(capPctC, 1)}% = $${fmtD(cap, 2)})\n\nส่งไม้จริงทั้งที่เกินเพดาน — ยืนยันเอง?`)) {
          r = await window.api.sendOrder({ side: buy ? 'buy' : 'sell', lot, sl, tp, allowOverCap: true });
        }
      }
      if (r.ok) {
        closeModal();
        toast(`📤 ส่งคำสั่งแล้ว (id ${r.id}) — รอผลจาก MT5...`, 'ok');
        setTimeout(() => window.api.refreshNow(), 1500);
      } else {
        if (!$('m-err').textContent) $('m-err').textContent = '✗ ' + (r.reason || 'ส่งไม่ได้');
        $('m-go').disabled = false;
        $('m-go').textContent = overCap ? 'ส่งแม้เกินเพดาน (ยืนยันเอง)' : goTxt;
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
  // ช่องคู่บาท/จุด: อัปเดตคู่จากค่าบาทที่จัดเก็บทุกทิค
  acSyncInputs();
  // สรุปบนหัว: เปิดอยู่กี่ตัว
  const ids = ['ac-all', 'ac-allpts', 'ac-pts', 'ac-loss', 'ac-lossonly'];
  const nOn = ids.filter((id) => $(id).checked).length;
  $('ac-active').textContent = nOn ? `เปิดอยู่ ${nOn}/5` : 'ยังไม่เปิดใช้';
  $('ac-active').classList.toggle('on', nOn > 0);
  // ความคืบหน้าถึงเป้า (แถบ + ตัวเลขตอนนี้/เป้า — เป้าทั้งหมดจัดเก็บเป็นบาท)
  const bar = (id, now, target, fmt) => {
    const pct = target > 0 && now > 0 ? Math.min(100, (now / target) * 100) : 0;
    $(id + '-bar').style.width = pct + '%';
    $(id + '-now').textContent = now == null ? '—' : `${fmt(now)} / ${fmt(target)}`;
  };
  const bid = meta && Number(meta.bid), ask = meta && Number(meta.ask);
  const live = list.length && Number.isFinite(bid) && Number.isFinite(ask);
  const total = list.reduce((s, p) => s + (Number(p.profit) || 0), 0);
  const best = live ? Math.max(...list.map((p) => Number(p.profit) || 0)) : null;
  const m = (x) => `${x >= 0 ? '+' : ''}${fmtD(x, 2)}`;
  bar('ac-all', list.length ? total : null, appSettings ? Number(appSettings.autoCloseAllProfit) || 0 : 0, m);
  bar('ac-allpts', list.length ? total : null, appSettings ? Number(appSettings.autoCloseAllPtsValue) || 0 : 0, m);
  bar('ac-pts', live ? best : null, appSettings ? Number(appSettings.autoClosePointsValue) || 0 : 0, m);
  // ตัดขาดทุน: เทียบขนาดขาดทุน (บวก) กับเพดาน
  const loss = list.length ? Math.max(0, -total) : null;
  const lossTarget = appSettings ? Number(appSettings.autoCloseLossValue) || 0 : 0;
  const lossOnlyTarget = appSettings ? Number(appSettings.autoCloseLosingOnlyValue) || 0 : 0;
  $('ac-loss-bar').style.width = (loss && lossTarget > 0 ? Math.min(100, (loss / lossTarget) * 100) : 0) + '%';
  $('ac-loss-now').textContent = loss == null ? '—' : `ขาดทุน ${fmtD(loss, 2)} / ${fmtD(lossTarget, 2)} บาท`;
  // ตัดขาดทุนเฉพาะไม้แดง: แถบเดียวกัน — แสดงครบเมื่อไม้เปิด + สรุปกี่ไม้แดงที่จะถูกปิดเมื่อทำงาน
  const lossOnlyEl = $('ac-lossonly-bar');
  if (lossOnlyEl) {
    lossOnlyEl.style.width = (loss && lossOnlyTarget > 0 ? Math.min(100, (loss / lossOnlyTarget) * 100) : 0) + '%';
    const nowEl = $('ac-lossonly-now');
    const sumLoss = list.reduce((s, p) => s + (Number(p.profit) < 0 ? Number(p.profit) : 0), 0);
    const nRed = list.filter((p) => Number(p.profit) < 0).length;
    if (nowEl) nowEl.textContent = loss == null ? '—' : `แดง ${nRed} ไม้ • ลอยตัว ${fmtD(sumLoss, 2)} / ตั้ง ${fmtD(lossOnlyTarget, 2)} บาท`;
  }
  $('ac-status').textContent = list.length
    ? `ไม้ที่เปิด ${list.length} ไม้ • กำไรรวม ${money(total, acctCur, true)}${best != null ? ` • กำไรรายไม้สูงสุด ${money(best, acctCur, true)}` : ''}`
    : 'ไม่มีไม้ที่เปิดอยู่ — ตั้งเป้าไว้ก่อนได้ ระบบจะเริ่มดูเมื่อมีไม้';
}

async function saveAutoClose(partial, okMsg) {
  try {
    const clean = await window.api.saveSettings(partial);
    if (appSettings) Object.assign(appSettings, clean);
    if (okMsg) toast(okMsg, 'ok');
    return clean;
  } catch (err) { toast('บันทึกไม่สำเร็จ: ' + err.message, 'err'); return null; }
}
// ---------- เป้าปิดอัตโนมัติ: ช่องคู่บาท↔จุด (MT5-style) — แก้ช่องไหนอีกช่องแปลงให้ • เกตบันทึกจริง = บาท ----------
// ค่า จุด → บาท: จุด × ขนาดจุด (10^-digits) × oz/ล็อต × ล็อตใช้งาน × อัตราแลกบาท
function acMoneyPerPoint() {
  const meta = (lastSnap && lastSnap.meta) || {};
  const point = Math.pow(10, -(Number(meta.digits) || 2));
  const oz = ((appSettings && Number(appSettings.ozPerLot)) || (meta.spec && meta.spec.contractSize) || 100);
  const positions = (meta && meta.positions) || [];
  const lots = [...new Set(positions.map((p) => Number(p.volume)).filter((v) => v > 0))];
  const lot = lots.length === 1 ? lots[0] : (Number($('t-lot').value) || 0.01);
  const acct = meta.account || null;
  const fx = acct && acct.equityUSD > 0 && acct.equity > 0 ? acct.equity / acct.equityUSD : 1;
  return { per: point * oz * lot * fx, lot };
}
function acPtsToMoney(pts) {
  const meta = (lastSnap && lastSnap.meta) || {};
  const point = Math.pow(10, -(Number(meta.digits) || 2));
  const oz = ((appSettings && Number(appSettings.ozPerLot)) || (meta.spec && meta.spec.contractSize) || 100);
  const lots = [...new Set(((meta && meta.positions) || []).map((p) => Number(p.volume)).filter((v) => v > 0))];
  const lot = lots.length === 1 ? lots[0] : (Number($('t-lot').value) || 0.01);
  const acct = meta.account || null;
  const fx = acct && acct.equityUSD > 0 && acct.equity > 0 ? acct.equity / acct.equityUSD : 1;
  return pts * point * oz * lot * fx;
}
const AC_ROWS = [
  { sw: 'ac-all', th: 'ac-all-th', p: 'ac-all-p', key: 'autoCloseAll', valKey: 'autoCloseAllProfit', label: 'ปิดรวบ' },
  { sw: 'ac-allpts', th: 'ac-allpts-th', p: 'ac-allpts-p', key: 'autoCloseAllPts', valKey: 'autoCloseAllPtsValue', label: 'ปิดรวบ (เป้าที่สอง)' },
  { sw: 'ac-pts', th: 'ac-pts-th', p: 'ac-pts-p', key: 'autoClosePoints', valKey: 'autoClosePointsValue', label: 'ปิดเฉพาะไม้บวก' },
  { sw: 'ac-loss', th: 'ac-loss-th', p: 'ac-loss-p', key: 'autoCloseLoss', valKey: 'autoCloseLossValue', label: 'ตัดขาดทุนรวบ' },
  { sw: 'ac-lossonly', th: 'ac-lossonly-th', p: 'ac-lossonly-p', key: 'autoCloseLosingOnly', valKey: 'autoCloseLosingOnlyValue', label: 'ตัดขาดทุนเฉพาะไม้แดง' },
];
// sync คู่ช่องทั้งหมดจากค่าบาทที่จัดเก็บ — ช่องที่กำลังพิมพ์ = เว้น (ไม่แย่งคีย์บอร์ด)
function acSyncInputs() {
  const per = acMoneyPerPoint().per || 0;
  for (const row of AC_ROWS) {
    const thb = appSettings ? Number(appSettings[row.valKey]) || 0 : 0;
    const th = $(row.th), pi = $(row.p);
    if (th && document.activeElement !== th) th.value = thb ? Math.round(thb) : '';
    if (pi && document.activeElement !== pi) pi.value = thb && per ? Math.round(thb / per) : '';
  }
}
function bindAutoClose(row) {
  const { sw, th, p, key, valKey: vk, label } = row;
  const per = () => acMoneyPerPoint().per || 0;
  const save = async (thb) => { const r = await saveAutoClose({ [vk]: Math.max(0, Math.round((thb || 0) * 100) / 100) }); acSyncInputs(); return r; };
  const commit = async (srcId) => {
    const raw = Number($(srcId).value);
    const thb = srcId === th ? raw : acPtsToMoney(raw);
    if (!Number.isFinite(thb) || thb <= 0) { toast(`ใส่${label}ก่อน (>0) — บาท หรือ จุด ก็ได้`, 'err'); $(sw).checked = false; acSyncInputs(); return; }
    $(sw).checked = true;
    const r = await save(thb);
    if (r) toast(`🔒 ${label}: ${thb.toFixed(2)} บาท (≈ ${Math.round((thb / (per() || 1)) * 10) / 10} จุด / 0.01 ล็อต)`, 'ok');
  };
  $(th).addEventListener('change', () => commit(th));
  $(p).addEventListener('change', () => commit(p));
  $(sw).addEventListener('change', async (e) => {
    const on = e.target.checked;
    const cur = appSettings ? Number(appSettings[vk]) || 0 : ($(th).value ? Number($(th).value) : 0);
    if (on && !(cur > 0)) { e.target.checked = false; toast(`ตั้ง${label}ที่ช่องบาท/จุดก่อน (>0)`, 'err'); return; }
    if (on && !confirm(`เปิด${label}อัตโนมัติ?\n\nเป้าปัจจุบัน ${cur.toFixed(2)} บาท (≈ ${Math.round((cur / (per() || 1)) * 10) / 10} จุด)\nถึงเป้า = ส่งคำสั่งปิดจริงใน MT5 ทันที (ไม่ถามซ้ำ) • แอป + MT5 ควรเปิดไว้`)) { e.target.checked = false; return; }
    await save(cur);
  });
}
bindAutoClose(AC_ROWS[0]); bindAutoClose(AC_ROWS[1]); bindAutoClose(AC_ROWS[2]); bindAutoClose(AC_ROWS[3]); bindAutoClose(AC_ROWS[4]);
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
  openConfirm({ action: side, side, lot, sl, tp: Number.isFinite(tp) ? tp : 0, px: st.px });
}

// รหัสข้อผิดพลาดจาก EA (msg=...) → ข้อความไทย • รหัสอื่นแสดงตามเดิม
const EA_ERR_TH = {
  HEDGING_ONLY: 'ปิดครึ่งได้เฉพาะบัญชีแบบ hedging — บัญชีนี้เป็น netting',
  REMAIN_BELOW_MIN: 'ล็อตที่เหลือต่ำกว่าขั้นต่ำโบรก',
  LOT_BELOW_MIN: 'ล็อตที่จะปิดต่ำกว่าขั้นต่ำโบรก',
  POSITION_NOT_FOUND: 'ไม่พบไม้นี้ใน MT5 แล้ว',
};
const eaErrTh = (msg) => EA_ERR_TH[String(msg || '').trim()] || msg;
window.api.onOrderResult((r) => {
  const isClose = r.cmd && r.cmd.action === 'close';
  const isPart = r.cmd && r.cmd.action === 'closepart';
  const isModify = r.cmd && (r.cmd.action === 'modify' || r.cmd.action === 'pmodify');
  const pxTxt = Number.isFinite(r.price) && r.price ? ' @ ' + r.price.toFixed(2) : '';
  if (isClose && r.status !== 'ok') { closingTickets.delete(Number(r.cmd.ticket)); if (lastSnap) renderPositions(lastSnap.meta); }
  // กันทุน/ปิดครึ่งที่ MT5 ไม่รับ = ปลดล็อกปุ่มแถวนั้นทันที (สำเร็จ = รอ snapshot เห็นผลค่อยปลด กันกดซ้ำด้วยล็อตเก่า)
  if (r.cmd && r.status !== 'ok' && rowBusy.delete(Number(r.cmd.ticket)) && lastSnap) renderPositions(lastSnap.meta);
  toast(r.status === 'ok'
    ? isModify ? `✅ แก้${r.cmd.action === 'pmodify' ? 'คำสั่งรอ' : ' SL/TP ไม้'} #${r.cmd.ticket} แล้ว`
    : isClose ? `✅ ปิดไม้ #${r.ticket} แล้ว${pxTxt}`
    : isPart ? `✂️ ปิดบางส่วนไม้ #${r.cmd.ticket} แล้ว (${fmtD(Number(r.cmd.lot), 2)} ล็อต${pxTxt})`
    : `✅ MT5 รับไม้แล้ว — ticket ${r.ticket}${pxTxt}`
    : r.status === 'stale'
    ? `⏳ ${r.msg}`
    : isPart ? `❌ ปิดครึ่งไม้ #${r.cmd.ticket} ไม่ได้: ${eaErrTh(r.msg)} (retcode ${r.retcode})`
    : `❌ MT5 ปฏิเสธ: ${eaErrTh(r.msg)} (retcode ${r.retcode})`, r.status === 'ok' ? 'ok' : r.status === 'stale' ? '' : 'err');
  if (r.status === 'ok') setTimeout(() => window.api.refreshNow(), 800);
});

// ---------- เลนเรียลไทม์ (ราคาวิ่งทุก ~1 วิ เหมือน MT5) ----------
// ทิคมาได้ถึง ~10 ครั้ง/วิ → วาดรวบเป็นเฟรมเดียว (ใช้ทิคล่าสุดเสมอ) แบ่ง 2 ชั้น:
//   ชั้นเร็ว (ราคา/bid/ask/ทุนสด) ≤ 4 ครั้ง/วิ • ชั้นหนัก (วาดชาร์ตใหม่ + บันไดราคา + ระยะจุดรอ) ≤ 1 ครั้ง/วิ
// วัดจริง: วาดทุกทิคกิน CPU renderer+GPU ~35% ตอนตลาดวิ่ง • หน้าต่างถูกซ่อน = rAF ไม่ทำงาน = ไม่วาดเลย
let pendingTick = null, tickTimer = 0, lastTickPaint = 0, lastHeavyPaint = 0;
const TICK_PAINT_MS = 100, HEAVY_PAINT_MS = 500;   // วาดราคาเร็วสุด 10 ครั้ง/วิ + กลุ่มอื่น 2 ครั้ง/วิ
window.api.onTick((q) => {
  if (!q || !Number.isFinite(q.bid)) return;
  pendingTick = q;
  if (tickTimer) return;
  const wait = Math.max(0, TICK_PAINT_MS - (performance.now() - lastTickPaint));
  tickTimer = setTimeout(() => requestAnimationFrame(() => {
    tickTimer = 0;
    lastTickPaint = performance.now();
    const latest = pendingTick;
    pendingTick = null;
    if (latest) paintTick(latest);
  }), wait);
});
// กระพริบตัวเลขตามทิศ (เหมือน MT5) — สลับ class ค้างไว้สั้นๆ ไม่ interpolate ทุกเฟรม (ดู .flash-up ใน styles.css)
const FLASH_MS = 350;
function paintTick(q) {
  const d = q.digits || 2;
  // แท่งสุดท้ายหายใจสด: อัปเดตเฉพาะแท่งเดียวด้วย update() — ไม่ยิง setData ทั้งก้อน (สเกล/ซูมคงเดิม)
  try {
    if (chartM && candleSeries && lastBarLive && chartBars.length && chartBars[chartBars.length - 1].time === lastBarLive.t) {
      const px = (q.bid + q.ask) / 2;
      if (px > 0) {
        lastBarLive.c = px;
        if (px > lastBarLive.h) lastBarLive.h = px;
        if (px < lastBarLive.l) lastBarLive.l = px;
        candleSeries.update({ time: lastBarLive.t, open: lastBarLive.o, high: lastBarLive.h, low: lastBarLive.l, close: lastBarLive.c });
      }
    }
  } catch { void 0; }
  const bidEl = $('t-bid'), askEl = $('t-ask'), priceEl = $('price');
  const oldBid = bidEl._v, oldAsk = askEl._v;
  bidEl.textContent = q.bid.toFixed(d);
  askEl.textContent = q.ask.toFixed(d);
  bidEl._v = q.bid; askEl._v = q.ask; bidEl._at = Date.now();
  // สเปรดเป็นจุด (ASK − BID) / จุด = 10^-digits — เขียนเฉพาะเมื่อค่าเปลี่ยน
  const spEl = $('t-spread');
  if (spEl && Number.isFinite(q.ask)) { const sp = String(Math.round((q.ask - q.bid) * Math.pow(10, d))); if (spEl.textContent !== sp) spEl.textContent = sp; }
  // ตัวเลขกระพริบตามทิศ (เหมือน MT5) — 1 timer ต่อช่อง ทิคใหม่ล้าง timer เก่า
  const blink = (el, now, before) => {
    if (!Number.isFinite(before) || now === before) return;
    el.classList.toggle('flash-up', now > before);
    el.classList.toggle('flash-down', now < before);
    clearTimeout(el._flashT);
    el._flashT = setTimeout(() => el.classList.remove('flash-up', 'flash-down'), FLASH_MS);
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
  // แท่งสุดท้าย: จด high/low/close ทุกทิค (ไม่พลาดไส้เทียน) — แต่วาดชาร์ตใหม่ในชั้นหนัก
  if (chartBars.length && candleSeries) {
    const i = chartBars.length - 1, last = chartBars[i];
    chartBars[i] = { ...last, high: Math.max(last.high, q.bid), low: Math.min(last.low, q.bid), close: q.bid };
  }
  lastTickQ = q;
  const since = performance.now() - lastHeavyPaint;
  if (since >= HEAVY_PAINT_MS) paintHeavy();
  else if (!heavyTimer) heavyTimer = setTimeout(paintHeavy, HEAVY_PAINT_MS - since); // ทิคสุดท้ายก่อนตลาดเงียบยังถูกวาด
}
// ชั้นหนัก ≤ 1 ครั้ง/วิ: วาดแท่งล่าสุดบนชาร์ต + ระยะจุดรอเข้า + บันไดราคา ด้วยทิคล่าสุด
let lastTickQ = null, heavyTimer = 0;
function paintHeavy() {
  heavyTimer = 0;
  lastHeavyPaint = performance.now();
  const q = lastTickQ;
  if (!q) return;
  if (chartBars.length && candleSeries) { try { candleSeries.update(chartBars[chartBars.length - 1]); } catch { void 0; } }
  if (lastSnap && lastSnap.entryPlan) renderEntryPlan(lastSnap, q.bid);
  if (lastSnap) renderLadder(lastSnap, q.bid);
}

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
// ---------- memo ผล render: ข้อมูลเดิมซ้ำกัน (ราคาไม่เปลี่ยน/ข้อมูลยังเดิม) = กระโดน HTML ซ้ำ ----------
// ชาร์ตวาดเองทุกทิค — ที่เหลือใช้ key ต่อการ์ด เทียบก่อนเขียน innerHTML (ลด GC + หน้าจอไม่กระพริบ)
const renderMemo = {};
const memoHtml = (name, key, html) => {
  if (renderMemo[name] === key && renderMemo[name + ':html'] === html) return false;
  renderMemo[name] = key; renderMemo[name + ':html'] = html;
  return true;
};
const renderOnce = (name, key, box, html) => { if (box && memoHtml(name, key, html)) box.innerHTML = html; };

// กันเหนียว render ซ้ำ: zone มีราคาลอยตัวสด → key รวม bid/ask เพื่อวาดเมื่อมีอะไรเปลี่ยนจริง (ชื่อ zoneRendersKey — zoneKey ถูกใช้โดยวาดเส้นกราฟ)
function zoneRendersKey(snap) {
  const m = snap.meta || {};
  return `${(snap.zoneHistory || []).length}|${(snap.zoneOpen || []).length}|${(snap.roundLog || []).length}|${m.bid}|${m.ask}`;
}
function renderZoneHistory(snap) {
  const html = zoneHistoryHtml(snap);
  renderOnce('zone', zoneRendersKey(snap), $('zonehist'), html);
  renderOnce('zoneMini', zoneRendersKey(snap), $('zonehist-mini'), html);
}
function zoneHistoryHtml(snap) {
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
    const cTxt = (t) => { const c = t.councilAtOpen; if (!c) return ''; 
      // ตัดสินเหมือน gateSignal จริง: สภามีทิศตรงกับไม้ = ผ่านด่านมติ (conf แค่ตัดสินตัวกรองสวน — ≥55% ยับ) • ไม่มีมติ/สวน = ไม่ผ่าน
      const verdictSide = c.side;
      if (verdictSide === 'none') return `<span class="zcouncil none">สภา: ไม่มีมติ ${c.confidence}%${c.net != null ? ` (เอน ${c.net > 0 ? 'ซื้อ' : 'ขาย'} ${Math.abs(c.net)})` : ''} → ไม้จริงโหมดเข้มไม่ผ่าน (ต้องมีมติก่อน)</span>`;
      if (verdictSide !== t.side) return `<span class="zcouncil none">สภา: ${verdictSide === 'buy' ? 'ซื้อ' : 'ขาย'} ${c.confidence}% — <b>สวนไม้</b> → ไม้จริงไม่ผ่าน (สภายับอีกฝั่ง)</span>`;
      return `<span class="zcouncil ${c.side}">สภา ณ เปิดไม้: ${c.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${c.confidence}% • เห็นพ้อง ${c.agree}${c.quorumNeed ? `/${c.quorumNeed}+` : ''} → ✅ ผ่านมติ (ฝั่งตรงกัน — ผ่านเกตความเสี่ยงต่อได้)</span>`; };
    const lines = [
      ...openRows.map((t) => `<div class="zh-line"><span class="t">เปิดอยู่</span><span>${t.side === 'buy' ? 'BUY' : 'SELL'} ${fmtD(t.entry, 2)} • SL ${fmtD(t.sl, 2)} • TP ${fmtD(t.tp, 2)}</span>${(() => { const l = liveOf(t); return l ? `<span class="res open ${l.pnl >= 0 ? 'up' : 'down'}">${l.pnl >= 0 ? '+' : '-'}$${fmtD(Math.abs(l.pnl), 2)} (${l.pts >= 0 ? '+' : ''}${Math.round(l.pts)} จุด)</span>` : '<span class="res open">เปิด</span>'; })()}${cTxt(t)}</div>`),
      ...rows.map((t) => `<div class="zh-line"><span class="t">${fmtTs(t.closedAt || t.openedAt)}</span><span>${t.side === 'buy' ? 'BUY' : 'SELL'} ${fmtD(t.entry, 2)} → ${fmtD(t.exit != null ? t.exit : 0, 2)}</span><span class="res ${t.status || ''}">${t.status || '-'} ${t.pnl != null ? (t.pnl >= 0 ? '+' : '') + fmtD(t.pnl, 2) : ''}</span>${cTxt(t)}</div>`),
    ];
    return `<div class="zh-side ${side}"><h5>${side === 'buy' ? 'ไม้จำลองซื้อ (BUY)' : 'ไม้จำลองขาย (SELL)'}</h5>
      <div class="zh-score">${score}</div>
      <div class="zh-rows">${lines.length ? lines.join('') : '<div class="empty sm">ยังไม่มี — ราคาแตะจุดรอเข้าฝั่งนี้แล้วจะเริ่มจด</div>'}</div></div>`;
  };
  const rounds = (snap.roundLog || []).slice(-12).reverse().map((r) =>
    `<div class="zh-line"><span class="t">${fmtTs(r.ts)}</span><span class="zact">${esc(r.action)}</span></div><div class="zdetail">${esc(r.detail)}</div>`).join('');
  return renderSide('sell') + renderSide('buy') +
    `<div class="zh-side zh-rounds"><h5>ประวัติรอบ — ลงไม้ไหน <button class="zh-all" data-open-history title="เปิดหน้าต่างใหม่ ดูประวัติรอบทั้งหมด">ดูทั้งหมด ↗</button></h5><div class="zh-rows roundlines">${rounds || '<div class="empty sm">ยังไม่มีรอบที่เปลี่ยนสถานะ</div>'}</div></div>`;
}

// ปุ่ม "ดูทั้งหมด" อยู่ในกล่องที่วาดใหม่ทุกรอบ → ผูกที่ document ครั้งเดียว
document.addEventListener('click', (e) => { if (e.target.closest('[data-open-history]')) window.api.openHistoryWindow(); });

/* ---------- แผงระยะไกล (เว็บควบคุมเต็ม) — ตั้งค่าได้เฉพาะในแอปบนเครื่อง ---------- */
// label ไม่ส่ง = คัดลอกลิงก์ (ข้อความเดิม) • ส่ง label (เช่น 'Bid', 'SL') = คัดลอกราคา ทอสต์สั้นลง
async function copyText(u, label) {
  try { await navigator.clipboard.writeText(u); }
  catch {
    const t = document.createElement('textarea');
    t.value = u; t.style.position = 'fixed'; t.style.opacity = '0';
    document.body.appendChild(t); t.select(); t.setSelectionRange(0, 99999); document.execCommand('copy'); t.remove();
  }
  if (label === undefined) toast('📋 คัดลอกลิงก์แล้ว: ' + u, 'ok');
  else toast(`📋 คัดลอกแล้ว: ${label ? label + ' ' : ''}${u}`, 'ok', 2500);
}
// แถวลิงก์: ชื่อช่องทาง + ที่อยู่ + ปุ่มคัดลอก/เปิด
const linkRow = (kind, u, main = false) => `<div class="wc-link${main ? ' main' : ''}">
  <span class="k">${esc(kind)}</span><span class="u" title="${esc(u)}">${esc(u)}</span>
  <button class="wc-btn sm" data-wc-copy="${esc(u)}">คัดลอก</button><button class="wc-btn sm" data-wc-open="${esc(u)}">เปิด</button></div>`;
const WC_HIDE_KEY = 'gs.webctl.hidden';
function setWcHidden(hide) {
  $('wc-body').hidden = hide;
  $('wc-toggle').textContent = hide ? 'แสดง ▾' : 'ซ่อน ▴';
  $('wc-toggle').setAttribute('aria-expanded', String(!hide));
  try { localStorage.setItem(WC_HIDE_KEY, hide ? '1' : '0'); } catch { void 0; }
}
async function renderWebCtl() {
  const card = $('webctl-card');
  if (!card) return;
  if (window.GS_WEB) { card.hidden = true; return; }
  let w;
  try { w = await window.api.webAccessGet(); } catch { return; }
  const t = w.tunnel || {};
  // สรุปย่อบนหัวการ์ด (เห็นแม้ซ่อนแผง)
  const chips = [];
  chips.push(`<span class="wc-chip ${w.hasPassword ? 'on' : 'err'}">${w.hasPassword ? '🔑 ตั้งรหัสแล้ว' : '🔑 ยังไม่ตั้งรหัส'}</span>`);
  chips.push(`<span class="wc-chip ${w.remote ? 'on' : ''}">${w.remote ? 'เข้าจากนอกเครื่องได้' : 'เฉพาะเครื่องนี้'}</span>`);
  chips.push(`<span class="wc-chip ${t.state === 'on' ? 'on' : t.state === 'error' ? 'err' : ''}">${t.state === 'on' ? '🟢 tunnel ' + esc(t.provider) : t.state === 'starting' ? '⏳ tunnel' : t.state === 'error' ? '🔴 tunnel' : 'tunnel ปิด'}</span>`);
  if (w.pagesUrl) chips.push(`<button class="wc-btn sm" data-wc-copy="${esc(w.pagesUrl)}" title="${esc(w.pagesUrl)}">📋 ลิงก์ถาวร</button>`);
  $('wc-summary').innerHTML = chips.join('');

  $('wc-pw-st').textContent = w.hasPassword ? '✓ ตั้งรหัสแล้ว — เปลี่ยนได้ (ทุกเครื่องจะถูกออกจากระบบ)' : 'ยังไม่ได้ตั้งรหัส — หน้าเว็บยังเข้าไม่ได้';
  $('wc-remote').checked = !!w.remote;
  const addrs = [];
  if (w.localUrl) addrs.push(linkRow('เครื่องนี้', w.localUrl));
  for (const a of w.addresses || []) addrs.push(linkRow(a.kind, a.url));
  if (!w.remote) addrs.push('<div class="wc-empty">เปิดสวิตช์ด้านบนเพื่อให้มือถือ/เครื่องอื่นเข้าได้</div>');
  else if (!(w.addresses || []).length) addrs.push('<div class="wc-empty">ไม่พบเครือข่าย — ต่อ Wi-Fi หรือเปิด Tailscale</div>');
  $('wc-addrs').innerHTML = addrs.join('');

  const av = w.tunnelAvailable || {};
  for (const o of $('wc-prov').options) o.disabled = !av[o.value];
  if (t.provider && document.activeElement !== $('wc-prov')) $('wc-prov').value = t.provider;
  $('wc-tun-st').innerHTML = t.state === 'on' ? linkRow(`🟢 tunnel ${t.provider} (เปลี่ยนเมื่อเปิดใหม่ — ใช้ลิงก์ถาวรด้านล่างแทนได้)`, t.url)
    : t.state === 'starting' ? `<div class="wc-empty">⏳ กำลังเปิด ${esc(t.provider)}…</div>`
    : t.state === 'error' ? `<div class="wc-empty err">🔴 ${esc(t.msg || 'เปิดไม่ได้')}</div>` : '<div class="wc-empty">tunnel ปิดอยู่</div>';

  if (document.activeElement !== $('wc-repo') && w.pagesRepo) $('wc-repo').value = w.pagesRepo;
  $('wc-pages-st').innerHTML = !w.ghAvailable ? '<div class="wc-empty err">ต้องติดตั้ง GitHub CLI ก่อน: brew install gh แล้ว gh auth login</div>'
    : w.pagesUrl ? linkRow('⭐ ลิงก์ถาวร — ส่งลิงก์นี้ไว้ในมือถือ (อัปเดตที่อยู่ tunnel ให้เอง ~1 นาที)', w.pagesUrl, true)
    : '<div class="wc-empty">ยังไม่ได้ตั้ง</div>';
  $('wc-sess').textContent = `เครื่องที่ล็อกอินเว็บอยู่: ${w.sessions}`;
}
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-wc-copy]');
  if (c) { copyText(c.dataset.wcCopy); return; }
  const o = e.target.closest('[data-wc-open]');
  if (o) window.open(o.dataset.wcOpen, '_blank');
});
if ($('webctl-card') && !window.GS_WEB) {
  let hidden = false;
  try { hidden = localStorage.getItem(WC_HIDE_KEY) === '1'; } catch { void 0; }
  setWcHidden(hidden);
  $('wc-toggle').addEventListener('click', () => setWcHidden(!$('wc-body').hidden));
  const wrap = (fn) => async () => { try { await fn(); } catch (err) { toast('✗ ' + err.message, 'err'); } renderWebCtl(); };
  $('wc-pw-save').addEventListener('click', wrap(async () => {
    const pw = $('wc-pw').value;
    if (pw.length < 8) throw new Error('รหัสต้องยาวอย่างน้อย 8 ตัวอักษร');
    await window.api.webAccessSet({ password: pw });
    $('wc-pw').value = '';
    toast('🔑 บันทึกรหัสเว็บแล้ว', 'ok');
  }));
  $('wc-pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('wc-pw-save').click(); });
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
  // ตัวเฝ้าแผงระยะไกล: ข้ามเมื่อจอซ่อน/อยู่แท็บอื่น/แผงย่อแล้ว (ลด IPC + เรนเดอร์จอหลัก) — กลับมาโชว์วาดทันที
  setInterval(() => {
    if (document.hidden) return;
    const pane = $('wc-body');
    if (pane && pane.hidden) return;
    if ($('tab-mt5') && !$('tab-mt5').classList.contains('active')) return;
    renderWebCtl();
  }, 5000);
}

/* ---------- แจ้งเตือน Telegram (ตั้งค่าได้เฉพาะในแอปบนเครื่อง) ---------- */
async function renderTg() {
  const card = $('tg-card');
  if (!card) return;
  if (window.GS_WEB) { card.hidden = true; return; }
  let v;
  try { v = await window.api.tgGet(); } catch { return; }
  $('tg-on').checked = !!v.enabled;
  const nEv = Object.values(v.events).filter((e) => e.on).length;
  $('tg-summary').innerHTML = [
    `<span class="wc-chip ${v.enabled ? 'on' : 'err'}">${v.enabled ? '🔔 แจ้งเตือนเปิด' : '🔕 ปิดอยู่'}</span>`,
    `<span class="wc-chip ${v.tokenSet && v.chatId ? 'on' : ''}">${v.tokenSet && v.chatId ? 'เชื่อม bot แล้ว' : 'ยังไม่เชื่อม bot'}</span>`,
    `<span class="wc-chip">${nEv} เรื่อง</span>`,
  ].join('');
  $('tg-token-st').textContent = v.tokenSet ? `✓ ตั้งแล้ว (${v.tokenHint})` : 'ยังไม่ได้ใส่ token';
  if (document.activeElement !== $('tg-chat')) $('tg-chat').value = v.chatId || '';
  $('tg-events').innerHTML = Object.entries(v.events).map(([k, e]) => `<label><input type="checkbox" data-tg-ev="${esc(k)}"${e.on ? ' checked' : ''} />${esc(e.label)}</label>`).join('');
}
if ($('tg-card') && !window.GS_WEB) {
  const TG_HIDE = 'gs.tg.hidden';
  const setTgHidden = (h) => { $('tg-body').hidden = h; $('tg-toggle').textContent = h ? 'แสดง ▾' : 'ซ่อน ▴'; $('tg-toggle').setAttribute('aria-expanded', String(!h)); try { localStorage.setItem(TG_HIDE, h ? '1' : '0'); } catch { void 0; } };
  let tgHidden = false;
  try { tgHidden = localStorage.getItem(TG_HIDE) === '1'; } catch { void 0; }
  setTgHidden(tgHidden);
  $('tg-toggle').addEventListener('click', () => setTgHidden(!$('tg-body').hidden));
  const run = (fn) => async () => { try { await fn(); } catch (err) { toast('✗ ' + err.message, 'err'); } renderTg(); };
  $('tg-token-save').addEventListener('click', run(async () => {
    const t = $('tg-token').value.trim();
    if (!t) throw new Error('วาง token ก่อน');
    await window.api.tgSet({ token: t });
    $('tg-token').value = '';
    toast('🔑 บันทึก token แล้ว', 'ok');
  }));
  $('tg-chat-save').addEventListener('click', run(async () => { await window.api.tgSet({ chatId: $('tg-chat').value.trim() }); toast('บันทึก chat id แล้ว', 'ok'); }));
  $('tg-detect').addEventListener('click', run(async () => {
    const btn = $('tg-detect');
    if (btn.disabled) return;
    btn.disabled = true; btn.textContent = 'กำลังหา…';
    let r;
    try { r = await window.api.tgDetect($('tg-token').value.trim() || null); }
    finally { btn.disabled = false; btn.textContent = 'หา chat id'; }
    if (!r.chats.length) { $('tg-chat-st').textContent = `ยังไม่เจอแชต — เปิดแชตกับ @${r.bot} แล้วพิมพ์อะไรก็ได้ 1 ข้อความ แล้วกดใหม่`; return; }
    const c = r.chats[0];
    $('tg-chat').value = c.id;
    if ($('tg-token').value.trim()) { await window.api.tgSet({ token: $('tg-token').value.trim() }); $('tg-token').value = ''; }
    await window.api.tgSet({ chatId: c.id });
    $('tg-chat-st').textContent = `เจอ ${r.chats.length} แชต — ใช้ "${c.name}" (${c.id}) กับ bot @${r.bot}`;
    toast('✓ ตั้ง chat id แล้ว', 'ok');
  }));
  $('tg-on').addEventListener('change', run(async () => {
    const on = $('tg-on').checked;
    try { await window.api.tgSet({ enabled: on }); } catch (e) { $('tg-on').checked = false; throw e; }
    toast(on ? '🔔 เปิดแจ้งเตือน Telegram แล้ว' : 'ปิดแจ้งเตือน Telegram แล้ว', 'ok');
  }));
  $('tg-events').addEventListener('change', run(async (e) => {
    const ev = Object.fromEntries([...document.querySelectorAll('[data-tg-ev]')].map((x) => [x.dataset.tgEv, x.checked]));
    await window.api.tgSet({ events: ev });
  }));
  $('tg-test').addEventListener('click', run(async () => { await window.api.tgTest(); toast('📨 ส่งข้อความทดสอบแล้ว — ดูใน Telegram', 'ok'); }));
  renderTg();
}

/* ---------- แจ้งเตือน LINE (ตั้งค่าได้เฉพาะในแอปบนเครื่อง) ---------- */
async function renderLine() {
  const card = $('line-card');
  if (!card) return;
  if (window.GS_WEB) { card.hidden = true; return; }
  const maskUid = (u) => (u && u.length > 12 ? u.slice(0, 5) + '•••' + u.slice(-4) : (u || ''));
  let v;
  try { v = await window.api.lineGet(); } catch { return; }
  $('line-on').checked = !!v.enabled;
  const nEv = Object.values(v.events).filter((e) => e.on).length;
  $('line-summary').innerHTML = [
    `<span class="wc-chip ${v.enabled ? 'on' : 'err'}">${v.enabled ? '🔔 แจ้งเตือนเปิด' : '🔕 ปิดอยู่'}</span>`,
    `<span class="wc-chip ${v.tokenSet && v.userId ? 'on' : ''}">${v.tokenSet && v.userId ? 'เชื่อม LINE แล้ว' : 'ยังไม่เชื่อม LINE'}</span>`,
    `<span class="wc-chip">${nEv} เรื่อง</span>`,
  ].join('');
  $('line-token-st').textContent = v.tokenSet ? `✓ ตั้งแล้ว (${v.tokenHint})` : 'ยังไม่ได้ใส่ token';
  if (document.activeElement !== $('line-user')) {
    $('line-user').value = ($('line-user').type === 'password') && v.userId ? '' : (v.userId || '');
    $('line-user').placeholder = v.userId ? `บันทึกแล้ว (${maskUid(v.userId)}) — แตะ 👁 เพื่อดู` : 'เช่น U99fc69b4… (U + 32 ตัว)';
  }
  $('line-events').innerHTML = Object.entries(v.events).map(([k, e]) => `<label><input type="checkbox" data-line-ev="${esc(k)}"${e.on ? ' checked' : ''} />${esc(e.label)}</label>`).join('');
}
if ($('line-card') && !window.GS_WEB) {
  try {
  const LINE_HIDE = 'gs.line.hidden';
  const setLineHidden = (h) => { $('line-body').hidden = h; $('line-toggle').textContent = h ? 'แสดง ▾' : 'ซ่อน ▴'; $('line-toggle').setAttribute('aria-expanded', String(!h)); try { localStorage.setItem(LINE_HIDE, h ? '1' : '0'); } catch { void 0; } };
  let lineHidden = true;
  try { lineHidden = localStorage.getItem(LINE_HIDE) !== '0'; } catch { void 0; }
  setLineHidden(lineHidden);
  $('line-toggle').addEventListener('click', () => setLineHidden(!$('line-body').hidden));
  const run = (fn) => async () => { try { await fn(); } catch (err) { toast('✗ ' + err.message, 'err'); } renderLine(); };
  $('line-token-save').addEventListener('click', run(async () => {
    const t = $('line-token').value.trim();
    if (!t) throw new Error('วาง token ก่อน');
    await window.api.lineSet({ token: t });
    $('line-token').value = '';
    toast('🔑 บันทึก token แล้ว', 'ok');
  }));
  $('line-user-save').addEventListener('click', run(async () => { await window.api.lineSet({ userId: $('line-user').value.trim() }); $('line-user').value = ''; toast('บันทึก userId แล้ว — ซ่อนอยู่ กด 👁 เพื่อดู', 'ok'); }));
  // ปุ่ม 👁: สลับแสดง/ซ่อน token และ userId
  const eye = (btn, inp) => { $(btn).addEventListener('click', async () => {
    const i = $(inp); const toText = i.type === 'password';
    if (toText && !i.value.trim() && inp === 'line-user') {
      // ว่าง = ดึงค่าที่บันทึกไว้มาแสดงชั่วคราว
      try { const v = await window.api.lineGet(); i.value = (v && v.userId) || ''; } catch { void 0; }
    }
    i.type = toText ? 'text' : 'password';
    if (!toText && inp === 'line-user') { i.value = ''; renderLine(); } // กลับเป็นซ่อน = เคลียร์ค่าออกจากจอ
  }); };
  eye('line-token-eye', 'line-token');
  eye('line-user-eye', 'line-user');
  $('line-on').addEventListener('change', run(async () => {
    const on = $('line-on').checked;
    try { await window.api.lineSet({ enabled: on }); } catch (e) { $('line-on').checked = false; throw e; }
    toast(on ? '🔔 เปิดแจ้งเตือน LINE แล้ว' : 'ปิดแจ้งเตือน LINE แล้ว', 'ok');
  }));
  $('line-events').addEventListener('change', run(async (e) => {
    const ev = Object.fromEntries([...document.querySelectorAll('[data-line-ev]')].map((x) => [x.dataset.lineEv, x.checked]));
    await window.api.lineSet({ events: ev });
  }));
  $('line-test').addEventListener('click', run(async () => { await window.api.lineTest(); toast('📨 ส่งข้อความทดสอบแล้ว — ดูใน LINE', 'ok'); }));
  renderLine();
  } catch (err) { try { window.api && window.api.reportError && window.api.reportError('line-card bind: ' + (err && err.message), err && err.stack); } catch { void 0; } }
}

/* ---------- ช่องกรอกราคา: ทศนิยมตาม digits ของโบรกเกอร์ + ปรับละเอียดด้วยลูกศร ----------
   ออกจากช่อง = จัดรูปเป็นทศนิยม 2 ตำแหน่ง (เช่น 3930 → 3930.00)
   ↑/↓ = ±0.01 • Shift+↑/↓ = ±0.10 • Alt/Option+↑/↓ = ±1.00 • ช่องราคาเข้าว่าง + กด ↑/↓ = เริ่มจากราคาตลาด */
const PRICE_INPUTS = '#t-sl, #t-tp, #p-entry, #p-sl, #p-tp, .pin';
const priceDigits = () => (lastSnap && lastSnap.meta && lastSnap.meta.digits) || 2;
const marketPx = () => { const m = (lastSnap && lastSnap.meta) || {}; return Number(m.bid) || Number(lastSnap && lastSnap.price) || null; };
document.addEventListener('focusout', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || !el.matches(PRICE_INPUTS) || el.value === '') return;
  const n = Number(el.value);
  if (Number.isFinite(n) && n > 0) el.value = n.toFixed(priceDigits());
});
document.addEventListener('keydown', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || !el.matches(PRICE_INPUTS) || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  const d = priceDigits();
  const base = el.value === '' ? marketPx() : Number(el.value);
  if (!Number.isFinite(base)) return;
  const stepV = e.altKey ? 1 : e.shiftKey ? 0.1 : Math.pow(10, -d);
  el.value = (base + (e.key === 'ArrowUp' ? stepV : -stepV)).toFixed(d);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

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

/* ---------- แท็บแยกในการ์ดโอกาส: โอกาส (ผ่านกฎ) / ไม้จำลอง (สภา ณ เปิดไม้) ---------- */
// (แยกแผงไม้จำลองออกมาอ่านเฉพาะ — แท็บกลุ่มนี้เป็นสำเนาย่อของแท็บประวัติใหญ่)
const oppTabsCtl = document.getElementById('o-tabs');
if (oppTabsCtl) {
  const showOpp = (name) => {
    const tab = name === 'sim' ? 'sim' : 'opps';
    store.set('gsOppTab', tab);
    document.querySelectorAll('#o-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.o === tab));
    $('o-pane-opps').hidden = tab !== 'opps';
    $('o-pane-sim').hidden = tab !== 'sim';
    if (lastSnap) renderZoneHistory(lastSnap);
  };
  oppTabsCtl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => showOpp(b.dataset.o)));
  showOpp(store.get('gsOppTab', 'opps'));
}
function renderOppCounts(snap) {
  const nSig = (snap.signals || []).length;
  const nSim = (snap.zoneHistory || []).length + (snap.zoneOpen || []).length;
  const a = $('o-sig-n'), b = $('o-sim-n');
  if (a) a.textContent = nSig ? String(nSig) : '';
  if (b) b.textContent = nSim ? String(nSim) : '';
}

/* ---------- แถบตัวเลขหลัก (KPI) — สรุปสิ่งที่ต้องรู้ในแวบเดียว ---------- */
function setKpi(id, text, cls = '') { const el = $(id); el.textContent = text; el.className = cls; }
function renderKpis(snap) {
  const a = snap.analysis;
  const bias = a && a.bias;
  setKpi('kpi-bias', bias === 'bull' ? 'ขาขึ้น ▲' : bias === 'bear' ? 'ขาลง ▼' : a ? 'ออกข้าง' : '—', bias === 'bull' ? 'up' : bias === 'bear' ? 'down' : '');
  const c = snap.council;
  if (!c) setKpi('kpi-council', 'ปิดอยู่');
  else if (c.side === 'none') {
    const lean = c.leanSide === 'buy' ? 'ซื้อ' : c.leanSide === 'sell' ? 'ขาย' : '';
    const why = !lean ? 'ยังไม่มีใครเลือกฝั่ง'
      : (c.leanAgree || 0) < (c.quorumNeed || 3) ? `${lean} ${c.leanAgree}/${c.quorumNeed} คน`
      : `${lean} ${c.leanAgree}/${c.quorumNeed} คน แต่โหวตขัดกัน`;
    setKpi('kpi-council', `ไม่ผ่านมติ • ${why} • ${Math.max(0, c.confidence)}%`, '');
  }
  else {
    // ผ่านมติ = สภาออกทิศ + ครบเกณฑ์จริงที่ใช้ (โหมดเข้ม: มั่นใจรวม ≥ councilMin และเห็นพ้อง ≥ โควตา)
    const strict = !(snap.risk && snap.risk.councilStrict === false);
    const pass = strict
      ? (c.confidence || 0) >= ((snap.risk && snap.risk.councilMin) || 70) && (c.agree || 0) >= (c.quorumNeed || 3)
      : true;
    setKpi('kpi-council', pass
      ? `ผ่านมติ ✓ ${c.confidence}% • ${c.agree} เสียง`
      : `มีมติ (ไม่ผ่านเกณฑ์) ${c.confidence}% • ${c.agree}/${c.quorumNeed || 3}+ เสียง`, c.side === 'buy' ? 'up' : 'down');
  }
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

const rendererErrorMemo = {};   // กันอุทกภัย spam: จุดเดียวพังซ้ำ = รายงานบ่อยน้อยลง
const rendererErrorCount = {};
function applySnapshot(snap, first) {
  if (!snap) return;
  lastSnap = snap;
  // เลขเวอร์ชันใต้ชื่อโปรแกรม (แบบ macOS: Version x (build))
  const ver = snap.app && snap.app.version;
  const verEl = $('app-ver');
  if (ver && verEl && verEl._v !== ver) { verEl._v = ver; verEl.textContent = `Version ${ver} (${ver})`; }
  // กันเหนียว: แต่ละการ์ดแยกกัน — render เดียวพัง = จุดเดียวหยุด ที่เหลือวาดต่อ (หน้าจอไม่ตายทั้งใบ)
  const guard = (name, fn) => {
    try { fn(); }
    catch (err) {
      rendererErrorCount[name] = (rendererErrorCount[name] || 0) + 1;
      const c = rendererErrorCount[name];
      if (c === 1 || (c % 50 === 0 && Date.now() - (rendererErrorMemo[name] || 0) > 30_000)) {
        rendererErrorMemo[name] = Date.now();
        console.error(`render ${name} ล้ม:`, err);
        window.api && window.api.reportError && window.api.reportError(`render ${name}: ` + (err && err.message), err && err.stack);
      }
    }
  };
  const fresh = () => {
    if (snap.candles && Object.keys(snap.candles).length) Object.assign(candStore, snap.candles);
    // แท่งที่กำลังก่อตัว: แทนแท่งสุดท้าย (เวลาเดียวกัน) หรือต่อท้าย (แท่งใหม่)
    for (const [tf, bar] of Object.entries(snap.candleTail || {})) {
      const arr = candStore[tf];
      if (!arr || !arr.length || !bar) continue;
      const last = arr[arr.length - 1];
      if (last.t === bar.t) arr[arr.length - 1] = bar; else if (bar.t > last.t) arr.push(bar);
    }
  };
  guard('store', fresh);
  guard('ticker', () => renderTicker(snap));
  guard('standby', () => renderStandby(snap.standby, snap.session));
  guard('commentary', () => renderCommentary(snap));
  guard('dataAlert', () => renderDataAlert(snap));
  guard('session', () => renderSession(snap));
  guard('entryplan', () => renderEntryPlan(snap));
  guard('trade', () => renderTradePanel(snap));
  guard('autoEnter', () => autoEnterTick(snap));
  guard('positions', () => renderPositions(snap.meta));
  guard('pendings', () => renderPendings(snap));
  guard('connBadge', () => badgeFor(snap.connectorStatuses, (snap.risk && snap.risk.source) || $('source-sel').value));
  guard('market', () => renderMarket(snap.analysis));
  guard('guards', () => renderGuards(snap.guard, snap.risk || {}));
  guard('signals', () => renderSignals(snap));
  guard('oppCounts', () => renderOppCounts(snap));
  guard('zoneHistory', () => renderZoneHistory(snap));
  guard('council', () => renderCouncil(snap.council, snap.error, snap.councilStats));
  guard('kpis', () => renderKpis(snap));
  guard('ladder', () => renderLadder(snap));
  guard('deferred', () => renderDeferred(snap));
  guard('chart', () => updateChart(candStore));
}

async function loadSettingsToForm() {
  const s = await window.api.getSettings();
  $('s-equity').value = s.equity;
  $('s-riskpct').value = s.riskPct;
  $('s-automax').value = s.autoRiskMaxPct != null ? s.autoRiskMaxPct : 2;
  $('s-manualriskmax').value = s.manualRiskMaxPct != null ? s.manualRiskMaxPct : 2;
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
  $('s-modifyabsmax').value = s.modifyAbsMaxPct != null ? s.modifyAbsMaxPct : 10;
  // "จุด SL/จุด TP" = ค่าตั้งจริงของระบบ (ทุกกลยุทธ์/คำสั่งรอดึงใช้) — ว่าง = อัตโนมัติ ATR
  $('rc-sl').value = Number(s.slDistPts) > 0 ? Number(s.slDistPts) : '';
  $('rc-tp').value = Number(s.tpDistPts) > 0 ? Number(s.tpDistPts) : '';
  $('t-auto').checked = !!s.autoEnter;
  $('t-real').checked = !!s.realOrdersEnabled;
  $('ac-all').checked = !!s.autoCloseAll;
  $('ac-all-th').value = Number(s.autoCloseAllProfit) > 0 ? Math.round(s.autoCloseAllProfit) : '';
  $('ac-all-p').value = Number(s.autoCloseAllProfit) > 0 ? Math.round(s.autoCloseAllProfit / (acMoneyPerPoint().per || 1)) : '';
  $('ac-loss').checked = !!s.autoCloseLoss;
  $('ac-loss-th').value = Number(s.autoCloseLossValue) > 0 ? Math.round(s.autoCloseLossValue) : '';
  $('ac-loss-p').value = Number(s.autoCloseLossValue) > 0 ? Math.round(s.autoCloseLossValue / (acMoneyPerPoint().per || 1)) : '';
  if ($('ac-lossonly')) $('ac-lossonly').checked = !!s.autoCloseLosingOnly;
  if ($('ac-lossonly-th')) $('ac-lossonly-th').value = Number(s.autoCloseLosingOnlyValue) > 0 ? Math.round(s.autoCloseLosingOnlyValue) : '';
  if ($('ac-lossonly-p')) $('ac-lossonly-p').value = Number(s.autoCloseLosingOnlyValue) > 0 ? Math.round(s.autoCloseLosingOnlyValue / (acMoneyPerPoint().per || 1)) : '';
  $('ac-allpts').checked = !!s.autoCloseAllPts;
  $('ac-allpts-th').value = Number(s.autoCloseAllPtsValue) > 0 ? Math.round(s.autoCloseAllPtsValue) : '';
  $('ac-allpts-p').value = Number(s.autoCloseAllPtsValue) > 0 ? Math.round(s.autoCloseAllPtsValue / (acMoneyPerPoint().per || 1)) : '';
  $('ac-pts').checked = !!s.autoClosePoints;
  $('ac-pts-th').value = Number(s.autoClosePointsValue) > 0 ? Math.round(s.autoClosePointsValue) : '';
  $('ac-pts-p').value = Number(s.autoClosePointsValue) > 0 ? Math.round(s.autoClosePointsValue / (acMoneyPerPoint().per || 1)) : '';
  $('s-councilon').checked = s.councilEnabled !== false;
  $('s-councilstrict').checked = s.councilStrict !== false;
  $('s-quorumauto').checked = s.councilQuorumAuto !== false;
  $('s-quorum').value = s.councilQuorum;
  $('s-councilmin').value = s.councilMin;
  $('source-sel').value = s.source;
  $('bridge-path').textContent = s.mt5BridgePath ? 'ไฟล์: ' + s.mt5BridgePath : '';
  updateCalcExample(s);
  appSettings = s;
  rcFromPct(); // เครื่องคิดเลข: ล็อตคงที่ → เติมจุด SL จาก % ที่โหลดมา (ไม่แก้ % ตอนโหลด)
  return s;
}

/* ---------- เครื่องคิดเลขความเสี่ยง: ล็อต / จุด SL / จุด TP ↔ ความเสี่ยงต่อไม้ % ----------
   คำนวณบนหน้าอย่างเดียว ไม่แตะลอจิกส่งคำสั่ง — ตอนบันทึกส่งแค่ riskPct ตามเดิม
   1 จุด = 10^-digits (แบบเดียวกับปิดอัตโนมัติ: XAUUSD digits 2 → 0.01)
   $ = จุด × ขนาดจุด × oz/ล็อต × ล็อต • % = $ ÷ ทุน × 100 */
const RC_KEY = 'gs.riskCalc', RC_MIN = 0.05, RC_MAX = 10;
const rcNum = (id) => { const v = Number($(id).value); return Number.isFinite(v) && v > 0 ? v : 0; };
function rcEnv() {
  const m = (lastSnap && lastSnap.meta) || {};
  const point = Math.pow(10, -(Number(m.digits) || 2));
  const oz = Number(appSettings && appSettings.ozPerLot) || 100; // OZ_PER_LOT (src/engine/risk.js)
  return { point, oz, equity: rcNum('s-equity') };
}
function rcInfo(note) {
  const { point, oz, equity } = rcEnv();
  const lot = rcNum('rc-lot'), sl = rcNum('rc-sl'), tp = rcNum('rc-tp');
  const perPt = point * oz * lot; // $ ต่อ 1 จุด
  const parts = [];
  if (!(equity > 0)) parts.push('ใส่ทุนก่อน');
  if (!(lot > 0)) parts.push('ใส่ล็อตเพื่อคำนวณ');
  else {
    if (sl > 0) parts.push(`SL $${r2(sl * perPt, 2)}`);
    if (tp > 0) parts.push(`TP $${r2(tp * perPt, 2)}`);
    if (sl > 0 && tp > 0) parts.push(`RR 1:${r2(tp / sl, 2)}`);
    if (!parts.length) parts.push(`1 จุด = $${r2(perPt, 2)}`);
  }
  $('rc-out').textContent = (note ? note + ' • ' : '') + parts.join(' • ');
  $('rc-out').classList.toggle('down', !!note);
}
// แก้ล็อต / จุด SL → เขียน % ใหม่ (ปัด 2 ตำแหน่ง, บีบในกรอบ 0.05–10) • แก้ทุนไม่แตะ % (ใช้ rcFromPct)
function rcFromLotSl() {
  const { point, oz, equity } = rcEnv();
  const lot = rcNum('rc-lot'), sl = rcNum('rc-sl');
  let note = '';
  if (lot > 0 && sl > 0 && equity > 0) {
    const raw = Number(((sl * point * oz * lot) / equity * 100).toFixed(2));
    const pct = Math.min(RC_MAX, Math.max(RC_MIN, raw));
    $('s-riskpct').value = pct;
    if (pct !== raw) note = `คิดได้ ${r2(raw, 2)}% ${raw > RC_MAX ? 'เกินเพดาน' : 'ต่ำกว่าขั้นต่ำ'} — ตั้งเป็น ${pct}%`;
  }
  rcInfo(note);
}
// แก้ % → คำนวณจุด SL ใหม่ (ล็อตคงที่, ปัดเป็นจุดเต็ม)
function rcFromPct() {
  const { point, oz, equity } = rcEnv();
  const lot = rcNum('rc-lot'), pct = rcNum('s-riskpct');
  if (lot > 0 && pct > 0 && equity > 0) $('rc-sl').value = Math.max(1, Math.round((equity * pct / 100) / (point * oz * lot)));
  rcInfo('');
}
const rcSave = () => store.set(RC_KEY, JSON.stringify({ lot: $('rc-lot').value }));
// จุด SL/จุด TP ที่พิมพ์ = ค่าตั้งจริง (settings.json) — ทุกแผน/คำสั่งรอ/อัตโนมัติจะดึงมาใช้
const rcPushSettings = () => {
  const sl = Number($('rc-sl').value), tp = Number($('rc-tp').value);
  try {
    window.api.saveSettings({
      slDistPts: Number.isFinite(sl) && sl > 0 ? Math.round(sl) : 0,
      tpDistPts: Number.isFinite(tp) && tp > 0 ? Math.round(tp) : 0,
    });
  } catch { void 0; }
};
(() => {
  // migrate: ค่าจุด SL/TP ที่เคยจำใน localStorage (ก่อนมี settings) → ย้ายเป็นค่าตั้งจริงครั้งเดียว
  let saved = null;
  try { saved = JSON.parse(store.get(RC_KEY, 'null')); } catch { saved = null; }
  const ls = (saved && appSettings && Number(appSettings.slDistPts) === 0) ? Number(saved.slPts) : 0;
  const lt = (saved && appSettings && Number(appSettings.tpDistPts) === 0) ? Number(saved.tp) : 0;
  $('rc-lot').value = saved && saved.lot ? saved.lot : '0.01';
  if (Number.isFinite(ls) && ls > 0) { $('rc-sl').value = ls; rcPushSettings(); store.set(RC_KEY, JSON.stringify({ lot: saved.lot, slPts: ls, tp: saved.tp })); }
})();
$('rc-lot').addEventListener('input', () => { rcFromLotSl(); rcSave(); });
$('rc-sl').addEventListener('input', () => { rcFromLotSl(); rcPushSettings(); });
$('rc-tp').addEventListener('input', () => { rcInfo(''); rcPushSettings(); });
$('s-equity').addEventListener('input', rcFromPct); // แก้ทุน = คงค่า % ที่ตั้งไว้ คิดจุด SL ใหม่ (เดิมเขียนทับ % เงียบๆ)
$('s-riskpct').addEventListener('input', rcFromPct);

function updateCalcExample(s) {
  const eff = Math.min(Number(s.riskPct) || 1, Number(s.autoRiskMaxPct) || 2);
  const effAuto = Math.min(eff, Number(s.manualRiskMaxPct) || 6);
  $('calc-example').innerHTML = `
    <b>สูตรคำนวณจากทุนที่ตั้ง $${r2(s.equity, 0)}</b> — เมื่อเชื่อม MT5 ระบบใช้ <b>ทุนจริงบนบัญชี</b>แทนเสมอ (ป้ายสดอยู่แผงส่งคำสั่ง)<br>
    อัตโนมัติ: เสี่ยง ≤ ${r2(eff, 2)}% ต่อไม้ (เพดาน ${r2(Number(s.autoRiskMaxPct) || 2, 1)}%) → ออกเงินต่อไม้ ≤ <b>$${r2((s.equity * eff) / 100, 2)}</b> • ปุ่มกดเอง: เพดาน ${r2(Number(s.manualRiskMaxPct) || 2, 1)}% → สูงสุด <b>$${r2((s.equity * effAuto) / 100, 2)}/ไม้</b><br>
    ตัวอย่าง: SL $8.00 → ล็อต = ${((s.equity * eff) / 100 / (8 * 100)).toFixed(2)} (XAUUSD 100 oz/ล็อต)`;
}

$('form-risk').addEventListener('submit', async (e) => {
  e.preventDefault();
  const partial = {
    equity: Number($('s-equity').value),
    riskPct: Number($('s-riskpct').value),
    autoRiskMaxPct: Number($('s-automax').value),
    manualRiskMaxPct: Number($('s-manualriskmax').value),
    modifyAbsMaxPct: Number($('s-modifyabsmax').value),
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
    councilQuorumAuto: $('s-quorumauto').checked,
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

// สวิตช์เปิด/ปิดเอเจนต์รายคน (แผงสภา) — บันทึกทันที สภาใช้ทีมนี้ตั้งแต่รถัดไป ไม่ต้องรีสตาร์ท
$('council-agents').addEventListener('change', async (e) => {
  const box = e.target;
  const id = box && box.dataset && box.dataset.agent;
  if (!id) return;
  const next = Object.assign({}, appSettings.councilAgents || {}, { [id]: box.checked });
  try {
    const s = await window.api.saveSettings({ councilAgents: next });
    appSettings = s;
    toast('สภา: อัปเดตทีมเอเจนต์แล้ว — ใช้ตั้งแต่รอบถัดไป', 'ok');
    window.api.refreshNow();
  } catch (err) {
    box.checked = !box.checked;
    toast('บันทึกไม่สำเร็จ: ' + err.message, 'err');
  }
});

$('btn-refresh').addEventListener('click', () => { $('conn-badge').textContent = 'กำลังอัปเดต...'; window.api.refreshNow(); });
$('btn-newwin').addEventListener('click', async () => {
  if (window.GS_WEB) return;
  try { await window.api.openNewWindow(); toast('🗔 เปิดหน้าต่างใหม่แล้ว — ข้อมูลสดเท่าเดิม', 'ok'); } catch (err) { toast('✗ ' + err.message, 'err'); }
});

/* ---------- คีย์ลัด (เฉพาะเครื่องที่มีเมาส์/คีย์บอร์ด) — ไม่มีคีย์ไหนส่งคำสั่งซื้อขายเด็ดขาด ---------- */
function openKeysHelp() {
  if ($('modal').classList.contains('show')) return; // ไม่ทับหน้ายืนยันที่เปิดอยู่
  $('mbox').innerHTML = `
    <h3>คีย์ลัด</h3>
    <div class="mline"><span>สลับแท็บ ภาพรวม / ความเสี่ยง / กลยุทธ์ / MT5 / บันทึก</span><b><kbd>1</kbd>–<kbd>5</kbd></b></div>
    <div class="mline"><span>อัปเดตทันที</span><b><kbd>R</kbd></b></div>
    <div class="mline"><span>เปิดหน้านี้</span><b><kbd>?</kbd></b></div>
    <div class="mline"><span>ปิดหน้าต่าง / ย่อชาร์ต-คำสั่งรอ</span><b><kbd>Esc</kbd></b></div>
    <div class="mline"><span>เลื่อนราคาในช่อง SL/TP/ราคาเข้า (Shift = 0.1 • Alt = 1)</span><b><kbd>↑</kbd><kbd>↓</kbd></b></div>
    <div class="mline"><span>คัดลอกราคา: คลิกราคาบนแถบบน / ปุ่มคัดลอก Bid-Ask / ช่องเข้า-SL-TP ในตาราง</span><b>คลิก</b></div>
    <div class="mwarn">⚠ คีย์ลัดไม่มีคำสั่งซื้อขาย — ต้องกด BUY/SELL แล้วยืนยันเสมอ</div>
    <div class="mbtns"><button class="mcancel" id="m-cancel">ปิด</button></div>`;
  $('modal').classList.add('show');
  $('m-cancel').focus();
  $('m-cancel').addEventListener('click', closeModal);
}
if ($('btn-keys')) $('btn-keys').addEventListener('click', openKeysHelp);
const keysMq = window.matchMedia ? window.matchMedia('(hover: hover) and (pointer: fine)') : null;
let lastKeyRefresh = 0;
document.addEventListener('keydown', (e) => {
  if (!keysMq || !keysMq.matches) return;
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = document.activeElement;
  if (el && (el.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName))) return;
  if ($('modal').classList.contains('show')) return;
  // e.code = ตำแหน่งปุ่มจริง (คีย์บอร์ดไทยก็ใช้ได้)
  const dm = /^(?:Digit|Numpad)([1-5])$/.exec(e.code);
  if (dm && !e.shiftKey) {
    if (document.body.classList.contains('chart-max') || ($('pend-card') && $('pend-card').classList.contains('max'))) return;
    const btn = document.querySelectorAll('#tabs button')[Number(dm[1]) - 1];
    if (btn) { e.preventDefault(); btn.click(); }
    return;
  }
  if (e.code === 'KeyR' && !e.shiftKey) {
    e.preventDefault();
    if (Date.now() - lastKeyRefresh < 1500) return; // กันกดรัว
    lastKeyRefresh = Date.now();
    $('btn-refresh').click();
    return;
  }
  if (e.key === '?' || (e.shiftKey && e.code === 'Slash')) { e.preventDefault(); openKeysHelp(); }
});
// ตรวจอัปเดต (ปุ่มบนการ์ดบันทึก) — เจอรุ่นใหม่ = แจ้ง + ลิงก์ดาวน์โหลดในหน้าจอและ log
const btnUpdateCheck = $('btn-update-check');
if (btnUpdateCheck) btnUpdateCheck.addEventListener('click', async () => {
  const st = $('update-st');
  btnUpdateCheck.disabled = true;
  if (st) st.textContent = 'กำลังตรวจ...';
  try {
    const r = await window.api.updateCheck();
    if (st) st.textContent = r.latest ? `มีรุ่นใหม่: ${r.latest} (รุ่นนี้ ${r.current})` : `ล่าสุดแล้ว (${r.current})`;
    toast(r.latest ? `🚀 มีเวอร์ชันใหม่ ${r.latest} — ดู https://github.com/ProgramZa2560/GoldSignal/releases` : '✓ รุ่นล่าสุดอยู่แล้ว', r.latest ? 'ok' : '');
  } catch { if (st) st.textContent = 'ตรวจไม่สำเร็จ — ลองใหม่'; }
  finally { btnUpdateCheck.disabled = false; }
});

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
function renderCouncil(c, error, stats) {
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
    const skTxt = a.off ? 'เอเจนต์ปิดอยู่ — ไม่ร่วมโหวตในรอบนี้' : (sk.hit != null ? `${a.name.split('เอเจนต์')[1] || ''}: ผลงาน ${sk.grade} ${Math.round(sk.hit * 100)}% (${sk.n} ไม้)` : (sk.grade === 'ใหม่' ? 'เพิ่งรับหน้าที่ — ยังไม่ผ่านการตรวจผลงาน' : `${sk.grade} (${sk.n})`));
    // ตัวปรับน้ำหนักจากฝ่ายบริบท (สภาพตลาด/ช่วงเวลา) — โชว์เมื่อไม่ใช่ ×1
    const adj = Number.isFinite(a.weightAdj) && Math.abs(a.weightAdj - 1) > 0.01 ? ` • น้ำหนักตามสนาม ×${a.weightAdj.toFixed(2)}` : '';
    const sw = `<span class="asw" title="เปิด/ปิดเอเจนต์นี้ — ใช้ตั้งแต่รอบวิเคราะห์ถัดไป"><label class="switch"><input type="checkbox" class="agl" data-agent="${a.id}" ${a.off ? '' : 'checked'}><span></span></label><i>${a.off ? 'ปิด' : 'เปิด'}</i></span>`;
    return `<div class="cagent${a.off ? ' is-off' : ''}" title="${esc(a.reason)}${a.skillNote ? ' | ' + esc(a.skillNote) : ''}"><span class="cname">${esc(a.name)}</span><span class="${cls}">${txt}</span><span class="creason">${esc(a.reason)}</span>${sw}</div><div class="cagent-skill">${esc(skTxt)}${esc(adj)}${a.skillNote ? ' • ' + esc(a.skillNote) : ''}</div>`;
  }).join('');
  const notesHtml =
    (c.boosts && c.boosts.length ? `<div class="council-note boost">➕ ${esc(c.boosts.map(String).join(' | '))}</div>` : '') +
    (c.caps && c.caps.length ? `<div class="council-note">⚠ ${esc(c.caps.map(String).join(' | '))}</div>` : '') +
    (c.calibrated ? `<div class="council-note boost">🎓 ปรับความมั่นใจตามผลจริงของสภา: ${esc(c.calibrated.before)}% → ${c.confidence}% (${esc(c.calibrated.note || '')})</div>` : '') +
    (stats ? councilStatsHtml(stats) : '');
  const ck = `${c.side}|${c.confidence}|${c.agree}|${(c.votes || []).map((v) => `${v.id}${v.side}${v.conf}${v.off ? '0' : '1'}`).join('')}|${stats ? `${stats.verdict && stats.verdict.n}|${stats.lean && stats.lean.n}` : ''}`;
  renderOnce('council', ck, $('council-agents'), rows + notesHtml);
  // ช่องตั้งค่าเก็บค่าที่ผู้ใช้พิมพ์เสมอ (ไม่เขียนทับ) — หมายเหตุใต้ช่องบอกค่าที่ใช้จริงรอบนี้
  const qn = $('quorum-note');
  if (qn && c.quorumSrc && qn.textContent !== c.quorumSrc) qn.textContent = c.quorumSrc;
}

// แถบผลงานจริงของสภา (สมุด council-stats): ตรวจมติย้อนหลัง 30 นาทีทุกใบ
function councilStatsHtml(stats) {
  const v = stats.verdict || {}, lean = stats.lean || {}, bands = stats.bands || [];
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  const bandChips = bands.filter((b) => b.hit != null).map((b) =>
    `<span class="cstat-chip ${b.hit >= 0.6 ? 'good' : b.hit >= 0.45 ? 'mid' : 'bad'}">${b.band}: ${Math.round(b.hit * 100)}%<small>${b.n}</small></span>`
  ).join('');
  return `<div class="council-stats">
    <div class="cstats-row"><span>ผลจริงของมติสภา (ตรวจ 30 นาที)</span><b>${pct(v.hit)}</b><small>${v.n != null ? v.n + ' มติ' : ''} ${v.grade && v.hit != null ? '• ' + esc(v.grade) : ''}</small></div>
    <div class="cstats-row"><span>มติเงา (เกือบมีมติ — เอนสุทธิ แต่ไม่ขอผ่าน)</span><b>${pct(lean.hit)}</b><small>${lean.n != null ? lean.n + ' ใบ' : ''}</small></div>
    <div class="cstats-row band">${bandChips ? `<small class="cband-lbl">ช่วงความมั่นใจที่แม่นจริง:</small>${bandChips}` : '<small>กำลังสะสมผลมติ — ครบ 10 ใบต่อช่วงแล้วเริ่มปรับความมั่นใจอัตโนมัติ</small>'}</div>
    ${stats.pending ? `<div class="cstats-row"><small>รอตรวจผลอยู่ ${stats.pending} รอบ</small></div>` : ''}
  </div>`;
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
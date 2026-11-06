'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, Notification, powerSaveBlocker, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
// เน็ตบางบ้าน IPv6 ไปไม่ถึงปลายทาง (เช่น api.telegram.org = EHOSTUNREACH) แต่ fetch เลือก IPv6 ก่อนแล้วค้างจน timeout → ใช้ IPv4 ก่อนเสมอ
require('dns').setDefaultResultOrder('ipv4first');

const { AnalysisEngine } = require('../engine/engine');
const { PluginLoader } = require('../engine/plugins');
const { MT5Connector, findMql5ExpertsDir, compileEA, checkPartialVolume } = require('../engine/connectors/mt5');
const { YahooConnector } = require('../engine/connectors/yahoo');
const { gateSignal, AGENTS } = require('../engine/council');
const risk = require('../engine/risk');
const autoclose = require('../engine/autoclose');
const { startWebServer, startRemotePush } = require('./webserver');
const { createWebAuth } = require('./webauth');
const { createTunnel } = require('./tunnel');
const pages = require('./pages');
const { createTelegram } = require('./telegram');
const { createLine } = require('./line');

// คำสั่งทุกตัวลงทะเบียนที่เดียว: หน้าต่างแอปเรียกผ่าน IPC • หน้าเว็บเรียกผ่าน HTTP (ชุดเดียวกัน ตรวจเกตเดียวกัน)
const handlers = new Map();
const handle = (channel, fn) => { handlers.set(channel, fn); ipcMain.handle(channel, fn); };
// คำสั่งที่ห้ามเรียกจากเว็บ: เปิดหน้าต่าง/กล่องเลือกไฟล์บนเครื่อง + จัดการรหัสเว็บ (ต้องทำที่เครื่องเท่านั้น)
const WEB_BLOCKED = new Set(['pick-bridge-file', 'open-plugins-dir', 'open-history-window', 'open-new-window', 'web-access-get', 'web-access-set', 'web-access-logout-all', 'tunnel-start', 'tunnel-stop', 'pages-setup', 'tg-get', 'tg-set', 'tg-detect', 'tg-test', 'line-get', 'line-set', 'line-test', 'update-check']);

// ---------- paths ----------
const isDev = !app.isPackaged;
const root = isDev ? path.join(__dirname, '..', '..') : process.resourcesPath;
const builtInPluginsDir = isDev ? path.join(root, 'plugins') : path.join(root, 'plugins');
const userPluginsDir = path.join(app.getPath('userData'), 'plugins');
const settingsFile = path.join(app.getPath('userData'), 'settings.json');
fs.mkdirSync(userPluginsDir, { recursive: true });

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  symbol: 'XAUUSD',
  yahooSymbol: 'GC=F',
  source: 'auto',            // auto | mt5 | yahoo
  mt5BridgePath: '',
  pollSec: 10,
  equity: 1000,
  riskPct: 1,                // เปอร์เซ็นต์ต่อไม้ — ถูกบีบด้วย HARD_MAX_RISK_PCT เสมอ
  manualRiskMaxPct: 2,       // เพดานของปุ่มกดเองเท่านั้น (2–10) — ปรับสูงได้โดยผู้ใช้รับความเสี่ยงเอง; อัตโนมัติยังล็อก 2%
  modifyAbsMaxPct: 10,       // เพดานสัมบูรณ์ของการแก้ SL/คำสั่งรอแบบกดเอง (ยืนยันแล้วห้ามเกินค่านี้; 10–50% ของทุน)
  slDistPts: 0,              // ระยะ SL ที่ผู้ใช้ตั้ง (จุด) — 0 = อัตโนมัติ ATR×1.8 • >0 = ใช้ตามที่ตั้งทุกสาย (เว้นแต่กรอกในช่องตรวจแปะเอง)
  tpDistPts: 0,              // ระยะ TP (จุด) — 0 = อัตโนมัติ ATR×4.5 • >0 = ใช้ตามที่ตั้ง
  minRR: 1.5,                // HARD_MIN_RR คือพื้น 1.0
  minConfidence: 60,
  maxSignalsPerDay: 3,   // โควตาไม้ต่อวัน (สัญญาณ + ปุ่มคำสั่งจริงนับรวม) — ผู้ใช้เลือกได้ในแท็บตั้งค่า
  leastRisk: true,       // เข้าเฉพาะไม้ที่วิเคราะห์แล้วเสี่ยงน้อยที่สุดของรอบ
  notifySignal: true,       // แจ้งเตือน macOS เมื่อโอกาสพร้อม
  autoStart: false,         // เปิดวิเคราะห์เองตอนเปิดเครื่อง
  cooldownMin: 15,
  newsStop: false,
  realOrdersEnabled: false, // สวิตช์ใหญ่: ปิดอยู่เริ่มต้น — ปุ่มซื้อขายทำงานเรียลมื่อเปิด + ยืนยัน 2 ชั้น
  autoEnter: false,         // เปิด = ระบบเข้าไม้เองทันทีเมื่อผ่านทุกเกต (ไม่รอกด) • ปิด = ระบบเด้งหน้ายืนยันรอกด
  councilEnabled: true,   // ทีมเอเจนต์วิเคราะห์ก่อนทุกไม้
  councilStrict: true,    // โหมดเข้ม: ต้องมีมติสภาสนับสนุนถึงแสดงสัญญาณ (หลักฐานจาก backtest 60 วัน)
  councilQuorum: 3,       // จำนวนเอเจนต์เห็นพ้องขั้นต่ำให้สภาออกมติ (โหมดอัตโนมัติใช้เป็นเพดาน)
  councilQuorumAuto: true, // อัตโนมัติ: คิวรัม = min(councilQuorum, 60% ของเอเจนต์ที่เปิด ปัดขึ้น)
  autoCloseAll: false,        // ปิดรวบอัตโนมัติเมื่อกำไรลอยตัวรวม ≥ autoCloseAllProfit (สกุลเงินบัญชี)
  autoCloseAllProfit: 100,
  autoCloseLoss: false,       // ตัดขาดทุนรวบอัตโนมัติเมื่อขาดทุนลอยตัวรวม ≥ autoCloseLossValue (สกุลเงินบัญชี)
  autoCloseLossValue: 100,
  autoCloseLosingOnly: false, // ตัดขาดทุน "เฉพาะไม้แดง": ขาดทุนรวม ≥ autoCloseLosingOnlyValue → ปิดแค่ฝั่งติดลบ เก็บไม้ที่บวกไว้
  autoCloseLosingOnlyValue: 100,
  autoCloseAllPts: false,     // ปิดรวบอัตโนมัติเมื่อจุดของทุกไม้รวมกัน ≥ autoCloseAllPtsValue
  autoCloseAllPtsValue: 300,
  autoClosePoints: false,     // ปิดรายไม้อัตโนมัติเมื่อไม้บวก ≥ autoClosePointsValue จุด
  autoClosePointsValue: 300,
  councilMin: 70,         // ความมั่นใจรวมขั้นต่ำปล่อยสัญญาณมติสภา (แตะแล้ววัด: 75=+0.7R, 70=+19.9R, 65=+18.4R)
};

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

// เขียนแบบ atomic (tmp → rename) กันไฟล์ตั้งค่าพังถ้าแอปปิดกลางทาง
function writeSettings(clean) {
  const tmp = settingsFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), 'utf8');
  fs.renameSync(tmp, settingsFile);
}

function sanitizeSettings(input) {
  const s = { ...loadSettings(), ...(input || {}) };
  const num = (v, def, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? risk.clamp(n, min, max) : def;
  };
  return {
    symbol: String(s.symbol || DEFAULT_SETTINGS.symbol).slice(0, 24),
    yahooSymbol: String(s.yahooSymbol || DEFAULT_SETTINGS.yahooSymbol).slice(0, 16),
    source: ['auto', 'mt5', 'yahoo'].includes(s.source) ? s.source : 'auto',
    mt5BridgePath: typeof s.mt5BridgePath === 'string' ? s.mt5BridgePath.slice(0, 500) : '',
    pollSec: num(s.pollSec, 10, 5, 60),
    equity: num(s.equity, 1000, 0, 100_000_000),
    riskPct: num(s.riskPct, 1, 0.05, 10),        // % เป้า (calcPosition บีบด้วยเพดานอัตโนมัติจริงอีกชั้น)
    autoRiskMaxPct: num(s.autoRiskMaxPct, 2, 2, 10),   // เพดานไม้อัตโนมัติ (2–10%) — default 2% แนะนำ
    manualRiskMaxPct: num(s.manualRiskMaxPct, 2, 2, 100),  // เพดานปุ่มกดเอง (2–100% ของทุน • 100 = ไม่มีการกั้นอีกต่อไป)
    modifyAbsMaxPct: num(s.modifyAbsMaxPct, 10, 10, 100),  // เพดานสัมบูรณ์แก้ SL/คำสั่งรอ (10–100% ของทุน)
    slDistPts: num(s.slDistPts, 0, 0, 50000),     // จุด SL ที่ผู้ใช้ตั้ง (0 = อัตโนมัติ ATR)
    tpDistPts: num(s.tpDistPts, 0, 0, 50000),     // จุด TP ที่ผู้ใช้ตั้ง (0 = อัตโนมัติ ATR)
    minRR: num(s.minRR, 1.5, risk.HARD_MIN_RR, 10),
    minConfidence: num(s.minConfidence, 60, 0, 95),
    maxSignalsPerDay: Math.round(num(s.maxSignalsPerDay, 3, 1, 50)),
    leastRisk: s.leastRisk === false ? false : true,
    cooldownMin: num(s.cooldownMin, 15, 0, 240),
    newsStop: !!s.newsStop,
    notifySignal: s.notifySignal === false ? false : true,
    autoStart: !!s.autoStart,
    realOrdersEnabled: !!s.realOrdersEnabled,
    // ย้ายชื่อ: autoArm (เดิม = เด้งรอกด) → autoEnter (เปิด = เข้าเอง, ปิด = เด้งรอกด) — อ่านค่าเดิมให้ผู้ใช้ไม่ตื่น
    autoEnter: (s.autoEnter === undefined ? s.autoArm : s.autoEnter) === true,
    remoteDashboardUrl: String(s.remoteDashboardUrl || '').trim().slice(0, 300),
    remoteDashboardToken: String(s.remoteDashboardToken || '').trim().slice(0, 200),
    councilEnabled: s.councilEnabled === false ? false : true,
    councilStrict: s.councilStrict === false ? false : true,
    councilQuorum: Math.round(num(s.councilQuorum, 3, 2, 6)),
    councilQuorumAuto: s.councilQuorumAuto !== false,
    councilMin: num(s.councilMin, 70, 50, 95),
    // สวิตช์เปิด/ปิดรายเอเจนต์ในสภา — เก็บเฉพาะ id ที่รู้จัก (id แปลก/เอเจนต์ที่ถอดออกจากโค้ด = ลบออก) ค่า default = เปิด
    councilAgents: (() => {
      const src = input && input.councilAgents && typeof input.councilAgents === 'object' && !Array.isArray(input.councilAgents) ? input.councilAgents : s.councilAgents;
      const out = {};
      for (const a of AGENTS) out[a.id] = src && typeof src === 'object' && src[a.id] !== undefined ? !!src[a.id] : true;
      return out;
    })(),
    autoCloseAll: s.autoCloseAll === true,
    autoCloseAllProfit: num(s.autoCloseAllProfit, 100, 0.01, 1e9),
    autoCloseLoss: s.autoCloseLoss === true,
    autoCloseLossValue: num(s.autoCloseLossValue, 100, 0.01, 1e9),
    autoCloseLosingOnly: s.autoCloseLosingOnly === true,
    autoCloseLosingOnlyValue: num(s.autoCloseLosingOnlyValue, 100, 0.01, 1e9),
    autoCloseAllPts: s.autoCloseAllPts === true,
    autoCloseAllPtsValue: Math.round(num(s.autoCloseAllPtsValue, 300, 1, 1e6)),
    autoClosePoints: s.autoClosePoints === true,
    autoClosePointsValue: Math.round(num(s.autoClosePointsValue, 300, 1, 1e6)),
  };
}

// ---------- window ----------
let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 1080, minHeight: 700,
    title: 'GoldSignal — วิเคราะห์ทองความเสี่ยงต่ำ',
    backgroundColor: '#07080b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
  // เปิดลิงก์ภายนอกเฉพาะ https ในเบราว์เซอร์ระบบ • ห้ามหน้าต่างหลักถูกพาไปหน้าอื่น
  // http อนุญาตเฉพาะที่อยู่แผงของเราเอง (เครื่องนี้ / LAN / Tailscale 100.64.0.0/10)
  const ownHttp = /^http:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)(:\d+)?(\/|$)/i;
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url) || ownHttp.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'app.log'), `${new Date().toISOString()} [console:${level}] ${String(message).slice(0, 300)} (${String(sourceId).split('/').pop()}:${line})\n`); } catch { void 0; }
  });
}

// บันทึกเหตุการณ์ลงไฟล์เพื่อให้ตรวจสอบระบบเชิงพิสูจน์ได้หลังเปิดแอป
function fileLogger() {
  const logFile = path.join(app.getPath('userData'), 'app.log');
  return (tag, msg, lvl = 'info') => {
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} [${lvl}] [${tag}] ${String(msg).slice(0, 300)}\n`);
      // กันไฟล์บวม: หมุนเก็บไว้ 1 ชุด (app.log.1) แทนการลบทิ้ง — ยังย้อนดูเหตุการณ์ได้
      if (fs.statSync(logFile).size > 600 * 1024) fs.renameSync(logFile, logFile + '.1');
    } catch { /* log พังไม่ให้ระบบล้ม */ }
  };
}

// ---------- engine wiring ----------
function boot() {
  const fileLog = fileLogger();
  const engine = new AnalysisEngine({
    settings: sanitizeSettings(), // ค่าจากไฟล์ผ่านการบีบกรอบเสมอ (ไฟล์ถูกแก้มือ/เสีย = ค่า NaN ห้ามหลุดเข้าคิดล็อต)
    connectors: { mt5: new MT5Connector({ logger: fileLog }), yahoo: new YahooConnector({ logger: fileLog }) },
    pluginLoader: null,      // ตั้งด้านล่าง
    logger: fileLog,
    skillsPath: path.join(app.getPath('userData'), 'agent-skills.json'),
    roundStorePath: path.join(app.getPath('userData'), 'round-history.jsonl'),
    zoneStorePath: path.join(app.getPath('userData'), 'zone-history.json'), // เดิมไม่ส่ง → ประวัติไม้เสมือนหายทุกครั้งที่ปิดแอป
    appVersion: app.getVersion(),
  });
  engine.pushLog('app', `GoldSignal เริ่มทำงาน (mode: ${isDev ? 'dev' : 'app'}, version ${app.getVersion()})`);
  // คงการตั้งค่า "เปิดเองตอนเปิดเครื่อง" ตามที่เคยเลือกไว้
  try { app.setLoginItemSettings({ openAtLogin: !!engine.settings.autoStart, openAsHidden: true }); } catch { void 0; }

  const plugins = new PluginLoader({
    builtInDir: builtInPluginsDir,
    userDir: userPluginsDir,
    logger: engine.pushLog,
    // จาก backtest 60 วัน (scripts/backtest.js): สองกลยุทธ์นี้แพ้ทั้งโหมดเข้ม/ธรรมดา
    // ปิดเป็นค่าตั้งต้น — เปิดกลับได้ในแท็บ PLUGINS
    defaultOff: ['bb-squeeze-breakout', 'momentum-ignition'],
  });
  plugins.reload();
  engine.plugins = plugins;

  engine.connectors.mt5.logger = engine.pushLog;
  engine.connectors.yahoo.logger = engine.pushLog;
  engine.connectors.mt5.setBridgePath(loadSettings().mt5BridgePath);
  engine.connectors.mt5.start();

  // แดชบอร์ดเว็บ (โหมดดูเท่านั้น — localhost เครื่องนี้เท่านั้น): ข้อมูลชุดเดียวกับหน้าจอแอป
  // เว็บ GoldSignal: ใช้งานได้เหมือนแอปทั้งหมด (ล็อกอินด้วยรหัสที่ตั้งในแอป)
  const webAuth = createWebAuth(path.join(app.getPath('userData'), 'web-auth.json'));
  // แจ้งเตือน Telegram (token อยู่ไฟล์แยก — หน้าเว็บอ่าน/แก้ไม่ได้)
  // ใช้ net.fetch (ระบบเครือข่ายของ Chromium เหมือนเบราว์เซอร์) — fetch ของ Node ใน Electron ต่อ api.telegram.org ไม่ได้ในบางเน็ต (ETIMEDOUT)
  const tg = createTelegram({ file: path.join(app.getPath('userData'), 'telegram.json'), logger: engine.pushLog, fetchImpl: (u, o) => net.fetch(u, o) });
  // แจ้งเตือน LINE (token/userId อยู่ไฟล์แยก เหมือน Telegram)
  const line = createLine({ file: path.join(app.getPath('userData'), 'line.json'), logger: engine.pushLog, fetchImpl: (u, o) => net.fetch(u, o) });
  // ไม่มีช่องทางไหนรับ (ยังไม่ตั้ง Telegram/LINE หรือปิดเหตุการณ์นี้) → เตือนใน log ครั้งเดียวต่อเหตุการณ์ต่อรอบเปิดแอป (เดิมเงียบ)
  const notifySkipWarned = new Set();
  const notify = (ev, text) => {
    const sent = [tg.notify(ev, text), line.notify(ev, text)].some(Boolean);
    // ลิงก์ (นาน ๆ ครั้ง) เตือนทุกครั้ง • เหตุการณ์อื่นเตือนครั้งเดียวต่อรอบเปิดแอป
    if (!sent && (ev === 'link' || !notifySkipWarned.has(ev))) {
      notifySkipWarned.add(ev);
      const v = tg.view();
      const why = v.tokenSet && v.chatId && !v.enabled ? 'สวิตช์ "เปิดแจ้งเตือน" ของ Telegram ปิดอยู่'
        : v.enabled ? `เหตุการณ์ "${ev}" ถูกปิดในรายการแจ้งเตือน Telegram`
        : 'ยังไม่ได้ใส่ token / chat id ของ Telegram (หรือ LINE)';
      engine.pushLog('notify', `ไม่ได้ส่งแจ้งเตือน "${ev}" — ${why} • ตั้งที่แท็บ MT5 → การ์ด Telegram`, 'warn');
    }
  };
  handle('tg-get', () => tg.view());
  handle('tg-set', (_e, p) => tg.set(p || {}));
  handle('tg-detect', (_e, token) => tg.detectChat(token));
  handle('tg-test', () => tg.test());
  handle('line-get', () => line.view());
  handle('line-set', (_e, p) => line.set(p || {}));
  handle('line-test', () => line.test());
  const thTime = (ms = Date.now()) => new Date(ms).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const px = (n) => (Number.isFinite(Number(n)) && Number(n) ? Number(n).toFixed(2) : '-');
  let webUrl = null, web = null;
  startWebServer({
    getSnapshot: () => engine.lastSnap, logger: engine.pushLog,
    handlers, auth: webAuth, rendererDir: path.join(__dirname, '..', '..', 'renderer'), blocked: WEB_BLOCKED,
  }).then(async (w) => {
    web = w; webUrl = w ? w.url : null;
    // เปิด tunnel ต่อเองตอนเปิดแอป ถ้าครั้งก่อนเปิดค้างไว้ — ลอง "ดึง daemon เก่า" ก่อน (ลิงก์เดิมไม่ตาย 1033)
    const o = webAuth.opts();
    if (w && o.tunnelOn && o.tunnelProvider && webAuth.isRemote()) {
      const ad = await tunnel.adopt(w.port, o.tunnelProvider);
      if (ad.state !== 'on') tunnel.start(o.tunnelProvider, w.port);
    }
  });
  // แจ้ง Telegram/LINE ทุกครั้งที่ลิงก์ถาวรชี้ที่อยู่ใหม่ (เปิดแอป/อัปเดตโปรแกรม/tunnel ได้ URL ใหม่/กดตั้งเอง)
  const notifyLink = (why, repo, u, prov) => notify('link',
    `🔗 GoldSignal: ${why}\nลิงก์ถาวร: ${pages.pagesUrl(repo)}` +
    (u ? `\nลิงก์ตรง (${prov || 'tunnel'}): ${u}` : '\nแผงระยะไกลปิดอยู่') +
    `\nVersion ${app.getVersion()} (${app.getVersion()})`);
  // tunnel ได้ URL ใหม่ → อัปเดตลิงก์ถาวรบน GitHub Pages (ถ้าตั้ง repo ไว้)
  const publish = (u, prov) => {
    const repo = webAuth.opts().pagesRepo;
    if (!repo) return;
    pages.publishLink(repo, u, prov)
      .then(() => {
        engine.pushLog('pages', u ? `อัปเดตลิงก์ถาวร → ${u}` : 'ลิงก์ถาวร: แจ้งว่าแผงปิด');
        notifyLink(u ? 'อัปเดตลิงก์ถาวรแล้ว' : 'ลิงก์ถาวร: แผงปิด', repo, u, prov);
      })
      .catch((err) => engine.pushLog('pages', err.message, 'warn'));
  };
  const tunnel = createTunnel({ logger: engine.pushLog, onUrl: publish, stateFile: path.join(app.getPath('userData'), 'tunnel-state.json') });
  // ออกจากแอป (อัปเดต/ปิดหน้าต่าง): **ไม่ฆ่า cloudflared** — daemon รับทำการต่อกับรอบเปิดถัดไป = ลิงก์ (trycloudflare) ไม่ตาย 1033
  app.on('before-quit', () => { tunnel.stop({ linger: true }); });
  handle('tunnel-start', async (_e, req) => {
    const provider = String((req && req.provider) || '');
    if (!['cloudflared', 'ngrok', 'tailscale'].includes(provider)) throw new Error('เลือก cloudflared / ngrok / tailscale');
    if (!webAuth.hasPassword()) throw new Error('ตั้งรหัสผ่านเว็บก่อนเปิด tunnel');
    if (!web) throw new Error('เว็บยังไม่พร้อม');
    if (!webAuth.isRemote()) { webAuth.setRemote(true); await web.setRemote(true); }
    webAuth.setOpts({ tunnelOn: true, tunnelProvider: provider });
    return tunnel.start(provider, web.port);
  });
  handle('tunnel-stop', async () => {
    webAuth.setOpts({ tunnelOn: false });
    const st = await tunnel.stop();
    publish(null, null);
    return st;
  });
  handle('pages-setup', async (_e, req) => {
    const repo = String((req && req.repo) || '').trim();
    const url = await pages.setup(repo, tunnel.status().url, tunnel.status().provider);
    webAuth.setOpts({ pagesRepo: repo });
    engine.pushLog('pages', `ตั้งลิงก์ถาวรแล้ว: ${url}`);
    notifyLink('ตั้งลิงก์ถาวรใหม่', repo, tunnel.status().url, tunnel.status().provider);
    return { url };
  });
  handle('get-web-url', () => webUrl);
  // ที่อยู่ที่เครื่องอื่นใช้เข้า: Tailscale (100.64.0.0/10) มาก่อน แล้วตามด้วย Wi-Fi/LAN
  const webAddresses = () => {
    if (!web) return [];
    const out = [];
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family !== 'IPv4' || a.internal) continue;
        const [x, y] = a.address.split('.').map(Number);
        const tailscale = x === 100 && y >= 64 && y <= 127;
        out.push({ url: `http://${a.address}:${web.port}`, kind: tailscale ? 'Tailscale (เข้าจากที่ไหนก็ได้)' : `เครือข่าย ${name} (Wi-Fi/LAN เดียวกัน)`, tailscale });
      }
    }
    return out.sort((a, b) => Number(b.tailscale) - Number(a.tailscale));
  };
  handle('web-access-get', () => ({
    hasPassword: webAuth.hasPassword(), remote: webAuth.isRemote(), minLength: webAuth.MIN_PASSWORD,
    sessions: webAuth.sessionCount(), localUrl: webUrl, addresses: webAuth.isRemote() ? webAddresses() : [],
    tunnel: tunnel.status(), tunnelAvailable: tunnel.available(), ghAvailable: !!pages.ghBin(),
    pagesRepo: webAuth.opts().pagesRepo || '', pagesUrl: webAuth.opts().pagesRepo ? pages.pagesUrl(webAuth.opts().pagesRepo) : null,
  }));
  handle('web-access-set', async (_e, req) => {
    const r = req || {};
    if (typeof r.password === 'string' && r.password) { webAuth.setPassword(r.password); engine.pushLog('web', 'ตั้งรหัสผ่านเว็บใหม่แล้ว (ทุกเครื่องที่ล็อกอินอยู่ถูกออกจากระบบ)'); }
    if (typeof r.remote === 'boolean') {
      if (r.remote && !webAuth.hasPassword()) throw new Error('ตั้งรหัสผ่านก่อนเปิดให้เครื่องอื่นเข้า');
      webAuth.setRemote(r.remote);
      if (web) await web.setRemote(webAuth.isRemote());
      if (!r.remote && tunnel.status().state !== 'off') { webAuth.setOpts({ tunnelOn: false }); await tunnel.stop(); publish(null, null); }
      engine.pushLog('web', r.remote ? 'เปิดให้เครื่องอื่นเข้าเว็บควบคุมเต็ม' : 'ปิดการเข้าเว็บจากเครื่องอื่น (เหลือเฉพาะเครื่องนี้)', r.remote ? 'warn' : 'info');
    }
    return { ok: true };
  });
  handle('web-access-logout-all', () => { webAuth.logoutAll(); engine.pushLog('web', 'ออกจากระบบเว็บทุกเครื่องแล้ว'); return { ok: true }; });
  // เว็บระยะไกล (แบบ A): push ข้อมูลขึ้น server คุณเมื่อตั้ง URL + รหัส (ตั้งในแท็บ ตั้งค่า)
  startRemotePush({
    getUrl: () => engine.settings.remoteDashboardUrl,
    getToken: () => engine.settings.remoteDashboardToken,
    getSnapshot: () => engine.lastSnap,
    logger: engine.pushLog,
  });

  const send = (channel, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    for (const w of extraWins) if (!w.isDestroyed()) w.webContents.send(channel, payload);
    if (web) web.broadcast(channel, payload); // เบราว์เซอร์ที่ล็อกอินอยู่ได้ข้อมูลชุดเดียวกัน
    if (channel === 'auto-enter') notify(payload && payload.ok ? 'autoTrade' : 'orderFail', `🤖 ${payload && payload.msg}\n${thTime()}`);
    else if (channel === 'auto-close') notify('autoTrade', `🔒 ${payload && payload.msg}\n${thTime()}`);
  };
  // หน้าต่างซ้ำ: เปิดแอปแบบหลายหน้าต่าง (จอลอง/จอทรฟ่าเหล้ง) — ข้อมูลสดเท่าเดิม
  const extraWins = [];
  handle('open-new-window', () => {
    const w = new BrowserWindow({
      width: 1240, height: 800,
      minWidth: 940, minHeight: 620,
      title: 'GoldSignal — หน้าต่างใหม่',
      backgroundColor: '#07080b',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true, // throttling ค่าเริ่มต้น: หน้าต่างที่มองเห็นอยู่ไม่ถูกหน่วง — ย่อ/ถูกบังทั้งหมดเท่านั้นที่พักวาด (ประหยัด CPU)
      },
    });
    w.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    w.webContents.on('will-navigate', (e) => e.preventDefault());
    extraWins.push(w);
    w.on('closed', () => { const i = extraWins.indexOf(w); if (i >= 0) extraWins.splice(i, 1); });
    w.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
    return true;
  });
  const notifiedSet = new Set();
  // แจ้งเตือน macOS ครั้งเดียวต่อ key (กัน spam) — คลิกแล้วเปิดหน้าต่าง (หรือลิงก์ที่กำหนด เช่น หน้าโหลดอัปเดต)
  const notifyOnce = (key, title, body, url) => {
    if (notifiedSet.has(key)) return;
    if (notifiedSet.size > 64) notifiedSet.clear();
    notifiedSet.add(key);
    if (engine.settings.notifySignal === false) return;
    try {
      const n = new Notification({ title, body });
      n.on('click', () => { if (url) shell.openExternal(url); else if (win && !win.isDestroyed()) { win.show(); win.focus(); } });
      n.show();
    } catch (err) { engine.pushLog('notify', `แจ้งเตือนไม่สำเร็จ: ${err.message}`, 'warn'); }
  };

  const tgSignalSeen = new Set();
  let tgRoundTs = Date.now();
  // ปุ่มยืนยันจาก Telegram → ส่งไม้จริง (ผ่านชั้นเกตเดิมทุกชั้น) หรือปิดคำเชิญ
  const tgQueueConfirm = new Map();
  tg.onActions(async (data, args) => {
    const kind = String(data || '').split(':')[0];
    const key = String(data || '').split(':').slice(1).join(':');
    if (kind === 'skip') {
      pendingSigConfirmRemove(key);
      await tg.sendInline('✋ ปิดคำเชิญนี้แล้ว — ไม่ได้ส่งไม้');
      return;
    }
    if (kind !== 'sig') return;
    const sig = tgQueueConfirm.get(key);
    if (!sig) { await tg.sendInline('⌛ คำเชิญนี้หมดอายุ — รอสัญญาณใหม่เท่านั้น'); return; }
    tgQueueConfirm.delete(key); // ยึดก่อนส่ง — กดซ้ำเร็ว ๆ ไม่ส่งไม้ซ้อน
    // กติกาเดียวกับหน้ายืนยันในแอป: เกิน 15 นาที หรือราคาทะลุ SL/TP ของโอกาสไปแล้ว = ไม่ส่งตามราคาเก่า
    const pxNow = quoteFor(sig.side);
    const crossed = Number.isFinite(pxNow) && ((sig.side === 'buy' ? pxNow <= sig.sl : pxNow >= sig.sl) || (Number(sig.tp) > 0 && (sig.side === 'buy' ? pxNow >= sig.tp : pxNow <= sig.tp)));
    if (Date.now() - sig.at > 15 * 60_000 || crossed) {
      await tg.sendInline(`⌛ คำเชิญนี้ใช้ไม่ได้แล้ว — ${crossed ? 'ราคาทะลุ SL/TP ของโอกาสไปแล้ว' : 'เกิน 15 นาที ราคาอาจเก่าเกิน'} • ไม่ได้ส่งไม้`);
      return;
    }
    const r = await sendOrderReq({ side: sig.side, lot: sig.lot, sl: sig.sl, tp: sig.tp || 0, auto: false });
    if (r && r.ok) {
      await tg.sendInline(`✅ ส่งไม้จริงแล้ว: ${sig.side === 'buy' ? 'BUY' : 'SELL'} ล็อต ${sig.lot} • SL ${px(sig.sl)} • TP ${sig.tp ? px(sig.tp) : '-'} (รอผลจาก MT5)`);
    } else {
      tgQueueConfirm.set(key, sig); // เกตไม่ผ่าน = คืนคำเชิญ ให้กดใหม่ได้ (ยังติดกติกา 15 นาทีเดิม)
      await tg.sendInline(`✗ ผ่านเกตไม่ได้: ${(r && r.reason) || 'ไม่ทราบสาเหตุ'} — ตรวจ: ทุนเสียอัตโนมัติใช้กลุ่ม "ปุ่มกดเอง" (${engine.settings.manualRiskMaxPct || 2}%) • SL กว้างไป/โควตาเต็ม/ข้อมูลไม่สด`);
    }
  });
  function pendingSigConfirmRemove(key) { tgQueueConfirm.delete(key); }
  engine.on('snapshot', async (snap) => {
    send('snapshot', snap);
    autoEnterMain(snap); // เข้าไม้อัตโนมัติฝั่ง main — ทำงานต่อแม้ปิดหน้าต่าง
    // ระบบรอเข้า: แจ้งเตือนทันทีที่โอกาสผ่านทุกเกต (ครั้งเดียวต่อสัญญาณ)
    const approved = (snap.signals || []).filter((x) => !x.held);
    // ไม้เสมือน: แจ้งรายการใหม่ในประวัติรอบ (ลง/ปิดไม้เสมือน)
    for (const r of snap.roundLog || []) {
      if (!(r.ts > tgRoundTs)) continue;
      tgRoundTs = r.ts;
      if (/^(ลงไม้เสมือน|ปิดไม้เสมือน)/.test(r.action)) notify('virtual', `🧪 ${r.action}\n${r.detail}\n${thTime(r.ts)}`);
    }
    for (const s of approved) {
      const tk = `${s.plugin}|${s.side}|${Math.round(s.entry)}`;
      if (!tgSignalSeen.has(tk)) {
        tgSignalSeen.add(tk);
        if (tgSignalSeen.size > 100) tgSignalSeen.clear();
        const sigTxt = `📣 สัญญาณ ${s.side === 'buy' ? 'BUY' : 'SELL'} ${s.confidence}% — ${s.pluginName}\nเข้า ${px(s.entry)} • SL ${px(s.sl)} • TP ${px(s.tp)} • ล็อต ${(s.metrics && s.metrics.lot) || '-'}\n${thTime()}`;
        notify('signal', sigTxt);
        // ปุ่มกดยืนยันจาก Telegram: สัญญาณผ่านทุกด่าน + ส่งจริงเปิด + โหวตมือ (โหมดอัตโนมัติยิงเองอยู่แล้ว = ไม่ส่งซ้ำ)
        if (engine.settings.realOrdersEnabled === true && engine.settings.autoEnter !== true) {
          const sk = `${s.plugin}|${s.side}|${Math.round(s.entry)}`;
          tgQueueConfirm.set(sk, { side: s.side, lot: Math.max(0.01, Number(s.metrics && s.metrics.lot) || 0.01), sl: s.sl, tp: s.tp || 0, entry: s.entry, at: Date.now() });
          if (tgQueueConfirm.size > 40) tgQueueConfirm.delete(tgQueueConfirm.keys().next().value);
          try {
            await tg.sendInline(`${sigTxt}\n\nกดเพื่อส่งไม้จริง (ผ่านเกตความเสี่ยง/โควตาของระบบเดิม • ใช้แชตนี้เท่านั้น):`, [
              [{ text: `✅ เข้าจริง ${s.side === 'buy' ? 'BUY' : 'SELL'}`, callback_data: `sig:${sk}` },
               { text: '✗ ปิดคำเชิญ', callback_data: `skip:${sk}` }],
            ]);
          } catch (e) { engine.pushLog('telegram', `ส่งปุ่มยืนยันไม่สำเร็จ: ${e.message}`, 'warn'); }
        }
      }
      notifyOnce(`${s.plugin}|${s.side}|${Math.round(s.entry)}`,
        `GoldSignal — ${s.side === 'buy' ? 'BUY' : 'SELL'} SIGNAL ${s.confidence}% พร้อมแล้ว!`,
        `${s.pluginName}: เข้า ${s.entry} • SL ${s.sl} • TP ${s.tp} • ล็อต ${(s.metrics && s.metrics.lot) || '-'} • (สภา: ${snap.council ? snap.council.confidence + '%' : '-'})`);
    }
    // จุดรอเข้า: ราคาแตะโซนซื้อ/ขาย → แจ้งหนึ่งครั้งต่อการเข้าโซน
    for (const ev of (snap.entryZoneEvents || [])) {
      if (ev.event !== 'entered') continue;
      notifyOnce(`zone|${ev.side}|${ev.center}|${ev.ts}`,
        ev.side === 'buy' ? 'GoldSignal — BUY ZONE HIT!' : 'GoldSignal — SELL ZONE HIT!',
        `โซน ${ev.side === 'buy' ? 'ซื้อ' : 'ขาย'}: ${ev.bottom}–${ev.top} (${ev.levelType}) • ราคาขณะนี้ ${snap.price} — ตรวจมติสภาและกดปุ่มในแอป`);
      engine.pushLog('zone', `ราคาถึงจุดเข้า${ev.side === 'buy' ? 'ซื้อ' : 'ขาย'}: โซน ${ev.bottom}–${ev.top} ณ ราคา ${snap.price}`);
    }
    // มติเกินเกณฑ์แต่ยังไม่มีสัญญาณ → แจ้ง "ใกล้แล้ว" ครั้งเดียวต่อช่วงมติ
    const c = snap.council;
    if (c && c.side !== 'none' && c.confidence >= (engine.settings.councilMin || 70) && !approved.length) {
      notifyOnce(`near|${c.side}|${Math.floor(c.confidence / 5)}`,
        `GoldSignal — มติสภา ${c.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${c.confidence}%`,
        'ระบบกำลังรอจังหวะเข้า: จะแจ้งอีกครั้งเมื่อสัญญาณสมบูรณ์');
    }
  });

  engine.start();

  // ---------- IPC ----------
  // หน้าต่างเปิดใหม่/รีโหลด: ส่งแท่งเทียนครบทุกไทม์เฟรม (snapshot ปกติส่งเฉพาะส่วนที่เปลี่ยน)
  handle('get-state', () => (engine.lastSnap ? { ...engine.lastSnap, candles: engine.fullCandles() || engine.lastSnap.candles } : null));
  handle('get-settings', () => engine.settings);
  handle('save-settings', (_e, partial) => {
    const oldPoll = engine.settings.pollSec;
    const clean = sanitizeSettings(partial);
    engine.settings = clean;
    writeSettings(clean);
    engine.connectors.mt5.setBridgePath(clean.mt5BridgePath);
    if (oldPoll !== clean.pollSec) { engine.stop(); engine.start(); } // ปรับความถี่ตามการตั้งค่าใหม่ทันที
    engine.pushLog('settings', 'บันทึกการตั้งค่าแล้ว');
    syncKeepAwake();
    // "ตัวช่วยทำงานตลอดเวลา": ตั้งให้แอปวิ่งเองตอนเปิดเครื่อง
    try { app.setLoginItemSettings({ openAtLogin: !!clean.autoStart, openAsHidden: true }); } catch (err) { engine.pushLog('settings', `ตั้ง login item ไม่สำเร็จ: ${err.message}`, 'warn'); }
    return clean;
  });
  handle('list-plugins', () => plugins.list());
  // ประวัติรอบทั้งหมดจากไฟล์ (ใหม่สุดก่อน) — สูงสุด 20,000 รายการต่อครั้ง
  handle('get-round-history', () => {
    try {
      const f = engine.roundStorePath;
      if (!f || !fs.existsSync(f)) return [];
      const out = [];
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line) continue;
        try { const e = JSON.parse(line); if (Number.isFinite(e.ts)) out.push({ ts: e.ts, action: String(e.action || ''), detail: String(e.detail || '') }); } catch { void 0; }
      }
      return out.slice(-20000).reverse();
    } catch (err) { engine.pushLog('app', `อ่านประวัติรอบไม่ได้: ${err.message}`, 'warn'); return []; }
  });
  // หน้าต่างใหม่ "ประวัติรอบทั้งหมด" (เปิดซ้ำ = โฟกัสหน้าต่างเดิม)
  let historyWin = null;
  handle('open-history-window', () => {
    if (historyWin && !historyWin.isDestroyed()) { historyWin.show(); historyWin.focus(); return true; }
    historyWin = new BrowserWindow({
      width: 980, height: 760, minWidth: 640, minHeight: 420,
      title: 'GoldSignal — ประวัติรอบทั้งหมด', backgroundColor: '#07080b',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    historyWin.loadFile(path.join(__dirname, '..', '..', 'renderer', 'history.html'));
    historyWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    historyWin.on('closed', () => { historyWin = null; });
    return true;
  });
  handle('toggle-plugin', (_e, { id, enabled }) => { plugins.setEnabled(id, enabled); return plugins.list(); });
  handle('reload-plugins', () => { plugins.reload(); return plugins.list(); });
  handle('refresh-now', async () => { await engine.tick(); return null; }); // snapshot ไปทาง event อยู่แล้ว — ไม่ต้องส่งซ้ำ
  handle('open-plugins-dir', async (_e, which) => {
    const dir = which === 'builtin' ? builtInPluginsDir : userPluginsDir;
    if (which !== 'builtin') fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });
  // คัดลอก JsonBridgeEA.mq5 เข้าโฟลเดอร์ Experts ของ MetaTrader ในเครื่องโดยอัตโนมัติ
  handle('install-ea', async () => {
    const eaSrc = path.join(root, 'mt5-ea', 'JsonBridgeEA.mq5');
    if (!fs.existsSync(eaSrc)) return { ok: false, msg: 'ไม่พบไฟล์ EA ในแพ็กเกจแอป' };
    const experts = findMql5ExpertsDir();
    if (!experts) return { ok: false, msg: 'ไม่พบโฟลเดอร์ MetaTrader 5 / MQL5 / Experts — ติดตั้ง MT5 แล้วเปิดครั้งแรกก่อน' };
    const dest = path.join(experts, 'GoldSignal');
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(eaSrc, path.join(dest, 'JsonBridgeEA.mq5'));
    // สำรองที่ Downloads ให้ผู้ใช้เห็นด้วยตาเสมอ
    const dl = path.join(os.homedir(), 'Downloads', 'JsonBridgeEA.mq5');
    try { fs.copyFileSync(eaSrc, dl); } catch { /* Downloads อาจถูกจำกัด */ }
    // คอมไพล์แทนผู้ใช้ด้วย wine (ไม่ต้องเปิด MetaEditor ก็ได้)
    const compiled = await compileEA(dest, engine.pushLog);
    return {
      ok: true,
      msg: `คัดลอก EA ไปที่ ${dest} ✓ • ${compiled.msg}`,
      compiled: compiled.ok,
    };
  });
  // ตรวจสถานะ 3 ชั้น: วางไฟล์ / คอมไพล์ / EA ทำงาน (มี bridge JSON สด)
  handle('ea-status', () => {
    const experts = findMql5ExpertsDir();
    const out = { experts: experts || null, mq5: false, ex5: false, bridge: false, bridgePath: null };
    if (experts) {
      const gs = path.join(experts, 'GoldSignal');
      out.mq5 = fs.existsSync(path.join(gs, 'JsonBridgeEA.mq5'));
      out.ex5 = fs.existsSync(path.join(gs, 'JsonBridgeEA.ex5'));
    }
    const conn = engine.connectors.mt5;
    conn._lastWalk = 0; // ผู้ใช้กดตรวจเอง = ค้นหาใหม่ทันที (ไม่รอรอบ 30 วิ)
    conn._scan();
    out.bridge = !!conn.bridgePath;
    out.bridgePath = conn.bridgePath;
    return out;
  });
  // จับผิดพลาดฝั่งหน้าจอ (renderer) ให้ลง log จริง — ห้าม error เงียบอีก
  handle('client-error', (_e, { msg, stack }) => {
    engine.pushLog('renderer', `ผิดพลาด: ${msg}${stack ? ' | ' + stack.split('\n').slice(0, 3).join(' ← ') : ''}`, 'err');
    return true;
  });
  // สกิลเอเจนต์: บันทึกผลงานลงดิสก์ทุก 2 นาที + ตอนออกจากโปรแกรม
  setInterval(() => engine.skills.save(), 120_000);
  app.on('before-quit', () => { try { engine.skills.save(); } catch { void 0; } });
  // ---------- คำสั่งซื้อ/ขายจริง (ผ่าน EA bridge) ----------
  // เกตร่วมของทุกคำสั่ง (ตลาดสด + คำสั่งรอ): บัญชี/EA พร้อม • ข้อมูลสด • สเปก • ทุนเป็น USD — คืนตัวเริ่มส่ง
  const orderGatePre = (side) => {
    const snap = engine.lastSnap || {};
    // เกตระดับ EA/เทอร์มินัล (มีข้อมูลจาก bridge ครั้งที่ EA ใหม่รายงาน)
    const acct = snap.meta && snap.meta.account;
    if (acct && acct.ordersAllowed === false) {
      engine.pushLog('order', 'ปฏิเสธ: EA ตั้ง AllowOrders = false — แก้ที่ Expert List → Properties → Inputs', 'warn');
      return { ok: false, reason: 'EA ยังตั้ง AllowOrders = false — คลิกขวาชาร์ต → Expert List → JsonBridgeEA → Properties → Inputs → AllowOrders = true' };
    }
    if (acct && acct.algoTrading === false) {
      engine.pushLog('order', 'ปฏิเสธ: ปุ่ม AutoTrading ใน MT5 ยังปิด', 'warn');
      return { ok: false, reason: 'เปิดปุ่ม AutoTrading ใน MetaTrader 5 ก่อน (แถบเครื่องมือด้านบน ให้เป็นสีเขียว)' };
    }
    // ข้อมูลต้องสด: bridge อ่านได้ล่าสุด ≤15 วิ และราคาสด ≤5 วิ — ไม่ส่งไม้จากราคา/บัญชีค้าง
    const mt5 = engine.connectors.mt5;
    if (!mt5.isLive()) return { ok: false, reason: `MT5 ไม่ได้อัปเดตข้อมูล (${mt5.status.msg}) — ตรวจว่า MT5 เปิดอยู่และ EA อยู่บนชาร์ต` };
    // มติสภา/บัญชี/สเปกมาจาก snapshot ล่าสุด — ต้องสดและไม่ใช่รอบที่ผิดพลาด (เดิมรอบวิเคราะห์พังแล้ว snapshot ค้างได้ไม่จำกัด)
    if (!snap.ts || Date.now() - snap.ts > 20_000 || snap.error || snap.dataSource !== 'mt5') return { ok: false, reason: 'ข้อมูลวิเคราะห์ล่าสุดไม่สด/ไม่ได้มาจาก MT5 — รอรอบวิเคราะห์ถัดไปแล้วลองใหม่ (ดูแท็บบันทึกถ้ายังไม่หาย)' };
    // EA รุ่นก่อน v1.4 อ่านคำสั่งไม่ออก (บั๊ก StringTrim) และไม่มีวันหมดอายุคำสั่ง → ต้องอัปเดตก่อนส่งไม้จริง
    if (!(snap.meta && snap.meta.spec)) return { ok: false, reason: EA_OUTDATED };
    const quote = quoteFor(side);
    if (!quote) return { ok: false, reason: 'ราคาสดจาก MT5 หยุดเกิน 5 วินาที — รอให้ราคาวิ่งก่อน (ตลาดปิด/เน็ตหลุด?)' };
    // ทุนจริงจาก MT5 แปลงเป็น USD ก่อนคิดเพดาน 2% (บัญชี THB/JPY/… ห้ามนับเป็นดอลลาร์)
    if (acct && !(acct.usdRate > 0)) return { ok: false, reason: `ยังไม่รู้อัตราแลกเปลี่ยน ${acct.currency} → USD จึงคิดเพดานความเสี่ยงไม่ได้ — รอสักครู่ (ต้องต่อเน็ต) หรืออัปเดต EA เป็นเวอร์ชันล่าสุด` };
    const tickEqUSD = acct && Number.isFinite(lastQ.equity) && lastQ.equity > 0 ? lastQ.equity / acct.usdRate : null;
    const liveEquity = tickEqUSD || (acct && acct.equityUSD > 0 ? acct.equityUSD : null);
    const spec = snap.meta && snap.meta.spec;
    const effSettings = {
      ...engine.settings,
      ...(liveEquity ? { equity: liveEquity } : {}),
      ...(spec ? { ozPerLot: spec.contractSize, volMin: spec.volMin } : {}),
    };
    return { ok: true, quote, effSettings, snap, acct, liveEquity };
  };

  // หน้าต่าง/เว็บส่งมา = กลุ่ม "ปุ่มกดเอง" เสมอ (เดิมเชื่อ req.auto จากฝั่งหน้าจอ → ยืมเพดานกลุ่มอัตโนมัติได้)
  // เทียบรุ่น EA แบบตัวเลข (เดิมเทียบสตริง: '1.10' < '1.7' = true → EA รุ่นใหม่ถูกปฏิเสธ)
  const eaBelow = (have, need) => {
    const a = String(have || '').split('.').map(Number), b = String(need).split('.').map(Number);
    if (!a.length || a.some((x) => !Number.isFinite(x))) return true;
    for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x < y; }
    return false;
  };
  handle('send-order', (_e, req) => sendOrderReq({ ...(req || {}), auto: false }));
  function sendOrderReq(req) {
    const side = req.side === 'buy' ? 'buy' : 'sell';
    const g = orderGatePre(side);
    if (!g.ok) return g;
    const v = risk.validateManualOrder({
      side, lot: Number(req.lot), entry: g.quote, sl: Number(req.sl), tp: Number(req.tp) || 0,
      settings: g.effSettings,
      manualToday: engine.manualToday,
      signalsToday: engine.dailyCount,
      auto: req.auto === true,
      allowOverCap: req.allowOverCap === true,
    });
    if (!v.pass) { engine.pushLog('order', `ปฏิเสธคำสั่ง ${side}: ${v.reason}`, 'warn'); return { ok: false, reason: v.reason, warn: v.warn, metrics: v.metrics, overCap: v.overCap === true }; }
    // มติสภาบังคับเหมือนสัญญาณ (สวนมติ/ไร้มติ = กรอง ตามโหมดเข้ม)
    const councilVerdict = g.snap.council || null;
    const gate = gateSignal({ side }, councilVerdict, engine.settings);
    if (!gate.ok) { engine.pushLog('order', `ปฏิเสธคำสั่ง ${side}: ${gate.reason}`, 'warn'); return { ok: false, reason: gate.reason, metrics: v.metrics }; }
    try {
      const { id } = engine.connectors.mt5.sendOrder({ side, lot: v.metrics.lot, sl: Number(req.sl), tp: Number(req.tp) || 0 });
      engine.manualToday++;
      engine.pushLog('order', `ส่งคำสั่งจริง id=${id} ${side.toUpperCase()} ล็อต ${v.metrics.lot} @ ${side === 'buy' ? 'ASK' : 'BID'} ${fmtPrice(g.quote)} SL ${req.sl} TP ${req.tp || '-'} เสี่ยง $${v.metrics.riskUSD} (ทุนที่ใช้คิด: ${g.liveEquity ? `จาก MT5 ≈ $${Math.round(g.liveEquity)}${g.acct && g.acct.currency !== 'USD' ? ` (${g.acct.currency})` : ''}` : 'ตั้งเอง $' + engine.settings.equity})${v.warn ? ' • ⚠ ' + v.warn : ''}`);
      return { ok: true, id, metrics: v.metrics, warn: v.warn };
    } catch (err) {
      engine.pushLog('order', `ส่งคำสั่งไม่ได้: ${err.message}`, 'err');
      return { ok: false, reason: err.message };
    }
  }
  const EA_PENDINGS = 'คำสั่งรอล่วงหน้าต้องมี EA รุ่น 1.7 บนชาร์ต — แท็บ "MT5" → กด "ติดตั้ง EA ให้ฉันเอง" แล้วลาก JsonBridgeEA ลงชาร์ตใหม่ 1 ครั้ง';
  // คำสั่งรอล่วงหน้า: วาง limit/stop รอราคา + SL/TP คุมตั้งแต่วาง (นับโควตาเหมือนไม้จริง)
  handle('send-pending', (_e, req) => {
    const side = req.side === 'buy' ? 'buy' : 'sell';
    const ptype = req.ptype === 'stop' ? 'stop' : 'limit';
    const g = orderGatePre(side);
    if (!g.ok) return g;
    // EA ต้องรุ่นใหม่พอ: pendings มาตั้งแต่ v1.7 (ป้าย "ea" ใน bridge — ป้ายไม่มี/ต่ำกว่า = ปฏิเสธ)
    if (eaBelow(g.snap.meta.ea, '1.7')) return { ok: false, reason: EA_PENDINGS };
    const entry = Number(req.entry);
    if (!Number.isFinite(entry) || entry <= 0) return { ok: false, reason: 'ใส่ราคาเข้า (ราคาที่จะรอ) ก่อน — จะวาง limit/stop นี้ไว้รอเช่นไหน' };
    // ทิศราคาต้องถูกตามชนิด: BUY LIMIT ต่ำกว่าตลาด / BUY STOP สูงกว่าตลาด / SELL LIMIT สูงกว่าตลาด / SELL STOP ต่ำกว่าตลาด
    const ask = g.acct ? Number(g.snap.meta.ask) : null;
    const bid = g.acct ? Number(g.snap.meta.bid) : null;
    const market = side === 'sell' ? bid : ask;
    if (!Number.isFinite(market)) return { ok: false, reason: 'ราคาสดไม่พร้อม — รอบริดจ์ใหม่' };
    let bad = null;
    if (ptype === 'limit' && side === 'buy' && !(entry < market)) bad = `BUY LIMIT ต้องตั้งราคาต่ำกว่าตลาดปัจจุบัน (ตอนนี้ ${fmtPrice(market)})`;
    if (ptype === 'limit' && side === 'sell' && !(entry > market)) bad = `SELL LIMIT ต้องตั้งราคาสูงกว่าตลาดปัจจุบัน (ตอนนี้ ${fmtPrice(market)})`;
    if (ptype === 'stop' && side === 'buy' && !(entry > market)) bad = `BUY STOP ต้องตั้งราคาสูงกว่าตลาดปัจจุบัน (ตอนนี้ ${fmtPrice(market)})`;
    if (ptype === 'stop' && side === 'sell' && !(entry < market)) bad = `SELL STOP ต้องตั้งราคาต่ำกว่าตลาดปัจจุบัน (ตอนนี้ ${fmtPrice(market)})`;
    if (bad) { engine.pushLog('order', `ปฏิเสธคำสั่งรอ: ${bad}`, 'warn'); return { ok: false, reason: bad }; }
    const v = risk.validateManualOrder({
      side, lot: Number(req.lot), entry, sl: Number(req.sl), tp: Number(req.tp) || 0,
      settings: g.effSettings,
      manualToday: engine.manualToday,
      signalsToday: engine.dailyCount,
      auto: req.auto === true,
      allowOverCap: req.allowOverCap === true,
    });
    if (!v.pass) { engine.pushLog('order', `ปฏิเสธคำสั่งรอ ${side}: ${v.reason}`, 'warn'); return { ok: false, reason: v.reason, warn: v.warn, metrics: v.metrics, overCap: v.overCap === true }; }
    if (req.allowOverCap === true && v.metrics.riskUSD > v.metrics.hardMax) engine.pushLog('order', `วางคำสั่งรอ ${side} เกินเพดาน (เสี่ยง $${v.metrics.riskUSD} > $${v.metrics.hardMax}) — ผู้ใช้ยืนยันเอง`, 'warn');
    try {
      const { id } = engine.connectors.mt5.sendPending({ side, ptype, lot: v.metrics.lot, entry: Number(entry), sl: Number(req.sl), tp: Number(req.tp) || 0 });
      engine.manualToday++;
      engine.pushLog('order', `วางคำสั่งรอ id=${id} ${side.toUpperCase()} ${ptype.toUpperCase()} @ ${fmtPrice(entry)} • SL ${req.sl} • TP ${req.tp || '-'} • ล็อต ${v.metrics.lot} — รอ trigger โบรเกอร์`);
      return { ok: true, id, metrics: v.metrics, warn: v.warn };
    } catch (err) {
      engine.pushLog('order', `วางคำสั่งรอไม่ได้: ${err.message}`, 'err');
      return { ok: false, reason: err.message };
    }
  });
  // แก้คำสั่งรอ (ราคาเข้า/SL/TP) — เกตเดียวกับวางคำสั่งรอ แต่ไม่นับโควตา (ไม่ใช่ไม้ใหม่)
  const EA_PMODIFY = 'แก้คำสั่งรอต้องมี EA รุ่น 1.8 บนชาร์ต — แท็บ "MT5" → กด "ติดตั้ง EA ให้ฉันเอง" แล้วลาก JsonBridgeEA ลงชาร์ตใหม่ 1 ครั้ง';
  handle('modify-pending', (_e, req) => {
    const ticket = Number(req && req.ticket);
    const mt5 = engine.connectors.mt5;
    const pendings = (mt5.latest && mt5.latest.meta && mt5.latest.meta.pendings) || [];
    const po = Number.isSafeInteger(ticket) && ticket > 0 ? pendings.find((p) => Number(p.ticket) === ticket) : null;
    if (!po) return { ok: false, reason: `ไม่พบคำสั่งรอ ticket ${req && req.ticket}` };
    const m = /^(buy|sell)(limit|stop)$/.exec(String(po.type));
    if (!m) return { ok: false, reason: `คำสั่งชนิด ${po.type} แก้จากแอปไม่ได้ — แก้ใน MT5` };
    const [, side, ptype] = m;
    const g = orderGatePre(side);
    if (!g.ok) return g;
    if (eaBelow(g.snap.meta.ea, '1.8')) return { ok: false, reason: EA_PMODIFY };
    if ([...mt5.pending.values()].some((c) => Number(c.ticket) === ticket)) return { ok: false, reason: `คำสั่งรอ #${ticket} มีคำสั่งค้างอยู่ — รอผลจาก MT5` };
    const entry = Number(req.entry), sl = Number(req.sl), tp = Number(req.tp) || 0;
    const v = risk.validatePendingModify({ side, ptype, volume: Number(po.volume), entry, sl, tp, curEntry: Number(po.open), curSl: Number(po.sl), market: g.quote, settings: g.effSettings, allowOverCap: req.allowOverCap === true });
    if (!v.pass) { engine.pushLog('order', `ปฏิเสธแก้คำสั่งรอ #${ticket}: ${v.reason}`, 'warn'); return { ok: false, reason: v.reason, metrics: v.metrics, overCap: v.overCap === true }; }
    if (req.allowOverCap === true && v.metrics.riskUSD > v.metrics.hardMax) engine.pushLog('order', `แก้คำสั่งรอ #${ticket} เกินเพดาน (เสี่ยง $${v.metrics.riskUSD} > $${v.metrics.hardMax}) — ผู้ใช้ยืนยันเอง`, 'warn');
    try {
      const { id } = mt5.requestModifyPending(ticket, entry, sl, tp);
      engine.pushLog('order', `แก้คำสั่งรอ #${ticket} id=${id}: ราคา ${fmtPrice(Number(po.open))} → ${fmtPrice(entry)} • SL ${fmtPrice(Number(po.sl))} → ${fmtPrice(sl)} • TP ${Number(po.tp) ? fmtPrice(Number(po.tp)) : '-'} → ${tp ? fmtPrice(tp) : '-'} • เสี่ยง $${v.metrics.riskUSD}`);
      return { ok: true, id, metrics: v.metrics };
    } catch (err) {
      engine.pushLog('order', `แก้คำสั่งรอไม่ได้: ${err.message}`, 'err');
      return { ok: false, reason: err.message };
    }
  });
  handle('cancel-pending', (_e, ticket) => {
    const mt5 = engine.connectors.mt5;
    if (engine.settings.realOrdersEnabled !== true) return { ok: false, reason: 'สวิตช์ "อนุญาตส่งออร์เดอร์จริง" ยังปิดอยู่' };
    try {
      const r = mt5.requestCancelPending(Number(ticket));
      engine.pushLog('order', `ส่งคำสั่งยกเลิกไม้รอ ticket=${ticket}`);
      return { ok: true, ...r };
    } catch (err) { return { ok: false, reason: err.message }; }
  });
  const EA_OUTDATED = 'EA ใน MT5 เป็นรุ่นเก่า (ส่งคำสั่งไม่ได้) — แท็บ "MT5" → กด "ติดตั้ง EA ให้ฉันเอง" แล้วลาก JsonBridgeEA ลงชาร์ตทองใหม่ 1 ครั้ง';
  const fmtPrice = (n) => Number.isFinite(n) ? n.toFixed(2) : '—';
  // ปิดไม้รายตัว: กดครั้งเดียวส่งทันที (ไม่ผูกสวิตช์ส่งออร์เดอร์จริง — การปิดลดความเสี่ยง ต้องเร็ว)
  handle('close-position', (_e, rawTicket) => {
    const mt5 = engine.connectors.mt5;
    // ticket ต้องเป็นเลขจำนวนเต็มของไม้ที่เปิดอยู่จริง (กันข้อความแปลกปลอมถูกเขียนต่อท้ายบรรทัด CMD)
    const ticket = Number(rawTicket);
    const liveMeta = mt5.latest && mt5.latest.meta;
    const positions = (liveMeta && liveMeta.positions) || [];
    if (!Number.isSafeInteger(ticket) || ticket <= 0 || !positions.some((p) => Number(p.ticket) === ticket)) return { ok: false, reason: `ไม่พบไม้ ticket ${rawTicket} ที่เปิดอยู่` };
    if (!mt5.isLive()) return { ok: false, reason: 'MT5 ไม่ได้อัปเดตข้อมูล — ตรวจว่า MT5 เปิดอยู่และ EA อยู่บนชาร์ต' };
    if (!(liveMeta && liveMeta.spec)) return { ok: false, reason: EA_OUTDATED };
    if ([...mt5.pending.values()].some((c) => c.action === 'close' && Number(c.ticket) === ticket)) return { ok: false, reason: `กำลังปิดไม้ #${ticket} อยู่แล้ว — รอผลจาก MT5` };
    try { const r = mt5.requestClose(ticket); engine.pushLog('order', `ส่งคำสั่งปิดไม้ ticket=${ticket}`); return { ok: true, ...r }; }
    catch (err) { return { ok: false, reason: err.message }; }
  });
  // ปิดบางส่วน (ปิดครึ่ง): เกตเดียวกับปิดไม้รายตัว (ไม่ผูกสวิตช์ส่งออร์เดอร์จริง — ลดความเสี่ยง) + EA 1.9 + ล็อตตามสเปกโบรก
  const EA_CLOSEPART = 'ปิดครึ่งต้องมี EA รุ่น 1.9 บนชาร์ต — แท็บ MT5 → กด "ติดตั้ง EA ให้ฉันเอง" แล้วลาก EA ลงชาร์ตใหม่';
  handle('close-partial', (_e, req) => {
    const mt5 = engine.connectors.mt5;
    // ticket ต้องเป็นเลขจำนวนเต็มของไม้ที่เปิดอยู่จริง (กันข้อความแปลกปลอมถูกเขียนต่อท้ายบรรทัด CMD)
    const ticket = Number(req && req.ticket);
    const liveMeta = mt5.latest && mt5.latest.meta;
    const positions = (liveMeta && liveMeta.positions) || [];
    const pos = Number.isSafeInteger(ticket) && ticket > 0 ? positions.find((p) => Number(p.ticket) === ticket) : null;
    if (!pos) return { ok: false, reason: `ไม่พบไม้ ticket ${req && req.ticket} ที่เปิดอยู่` };
    if (!mt5.isLive()) return { ok: false, reason: 'MT5 ไม่ได้อัปเดตข้อมูล — ตรวจว่า MT5 เปิดอยู่และ EA อยู่บนชาร์ต' };
    if (!(liveMeta && liveMeta.spec)) return { ok: false, reason: EA_OUTDATED };
    if (eaBelow(liveMeta.ea, '1.9')) return { ok: false, reason: EA_CLOSEPART };
    if ([...mt5.pending.values()].some((c) => (c.action === 'close' || c.action === 'closepart') && Number(c.ticket) === ticket)) return { ok: false, reason: `กำลังปิดไม้ #${ticket} อยู่แล้ว — รอผลจาก MT5` };
    const cv = checkPartialVolume({ volume: req.volume, posVolume: pos.volume, volMin: liveMeta.spec.volMin, volStep: liveMeta.spec.volStep });
    if (!cv.ok) { engine.pushLog('order', `ปฏิเสธปิดบางส่วน #${ticket}: ${cv.reason}`, 'warn'); return { ok: false, reason: cv.reason }; }
    try {
      const r = mt5.requestClosePartial(ticket, cv.volume);
      engine.pushLog('order', `ส่งคำสั่งปิดบางส่วน ticket=${ticket} ล็อต ${cv.volume} จาก ${pos.volume} (เหลือ ${cv.remain}) id=${r.id}`);
      return { ok: true, ...r };
    } catch (err) {
      engine.pushLog('order', `ปิดบางส่วนไม่ได้: ${err.message}`, 'err');
      return { ok: false, reason: err.message };
    }
  });
  // แก้ SL/TP ไม้ที่เปิดอยู่ — ผ่านเกตเดียวกับการส่งไม้ (สวิตช์จริง/ข้อมูลสด/EA) แต่ไม่นับโควตา
  handle('modify-position', (_e, req) => {
    const ticket = Number(req && req.ticket);
    const mt5 = engine.connectors.mt5;
    const positions = (mt5.latest && mt5.latest.meta && mt5.latest.meta.positions) || [];
    const pos = Number.isSafeInteger(ticket) && ticket > 0 ? positions.find((p) => Number(p.ticket) === ticket) : null;
    if (!pos) return { ok: false, reason: `ไม่พบไม้ ticket ${req && req.ticket} ที่เปิดอยู่` };
    const side = pos.type === 'buy' ? 'buy' : 'sell';
    // ราคาปิดของไม้: ซื้อปิดที่ BID / ขายปิดที่ ASK
    const g = orderGatePre(side === 'buy' ? 'sell' : 'buy');
    if (!g.ok) return g;
    if ([...mt5.pending.values()].some((c) => Number(c.ticket) === ticket)) return { ok: false, reason: `ไม้ #${ticket} มีคำสั่งค้างอยู่ — รอผลจาก MT5` };
    const sl = Number(req.sl), tp = Number(req.tp) || 0;
    const v = risk.validateModify({ side, open: Number(pos.open), volume: Number(pos.volume), curSl: Number(pos.sl), sl, tp, market: g.quote, settings: g.effSettings, allowOverCap: req.allowOverCap === true });
    if (!v.pass) { engine.pushLog('order', `ปฏิเสธแก้ไม้ #${ticket}: ${v.reason}`, 'warn'); return { ok: false, reason: v.reason, metrics: v.metrics, overCap: v.overCap === true }; }
    if (req.allowOverCap === true && v.metrics.riskUSD > v.metrics.hardMax) engine.pushLog('order', `แก้ไม้ #${ticket} เกินเพดาน (เสี่ยง $${v.metrics.riskUSD} > $${v.metrics.hardMax}) — ผู้ใช้ยืนยันเอง`, 'warn');
    try {
      const { id } = mt5.requestModify(ticket, sl, tp);
      engine.pushLog('order', `แก้ไม้ #${ticket} id=${id}: SL ${fmtPrice(Number(pos.sl))} → ${fmtPrice(sl)} • TP ${Number(pos.tp) ? fmtPrice(Number(pos.tp)) : '-'} → ${tp ? fmtPrice(tp) : '-'} • เสี่ยง $${v.metrics.riskUSD}`);
      return { ok: true, id, metrics: v.metrics };
    } catch (err) {
      engine.pushLog('order', `แก้ไม้ไม่ได้: ${err.message}`, 'err');
      return { ok: false, reason: err.message };
    }
  });
  // ปุ่มฉุกเฉิน "ปิดทุกไม้": ปิดทุกไม้ XAUUSD ที่ EA รายงานว่าเปิดอยู่ ณ ราคาตลาด
  // ไม่ผูกกับสวิตช์ส่งออร์เดอร์จริง และไม่มีหน้ายืนยัน (การปิดลดความเสี่ยง ต้องทันตลาด)
  handle('close-all', () => {
    const mt5 = engine.connectors.mt5;
    const meta = mt5.latest && mt5.latest.meta; // รายการไม้จากไฟล์ bridge ล่าสุด (ไม่พึ่งรอบวิเคราะห์ — ใช้ได้แม้ engine มีปัญหา)
    if (!mt5.isLive()) return { ok: false, reason: 'MT5 ไม่ได้อัปเดตข้อมูล — ตรวจว่า MT5 เปิดอยู่และ EA อยู่บนชาร์ต (ปิดไม้เองใน MT5 ได้ทันที)' };
    if (!(meta && meta.spec)) return { ok: false, reason: EA_OUTDATED };
    const tickets = (meta.positions || []).map((p) => Number(p.ticket)).filter((t) => Number.isSafeInteger(t) && t > 0);
    // ticket ที่มีคำสั่งปิดค้างอยู่แล้ว ไม่ส่งซ้ำ
    const closing = new Set([...mt5.pending.values()].filter((c) => c.action === 'close').map((c) => Number(c.ticket)));
    const todo = tickets.filter((t) => !closing.has(t));
    if (!todo.length) return { ok: false, reason: tickets.length ? 'กำลังปิดทุกไม้อยู่แล้ว — รอผลจาก MT5' : 'ไม่มีไม้ที่เปิดอยู่' };
    try {
      const { ids } = mt5.requestCloseAll(todo);
      engine.pushLog('order', `ปิดทุกไม้: ส่งคำสั่งปิด ${ids.length} ไม้ (tickets ${todo.join(', ')})`, 'warn');
      return { ok: true, count: ids.length, ids };
    } catch (err) {
      engine.pushLog('order', `ปิดทุกไม้ไม่สำเร็จ: ${err.message}`, 'err');
      return { ok: false, reason: err.message };
    }
  });
  // เลนราคาเร็ว: เหตุการณ์ไฟล์ (fs.watch) = รู้ทันทึงราคาเปลี่ยน — โพลเป็นแผนสำรอง
  // ---------- เข้าไม้อัตโนมัติ (autoEnter) — ย้ายจากหน้าต่างมา main: ปิดหน้าต่างแล้วยังทำงาน ----------
  // ผ่าน sendOrderReq เดิม (เกตความเสี่ยง/มติสภา/โควตา/ข้อมูลสดครบทุกชั้นเหมือนกดมือ)
  const autoEntered = new Set();      // สัญญาณที่ส่งแล้ว (กันซ้ำ)
  const autoRejectedAt = new Map();   // สัญญาณที่เกตปฏิเสธ → ลองใหม่ได้หลัง 60 วิ (กัน log/แจ้งเตือนรัว)
  const sigKey = (x) => `${x.plugin || '?'}|${x.side}|${x.ts || ''}`;
  function autoEnterMain(snap) {
    const s = engine.settings;
    if (s.realOrdersEnabled !== true || s.autoEnter !== true) {
      // มีโอกาสผ่านทุกด่านแต่สวิตช์ยังปิด = บอกเหตุผลลง log (ครั้งเดียว / 10 นาที ไม่กลั่นแกล้ง log)
      const approved = (snap.signals || []).find((x) => !x.held);
      if (approved) {
        const why = s.realOrdersEnabled !== true ? 'สวิตช์ "ส่งออร์เดอร์จริง" ยังปิด' : 'สวิตช์ "เข้าอัตโนมัติ" ยังปิด (รอยืนยันในหน้าจอ/เว็บ)';
        const k = 'sw-' + (s.realOrdersEnabled ? 0 : 1);
        if (!(engine._autoSkippedAt && engine._autoSkippedAt[k] > Date.now() - 600_000)) {
          engine._autoSkippedAt = engine._autoSkippedAt || {};
          engine._autoSkippedAt[k] = Date.now();
          engine.pushLog('auto', `มีโอกาสผ่านทุกด่าน (${approved.side.toUpperCase()}) แต่${why} — ไม่ได้ส่งไม้จริง เปิดสวิตช์ในแท็บ การวม แผงส่งคำสั่ง (หรือกดยืนยันนอกหน้าจอใน 15 นาที)`, 'warn');
        }
      }
      return;
    }
    const now = Date.now();
    const sig = (snap.signals || []).find((x) => !x.held && !autoEntered.has(sigKey(x)) && !(now - (autoRejectedAt.get(sigKey(x)) || 0) < 60_000));
    if (!sig || !Number.isFinite(sig.sl) || sig.sl <= 0) return;
    const key = sigKey(sig);
    const lot = Math.max(0.01, Number(sig.metrics && sig.metrics.lot) || 0.01);
    autoEntered.add(key);
    if (autoEntered.size > 200) autoEntered.delete(autoEntered.values().next().value);
    let r;
    try { r = sendOrderReq({ side: sig.side, lot, sl: sig.sl, tp: sig.tp || 0, auto: true }); }
    catch (err) { r = { ok: false, reason: err.message }; }
    const c = snap.council && snap.council.confidence != null ? `มติสภา ${snap.council.confidence}%` : '-';
    if (r && r.ok) {
      const msg = `เข้าไม้เองอัตโนมัติ: ${sig.side === 'buy' ? 'BUY' : 'SELL'} ล็อต ${r.metrics ? r.metrics.lot : lot} • SL ${sig.sl} • TP ${sig.tp || '-'} (${c}) — รอผลจาก MT5`;
      send('auto-enter', { ok: true, msg });
      notifyOnce('autoenter-' + key, 'GoldSignal: เข้าไม้อัตโนมัติ', msg);
    } else {
      autoEntered.delete(key);
      autoRejectedAt.set(key, now);
      if (autoRejectedAt.size > 200) autoRejectedAt.delete(autoRejectedAt.keys().next().value);
      send('auto-enter', { ok: false, msg: `ระบบขอเข้าไม้อัตโนมัติแต่ถูกกันเหนียวปฏิเสธ — ${(r && r.reason) || 'เกตไม่ผ่าน'}` });
    }
  }

  // ---------- กันเครื่องหลับ: เปิดเมื่อระบบอัตโนมัติใดทำงาน (เข้าไม้เอง / ปิดอัตโนมัติ) ----------
  let keepAwakeId = null;
  function syncKeepAwake() {
    const s = engine.settings;
    const need = (s.realOrdersEnabled === true && s.autoEnter === true) || s.autoCloseAll === true || s.autoCloseLoss === true || s.autoCloseAllPts === true || s.autoClosePoints === true || s.autoCloseLosingOnly === true;
    const on = keepAwakeId != null && powerSaveBlocker.isStarted(keepAwakeId);
    if (need && !on) { keepAwakeId = powerSaveBlocker.start('prevent-app-suspension'); engine.pushLog('app', 'กันเครื่องหลับ: เปิด (ระบบอัตโนมัติทำงานอยู่ — จอดับได้ แต่เครื่องไม่หลับ)'); }
    else if (!need && on) { powerSaveBlocker.stop(keepAwakeId); keepAwakeId = null; engine.pushLog('app', 'กันเครื่องหลับ: ปิด (ไม่มีระบบอัตโนมัติเปิดอยู่)'); }
  }
  syncKeepAwake();

  // ---------- ปิดอัตโนมัติเพื่อเซฟกำไร (ปิดรวบ / ปิดรายไม้ตามจุด) ----------
  // ใช้ราคาสดทุกทิค • ไม่ผูกสวิตช์ส่งออร์เดอร์จริง (การปิดลดความเสี่ยง เหมือนปุ่มปิด) • ไม้ที่สั่งปิดแล้วรอ 20 วิ ไม่ส่งซ้ำ
  const autoCloseBusy = new Map(); // ticket → เวลาที่ส่งคำสั่งปิด
  function autoCloseCheck() {
    const s = engine.settings;
    if (s.autoCloseAll !== true && s.autoCloseLoss !== true && s.autoCloseAllPts !== true && s.autoClosePoints !== true && s.autoCloseLosingOnly !== true) return;
    const mt5 = engine.connectors.mt5;
    const meta = mt5.latest && mt5.latest.meta;
    if (!meta || !meta.spec || !(meta.positions || []).length || !mt5.isLive()) return;
    if (!lastQ || !lastQ.fresh || Date.now() - lastQ.t > 5000) return;
    const now = Date.now();
    for (const [t, at] of autoCloseBusy) if (now - at > 20_000) autoCloseBusy.delete(t);
    const skip = new Set([...autoCloseBusy.keys(), ...[...mt5.pending.values()].filter((c) => c.action === 'close').map((c) => Number(c.ticket))]);
    const p = autoclose.plan({ positions: meta.positions, bid: lastQ.bid, ask: lastQ.ask, spec: meta.spec, digits: meta.digits, settings: s, skip });
    const cur = (meta.account && meta.account.currency) || '';
    try {
      if (p.closeAll.length) {
        mt5.requestCloseAll(p.closeAll);
        p.closeAll.forEach((t) => autoCloseBusy.set(t, now));
        const why = p.trigger === 'loss'
          ? `ขาดทุนรวม ≈ ${p.total.toFixed(2)} ${cur} ถึงจุดตัด -${s.autoCloseLossValue} ${cur}`
          : p.trigger === 'points'
          ? `จุดรวม ${Math.round(p.totalPts)} จุด ถึงเป้า ${s.autoCloseAllPtsValue} จุด (≈ ${p.total.toFixed(2)} ${cur})`
          : `กำไรรวม ≈ ${p.total.toFixed(2)} ${cur} ถึงเป้า ${s.autoCloseAllProfit} ${cur}`;
        const msg = `${p.trigger === 'loss' ? 'ตัดขาดทุนรวบอัตโนมัติ' : 'ปิดรวบอัตโนมัติ'}: ${why} — สั่งปิด ${p.closeAll.length} ไม้`;
        engine.pushLog('order', '🔒 ' + msg, 'warn');
        send('auto-close', { kind: 'all', msg, tickets: p.closeAll });
        notifyOnce('autoclose-all-' + p.closeAll.join('-'), p.trigger === 'loss' ? 'GoldSignal: ตัดขาดทุนรวบ' : 'GoldSignal: ปิดรวบเซฟกำไร', msg);
        return;
      }
      for (const x of p.singles) {
        mt5.requestClose(x.ticket);
        autoCloseBusy.set(x.ticket, now);
        const msg = p.trigger === 'lossonly'
          ? `ตัดขาดทุนเฉพาะไม้แดง: ขาดทุนรวม ${p.total.toFixed(2)} ${cur} ถึงเป้า ${s.autoCloseLosingOnlyValue} ${cur} — ปิดไม้ #${x.ticket} (ลอยตัว ${x.profit.toFixed(2)} ${cur}) เก็บไม้ที่บวกไว้`
          : `ปิดไม้ #${x.ticket} อัตโนมัติ: บวก ${Math.round(x.pts)} จุด ถึงเป้า ${s.autoClosePointsValue} จุด (≈ ${x.profit.toFixed(2)} ${cur})`;
        engine.pushLog('order', '🔒 ' + msg, 'warn');
        send('auto-close', { kind: 'one', msg, tickets: [x.ticket] });
        notifyOnce('autoclose-' + x.ticket, p.trigger === 'lossonly' ? 'GoldSignal: ตัดขาดทุนเฉพาะไม้แดง' : 'GoldSignal: ปิดไม้เซฟกำไร', msg);
      }
    } catch (err) {
      engine.pushLog('order', `ปิดอัตโนมัติไม่สำเร็จ: ${err.message}`, 'err');
    }
  }
  // ---------- Telegram: ติดตามไม้จริงเข้า/ปิด จากรายการไม้ใน bridge (ครอบคลุมทั้งไม้จากแอป, คำสั่งรอ trigger, เปิดเองใน MT5) ----------
  let tgKnown = null;              // ticket → position ล่าสุดที่เห็น
  const tgClosing = new Map();     // ticket → { p, at } รอประวัติปิดจาก EA (กำไรจริง + เหตุผล)
  const REASON_TH = { TP: 'ถึง TP 🎯', SL: 'โดน SL', SO: 'Stop out', manual: 'ปิดเอง' };
  function tgTrackPositions() {
    const mt5 = engine.connectors.mt5;
    const meta = mt5.latest && mt5.latest.meta;
    if (!meta || !mt5.isLive()) return;
    const cur = new Map((meta.positions || []).map((p) => [Number(p.ticket), p]));
    if (tgKnown === null) { tgKnown = cur; return; } // รอบแรกหลังเปิดแอป: จำไว้เฉยๆ ไม่แจ้งไม้เก่า
    const cc = (meta.account && meta.account.currency) || '';
    const pt = Math.pow(10, -(meta.digits || 2));
    for (const [t, p] of cur) {
      if (tgKnown.has(t)) continue;
      notify('realOpen', `🟢 เข้าไม้จริง ${p.type === 'buy' ? 'BUY' : 'SELL'} ${Number(p.volume).toFixed(2)} ล็อต @ ${px(p.open)}\nSL ${px(p.sl)} • TP ${px(p.tp)}\nticket #${t} • ${thTime()}`);
    }
    for (const [t, p] of tgKnown) if (!cur.has(t) && !tgClosing.has(t)) tgClosing.set(t, { p, at: Date.now(), auto: autoCloseBusy.has(t) });
    tgKnown = cur;
    for (const [t, w] of tgClosing) {
      const h = (meta.history || []).find((x) => Number(x.pid) === t);
      if (!h && Date.now() - w.at < 30_000) continue;
      tgClosing.delete(t);
      const p = w.p;
      const close = h ? Number(h.close) : null;
      const profit = h ? Number(h.profit) : Number(p.profit);
      const pts = close != null ? ((p.type === 'buy' ? close - p.open : p.open - close) / pt) : null;
      const why = w.auto ? 'ระบบปิดอัตโนมัติ 🔒' : h ? (REASON_TH[h.reason] || h.reason) : 'ปิดแล้ว';
      notify('realClose', `${profit >= 0 ? '✅' : '❌'} ปิดไม้ ${p.type === 'buy' ? 'BUY' : 'SELL'} ${Number(p.volume).toFixed(2)} ล็อต @ ${px(p.open)} → ${close != null ? px(close) : '-'} (${why})\n${profit >= 0 ? 'กำไร +' : 'ขาดทุน '}${profit.toFixed(2)} ${cc}${pts != null ? ` (${pts >= 0 ? '+' : ''}${Math.round(pts)} จุด)` : ''}\nticket #${t} • ${thTime()}`);
    }
  }
  setInterval(tgTrackPositions, 2000);
  // ระบบ: MT5 หลุดเกิน 60 วิ / กลับมา • tunnel ล่ม
  let tgMt5Down = null, tgMt5Alerted = false, tgTunState = 'off';
  setInterval(() => {
    const live = engine.connectors.mt5.isLive();
    if (!live) {
      if (tgMt5Down == null) tgMt5Down = Date.now();
      if (!tgMt5Alerted && Date.now() - tgMt5Down > 60_000) { tgMt5Alerted = true; notify('system', `⚠️ MT5 ไม่อัปเดตข้อมูลเกิน 1 นาที — ตรวจว่า MT5 เปิดอยู่และ EA อยู่บนชาร์ต\n(ไม้ที่เปิดอยู่ยังมี SL/TP ที่โบรกเกอร์)\n${thTime()}`); }
    } else {
      if (tgMt5Alerted) notify('system', `✅ MT5 กลับมาเชื่อมต่อแล้ว\n${thTime()}`);
      tgMt5Down = null; tgMt5Alerted = false;
    }
    const ts = tunnel.status();
    if (ts.state === 'error' && tgTunState !== 'error') notify('system', `⚠️ tunnel ${ts.provider} ล่ม: ${ts.msg}\n${thTime()}`);
    tgTunState = ts.state;
  }, 10_000);
  let lastQ = null;
  const pushTick = () => {
    try {
      const q = engine.connectors.mt5.pollQuotes();
      if (!q || !q.fresh) { lastQ = null; return; } // ราคาหยุด/MT5 หลุดเซิร์ฟเวอร์ = ห้ามใช้ราคาเก่าส่งไม้
      const changed = !lastQ || lastQ.bid !== q.bid || lastQ.ask !== q.ask;
      lastQ = q; // อายุไฟล์ราคา (t) + ทุนสด อัปเดตทุกครั้ง แม้ราคานิ่ง (เดิมราคานิ่ง 5 วิ = ถูกปฏิเสธว่าราคาหยุด)
      autoCloseCheck(); // ตรวจเป้าเซฟกำไรทุกทิค
      if (changed) send('tick', q);
    } catch { void 0; }
  };
  engine.connectors.mt5.watch((ev) => {
    if (ev === 'quotes') pushTick();                                  // ราคาสด → ส่งทันที (EA v1.6 เขียนทุกทิค สูงสุด ~10 ครั้ง/วิ)
    else if (ev === 'bridge') scheduleFastTick();                     // แท่งใหม่ → วิเคราะห์เลย ไม่รอรอบโพล
    else if (ev === 'results') drainResults();                        // ผลออร์เดอร์มาแล้ว → แจ้งทันที
  });
  let fastTickTimer = null;
  function scheduleFastTick() {
    if (fastTickTimer) return;
    fastTickTimer = setTimeout(() => { fastTickTimer = null; engine.tick().catch(() => {}); }, 900); // รวมเหตุการณ์หนึ่งครั้ง/วิ
  }
  // อ่านผลจาก EA (pollResults ดึงแล้วลบออกจากคิว — เรียกซ้ำได้ปลอดภัย)
  function drainResults() {
    let results = [];
    try { results = engine.connectors.mt5.pollResults(); } catch (err) { engine.pushLog('order', `อ่านผลจาก MT5 ไม่ได้: ${err.message}`, 'warn'); }
    for (const r of results) {
      // ไม้เปิดที่ไม่สำเร็จ (โบรกปฏิเสธ/หมดอายุ) ไม่ได้เข้าตลาด → คืนโควตาวันนี้
      if (r.status !== 'ok' && r.cmd && r.cmd.action === 'open') engine.manualToday = Math.max(0, engine.manualToday - 1);
      engine.pushLog('order', `ผล id=${r.id}: ${r.status === 'ok' ? '✅ ทำสำเร็จ' : '❌ ล้มเหลว — ' + r.msg} (retcode ${r.retcode}, ticket ${r.ticket || '-'})`, r.status === 'ok' ? 'info' : 'err');
      send('order-result', r);
      const a = r.cmd && r.cmd.action;
      if (r.status !== 'ok') notify('orderFail', `❌ คำสั่ง ${a === 'closepart' ? 'ปิดบางส่วน' : a || '-'} ล้มเหลว: ${r.msg} (retcode ${r.retcode})${r.cmd && r.cmd.ticket ? ' • ticket #' + r.cmd.ticket : ''}\n${thTime()}`);
      else if (a === 'limit' || a === 'stop') notify('pending', `⏳ วางคำสั่งรอ ${String(r.cmd.side).toUpperCase()} ${a.toUpperCase()} ล็อต ${r.cmd.lot} @ ${px(r.cmd.entry)} • SL ${px(r.cmd.sl)} • TP ${px(r.cmd.tp)}\nticket #${r.ticket || '-'} • ${thTime()}`);
      else if (a === 'cancel') notify('pending', `🗑 ยกเลิกคำสั่งรอ #${r.cmd.ticket}\n${thTime()}`);
      else if (a === 'closepart') notify('realClose', `✂️ ปิดบางส่วน ${r.cmd.lot} ล็อต @ ${px(r.price)}\nticket #${r.cmd.ticket} • ${thTime()}`);
      else if (a === 'pmodify' || a === 'modify') notify('pending', `✏️ แก้${a === 'pmodify' ? 'คำสั่งรอ' : ' SL/TP ไม้'} #${r.cmd.ticket}: SL ${px(r.cmd.sl)} • TP ${px(r.cmd.tp)}${a === 'pmodify' ? ' • ราคา ' + px(r.cmd.entry) : ''}\n${thTime()}`);
    }
  }
  // โพล fallback ทุก 250ms — เร็วเท่าจังหวะที่ EA เขียนราคา (ครอบคลุมถ้า watch ใช้ไม่ได้บนเครื่องนั้น)
  // (pushTick กรองซ้ำเอง: ส่งต่อ renderer เฉพาะเมื่อ bid/ask เปลี่ยน)
  const quoteLane = setInterval(pushTick, 250);
  // ราคาสดต้องมาไม่เกิน 5 วิ (t = เวลาไฟล์ราคาจริง)
  const quoteFor = (side) => (lastQ && lastQ.fresh && Date.now() - lastQ.t < 5000 ? (side === 'buy' ? lastQ.ask : lastQ.bid) : null);
  // วงจรอ่านผลจาก EA ทุก 2 วินาที + ถอนคำสั่งที่ EA ไม่หยิบภายใน 15 วิ
  // (เดิมค้างในไฟล์ไม่มีกำหนด → MT5 เปิดใหม่เมื่อไรก็ยิงไม้ที่ราคาตอนนั้น ไม่ใช่ราคาที่ผู้ใช้ยืนยัน)
  setInterval(() => {
    drainResults();
    for (const c of engine.connectors.mt5.expirePending()) {
      if (c.action === 'open') engine.manualToday = Math.max(0, engine.manualToday - 1);
      const msg = `คำสั่ง id=${c.id} (${c.action}) หมดอายุ — MT5 ไม่ได้หยิบภายใน 15 วิ จึงยกเลิกแล้ว ไม่มีไม้เข้า • สาเหตุที่พบบ่อย: (1) EA ตั้ง AllowOrders = false (2) ปุ่ม AutoTrading ใน MT5 ยังไม่เขียว (3) MT5/ตลาดปิดอยู่`;
      engine.pushLog('order', msg, 'warn');
      send('order-result', { id: c.id, status: 'stale', msg, cmd: c });
      notify('orderFail', `⏳ ${msg}\n${thTime()}`);
    }
  }, 2000);
  handle('pick-bridge-file', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'เลือกไฟล์ goldsignal_bridge.json',
      properties: ['openFile'],
      filters: [{ name: 'Bridge JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    engine.connectors.mt5.setBridgePath(r.filePaths[0]);
    engine.settings.mt5BridgePath = r.filePaths[0];
    writeSettings(sanitizeSettings(engine.settings));
    return r.filePaths[0];
  });

  // ---------- ตัวตรวจเวอร์ชันใหม่: ปุ่มตรวจเอง + อัตโนมัติทุก 6 ชม. + ครั้งแรกหลังเปิด 20 วิ ----------
  handle('update-check', async () => { await checkAppUpdate(engine, notifyOnce); return { latest: engine.lastUpdateNotified || null, current: app.getVersion() }; });
  setInterval(() => checkAppUpdate(engine, notifyOnce), 6 * 3600_000);
  setTimeout(() => checkAppUpdate(engine, notifyOnce), 20_000);
}

// ---------- ตรวจเวอร์ชันใหม่ (โปรแกรมอัปเดตแบบเบา): GitHub Releases เทียบ semver -------
const REPO = 'ProgramZa2560/GoldSignal';
const semverParts = (s) => String(s || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
function isNewer(newV, curV) {
  const a = semverParts(newV), b = semverParts(curV);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}
async function checkAppUpdate(engine, notifyOnce) {
  try {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'user-agent': 'GoldSignal' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return;
    const j = await res.json();
    const tag = String(j.tag_name || '').replace(/^v/i, '');
    if (isNewer(tag, app.getVersion()) && engine.lastUpdateNotified !== tag) {
      engine.lastUpdateNotified = tag;
      engine.pushLog('app', `🚀 มีเวอร์ชันใหม่ ${tag} (รุ่นนี้ ${app.getVersion()}) — เปิด https://github.com/${REPO}/releases เพื่อโหลด DMG`, 'info');
      notifyOnce(`update-${tag}`, `GoldSignal ${tag} ออกแล้ว`, `แตะเพื่อเปิดหน้าดาวน์โหลด (ตอนนี้: ${app.getVersion()})`, `https://github.com/${REPO}/releases`);
    }
  } catch (e) { void e; } // เน็ตหลุด/Rate limit = งานเสริม ไม่ทำให้ระบบหยุด
}

// กันแอปล้มจาก error ที่ไม่ได้ดักไว้ (เช่น ไฟล์ bridge ถูกลบกลางการอ่าน) — บันทึกแล้วทำงานต่อ
process.on('uncaughtException', (err) => { try { fileLogger()('process', `uncaught: ${err && err.stack || err}`, 'err'); } catch { void 0; } });
process.on('unhandledRejection', (err) => { try { fileLogger()('process', `unhandled rejection: ${err && err.stack || err}`, 'err'); } catch { void 0; } });

app.whenReady().then(() => {
  createWindow();
  boot();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  // macOS: ปิดหน้าต่าง = แอปยัอยู่ใน dock และวิเคราะห์ต่อเนื่อง (คลิก dock จะเปิดหน้าต่างใหม่)
  if (process.platform !== 'darwin') app.quit();
});
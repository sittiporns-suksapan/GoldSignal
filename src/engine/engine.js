'use strict';

// ============================================================
// AnalysisEngine — วนวิเคราะห์ตลอดเวลา:
//   เลือกแหล่งข้อมูล (MT5 → Yahoo อัตโนมัติ) → analyze → plugin strategies
//   → normalize → ตรวจกฎความเสี่ยง → กรองซ้ำ/คูลดาวน์/โควตาวัน → snapshot
// สัญญาณที่ปฏิเสธจะถูกเก็บพร้อมเหตุผล เพื่อให้ผู้ใช้เชื่อใจได้ว่ากฎทำงาน
// ============================================================

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { analyzeMarket } = require('./analysis');
const { runCouncil, gateSignal, AGENTS } = require('./council');
const sessions = require('./sessions');
const { buildEntryPlan } = require('./entryplan');
const { SkillBook } = require('./skillbook');
const { CouncilStats } = require('./councilstats');
const ind = require('./indicators');
const risk = require('./risk');

const ZONE_REENTRY_MS = 15 * 60_000;
// ตัวชี้วัดชุดที่ plugin เห็น: แช่แข็ง (plugin แก้ฟังก์ชันที่สภา/กฎความเสี่ยงใช้ร่วมไม่ได้)
const PLUGIN_IND = Object.freeze({ ...ind });
// จำนวนแท่งที่ส่งให้ renderer ต่อไทม์เฟรม
const CANDLE_LIMIT = { M1: 380, M5: 300, M15: 320, H1: 300 };

class AnalysisEngine extends EventEmitter {
  constructor({ settings, connectors, pluginLoader, logger = () => {}, skillsPath = null, zoneStorePath = null, roundStorePath = null, appVersion = '1.1.0' } = {}) {
    super();
    this.appVersion = appVersion;
    this.settings = settings;
    this.connectors = connectors;                 // { mt5, yahoo }
    this.plugins = pluginLoader;
    this.logger = logger;
    this.skills = new SkillBook({ storePath: skillsPath, logger });
    // สมุดผลงานของสภาทั้งคณะ: จดมติทุกรอบ → ตรวจผลหลัง 30 นาที → ปรับความมั่นใจของมติใหม่ตามอัตราชนะจริง
    this.councilStats = new CouncilStats({ storePath: skillsPath ? skillsPath.replace(/agent-skills\.json$/, 'council-stats.json') : null, logger });
    this.zoneOpen = [];      // ไม้เสมือนที่เปิดจากจุดรอเข้า (ยังไม่จบ)
    this.zoneHistory = [];   // ไม้เสมือนที่จบแล้ว (ring)
    this.zoneStorePath = zoneStorePath || null;
    this.roundStorePath = roundStorePath || null; // ประวัติรอบทั้งหมด (JSONL ต่อท้าย) — หน้าต่าง "ดูทั้งหมด" อ่านจากไฟล์นี้
    this._loadZoneHistory();
    this.timer = null;
    this.busy = false;
    this.lastSnap = null;
    this.active = new Map();    // key plugin+side → { entry, sl, tp, ts }
    this.lastIssue = new Map(); // key plugin+side → ts (คูลดาวน์)
    this.dailyCount = 0;
    this.day = new Date().toDateString();
    this.logs = [];
    this.manualToday = 0;   // จำนวนคำสั่งจริงที่ส่งมาจากปุ่มของผู้ใช้วันนี้ (นับรวมโควตากับสัญญาณ)
    this.pushLog = (tag, msg, lvl = 'info') => {
      this.logs.push({ t: Date.now(), tag, msg: String(msg).slice(0, 220), lvl });
      if (this.logs.length > 120) this.logs = this.logs.slice(-100);
      logger(tag, msg, lvl);
    };
  }

  start() {
    if (this.timer) return;
    const sec = Math.max(5, Number(this.settings.pollSec) || 10);
    this.timer = setInterval(() => this.tick(), sec * 1000);
    this.tick();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  pickConnector() {
    const src = this.settings.source || 'auto';
    const mt5 = this.connectors.mt5, yahoo = this.connectors.yahoo;
    if (src === 'mt5') return { c: mt5, note: mt5.status };
    if (src === 'yahoo') return { c: yahoo, fallback: false };
    // auto: ใช้ MT5 เมื่อ bridge พร้อม ไม่เช่นนั้น fallback Yahoo
    if (mt5.available()) return { c: mt5, note: mt5.status };
    return { c: yahoo, fallbackReason: 'MT5 bridge ยังไม่พร้อม → ใช้ข้อมูลฟรีชั่วคราว' };
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this._tickOnce();
    } catch (err) {
      this.pushLog('engine', `รอบวิเคราะห์ผิดพลาด: ${(err && err.message) || err}`, 'err');
    } finally {
      this.busy = false;
    }
  }

  async _tickOnce() {
      this._rolloverDay();
      this.tickCount = (this.tickCount || 0) + 1;
      const { c, fallbackReason } = this.pickConnector();
      this._openedRefs = [];
      this._closedThisRound = [];
      let data;
      try { data = await c.fetch(this.settings.yahooSymbol || 'GC=F'); }
      catch (err) { this.logger('engine', `${c.label}: ${err.message}`, 'warn'); }
      // ถ้าแหล่งหลักล้ม ลองอีกตัว
      if (!data && this.settings.source !== 'mt5' && c !== this.connectors.yahoo) {
        try { data = await this.connectors.yahoo.fetch(this.settings.yahooSymbol || 'GC=F'); } catch (err) { this.logger('engine', `fallback: ${err.message}`, 'warn'); }
      }
      if (!data) {
        this.lastSnap = this._snapshot({ error: 'ไม่ได้ข้อมูลราคาจากทุกแหล่ง' });
        this.emit('snapshot', this.lastSnap);
        return;
      }
      // แหล่งราคาเปลี่ยน (MT5 spot ↔ Yahoo ฟิวเจอร์ส ต่างกัน $10-40) → ของที่จดจากราคาอีกแหล่งเทียบกันไม่ได้
      if (this._priceSource && this._priceSource !== data.source) {
        this.skills.pending = [];
        this.councilStats.pending = [];   // โหวต/มติที่รอตรวจผลยังไม่จบ = ราคาคนละตลาด ถือเป็นผลไม่ได้
        this.active.clear();
        this.pushLog('engine', `แหล่งราคาเปลี่ยน ${this._priceSource} → ${data.source}: ล้างโหวตที่รอตรวจผล + สัญญาณที่เปิดอยู่ (ราคาคนละตลาด)`, 'warn');
      }
      this._priceSource = data.source;
      const candles = data.candles;
      const analysis = analyzeMarket(candles);
      const price = data.price != null ? data.price : analysis.price;
      // ทุนที่ใช้คิดเสี่ยง: ยอดจริงจาก MT5 แปลงเป็น USD แล้ว (ไม่รู้อัตรา = ใช้ค่าที่ตั้ง) • ขนาดสัญญาจริงของโบรกเกอร์ถ้า EA ส่งมา
      const liveEquity = this._liveEquityUSD(data.meta && data.meta.account);
      const spec = data.meta && data.meta.spec;
      const effSettings = {
        ...this.settings,
        ...(liveEquity ? { equity: liveEquity } : {}),
        ...(spec ? { ozPerLot: spec.contractSize } : {}),
        ...(Number(data.digits) > 0 ? { digits: Number(data.digits) } : {}),
      };
      // 1) สภาทีมเอเจนต์ (น้ำหนักปรับด้วยสกิลของแต่ละคน + เรียกก่อน plugins)
      this.skills.processTick(price, Date.now());
      const councilResults = this.councilStats.processTick(price, Date.now());
      for (const r of councilResults) {
        if (r.result === 'won' || r.result === 'lost') {
          this.pushLog('council', `ตรวจมติสภาเดิม (${r.kind === 'lean' ? 'มติเงา' : 'มติจริง'}) ${r.side.toUpperCase()} conf ${r.conf}% → ${r.result === 'won' ? 'ชนะ ✓' : 'แพ้ ✗'}`, r.result === 'won' ? 'ok' : 'warn');
        }
      }
      const councilVerdict = this.settings.councilEnabled !== false
        ? runCouncil({ analysis, candles, price, now: Date.now(), ind, skills: this.skills.all(), councilCal: this.councilStats }, effSettings)
        : null;
      // จดโหวตที่มั่นโค้ง ≥50% ไว้ตรวจผลหลัง 30 นาที (วัดว่าเก่งด้านนั้นแค่ไหน)
      const m15atr = analysis.tf && analysis.tf.M15 && Number.isFinite(analysis.tf.M15.atr) ? analysis.tf.M15.atr : null;
      if (councilVerdict && m15atr) {
        for (const v of councilVerdict.votes) {
          if (v.side !== 'none' && v.conf >= 50) this.skills.openVote(v.id, v.side, price, m15atr, Date.now());
        }
        // สมุดผลงานสภา: จดมติ (และมติเงา เกือบมีมติ) → ตรวจผล 30 นาที → ปรับความมั่นใจของมติใหม่
        this.councilStats.open(councilVerdict, price, m15atr, Date.now());
      }
      // จำมติรอบนี้ไว้ — ไม้จำลองที่เปิดจากโซนในรอบนี้จะแนบ "มติสภา ณ จังหวะเปิด" ให้ดูคู่กันเสมอ
      this._lastCouncil = councilVerdict || null;
      // 2) plugin ให้คำแนะนำ (รองรับ plugin ที่ทำงานแบบ async เช่นเรียก LLM ภายนอก)
      // plugin ได้สำเนา (frozen) — โค้ดผู้ใช้แก้ค่าตั้ง/มติสภา/แท่งเทียน ที่สภา/กฎความเสี่ยงใช้ต่อไม่ได้
      // (แท่งเทียน: แช่แข็งแบบอ่านอย่างเดียวตามไทม์เฟรม — เร็วกว่า structuredClone ทั้งก้อนหลายเท่า)
      const frozenCandles = this._frozen && this._frozenSrc === candles
        ? this._frozen
        : ((this._frozenSrc = candles), (this._frozen = Object.freeze(Object.fromEntries(Object.entries(candles).map(([tf, arr]) => [tf, Object.freeze((Array.isArray(arr) ? arr : []).map(Object.freeze))])))));
      const raw = await this.plugins.runStrategies({
        analysis: structuredClone(analysis), candles: frozenCandles, price, settings: Object.freeze({ ...effSettings }), council: councilVerdict ? Object.freeze(structuredClone(councilVerdict)) : null,
        ind: PLUGIN_IND,
        log: (msg, lvl) => this.logger('plugin', msg, lvl),
      });
      // 3) ทำให้สมบูรณ์ + ตรวจกฎความเสี่ยง → เก็บผู้ผ่านด่านไว้ก่อน (รอเลือกเสี่ยงน้อยสุด)
      const signals = [], filtered = [], passers = [];
      for (const r of raw) {
        if (r.watchOnly) {
          // ข้อความ "เฝ้ารอโอกาส" — ไม่ใช่สัญญาณเข้าไม้ แสดงเป็นพาดหัวเฝ้ารอ
          filtered.push({ plugin: r.plugin || '?', reason: `👀 เฝ้ารอ — ${r.reason}` });
          continue;
        }
        const norm = risk.normalizeSignal(r, price);
        if (!norm) { filtered.push({ plugin: r.plugin || '?', reason: 'โครงสร้างสัญญาณไม่ถูกต้อง (ไม่มี SL หรือทิศทางผิด)' }); continue; }
        const ev = risk.evaluateSignal(norm, effSettings);
        ev.plugin = r.plugin || '?';
        ev.pluginName = r.pluginName || ev.plugin;
        if (!ev.pass) { filtered.push({ plugin: ev.plugin, reason: ev.reject }); continue; }
        const key = this._keySig(ev);
        if (this._staleActive(price, ev)) continue; // สัญญาณแบบเดิมยังทำงานอยู่
        if (this._cooldown(key)) { filtered.push({ plugin: ev.plugin, reason: 'อยู่ในช่วงคูลดาวน์ของสัญญาณแบบเดิม' }); continue; }
        // 3) ด่านตรวจมติทีมเอเจนต์ — สวนสภาเมื่อสภามั่นใจ = กรอง
        const gate = gateSignal(ev, councilVerdict, this.settings);
        if (!gate.ok) { filtered.push({ plugin: ev.plugin, reason: gate.reason }); continue; }
        if (gate.info) ev.council = gate.info.councilConf != null ? { conf: gate.info.councilConf, note: gate.info.note } : null;
        passers.push(ev);
      }
      // 4) โหมดเสี่ยงน้อยที่สุด: เข้าเฉพาะไม้ที่วิเคราะห์แล้วเสี่ยงต่ำสุดของรอบ — ไม้ที่เหลือ "เลื่อน" พร้อมเหตุผล
      const sessionNow = sessions.evaluate(Date.now());
      const chosen = this.settings.leastRisk === false ? null : this._pickLeastRisk(passers, sessionNow.quality);
      for (const ev of passers) {
        const hold = !chosen || ev === chosen ? this._gate() : { reason: 'เสี่ยงกว่าไม้ที่เลือกในรอบนี้ (โหมดเสี่ยงน้อยที่สุด)' };
        signals.push({ ...ev, ts: Date.now(), riskScore: risk.riskScore(ev, sessionNow.quality), held: hold.reason ? hold.reason : null });
        if (!hold.reason) {
          this._rememberIssue(this._keySig(ev), ev);
          this.dailyCount++;
        }
      }
      // วินิจฉัยอัตโนมัติ: สภาผ่านมติแต่ 0 สัญญาณ = บอกเหตุผลทันที (ห้ามผู้ใช้หาเอง — รายงานทุก 5 นาที)
      if (councilVerdict && councilVerdict.side !== 'none' && !signals.length && (filtered.length || this.settings.councilEnabled !== false)) {
        const now = Date.now();
        if (!(this._councilNoSigAt > now - 300_000)) {
          this._councilNoSigAt = now;
          const why = filtered.slice(0, 2).map((x) => `${x.plugin}: ${x.reason}`).join(' • ');
          this.pushLog('council', `🧠 สภามีมติ ${councilVerdict.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${councilVerdict.confidence}% (เห็นพ้อง ${councilVerdict.agree}) แต่ 0 สัญญาณ — ${why || 'กลยุทธ์ยังรอเงื่อนไขราคาตัวเอง (เช่น รอย่อเข้า EMA)'}`);
        }
      }
      const lastSnap = this._snapshot({ data, analysis, price, signals, filtered, connectorLabel: c.label, fallbackReason, council: councilVerdict, councilStats: this.councilStats ? this.councilStats.snapshot() : null });
      lastSnap.session = sessionNow;
      lastSnap.sessionWindows = sessions.WINDOWS;
      lastSnap.sessionToBest = sessions.minutesToNextBest(Date.now());
      // ห้องรอโอกาส: อะไรกำลังถูกเฝ้า + อะไรมาถึงแล้ว (ใช้เซสชันที่คำนวณแล้ว)
      lastSnap.standby = this._standby(lastSnap, councilVerdict, analysis, lastSnap.session);
      lastSnap.entryPlan = buildEntryPlan({
        analysis, price,
        sessionQuality: lastSnap.session.quality,
      });
      lastSnap.entryZoneEvents = this._zoneEvents(lastSnap.entryPlan, lastSnap.ts);
      // ไม้เสมือนจากจุดรอเข้า: อัปเดตผลก่อน → เปิดใหม่จาก HIT ล่าสุด (แยกกระดานซื้อ/ขาย)
      this._equityForSizing = (lastSnap.guard && lastSnap.guard.equityUsed) || this.settings.equity;
      this._updateZoneTrades(price, lastSnap.ts);
      for (const ev of lastSnap.entryZoneEvents) {
        if (ev.event === 'entered') this._openZoneTrade(ev.side, price, lastSnap.entryPlan, lastSnap.ts);
      }
      lastSnap.zoneHistory = this.zoneHistory.slice(-25);
      lastSnap.zoneOpen = this.zoneOpen;
      lastSnap.zoneSummary = this._zoneSummary();
      lastSnap.roundLog = this._recordRound(lastSnap);
      lastSnap.commentary = this._commentary(lastSnap);
      this.lastSnap = lastSnap;
      this.emit('snapshot', lastSnap);
      // heartbeat: หลักฐานวิ่งต่อเนื่องลง log ทุก ~5 นาที (ทิศ 30 ตัวต่อ tick)
      if (this.tickCount % 30 === 0) {
        const v = councilVerdict;
        this.pushLog('engine', `ทำงานต่อเนื่อง ✓ tick ${this.tickCount} • ${c.label} • ราคา ${ind.round(price, 2)} • สภา: ${v ? (v.side === 'none' ? 'ไม่มีมติ' : `${v.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${v.confidence}%`) : 'ปิด'} • สัญญาณรออยู่ ${signals.length}`);
      }
  }

  _liveEquityUSD(acct) {
    return acct && Number.isFinite(acct.equityUSD) && acct.equityUSD > 0 ? acct.equityUSD : null;
  }

  // แท่งเทียนครบทุกไทม์เฟรม (ให้หน้าต่างที่เปิดใหม่/รีโหลดวาดชาร์ตได้ทันที ไม่ต้องรอแท่งใหม่)
  fullCandles() {
    const all = this._lastCandles;
    if (!all) return undefined;
    const out = {};
    for (const [tf, n] of Object.entries(CANDLE_LIMIT)) if (Array.isArray(all[tf])) out[tf] = all[tf].slice(-n);
    return out;
  }

  _rolloverDay() {
    const today = new Date().toDateString();
    if (today !== this.day) { this.day = today; this.dailyCount = 0; this.manualToday = 0; }
  }

  // ห้องรอโอกาส: เก็บ "อะไรกำลังถูกเฝ้ารอ" ตอนสัญญาณยังไม่ผ่าน
  // (sessionNow แยกเป็นพารามิเตอร์ — รับของที่ถูกคำนวณไว้แล้ว)
  _standby(snap, verdict, analysis, sessionNow = sessions.evaluate(Date.now())) {
    const approved = (snap.signals || []).filter((x) => !x.held);
    if (approved.length) return { mode: 'ready', notes: [`🎯 สัญญาณพร้อม (SIGNAL READY) ${approved.length} ไม้ (${approved[0].side === 'buy' ? 'BUY' : 'SELL'} ${approved[0].confidence}%)`] };
    const notes = [];
    if (verdict) {
      const need = this._councilMin();
      if (verdict.side !== 'none') {
        notes.push(verdict.confidence >= need
          ? `มติ${verdict.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${verdict.confidence}% — ผ่านเกณฑ์ ${need}% แล้ว รอกลยุทธ์ยืนยันจุดเข้า`
          : `มติ${verdict.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${verdict.confidence}% — ใกล้เกณฑ์ออกไม้ ${need}% อีก ${need - verdict.confidence} คะแนน`);
      }
      else {
        const dirVotes = (verdict.votes || []).filter((x) => x.side !== 'none');
        const top = dirVotes.sort((a, b) => b.conf - a.conf)[0];
        if (top && top.conf >= 50) notes.push(`${top.name}: หัวไป ${top.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${top.conf}% — รอเพื่อนเอเจนต์เห็นด้วยเพิ่ม`);
      }
    }
    const m15 = analysis && analysis.tf && analysis.tf.M15;
    if (m15 && m15.squeeze) notes.push('แบนด์ Bollinger กำลังบีบ — ระเบิดราคาใกล้มาแล้ว (เฝ้ารอแตก)');
    if (sessionNow.quality === 'avoid' || sessionNow.closed) notes.push(`${sessionNow.label}: ${sessionNow.riskNote || 'ไม่แนะนำเข้าตอนนี้'}`);
    if (!notes.length) return { mode: 'quiet', notes: ['ระบบกำลังเฝ้าดู — ยังไม่มีจุดพร้อมพิเศษ'] };
    return { mode: 'waiting', notes };
  }

  _keySig(s) { return `${s.plugin}|${s.side}`; }

  // เกณฑ์มั่นใจรวมของสภาที่ผู้ใช้ตั้ง (เดิมฮาร์ดโค้ด 70 ในข้อความ → ไม่ตรงกับค่าที่ตั้งจริง)
  _councilMin() { return Number(this.settings.councilMin) || 70; }

  // ---------- ประวัติจุดรอเข้า: ไม้เสมือนจาก HIT ----------
  _loadZoneHistory() {
    if (!this.zoneStorePath) return;
    try {
      if (fs.existsSync(this.zoneStorePath)) {
        const j = JSON.parse(fs.readFileSync(this.zoneStorePath, 'utf8'));
        this.zoneHistory = Array.isArray(j.history) ? j.history.slice(-40) : [];
        // ฝั่งละไม่เกิน 1 ไม้ (ไฟล์จากรุ่นก่อนอาจมีไม้ซ้ำที่เปิดตอนราคาแกว่งเข้าออกขอบโซน — เก็บไม้แรกของแต่ละฝั่ง)
        const open = Array.isArray(j.open) ? j.open : [];
        this.zoneOpen = ['buy', 'sell'].map((side) => open.find((t) => t && t.side === side)).filter(Boolean);
        if (this.zoneOpen.length !== open.length) this._saveZoneHistory();
      }
    } catch (e) { this.logger('zone', `โหลดประวัติจุดรอล้ม: ${e.message}`, 'warn'); }
  }

  _saveZoneHistory() {
    if (!this.zoneStorePath) return;
    try {
      fs.mkdirSync(path.dirname(this.zoneStorePath), { recursive: true });
      fs.writeFileSync(this.zoneStorePath + '.tmp', JSON.stringify({ history: this.zoneHistory.slice(-40), open: this.zoneOpen }, null, 0), 'utf8');
      fs.renameSync(this.zoneStorePath + '.tmp', this.zoneStorePath);
    } catch (e) { this.logger('zone', `บันทึกประวัติจุดรอล้ม: ${e.message}`, 'warn'); }
  }

  _openZoneTrade(side, price, plan, ts) {
    const z = plan[side];
    if (!z || !Number.isFinite(price)) return;
    if (this.zoneOpen.some((t) => t.side === side)) return; // ฝั่งนี้มีไม้จำลองเปิดอยู่แล้ว = ไม่เปิดซ้อน
    // มติสภา "ณ จังหวะเปิดไม้" — จดคู่ไว้ดูว่าจังหวะที่โซน HIT สภาตัดสินกี่ %
    const cv = this._lastCouncil || null;
    const councilAtOpen = cv ? {
      side: cv.side,
      confidence: Math.round(cv.confidence || 0),
      agree: cv.agree || 0,
      quorumNeed: cv.quorumNeed || null,
      net: cv.net != null ? Math.round(cv.net * 10) / 10 : null,
    } : null;
    const atr = Number(plan.atr) || 1;
    const sl = side === 'buy' ? ind.round(z.bottom - 0.5 * atr, 2) : ind.round(z.top + 0.5 * atr, 2);
    const rr = 2.2;
    const tp = side === 'buy' ? ind.round(price + rr * (price - sl), 2) : ind.round(price - rr * (sl - price), 2);
    const slDist = Math.abs(price - sl);
    const equity = (this._equityForSizing || 1000);
    const lot = Math.max(0.01, Math.floor(((equity * 1) / 100) / (slDist * risk.OZ_PER_LOT) * 100) / 100);
    const t = {
      id: `zt-${ts}-${side}`, side, entry: ind.round(price, 2), sl, tp, source: this._priceSource || null,
      zone: z.center, levelType: z.levelType, openedAt: ts, status: 'open',
      slDist: ind.round(slDist, 2), lot,
      councilAtOpen,
      // ตรวจทิศยอดของแต่ละเอเจนต์ ณ จุดเปิด — ผลไม้จำลองปิดแล้วจะป้อนกลับเป็นบทเรียนรายคน
      votesAtOpen: cv && Array.isArray(cv.votes) ? cv.votes.map((v) => ({ id: v.id, side: v.side, conf: Math.round(v.conf || 0) })).filter((v) => v.id) : null,
    };
    this.zoneOpen.push(t);
    this._openedRefs = this._openedRefs || [];
    this._openedRefs.push(t);
    const cTxt = councilAtOpen ? ` • สภา: ${councilAtOpen.side === 'none' ? `ไม่มีมติ ${councilAtOpen.confidence}%` : `${councilAtOpen.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${councilAtOpen.confidence}% เห็นพ้อง ${councilAtOpen.agree}`}` : ' • สภา: ปิดอยู่';
    this.logger('zone', `จุดรอ${side === 'buy' ? 'ซื้อ' : 'ขาย'} HIT → เปิดไม้เสมือน: เข้า ${t.entry} SL ${t.sl} TP ${t.tp} ล็อต ${t.lot}${cTxt}`);
    this._saveZoneHistory();
  }

  _updateZoneTrades(price, ts) {
    if (!this.zoneOpen.length) return;
    const stillOpen = [];
    for (const t of this.zoneOpen) {
      // ไม้จำลองที่เปิดจากราคาอีกแหล่ง: รอจนกลับมาแหล่งเดิม (ไม่ตัดสิน TP/SL ด้วยราคาคนละตลาด)
      if (!Number.isFinite(price) || (t.source && this._priceSource && t.source !== this._priceSource)) { stillOpen.push(t); continue; }
      const dir = t.side === 'buy' ? 1 : -1;
      const hitTp = dir * (price - t.tp) >= 0;
      const hitSl = dir * (price - t.sl) <= 0;
      let exit = null, result = null;
      if (hitTp) { exit = t.tp; result = 'TP'; }
      else if (hitSl) { exit = t.sl; result = 'SL'; }
      else if (ts - t.openedAt > 4 * 3600_000) { exit = price; result = 'TIME'; }
      if (result) {
        t.exit = ind.round(exit, 2); t.closedAt = ts; t.status = result; t.result = result;
        t.pnl = ind.round(dir * (exit - t.entry) * 100 * t.lot, 2);
        t.r = ind.round(t.pnl / (t.slDist * 100 * t.lot), 2);
        this.zoneHistory.push(t);
        if (this.zoneHistory.length > 40) this.zoneHistory = this.zoneHistory.slice(-40);
        this._closedThisRound = this._closedThisRound || [];
        this._closedThisRound.push(t);
        this._learnFromVirtual(t);
        this.logger('zone', `ไม้เสมือนจุดรอเข้าจบ: ${t.side} → ${result} → ${t.pnl >= 0 ? '+' : ''}$${t.pnl}`);
        this._saveZoneHistory();
      } else stillOpen.push(t);
    }
    this.zoneOpen = stillOpen;
  }

  // ---------- ให้สภาเรียนรู้จากผลไม้จำลองจริง ----------
  // ไม้จำลองปิด = ผลลัพธ์จริงของจังหวะเปิด → สมุดสภา (รวมช่วงความมั่นใจ) + สกิลรายเอเจนต์ที่โหวตตอนนั้น
  _learnFromVirtual(t) {
    const c = t && t.councilAtOpen;
    if (!c) return;
    // ชนะ = จบ TP หรือ หมดเวลาแต่กำไรลอยตัวสำคัญ (≥ +0.5 × ระยะ SL) • แพ้ = SL หรือขาดทุนจริงจัง
    const budget = (t.slDist || 0) * 100 * (Number(t.lot) || 0.01);
    const win = t.status === 'TP' ? 1 : t.status === 'SL' ? -1 : (t.pnl >= budget * 0.5 ? 1 : t.pnl <= -budget * 0.5 ? -1 : 0);
    this.councilStats.observeTrade(c, win);
    for (const v of (t.votesAtOpen || [])) {
      if (v.side === 'none' || (v.conf || 0) < 50) continue;
      let rec = win;
      if (rec !== 0 && v.side !== t.side) rec = -rec;    // โหวตสวนทิศไม้ = ผลสวน
      if (rec !== 0) this.skills.recordAgent(v.id, rec);
    }
    if (win !== 0) {
      this.logger('skills', `เรียนรู้จากไม้จำลอง #${t.id}: สภา ${c.side === 'none' ? `ไม่มีมติ ${c.confidence}%` : `${c.side} ${c.confidence}%`} → ${win > 0 ? 'ผลจริงชนะ' : 'ผลจริงแพ้'} — ปรับสถิติสภา/เอเจนต์แล้ว`, win > 0 ? 'ok' : 'warn');
    }
  }

  _zoneSummary() {
    const h = this.zoneHistory || [];
    const per = (side) => {
      const rows = h.filter((t) => t.side === side);
      return {
        w: rows.filter((t) => t.status === 'TP').length,
        l: rows.filter((t) => t.status === 'SL').length,
        time: rows.filter((t) => t.status === 'TIME').length,
        total: ind.round(rows.reduce((s, t) => s + (t.pnl || 0), 0), 2),
      };
    };
    return { buy: per('buy'), sell: per('sell') };
  }

  // เก็บประวัติรอบถาวร: ต่อท้ายไฟล์ JSONL • เกิน 8MB = เก็บครึ่งหลังไว้ (ไม่ลบทิ้งทั้งก้อน)
  _appendRoundHistory(entry) {
    if (!this.roundStorePath) return;
    try {
      fs.appendFileSync(this.roundStorePath, JSON.stringify(entry) + '\n', 'utf8');
      if (fs.statSync(this.roundStorePath).size > 8 * 1024 * 1024) {
        const lines = fs.readFileSync(this.roundStorePath, 'utf8').split('\n').filter(Boolean);
        fs.writeFileSync(this.roundStorePath, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n', 'utf8');
      }
    } catch { /* เขียนประวัติไม่ได้ไม่ให้รอบวิเคราะห์ล้ม */ }
  }

  // "รอบนี้ลงไม้ไหน": สรุปการลงมือของรอบ (ลงเสมือน/สัญญาณ/ไม่ลง+เหตุผล) — จดเฉพาะเมื่อเปลี่ยน
  _recordRound(snap) {
    this.roundLog = this.roundLog || [];
    const fmt = (n, d = 2) => Number.isFinite(n) ? n.toFixed(d) : '—';
    const approved = (snap.signals || []).filter((x) => !x.held);
    const c = snap.council || { side: 'none', confidence: 0 };
    let action, detail, key = null;
    if (this._closedThisRound && this._closedThisRound.length) {
      const t = this._closedThisRound[this._closedThisRound.length - 1];
      action = `ปิดไม้เสมือน ${t.side === 'buy' ? 'BUY' : 'SELL'} → ${t.result} ${t.pnl >= 0 ? '+' : ''}$${t.pnl}`;
      detail = `เข้า ${t.entry} → ออก ${t.exit}`;
    } else if (this._openedRefs && this._openedRefs.length) {
      const t = this._openedRefs[this._openedRefs.length - 1];
      action = `ลงไม้เสมือน ${t.side === 'buy' ? 'BUY' : 'SELL'} @ ${t.entry} (จากจุดรอ${t.side === 'buy' ? 'ซื้อ' : 'ขาย'})`;
      detail = `SL ${t.sl} • TP ${t.tp} • ล็อต ${t.lot} • โซน ${t.zone}`;
    } else if (approved.length) {
      const s = approved[0];
      action = `สัญญาณ (SIGNAL) ${s.side === 'buy' ? 'BUY' : 'SELL'} ${s.confidence}% @ ${s.entry} — ${s.pluginName}`;
      detail = `SL ${s.sl} • TP ${s.tp} • ล็อตแนะนำ ${s.metrics && s.metrics.lot != null ? s.metrics.lot : '—'}`;
    } else {
      const zTxt = (z, label) => {
        if (!z) return `ไม่มีโซน${label}`;
        if (z.status === 'armed') return `ราคาอยู่ในโซน${label}`;
        if (Number.isFinite(z.distance) && z.distance <= 0) return `อยู่ในโซน${label} (สถานะ ${z.status})`;
        return `ห่างโซน${label} $${fmt(Math.max(0, z.distance))}`;
      };
      const dB = snap.entryPlan ? zTxt(snap.entryPlan.buy, 'ซื้อ') : 'ไม่มีโซนซื้อ';
      const dS = snap.entryPlan ? zTxt(snap.entryPlan.sell, 'ขาย') : 'ไม่มีโซนขาย';
      action = `ไม่ลง — เฝ้ารอ (ราคา ${fmt(snap.price)})`;
      detail = `สภา: ${c.side === 'none' ? 'ไม่มีมติ' : `มติ${c.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${c.confidence}%`} • ซื้อ: ${dB} • ขาย: ${dS}`;
      // ช่วงเฝ้ารอ: จดเฉพาะเมื่อมติ/สถานะโซนเปลี่ยน (เดิมราคา/ระยะขยับทุกทิค = จดรัวจนประวัติจริงหลุดหาย)
      const zs = (z) => (z ? z.status : '-');
      key = `wait|${c.side}|${Math.floor((c.confidence || 0) / 10)}|${zs(snap.entryPlan && snap.entryPlan.buy)}|${zs(snap.entryPlan && snap.entryPlan.sell)}`;
    }
    key = key || action + '///' + detail;
    if (key !== this._roundKey) {
      const entry = { ts: snap.ts, action, detail };
      this.roundLog.push(entry);
      if (this.roundLog.length > 40) this.roundLog = this.roundLog.slice(-40);
      this._appendRoundHistory(entry);
      this._roundKey = key;
    }
    return this.roundLog;
  }

  // ตรวจเปลี่ยนสถานะโซน: waiting → armed = เหตุการณ์ "ถึงจุดเข้าแล้ว" (หนึ่งครั้ง/การเข้า)
  // คีย์ตามฝั่งเท่านั้น (เดิมรวมราคากลางโซนที่ขยับเกือบทุกทิค → Map โตไม่หยุด และเหตุการณ์ "เข้าโซน" แทบไม่เกิด)
  _zoneEvents(plan, ts) {
    const out = [];
    this._zoneState = this._zoneState || new Map();
    for (const side of ['buy', 'sell']) {
      const z = plan[side];
      if (!z) { this._zoneState.delete(side); continue; }
      const prev = this._zoneState.get(side);
      this._zoneState.set(side, { state: z.status, ts });
      // ราคาแกว่งเข้าออกขอบโซนถี่ ๆ = นับเป็นการเข้าครั้งเดียวใน 15 นาที (กันแจ้งเตือนรัว/เปิดไม้จำลองซ้ำ)
      this._zoneEnteredAt = this._zoneEnteredAt || {};
      if (prev && prev.state !== 'armed' && z.status === 'armed') {
        if (ts - (this._zoneEnteredAt[side] || 0) >= ZONE_REENTRY_MS) { this._zoneEnteredAt[side] = ts; out.push({ side, ...z, event: 'entered', ts }); }
      }
      else if (prev && prev.state === 'armed' && z.status !== 'armed') out.push({ side, ...z, event: 'left', ts });
    }
    return out;
  }

  // ผู้ช่วยเทรดบรรยายสด: สรุปเหตุการณ์ทุกรอบเป็นภาษาไทยพร้อมคำแนะนำการรอ (แหล่งข้อมูลเดียวกับ panel ทุกชั้น)
  _commentary(snap) {
    const lines = [];
    const a = snap.analysis || {};
    const sess = snap.session || {};
    const c = snap.council;
    const st = snap.standby || {};
    const zones = snap.entryPlan || {};
    const fmt = (n, d = 2) => Number.isFinite(n) ? n.toFixed(d) : '—';

    if (snap.price == null) { lines.push(`ยังไม่ได้ราคาจากแหล่งข้อมูลแลนี้ — ผมหมายถึงจะลองรอบหน้า (ถ้าเลือก MT5 เท่านั้น ให้แน่ว่า EA ลงชาร์ต)`); }
    else {
      // บรรทัดมุมมองหลัก: ราคา+ทุน
      const acct = snap.account;
      const cur = acct && acct.currency && acct.currency !== 'USD' ? ` ${acct.currency}` : '';
      const money = acct && Number.isFinite(acct.equity) ? ` • ทุนสุทธิ ${fmt(acct.equity)}${cur}${acct.equity !== acct.balance ? ` (ลอยตัว ${fmt(acct.equity - acct.balance)}${cur})` : ''}` : '';
      lines.push(`ราคาทอง $${fmt(snap.price)}${money} — เซสชัน${sess.label || '…'} (${sess.quality === 'best' ? 'ดีสุดของวัน' : sess.quality === 'good' ? 'ดี' : sess.quality === 'ok' ? 'พอใช้' : sess.quality === 'closed' ? 'ตลาดปิด' : 'ไม่แนะนำ'})`);

      // ทิศทาง+เทรนด์+โมเมนตัม (จากภาพตลาด)
      const trendTxt = a.bias === 'bull' ? 'ขาขึ้น' : a.bias === 'bear' ? 'ขาลง' : 'ไปข้างกว้าง';
      lines.push(`ภาพรวม: ขา${trendTxt === 'ไปข้างกว้าง' ? 'ข้าง' : trendTxt} (H1:${a.trendH1} M15:${a.trendM15}) • RSI ${a.tf && a.tf.M5 && Number.isFinite(a.tf.M5.rsi) ? fmt(a.tf.M5.rsi, 1) : '—'}${a.tf && a.tf.M15 && a.tf.M15.squeeze ? ' • แบนด์บีบตัว เฝ้ารอแตก' : ''}`);

      // มติสภา
      if (c && c.side !== 'none') lines.push(`สภา: มติ${c.side === 'buy' ? 'ซื้อ' : 'ขาย'} ${c.confidence}% (เห็นพ้อง ${c.agree}/${c.quorumNeed}+) — ${c.confidence >= this._councilMin() ? 'ผ่านเกณฑ์ออกไม้' : `ยังรอให้ครบ ${this._councilMin()}%`}`);
      else lines.push('สภา: ยังไม่มีมติ (โหวตยังขัดกัน/แรงไม่พอ) — ระยอกหมายว่ายังไม่ต้องเร่ง');

      // โซนรอเข้า
      const zBuy = zones.buy, zSell = zones.sell;
      const zoneDesc = [];
      if (zBuy) zoneDesc.push(`ซื้อ ${zBuy.bottom}–${zBuy.top} [${zBuy.status === 'armed' ? 'ราคาในโซน!' : zBuy.status === 'blocked' ? 'ถูกยกเลิก' : zBuy.status === 'danger' ? 'ห้าม' : Number.isFinite(zBuy.distance) && zBuy.distance <= 0 ? `อยู่ในโซน (รอยืนยัน ${zBuy.status})` : `รอ เหลือ $${fmt(Math.max(0, zBuy.distance))}`}]`);
      if (zSell) zoneDesc.push(`ขาย ${zSell.bottom}–${zSell.top} [${zSell.status === 'armed' ? 'ราคาในโซน!' : zSell.status === 'blocked' ? 'ถูกยกเลิก' : zSell.status === 'danger' ? 'ห้าม' : Number.isFinite(zSell.distance) && zSell.distance <= 0 ? `อยู่ในโซน (รอยืนยัน ${zSell.status})` : `รอ เหลือ $${fmt(Math.max(0, zSell.distance))}`}]`);
      lines.push(`จุดรอเข้า: ${zoneDesc.length ? zoneDesc.join(' • ') : 'ไม่มีโซนชัดตอนนี้'}`);

      // คำแนะนำตอนนี้ (จากห้องรอ+เกต)
      if (st.notes && st.notes.length) lines.push(`รอเข้า: ${st.notes[0]}`);
      if (snap.guard && snap.guard.newsStop) lines.push('⚠ โหมดหยุดข่าวเปิด — วิเคราคห่อกันไปก่อน แต่ยังไม่ส่งสัญญาณ');
      lines.push('→ แจ้งเตือนทันทีที่สัญญาณ/จุดรอพร้อม (ไม่ต้องจ้องจอ)');
    }

    const entry = { ts: snap.ts, lines };
    this.commentaryLog = this.commentaryLog || [];
    const lastTs = this.commentaryLog.length ? this.commentaryLog[this.commentaryLog.length - 1].ts : 0;
    // กัน spam: คงไว้เฉพาะอย่างน้อยถ้าต่างจากบรรทัดหลักก่อนหน้า
    const key = lines.join('|');
    const lastKey = this._lastCommentaryKey || '';
    if (key !== lastKey || snap.ts - lastTs > 10 * 60_000) {
      this.commentaryLog.push(entry);
      if (this.commentaryLog.length > 14) this.commentaryLog = this.commentaryLog.slice(-12);
      this._lastCommentaryKey = key;
    }
    return entry;
  }

  // สัญญาณแบบเดิมยังทำงานอยู่ (ราคายังไม่แตะ SL/TP และไม่เก่าเกิน 4 ชม.) = ซ้ำ
  _staleActive(price, sig) {
    const key = this._keySig(sig);
    const a = this.active.get(key);
    if (!a) return false;
    const hit = sig.side === 'buy' ? price <= a.sl || price >= a.tp : price >= a.sl || price <= a.tp;
    if (hit || Date.now() - a.ts > 4 * 3600_000) { this.active.delete(key); return false; }
    return true;
  }

  _cooldown(key) {
    const min = Math.max(0, Number(this.settings.cooldownMin) || 0);
    const t = this.lastIssue.get(key);
    return t && Date.now() - t < min * 60_000;
  }

  _rememberIssue(key, sig) {
    this.lastIssue.set(key, Date.now());
    this.active.set(key, { entry: sig.entry, sl: sig.sl, tp: sig.tp, ts: Date.now() });
  }

  // เกทระดับระบบ: newsStop + โควตาต่อวัน (มาจาก settings แต่ไม่ปิดได้ในแง่ที่ทำให้เสี่ยง)
  // นับ "รวม" ทุกทาง: สัญญาณที่ออกไปแล้ว + ไม้จริงที่ผู้ใช้กด — เพดานเดียวกันทั้งระบบ
  _gate() {
    if (this.settings.newsStop) return { reason: 'โหมดหยุดช่วงข่าวเปิดอยู่ — ยังไม่ส่งถึงคุณ' };
    const max = Number(this.settings.maxSignalsPerDay) || 0;
    if (max > 0 && (this.dailyCount || 0) + (this.manualToday || 0) >= max) {
      return { reason: `ครบโควตา ${max} ไม้ต่อวันแล้ว` };
    }
    return {};
  }

  // โหมดเสี่ยงน้อยที่สุด: เลือกไม้ที่คะแนนเสี่ยงต่ำสุดของรอบ (คืน null ถ้าว่าง)
  _pickLeastRisk(list, sessionQuality) {
    if (!Array.isArray(list) || !list.length) return null;
    let best = null, bestScore = Infinity;
    for (const ev of list) {
      const sc = risk.riskScore(ev, sessionQuality);
      if (sc < bestScore) { best = ev; bestScore = sc; }
    }
    return best;
  }

  // คัดแท่งเทียนที่มีแท่งใหม่จริงต่อไทม์เฟรม (แท่งก่อนหน้านิ่ง → ไม่ต้องขนไป renderer ซ้ำ)
  // คืน: { candles: { [tf]: bars } เฉพาะ tf ที่มีแท่งใหม่, tail: { [tf]: แท่งล่าสุด } เมื่อแท่งที่กำลังก่อตัวเปลี่ยน }
  // (เดิมไม่ส่งแท่งที่กำลังก่อตัว — แท่งสุดท้ายบนชาร์ตค้างจนกว่าจะขึ้นแท่งใหม่)
  _pickChangedCandles(all = {}) {
    if (!all || !Object.keys(all).length) return { candles: undefined, tail: undefined };
    this._lastCandles = all;
    const out = {}, tail = {};
    this._candleKeys = this._candleKeys || {};
    this._tailKeys = this._tailKeys || {};
    for (const [tf, n] of Object.entries(CANDLE_LIMIT)) {
      const rows = all[tf];
      if (!Array.isArray(rows) || !rows.length) continue;
      const last = rows[rows.length - 1];
      const key = `${Math.min(rows.length, n)}|${last.t}`;
      const tKey = `${last.t}|${last.o}|${last.h}|${last.l}|${last.c}`;
      if (this._candleKeys[tf] !== key) { this._candleKeys[tf] = key; out[tf] = rows.slice(-n); }
      else if (this._tailKeys[tf] !== tKey) tail[tf] = last;
      this._tailKeys[tf] = tKey;
    }
    return { candles: out, tail };
  }

  _snapshot(extra) {
    const s = this.settings;
    const now = Date.now();
    // ข้อมูลบัญชี/ไม้เปิด: จากรอบนี้ ถ้าไม่มี (ข้อมูลฟรี/รอบผิดพลาด) ใช้ของ MT5 ได้เฉพาะตอน MT5 ยังสด — ไม่ยกของเก่าค้างไปเรื่อย ๆ
    const mt5 = this.connectors && this.connectors.mt5;
    const mt5Live = !!(mt5 && typeof mt5.isLive === 'function' && mt5.isLive());
    const meta = extra.data && extra.data.meta ? extra.data.meta : (mt5Live && mt5.latest ? mt5.latest.meta : null);
    const liveAccount = meta ? meta.account || null : null;
    const effectiveEquity = this._liveEquityUSD(liveAccount);
    const picked = this._pickChangedCandles(extra.data && extra.data.candles);
    return {
      ts: now,
      app: { version: this.appVersion },
      source: extra.fallbackReason ? `อัตโนมัติ (ฟรี) — ${extra.fallbackReason}` : (extra.connectorLabel || '-'),
      connectorStatuses: Object.fromEntries(Object.entries(this.connectors).map(([k, c]) => [k, c.status])),
      price: extra.price ?? null,
      prevPrice: this.lastSnap ? this.lastSnap.price : null,
      analysis: extra.analysis || null,
      council: extra.council || null,
      // สมุดผลงานของสภา: อัตราชนะจริงของมติ (ตรวจผล 30 นาที) + แยกตามช่วงความมั่นใจ
      councilStats: extra.councilStats !== undefined ? extra.councilStats : (this.councilStats ? this.councilStats.snapshot() : null),
      signals: extra.signals || [],
      filteredCount: (extra.filtered || []).length,
      filtered: (extra.filtered || []).slice(0, 6),
      guard: {
        dailyCount: this.dailyCount,
        manualCount: this.manualToday,
        maxPerDay: s.maxSignalsPerDay,
        newsStop: !!s.newsStop,
        activeCount: this.active.size,
        equityUsed: effectiveEquity || s.equity,
      },
      risk: s,
      account: liveAccount,
      // แบ่งโหลด: ส่งแท่งเทียนเฉพาะไทม์เฟรมที่ "มีแท่งใหม่จริง" นับแตรอบก่อน (กัน serialize 112KB ทุกรอบเลย)
      // ฝั่ง renderer เก็บของเดิมแล้วเติมเฉพาะที่มาใหม่
      candles: picked.candles,
      candleTail: picked.tail,
      meta,
      dataSource: extra.data ? extra.data.source : null,
      // ค่าตั้งต้นของส่วนไม้จำลอง (รอบปกติเขียนทับด้วยค่าล่าสุด) — รอบผิดพลาดหน้าจอจะไม่ว่างเปล่า
      zoneHistory: (this.zoneHistory || []).slice(-25),
      zoneOpen: this.zoneOpen || [],
      zoneSummary: this._zoneSummary(),
      roundLog: this.roundLog || [],
      logs: (this.logs || []).slice(-40),
      commentaryFeed: (this.commentaryLog || []).slice(-12),
      error: extra.error || null,
    };
  }
}

module.exports = { AnalysisEngine };
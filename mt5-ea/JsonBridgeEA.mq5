//+------------------------------------------------------------------+
//| JsonBridgeEA.mq5 — GoldSignal Bridge v1.9 (pending limit/stop + modify + cancel)                       |
//| v1.9: ปิดบางส่วน (action closepart: ปิด lot ของไม้ ticket — บัญชี hedging) |
//| v1.6: ราคาสดทันทุกทิค (ไม่ทิ้งราคาล่าสุด, timer 100ms) • หยิบคำสั่งทุก 0.1 วิ |
//| v1.5: จองคำสั่งแบบ atomic + ทำงานทีละ EA เดียว • ส่งสถานะเชื่อมเซิร์ฟเวอร์/เวลา GMT |
//| v1.4: คำสั่งหมดอายุ 15 วิ • หยิบไฟล์คำสั่งแบบ atomic • กันรันซ้ำข้ามรีสตาร์ท |
//|       ล็อตต่ำกว่าขั้นต่ำ = ปฏิเสธ • JSON ถูกต้องเสมอ • ส่งสเปกสัญญา/ค่า tick |
//| 1) เขียนไฟล์ JSON (แท่งเทียน + bid/ask + ตำแหน่งเปิด) ทุก InpIntervalSec |
//| 2) รับคำสั่งซื้อ/ขายจาก goldsignal_commands.txt — ต้องเปิด InpAllowOrders |
//|    และปุ่ม AutoTrading ของเทอร์มินัลเป็นเขียวจึงจะส่งออร์เดอร์ได้จริง |
//|    ทุกไม้ที่ส่ง ต้องมี SL มิฉะนั้น EA ปฏิเสธเอง                     |
//| 3) ผลการทำงานถูกเขียนที่ goldsignal_results.txt                    |
//|                                                                  |
//| วิธีติดตั้ง: แอป GoldSignal → แท็บ เชื่อม MT5 → ปุ่มติดตั้งอัตโนมัติ |
//+------------------------------------------------------------------+
#property copyright "GoldSignal"
#property version   "1.90"
#property strict

input int    InpIntervalSec  = 3;     // เขียนไฟล์แท่งเทียน (bridge หลัก) ทุกกี่วินาที
input int    InpQuotesMs     = 100;   // ราคาสด: เขียนเร็วสุดทุกกี่มิลลิวินาที (ไม่ทิ้งราคาล่าสุด — ตามทัน MT5)
// สวิตช์การส่งไม้จริงคุมอยู่ที่ 2 ชั้นหลัก: ปุ่ม AutoTrading ในเทอรมินัล + สวิตช์ในแอป (ยืนยัน 2 ชั้น)
// (ค่าเดิมตั้ง false เพื่อความชอบของผู้ใช้ที่ขอความปลอดภัยสุด)
input bool   InpAllowOrders  = true;  // รับคำสั่งซื้อขายจากแอป GoldSignal (ต้องเปิด AutoTrading ด้วย)
input int    InpBarsM1       = 300;
input int    InpBarsM5       = 500;
input int    InpBarsM15      = 400;
input int    InpBarsH1       = 300;

#include <Trade/Trade.mqh>
CTrade trade;

string BridgeFile     = "goldsignal_bridge.json";
string BridgeFileTmp  = "goldsignal_bridge.json.tmp";
string QuotesFile     = "goldsignal_quotes.txt";
string QuotesFileTmp  = "goldsignal_quotes.txt.tmp";
string CommandFile    = "goldsignal_commands.txt";
string CommandWork    = "goldsignal_commands.work";
string LastIdVar      = "GoldSignal_LastCmdId";   // id ล่าสุดที่ทำแล้ว (GlobalVariable อยู่รอดข้ามรีสตาร์ท EA/MT5)
string OwnerVar       = "GoldSignal_OwnerChart";  // ชาร์ตที่เป็นเจ้าของ bridge (ทำงานได้ทีละ EA เดียว)
string OwnerBeatVar   = "GoldSignal_OwnerBeat";   // เวลาล่าสุดที่เจ้าของยังทำงาน (TimeLocal)
string ResultFile     = "goldsignal_results.txt";
string ResultFileTmp  = "goldsignal_results.txt.tmp";

ENUM_TIMEFRAMES TF[4]  = {PERIOD_M1, PERIOD_M5, PERIOD_M15, PERIOD_H1};
string          TFN[4] = {"M1","M5","M15","H1"};

string gResults[64];
int    gResultsCount = 0;

uint gLastSnapshotMs = 0;   // เวลาเขียน bridge หลักล่าสุด
uint gLastBeatMs = 0;       // เวลาเขียนราคาสดล่าสุด (เขียนซ้ำทุก 1 วิแม้ราคานิ่ง = แอปรู้ว่า EA ยังทำงาน)

int OnInit()
  {
   trade.SetExpertMagicNumber(20261102);
   trade.SetDeviationInPoints(30);
   trade.SetTypeFillingBySymbol(_Symbol);
   EventSetMillisecondTimer(MathMax(50, InpQuotesMs));
   if(IsOwner())
     {
      WriteSnapshot();
      { MqlTick q; if(SymbolInfoTick(_Symbol, q)) WriteQuotes(q); }
      ProcessCommands();
     }
   else Print("GoldSignal: มี JsonBridgeEA อีกตัวทำงานอยู่แล้ว — ตัวนี้รอเป็นสำรอง (ไม่ส่งคำสั่ง/ไม่เขียนไฟล์)");
   return(INIT_SUCCEEDED);
  }

uint   gLastQuoteMs = 0;
MqlTick gLastQuoteSent;

void OnDeinit(const int reason)
  {
   EventKillTimer();
   // ปล่อยความเป็นเจ้าของให้ EA ตัวอื่นรับต่อได้ทันที
   if(GlobalVariableCheck(OwnerVar) && GlobalVariableGet(OwnerVar) == (double)ChartID()) GlobalVariableDel(OwnerVar);
  }

//+------------------------------------------------------------------+
//| เจ้าของ bridge: วาง EA หลายชาร์ต = ทำงานตัวเดียว (กันส่งไม้ซ้ำ)     |
//| เจ้าของเดิมเงียบเกิน 15 วิ (ชาร์ตถูกปิด/ค้าง) = ตัวอื่นรับช่วงต่อ    |
//+------------------------------------------------------------------+
bool IsOwner()
  {
   double me = (double)ChartID();
   double now = (double)TimeLocal();
   bool has = GlobalVariableCheck(OwnerVar);
   double owner = has ? GlobalVariableGet(OwnerVar) : 0.0;
   double beat = GlobalVariableCheck(OwnerBeatVar) ? GlobalVariableGet(OwnerBeatVar) : 0.0;
   if(!has || owner == me || now - beat > 15.0)
     {
      GlobalVariableSet(OwnerVar, me);
      GlobalVariableSet(OwnerBeatVar, now);
      return true;
     }
   return false;
  }

//+------------------------------------------------------------------+
//| OnTick = ทุกทิคจริงจากโบรกเกอร์ (บางวิมีหลายทิค)                    |
//| เขียนราคาสดได้ถึง ~4 ครั้ง/วิ (เวลาแน่นเกิน 250ms ข้ามตามด้วยความเบา) |
//+------------------------------------------------------------------+
void OnTick()
  {
   if(!GlobalVariableCheck(OwnerVar) || GlobalVariableGet(OwnerVar) != (double)ChartID()) return;
   MqlTick t;
   if(!SymbolInfoTick(_Symbol, t)) return;
   if(t.bid == gLastQuoteSent.bid && t.ask == gLastQuoteSent.ask) return; // ราคาเดิม = ไม่เขียน
   // ทิคถี่กว่า InpQuotesMs: ไม่เขียนตอนนี้ แต่ timer รอบถัดไป (≤ InpQuotesMs) จะเขียนราคาล่าสุดให้เอง
   // (เดิมทิ้งทิคช่วง 250ms แล้วรอ timer 1 วิ = ราคาในแอปช้ากว่า MT5 ได้ถึง 1 วิ)
   if(GetTickCount() - gLastQuoteMs < (uint)MathMax(50, InpQuotesMs)) return;
   SendQuote(t);
  }

void SendQuote(MqlTick &t)
  {
   gLastQuoteMs = GetTickCount();
   gLastBeatMs = gLastQuoteMs;
   gLastQuoteSent = t;
   WriteQuotes(t);
  }

void OnTimer()
  {
   if(!IsOwner()) return;
   ProcessCommands();                       // คำสั่งจากแอปถูกหยิบภายใน ~0.1 วิ (เดิม 1 วิ)
   uint now = GetTickCount();
   MqlTick t;
   if(SymbolInfoTick(_Symbol, t))
     {
      bool changed = (t.bid != gLastQuoteSent.bid || t.ask != gLastQuoteSent.ask);
      if(changed || now - gLastBeatMs >= 1000) SendQuote(t);   // ราคาล่าสุดที่ OnTick ยังไม่ได้เขียน + heartbeat
     }
   if(now - gLastSnapshotMs >= (uint)MathMax(1, InpIntervalSec) * 1000)
     {
      gLastSnapshotMs = now;
      WriteSnapshot();
     }
  }

//+------------------------------------------------------------------+
//| ไฟล์ราคาสดจิ๋ว — ปุ่มซื้อขาย/ราคาหัวจอใช้ อัปเดตบ่อยกว่าแท่งเทียน    |
//+------------------------------------------------------------------+
void WriteQuotes(MqlTick &tick)
  {
   int h = FileOpen(QuotesFileTmp, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   FileWriteString(h, StringFormat("Q t=%d bid=%.5f ask=%.5f digits=%d spread=%d eq=%.2f bal=%.2f conn=%d\r\n",
                   (long)TimeCurrent(), tick.bid, tick.ask, _Digits,
                   (int)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD),
                   AccountInfoDouble(ACCOUNT_EQUITY), AccountInfoDouble(ACCOUNT_BALANCE),
                   (int)TerminalInfoInteger(TERMINAL_CONNECTED)));
   FileClose(h);
   if(!FileMove(QuotesFileTmp, 0, QuotesFile, FILE_REWRITE))
     { FileDelete(QuotesFile); FileMove(QuotesFileTmp, 0, QuotesFile, FILE_REWRITE); }
  }

//+------------------------------------------------------------------+
//| ตรวจว่าเคยดำเนินการคำสั่ง id นี้แล้วหรือยัง (กันซ้ำ)                  |
//+------------------------------------------------------------------+
bool ClaimId(long id)
  {
   // id จากแอปเพิ่มขึ้นเสมอ: จอง = ตั้ง LastId จากค่าเดิมเป็น id แบบ atomic (GlobalVariableSetOnCondition)
   // จองไม่ได้ / id ไม่ใหม่กว่า = มีคนทำไปแล้ว → ข้าม (ก่อนส่งไม้ ไม่ใช่หลังส่ง)
   if(!GlobalVariableCheck(LastIdVar)) GlobalVariableSet(LastIdVar, 0.0);
   double last = GlobalVariableGet(LastIdVar);
   if((double)id <= last) return false;
   return GlobalVariableSetOnCondition(LastIdVar, (double)id, last);
  }

//+------------------------------------------------------------------+
//| escape ข้อความก่อนใส่ JSON (ชื่อบัญชี/เซิร์ฟเวอร์อาจมี " หรือ \)   |
//+------------------------------------------------------------------+
string JsonEscape(string s)
  {
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   StringReplace(s, "\r", " ");
   StringReplace(s, "\n", " ");
   StringReplace(s, "\t", " ");
   return s;
  }

void AppendResult(long id, string status, string extra)
  {
   string line = "RES id=" + IntegerToString(id) +
                 " ts=" + IntegerToString((long)TimeCurrent()) +
                 " status=" + status + " " + extra;
   if(gResultsCount == 32) { for(int i = 0; i < 31; i++) gResults[i] = gResults[i + 1]; gResultsCount = 31; }
   gResults[gResultsCount++] = line;
   WriteResults();
  }

void WriteResults()
  {
   int h = FileOpen(ResultFileTmp, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;
   for(int i = 0; i < gResultsCount; i++)
      FileWriteString(h, gResults[i] + "\r\n");
   FileClose(h);
   if(!FileMove(ResultFileTmp, 0, ResultFile, FILE_REWRITE))
     { FileDelete(ResultFile); FileMove(ResultFileTmp, 0, ResultFile, FILE_REWRITE); }
  }

//+------------------------------------------------------------------+
//| ปรับขนาดล็อตให้เป็นก้าวที่สัญลักษณ์ยอมรับ                           |
//+------------------------------------------------------------------+
double NormalizeLot(double lot)
  {
   double vmin = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double vmax = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double step = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(step <= 0) step = 0.01;
   double v = MathFloor(lot / step + 1e-9) * step;
   if(v < vmin - 1e-9) return 0.0;
   if(v > vmax) v = vmax;
   int digits = (int)MathMax(0, MathCeil(-MathLog10(step) - 1e-9));
   return NormalizeDouble(v, digits);
  }

//+------------------------------------------------------------------+
//| อ่านคำสั่งจากแอป → ทำตาม (open/close/modify)                       |
//+------------------------------------------------------------------+
void ProcessCommands()
  {
   if(!InpAllowOrders) return; // สวิตช์ระดับ EA ปิด = อ่านอย่างเดียว ไม่ส่งออร์เดอร์เด็ดขาด
   // ย้ายไฟล์มาเป็นของ EA ก่อนอ่าน — แอปเขียนไฟล์ใหม่ระหว่างนี้ได้โดยไม่ถูกลบทิ้ง (เดิมลบหลังส่งไม้ = คำสั่งใหม่หายได้)
   if(!FileIsExist(CommandWork))
     {
      if(!FileIsExist(CommandFile)) return;
      if(!FileMove(CommandFile, 0, CommandWork, FILE_REWRITE)) return;
     }
   int h = FileOpen(CommandWork, FILE_READ | FILE_TXT | FILE_ANSI | FILE_SHARE_READ);
   if(h == INVALID_HANDLE) return;
   while(!FileIsEnding(h))
     {
      string line = FileReadString(h);
      StringTrimLeft(line); StringTrimRight(line);   // ตัดช่องว่างในตัวแปรเอง (คืนค่า = จำนวนตัวที่ตัด — เดิมเอามาทับ line ทำให้ไม่เคยอ่านคำสั่งออก)
      if(StringFind(line, "CMD ") != 0) continue;
      long id = 0; string action = "", side = "", comment = "";
      double lot = 0, sl = 0, tp = 0, pr = 0; long ticket = 0, exp = 0;
      string parts[];
      int n = StringSplit(line, ' ', parts);
      for(int i = 1; i < n; i++)
        {
         string kv[2];
         if(StringSplit(parts[i], '=', kv) == 2)
           {
            if(kv[0] == "id") id = (long)StringToInteger(kv[1]);
            else if(kv[0] == "action") action = kv[1];
            else if(kv[0] == "side") side = kv[1];
            else if(kv[0] == "lot") lot = StringToDouble(kv[1]);
            else if(kv[0] == "sl") sl = StringToDouble(kv[1]);
            else if(kv[0] == "tp") tp = StringToDouble(kv[1]);
            else if(kv[0] == "price") pr = StringToDouble(kv[1]);
            else if(kv[0] == "ticket") ticket = (long)StringToInteger(kv[1]);
            else if(kv[0] == "exp") exp = (long)StringToInteger(kv[1]);
           }
        }
      if(id == 0 || !ClaimId(id)) continue;
      // ต้องมีเวลาหมดอายุเสมอ: คำสั่งจากแอปรุ่นเก่า (ไม่มี exp) อาจค้างมานาน — ไม่ส่งไม้จากคำสั่งเหล่านั้น
      if(exp <= 0 || (long)TimeGMT() > exp)
         AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=EXPIRED");
      else
         ExecuteCommand(id, action, side, lot, sl, tp, ticket, pr);
     }
   FileClose(h);
   FileDelete(CommandWork);
  }

void ExecuteCommand(long id, string action, string side, double lot, double sl, double tp, long ticket, double pr)
  {
   if(action == "open")
     {
      if(lot <= 0) { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=BAD_LOT"); return; }
      if(sl <= 0)  { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=SL_REQUIRED"); return; }
      double vol = NormalizeLot(lot);
      if(vol <= 0) { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=LOT_BELOW_MIN"); return; }
      sl = NormalizeDouble(sl, _Digits);
      tp = tp > 0 ? NormalizeDouble(tp, _Digits) : 0.0;
      bool res = (side == "buy") ? trade.Buy(vol, _Symbol, 0.0, sl, tp, "GoldSignal")
                                 : trade.Sell(vol, _Symbol, 0.0, sl, tp, "GoldSignal");
      string extra = StringFormat("retcode=%d ticket=%I64d price=%.2f vol=%.2f", (int)trade.ResultRetcode(),
                                  (long)trade.ResultOrder(), trade.ResultPrice(), trade.ResultVolume());
      AppendResult(id, res ? "ok" : "error", extra + " msg=" + trade.ResultRetcodeDescription());
      return;
     }
   if(action == "close")
     {
      if(ticket <= 0 || !PositionSelectByTicket(ticket)) { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=POSITION_NOT_FOUND"); return; }
      bool res = trade.PositionClose(ticket);
      AppendResult(id, res ? "ok" : "error",
                   StringFormat("retcode=%d ticket=%I64d price=%.2f msg=%s", (int)trade.ResultRetcode(), ticket, trade.ResultPrice(), trade.ResultRetcodeDescription()));
      return;
     }
   if(action == "closepart")
     {
      // ปิดบางส่วน (v1.9): lot = ล็อตที่จะปิด • ต้องเหลือไม้ ≥ ขั้นต่ำโบรก (ปิดหมดให้ใช้ action close)
      if(ticket <= 0 || !PositionSelectByTicket(ticket)) { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=POSITION_NOT_FOUND"); return; }
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=SYMBOL_MISMATCH"); return; }
      // CTrade::PositionClosePartial ทำงานเฉพาะบัญชี hedging (netting คืน false โดยไม่ล้างผลเก่า) — ปฏิเสธเองให้ชัด
      if((ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE) != ACCOUNT_MARGIN_MODE_RETAIL_HEDGING) { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=HEDGING_ONLY"); return; }
      if(lot <= 0) { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=BAD_LOT"); return; }
      double vol = NormalizeLot(lot);   // ปัดลงตาม SYMBOL_VOLUME_STEP • ต่ำกว่า VOLUME_MIN = 0
      if(vol <= 0) { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=LOT_BELOW_MIN"); return; }
      double vmin = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
      double posVol = PositionGetDouble(POSITION_VOLUME);
      if(posVol - vol < vmin - 1e-9) { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=REMAIN_BELOW_MIN"); return; }
      bool res = trade.PositionClosePartial((ulong)ticket, vol);
      AppendResult(id, res ? "ok" : "error",
                   StringFormat("retcode=%d ticket=%I64d price=%.2f vol=%.2f msg=%s", (int)trade.ResultRetcode(), ticket, trade.ResultPrice(), vol, trade.ResultRetcodeDescription()));
      return;
     }
   if(action == "modify")
     {
      if(ticket <= 0 || !PositionSelectByTicket(ticket)) { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=POSITION_NOT_FOUND"); return; }
      bool res = trade.PositionModify(ticket, NormalizeDouble(sl, _Digits), tp > 0 ? NormalizeDouble(tp, _Digits) : 0.0);
      AppendResult(id, res ? "ok" : "error",
                   StringFormat("retcode=%d ticket=%I64d price=0 msg=%s", (int)trade.ResultRetcode(), ticket, trade.ResultRetcodeDescription()));
      return;
     }
   if(action == "limit" || action == "stop")
     {
      if(lot <= 0) { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=BAD_LOT"); return; }
      if(pr <= 0)  { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=PRICE_REQUIRED"); return; }
      if(sl <= 0)  { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=SL_REQUIRED"); return; }
      double vol = NormalizeLot(lot);
      if(vol <= 0) { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=LOT_BELOW_MIN"); return; }
      pr = NormalizeDouble(pr, _Digits);
      sl = NormalizeDouble(sl, _Digits);
      tp = tp > 0 ? NormalizeDouble(tp, _Digits) : 0.0;
      bool res = false;
      if(action == "limit") res = (side == "buy") ? trade.BuyLimit(vol, pr, _Symbol, sl, tp, ORDER_TIME_GTC, 0, "GoldSignal")
                                                  : trade.SellLimit(vol, pr, _Symbol, sl, tp, ORDER_TIME_GTC, 0, "GoldSignal");
      else res = (side == "buy") ? trade.BuyStop(vol, pr, _Symbol, sl, tp, ORDER_TIME_GTC, 0, "GoldSignal")
                                 : trade.SellStop(vol, pr, _Symbol, sl, tp, ORDER_TIME_GTC, 0, "GoldSignal");
      string extra2 = StringFormat("retcode=%d ticket=%I64d price=%.2f vol=%.2f", (int)trade.ResultRetcode(),
                                    (long)trade.ResultOrder(), trade.ResultPrice(), trade.ResultVolume());
      AppendResult(id, res ? "ok" : "error", extra2 + " msg=" + trade.ResultRetcodeDescription());
      return;
     }
   if(action == "pmodify")
     {
      // แก้คำสั่งรอ (limit/stop ที่ยังไม่ trigger): ราคาเข้า + SL + TP — SL ห้ามเป็น 0
      if(ticket <= 0 || !OrderSelect(ticket)) { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=ORDER_NOT_FOUND"); return; }
      if(sl <= 0) { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=SL_REQUIRED"); return; }
      double np = pr > 0 ? NormalizeDouble(pr, _Digits) : OrderGetDouble(ORDER_PRICE_OPEN);
      bool res = trade.OrderModify(ticket, np, NormalizeDouble(sl, _Digits), tp > 0 ? NormalizeDouble(tp, _Digits) : 0.0, ORDER_TIME_GTC, 0);
      AppendResult(id, res ? "ok" : "error", StringFormat("retcode=%d ticket=%I64d price=%.2f msg=%s", (int)trade.ResultRetcode(), ticket, np, trade.ResultRetcodeDescription()));
      return;
     }
   if(action == "cancel")
     {
      if(ticket <= 0 || !OrderSelect(ticket)) { AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=ORDER_NOT_FOUND"); return; }
      bool res = trade.OrderDelete(ticket);
      AppendResult(id, res ? "ok" : "error", StringFormat("retcode=%d ticket=%I64d price=0 msg=%s", (int)trade.ResultRetcode(), ticket, trade.ResultRetcodeDescription()));
      return;
     }
   AppendResult(id, "error", "retcode=0 ticket=0 price=0 msg=UNKNOWN_ACTION");
  }

//+------------------------------------------------------------------+
//| เขียนสแนปช็อต: แท่งเทียน + ราคา bid/ask + ตำแหน่งเปิดทั้งหมด          |
//+------------------------------------------------------------------+
void AppendTF(string &json, int tfIdx, int &wrote)
  {
   MqlRates rates[];
   int want = 200;
   switch(tfIdx)
     {
      case 0: want = InpBarsM1;  break;
      case 1: want = InpBarsM5;  break;
      case 2: want = InpBarsM15; break;
      case 3: want = InpBarsH1;  break;
     }
   int got = CopyRates(_Symbol, TF[tfIdx], 0, want, rates);
   if(got <= 0) return;
   ArraySetAsSeries(rates, false);
   if(wrote > 0) json += ",";
   wrote++;
   json += "\"" + TFN[tfIdx] + "\":[";
   for(int i = 0; i < got; i++)
     {
      if(i > 0) json += ",";
      json += StringFormat("[%d,%.2f,%.2f,%.2f,%.2f,%d]",
                           (long)rates[i].time,
                           rates[i].open, rates[i].high, rates[i].low,
                           rates[i].close, (long)rates[i].tick_volume);
     }
   json += "]";
  }

//+------------------------------------------------------------------+
//| ประวัติไม้จริงที่ปิดแล้ว (ใหม่สุดก่อน, ล่าสุด 30 รายการ, เฉพาะ XAUUSD)   |
//| deal ฝั่งปิด (OUT) = แหล่งความจริงของเทอร์มินัล: ครอบคลุม TP/SL/ปิดเอง    |
//+------------------------------------------------------------------+
void AppendHistory(string &json)
  {
   if(!HistorySelect(TimeCurrent() - 30 * 86400, TimeCurrent() + 60)) { json += "[]"; return; }   // 30 วันพอ (เดิมทั้งบัญชีทุก 3 วิ)
   int total = HistoryDealsTotal();
   int from = MathMax(0, total - 80);
   long inPid[80]; double inPx[80]; int mapCount = 0;   // หาราคาเปิดจาก deal ฝั่งเข้า (IN)
   for(int i = from; i < total && mapCount < 80; i++)
     {
      ulong tk = HistoryDealGetTicket(i);
      if(tk == 0) continue;
      if(HistoryDealGetString(tk, DEAL_SYMBOL) != _Symbol) continue;
      if(HistoryDealGetInteger(tk, DEAL_ENTRY) != DEAL_ENTRY_IN) continue;
      inPid[mapCount] = (long)HistoryDealGetInteger(tk, DEAL_POSITION_ID);
      inPx[mapCount] = HistoryDealGetDouble(tk, DEAL_PRICE);
      mapCount++;
     }
   json += "[";
   int wrote = 0;
   for(int i = total - 1; i >= from; i--)        // ใหม่สุดมาก่อน
     {
      ulong tk = HistoryDealGetTicket(i);
      if(tk == 0) continue;
      long entry = HistoryDealGetInteger(tk, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY) continue;
      if(HistoryDealGetString(tk, DEAL_SYMBOL) != _Symbol) continue;
      long pid = (long)HistoryDealGetInteger(tk, DEAL_POSITION_ID);
      double openPx = 0.0;
      for(int m = 0; m < mapCount; m++)
         if(inPx[m] > 0.0 && inPid[m] == pid) { openPx = inPx[m]; break; }
      long dtype = HistoryDealGetInteger(tk, DEAL_TYPE);  // OUT ของไม้ซื้อ = deal ขาย
      string ptype = (dtype == DEAL_TYPE_SELL) ? "buy" : "sell";
      double net = HistoryDealGetDouble(tk, DEAL_PROFIT) + HistoryDealGetDouble(tk, DEAL_COMMISSION) + HistoryDealGetDouble(tk, DEAL_SWAP);
      long reason = HistoryDealGetInteger(tk, DEAL_REASON);
      string why = "manual";               // 4=SL 5=TP 6=SO นอกนั้น = ปิดเอง/คำสั่งแอป
      if(reason == DEAL_REASON_SL) why = "SL";
      else if(reason == DEAL_REASON_TP) why = "TP";
      else if(reason == DEAL_REASON_SO) why = "SO";
      if(wrote > 0) json += ",";
      json += StringFormat("{\"pid\":%I64d,\"type\":\"%s\",\"volume\":%.2f,\"open\":%.2f,\"close\":%.2f,\"profit\":%.2f,\"reason\":\"%s\",\"time\":%I64d}",
                           pid, ptype, HistoryDealGetDouble(tk, DEAL_VOLUME), openPx,
                           HistoryDealGetDouble(tk, DEAL_PRICE), net, why,
                           (long)HistoryDealGetInteger(tk, DEAL_TIME));
      wrote++;
      if(wrote >= 30) break;
     }
   json += "]";
  }

void WriteSnapshot()
  {
   int h = FileOpen(BridgeFileTmp, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE) return;

   MqlTick tick;
   bool hasTick = SymbolInfoTick(_Symbol, tick);

   string json = "{\"t\":" + IntegerToString((long)TimeCurrent()) +
                 ",\"gmt\":" + IntegerToString((long)TimeGMT()) +
                 ",\"srv\":" + IntegerToString((long)TimeTradeServer()) +
                 ",\"symbol\":\"" + _Symbol + "\"" +
                 ",\"digits\":" + IntegerToString(_Digits);
   json += ",\"ea\":\"1.9\"";
   if(hasTick)
     {
      json += StringFormat(",\"bid\":%.5f,\"ask\":%.5f,\"spreadPts\":%d", tick.bid, tick.ask,
                           (int)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD));
     }
   // สเปกสัญญา: แอปใช้แปลงทุนสกุลบัญชี → USD และคิดเงินเสี่ยงตามขนาดสัญญาจริงของโบรกเกอร์
   json += StringFormat(",\"contractSize\":%.2f,\"tickValue\":%.8f,\"tickSize\":%.8f,\"volMin\":%.2f,\"volStep\":%.2f",
                        SymbolInfoDouble(_Symbol, SYMBOL_TRADE_CONTRACT_SIZE),
                        SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE),
                        SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE),
                        SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN),
                        SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP));
   json += ",\"account\":{\"login\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) +
           ",\"name\":\"" + JsonEscape(AccountInfoString(ACCOUNT_NAME)) + "\"" +
           ",\"server\":\"" + JsonEscape(AccountInfoString(ACCOUNT_SERVER)) + "\"" +
           ",\"currency\":\"" + JsonEscape(AccountInfoString(ACCOUNT_CURRENCY)) + "\"" +
           StringFormat(",\"balance\":%.2f,\"equity\":%.2f,\"margin\":%.2f,\"marginFree\":%.2f,\"leverage\":%d",
                        AccountInfoDouble(ACCOUNT_BALANCE), AccountInfoDouble(ACCOUNT_EQUITY),
                        AccountInfoDouble(ACCOUNT_MARGIN), AccountInfoDouble(ACCOUNT_MARGIN_FREE),
                        (int)AccountInfoInteger(ACCOUNT_LEVERAGE)) +
           ",\"ordersAllowed\":" + (InpAllowOrders ? "true" : "false") +
           ",\"algoTrading\":" + (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) ? "true" : "false") +
           "}";
   json += ",\"positions\":[";
   int posWrote = 0;
   for(int i = 0; i < PositionsTotal(); i++)
     {
      ulong tk = PositionGetTicket(i);
      if(tk == 0) continue;
      if(PositionGetString(POSITION_SYMBOL) != _Symbol) continue;
      if(posWrote > 0) json += ",";
      posWrote++;
      long t = PositionGetInteger(POSITION_TYPE);
      json += StringFormat("{\"ticket\":%I64d,\"type\":\"%s\",\"volume\":%.2f,\"open\":%.2f,\"sl\":%.2f,\"tp\":%.2f,\"profit\":%.2f}",
                           tk, (t == POSITION_TYPE_BUY ? "buy" : "sell"),
                           PositionGetDouble(POSITION_VOLUME), PositionGetDouble(POSITION_PRICE_OPEN),
                           PositionGetDouble(POSITION_SL), PositionGetDouble(POSITION_TP),
                           PositionGetDouble(POSITION_PROFIT));
     }
   json += "],\"pendings\":[";
   int wroteP = 0;
   for(int i = 0; i < OrdersTotal(); i++)
     {
      ulong ot = OrderGetTicket(i);
      if(ot == 0) continue;
      if(OrderGetString(ORDER_SYMBOL) != _Symbol) continue;
      long pt2 = OrderGetInteger(ORDER_TYPE);
      string pt3 = (pt2 == ORDER_TYPE_BUY_LIMIT ? "buylimit" : (pt2 == ORDER_TYPE_SELL_LIMIT ? "selllimit" : (pt2 == ORDER_TYPE_BUY_STOP ? "buystop" : (pt2 == ORDER_TYPE_SELL_STOP ? "sellstop" : "other"))));
      if(wroteP > 0) json += ",";
      json += StringFormat("{\"ticket\":%I64d,\"type\":\"%s\",\"volume\":%.2f,\"open\":%.2f,\"sl\":%.2f,\"tp\":%.2f}",
                           ot, pt3, OrderGetDouble(ORDER_VOLUME_CURRENT), OrderGetDouble(ORDER_PRICE_OPEN),
                           OrderGetDouble(ORDER_SL), OrderGetDouble(ORDER_TP));
      wroteP++;
     }
   json += "],\"history\":";
   AppendHistory(json);
   json += ",\"candles\":{";
   int tfWrote = 0;
   for(int tf = 0; tf < 4; tf++)
      AppendTF(json, tf, tfWrote);
   json += "}}";

   FileWriteString(h, json);
   FileClose(h);
   if(!FileMove(BridgeFileTmp, 0, BridgeFile, FILE_REWRITE))
     { FileDelete(BridgeFile); FileMove(BridgeFileTmp, 0, BridgeFile, FILE_REWRITE); }
  }
//+------------------------------------------------------------------+
# GoldSignal — คู่มือนักพัฒนา (clone, ตั้งค่า, พัฒนาต่อ, ติดตั้งที่อื่น)

เอกสารนี้สำหรับคนที่จะ **clone โค้ดไปพัฒนาต่อ** หรือ **ติดตั้งบนเครื่องใหม่** ส่วนวิธีใช้งานแอปอยู่ใน [README.md](README.md)

> ⚠️ แอปนี้ส่งออร์เดอร์เข้าบัญชี MT5 จริงได้ (เมื่อเปิดสวิตช์) — ทดสอบบนบัญชี **Demo** ก่อนทุกครั้งที่แก้โค้ดส่วนออร์เดอร์/ความเสี่ยง

---

## 1. สิ่งที่ต้องมี

| สิ่งที่ต้องมี | รุ่น | หมายเหตุ |
|---|---|---|
| macOS | Apple Silicon (M1–M4) | DMG ที่ build ได้เป็น `arm64` · Mac Intel ต้อง build เอง (ดูข้อ 4) |
| Node.js | 18 ขึ้นไป | `node -v` |
| Git | ใดก็ได้ | |
| MetaTrader 5 for Mac | ล่าสุด | ล็อกอินบัญชีแล้วเปิดชาร์ต XAUUSD ได้ |
| GitHub CLI `gh` | ไม่บังคับ | ใช้ตั้ง "ลิงก์ถาวร" GitHub Pages (`brew install gh && gh auth login`) |
| cloudflared / ngrok / Tailscale | ไม่บังคับ | ใช้เปิดแผงเว็บออกอินเทอร์เน็ต (`brew install cloudflared`) |

---

## 2. Clone และรันครั้งแรก

```bash
git clone https://github.com/ProgramZa2560/GoldSignal.git
cd GoldSignal
npm install
npm start          # เปิดแอปโหมดพัฒนา (electron .)
```

ทดสอบอัตโนมัติ (ต้องผ่านทุกข้อก่อน commit):

```bash
npm run smoke                       # ~55 รายการ ไม่ต้องต่อเน็ต
SMOKE_NETWORK=1 npm run smoke       # + ทดสอบดึงราคาจริงจาก Yahoo
```

> ⚠️ อย่ารัน `npm start` พร้อมกับแอปที่ติดตั้งไว้ใน /Applications บนเครื่องที่ต่อบัญชีจริง — ทั้งสองตัวอ่าน MT5 ตัวเดียวกัน และถ้าเปิดสวิตช์อัตโนมัติไว้ อาจส่งคำสั่งซ้ำกันได้ (ปิดตัวหนึ่งก่อนด้วย Cmd+Q)

---

## 3. โครงสร้างโปรเจกต์

```
src/main/            ส่วนหลังของแอป (Electron main process)
  main.js            จุดเริ่ม: หน้าต่าง, IPC handlers, เกตส่งออร์เดอร์, เข้าไม้/ปิดอัตโนมัติ, Telegram hooks
  preload.js         window.api ของหน้าต่างแอป (ชื่อคำสั่งทุกตัว)
  webserver.js       เว็บควบคุมเต็ม port 8008 (ล็อกอิน, /api/call/*, SSE /api/events)
  webauth.js         รหัสผ่านเว็บ (scrypt) + session + ค่าตั้ง tunnel/Pages
  tunnel.js          cloudflared / ngrok / Tailscale Funnel
  pages.js           ลิงก์ถาวร GitHub Pages (ผ่าน gh CLI) + pages-index.html
  telegram.js        แจ้งเตือน Telegram (คิว, rate limit, เลือกเหตุการณ์)
  line.js            แจ้งเตือน LINE Messaging API (push, คิว, เลือกเหตุการณ์แยกได้)
src/engine/          สมองวิเคราะห์ (ไม่พึ่ง Electron — ทดสอบด้วย node ได้)
  engine.js          รอบวิเคราะห์ทุก N วินาที → snapshot
  analysis.js        EMA/RSI/ATR/Bollinger หลายไทม์เฟรม + แนวรับ/ต้าน
  council.js         ทีมเอเจนต์ 7 คน (v3) + ประธานสภา + gateSignal
  risk.js            กฎความเสี่ยงที่ล็อกในโค้ด (SL บังคับ, เพดาน 2%, RR, โควตา)
  autoclose.js       ปิดรวบ/ตัดขาดทุน/ปิดรายไม้ (คำนวณอย่างเดียว)
  entryplan.js       โซนรอเข้า + ไม้เสมือน
  skillbook.js       สถิติผลงานรายเอเจนต์ → ปรับน้ำหนัก
  connectors/mt5.js  อ่าน bridge JSON / เขียนคำสั่งให้ EA / คอมไพล์ EA ผ่าน Wine
  connectors/yahoo.js ราคาสำรอง COMEX GC=F
renderer/            หน้าจอ (ใช้ทั้งในแอปและบนเว็บ)
  index.html app.js styles.css   หน้าแอปหลัก
  history.html history.js         หน้าต่างประวัติรอบทั้งหมด
  web-api.js         ตัวแทน window.api เมื่อเปิดผ่านเว็บ (HTTP + SSE)
plugins/             กลยุทธ์ในตัว (ระบบ plugin เปิด — ดู README)
mt5-ea/JsonBridgeEA.mq5   EA ฝั่ง MT5 (รุ่น 1.9)
scripts/smoke.js     ชุดทดสอบ
scripts/backtest.js  backtest 60 วัน (Yahoo GC=F 5m) ด้วย pipe เดียวกับแอป
remote/deploy/       เซิร์ฟเวอร์แดชบอร์ดแบบ push (ทางเลือกเก่า)
```

### การไหลของข้อมูล

```
MT5 + JsonBridgeEA ──เขียนไฟล์──▶ goldsignal_bridge.json / goldsignal_quotes.txt
                                     │
                         connectors/mt5.js (อ่านทุกทิค)
                                     │
   engine.js → analysis → council → plugins → risk  ──▶ snapshot
                                     │
          main.js ── IPC ──▶ หน้าต่างแอป (renderer)
                   └ HTTP/SSE ─▶ หน้าเว็บ (renderer + web-api.js)
คำสั่ง (ซื้อ/ขาย/ปิด/แก้) ─▶ main.js ตรวจเกต ─▶ goldsignal_commands.txt ─▶ EA ─▶ ผลกลับ goldsignal_results.txt
```

### กฎเวลาเพิ่มคำสั่งใหม่ (IPC)

1. ลงทะเบียนใน `main.js` ด้วย `handle('ชื่อ', fn)` — คำสั่งจะใช้ได้ทั้งในแอปและบนเว็บอัตโนมัติ
2. เพิ่มชื่อใน `src/main/preload.js` **และ** `renderer/web-api.js` (smoke test ตรวจว่าครบตรงกัน)
3. ถ้าเป็นคำสั่งที่เปิดหน้าต่าง/ไฟล์บนเครื่อง หรือจัดการรหัส/token → ใส่ใน `WEB_BLOCKED` (`main.js`) ห้ามเรียกจากเว็บ
4. คำสั่งที่ส่งออร์เดอร์ต้องผ่าน `orderGatePre()` + ฟังก์ชันตรวจใน `risk.js` เสมอ

---

## 4. Build ตัวติดตั้ง (DMG)

```bash
npm run dist          # → dist/GoldSignal-<version>-arm64.dmg และ dist/mac-arm64/GoldSignal.app
```

- เลขเวอร์ชันอยู่ที่ `package.json` → `"version"`
- แอปไม่ได้เซ็นชื่อ (`identity: null`) → เครื่องอื่นเปิดครั้งแรกให้ **คลิกขวา → Open** หรือ
  ```bash
  xattr -dr com.apple.quarantine /Applications/GoldSignal.app
  ```
- Mac Intel: build บนเครื่อง Intel เอง (`npm run dist`) หรือเพิ่ม `"arch": ["x64"]` ใน `build.mac.target`

ติดตั้งทับบนเครื่องตัวเอง:

```bash
osascript -e 'quit app "GoldSignal"'
rm -rf /Applications/GoldSignal.app && ditto dist/mac-arm64/GoldSignal.app /Applications/GoldSignal.app
xattr -dr com.apple.quarantine /Applications/GoldSignal.app && open -a /Applications/GoldSignal.app
```

---

## 5. ติดตั้ง EA ใน MT5

**ง่ายสุด:** เปิดแอป → แท็บ **MT5** → กด **ติดตั้ง EA ให้ฉันเอง** (คัดลอก + คอมไพล์ผ่าน Wine ให้)

**ทำเอง:**
1. คัดลอก `mt5-ea/JsonBridgeEA.mq5` ไปที่
   `~/Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Experts/GoldSignal/`
2. MT5 → F4 (MetaEditor) → เปิดไฟล์ → Compile (F7) → ต้องได้ `0 errors`
3. ลาก `JsonBridgeEA` ลงชาร์ต XAUUSD → Inputs: `AllowOrders = true` → กด AutoTrading (Ctrl+E) ให้เขียว

> แก้ EA แล้ว: ต้อง **ถอด EA ออกจากชาร์ตแล้วลากใหม่** MT5 ถึงจะโหลดรุ่นใหม่ (ตรวจได้จาก `"ea"` ในไฟล์ bridge)

---

## 6. ข้อมูลผู้ใช้ (ไม่อยู่ใน git)

ทุกอย่างอยู่ที่ `~/Library/Application Support/GoldSignal/`

| ไฟล์ | เก็บอะไร | ย้ายเครื่องได้ไหม |
|---|---|---|
| `settings.json` | ค่าตั้งทั้งหมด (ความเสี่ยง, สภา, สวิตช์อัตโนมัติ) | ✅ (แนะนำปิด `realOrdersEnabled`/`autoEnter` ก่อนย้าย) |
| `zone-history.json` | ไม้เสมือน | ✅ |
| `round-history.jsonl` | ประวัติรอบทั้งหมด | ✅ |
| `agent-skills.json` | สถิติผลงานเอเจนต์ | ✅ |
| `web-auth.json` | hash รหัสเว็บ + ค่า tunnel/Pages (สิทธิ์ 600) | ✅ แต่เป็นข้อมูลลับ |
| `telegram.json` | bot token + chat id (สิทธิ์ 600) | ✅ แต่เป็นข้อมูลลับ |
| `app.log` | log | ไม่จำเป็น |

> 🔒 ห้าม commit ไฟล์ในโฟลเดอร์นี้ขึ้น git — `web-auth.json` และ `telegram.json` เป็นข้อมูลลับ

---

## 7. ย้าย/ติดตั้งบนเครื่องใหม่ (ทีละขั้น)

1. ติดตั้ง MetaTrader 5 แล้วล็อกอินบัญชี
2. ติดตั้งแอป: เปิด DMG ลากไป Applications (หรือ clone + `npm install` + `npm run dist`)
3. เปิดแอป 1 ครั้งแล้วปิด (Cmd+Q) เพื่อให้สร้างโฟลเดอร์ข้อมูล
4. (ถ้าต้องการค่าตั้ง/ประวัติเดิม) คัดลอกไฟล์จากข้อ 6 ของเครื่องเก่า ไปที่ `~/Library/Application Support/GoldSignal/` ของเครื่องใหม่
5. ติดตั้ง EA ตามข้อ 5
6. เปิดแอป → ตรวจว่าการ์ด MT5 ขึ้น "เชื่อมต่อ MT5 แล้ว" และบัญชี/ทุนถูกต้อง **ก่อน** เปิดสวิตช์ "ส่งออร์เดอร์จริง"
7. ตั้งค่าเสริมตามต้องการ: รหัสเว็บ / tunnel / ลิงก์ถาวร (ข้อ 8), Telegram (ข้อ 9)

---

## 8. เว็บควบคุมเต็ม + tunnel + ลิงก์ถาวร

- เว็บเปิดอัตโนมัติที่ `http://localhost:8008` (ชน → ไล่ 8009–8019) · ต้อง **ตั้งรหัสเว็บ** ก่อน (แท็บ MT5 → แผงระยะไกล)
- **เข้าจากนอกเครื่อง:** เปิดสวิตช์ในแผง → ฟัง `0.0.0.0` (Wi-Fi / Tailscale)
- **tunnel:** แอปหาโปรแกรมจาก `/opt/homebrew/bin`, `/usr/local/bin` และ `/Applications/Tailscale.app` เอง
  - cloudflared: ไม่ต้องสมัคร ลิงก์ `*.trycloudflare.com` เปลี่ยนทุกครั้ง
  - ngrok: ต้อง `ngrok config add-authtoken <token>` ก่อน
  - Tailscale Funnel: ต้องเปิด Funnel ใน admin ของ tailnet · ลิงก์ถาวร `*.ts.net`
- **ลิงก์ถาวร (GitHub Pages):** ใส่ repo `owner/name` แล้วกด "ตั้งลิงก์ถาวร" → แอปสร้าง repo public + เปิด Pages + อัปเดต `gs-link.json` ทุกครั้งที่ tunnel ได้ URL ใหม่ (ใช้ `gh` ที่ล็อกอินไว้ — แอปไม่เก็บ GitHub token)
  - ⚠️ อย่าใช้ชื่อ repo ที่เก็บโค้ด (เช่น `GoldSignal`) — แอปจะเขียนไฟล์ทับ ให้ใช้ repo แยก เช่น `goldsignal-link`
- ความปลอดภัย: ทุกหน้าต้องล็อกอิน · ผิด 5 ครั้ง/IP = ล็อก 15 นาที · คำขอผ่าน tunnel ไม่นับเป็น "เครื่องนี้" · คำสั่งจากเว็บผ่านเกตความเสี่ยงชุดเดียวกับแอป

---

## 9. แจ้งเตือน Telegram

1. Telegram → **@BotFather** → `/newbot` → ได้ token
2. แอป → แท็บ MT5 → การ์ด Telegram → วาง token → บันทึก
3. เปิดแชตกับ bot → กด Start → กลับมากด **หา chat id**
4. เปิดสวิตช์ "เปิดแจ้งเตือน" → **ส่งทดสอบ**

หมายเหตุเทคนิค:
- ส่งด้วย `net.fetch` ของ Electron — `fetch` ของ Node ภายใน Electron ต่อ `api.telegram.org` ไม่ได้ในบางเน็ต (ETIMEDOUT)
- แอปตั้ง `dns.setDefaultResultOrder('ipv4first')` เพราะเน็ตบางบ้าน IPv6 ไปไม่ถึง
- error `409 Conflict` = มีโปรแกรมอื่นใช้ token เดียวกันดึงข้อความ → ปิดโปรแกรมนั้น หรือใส่ chat id เอง (ถาม @userinfobot)

## 9.1 แจ้งเตือน LINE

1. [developers.line.biz](https://developers.line.biz/) → **Provider** + **Messaging API channel** ใหม่
2. แท็บ **Messaging API** → **Channel access token (long-lived)** → Issue → คัดลอก token
3. แอป → แท็บ MT5 → การ์ด **LINE** → วาง token → บันทึก
4. แท็บ **Basic settings** → `Your user ID` (ขึ้นต้น U + 32 ตัว) → วางในช่อง User ID → บันทึก
5. เพิ่มเพื่อน OA (QR ในแท็บ Messaging API) → เปิดสวิตช์ → **ส่งทดสอบ**
6. เลือกเหตุการณ์ที่จะแจ้งแยกจาก Telegram ได้

หมายเหตุเทคนิค:
- ส่งผ่าน `POST https://api.line.me/v2/bot/message/push` (Bearer token) — คิวห่าง ≥1.4 วิ, ล้มเหลว 3 ครั้ง = ทิ้งข้อความนั้น
- `401` = token ผิด/หมดอายุ, `400` = userId ไม่ถูก (ต้องเป็น U… หรือ C… + 32 ตัวอักษร)
- token อยู่ไฟล์ `line.json` (สิทธิ์ 600) เหมือน `telegram.json` — หน้าเว็บระยะไกลอ่าน/แก้ไม่ได้ (IPC `line-get/set/test` อยู่ใน `WEB_BLOCKED`)

---

## 10. Backtest และการแก้ทีมเอเจนต์

```bash
node scripts/backtest.js            # ใช้แคช ≤6 ชม. (.backtest-cache.json)
node scripts/backtest.js --refresh  # ดึงใหม่
COUNCIL_MIN=60 node scripts/backtest.js
```

- backtest ใช้แท่ง M15/H1 **เฉพาะส่วนที่เกิดแล้ว** ณ จุดตัดสินใจ (ห้ามใช้แท่งเต็มของอนาคต — เคยเป็นบั๊ก lookahead ทำให้ผลดีเกินจริง)
- แก้กฎใน `council.js`: วัดผลแยก **ครึ่งแรก/ครึ่งหลัง** ของข้อมูล และเก็บเฉพาะสัญญาณที่บวกทั้งสองครึ่ง
- เปลี่ยนตรรกะเอเจนต์มาก → ลบ `agent-skills.json` (สถิติเดิมวัดจากตรรกะเก่า)
- ผล backtest ไม่การันตีอนาคต

---

## 11. ขั้นตอนปล่อยเวอร์ชัน

```bash
npm run smoke                                   # ต้องผ่านทั้งหมด
# แก้ "version" ใน package.json
npm run dist
git add -A && git commit -m "x.y.z: <สิ่งที่เปลี่ยน>"
git push origin main
```

ถ้าแก้ EA: เพิ่มเลข `#property version` และ `"ea"` ใน `JsonBridgeEA.mq5` แล้วให้ฝั่งแอปตรวจรุ่นขั้นต่ำก่อนเรียกคำสั่งใหม่ (ดู `EA_PMODIFY` ใน `main.js`)

---

## 12. แก้ปัญหาที่เจอบ่อย

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| การ์ด MT5 แดง "ยังไม่พบไฟล์ bridge" | EA ยังไม่อยู่บนชาร์ต หรือ AutoTrading ปิด → ลาก EA + Ctrl+E |
| สั่งแก้คำสั่งรอแล้วขึ้นให้ติดตั้ง EA 1.8 | ถอด EA ออกจากชาร์ตแล้วลากใหม่ |
| กดปิดครึ่งแล้วขึ้นให้ติดตั้ง EA 1.9 | แท็บ MT5 → ติดตั้ง EA ให้ฉันเอง → ถอด EA ออกจากชาร์ตแล้วลากใหม่ (ปิดครึ่งใช้ได้เฉพาะบัญชีแบบ hedging) |
| `no changes (retcode 10025)` | ค่าที่แก้เหมือนเดิม — แอปกันไว้แล้ว |
| สัญญาณถูกปฏิเสธ "ล็อตขั้นต่ำ 0.01 ทำให้ความเสี่ยงเกิน" | ทุนเล็กเมื่อเทียบระยะ SL (เพดาน 2%) — ตั้งใจให้ปฏิเสธ |
| เปิดเว็บแล้ววนกลับหน้าล็อกอิน | ยังไม่ตั้งรหัสเว็บ หรือ session หมด (ปิดแอป = ต้องล็อกอินใหม่) |
| tunnel ขึ้นแดง | ดูข้อความในแผง — ngrok ต้องมี authtoken, Tailscale ต้องเปิด Funnel |
| เครื่องหลับแล้วระบบหยุด | แอปกันเครื่องหลับเมื่อเปิดระบบอัตโนมัติ แต่พับฝาโน้ตบุ๊กยังหลับ (ต่อจอนอก/ปลั๊ก) |
| ดู log | แท็บ "บันทึก" ในแอป หรือ `~/Library/Application Support/GoldSignal/app.log` |

#!/bin/bash
# ============================================================
# GoldSignal Remote Dashboard — ติดตั้งบน Ubuntu/Debian VPS
# ใช้ (บน server): bash install.sh
#   (เลือกสร้าง token ใหม่เอง | แนะนำรันด้วย sudo)
# ============================================================
set -e

APP_DIR="/opt/goldsignal-web"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "รันด้วย sudo เช่น: sudo bash install.sh"; exit 1; }

# 1) node ให้พร้อม (ถ้าไม่มี)
if ! command -v node >/dev/null 2>&1; then
  echo "ติดตั้ง Node.js ผ่าน apt..."
  apt-get update -qq && apt-get install -y -qq nodejs
fi
node -v

# 2) โครงไฟล์
mkdir -p "$APP_DIR"
cp "$SRC_DIR/server-dashboard.js" "$APP_DIR/"
cp "$SRC_DIR/remote-dashboard.html" "$APP_DIR/"

# 3) token (รหัสลับ): ใช้ที่มีอยู่ถ้ามี ไม่ทิ้งไว้ = สร้างใหม่
ENVFILE=/etc/goldsignal-web.env
if [ -f "$ENVFILE" ]; then
  token=$(grep -oP '(?<=GS_TOKEN=).*' "$ENVFILE" || true)
  echo "ใช้ token เดิมจาก $ENVFILE: ${token:0:4}***"
fi
if [ -z "$token" ]; then
  token=$(head -c 32 /dev/urandom | sha256sum | cut -c1-32)
  echo "สร้าง token ใหม่: $token"
fi
cat > "$ENVFILE" <<EOF
GS_TOKEN=$token
GS_PORT=7779
EOF
chmod 640 "$ENVFILE"

# 4) systemd service (เปิดเองหลัง reboot)
cat > /etc/systemd/system/goldsignal-web.service <<EOF
[Unit]
Description=GoldSignal Remote Dashboard (read-only)
After=network.target

[Service]
EnvironmentFile=$ENVFILE
ExecStart=/usr/bin/env node $APP_DIR/server-dashboard.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable goldsignal-web >/dev/null 2>&1
systemctl restart goldsignal-web

# 5) เปิดพอร์ตไฟร์วอลล์ (ถ้ามี ufw)
command -v ufw >/dev/null 2>&1 && ufw allow 7779/tcp >/dev/null 2>&1 || true

sleep 1
systemctl is-active goldsignal-web && echo "✓ รันอยู่"
IP=$(curl -s http://ifconfig.me || hostname -I | awk '{print $1}')
echo
echo "============================================================"
echo "เปิดดูจากมือถือ/คอมไหนก็ได้:"
echo "  http://$IP:7779/?key=$token"
echo "ฝั่งแอป GoldSignal (Mac) ใส่ที่แท็บ ตั้งค่า:"
echo "  เว็บระยะไกล (push): http://$IP:7779/push"
echo "  รหัสเชื่อม: $token"
echo "============================================================"
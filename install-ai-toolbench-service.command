#!/bin/zsh
set -u

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.bajia.ai-toolbench"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
USER_ID="$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents" "$APP_DIR/logs"
chmod +x "$APP_DIR/run-ai-toolbench-daemon.sh"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$APP_DIR/run-ai-toolbench-daemon.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$APP_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$APP_DIR/logs/ai-toolbench-service.log</string>
  <key>StandardErrorPath</key>
  <string>$APP_DIR/logs/ai-toolbench-service.err.log</string>
</dict>
</plist>
PLIST

/bin/launchctl bootout "gui/$USER_ID" "$PLIST" >/dev/null 2>&1 || true
/bin/launchctl bootstrap "gui/$USER_ID" "$PLIST"
/bin/launchctl kickstart -k "gui/$USER_ID/$LABEL"

echo ""
echo "AI工具台常驻服务已安装并启动。"
echo "本机打开: http://127.0.0.1:4173/"
echo "同事打开: http://192.168.192.34:4173/"
echo ""
echo "以后登录这台 Mac 后，它会自动后台运行。"
echo "可以关闭这个窗口。"
echo ""
read -k 1 "?按任意键关闭..."

#!/bin/zsh
set -u

LABEL="com.bajia.ai-toolbench"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
USER_ID="$(id -u)"

/bin/launchctl bootout "gui/$USER_ID" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"

echo ""
echo "AI工具台常驻服务已移除。"
echo ""
read -k 1 "?按任意键关闭..."

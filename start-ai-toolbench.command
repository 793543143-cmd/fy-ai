#!/bin/zsh
cd "$(dirname "$0")" || exit 1

echo "AI工具台正在启动..."
echo "本机打开: http://127.0.0.1:4173/"
echo "同事打开: http://192.168.192.34:4173/"
echo ""
echo "这个窗口不要关闭；如果服务意外停止，会自动重新启动。"
echo ""

while true; do
  npm start
  echo ""
  echo "AI工具台服务刚刚停止，3 秒后自动重启..."
  sleep 3
done

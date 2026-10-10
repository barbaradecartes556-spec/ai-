#!/bin/bash
#
# 双击这个文件 = 启动网站
#
# 它会做三件事：
#   1. 启动本地服务器（带 /api/dify 代理，聊天功能靠它）
#   2. 自动用浏览器打开 http://localhost:8899
#   3. 保持运行；关掉这个终端窗口就停止
#
# 为什么不能直接双击 index.html？
#   那样打开的话地址栏是 file:// 开头，浏览器里没有 /api/dify 这个接口，
#   聊天窗会提示「请改用本地服务器」—— 也就是现在这个脚本帮你做的事。

cd "$(dirname "$0")" || exit 1

PORT=8899
URL="http://localhost:$PORT"

echo ""
echo "  ┌────────────────────────────────────────────┐"
echo "  │  小王.EXE · 个人网站                       │"
echo "  └────────────────────────────────────────────┘"
echo ""

# 环境检查
if ! command -v python3 >/dev/null 2>&1; then
  echo "  ✗ 没找到 python3，无法启动。"
  echo "    macOS 可以执行：xcode-select --install"
  echo ""
  read -n 1 -s -r -p "  按任意键关闭…"
  exit 1
fi

# 已经在运行？直接开浏览器就好
if curl -s -o /dev/null --max-time 1 "$URL/index.html"; then
  echo "  服务器已在运行 → $URL"
  open "$URL"
  echo ""
  echo "  这个窗口可以关掉了（不会影响已在运行的服务器）。"
  exit 0
fi

# 启动服务器
echo "  正在启动服务器…"
python3 server.py &
SERVER_PID=$!

# 等它就绪（最多 6 秒）
READY=0
for _ in $(seq 1 30); do
  sleep 0.2
  if curl -s -o /dev/null --max-time 1 "$URL/index.html"; then
    READY=1
    break
  fi
done

if [ "$READY" = "1" ]; then
  open "$URL"
  echo ""
  echo "  ✓ 已就绪 → $URL"
  echo "    浏览器应该自动打开了；没打开就手动访问上面的地址。"
else
  echo ""
  echo "  ✗ 服务器启动超时，请检查上面的报错信息。"
fi

echo ""
echo "  ────────────────────────────────────────────"
echo "  保持这个窗口开着，网站才能访问。"
echo "  用完关闭窗口，或在这里按 Control + C 停止。"
echo "  ────────────────────────────────────────────"
echo ""

# 等服务器结束（关窗口 / Ctrl+C）
wait $SERVER_PID

#!/usr/bin/env bash
# 生产启动：构建前端（缺失时）+ 单端口 8765 同时提供页面 / REST / WebSocket
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8765}"

if [ ! -d web/node_modules ]; then
  echo "==> 安装前端依赖"
  npm --prefix web install
fi

if [ ! -f web/dist/index.html ]; then
  echo "==> 构建前端"
  npm --prefix web run build
fi

if [ ! -x server/.venv/bin/uvicorn ]; then
  echo "==> 创建 Python 虚拟环境并安装依赖"
  python3 -m venv server/.venv
  server/.venv/bin/python -m pip install -q --upgrade pip
  server/.venv/bin/pip install -q -r server/requirements.txt
fi

export WEB_DIST="${WEB_DIST:-$ROOT/web/dist}"

echo "==> 启动五子棋服务：http://${HOST}:${PORT}"
cd server
exec .venv/bin/uvicorn app.main:app --host "$HOST" --port "$PORT" --workers 1

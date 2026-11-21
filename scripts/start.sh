#!/usr/bin/env bash
# 生产启动：只启动后端 API/WS（前端静态资源由 Nginx/CDN 托管）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# 环境变量：先加载仓库根 .env，再加载 server/.env（后者优先，便于只配后端）
for env_file in .env server/.env; do
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1091
    . "$env_file"
    set +a
  fi
done

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8765}"

# 仓库可能被整体移动：shebang/sys.prefix 与当前路径不符或不可执行时自动重建
if ! [ -x server/.venv/bin/uvicorn ] || \
   ! server/.venv/bin/python -c "import sys; raise SystemExit(0 if sys.prefix == '$ROOT/server/.venv' else 1)" >/dev/null 2>&1; then
  echo "==> 创建 Python 虚拟环境并安装依赖"
  rm -rf server/.venv
  python3 -m venv server/.venv
  server/.venv/bin/python -m pip install -q --upgrade pip
  server/.venv/bin/pip install -q -r server/requirements.txt
fi

echo "==> 启动五子棋后端（API/WS）：http://${HOST}:${PORT}"
cd server
exec .venv/bin/uvicorn app.main:app --host "$HOST" --port "$PORT" --workers 1

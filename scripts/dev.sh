#!/usr/bin/env bash
# 开发模式：后端 8765（--reload）+ 前端 Vite 5173（HMR，代理 /api 与 /ws）
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

# 仓库可能被整体移动：shebang/sys.prefix 与当前路径不符或不可执行时自动重建
if ! [ -x server/.venv/bin/uvicorn ] || \
   ! server/.venv/bin/python -c "import sys; raise SystemExit(0 if sys.prefix == '$ROOT/server/.venv' else 1)" >/dev/null 2>&1; then
  echo "==> 创建 Python 虚拟环境并安装依赖"
  rm -rf server/.venv
  python3 -m venv server/.venv
  server/.venv/bin/python -m pip install -q --upgrade pip
  server/.venv/bin/pip install -q -r server/requirements.txt
fi

if [ ! -d web/node_modules ]; then
  echo "==> 安装前端依赖"
  npm --prefix web install
fi

PORT="${PORT:-8765}"
echo "==> 后端 http://127.0.0.1:${PORT}"
(
  cd server
  exec .venv/bin/uvicorn app.main:app --host "${HOST:-127.0.0.1}" --port "$PORT" --reload
) &
BACK_PID=$!

cleanup() {
  kill "$BACK_PID" 2>/dev/null || true
  wait "$BACK_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> 前端 http://localhost:5173"
npm --prefix web run dev

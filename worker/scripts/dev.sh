#!/usr/bin/env bash
# 本地启动 Python Worker（workerd 模拟器）。
# 依赖：Node.js >= 22、uv、wrangler（npm install，见 worker/package.json）。
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v uv >/dev/null 2>&1; then
  echo "缺少 uv，请先安装：https://docs.astral.sh/uv/" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "提示：当前目录没有 node_modules；pywrangler 需要本地 wrangler。" >&2
  echo "     可执行：npm install（或 ln -s ../web/node_modules node_modules）" >&2
fi

exec uv run pywrangler dev --ip 127.0.0.1 --port "${PORT:-8787}" "$@"

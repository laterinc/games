#!/usr/bin/env python3
"""五子棋后端启动入口。

- **监听地址是进程参数**（不放进 .env）：`--host` / `--port`，与 uvicorn CLI 一致；
- **应用配置读 .env**：BOARD_SIZE、CORS_ORIGINS、ALLOWED_ORIGINS 等；
  读取顺序为仓库根 `.env` → `server/.env`（后者优先），已存在的真实环境变量优先；
- `uvicorn app.main:app` 的 `--env-file .env` 只注入应用变量，不会设置监听端口，
  所以需要按端口启动时用本脚本或显式 `--host/--port`。

用法：
    cd server
    .venv/bin/python run.py                                  # 0.0.0.0:8765
    .venv/bin/python run.py --host 127.0.0.1 --port 8000
    .venv/bin/python run.py --reload                         # 开发热重载
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parent
REPO_ROOT = SERVER_DIR.parent


def read_env_file(path: Path) -> dict[str, str]:
    """解析最简单的 KEY=VALUE 行（忽略注释/空行，去掉成对引号）。"""
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not key:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def load_env_files() -> None:
    merged: dict[str, str] = {}
    merged.update(read_env_file(REPO_ROOT / ".env"))
    merged.update(read_env_file(SERVER_DIR / ".env"))  # server/.env 优先
    for key, value in merged.items():
        os.environ.setdefault(key, value)  # 真实环境变量优先


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="五子棋后端（REST + WebSocket）")
    parser.add_argument("--host", default="0.0.0.0", help="监听地址（默认 0.0.0.0）")
    parser.add_argument("--port", type=int, default=8765, help="监听端口（默认 8765）")
    parser.add_argument("--reload", action="store_true", help="开发热重载")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    load_env_files()

    import uvicorn

    uvicorn.run("app.main:app", host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    main()

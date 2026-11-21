#!/usr/bin/env python3
"""五子棋后端启动入口（读取 .env 并使用其中的 HOST/PORT）。

为什么需要它：`uvicorn app.main:app` 的 `--host/--port` 是 **uvicorn CLI 参数**，
默认 127.0.0.1:8000；`--env-file .env` 只是把变量注入应用进程，uvicorn 自己
不会用 `PORT=...` 作为监听端口。这个入口让 `.env` 里的 HOST/PORT 真正生效。

读取顺序：仓库根 `.env` → `server/.env`（后者优先），已存在的真实环境变量优先。
用法：
    cd server
    .venv/bin/python run.py            # 读取 .env，按 HOST/PORT 监听
    .venv/bin/python run.py --reload   # 开发热重载
"""

from __future__ import annotations

import os
import sys
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


def main() -> None:
    load_env_files()

    import uvicorn

    from app.config import Settings

    settings = Settings.from_env()
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload="--reload" in sys.argv[1:],
    )


if __name__ == "__main__":
    main()

"""D1 持久化：玩家昵称与最近战绩。

设计取舍：
- D1 只在连接时读取、对局结束时写入，避免高频 tick 触碰数据库。
- D1 不可用时降级为纯内存（记录日志，不影响对局）。
- 表结构也会在 DO 首次访问时 ``CREATE TABLE IF NOT EXISTS``，方便本地
  ``pywrangler dev`` 直接跑；生产环境仍建议用 ``wrangler d1 migrations apply``。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)

MAX_RECORDS = 10

SCHEMA_STATEMENTS = (
    """
    CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        player_id TEXT NOT NULL,
        result TEXT NOT NULL,
        opponent TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT 'pvp',
        game_type TEXT NOT NULL,
        ended_reason TEXT NOT NULL DEFAULT '',
        moves INTEGER NOT NULL DEFAULT 0,
        my_color TEXT NOT NULL DEFAULT '',
        at INTEGER NOT NULL
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_records_player_at
        ON records (player_id, at DESC, id DESC)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_records_at
        ON records (at DESC)
    """,
)

def _camel_record(row: Any) -> dict[str, Any]:
    """把 D1 行转成前端使用的 MatchRecord 形状。"""

    def get(key: str, default: Any = "") -> Any:
        try:
            value = row[key]
        except (KeyError, TypeError):
            return default
        return default if value is None else value

    return {
        "result": str(get("result", "draw")),
        "opponent": str(get("opponent", "")),
        "mode": str(get("mode", "pvp")),
        "gameType": str(get("game_type", "gomoku")),
        "endedReason": str(get("ended_reason", "")),
        "moves": int(get("moves", 0) or 0),
        "myColor": str(get("my_color", "")),
        "at": int(get("at", 0) or 0),
    }


class D1Store:
    """RoomManager 需要的异步持久化接口。"""

    def __init__(self, env: Any) -> None:
        self._db = getattr(env, "DB", None)
        self._schema_ready = False
        self._schema_lock = asyncio.Lock()
        self._write_lock = asyncio.Lock()

    @property
    def available(self) -> bool:
        return self._db is not None

    async def ensure_schema(self) -> None:
        if self._db is None or self._schema_ready:
            return
        async with self._schema_lock:
            if self._schema_ready:
                return
            # D1 的 exec() 对多行/多语句支持不可靠，逐条 prepare().run() 更稳。
            for statement in SCHEMA_STATEMENTS:
                await self._db.prepare(statement).run()
            self._schema_ready = True

    async def load_player(self, player_id: str) -> dict[str, Any] | None:
        if self._db is None:
            return None
        await self.ensure_schema()
        row = (
            await self._db.prepare(
                "SELECT id, name, created_at, last_seen FROM players WHERE id = ?"
            )
            .bind(player_id)
            .first()
        )
        if row is None:
            return None
        try:
            return {
                "id": str(row["id"]),
                "name": str(row["name"] or ""),
                "createdAt": int(row["created_at"] or 0),
                "lastSeen": int(row["last_seen"] or 0),
            }
        except (KeyError, TypeError, ValueError):
            return None

    async def load_records(self, player_id: str) -> list[dict[str, Any]]:
        if self._db is None:
            return []
        await self.ensure_schema()
        result = (
            await self._db.prepare(
                "SELECT result, opponent, mode, game_type, ended_reason, moves, my_color, at "
                "FROM records WHERE player_id = ? "
                "ORDER BY at DESC, id DESC LIMIT ?"
            )
            .bind(player_id, MAX_RECORDS)
            .all()
        )
        rows = getattr(result, "results", None) or []
        return [_camel_record(row) for row in rows]

    async def upsert_player(self, player_id: str, name: str, at: int) -> None:
        if self._db is None:
            return
        await self.ensure_schema()
        async with self._write_lock:
            await self._db.prepare(
                "INSERT INTO players (id, name, created_at, last_seen) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET "
                "name = CASE WHEN excluded.name != '' THEN excluded.name ELSE players.name END, "
                "last_seen = excluded.last_seen"
            ).bind(player_id, name or "", at, at).run()

    async def append_record(self, player_id: str, record: dict[str, Any]) -> None:
        if self._db is None:
            return
        await self.ensure_schema()
        async with self._write_lock:
            await self._db.prepare(
                "INSERT INTO records "
                "(player_id, result, opponent, mode, game_type, ended_reason, moves, my_color, at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
            ).bind(
                player_id,
                str(record.get("result", "draw")),
                str(record.get("opponent", "")),
                str(record.get("mode", "pvp")),
                str(record.get("gameType", "gomoku")),
                str(record.get("endedReason", "")),
                int(record.get("moves", 0) or 0),
                str(record.get("myColor", "")),
                int(record.get("at", 0) or 0),
            ).run()
            # 只保留最近 MAX_RECORDS 条，避免无界增长（仍是单条玩家级写入）。
            await self._db.prepare(
                "DELETE FROM records WHERE player_id = ? AND id NOT IN ("
                "SELECT id FROM records WHERE player_id = ? "
                "ORDER BY at DESC, id DESC LIMIT ?)"
            ).bind(player_id, player_id, MAX_RECORDS).run()

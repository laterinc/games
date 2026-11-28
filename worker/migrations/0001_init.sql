-- D1：玩家昵称与最近战绩。
-- 可由 `wrangler d1 migrations apply games --remote` 应用；运行时也会幂等建表。

CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
);

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
);

CREATE INDEX IF NOT EXISTS idx_records_player_at
    ON records (player_id, at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_records_at
    ON records (at DESC);

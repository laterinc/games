# Games 后端 · Cloudflare Python Workers + D1

把原来的 FastAPI（`server/`）后端搬到 **Cloudflare Python Workers**，协议保持 v2/v3 不变，前端无需改协议；D1 负责持久化玩家昵称与最近 10 局战绩。

## 架构

```text
浏览器 ── HTTPS / WSS ──> Worker (Python, src/entry.py)
                              │
                              ▼
                    GameHub Durable Object（单实例）
                    ├─ RoomManager（复用 server/app 的纯 Python 规则）
                    ├─ WebSocket 连接池 + 输入驱动的 tank tick（Workers 默认 10Hz）
                    ├─ AI 落子 / 断线宽限 / 房间回收（asyncio 任务）
                    └─ D1Store ──> D1: players / records
```

为什么是**一个全局 DO**：

- 现有前端协议是「一条 WebSocket 上复用所有房间」。改成每房间一个 DO，需要客户端「先加入房间再换连接」，会动 `useGameSocket` / 房间路由与重连逻辑。
- 朋友局规模（几十人、个位数房间）下，单 DO 足够；它天然串行化所有房间状态，省掉跨实例同步。
- WebSocket 使用 `server.accept()`（**非休眠模式**）。只要还有连接，DO 就常驻，坦克大战 tick、AI 延迟落子、断线 60s 宽限才能继续跑。
- 代价：所有大厅流量共用一个 DO；DO 被重新部署/驱逐时，**内存中的房间会丢**（与原来 FastAPI 进程重启一致）。D1 里的战绩不会丢。

## 目录

```text
worker/
├── src/
│   ├── entry.py      # Worker 入口：所有请求转给 GameHub DO
│   ├── hub.py        # GameHub DO、WebSocket 事件、REST、CORS、定时任务
│   ├── ws.py         # WorkerConnection：JSON / 二进制发送与限流
│   └── store.py      # D1：players / records
├── migrations/       # D1 schema
├── scripts/
│   ├── dev.sh        # 本地启动
│   └── smoke.mjs     # 端到端冒烟（棋类 + 坦克）
├── wrangler.jsonc
├── pyproject.toml    # 依赖本地包 games-core（../server）
└── package.json      # wrangler CLI
```

后端核心逻辑没有复制一份：`worker/pyproject.toml` 通过 `[tool.uv.sources]` 依赖 `../server` 的 `games-core` 包，`app.rooms` / `app.games` / `app.realtime` 原样复用；FastAPI 只在 Docker 形态下使用。

## 本地开发

前置：Node.js ≥ 22、[uv](https://docs.astral.sh/uv/)、Python 3.12+。

```bash
# 1. 安装 worker 的 Python / Node 依赖
cd worker
npm install          # 或复用 ../web/node_modules
uv sync

# 2. 启动 workerd（默认 http://127.0.0.1:8787）
./scripts/dev.sh

# 3. 另开终端跑冒烟测试
node scripts/smoke.mjs
```

本地 D1 数据在 `worker/.wrangler/state/v3/d1/`；表结构会在 DO 首次访问时自动创建，也可以手动应用迁移：

```bash
npx wrangler d1 migrations apply games --local
```

> `database_name` 已按 Dashboard 实际库名设为 `games`；远程绑定以 `database_id` 为准。

## 部署

```bash
cd worker
npx wrangler login                 # 或 export CLOUDFLARE_API_TOKEN=...
npx wrangler d1 migrations apply games --remote
uv run pywrangler deploy
```

部署前确认：

1. `wrangler.jsonc` 的 `d1_databases[0].database_id` 与目标库一致（当前：`d3ca2d34-8539-4dfd-a43e-05c57ddb6a81`）。
2. `database_name` 与 Dashboard 库名一致（当前 `games`）。
3. `vars.ALLOWED_ORIGINS` / `vars.CORS_ORIGINS` 已包含 `https://games.later.design`、`https://cloudflare.org.cn` 和本地开发地址；换前端域名时同步修改。
4. `routes` 已配置 `cloudflare.org.cn/games*`，Worker 会自动剥掉 `/games` 前缀；前端继续用 `https://cloudflare.org.cn/games` 时无需改前端。若换域名，改 `routes` 与 `web/.env.production.local` 的 `VITE_API_BASE` / `VITE_WS_URL`。

当前线上地址：`https://cloudflare.org.cn/games`（REST）与 `wss://cloudflare.org.cn/games/ws`（WebSocket）。

健康检查：

```bash
curl https://<worker>/api/health
# {"status":"ok","runtime":"cloudflare-python-workers",...,"d1":true}
```

## 与 FastAPI 版的差异 / 限制

| 项 | FastAPI 版 | Workers 版 |
| --- | --- | --- |
| 房间状态 | 进程内存，重启即丢 | DO 内存，重启/驱逐即丢（有连接时常驻） |
| 战绩 | 进程内存 | D1，跨重启保留 |
| 昵称 | 进程内存 | D1（建房/加入时 upsert） |
| 水平扩展 | 单进程 | 单 DO（当前设计）；后续可按房间拆分 DO |
| 定时任务 | `asyncio` | `asyncio`（非休眠 WS，连接期间可跑） |
| 二进制 WS | 原生 bytes | 发送显式转 `Uint8Array`；接收 `binaryType=arraybuffer` |
| 坦克 tick | 服务端独立 asyncio 20Hz | **客户端输入驱动**，Workers 默认 10Hz（`TANK_TICK_RATE=10`）；前端按服务端下发的 `tickRate` 调整发送间隔 |
| 线程 | 可用 | **不可用**（Pyodide/WASM 限制）；AI 搜索会占用 DO 事件循环 |
| CPU/内存 | 自定义 | Workers 限制（Python Workers 128 MB 内存、单次请求 CPU 上限） |
| D1 写入 | 无 | 每局结束 1 次 insert + 1 次 trim，低频 |

### 坦克 tick 为什么改成输入驱动

Cloudflare Python Worker 的 WebSocket 消息处理有固定开销（实测每条约 2–10ms，且后台 asyncio/JS 定时器要么缺少二进制 `ws.send` 的 I/O 上下文，要么被限流）。因此 Workers 版不跑独立 tick 循环，而是：

1. 前端按服务端 `tickRate`（Workers 默认 10Hz）发送二进制输入帧；
2. 服务端每收到一帧就调用 `TankSession.pump()`，按墙钟补齐最多 4 个 100ms 步长，然后广播快照；
3. 发送发生在 WebSocket 消息事件上下文内，避免后台任务发二进制帧阻塞。

代价是输入/快照频率约 10Hz（FastAPI 版仍为 20Hz），朋友局可玩；如果要求 20Hz，建议把坦克大战单独留在长连接服务器，或用 Cloudflare Container。

如果以后要水平扩展，推荐演进为「Lobby DO + 每房间 Room DO」：房间内 WS 直连 Room DO，大厅只保留房间目录；代价是前端加入房间时需要重新建立 WebSocket。

## 故障排查

- `ModuleNotFoundError: No module named 'app.dispatch'`：改了 `server/app` 后要重建 worker bundle（删除 `worker/.venv-workers`、`python_modules`、`pylock.toml` 后重启）。
- `A DurableObjectNamespace ... no such Durable Object class is exported`：`GameHub` 必须从 `src/entry.py` 可导入。
- 二进制帧被当成文本（`b'\x02...'`）：`ws.send()` 必须传 `to_js(bytes)`，不能直接传 Python `bytes`。
- 二进制输入收不到：Workers 的 `event.data` 是 `Blob`，需要 `await data.arrayBuffer()`。
- D1 `incomplete input`：不要用 `db.exec()` 跑多行建表语句，逐条 `prepare().run()`。

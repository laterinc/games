# Games 协议 v2

面向 **多游戏联机大厅** 的 WebSocket 协议。房间生命周期与游戏无关；棋盘、走法、终局状态由 `gameType` 区分。

- 传输：WebSocket（`/ws`，生产通常在 `/games/ws`）
- 编码：JSON 文本帧，UTF-8（实时游戏预留二进制帧，见 §9 / [docs/REALTIME.md](docs/REALTIME.md)）
- 版本：`protocolVersion = 2`（v1 只支持五子棋，且无 `gameType` 字段）
- 服务端权威：所有走法、悔棋、胜负由服务端规则引擎裁决

## 1. 身份

身份是一个 **UUID v4**，保存在前端 localStorage（`games.uid.v1`，永不过期）：

- 首次连接（未带 UUID）：服务端生成新 UUID，通过 `welcome` 的 `playerId` 下发，`reconnected=false`。
- 之后连接：前端把 UUID 拼到 WebSocket 地址上，例如 `wss://host/games/ws?uid=<uuid>`。服务端直接采用该 UUID，不再生成新身份。
- 服务端已认识该 UUID 时，`welcome.reconnected=true`，并在 `welcome` / `records` 后补发当前房间快照。
- 刷新页面 / 重开浏览器 / 多标签页：只要 localStorage 中的 UUID 相同，就恢复同一身份与房间座位，不互踢。
- 前端提供了格式非法的 UUID 时，服务端忽略它并生成新的合法 UUID。
- 服务端在 `welcome` 后立即推送一条 `records`（最近战绩）。

> UUID 就是可迁移的身份凭证：持有同一 UUID 即代表同一玩家。清除 localStorage 等于换一个新身份。

## 2. 消息总览

客户端 → 服务端：

| type | 说明 |
| --- | --- |
| `create_room` | 创建房间（可指定 gameType / 人机） |
| `join_room` | 用房间码加入（幂等） |
| `quick_match` | 快速匹配（按 gameType） |
| `watch_room` | 观战 |
| `list_rooms` | 拉取公开房间（可按 gameType 过滤） |
| `ready` | 准备 / 取消准备（pvp） |
| `move` | 走子（形状由 gameType 决定） |
| `resign` | 认输 |
| `undo_request` | 发起悔棋 |
| `undo_response` | 同意/拒绝悔棋 |
| `rematch` | 再来一局 |
| `leave_room` | 离开房间 / 退出观战 |
| `chat` | 聊天 |
| `ping` | 心跳，返回 `pong` |

服务端 → 客户端：

| type | 说明 |
| --- | --- |
| `welcome` | 身份 UUID、协议版本 |
| `room` | 房间快照（`room=null` 表示已离开/房间解散） |
| `rooms` | 公开房间列表 |
| `chat` | 聊天消息 |
| `records` | 最近战绩 |
| `notice` | 提示（`level` + `text`） |
| `error` | 错误（`code` + `message`） |
| `pong` | 心跳响应 |

## 3. 游戏与颜色

| gameType | 名称 | 先手 | 颜色 | 走法输入 |
| --- | --- | --- | --- | --- |
| `gomoku` | 五子棋 | 黑棋 | `black` / `white` | `{row,col}` |
| `chess` | 中国象棋 | 红棋 | `red` / `black` | `{from:{row,col},to:{row,col}}` |

`create_room.color` 可传对应游戏颜色或 `"random"`；不传默认：五子棋 `black`，象棋 `red`。
中文象棋红方在下方，黑方在上方。

## 4. 大厅与房间

### 4.1 create_room

```json
{
  "type": "create_room",
  "name": "小明",
  "gameType": "chess",
  "roomName": "可空",
  "visibility": "public",
  "color": "red",
  "boardSize": 15,
  "matchSeconds": 180,
  "mode": "pvp"
}
```

- `gameType` 缺省 `"gomoku"`。
- `boardSize`：仅五子棋支持，可选 `9/11/13/15/17/19` 路，缺省 `15`；象棋固定 9×10，传了会报 `INVALID_MESSAGE`。
- `matchSeconds`：仅坦克大战支持，房主设定对局时长；整数秒，范围 60–900、且为 30 的整数倍，缺省 `180`。非坦克游戏传了会报 `INVALID_MESSAGE`。
- `mode`：`"pvp"`（默认）或 `"ai"`（电脑对手，直接开局）。
- 成功：所有连接收到 `room`；大厅在线者收到 `rooms`。
- 错误：`INVALID_MESSAGE`（未知游戏/颜色不适用）、`ALREADY_IN_ROOM` 等。

### 4.2 join_room / quick_match / watch_room

```json
{"type":"join_room","roomId":"ABC123","name":"小红"}
{"type":"quick_match","name":"小红","gameType":"chess"}
{"type":"watch_room","roomId":"ABC123","name":"观战者"}
```

- `join_room` 对已在同一房间的玩家**幂等**：重新下发 `room` 快照（刷新后误点加入不会报错）。
- `quick_match` 只匹配同 `gameType` 的公开 waiting 房间；没有则新建 15 路公开房。自定义棋盘大小请用 `create_room`。
- 公开房间列表的 `boardSize` 字段表示五子棋房间路数，加入后以房间实际棋盘为准。
- `watch_room` 不占座位，最多 20 名观战者；观战者可聊天，收到完整 `room` 快照。

### 4.3 room 快照

```json
{
  "id": "ABC123",
  "name": "小明的棋局",
  "visibility": "public",
  "gameType": "chess",
  "status": "playing",
  "hostId": "p_xxx",
  "createdAt": 1730000000000,
  "updatedAt": 1730000000000,
  "players": [
    {"id":"p_a","name":"小明","color":"red","connected":true,"ready":true,"isHost":true,"isBot":false},
    {"id":"p_b","name":"小红","color":"black","connected":true,"ready":true,"isHost":false,"isBot":false}
  ],
  "spectators": 1,
  "mode": "pvp",
  "pendingUndo": null,
  "rematchVotes": [],
  "game": { "...": "按 gameType 决定，见下" },
  "chat": []
}
```

`status`：`waiting` | `playing` | `finished`。

### 4.4 rooms 列表（REST 同构）

```json
{
  "rooms": [
    {
      "id": "ABC123",
      "name": "小明的棋局",
      "gameType": "gomoku",
      "boardSize": 15,
      "status": "waiting",
      "playerCount": 1,
      "maxPlayers": 2,
      "hostName": "小明",
      "createdAt": 1730000000000
    }
  ]
}
```

- 仅包含公开、waiting、pvp 房间；五子棋房间的 `boardSize` 为实际棋盘路数。
- `GET /api/rooms?game=chess` 可按游戏过滤；不传返回全部。

### 4.5 ready / rematch / undo

- `ready`：仅 pvp waiting 房间；切换准备状态；双方都准备后服务端自动开局，`game.startedAt` 被写入。
- `rematch`：仅 finished；pvp 双方都投票后重开并交换颜色；AI 房间由人类玩家直接重开。
- `undo_request`：playing 且至少有一手时可用；AI 房间自动同意并回退（电脑应手 + 玩家上一手）；pvp 房间经对方 `undo_response`。
- `undo_response`：`{"type":"undo_response","accept":true|false}`，只允许非发起方回应。
- 认输：`{"type":"resign"}`，胜方为对手，`game.endedReason="resign"`。
- 断线宽限（默认 60s）超时、或玩家主动离开正在进行的对局：判对手胜，`endedReason="forfeit"`，随后房间重置回 waiting。

## 5. 对局状态

### 5.1 五子棋 game

```json
{
  "boardSize": 15,
  "board": [[0,0,1,...], ...],
  "currentTurn": "black",
  "lastMove": {"row": 7, "col": 7},
  "moves": [{"row":7,"col":7,"color":"black","at":1730000000000}],
  "winner": null,
  "winLine": null,
  "endedReason": null,
  "startedAt": 1730000000000,
  "endedAt": null
}
```

- `board`：`0` 空 / `1` 黑 / `2` 白，`[row][col]`，row 0 在上。
- `winLine`：获胜时 5 个连续坐标。
- `endedReason`：`five`（五连）| `draw`（棋盘下满）| `resign` | `forfeit`。
- 走子消息：

```json
{"type":"move","row":7,"col":7}
```

### 5.2 中国象棋 game

```json
{
  "rows": 10,
  "cols": 9,
  "board": [["r","n","b","a","k","a","b","n","r"], ...],
  "currentTurn": "red",
  "lastMove": {"from":{"row":7,"col":1},"to":{"row":7,"col":4}},
  "moves": [
    {
      "from":{"row":7,"col":1},
      "to":{"row":7,"col":4},
      "piece":"C",
      "captured":null,
      "color":"red",
      "notation":"B3E3",
      "at":1730000000000
    }
  ],
  "winner": null,
  "winLine": null,
  "endedReason": null,
  "startedAt": 1730000000000,
  "endedAt": null,
  "check": false,
  "legalMoves": [{"from":{"row":6,"col":0},"to":{"row":5,"col":0}}],
  "captured": {"red": [], "black": []}
}
```

棋子编码：

| 红方 | 黑方 | 棋子 |
| --- | --- | --- |
| `K` | `k` | 帅 / 将 |
| `A` | `a` | 仕 / 士 |
| `B` | `b` | 相 / 象 |
| `N` | `n` | 马 |
| `R` | `r` | 车 |
| `C` | `c` | 炮 |
| `P` | `p` | 兵 / 卒 |

- `board[r][c]` 为 `null` 或棋子编码；红方底线在 row 9，黑方底线在 row 0。
- `legalMoves`：**当前行棋方**全部合法走法，前端用来高亮；服务端仍会再次校验。
- `check`：当前行棋方是否被将军。
- `captured.red` / `captured.black`：双方已吃掉的棋子编码。
- `notation`：`起点列起点行终点列终点行`，列 A–I，行按红方视角 1–10（红底线为第 1 行）。
- `endedReason`：`checkmate`（将死）| `stalemate`（困毙，判走子方胜）| `resign` | `forfeit` | `draw`（240 半回合自然限着）。
- 走子消息：

```json
{"type":"move","from":{"row":7,"col":1},"to":{"row":7,"col":4}}
```

## 6. 聊天 / 战绩 / 错误

### chat

```json
{"type":"chat","text":"好棋！"}
```

服务端广播给房间内玩家与观战者：

```json
{"type":"chat","message":{"id":"m_1","playerId":"p_a","name":"小明","text":"好棋！","at":1730000000000}}
```

快照中的 `chat` 保留最近 50 条；单条最长 200 字符。

### records

```json
{
  "type": "records",
  "records": [
    {
      "result": "win",
      "opponent": "电脑",
      "mode": "ai",
      "gameType": "chess",
      "endedReason": "checkmate",
      "moves": 34,
      "myColor": "red",
      "at": 1730000000000
    }
  ]
}
```

`result`：`win` | `loss` | `draw`；每位玩家保留最近 10 局。

### error

```json
{"type":"error","code":"NOT_YOUR_TURN","message":"还没轮到你走子"}
```

错误码：`INVALID_MESSAGE`、`UNKNOWN_TYPE`、`INVALID_NAME`、`INVALID_ROOM_NAME`、`ALREADY_IN_ROOM`、`NOT_IN_ROOM`、`ROOM_NOT_FOUND`、`ROOM_FULL`、`ROOM_STARTED`、`NOT_YOUR_TURN`、`INVALID_MOVE`、`GAME_NOT_ACTIVE`、`RATE_LIMITED`。

## 7. 新增游戏

1. 在 `server/app/games/` 实现 `GameRules`：`key`、`name`、`colors`、`create_colors`、`new_game`、`apply_move`、`ai_move`、`undo`、`legal_moves`（可选 `finish` / `ai_delay_seconds`）。
2. 在 `server/app/games/__init__.py::build_registry` 注册。
3. `state` 必须是可直接 JSON 序列化的字典，并包含公共字段：`currentTurn`、`moves`、`lastMove`、`winner`、`endedReason`、`startedAt`、`endedAt`。
4. 前端在 `types.ts` 增加游戏状态类型，在 `web/src/games/<slug>/` 提供 `meta.ts` 与棋盘组件，并登记到 `web/src/games/registry.ts`；路由、首页卡片、大厅切换会自动生效。
5. 房间生命周期、悔棋、认输、观战、聊天、战绩、断线重连无需改动。

## 8. 兼容性

- v1 客户端不带 `gameType`，服务端按 `gomoku` 处理并返回 `gameType:"gomoku"`；但 v1 客户端不认识 `gameType`/象棋字段。
- v2 服务端的 `protocolVersion=2`，房间快照新增 `gameType`，战绩新增 `gameType`。
- 五子棋 `game` 字段与 v1 兼容。

## 9. 实时游戏与二进制帧（v3 草案，未实现）

v2 的事件驱动 + JSON 模型适合回合制，不适合坦克大战这类 10–20Hz 状态同步。v3 的方向是**混合通道**：

- 身份、房间、大厅、聊天、回合制走子：继续 JSON 文本帧。
- 实时游戏输入与快照：二进制帧，与文本帧共用同一条 WebSocket。
- 服务端按固定 tick 推进实时房间，客户端发送输入意图，快照支持关键帧 + 增量 + 兴趣裁剪。

二进制帧的字段布局、带宽测算、tick 模型、断线/背压处理和迁移步骤，统一维护在：

**[docs/REALTIME.md](docs/REALTIME.md)**

编解码骨架已经落地（尚未接入 WS/房间 tick）：

- 后端：`server/app/realtime/codec.py`，测试 `server/tests/test_realtime_codec.py`
- 前端：`web/src/lib/realtime/codec.ts`，测试 `web/src/lib/realtime/codec.test.ts`
- 共享黄金样例：`shared/realtime-v3.fixtures.json`

在 v3 接入 WS 前，`protocolVersion` 保持 `2`，现有客户端/服务端不受影响。

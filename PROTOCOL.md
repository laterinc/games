# 五子棋联机协议 v1（WebSocket）

本文件是**前后端唯一契约**。后端 `server/` 与前端 `web/` 都必须严格按此实现，
字段名、枚举值、消息类型不得私自改动。修订协议时必须同时改两端与本文件。

## 1. 连接

- 地址：同源 `/ws`（生产环境由后端同端口提供；开发环境 Vite 代理到后端）。
- 子协议：无。文本帧，UTF-8 JSON 对象。
- 心跳：客户端每 20s 发送 `{"type":"ping"}`，服务端回 `{"type":"pong","t":<serverMs>}`；
  服务端另有 30s 无消息则断开（客户端 ping 足够）。
- 重连：客户端首次连接收到 `welcome` 后把 `playerId` + `token` 存入 localStorage；
  断线重连时先发 `hello`（见下）恢复身份与所在房间。
- 限流：单个连接 5 秒内最多 40 条消息，超出回 `RATE_LIMITED` 错误并计入，严重可断开。

## 2. 服务端 → 客户端消息

### 2.1 welcome（连接建立后立即发送，第一条）

```json
{
  "type": "welcome",
  "playerId": "p_9f2c1a7d",
  "token": "t_7d1e...",
  "reconnected": false,
  "serverTime": 1732000000123,
  "protocolVersion": 1
}
```

`token` 仅用于重连身份校验，客户端持久化保存。`reconnected=true` 表示 `hello` 成功恢复。

### 2.2 room（房间状态全量快照，房间内任何变化都会广播）

```json
{
  "type": "room",
  "room": {
    "id": "8F3KQ2",
    "name": "午后棋局",
    "visibility": "public",
    "status": "playing",
    "hostId": "p_9f2c1a7d",
    "createdAt": 1732000000000,
    "updatedAt": 1732000005000,
    "players": [
      {"id": "p_9f2c1a7d", "name": "小明", "color": "black", "connected": true, "ready": true, "isHost": true},
      {"id": "p_4b8e0c11", "name": "小红", "color": "white", "connected": true, "ready": true, "isHost": false}
    ],
    "spectators": 0,
    "rematchVotes": [],
    "game": {
      "boardSize": 15,
      "board": [[0,0,0,"...15 列..."]],
      "currentTurn": "white",
      "lastMove": {"row": 7, "col": 8},
      "moves": [{"row": 7, "col": 7, "color": "black", "at": 1732000004000}],
      "winner": null,
      "winLine": null,
      "endedReason": null,
      "startedAt": 1732000003000,
      "endedAt": null
    }
  }
}
```

离开房间后服务端发 `{"type":"room","room":null}`。

字段约束：

- `status`：`"waiting"`（不满 2 人或未全部准备）/ `"playing"` / `"finished"`。
- `visibility`：`"public"` / `"private"`。private 房间不出现在房间列表与快速匹配中。
- `color`：`"black"` / `"white"`。`black` 先行。
- `board`：15×15（由 `boardSize` 决定），`0` 空、`1` 黑、`2` 白。矩阵下标 `[row][col]`，
  `row` 从上到下、`col` 从左到右，均从 0 开始。
- `winner`：`"black"` / `"white"` / `null`；`winLine`：获胜的连续棋子坐标数组
  `[{"row":r,"col":c}, ...]`（长度 ≥5），无胜负为 `null`。
- `endedReason`：`"five"`（五连）/ `"draw"`（棋盘下满）/ `"forfeit"`（对手离开，仅用于结算）/ `null`。
- `moves`：按落子顺序，用于复盘/手数显示。
- 房间内玩家最多 2 人；`players` 顺序固定为黑方在前。断线玩家的 `connected=false`，
  60 秒内不回来则视为离开。
- `rematchVotes`：已投票"再来一局"的 playerId 数组。双方都投后自动重开并**交换黑白**。

### 2.3 rooms（大厅房间列表）

```json
{
  "type": "rooms",
  "rooms": [
    {
      "id": "8F3KQ2",
      "name": "午后棋局",
      "status": "waiting",
      "playerCount": 1,
      "maxPlayers": 2,
      "hostName": "小明",
      "createdAt": 1732000000000
    }
  ]
}
```

只包含 `visibility=public` 且在 `waiting` 状态（可加入）的房间，按创建时间升序。
大厅内（不在房间）的连接会在房间列表变化时收到推送；也可随时发 `list_rooms` 拉取。

### 2.4 pong

`{"type":"pong","t":1732000000123}`

### 2.5 notice（轻提示，可选展示为 toast）

```json
{"type": "notice", "level": "info", "text": "对手已离开，等待新对手"}
```

`level`：`"info"` / `"success"` / `"warn"`。

### 2.6 error

```json
{"type": "error", "code": "NOT_YOUR_TURN", "message": "还没轮到你落子"}
```

`message` 恒为中文，可直接展示。错误码全集：

| code | 含义 |
| --- | --- |
| `INVALID_MESSAGE` | JSON 解析失败 / 缺少 type / 字段类型错误 / 聊天内容为空或超长 |
| `UNKNOWN_TYPE` | 未知消息类型 |
| `INVALID_NAME` | 昵称不合法（1–16 字符，去首尾空白后非空） |
| `INVALID_ROOM_NAME` | 房间名不合法（0–24 字符，空则自动命名） |
| `ALREADY_IN_ROOM` | 已在房间中 |
| `NOT_IN_ROOM` | 不在房间中 |
| `ROOM_NOT_FOUND` | 房间不存在 |
| `ROOM_FULL` | 房间已满 |
| `ROOM_STARTED` | 对局已开始，无法加入 |
| `NOT_YOUR_TURN` | 未轮到该玩家 |
| `INVALID_MOVE` | 坐标越界或该点已有棋子 |
| `GAME_NOT_ACTIVE` | 当前不在对局中 |
| `RATE_LIMITED` | 消息过于频繁 |
| `AUTH_FAILED` | `hello` 的 token 无效 |

## 3. 客户端 → 服务端消息

所有消息都是 `{"type": "...", ...}`；未知字段忽略。

### 3.1 hello（可选，重连）

```json
{"type": "hello", "playerId": "p_9f2c1a7d", "token": "t_7d1e..."}
```

成功：发 `welcome`（`reconnected=true`）；若该玩家仍在房间中则紧跟 `room` 快照。
失败：发 `AUTH_FAILED` 错误，之后按新玩家处理（不分配新身份直到再次 welcome？——
**失败时服务端保持当前全新身份不变**，客户端应清空本地 session）。

### 3.2 create_room

```json
{"type": "create_room", "name": "小明", "roomName": "午后棋局", "visibility": "public", "color": "black"}
```

- `name` 必填，昵称。
- `roomName` 可省，空则服务端自动生成（如 `小明的棋局`）。
- `visibility` 缺省 `public`；`color` 缺省 `black`，可选 `random`（服务端随机黑/白）。
- 成功：创建者进入房间，服务端广播 `room` 快照（并给大厅推送新 `rooms`）。

### 3.3 join_room

```json
{"type": "join_room", "roomId": "8F3KQ2", "name": "小红"}
```

成功进入并收到 `room` 快照；失败按错误码返回。加入者颜色为创建者颜色的相反色。
若创建者选了 `random`，加入时服务端已按实际颜色分配。

### 3.4 quick_match

```json
{"type": "quick_match", "name": "小红"}
```

优先加入最早的、公开且仅 1 人的 `waiting` 房；没有则新建公开房（创建者执黑）。
结果与 create/join 相同。

### 3.5 list_rooms

`{"type":"list_rooms"}` → 回 `rooms`。

### 3.6 ready（切换准备状态）

`{"type":"ready"}`：`waiting` 状态下切换自己的 `ready`。两人都 `ready` 时立即开局：
重置棋盘，黑方先行，`status=playing`。`playing` / `finished` 状态下发送返回 `GAME_NOT_ACTIVE`。

### 3.7 move

```json
{"type": "move", "row": 7, "col": 8}
```

校验：在房间、`status=playing`、是自己的颜色回合、坐标合法且为空。
成功后广播新 `room` 快照（含 `lastMove`、`board`、`currentTurn`、胜负）。
五连即 `status=finished`、`winner`、`winLine`、`endedReason="five"`；
下满无五连则 `winner=null`、`endedReason="draw"`。

### 3.8 rematch

`{"type":"rematch"}`：`finished` 状态下投票"再来一局"。
同一玩家重复投票幂等。双方都投票后：清空棋盘、`status=playing`、**交换黑白**、
`winner/winLine/endedReason=null`、`rematchVotes=[]`，黑方先行（原白方执黑）。

### 3.9 leave_room

`{"type":"leave_room"}`：离开当前房间。`playing` 时对手收到 `notice`，
对局结束（`endedReason="forfeit"`，对手获胜）随后房间重置为 `waiting`（棋盘清空、
剩余玩家为 host、ready=false），等待新对手。房主离开且房间无人则房间销毁。

### 3.10 chat

```json
{"type": "chat", "text": "好棋！"}
```

`text` 去首尾空白后 1–200 字符；仅房间内可用，否则 `NOT_IN_ROOM`。
聊天记录保留最近 50 条，随 `room.chat` 数组下发（见下），并单独推送 `chat` 消息：

```json
{"type": "chat", "message": {"id": "m_12", "playerId": "p_9f2c1a7d", "name": "小明", "text": "好棋！", "at": 1732000008000}}
```

`room.chat` 字段同样存在（最多 50 条，结构相同）。前端可二选一，
**建议**：渲染用 `room.chat`，收到 `chat` 时追加（按 `id` 去重），收到 `room` 时整体替换。

### 3.11 ping

`{"type":"ping"}` → `pong`。

## 4. 状态机

```
create/join/quick ──► waiting ──(双方 ready)──► playing ──(五连/和棋)──► finished
                        ▲                            │                        │
                        │                            └──── leave ─────────────┘
                        └──────────── 对手离开后重置（棋盘清空）◄────────────────┘
finished ──(双方 rematch)──► playing（交换黑白）
任意状态 ──(leave_room)──► 离开，room=null
```

- 房间只剩 0 人即销毁；`waiting` 房间 6 小时无活动回收；`playing` 房间不因空闲回收。
- 玩家断线不立即离开：标记 `connected=false`，60s 后按 `leave_room` 处理。
  断线期间游戏状态保留；对手可在棋盘上看到"对方掉线"提示。

## 5. REST 接口（生产同源，开发 Vite 代理）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，返回 `{"status":"ok","version":"1.0.0","uptimeSeconds":12.3,"rooms":2,"connections":3,"serverTime":...}` |
| GET | `/api/rooms` | 返回 `{"rooms":[...]}`，结构同 `rooms` 消息 |
| GET | `/api/config` | 返回 `{"protocolVersion":1,"boardSize":15,"maxPlayers":2,"appName":"五子棋"}` |

后端只处理 `/api/*` 与 `/ws`；其他路径一律 404。前端页面/静态资源由 Nginx、CDN 或
Vite 等外部静态服务器托管，后端不提供静态文件服务。

## 6. 实现约束

- 服务端为**唯一裁判**：所有合法性、胜负判定都在服务端完成，前端只做乐观 UI。
- 昵称、房间名、聊天内容做 HTML 转义由前端负责（React 默认转义即可），服务端去除首尾空白、
  长度限制并拒绝仅含空白的内容。
- 服务端不得把 token 放进任何广播消息（仅 `welcome` 单发给本人）。
- 广播顺序：先更新内存状态，再按连接逐条发送；同一连接不得并发写（每个连接一把发送锁）。
- 所有时间戳为毫秒级 Unix 时间。

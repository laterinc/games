# 实时游戏与二进制 WebSocket 传输（v3 草案）

> 状态：**已接入（2026-11）**：坦克大战使用 v3 二进制帧，房间 tick 循环、能力协商、二进制收发均已落地；
> 回合制游戏仍走 v2 JSON。具体契约见 [TANK.md](TANK.md)。

## 1. 结论先行

- **大厅控制面继续用 JSON**：`hello`、`create_room`、`room`、`chat`、`error`、`records` 等消息频率低、字段多变，JSON 可读性和调试成本更重要。
- **回合制游戏（五子棋 / 中国象棋）继续用 JSON**：一局最多几百手，每手几十字节，改成二进制没有实际收益。
- **实时游戏（坦克大战等）只把高频热路径改成二进制**：输入帧 + 快照帧，文本帧与二进制帧在同一条 WebSocket 上共存。
- **不要一次性把所有 WS 消息二进制化**：收益集中在每秒 10–30 次的快照/输入，控制消息只增加开发与排障成本。

判断标准：**每秒消息数 × 消息体积**。回合制的每秒体积可以忽略；实时游戏则是数量级差异。

## 2. 带宽测算

以坦克大战为例：8 名玩家、场上约 20 个实体、服务端 20Hz 快照。

### JSON 快照

单实体约 110 字节：

```json
{"id":12,"x":12345,"y":6789,"vx":30,"vy":0,"a":1.57,"hp":100,"t":1,"f":0}
```

- 单帧：20 × 110 ≈ **2.2 KB**
- 20Hz：**约 44 KB/s / 每个客户端**
- 8 个客户端服务端出口：**约 350 KB/s**，还没算玩家输入与大房间

### 二进制快照

单实体定长 14 字节：

| 字段 | 类型 | 字节 |
| --- | --- | --- |
| id | u16 | 2 |
| x / y | i16 × 2（0.01 单位定点） | 4 |
| vx / vy | i16 × 2（0.01 单位/秒） | 4 |
| angle | u16（0–65535 映射 0–2π） | 2 |
| hp | u8 | 1 |
| team / flags | u8 | 1 |

- 单帧：20 × 14 + 12 字节头 ≈ **292 B**
- 20Hz：**约 5.8 KB/s / 客户端**
- 再叠加“只发变化实体”的增量快照，稳态通常还能再降 50%–80%

收益约 **8–10 倍**；实体越多、tick 越高，差距越大。对五子棋一手棋来说，这点差异没有意义。

## 3. 传输分层

| 流量 | 编码 | 频率 | 通道 |
| --- | --- | --- | --- |
| 身份 / 房间 / 大厅 / 聊天 / 战绩 | JSON 文本帧 | 事件驱动 | WebSocket |
| 回合制走子、悔棋、准备 | JSON 文本帧 | 每手 / 每次操作 | WebSocket |
| 实时游戏输入 | 二进制帧 | 20–30 Hz | WebSocket |
| 实时游戏快照 | 二进制帧 | 10–20 Hz | WebSocket |
| 观战快照 | 二进制帧 | 5–10 Hz，可按可见区域裁剪 | WebSocket |

浏览器 `WebSocket` 允许文本帧与二进制帧混用：**文本帧按 JSON 解析，二进制帧按首字节分发**，不需要额外握手。

```text
client -> server: text  {"type":"create_room","gameType":"tank",...}
server -> client: text  {"type":"welcome","protocolVersion":3,"binary":true,"tickRate":20}
# 注意：tickRate 是服务端能力协商值。Cloudflare Workers 部署默认 TANK_TICK_RATE=10；
# 客户端应按 welcome.tickRate / room.game.tickRate 调整输入发送间隔，不要硬编码 20Hz。
client -> server: bin   01 05 00 2a ...   // input, seq=42
server -> client: bin   02 01 12 34 ...   // snapshot, tick=4660
```

## 4. 二进制帧格式（建议）

统一小端序（`DataView`），所有字段定长、边界明确。

### 4.1 通用头

| 偏移 | 类型 | 字段 |
| --- | --- | --- |
| 0 | u8 | frameType：`0x01` 输入、`0x02` 快照 |
| 1 | u8 | flags：bit0 关键帧、bit1 增量、bit2 需要确认 |
| 2 | u16 | seq（客户端输入序号 / 服务端帧序号） |
| 4 | u32 | tick（服务端逻辑帧号；输入帧可填客户端预测 tick） |

### 4.2 客户端输入帧

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| inputFlags | u8 | bit0 上、bit1 下、bit2 左、bit3 右、bit4 开火、bit5 刹车 |
| aim | u16 | 炮口角度，0–65535 映射 0–2π |

客户端只发“意图”，位置、碰撞、命中全部由服务端计算。

### 4.3 服务端快照帧

关键帧（全量）：

```text
header(8) + u16 entityCount + entityCount * 14B
```

增量帧（只发变化实体）：

```text
header(8) + u16 ackSeq + u32 baselineTick + u16 changedCount
         + changedCount * (u16 id + u8 mask + 变化字段...)
```

- `mask` 的每一位对应一个字段，未变化字段不传。
- 客户端确认（ack）自己已收到的最新 tick；服务端以该 tick 为基线生成增量。
- 客户端基线丢失时，服务端补发关键帧。
- 关键帧兜底间隔建议 2 秒（40 tick）。

### 4.4 定点与量化

- 坐标用 `i16`，单位 `0.01` 世界单位，可表示 ±327；大战场用 `i32` 或分区坐标。
- 速度用 `i16`，单位 `0.01/秒`；角度用 `u16`。
- 生命周期、队伍、无敌帧等放 `u8` 位域。
- **服务端必须把反序列化结果夹紧到合法范围**，不能直接信任客户端输入。

## 5. 服务端模型

现有 `GameRules` 是“收到走子 → 校验 → 返回新状态”，**没有 tick 循环**，不能直接承载实时游戏。

### 5.1 新增接口

```python
class RealtimeGame(Protocol):
    tick_rate: int                      # 20
    def apply_input(self, player_id: str, input_frame: InputFrame) -> None: ...
    def tick(self, dt: float) -> None:  # 固定步长推进
        ...
    def snapshot(self, viewer_id: str, baseline: int | None) -> bytes: ...
    def finished(self) -> FinishResult | None: ...
```

回合制的 `GameRules` 保持不变，两种规则插件并存。

### 5.2 房间循环

- 每个实时房间一个 `asyncio` 循环任务，固定步长 `1/tick_rate`，用累计器补帧，单帧最多追 5 步，避免卡顿雪崩。
- 房间结束 / 空房时取消任务，避免泄漏。
- 小规模（几十个房间）每房一个任务足够；规模上来后改为全局 tick 调度器 + 时间轮。

### 5.3 快照与基线

- 服务端保存最近 N 个 tick 的快照或状态差异，按客户端的 `ackSeq` 生成增量。
- 观战者独立降频（如 5Hz），不做预测。
- 只给玩家发送其视野内实体（AOI / 迷雾），既能省带宽，也能避免“透视外挂”。

## 6. 客户端模型

- `lib/realtime/codec.ts`：`DataView` 编解码，所有读取先校验长度。
- 输入 20–30Hz 发送，带自增 `seq`；服务端回 `ackSeq` 用于对账。
- 快照进入 100ms 左右插值缓冲，渲染 `requestAnimationFrame` 平滑。
- 可选：本地预测 + 服务端校正（命中、碰撞仍以服务端为准）。
- 断线重连后请求关键帧；不要回放旧输入。
- **不要对实时二进制帧开启 `permessage-deflate`**：压缩 CPU 与延迟成本大于收益；大厅 JSON 可以按需压缩。

## 7. WebSocket 的边界

WebSocket 是**可靠、有序**的字节流：丢包会阻塞后续帧（队头阻塞）。对 8 人休闲坦克、20Hz 小帧，这通常没问题；但需要：

- 客户端只保留最新快照，渲染落后时主动丢帧，不排队。
- 服务端限制单连接发送队列，超过阈值丢弃旧快照。
- 输入限频（如 30 次/秒），超出直接拒绝，防止刷包。
- 若未来做竞技级、百人战场或强实时射击，再评估 WebTransport / WebRTC DataChannel 的不可靠通道；**当前不提前引入**。

## 8. 协议版本与兼容

- v2 完全不动：现有五子棋/象棋客户端继续 JSON。
- v3 新增能力协商：`welcome` 增加 `binary: true`、`tickRate`、`encoding: "json+binary"`。
- 只有 `mode = realtime` 的房间使用二进制帧；控制面仍走 JSON。
- 客户端与服务端共用 `shared/realtime-v3.fixtures.json` 黄金样例做单元测试，防止两边编码漂移。
- 上线顺序：~~编解码与测试~~ → ~~能力协商~~ → ~~单个坦克原型房~~ → AOI/增量 → 压测与限流。

## 9. 安全与可观测性

- 输入帧：长度、seq 单调性、位域合法性、坐标/角度夹紧、频率限制。
- 快照：实体数量上限、单帧最大字节数、房间 tick 预算监控。
- 指标：每连接上下行 B/s、快照大小 P50/P95、丢帧数、输入拒绝数、tick 延迟。
- 排障：提供 `xxd` 风格帧解码脚本与采样开关，不要在线上常开全量日志。

## 10. 与当前代码的衔接

- 前端游戏目录：`web/src/games/`，实时游戏加入时在 `types.ts` 增加 `GameType` 与状态类型，并新增 `games/<slug>/`。
- 传输层：`web/src/lib/socket.ts` 目前只处理文本帧；v3 时增加 `binaryType = 'arraybuffer'` 与二进制分支。
- 服务端：`server/app/games/` 增加 `realtime` 规则插件，`rooms.py` 增加 tick 任务与快照广播；现有回合制房间路径不变。

## 11. 当前落地状态（2026-11）

已经完成：

| 位置 | 内容 |
| --- | --- |
| `server/app/games/tank.py` | 纯模拟 TankWorld（移动/碰撞/子弹/命中/复活/胜负/地图） |
| `server/app/realtime/engine.py` | TankSession：20Hz 固定步长 tick、输入合并与限频、关键帧编码广播、事件下发 |
| `server/app/rooms.py` | 实时房间生命周期（2–8 人 ready 开局、离开/弃权结算、rematch、观战） |
| `server/app/ws.py` | 同连接文本/二进制双通道、`welcome.binary/tickRate` 能力协商 |
| `web/src/lib/socket.ts` | `onBinary` / `sendBinary` |
| `web/src/games/tank/` | 帧解码、快照插值/外推、输入采集、three.js 场景、HUD、等待/对局/结算页面 |

尚未完成（记录为后续工作）：AOI 视野裁剪、增量快照接入、客户端回滚式预测、压测与限流指标。

v3 编解码与共享 golden fixture：

| 位置 | 内容 |
| --- | --- |
| `server/app/realtime/codec.py` | 输入帧 / 关键帧 / 增量帧编解码、范围校验、定点与角度辅助函数 |
| `web/src/lib/realtime/codec.ts` | 与后端逐字节一致的 TypeScript 编解码 |
| `shared/realtime-v3.fixtures.json` | 共享黄金样例（hex + 期望解码结果） |
| `scripts/gen_realtime_fixtures.py` | 从 Python codec 重新生成 fixture |
| `server/tests/test_realtime_codec.py` | pytest：golden、截断、未知 mask、范围校验 |
| `web/src/lib/realtime/codec.test.ts` | vitest：同一份 golden + 防御性测试 |

尚未完成：`welcome` 能力协商、二进制帧接入 `socket.ts` / `ws.py`、实时房间 tick 循环、坦克玩法本身。

验证命令：

```bash
server/.venv/bin/python -m pytest server/tests/test_realtime_codec.py -q
cd web && npm test
```

# 坦克大战（tank）实现契约

> 状态：**已落地（2026-11）**：服务端模拟/房间 tick/二进制广播、前端 three.js 渲染与 HUD 全部按本文实现并通过测试；
> 本文同时是契约文档——改协议前先改这里，再同步两端与 `shared/realtime-v3.fixtures.json`。
>
> 关联文档：[REALTIME.md](REALTIME.md)（v3 二进制传输总设计）。

## 1. 玩法（v1 垂直切片）

- 2–8 人**自由混战（FFA）**，无队伍，先到 15 杀或 180 秒结束，按击杀数排名。
- 20Hz 固定步长服务端权威模拟；客户端只发输入意图，位置/碰撞/命中全部由服务端计算。
- 地图 96 × 96 世界单位（面积为旧版 4 倍），矩形掩体；坦克圆半径 0.9，子弹圆半径 0.18。
- 坦克 100 HP，每发 25 伤害（4 发击杀）；开火冷却 0.9s；子弹速度 22 u/s、寿命 3s。
- 击杀 +1 分；被击杀者 3s 后随机出生点复活，复活后 1.5s 无敌。
- 玩家颜色由座位 slot（0–7）决定，固定色板；观战者看全场。
- **人机混战**：建房时 `mode=ai` + `botCount=1–7`，房主 + N 台电脑坦克立即开局；
  电脑由服务端 `TankBotController` 每 tick 生成输入，与真人共用同一套物理与判定规则。

## 2. 世界坐标与定点

- 世界为 `x/y` 平面（渲染时映射到 three.js 的 `x/z`，`y` 为高度）。
- 二进制帧中坐标/速度为 `i16` 定点，单位 `0.01` 世界单位（±327 范围，地图 96 足够）。
- 角度为 `u16`，`0..65535` 映射 `0..2π`；**角度 0 指向 +x**，逆时针为正。
- 每实体同时携带**车体角 hull** 与**炮塔角 turret**。

## 3. 二进制帧（协议 v3）

通用头与输入帧不变，**实体从 14 字节扩到 16 字节**（新增 `turret`）。

### 3.1 通用头（8B，小端）

| 偏移 | 类型 | 字段 |
| --- | --- | --- |
| 0 | u8 | frameType：`0x01` 输入 / `0x02` 快照 |
| 1 | u8 | flags：bit0 关键帧、bit1 增量、bit2 需确认 |
| 2 | u16 | seq |
| 4 | u32 | tick |

### 3.2 客户端输入帧（11B）

`header(8) + u8 inputFlags + u16 aim`

- `inputFlags`：bit0 上（前进）、bit1 下（倒车）、bit2 左（车体左转）、bit3 右（车体右转）、bit4 开火、bit5 刹车。
- `aim`：炮塔**绝对角度**（u16）。
- 只发意图；频率上限 30 次/秒，服务端按 tick 合并（同一 tick 多帧以最后一帧为准）。

### 3.3 实体（16B）

| 偏移 | 类型 | 字段 | 说明 |
| --- | --- | --- | --- |
| 0 | u16 | id | 坦克 1–8（=slot+1），子弹 100+ 递增 |
| 2 | i16 | x | 0.01 定点 |
| 4 | i16 | y | 0.01 定点 |
| 6 | i16 | vx | 0.01 定点/秒 |
| 8 | i16 | vy | 0.01 定点/秒 |
| 10 | u16 | angle | 车体角 hull |
| 12 | u16 | turret | 炮塔角 |
| 14 | u8 | hp | 0–100 |
| 15 | u8 | flags | 见下 |

`flags` 位域：

| 位 | 含义 |
| --- | --- |
| 0–1 | kind：`0` 坦克、`1` 子弹 |
| 2–4 | owner slot（0–7） |
| 5 | alive：`1` 存活；炮塔/子弹恒为 1 |
| 6 | shielded：出生无敌 |
| 7 | 保留 |

### 3.4 快照帧

- 关键帧：`header(8) + u16 count + count × 16B`。
- 增量帧格式保留（`MASK_TURRET = 1<<7`，`DELTA_MASK_ALL = 0xFF`），**v1 服务端只发关键帧**，
  每 tick 一帧（20Hz），8 人局约 30 实体 ≈ 500B/帧 ≈ 10KB/s/客户端；后续再上增量与 AOI。

## 4. JSON 控制面（在现有 v2 协议上扩展）

控制面全部复用现有房间消息，`room.game` 对坦克是 **`TankGameInfo`**（不含实体）：

```jsonc
{
  "type": "room",
  "room": {
    "gameType": "tank",
    "status": "waiting|playing|finished",
    "players": [/* 复用 Player，color 固定为 slot 色名 */],
    "game": {
      "phase": "waiting|playing|finished",
      "tickRate": 20,
      "map": {
        "width": 96, "height": 96,
        "obstacles": [{ "x": 12, "y": 8, "w": 4, "h": 2 }],
        "spawns": [{ "x": 6, "y": 6 }],
        "theme": "warehouse"
      },
      "targetKills": 15,
      "endsAt": 1699999999999,      // playing 时的时间戳，等待中为 null
      "winnerId": null,
      "endedReason": null,          // "kills" | "time" | "forfeit"
      "scores": { "p_xxx": { "kills": 3, "deaths": 2 } }
    }
  }
}
```

- 开局：`ready` 对坦克表示「准备」，**≥2 人且全部 ready** 时服务端开局（房主无需额外 start）。
- 房间上限 8 人（`maxPlayers`），`waiting` 时可加入；`playing` 时只能观战。
- `welcome` 增加能力字段：`"binary": true`, `"tickRate": 20`（老客户端忽略即可）。
- 服务端→客户端新增事件消息（JSON，低频）：

```jsonc
{ "type": "tank_event", "event": { "kind": "hit|kill|respawn|match_end", ... } }
```

`hit`: `shooterId/targetId/x/y/damage`；`kill`: `shooterId/targetId`；
`respawn`: `playerId/x/y`；`match_end`: `winnerId/reason`。

- 客户端二进制帧只在 `status = playing` 且自己是玩家时发送。

## 5. 服务端模块

### 5.1 `server/app/games/tank.py`（纯模拟，无 asyncio）

```python
TICK_RATE = 20
WORLD_SIZE = 96.0

@dataclass(frozen=True, slots=True)
class EntityView:
    entity_id: int
    kind: int          # 0 tank / 1 bullet
    owner_slot: int
    x: float; y: float
    vx: float; vy: float
    hull: float        # 弧度
    turret: float      # 弧度
    hp: int
    shielded: bool

class TankWorld:
    def __init__(self, players: Sequence[tuple[str, str]], *, seed: int | None = None) -> None: ...
    def info(self, phase: str = ...) -> dict[str, Any]: ...      # TankGameInfo（JSON-safe）
    def apply_input(self, player_id: str, *, flags: int, aim: int, tick: int = 0) -> None: ...
    def tick(self, dt: float) -> list[dict[str, Any]]: ...       # 事件列表（JSON-safe）
    def entities(self) -> list[EntityView]: ...
    def scores(self) -> dict[str, dict[str, int]]: ...           # {pid: {kills, deaths}}
    def finished(self) -> bool: ...
    def winner(self) -> str | None: ...
    def ended_reason(self) -> str | None: ...
    def end_match(self, reason: str) -> None: ...                # 外部判负 / 人数不足
    def remove_player(self, player_id: str) -> None: ...
    def add_player(self, player_id: str, name: str) -> None: ... # 断线重连回座
    def player_slots(self) -> dict[str, int]: ...
```

要求：纯 Python 标准库、确定性（同 seed 同地图）、非法输入夹紧而不是抛异常（`apply_input` 只忽略未知玩家），
`tick` 后清理越界/过期子弹，事件按发生顺序返回。

### 5.2 `server/app/realtime/engine.py`

```python
class TankSession:
    """一个房间的实时对局：持有 TankWorld，跑 20Hz tick 循环，广播二进制快照。"""
    def __init__(self, room: Room, world: TankWorld, *, hub: ConnectionHub) -> None: ...
    async def start(self) -> None: ...          # 创建 asyncio 任务
    async def stop(self) -> None: ...           # 取消任务
    def submit(self, player_id: str, data: bytes) -> None: ...   # 解码输入帧并入队
    @property
    def world(self) -> TankWorld: ...
```

- 循环：`asyncio.sleep` 固定步长 + 累计器补帧（单帧最多追 5 步）。
- 每 tick：`world.tick(1/20)` → 编码关键帧 → 给每个玩家/观战者 `send_bytes`；事件转 `tank_event`。
- 玩家输入通过 `ConnectionHub.send_bytes_to_player`；WS 层把二进制帧转给 `TankSession.submit`。
- `world.finished()` 后停循环，房间层结算（战绩、`status=finished`）。

### 5.3 房间层（`rooms.py`）

- `Room` 增加 `max_players`、`session: TankSession | None`、`tank_players`（id→slot 映射由 world 持有）。
- `_start_game_locked` 对坦克：建 world → 建 session → `session.start()`，`status = playing`。
- 离开/断线宽限：调 `world.remove_player`；人数 < 2 时 `world.end_match("forfeit")` 并结算。
- 战绩：FFA，`winner` 得 `win`，其余 `loss`（`endedReason` 用 `kills/time/forfeit`，`moves` 字段写击杀数）。

### 5.4 WS 层（`ws.py`）

- `ConnectionHub` 增加 `send_bytes_to_player(player_id, data: bytes)`（同一把发送锁，`send_bytes`）。
- 接收循环改为同时接受 `bytes` 与 `str`：`receive()`；`str` 走现有 JSON 分派，`bytes` 交给
  当前房间的 `TankSession.submit`；非实时房间收到二进制帧直接丢弃并回 `error`（限流）。
- `welcome` 增加 `binary` / `tickRate` 字段。

## 5.5 电脑对手（`server/app/games/tank_ai.py`）

```python
class TankBotController:
    def __init__(self, bots: dict[str, int], obstacles, *, seed: int | None = None) -> None: ...
    def think(self, player_id: str, entities: Sequence[EntityView], dt: float) -> tuple[int, int]:
        """返回 (input_flags, aim_u16)；未知玩家或已死亡返回 (0, 0)。"""
```

- 只读实体快照 + 静态掩体，输出一帧输入；**不直接改世界状态**，因此 AI 无法绕开碰撞/冷却/命中。
- 行为：最近目标追击（距离 + 残血加权）、前方射线探测绕障、卡住 0.7s 倒车脱困、
  炮塔按子弹飞行时间做提前量、视线被掩体挡住不开火。
- 三档难度（`PROFILES`）：`easy` 误差约 ±0.06 rad + 0.8s 反应、跟瞄 2.2 rad/s；
  `normal` ±0.018 rad + 0.22s、4.2 rad/s；`hard` ±0.009 rad + 0.1s、6.2 rad/s。
- 引擎接线：`TankSession` 构造时收集 `is_bot` 玩家与 slot，每个 tick 先让 AI 生成输入，
  再与真人输入一起 `apply_input`；电脑不注册 WS 连接、不参与战绩、不占观战名额。
- 房间：`create_room(mode="ai", botCount=N, botDifficulty="easy|normal|hard")` →
  `_start_ai_tank_locked` 追加电脑玩家并立即开局；
  电脑局 `visibility=private`、不出现在大厅列表；`rematch` 立即重开；最后一名真人离开即解散房间。
- 客户端：大厅「人机对战」弹窗用步进器选 **1–7 台任意数量**电脑，并可切简单/普通/困难；
  比分榜直接显示「电脑1…N」。

## 6. 客户端模块

### 6.1 传输（`web/src/lib/socket.ts`）

- `socket.binaryType = 'arraybuffer'`；新增 `onBinary(cb: (buf: ArrayBuffer) => void)` 与 `sendBinary(buf: ArrayBuffer): void`。
- 二进制帧不进 JSON 解析，直接分发给 binary 监听者（新增连接时不重放，重连后由服务端推关键帧自然恢复）。

### 6.2 协议与状态（`web/src/games/tank/`）

- `protocol.ts`：`encodeTankInput(seq, tick, flags, aim): ArrayBuffer`；`decodeTankFrame(buf): TankFrame`；
  常量与 `lib/realtime/codec.ts` 一致（复用其编解码，展示层不要重复实现）。
- `state.ts`：快照缓冲（保留最近 200ms）+ 插值 + 本地预测（自己的坦克即时响应、平滑校正到服务端）。
- `input.ts`：键盘/鼠标 → `{flags, aim}`，20Hz 发送。

### 6.3 渲染（`web/src/games/tank/scene.ts`）

```ts
export interface SceneEntityView {
  id: number; kind: 0 | 1; ownerSlot: number;
  x: number; y: number; vx: number; vy: number;
  hull: number; turret: number; hp: number; shielded: boolean;
}
export interface TankScene {
  setMap(map: TankMap): void;
  setLocal(entityId: number | null): void;
  setEntities(entities: readonly SceneEntityView[]): void;   // 每帧调用，已是插值/预测后的位置
  frame(dt: number): void;                                    // 相机跟随、特效、渲染
  aimFromScreen(nx: number, ny: number): number | null;       // 归一化屏幕坐标→炮塔世界角度
  orbit(dx: number, dy: number): void;                        // 鼠标拖拽转视角（可选）
  setCameraMode(mode: 'chase' | 'top'): void;
  emit(event: SceneFxEvent): void;                            // 命中/爆炸/开火火光
  resize(): void;
  dispose(): void;
}
export function createTankScene(canvas: HTMLCanvasElement): TankScene;
```

- three.js 用**懒加载**（`import('three')` 只在 `/tank` 房间路由触发），大厅与棋类包体不变。
- 程序化精细建模（倒角块体 + 合并几何）：单辆约 10 Mesh / 7.5k 三角面，含倒角车体与炮塔、5 负重轮 + 主动轮 + 每侧 22 段履带链节、车长塔/潜望镜/舱盖/尾舱架/烟雾弹发射器/细电缆；个人坦克高亮描边 + 接触阴影；受伤冒烟/火花；子弹为 HDR 发光球 + 拖尾。
- 涂装：主漆 = `mix(队伍色, #EFEAE0, 0.55)` + clearcoat + 程序化面板缝/铆钉/掉漆/尘土贴图；
  队伍色以高饱和点缀形式出现在炮塔环带/首上条/侧裙色块/舱盖环，远距离仍可辨队。
- 相机：滚轮缩放在 chase 0.82x–1.6x、iso 0.5x–1.6x 之间；每帧从焦点向机位做障碍 AABB 射线夹紧
  （命中前 0.4 停下），避免放大时相机穿进集装箱/掩体；注视点前移 LEAD=10 单位（坦克落画面下方 1/3）。
- 打击特效：服务端子弹命中掩体/边界墙时下发 `tank_event.impact`（x/y，surface 由客户端按命中点查最近掩体面）；
  客户端按材质生成砖屑/火花/沙粒 + 贴合表面的弹坑/烧蚀/焦痕贴花（InstancedMesh 池、容量 256；墙面弹坑/烧蚀保留 240–300 秒，地面焦痕 60 秒）；`kill`
  为多段爆炸（闪光/火球/地面焦痕/抛物碎片/3.6s 黑烟柱/冲击波）；坦克移动留下两条 7–9 秒淡出的履带印。
- 受击反馈（本地玩家）：服务端 `tank_event.hit` 带 target/damage → 前端触发屏幕红闪、屏震（CSS 动画）、
  掉血数字（-25 上浮消散）与命中音效；被击毁时显示「被击毁」。
- 名字标签：每辆坦克头顶 `setNameTags` 渲染的 billboard（队伍色圆点 + 昵称，**无底板、文字描边**，
  自适应宽度、屏幕恒定尺寸，本地为「你 · 昵称」）；本地坦克另有脚下脉冲环。
- 瞄准反馈：目标标记就是 DOM 准星本身（严格跟随鼠标），准星到坦克的虚线由前端 SVG 绘制
  （终点与准星像素误差 <2px，冒烟断言）；场景侧不再绘制固定距离的标靶环。
- 指针锁定下的 HUD：准星作为虚拟光标，`elementFromPoint` 命中 HUD 按钮时高亮并在左键按下时直接触发
  按钮点击（不退出指针锁定，也不需要 Esc）——开火/音效/视角/离开都可直接操作。
- 植被与装饰：外围森林环带、场内靠墙约 6 棵树、草丛/落叶/碎石/小灌木（数量随面积等比放大）；全部 InstancedMesh 合批，
  **不参与碰撞**（坦克可直接碾过），放置由地图内容确定性哈希、自动避让掩体与出生点。
- 色彩管线（`scene-post.ts`）：ACESFilmic 色调映射 + sRGB 输出、程序化黄昏 PMREM 环境贴图、
  EffectComposer（Bloom 半分辨率 + SMAA + 自写色彩分级：冷暗部/暖高光/对比/暗角/极轻颗粒）、
  渐变天空穹顶 + 太阳光晕 + FogExp2、PCFSoft 阴影收紧到竞技场。
- 场景比例：程序化砖砌仓库 / 集装箱 / 沙袋矮墙三类掩体（CanvasTexture 生成砖缝、瓦楞、掉漆、
  粗糙度/凹凸），锥形针叶树 + 圆冠阔叶树，地面轮胎压痕/油渍/水洼；iso 视角下坦克约占屏高 6–9%。
- 三种相机：`iso`（默认，等距俯视、角度固定只平移跟随，屏幕绝大部分是地面，鼠标指哪打哪）、
  `chase`（第三人称追尾，可右键拖拽 orbit，Q/E 转向）、`top`（整场俯视不入旋转，用于看全局）；
  滚轮缩放 `zoomBy`（0.7x–1.6x，指数平滑，切视角/resize 保留缩放）。
- 全画布沉浸模式：对局中隐藏站点页头页脚，画布 fixed 铺满窗口（`body.tank-immersive`），
  `ResizeObserver` 同步渲染尺寸。
- 标靶环：位置 = 屏幕中心射线的地面交点（距离可变，随视角俯仰自然变化），`depthTest:false` 置顶显示；
  从炮口到标靶的虚线同步画到该点。
- 瞄准与视角（第三人称坦克手感）：点画面锁定鼠标后，**鼠标移动虚拟准星**（NDC），炮塔瞄准方向 = 「准星 NDC − 本地坦克 NDC」经相机 yaw 换算得到的世界方向（360° 无限制、零平滑）；标靶环画在准星正下方的地面交点（`groundPointFromScreen`），距离随准星位置变化，`depthTest:false` 置顶；相机每帧自动跟到车体后方（yaw = 车体角），车体在「跟随」模式自动朝瞄准方向转、A/D 辅助覆盖。

### 6.4 页面（`web/src/games/tank/TankRoom.tsx`）

- 全屏 canvas + React HUD 覆盖层（血量、装填、比分榜、倒计时、击杀播报、小地图 Canvas 2D、操作提示）。
- 生命周期：进入房间 → `setMap`（`room.game` 的 map）→ 二进制监听 → rAF 循环 → 退出时 `dispose`。
- `App.tsx` 在 `room.gameType === 'tank'` 时渲染 `TankRoom`，其余仍走 `RoomView`。
- 注册：`types.ts` 增加 `GameType 'tank'` 与 `TankGame`；`registry.ts` 登记 `tank`；从 `planned.ts` 移除。

## 7. 测试与验收

- `server/tests/test_tank_world.py`：移动/转向、掩体碰撞、子弹命中与击杀、复活与无敌、比分与结束条件、确定性。
- `server/tests/test_tank_room.py`：房间 2 人 ready 开局、20Hz 快照关键帧可解码、输入驱动位移、离开结算。
- `web/src/games/tank/*.test.ts`：输入编码/帧解码 golden（复用共享 fixture）、快照插值、输入位域。
- `scripts/tank_smoke.py`：Playwright 双客户端全流程（含准星、爆炸特效、音效开关、视角切换）。
- 验收：`pytest`、`npm test`、`npx tsc --noEmit`、`npm run build` 全绿；双客户端脚本对局可打到击杀。

## 8. 暂不做（记录边界）

- 队伍模式、道具、击穿/弹道下坠、载具差异、AOI/迷雾、增量快照、WebTransport。
- AI 只有一档难度，不会团队协作/占点，也不会绕到侧翼包抄。
- 服务端 v1 只发关键帧（增量帧编解码已具备，接入即可省带宽）；观战 5Hz、玩家 20Hz。
- 客户端为「外推 + 平滑」而非完整回滚式预测：本地操作有约 1 个 tick 的可感知延迟，命中判定始终以服务端为准。

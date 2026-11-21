#!/usr/bin/env python3
"""端到端联机冒烟测试：真实 HTTP + 两个 WebSocket 客户端打完整对局。

后端只提供 API/WS（前端静态资源不在后端），所以这里只验证 REST + WS。

用法（先启动后端）：
    server/.venv/bin/python scripts/e2e.py --url http://127.0.0.1:8765

需要 `websockets` 库（uvicorn[standard] 已自带）。
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import urllib.request
from typing import Any, Callable

import websockets
from websockets.exceptions import WebSocketException

CHECKS = 0


def ok(desc: str) -> None:
    global CHECKS
    CHECKS += 1
    print(f"  \u2713 {desc}")


def fail(desc: str, extra: Any = None) -> None:
    print(f"  \u2717 {desc}")
    if extra is not None:
        print(f"    实际：{json.dumps(extra, ensure_ascii=False)[:800]}")
    sys.exit(1)


def http_json(url: str) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=5) as resp:
        assert resp.status == 200, resp.status
        return json.loads(resp.read().decode("utf-8"))


class Client:
    def __init__(self, ws: Any, label: str) -> None:
        self.ws = ws
        self.label = label
        self.inbox: list[dict[str, Any]] = []

    async def send(self, payload: dict[str, Any]) -> None:
        await self.ws.send(json.dumps(payload, ensure_ascii=False))

    async def wait(
        self,
        matcher: Callable[[dict[str, Any]], bool],
        desc: str,
        timeout: float = 6.0,
    ) -> dict[str, Any]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            for idx, msg in enumerate(self.inbox):
                if matcher(msg):
                    return self.inbox.pop(idx)
            remaining = deadline - loop.time()
            if remaining <= 0:
                fail(f"{self.label} 等待超时：{desc}", self.inbox[-3:])
            raw = await asyncio.wait_for(self.ws.recv(), timeout=remaining)
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                fail(f"{self.label} 收到非 JSON 消息", raw[:200])
            if not matcher(msg):
                self.inbox.append(msg)
                continue
            return msg

    async def expect(self, mtype: str, desc: str, timeout: float = 6.0) -> dict[str, Any]:
        return await self.wait(lambda m: m.get("type") == mtype, desc, timeout)

    async def expect_error(self, code: str, desc: str) -> None:
        msg = await self.expect("error", desc)
        if msg.get("code") != code:
            fail(f"{desc}（期望错误码 {code}）", msg)
        ok(f"{desc} → {code}")

    async def room_where(
        self, pred: Callable[[dict[str, Any]], bool], desc: str, timeout: float = 6.0
    ) -> dict[str, Any]:
        msg = await self.wait(
            lambda m: m.get("type") == "room" and m.get("room") is not None and pred(m["room"]),
            desc,
            timeout,
        )
        return msg["room"]


async def connect(ws_url: str, label: str) -> tuple[Client, dict[str, Any]]:
    ws = await websockets.connect(ws_url, open_timeout=6, max_size=4 * 1024 * 1024)
    client = Client(ws, label)
    welcome = await client.expect("welcome", f"{label} 收到 welcome")
    return client, welcome


def player(room: dict[str, Any], player_id: str) -> dict[str, Any]:
    for p in room["players"]:
        if p["id"] == player_id:
            return p
    fail(f"房间中找不到玩家 {player_id}", room)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    args = parser.parse_args()
    base = args.url.rstrip("/")
    ws_url = base.replace("http://", "ws://").replace("https://", "wss://") + "/ws"

    print(f"== E2E 目标 {base}")

    health = http_json(f"{base}/api/health")
    assert health.get("status") == "ok", health
    ok(f"/api/health ok（版本 {health.get('version')}，房间 {health.get('rooms')}）")

    config = http_json(f"{base}/api/config")
    board_size = config["boardSize"]
    if board_size < 9:
        fail("boardSize 异常", config)
    ok(f"/api/config ok（棋盘 {board_size} 路，协议 v{config['protocolVersion']}）")

    c1, w1 = await connect(ws_url, "黑方")
    c2, w2 = await connect(ws_url, "白方")
    if not w1.get("playerId") or not w1.get("token") or not w2.get("playerId"):
        fail("welcome 缺少 playerId/token", [w1, w2])
    ok("两个客户端连接成功并拿到 playerId/token")

    await c1.send(
        {"type": "create_room", "name": "棋手A", "roomName": "E2E 测试房", "visibility": "public", "color": "black"}
    )
    room1 = await c1.room_where(lambda r: r["status"] == "waiting", "创建房间")
    room_id = room1["id"]
    if len(room1["players"]) != 1 or room1["players"][0]["color"] != "black":
        fail("创建者应为房主且执黑", room1)
    ok(f"创建房间 {room_id} 成功，房主执黑")

    await c1.send({"type": "move", "row": 7, "col": 7})
    await c1.expect_error("GAME_NOT_ACTIVE", "未开局时落子被拒")

    await c2.send({"type": "join_room", "roomId": room_id, "name": "棋手B"})
    room2 = await c2.room_where(lambda r: len(r["players"]) == 2, "加入房间")
    if room2["id"] != room_id:
        fail("加入的房间 id 不一致", room2)
    await c1.room_where(lambda r: len(r["players"]) == 2, "房主看到对手加入")
    colors = {p["name"]: p["color"] for p in room2["players"]}
    if colors != {"棋手A": "black", "棋手B": "white"}:
        fail("颜色分配错误", colors)
    ok("对手加入成功，黑白分配正确")

    await c1.send({"type": "ready"})
    await c1.room_where(lambda r: r["players"][0]["ready"] is True, "房主准备")
    await c2.send({"type": "ready"})
    playing = await c1.room_where(lambda r: r["status"] == "playing", "双方准备后开局")
    if playing["game"]["currentTurn"] != "black" or any(any(row) for row in playing["game"]["board"]):
        fail("开局状态错误（应空盘且黑先）", playing["game"])
    await c2.room_where(lambda r: r["status"] == "playing", "白方看到开局")
    ok("双方准备后自动开局，空盘黑先")

    # 第三人观战：满房/开局后不占座，只读同步
    c3, w3 = await connect(ws_url, "观众")
    await c3.send({"type": "watch_room", "roomId": room_id, "name": "观众甲"})
    watched = await c3.room_where(lambda r: r["spectators"] == 1, "观战进入房间")
    if any(p["id"] == w3["playerId"] for p in watched["players"]):
        fail("观战者不应出现在玩家列表中", watched["players"])
    await c1.room_where(lambda r: r["spectators"] == 1, "玩家看到观战人数")
    await c2.room_where(lambda r: r["spectators"] == 1, "另一玩家看到观战人数")
    ok("第三人在开局后以观战身份进入，不占座")

    # 黑方在 row=7 连成 col 3..7，白方在 row=0 陪跑 col 0..3
    black_plan = [(7, col) for col in range(3, 8)]
    white_plan = [(0, col) for col in range(0, 4)]
    for turn in range(9):
        if turn % 2 == 0:
            mover, color, (row, col) = c1, "black", black_plan[turn // 2]
        else:
            mover, color, (row, col) = c2, "white", white_plan[turn // 2]
        await mover.send({"type": "move", "row": row, "col": col})
        snapshot = await mover.room_where(
            lambda r, row=row, col=col: r["game"]["lastMove"] == {"row": row, "col": col},
            f"{color} 落子 ({row},{col}) 广播",
        )
        # 对手也应当收到同一手
        opponent = c2 if mover is c1 else c1
        await opponent.room_where(
            lambda r, row=row, col=col: r["game"]["lastMove"] == {"row": row, "col": col},
            f"对手看到 ({row},{col})",
        )
        if turn < 8 and snapshot["game"]["winner"] is not None:
            fail("尚未五连却判胜", snapshot["game"])
    # 第 9 手（黑方五连）的快照本身就是终局快照
    final = snapshot
    if final["status"] != "finished":
        fail("五连后房间状态未变为 finished", final)
    game = final["game"]
    if game["winner"] != "black" or game["endedReason"] != "five" or len(game["winLine"] or []) < 5:
        fail("胜负判定错误", game)
    ok(f"黑方五连判胜，winLine {len(game['winLine'])} 子，endedReason=five")

    # 观战者同步终局、不能落子、可以聊天、可以退出
    await c3.room_where(lambda r: r["status"] == "finished", "观战者看到终局")
    await c3.send({"type": "move", "row": 0, "col": 0})
    await c3.expect_error("NOT_IN_ROOM", "观战者不能落子")
    await c3.send({"type": "chat", "text": "精彩"})
    for viewer, label in ((c1, "玩家A"), (c2, "玩家B"), (c3, "观战者")):
        chat = await viewer.expect("chat", f"{label} 收到观战者聊天")
        if chat["message"]["text"] != "精彩":
            fail("观战者聊天内容错误", chat)
    await c3.send({"type": "leave_room"})
    await c3.wait(
        lambda m: m.get("type") == "room" and m.get("room") is None,
        "观战者退出后 room=null",
    )
    await c1.room_where(lambda r: r["spectators"] == 0, "退出后观战人数归零")
    await c2.room_where(lambda r: r["spectators"] == 0, "另一玩家看到观战人数归零")
    await c3.ws.close()
    ok("观战同步终局/聊天，只读不可落子，退出后人数归零")

    # 再来一局：双方投票 → 交换黑白、清空棋盘
    await c1.send({"type": "rematch"})
    await c2.send({"type": "rematch"})
    rematch = await c1.room_where(lambda r: r["status"] == "playing" and not any(map(any, r["game"]["board"])), "再来一局开局")
    if player(rematch, w1["playerId"])["color"] != "white" or player(rematch, w2["playerId"])["color"] != "black":
        fail("再来一局未交换黑白", rematch["players"])
    ok("双方 rematch 后清盘重开且交换黑白")

    # 聊天
    await c1.send({"type": "chat", "text": "好棋！"})
    chat = await c2.expect("chat", "对手收到聊天")
    if chat["message"]["text"] != "好棋！" or chat["message"]["name"] != "棋手A":
        fail("聊天内容错误", chat)
    ok("房间内聊天广播正常")

    # 断线重连：白方断开后用 token 恢复身份与房间
    await c2.ws.close()
    ws2 = await websockets.connect(ws_url, open_timeout=6)
    c2b = Client(ws2, "白方重连")
    await c2b.send({"type": "hello", "playerId": w2["playerId"], "token": w2["token"]})
    welcome = await c2b.wait(
        lambda m: m.get("type") == "welcome" and m.get("reconnected") is True,
        "重连 welcome",
    )
    restored = await c2b.expect("room", "重连恢复房间快照")
    if restored.get("room") is None or restored["room"]["id"] != room_id:
        fail("重连未恢复原房间", restored)
    ok("断线用 token 重连并恢复原房间")

    await c2b.send({"type": "leave_room"})
    after_leave = await c1.room_where(lambda r: r["status"] == "waiting" and len(r["players"]) == 1, "对手离开后房间重置")
    if after_leave["game"]["endedReason"] not in (None, "forfeit"):
        fail("对手离开后未重置，endedReason 异常", after_leave["game"])
    ok("对手离开后对局结算并重置为等待")

    await c1.send({"type": "leave_room"})
    await c1.wait(
        lambda m: m.get("type") == "room" and m.get("room") is None,
        "自己离开房间后收到 room=null",
    )
    ok("离开房间后 room=null")

    await c1.ws.close()
    await c2b.ws.close()

    # 握手 Cookie 身份恢复：模拟 localStorage 丢失后刷新，仍认回同一玩家
    ws_cookie = await websockets.connect(ws_url, open_timeout=6)
    cookie_client = Client(ws_cookie, "Cookie 会话")
    cookie_welcome = await cookie_client.expect("welcome", "Cookie 会话 welcome")
    set_cookie = ws_cookie.response.headers.get("set-cookie") or ""
    if "games_session=" not in set_cookie:
        fail("握手未下发身份 Cookie", set_cookie)
    cookie = set_cookie.split(";", 1)[0]
    await ws_cookie.close()

    ws_restored = await websockets.connect(
        ws_url, open_timeout=6, additional_headers={"Cookie": cookie}
    )
    restored_client = Client(ws_restored, "Cookie 恢复")
    restored_welcome = await restored_client.wait(
        lambda m: m.get("type") == "welcome" and m.get("reconnected") is True,
        "Cookie 恢复 welcome",
    )
    if restored_welcome["playerId"] != cookie_welcome["playerId"]:
        fail("Cookie 未恢复同一 playerId", [cookie_welcome, restored_welcome])
    await ws_restored.close()
    ok("刷新/丢失 localStorage 时可通过握手 Cookie 认回同一玩家")

    print(f"\n== E2E PASS：{CHECKS} 项检查全部通过")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except AssertionError as exc:  # 主要给 HTTP 断言兜底
        print(f"断言失败：{exc}")
        sys.exit(1)
    except WebSocketException as exc:
        print(f"WebSocket 失败：{exc}")
        sys.exit(1)

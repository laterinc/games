#!/usr/bin/env python3
"""浏览器端 UI 冒烟（可选，不属于运行时依赖）。

用 Playwright 驱动真实 Chrome 开两个独立浏览器上下文，完整走一遍
「建房 → 邀请链接加入 → 双方准备 → 五连 → 再来一局 → 聊天 → 刷新重连」。

依赖：
    python3 -m venv /tmp/pwenv && /tmp/pwenv/bin/pip install playwright
    （使用系统安装的 Chrome，无需 playwright install chromium）

用法（后端不托管前端，需先起静态服务器 + 代理，如 Vite preview 4173）：
    ./scripts/start.sh
    cd web && npm run build && npm run preview
    /tmp/pwenv/bin/python scripts/ui_smoke.py --url http://127.0.0.1:4173
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

PAD = 38
CELL = 40
BOARD_PX = (15 - 1) * CELL + PAD * 2
SHOT_DIR = Path("/tmp/games-ui")
CHESS_BOARD_W = (9 - 1) * 64 + 44 * 2
CHESS_BOARD_H = (10 - 1) * 64 + 44 * 2


def wait_room(page: Page, room_id: str) -> None:
    expect(page.locator(".room-code-chip strong")).to_have_text(room_id, timeout=10_000)
    expect(page.locator('[role="application"]')).to_be_visible(timeout=10_000)


def click_point(page: Page, row: int, col: int) -> None:
    box = page.locator(".board-canvas").bounding_box()
    assert box is not None, "棋盘不可见"
    x = box["x"] + (PAD + col * CELL) / BOARD_PX * box["width"]
    y = box["y"] + (PAD + row * CELL) / BOARD_PX * box["height"]
    page.mouse.click(x, y)


def click_chess_point(page: Page, row: int, col: int) -> None:
    box = page.locator(".chess-canvas").bounding_box()
    assert box is not None, "象棋棋盘不可见"
    x = box["x"] + (44 + col * 64) / CHESS_BOARD_W * box["width"]
    y = box["y"] + (44 + row * 64) / CHESS_BOARD_H * box["height"]
    page.mouse.click(x, y)


def wait_moves(page: Page, count: int) -> None:
    expect(page.locator(".turn-meta")).to_contain_text(f"手数 {count}", timeout=10_000)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:4173")
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    base = args.url.rstrip("/")
    SHOT_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=not args.headed)
        context_a = browser.new_context(viewport={"width": 1360, "height": 900})
        context_b = browser.new_context(viewport={"width": 1360, "height": 900})
        a = context_a.new_page()
        b = context_b.new_page()
        errors: list[str] = []
        for page, tag in ((a, "A"), (b, "B")):
            page.on("console", lambda msg, tag=tag: errors.append(f"[{tag}] console.{msg.type}: {msg.text}") if msg.type == "error" else None)
            page.on("pageerror", lambda exc, tag=tag: errors.append(f"[{tag}] pageerror: {exc}"))

        print(f"== UI 冒烟 {base}")
        a.goto(base, wait_until="networkidle")
        expect(a.locator(".home")).to_be_visible()
        expect(a.locator(".game-card.is-planned:not(.is-placeholder)")).to_contain_text("坦克大战")
        print("  ✓ 游戏中心首页加载（含开发中游戏卡片）")
        a.get_by_role("button", name="进入五子棋").click()
        a.wait_for_url(lambda url: url.rstrip("/").endswith("/gomoku"), timeout=10_000)
        a.locator('input[autocomplete="nickname"]').fill("小明")
        expect(a.locator(".conn-pill")).to_contain_text("已连接", timeout=10_000)
        print("  ✓ 从首页进入 /gomoku，WebSocket 已连接")
        a.screenshot(path=str(SHOT_DIR / "lobby.png"), full_page=True)

        a.get_by_role("button", name="创建房间").click()
        a.locator(".field").filter(has_text="房间名（可空）").locator("input").fill("UI 冒烟房")
        a.get_by_role("button", name="创建并进入").click()
        a.wait_for_url(lambda url: "/room/" in url, timeout=10_000)
        room_id = a.locator(".room-code-chip strong").inner_text().strip()
        assert len(room_id) == 6, f"房间码异常：{room_id!r}"
        wait_room(a, room_id)
        print(f"  ✓ 创建房间 {room_id} 并进入对局页")

        # 好友通过邀请链接加入
        b.goto(f"{base}/gomoku/room/{room_id}", wait_until="networkidle")
        b.locator('input[autocomplete="nickname"]').fill("小红")
        expect(b.locator('input[aria-label="6 位房间码"]')).to_have_value(room_id, timeout=5_000)
        b.locator("form.join-form").get_by_role("button", name="加入").click()
        wait_room(b, room_id)
        expect(b.locator(".players-card")).to_contain_text("小明", timeout=10_000)
        print(f"  ✓ 通过 /gomoku/room/{room_id} 邀请链接加入，双方玩家卡正确")

        a.get_by_role("button", name="准备", exact=True).click()
        b.get_by_role("button", name="准备", exact=True).click()
        expect(a.locator(".turn-text")).to_contain_text("轮到你落子", timeout=10_000)
        expect(b.locator(".turn-text")).to_contain_text("等待黑棋落子", timeout=10_000)
        print("  ✓ 双方准备后开局，黑方先手（A 执黑）")

        # 黑（A）row 7 col 3..7 五连；白（B）row 0 col 0..3 陪跑
        black = [(7, c) for c in range(3, 8)]
        white = [(0, c) for c in range(4)]
        count = 0
        for i in range(9):
            if i % 2 == 0:
                click_point(a, *black[i // 2])
                count += 1
                wait_moves(a, count)
                wait_moves(b, count)
            else:
                click_point(b, *white[i // 2])
                count += 1
                wait_moves(b, count)
                wait_moves(a, count)
        expect(a.locator(".result-banner")).to_contain_text("黑棋胜", timeout=10_000)
        expect(b.locator(".result-banner")).to_contain_text("黑棋胜", timeout=10_000)
        expect(a.locator(".result-banner")).to_contain_text("五连达成", timeout=10_000)
        print("  ✓ 九手五连判胜，双方均显示黑胜与 5 子连线高亮")
        a.wait_for_timeout(500)
        a.screenshot(path=str(SHOT_DIR / "finished-desktop.png"), full_page=True)

        # 再来一局：双方投票 → 交换黑白、清盘
        a.get_by_role("button", name="再来一局").click()
        expect(a.locator(".action-hint").first).to_be_visible()
        b.get_by_role("button", name="再来一局").click()
        expect(a.locator(".turn-text")).to_contain_text("等待黑棋落子", timeout=10_000)
        expect(a.locator(".board-footer")).to_contain_text("你执白棋", timeout=10_000)
        expect(b.locator(".board-footer")).to_contain_text("你执黑棋", timeout=10_000)
        expect(a.locator(".turn-meta")).to_contain_text("手数 0")
        print("  ✓ 双方 rematch 后清盘重开并交换黑白（A 变白、B 变黑）")

        # 重开后走三手，留一张中局截图
        for index, (row, col, page) in enumerate(((7, 7, b), (7, 8, a), (6, 7, b)), start=1):
            click_point(page, row, col)
            wait_moves(a, index)
            wait_moves(b, index)
        a.wait_for_timeout(400)
        a.screenshot(path=str(SHOT_DIR / "midgame-desktop.png"), full_page=True)
        print("  ✓ 对局页渲染（截图见 /tmp/games-ui）")

        # 第三人观战：通过 /gomoku/room/{code} 进入，点「观战」，只读看棋
        spectator_ctx = browser.new_context()
        spectator = spectator_ctx.new_page()
        spectator.goto(f"{base}/gomoku/room/{room_id}", wait_until="networkidle")
        spectator.locator('input[autocomplete="nickname"]').fill("观众")
        expect(spectator.locator('input[aria-label="6 位房间码"]')).to_have_value(
            room_id, timeout=5_000
        )
        spectator.get_by_role("button", name="观战", exact=True).click()
        wait_room(spectator, room_id)
        expect(spectator.locator(".badge-spectator")).to_be_visible(timeout=10_000)
        expect(spectator.locator('[role="application"]')).to_have_attribute(
            "aria-disabled", "true"
        )
        expect(spectator.locator(".board-footer")).to_contain_text("观战中", timeout=10_000)
        expect(a.locator(".spectator-count")).to_contain_text("1 人正在观战", timeout=10_000)
        print("  ✓ 第三人观战进入，只读棋盘，玩家界面显示观战人数")

        # 聊天双向同步（观战者也能看到）
        a.locator('input[aria-label="聊天内容"]').fill("好棋！")
        a.locator('input[aria-label="聊天内容"]').press("Enter")
        expect(b.locator(".chat-list")).to_contain_text("好棋！", timeout=10_000)
        expect(a.locator(".chat-list")).to_contain_text("好棋！", timeout=10_000)
        expect(spectator.locator(".chat-list")).to_contain_text("好棋！", timeout=10_000)
        print("  ✓ 房间聊天实时同步（含观战者）")

        # 观战者退出：不占座，玩家侧观战人数归零
        spectator.get_by_role("button", name="退出观战").first.click()
        expect(spectator.locator(".room-view")).to_have_count(0, timeout=10_000)
        expect(a.locator(".spectator-count")).to_have_count(0, timeout=10_000)
        spectator_ctx.close()
        print("  ✓ 退出观战后不影响对局，观战人数归零")

        # 移动端视图（复用白方页面，避免同 session 双开互相顶号）
        b.set_viewport_size({"width": 390, "height": 844})
        b.wait_for_timeout(300)
        b.screenshot(path=str(SHOT_DIR / "mobile-room.png"), full_page=True)
        b.set_viewport_size({"width": 1360, "height": 900})
        print("  ✓ 移动端 390×844 对局页渲染（截图见 /tmp/games-ui）")

        # 刷新重连：A 刷新后应凭 session 自动回到房间
        a.reload(wait_until="networkidle")
        wait_room(a, room_id)
        expect(a.locator(".board-footer")).to_contain_text("你执白棋", timeout=10_000)
        print("  ✓ 刷新页面后凭 playerId/token 自动恢复对局与座位")

        # 即使 localStorage 被清掉，也能靠握手 Cookie 认回同一玩家与座位
        a.evaluate("() => localStorage.removeItem('games.session.v1')")
        a.reload(wait_until="networkidle")
        wait_room(a, room_id)
        expect(a.locator(".board-footer")).to_contain_text("你执白棋", timeout=10_000)
        print("  ✓ 清空 localStorage 后刷新，仍凭 Cookie 恢复同一玩家与座位")

        # 中国象棋：首页进入 → 人机对战 → 红兵前进 → 电脑应手
        c = browser.new_context(viewport={"width": 1360, "height": 1000}).new_page()
        c.on("console", lambda msg: errors.append(f"[C] console.{msg.type}: {msg.text}") if msg.type == "error" else None)
        c.on("pageerror", lambda exc: errors.append(f"[C] pageerror: {exc}"))
        c.goto(base, wait_until="networkidle")
        c.get_by_role("button", name="进入中国象棋").click()
        c.wait_for_url(lambda url: url.rstrip("/").endswith("/chess"), timeout=10_000)
        c.locator('input[autocomplete="nickname"]').fill("象棋手")
        expect(c.locator(".lobby")).to_have_attribute("data-game", "chess")
        c.screenshot(path=str(SHOT_DIR / "chess-lobby.png"), full_page=True)
        c.get_by_role("button", name="人机对战").click()
        c.get_by_role("button", name="开始对局").click()
        c.locator(".chess-canvas").wait_for(timeout=10_000)
        click_chess_point(c, 6, 0)
        click_chess_point(c, 5, 0)
        expect(c.locator(".turn-meta")).to_contain_text("手数 2", timeout=10_000)
        expect(c.locator(".board-footer")).to_contain_text("红棋先行")
        c.screenshot(path=str(SHOT_DIR / "chess-room.png"), full_page=True)
        print("  ✓ 首页进入中国象棋：人机开局、红兵前进与电脑应手")

        if errors:
            print("\n浏览器控制台错误：")
            for line in errors:
                print("  ", line)
            sys.exit(1)
        print("\n== UI SMOKE PASS：全流程通过，零控制台错误")
        browser.close()


if __name__ == "__main__":
    main()

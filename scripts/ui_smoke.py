#!/usr/bin/env python3
"""浏览器端 UI 冒烟（可选，不属于运行时依赖）。

用 Playwright 驱动真实 Chrome 开两个独立浏览器上下文，完整走一遍
「建房 → 邀请链接加入 → 双方准备 → 五连 → 再来一局 → 聊天 → 刷新重连」。

依赖：
    python3 -m venv /tmp/pwenv && /tmp/pwenv/bin/pip install playwright
    （使用系统安装的 Chrome，无需 playwright install chromium）

用法：
    /tmp/pwenv/bin/python scripts/ui_smoke.py --url http://127.0.0.1:8765
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

PAD = 38
CELL = 40
BOARD_PX = (15 - 1) * CELL + PAD * 2
SHOT_DIR = Path("/tmp/gomoku-ui")


def wait_room(page: Page, room_id: str) -> None:
    expect(page.locator(".room-code-chip strong")).to_have_text(room_id, timeout=10_000)
    expect(page.locator('[role="application"]')).to_be_visible(timeout=10_000)


def click_point(page: Page, row: int, col: int) -> None:
    box = page.locator(".board-svg").bounding_box()
    assert box is not None, "棋盘不可见"
    x = box["x"] + (PAD + col * CELL) / BOARD_PX * box["width"]
    y = box["y"] + (PAD + row * CELL) / BOARD_PX * box["height"]
    page.mouse.click(x, y)


def wait_moves(page: Page, count: int) -> None:
    expect(page.locator(".turn-meta")).to_contain_text(f"手数 {count}", timeout=10_000)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8765")
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
        a.locator('input[autocomplete="nickname"]').fill("小明")
        expect(a.locator(".conn-pill")).to_contain_text("已连接", timeout=10_000)
        print("  ✓ 大厅加载、WebSocket 已连接")
        a.screenshot(path=str(SHOT_DIR / "lobby.png"), full_page=True)

        a.get_by_role("button", name="创建房间").click()
        a.locator(".field").filter(has_text="房间名（可空）").locator("input").fill("UI 冒烟房")
        a.get_by_role("button", name="创建并进入").click()
        a.wait_for_url(lambda url: "room=" in url, timeout=10_000)
        room_id = a.locator(".room-code-chip strong").inner_text().strip()
        assert len(room_id) == 6, f"房间码异常：{room_id!r}"
        wait_room(a, room_id)
        print(f"  ✓ 创建房间 {room_id} 并进入对局页")

        # 好友通过邀请链接加入
        b.goto(f"{base}/?room={room_id}", wait_until="networkidle")
        b.locator('input[autocomplete="nickname"]').fill("小红")
        expect(b.locator('input[aria-label="6 位房间码"]')).to_have_value(room_id, timeout=5_000)
        b.locator("form.join-form").get_by_role("button", name="加入").click()
        wait_room(b, room_id)
        expect(b.locator(".players-card")).to_contain_text("小明", timeout=10_000)
        print("  ✓ 通过 ?room= 邀请链接加入，双方玩家卡正确")

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
        expect(a.locator(".win-ring")).to_have_count(5, timeout=10_000)
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

        # 聊天双向同步
        a.locator('input[aria-label="聊天内容"]').fill("好棋！")
        a.locator('input[aria-label="聊天内容"]').press("Enter")
        expect(b.locator(".chat-list")).to_contain_text("好棋！", timeout=10_000)
        expect(a.locator(".chat-list")).to_contain_text("好棋！", timeout=10_000)
        print("  ✓ 房间聊天实时同步")

        # 移动端视图（复用白方页面，避免同 session 双开互相顶号）
        b.set_viewport_size({"width": 390, "height": 844})
        b.wait_for_timeout(300)
        b.screenshot(path=str(SHOT_DIR / "mobile-room.png"), full_page=True)
        b.set_viewport_size({"width": 1360, "height": 900})
        print("  ✓ 移动端 390×844 对局页渲染（截图见 /tmp/gomoku-ui）")

        # 刷新重连：A 刷新后应凭 session 自动回到房间
        a.reload(wait_until="networkidle")
        wait_room(a, room_id)
        expect(a.locator(".board-footer")).to_contain_text("你执白棋", timeout=10_000)
        print("  ✓ 刷新页面后凭 playerId/token 自动恢复对局与座位")

        if errors:
            print("\n浏览器控制台错误：")
            for line in errors:
                print("  ", line)
            sys.exit(1)
        print("\n== UI SMOKE PASS：全流程通过，零控制台错误")
        browser.close()


if __name__ == "__main__":
    main()

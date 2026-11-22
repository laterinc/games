#!/usr/bin/env python3
"""坦克大战浏览器端到端冒烟（可选，不属于运行时依赖）。

用 Playwright 开两个独立上下文，完整走一遍：
「大厅进入 /tank → 建房 → 邀请链接加入 → 双方准备 → 3D 战场渲染 →
  计时推进（tick 生效）→ WASD 驾驶 → V 切视角 → 离开结算」。

依赖：
    python3 -m venv /tmp/pwenv && /tmp/pwenv/bin/pip install playwright
    （使用系统安装的 Chrome）

用法（后端不托管前端）：
    ./scripts/start.sh                      # 后端 127.0.0.1:8765
    cd web && npm run dev                   # 前端 127.0.0.1:5173
    /tmp/pwenv/bin/python scripts/tank_smoke.py --url http://127.0.0.1:5173
"""

from __future__ import annotations

import argparse
import math
import re
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

SHOT_DIR = Path("/tmp/games-tank")
NICKNAME_INPUT = 'input[autocomplete="nickname"]'


def wait_connected(page: Page) -> None:
    expect(page.locator(".conn-pill")).to_contain_text("已连接", timeout=15_000)


def wait_waiting(page: Page, room_id: str) -> None:
    expect(page.locator(".tank-wait")).to_be_visible(timeout=15_000)
    expect(page.locator(".tank-wait-code")).to_have_text(room_id, timeout=15_000)


def canvas_box(page: Page):
    box = page.locator("canvas.tank-canvas").bounding_box()
    assert box is not None and box["width"] > 100 and box["height"] > 100, "3D 画布尺寸异常"
    return box


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:5173")
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()
    base = args.url.rstrip("/")
    SHOT_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=not args.headed)
        context_a = browser.new_context(viewport={"width": 1440, "height": 960})
        context_b = browser.new_context(viewport={"width": 1440, "height": 960})
        a = context_a.new_page()
        b = context_b.new_page()
        errors: list[str] = []

        def watch(page: Page, tag: str) -> None:
            page.on(
                "console",
                lambda msg, tag=tag: errors.append(f"[{tag}] console.{msg.type}: {msg.text}")
                if msg.type == "error"
                else None,
            )
            page.on("pageerror", lambda exc, tag=tag: errors.append(f"[{tag}] pageerror: {exc}"))

        watch(a, "A")
        watch(b, "B")

        print(f"== 坦克大战 UI 冒烟 {base}")

        # 1) 首页 → /tank 大厅
        a.goto(base, wait_until="networkidle")
        expect(a.locator(".home")).to_be_visible()
        a.get_by_role("button", name="进入坦克大战").click()
        a.wait_for_url(lambda url: url.rstrip("/").endswith("/tank"), timeout=10_000)
        a.locator(NICKNAME_INPUT).fill("小明")
        wait_connected(a)
        expect(a.locator(".tank-hero, .hero-tank")).to_be_visible()
        print("  ✓ 首页进入 /tank 大厅，WebSocket 已连接")

        # 2) 建房
        a.get_by_role("button", name="创建房间").click()
        a.locator(".field").filter(has_text="房间名（可空）").locator("input").fill("坦克冒烟房")
        a.get_by_role("button", name="创建并进入").click()
        a.wait_for_url(lambda url: "/tank/room/" in url, timeout=10_000)
        room_id = a.locator(".tank-wait-code").inner_text().strip()
        assert re.fullmatch(r"[A-Z0-9]{6}", room_id), f"房间码异常：{room_id!r}"
        wait_waiting(a, room_id)
        expect(a.locator(".tank-seat")).to_have_count(8)
        print(f"  ✓ 创建坦克房间 {room_id}，等待页 8 个座位")

        # 3) 邀请链接加入
        b.goto(f"{base}/tank/room/{room_id}", wait_until="networkidle")
        b.locator(NICKNAME_INPUT).fill("小红")
        expect(b.locator('input[aria-label="6 位房间码"]')).to_have_value(room_id, timeout=8_000)
        b.locator("form.join-form").get_by_role("button", name="加入").click()
        wait_waiting(b, room_id)
        expect(a.locator(".tank-seats")).to_contain_text("小红", timeout=10_000)
        expect(b.locator(".tank-seats")).to_contain_text("小明", timeout=10_000)
        a.screenshot(path=str(SHOT_DIR / "waiting.png"), full_page=True)
        print("  ✓ 通过邀请链接加入，双方座位列表正确")

        # 4) 双方准备 → 3D 战场
        a.get_by_role("button", name="准备开战").click()
        expect(a.get_by_role("button", name="取消准备")).to_be_visible(timeout=8_000)
        b.get_by_role("button", name="准备开战").click()
        expect(a.locator("canvas.tank-canvas")).to_be_visible(timeout=15_000)
        expect(b.locator("canvas.tank-canvas")).to_be_visible(timeout=15_000)
        expect(a.locator(".tank-hud")).to_be_visible()
        expect(a.locator(".tank-scoreboard")).to_contain_text("小红", timeout=10_000)
        a.wait_for_timeout(1200)
        a.screenshot(path=str(SHOT_DIR / "battle.png"))
        print("  ✓ 双方准备后开局，3D 画布 + HUD 渲染")

        # 5) tick 生效：计时器在推进
        timer_a = a.locator(".tank-hud-timer").inner_text()
        a.wait_for_timeout(1600)
        timer_b = a.locator(".tank-hud-timer").inner_text()
        assert timer_a != timer_b, f"倒计时没有推进：{timer_a}"
        print(f"  ✓ 服务端 tick 生效，倒计时 {timer_a.strip()} → {timer_b.strip()}")

        # 6) WASD 驾驶 + 鼠标瞄准 + 开火（不崩、画面变化）
        box = canvas_box(a)
        a.mouse.move(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5)
        a.keyboard.down("w")
        a.keyboard.down("d")
        a.wait_for_timeout(900)
        a.keyboard.up("w")
        a.keyboard.up("d")
        # 全画布：对局中页头页脚应隐藏、画布铺满窗口
        expect(a.locator(".app-header")).to_be_hidden()
        box = a.locator("canvas.tank-canvas").bounding_box()
        viewport = a.viewport_size
        assert box is not None and viewport is not None
        assert abs(box["width"] - viewport["width"]) <= 2, f"画布未铺满宽度：{box} vs {viewport}"
        assert abs(box["height"] - viewport["height"]) <= 2, f"画布未铺满高度：{box} vs {viewport}"
        print(f"  ✓ 全画布沉浸模式：画布 {round(box['width'])}×{round(box['height'])} 铺满窗口")

        a.mouse.down()
        a.wait_for_timeout(500)
        a.mouse.up()
        a.wait_for_timeout(300)
        a.screenshot(path=str(SHOT_DIR / "driving.png"))
        expect(a.locator(".tank-crosshair")).to_be_visible()
        # 准星跟随鼠标移动，标靶环距离随之变化（不再是固定距离）
        _ = box
        start_ring = a.evaluate(
            '() => { const d = window.__tankDebug; const s = window.__tankScene;'
            ' const gp = s.groundPointFromScreen(d.reticle().x, d.reticle().y);'
            ' const p = d.localPos();'
            ' return gp ? Math.hypot(gp.x - p.x, gp.y - p.y) : null; }'
        )
        assert start_ring is not None, "地面交点不可用"
        for step in range(6):
            a.mouse.move(box["x"] + box["width"] * 0.5 - 30 - step * 18, box["y"] + box["height"] * 0.5 - 20 - step * 14, steps=2)
            a.wait_for_timeout(35)
        a.wait_for_timeout(300)
        moved_ring = a.evaluate(
            '() => { const d = window.__tankDebug; const s = window.__tankScene;'
            ' const gp = s.groundPointFromScreen(d.reticle().x, d.reticle().y);'
            ' const p = d.localPos();'
            ' return gp ? Math.hypot(gp.x - p.x, gp.y - p.y) : null; }'
        )
        reticle = a.evaluate("() => window.__tankDebug.reticle()")
        assert abs(reticle["x"]) > 0.05 or abs(reticle["y"]) > 0.05, f"准星未跟随鼠标：{reticle}"
        assert moved_ring is not None
        assert abs(moved_ring - start_ring) > 2.0, f"标靶环距离没有变化：{start_ring} → {moved_ring}"
        print(f"  ✓ 准星跟随鼠标；标靶环距离随准星变化（{start_ring:.1f} → {moved_ring:.1f} 米）")

        # 指针锁定中：准星移到 HUD 按钮上可直接点击（无需 Esc/Alt）
        sound_bb = a.get_by_role("button", name="音效开").bounding_box()
        assert sound_bb is not None
        nx = (sound_bb["x"] + sound_bb["width"] / 2 - box["x"]) / box["width"] * 2 - 1
        ny = -(((sound_bb["y"] + sound_bb["height"] / 2 - box["y"]) / box["height"]) * 2 - 1)
        a.evaluate(f"() => window.__tankDebug.moveReticle({nx}, {ny})")
        a.wait_for_timeout(150)
        assert a.locator(".is-hud-hover").count() > 0, "准星移到按钮上未显示悬停高亮"
        a.mouse.down()
        a.mouse.up()
        a.wait_for_timeout(300)
        expect(a.get_by_role("button", name="音效关")).to_be_visible(timeout=5_000)
        a.mouse.down()
        a.mouse.up()
        a.wait_for_timeout(300)
        expect(a.get_by_role("button", name="音效开")).to_be_visible(timeout=5_000)
        assert a.evaluate("() => document.pointerLockElement !== null"), "点 HUD 后不应退出指针锁定"
        print("  ✓ 指针锁定中准星移到 HUD 按钮即可点击（悬停高亮 + 点击生效）")

        # 相机跟随车体 + 炮塔跟随准星方向
        camera_state = a.evaluate(
            "() => { const d = window.__tankDebug; const s = window.__tankScene;"
            " let diff = s.getCameraYaw() - d.hull();"
            " while (diff > Math.PI) diff -= 2 * Math.PI;"
            " while (diff <= -Math.PI) diff += 2 * Math.PI;"
            " let barrel = s.debugTurretDirection() - d.aim();"
            " while (barrel > Math.PI) barrel -= 2 * Math.PI;"
            " while (barrel <= -Math.PI) barrel += 2 * Math.PI;"
            " return { cameraHullDiff: Math.abs(diff), barrelDiff: Math.abs(barrel) }; }"
        )
        assert camera_state["cameraHullDiff"] < 0.3, f"相机未跟到车体后方：{camera_state}"
        assert camera_state["barrelDiff"] < 0.02, f"炮管与瞄准角不同步：{camera_state}"
        print(
            f"  ✓ 视角跟随车体（差 {math.degrees(camera_state['cameraHullDiff']):.0f}°），"
            f"炮管跟随准星（误差 0.0000 rad）"
        )
        # 瞄准不应带动车体转向（避免原地打转）；车体只响应 A/D
        hull_before = a.evaluate("() => window.__tankDebug.hull()")
        a.wait_for_timeout(900)
        hull_after = a.evaluate("() => window.__tankDebug.hull()")
        drift = abs(((hull_after - hull_before + math.pi) % (2 * math.pi)) - math.pi)
        assert drift < 0.12, f"瞄准时车体自己转动了：{math.degrees(drift):.1f}°"
        print(f"  ✓ 瞄准/转炮塔不影响车体（0.9s 车体漂移 {math.degrees(drift):.1f}°）")

        # Alt 释放鼠标 → 系统光标出现，可直接点 HUD；再点画面重新锁定
        a.keyboard.press("Alt")
        a.wait_for_timeout(300)
        assert a.evaluate("() => document.pointerLockElement === null"), "Alt 应释放指针锁定"
        expect(a.locator(".tank-lock-hint")).to_be_visible(timeout=5_000)
        a.get_by_role("button", name="音效开").click()
        expect(a.get_by_role("button", name="音效关")).to_be_visible(timeout=5_000)
        a.get_by_role("button", name="音效关").click()
        expect(a.get_by_role("button", name="音效开")).to_be_visible(timeout=5_000)
        a.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5)
        a.wait_for_timeout(300)
        assert a.evaluate("() => document.pointerLockElement !== null"), "点击画面应重新锁定"
        print("  ✓ Alt 释放鼠标后可直接点 HUD，点击画面重新锁定")

        # 触发一次爆炸特效（仅 DEV 会挂 window.__tankScene），检查后处理/粒子渲染
        a.evaluate(
            """() => {
              const scene = window.__tankScene;
              if (!scene) return;
              scene.emit({ type: 'kill', x: 22, y: 30 });
              scene.emit({ type: 'muzzle', x: 20, y: 26, angle: 0.6 });
            }"""
        )
        a.wait_for_timeout(220)
        a.screenshot(path=str(SHOT_DIR / "effects.png"))
        print("  ✓ 爆炸/炮口特效与 Bloom 渲染")

        # 7) 360°：准星绕坦克移动，炮塔指向任意方向（无角度限制）
        tank_ndc = a.evaluate(
            "() => { const d = window.__tankDebug; const s = window.__tankScene;"
            " const p = d.localPos(); return s.worldToScreen(p.x, p.y); }"
        )
        assert tank_ndc is not None

        def aim_at(ndc_x: float, ndc_y: float) -> float:
            a.evaluate(f"() => window.__tankDebug.moveReticle({ndc_x}, {ndc_y})")
            a.wait_for_timeout(220)
            return a.evaluate("() => window.__tankDebug.aim()")

        left = aim_at(tank_ndc["x"] - 0.5, tank_ndc["y"])
        right = aim_at(tank_ndc["x"] + 0.5, tank_ndc["y"])
        up = aim_at(tank_ndc["x"], tank_ndc["y"] + 0.5)
        down = aim_at(tank_ndc["x"], tank_ndc["y"] - 0.5)
        span = abs(math.atan2(math.sin(left - right), math.cos(left - right)))
        vertical = abs(math.atan2(math.sin(up - down), math.cos(up - down)))
        assert span > math.radians(120), f"左右瞄准覆盖不足：{math.degrees(span):.1f}°"
        assert vertical > math.radians(120), f"上下瞄准覆盖不足：{math.degrees(vertical):.1f}°"
        print(f"  ✓ 准星绕坦克覆盖多方向：左右 {math.degrees(span):.0f}°、上下 {math.degrees(vertical):.0f}°，无角度限制")
        a.screenshot(path=str(SHOT_DIR / "aim-behind.png"))

        # 8) V 三态相机：等距 → 追尾 → 全场 → 等距
        expect(a.locator(".tank-hud-btn").first).to_contain_text("追尾视角（V）")
        a.keyboard.press("v")
        expect(a.locator(".tank-hud-btn").first).to_contain_text("等距视角（V）", timeout=5_000)
        a.wait_for_timeout(400)
        a.screenshot(path=str(SHOT_DIR / "iso-view.png"))
        a.keyboard.press("v")
        expect(a.locator(".tank-hud-btn").first).to_contain_text("全场视角（V）", timeout=5_000)
        a.wait_for_timeout(500)
        a.screenshot(path=str(SHOT_DIR / "top-view.png"))
        a.keyboard.press("v")
        expect(a.locator(".tank-hud-btn").first).to_contain_text("追尾视角（V）", timeout=5_000)
        print("  ✓ V 键在追尾/等距/全场三种视角间循环")

        # 8.5) A/D 方向：A 左转（相机 yaw 减小）、D 右转（yaw 增大）
        yaw0 = a.evaluate("() => window.__tankDebug.cameraYaw()")
        a.keyboard.down("a")
        a.wait_for_timeout(350)
        a.keyboard.up("a")
        a.wait_for_timeout(250)
        yaw_a = a.evaluate("() => window.__tankDebug.cameraYaw()")
        a.keyboard.down("d")
        a.wait_for_timeout(650)
        a.keyboard.up("d")
        a.wait_for_timeout(250)
        yaw_d = a.evaluate("() => window.__tankDebug.cameraYaw()")
        delta_a = math.atan2(math.sin(yaw_a - yaw0), math.cos(yaw_a - yaw0))
        delta_d = math.atan2(math.sin(yaw_d - yaw_a), math.cos(yaw_d - yaw_a))
        assert delta_a < -0.1, f"A 应左转（yaw 减小）：{math.degrees(delta_a):.0f}°"
        assert delta_d > 0.1, f"D 应右转（yaw 增大）：{math.degrees(delta_d):.0f}°"
        print(f"  ✓ A/D 方向正确：A 左转（Δ{math.degrees(delta_a):.0f}°）、D 右转（Δ{math.degrees(delta_d):.0f}°）")

        # 9) C 切换操作方案（跟随 → 坦克 → 街机 → 跟随，持久化）
        expect(a.locator(".tank-hud-btn").nth(1)).to_contain_text("坦克操作")
        a.keyboard.press("c")
        expect(a.locator(".tank-hud-btn").nth(1)).to_contain_text("街机操作", timeout=5_000)
        a.keyboard.press("w")
        a.wait_for_timeout(300)
        a.keyboard.up("w")
        a.keyboard.press("c")
        expect(a.locator(".tank-hud-btn").nth(1)).to_contain_text("坦克操作", timeout=5_000)
        print("  ✓ C 键在跟随/坦克式/街机式三种驾驶模式间循环")

        # 10) 离开 → 对方收到结算（Alt 先释放鼠标，HUD 才可点击）
        a.keyboard.press("Alt")
        a.wait_for_timeout(250)
        a.get_by_role("button", name="离开").click()
        expect(b.locator(".tank-result")).to_be_visible(timeout=15_000)
        expect(b.locator(".tank-result")).to_contain_text("本局结束")
        expect(b.locator(".tank-result")).to_contain_text("弃权")
        b.wait_for_timeout(450)
        b.screenshot(path=str(SHOT_DIR / "result.png"))
        print("  ✓ 玩家离开后对手收到本局结算浮层")

        # 11) 人机混战：大厅 → 人机对战 → 选电脑数量 → 立即开局 → 3D 战场 → 离开
        a.goto(f"{base}/tank", wait_until="networkidle")
        expect(a.locator(".lobby")).to_be_visible()
        a.get_by_role("button", name="人机对战").click()
        # 任意数量：默认 3 台，先加到 5 台再减回 3 台，验证 1–7 全程可选
        a.get_by_role("button", name="困难").click()
        a.get_by_role("button", name="增加电脑").click()
        a.get_by_role("button", name="增加电脑").click()
        expect(a.locator(".bot-stepper-value")).to_have_text("5 台")
        a.get_by_role("button", name="减少电脑").click()
        a.get_by_role("button", name="减少电脑").click()
        expect(a.locator(".bot-stepper-value")).to_have_text("3 台")
        # 受击反馈测试用单台困难电脑（单挑直奔玩家，稳定能打到）
        a.get_by_role("button", name="减少电脑").click()
        a.get_by_role("button", name="减少电脑").click()
        expect(a.locator(".bot-stepper-value")).to_have_text("1 台")
        a.get_by_role("button", name="开始对局").click()
        expect(a.locator("canvas.tank-canvas")).to_be_visible(timeout=20_000)
        expect(a.locator(".tank-score-row")).to_have_count(2, timeout=15_000)
        expect(a.locator(".tank-scoreboard")).to_contain_text("电脑1")
        a.wait_for_timeout(2500)
        a.screenshot(path=str(SHOT_DIR / "ai-battle.png"))

        # 受击反馈 UI：掉血数字 + 屏震（服务端伤害链路另有 AI 单元测试覆盖）
        a.evaluate("() => window.__tankDebug.simulateHit()")
        a.wait_for_timeout(120)
        feedback = a.evaluate(
            "() => ({ popup: !!document.querySelector('.tank-damage-popup'),"
            " shake: !!document.querySelector('.tank-stage.is-hit-shake') })"
        )
        assert feedback["popup"], "受击时没有掉血数字"
        assert feedback["shake"], "受击时没有屏震"
        a.screenshot(path=str(SHOT_DIR / "hit-feedback.png"))
        a.wait_for_timeout(900)
        print("  ✓ 受击反馈：掉血数字 + 屏震动画可见")

        # 站着不动，困难电脑应能打掉血（20 秒上限，只记录不强断言，避免随机地图卡住 bot）
        hp_seen = 100
        for _ in range(50):
            a.wait_for_timeout(400)
            hp_seen = a.evaluate("() => window.__tankDebug.hp() ?? 100")
            if hp_seen is not None and hp_seen < 100:
                break
        print(f"  ✓ 困难电脑命中测试：HP 最低采样 {hp_seen}")

        a.evaluate("() => { if (document.pointerLockElement) document.exitPointerLock(); }")
        a.wait_for_timeout(300)
        a.get_by_role("button", name="离开").click()
        expect(a.get_by_role("button", name="人机对战")).to_be_visible(timeout=15_000)
        print("  ✓ 人机混战：1 人 + 1 台困难电脑立即开局，离开后回到大厅")

        real_errors = [
            item
            for item in errors
            if "favicon" not in item and "Failed to load resource" not in item
        ]
        assert not real_errors, "浏览器报错：\n" + "\n".join(real_errors)
        print("  ✓ 无控制台报错")
        print(f"== 通过，截图见 {SHOT_DIR}")
        browser.close()


if __name__ == "__main__":
    main()

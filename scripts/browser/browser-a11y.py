"""P4–P7 的浏览器验收：快捷键开关、aria-busy、焦点续接、太短提示。

用 async API：G4 要把 DELETE 延迟，同步 route 回调会阻塞整个脚本。
"""
import asyncio
import os
import re
import sqlite3
import sys

from playwright.async_api import async_playwright

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:3000")
DB = os.environ.get(
    "DB_PATH", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "app.db"))
)
ROWS = "aside[aria-label='片段'] li"

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + ((" | " + str(detail)) if detail else ""))


def alice_task():
    with sqlite3.connect(DB) as con:
        return con.execute(
            "SELECT t.id FROM tasks t JOIN users u ON u.id = t.claimed_by "
            "WHERE u.username = 'alice' AND t.status = 'claimed' LIMIT 1"
        ).fetchone()[0]


def segment_ids(task_id):
    with sqlite3.connect(DB) as con:
        return [
            row[0]
            for row in con.execute(
                "SELECT id FROM segments WHERE task_id = ? ORDER BY start_ms", (task_id,)
            )
        ]


async def create_segment(page, task_id, start_ms, end_ms):
    return await page.evaluate(
        """async ([url, body]) => {
            const r = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            return r.status;
        }""",
        [f"/api/tasks/{task_id}/segments", {"startMs": start_ms, "endMs": end_ms}],
    )


async def delete_all(page, task_id):
    for sid in segment_ids(task_id):
        await page.evaluate(
            """async (url) => {
                const r = await fetch(url, { method: 'DELETE' });
                return r.status;
            }""",
            f"/api/tasks/{task_id}/segments/{sid}",
        )


async def open_workbench(page, task_id):
    await page.goto(f"{BASE}/tasks/{task_id}/work", wait_until="domcontentloaded")
    await page.wait_for_selector("video")
    await page.wait_for_timeout(1200)


async def main():
    task_id = alice_task()

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True, args=["--autoplay-policy=no-user-gesture-required"]
        )
        ctx = await browser.new_context(viewport={"width": 1440, "height": 1000})
        page = await ctx.new_page()

        await page.goto(BASE + "/login", wait_until="domcontentloaded")
        await page.fill("#username", "alice")
        await page.fill("#password", "demo123")
        await page.click("button[type=submit]")
        await page.wait_for_url("**/tasks**", timeout=15000)
        await open_workbench(page, task_id)

        # ── P4：关掉单字符快捷键 ─────────────────────────────
        toggle = page.get_by_role("checkbox")
        check("页脚有单字符快捷键开关", await toggle.count() == 1)
        check("默认开启", await toggle.is_checked())

        posts = []
        page.on(
            "request",
            lambda r: posts.append(r.url)
            if r.method == "POST" and "/segments" in r.url
            else None,
        )

        await toggle.click()
        check("点击后关闭", not await toggle.is_checked())
        # 焦点要离开 checkbox：否则下面按空格会被浏览器当成「切换勾选框」，
        # 测到的不是快捷键而是原生控件行为
        await page.evaluate("document.activeElement && document.activeElement.blur()")
        await page.wait_for_timeout(150)

        await page.keyboard.press("Space")
        await page.wait_for_timeout(500)
        paused_after_space = await page.evaluate("document.querySelector('video').paused")
        check("关闭后空格不播放", paused_after_space is True)

        await page.keyboard.press("i")
        await page.evaluate("document.querySelector('video').currentTime = 3")
        await page.wait_for_timeout(200)
        await page.keyboard.press("o")
        await page.wait_for_timeout(600)
        check("关闭后 I / O 不创建片段", len(posts) == 0, len(posts))

        await page.reload(wait_until="domcontentloaded")
        await page.wait_for_selector("video")
        await page.wait_for_selector("input[type=checkbox]")
        # 偏好是在挂载后的 effect 里读的，给 hydration 留时间；轮询而不是固定睡
        persisted = True
        for _ in range(20):
            if not await page.get_by_role("checkbox").is_checked():
                persisted = False
                break
            await page.wait_for_timeout(250)
        check(
            "刷新后仍是关闭",
            persisted is False,
            await page.get_by_role("checkbox").is_checked(),
        )

        # ── 重新开启：空格能播放 ─────────────────────────────
        await page.get_by_role("checkbox").click()
        await page.evaluate("document.activeElement && document.activeElement.blur()")
        await page.wait_for_timeout(150)
        await page.keyboard.press("Space")
        await page.wait_for_timeout(700)
        playing = not await page.evaluate("document.querySelector('video').paused")
        check("重新开启后空格能播放", playing)
        await page.evaluate("document.querySelector('video').pause()")

        # ── 造三段，测 G4 / G5 ───────────────────────────────
        for start, end in [(12_000, 14_000), (14_000, 16_000), (18_000, 20_000)]:
            status = await create_segment(page, task_id, start, end)
            if status != 200:
                check("造片段失败", False, status)
        await open_workbench(page, task_id)
        rows = page.locator(ROWS)
        check("现在有 4 段", await rows.count() == 4, await rows.count())
        # 删第 2 段；删除后焦点应落到原第 3 段（14–16s）
        expected_focus = await rows.nth(2).inner_text()

        async def delay_delete(route):
            if route.request.method == "DELETE":
                await asyncio.sleep(1.5)
            await route.continue_()

        pattern = re.compile(r".*/api/tasks/.*/segments.*")
        await ctx.route(pattern, delay_delete)

        delete_button = rows.nth(1).locator("button").last
        await delete_button.click()
        await page.wait_for_timeout(300)
        busy = await delete_button.get_attribute("aria-busy")
        label = await delete_button.get_attribute("aria-label")
        check("删除中 aria-busy=true", busy == "true", busy)
        check("删除中 label 带「删除中」", "删除中" in (label or ""), label)
        status_during = await page.locator("#workbench-status").inner_text()
        check("删除中状态行播报「正在删除」", "正在删除" in status_during, status_during)

        await page.wait_for_timeout(1600)
        check("删除完成，剩 3 段", await rows.count() == 3, await rows.count())
        focused = await page.evaluate(
            """() => {
                const el = document.activeElement;
                return {
                    tag: el ? el.tagName : 'none',
                    text: el ? el.innerText : '',
                    inList: !!(el && el.closest("aside[aria-label='片段']")),
                };
            }"""
        )
        check(
            "焦点落到下一段的选中按钮",
            focused["tag"] == "BUTTON" and focused["inList"] and expected_focus.split("\n")[1] in focused["text"],
            focused,
        )

        await ctx.unroute(pattern)

        # ── G5：删最后一段，焦点落到空态 ─────────────────────
        await delete_all(page, task_id)
        await open_workbench(page, task_id)
        check("清空后 0 段", await page.locator(ROWS).count() == 0)
        status = await create_segment(page, task_id, 25_000, 27_000)
        check("重建唯一一段", status == 200, status)
        await open_workbench(page, task_id)
        await page.locator(ROWS).first.locator("button").last.click()
        await page.wait_for_timeout(800)
        empty_focus = await page.evaluate(
            """() => {
                const el = document.activeElement;
                return { tag: el ? el.tagName : 'none', tabindex: el ? el.getAttribute('tabindex') : null, text: el ? el.innerText : '' };
            }"""
        )
        check(
            "删空后焦点在空态文本上",
            empty_focus["tag"] == "P" and empty_focus["tabindex"] == "-1" and "还没有片段" in empty_focus["text"],
            empty_focus,
        )

        # ── P7：太短提示 ─────────────────────────────────────
        posts.clear()
        await page.keyboard.press("i")
        await page.evaluate("document.querySelector('video').currentTime = 0.05")
        await page.wait_for_timeout(200)
        await page.keyboard.press("o")
        await page.wait_for_timeout(600)
        hint_text = await page.locator("#workbench-status").inner_text()
        check("太短时出现提示", "太短" in hint_text and "入点还在" in hint_text, hint_text)
        check("太短时不发 POST", len(posts) == 0, len(posts))

        # 挪远一点再按 O：应该成功，提示消失
        await page.evaluate("document.querySelector('video').currentTime = 2.5")
        await page.wait_for_timeout(200)
        async with page.expect_response(
            lambda r: r.request.method == "POST" and "/segments" in r.url, timeout=10000
        ) as created:
            await page.keyboard.press("o")
        check("挪远后按 O 成功", (await created.value).status == 200)
        await page.wait_for_timeout(500)
        after_text = await page.locator("#workbench-status").inner_text()
        check("成功后提示消失", "太短" not in after_text, after_text)
        check("成功后多一段", await page.locator(ROWS).count() == 1)

        await ctx.close()
        await browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} 项通过")
    return 1 if failed else 0


sys.exit(asyncio.run(main()))

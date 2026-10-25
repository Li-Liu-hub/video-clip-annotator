"""P1–P3 的浏览器验收：标签保真、并发删除守卫、相邻描边层级。

与 browser-check.py 分开：这里要用「延迟 DELETE」把在途窗口拉长，
同步 API 的 route 回调会阻塞整个脚本，必须用 async API。
"""
import asyncio
import os
import re
import sqlite3
import sys
import tempfile

from playwright.async_api import async_playwright

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:3000")
DB = os.environ.get(
    "DB_PATH", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "app.db"))
)
SHOT_DIR = os.environ.get("SHOT_DIR", tempfile.gettempdir())
os.makedirs(SHOT_DIR, exist_ok=True)

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


def segment_labels(task_id):
    with sqlite3.connect(DB) as con:
        return [row[0] for row in con.execute(
            "SELECT label FROM segments WHERE task_id = ? ORDER BY start_ms", (task_id,)
        )]


async def create_segment(page, task_id, start_ms, end_ms):
    """用页面内的 fetch 建片段：ctx.request 不共享页面 cookie，会拿到 401。"""
    return await page.evaluate(
        """async ([url, body]) => {
            const r = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            return { status: r.status, text: await r.text() };
        }""",
        [f"/api/tasks/{task_id}/segments", {"startMs": start_ms, "endMs": end_ms}],
    )


async def drag(page, x_ratio1, x_ratio2):
    track = page.locator("div.touch-none").first
    await track.scroll_into_view_if_needed()
    await page.wait_for_timeout(250)
    box = await track.bounding_box()
    y = box["y"] + box["height"] / 2
    x1 = box["x"] + box["width"] * x_ratio1
    x2 = box["x"] + box["width"] * x_ratio2
    await page.mouse.move(x1, y)
    await page.mouse.down()
    await page.mouse.move(x1 + 4, y, steps=2)
    await page.mouse.move(x2, y, steps=10)
    await page.mouse.up()


async def main():
    task_id = alice_task()
    rows = "aside[aria-label='片段'] li"

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        ctx = await browser.new_context(viewport={"width": 1440, "height": 1000})
        page = await ctx.new_page()

        # 表单登录：不依赖构建时的演示按钮开关
        await page.goto(BASE + "/login", wait_until="domcontentloaded")
        await page.fill("#username", "alice")
        await page.fill("#password", "demo123")
        await page.click("button[type=submit]")
        await page.wait_for_url("**/tasks**", timeout=15000)
        check("alice 登录后进入任务列表", "/tasks" in page.url, page.url)

        await page.goto(f"{BASE}/tasks/{task_id}/work", wait_until="domcontentloaded")
        await page.wait_for_selector("video")
        await page.wait_for_timeout(1500)
        check("片段列表初始为 1 段", await page.locator(rows).count() == 1)

        # ── P1a：拖动替换后 label 仍在 ─────────────────────────
        block = page.locator("div[title]").first
        box = await block.bounding_box()
        await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        async with page.expect_response(
            lambda r: r.request.method == "POST" and "/segments" in r.url, timeout=15000
        ) as moved:
            await page.mouse.down()
            await page.mouse.move(box["x"] + box["width"] / 2 + 60, box["y"] + box["height"] / 2, steps=10)
            await page.mouse.up()
        check("拖动已存在的片段成功", (await moved.value).status == 200, (await moved.value).status)
        await page.wait_for_timeout(500)
        row_text = await page.locator(rows).first.inner_text()
        check("拖动后 label 仍在", "有效操作" in row_text, row_text.replace("\n", " | "))
        check("拖动后库里的 label 仍在", "有效操作" in segment_labels(task_id), segment_labels(task_id))

        # ── P1b：删除后 Ctrl+Z，label 回来 ────────────────────
        await page.locator(rows).first.locator("button").first.click()
        async with page.expect_response(
            lambda r: r.request.method == "DELETE" and "/segments/" in r.url, timeout=15000
        ) as deleted:
            await page.keyboard.press("Delete")
        check("删除片段 200", (await deleted.value).status == 200, (await deleted.value).status)
        await page.wait_for_timeout(400)
        check("删除后列表为空", await page.locator(rows).count() == 0)

        async with page.expect_response(
            lambda r: r.request.method == "POST" and "/segments" in r.url, timeout=15000
        ) as undone:
            await page.keyboard.press("Control+z")
        check("撤销删除 200", (await undone.value).status == 200, (await undone.value).status)
        await page.wait_for_timeout(500)
        restored = await page.locator(rows).first.inner_text()
        check("撤销后 label 回来", "有效操作" in restored, restored.replace("\n", " | "))
        check("撤销后库里的 label 回来", "有效操作" in segment_labels(task_id), segment_labels(task_id))

        # ── P2：删除在途时拖拽必须被挡 ─────────────────────────
        # 先补第二段（20–22s），让「删一段、拖空白」两件事同时存在
        second = await create_segment(page, task_id, 20_000, 22_000)
        check("补第二段（页面内 fetch）", second["status"] == 200, second)
        await page.reload(wait_until="domcontentloaded")
        await page.wait_for_selector("video")
        await page.wait_for_timeout(1200)

        posts = []
        deletes = []

        def on_request(request):
            if "/segments" not in request.url:
                return
            if request.method == "POST":
                posts.append(request.url)
            if request.method == "DELETE":
                deletes.append(request.url)

        page.on("request", on_request)

        async def delay_delete(route):
            if route.request.method == "DELETE":
                await asyncio.sleep(2.0)
            await route.continue_()

        pattern = re.compile(r".*/api/tasks/.*/segments.*")
        await ctx.route(pattern, delay_delete)

        # 点第一段选中，再按 Delete：DELETE 被挂起 2 秒
        await page.locator(rows).first.locator("button").first.click()
        await page.keyboard.press("Delete")
        await page.wait_for_timeout(250)
        posts_before = len(posts)

        # 在途窗口里在空白处拖出一段
        await drag(page, 0.85, 0.95)
        await page.wait_for_timeout(500)
        guard_text = await page.locator("#workbench-status").inner_text()
        check("删除在途时没有发出 POST", len(posts) == posts_before, (posts_before, len(posts)))
        check("界面提示「正在删除片段」", "正在删除片段" in guard_text, guard_text)

        # 等删除完成，确认窗口确实存在过（DELETE 1 次）
        await page.wait_for_timeout(2200)
        check("DELETE 恰好 1 次", len(deletes) == 1, len(deletes))
        check("删除后只剩 1 段", await page.locator(rows).count() == 1, await page.locator(rows).count())

        # 守卫放开后重试：POST 必须真的发出去，证明上一步不是「拖拽坏了」
        await ctx.unroute(pattern)
        async with page.expect_response(
            lambda r: r.request.method == "POST" and "/segments" in r.url, timeout=15000
        ) as retried:
            await drag(page, 0.85, 0.95)
        check("删除完成后重试拖拽 200", (await retried.value).status == 200, (await retried.value).status)
        await page.wait_for_timeout(500)
        check("重试后列表变成 2 段", await page.locator(rows).count() == 2, await page.locator(rows).count())

        # ── P3：相邻色块，选中环的层级 ─────────────────────────
        # 现有两段：20–22 与 25.5–28.5；补一段 22–24 变成首尾相接
        adjacent = await create_segment(page, task_id, 22_000, 24_000)
        check("补相邻段（页面内 fetch）", adjacent["status"] == 200, adjacent)
        await page.reload(wait_until="domcontentloaded")
        await page.wait_for_selector("video")
        await page.wait_for_timeout(1200)

        # 点第一行（20–22），时间轴上对应块应带 ring-ink
        await page.locator(rows).first.locator("button").first.click()
        await page.wait_for_timeout(400)
        z_selected = await page.eval_on_selector(
            "div.ring-ink", "el => getComputedStyle(el).zIndex"
        )
        z_sibling = await page.evaluate(
            """() => {
                const blocks = [...document.querySelectorAll('div[title]')];
                const other = blocks.find((el) => !el.className.includes('ring-ink'));
                return other ? getComputedStyle(other).zIndex : 'missing';
            }"""
        )
        check("选中块 z-index = 10", z_selected == "10", z_selected)
        check("未选中的兄弟块仍是 auto", z_sibling == "auto", z_sibling)
        await page.screenshot(path=os.path.join(SHOT_DIR, "ring-selected.png"))

        await ctx.close()
        await browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} 项通过")
    return 1 if failed else 0


sys.exit(asyncio.run(main()))

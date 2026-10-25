"""浏览器层验收：演示账号一键进入、工作台视频、删除 + 撤销。

前两项此前只有 HTTP/单元覆盖；第三项（撤销方向）是 REPORT 里明确记录的测试盲区 ——
单测把栈操作测穿了，但「调用点传的是操作前还是操作后」只有真点一次才知道。

用法：服务已启动在 3000，且用 DEMO_LOGIN=1 建库、NEXT_PUBLIC_DEMO_LOGIN=1 构建。
"""
import os
import sqlite3
import sys
import tempfile

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:3000")
DB = os.environ.get(
    "DB_PATH", os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "app.db"))
)
SHOT_DIR = os.environ.get("SHOT_DIR", tempfile.gettempdir())
os.makedirs(SHOT_DIR, exist_ok=True)


def login(page, username, password, demo_name):
    """优先点演示按钮；默认构建没有这块 UI，回落到表单。"""
    page.goto(BASE + "/login", wait_until="domcontentloaded")
    demo = page.get_by_role("button", name=demo_name)
    if demo.count() > 0:
        demo.click()
        return "demo"
    page.fill("#username", username)
    page.fill("#password", password)
    page.click("button[type=submit]")
    return "form"


# 任务 id 每次 seed 随机，不能写死；取 alice 已领取的那条（种子固定造一条）
with sqlite3.connect(DB) as con:
    TASK_ID = con.execute(
        "SELECT t.id FROM tasks t JOIN users u ON u.id = t.claimed_by "
        "WHERE u.username = 'alice' AND t.status = 'claimed' LIMIT 1"
    ).fetchone()[0]

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + ((" | " + str(detail)) if detail else ""))


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    # ── 1. admin 登录 → 管理台（演示按钮或表单）──────────────
    ctx = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = ctx.new_page()
    mode = login(page, "admin", "admin123", "平台管理员")
    try:
        page.wait_for_url("**/admin**", timeout=15000)
        landed = "/admin" in page.url
    except Exception:
        landed = False
    check(f"admin 登录后进入管理台（{mode}）", landed, page.url)
    check("管理台页面有内容", "管理" in page.inner_text("body"), page.url)
    ctx.close()

    # ── 2. alice 登录 → 任务列表（演示按钮或表单）────────────
    ctx = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = ctx.new_page()
    mode = login(page, "alice", "demo123", "林小雨")
    try:
        page.wait_for_url("**/tasks**", timeout=15000)
        landed = "/tasks" in page.url
    except Exception:
        landed = False
    check(f"alice 登录后进入任务列表（{mode}）", landed, page.url)

    # ── 3. 工作台：视频经鉴权路由加载 ────────────────────────
    stream_responses = []
    page.on(
        "response",
        lambda r: stream_responses.append((r.url.split("/")[-1][:8], r.status))
        if "/stream" in r.url
        else None,
    )
    page.goto(f"{BASE}/tasks/{TASK_ID}/work", wait_until="domcontentloaded")
    page.wait_for_selector("video", timeout=15000)
    page.wait_for_timeout(2500)  # 给 preload=metadata 的 Range 请求留时间

    check("工作台有 <video>", page.locator("video").count() == 1)
    check("视频请求走 /stream 且非 404", any(s in (200, 206) for _, s in stream_responses), stream_responses)
    check(
        "没有出现「视频加载失败」",
        page.get_by_text("视频加载失败").count() == 0,
        page.locator("section[aria-label='视频']").inner_text()[:80],
    )
    duration = page.evaluate("document.querySelector('video').duration")
    print(f"     info 浏览器读到的 duration = {duration}")
    check("页面是只写模式（有删除按钮）", page.get_by_role("button", name="删除第 1 段").count() == 1)

    # ── 4. 拖拽创建 → Ctrl+Z：验证撤销方向（REPORT 风险 1 的盲区）──
    rows = page.locator("aside[aria-label='片段'] li")
    before_count = rows.count()
    before_text = rows.first.inner_text()
    check("片段列表非空", before_count >= 1, before_count)

    track = page.locator("div.touch-none").first
    # 默认视口 720 高时轨道在折叠线以下，鼠标坐标落在视口外 → 拖拽不触发任何事件
    track.scroll_into_view_if_needed()
    page.wait_for_timeout(300)
    box = track.bounding_box()
    y = box["y"] + box["height"] / 2
    # 60%–70% 落在空白处（种子段在 5.1–10.8s），避免与既有片段重叠
    x1 = box["x"] + box["width"] * 0.60
    x2 = box["x"] + box["width"] * 0.70
    page.mouse.move(x1, y)
    with page.expect_response(
        lambda r: "/segments" in r.url and r.request.method == "POST", timeout=15000
    ) as create_info:
        page.mouse.down()
        page.mouse.move(x2, y, steps=8)
        page.mouse.up()
    check("拖拽创建片段 200", create_info.value.status == 200, create_info.value.status)
    page.wait_for_timeout(500)
    after_create = rows.count()
    check("拖拽后列表多一段", after_create == before_count + 1, (before_count, after_create))

    with page.expect_response(
        lambda r: "/segments/" in r.url and r.request.method == "DELETE", timeout=15000
    ) as undo_create:
        page.keyboard.press("Control+z")
    check("Ctrl+Z 撤销创建 200", undo_create.value.status == 200, undo_create.value.status)
    page.wait_for_timeout(600)
    after_undo_create = rows.count()
    check(
        "撤销创建后片段数回到拖拽前（方向正确）",
        after_undo_create == before_count,
        (before_count, after_undo_create),
    )
    check(
        "撤销后剩下的仍是原来那段",
        after_undo_create == 0 or rows.first.inner_text() == before_text,
        (before_text, rows.first.inner_text() if after_undo_create else ""),
    )

    # ── 5. 删除 → Ctrl+Z：撤销的另一个调用点 ─────────────────
    rows.first.locator("button").first.click()
    with page.expect_response(
        lambda r: "/segments/" in r.url and r.request.method == "DELETE", timeout=15000
    ) as del_info:
        page.keyboard.press("Delete")
    check("按 Delete 真的发出 DELETE 且 200", del_info.value.status == 200, del_info.value.status)
    page.wait_for_timeout(600)
    after_delete = rows.count()
    check("删除后列表少一段", after_delete == before_count - 1, (before_count, after_delete))

    with page.expect_response(
        lambda r: "/segments" in r.url and r.request.method == "POST", timeout=15000
    ) as undo_info:
        page.keyboard.press("Control+z")
    check("Ctrl+Z 触发重建请求且 200", undo_info.value.status == 200, undo_info.value.status)
    page.wait_for_timeout(600)
    after_undo = rows.count()
    restored_text = rows.first.inner_text() if after_undo else ""
    # 只比区间那一行：历史栈按契约只存 {startMs, endMs}，label 不参与回退
    # （见 22-undo-redo「历史栈存区间，不存 id」；label 丢失已记入 INDEX 未修项）
    def interval_of(text):
        lines = [line for line in text.splitlines() if "–" in line]
        return lines[0] if lines else ""

    check("撤销删除后片段数恢复", after_undo == before_count, (before_count, after_undo))
    check(
        "撤销删除回到同一区间（方向正确）",
        interval_of(restored_text) == interval_of(before_text),
        (before_text, restored_text),
    )
    if restored_text != before_text:
        print("     info 撤销后 label 未恢复（历史栈只存区间，契约如此）")

    page.screenshot(path=os.path.join(SHOT_DIR, "workbench-after-undo.png"), full_page=False)
    ctx.close()
    browser.close()

failed = [r for r in results if not r[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} 项通过")
sys.exit(1 if failed else 0)

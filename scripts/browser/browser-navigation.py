"""R1 独立浏览器验收：角色导航、统计往返、退出、窄屏、只读入口与视频预选。

BASE_URL 可带 basePath；runner 为每个脚本提供独立种子库与独立 Next 服务。
"""
import os
import re
import sqlite3
import sys
import time

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:3000").rstrip("/")
BASE_PATH = os.environ.get("APP_BASE_PATH", "")
DB = os.environ.get("DB_PATH")
if not DB:
    raise RuntimeError("browser-navigation.py 需要 runner 提供独立 DB_PATH")

results = []
asset_responses = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + ((" | " + str(detail)) if detail else ""))


def login(page, username, password):
    page.goto(BASE + "/login", wait_until="domcontentloaded")
    page.fill("#username", username)
    page.fill("#password", password)
    page.click("button[type=submit]")


def logout(page):
    page.get_by_role("button", name="退出").click()
    page.wait_for_url("**/login", timeout=15000)


with sqlite3.connect(DB) as con:
    video_id = con.execute("SELECT id FROM videos ORDER BY created_at DESC, id LIMIT 1").fetchone()[0]
    submitted_task = con.execute(
        "SELECT t.id FROM tasks t JOIN users u ON u.id = t.claimed_by "
        "WHERE u.username = 'alice' AND t.status = 'submitted' "
        "ORDER BY t.created_at, t.id LIMIT 1"
    ).fetchone()[0]
    tenant_id = con.execute("SELECT tenant_id FROM users WHERE username = 'alice'").fetchone()[0]
    admin_id = con.execute("SELECT id FROM users WHERE username = 'admin'").fetchone()[0]
    # PAGE_SIZE=20；alice 原有 7 条，补 16 条较新的待领取任务，使最旧提交落在第 2 页。
    now = int(time.time() * 1000)
    for index in range(16):
        con.execute(
            "INSERT INTO tasks "
            "(id, tenant_id, video_id, title, description, status, claimed_by, claimed_at, "
            "first_submitted_at, reject_reason, created_by, created_at) "
            "VALUES (?, ?, ?, ?, NULL, 'pending', NULL, NULL, NULL, NULL, ?, ?)",
            (f"{index + 1:016x}", tenant_id, video_id, f"R1 分页任务 {index}", admin_id, now + index),
        )

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)

    admin_context = browser.new_context(viewport={"width": 1440, "height": 1000})
    admin = admin_context.new_page()
    admin.on("response", lambda response: asset_responses.append(response) if "/_next/" in response.url else None)
    login(admin, "admin", "admin123")
    admin.wait_for_url("**/admin/videos", timeout=15000)
    check("管理员视频页有退出入口", admin.get_by_role("button", name="退出").count() == 1)

    create_link = admin.get_by_role("link", name="去建任务").first
    check("视频入口携带当前素材 id", f"videoId={video_id}" in (create_link.get_attribute("href") or ""))
    create_link.click()
    admin.wait_for_url("**/admin/tasks/new**")
    selected = admin.locator("button[aria-pressed='true']")
    check("合法视频 id 在新建页预选", selected.count() == 1 and video_id is not None)
    current_task = admin.get_by_role("navigation", name="管理台导航").get_by_role("link", name=re.compile("任务$"))
    check("新建任务页当前导航仍是任务", current_task.get_attribute("aria-current") == "page")

    admin.goto(f"{BASE}/admin/tasks/new?videoId=not-a-video", wait_until="domcontentloaded")
    check("失效视频 id 不错误预选", admin.locator("button[aria-pressed='true']").count() == 0)

    admin.get_by_role("navigation", name="管理台导航").get_by_role("link", name=re.compile("统计")).click()
    admin.wait_for_url("**/stats**")
    check("管理员统计页保留管理台导航", admin.get_by_role("navigation", name="管理台导航").count() == 1)
    admin.screenshot(path=os.path.join(os.environ["SHOT_DIR"], "navigation-admin-stats.png"))
    check(
        "统计日期表单 action 带部署前缀",
        admin.locator("form[method='get']").first.get_attribute("action") == f"{BASE_PATH}/stats",
        admin.locator("form[method='get']").first.get_attribute("action"),
    )
    admin.locator("header").get_by_role("link", name=re.compile("任务管理")).click()
    admin.wait_for_url("**/admin/tasks")
    check("管理员统计明确返回任务管理", admin.url.endswith("/admin/tasks"), admin.url)

    admin.set_viewport_size({"width": 375, "height": 812})
    check(
        "375px 管理台外壳无整页横向溢出",
        admin.evaluate("document.documentElement.scrollWidth <= 375"),
        admin.evaluate("document.documentElement.scrollWidth"),
    )
    check(
        "375px 账号、导航与退出可用",
        admin.get_by_role("button", name="退出").is_visible()
        and admin.get_by_role("navigation", name="管理台导航").is_visible(),
    )
    admin.screenshot(path=os.path.join(os.environ["SHOT_DIR"], "navigation-mobile.png"))
    for _ in range(8):
        admin.keyboard.press("Tab")
        if "退出" in (admin.evaluate("document.activeElement.textContent") or ""):
            break
    outline = admin.evaluate(
        """() => {
          const el = document.activeElement;
          return {
            text: el.textContent,
            visible: el.matches(':focus-visible'),
            style: getComputedStyle(el).outlineStyle,
            width: getComputedStyle(el).outlineWidth,
          };
        }"""
    )
    check(
        "键盘焦点有可见轮廓",
        "退出" in (outline["text"] or "")
        and outline["visible"]
        and outline["style"] != "none"
        and outline["width"] != "0px",
        outline,
    )

    logout(admin)
    admin.goto(f"{BASE}/admin/tasks", wait_until="domcontentloaded")
    check("管理员退出后受保护页不再使用旧会话", "/login" in admin.url, admin.url)
    admin_context.close()

    annotator_context = browser.new_context(viewport={"width": 1440, "height": 1000})
    annotator = annotator_context.new_page()
    annotator.on("response", lambda response: asset_responses.append(response) if "/_next/" in response.url else None)
    login(annotator, "alice", "demo123")
    annotator.wait_for_url("**/tasks", timeout=15000)
    annotator.get_by_role("navigation", name="标注员导航").get_by_role("link", name=re.compile("我的工作量")).click()
    annotator.wait_for_url("**/stats**")
    check("标注员统计页保留标注员导航", annotator.get_by_role("navigation", name="标注员导航").count() == 1)
    annotator.screenshot(path=os.path.join(os.environ["SHOT_DIR"], "navigation-annotator-stats.png"))
    annotator.locator("header").get_by_role("link", name=re.compile("我的任务")).click()
    annotator.wait_for_url("**/tasks")
    check("标注员统计明确返回我的任务", annotator.url.endswith("/tasks"), annotator.url)

    annotator.goto(f"{BASE}/tasks?page=2", wait_until="domcontentloaded")
    readonly_href = f"{BASE_PATH}/tasks/{submitted_task}/work?returnPage=2"
    readonly_link = annotator.locator(f'a[href="{readonly_href}"]', has_text="查看标注")
    check("本人 submitted 任务有只读入口", readonly_link.count() == 1, readonly_link.count())
    check(
        "只读入口来自第 2 页且指向目标任务",
        readonly_link.get_attribute("href") == readonly_href,
        readonly_link.get_attribute("href"),
    )
    readonly_link.click()
    annotator.wait_for_url(f"**/tasks/{submitted_task}/work**")
    check("只读工作台显示已提交仅供查看", annotator.get_by_text("已提交，仅供查看").count() == 1)
    back = annotator.locator("header").get_by_role("link", name=re.compile("任务列表"))
    check("工作台返回保留第 2 页", back.get_attribute("href") == f"{BASE_PATH}/tasks?page=2", back.get_attribute("href"))
    back.click()
    annotator.wait_for_url("**/tasks?page=2")
    check("工作台返回到原列表页码", annotator.url.endswith("/tasks?page=2"), annotator.url)

    annotator.goto(f"{BASE}/tasks/{submitted_task}/work?returnPage=0", wait_until="domcontentloaded")
    normalized_back = annotator.locator("header").get_by_role("link", name=re.compile("任务列表"))
    check("非法返回页码归一为第 1 页", normalized_back.get_attribute("href") == f"{BASE_PATH}/tasks?page=1")
    check("工作台也有退出入口", annotator.get_by_role("button", name="退出").count() == 1)
    logout(annotator)
    annotator.goto(f"{BASE}/stats", wait_until="domcontentloaded")
    check("标注员退出后统计页不再使用旧会话", "/login" in annotator.url, annotator.url)
    annotator_context.close()

    bad_assets = [r for r in asset_responses if r.status >= 400]
    check("Next 子路径资源请求无失败", len(bad_assets) == 0, [(r.url, r.status) for r in bad_assets])
    if BASE_PATH:
        wrong_prefix = [r.url for r in asset_responses if not r.url.startswith(f"{BASE}/_next/")]
        check("Next 资源全部保留 basePath", len(wrong_prefix) == 0, wrong_prefix)

    browser.close()

failed = [result for result in results if not result[1]]
print(f"\n{len(results) - len(failed)}/{len(results)} 项通过")
sys.exit(1 if failed else 0)

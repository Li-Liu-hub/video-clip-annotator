"""R2 管理闭环验收：按人明细、冻结提交片段播放、发布时查看空间任务。"""
import json
import os
import sqlite3
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ['BASE_URL'].rstrip('/')
DB = os.environ['DB_PATH']
SHOTS = Path(os.environ['SHOT_DIR'])


def check(name, condition):
    if not condition:
        raise AssertionError(name)
    print('PASS ' + name)


with sqlite3.connect(DB) as con:
    task_id, tenant_id, submission_id, frozen = con.execute(
        "SELECT t.id, t.tenant_id, s.id, s.segments_json FROM tasks t "
        "JOIN submissions s ON s.task_id = t.id AND s.superseded_by IS NULL "
        "JOIN users u ON u.id = s.annotator_id "
        "WHERE t.status = 'submitted' AND u.username = 'alice' ORDER BY s.submitted_at DESC LIMIT 1"
    ).fetchone()
    title = con.execute('SELECT title FROM tasks WHERE id = ?', (task_id,)).fetchone()[0]
    tenant_name = con.execute('SELECT name FROM tenants WHERE id = ?', (tenant_id,)).fetchone()[0]
    expected_count = con.execute('SELECT COUNT(*) FROM tasks WHERE tenant_id = ?', (tenant_id,)).fetchone()[0]
    first_segment = sorted(json.loads(frozen), key=lambda s: s['startMs'])[0]
    # 草稿故意与已提交标签不同，审核页必须仍展示冻结内容。
    con.execute("UPDATE segments SET label = '审核不应读取的草稿' WHERE task_id = ?", (task_id,))

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(BASE + '/login')
    page.locator('#username').fill('admin')
    page.locator('#password').fill('admin123')
    page.locator('button[type=submit]').click()
    page.wait_for_url('**/admin/videos')

    page.goto(BASE + '/stats?dim=annotator&from=2000-01-01&to=2099-12-31')
    check('按人视图展示日期任务及有效片段数', page.locator('thead th').all_text_contents() == [
        '姓名', '提交日期', '任务', '有效片段数', '净时长', '提交次数', '退回次数'])
    check('按人视图有多条任务明细', page.locator('tbody tr').count() >= 12)
    with page.expect_download() as download_info:
        page.get_by_role('link', name='导出 CSV').click()
    exported = Path(download_info.value.path()).read_text(encoding='utf-8-sig')
    check('按人导出包含任务片段列', '有效片段数' in exported and '任务ID' in exported)
    page.screenshot(path=str(SHOTS / 'management-stats.png'), full_page=True)

    page.goto(BASE + '/admin/tasks?status=submitted')
    row = page.locator('tbody tr').filter(has_text=title).first
    row.get_by_role('link', name='审核提交').click()
    page.wait_for_url(f'**/admin/tasks/{task_id}/review**')
    page.get_by_role('heading', name=title).wait_for()
    check('审核页从任务列表可达', page.get_by_role('heading', name=title).count() == 1)
    check('审核片段列表读取冻结快照', page.get_by_text('审核不应读取的草稿').count() == 0)
    video = page.locator('video')
    page.wait_for_function('document.querySelector("video").readyState >= 1')
    check('审核视频加载真实素材', video.evaluate('(v) => v.duration') == 30)
    check('审核使用自绘播放控件', not video.evaluate('(v) => v.controls') and page.get_by_role('button', name='播放', exact=True).count() == 1)
    video.evaluate('(v) => { v.playbackRate = 4; }')
    page.get_by_role('button', name='播放片段 1', exact=False).first.click()
    start = first_segment['startMs'] / 1000
    end = first_segment['endMs'] / 1000
    position = video.evaluate('(v) => v.currentTime')
    check('点击片段从对应起点开始播放', start <= position <= end)
    page.wait_for_function('(end) => { const v = document.querySelector("video"); return v.paused && Math.abs(v.currentTime - end) < 0.02; }', arg=end)
    check('片段终点自动暂停', video.evaluate('(v) => v.paused'))
    page.screenshot(path=str(SHOTS / 'management-review.png'), full_page=True)
    page.set_viewport_size({'width': 375, 'height': 812})
    check('审核页窄屏没有整页横向溢出', page.evaluate('document.documentElement.scrollWidth <= 375'))
    page.set_viewport_size({'width': 1440, 'height': 1000})

    page.goto(BASE + '/admin/tasks/new')
    page.get_by_label('标题', exact=True).fill('表单应保留的标题')
    page.get_by_role('button', name='查看现有任务 · ' + tenant_name).click()
    page.get_by_text(f'共 {expected_count} 条 · 第 1 页', exact=False).wait_for()
    check('展开看到该空间的任务标题', page.get_by_text(title, exact=True).count() == 1)
    check('展开明细不改变发布勾选', page.locator('input[type=checkbox]:checked').count() == 0)
    check('展开明细保留已填标题', page.get_by_label('标题', exact=True).input_value() == '表单应保留的标题')
    page.screenshot(path=str(SHOTS / 'management-publish.png'), full_page=True)

    # 真实退回后，在统计中仍能找到原提交日的任务，净额和片段数归零。
    page.goto(BASE + f'/admin/tasks/{task_id}/review')
    page.get_by_label('退回原因（必填）').fill('第一段结束时间需要重标')
    page.get_by_role('button', name='退回修改').click()
    page.get_by_role('status').filter(has_text='已退回').wait_for()
    page.goto(BASE + '/stats?dim=annotator&from=2000-01-01&to=2099-12-31')
    cells = page.locator('tbody tr').filter(has_text=title).locator('td').all_text_contents()
    check('退回后原日期任务的片段数和净时长归零', cells[3:7] == ['0', '0.0s', '1', '1'])
    check('新增管理流程没有前端异常', not errors)

    personal = browser.new_context(viewport={'width': 1440, 'height': 1000})
    annotator = personal.new_page()
    annotator.goto(BASE + '/login')
    annotator.locator('#username').fill('alice')
    annotator.locator('#password').fill('demo123')
    annotator.locator('button[type=submit]').click()
    annotator.wait_for_url('**/tasks')
    annotator.goto(BASE + '/stats?dim=annotator&from=2026-10-20&to=2026-10-26')
    check('个人工作量不显示按人入口', annotator.get_by_role('navigation', name='统计视图').get_by_role('link').all_text_contents() == ['按日', '按任务'])
    check('个人旧按人链接回落按日且导出同步', annotator.locator('input[name=dim]').input_value() == 'day' and 'dim=day' in annotator.get_by_role('link', name='导出 CSV').get_attribute('href'))
    annotator.screenshot(path=str(SHOTS / 'management-personal-stats.png'), full_page=True)
    browser.close()

print('管理流程验收全部通过')

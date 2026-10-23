#!/usr/bin/env node
/**
 * 规范的可执行部分。
 *
 * 「零信任」的前提是：能做成机械检查的，不要写成「请务必」。
 * 本脚本只查那些能被正则和文件路径判定死的规则，判断类的交给 Reviewer。
 *
 * 用法：npm run audit:rules
 * 任何一条违规都让退出码非 0。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const violations = [];
const report = (rule, file, line, detail) => violations.push({ rule, file, line, detail });

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.next', '.git', 'data'].includes(entry.name)) continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

// ── 规则 1：rule-exception 必须带批准人 ──────────────
// Writer 自行编造理由绕开规范，是这类流程最常见的失效方式。
for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'tests'))]) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    if (!text.includes('rule-exception')) return;
    if (!/批准人\s*\S+/.test(text)) {
      report('rule-exception 未标注批准人', rel(file), i + 1, text.trim());
    }
  });
}

// ── 规则 2：repo 层不得自行开启事务 ──────────────────
// 事务边界只在 service 层。better-sqlite3 里嵌套 BEGIN 会直接抛错，
// 但在 repo 里写好、只在特定调用路径才炸，属于最难排查的一类。
for (const file of walk(path.join(ROOT, 'src', 'lib', 'db', 'repos'))) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    if (/\bwriteTx\s*\(|\.transaction\s*\(|BEGIN\s+(IMMEDIATE|DEFERRED|EXCLUSIVE)/i.test(text)) {
      report('repo 层不得开启事务', rel(file), i + 1, text.trim());
    }
  });
}

// ── 规则 3：测试里不得留 .only / .skip ──────────────
// .only 会让 CI 只跑一个用例而全绿，是「假绿灯」的头号来源。
for (const file of walk(path.join(ROOT, 'tests'))) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    if (/\.(only|skip)\s*\(/.test(text)) {
      report('测试中存在 .only / .skip', rel(file), i + 1, text.trim());
    }
  });
}

// ── 规则 4：src 里不得留 console.log ─────────────────
for (const file of walk(path.join(ROOT, 'src'))) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    if (/console\.log\s*\(/.test(text)) {
      report('源码中存在 console.log', rel(file), i + 1, text.trim());
    }
  });
}

// ── 规则 5：跨租户不得返回 403 ───────────────────────
// 403 等于承认「资源存在但不给你」，泄漏存在性。
for (const file of walk(path.join(ROOT, 'src'))) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    if (/new ForbiddenError\(/.test(text) && /租户|tenant/i.test(text)) {
      report('跨租户场景不得用 403', rel(file), i + 1, text.trim());
    }
  });
}

// ── 输出 ────────────────────────────────────────────
if (violations.length === 0) {
  console.log('[audit:rules] 5 条规则全部通过');
  process.exit(0);
}

console.log(`[audit:rules] 发现 ${violations.length} 处违规\n`);
for (const v of violations) {
  console.log(`  !! ${v.rule}`);
  console.log(`     ${v.file}:${v.line}  ${v.detail}`);
}
process.exit(1);

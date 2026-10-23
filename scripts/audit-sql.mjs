#!/usr/bin/env node
/**
 * 租户谓词静态扫描。
 *
 * 与 ESLint 分工：ESLint 管「import 谁」，本脚本管「SQL 里有没有 tenant_id」——
 * 后者是字符串内容，规则引擎看不见。
 *
 * 用法：npm run audit:sql
 * 豁免：在 SQL 字面量前 300 字符内写 `audit-ignore: <理由>`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_DIR = path.join(ROOT, 'src', 'lib', 'db', 'repos');

/** 带 tenant_id 的表。users / tenants / sessions / audit_logs / videos 不在此列：
 *  前四者按 id 或全局唯一键访问，videos 是平台资产，本就不分租户。 */
const SCOPED = ['tasks', 'segments', 'submissions', 'ledger_entries'];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const violations = [];

for (const file of walk(REPO_DIR)) {
  const src = fs.readFileSync(file, 'utf8');
  // 提取模板字符串与单引号字符串；忽略双引号（项目内 SQL 不用它）
  const literal = /`([\s\S]*?)`|'((?:[^'\\\n]|\\.)*)'/g;
  let match;
  while ((match = literal.exec(src)) !== null) {
    const body = match[1] ?? match[2] ?? '';
    if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(body)) continue;

    const touched = SCOPED.filter((t) => new RegExp(`\\b${t}\\b`).test(body));
    if (touched.length === 0) continue;
    if (/\btenant_id\b/.test(body)) continue;

    const before = src.slice(Math.max(0, match.index - 300), match.index);
    if (before.includes('audit-ignore')) continue;

    const line = src.slice(0, match.index).split('\n').length;
    violations.push({
      file: path.relative(ROOT, file).replace(/\\/g, '/'),
      line,
      tables: touched.join(', '),
      sql: body.trim().replace(/\s+/g, ' ').slice(0, 70),
    });
  }
}

if (violations.length === 0) {
  console.log(`[audit:sql] 4 张受控表的查询均含 tenant_id 谓词`);
  process.exit(0);
}

console.log(`[audit:sql] 发现 ${violations.length} 处缺失租户谓词\n`);
for (const v of violations) {
  console.log(`  !! ${v.file}:${v.line}  涉及 ${v.tables}`);
  console.log(`     ${v.sql}`);
}
console.log('\n若确属豁免（如按全局唯一键查询），在 SQL 前加：// audit-ignore: <理由>');
process.exit(1);

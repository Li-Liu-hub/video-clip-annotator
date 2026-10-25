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

// ── 规则 6：每个写 handler 必须做同源校验 ──────────────
//
// 只测函数本身不够：requireSameOrigin 写得再对，漏接一个 handler 就等于那个接口
// 没防护，而函数级测试全绿。实测删掉 claim 路由里的调用，12 例一条都不红。
//
// 写方法按「导出方法」算，不按文件：segments/[segmentId] 的签名跨行，正则按文件数会漏。
const WRITE_METHODS = ['POST', 'PATCH', 'PUT', 'DELETE'];
const apiRoot = path.join(ROOT, 'src/app/api');
let writeHandlerCount = 0;

for (const file of walk(apiRoot)) {
  if (!file.endsWith('route.ts')) continue;
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');

  lines.forEach((line, i) => {
    const decl = line.match(/export\s+async\s+function\s+(POST|PATCH|PUT|DELETE)\b/);
    if (!decl) return;
    writeHandlerCount += 1;

    // 取这个 handler 的函数体：从声明行到下一个 export 或文件尾
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^export\s/.test(lines[j])) {
        end = j;
        break;
      }
    }
    const body = lines.slice(i, end).join('\n');

    if (!/requireSameOrigin\s*\(/.test(body)) {
      report('写接口必须调用 requireSameOrigin', rel(file), i + 1, `${decl[1]} 没有同源校验`);
    }
    // 参数名以 _ 开头等于没接：拿不到 request 就没法看头
    if (/_request\s*:\s*Request/.test(body)) {
      report('写接口的 request 参数不得命名为 _request', rel(file), i + 1, '拿不到请求头');
    }
  });
}

// 12 是当前写接口的数量。新增写 handler 时必须同时确认它接入了校验，
// 否则这条规则会因为「没扫到」而假绿
if (writeHandlerCount !== 12) {
  report('写接口数量变化，需要复核校验覆盖', 'src/app/api', 0, `实际 ${writeHandlerCount} 个，预期 12 个`);
}

// ── 输出 ────────────────────────────────────────────
if (violations.length === 0) {
  console.log('[audit:rules] 6 条规则全部通过');
  process.exit(0);
}

console.log(`[audit:rules] 发现 ${violations.length} 处违规\n`);
for (const v of violations) {
  console.log(`  !! ${v.rule}`);
  console.log(`     ${v.file}:${v.line}  ${v.detail}`);
}
process.exit(1);

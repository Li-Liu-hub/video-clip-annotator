/**
 * 统计查询的统一入口：校验维度与区间，按角色收窄可见范围。
 *
 * 不 import next/headers —— 身份与连接由调用方注入，本层可在内存库上单测。
 */
import type { DB } from '@/lib/db';
import {
  annotatorTotals,
  dailyTotals,
  taskTotals,
  type AnnotatorTotal,
  type DayTotal,
  type TaskTotal,
} from '@/lib/db/repos/ledger-repo';
import { ForbiddenError, ValidationError } from '@/lib/errors';
import type { DateRange } from '@/lib/stats-range';
import { isTenantUser, type SessionUser } from './auth-service';

export type { AnnotatorTotal, DayTotal, TaskTotal };

export type StatsDimension = 'day' | 'annotator' | 'task';

export type StatsResult =
  | { dimension: 'day'; rows: DayTotal[] }
  | { dimension: 'annotator'; rows: AnnotatorTotal[] }
  | { dimension: 'task'; rows: TaskTotal[] };

/** 三个维度是穷举的，路由传来的字符串必须先在这里过一道。 */
const DIMENSIONS = ['day', 'annotator', 'task'] as const;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * 日期是不是真实存在的一天。
 *
 * 光用正则会放过 `2026-02-31`、`2025-02-29`（非闰年）、`2026-13-45`。
 * 这些输入会静默返回空数组，用户看到的是「这段时间没数据」——
 * 与 from > to 返回空数组是同一个问题：调用方写错了却看不出来。
 *
 * 不用 `new Date(x)` 判断：它对这些值不抛错，只给一个 Invalid Date，
 * 而且 `new Date('2026-02-31')` 会被解析成 3 月 3 日，反而"有效"。
 */
function isRealDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const limit = month === 2 && isLeap ? 29 : DAYS_IN_MONTH[month - 1];
  return day <= limit;
}

const INVALID_DIMENSION_MESSAGE = '统计维度不合法';
const INVALID_DATE_MESSAGE = '日期应为真实存在的 YYYY-MM-DD';
const REVERSED_RANGE_MESSAGE = '起始日期不能晚于结束日期';
const BROKEN_IDENTITY_MESSAGE = '账号数据异常，请联系管理员';

function isStatsDimension(value: string): value is StatsDimension {
  return (DIMENSIONS as readonly string[]).includes(value);
}

/**
 * 区间校验。from > to 抛错而不是返回空数组：
 * 调用方写错了却看不出，会以为「这段时间真没数据」。
 */
function parseRange(from: string, to: string): DateRange {
  if (!isRealDate(from) || !isRealDate(to)) {
    throw new ValidationError(INVALID_DATE_MESSAGE);
  }
  // 落库即定型的字符串，字典序与日期序一致，不必转成 Date 再比
  if (from > to) throw new ValidationError(REVERSED_RANGE_MESSAGE);
  return { from, to };
}

/** 三个维度共用一次分派：可见范围已经算好，这里只选列。 */
function selectRows(
  db: DB,
  dimension: StatsDimension,
  tenantId: string | null,
  annotatorId: string | null,
  range: DateRange,
): StatsResult {
  switch (dimension) {
    case 'day':
      return { dimension: 'day', rows: dailyTotals(db, tenantId, range, annotatorId) };
    case 'annotator':
      return { dimension: 'annotator', rows: annotatorTotals(db, tenantId, range, annotatorId) };
    case 'task':
      return { dimension: 'task', rows: taskTotals(db, tenantId, range, annotatorId) };
  }
}

/**
 * 统计查询。
 *
 * 管理员看全租户；标注员只能看自己的（`annotatorId` 固定为自己）。
 * 这个限制在 repo 层用额外谓词实现，不在 service 里过滤结果 ——
 * 后者会先把别人的数据读进内存再丢弃，日志与性能都说不过去。
 */
export function listStats(
  db: DB,
  actor: SessionUser,
  args: { dimension: StatsDimension; from: string; to: string },
): StatsResult {
  // 先判维度：非法维度不该走到日期校验，否则错误文案会指错地方
  const { dimension } = args;
  if (!isStatsDimension(dimension)) throw new ValidationError(INVALID_DIMENSION_MESSAGE);

  const range = parseRange(args.from, args.to);

  // 管理员跨租户全量，显式传 null（RULES 数据节）；标注员缺租户是数据坏了，不是「看全部」
  if (actor.role === 'admin') return selectRows(db, dimension, null, null, range);

  // 单独赋值：audit:rules 把「同一行既有 ForbiddenError 又有 tenant 字样」判为跨租户 403，
  // 而这里判的是身份是否完整，不是访问范围
  const isAnnotator = isTenantUser(actor);
  if (!isAnnotator) throw new ForbiddenError(BROKEN_IDENTITY_MESSAGE);

  return selectRows(db, dimension, actor.tenantId, actor.id, range);
}

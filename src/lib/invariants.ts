/**
 * 五组数据不变量的判定：把「数据不该变成什么样」写成可执行的断言。
 *
 * 单测验的是「函数按我预期的方式工作」，本模块验的是「这些函数一起用完之后数据仍自洽」。
 * 取数在 db/repos/invariant-repo（RULES：SQL 只在 repos 层），本层只把行解释成违反项。
 *
 * 判定一律跨全部租户：这里没有「当前用户」，任何 tenant_id 谓词都会让
 * 「这一行租了别的租户」变得查不出来。
 */
import type { DB } from '@/lib/db';
import {
  listClaimedPairMismatches,
  listLedgerSnapshotMismatches,
  listNegativeNets,
  listTaskBalanceMismatches,
  listTasksWithMultipleOpenSnapshots,
  listTenantMismatches,
  type LedgerSnapshotRow,
  type TenantMismatchRow,
} from '@/lib/db/repos/invariant-repo';
import { AppError } from '@/lib/errors';

export type Violation = {
  rule: 'ledger-sum' | 'ledger-non-negative' | 'snapshot-unique' | 'ledger-snapshot-match' | 'status-claimed-pair' | 'tenant-consistency';
  /** 违反的那一行（任务 id / 账本 id），便于直接去库里查 */
  subject: string;
  detail: string;
};

/** 关系名用领域词而不是表名：报告是给人看的，`segments` 只会让人再去翻 schema */
const RELATION_NAMES: Record<TenantMismatchRow['relation'], string> = {
  segments: '片段',
  submissions: '提交快照',
  ledger: '账目',
};

/** 账本净额与当前有效提交的金额对不上。detail 里两个数字都给出，省得再去查库。 */
function ledgerSumViolations(db: DB): Violation[] {
  return listTaskBalanceMismatches(db).map((row) => ({
    rule: 'ledger-sum',
    subject: row.task_id,
    detail:
      row.status === 'submitted'
        ? `状态为 submitted，账本净额 ${row.net}ms 与有效提交 ${row.expected}ms 不一致`
        : `状态为 ${row.status}，无有效提交时净额应为 0，实际 ${row.net}ms`,
  }));
}

/** 净额为负：冲正冲掉了不曾计入的量 —— 是缺陷，不是「负数工作量」。 */
function ledgerNonNegativeViolations(db: DB): Violation[] {
  return listNegativeNets(db).map((row) => ({
    rule: 'ledger-non-negative',
    subject: row.task_id,
    detail: `账本净额 ${row.net}ms 为负，说明冲正超过已计入的工作量`,
  }));
}

/** 同一任务最多一条未被取代的快照，否则同一份工作量会被算两次。 */
function snapshotUniqueViolations(db: DB): Violation[] {
  return listTasksWithMultipleOpenSnapshots(db).map((row) => ({
    rule: 'snapshot-unique',
    subject: row.task_id,
    detail: `存在 ${row.open_count} 条未被取代的快照（${row.ids}）`,
  }));
}

/** 把一条账目的所有不一致都列出来；只报第一个会让修完一处又冒一处。 */
function describeLedgerMismatch(row: LedgerSnapshotRow): string {
  if (row.snapshot_id === null || row.snapshot_total_ms === null) {
    return '指向的提交快照不存在';
  }

  const reasons: string[] = [];
  if (row.kind === 'submit') {
    if (row.snapshot_total_ms !== row.delta_ms) {
      reasons.push(`金额 ${row.delta_ms}ms 与快照 ${row.snapshot_total_ms}ms 不一致`);
    }
  } else if (row.snapshot_total_ms !== -row.delta_ms) {
    // 冲正必须与快照金额互为相反数：写成 Math.abs 或漏掉负号都会在这里露出来
    reasons.push(`冲正 ${row.delta_ms}ms 与快照 ${row.snapshot_total_ms}ms 不互为相反数`);
  }
  if (row.snapshot_local_date !== row.entry_date) {
    reasons.push(`记账日 ${row.entry_date} 与快照日 ${row.snapshot_local_date} 不一致`);
  }
  if (row.snapshot_task_id !== row.task_id) {
    reasons.push(`所属任务 ${row.task_id} 与快照的任务 ${row.snapshot_task_id} 不一致`);
  }
  return reasons.join('；');
}

/** 账本不能凭空长出来：每条账目都要能在快照里找到同源的那一行。 */
function ledgerSnapshotMatchViolations(db: DB): Violation[] {
  return listLedgerSnapshotMismatches(db).map((row) => ({
    rule: 'ledger-snapshot-match',
    subject: row.id,
    detail: `${row.kind}：${describeLedgerMismatch(row)}`,
  }));
}

/** pending 与「无领取人」互为充要条件。schema 的 CHECK 只管单条 UPDATE，跨两条管不了。 */
function statusClaimedPairViolations(db: DB): Violation[] {
  return listClaimedPairMismatches(db).map((row) => ({
    rule: 'status-claimed-pair',
    subject: row.id,
    detail:
      row.claimed_by === null
        ? `状态为 ${row.status} 却没有领取人`
        : `状态为 ${row.status} 却已有领取人 ${row.claimed_by}`,
  }));
}

/** 片段 / 快照 / 账本的租户都必须等于所属任务的租户，否则跨租户统计会静默算错。 */
function tenantConsistencyViolations(db: DB): Violation[] {
  return listTenantMismatches(db).map((row) => ({
    rule: 'tenant-consistency',
    subject: row.subject,
    detail: `${RELATION_NAMES[row.relation]}的租户 ${row.row_tenant} 与所属任务 ${row.task_id} 的租户 ${row.task_tenant} 不一致`,
  }));
}

/** 返回所有违反项。空数组表示全部成立。 */
export function findViolations(db: DB): Violation[] {
  return [
    ...ledgerSumViolations(db),
    ...ledgerNonNegativeViolations(db),
    ...snapshotUniqueViolations(db),
    ...ledgerSnapshotMatchViolations(db),
    ...statusClaimedPairViolations(db),
    ...tenantConsistencyViolations(db),
  ];
}

/** 检查器的失败形态：500 + INTERNAL，不把行内容当成用户可见错误往外抛。 */
export class InvariantViolationError extends AppError {
  constructor(violations: Violation[]) {
    // 只把前三条写进消息：调试时最想看的是第一个，全量交给 findViolations
    const head = violations
      .slice(0, 3)
      .map((violation) => `[${violation.rule}] ${violation.subject}：${violation.detail}`)
      .join('；');
    super('INTERNAL', 500, `数据不变量被破坏 ${violations.length} 项：${head}`, { violations });
  }
}

/** 有违反项就抛错，消息里带上前三条。测试与脚本共用。 */
export function assertInvariants(db: DB): void {
  const violations = findViolations(db);
  if (violations.length > 0) throw new InvariantViolationError(violations);
}

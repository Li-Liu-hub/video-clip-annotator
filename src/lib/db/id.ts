/**
 * 领域 id 的唯一生成处。
 *
 * RULES 约定「16 位十六进制」。此前 6 处各写一遍 `randomBytes(8).toString('hex')`，
 * 谁顺手写成 4 字节都不会有编译错误，只会在运行期破坏这个假设。
 *
 * 会话 id 不走这里：它按 auth-service 的约定是 48 位，与业务 id 不是同一个语义。
 */
import { randomBytes } from 'node:crypto';

/** 8 字节 → 16 位十六进制 */
const ID_BYTES = 8;

/** 新的业务 id（任务 / 片段 / 快照 / 账目 / 视频 / 审计）。 */
export function newId(): string {
  return randomBytes(ID_BYTES).toString('hex');
}

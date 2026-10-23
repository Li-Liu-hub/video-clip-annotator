/**
 * 从查询串取页码。两个列表页共用，避免一处接受 0 / NaN、另一处拒绝。
 *
 * 单列一文件而非放进 TaskList：表格是客户端组件，服务端页面调用客户端模块的导出会失败
 * （客户端导出在服务端只能作为组件渲染）。
 */
export function parsePageParam(raw: string | string[] | undefined): number {
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  // 非法值一律回落 1：负 OFFSET 在 SQLite 里是合法值，会静默返回奇怪的结果
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

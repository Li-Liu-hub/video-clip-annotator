/**
 * 退回原因的长度上限。
 *
 * 单独成文件是为了让客户端表单与服务端校验引用同一个数字 ——
 * 客户端组件不得 import service（会把它依赖的数据层拖进浏览器 bundle）。
 */
export const MAX_REASON_LENGTH = 200;

/**
 * 视频上传的上限与类型白名单。
 *
 * 单独成文件：服务端（video-service）与浏览器（video-upload / 上传界面）判的必须是同一组值，
 * 而 video-service 依赖 node:fs，被客户端 bundle 引用会在导入期失败。
 * 与 task-limits.ts 同一范式 —— 常量放中立模块，两端各引它，就不会出现前端放行、后端 413。
 */

/** 200 MB。声明长度与实际写出字节数两处都按它判 */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/**
 * 只允许 MP4。扩展名按 MIME 推导，绝不取上传文件名的后缀：
 * 否则 `x-filename: ../../.env` 这类输入会决定落盘路径。
 */
export const SUPPORTED_MIME_EXTENSIONS: Record<string, string | undefined> = {
  'video/mp4': 'mp4',
};

/**
 * 浏览器侧的 file.type 白名单，直接由 SUPPORTED_MIME_EXTENSIONS 的键推出：
 * 两处各写一份 ['video/mp4'] 时，服务端加一种格式前端仍会把它当成坏文件。
 */
export const ACCEPTED_MIME: readonly string[] = Object.keys(SUPPORTED_MIME_EXTENSIONS);

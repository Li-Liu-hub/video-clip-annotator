/** Vitest 配置：测试跑在 Node 环境，`@/` 与 tsconfig 的路径别名保持一致。 */
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 与 tsconfig.json 的 paths 对齐，否则测试里的 @/lib/* 解析不到
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Windows 下 cwd 的盘符大小写与 Vite 内部的 root 可能不一致（d: vs D:）。
      // Node 把 file:///d:/... 与 file:///D:/... 当成两个模块，于是 collector 设置的
      // runner 在测试文件那份 vitest 实例里不可见（表现为 "Cannot access ... before
      // initialization"）。固定到项目内的同一份入口，消除双实例。
      // 路径按 __dirname 而不是 cwd：从子目录调用 vitest 时 cwd 会变。
      vitest: path.resolve(__dirname, './node_modules/vitest/dist/index.js'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /*
     * 41 个测试文件各起一个 worker；默认并发会把 16 核全部占满，
     * 冷启动时模块装载被拖慢，出现过一次「逻辑没问题但整批超时」的假红（8 例）。
     * 并发限到 8：单文件装载不再互相抢，整轮从 20 秒量级变成 40 秒量级，换来门禁可重复。
     * 超时放宽到 15 秒只影响真挂起的暴露时间，不影响任何断言语义。
     */
    maxWorkers: 8,
    testTimeout: 15_000,
  },
});

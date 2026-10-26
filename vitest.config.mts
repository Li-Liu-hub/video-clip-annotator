/** Vitest 配置：测试跑在 Node 环境，`@/` 与 tsconfig 的路径别名保持一致。 */
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const SRC = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  /*
   * tsconfig 的 jsx 是 "preserve"（Next 自己转）。Vitest 侧用 plugin-react 接管 .tsx，
   * 否则 JSX 会原样进转换器，报 "Unexpected JSX expression"。
   */
  plugins: [react()],
  // 与 tsconfig.json 的 paths 对齐，否则测试里的 @/lib/* 解析不到
  resolve: {
    alias: {
      '@': SRC,
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    // Vitest 使用原生包入口；手工 alias 或内联会使当前运行器产生双实例。
    /*
     * 每个测试文件各起一个 worker；默认并发会把 16 核全部占满，
     * 冷启动时模块装载被拖慢，出现过一次「逻辑没问题但整批超时」的假红（8 例）。
     * 并发限到 8：单文件装载不再互相抢，整轮从 20 秒量级变成 40 秒量级，换来门禁可重复。
     * 超时放宽到 15 秒只影响真挂起的暴露时间，不影响任何断言语义。
     */
    maxWorkers: 8,
    testTimeout: 15_000,
  },
});

/** Vitest 配置：测试跑在 Node 环境，`@/` 与 tsconfig 的路径别名保持一致。 */
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 与 tsconfig.json 的 paths 对齐，否则测试里的 @/lib/* 解析不到
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});

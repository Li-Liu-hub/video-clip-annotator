/** Next 配置：better-sqlite3 是原生模块，必须排除在打包之外由 Node 直接加载。 */
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 是原生模块，必须排除在打包之外由 Node 直接加载
  serverExternalPackages: ['better-sqlite3'],
  poweredByHeader: false,
  /**
   * 把演示账号开关钉成构建期常量。
   *
   * Next 默认只内联「构建时确实存在」的 NEXT_PUBLIC_* 变量；未设置时留成运行时读
   * `process.env.NEXT_PUBLIC_DEMO_LOGIN`，于是 `=== '1'` 折不成 false，
   * 整个 DEMO_ACCOUNTS 连同四个明文口令照样进 bundle（实测过）。
   * 这里缺省补空串，表达式在编译期就是 `'' === '1'`，演示数据才会被摇掉。
   */
  env: {
    NEXT_PUBLIC_DEMO_LOGIN: process.env.NEXT_PUBLIC_DEMO_LOGIN ?? '',
  },
};

export default nextConfig;

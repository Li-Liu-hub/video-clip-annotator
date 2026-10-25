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
  /**
   * 安全响应头（O4）。
   *
   * 管理端的「退回」是不可撤销的写操作，被 iframe 套一层透明覆盖就能骗管理员点下去；
   * SameSite 拦不住这种同站请求伪造。frame-ancestors 与 X-Frame-Options 一起给，
   * 前者是现代浏览器的口径，后者兜旧浏览器。
   *
   * 不写完整 CSP：Next 的运行时需要 inline script，没有 nonce 基础设施时
   * 强行上 CSP 只会把页面打挂。这里只封「被嵌框」这一条，收益明确、代价为零。
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;

/** Next 配置：better-sqlite3 是原生模块，必须排除在打包之外由 Node 直接加载。 */
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 是原生模块，必须排除在打包之外由 Node 直接加载
  serverExternalPackages: ['better-sqlite3'],
  poweredByHeader: false,
};

export default nextConfig;

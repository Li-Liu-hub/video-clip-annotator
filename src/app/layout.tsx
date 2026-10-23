/** 根布局：只放全局字体、主题色与基础样式，不承载任何业务逻辑。 */
import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '片段标注 · 视频标注平台',
  description: '多租户机器人示教视频片段标注与工作量核算',
};

export const viewport: Viewport = {
  themeColor: '#08090d',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}

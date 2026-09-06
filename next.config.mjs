import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Tauri 加载的是打包好的静态文件，不存在 Node 服务端。
  output: 'export',
  images: { unoptimized: true },
  // 版本号只在 package.json 维护一处，页脚直接读它。
  env: { NEXT_PUBLIC_APP_VERSION: pkg.version },
};

export default nextConfig;

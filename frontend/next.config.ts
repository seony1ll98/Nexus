import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS?.split(',') ?? [],
  transpilePackages: ['@xterm/xterm', '@xterm/addon-fit'],
  // 레포 루트에도 lockfile(E2E용 playwright)이 있어 Next.js가 워크스페이스 루트를
  // 잘못 추론하고 경고를 낸다. 프론트엔드 디렉토리를 루트로 명시한다.
  turbopack: {
    root: __dirname,
  },
  outputFileTracingRoot: __dirname,
  // 클라이언트 컴포넌트 기반 앱 — 정적 prerender 비활성화
  experimental: {
    staticGenerationRetryCount: 0,
  },
};

export default nextConfig;

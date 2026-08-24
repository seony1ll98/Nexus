import { defineConfig } from '@playwright/test';
import { ADMIN_AUTH_FILE } from './e2e/auth-file';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    // headless로 실행 (CI/서버 환경)
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    // 로그인 상태를 1회만 만들어 저장한다 (백엔드 로그인 레이트 리밋 회피)
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      testIgnore: /auth\.setup\.ts/,
      use: { browserName: 'chromium', storageState: ADMIN_AUTH_FILE },
      dependencies: ['setup'],
    },
  ],
});

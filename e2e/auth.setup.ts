// 인증 셋업 — 테스트 전체가 공유할 로그인 상태를 1회만 만든다.
//
// 매 테스트마다 로그인하면 백엔드의 로그인 레이트 리밋(IP당 5회/분)에 걸려
// 6번째 테스트부터 429로 실패한다. Playwright 표준 방식대로 storageState를
// 한 번 저장해 재사용하면 로그인 호출이 1회로 줄고 실행 속도도 빨라진다.
import { test as setup, expect } from '@playwright/test';
import { ADMIN_AUTH_FILE } from './auth-file';

const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

if (!TEST_EMAIL || !TEST_PASSWORD) {
  throw new Error('TEST_EMAIL, TEST_PASSWORD 환경변수가 필요합니다');
}

setup('관리자 로그인 상태 저장', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: '이메일' }).fill(TEST_EMAIL);
  await page.getByRole('textbox', { name: '비밀번호' }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: '로그인' }).click();

  // 로그인 성공을 URL이 아니라 화면 내용으로 확인한다.
  // 로그인 폼이 '/'에 있어 URL만 보면 실패해도 통과해버린다.
  await expect(page.getByText('팀 대시보드')).toBeVisible({ timeout: 15000 });

  await page.context().storageState({ path: ADMIN_AUTH_FILE });
});

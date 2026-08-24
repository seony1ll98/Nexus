// 저장된 인증 상태 파일 경로 (레포 루트 기준 상대 경로).
//
// playwright.config.ts와 auth.setup.ts가 함께 참조한다.
// 설정 파일이 셋업 파일을 직접 import하면 config 로드 시점에 테스트 정의가
// 실행되어 오류가 나므로, 상수만 별도 모듈로 분리한다.
export const ADMIN_AUTH_FILE = 'playwright/.auth/admin.json';

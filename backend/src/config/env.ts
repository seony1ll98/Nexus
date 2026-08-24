// 환경변수 로딩 및 검증
import 'dotenv/config';

interface Env {
  DATABASE_URL: string;
  PORT: number;
  SESSION_SECRET: string;
  FRONTEND_URL: string;
  NODE_ENV: 'development' | 'production';
  /**
   * 신뢰할 리버스 프록시 주소 목록 (쉼표 구분).
   * Fastify trustProxy에 그대로 전달된다 — 여기 없는 주소가 보낸
   * X-Forwarded-For는 무시되므로 IP 위조를 막을 수 있다.
   * 기본값: 같은 호스트의 Nginx만 신뢰
   */
  TRUSTED_PROXIES: string[];
  /** 전역 API 레이트 리밋 — 1분당 최대 요청 수 (기본 100) */
  RATE_LIMIT_MAX: number;
  /** 로그인 레이트 리밋 — IP당 1분 최대 시도 수 (기본 5) */
  LOGIN_RATE_LIMIT_MAX: number;
  /**
   * 세션 쿠키에 Secure 속성을 붙일지 여부.
   * 기본값은 NODE_ENV === 'production'이지만, HTTPS 없이 운영하는 경우
   * Secure 쿠키는 브라우저가 저장하지 않아 로그인 자체가 불가능해진다.
   * 그런 환경에서는 COOKIE_SECURE=false로 명시적으로 끌 수 있다.
   */
  COOKIE_SECURE: boolean;
  // DB 민감 데이터 암호화 키 — 64자 hex (32바이트). 미설정 시 claudeAccount 평문 저장
  ENCRYPTION_KEY?: string;
  // 알리고 SMS — optional (미설정 시 SMS 비활성화)
  ALIGO_API_KEY?: string;
  ALIGO_USER_ID?: string;
  ALIGO_SENDER?: string;
}

function loadEnv(): Env {
  const required = ['DATABASE_URL', 'SESSION_SECRET'];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`환경변수 ${key}가 설정되지 않았습니다`);
    }
  }

  return {
    DATABASE_URL: process.env.DATABASE_URL!,
    PORT: parseInt(process.env.PORT || '8080', 10),
    SESSION_SECRET: process.env.SESSION_SECRET!,
    FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
    NODE_ENV: (process.env.NODE_ENV as Env['NODE_ENV']) || 'development',
    TRUSTED_PROXIES: (process.env.TRUSTED_PROXIES || '127.0.0.1,::1')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // 기본값은 기존 하드코딩 값과 동일 — E2E/CI에서만 높여 쓴다
    RATE_LIMIT_MAX: parseInt(process.env.RATE_LIMIT_MAX || '100', 10),
    LOGIN_RATE_LIMIT_MAX: parseInt(process.env.LOGIN_RATE_LIMIT_MAX || '5', 10),
    COOKIE_SECURE: process.env.COOKIE_SECURE !== undefined
      ? process.env.COOKIE_SECURE === 'true'
      : process.env.NODE_ENV === 'production',
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    ALIGO_API_KEY: process.env.ALIGO_API_KEY,
    ALIGO_USER_ID: process.env.ALIGO_USER_ID,
    ALIGO_SENDER: process.env.ALIGO_SENDER,
  };
}

export const env = loadEnv();

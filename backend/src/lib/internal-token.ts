// 내부 전용 API 접근 토큰 — 세션별 1회용
//
// 배경: Claude CLI가 merge를 수행할 때 /api/internal/... 을 curl로 호출한다.
// 이 경로를 IP만으로 지키면 리버스 프록시 뒤에서 외부에 그대로 노출된다.
// 그래서 스트림이 시작될 때 세션별 토큰을 발급해 시스템 프롬프트에 실어 보내고,
// 스트림이 끝나면 즉시 폐기한다. 고정 시크릿과 달리 유출 시 영향 범위가
// "그 세션, 그 실행 시간" 으로 제한된다.
import crypto from 'crypto';

/** 세션ID → { token, expiresAt } */
const tokens = new Map<string, { token: string; expiresAt: number }>();

/** 토큰 최대 수명 — 스트림 타임아웃(30분)보다 약간 길게 잡는다 */
const TTL_MS = 35 * 60 * 1000;

/** 세션에 새 토큰을 발급한다 (기존 토큰은 덮어써서 무효화) */
export function issueInternalToken(sessionId: string): string {
  const token = crypto.randomBytes(32).toString('base64url');
  tokens.set(sessionId, { token, expiresAt: Date.now() + TTL_MS });
  return token;
}

/** 세션 토큰을 폐기한다 — 스트림 종료 시 호출 */
export function revokeInternalToken(sessionId: string): void {
  tokens.delete(sessionId);
}

/**
 * 토큰 검증 — 세션ID와 토큰이 짝이 맞고 만료되지 않았는지 확인한다.
 * 타이밍 공격을 피하기 위해 상수 시간 비교를 사용한다.
 */
export function verifyInternalToken(sessionId: string, presented: string | undefined): boolean {
  if (!presented) return false;

  const entry = tokens.get(sessionId);
  if (!entry) return false;

  if (Date.now() > entry.expiresAt) {
    tokens.delete(sessionId);
    return false;
  }

  const a = Buffer.from(entry.token);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 만료된 토큰 정리 — 주기적으로 호출 */
export function pruneExpiredInternalTokens(): void {
  const now = Date.now();
  for (const [sessionId, entry] of tokens.entries()) {
    if (now > entry.expiresAt) tokens.delete(sessionId);
  }
}

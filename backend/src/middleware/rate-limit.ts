// Rate Limit 설정 — 엔드포인트별 요청 제한
import rateLimit from '@fastify/rate-limit';
import { FastifyInstance } from 'fastify';
import { createHttpError } from '../lib/errors.js';
import { env } from '../config/env.js';

/**
 * 전역 기본 Rate Limit 등록 — 일반 API: 100회/분
 * 개별 라우트는 config.rateLimit으로 오버라이드 가능
 */
export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    // 전역 기본값: 1분당 100회 (RATE_LIMIT_MAX로 조정 가능)
    max: env.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    /**
     * 제한 초과 시 반환할 에러.
     *
     * 여기서 만든 값은 전역 에러 핸들러로 던져진다. 평범한 객체를 반환하면
     * statusCode가 없어 500 INTERNAL_ERROR로 처리되므로(실제로 그렇게 나가고 있었다),
     * statusCode를 가진 Error를 반환해야 429 TOO_MANY_REQUESTS로 응답된다.
     */
    errorResponseBuilder: (_request, context) =>
      createHttpError(
        429,
        `요청이 너무 많습니다. ${Math.ceil(context.ttl / 1000)}초 후 다시 시도해주세요.`,
        { code: 'TOO_MANY_REQUESTS' },
      ),
    // 레이트 리밋 헤더 응답에 포함
    addHeadersOnExceeding: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
    },
  });
}

/** 채팅 엔드포인트 전용 Rate Limit 설정 — 10회/분 */
export const chatRateLimit = {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: '1 minute',
    },
  },
} as const;

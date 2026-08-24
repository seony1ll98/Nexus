// 로그인 라우트 — POST /api/auth/login
import { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcrypt';
import prisma from '../../lib/prisma.js';
import { env } from '../../config/env.js';

// 요청 body 타입
interface LoginBody {
  email: string;
  password: string;
}

/**
 * 타이밍 공격 방지용 더미 해시
 * 이메일 미존재 시에도 동일한 시간이 소요되도록 bcrypt.compare 수행
 */
const DUMMY_HASH = '$2b$10$dummyhashfortimingattack0000000000000000000000000000';

/**
 * IP당 로그인 시도 횟수 관리 — 메모리 기반 레이트 리미터
 * 구조: Map<ip, { count: number; resetAt: number }>
 */
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
/** IP당 허용 최대 시도 횟수 (LOGIN_RATE_LIMIT_MAX로 조정 가능) */
const MAX_ATTEMPTS = env.LOGIN_RATE_LIMIT_MAX;
/** 시도 횟수 초기화 주기 (밀리초) */
const WINDOW_MS = 60_000;

/**
 * IP 기반 레이트 리밋 검사
 * 5회/분 초과 시 true 반환
 */
function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (!entry || now > entry.resetAt) {
    // 새 윈도우 시작
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  entry.count += 1;
  if (entry.count > MAX_ATTEMPTS) {
    return true;
  }
  return false;
}

/**
 * 오래된 레이트 리밋 엔트리 정리 (메모리 누수 방지)
 * 서버 실행 중 주기적으로 호출
 */
function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts.entries()) {
    if (now > entry.resetAt) {
      loginAttempts.delete(ip);
    }
  }
}

// 5분마다 만료된 엔트리 정리
setInterval(cleanupExpiredEntries, 5 * 60_000);

const loginRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Body: LoginBody }>(
    '/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      // IP 기반 레이트 리밋 검사 (브루트포스 방어)
      const ip = request.ip ?? '0.0.0.0';
      if (isRateLimited(ip)) {
        return reply.code(429).send({
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: '로그인 시도 횟수를 초과했습니다. 잠시 후 다시 시도해주세요',
          },
        });
      }

      const { email, password } = request.body;

      // 이메일로 사용자 조회
      const user = await prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          passwordHash: true,
        },
      });

      // 타이밍 공격 방지: 이메일 미존재 시에도 더미 해시로 bcrypt.compare 수행
      if (!user) {
        await bcrypt.compare(password, DUMMY_HASH);
        return reply.code(401).send({
          error: { code: 'INVALID_CREDENTIALS', message: '이메일 또는 비밀번호가 올바르지 않습니다' },
        });
      }

      // 비밀번호 검증
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return reply.code(401).send({
          error: { code: 'INVALID_CREDENTIALS', message: '이메일 또는 비밀번호가 올바르지 않습니다' },
        });
      }

      // 세션 고정 공격 방어: 로그인 성공 시 세션 재생성
      await request.session.regenerate();

      // 세션에 userId 저장
      request.session.set('userId', user.id);

      return {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      };
    },
  );
};

export default loginRoute;

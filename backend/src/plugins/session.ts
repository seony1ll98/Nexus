// 세션 플러그인 — PostgreSQL 스토어 기반 httpOnly 쿠키 세션
import fp from 'fastify-plugin';
import session, { type FastifySessionOptions } from '@fastify/session';
import connectPgSimple from 'connect-pg-simple';
import { env } from '../config/env.js';

// fastify Session 타입 확장 — userId + OAuth PKCE 임시 데이터 저장용
declare module 'fastify' {
  interface Session {
    userId: string;
    /** OAuth PKCE code_verifier — 세션에만 저장, DB/로그 기록 금지 */
    oauthCodeVerifier?: string;
    /** OAuth state — CSRF 방어용 */
    oauthState?: string;
  }
}

// connect-pg-simple에 Store 생성자를 전달하기 위한 어댑터
const PgStore = connectPgSimple(session as never);

export default fp(async (fastify) => {
  const store = new PgStore({
    conString: env.DATABASE_URL,
    tableName: 'user_sessions',
    createTableIfMissing: false,
  });

  const sessionOptions: FastifySessionOptions = {
    secret: env.SESSION_SECRET,
    store: store as unknown as FastifySessionOptions['store'],
    cookieName: 'connect.sid',
    cookie: {
      httpOnly: true,
      // HTTPS 없이 운영하면 Secure 쿠키가 저장되지 않아 로그인이 막힌다 — COOKIE_SECURE로 조정
      secure: env.COOKIE_SECURE,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24시간
      path: '/',
    },
    saveUninitialized: false,
  };

  await fastify.register(session, sessionOptions);
}, { name: 'session-plugin' });

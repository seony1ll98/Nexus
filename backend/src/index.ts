// Fastify 서버 엔트리포인트
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { Server as SocketIOServer } from 'socket.io';
import { env } from './config/env.js';
import sessionPlugin from './plugins/session.js';
import errorHandlerPlugin from './plugins/error-handler.js';
import { registerRateLimit } from './middleware/rate-limit.js';
import authRoutes from './routes/auth/index.js';
import projectRoutes from './routes/projects/index.js';
import sessionRoutes from './routes/sessions/index.js';
import treeRoutes from './routes/tree/index.js';
import notificationRoutes from './routes/notifications/index.js';
import usersIndexRoute from './routes/users/index.js';
import userIdRoute from './routes/users/[id].js';
import internalRoutes from './routes/internal/index.js';
import { registerTerminalNamespace } from './plugins/terminal.js';
import { registerSocketPlugin } from './plugins/socket.js';
import { socketService } from './services/socket.service.js';
import { lockService } from './services/lock.service.js';
import { pruneExpiredPkce } from './lib/oauth-pkce-store.js';
import { pruneExpiredInternalTokens } from './lib/internal-token.js';
import { terminalService } from './services/terminal.service.js';

/**
 * trustProxy를 "신뢰할 프록시 홉"으로 한정한다.
 *
 * Nginx 리버스 프록시 뒤에서는 소켓 주소가 항상 127.0.0.1이 되어,
 * request.ip 기반 판정(rate limit, 내부 API의 localhost 검사)이 전부 무력화된다.
 * 반대로 trustProxy: true로 열어두면 클라이언트가 X-Forwarded-For를 위조할 수 있다.
 * 신뢰 목록을 로컬 홉으로 좁히면 Nginx가 덧붙인 실제 클라이언트 IP만 채택된다.
 *
 * Nginx 측에는 다음 설정이 필요하다:
 *   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
 *   proxy_set_header X-Forwarded-Proto $scheme;
 */
const app = Fastify({ logger: true, trustProxy: env.TRUSTED_PROXIES });

// 전역 에러 핸들러 플러그인 — Prisma 에러 변환 + 일관된 응답 형식
await app.register(errorHandlerPlugin);

// Rate Limit 플러그인 — 전역 기본 100회/분
await registerRateLimit(app);

// CORS 설정 — FRONTEND_URL + localhost 모두 허용
await app.register(cors, {
  origin: [env.FRONTEND_URL, 'http://localhost:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
});

// 쿠키 플러그인
await app.register(cookie);

// 세션 플러그인 (쿠키 이후 등록)
await app.register(sessionPlugin);

// 헬스 체크
app.get('/api/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// 인증 라우트
await app.register(authRoutes, { prefix: '/api/auth' });

// CRUD 라우트
await app.register(projectRoutes, { prefix: '/api/projects' });
await app.register(sessionRoutes, { prefix: '/api/sessions' });
await app.register(treeRoutes, { prefix: '/api/tree' });
await app.register(notificationRoutes, { prefix: '/api/notifications' });

// 사용자 관리 라우트 (관리자 전용)
await app.register(usersIndexRoute, { prefix: '/api/users' });
await app.register(userIdRoute, { prefix: '/api/users' });

// 내부 전용 라우트 (localhost 전용 — Claude CLI 등 서버 내부 호출)
await app.register(internalRoutes, { prefix: '/api/internal/sessions' });

// 서버 종료 시 인터벌 및 터미널 세션 정리 — ready() 호출 전에 등록
let lockCheckInterval: ReturnType<typeof setInterval>;
let pkceCleanupInterval: ReturnType<typeof setInterval>;
app.addHook('onClose', async () => {
  clearInterval(lockCheckInterval);
  clearInterval(pkceCleanupInterval);
  terminalService.destroyAll();
});

// 서버 시작
const start = async () => {
  try {
    // Fastify가 내부 http.Server를 생성하기 전에 ready() 호출
    await app.ready();

    // Fastify 내부 http.Server를 Socket.IO에 직접 연결
    const io = new SocketIOServer(app.server, {
      cors: {
        origin: env.FRONTEND_URL,
        credentials: true,
      },
      path: '/socket.io',
    });

    // 기본 네임스페이스 인증 미들웨어 및 룸 핸들러 등록
    registerSocketPlugin(io);

    // 웹 터미널 네임스페이스 등록
    registerTerminalNamespace(io);

    // SocketService 싱글턴 초기화 — 브로드캐스트 유틸 사용 가능
    socketService.init(io);

    // Fastify listen (Socket.IO가 동일 http.Server를 공유)
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    app.log.info(`서버가 포트 ${env.PORT}에서 실행 중입니다 (HTTP + Socket.IO)`);

    // 고스트 락 방지 — 서버 재시작 시 모든 락 초기화
    await lockService.clearAllLocks();
    app.log.info('기존 세션 락 초기화 완료');

    // 만료 락 자동 해제 타이머 — 60초마다 15분 초과 락 점검
    lockCheckInterval = setInterval(() => {
      lockService.checkExpiredLocks().catch((err) => {
        app.log.error({ err }, '만료 락 해제 중 오류 발생');
      });
    }, 60_000);

    // 만료된 OAuth PKCE 항목 + 내부 API 토큰 정리 타이머 — 5분마다 실행
    pkceCleanupInterval = setInterval(() => {
      pruneExpiredPkce();
      pruneExpiredInternalTokens();
    }, 5 * 60_000);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();

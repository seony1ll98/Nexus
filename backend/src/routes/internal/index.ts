// 내부 전용 API — 서버 내부(Claude CLI)에서만 호출한다
//
// 방어는 두 겹이다:
//  1) 출발지가 localhost인지 (trustProxy를 로컬 홉으로 한정했으므로 request.ip는 실제 클라이언트 IP)
//  2) 해당 세션에 발급된 1회용 토큰을 제시했는지
// IP 검사만으로는 리버스 프록시 구성에서 우회될 수 있어 토큰을 필수로 둔다.
import { FastifyPluginAsync } from 'fastify';
import { mergeService } from '../../services/merge.service.js';
import { commitSyncService } from '../../services/commit-sync.service.js';
import { verifyInternalToken } from '../../lib/internal-token.js';
import prisma from '../../lib/prisma.js';

/** 내부 API 토큰을 싣는 헤더 이름 */
export const INTERNAL_TOKEN_HEADER = 'x-internal-token';

const internalRoutes: FastifyPluginAsync = async (fastify) => {
  // 1차 방어 — 출발지 검증
  fastify.addHook('onRequest', async (request, reply) => {
    const ip = request.ip;
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    if (!isLocal) {
      request.log.warn({ ip, url: request.url }, '내부 API에 외부 접근 시도');
      return reply.code(403).send({
        error: { code: 'FORBIDDEN', message: '내부 API는 localhost에서만 접근 가능합니다' },
      });
    }
  });

  // 2차 방어 — 세션별 1회용 토큰 검증
  fastify.addHook('preHandler', async (request, reply) => {
    const sessionId = (request.params as { id?: string } | undefined)?.id;
    const presented = request.headers[INTERNAL_TOKEN_HEADER];
    const token = Array.isArray(presented) ? presented[0] : presented;

    if (!sessionId || !verifyInternalToken(sessionId, token)) {
      request.log.warn({ ip: request.ip, url: request.url }, '내부 API 토큰 검증 실패');
      return reply.code(403).send({
        error: { code: 'FORBIDDEN', message: '유효하지 않은 내부 API 토큰입니다' },
      });
    }
  });

  /** POST /:id/merge — main에 merge만 수행 (세션/worktree 유지, 계속 작업 가능) */
  fastify.post<{ Params: { id: string } }>('/:id/merge', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
  }, async (request) => {
    const { id } = request.params;

    // 세션 + 프로젝트 정보 조회
    const session = await prisma.session.findUnique({
      where: { id },
      include: { project: { select: { id: true, repoPath: true } } },
    });
    if (!session) {
      return { status: 'error', message: '세션을 찾을 수 없습니다' };
    }
    if (!session.branchName) {
      return { status: 'error', message: '브랜치 정보가 없는 세션입니다' };
    }

    // main에 merge (세션 상태는 변경하지 않음)
    // CLI가 대신 호출하므로 요청 사용자가 없다 — 세션 생성자를 작성자로 쓴다
    const result = await mergeService.mergeSessionToMain(session, session.project, session.createdBy);

    // merge 성공 시 커밋 동기화
    if (result.status === 'merged') {
      await prisma.session.update({
        where: { id },
        data: { mergeStatus: 'merged' },
      });

      await commitSyncService.syncNewCommits(
        session.project.id,
        session.id,
        session.project.repoPath,
      ).catch(() => null);
    }

    return {
      status: 'ok',
      mergeStatus: result.status,
      message: result.status === 'merged'
        ? 'main 브랜치에 성공적으로 merge되었습니다. 세션은 계속 활성 상태입니다.'
        : 'merge 충돌이 발생했습니다. 수동 해결이 필요합니다.',
    };
  });
};

export default internalRoutes;

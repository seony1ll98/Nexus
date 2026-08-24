// POST /api/sessions/:id/merge — 세션 브랜치를 main에 merge (세션/worktree 유지)
import { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { mergeService } from '../../services/merge.service.js';
import { commitSyncService } from '../../services/commit-sync.service.js';
import { createHttpError } from '../../lib/errors.js';
import prisma from '../../lib/prisma.js';

/** params UUID 검증 스키마 */
const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
};

const mergeRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { id: string } }>('/:id/merge', {
    preHandler: [requireAuth],
    schema: { params: idParamsSchema },
  }, async (request) => {
    // 세션 접근 권한은 sessions/index.ts의 공통 preHandler 훅에서 검증된다
    const { id } = request.params;

    // 세션 + 프로젝트 조회
    const session = await prisma.session.findUnique({
      where: { id },
      include: { project: { select: { id: true, repoPath: true } } },
    });
    if (!session) throw createHttpError(404, '세션을 찾을 수 없습니다');
    if (!session.branchName) throw createHttpError(400, '브랜치 정보가 없는 세션입니다');

    // main에 merge (세션 상태는 변경하지 않음 — worktree 유지)
    const result = await mergeService.mergeSessionToMain(session, session.project, request.userId);

    // merge 성공 시 DB 상태 업데이트 + 커밋 동기화
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
    } else {
      await prisma.session.update({
        where: { id },
        data: { mergeStatus: 'conflict' },
      });
    }

    return {
      mergeStatus: result.status,
      message: result.status === 'merged'
        ? 'main 브랜치에 성공적으로 merge되었습니다'
        : 'merge 충돌이 발생했습니다. 수동 해결이 필요합니다',
    };
  });
};

export default mergeRoute;

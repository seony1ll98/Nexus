// 커밋 revert 라우트 — POST /api/projects/:id/commits/:hash/revert
import { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../../../plugins/auth.js';
import prisma from '../../../lib/prisma.js';
import { revertCommit } from '../../../services/commit-diff.service.js';
import { createHttpError } from '../../../lib/errors.js';
import { memberService } from '../../../services/member.service.js';

/** 라우트 파라미터 타입 */
interface RevertParams { id: string; hash: string }

const commitRevertRoute: FastifyPluginAsync = async (fastify) => {
  // POST /:hash/revert — revert 커밋 생성 (충돌 시 409)
  fastify.post<{ Params: RevertParams }>('/:hash/revert', {
    preHandler: [requireAuth],
    schema: {
      params: {
        type: 'object',
        required: ['id', 'hash'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          hash: { type: 'string', minLength: 7, maxLength: 40 },
        },
      },
    },
  }, async (request, reply) => {
    const { id: projectId, hash } = request.params;

    // 프로젝트 확인
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw createHttpError(404, '프로젝트를 찾을 수 없습니다');

    // 프로젝트 멤버십 검증
    await memberService.assertProjectMember(projectId, request.userId);

    // 커밋 확인
    const commit = await prisma.commit.findFirst({
      where: { projectId, hash: { startsWith: hash } },
    });
    if (!commit) throw createHttpError(404, '커밋을 찾을 수 없습니다');

    // 활성 세션(락) 경고 조회
    const activeSessions = await prisma.session.findMany({
      where: { projectId, lockedBy: { not: null } },
      select: { id: true, title: true, lockedBy: true },
    });

    // revert 실행 (충돌 시 서비스에서 409 throw)
    await revertCommit(projectId, project.repoPath, commit.hash, request.userId);

    return reply.code(200).send({
      message: `커밋 ${commit.hash.slice(0, 7)} revert 완료`,
      warnings: activeSessions.length > 0
        ? [`현재 ${activeSessions.length}개의 활성 세션이 있습니다`]
        : [],
    });
  });
};

export default commitRevertRoute;

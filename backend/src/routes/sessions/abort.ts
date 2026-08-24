// AI 응답 중단 라우트 — POST /api/sessions/:id/abort
import { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { claudeService } from '../../services/claude.service.js';

interface AbortParams { id: string }

const abortRoute: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: AbortParams }>('/:id/abort', {
    preHandler: [requireAuth],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
  }, async (request, reply) => {
    // 세션 접근 권한은 sessions/index.ts의 공통 preHandler 훅에서 검증된다
    const { id: sessionId } = request.params;

    const aborted = claudeService.abort(sessionId);

    if (!aborted) {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: '실행 중인 작업이 없습니다' },
      });
    }

    return {
      message: '작업이 중단되었습니다.',
      sessionId,
      partialResultSaved: true,
    };
  });
};

export default abortRoute;

// 세션 락/해제/요청/이전 라우트 — /api/sessions/:id/lock*
import { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { lockService } from '../../services/lock.service.js';
import { socketService } from '../../services/socket.service.js';
import { createHttpError } from '../../lib/errors.js';
import prisma from '../../lib/prisma.js';

interface IdParams { id: string }
interface TransferBody { toUserId: string }
interface LockRequestBody { message?: string }

/** params UUID 검증 스키마 */
const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
};

const lockRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /:id/lock — 락 획득
  fastify.post<{ Params: IdParams }>('/:id/lock', {
    preHandler: [requireAuth],
    schema: { params: idParamsSchema },
  }, async (request) => {
    // 세션 접근 권한은 sessions/index.ts의 공통 preHandler 훅에서 검증된다
    const lockInfo = await lockService.acquireLock(request.params.id, request.userId);
    return lockInfo;
  });

  // POST /:id/unlock — 락 해제
  fastify.post<{ Params: IdParams }>('/:id/unlock', {
    preHandler: [requireAuth],
    schema: { params: idParamsSchema },
  }, async (request) => {
    // 세션 접근 권한은 sessions/index.ts의 공통 preHandler 훅에서 검증된다
    const lockInfo = await lockService.releaseLock(request.params.id, request.userId);
    return lockInfo;
  });

  // POST /:id/lock-request — 락 보유자에게 작업 요청 알림 전송
  fastify.post<{ Params: IdParams; Body: LockRequestBody }>('/:id/lock-request', {
    preHandler: [requireAuth],
    schema: {
      params: idParamsSchema,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { message: { type: 'string', maxLength: 300 } },
      },
    },
  }, async (request, reply) => {
    const sessionId = request.params.id;
    const requesterId = request.userId;

    // 세션 및 락 보유자 조회
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        projectId: true,
        lockedBy: true,
        title: true,
        locker: { select: { name: true } },
      },
    });

    if (!session) throw createHttpError(404, '세션을 찾을 수 없습니다');

    if (!session.lockedBy) throw createHttpError(400, '현재 락이 없는 세션입니다');
    if (session.lockedBy === requesterId) {
      throw createHttpError(400, '본인이 락 보유자입니다');
    }

    // 요청자 정보 조회
    const requester = await prisma.user.findUnique({
      where: { id: requesterId },
      select: { name: true },
    });

    // 알림 DB 저장
    await prisma.notification.create({
      data: {
        userId: session.lockedBy,
        type: 'lock_request',
        payload: {
          sessionId,
          sessionTitle: session.title,
          requesterId,
          requesterName: requester?.name ?? '알 수 없음',
          message: request.body?.message ?? '',
        },
      },
    });

    // 락 보유자에게 실시간 전달
    socketService.emitToUser(session.lockedBy, 'session:lock-request', {
      sessionId,
      sessionTitle: session.title,
      requesterId,
      requesterName: requester?.name ?? '알 수 없음',
      message: request.body?.message ?? '',
    });

    return reply.code(200).send({ ok: true });
  });

  // POST /:id/lock-transfer — 락 이전 (현재 보유자만 가능)
  fastify.post<{ Params: IdParams; Body: TransferBody }>('/:id/lock-transfer', {
    preHandler: [requireAuth],
    schema: {
      params: idParamsSchema,
      body: {
        type: 'object',
        required: ['toUserId'],
        additionalProperties: false,
        properties: { toUserId: { type: 'string', format: 'uuid' } },
      },
    },
  }, async (request) => {
    // 세션 접근 권한은 sessions/index.ts의 공통 preHandler 훅에서 검증된다
    const lockInfo = await lockService.transferLock(
      request.params.id,
      request.userId,
      request.body.toUserId,
    );
    return lockInfo;
  });
};

export default lockRoutes;

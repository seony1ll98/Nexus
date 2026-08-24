// 세션 라우트 — /api/sessions
// 핸들러 로직은 session.handlers.ts로 분리됨
import { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import chatRoute from './chat.js';
import abortRoute from './abort.js';
import messagesRoute from './messages.js';
import lockRoutes from './lock.js';
import mergeRoute from './merge.js';
import {
  assertSessionAccess,
  handleList,
  handleCreate,
  handleGetOne,
  handleUpdate,
  handleDelete,
  type ListQuery,
  type IdParams,
  type CreateBody,
  type UpdateBody,
} from './session.handlers.js';

/** params UUID 검증 스키마 */
const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
};

const sessionRoutes: FastifyPluginAsync = async (fastify) => {
  // ────────────────────────────────────────────
  // 세션 라우트 공통 가드 (검문소)
  // 라우트마다 개별로 붙이면 누락이 생기므로 플러그인 레벨 훅으로 일괄 적용한다.
  // 반드시 하위 라우트 register()보다 먼저 등록해야 한다 —
  // Fastify 훅은 "이후에 등록된" 라우트에만 적용되기 때문이다.
  // 인스턴스 레벨 preHandler는 등록 순서대로, 라우트 레벨 preHandler보다 먼저 실행된다.
  // ────────────────────────────────────────────

  // 1) 로그인 검증 — request.userId를 설정한다
  fastify.addHook('preHandler', requireAuth);

  // 2) :id 파라미터가 있는 모든 라우트에 세션 접근 권한 검증
  //    (프로젝트 멤버십 + admin-only 프로젝트 차단)
  fastify.addHook('preHandler', async (request) => {
    const id = (request.params as { id?: string } | undefined)?.id;
    if (!id) return; // 목록/생성 등 :id가 없는 라우트는 각 핸들러가 검증
    await assertSessionAccess(id, request.userId);
  });

  // 채팅, 중단, 메시지, 락, merge 라우트 등록
  await fastify.register(chatRoute);
  await fastify.register(abortRoute);
  await fastify.register(messagesRoute);
  await fastify.register(lockRoutes);
  await fastify.register(mergeRoute);

  // GET / — 세션 목록 (folderId 또는 projectId로 필터)
  fastify.get<{ Querystring: ListQuery }>('/', {
    preHandler: [requireAuth],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          folderId: { type: 'string', format: 'uuid' },
          projectId: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['active', 'archived'] },
        },
      },
    },
  }, handleList);

  // POST / — 세션 생성 (projectId 필수, folderId 선택)
  fastify.post<{ Body: CreateBody }>('/', {
    preHandler: [requireAuth],
    schema: {
      body: {
        type: 'object',
        required: ['projectId', 'title'],
        additionalProperties: false,
        properties: {
          projectId: { type: 'string', format: 'uuid' },
          folderId: { type: 'string', format: 'uuid' },
          title: { type: 'string', minLength: 1, maxLength: 300 },
        },
      },
    },
  }, handleCreate);

  // GET /:id — 세션 상세 (관계 포함)
  fastify.get<{ Params: IdParams }>('/:id', {
    preHandler: [requireAuth],
    schema: { params: idParamsSchema },
  }, handleGetOne);

  // PATCH /:id — 세션 수정
  fastify.patch<{ Params: IdParams; Body: UpdateBody }>('/:id', {
    preHandler: [requireAuth],
    schema: {
      params: idParamsSchema,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 300 },
          status: { type: 'string', enum: ['active', 'archived'] },
        },
      },
    },
  }, handleUpdate);

  // DELETE /:id — 세션 삭제
  fastify.delete<{ Params: IdParams }>('/:id', {
    preHandler: [requireAuth],
    schema: { params: idParamsSchema },
  }, handleDelete);
};

export default sessionRoutes;

// 폴더 라우트 — /api/projects/:projectId/folders
import { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import { folderService } from '../../services/folder.service.js';
import { memberService } from '../../services/member.service.js';
import { createHttpError } from '../../lib/errors.js';

// 요청 타입 정의
interface ProjectParams { projectId: string }
interface FolderParams extends ProjectParams { id: string }
interface CreateBody { name: string; description?: string }
interface UpdateBody { name?: string; description?: string }

/** projectId params UUID 검증 스키마 */
const projectParamsSchema = {
  type: 'object',
  required: ['projectId'],
  properties: {
    projectId: { type: 'string', format: 'uuid' },
  },
};

/** projectId + id params UUID 검증 스키마 */
const folderParamsSchema = {
  type: 'object',
  required: ['projectId', 'id'],
  properties: {
    projectId: { type: 'string', format: 'uuid' },
    id: { type: 'string', format: 'uuid' },
  },
};

const folderRoutes: FastifyPluginAsync = async (fastify) => {
  // GET / — 프로젝트 내 폴더 목록
  fastify.get<{ Params: ProjectParams }>('/', {
    preHandler: [requireAuth],
    schema: { params: projectParamsSchema },
  }, async (request) => {
    // 프로젝트 멤버십 검증
    await memberService.assertProjectMember(request.params.projectId, request.userId);
    return folderService.findByProject(request.params.projectId);
  });

  // POST / — 폴더 생성
  fastify.post<{ Params: ProjectParams; Body: CreateBody }>('/', {
    preHandler: [requireAuth],
    schema: {
      params: projectParamsSchema,
      body: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    // 프로젝트 멤버십 검증 — 비멤버는 폴더 생성 불가
    await memberService.assertProjectMember(request.params.projectId, request.userId);
    // 409 Conflict 포함 에러는 전역 핸들러에서 처리
    const folder = await folderService.create(request.params.projectId, request.body, request.userId);
    return reply.code(201).send(folder);
  });

  // GET /:id — 폴더 상세
  fastify.get<{ Params: FolderParams }>('/:id', {
    preHandler: [requireAuth],
    schema: { params: folderParamsSchema },
  }, async (request) => {
    // URL의 projectId로 멤버십 검증 (폴더 조회 전에 선행)
    await memberService.assertProjectMember(request.params.projectId, request.userId);
    const folder = await folderService.findById(request.params.id);
    // 폴더 미존재 시 전역 핸들러에서 처리
    if (!folder) throw createHttpError(404, '폴더를 찾을 수 없습니다');
    return folder;
  });

  // PATCH /:id — 폴더 수정
  fastify.patch<{ Params: FolderParams; Body: UpdateBody }>('/:id', {
    preHandler: [requireAuth],
    schema: {
      params: folderParamsSchema,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          description: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    // 프로젝트 멤버십 검증 — 비멤버는 폴더 수정 불가
    await memberService.assertProjectMember(request.params.projectId, request.userId);
    // 서비스 레이어 에러(404 등)는 전역 핸들러에서 처리
    return folderService.update(request.params.id, request.body);
  });

  // DELETE /:id — 폴더 삭제
  fastify.delete<{ Params: FolderParams }>('/:id', {
    preHandler: [requireAuth],
    schema: { params: folderParamsSchema },
  }, async (request, reply) => {
    // 프로젝트 멤버십 검증 — 비멤버는 폴더 삭제 불가
    await memberService.assertProjectMember(request.params.projectId, request.userId);
    // 서비스 레이어 에러(404 등)는 전역 핸들러에서 처리
    await folderService.remove(request.params.id);
    return reply.code(204).send();
  });
};

export default folderRoutes;

// 세션 라우트 핸들러 — sessions/index.ts에서 분리
import type { FastifyRequest, FastifyReply } from 'fastify';
import { sessionService } from '../../services/session.service.js';
import { memberService } from '../../services/member.service.js';
import { createHttpError } from '../../lib/errors.js';
import prisma from '../../lib/prisma.js';

// 요청 타입 정의
export interface ListQuery { folderId?: string; projectId?: string; status?: string }
export interface IdParams { id: string }
export interface CreateBody { projectId: string; folderId?: string; title: string }
export interface UpdateBody { title?: string; status?: string }

/**
 * 세션이 요청자의 프로젝트 소속인지 검증
 * 폴더 소속 / 프로젝트 직속 모두 지원
 */
export async function assertSessionAccess(sessionId: string, userId: string): Promise<void> {
  if (!userId) {
    throw createHttpError(401, '로그인이 필요합니다');
  }
  // 세션이 속한 프로젝트 조회
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { projectId: true },
  });
  if (!session) {
    throw createHttpError(404, '세션을 찾을 수 없습니다');
  }
  // 프로젝트 멤버십 검증
  await memberService.assertProjectMember(session.projectId, userId);
}

/** GET / — 세션 목록 핸들러 */
export async function handleList(
  request: FastifyRequest<{ Querystring: ListQuery }>,
) {
  const { folderId, projectId, status } = request.query;
  const userId = request.userId;

  if (!folderId && !projectId) {
    throw createHttpError(400, 'folderId 또는 projectId가 필요합니다');
  }

  // folderId로 조회 시: 해당 폴더의 프로젝트 멤버인지 확인
  if (folderId) {
    const folder = await prisma.folder.findUnique({
      where: { id: folderId },
      select: { projectId: true },
    });
    if (!folder) throw createHttpError(404, '폴더를 찾을 수 없습니다');

    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: folder.projectId, userId } },
    });
    if (!member) throw createHttpError(403, '이 폴더에 접근할 권한이 없습니다');

    return sessionService.findByFolder(folderId, status);
  }

  // projectId로 조회 시: 해당 프로젝트 멤버인지 확인
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: projectId!, userId } },
  });
  if (!member) throw createHttpError(403, '이 프로젝트에 접근할 권한이 없습니다');

  return sessionService.findByProject(projectId!, status);
}

/** POST / — 세션 생성 핸들러 */
export async function handleCreate(
  request: FastifyRequest<{ Body: CreateBody }>,
  reply: FastifyReply,
) {
  const userId = request.userId;

  // 프로젝트 멤버십 검증 (시스템 admin은 bypass)
  await memberService.assertProjectMember(request.body.projectId, userId);

  const session = await sessionService.create({
    projectId: request.body.projectId,
    folderId: request.body.folderId,
    title: request.body.title,
    createdBy: userId,
  });
  return reply.code(201).send(session);
}

/** GET /:id — 세션 상세 핸들러 */
export async function handleGetOne(
  request: FastifyRequest<{ Params: IdParams }>,
) {
  // 세션 접근 권한은 sessions/index.ts의 공통 preHandler 훅에서 검증된다
  const session = await sessionService.findById(request.params.id);
  if (!session) throw createHttpError(404, '세션을 찾을 수 없습니다');

  return session;
}

/** PATCH /:id — 세션 수정 핸들러 */
export async function handleUpdate(
  request: FastifyRequest<{ Params: IdParams; Body: UpdateBody }>,
) {
  return sessionService.update(request.params.id, request.body);
}

/** DELETE /:id — 세션 삭제 핸들러 */
export async function handleDelete(
  request: FastifyRequest<{ Params: IdParams }>,
  reply: FastifyReply,
) {
  await sessionService.remove(request.params.id);
  return reply.code(204).send();
}

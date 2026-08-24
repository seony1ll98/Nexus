// 사용자 단건 라우트 — GET/PATCH/DELETE /api/users/:id (관리자 전용)
import { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcrypt';
import { requireAdmin } from '../../plugins/auth.js';
import { createHttpError } from '../../lib/errors.js';
import prisma from '../../lib/prisma.js';
import { linuxUserService } from '../../services/linux-user.service.js';

/** 사용자 수정 요청 바디 */
interface UpdateUserBody {
  name?: string;
  role?: string;
  authMode?: string;
  linuxUser?: string;
  newPassword?: string;
}

/** id params 스키마 */
const idParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
};

/** 공통 사용자 select 필드 */
const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  authMode: true,
  linuxUser: true,
  createdAt: true,
};

const userIdRoute: FastifyPluginAsync = async (fastify) => {
  // GET /:id — 사용자 상세 조회 (관리자 전용)
  fastify.get<{ Params: { id: string } }>('/:id', {
    preHandler: [requireAdmin],
    schema: { params: idParamsSchema },
  }, async (request) => {
    const user = await prisma.user.findUnique({
      where: { id: request.params.id },
      select: userSelect,
    });
    if (!user) throw createHttpError(404, '사용자를 찾을 수 없습니다');
    return user;
  });

  // PATCH /:id — 사용자 수정 (관리자 전용)
  fastify.patch<{ Params: { id: string }; Body: UpdateUserBody }>('/:id', {
    preHandler: [requireAdmin],
    schema: {
      params: idParamsSchema,
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          role: { type: 'string', enum: ['admin', 'member'] },
          authMode: { type: 'string', enum: ['subscription', 'api'] },
          linuxUser: { type: 'string', pattern: '^[a-z0-9_-]{1,32}$' },
          newPassword: { type: 'string', minLength: 6 },
        },
      },
    },
  }, async (request) => {
    const { id } = request.params;
    const { name, role, authMode, linuxUser, newPassword } = request.body;

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw createHttpError(404, '사용자를 찾을 수 없습니다');

    // 비밀번호 변경 시 bcrypt 해싱
    const passwordHash = newPassword ? await bcrypt.hash(newPassword, 10) : undefined;

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(role !== undefined && { role }),
        ...(authMode !== undefined && { authMode }),
        ...(linuxUser !== undefined && { linuxUser }),
        ...(passwordHash !== undefined && { passwordHash }),
      },
      select: userSelect,
    });

    // ────────────────────────────────────────────
    // Linux 계정 실제 생성
    //
    // 이전에는 linuxUser가 DB에 문자열로만 저장되고 서버에는 그 계정이
    // 존재하지 않았다. 그래서 팀원이 터미널을 열면 없는 계정으로 실행하려다 실패했다.
    // 관리자가 저장하는 시점에 실제로 만들어 둔다.
    // 실패해도 사용자 정보 수정 자체는 성공 처리하고, 사유를 응답에 담아 알린다
    // (터미널을 열 때 다시 시도되므로 복구 가능하다).
    // ────────────────────────────────────────────
    let provisionWarning: string | undefined;
    const targetRole = role ?? existing.role;

    if (linuxUser !== undefined && targetRole !== 'admin') {
      if (!linuxUserService.isProvisioningSupported()) {
        provisionWarning = 'Linux 계정 생성은 Linux 서버에서만 가능합니다. 계정명만 저장되었습니다.';
      } else {
        try {
          await linuxUserService.ensureLinuxUser(id);
        } catch (err) {
          provisionWarning = err instanceof Error ? err.message : 'Linux 계정 생성에 실패했습니다';
          request.log.error({ err, userId: id }, 'Linux 계정 프로비저닝 실패');
        }
      }
    }

    return provisionWarning ? { ...updated, provisionWarning } : updated;
  });

  // DELETE /:id — 사용자 삭제 (관리자 전용)
  fastify.delete<{ Params: { id: string } }>('/:id', {
    preHandler: [requireAdmin],
    schema: { params: idParamsSchema },
  }, async (request, reply) => {
    const { id } = request.params;

    // 자기 자신 삭제 불가
    if (id === request.userId) throw createHttpError(400, '자기 자신은 삭제할 수 없습니다');

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw createHttpError(404, '사용자를 찾을 수 없습니다');

    await prisma.user.delete({ where: { id } });
    return reply.code(204).send();
  });
};

export default userIdRoute;

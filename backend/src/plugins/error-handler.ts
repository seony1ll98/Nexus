// 전역 에러 핸들러 플러그인 — Prisma 에러 변환 포함
import fp from 'fastify-plugin';
import { FastifyPluginAsync, FastifyError } from 'fastify';
import { Prisma } from '@prisma/client';

/** HTTP 상태 코드 → 에러 코드 문자열 변환 */
function statusToCode(status: number): string {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'UNAUTHORIZED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 429: return 'TOO_MANY_REQUESTS';
    default:  return 'INTERNAL_ERROR';
  }
}

const errorHandlerPlugin: FastifyPluginAsync = async (fastify) => {
  // 등록되지 않은 경로의 404도 프로젝트 공통 형식으로 응답한다.
  // 기본 응답은 { message, error, statusCode } 형태라 프론트의 apiFetch가
  // error.code를 읽지 못해 "알 수 없는 오류"로 표시됐다.
  fastify.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `요청한 경로를 찾을 수 없습니다: ${request.method} ${request.url}`,
      },
    });
  });

  fastify.setErrorHandler((err: FastifyError, _request, reply) => {
    // Prisma 알려진 요청 에러 변환
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') {
        // 유니크 제약 위반
        return reply.code(409).send({
          error: { code: 'CONFLICT', message: '이미 존재하는 데이터입니다.' },
        });
      }
      if (err.code === 'P2025') {
        // 레코드 없음
        return reply.code(404).send({
          error: { code: 'NOT_FOUND', message: '해당 데이터를 찾을 수 없습니다.' },
        });
      }
      // 그 외 Prisma 에러 → 400
      fastify.log.error({ err }, 'Prisma 요청 에러');
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: '잘못된 데이터 요청입니다.' },
      });
    }

    // Prisma 유효성 검증 에러
    if (err instanceof Prisma.PrismaClientValidationError) {
      fastify.log.warn({ err }, 'Prisma 유효성 검증 실패');
      return reply.code(400).send({
        error: { code: 'BAD_REQUEST', message: '요청 데이터 형식이 올바르지 않습니다.' },
      });
    }

    const statusCode = err.statusCode ?? 500;
    const code = statusToCode(statusCode);

    // 500 이상 에러는 내부 메시지 숨김
    if (statusCode >= 500) {
      fastify.log.error({ err }, '서버 내부 오류 발생');
      return reply.code(statusCode).send({
        error: { code, message: '서버 내부 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' },
      });
    }

    return reply.code(statusCode).send({
      error: { code, message: err.message },
    });
  });
};

export default fp(errorHandlerPlugin, { name: 'error-handler' });

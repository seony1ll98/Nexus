// 세션 락 비즈니스 로직 서비스
import prisma from '../lib/prisma.js';
import { createHttpError } from '../lib/errors.js';
import { socketService } from './socket.service.js';
import { claudeService } from './claude.service.js';

/** 락 정보 형식 — 브로드캐스트 및 응답에 사용 */
export interface LockInfo {
  sessionId: string;
  lockedBy: string | null;
  lockedAt: string | null;
  lockerName: string | null;
}

/** 락 상태 브로드캐스트 — 트랜잭션 커밋 후에 호출해야 정확한 데이터 전송 보장 */
async function broadcastLockUpdate(sessionId: string): Promise<LockInfo> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      lockedBy: true,
      lockedAt: true,
      locker: { select: { name: true } },
    },
  });

  const lockInfo: LockInfo = {
    sessionId,
    lockedBy: session?.lockedBy ?? null,
    lockedAt: session?.lockedAt?.toISOString() ?? null,
    lockerName: session?.locker?.name ?? null,
  };

  // 프론트엔드 타입에 맞춘 페이로드: { sessionId, lock: { userId, userName, lockedAt } | null }
  const lock = session?.lockedBy
    ? { userId: session.lockedBy, userName: session.locker?.name ?? '', lockedAt: session.lockedAt?.toISOString() ?? '' }
    : null;
  socketService.emitToSession(sessionId, 'session:lock-updated', { sessionId, lock });

  return lockInfo;
}

class LockService {
  /**
   * 세션 락 획득 — 조건부 UPDATE로 처리 (동시 요청 시 한 명만 성공)
   * - 미잠금 → lockedBy, lockedAt, lastActivityAt 설정
   * - 이미 본인 → lastActivityAt만 갱신
   * - 다른 사용자 → 409 SESSION_LOCKED
   */
  async acquireLock(sessionId: string, userId: string): Promise<LockInfo> {
    // ────────────────────────────────────────────
    // 조건부 UPDATE로 경합을 DB에 위임한다.
    //
    // 예전에는 트랜잭션 안에서 "읽고 → 쓰기"를 했는데, PostgreSQL 기본
    // 격리수준(Read Committed)에서는 동시 요청 둘이 모두 lockedBy=null을 읽고
    // 둘 다 성공한다. 조건을 WHERE에 넣으면 DB가 한쪽만 통과시킨다.
    // ────────────────────────────────────────────
    const now = new Date();

    // ① 미잠금 상태에서만 신규 획득 (lockedAt 갱신)
    const acquired = await prisma.session.updateMany({
      where: { id: sessionId, lockedBy: null },
      data: { lockedBy: userId, lockedAt: now, lastActivityAt: now },
    });

    if (acquired.count === 0) {
      // ② 이미 본인이 보유 중이면 활동 시각만 갱신 (lockedAt은 유지)
      const refreshed = await prisma.session.updateMany({
        where: { id: sessionId, lockedBy: userId },
        data: { lastActivityAt: now },
      });

      if (refreshed.count === 0) {
        // 세션이 없는 것인지, 다른 사람이 보유 중인지 구분해 응답한다
        const session = await prisma.session.findUnique({
          where: { id: sessionId },
          select: { lockedBy: true },
        });
        if (!session) throw createHttpError(404, '세션을 찾을 수 없습니다');
        throw createHttpError(409, '다른 사용자가 작업 중입니다');
      }
    }

    // 커밋 완료 후 브로드캐스트 — 정확한 데이터 보장
    return broadcastLockUpdate(sessionId);
  }

  /**
   * 세션 락 해제 — 본인 락만 해제 가능
   */
  async releaseLock(sessionId: string, userId: string): Promise<LockInfo> {
    await prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { lockedBy: true },
      });

      if (!session) throw createHttpError(404, '세션을 찾을 수 없습니다');
      if (!session.lockedBy) return; // 이미 미잠금
      if (session.lockedBy !== userId) {
        throw createHttpError(403, '본인 락만 해제할 수 있습니다');
      }

      await tx.session.update({
        where: { id: sessionId },
        data: { lockedBy: null, lockedAt: null, lastActivityAt: null },
      });
    });

    // 트랜잭션 커밋 완료 후 브로드캐스트
    return broadcastLockUpdate(sessionId);
  }

  /**
   * 락 이전 — 트랜잭션으로 lockedBy 직접 교체 (중간 상태 없음)
   */
  async transferLock(
    sessionId: string,
    fromUserId: string,
    toUserId: string,
  ): Promise<LockInfo> {
    await prisma.$transaction(async (tx) => {
      const session = await tx.session.findUnique({
        where: { id: sessionId },
        select: { lockedBy: true },
      });

      if (!session) throw createHttpError(404, '세션을 찾을 수 없습니다');
      if (session.lockedBy !== fromUserId) {
        throw createHttpError(403, '락 보유자만 이전할 수 있습니다');
      }

      // 수신자 존재 확인
      const toUser = await tx.user.findUnique({ where: { id: toUserId }, select: { id: true } });
      if (!toUser) throw createHttpError(404, '이전 대상 사용자를 찾을 수 없습니다');

      const now = new Date();
      await tx.session.update({
        where: { id: sessionId },
        data: { lockedBy: toUserId, lockedAt: now, lastActivityAt: now },
      });
    });

    // 트랜잭션 커밋 완료 후 브로드캐스트
    return broadcastLockUpdate(sessionId);
  }

  /**
   * 만료된 락 자동 해제 — lastActivityAt이 15분 초과된 세션
   */
  async checkExpiredLocks(): Promise<void> {
    const expiredAt = new Date(Date.now() - 15 * 60 * 1000);

    const expiredSessions = await prisma.session.findMany({
      where: {
        lockedBy: { not: null },
        lastActivityAt: { lt: expiredAt },
      },
      select: { id: true },
    });

    for (const { id } of expiredSessions) {
      // 실행 중인 작업의 락은 해제하지 않는다.
      // 스트림이 활동 시각을 주기적으로 갱신하지만, 갱신 실패나 시계 오차로
      // 만료 판정에 걸릴 수 있다. 프로세스가 살아 있으면 그것이 더 확실한 신호다.
      if (claudeService.isRunning(id)) continue;

      await prisma.session.update({
        where: { id },
        data: { lockedBy: null, lockedAt: null, lastActivityAt: null },
      });
      await broadcastLockUpdate(id);
    }
  }

  /**
   * 서버 시작 시 모든 락 초기화 — 고스트 락 방지
   */
  async clearAllLocks(): Promise<void> {
    await prisma.session.updateMany({
      where: { lockedBy: { not: null } },
      data: { lockedBy: null, lockedAt: null, lastActivityAt: null },
    });
  }
}

export const lockService = new LockService();

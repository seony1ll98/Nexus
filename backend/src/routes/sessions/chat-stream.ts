// 채팅 SSE 스트림 처리 로직
import { FastifyReply } from 'fastify';
import { EventEmitter } from 'events';
import { StreamEvent } from '../../services/claude.service.js';
import { transformStreamEvent, SseEvent } from '../../services/sse-transformer.js';
import { messageService } from '../../services/message.service.js';
import { commitSyncService } from '../../services/commit-sync.service.js';
import { externalNotifyService } from '../../services/external-notify.service.js';
import { lockService } from '../../services/lock.service.js';
import { revokeInternalToken } from '../../lib/internal-token.js';
import prisma from '../../lib/prisma.js';

/** 커밋 동기화 및 외부 알림에 필요한 세션 컨텍스트 */
interface SessionContext {
  projectId: string;
  worktreePath: string | null;
  /** 세션 생성자 유저 ID — 작업 완료 외부 알림 발송 대상 */
  createdBy?: string | null;
  /** 세션 제목 — SMS/푸시 알림 메시지에 사용 */
  sessionTitle?: string;
  /** 프로젝트 이름 — SMS/푸시 알림 메시지에 사용 */
  projectName?: string;
  /** 현재 요청 사용자 ID — claude_session_id 저장 시 사용자별 구분 */
  userId?: string;
  /** 글로벌 config 모드 — admin-only 프로젝트에서 claudeSessionId를 prefix 없이 저장 */
  useGlobalConfig?: boolean;
}

/** SSE 스트림 최대 유지 시간 (30분) — CLI hang 방지 */
const STREAM_TIMEOUT_MS = 30 * 60 * 1000;

/** SSE 전송 — 클라이언트 연결 끊김 시 안전하게 스킵 */
function safeSend(reply: FastifyReply, disconnected: boolean, event: string, data: object) {
  if (disconnected) return;
  try {
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch { /* 연결 끊김 — 무시 */ }
}

/** 스트림 이벤트 수집 및 SSE 전달 처리 */
export function handleChatStream(
  emitter: EventEmitter,
  reply: FastifyReply,
  sessionId: string,
  sessionCtx?: SessionContext,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let fullText = '';
    let claudeSessionId: string | null = null;
    let totalTokens = 0;
    const toolsUsed: string[] = [];
    // 도구 사용 상세 기록 — 메시지 metadata에 저장하여 이후 표시에 활용
    const toolDetails: { toolId: string; tool: string; summary?: string; input?: Record<string, unknown>; output?: string; isError?: boolean }[] = [];

    // 클라이언트 연결 끊김 플래그 — SSE 전송만 중단, 이벤트 수집은 계속
    let clientDisconnected = false;
    // 스트림 종료 플래그 — timeout/close 중복 실행 방지
    let streamEnded = false;

    // 스트림 타임아웃 — 30분 초과 시 close 이벤트를 발생시켜 DB 저장 후 종료
    const streamTimeout = setTimeout(() => {
      if (streamEnded) return;
      safeSend(reply, clientDisconnected, 'system', { subtype: 'error', message: '스트림 타임아웃 (30분 초과)' });
      // close 핸들러가 DB 저장/알림/커밋동기화를 수행하도록 close 이벤트 발생
      emitter.emit('close');
    }, STREAM_TIMEOUT_MS);

    emitter.on('event', (raw: StreamEvent) => {
      const sseEvents = transformStreamEvent(raw as Record<string, unknown>);

      for (const evt of sseEvents) {
        // result(done) 이벤트는 클라이언트로 전달하지 않음 — close 핸들러에서 DB 저장 후 전송
        if (evt.event === 'done') continue;

        // 클라이언트 연결 중일 때만 SSE 전송 — 끊겨도 이벤트 수집은 계속
        safeSend(reply, clientDisconnected, evt.event, evt.data);

        // 텍스트 누적
        if (evt.event === 'assistant_text') {
          fullText += evt.data.content as string;
        }
        // 도구 사용 시작 — 이름 + 요약 수집
        if (evt.event === 'tool_use_begin') {
          toolsUsed.push(evt.data.tool as string);
          toolDetails.push({
            toolId: evt.data.toolId as string,
            tool: evt.data.tool as string,
            summary: evt.data.toolUseSummary as string | undefined,
          });
        }
        // 도구 입력 수집
        if (evt.event === 'tool_use_input') {
          const detail = toolDetails.find((t) => t.toolId === evt.data.toolId);
          if (detail) detail.input = evt.data.input as Record<string, unknown>;
        }
        // 도구 결과 수집
        if (evt.event === 'tool_result') {
          const detail = toolDetails.find((t) => t.toolId === evt.data.toolId);
          if (detail) {
            detail.output = evt.data.output as string;
            detail.isError = evt.data.isError as boolean;
          }
        }
      }

      // session_id 추출 — system(init), result 두 이벤트 모두에서 시도
      const extractedId = (raw.session_id ?? raw.sessionId ?? null) as string | null;
      if (extractedId && !claudeSessionId) {
        claudeSessionId = extractedId;
      }

      // result 이벤트에서 토큰 수 추출
      if (raw.type === 'result') {
        totalTokens = (raw.total_tokens ?? raw.totalTokens ?? 0) as number;
      }
    });

    emitter.on('error', (errMsg: string) => {
      streamEnded = true;
      clearTimeout(streamTimeout);
      // 내부 API 토큰 폐기 — 스트림이 끝나면 더 이상 유효하지 않다
      revokeInternalToken(sessionId);
      safeSend(reply, clientDisconnected, 'system', { subtype: 'error', message: errMsg });
      if (!clientDisconnected) reply.raw.end();
      resolve();
    });

    emitter.on('close', async () => {
      streamEnded = true;
      clearTimeout(streamTimeout);
      // 내부 API 토큰 폐기 — 스트림이 끝나면 더 이상 유효하지 않다
      revokeInternalToken(sessionId);
      try {
        // AI 응답 메시지 저장 — 모든 세션 공통으로 DB에 저장 (DB가 source of truth)
        let messageId: string | null = null;
        if (fullText) {
          const metadata = toolsUsed.length > 0
            ? { toolsUsed, toolDetails: toolDetails.length > 0 ? toolDetails : undefined }
            : undefined;
          const saved = await messageService.saveAssistantMessage(
            sessionId, fullText, metadata, totalTokens || undefined,
          );
          messageId = saved.id;
        }

        // done 이벤트 — 클라이언트 연결 중일 때만 전송
        safeSend(reply, clientDisconnected, 'done', {
          messageId: messageId ?? '',
          sessionId,
          totalTokens,
        });

        // 외부 알림 발송 (SMS + 브라우저 푸시 + 알림음) — 연결 끊김과 무관하게 실행
        if (sessionCtx?.createdBy && sessionCtx.sessionTitle && sessionCtx.projectName) {
          externalNotifyService.notifyTaskComplete(
            sessionCtx.createdBy,
            sessionId,
            sessionCtx.sessionTitle,
            sessionCtx.projectName,
          ).catch((err) => {
            console.error('외부 알림 발송 실패:', err);
          });
        }

        // 새 커밋 자동 동기화 — 연결 끊김과 무관하게 실행
        if (sessionCtx?.worktreePath) {
          commitSyncService.syncNewCommits(
            sessionCtx.projectId,
            sessionId,
            sessionCtx.worktreePath,
          ).catch((err) => {
            console.error('커밋 동기화 실패:', err);
          });
        }

        // 세션 정보 업데이트 (claudeSessionId, lastActivityAt)
        // admin-only: 최초 claudeSessionId는 체인 추적의 앵커이므로 보존
        // 새 세션 ID는 체인 탐색으로 자동 발견됨
        const updateData: Record<string, unknown> = { lastActivityAt: new Date() };
        if (claudeSessionId) {
          if (sessionCtx?.useGlobalConfig) {
            // admin-only — 기존 ID가 없을 때만 저장 (체인 앵커 보존)
            const current = await prisma.session.findUnique({
              where: { id: sessionId },
              select: { claudeSessionId: true },
            });
            if (!current?.claudeSessionId) {
              updateData.claudeSessionId = claudeSessionId;
            }
          } else if (sessionCtx?.userId) {
            updateData.claudeSessionId = `${sessionCtx.userId}:${claudeSessionId}`;
          } else {
            updateData.claudeSessionId = claudeSessionId;
          }
        }
        await prisma.session.update({
          where: { id: sessionId },
          data: updateData,
        });

        // 스트림 완료 후 락 자동 해제 — 작업 끝나면 다른 팀원이 바로 사용 가능
        if (sessionCtx?.userId) {
          await lockService.releaseLock(sessionId, sessionCtx.userId).catch((err) => {
            console.warn('[chat-stream] 락 해제 실패 (무시):', err);
          });
        }
      } catch (err) {
        console.error('메시지 저장 실패:', err);
      } finally {
        // 클라이언트 연결 중일 때만 스트림 종료 — 이미 끊긴 경우 스킵
        if (!clientDisconnected) {
          try { reply.raw.end(); } catch { /* 이미 닫힘 */ }
        }
        resolve();
      }
    });

    // 클라이언트 연결 끊김 — SSE 전송만 중단, CLI는 계속 실행
    // 이유: 탭 이동/새로고침 등 비명시적 끊김에서도 응답 완료 후 DB에 저장되도록
    // 명시적 중지는 POST /abort 엔드포인트로만 처리 (onAbort는 호출하지 않음)
    reply.raw.on('close', () => {
      clientDisconnected = true;
      // streamTimeout은 유지 — CLI hang 방지 목적이므로 필요
    });
  });
}

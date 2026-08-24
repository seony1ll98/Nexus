// WebSocket 이벤트 → Zustand 스토어 매핑 훅
// 단일 구독 로직 — 핸들러를 ref에 저장하여 불필요한 재구독 방지

'use client';

import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getSocket } from '@/lib/socket';
import { useRealtimeStore } from '@/stores/realtimeStore';
import { useAuthStore } from '@/stores/authStore';
import { showNotification } from '@/lib/browser-notification';
import { playNotificationSound } from '@/lib/notification-sound';
import type { LockInfo, OnlineUser, Notification, SocketPayload } from '@/types/realtime';

interface UseRealtimeSyncOptions {
  projectId?: string;
  sessionId?: string;
}

interface LockRequestPayload {
  sessionId: string;
  sessionTitle: string;
  requesterId: string;
  requesterName: string;
  message: string;
}

interface TaskCompletePayload {
  sessionId: string;
  sessionTitle: string;
  projectName: string;
  notifyBrowser: boolean;
  notifySound: boolean;
}

/**
 * Socket.IO 이벤트를 구독하고 Zustand 스토어와 TanStack Query를 동기화.
 * 이벤트 리스너는 컴포넌트 마운트 시 1회만 등록 (의존성 변경 시 재구독 안 함).
 * 프로젝트/세션 룸 join/leave는 별도 effect로 분리.
 */
export function useRealtimeSync({ projectId, sessionId }: UseRealtimeSyncOptions = {}) {
  const queryClient = useQueryClient();
  const setLock = useRealtimeStore((s) => s.setLock);
  const setOnlineUsers = useRealtimeStore((s) => s.setOnlineUsers);
  const addNotification = useRealtimeStore((s) => s.addNotification);
  const user = useAuthStore((s) => s.user);

  // 현재 값을 ref에 보관 — useEffect 재실행 없이 최신 값 참조
  const handlersRef = useRef({
    setLock, setOnlineUsers, addNotification, queryClient, user,
  });
  // 렌더 중 ref를 수정하면 React가 경고한다(react-hooks/refs).
  // 커밋 이후에 갱신해도 구독 콜백은 항상 최신 값을 읽으므로 동작은 동일하다.
  useEffect(() => {
    handlersRef.current = { setLock, setOnlineUsers, addNotification, queryClient, user };
  });

  // 단일 구독 — 마운트 시 1회만 실행, 언마운트 시 정리
  useEffect(() => {
    const socket = getSocket();

    const onLockUpdated = (payload: SocketPayload<{ sessionId: string; lock: LockInfo | null }>) => {
      handlersRef.current.setLock(payload.data.sessionId, payload.data.lock);
    };

    const onOnlineUsers = (payload: SocketPayload<{ projectId: string; users: OnlineUser[] }>) => {
      handlersRef.current.setOnlineUsers(payload.data.projectId, payload.data.users);
    };

    const onNewNotification = (payload: SocketPayload<Notification>) => {
      handlersRef.current.addNotification(payload.data);
      // TanStack Query 캐시에도 동기화 — 중복 방지를 위해 ID 체크
      handlersRef.current.queryClient.setQueryData<Notification[]>(
        ['notifications'],
        (old) => {
          if (!old) return [payload.data];
          if (old.some((n) => n.id === payload.data.id)) return old;
          return [payload.data, ...old];
        },
      );
    };

    const onLockRequest = (payload: SocketPayload<LockRequestPayload>) => {
      const notif: Notification = {
        id: `lr-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        type: 'lock_request',
        payload: payload.data as unknown as Record<string, unknown>,
        isRead: false,
        createdAt: new Date().toISOString(),
      };
      handlersRef.current.addNotification(notif);
      handlersRef.current.queryClient.setQueryData<Notification[]>(
        ['notifications'],
        (old) => (old ? [notif, ...old] : [notif]),
      );
    };

    const onSessionCreated = () => {
      handlersRef.current.queryClient.invalidateQueries({ queryKey: ['tree'] });
    };

    const onSessionDeleted = () => {
      handlersRef.current.queryClient.invalidateQueries({ queryKey: ['tree'] });
    };

    const onSessionArchived = () => {
      handlersRef.current.queryClient.invalidateQueries({ queryKey: ['tree'] });
    };

    const onTaskComplete = (payload: SocketPayload<TaskCompletePayload>) => {
      const { sessionTitle, projectName, notifyBrowser, notifySound } = payload.data;
      const u = handlersRef.current.user;
      const browserEnabled = notifyBrowser && (u?.notifyBrowser ?? true);
      const soundEnabled = notifySound && (u?.notifySound ?? true);
      if (browserEnabled) {
        showNotification(`작업 완료 — ${projectName}`, `"${sessionTitle}" 세션의 작업이 완료되었습니다.`);
      }
      if (soundEnabled) {
        playNotificationSound();
      }
    };

    socket.on('session:lock-updated', onLockUpdated);
    socket.on('session:lock-request', onLockRequest);
    socket.on('project:online-users', onOnlineUsers);
    socket.on('notification:new', onNewNotification);
    socket.on('session:created', onSessionCreated);
    socket.on('session:deleted', onSessionDeleted);
    socket.on('session:archived', onSessionArchived);
    socket.on('session:task-complete', onTaskComplete);

    return () => {
      socket.off('session:lock-updated', onLockUpdated);
      socket.off('session:lock-request', onLockRequest);
      socket.off('project:online-users', onOnlineUsers);
      socket.off('notification:new', onNewNotification);
      socket.off('session:created', onSessionCreated);
      socket.off('session:deleted', onSessionDeleted);
      socket.off('session:archived', onSessionArchived);
      socket.off('session:task-complete', onTaskComplete);
    };
  }, []);

  // 프로젝트 룸 join/leave — projectId 변경 시에만 실행
  useEffect(() => {
    if (!projectId) return;
    const socket = getSocket();
    const joinProject = () => socket.emit('join:project', projectId);
    if (socket.connected) joinProject();
    socket.on('connect', joinProject);
    return () => {
      socket.off('connect', joinProject);
      socket.emit('leave:project', projectId);
    };
  }, [projectId]);

  // 세션 룸 join/leave — sessionId 변경 시에만 실행
  useEffect(() => {
    if (!sessionId) return;
    const socket = getSocket();
    const joinSession = () => socket.emit('join:session', sessionId);
    if (socket.connected) joinSession();
    socket.on('connect', joinSession);
    return () => {
      socket.off('connect', joinSession);
      socket.emit('leave:session', sessionId);
    };
  }, [sessionId]);
}

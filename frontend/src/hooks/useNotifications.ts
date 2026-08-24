// 알림 관련 TanStack Query 훅 — 조회, 읽음 처리, 전체 읽음, 삭제

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { apiFetch } from '@/lib/api';
import { useRealtimeStore } from '@/stores/realtimeStore';
import type { Notification } from '@/types/realtime';

/** 알림 목록 조회 쿼리 키 */
export const NOTIFICATIONS_KEY = ['notifications'] as const;

/** 서버에서 알림 목록 가져오기 */
async function fetchNotifications(): Promise<Notification[]> {
  // 백엔드가 배열을 직접 반환하므로 래핑 없이 사용
  return apiFetch<Notification[]>('/api/notifications');
}

/** 알림 읽음 처리 */
async function markNotificationRead(id: string): Promise<void> {
  await apiFetch(`/api/notifications/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ isRead: true }),
  });
}

/** 전체 알림 읽음 처리 */
async function markAllNotificationsRead(): Promise<void> {
  await apiFetch('/api/notifications/read-all', { method: 'PATCH' });
}

/** 알림 삭제 */
async function deleteNotification(id: string): Promise<void> {
  await apiFetch(`/api/notifications/${id}`, { method: 'DELETE' });
}

/** 알림 목록 TanStack Query 훅 — realtimeStore와 동기화 */
export function useNotifications() {
  const queryClient = useQueryClient();
  const { initNotifications, markAsRead, markAllAsRead } = useRealtimeStore();

  // 서버 알림 목록 조회
  const query = useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: fetchNotifications,
    staleTime: 30_000, // 30초 캐시
  });

  // 초기 로드 시 realtimeStore 동기화 (알림 목록 + 미읽음 수)
  useEffect(() => {
    if (query.data) {
      initNotifications(query.data);
    }
  }, [query.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // 읽음 처리 mutation
  const readMutation = useMutation({
    mutationFn: markNotificationRead,
    onSuccess: (_, id) => {
      markAsRead(id);
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    },
  });

  // 전체 읽음 처리 mutation
  const readAllMutation = useMutation({
    mutationFn: markAllNotificationsRead,
    onSuccess: () => {
      markAllAsRead();
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    },
  });

  // 삭제 mutation
  const deleteMutation = useMutation({
    mutationFn: deleteNotification,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    },
  });

  return {
    notifications: query.data ?? [],
    isLoading: query.isLoading,
    markAsRead: readMutation.mutate,
    markAllAsRead: readAllMutation.mutate,
    deleteNotification: deleteMutation.mutate,
  };
}

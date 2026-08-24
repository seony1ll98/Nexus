'use client';
// 오프라인 상태 감지 배너 — navigator.onLine + online/offline 이벤트

import { useSyncExternalStore } from 'react';
import { WifiOff } from 'lucide-react';

/** online/offline 이벤트 구독 — 브라우저 외부 상태이므로 useSyncExternalStore를 사용 */
function subscribeToNetwork(onChange: () => void) {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

/** 네트워크 연결이 끊길 때 상단에 표시되는 빨간 배너 */
export function OfflineBanner() {
  const isOnline = useSyncExternalStore(
    subscribeToNetwork,
    () => navigator.onLine, // 클라이언트 스냅샷
    () => true,             // SSR 스냅샷 — 서버에서는 온라인으로 가정
  );

  // 온라인 상태면 렌더링하지 않음
  if (isOnline) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white"
      style={{ backgroundColor: '#DC2626' }}
    >
      <WifiOff size={16} aria-hidden="true" />
      <span>네트워크 연결이 끊겼습니다. 인터넷 연결을 확인해주세요.</span>
    </div>
  );
}

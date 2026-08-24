/** 사용자 정보 타입 */
export interface User {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'member';
  linuxUser?: string;
  authMode: 'subscription' | 'api';
  createdAt?: string;
  // Claude OAuth 연동 여부 (subscription 모드에서 사용)
  claudeConnected?: boolean;
  // Claude 구독 플랜 ('pro' | 'max' 등) — 연동 시 서버에서 반환
  claudeSubscriptionType?: string;
  // 알림 설정
  phone?: string | null;
  notifySms?: boolean;
  notifyBrowser?: boolean;
  notifySound?: boolean;
  /**
   * Linux 계정 생성이 실패했거나 지원되지 않을 때 서버가 담아 보내는 안내.
   * 사용자 정보 수정 자체는 성공한 상태이며, 터미널을 열 때 다시 시도된다.
   */
  provisionWarning?: string;
}

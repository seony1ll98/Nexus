'use client';
// 터미널 패널 — 드래그로 높이 조절 가능한 하단 패널 + 멀티탭 지원

import { useRef, useCallback, useEffect, useState } from 'react';
import { X, Minus } from 'lucide-react';
import { Terminal } from './Terminal';
import { TerminalTabBar, type TerminalTab } from './TerminalTabBar';

interface TerminalPanelProps {
  isOpen: boolean;
  height: number;
  onHeightChange: (h: number) => void;
  onClose: () => void;
  sessionId: string;
  projectId: string;
}

const MIN_HEIGHT = 120;
const MAX_HEIGHT = 600;
/** 최대 동시 터미널 탭 수 — 백엔드 MAX_USER_SESSIONS와 일치해야 함 */
const MAX_TABS = 4;

/** 탭 ID 생성 — 고유 식별자 */
function genTabId(): string {
  return `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 첫 번째 탭 — 서버/클라이언트 렌더가 일치하도록 ID를 고정한다 */
const FIRST_TAB: TerminalTab = { id: 'term-1', label: '터미널 1' };

export function TerminalPanel({
  isOpen,
  height,
  onHeightChange,
  onClose,
  sessionId,
  projectId,
}: TerminalPanelProps) {
  // 드래그 활성 여부 — 트랜지션 비활성화에 사용
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  // 탭 상태 — 첫 탭은 마운트 시 바로 준비한다.
  // effect 안에서 setState로 만들면 불필요한 연쇄 렌더가 발생하므로 초기값으로 둔다.
  // 첫 탭 ID는 SSR/클라이언트가 동일해야 하므로 고정값을 쓴다(이후 탭만 genTabId 사용).
  const [tabs, setTabs] = useState<TerminalTab[]>([FIRST_TAB]);
  const [activeTabId, setActiveTabId] = useState<string>(FIRST_TAB.id);

  /** 새 탭 추가 */
  const handleNewTab = useCallback(() => {
    setTabs((prev) => {
      if (prev.length >= MAX_TABS) return prev;
      const nextNum = prev.length + 1;
      const newTab: TerminalTab = { id: genTabId(), label: `터미널 ${nextNum}` };
      setActiveTabId(newTab.id);
      return [...prev, newTab];
    });
  }, []);

  /** 탭 닫기 */
  const handleCloseTab = useCallback((id: string) => {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const remaining = tabs.filter((t) => t.id !== id);

    // 마지막 탭을 닫으면 패널 자체를 닫고, 다음 오픈을 위해 새 탭을 하나 준비해 둔다
    if (remaining.length === 0) {
      const fresh: TerminalTab = { id: genTabId(), label: '터미널 1' };
      setTabs([fresh]);
      setActiveTabId(fresh.id);
      onClose();
      return;
    }

    setTabs(remaining);
    // 활성 탭이 닫힌 경우 인접 탭으로 이동
    if (id === activeTabId) {
      setActiveTabId(remaining[Math.min(idx, remaining.length - 1)].id);
    }
  }, [tabs, activeTabId, onClose]);

  /** 드래그 시작 — mousedown 이벤트 */
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startH: height };
      setIsDragging(true);
    },
    [height],
  );

  /** 드래그 중 — mousemove로 높이 계산 */
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = dragRef.current.startY - e.clientY;
      const newH = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragRef.current.startH + delta));
      onHeightChange(newH);
    };

    const onMouseUp = () => {
      if (dragRef.current) {
        dragRef.current = null;
        setIsDragging(false);
      }
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [onHeightChange]);

  return (
    <div
      className="shrink-0 flex flex-col overflow-hidden"
      style={{
        height: isOpen ? `${height}px` : '0px',
        transition: isDragging ? 'none' : 'height 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        borderTop: isOpen ? '1px solid #333' : 'none',
        backgroundColor: '#282A36',
      }}
    >
      {/* 드래그 핸들 + 헤더 */}
      <div
        onMouseDown={handleDragStart}
        className="flex items-center justify-between px-3 shrink-0 select-none"
        style={{
          height: '28px',
          cursor: 'row-resize',
          backgroundColor: '#1A1A2E',
          borderBottom: '1px solid #333',
          userSelect: 'none',
        }}
      >
        <div className="flex items-center gap-2">
          <Minus size={12} style={{ color: '#9CA3AF' }} />
          <span className="text-xs font-medium" style={{ color: '#9CA3AF' }}>
            터미널
          </span>
        </div>

        <button
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onClose}
          className="p-1 rounded transition-colors"
          style={{ color: '#9CA3AF' }}
          onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = '#3C3C3C')}
          onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
          aria-label="터미널 닫기"
        >
          <X size={14} />
        </button>
      </div>

      {/* 탭 바 */}
      {isOpen && tabs.length > 0 && (
        <TerminalTabBar
          tabs={tabs}
          activeId={activeTabId}
          onSelect={setActiveTabId}
          onClose={handleCloseTab}
          onNew={handleNewTab}
          maxTabs={MAX_TABS}
        />
      )}

      {/* 터미널 영역 — 각 탭의 인스턴스를 유지하되 활성 탭만 표시 */}
      {isOpen && (
        <div className="flex-1 relative overflow-hidden">
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className="absolute inset-0"
              style={{ display: tab.id === activeTabId ? 'block' : 'none' }}
            >
              <Terminal sessionId={`${sessionId}:${tab.id}`} projectId={projectId} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

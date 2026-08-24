// 사용자 수정 다이얼로그 컴포넌트
'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUpdateUser } from '@/hooks/useUsers';
import type { User } from '@/types/user';

interface Props {
  user: User | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** 네이티브 셀렉트 스타일 클래스 */
const selectClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';

/**
 * 사용자 수정 다이얼로그.
 * 폼 상태 초기화는 내부 EditUserForm에 위임한다 — user.id를 key로 주어
 * 대상 사용자가 바뀌면 컴포넌트가 새로 마운트되며 상태가 자연스럽게 초기화된다.
 * (effect 안에서 setState를 호출하는 방식은 불필요한 연쇄 렌더를 유발한다)
 */
export function EditUserDialog({ user, open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[#1A1A1A]">사용자 수정</DialogTitle>
        </DialogHeader>
        {user && <EditUserForm key={user.id} user={user} onOpenChange={onOpenChange} />}
      </DialogContent>
    </Dialog>
  );
}

/** 실제 폼 — 마운트 시 user 값으로 상태를 초기화한다 */
function EditUserForm({ user, onOpenChange }: { user: User; onOpenChange: (open: boolean) => void }) {
  const [form, setForm] = useState({
    name: user.name,
    role: user.role,
    authMode: user.authMode,
    linuxUser: user.linuxUser ?? '',
    newPassword: '',
  });
  const [error, setError] = useState('');
  // 저장은 됐지만 Linux 계정 생성이 실패한 경우의 안내
  const [warning, setWarning] = useState('');
  const { mutateAsync, isPending } = useUpdateUser();

  const set = <K extends keyof typeof form>(key: K, value: typeof form[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setWarning('');
    try {
      const result = await mutateAsync({
        id: user.id,
        data: {
          name: form.name,
          role: form.role,
          authMode: form.authMode,
          linuxUser: form.linuxUser || undefined,
          ...(form.newPassword && { newPassword: form.newPassword }),
        },
      });

      // 계정 생성 경고가 있으면 다이얼로그를 닫지 않고 그대로 보여준다
      if (result?.provisionWarning) {
        setWarning(result.provisionWarning);
        return;
      }
      onOpenChange(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '수정 실패');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="eu-name">이름</Label>
        <Input id="eu-name" value={form.name} onChange={(e) => set('name', e.target.value)} required />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="eu-role">역할</Label>
          <select
            id="eu-role"
            className={selectClass}
            value={form.role}
            onChange={(e) => set('role', e.target.value as 'admin' | 'member')}
          >
            <option value="member">멤버</option>
            <option value="admin">관리자</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="eu-auth">인증 모드</Label>
          <select
            id="eu-auth"
            className={selectClass}
            value={form.authMode}
            onChange={(e) => set('authMode', e.target.value as 'subscription' | 'api')}
          >
            <option value="subscription">구독</option>
            <option value="api">API 키</option>
          </select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="eu-linux">리눅스 사용자명</Label>
        <Input id="eu-linux" value={form.linuxUser} onChange={(e) => set('linuxUser', e.target.value)} placeholder="예: john" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="eu-pw">새 비밀번호 (변경 시에만 입력)</Label>
        <Input id="eu-pw" type="password" value={form.newPassword} onChange={(e) => set('newPassword', e.target.value)} minLength={6} placeholder="변경하지 않으면 공백으로 두세요" />
      </div>
      {error && <p className="text-sm text-red-500">{error}</p>}
      {warning && (
        <p className="text-sm" style={{ color: '#E0845E' }}>
          저장은 완료됐습니다. 다만 {warning}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>취소</Button>
        <Button type="submit" disabled={isPending} className="bg-[#2D7D7B] hover:bg-[#236160] text-white">
          {isPending ? '저장 중...' : '저장'}
        </Button>
      </DialogFooter>
    </form>
  );
}

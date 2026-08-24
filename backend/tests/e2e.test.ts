// E2E 테스트 — 실제 서버에 HTTP 요청을 보내 핵심 기능 검증
// 실행: cd backend && npm test
// 전제조건: 서버가 localhost:8080에서 실행 중이어야 함
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const API = process.env.TEST_API_URL || 'http://localhost:8080';
const TEST_EMAIL = process.env.TEST_EMAIL ?? '';
const TEST_PASSWORD = process.env.TEST_PASSWORD ?? '';

if (!TEST_EMAIL || !TEST_PASSWORD) {
  throw new Error('TEST_EMAIL, TEST_PASSWORD 환경변수가 필요합니다');
}

/**
 * 권한 회귀 테스트용 비멤버 계정.
 * 어느 프로젝트에도 소속되지 않은 일반 멤버로, 세션 라우트 접근이 전부 차단되어야 한다.
 */
const OUTSIDER_EMAIL = process.env.TEST_OUTSIDER_EMAIL ?? 'e2e-outsider@nexus.local';
const OUTSIDER_PASSWORD = process.env.TEST_OUTSIDER_PASSWORD ?? 'E2eOutsider!2026';
const OUTSIDER_NAME = 'E2E 비멤버';

/** 락 경합 테스트용 두 번째 멤버 계정 */
const RIVAL_EMAIL = process.env.TEST_RIVAL_EMAIL ?? 'e2e-rival@nexus.local';
const RIVAL_PASSWORD = process.env.TEST_RIVAL_PASSWORD ?? 'E2eRival!2026';

/** 쿠키 저장소 */
let sessionCookie = '';
let outsiderCookie = '';
let currentUserId = '';
let projectId = '';
let testSessionId = '';

/** 인증된 fetch — POST body가 없으면 Content-Type 생략 */
async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = { Cookie: sessionCookie };
  // body가 있을 때만 Content-Type 설정 (Fastify가 빈 body + json content-type이면 400 반환)
  if (init?.body) headers['Content-Type'] = 'application/json';
  return fetch(`${API}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers || {}) },
  });
}

// ────────────────────────────────────────────
// 0. 사전 준비 — 로그인 + 기본 데이터 로드
// ────────────────────────────────────────────
beforeAll(async () => {
  // 로그인
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  if (res.status !== 200) {
    throw new Error(`로그인 실패: ${res.status} — ${await res.text()}`);
  }
  const body = await res.json();
  currentUserId = body.user.id;

  const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  const cookie = setCookie.find((c: string) => c.includes('connect.sid'));
  if (!cookie) throw new Error('세션 쿠키 없음');
  sessionCookie = cookie.split(';')[0];

  // 프로젝트 목록 로드
  const projRes = await authFetch('/api/projects');
  const projBody = await projRes.json();
  const projects = projBody.data ?? projBody;
  if (projects.length > 0) {
    projectId = projects[0].id;
  }

  // 세션 목록 로드
  if (projectId) {
    const sessRes = await authFetch(`/api/sessions?projectId=${projectId}`);
    const sessBody = await sessRes.json();
    const sessions = Array.isArray(sessBody) ? sessBody : (sessBody.data ?? []);
    if (sessions.length > 0) {
      testSessionId = sessions[0].id;
    }
  }

  // 비멤버 계정 준비 — 권한 회귀 테스트용
  // 이미 존재하면 409가 나므로 무시하고 로그인만 시도한다
  await authFetch('/api/users', {
    method: 'POST',
    body: JSON.stringify({
      name: OUTSIDER_NAME,
      email: OUTSIDER_EMAIL,
      password: OUTSIDER_PASSWORD,
      role: 'member',
    }),
  });

  const outRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OUTSIDER_EMAIL, password: OUTSIDER_PASSWORD }),
  });
  if (outRes.status !== 200) {
    throw new Error(`비멤버 로그인 실패: ${outRes.status} — ${await outRes.text()}`);
  }
  const outCookies = outRes.headers.getSetCookie?.() ?? [outRes.headers.get('set-cookie') ?? ''];
  const outCookie = outCookies.find((c: string) => c.includes('connect.sid'));
  if (!outCookie) throw new Error('비멤버 세션 쿠키 없음');
  outsiderCookie = outCookie.split(';')[0];
});

// ────────────────────────────────────────────
// 1. 헬스 체크
// ────────────────────────────────────────────
describe('헬스 체크', () => {
  it('GET /api/health → 200', async () => {
    const res = await fetch(`${API}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});

// ────────────────────────────────────────────
// 2. 인증
// ────────────────────────────────────────────
describe('인증', () => {
  it('인증 없이 보호된 API → 401', async () => {
    const res = await fetch(`${API}/api/projects`);
    expect(res.status).toBe(401);
  });

  it('GET /api/auth/me → 현재 사용자', async () => {
    const res = await authFetch('/api/auth/me');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe(TEST_EMAIL);
    expect(body.id).toBeDefined();
  });
});

// ────────────────────────────────────────────
// 3. 프로젝트
// ────────────────────────────────────────────
describe('프로젝트', () => {
  it('GET /api/projects → 프로젝트 목록', async () => {
    const res = await authFetch('/api/projects');
    expect(res.status).toBe(200);
    const body = await res.json();
    const projects = body.data ?? body;
    expect(Array.isArray(projects)).toBe(true);
    expect(projects.length).toBeGreaterThan(0);
  });

  it('GET /api/projects/:id → 단일 프로젝트', async () => {
    if (!projectId) return;
    const res = await authFetch(`/api/projects/${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(projectId);
    expect(body.name).toBeDefined();
  });
});

// ────────────────────────────────────────────
// 4. 세션
// ────────────────────────────────────────────
describe('세션', () => {
  it('GET /api/sessions?projectId → 세션 목록', async () => {
    if (!projectId) return;
    const res = await authFetch(`/api/sessions?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    const sessions = Array.isArray(body) ? body : (body.data ?? []);
    expect(Array.isArray(sessions)).toBe(true);
  });

  it('GET /api/sessions/:id → 세션 상세', async () => {
    if (!testSessionId) return;
    const res = await authFetch(`/api/sessions/${testSessionId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(testSessionId);
    expect(body.title).toBeDefined();
    expect(body.projectId).toBe(projectId);
  });

  it('존재하지 않는 세션 → 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res = await authFetch(`/api/sessions/${fakeId}`);
    expect(res.status).toBe(404);
  });
});

// ────────────────────────────────────────────
// 5. 메시지 조회 (하이브리드 JSONL/DB)
// ────────────────────────────────────────────
describe('메시지 조회', () => {
  it('GET messages → 기본 페이지네이션', async () => {
    if (!testSessionId) return;
    const res = await authFetch(`/api/sessions/${testSessionId}/messages`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toBeDefined();
    expect(body.pagination).toBeDefined();
    expect(body.pagination.page).toBeGreaterThanOrEqual(1);
    expect(body.pagination.totalPages).toBeGreaterThanOrEqual(1);
  });

  it('page=-1 → 마지막 페이지', async () => {
    if (!testSessionId) return;
    const res = await authFetch(`/api/sessions/${testSessionId}/messages?page=-1&limit=10`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pagination.page).toBe(body.pagination.totalPages);
  });

  it('메시지 role은 user 또는 assistant만', async () => {
    if (!testSessionId) return;
    const res = await authFetch(`/api/sessions/${testSessionId}/messages?limit=200`);
    const body = await res.json();
    for (const msg of body.messages) {
      expect(['user', 'assistant']).toContain(msg.role);
      expect(msg.content).toBeDefined();
      expect(typeof msg.content).toBe('string');
    }
  });

  it('메시지에 시스템 태그 미포함', async () => {
    if (!testSessionId) return;
    const res = await authFetch(`/api/sessions/${testSessionId}/messages?limit=200`);
    const body = await res.json();
    const systemTags = [
      '<system-reminder>', '<task-notification>',
      '<local-command-caveat>', '<user-prompt-submit-hook>',
    ];
    for (const msg of body.messages) {
      if (msg.role === 'user') {
        for (const tag of systemTags) {
          expect(msg.content).not.toContain(tag);
        }
      }
    }
  });

  it('세션 간 메시지 ID 겹침 없음', async () => {
    if (!projectId) return;
    const sessRes = await authFetch(`/api/sessions?projectId=${projectId}`);
    const sessBody = await sessRes.json();
    const sessions = (Array.isArray(sessBody) ? sessBody : (sessBody.data ?? [])).slice(0, 3);
    if (sessions.length < 2) return;

    const allIds: Map<string, string> = new Map(); // msgId → sessionId
    for (const s of sessions) {
      const res = await authFetch(`/api/sessions/${s.id}/messages?limit=200`);
      const body = await res.json();
      for (const msg of body.messages) {
        if (allIds.has(msg.id)) {
          // 같은 ID가 다른 세션에서 나오면 실패
          expect(allIds.get(msg.id)).toBe(s.id);
        }
        allIds.set(msg.id, s.id);
      }
    }
  });
});

// ────────────────────────────────────────────
// 6. 세션 락
// ────────────────────────────────────────────
describe('세션 락', () => {
  it('락 획득 → 해제 사이클', async () => {
    if (!testSessionId) return;
    // 획득
    const lockRes = await authFetch(`/api/sessions/${testSessionId}/lock`, { method: 'POST' });
    expect(lockRes.status).toBe(200);
    const lockBody = await lockRes.json();
    expect(lockBody.lockedBy).toBeDefined();

    // 해제
    const unlockRes = await authFetch(`/api/sessions/${testSessionId}/unlock`, { method: 'POST' });
    expect(unlockRes.status).toBe(200);
    const unlockBody = await unlockRes.json();
    expect(unlockBody.lockedBy).toBeNull();
  });

  /**
   * 동시 획득 경합 (F8 회귀 방지).
   *
   * 예전에는 "읽고 → 쓰기" 방식이라 동시 요청 둘이 모두 미잠금 상태를 읽고
   * 둘 다 성공했다. 조건부 UPDATE로 바꾼 뒤에는 정확히 하나만 200,
   * 나머지는 409를 받아야 한다.
   */
  it('서로 다른 사용자의 동시 락 요청 — 정확히 한 명만 획득', async () => {
    if (!testSessionId) throw new Error('테스트 세션이 없습니다');
    if (!projectId) throw new Error('프로젝트가 없습니다');

    // 경합 상대 계정 준비 — 같은 프로젝트의 멤버여야 락 API에 도달한다
    await authFetch('/api/users', {
      method: 'POST',
      body: JSON.stringify({
        name: 'E2E 락 경합',
        email: RIVAL_EMAIL,
        password: RIVAL_PASSWORD,
        role: 'member',
      }),
    });

    const rivalLogin = await fetch(`${API}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: RIVAL_EMAIL, password: RIVAL_PASSWORD }),
    });
    expect(rivalLogin.status, '경합 계정 로그인').toBe(200);
    const rivalId = (await rivalLogin.json()).user.id as string;
    const rivalCookies = rivalLogin.headers.getSetCookie?.() ?? [];
    const rivalCookie = (rivalCookies.find((c: string) => c.includes('connect.sid')) ?? '').split(';')[0];
    expect(rivalCookie).toBeTruthy();

    // 프로젝트 멤버로 추가 (이미 멤버면 409 — 무시)
    await authFetch(`/api/projects/${projectId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId: rivalId, role: 'member' }),
    });

    // 잠기지 않은 상태에서 시작
    await authFetch(`/api/sessions/${testSessionId}/unlock`, { method: 'POST' });

    const lockAs = (cookie: string) =>
      fetch(`${API}/api/sessions/${testSessionId}/lock`, {
        method: 'POST',
        headers: { Cookie: cookie },
      });

    // 서로 다른 사용자가 동시에 락을 요청한다.
    // 경합 구간이 좁으므로 여러 라운드를 반복해 확률을 높인다.
    for (let round = 0; round < 20; round++) {
      await authFetch(`/api/sessions/${testSessionId}/unlock`, { method: 'POST' });
      await fetch(`${API}/api/sessions/${testSessionId}/unlock`, {
        method: 'POST', headers: { Cookie: rivalCookie },
      }).catch(() => null);

      const [a1, r1, a2, r2] = await Promise.all([
        lockAs(sessionCookie), lockAs(rivalCookie),
        lockAs(sessionCookie), lockAs(rivalCookie),
      ]);

      // 같은 사용자의 반복 요청은 200이 여러 번 나올 수 있다(이미 본인 락).
      // 검증할 불변식은 "서로 다른 두 사용자가 동시에 획득하지 못한다"이다.
      const adminWon = [a1.status, a2.status].includes(200);
      const rivalWon = [r1.status, r2.status].includes(200);
      expect(
        adminWon && rivalWon,
        `라운드 ${round}: 두 사용자가 동시에 락을 획득했다 `
        + `(admin=${a1.status},${a2.status} / rival=${r1.status},${r2.status})`,
      ).toBe(false);
    }

    // 최종 소유자는 200을 받은 쪽 하나뿐
    const detail = await authFetch(`/api/sessions/${testSessionId}`);
    const body = await detail.json();
    expect([currentUserId, rivalId]).toContain(body.lockedBy);

    // 정리 — 소유자가 누구든 해제되도록 양쪽 모두 시도
    await authFetch(`/api/sessions/${testSessionId}/unlock`, { method: 'POST' });
    await fetch(`${API}/api/sessions/${testSessionId}/unlock`, {
      method: 'POST',
      headers: { Cookie: rivalCookie },
    }).catch(() => null);
  });
});

// ────────────────────────────────────────────
// 7. 채팅 중단
// ────────────────────────────────────────────
describe('채팅 중단', () => {
  it('실행 중인 작업 없을 때 abort → 404', async () => {
    if (!testSessionId) return;
    const res = await authFetch(`/api/sessions/${testSessionId}/abort`, { method: 'POST' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

// ────────────────────────────────────────────
// 8. 알림
// ────────────────────────────────────────────
describe('알림', () => {
  it('GET /api/notifications → 알림 목록', async () => {
    const res = await authFetch('/api/notifications');
    expect(res.status).toBe(200);
  });
});

// ────────────────────────────────────────────
// 9. 사용자 관리
// ────────────────────────────────────────────
describe('사용자 관리', () => {
  it('사용자 목록 — 비밀번호 미노출', async () => {
    const res = await authFetch('/api/users');
    expect(res.status).toBe(200);
    const body = await res.json();
    const users = body.users ?? body.data ?? body;
    expect(Array.isArray(users)).toBe(true);
    expect(users.length).toBeGreaterThan(0);
    for (const user of users) {
      expect(user.passwordHash).toBeUndefined();
      expect(user.password_hash).toBeUndefined();
    }
  });
});

// ────────────────────────────────────────────
// 10. 에러 형식 일관성
// ────────────────────────────────────────────
describe('에러 응답 형식', () => {
  it('404 → { error: { code, message } }', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res = await authFetch(`/api/sessions/${fakeId}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(typeof body.error.code).toBe('string');
    expect(typeof body.error.message).toBe('string');
  });
});

// ────────────────────────────────────────────
// 11. 세션 권한 경계 (회귀 방지)
//
// 세션 하위 라우트는 sessions/index.ts의 공통 preHandler 훅에서 일괄 검증된다.
// 라우트를 추가하면서 훅 등록 순서를 잘못 두면 이 묶음이 실패한다.
// ────────────────────────────────────────────
describe('세션 권한 경계 — 비멤버 차단', () => {
  /**
   * 프로브 전용 세션.
   * DELETE/PATCH/merge까지 검증하므로, 가드가 깨졌을 때 실제 작업 세션이
   * 손상되지 않도록 일회용 세션을 따로 만들어 쓴다.
   */
  let probeSessionId = '';
  /** 과차단 회귀 확인용 — 파괴적 프로브의 영향을 받지 않도록 별도로 만든다 */
  let memberSessionId = '';

  /** 프로젝트 직속 세션 생성 (worktree 없이 가볍게) */
  async function createSession(title: string): Promise<string> {
    const res = await authFetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ projectId, title }),
    });
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`세션 생성 실패(${title}): ${res.status} — ${await res.text()}`);
    }
    return (await res.json()).id;
  }

  beforeAll(async () => {
    if (!projectId) throw new Error('프로젝트가 없습니다');
    probeSessionId = await createSession('E2E 권한 프로브 세션');
    memberSessionId = await createSession('E2E 멤버 접근 확인 세션');
  });

  afterAll(async () => {
    // 임시 세션 정리 (이미 삭제되었으면 무시)
    for (const id of [probeSessionId, memberSessionId]) {
      if (id) await authFetch(`/api/sessions/${id}`, { method: 'DELETE' }).catch(() => null);
    }
  });

  /** 비멤버 쿠키로 호출 */
  async function asOutsider(path: string, method = 'GET', body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { Cookie: outsiderCookie };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${API}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  /** 검증 대상 — 세션 :id 하위 라우트 전체 */
  const routes: Array<[string, string, string, unknown?]> = [
    ['세션 상세',   'GET',    '',              undefined],
    ['메시지 조회', 'GET',    '/messages',     undefined],
    ['채팅 전송',   'POST',   '/chat',         { message: '권한 검증' }],
    ['락 획득',     'POST',   '/lock',         undefined],
    ['락 해제',     'POST',   '/unlock',       undefined],
    ['락 요청',     'POST',   '/lock-request', { message: '부탁' }],
    ['merge',       'POST',   '/merge',        undefined],
    ['중단',        'POST',   '/abort',        undefined],
    ['세션 수정',   'PATCH',  '',              { title: '변경 시도' }],
    ['세션 삭제',   'DELETE', '',              undefined],
  ];

  for (const [label, method, suffix, body] of routes) {
    it(`${label} — 비멤버는 FORBIDDEN`, async () => {
      const res = await asOutsider(`/api/sessions/${probeSessionId}${suffix}`, method, body);
      const where = `${method} /api/sessions/:id${suffix}`;
      expect(res.status, where).toBe(403);
      // 상태 코드만 보면 CLAUDE_NOT_CONNECTED 같은 다른 403에 속을 수 있으므로
      // 권한 거부 코드 자체를 확인한다
      const errBody = await res.json();
      expect(errBody.error?.code, `${where} — 403의 사유`).toBe('FORBIDDEN');
    });
  }

  it('정상 멤버는 그대로 접근 가능 (과차단 회귀 방지)', async () => {
    const detail = await authFetch(`/api/sessions/${memberSessionId}`);
    expect(detail.status).toBe(200);
    const messages = await authFetch(`/api/sessions/${memberSessionId}/messages`);
    expect(messages.status).toBe(200);
  });
});

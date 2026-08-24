// 웹 터미널 서비스 — node-pty 기반 프로세스 관리
// Linux 유저 분리: runAsUser가 지정되면 sudo -u로 실행
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Socket } from 'socket.io';

/** pty 인터페이스 — node-pty와 fallback 공용 */
interface PtyProcess {
  write: (data: string) => void;
  resize?: (cols: number, rows: number) => void;
  kill: () => void;
}

/** 터미널 세션 항목 — pty 프로세스, 소유 userId, 마지막 활동 시각, socket 참조 */
interface TerminalEntry {
  pty: PtyProcess;
  userId: string;
  /** 마지막 입력/시작 시각 (유휴 타임아웃 계산용) */
  lastActivity: number;
  /** 타임아웃 이벤트 전송을 위한 socket 참조 */
  socket: Socket;
}

/** 전체 동시 터미널 세션 최대 수 */
const MAX_TOTAL_SESSIONS = 40;

/** 사용자 1인당 최대 터미널 세션 수 — 멀티탭 지원 */
const MAX_USER_SESSIONS = 4;

/** 유휴 세션 자동 종료 시간 — 15분 */
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** socketId → 터미널 세션 항목 매핑 */
const ptyMap = new Map<string, TerminalEntry>();

// 1분마다 유휴 세션 정리
const idleCheckInterval = setInterval(() => {
  const now = Date.now();
  for (const [socketId, entry] of ptyMap.entries()) {
    if (now - entry.lastActivity > IDLE_TIMEOUT_MS) {
      entry.pty.kill();
      ptyMap.delete(socketId);
      // 클라이언트에 타임아웃 이벤트 전송
      try { entry.socket.emit('terminal:timeout', { message: '유휴 상태로 인해 터미널 세션이 종료되었습니다 (15분)' }); } catch { /* 소켓 이미 닫힘 */ }
    }
  }
}, 60_000);

/** node-pty 동적 로드 시도 */
async function tryLoadNodePty() {
  try {
    const pty = await import('node-pty');
    return pty.default ?? pty;
  } catch {
    return null;
  }
}

/**
 * 실행할 명령어와 인자 결정 — runAsUser가 있으면 그 계정으로 셸을 띄운다.
 *
 * 절대 경로(/bin/bash)를 쓰는 이유: sudoers 화이트리스트가
 * `appuser ALL=(%devusers) NOPASSWD: /bin/bash` 형태로 명령을 특정하므로,
 * 경로가 다르면 권한 검사에 걸린다.
 * `-i` 대신 `-l`(로그인 셸)을 쓰면 실행되는 명령이 그대로 /bin/bash가 되어
 * sudoers 규칙과 정확히 맞는다.
 */
function resolveCommand(runAsUser?: string): { cmd: string; args: string[] } {
  if (runAsUser) {
    return { cmd: 'sudo', args: ['-u', runAsUser, '/bin/bash', '-l'] };
  }
  return { cmd: 'bash', args: [] };
}

/**
 * cwd 경로에서 명령 인젝션에 악용될 수 있는 특수문자를 이스케이프
 * 큰따옴표, 백슬래시, $, 백틱, 개행문자를 제거/이스케이프
 */
function escapeCwd(cwd: string): string {
  // 개행/캐리지리턴 완전 제거 — 명령 인젝션 벡터 차단
  return cwd
    .replace(/[\r\n]/g, '')
    .replace(/["\\`$]/g, (c) => `\\${c}`);
}

/** PTY에 전달할 안전한 환경변수 — 민감 정보 제외 */
function getSafeEnv(): Record<string, string> {
  const safe: Record<string, string> = {};
  const ALLOWED_KEYS = [
    'HOME', 'USER', 'SHELL', 'PATH', 'LANG', 'LC_ALL', 'TERM',
    'COLORTERM', 'EDITOR', 'VISUAL', 'PAGER',
    'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME',
  ];
  for (const key of ALLOWED_KEYS) {
    if (process.env[key]) safe[key] = process.env[key]!;
  }
  safe.TERM = 'xterm-256color';
  return safe;
}

/** node-pty로 bash 스폰 */
async function spawnWithNodePty(
  cwd: string,
  cols: number,
  rows: number,
  runAsUser?: string,
): Promise<{ pty: PtyProcess; onData: (cb: (data: string) => void) => void } | null> {
  const pty = await tryLoadNodePty();
  if (!pty) return null;

  const { cmd, args } = resolveCommand(runAsUser);

  const ptyProc = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols,
    rows,
    // sudo -i 없이 직접 실행 시 cwd 옵션으로 안전하게 전달 (셸 인젝션 없음)
    cwd: runAsUser ? undefined : cwd,
    env: getSafeEnv(),
  });

  // runAsUser 시 시작 디렉토리를 수동 이동 — 특수문자 이스케이프 후 큰따옴표로 감싸기
  if (runAsUser) {
    ptyProc.write(`cd "${escapeCwd(cwd)}" 2>/dev/null\n`);
  }

  return {
    pty: {
      write: (data: string) => ptyProc.write(data),
      resize: (c: number, r: number) => { try { ptyProc.resize(c, r); } catch { /* 이미 닫힌 PTY 무시 */ } },
      kill: () => { try { ptyProc.kill(); } catch { /* 무시 */ } },
    },
    onData: (cb) => { ptyProc.onData(cb); },
  };
}

/** child_process.spawn으로 bash 스폰 (fallback) */
function spawnWithChildProcess(
  cwd: string,
  runAsUser?: string,
): { pty: PtyProcess; onData: (cb: (data: string) => void) => void } {
  const { cmd, args } = resolveCommand(runAsUser);

  const child = spawn(cmd, [...args], {
    cwd: runAsUser ? undefined : cwd,
    env: getSafeEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  const callbacks: Array<(data: string) => void> = [];

  child.stdout.on('data', (data: Buffer) => {
    callbacks.forEach((cb) => cb(data.toString()));
  });
  child.stderr.on('data', (data: Buffer) => {
    callbacks.forEach((cb) => cb(data.toString()));
  });

  // runAsUser 시 시작 디렉토리를 수동 이동 — 특수문자 이스케이프 후 큰따옴표로 감싸기
  if (runAsUser) {
    child.stdin.write(`cd "${escapeCwd(cwd)}" 2>/dev/null\n`);
  }

  return {
    pty: {
      write: (data: string) => { try { child.stdin.write(data); } catch { /* 무시 */ } },
      kill: () => { try { child.kill('SIGTERM'); } catch { /* 무시 */ } },
    },
    onData: (cb) => { callbacks.push(cb); },
  };
}

/** 터미널 세션 시작 — runAsUser로 Linux 유저 분리, 동시 세션 수 제한 적용 */
async function startTerminal(
  socket: Socket,
  userId: string,
  cwd: string,
  cols = 80,
  rows = 24,
  runAsUser?: string,
): Promise<void> {
  // 같은 socket의 기존 세션만 정리 (다른 socket은 별도 탭이므로 유지)
  killTerminal(socket.id);

  // 전체 세션 수 제한 확인
  if (ptyMap.size >= MAX_TOTAL_SESSIONS) {
    throw new Error(`전체 터미널 세션 한도(${MAX_TOTAL_SESSIONS}개)를 초과했습니다`);
  }

  // 사용자별 세션 수 확인 — 초과 시 가장 오래된 세션 종료 (FIFO)
  const userSessions = Array.from(ptyMap.entries()).filter(
    ([, entry]) => entry.userId === userId,
  );
  if (userSessions.length >= MAX_USER_SESSIONS) {
    // 가장 오래된 활동 세션부터 제거 (lastActivity 오름차순)
    userSessions.sort((a, b) => a[1].lastActivity - b[1].lastActivity);
    const [oldestSocketId, oldestEntry] = userSessions[0];
    oldestEntry.pty.kill();
    ptyMap.delete(oldestSocketId);
  }

  let session = await spawnWithNodePty(cwd, cols, rows, runAsUser);
  if (!session) {
    socket.emit('terminal:output', '\r\n[node-pty 미설치 — child_process 모드로 실행]\r\n');
    session = spawnWithChildProcess(cwd, runAsUser);
  }

  const { pty, onData } = session;

  onData((data: string) => {
    socket.emit('terminal:output', data);
  });

  // userId, socket 참조, 마지막 활동 시각과 함께 세션 등록
  ptyMap.set(socket.id, { pty, userId, lastActivity: Date.now(), socket });
}

/** 터미널 입력 처리 — 마지막 활동 시각 갱신 */
function writeInput(socketId: string, data: string): void {
  const entry = ptyMap.get(socketId);
  if (entry) {
    entry.lastActivity = Date.now();
    entry.pty.write(data);
  }
}

/** 터미널 크기 변경 */
function resizeTerminal(socketId: string, cols: number, rows: number): void {
  ptyMap.get(socketId)?.pty.resize?.(cols, rows);
}

/** 터미널 종료 */
function killTerminal(socketId: string): void {
  const entry = ptyMap.get(socketId);
  if (entry) {
    entry.pty.kill();
    ptyMap.delete(socketId);
  }
}

/** 활성 터미널 수 조회 */
function getActiveCount(): number {
  return ptyMap.size;
}

/** 모든 터미널 종료 및 인터벌 정리 — 서버 shutdown 시 호출 */
function destroyAll(): void {
  clearInterval(idleCheckInterval);
  for (const [socketId, entry] of ptyMap.entries()) {
    entry.pty.kill();
    ptyMap.delete(socketId);
  }
}

export const terminalService = {
  startTerminal,
  writeInput,
  resizeTerminal,
  killTerminal,
  getActiveCount,
  destroyAll,
};

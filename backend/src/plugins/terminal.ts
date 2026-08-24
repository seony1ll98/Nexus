// 웹 터미널 Socket.IO 플러그인 — /terminal 네임스페이스
// Linux 유저 분리: admin은 ubuntu, 일반 멤버는 개인 linuxUser로 실행
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { terminalService } from '../services/terminal.service.js';
import prisma from '../lib/prisma.js';
import { linuxUserService } from '../services/linux-user.service.js';

/** 인증된 Socket 타입 확장 */
interface AuthenticatedSocket extends Socket {
  userId: string;
}

/** 터미널 시작 요청 페이로드 */
interface TerminalStartPayload {
  projectId?: string;
  cols?: number;
  rows?: number;
}

/** 터미널 크기 변경 페이로드 */
interface TerminalResizePayload {
  cols: number;
  rows: number;
}

/** 프로젝트 멤버십 검증 후 repoPath 반환 — 비멤버는 null 반환 */
async function resolveWorkingDir(
  projectId: string | undefined,
  userId: string,
): Promise<{ cwd: string; isAdminOnly: boolean } | null> {
  if (!projectId) return null;

  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { repoPath: true, isAdminOnly: true },
    });
    if (!project) return null;

    // 프로젝트 멤버십 검증
    const membership = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    if (!membership) return null;

    return { cwd: project.repoPath, isAdminOnly: project.isAdminOnly };
  } catch {
    return null;
  }
}

/** 유저 정보 조회 — role, linuxUser */
async function resolveUser(userId: string) {
  try {
    return await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, linuxUser: true },
    });
  } catch {
    return null;
  }
}

/** Socket.IO 서버에 터미널 네임스페이스 등록 */
export function registerTerminalNamespace(io: SocketIOServer): void {
  const terminalNsp = io.of('/terminal');

  // 인증 미들웨어 — 세션 쿠키에서 userId 검증
  terminalNsp.use(async (socket, next) => {
    try {
      const cookieHeader = socket.handshake.headers.cookie ?? '';

      // connect.sid 쿠키 파싱 — @fastify/session은 s%3A 접두사 없이 직접 sid를 저장
      // 형식: connect.sid=<sid> 또는 connect.sid=s%3A<sid>.<signature>
      const match = cookieHeader.match(/connect\.sid=(?:s%3A)?([^.;\s]+)/);
      if (!match) {
        return next(new Error('인증이 필요합니다'));
      }

      const sid = decodeURIComponent(match[1]);

      // DB에서 세션 조회
      const session = await prisma.userSession.findUnique({ where: { sid } });
      if (!session) return next(new Error('유효하지 않은 세션'));

      // 세션 만료 확인
      if (session.expire < new Date()) return next(new Error('세션이 만료되었습니다'));

      const sess = session.sess as { userId?: string };
      if (!sess.userId) return next(new Error('인증이 필요합니다'));

      // 인증된 userId를 socket에 저장
      (socket as AuthenticatedSocket).userId = sess.userId;
      next();
    } catch {
      next(new Error('인증 실패'));
    }
  });

  terminalNsp.on('connection', (socket) => {
    // 미들웨어에서 주입된 인증된 userId 사용
    const userId = (socket as AuthenticatedSocket).userId;

    socket.on('terminal:start', async (payload: TerminalStartPayload) => {
      try {
        const { projectId, cols = 80, rows = 24 } = payload ?? {};

        // cols/rows 범위 제한 — 과도한 값으로 인한 메모리 낭비 방지
        const safeCols = Math.min(Math.max(cols, 10), 500);
        const safeRows = Math.min(Math.max(rows, 5), 200);

        // 프로젝트 멤버십 검증 — 비멤버 또는 프로젝트 미지정 시 차단
        const resolved = await resolveWorkingDir(projectId, userId);
        if (!resolved) {
          socket.emit('terminal:error', {
            error: { code: 'FORBIDDEN', message: '프로젝트에 접근 권한이 없습니다' },
          });
          return;
        }

        const user = await resolveUser(userId);
        if (!user) {
          socket.emit('terminal:error', {
            error: { code: 'UNAUTHORIZED', message: '사용자 정보를 확인할 수 없습니다' },
          });
          return;
        }

        const isAdmin = user.role === 'admin';

        // ────────────────────────────────────────────
        // 일반 멤버는 반드시 자기 Linux 계정으로 격리 실행한다.
        // 계정이 없으면 백엔드 프로세스 유저로 실행되어 격리가 무너지므로,
        // 여기서 계정을 보정하고 프로젝트 접근 권한(ACL)을 부여한다.
        // 관리자가 사용자 편집에서 저장할 때도 계정이 만들어지지만,
        // 빠뜨렸을 경우를 대비한 자가 보정 지점이다.
        // ────────────────────────────────────────────
        let runAsUser: string | undefined;

        if (!isAdmin) {
          if (!linuxUserService.isProvisioningSupported()) {
            socket.emit('terminal:error', {
              error: {
                code: 'PROVISIONING_UNSUPPORTED',
                message: '이 서버에서는 팀원 계정 격리를 사용할 수 없어 터미널을 열 수 없습니다 (Linux 전용).',
              },
            });
            return;
          }

          // 계정 준비 → 실패 시 아래 catch에서 사유가 담긴 에러가 전달된다
          runAsUser = (await linuxUserService.ensureLinuxUser(userId)) ?? undefined;
          if (!runAsUser) {
            socket.emit('terminal:error', {
              error: { code: 'NO_LINUX_USER', message: '터미널 사용을 위해 관리자에게 Linux 계정 할당을 요청하세요' },
            });
            return;
          }

          // 이 프로젝트 디렉토리에 접근 권한 부여 (멱등)
          linuxUserService.grantProjectAccess(runAsUser, resolved.cwd);
        }

        await terminalService.startTerminal(socket, userId, resolved.cwd, safeCols, safeRows, runAsUser);
        socket.emit('terminal:ready', {
          cwd: resolved.cwd,
          // 관리자는 백엔드 프로세스 유저로 실행된다 — 환경에 따라 이름이 다르므로
          // 'ubuntu'로 단정하지 않고 실제 프로세스 유저를 보고한다
          user: runAsUser ?? (process.env.USER || process.env.LOGNAME || 'unknown'),
          restricted: !isAdmin,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : '터미널 시작 실패';
        socket.emit('terminal:error', {
          error: { code: 'TERMINAL_START_FAILED', message },
        });
      }
    });

    socket.on('terminal:input', (data: unknown) => {
      // 입력 타입 + 크기 검증 — 비문자열 또는 과도한 입력 차단
      if (typeof data !== 'string' || data.length > 64 * 1024) return;
      terminalService.writeInput(socket.id, data);
    });

    socket.on('terminal:resize', (payload: TerminalResizePayload) => {
      const { cols, rows } = payload ?? {};
      if (!cols || !rows || cols <= 0 || rows <= 0) return;
      // 범위 제한 — 과도한 값 방지
      const safeCols = Math.min(cols, 500);
      const safeRows = Math.min(rows, 200);
      terminalService.resizeTerminal(socket.id, safeCols, safeRows);
    });

    socket.on('disconnect', () => {
      terminalService.killTerminal(socket.id);
    });
  });
}

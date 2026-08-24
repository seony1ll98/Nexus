// Linux 유저 관리 서비스 — 프로젝트별 터미널 격리용
import { execFileSync } from 'node:child_process';
import prisma from '../lib/prisma.js';

/** 팀원 Linux 계정이 속하는 그룹 — Dockerfile의 sudoers 화이트리스트와 일치해야 한다 */
const DEV_GROUP = 'devusers';

/** execFileSync 오류에서 stderr를 뽑아 읽을 수 있는 메시지로 만든다 */
function describeExecError(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const stderr = e.stderr ? e.stderr.toString().trim() : '';
  return stderr || e.message || String(err);
}

/** Linux 유저명 생성 규칙: dev-{userId 앞 8자} */
function toLinuxUsername(userId: string): string {
  return `dev-${userId.replace(/-/g, '').slice(0, 8)}`;
}

/** Linux 유저 존재 여부 확인 */
function linuxUserExists(username: string): boolean {
  try {
    execFileSync('id', [username], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Linux 유저 생성 + DB에 linuxUser 저장 */
async function ensureLinuxUser(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { linuxUser: true, role: true },
  });

  if (!user) throw new Error('사용자를 찾을 수 없습니다');

  // admin은 ubuntu 유저 사용 — linuxUser 불필요
  if (user.role === 'admin') return 'ubuntu';

  // 이미 linuxUser가 있으면 반환
  if (user.linuxUser) return user.linuxUser;

  const username = toLinuxUsername(userId);

  // Linux 유저 생성 (이미 존재하면 건너뜀)
  // devusers 그룹에 넣어야 sudoers 화이트리스트(appuser → %devusers로 셸 실행)가 적용된다
  if (!linuxUserExists(username)) {
    try {
      execFileSync('sudo', ['useradd', '-m', '-s', '/bin/bash', '-G', DEV_GROUP, username], {
        stdio: 'pipe',
      });
    } catch (err) {
      throw new Error(
        `Linux 계정 생성 실패 (${username}). sudo useradd 권한과 ${DEV_GROUP} 그룹 존재 여부를 확인하세요: ${describeExecError(err)}`,
      );
    }
  }

  // DB에 linuxUser 저장
  await prisma.user.update({
    where: { id: userId },
    data: { linuxUser: username },
  });

  return username;
}

/**
 * 프로젝트 디렉토리에 Linux 유저 접근 권한 부여 (ACL).
 *
 * 실패를 조용히 삼키면 터미널은 열리지만 프로젝트 파일을 읽지 못하는
 * 원인 불명 상태가 된다(예전 폴백은 존재하지도 않는 ubuntu 그룹에 넣으려 했다).
 * 실패하면 그대로 던져 호출부가 사용자에게 알리도록 한다.
 */
function grantProjectAccess(username: string, projectPath: string): void {
  try {
    execFileSync('sudo', ['setfacl', '-R', '-m', `u:${username}:rwx`, projectPath], { stdio: 'pipe' });
    execFileSync('sudo', ['setfacl', '-R', '-d', '-m', `u:${username}:rwx`, projectPath], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(
      `프로젝트 접근 권한 부여 실패 (${username} → ${projectPath}). `
      + `setfacl 설치 여부와 sudo 권한을 확인하세요: ${describeExecError(err)}`,
    );
  }
}

/** 프로젝트 디렉토리에서 Linux 유저 접근 권한 제거 */
function revokeProjectAccess(username: string, projectPath: string): void {
  try {
    execFileSync('sudo', ['setfacl', '-R', '-x', `u:${username}`, projectPath], { stdio: 'pipe' });
  } catch (err) {
    // 회수 실패는 치명적이지 않지만 흔적은 남긴다
    console.warn(`[linux-user] 접근 권한 회수 실패 (${username}):`, describeExecError(err));
  }
}

export const linuxUserService = {
  toLinuxUsername,
  ensureLinuxUser,
  grantProjectAccess,
  revokeProjectAccess,
};

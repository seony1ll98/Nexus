// Linux 유저 관리 서비스 — 프로젝트별 터미널 격리용
//
// 설계: 팀원마다 서버에 별도 Linux 계정을 만들고, 웹 터미널을 그 계정으로 실행한다.
// 프로젝트 폴더 접근은 ACL(setfacl)로 프로젝트 멤버에게만 부여한다.
//
// 호출 시점
//  - 관리자가 사용자 편집에서 저장할 때: 계정 생성 (명시적)
//  - 팀원이 터미널을 열 때: 계정이 없으면 보정 + 해당 프로젝트 ACL 부여
//  - 프로젝트 멤버 추가/제거 시: ACL 부여 / 회수
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

/**
 * 이 서버에서 Linux 계정 프로비저닝이 가능한지.
 *
 * useradd/setfacl은 Linux 전용이라 macOS 개발 환경에서는 쓸 수 없다.
 * 지원하지 않는 환경에서 조용히 실패하면 "터미널이 이유 없이 안 되는" 상태가 되므로,
 * 호출부가 이 값을 먼저 확인해 사용자에게 명확히 안내하도록 한다.
 */
function isProvisioningSupported(): boolean {
  return process.platform === 'linux';
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

/** 계정을 devusers 그룹에 넣는다 — 이미 속해 있으면 무해하다 */
function ensureInDevGroup(username: string): void {
  try {
    execFileSync('sudo', ['usermod', '-aG', DEV_GROUP, username], { stdio: 'pipe' });
  } catch (err) {
    throw new Error(
      `Linux 계정을 ${DEV_GROUP} 그룹에 추가하지 못했습니다 (${username}). `
      + `그룹 존재 여부와 sudo 권한을 확인하세요: ${describeExecError(err)}`,
    );
  }
}

/**
 * 팀원의 Linux 계정을 준비한다.
 *
 * @returns 사용할 계정명. 관리자는 별도 계정이 필요 없어 null을 반환한다.
 * @throws 프로비저닝이 지원되지만 실패한 경우
 */
async function ensureLinuxUser(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { linuxUser: true, role: true },
  });

  if (!user) throw new Error('사용자를 찾을 수 없습니다');

  // 관리자 터미널은 백엔드 프로세스 유저로 실행된다 — 별도 계정을 만들지 않는다
  if (user.role === 'admin') return null;

  // 관리자가 직접 지정한 이름이 있으면 그것을 쓰고, 없으면 규칙대로 생성한다
  const username = user.linuxUser || toLinuxUsername(userId);

  if (isProvisioningSupported()) {
    if (!linuxUserExists(username)) {
      try {
        execFileSync('sudo', ['useradd', '-m', '-s', '/bin/bash', '-G', DEV_GROUP, username], {
          stdio: 'pipe',
        });
      } catch (err) {
        throw new Error(
          `Linux 계정 생성 실패 (${username}). sudo useradd 권한과 ${DEV_GROUP} 그룹 존재 여부를 확인하세요: `
          + describeExecError(err),
        );
      }
    } else {
      // 예전 배포에서 만들어진 계정은 devusers 그룹에 없을 수 있다 — 여기서 보정한다
      ensureInDevGroup(username);
    }
  }

  // DB에 계정명 기록 (지원되지 않는 환경에서도 이름은 확정해 둔다)
  if (user.linuxUser !== username) {
    await prisma.user.update({ where: { id: userId }, data: { linuxUser: username } });
  }

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
  if (!isProvisioningSupported()) return;
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
  if (!isProvisioningSupported()) return;
  try {
    execFileSync('sudo', ['setfacl', '-R', '-x', `u:${username}`, projectPath], { stdio: 'pipe' });
    execFileSync('sudo', ['setfacl', '-R', '-d', '-x', `u:${username}`, projectPath], { stdio: 'pipe' });
  } catch (err) {
    // 회수 실패는 요청 자체를 막지 않되, 권한이 남는 상황이므로 반드시 로그를 남긴다
    console.error(
      `[linux-user] 접근 권한 회수 실패 — 권한이 남아 있을 수 있습니다 (${username} → ${projectPath}):`,
      describeExecError(err),
    );
  }
}

export const linuxUserService = {
  isProvisioningSupported,
  toLinuxUsername,
  ensureLinuxUser,
  grantProjectAccess,
  revokeProjectAccess,
};

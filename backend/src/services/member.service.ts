// 프로젝트 멤버 서비스 레이어
import prisma from '../lib/prisma.js';
import { linuxUserService } from './linux-user.service.js';
import { createHttpError } from '../lib/errors.js';

/** 프로젝트 멤버 목록 조회 */
async function findByProject(projectId: string) {
  const members = await prisma.projectMember.findMany({
    where: { projectId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { joinedAt: 'desc' },
  });
  return members.map((m) => ({
    userId: m.user.id,
    name: m.user.name,
    email: m.user.email,
    role: m.role,
    joinedAt: m.joinedAt,
  }));
}

/**
 * 프로젝트 디렉토리에 대한 팀원의 파일 접근 권한을 동기화한다.
 *
 * 멤버십 변경 자체를 막지 않도록 실패해도 예외를 던지지 않는다.
 * 부여에 실패하더라도 터미널을 열 때 다시 시도하므로 자가 복구된다.
 * (회수 실패는 권한이 남는 문제라 linux-user 서비스가 error 로그를 남긴다)
 */
async function syncProjectAcl(
  projectId: string,
  userId: string,
  action: 'grant' | 'revoke',
): Promise<void> {
  if (!linuxUserService.isProvisioningSupported()) return;
  try {
    const [project, user] = await Promise.all([
      prisma.project.findUnique({ where: { id: projectId }, select: { repoPath: true } }),
      prisma.user.findUnique({ where: { id: userId }, select: { role: true, linuxUser: true } }),
    ]);
    // 관리자는 별도 계정을 쓰지 않으므로 ACL 대상이 아니다
    if (!project || !user || user.role === 'admin' || !user.linuxUser) return;

    if (action === 'grant') {
      linuxUserService.grantProjectAccess(user.linuxUser, project.repoPath);
    } else {
      linuxUserService.revokeProjectAccess(user.linuxUser, project.repoPath);
    }
  } catch (err) {
    console.warn(
      `[member] 프로젝트 접근 권한 ${action === 'grant' ? '부여' : '회수'} 실패 `
      + `(project=${projectId}, user=${userId}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** 멤버 추가 */
async function add(projectId: string, userId: string, role: string) {
  const exists = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  if (exists) {
    throw createHttpError(409, '이미 프로젝트에 참여 중인 사용자입니다');
  }
  await prisma.projectMember.create({ data: { projectId, userId, role } });

  // 프로젝트 폴더 접근 권한 부여
  await syncProjectAcl(projectId, userId, 'grant');

  return findByProject(projectId);
}

/** 멤버 역할 변경 */
async function changeRole(projectId: string, userId: string, role: string) {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  if (!member) {
    throw createHttpError(404, '프로젝트 멤버를 찾을 수 없습니다');
  }
  await prisma.projectMember.update({ where: { id: member.id }, data: { role } });
}

/** 멤버 제거 */
async function remove(projectId: string, userId: string) {
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  if (!member) {
    throw createHttpError(404, '프로젝트 멤버를 찾을 수 없습니다');
  }
  await prisma.projectMember.delete({ where: { id: member.id } });

  // 프로젝트에서 빠지면 파일 접근 권한도 회수한다.
  // 회수하지 않으면 멤버에서 제외된 뒤에도 서버 파일을 계속 볼 수 있다.
  await syncProjectAcl(projectId, userId, 'revoke');
}

/**
 * 프로젝트 접근 검증 — 관리자 또는 프로젝트 멤버만 통과
 * 관리자는 모든 프로젝트 접근 가능, 일반 유저는 ProjectMember 레코드 필요
 */
async function assertProjectMember(projectId: string, userId: string): Promise<void> {
  if (!userId) {
    throw createHttpError(401, '로그인이 필요합니다');
  }

  // 관리자 역할 확인 — 관리자는 모든 프로젝트 접근 가능
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (!user) {
    throw createHttpError(401, '유효하지 않은 사용자입니다');
  }
  if (user.role === 'admin') return;

  // 프로젝트 존재 여부 + admin-only 확인
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { isAdminOnly: true },
  });
  if (!project) {
    throw createHttpError(404, '프로젝트를 찾을 수 없습니다');
  }
  if (project.isAdminOnly) {
    throw createHttpError(403, '관리자 전용 프로젝트입니다');
  }

  // 일반 유저는 ProjectMember 레코드 필요
  const member = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  if (!member) {
    throw createHttpError(403, '프로젝트에 접근 권한이 없습니다');
  }
}

export const memberService = { findByProject, add, changeRole, remove, assertProjectMember };

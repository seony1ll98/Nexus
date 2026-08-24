// git 공통 래퍼 — 커밋 신원 주입 + 기본 브랜치 감지
//
// 배경 1) 커밋 신원
//   Nexus는 서버 프로세스에서 git commit을 실행한다. 그런데 컨테이너에는 전역
//   gitconfig가 없고, 호스트명에 도메인이 없어 이메일 자동 추론도 실패한다.
//   그 결과 "unable to auto-detect email address"로 커밋이 거부되어
//   프로젝트 생성과 merge가 실패한다.
//   개발자 노트북에서는 개인 gitconfig가 대신 잡혀 문제가 드러나지 않는다.
//   simple-git의 config 옵션(-c)으로 신원을 항상 명시해 환경에 의존하지 않게 한다.
//
// 배경 2) 기본 브랜치
//   `git init`은 설정이 없으면 master를 만든다. 코드 곳곳에 'main'이 하드코딩되어
//   있으면 ahead/behind 계산이 조용히 0으로 떨어진다. 감지 로직을 여기 한 곳에 둔다.
import { simpleGit, type SimpleGit } from 'simple-git';
import prisma from './prisma.js';

/** 커밋 작성자 정보 */
export interface GitAuthor {
  name: string;
  email: string;
}

/** 작성자를 알 수 없을 때 쓰는 기본 신원 */
const FALLBACK_AUTHOR: GitAuthor = { name: 'Nexus', email: 'nexus@localhost' };

/** 새 저장소의 기본 브랜치 이름 */
export const DEFAULT_BRANCH = 'main';

/**
 * 저장소 핸들 생성.
 * author를 넘기면 그 사용자 이름으로 커밋이 기록되어 대시보드 통계가 실제 값이 된다.
 */
export function git(repoPath: string, author?: GitAuthor | null): SimpleGit {
  const who = author?.name && author?.email ? author : FALLBACK_AUTHOR;
  return simpleGit(repoPath, {
    config: [
      `user.name=${who.name}`,
      `user.email=${who.email}`,
      // 시스템에 커밋 서명 요구 설정이 있어도 서버 커밋이 실패하지 않도록 끈다
      'commit.gpgsign=false',
    ],
  });
}

/**
 * userId로 커밋 작성자 정보를 조회한다.
 * 사용자를 찾지 못하면 null을 반환하고, 호출부는 기본 신원으로 동작한다.
 */
export async function authorForUser(userId?: string | null): Promise<GitAuthor | null> {
  if (!userId) return null;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    return user ? { name: user.name, email: user.email } : null;
  } catch {
    return null;
  }
}

/**
 * 저장소의 기본 브랜치를 감지한다.
 * main이 있으면 main, 없으면 master, 둘 다 없으면 현재 브랜치를 쓴다.
 */
export async function resolveDefaultBranch(repoPath: string): Promise<string> {
  try {
    const branches = await git(repoPath).branchLocal();
    if (branches.all.includes(DEFAULT_BRANCH)) return DEFAULT_BRANCH;
    if (branches.all.includes('master')) return 'master';
    return branches.current || DEFAULT_BRANCH;
  } catch {
    // 커밋이 하나도 없는 저장소 등
    return DEFAULT_BRANCH;
  }
}

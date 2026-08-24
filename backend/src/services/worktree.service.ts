// git worktree 생성/삭제 서비스
import { git as openRepo } from '../lib/git.js';
import path from 'path';
import fs from 'fs/promises';
import { createHttpError } from '../lib/errors.js';

/** worktree가 생성될 기본 경로 (Docker: /data/projects-wt) */
const WORKTREE_BASE = process.env.PROJECTS_WT_DIR || '/home/ubuntu/projects-wt';

/** 프로젝트 레포 기본 경로 (Docker: /data/projects) */
const REPO_BASE = process.env.PROJECTS_DIR || '/home/ubuntu/projects';

/**
 * worktreePath가 허용된 base 경로 내에 있는지 검증
 * 경로 트래버설 공격 방지
 */
export function validateBasePath(targetPath: string): void {
  const resolved = path.resolve(targetPath);
  if (!resolved.startsWith(WORKTREE_BASE + '/') && resolved !== WORKTREE_BASE) {
    throw createHttpError(400, `허용되지 않은 worktree 경로입니다: ${targetPath}`);
  }
}

/**
 * repoPath가 허용된 프로젝트 기본 경로 내에 있는지 검증
 */
function validateRepoBasePath(repoPath: string): void {
  const resolved = path.resolve(repoPath);
  if (!resolved.startsWith(REPO_BASE + '/') && resolved !== REPO_BASE) {
    throw createHttpError(400, `허용되지 않은 repoPath입니다: ${repoPath}`);
  }
}

/**
 * repoPath에서 프로젝트명 추출
 * 예) /home/ubuntu/projects/my-app → my-app
 */
function extractProjectName(repoPath: string): string {
  const resolved = path.resolve(repoPath);
  return path.basename(resolved);
}

/**
 * git worktree 생성
 * @param repoPath - 원본 레포 경로 (예: /home/ubuntu/projects/my-app)
 * @param sessionId - 세션 UUID
 * @param branchName - 생성할 브랜치명 (예: session/{uuid})
 * @returns 생성된 worktree 절대 경로
 */
export async function createWorktree(
  repoPath: string,
  sessionId: string,
  branchName: string,
): Promise<string> {
  // 경로 보안 검증
  validateRepoBasePath(repoPath);

  const projectName = extractProjectName(repoPath);
  const rawWorktreePath = path.join(WORKTREE_BASE, projectName, sessionId);
  validateBasePath(rawWorktreePath);
  const worktreePath = path.resolve(rawWorktreePath);

  // 이미 존재하면 에러
  try {
    await fs.access(worktreePath);
    throw createHttpError(409, `worktree 경로가 이미 존재합니다: ${worktreePath}`);
  } catch (err: unknown) {
    // ENOENT면 정상 — 경로 없음, 계속 진행
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // 부모 디렉토리 생성
  await fs.mkdir(path.dirname(worktreePath), { recursive: true });

  const git = openRepo(repoPath);

  try {
    // git worktree add -b {branchName} {worktreePath}
    await git.raw(['worktree', 'add', '-b', branchName, worktreePath]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw createHttpError(500, `git worktree 생성 실패: ${msg}`);
  }

  return worktreePath;
}

/**
 * git worktree 제거
 * @param repoPath - 원본 레포 경로
 * @param worktreePath - 제거할 worktree 절대 경로
 * 경로가 존재하지 않으면 무시하고 정상 종료
 */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  validateBasePath(worktreePath);

  // 경로가 없으면 무시
  try {
    await fs.access(worktreePath);
  } catch {
    return;
  }

  const git = openRepo(repoPath);

  try {
    // --force: 작업 중인 변경사항이 있어도 강제 제거
    await git.raw(['worktree', 'remove', '--force', worktreePath]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw createHttpError(500, `git worktree 제거 실패: ${msg}`);
  }
}

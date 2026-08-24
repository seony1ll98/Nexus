// 커밋 diff 조회 및 revert 서비스 — commit-sync.service.ts에서 분리
import { git as openRepo, authorForUser } from '../lib/git.js';
import { createHttpError } from '../lib/errors.js';
import { commitSyncService } from './commit-sync.service.js';

/** unified diff 문자열을 파일별로 분리 */
export function parseDiffByFile(raw: string): { filename: string; diff: string }[] {
  const results: { filename: string; diff: string }[] = [];
  const fileSections = raw.split(/^diff --git /m).filter(Boolean);
  for (const section of fileSections) {
    const match = section.match(/^a\/(.+?) b\//);
    const filename = match ? match[1] : 'unknown';
    results.push({ filename, diff: `diff --git ${section}` });
  }
  return results;
}

/**
 * 특정 커밋의 diff를 파일별로 파싱하여 반환
 * @param repoPath 저장소 경로
 * @param hash 커밋 해시
 */
export async function getCommitDiff(
  repoPath: string,
  hash: string,
): Promise<{ filename: string; diff: string }[]> {
  const git = openRepo(repoPath);
  const raw = await git.diff([`${hash}^`, hash]);
  return parseDiffByFile(raw);
}

/**
 * 커밋을 revert하고 새 커밋을 동기화
 * @param projectId 프로젝트 ID
 * @param repoPath 저장소 경로
 * @param hash revert 대상 커밋 해시
 */
export async function revertCommit(
  projectId: string,
  repoPath: string,
  hash: string,
  /** revert를 실행한 사용자 — revert 커밋의 작성자로 기록된다 */
  userId?: string | null,
): Promise<void> {
  // revert는 새 커밋을 만든다 — 커밋 신원이 없으면 컨테이너에서 실패한다
  const git = openRepo(repoPath, await authorForUser(userId));
  try {
    // --no-edit: 에디터 없이 기본 revert 커밋 메시지 사용
    await git.raw(['revert', '--no-edit', hash]);
  } catch {
    // 충돌 발생 시 abort 후 409 에러
    await git.raw(['revert', '--abort']).catch(() => null);
    throw createHttpError(409, '충돌로 인해 revert를 수행할 수 없습니다');
  }

  // revert 커밋 동기화
  await commitSyncService.syncNewCommits(projectId, null, repoPath);
}

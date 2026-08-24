// Git 커밋 동기화 서비스 — worktree에서 새 커밋을 읽어 DB에 동기화
// diff/revert 기능은 commit-diff.service.ts로 분리됨
import { git as openRepo } from '../lib/git.js';
import prisma from '../lib/prisma.js';
import { socketService } from './socket.service.js';

/**
 * 한 번에 훑어볼 최근 커밋 수.
 * 전체 이력을 매번 대조하면 저장소가 커질수록 비용이 늘어나므로 상한을 둔다.
 * 스트림 종료마다 호출되므로 이 범위를 넘길 만큼 밀리는 상황은 없다.
 */
const MAX_SCAN_COMMITS = 200;

/** 커밋 단건 파싱 결과 */
interface CommitStatResult {
  filesChanged: string[];
  additions: number;
  deletions: number;
}

/** git diff-tree로 변경 파일 및 통계 추출 */
async function extractCommitStat(
  repoPath: string,
  hash: string,
): Promise<CommitStatResult> {
  const git = openRepo(repoPath);
  try {
    // 변경 파일 목록
    const filesRaw = await git.raw([
      'diff-tree', '--no-commit-id', '--name-only', '-r', hash,
    ]);
    const filesChanged = filesRaw.trim().split('\n').filter(Boolean);

    // 추가/삭제 라인 수
    const statRaw = await git.raw([
      'diff-tree', '--no-commit-id', '--numstat', '-r', hash,
    ]);
    let additions = 0;
    let deletions = 0;
    for (const line of statRaw.trim().split('\n').filter(Boolean)) {
      const [add, del] = line.split('\t');
      additions += parseInt(add, 10) || 0;
      deletions += parseInt(del, 10) || 0;
    }
    return { filesChanged, additions, deletions };
  } catch {
    // 머지 커밋 등 diff-tree 실패 시 기본값 반환
    return { filesChanged: [], additions: 0, deletions: 0 };
  }
}

class CommitSyncService {
  /**
   * worktree의 새 커밋을 DB에 동기화하고 WebSocket으로 브로드캐스트
   * @param projectId 프로젝트 ID
   * @param sessionId 세션 ID (nullable)
   * @param worktreePath worktree 절대 경로
   */
  async syncNewCommits(
    projectId: string,
    sessionId: string | null,
    worktreePath: string,
  ): Promise<void> {
    const git = openRepo(worktreePath);

    // ────────────────────────────────────────────
    // 최근 커밋을 훑고, DB에 없는 것만 추가한다.
    //
    // 예전에는 "커밋 날짜가 가장 최신인 DB 레코드"를 기준으로 `hash..HEAD`를 돌렸다.
    // 그런데 여러 세션이 각자의 브랜치에서 병렬로 커밋하면 커밋 날짜 순서와
    // 브랜치별 도달 가능 순서가 어긋나, 기준점보다 "과거 날짜"인 새 커밋이
    // 범위에서 빠져 영영 동기화되지 않았다.
    // 해시로 직접 대조하면 순서에 의존하지 않는다.
    // ────────────────────────────────────────────
    let log;
    try {
      log = await git.log([`--max-count=${MAX_SCAN_COMMITS}`, 'HEAD']);
    } catch {
      // 커밋이 없는 저장소 등 예외 무시
      return;
    }

    if (!log.all.length) return;

    // 이미 저장된 해시를 한 번에 조회해 중복 작업을 피한다
    const scannedHashes = log.all.map((c) => c.hash);
    const known = await prisma.commit.findMany({
      where: { projectId, hash: { in: scannedHashes } },
      select: { hash: true },
    });
    const knownHashes = new Set(known.map((c) => c.hash));

    const newEntries = log.all.filter((c) => !knownHashes.has(c.hash));
    if (!newEntries.length) return;

    // 새 커밋을 DB에 upsert 후 WebSocket 브로드캐스트 (오래된 것부터)
    for (const entry of [...newEntries].reverse()) {
      const stat = await extractCommitStat(worktreePath, entry.hash);

      const saved = await prisma.commit.upsert({
        where: { projectId_hash: { projectId, hash: entry.hash } },
        create: {
          projectId,
          sessionId: sessionId ?? undefined,
          hash: entry.hash,
          message: entry.message,
          author: entry.author_name,
          filesChanged: stat.filesChanged,
          additions: stat.additions,
          deletions: stat.deletions,
          createdAt: new Date(entry.date),
        },
        update: {},
      });

      socketService.emitToProject(projectId, 'git:commit-new', {
        id: saved.id,
        projectId: saved.projectId,
        sessionId: saved.sessionId,
        hash: saved.hash,
        message: saved.message,
        author: saved.author,
        filesChanged: saved.filesChanged,
        additions: saved.additions,
        deletions: saved.deletions,
        createdAt: saved.createdAt,
      });
    }
  }

}

export const commitSyncService = new CommitSyncService();

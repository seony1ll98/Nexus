// 브랜치 목록 조회 라우트 — GET /api/projects/:id/branches
import { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../../plugins/auth.js';
import prisma from '../../lib/prisma.js';
import { createHttpError } from '../../lib/errors.js';
import { memberService } from '../../services/member.service.js';
import { type BranchSummaryBranch } from 'simple-git';
import { git as openRepo, resolveDefaultBranch } from '../../lib/git.js';

/** 응답 브랜치 항목 타입 */
interface BranchItem {
  name: string;
  current: boolean;
  hash: string;
  status: 'latest' | 'ahead' | 'behind' | 'diverged';
  aheadCount: number;
  behindCount: number;
  author?: string;
}

/** 라우트 파라미터 타입 */
interface IdParams { id: string }

const branchesRoute: FastifyPluginAsync = async (fastify) => {
  // GET /:id/branches — 프로젝트 레포의 로컬 브랜치 목록 반환
  fastify.get<{ Params: IdParams }>('/', {
    preHandler: [requireAuth],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', format: 'uuid' } },
      },
    },
  }, async (request) => {
    const { id: projectId } = request.params;

    // 프로젝트 조회 및 멤버십 검증
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw createHttpError(404, '프로젝트를 찾을 수 없습니다');
    await memberService.assertProjectMember(projectId, request.userId);

    const git = openRepo(project.repoPath);
    // 기본 브랜치를 실제로 감지한다 — 'main'을 하드코딩하면 master로 만들어진
    // 저장소에서 rev-list가 조용히 실패해 ahead/behind가 항상 0으로 표시된다.
    const baseBranch = await resolveDefaultBranch(project.repoPath);

    // 로컬 브랜치 목록 조회
    const branchSummary = await git.branchLocal();
    const branches: BranchItem[] = [];

    for (const [name, detail] of Object.entries(branchSummary.branches) as [string, BranchSummaryBranch][]) {
      // 커밋 작성자 조회
      let author: string | undefined;
      try {
        const log = await git.log({ maxCount: 1, from: detail.commit });
        author = log.latest?.author_name ?? undefined;
      } catch {
        // 작성자 조회 실패 시 생략
      }

      // 기본 브랜치와의 ahead/behind 계산
      let aheadCount = 0;
      let behindCount = 0;
      if (name !== baseBranch) {
        try {
          const raw = await git.raw([
            'rev-list', '--left-right', '--count', `${baseBranch}...${name}`,
          ]);
          // 출력 형식: "behind\tahead\n"
          const parts = raw.trim().split(/\s+/);
          behindCount = parseInt(parts[0] ?? '0', 10) || 0;
          aheadCount = parseInt(parts[1] ?? '0', 10) || 0;
        } catch {
          // 기본 브랜치가 없거나 비교 실패 시 0 유지
        }
      }

      // 브랜치 상태 결정
      let status: BranchItem['status'] = 'latest';
      if (aheadCount > 0 && behindCount > 0) status = 'diverged';
      else if (aheadCount > 0) status = 'ahead';
      else if (behindCount > 0) status = 'behind';

      branches.push({
        name,
        current: detail.current,
        hash: detail.commit.slice(0, 7),
        status,
        aheadCount,
        behindCount,
        ...(author ? { author } : {}),
      });
    }

    // 기본/현재 브랜치를 앞으로 정렬
    branches.sort((a, b) => {
      if (a.name === baseBranch) return -1;
      if (b.name === baseBranch) return 1;
      if (a.current) return -1;
      if (b.current) return 1;
      return 0;
    });

    return { branches };
  });
};

export default branchesRoute;

// 팀 질의 서비스 — 컨텍스트 수집 + Claude Code 코드 분석/결과물 생성 실행
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import prisma from '../lib/prisma.js';
import { StreamEvent } from './claude.service.js';
import { createStreamHandler } from '../lib/stream-parser.js';
import { claudeAuthService } from './claude-auth.service.js';

/** 프로젝트당 동시 질의 카운터 */
const activeQueries = new Map<string, number>();

/** 동시 질의 최대 허용 수 */
const MAX_CONCURRENT = 2;

/** 분석 결과물 저장 경로 (기존 파일 수정 방지용 격리 디렉토리) */
const REPORT_OUTPUT_DIR = '/tmp/nexus-reports';

class TeamQueryService {
  /** 컨텍스트 프롬프트 구성 */
  private buildPrompt(
    sessions: Array<{ title: string; status: string; createdAt: Date; messages: Array<{ role: string; content: string }> }>,
    commits: Array<{ hash: string; message: string | null; author: string | null; createdAt: Date }>,
    userMessage: string,
  ): string {
    const sessionSummary = sessions
      .map((s) => {
        const lastMsg = s.messages[0]?.content?.slice(0, 100) ?? '(없음)';
        return `- [${s.status}] ${s.title} (${s.createdAt.toISOString().slice(0, 10)}): ${lastMsg}`;
      })
      .join('\n');

    const commitSummary = commits
      .map((c) => `- ${c.hash.slice(0, 7)} ${c.author ?? '?'}: ${c.message ?? '(메시지 없음)'} (${c.createdAt.toISOString().slice(0, 10)})`)
      .join('\n');

    return [
      '# 프로젝트 현황 컨텍스트',
      '',
      '## 최근 세션 (최대 10개)',
      sessionSummary || '(세션 없음)',
      '',
      '## 최근 커밋 (최대 50개)',
      commitSummary || '(커밋 없음)',
      '',
      '---',
      '',
      '## 중요 지시사항',
      '- 코드베이스의 기존 파일을 절대 수정(Edit)하지 마세요.',
      '- 파일 읽기/분석은 Read, Glob, Grep 도구를 사용하세요.',
      '- 통계/분석이 필요하면 Bash 도구로 git log, wc, find 등의 명령어를 실행해도 됩니다.',
      `- 분석 결과나 보고서 파일이 필요하면 반드시 ${REPORT_OUTPUT_DIR}/ 경로에 생성하세요.`,
      '',
      '위 컨텍스트를 바탕으로 다음 질문에 답변해줘.',
      '',
      `## 질문: ${userMessage}`,
    ].join('\n');
  }

  /**
   * 팀 질의 실행 — EventEmitter 반환 (채팅과 동일 패턴).
   * @param userId 요청 사용자 ID — CLAUDE_CONFIG_DIR 결정에 사용
   */
  async query(projectId: string, message: string, folderId?: string, userId?: string | null): Promise<EventEmitter> {
    const emitter = new EventEmitter();

    // 동시 질의 수 확인
    const current = activeQueries.get(projectId) ?? 0;
    if (current >= MAX_CONCURRENT) {
      // 비동기로 에러 emit (이벤트 루프 다음 틱)
      setTimeout(() => emitter.emit('error', '이 프로젝트에서 이미 최대 동시 질의 수에 도달했습니다'), 0);
      return emitter;
    }

    // 프로젝트 + 컨텍스트 조회
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      setTimeout(() => emitter.emit('error', '프로젝트를 찾을 수 없습니다'), 0);
      return emitter;
    }

    // 세션 컨텍스트 수집 (folderId 전달 시 해당 폴더 세션만 조회)
    const sessions = await prisma.session.findMany({
      where: { projectId, ...(folderId ? { folderId } : {}) },
      take: 10,
      orderBy: { updatedAt: 'desc' },
      include: { messages: { take: 3, orderBy: { createdAt: 'desc' }, select: { role: true, content: true } } },
    });

    // 커밋 컨텍스트 수집
    const commits = await prisma.commit.findMany({
      where: { projectId },
      take: 50,
      orderBy: { createdAt: 'desc' },
      select: { hash: true, message: true, author: true, createdAt: true },
    });

    const prompt = this.buildPrompt(sessions, commits, message);

    // 카운터 증가
    activeQueries.set(projectId, current + 1);

    // userId가 있으면 CLAUDE_CONFIG_DIR 주입 (OAuth 인증) + 토큰 자동 갱신
    const env: Record<string, string | undefined> = { ...process.env };
    if (userId) {
      await claudeAuthService.ensureValidToken(userId);
      env.CLAUDE_CONFIG_DIR = claudeAuthService.getConfigDir(userId);
    }

    // Claude Code 실행 — 읽기+Bash+Write 허용, Edit(기존 파일 수정) 금지
    const proc = spawn('claude', [
      '--output-format', 'stream-json',
      '--allowedTools', 'Read,Glob,Grep,Bash,Write',
      '-p',
    ], {
      cwd: project.repoPath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // stdin으로 프롬프트 전달 후 닫기 — stdin이 null이면 스킵
    if (proc.stdin) {
      proc.stdin.write(prompt, 'utf8');
      proc.stdin.end();
    } else {
      console.warn('[TeamQueryService] proc.stdin이 null — 프롬프트 전달 불가');
    }

    // 공통 stream-json 파서 사용
    const { onData, flush } = createStreamHandler(emitter);

    proc.stdout.on('data', onData);

    // stderr는 진단 정보다 — 종료 신호로 쓰면 경고 한 줄에 스트림이 끊긴다
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.warn('[TeamQueryService] CLI stderr:', text);
    });
    proc.on('error', (e) => {
      emitter.emit('error', `CLI 프로세스를 실행하지 못했습니다: ${e.message}`);
    });

    proc.on('close', (code) => {
      // 카운터 감소
      const cnt = activeQueries.get(projectId) ?? 1;
      if (cnt <= 1) activeQueries.delete(projectId);
      else activeQueries.set(projectId, cnt - 1);

      // 남은 버퍼 처리
      flush();
      emitter.emit('close', code);
    });

    return emitter;
  }
}

export const pmQueryService = new TeamQueryService();

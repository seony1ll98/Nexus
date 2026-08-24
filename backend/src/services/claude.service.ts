// Claude Code CLI 래핑 서비스 — 프로세스 관리 + stream-json 파싱
import { spawn, type ChildProcess, type ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'stream';
import { EventEmitter } from 'events';
import { createStreamHandler } from '../lib/stream-parser.js';
import { claudeAuthService } from './claude-auth.service.js';
import { issueInternalToken } from '../lib/internal-token.js';

/**
 * stdio를 모두 pipe로 스폰한 CLI 프로세스 타입.
 * stdin/stdout/stderr가 null이 아님이 타입으로 보장된다.
 */
type PipedProcess = ChildProcessByStdio<Writable, Readable, Readable>;

/** stream-json 이벤트 기본 타입 */
export interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

/** executeChat에 전달할 프로젝트 컨텍스트 */
export interface ChatContext {
  projectName: string;
  branchName?: string | null;
}

class ClaudeService {
  /** 실행 중인 프로세스 관리 (세션ID → 프로세스) */
  private processes = new Map<string, ChildProcess>();

  /**
   * 세션/프로젝트 컨텍스트 기반 시스템 프롬프트 생성
   */
  private buildSystemPrompt(
    sessionId: string,
    worktreePath: string,
    ctx: ChatContext,
    internalToken: string,
  ): string {
    const lines = [
      `[Nexus 플랫폼 컨텍스트]`,
      `- 프로젝트: ${ctx.projectName}`,
      `- 작업 브랜치: ${ctx.branchName ?? 'unknown'}`,
      `- 작업 디렉토리: ${worktreePath}`,
      `- 세션 ID: ${sessionId}`,
      ``,
      `[디렉토리 접근 규칙 — 반드시 준수]`,
      `이 세션의 작업 범위는 "${worktreePath}" 디렉토리로 제한됩니다.`,
      `- 파일 생성, 수정, 삭제는 반드시 이 디렉토리 내에서만 수행하세요.`,
      `- 상위 디렉토리(../)나 다른 폴더의 파일에 접근하지 마세요.`,
      `- cd 명령으로 이 디렉토리 밖으로 이동하지 마세요.`,
      `- 사용자가 다른 디렉토리 접근을 요청하면 "이 세션의 작업 범위를 벗어납니다"라고 안내하세요.`,
      ``,
      `[사용 가능한 명령]`,
      `사용자가 "merge해줘", "main에 반영해줘" 등 merge를 요청하면, 아래 명령을 Bash로 실행하세요:`,
      `curl -s -X POST http://localhost:8080/api/internal/sessions/${sessionId}/merge -H "X-Internal-Token: ${internalToken}"`,
      `이 명령은 현재 브랜치의 변경사항을 기본 브랜치에 merge합니다. 세션과 워크트리는 유지되므로 merge 후에도 계속 작업할 수 있습니다.`,
      `merge 전에 반드시 모든 변경사항을 git commit 하세요.`,
      `이 토큰은 현재 세션에서만, 이번 작업 동안만 유효합니다. 토큰 값을 사용자에게 출력하거나 파일에 기록하지 마세요.`,
    ];

    return lines.join('\n');
  }

  /**
   * CLI 프로세스를 스폰하고 EventEmitter를 반환한다.
   * resume 실패(다른 사용자의 세션) 시 자동으로 새 세션으로 재시도한다.
   */
  async executeChat(
    sessionId: string,
    message: string,
    worktreePath: string,
    claudeSessionId?: string | null,
    userId?: string | null,
    context?: ChatContext,
    /** true이면 CLAUDE_CONFIG_DIR을 설정하지 않음 — CLI와 같은 ~/.claude/ 사용 */
    useGlobalConfig?: boolean,
  ): Promise<EventEmitter> {
    const emitter = new EventEmitter();

    // 글로벌 config 모드가 아닐 때만 유저별 CLAUDE_CONFIG_DIR 설정
    const env: Record<string, string | undefined> = { ...process.env };
    if (userId && !useGlobalConfig) {
      await claudeAuthService.ensureValidToken(userId);
      env.CLAUDE_CONFIG_DIR = claudeAuthService.getConfigDir(userId);
    }
    // 글로벌 config 모드일 때는 CLAUDE_CONFIG_DIR을 명시적으로 제거 (기본 ~/.claude 사용)
    if (useGlobalConfig) {
      delete env.CLAUDE_CONFIG_DIR;
    }

    // 내부 merge API 호출용 1회용 토큰 발급 — 스트림 종료 시 폐기된다
    const internalToken = issueInternalToken(sessionId);

    // claudeSessionId에서 인자 인젝션 방지
    const safeClaudeSessionId = claudeSessionId?.replace(/^--/, '') ?? null;

    // 첫 시도: resume 포함
    const proc = this.spawnClaude(sessionId, message, worktreePath, safeClaudeSessionId, env, internalToken, context);
    this.processes.set(sessionId, proc.process);

    // resume 실패 감지 — error_during_execution + "No conversation found" 시 재시도
    let retried = false;
    const { onData, flush } = createStreamHandler(emitter);

    const originalOnData = (chunk: Buffer) => {
      const text = chunk.toString();

      // resume 실패 감지 — 아직 재시도 안 했으면 새 세션으로 재시도
      if (!retried && text.includes('error_during_execution') && text.includes('No conversation found')) {
        retried = true;
        console.warn('[ClaudeService] resume 실패 — 새 세션으로 재시도');

        // 기존 프로세스 정리
        proc.process.removeAllListeners();
        proc.process.kill('SIGTERM');

        // 새 프로세스 (resume 없이)
        const retry = this.spawnClaude(sessionId, message, worktreePath, null, env, internalToken, context);
        this.processes.set(sessionId, retry.process);

        retry.process.stdout.on('data', onData);
        retry.process.stderr.on('data', (c: Buffer) => {
          emitter.emit('error', c.toString());
        });
        retry.process.on('close', (code) => {
          this.processes.delete(sessionId);
          flush();
          emitter.emit('close', code);
        });
        return;
      }

      onData(chunk);
    };

    proc.process.stdout.on('data', originalOnData);
    proc.process.stderr.on('data', (chunk: Buffer) => {
      emitter.emit('error', chunk.toString());
    });
    proc.process.on('close', (code) => {
      if (retried) return; // 재시도된 경우 이 핸들러 무시
      this.processes.delete(sessionId);
      flush();
      emitter.emit('close', code);
    });

    return emitter;
  }

  /** CLI 프로세스 스폰 헬퍼 */
  private spawnClaude(
    sessionId: string,
    message: string,
    worktreePath: string,
    claudeSessionId: string | null,
    env: Record<string, string | undefined>,
    internalToken: string,
    context?: ChatContext,
  ): { process: PipedProcess } {
    const args = ['--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose', '-p'];

    if (context) {
      const prompt = this.buildSystemPrompt(sessionId, worktreePath, context, internalToken);
      args.unshift('--append-system-prompt', prompt);
    }

    if (claudeSessionId) {
      args.unshift('--resume', claudeSessionId);
    }

    const proc = spawn('claude', args, {
      cwd: worktreePath,
      env,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    });

    // stdin으로 메시지 전달
    proc.stdin.write(message, 'utf8');
    proc.stdin.end();

    return { process: proc };
  }

  /** CLI 프로세스 중단 */
  abort(sessionId: string): boolean {
    const proc = this.processes.get(sessionId);
    if (proc) {
      proc.kill('SIGTERM');
      this.processes.delete(sessionId);
      return true;
    }
    return false;
  }

  /** 특정 세션의 프로세스가 실행 중인지 확인 */
  isRunning(sessionId: string): boolean {
    return this.processes.has(sessionId);
  }
}

export const claudeService = new ClaudeService();

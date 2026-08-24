# ============================================================
# Nexus Backend — Fastify + Prisma + Claude Code CLI
# 베이스: node:20-bookworm (node-pty에 glibc 필요, Alpine 불가)
# ============================================================

FROM node:20-bookworm AS builder

# 시스템 의존성 설치 (node-pty 빌드에 필요)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    python3 \
    sudo \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 의존성 캐싱을 위해 package 파일 먼저 복사
COPY package.json package-lock.json ./

# 의존성 설치
RUN npm ci

# 소스 코드 복사
COPY . .

# Prisma 클라이언트 생성
RUN npx prisma generate

# ============================================================
# 프로덕션 스테이지
# ============================================================
FROM node:20-bookworm

# 런타임 시스템 의존성
#  git          : simple-git / worktree
#  python3      : node-pty 빌드
#  sudo         : 터미널을 팀원별 Linux 계정으로 실행
#  acl(setfacl) : 팀원 계정에 프로젝트 디렉토리 접근 권한 부여
#                 (없으면 터미널은 열리지만 프로젝트 파일을 읽지 못한다)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
    python3 \
    sudo \
    acl \
    && rm -rf /var/lib/apt/lists/*

# Claude Code CLI 전역 설치
RUN npm install -g @anthropic-ai/claude-code

# ============================================================
# 비root 사용자 + 최소 권한 sudo
#
# 이전에는 appuser에게 NOPASSWD:ALL을 줬는데, 웹 터미널이 결국 appuser 셸이므로
# 누구든 `sudo -i`로 컨테이너 root가 될 수 있었다. 즉 "팀원별 계정 격리"가
# 성립하지 않았다. 실제로 필요한 명령만 화이트리스트로 허용한다.
#
#  - useradd/usermod : 팀원 Linux 계정 생성
#  - setfacl         : 프로젝트 디렉토리 접근 권한 부여/회수
#  - runuser         : 팀원 계정으로 셸 실행 (%devusers 그룹 대상으로 한정)
# ============================================================
RUN groupadd -r appuser \
    && useradd -r -g appuser -m -s /bin/bash appuser \
    && groupadd devusers \
    && printf '%s\n' \
       'Cmnd_Alias NEXUS_USERADM = /usr/sbin/useradd, /usr/sbin/usermod, /usr/bin/setfacl' \
       'appuser ALL=(root) NOPASSWD: NEXUS_USERADM' \
       'appuser ALL=(%devusers) NOPASSWD: /bin/bash' \
       > /etc/sudoers.d/nexus \
    && chmod 0440 /etc/sudoers.d/nexus \
    && visudo -cf /etc/sudoers.d/nexus

WORKDIR /app

# 빌더에서 node_modules와 소스 복사
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app .

# 데이터 디렉토리 생성 및 권한 설정
RUN mkdir -p /data/claude-configs /data/projects /data/projects-wt \
    && chown -R appuser:appuser /app /data

# 엔트리포인트 스크립트 실행 권한 부여
RUN chmod +x docker-entrypoint.sh

# 환경변수 기본값
ENV NODE_ENV=production
ENV PORT=8080
ENV CLAUDE_CONFIGS_DIR=/data/claude-configs
ENV PROJECTS_DIR=/data/projects
ENV PROJECTS_WT_DIR=/data/projects-wt

# 볼륨 마운트 포인트
VOLUME ["/data/claude-configs", "/data/projects", "/data/projects-wt"]

EXPOSE 8080

USER appuser

ENTRYPOINT ["./docker-entrypoint.sh"]

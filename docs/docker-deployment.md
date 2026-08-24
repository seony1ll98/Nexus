# Docker 배포 가이드

> Nexus를 Docker Compose로 배포하는 방법을 설명한다.

---

## 아키텍처

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Frontend   │────▶│   Backend    │────▶│  PostgreSQL   │
│  (Next.js)   │     │ (Fastify +   │     │              │
│  :3000       │     │  Claude CLI) │     │  :5432       │
└──────────────┘     │  :8080       │     └──────────────┘
                     └──────┬───────┘
                            │
                     ┌──────┴───────┐
                     │   Volumes    │
                     │ - configs    │
                     │ - projects   │
                     │ - worktrees  │
                     └──────────────┘
```

- **Frontend**: Next.js 14+ App Router 기반 웹 클라이언트 (포트 3000)
- **Backend**: Fastify + Claude Code CLI 래퍼 (포트 8080)
- **PostgreSQL**: 데이터 영속 저장소 (포트 5432)

---

## 사전 요구사항

- Docker Engine 24.0 이상
- Docker Compose v2 이상 (`docker compose` 명령어 사용)
- 최소 4GB RAM, 10GB 디스크 여유 공간
- (선택) Nginx 리버스 프록시 — 외부 HTTPS 접근 시

---

## 환경변수 설정

1. `.env.docker.example` 파일을 `.env`로 복사한다:

```bash
cp .env.docker.example .env
```

2. `.env` 파일을 열어 필수 값을 설정한다:

```bash
# 예시 항목 (실제 키/값은 .env.docker.example 참조)
POSTGRES_PASSWORD=DB-비밀번호
SESSION_SECRET=랜덤-시크릿-문자열
ADMIN_SEED_PASSWORD=최초-관리자-비밀번호   # ← 최초 배포 시 반드시 설정
FRONTEND_URL=http://localhost:3000
```

> **주의**: `.env` 파일은 절대 Git에 커밋하지 않는다. `.gitignore`에 포함되어 있는지 확인한다.

---

## 최초 로그인

Nexus에는 회원가입 기능이 없다. 계정은 관리자가 만들어 배포하며,
그 최초 관리자 계정은 컨테이너가 처음 뜰 때 시드로 생성된다.

1. `.env`에 `ADMIN_SEED_PASSWORD`를 설정한다.
2. `docker compose up -d`로 기동하면 엔트리포인트가 관리자 계정을 만든다.
3. `admin@nexus.com` + 설정한 비밀번호로 로그인한 뒤 **즉시 비밀번호를 변경한다.**

```bash
# 시드가 실행됐는지 확인
docker compose logs backend | grep -A1 "관리자 계정"
```

`ADMIN_SEED_PASSWORD`를 설정하지 않으면 시드를 건너뛰며, 이 경우
**로그인할 수 있는 계정이 하나도 없는 상태로 서비스가 뜬다.** 로그에 안내가 출력된다.

계정이 이미 있으면 시드는 아무 것도 하지 않는다(비밀번호를 덮어쓰지 않는다).
따라서 재기동을 반복해도 안전하다.

---

## Nginx 리버스 프록시를 앞단에 둘 경우

프록시 뒤에서는 모든 요청의 출발지가 `127.0.0.1`로 보인다. 그대로 두면
레이트 리밋이 팀 전체 공용이 되고, 내부 전용 API의 접근 제한도 무력화된다.

Nginx 쪽에 실제 클라이언트 IP를 전달하도록 설정한다:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;

# 내부 전용 API는 외부에 노출하지 않는다
location /api/internal { return 404; }
```

백엔드에는 신뢰할 프록시 주소를 지정한다(기본값이 로컬 홉이므로 같은 호스트면 그대로 두면 된다):

```env
TRUSTED_PROXIES=127.0.0.1,::1
```

여기 등록되지 않은 출발지가 붙인 `X-Forwarded-For`는 무시되므로 IP 위조는 통하지 않는다.

---

## 빌드 및 실행

### 최초 실행 (이미지 빌드 포함)

```bash
docker compose up -d --build
```

### 일반 실행 (이미지가 이미 빌드된 경우)

```bash
docker compose up -d
```

### 서비스 중지

```bash
docker compose down
```

> `docker compose down -v`는 볼륨까지 삭제하므로 주의한다. 데이터가 영구 삭제된다.

---

## 볼륨 설명

| 볼륨명 | 용도 | 컨테이너 마운트 경로 |
|--------|------|---------------------|
| `claude-configs` | 사용자별 Claude CLI OAuth 인증 정보 (credentials.json 등) | `/data/claude-configs` |
| `projects` | 프로젝트 Git 저장소 원본 | `/data/projects` |
| `projects-wt` | 세션별 Git worktree 디렉토리 | `/data/projects-wt` |
| `postgres-data` | PostgreSQL 데이터베이스 파일 | `/var/lib/postgresql/data` |

- `claude-configs` 볼륨 내 파일 권한은 700(디렉토리) / 600(credentials.json)을 유지한다.
- `projects-wt`는 세션 종료 후에도 worktree가 남아 있을 수 있으므로 주기적 정리를 권장한다.

---

## 로그 확인

### 전체 서비스 로그

```bash
docker compose logs -f
```

### 특정 서비스 로그

```bash
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f postgres
```

### 최근 100줄만 확인

```bash
docker compose logs --tail 100 backend
```

---

## Prisma 마이그레이션

백엔드 컨테이너는 시작 시 Prisma 마이그레이션을 자동으로 실행한다. 별도의 수동 마이그레이션이 필요하지 않다.

수동으로 마이그레이션을 실행해야 하는 경우:

```bash
docker compose exec backend npx prisma migrate deploy
```

Prisma Studio로 DB를 확인하려면:

```bash
docker compose exec backend npx prisma studio
```

---

## 데이터 백업

### PostgreSQL 데이터 백업

```bash
# SQL 덤프 생성
docker compose exec postgres pg_dump -U nexus nexus > backup_$(date +%Y%m%d_%H%M%S).sql
```

### PostgreSQL 데이터 복원

```bash
# SQL 덤프 복원
cat backup_20260404_120000.sql | docker compose exec -T postgres psql -U nexus nexus
```

### 볼륨 전체 백업

```bash
# 볼륨 데이터를 tar로 백업
docker run --rm -v nexus_projects:/data -v $(pwd):/backup alpine \
  tar czf /backup/projects_backup.tar.gz -C /data .

docker run --rm -v nexus_claude-configs:/data -v $(pwd):/backup alpine \
  tar czf /backup/configs_backup.tar.gz -C /data .
```

---

## 업데이트 방법

코드 변경 후 이미지를 재빌드하고 컨테이너를 재시작한다:

```bash
# 1. 최신 코드 풀
git pull origin main

# 2. 이미지 재빌드 + 컨테이너 재시작
docker compose up -d --build

# 3. 사용하지 않는 이전 이미지 정리 (선택)
docker image prune -f
```

> 백엔드 재시작 시 Prisma 마이그레이션이 자동 실행되므로 DB 스키마 변경도 자동 반영된다.

---

## 트러블슈팅

### 포트 충돌

```
Error: bind: address already in use
```

- 3000, 8080, 5432 포트가 이미 사용 중인지 확인한다:

```bash
sudo lsof -i :3000
sudo lsof -i :8080
sudo lsof -i :5432
```

- 기존 프로세스를 종료하거나, `docker-compose.yml`에서 포트 매핑을 변경한다.

### DB 연결 실패

```
Error: P1001: Can't reach database server
```

- PostgreSQL 컨테이너가 정상 실행 중인지 확인한다:

```bash
docker compose ps postgres
docker compose logs postgres
```

- `.env`의 `DATABASE_URL`이 올바른지 확인한다. 컨테이너 간 통신에서는 호스트명으로 서비스명(`postgres`)을 사용한다.
- PostgreSQL이 완전히 시작되기 전에 백엔드가 연결을 시도하는 경우, `docker compose restart backend`로 재시작한다.

### Claude CLI 인증 오류

- 사용자의 Claude OAuth 인증이 만료되었을 수 있다. 웹 UI에서 재인증을 진행한다.
- `claude-configs` 볼륨의 파일 권한을 확인한다:

```bash
docker compose exec backend ls -la /data/claude-configs/
```

- 디렉토리 권한이 700, `credentials.json` 파일 권한이 600인지 확인한다.

### 컨테이너가 계속 재시작되는 경우

```bash
# 컨테이너 상태 확인
docker compose ps

# 종료 로그 확인
docker compose logs --tail 50 backend
```

- 환경변수 누락, DB 연결 실패, 포트 충돌 등이 원인일 수 있다.
- `.env` 파일의 모든 필수 항목이 설정되어 있는지 확인한다.

### 디스크 공간 부족

```bash
# Docker 디스크 사용량 확인
docker system df

# 사용하지 않는 리소스 정리
docker system prune -f
```

---

## 프로덕션 배포 시 권장사항

- Nginx 리버스 프록시로 HTTPS 종단 처리
- `SESSION_SECRET`은 충분히 긴 랜덤 문자열 사용 (최소 32자)
- PostgreSQL 정기 백업 크론잡 설정
- Docker 로그 로테이션 설정 (`docker-compose.yml`에서 `logging` 옵션)
- 모니터링 도구 연동 (예: Prometheus + Grafana)

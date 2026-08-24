# Nexus

팀 전용 웹 기반 자연어 코딩 + PM 플랫폼.
Claude Code CLI를 래핑하여 웹에서 자연어로 AI에게 코딩을 지시하고 팀 단위로 협업합니다.

## 기술 스택

- **Frontend**: Next.js 16 (App Router), TypeScript, Tailwind CSS, shadcn/ui, Socket.IO Client, TanStack Query, Zustand
- **Backend**: Node.js + Fastify 5, TypeScript, Socket.IO, Prisma 7, simple-git
- **DB**: PostgreSQL (Prisma ORM)
- **Infra**: EC2, pm2, Nginx

## 설치 및 실행

### 사전 요구사항

- Node.js 20+
- PostgreSQL 15+
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)

### 1. 클론

```bash
git clone git@github.com:Strangekim/Nexus.git
cd Nexus
```

### 2. 환경변수 설정

```bash
# 백엔드
cp backend/.env.example backend/.env
# DATABASE_URL, SESSION_SECRET 등 실제 값으로 수정

# 프론트엔드
cp frontend/.env.example frontend/.env.local
# NEXT_PUBLIC_API_URL을 실제 서버 주소로 수정
```

### 3. 의존성 설치

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 4. DB 설정

```bash
# PostgreSQL에 DB 및 유저 생성
sudo -u postgres psql -c "CREATE USER nexus WITH PASSWORD 'nexus';"
sudo -u postgres psql -c "CREATE DATABASE nexus OWNER nexus;"

# 마이그레이션 실행
cd backend
npx prisma migrate deploy

# 관리자 계정 시드 (초기 비밀번호는 콘솔에 출력됨 — 반드시 변경)
ADMIN_SEED_PASSWORD=your_secure_password npx tsx src/seed.ts
```

### 5. 실행

```bash
# 백엔드 (포트 8080)
cd backend && npm run dev

# 프론트엔드 (포트 3000)
cd frontend && npm run dev
```

## 선택적 서비스

### 알리고 SMS 알림

`.env`에 알리고 API 키를 설정하면 SMS 알림이 활성화됩니다.
미설정 시 자동으로 비활성화되며 다른 기능에 영향 없습니다.

```env
ALIGO_API_KEY=your_api_key
ALIGO_USER_ID=your_user_id
ALIGO_SENDER=01012345678
```

### Claude Code CLI

AI 코딩 기능을 사용하려면 Claude Code CLI가 설치되어 있어야 합니다.
미설치 시 채팅 기능만 비활성화되며 나머지 기능은 정상 동작합니다.

```bash
npm install -g @anthropic-ai/claude-code
```

## 프로젝트 구조

```
Nexus/
├── frontend/          # Next.js 프론트엔드
│   ├── src/app/       # App Router 페이지
│   ├── src/components/# UI 컴포넌트
│   ├── src/hooks/     # 커스텀 훅
│   ├── src/stores/    # Zustand 스토어
│   └── src/services/  # API 함수
├── backend/           # Fastify 백엔드
│   ├── src/routes/    # API 라우트
│   ├── src/services/  # 비즈니스 로직
│   ├── src/plugins/   # Fastify 플러그인
│   └── prisma/        # DB 스키마 + 마이그레이션
└── docs/              # 설계 문서
    ├── api-spec.md
    ├── db-schema.md
    ├── frontend-design.md
    └── plans/         # Phase별 구현 계획
```

## 설계 문서

- [API 명세](docs/api-spec.md)
- [DB 스키마](docs/db-schema.md)
- [프론트엔드 설계](docs/frontend-design.md)
- [프로젝트 기획서](description.md)

#!/bin/bash
# Docker 엔트리포인트: 마이그레이션 → 관리자 시드 → 서버 시작

set -e

echo "=== Prisma 마이그레이션 실행 ==="
npx prisma migrate deploy

echo "=== 필수 디렉토리 생성 ==="
mkdir -p /data/claude-configs
mkdir -p /data/projects
mkdir -p /data/projects-wt

# ============================================================
# 관리자 계정 시드
#
# 이 단계가 없으면 최초 배포 시 User 테이블이 비어 있고,
# 회원가입 API도 없어 아무도 로그인할 수 없다.
# ADMIN_SEED_PASSWORD가 설정된 경우에만 실행하며,
# seed는 upsert라 이미 계정이 있으면 비밀번호를 덮어쓰지 않는다.
# ============================================================
if [ -n "$ADMIN_SEED_PASSWORD" ]; then
  echo "=== 관리자 계정 시드 ==="
  npx tsx src/seed.ts
else
  echo "=== 관리자 시드 건너뜀 (ADMIN_SEED_PASSWORD 미설정) ==="
  echo "    최초 배포라면 .env에 ADMIN_SEED_PASSWORD를 설정한 뒤 다시 시작하세요."
fi

echo "=== 서버 시작 ==="
exec npx tsx src/index.ts

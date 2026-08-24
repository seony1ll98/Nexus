// 초기 관리자 계정 시드 데이터
//
// 컨테이너 엔트리포인트에서 매 기동 시 호출될 수 있으므로 멱등하게 동작해야 한다.
// 계정이 이미 있으면 비밀번호를 덮어쓰지 않고, 새 비밀번호를 출력하지도 않는다
// (있지도 않은 비밀번호를 안내하면 로그를 보는 사람이 오해한다).
import 'dotenv/config';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import bcrypt from 'bcrypt';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/** 초기 관리자 이메일 */
const ADMIN_EMAIL = 'admin@nexus.com';

async function main() {
  const existing = await prisma.user.findUnique({
    where: { email: ADMIN_EMAIL },
    select: { id: true },
  });

  if (existing) {
    console.log(`관리자 계정(${ADMIN_EMAIL})이 이미 존재합니다 — 시드를 건너뜁니다.`);
    return;
  }

  // 환경변수에서 관리자 초기 비밀번호 읽기 — 미설정 시 랜덤 생성
  const seedPassword = process.env.ADMIN_SEED_PASSWORD || crypto.randomBytes(16).toString('hex');
  const passwordHash = await bcrypt.hash(seedPassword, 10);

  const admin = await prisma.user.create({
    data: {
      name: '관리자',
      email: ADMIN_EMAIL,
      passwordHash,
      role: 'admin',
    },
    select: { id: true, name: true, email: true, role: true },
  });

  console.log('관리자 계정을 생성했습니다:', admin.email);
  console.log('초기 비밀번호:', seedPassword, '(반드시 변경하세요)');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

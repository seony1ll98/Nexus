// 폴더 서비스 레이어
import prisma from '../lib/prisma.js';
import { createHttpError } from '../lib/errors.js';
import { git as openRepo, authorForUser } from '../lib/git.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * 폴더명에서 파일시스템 안전한 디렉토리명 생성
 * project.service.ts와 동일한 패턴 사용
 */
function sanitizeDirName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9가-힣\s-_]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase();
}

/** 프로젝트 내 폴더 목록 조회 */
async function findByProject(projectId: string) {
  return prisma.folder.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  });
}

/** 폴더 단건 조회 */
async function findById(id: string) {
  return prisma.folder.findUnique({ where: { id } });
}

/** 폴더 생성 — 실제 git 저장소에 디렉토리 생성 + 커밋 포함 */
async function create(
  projectId: string,
  dto: { name: string; description?: string },
  /** 폴더를 만든 사용자 — 커밋 작성자로 기록된다 */
  userId?: string | null,
) {
  // 중복 검사
  const exists = await prisma.folder.findUnique({
    where: { projectId_name: { projectId, name: dto.name } },
  });
  if (exists) {
    throw createHttpError(409, '같은 프로젝트 내에 동일한 폴더명이 존재합니다');
  }

  // 프로젝트 repoPath 조회
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { repoPath: true },
  });
  if (!project) {
    throw createHttpError(404, '프로젝트를 찾을 수 없습니다');
  }

  // 디렉토리명 생성 (파일시스템 안전한 이름)
  const dirName = sanitizeDirName(dto.name);
  if (!dirName) {
    throw createHttpError(400, '유효한 디렉토리명을 생성할 수 없습니다');
  }

  const dirPath = path.join(project.repoPath, dirName);

  // 실제 디렉토리 생성 + .gitkeep 파일 추가
  await fs.mkdir(dirPath, { recursive: true });
  await fs.writeFile(path.join(dirPath, '.gitkeep'), '', 'utf8');

  // git add + commit (커밋 신원은 lib/git.ts가 주입)
  const git = openRepo(project.repoPath, await authorForUser(userId));
  await git.add(path.join(dirName, '.gitkeep'));
  await git.commit(`폴더 "${dto.name}" 생성`);

  // DB 저장 (dirName 포함)
  return prisma.folder.create({
    data: { projectId, name: dto.name, dirName, description: dto.description },
  });
}

/** 폴더 수정 — dirName은 변경하지 않음 (디렉토리 유지) */
async function update(id: string, dto: { name?: string; description?: string }) {
  return prisma.folder.update({ where: { id }, data: dto });
}

/** 폴더 삭제 */
async function remove(id: string) {
  return prisma.folder.delete({ where: { id } });
}

export const folderService = { findByProject, findById, create, update, remove };

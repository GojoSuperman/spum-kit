/**
 * SPUM Studio 백업 파일 (내보내기/불러오기) 읽기·쓰기.
 *
 * 근거: studio/shell/StudioPersistence.js
 *   exportStudioData()        → { type, version, exportedAt, activeSection, keys }
 *   normalizeStudioBackupPayload() → keys 의 값은 전부 "문자열" 이어야 한다
 *   importStudioDataFromFile() → replaceStudioData() 로 **전체를 교체**한다
 *
 * ★ 불러오기는 병합이 아니라 교체다. 그래서 이 모듈은 항상 기존 백업 위에
 *   얹는 방식(mergeIntoBackup)을 기본으로 쓴다. 맵만 든 파일을 그냥 불러오면
 *   캐릭터·오브젝트·월드가 전부 사라진다.
 */
import { readFile } from 'node:fs/promises';

export const STUDIO_BACKUP_TYPE = 'spum-studio-local-backup';
export const STUDIO_BACKUP_VERSION = 1;

/** Studio 가 백업에 담는 정확 키 (StudioPersistence.STUDIO_BACKUP_EXACT_KEYS 중 핵심) */
export const STUDIO_CORE_KEYS = Object.freeze({
  characters: 'sv_studio_characters_v1',
  maps: 'sv_studio_maps_v1',
  objects: 'sv_studio_smo_v1',
  worldDrafts: 'sv_studio_draft_v1',
  worldLibrary: 'sv_studio_draft_library_v1',
});

export function createBackup(keys = {}, activeSection = 'map') {
  const stringified = Object.fromEntries(
    Object.entries(keys).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ])
  );
  return {
    type: STUDIO_BACKUP_TYPE,
    version: STUDIO_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    activeSection,
    keys: stringified,
  };
}

export async function readBackup(path) {
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  const keys = parsed?.keys && typeof parsed.keys === 'object'
    ? parsed.keys
    : (parsed?.localStorage && typeof parsed.localStorage === 'object' ? parsed.localStorage : null);
  if (!keys) {
    throw new Error(`${path}: Studio 백업이 아닙니다 (keys 가 없습니다). Studio 우상단 메뉴 → 데이터 저장 으로 받은 파일을 주세요.`);
  }
  return { ...parsed, keys };
}

/** 백업 안의 키 하나를 배열로 꺼낸다 (값은 JSON 문자열로 들어 있다) */
export function readKeyArray(backup, key) {
  const raw = backup?.keys?.[key];
  if (raw == null) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 기존 백업의 다른 데이터는 그대로 두고 한 키만 갈아끼운다.
 * @returns 새 백업 객체 (원본은 건드리지 않는다)
 */
export function mergeIntoBackup(backup, key, list, activeSection = null) {
  return {
    ...backup,
    type: STUDIO_BACKUP_TYPE,
    version: STUDIO_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    activeSection: activeSection || backup?.activeSection || 'map',
    keys: { ...backup.keys, [key]: JSON.stringify(list) },
  };
}

/** 백업에 뭐가 들어 있는지 한 줄 요약 */
export function summarizeBackup(backup) {
  const counts = Object.entries(STUDIO_CORE_KEYS).map(([label, key]) => {
    const list = readKeyArray(backup, key);
    return `${label} ${list.length}`;
  });
  const other = Object.keys(backup?.keys || {}).length;
  return `${counts.join(' · ')} (키 ${other}개)`;
}

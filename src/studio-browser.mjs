/**
 * SPUM Studio 를 Playwright 로 여는 공용 헬퍼.
 *
 * 왜 persistent context 인가 (실측 근거, docs/Studio와 Claude Code 역할 분담.md 1-1):
 *   Studio 인증은 httpOnly 쿠키 세션뿐이고 API 키 경로가 없다. 그래서 쿠키를
 *   디스크에 남기는 프로필이 있어야 로그인 한 번으로 이후 자동화가 이어진다.
 *   launchPersistentContext 는 user-data-dir 을 그대로 쓰므로 쿠키가 유지된다.
 *
 * 프로필 디렉토리에는 로그인 쿠키가 들어간다. .gitignore 에 `.browser/` 로 막아 뒀다.
 */

import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 프로필(=로그인 세션 + localStorage)을 어디에 둘 것인가.
 *
 * ★ 홈의 공용 위치가 기본이다 (2026-08-20). 프로젝트마다 프로필을 따로 두면
 *   ① SPUM 프로젝트를 새로 팔 때마다 매직링크 재로그인을 해야 하고,
 *   ② localStorage 가 여러 벌이 되어 **나중에 여는 쪽이 낡은 상태를 최신 리비전으로
 *      올려버린다** (동기화가 append-only 라서. docs/Studio 를 두 곳에서 쓰기.md 참고).
 *   공용으로 두면 로그인 한 번, 로컬 한 벌이다. 산출물(out/)은 실행한 프로젝트에 남는다.
 *
 * 우선순위: SPUM_STUDIO_HOME 환경변수 > 이 저장소의 옛 .browser/ (있으면) > ~/.spum-studio
 */
function resolveStudioHome() {
  if (process.env.SPUM_STUDIO_HOME) return path.resolve(process.env.SPUM_STUDIO_HOME);
  const legacy = path.join(ROOT, '.browser');
  if (fs.existsSync(path.join(legacy, 'profile'))) return legacy;   // 기존 설치를 깨지 않는다
  return path.join(os.homedir(), '.spum-studio');
}

export const STUDIO_HOME = resolveStudioHome();
export const PROFILE_DIR = path.join(STUDIO_HOME, 'profile');
/**
 * 쿠키 이중 백업.
 *
 * 왜 필요한가 (2026-08-20 실측 사고): 크롬은 쿠키를 즉시 디스크에 쓰지 않는다.
 * 스크립트가 예외로 죽으면서 context.close() 를 안 하면 브라우저가 강제 종료되고,
 * **이미 들어와 있던 spum_session 까지 유실된다** (실제로 날아갔다).
 * SSO 는 이메일 매직링크라 재로그인에 사람 손이 필요하므로, 세션 유실 비용이 크다.
 * 그래서 쿠키를 프로필 밖에 한 벌 더 둔다.
 */
export const SESSION_FILE = path.join(STUDIO_HOME, 'session.json');
export const STUDIO_ORIGIN = 'https://spum.soonsoon.ai';
export const STUDIO_URL = `${STUDIO_ORIGIN}/studio/`;

/**
 * 프로필을 물린 브라우저 컨텍스트를 연다.
 * @param {{ headless?: boolean }} [opts] headless 기본 true. 로그인은 false 로.
 */
/**
 * 프로필을 이미 다른 크롬이 쓰고 있는지 본다.
 *
 * ★ 2026-08-20, 반나절을 잡아먹은 원인.
 *   `npm run studio-open` 으로 띄운 창을 열어둔 채 다른 스크립트를 돌리면,
 *   크롬이 "기존 브라우저 세션에서 여는 중" 으로 붙어버리고 **저장이 남지 않는다.**
 *   localStorage 소실 · saveServerSnapshot=false · 쿠키 미보존이 전부 이 하나였다.
 *   조용히 이상하게 도는 것보다 시작하기 전에 멈추는 편이 훨씬 낫다.
 */
export function findProfileHolders() {
  try {
    const out = execSync(
      `ps -eo pid,cmd | grep "chrome-linux64/chrome" | grep -v grep | grep -F "user-data-dir=${PROFILE_DIR}" || true`,
      { encoding: 'utf8' }
    ).trim();
    if (!out) return [];
    return out.split('\n').map((l) => Number(l.trim().split(/\s+/)[0])).filter(Boolean);
  } catch { return []; }
}

export async function openStudioContext(opts = {}) {
  const { headless = true, allowShared = false, recordDir = null } = opts;
  if (!allowShared) {
    const holders = findProfileHolders();
    if (holders.length) {
      throw new Error(
        `프로필을 이미 쓰는 크롬이 있습니다 (pid ${holders.join(', ')}).\n` +
        `  같은 프로필을 두 크롬이 동시에 쓰면 저장이 남지 않습니다 — 데이터가 날아갑니다.\n` +
        `  떠 있는 Studio 창(Chrome for Testing)을 닫고 다시 실행하세요.`
      );
    }
  }
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    // 녹화할 땐 뷰포트를 고정해야 프레임 크기가 흔들리지 않는다
    viewport: (headless || recordDir) ? { width: 1600, height: 1000 } : null,
    args: headless ? [] : ['--window-size=1600,1000'],
    ...(recordDir ? { recordVideo: { dir: recordDir, size: { width: 1600, height: 1000 } } } : {}),
  });
  // 프로필에 세션이 없고 백업이 있으면 되살린다 (프로필이 깨져도 로그인이 살아남는다)
  try {
    const has = (await context.cookies(STUDIO_ORIGIN)).some((c) => c.name === 'spum_session');
    if (!has && fs.existsSync(SESSION_FILE)) {
      const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      if (Array.isArray(saved?.cookies) && saved.cookies.length) {
        await context.addCookies(saved.cookies);
        console.log('[studio-browser] 백업에서 세션 쿠키를 복원했습니다.');
      }
    }
  } catch (e) {
    console.warn('[studio-browser] 세션 복원 실패(무시하고 진행):', e.message);
  }
  return context;
}

/**
 * 현재 컨텍스트의 쿠키를 프로필 밖에 저장한다. 로그인 직후·작업 끝에 부른다.
 *
 * ★ spum_session 이 없으면 **저장하지 않는다.**
 *   2026-08-20 사고: 로그아웃 상태에서 withStudio 가 finally 로 saveSession 을 부르는 바람에
 *   멀쩡하던 백업이 빈 쿠키로 덮여 날아갔다. 백업의 존재 이유를 스스로 지운 셈이다.
 */
export async function saveSession(context) {
  const cookies = await context.cookies();
  const hasSession = cookies.some((c) => c.name === 'spum_session');
  if (!hasSession) return { saved: false, reason: 'spum_session 없음 — 기존 백업을 지키려고 저장하지 않았습니다' };
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ savedAt: new Date().toISOString(), cookies }, null, 2), { mode: 0o600 });
  return { saved: true, count: cookies.length };
}

/**
 * 컨텍스트를 열고 콜백을 돌린 뒤 **무슨 일이 있어도 닫는다.**
 * 강제 종료로 쿠키가 날아가는 사고를 막는 유일한 방법이다.
 */
export async function withStudio(opts, fn) {
  const context = await openStudioContext(opts);
  try {
    return await fn(context);
  } finally {
    try { await saveSession(context); } catch { /* 저장 실패가 close 를 막으면 안 된다 */ }
    // 영상은 context.close() 뒤에야 파일로 떨어진다
    const videos = opts?.recordDir ? context.pages().map((p) => p.video()).filter(Boolean) : [];
    await context.close();
    for (const v of videos) {
      try { console.log(`[녹화] ${await v.path()}`); } catch { /* 저장 실패는 무시 */ }
    }
  }
}

/**
 * Studio 오리진에 있는 탭을 찾는다. 없으면 새로 연다.
 *
 * 왜 필요한가 (실측, 2026-08-20): 로그인은 SSO 리다이렉트라 원래 탭이 SoonSoon ID
 * 도메인에 남고, Studio 는 새 탭으로 열린다. 그 상태에서 다른 오리진 탭에 대고
 * fetch(studio/api/me) 를 하면 CORS 로 막혀 "로그인 안 됨" 처럼 보인다.
 * 그래서 항상 오리진이 맞는 탭을 골라야 한다.
 */
export async function findStudioPage(context) {
  for (const p of context.pages()) {
    if (p.url().startsWith(STUDIO_ORIGIN)) return p;
  }
  return null;
}

/**
 * 로그인 여부를 서버에 물어본다.
 * /api/me 가 {"user":null} 이면 로그아웃 (실측, 같은 문서 1-1).
 * @returns {Promise<{ loggedIn: boolean, user: any, status: number }>}
 */
export async function checkSession(page) {
  // 오리진이 다르면 CORS 로 막힌다 — 조용히 실패하지 말고 분명히 알린다.
  if (!page.url().startsWith(STUDIO_ORIGIN)) {
    return { loggedIn: false, user: null, status: 0, wrongOrigin: page.url() };
  }
  return page.evaluate(async (origin) => {
    const res = await fetch(`${origin}/api/me`, { credentials: 'include' });
    let body = null;
    try { body = await res.json(); } catch { /* 비 JSON 응답 */ }
    return { loggedIn: Boolean(body?.user), user: body?.user ?? null, status: res.status };
  }, STUDIO_ORIGIN);
}

/**
 * 쿠키를 값 없이 요약한다. 세션이 브라우저 종료 후에도 살아남는지 보려면
 * expires 가 -1(세션 쿠키)인지 봐야 한다. 값은 시크릿이므로 절대 찍지 않는다.
 */
export async function summarizeCookies(context) {
  const cookies = await context.cookies(STUDIO_ORIGIN);
  return cookies.map((c) => ({
    name: c.name,
    domain: c.domain,
    httpOnly: c.httpOnly,
    secure: c.secure,
    // -1 = 세션 쿠키 → 브라우저를 닫으면 사라진다
    expires: c.expires === -1 ? '세션(브라우저 종료 시 소멸)' : new Date(c.expires * 1000).toISOString(),
  }));
}

/**
 * 세션을 보장한다 — 끊겼으면 스스로 되살린다.
 *
 * 실측(2026-08-20): spum_session 은 쿠키 만료가 +30일인데도 **서버 쪽 세션이 15분쯤에 끊긴다.**
 * 그런데 SSO 상위 쿠키(id.soonsoon.ai 의 id_access·id_refresh)가 살아 있으면
 * `/auth/login` 을 한 번 방문하는 것만으로 /studio/ 로 리다이렉트되며 재발급된다.
 * (id 쿠키까지 죽었으면 id.soonsoon.ai/login 에 멈춘다 — 그때만 사람이 필요하다.)
 *
 * @returns {Promise<{loggedIn:boolean, user:any, renewed?:boolean, needsHuman?:boolean}>}
 */
export async function ensureSession(page) {
  let s = await checkSession(page);
  if (s.loggedIn) return s;

  await page.goto(`${STUDIO_ORIGIN}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(4000);
  if (!page.url().startsWith(STUDIO_ORIGIN)) {
    // SSO 로그인 화면에 멈췄다 = 상위 쿠키도 죽었다. 이메일 매직링크라 사람이 해야 한다.
    return { loggedIn: false, user: null, needsHuman: true, at: page.url() };
  }
  await page.goto(`${STUDIO_ORIGIN}/studio/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => window.spumStudioData != null, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(2000);
  s = await checkSession(page);
  return { ...s, renewed: s.loggedIn };
}

/**
 * 투어 오버레이를 걷어낸다.
 *
 * 2026-08-20: `.studio-tour__shade` 가 화면 전체를 덮어 클릭을 전부 가로챘다
 * (`[data-object-action="create"]` 클릭이 19번 재시도 끝에 타임아웃).
 * 로컬 저장소가 비면 "처음 온 사용자" 로 판단해 투어가 다시 뜨므로 매번 확인한다.
 */
export async function dismissTour(page) {
  let removed = 0;
  for (const f of page.frames()) {
    try {
      removed += await f.evaluate(() => {
        let n = 0;
        for (const el of document.querySelectorAll('.studio-tour, .studio-tour__shade')) { el.remove(); n += 1; }
        try {
          const KEY = 'spum_studio_tour_seen_v1';
          const cur = JSON.parse(localStorage.getItem(KEY) || '{}');
          localStorage.setItem(KEY, JSON.stringify({
            version: 'spum-tour-20260630-2',
            dashboard: true, object: true, character: true, map: true, world: true, ...cur,
          }));
        } catch { /* 저장소 접근 실패는 무시 */ }
        return n;
      });
    } catch { /* 떠난 프레임 */ }
  }
  return removed;
}

/**
 * ★ 로컬이 서버보다 비어 있으면 되돌린다.
 *
 * 2026-08-20 사고: 브라우저 프로필의 localStorage 가 통째로 비었는데 서버에는
 * rev 42 가 멀쩡했다. 이 상태로 Studio 를 새로고침하면 **빈 로컬이 서버를 덮어쓴다**
 * (1-2 의 방향 규칙). 실제로 덮이기 직전에 잡았다.
 *
 * 그래서 모든 작업 앞에서 확인한다. 로컬이 더 많거나 같으면 손대지 않는다
 * (그건 아직 서버에 안 올린 새 작업일 수 있다).
 */
export async function guardLocalData(page) {
  const cmp = await page.evaluate(async () => {
    const n = (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]').length; } catch { return 0; } };
    const local = { maps: n('sv_studio_maps_v1'), smo: n('sv_studio_smo_v1') };
    let server = null;
    try {
      const r = await fetch('/api/studio/state', { credentials: 'include' });
      const j = await r.json();
      const keys = j?.state?.keys || j?.keys || {};
      const c = (k) => { try { return JSON.parse(keys[k] || '[]').length; } catch { return 0; } };
      server = { rev: j?.revision ?? j?.rev ?? j?.state?.revision, maps: c('sv_studio_maps_v1'), smo: c('sv_studio_smo_v1') };
    } catch { /* 서버를 못 읽으면 판단하지 않는다 */ }
    return { local, server };
  });

  if (!cmp.server) return { checked: false, reason: '서버 상태를 못 읽어 비교하지 않았습니다' };

  // ★ 2026-08-20 사고: 맵 개수만 보고 복원했다가, 로컬에만 있던 새 테마(SMO)를 지웠다.
  //   어느 한 종류라도 로컬이 **더 많으면** 그건 아직 서버에 못 올린 새 작업이다 — 손대지 않는다.
  const localAhead = cmp.local.maps > cmp.server.maps || cmp.local.smo > cmp.server.smo;
  if (localAhead) {
    return { checked: true, restored: false, skipped: '로컬에 서버보다 새 것이 있어 복원하지 않았습니다', ...cmp };
  }
  const loss = cmp.local.maps < cmp.server.maps || cmp.local.smo < cmp.server.smo;
  if (!loss) return { checked: true, restored: false, ...cmp };

  // 서버 키를 브라우저 안에서 바로 로컬에 쓴다 (수 MB 를 왕복시키지 않는다)
  const wrote = await page.evaluate(async () => {
    const r = await fetch('/api/studio/state', { credentials: 'include' });
    const j = await r.json();
    const keys = j?.state?.keys || j?.keys || {};
    let n = 0;
    for (const [k, v] of Object.entries(keys)) {
      localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      window.dispatchEvent(new CustomEvent('spum:studio-storage-write', { detail: { key: k, action: 'set' } }));
      n += 1;
    }
    return n;
  });
  return { checked: true, restored: true, wroteKeys: wrote, ...cmp };
}

/**
 * Studio 에 들어가는 표준 절차 — 이걸 쓰면 아래 사고들이 자동으로 막힌다.
 *   세션 만료(8-4) · 투어 오버레이 · 로컬 소실로 인한 서버 덮어쓰기
 */
export async function enterStudio(page, { section = '' } = {}) {
  const url = `${STUDIO_ORIGIN}/studio/${section ? `?section=${section}` : ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.spumStudioData != null, { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const s = await ensureSession(page);
  if (!s.loggedIn) {
    throw new Error(s.needsHuman
      ? 'SSO 쿠키까지 만료됐습니다 — `npm run studio-login` 을 실행하세요.'
      : '세션 확인에 실패했습니다.');
  }
  const tour = await dismissTour(page);
  const guard = await guardLocalData(page);
  if (guard.restored) {
    console.log(`[guard] ⚠ 로컬이 비어 있었습니다 (맵 ${guard.local.maps} < 서버 ${guard.server.maps}). 서버 rev ${guard.server.rev} 에서 ${guard.wroteKeys}개 키를 복원했습니다.`);
    // 복원 후 앱이 제대로 읽도록 한 번 더 들어간다
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    await dismissTour(page);
  }
  if (tour) console.log(`[guard] 투어 오버레이 ${tour}개 제거`);
  return { session: s, guard };
}

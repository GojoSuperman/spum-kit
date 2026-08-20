/**
 * SPUM Studio 로그인 창을 띄우고, 세션이 프로필에 남는지까지 검증한다.
 *
 * 순서:
 *   1. 창을 띄워 Studio 를 연다 (WSLg 로 화면에 뜬다)
 *   2. 사람이 SSO 로그인 → /api/me 폴링으로 확인
 *   3. 쿠키를 값 없이 요약 (세션 쿠키인지 만료 있는 쿠키인지가 관건)
 *   4. 창을 닫고 headless 로 다시 열어 세션이 살아남았는지 재확인
 *
 * 4번이 핵심이다. 세션 쿠키라면 창을 닫는 순간 사라지므로, 그때는
 * 브라우저를 계속 띄워 두는 방식으로 가야 한다.
 */

import { openStudioContext, checkSession, summarizeCookies, saveSession, findStudioPage, STUDIO_URL, PROFILE_DIR, SESSION_FILE } from '../src/studio-browser.mjs';

const WAIT_LIMIT_MS = 10 * 60 * 1000; // 10분
const POLL_MS = 3000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('프로필:', PROFILE_DIR);
  console.log('창을 띄웁니다…');

  const context = await openStudioContext({ headless: false });
  let page = context.pages()[0] ?? (await context.newPage());
  await page.goto(STUDIO_URL, { waitUntil: 'domcontentloaded' });

  let session = await checkSession(page);
  if (session.loggedIn) {
    console.log('이미 로그인돼 있습니다:', session.user?.email ?? session.user?.name ?? '(사용자 정보 없음)');
  } else {
    console.log('');
    console.log('  ▶ 뜬 창에서 로그인해 주세요. 여기서 기다립니다 (최대 10분).');
    console.log('');
    const deadline = Date.now() + WAIT_LIMIT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      try {
        // SSO 는 Studio 를 새 탭으로 연다. 매번 오리진이 맞는 탭을 다시 고른다
        // (안 그러면 원래 탭이 다른 오리진에 남아 CORS 로 조용히 실패한다).
        const studioPage = await findStudioPage(context);
        if (studioPage) page = studioPage;
        session = await checkSession(page);
      } catch (e) {
        // 페이지 이동 중이면 evaluate 가 잠깐 실패한다 — 무시하고 계속
        continue;
      }
      if (session.loggedIn) break;
      process.stdout.write('.');
    }
    console.log('');
    if (!session.loggedIn) {
      console.error('시간 안에 로그인이 확인되지 않았습니다. 창을 닫고 다시 실행하세요.');
      await context.close();
      process.exit(1);
    }
    console.log('로그인 확인:', session.user?.email ?? session.user?.name ?? '(사용자 정보 없음)');
  }

  const cookies = await summarizeCookies(context);
  console.log('');
  console.log('쿠키 (값은 시크릿이라 생략):');
  for (const c of cookies) {
    console.log(`  ${c.name.padEnd(28)} httpOnly=${String(c.httpOnly).padEnd(5)} 만료=${c.expires}`);
  }

  // 프로필 밖에 한 벌 더 저장한다 — 프로필이 깨져도 로그인이 살아남는다
  const r = await saveSession(context);
  console.log('');
  console.log(r.saved ? `세션 백업: ${SESSION_FILE} (쿠키 ${r.count}개)` : `세션 백업 건너뜀 — ${r.reason}`);

  console.log('창을 닫고 프로필에서 세션이 살아남는지 확인합니다…');
  await context.close();

  const headless = await openStudioContext({ headless: true });
  const hp = headless.pages()[0] ?? (await headless.newPage());
  await hp.goto(STUDIO_URL, { waitUntil: 'domcontentloaded' });
  const after = await checkSession(hp);
  await headless.close();

  console.log('');
  if (after.loggedIn) {
    console.log('✅ 세션이 프로필에 남았습니다 — 앞으로 headless 자동화가 그대로 됩니다.');
    console.log('   사용자:', after.user?.email ?? after.user?.name ?? '(정보 없음)');
  } else {
    console.log('⚠️  창을 닫으니 세션이 사라졌습니다 (세션 쿠키).');
    console.log('   → 브라우저를 띄워 둔 채로 붙는 방식(장기 실행 컨텍스트)으로 가야 합니다.');
    console.log('   /api/me 상태코드:', after.status);
  }
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});

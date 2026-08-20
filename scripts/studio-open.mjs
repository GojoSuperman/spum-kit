/**
 * 자동화 프로필로 Studio 창을 띄우고, 사람이 닫을 때까지 유지한다.
 *
 * 왜 이 창으로 봐야 하나 (문서 1-2):
 *   localStorage 가 원본이고 서버는 백업이다. 평소 쓰던 크롬에 예전 데이터가 남아
 *   있으면, 그 브라우저로 Studio 를 열었을 때 **로컬이 서버를 덮어쓴다.**
 *   코드로 넣은 맵이 그렇게 날아갈 수 있다. 그래서 확인은 이 프로필에서 한다.
 *
 * 사용: npm run studio-open [-- --section map]
 */

import { appendFileSync } from 'node:fs';
import { withStudio, enterStudio, saveSession, STUDIO_ORIGIN } from '../src/studio-browser.mjs';

const args = process.argv.slice(2);
const section = (() => { const i = args.indexOf('--section'); return i > -1 ? args[i + 1] : 'map'; })();

const WATCH_LOG = 'out/session-watch.log';
const wlog = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(`[감시] ${line}`);
  try { appendFileSync(WATCH_LOG, line + '\n'); } catch { /* 로그 실패는 무시 */ }
};

await withStudio({ headless: false }, async (ctx) => {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const { session } = await enterStudio(page, { section });
  console.log(`로그인 상태: ${session.user?.email}`);

  const maps = await page.evaluate(() => JSON.parse(localStorage.getItem('sv_studio_maps_v1') || '[]').map((m) => `${m.name} (${m.width}×${m.height})`));
  console.log('맵 목록:', maps.join(' · ') || '(없음)');
  console.log('');
  console.log('  창을 띄웠습니다. 다 보시면 **창을 닫으세요** — 창을 닫아야 세션이 안전하게 저장됩니다.');
  console.log('  타일이 오버레이(빨강/초록)에 가려지면 오른쪽 MAP STRUCTURE > Navigation 의');
  console.log('  체크박스 2개(장애물/워커블)를 끄세요.');

  // ── 세션 감시 (2026-08-21: 창 세션 중 세션이 죽는 원인 불명 사고 3회) ──
  // 30초마다 ① spum_session 값이 회전하면 즉시 백업 ② /api/me 로 생사를 기록한다.
  // 죽는 정확한 시각이 로그에 남고, 회전 유실이 원인이라면 백업만으로 복구된다.
  let lastToken = (await ctx.cookies(STUDIO_ORIGIN)).find((c) => c.name === 'spum_session')?.value || '';
  wlog(`감시 시작 — spum_session ${lastToken ? '있음' : '없음'} (로그: ${WATCH_LOG})`);
  let alive = true;
  const watcher = setInterval(async () => {
    try {
      const cookies = await ctx.cookies(STUDIO_ORIGIN);
      const token = cookies.find((c) => c.name === 'spum_session')?.value || '';
      if (token && token !== lastToken) {
        lastToken = token;
        const saved = await saveSession(ctx);
        wlog(`spum_session 회전 감지 → 백업 ${saved.saved ? '갱신' : '실패: ' + saved.reason}`);
      } else if (!token && lastToken) {
        wlog('★ spum_session 이 프로필에서 사라졌습니다 (앱이 지웠거나 서버가 무효화)');
        lastToken = '';
      }
      const me = await ctx.request.get(`${STUDIO_ORIGIN}/api/me`, { timeout: 10000 });
      const body = await me.json().catch(() => ({}));
      const ok = !!body?.user?.email;
      if (ok !== alive) {
        wlog(ok ? '세션 살아남 (복구됨)' : `★ 세션 죽음 — /api/me ${me.status()} ${JSON.stringify(body).slice(0, 120)}`);
        alive = ok;
      }
    } catch (e) {
      wlog(`감시 오류(창이 닫혔을 수 있음): ${String(e.message).slice(0, 80)}`);
    }
  }, 30000);

  // 창이 닫힐 때까지 기다린다
  await new Promise((resolve) => {
    ctx.on('close', resolve);
    page.on('close', () => setTimeout(resolve, 500));
  });
  clearInterval(watcher);
  console.log('창이 닫혔습니다.');
});

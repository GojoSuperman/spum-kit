#!/usr/bin/env node
/**
 * 서버 Studio 저장소의 리비전을 이 프로필 로컬(localStorage)로 당겨온다.
 *
 * 왜 필요한가 (2026-08-20 실측 사고):
 *   Studio 동기화는 **append-only** 다. 부팅할 때 로컬과 서버가 다르면 서버를 읽어오는 게
 *   아니라 **로컬을 새 리비전으로 얹는다** (main.js 의 `boot-diverge-append`).
 *   그래서 사람이 자기 브라우저로 Studio 를 열면, 그 브라우저의 낡은 로컬이 최신 리비전이
 *   되어 버린다 — 실제로 맵 5개가 있던 rev 76 위에 옛 맵 하나뿐인 rev 78 이 얹혔다.
 *   덮어쓰기가 아니라 append 라 히스토리에 남지만, 다음에 여는 쪽은 낡은 걸 보게 된다.
 *
 *   이 스크립트는 그 반대 방향을 해준다: **서버의 좋은 리비전을 로컬로 가져온 뒤**
 *   작업을 시작하면, 이후 append 되는 것도 최신 기준이 된다.
 *
 * 사용:
 *   npm run studio-pull                  현재 활성 리비전을 가져온다
 *   npm run studio-pull -- --list        리비전 목록만 본다 (가져오지 않음)
 *   npm run studio-pull -- --revision 79 특정 리비전을 가져온다
 *   npm run studio-pull -- --dry-run     무엇이 바뀔지만 보여준다
 *   npm run studio-pull -- --replace     서버에 없는 Studio 로컬 키도 지운다 (기본은 병합)
 *
 * 앱을 띄우지 않고 localStorage 만 만진다. 앱을 띄우면 그 순간 동기화가 돌아
 * 우리가 방금 넣은 것과 다른 리비전이 얹힐 수 있기 때문이다.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { openStudioContext, STUDIO_ORIGIN } from '../src/studio-browser.mjs';

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : d; };
const has = (n) => args.includes(n);

const wantList = has('--list');
const dryRun = has('--dry-run');
const replace = has('--replace');
const wantRevision = arg('--revision');

const kb = (n) => `${Math.round(n / 1024)}KB`;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const ctx = await openStudioContext({ headless: true });
try {
  // ── 로그인 확인 ────────────────────────────────────────
  const me = await (await ctx.request.get(`${STUDIO_ORIGIN}/api/me`)).json().catch(() => ({}));
  if (!me?.user?.email) {
    console.error('로그인이 안 돼 있습니다. `npm run studio-login` 으로 먼저 로그인하세요.');
    console.error('(사람이 브라우저로 로그인하면 자동화 세션이 무효화됩니다 — 계정당 세션 하나)');
    process.exit(1);
  }
  console.log(`로그인: ${me.user.email}`);

  // ── 리비전 목록 ────────────────────────────────────────
  const revs = await (await ctx.request.get(`${STUDIO_ORIGIN}/api/studio/revisions`)).json();
  const list = revs.revisions || [];
  const active = revs.activeRevision;
  console.log(`서버 리비전 ${list.length}개 · 활성 rev ${active}\n`);
  for (const r of list.slice(0, wantList ? 20 : 5)) {
    console.log(`  ${r.isActive ? '▶' : ' '} rev ${String(r.revision).padStart(3)}  ${r.createdAt?.slice(0, 19).replace('T', ' ')}  ${kb(r.rawSizeBytes || 0).padStart(7)}  ${r.activeSection || ''}`);
  }
  if (wantList) {
    console.log('\n특정 리비전을 가져오려면: npm run studio-pull -- --revision <번호>');
    process.exit(0);
  }

  // ── 대상 리비전 받기 ───────────────────────────────────
  const target = wantRevision ? Number(wantRevision) : active;
  const url = wantRevision ? `/api/studio/revisions/${target}` : '/api/studio/state';
  const body = await (await ctx.request.get(`${STUDIO_ORIGIN}${url}`)).json();
  const state = body.state || body;
  if (!state?.keys) { console.error(`rev ${target} 을 받지 못했습니다.`); process.exit(1); }
  const serverKeys = state.keys;
  const serverMaps = JSON.parse(serverKeys['sv_studio_maps_v1'] || '[]');
  console.log(`\n가져올 rev ${state.revision} (${state.updatedAt?.slice(0, 19).replace('T', ' ')})`);
  console.log(`  맵 ${serverMaps.length}개: ${serverMaps.map((m) => m.name).join(', ') || '(없음)'}`);

  // ── 앱을 띄우지 않고 로컬 읽기 ─────────────────────────
  const page = await ctx.newPage();
  await page.route('**/*', (r) => (r.request().resourceType() === 'script' ? r.abort() : r.continue()));
  await page.goto(`${STUDIO_ORIGIN}/__studio_pull__`, { waitUntil: 'domcontentloaded' }).catch(() => {});

  const before = await page.evaluate(() => {
    const all = {};
    for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); all[k] = localStorage.getItem(k); }
    return all;
  });
  const localMaps = JSON.parse(before['sv_studio_maps_v1'] || '[]');
  console.log(`\n지금 로컬 맵 ${localMaps.length}개: ${localMaps.map((m) => m.name).join(', ') || '(없음)'}`);

  const willWrite = Object.keys(serverKeys).filter((k) => before[k] !== serverKeys[k]);
  const willDelete = replace ? Object.keys(before).filter((k) => /^(sv_studio_|spum_studio_|spum_world_)/.test(k) && !(k in serverKeys)) : [];
  console.log(`\n바뀔 키 ${willWrite.length}개: ${willWrite.join(', ') || '(없음)'}`);
  if (replace) console.log(`지울 키 ${willDelete.length}개: ${willDelete.join(', ') || '(없음)'}`);
  else console.log('(기본은 병합 — 서버에 없는 로컬 키는 그대로 둡니다. 지우려면 --replace)');

  if (dryRun) { console.log('\n--dry-run: 아무것도 쓰지 않았습니다.'); process.exit(0); }
  if (!willWrite.length && !willDelete.length) { console.log('\n이미 같습니다 — 할 일이 없습니다.'); process.exit(0); }

  // ── 백업 먼저 ──────────────────────────────────────────
  const bdir = path.join('out', 'backups');
  await mkdir(bdir, { recursive: true });
  const bpath = path.join(bdir, `studio-before-pull-${stamp}.json`);
  await writeFile(bpath, JSON.stringify({ savedAt: new Date().toISOString(), reason: `pull rev ${state.revision}`, keys: before }, null, 2), 'utf8');
  console.log(`\n백업: ${bpath} (${kb(JSON.stringify(before).length)})`);

  // ── 쓰기 ───────────────────────────────────────────────
  const res = await page.evaluate(({ keys, del }) => {
    const failed = [];
    for (const k of del) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(keys)) {
      try { localStorage.setItem(k, v); } catch (e) { failed.push(`${k}: ${String(e).slice(0, 60)}`); }
    }
    let tot = 0; for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); tot += k.length + (localStorage.getItem(k) || '').length; }
    const maps = JSON.parse(localStorage.getItem('sv_studio_maps_v1') || '[]').map((m) => m.name);
    return { failed, totKB: Math.round(tot / 1024), maps };
  }, { keys: serverKeys, del: willDelete });

  if (res.failed.length) {
    console.error(`\n⚠ 쓰지 못한 키 ${res.failed.length}개 (localStorage 한도 약 5MB):`);
    res.failed.forEach((f) => console.error(`   ${f}`));
    console.error('   --replace 로 낡은 로컬 키를 정리하거나, 큰 항목을 지운 뒤 다시 시도하세요.');
    process.exit(1);
  }
  console.log(`\n✅ rev ${state.revision} 을 로컬에 반영했습니다.`);
  console.log(`   로컬 맵 ${res.maps.length}개: ${res.maps.join(', ')}`);
  console.log(`   localStorage ${res.totKB}KB / 약 5120KB`);
  console.log('\n이제 Studio 를 열면 이 상태가 기준이 됩니다 (`npm run studio-open`).');
} finally {
  await ctx.close();
}

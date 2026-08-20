/**
 * 맵 레코드를 Studio 에 직접 주입한다 — 문서 4-4 의 콘솔 스니펫 대체.
 *
 * 기존: `--snippet` 으로 만든 JS 를 사람이 크롬 콘솔에 붙여넣었다.
 * 지금: 같은 일을 page.evaluate() 로 한다. 붙여넣기도, 새로고침도 자동.
 *
 * 방향 규칙(문서 1-2)은 그대로다: **localStorage → saveServerSnapshot** 순서.
 * 반대로 하면 다음 새로고침 때 로컬이 서버를 덮어써서 작업이 날아간다.
 *
 * 사용:
 *   node scripts/studio-apply.mjs --map out/<이름>-studio-map.json [--dry-run]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { withStudio, enterStudio, STUDIO_URL, STUDIO_ORIGIN } from '../src/studio-browser.mjs';
import { createBackup } from '../src/studio-backup.mjs';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : null; };
const has = (n) => args.includes(n);

const mapPath = arg('--map');
const wantName = arg('--name');   // --into 로 만든 백업에는 맵이 여럿 들어 있다
const dryRun = has('--dry-run');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!mapPath) {
  console.error('사용법: node scripts/studio-apply.mjs --map <맵레코드.json> [--dry-run]');
  console.error('맵 레코드는 `node scripts/make-map.mjs --config <레이아웃>` 이 만듭니다.');
  process.exit(1);
}

async function main() {
  const raw = JSON.parse(await readFile(mapPath, 'utf8'));
  // make-map 은 맵 레코드 자체 또는 { keys: {...} } 백업 형태를 낼 수 있다
  const pick = (list) => {
    if (!wantName) return list[0];
    const hit = list.find((m) => m.name === wantName);
    if (!hit) throw new Error(`"${wantName}" 이름의 맵이 없습니다. 들어 있는 맵: ${list.map((m) => m.name).join(', ')}`);
    return hit;
  };
  const record = raw?.keys?.sv_studio_maps_v1
    ? pick(JSON.parse(raw.keys.sv_studio_maps_v1))
    : (Array.isArray(raw) ? pick(raw) : raw);
  if (!record?.name || !Array.isArray(record?.layers)) {
    throw new Error(`${mapPath}: 맵 레코드로 보이지 않습니다 (name·layers 없음).`);
  }
  console.log(`주입할 맵: "${record.name}" ${record.width}×${record.height} · 레이어 ${record.layers.length}개`);

  return withStudio({ headless: true }, async (ctx) => {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const { session } = await enterStudio(page);
    console.log('세션 OK:', session.user?.email);

    // ── 1. 백업 먼저. 예외 없이 항상 (문서 7절 1번) ──────────────────
    const ls = await page.evaluate(() => {
      const out = {};
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out[k] = localStorage.getItem(k); }
      return out;
    });
    await mkdir(path.join('out', 'backups'), { recursive: true });
    const backupPath = path.join('out', 'backups', `studio-${stamp}.json`);
    await writeFile(backupPath, JSON.stringify(createBackup(ls, 'map'), null, 2), 'utf8');
    console.log(`백업: ${backupPath}`);

    const before = JSON.parse(ls.sv_studio_maps_v1 || '[]');
    console.log(`현재 맵 ${before.length}개: ${before.map((m) => m.name).join(', ') || '(없음)'}`);
    const willReplace = before.some((m) => m.name === record.name);
    console.log(willReplace ? `→ 같은 이름 "${record.name}" 을 교체합니다 (id 유지)` : `→ 새 맵으로 추가합니다`);

    if (dryRun) { console.log('\n--dry-run: 여기까지. 아무것도 쓰지 않았습니다.'); return; }

    // ── 2. 주입: localStorage → 이벤트 → 서버 스냅샷 (이 순서를 지킨다) ──
    const result = await page.evaluate(async (map) => {
      const KEY = 'sv_studio_maps_v1';
      const list = JSON.parse(localStorage.getItem(KEY) || '[]');
      const at = list.findIndex((m) => m.name === map.name);
      if (at > -1) {
        // 월드가 맵을 id 로 참조한다 — 교체해도 id 는 유지해야 참조가 안 끊긴다
        map.id = list[at].id;
        map.meta = { ...map.meta, createdAt: list[at].meta?.createdAt || map.meta?.createdAt };
        list[at] = map;
      } else {
        list.unshift(map);
      }
      localStorage.setItem(KEY, JSON.stringify(list));
      // localStorage 직접 쓰기는 앱이 모른다 — 알려줘야 한다
      window.dispatchEvent(new CustomEvent('spum:studio-storage-write', { detail: { key: KEY, action: 'set' } }));
      let saved = null;
      if (window.spumStudioData?.saveServerSnapshot) {
        saved = await window.spumStudioData.saveServerSnapshot('map-import');
      }
      return { count: list.length, names: list.map((m) => m.name), saved };
    }, record);

    console.log(`주입 완료 — 맵 ${result.count}개: ${result.names.join(', ')}`);
    console.log(`saveServerSnapshot → ${result.saved}`);

    // ── 3. 새로고침하고 눈으로 확인 ────────────────────────────────────
    await page.goto(`${STUDIO_ORIGIN}/studio/?section=map`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    const shot = path.join('out', `apply-${stamp}.png`);
    await page.screenshot({ path: shot });
    console.log(`스크린샷: ${shot}`);

    const after = await page.evaluate(() => JSON.parse(localStorage.getItem('sv_studio_maps_v1') || '[]').map((m) => m.name));
    console.log(`새로고침 후 맵: ${after.join(', ')}`);
  });
}

main().catch((e) => { console.error('실패:', e.message); process.exit(1); });

#!/usr/bin/env node
/**
 * "이런 느낌으로 맵 만들어줘" 한 방 — 창을 띄운 채 전 과정을 잇는다.
 *
 *   ① 씬 조감도 생성 (AI)        ② 참조본 512 축소
 *   ③ 통행 마스크 생성 (img2img) ④ 마스크로 통행 판정 + 고립 구역 잇기
 *   ⑤ 맵 레코드 생성             ⑥ Studio 에 주입 + 확인 스크린샷
 *
 * 창 하나로 이어서 하므로 사람이 전 과정을 지켜볼 수 있다 (--headed).
 * 각 단계는 이미 따로따로 검증된 것들이다 (문서 9절·10절).
 *
 * 사용:
 *   node scripts/make-scene-map.mjs --name "중세 대장간" --prompt-file <파일> --headed --record
 *   node scripts/make-scene-map.mjs --name "..." --prompt-text "..." --headed
 *   ... --quality medium   생성 품질 (low|medium|high, 기본 high). 504 가 잦으면 낮춘다
 *   ... --model FLUX.2-pro 모델 (gpt-image-2|gpt-image|FLUX.2-pro, 기본 gpt-image-2)
 *   ... --dry-run     그림만 만들고 주입은 하지 않는다
 *   ... --keep-open   끝나도 창을 닫지 않고 사람이 닫을 때까지 기다린다
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withStudio, enterStudio, STUDIO_ORIGIN } from '../src/studio-browser.mjs';
import { createBackup } from '../src/studio-backup.mjs';
import { decodePng, Canvas } from '../src/png.mjs';
import { encodeJpeg } from '../src/image-io.mjs';
import { attachImageCapture, createAndOpenTheme, setupTheme, applySource, generate } from '../src/studio-scene.mjs';

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : d; };
const has = (n) => args.includes(n);

const mapName = arg('--name');
const promptFile = arg('--prompt-file');
const promptText = arg('--prompt-text');
const headed = has('--headed');
const record = has('--record');
const dryRun = has('--dry-run');
// 끝난 뒤 창을 닫지 않고 사람이 닫을 때까지 기다린다 (결과를 눈으로 둘러볼 때).
// ★ 창이 떠 있는 동안에는 같은 프로필을 쓰는 다른 스크립트가 돌지 못한다.
const keepOpen = has('--keep-open');
const jpegQ = arg('--jpeg', '68');
// 생성 품질·모델. UI 기본은 quality=low 인데 파이프라인은 high 를 써 왔다.
// high 는 생성이 길어져 앞단 nginx 타임아웃(504)에 걸릴 확률이 오른다 —
// 서버가 밀릴 땐 medium/low 로 낮춰 통과시키는 게 낫다 (2026-08-20 실측: 504 두 번, 249쌤 소모).
const quality = arg('--quality', 'high');
const model = arg('--model', 'gpt-image-2');
// 이미 뽑아둔 씬으로 마스크부터 재개한다 (씬 생성 과금을 건너뛴다).
// 마스크가 413/504 로 죽었을 때 "씬은 남아 있으니 마스크만 다시" 하는 경로.
const sceneFile = arg('--scene');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (!mapName || (!promptFile && !promptText && !sceneFile)) {
  console.error('사용법: node scripts/make-scene-map.mjs --name "<맵 이름>" (--prompt-file <파일> | --prompt-text "<문장>" | --scene <씬 PNG>) [--headed] [--record] [--dry-run] [--quality low|medium|high] [--model gpt-image-2|gpt-image|FLUX.2-pro] [--keep-open]');
  process.exit(1);
}

// 2026-08-21: 성주의 거처에서 붉은 카펫 대로가 검게 칠해져 카펫을 명시 강조.
// "Keep the same shapes and positions" 는 첫 줄의 same layout 과 중복이라 뺐다 (520자 관리).
const MASK_PROMPT = `Convert the reference into a flat two-tone navigation mask, same layout and grid alignment.
Pure WHITE for ground a person can walk on: floors, paths, grass, lawns, dirt, rugs, carpets and red carpet runners.
Pure BLACK for everything blocked: walls, furniture, beds, tables, chairs, counters, crates, barrels, stairs, bushes, potted plants,
fireplaces, stalls, water, rivers, canals, ponds, fountains, pits.
Hard edges, no anti-aliasing, no grey, no gradients, no text, no icons. Square image on a 32x32 grid.`;

// 하위 스크립트는 **이 파일 기준**으로 찾는다. cwd 기준이면 다른 프로젝트 폴더에서 돌릴 때 깨진다.
const SCENE_TO_MAP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scene-to-map.mjs');

const safe = (s) => s.replace(/[^\w가-힣-]+/g, '_');
const step = (n, msg) => console.log(`\n[${n}/6] ${msg}`);

/** 1024² → 512² (참조 이미지가 크면 413 이 난다).
 *  업로드가 base64(×4/3)라 앞단 한도 1MiB 기준 파일 약 780KB 가 상한이다 —
 *  실측: 773KB 통과, 815KB 에서 0.4초 만에 413 (2026-08-21 산동네 마을).
 *  PNG 가 한도를 넘으면 JPEG 로 재인코딩한다 (참조용이라 무손실일 필요가 없다). */
const REF_LIMIT = 740 * 1024;
async function halve(srcPath, outBase) {
  const src = decodePng(await readFile(srcPath));
  const S = 2, w = src.width / S, h = src.height / S;
  const c = new Canvas(w, h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < S; dy += 1) for (let dx = 0; dx < S; dx += 1) {
      const i = ((y * S + dy) * src.width + (x * S + dx)) * 4;
      r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2];
    }
    const n = S * S;
    c.set(x, y, [Math.round(r / n), Math.round(g / n), Math.round(b / n), 255]);
  }
  const png = c.toPng();
  if (png.length <= REF_LIMIT) {
    const outPath = `${outBase}.png`;
    await writeFile(outPath, png);
    return { path: outPath, kb: Math.round(png.length / 1024) };
  }
  for (const q of [88, 80, 70]) {
    const jpg = await encodeJpeg(w, h, c.data, q);
    if (jpg.length <= REF_LIMIT || q === 70) {
      const outPath = `${outBase}.jpg`;
      await writeFile(outPath, jpg);
      console.log(`  PNG ${Math.round(png.length / 1024)}KB > 한도 ${Math.round(REF_LIMIT / 1024)}KB → JPEG q${q}`);
      return { path: outPath, kb: Math.round(jpg.length / 1024) };
    }
  }
}

const text = promptText || (promptFile ? (await readFile(promptFile, 'utf8')).trim() : '');
console.log(`맵 "${mapName}" · 프롬프트 ${text.length}자 · ${model}/${quality}${text.length > 520 ? '  ⚠ 520자를 넘으면 504 가 나기 쉽습니다' : ''}`);

await withStudio({ headless: !headed, ...(record ? { recordDir: 'out/videos' } : {}) }, async (ctx) => {
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const capture = await attachImageCapture(page);

  await enterStudio(page, { section: 'object' });

  // 백업 먼저
  const ls = await page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i += 1) { const k = localStorage.key(i); o[k] = localStorage.getItem(k); } return o; });
  await mkdir('out/backups', { recursive: true });
  await writeFile(path.join('out', 'backups', `studio-${stamp}.json`), JSON.stringify(createBackup(ls, 'object'), null, 2), 'utf8');

  // ── ① 씬 ──────────────────────────────────────────────
  let ed, scenePath;
  if (sceneFile) {
    step(1, `씬 재사용 — ${sceneFile} (생성 과금 없음)`);
    scenePath = sceneFile;
  } else {
    step(1, `씬 조감도 생성 — "${mapName}"`);
    ed = await createAndOpenTheme(page);
    await setupTheme(page, ed, { name: mapName, promptText: text, tags: `scene, 32x32, ${mapName}`, quality, model });
    scenePath = path.join('out', 'assets-studio', `${safe(mapName)}__scene-${stamp}.png`);
    if (!(await generate(page, ed, capture, scenePath))) {
      throw new Error('씬 생성 실패 — 504 이거나 응답에 이미지가 없습니다. 프롬프트를 줄여 다시 시도하세요.');
    }
  }

  // ── ② 참조본 ──────────────────────────────────────────
  step(2, '참조본 512² 로 축소 (1024² 를 그대로 올리면 413)');
  const ref = await halve(scenePath, path.join('out', 'assets-studio', `${safe(mapName)}__ref512-${stamp}`));
  const refPath = ref.path;
  console.log(`  ${ref.kb}KB → ${refPath}`);

  // ── ③ 마스크 ──────────────────────────────────────────
  step(3, '통행 마스크 생성 (img2img — 구조를 유지시킨다)');
  ed = await createAndOpenTheme(page);
  await setupTheme(page, ed, { name: `${mapName} 마스크`, promptText: MASK_PROMPT, tags: 'mask, 32x32', quality, model });
  await applySource(page, ed, refPath);
  const maskPath = path.join('out', 'assets-studio', `${safe(mapName)}__mask-${stamp}.png`);
  if (!(await generate(page, ed, capture, maskPath))) {
    throw new Error('마스크 생성 실패 — 씬은 남아 있으니 마스크만 다시 뽑으면 됩니다.');
  }

  // ── ④⑤ 맵 레코드 ─────────────────────────────────────
  step(4, '마스크로 통행 판정 · 고립 구역 잇기 · 맵 레코드 생성');
  const outJson = path.join('out', `scene-map-${safe(mapName)}.json`);
  const res = execFileSync(process.execPath, [
    SCENE_TO_MAP, '--image', scenePath, '--maskimage', maskPath,
    '--name', mapName, '--jpeg', String(jpegQ), '--connect', '--mask', '--out', outJson,
  ], { encoding: 'utf8' });
  process.stdout.write(res.split('\n').map((l) => (l ? '  ' + l : l)).join('\n'));

  /** --keep-open 이면 사람이 창을 닫을 때까지 기다린다 */
  const waitForClose = async () => {
    if (!keepOpen) return;
    console.log('\n  --keep-open: 창을 열어둡니다. 다 보시면 **창을 닫으세요**.');
    console.log('  (창을 닫아야 세션 쿠키와 녹화 파일이 저장되고, 다음 스크립트가 프로필을 쓸 수 있습니다)');
    await new Promise((resolve) => {
      ctx.on('close', resolve);
      page.on('close', () => setTimeout(resolve, 500));
    });
    console.log('  창이 닫혔습니다.');
  };

  if (dryRun) { console.log('\n--dry-run: 주입하지 않았습니다.'); await waitForClose(); return; }

  // ── ⑥ 주입 ────────────────────────────────────────────
  step(5, 'Studio 에 주입');
  const record0 = JSON.parse(await readFile(outJson, 'utf8'));
  const applied = await page.evaluate(async (m) => {
    const KEY = 'sv_studio_maps_v1';
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    const at = list.findIndex((x) => x.name === m.name);
    if (at > -1) { m.id = list[at].id; m.meta = { ...m.meta, createdAt: list[at].meta?.createdAt }; list[at] = m; }
    else list.unshift(m);
    try { localStorage.setItem(KEY, JSON.stringify(list)); }
    catch (e) { return { error: String(e).slice(0, 120) }; }
    window.dispatchEvent(new CustomEvent('spum:studio-storage-write', { detail: { key: KEY, action: 'set' } }));
    const saved = await window.spumStudioData?.saveServerSnapshot?.('scene-map');
    return { names: list.map((x) => x.name), saved };
  }, record0);
  if (applied.error) throw new Error(`주입 실패(저장소 한도일 수 있습니다): ${applied.error}`);
  console.log(`  맵 ${applied.names.length}개: ${applied.names.join(', ')}`);
  console.log(`  saveServerSnapshot → ${applied.saved}`);

  step(6, '새로고침하고 확인');
  await page.goto(`${STUDIO_ORIGIN}/studio/?section=map`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(7000);
  await page.locator(`text=${mapName}`).first().click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(4000);
  for (const [x, y] of [[1018, 511], [1018, 537]]) { await page.mouse.click(x, y); await page.waitForTimeout(800); }
  await page.waitForTimeout(2500);
  const shot = path.join('out', `scene-final-${safe(mapName)}.png`);
  await page.screenshot({ path: shot });
  console.log(`  스크린샷: ${shot}`);
  console.log(`\n완료 — "${mapName}"`);
  await waitForClose();
});

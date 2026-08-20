/**
 * 씬 맵 파이프라인의 브라우저 조작 부분.
 *
 * scripts/studio-ai-theme.mjs 에서 검증된 절차를 함수로 뽑았다.
 * 창 하나를 열어둔 채 "씬 생성 → 마스크 생성 → 주입" 을 연속으로 하려면
 * 각 단계가 같은 page 를 공유해야 하기 때문이다.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const SEL = {
  create: '[data-object-action="create"]',
  listName: '.spum-resource-list__name',
  name: '#resourceThemeNameInput',
  prompt: '#resourcePromptInput',
  preset: '#resourcePresetSelect',      // ★ 건드리면 프롬프트가 덮인다
  model: '#resourceModelSelect',
  quality: '#resourceQualitySelect',
  generate: '#resourceGenerateButton',
  themeType: '#themeTypeSelect',
  tileSize: '#themeTileSizeSelect',
  gridSel: '#themeGridSelect',
  tags: '#themeTagsInput',
  source: '#themeSourceButton',
  sourceFile: '#sourceImageFileInput',
  sourceApply: '#applyThemeSourceButton',
};

/** 에디터 UI 는 iframe 안에 있다 — 해당 프레임을 찾는다 */
export async function frameWith(page, selector, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      try { if (await f.$(selector)) return f; } catch { /* 떠난 프레임 */ }
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(`어느 프레임에서도 ${selector} 를 못 찾았습니다.`);
}

/**
 * 생성 응답을 가로채는 route 를 건다. 한 번만 걸고 여러 생성에 재사용한다.
 * @returns {{ take: () => Buffer|null }} 마지막으로 잡은 이미지를 꺼내는 함수
 */
export async function attachImageCapture(page, log = console.log) {
  let latest = null;
  await page.route('**/api/ai-tiles/**', async (route) => {
    // ★ 경과 시간을 남긴다 (2026-08-20): 504 가 났을 때 "몇 초에서 끊겼는지" 가 없으면
    //   업스트림 지연인지 앞단 nginx 타임아웃인지 구분할 수가 없다. 정상 생성은 60~70초다.
    const t0 = Date.now();
    try {
      // 생성은 1분 이상 걸린다 — 기본 30초로는 못 기다린다
      const resp = await route.fetch({ timeout: 300000 });
      const buf = await resp.body();
      const url = route.request().url();
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      if (url.includes('/generate')) {
        const via = resp.headers()['server'] ? ` · ${resp.headers()['server']}` : '';
        log(`  [api] ${resp.status()} ${url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]}  ${sec}초${via}`);
        if (resp.status() === 504) {
          log(`  [api] ↳ 504 는 앞단이 업스트림 응답을 못 기다리고 끊은 것입니다 (정상 생성 60~70초). 과금은 됩니다.`);
        }
        if (resp.ok()) {
          try {
            const scan = (v, d = 0) => {
              if (typeof v === 'string') {
                if (v.startsWith('data:image')) return Buffer.from(v.split(',')[1], 'base64');
                // 실제 응답은 image.data 에 접두사 없는 base64 다
                if (v.startsWith('iVBORw0KGgo') || v.startsWith('/9j/')) return Buffer.from(v, 'base64');
                return null;
              }
              if (v && typeof v === 'object' && d < 8) for (const x of Object.values(v)) { const h = scan(x, d + 1); if (h) return h; }
              return null;
            };
            latest = scan(JSON.parse(buf.toString('utf8')));
          } catch { /* JSON 이 아니면 넘어간다 */ }
        }
      }
      await route.fulfill({ response: resp, body: buf });
    } catch (e) {
      log(`  [route] 프록시 실패(${((Date.now() - t0) / 1000).toFixed(1)}초) — 원 요청을 흘려보냅니다: ${e.message.split('\n')[0]}`);
      try { await route.continue(); } catch { /* 이미 처리됨 */ }
    }
  });
  return { take: () => { const v = latest; latest = null; return v; } };
}

/** 새 오브젝트를 만들고 편집 화면을 연다 */
export async function createAndOpenTheme(page, log = console.log) {
  const names = () => page.evaluate(() => JSON.parse(localStorage.getItem('sv_studio_smo_v1') || '[]').map((o) => o.name));
  const before = await names();
  const lf = await frameWith(page, SEL.create, 20000);
  await lf.click(SEL.create, { timeout: 10000 });
  await page.waitForTimeout(4000);
  const after = await names();
  const fresh = after.find((n) => !before.includes(n));
  if (!fresh) throw new Error('새 오브젝트를 못 찾았습니다.');
  log(`  새 오브젝트: "${fresh}"`);
  const nf = await frameWith(page, SEL.listName, 20000);
  await nf.locator(SEL.listName, { hasText: fresh }).first().click({ timeout: 10000 });
  await page.waitForTimeout(4000);
  return frameWith(page, SEL.name);
}

/** 테마 설정을 채운다. 프리셋은 절대 건드리지 않는다 */
export async function setupTheme(page, ed, { name, promptText, grid = '32x32', target = '32', model = 'gpt-image-2', quality = 'high', tags = 'scene, 32x32' }) {
  await ed.fill(SEL.name, name);
  await ed.selectOption(SEL.themeType, 'map-theme').catch(() => {});
  await ed.selectOption(SEL.tileSize, target);
  await ed.selectOption(SEL.gridSel, grid);
  await ed.fill(SEL.tags, tags);
  await ed.selectOption(SEL.model, model);
  await ed.selectOption(SEL.quality, quality);
  await ed.fill(SEL.prompt, promptText);
  await page.waitForTimeout(1500);
}

/** img2img 참조 이미지를 올린다 (모달 → 파일 input → Use Source) */
export async function applySource(page, ed, filePath, log = console.log) {
  await ed.click(SEL.source, { timeout: 10000 });
  await page.waitForTimeout(2500);
  await ed.setInputFiles(SEL.sourceFile, filePath, { timeout: 15000 });
  await page.waitForTimeout(7000);
  await ed.click(SEL.sourceApply, { timeout: 10000 }).catch(() => log('  (Use Source 를 못 눌렀습니다 — 이미 적용됐을 수 있습니다)'));
  await page.waitForTimeout(4000);
  log(`  SOURCE 적용: ${path.basename(filePath)}`);
}

/** Generate 를 누르고 이미지가 잡힐 때까지 기다린다 */
export async function generate(page, ed, capture, outPath, log = console.log, waitMs = 5 * 60 * 1000) {
  log('  ▶ Generate (과금)…');
  await ed.click(SEL.generate, { timeout: 10000 });
  const deadline = Date.now() + waitMs;
  let img = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    img = capture.take();
    if (img) break;
  }
  if (!img) return null;
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, img);
  log(`  ★ 원본 확보 ${Math.round(img.length / 1024)}KB → ${outPath}`);
  return outPath;
}

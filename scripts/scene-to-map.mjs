/**
 * AI 가 그린 조감도 한 장 → SPUM 맵.
 *
 * 타일을 반복 배치하는 보통 맵과 정반대다. 씬 전체를 격자로 잘라 **모든 칸을 고유 타일로**
 * 등록하고 원래 좌표에 그대로 놓는다. 그러면 그림이 픽셀 단위로 복원된다.
 *
 * 통행 판정은 그림에 정보가 없으므로 픽셀에서 추정한다:
 *   바닥 = 밝고 채도 낮은 회색 · 설비/벽/가구 = 어둡거나 색이 있다.
 *
 * 사용: node scripts/scene-to-map.mjs --image <조감도.png> --name "<맵 이름>" [--mask]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { decodePng, Canvas, toDataUrl } from '../src/png.mjs';
import { autoConnect } from '../src/auto-connect.mjs';
import jpeg from 'jpeg-js';

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : d; };
const imagePath = arg('--image');
const mapName = arg('--name', '우주선 조감도');
const cell = Number(arg('--cell', 32));
const wantMask = args.includes('--mask');
const jpegQuality = Number(arg('--jpeg', 0));   // >0 이면 시트를 JPEG 로 굽는다 (용량 절감)
const maskImage = arg('--maskimage');
const doConnect = args.includes('--connect');   // 고립 구역을 메인에 이어 붙인다   // AI 가 만든 흑백 통행 마스크 (있으면 이걸 쓴다)
const brightMin = Number(arg('--bright', 118));   // 이 밝기 이상이면 바닥 후보
const satMax = Number(arg('--sat', 34));          // 채도가 이보다 크면 사물로 본다
const stdMax = Number(arg('--std', 30));          // 밝기 편차가 크면 무언가 그려진 칸이다

if (!imagePath) { console.error('사용법: node scripts/scene-to-map.mjs --image <png> --name "<맵 이름>"'); process.exit(1); }

const TILE_ID_BASE = 2049;
const src = decodePng(await readFile(imagePath));
const cols = Math.floor(src.width / cell);
const rows = Math.floor(src.height / cell);
console.log(`[scene-to-map] 원본 ${src.width}×${src.height} · 셀 ${cell}px → ${cols}×${rows} = ${cols * rows}칸`);

/** 셀 하나의 통계 */
function cellStats(cx, cy) {
  let sum = 0, sum2 = 0, rS = 0, gS = 0, bS = 0, n = 0;
  for (let y = 0; y < cell; y += 1) {
    for (let x = 0; x < cell; x += 1) {
      const i = ((cy * cell + y) * src.width + (cx * cell + x)) * 4;
      const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += lum; sum2 += lum * lum; rS += r; gS += g; bS += b; n += 1;
    }
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
  const r = rS / n, g = gS / n, b = bS / n;
  const sat = Math.max(r, g, b) - Math.min(r, g, b);   // 회색이면 0에 가깝다
  return { mean, std, sat };
}

const walkable = new Uint8Array(cols * rows);

if (maskImage) {
  // ★ AI 가 img2img 로 만든 흑백 마스크로 판정한다.
  //   씬 픽셀만 보고 추정하면 바닥(밝기 77~110)과 설비(53~82)가 겹쳐 구분이 안 된다
  //   (2026-08-20 실측: 그 방식은 통행 0칸이 나왔다). 마스크는 흑백이라 명확하다.
  // ★ 판정은 "평균 밝기" 가 아니라 **흰 픽셀 비율**로 (2026-08-21 실측).
  //   평균>127 은 사실상 "흰색 50% 이상" 이라, 길 가장자리 칸(흰 30~50%)이 전부
  //   막힘으로 떨어져 통로가 1칸으로 좁아졌다 — 성주의 거처에서 89칸이 여기 걸렸고
  //   사용자가 "길 같은데 못 간다" 고 관측했다. 35% 이상이면 발 디딜 바닥이 있다고 본다.
  const walkFrac = Number(arg('--walk-frac', 0.35));
  const m = decodePng(await readFile(maskImage));
  const sx = m.width / src.width, sy = m.height / src.height;
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      let white = 0, n = 0;
      for (let y = 4; y < cell - 4; y += 1) {           // 격자선을 피해 안쪽만 본다
        for (let x = 4; x < cell - 4; x += 1) {
          const i = (Math.floor((cy * cell + y) * sy) * m.width + Math.floor((cx * cell + x) * sx)) * 4;
          const lum = 0.299 * m.data[i] + 0.587 * m.data[i + 1] + 0.114 * m.data[i + 2];
          if (lum > 127) white += 1;
          n += 1;
        }
      }
      walkable[cy * cols + cx] = (white / n) >= walkFrac ? 1 : 0;
    }
  }
  console.log(`[scene-to-map] 마스크로 판정: ${maskImage} (흰 픽셀 ${Math.round(walkFrac * 100)}% 이상 = 통행)`);
} else {
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const s = cellStats(x, y);
      walkable[y * cols + x] = (s.mean >= brightMin && s.sat <= satMax && s.std <= stdMax) ? 1 : 0;
    }
  }
}
const walkCount = walkable.reduce((a, v) => a + v, 0);
console.log(`[scene-to-map] 통행 ${walkCount}칸 / 막힘 ${cols * rows - walkCount}칸 (${Math.round(walkCount / (cols * rows) * 100)}% 통행)`);

// ── 고립 구역 잇기 ──
// 마스크가 문턱까지 막아 방이 통째로 갈라지는 일이 잦다 (2026-08-20: 5구역으로 분리,
// 침실 67칸·화물칸 101칸이 고립). autoConnect 가 밝은 칸을 골라 뚫는다.
const doorSet = new Set();     // 뚫은 문 자리 (확인 이미지에 노랑으로 표시)
const sealedSet = new Set();   // 잇지 않고 막은 고립 조각 (주황으로 표시)

if (doConnect) {
  // ★ 어디를 뚫을지는 그림 판이 알려준다 (autoConnect, 2026-08-21 정책 전환).
  //   예전 0-1 BFS 는 "가장 적게 뚫는 곳"만 골라서 멀쩡한 담 한복판에 보이지 않는
  //   구멍을 냈다 — AI 는 벽을 통과해 다니고, 조이스틱 사용자는 마당에 갇혔다.
  //   실제 대문·빈 틈은 바닥이 보여 밝으므로, 어두운 칸일수록 비싸게 매겨
  //   밝은 칸(진짜 개구부일 곳)을 골라 뚫는다. minRegion 미만 조각(장식 안쪽 등)은
  //   잇지 않고 아래 "가장 큰 덩어리만 남기기"에서 막힘으로 떨어진다.
  const bright = new Array(cols * rows);
  for (let cy = 0; cy < rows; cy += 1) for (let cx = 0; cx < cols; cx += 1) {
    bright[cy * cols + cx] = cellStats(cx, cy).mean / 255;
  }
  const roles = Array.from(walkable, (v) => (v ? 'floor' : 'wall'));
  // minRegion 3: 계단이 마스크에서 잘게 끊겨도 잇는다 (밝기 실측상 계단 0.24~0.54,
  // 담 0.29~0.40 으로 겹쳐서 밝기 문턱으로는 계단과 담을 가를 수 없다 — 대신 아래에서
  // 뚫은 칸의 타일 그림을 바닥으로 갈아 끼워 "보이는 개구부"로 만든다).
  const res = autoConnect(cols, rows, roles, bright, {
    minRegion: Number(arg('--min-region', 3)),
    minBrightness: Number(arg('--min-brightness', 0)),
  });
  const carved = res.openings.filter((o) => !o.skipped);
  for (const o of carved) { walkable[o.at] = 1; doorSet.add(o.at); }
  if (carved.length) {
    console.log(`[scene-to-map] 고립 구역을 잇느라 ${carved.length}칸을 뚫었습니다 (밝은 칸 우선):`);
    for (const o of carved) console.log(`  (${o.col},${o.row}) 밝기 ${o.brightness}`);
  }
  for (const o of res.openings.filter((o) => o.skipped)) {
    console.log(`[scene-to-map] ${o.size}칸 구역은 ${o.need}칸을 뚫어야 해 잇지 않고 막습니다`);
  }
}

// ── 뚫은 문을 눈에 보이게 ──
// 통행 데이터만 뚫으면 그림은 담 그대로라, AI 는 벽을 통과해 다니고 조이스틱
// 사용자는 문을 못 찾는다 (2026-08-21 사용자 관측). 타일 시트는 우리가 만들므로
// 뚫은 칸의 픽셀을 이웃 바닥 타일로 갈아 끼워 개구부가 실제로 보이게 한다.
if (doorSet.size) {
  for (const at of doorSet) {
    const gx = at % cols, gy = (at / cols) | 0;
    let donor = -1;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = ny * cols + nx;
      if (walkable[ni] && !doorSet.has(ni)) { donor = ni; break; }
    }
    if (donor < 0) continue;
    const sx = (donor % cols) * cell, sy = ((donor / cols) | 0) * cell;
    for (let y = 0; y < cell; y += 1) for (let x = 0; x < cell; x += 1) {
      const to = ((gy * cell + y) * src.width + (gx * cell + x)) * 4;
      const from = ((sy + y) * src.width + (sx + x)) * 4;
      for (let k = 0; k < 4; k += 1) src.data[to + k] = src.data[from + k];
    }
  }
  console.log(`[scene-to-map] 뚫은 ${doorSet.size}칸의 타일을 이웃 바닥 그림으로 바꿨습니다 (개구부가 보이게)`);
}

// ── 연결성: 가장 큰 통행 덩어리만 남긴다 (섬처럼 떨어진 칸은 못 간다) ──
const seen = new Uint8Array(cols * rows);
let best = [], bestSize = 0;
for (let i = 0; i < walkable.length; i += 1) {
  if (!walkable[i] || seen[i]) continue;
  const stack = [i], group = [];
  seen[i] = 1;
  while (stack.length) {
    const cur = stack.pop(); group.push(cur);
    const cx = cur % cols, cy = (cur / cols) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const ni = ny * cols + nx;
      if (walkable[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
    }
  }
  if (group.length > bestSize) { bestSize = group.length; best = group; }
}
const keep = new Set(best);
let trimmed = 0;
for (let i = 0; i < walkable.length; i += 1) {
  if (walkable[i] && !keep.has(i)) { walkable[i] = 0; sealedSet.add(i); trimmed += 1; }
}
console.log(`[scene-to-map] 최대 연결 구역 ${bestSize}칸 · 떨어진 ${trimmed}칸은 막음`);

// ── 판정 확인용 마스크 이미지 ──
if (wantMask) {
  const m = new Canvas(src.width, src.height);
  for (let y = 0; y < src.height; y += 1) {
    for (let x = 0; x < src.width; x += 1) {
      const i = (y * src.width + x) * 4;
      const ci = ((y / cell) | 0) * cols + ((x / cell) | 0);
      const w = walkable[ci];
      // 노랑 = 뚫은 문 · 주황 = 잇지 않고 막은 고립 조각 · 초록/빨강 = 통행/막힘
      const tint = doorSet.has(ci) ? [255, 220, 0]
        : sealedSet.has(ci) ? [255, 140, 0]
          : w ? [0, 200, 90] : [120, 0, 0];
      m.set(x, y, [
        Math.round(src.data[i] * 0.55 + tint[0] * 0.45),
        Math.round(src.data[i + 1] * 0.55 + tint[1] * 0.45),
        Math.round(src.data[i + 2] * 0.55 + tint[2] * 0.45),
        255,
      ]);
    }
  }
  await mkdir('out', { recursive: true });
  await writeFile('out/scene-walkmask.png', m.toPng());
  const safeName = mapName.replace(/[^\w가-힣-]+/g, '_');
  await writeFile(`out/scene-walkmask-${safeName}.png`, m.toPng());
  console.log(`[scene-to-map] 판정 확인용: out/scene-walkmask-${safeName}.png (초록=통행, 빨강=막힘, 노랑=뚫은 문, 주황=막은 고립 조각)`);
}

// ── 타일 속성: 칸마다 하나씩 ──
const tileProperties = {};
for (let y = 0; y < rows; y += 1) {
  for (let x = 0; x < cols; x += 1) {
    const idx = y * cols + x;
    const id = TILE_ID_BASE + idx;
    const blocked = !walkable[idx];
    // ★ 1024칸이라 필드 하나가 곧 수십 KB 다. localStorage 한도(2026-08-20 QuotaExceeded)를
    //   넘지 않도록 Studio 가 실제로 읽는 것만 남긴다.
    tileProperties[String(id)] = {
      category: blocked ? 'obstacle_blocking' : 'floor',
      movement: blocked ? 'blocked' : 'passable',
      blocksMovement: blocked, blocksVision: false,
      moveSpeed: blocked ? 0 : 1,
    };
  }
}

// ── 시트 이미지: PNG 그대로면 data URL 이 2.3MB 라 localStorage 를 넘긴다 ──
let sheetDataUrl;
if (jpegQuality > 0) {
  const rgba = Buffer.alloc(src.width * src.height * 4);
  src.data.forEach((v, i) => { rgba[i] = v; });
  const enc = jpeg.encode({ data: rgba, width: src.width, height: src.height }, jpegQuality);
  sheetDataUrl = `data:image/jpeg;base64,${Buffer.from(enc.data).toString('base64')}`;
  console.log(`[scene-to-map] 시트 JPEG q${jpegQuality}: ${Math.round(enc.data.length / 1024)}KB (PNG 대비 압축)`);
} else {
  sheetDataUrl = toDataUrl(await readFile(imagePath));
}

// ── 맵 레코드 ──
const layer = (name, type, data) => ({ name, type, visible: true, opacity: 1, data });
const ground = new Array(cols * rows);
for (let i = 0; i < cols * rows; i += 1) ground[i] = TILE_ID_BASE + i;

const now = new Date().toISOString();
const record = {
  id: `MAP_scene_${Math.random().toString(36).slice(2, 10)}`,
  name: mapName,
  width: cols, height: rows, tileWidth: cell, tileHeight: cell,
  layers: [
    layer('back_1', 'tile', ground),
    layer('back_2', 'tile', new Array(cols * rows).fill(0)),
    layer('front_1', 'tile', new Array(cols * rows).fill(0)),
    // ★ type 은 'nav' 가 아니라 스키마의 'walkable'/'obstacle' 이어야 한다 (2026-08-20 실측).
    //   'nav' 는 월드 런타임의 walkable 토큰 목록에 들어 있어서, obstacle 레이어까지
    //   walkable 로 분류돼 전 칸 통행이 된다 (WorldCastSync.inferLayerType).
    layer('walkable', 'walkable', Array.from(walkable)),
    layer('obstacle', 'obstacle', Array.from(walkable).map((v) => (v ? 0 : 1))),
  ],
  tilesets: [{
    tileSetAssetId: 'theme_ship_scene',
    tileIdBase: TILE_ID_BASE,
    tileWidth: cell, tileHeight: cell,
    columns: cols, tileCount: cols * rows,
    imageUrl: sheetDataUrl,
    tiles: [],
    tileProperties,
  }],
  objects: [],
  spawnPoints: [],
  meta: { createdAt: now, updatedAt: now, source: 'scene-to-map', image: path.basename(imagePath) },
};

// 스폰: 가장 큰 통행 구역의 중앙쯤
const firstWalk = best.length ? best[Math.floor(best.length / 2)] : 0;
record.spawnPoints.push({ id: 'spawn_main', name: '시작 지점', x: firstWalk % cols, y: (firstWalk / cols) | 0 });

await mkdir('out', { recursive: true });
const outPath = arg('--out') || path.join('out', 'scene-map.json');
await writeFile(outPath, JSON.stringify(record, null, 2), 'utf8');
console.log(`[scene-to-map] → ${outPath}  (${cols}×${rows} · 타일 ${cols * rows}종)`);

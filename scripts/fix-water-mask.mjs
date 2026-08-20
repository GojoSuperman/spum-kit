/**
 * 씬 픽셀에서 물(청록) 칸을 찾아 통행 마스크에 검정으로 덧칠한다.
 *
 * AI 마스크가 물을 흰색(통행)으로 잘못 내는 사고가 반복돼서 만들었다
 * (2026-08-20 판타지 시장 광장 73/88칸, 같은 날 원시 동굴 71칸).
 * 재과금 없이 로컬에서 고친 뒤 scene-to-map 에 --maskimage 로 넘기면 된다.
 *
 * 사용: node scripts/fix-water-mask.mjs --scene <씬.png> --mask <마스크.png> --out <보정.png> [--frac 0.3]
 */
import { readFile, writeFile } from 'node:fs/promises';
import { decodePng, encodePng } from '../src/png.mjs';

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : d; };
const scenePath = arg('--scene');
const maskPath = arg('--mask');
const outPath = arg('--out');
const frac = Number(arg('--frac', 0.3));
const cell = Number(arg('--cell', 32));

if (!scenePath || !maskPath || !outPath) {
  console.error('사용법: node scripts/fix-water-mask.mjs --scene <png> --mask <png> --out <png> [--frac 0.3]');
  process.exit(1);
}

const scene = decodePng(await readFile(scenePath));
const mask = decodePng(await readFile(maskPath));
console.log(`[fix-water] scene ${scene.width}×${scene.height} · mask ${mask.width}×${mask.height}`);

// 물 판정: 파랑이 빨강보다 뚜렷이 높고 절대값도 높다 (실측: 물 [33,66,107]·[37,90,143], 흙 [91,57,32])
const isWater = (r, g, b) => b > r + 35 && b > 110 && g > r;

const cols = Math.floor(scene.width / cell);
const rows = Math.floor(scene.height / cell);
const sx = mask.width / scene.width;
let painted = 0;
for (let cy = 0; cy < rows; cy += 1) {
  for (let cx = 0; cx < cols; cx += 1) {
    let w = 0;
    for (let y = 0; y < cell; y += 1) {
      for (let x = 0; x < cell; x += 1) {
        const i = ((cy * cell + y) * scene.width + (cx * cell + x)) * 4;
        if (isWater(scene.data[i], scene.data[i + 1], scene.data[i + 2])) w += 1;
      }
    }
    if (w / (cell * cell) <= frac) continue;
    const mc = Math.round(cell * sx);
    for (let y = 0; y < mc; y += 1) {
      for (let x = 0; x < mc; x += 1) {
        const mi = ((Math.round(cy * cell * sx) + y) * mask.width + Math.round(cx * cell * sx) + x) * 4;
        mask.data[mi] = 0; mask.data[mi + 1] = 0; mask.data[mi + 2] = 0; mask.data[mi + 3] = 255;
      }
    }
    painted += 1;
  }
}
console.log(`[fix-water] 물 칸 ${painted}개를 검정(막힘)으로 칠함`);
await writeFile(outPath, encodePng(mask.width, mask.height, mask.data));
console.log(`[fix-water] → ${outPath}`);

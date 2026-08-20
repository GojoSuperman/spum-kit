/**
 * 이미지 읽기 — PNG 는 자체 디코더, JPEG 는 jpeg-js.
 *
 * 이 리포는 의존성 없이 굴러가는 것을 원칙으로 두는데, 이미지 디코딩은 표준
 * 라이브러리 밖이라 여기서만 예외를 둔다. jpeg-js 가 없으면 PNG 만 읽고,
 * JPEG 는 변환 방법을 안내한다 (동작이 조용히 실패하지 않게).
 */
import { readFile } from 'node:fs/promises';
import { decodePng } from './png.mjs';

let jpegModule;
async function loadJpegModule() {
  if (jpegModule !== undefined) return jpegModule;
  try {
    jpegModule = (await import('jpeg-js')).default;
  } catch {
    jpegModule = null;
  }
  return jpegModule;
}

/** @returns {{ width, height, data: Uint8Array }} RGBA */
export async function loadImage(path) {
  const buffer = await readFile(path);
  if (buffer.length > 8 && buffer.readUInt32BE(0) === 0x89504e47) {
    return decodePng(buffer);
  }
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    const jpeg = await loadJpegModule();
    if (!jpeg) {
      throw new Error(`JPEG 를 읽으려면 jpeg-js 가 필요합니다.
  설치:  pnpm add jpeg-js
  또는:  이미지를 PNG 로 저장해서 다시 주세요 (윈도우 캡처 도구는 PNG 로 저장합니다)`);
    }
    const raw = jpeg.decode(buffer, { useTArray: true });
    return { width: raw.width, height: raw.height, data: raw.data };
  }
  throw new Error(`${path}: PNG 나 JPEG 가 아닙니다.`);
}

/** 사각형 영역을 잘라낸다 */
export function cropImage(img, x, y, w, h) {
  const x0 = Math.max(0, Math.min(img.width - 1, Math.trunc(x)));
  const y0 = Math.max(0, Math.min(img.height - 1, Math.trunc(y)));
  const width = Math.max(1, Math.min(img.width - x0, Math.trunc(w)));
  const height = Math.max(1, Math.min(img.height - y0, Math.trunc(h)));
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const src = ((y0 + row) * img.width + x0) * 4;
    data.set(img.data.subarray(src, src + width * 4), row * width * 4);
  }
  return { width, height, data };
}

/**
 * 흰 여백으로 나뉜 판(panel)을 찾는다.
 *
 * 합성 도면 이미지(여러 평면도를 한 장에 붙인 것)에서 원하는 판만 떼어내려면
 * 먼저 경계를 알아야 한다. 거의 흰 행·열을 여백으로 보고 덩어리를 자른다.
 */
export function findPanels(img, { whiteThreshold = 232, minSize = 60, gutter = 4 } = {}) {
  const isWhiteRow = new Uint8Array(img.height);
  const isWhiteCol = new Uint8Array(img.width);
  const rowWhite = new Int32Array(img.height);
  const colWhite = new Int32Array(img.width);

  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const i = (y * img.width + x) * 4;
      const white = img.data[i] >= whiteThreshold && img.data[i + 1] >= whiteThreshold && img.data[i + 2] >= whiteThreshold;
      if (white) { rowWhite[y] += 1; colWhite[x] += 1; }
    }
  }
  for (let y = 0; y < img.height; y += 1) isWhiteRow[y] = rowWhite[y] / img.width > 0.97 ? 1 : 0;
  for (let x = 0; x < img.width; x += 1) isWhiteCol[x] = colWhite[x] / img.height > 0.97 ? 1 : 0;

  const bands = (flags, limit) => {
    const out = [];
    let start = -1;
    for (let i = 0; i < limit; i += 1) {
      if (!flags[i] && start < 0) start = i;
      else if (flags[i] && start >= 0) {
        if (i - start >= minSize) out.push([start, i - start]);
        start = -1;
      }
    }
    if (start >= 0 && limit - start >= minSize) out.push([start, limit - start]);
    return out;
  };

  const rowBands = bands(isWhiteRow, img.height);
  const colBands = bands(isWhiteCol, img.width);
  const panels = [];
  for (const [y, h] of rowBands) {
    for (const [x, w] of colBands) {
      panels.push({ x: x + gutter, y: y + gutter, width: w - gutter * 2, height: h - gutter * 2 });
    }
  }
  return { panels, rowBands, colBands };
}

/**
 * 시트를 JPEG 로 인코딩한다.
 *
 * 왜: 손으로 그린 듯한 도면은 셀마다 무늬가 달라 고유 타일이 1,000장 가까이 나오고,
 * PNG(무손실)로 담으면 1.8MB 가 된다. localStorage 에 넣기엔 부담이다.
 * SPUM 은 `imageUrl` 을 `<img>` 로 로드하므로 형식을 가리지 않고, 도면 맵은
 * 투명이 필요 없어서 JPEG 로 10분의 1 이하로 줄일 수 있다.
 */
export async function encodeJpeg(width, height, rgba, quality = 85) {
  let jpeg;
  try {
    jpeg = (await import('jpeg-js')).default;
  } catch {
    throw new Error('JPEG 인코딩에는 jpeg-js 가 필요합니다 (pnpm add jpeg-js).');
  }
  // jpeg-js 는 투명을 모른다 — 흰 배경에 합성한다
  const flat = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const a = rgba[i * 4 + 3];
    for (let c = 0; c < 3; c += 1) {
      flat[i * 4 + c] = Math.round((rgba[i * 4 + c] * a + 255 * (255 - a)) / 255);
    }
    flat[i * 4 + 3] = 255;
  }
  return jpeg.encode({ data: flat, width, height }, quality).data;
}

/**
 * 흰 여백을 잘라내 그림의 실제 범위만 남긴다.
 *
 * 짝 이미지(그림+마스크)를 맞출 때 필요하다. AI 는 두 판을 정확히 같은 크기로
 * 그리지 않는다 — 실측: 896×1200 이미지에서 위 판 567px, 아래 판 541px (4.6% 차이).
 * 판 크기로 맞추면 그만큼 어긋난다. 각 판에서 **도면의 경계 상자**를 찾아
 * 그 기준으로 맞추면 판 크기가 달라도 정렬된다.
 */
export function trimWhite(img, threshold = 236) {
  let x0 = img.width; let y0 = img.height; let x1 = -1; let y1 = -1;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const i = (y * img.width + x) * 4;
      if (img.data[i + 3] < 32) continue;
      if (img.data[i] >= threshold && img.data[i + 1] >= threshold && img.data[i + 2] >= threshold) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { img, box: null };
  return { img: cropImage(img, x0, y0, x1 - x0 + 1, y1 - y0 + 1), box: { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } };
}

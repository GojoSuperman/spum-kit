/**
 * 최소 PNG 인코더 (8bit RGBA, 무필터).
 *
 * 타일 시트를 만들려면 PNG 를 써야 하는데, 이 리포는 의존성이 없다.
 * PNG 는 zlib + CRC32 만 있으면 되고 둘 다 표준 라이브러리에 있다.
 */
import zlib from 'node:zlib';

function crc32(buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer) >>> 0;
  let table = crc32._table;
  if (!table) {
    table = crc32._table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, body, tail]);
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba  width*height*4
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function toDataUrl(buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

/** 그리기용 캔버스 — 픽셀 배열 + 기본 도형 */
export class Canvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }

  set(x, y, [r, g, b, a = 255]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    if (a >= 255) {
      this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; this.data[i + 3] = 255;
      return;
    }
    const pa = this.data[i + 3];
    const out = a + (pa * (255 - a)) / 255;
    if (out <= 0) return;
    this.data[i] = (r * a + this.data[i] * pa * (255 - a) / 255) / out;
    this.data[i + 1] = (g * a + this.data[i + 1] * pa * (255 - a) / 255) / out;
    this.data[i + 2] = (b * a + this.data[i + 2] * pa * (255 - a) / 255) / out;
    this.data[i + 3] = out;
  }

  fill(x0, y0, w, h, color) {
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) this.set(x, y, color);
    }
  }

  outline(x0, y0, w, h, color) {
    for (let x = x0; x < x0 + w; x += 1) { this.set(x, y0, color); this.set(x, y0 + h - 1, color); }
    for (let y = y0; y < y0 + h; y += 1) { this.set(x0, y, color); this.set(x0 + w - 1, y, color); }
  }

  hline(x0, x1, y, color) { for (let x = x0; x <= x1; x += 1) this.set(x, y, color); }
  vline(x, y0, y1, color) { for (let y = y0; y <= y1; y += 1) this.set(x, y, color); }

  /** 다른 캔버스를 붙여넣는다 (타일 → 시트) */
  blit(source, x0, y0) {
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const i = (y * source.width + x) * 4;
        const a = source.data[i + 3];
        if (a === 0) continue;
        this.set(x0 + x, y0 + y, [source.data[i], source.data[i + 1], source.data[i + 2], a]);
      }
    }
  }

  toPng() { return encodePng(this.width, this.height, this.data); }
}

/** 좌표로 결정되는 의사난수 — 다시 돌려도 같은 그림이 나온다 */
export function noise(x, y, seed = 0) {
  let h = Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b) ^ Math.imul(seed + 1, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * 최소 PNG 디코더 — 8bit RGBA/RGB/그레이, 비인터레이스만.
 * 타일 시트를 잘라 쓰려면 읽기도 필요하다. 여기 쓰는 에셋이 그 범위 안에 있다.
 */
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('PNG 시그니처가 아닙니다.');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  let palette = null;
  let trns = null;

  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('인터레이스 PNG 는 지원하지 않습니다.');
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') trns = Buffer.from(data);
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`bitDepth ${bitDepth} 는 지원하지 않습니다 (8 만).`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`colorType ${colorType} 는 지원하지 않습니다.`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[p]; p += 1;
    const line = Buffer.from(raw.subarray(p, p + stride)); p += stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
        line[x] = (line[x] + pr) & 255;
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * channels;
    let r; let g; let b; let a = 255;
    if (colorType === 6) { r = out[o]; g = out[o + 1]; b = out[o + 2]; a = out[o + 3]; }
    else if (colorType === 2) { r = out[o]; g = out[o + 1]; b = out[o + 2]; }
    else if (colorType === 0) { r = out[o]; g = out[o]; b = out[o]; }
    else if (colorType === 4) { r = out[o]; g = out[o]; b = out[o]; a = out[o + 1]; }
    else { const k = out[o]; r = palette[k * 3]; g = palette[k * 3 + 1]; b = palette[k * 3 + 2]; a = trns && k < trns.length ? trns[k] : 255; }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a;
  }
  return { width, height, data: rgba };
}

// 生成本地图标源图（1024×1024 PNG），风格：浅色底 + 品牌色圆角方块 + 白色字母「H」。
// 纯 Node 实现，无第三方依赖（zlib 手写 PNG 编码），避免依赖系统 GDI+/字体。
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SIZE = 1024;
const BG = [246, 248, 250]; // 浅色底
const BRAND = [37, 137, 214]; // 品牌强调色
const WHITE = [255, 255, 255];

// 圆角方块参数
const RECT = { x0: 96, y0: 96, x1: 96 + 832, y1: 96 + 832, r: 200 };

// 字母 H 的矩形笔画（用矩形拼出「H」，避免字体依赖）
const H = (() => {
  const top = RECT.y0 + 190;
  const bottom = RECT.y1 - 190;
  const barW = 120;
  const leftBarX = RECT.x0 + 232;
  const rightBarX = RECT.x1 - 232 - barW;
  const midY = (top + bottom) / 2;
  const crossH = barW;
  return {
    top,
    bottom,
    bars: [
      // 左竖
      { x0: leftBarX, y0: top, x1: leftBarX + barW, y1: bottom },
      // 右竖
      { x0: rightBarX, y0: top, x1: rightBarX + barW, y1: bottom },
      // 中横
      { x0: leftBarX, y0: midY - crossH / 2, x1: rightBarX + barW, y1: midY + crossH / 2 },
    ],
  };
})();

function inRect(x, y, r) {
  return x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1;
}

function inRoundedRect(x, y) {
  const { x0, y0, x1, y1, r } = RECT;
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
  // 四个角的圆角判定
  const cx = x < x0 + r ? x0 + r : x >= x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y >= y1 - r ? y1 - r : y;
  if (cx === x || cy === y) return true;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inH(x, y) {
  for (const bar of H.bars) {
    if (inRect(x, y, bar)) return true;
  }
  return false;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

// 3×3 超采样抗锯齿
const SS = 3;
const rgba = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let accR = 0;
    let accG = 0;
    let accB = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const px = x + (sx + 0.5) / SS;
        const py = y + (sy + 0.5) / SS;
        let color = BG;
        if (inRoundedRect(px, py)) color = BRAND;
        if (inH(px, py)) color = WHITE;
        accR += color[0];
        accG += color[1];
        accB += color[2];
      }
    }
    const n = SS * SS;
    const i = (y * SIZE + x) * 4;
    rgba[i] = Math.round(accR / n);
    rgba[i + 1] = Math.round(accG / n);
    rgba[i + 2] = Math.round(accB / n);
    rgba[i + 3] = 255;
  }
}

// —— 手写 PNG 编码 ——
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace

// 每行前置 filter 字节 0
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const rowStart = y * (SIZE * 4 + 1);
  raw[rowStart] = 0;
  rgba.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const idat = deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '..', 'src-tauri', 'app-icon.png');
writeFileSync(outPath, png);
console.log(`ICON_SOURCE_OK ${outPath} bytes=${png.length} mixed=${mix(BG, BRAND, 0.5).join(',')}`);

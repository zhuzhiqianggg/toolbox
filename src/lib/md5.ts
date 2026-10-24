/**
 * 纯 JS MD5（RFC 1321），输出 32 位小写十六进制。
 *
 * 存在原因：Web Crypto（`crypto.subtle`）**不提供 MD5**；为不引入第三方依赖，
 * 此处自带一份紧凑实现（消息按 UTF-8 编码，与常见 md5 工具一致）。
 *
 * 正确性锚点（RFC 1321 官方测试向量）：
 *   md5("")    = d41d8cd98f00b204e9800998ecf8427e
 *   md5("a")   = 0cc175b9c0f1b6a831c399e269772661
 *   md5("abc") = 900150983cd24fb0d6963f7d28e17f72
 *   md5("message digest") = f96b697d7cb7938d525a2f31aaf161d0
 *
 * 仅用于校验/比对场景（MVP）；MD5 已不具密码学安全性，禁止用于新签名体系。
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
] as const;

/** 常量表 K[i] = floor(|sin(i+1)| × 2^32)（RFC 1321 §3.4）。 */
const K: readonly number[] = Array.from({ length: 64 }, (_unused, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0,
);

function toHexLE(word: number): string {
  let out = '';
  for (let i = 0; i < 4; i += 1) {
    out += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * 计算字节序列的 MD5（32 位小写十六进制）。
 *
 * 与 `md5(string)` 共用同一实现：文本场景先按 UTF-8 编码为字节，
 * 文件场景直接喂入原始字节，两条路径结果口径一致。
 */
export function md5Bytes(bytes: Uint8Array): string {
  const len = bytes.length;
  const bitLenLo = (len << 3) >>> 0;
  const bitLenHi = Math.floor(len / 0x20000000) >>> 0; // len*8 的高 32 位

  // 填充：原消息 + 0x80 + 补零至 ≡56 (mod 64) + 8 字节小端比特长度
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, bitLenLo, true);
  view.setUint32(total - 4, bitLenHi, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let j = 0; j < 16; j += 1) {
      m[j] = view.getUint32(off + j * 4, true);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let j = 0; j < 64; j += 1) {
      let f: number;
      let g: number;
      if (j < 16) {
        f = (b & c) | (~b & d);
        g = j;
      } else if (j < 32) {
        f = (d & b) | (~d & c);
        g = (5 * j + 1) % 16;
      } else if (j < 48) {
        f = b ^ c ^ d;
        g = (3 * j + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * j) % 16;
      }
      const tmp = (f + a + (K[j] ?? 0) + (m[g] ?? 0)) >>> 0;
      a = d;
      d = c;
      c = b;
      const s = S[j] ?? 1;
      b = (b + ((tmp << s) | (tmp >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  return toHexLE(a0) + toHexLE(b0) + toHexLE(c0) + toHexLE(d0);
}

/** 计算字符串的 MD5（UTF-8 编码，32 位小写十六进制）。 */
export function md5(input: string): string {
  return md5Bytes(new TextEncoder().encode(input));
}

import { format } from 'date-fns';

/**
 * JWT 解码 / 验签工具集（工具箱 JWT 解码器专用）。
 *
 * 纯函数、无 React 依赖，便于单测与复用：
 * - base64url ↔ 字节 / 文本 互转；
 * - JWT 三段解析（header / payload / signature）+ 友好错误；
 * - **HMAC 验签**（HS256 / HS384 / HS512），基于浏览器原生 Web Crypto（`crypto.subtle`）；
 * - 过期四态判定（已过期 / 即将过期 / 正常 / 无过期时间）与时间声明本地化；
 * - 标准声明（iss / sub / aud / jti）抽取；
 * - 示例 Token 构造（含真实 HMAC 签名，便于演示验签通过）。
 *
 * 浏览器 / Tauri 双环境均可用：`crypto.subtle` 缺失时验签降级为明确报错，不抛未捕获异常。
 */

/** 本项目支持本地验签的 HMAC 算法 */
export const HMAC_ALGORITHMS = ['HS256', 'HS384', 'HS512'] as const;
export type HmacAlg = (typeof HMAC_ALGORITHMS)[number];

/** JWT 算法 → Web Crypto 哈希名 */
const HASH_BY_ALG: Record<string, string> = {
  HS256: 'SHA-256',
  HS384: 'SHA-384',
  HS512: 'SHA-512',
};

/** 标准时间格式（本地时区） */
const TIME_FORMAT = 'yyyy-MM-dd HH:mm:ss';
/** 判定「即将过期」的剩余时间阈值（毫秒，24 小时） */
const EXPIRING_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** JWT 头部 */
export interface JwtHeader {
  alg?: string;
  typ?: string;
  kid?: string;
  [key: string]: unknown;
}

/** JWT 载荷（标准声明 + 自定义声明） */
export interface JwtPayload {
  /** 签发者 */
  iss?: string;
  /** 主题 */
  sub?: string;
  /** 受众（可字符串或字符串数组） */
  aud?: string | string[];
  /** 过期时间（Unix 秒） */
  exp?: number;
  /** 生效时间（Unix 秒） */
  nbf?: number;
  /** 签发时间（Unix 秒） */
  iat?: number;
  /** 令牌 ID */
  jti?: string;
  [key: string]: unknown;
}

/** 解码成功的 JWT 结构 */
export interface DecodedJwt {
  /** 头部原始段（base64url 原文） */
  headerSegment: string;
  /** 载荷原始段（base64url 原文） */
  payloadSegment: string;
  /** 签名原始段 */
  signatureSegment: string;
  /** 参与签名的原文：`header.payload` */
  signingInput: string;
  /** 头部对象 */
  header: JwtHeader;
  /** 载荷对象 */
  payload: JwtPayload;
  /** 头部 JSON（缩进 2 空格） */
  headerText: string;
  /** 载荷 JSON（缩进 2 空格） */
  payloadText: string;
  /** 头部算法（alg） */
  algorithm: string;
}

export type DecodeResult =
  | { ok: true; decoded: DecodedJwt }
  | { ok: false; error: string };

/** 验签状态 */
export type VerifyStatus =
  /** 尚未验证 */
  | 'idle'
  /** 验证中 */
  | 'verifying'
  /** 签名有效 */
  | 'valid'
  /** 签名无效 */
  | 'invalid'
  /** 算法不支持 / 环境不支持（无法验证） */
  | 'unsupported'
  /** 验证过程出错 */
  | 'error';

export interface VerifyState {
  status: VerifyStatus;
  /** 面向用户的说明文案 */
  message: string;
}

/** 过期状态 */
export type ExpiryState =
  /** 已过期 */
  | 'expired'
  /** 即将过期（24 小时内） */
  | 'expiring'
  /** 正常 */
  | 'active'
  /** 未设置 exp */
  | 'none';

export interface ExpiryInfo {
  state: ExpiryState;
  /** 徽章文案 */
  label: string;
  /** 徽章样式类名 */
  className: string;
  /** 过期时间戳（毫秒），未设置 exp 时为 null */
  expiresAt: number | null;
  /** 补充说明（如「3 小时后过期」） */
  detail: string;
}

/** 时间声明展示项 */
export interface TimeClaim {
  key: 'iat' | 'nbf' | 'exp';
  label: string;
  seconds: number;
  /** 本地格式化时间 */
  absolute: string;
  /** 相对描述（如「3 小时后」） */
  relative: string;
}

/** 标准声明展示项 */
export interface ClaimRow {
  key: string;
  label: string;
  value: string;
}

/** 是否为普通对象（排除数组与 null） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** base64url → 字节数组；非法输入抛出 Error（调用方负责兜底）。 */
export function base64UrlToBytes(segment: string): Uint8Array {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + padding);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** 字节数组 → base64url（无填充） */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 文本 → base64url（UTF-8 安全） */
export function stringToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

/** base64url → UTF-8 文本；非法输入抛出 Error。 */
export function base64UrlToString(segment: string): string {
  return new TextDecoder().decode(base64UrlToBytes(segment));
}

/** 把 JSON 文本重新序列化为缩进 2 空格的形式（非法 JSON 原样返回）。 */
function prettyJsonText(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return text;
  }
}

/**
 * 解析 JWT。
 *
 * 容错：自动去除前缀 `Bearer `；非法结构 / 非法 base64 / 非 JSON 载荷
 * 均返回 `{ ok: false, error }`，不抛异常。
 */
export function decodeJwtToken(input: string): DecodeResult {
  const token = input.trim().replace(/^Bearer\s+/i, '');
  if (token.length === 0) {
    return { ok: false, error: '请输入 JWT' };
  }
  const segments = token.split('.');
  if (segments.length !== 3) {
    return {
      ok: false,
      error: `不是有效的 JWT：应由 header.payload.signature 三段组成，当前为 ${segments.length} 段`,
    };
  }
  const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
  if (headerSegment.length === 0 || payloadSegment.length === 0) {
    return { ok: false, error: 'JWT 头部或载荷为空，无法解析' };
  }

  let headerText = '';
  let payloadText = '';
  try {
    headerText = base64UrlToString(headerSegment);
  } catch {
    return { ok: false, error: '头部不是合法的 base64url 编码' };
  }
  try {
    payloadText = base64UrlToString(payloadSegment);
  } catch {
    return { ok: false, error: '载荷不是合法的 base64url 编码' };
  }

  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(headerText) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `头部不是合法 JSON：${message}` };
  }
  try {
    payload = JSON.parse(payloadText) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `载荷不是合法 JSON：${message}` };
  }
  if (!isPlainObject(header)) {
    return { ok: false, error: '头部必须是 JSON 对象' };
  }
  if (!isPlainObject(payload)) {
    return { ok: false, error: '载荷必须是 JSON 对象' };
  }

  const algValue = header.alg;
  return {
    ok: true,
    decoded: {
      headerSegment,
      payloadSegment,
      signatureSegment,
      signingInput: `${headerSegment}.${payloadSegment}`,
      header: header as JwtHeader,
      payload: payload as JwtPayload,
      headerText: prettyJsonText(headerText),
      payloadText: prettyJsonText(payloadText),
      algorithm: typeof algValue === 'string' ? algValue : '',
    },
  };
}

/** 相对时间描述（N 秒/分钟/小时/天 前·后）。 */
export function describeRelative(targetMs: number, now: number = Date.now()): string {
  const diffSec = Math.round((targetMs - now) / 1000);
  const abs = Math.abs(diffSec);
  const suffix = diffSec >= 0 ? '后' : '前';
  if (abs < 60) {
    return `${abs} 秒${suffix}`;
  }
  const minutes = Math.floor(abs / 60);
  if (minutes < 60) {
    return `${minutes} 分钟${suffix}`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时${suffix}`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days} 天${suffix}`;
  }
  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months} 个月${suffix}`;
  }
  return `${Math.floor(months / 12)} 年${suffix}`;
}

/** Unix 秒 → 本地格式化时间（失败回退 ISO 串）。 */
export function formatUnixSeconds(seconds: number): string {
  try {
    return format(new Date(seconds * 1000), TIME_FORMAT);
  } catch {
    return new Date(seconds * 1000).toISOString();
  }
}

/** 过期四态判定。 */
export function getExpiryInfo(payload: JwtPayload, now: number = Date.now()): ExpiryInfo {
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return {
      state: 'none',
      label: '无过期时间',
      className: 'border-blue-200 bg-blue-50 text-blue-700',
      expiresAt: null,
      detail: '该 Token 未设置 exp，长期有效',
    };
  }
  const expiresAt = exp * 1000;
  if (expiresAt <= now) {
    return {
      state: 'expired',
      label: '已过期',
      className: 'border-red-200 bg-red-50 text-red-700',
      expiresAt,
      detail: `已于 ${describeRelative(expiresAt, now)}过期`,
    };
  }
  const remain = expiresAt - now;
  if (remain < EXPIRING_THRESHOLD_MS) {
    return {
      state: 'expiring',
      label: '即将过期',
      className: 'border-amber-200 bg-amber-50 text-amber-700',
      expiresAt,
      detail: `将在 ${describeRelative(expiresAt, now)}过期`,
    };
  }
  return {
    state: 'active',
    label: '正常',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    expiresAt,
    detail: `将在 ${describeRelative(expiresAt, now)}过期`,
  };
}

/** 抽取时间类声明（iat / nbf / exp），按 iat → nbf → exp 顺序。 */
export function buildTimeClaims(payload: JwtPayload, now: number = Date.now()): TimeClaim[] {
  const claims: TimeClaim[] = [];
  const push = (key: TimeClaim['key'], label: string): void => {
    const value = payload[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      claims.push({
        key,
        label,
        seconds: value,
        absolute: formatUnixSeconds(value),
        relative: describeRelative(value * 1000, now),
      });
    }
  };
  push('iat', '签发时间 iat');
  push('nbf', '生效时间 nbf');
  push('exp', '过期时间 exp');
  return claims;
}

/** 抽取标准声明（iss / sub / aud / jti），值为空则不展示。 */
export function buildStandardClaims(payload: JwtPayload): ClaimRow[] {
  const rows: ClaimRow[] = [];
  const add = (key: string, label: string, value: unknown): void => {
    if (value === undefined || value === null || value === '') {
      return;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return;
      }
      rows.push({ key, label, value: value.map((item) => String(item)).join('、') });
      return;
    }
    rows.push({ key, label, value: String(value) });
  };
  add('iss', '签发者 iss', payload.iss);
  add('sub', '主题 sub', payload.sub);
  add('aud', '受众 aud', payload.aud);
  add('jti', '令牌 ID jti', payload.jti);
  return rows;
}

/** 是否为可本地验证的 HMAC 算法 */
export function isHmacAlgorithm(alg: string): boolean {
  return Object.prototype.hasOwnProperty.call(HASH_BY_ALG, alg);
}

/** 是否具备 Web Crypto 验签环境 */
export function hasWebCrypto(): boolean {
  return typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.subtle !== 'undefined';
}

/**
 * HMAC 验签（HS256 / HS384 / HS512）。
 *
 * 算法取 `algOverride`（UI 手动覆盖）优先，其次 header.alg；二者皆非 HMAC 时返回 `unsupported`。
 * 环境缺少 `crypto.subtle`（非安全上下文）时返回明确错误，不抛异常。
 */
export async function verifyJwtSignature(
  decoded: DecodedJwt,
  secret: string,
  algOverride: string = '',
): Promise<VerifyState> {
  const alg = algOverride.length > 0 ? algOverride : decoded.algorithm;
  if (alg.length === 0) {
    return { status: 'unsupported', message: '头部缺少 alg 字段，请手动选择算法' };
  }
  if (!isHmacAlgorithm(alg)) {
    return {
      status: 'unsupported',
      message: `算法 ${alg} 不是 HMAC 算法，本工具仅支持本地验证 ${HMAC_ALGORITHMS.join(' / ')}`,
    };
  }
  if (secret.length === 0) {
    return { status: 'error', message: '请先填写密钥' };
  }
  if (decoded.signatureSegment.length === 0) {
    return { status: 'invalid', message: '该 Token 没有签名段（alg=none），无法验证' };
  }
  if (!hasWebCrypto()) {
    return {
      status: 'error',
      message: '当前环境不支持 Web Crypto（需 HTTPS 或 localhost），无法验签',
    };
  }

  try {
    const signature = base64UrlToBytes(decoded.signatureSegment);
    const hash = HASH_BY_ALG[alg] ?? 'SHA-256';
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash },
      false,
      ['verify'],
    );
    const data = new TextEncoder().encode(decoded.signingInput);
    // 某些实现对 BufferSource 的视图有要求，统一拷贝为独立 ArrayBuffer 视图
    const signatureView = new Uint8Array(signature);
    const ok = await globalThis.crypto.subtle.verify('HMAC', key, signatureView, data);
    return ok
      ? { status: 'valid', message: `签名有效（${alg}）` }
      : { status: 'invalid', message: `签名无效（${alg}）—— 密钥不匹配或内容被篡改` };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'error', message: `验签失败：${message}` };
  }
}

/** 示例 Token 使用的演示密钥（填入密钥框即可看到「验证通过」） */
export const SAMPLE_SECRET = 'toolbox-demo-secret';

/** 示例载荷（正常 / 已过期） */
function buildSamplePayload(expired: boolean, now: number): JwtPayload {
  const iat = expired ? Math.floor(now / 1000) - 7200 : Math.floor(now / 1000);
  const exp = expired ? Math.floor(now / 1000) - 3600 : Math.floor(now / 1000) + 7 * 24 * 3600;
  return {
    iss: 'https://toolbox.local',
    sub: 'user-10086',
    aud: 'toolbox-desktop',
    jti: expired ? 'demo-expired-0001' : 'demo-active-0001',
    iat,
    nbf: iat,
    exp,
    name: 'Toolbox 示例用户',
    roles: ['admin', 'editor'],
  };
}

/**
 * 构造示例 JWT（带真实 HMAC-SHA256 签名，密钥见 `SAMPLE_SECRET`）。
 * 环境缺少 Web Crypto 时退化为随机占位签名（仍可正常解码与查看过期态）。
 */
export async function buildSampleToken(expired: boolean): Promise<string> {
  const now = Date.now();
  const header: JwtHeader = { alg: 'HS256', typ: 'JWT' };
  const payload = buildSamplePayload(expired, now);
  const headerSegment = stringToBase64Url(JSON.stringify(header));
  const payloadSegment = stringToBase64Url(JSON.stringify(payload));
  const signingInput = `${headerSegment}.${payloadSegment}`;

  let signatureSegment = '';
  if (hasWebCrypto()) {
    try {
      const key = await globalThis.crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(SAMPLE_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const signature = await globalThis.crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(signingInput),
      );
      signatureSegment = bytesToBase64Url(new Uint8Array(signature));
    } catch {
      signatureSegment = '';
    }
  }
  if (signatureSegment.length === 0) {
    // 占位签名：外形合法，验签会失败（这是预期行为）
    signatureSegment = stringToBase64Url(`toolbox-demo-signature-${now}-${expired ? 'expired' : 'active'}`);
  }
  return `${signingInput}.${signatureSegment}`;
}

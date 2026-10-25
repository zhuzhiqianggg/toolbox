import * as React from 'react';
import { Palette as PaletteIcon } from 'lucide-react';
import { CommandShell, type SampleEntry } from '@/components/CommandShell';
import { CopyButton } from '@/components/CopyButton';
import { useCommandShell } from '@/hooks/useCommandShell';
import { usePersistedState } from '@/hooks/usePersistedState';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'color-converter';

/** RGBA 颜色（a ∈ [0,1]，1 = 不透明）。 */
interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * 解析 HEX：支持 #RGB / #RGBA / #RRGGBB / #RRGGBBAA。
 * 3/4 位是 6/8 位的短写法（每位重复一次），alpha 位换算为 该字节 / 255。
 */
function parseHex(input: string): Rgba | null {
  const token = input.trim().replace(/^#/, '');
  if (!/^(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(token)) {
    return null;
  }
  let hex = token;
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

/**
 * 解析 rgb()/rgba()：前三个通道 0-255，第 4 个是透明度 ——
 * 按 CSS 惯例取 0-1 小数，也兼容 0-255 整数写法（>1 时按 255 折算）。
 */
function parseRgb(input: string): Rgba | null {
  const parts = input
    .trim()
    .replace(/^rgba?\(/i, '')
    .replace(/\)$/, '')
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((s) => Number.parseFloat(s));
  if (parts.length !== 3 && parts.length !== 4) {
    return null;
  }
  const r = parts[0];
  const g = parts[1];
  const b = parts[2];
  if (r === undefined || g === undefined || b === undefined) {
    return null;
  }
  if (
    parts.some((n) => Number.isNaN(n)) ||
    r < 0 ||
    r > 255 ||
    g < 0 ||
    g > 255 ||
    b < 0 ||
    b > 255
  ) {
    return null;
  }
  let a = 1;
  if (parts.length === 4) {
    const raw = parts[3];
    if (raw === undefined || Number.isNaN(raw) || raw < 0 || raw > 255) {
      return null;
    }
    a = raw > 1 ? raw / 255 : raw;
  }
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a };
}

/** 解析 hsl()/hsla()：h ∈ [0,360]，s/l ∈ [0,100]，透明度 0-1。 */
function parseHsl(input: string): Rgba | null {
  const parts = input
    .trim()
    .replace(/^hsla?\(/i, '')
    .replace(/\)$/, '')
    .split(/[,\s%]+/)
    .filter(Boolean)
    .map((s) => Number.parseFloat(s));
  if (parts.length !== 3 && parts.length !== 4) {
    return null;
  }
  const h = parts[0];
  const s = parts[1];
  const l = parts[2];
  if (h === undefined || s === undefined || l === undefined) {
    return null;
  }
  if (
    parts.some((n) => Number.isNaN(n)) ||
    h < 0 ||
    h > 360 ||
    s < 0 ||
    s > 100 ||
    l < 0 ||
    l > 100
  ) {
    return null;
  }
  let a = 1;
  if (parts.length === 4) {
    const raw = parts[3];
    if (raw === undefined || Number.isNaN(raw) || raw < 0 || raw > 1) {
      return null;
    }
    a = raw;
  }
  return { ...hslToRgb(h, s / 100, l / 100), a };
}

function hslToRgb(h: number, s: number, l: number): Rgba {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
    a: 1,
  };
}

function rgbToHsl({ r, g, b }: Rgba): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

const toHex2 = (n: number): string => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
const formatHex = ({ r, g, b, a }: Rgba): string =>
  // 不透明时省略 alpha 位（保持惯用 6 位写法），带透明度时输出 8 位
  `#${toHex2(r)}${toHex2(g)}${toHex2(b)}${a < 1 ? toHex2(clamp(a, 0, 1) * 255) : ''}`.toUpperCase();
const formatRgb = ({ r, g, b, a }: Rgba): string =>
  a < 1 ? `rgba(${r}, ${g}, ${b}, ${round3(a)})` : `rgb(${r}, ${g}, ${b})`;
const formatHsl = (rgb: Rgba): string => {
  const { h, s, l } = rgbToHsl(rgb);
  return rgb.a < 1 ? `hsla(${h}, ${s}%, ${l}%, ${round3(rgb.a)})` : `hsl(${h}, ${s}%, ${l}%)`;
};

/** CSS 颜色值（预览用）：统一 rgba 形式，半透明色才能正确渲染。 */
const toCssColor = ({ r, g, b, a }: Rgba): string => `rgba(${r}, ${g}, ${b}, ${round3(a)})`;

/** 透明度棋盘格底（仅半透明色时垫在色块下，让「透」看得见）。 */
const CHECKER_STYLE: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, #d4d4d8 25%, transparent 25%, transparent 75%, #d4d4d8 75%),' +
    'linear-gradient(45deg, #d4d4d8 25%, transparent 25%, transparent 75%, #d4d4d8 75%)',
  backgroundSize: '12px 12px',
  backgroundPosition: '0 0, 6px 6px',
};

/**
 * 颜色转换：HEX / RGB / HSL 三栏互通，任意一栏输入即同步另两栏与预览色块。
 * 支持透明度：HEX 8 位（#RRGGBBAA）与 rgba()/hsla() 的第四参数互通。
 * 纯前端，无依赖。
 */
export function ColorConverter({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);

  const initRgb = parseHex(initialInput) ?? { r: 59, g: 130, b: 246, a: 1 };
  const [hex, setHex] = usePersistedState<string>(COMMAND_ID, 'hex', formatHex(initRgb));
  // RGB / HSL 栏的初始值从「可能已被持久化的 hex」派生：
  // 若直接用 initRgb（来自 initialInput 或默认蓝），重开工具时三栏会对不上
  const initFromHex = parseHex(hex) ?? initRgb;
  const [rgbStr, setRgbStr] = React.useState<string>(formatRgb(initFromHex));
  const [hslStr, setHslStr] = React.useState<string>(formatHsl(initFromHex));

  const currentRgb = parseHex(hex);
  const preview = currentRgb ?? { r: 0, g: 0, b: 0, a: 1 };

  const syncFromRgb = (rgb: Rgba, except: 'hex' | 'rgb' | 'hsl'): void => {
    if (except !== 'hex') setHex(formatHex(rgb));
    if (except !== 'rgb') setRgbStr(formatRgb(rgb));
    if (except !== 'hsl') setHslStr(formatHsl(rgb));
  };

  const onHex = (v: string): void => {
    setHex(v);
    const rgb = parseHex(v);
    if (rgb) syncFromRgb(rgb, 'hex');
  };
  const onRgb = (v: string): void => {
    setRgbStr(v);
    const rgb = parseRgb(v);
    if (rgb) syncFromRgb(rgb, 'rgb');
  };
  const onHsl = (v: string): void => {
    setHslStr(v);
    const rgb = parseHsl(v);
    if (rgb) syncFromRgb(rgb, 'hsl');
  };

  const valid = currentRgb !== null;

  /** 示例条：一键填入代表性颜色，apply 只调 onHex，另两栏自动同步 */
  const samples = React.useMemo<SampleEntry[]>(
    () => [
      { label: '品牌蓝', description: '#3B82F6', apply: () => onHex('#3B82F6') },
      { label: '翡翠绿', description: '#10B981', apply: () => onHex('#10B981') },
      { label: '琥珀橙', description: '#F59E0B', apply: () => onHex('#F59E0B') },
      { label: '深夜蓝', description: '#0F172A（Tailwind slate-900）', apply: () => onHex('#0F172A') },
      {
        label: '半透明蓝',
        description: '#3B82F680（50% 透明度）—— 三栏会切到 rgba/hsla 形式，预览垫棋盘格',
        apply: () => onHex('#3B82F680'),
      },
    ],
    // onHex 只写状态不读状态，闭包可安全缓存
    [],
  );

  return (
    <CommandShell
      title="颜色转换"
      onPaste={(t) => setHex(t)}
      description="HEX / RGB / HSL 互通 + 透明度 + 实时预览"
      icon={<PaletteIcon className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={valid ? hex : ''}
      samples={samples}
      shortcutHint="任意一栏输入即同步另两栏；透明度支持 #RRGGBBAA 与 rgba()/hsla()"
    >
      <div className="flex flex-col gap-4">
        {/* 预览色块：半透明色时垫棋盘格底，透明部分能看出来 */}
        <div className="flex items-center gap-4">
          <div
            className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-border shadow-inner"
            style={preview.a < 1 ? CHECKER_STYLE : undefined}
          >
            <div className="absolute inset-0" style={{ backgroundColor: toCssColor(preview) }} />
          </div>
          <div className="text-sm text-muted-foreground">
            {currentRgb ? (
              <>
                <div>
                  十六进制：<code className="font-mono text-foreground">{hex}</code>
                </div>
                <div>
                  RGB：<code className="font-mono text-foreground">{rgbStr}</code>
                </div>
                <div>
                  HSL：<code className="font-mono text-foreground">{hslStr}</code>
                </div>
                {currentRgb.a < 1 ? <div>透明度：{Math.round(currentRgb.a * 100)}%</div> : null}
              </>
            ) : (
              <span className="text-destructive">HEX 格式无效，无法预览</span>
            )}
          </div>
        </div>

        <Field label="HEX" value={hex} onChange={onHex} valid={currentRgb !== null} copy={hex} mono autoFocus />
        <Field
          label="RGB"
          value={rgbStr}
          onChange={onRgb}
          valid={parseRgb(rgbStr) !== null}
          copy={rgbStr}
          mono
        />
        <Field
          label="HSL"
          value={hslStr}
          onChange={onHsl}
          valid={parseHsl(hslStr) !== null}
          copy={hslStr}
          mono
        />
      </div>
    </CommandShell>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  valid: boolean;
  copy: string;
  mono?: boolean;
  autoFocus?: boolean;
}

function Field({ label, value, onChange, valid, copy, mono, autoFocus }: FieldProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <CopyButton text={copy} disabled={!valid} label="复制" />
      </div>
      <input
        type="text"
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={
          'h-9 rounded-md border bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ' +
          (valid ? 'border-input text-foreground' : 'border-destructive/50 text-destructive') +
          (mono ? ' font-mono' : '')
        }
      />
    </div>
  );
}

export default ColorConverter;

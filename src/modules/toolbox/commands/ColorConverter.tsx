import * as React from 'react';
import { Palette as PaletteIcon } from 'lucide-react';
import { CommandShell } from '@/components/CommandShell';
import { CopyButton } from '@/components/CopyButton';
import { useCommandShell } from '@/hooks/useCommandShell';
import { usePersistedState } from '@/hooks/usePersistedState';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'color-converter';

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function parseHex(input: string): Rgb | null {
  const m = input.trim().replace(/^#/, '').match(/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!m) {
    return null;
  }
  let hex = m[1] ?? '';
  if (hex.length !== 3 && hex.length !== 6) {
    return null;
  }
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function parseRgb(input: string): Rgb | null {
  const m = input
    .trim()
    .replace(/^rgb\(/i, '')
    .replace(/\)$/, '')
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((s) => Number.parseInt(s, 10));
  if (m.length !== 3 || m.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return null;
  }
  const [r, g, b] = m as [number, number, number];
  return { r, g, b };
}

function parseHsl(input: string): Rgb | null {
  const m = input
    .trim()
    .replace(/^hsl\(/i, '')
    .replace(/\)$/, '')
    .split(/[,\s%]+/)
    .filter(Boolean)
    .map((s) => Number.parseFloat(s));
  if (m.length !== 3 || m.some((n) => Number.isNaN(n))) {
    return null;
  }
  const [h, s, l] = m as [number, number, number];
  if (h < 0 || h > 360 || s < 0 || s > 100 || l < 0 || l > 100) {
    return null;
  }
  return hslToRgb(h, s / 100, l / 100);
}

function hslToRgb(h: number, s: number, l: number): Rgb {
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
  };
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
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
const formatHex = ({ r, g, b }: Rgb): string => `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`.toUpperCase();
const formatRgb = ({ r, g, b }: Rgb): string => `rgb(${r}, ${g}, ${b})`;
const formatHsl = (rgb: Rgb): string => {
  const { h, s, l } = rgbToHsl(rgb);
  return `hsl(${h}, ${s}%, ${l}%)`;
};

/**
 * 颜色转换：HEX / RGB / HSL 三栏互通，任意一栏输入即同步另两栏与预览色块。
 * 纯前端，无依赖。
 */
export function ColorConverter({ initialInput = '' }: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);

  const initRgb = parseHex(initialInput) ?? { r: 59, g: 130, b: 246 };
  const [hex, setHex] = usePersistedState<string>(COMMAND_ID, 'hex', formatHex(initRgb));
  const [rgbStr, setRgbStr] = React.useState<string>(formatRgb(initRgb));
  const [hslStr, setHslStr] = React.useState<string>(formatHsl(initRgb));

  const currentRgb = parseHex(hex) ?? { r: 0, g: 0, b: 0 };
  const preview = parseHex(hex) ? hex : '#000000';

  const syncFromRgb = (rgb: Rgb, except: 'hex' | 'rgb' | 'hsl'): void => {
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

  const valid = parseHex(hex) !== null;

  return (
    <CommandShell
      title="颜色转换"
      onPaste={(t) => setHex(t)}
      description="HEX / RGB / HSL 互通 + 实时预览"
      icon={<PaletteIcon className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={valid ? hex : ''}
      shortcutHint="任意一栏输入即同步另两栏；复制按钮可单独取各格式"
    >
      <div className="flex flex-col gap-4">
        {/* 预览色块 */}
        <div className="flex items-center gap-4">
          <div
            className="h-20 w-20 shrink-0 rounded-lg border border-border shadow-inner"
            style={{ backgroundColor: preview }}
          />
          <div className="text-sm text-muted-foreground">
            {valid ? (
              <>
                <div>
                  十六进制：<code className="font-mono text-foreground">{hex}</code>
                </div>
                <div>
                  RGB：<code className="font-mono text-foreground">{rgbStr}</code>
                </div>
              </>
            ) : (
              <span className="text-destructive">HEX 格式无效，无法预览</span>
            )}
          </div>
        </div>

        <Field label="HEX" value={hex} onChange={onHex} valid={parseHex(hex) !== null} copy={hex} mono />
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
}

function Field({ label, value, onChange, valid, copy, mono }: FieldProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <CopyButton text={copy} disabled={!valid} label="复制" />
      </div>
      <input
        type="text"
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

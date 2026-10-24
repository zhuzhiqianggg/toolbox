import type { Config } from 'tailwindcss';

/**
 * Handy · 顺手 设计令牌
 * 风格：浅色、扁平、少层级、单一品牌强调色、低对比分割线、无重阴影。
 * 深浅色通过 CSS 变量 + `dark:` 前缀切换（MVP 保证浅色）。
 */
const config: Config = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 语义色（映射到 index.css 中的 CSS 变量）
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        /** 页面画布底色（V24）：浅灰，白色卡片浮在它上面形成层次。
         *  不要拿 `background` 当画布用 —— 输入框、二维码画布等都应该保持纯白。 */
        canvas: 'hsl(var(--canvas))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // 单一品牌强调色（蓝）
        brand: {
          DEFAULT: 'hsl(var(--brand))',
          foreground: 'hsl(var(--brand-foreground))',
          muted: 'hsl(var(--brand-muted))',
        },
      },
      fontFamily: {
        sans: [
          // V24：Windows 11 优先走 Segoe UI Variable（字重与字宽更细腻），
          // 回退到 YaHei UI（比 YaHei 行距更好）；macOS 走 PingFang SC。
          '"Segoe UI Variable Display"',
          '"Segoe UI Variable Text"',
          '"Segoe UI"',
          '"Microsoft YaHei UI"',
          '"Microsoft YaHei"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Source Han Sans SC"',
          '"Noto Sans SC"',
          'system-ui',
          '-apple-system',
          'sans-serif',
        ],
        mono: [
          '"JetBrains Mono"',
          '"Cascadia Code"',
          'Consolas',
          '"Courier New"',
          'monospace',
        ],
      },
      borderRadius: {
        sm: 'calc(var(--radius) - 4px)',
        md: 'calc(var(--radius) - 2px)',
        lg: 'var(--radius)',
        xl: 'calc(var(--radius) + 4px)',
      },
      boxShadow: {
        // V24 层次：card（静息）→ hover（悬停微抬）→ popover（浮层）。
        // 一律走同一色相的低透明阴影，避免彩色投影那种廉价感。
        card: '0 1px 2px 0 hsl(215 16% 47% / 0.06)',
        panel: '0 1px 2px 0 hsl(215 16% 47% / 0.08)',
        hover: '0 4px 12px -2px hsl(215 16% 47% / 0.12), 0 2px 4px -2px hsl(215 16% 47% / 0.06)',
        popover: '0 8px 24px -4px hsl(215 16% 47% / 0.16), 0 2px 8px -2px hsl(215 16% 47% / 0.08)',
      },
      transitionTimingFunction: {
        // 统一的「现代感」缓动：出场快、收尾缓
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-down': {
          from: { opacity: '0', transform: 'translateY(-4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'slide-down': 'slide-down 140ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;

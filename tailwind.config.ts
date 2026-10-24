import type { Config } from 'tailwindcss';

/**
 * Toolbox 设计令牌
 * 风格：浅色、扁平为骨、品牌渐变点缀、单一品牌强调色、低对比分割线、精致分层阴影。
 * 深浅色通过 CSS 变量 + `dark:` 前缀切换。
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
        // 层次：card（静息）→ hover（悬停微抬）→ popover（浮层）。
        // 一律走同一色相的低透明分层阴影，避免彩色投影那种廉价感。
        card: '0 1px 2px 0 hsl(220 22% 45% / 0.05), 0 1px 3px 0 hsl(220 22% 45% / 0.04)',
        panel: '0 1px 2px 0 hsl(220 22% 45% / 0.08), 0 2px 6px -2px hsl(220 22% 45% / 0.05)',
        hover: '0 12px 32px -8px hsl(220 25% 45% / 0.14), 0 4px 10px -4px hsl(220 25% 45% / 0.08)',
        popover: '0 16px 40px -12px hsl(220 25% 40% / 0.18), 0 4px 12px -4px hsl(220 25% 40% / 0.08)',
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

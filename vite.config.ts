import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri 通过该环境变量告知当前目标平台（用于选择 WebView 编译目标）
const tauriPlatform = process.env.TAURI_ENV_PLATFORM ?? process.platform;
// Windows 用 WebView2（Chromium 105），macOS 用 WKWebView（Safari 13）
const buildTarget = tauriPlatform === 'darwin' || tauriPlatform === 'macos' ? 'safari13' : 'chrome105';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // 别名必须与 tsconfig.json 的 paths 保持一致（@ -> ./src）
  resolve: {
    alias: {
      // 不用 node: 内置模块，直接用全局 process.cwd()（npm/tauri 均以项目根为 cwd）；
      // 统一为正斜杠，避免 Windows 反斜杠在解析时出问题。
      '@': `${process.cwd().replace(/\\/g, '/')}/src`,
    },
  },
  // Tauri CLI 需要读取前端日志，不要清屏
  clearScreen: false,
  // 仅暴露 VITE_ / TAURI_ 前缀的环境变量
  envPrefix: ['VITE_', 'TAURI_'],
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    hmr: {
      protocol: 'ws',
      host: 'localhost',
      port: 1421,
    },
    // Rust 源码变更交给 tauri dev 处理，避免前端热更新误触发
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    target: buildTarget,
    minify: 'esbuild',
    sourcemap: false,
    // 桌面端无需兼容老浏览器，跳过部分 polyfill
    cssTarget: buildTarget,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // 拆分重型第三方库，降低首屏体积
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-ui': [
            'lucide-react',
            'class-variance-authority',
            'clsx',
            'tailwind-merge',
          ],
        },
      },
    },
  },
});

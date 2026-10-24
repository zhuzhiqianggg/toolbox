# Handy · 顺手 — 开发规范与环境准备

> 面向 **Handy · 顺手**（项目代号 `handy`）桌面版的开发手册。约束来源：`02-architecture/TASKS.md` 第 2 章「共享知识」，此处整理为可执行规范。

---

## 1. 环境准备（Windows）

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20 LTS | 前端构建 |
| Rust | stable（建议用 `rustup` 安装） | Tauri 后端编译 |
| MSVC Build Tools | 最新 | Windows 上的 Rust 链接器（含 C++ 生成工具） |
| WebView2 Runtime | — | Win10 1809+ / Win11 多已内置；缺失时 Tauri 安装器会引导 |

> 建议后续在项目根提供 `rust-toolchain.toml` 锁定 Rust 版本。

## 2. 常用命令（脚手架就绪后）

| 命令 | 说明 |
| --- | --- |
| `npm install` | 安装前端依赖 |
| `npm run tauri dev` | 桌面开发模式（热更新） |
| `npm run tauri build` | 打包 MSI / NSIS 安装包 |
| `npm run dev` | 仅启动前端（浏览器调试用，无桌面能力） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run test` | 单元测试（Vitest） |

## 3. 命名与目录规范

- **工具 id**：全小写 `kebab-case`，如 `timestamp`、`json-formatter`、`port-query`。
- **组件文件**：`PascalCase.tsx`，默认导出 `React.FC<ToolProps>`。
- **Rust 命令**：`snake_case`，按领域分文件放 `src-tauri/src/commands/`，在 `commands/mod.rs` 汇总，在 `main.rs` 的 `invoke_handler` 注册。
- **IPC 调用**：前端**一律通过 `src/lib/ipc.ts`** 封装调用，**禁止**在组件里直接写 `invoke('xxx')` 字符串。
- **目录层级**：保持扁平，工具按大类分子目录（`tools/text|encoding|security|network|devops`）。

## 4. 工具注册的固定写法

新增一个工具 = **1 个组件文件 + 1 条注册项**，框架其余部分自动生效。

```ts
// src/tools/registry.ts
export const TOOLS: ToolMeta[] = [
  {
    id: 'timestamp',
    name: '时间戳转换',
    description: '时间戳与日期时间互转，支持秒/毫秒与多时区',
    category: 'encoding-decoding',
    icon: 'Clock',
    aliases: ['ts', 'timestamp', 'sjc'],
    keywords: ['时间戳', 'timestamp', 'unix', '日期'],
    layout: 'split',
    popularity: 100,
    isOnline: false,
    load: () => import('./encoding/TimestampConverter'),
  },
];
```

## 5. IPC 调用统一封装

```ts
// src/lib/ipc.ts
import { invoke } from '@tauri-apps/api/core';

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : (e as Error).message);
  }
}

export const ipc = {
  queryPortUsage: (port: number) => call<PortProcess[]>('query_port_usage', { port }),
  killProcess: (pid: number) => call<void>('kill_process', { pid }),
  fileHash: (path: string, algorithm: string) => call<FileHashResult>('file_hash', { path, algorithm }),
  // ...见 ARCHITECTURE 5.3
};
```

## 6. 错误处理约定

- Rust 命令统一返回 `Result<T, String>`，`String` 为**面向用户的中文可读信息**。
- 前端 `ipc.ts` 统一兜底并抛 `Error`；组件内 `try/catch` 后以 `sonner` toast 展示。
- **高风险操作**（结束进程、写 hosts、批量重命名）**必须二次确认**后再调用。
- 需要提权的失败，错误信息带 `NEED_ELEVATION` 标记，前端据此显示「以管理员重启」入口。

## 7. 样式约定（Tailwind 令牌）

- 主色：单一强调色（蓝/青），定义在 `tailwind.config.ts` 的 `theme.extend.colors.brand`。
- 圆角：`rounded-lg`（8px）为基准，卡片 `rounded-xl`。
- 间距：4 的倍数（`p-4` / `gap-4` / `space-y-4`）。
- 分割线：`border-border` 低对比，扁平优先，避免重阴影。
- 深浅色：CSS 变量（HSL）+ `dark:` 前缀；MVP 保证浅色。
- 字体：系统中文优先，栈含「Microsoft YaHei / 思源黑体」。

## 8. TypeScript 严格模式

- `tsconfig.json`：`"strict": true`、`"noUncheckedIndexedAccess": true`、`"noImplicitOverride": true`。
- **禁止 `any`**（用 `unknown` + 收窄）；公共函数必须显式返回类型。
- 工具组件 props 必须实现 `ToolProps`。
- 构建前 `tsc --noEmit` **必须零错误**。

## 9. 提交规范

```
feat: 新功能
fix: 修复问题
docs: 文档更新
style: 代码格式
refactor: 重构
test: 测试
chore: 构建/工具链
```

## 10. 质量门禁（每个任务完成前）

1. `npm run typecheck` 零错误；
2. `npm run lint` 通过；
3. `npm run test` 通过（有测试覆盖的核心工具）；
4. 桌面能力相关任务：`npm run tauri dev` 实测通过（不能只靠类型检查）；
5. 高风险操作实测（提权失败路径、大文件、快捷键冲突）。

## 11. Tauri 相关注意事项

- `tauri-plugin-single-instance` **必须最先注册**，否则无法拦截二次启动。
- 主窗口**启动即预创建并隐藏**，快捷键呼出仅 `show()/setFocus()`，以满足首帧 < 300ms。
- 权限（`capabilities/*.json`）遵循**最小授权**：不授予宽泛 `fs`；文件读写走自定义命令。
- `Cargo.toml` 的 `[profile.release]` 已设 `opt-level="s" / lto / codegen-units=1 / panic="abort" / strip`。

---

*配套文档：`docs/02-architecture/ARCHITECTURE.md`、`docs/02-architecture/TASKS.md`*

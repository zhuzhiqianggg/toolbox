# Handy · 顺手

> **一个常驻托盘的跨平台桌面效率套件**：把桌面整理、便签、剪贴板、截图、文件处理、系统增强，以及一整套随手即用的小工具收进同一个入口——**一个快捷键呼出，双击安装即用，离线可用、隐私不外泄。**

| 项目 | 内容 |
| --- | --- |
| 产品名 | **Handy · 顺手**（已定） |
| 项目代号 | `handy` |
| 项目路径 | `D:\_Projects\ops\handy` |
| 目标平台 | **Windows 10 1809+ / 11（x64、arm64）· macOS 12+（Apple Silicon / Intel）**，Linux 后续评估 |
| 当前阶段 | **Phase 1 · MVP 已完成，待装机验收**：统一入口命令面板 + 工具箱 **23 个工具** + 桌面网格挂件 + 便签/待办 + 桌面工作台 + 密码存储器；Windows 安装包（`.exe`/`.msi`）已产出；`cargo check` / `tsc` 双绿，GUI 运行时行为待人工验证。详见 **[`.workbuddy/PROJECT_STATUS.md`](.workbuddy/PROJECT_STATUS.md)**。 |
| 参考项目 | `../ops-tools`（网页版，**只读借鉴，禁止修改**） |

> **🚀 开发上下文（从这里续接）**：现状、剩余任务、开发约束、环境命令 → **[`.workbuddy/PROJECT_STATUS.md`](.workbuddy/PROJECT_STATUS.md)**；长期约定与踩坑记录 → [`.workbuddy/memory/MEMORY.md`](.workbuddy/memory/MEMORY.md)；逐日进展 → `.workbuddy/memory/`。
>
> **命名说明**：最终采用 **Handy · 顺手**——主张「**方便，而不是全面**」，最贴合普通办公人群的使用动机。候选名 `万象 / OmniDesk` 及完整推演见 `docs/01-planning/PRD.md` §2 与 `docs/01-planning/DECISIONS.md`。
>
> **文档导航**：先看 [`docs/README.md`](docs/README.md)（文档索引与阅读顺序）。

---

## 1. 这是什么、给谁用

从最初的「运维工具箱」升级为**面向大众的跨平台桌面效率套件**：

- 对**普通办公人员**：它是「桌面管家 + 效率助手」——收拾桌面、随手记事、找回剪贴板、截图标注、批量处理文件；
- 对**运维 / 研发**：它仍是那把「秒开的工具箱」——完整继承网页版 30+ 高频工具；
- 底层：**一个可以不断加模块的平台**，新功能 = 新模块 = 新价值。

### 为什么用户要装它（而不是一堆零散小软件）

| 差异点 | 零散小软件 | 本产品 |
| --- | --- | --- |
| 入口 | 10 个软件、10 个托盘图标、10 套快捷键 | **一个快捷键、一个托盘、一个设置中心** |
| 数据 | 便签/剪贴板/待办各自为政 | **互通**：剪贴板一键转便签/待办，截图可存便签 |
| 隐私 | 要联网、上云、带广告捆绑 | **纯本地、默认不联网、无广告无捆绑** |
| 安装 | 解压、配置、命令行 | **双击安装即用，零环境依赖** |
| 扩展 | 单一工具做完就停更 | **模块化平台**，官方持续加模块 |

---

## 2. 核心体验

```
[任意界面] --Alt+Space--> [命令面板] --输入关键词--> [命中工具/模块] --Enter-->
[就地打开或独立窗口] --操作--> [一键复制结果] --Esc--> [退回原界面]
```

- **命令面板优先**：不摆分类宫格，只有「搜索 + 收藏 + 最近使用」，支持拼音首字母（`sjc`→时间戳）。
- **常驻与秒开**：托盘/菜单栏常驻，主窗预创建隐藏，呼出首帧目标 < 300ms。
- **零粘贴 + 全键盘闭环**：能从剪贴板/本地文件拿到的绝不手工粘贴；`↑↓` 选择、`Enter` 执行、`Esc` 退出、`Ctrl+C` 复制。

---

## 3. 模块矩阵（11 个）

| 模块 | 内容 | 优先级 |
| --- | --- | --- |
| **M1 效率工具箱** | 时间戳 / JSON / Base64 / 密码 / 哈希 / JWT / IP-CIDR / Cron / Docker↔Compose / 编解码 / 网络 / 运维等 | P0 |
| **M2 桌面整理** | 一键整理、按类型/日期归类、预览 + 撤销（mac 降级为文件归类） | P0 |
| **M3 便签·待办·提醒** | 桌面便签（置顶/换色）、任务清单、定时提醒、便签↔待办互转 | P0 |
| **M4 剪贴板增强** | 历史/搜索/置顶、智能识别（JSON/JWT/URL/时间戳）、转便签 | P0 |
| **M5 快速启动·全局搜索** | 命令面板 + 应用/文件快速搜索启动 | P1 |
| **M6 截图·贴图·标注·OCR** | 截图、钉图、标注、本地 OCR | P1 |
| **M7 文件处理** | 批量重命名、编码/换行符转换、重复文件、磁盘分析、大文件清理 | P1 |
| **M8 系统优化·增强** | 启动项管理、右键菜单增强(Win)/访达扩展(mac)、系统信息 | P1 |
| **M9 安全与隐私** | 数据脱敏、文件加密、密码管理 | P1 |
| **M10 媒体小工具** | 图片压缩、二维码、PDF 轻处理、格式转换 | P1 |
| **M11 办公增强·协作** | 会议记录、跨设备传文件、快捷片段、专注计时 | P2 |

> **MVP（第一版）只做 6 部分**：统一入口 + M1 工具箱(8 子工具) + M2 桌面整理(基础) + M3 便签/待办 + M4 剪贴板 + **双平台一键安装**。其余模块按 Phase 2/3/4 排期。

---

## 4. 技术栈（已定）

| 层 | 选型 | 备注 |
| --- | --- | --- |
| 桌面运行时 | **Tauri 2（Rust）** | 原生跨平台；包小、内存低；快捷键/托盘/自启/更新/通知为一等公民插件 |
| 前端 | React 18 + TypeScript 5 + Vite 5 | 与网页版同源，算法可迁移 |
| 样式/组件 | Tailwind CSS 3 + shadcn/ui（Radix）+ `cmdk` | **不引入 MUI** |
| 状态 | Zustand | 配置态 + 视图态 |
| 数据层 | **SQLite（`tauri-plugin-sql`）** | 便签/待办/剪贴板/历史/整理计划（`handy.db`） |
| 配置层 | `tauri-plugin-store`(JSON) | 仅 settings/模块开关/Pro 标记（`settings.json`） |
| 平台能力 | `src-tauri/src/platform/{windows,macos}` + `src/platform/` | 差异收敛，业务不写平台分支 |

> 决策与理由见 `docs/02-architecture/ARCHITECTURE.md`。

---

## 5. 文档地图

> 完整索引与阅读顺序见 **[`docs/README.md`](docs/README.md)**。

| 文档 | 内容 |
| --- | --- |
| `docs/01-planning/PRD.md` | **权威需求文档**：定位、命名、11 模块矩阵、30 条办公痛点清单、MVP 裁定、可扩展性与商业化设计、跨平台策略、路线图 |
| `docs/01-planning/TOOLS_INVENTORY.md` | 网页版约 50 个工具全量盘点 + 保留/砍掉决策 + 源码位置（开发时的迁移清单） |
| `docs/01-planning/DECISIONS.md` | **决策记录**：已决策 15 项 + 待拍板事项 |
| `docs/02-architecture/ARCHITECTURE.md` | **权威架构**：ADR-5…10、架构图、目录结构、模块/功能注册契约、IPC 契约、数据模型、打包签名公证、风险 |
| `docs/02-architecture/TASKS.md` | 依赖清单、**15 个可派工任务（V01–V15）**、共享约定、Phase 划分、依赖图 |
| `docs/02-architecture/*.mermaid` | 独立时序图 / 类图源文件 |
| `docs/03-development/DEVELOPMENT.md` | 开发规范、环境准备、质量门禁 |
| `docs/99-archive/` | v1 历史文档（运维工具箱版 PRD / 架构 / 任务 / 决策），保留可追溯 |

---

## 6. 路线图

| 阶段 | 目标 | 核心交付 |
| --- | --- | --- |
| **Phase 1 · MVP** | 做出能打动大众的最小组合，**双平台一键安装** | 统一入口 + 桌面整理(基础) + 便签/待办 + 剪贴板 + 工具箱(8 子工具) |
| **Phase 2 · 效率增强** | 补齐高频生产力模块 | 快速启动/全局搜索 + 截图套件(标注/贴图/OCR) + 文件处理 |
| **Phase 3 · 系统与专业** | 强化系统级与专业能力，形成付费点 | 系统优化 + 安全隐私 + 媒体/PDF + 官方扩展包(L2) + Pro 分层 |
| **Phase 4 · 生态与商业化** | 从「工具」走向「平台」 | 插件市场(L3) + 可选账号/同步 + 商业化闭环 |

> 节奏原则：**每一阶段都要能独立交付、可装机、可被用户用起来**。

---

## 7. 目录结构

### 7.1 当前（规划阶段）

```
handy/
├── README.md                        # 项目主文档（本文件）
└── docs/
    ├── README.md                    # 文档索引与阅读顺序
    ├── 01-planning/
    │   ├── PRD.md                   # 权威需求文档（原 PRD-v2）
    │   ├── TOOLS_INVENTORY.md       # 工具盘点与取舍
    │   └── DECISIONS.md             # 决策记录（原 DECISIONS-v2）
    ├── 02-architecture/
    │   ├── ARCHITECTURE.md          # 权威架构（原 ARCHITECTURE-v2）
    │   ├── TASKS.md                 # 任务分解（原 TASKS-v2）
    │   ├── sequence-diagram.mermaid
    │   └── class-diagram.mermaid
    ├── 03-development/
    │   └── DEVELOPMENT.md           # 开发规范
    └── 99-archive/                  # v1 历史文档（只读归档）
        ├── PRD-v1.md
        ├── ARCHITECTURE-v1.md
        ├── TASKS-v1.md
        └── DECISIONS-v1.md
```

### 7.2 开发时创建（代码骨架）

```
handy/
├── src/                      # 前端 React
│   ├── core/                 # 内核：模块注册表 / 扩展点 / 授权 / 跨模块数据服务
│   ├── modules/              # 各功能模块（toolbox / notes / clipboard / desktop-organizer …）
│   ├── components/           # 共享 UI：命令面板 / 外壳 / 设置中心 / shadcn 原子组件
│   ├── platform/             # 平台抽象（能力探测与封装）
│   ├── lib/                  # ipc / db / store / clipboard / search / detect
│   └── stores/  hooks/
└── src-tauri/                # Rust 原生层
    ├── src/platform/         # windows.rs / macos.rs（PlatformOps trait 分实现）
    ├── src/db/               # SQLite + 迁移 + schema
    ├── src/commands/         # IPC 命令（net/file/system/clipboard/notes/todos/clip/organizer/app）
    └── capabilities/         # 最小权限清单
```

---

## 8. 开发环境准备（后续开发时执行）

> 进度：**V01 项目脚手架与双平台工程基座**、**V02 平台适配层与窗口/托盘/快捷键/单实例**、**V03 设计系统与共享 UI**、**V04 模块框架（注册表 / 扩展点 / SQLite 持久化）**、**V05 统一入口命令面板（含拼音搜索、收藏 / 最近首屏、设置中心骨架）**、**V06+V07 工具箱 9 子工具（时间戳多时区 / JSON 行号定位与大输入保护 / Base64 / URL / JWT / 文本对比 / 密码生成 / 哈希 MD5·SHA1·SHA256 / 二维码）** 已完成。
>
> 自测状态：前端 `npm run typecheck` / `npm run build` 零错误；Rust `cargo check` 零错误（MSVC Build Tools 已就绪，cargo 1.98.1 + MSVC 14.44.35207 + Windows SDK 10.0.26100）；MD5 实现经 RFC 1321 向量 + Node crypto 交叉验证 15/15 通过。
>
> 说明：`tauri build` 打包与安装测试进行中。

前置要求（**仅开发者需要，终端用户无需任何环境**）：

- **Node.js** ≥ 20 LTS
- **Rust** 稳定版（`rustup`）+ 平台工具链：Win 需 MSVC Build Tools；mac 需 Xcode Command Line Tools
- **WebView2 Runtime**（Win10 1809+ 多已内置；mac 用系统 WKWebView）

常用命令（脚手架就绪后）：

```bash
npm install              # 安装依赖
npm run tauri dev        # 桌面开发模式（Win/mac 均可）
npm run tauri build      # 打包：Win → .msi/.exe；mac → .dmg
npm run typecheck        # tsc --noEmit
```

---

## 9. 与参考项目的关系

- 本目录 `handy/` 是**全新独立项目**（原 `ops-tools/ops-toolbox-desktop/` 已迁出，与老项目彻底分离），独立开发；
- 参考项目 `../ops-tools`（网页版）**仅作借鉴参考，不得修改**；
- 可复用：工具的纯函数算法、UI 组件思路、工具元数据；不迁移：路由、SEO、依赖后端的能力。

---

## 10. 商业化（构想）

- **免费**：核心效率与整理能力**永久免费**（统一入口、工具箱、便签、剪贴板、基础桌面整理）。
- **Pro（买断制为主）**：截图/OCR、PDF、密码管理、批量处理、跨设备传文件等**增强能力**。
- **底线**：无广告、无捆绑、不诱导付费；核心功能离线永久可用；数据不出本机。
- **远期**：官方扩展包（L2）→ 第三方插件市场（L3）。

---

## 11. 开发环境与命令

> 本节面向开发者。终端用户安装包（`.msi`/`.exe`/`.dmg`）**无需任何环境依赖**。

### 11.1 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20 LTS（本项目在 v22 上开发） | 前端构建 |
| npm | ≥ 10 | 包管理 |
| **Rust 工具链** | stable（`rustup` 安装） | Tauri 后端编译；版本锁定见 `rust-toolchain.toml` |
| **MSVC Build Tools** | 最新（含「使用 C++ 的桌面开发」） | Windows 上的 Rust 链接器 |
| WebView2 Runtime | — | Win10 1809+ / Win11 多已内置；缺失时安装器引导 |
| Xcode Command Line Tools | — | macOS 构建 |

> **重要**：Rust 工具链需先安装（`rustup` + MSVC Build Tools），否则 `npm run tauri dev` / `npm run tauri build` 无法编译后端。仅前端开发（`npm run dev`）不需要 Rust。

### 11.2 常用命令

```bash
npm install              # 安装前端依赖（首次必须）
npm run dev              # 仅启动前端 Vite（浏览器调试，无桌面能力）
npm run typecheck        # tsc --noEmit（严格模式，要求零错误）
npm run build            # 前端生产构建，产出 dist/
npm run preview          # 预览已构建的前端产物

# —— 以下需要 Rust 工具链就绪 ——
npm run tauri dev        # 桌面开发模式（Win/mac，热更新）
npm run tauri build      # 打包：Win → .msi/.exe；mac → .dmg
```

### 11.3 首次运行顺序

1. 安装 Rust 工具链（`rustup`）+ 平台编译工具（Win：MSVC Build Tools；mac：Xcode CLT）；
2. `npm install`；
3. `npm run typecheck` 确认零错误；
4. `npm run tauri dev` 拉起桌面窗口（前端可先用 `npm run dev` 在浏览器里调 UI）。

### 11.4 目录速览（代码骨架）

```
handy/
├── src/                 # 前端：core / modules / components / platform / lib / stores / hooks
├── src-tauri/           # Rust：src/{platform,db,commands}、capabilities、icons、tauri.conf.json
├── docs/                # 规划与架构文档（PRD / ARCHITECTURE / TASKS / DEVELOPMENT）
└── rust-toolchain.toml  # 锁定 Rust 版本（CI 复用）
```


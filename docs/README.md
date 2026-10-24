# Handy · 顺手 — 文档索引

> 本目录是 **Handy（顺手）** 项目的全部规划与设计文档。本文件是导航入口：**先读这里，再按「推荐阅读顺序」往下看**。

| 项目 | 内容 |
| --- | --- |
| 产品名 | **Handy · 顺手** |
| 项目代号 | `handy` |
| 一句话定位 | 一个常驻托盘、快捷键呼出、双击安装的**跨平台桌面效率套件** |
| 当前阶段 | **Phase 1（MVP）交付完成**：工具箱 23 工具 + 工作台 + 桌面挂件 + 密码存储器；V16→V20 五轮用户反馈修复已落地；Windows 安装包已产出，待装机 GUI 验收（现状见 [`../.workbuddy/PROJECT_STATUS.md`](../.workbuddy/PROJECT_STATUS.md)） |
| 文档语言 | 简体中文 |

---

## 1. 推荐阅读顺序

| 顺序 | 文档 | 谁该看 | 读完你会知道 |
| --- | --- | --- | --- |
| ① | [`../README.md`](../README.md) | 所有人 | 产品是什么、给谁用、技术栈、路线图（5 分钟） |
| ② | [`01-planning/PRD.md`](01-planning/PRD.md) | 决策者 / 产品 | **做什么、不做什么**：定位、命名、11 模块、30 条痛点、MVP 范围、商业化 |
| ③ | [`01-planning/DECISIONS.md`](01-planning/DECISIONS.md) | 决策者 | 已拍板的 15 项 + 仍需你确认的事项 |
| ④ | [`02-architecture/ARCHITECTURE.md`](02-architecture/ARCHITECTURE.md) | 架构 / 开发 | **怎么做**：技术选型、架构图、目录结构、注册契约、IPC 契约、数据模型、打包签名 |
| ⑤ | [`02-architecture/TASKS.md`](02-architecture/TASKS.md) | 开发 | **按什么顺序做**：15 个可派工任务（V01–V15）+ 依赖图 + 共享约定 |
| ⑥ | [`03-development/DEVELOPMENT.md`](03-development/DEVELOPMENT.md) | 开发 | 环境准备、编码与命名规范、质量门禁 |
| ⑦ | [`01-planning/TOOLS_INVENTORY.md`](01-planning/TOOLS_INVENTORY.md) | 开发（迁移工具时） | 旧网页版 50 个工具的取舍结论 + 源码位置 |

> 只想快速了解结论 → 读 ① + ②；准备开工 → 读 ④ + ⑤ + ⑥。

---

## 2. 目录结构与文档清单

```
docs/
├── README.md                      # 本文件（索引）
├── 01-planning/                   # 规划：做什么
│   ├── PRD.md                     # ★ 权威需求文档
│   ├── TOOLS_INVENTORY.md         # 工具盘点与取舍（迁移清单）
│   └── DECISIONS.md               # ★ 决策记录
├── 02-architecture/               # 架构：怎么做
│   ├── ARCHITECTURE.md            # ★ 权威架构设计
│   ├── TASKS.md                   # ★ 任务分解与实现计划
│   ├── sequence-diagram.mermaid   # 时序图（源文件）
│   └── class-diagram.mermaid      # 类图（源文件）
├── 03-development/                # 开发：怎么落地
│   ├── DEVELOPMENT.md             # 开发规范与环境准备
│   └── TOOL-OPTIMIZATION.md       # 工具箱优化评估报告（V20，23 工具评分 + 方案）
└── 99-archive/                    # v1 历史文档（只读归档）
    ├── PRD-v1.md
    ├── ARCHITECTURE-v1.md
    ├── TASKS-v1.md
    └── DECISIONS-v1.md
```

| 文档 | 版本 | 状态 | 说明 |
| --- | --- | --- | --- |
| `01-planning/PRD.md` | v2.0 | ✅ 权威 | 从「运维工具箱」升级为「跨平台桌面效率套件」的完整需求文档 |
| `01-planning/TOOLS_INVENTORY.md` | v1.0 | ✅ 有效 | 旧网页版工具全量盘点 + 保留/砍掉/新增决策 |
| `01-planning/DECISIONS.md` | v2.0 | ✅ 权威 | 决策记录（ADR 口径），含待拍板项 |
| `02-architecture/ARCHITECTURE.md` | v2.0 | ✅ 权威 | 增量架构设计（ADR-5…10） |
| `02-architecture/TASKS.md` | v2.0 | ✅ 权威 | 15 个任务 + Phase 划分 + 依赖图 |
| `03-development/DEVELOPMENT.md` | v1.0 | ✅ 有效 | 开发规范 |
| `03-development/TOOL-OPTIMIZATION.md` | v1.0 | ✅ 有效 | 工具箱 23 个工具的成熟度评分、共性问题、逐工具优化方案与 P0/P1/P2 路线（V20） |
| `99-archive/*-v1.md` | v1.0 | 🗄️ 已归档 | 历史版本，仅作追溯，**不再维护** |

---

## 3. 版本与归档说明

- **权威版本 = 无后缀文件**（`PRD.md` / `ARCHITECTURE.md` / `TASKS.md` / `DECISIONS.md`），均对应 **v2.0**。
- **v1 历史文档**（Windows 运维工具箱定位）已移入 `99-archive/`，保留用于追溯 M1 工具箱的工具来源与早期架构推演。
- 任何决策变更：先在 `01-planning/DECISIONS.md` 登记，再回改对应文档。

---

## 4. 与参考项目的关系

- 本项目文档描述的是**独立新项目** `handy/`（已从旧项目 `ops-tools/ops-toolbox-desktop/` 迁出）。
- 参考项目路径：`D:\_Projects\ops\ops-tools`（网页版）——**只读借鉴，禁止修改**。
- `TOOLS_INVENTORY.md` 中的源码位置以 `../ops-tools/src/components/tools/` 为基准。

---

*最后更新：2026-09-15（V20 批次——补入 `03-development/TOOL-OPTIMIZATION.md`，并把「当前阶段」从「待开发」更正为 MVP 完成待验收）*

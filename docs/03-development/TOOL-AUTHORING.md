# 新增一个工具：完整指南

> 面向「我要给 Handy 加一个工具」的人。**按本文做完 = 工具会出现在首页、命令面板搜得到、图标不缺席、输入不丢失。**
> 配套：`scripts/new-tool.mjs`（脚手架）· `scripts/audit/tool-audit.mjs`（自检）· `docs/03-development/TOOL-OPTIMIZATION.md`（逐工具优化评估）。

---

## 0. 三步速览

```bash
# ① 生成组件 + 注册项
node scripts/new-tool.mjs --id=my-tool --name="我的工具" --category=text --icon=Wand2 --desc="一句话说明"

# ② 在 src/lib/icons.ts 的 ICONS 里登记图标（脚手架会提示，漏了会静默变扳手）

# ③ 自检（必过项 FAIL 会 exit 1）
node scripts/audit/tool-audit.mjs
```

然后补 **示例条（samples）** 与 **业务逻辑**。完工。

---

## 1. 一个工具由哪几部分组成

| 位置 | 作用 | 是否必须 |
| --- | --- | --- |
| `src/lib/<name>.ts` | **纯逻辑**（不碰 React / DOM / Tauri） | 强烈建议：能进回归测试 |
| `src/modules/toolbox/commands/<Name>.tsx` | 界面组件 | 必须 |
| `src/modules/toolbox/commands/index.ts` | 注册项（`CommandMeta`） | 必须 |
| `src/lib/icons.ts` 的 `ICONS` | 图标登记 | 必须（漏了不报错，只是变扳手） |
| `scripts/regression/test-<name>.mjs` | 回归测试 | 有纯逻辑就必须有 |

**分层铁律**：能放进 `src/lib/` 的计算，绝不写进组件。理由见 §5。

---

## 2. 注册项字段规范

```ts
{
  id: 'my-tool',              // kebab-case，全局唯一
  category: 'text',           // 首页分组依据 —— 见下表
  moduleId: 'toolbox',
  name: '我的工具',            // ≤ 18 字（卡片两行放得下）
  description: '一句话说明',    // ≤ 60 字
  icon: 'Wand2',              // 必须在 icons.ts 登记
  aliases: ['my-tool'],       // ≥ 1 个，英文缩写最好用
  keywords: ['关键词', 'mt'],  // ≥ 5 个，**务必含拼音首字母**（命令面板靠它）
  layout: 'split',
  tier: 'free',
  load: () => import('./MyTool'),
}
```

### 分类（`category`）怎么选

| id | 名称 | 放什么 |
| --- | --- | --- |
| `text` | 文本处理 | 清洗、对比、去重、命名转换 |
| `data` | 数据格式 | JSON / SQL / CSV 的排版与互转 |
| `encode` | 编码解码 | Base64 / URL / JWT / 摘要 / 图片 |
| `convert` | 换算转换 | 时间戳、相对时间、单位与体积 |
| `generate` | 生成器 | 密码、UUID、二维码 |
| `dev` | 开发辅助 | 正则、Cron、类型定义、码表 |

分类定义在 `src/core/toolCategories.ts`，与 `src/core/types.ts` 的 `ToolCategory` 联合类型
**必须一一对应**，`tool-audit` 会双向校验。加新分类要同时改这两处。

> 为什么强制分类：工具箱已经 24 个且还会继续加。**平铺网格在 20+ 个工具时必然失控**
> —— 用户找不到、新工具被埋掉。分类是「易扩展」的第一道约束。

---

## 3. 界面必须遵守的约定

1. **统一外壳**：一律用 `<CommandShell>`（标题栏 / 返回 / 收藏 / 一键复制 / 快捷键提示条都在这里）。
   随手写个 `<div>` 当标题栏 = 少了复制和收藏，用户会以为工具坏了。
2. **状态持久化**：两个 hook，按「状态长什么样」二选一。不接的话「切走再回来输入全丢」，
   这是用户明确投诉过的问题。
   - **状态本来就集中在一个对象里** → `useToolState(commandId, initialObject)` → `[state, patch, reset]`：
     ```tsx
     const [state, patch] = useToolState('my-tool', { input: '', strict: false });
     patch({ input: next });   // 浅合并，新增字段无需迁移
     ```
   - **状态散在多个 `useState` 里（工具箱里绝大多数工具是这样）** →
     `usePersistedState(commandId, key, initial)`。签名与 `useState` **完全一致**（含函数式更新），
     所以只改声明那一行，调用点一行都不用动：
     ```diff
     - const [input, setInput] = React.useState<string>(initialInput);
     + const [input, setInput] = usePersistedState<string>(COMMAND_ID, 'input', initialInput);
     ```
     相同 `commandId` 的多个字段共享一份内存镜像 + 一次防抖落盘，十几个状态连环变也只写一次。
   - **三类东西绝对不要持久化**：
     ① 派生结果（格式化输出、摘要、二维码 dataURL）—— 重算便宜，落盘纯浪费；
     ② 大块 Base64 正文（图片工具）—— 直接把 WebView 存储撑胖；
     ③ **密钥类输入**（WiFi 密码、JWT secret）—— 落盘 = 明文写进用户目录，
     与「保险箱加密存储」的约定自相矛盾。这三类保持 `React.useState`。
   - V24 起工具已全部接入：19 个用 `usePersistedState`（80 个字段）+ 3 个用 `useToolState`。
3. **示例条**：`samples={[{ label: '示例一', apply: () => {...} }]}`。
   每条自带 `apply` 闭包，可以「填文本 + 开开关 + 切页签」一次做完。**新工具默认配 3-5 条**，
   示例数据要贴近真实用法（日志片段、真实 JSON……），别写 `abc`。
   > 示例里出现的哈希 / Base64 / 时间戳**必须真算过再写进去**（V24 的 8 个工具示例条就是这么来的）。
   > 编一个「看起来像」的摘要值，用户点开校验会直接对不上，比没有示例更糟。
   >
   > 写完跑一遍 `node scripts/audit/sample-smoke.mjs` —— 它会在真实产物里点你的 chip 并断言结果。
   > 如果这个工具也值得进冒烟，就在脚本的 `CASES` 里加一条用例（`check` 要断言**用户能看到的后果**，
   > 不是内部状态）。
4. **结果区**：带高亮用 `<CodeBlock lang="...">`；普通文本用 `<ResultBox>`。
   高亮词法表**只有一份**（`CodeBlock` 的 `LANGS`），加语言只改那里，不要在别处复制正则。
5. **复制**：`copyText`（静态）或 `getCopyText`（惰性）二选一传给 `CommandShell`。
   **不要做「点了只弹 toast 不复制」的假按钮**（V20 挖出过 5 个这种假功能）。
6. **豁免标记**：示例能力已有更强的原生实现（正则库、示例 token 生成、生成器预设），
   或工具压根没有可填的输入（图片工具），在文件里写一行说明，**不要硬凑示例**：
   ```ts
   // tool-audit-ignore: samples —— 内置「示例 token」生成（含过期 token），比静态示例更完整
   ```
   支持 `samples` / `persist` 两个键。这不是「跳过检查」：自检报告里每一项都必须落在
   **「已接」或「显式豁免」** 二选一上，不允许静默缺失。

---

## 4. 响应式（改动布局必须跑审计）

```bash
node scripts/audit/layout-audit.mjs        # 24 工具 + 3 模块页 × 3 档视口
```

铁律（V23 血泪，详见 `PROJECT_STATUS.md` §1.9.4）：

- **`flex-1` 在 auto 高度的父容器里不是「撑满」，而是「可被压缩到 0」**。
  要撑满必须给父级明确高度；给不了，就让内容自然排布、把滚动交给外层。
- 因此**一切 `flex-1` / `min-h-*` 都要用 `lg:` 前缀关进宽屏**，
  窄屏走「单栏 + 内容高度 + 外层滚动」。
- **只看横向溢出会漏掉所有真缺陷**：V23 抓到的两处（日历被裁掉近两周、计划面板被压成 19px 空壳），
  `ox` 全程为 0，只有 `clipY` / `overlap` 抓得到。

---

## 5. 纯逻辑与回归测试

- 能抽出 `src/lib/<name>.ts` 的，一律抽出来（`cron.ts` / `sql.ts` / `textlab.ts` / `lunar.ts` 都是这样）。
- 写完就加 `scripts/regression/test-<name>.mjs`，并把文件名加进 `scripts/regression/run.mjs` 的 `SUITES`。
- **测试靠 Node ≥ 22.18 的原生类型剥离直接 `import '../../src/lib/x.ts'`，不要为测试引入打包步骤。**
- 历史上这些模块都翻过车（cron 的 Quartz `N/step` 展开、lunar 的闰月游标漂移、
  sql 的「抹平用空格」误报、textlab 的换行风格），**没有回归就是等着出事**。

---

## 6. 常见坑（都是真踩过的）

| 坑 | 现象 | 规避 |
| --- | --- | --- |
| 图标没登记 | 界面上一个扳手，**不报错** | 脚手架会提示；`tool-audit` 必过项 |
| `category` 没填 | 新工具在首页分组里没有位置，等于被埋 | `tool-audit` 必过项 |
| 组件文件名与 `load` 对不上 | 点开工具白屏（运行时才发现） | `tool-audit` 必过项 |
| 源码里的中文文案带反引号 / `**` | `TS1005`，且报错位置离真凶很远 | 中文文案用「」或普通引号 |
| 改了 `src/lib/*.ts` 没跑回归 | 悄悄回归 | 打包前必跑 `scripts/regression/run.mjs` |
| 输入框做输入期语法高亮 | 中文输入法下光标崩 | 输入用朴素 `textarea`，高亮只放结果区 |
| 换行处理只认 `\n` | Windows 文本行尾留 `\r`，去重把 `a` 和 `a\r` 当两行 | 用 `detectEol`/`splitLines`/`joinLines` |
| 把「密钥类输入」也持久化 | WiFi 密码 / JWT secret 明文落进 localStorage | 这三类保持 `React.useState`，见 §3.2 |
| 示例里的摘要 / Base64 手写 | 用户点开校验对不上，比没有示例更糟 | 先 `node -e` 真算一遍再写进示例 |
| 整体重写一个工具只为了接持久化 | 改动面大、回归风险高，收益却只是「输入不丢」 | 用 `usePersistedState` 一行替换，见 §3.2 |

---

## 7. 完工检查清单

- [ ] `node scripts/audit/tool-audit.mjs` —— 必过项 0 FAIL，提示项 0 WARN（或已写显式豁免标记）
- [ ] `node scripts/audit/layout-audit.mjs` —— 0 溢出 / 0 裁切 / 0 重叠
- [ ] `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` —— exit 0
- [ ] 有纯逻辑 → `node scripts/regression/run.mjs` 全绿
- [ ] 手动过一遍：填入 → 操作 → 复制，每个按钮的副作用**真的发生了**
- [ ] 示例条 3-5 条，数据是真实场景，**里面的哈希 / Base64 / 时间戳都真算过**
- [ ] `node scripts/audit/sample-smoke.mjs` —— 本工具的示例 chip 在真实产物里点了确实生效
      （新工具建议往脚本 `CASES` 里补一条用例）
- [ ] 密钥类输入（密码 / secret）**没有**被持久化

/**
 * 前后端**布局度量常量**的一致性回归（V56 新增，V60 随工作台改版）。
 *
 * # 为什么必须锁
 *
 * 桌面格子这套布局是**两边各算一遍**的：
 *   · Rust（`src-tauri/src/commands/grid.rs`）算格子摆哪、留多大地方（`min_x` / 竖条宽高 /
 *     每个格子该多高）；
 *   · 前端（`GridOverlay.tsx` / `DesktopWorkstation.tsx`）按同一组数去**画**。
 * 两边只靠源码注释约定「必须一致」，没有任何机器校验。
 *
 * 后果在 V51–V55 那批里集中爆发过一次（V56 全部修掉）：
 *   · `CELL_EXTRA_W` 36 → 32、`GRID_GAP` 4 → 6（前端条目网格改成 `gap-1.5 px-2.5` +
 *     `minmax(iconSize + 32)`），**前端竖条那两个常量没跟着改** —— 桌面左侧「未归类」竖条
 *     实际画出来比后端预留的宽 10px；
 *   · 格子标题栏 `h-8` → `h-9`（Rust `BOX_HEADER_H` 跟着改成 36），**前端那份漏改** ——
 *     所有「按内容自动撑高」的挂件盒子永远矮 4px；
 *   · Rust 单测里还留着旧度量算出来的期望值（228 / 300 / 日历 638），`cargo test` 一直红着
 *     而产品是对的 —— 「测试错、产品对」比反过来更危险。
 *
 * 于是把「必须相等的那些数」逐条对出来。**解析不到即 FAIL**（不是跳过）：源码格式一变、
 * 正则没匹配上时，本套件必须变红 —— 否则它静默退化成「永远 PASS」，比没有它更糟
 * （CONVENTIONS 里那条「审计脚本解析为空即 FAIL」的守卫）。
 *
 * V56 锁的三件（V60 把主角从「右下角快捷入口格子」换成了「右侧工作台浮窗」）：
 *   ① 工作台（前端 `WORKSTATION_W` ↔ Rust `WST_BOX_W`）——
 *      它由 Rust 当**禁区**（工作区右侧一整列）、由前端画，差 1px 就是
 *      「格子压在工作台上」或「白留一道缝」；
 *   ② 它是**固定定位**的（`top-8 right-8 bottom-8`），必须等于引擎的 `ARRANGE_MARGIN`；
 *      而且 V60 起它**占满整列高度**（不再有 `DOCK_MAX_H` 那种上限）；
 *   ③ 右侧工具面板的半屏档必须**让开**它（`sidePanelShell` 的 `right-[Npx]`），
 *      且面板的 z 必须**高于**工作台（铺满档会横向盖住它）—— 见 ③。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const OVERLAY = 'src/modules/desktop-grid/GridOverlay.tsx';
const WORKSTATION = 'src/modules/desktop-grid/DesktopWorkstation.tsx';
const PANEL = 'src/modules/desktop-grid/DesktopSidePanel.tsx';
const RUST = 'src-tauri/src/commands/grid.rs';

const overlaySrc = fs.readFileSync(path.join(root, OVERLAY), 'utf8');
const workstationSrc = fs.readFileSync(path.join(root, WORKSTATION), 'utf8');
const panelSrc = fs.readFileSync(path.join(root, PANEL), 'utf8');
const rustSrc = fs.readFileSync(path.join(root, RUST), 'utf8');

let pass = 0;
let fail = 0;
const bad = [];

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    bad.push(`${name}${extra ? ` → ${extra}` : ''}`);
  }
}

/**
 * 取 TS 源码里 `const NAME = <算式>;` 的值（支持常量引用与「加减」表达式，最多解四层）。
 *
 * 支持引用是必须的：`WORKSTATION_W = 320`、`WST_BOX_W = CALENDAR_BOX_W`
 * 这类写法本身就是「它们必须相等」的表达，只要最终值对得上就算过。
 * 出现不认识的形态（三元、函数调用…）时返回 null —— 由解析守卫报 FAIL，不许静默放过。
 */
function tsNumber(src, name, depth = 0) {
  const m = src.match(new RegExp(`^(?:export\\s+)?const\\s+${name}\\s*=\\s*([^;]+);`, 'm'));
  if (m === null) {
    return null;
  }
  return evalConstExpr(src, m[1].trim(), depth);
}

function evalConstExpr(src, expr, depth) {
  if (depth > 4) {
    return null;
  }
  if (/^-?\d+$/.test(expr)) {
    return Number(expr);
  }
  if (/^[A-Z][A-Z0-9_]*$/.test(expr)) {
    return tsNumber(src, expr, depth + 1);
  }
  const parts = expr.split(/([+-])/).map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length < 3) {
    return null;
  }
  let total = null;
  let op = '+';
  for (const part of parts) {
    if (part === '+' || part === '-') {
      op = part;
      continue;
    }
    const value = /^-?\d+$/.test(part)
      ? Number(part)
      : /^[A-Z][A-Z0-9_]*$/.test(part)
        ? tsNumber(src, part, depth + 1)
        : null;
    if (value === null) {
      return null;
    }
    total = total === null ? value : op === '+' ? total + value : total - value;
  }
  return total;
}

/** 取 Rust 源码里 `const NAME: i64 = <数字 | 常量名>;` 的值（取不到 null） */
function rsNumber(src, name, depth = 0) {
  const m = src.match(
    new RegExp(`^const\\s+${name}\\s*:\\s*i64\\s*=\\s*([A-Z_0-9]+|\\d+)\\s*;`, 'm'),
  );
  if (m === null) {
    return null;
  }
  const raw = m[1];
  return /^\d+$/.test(raw) ? Number(raw) : rsNumber(src, raw, depth + 1);
}

/** Tailwind 间距类名 → px（`gap-1.5` → 6、`px-2.5` → 10、`right-8` → 32） */
function tailwindPx(token) {
  const m = String(token).match(/^(-?\d+(?:\.\d+)?)$/);
  return m === null ? null : Number(m[1]) * 4;
}

/* ================================================================== *
 * ⓪ 解析守卫
 * ================================================================== */

const TS_NAMES = [
  ['MIN_BOX_W', overlaySrc],
  ['MIN_BOX_H', overlaySrc],
  // V60：日历不再是盒子，工作台宽度这个数搬到了 `DesktopWorkstation.tsx`。
  ['WORKSTATION_W', workstationSrc],
  ['BOX_HEADER_H', overlaySrc],
  ['BOX_BORDER_H', overlaySrc],
  ['STRIP_CELL_EXTRA_W', overlaySrc],
  ['STRIP_CELL_EXTRA_H', overlaySrc],
];
const RS_NAMES = [
  'ARRANGE_MARGIN',
  'ARRANGE_GAP_X',
  'ARRANGE_GAP_Y',
  'MIN_BOX_W',
  'MIN_BOX_H',
  'CALENDAR_BOX_W',
  'WST_BOX_W',
  'BOX_HEADER_H',
  'BOX_BORDER_H',
  'CELL_EXTRA_W',
  'CELL_EXTRA_H',
  'GRID_GAP',
  'GRID_PAD_X',
  'GRID_PAD_Y',
  'GRID_SCROLLBAR_W',
];
// V70：条目网格那条滚动条是**经典滚动条**（一直占位），CSS 里它的宽度必须与
// Rust `GRID_SCROLLBAR_W` 是同一个数 —— 否则「引擎按 N 列算」与「前端画出 N-1 列」
// 之间只差几像素，却会让格子内部提前出滚动条（V70 真机上 1px 的高度账就是这样被
// 放大成整整一列的）。
const CSS = 'src/index.css';
const cssSrc = fs.readFileSync(path.join(root, CSS), 'utf8');

/** 前端类名 / 结构（同样解析不到即 FAIL） */
const TS_CLASSES = [
  // V60：工作台是 `fixed bottom-8 right-8 top-8`（贴右侧一整列，不再只贴右下角）
  ['工作台固定定位', /fixed\s+bottom-(\d+)\s+right-(\d+)\s+top-(\d+)/, workstationSrc],
  // V59：收纳格高度改为严格绑定引擎值，内容区靠 `flex-1 min-h-0 overflow-y-auto` 滚动
  // （原先是 `grid max-h-[60vh] …`），所以这一条也跟着更新 —— 度量断言（gap / px / minmax）
  // 依旧是它后面的几行在管。
  ['收纳格条目网格类名', /"(grid min-h-0 flex-1 content-start[^"]*)"/, overlaySrc],
  ['条目网格 minmax', /minmax\(\$\{iconSize \+ (\d+)\}px/, overlaySrc],
  // V60：工作台的层级必须**低于**面板（铺满档面板横向盖住它那一列）
  ['工作台 z 层级', /'(z-\[\d+\])'/, workstationSrc],
];
const PANEL_CLASSES = [
  ['面板半屏档 right-[Npx]', /right-\[(\d+)px\]\s*\+?\s*w-\[min\(50vw/, panelSrc],
  ['面板外壳类名', /const box = '([^']*)';/, panelSrc],
];
// V70：`.grid-scroll` 那条滚动条的宽度（CSS）与 Rust 记账用的数必须同一个。
const CSS_CLASSES = [
  ['滚动条槽位恒留声明', /\.grid-scroll\s*\{([^}]*)\}/, cssSrc],
  ['滚动条宽度', /\.grid-scroll::-webkit-scrollbar\s*\{([^}]*)\}/, cssSrc],
];

const ts = {};
for (const [name, src] of TS_NAMES) {
  ts[name] = tsNumber(src, name);
  ok(`解析 TS 的 ${name}`, ts[name] !== null, '正则没匹配到 —— 改名/改格式后必须同步改本套件');
}
const rs = {};
for (const name of RS_NAMES) {
  rs[name] = rsNumber(rustSrc, name);
  ok(`解析 ${RUST} 的 ${name}`, rs[name] !== null, '正则没匹配到 —— 改名/改格式后必须同步改本套件');
}

const found = {};
for (const [label, re, src] of TS_CLASSES) {
  found[label] = src.match(re);
  ok(`解析「${label}」`, found[label] !== null, '正则没匹配到 —— 解析为空必须变红');
}
for (const [label, re, src] of PANEL_CLASSES) {
  found[label] = src.match(re);
  ok(`解析「${label}」`, found[label] !== null, '正则没匹配到 —— 解析为空必须变红');
}
for (const [label, re, src] of CSS_CLASSES) {
  found[label] = src.match(re);
  ok(`解析「${label}」`, found[label] !== null, '正则没匹配到 —— 解析为空必须变红');
}

if (fail > 0) {
  console.log('PASS %d / FAIL %d（解析守卫未通过，后面的数值比对没有意义）', pass, fail);
  for (const item of bad) {
    console.log('  ✗ ' + item);
  }
  process.exit(1);
}

/* ================================================================== *
 * ① 格子几何：两边必须逐字相等
 * ================================================================== */

const pairs = [
  ['最小宽度 MIN_BOX_W', ts.MIN_BOX_W, rs.MIN_BOX_W],
  ['最小高度 MIN_BOX_H', ts.MIN_BOX_H, rs.MIN_BOX_H],
  ['工作台宽度 WORKSTATION_W / WST_BOX_W', ts.WORKSTATION_W, rs.WST_BOX_W],
  ['标题栏高度 BOX_HEADER_H', ts.BOX_HEADER_H, rs.BOX_HEADER_H],
  ['边框高度 BOX_BORDER_H', ts.BOX_BORDER_H, rs.BOX_BORDER_H],
  ['竖条单元格宽 STRIP_CELL_EXTRA_W / CELL_EXTRA_W', ts.STRIP_CELL_EXTRA_W, rs.CELL_EXTRA_W],
  ['竖条单元格高 STRIP_CELL_EXTRA_H / CELL_EXTRA_H', ts.STRIP_CELL_EXTRA_H, rs.CELL_EXTRA_H],
];
for (const [label, a, b] of pairs) {
  ok(`${label} 前后端一致`, a === b, `前端 ${a} ≠ Rust ${b}`);
}

/* ================================================================== *
 * ② 右侧工作台浮窗（V60；V56 时它还是「右下角快捷入口格子」）
 * ================================================================== */

ok(
  '工作台宽度 ≥ 400（V62 用户：「工作台太小了 日历等都不清晰…最重要的工作台反而太小」）',
  rs.WST_BOX_W >= 400,
  `WST_BOX_W=${rs.WST_BOX_W} < 400 —— 日历会被压回 max-w 288 那个窄网格`,
);
ok(
  '工作台不比当年日历那一列更窄（它现在要装日历 + 快捷入口 + 操作按钮三段）',
  rs.WST_BOX_W >= rs.CALENDAR_BOX_W,
  `WST_BOX_W=${rs.WST_BOX_W} 比 CALENDAR_BOX_W=${rs.CALENDAR_BOX_W} 还窄`,
);
ok(
  '工作台占满整列高度（已无 DOCK_MAX_H 那类上限，高度由上下边距决定）',
  !/maxHeight/.test(workstationSrc),
  'V56 的快捷入口格子有 DOCK_MAX_H 封顶；工作台是「整列」，再有上限就会与右侧禁区对不上',
);
{
  // 固定定位（贴右侧一整列）必须与引擎的边距同一个数，否则「禁区」与实际画的对不上
  const m = found['工作台固定定位'];
  const bottom = tailwindPx(m[1]);
  const right = tailwindPx(m[2]);
  const top = tailwindPx(m[3]);
  ok('工作台 right-N == Rust ARRANGE_MARGIN', right === rs.ARRANGE_MARGIN,
    `right-${m[2]} = ${right}px ≠ ${rs.ARRANGE_MARGIN}`);
  ok('工作台 bottom-N == Rust ARRANGE_MARGIN', bottom === rs.ARRANGE_MARGIN,
    `bottom-${m[1]} = ${bottom}px ≠ ${rs.ARRANGE_MARGIN}`);
  ok('工作台 top-N == Rust ARRANGE_MARGIN（`workstation_rect` 上边距就是它）',
    top === rs.ARRANGE_MARGIN,
    `top-${m[3]} = ${top}px ≠ ${rs.ARRANGE_MARGIN}`);
}

/* ================================================================== *
 * ③ 右侧工具面板与工作台的关系
 * ================================================================== */

{
  const offset = Number(found['面板半屏档 right-[Npx]'][1]);
  ok(
    '半屏档面板让开了工作台（右边缘 + 一道缝）',
    offset >= ts.WORKSTATION_W + rs.ARRANGE_MARGIN,
    `right-[${offset}px] < WORKSTATION_W(${ts.WORKSTATION_W}) + ARRANGE_MARGIN(${rs.ARRANGE_MARGIN})`,
  );
  // ⚠️ 这一条是 V60 抓出来的真 bug：面板原本也是 `z-40`，与工作台同级。
  // 同级时谁在上只看 DOM 顺序，而工作台在 GridOverlay 里排在面板**之后** ——
  // 铺满档面板（`right-3 w-[calc(100vw-24px)]`，横向盖住工作台那一列）的右侧
  // （滚动条、关闭按钮所在）会被工作台压住，那一片点不动。
  const panelZ = Number(/(?:^|\s)z-(\d+)/.exec(found['面板外壳类名'][1])?.[1]);
  const wsZ = Number(/z-\[(\d+)\]/.exec(found['工作台 z 层级'][1])[1]);
  ok('能解析出面板与工作台的 z 值',
    Number.isFinite(panelZ) && Number.isFinite(wsZ),
    `面板 z-${panelZ} / 工作台 z-[${wsZ}]`);
  ok(
    '面板的 z 高于工作台（同 z 时 DOM 顺序会替工作台抢到上层）',
    panelZ > wsZ,
    `面板 z-${panelZ} 必须 > 工作台 z-[${wsZ}]`,
  );
  ok(
    '工作台仍在盒子之上、菜单之下（阶梯：盒子 auto < 参考线 35 < 工作台 < 面板 < 菜单 50）',
    wsZ > 35 && wsZ < 50 && panelZ < 50,
    `工作台 z-[${wsZ}] / 面板 z-${panelZ}：工作台要盖住盒子（无 z），菜单要保持最上`,
  );
}

/* ================================================================== *
 * ④ 格子条目网格度量（前端类名 ↔ Rust 常量）
 * ================================================================== */

{
  const cls = found['收纳格条目网格类名'][1];
  const gap = cls.match(/\bgap-(\d+(?:\.\d+)?)/);
  const px = cls.match(/\bpx-(\d+(?:\.\d+)?)/);
  ok('收纳格条目网格有 gap-*', gap !== null, `类名：${cls}`);
  ok('收纳格条目网格有 px-*', px !== null, `类名：${cls}`);
  if (gap !== null) {
    ok('条目网格 gap == Rust GRID_GAP', tailwindPx(gap[1]) === rs.GRID_GAP,
      `前端 ${tailwindPx(gap[1])} ≠ ${rs.GRID_GAP}`);
  }
  if (px !== null) {
    ok('条目网格 px == Rust GRID_PAD_X', tailwindPx(px[1]) === rs.GRID_PAD_X,
      `前端 ${tailwindPx(px[1])} ≠ ${rs.GRID_PAD_X}`);
  }
  ok(
    '条目网格 minmax(iconSize + N) 的 N == Rust CELL_EXTRA_W',
    Number(found['条目网格 minmax'][1]) === rs.CELL_EXTRA_W,
    `前端 ${found['条目网格 minmax'][1]} ≠ ${rs.CELL_EXTRA_W}`,
  );
}

/* ================================================================== *
 * ⑤ 条目网格的滚动条槽位（V70）
 *
 * 不加 `scrollbar-gutter: stable` 时，滚动条**只在滚得动的时候**才占位 —— 于是
 * 「引擎算出来刚好排得下」的格子，前端一渲染就少了 4px ⇒ 少排一列 ⇒ 行数变多 ⇒
 * 反而真的滚起来了（正反馈）。V70 真机上 1px 的高度账就是这样被放大成整整一列：
 * 「文档」（18 项）引擎按 5 列 × 4 行算，前端画出 4 列 × 4 行，活活藏掉 2 个图标。
 * ================================================================== */

{
  const gutter = found['滚动条槽位恒留声明'][1];
  const bar = found['滚动条宽度'][1];
  ok(
    '滚动条槽位恒留（`scrollbar-gutter: stable`）—— 否则「有没有滚动条」会改变可排列数',
    /scrollbar-gutter:\s*stable/.test(gutter),
    `CSS 里现在是：${gutter.trim() || '(空)'}`,
  );
  const barW = Number(/width:\s*(\d+)px/.exec(bar)?.[1]);
  ok('能解析出滚动条宽度', Number.isFinite(barW), `CSS 里现在是：${bar.trim()}`);
  ok('滚动条宽度 == Rust GRID_SCROLLBAR_W', barW === rs.GRID_SCROLLBAR_W,
    `CSS ${barW}px ≠ Rust ${rs.GRID_SCROLLBAR_W} —— 引擎会把这一个槽位算漏/算多`);
  ok('Rust 真的把滚动条宽度算进了格子（不是摆设）',
    rs.GRID_SCROLLBAR_W > 0 &&
      /GRID_SCROLLBAR_W/.test(rustSrc.slice(rustSrc.indexOf('fn box_width_for_columns'))),
    `GRID_SCROLLBAR_W=${rs.GRID_SCROLLBAR_W}，且 box_width_for_columns 没用到它`);
}

/* ================================================================== *
 * 结果
 * ================================================================== */

console.log(`PASS ${pass} / FAIL ${fail}`);
if (bad.length > 0) {
  console.log('--- 失败明细 ---');
  for (const item of bad) {
    console.log('  ✗ ' + item);
  }
}
process.exit(fail === 0 ? 0 : 1);

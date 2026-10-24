/**
 * 「图标拖拽 = 指针拖拽，不是 HTML5 拖放」＋「盒子高度不许自己长」的回归守卫（V59 新增）。
 *
 * # 为什么必须锁
 *
 * 用户 09-21 三条反馈里，两条的根因都**不在能跑测试的那一层**：
 *
 *   ① 「图标还是不能自己拖动，拖动就显示禁用图标」——
 *      根因在 wry（`wry-0.55.1/src/webview2/drag_drop.rs`）：
 *      `DragEnter` 只在载荷含 `CF_HDROP`（真实文件）时才写 `*pdwEffect`，否则
 *      **直接 return 不写**；而 `DragOver` 每次都把初始化值 `DROPEFFECT_NONE` 回填。
 *      于是 DOM 元素的 HTML5 拖放在这个窗口里**永远被系统判成「不可放置」**：
 *      光标画成禁止符号、`drop` 不派发。V43–V58 加的五层兜底（`effectAllowed`、
 *      `types`、`ref`、无条件 `preventDefault`…）全部无效，因为改的不是那一层。
 *      现在的口径是**指针拖拽**，这条守卫就是防止有人再退回去用 HTML5 拖放。
 *
 *   ② 「高度方向还是有点重叠」＋「列表展开装不下了应该自动出滚动条」——
 *      同一个根因：`height: isWidget ? box.height : undefined` 让**收纳格高度是 auto**，
 *      引擎按「条目数 ÷ 每行列数」估算的几何被前端渲染成另一个高度 ⇒ 盒子长出去压住
 *      下一个格子；而且盒子自己长高了，内容区的 `overflow-y-auto` 没有可滚余量 ⇒
 *      永远不出滚动条；更隐蔽的是 flex 子项默认 `min-height: auto`，
 *      少了 `min-h-0` 它根本不会被压缩。
 *
 * 这三条都**编译通过、类型正确、单测全绿**，只能靠源码断言守住。
 *
 *   ③ 「桌面可以滚轮上下移动了……只有光标在图标或格子上才可以移动」——
 *      这是 ① ② 改完之后**自己制造的回归**：为了排查「装不下不出滚动条」，把根画布从
 *      `overflow-hidden` 改成了 `overflow-y-auto grid-scroll`。根画布是 `fixed inset-0`，
 *      格子 / 竖条都是它的绝对定位子元素 —— 绝对定位元素会把溢出算进包含块的可滚动溢出区，
 *      于是**任何**一处子元素比视口高出十几像素，整层就变成可滚的。
 *      空白处 `pointerEvents: 'none'`（事件穿透到桌面，滚不动）、图标 / 格子上恢复了指针
 *      事件（滚轮冒泡到根画布 → 整个桌面跟着跑），用户看到的正是「只在图标或格子上能滚」。
 *
 * **解析不到即 FAIL**（不是跳过）：正则没匹配上时必须变红，否则本套件会静默退化成
 * 「永远 PASS」，比没有它更糟（CONVENTIONS「审计脚本解析为空即 FAIL」）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const OVERLAY = 'src/modules/desktop-grid/GridOverlay.tsx';
const RUST_CMD = 'src-tauri/src/commands/grid.rs';

let pass = 0;
let fail = 0;
const bad = [];

function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    bad.push(extra ? `${name} —— ${extra}` : name);
  }
}

/** 读文件；读不到直接记 FAIL 并把内容当空串，后续断言会连带暴露。 */
function read(rel) {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch (err) {
    ok(`能读到 ${rel}`, false, String(err.message));
    return '';
  }
}

const overlay = read(OVERLAY);
const rustCmd = read(RUST_CMD);
// V60：工作台（日历 + 快捷入口 + 操作按钮）从 GridOverlay 里抽成了一个组件，
// 于是「滚动容器必须带 min-h-0」这条纪律的适用面也跟着多了一个文件 —— 见 ⑦。
const WORKSTATION = 'src/modules/desktop-grid/DesktopWorkstation.tsx';
const workstation = read(WORKSTATION);
const MIGRATIONS = 'src-tauri/src/db/migrations.rs';
const migrations = read(MIGRATIONS);
const LIB_RS = 'src-tauri/src/lib.rs';
const libRs = read(LIB_RS);
// V61：日历（`CalendarWidget`）的唯一宿主现在是工作台，它的外壳观感属于「工作台整体感」
// 的一部分 —— 见 ⑫ 的最后两条。
const WIDGETS = 'src/modules/desktop-grid/DesktopWidgets.tsx';
const widgets = read(WIDGETS);
// V79：托盘的「桌面整理：显示/隐藏」以前是**唯一**会广播 `grid:visibility` 的地方，
// 于是其余改真源的路径全成了「只改库、不改界面」—— 见 ⑮。
const TRAY_RS = 'src-tauri/src/tray.rs';
const trayRs = read(TRAY_RS);
// V80：日历可以跳到任意年份了（用户要回 1988 年记生日），而农历年表只有 1900–2100
// 这一份 —— 年份上下限必须是**从年表导出**的那一份，见 ⑯。
const LUNAR = 'src/lib/lunar.ts';
const lunar = read(LUNAR);
// V81：系统菜单期间要把桌面「暂时还给系统」—— 借出去的那段时间里，
// 接管自愈（看到原生图标露着就藏）必须让路，见 ⑰。
const HANDOFF_RS = 'src-tauri/src/platform/desktop_handoff.rs';
const handoffRs = read(HANDOFF_RS);
// V83：窗口几何**不再持久化** —— 前端那条「moved / resized 写库」的路径和 ipc 里的
// 两个命令一起删掉了。要断「不许有」，得连 ipc 层一起看，见 ⑩。
const IPC_TS = 'src/lib/ipc.ts';
const ipcTs = read(IPC_TS);

/**
 * 把注释剥掉后再断「不许有」——本文件里有一大段解释**为什么**删掉那些东西的注释，
 * 里面必然出现 `effectAllowed`、`max-h-[60vh]` 这些字面量。不剥注释，「不许有」的断言
 * 会被自己的说明书判红（这一版第一跑就是被自己绊倒的）；而「必须有」的断言用原文即可。
 *
 * 只剥 `/* … *​/` 与**整行** `//`：够用，且不会误伤 `'https://…'` 这类字符串里的 `//`。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^[ \t]*\/\/.*$/gm, ' ');
}

const overlayCode = stripComments(overlay);
const rustCmdCode = stripComments(rustCmd);
const workstationCode = stripComments(workstation);
const widgetsCode = stripComments(widgets);
const trayCode = stripComments(trayRs);
const lunarCode = stripComments(lunar);
const handoffCode = stripComments(handoffRs);
const ipcCode = stripComments(ipcTs);

/** 数一下源码里出现次数 */
function count(src, re) {
  return (src.match(re) ?? []).length;
}

/* ================================================================== *
 * ① 内部拖拽必须是**指针**拖拽：不许再出现 HTML5 拖放的实操痕迹
 * ================================================================== */

ok('GridOverlay 里已无 dataTransfer.setData（HTML5 拖拽载荷）',
  count(overlayCode, /dataTransfer\.setData/g) === 0);
ok('GridOverlay 里已无 dataTransfer.getData',
  count(overlayCode, /dataTransfer\.getData/g) === 0);
ok('GridOverlay 里已无 effectAllowed（V43 那个「兼容 Dock 的 copy」补丁）',
  count(overlayCode, /effectAllowed/g) === 0,
  '它在 wry 的 DROPEFFECT_NONE 面前毫无作用 —— 见文件头说明');
ok('GridOverlay 里已无 dropEffect',
  count(overlayCode, /dropEffect/g) === 0);
for (const attr of ['onDragStart', 'onDragOver', 'onDragLeave', 'onDragEnd', 'onDrop']) {
  ok(`GridOverlay 里已无 JSX 属性 ${attr}`,
    count(overlayCode, new RegExp(`\\b${attr}=`, 'g')) === 0);
}

/* ================================================================== *
 * ② 指针拖拽的关键件都在
 * ================================================================== */

ok('定义了拖拽阈值 DRAG_THRESHOLD', /const DRAG_THRESHOLD = \d+;/.test(overlay));
ok('有拖拽会话类型 DragSession', /interface DragSession/.test(overlay));
ok('有拖拽会话 ref', /const dragSessionRef = useRef<DragSession \| null>\(null\)/.test(overlay));
ok('有拖拽预览 ref', /const dragGhostRef = useRef<HTMLDivElement \| null>\(null\)/.test(overlay));
ok('有 beginDragSession / beginItemDrag / beginLooseDrag / resetDragVisuals 四个入口',
  ['beginDragSession', 'beginItemDrag', 'beginLooseDrag', 'resetDragVisuals']
    .every((name) => new RegExp(`const ${name} = useCallback\\(`).test(overlay)));
ok('主循环挂了 window mousemove', /window\.addEventListener\('mousemove', onMove\)/.test(overlay));
ok('主循环挂了 window mouseup', /window\.addEventListener\('mouseup', onUp\)/.test(overlay));
ok('拖拽中可按 Esc 取消（V86：没在拖拽时 Esc 清除选中）',
  /event\.key === 'Escape'/.test(overlay)
  && /dragSessionRef\.current\.cancelled = true;/.test(overlay)
  && /} else if \(selectedPathsRef\.current\.size > 0\) \{/.test(overlay));
ok('指针移出窗口要作废会话（否则永久卡在拖拽态）',
  /document\.documentElement\.addEventListener\('mouseleave', onAbort\)/.test(overlay));
ok('卸载时把四个监听都摘掉', count(overlay, /removeEventListener\(/g) >= 4);

/* ================================================================== *
 * ③ 阈值：没过阈值 = 普通单击 / 双击，什么都不做
 *    （条目上挂着「双击打开文件」，被拖拽抢掉就变成「点不开」）
 * ================================================================== */

ok('用位移阈值判定「真的在拖了吗」',
  /if \(moved < DRAG_THRESHOLD\) \{\s*return;/.test(overlay),
  '正则没匹配到：阈值判据被改过，请人工确认双击还能用');
ok('没过阈值 / 按过 Esc 一律不落点（V86：没取消的单击转为「选择点击」）',
  /if \(!active \|\| cancelled\) \{[\s\S]{0,260}?applySelectionClick\(/.test(overlay));
ok('条目 onMouseDown 里先 stopPropagation 再 beginItemDrag',
  /event\.stopPropagation\(\);\s*\/\/[\s\S]{0,200}?beginItemDrag\(item, event\);/.test(overlay)
  || /beginItemDrag\(item, event\)/.test(overlay));
ok('竖条条目 onMouseDown 里也走 beginLooseDrag',
  /beginLooseDrag\(entry, event\)/.test(overlay));

/* ================================================================== *
 * ④ 落点判定：入口优先于格子，判定函数复用同一套（不另起一套坐标换算）
 * ================================================================== */

ok('落点用 hitDock 判快捷入口', /hitDock\(event\.clientX, event\.clientY\)/.test(overlay));
ok('落点用 hitBoxId 判格子', /hitBoxId\(event\.clientX, event\.clientY\)/.test(overlay));
ok('拖到入口 = 收藏成快捷方式（V86 多选：按 batch 整批走）',
  /for \(const path of batch\) \{\s*addDockLink\(nameOf\(path\), path\);/.test(overlay));
ok('拖出所有格子 = 移出格子（V86 多选：按 batch 整批走）',
  /if \(boxId === null\) \{\s*for \(const path of batch\) \{\s*const it = itemByPath\(path\);\s*if \(it !== null\) \{\s*removeItem\(it\);/.test(overlay));
ok('拖进格子 = 改引用归属（V86 多选：按 batch 整批走）',
  /moveItem\(\{ item: it, itemId: it\.id, fromBoxId: it\.boxId \}, boxId\);/.test(overlay));
ok('V86 多选：拖的若是已选中的一项，整个选中集合一起走',
  /sel\.has\(session\.item\.filePath\) && sel\.size > 1/.test(overlay));

/* ================================================================== *
 * ⑤ 不许关掉 Tauri 的原生拖放（关了它，真实文件就再也拿不到路径）
 *    只是**不许在窗口构建里显式关闭**；注释里提它是允许的
 * ================================================================== */

ok('挂件窗构建里没有 `.drag_drop_enabled(` 调用',
  count(rustCmdCode, /\.drag_drop_enabled\(/g) === 0,
  '关掉它 = 从资源管理器拖文件进格子拿不到真实路径；内部拖拽改指针就是为了两全');
ok('grid.rs 里说明了为什么不能关（留痕，防下次又有人「顺手修一下」）',
  /不要给这个窗口设 `drag_drop_enabled\(false\)`/.test(rustCmd));

/* ================================================================== *
 * ⑥ 盒子高度必须绑定引擎值 —— 否则又会出现「压住下面那个格子」
 * ================================================================== */

ok('section 高度绑引擎值 height: box.height', /height: box\.height,/.test(overlayCode));
ok('已删掉 `isWidget ? box.height : undefined` 这条 auto 高度分支',
  !/isWidget \? box\.height : undefined/.test(overlayCode),
  '收纳格 auto 高度 = 渲染几何与引擎几何不一致 = 重叠');
ok('已删掉 `maxHeight: isWidget ? … : …` 这条只给挂件的上限',
  !/maxHeight: isWidget/.test(overlayCode),
  '再压一层上限同样会让渲染高度小于引擎高度');
ok('盒子 section 上不再有 maxHeight 内联样式',
  count(overlayCode, /maxHeight: `\$\{Math\.round\(window\.innerHeight/g) === 0);

/* ================================================================== *
 * ⑦ 内容区必须能滚：flex-1 + min-h-0 + overflow-y-auto，三件缺一不可
 * ================================================================== */

ok('收纳格内容区带 min-h-0 flex-1 overflow-y-auto（列表视图）',
  /flex min-h-0 flex-1 flex-col gap-0\.5 overflow-y-auto/.test(overlayCode));
ok('收纳格内容区带 min-h-0 flex-1 overflow-y-auto（网格视图）',
  /grid min-h-0 flex-1 content-start gap-1\.5 overflow-y-auto/.test(overlayCode));
ok('便签内容区也带 min-h-0 flex-1 overflow-y-auto',
  count(overlayCode, /className="min-h-0 flex-1 overflow-y-auto grid-scroll"/g) >= 1,
  'V60 起日历不再是盒子，便签这一条路仍要能滚');
ok('工作台的内容区也带 min-h-0 flex-1 overflow-y-auto（日历 + 快捷入口装不下时在它里面滚）',
  // 间距值会随排版微调（V60 是 gap-2、V61 是 gap-2.5）—— 这里只锁「这条纪律在不在」，
  // 不锁具体数值：真正的尺寸约束由 `test-desktop-constants.mjs` 管。
  /className="flex min-h-0 flex-1 flex-col gap-[\d.]+ overflow-y-auto p-2 grid-scroll"/.test(workstationCode),
  '少了 min-h-0，flex 子项的 min-height:auto 会把标题栏 / 按钮条顶出屏幕');
ok('收纳格内容区已去掉 max-h-[60vh]（高度上限由盒子本身给）',
  !/max-h-\[60vh\]/.test(overlayCode));
ok('左下「未归类」竖条自己滚（列数撞 4 列上限时，内容天然高于引擎给的区域）',
  /"absolute grid content-start gap-1\.5 overflow-y-auto grid-scroll"/.test(overlayCode),
  '少了它，多出来的行会溢出竖条、被根画布的可滚动溢出区收走 → 整个桌面又能滚了');
{
  // 扫描**每个**桌面层文件里所有「滚动的类名字符串」，除了白名单里的，都必须带 `min-h-0`。
  //
  // 白名单里那一条是左侧「未归类」竖条：绝对定位 + 引擎给定的 `height`（定高），
  // 不靠 flex 压缩，所以不需要 min-h-0。
  //
  // ⚠️ 判据是「漏掉的**恰好等于**白名单」，不是数个数 —— 数个数那种写法一有人
  // 合理地新增/删除一个滚动容器就会误报（V60 就撞上了：工作台的内容区从 GridOverlay
  // 搬进 DesktopWorkstation，GridOverlay 那份白名单里的快捷入口条目当场过期）。
  // 集合相等这个判据同时挡住了两边：新增了没带 min-h-0 的容器 → 漏掉的变多 → 红；
  // 白名单里的东西被改好或删掉了 → 漏掉的变少 → 也红（顺手删掉白名单项）。
  // V63：白名单从「一条」扩成「一组」—— 判据没变（**绝对定位 + 定高**，不靠 flex
  // 压缩，所以不需要 min-h-0），只是符合这条的容器多了一个。
  const ABSOLUTE_SCROLLERS = new Set([
    // 左侧「未归类」竖条：绝对定位 + 引擎给定的 `height`
    '"absolute grid content-start gap-1.5 overflow-y-auto grid-scroll"',
    // V63 收纳区滚动容器：绝对定位 + `top-0 bottom-0`（统一网格放不下时在这里滚）。
    // 高度由上下 inset 定死，加 min-h-0 只是个无害的摆设，不如进白名单说清楚。
    '"absolute left-0 top-0 bottom-0 overflow-y-auto overflow-x-hidden"',
  ]);
  const files = [
    ['GridOverlay.tsx', overlayCode],
    ['DesktopWorkstation.tsx', workstationCode],
  ];
  const leaked = [];
  let withMin = 0;
  for (const [name, code] of files) {
    const scrollers = code.match(/"(?:[^"\\]|\\.)*overflow-y-auto(?:[^"\\]|\\.)*"/g) ?? [];
    for (const cls of scrollers) {
      if (cls.includes('min-h-0')) {
        withMin += 1;
      } else if (!ABSOLUTE_SCROLLERS.has(cls)) {
        leaked.push(`${name}: ${cls}`);
      }
    }
  }
  ok('盒内 / 工作台里漏掉 min-h-0 的滚动容器恰好只有白名单那几条（都是绝对定位定高）',
    leaked.length === 0,
    `多出来 ${leaked.length} 处：${leaked.join(' | ')}`);
  ok('白名单没过期：「未归类」竖条仍在，且仍是那几条不带 min-h-0 的滚动容器之一',
    count(overlayCode, /"absolute grid content-start gap-1\.5 overflow-y-auto grid-scroll"/g) === 1,
    '竖条被改写成带 min-h-0 或删掉了 → 请同步删掉 ABSOLUTE_SCROLLERS 里的对应项');
  ok('带 min-h-0 的滚动容器总数没掉（盒子两种视图 + 便签 + 工作台）',
    withMin >= 4,
    `只有 ${withMin} 个 —— 有人的 min-h-0 掉了，或滚动容器被删了`);
}

/* ================================================================== *
 * ⑧ 桌面根画布**不许**是滚动容器
 *
 * 用户 09-21：「桌面可以滚轮上下移动了……只有鼠标移动到图标或者格子上才可以移动，
 * 在桌面空白的地方不能移动」。根画布 `fixed inset-0` + `overflow-y-auto` ⇒ 只要有任何
 * 绝对定位子元素（格子 / 竖条）比视口高出十几像素，整层就变成可滚容器 ⇒ 滚轮一动
 * 整个桌面跟着跑。空白处因为 `pointerEvents:'none'` 才「恰好正常」，极具迷惑性。
 * ================================================================== */

ok('根画布是 overflow-hidden（整层滚动 = 滚轮一动整个桌面跟着跑）',
  /className="fixed inset-0 select-none overflow-hidden"/.test(overlayCode),
  'V59 曾把它改成 `overflow-y-auto grid-scroll` —— 桌面层永远不该能滚');
ok('根画布上不再挂 grid-scroll',
  !/"fixed inset-0 select-none[^"]*grid-scroll"/.test(overlayCode),
  '它是整层画布，不是滚动区；滚动条样式只属于盒内 / 竖条 / 入口');
ok('根画布的次数是 1（别处不要冒出第二个全屏层）',
  count(overlayCode, /className="fixed inset-0 select-none/g) === 1);

/* ================================================================== *
 * ⑨ 右键菜单必须视口锚定（`fixed`），不许再退回 `absolute`
 *
 * 四处菜单（格子 / 条目 / 竖条 / 快捷条）的坐标全部直接取自 `event.clientX / clientY`
 * —— 那是**视口**坐标。根画布带 `overflow-hidden`（见 ⑧），`absolute` 子元素会被它裁剪，
 * 在屏幕靠下 / 靠右的位置右键就会看到菜单被切掉半截；`fixed` 的包含块是视口，不受影响。
 * V53 的桌面菜单一直是 `fixed`，两边原本就不一致。
 * ================================================================== */

ok('没有 `absolute z-50` 的菜单外壳了（全部视口锚定）',
  count(overlayCode, /\babsolute z-50\b/g) === 0,
  '菜单坐标是 clientX/clientY —— absolute 会被根画布的 overflow-hidden 裁掉半截');
ok('菜单外壳确实是 fixed z-50（改完别改丢）',
  count(overlayCode, /\bfixed z-50\b/g) >= 3,
  `期望格子/条目/竖条/快捷条/桌面几处都是 fixed z-50，实际只有 ${count(overlayCode, /\bfixed z-50\b/g)} 处`);

/* ================================================================== *
 * ⑩ 视图模式要持久化（原本是纯内存态，重启就悄悄变回网格）
 * ================================================================== */

ok('定义了视图模式的 localStorage 键',
  /const BOX_VIEW_MODES_KEY = 'handy:grid\.box-view-modes';/.test(overlay));
ok('视图模式启动时从 localStorage 恢复',
  /localStorage\.getItem\(BOX_VIEW_MODES_KEY\)/.test(overlay));
ok('视图模式切换后写回 localStorage',
  /localStorage\.setItem\(BOX_VIEW_MODES_KEY, JSON\.stringify\(next\)\)/.test(overlay));

/* ================================================================== *
 * ⑪ 工作台（V60）：日历 + 快捷入口 + 操作按钮是**一个常驻浮窗**
 *
 * 用户 09-21（附腾讯桌面整理截图）：「日历可以修改为工作台，把快捷入口这些都可以整合到
 * 工作台里面，整合成一个整体的模块，现在还缺少添加便签的按钮 还有整理 关闭整理等，
 * 工作台这个可以常驻，不跟桌面整理一起退出等」
 *
 * 这一段的每一条都对应一个「编译通过、类型正确、单测全绿」的翻车方式：
 *   · 工作台被 `contentHidden` 门控 → 「退出桌面整理」把唯一的入口一起收走了；
 *   · 前端宽度与 Rust 禁区宽度不一致 → 格子压在工作台上，或右边白留一条缝；
 *   · Rust 发一个动作、前端没人接 → 用户点了右键菜单什么都没发生（假按钮）；
 *   · 历史遗留的日历盒子数据没人清 → 升级后桌面上多出一个几何算不出来位置的盒子。
 * ================================================================== */

{
  // —— ① 常驻：渲染不能被 contentHidden 门控 ——
  const wsIdx = overlayCode.indexOf('<DesktopWorkstation');
  ok('GridOverlay 里渲染了工作台', wsIdx > 0);
  ok('工作台的渲染没有被 contentHidden 门控（退出整理时它必须还在）',
    wsIdx > 0 &&
      !/contentHidden\s*(?:&&|\?)/.test(overlayCode.slice(Math.max(0, wsIdx - 300), wsIdx)),
    '「退出桌面整理」只该收起格子与竖条；工作台一起没了，用户就没有再打开整理的入口');
  ok('工作台把 contentHidden 当**显示状态**传进去（只用来翻转按钮文案 / 图标）',
    /hidden=\{contentHidden\}/.test(overlayCode));
  ok('工作台组件本身不会因 hidden 而整块消失（hidden 只换图标与文案）',
    !/\bhidden\s*\?\s*null/.test(workstationCode),
    'hidden ? null : … 会让「已退出整理」时工作台整个消失，与「常驻」直接冲突');
  ok('工作台只有『收起』一种折叠（collapsed ? null : …）',
    count(workstationCode, /\?\s*null\s*:\s*\(/g) === 1);

  // —— ② 操作按钮：用户点名缺的四件事必须都在 ——
  for (const [name, prop] of [
    ['便签', 'onAddNote'],
    ['格子', 'onAddBox'],
    ['整理', 'onArrange'],
    ['退出整理', 'onToggleOverlay'],
  ]) {
    ok(`工作台底栏有「${name}」按钮（绑到 ${prop}）`,
      new RegExp(`${prop}=\\{`).test(overlayCode) && new RegExp(`${prop}:`).test(workstationCode));
  }

  // —— ③ 几何必须跨语言一致：前端浮窗宽 == Rust 禁区宽 ——
  //
  // V62：宽度源从 `CALENDAR_BOX_W` 换成了 `WST_BOX_W`。工作台不再是「当年日历那一列」
  // —— 它要装日历 + 快捷入口 + 操作按钮三段，用户 09-21「工作台太小了 日历等都不清晰」
  // 之后加宽到 400，与 `CALENDAR_BOX_W`（日历本体的自然宽度，320）**解耦**。
  const frontW = /export const WORKSTATION_W = (\d+);/.exec(workstation)?.[1];
  const rustW = /const WST_BOX_W: i64 = (\d+);/.exec(rustCmdCode)?.[1];
  const calendarW = /const CALENDAR_BOX_W: i64 = (\d+);/.exec(rustCmdCode)?.[1];
  ok('能解析出前端工作台宽度 WORKSTATION_W',
    frontW !== undefined, '正则没匹配到：常量被改名了，请同步本守卫');
  ok('能解析出 Rust 工作台禁区宽度（WST_BOX_W）',
    rustW !== undefined, '正则没匹配到：常量被改名了，请同步本守卫');
  ok('前端工作台宽度 == Rust 禁区宽度（差 1 像素就压住或留缝）',
    frontW !== undefined && frontW === rustW,
    `前端 ${frontW} vs Rust ${rustW}`);
  ok('Rust 工作台宽度 ≥ 当年日历那一列（V62：它现在要装三段内容，只能更宽）',
    rustW !== undefined && calendarW !== undefined && Number(rustW) >= Number(calendarW),
    `WST_BOX_W=${rustW} < CALENDAR_BOX_W=${calendarW}`);
  ok('工作台外壳的边距用满 Rust 的 ARRANGE_MARGIN（32px = Tailwind 的 8 档）',
    /const ARRANGE_MARGIN: i64 = 32;/.test(rustCmdCode) &&
      /fixed bottom-8 right-8 top-8 flex flex-col overflow-hidden/.test(workstationCode),
    'Rust `workstation_rect` 的上下右边距就是它，错一个档位就会与禁区对不上');
  ok('布局引擎确实把这一列当禁区（workstation_rect 存在且被 layout 用上）',
    /fn workstation_rect\(/.test(rustCmdCode) &&
      count(rustCmdCode, /workstation_rect\(/g) >= 2);

  // —— ④ Rust 发的动作，前端必须逐个接住（否则就是点不动的假按钮）——
  const dispatched = [...libRs.matchAll(/dispatch\(app, "([a-z-]+)"\)/g)].map((m) => m[1]).sort();
  const handled = [...overlayCode.matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]).sort();
  ok('能解析出 Rust 侧分发的桌面右键动作',
    dispatched.length > 0, '正则没匹配到：dispatch 调用被改名了，请同步本守卫');
  ok('Rust 分发的每个动作前端都处理了（动作集必须一致）',
    JSON.stringify(dispatched) === JSON.stringify(handled),
    `Rust 发 ${JSON.stringify(dispatched)}，前端接 ${JSON.stringify(handled)}`);

  // —— ⑤ 冷启动那条路的兜底 ——
  ok('Rust 侧把动作入队（冷启动时事件早于前端监听，必丢）',
    /static PENDING_ACTION: Mutex<Option<String>>/.test(rustCmdCode));
  ok('Rust 侧提供了取待办动作的命令',
    /pub async fn grid_take_pending_action\(/.test(rustCmdCode));
  ok('前端挂载时取一次待办 + 监听唤醒事件',
    /\.gridTakePendingAction\(\)/.test(overlayCode) &&
      /listen\('handy:\/\/desktop-action'/.test(overlayCode));

  // —— ⑥ 日历盒子：渲染分支已删、存量数据有迁移清 ——
  ok('GridOverlay 里已无日历盒子的渲染分支',
    !/kind === 'calendar'/.test(overlayCode),
    '日历已并进工作台；留着分支 = 又会出现一个布局算不出位置的盒子');
  ok('`isWidget` 只认便签（widget 列只放便签）',
    /const isWidget = box\.kind === 'note';/.test(overlayCode));
  ok('迁移 v11 会清掉历史遗留的日历盒子',
    /V11_GRID_DROP_CALENDAR/.test(migrations) && /\(11, V11_GRID_DROP_CALENDAR\)/.test(migrations),
    '不清的话老库升级后 `grid_boxes` 里还躺着 kind=calendar 的行');
}

/* ================================================================== *
 * ⑫ 工作台样式融合 + 「双击不被穿透打断」（V61）
 *
 * 用户 09-21（附截图）：「感觉工作台这块样式不够自然，一看那个快捷模块就是拼接上去的
 * 要融为几个整体，简单的文字按钮就可以 不用那么大的图标占空间，本来空间就不够，
 * 图标原有的行为都被覆盖了 例如我双击打开我的电脑 打开某个文件夹现在都做不到了
 * 双击没反应，右键打开居然切到 资源管理器了」
 *
 * 两件独立的事，分别对应下面 A / B：
 *   A. **观感**——快捷入口从「32px 图标 + 10px 标签」的方阵磁贴改成「12px 图标 + 文字」
 *      的胶囊；段与段之间不再画整条分隔线。方阵 + 横线正是「两块板子拼在一起」的来源。
 *   B. **双击**——`grid_set_interactive(false)` 曾让窗口**瞬间穿透**，而轮询线程的局部缓存
 *      `last_ignore` 看不见那次改动 ⇒ 下一拍算出「光标在命中区、该可交互」时与缓存相等
 *      ⇒ 判定「不用改」而跳过 `set` ⇒ 窗口**永久停在穿透态** ⇒ 第二次点击落到下层桌面，
 *      浏览器永远凑不齐 `dblclick`。这里把「谁改状态谁记账」钉死。
 *      （右键不受影响：`onContextMenu` 不经过 `beginDragSession`，没改过窗口状态。）
 * ================================================================== */

{
  // —— A. 胶囊化 ——
  ok('快捷入口用 DockChip（小图标 + 文字胶囊）',
    /function DockChip\(/.test(overlayCode) && !/function DockCell\(/.test(overlayCode));
  ok('DockChip 里不再有 32px 的磁贴图标底座',
    !/h-8 w-8 shrink-0 items-center justify-center rounded-lg/.test(overlayCode),
    '用户：「不用那么大的图标占空间，本来空间就不够」');
  ok('DockChip 的图标收到 h-3.5（14px 档）',
    /flex h-3\.5 w-3\.5 shrink-0 items-center justify-center/.test(overlayCode));
  ok('快捷入口改两列排布（原 3 列方阵）',
    count(overlayCode, /className="grid grid-cols-2 gap-1"/g) >= 2,
    '两处（快捷入口 / 我的快捷方式）都该是两列；少一处说明有人退回方阵了');
  ok('工作台底栏按钮是横向胶囊（原「上图标下文字」的竖排块）',
    /flex min-w-0 flex-1 items-center justify-center gap-1 rounded-lg/.test(workstationCode));
  // ⚠️ 两处都要查：`<section aria-label="快捷入口">` 本身在 DesktopWorkstation 里，
  //    别处若有人另起一段、自己加回 `border-t`，这条也要能发现。
  ok('段与段之间不再画整条分隔线（改由段头分组）',
    !/aria-label="快捷入口"\s+className="border-t/.test(workstationCode) &&
      !/aria-label="快捷入口"\s+className="border-t/.test(overlayCode),
    '一条横线把卡片切成两块，正是用户说的「拼接上去的」');
  ok('段头由工作台统一提供（两段共用同一套语言）',
    count(overlayCode, /<WorkstationSectionLabel/g) >= 2 &&
      /function SectionLabel\(/.test(workstationCode),
    '「快捷入口」与「我的快捷方式」必须都走它；各写各的就会各自漂移回「几块板子」');
  ok('「我的快捷方式」的文件图标跟着缩到 14px',
    /<FileIcon path=\{link\.value\} size=\{14\} \/>/.test(overlayCode));
  ok('日历（默认主题）的外壳只留一抹极淡暗调（不再自带深色底 + 描边）',
    /shell: 'bg-black\/\[0\.12\] text-neutral-100',/.test(widgetsCode),
    'V61 从 neutral-950/72 + ring 收到 0.18，V62 再压到 0.12（工作台加宽后日历是主角，'
    + '底越淡越像长在卡片上的一段）；自带底色 + ring 会在工作台里形成「卡片里贴卡片」');
  ok('六套浅色日历主题的外壳底面保留（浅底是主题的一部分，去掉就看不见字）',
    count(widgetsCode, /shell: 'bg-gradient-to-b from-\w+-\d+ to-\w+-\d+ text-\w+-\d+/g) === 6,
    'V61 只动了默认那套；这里顺手把「六套浅色」钉住，防止有人顺着改下去');
  // —— V62 立规、V66 按用户口径改名：底栏里「一次性动作」与「模式开关」不能长同一张脸 ——
  //
  // 用户 09-21：「开启整理和整理两个让人懵逼 可以有一个更好的方式体现 或者整理换个说法」；
  // 用户 09-22 又点名：「现在只有一个整理动作了，为什么不叫整理 还是归类不是很傻吗?」
  //
  // 于是口径定为：**一次性动作 = 「整理」**（底栏里唯一一颗含「整理」字样的按钮）；
  // **模式开关 = 「显示格子 / 收起格子」**（一格「整理」都不许出现）。
  // 两者只要都带「整理」，就退回那对让人懵逼的按钮。
  const barLabels = [
    ...workstationCode.matchAll(/(?<![-\w])label=(?:"([^"]*)"|\{[^}]*\})/g),
  ].flatMap((m) => (m[1] !== undefined ? [m[1]] : [...m[0].matchAll(/'([^']*)'/g)].map((s) => s[1])));
  const tidyButtons = barLabels.filter((l) => l.includes('整理'));
  ok('底栏只有一颗含「整理」的按钮，且模式开关叫「显示格子 / 收起格子」',
    tidyButtons.length === 1 &&
      tidyButtons[0] === '整理' &&
      barLabels.includes('显示格子') &&
      barLabels.includes('收起格子') &&
      !/label="归类"/.test(workstationCode) &&
      !/'开启整理'/.test(workstationCode) && !/'退出整理'/.test(workstationCode),
    `底栏按钮 = ${JSON.stringify(barLabels)}；「整理」只能出现一次（它就是那个一次性动作），`
      + '模式开关必须是「显示格子 / 收起格子」—— 都叫「整理」就是 09-21 那对让人懵逼的按钮');
  ok('模式开关用描边外观与动作按钮区分（ActionButton 的 variant）',
    /variant="toggle"/.test(workstationCode) && /variant\?: 'action' \| 'toggle'/.test(workstationCode));
  // —— V62：日历网格必须随工作台自适应（限宽会把它锁回 41px 的窄格） ——
  ok('日历网格不再有 max-w-[288px] 限宽（V62：随 400 宽的工作台自适应）',
    /<div className="mx-auto w-full">/.test(widgetsCode) &&
      !/max-w-\[288px\]/.test(widgetsCode),
    '限宽把日期格锁在 41px、字号压到 12px —— 正是用户「日历等都不清晰」的来源');

  // —— B. 双击：交互状态必须「谁改谁记账」 ——
  ok('grid_set_interactive 按「强制标志 + 当前光标命中」求值，而不是无脑跟随参数',
    /let want = interactive \|\| cursor_hit\(&win\);/.test(rustCmdCode),
    '无脑 `set_ignore_cursor_events(!interactive)` ⇒ 抬起鼠标那一刻窗口穿透 ⇒ 双击丢失');
  ok('源码里不再出现无脑按参数设穿透的写法',
    !/set_ignore_cursor_events\(!interactive\)/.test(rustCmdCode),
    '这是 V61 修掉的那个双击 bug 的原文');
  ok('穿透态的「上次施加值」放在共享原子里（轮询与命令路径同源）',
    /static POLLER_IGNORE: AtomicU8/.test(rustCmdCode));
  ok('轮询线程不再用局部 last_ignore 缓存',
    !/let mut last_ignore/.test(rustCmdCode),
    '局部缓存看不见 grid_set_interactive 的改动 ⇒ 判「不用改」而跳过 set ⇒ 永久穿透');
  ok('施加穿透态统一走 apply_ignore（带变化判据 + 记账）',
    /fn apply_ignore\(win: &WebviewWindow, ignore: bool\)/.test(rustCmdCode) &&
      count(rustCmdCode, /apply_ignore\(/g) >= 4);
  ok('「实际状态不可知」的两条路径走 force_ignore（先把缓存置为未知）',
    /fn force_ignore\(win: &WebviewWindow, ignore: bool\)/.test(rustCmdCode) &&
      count(rustCmdCode, /force_ignore\(/g) >= 3,
    '窗口创建 / 收起格子时窗口的实际穿透态已不可知，沿用旧缓存会让下一次判据失真');
  // ⚠️ 下面两条必须查**函数体内**而不是全文件：只把 `POLLER_IGNORE` 声明出来、
  //    却漏了写回那一步，全文件正则照样通过 —— 而那正是双击 bug 的机理。
  {
    const at = rustCmdCode.indexOf('pub async fn grid_set_interactive(');
    const body = at < 0 ? '' : rustCmdCode.slice(at, at + 900);
    ok('能定位 grid_set_interactive 的函数体',
      at >= 0, '正则没匹配到：函数被改名了，请同步本守卫');
    ok('grid_set_interactive 改完窗口状态会写回 POLLER_IGNORE（谁改谁记账）',
      /POLLER_IGNORE\.store\(/.test(body),
      '漏了它 ⇒ 命令路径改了窗口、轮询却以为没改 ⇒ 窗口永久穿透 ⇒ 双击丢失');
  }
  {
    const at = rustCmdCode.indexOf('fn force_ignore(');
    const body = at < 0 ? '' : rustCmdCode.slice(at, at + 400);
    ok('force_ignore 先把缓存置为未知，再施加',
      /IGNORE_UNKNOWN/.test(body) && /apply_ignore\(/.test(body));
  }
}

/* ================================================================== *
 * ⑬ 「桌面排满了就别再建格子」（V70）
 *
 * 用户 09-23：「格子太多后还是出现了滚动条，我建议**如果放不下了就提醒用户不能因为空间
 * 有限不能创建更多格子**，不然逻辑没法实现了」。
 *
 * 判据必须是**引擎自己说放不下**，而不是「数够 N 个格子」：格子的宽高由条目数算出来，
 * 同一个格数在不同内容下占的面积完全不同。所以实现是在一个立刻回滚的 `SAVEPOINT` 里
 * 真的插进去、真的排一遍，看 `LayoutOutcome::overflowed`。
 *
 * 这几条都在守「编译通过、类型正确、单测全绿」的翻车方式：
 *   · 试探被删 ⇒ 又回到「建出来一屏滚动条」；
 *   · 试探插的是另一条 SQL（`content` / `accent` 之类字段不同）⇒ 量出来的不是真货；
 *   · 忘了回滚 ⇒ 每次点「+ 格子」都在库里留一个幽灵格子；
 *   · 拒绝理由没写明「没建」并给出路 ⇒ 用户只看到一句报错，不知道该干什么。
 * ================================================================== */

{
  ok('Rust 里有「试探还有没有地方」的实现',
    /fn probe_room_for_another_box\(/.test(rustCmdCode),
    'V70 之后新建格子必须先量一次；删掉它 ⇒ 桌面又会出现整层滚动条');
  ok('新建格子的那条路径真的调用了试探',
    /if let Some\(reason\) = probe_room_for_another_box\(/.test(rustCmdCode),
    '有函数没调用 = 假守卫');
  {
    const at = rustCmdCode.indexOf('if let Some(reason) = probe_room_for_another_box(');
    const body = at < 0 ? '' : rustCmdCode.slice(at, at + 1200);
    ok('试探与随后的真插入共用同一条 SQL',
      /probe\.execute\(\s*INSERT_BOX_SQL,/.test(body),
      '试探插的是另一条语句 ⇒ 量出来的不是真正会落库的那一行');
    ok('拒绝时要记日志（便于事后查「为什么没建出来」）',
      /grid_log\(&format!\("新建格子被拒/.test(body));
  }
  ok('试探必须整条回滚（不许在库里留下幽灵格子）',
    /ROLLBACK TO \{SP\}; RELEASE \{SP\}/.test(rustCmdCode),
    '只插不回滚 ⇒ 每点一次「+ 格子」库里就多一条看不见的格子');
  ok('试探出错一律当成还装得下（宁可放行，也别把人挡在门外）',
    /Err\(_\) => None,/.test(rustCmdCode),
    '「量尺子」失败就拒绝 ⇒ 用户永远建不出格子');
  ok('拒绝的理由写明「没有新建」',
    /没有新建/.test(rustCmd),
    '用户 09-23 要的是「提醒 + 给出路」，不是一句莫名的报错');
  ok('拒绝的理由给出路（删一个格子 / 清掉一些图标）',
    /先删掉一个格子/.test(rustCmd) && /清掉一些/.test(rustCmd));
  // 前端：这句话有两行那么长，按固定 2.6 秒显示根本读不完
  ok('提示条按字数放宽显示时长（长提示读不完就没了）',
    /Math\.min\(9000, Math\.max\(HINT_DURATION_MS, message\.length \* 110\)\)/.test(overlayCode),
    'V70 的拒绝理由带行动指引，固定 2.6 秒不够读');
  {
    const hintCls = /className="(absolute left-1\/2 top-5[^"]*)"/.exec(overlay)?.[1] ?? '';
    ok('能解析出提示条的类名', hintCls !== '', '提示条被改写/搬走了，请同步本守卫');
    ok('提示条能换行（不再是单行胶囊）',
      hintCls.includes('max-w-[560px]') && hintCls.includes('leading-snug') &&
        !hintCls.includes('rounded-full'),
      `两行长的理由塞进单行胶囊会撑成一条，现在是：${hintCls}`);
  }
}

/* ================================================================== *
 * ⑭ 列数判据：两轴填充率取 min（V71 → V84）
 *
 * 用户 09-23（附截图）：「你看整体效果怎么还是补补丁一样的，三个图表最多的不应该 2 3 列
 * 上面开始平均放置，然后把零散的少量的格子补在下面即可哇，至于便签这个列前面的空间不够再放」
 * —— 钉下「一列空半截、另一列摞满」的解必须淘汰。
 *
 * 用户 09-29（附截图）：「搞成那么多列，却空了大量的空白，格子宽度反而压缩到文件名都
 * 看不清了」「这部分完全可以合并到一列里面」 —— V71 的「k 从大到小、能多铺一列就多铺
 * 一列」被推翻：真机 6 格 920×968 被排成 5 列、每列 ~176px。
 *
 * V84 定稿：`k = 1..=capacity` **从小到大**、每个 k 先自然宽度再夹宽，在全部装得下的
 * 候选里取 `min(横向填充率, 纵向填充率)` 最大者 —— 「补丁洞」（纵空）与「列多空白」
 * （横空）是同一个判据否掉的两个方向。行为判据在 Rust 侧
 * （`cargo test --lib`）：`the_biggest_boxes_share_the_top_row_instead_of_piling_up` /
 * `small_boxes_fill_in_below_the_big_ones` / `a_roomy_zone_keeps_natural_box_widths` /
 * `six_boxes_pack_into_wide_natural_columns_not_five_cramped_ones`。
 * mjs 这边只确认「这段结构还在」，防止重构时整块丢掉、而没人发现。
 * ================================================================== */

{
  const at = rustCmdCode.indexOf('fn pick_columns(');
  ok('Rust 里有挑列数的实现（pick_columns）',
    at >= 0,
    '函数被改名/搬走 ⇒ 下面两条断言会全部落空，必须同步本守卫');
  const body = at < 0 ? '' : rustCmdCode.slice(at, at + 2600);
  ok('列数循环里同时准备「自然宽度」与「夹到 zone_w/k」两套尺寸，且自然在前',
    /vec!\[\(natural_h\.to_vec\(\), natural_w\.to_vec\(\), false\)\][\s\S]{0,260}?trials\.push\(\(ch, cw, true\)\)/.test(body),
    '把「夹宽」挪出列数循环（或排到自然之前）⇒ 宽度一紧张就少开一列，布局又变成「补补丁一样」');
  ok('k 从小到大扫全部候选，并用两轴填充率的 min 挑最优（V84，不是 V71 的 k 从大到小）',
    body.indexOf('for k in 1..=capacity') >= 0 &&
      body.indexOf('for k in 1..=capacity') < body.indexOf('trials.push((ch, cw, true))') &&
      /\(used_w \* zone_h\)\.min\(tallest \* zone_w\)/.test(body),
    'V71 的「k 从大到小」会重新产出用户 09-29 截图里的 5 列窄格；丢掉 min 评分会退回「补丁洞」或「列多空白」二者之一');
}

/* ================================================================== *
 * ⑮ 挂件显隐：唯一真源 `overlay_visible`，**谁写谁广播**（V79）
 *
 * 用户 09-25（附截图，图上任务栏时钟 11:17）：
 *   「退出桌面整理也是格子一直都在桌面……整理没有退出」
 * `handy.log` 11:19:25 / 11:20:39 / 11:20:47 / 11:20:57 **连打四条 `收起挂件层`** ——
 * 库确实改了，界面却一直在，用户于是连点四次。
 *
 * 根因不是「忘了广播」这么简单，而是**广播只挂在一条路上**：
 * 前端的 `contentHidden` 只在挂载时查一次 `grid_overlay_status`，之后只认
 * `grid:visibility` 事件；而 V48–V78 期间只有 `tray.rs` 会发这个事件。
 * 于是凡是「不由前端发起」的显隐变化（桌面右键菜单 `--hide-grid` / `--show-grid`、
 * 轮询线程按偏好自动重建挂件层）全都只改库、不改界面。
 * 这与 V61 那条「一个跨线程可变状态只许一个记账人」是同一条纪律。
 *
 * 另一半是**冷启动的初值**：挂件窗 `show()` 之后 React 立刻按初值画了一屏格子，
 * 而此刻 `grid_overlay_status()` 还没回来 —— 后端明明决定了「只留工具栏」。
 * 初值必须是「收起」（fail-closed）：没问清楚之前绝不画格子。
 * ================================================================== */

{
  // —— ① Rust：三处写入真源的地方，后面都必须紧跟广播 ——
  const writesThenEmits = (value) =>
    new RegExp(
      `write_overlay_visible\\(app, ${value}\\)[\\s\\S]{0,240}?emit_visibility\\(app, ${value}\\)`,
    ).test(rustCmdCode);

  ok('show_overlay 写完真源后广播「已显示」',
    writesThenEmits('true'),
    '桌面右键「打开 Handy 桌面整理」走的这条路，不广播 ⇒ 前端不知道已经切到显示态');
  ok('hide_overlay_now 写完真源后广播「已收起」',
    writesThenEmits('false'),
    '桌面右键「退出桌面整理」走的正是这条路；用户实测连点四次都收不起来');
  ok('show_launcher_only 也广播「已收起」',
    /emit_visibility\(app, false\)[\s\S]{0,240}?grid_log\("显示桌面工具栏/.test(rustCmdCode),
    '启动期判定「未接管」时前端同样要收到收起态，否则会按初值摊开格子');

  // —— ② 广播只此一处：不许哪个模块再自己 emit 一份 ——
  ok('`grid:visibility` 的广播在整个 Rust 侧只有一处',
    count(rustCmdCode, /emit_to\(GRID_LABEL, "grid:visibility"/g) === 1,
    '散成两处正是这次 bug 的成因：改真源的地方不广播、广播的地方不改真源');
  ok('托盘不再自己发 `grid:visibility`（改由 grid 模块统一广播）',
    !/emit_to\([\s\S]{0,80}?"grid:visibility"/.test(trayCode),
    '托盘那条路的广播已下沉到 grid_overlay_show / hide，留在这里就是第二个记账人');

  // —— ③ 前端：初值 fail-closed + 先监听后查询 ——
  ok('`contentHidden` 初值是 true（没问清楚之前绝不画格子）',
    /const \[contentHidden, setContentHidden\] = useState\(true\)/.test(overlayCode),
    '初值 false ⇒ 冷启动必然先摊开一屏格子，且查询失败就永远停在摊开态');
  {
    const listenerAt = overlayCode.indexOf("listen('grid:visibility'");
    const statusAt = overlayCode.indexOf('gridOverlayStatus()');
    ok('先注册 `grid:visibility` 监听、再查 `grid_overlay_status`',
      listenerAt > 0 && statusAt > listenerAt,
      '反过来的话，查询在途时后端广播的那一次会丢 —— 界面停在初值，与后端长期不一致');
  }
}

/* ================================================================== *
 * ⑯ 日历：年份可直接指定 + 纪念日可增删（V80）
 *
 * 用户 09-25：「日历上不能选年呢？例如我想回到 1988 年我生日那天记录下我的生日
 * 或者我记录别人的生日等 或者特殊日期现在怎么没有添加了。」
 *
 * 两件事都不是「加个按钮」而已，各藏着一条会**静默退化**的陷阱：
 *
 *   ① **年份**：只有 ±1 月箭头时，2026 → 1988 是 456 次点击 —— 功能上等于没有。
 *      而一旦允许任意年份，就必然撞上农历年表的边界（`LUNAR_INFO` 只有 1900–2100）：
 *      越界后 `LUNAR_INFO[year - 1900]` 取到 `undefined`，农历列整片空白 ——
 *      **不报错、不崩溃**，只是「日历坏了」，最难查的那种。所以跳转必须夹范围。
 *      另一半是「翻页时选中日必须跟着走」：月份翻到 1988 年 6 月、下面「……的计划」
 *      却还停在出发那个月，用户以为在给 1988 年加计划，其实加到了今天。
 *
 *   ② **纪念日**：桌面日历以前只**读**设置里的 `anniversaries` 画蛋糕标记，能加的
 *      地方在工作台，用户根本找不到入口。加了写入又冒出第三个坑：写设置必须走
 *      `patchSettings`（read-modify-write）—— 直接 `writeSettings` 整份覆盖会把
 *      Rust 侧刚写进去的 `modules` 冲掉（`store.ts` 里明写着这条注意）。
 * ================================================================== */

{
  // —— ① 年份能直接指定，不是只能一月一月点 ——
  ok('日历有可键入的年份（yearDraft 受控 + 失焦即生效）',
    /const \[yearDraft, setYearDraft\] = useState/.test(widgetsCode) &&
      /onBlur=\{applyYearDraft\}/.test(widgetsCode),
    '只剩 ±1 月箭头 ⇒ 回到 1988 年要点 456 次，等于没有选年');
  ok('快选面板有 12 个月宫格（不是只做年份）',
    /const MONTHS = Array\.from\(\{ length: 12 \}/.test(widgetsCode) && /MONTHS\.map/.test(widgetsCode),
    '月份写死成 12 个 button 或干脆漏掉，都会让「回到 1988 年 6 月」走不通');

  {
    // ⚠️ 取**函数体内**（而不是全文件）：只 import 了常量、却没在跳转时用上它，
    //    全文件正则照样通过 —— 而越界的正是那一年。
    const at = widgetsCode.indexOf('const jumpTo = useCallback(');
    const body = at < 0 ? '' : widgetsCode.slice(at, at + 600);
    ok('跳转前把年份夹进农历年表范围（1900–2100）',
      body.includes('LUNAR_MIN_YEAR') && body.includes('LUNAR_MAX_YEAR'),
      '不夹 ⇒ 跳到 1899 时 LUNAR_INFO 取到 undefined，农历列整片空白且不报错');
    ok('跳转时「选中日」跟着走（否则计划清单与输入框还指着出发那个月）',
      /setSelected\(/.test(body),
      '月份翻走了、下面却还是别的月的计划 ⇒ 用户以为在给 1988 年加，其实加到了今天');
  }

  // —— ② 纪念日：能增删，且写盘走 patchSettings ——
  ok('纪念日可新增 / 可删除（两处写入，不是只读展示）',
    count(widgetsCode, /patchSettings\(\{ anniversaries:/g) >= 2,
    '桌面日历以前只画蛋糕标记不给入口 —— 用户 09-25「特殊日期现在怎么没有添加了」');
  ok('写设置走 patchSettings（read-modify-write），不许整份覆盖',
    count(widgetsCode, /writeSettings\(/g) === 0,
    'writeSettings 整份覆盖会把 Rust 侧刚写的 modules 冲掉');
  ok('点纪念日能跳到那一天（1988 年的生日要能回看）',
    /const gotoAnniversary = useCallback\(/.test(widgetsCode) &&
      /onClick=\{\(\) => gotoAnniversary\(item\)\}/.test(widgetsCode),
    '列表只能看不能跳 ⇒ 用户还得自己翻 456 次回到那天');

  // —— ③ 面板展开会改变高度：必须进「自然高度上报」的依赖 ——
  {
    // `rows.length,` 带逗号只出现在那个依赖数组里（`rows.length === 0` 没有逗号）
    const at = widgetsCode.indexOf('rows.length,');
    const deps = at < 0 ? '' : widgetsCode.slice(at, at + 400);
    ok('showPicker / showAnniversaries 进了高度上报的依赖',
      deps.includes('showPicker') && deps.includes('showAnniversaries'),
      '面板展开后盒子高度不变 ⇒ 计划区被顶出可视区，看着像「日历少了一截」');
  }
  ok('两个面板互斥（同时展开会把计划区顶出盒子）',
    /setShowAnniversaries\(false\)/.test(widgetsCode) && /setShowPicker\(false\)/.test(widgetsCode),
    '400px 宽的挂件装不下两块面板叠着开');

  // —— ④ 年份范围只有一个真源：农历年表 ——
  ok('农历年表导出年份范围常量（挂件从这里取，不另写一份）',
    /export const LUNAR_MIN_YEAR = 1900;/.test(lunarCode) &&
      /export const LUNAR_MAX_YEAR = 2100;/.test(lunarCode),
    '挂件里另写一份 1900/2100 ⇒ 哪天换了年表，两边立刻对不上');
}

/* ================================================================== *
 * ⑰ V81：系统菜单期间「把桌面暂时还给系统」
 *
 * 用户 09-27 原话：「在桌面右键新建文件夹非常慢而且也不能点击两下重命名操作……
 * 现在功能变成我创建了文本文件和文件夹完全没有生效了」。
 *
 * 根因不是菜单是假的（桌面空白处右键会**穿透**到系统桌面，弹的就是 Explorer 原生菜单），
 * 而是**接管态把 `SysListView32` 藏了**：新建的文件夹真的建了、原位改名编辑框真的开了，
 * 但都在那个隐藏的视图里 —— 用户看到的就是「什么都没发生」。
 *
 * 修法是「菜单期间把桌面借给系统」，于是冒出四条**新的不变量**，全是
 * 「编译通过、类型正确、单测全绿」也守不住的：
 *
 *   ① 借出期间「原生图标露着 / 挂件窗不可见」是我们自己造成的，接管自愈若照常纠正，
 *      会在 100ms 内把桌面抢回来 —— 与没修完全一样；
 *   ② 收回前必须复核「是否仍接管」：菜单里就有我们注入的「退出桌面整理」，
 *      用户点了它之后图标必须留着；
 *   ③ 菜单收起**不能立刻收回**：原生「新建」是菜单关闭之后才进原位改名的，
 *      早收回一步，编辑框就又藏回暗处；
 *   ④ 只认**桌面**的菜单：同一个 explorer.exe 里还开着资源管理器窗口，
 *      在它里面右键也要弹菜单，误判的代价是用户的格子莫名消失。
 * ================================================================== */

{
  // —— ① 借出期间，接管自愈必须让路 ——
  {
    const at = rustCmdCode.indexOf('fn reassert_takeover(app: &AppHandle) {');
    const body = at < 0 ? '' : rustCmdCode.slice(at, at + 400);
    ok('接管自愈在「桌面借给系统」期间让路',
      body.includes('handoff_active()') && body.includes('return;'),
      '不让路 ⇒ 刚还回去的桌面 100ms 内又被藏起来，用户新建的文件夹照样看不见');
  }
  {
    // 取 `hidden_ticks += 1;` 之前的那一小段：那里的自愈会把挂件窗 show 回来
    const at = rustCmdCode.indexOf('hidden_ticks += 1;');
    const before = at < 0 ? '' : rustCmdCode.slice(Math.max(0, at - 400), at);
    ok('挂件窗不可见的自愈在借出期间跳过（菜单期间它就是我们自己收的）',
      before.includes('handoff_active()') && before.includes('continue;'),
      '不跳过 ⇒ 这一层在菜单上头糊回来，刚还回去的原生桌面又被盖住');
  }

  // —— ② 收回前复核接管态 + 通知前端重扫 ——
  {
    const at = handoffCode.indexOf('fn end_handoff(app: &AppHandle) {');
    const body = at < 0 ? '' : handoffCode.slice(at, at + 800);
    ok('收回前复核「是否仍接管」（菜单里就有「退出桌面整理」）',
      body.includes('icons_taken()') && body.includes('SW_HIDE'),
      '不复核 ⇒ 用户点了「退出桌面整理」，图标又被藏回去，变成「点了没反应」');
    ok('收回后通知前端重扫桌面（新建的文件要马上出现在未归类里）',
      body.includes('grid:desktop-changed'),
      '不通知 ⇒ 文件建好了、用户却只看到「什么都没干」');
  }

  // —— ③ 菜单收起后还要等原位改名结束 ——
  {
    const at = handoffCode.indexOf('fn schedule_takeback() {');
    const body = at < 0 ? '' : handoffCode.slice(at, at + 1400);
    ok('菜单收起后等「原位改名」结束再收回',
      body.includes('label_editing()'),
      '不等 ⇒ 新建后刚弹出的改名编辑框被一起藏掉，用户还是改不了名');
    ok('收回前要求「安静满宽限」或「见过改名编辑框」（V84：编辑框比菜单晚几百毫秒才出现）',
      body.includes('HANDOFF_QUIET_GRACE') && body.includes('saw_edit'),
      '菜单一收就收回 ⇒ 编辑框还没出现桌面就被藏起来，用户看到「点了新建没反应」（09-29 三次反馈）');
    ok('借出有硬上限（事件不配对时挂件窗必须回来）',
      /const MAX_HANDOFF_SECS: u64 = \d+/.test(handoffCode) && body.includes('deadline'),
      '没有上限 ⇒ 挂件窗可能永远不回来，用户找不到入口（死路）');
  }

  // —— ③.1 编辑框借出（V86：Win11 新式菜单不是 #32768，认菜单会全程落空） ——
  //
  // 用户 09-30 原话：「创建一个文件夹 文本文档还是特别慢……除了第一次新建文件夹成功了，
  // 后面的新建都没有反应了」。这台机器是 Win11 25H2 且没恢复经典菜单：桌面背景右键
  // 弹的是**新式菜单宿主窗口**，`poll_menu` 里 `FindWindowW("#32768")` 永远落空
  // ⇒ 一条借出都没有 ⇒ 新建全部发生在隐藏视图里。
  // 修法是第三条路：**原位改名编辑框**（`SysListView32` 的 `Edit` 子窗）一出现就借出
  // —— 不管菜单长什么样，新建的终点都是这个编辑框，这是绕不过去的直接观测量。
  {
    const at = handoffCode.indexOf('pub fn poll_menu()');
    const body = at < 0 ? '' : handoffCode.slice(at, at + 1700);
    ok('V86：原位改名编辑框一出现就借出（不赌菜单窗口类名）',
      body.includes('label_editing()') && /begin_handoff\(\);\s*return;/.test(body),
      '删掉这条 ⇒ Win11 上新建文件夹又藏回隐藏视图 = 用户看到的「没反应 / 要手动刷新」');
  }

  // —— ④ 只认桌面的菜单，不误伤资源管理器窗口 ——
  ok('只认桌面的菜单（同进程 + 桌面宿主双重判据）',
    /GetWindowThreadProcessId\(hwnd/.test(handoffCode) && handoffCode.includes('Progman'),
    '只看同进程 ⇒ 在资源管理器窗口里右键也会触发，用户的格子会莫名其妙消失');

  // —— ⑤ 接线：接管时启动旁听；前端随之重扫 ——
  ok('接管显示时启动菜单旁听（没接管时原生视图本来就在，无需借还）',
    /desktop_handoff::ensure_watcher\(app\)/.test(rustCmdCode),
    '不启动 ⇒ 整套借还都不发生，等于没修');
  ok('前端监听 grid:desktop-changed 并立刻重扫桌面',
    /listen\('grid:desktop-changed'/.test(overlayCode),
    '不监听 ⇒ 新建的文件要等下一次周期对账才出现');
  ok('桌面空白右键不再调那条从来没成功过的 CLSID 复刻菜单',
    !overlayCode.includes('::{00021400-0000-0000-C000-000000000046}'),
    '那条路径几百条「拿不到 shell 对象：参数错误」；就算成功弹的也是用户反对的复刻菜单');

  /* ------------------------------------------------------------------
   * V82：借出机制在真机上**一次都没触发过**（用户 09-27 二次反馈）
   * ------------------------------------------------------------------
   * 日志里只有「旁听已启动」、一条借出记录都没有 ⇒ 事件参数没被认出来
   * （`EVENT_SYSTEM_MENUPOPUPSTART` 的 hwnd 实测给的是菜单窗 `#32768` 自己，
   * 而旧判据只看「就是桌面视图」和「顶层是 Progman/WorkerW」—— 双双落空）。
   * 下面这几条守的就是这次修正不被改回去。
   * ------------------------------------------------------------------ */

  // —— ⑥ 认菜单窗：先换 owner 再认 ——
  {
    const at = handoffCode.indexOf('unsafe fn is_desktop_menu(hwnd: HWND) -> bool {');
    const body = at < 0 ? '' : handoffCode.slice(at, at + 2600);
    ok('认桌面菜单时先换菜单窗（#32768）的 owner 再判',
      body.includes('"#32768"') && /GetWindow\(hwnd, GW_OWNER\)/.test(body),
      '不换 owner ⇒ 菜单窗的顶层就是它自己，两个旧判据双双落空（V81 实测就是这个后果）');
    ok('认桌面菜单时有「前台是不是别的应用」的兜底',
      body.includes('GetForegroundWindow'),
      '少了这条 ⇒ 用户在 Handy 挂件窗上点过之后前台就变了，桌面菜单也跟着认不出来');
    ok('认桌面菜单时会看「菜单压在谁身上」（前台不是桌面时也能认出来）',
      body.includes('window_under_menu(hwnd)') && handoffCode.includes('WindowFromPoint'),
      '只靠前台窗口 ⇒ 用户刚点过浏览器 / IDE 再回来右键桌面，前台仍是那个应用，'
      + '那一下右键又被静默判掉');
  }

  // —— ⑦ 事件之外再加一条直接观测量：菜单窗在不在 ——
  ok('有一条「直接问 #32768 在不在」的轮询兜底（不再把机制赌在事件参数语义上）',
    /pub fn poll_menu\(\)/.test(handoffCode) && handoffCode.includes('"#32768"'),
    '只信事件 ⇒ 事件语义一变整套机制就静默失效，正是 V81 的下场');
  ok('轮询兜底挂在保险循环里（每拍都问一次）',
    /desktop_handoff::poll_menu\(\)/.test(rustCmdCode),
    '不挂 ⇒ 那条兜底函数根本不会被调用，等于没写');

  // —— ⑧ 收回线程只能有一个 ——
  {
    const at = handoffCode.indexOf('fn schedule_takeback() {');
    const body = at < 0 ? '' : handoffCode.slice(at, at + 500);
    ok('「等改名结束」的收回线程有去重闸门',
      body.includes('TAKEBACK_PENDING') && body.includes('swap(true'),
      '不去重 ⇒ 轮询每 25ms spawn 一个线程，菜单收起后几百个线程同时抢着收回桌面');
  }

  // —— ⑨ 系统图标（此电脑 / 回收站）的右键也必须交回原生 ——
  {
    ok('系统入口（此电脑 / 回收站）的右键也走原生 Shell 菜单',
      !/!entry\.isSystem/.test(overlayCode)
        && /shellContextMenu\(entry\.path, event\.shiftKey\)/.test(overlayCode),
      '把系统图标排除在外 ⇒ 右键「此电脑」弹的是只有两行的复刻菜单'
      + '（用户 09-27 贴图报的正是这个：「我的电脑都变成这样了」）');
    ok('原生菜单拿不到时**才**回落到 Handy 自己的菜单（降级成兜底）',
      /shellContextMenu\(entry\.path, event\.shiftKey\)[\s\S]{0,420}setMenuLoose\(/.test(overlayCode),
      '原先是无条件回落 ⇒ 系统图标的右键永远到不了 Shell');
  }

  // —— ⑩ 窗口几何：只由**主显示器实时决定**，不再持久化（V83）——
  //
  // 用户 09-28 接了双显示器后，格子全挤在 1138×608 的角落里，屏幕右侧近 800px、
  // 下方 400 多 px 全空。根因是几何被持久化：前端挂载时读一次 `scaleFactor`，之后
  // 窗口 `moved` / `resized` 就用**过期 DPI** 换算写库，而后端开窗「DB 优先」
  // ⇒ 尺寸永久锁死。窗口是 `resizable(false)` + `decorations(false)`，用户根本没有
  // 调整它的途径，持久化它只有害处。这一段每一条都是那次事故的直接防线。
  {
    ok('前端不再把窗口几何写回数据库（V83 的根因就是这条）',
      !overlayCode.includes('gridGeometrySet') && !ipcCode.includes('gridGeometrySet'),
      '写回去 ⇒ 换显示器 / 改缩放那一次用的是**过期的** scaleFactor，'
      + '换算出的错值自此永久生效，屏幕再大也白搭');

    ok('后端不再从 DB 读窗口几何，开窗一律实时取主显示器',
      !rustCmdCode.includes('fn read_geometry') && !rustCmdCode.includes('grid_geometry_get'),
      '留着读路径 ⇒ 只要库里还躺着一条脏记录，开出来的窗口就是错的尺寸');

    ok('历史脏键会被清掉（不做清理它就永远是个"看起来还有用"的键）',
      (() => {
        const at = rustCmdCode.indexOf('fn drop_legacy_geometry');
        const body = at < 0 ? '' : rustCmdCode.slice(at, at + 400);
        return body.includes('DELETE FROM grid_meta') && body.includes('META_KEY_GEOMETRY');
      })(),
      'META_KEY_GEOMETRY 已废弃 ⇒ 必须有一次性的删除动作。'
      + '（判据限定在这个函数体内 —— 删布局快照那条也写了 DELETE FROM grid_meta，'
      + '不能让它冒充。）');

    ok('存在「主显示器工作区」这个唯一真源（物理像素）',
      /fn primary_work_area\(app: &AppHandle\) -> Option<\(i32, i32, u32, u32\)>/.test(rustCmdCode)
        && rustCmdCode.includes('app.primary_monitor()'),
      '几何必须有明确真源，否则迟早出现第二条写路'
      + '（V61 的教训：一个跨线程可变状态只许一个记账人）');

    ok('对齐窗口用**物理像素**，不走逻辑换算',
      /fn sync_overlay_bounds\(app: &AppHandle\) -> bool/.test(rustCmdCode)
        && rustCmdCode.includes('PhysicalPosition::new')
        && rustCmdCode.includes('PhysicalSize::new'),
      '逻辑像素要按"窗口所在屏的缩放"换算，而窗口正是要被摆到那块屏上的 —— '
      + '拿它的 DPI 算它自己的位置是循环论证，跨屏 / 改缩放时必然错位');

    ok('对齐判定带容差（否则非整数缩放下会变成每秒纠正一次的死循环）',
      /const BOUNDS_TOLERANCE: i32 = \d+;/.test(rustCmdCode)
        && /\.abs\(\) > BOUNDS_TOLERANCE/.test(rustCmdCode),
      '125% / 150% / 175% 下 `SetWindowPos` 与 `GetWindowRect` 会差 1–2px：'
      + '用严格相等 ⇒ 窗口每秒闪一下、前端每秒重排一次');

    ok('连续纠正失败会退避（不和系统互相较劲）',
      rustCmdCode.includes('BOUNDS_MAX_FIXES') && rustCmdCode.includes('BOUNDS_RETRY_AT'),
      '第三方窗口管理工具下"我们要的尺寸"可能永远得不到，每秒硬掰只会一直闪');

    ok('复用窗口时**先对齐再显示**（复用才是每次启动都走的那条路）',
      /\{\s*sync_overlay_bounds\(app\);\s*let _ = existing\.show\(\);/.test(rustCmdCode),
      '不对齐 ⇒ 窗口可能是在另一套显示器配置下建的，之后一直错尺寸；'
      + '放在 show 之后 ⇒ 用户会看到它"先在错位置出现、再跳一下"');

    ok('新建窗口也在 show() 之前按物理边界贴一次',
      /sync_overlay_bounds\(app\);\s*let _ = win\.show\(\);/.test(rustCmdCode),
      '逻辑像素换算有取整误差，不贴一次就与主屏工作区差几个像素');

    ok('保险循环里周期性复核显示器配置（否则插上外接屏永远不会重新对齐）',
      /bounds_ticks % BOUNDS_CHECK_TICKS == 0 && sync_overlay_bounds\(&app\)/.test(rustCmdCode),
      '开窗只对齐那一次，而窗口是**常驻**的 —— 用户插上外接屏的那一刻，'
      + '没有任何人会再叫它一次（他也不会为此去点「整理」）');

    ok('几何变了要提醒前端重排（不然窗口对了、格子还按旧尺寸摆着）',
      rustCmdCode.includes('EVENT_BOUNDS_CHANGED')
        && /emit_to\(GRID_LABEL, EVENT_BOUNDS_CHANGED/.test(rustCmdCode)
        && overlayCode.includes("'grid:bounds-changed'"),
      '少一环 ⇒ 用户得自己去点一次「整理」才看得到新布局');

    {
      const at = rustCmdCode.indexOf('fn layout_work_size(app: &AppHandle) -> (i64, i64) {');
      const body = at < 0 ? '' : rustCmdCode.slice(at, at + 900);
      const monAt = body.indexOf('primary_monitor');
      const winAt = body.indexOf('get_webview_window');
      ok('布局尺寸**优先**问主屏、窗口尺寸只作兜底',
        monAt >= 0 && winAt >= 0 && monAt < winAt,
        '反过来写 ⇒ 接上第二块屏那一瞬间会先按旧窗口尺寸排一次、纠正后再排一次，'
        + '用户看到格子抖一下');
    }

    ok('前端不再自己取 scaleFactor 做几何换算',
      !/\bonMoved\(|\bonResized\(/.test(overlayCode),
      '挂载时取一次的 scaleFactor 会过期 —— 那正是 V83 事故里的换算环节');
  }
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

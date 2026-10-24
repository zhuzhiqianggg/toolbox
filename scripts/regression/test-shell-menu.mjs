/**
 * 「右键菜单不许改变原生行为」的回归守卫（V58 新增）。
 *
 * # 为什么必须锁
 *
 * 用户 09-21：「为什么我们的整理把桌面图标原始的右键行为改变了…我们只是整理位置，
 * 不能改变桌面默认行为」。查下来的根因**全是静默的**——源码读起来完全合理：
 *
 *   ① `QueryContextMenu(hmenu, 0, 1, 0x7FFF, 0)` —— `uFlags` 传 0，而 Explorer 传的是
 *      `CMF_NORMAL | CMF_EXPLORE`。少一个标志位不会报错、不会 panic，只是菜单里
 *      **默默少几项**；
 *   ② 从不转发 `WM_INITMENUPOPUP` —— Shell 与第三方扩展的子菜单是**懒加载**的，
 *      实测「发送到」只剩一项「蓝牙设备」、「包含到库中」直接显示占位文案
 *      「正在检索库...」；
 *   ③ Shift + 右键被我们自己的 React 菜单抢走 —— 而 Shift + 右键在 Explorer 里是
 *      「扩展菜单」（在此处打开 PowerShell 窗口…），**属于系统语义**。
 *
 * 这三条编译通过、类型正确、单测全绿，只能靠**源码断言**守住。这里锁的就是它们，
 * 外加一条**反向**断言：不许传 `CMF_CANRENAME`。原因是那条「重命名」是 Explorer 的
 * 视图（DefView）自己实现的原位改名，不是菜单命令；我们不是它的视图，传了只会得到
 * 一个点了没反应的项 —— 宁缺毋滥（理由写在 `platform/shell_menu.rs` 顶部）。
 *
 * **解析不到即 FAIL**（不是跳过）：正则没匹配上时本套件必须变红，否则它静默退化成
 * 「永远 PASS」，比没有它更糟（CONVENTIONS「审计脚本解析为空即 FAIL」）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const SHELL_MENU = 'src-tauri/src/platform/shell_menu.rs';
const RUST_CMD = 'src-tauri/src/commands/grid.rs';
const IPC = 'src/lib/ipc.ts';
const OVERLAY = 'src/modules/desktop-grid/GridOverlay.tsx';
const LIB_RS = 'src-tauri/src/lib.rs';
const DESKTOP_HANDOFF = 'src-tauri/src/platform/desktop_handoff.rs';

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

const shellMenuSrc = read(SHELL_MENU);
const rustCmdSrc = read(RUST_CMD);
const ipcSrc = read(IPC);
const overlaySrc = read(OVERLAY);
const libSrc = read(LIB_RS);
const handoffSrc = read(DESKTOP_HANDOFF);

/* ================================================================== *
 * ① 标志位：按 Explorer 的口径传，且不许谎报能改名
 * ================================================================== */

/** 取 Rust 里某个 `const X: u32 = 0x...;` 的数值；取不到返回 null（= 断言会红）。 */
function rustU32Const(src, name) {
  const m = src.match(new RegExp(`const ${name}: u32 = (0x[0-9a-fA-F_]+);`));
  return m === null ? null : Number.parseInt(m[1].replace(/_/g, ''), 16);
}

ok('shell_menu.rs 有 CMF_EXPLORE = 0x4', rustU32Const(shellMenuSrc, 'CMF_EXPLORE') === 0x4);
ok('shell_menu.rs 有 CMF_EXTENDEDVERBS = 0x100',
  rustU32Const(shellMenuSrc, 'CMF_EXTENDEDVERBS') === 0x100);
ok('shell_menu.rs 有 CMF_NORMAL = 0x0（写出来是为了语义清楚）',
  rustU32Const(shellMenuSrc, 'CMF_NORMAL') === 0x0);

const flagsExpr = shellMenuSrc.match(/let mut flags = ([^;]+);/);
ok('能找到 flags 的构造表达式', flagsExpr !== null, '正则没匹配到，源码可能被改过');
if (flagsExpr !== null) {
  const expr = flagsExpr[1];
  ok('flags 含 CMF_EXPLORE（Explorer 弹菜单一定带它）', expr.includes('CMF_EXPLORE'), expr);
  ok('flags 不再裸传 0', !/^\s*0\s*$/.test(expr), expr);
  ok(
    'flags **不含** CMF_CANRENAME（Explorer 的重命名是视图实现的，我们谎报只会得到死项）',
    !expr.includes('CMF_CANRENAME'),
    expr,
  );
}
ok(
  'shell_menu.rs 里根本没有声明 CMF_CANRENAME',
  rustU32Const(shellMenuSrc, 'CMF_CANRENAME') === null,
);
const qcm = shellMenuSrc.match(/QueryContextMenu\(hmenu, 0, 1, 0x7FFF, (\w+)\)/);
ok('QueryContextMenu 传的是算好的 flags 变量，而不是字面量 0', qcm !== null && qcm[1] === 'flags',
  qcm === null ? '正则没匹配到' : qcm[1]);
ok('extended 时补 CMF_EXTENDEDVERBS', /if extended \{\s*flags \|= CMF_EXTENDEDVERBS;/.test(shellMenuSrc));

/* ================================================================== *
 * ② 菜单消息转发：懒加载子菜单全靠它
 * ================================================================== */

ok('shell_menu.rs 引入了 IContextMenu2', /IContextMenu2/.test(shellMenuSrc));
ok('shell_menu.rs 引入了 IContextMenu3', /IContextMenu3/.test(shellMenuSrc));
ok('通过 cast 查 IContextMenu3', /cast::<IContextMenu3>\(\)/.test(shellMenuSrc));
ok('调用 HandleMenuMsg2（IContextMenu3）', /HandleMenuMsg2\(/.test(shellMenuSrc));
ok('调用 HandleMenuMsg（IContextMenu2 兜底）', /HandleMenuMsg\(/.test(shellMenuSrc));
for (const msg of ['WM_INITMENUPOPUP', 'WM_DRAWITEM', 'WM_MEASUREITEM', 'WM_MENUCHAR']) {
  ok(`处理 ${msg}`, new RegExp(msg).test(shellMenuSrc));
}
ok('用 SetWindowLongPtrW 做窗口子类化', /SetWindowLongPtrW\(hwnd, GWLP_WNDPROC/.test(shellMenuSrc));
ok('子类化后**必须还原**（否则宿主窗口过程被永久换掉）',
  (shellMenuSrc.match(/SetWindowLongPtrW\(hwnd, GWLP_WNDPROC/g) ?? []).length >= 2);
ok('未处理的菜单消息原样交回原窗口过程（CallWindowProcW）', /CallWindowProcW\(/.test(shellMenuSrc));
ok('WM_MENUCHAR 命中后自己 return（要回话给系统）', /return result;/.test(shellMenuSrc));
ok('子类化失败不静默（写日志）', /窗口子类化失败/.test(shellMenuSrc));

/* ================================================================== *
 * ③ 命令层 / IPC / 前端：Shift 让回系统，Handy 菜单改 Ctrl
 * ================================================================== */

ok('Rust 命令 shell_context_menu 接受 extended 参数',
  /pub async fn shell_context_menu\(\s*app: AppHandle,\s*path: String,\s*extended: Option<bool>,/.test(rustCmdSrc));
ok('命令层把 extended 传给 show_context_menu',
  /show_context_menu\(hwnd, &target, want_extended\)/.test(rustCmdSrc));

ok('ipc.ts shellContextMenu 带 extended（默认 false）',
  /shellContextMenu: \(path: string, extended = false\)/.test(ipcSrc));
ok('ipc.ts 把 extended 发到后端', /call<void>\('shell_context_menu', \{ path, extended \}\)/.test(ipcSrc));

ok('前端条目右键用 ctrlKey 判 Handy 菜单（不再抢 Shift）',
  /if \(!event\.ctrlKey\) \{/.test(overlaySrc));
// V81：**桌面空白处这一处不再算进来**。那里右键会穿透到系统桌面，弹的是 Explorer 的
// 真原生菜单（我们注入的 Handy 子菜单也在里面），Shift 由 Explorer 自己解释成扩展动词
// —— 比我们「传一次 shiftKey 给复刻菜单」更接近原生。原来那条 `shellContextMenu(
// '::{…}\Desktop', …)` 从来没成功过（日志里几百条「拿不到 shell 对象：参数错误」），
// 所以这里从 3 处改成 2 处是**有意为之**，不是漏传。
ok('前端把 shiftKey 透传给原生菜单（扩展动词）',
  (overlaySrc.match(/shellContextMenu\([^)]*event\.shiftKey\)/g) ?? []).length >= 2,
  '格子条目 / 未归类条目 两处都要传 —— 不一致本身就算「改行为」');
ok('前端不再出现「!event.shiftKey && !entry.isSystem」这种抢 Shift 的写法',
  !/!event\.shiftKey && !entry\.isSystem/.test(overlaySrc));

/* ================================================================== *
 * ④ 诊断工具还在（改 shell_menu 时靠它对照菜单项）
 * ================================================================== */

ok('诊断 example 仍在（cargo run --example menu_dump）',
  fs.existsSync(path.join(root, 'src-tauri/examples/menu_dump.rs')));

/* ================================================================== *
 * ⑤ V87：桌面**背景菜单** + 条目改名
 *
 * 用户 10-08：「新建文件夹 / 新建文本文档等右键功能都不是原生的，问题很多」。
 * 修法是**我们自己把桌面背景菜单弹出来**（`IShellFolder::CreateViewObject`），
 * 而不是 V81–V86 那套「把桌面借给 Explorer 再收回来」的补丁。
 *
 * 这里锁的是那条唯一正确的取菜单路径 —— 踩过一次坑：
 * `SHGetKnownFolderIDList(FOLDERID_Desktop)` + `BindToObject` 会报
 * `E_INVALIDARG`，因为 FOLDERID_Desktop 的 PIDL **就是命名空间根本身**，
 * Root 没有父可绑。必须直接用 `SHGetDesktopFolder()` 的结果。
 * ================================================================== */

ok('shell_menu.rs 有 show_background_context_menu',
  /pub fn show_background_context_menu\(/.test(shellMenuSrc));
ok('背景菜单取的是 SHGetDesktopFolder（桌面根自己就是桌面视图）',
  /SHGetDesktopFolder\(\)/.test(shellMenuSrc));
ok('背景菜单走 CreateViewObject（IContextMenu 给不出「新建」）',
  /CreateViewObject\(None\)/.test(shellMenuSrc));
// 只查 **import 块**：正文的注释里会提到 `FOLDERID_Desktop`（就是为了说明这条路错在
// 哪），拿全文去 match 会永远命中注释 —— 断言必须打在真正会生效的地方。
const shellImportBlock = shellMenuSrc.match(
  /use windows::Win32::UI::Shell::\{([\s\S]*?)\};/,
);
ok('能定位到 shell_menu.rs 的 Shell import 块', shellImportBlock !== null);
if (shellImportBlock !== null) {
  ok(
    '**不许**再引入 FOLDERID_Desktop 走 BindToObject（实测 E_INVALIDARG：它的 PIDL 就是根本身）',
    !shellImportBlock[1].includes('FOLDERID_Desktop'),
    shellImportBlock[1],
  );
  ok('**不许**再引入 SHGetKnownFolderIDList（那条错路的入口 API）',
    !shellImportBlock[1].includes('SHGetKnownFolderIDList'),
    shellImportBlock[1]);
}
ok('两条取菜单的路共用 run_menu（时序逻辑不许抄两遍）',
  /fn run_menu\([\s\S]*?hwnd: HWND[\s\S]*?menu: &IContextMenu[\s\S]*?extended: bool[\s\S]*?inject_new: bool/.test(
    shellMenuSrc,
  ));
ok('show_context_menu 也走 run_menu（条目菜单不注入新建）',
  /run_menu\(hwnd, &menu, extended, false\)/.test(shellMenuSrc));
ok('背景菜单走 run_menu 且注入新建（inject_new = true）',
  /run_menu\(hwnd, &menu, extended, true\)/.test(shellMenuSrc));

ok('Rust 命令 shell_desktop_background_menu 存在',
  /pub async fn shell_desktop_background_menu\(/.test(rustCmdSrc));
ok('该命令已注册到 invoke_handler',
  /commands::grid::shell_desktop_background_menu,/.test(libSrc));
ok('ipc.ts 暴露 shellDesktopBackgroundMenu',
  /shellDesktopBackgroundMenu: \(extended = false\)/.test(ipcSrc));

ok('桌面/格子空白右键改成弹背景菜单（不再是只弹 Handy 菜单）',
  /openDesktopBackgroundMenu\(event\.shiftKey\)/.test(overlaySrc));
// 允许中间夹注释（`{` 与 `setMenuDesktop` 之间有两行解释），但窗口不能太大，
// 否则这条断言会退化成「文件里同时出现这两串」的假通过。
ok('Ctrl + 右键才弹 Handy 自己的菜单（Shift 归系统扩展动词）',
  /if \(event\.ctrlKey\) \{[\s\S]{0,400}?setMenuDesktop\(\{ x: event\.clientX, y: event\.clientY \}\)/.test(
    overlaySrc,
  ));

/** V87：条目改名（对齐 Explorer 的 重命名 / F2 / 单击两次） */
ok('Rust 命令 grid_item_rename 存在', /pub async fn grid_item_rename\(/.test(rustCmdSrc));
ok('grid_item_rename 已注册', /commands::grid::grid_item_rename,/.test(libSrc));
ok('ipc.ts 暴露 gridItemRename', /gridItemRename: \(path: string/.test(ipcSrc));
ok('改名落在**同一个目录**（用 Path::parent 拼目标，不接用户给的目录）',
  /let target = parent\.join\(&trimmed\)/.test(rustCmdSrc));
ok('改名拒绝含路径分隔符的名字（否则又变成搬文件）',
  /return Err\(format!\("名字里不能包含/.test(rustCmdSrc));
ok('改名后同步更新 grid_items 登记（否则出现幽灵条目）',
  /UPDATE grid_items SET file_path = \?1, display_name = \?2 WHERE file_path = \?3/.test(rustCmdSrc));
ok('前端有 F2 改名', /event\.key !== 'F2'/.test(overlaySrc));
ok('前端有「单击两次」改名（间隔 > 350ms 且 < 1500ms）',
  /now - last\.at > 350 && now - last\.at < 1500/.test(overlaySrc));
ok('新诊断 example bg_menu_dump.rs 仍在',
  fs.existsSync(path.join(root, 'src-tauri/examples/bg_menu_dump.rs')));

/* ================================================================== *
 * ⑥ V88：亲手把「新建」做成可控的原生等价项
 *
 * 用户 10-08：「第一次新建文件夹报错」「新建每次都要卡、桌面还要整体刷新」。
 * 根因：背景菜单的「新建」是 Shell 的 CNewMenu，需要 IShellView 才能落地，
 * 我们对无真实 view 的 view-object 菜单执行它 → E_FAIL (0x80004005)。
 * 与其跟 IShellView 死磕（版本不稳），改为自己注入「新建」子菜单（文件夹/文本文档），
 * 在桌面根建真实目录/文件，再广播 grid:item-created 让前端增量认领 + 进改名。
 * 这条路同时消除了「报错 / 卡 / 整体刷新」三个子投诉。
 * ================================================================== */

ok('V88：定义了新建命令 id 常量（0x9000+ 档，不与 Shell 的 1..=0x7FFF 撞车）',
  /const CMD_NEW_FOLDER: u32 = 0x9001;/.test(shellMenuSrc) &&
    /const CMD_NEW_TEXT: u32 = 0x9002;/.test(shellMenuSrc));
// V89：改成「把结果作为返回值带回」，不再要 AppHandle、也不再广播事件。
ok('V88：有 create_new_item 在桌面根建真实文件/目录',
  /fn create_new_item\(kind: &str\) -> Option<CreatedItem>/.test(shellMenuSrc));
ok('V88：按 Windows 命名规则算不重名（新建文件夹 → 新建文件夹 (2)…）',
  /fn unique_new_name\(root: &Path, prefix: &str, ext: &str\)/.test(shellMenuSrc));
ok('V88：用 InsertMenuW 注入「新建」子菜单（MF_POPUP）',
  /InsertMenuW\([\s\S]*?MF_POPUP/.test(shellMenuSrc));
ok('V88：用 AppendMenuW 往子菜单里加「新建文件夹 / 新建文本文档」',
  /AppendMenuW\([\s\S]*?CMD_NEW_FOLDER/.test(shellMenuSrc) &&
    /AppendMenuW\([\s\S]*?CMD_NEW_TEXT/.test(shellMenuSrc));
ok('V88：命中我们的新建项**不走** InvokeCommand（那条对 view-object 菜单会 E_FAIL）',
  /if \(cmd as u32\) == CMD_NEW_FOLDER/.test(shellMenuSrc) &&
    /if \(cmd as u32\) == CMD_NEW_TEXT/.test(shellMenuSrc));
// 分支在、但分支体被改成 `Ok(None)` 的话上面两条仍会通过（假通过）—— 必须连分支体一起锁。
ok('V89：CMD_NEW_FOLDER 分支必须真的建项（不许被改成 Ok(None) 吞掉）',
  /if \(cmd as u32\) == CMD_NEW_FOLDER \{\s*return Ok\(create_new_item\("folder"\)\);/.test(
    shellMenuSrc,
  ) && /if \(cmd as u32\) == CMD_NEW_TEXT \{\s*return Ok\(create_new_item\("text"\)\);/.test(
    shellMenuSrc,
  ));
// 只查**调用点**：正文注释里会提到 `grid:item-created`（就是为说明它错在哪），
// 拿全文去 match 会永远命中注释 —— 断言必须打在真正会生效的地方。
ok('V89：**不再**广播 grid:item-created（事件在菜单还没弹时就到，会被误判成「没新建」）',
  !/app\.emit\(\s*"grid:item-created"/.test(shellMenuSrc));
ok('V89：定义 CreatedItem 并作为返回值带回前端',
  /pub struct CreatedItem \{[\s\S]*?pub path: String,[\s\S]*?pub name: String,/.test(shellMenuSrc));
ok('V89：run_menu / show_background_context_menu 返回 Option<CreatedItem>',
  /pub fn show_background_context_menu\([\s\S]{0,200}?\) -> Result<Option<CreatedItem>, String>/.test(
    shellMenuSrc,
  ) && /fn run_menu\([\s\S]{0,300}?\) -> Result<Option<CreatedItem>, String>/.test(shellMenuSrc));

ok('V89：前端**不再**监听 grid:item-created',
  !/grid:item-created/.test(overlaySrc));
ok('V89：前端改读命令返回值（created !== null 才算新建）',
  /created = await ipc\.shellDesktopBackgroundMenu\(extended\)[\s\S]{0,600}?if \(created !== null\)/.test(
    overlaySrc,
  ));
ok('V89：命中新建后 beginItemRename（进原地改名，对齐 Explorer 新建体验）',
  /beginItemRename\(created\.path, created\.name\)/.test(overlaySrc));
ok('V89：没新建（普通菜单项）才走全量 refresh',
  /await refresh\(\)\.catch\(\(\) => undefined\);[\s\S]{0,120}?\}/.test(overlaySrc));
// V88 那套「事件 + 30ms 竞速」已彻底删除：它会在菜单还没弹出时就判「没新建」触发整层刷新。
ok('V89：**不再**有 30ms 竞速（竞速本身就是「整体刷新」的来源）',
  !/setTimeout\(resolve, 30\)/.test(overlaySrc) && !/finalizeNonCreated/.test(overlaySrc));

/* ================================================================== *
 * ⑦ V89：桌面空白右键归 Handy、桌面永不翻白、新建只有「一定成的那一个」
 *
 * 用户 10-08 两张截图 + 一句「新建桌面就变成这样了，成了原桌面样式了」。
 * 三个根因，逐条锁死：
 *
 *   Ⓐ 真·桌面空白右键**穿透**给了 Explorer（根画布 pointerEvents:none + 命中区只含
 *      盒子）→ 走原生菜单 → handoff 借出桌面 → 整层翻白。日志铁证：
 *      「桌面出现原位改名编辑框 → 把桌面还给系统」。
 *   Ⓑ 菜单里**两个同名「新建(&W)」**并存：V88 只「注入」没「摘除」，原生那个 CNewMenu
 *      在无 view 的菜单里必然 E_FAIL(0x80004005) —— 用户点中它看到的就是「新建失效」
 *      （日志里那两条「执行菜单命令失败：未指定的错误」）。
 *   Ⓒ V88 的 `run_on_main_thread` 只投递不等待，命令在菜单弹出前就 resolve
 *      → 30ms 竞速误判「没新建」→ 整层 refresh。
 * ================================================================== */

// Ⓑ 先摘后插
ok('V89：有 strip_native_new_menu（摘掉原生那个必然 E_FAIL 的「新建」）',
  /unsafe fn strip_native_new_menu\(hmenu: HMENU\)/.test(shellMenuSrc));
// 顺序用**位置**判，不用窗口宽度：两者之间夹着整段 AppendMenuW，写死字符数会假失败。
// 「摘除调用」这条必须**行锚定**（行首只允许缩进）：否则被注释掉后仍会被 indexOf 命中，
// 断言就退化成永远通过 —— 变异自检就是靠这条变红的。
const stripAt = shellMenuSrc.indexOf('strip_native_new_menu(hmenu);');
const insertAt = shellMenuSrc.indexOf('InsertMenuW(');
ok('V89：存在「摘除」调用（未被注释掉）',
  /^\s*strip_native_new_menu\(hmenu\);$/m.test(shellMenuSrc));
ok('V89：存在「插入」调用', insertAt > 0);
ok('V89：注入前**先**摘原生「新建」（顺序反了就会两个同名项并存）',
  stripAt > 0 && insertAt > stripAt, `strip@${stripAt} insert@${insertAt}`);
ok('V89：摘除按位置倒序（正序删会因前移漏项）',
  /for pos in \(0\.\.count\)\.rev\(\)/.test(shellMenuSrc));
ok('V89：摘除命中判据覆盖中文「新建」与英文「New」',
  /text\.contains\("新建"\)/.test(shellMenuSrc) && /text\.starts_with\("&New"\)/.test(shellMenuSrc));
ok('V89：插入失败不静默（否则菜单里一个可用新建都没有）',
  /插入「新建」子菜单失败/.test(shellMenuSrc));
ok('V89：菜单收起时留痕命令 id（下次再报「新建失效」能一眼看出点了哪个）',
  /命令 id=\{cmd:#x\}/.test(shellMenuSrc));
ok('V89：新建成功也写日志（成功不静默，才能区分「没点到」与「建失败」）',
  /桌面新建成功/.test(shellMenuSrc));

// Ⓐ 桌面空白右键归 Handy + 不再借出
ok('V89：接管态下根画布整窗可交互（桌面空白右键不再穿透给 Explorer）',
  /pointerEvents:[\s\S]{0,400}?takeover\?\.enabled === true && !contentHidden[\s\S]{0,120}?'auto'/.test(
    overlaySrc,
  ));
ok('V89：接管态下上报「整窗」命中区（让 Rust 命中轮询认为光标始终命中）',
  /if \(takeover\?\.enabled === true && !contentHidden\) \{[\s\S]{0,200}?width: window\.innerWidth \* scaleFactor/.test(
    overlaySrc,
  ));
ok('V89：整窗命中区随 takeover 变化重算（写进了依赖数组）',
  /\}, \[regionsKey, scaleFactor, contentHidden, takeover\]\);/.test(overlaySrc));
ok('V89：handoff 整体停用（HANDOFF_DISABLED）',
  /const HANDOFF_DISABLED: bool = true;/.test(handoffSrc));
ok('V89：begin_handoff 看到停用标志就让路',
  /fn begin_handoff\(\) \{[\s\S]{0,300}?if HANDOFF_DISABLED \{\s*return;/.test(handoffSrc));
ok('V89：poll_menu 也停用（不再有第二处借出口）',
  /pub fn poll_menu\(\) \{[\s\S]{0,300}?if HANDOFF_DISABLED \{\s*return;/.test(handoffSrc));
ok('V89：保留 own_menu_active 守卫（自持菜单期间绝不借出，双保险）',
  /pub fn own_menu_active\(\) -> bool/.test(handoffSrc) &&
    /set_own_menu_active\(true\)/.test(shellMenuSrc) &&
    /set_own_menu_active\(false\)/.test(shellMenuSrc));

// Ⓒ 命令真正等到菜单收起
ok('V89：命令返回 Option<CreatedItem>（不再是 ()）',
  /pub async fn shell_desktop_background_menu\([\s\S]{0,200}?\) -> Result<Option<crate::platform::shell_menu::CreatedItem>, String>/.test(
    rustCmdSrc,
  ));
ok('V89：用 mpsc 通道把菜单结果从主线程发回（命令线程阻塞等，绝不早退）',
  /std::sync::mpsc::channel::<Option<crate::platform::shell_menu::CreatedItem>>\(\)/.test(rustCmdSrc) &&
    /tx\.send\(/.test(rustCmdSrc) &&
    /rx\.recv\(\)/.test(rustCmdSrc));
ok('V89：弹菜单一律经 run_on_main_thread（TrackPopupMenuEx 需要宿主线程有消息泵）',
  /app\.run_on_main_thread\(move \|\| \{/.test(rustCmdSrc) &&
    /show_background_context_menu\(/.test(rustCmdSrc));
ok('V89：ipc 返回 CreatedItem | null',
  /shellDesktopBackgroundMenu: \(extended = false\): Promise<CreatedItem \| null>/.test(ipcSrc));
ok('V89：types/grid.ts 导出 CreatedItem',
  /export interface CreatedItem \{/.test(read('src/types/grid.ts')));

/* ================================================================== *
 * ⑧ V90/V91：不复刻了 —— 把右键**转发**给 Explorer 的桌面视图，弹它自己的完整原生菜单
 *
 * 用户 10-08 23:01 给两张对比图质问「这是你搞得右键菜单，你到底能不能实现原始功能」：
 *   · 退出接管后 → 原生菜单：查看 / 排序方式 / 刷新 / 撤销 / 新建（14 项）/ 显示更多选项；
 *   · 接管态 → 我们复刻的菜单：只有「新建文件夹 / 新建文本文档」，连视图菜单都没有。
 * 那两块钱**不经过 `IContextMenu`**（查看/排序/刷新 = `IShellView` 的视图菜单；
 * 完整新建 = `CNewMenu` + 注册表 `ShellNew`），复刻永远追不平 ⇒ 改成转发。
 * （`examples/bg_menu_dump` 实测：`CreateViewObject` 的桌面背景菜单只有 16 项，
 *   里面**没有**查看 / 排序方式 / 刷新 —— 那三项只有 Explorer 自己弹时才有。）
 *
 * V91 修的是 V90 的**判据错误**：Win11 的桌面右键菜单由 Explorer 的 XAML 宿主在
 * **另一个线程**弹出，`SendMessage` 立刻返回（这台机器实测 37–48ms）。V90 拿
 * 「耗时 ≥ 150ms」当「弹出来了」的判据 ⇒ 每次都被判成「没弹出」⇒ 又回退弹一个复刻
 * 菜单 ⇒ **两个菜单同时挂在屏幕上**，而 Explorer 那个还因为我们的 `TrackPopupMenuEx`
 * 抢了模态前台**收不回去**（用户 10-08 23:30：「右键要出两个菜单，而且一个菜单好像
 * 还一直存在」）。修法：① 判据换成**直接观测屏幕**；② 「等菜单」挪到后台线程。
 * ================================================================== */

ok('V90：转发拆成「发消息」+「等菜单」两半（等菜单不许占 UI 线程）',
  /pub fn forward_desktop_view_menu\(\) -> Result<DesktopViewMenuState, String>/.test(shellMenuSrc) &&
    /pub fn await_desktop_view_menu\(state: &DesktopViewMenuState\) -> bool/.test(shellMenuSrc));
ok('V90：用 SendMessageW + WM_CONTEXTMENU 转发（wParam=发起窗口、lParam=屏幕坐标）',
  /SendMessageW\(list, WM_CONTEXTMENU, WPARAM\(list\.0 as usize\), LPARAM\(lp\)\)/.test(shellMenuSrc));
ok('V90：坐标取自 GetCursorPos（屏幕物理像素，不是前端 client 坐标）',
  /let mut point = POINT::default\(\);[\s\S]{0,200}?GetCursorPos\(&mut point\)/.test(shellMenuSrc));
ok('V90：MAKELPARAM 低 16 位 x、高 16 位 y',
  /\(\(\(point\.y as u32 & 0xFFFF\) << 16\) \| \(point\.x as u32 & 0xFFFF\)\)/.test(shellMenuSrc));
ok('V90：目标是我们隐藏掉的那个“真”桌面视图（SysListView32），不是自建窗口',
  /crate::commands::grid::desktop_icon_view\(\)/.test(shellMenuSrc));

// —— V91：判据必须是「观测屏幕」，不许再拿 SendMessage 耗时当数（双菜单真凶）——
ok('V91：**不再**用 SendMessage 耗时当「菜单弹没弹」的判据',
  !/let popped = ms >= 150;/.test(shellMenuSrc));
ok('V91：改用 WindowFromPoint 观测鼠标点下的顶层窗口（菜单就弹在鼠标点）',
  /WindowFromPoint\(point\)/.test(shellMenuSrc) &&
    /GetAncestor\(hit, GA_ROOT\)/.test(shellMenuSrc) &&
    /GetWindowThreadProcessId/.test(shellMenuSrc));
ok('V91：判据 =「鼠标点下换了人 + 不是我们自己」⇒ 菜单弹出来了',
  /now != 0 && now != state\.before && window_pid\(now\) != me/.test(shellMenuSrc));
// 行锚定（不许再 && 别的）：多一个条件就可能永远判不出「弹出来了」，于是每次右键都多弹一个。
ok('V91：判据就那三条，后面紧跟 `{ popped = true;`（不许再 && 条件）',
  /if now != 0 && now != state\.before && window_pid\(now\) != me \{\s*popped = true;/.test(
    shellMenuSrc,
  ));
ok('V91：等菜单**出现**之后还要等它**收起**（否则前端在菜单还开着时对账 ⇒ 永远认领不到新建项）',
  /while close\.elapsed\(\)\.as_millis\(\) < MENU_CLOSE_TIMEOUT_MS/.test(shellMenuSrc));
ok('V91：取消隐藏改名框改走 PostMessage（投递即走，Explorer 忙也不会卡死后台线程）',
  /PostMessageW\(list, LVM_CANCELEDITLABEL, WPARAM\(0\), LPARAM\(0\)\)/.test(shellMenuSrc));
ok('V91：取消改名框在**等菜单收起**的循环里持续打点（改名框是菜单收起那一刻才拉起的）',
  /while close\.elapsed\(\)[\s\S]{0,400}?PostMessageW\(list, LVM_CANCELEDITLABEL/.test(shellMenuSrc));

ok('V90：命令层**优先**走转发（原生完整菜单）',
  /crate::platform::shell_menu::forward_desktop_view_menu\(\)/.test(rustCmdSrc));
ok('V91：等待放**后台线程**（UI 线程只发消息，否则 sleep 循环会冻住整个前端）',
  /std::thread::spawn\(move \|\| \{[\s\S]{0,200}?await_desktop_view_menu\(&state\)/.test(rustCmdSrc));
ok('V90：转发不生效时回退到 V89 复刻菜单（最坏情况不比以前差）',
  /await_desktop_view_menu\(&state\)[\s\S]{0,700}?show_background_context_menu\(/.test(rustCmdSrc));
ok('V91：回退必须回 UI 线程弹（TrackPopupMenuEx 要求宿主线程有消息泵）',
  /fallback_handle\.run_on_main_thread\(move \|\| \{/.test(rustCmdSrc));
ok('V90：弹原生菜单前先把前台给可见窗口（隐藏宿主 ⇒ 不占前台菜单会“点外面不消失”）',
  /unsafe \{\s*let _ = SetForegroundWindow\(hwnd\);\s*\}/.test(rustCmdSrc));

ok('V90：前端原生路径做**增量对账**（diff 出新增项送进竖条）',
  /const added = after\.filter\(\(p\) => !before\.has\(p\)\);/.test(overlaySrc) &&
    /const removed = \[\.\.\.before\]\.filter\(\(p\) => !after\.includes\(p\)\);/.test(overlaySrc));
ok('V90：只有出现删除 / 改名才重排格子（单纯新建不整层 refresh）',
  /if \(removed\.length > 0\) \{\s*await refresh\(\)/.test(overlaySrc));
ok('V90：单个新增项进原地改名（对齐 Explorer 新建体验）',
  /const only = added\.length === 1 \? added\[0\] : undefined;[\s\S]{0,200}?beginItemRename\(only,/.test(
    overlaySrc,
  ));
// 原生「新建」会让 Explorer 在**隐藏的** listview 上拉起改名框：用户看不见 + 它会抢键盘
// （我们自己的改名输入框就打不进字了）。必须取消它 —— 这条不锁就会回归。
ok('V90：定义了 LVM_CANCELEDITLABEL（取消 ListView 原生改名框）',
  /const LVM_CANCELEDITLABEL: u32 = 0x1000 \+ 0x77;/.test(shellMenuSrc));
ok('V90：同时发 WM_CANCELMODE（收尾兜底，避免残留模态态）',
  /PostMessageW\(list, WM_CANCELMODE, WPARAM\(0\), LPARAM\(0\)\)/.test(shellMenuSrc));

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

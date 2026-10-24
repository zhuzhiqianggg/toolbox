/**
 * 纯逻辑模块回归总入口。
 *
 * 跑法（项目根）：
 *   node scripts/regression/run.mjs
 *
 * 这些模块（cron / lunar / holidays）不依赖 React / DOM / Tauri，
 * 靠 Node ≥ 22.18 的**原生类型剥离**直接 import `src/lib/*.ts`，不用先打包。
 * 想加新模块：写个 `test-<name>.mjs`（import 源码 + 打印 PASS/FAIL + 用 exit code 报结果），
 * 再把文件名加进下面的 SUITES。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  'test-cron.mjs',
  'test-cron-platform.mjs',
  'test-lunar.mjs',
  'test-holidays.mjs',
  'test-sql.mjs',
  'test-textlab.mjs',
  'test-password.mjs',
  'test-regex-library.mjs',
  // V26：工具箱底层（此前零覆盖）—— 编码 / URL / 哈希 / JWT / JSON
  'test-base64.mjs',
  'test-url.mjs',
  'test-hash.mjs',
  'test-jwt.mjs',
  'test-json.mjs',
  'test-byte-units.mjs',
  // V27：内容识别启发式（建议条误报）+ JSON 错误定位（与 V8 JSON.parse 差分）
  'test-detect.mjs',
  'test-json-locate.mjs',
  // V28：接口测试底层（cURL 解析 / 头部装配 / 响应格式化）
  'test-api.mjs',
  // V49：智能桌面整理 · 归组与盒内排序引擎
  'test-smart-arrange.mjs',
  // V56：桌面格子前后端布局常量交叉校验（标题栏高 / 竖条宽 / 入口宽 = 日历宽 …）
  'test-desktop-constants.mjs',
  // V58：原生右键菜单不许改行为（flags 按 Explorer 传 / 转发 WM_INITMENUPOPUP / Shift 让回系统）
  'test-shell-menu.mjs',
  // V59：内部拖拽必须是指针拖拽（HTML5 拖放在挂件窗里被 wry 判死）+ 盒子高度必须绑引擎值
  'test-drag-pointer.mjs',
];

let failed = 0;
for (const suite of SUITES) {
  console.log(`\n===== ${suite} =====`);
  const result = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit' });
  if (result.error) {
    failed += 1;
    console.error(`  ✗ 无法启动：${result.error.message}`);
    continue;
  }
  if (result.status !== 0) {
    failed += 1;
  }
}

console.log(`\n===== 结果：${SUITES.length - failed}/${SUITES.length} 套通过 =====`);
process.exit(failed === 0 ? 0 : 1);

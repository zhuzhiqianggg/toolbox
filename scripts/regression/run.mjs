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

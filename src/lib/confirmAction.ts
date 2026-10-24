/**
 * 危险操作前的二次确认（V40.1）。
 *
 * ## 为什么不能直接写 window.confirm
 *
 * Tauri 的 dialog 插件会往 webview 注入一段初始化脚本，把原生对话框**整个换掉**：
 *
 *   window.alert   -> plugin:dialog|message
 *   window.confirm -> plugin:dialog|confirm     （注意：async，返回 Promise）
 *
 * 这带来一个**看不见的**缺陷，两个后果叠在一起：
 *
 *   ① 插件自带的 default 权限集只含 allow-message / allow-save / allow-open，
 *      **没有 allow-confirm** ⇒ 调用必然 reject。日志里表现为
 *      「未处理的 Promise 拒绝：Command plugin:dialog|confirm not allowed by ACL」；
 *   ② 它变成 async 之后，老写法 `const ok = window.confirm(...); if (!ok) return;`
 *      拿到的是一个 **Promise 对象（永远为真）**，`if (!ok)` 永远不成立
 *      ⇒ **删除格子 / 删除备份 / 还原布局这些破坏性操作会直接执行，用户根本没被问过**。
 *      `if (!window.confirm(...)) return;` 同理（`!Promise` 恒为 false）。
 *
 * 这条链**不报错、不白屏、不卡顿**，只是「点了就直接删了」—— 所以 tsc、cargo、
 * 回归、冒烟四层全拦不住（浏览器里 window.confirm 本来就是同步的，测试环境永远正常）。
 * V40 实测在用户首次启动的日志里抓到那条未处理拒绝，才把它挖出来。
 *
 * ## 用法
 *
 *   if (!(await confirmAction('删除这个格子？'))) return;
 *
 * 调用方必须是 async（或把整段包进 `void (async () => { ... })()`）。
 * 确认流程出任何问题（ACL 被收紧 / webview 不支持 / 权限没批）时**保守返回 false**：
 * 问不到就不做 —— 破坏性操作绝不因为「问不出来」而默认执行。
 *
 * 配套的 ACL 声明见 `src-tauri/capabilities/default.json` 里的
 * `dialog:allow-confirm`（不补这一条，上面第 ① 条就会一直生效）。
 */
import { reportOperation } from '@/lib/errorSink';

/**
 * 弹一个「确定 / 取消」确认框，返回用户是否点了确定。
 *
 * 浏览器里 `window.confirm` 是**同步** boolean，Tauri 里被插件换成了 Promise ——
 * 这里统一 `await`（对 boolean 用 await 也成立），把两种环境的行为抹平。
 */
export async function confirmAction(message: string): Promise<boolean> {
  try {
    const answer: unknown = await (window.confirm(message) as unknown);
    return answer === true;
  } catch (err) {
    reportOperation('确认对话框不可用（已按「不执行」处理）', err);
    return false;
  }
}

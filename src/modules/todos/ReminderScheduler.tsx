import { useEffect } from 'react';
import { isTauri } from '@/platform/detect';
import { listTodos, updateTodo } from '@/core/data/todosService';

/**
 * 待办提醒调度器（V09）。
 *
 * **设计取舍（重要）**：
 *   - 挂载在主窗口，每 60s 扫描一次库内 `remind_at` 到期且 `reminded = 0` 的未完成待办，
 *     经系统通知（`tauri-plugin-notification`）提醒一次并置 `reminded = 1`（防重复）；
 *   - **过期 > 1h 不补发**：应用启动 / 长时间休眠恢复时，提醒时间早已过去的待办
 *     只静默标记 `reminded = 1`，**不发通知**。理由：休眠一晚后唤醒若把数十条过期
 *     提醒一次性弹出，等于通知轰炸，且此时补发的价值极低（用户回到待办列表即可看到
 *     逾期标红）。1 小时内的短暂逾期仍正常补发，覆盖「临期才开机」的常见场景；
 *   - 调度直接读库（不经 zustand store），保证任意窗口视角下不重复调度；
 *     `reminded` 写库走统一服务路径并广播，其他窗口列表同步收敛。
 *
 * 通知权限：首次发送前经 `isPermissionGranted` / `requestPermission` 引导授权。
 * **未授权则不置 `reminded`**（本轮不发、下轮重试）——绝不在"没真正提醒"的情况下标记
 * 已提醒，否则该待办会永久失去提醒（用户事后授权也等不到）。持续未授权时，由上面的
 * 「过期 > 1h 静默置位」规则收敛而停止重试。
 */

/** 过期不补发阈值：提醒时间已过去超过 1 小时 → 静默标记，不弹通知 */
export const OVERDUE_SKIP_MS = 60 * 60 * 1000;

/** 扫描间隔（毫秒） */
const SWEEP_INTERVAL_MS = 60 * 1000;

/** 发送一条系统通知（权限未授权时尝试请求一次；仍失败则静默放弃）。 */
async function notifyOnce(title: string): Promise<boolean> {
  const plugin = await import('@tauri-apps/plugin-notification');
  let granted = await plugin.isPermissionGranted();
  if (!granted) {
    granted = (await plugin.requestPermission()) === 'granted';
  }
  if (!granted) {
    return false;
  }
  plugin.sendNotification({ title: '待办提醒 · Handy', body: title });
  return true;
}

/**
 * 执行一轮提醒扫描（导出以便测试/手动触发）。
 * @returns 本轮 `已通知 / 已跳过（过期不补发）` 条数
 */
export async function runReminderSweep(
  now: number = Date.now(),
): Promise<{ notified: number; skipped: number }> {
  const todos = await listTodos();
  let notified = 0;
  let skipped = 0;
  for (const todo of todos) {
    if (todo.done || todo.reminded || todo.remindAt === null) {
      continue;
    }
    if (todo.remindAt > now) {
      continue; // 尚未到期
    }

    // 逐条 try/catch：单条异常（脏数据 / 通知失败）只跳过该条并记录，不中断整轮扫描
    try {
      if (now - todo.remindAt > OVERDUE_SKIP_MS) {
        // 过期超 1 小时：不补发（产品取舍，防通知轰炸），静默标记已提醒
        await updateTodo(todo.id, { reminded: true });
        skipped += 1;
        continue;
      }

      const sent = await notifyOnce(todo.title);
      // 仅当通知**确实发出**才置位：未授权/发送失败时不置位，留待下一轮重试，
      // 避免"未提醒却被标记已提醒"导致该待办永久丢失提醒（持续未授权时由上面的
      // 「过期 > 1h 静默置位」规则收敛并停止重试）。
      if (sent) {
        await updateTodo(todo.id, { reminded: true });
        notified += 1;
      }
    } catch (error: unknown) {
      console.error(`[Handy] 待办提醒处理失败（已跳过该条，id=${todo.id}）：`, error);
      continue;
    }
  }
  return { notified, skipped };
}

/**
 * 提醒调度器挂载组件（无 UI）。仅 Tauri 宿主内工作；浏览器调试环境为 no-op。
 */
export function ReminderScheduler(): null {
  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    const sweep = (): void => {
      void runReminderSweep().catch((error: unknown) => {
        console.error('[Handy] 待办提醒调度失败：', error);
      });
    };
    sweep();
    const timer = window.setInterval(sweep, SWEEP_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  return null;
}

export default ReminderScheduler;

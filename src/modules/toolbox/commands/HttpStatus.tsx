import * as React from 'react';
import { BookOpen as BookOpenIcon, Copy } from 'lucide-react';
import { CommandShell, type SampleEntry } from '@/components/CommandShell';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { useCommandShell } from '@/hooks/useCommandShell';
import { useToolState } from '@/hooks/useToolState';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import type { CommandProps } from '@/core/types';

const COMMAND_ID = 'http-status';

/**
 * HTTP 状态码速查表。
 *
 * 工具定位：调接口 / 看日志 / 排查网关报错时快速确认状态码含义，并把
 * 「404 Not Found」这类标准写法一键带进聊天或工单。
 *
 * - 内置 1xx-5xx 共 62 个常用状态码（含 418 彩蛋与 WebDAV 扩展），纯前端静态表零延迟；
 * - 顶部过滤框数字 / 文本通吃（匹配 code / name / 中文说明），分组 chip 带计数；
 * - 每行是原生 button：点击即复制「404 Not Found」格式（Tab 聚焦 + Enter 同样可复制）；
 * - 标题栏复制为**全表**按行拼接（code + name），便于整体贴进文档。
 */

/** 状态码分组（按百位） */
type StatusGroup = '1xx' | '2xx' | '3xx' | '4xx' | '5xx';

/** 分组筛选值：'all' 表示不过滤 */
type GroupFilter = StatusGroup | 'all';

/** 一条状态码 */
interface HttpStatusEntry {
  code: number;
  name: string;
  /** 一句话中文说明 */
  summary: string;
  group: StatusGroup;
}

/** 工具持久化状态（过滤词 + 分组，重开工具接着上次查） */
interface HttpStatusState {
  query: string;
  group: GroupFilter;
}

/** 静态数据表：1xx(4) + 2xx(10) + 3xx(8) + 4xx(29) + 5xx(11) = 62 条 */
const HTTP_STATUS: ReadonlyArray<HttpStatusEntry> = [
  { code: 100, name: 'Continue', summary: '服务器已收到请求头，客户端应继续发送请求体', group: '1xx' },
  { code: 101, name: 'Switching Protocols', summary: '服务器同意切换协议（如升级为 WebSocket）', group: '1xx' },
  { code: 102, name: 'Processing', summary: '服务器已收到请求，仍在处理中（WebDAV）', group: '1xx' },
  { code: 103, name: 'Early Hints', summary: '预告后续响应头，让浏览器提前预加载资源', group: '1xx' },
  { code: 200, name: 'OK', summary: '请求成功，响应体随本次返回', group: '2xx' },
  { code: 201, name: 'Created', summary: '请求成功且已创建新资源（常配 Location 头）', group: '2xx' },
  { code: 202, name: 'Accepted', summary: '请求已接受，但尚未处理完成（异步任务）', group: '2xx' },
  { code: 203, name: 'Non-Authoritative Information', summary: '成功，但返回的是代理改造过的元信息', group: '2xx' },
  { code: 204, name: 'No Content', summary: '成功但无响应体（常用于保存 / 删除成功）', group: '2xx' },
  { code: 205, name: 'Reset Content', summary: '成功，要求客户端重置表单等输入', group: '2xx' },
  { code: 206, name: 'Partial Content', summary: '成功返回部分内容（Range 断点续传）', group: '2xx' },
  { code: 207, name: 'Multi-Status', summary: '批量操作逐资源报告状态（WebDAV）', group: '2xx' },
  { code: 208, name: 'Already Reported', summary: '成员已在之前响应中报告过，避免重复（WebDAV）', group: '2xx' },
  { code: 226, name: 'IM Used', summary: '服务器完成了实例操作（Delta 编码）', group: '2xx' },
  { code: 300, name: 'Multiple Choices', summary: '资源有多个表示，让客户端或用户选择', group: '3xx' },
  { code: 301, name: 'Moved Permanently', summary: '资源永久迁移，后续应使用新地址（SEO 权重转移）', group: '3xx' },
  { code: 302, name: 'Found', summary: '资源临时位于其他地址，之后仍用原 URI', group: '3xx' },
  { code: 303, name: 'See Other', summary: '用 GET 去另一个 URI 取结果（POST 后重定向）', group: '3xx' },
  { code: 304, name: 'Not Modified', summary: '缓存仍有效，客户端使用本地缓存', group: '3xx' },
  { code: 305, name: 'Use Proxy', summary: '已弃用：应通过指定代理访问', group: '3xx' },
  { code: 307, name: 'Temporary Redirect', summary: '临时重定向，且不得更改请求方法', group: '3xx' },
  { code: 308, name: 'Permanent Redirect', summary: '永久重定向，且不得更改请求方法', group: '3xx' },
  { code: 400, name: 'Bad Request', summary: '请求语法或参数有误，服务器无法理解', group: '4xx' },
  { code: 401, name: 'Unauthorized', summary: '未认证：需要登录或携带有效凭证', group: '4xx' },
  { code: 402, name: 'Payment Required', summary: '预留：需要付费（实际很少使用）', group: '4xx' },
  { code: 403, name: 'Forbidden', summary: '已认证但无权限访问该资源', group: '4xx' },
  { code: 404, name: 'Not Found', summary: '服务器找不到请求的资源', group: '4xx' },
  { code: 405, name: 'Method Not Allowed', summary: '请求方法不被该资源支持（如对只读接口 POST）', group: '4xx' },
  { code: 406, name: 'Not Acceptable', summary: '无法按 Accept 头生成可接受的内容', group: '4xx' },
  { code: 407, name: 'Proxy Authentication Required', summary: '需要先向代理完成认证', group: '4xx' },
  { code: 408, name: 'Request Timeout', summary: '客户端在服务器等待期内未完成请求', group: '4xx' },
  { code: 409, name: 'Conflict', summary: '请求与资源当前状态冲突（如并发修改）', group: '4xx' },
  { code: 410, name: 'Gone', summary: '资源已永久删除，且无可知的新地址', group: '4xx' },
  { code: 411, name: 'Length Required', summary: '缺少 Content-Length，服务器拒绝处理', group: '4xx' },
  { code: 412, name: 'Precondition Failed', summary: '请求头前置条件（如 If-Match）不满足', group: '4xx' },
  { code: 413, name: 'Payload Too Large', summary: '请求体超过服务器允许的大小', group: '4xx' },
  { code: 414, name: 'URI Too Long', summary: '请求 URI 过长（常见于超长 GET 参数）', group: '4xx' },
  { code: 415, name: 'Unsupported Media Type', summary: '不支持请求体的媒体类型或格式', group: '4xx' },
  { code: 416, name: 'Range Not Satisfiable', summary: '请求的 Range 范围超出资源实际大小', group: '4xx' },
  { code: 417, name: 'Expectation Failed', summary: 'Expect 头声明的期望无法满足', group: '4xx' },
  { code: 418, name: "I'm a teapot", summary: '愚人节彩蛋（RFC 2324）：我是茶壶，不煮咖啡', group: '4xx' },
  { code: 421, name: 'Misdirected Request', summary: '请求被发到了无法产生响应的连接', group: '4xx' },
  { code: 422, name: 'Unprocessable Entity', summary: '格式正确但语义有误，无法处理（表单校验常用）', group: '4xx' },
  { code: 423, name: 'Locked', summary: '目标资源被锁定（WebDAV）', group: '4xx' },
  { code: 424, name: 'Failed Dependency', summary: '依赖的前置请求失败，本请求未执行（WebDAV）', group: '4xx' },
  { code: 425, name: 'Too Early', summary: '服务器拒绝处理可能被重放的早期数据', group: '4xx' },
  { code: 426, name: 'Upgrade Required', summary: '需要切换协议（如 TLS）后重试', group: '4xx' },
  { code: 428, name: 'Precondition Required', summary: '要求携带条件请求头，防止丢失更新', group: '4xx' },
  { code: 429, name: 'Too Many Requests', summary: '请求频率过高，被限流', group: '4xx' },
  { code: 431, name: 'Request Header Fields Too Large', summary: '请求头整体过大', group: '4xx' },
  { code: 451, name: 'Unavailable For Legal Reasons', summary: '因法律要求不可提供该资源', group: '4xx' },
  { code: 500, name: 'Internal Server Error', summary: '服务器内部错误（最通用的失败）', group: '5xx' },
  { code: 501, name: 'Not Implemented', summary: '服务器不支持实现该请求所需的功能', group: '5xx' },
  { code: 502, name: 'Bad Gateway', summary: '网关或代理从上游收到无效响应', group: '5xx' },
  { code: 503, name: 'Service Unavailable', summary: '服务暂时不可用（过载或维护）', group: '5xx' },
  { code: 504, name: 'Gateway Timeout', summary: '网关或代理等待上游响应超时', group: '5xx' },
  { code: 505, name: 'HTTP Version Not Supported', summary: '不支持请求所用的 HTTP 版本', group: '5xx' },
  { code: 506, name: 'Variant Also Negotiates', summary: '内容协商配置错误，产生循环引用', group: '5xx' },
  { code: 507, name: 'Insufficient Storage', summary: '服务器存储空间不足（WebDAV）', group: '5xx' },
  { code: 508, name: 'Loop Detected', summary: '处理请求时检测到无限循环（WebDAV）', group: '5xx' },
  { code: 510, name: 'Not Extended', summary: '请求未遵循服务器要求的扩展策略', group: '5xx' },
  { code: 511, name: 'Network Authentication Required', summary: '需要在网络层完成认证（如公共 Wi-Fi Portal）', group: '5xx' },
];

/** 分组 chip 元数据 */
const GROUP_META: ReadonlyArray<{ id: GroupFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: '1xx', label: '1xx 信息' },
  { id: '2xx', label: '2xx 成功' },
  { id: '3xx', label: '3xx 重定向' },
  { id: '4xx', label: '4xx 客户端错误' },
  { id: '5xx', label: '5xx 服务端错误' },
];

/** 分组徽章配色：蓝 → 绿 → 琥珀 → 橙 → 红，语义从「信息」到「严重」渐进 */
const GROUP_BADGE: Readonly<Record<StatusGroup, string>> = {
  '1xx': 'bg-sky-500/10 text-sky-700',
  '2xx': 'bg-emerald-500/10 text-emerald-700',
  '3xx': 'bg-amber-500/10 text-amber-700',
  '4xx': 'bg-orange-500/10 text-orange-700',
  '5xx': 'bg-rose-500/10 text-rose-700',
};

/** 各分组计数（静态表只算一次） */
const GROUP_COUNTS: Readonly<Record<StatusGroup, number>> = (() => {
  const acc: Record<StatusGroup, number> = { '1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  for (const entry of HTTP_STATUS) {
    acc[entry.group] += 1;
  }
  return acc;
})();

/** HttpStatus 工具组件 */
export function HttpStatus(_props: CommandProps): React.JSX.Element {
  const shell = useCommandShell(COMMAND_ID);
  const [state, patch] = useToolState<HttpStatusState>(COMMAND_ID, {
    query: '',
    group: 'all',
  });

  const filtered = React.useMemo(() => {
    const q = state.query.trim().toLowerCase();
    return HTTP_STATUS.filter(
      (entry) =>
        (state.group === 'all' || entry.group === state.group) &&
        (q.length === 0 ||
          String(entry.code).includes(q) ||
          entry.name.toLowerCase().includes(q) ||
          entry.summary.toLowerCase().includes(q)),
    );
  }, [state.query, state.group]);

  /** 点击行复制「404 Not Found」格式：排查日志、贴群、写工单都直接可用 */
  const copyRow = React.useCallback(async (entry: HttpStatusEntry): Promise<void> => {
    const text = `${entry.code} ${entry.name}`;
    const ok = await copyText(text);
    if (ok) {
      toast.success(`已复制 ${text}`);
    } else {
      toast.error('复制失败，请手动复制');
    }
  }, []);

  // 标题栏一键复制：全表按行拼（code + name），过滤与否都给完整表
  const allCopy = React.useMemo(
    () => HTTP_STATUS.map((entry) => `${entry.code} ${entry.name}`).join('\n'),
    [],
  );

  const samples: readonly SampleEntry[] = [
    {
      label: '404',
      description: '最常用的排查起点：资源不存在',
      apply: () => {
        patch({ query: '404' });
      },
    },
    {
      label: '429',
      description: '触发限流时的标准返回',
      apply: () => {
        patch({ query: '429' });
      },
    },
    {
      label: '502',
      description: '网关从上游拿到无效响应',
      apply: () => {
        patch({ query: '502' });
      },
    },
    {
      label: '301',
      description: '永久重定向，SEO 权重转移',
      apply: () => {
        patch({ query: '301' });
      },
    },
  ];

  return (
    <CommandShell
      title="HTTP 状态码速查"
      onPaste={(t) => patch({ query: t })}
      description="1xx-5xx 常用状态码：过滤 / 分组 / 点击复制"
      icon={<BookOpenIcon className="h-4 w-4" />}
      onBack={shell.onBack}
      favorite={shell.favorite}
      onToggleFavorite={shell.onToggleFavorite}
      copyText={allCopy}
      shortcutHint="点击行复制「404 Not Found」格式 · 标题栏复制全表（Esc 返回）"
      samples={samples}
    >
      <div className="flex flex-col gap-3">
        {/* 过滤框：数字 / 文本均可，匹配 code / name / 中文说明 */}
        <input
          type="text"
          autoFocus
          value={state.query}
          onChange={(event) => patch({ query: event.target.value })}
          placeholder="过滤：状态码 / 名称 / 说明，如 404、redirect、限流"
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />

        {/* 分组 chips（带计数） */}
        <div className="flex flex-wrap items-center gap-1.5">
          {GROUP_META.map((meta) => (
            <Button
              key={meta.id}
              size="sm"
              variant={state.group === meta.id ? 'default' : 'outline'}
              className="h-7 px-2.5 text-xs"
              onClick={() => patch({ group: meta.id })}
            >
              {meta.label}
              <span className="ml-0.5 font-mono">
                {meta.id === 'all' ? HTTP_STATUS.length : GROUP_COUNTS[meta.id]}
              </span>
            </Button>
          ))}
        </div>

        <div className="text-xs text-muted-foreground">
          共 {filtered.length} 条
          {state.query.trim() || state.group !== 'all' ? `（已过滤，全表 ${HTTP_STATUS.length} 条）` : ''}
        </div>

        {/* 列表：每行是原生 button —— Tab 聚焦 + Enter 即复制，行尾图标仅装饰 */}
        <div className="scrollbar-thin max-h-[460px] overflow-auto rounded-xl border border-border bg-card shadow-card">
          <div className="divide-y divide-border/70">
            {filtered.map((entry) => (
              <button
                key={entry.code}
                type="button"
                onClick={() => void copyRow(entry)}
                title={`点击复制「${entry.code} ${entry.name}」`}
                aria-label={`复制 ${entry.code} ${entry.name}`}
                className="grid w-full grid-cols-[64px_230px_1fr_16px] items-center gap-3 px-3 py-2 text-left transition last:rounded-b-xl hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                <span
                  className={cn(
                    'inline-flex h-6 items-center justify-center rounded-md px-1 font-mono text-xs font-semibold',
                    GROUP_BADGE[entry.group],
                  )}
                >
                  {entry.code}
                </span>
                <span className="truncate text-sm font-medium text-foreground">{entry.name}</span>
                <span className="truncate text-sm text-muted-foreground">{entry.summary}</span>
                <Copy aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground/50" />
              </button>
            ))}
            {filtered.length === 0 ? (
              <div className="px-3 py-10 text-center text-sm text-muted-foreground">没有匹配的状态码</div>
            ) : null}
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground">
          覆盖 1xx-5xx 常用码与 418 彩蛋；4xx 含 WebDAV 扩展（422 / 423 / 424），451 为法律原因不可用。
        </p>
      </div>
    </CommandShell>
  );
}

export default HttpStatus;

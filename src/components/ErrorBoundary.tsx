/**
 * 渲染错误边界（V37）。
 *
 * React 的渲染期错误会让**整棵子树卸载**，用户看到的是白屏 —— 而白屏是最难排查的
 * 一种表现：没有提示、没有弹窗、不看控制台什么都不知道。这里做两件事：
 *   ① 给出一个能看懂、能重试的兜底界面；
 *   ② 把错误连组件栈一起写进统一日志（`handy.log`），用户可以直接回传。
 */
import React from 'react';
import { reportReactError } from '@/lib/errorSink';

interface Props {
  children: React.ReactNode;
  /** 出错时显示的范围名（哪个窗口 / 哪块区域崩了） */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    reportReactError(error, info.componentStack ?? '');
  }

  override render(): React.ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-neutral-900 p-6 text-center">
        <p className="text-sm font-medium text-neutral-100">
          {this.props.label ?? '界面'}出错了
        </p>
        <p className="max-w-md break-all text-xs leading-relaxed text-neutral-400">
          {error.message}
        </p>
        <p className="text-[11px] leading-relaxed text-neutral-500">
          详细信息已写进日志（设置 → 诊断 → 打开日志目录），
          <br />
          发给我就能定位。
        </p>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="rounded bg-neutral-700 px-3 py-1 text-xs text-neutral-100 hover:bg-neutral-600"
        >
          重试
        </button>
      </div>
    );
  }
}

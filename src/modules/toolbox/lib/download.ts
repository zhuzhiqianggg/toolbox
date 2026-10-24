/**
 * 浏览器原生文件下载（Blob + Object URL + `<a download>`）。
 *
 * 为什么不用 Tauri fs 插件：fs 需要额外的权限配置（`tauri.conf.json` + capabilities），
 * 且在浏览器环境（我们的冒烟测试就在浏览器里跑）完全不可用。
 * Blob 方案在浏览器与 Tauri WebView 下行为一致，零依赖、零权限。
 */

/** 生成 `YYYYMMDD-HHmmss` 形式的时间戳后缀（用于默认文件名）。 */
export function timestampSuffix(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * 触发一次文本文件下载。
 *
 * @param filename 下载文件名（含扩展名）
 * @param content 文件内容
 * @param mimeType MIME 类型，默认 `text/plain;charset=utf-8`
 * @returns 是否成功触发（失败时返回 false，调用方负责 toast 提示）
 */
export function downloadTextFile(
  filename: string,
  content: string,
  mimeType = 'text/plain;charset=utf-8',
): boolean {
  try {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    // 延迟释放：部分浏览器在 click 后仍需短暂持有 URL
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

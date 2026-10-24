/**
 * 诊断收集器：接收 webview 的 beacon POST，全部落盘。
 * 用途：当 Tauri invoke 通道疑似整体失效时，提供不依赖 IPC 的诊断回传。
 * 启动：node diag-collector.mjs  （Ctrl+C 结束）
 */
import http from 'node:http';
import fs from 'node:fs';

const PORT = 9321;
const OUT = 'D:/Personal/Projects/toolbox/.build-logs/diag_beacon.log';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const line = `[${new Date().toISOString()}] ${req.url} ${body.slice(0, 2000)}`;
    console.log(line);
    fs.appendFileSync(OUT, line + '\n');
    res.writeHead(204);
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`diag-collector on ${PORT} -> ${OUT}`));

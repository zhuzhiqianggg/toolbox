/**
 * 临时静态服务（仅用于 V18 浏览器冒烟验证，非产品代码）。
 * 用 `node scripts/dev-static.cjs <port>` 启动，指向 dist 目录。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 41777);
const root = path.resolve(__dirname, '..', 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.join(root, rel);
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`dev-static listening on http://127.0.0.1:${port} (root=${root})`);
  });

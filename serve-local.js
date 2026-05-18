const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.argv[2]) || 8087;
const host = '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
};

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);
  const requestPath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const filePath = path.resolve(root, `.${requestPath}`);

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, host, () => {
  console.log(`Open http://${host}:${port}/depth-map.html`);
});

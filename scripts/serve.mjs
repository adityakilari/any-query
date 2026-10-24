// Local development server: npm start -> http://localhost:8080
// Rebuilds the page on every request, so edits show up on reload.
import http from 'node:http';
import { buildHtml } from './build.mjs';

const port = Number(process.env.PORT || 8080);
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x').pathname;
  if (url !== '/' && url !== '/index.html') { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
  try {
    const html = await buildHtml();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(html);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err && err.stack || err));
  }
}).listen(port, () => console.log(`Any Query running at http://localhost:${port}`));

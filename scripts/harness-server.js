// Serves src/ over http so the renderer harness (src/_harness.html) can be
// opened in a browser. The Browser pane can't run file:// pages — they load as
// static snapshots with no JavaScript — so the harness needs a real server.
//
//   node scripts/harness-server.js     -> http://localhost:5178
//
// Wired up as the "stash-harness" config in .claude/launch.json.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
const PORT = Number(process.env.PORT) || 5178;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/_harness.html';
  const file = path.resolve(ROOT, '.' + rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('nope');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // The harness page is generated and gitignored, so a fresh clone has the
      // server but not the page it serves. Say so rather than a bare 404.
      if (rel === '/_harness.html') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
           .end(`src/_harness.html has not been built yet.

Run:  npm run harness
`);
        return;
      }
      res.writeHead(404).end('not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}).listen(PORT, () => console.log('harness on http://localhost:' + PORT));

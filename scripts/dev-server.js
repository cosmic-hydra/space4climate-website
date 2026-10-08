#!/usr/bin/env node
/**
 * Local preview server: serves space4climate/ like Vercel does, follows the same-site
 * redirects in vercel.json, and runs the real /api/orbit handler with a file-backed store.
 *
 *   node scripts/dev-server.js          (PORT defaults to 8081)
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SITE = path.join(ROOT, 'space4climate');
const PORT = Number(process.env.PORT) || 8081;

const orbit = require(path.join(ROOT, 'api', 'orbit.js'));
const store = new orbit.MemoryStore(path.join(SITE, '.orbit-data', 'commonboard-dev.json'));
const orbitHandler = orbit.createHandler(store);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
};

function loadRedirects() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    return (config.redirects || [])
      .filter((r) => !/^https?:\/\//.test(r.destination || ''))
      .map((r) => {
        const pattern = r.source.replace(/:\w+\*/g, '(.*)').replace(/\.(?!\*)/g, '\\.');
        return { re: new RegExp('^' + pattern + '$'), destination: r.destination };
      });
  } catch {
    return [];
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function serveStatic(req, res, pathname) {
  let rel = safeDecode(pathname);
  if (rel == null) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad request');
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(SITE, rel));
  if (!file.startsWith(SITE + path.sep) || rel.split('/').some((part) => part.startsWith('.') && part.length > 1)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.replace(/\/$/, '') === '/api/orbit') return orbitHandler(req, res);
    if (req.method === 'GET' || req.method === 'HEAD') {
      const decoded = safeDecode(url.pathname) || url.pathname;
      const hit = loadRedirects().find((r) => r.re.test(decoded));
      if (hit) {
        // 307 locally so browsers don't cache redirects while developing
        res.writeHead(307, { Location: hit.destination, 'Content-Length': 0 });
        return res.end();
      }
      return serveStatic(req, res, url.pathname);
    }
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`Serving Space4Climate on http://localhost:${PORT}/ (CommonBoard storage: ${store.kind})`);
  });

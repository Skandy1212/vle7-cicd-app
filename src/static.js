'use strict';
// Tiny static file server with path-traversal protection and security headers.
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

// mounts: [{ prefix: '/shared/', dir: '/abs/path' }], fallback dir serves '/'
function serveStatic(req, res, pathname, rootDir, mounts = []) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let dir = rootDir;
  let rel = pathname;
  for (const m of mounts) {
    if (pathname.startsWith(m.prefix)) { dir = m.dir; rel = pathname.slice(m.prefix.length - 1); }
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return false; }
  if (decoded.includes('\0')) return false;
  const file = path.resolve(dir, '.' + decoded);
  if (file !== dir && !file.startsWith(dir + path.sep)) return false;
  let data;
  try {
    if (!fs.statSync(file).isFile()) return false;
    data = fs.readFileSync(file);
  } catch { return false; }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-cache',
    ...HEADERS,
  });
  res.end(req.method === 'HEAD' ? undefined : data);
  return true;
}

module.exports = { serveStatic };

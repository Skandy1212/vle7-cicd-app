'use strict';
// GATEWAY role: the public entry point (:30080). Authenticates, routes each login to its shard,
// writes through to the backup, and fails over to the backup when a shard cannot serve.
const http = require('http');
const path = require('path');
const C = require('./common');
const { serveStatic } = require('./static');
const { hydrate, evict } = require('./sync');

const BACKUP = process.env.BACKUP_URL || 'http://backup:3000';
const RECONCILE_MS = Number(process.env.RECONCILE_MS || 3000);
const PUBLIC = process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public');
const APP_DIR = path.join(PUBLIC, 'app');
const MOUNTS = [{ prefix: '/shared/', dir: path.join(PUBLIC, 'shared') }];
const COOKIE = 'vle7_session';

// Cache of the backup's routing table. Lets shards keep serving even if the backup is briefly down.
const cache = { routes: {}, revs: {}, shards: {}, settings: { autoheal: true }, loaded: false };
const backup = (p, opts = {}) => C.call(BACKUP + p, { internal: true, timeout: 2500, ...opts });

async function refreshState() {
  const r = await backup('/internal/state');
  if (r.status !== 200) throw new Error('state ' + r.status);
  cache.routes = r.json.routes; cache.revs = r.json.revs; cache.settings = r.json.settings;
  cache.shards = Object.fromEntries(r.json.shards.map((s) => [s.name, s.url]));
  cache.loaded = true;
}

async function probeHealthy() {
  const names = Object.keys(cache.shards);
  const res = await Promise.all(names.map((n) =>
    C.call(cache.shards[n] + '/healthz', { timeout: 800 }).then((r) => (r.status === 200 ? n : null)).catch(() => null)));
  return res.filter(Boolean);
}

// ---------- login throttle ----------
const fails = new Map(); // login -> { n, until }
function throttled(login) {
  const f = fails.get(login);
  return f && f.n >= 8 && Date.now() < f.until;
}
function noteFail(login) {
  const f = fails.get(login) || { n: 0, until: 0 };
  f.n++; f.until = Date.now() + 60_000;
  fails.set(login, f);
}

function userOf(req) {
  const p = C.verifyToken(C.parseCookies(req)[COOKIE], 'user');
  return p ? p.login : null;
}

async function routeOf(login) {
  if (Object.hasOwn(cache.routes, login)) return cache.routes[login];
  const r = await backup('/internal/data/' + encodeURIComponent(login));
  if (r.status === 404) throw C.bad('account no longer exists', 401);
  if (r.status !== 200) throw C.bad('state unavailable, try again', 503);
  cache.routes[login] = r.json.route; cache.revs[login] = r.json.rev;
  return r.json.route;
}

// Serve a read or a write for ONE login. The login comes only from the signed cookie.
async function serveStudents(login, op) {
  const route = await routeOf(login);
  const shardName = Object.hasOwn(cache.shards, route) ? route : null;
  const meta = { assigned: route, servedBy: 'backup', pod: null, reason: null };
  let list;

  if (op) {
    // Backup FIRST: it is the durable copy. If it is down, refuse rather than accept a write we could lose.
    let r;
    try { r = await backup('/internal/op/' + encodeURIComponent(login), { method: 'POST', body: { op } }); }
    catch { throw C.bad('backup is unreachable, writes are paused', 503); }
    if (r.status !== 200) throw C.bad((r.json && r.json.error) || 'write failed', r.status);
    list = r.json.list; cache.revs[login] = r.json.rev;
    meta.pod = 'backup';
    if (shardName) {
      try {
        const w = await C.call(cache.shards[shardName] + '/internal/data/' + encodeURIComponent(login), {
          method: 'PUT', internal: true, timeout: 1500, body: { list, rev: r.json.rev, create: false },
        });
        if (w.status === 200) { meta.servedBy = shardName; meta.pod = w.json.pod; }
        else meta.reason = w.status === 409 ? 'shard-empty' : 'shard-error';
      } catch { meta.reason = 'shard-unreachable'; }
    } else meta.reason = route.startsWith('parked:') ? 'parked' : 'no-shard';
    return { students: list, meta };
  }

  if (shardName) {
    try {
      const r = await C.call(cache.shards[shardName] + '/internal/data/' + encodeURIComponent(login), { internal: true, timeout: 1500 });
      if (r.status === 200 && r.json.has) {
        if (r.json.rev === cache.revs[login]) {
          return { students: r.json.list, meta: { ...meta, servedBy: shardName, pod: r.json.pod } };
        }
        meta.reason = 'shard-stale';
      } else meta.reason = 'shard-empty';
    } catch { meta.reason = 'shard-unreachable'; }
  } else meta.reason = route.startsWith('parked:') ? 'parked' : 'no-shard';

  const b = await backup('/internal/data/' + encodeURIComponent(login)).catch(() => null);
  if (!b || b.status !== 200) throw C.bad('no copy of your data is reachable right now', 503);
  cache.revs[login] = b.json.rev;
  return { students: b.json.list, meta: { ...meta, pod: 'backup' } };
}

async function api(req, res, url) {
  const m = req.method;
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

  if (m === 'POST' && (url.pathname === '/api/register' || url.pathname === '/api/login')) {
    const b = await C.readJson(req);
    const login = String(b.login || '').toLowerCase();
    const password = String(b.password || '');
    let out;
    if (url.pathname === '/api/register') {
      await refreshState().catch(() => {}); // see shards created a moment ago
      const healthy = await probeHealthy();
      const r = await backup('/internal/register', { method: 'POST', body: { login, password, healthy } }).catch(() => null);
      if (!r) throw C.bad('backup is unreachable, cannot create accounts right now', 503);
      if (r.status !== 200) throw C.bad((r.json && r.json.error) || 'could not register', r.status);
      out = r.json;
      cache.routes[login] = out.route; cache.revs[login] = 0;
      if (Object.hasOwn(cache.shards, out.route)) { // create the (empty) slot on the shard; the heal loop covers failures
        C.call(cache.shards[out.route] + '/internal/data/' + encodeURIComponent(login), {
          method: 'PUT', internal: true, timeout: 1500, body: { list: [], rev: 0, create: true },
        }).catch(() => {});
      }
    } else {
      if (throttled(login)) throw C.bad('too many failed attempts, wait a minute', 429);
      const r = await backup('/internal/auth', { method: 'POST', body: { login, password } }).catch(() => null);
      if (!r) throw C.bad('backup is unreachable, cannot sign in right now', 503);
      if (r.status === 401) { noteFail(login); throw C.bad('wrong login or password', 401); }
      if (r.status !== 200) throw C.bad('sign-in failed', r.status);
      fails.delete(login);
      out = r.json;
      cache.routes[login] = out.route; cache.revs[login] = out.rev;
    }
    return C.send(res, 200, { login, assigned: out.route },
      { 'set-cookie': C.sessionCookie(COOKIE, C.signToken({ login }, 'user')) });
  }
  if (m === 'POST' && url.pathname === '/api/logout') {
    return C.send(res, 200, { ok: true }, { 'set-cookie': C.sessionCookie(COOKIE, '', 0) });
  }

  const login = userOf(req);
  if (!login) return C.send(res, 401, { error: 'not signed in' });
  if (url.pathname === '/api/me' && m === 'GET') return C.send(res, 200, { login });

  if (parts[1] === 'students') {
    const op = m === 'GET' && parts.length === 2 ? null
      : C.opFromRequest(m, parts, m === 'POST' || m === 'PUT' ? await C.readJson(req) : {});
    const out = await serveStudents(login, op);
    return C.send(res, 200, { login, ...out });
  }
  return C.send(res, 404, { error: 'not found' });
}

// ---------- background reconcile: evict stray data, heal empty/stale shards ----------
let reconciling = false;
async function reconcile() {
  if (reconciling) return;
  reconciling = true;
  try {
    await refreshState();
    for (const [name, url] of Object.entries(cache.shards)) {
      let stats;
      try { const r = await C.call(url + '/internal/stats', { internal: true, timeout: 1000 }); if (r.status !== 200) continue; stats = r.json; }
      catch { continue; }
      for (const login of Object.keys(stats.logins)) {
        if (cache.routes[login] !== name) await evict(url, login).catch(() => {}); // data must live only where it is routed
      }
      if (!cache.settings.autoheal) continue;
      for (const [login, route] of Object.entries(cache.routes)) {
        if (route !== name) continue;
        const have = stats.logins[login];
        if (!have || have.rev !== cache.revs[login]) await hydrate(url, BACKUP, login).catch(() => {});
      }
    }
  } catch { /* backup unreachable: keep the last known state */ }
  finally { reconciling = false; }
}

function start(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz' || url.pathname === '/livez') return C.send(res, 200, { ok: true, role: 'gateway', pod: C.HOST });
    if (url.pathname === '/internal/refresh' && req.method === 'POST') { // called by the control panel after re-routing
      if (!C.requireInternal(req, res)) return;
      return refreshState().then(() => C.send(res, 200, { ok: true }), () => C.send(res, 503, { error: 'backup unreachable' }));
    }
    const done = url.pathname.startsWith('/api/')
      ? api(req, res, url)
      : Promise.resolve(serveStatic(req, res, url.pathname, APP_DIR, MOUNTS) || C.send(res, 404, { error: 'not found' }));
    done.catch((e) => {
      if (!res.headersSent) C.send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
      if (!e.status) console.error('gateway error:', e);
    });
  });
  server.listen(port, () => console.log(`gateway listening on :${port}, backup at ${BACKUP}`));
  refreshState().catch(() => {});
  setInterval(reconcile, RECONCILE_MS).unref();
  return server;
}
module.exports = { start };

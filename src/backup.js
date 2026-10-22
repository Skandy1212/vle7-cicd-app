'use strict';
// BACKUP role: the durable source of truth. Holds accounts, the routing table and ALL data.
// It never returns another login's data: every data call is scoped to one login in the URL.
const http = require('http');
const path = require('path');
const C = require('./common');

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'state.json');

const empty = () => ({
  accounts: {}, routes: {}, revs: {}, data: {},
  shards: [], nextShard: 1, settings: { autoheal: true, bootstrapped: false },
});
const S = Object.assign(empty(), C.loadJson(FILE, {}));
S.settings = Object.assign({ autoheal: true, bootstrapped: false }, S.settings);
const save = () => C.saveJson(FILE, S);
const startedAt = Date.now();
// Records analytics for Prometheus/Grafana (anonymous aggregates), served on the metrics port.
require('./metrics').addCollector(() => require('./recordmetrics').render(S));

const shardNum = (n) => Number(String(n).replace('shard-', '')) || 0;

// Least-loaded shard; ties go to the lowest number. `counts` is mutated by callers that assign repeatedly.
function leastLoaded(candidates, counts) {
  let best = null;
  for (const n of [...candidates].sort((a, b) => shardNum(a) - shardNum(b))) {
    if (best === null || (counts[n] || 0) < (counts[best] || 0)) best = n;
  }
  return best;
}
function routeCounts() {
  const counts = {};
  for (const s of S.shards) counts[s.name] = 0;
  for (const r of Object.values(S.routes)) if (r in counts) counts[r]++;
  return counts;
}
// Prefer shards the caller says are healthy; fall back to every registered shard.
function pool(healthy, exclude) {
  const all = S.shards.map((s) => s.name).filter((n) => n !== exclude);
  const ok = Array.isArray(healthy) ? all.filter((n) => healthy.includes(n)) : [];
  return ok.length ? ok : all;
}

const dummy = { salt: '00'.repeat(16), hash: '00'.repeat(32) };
const dummyReady = C.hashPassword('x', dummy.salt).then((h) => { dummy.hash = h.hash; });

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const parts = p.split('/').filter(Boolean); // ['internal', ...]
  if (p === '/healthz' || p === '/livez') return C.send(res, 200, { ok: true, role: 'backup', pod: C.HOST });
  if (parts[0] !== 'internal') return C.send(res, 404, { error: 'not found' });
  if (!C.requireInternal(req, res)) return;
  const m = req.method;
  const body = (m === 'GET' || m === 'DELETE') ? {} : await C.readJson(req);

  if (m === 'GET' && p === '/internal/stats') {
    return C.send(res, 200, {
      pod: C.HOST, accounts: Object.keys(S.accounts).length,
      records: Object.values(S.data).reduce((n, l) => n + l.length, 0),
      shards: S.shards.length, uptime: Math.round((Date.now() - startedAt) / 1000),
    });
  }
  // Anonymous rows for the control panel's analytics: no names, no reg numbers, no logins.
  if (m === 'GET' && p === '/internal/analytics') {
    const rows = [];
    for (const [login, list] of Object.entries(S.data)) {
      const route = S.routes[login] || 'unassigned';
      for (const r of list) rows.push({ route, age: r.age, gender: r.gender, course: r.course, year: r.year, residence: r.residence, marks: r.marks, attendance: r.attendance });
    }
    const accounts = {};
    for (const route of Object.values(S.routes)) accounts[route] = (accounts[route] || 0) + 1;
    return C.send(res, 200, { rows, accounts, shards: S.shards.map((x) => x.name) });
  }
  if (m === 'GET' && p === '/internal/state') {
    return C.send(res, 200, {
      routes: S.routes, revs: S.revs, shards: S.shards, nextShard: S.nextShard, settings: S.settings,
      counts: Object.fromEntries(Object.keys(S.data).map((l) => [l, S.data[l].length])),
    });
  }

  if (m === 'POST' && p === '/internal/register') {
    const login = String(body.login || '').toLowerCase();
    const pw = String(body.password || '');
    if (!C.LOGIN_RE.test(login)) throw C.bad('login must be 3-20 chars: a-z, 0-9, _ (start with a letter)');
    if (pw.length < 6 || pw.length > 100) throw C.bad('password must be 6-100 characters');
    if (Object.hasOwn(S.accounts, login)) throw C.bad('that login is taken', 409);
    if (Object.keys(S.accounts).length >= 300) throw C.bad('this demo is full: no more accounts can be created', 503);
    const route = leastLoaded(pool(body.healthy), routeCounts()) || 'parked:unassigned';
    const h = await C.hashPassword(pw);
    if (Object.hasOwn(S.accounts, login)) throw C.bad('that login is taken', 409); // re-check after the await
    S.accounts[login] = { ...h, created: Date.now() };
    S.routes[login] = route; S.revs[login] = 0; S.data[login] = [];
    save();
    return C.send(res, 200, { login, route, rev: 0 });
  }
  if (m === 'POST' && p === '/internal/auth') {
    const login = String(body.login || '').toLowerCase();
    const acct = Object.hasOwn(S.accounts, login) ? S.accounts[login] : null;
    await dummyReady;
    const ok = await C.checkPassword(String(body.password || ''), (acct || dummy).salt, (acct || dummy).hash);
    if (!acct || !ok) return C.send(res, 401, { error: 'wrong login or password' });
    return C.send(res, 200, { login, route: S.routes[login], rev: S.revs[login] });
  }

  if (parts[1] === 'data' && parts[2]) {
    const login = parts[2];
    if (!Object.hasOwn(S.accounts, login)) return C.send(res, 404, { error: 'no such account' });
    if (m === 'GET') return C.send(res, 200, { list: S.data[login], rev: S.revs[login], route: S.routes[login] });
  }
  if (m === 'POST' && parts[1] === 'op' && parts[2]) {
    const login = parts[2];
    if (!Object.hasOwn(S.accounts, login)) return C.send(res, 404, { error: 'no such account' });
    S.data[login] = C.applyOp(S.data[login], body.op); // throws on invalid; nothing changed then
    S.revs[login]++;
    save();
    return C.send(res, 200, { list: S.data[login], rev: S.revs[login], route: S.routes[login] });
  }

  // ---- shard registry ----
  if (m === 'POST' && p === '/internal/shards/allocate') {
    const name = 'shard-' + S.nextShard++;
    save();
    return C.send(res, 200, { name });
  }
  if (m === 'POST' && p === '/internal/shards') {
    if (!/^shard-\d+$/.test(String(body.name)) || !/^http:\/\//.test(String(body.url))) throw C.bad('invalid shard');
    S.shards = S.shards.filter((s) => s.name !== body.name);
    S.shards.push({ name: body.name, url: body.url, created: Date.now() });
    S.nextShard = Math.max(S.nextShard, shardNum(body.name) + 1);
    save();
    return C.send(res, 200, { ok: true });
  }
  if (m === 'DELETE' && parts[1] === 'shards' && parts[2]) {
    const name = parts[2];
    const stillRouted = Object.values(S.routes).filter((r) => r === name).length;
    if (stillRouted) throw C.bad(`${stillRouted} account(s) are still routed to ${name}`, 409);
    S.shards = S.shards.filter((s) => s.name !== name);
    save();
    return C.send(res, 200, { ok: true });
  }

  // ---- bulk re-routing: `from` is a route key (a shard name or "parked:<group>") ----
  if (m === 'POST' && p === '/internal/reassign') {
    const from = String(body.from || '');
    const logins = Object.keys(S.routes).filter((l) => S.routes[l] === from).sort();
    const moved = {};
    if (body.mode === 'park') {
      if (from.startsWith('parked:')) throw C.bad('already parked');
      for (const l of logins) S.routes[l] = moved[l] = 'parked:' + from;
    } else if (body.mode === 'to') {
      if (!S.shards.some((s) => s.name === body.to)) throw C.bad('target shard is not registered', 409);
      for (const l of logins) S.routes[l] = moved[l] = body.to;
    } else if (body.mode === 'move') {
      const targets = pool(body.healthy, from);
      if (!targets.length) throw C.bad('no other shard to move accounts to', 409);
      const counts = routeCounts();
      for (const l of logins) {
        const t = leastLoaded(targets, counts);
        counts[from] = Math.max(0, (counts[from] || 0) - 1);
        counts[t] = (counts[t] || 0) + 1;
        S.routes[l] = moved[l] = t;
      }
    } else throw C.bad('unknown mode');
    save();
    return C.send(res, 200, { moved });
  }
  if (m === 'POST' && p === '/internal/settings') {
    if (typeof body.autoheal === 'boolean') S.settings.autoheal = body.autoheal;
    if (typeof body.bootstrapped === 'boolean') S.settings.bootstrapped = body.bootstrapped;
    save();
    return C.send(res, 200, S.settings);
  }
  return C.send(res, 404, { error: 'not found' });
}

function start(port) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) C.send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
      if (!e.status) console.error('backup error:', e);
    });
  });
  server.listen(port, () => console.log(`backup listening on :${port}, state file ${FILE}`));
  return server;
}
module.exports = { start };

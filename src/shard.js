'use strict';
// SHARD role: holds the data of the logins routed to it. A shard is a serving copy; the backup is the truth.
// Data is kept in DATA_DIR (an emptyDir in Kubernetes): it survives a container crash but NOT a pod deletion.
const http = require('http');
const path = require('path');
const C = require('./common');

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'shard.json');
let held = C.loadJson(FILE, {});           // { login: { list, rev } }
let failHealth = false;                    // when true, /healthz returns 503 (readiness probe fails)
const startedAt = Date.now();
const save = () => C.saveJson(FILE, held);

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const parts = p.split('/').filter(Boolean);
  if (p === '/livez') return C.send(res, 200, { ok: true });
  if (p === '/healthz') {
    return failHealth ? C.send(res, 503, { ok: false, reason: 'health forced off' }) : C.send(res, 200, { ok: true, role: 'shard', pod: C.HOST });
  }
  if (parts[0] !== 'internal') return C.send(res, 404, { error: 'not found' });
  if (!C.requireInternal(req, res)) return;
  const m = req.method;

  if (m === 'GET' && p === '/internal/stats') {
    const logins = {};
    let records = 0;
    for (const [l, v] of Object.entries(held)) { logins[l] = { count: v.list.length, rev: v.rev }; records += v.list.length; }
    return C.send(res, 200, { pod: C.HOST, logins, records, failHealth, uptime: Math.round((Date.now() - startedAt) / 1000) });
  }
  if (parts[1] === 'data' && parts[2]) {
    const login = parts[2];
    if (!C.LOGIN_RE.test(login)) throw C.bad('invalid login');
    if (m === 'GET') {
      const v = held[login];
      return C.send(res, 200, v ? { has: true, list: v.list, rev: v.rev, pod: C.HOST } : { has: false, pod: C.HOST });
    }
    if (m === 'PUT') {
      const b = await C.readJson(req);
      const cur = held[login];
      if (!cur && !b.create) return C.send(res, 409, { error: 'not-held' });
      const rev = Number(b.rev);
      if (!Number.isInteger(rev) || rev < 0) throw C.bad('invalid rev');
      if (cur && rev < cur.rev) return C.send(res, 409, { error: 'older-than-held' });
      held[login] = { list: C.validList(b.list), rev };
      save();
      return C.send(res, 200, { ok: true, rev, pod: C.HOST });
    }
    if (m === 'DELETE') { delete held[login]; save(); return C.send(res, 200, { ok: true }); }
  }
  if (m === 'POST' && p === '/internal/erase') { held = {}; save(); return C.send(res, 200, { ok: true }); }
  if (m === 'POST' && p === '/internal/fail-health') {
    const b = await C.readJson(req);
    failHealth = !!b.on;
    return C.send(res, 200, { failHealth });
  }
  if (m === 'POST' && p === '/internal/crash') {
    C.send(res, 200, { ok: true, note: 'exiting with code 1' });
    setTimeout(() => process.exit(1), 50);
    return;
  }
  return C.send(res, 404, { error: 'not found' });
}

function start(port) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) C.send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
      if (!e.status) console.error('shard error:', e);
    });
  });
  server.listen(port, () => console.log(`shard ${C.HOST} listening on :${port}`));
  return server;
}
module.exports = { start };

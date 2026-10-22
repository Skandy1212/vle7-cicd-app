'use strict';
// CONTROL role: the operator panel (:30090). Manual buttons: kill pod, erase data, stop/start, create/remove pods.
// Protected by an admin password and (in the cluster) a namespace-scoped ServiceAccount.
const http = require('http');
const path = require('path');
const C = require('./common');
const { serveStatic } = require('./static');
const { hydrate } = require('./sync');
const { K8sOrchestrator, LocalOrchestrator } = require('./orchestrator');

const PUBLIC = process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public');
const CONTROL_DIR = path.join(PUBLIC, 'control');
const MOUNTS = [{ prefix: '/shared/', dir: path.join(PUBLIC, 'shared') }];
const COOKIE = 'vle7_admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_PASSWORD) { console.error('FATAL: ADMIN_PASSWORD must be set'); process.exit(1); }

const orch = process.env.ORCHESTRATOR === 'local' ? new LocalOrchestrator() : new K8sOrchestrator();
const gatewayUrl = () => (orch.kind === 'local' ? `http://127.0.0.1:${orch.portBase}` : 'http://gateway:3000');
const backup = (p, opts = {}) => C.call(orch.backupUrl + p, { internal: true, timeout: 2500, ...opts });
const shardCall = (url, p, opts = {}) => C.call(url + p, { internal: true, timeout: 1500, ...opts });

// ---------- activity log ----------
const events = [];
const log = (msg) => { events.unshift({ t: Date.now(), msg }); events.length = Math.min(events.length, 60); console.log('[control]', msg); };

// ---------- helpers ----------
async function getState() {
  const r = await backup('/internal/state');
  if (r.status !== 200) throw C.bad('backup is not reachable, so the routing table cannot be read', 503);
  return r.json;
}
async function mustBackup(p, opts) {
  const r = await backup(p, opts);
  if (p.startsWith('/internal/reassign') && r.status === 200) await C.call(gatewayUrl() + '/internal/refresh', { method: 'POST', body: {}, internal: true, timeout: 2500 }).catch(() => {});
  if (r.status !== 200) throw C.bad((r.json && r.json.error) || `backup error ${r.status}`, r.status === 404 ? 404 : r.status >= 500 ? 502 : r.status);
  return r.json;
}
async function healthyShards(st) {
  const res = await Promise.all(st.shards.map((s) => C.call(s.url + '/healthz', { timeout: 800 }).then((r) => (r.status === 200 ? s.name : null)).catch(() => null)));
  return res.filter(Boolean);
}
function shardOf(st, name) {
  const s = st.shards.find((x) => x.name === name);
  if (!s) throw C.bad('no such shard: ' + name, 404);
  return s;
}
const loginsOn = (st, route) => Object.keys(st.routes).filter((l) => st.routes[l] === route).sort();

// Push data from the backup into a shard once its pod is ready (does not block the HTTP response).
function hydrateInBackground(url, logins, label) {
  if (!logins.length) return;
  (async () => {
    const deadline = Date.now() + 90_000;
    let done = 0;
    for (const login of logins) {
      while (Date.now() < deadline) {
        try { await hydrate(url, orch.backupUrl, login); done++; break; } catch { await C.sleep(1000); }
      }
    }
    log(`${label}: restored ${done}/${logins.length} account(s) from the backup`);
  })().catch(() => {});
}

async function createShard() {
  const { name } = await mustBackup('/internal/shards/allocate', { method: 'POST', body: {} });
  let url;
  try { url = await orch.createShard(name); }
  catch (e) { log(`creating ${name} failed: ${e.message}`); throw C.bad(`could not create ${name}: ${e.message}`, 502); }
  await mustBackup('/internal/shards', { method: 'POST', body: { name, url } });
  return { name, url };
}

// ---------- actions ----------
async function actCreate(b) {
  const mode = b.mode === 'recover' ? 'recover' : 'fresh';
  let logins = [];
  if (mode === 'recover') {
    const st = await getState();
    logins = loginsOn(st, 'parked:' + String(b.group));
    if (!logins.length) throw C.bad('nothing is parked under that name', 409);
  }
  const { name, url } = await createShard();
  if (mode === 'recover') {
    await mustBackup('/internal/reassign', { method: 'POST', body: { from: 'parked:' + b.group, mode: 'to', to: name } });
    hydrateInBackground(url, logins, name);
    log(`created ${name} and recovered ${logins.length} parked account(s) from "${b.group}"`);
    return { name, recovered: logins.length };
  }
  log(`created ${name} (fresh, empty)`);
  return { name, recovered: 0 };
}

async function actRemove(name, b) {
  const st = await getState();
  const shard = shardOf(st, name);
  const logins = loginsOn(st, name);
  const strategy = b.strategy;
  if (logins.length && !['replace', 'move', 'park'].includes(strategy)) {
    return { status: 409, body: { needsStrategy: true, accounts: logins, error: `${name} holds ${logins.length} account(s): choose what happens to them` } };
  }
  let summary = `removed ${name} (no accounts)`;
  if (logins.length) {
    if (strategy === 'replace') {
      const fresh = await createShard();
      await mustBackup('/internal/reassign', { method: 'POST', body: { from: name, mode: 'to', to: fresh.name } });
      hydrateInBackground(fresh.url, logins, fresh.name);
      summary = `removed ${name}; replaced by ${fresh.name} holding the same ${logins.length} account(s)`;
    } else if (strategy === 'move') {
      const healthy = (await healthyShards(st)).filter((n) => n !== name);
      const { moved } = await mustBackup('/internal/reassign', { method: 'POST', body: { from: name, mode: 'move', healthy } });
      const st2 = await getState();
      const byTarget = {};
      for (const [l, t] of Object.entries(moved)) (byTarget[t] ||= []).push(l);
      for (const [t, ls] of Object.entries(byTarget)) hydrateInBackground(shardOf(st2, t).url, ls, t);
      summary = `removed ${name}; moved ${logins.length} account(s) to ${Object.entries(byTarget).map(([t, ls]) => `${t} (${ls.length})`).join(', ')}`;
    } else {
      await mustBackup('/internal/reassign', { method: 'POST', body: { from: name, mode: 'park' } });
      summary = `removed ${name}; ${logins.length} account(s) parked in the backup as "${name}" (served by the backup until recovered)`;
    }
  }
  await orch.deleteShard(name);
  await mustBackup('/internal/shards/' + name, { method: 'DELETE' });
  log(summary);
  return { status: 200, body: { ok: true, summary, shard: shard.name } };
}

async function actShard(name, action, b) {
  const st = await getState();
  const shard = shardOf(st, name);
  switch (action) {
    case 'kill': await orch.killPods(name); log(`deleted the pod of ${name} (Kubernetes will create a new, empty one)`); return {};
    case 'crash': await shardCall(shard.url, '/internal/crash', { method: 'POST', body: {} }).catch(() => {}); log(`crashed the container of ${name} (same pod restarts, emptyDir survives)`); return {};
    case 'erase': await shardCall(shard.url, '/internal/erase', { method: 'POST', body: {} }); log(`erased all data held by ${name}`); return {};
    case 'stop': await orch.scale(name, 0); log(`stopped ${name} (scaled to 0 replicas)`); return {};
    case 'start': await orch.scale(name, 1); log(`started ${name} (scaled to 1 replica)`); return {};
    case 'fail-health': {
      const on = !!b.on;
      await shardCall(shard.url, '/internal/fail-health', { method: 'POST', body: { on } });
      log(`${name} health check forced ${on ? 'to FAIL (readiness probe will pull it from the Service)' : 'back to normal'}`);
      return {};
    }
    case 'resync': {
      const logins = loginsOn(st, name);
      let n = 0;
      for (const l of logins) { await hydrate(shard.url, orch.backupUrl, l); n++; }
      log(`resynced ${name} from the backup (${n} account(s))`);
      return { restored: n };
    }
    default: throw C.bad('unknown action', 404);
  }
}

async function actCore(name, action) {
  if (!['backup', 'gateway'].includes(name)) throw C.bad('unknown component', 404);
  if (action === 'kill') { await orch.killPods(name); log(`deleted the pod of ${name}`); }
  else if (action === 'stop') { await orch.scale(name, 0); log(`stopped ${name}`); }
  else if (action === 'start') { await orch.scale(name, 1); log(`started ${name}`); }
  else throw C.bad('unknown action', 404);
  return {};
}

// ---------- overview ----------
async function overview() {
  const bs = await Promise.all([
    backup('/internal/state').catch(() => null),
    backup('/internal/stats').catch(() => null),
    orch.describe('backup'), orch.describe('gateway'),
    C.call(orch.backupUrl + '/healthz', { timeout: 800 }).catch(() => null),
    C.call(gatewayUrl() + '/healthz', { timeout: 800 }).catch(() => null),
  ]);
  const st = bs[0] && bs[0].status === 200 ? bs[0].json : null;
  const bstats = bs[1] && bs[1].status === 200 ? bs[1].json : null;
  const out = {
    orchestrator: orch.kind,
    backup: { ...bs[2], healthy: !!(bs[4] && bs[4].status === 200), stats: bstats },
    gateway: { ...bs[3], healthy: !!(bs[5] && bs[5].status === 200) },
    settings: st ? st.settings : null, shards: [], parked: [], events,
  };
  if (!st) return out;
  out.shards = await Promise.all(st.shards.map(async (s) => {
    const [d, h, stats] = await Promise.all([
      orch.describe(s.name),
      C.call(s.url + '/healthz', { timeout: 800 }).catch(() => null),
      shardCall(s.url, '/internal/stats', { timeout: 1000 }).catch(() => null),
    ]);
    const held = stats && stats.status === 200 ? stats.json : null;
    return {
      name: s.name, desired: d.desired, pods: d.pods,
      health: h ? (h.status === 200 ? 'ok' : 'failing') : 'down',
      failHealth: held ? held.failHealth : false,
      shardRecords: held ? held.records : null,
      accounts: loginsOn(st, s.name).map((l) => ({ login: l, records: st.counts[l] || 0, onShard: held ? (held.logins[l] ? held.logins[l].count : null) : null })),
    };
  }));
  const groups = {};
  for (const [l, r] of Object.entries(st.routes)) if (r.startsWith('parked:')) (groups[r.slice(7)] ||= []).push(l);
  out.parked = Object.entries(groups).map(([group, logins]) => ({ group, accounts: logins.sort().map((l) => ({ login: l, records: st.counts[l] || 0 })) }));
  return out;
}

// ---------- HTTP ----------
const fails = { n: 0, until: 0 };
function isAdmin(req) { return !!C.verifyToken(C.parseCookies(req)[COOKIE], 'admin'); }

async function api(req, res, url) {
  const m = req.method;
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  if (m === 'POST' && url.pathname === '/api/admin/login') {
    const b = await C.readJson(req);
    if (fails.n >= 8 && Date.now() < fails.until) throw C.bad('too many failed attempts, wait a minute', 429);
    const want = Buffer.from(ADMIN_PASSWORD), got = Buffer.from(String(b.password || ''));
    const ok = want.length === got.length && require('crypto').timingSafeEqual(want, got);
    if (!ok) { fails.n++; fails.until = Date.now() + 60_000; throw C.bad('wrong admin password', 401); }
    fails.n = 0;
    return C.send(res, 200, { ok: true }, { 'set-cookie': C.sessionCookie(COOKIE, C.signToken({ login: 'admin' }, 'admin', 4 * 3600), 4 * 3600) });
  }
  if (m === 'POST' && url.pathname === '/api/admin/logout') return C.send(res, 200, { ok: true }, { 'set-cookie': C.sessionCookie(COOKIE, '', 0) });
  if (!isAdmin(req)) return C.send(res, 401, { error: 'admin sign-in required' });
  if (m === 'GET' && url.pathname === '/api/admin/me') return C.send(res, 200, { ok: true, orchestrator: orch.kind });
  if (m === 'GET' && url.pathname === '/api/overview') return C.send(res, 200, await overview());
  if (m === 'GET' && url.pathname === '/api/analytics') {
    const r = await backup('/internal/analytics').catch(() => null);
    if (!r || r.status !== 200) throw C.bad('backup is unreachable, analytics unavailable', 503);
    return C.send(res, 200, r.json);
  }

  const body = m === 'POST' ? await C.readJson(req) : {};
  if (m === 'POST' && url.pathname === '/api/shards') return C.send(res, 200, await actCreate(body));
  if (m === 'POST' && parts[1] === 'shards' && /^shard-\d+$/.test(parts[2] || '') && parts[3]) {
    if (parts[3] === 'remove') { const r = await actRemove(parts[2], body); return C.send(res, r.status, r.body); }
    return C.send(res, 200, await actShard(parts[2], parts[3], body));
  }
  if (m === 'POST' && parts[1] === 'core' && parts[2] && parts[3]) return C.send(res, 200, await actCore(parts[2], parts[3]));
  if (m === 'POST' && url.pathname === '/api/settings') {
    const s = await mustBackup('/internal/settings', { method: 'POST', body: { autoheal: !!body.autoheal } });
    log(`auto-heal turned ${s.autoheal ? 'ON' : 'OFF'}`);
    return C.send(res, 200, s);
  }
  return C.send(res, 404, { error: 'not found' });
}

async function boot() {
  await orch.ensureCore();
  let st;
  for (let i = 0; i < 90; i++) { try { st = await getState(); break; } catch { await C.sleep(1000); } }
  if (!st) { console.error('backup never became reachable'); return; }
  for (const name of await orch.listShardNames()) { // adopt shards that exist but are not registered
    if (!st.shards.some((s) => s.name === name)) { await mustBackup('/internal/shards', { method: 'POST', body: { name, url: orch.shardUrl(name) } }); log(`adopted existing ${name}`); }
  }
  st = await getState();
  if (!st.settings.bootstrapped) {
    if (!st.shards.length) { await createShard(); await createShard(); log('bootstrapped shard-1 and shard-2'); }
    await mustBackup('/internal/settings', { method: 'POST', body: { bootstrapped: true } });
  }
}

function start(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/healthz' || url.pathname === '/livez') return C.send(res, 200, { ok: true, role: 'control', pod: C.HOST });
    const done = url.pathname.startsWith('/api/')
      ? api(req, res, url)
      : Promise.resolve(serveStatic(req, res, url.pathname, CONTROL_DIR, MOUNTS) || C.send(res, 404, { error: 'not found' }));
    done.catch((e) => {
      if (!res.headersSent) C.send(res, e.status || 500, { error: e.status ? e.message : 'internal error' });
      if (!e.status) console.error('control error:', e);
    });
  });
  server.listen(port, () => console.log(`control listening on :${port} (${orch.kind})`));
  boot().catch((e) => console.error('boot failed:', e));
  return server;
}
module.exports = { start };

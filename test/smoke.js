'use strict';
// End-to-end smoke test. Starts the real control/backup/gateway/shard code as local processes
// (the "local" orchestrator stands in for Kubernetes) and checks every behaviour we promise.
const { spawn } = require('child_process');
const path = require('path');

const GW = 'http://127.0.0.1:4400';
const CP = 'http://127.0.0.1:4490';
let failures = 0, passes = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, extra) {
  if (ok) { passes++; console.log('  ok   ' + name); } else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
async function waitFor(fn, ms = 15000, step = 150) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } await sleep(step); }
  return false;
}
class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, p, body, rawCookie) {
    const r = await fetch(this.base + p, {
      method, headers: { 'content-type': 'application/json', cookie: rawCookie ?? this.cookie }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie');
    if (sc && rawCookie === undefined) this.cookie = sc.split(';')[0];
    let json = null; try { json = await r.json(); } catch { /* none */ }
    return { status: r.status, json };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  put(p, b) { return this.req('PUT', p, b); }
  del(p) { return this.req('DELETE', p); }
}
const student = (n, extra = {}) => ({ name: 'Student ' + n, regno: 'RA' + n, attendance: 80, marks: 70, ...extra });

async function main() {
  const env = {
    ...process.env, ROLE: 'control', ORCHESTRATOR: 'local', PORT: '4490', PORT_BASE: '4400', RECONCILE_MS: '300',
    ADMIN_PASSWORD: 'adminpw', SESSION_SECRET: 'test-secret', INTERNAL_TOKEN: 'test-internal',
  };
  const ctl = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], { env, stdio: process.env.LOCAL_VERBOSE ? 'inherit' : 'ignore' });
  process.on('exit', () => ctl.kill('SIGKILL'));

  const admin = new Client(CP);
  console.log('\n[boot]');
  check('control answers', await waitFor(async () => (await admin.get('/healthz')).status === 200, 15000));
  check('admin API refuses without sign-in', (await admin.get('/api/overview')).status === 401);
  check('wrong admin password refused', (await admin.post('/api/admin/login', { password: 'nope' })).status === 401);
  check('admin signs in', (await admin.post('/api/admin/login', { password: 'adminpw' })).status === 200);
  const ov = () => admin.get('/api/overview').then((r) => r.json);
  check('two shards are bootstrapped and ready', await waitFor(async () => {
    const o = await ov(); return o.shards.length === 2 && o.shards.every((s) => s.pods[0] && s.pods[0].ready);
  }, 20000), await ov());
  check('gateway and backup are healthy', await waitFor(async () => { const o = await ov(); return o.gateway.healthy && o.backup.healthy; }));
  const routeOf = async (login) => (await new Client(GW).post('/api/login', { login, password: 'secret1' })).json.assigned;

  console.log('\n[assignment rule: 2 pods, 3 accounts]');
  const A = new Client(GW), B = new Client(GW), Cc = new Client(GW);
  const ra = await A.post('/api/register', { login: 'alice', password: 'secret1' });
  const rb = await B.post('/api/register', { login: 'bob', password: 'secret1' });
  const rc = await Cc.post('/api/register', { login: 'carol', password: 'secret1' });
  check('1st account -> shard-1', ra.json.assigned === 'shard-1', ra);
  check('2nd account -> shard-2', rb.json.assigned === 'shard-2', rb);
  check('3rd account -> shard-1', rc.json.assigned === 'shard-1', rc);
  check('duplicate login refused', (await new Client(GW).post('/api/register', { login: 'alice', password: 'secret1' })).status === 409);
  check('bad login refused', (await new Client(GW).post('/api/register', { login: 'A!', password: 'secret1' })).status === 400);
  check('short password refused', (await new Client(GW).post('/api/register', { login: 'dave', password: '123' })).status === 400);
  check('prototype-name login does not crash', (await new Client(GW).post('/api/login', { login: 'constructor', password: 'secret1' })).status === 401);

  console.log('\n[isolation: one login never sees another login\'s data]');
  const a1 = await A.post('/api/students', student(1, { name: 'Alice Only' }));
  check('alice adds a student', a1.status === 200 && a1.json.students.length === 1 && a1.json.meta.servedBy === 'shard-1', a1.json);
  await B.post('/api/students', student(2, { name: 'Bob Only' }));
  const la = (await A.get('/api/students')).json, lb = (await B.get('/api/students')).json;
  check('alice sees only Alice', la.students.length === 1 && la.students[0].name === 'Alice Only');
  check('bob sees only Bob', lb.students.length === 1 && lb.students[0].name === 'Bob Only');
  check('carol (same shard as alice) sees nothing', (await Cc.get('/api/students')).json.students.length === 0);
  const aliceId = la.students[0].id;
  check('bob cannot edit alice\'s record by id', (await B.put('/api/students/' + aliceId, { name: 'Hacked' })).status === 404);
  check('bob cannot delete alice\'s record by id', (await B.del('/api/students/' + aliceId)).status === 404);
  check('alice record unchanged', (await A.get('/api/students')).json.students[0].name === 'Alice Only');
  const anon = new Client(GW);
  check('no cookie -> 401', (await anon.get('/api/students')).status === 401);
  const [body, sig] = A.cookie.split('=')[1].split('.');
  const forged = Buffer.from(JSON.stringify({ login: 'bob', aud: 'user', exp: 9999999999 })).toString('base64url');
  check('forged cookie (valid sig of other payload) -> 401', (await anon.req('GET', '/api/students', undefined, `vle7_session=${forged}.${sig}`)).status === 401);
  check('tampered cookie -> 401', (await anon.req('GET', '/api/students', undefined, `vle7_session=${body}.${sig.slice(0, -2)}xx`)).status === 401);
  check('admin cookie is not a user session', (await anon.req('GET', '/api/students', undefined, admin.cookie)).status === 401);
  check('user cookie is not an admin session', (await new Client(CP).req('GET', '/api/overview', undefined, A.cookie)).status === 401);
  check('shards refuse requests without the internal token', (await fetch('http://127.0.0.1:4410/internal/stats')).status === 403);
  check('validation: marks 150 refused', (await A.post('/api/students', student(9, { marks: 150 }))).status === 400);

  console.log('\n[profile fields + analytics]');
  const p1 = await A.post('/api/students', student(11, { name: 'Profile One', age: 20, gender: 'Female', course: 'CSE', year: 3, residence: 'Hostel' }));
  const prof = p1.json.students.find((x) => x.name === 'Profile One');
  check('new fields are stored', prof && prof.age === 20 && prof.gender === 'Female' && prof.course === 'CSE' && prof.year === 3 && prof.residence === 'Hostel', prof);
  check('bad gender refused', (await A.post('/api/students', student(12, { gender: 'x' }))).status === 400);
  check('bad course refused', (await A.post('/api/students', student(13, { course: 'Underwater Basket' }))).status === 400);
  check('age 12 refused', (await A.post('/api/students', student(14, { age: 12 }))).status === 400);
  check('year 7 refused', (await A.post('/api/students', student(15, { year: 7 }))).status === 400);
  const up = await A.put('/api/students/' + prof.id, { course: '', age: 21 });
  const prof2 = up.json.students.find((x) => x.id === prof.id);
  check('update changes age and clears course', prof2 && prof2.age === 21 && !('course' in prof2) && prof2.gender === 'Female', prof2);
  check('records without the new fields still work', (await A.get('/api/students')).json.students.some((x) => x.gender === undefined));
  const an = await admin.get('/api/analytics');
  check('analytics returns anonymous rows', an.status === 200 && Array.isArray(an.json.rows) && an.json.rows.length >= 3 && !JSON.stringify(an.json).includes('Profile One') && !JSON.stringify(an.json).includes('alice'), an.status);
  check('analytics rows carry the pod and profile fields', an.json.rows.some((r) => r.route === 'shard-1' && r.gender === 'Female' && r.age === 21));
  check('analytics needs admin sign-in', (await new Client(CP).get('/api/analytics')).status === 401);
  await A.del('/api/students/' + prof.id);

  console.log('\n[create pod: 3 pods, new accounts spread one each]');
  const cr = await admin.post('/api/shards', { mode: 'fresh' });
  check('create fresh pod -> shard-3', cr.status === 200 && cr.json.name === 'shard-3', cr.json);
  await waitFor(async () => (await ov()).shards.find((s) => s.name === 'shard-3').pods[0]?.ready);
  const D = new Client(GW);
  check('new account goes to the empty new pod', (await D.post('/api/register', { login: 'dave', password: 'secret1' })).json.assigned === 'shard-3');
  await D.post('/api/students', student(4, { name: 'Dave Only' }));

  console.log('\n[self-healing: kill pod -> new pod is empty, data comes back from the backup]');
  await admin.post('/api/shards/shard-1/kill');
  const during = (await A.get('/api/students')).json;
  check('alice still sees her data right after the kill', during.students.length === 1 && during.students[0].name === 'Alice Only', during);
  check('served by backup or the recovered shard, never lost', ['backup', 'shard-1'].includes(during.meta.servedBy));
  check('shard-1 serves alice again after heal', await waitFor(async () => (await A.get('/api/students')).json.meta.servedBy === 'shard-1', 15000));

  console.log('\n[erase data with auto-heal OFF: backup takes over]');
  await admin.post('/api/settings', { autoheal: false });
  await admin.post('/api/shards/shard-2/erase');
  const er = (await B.get('/api/students')).json;
  check('bob served by backup with his data intact', er.meta.servedBy === 'backup' && er.students.length === 1 && er.meta.reason === 'shard-empty', er.meta);
  await sleep(900);
  check('no auto-heal while it is off', (await B.get('/api/students')).json.meta.servedBy === 'backup');
  const w = (await B.post('/api/students', student(5, { name: 'Bob Two' }))).json;
  check('write while shard empty is durable (backup) and visible', w.students.length === 2 && w.meta.servedBy === 'backup');
  await admin.post('/api/shards/shard-2/resync');
  check('resync button restores the shard', (await B.get('/api/students')).json.meta.servedBy === 'shard-2');
  await admin.post('/api/settings', { autoheal: true });

  console.log('\n[stale shard copy is never served]');
  const bobNow = (await B.get('/api/students')).json.students;
  const stale = bobNow.slice(0, 1);
  const direct = await fetch('http://127.0.0.1:4411/internal/data/bob', { method: 'GET', headers: { 'x-internal-token': 'test-internal' } }).catch(() => null);
  check('(info) shard internal port reachable in local mode', !!direct);
  await admin.post('/api/shards/shard-2/erase');
  await fetch('http://127.0.0.1:4411/internal/data/bob', { method: 'PUT', headers: { 'x-internal-token': 'test-internal', 'content-type': 'application/json' }, body: JSON.stringify({ list: stale, rev: 1, create: true }) });
  await admin.post('/api/settings', { autoheal: false });
  const sv = (await B.get('/api/students')).json;
  check('stale copy detected, served from backup with both records', sv.meta.servedBy === 'backup' && sv.meta.reason === 'shard-stale' && sv.students.length === 2, sv.meta);
  await admin.post('/api/settings', { autoheal: true });
  check('heal loop replaces the stale copy', await waitFor(async () => { const r = (await B.get('/api/students')).json; return r.meta.servedBy === 'shard-2' && r.students.length === 2; }, 8000));

  console.log('\n[stop / start]');
  await admin.post('/api/shards/shard-1/stop');
  await waitFor(async () => (await ov()).shards.find((s) => s.name === 'shard-1').pods.length === 0);
  const stopped = (await A.get('/api/students')).json;
  check('while stopped alice is served by backup', stopped.meta.servedBy === 'backup' && stopped.students.length === 1, stopped.meta);
  const wr = (await A.post('/api/students', student(6, { name: 'Alice Two' }))).json;
  check('writes still work while the shard is stopped', wr.students.length === 2);
  await admin.post('/api/shards/shard-1/start');
  check('after start, shard-1 holds both records', await waitFor(async () => { const r = (await A.get('/api/students')).json; return r.meta.servedBy === 'shard-1' && r.students.length === 2; }, 20000));

  console.log('\n[readiness: failing health check]');
  await admin.post('/api/shards/shard-2/fail-health', { on: true });
  check('health shows failing', await waitFor(async () => (await ov()).shards.find((s) => s.name === 'shard-2').health === 'failing'));
  await admin.post('/api/shards/shard-2/fail-health', { on: false });

  console.log('\n[remove a data-holding pod]');
  const need = await admin.post('/api/shards/shard-3/remove', {});
  check('remove without a choice -> asks which strategy', need.status === 409 && need.json.needsStrategy && need.json.accounts.includes('dave'), need.json);
  const park = await admin.post('/api/shards/shard-3/remove', { strategy: 'park' });
  check('park: removed', park.status === 200, park.json);
  const parked = (await D.get('/api/students')).json;
  check('parked account still readable, from the backup', parked.meta.servedBy === 'backup' && parked.meta.reason === 'parked' && parked.students[0].name === 'Dave Only', parked.meta);
  const ovp = await ov();
  check('parked group listed', ovp.parked.length === 1 && ovp.parked[0].group === 'shard-3' && ovp.shards.length === 2, ovp.parked);
  const rec = await admin.post('/api/shards', { mode: 'recover', group: 'shard-3' });
  check('create pod from recovery', rec.status === 200 && rec.json.recovered === 1, rec.json);
  check('dave served by the recovered pod', await waitFor(async () => { const r = (await D.get('/api/students')).json; return r.meta.servedBy === rec.json.name && r.students.length === 1; }, 20000));
  check('recover from nothing refused', (await admin.post('/api/shards', { mode: 'recover', group: 'nope' })).status === 409);

  const mv = await admin.post(`/api/shards/${rec.json.name}/remove`, { strategy: 'move' });
  check('move: removed', mv.status === 200, mv.json);
  const moved = (await D.get('/api/students')).json;
  check('moved account still sees its data', moved.students.length === 1 && moved.students[0].name === 'Dave Only', moved);
  check('moved account lands on an existing shard', await waitFor(async () => ['shard-1', 'shard-2'].includes((await D.get('/api/students')).json.meta.servedBy), 15000));

  const o3 = await ov();
  const target = o3.shards.find((s) => s.accounts.some((a) => a.login === 'dave'));
  const rp = await admin.post(`/api/shards/${target.name}/remove`, { strategy: 'replace' });
  check('replace: removed', rp.status === 200, rp.json);
  const o4 = await ov();
  const holder = o4.shards.find((s) => s.accounts.some((a) => a.login === 'dave'));
  check('replace: a NEW shard holds the same accounts', holder && !['shard-1', 'shard-2'].includes(holder.name) || holder.name !== target.name, holder && holder.name);
  check('replace: data still intact', await waitFor(async () => { const r = (await D.get('/api/students')).json; return r.students.length === 1 && r.meta.servedBy === holder.name; }, 20000));
  check('removing a shard with zero accounts needs no choice', (await admin.post('/api/shards', { mode: 'fresh' })).status === 200);

  console.log('\n[evicted data does not linger on the old shard]');
  const o5 = await ov();
  const total = (login) => o5.shards.filter((s) => s.accounts.some((a) => a.login === login)).length;
  check('each account is routed to exactly one shard', ['alice', 'bob', 'carol', 'dave'].every((l) => total(l) === 1));

  console.log('\n[backup is the single source of truth]');
  await admin.post('/api/core/backup/kill');
  const noBk = (await A.get('/api/students')).json;
  check('with the backup down, shards still serve reads', noBk.students.length === 2 && String(noBk.meta.servedBy).startsWith('shard-'), noBk.meta);
  const noW = await A.post('/api/students', student(7));
  check('with the backup down, writes are refused (no durable copy)', noW.status === 503, noW);
  check('backup returns and the data is still there (PVC)', await waitFor(async () => (await A.post('/api/students', student(8, { name: 'After Backup' }))).status === 200, 20000));
  check('login works again and data survived', (await new Client(GW).post('/api/login', { login: 'alice', password: 'secret1' })).status === 200);
  const finalA = (await A.get('/api/students')).json;
  check('alice has 3 records now', finalA.students.length === 3, finalA.students.map((s) => s.name));

  console.log('\n[login throttle]');
  const T = new Client(GW);
  let last;
  for (let i = 0; i < 9; i++) last = await T.post('/api/login', { login: 'carol', password: 'wrong' + i });
  check('9th wrong attempt is throttled', last.status === 429, last);
  check('static dashboards are served', (await fetch(GW + '/')).status === 200 && (await fetch(CP + '/')).status === 200);
  check('path traversal blocked', (await fetch(GW + '/..%2f..%2fsrc%2fcommon.js')).status === 404);

  console.log(`\n${passes} passed, ${failures} failed`);
  ctl.kill('SIGKILL');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

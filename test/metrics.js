'use strict';
// Metrics test: starts a real backup role, sends a few requests, scrapes /metrics on the separate port.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (name, ok, extra) => { if (ok) console.log('  ok   ' + name); else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + String(extra).slice(0, 300) : '')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vle7-metrics-'));
  const p = spawn('node', [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, ROLE: 'backup', PORT: '4601', METRICS_PORT: '4602', DATA_DIR: dir, STATE_FILE: path.join(dir, 'state.json'), INTERNAL_TOKEN: 't', SESSION_SECRET: 's', POD_NAME: 'backup-test' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) { try { up = (await fetch('http://127.0.0.1:4601/healthz')).ok; } catch { await sleep(100); } }
    check('app port is up', up);
    for (let i = 0; i < 4; i++) await fetch('http://127.0.0.1:4601/healthz');
    await fetch('http://127.0.0.1:4601/nope');
    await sleep(100);
    const r = await fetch('http://127.0.0.1:4602/metrics');
    const text = await r.text();
    check('/metrics returns 200 text/plain', r.status === 200 && /text\/plain/.test(r.headers.get('content-type')), r.status);
    check('request counter counts healthz (>=5)', /vle7_http_requests_total\{method="GET",route="health",code="200"\} ([5-9]|\d\d+)/.test(text), text);
    check('request counter labels non-200 codes', /vle7_http_requests_total\{[^}]*code="404"\}/.test(text), text);
    check('latency histogram present', /vle7_http_request_duration_seconds_bucket\{route="health",le="\+Inf"\}/.test(text) && /_count\{route="health"\}/.test(text));
    check('build_info carries component and hostname', /vle7_build_info\{component="backup",hostname="backup-test"/.test(text), text);
    check('process gauges present', /vle7_process_resident_memory_bytes \d+/.test(text) && /vle7_process_uptime_seconds/.test(text));
    check('metrics are NOT served on the public app port', (await fetch('http://127.0.0.1:4601/metrics')).status !== 200 || !(await (await fetch('http://127.0.0.1:4601/metrics')).text()).includes('vle7_http_requests_total'));
    check('metrics port serves nothing else', (await fetch('http://127.0.0.1:4602/api/students')).status === 404);
    // ---- records analytics gauges (backup role only) ----
    const H = { 'content-type': 'application/json', 'x-internal-token': 't' };
    const post = (u, b) => fetch('http://127.0.0.1:4601' + u, { method: 'POST', headers: H, body: JSON.stringify(b) });
    await post('/internal/shards', { name: 'shard-1', url: 'http://127.0.0.1:9' });
    await post('/internal/register', { login: 'metricuser', password: 'secret1', healthy: ['shard-1'] });
    const mk = (i, f) => post('/internal/op/metricuser', { op: { type: 'add', id: String(i).padStart(12, 'a'), student: { name: 'N' + i, regno: 'R' + i, attendance: 80, marks: 70, ...f } } });
    await mk(1, { gender: 'Female', course: 'CSE', year: 2, age: 19, residence: 'Hostel' });
    await mk(2, { gender: 'Male', course: 'CSE', year: 3, age: 24, residence: 'Day scholar', attendance: 60, marks: 90 });
    await mk(3, {});
    const t2 = await (await fetch('http://127.0.0.1:4602/metrics')).text();
    check('records gauge per shard', /vle7_records\{shard="shard-1"\} 3/.test(t2), t2.split('\n').filter((l) => l.includes('vle7_records{')).join(' | '));
    check('gender counts (2 known + 1 unknown)', /vle7_records_by_gender\{shard="shard-1",gender="Female"\} 1/.test(t2) && /gender="Male"\} 1/.test(t2) && /gender="Unknown"\} 1/.test(t2));
    check('course, year, age band, marks band', /course="CSE"\} 2/.test(t2) && /year="3"\} 1/.test(t2) && /age="24\+"\} 1/.test(t2) && /marks="80-100"\} 1/.test(t2));
    check('averages and low-attendance count', /vle7_marks_avg\{shard="shard-1"\} 76\.67/.test(t2) && /vle7_records_low_attendance\{shard="shard-1"\} 1/.test(t2), t2.split('\n').filter((l) => l.includes('avg{')).join(' | '));
    check('no names or logins leak into metrics', !/N1|N2|R1|metricuser/.test(t2.replace(/vle7_[a-z_]+/g, '')));
  } finally { p.kill('SIGKILL'); fs.rmSync(dir, { recursive: true, force: true }); }
  console.log(failures ? `\n${failures} failed` : '\nmetrics ok');
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });

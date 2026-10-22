'use strict';
// Prometheus metrics, no dependencies. Every role (gateway, shard, backup, control) gets the same
// instrumentation by listening to its HTTP server's 'request' event; no handler code is touched.
// Metrics are served on a SEPARATE port (default 9102) so they are never reachable through the
// public NodePorts. Prometheus scrapes that port from inside the cluster.
const http = require('http');
const os = require('os');

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const counts = new Map();   // "method|route|code" -> n
const hist = new Map();     // route -> { buckets: number[], sum, count }
const startedAt = Date.now();
const collectors = []; // extra metric text producers (the backup role adds the records analytics)
function addCollector(fn) { collectors.push(fn); }

// Collapse URLs into a few fixed classes so the label set can never explode.
function routeOf(pathname) {
  if (pathname === '/healthz' || pathname === '/livez') return 'health';
  if (pathname.startsWith('/api/')) return 'api';
  if (pathname.startsWith('/internal/')) return 'internal';
  return 'static';
}

function observe(method, pathname, code, seconds) {
  const route = routeOf(pathname);
  const k = `${method}|${route}|${code}`;
  counts.set(k, (counts.get(k) || 0) + 1);
  let h = hist.get(route);
  if (!h) { h = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }; hist.set(route, h); }
  BUCKETS.forEach((b, i) => { if (seconds <= b) h.buckets[i]++; });
  h.sum += seconds; h.count++;
}

function instrument(server) {
  server.on('request', (req, res) => {
    const t0 = process.hrtime.bigint();
    let pathname = '/';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* keep '/' */ }
    res.on('finish', () => observe(req.method, pathname, res.statusCode, Number(process.hrtime.bigint() - t0) / 1e9));
  });
  return server;
}

const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

function render(role, pod) {
  const L = [];
  // Names differ from the Prometheus target labels (role, pod) on purpose, to avoid "exported_" renames.
  const base = `component="${esc(role)}",hostname="${esc(pod)}"`;
  L.push('# HELP vle7_http_requests_total HTTP requests served, by method, route class and status code.');
  L.push('# TYPE vle7_http_requests_total counter');
  for (const [k, n] of counts) {
    const [method, route, code] = k.split('|');
    L.push(`vle7_http_requests_total{method="${method}",route="${route}",code="${code}"} ${n}`);
  }
  L.push('# HELP vle7_http_request_duration_seconds Request latency.');
  L.push('# TYPE vle7_http_request_duration_seconds histogram');
  for (const [route, h] of hist) {
    BUCKETS.forEach((b, i) => L.push(`vle7_http_request_duration_seconds_bucket{route="${route}",le="${b}"} ${h.buckets[i]}`));
    L.push(`vle7_http_request_duration_seconds_bucket{route="${route}",le="+Inf"} ${h.count}`);
    L.push(`vle7_http_request_duration_seconds_sum{route="${route}"} ${h.sum}`);
    L.push(`vle7_http_request_duration_seconds_count{route="${route}"} ${h.count}`);
  }
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  L.push('# HELP vle7_build_info Constant 1; labels say which role/pod this is.');
  L.push('# TYPE vle7_build_info gauge');
  L.push(`vle7_build_info{${base},node="${esc(process.version)}"} 1`);
  L.push('# TYPE vle7_process_uptime_seconds gauge');
  L.push(`vle7_process_uptime_seconds ${((Date.now() - startedAt) / 1000).toFixed(1)}`);
  L.push('# TYPE vle7_process_resident_memory_bytes gauge');
  L.push(`vle7_process_resident_memory_bytes ${mem.rss}`);
  L.push('# TYPE vle7_process_heap_used_bytes gauge');
  L.push(`vle7_process_heap_used_bytes ${mem.heapUsed}`);
  L.push('# TYPE vle7_process_cpu_seconds_total counter');
  L.push(`vle7_process_cpu_seconds_total ${((cpu.user + cpu.system) / 1e6).toFixed(3)}`);
  L.push('# TYPE vle7_host_load1 gauge');
  L.push(`vle7_host_load1 ${os.loadavg()[0]}`);
  let text = L.join('\n') + '\n';
  for (const c of collectors) { try { text += c(); } catch (e) { text += `# collector failed: ${String(e.message).replace(/\n/g, ' ')}\n`; } }
  return text;
}

// Port rules: METRICS_PORT=0 disables; METRICS_PORT=<n> forces; otherwise on 9102 only inside
// Kubernetes (local-mode test runs start several roles on one machine and would collide).
function metricsPort() {
  if (process.env.METRICS_PORT !== undefined) return Number(process.env.METRICS_PORT);
  return process.env.KUBERNETES_SERVICE_HOST ? 9102 : 0;
}

function startMetricsServer(role, pod, port = metricsPort()) {
  if (!port) return null;
  const srv = http.createServer((req, res) => {
    if (req.url === '/metrics' || req.url.startsWith('/metrics?')) {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      return res.end(render(role, pod));
    }
    res.writeHead(404); res.end('not found\n');
  });
  srv.on('error', (e) => console.error('metrics server error (app keeps running):', e.message));
  srv.listen(port, () => console.log(`metrics for ${role} on :${port}/metrics`));
  return srv;
}

module.exports = { addCollector, instrument, startMetricsServer, render, observe, routeOf };

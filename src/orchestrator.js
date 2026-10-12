'use strict';
// How the control panel creates, stops and kills "pods".
//  - K8sOrchestrator: talks to the Kubernetes API with the pod's own ServiceAccount (real cluster).
//  - LocalOrchestrator: runs the same roles as child processes (used by the smoke test / local dev).
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const C = require('./common');

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';
const LABEL = 'app.kubernetes.io/part-of';

// ---------------------------------------------------------------- Kubernetes
class K8sOrchestrator {
  constructor() {
    this.kind = 'kubernetes';
    this.ns = process.env.NAMESPACE || fs.readFileSync(SA + '/namespace', 'utf8').trim();
    this.ca = fs.readFileSync(SA + '/ca.crt');
    this.backupUrl = 'http://backup:3000';
  }
  req(method, p, body, type = 'application/json') {
    const token = fs.readFileSync(SA + '/token', 'utf8').trim(); // re-read: tokens rotate
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const r = https.request({
        host: process.env.KUBERNETES_SERVICE_HOST, port: process.env.KUBERNETES_SERVICE_PORT, path: p, method, ca: this.ca,
        headers: { authorization: 'Bearer ' + token, accept: 'application/json', ...(data ? { 'content-type': type, 'content-length': Buffer.byteLength(data) } : {}) },
        timeout: 6000,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
          resolve({ status: res.statusCode, json, text });
        });
      });
      r.on('timeout', () => r.destroy(new Error('kubernetes API timeout')));
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }
  async must(method, p, body, type) {
    const r = await this.req(method, p, body, type);
    if (r.status >= 300) throw new Error(`kubernetes ${method} ${p} -> ${r.status} ${(r.json && r.json.message) || ''}`);
    return r.json;
  }
  dep(name) { return `/apis/apps/v1/namespaces/${this.ns}/deployments/${name}`; }

  async image() {
    const d = await this.must('GET', this.dep('control'));
    return d.spec.template.spec.containers[0].image;
  }
  async ensureCore() { /* deployed by manifests */ }
  shardUrl(name) { return `http://${name}:3000`; }

  async listShardNames() {
    const j = await this.must('GET', `/apis/apps/v1/namespaces/${this.ns}/deployments?labelSelector=${encodeURIComponent('vle7/role=shard')}`);
    return j.items.map((d) => d.metadata.name);
  }
  async describe(name) {
    const [d, pods] = await Promise.all([
      this.req('GET', this.dep(name)),
      this.must('GET', `/api/v1/namespaces/${this.ns}/pods?labelSelector=${encodeURIComponent('vle7/name=' + name)}`),
    ]);
    if (d.status === 404) return { exists: false, desired: 0, pods: [] };
    return {
      exists: true,
      desired: d.json.spec.replicas,
      pods: pods.items.map((p) => {
        const cs = (p.status.containerStatuses || [])[0] || {};
        return { name: p.metadata.name, phase: p.metadata.deletionTimestamp ? 'Terminating' : p.status.phase, ready: !!cs.ready, restarts: cs.restartCount || 0 };
      }),
    };
  }
  async createShard(name) {
    const image = await this.image();
    const labels = { [LABEL]: 'vle7', 'vle7/role': 'shard', 'vle7/name': name };
    const secretRef = { secretRef: { name: 'vle7-secrets' } };
    const ctx = { runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } };
    await this.must('POST', `/apis/apps/v1/namespaces/${this.ns}/deployments`, {
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, labels },
      spec: {
        replicas: 1, selector: { matchLabels: { 'vle7/name': name } },
        strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
        template: {
          metadata: { labels },
          spec: {
            automountServiceAccountToken: false,
            securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
            containers: [{
              name: 'app', image, imagePullPolicy: 'IfNotPresent',
              env: [{ name: 'ROLE', value: 'shard' }, { name: 'PORT', value: '3000' }, { name: 'DATA_DIR', value: '/data' }, { name: 'NODE_ENV', value: 'production' },
                { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } }],
              envFrom: [secretRef],
              ports: [{ containerPort: 3000 }],
              readinessProbe: { httpGet: { path: '/healthz', port: 3000 }, periodSeconds: 2, failureThreshold: 2 },
              livenessProbe: { httpGet: { path: '/livez', port: 3000 }, periodSeconds: 10, failureThreshold: 3 },
              resources: { requests: { cpu: '20m', memory: '40Mi' }, limits: { cpu: '200m', memory: '128Mi' } },
              securityContext: ctx,
              volumeMounts: [{ name: 'data', mountPath: '/data' }],
            }],
            volumes: [{ name: 'data', emptyDir: {} }],
          },
        },
      },
    });
    await this.must('POST', `/api/v1/namespaces/${this.ns}/services`, {
      apiVersion: 'v1', kind: 'Service', metadata: { name, labels },
      spec: { selector: { 'vle7/name': name }, ports: [{ port: 3000, targetPort: 3000 }] },
    });
    return this.shardUrl(name);
  }
  async deleteShard(name) {
    await this.req('DELETE', this.dep(name));
    await this.req('DELETE', `/api/v1/namespaces/${this.ns}/services/${name}`);
  }
  async scale(name, n) {
    await this.must('PATCH', this.dep(name) + '/scale', { spec: { replicas: n } }, 'application/merge-patch+json');
  }
  async killPods(name) {
    const j = await this.must('GET', `/api/v1/namespaces/${this.ns}/pods?labelSelector=${encodeURIComponent('vle7/name=' + name)}`);
    if (!j.items.length) throw C.bad('no pod to delete', 409);
    await Promise.all(j.items.map((p) => this.must('DELETE', `/api/v1/namespaces/${this.ns}/pods/${p.metadata.name}`)));
  }
}

// ---------------------------------------------------------------- Local (child processes)
class LocalOrchestrator {
  constructor() {
    this.kind = 'local';
    this.appDir = path.join(__dirname, '..');
    this.base = fs.mkdtempSync(path.join(os.tmpdir(), 'vle7-local-'));
    this.portBase = Number(process.env.PORT_BASE || 4400);
    this.backupUrl = `http://127.0.0.1:${this.portBase + 1}`;
    this.specs = new Map();
    this.nextPort = this.portBase + 10;
    process.on('exit', () => this.killAll());
  }
  killAll() { for (const s of this.specs.values()) { s.desired = 0; if (s.proc) s.proc.kill('SIGKILL'); } }
  async image() { return 'local-process'; }
  shardUrl(name) { return this.specs.get(name).url; }

  define(name, role, port) {
    const spec = { name, role, port, url: `http://127.0.0.1:${port}`, dir: path.join(this.base, name), desired: 1, proc: null, restarts: 0, pod: null, ready: false };
    this.specs.set(name, spec);
    return spec;
  }
  launch(spec, { freshPod }) {
    if (freshPod) {
      if (spec.role === 'shard') fs.rmSync(spec.dir, { recursive: true, force: true }); // emptyDir dies with the pod
      spec.pod = `${spec.name}-${C.newId().slice(0, 5)}`;
    }
    fs.mkdirSync(spec.dir, { recursive: true });
    const env = {
      ...process.env, ROLE: spec.role, PORT: String(spec.port), DATA_DIR: spec.dir, POD_NAME: spec.pod,
      BACKUP_URL: this.backupUrl, ORCHESTRATOR: '', PARENT_PID: String(process.pid), RECONCILE_MS: process.env.RECONCILE_MS || '3000',
    };
    const proc = spawn(process.execPath, [path.join(__dirname, 'index.js')], { env, stdio: process.env.LOCAL_VERBOSE ? 'inherit' : 'ignore' });
    spec.proc = proc; spec.ready = false;
    proc.on('exit', () => {
      if (spec.proc !== proc) return;
      spec.proc = null; spec.ready = false;
      if (spec.desired > 0) {            // like the kubelet / ReplicaSet: bring it back
        const wasKilled = spec.killed; spec.killed = false;
        if (!wasKilled) spec.restarts++;  // crash = container restart in the same pod
        setTimeout(() => { if (spec.desired > 0 && !spec.proc) this.launch(spec, { freshPod: wasKilled }); }, 300);
      }
    });
    const probe = async () => {
      for (let i = 0; i < 50 && spec.proc === proc; i++) {
        try { const r = await C.call(spec.url + '/healthz', { timeout: 300 }); if (r.status === 200) { spec.ready = true; return; } } catch { /* not up yet */ }
        await C.sleep(100);
      }
    };
    probe();
  }
  async ensureCore() {
    this.launch(this.define('backup', 'backup', this.portBase + 1), { freshPod: true });
    this.launch(this.define('gateway', 'gateway', this.portBase), { freshPod: true });
    for (let i = 0; i < 100 && !(this.specs.get('backup').ready); i++) await C.sleep(100);
  }
  async listShardNames() { return [...this.specs.values()].filter((s) => s.role === 'shard').map((s) => s.name); }
  async describe(name) {
    const s = this.specs.get(name);
    if (!s) return { exists: false, desired: 0, pods: [] };
    const pods = s.proc ? [{ name: s.pod, phase: 'Running', ready: s.ready, restarts: s.restarts }] : [];
    return { exists: true, desired: s.desired, pods };
  }
  async createShard(name) {
    const spec = this.define(name, 'shard', this.nextPort++);
    this.launch(spec, { freshPod: true });
    return spec.url;
  }
  async deleteShard(name) {
    const s = this.specs.get(name);
    if (!s) return;
    s.desired = 0; if (s.proc) s.proc.kill('SIGKILL');
    this.specs.delete(name);
  }
  async scale(name, n) {
    const s = this.specs.get(name);
    if (!s) throw C.bad('unknown deployment', 404);
    s.desired = n;
    if (n === 0 && s.proc) { s.proc.kill('SIGKILL'); }
    if (n > 0 && !s.proc) this.launch(s, { freshPod: true });
  }
  async killPods(name) {
    const s = this.specs.get(name);
    if (!s || !s.proc) throw C.bad('no pod to delete', 409);
    s.killed = true; s.proc.kill('SIGKILL');
  }
}

module.exports = { K8sOrchestrator, LocalOrchestrator };

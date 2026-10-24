# College Campus Records: Jenkins to Kubernetes CI/CD demo (PBL-3, VLE 7)

One Docker image, four roles (`ROLE=gateway|shard|backup|control`).

| Role | What it is | Port on the node |
|------|-----------|------------------|
| gateway | The app (login, dashboard). Routes each login to its shard, writes through to the backup, fails over to it. | 30080 |
| shard-N | Holds the data of the accounts routed to it (one Deployment + Service each). Data in an `emptyDir`. | internal |
| backup | Source of truth: all accounts and all data, on a PersistentVolumeClaim. Only ever returns one login's data per call. | internal |
| control | Operator panel with manual buttons (kill pod, erase data, stop, start, create/remove pod). Admin password. | 30090 |

Rules: a new account goes to the least-loaded shard (ties to the lowest number). A login only ever sees its own data.
When a shard cannot serve a login, the backup answers with that login's data only.

## One-time setup (cluster)

    kubectl apply -f k8s/00-namespace.yaml
    kubectl -n vle7 create secret generic vle7-secrets \
      --from-literal=SESSION_SECRET="$(openssl rand -hex 32)" \
      --from-literal=INTERNAL_TOKEN="$(openssl rand -hex 32)" \
      --from-literal=ADMIN_PASSWORD='choose-a-long-password'

The secret is never committed to git.

## Pipeline

`Jenkinsfile`: Checkout, Test (smoke test in a throwaway container), Build, Push to `localhost:5001`, Deploy (`kubectl apply` + `set image` on shards), Verify (`rollout status` + health checks).

## Run the tests locally

    node test/smoke.js

No dependencies. Needs Node 22.

## Monitoring (Prometheus + Grafana)
What it adds: every pod serves `/metrics` on port 9102 (cluster-internal only, never on the NodePorts). Prometheus scrapes them every 15 s, plus kube-state-metrics (pod ready / restarts) and cAdvisor (CPU / memory). Grafana shows one dashboard, "VLE 7 - College Campus Records on Kubernetes".

One-time setup on the instance (pick your own password; do not commit it):
```
kubectl apply -f k8s/monitoring/00-namespace.yaml
kubectl -n monitoring create secret generic grafana-admin --from-literal=admin-password='<your-password>'
```
Then push to GitHub. The pipeline's new Monitoring stage applies `k8s/monitoring/` and waits for the three Deployments. (Or by hand: `kubectl apply -f k8s/monitoring/`.)

Open Grafana: NodePort 30300 (login `admin` / your password). If your network blocks high ports:
`docker run -d --name vle7-fwd-3000 --restart unless-stopped --network host alpine/socat tcp-listen:3000,fork,reuseaddr tcp-connect:127.0.0.1:30300`
then browse to `http://<instance-ip>:3000` (needs a security-group rule for that port from your IP only).

Check without a browser: `kubectl -n monitoring port-forward svc/prometheus 9090:9090` then `curl -s localhost:9090/api/v1/targets | head`.
Notes: Prometheus keeps 6 h of data in an emptyDir (lost if its pod restarts). Total extra memory limit is about 600 MiB; check `free -m` first on a 4 GB instance.

## Student records: new fields and dashboards
Each student record now also has optional `age` (16-40), `gender`, `course`, `year` (1-4) and `residence`. Old records without them still work (shown as "Not set"/"Unknown").

Two ways to see the records as charts:
1. **Grafana (Prometheus)**: dashboard "VLE 7 - Student records". The backup pod publishes anonymous aggregates (counts and averages per shard, never names or reg numbers) on its metrics port; the dashboard has a Shard filter. Deployed together with the monitoring stack (same `k8s/monitoring/` apply).
2. **Control panel** (optional, :30090): "Records analytics" section, plus a marks-vs-attendance scatter that Prometheus cannot draw.

Seed demo data (about 25 records per shard, with the new fields; safe to re-run):
`DEMO_PW='<choose a password>' python3 seed.py`   (use `SHARDS=3` if you have three pods)


small changes

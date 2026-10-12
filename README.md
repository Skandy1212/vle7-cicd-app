# Campus Records: Jenkins to Kubernetes CI/CD demo (PBL-3, VLE 7)

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

// Declarative pipeline: Checkout -> Test -> Build -> Push -> Deploy -> Verify -> Monitoring
pipeline {
  agent any
  options {
    timestamps()
    disableConcurrentBuilds()
    timeout(time: 20, unit: 'MINUTES')
  }
  triggers { pollSCM('H/2 * * * *') }   // fallback: a push is picked up within ~2 minutes even without a webhook
  environment {
    REGISTRY   = 'localhost:5001'
    IMAGE_NAME = 'vle7-app'
    NS         = 'vle7'
  }
  stages {
    stage('Checkout') {
      steps {
        checkout scm
        script {
          def sha = sh(returnStdout: true, script: 'git rev-parse --short HEAD').trim()
          env.IMAGE = "${REGISTRY}/${IMAGE_NAME}:${env.BUILD_NUMBER}-${sha}"   // unique tag, never reused
        }
        echo "Image for this build: ${env.IMAGE}"
      }
    }
    stage('Test') {
      steps {
        // Runs the real roles as local processes and checks isolation, failover, recovery.
        sh 'docker run --rm -v "$PWD":/w -w /w node:22-alpine sh -c "node test/smoke.js && node test/metrics.js"'
      }
    }
    stage('Build') {
      steps { sh 'docker build -t "$IMAGE" .' }
    }
    stage('Push') {
      steps { sh 'docker push "$IMAGE"' }
    }
    stage('Deploy') {
      steps {
        sh '''
          set -e
          kubectl apply -f k8s/00-namespace.yaml
          kubectl -n "$NS" get secret vle7-secrets >/dev/null || { echo "Secret vle7-secrets is missing. Create it once (see README)."; exit 1; }
          for f in k8s/10-rbac.yaml k8s/20-backup.yaml k8s/30-gateway.yaml k8s/40-control.yaml; do
            sed "s|IMAGE_PLACEHOLDER|$IMAGE|g" "$f" | kubectl apply -f -
          done
          # Shard pods are created by the control panel at runtime: roll them to the new image too.
          if kubectl -n "$NS" get deploy -l vle7/role=shard -o name | grep -q .; then
            kubectl -n "$NS" set image deployment -l vle7/role=shard app="$IMAGE"
          fi
        '''
      }
    }
    stage('Verify') {
      steps {
        sh '''
          set -e
          for d in backup gateway control; do kubectl -n "$NS" rollout status deployment/$d --timeout=180s; done
          for d in $(kubectl -n "$NS" get deploy -l vle7/role=shard -o name); do kubectl -n "$NS" rollout status $d --timeout=180s; done
          curl -fsS http://localhost:30080/healthz
          echo
          curl -fsS http://localhost:30090/healthz
          echo
          kubectl -n "$NS" get pods -o wide
        '''
      }
    }
    stage('Monitoring') {
      // Prometheus + Grafana live in their own namespace. Applied only if the one-time grafana-admin secret exists,
      // so the app pipeline never fails because monitoring was not set up.
      steps {
        sh '''
          set -e
          if kubectl -n monitoring get secret grafana-admin >/dev/null 2>&1; then
            kubectl apply -f k8s/monitoring/00-namespace.yaml
            kubectl apply -f k8s/monitoring/
            for d in kube-state-metrics prometheus grafana; do kubectl -n monitoring rollout status deployment/$d --timeout=240s; done
            kubectl -n monitoring get pods
          else
            echo "Monitoring skipped: create secret grafana-admin in namespace monitoring first (see README)."
          fi
        '''
      }
    }
  }
  post {
    failure { sh 'kubectl -n "$NS" get pods -o wide || true' }
  }
}

#!/usr/bin/env bash
# Captura screenshots do app motorista (manual de uso) — dados fictícios, /api stubado.
# Molde: hub-motorista-adiantamento-e2e-browser.sh. Saída: docs/manuais/app-motorista/img/
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$HUB_DIR/../.." && pwd)"
MOTORISTA_DIR="$REPO_DIR/app_homologacao/frontend_motorista"
FRONTEND_V2_DIR="$REPO_DIR/app_homologacao/frontend_v2"
CAPT_DIR="$HUB_DIR/testes/manual-motorista-capturas"
OUT_DIR="$REPO_DIR/docs/manuais/app-motorista/img"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.61.1-jammy"
mkdir -p "$OUT_DIR"

cleanup() {
  echo
  echo "=== cleanup: conferindo package-lock.json (gotcha do container Playwright) ==="
  for d in "$MOTORISTA_DIR" "$FRONTEND_V2_DIR"; do
    if ! git -C "$d" diff --quiet -- package-lock.json 2>/dev/null; then
      echo "AVISO: package-lock.json de $d foi alterado pelo container — revertendo" >&2
      git -C "$d" checkout -- package-lock.json
    else
      echo "package-lock.json intacto em $d"
    fi
  done
  echo "=== estado do host DEPOIS ==="; free -h; df -h /
}
trap cleanup EXIT

echo "df -h / e swap antes do build:"; df -h /; swapon --show
AVAIL_KB=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
SWAP_FREE_KB=$(awk '/SwapFree/{print $2}' /proc/meminfo)
DISK_AVAIL_KB=$(df -Pk / | awk 'NR==2{print $4}')
if [ "${AVAIL_KB:-0}" -lt 2097152 ]; then
  echo "ABORTADO: RAM disponível < 2Gi — não prosseguir (lição 2026-06-11)" >&2; exit 2
fi
if [ "${SWAP_FREE_KB:-0}" -lt 1048576 ]; then
  echo "ABORTADO: swap livre < 1Gi — não prosseguir" >&2; exit 2
fi
if [ "${DISK_AVAIL_KB:-0}" -lt 21943040 ]; then
  echo "ABORTADO: disco livre em / < 21Gi — não prosseguir (lição 2026-08-30 + margem p/ FASE 10)" >&2; exit 2
fi

echo "build+start do app motorista (porta 3006) + capturas, no container oficial do Playwright…"
docker run --rm --memory=1536m \
  -e BACKEND_URL="http://127.0.0.1:9" \
  -e NODE_ENV=production \
  -e MOTORISTA_E2E_BASE_URL="http://127.0.0.1:3006" \
  -e CAPTURA_OUT=/out \
  -v "$MOTORISTA_DIR:/motorista" \
  -v "$FRONTEND_V2_DIR:/work:ro" \
  -v "$CAPT_DIR:/capt:ro" \
  -v "$OUT_DIR:/out" \
  -w /motorista \
  "$PLAYWRIGHT_IMAGE" \
  bash -lc '
    set -e
    npm run build > /tmp/next-build.log 2>&1 || { echo "BUILD_FAILED"; tail -150 /tmp/next-build.log; exit 1; }
    (PORT=3006 HOSTNAME=0.0.0.0 npx next start -p 3006 -H 0.0.0.0 > /tmp/next-start.log 2>&1 &)
    ok=""
    for i in $(seq 1 30); do
      curl -sf -o /dev/null http://127.0.0.1:3006/login && { ok=1; break; }
      sleep 1
    done
    [ -n "$ok" ] || { echo "FRONTEND_NAO_SUBIU"; cat /tmp/next-start.log; exit 1; }
    mkdir /tmp/cap && cp /capt/* /tmp/cap/ && ln -s /work/node_modules /tmp/cap/node_modules
    cd /tmp/cap
    npx playwright test -c playwright.config.ts
  '
PW_EXIT=$?
ls -la "$OUT_DIR"
exit "$PW_EXIT"

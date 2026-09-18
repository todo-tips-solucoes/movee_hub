#!/usr/bin/env bash
# =============================================================================
# hub-adiantamentos-e2e-browser.sh — tasks.md 7.10 (feature "Adiantamento
# pelo App, Dados Bancários e Exportação Transfeera"): E2E de BROWSER das
# telas novas do HUB (app_homologacao/frontend_v2/app/hub/dashboard/
# adiantamentos/**) cobrindo US3 (contas), US4 (montar/gerar lote), US5
# (confirmar resultado, reprocessar, encerrar sem pagamento) e US6 (repasse
# e fechamento de apuração).
#
# Mesmo padrão "sem stack" de hub-motorista-adiantamento-e2e-browser.sh
# (dec-107): aqui o alvo É o próprio frontend_v2 (não há segundo projeto a
# montar) — `next build && next start` roda dentro do MESMO container
# oficial do Playwright, numa porta isolada; todo `/api/**` do browser é
# stubado via page.route (adiantamentos.spec.ts) — o backend real
# (hub-homolog) NUNCA é exercitado por esta suíte (isso já é coberto por
# hub-adiantamentos-integration.sh, nível API/DB). Nenhum node_modules/
# package.json é instalado/alterado.
#
# Uso: infra/hub/testes/hub-adiantamentos-e2e-browser.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$HUB_DIR/../.." && pwd)"
FRONTEND_V2_DIR="$REPO_DIR/app_homologacao/frontend_v2"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.61.1-jammy"
EVID_DIR="$REPO_DIR/docs/specs/adiantamento-motorista/evidencias/7.10"
mkdir -p "$EVID_DIR"
RUN_LOG="$EVID_DIR/7.10.1-adiantamentos-e2e-browser-run-$(date -u +%Y%m%dT%H%M%SZ).log"

cleanup() {
  echo
  echo "=== cleanup: conferindo package-lock.json (gotcha do container Playwright) ==="
  if ! git -C "$FRONTEND_V2_DIR" diff --quiet -- package-lock.json 2>/dev/null; then
    echo "AVISO: package-lock.json de $FRONTEND_V2_DIR foi alterado pelo container — revertendo" >&2
    git -C "$FRONTEND_V2_DIR" checkout -- package-lock.json
  else
    echo "package-lock.json intacto em $FRONTEND_V2_DIR"
  fi
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

echo "rodando build+start do hub (frontend_v2, porta 3020) + playwright test, MESMO container oficial…"
set -o pipefail
docker run --rm --memory=1536m \
  -e BACKEND_URL="http://127.0.0.1:9" \
  -e NODE_ENV=production \
  -e HUB_ADIANTAMENTOS_E2E_BASE_URL="http://127.0.0.1:3020" \
  -e CI=true \
  -v "$FRONTEND_V2_DIR:/work" \
  -w /work \
  "$PLAYWRIGHT_IMAGE" \
  bash -lc '
    set -e
    npm run build > /tmp/next-build.log 2>&1 || { echo "BUILD_FAILED"; tail -150 /tmp/next-build.log; exit 1; }
    (PORT=3020 HOSTNAME=0.0.0.0 npx next start -p 3020 -H 0.0.0.0 > /tmp/next-start.log 2>&1 &)
    ok=""
    for i in $(seq 1 30); do
      curl -sf -o /dev/null http://127.0.0.1:3020/hub/login && { ok=1; break; }
      sleep 1
    done
    [ -n "$ok" ] || { echo "FRONTEND_NAO_SUBIU"; cat /tmp/next-start.log; exit 1; }
    npx playwright test -c playwright.config.hub-adiantamentos.ts
  ' \
  2>&1 | tee "$RUN_LOG"
PW_EXIT=${PIPESTATUS[0]}
set +o pipefail

echo
echo "=== log completo: $RUN_LOG ==="
if [ "$PW_EXIT" = "0" ]; then
  echo "HUB-ADIANTAMENTOS-E2E-BROWSER: OK — US3/US4/US5/US6 verdes"
else
  echo "HUB-ADIANTAMENTOS-E2E-BROWSER: Playwright FALHOU (exit=$PW_EXIT)" >&2
fi
exit "$PW_EXIT"

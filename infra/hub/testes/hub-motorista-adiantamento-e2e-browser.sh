#!/usr/bin/env bash
# =============================================================================
# hub-motorista-adiantamento-e2e-browser.sh — tasks.md 6.8.3/6.9 (feature
# "Adiantamento pelo App, Dados Bancários e Exportação Transfeera"): E2E de
# BROWSER do app_homologacao/frontend_motorista cobrindo US1 (solicitar/
# acompanhar), US2 (dados bancários) e US7 (central de notificações), mais
# a auditoria de acessibilidade (6.8.2 alvo de toque medido, 6.8.3 axe-core
# escore >=95 + color-contrast nos 2 temas).
#
# Mesmo padrão (dec-107, "padrão motorista-push" citado em tasks.md 6.9):
# frontend_motorista NÃO tem @playwright/test nem @axe-core/playwright — o
# driver monta o app motorista (build+start) E o frontend_v2 (que JÁ tem os
# dois pacotes) no MESMO container oficial do Playwright; o Playwright roda
# a partir de frontend_v2 e fala HTTP com o app motorista. Nenhum
# node_modules/package.json de nenhum dos dois projetos é instalado/alterado.
#
# SEM backend nem stack docker-compose: todo /api/* do browser é stubado via
# page.route no próprio spec (adiantamento.spec.ts) — o proxy server-side do
# app motorista (app/api/[...path]/route.ts) nunca é exercitado de verdade
# nesta suíte. BACKEND_URL aponta para uma porta local sem NADA escutando
# (defesa em profundidade: mesmo se algum request escapar do stub do
# browser, cai em connection refused, nunca em produção/staging real).
#
# Uso: infra/hub/testes/hub-motorista-adiantamento-e2e-browser.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$HUB_DIR/../.." && pwd)"
MOTORISTA_DIR="$REPO_DIR/app_homologacao/frontend_motorista"
FRONTEND_V2_DIR="$REPO_DIR/app_homologacao/frontend_v2"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.61.1-jammy"
EVID_DIR="$REPO_DIR/docs/specs/adiantamento-motorista/evidencias/6.9"
mkdir -p "$EVID_DIR"
RUN_LOG="$EVID_DIR/6.9.1-adiantamento-e2e-browser-run-$(date -u +%Y%m%dT%H%M%SZ).log"

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

echo "rodando build+start do app motorista (porta 3006) + playwright test (a partir de frontend_v2), MESMO container oficial…"
set -o pipefail
docker run --rm --memory=1536m \
  -e BACKEND_URL="http://127.0.0.1:9" \
  -e NODE_ENV=production \
  -e MOTORISTA_E2E_BASE_URL="http://127.0.0.1:3006" \
  -e CI=true \
  -v "$MOTORISTA_DIR:/motorista" \
  -v "$FRONTEND_V2_DIR:/work" \
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
    cd /work
    npx playwright test -c playwright.config.motorista-adiantamento.ts
  ' \
  2>&1 | tee "$RUN_LOG"
PW_EXIT=${PIPESTATUS[0]}
set +o pipefail

echo
echo "=== log completo: $RUN_LOG ==="
if [ "$PW_EXIT" = "0" ]; then
  echo "HUB-MOTORISTA-ADIANTAMENTO-E2E-BROWSER: OK — US1/US2/US7 + 6.8.2/6.8.3 verdes"
else
  echo "HUB-MOTORISTA-ADIANTAMENTO-E2E-BROWSER: Playwright FALHOU (exit=$PW_EXIT)" >&2
fi
exit "$PW_EXIT"

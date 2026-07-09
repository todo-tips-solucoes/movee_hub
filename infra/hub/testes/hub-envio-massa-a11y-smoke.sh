#!/usr/bin/env bash
# =============================================================================
# hub-envio-massa-a11y-smoke.sh — hub-envio-massa (S8), tasks.md FASE 5.2:
# smoke de a11y/teclado da montagem /hub/dashboard/envio_massa no hub-homolog
# ISOLADO (nunca produção). Playwright DENTRO da imagem oficial
# mcr.microsoft.com/playwright (mesmo padrão de hub-shell-e2e-browser.sh —
# nunca `npx playwright install --with-deps`/apt no host).
#
# Contas usadas (persistentes, sintéticas, já existentes no hub_homolog_db):
#   hub:    qa.importacoes@moveelog.local (admin_entidade, empresa 9001)
#   legado: qa.envio-massa.matriz@hub-test.local (Empresa 9001, seed 0034)
# Nenhum seed/cleanup de dados é necessário — a suíte é somente-leitura
# (dialogs abertos são fechados com Escape, nada é submetido).
#
# Uso: infra/hub/testes/hub-envio-massa-a11y-smoke.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$HUB_DIR/../.." && pwd)"
FRONTEND_DIR="$REPO_DIR/app_homologacao/frontend_v2"
ENV_FILE="${HUB_HOMOLOG_ENV:-/var/lib/hub_secrets/.env.hub.homolog}"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.61.1-jammy"
EVID_DIR="$REPO_DIR/docs/specs/hub-envio-massa/evidencias"
mkdir -p "$EVID_DIR"
RUN_LOG="$EVID_DIR/5.2-a11y-smoke-run-$(date -u +%Y%m%dT%H%M%SZ).log"

. "$HUB_DIR/scripts/lib.sh"
HUB_DOMAIN="$(get_var HUB_DOMAIN "$ENV_FILE")"; HUB_HTTPS_PORT="$(get_var HUB_HTTPS_PORT "$ENV_FILE")"
[ -n "$HUB_DOMAIN" ] && [ -n "$HUB_HTTPS_PORT" ] || { echo "HUB_DOMAIN/HUB_HTTPS_PORT ausentes em $ENV_FILE" >&2; exit 2; }

if [ "$(hostname)" != "VPSTodo" ]; then
  echo "ABORTADO: host inesperado '$(hostname)' (esperado VPSTodo)" >&2; exit 2
fi

echo "=== rito anti-starvation: estado do host ANTES ==="
free -h
AVAIL_KB=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
if [ "${AVAIL_KB:-0}" -lt 2097152 ]; then
  echo "ABORTADO: RAM disponível < 2Gi — não prosseguir (lição 2026-06-11)" >&2
  exit 2
fi
for svc in hub_homolog_frontend hub_homolog_backend hub_homolog_traefik; do
  st="$(docker ps --format '{{.Names}}\t{{.Status}}' | grep "^${svc}" | awk '{print $2}')"
  case "$st" in
    Up*) : ;;
    *) echo "ABORTADO: serviço '$svc' não está Up (obtido: '${st:-ausente}')" >&2; exit 2 ;;
  esac
done
echo "=== rito anti-starvation: OK, prosseguindo ==="

BASE_URL="https://$HUB_DOMAIN:$HUB_HTTPS_PORT"
echo "=== Playwright ($PLAYWRIGHT_IMAGE) contra $BASE_URL (network host + add-host local) ==="
set -o pipefail
docker run --rm --memory=1g --network host \
  --add-host "$HUB_DOMAIN:127.0.0.1" \
  -e HUB_E2E_BASE_URL="$BASE_URL" \
  -e HUB_E2E_HUB_EMAIL="${HUB_E2E_HUB_EMAIL:-qa.importacoes@moveelog.local}" \
  -e HUB_E2E_HUB_SENHA="${HUB_E2E_HUB_SENHA:-Teste@Hub2026}" \
  -e HUB_E2E_LEGADO_EMAIL="${HUB_E2E_LEGADO_EMAIL:-qa.envio-massa.matriz@hub-test.local}" \
  -e HUB_E2E_LEGADO_SENHA="${HUB_E2E_LEGADO_SENHA:-EnvioMassaQA@2026}" \
  -e CI=true \
  -v "$FRONTEND_DIR:/work" \
  -w /work \
  "$PLAYWRIGHT_IMAGE" \
  bash -lc 'npx playwright test -c playwright.config.hub-envio-massa.ts' \
  2>&1 | tee "$RUN_LOG"
PW_EXIT=${PIPESTATUS[0]}
set +o pipefail

# Evidências geradas pelos specs (JSONs do tab-walk e da comparação ARIA)
EVID_SRC="$FRONTEND_DIR/tests/e2e-hub-envio-massa/.evidencias"
if [ -d "$EVID_SRC" ]; then
  cp -v "$EVID_SRC"/*.json "$EVID_DIR/" 2>/dev/null || true
  rm -rf "$EVID_SRC"
fi

echo
echo "=== log completo: $RUN_LOG ==="
if [ "$PW_EXIT" = "0" ]; then
  echo "HUB-ENVIO-MASSA-A11Y-SMOKE: OK — 5.2.1/5.2.2 verdes (evidências em $EVID_DIR)"
else
  echo "HUB-ENVIO-MASSA-A11Y-SMOKE: FALHOU (exit=$PW_EXIT)" >&2
fi
exit "$PW_EXIT"

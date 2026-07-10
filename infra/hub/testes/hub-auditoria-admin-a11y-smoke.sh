#!/usr/bin/env bash
# =============================================================================
# hub-auditoria-admin-a11y-smoke.sh — hub-auditoria-admin (S9), tasks.md
# FASE 6.3: smoke de a11y/teclado + tema das 4 telas NOVAS/evoluídas
# (/hub/dashboard/auditoria, /usuarios, /usuarios/papeis, /admin) no
# hub-homolog ISOLADO (nunca produção). Mesmo padrão de
# hub-envio-massa-a11y-smoke.sh (S8): Playwright DENTRO da imagem oficial
# mcr.microsoft.com/playwright (nunca `npx playwright install --with-deps`/
# apt no host).
#
# Contas usadas:
#   qa.importacoes@moveelog.local (admin_entidade, empresa 9001, persistente)
#   admin_plataforma temporário — reativado por este driver ANTES da suíte
#     (Usuario id=58 / UsuarioEntidade id=65, desativados no fim da FASE
#     6.2) e desativado de novo ao final (nunca DELETE — trilha imutável).
#
# Uso: infra/hub/testes/hub-auditoria-admin-a11y-smoke.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$HUB_DIR/../.." && pwd)"
FRONTEND_DIR="$REPO_DIR/app_homologacao/frontend_v2"
ENV_FILE="${HUB_HOMOLOG_ENV:-/var/lib/hub_secrets/.env.hub.homolog}"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.61.1-jammy"
EVID_DIR="$REPO_DIR/docs/specs/hub-auditoria-admin/evidencias"
mkdir -p "$EVID_DIR"
RUN_LOG="$EVID_DIR/6.3-a11y-smoke-run-$(date -u +%Y%m%dT%H%M%SZ).log"

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
for svc in hub_homolog_frontend hub_homolog_backend hub_homolog_traefik hub_homolog_db; do
  st="$(docker ps --format '{{.Names}}\t{{.Status}}' | grep "^${svc}" | awk '{print $2}')"
  case "$st" in
    Up*) : ;;
    *) echo "ABORTADO: serviço '$svc' não está Up (obtido: '${st:-ausente}')" >&2; exit 2 ;;
  esac
done
echo "=== rito anti-starvation: OK, prosseguindo ==="

# Reativa temporariamente o usuário admin_plataforma de teste (6.2) para
# exercitar /admin com permissão real — desativado de novo no final
# (trap), nunca DELETE (Auditoria.usuario_id é FK, trilha imutável).
echo "=== reativando usuário admin_plataforma temporário (id=58/65) para a suíte ==="
docker exec hub_homolog_db psql -U hub_homolog -d hub_homolog -c \
  "UPDATE \"Usuario\" SET ativo=true WHERE id=58; UPDATE \"UsuarioEntidade\" SET ativo=true WHERE id=65;" \
  || { echo "ABORTADO: falha ao reativar usuário admin_plataforma de teste" >&2; exit 2; }

cleanup() {
  echo "=== desativando de novo o usuário admin_plataforma temporário (nunca DELETE) ==="
  docker exec hub_homolog_db psql -U hub_homolog -d hub_homolog -c \
    "UPDATE \"Usuario\" SET ativo=false WHERE id=58; UPDATE \"UsuarioEntidade\" SET ativo=false WHERE id=65;"
  echo "=== reiniciando hub_homolog_backend para descartar cache RBAC de 60s ==="
  docker restart hub_homolog_backend >/dev/null
}
trap cleanup EXIT

BASE_URL="https://$HUB_DOMAIN:$HUB_HTTPS_PORT"
echo "=== Playwright ($PLAYWRIGHT_IMAGE) contra $BASE_URL (network host + add-host local) ==="
set -o pipefail
docker run --rm --memory=1g --network host \
  --add-host "$HUB_DOMAIN:127.0.0.1" \
  -e HUB_E2E_BASE_URL="$BASE_URL" \
  -e HUB_E2E_HUB_EMAIL="${HUB_E2E_HUB_EMAIL:-qa.importacoes@moveelog.local}" \
  -e HUB_E2E_HUB_SENHA="${HUB_E2E_HUB_SENHA:-Teste@Hub2026}" \
  -e HUB_E2E_ADMIN_PLATAFORMA_EMAIL="${HUB_E2E_ADMIN_PLATAFORMA_EMAIL:-qa-admin-plataforma@moveelog.local}" \
  -e HUB_E2E_ADMIN_PLATAFORMA_SENHA="${HUB_E2E_ADMIN_PLATAFORMA_SENHA:-Teste@Hub2026Admin}" \
  -e HUB_E2E_ENTIDADE_ID="${HUB_E2E_ENTIDADE_ID:-9001}" \
  -e CI=true \
  -v "$FRONTEND_DIR:/work" \
  -w /work \
  "$PLAYWRIGHT_IMAGE" \
  bash -lc 'npx playwright test -c playwright.config.hub-auditoria-admin.ts' \
  2>&1 | tee "$RUN_LOG"
PW_EXIT=${PIPESTATUS[0]}
set +o pipefail

EVID_SRC="$FRONTEND_DIR/tests/e2e-hub-auditoria-admin/.evidencias"
if [ -d "$EVID_SRC" ]; then
  cp -v "$EVID_SRC"/*.json "$EVID_DIR/" 2>/dev/null || true
  rm -rf "$EVID_SRC"
fi

echo
echo "=== log completo: $RUN_LOG ==="
if [ "$PW_EXIT" = "0" ]; then
  echo "HUB-AUDITORIA-ADMIN-A11Y-SMOKE: OK"
else
  echo "HUB-AUDITORIA-ADMIN-A11Y-SMOKE: FALHOU (exit $PW_EXIT)" >&2
fi
exit "$PW_EXIT"

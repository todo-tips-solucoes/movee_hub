#!/usr/bin/env bash
# =============================================================================
# hub-motorista-360-e2e-browser.sh — hub-motorista-360, tasks.md FASE 8
# (8.2.1/8.2.2/8.2.3): E2E real da tela de detalhe do motorista contra o
# hub-homolog ISOLADO (nunca produção). Mesmo padrão enxuto de
# hub-auditoria-admin-a11y-smoke.sh (S9): Playwright DENTRO da imagem
# oficial mcr.microsoft.com/playwright (nunca instalado/apt no host —
# bash-guard.sh bloqueia; VPSTodo é produção do cliente), SEM `npm install`
# dentro do container (node_modules já presente no host via bind mount) —
# evita de propósito o gotcha já documentado em CLAUDE.md de o container
# reescrever package-lock.json; ainda assim este driver CONFERE e reverte
# ao final, como cinto-e-suspensório.
#
# NÃO sobe stack nova — usa o hub-homolog que já está no ar (docker compose
# -p hub-homolog). 2 fixtures "Entregador" sintéticas (empresa 9001, prefixo
# de uuid eeeeeeee-0000-0000-0000-*, distinto do usado por
# hub-motorista-360-integration-homolog.sh):
#   ENT_PENDENTE    — id_externo setado, SEM enriquecimento prévio (prova
#                      8.2.1 parte "aciona a busca").
#   ENT_ENRIQUECIDO — JÁ enriquecido via UPDATE direto (simula o worker já
#                      ter rodado) — prova 8.2.1 parte "vê os campos
#                      preenchidos" e 8.2.2 (RBAC leitura).
#
# Contas: qa.importacoes@moveelog.local (admin_entidade) e
# qa.motoristas.leitura@moveelog.local (leitura), ambas empresa 9001,
# senha Teste@Hub2026 (convenção documentada na memória do projeto).
#
# 🔴 dec-072: nenhuma URL de foto de documento é seedada aqui. PII: todo
# dado é sintético (prefixo "E2E360"/"SINTETICO-").
#
# Uso: infra/hub/testes/hub-motorista-360-e2e-browser.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$HUB_DIR/../.." && pwd)"
FRONTEND_DIR="$REPO_DIR/app_homologacao/frontend_v2"
ENV_FILE="${HUB_HOMOLOG_ENV:-/var/lib/hub_secrets/.env.hub.homolog}"
COMPOSE="$HUB_DIR/compose.hub.homolog.yml"
PROJECT="hub-homolog"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.61.1-jammy"
EVID_DIR="$REPO_DIR/docs/specs/hub-motorista-360/evidencias"
mkdir -p "$EVID_DIR"
RUN_LOG="$EVID_DIR/8.2-e2e-browser-run-$(date -u +%Y%m%dT%H%M%SZ).log"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
HUB_DOMAIN="$(get_var HUB_DOMAIN "$ENV_FILE")"; HUB_HTTPS_PORT="$(get_var HUB_HTTPS_PORT "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] && [ -n "$HUB_DOMAIN" ] && [ -n "$HUB_HTTPS_PORT" ] \
  || { echo "HUB_DB_USER/HUB_DB_NAME/HUB_DOMAIN/HUB_HTTPS_PORT ausentes em $ENV_FILE" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
psql_val() { psql_t -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }

if [ "$(hostname)" != "VPSTodo" ]; then
  echo "ABORTADO: host inesperado '$(hostname)' (esperado VPSTodo)" >&2; exit 2
fi

echo "=== rito anti-starvation: estado do host ANTES ==="
free -h
AVAIL_KB=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
SWAP_FREE_KB=$(awk '/SwapFree/{print $2}' /proc/meminfo)
if [ "${AVAIL_KB:-0}" -lt 2097152 ]; then
  echo "ABORTADO: RAM disponível < 2Gi — não prosseguir (lição 2026-06-11)" >&2
  exit 2
fi
if [ "${SWAP_FREE_KB:-0}" -lt 512000 ]; then
  echo "ABORTADO: swap livre < 500Mi — não prosseguir (pressão de memória do host)" >&2
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

EMPRESA=9001
UUID_PREFIX="eeeeeeee-0000-0000-0000-00000000000"
UUID_PENDENTE="${UUID_PREFIX}1"
UUID_ENRIQUECIDO="${UUID_PREFIX}2"

cleanup_rows() {
  echo
  echo "=== cleanup: removendo fixtures E2E360 (uuid prefix $UUID_PREFIX) ==="
  psql_t <<SQL >/dev/null || true
SET session_replication_role = replica;
DELETE FROM "Auditoria" WHERE recurso='Entregador' AND recurso_id IN (
  SELECT id::text FROM "Entregador" WHERE id_empresa = $EMPRESA AND id_externo::text LIKE '$UUID_PREFIX%'
);
DELETE FROM "Entregador" WHERE id_empresa = $EMPRESA AND id_externo::text LIKE '$UUID_PREFIX%';
SQL
  echo "=== cleanup: concluído ==="
  echo "=== conferindo package-lock.json (gotcha do container Playwright) ==="
  if ! git -C "$FRONTEND_DIR" diff --quiet -- package-lock.json 2>/dev/null; then
    echo "AVISO: package-lock.json foi alterado pelo container — revertendo" >&2
    git -C "$FRONTEND_DIR" checkout -- package-lock.json
  else
    echo "package-lock.json intacto"
  fi
  echo "=== estado do host DEPOIS ==="
  free -h
}
trap cleanup_rows EXIT

echo "=== seed: 2 fixtures Entregador (empresa $EMPRESA) ==="
psql_t -c "INSERT INTO \"Entregador\" (id_empresa, id_externo, nome) VALUES ($EMPRESA, '$UUID_PENDENTE', 'E2E360 Pendente Busca');" >/dev/null
ENT_PENDENTE_ID="$(psql_val "SELECT id FROM \"Entregador\" WHERE id_externo='$UUID_PENDENTE';")"

JSON_ENRIQ='{"dadosPessoais":{"nomeCompleto":"E2E360 Nome EntreGo C","dataNascimento":"1992-02-02","email":"sintetico360c@example.invalid","cpf":"SINTETICO-CPF-222.222.222-22","nomeMae":"SINTETICO Mae C","nomePai":"SINTETICO Pai C","telefone":"+5511900000004"},"documentos":{"rg":"SINTETICO-RG-22.222.222-2","cnh":"SINTETICO-CNH-99999999999"},"contatoEmergencia":{"grauParentesco":"irma","nome":"SINTETICO Contato C","telefone":"+5511900000005"},"informacoesEntrega":{"operadorLogistico":"SINTETICO Operador C","modal":"bike"}}'
psql_t -c "INSERT INTO \"Entregador\" (id_empresa, id_externo, nome, dados_entrego_json, dados_entrego_enriquecidos_em) VALUES ($EMPRESA, '$UUID_ENRIQUECIDO', 'E2E360 Enriquecido Completo', '$JSON_ENRIQ'::jsonb, now());" >/dev/null
ENT_ENRIQUECIDO_ID="$(psql_val "SELECT id FROM \"Entregador\" WHERE id_externo='$UUID_ENRIQUECIDO';")"

[ -n "$ENT_PENDENTE_ID" ] && [ -n "$ENT_ENRIQUECIDO_ID" ] || { echo "FAIL: seed das fixtures Entregador"; exit 1; }
echo "=== seeds OK: ENT_PENDENTE_ID=$ENT_PENDENTE_ID ENT_ENRIQUECIDO_ID=$ENT_ENRIQUECIDO_ID ==="

BASE_URL="https://$HUB_DOMAIN:$HUB_HTTPS_PORT"
echo "=== Playwright ($PLAYWRIGHT_IMAGE) contra $BASE_URL (network host + add-host local) ==="
set -o pipefail
docker run --rm --memory=1g --network host \
  --add-host "$HUB_DOMAIN:127.0.0.1" \
  -e HUB_E2E_BASE_URL="$BASE_URL" \
  -e HUB_E2E_ADMIN_EMAIL="${HUB_E2E_ADMIN_EMAIL:-qa.importacoes@moveelog.local}" \
  -e HUB_E2E_ADMIN_SENHA="${HUB_E2E_ADMIN_SENHA:-Teste@Hub2026}" \
  -e HUB_E2E_LEITURA_EMAIL="${HUB_E2E_LEITURA_EMAIL:-qa.motoristas.leitura@moveelog.local}" \
  -e HUB_E2E_LEITURA_SENHA="${HUB_E2E_LEITURA_SENHA:-Teste@Hub2026}" \
  -e HUB_E2E_ENT_PENDENTE_ID="$ENT_PENDENTE_ID" \
  -e HUB_E2E_ENT_ENRIQUECIDO_ID="$ENT_ENRIQUECIDO_ID" \
  -e CI=true \
  -v "$FRONTEND_DIR:/work" \
  -w /work \
  "$PLAYWRIGHT_IMAGE" \
  bash -lc 'npx playwright test -c playwright.config.hub-motorista-360.ts' \
  2>&1 | tee "$RUN_LOG"
PW_EXIT=${PIPESTATUS[0]}
set +o pipefail

echo
echo "=== log completo: $RUN_LOG ==="
if [ "$PW_EXIT" = "0" ]; then
  echo "HUB-MOTORISTA-360-E2E-BROWSER: OK — 8.2.1/8.2.2 verdes"
else
  echo "HUB-MOTORISTA-360-E2E-BROWSER: FALHOU (exit $PW_EXIT)" >&2
fi
exit "$PW_EXIT"

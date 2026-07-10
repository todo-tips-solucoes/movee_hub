#!/usr/bin/env bash
# =============================================================================
# hub-auditoria-expurgo-integration.sh — D5 (migration 0041): retenção de
# 12 meses + expurgo mensal da Auditoria, num projeto hub-test EFÊMERO
# (db-only). Nunca toca chatmasterveloz/produção nem o hub-homolog.
#
# Cobre:
#   (a) imutabilidade PRESERVADA: DELETE/UPDATE diretos (mesmo como role de
#       manutenção do container) continuam bloqueados pelo trigger da 0004;
#   (b) hub_auditoria_expurgo() remove SOMENTE eventos além da retenção e
#       retorna a contagem exata;
#   (c) meta-evento global 'auditoria_expurgo' registrado com a contagem;
#   (d) re-execução no mesmo mês = 0 removidos (idempotência operacional);
#   (e) retenção < 1 mês é rejeitada (guarda contra chamada acidental);
#   (f) role de aplicação (`authenticated`) NÃO consegue executar a função.
#
# Uso: infra/hub/testes/hub-auditoria-expurgo-integration.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)"
PROJECT="hub-test-$RUNID"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
cleanup() { dc down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails + 1)); fi
}

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }

echo "subindo db efêmero ($PROJECT, tmpfs)…"
dc up -d --wait db
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >/dev/null 2>&1 \
  || { echo "FAIL: migrate.sh"; exit 1; }

# seed: 3 eventos VELHOS (13 meses), 1 no limiar mantido (11 meses), 2 recentes
psql_t <<'SQL' >/dev/null
INSERT INTO "Auditoria" (id_empresa, acao, recurso, detalhes, criado_em) VALUES
  (930001, 'evento_velho_1', 'Teste', '{}'::jsonb, now() - interval '13 months'),
  (930001, 'evento_velho_2', 'Teste', '{}'::jsonb, now() - interval '14 months'),
  (NULL,   'evento_velho_global', 'Teste', '{}'::jsonb, now() - interval '13 months'),
  (930001, 'evento_limiar', 'Teste', '{}'::jsonb, now() - interval '11 months'),
  (930001, 'evento_recente_1', 'Teste', '{}'::jsonb, now() - interval '1 day'),
  (NULL,   'evento_recente_global', 'Teste', '{}'::jsonb, now());
SQL

# (a) imutabilidade preservada fora da função
DEL_DIRETO="$(psql_t -tAc 'DELETE FROM "Auditoria" WHERE acao=$$evento_velho_1$$' 2>&1 | grep -c 'imutavel' || true)"
check "(a) DELETE direto continua bloqueado pelo trigger da 0004" "$DEL_DIRETO" "1"
UPD_DIRETO="$(psql_t -tAc 'UPDATE "Auditoria" SET recurso=$$X$$ WHERE acao=$$evento_recente_1$$' 2>&1 | grep -c 'imutavel' || true)"
check "(a) UPDATE direto continua bloqueado" "$UPD_DIRETO" "1"

# (b) expurgo remove exatamente os 3 velhos
REMOVIDOS="$(psql_t -tAc "SELECT hub_auditoria_expurgo(interval '12 months')" | tr -d '[:space:]')"
check "(b) expurgo retorna exatamente 3 (só os eventos além de 12 meses)" "$REMOVIDOS" "3"
check "(b) eventos velhos: 0 restantes" "$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao LIKE 'evento_velho%'" | tr -d '[:space:]')" "0"
check "(b) evento no limiar (11 meses) MANTIDO" "$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='evento_limiar'" | tr -d '[:space:]')" "1"
check "(b) eventos recentes mantidos" "$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao LIKE 'evento_recente%'" | tr -d '[:space:]')" "2"

# (c) meta-evento global com a contagem
META="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='auditoria_expurgo' AND id_empresa IS NULL AND (detalhes->>'removidos')::int = 3" | tr -d '[:space:]')"
check "(c) meta-evento global 'auditoria_expurgo' registrado com removidos=3" "$META" "1"

# (d) re-execução = 0 (nada mais além da retenção)
REMOVIDOS2="$(psql_t -tAc "SELECT hub_auditoria_expurgo(interval '12 months')" | tr -d '[:space:]')"
check "(d) re-execução remove 0 (idempotência operacional)" "$REMOVIDOS2" "0"

# (e) retenção < 1 mês rejeitada
CURTA="$(psql_t -tAc "SELECT hub_auditoria_expurgo(interval '1 day')" 2>&1 | grep -c 'retencao minima' || true)"
check "(e) retenção < 1 mês é rejeitada" "$CURTA" "1"

# (f) role de aplicação não executa a função (REVOKE ALL FROM PUBLIC, sem grant)
APP_NEGADO="$(psql_t -tAc "SET ROLE authenticated; SELECT hub_auditoria_expurgo()" 2>&1 | grep -c 'permission denied' || true)"
check "(f) role authenticated NÃO executa hub_auditoria_expurgo (fail-closed)" "$APP_NEGADO" "1"

echo
if [ "$fails" = "0" ]; then
  echo "HUB-AUDITORIA-EXPURGO-INTEGRATION: OK — todos os asserts passaram (D5/0041)"
  exit 0
else
  echo "HUB-AUDITORIA-EXPURGO-INTEGRATION: $fails assert(s) FALHARAM" >&2
  exit 1
fi

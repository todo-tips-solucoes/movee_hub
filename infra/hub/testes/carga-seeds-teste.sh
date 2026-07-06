#!/usr/bin/env bash
# =============================================================================
# carga-seeds-teste.sh — prova o pipeline de carga dos seeds anonimizados num
# ambiente TEST efêmero (Alternativa C, §4.3), sem tocar o homolog.
#
# O banco hub_homolog da S1 permanece VAZIO (+SchemaMigration): o Prompt A
# proíbe schema funcional. Aqui as tabelas de staging são criadas AD HOC num
# projeto hub-test-<runid> descartável (tmpfs) e destruídas no down -v.
#
# Uso: infra/hub/testes/carga-seeds-teste.sh [dir-seeds=infra/hub/seeds/out]
# =============================================================================
set -euo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SEEDS="${1:-$HUB_DIR/seeds/out}"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)"
PROJECT="hub-test-$RUNID"

[ -d "$SEEDS/faturamento" ] || { echo "seeds não encontrados em $SEEDS (rode gen-seeds.py)" >&2; exit 1; }

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
cleanup() { dc down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE"

echo "subindo banco efêmero ($PROJECT, tmpfs)…"
dc up -d --wait db

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }

load_dataset() { # load_dataset <nome> <dir>
  local name="$1" dir="$2" header ddl rows
  header="$(head -1 "$(ls "$dir"/*.csv | head -1)" | tr -d '\r')"
  ddl="CREATE TABLE staging_$name ($(echo "$header" | awk -F';' '{for(i=1;i<=NF;i++) printf "%s\"%s\" text", (i>1?", ":""), $i}'));"
  psql_t -c "$ddl" >/dev/null
  # Um único exec/\copy por dataset (review S1: 730 execs no dataset S10 de
  # 365 dias custariam minutos só de overhead de CLI): stream de todos os
  # arquivos sem header em um só pipe.
  { for f in "$dir"/*.csv; do tail -n +2 "$f"; done; } \
    | psql_t -c "\\copy staging_$name FROM STDIN WITH (FORMAT csv, DELIMITER ';', HEADER false)" >/dev/null
  rows="$(psql_t -tAc "SELECT count(*) FROM staging_$name")"
  echo "  staging_$name: $rows linhas carregadas de $(ls "$dir"/*.csv | wc -l) arquivo(s)"
}

echo "carregando seeds anonimizados…"
load_dataset faturamento "$SEEDS/faturamento"
load_dataset performance "$SEEDS/performance"

echo "verificação de conteúdo (amostras NUNCA são impressas — só agregados):"
psql_t -tAc "SELECT 'faturamento: ' || count(*) || ' linhas, ' || count(DISTINCT id_da_pessoa_entregadora) || ' entregadores anon' FROM staging_faturamento"
psql_t -tAc "SELECT 'performance: ' || count(*) || ' linhas, ' || count(DISTINCT id_da_pessoa_entregadora) || ' entregadores anon' FROM staging_performance"

echo "derrubando ambiente efêmero (down -v)…"
cleanup
trap - EXIT
echo "CARGA DE SEEDS: OK (projeto $PROJECT destruído; homolog intocado)"

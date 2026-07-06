#!/usr/bin/env bash
# =============================================================================
# restore.sh — testa a restauração de um dump (teste de isolamento §4.11 #20).
# Restaura o dump mais recente (ou o passado em -d) num banco hub_restore e
# compara contagem de linhas tabela a tabela com o banco de origem.
# Em caso de falha o dump é preservado para diagnóstico.
#
# Uso:
#   infra/hub/scripts/restore.sh -f <compose.yml> -p <projeto> -e <env-file> \
#     [-d <arquivo.dump>] [--keep]
# =============================================================================
set -euo pipefail

COMPOSE_FILE="" PROJECT="" ENV_FILE="" DUMP="" KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    -f) COMPOSE_FILE="$2"; shift 2 ;;
    -p) PROJECT="$2"; shift 2 ;;
    -e) ENV_FILE="$2"; shift 2 ;;
    -d) DUMP="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "uso: $0 -f compose.yml -p projeto -e env-file [-d dump] [--keep]" >&2; exit 2 ;;
  esac
done
[ -n "$COMPOSE_FILE" ] && [ -n "$PROJECT" ] && [ -n "$ENV_FILE" ] || { echo "argumentos -f/-p/-e obrigatórios" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE_FILE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }

dc exec -T backup bash -s -- "$DUMP" "$KEEP" <<'SCRIPT'
set -euo pipefail
DUMP="${1:-}"
KEEP="${2:-0}"
if [ -z "$DUMP" ]; then
  DUMP="$(ls -1t /backups/*.dump 2>/dev/null | head -1 || true)"
fi
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "nenhum dump encontrado em /backups" >&2; exit 1; }
echo "restaurando: $DUMP"

export PGDATABASE_RESTORE=hub_restore
dropdb --if-exists -h "$PGHOST" -U "$PGUSER" "$PGDATABASE_RESTORE"
createdb -h "$PGHOST" -U "$PGUSER" "$PGDATABASE_RESTORE"
pg_restore -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE_RESTORE" --no-owner "$DUMP"

# Compara contagens tabela a tabela (schema public)
TABLES="$(psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -tAc \
  "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1")"
FAIL=0
for t in $TABLES; do
  a="$(psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -tAc "SELECT count(*) FROM \"$t\"")"
  b="$(psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE_RESTORE" -tAc "SELECT count(*) FROM \"$t\"" 2>/dev/null || echo "AUSENTE")"
  if [ "$a" = "$b" ]; then
    echo "  OK  $t: origem=$a restore=$b"
  else
    echo "  DIVERGE  $t: origem=$a restore=$b"
    FAIL=1
  fi
done

if [ "$FAIL" = "0" ]; then
  dropdb -h "$PGHOST" -U "$PGUSER" "$PGDATABASE_RESTORE"
  if [ "$KEEP" != "1" ] && [[ "$DUMP" == *"_restoretest_"* ]]; then rm -f "$DUMP"; fi
  echo "RESTORE OK: contagens iguais em todas as tabelas"
else
  echo "RESTORE FALHOU: dump preservado em $DUMP para diagnóstico" >&2
  exit 1
fi
SCRIPT

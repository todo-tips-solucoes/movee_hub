#!/usr/bin/env bash
# =============================================================================
# migrate.sh — aplica a série única de migrations (infra/hub/migrations/*.sql)
# no banco do hub, com registro em "SchemaMigration" e SIGUSR1 no PostgREST
# (§4.6/§4.10). Idempotente: migration já registrada é pulada.
#
# Uso:
#   infra/hub/scripts/migrate.sh -f <compose.yml> -p <projeto> -e <env-file>
# =============================================================================
set -euo pipefail

COMPOSE_FILE="" PROJECT="" ENV_FILE=""
while getopts "f:p:e:" opt; do
  case "$opt" in
    f) COMPOSE_FILE="$OPTARG" ;;
    p) PROJECT="$OPTARG" ;;
    e) ENV_FILE="$OPTARG" ;;
    *) echo "uso: $0 -f compose.yml -p projeto -e env-file" >&2; exit 2 ;;
  esac
done
[ -n "$COMPOSE_FILE" ] && [ -n "$PROJECT" ] && [ -n "$ENV_FILE" ] || { echo "argumentos -f/-p/-e obrigatórios" >&2; exit 2; }

MIG_DIR="$(cd "$(dirname "$0")/../migrations" && pwd)"

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"
DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes no env-file" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE_FILE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
psql_exec() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }

# Bootstrap: a 0000 cria a própria SchemaMigration (IF NOT EXISTS — reexecutável).
# Lista de aplicadas carregada UMA vez (2 execs no total, não 2 por migration).
APPLIED=""
if psql_exec -tAc "SELECT 1 FROM pg_tables WHERE tablename='SchemaMigration'" | grep -q 1; then
  APPLIED="$(psql_exec -tAc 'SELECT nome FROM "SchemaMigration"')"
fi
applied() { printf '%s\n' "$APPLIED" | grep -qx "$1"; }

count=0
for f in "$MIG_DIR"/*.sql; do
  [ -e "$f" ] || { echo "nenhuma migration em $MIG_DIR"; exit 1; }
  nome="$(basename "$f")"
  if applied "$nome"; then
    echo "pulada (já aplicada): $nome"
    continue
  fi
  echo "aplicando: $nome"
  psql_exec -1 -f - <"$f"
  psql_exec -c "INSERT INTO \"SchemaMigration\" (nome) VALUES ('$nome') ON CONFLICT (nome) DO NOTHING" >/dev/null
  count=$((count + 1))
done

# Recarrega o schema cache do PostgREST (mesmo mecanismo usado em produção)
if dc ps --services 2>/dev/null | grep -q '^postgrest$'; then
  dc kill -s SIGUSR1 postgrest
  echo "PostgREST: SIGUSR1 enviado (reload de schema)"
fi

echo "migrate: concluído ($count aplicadas agora)"
psql_exec -c 'SELECT id, nome, aplicado_em FROM "SchemaMigration" ORDER BY id'

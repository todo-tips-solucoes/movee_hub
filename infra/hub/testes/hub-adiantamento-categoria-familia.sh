#!/usr/bin/env bash
# Driver do teste da 0087 (famílias de categoria) contra o hub-homolog.
#
# Roda migration + teste numa transação que termina em ROLLBACK: não deixa
# nada no banco, então serve tanto ANTES quanto DEPOIS de a 0087 ser aplicada.
#
#   infra/hub/testes/hub-adiantamento-categoria-familia.sh            # com a 0087
#   SEM_MIGRATION=1 infra/hub/testes/hub-adiantamento-categoria-familia.sh  # controle negativo
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
DB=hub_homolog_db
MIG="$RAIZ/infra/hub/migrations/0087_adiantamento_categoria_familia.sql"
TESTE="$RAIZ/infra/hub/testes/sql/0087-categoria-familia.test.sql"

{
  echo 'BEGIN;'
  [ "${SEM_MIGRATION:-}" = 1 ] || cat "$MIG"
  cat "$TESTE"
  echo 'ROLLBACK;'
} | docker exec -i "$DB" sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>&1 \
  | grep -E 'NOTICE|WARNING|ERROR|FALHOU' | sed 's/^psql:[^ ]* //'

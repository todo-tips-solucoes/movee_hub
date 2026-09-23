#!/usr/bin/env bash
# Driver do teste da 0094 (índice em EnvioMassa.cnpj_prestador) contra o
# hub-homolog. Tudo numa transação que termina em ROLLBACK.
#
#   infra/hub/testes/hub-indice-cnpj.sh                  # normal
#   SEM_MIGRATION=1 infra/hub/testes/hub-indice-cnpj.sh  # controle: sem o índice, o teste tem de pegar (falha já no bloco 1)
#   CONTROLE_PLANEJADOR=1 infra/hub/testes/hub-indice-cnpj.sh # controle do bloco 3: o índice EXISTE mas o planejador é forçado a ignorá-lo
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
DB=hub_homolog_db
MIG="$RAIZ/infra/hub/migrations/0094_indice_envio_massa_cnpj.sql"
TESTE="$RAIZ/infra/hub/testes/sql/0094-indice-cnpj.test.sql"

{
  echo 'BEGIN;'
  [ "${SEM_MIGRATION:-}" = 1 ] || cat "$MIG"
  # Índice presente, planejador proibido de usá-lo: separa "o índice existe" de
  # "o índice serve para alguma coisa".
  [ "${CONTROLE_PLANEJADOR:-}" = 1 ] && echo 'SET enable_indexscan = off; SET enable_bitmapscan = off;'
  cat "$TESTE"
  echo 'ROLLBACK;'
} | docker exec -i "$DB" sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>&1 \
  | grep -E 'NOTICE|WARNING|ERROR|FALHOU' | sed 's/^psql:[^ ]* //'

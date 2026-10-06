#!/usr/bin/env bash
# Driver do teste da 0104 (trava de poupança vale para conta VIVA) contra o
# hub-homolog. Transação que termina em ROLLBACK.
#
#   infra/hub/testes/hub-poupanca-carga.sh                     # normal
#   CONTROLE_CARGA=1 infra/hub/testes/hub-poupanca-carga.sh     # sem a exceção da carga, o teste tem de pegar
#   CONTROLE_STATUS=1 infra/hub/testes/hub-poupanca-carga.sh    # sem a isenção por status, o teste tem de pegar
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
DB=hub_homolog_db
MIG="$RAIZ/infra/hub/migrations/0104_carga_inicial_pode_poupanca.sql"
TESTE="$RAIZ/infra/hub/testes/sql/0104-poupanca-carga-e-aposentar.test.sql"

migration() {
  if [ "${CONTROLE_CARGA:-}" = 1 ]; then
    sed "s|    OR origem = 'CARGA_INICIAL'||" "$MIG"
  elif [ "${CONTROLE_STATUS:-}" = 1 ]; then
    # sem esta linha volta o bug da 0103: conta poupança não pode ser aposentada
    sed "s|    OR status IN ('CANCELADA', 'SUBSTITUIDA', 'REJEITADA')||" "$MIG"
  else
    cat "$MIG"
  fi
}

{ echo 'BEGIN;'; migration; cat "$TESTE"; echo 'ROLLBACK;'; } \
  | docker exec -i "$DB" sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>&1 \
  | grep -E 'NOTICE|WARNING|ERROR|FALHOU' | sed 's/^psql:[^ ]* //'

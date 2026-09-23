#!/usr/bin/env bash
# Driver do teste da 0092 (F4-B: divisão congelada na apuração + trilha da
# geração) contra o hub-homolog. Tudo numa transação que termina em ROLLBACK.
#
#   infra/hub/testes/hub-apuracao-divisao-nota.sh                   # normal
#   CONTROLE_RECALCULO=1 infra/hub/testes/hub-apuracao-divisao-nota.sh  # controle: se o congelado virar o `creditos` inteiro, o teste pega
#   ROLLBACK=1 infra/hub/testes/hub-apuracao-divisao-nota.sh         # aplica, reverte e confere
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
DB=hub_homolog_db
MIG="$RAIZ/infra/hub/migrations/0092_apuracao_divisao_nota_e_trilha.sql"
ANTES="$RAIZ/infra/hub/testes/sql/0092-antes.sql"
TESTE="$RAIZ/infra/hub/testes/sql/0092-divisao-nota.test.sql"
VOLTA="$RAIZ/infra/hub/testes/sql/0092-rollback.sql"
VOLTA_TESTE="$RAIZ/infra/hub/testes/sql/0092-rollback.test.sql"

migration() {
  if [ "${CONTROLE_RECALCULO:-}" = 1 ]; then
    # Estraga a divisão: a base da nota passa a ser TUDO (a gorjeta entraria na
    # nota). É o erro que custaria dinheiro de verdade.
    sed 's|l.total_nota, l.total_fora,|l.creditos, 0::numeric,|' "$MIG"
  else
    cat "$MIG"
  fi
}

{
  echo 'BEGIN;'
  cat "$ANTES"
  migration
  if [ "${ROLLBACK:-}" = 1 ]; then cat "$VOLTA" "$VOLTA_TESTE"; else cat "$TESTE"; fi
  echo 'ROLLBACK;'
} | docker exec -i "$DB" sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>&1 \
  | grep -E 'NOTICE|WARNING|ERROR|FALHOU' | sed 's/^psql:[^ ]* //'

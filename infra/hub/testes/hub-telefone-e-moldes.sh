#!/usr/bin/env bash
# Driver do teste da 0091 (F4-A: telefone no hub + moldes de mensagem) contra
# o hub-homolog. Tudo numa transação que termina em ROLLBACK.
#
#   infra/hub/testes/hub-telefone-e-moldes.sh                  # normal
#   (não existe SEM_MIGRATION aqui: depois que a 0091 é aplicada no ambiente, as
#    colunas passam a existir fora da transação e o teste passaria mesmo sem
#    reaplicar — seria um controle negativo oco. Os dois controles abaixo
#    continuam válidos porque atacam o BACKFILL, que age sobre fixtures criados
#    dentro da transação, sempre com telefone nulo.)
#   CONTROLE_LIXO=1 infra/hub/testes/hub-telefone-e-moldes.sh  # controle: backfill SEM o filtro de sanidade tem de ser pego
#   CONTROLE_ORDEM=1 infra/hub/testes/hub-telefone-e-moldes.sh # controle: backfill pegando o telefone ANTIGO tem de ser pego
#   ROLLBACK=1 infra/hub/testes/hub-telefone-e-moldes.sh       # aplica, reverte e confere
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
DB=hub_homolog_db
MIG="$RAIZ/infra/hub/migrations/0091_hub_dono_telefone_e_moldes.sql"
ANTES="$RAIZ/infra/hub/testes/sql/0091-antes.sql"
TESTE="$RAIZ/infra/hub/testes/sql/0091-telefone-e-moldes.test.sql"
VOLTA="$RAIZ/infra/hub/testes/sql/0091-rollback.sql"
VOLTA_TESTE="$RAIZ/infra/hub/testes/sql/0091-rollback.test.sql"

migration() {
  if [ "${CONTROLE_LIXO:-}" = 1 ]; then
    # Tira o filtro de sanidade: o motorista do fixture (b) passaria a herdar "55".
    sed "s|WHERE em.number ~ '\^\[0-9\]{12,13}\$' AND em.cnpj_prestador IS NOT NULL|WHERE em.number IS NOT NULL AND em.cnpj_prestador IS NOT NULL|" "$MIG"
  elif [ "${CONTROLE_ORDEM:-}" = 1 ]; then
    # Inverte a ordem: pegaria o telefone ANTIGO em vez do mais recente.
    sed 's|ORDER BY em.cnpj_prestador, em.created_at DESC|ORDER BY em.cnpj_prestador, em.created_at ASC|' "$MIG"
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

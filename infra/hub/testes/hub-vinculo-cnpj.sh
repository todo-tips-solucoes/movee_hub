#!/usr/bin/env bash
# Driver do teste da 0093 (vínculo do entregador ao CNPJ via EnvioMassa)
# contra o hub-homolog. Tudo numa transação que termina em ROLLBACK.
#
#   infra/hub/testes/hub-vinculo-cnpj.sh                   # normal
#   CONTROLE_HOMONIMO=1 infra/hub/testes/hub-vinculo-cnpj.sh  # controle: sem a guarda de homônimo, o teste tem de pegar
#   CONTROLE_AMBIGUO=1  infra/hub/testes/hub-vinculo-cnpj.sh  # controle: aceitando o 1º de vários CNPJs, o teste tem de pegar
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
DB=hub_homolog_db
MIG="$RAIZ/infra/hub/migrations/0093_vinculo_cnpj_por_envio_massa.sql"
TESTE="$RAIZ/infra/hub/testes/sql/0093-vinculo-cnpj.test.sql"

migration() {
  if [ "${CONTROLE_HOMONIMO:-}" = 1 ]; then
    # Tira a guarda de homônimo: dois entregadores de mesmo nome passariam a
    # receber o MESMO CNPJ — nota de um no outro.
    sed "s|WHEN c.chave IN (SELECT chave FROM homonimos) THEN 'HOMONIMO_INTERNO'||" "$MIG"
  elif [ "${CONTROLE_AMBIGUO:-}" = 1 ]; then
    # Aceita o primeiro de vários CNPJs em vez de recusar o ambíguo.
    sed "s|WHEN c.cnpjs > 1 THEN 'AMBIGUO'||" "$MIG"
  else
    cat "$MIG"
  fi
}

{ echo 'BEGIN;'; migration; cat "$TESTE"; echo 'ROLLBACK;'; } \
  | docker exec -i "$DB" sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>&1 \
  | grep -E 'NOTICE|WARNING|ERROR|FALHOU' | sed 's/^psql:[^ ]* //'

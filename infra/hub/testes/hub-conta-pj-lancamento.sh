#!/usr/bin/env bash
# Driver do teste da 0103 (conta só CORRENTE, lançamento pelo hub, busca de
# entregador) contra o hub-homolog. Tudo numa transação que termina em ROLLBACK.
#
#   infra/hub/testes/hub-conta-pj-lancamento.sh                      # normal
#   CONTROLE_POUPANCA=1 infra/hub/testes/hub-conta-pj-lancamento.sh  # sem a guarda de poupança, o teste tem de pegar
#   CONTROLE_ESCOPO=1   infra/hub/testes/hub-conta-pj-lancamento.sh  # sem o filtro de escopo, o teste tem de pegar
#   CONTROLE_BUSCA=1    infra/hub/testes/hub-conta-pj-lancamento.sh  # sem o piso de 3 caracteres, o teste tem de pegar
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
DB=hub_homolog_db
MIG="$RAIZ/infra/hub/migrations/0103_conta_bancaria_pj_e_lancamento_hub.sql"
TESTE="$RAIZ/infra/hub/testes/sql/0103-conta-pj-e-lancamento.test.sql"

migration() {
  if [ "${CONTROLE_POUPANCA:-}" = 1 ]; then
    sed "s|IF (p_dados ->> 'tipoConta') <> 'CORRENTE' THEN RAISE EXCEPTION 'POUPANCA_NAO_PERMITIDA'; END IF;||" "$MIG"
  elif [ "${CONTROLE_ESCOPO:-}" = 1 ]; then
    # só a guarda do LANÇAMENTO (a da busca fica, senão o teste 7 muda de causa)
    sed "s|^       AND id_empresa = ANY (hub_jwt_escopo_ids())$||" "$MIG"
  elif [ "${CONTROLE_BUSCA:-}" = 1 ]; then
    sed "s|IF char_length(v_busca) < 3 THEN RETURN; END IF;||" "$MIG"
  else
    cat "$MIG"
  fi
}

{ echo 'BEGIN;'; migration; cat "$TESTE"; echo 'ROLLBACK;'; } \
  | docker exec -i "$DB" sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>&1 \
  | grep -E 'NOTICE|WARNING|ERROR|FALHOU' | sed 's/^psql:[^ ]* //'

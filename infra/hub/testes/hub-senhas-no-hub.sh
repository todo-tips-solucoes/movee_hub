#!/usr/bin/env bash
# Driver do teste da 0095 (senhas do legado -> hub) contra o hub-homolog.
# Tudo numa transação que termina em ROLLBACK.
#
#   infra/hub/testes/hub-senhas-no-hub.sh                     # normal
#   CONTROLE_SOBRESCREVE=1 infra/hub/testes/hub-senhas-no-hub.sh  # controle: sem o guard `senha IS NULL`, o teste tem de pegar
#   CONTROLE_SEM_NORMALIZAR=1 infra/hub/testes/hub-senhas-no-hub.sh # controle: sem normalizar o CNPJ, o pontuado não casa
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
DB=hub_homolog_db
MIG="$RAIZ/infra/hub/migrations/0095_senhas_motorista_no_hub.sql"
ANTES="$RAIZ/infra/hub/testes/sql/0095-senhas-no-hub.test.sql"
DEPOIS="$RAIZ/infra/hub/testes/sql/0095-depois.test.sql"

migration() {
  if [ "${CONTROLE_SOBRESCREVE:-}" = 1 ]; then
    # Tira o guard: passaria a sobrescrever senha já definida no hub.
    sed 's| WHERE cm.senha IS NULL| WHERE true|' "$MIG"
  elif [ "${CONTROLE_SEM_NORMALIZAR:-}" = 1 ]; then
    # Não normaliza o CNPJ: o pontuado deixa de casar com o legado.
    sed "s|   SET cnpj_prestador = regexp_replace(cnpj_prestador, '\[^0-9\]', '', 'g')|   SET cnpj_prestador = cnpj_prestador|" "$MIG"
  else
    cat "$MIG"
  fi
}

{ echo 'BEGIN;'; cat "$ANTES"; migration; cat "$DEPOIS"; echo 'ROLLBACK;'; } \
  | docker exec -i "$DB" sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>&1 \
  | grep -E 'NOTICE|WARNING|ERROR|FALHOU' | sed 's/^psql:[^ ]* //'

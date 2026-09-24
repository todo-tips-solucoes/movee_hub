#!/usr/bin/env bash
# Driver do teste da 0096 (e-mail como cadastro do hub) contra o hub-homolog.
# Tudo numa transação que termina em ROLLBACK.
#
#   infra/hub/testes/hub-email-motorista.sh                    # normal
#   CONTROLE_PRECEDENCIA=1 infra/hub/testes/hub-email-motorista.sh # controle: sem o gatilho, o enriquecimento sobrescreve o hub
#   REAPLICAR=1 infra/hub/testes/hub-email-motorista.sh             # aplica 2x: o e-mail gravado pelo hub no meio tem de sobreviver
#   REAPLICAR=1 CONTROLE_BACKFILL=1 …                               # controle: sem o guard `email IS NULL`, a 2ª aplicação apaga o do hub
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
DB=hub_homolog_db
MIG="$RAIZ/infra/hub/migrations/0096_email_motorista_no_hub.sql"
ANTES="$RAIZ/infra/hub/testes/sql/0096-email-hub.test.sql"
DEPOIS="$RAIZ/infra/hub/testes/sql/0096-depois.test.sql"

migration() {
  if [ "${CONTROLE_PRECEDENCIA:-}" = 1 ]; then
    # Tira a proteção: o enriquecimento passa a sobrescrever o e-mail do hub.
    sed "s|    IF OLD.email_origem = 'hub' AND NEW.email_origem IS DISTINCT FROM 'hub' THEN|    IF false THEN|" "$MIG"
  elif [ "${CONTROLE_BACKFILL:-}" = 1 ]; then
    # Tira o guard do backfill E o gatilho. Só com as DUAS camadas fora o
    # e-mail do hub morre — o que prova que a proteção é redundante de
    # propósito: o gatilho sozinho já segura o backfill sem guard.
    sed -e 's| WHERE cm.id = e.motorista_id AND cm.email IS NULL;| WHERE cm.id = e.motorista_id;|' \
        -e "s|    IF OLD.email_origem = 'hub' AND NEW.email_origem IS DISTINCT FROM 'hub' THEN|    IF false THEN|" "$MIG"
  else
    cat "$MIG"
  fi
}

montar() {
  echo 'BEGIN;'
  cat "$ANTES"
  migration
  if [ "${REAPLICAR:-}" = 1 ]; then
    # O cenário que o guard existe para proteger: alguém edita no hub DEPOIS da
    # primeira aplicação, e a migration roda de novo.
    cat "$RAIZ/infra/hub/testes/sql/0096-reaplicar.test.sql"
    migration
    cat "$RAIZ/infra/hub/testes/sql/0096-reaplicar-depois.test.sql"
  else
    cat "$DEPOIS"
  fi
  echo 'ROLLBACK;'
}

montar \
  | docker exec -i "$DB" sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>&1 \
  | grep -E 'NOTICE|WARNING|ERROR|FALHOU' | sed 's/^psql:[^ ]* //'

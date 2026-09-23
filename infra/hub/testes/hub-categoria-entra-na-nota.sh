#!/usr/bin/env bash
# Driver do teste da 0090 (F3 — "entra na nota") contra o hub-homolog.
#
# Roda tudo numa transação que termina em ROLLBACK: não deixa nada no banco.
# A ordem importa — o retrato de ANTES tem de ser tirado com as funções
# antigas, senão a comparação que prova "nada muda essa semana" vira
# tautologia.
#
#   infra/hub/testes/hub-categoria-entra-na-nota.sh              # normal
#   SEM_MIGRATION=1 infra/hub/testes/hub-categoria-entra-na-nota.sh   # controle: sem a coluna, o teste tem de quebrar
#   CONTROLE_TOTAL=1 infra/hub/testes/hub-categoria-entra-na-nota.sh  # controle: se o `total` passar a ser só a nota, o teste tem de pegar
#   CONTROLE_JANELA=1 infra/hub/testes/hub-categoria-entra-na-nota.sh # controle: se o extrato mudar com categorias_nota NULA, a comparação antes/depois tem de pegar
#   ROLLBACK=1 infra/hub/testes/hub-categoria-entra-na-nota.sh        # aplica a migration, reverte e confere que os números voltaram
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
DB=hub_homolog_db
MIG="$RAIZ/infra/hub/migrations/0090_categoria_entra_na_nota.sql"
ANTES="$RAIZ/infra/hub/testes/sql/0090-antes.sql"
TESTE="$RAIZ/infra/hub/testes/sql/0090-categoria-entra-na-nota.test.sql"
VOLTA="$RAIZ/infra/hub/testes/sql/0090-rollback.sql"
VOLTA_TESTE="$RAIZ/infra/hub/testes/sql/0090-rollback.test.sql"

migration() {
  if [ "${CONTROLE_TOTAL:-}" = 1 ]; then
    # Estraga de propósito o que o operador proibiu mudar: o `total` do
    # extrato passa a contar só o que entra na nota.
    sed 's|COALESCE((SELECT sum(total)::numeric(12,2) FROM por_dia), 0::numeric(12,2)),|COALESCE((SELECT sum(valor)::numeric(12,2) FROM por_categoria WHERE na_nota IS NOT FALSE), 0::numeric(12,2)),|' "$MIG"
  elif [ "${CONTROLE_JANELA:-}" = 1 ]; then
    # Estraga o extrato JÁ no estado em que a migration deixa produção
    # (categorias_nota nula): prova que a comparação antes/depois do bloco 1
    # não passa por passar — ela realmente mede.
    sed "s|COALESCE(v_config.categorias_extrato, ARRAY\[\]::text\[\])|ARRAY['Corridas concluidas']|" "$MIG"
  else
    cat "$MIG"
  fi
}

{
  echo 'BEGIN;'
  cat "$ANTES"
  [ "${SEM_MIGRATION:-}" = 1 ] || migration
  if [ "${ROLLBACK:-}" = 1 ]; then
    cat "$VOLTA" "$VOLTA_TESTE"
  else
    cat "$TESTE"
  fi
  echo 'ROLLBACK;'
} | docker exec -i "$DB" sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>&1 \
  | grep -E 'NOTICE|WARNING|ERROR|FALHOU' | sed 's/^psql:[^ ]* //'

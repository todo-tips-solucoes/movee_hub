#!/usr/bin/env bash
# =============================================================================
# hub-repasse-saldo-minimo.sh — driver SQL-only (SEM docker build, SEM subir
# ambiente novo) para as migrations 0097 (papel financeiro_aprovador) e 0098
# (repasse saldo mínimo carregado), contra hub_homolog_db. Tudo dentro de
# transações que terminam em ROLLBACK — NUNCA persiste nada no ambiente vivo.
# Mesmo molde de infra/hub/testes/hub-apuracao-divisao-nota.sh (usado para a
# 0092). tasks.md 2.3.4, 3.2.3, 3.7.1-3.7.4, 3.8.1, 3.8.4.
#
# hub-homolog hoje está em 0091 — este driver aplica 0092..0097/0098 DENTRO
# da transação (nunca no schema real do container).
#
# Modos (mutuamente exclusivos, via env var):
#   (nenhuma)                 aplica 0092..0098 + 0098-antes.sql +
#                              0098-saldo-minimo.test.sql (9 casos + F3.15)
#   CONTROLE=sem-saldo-cte     negativo 3.7.1 — deve FALHAR a ASSERT do caso 2
#                              ("item deveria existir mesmo sem atividade")
#   CONTROLE=sem-soma-saldo    negativo 3.7.2 — deve FALHAR ainda mais cedo
#                              que a ASSERT dos casos 1/3/7: o INSERT do
#                              fechamento de W1 já viola o CHECK constraint
#                              apuracaorepasseitem_saldo_conserva (3.1.2) —
#                              defesa em profundidade pegando antes da app
#   CONTROLE=sem-ordem         negativo 3.7.3 — deve FALHAR a ASSERT do caso 6
#                              (fechar semana anterior não recusa mais)
#   ROLLBACK_0097_CASO1=1      aplica 0092..0097, roda 0097-rollback.sql +
#                              BLOCO 1 do teste (2.3.4 caso 1 — sem vínculo,
#                              rollback aplica)
#   ROLLBACK_0097_CASO2=1      aplica 0092..0097, cria vínculo ativo (BLOCO 2),
#                              roda 0097-rollback.sql — esta passada DEVE
#                              terminar com erro do psql (ERRCODE 42501)
#   ROLLBACK_0098_CASO1=1      aplica 0092..0098, roda 0098-rollback.sql +
#                              BLOCO 1 do teste (3.2.3 caso 1 — sem saldo
#                              pendente, rollback aplica)
#   ROLLBACK_0098_CASO2=1      aplica 0092..0098, fecha semana com motorista
#                              retido (BLOCO 2), roda 0098-rollback.sql —
#                              esta passada DEVE terminar com erro do psql
#                              (ERRCODE 42501)
#
# Uso: infra/hub/testes/hub-repasse-saldo-minimo.sh
# =============================================================================
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
DB=hub_homolog_db
MIGDIR="$RAIZ/infra/hub/migrations"
SQLDIR="$RAIZ/infra/hub/testes/sql"

mig_ate() { for n in "$@"; do cat "$(ls "$MIGDIR/${n}"_*.sql)"; echo; done; }

mig_0098() {
  local f; f="$(ls "$MIGDIR"/0098_*.sql)"
  case "${CONTROLE:-}" in
    sem-saldo-cte)
      # 3.7.1 (Decision 10): remove a inclusão de quem só tem saldo anterior
      # (sem outra atividade na semana) do CTE `linhas` — 0098:252.
      awk '
        /p\.entregador_id IS NOT NULL$/ {
          print "          AND (c.entregador_id IS NOT NULL OR d.entregador_id IS NOT NULL OR p.entregador_id IS NOT NULL)"
          skip=1; next
        }
        skip && /OR COALESCE\(sa\.valor_transportado, 0\) > 0\)/ { skip=0; next }
        skip { next }
        { print }
      ' "$f"
      ;;
    sem-soma-saldo)
      # 3.7.2 (Decision 8): não soma saldo_anterior no cálculo de
      # valor_pago/valor_transportado — só dentro de hub_adiantamento_repasse_fechar.
      awk '
        /CREATE OR REPLACE FUNCTION hub_adiantamento_repasse_fechar/ { infn=1 }
        infn && /^DROP FUNCTION IF EXISTS hub_adiantamento_repasse\(date/ { infn=0 }
        infn { gsub(/\(c\.remanescente \+ c\.saldo_anterior\)/, "c.remanescente") }
        { print }
      ' "$f"
      ;;
    sem-ordem)
      # 3.7.3 (Decision 9): remove a guarda de ordem estrita — 0098:146-148.
      awk '
        /IF v_ultimo_periodo IS NOT NULL/ { skip=1; next }
        skip && /END IF;/ { skip=0; next }
        skip { next }
        { print }
      ' "$f"
      ;;
    "") cat "$f" ;;
    *) echo "CONTROLE desconhecido: ${CONTROLE:-}" >&2; exit 2 ;;
  esac
}

run_psql() {
  docker exec -i "$DB" sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

echo "=== modo: CONTROLE=${CONTROLE:-<nenhum>} ROLLBACK_0097_CASO1=${ROLLBACK_0097_CASO1:-0} ROLLBACK_0097_CASO2=${ROLLBACK_0097_CASO2:-0} ROLLBACK_0098_CASO1=${ROLLBACK_0098_CASO1:-0} ROLLBACK_0098_CASO2=${ROLLBACK_0098_CASO2:-0} ==="

if [ "${ROLLBACK_0097_CASO1:-0}" = 1 ] || [ "${ROLLBACK_0097_CASO2:-0}" = 1 ]; then
  {
    echo 'BEGIN;'
    mig_ate 0092 0093 0094 0095 0096 0097
    if [ "${ROLLBACK_0097_CASO2:-0}" = 1 ]; then
      sed -n '35,58p' "$SQLDIR/0097-rollback.test.sql"   # BLOCO 2: fixture com vínculo ativo
    fi
    cat "$SQLDIR/0097-rollback.sql"
    if [ "${ROLLBACK_0097_CASO1:-0}" = 1 ]; then
      sed -n '1,20p;21,33p' "$SQLDIR/0097-rollback.test.sql"   # BLOCO 1: pós-rollback
    fi
    echo 'ROLLBACK;'
  } | run_psql 2>&1 | grep -E 'NOTICE|WARNING|ERROR|FALHOU|ERRO|ASSERT' | sed 's/^psql:[^ ]* //'
  exit $?
fi

if [ "${ROLLBACK_0098_CASO1:-0}" = 1 ] || [ "${ROLLBACK_0098_CASO2:-0}" = 1 ]; then
  {
    echo 'BEGIN;'
    mig_ate 0092 0093 0094 0095 0096 0097
    mig_0098
    if [ "${ROLLBACK_0098_CASO2:-0}" = 1 ]; then
      sed -n '42,98p' "$SQLDIR/0098-rollback.test.sql"   # BLOCO 2: fixture com saldo pendente
    fi
    cat "$SQLDIR/0098-rollback.sql"
    if [ "${ROLLBACK_0098_CASO1:-0}" = 1 ]; then
      sed -n '1,40p' "$SQLDIR/0098-rollback.test.sql"   # BLOCO 1: pós-rollback
    fi
    echo 'ROLLBACK;'
  } | run_psql 2>&1 | grep -E 'NOTICE|WARNING|ERROR|FALHOU|ERRO|ASSERT' | sed 's/^psql:[^ ]* //'
  exit $?
fi

# modo normal / CONTROLE=... : 0092..0097 (vigente) + 0098-antes (função
# 0092, PRÉ-0098) + 0098 (ou variante controlada) + 0098-saldo-minimo.test.sql
SAIDA=$(
  {
    echo 'BEGIN;'
    mig_ate 0092 0093 0094 0095 0096 0097
    cat "$SQLDIR/0098-antes.sql"
    mig_0098
    cat "$SQLDIR/0098-saldo-minimo.test.sql"
    echo 'ROLLBACK;'
  } | run_psql 2>&1
)
RC=$?
echo "$SAIDA" | grep -E 'NOTICE|WARNING|ERROR|FALHOU|ERRO|ASSERT' | sed 's/^psql:[^ ]* //'

# F3.11 (tasks.md 3.8.3): a linha JSON emitida pelo SQL acima (RPC congelado
# real, dado de motorista retido) é alimentada em serializarCsvRemanescente
# DE VERDADE (lib/adiantamento-remanescente.js, nunca mockada) — confere que
# o CSV real sai com "A pagar"=0.00 (formatarCentavos usa ponto, não vírgula
# — conferido contra tests/hub-adiantamentos-rotas-unit.test.js) e "Passou
# para a próxima semana" coerente com o valor_transportado congelado.
JSON_LINE=$(echo "$SAIDA" | grep -o 'CSV_ROW_JSON: .*' | sed 's/^CSV_ROW_JSON: //' | tail -1)
if [ -n "$JSON_LINE" ]; then
  NODE_OUT=$(cd "$RAIZ/app_homologacao/backend" && node -e '
    const row = JSON.parse(process.argv[1]);
    const { serializarCsvRemanescente, paraCentavos, formatarCentavos } = require("./lib/adiantamento-remanescente");
    if (row.retido !== true) throw new Error("F3.11: linha escolhida nao esta retido=true, veio " + row.retido);
    const csv = serializarCsvRemanescente([{
      idExterno: row.entregador_id, nome: row.nome, creditos: row.creditos,
      adiantamentos: row.adiantamentos, debitos: row.debitos, remanescente: row.remanescente,
      saldoAnterior: row.saldo_anterior, aPagar: row.valor_pago, transportado: row.valor_transportado,
    }]);
    const linha = csv.split("\r\n")[1];
    const campos = linha.split(",");
    if (campos[7] !== "0.00") throw new Error("F3.11: A pagar deveria ser 0.00, veio " + campos[7]);
    const transportadoEsperado = formatarCentavos(paraCentavos(row.valor_transportado));
    if (campos[8] !== transportadoEsperado) throw new Error("F3.11: transportado deveria ser " + transportadoEsperado + ", veio " + campos[8]);
    if (paraCentavos(row.valor_transportado) <= 0) throw new Error("F3.11: transportado deveria ser > 0 para o retido, veio " + row.valor_transportado);
    console.log("NOTICE:  ok  F3.11: CSV real (RPC congelado + serializarCsvRemanescente) -- A pagar=0.00 transportado=" + transportadoEsperado + " -- linha: " + linha);
  ' "$JSON_LINE" 2>&1)
  NODE_RC=$?
  echo "$NODE_OUT"
  [ "$NODE_RC" -ne 0 ] && RC=1
else
  echo "NOTICE:  FALHOU F3.11: CSV_ROW_JSON nao encontrado na saida do psql"
  RC=1
fi
exit $RC

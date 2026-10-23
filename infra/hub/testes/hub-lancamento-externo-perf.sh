#!/usr/bin/env bash
# =============================================================================
# hub-lancamento-externo-perf.sh — feature lancamento-externo, tasks 4.5.1-4.5.4 (SC-009 / dec-040).
# Stack EFEMERO (hub-test-*). Semeia 229.467 linhas (223 entregadores x 1.029 dias) DENTRO de
# BEGIN..ROLLBACK (nada sobra), mede o EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) da CTE nova e das
# tres fontes, e REPROVA se ocorrer qualquer regressao do criterio:
#   (1) Seq Scan em "LancamentoExterno"
#   (2) Index Cond de idx_lancamentoexterno_empresa_data_entregador sem igualdade (id_empresa) E faixa (data_pagamento)
#   (3) mais de 2x a baseline: CTE isolada > 3,208 ms / 94 buffers; tres fontes > 4,188 ms / 116 buffers
#
# Controle negativo: PERF_NEG=noindex  -> DROP INDEX (dentro da transacao; o ROLLBACK o devolve).
# Uso: infra/hub/testes/hub-lancamento-externo-perf.sh      (PERF_NEG=noindex para o controle)
# =============================================================================
set -euo pipefail
HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
PROJECT="hub-test-$(date +%s)-$$"
TMP="$(mktemp -d)"
. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }
dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
trap 'dc down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou"; exit 1; }
dc up -d --wait db
psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/m.log" 2>&1 || { echo "FAIL: migrate"; tail -20 "$TMP/m.log"; exit 1; }

ANTES="$(psql_t -tAc 'SELECT count(*) FROM "LancamentoExterno"')"
NEG_SQL=""; [ "${PERF_NEG:-}" = "noindex" ] && NEG_SQL='DROP INDEX idx_lancamentoexterno_empresa_data_entregador;'

psql_t -tA >"$TMP/out.txt" 2>"$TMP/err.txt" <<SQL || { echo "FAIL: script SQL"; cat "$TMP/err.txt"; exit 1; }
BEGIN;
INSERT INTO "Usuario" (email, senha_hash, nome) VALUES ('perf@example.com','x','Perf');
INSERT INTO "Entregador" (id_empresa, id_externo, nome)
  SELECT 6, gen_random_uuid(), 'Perf '||n FROM generate_series(1,223) n;
INSERT INTO "LancamentoExterno" (id_empresa, entregador_id, cnpj_prestador, data_pagamento, tipo, valor, criado_por)
  SELECT 6, e.id, '900000000'||lpad(e.rn::text,5,'0'), d::date, 'ADIANTAMENTO', 10.00, (SELECT id FROM "Usuario" WHERE email='perf@example.com')
  FROM (SELECT id, row_number() OVER (ORDER BY id) rn FROM "Entregador" WHERE nome LIKE 'Perf %') e
  CROSS JOIN generate_series('2024-01-01'::date, '2026-10-25'::date, '1 day') d;
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES (6,'faturamento',repeat('9',64),'completed');
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
  SELECT 6, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('9',64)), e.id, d::date, d::date,
         CASE WHEN extract(day from d)::int % 2 = 0 THEN 'Credito' ELSE 'Debito' END, 5.00, 'Corrida', md5(e.id::text||d::text)||md5(d::text||e.id::text)
  FROM "Entregador" e CROSS JOIN generate_series('2026-10-19'::date,'2026-10-25'::date,'1 day') d WHERE e.nome LIKE 'Perf %';
$NEG_SQL
ANALYZE "LancamentoExterno"; ANALYZE "FaturamentoLancamento"; ANALYZE "Entregador";
SELECT 'SEED:'||count(*) FROM "LancamentoExterno";
CREATE FUNCTION pg_temp.ex(q text) RETURNS jsonb LANGUAGE plpgsql AS \$f\$
DECLARE j json; BEGIN EXECUTE 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '||q INTO j; RETURN j::jsonb; END \$f\$;
SELECT 'ISO:'||pg_temp.ex(\$q\$
  SELECT l.entregador_id, sum(l.valor) FILTER (WHERE t.sinal < 0) AS deducoes, sum(l.valor) FILTER (WHERE t.sinal > 0) AS creditos
  FROM "LancamentoExterno" l JOIN "LancamentoExternoTipo" t ON t.codigo = l.tipo
  WHERE l.id_empresa = ANY ('{6}'::int[]) AND l.data_pagamento BETWEEN '2026-10-19' AND '2026-10-25' GROUP BY l.entregador_id \$q\$)::text
  FROM generate_series(1,5);
SELECT 'TRES:'||pg_temp.ex(\$q\$
  WITH cr AS (SELECT entregador_id, sum(valor) t FROM "FaturamentoLancamento" WHERE id_empresa = ANY ('{6}'::int[]) AND tipo='Credito' AND data_lancamento BETWEEN '2026-10-19' AND '2026-10-25' GROUP BY 1),
       de AS (SELECT entregador_id, sum(abs(valor)) t FROM "FaturamentoLancamento" WHERE id_empresa = ANY ('{6}'::int[]) AND tipo='Debito' AND data_lancamento BETWEEN '2026-10-19' AND '2026-10-25' GROUP BY 1),
       ex AS (SELECT l.entregador_id, sum(l.valor) FILTER (WHERE t.sinal < 0) AS d, sum(l.valor) FILTER (WHERE t.sinal > 0) AS c
              FROM "LancamentoExterno" l JOIN "LancamentoExternoTipo" t ON t.codigo = l.tipo
              WHERE l.id_empresa = ANY ('{6}'::int[]) AND l.data_pagamento BETWEEN '2026-10-19' AND '2026-10-25' GROUP BY l.entregador_id)
  SELECT e.id, COALESCE(cr.t,0) - COALESCE(de.t,0) - COALESCE(ex.d,0) + COALESCE(ex.c,0) AS rem
  FROM "Entregador" e LEFT JOIN cr ON cr.entregador_id=e.id LEFT JOIN de ON de.entregador_id=e.id LEFT JOIN ex ON ex.entregador_id=e.id
  WHERE e.id_empresa = ANY ('{6}'::int[]) \$q\$)::text
  FROM generate_series(1,5);
SELECT 'LIQ:'||pg_temp.ex(\$q\$
  SELECT hub_lancamento_externo_liquido(e.id, '2026-10-19'::date, (SELECT c FROM hub_adiantamento_config_vigente(6) c))
  FROM "Entregador" e WHERE e.id_empresa = 6 AND e.nome LIKE 'Perf %' \$q\$)::text
  FROM generate_series(1,5);
ROLLBACK;
SQL

fails=0
ck() { if [ "$2" = "ok" ]; then echo "PASS: $1"; else echo "FAIL: $1 ($2)"; fails=$((fails+1)); fi; }
SEED="$(grep '^SEED:' "$TMP/out.txt" | cut -d: -f2)"
ck "seed efetivo = 229.467 linhas (sem isto a medicao e oca)" "$([ "$SEED" = "229467" ] && echo ok || echo "SEED=$SEED")"

analisa() { # analisa <ISO|TRES> <max_ms> <max_buffers>
  grep "^$1:" "$TMP/out.txt" | cut -d: -f2- > "$TMP/$1.jsonl"
  local ms buf seq idx
  ms=$(jq -r '.[0]["Execution Time"]' "$TMP/$1.jsonl" | sort -n | sed -n 1p)            # melhor de 5 (ruido de relogio)
  buf=$(jq -r '.[0].Plan | ((."Shared Hit Blocks" // 0) + (."Shared Read Blocks" // 0))' "$TMP/$1.jsonl" | sort -n | sed -n 1p)
  seq=$(jq -s '[.[] | .. | objects | select(."Node Type"=="Seq Scan" and ."Relation Name"=="LancamentoExterno")] | length' "$TMP/$1.jsonl" | sed -n 1p)
  idx=$(jq -r 'first(.. | objects | select(."Index Name"=="idx_lancamentoexterno_empresa_data_entregador") | ."Index Cond") // ""' "$TMP/$1.jsonl" | sed -n 1p)
  echo "  [$1] melhor tempo=${ms} ms | buffers=${buf} | Seq Scan em LancamentoExterno (nos)=${seq} | Index Cond=${idx}"
  ck "$1 criterio 1: zero Seq Scan em LancamentoExterno" "$([ "$seq" = "0" ] && echo ok || echo "$seq Seq Scan")"
  ck "$1 criterio 2: Index Cond cobre igualdade (id_empresa) E faixa (data_pagamento >= e <=)" \
     "$(printf '%s' "$idx" | grep -q 'id_empresa' && printf '%s' "$idx" | grep -q 'data_pagamento >=' && printf '%s' "$idx" | grep -q 'data_pagamento <=' && echo ok || echo "Index Cond='$idx'")"
  ck "$1 criterio 3a: tempo <= $2 ms (2x baseline)" "$(awk -v a="$ms" -v b="$2" 'BEGIN{print (a<=b)?"ok":"tempo="a" ms"}')"
  ck "$1 criterio 3b: buffers <= $3 (2x baseline)" "$(awk -v a="$buf" -v b="$3" 'BEGIN{print (a<=b)?"ok":"buffers="a}')"
}
analisa ISO 3.208 94
analisa TRES 4.188 116

# ALTO 2 (rodada 3): a recusa por liquido chama `hub_lancamento_externo_liquido` UMA vez por linha de DEDUCAO do arquivo (ate 10.000). O custo
# por chamada e o que escala. Mede 223 chamadas numa instrucao (melhor de 5) sobre 229.467 lancamentos + 1 semana de faturamento.
grep "^LIQ:" "$TMP/out.txt" | cut -d: -f2- > "$TMP/LIQ.jsonl"
LIQ_MS=$(jq -r '.[0]["Execution Time"]' "$TMP/LIQ.jsonl" | sort -n | sed -n 1p)
LIQ_POR_CHAMADA=$(awk -v a="$LIQ_MS" 'BEGIN{printf "%.3f", a/223}')
echo "  [LIQ] 223 chamadas = ${LIQ_MS} ms -> ${LIQ_POR_CHAMADA} ms/chamada -> projecao 10.000 linhas = $(awk -v a="$LIQ_POR_CHAMADA" 'BEGIN{printf "%.1f", a*10}') s"
ck "LIQ criterio 4: custo por chamada do liquido <= ${LIQ_MAX_MS:-1} ms (10.000 linhas de deducao no pior caso <= $(awk -v a="${LIQ_MAX_MS:-1}" 'BEGIN{printf "%d", a*10}') s)" "$(awk -v a="$LIQ_POR_CHAMADA" -v b="${LIQ_MAX_MS:-1}" 'BEGIN{print (a<=b)?"ok":"ms/chamada="a}')"

DEPOIS="$(psql_t -tAc 'SELECT count(*) FROM "LancamentoExterno"')"
ck "4.5.4: sem residuo — count antes ($ANTES) = depois ($DEPOIS)" "$([ "$ANTES" = "$DEPOIS" ] && echo ok || echo "antes=$ANTES depois=$DEPOIS")"
echo "===================================================================="
echo "PERF${PERF_NEG:+ (controle negativo: $PERF_NEG)}: $([ $fails -eq 0 ] && echo APROVADO || echo "REPROVADO ($fails criterio(s))")"
echo "===================================================================="
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)

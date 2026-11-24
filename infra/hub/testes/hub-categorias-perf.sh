#!/usr/bin/env bash
# =============================================================================
# hub-categorias-perf.sh — 0131: orcamento de desempenho ANTES (so ate a 0130) x DEPOIS (com a 0131), no MESMO stack
# e com os MESMOS dados. Stack EFEMERO (hub-test-*). Semeia ~300 mil linhas de FaturamentoLancamento da empresa 6
# (1.000 entregadores x 150 dias x 2 linhas: 'Corridas concluidas' + (Promocao - Wn | Percentual atingido | Gorjeta))
# e mede (mediana de 15 (2 rodadas ANTES/DEPOIS alternadas); mediana tambem):
#   hub_adiantamento_producao   — 300 entregadores/dia num loop (valor por chamada = total/300)
#   hub_adiantamento_repasse    — previa de 1 semana (empresa inteira)
#   hub_adiantamento_categorias — seletor (janela de 90 dias)             <= 500 ms
# Orcamento: regressao <= 10% (config so com nomes+familia, a de hoje). Mede tambem a config em modo:todas (informativo).
# O db do hub-test tem 0,5 CPU: pior que producao. Uso: infra/hub/testes/hub-categorias-perf.sh
# =============================================================================
set -uo pipefail
HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
PROJECT="hub-test-catperf-$(date +%s)-$$"
TMP="$(mktemp -d)"
. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
cat > "$TMP/override.yml" <<'YML'
services:
  db:
    mem_limit: 3g
YML
dc() { docker compose -f "$COMPOSE" -f "$TMP/override.yml" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
trap 'dc down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
df -h / | awk 'NR==2{print "disco livre: "$4}'
"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >/dev/null || { echo "preflight abortou"; exit 1; }
dc up -d --wait db >/dev/null
psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" -t 0130 >"$TMP/m.log" 2>&1 || { echo "FAIL: migrate ate 0130"; tail -20 "$TMP/m.log"; exit 1; }
[ "$(psql_t -tAc "SELECT count(*) FROM \"SchemaMigration\" WHERE nome LIKE '0131%'")" = 0 ] || { echo "FAIL: 0131 ja aplicada antes da medida"; exit 1; }

ENT=1000; DIAS=150
echo "semeando $((ENT * DIAS * 2)) linhas..."
psql_t -q >"$TMP/seed.log" 2>&1 <<SQL || { echo "FAIL: seed"; tail "$TMP/seed.log"; exit 1; }
INSERT INTO "Usuario" (email, senha_hash, nome) VALUES ('perf@example.com','x','Perf');
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo)
  SELECT (SELECT id FROM "Usuario" WHERE email='perf@example.com'), 6, (SELECT id FROM "Papel" WHERE nome='financeiro_aprovador'), true;
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) SELECT lpad((91000000000000 + n)::text, 14, '0'), 'PerfC '||n FROM generate_series(1,$ENT) n;
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
  SELECT 6, gen_random_uuid(), 'PerfC Nome '||n, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador = lpad((91000000000000 + n)::text, 14, '0')) FROM generate_series(1,$ENT) n;
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES (6,'faturamento',repeat('q',64),'completed');
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, periodo, tipo, valor, descricao, hash_linha)
SELECT 6, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('q',64)), e.id, (CURRENT_DATE - d), (CURRENT_DATE - d), 'JANTAR 18H-22H', 'Credito',
       v.valor + (e.id + d) % 50, v.descr, md5(e.id::text||'/'||d||'/'||v.i)||md5(v.i||'/'||d||'/'||e.id)
FROM "Entregador" e CROSS JOIN generate_series(0, $DIAS - 1) d
CROSS JOIN LATERAL (VALUES (1, 'Corridas concluidas', 40),
   (2, CASE (e.id + d) % 3 WHEN 0 THEN 'Promocao - W' || (d / 7) WHEN 1 THEN 'Percentual atingido de rotas' ELSE 'Gorjeta' END, 10)) v(i, descr, valor)
WHERE e.id_empresa = 6;
ANALYZE "FaturamentoLancamento"; ANALYZE "Entregador";
SQL
echo "linhas: $(psql_t -tAc 'SELECT count(*) FROM "FaturamentoLancamento"')"

CLAIM="SELECT set_config('request.jwt.claims', jsonb_build_object('sub',(SELECT id FROM \"Usuario\" WHERE email='perf@example.com'),'empresa_ativa','6','escopo','[6]'::jsonb)::text, true);"
cfg() { # cfg <producao-array> <extrato-array> <nota-array> <n>  (vigente_desde crescente em microssegundos)
  psql_t -q >/dev/null <<SQL
BEGIN; $CLAIM
SELECT hub_adiantamento_configuracao_salvar((SELECT max(versao) FROM "AdiantamentoConfiguracao" WHERE id_empresa=6),
  jsonb_build_object('vigenteDesde', (clock_timestamp() - interval '1 second'), 'fonteProducao','financeiro_lancamento','apuracaoDataBase','data_lancamento',
    'apuracaoDiaInicio',1,'apuracaoDiasAteRepasse',3,'percentual',50,
    'categoriasProducao', to_jsonb($1::text[]), 'categoriasExtrato', to_jsonb($2::text[]), 'categoriasNota', to_jsonb($3::text[])));
COMMIT;
SQL
}
mede() { # mede <rotulo> <sql-de-uma-chamada>  -> imprime "rotulo|melhor|mediana" e guarda em $TMP/res
  local rot="$1" call="$2"
  psql_t -tA 2>"$TMP/mede.err" >/dev/null <<SQL || { echo "FAIL: mede $rot"; cat "$TMP/mede.err"; return; }
BEGIN;
$CLAIM
DO \$do\$
DECLARE t0 timestamptz; v numeric[] := '{}'; i int;
BEGIN
  FOR i IN 1..15 LOOP
    t0 := clock_timestamp(); PERFORM $call; v := v || (extract(epoch FROM clock_timestamp() - t0) * 1000)::numeric;
  END LOOP;
  RAISE NOTICE 'MEDIDAS %', (SELECT string_agg(round(x,1)::text, ' ' ORDER BY x) FROM unnest(v) x);
END \$do\$;
ROLLBACK;
SQL
  local linha melhor med
  linha="$(grep -h MEDIDAS "$TMP/mede.err" | sed 's/.*MEDIDAS //')"
  melhor="$(printf '%s\n' $linha | sort -n | head -1)"; med="$(printf '%s\n' $linha | sort -n | sed -n 8p)"
  echo "  [$rot] 15 medidas ordenadas (ms): $linha | melhor=$melhor mediana=$med"
  echo "$rot|$melhor|$med" >> "$TMP/res"
}

DIA="(CURRENT_DATE - 20)"
PRODUCAO="(SELECT sum(r.valor) FROM \"Entregador\" e, LATERAL hub_adiantamento_producao(e.id, $DIA, (SELECT c FROM \"AdiantamentoConfiguracao\" c WHERE id_empresa=6 ORDER BY versao DESC LIMIT 1)) r WHERE e.id_empresa=6 AND e.id <= (SELECT min(id)+299 FROM \"Entregador\" WHERE id_empresa=6))"
REPASSE="(SELECT count(*) FROM hub_adiantamento_repasse($DIA - 3, NULL, false, 0, 2000))"
SELETOR="(SELECT count(*) FROM hub_adiantamento_categorias())"

fase() { # fase <rotulo-config> ; mede as 3 operacoes
  echo "--- $1 ---"
  mede "$1 | producao x300 entregadores" "$PRODUCAO"
  mede "$1 | repasse previa (1 semana)" "$REPASSE"
  mede "$1 | seletor categorias" "$SELETOR"
}
cfg "ARRAY['Corridas concluidas','Gorjeta','familia:promocao','familia:missoes']" "ARRAY['Corridas concluidas','Gorjeta','familia:promocao']" "ARRAY['Corridas concluidas','familia:promocao']" 1
aplica() { "$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/m2.log" 2>&1 || { echo "FAIL: migrate 0131"; tail -20 "$TMP/m2.log"; exit 1; }; grep -q "aplicando: 0131" "$TMP/m2.log" || { echo "FAIL: 0131 nao aplicada"; exit 1; } }
desfaz() { psql_t -q < "$HUB_DIR/testes/sql/0131-rollback.sql" >/dev/null 2>"$TMP/rb.err" || { echo "FAIL: rollback"; cat "$TMP/rb.err"; exit 1; }; psql_t -q -c "DELETE FROM \"SchemaMigration\" WHERE nome LIKE '0131%'" >/dev/null; }
# rodadas alternadas (o relogio de um db de 0,5 CPU oscila): ANTES1, DEPOIS1, ANTES2, DEPOIS2
echo "=== ANTES #1 (migrations ate 0130) ==="; fase "ANTES1"
aplica; echo "=== DEPOIS #1 (com a 0131, MESMA config so de nomes+familia) ==="; fase "DEPOIS1"
desfaz; echo "=== ANTES #2 (0131 desfeita pelo rollback) ==="; fase "ANTES2"
psql_t -tAc "SELECT hub_adiantamento_categoria_casa('x', ARRAY['modo:todas'])" | grep -q f || { echo "ABORTA: rollback nao restaurou a casa() antiga"; exit 1; }
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/m3.log" 2>&1; grep -q "aplicando: 0131" "$TMP/m3.log" || { echo "FAIL: 0131 nao reaplicada"; exit 1; }
echo "=== DEPOIS #2 ==="; fase "DEPOIS2"
echo "=== DEPOIS, config em modo:todas (informativo) ==="
cfg "ARRAY['modo:todas','familia:indicador','Gorjeta']" "ARRAY['modo:todas','familia:indicador']" "ARRAY['Corridas concluidas']" 2
fase "DEPOIS-todas"

echo "--- veredito (regressao <= 10% sobre a mediana media das 2 rodadas; folga de 2 ms) ---"
fails=0
med() { grep "^$1 | $2|" "$TMP/res" | cut -d'|' -f4; }
for op in "producao x300 entregadores" "repasse previa (1 semana)" "seletor categorias"; do
  a1="$(med ANTES1 "$op")"; a2="$(med ANTES2 "$op")"; d1="$(med DEPOIS1 "$op")"; d2="$(med DEPOIS2 "$op")"
  r="$(awk -v a1="$a1" -v a2="$a2" -v d1="$d1" -v d2="$d2" 'BEGIN{ a=(a1+a2)/2; d=(d1+d2)/2; printf "antes=%.1f depois=%.1f (%+.1f%%) ", a, d, (d-a)*100/a; if (d <= a*1.10+2) print "ok"; else print "REGRESSAO" }')"
  echo "  $op: ANTES ${a1}/${a2} ms | DEPOIS ${d1}/${d2} ms | $r"
  case "$r" in *REGRESSAO) fails=$((fails+1));; esac
done
sel="$(med DEPOIS2 "seletor categorias")"
awk -v s="$sel" 'BEGIN{ exit !(s <= 500) }' && echo "  seletor <= 500 ms: ok (${sel} ms)" || { echo "  seletor <= 500 ms: FALHOU (${sel} ms)"; fails=$((fails+1)); }
echo "CATEGORIAS-PERF: $([ $fails -eq 0 ] && echo APROVADO || echo "REPROVADO ($fails)")"
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)

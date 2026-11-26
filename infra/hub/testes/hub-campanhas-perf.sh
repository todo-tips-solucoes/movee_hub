#!/usr/bin/env bash
# =============================================================================
# hub-campanhas-perf.sh — campanhas-motorista W1: orcamento de desempenho da 0127 sob volume.
# Stack EFEMERO (hub-test-*). Semeia ~900 mil turnos em "PerformanceTurno" (2.000 entregadores x 150 dias
# x 3 turnos/dia), atualiza mv_performance_dia e mede, COM E SEM filtro de praca (campanha de 30 dias):
#   hub_campanha_recalcular        <= 2000 ms
#   hub_motorista_campanha         <=   50 ms   (como o motorista: claim motorista_cnpj, SET ROLE authenticated)
#   hub_campanha_ranking (pag. 50) <=  100 ms   (como o admin)
# 0129 (campanha tipo extrato, plano §7): alem dos ~900 mil turnos semeia ~300 mil linhas de FaturamentoLancamento e mede
#   recalculo extrato 30 dias (sem filtro e com praca+turno+modal)  <= 2000 ms
#   hub_motorista_campanha (extrato)                                <=   50 ms
#   hub_motorista_campanha_turnos (campanha de 91 dias)             <=   50 ms
#   hub_campanha_ranking (extrato, pag. 50)                         <=  100 ms
# 0133 (parametrizacao): subpraca efetiva (hub_subpraca_efetiva) no semi-join, descarte de turno curto zerado e nota com categorias:
#   o volume ganha ~2% de turnos curtos zerados (descarte), entregadores com subpraca VAZIA e origem preenchida, e mede
#   recalcular nota COM categorias (V3, 30 dias)                    <= 2000 ms  (usa hub_campanha_creditos_turno, a funcao do extrato)
#   hub_performance_totais / _turnos com p_subpraca (filtro efetivo) <=  500 ms
#   + EXPLAIN: o semi-join da campanha e as RPCs de performance usam os INDICES DE EXPRESSAO (idx_performance_empresa_subpraca_ef(u)_data)
# Cada medida = melhor de 5 (ruido de relogio, como hub-lancamento-externo-perf.sh); a mediana tambem e impressa.
# Imprime o EXPLAIN (ANALYZE) dos comandos internos via auto_explain aninhado.
# O db do hub-test tem 0,5 CPU: o orcamento e medido numa maquina PIOR que a de producao.
# O tmpfs do db conta na memoria do container (512 MB nao comporta 900k turnos): um override de compose
# SO deste driver sobe mem_limit para 3 GB (o compose.hub.test.yml nao e alterado).
#
# Controle negativo: PERF_NEG=semindice -> derruba os indices de PerformanceTurno que servem o semi-join de
# praca (idx_performanceturno_empresa_data; idx_performance_empresa_subpraca_data, 0051; e os de expressao da 0133)
# e o orcamento da campanha COM praca deve estourar. (Medido: o planner usa o 1o, nao o 2o, porque a comparacao
# e por upper(btrim(subpraca)).)
# Uso: infra/hub/testes/hub-campanhas-perf.sh   (PERF_FULL=0 para 1/10 do volume em depuracao)
# =============================================================================
set -uo pipefail
HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
PROJECT="hub-test-campperf-$(date +%s)-$$"
TMP="$(mktemp -d)"
. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }
cat > "$TMP/override.yml" <<'YML'
services:
  db:
    mem_limit: 3g
YML
dc() { docker compose -f "$COMPOSE" -f "$TMP/override.yml" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
# PERF_KEEP=1 mantem o stack no ar (so para depurar; remova com `docker compose -p <projeto> down -v`)
trap '[ -n "${PERF_KEEP:-}" ] && { echo "stack mantido: $PROJECT"; exit 0; }; dc down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
df -h / | awk 'NR==2{print "disco livre: "$4}'
"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >/dev/null || { echo "preflight abortou"; exit 1; }
dc up -d --wait db >/dev/null
psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/m.log" 2>&1 || { echo "FAIL: migrate"; tail -20 "$TMP/m.log"; exit 1; }
grep -q "0127_campanhas.sql" "$TMP/m.log" || { echo "FAIL: 0127 nao aplicada"; exit 1; }
grep -q "0129_campanhas_extrato.sql" "$TMP/m.log" || { echo "FAIL: 0129 nao aplicada"; exit 1; }
grep -q "0132_campanhas_visibilidade_app.sql" "$TMP/m.log" || { echo "FAIL: 0132 nao aplicada"; exit 1; }
grep -q "0133_campanhas_parametrizacao.sql" "$TMP/m.log" || { echo "FAIL: 0133 nao aplicada"; exit 1; }

DIAS=150; ENT=2000
[ "${PERF_FULL:-1}" = "0" ] && { DIAS=15; ENT=2000; }
echo "semeando $((ENT * DIAS * 3)) turnos..."
psql_t -q >"$TMP/seed.log" 2>&1 <<SQL || { echo "FAIL: seed"; tail "$TMP/seed.log"; exit 1; }
INSERT INTO "Usuario" (email, senha_hash, nome) VALUES ('perf@example.com','x','Perf');
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo)
  SELECT (SELECT id FROM "Usuario" WHERE email='perf@example.com'), 9001, (SELECT id FROM "Papel" WHERE nome='admin_entidade'), true;
INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo) SELECT id, 9001, true FROM "Modulo" WHERE codigo='campanhas';
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) SELECT lpad((90000000000000 + n)::text, 14, '0'), 'Perf '||n FROM generate_series(1,$ENT) n;
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id, dados_entrego_json)
  SELECT 9001, gen_random_uuid(), 'Perf Nome '||n, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador = lpad((90000000000000 + n)::text, 14, '0')),
         CASE WHEN n % 10 = 0 THEN NULL WHEN n % 10 < 8 THEN '{"informacoesEntrega":{"modal":"MOTO"}}'::jsonb ELSE '{"informacoesEntrega":{"modal":"CARRO"}}'::jsonb END
  FROM generate_series(1,$ENT) n;
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES (9001,'performance',repeat('p',64),'completed');
-- 3 turnos/dia/entregador; 10 subpracas (por entregador); datas 2026-06-30 para tras
INSERT INTO "PerformanceTurno" (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca, origem,
       corridas_ofertadas, corridas_aceitas, corridas_completadas, pedidos_concluidos, tempo_disponivel, hash_linha)
SELECT 9001, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('p',64)), e.id, ('2026-06-30'::date - d), t.p, interval '4 hours',
       CASE WHEN e.id % 20 = 0 THEN '' ELSE 'PRACA '||(e.id % 10) END,
       CASE WHEN e.id % 20 = 0 THEN 'PRACA 7' END,
       CASE WHEN t.i = 3 AND (e.id + d) % 50 = 0 THEN 0 ELSE 10 + (e.id + d) % 5 END,
       CASE WHEN t.i = 3 AND (e.id + d) % 50 = 0 THEN 0 ELSE 6 + (e.id * d) % 5 END,
       CASE WHEN t.i = 3 AND (e.id + d) % 50 = 0 THEN 0 ELSE 5 + (e.id + d) % 5 END,
       CASE WHEN t.i = 3 AND (e.id + d) % 50 = 0 THEN 0 ELSE 4 + (e.id + d + t.i) % 9 END,
       CASE WHEN t.i = 3 AND (e.id + d) % 50 = 0 THEN interval '200 seconds' ELSE make_interval(secs => (2 + ((e.id + d) % 20) / 10.0) * 3600) END,
       md5(e.id::text||'/'||d::text||'/'||t.p)||md5(t.p||'/'||d::text||'/'||e.id::text)
FROM "Entregador" e
CROSS JOIN generate_series(0, $DIAS - 1) d
CROSS JOIN (VALUES (1,'ALMOCO 11H-14H'),(2,'JANTAR 18H-22H'),(3,'MADRUGADA 00H-04H')) t(i,p)
WHERE e.id_empresa = 9001;
SQL
# faturamento: 1 linha de credito por entregador/dia (300 mil), no turno JANTAR (+ ~1/3 com 2a categoria "Promocao - Wn")
psql_t -q >"$TMP/seedf.log" 2>&1 <<SQL || { echo "FAIL: seed faturamento"; tail "$TMP/seedf.log"; exit 1; }
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES (9001,'faturamento',repeat('q',64),'completed');
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, periodo, tipo, valor, descricao, hash_linha)
SELECT 9001, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('q',64)), e.id, ('2026-06-30'::date - d + 1), ('2026-06-30'::date - d),
       'JANTAR 18H-22H', 'Credito', 10 + (e.id + d) % 90,
       CASE WHEN (e.id + d) % 3 = 0 THEN 'Promocao - W' || (d / 7) ELSE 'Corridas' END,
       md5(e.id::text||'/'||d::text||'/f')||md5(d::text||'/'||e.id::text||'/ff')
FROM "Entregador" e CROSS JOIN generate_series(0, $DIAS - 1) d WHERE e.id_empresa = 9001;
SQL
if [ "${PERF_NEG:-}" = "semindice" ]; then
  psql_t -q -c 'DROP INDEX IF EXISTS idx_performanceturno_empresa_data; DROP INDEX IF EXISTS idx_performance_empresa_subpraca_data; DROP INDEX IF EXISTS idx_performance_empresa_subpraca_ef_data; DROP INDEX IF EXISTS idx_performance_empresa_subpraca_efu_data;' >/dev/null
  N="$(psql_t -tAc "SELECT count(*) FROM pg_indexes WHERE indexname IN ('idx_performanceturno_empresa_data','idx_performance_empresa_subpraca_data','idx_performance_empresa_subpraca_ef_data','idx_performance_empresa_subpraca_efu_data')")"
  [ "$N" = "0" ] || { echo "ABORTA: indices nao foram derrubados (controle OCO)"; exit 1; }
  echo "NEG semindice: os 4 indices de PerformanceTurno DERRUBADOS (conferido em pg_indexes)"
fi
psql_t -q -c 'REFRESH MATERIALIZED VIEW mv_performance_dia; ANALYZE "PerformanceTurno"; ANALYZE mv_performance_dia; ANALYZE "Entregador"; ANALYZE "FaturamentoLancamento";' >/dev/null
echo "turnos em PerformanceTurno: $(psql_t -tAc 'SELECT count(*) FROM "PerformanceTurno"') | linhas na MV: $(psql_t -tAc 'SELECT count(*) FROM mv_performance_dia') | linhas de faturamento: $(psql_t -tAc 'SELECT count(*) FROM "FaturamentoLancamento"')"

# campanhas de 30 dias (junho/2026): V1 sem filtro de praca, V2 com 3 de 10 pracas + 1 turno + modal MOTO.
psql_t -q -c "SELECT 1; CREATE OR REPLACE FUNCTION hub_hoje_sp() RETURNS date LANGUAGE sql STABLE AS \$\$ SELECT '2026-06-30'::date \$\$;" >/dev/null
psql_t -q <<'SQL' >/dev/null
INSERT INTO "Campanha" (id_empresa, nome, data_inicio, data_fim, pracas, turnos, modais, min_turnos, peso_aceitacao, peso_conclusao, peso_tempo, peso_pedidos,
                        corte_aceitacao, corte_conclusao, criada_por, lancada_por, lancada_em)
SELECT 9001, v.nome, '2026-06-01', '2026-06-30', v.pracas, v.turnos, v.modais, 5, 25, 25, 25, 25, 0.55, 0.60,
       (SELECT id FROM "Usuario" WHERE email='perf@example.com'), (SELECT id FROM "Usuario" WHERE email='perf@example.com'), now()
FROM (VALUES ('V1 sem praca', NULL::text[], NULL::text[], NULL::text[]),
             ('V2 com praca', ARRAY['PRACA 1','PRACA 2','PRACA 3'], ARRAY['JANTAR 18H-22H'], ARRAY['MOTO'])) v(nome, pracas, turnos, modais);
SQL
# 0133: V3 = nota COM categorias (30 dias, sem filtro) — o turno so conta com credito que casa (hub_campanha_creditos_turno)
psql_t -q <<'SQL' >/dev/null
INSERT INTO "Campanha" (id_empresa, nome, data_inicio, data_fim, min_turnos, peso_aceitacao, peso_conclusao, peso_tempo, peso_pedidos,
                        corte_aceitacao, corte_conclusao, categorias, criada_por, lancada_por, lancada_em)
SELECT 9001, 'V3 nota com categorias', '2026-06-01', '2026-06-30', 5, 25, 25, 25, 25, 0.55, 0.60, ARRAY['Corridas','familia:promocao'],
       (SELECT id FROM "Usuario" WHERE email='perf@example.com'), (SELECT id FROM "Usuario" WHERE email='perf@example.com'), now();
SQL
# campanhas extrato (0129): X1 30 dias sem filtro de praca; X2 30 dias com praca+turno+modal; X3 91 dias (tela de turnos do app)
psql_t -q <<'SQL' >/dev/null
INSERT INTO "Campanha" (id_empresa, nome, data_inicio, data_fim, pracas, turnos, modais, min_turnos, corte_aceitacao, corte_tempo,
                        tipo, categorias, min_turnos_base, criada_por, lancada_por, lancada_em)
SELECT 9001, v.nome, v.ini, '2026-06-30', v.pracas, v.turnos, v.modais, 5, 0.55, 0.60, 'extrato', ARRAY['Corridas','familia:promocao'], 'validos',
       (SELECT id FROM "Usuario" WHERE email='perf@example.com'), (SELECT id FROM "Usuario" WHERE email='perf@example.com'), now()
FROM (VALUES ('X1 extrato 30d', '2026-06-01'::date, NULL::text[], NULL::text[], NULL::text[]),
             ('X2 extrato 30d filtros', '2026-06-01'::date, ARRAY['PRACA 1','PRACA 2','PRACA 3'], ARRAY['JANTAR 18H-22H'], ARRAY['MOTO']),
             ('X3 extrato 91d', '2026-04-01'::date, NULL, NULL, NULL)) v(nome, ini, pracas, turnos, modais);
SQL
# 0132: toda campanha nasce oculta e o app (hub_motorista_*) so enxerga as visiveis; as campanhas do volume sao ligadas aqui
psql_t -q -c 'UPDATE "Campanha" SET visivel_app = true WHERE id_empresa = 9001' >/dev/null
X1="$(psql_t -tAc "SELECT id FROM \"Campanha\" WHERE nome='X1 extrato 30d'")"; X2="$(psql_t -tAc "SELECT id FROM \"Campanha\" WHERE nome='X2 extrato 30d filtros'")"; X3="$(psql_t -tAc "SELECT id FROM \"Campanha\" WHERE nome='X3 extrato 91d'")"
V3="$(psql_t -tAc "SELECT id FROM \"Campanha\" WHERE nome='V3 nota com categorias'")"
V1="$(psql_t -tAc "SELECT id FROM \"Campanha\" WHERE nome='V1 sem praca'")"; V2="$(psql_t -tAc "SELECT id FROM \"Campanha\" WHERE nome='V2 com praca'")"
CNPJ=90000000000003  # entregador 3 (PRACA 3, MOTO) esta nas duas

fails=0
ck() { if [ "$2" = "ok" ]; then echo "PASS: $1"; else echo "FAIL: $1 ($2)"; fails=$((fails+1)); fi; }

# mede <rotulo> <max_ms> <sql-de-uma-chamada> [prefixo SET ROLE/claims]  -> melhor/mediana de 5 (clock_timestamp em DO)
mede() {
  local rot="$1" max="$2" call="$3" pre="${4:-}"
  psql_t -tA 2>"$TMP/mede.err" >"$TMP/mede.out" <<SQL || { echo "FAIL: mede $rot"; cat "$TMP/mede.err"; fails=$((fails+1)); return; }
BEGIN;
$pre
DO \$do\$
DECLARE t0 timestamptz; v numeric[] := '{}'; i int; m numeric;
BEGIN
  FOR i IN 1..5 LOOP
    t0 := clock_timestamp(); PERFORM $call; v := v || (extract(epoch FROM clock_timestamp() - t0) * 1000)::numeric;
  END LOOP;
  RAISE NOTICE 'MEDIDAS %', (SELECT string_agg(round(x,1)::text, ' ' ORDER BY ord) FROM unnest(v) WITH ORDINALITY u(x, ord));
END \$do\$;
ROLLBACK;
SQL
  local linha melhor med
  linha="$(grep -h 'MEDIDAS' "$TMP/mede.err" | sed 's/.*MEDIDAS //')"
  melhor="$(printf '%s\n' $linha | sort -n | head -1)"; med="$(printf '%s\n' $linha | sort -n | sed -n 3p)"
  echo "  [$rot] 5 medidas (ms): $linha | melhor=$melhor mediana=$med | orcamento=$max"
  ck "$rot melhor de 5 <= $max ms" "$(awk -v a="$melhor" -v b="$max" 'BEGIN{print (a<=b)?"ok":"ms="a}')"
}
CLAIM_ADM="SELECT set_config('request.jwt.claims', jsonb_build_object('sub',(SELECT id FROM \"Usuario\" WHERE email='perf@example.com'),'empresa_ativa','9001','escopo','[9001]'::jsonb)::text, true); SET LOCAL ROLE authenticated;"
CLAIM_MOT="SELECT set_config('request.jwt.claims', jsonb_build_object('sub','1','motorista_cnpj','$CNPJ')::text, true); SET LOCAL ROLE authenticated;"

echo "--- 1a execucao (INSERT de ~2.000 linhas de ranking) e re-execucoes (UPDATE por conflito) ---"
for V in $V1 $V2 $V3; do
  R="$(psql_t -tA -c "SELECT hub_campanha_recalcular_interno($V);")"
  echo "  campanha $V 1a execucao: $R"
done
mede "recalcular V1 (30 dias, SEM praca)" 2000 "hub_campanha_recalcular_interno($V1)"
mede "recalcular V2 (30 dias, COM praca+turno+modal)" 2000 "hub_campanha_recalcular_interno($V2)"
mede "recalcular V3 (nota COM categorias, 30 dias)" 2000 "hub_campanha_recalcular_interno($V3)"
mede "hub_campanha_recalcular V1 via RPC do hub (autorizado)" 2000 "hub_campanha_recalcular($V1)" "$CLAIM_ADM"
mede "hub_motorista_campanha V1" 50 "hub_motorista_campanha($V1)" "$CLAIM_MOT"
mede "hub_motorista_campanha V2" 50 "hub_motorista_campanha($V2)" "$CLAIM_MOT"
mede "hub_motorista_campanhas (lista do app)" 50 "hub_motorista_campanhas()" "$CLAIM_MOT"
mede "hub_campanha_ranking V1 pagina 50 (classificado)" 100 "(SELECT count(*) FROM hub_campanha_ranking($V1,'classificado',50,0))" "$CLAIM_ADM"
mede "hub_campanha_ranking V1 pagina 50, offset 1000" 100 "(SELECT count(*) FROM hub_campanha_ranking($V1,'classificado',50,1000))" "$CLAIM_ADM"
mede "hub_campanha_ranking V1 pagina 50 (todas as situacoes)" 100 "(SELECT count(*) FROM hub_campanha_ranking($V1,NULL,50,0))" "$CLAIM_ADM"
mede "hub_campanha_ranking V2 pagina 50" 100 "(SELECT count(*) FROM hub_campanha_ranking($V2,'classificado',50,0))" "$CLAIM_ADM"
echo "--- 0129: campanha extrato ---"
for V in $X1 $X2 $X3; do echo "  extrato $V 1a execucao: $(psql_t -tA -c "SELECT hub_campanha_recalcular_interno($V);")"; done
echo "  classificados X1: $(psql_t -tAc "SELECT count(*) FILTER (WHERE situacao='classificado')||' de '||count(*) FROM \"CampanhaRanking\" WHERE campanha_id=$X1") | valor medio dos classificados (centavos): $(psql_t -tAc "SELECT round(avg(valor_centavos)) FROM \"CampanhaRanking\" WHERE campanha_id=$X1 AND situacao='classificado'")"
mede "recalcular EXTRATO X1 (30 dias, SEM filtro)" 2000 "hub_campanha_recalcular_interno($X1)"
mede "recalcular EXTRATO X2 (30 dias, praca+turno+modal)" 2000 "hub_campanha_recalcular_interno($X2)"
mede "recalcular EXTRATO X3 (91 dias; o plano so exige 30 dias — teto informativo de 3x)" 6000 "hub_campanha_recalcular_interno($X3)"
mede "hub_motorista_campanha EXTRATO X1" 50 "hub_motorista_campanha($X1)" "$CLAIM_MOT"
mede "hub_motorista_campanha EXTRATO X3 (91 dias)" 50 "hub_motorista_campanha($X3)" "$CLAIM_MOT"
mede "hub_motorista_campanha_turnos X1 (30 dias)" 50 "hub_motorista_campanha_turnos($X1)" "$CLAIM_MOT"
mede "hub_motorista_campanha_turnos X3 (91 dias)" 50 "hub_motorista_campanha_turnos($X3)" "$CLAIM_MOT"
mede "hub_campanha_ranking EXTRATO X1 pagina 50" 100 "(SELECT count(*) FROM hub_campanha_ranking($X1,'classificado',50,0))" "$CLAIM_ADM"
mede "hub_campanha_categorias (seletor)" 500 "(SELECT count(*) FROM hub_campanha_categorias())" "$CLAIM_ADM"
mede "hub_campanha_ranking_contagem V1" 100 "hub_campanha_ranking_contagem($V1)" "$CLAIM_ADM"
echo "  hub_campanha_opcoes (abre o formulario e roda ao lancar; meta do orquestrador <= 500 ms):"
mede "hub_campanha_opcoes (lista de opcoes + cobertura 30d, sem filtro)" 500 "hub_campanha_opcoes(9001,NULL,NULL,NULL)" "$CLAIM_ADM"

echo "--- 0133: RPCs de performance com p_subpraca (filtro pela efetiva) ---"
mede "hub_performance_totais p_subpraca='PRACA 3' (30 dias)" 500 "hub_performance_totais(9001,'2026-06-01','2026-06-30',NULL,'PRACA 3',NULL)" "$CLAIM_ADM"
mede "hub_performance_turnos p_subpraca='PRACA 7' (efetiva: subpraca vazia -> origem; pagina 50)" 500 "(SELECT count(*) FROM hub_performance_turnos(9001,'2026-06-01','2026-06-30',NULL,'PRACA 7',NULL,50,0))" "$CLAIM_ADM"

echo "--- 0133/C6: listas por PostgREST filtradas por subpraca_efetiva=eq.X (como authenticated, sob RLS; filtros e ordem das rotas) ---"
FPT="pt.id_empresa = 9001 AND pt.data_periodo >= '2026-06-01' AND pt.data_periodo <= '2026-06-30' AND subpraca_efetiva(pt) = 'PRACA 3'"
FFL="fl.id_empresa = 9001 AND fl.data_lancamento >= '2026-06-01' AND fl.data_lancamento <= '2026-07-01' AND subpraca_efetiva(fl) = 'LIVRE'"
mede "C6 performance: pagina 50 (order data_periodo desc, id desc) com subpraca_efetiva=eq" 500 "(SELECT count(*) FROM (SELECT pt.id, subpraca_efetiva(pt) FROM \"PerformanceTurno\" pt WHERE $FPT ORDER BY pt.data_periodo DESC, pt.id DESC LIMIT 50) x)" "$CLAIM_ADM"
mede "C6 performance: contagem exata do filtro (30 dias, PRACA 3)" 500 "(SELECT count(*) FROM \"PerformanceTurno\" pt WHERE $FPT)" "$CLAIM_ADM"
mede "C6 faturamento: pagina 50 (order data_lancamento desc, data_referencia desc, id desc) com subpraca_efetiva=eq" 500 "(SELECT count(*) FROM (SELECT fl.id, subpraca_efetiva(fl) FROM \"FaturamentoLancamento\" fl WHERE $FFL ORDER BY fl.data_lancamento DESC, fl.data_referencia DESC, fl.id DESC LIMIT 50) x)" "$CLAIM_ADM"
mede "C6 faturamento: contagem exata do filtro (LIVRE, 30 dias)" 500 "(SELECT count(*) FROM \"FaturamentoLancamento\" fl WHERE $FFL)" "$CLAIM_ADM"

echo "--- EXPLAIN (ANALYZE) dos comandos internos via auto_explain aninhado (uma sessao por cenario: secoes deterministicas) ---"
plano() { # plano <rotulo> <comandos SQL>
  psql_t -tA >"$TMP/plan-$1.out" 2>&1 <<SQL
LOAD 'auto_explain';
SET auto_explain.log_min_duration = 0; SET auto_explain.log_analyze = on; SET auto_explain.log_buffers = on;
SET auto_explain.log_nested_statements = on; SET auto_explain.log_timing = on; SET client_min_messages = log;
DO \$\$ BEGIN RAISE LOG '#### $1'; END \$\$;
$2
SQL
}
plano RECALCULAR_V1 "SELECT hub_campanha_recalcular_interno($V1) \\gset"
plano RECALCULAR_V2 "SELECT hub_campanha_recalcular_interno($V2) \\gset"
plano RECALCULAR_V3_nota_com_categorias "SELECT hub_campanha_recalcular_interno($V3) \\gset"
plano PERFORMANCE_TOTAIS_p_subpraca "BEGIN; $CLAIM_ADM SELECT * FROM hub_performance_totais(9001,'2026-06-01','2026-06-30',NULL,'PRACA 3',NULL) \\gset
ROLLBACK;"
plano PERFORMANCE_TURNOS_p_subpraca "BEGIN; $CLAIM_ADM SELECT count(*) FROM hub_performance_turnos(9001,'2026-06-01','2026-06-30',NULL,'PRACA 7',NULL,50,0);
ROLLBACK;"
plano OPCOES "BEGIN; $CLAIM_ADM SELECT hub_campanha_opcoes(9001,NULL,NULL,NULL) \\gset
ROLLBACK;"
plano MOTORISTA_V1 "BEGIN; $CLAIM_MOT SELECT hub_motorista_campanha($V1) \\gset
ROLLBACK;"
plano RECALCULAR_EXTRATO_X1 "SELECT hub_campanha_recalcular_interno($X1) \\gset"
plano TURNOS_APP_X3 "BEGIN; $CLAIM_MOT SELECT hub_motorista_campanha_turnos($X3) \\gset
ROLLBACK;"
plano RANKING_V1_pagina_50 "BEGIN; $CLAIM_ADM SELECT count(*) FROM hub_campanha_ranking($V1,'classificado',50,0);
ROLLBACK;"
cat "$TMP"/plan-*.out > "$TMP/plan.out"
cp "$TMP/plan.out" /tmp/claude-0/camp-plan.txt 2>/dev/null || true
# resumo: no principal de cada plano e o tempo total (a transcricao completa fica em /tmp/claude-0/camp-plan.txt)
grep -E '(^|LOG:  )(####|duration)|Execution Time|Seq Scan|Index (Only )?Scan|Hash Semi Join|Bitmap (Heap|Index) Scan|WindowAgg|Sort Method|Planning Time' "$TMP/plan.out" | cut -c1-200 | head -200
# 0133: EXPLAIN tem de mostrar os indices de EXPRESSAO (semi-join da campanha por upper(efetiva); RPCs de performance pela efetiva exata)
# (com PERF_NEG=semindice estes checks DEVEM falhar: sao o controle negativo do plano)
if true; then
  ck "EXPLAIN: semi-join de praca da campanha (V2) usa idx_performance_empresa_subpraca_efu_data" "$(grep -q 'idx_performance_empresa_subpraca_efu_data' "$TMP/plan-RECALCULAR_V2.out" && echo ok || echo 'indice de expressao ausente do plano de V2')"
  ck "EXPLAIN: hub_performance_totais com p_subpraca usa idx_performance_empresa_subpraca_ef_data" "$(grep -q 'idx_performance_empresa_subpraca_ef_data' "$TMP/plan-PERFORMANCE_TOTAIS_p_subpraca.out" && echo ok || echo 'indice de expressao ausente do plano de totais')"
  ck "EXPLAIN: hub_performance_turnos com p_subpraca usa idx_performance_empresa_subpraca_ef_data" "$(grep -q 'idx_performance_empresa_subpraca_ef_data' "$TMP/plan-PERFORMANCE_TURNOS_p_subpraca.out" && echo ok || echo 'indice de expressao ausente do plano de turnos')"
  ck "EXPLAIN: hub_campanha_opcoes (varredura solta de pracas) usa o indice de expressao" "$(grep -q 'idx_performance_empresa_subpraca_ef' "$TMP/plan-OPCOES.out" && echo ok || echo 'indice de expressao ausente do plano das opcoes')"
fi

echo "===================================================================="
echo "CAMPANHAS-PERF${PERF_NEG:+ (controle negativo: $PERF_NEG)}: $([ $fails -eq 0 ] && echo APROVADO || echo "REPROVADO ($fails criterio(s))")"
echo "===================================================================="
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)

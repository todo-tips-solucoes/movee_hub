#!/usr/bin/env bash
# =============================================================================
# ensaio-migrations-s10.sh — S10, escopo item 2 (briefing s10-regressao-
# cutover.md, com a correção de drift: o local canônico das migrations é
# infra/hub/migrations/ — série 0000–0040 — aplicadas via migrate.sh +
# SIGUSR1, NUNCA app_homologacao/backend/db/011+).
#
# Duas medições, dois projetos compose efêmeros (compose.hub.s10.yml — banco
# em DISCO, não tmpfs, para pagar I/O real como o postgres:13 de produção):
#
#   RUN A (hub-s10a-<runid>) — cenário do CUTOVER REAL: banco VAZIO, série
#     completa 0000→0040 pelo migrate.sh (caminho real, com SIGUSR1 no
#     PostgREST), tempo por migration extraído do stdout com timestamps ms.
#     No cutover as tabelas de fato nascem vazias (primeira importação real é
#     passo pós-smoke do runbook), então ESTES são os números esperados no G3.
#
#   RUN B (hub-s10b-<runid>) — prova de ROBUSTEZ sob volume: aplica 0000→0019
#     (migrate.sh -t 0019), carrega o dataset sintético volumoso do gen-seeds
#     (~1,5M FaturamentoLancamento + ~1M PerformanceTurno, 374 dos 375 dias —
#     o último dia fica reservado para o teste de import diário da carga-
#     s10.sh), e aplica 0020→0040 cronometradas SOBRE o volume, com:
#       - sampler de pg_locks (bloqueios não-granted) em background;
#       - log_lock_waits=on + deadlock_timeout=200ms no postgres;
#       - integridade ao final (contagens, FKs órfãs, SchemaMigration=40);
#       - idempotência (re-run migrate.sh = "0 aplicadas agora");
#       - REFRESH MATERIALIZED VIEW CONCURRENTLY das 2 MVs medido sob volume.
#
# LGPD: o dataset é 100% sintético/anonimizado (gen-seeds, asserção de 0
# vazamentos). NUNCA usa dump de produção. NUNCA toca chatmasterveloz.
#
# Uso:
#   infra/hub/testes/ensaio-migrations-s10.sh [-k] [-s dir-seeds] [-o dir-evid]
#     -k  mantém o stack do RUN B no ar ao final (para carga-s10.sh); o
#         projeto fica registrado em <dir-evid>/stack-mantido.txt
#     -s  dataset sintético (default: infra/hub/seeds/out-s10)
#     -o  evidências (default: docs/plans/hub-frota/evidencias/S10/
#         ensaio-migrations-<ts>)
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$HUB_DIR/../.." && pwd)"
COMPOSE="$HUB_DIR/compose.hub.s10.yml"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
RUNID="$(date +%s)"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

KEEP=0
SEEDS="$HUB_DIR/seeds/out-s10"
EVID="$REPO_DIR/docs/plans/hub-frota/evidencias/S10/ensaio-migrations-$TS"
while getopts "ks:o:" opt; do
  case "$opt" in
    k) KEEP=1 ;;
    s) SEEDS="$OPTARG" ;;
    o) EVID="$OPTARG" ;;
    *) echo "uso: $0 [-k] [-s dir-seeds] [-o dir-evid]" >&2; exit 2 ;;
  esac
done
mkdir -p "$EVID"
[ -d "$SEEDS/faturamento" ] || { echo "seeds não encontrados em $SEEDS (rode gen-seeds.py --synthesize-days)" >&2; exit 1; }

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }

P_A="hub-s10a-$RUNID"
P_B="hub-s10b-$RUNID"
SAMPLER_PID=""

dca() { docker compose -f "$COMPOSE" -p "$P_A" --env-file "$ENV_FILE" "$@"; }
dcb() { docker compose -f "$COMPOSE" -p "$P_B" --env-file "$ENV_FILE" "$@"; }
psql_a() { dca exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
psql_b() { dcb exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }

cleanup() {
  [ -n "$SAMPLER_PID" ] && kill "$SAMPLER_PID" 2>/dev/null
  dca down -v --remove-orphans >/dev/null 2>&1 || true
  if [ "$KEEP" != "1" ]; then dcb down -v --remove-orphans >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails + 1)); fi
}

# migrate.sh com timestamp ms por linha de stdout (para derivar duração por
# migration); preserva o exit code do migrate.sh via pipefail.
migrate_timed() { # migrate_timed <log> <migrate-args...>
  local log="$1"; shift
  set -o pipefail
  "$HUB_DIR/scripts/migrate.sh" "$@" 2>&1 \
    | while IFS= read -r line; do printf '%s %s\n' "$(date +%s%3N)" "$line"; done \
    | tee "$log" >/dev/null
}

# extrai "| migration | ms |" de um log do migrate_timed
tabela_tempos() { # tabela_tempos <log>
  awk '
    { ts = $1 }
    $2 == "aplicando:" { if (n != "") { print "| " n " | " (ts - t0) " |" } n = $3; t0 = ts }
    (n != "") && ($2 == "PostgREST:" || $2 == "migrate:") { print "| " n " | " (ts - t0) " |"; n = "" }
  ' "$1"
}

echo "ensaio-migrations-s10: evidências em $EVID"
"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$P_A" -e "$ENV_FILE" || { echo "preflight abortou (RUN A)"; exit 1; }

# ═══ RUN A — série completa do zero em banco VAZIO (cenário do cutover) ════
echo "── RUN A ($P_A): banco vazio, série completa via migrate.sh"
dca up -d --wait db postgrest
migrate_timed "$EVID/run-a-migrations.log" -f "$COMPOSE" -p "$P_A" -e "$ENV_FILE" \
  || { echo "FAIL: migrate.sh RUN A"; tail -20 "$EVID/run-a-migrations.log"; exit 1; }
N_A="$(psql_a -tAc 'SELECT count(*) FROM "SchemaMigration"' | tr -d '[:space:]')"
check "RUN A: SchemaMigration registra a série completa (41)" "$N_A" "41"
# idempotência em banco recém-migrado
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$P_A" -e "$ENV_FILE" >"$EVID/run-a-rerun.log" 2>&1
check "RUN A: re-run do migrate.sh é no-op" \
  "$(grep -c 'concluído (0 aplicadas agora)' "$EVID/run-a-rerun.log")" "1"
dca down -v --remove-orphans >/dev/null 2>&1

# ═══ RUN B — volume: 0000→0019, carga bulk, 0020→0040 sob 2,5M linhas ══════
echo "── RUN B ($P_B): 0000→0019, carga volumosa, 0020→0040 medidas sob volume"
"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$P_B" -e "$ENV_FILE" || { echo "preflight abortou (RUN B)"; exit 1; }
dcb up -d --wait db postgrest

# visibilidade de locks no postgres (mesmos parâmetros sugeridos no runbook)
psql_b -c "ALTER SYSTEM SET log_lock_waits = on" >/dev/null
psql_b -c "ALTER SYSTEM SET deadlock_timeout = '200ms'" >/dev/null
psql_b -tAc "SELECT pg_reload_conf()" >/dev/null

migrate_timed "$EVID/run-b-fase1.log" -f "$COMPOSE" -p "$P_B" -e "$ENV_FILE" -t 0019 \
  || { echo "FAIL: migrate.sh -t 0019 RUN B"; tail -20 "$EVID/run-b-fase1.log"; exit 1; }

echo "── RUN B: staging + transformação para as tabelas de fato (tenant 9001)"
{
  echo "início carga: $(date -u +%H:%M:%SZ)"
  # staging all-text (mesmo desenho de carga-seeds-teste.sh: 1 \copy por
  # dataset, stream único sem headers). O ÚLTIMO dia de cada dataset fica de
  # fora — reservado ao teste de import diário via pipeline real (carga-s10.sh).
  for tipo in faturamento performance; do
    dir="$SEEDS/$tipo"
    header="$(head -1 "$(ls "$dir"/*.csv | head -1)" | tr -d '\r')"
    ddl="CREATE TABLE staging_$tipo ($(echo "$header" | awk -F';' '{for(i=1;i<=NF;i++) printf "%s\"%s\" text", (i>1?", ":""), $i}'));"
    psql_b -c "$ddl" >/dev/null
    ultimo="$(ls "$dir"/*.csv | sort | tail -1)"
    { for f in $(ls "$dir"/*.csv | sort); do [ "$f" = "$ultimo" ] && continue; tail -n +2 "$f"; done; } \
      | psql_b -c "\\copy staging_$tipo FROM STDIN WITH (FORMAT csv, DELIMITER ';', HEADER false)" >/dev/null
    echo "staging_$tipo: $(psql_b -tAc "SELECT count(*) FROM staging_$tipo") linhas (dia reservado ao pipeline: $(basename "$ultimo"))"
  done

  psql_b <<'SQL'
-- conversões tolerantes (linhas fora do domínio viram NULL/excluídas — o
-- objetivo aqui é VOLUME fiel em escala, não re-testar o parser, que já tem
-- suíte própria: hub-import-parser/normalizer + integração S4)
CREATE OR REPLACE FUNCTION s10_num(t text) RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF t IS NULL OR t = '' THEN RETURN NULL; END IF;
  IF position(',' in t) > 0 THEN t := replace(replace(t, '.', ''), ',', '.'); END IF;
  RETURN t::numeric;
EXCEPTION WHEN others THEN RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION s10_date(t text) RETURNS date LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN RETURN t::date; EXCEPTION WHEN others THEN RETURN NULL; END $$;
CREATE OR REPLACE FUNCTION s10_interval(t text) RETURNS interval LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF t IS NULL OR t !~ '^[0-9]{1,3}:[0-9]{2}(:[0-9]{2})?$' THEN RETURN NULL; END IF;
  RETURN t::interval;
EXCEPTION WHEN others THEN RETURN NULL; END $$;
SQL

  psql_b <<'SQL'
-- dimensão Entregador a partir dos UUIDs anônimos dos dois datasets
INSERT INTO "Entregador" (id_empresa, id_externo, nome)
SELECT 9001, u::uuid, NULL
FROM (
  SELECT id_da_pessoa_entregadora AS u FROM staging_faturamento
  WHERE id_da_pessoa_entregadora ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  UNION
  SELECT id_da_pessoa_entregadora FROM staging_performance
  WHERE id_da_pessoa_entregadora ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
) x
ON CONFLICT (id_empresa, id_externo) DO NOTHING;
UPDATE "Entregador" e SET nome = p.nome
FROM (
  SELECT id_da_pessoa_entregadora AS u, max(pessoa_entregadora) AS nome
  FROM staging_performance WHERE pessoa_entregadora <> '' GROUP BY 1
) p
WHERE e.id_empresa = 9001 AND e.id_externo::text = p.u AND e.nome IS NULL;
-- cabeçalhos sintéticos de importação (FK obrigatória dos fatos)
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, nome_arquivo, hash_sha256, status)
VALUES (9001, 'faturamento', 's10-volume-bulk.csv', repeat('f', 64), 'completed'),
       (9001, 'performance', 's10-volume-bulk.csv', repeat('e', 64), 'completed')
ON CONFLICT DO NOTHING;
SQL

  echo "fatos faturamento: $(date -u +%H:%M:%SZ)"
  psql_b <<'SQL'
INSERT INTO "FaturamentoLancamento"
  (id_empresa, importacao_id, entregador_id, recebedor_agregado, data_lancamento,
   data_referencia, data_repasse, periodo, praca, subpraca, origem, tipo, valor,
   descricao, atingido, pct_tempo_disponivel, pct_aceitacao, pct_conclusao,
   criterio_tempo_disponivel, criterio_rotas_aceitas, criterio_rotas_concluidas,
   margem_fee_raw, hash_linha)
SELECT 9001,
       (SELECT id FROM "ImportacaoArquivo" WHERE id_empresa = 9001 AND tipo = 'faturamento' AND nome_arquivo = 's10-volume-bulk.csv'),
       e.id, NULLIF(s.recebedor, ''),
       s10_date(s.data_do_lancamento_financeiro), s10_date(s.data_do_periodo_de_referencia), s10_date(s.data_do_repasse),
       NULLIF(s.periodo, ''), NULLIF(s.praca, ''), NULLIF(s.subpraca, ''), NULLIF(s.origem, ''),
       s.tipo, s10_num(s.valor), s.descricao,
       CASE WHEN s10_num(s.atingido) BETWEEN 0 AND 1000 THEN s10_num(s.atingido) END,
       s10_num(s.percentual_de_tempo_disponivel), s10_num(s.percentual_de_aceitacao), s10_num(s.percentual_de_conclusao),
       s10_num(s.criterio_tempo_disponivel), s10_num(s.criterio_rotas_aceitas), s10_num(s.criterio_rotas_concluidas),
       NULLIF(s.margem_fee_porcentagem, ''),
       md5('s10-fat-a' || s.rn::text) || md5('s10-fat-b' || s.rn::text)
FROM (SELECT *, row_number() OVER () AS rn FROM staging_faturamento) s
LEFT JOIN "Entregador" e
  ON e.id_empresa = 9001 AND e.id_externo::text = lower(s.id_da_pessoa_entregadora)
WHERE s10_date(s.data_do_lancamento_financeiro) IS NOT NULL
  AND s10_date(s.data_do_periodo_de_referencia) IS NOT NULL
  AND s.tipo <> '' AND s.descricao <> ''
  AND s10_num(s.valor) > 0;
SQL

  echo "fatos performance: $(date -u +%H:%M:%SZ)"
  psql_b <<'SQL'
INSERT INTO "PerformanceTurno"
  (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao,
   min_entregadores_escala, tag, praca, subpraca, origem, tempo_disponivel_pct,
   tempo_disponivel, corridas_ofertadas, corridas_aceitas, corridas_rejeitadas,
   corridas_completadas, corridas_canceladas, pedidos_concluidos, taxas_centavos,
   hash_linha)
SELECT 9001,
       (SELECT id FROM "ImportacaoArquivo" WHERE id_empresa = 9001 AND tipo = 'performance' AND nome_arquivo = 's10-volume-bulk.csv'),
       e.id, s10_date(s.data_do_periodo), s.periodo,
       s10_interval(s.duracao_do_periodo),
       GREATEST(trunc(s10_num(s.numero_minimo_de_entregadores_regulares_na_escala))::int, 0),
       NULLIF(s.tag, ''), NULLIF(s.praca, ''), NULLIF(s.sub_praca, ''), NULLIF(s.origem, ''),
       CASE WHEN s10_num(s.tempo_disponivel_escalado) BETWEEN 0 AND 150 THEN s10_num(s.tempo_disponivel_escalado) END,
       s10_interval(s.tempo_disponivel_absoluto),
       GREATEST(COALESCE(trunc(s10_num(s.numero_de_corridas_ofertadas))::int, 0), 0),
       GREATEST(COALESCE(trunc(s10_num(s.numero_de_corridas_aceitas))::int, 0), 0),
       GREATEST(COALESCE(trunc(s10_num(s.numero_de_corridas_rejeitadas))::int, 0), 0),
       GREATEST(COALESCE(trunc(s10_num(s.numero_de_corridas_completadas))::int, 0), 0),
       GREATEST(COALESCE(trunc(s10_num(s.numero_de_corridas_canceladas_pela_pessoa_entregadora))::int, 0), 0),
       trunc(s10_num(s.numero_de_pedidos_aceitos_e_concluidos))::int,
       trunc(s10_num(s.soma_das_taxas_das_corridas_aceitas) * 100)::int,
       md5('s10-perf-a' || s.rn::text) || md5('s10-perf-b' || s.rn::text)
FROM (SELECT *, row_number() OVER () AS rn FROM staging_performance) s
JOIN "Entregador" e
  ON e.id_empresa = 9001 AND e.id_externo::text = lower(s.id_da_pessoa_entregadora)
WHERE s10_date(s.data_do_periodo) IS NOT NULL AND s.periodo <> '';
SQL

  psql_b -c 'ANALYZE "FaturamentoLancamento"; ANALYZE "PerformanceTurno"; ANALYZE "Entregador";' >/dev/null
  echo "fim carga: $(date -u +%H:%M:%SZ)"
  echo "contagens pós-carga:"
  psql_b -tAc "SELECT 'FaturamentoLancamento: ' || count(*) FROM \"FaturamentoLancamento\""
  psql_b -tAc "SELECT 'PerformanceTurno: '      || count(*) FROM \"PerformanceTurno\""
  psql_b -tAc "SELECT 'Entregador: '            || count(*) FROM \"Entregador\""
  psql_b -tAc "SELECT 'staging fat excluídas: ' || ((SELECT count(*) FROM staging_faturamento) - (SELECT count(*) FROM \"FaturamentoLancamento\"))"
  psql_b -tAc "SELECT 'staging perf excluídas: '|| ((SELECT count(*) FROM staging_performance) - (SELECT count(*) FROM \"PerformanceTurno\"))"
  psql_b -tAc "SELECT 'tamanho fat: '  || pg_size_pretty(pg_total_relation_size('\"FaturamentoLancamento\"'))"
  psql_b -tAc "SELECT 'tamanho perf: ' || pg_size_pretty(pg_total_relation_size('\"PerformanceTurno\"'))"
} 2>&1 | tee "$EVID/run-b-carga.log"

FAT_N="$(psql_b -tAc 'SELECT count(*) FROM "FaturamentoLancamento"' | tr -d '[:space:]')"
PERF_N="$(psql_b -tAc 'SELECT count(*) FROM "PerformanceTurno"' | tr -d '[:space:]')"
[ "${FAT_N:-0}" -ge 1400000 ] && echo "PASS: volume de faturamento >= 1,4M ($FAT_N)" || { echo "FAIL: volume de faturamento insuficiente ($FAT_N)"; fails=$((fails + 1)); }
[ "${PERF_N:-0}" -ge 950000 ] && echo "PASS: volume de performance >= 950k ($PERF_N)" || { echo "FAIL: volume de performance insuficiente ($PERF_N)"; fails=$((fails + 1)); }

# staging (~1 GB all-text) e helpers s10_* já cumpriram o papel — dropa ANTES
# da fase cronometrada para não inflar cache/autovacuum durante a medição nem
# deixar peso morto no stack mantido pelo -k
psql_b -c 'DROP TABLE IF EXISTS staging_faturamento, staging_performance;' >/dev/null
psql_b -c 'DROP FUNCTION IF EXISTS s10_num(text); DROP FUNCTION IF EXISTS s10_date(text); DROP FUNCTION IF EXISTS s10_interval(text);' >/dev/null

# sampler de locks em background — UM docker exec com o loop DENTRO do
# container (1 fork de compose no total; período real ~0,5s — o desenho
# anterior pagava o startup do CLI do compose por amostra e o período efetivo
# passava de 1s). Loop LIMITADO (2400 × 0,5s = 20 min) para nunca ficar órfão
# no container caso o kill do cliente docker exec não propague.
(
  dcb exec -T db bash -s "$DB_USER" "$DB_NAME" <<'SAMPLER'
DB_USER="$1"; DB_NAME="$2"; i=0
while [ "$i" -lt 2400 ]; do
  psql -U "$DB_USER" -d "$DB_NAME" -tAc "
    SELECT to_char(now(), 'HH24:MI:SS.MS') || ' | pid=' || a.pid || ' | ' || l.mode ||
           ' | rel=' || coalesce(l.relation::regclass::text, '-') ||
           ' | espera: ' || left(regexp_replace(a.query, '\s+', ' ', 'g'), 100)
    FROM pg_locks l JOIN pg_stat_activity a USING (pid)
    WHERE NOT l.granted" 2>/dev/null
  sleep 0.5
  i=$((i + 1))
done
SAMPLER
) >>"$EVID/run-b-locks-sampler.log" &
SAMPLER_PID=$!

echo "── RUN B: migrations 0020→0040 sobre o volume (sampler de locks ativo)"
migrate_timed "$EVID/run-b-fase2.log" -f "$COMPOSE" -p "$P_B" -e "$ENV_FILE" \
  || { echo "FAIL: migrate.sh fase 2 RUN B"; tail -20 "$EVID/run-b-fase2.log"; exit 1; }

kill "$SAMPLER_PID" 2>/dev/null; wait "$SAMPLER_PID" 2>/dev/null; SAMPLER_PID=""
BLOQUEIOS="$(grep -c 'pid=' "$EVID/run-b-locks-sampler.log" 2>/dev/null || true)"
check "RUN B: 0 amostras de lock bloqueado durante as migrations" "${BLOQUEIOS:-0}" "0"
dcb logs db 2>&1 | grep -i 'still waiting\|deadlock detected' >"$EVID/run-b-db-lock-waits.log" || true
check "RUN B: 0 'still waiting' no log do postgres (log_lock_waits)" \
  "$(wc -l <"$EVID/run-b-db-lock-waits.log" | tr -d '[:space:]')" "0"

# integridade + idempotência + REFRESH das MVs sob volume
N_B="$(psql_b -tAc 'SELECT count(*) FROM "SchemaMigration"' | tr -d '[:space:]')"
check "RUN B: SchemaMigration registra a série completa (41)" "$N_B" "41"
ORFAS="$(psql_b -tAc 'SELECT count(*) FROM "PerformanceTurno" p LEFT JOIN "Entregador" e ON e.id = p.entregador_id WHERE e.id IS NULL' | tr -d '[:space:]')"
check "RUN B: 0 FKs órfãs PerformanceTurno→Entregador" "$ORFAS" "0"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$P_B" -e "$ENV_FILE" >"$EVID/run-b-rerun.log" 2>&1
check "RUN B: re-run do migrate.sh é no-op (idempotência sob volume)" \
  "$(grep -c 'concluído (0 aplicadas agora)' "$EVID/run-b-rerun.log")" "1"
{
  echo "REFRESH CONCURRENTLY sob volume:"
  psql_b -c '\timing on' -c 'REFRESH MATERIALIZED VIEW CONCURRENTLY mv_faturamento_dia'
  psql_b -c '\timing on' -c 'REFRESH MATERIALIZED VIEW CONCURRENTLY mv_performance_dia'
  psql_b -tAc "SELECT 'mv_faturamento_dia: ' || count(*) FROM mv_faturamento_dia"
  psql_b -tAc "SELECT 'mv_performance_dia: ' || count(*) FROM mv_performance_dia"
} 2>&1 | tee "$EVID/run-b-refresh-mv.log"

# ── tabela consolidada tempo/locks (insumo direto do RUNBOOK-CUTOVER.md) ────
{
  echo "# Ensaio de migrations S10 — tempos por migration ($TS)"
  echo
  echo "## RUN A — banco VAZIO (cenário do cutover; migrate.sh série completa)"
  echo
  echo "| migration | ms |"; echo "|---|---|"
  tabela_tempos "$EVID/run-a-migrations.log"
  echo
  echo "## RUN B — fase 1 (0000→0019, banco vazio)"
  echo
  echo "| migration | ms |"; echo "|---|---|"
  tabela_tempos "$EVID/run-b-fase1.log"
  echo
  echo "## RUN B — fase 2 (0020→0040 sobre ~$FAT_N fat + $PERF_N perf)"
  echo
  echo "| migration | ms |"; echo "|---|---|"
  tabela_tempos "$EVID/run-b-fase2.log"
  echo
  echo "Locks bloqueados observados no sampler: ${BLOQUEIOS:-0} amostras"
  echo "(run-b-locks-sampler.log; log_lock_waits em run-b-db-lock-waits.log)."
} >"$EVID/tabela-tempos-locks.md"
echo "tabela consolidada: $EVID/tabela-tempos-locks.md"

if [ "$KEEP" = "1" ]; then
  {
    echo "PROJETO=$P_B"
    echo "COMPOSE=$COMPOSE"
    echo "ENV_FILE=$ENV_FILE"
    echo "FAT_N=$FAT_N"
    echo "PERF_N=$PERF_N"
    echo "SEEDS=$SEEDS"
  } >"$EVID/stack-mantido.txt"
  echo "stack RUN B mantido no ar: $P_B (derrube com: docker compose -f $COMPOSE -p $P_B --env-file $ENV_FILE down -v)"
fi

echo
if [ "$fails" = "0" ]; then
  echo "ENSAIO-MIGRATIONS-S10: OK — todos os checks passaram"
  exit 0
else
  echo "ENSAIO-MIGRATIONS-S10: $fails check(s) FALHARAM" >&2
  exit 1
fi

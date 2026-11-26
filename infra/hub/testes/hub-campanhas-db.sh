#!/usr/bin/env bash
# =============================================================================
# hub-campanhas-db.sh — feature campanhas-motorista, onda W1 (banco): prova EM BANCO da 0127.
# Stack EFEMERO (hub-test-*), aplica TODAS as migrations e exercita as RPCs como o PostgREST as
# chamaria (SET ROLE authenticated + claims). Stub nao ve gatilho: tudo aqui e Postgres de verdade.
# Nao toca producao.
#
# Cobre: (a) imutabilidade por gatilho · (b) RLS/escopo/privacidade do motorista · (c) calculo com
# cenario fixo (valores calculados a mao) · (d) fechamento automatico + vencedores + aviso ·
# (e) validacoes do §4 que vivem no banco · (g) hub_adiantamento_notificar apos a extracao ·
# (h) 0129: campanha tipo extrato (turno valido/invalido/pendente, categoria por nome e familia, E6, privacidade do app,
#     fechamento em fim+3, imutabilidade das colunas novas, idempotencia da 0129).
# ((f) = rodar os drivers de adiantamento/avisos existentes; ver o relatorio.)
#
# "Hoje" e fixado por CREATE OR REPLACE de hub_hoje_sp() NESTE stack efemero (percorre a semana).
#
# Controles negativos (so em stack de teste; o guarda anti-oco ABORTA se a reversao nao aplicou):
#   CAMP_NEG=trigger   -> DESLIGA os gatilhos de imutabilidade (prova (a): as secoes (a) devem FALHAR)
#   CAMP_NEG=desempate -> inverte o ultimo criterio de desempate (prova (c): Ana x Carla trocam)
#   CAMP_NEG=a1|a2|m1|m2 -> reverte A1 (data do carimbo), A2 (adiar CNPJ do dia), M1 (fechar so apos o dia), M2 (relido sob lock)
#   CAMP_NEG=anterior  -> remove a guarda de dados_ate (prova (c)/variacao: posicao_anterior zera no mesmo dado)
#   CAMP_NEG=extrato_fecha   -> (0129) extrato volta a fechar em fim+1 (prova: a secao de fechamento deve FALHAR)
#   CAMP_NEG=extrato_corte   -> (0129/M2) turnos voltam a ver faturamento pos-fechamento (prova: os checks M2 devem FALHAR)
#   CAMP_NEG=extrato_privado -> (0129) top10 do extrato vaza campo de valor (prova: a secao de privacidade deve FALHAR)
#   CAMP_NEG=tempo_leitura -> (0130) tempo sem leitura volta a valer 100% (prova: os checks 0130 (a)/(b) devem FALHAR)
#   CAMP_NEG=familias  -> (0131) familias() sem indicador (prova: os checks 0131/campanha de familia:indicador devem FALHAR)
#   CAMP_NEG=descarte  -> (0133/D2) predicado de descarte de turno curto zerado SEMPRE falso (prova: os checks de descarte devem FALHAR)
#   CAMP_NEG=semijoin  -> (0133/D1) semi-join de praca da nota e do extrato volta a upper(btrim(subpraca)) (prova: os checks de subpraca efetiva devem FALHAR)
#   CAMP_NEG=data_premio -> (0133/D5) gatilho de imutabilidade deixa de liberar data_premio (prova: alterar a data apos lancar deve FALHAR)
#   CAMP_NEG=escopo    -> remove a policy de escopo de "Campanha" (prova (b): a leitura direta vaza)
#   CAMP_NEG=excluir   -> (so na secao 0128) remove a checagem de lancada_em de hub_campanha_excluir E desliga o gatilho de DELETE
#                         (0128: sem os DOIS, a lancada nao e apagada; so a RPC sem o gatilho daria o mesmo token)
#
# CAMP_REUSE=<projeto compose ja no ar e migrado> reaproveita o stack (so para desenvolver o driver).
# Uso: infra/hub/testes/hub-campanhas-db.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)-$$"
PROJECT="${CAMP_REUSE:-hub-test-camp-$RUNID}"
TMP="$(mktemp -d)"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
cleanup() { [ -n "${CAMP_REUSE:-}" ] || dc down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

if [ -z "${CAMP_REUSE:-}" ]; then
  "$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou"; exit 1; }
  echo "subindo db efemero ($PROJECT)..."
  dc up -d --wait db
  "$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1 \
    || { echo "FAIL: migrate"; tail -30 "$TMP/migrate.log"; exit 1; }
  grep -q "0127_campanhas.sql" "$TMP/migrate.log" || { echo "FAIL: 0127 nao aplicada"; exit 1; }
fi

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
psql_relaxed() { dc exec -T db psql -U "$DB_USER" -d "$DB_NAME" "$@"; }

fails=0; passes=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; passes=$((passes + 1)); else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails + 1)); fi
}
# tok: primeiro token de erro de uma saida (ERROR:  TOKEN) ou nome da CHECK violada
tok() { printf '%s' "$1" | grep -oE 'ERROR:  [A-Z_]+$|violates check constraint "[a-z_]+"|permission denied[^"]*|violates row-level security' | head -1 | sed -e 's/^ERROR:  //' -e 's/^permission denied.*/permission denied/'; }
hoje() { psql_t -q -c "CREATE OR REPLACE FUNCTION hub_hoje_sp() RETURNS date LANGUAGE sql STABLE AS \$\$ SELECT '$1'::date \$\$;" >/dev/null; }

hora() { psql_t -q -c "CREATE OR REPLACE FUNCTION hub_hora_sp() RETURNS time LANGUAGE sql STABLE AS \$\$ SELECT '$1'::time \$\$;" >/dev/null; }
hora_real() { psql_t -q -c "CREATE OR REPLACE FUNCTION hub_hora_sp() RETURNS time LANGUAGE sql STABLE AS \$\$ SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::time \$\$;" >/dev/null; }

# rpc <email> <escopo-json> <empresa_ativa> <sql>  (commit; saida filtrada, erros incluidos)
rpc() {
  psql_relaxed -tA 2>&1 <<SQL | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | grep -v '^{"sub"' | grep -vE '^(DETAIL|CONTEXT|HINT|LINE|QUERY)|^PL/pgSQL|^SQL (statement|function)'
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub',(SELECT id FROM "Usuario" WHERE email='$1'),'empresa_ativa','$3','escopo','$2'::jsonb)::text, true);
SET ROLE authenticated;
$4
COMMIT;
SQL
}
# app <cnpj> <sql>: como o motorista (claim motorista_cnpj, sem escopo)
app() {
  psql_relaxed -tA 2>&1 <<SQL | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | grep -v '^{"sub"' | grep -vE '^(DETAIL|CONTEXT|HINT|LINE|QUERY)|^PL/pgSQL|^SQL (statement|function)'
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub','1','motorista_cnpj','$1')::text, true);
SET ROLE authenticated;
$2
COMMIT;
SQL
}
# worker <sql>: claim do push worker
worker() {
  psql_relaxed -tA 2>&1 <<SQL | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | grep -v '^{"hub_push' | grep -vE '^(DETAIL|CONTEXT|HINT|LINE|QUERY)|^PL/pgSQL|^SQL (statement|function)'
BEGIN;
SELECT set_config('request.jwt.claims', '{"hub_push_worker":true,"escopo":[]}', true);
SET ROLE authenticated;
$1
COMMIT;
SQL
}
own() { psql_t -tAc "$1"; }
ownx() { psql_relaxed -tA 2>&1 -c "$1" | grep -vE '^(DETAIL|CONTEXT|HINT|LINE|QUERY)|^PL/pgSQL|^SQL (statement|function)'; }

# --- controles negativos: reversao SO neste stack efemero, com guarda anti-oco ------------------
patch_fn() { # patch_fn <regprocedure> <sed-expr>
  psql_t -tA -c "SELECT pg_get_functiondef('$1'::regprocedure);" > "$TMP/fn.sql"
  cp "$TMP/fn.sql" "$TMP/fn.orig"
  sed -i "$2" "$TMP/fn.sql"
  cmp -s "$TMP/fn.orig" "$TMP/fn.sql" && { echo "ABORTA: patch_fn nao alterou $1 (controle negativo OCO)"; exit 1; }
  psql_t -q < "$TMP/fn.sql" >/dev/null
}
case "${CAMP_NEG:-}" in
  trigger)
    psql_t -q -c 'ALTER TABLE "Campanha" DISABLE TRIGGER trg_campanha_imutavel; ALTER TABLE "CampanhaPremio" DISABLE TRIGGER trg_campanhapremio_imutavel; ALTER TABLE "CampanhaVencedor" DISABLE TRIGGER trg_campanhavencedor_imutavel;'
    N="$(own "SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trg_campanha%' AND tgenabled = 'D'")"
    [ "$N" = "3" ] || { echo "ABORTA: gatilhos nao ficaram desligados ($N/3) — controle OCO"; exit 1; }
    echo "NEG trigger: 3 gatilhos DESLIGADOS (conferido em pg_trigger)";;
  desempate)
    patch_fn 'hub_campanha_recalcular_interno(integer)' 's/nt\.tempo DESC NULLS LAST, nt\.entregador_id ASC/nt.tempo DESC NULLS LAST, nt.entregador_id DESC/'
    own "SELECT pg_get_functiondef('hub_campanha_recalcular_interno(integer)'::regprocedure) ~ 'nt[.]entregador_id DESC[)]'" | grep -q t || { echo "ABORTA: reversao nao esta no corpo vivo"; exit 1; }
    echo "NEG desempate: corpo vivo agora desempata por entregador_id DESC (conferido)";;
  familias)
    patch_fn 'hub_adiantamento_familias()' "s/, 'familia:indicador'//"
    own "SELECT pg_get_functiondef('hub_adiantamento_familias()'::regprocedure) ~ 'indicador'" | grep -q f || { echo "ABORTA: reversao familias nao esta no corpo vivo — controle OCO"; exit 1; }
    echo "NEG familias: familias() volta a ter so promocao/missoes (conferido; os checks 0131/campanha de indicador devem FALHAR)";;
  a1)
    patch_fn 'hub_campanha_marcar_exportado(integer)' "s/v_dpg, false/v_hoje, false/"
    own "SELECT pg_get_functiondef('hub_campanha_marcar_exportado(integer)'::regprocedure) ~ 'v_hoje, false'" | grep -q t || { echo "ABORTA: reversao A1 nao esta no corpo vivo"; exit 1; }
    echo "NEG a1: data_pagamento agora = hoje (nao o dia do carimbo) (conferido)";;
  a2)
    patch_fn 'hub_campanha_marcar_exportado(integer)' 's/IF v_conflito THEN/IF false THEN/'
    own "SELECT pg_get_functiondef('hub_campanha_marcar_exportado(integer)'::regprocedure) ~ 'IF false THEN'" | grep -q t || { echo "ABORTA: reversao A2 nao esta no corpo vivo"; exit 1; }
    echo "NEG a2: checagem de CNPJ ja exportado no dia REMOVIDA (conferido)";;
  m1)
    patch_fn 'hub_campanhas_recalcular_ativas(integer)' 's/IF v_max >= r.data_fim AND hub_hoje_sp() > r.data_fim THEN/IF v_max >= r.data_fim THEN/'
    own "SELECT pg_get_functiondef('hub_campanhas_recalcular_ativas(integer)'::regprocedure) ~ 'hub_hoje_sp[(][)] > r.data_fim'" | grep -q t && { echo "ABORTA: a guarda M1 ainda esta no corpo vivo"; exit 1; }
    echo "NEG m1: fechamento volta a depender so de max(data_periodo) >= data_fim (conferido)";;
  m2)
    patch_fn 'hub_campanha_recalcular_interno(integer)' 's/IF v_c.cancelada_em IS NOT NULL OR v_c.fechada_em IS NOT NULL OR v_c.lancada_em IS NULL THEN/IF false THEN/'
    patch_fn 'hub_campanha_fechar_interno(integer)' 's/IF NOT FOUND OR c.fechada_em IS NOT NULL OR c.cancelada_em IS NOT NULL OR c.lancada_em IS NULL THEN RETURN; END IF;/IF NOT FOUND THEN RETURN; END IF;/'
    own "SELECT (pg_get_functiondef('hub_campanha_recalcular_interno(integer)'::regprocedure) ~ 'IF false THEN') AND NOT (pg_get_functiondef('hub_campanha_fechar_interno(integer)'::regprocedure) ~ 'cancelada_em IS NOT NULL')" | grep -q t || { echo "ABORTA: reversao M2 nao esta nos corpos vivos"; exit 1; }
    echo "NEG m2: guardas de cancelada/fechada removidas de recalcular_interno e fechar_interno (conferido)";;
  anterior)
    patch_fn 'hub_campanha_recalcular_interno(integer)' 's/CASE WHEN v_mesmo THEN r\.posicao_anterior ELSE r\.posicao END/r.posicao/'
    own "SELECT pg_get_functiondef('hub_campanha_recalcular_interno(integer)'::regprocedure) ~ 'v_mesmo THEN r[.]posicao_anterior'" | grep -q t && { echo "ABORTA: a guarda ainda esta no corpo vivo"; exit 1; }
    echo "NEG anterior: guarda 'v_mesmo' removida do corpo vivo (conferido)";;
  extrato_fecha)
    patch_fn 'hub_campanhas_recalcular_ativas(integer)' 's/::int \* 2 THEN/::int * 0 THEN/'
    own "SELECT pg_get_functiondef('hub_campanhas_recalcular_ativas(integer)'::regprocedure) ~ '::int [*] 0 THEN'" | grep -q t || { echo "ABORTA: reversao extrato_fecha nao esta no corpo vivo"; exit 1; }
    echo "NEG extrato_fecha: extrato volta a fechar em fim+1 (conferido)";;
  extrato_corte)
    patch_fn 'hub_campanha_creditos_turno(integer,date,date,integer,text[],timestamp with time zone)' 's/(v_corte IS NULL OR f\.criado_em <= v_corte)/true/'
    own "SELECT pg_get_functiondef('hub_campanha_creditos_turno(integer,date,date,integer,text[],timestamp with time zone)'::regprocedure) !~ 'v_corte IS NULL'" | grep -q t || { echo "ABORTA: reversao extrato_corte nao esta no corpo vivo"; exit 1; }
    echo "NEG extrato_corte: lista de turnos volta a ver faturamento posterior ao fechamento (conferido)";;
  extrato_privado)
    patch_fn 'hub_motorista_campanha(integer)' "s/'nomeAbreviado', hub_nome_abreviado(t.nome)/'nomeAbreviado', hub_nome_abreviado(t.nome), 'valorCentavos', t.posicao/"
    own "SELECT pg_get_functiondef('hub_motorista_campanha(integer)'::regprocedure) ~ 'valorCentavos., t.posicao'" | grep -q t || { echo "ABORTA: reversao extrato_privado nao esta no corpo vivo"; exit 1; }
    echo "NEG extrato_privado: top10 do extrato agora vaza um campo de valor (conferido)";;
  descarte)
    patch_fn 'hub_campanha_turno_descartado(double precision,bigint,bigint,bigint,bigint,integer)' 's/p_min > 0 AND/false AND/'
    own "SELECT pg_get_functiondef('hub_campanha_turno_descartado(double precision,bigint,bigint,bigint,bigint,integer)'::regprocedure) !~ 'p_min > 0'" | grep -q t || { echo "ABORTA: reversao descarte nao esta no corpo vivo — controle OCO"; exit 1; }
    echo "NEG descarte: predicado de descarte agora SEMPRE falso (conferido no corpo vivo)";;
  semijoin)
    patch_fn 'hub_campanha_recalcular_interno(integer)' 's/upper(hub_subpraca_efetiva(pt\.subpraca, pt\.origem))/upper(btrim(pt.subpraca))/'
    patch_fn 'hub_campanha_turnos_extrato_q(integer,date,date,integer,text[],text[],text[],text[],numeric,numeric,numeric,integer,timestamp with time zone,integer)' 's/upper(hub_subpraca_efetiva(pt\.subpraca, pt\.origem))/upper(btrim(pt.subpraca))/'
    own "SELECT NOT (pg_get_functiondef('hub_campanha_recalcular_interno(integer)'::regprocedure) ~ 'hub_subpraca_efetiva') AND NOT (pg_get_functiondef('hub_campanha_turnos_extrato_q(integer,date,date,integer,text[],text[],text[],text[],numeric,numeric,numeric,integer,timestamp with time zone,integer)'::regprocedure) ~ 'hub_subpraca_efetiva')" | grep -q t || { echo "ABORTA: reversao semijoin nao esta nos corpos vivos — controle OCO"; exit 1; }
    echo "NEG semijoin: semi-join da nota e do extrato sem hub_subpraca_efetiva (conferido nos corpos vivos)";;
  data_premio)
    patch_fn 'hub_campanha_imutavel_trg()' "s/'data_premio'\];/'visivel_app'];/"
    own "SELECT pg_get_functiondef('hub_campanha_imutavel_trg()'::regprocedure) !~ '''data_premio'''" | grep -q t || { echo "ABORTA: reversao data_premio nao esta no corpo vivo — controle OCO"; exit 1; }
    echo "NEG data_premio: gatilho de imutabilidade sem 'data_premio' em v_livres (conferido no corpo vivo)";;
  tempo_leitura) : ;;  # aplicado na secao 0130 (a 0129 e reaplicada antes dela e desfaria a reversao)
  escopo)
    psql_t -q -c 'DROP POLICY campanha_select_por_escopo ON "Campanha"; CREATE POLICY campanha_select_por_escopo ON "Campanha" FOR SELECT USING (true);'
    own "SELECT count(*) FROM pg_policies WHERE policyname='campanha_select_por_escopo' AND qual='true'" | grep -q 1 || { echo "ABORTA: policy nao revertida"; exit 1; }
    echo "NEG escopo: policy de Campanha agora USING (true) (conferido)";;
esac

neg_excluir() { # aplicado so na secao 0128 (no inicio ele quebraria o cenario inteiro das secoes anteriores)
  patch_fn 'hub_campanha_excluir(integer)' 's/IF c\.lancada_em IS NOT NULL THEN/IF false THEN/'
  psql_t -q -c 'ALTER TABLE "Campanha" DISABLE TRIGGER trg_campanha_imutavel;'
  own "SELECT (pg_get_functiondef('hub_campanha_excluir(integer)'::regprocedure) ~ 'IF false THEN') AND (SELECT tgenabled = 'D' FROM pg_trigger WHERE tgname = 'trg_campanha_imutavel')" | grep -q t || { echo "ABORTA: reversao excluir nao esta no corpo vivo/gatilho — controle OCO"; exit 1; }
  echo "NEG excluir: RPC sem a checagem de lancada_em e gatilho de imutabilidade DESLIGADO (conferido)"
}

# ============================ fixtures SINTETICAS ============================
# Empresas: 9001 (cenario), 9002 (outro tenant), 9003 (sem cobertura de pedidos), 9004 (teto).
psql_t -q <<'SQL' >"$TMP/seed.log" 2>&1 || { echo "FAIL: seed"; cat "$TMP/seed.log"; exit 1; }
INSERT INTO "Usuario" (email, senha_hash, nome) VALUES
  ('adm@example.com','x','Adm 9001'),('fin@example.com','x','Fin 9001'),('op@example.com','x','Op 9001'),
  ('admb@example.com','x','Adm 9002'),('adm3@example.com','x','Adm 9003'),('adm4@example.com','x','Adm 9004');
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ((SELECT id FROM "Usuario" WHERE email='adm@example.com'), 9001, (SELECT id FROM "Papel" WHERE nome='admin_entidade'), true),
  ((SELECT id FROM "Usuario" WHERE email='fin@example.com'), 9001, (SELECT id FROM "Papel" WHERE nome='financeiro'), true),
  ((SELECT id FROM "Usuario" WHERE email='op@example.com'),  9001, (SELECT id FROM "Papel" WHERE nome='operador'), true),
  ((SELECT id FROM "Usuario" WHERE email='admb@example.com'), 9002, (SELECT id FROM "Papel" WHERE nome='admin_entidade'), true),
  ((SELECT id FROM "Usuario" WHERE email='adm3@example.com'), 9003, (SELECT id FROM "Papel" WHERE nome='admin_entidade'), true),
  ((SELECT id FROM "Usuario" WHERE email='adm4@example.com'), 9004, (SELECT id FROM "Papel" WHERE nome='admin_entidade'), true);
INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo)
  SELECT m.id, e, true FROM "Modulo" m, (VALUES (9001),(9002),(9003),(9004)) v(e) WHERE m.codigo = 'campanhas';

CREATE TEMP TABLE spec (k int, nome text, modal text, praca text, n int, o int, a int, c int, p int, t numeric, cnpj text);
INSERT INTO spec VALUES
 (1,'Ana Lima',     '  moto ', 'SAO PAULO', 5, 10,  9,  9,  8, 3.6, '90000000000001'),
 (2,'Bruno Souza',  'MOTO',    'SAO PAULO', 5, 10, 10,  9, 10, 3.2, '90000000000002'),
 (3,'Carla Dias',   'MOTO',    'CAMPINAS',  4, 10,  9,  9, 10, 3.6, '90000000000003'),
 (4,'Diego Pires',  'MOTO',    'SAO PAULO', 5, 10,  7,  7,  5, 3.6, '90000000000004'),
 (5,'Eva Costa',    'MOTO',    'SAO PAULO', 2, 10,  9,  9,  8, 3.6, '90000000000005'),
 (6,'Fabio Nunes',  NULL,      'SAO PAULO', 5, 10,  9,  9,  8, 3.6, '90000000000006'),
 (7,'Gil Rocha',    'CARRO',   'SAO PAULO', 5, 10,  9,  9,  8, 3.6, '90000000000007'),
 (9,'Iara Melo',    'MOTO',    'SAO PAULO', 5,100, 79, 79, 10, 3.8, '90000000000009');
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) SELECT cnpj, nome FROM spec;
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('90000000000101','Zeca Brito'),('90000000000103','Zed Sem Pedidos');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id, dados_entrego_json)
  SELECT 9001, gen_random_uuid(), s.nome, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador = s.cnpj),
         CASE WHEN s.modal IS NULL THEN NULL ELSE jsonb_build_object('informacoesEntrega', jsonb_build_object('modal', s.modal)) END
  FROM spec s ORDER BY s.k;
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id, dados_entrego_json) VALUES
  (9002, gen_random_uuid(), 'Zeca Brito', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='90000000000101'), '{"informacoesEntrega":{"modal":"MOTO"}}'),
  (9003, gen_random_uuid(), 'Zed Sem Pedidos', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='90000000000103'), '{"informacoesEntrega":{"modal":"MOTO"}}');

INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES (9001,'performance',repeat('a',64),'completed'),(9002,'performance',repeat('b',64),'completed'),(9003,'performance',repeat('c',64),'completed');

-- janela da campanha: 2026-12-01 a (01 + n - 1); historico 24..26/11 para todos (alimenta as opcoes)
INSERT INTO "PerformanceTurno" (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca,
       corridas_ofertadas, corridas_aceitas, corridas_completadas, pedidos_concluidos, tempo_disponivel, hash_linha)
SELECT 9001, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('a',64)), e.id, d.d, 'JANTAR 18H-22H', interval '4 hours', s.praca,
       s.o, s.a, s.c, s.p, make_interval(secs => (s.t * 3600)::float8), md5(e.id::text||d.d::text||'j')||md5(d.d::text||e.id::text)
FROM spec s JOIN "Entregador" e ON e.nome = s.nome AND e.id_empresa = 9001
CROSS JOIN LATERAL (SELECT ('2026-12-01'::date + g) AS d FROM generate_series(0, s.n - 1) g
                    UNION ALL SELECT ('2026-11-24'::date + g) FROM generate_series(0, 2) g) d;
-- turno de ALMOCO so do Bruno (campanha A3 de filtro por turno): 01 e 02/12
INSERT INTO "PerformanceTurno" (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca,
       corridas_ofertadas, corridas_aceitas, corridas_completadas, pedidos_concluidos, tempo_disponivel, hash_linha)
SELECT 9001, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('a',64)), e.id, d::date, 'ALMOCO 11H-14H', interval '3 hours', 'SAO PAULO',
       10, 5, 5, 3, interval '2 hours', md5(e.id::text||d::text||'a')||md5(d::text||e.id::text||'a')
FROM "Entregador" e CROSS JOIN generate_series('2026-12-01'::date,'2026-12-02'::date,'1 day') d WHERE e.nome='Bruno Souza';
-- empresa 9002 (outro tenant) e 9003 (pedidos NULOS: cobertura 0)
INSERT INTO "PerformanceTurno" (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca,
       corridas_ofertadas, corridas_aceitas, corridas_completadas, pedidos_concluidos, tempo_disponivel, hash_linha)
SELECT 9002, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('b',64)), e.id, d::date, 'JANTAR 18H-22H', interval '4 hours', 'RECIFE',
       10, 9, 9, 5, interval '3 hours', md5(e.id::text||d::text)||md5(d::text||e.id::text)
FROM "Entregador" e CROSS JOIN generate_series('2026-11-24'::date,'2026-12-03'::date,'1 day') d WHERE e.nome='Zeca Brito';
INSERT INTO "PerformanceTurno" (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca,
       corridas_ofertadas, corridas_aceitas, corridas_completadas, pedidos_concluidos, tempo_disponivel, hash_linha)
SELECT 9003, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('c',64)), e.id, d::date, 'JANTAR 18H-22H', interval '4 hours', 'NATAL',
       10, 9, 9, NULL, interval '3 hours', md5(e.id::text||d::text)||md5(d::text||e.id::text)
FROM "Entregador" e CROSS JOIN generate_series('2026-11-24'::date,'2026-11-28'::date,'1 day') d WHERE e.nome='Zed Sem Pedidos';
REFRESH MATERIALIZED VIEW mv_performance_dia;
SQL

AID() { own "SELECT id FROM \"Usuario\" WHERE email='$1'"; }
EID() { own "SELECT id FROM \"Entregador\" WHERE nome='$1'"; }
PREMIOS_PADRAO='[{"posicaoDe":1,"posicaoAte":1,"tipo":"objeto","descricao":"Bag","valorCentavos":null},{"posicaoDe":2,"posicaoAte":3,"tipo":"dinheiro","descricao":"R$ 100","valorCentavos":10000}]'
body() { # body <nome> <ini> <fim> <pracas-json> <turnos-json> <modais-json> <min> <pa> <pc> <pt> <pp> <cortes-json> [premios-json]
  local pr="${13:-$PREMIOS_PADRAO}"
  printf '{"nome":"%s","descricao":"d","dataInicio":"%s","dataFim":"%s","pracas":%s,"turnos":%s,"modais":%s,"minTurnos":%s,"pesos":{"aceitacao":%s,"conclusao":%s,"tempo":%s,"pedidos":%s},"cortes":%s,"premios":%s,"avisar":true,"visivelApp":true}' \
    "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8" "$9" "${10}" "${11}" "${12}" "$pr"
}
NOCUT='{"aceitacao":null,"conclusao":null,"tempo":null,"pedidos":null}'
salvar() { rpc "$1" "$2" "$3" "SELECT hub_campanha_salvar($3, ${4:-NULL}, '$5'::jsonb);"; }   # salvar <email> <escopo> <emp> <id|NULL> <json>
ADM='adm@example.com'; E9001='[9001]'
PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

# ================================ funcoes puras =================================
check "hub_nome_abreviado: 3 tokens"  "$(own "SELECT hub_nome_abreviado('Juliana Pereira Lima')")" "Juliana L."
check "hub_nome_abreviado: 1 token"   "$(own "SELECT hub_nome_abreviado('Marcos')")" "Marcos"
check "hub_nome_abreviado: NULL"      "$(own "SELECT hub_nome_abreviado(NULL)")" "Motorista"
check "hub_nome_abreviado: so espacos" "$(own "SELECT hub_nome_abreviado('   ')")" "Motorista"
check "hub_nome_abreviado: espacos duplos/bordas" "$(own "SELECT hub_nome_abreviado('  Ana   Maria  silva ')")" "Ana S."
check "hub_hoje_sp = data de Sao Paulo" "$(own "SELECT hub_hoje_sp() = (now() AT TIME ZONE 'America/Sao_Paulo')::date")" "t"

# =========================== P0: hoje = 2026-11-30 ==============================
hoje 2026-11-30
BA="$(body 'Rei do Jantar' 2026-12-01 2026-12-07 null '["jantar 18h-22h"]' '["moto"]' 3 30 30 20 20 '{"aceitacao":0.8,"conclusao":null,"tempo":null,"pedidos":null}')"

echo "--- (e) validacoes do §4 ---"
check "e: salvar por quem nao tem permissao (operador) -> PERMISSAO_NEGADA" "$(tok "$(salvar op@example.com $E9001 9001 NULL "$BA")")" "PERMISSAO_NEGADA"
check "b: salvar na empresa 9002 com escopo so [9001] -> FORA_DE_ESCOPO" "$(tok "$(salvar $ADM $E9001 9002 NULL "$BA")")" "FORA_DE_ESCOPO"
check "e: soma dos pesos 90 -> PESOS_INVALIDOS" "$(tok "$(salvar $ADM $E9001 9001 NULL "$(body X1x 2026-12-01 2026-12-07 null null null 3 30 30 20 10 "$NOCUT")")")" "PESOS_INVALIDOS"
check "e: peso 150 -> PESOS_INVALIDOS" "$(tok "$(salvar $ADM $E9001 9001 NULL "$(body X1x 2026-12-01 2026-12-07 null null null 3 150 0 0 0 "$NOCUT")")")" "PESOS_INVALIDOS"
check "e: corte em indicador de peso 0 -> CORTE_SEM_PESO" "$(tok "$(salvar $ADM $E9001 9001 NULL "$(body X1x 2026-12-01 2026-12-07 null null null 3 100 0 0 0 '{"aceitacao":null,"conclusao":0.5,"tempo":null,"pedidos":null}')")")" "CORTE_SEM_PESO"
check "e: faixas sobrepostas (1-2 e 2-3) -> FAIXAS_SOBREPOSTAS" "$(tok "$(salvar $ADM $E9001 9001 NULL "$(body X1x 2026-12-01 2026-12-07 null null null 3 100 0 0 0 "$NOCUT" '[{"posicaoDe":1,"posicaoAte":2,"tipo":"objeto","descricao":"a"},{"posicaoDe":2,"posicaoAte":3,"tipo":"objeto","descricao":"b"}]')")")" "FAIXAS_SOBREPOSTAS"
check "e: faixas identicas -> FAIXAS_SOBREPOSTAS" "$(tok "$(salvar $ADM $E9001 9001 NULL "$(body X1x 2026-12-01 2026-12-07 null null null 3 100 0 0 0 "$NOCUT" '[{"posicaoDe":1,"posicaoAte":1,"tipo":"objeto","descricao":"a"},{"posicaoDe":1,"posicaoAte":1,"tipo":"objeto","descricao":"b"}]')")")" "FAIXAS_SOBREPOSTAS"
check "e: nome curto -> VALIDACAO" "$(tok "$(salvar $ADM $E9001 9001 NULL "$(body Ab 2026-12-01 2026-12-07 null null null 3 100 0 0 0 "$NOCUT")")")" "VALIDACAO"
check "e: duracao de 93 dias -> VALIDACAO" "$(tok "$(salvar $ADM $E9001 9001 NULL "$(body X1x 2026-12-01 2027-03-03 null null null 3 100 0 0 0 "$NOCUT")")")" "VALIDACAO"
check "e: duracao de 92 dias passa" "$(salvar $ADM $E9001 9001 NULL "$(body Dur92 2026-12-01 2027-03-02 null null null 3 100 0 0 0 "$NOCUT")" | grep -cE '^[0-9]+$')" "1"
check "e: dinheiro sem valor -> VALIDACAO" "$(tok "$(salvar $ADM $E9001 9001 NULL "$(body X1x 2026-12-01 2026-12-07 null null null 3 100 0 0 0 "$NOCUT" '[{"posicaoDe":1,"posicaoAte":1,"tipo":"dinheiro","descricao":"a"}]')")")" "VALIDACAO"
check "e: dinheiro acima do teto (500001) -> VALIDACAO" "$(tok "$(salvar $ADM $E9001 9001 NULL "$(body X1x 2026-12-01 2026-12-07 null null null 3 100 0 0 0 "$NOCUT" '[{"posicaoDe":1,"posicaoAte":1,"tipo":"dinheiro","descricao":"a","valorCentavos":500001}]')")")" "VALIDACAO"
check "e: min_turnos 0 -> VALIDACAO" "$(tok "$(salvar $ADM $E9001 9001 NULL "$(body X1x 2026-12-01 2026-12-07 null null null 0 100 0 0 0 "$NOCUT")")")" "VALIDACAO"
check "e: lista de 51 itens -> VALIDACAO" "$(tok "$(salvar $ADM $E9001 9001 NULL "$(body X1x 2026-12-01 2026-12-07 "$(seq 1 51 | jq -Rn '[inputs]' -c)" null null 3 100 0 0 0 "$NOCUT")")")" "VALIDACAO"
check "e: sem premio -> VALIDACAO" "$(tok "$(salvar $ADM $E9001 9001 NULL "$(body X1x 2026-12-01 2026-12-07 null null null 3 100 0 0 0 "$NOCUT" '[]')")")" "VALIDACAO"
# CHECKs da tabela (defesa em profundidade, como dono): o que a RPC barra, o banco tambem barra
check "e/db: CHECK soma dos pesos" "$(tok "$(ownx "INSERT INTO \"Campanha\"(id_empresa,nome,data_inicio,data_fim,min_turnos,peso_aceitacao,peso_conclusao,peso_tempo,peso_pedidos,criada_por) VALUES (9001,'abc','2026-12-01','2026-12-02',1,50,30,10,0,1)")")" 'violates check constraint "campanha_pesos_chk"'
check "e/db: CHECK duracao > 92 dias" "$(tok "$(ownx "INSERT INTO \"Campanha\"(id_empresa,nome,data_inicio,data_fim,min_turnos,peso_aceitacao,criada_por) VALUES (9001,'abc','2026-12-01','2027-03-03',1,100,1)")")" 'violates check constraint "campanha_datas_chk"'
check "e/db: CHECK lista nao canonica (minuscula)" "$(tok "$(ownx "INSERT INTO \"Campanha\"(id_empresa,nome,data_inicio,data_fim,min_turnos,peso_aceitacao,criada_por,pracas) VALUES (9001,'abc','2026-12-01','2026-12-02',1,100,1,ARRAY['sp'])")")" 'violates check constraint "campanha_pracas_chk"'
check "e/db: CHECK corte sem peso" "$(tok "$(ownx "INSERT INTO \"Campanha\"(id_empresa,nome,data_inicio,data_fim,min_turnos,peso_aceitacao,corte_tempo,criada_por) VALUES (9001,'abc','2026-12-01','2026-12-02',1,100,0.5,1)")")" 'violates check constraint "campanha_cortes_chk"'

echo "--- cria as campanhas do cenario ---"
ID_A="$(salvar $ADM $E9001 9001 NULL "$BA")"
check "salvar devolve id numerico" "$(printf '%s' "$ID_A" | grep -cE '^[0-9]+$')" "1"
check "listas canonizadas no banco (upper/btrim)" "$(own "SELECT turnos::text||modais::text FROM \"Campanha\" WHERE id=$ID_A")" '{"JANTAR 18H-22H"}{MOTO}'
ID_A2="$(salvar $ADM $E9001 9001 NULL "$(body 'Campinas Pro' 2026-12-01 2026-12-07 '["CAMPINAS"]' null null 2 100 0 0 0 "$NOCUT")")"
ID_A3="$(salvar $ADM $E9001 9001 NULL "$(body 'So Almoco' 2026-12-01 2026-12-07 null '["ALMOCO 11H-14H"]' null 1 100 0 0 0 "$NOCUT")")"
ID_F="$(salvar $ADM $E9001 9001 NULL "$(body 'Curta' 2026-12-01 2026-12-02 null null null 1 100 0 0 0 "$NOCUT")")"
ID_D="$(salvar $ADM $E9001 9001 NULL "$(body 'Com Foto' 2026-12-01 2026-12-07 null null null 1 100 0 0 0 "$NOCUT")")"
# G: 3 faixas de DINHEIRO (Ana vence A#2 e G#3 => A2 do relatorio: mesmo CNPJ, mesmo dia), com foto no 1o premio
ID_G="$(salvar $ADM $E9001 9001 NULL "$(body 'So Dinheiro' 2026-12-01 2026-12-07 null null null 1 100 0 0 0 "$NOCUT" '[{"posicaoDe":1,"posicaoAte":3,"tipo":"dinheiro","descricao":"R$ 100","valorCentavos":10000}]')")"
PID_G="$(own "SELECT id FROM \"CampanhaPremio\" WHERE campanha_id=$ID_G LIMIT 1")"
rpc $ADM $E9001 9001 "SELECT hub_campanha_premio_foto_salvar($ID_G,$PID_G,'image/png','$PNG');" >/dev/null
ID_B="$(salvar admb@example.com '[9002]' 9002 NULL "$(body 'Do Recife' 2026-12-01 2026-12-07 null null null 1 100 0 0 0 "$NOCUT")")"
check "situacao de rascunho" "$(own "SELECT hub_campanha_situacao(c) FROM \"Campanha\" c WHERE id=$ID_A")" "rascunho"
check "e: editar rascunho (PUT) passa" "$(salvar $ADM $E9001 9001 "$ID_A" "$BA" | grep -cE "^$ID_A\$")" "1"

echo "--- foto do premio (rascunho) ---"
PID_D="$(own "SELECT id FROM \"CampanhaPremio\" WHERE campanha_id=$ID_D ORDER BY id LIMIT 1")"
check "foto: texto que nao e imagem -> FOTO_INVALIDA" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_premio_foto_salvar($ID_D,$PID_D,'image/png','$(printf 'nao sou imagem' | base64)');")")" "FOTO_INVALIDA"
check "foto: mime declarado diferente dos bytes -> FOTO_INVALIDA" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_premio_foto_salvar($ID_D,$PID_D,'image/jpeg','$PNG');")")" "FOTO_INVALIDA"
check "foto: base64 invalido -> FOTO_INVALIDA" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_premio_foto_salvar($ID_D,$PID_D,'image/png','@@@');")")" "FOTO_INVALIDA"
check "foto: PNG valido grava" "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_premio_foto_salvar($ID_D,$PID_D,'image/png','$PNG');" | grep -c ERROR)" "0"
check "foto: gravada no banco (mime + bytes)" "$(own "SELECT foto_mime||':'||octet_length(foto) FROM \"CampanhaPremio\" WHERE id=$PID_D")" "image/png:70"
check "foto: ler pela RPC do hub devolve o mesmo base64" "$(rpc $ADM $E9001 9001 "SELECT mime||'|'||base64 FROM hub_campanha_premio_foto($ID_D,$PID_D);")" "image/png|$PNG"
check "B2: salvar foto com premio de OUTRA campanha (mesmo tenant) -> CAMPANHA_NAO_ENCONTRADA" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_premio_foto_salvar($ID_F,$PID_D,'image/png','$PNG');")")" "CAMPANHA_NAO_ENCONTRADA"
check "B2: ler foto com premio de OUTRA campanha -> CAMPANHA_NAO_ENCONTRADA" "$(tok "$(rpc $ADM $E9001 9001 "SELECT * FROM hub_campanha_premio_foto($ID_F,$PID_D);")")" "CAMPANHA_NAO_ENCONTRADA"
check "B2: premio de A com o id de campanha de OUTRO tenant -> CAMPANHA_NAO_ENCONTRADA" "$(tok "$(rpc admb@example.com '[9002]' 9002 "SELECT * FROM hub_campanha_premio_foto($ID_B,$PID_D);")")" "CAMPANHA_NAO_ENCONTRADA"
check "foto: PUT do rascunho preserva a foto (premio com id)" "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_salvar(9001,$ID_D,(SELECT jsonb_set('$(body 'Com Foto' 2026-12-01 2026-12-07 null null null 1 100 0 0 0 "$NOCUT" '[]')'::jsonb,'{premios}',jsonb_build_array(jsonb_build_object('id',$PID_D,'posicaoDe',1,'posicaoAte',1,'tipo','objeto','descricao','Bag nova','valorCentavos',null)))));" >/dev/null; own "SELECT descricao||':'||(foto IS NOT NULL) FROM \"CampanhaPremio\" WHERE id=$PID_D")" "Bag nova:true"

echo "--- (e) lancar: inicio no passado, opcao desconhecida, cobertura de pedidos ---"
ID_P="$(salvar $ADM $E9001 9001 NULL "$(body 'No Passado' 2026-11-20 2026-11-29 null null null 1 100 0 0 0 "$NOCUT")")"
check "e/0133: data_fim < hoje -> FIM_NO_PASSADO (o inicio no passado, com fim futuro, passou a ser permitido: secao 0133)" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_lancar($ID_P);")")" "FIM_NO_PASSADO"
PID_P="$(own "SELECT min(id) FROM \"CampanhaPremio\" WHERE campanha_id=$ID_P")"
check "B6: id de premio repetido no corpo -> VALIDACAO" "$(tok "$(salvar $ADM $E9001 9001 "$ID_P" "$(body 'No Passado' 2026-11-20 2026-11-29 null null null 1 100 0 0 0 "$NOCUT" "[{\"id\":$PID_P,\"posicaoDe\":1,\"posicaoAte\":1,\"tipo\":\"objeto\",\"descricao\":\"a\"},{\"id\":$PID_P,\"posicaoDe\":2,\"posicaoAte\":2,\"tipo\":\"objeto\",\"descricao\":\"b\"}]")")")" "VALIDACAO"
ID_O="$(salvar $ADM $E9001 9001 NULL "$(body 'Praca Fantasma' 2026-12-01 2026-12-07 '["NAOEXISTE"]' null null 1 100 0 0 0 "$NOCUT")")"
check "e: praca fora das opcoes -> OPCAO_DESCONHECIDA" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_lancar($ID_O);")")" "OPCAO_DESCONHECIDA"
ID_P3="$(salvar adm3@example.com '[9003]' 9003 NULL "$(body 'Sem Cobertura' 2026-12-01 2026-12-07 null null null 1 80 0 0 20 "$NOCUT")")"
check "e: peso_pedidos > 0 sem cobertura -> PEDIDOS_SEM_COBERTURA" "$(tok "$(rpc adm3@example.com '[9003]' 9003 "SELECT hub_campanha_lancar($ID_P3);")")" "PEDIDOS_SEM_COBERTURA"
check "e: cobertura medida pelas opcoes = 0.0000 na 9003" "$(rpc adm3@example.com '[9003]' 9003 "SELECT hub_campanha_opcoes(9003,NULL,NULL,NULL)->>'cobertura_pedidos';")" "0.0000"
check "e: cobertura 1.0000 na 9001 (praca/turno/modal informados em minuscula)" "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_opcoes(9001,ARRAY['sao paulo'],ARRAY['jantar 18h-22h'],ARRAY['moto'])->>'cobertura_pedidos';")" "1.0000"
check "opcoes: pracas distintas canonicas" "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_opcoes(9001,NULL,NULL,NULL)->'pracas';")" '["CAMPINAS", "SAO PAULO"]'
check "opcoes: modais distintos canonicos (inclui '  moto ' => MOTO)" "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_opcoes(9001,NULL,NULL,NULL)->'modais';")" '["CARRO", "MOTO"]'
check "B3: alcance SEM filtro de modal: 8 rodaram, 1 sem modal" "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_opcoes(9001,NULL,NULL,NULL)->'alcance';" | jq -c '[.rodaram,.sem_modal]')" "[8,1]"
check "B3: alcance COM modal MOTO: rodaram respeita o filtro (6), sem_modal continua 1" "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_opcoes(9001,NULL,NULL,ARRAY['moto'])->'alcance';" | jq -c '[.rodaram,.sem_modal]')" "[6,1]"
ID_P3b="$(salvar adm3@example.com '[9003]' 9003 NULL "$(body 'Sem Pedidos' 2026-12-01 2026-12-07 null null null 1 100 0 0 0 "$NOCUT")")"
check "e: peso_pedidos = 0 lanca mesmo sem cobertura" "$(rpc adm3@example.com '[9003]' 9003 "SELECT hub_campanha_lancar($ID_P3b);" | grep -c ERROR)" "0"
check "e: faixas sobrepostas inseridas direto no rascunho -> lancar recusa (revalida)" "$(ownx "INSERT INTO \"CampanhaPremio\"(campanha_id,id_empresa,posicao_de,posicao_ate,tipo,descricao) VALUES ($ID_O,9001,1,3,'objeto','x'),($ID_O,9001,3,4,'objeto','y')" >/dev/null; tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_lancar($ID_O);")")" "FAIXAS_SOBREPOSTAS"
check "e: confirmacao ausente nao e do banco (RPC lancar nao tem 'confirmo')" "$(own "SELECT count(*) FROM pg_proc WHERE proname='hub_campanha_lancar' AND pronargs=1")" "1"

echo "--- lancar o cenario ---"
for i in $ID_A $ID_A2 $ID_A3 $ID_F $ID_D $ID_G; do
  R="$(rpc $ADM $E9001 9001 "SELECT hub_campanha_lancar($i);")"
  check "lancar campanha $i" "$(tok "$R")" ""
done
check "lancar Recife (9002)" "$(tok "$(rpc admb@example.com '[9002]' 9002 "SELECT hub_campanha_lancar($ID_B);")")" ""
check "lancar de novo -> CAMPANHA_SITUACAO_INVALIDA" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_lancar($ID_A);")")" "CAMPANHA_SITUACAO_INVALIDA"
check "situacao agendada (hoje 30/11, inicio 01/12)" "$(own "SELECT hub_campanha_situacao(c) FROM \"Campanha\" c WHERE id=$ID_A")" "agendada"

echo "--- (a) imutabilidade (o gatilho, como dono do banco) ---"
check "a: UPDATE de nome apos lancar -> CAMPANHA_IMUTAVEL" "$(tok "$(ownx "UPDATE \"Campanha\" SET nome='Outro nome' WHERE id=$ID_A")")" "CAMPANHA_IMUTAVEL"
check "a: UPDATE de peso apos lancar -> CAMPANHA_IMUTAVEL" "$(tok "$(ownx "UPDATE \"Campanha\" SET peso_aceitacao=40, peso_pedidos=10 WHERE id=$ID_A")")" "CAMPANHA_IMUTAVEL"
check "a: UPDATE de data_fim -> CAMPANHA_IMUTAVEL" "$(tok "$(ownx "UPDATE \"Campanha\" SET data_fim=data_fim+1 WHERE id=$ID_A")")" "CAMPANHA_IMUTAVEL"
check "a: UPDATE de modais (filtro) -> CAMPANHA_IMUTAVEL" "$(tok "$(ownx "UPDATE \"Campanha\" SET modais=NULL WHERE id=$ID_A")")" "CAMPANHA_IMUTAVEL"
check "a: UPDATE de lancada_em (reabrir) -> CAMPANHA_IMUTAVEL" "$(tok "$(ownx "UPDATE \"Campanha\" SET lancada_em=NULL WHERE id=$ID_A")")" "CAMPANHA_IMUTAVEL"
check "a: DELETE da campanha lancada -> CAMPANHA_IMUTAVEL" "$(tok "$(ownx "DELETE FROM \"Campanha\" WHERE id=$ID_A")")" "CAMPANHA_IMUTAVEL"
check "a: UPDATE de premio -> CAMPANHA_IMUTAVEL" "$(tok "$(ownx "UPDATE \"CampanhaPremio\" SET descricao='Roubado' WHERE campanha_id=$ID_A")")" "CAMPANHA_IMUTAVEL"
check "a: DELETE de premio -> CAMPANHA_IMUTAVEL" "$(tok "$(ownx "DELETE FROM \"CampanhaPremio\" WHERE campanha_id=$ID_A")")" "CAMPANHA_IMUTAVEL"
check "a: INSERT de premio novo -> CAMPANHA_IMUTAVEL" "$(tok "$(ownx "INSERT INTO \"CampanhaPremio\"(campanha_id,id_empresa,posicao_de,posicao_ate,tipo,descricao) VALUES ($ID_A,9001,10,10,'objeto','x')")")" "CAMPANHA_IMUTAVEL"
check "B6/a: MOVER premio de campanha lancada para um rascunho -> CAMPANHA_IMUTAVEL (gatilho olha OLD.campanha_id)" "$(tok "$(ownx "UPDATE \"CampanhaPremio\" SET campanha_id=$ID_P WHERE campanha_id=$ID_A")")" "CAMPANHA_IMUTAVEL"
check "a: foto de premio apos lancar -> CAMPANHA_IMUTAVEL" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_premio_foto_salvar($ID_D,$PID_D,'image/png','$PNG');")")" "CAMPANHA_IMUTAVEL"
check "a: salvar (PUT) apos lancar -> CAMPANHA_IMUTAVEL" "$(tok "$(salvar $ADM $E9001 9001 "$ID_A" "$BA")")" "CAMPANHA_IMUTAVEL"
check "a: nome continua o original no banco" "$(own "SELECT nome FROM \"Campanha\" WHERE id=$ID_A")" "Rei do Jantar"
check "a: campos livres passam (dados_ate, aviso_inicio_em)" "$(ownx "UPDATE \"Campanha\" SET dados_ate='2026-11-20', aviso_inicio_em=NULL WHERE id=$ID_A" | grep -c ERROR)" "0"

echo "--- (b) escopo/RLS/permissao ---"
check "b: outra entidade (admb) nao ve o detalhe -> CAMPANHA_NAO_ENCONTRADA (nao vaza existencia)" "$(tok "$(rpc admb@example.com '[9002]' 9002 "SELECT hub_campanha_detalhe($ID_A);")")" "CAMPANHA_NAO_ENCONTRADA"
check "b: nem o ranking" "$(tok "$(rpc admb@example.com '[9002]' 9002 "SELECT * FROM hub_campanha_ranking($ID_A,NULL,50,0);")")" "CAMPANHA_NAO_ENCONTRADA"
check "b: nem cancelar a campanha alheia" "$(tok "$(rpc admb@example.com '[9002]' 9002 "SELECT hub_campanha_cancelar($ID_A,'tentando cancelar');")")" "CAMPANHA_NAO_ENCONTRADA"
check "b: nem editar (salvar com id alheio)" "$(tok "$(salvar admb@example.com '[9002]' 9002 "$ID_A" "$BA")")" "CAMPANHA_NAO_ENCONTRADA"
check "b: nem a foto" "$(rpc admb@example.com '[9002]' 9002 "SELECT count(*) FROM hub_campanha_premio_foto($ID_D,$PID_D);" 2>&1 | grep -oE 'CAMPANHA_NAO_ENCONTRADA|^0$')" "CAMPANHA_NAO_ENCONTRADA"
check "b: listar na empresa alheia -> FORA_DE_ESCOPO" "$(tok "$(rpc admb@example.com '[9002]' 9002 "SELECT * FROM hub_campanha_listar(9001,NULL);")")" "FORA_DE_ESCOPO"
check "b: a lista da propria empresa so traz as dela (admb: 1)" "$(rpc admb@example.com '[9002]' 9002 "SELECT count(*) FROM hub_campanha_listar(9002,NULL);")" "1"
check "b: escopo [9001,9002] mas empresa_ativa 9001 NAO opera a 9002 (permissao e da ativa)" "$(tok "$(rpc $ADM '[9001,9002]' 9001 "SELECT hub_campanha_salvar(9002,NULL,'$BA'::jsonb);")")" "FORA_DE_ESCOPO"
check "b: leitura DIRETA da tabela respeita RLS (admb ve 1 campanha: a dele)" "$(rpc admb@example.com '[9002]' 9002 "SELECT count(*) FROM \"Campanha\";")" "1"
check "b: leitura direta do ranking/vencedor/premio alheio = 0 linhas" "$(rpc admb@example.com '[9002]' 9002 "SELECT (SELECT count(*) FROM \"CampanhaRanking\")+(SELECT count(*) FROM \"CampanhaVencedor\")+(SELECT count(*) FROM \"CampanhaPremio\" WHERE campanha_id=$ID_A);")" "0"
check "b: ESCRITA direta recusada (sem GRANT) — UPDATE" "$(tok "$(rpc admb@example.com '[9002]' 9002 "UPDATE \"Campanha\" SET nome='hack' WHERE id=$ID_B;")")" "permission denied"
check "b: ESCRITA direta recusada — INSERT" "$(tok "$(rpc $ADM $E9001 9001 "INSERT INTO \"Campanha\"(id_empresa,nome,data_inicio,data_fim,min_turnos,peso_aceitacao,criada_por) VALUES (9001,'abc','2026-12-01','2026-12-02',1,100,1);")")" "permission denied"
check "b: ESCRITA direta recusada — DELETE" "$(tok "$(rpc $ADM $E9001 9001 "DELETE FROM \"CampanhaRanking\";")")" "permission denied"
check "b: coluna foto fora do GRANT (has_column_privilege, nao has_table_privilege)" "$(own "SELECT has_column_privilege('authenticated','\"CampanhaPremio\"','foto','SELECT')::text||has_column_privilege('authenticated','\"CampanhaPremio\"','descricao','SELECT')::text")" "falsetrue"
check "b: SELECT foto como authenticated -> permission denied" "$(tok "$(rpc $ADM $E9001 9001 "SELECT foto FROM \"CampanhaPremio\" LIMIT 1;")")" "permission denied"
check "b: SELECT * da tabela de premios tambem recusa (coluna foto)" "$(tok "$(rpc $ADM $E9001 9001 "SELECT * FROM \"CampanhaPremio\" LIMIT 1;")")" "permission denied"
check "b: motorista (claim sem escopo) le 0 linhas direto em Campanha" "$(app 90000000000001 'SELECT count(*) FROM "Campanha";')" "0"
check "b: operador sem permissao nao lista -> PERMISSAO_NEGADA" "$(tok "$(rpc op@example.com $E9001 9001 "SELECT * FROM hub_campanha_listar(9001,NULL);")")" "PERMISSAO_NEGADA"
check "b: financeiro consulta (papel recebeu as 3 permissoes)" "$(rpc fin@example.com $E9001 9001 "SELECT count(*) FROM hub_campanha_listar(9001,NULL);")" "9"
check "b: matriz: admin_entidade, admin_plataforma (0128), financeiro e financeiro_aprovador com as 3 permissoes" "$(own "SELECT string_agg(p.nome||'='||n, ',' ORDER BY p.nome) FROM (SELECT pa.nome, count(*) n FROM \"PapelPermissao\" pp JOIN \"Papel\" pa ON pa.id=pp.papel_id JOIN \"Permissao\" pe ON pe.id=pp.permissao_id WHERE pe.codigo LIKE 'campanhas.%' GROUP BY pa.nome) p")" "admin_entidade=3,admin_plataforma=3,financeiro=3,financeiro_aprovador=3"
check "b: modulo desligado na entidade nega (fail-closed)" "$(own "UPDATE \"ModuloEntidade\" SET ativo=false WHERE empresa_id=9002 AND modulo_id=(SELECT id FROM \"Modulo\" WHERE codigo='campanhas')" >/dev/null; tok "$(rpc admb@example.com '[9002]' 9002 "SELECT * FROM hub_campanha_listar(9002,NULL);")")" "PERMISSAO_NEGADA"
own "UPDATE \"ModuloEntidade\" SET ativo=true WHERE empresa_id=9002" >/dev/null
check "b: funcoes internas NAO executaveis por authenticated" "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_recalcular_interno($ID_A);" | grep -oE 'permission denied')" "permission denied"
check "b: hub_notificacao_enfileirar NAO executavel por authenticated" "$(rpc $ADM $E9001 9001 "SELECT hub_notificacao_enfileirar(9001,'individual',ARRAY[1],ARRAY['90000000000001'],'sistema','x','y',NULL);" | grep -oE 'permission denied')" "permission denied"
check "b: hub_campanhas_avisar_inicio sem claim do worker -> PERMISSAO_NEGADA" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanhas_avisar_inicio();")")" "PERMISSAO_NEGADA"
check "b: recalcular_ativas fora do escopo -> FORA_DE_ESCOPO" "$(tok "$(rpc admb@example.com '[9002]' 9002 "SELECT hub_campanhas_recalcular_ativas(9001);")")" "FORA_DE_ESCOPO"

echo "--- (e) teto de 10 campanhas ativas por entidade ---"
for n in 1 2 3 4 5 6 7 8 9 10 11; do
  I="$(salvar adm4@example.com '[9004]' 9004 NULL "$(body "Teto $n" 2026-12-01 2026-12-07 null null null 1 100 0 0 0 "$NOCUT")")"
  R="$(rpc adm4@example.com '[9004]' 9004 "SELECT hub_campanha_lancar($I);")"
  if [ $n -le 10 ]; then [ -z "$(tok "$R")" ] || { echo "FAIL: teto: lancar $n deveria passar ($R)"; fails=$((fails+1)); }; else check "e: 11a campanha lancada -> TETO_CAMPANHAS_ATIVAS" "$(tok "$R")" "TETO_CAMPANHAS_ATIVAS"; fi
done
check "e: 10 lancadas na 9004" "$(own "SELECT count(*) FROM \"Campanha\" WHERE id_empresa=9004 AND lancada_em IS NOT NULL")" "10"
ID_T1="$(own "SELECT min(id) FROM \"Campanha\" WHERE id_empresa=9004")"
check "e: cancelar libera o teto" "$(rpc adm4@example.com '[9004]' 9004 "SELECT hub_campanha_cancelar($ID_T1,'liberando vaga no teto');" >/dev/null; I="$(own "SELECT max(id) FROM \"Campanha\" WHERE id_empresa=9004")"; tok "$(rpc adm4@example.com '[9004]' 9004 "SELECT hub_campanha_lancar($I);")")" ""

echo "--- M3: aviso de inicio so a partir das 08:00 (SP) do dia de inicio ---"
ID_M3="$(salvar adm3@example.com '[9003]' 9003 NULL "$(body 'Inicia Hoje' 2026-11-30 2026-12-07 null null null 1 100 0 0 0 "$NOCUT")")"
rpc adm3@example.com '[9003]' 9003 "SELECT hub_campanha_lancar($ID_M3);" >/dev/null
hora 07:00
check "M3: 07:00 no dia de inicio -> NAO avisa" "$(worker "SELECT hub_campanhas_avisar_inicio();")" "0"
check "M3: ... e aviso_inicio_em segue nulo (pode avisar depois)" "$(own "SELECT aviso_inicio_em IS NULL FROM \"Campanha\" WHERE id=$ID_M3")" "t"
hora 09:00
check "M3: 09:00 -> avisa (1) e o motorista recebe a notificacao" "$(worker "SELECT hub_campanhas_avisar_inicio();")|$(own "SELECT count(*) FROM \"NotificacaoMotorista\" WHERE cnpj_prestador='90000000000103' AND link='/campanhas/$ID_M3'")" "1|1"
hora_real

echo "--- cancelamento (a): o que a imutabilidade DEVE aceitar ---"
check "a: cancelar sem motivo valido -> VALIDACAO" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_cancelar($ID_D,'x');")")" "VALIDACAO"
check "a: cancelamento de campanha lancada PASSA" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_cancelar($ID_D,'cancelada no teste');")")" ""
check "a: situacao cancelada + motivo gravado" "$(own "SELECT hub_campanha_situacao(c)||':'||motivo_cancelamento FROM \"Campanha\" c WHERE id=$ID_D")" "cancelada:cancelada no teste"
check "a: des-cancelar -> CAMPANHA_IMUTAVEL" "$(tok "$(ownx "UPDATE \"Campanha\" SET cancelada_em=NULL, motivo_cancelamento=NULL, cancelada_por=NULL WHERE id=$ID_D")")" "CAMPANHA_IMUTAVEL"
check "a: cancelar de novo -> CAMPANHA_SITUACAO_INVALIDA" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_cancelar($ID_D,'segunda vez aqui');")")" "CAMPANHA_SITUACAO_INVALIDA"

# ===================== P0b: hoje = 2026-12-04 — fechamento manual antecipado ==========
hoje 2026-12-04
check "A3: situacao em_andamento a partir de 01/12" "$(own "SELECT hub_campanha_situacao(c) FROM \"Campanha\" c WHERE id=$ID_A3")" "em_andamento"
check "F: situacao apurando (fim 02/12 < hoje 04/12)" "$(own "SELECT hub_campanha_situacao(c) FROM \"Campanha\" c WHERE id=$ID_F")" "apurando"
check "e: fechar manual antes de fim+3 -> FECHAMENTO_ANTECIPADO" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_fechar($ID_F);")")" "FECHAMENTO_ANTECIPADO"
check "e: fechar campanha em andamento -> CAMPANHA_SITUACAO_INVALIDA" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_fechar($ID_A);")")" "CAMPANHA_SITUACAO_INVALIDA"

# ===================== P1: hoje = 2026-12-06 — calculo (c) ============================
hoje 2026-12-06
check "e: fechar manual em fim+4 passa" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_fechar($ID_F);")")" ""
check "F: encerrada" "$(own "SELECT hub_campanha_situacao(c) FROM \"Campanha\" c WHERE id=$ID_F")" "encerrada"
check "F: recalculo de campanha encerrada -> CAMPANHA_SITUACAO_INVALIDA" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_recalcular($ID_F);")")" "CAMPANHA_SITUACAO_INVALIDA"

echo "--- (c) calculo: cenario fixo, valores calculados a mao ---"
R="$(rpc $ADM $E9001 9001 "SELECT hub_campanhas_recalcular_ativas(9001);")"
check "recalcular_ativas: 4 recalculadas (A, A2, A3, G), 0 fechadas, 0 erros" "$(printf '%s' "$R" | jq -c '[.recalculadas,.fechadas,(.erros|length)]')" "[4,0,0]"
RANK_ESPERADO='Ana Lima|classificado|2|91.00|-|-
Bruno Souza|classificado|1|93.00|-|-
Carla Dias|classificado|3|91.00|-|-
Diego Pires|abaixo_corte|-|-|79.00|4
Eva Costa|sem_minimo|-|-|-|-
Fabio Nunes|sem_modal|-|-|-|-
Iara Melo|abaixo_corte|-|-|92.70|2'
rank_tab() { own "SELECT e.nome||'|'||r.situacao||'|'||COALESCE(r.posicao::text,'-')||'|'||COALESCE(r.nota::text,'-')||'|'||COALESCE(r.nota_hipotetica::text,'-')||'|'||COALESCE(r.posicao_hipotetica::text,'-') FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$1 ORDER BY e.nome"; }
check "c: ranking de A completo (classificado, desempate, abaixo_corte c/ hipotetica, sem_minimo, sem_modal; Gil/CARRO fora)" "$(rank_tab $ID_A)" "$RANK_ESPERADO"
check "c: modal fora (CARRO) nao gera linha" "$(own "SELECT count(*) FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$ID_A AND e.nome='Gil Rocha'")" "0"
check "c: desempate: Ana (id menor) e Carla com a MESMA nota e MESMOS pedidos/tempo" "$(own "SELECT count(DISTINCT nota)||':'||count(DISTINCT pedidos)||':'||count(DISTINCT tempo) FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$ID_A AND e.nome IN ('Ana Lima','Carla Dias')")" "1:1:1"
check "c: motivo_corte de Diego e Iara = {aceitacao}" "$(own "SELECT string_agg(r.motivo_corte::text, ',') FROM \"CampanhaRanking\" r WHERE r.campanha_id=$ID_A AND r.situacao='abaixo_corte'")" "{aceitacao},{aceitacao}"
check "c: modal guardado canonico (Ana: '  moto ' -> MOTO)" "$(own "SELECT r.modal FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$ID_A AND e.nome='Ana Lima'")" "MOTO"
check "c: contagem (RPC)" "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_ranking_contagem($ID_A);" | jq -c '[.classificado,.abaixo_corte,.sem_minimo,.sem_modal]')" "[3,2,1,1]"
check "c: dados_ate = ultimo dia importado (05/12)" "$(own "SELECT dados_ate FROM \"Campanha\" WHERE id=$ID_A")" "2026-12-05"
check "c: posicao_anterior nula no 1o calculo" "$(own "SELECT count(*) FROM \"CampanhaRanking\" WHERE campanha_id=$ID_A AND posicao_anterior IS NOT NULL")" "0"
check "c/pracas: A2 (so CAMPINAS) tem apenas a Carla (turno inteiro, 4 turnos)" "$(rank_tab $ID_A2)" "Carla Dias|classificado|1|90.00|-|-"
check "c/turnos: A3 (so ALMOCO) tem apenas o Bruno: aceitacao 0.5 => nota 50.00" "$(rank_tab $ID_A3)" "Bruno Souza|classificado|1|50.00|-|-"
R="$(rpc $ADM $E9001 9001 "SELECT hub_campanha_recalcular($ID_A);")"
check "c: hub_campanha_recalcular devolve {classificados,abaixo_corte,sem_minimo,sem_modal,ms}" "$(printf '%s' "$R" | jq -c '[.classificados,.abaixo_corte,.sem_minimo,.sem_modal,(.ms|type)]')" '[3,2,1,1,"number"]'
check "c: ranking identico apos o 2o recalculo (idempotente)" "$(rank_tab $ID_A)" "$RANK_ESPERADO"
check "c/variacao: 2o recalculo com o MESMO dado (dados_ate igual) NAO avanca posicao_anterior (continua nula)" "$(own "SELECT count(*) FROM \"CampanhaRanking\" WHERE campanha_id=$ID_A AND posicao_anterior IS NOT NULL")" "0"
# sentinela: valores que so sobrevivem se a guarda preservar a coluna (posicao + 10)
own "UPDATE \"CampanhaRanking\" SET posicao_anterior = posicao + 10 WHERE campanha_id=$ID_A AND situacao='classificado'" >/dev/null
rpc $ADM $E9001 9001 "SELECT hub_campanha_recalcular($ID_A);" >/dev/null
rpc $ADM $E9001 9001 "SELECT hub_campanhas_recalcular_ativas(9001);" >/dev/null   # a 3a importacao do dia, pelo gancho
check "c/variacao: 3o recalculo, mesmo dado: a variacao gravada e PRESERVADA (Bruno 11, Ana 12, Carla 13)" "$(own "SELECT string_agg(e.nome||'='||COALESCE(r.posicao_anterior::text,'-'), ',' ORDER BY e.nome) FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$ID_A AND r.situacao='classificado'")" "Ana Lima=12,Bruno Souza=11,Carla Dias=13"
# dia NOVO (06/12, de quem esta fora da campanha): dados_ate anda => posicao_anterior = posicao do calculo anterior
own "INSERT INTO \"PerformanceTurno\" (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca, corridas_ofertadas, corridas_aceitas, corridas_completadas, pedidos_concluidos, tempo_disponivel, hash_linha)
     SELECT 9001, (SELECT id FROM \"ImportacaoArquivo\" WHERE hash_sha256=repeat('a',64)), id, '2026-12-06', 'JANTAR 18H-22H', interval '4 hours', 'SAO PAULO', 10, 9, 9, 8, interval '3 hours', md5('dia6')||md5('dia6b')
     FROM \"Entregador\" WHERE nome='Gil Rocha'; REFRESH MATERIALIZED VIEW mv_performance_dia;" >/dev/null
rpc $ADM $E9001 9001 "SELECT hub_campanha_recalcular($ID_A);" >/dev/null
check "c/variacao: dia novo (dados_ate 06/12) AVANCA: posicao_anterior = posicao anterior (Bruno 1, Ana 2, Carla 3)" "$(own "SELECT string_agg(e.nome||'='||COALESCE(r.posicao_anterior::text,'-'), ',' ORDER BY e.nome) FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$ID_A AND r.situacao='classificado'")" "Ana Lima=2,Bruno Souza=1,Carla Dias=3"
check "c/variacao: dados_ate = 06/12" "$(own "SELECT dados_ate FROM \"Campanha\" WHERE id=$ID_A")" "2026-12-06"
check "c: ranking continua igual com o dia novo (Gil e CARRO: fora)" "$(rank_tab $ID_A)" "$RANK_ESPERADO"
# mudanca de dado entre recalculos: a linha deixa de vir => e APAGADA do ranking
own "DELETE FROM \"PerformanceTurno\" WHERE entregador_id=$(EID 'Eva Costa'); REFRESH MATERIALIZED VIEW mv_performance_dia;" >/dev/null
rpc $ADM $E9001 9001 "SELECT hub_campanha_recalcular($ID_A);" >/dev/null
check "c: entregador que sumiu do universo e removido do ranking (delete na mesma transacao)" "$(own "SELECT count(*) FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$ID_A AND e.nome='Eva Costa'")" "0"

echo "--- ranking do hub (paginado) ---"
check "hub: ranking de classificados, 1a linha = Bruno, pos 1" "$(rpc $ADM $E9001 9001 "SELECT posicao||'|'||nome||'|'||nota FROM hub_campanha_ranking($ID_A,'classificado',50,0) LIMIT 1;")" "1|Bruno Souza|93.00"
check "hub: pagina de 1 com offset 1 = Ana" "$(rpc $ADM $E9001 9001 "SELECT nome FROM hub_campanha_ranking($ID_A,'classificado',1,1);")" "Ana Lima"
check "hub: abaixo_corte ordenado pela nota hipotetica (Iara 92.70 antes de Diego 79.00)" "$(rpc $ADM $E9001 9001 "SELECT string_agg(nome||'/'||posicao_hipotetica, ',') FROM hub_campanha_ranking($ID_A,'abaixo_corte',50,0);")" "Iara Melo/2,Diego Pires/4"
check "hub: leituras arredondadas a 4 casas (Bruno aceitacao 1.0000, conclusao 0.9000, tempo 0.8000, pedidos 50)" "$(rpc $ADM $E9001 9001 "SELECT aceitacao||'|'||conclusao||'|'||tempo||'|'||pedidos FROM hub_campanha_ranking($ID_A,'classificado',1,0);")" "1.0000|0.9000|0.8000|50"
check "hub: detalhe traz nomes completos e notaCorteTop10 nulo (so 3 classificados)" "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_detalhe($ID_A);" | jq -c '[.situacao,.contagem.classificado,.notaCorteTop10,(.premios|length),.minTurnos,.dadosAte]')" '["em_andamento",3,null,2,3,"2026-12-06"]'
check "hub: lista traz o item no formato do contrato (pesos, contagem, premiosPendentes)" "$(rpc $ADM $E9001 9001 "SELECT item FROM hub_campanha_listar(9001,'em_andamento') WHERE (item->>'id')::int=$ID_A;" | jq -c '[.pesos.aceitacao,.contagem.semModal,.premiosPendentes,.modais]')" '[30,1,0,["MOTO"]]'

echo "--- app do motorista: privacidade e (b) visibilidade A10 ---"
M1=90000000000001; M2=90000000000002; M3=90000000000003; M4=90000000000004; M7=90000000000007
J1="$(app $M1 "SELECT hub_motorista_campanha($ID_A);")"
check "app: Ana ve a propria posicao 2 (anterior 2), nota 91, 5 turnos" "$(printf '%s' "$J1" | jq -c '[.eu.situacao,.eu.posicao,.eu.posicaoAnterior,.eu.nota,.eu.turnos]')" '["classificado",2,2,91.00,5]'
check "app: 'acima' = Bruno abreviado, nota 93" "$(printf '%s' "$J1" | jq -c '.eu.acima')" '{"nome":"Bruno S.","nota":93.00}'
check "app: top10 so com nome ABREVIADO, na ordem" "$(printf '%s' "$J1" | jq -c '[.top10[]|[.posicao,.nome,.souEu]]')" '[[1,"Bruno S.",false],[2,"Ana L.",true],[3,"Carla D.",false]]'
check "app: NENHUM sobrenome/nome completo de terceiro no JSON (Souza, Dias, Pires, Melo, Nunes)" "$(printf '%s' "$J1" | grep -cE 'Souza|Dias|Pires|Melo|Nunes|Costa|Rocha')" "0"
check "app: leituras e notas por indicador (pedidos 40/50 = 80)" "$(printf '%s' "$J1" | jq -c '[.eu.leituras.aceitacao,.eu.leituras.conclusao,.eu.leituras.tempo,.eu.leituras.pedidos,.eu.notas.aceitacao,.eu.notas.pedidos,.lider.pedidos]')" '[0.9000,1.0000,0.9000,40,90.00,80.00,50]'
check "app: premio da faixa 2-3 (dinheiro) + ofertadas/aceitas/completadas" "$(printf '%s' "$J1" | jq -c '[.eu.premio.tipo,.eu.ofertadas,.eu.aceitas,.eu.completadas,.eu.entregueEm]')" '["dinheiro",50,45,45,null]'
check "app: campanha: regras visiveis (pesos/cortes/dadosAte)" "$(printf '%s' "$J1" | jq -c '[.campanha.pesos.tempo,.campanha.cortes.aceitacao,.campanha.dadosAte,.campanha.fechadaEm,.campanha.modais]')" '[20,0.8000,"2026-12-06",null,["MOTO"]]'
J4="$(app $M4 "SELECT hub_motorista_campanha($ID_A);")"
check "app: Diego (abaixo do corte): nota hipotetica 79 daria o 4o lugar; sem 'acima'; motivo aceitacao" "$(printf '%s' "$J4" | jq -c '[.eu.situacao,.eu.posicao,.eu.notaHipotetica,.eu.posicaoHipotetica,.eu.motivoCorte,.eu.acima,.eu.premio]')" '["abaixo_corte",null,79.00,4,["aceitacao"],null,null]'
J7="$(app $M7 "SELECT hub_motorista_campanha($ID_A);")"
check "app: Gil (modal CARRO fora da campanha): eu = null, ainda ve a campanha" "$(printf '%s' "$J7" | jq -c '[.eu,.campanha.id==('$ID_A')]')" '[null,true]'
check "app: lista da Ana: A, A3, F (encerrada <30d) e G — NAO a de Campinas (A10)" "$(app $M1 "SELECT hub_motorista_campanhas();" | jq -c '[.[].id] | sort')" "$(printf '%s\n' $ID_A $ID_A3 $ID_F $ID_G | sort -n | jq -Rn -c '[inputs|tonumber]')"
check "app: lista da Carla (Campinas): ve tambem A2" "$(app $M3 "SELECT hub_motorista_campanhas();" | jq -c '[.[].id] | sort')" "$(printf '%s\n' $ID_A $ID_A2 $ID_A3 $ID_F $ID_G | sort -n | jq -Rn -c '[inputs|tonumber]')"
check "app: Ana pedindo a campanha de Campinas por id -> 404 (A10)" "$(tok "$(app $M1 "SELECT hub_motorista_campanha($ID_A2);")")" "CAMPANHA_NAO_ENCONTRADA"
check "app: item da lista traz dataInicio e os campos do contrato" "$(app $M1 "SELECT hub_motorista_campanhas();" | jq -c --argjson id $ID_A '.[]|select(.id==$id)|[.dataInicio,.dataFim,.minhaPosicao,.minhaSituacao,.naZonaPremio,.situacao]')" '["2026-12-01","2026-12-07",2,"classificado",true,"em_andamento"]'
check "app: campanha CANCELADA some do app (D)" "$(app $M1 "SELECT hub_motorista_campanhas();" | jq -c --argjson id $ID_D '[.[]|select(.id==$id)]|length')" "0"
check "app: pedir a cancelada por id -> 404" "$(tok "$(app $M1 "SELECT hub_motorista_campanha($ID_D);")")" "CAMPANHA_NAO_ENCONTRADA"
check "app: motorista de OUTRA empresa pedindo a campanha de 9001 -> 404" "$(tok "$(app 90000000000101 "SELECT hub_motorista_campanha($ID_A);")")" "CAMPANHA_NAO_ENCONTRADA"
check "app: motorista de outra empresa nao ve campanha de 9001 na lista (so a do Recife)" "$(app 90000000000101 "SELECT hub_motorista_campanhas();" | jq -c '[.[].id]')" "[$ID_B]"
check "app: CNPJ sem Entregador -> SEM_VINCULO" "$(tok "$(app 99999999999999 "SELECT hub_motorista_campanha($ID_A);")")" "SEM_VINCULO"
check "app: sem claim de CNPJ -> lista vazia" "$(rpc $ADM $E9001 9001 "SELECT hub_motorista_campanhas();")" "[]"
check "app: foto de campanha CANCELADA (D) -> 404" "$(tok "$(app $M1 "SELECT count(*) FROM hub_motorista_campanha_foto($ID_D,$PID_D);")")" "CAMPANHA_NAO_ENCONTRADA"
check "app: foto do premio de campanha visivel (G) volta o PNG" "$(app $M1 "SELECT mime||'|'||base64 FROM hub_motorista_campanha_foto($ID_G,$PID_G);")" "image/png|$PNG"
check "B2/app: premio de OUTRA campanha com id certo de G e campanha errada -> 404" "$(tok "$(app $M1 "SELECT * FROM hub_motorista_campanha_foto($ID_A,$PID_G);")")" "CAMPANHA_NAO_ENCONTRADA"
# B8: o modulo `campanhas` desligado na empresa tira a campanha do app
own "UPDATE \"ModuloEntidade\" SET ativo=false WHERE empresa_id=9001 AND modulo_id=(SELECT id FROM \"Modulo\" WHERE codigo='campanhas')" >/dev/null
check "B8: modulo desligado -> lista do app vazia" "$(app $M1 "SELECT hub_motorista_campanhas();")" "[]"
check "B8: modulo desligado -> detalhe 404" "$(tok "$(app $M1 "SELECT hub_motorista_campanha($ID_A);")")" "CAMPANHA_NAO_ENCONTRADA"
check "B8: modulo desligado -> foto 404" "$(tok "$(app $M1 "SELECT * FROM hub_motorista_campanha_foto($ID_G,$PID_G);")")" "CAMPANHA_NAO_ENCONTRADA"
own "UPDATE \"ModuloEntidade\" SET ativo=true WHERE empresa_id=9001" >/dev/null
check "B8: religado -> a lista volta" "$(app $M1 "SELECT jsonb_array_length(hub_motorista_campanhas()) > 0;")" "t"

echo "--- aviso de inicio (varredura do push worker) ---"
check "avisar_inicio: 1a chamada enfileira (>=1: A, A2?, A3 ... campanhas iniciadas e com publico)" "$(worker "SELECT hub_campanhas_avisar_inicio() >= 1;")" "t"
check "avisar_inicio: idempotente (2a chamada = 0)" "$(worker "SELECT hub_campanhas_avisar_inicio();")" "0"
check "avisar_inicio: aviso_inicio_em carimbado em A" "$(own "SELECT aviso_inicio_em IS NOT NULL FROM \"Campanha\" WHERE id=$ID_A")" "t"
check "avisar_inicio: Aviso de sistema 'Nova campanha' criado, na categoria sistema" "$(own "SELECT count(*) > 0 FROM \"Aviso\" WHERE origem='sistema' AND titulo='Nova campanha' AND categoria='sistema'")" "t"
check "avisar_inicio: Ana recebeu a notificacao com link /campanhas/$ID_A (allowlist estendida)" "$(own "SELECT count(*) FROM \"NotificacaoMotorista\" WHERE cnpj_prestador='$M1' AND link='/campanhas/$ID_A'")" "1"
check "avisar_inicio: Carla (publico de Campinas) tambem" "$(own "SELECT count(*) FROM \"NotificacaoMotorista\" WHERE cnpj_prestador='$M3' AND link='/campanhas/$ID_A2'")" "1"
check "avisar_inicio: Ana NAO recebeu o aviso da campanha de Campinas" "$(own "SELECT count(*) FROM \"NotificacaoMotorista\" WHERE cnpj_prestador='$M1' AND link='/campanhas/$ID_A2'")" "0"
check "avisar_inicio: Fabio (sem modal) nao e avisado de campanha filtrada por MOTO" "$(own "SELECT count(*) FROM \"NotificacaoMotorista\" WHERE cnpj_prestador='90000000000006' AND link='/campanhas/$ID_A'")" "0"
check "allowlist de link: link fora do padrao segue recusado" "$(tok "$(ownx "INSERT INTO \"NotificacaoMotorista\"(cnpj_prestador,categoria,titulo,corpo,link,aviso_id) VALUES ('90000000000001','sistema','t','c','/hack/1',(SELECT max(id) FROM \"Aviso\"))")")" 'violates check constraint "notificacaomotorista_link_chk"'

echo "--- (g) hub_adiantamento_notificar apos a extracao: comportamento preservado ---"
ANTES="$(own "SELECT count(*) FROM \"Aviso\" WHERE titulo='Conta bancária aprovada'")"
ownx "SELECT hub_adiantamento_notificar(NULL, 'conta_aprovada', $(EID 'Ana Lima'));" >/dev/null
check "g: conta_aprovada cria Aviso(sistema/conta_bancaria/individual) + 1 NotificacaoMotorista /conta-bancaria" "$(own "SELECT a.origem||'|'||a.categoria||'|'||a.modo_destinatarios||'|'||a.destinatarios_ids::text||'|'||a.status||'|'||(SELECT count(*) FROM \"NotificacaoMotorista\" n WHERE n.aviso_id=a.id AND n.cnpj_prestador='$M1' AND n.link='/conta-bancaria' AND n.categoria='conta_bancaria') FROM \"Aviso\" a WHERE a.titulo='Conta bancária aprovada' ORDER BY a.id DESC LIMIT 1")" "sistema|conta_bancaria|individual|{$(EID 'Ana Lima')}|concluido|1"
check "g: evento 'criada' continua no-op" "$(ownx "SELECT hub_adiantamento_notificar(NULL,'criada',$(EID 'Ana Lima'));" >/dev/null; own "SELECT count(*) FROM \"Aviso\" WHERE titulo='Conta bancária aprovada'")" "$((ANTES + 1))"
check "g: evento desconhecido continua no-op" "$(ownx "SELECT hub_adiantamento_notificar(NULL,'inventado',$(EID 'Ana Lima'));" >/dev/null; own "SELECT count(*) FROM \"Aviso\" WHERE titulo='Conta bancária aprovada'")" "$((ANTES + 1))"
check "g: hub_adiantamento_notificar continua sem EXECUTE para authenticated" "$(own "SELECT has_function_privilege('authenticated','hub_adiantamento_notificar(bigint,text,integer)','EXECUTE')")" "f"

# ============= P2: hoje = 2026-12-08, dados cobrem data_fim — fechamento automatico (d) ======
echo "--- (d) fechamento automatico ---"
own "INSERT INTO \"PerformanceTurno\" (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca, corridas_ofertadas, corridas_aceitas, corridas_completadas, pedidos_concluidos, tempo_disponivel, hash_linha)
     SELECT 9001, (SELECT id FROM \"ImportacaoArquivo\" WHERE hash_sha256=repeat('a',64)), id, '2026-12-07', 'JANTAR 18H-22H', interval '4 hours', 'SAO PAULO', 10, 9, 9, 8, interval '3 hours', md5('fim')||md5('fim2')
     FROM \"Entregador\" WHERE nome='Gil Rocha'; REFRESH MATERIALIZED VIEW mv_performance_dia;" >/dev/null
# M1: o dado cobre data_fim (07/12) mas HOJE ainda e 07/12 (o dia nao acabou): NAO fecha
hoje 2026-12-07
R="$(rpc $ADM $E9001 9001 "SELECT hub_campanhas_recalcular_ativas(9001);")"
check "M1: dado cobre data_fim mas hoje = data_fim: recalcula as 4 e NAO fecha nenhuma" "$(printf '%s' "$R" | jq -c '[.recalculadas,.fechadas,(.erros|length)]')" "[4,0,0]"
check "M1: A segue em_andamento no dia do fim" "$(own "SELECT hub_campanha_situacao(c) FROM \"Campanha\" c WHERE id=$ID_A")" "em_andamento"
hoje 2026-12-08
check "situacao apurando antes do fechamento (fim 07/12, hoje 08/12)" "$(own "SELECT hub_campanha_situacao(c) FROM \"Campanha\" c WHERE id=$ID_A")" "apurando"
rank_antes="$(rank_tab $ID_A)"
R="$(rpc $ADM $E9001 9001 "SELECT hub_campanhas_recalcular_ativas(9001);")"
check "d: recalcular_ativas fecha as 4 (A, A2, A3, G): dado cobre 07/12 E o dia 07 ja passou" "$(printf '%s' "$R" | jq -c '[.recalculadas,.fechadas,(.erros|length)]')" "[0,4,0]"
# M2/B1: cancelada/fechada relida sob o lock => as funcoes internas nao tem efeito (corrida entre selecao e fechamento)
DADOS_A="$(own "SELECT dados_ate||'|'||fechada_em FROM \"Campanha\" WHERE id=$ID_A")"; RK_A="$(rank_tab $ID_A)"
check "M2: recalcular_interno em campanha CANCELADA (D) e ignorado" "$(own "SELECT hub_campanha_recalcular_interno($ID_D)->>'ignorada'")" "true"
check "M2: ... e nao gravou ranking nenhum para ela" "$(own "SELECT count(*) FROM \"CampanhaRanking\" WHERE campanha_id=$ID_D")" "0"
own "SELECT hub_campanha_fechar_interno($ID_D)" >/dev/null
check "M2/B1: fechar_interno em campanha CANCELADA nao fecha nem cria vencedor" "$(own "SELECT (fechada_em IS NULL)||':'||(SELECT count(*) FROM \"CampanhaVencedor\" WHERE campanha_id=$ID_D) FROM \"Campanha\" WHERE id=$ID_D")" "true:0"
check "M2: recalcular_interno em campanha FECHADA (A) e ignorado e o ranking nao muda" "$(own "SELECT hub_campanha_recalcular_interno($ID_A)->>'ignorada'")|$(rank_tab $ID_A | md5sum | cut -c1-8)" "true|$(printf '%s\n' "$RK_A" | md5sum | cut -c1-8)"
check "M2: ... nem o dados_ate/fechada_em de A" "$(own "SELECT dados_ate||'|'||fechada_em FROM \"Campanha\" WHERE id=$ID_A")" "$DADOS_A"
check "M2: fechar_interno de campanha ja fechada nao duplica vencedor nem reenfileira aviso" "$(own "SELECT hub_campanha_fechar_interno($ID_A)" >/dev/null; own "SELECT (SELECT count(*) FROM \"CampanhaVencedor\" WHERE campanha_id=$ID_A)||':'||(SELECT count(*) FROM \"Aviso\" WHERE titulo='Resultado da campanha' AND corpo LIKE 'A campanha Rei do Jantar%')")" "3:1"
check "d: A encerrada e carimbada" "$(own "SELECT hub_campanha_situacao(c)||':'||(fechada_em IS NOT NULL) FROM \"Campanha\" c WHERE id=$ID_A")" "encerrada:true"
check "d: vencedores por faixa: 1=Bruno (objeto), 2=Ana, 3=Carla (dinheiro)" "$(own "SELECT string_agg(v.posicao||'='||e.nome||'/'||p.tipo, ',' ORDER BY v.posicao) FROM \"CampanhaVencedor\" v JOIN \"Entregador\" e ON e.id=v.entregador_id JOIN \"CampanhaPremio\" p ON p.id=v.premio_id WHERE v.campanha_id=$ID_A")" "1=Bruno Souza/objeto,2=Ana Lima/dinheiro,3=Carla Dias/dinheiro"
check "d: abaixo_corte/sem_minimo NAO viram vencedor (so classificado)" "$(own "SELECT count(*) FROM \"CampanhaVencedor\" WHERE campanha_id=$ID_A")" "3"
check "d: ranking final preserva o resultado (Gil, do dia 07/12, e CARRO: fora)" "$(rank_tab $ID_A | grep -vc 'Eva Costa')" "6"
check "d: aviso de resultado enfileirado para o ranking (link /campanhas/A, titulo Resultado)" "$(own "SELECT count(*) FROM \"NotificacaoMotorista\" n JOIN \"Aviso\" a ON a.id=n.aviso_id WHERE a.titulo='Resultado da campanha' AND n.link='/campanhas/$ID_A'")" "6"
check "d: aviso_fim_em carimbado" "$(own "SELECT aviso_fim_em IS NOT NULL FROM \"Campanha\" WHERE id=$ID_A")" "t"
check "d: dados_ate = 07/12 (cobre data_fim)" "$(own "SELECT dados_ate FROM \"Campanha\" WHERE id=$ID_A")" "2026-12-07"
check "d: A2 e A3 tambem fecharam com vencedor (sem faixa de premio para o 1o? tem: 1 vencedor cada se houver premio)" "$(own "SELECT (SELECT count(*) FROM \"Campanha\" WHERE id IN ($ID_A2,$ID_A3) AND fechada_em IS NOT NULL)")" "2"
check "d: segunda varredura nao refecha nem recalcula (nada ativo na 9001)" "$(rpc $ADM $E9001 9001 "SELECT hub_campanhas_recalcular_ativas(9001);" | jq -c '[.recalculadas,.fechadas]')" "[0,0]"
check "d: ranking congelado: nao muda por novo dado (recalculo de encerrada recusado)" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_recalcular($ID_A);")")" "CAMPANHA_SITUACAO_INVALIDA"
check "d: cancelar campanha encerrada -> CAMPANHA_SITUACAO_INVALIDA" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_cancelar($ID_A,'tarde demais para isso');")")" "CAMPANHA_SITUACAO_INVALIDA"
check "d: encerrada continua visivel ao motorista (ate 30 dias) com premio e fechadaEm" "$(app $M1 "SELECT hub_motorista_campanha($ID_A);" | jq -c '[.campanha.situacao,(.campanha.fechadaEm!=null),.eu.premio.tipo]')" '["encerrada",true,"dinheiro"]'
# fechada_em e imutavel (de proposito): para simular 31 dias, desliga o gatilho SO nesta linha e o religa se estava ligado
own "DO \$\$ DECLARE v char; BEGIN SELECT tgenabled INTO v FROM pg_trigger WHERE tgname='trg_campanha_imutavel'; ALTER TABLE \"Campanha\" DISABLE TRIGGER trg_campanha_imutavel; UPDATE \"Campanha\" SET fechada_em = now() - interval '31 days' WHERE id=$ID_A3; IF v = 'O' THEN ALTER TABLE \"Campanha\" ENABLE TRIGGER trg_campanha_imutavel; END IF; END \$\$;" >/dev/null
check "d: encerrada ha mais de 30 dias SOME do app" "$(app $M2 "SELECT hub_motorista_campanhas();" | jq -c --argjson id $ID_A3 '[.[]|select(.id==$id)]|length')" "0"

echo "--- vencedores, entrega e exportacao ---"
check "vencedores (hub): 3 linhas, premio e nota; Bruno 93.00" "$(rpc $ADM $E9001 9001 "SELECT posicao||'|'||nome||'|'||nota||'|'||premio_tipo||'|'||COALESCE(valor_centavos::text,'-') FROM hub_campanha_vencedores($ID_A);" | paste -sd';')" "1|Bruno Souza|93.00|objeto|-;2|Ana Lima|91.00|dinheiro|10000;3|Carla Dias|91.00|dinheiro|10000"
check "premiosPendentes = 3 antes de entregar/exportar" "$(rpc $ADM $E9001 9001 "SELECT item->>'premiosPendentes' FROM hub_campanha_listar(9001,'encerrada') WHERE (item->>'id')::int=$ID_A;")" "3"
check "entrega: sem a permissao 'entregar' (operador) -> PERMISSAO_NEGADA" "$(tok "$(rpc op@example.com $E9001 9001 "SELECT hub_campanha_registrar_entrega($ID_A,1,'x');")")" "PERMISSAO_NEGADA"
check "entrega: registrar objeto (financeiro tem 'entregar')" "$(tok "$(rpc fin@example.com $E9001 9001 "SELECT hub_campanha_registrar_entrega($ID_A,1,'Entregue em maos');")")" ""
check "entrega: so UMA vez -> CAMPANHA_SITUACAO_INVALIDA" "$(tok "$(rpc fin@example.com $E9001 9001 "SELECT hub_campanha_registrar_entrega($ID_A,1,'de novo');")")" "CAMPANHA_SITUACAO_INVALIDA"
check "entrega: premio em dinheiro nao se 'entrega' -> CAMPANHA_SITUACAO_INVALIDA" "$(tok "$(rpc fin@example.com $E9001 9001 "SELECT hub_campanha_registrar_entrega($ID_A,2,'x');")")" "CAMPANHA_SITUACAO_INVALIDA"
check "entrega: posicao sem vencedor -> CAMPANHA_NAO_ENCONTRADA" "$(tok "$(rpc fin@example.com $E9001 9001 "SELECT hub_campanha_registrar_entrega($ID_A,9,'x');")")" "CAMPANHA_NAO_ENCONTRADA"
check "entrega: quem entregou e quando ficam gravados (nome do usuario na RPC)" "$(rpc $ADM $E9001 9001 "SELECT entregue_por_nome||'|'||observacao||'|'||(entregue_em IS NOT NULL) FROM hub_campanha_vencedores($ID_A) WHERE posicao=1;")" "Fin 9001|Entregue em maos|true"
check "Vencedor: so entrega/exportacao mudam — trocar o entregador vencedor -> CAMPANHA_IMUTAVEL" "$(tok "$(ownx "UPDATE \"CampanhaVencedor\" SET entregador_id=$(EID 'Diego Pires') WHERE campanha_id=$ID_A AND posicao=1")")" "CAMPANHA_IMUTAVEL"
check "Vencedor: trocar o premio -> CAMPANHA_IMUTAVEL" "$(tok "$(ownx "UPDATE \"CampanhaVencedor\" SET premio_id=(SELECT min(id) FROM \"CampanhaPremio\" WHERE campanha_id=$ID_A) WHERE campanha_id=$ID_A AND posicao=3")")" "CAMPANHA_IMUTAVEL"
check "Vencedor: DELETE -> CAMPANHA_IMUTAVEL" "$(tok "$(ownx "DELETE FROM \"CampanhaVencedor\" WHERE campanha_id=$ID_A")")" "CAMPANHA_IMUTAVEL"
check "Vencedor: campo de exportacao muda (permitido)" "$(ownx "UPDATE \"CampanhaVencedor\" SET exportado_em=NULL WHERE campanha_id=$ID_A AND posicao=3" | grep -c ERROR)" "0"
# Carla perde o vinculo de conta: vencedora SEM CNPJ nao volta na exportacao
own "UPDATE \"Entregador\" SET motorista_id=NULL WHERE nome='Carla Dias'" >/dev/null
EXP() { echo "SELECT cnpj||'|'||nome||'|'||valor_centavos||'|'||posicao||'|'||COALESCE(data_pagamento::text,'-')||'|'||adiado FROM hub_campanha_marcar_exportado($1);"; }
TODAY="$(own "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date")"
# A2 + corrida: a sessao 1 exporta A e SEGURA a transacao 3 s (lock por empresa); a sessao 2 exporta F
# (a Ana e vencedora de dinheiro nas duas) no meio. Com o lock a 2a espera e ve o carimbo => Ana adiada.
( rpc fin@example.com $E9001 9001 "$(EXP $ID_A) SELECT pg_sleep(3);" > "$TMP/ex1.out" ) &
sleep 1
rpc fin@example.com $E9001 9001 "$(EXP $ID_F)" > "$TMP/ex2.out"
wait
check "exportar (A): so dinheiro COM CNPJ volta (Ana, data = dia SP do carimbo); Carla sem CNPJ nao volta" "$(cat "$TMP/ex1.out")" "$M1|Ana Lima|10000|2|$TODAY|false"
check "exportar: carimba exportado_em so de quem saiu" "$(own "SELECT string_agg(posicao||'='||(exportado_em IS NOT NULL), ',' ORDER BY posicao) FROM \"CampanhaVencedor\" WHERE campanha_id=$ID_A")" "1=false,2=true,3=false"
check "A2/corrida: F exportada ENQUANTO A segura a transacao: a Ana volta ADIADA (sem data) — o lock por empresa serializa" "$(grep -cE "^$M1\|Ana Lima\|10000\|[0-9]+\|-\|true$" "$TMP/ex2.out")" "1"
check "A2/corrida: ... e a Ana NAO foi carimbada em F" "$(own "SELECT count(*) FROM \"CampanhaVencedor\" v JOIN \"Entregador\" e ON e.id=v.entregador_id WHERE v.campanha_id=$ID_F AND e.nome='Ana Lima' AND v.exportado_em IS NOT NULL")" "0"
check "A2/corrida: F carimbou os OUTROS vencedores de dinheiro com CNPJ (adiado=false)" "$([ "$(grep -c '|false$' "$TMP/ex2.out")" -ge 1 ] && echo sim || echo nao)" "sim"
R="$(rpc fin@example.com $E9001 9001 "$(EXP $ID_G)")"
check "A2: G no mesmo dia: Gil carimbado hoje; Ana (CNPJ ja exportado hoje em A) ADIADA; Carla (sem CNPJ) fora" "$R" "90000000000007|Gil Rocha|10000|1|$TODAY|false
$M1|Ana Lima|10000|2|-|true"
check "A2: o vencedor adiado NAO e carimbado (continua pendente)" "$(own "SELECT exportado_em IS NULL FROM \"CampanhaVencedor\" WHERE campanha_id=$ID_G AND posicao=2")" "t"
T1="$(own "SELECT exportado_em FROM \"CampanhaVencedor\" WHERE campanha_id=$ID_A AND posicao=2")"
R="$(rpc fin@example.com $E9001 9001 "$(EXP $ID_A)")"
check "exportar de novo reproduz a MESMA linha e mantem o 1o carimbo (nao reescreve)" "$R|$(own "SELECT exportado_em FROM \"CampanhaVencedor\" WHERE campanha_id=$ID_A AND posicao=2")" "$M1|Ana Lima|10000|2|$TODAY|false|$T1"
# A1: o carimbo e de 3 dias atras => a data da planilha tem de ser a do carimbo, NAO a de hoje
own "UPDATE \"CampanhaVencedor\" SET exportado_em = exportado_em - interval '3 days', data_pagamento = data_pagamento - 3 WHERE campanha_id=$ID_A AND posicao=2" >/dev/null
D3="$(own "SELECT (exportado_em AT TIME ZONE 'America/Sao_Paulo')::date FROM \"CampanhaVencedor\" WHERE campanha_id=$ID_A AND posicao=2")"
check "A1: re-download depois de dias traz a data ORIGINAL do carimbo (nao a de hoje)" "$(rpc fin@example.com $E9001 9001 "$(EXP $ID_A)")" "$M1|Ana Lima|10000|2|$D3|false"
check "A1: ... e a data original difere de hoje" "$([ "$D3" != "$TODAY" ] && echo sim || echo nao)" "sim"
# "dia seguinte": a Ana ja nao tem carimbo HOJE => G agora a carimba (hoje)
R="$(rpc fin@example.com $E9001 9001 "$(EXP $ID_G)")"
check "A2: no dia seguinte (sem carimbo da Ana hoje) o vencedor pendente e carimbado com a data de hoje" "$R" "90000000000007|Gil Rocha|10000|1|$TODAY|false
$M1|Ana Lima|10000|2|$TODAY|false"
check "A2: F, com a Ana agora carimbada hoje em G, volta a adia-la (qualquer campanha da empresa)" "$(rpc fin@example.com $E9001 9001 "$(EXP $ID_F)" | grep -cE "^$M1\|Ana Lima\|10000\|[0-9]+\|-\|true$")" "1"
check "exportar: operador sem 'entregar' -> PERMISSAO_NEGADA" "$(tok "$(rpc op@example.com $E9001 9001 "SELECT * FROM hub_campanha_marcar_exportado($ID_A);")")" "PERMISSAO_NEGADA"
check "tipo de lancamento externo PREMIO_CAMPANHA existe com sinal +1" "$(own "SELECT sinal FROM \"LancamentoExternoTipo\" WHERE codigo='PREMIO_CAMPANHA'")" "1"

echo "--- 0128: excluir rascunho + admin_plataforma ---"
psql_t -q <<'SQL' >"$TMP/seed128.log" 2>&1 || { echo "FAIL: seed 0128"; cat "$TMP/seed128.log"; exit 1; }
INSERT INTO "Usuario" (email, senha_hash, nome) VALUES ('plat@example.com','x','Plat 9001');
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ((SELECT id FROM "Usuario" WHERE email='plat@example.com'), 9001, (SELECT id FROM "Papel" WHERE nome='admin_plataforma'), true);
SQL
check "0128: admin_plataforma tem as 3 permissoes de campanhas" "$(own "SELECT string_agg(perm.codigo, ',' ORDER BY perm.codigo) FROM \"PapelPermissao\" pp JOIN \"Papel\" p ON p.id=pp.papel_id JOIN \"Permissao\" perm ON perm.id=pp.permissao_id WHERE p.nome='admin_plataforma' AND perm.codigo LIKE 'campanhas.%'")" "campanhas.consultar,campanhas.entregar,campanhas.gerir"
PLAT='plat@example.com'
BX="$(body 'Rascunho Excluir' 2027-02-01 2027-02-07 null null null 3 100 0 0 0 "$NOCUT")"
ID_PL="$(salvar $PLAT $E9001 9001 NULL "$BX")"
check "0128: admin_plataforma cria campanha na entidade onde tem vinculo" "$(printf '%s' "$ID_PL" | grep -cE '^[0-9]+$')" "1"
check "0128: admin_plataforma lista na entidade onde tem vinculo" "$(rpc $PLAT $E9001 9001 "SELECT count(*) >= 1 FROM hub_campanha_listar(9001,NULL);")" "t"
check "0128: admin_plataforma sem vinculo na entidade 9002 -> PERMISSAO_NEGADA (o grant nao cria acesso)" "$(tok "$(rpc $PLAT '[9002]' 9002 "SELECT * FROM hub_campanha_listar(9002,NULL);")")" "PERMISSAO_NEGADA"
ID_X="$(salvar $ADM $E9001 9001 NULL "$BX")"
ownx "INSERT INTO \"CampanhaRanking\" (campanha_id, entregador_id, id_empresa, turnos, ofertadas, aceitas, completadas, situacao) VALUES ($ID_X, $(EID 'Ana Lima'), 9001, 1, 1, 1, 1, 'classificado')" >/dev/null
check "0128: rascunho tem premios e ranking antes de excluir" "$(own "SELECT (SELECT count(*) FROM \"CampanhaPremio\" WHERE campanha_id=$ID_X) > 0 AND (SELECT count(*) FROM \"CampanhaRanking\" WHERE campanha_id=$ID_X) = 1")" "t"
check "0128: operador (sem gerir) -> PERMISSAO_NEGADA e o rascunho continua" "$(tok "$(rpc op@example.com $E9001 9001 "SELECT hub_campanha_excluir($ID_X);")")|$(own "SELECT count(*) FROM \"Campanha\" WHERE id=$ID_X")" "PERMISSAO_NEGADA|1"
check "0128: entidade B (9002) -> CAMPANHA_NAO_ENCONTRADA e o rascunho continua" "$(tok "$(rpc admb@example.com '[9002]' 9002 "SELECT hub_campanha_excluir($ID_X);")")|$(own "SELECT count(*) FROM \"Campanha\" WHERE id=$ID_X")" "CAMPANHA_NAO_ENCONTRADA|1"
check "0128: id inexistente -> CAMPANHA_NAO_ENCONTRADA" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_excluir(2147483647);")")" "CAMPANHA_NAO_ENCONTRADA"
check "0128: authenticated nao tem DELETE direto em Campanha" "$(tok "$(rpc $ADM $E9001 9001 "DELETE FROM \"Campanha\" WHERE id=$ID_X;")")|$(own "SELECT count(*) FROM \"Campanha\" WHERE id=$ID_X")" "permission denied|1"
[ "${CAMP_NEG:-}" = excluir ] && neg_excluir
check "0128: excluir lancada -> CAMPANHA_IMUTAVEL e ela continua la" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_excluir($ID_A);")")|$(own "SELECT count(*) FROM \"Campanha\" WHERE id=$ID_A")" "CAMPANHA_IMUTAVEL|1"
check "0128: excluir rascunho devolve {id,nome}" "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_excluir($ID_X);")" "{\"id\": $ID_X, \"nome\": \"Rascunho Excluir\"}"
check "0128: rascunho sumiu, com premios e ranking em cascata" "$(own "SELECT (SELECT count(*) FROM \"Campanha\" WHERE id=$ID_X)::text||(SELECT count(*) FROM \"CampanhaPremio\" WHERE campanha_id=$ID_X)::text||(SELECT count(*) FROM \"CampanhaRanking\" WHERE campanha_id=$ID_X)::text")" "000"
check "0128: admin_plataforma exclui o proprio rascunho" "$(rpc $PLAT $E9001 9001 "SELECT hub_campanha_excluir($ID_PL);" | grep -c "Rascunho Excluir")|$(own "SELECT count(*) FROM \"Campanha\" WHERE id=$ID_PL")" "1|0"
check "0128: hub_campanha_excluir nao e executavel por PUBLIC" "$(own "SELECT has_function_privilege('public','hub_campanha_excluir(int)','EXECUTE')")" "f"

echo "--- 0129: campanha tipo extrato (melhor extrato) ---"
# Empresa 9005 propria (nomes terminam em 'Extrato' para nao colidir com EID() das secoes anteriores).
# Cenario fixo, calculado a mao (R$ = centavos/100). Criterio por turno: aceitacao >= 0.8 E tempo >= 0.7.
psql_t -q <<'SQL' >"$TMP/seed129.log" 2>&1 || { echo "FAIL: seed 0129"; cat "$TMP/seed129.log"; exit 1; }
INSERT INTO "Usuario" (email, senha_hash, nome) VALUES ('adm5@example.com','x','Adm 9005'),('op5@example.com','x','Op 9005');
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ((SELECT id FROM "Usuario" WHERE email='adm5@example.com'), 9005, (SELECT id FROM "Papel" WHERE nome='admin_entidade'), true),
  ((SELECT id FROM "Usuario" WHERE email='op5@example.com'),  9005, (SELECT id FROM "Papel" WHERE nome='operador'), true);
INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo) SELECT m.id, 9005, true FROM "Modulo" m WHERE m.codigo = 'campanhas';
CREATE TEMP TABLE sx (k int, nome text, modal text, cnpj text);
INSERT INTO sx VALUES
 (1,'Alice Extrato','  moto ','90500000000001'),(2,'Bento Extrato','MOTO','90500000000002'),(3,'Cida Extrato','MOTO','90500000000003'),
 (4,'Davi Extrato','MOTO','90500000000004'),(5,'Elisa Extrato','MOTO','90500000000005'),(6,'Fabio Extrato',NULL,'90500000000006'),
 (7,'Gil Extrato','CARRO','90500000000007'),(8,'Hugo Extrato','MOTO','90500000000008'),(9,'Iara Extrato','MOTO','90500000000009');
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) SELECT cnpj, nome FROM sx;
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id, dados_entrego_json)
  SELECT 9005, gen_random_uuid(), s.nome, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador = s.cnpj),
         CASE WHEN s.modal IS NULL THEN NULL ELSE jsonb_build_object('informacoesEntrega', jsonb_build_object('modal', s.modal)) END
  FROM sx s ORDER BY s.k;
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES (9005,'performance',repeat('d',64),'completed'),(9005,'faturamento',repeat('e',64),'completed');
-- turnos: (nome, dia 1..3, ofertadas, aceitas, completadas, pedidos, horas online de 4h do turno; NULL = sem leitura)
CREATE TEMP TABLE px (nome text, d int, o int, a int, c int, p int, t numeric);
INSERT INTO px VALUES
 ('Alice Extrato',1,10,9,9,8,3.6),('Alice Extrato',2,10,9,9,8,3.6),('Alice Extrato',3,10,9,9,8,3.6),
 ('Bento Extrato',1,10,9,9,8,3.6),('Bento Extrato',2,10,7,7,8,3.6),('Bento Extrato',3,10,9,9,8,3.6),
 ('Cida Extrato',1,10,9,9,8,3.6),('Cida Extrato',2,10,9,9,8,3.6),
 ('Davi Extrato',1,10,9,9,8,3.6),('Davi Extrato',2,10,9,9,8,3.6),('Davi Extrato',3,10,9,9,8,3.6),
 ('Elisa Extrato',1,10,9,9,8,3.6),
 ('Fabio Extrato',1,10,9,9,8,3.6),('Fabio Extrato',2,10,9,9,8,3.6),('Fabio Extrato',3,10,9,9,8,3.6),
 ('Gil Extrato',1,10,9,9,8,3.6),
 ('Hugo Extrato',1,10,9,9,8,3.6),('Hugo Extrato',2,10,9,9,8,1.0),('Hugo Extrato',3,10,5,5,8,1.0),
 ('Iara Extrato',1,10,9,9,8,NULL),('Iara Extrato',2,10,9,9,8,NULL),('Iara Extrato',3,10,9,9,8,NULL);
INSERT INTO "PerformanceTurno" (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca,
       corridas_ofertadas, corridas_aceitas, corridas_completadas, pedidos_concluidos, tempo_disponivel, hash_linha)
SELECT 9005, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('d',64)), e.id, ('2027-03-01'::date + p.d - 1), 'JANTAR 18H-22H', interval '4 hours', 'RIO',
       p.o, p.a, p.c, p.p, CASE WHEN p.t IS NULL THEN NULL ELSE make_interval(secs => (p.t * 3600)::float8) END,
       md5(e.id::text||p.d::text||'x')||md5(p.d::text||e.id::text||'x')
FROM px p JOIN "Entregador" e ON e.nome = p.nome AND e.id_empresa = 9005;
REFRESH MATERIALIZED VIEW mv_performance_dia;
-- faturamento (estagio A: ate 02/03; estagio B entra depois). fx: (nome, dia, tipo, categoria, valor, periodo)
CREATE TEMP TABLE fx (nome text, d int, tipo text, cat text, v numeric, per text);
INSERT INTO fx VALUES
 ('Alice Extrato',1,'Credito','Corridas',50,'JANTAR 18H-22H'),('Alice Extrato',1,'Credito','Promocao - W1',10,'jantar 18h-22h '),
 ('Alice Extrato',2,'Credito','Corridas',40,'JANTAR 18H-22H'),('Alice Extrato',1,'Debito','Corridas',999,'JANTAR 18H-22H'),
 ('Bento Extrato',1,'Credito','Corridas',100,'JANTAR 18H-22H'),('Bento Extrato',2,'Credito','Corridas',200,'JANTAR 18H-22H'),
 ('Bento Extrato',2,'Credito','Corridas',300,'ALMOCO 11H-14H'),
 ('Cida Extrato',1,'Credito','Corridas',70,'JANTAR 18H-22H'),('Cida Extrato',2,'Credito','Corridas',50,'JANTAR 18H-22H'),
 ('Davi Extrato',1,'Credito','Corridas',40,'JANTAR 18H-22H'),('Davi Extrato',2,'Credito','Corridas',40,'JANTAR 18H-22H'),
 ('Davi Extrato',1,'Credito','Outra',77,'JANTAR 18H-22H'),
 ('Elisa Extrato',1,'Credito','Corridas',500,'JANTAR 18H-22H'),('Fabio Extrato',1,'Credito','Corridas',15,'JANTAR 18H-22H'),
 ('Gil Extrato',1,'Credito','Corridas',999,'JANTAR 18H-22H'),
 ('Hugo Extrato',1,'Credito','Corridas',30,'JANTAR 18H-22H'),('Hugo Extrato',2,'Credito','Corridas',90,'JANTAR 18H-22H'),
 ('Iara Extrato',1,'Credito','Corridas',10,'JANTAR 18H-22H'),('Iara Extrato',2,'Credito','Corridas',10,'JANTAR 18H-22H'),
 ('Alice Extrato',1,'Credito','Gorjeta',5,NULL);
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, periodo, tipo, valor, descricao, hash_linha)
SELECT 9005, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('e',64)), e.id, ('2027-03-01'::date + f.d), ('2027-03-01'::date + f.d - 1),
       f.per, f.tipo, f.v, f.cat, md5(random()::text||f.nome||f.d||f.cat)||md5(clock_timestamp()::text||f.v)
FROM fx f JOIN "Entregador" e ON e.nome = f.nome AND e.id_empresa = 9005;
-- sem entregador identificado: nunca soma
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, periodo, tipo, valor, descricao, hash_linha)
VALUES (9005, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('e',64)), NULL, '2027-03-02', '2027-03-01', 'JANTAR 18H-22H', 'Credito', 5, 'Corridas', md5('sement')||md5('sement2'));
SQL
ADM5='adm5@example.com'; E9005='[9005]'
xbody() { # xbody <nome> <ini> <fim> <categorias-json> <base> <cortes-json> <min> <modais-json>
  jq -nc --arg nome "$1" --arg ini "$2" --arg fim "$3" --argjson cats "$4" --arg base "$5" --argjson cortes "$6" --argjson min "$7" --argjson modais "$8" --argjson prem "$PREMIOS_PADRAO" \
    '{nome:$nome,descricao:"d",dataInicio:$ini,dataFim:$fim,pracas:null,turnos:null,modais:$modais,minTurnos:$min,pesos:{aceitacao:0,conclusao:0,tempo:0,pedidos:0},cortes:$cortes,premios:$prem,avisar:true,visivelApp:true,tipo:"extrato",categorias:$cats,minTurnosBase:$base}'; }
XC='{"aceitacao":0.8,"conclusao":null,"tempo":0.7,"pedidos":null}'
XCATS='["Corridas","familia:promocao"]'
sal5() { salvar $ADM5 $E9005 9005 "$1" "$2"; }

hoje 2027-02-20
echo "  validacoes do extrato (RPC e CHECKs)"
check "0129/v: extrato sem categoria -> VALIDACAO" "$(tok "$(sal5 NULL "$(xbody X1x 2027-03-01 2027-03-03 null trabalhados "$XC" 2 '["moto"]')")")" "VALIDACAO"
check "0129/v: extrato com categorias [] -> VALIDACAO" "$(tok "$(sal5 NULL "$(xbody X1x 2027-03-01 2027-03-03 '[]' trabalhados "$XC" 2 '["moto"]')")")" "VALIDACAO"
check "0129/v: extrato sem NENHUM criterio (cortes todos nulos) -> VALIDACAO" "$(tok "$(sal5 NULL "$(xbody X1x 2027-03-01 2027-03-03 "$XCATS" trabalhados "$NOCUT" 2 '["moto"]')")")" "VALIDACAO"
check "0129/v: extrato com peso -> PESOS_INVALIDOS" "$(tok "$(sal5 NULL "$(xbody X1x 2027-03-01 2027-03-03 "$XCATS" trabalhados "$XC" 2 '["moto"]' | jq -c '.pesos.aceitacao=100')")")" "PESOS_INVALIDOS"
check "0129/v: base do minimo invalida -> VALIDACAO" "$(tok "$(sal5 NULL "$(xbody X1x 2027-03-01 2027-03-03 "$XCATS" qualquer "$XC" 2 '["moto"]')")")" "VALIDACAO"
check "0129/v: tipo desconhecido -> VALIDACAO" "$(tok "$(sal5 NULL "$(xbody X1x 2027-03-01 2027-03-03 "$XCATS" trabalhados "$XC" 2 '["moto"]' | jq -c '.tipo="outro"')")")" "VALIDACAO"
check "0129/v: 61 categorias -> VALIDACAO" "$(tok "$(sal5 NULL "$(xbody X1x 2027-03-01 2027-03-03 "$(seq 1 61 | jq -Rn '[inputs]' -c)" trabalhados "$XC" 2 '["moto"]')")")" "VALIDACAO"
check "0129/v: categoria de 201 caracteres -> VALIDACAO" "$(tok "$(sal5 NULL "$(xbody X1x 2027-03-01 2027-03-03 "[\"$(head -c 201 < /dev/zero | tr '\0' 'a')\"]" trabalhados "$XC" 2 '["moto"]')")")" "VALIDACAO"
check "0129/v (0133/D3): nota com categorias INVALIDAS (modo:todas) -> VALIDACAO; categorias validas passam" "$(tok "$(sal5 NULL "$(body Nx1 2027-03-01 2027-03-03 null null null 2 100 0 0 0 "$NOCUT" | jq -c '.categorias=["modo:todas"]')")")|$(tok "$(sal5 NULL "$(body Nx2 2027-03-01 2027-03-03 null null null 2 100 0 0 0 "$NOCUT" | jq -c '.categorias=["Corridas"]')")")" "VALIDACAO|"
check "0129/v: nota com minTurnosBase=validos -> VALIDACAO" "$(tok "$(sal5 NULL "$(body Nx1 2027-03-01 2027-03-03 null null null 2 100 0 0 0 "$NOCUT" | jq -c '.minTurnosBase="validos"')")")" "VALIDACAO"
ID_N5="$(sal5 NULL "$(body Nota9005 2027-03-01 2027-03-03 null null null 2 100 0 0 0 '{"aceitacao":0.5,"conclusao":null,"tempo":null,"pedidos":null}')")"
check "0129/v: nota sem os campos novos continua salvando (retrocompativel) com tipo=nota" "$(own "SELECT tipo||'|'||COALESCE(categorias::text,'NULL')||'|'||min_turnos_base FROM \"Campanha\" WHERE id=$ID_N5")" "nota|NULL|trabalhados"
DBINS() { ownx "INSERT INTO \"Campanha\"(id_empresa,nome,data_inicio,data_fim,min_turnos,peso_aceitacao,peso_conclusao,peso_tempo,peso_pedidos,corte_aceitacao,criada_por,tipo,categorias,min_turnos_base) VALUES (9005,'abc','2027-03-01','2027-03-02',1,$1,$2,0,0,$3,1,'$4',$5,'$6')"; }
check "0129/db: extrato sem categorias -> campanha_categorias_chk" "$(tok "$(DBINS 0 0 0.5 extrato NULL trabalhados)")" 'violates check constraint "campanha_categorias_chk"'
check "0129/db: extrato com categoria vazia '' -> campanha_categorias_chk" "$(tok "$(DBINS 0 0 0.5 extrato "ARRAY['']" trabalhados)")" 'violates check constraint "campanha_categorias_chk"'
check "0129/db (0133/D3): nota com categorias invalidas ('' ) -> campanha_categorias_chk; nota com categorias validas passa" "$(tok "$(DBINS 50 50 0.5 nota "ARRAY['']" trabalhados)")|$(tok "$(DBINS 50 50 0.5 nota "ARRAY['x']" trabalhados)")" 'violates check constraint "campanha_categorias_chk"|'
check "0129/db: extrato com peso -> campanha_pesos_chk" "$(tok "$(DBINS 50 50 0.5 extrato "ARRAY['x']" trabalhados)")" 'violates check constraint "campanha_pesos_chk"'
check "0129/db: extrato sem nenhum corte -> campanha_cortes_chk" "$(tok "$(DBINS 0 0 NULL extrato "ARRAY['x']" trabalhados)")" 'violates check constraint "campanha_cortes_chk"'
check "0129/db: nota com base=validos -> campanha_min_turnos_base_chk" "$(tok "$(DBINS 50 50 0.5 nota NULL validos)")" 'violates check constraint "campanha_min_turnos_base_chk"'
check "0129/db: nota com corte em peso 0 continua barrado -> campanha_cortes_chk" "$(tok "$(ownx "INSERT INTO \"Campanha\"(id_empresa,nome,data_inicio,data_fim,min_turnos,peso_aceitacao,peso_conclusao,peso_tempo,peso_pedidos,corte_conclusao,criada_por) VALUES (9005,'abc','2027-03-01','2027-03-02',1,100,0,0,0,0.5,1)")")" 'violates check constraint "campanha_cortes_chk"'
check "0129/db: tipo invalido e barrado por CHECK" "$(DBINS 0 0 0.5 fantasma "ARRAY['x']" trabalhados | grep -c 'violates check constraint')" "1"
check "0129: internas nao sao executaveis por authenticated (linha forjada leria outra empresa)" "$(own "SELECT has_function_privilege('authenticated','hub_campanha_turnos_extrato(\"Campanha\",int)','EXECUTE')::text||has_function_privilege('authenticated','hub_campanha_recalcular_extrato(\"Campanha\")','EXECUTE')::text")" "falsefalse"

echo "  seletor de categorias"
check "0129/cat: admin ve Corridas e Promocao - W1; Gorjeta (sem turno) e Outra... so as com turno" "$(rpc $ADM5 $E9005 9005 "SELECT string_agg(descricao, ',' ORDER BY descricao) FROM hub_campanha_categorias();")" "Corridas,Outra,Promocao - W1"
check "0129/cat: familia vem pronta (Promocao - W1 -> familia:promocao)" "$(rpc $ADM5 $E9005 9005 "SELECT familia FROM hub_campanha_categorias() WHERE descricao='Promocao - W1';")" "familia:promocao"
check "0129/cat: operador (sem gerir) -> PERMISSAO_NEGADA" "$(tok "$(rpc op5@example.com $E9005 9005 "SELECT * FROM hub_campanha_categorias();")")" "PERMISSAO_NEGADA"
check "0129/cat: outra empresa (9002) nao ve as categorias da 9005" "$(rpc admb@example.com '[9002]' 9002 "SELECT count(*) FROM hub_campanha_categorias();")" "0"

echo "  lancar e imutabilidade"
ID_X1="$(sal5 NULL "$(xbody 'Melhor extrato' 2027-03-01 2027-03-03 "$XCATS" trabalhados "$XC" 2 '["moto"]')")"
check "0129: salvar extrato devolve id" "$(printf '%s' "$ID_X1" | grep -cE '^[0-9]+$')" "1"
check "0129: gravou tipo/categorias/base" "$(own "SELECT tipo||'|'||array_to_string(categorias,',')||'|'||min_turnos_base FROM \"Campanha\" WHERE id=$ID_X1")" "extrato|Corridas,familia:promocao|trabalhados"
ID_X2="$(sal5 NULL "$(xbody 'Extrato base validos' 2027-03-01 2027-03-03 "$XCATS" validos "$XC" 2 '["moto"]')")"
ID_XF="$(sal5 NULL "$(xbody 'Extrato fantasma' 2027-03-01 2027-03-03 '["Categoria Fantasma"]' trabalhados "$XC" 2 '["moto"]')")"
ID_X6="$(sal5 NULL "$(xbody 'Extrato familia so' 2027-03-01 2027-03-03 '["familia:promocao"]' trabalhados "$XC" 2 '["moto"]')")"
check "0129/lancar: categoria salva que nao existe mais -> OPCAO_DESCONHECIDA" "$(tok "$(rpc $ADM5 $E9005 9005 "SELECT hub_campanha_lancar($ID_XF);")")" "OPCAO_DESCONHECIDA"
check "0129/lancar: so familia (token) lanca" "$(tok "$(rpc $ADM5 $E9005 9005 "SELECT hub_campanha_lancar($ID_X6);")")" ""
check "0129/lancar: extrato com nomes + familia lanca" "$(tok "$(rpc $ADM5 $E9005 9005 "SELECT hub_campanha_lancar($ID_X1);")")" ""
check "0129/lancar: extrato base validos lanca" "$(tok "$(rpc $ADM5 $E9005 9005 "SELECT hub_campanha_lancar($ID_X2);")")" ""
check "0129/B2: salvar com familia fora da allowlist (familia:foo) -> VALIDACAO" "$(tok "$(sal5 NULL "$(xbody X1x 2027-03-01 2027-03-03 '["familia:foo"]' trabalhados "$XC" 2 '["moto"]')")")" "VALIDACAO"
check "0131/campanha: seletor traz primeira (data de CHEGADA, criado_em em SP) por categoria" "$(rpc $ADM5 $E9005 9005 "SELECT string_agg(descricao||'='||primeira, ',' ORDER BY descricao) FROM hub_campanha_categorias();")" "$(own "SELECT string_agg(descricao||'='||m, ',' ORDER BY descricao) FROM (SELECT f.descricao, (min(f.criado_em) AT TIME ZONE 'America/Sao_Paulo')::date m FROM \"FaturamentoLancamento\" f WHERE f.id_empresa=9005 AND f.tipo='Credito' AND f.data_referencia >= '2027-02-20'::date-90 GROUP BY f.descricao HAVING count(f.entregador_id)>0 AND count(NULLIF(btrim(f.periodo),''))>0) t")"
ID_XB="$(sal5 NULL "$(xbody 'Extrato familia ruim' 2027-03-01 2027-03-03 '["familia:promocao"]' trabalhados "$XC" 2 '["moto"]')")"
CHK_DEF="$(own "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='campanha_categorias_chk'")"
own "ALTER TABLE \"Campanha\" DROP CONSTRAINT campanha_categorias_chk" >/dev/null
own "UPDATE \"Campanha\" SET categorias=ARRAY['familia:foo'] WHERE id=$ID_XB" >/dev/null
check "0129/B2: lancar com token de familia desconhecido (gravado por fora da RPC) -> OPCAO_DESCONHECIDA" "$(tok "$(rpc $ADM5 $E9005 9005 "SELECT hub_campanha_lancar($ID_XB);")")" "OPCAO_DESCONHECIDA"
# 0131: familias vem de hub_adiantamento_familias() (inclui indicador); a campanha NAO tem o modo "todas".
# Reaproveita o rascunho ID_XB (sem criar campanha nova: os contadores dos blocos seguintes nao mudam).
echo "  0131: familia:indicador aceita, modo: recusado"
own "UPDATE \"Campanha\" SET categorias=ARRAY['modo:todas'] WHERE id=$ID_XB" >/dev/null
check "0131/campanha: lancar com modo: (gravado por fora, sem o CHECK) -> OPCAO_DESCONHECIDA" "$(tok "$(rpc $ADM5 $E9005 9005 "SELECT hub_campanha_lancar($ID_XB);")")" "OPCAO_DESCONHECIDA"
own "UPDATE \"Campanha\" SET categorias=ARRAY['Corridas'] WHERE id=$ID_XB" >/dev/null
own "ALTER TABLE \"Campanha\" ADD CONSTRAINT campanha_categorias_chk $CHK_DEF" >/dev/null
check "0131/campanha: CHECK reposto (campanha_categorias_chk existe)" "$(own "SELECT count(*) FROM pg_constraint WHERE conname='campanha_categorias_chk'")" "1"
check "0131/campanha: salvar (edita o rascunho) com familia:indicador grava" "$(tok "$(sal5 $ID_XB "$(xbody 'Extrato familia ruim' 2027-03-01 2027-03-03 '["Corridas","familia:indicador"]' trabalhados "$XC" 2 '["moto"]')")")|$(own "SELECT array_to_string(categorias,',') FROM \"Campanha\" WHERE id=$ID_XB")" "|Corridas,familia:indicador"
check "0131/campanha: lancar com familia:indicador NAO recusa (ROLLBACK: o rascunho segue rascunho)" "$(psql_relaxed -tA 2>&1 <<SQL | grep -c 'OPCAO_DESCONHECIDA'
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub',(SELECT id FROM "Usuario" WHERE email='$ADM5'),'empresa_ativa','9005','escopo','$E9005'::jsonb)::text, true);
SET ROLE authenticated;
SELECT hub_campanha_lancar($ID_XB);
ROLLBACK;
SQL
)" "0"
check "0131/campanha: o rascunho continua nao lancado depois do ROLLBACK" "$(own "SELECT lancada_em IS NULL FROM \"Campanha\" WHERE id=$ID_XB")" "t"
check "0131/campanha: salvar com modo:todas -> VALIDACAO" "$(tok "$(sal5 NULL "$(xbody X1x 2027-03-01 2027-03-03 '["modo:todas","Corridas"]' trabalhados "$XC" 2 '["moto"]')")")" "VALIDACAO"
check "0131/campanha: salvar com modo:outro -> VALIDACAO" "$(tok "$(sal5 NULL "$(xbody X1x 2027-03-01 2027-03-03 '["modo:outro"]' trabalhados "$XC" 2 '["moto"]')")")" "VALIDACAO"
check "0131/campanha: CHECK recusa modo:todas gravado por fora" "$(tok "$(DBINS 0 0 0.5 extrato "ARRAY['modo:todas','Corridas']" trabalhados)")" 'violates check constraint "campanha_categorias_chk"'
check "0131/campanha: CHECK recusa familia:foo gravada por fora" "$(tok "$(DBINS 0 0 0.5 extrato "ARRAY['familia:foo']" trabalhados)")" 'violates check constraint "campanha_categorias_chk"'
# B1: extrato com corte de pedidos em empresa SEM cobertura de pedidos (9003) lanca: leitura ausente so nao valida o turno
ID_XP="$(salvar adm3@example.com '[9003]' 9003 NULL "$(xbody 'Extrato pedidos' 2027-03-01 2027-03-03 '["familia:promocao"]' trabalhados '{"aceitacao":null,"conclusao":null,"tempo":null,"pedidos":3}' 1 null)")"
check "0129/B1: extrato com corte de pedidos lanca mesmo sem cobertura de pedidos (nao ha peso para zerar)" "$(tok "$(rpc adm3@example.com '[9003]' 9003 "SELECT hub_campanha_lancar($ID_XP);")")|$(own "SELECT lancada_em IS NOT NULL FROM \"Campanha\" WHERE id=$ID_XP")" "|t"
for col in "categorias=ARRAY['Outra']" "min_turnos_base='validos'" "tipo='nota'" "corte_tempo=0.1"; do
  check "0129/imutavel: depois de lancar, UPDATE de $col -> CAMPANHA_IMUTAVEL" "$(tok "$(ownx "UPDATE \"Campanha\" SET $col WHERE id=$ID_X1")")" "CAMPANHA_IMUTAVEL"
done
check "0129/imutavel: salvar de campanha lancada -> CAMPANHA_IMUTAVEL" "$(tok "$(sal5 $ID_X1 "$(xbody 'Melhor extrato' 2027-03-01 2027-03-03 '["Corridas"]' trabalhados "$XC" 2 '["moto"]')")")" "CAMPANHA_IMUTAVEL"

RK() { own "SELECT string_agg(e.nome||'|'||r.situacao||'|'||COALESCE(r.posicao::text,'-')||'|'||COALESCE(r.posicao_anterior::text,'-')||'|'||r.turnos||'|'||r.turnos_validos||'|'||r.valor_centavos, E'\\n' ORDER BY r.posicao NULLS LAST, e.nome) FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$1"; }
TURNOS() { own "SELECT string_agg(data_periodo::text||'|'||valido||'|'||tem_valor||'|'||valor_centavos||'|'||motivo::text, ';' ORDER BY data_periodo) FROM hub_campanha_turnos_extrato((SELECT c FROM \"Campanha\" c WHERE id=$1), (SELECT id FROM \"Entregador\" WHERE nome='$2'))"; }

echo "  estagio A: faturamento ate 02/03 (d3 aguardando), perfomance ate 03/03"
hoje 2027-03-04
R="$(rpc $ADM5 $E9005 9005 "SELECT hub_campanha_recalcular($ID_X1);")"
check "0129/A: recalcular devolve contagens (classificados=5, sem_minimo=2, sem_modal=1)" "$(printf '%s' "$R" | jq -c '[.classificados,.sem_minimo,.sem_modal,.abaixo_corte]')" "[5,2,1,0]"
check "0129/A: ranking (valor desc, validos desc; turno pendente e valido mas NAO soma; Gil CARRO fora; debito/outra categoria/sem turno/sem entregador nao contam)" "$(RK $ID_X1)" "Cida Extrato|classificado|1|-|2|2|12000
Alice Extrato|classificado|2|-|3|3|10000
Bento Extrato|classificado|3|-|3|2|10000
Davi Extrato|classificado|4|-|3|3|8000
Hugo Extrato|classificado|5|-|3|1|3000
Elisa Extrato|sem_minimo|-|-|1|1|50000
Fabio Extrato|sem_modal|-|-|3|3|1500
Iara Extrato|sem_minimo|-|-|3|0|0"
check "0129/A: dados_ate = LEAST(perf 03/03, faturamento 02/03) = 02/03" "$(own "SELECT dados_ate FROM \"Campanha\" WHERE id=$ID_X1")" "2027-03-02"
check "0129/turno: Alice (valido+valor | valido+valor | valido aguardando)" "$(TURNOS $ID_X1 'Alice Extrato')" "2027-03-01|true|true|6000|{};2027-03-02|true|true|4000|{};2027-03-03|true|false|0|{}"
check "0129/turno: Bento (valido | INVALIDO por aceitacao, com o valor que deixou de somar | pendente)" "$(TURNOS $ID_X1 'Bento Extrato')" "2027-03-01|true|true|10000|{};2027-03-02|false|true|20000|{aceitacao};2027-03-03|true|false|0|{}"
check "0129/turno: Hugo (valido | tempo | aceitacao+tempo)" "$(TURNOS $ID_X1 'Hugo Extrato')" "2027-03-01|true|true|3000|{};2027-03-02|false|true|9000|{tempo};2027-03-03|false|false|0|{aceitacao,tempo}"
check "0129/turno: Iara sem leitura de tempo NAO cumpre o criterio (fail-closed)" "$(TURNOS $ID_X1 'Iara Extrato')" "2027-03-01|false|true|1000|{tempo};2027-03-02|false|true|1000|{tempo};2027-03-03|false|false|0|{tempo}"
check "0129/turno: categoria por nome E por familia (Alice d1 = Corridas 50 + 'Promocao - W1' 10; periodo com caixa/espaco diferentes casa)" "$(own "SELECT valor_centavos FROM hub_campanha_turnos_extrato((SELECT c FROM \"Campanha\" c WHERE id=$ID_X1), (SELECT id FROM \"Entregador\" WHERE nome='Alice Extrato')) WHERE data_periodo='2027-03-01'")" "6000"
check "0129/turno: so a familia (X6) soma apenas a Promocao: Alice d1 = 1000" "$(own "SELECT valor_centavos FROM hub_campanha_turnos_extrato((SELECT c FROM \"Campanha\" c WHERE id=$ID_X6), (SELECT id FROM \"Entregador\" WHERE nome='Alice Extrato')) WHERE data_periodo='2027-03-01'")" "1000"

echo "  estagio B: chega o faturamento de 03/03"
psql_t -q <<'SQL' >"$TMP/seed129b.log" 2>&1 || { echo "FAIL: seed 0129b"; cat "$TMP/seed129b.log"; exit 1; }
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, periodo, tipo, valor, descricao, hash_linha)
SELECT 9005, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('e',64)), e.id, '2027-03-04', '2027-03-03', 'JANTAR 18H-22H', 'Credito', v.v, 'Corridas', md5(v.n||'b')||md5(v.n||'bb')
FROM (VALUES ('Alice Extrato',20),('Davi Extrato',40),('Hugo Extrato',5),('Iara Extrato',10)) v(n, v) JOIN "Entregador" e ON e.nome = v.n AND e.id_empresa = 9005;
-- Bento d3 (turno valido): faturamento chegou, mas so em categoria NAO marcada (M3)
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, periodo, tipo, valor, descricao, hash_linha)
SELECT 9005, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('e',64)), e.id, '2027-03-04', '2027-03-03', 'JANTAR 18H-22H', 'Credito', 7, 'Outra', md5('m3a')||md5('m3b')
FROM "Entregador" e WHERE e.nome='Bento Extrato' AND e.id_empresa=9005;
SQL
rpc $ADM5 $E9005 9005 "SELECT hub_campanha_recalcular($ID_X1);" >/dev/null
check "0129/B: ranking final (Alice x Davi empatam em valor e validos: desempata pelo id; posicao_anterior = a do estagio A)" "$(RK $ID_X1)" "Alice Extrato|classificado|1|2|3|3|12000
Davi Extrato|classificado|2|4|3|3|12000
Cida Extrato|classificado|3|1|2|2|12000
Bento Extrato|classificado|4|3|3|2|10000
Hugo Extrato|classificado|5|5|3|1|3000
Elisa Extrato|sem_minimo|-|-|1|1|50000
Fabio Extrato|sem_modal|-|-|3|3|1500
Iara Extrato|sem_minimo|-|-|3|0|0"
check "0129/M3: turno valido com faturamento so em OUTRA categoria: tem_valor=true e valor 0 (nao fica 'aguardando' para sempre)" "$(TURNOS $ID_X1 'Bento Extrato' | tr ';' '\n' | tail -1)" "2027-03-03|true|true|0|{}"
check "0129/B: dados_ate avancou para 03/03" "$(own "SELECT dados_ate FROM \"Campanha\" WHERE id=$ID_X1")" "2027-03-03"
rpc $ADM5 $E9005 9005 "SELECT hub_campanha_recalcular($ID_X1);" >/dev/null
check "0129/B: recalcular de novo com o MESMO dado preserva posicao_anterior" "$(own "SELECT string_agg(e.nome||'='||r.posicao_anterior, ',' ORDER BY r.posicao) FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$ID_X1 AND r.posicao <= 4")" "Alice Extrato=2,Davi Extrato=4,Cida Extrato=1,Bento Extrato=3"
check "0129/E6: minimo de turnos trabalhados atingido (3>=2) mas 0 turnos validos (Iara) -> sem_minimo, nao classificado" "$(own "SELECT situacao||'|'||COALESCE(posicao::text,'-') FROM \"CampanhaRanking\" WHERE campanha_id=$ID_X1 AND entregador_id=(SELECT id FROM \"Entregador\" WHERE nome='Iara Extrato')")" "sem_minimo|-"
check "0129/contagem: totais do extrato no item = soma do ranking (classificado+sem_minimo)" "$(own "SELECT (j->'contagem'->>'valorCentavos')||'|'||(j->'contagem'->>'turnosValidos') FROM (SELECT hub_campanha_item_json(c) j FROM \"Campanha\" c WHERE id=$ID_X1) s")" "$(own "SELECT COALESCE(sum(valor_centavos),0)||'|'||COALESCE(sum(turnos_validos),0) FROM \"CampanhaRanking\" WHERE campanha_id=$ID_X1 AND situacao IN ('classificado','sem_minimo')")"
check "0129/base: minimo por turnos VALIDOS (X2): Hugo (1 valido) e Iara (0) caem para sem_minimo; o topo e o mesmo" "$(rpc $ADM5 $E9005 9005 "SELECT hub_campanha_recalcular($ID_X2);" >/dev/null; own "SELECT string_agg(e.nome||'|'||r.situacao||'|'||COALESCE(r.posicao::text,'-'), ',' ORDER BY r.posicao NULLS LAST, e.nome) FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$ID_X2")" "Alice Extrato|classificado|1,Davi Extrato|classificado|2,Cida Extrato|classificado|3,Bento Extrato|classificado|4,Elisa Extrato|sem_minimo|-,Fabio Extrato|sem_modal|-,Hugo Extrato|sem_minimo|-,Iara Extrato|sem_minimo|-"
check "0129/nota: campanha 'nota' ganha as colunas novas NULAS (regressao: o motor da nota nao as toca)" "$(own "SELECT count(*) FROM \"CampanhaRanking\" WHERE campanha_id=$ID_A AND (turnos_validos IS NOT NULL OR valor_centavos IS NOT NULL)")|$(own "SELECT tipo FROM \"Campanha\" WHERE id=$ID_A")" "0|nota"

echo "  hub: ranking, detalhe, lista"
check "0129/hub: hub_campanha_ranking traz turnos_validos e valor_centavos (e nome completo)" "$(rpc $ADM5 $E9005 9005 "SELECT posicao||'|'||nome||'|'||turnos||'|'||turnos_validos||'|'||valor_centavos FROM hub_campanha_ranking($ID_X1,'classificado',2,0);")" "1|Alice Extrato|3|3|12000
2|Davi Extrato|3|3|12000"
check "0129/hub: detalhe traz tipo, categorias e minTurnosBase" "$(rpc $ADM5 $E9005 9005 "SELECT hub_campanha_detalhe($ID_X1);" | jq -c '[.tipo,.categorias,.minTurnosBase]')" '["extrato",["Corridas","familia:promocao"],"trabalhados"]'
check "0129/hub: lista traz tipo" "$(rpc $ADM5 $E9005 9005 "SELECT count(*) FROM hub_campanha_listar(9005,NULL) l WHERE l.item->>'tipo'='extrato';")" "5"
check "0129/hub: campanha de OUTRA empresa continua 404 no ranking" "$(tok "$(rpc admb@example.com '[9002]' 9002 "SELECT * FROM hub_campanha_ranking($ID_X1,NULL,10,0);")")" "CAMPANHA_NAO_ENCONTRADA"

echo "  app: privacidade (X2/E7)"
CA='90500000000001'; CB='90500000000002'
JA="$(app $CA "SELECT hub_motorista_campanha($ID_X1);")"
JB="$(app $CB "SELECT hub_motorista_campanha($ID_X1);")"
check "0129/app: top10 do extrato SO com posicao e nomeAbreviado (exato)" "$(printf '%s' "$JA" | jq -c '.top10')" '[{"posicao":1,"nomeAbreviado":"Alice E."},{"posicao":2,"nomeAbreviado":"Davi E."},{"posicao":3,"nomeAbreviado":"Cida E."},{"posicao":4,"nomeAbreviado":"Bento E."},{"posicao":5,"nomeAbreviado":"Hugo E."}]'
check "0129/app: nenhuma chave de valor/centavos/nota/turnos/souEu no top10 (nem no de quem esta em 4o)" "$(printf '%s\n%s' "$(printf '%s' "$JA" | jq -c '.top10')" "$(printf '%s' "$JB" | jq -c '.top10')" | grep -ciE 'valor|centavos|nota"|turnos|souEu')" "0"
check "0129/app: nao ha podio/lider/acima com dado de terceiros" "$(printf '%s' "$JA" | jq -c '[.lider, (.eu|has("acima")), (.eu|has("nota"))]')" "[null,false,false]"
check "0129/app: eu = proprio valor e turnos (Alice)" "$(printf '%s' "$JA" | jq -c '[.eu.posicao,.eu.turnos,.eu.turnosValidos,.eu.valorCentavos,.eu.situacao]')" '[1,3,3,12000,"classificado"]'
check "0129/app: payload do Bento (4o) nao contem o valor da Alice (12000) em lugar nenhum" "$(printf '%s' "$JB" | grep -c '12000')" "0"
check "0129/app: payload do Bento traz o PROPRIO valor (10000) e posicao 4" "$(printf '%s' "$JB" | jq -c '[.eu.posicao,.eu.valorCentavos,.eu.turnosValidos]')" "[4,10000,2]"
check "0129/app: campanha traz tipo e minTurnosBase" "$(printf '%s' "$JA" | jq -c '[.campanha.tipo,.campanha.minTurnosBase]')" '["extrato","trabalhados"]'
check "0129/app: a lista do app traz o tipo" "$(app $CA "SELECT hub_motorista_campanhas();" | jq -r '[.[]|select(.id=='$ID_X1')|.tipo]|first')" "extrato"
echo "  app: turnos do proprio motorista"
check "0129/app/turnos: Alice (so os dela, mais recente primeiro; soma = 12000)" "$(app $CA "SELECT hub_motorista_campanha_turnos($ID_X1);" | jq -c '[[.[]|[.data,.valido,.temValor,.valorCentavos]], ([.[].valorCentavos]|add)]')" '[[["2027-03-03",true,true,2000],["2027-03-02",true,true,4000],["2027-03-01",true,true,6000]],12000]'
check "0129/app/turnos: Bento — invalido com motivo, valor lido e minimo; pendente sem valor" "$(app $CB "SELECT hub_motorista_campanha_turnos($ID_X1);" | jq -cS 'walk(if type=="number" then .+0 else . end)|[.[]|{d:.data,v:.valido,t:.temValor,c:.valorCentavos,m:.motivos}]')" '[{"c":0,"d":"2027-03-03","m":[],"t":true,"v":true},{"c":20000,"d":"2027-03-02","m":[{"criterio":"aceitacao","lido":0.7,"minimo":0.8}],"t":true,"v":false},{"c":10000,"d":"2027-03-01","m":[],"t":true,"v":true}]'
check "0129/app/turnos: motivo de tempo traz lido e minimo (Hugo 02/03: 25% vs 70%)" "$(app 90500000000008 "SELECT hub_motorista_campanha_turnos($ID_X1);" | jq -cS 'walk(if type=="number" then .+0 else . end)|.[]|select(.data=="2027-03-02")|.motivos')" '[{"criterio":"tempo","lido":0.25,"minimo":0.7}]'
check "0129/app/turnos: motorista de OUTRA empresa -> CAMPANHA_NAO_ENCONTRADA" "$(tok "$(app 90000000000101 "SELECT hub_motorista_campanha_turnos($ID_X1);")")" "CAMPANHA_NAO_ENCONTRADA"
check "0129/app/turnos: campanha 'nota' devolve lista vazia" "$(app 90000000000001 "SELECT hub_motorista_campanha_turnos($ID_A);")" "[]"
check "0129/app/turnos: sem sessao de motorista (claim de hub) -> SEM_VINCULO" "$(tok "$(rpc $ADM5 $E9005 9005 "SELECT hub_motorista_campanha_turnos($ID_X1);")")" "SEM_VINCULO"

echo "  fechamento do extrato: so em fim+3 (E5)"
hoje 2027-03-05
R="$(rpc $ADM5 $E9005 9005 "SELECT hub_campanhas_recalcular_ativas(9005);")"
check "0129/fecha: fim+2 (dado ja cobre data_fim) NAO fecha o extrato" "$(printf '%s' "$R" | jq -c '.fechadas')|$(own "SELECT fechada_em IS NULL FROM \"Campanha\" WHERE id=$ID_X1")" "0|t"
check "0129/fecha: fechar manual antes de fim+3 -> FECHAMENTO_ANTECIPADO" "$(tok "$(rpc $ADM5 $E9005 9005 "SELECT hub_campanha_fechar($ID_X6);")")" "FECHAMENTO_ANTECIPADO"
hoje 2027-03-06
check "0129/fecha: fechar manual em fim+3 libera" "$(tok "$(rpc $ADM5 $E9005 9005 "SELECT hub_campanha_fechar($ID_X6);")")|$(own "SELECT fechada_em IS NOT NULL FROM \"Campanha\" WHERE id=$ID_X6")" "|t"
R="$(rpc $ADM5 $E9005 9005 "SELECT hub_campanhas_recalcular_ativas(9005);")"
check "0129/M1: em fim+3 so com PERFORMANCE (sem faturamento importado a partir de fim+3) NAO fecha o extrato" "$(printf '%s' "$R" | jq -c '.fechadas')|$(own "SELECT count(*) FROM \"Campanha\" WHERE id IN ($ID_X1,$ID_X2) AND fechada_em IS NOT NULL")" "0|0"
own "INSERT INTO \"FaturamentoLancamento\" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, periodo, tipo, valor, descricao, hash_linha, criado_em)
     SELECT 9005, (SELECT id FROM \"ImportacaoArquivo\" WHERE hash_sha256=repeat('e',64)), e.id, '2027-03-06', '2027-03-03', 'JANTAR 18H-22H', 'Credito', 5, 'Corridas', md5('m1a')||md5('m1b'), '2027-03-06 09:00-03'
     FROM \"Entregador\" e WHERE e.nome='Alice Extrato' AND e.id_empresa=9005" >/dev/null
R="$(rpc $ADM5 $E9005 9005 "SELECT hub_campanhas_recalcular_ativas(9005);")"
check "0129/M1: com faturamento criado em fim+3 o recalculo das ativas FECHA os 2 extratos" "$(printf '%s' "$R" | jq -c '.fechadas')|$(own "SELECT count(*) FROM \"Campanha\" WHERE id IN ($ID_X1,$ID_X2) AND fechada_em IS NOT NULL")" "2|2"
check "0129/M1: o valor desse faturamento entrou no ranking final (Alice 12000 + 500)" "$(own "SELECT valor_centavos FROM \"CampanhaRanking\" WHERE campanha_id=$ID_X1 AND entregador_id=(SELECT id FROM \"Entregador\" WHERE nome='Alice Extrato')")" "12500"
L0="$(TURNOS $ID_X1 'Alice Extrato')"
own "INSERT INTO \"FaturamentoLancamento\" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, periodo, tipo, valor, descricao, hash_linha, criado_em)
     SELECT 9005, (SELECT id FROM \"ImportacaoArquivo\" WHERE hash_sha256=repeat('e',64)), e.id, '2027-03-07', '2027-03-01', 'JANTAR 18H-22H', 'Credito', 99, 'Corridas', md5('m2a')||md5('m2b'), now() + interval '1 hour'
     FROM \"Entregador\" e WHERE e.nome='Alice Extrato' AND e.id_empresa=9005" >/dev/null
check "0129/M2: faturamento criado DEPOIS de fechada_em nao muda a lista de turnos (bate com o ranking congelado)" "$(TURNOS $ID_X1 'Alice Extrato')" "$L0"
check "0129/M2: ... e o d1 continua em 6000 (sem o +9900)" "$(TURNOS $ID_X1 'Alice Extrato' | tr ';' '\n' | head -1)" "2027-03-01|true|true|6000|{}"
check "0129/fecha: vencedores do extrato = posicoes 1..3 (Alice, Davi, Cida)" "$(own "SELECT string_agg(v.posicao||'='||e.nome, ',' ORDER BY v.posicao) FROM \"CampanhaVencedor\" v JOIN \"Entregador\" e ON e.id=v.entregador_id WHERE v.campanha_id=$ID_X1")" "1=Alice Extrato,2=Davi Extrato,3=Cida Extrato"
# (a nota segue fechando em fim+1: coberto pelo teste M1 desta suite, que roda sobre a funcao ja redefinida pela 0129)

echo "--- 0132: interruptor de visibilidade no app + so a posicao (sem total) ---"
psql_t -q <<'SQL' >"$TMP/seed132.log" 2>&1 || { echo "FAIL: seed 0132"; cat "$TMP/seed132.log"; exit 1; }
INSERT INTO "Usuario" (email, senha_hash, nome) VALUES ('adm9@example.com','x','Adm 9008'),('op9@example.com','x','Op 9008');
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ((SELECT id FROM "Usuario" WHERE email='adm9@example.com'), 9008, (SELECT id FROM "Papel" WHERE nome='admin_entidade'), true),
  ((SELECT id FROM "Usuario" WHERE email='op9@example.com'),  9008, (SELECT id FROM "Papel" WHERE nome='operador'), true);
INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo) SELECT m.id, 9008, true FROM "Modulo" m WHERE m.codigo = 'campanhas';
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('90800000000001','Vera Visivel'),('90800000000002','Caio Visivel');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id, dados_entrego_json)
  SELECT 9008, gen_random_uuid(), cm.nome, cm.id, '{"informacoesEntrega":{"modal":"MOTO"}}'::jsonb
  FROM "ContaMotorista" cm WHERE cm.cnpj_prestador IN ('90800000000001','90800000000002');
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES (9008,'performance',repeat('8',64),'completed');
INSERT INTO "PerformanceTurno" (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca,
       corridas_ofertadas, corridas_aceitas, corridas_completadas, pedidos_concluidos, tempo_disponivel, hash_linha)
SELECT 9008, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('8',64)), e.id, d::date, 'JANTAR 18H-22H', interval '4 hours', 'SAO PAULO',
       10, CASE WHEN e.nome='Vera Visivel' THEN 9 ELSE 8 END, 8, 5, interval '3 hours', md5(e.id::text||d::text||'v132')||md5(d::text||e.id::text||'v132')
FROM "Entregador" e CROSS JOIN generate_series('2027-06-01'::date,'2027-06-03'::date,'1 day') d WHERE e.id_empresa=9008;
REFRESH MATERIALIZED VIEW mv_performance_dia;
SQL
ADM9='adm9@example.com'; OP9='op9@example.com'; E9008='[9008]'; V1=90800000000001
sal9() { salvar $ADM9 $E9008 9008 "$1" "$2"; }
sem_vis() { jq -c 'del(.visivelApp)'; }       # corpo SEM a chave: o padrao do banco
nbody() { body "$1" 2027-06-01 2027-06-03 null null null 1 100 0 0 0 "$NOCUT" | sem_vis; }
hoje 2027-05-25; hora 09:00
VN="$(sal9 NULL "$(nbody 'Vis nota oculta')")"
VX="$(sal9 NULL "$(xbody 'Vis extrato oculta' 2027-06-01 2027-06-03 '["familia:promocao"]' trabalhados "$XC" 1 'null' | sem_vis)")"
VF="$(sal9 NULL "$(nbody 'Vis nota fim visivel' | jq -c '.visivelApp=true')")"
VC="$(sal9 NULL "$(nbody 'Vis nota fim oculta')")"
VK="$(sal9 NULL "$(nbody 'Vis nota cancelar')")"
VR="$(sal9 NULL "$(nbody 'Vis rascunho')")"
check "0132: seed criou 6 campanhas (ids numericos)" "$(printf '%s\n' $VN $VX $VF $VC $VK $VR | grep -cE '^[0-9]+$')" "6"
check "0132/oculta: salvar sem visivelApp -> nasce oculta (DEFAULT false), nota e extrato" "$(own "SELECT string_agg(visivel_app::text, ',' ORDER BY id) FROM \"Campanha\" WHERE id IN ($VN,$VX)")" "false,false"
check "0132/oculta: salvar com visivelApp=true grava true" "$(own "SELECT visivel_app FROM \"Campanha\" WHERE id=$VF")" "t"
check "0132/salvar: visivelApp nao-boolean -> VALIDACAO" "$(tok "$(sal9 $VR "$(nbody 'Vis rascunho' | jq -c '.visivelApp="sim"')")")" "VALIDACAO"
check "0132/salvar: item json do hub traz visivelApp" "$(rpc $ADM9 $E9008 9008 "SELECT item FROM hub_campanha_listar(9008, NULL);" | jq -c --argjson id $VF 'select(.id==$id)|.visivelApp')" "true"
# edicao do rascunho: sem a chave MANTEM o valor atual
sal9 $VF "$(nbody 'Vis nota fim visivel editada')" >/dev/null
check "0132/salvar: editar rascunho visivel SEM a chave mantem true" "$(own "SELECT visivel_app||'|'||nome FROM \"Campanha\" WHERE id=$VF")" "true|Vis nota fim visivel editada"
sal9 $VF "$(nbody 'Vis nota fim visivel editada' | jq -c '.visivelApp=false')" >/dev/null
check "0132/salvar: editar rascunho com visivelApp=false desliga" "$(own "SELECT visivel_app FROM \"Campanha\" WHERE id=$VF")" "f"
sal9 $VF "$(nbody 'Vis nota fim visivel editada' | jq -c '.visivelApp=true')" >/dev/null
check "0132/auditoria via salvar: criar com true + (true->false) + (false->true) = 3 registros; editar sem mudar nao grava" "$(own "SELECT string_agg((detalhes->>'de')||'>'||(detalhes->>'para'), ' ' ORDER BY id) FROM \"Auditoria\" WHERE acao='campanha.visibilidade' AND recurso_id='$VF'")" "false>true true>false false>true"
check "0132/auditoria: funcao interna nao e executavel por authenticated nem PUBLIC" "$(own "SELECT has_function_privilege('public','hub_campanha_auditar_visibilidade(int,boolean,boolean)','EXECUTE')::text||has_function_privilege('authenticated','hub_campanha_auditar_visibilidade(int,boolean,boolean)','EXECUTE')::text")" "falsefalse"
# premios com foto para o caso da foto
PNV="$(own "SELECT id FROM \"CampanhaPremio\" WHERE campanha_id=$VN LIMIT 1")"
rpc $ADM9 $E9008 9008 "SELECT hub_campanha_premio_foto_salvar($VN,$PNV,'image/png','$PNG');" >/dev/null
for i in $VN $VX $VF $VC $VK; do rpc $ADM9 $E9008 9008 "SELECT hub_campanha_lancar($i);" >/dev/null; done
check "0132: as 5 campanhas lancaram" "$(own "SELECT count(*) FROM \"Campanha\" WHERE id IN ($VN,$VX,$VF,$VC,$VK) AND lancada_em IS NOT NULL")" "5"
hoje 2027-06-02
own "SELECT hub_campanha_recalcular_interno(i) FROM unnest(ARRAY[$VN,$VX,$VF,$VC,$VK]) i" >/dev/null

# ---- oculta some do app inteiro ----
if [ "${CAMP_NEG:-}" = visibilidade ]; then
  patch_fn 'hub_campanha_visivel("Campanha",integer)' 's/AND c\.visivel_app//'
  own "SELECT pg_get_functiondef('hub_campanha_visivel(\"Campanha\",integer)'::regprocedure) ~ 'c[.]visivel_app'" | grep -q f || { echo "ABORTA: reversao visibilidade nao esta no corpo vivo — controle OCO"; exit 1; }
  echo "NEG visibilidade: AND c.visivel_app removido do corpo vivo (conferido)"
fi
check "0132/oculta: lista do app NAO traz as ocultas (nota e extrato)" "$(app $V1 "SELECT hub_motorista_campanhas();" | jq -c --argjson a $VN --argjson b $VX '[.[]|select(.id==$a or .id==$b)]|length')" "0"
check "0132/oculta: a lista traz so a visivel (VF) e a cancelavel oculta nao" "$(app $V1 "SELECT hub_motorista_campanhas();" | jq -c '[.[].id]')" "[$VF]"
check "0132/oculta: detalhe da nota oculta -> CAMPANHA_NAO_ENCONTRADA" "$(tok "$(app $V1 "SELECT hub_motorista_campanha($VN);")")" "CAMPANHA_NAO_ENCONTRADA"
check "0132/oculta: detalhe do extrato oculto -> CAMPANHA_NAO_ENCONTRADA" "$(tok "$(app $V1 "SELECT hub_motorista_campanha($VX);")")" "CAMPANHA_NAO_ENCONTRADA"
check "0132/oculta: turnos do extrato oculto -> CAMPANHA_NAO_ENCONTRADA" "$(tok "$(app $V1 "SELECT hub_motorista_campanha_turnos($VX);")")" "CAMPANHA_NAO_ENCONTRADA"
check "0132/oculta: foto do premio de campanha oculta -> CAMPANHA_NAO_ENCONTRADA" "$(tok "$(app $V1 "SELECT * FROM hub_motorista_campanha_foto($VN,$PNV);")")" "CAMPANHA_NAO_ENCONTRADA"
# ---- push de inicio ----
hoje 2027-06-02; hora 09:00
check "0132/push inicio: oculta no periodo -> a varredura NAO notifica (so a visivel VF: 1)" "$(worker "SELECT hub_campanhas_avisar_inicio();")" "1"
check "0132/push inicio: oculta continua com aviso_inicio_em NULL" "$(own "SELECT count(*) FROM \"Campanha\" WHERE id IN ($VN,$VX,$VC,$VK) AND aviso_inicio_em IS NULL")" "4"
check "0132/push inicio: nenhuma notificacao das ocultas" "$(own "SELECT count(*) FROM \"NotificacaoMotorista\" WHERE link IN ('/campanhas/$VN','/campanhas/$VX','/campanhas/$VC','/campanhas/$VK')")" "0"
# ---- interruptor depois de lancar ----
check "0132/interruptor: ligar a nota (lancada, em andamento) funciona sem CAMPANHA_IMUTAVEL" "$(tok "$(rpc $ADM9 $E9008 9008 "SELECT hub_campanha_visibilidade($VN, true);")")|$(own "SELECT visivel_app FROM \"Campanha\" WHERE id=$VN")" "|t"
check "0132/interruptor: ligar o extrato tambem" "$(tok "$(rpc $ADM9 $E9008 9008 "SELECT hub_campanha_visibilidade($VX, true);")")|$(own "SELECT visivel_app FROM \"Campanha\" WHERE id=$VX")" "|t"
check "0132/interruptor: as outras colunas seguem imutaveis (nome)" "$(tok "$(ownx "UPDATE \"Campanha\" SET nome='x' WHERE id=$VN")")" "CAMPANHA_IMUTAVEL"
check "0132/interruptor: as outras colunas seguem imutaveis (avisar)" "$(tok "$(ownx "UPDATE \"Campanha\" SET avisar=NOT avisar WHERE id=$VN")")" "CAMPANHA_IMUTAVEL"
check "0132/interruptor: UPDATE direto de visivel_app depois de lancar passa (v_livres)" "$(tok "$(ownx "UPDATE \"Campanha\" SET visivel_app=visivel_app WHERE id=$VN")")" ""
# ---- ligar muda tudo ----
check "0132/ligar: a lista do app agora traz VN, VX e VF" "$(app $V1 "SELECT hub_motorista_campanhas();" | jq -c '[.[].id]|sort')" "$(printf '%s\n' $VN $VX $VF | sort -n | jq -Rn -c '[inputs|tonumber]')"
check "0132/ligar: detalhe da nota aparece" "$(app $V1 "SELECT hub_motorista_campanha($VN);" | jq -r '.campanha.id')" "$VN"
check "0132/ligar: detalhe do extrato aparece" "$(app $V1 "SELECT hub_motorista_campanha($VX);" | jq -r '.campanha.id')" "$VX"
check "0132/ligar: turnos do extrato aparecem (sem erro)" "$(tok "$(app $V1 "SELECT hub_motorista_campanha_turnos($VX);")")" ""
check "0132/ligar: foto do premio volta o PNG" "$(app $V1 "SELECT mime||'|'||base64 FROM hub_motorista_campanha_foto($VN,$PNV);")" "image/png|$PNG"
check "0132/push inicio: depois de ligar, a varredura seguinte gera 1 (nota VN e extrato VX avisam: 2 campanhas)" "$(worker "SELECT hub_campanhas_avisar_inicio();")" "2"
check "0132/push inicio: notificacao de VN criada 1x e aviso_inicio_em carimbado" "$(own "SELECT count(*) FROM \"NotificacaoMotorista\" WHERE cnpj_prestador='$V1' AND link='/campanhas/$VN'")|$(own "SELECT aviso_inicio_em IS NOT NULL FROM \"Campanha\" WHERE id=$VN")" "1|t"
check "0132/push inicio: a varredura seguinte nao gera nada" "$(worker "SELECT hub_campanhas_avisar_inicio();")" "0"
# ---- desligar tira do app de novo ----
rpc $ADM9 $E9008 9008 "SELECT hub_campanha_visibilidade($VX, false);" >/dev/null
check "0132/desligar: o extrato some do app de novo" "$(tok "$(app $V1 "SELECT hub_motorista_campanha($VX);")")" "CAMPANHA_NAO_ENCONTRADA"
rpc $ADM9 $E9008 9008 "SELECT hub_campanha_visibilidade($VX, true);" >/dev/null
# ---- payload sem total ----
JN="$(app $V1 "SELECT hub_motorista_campanha($VN);")"; JX="$(app $V1 "SELECT hub_motorista_campanha($VX);")"
check "0132/payload: detalhe da NOTA sem totalClassificados" "$(printf '%s' "$JN" | jq -c 'has("totalClassificados")')" "false"
check "0132/payload: detalhe do EXTRATO sem totalClassificados" "$(printf '%s' "$JX" | jq -c 'has("totalClassificados")')" "false"
check "0132/payload: continua trazendo eu.posicao (nota) e top10" "$(printf '%s' "$JN" | jq -c '[(.eu.posicao!=null),(.top10|length>0)]')" "[true,true]"
check "0132/payload: itens da lista sem total e com minhaPosicao/naZonaPremio" "$(app $V1 "SELECT hub_motorista_campanhas();" | jq -c '[.[]|(has("total")), has("minhaPosicao"), has("naZonaPremio")]|unique')" "[false,true]"
# ---- push de fim ----
hoje 2027-06-05
NF0="$(own "SELECT count(*) FROM \"NotificacaoMotorista\" WHERE link='/campanhas/$VF'")"
own "SELECT hub_campanha_fechar_interno($VF); SELECT hub_campanha_fechar_interno($VC);" >/dev/null
check "0132/push fim: visivel fechada enfileira o aviso (+2 motoristas) e marca aviso_fim_em" "$(( $(own "SELECT count(*) FROM \"NotificacaoMotorista\" WHERE link='/campanhas/$VF'") - NF0 ))|$(own "SELECT aviso_fim_em IS NOT NULL FROM \"Campanha\" WHERE id=$VF")" "2|t"
check "0132/push fim: oculta fechada NAO enfileira, mas marca aviso_fim_em" "$(own "SELECT count(*) FROM \"NotificacaoMotorista\" WHERE link='/campanhas/$VC'")|$(own "SELECT aviso_fim_em IS NOT NULL AND fechada_em IS NOT NULL FROM \"Campanha\" WHERE id=$VC")" "0|t"
# ---- seguranca ----
hoje 2027-06-02
VA="$(own "SELECT count(*) FROM \"Auditoria\" WHERE acao='campanha.visibilidade' AND recurso='Campanha' AND recurso_id='$VX'")"
check "0132/auditoria: 3 trocas de VX (liga, desliga, liga) gravadas" "$VA" "3"
check "0132/auditoria: quem e de->para" "$(own "SELECT usuario_id||'|'||id_empresa||'|'||(detalhes->>'de')||'>'||(detalhes->>'para') FROM \"Auditoria\" WHERE acao='campanha.visibilidade' AND recurso_id='$VX' ORDER BY id LIMIT 1")" "$(AID $ADM9)|9008|false>true"
rpc $ADM9 $E9008 9008 "SELECT hub_campanha_visibilidade($VX, true);" >/dev/null
check "0132/auditoria: trocar para o mesmo valor nao grava de novo" "$(own "SELECT count(*) FROM \"Auditoria\" WHERE acao='campanha.visibilidade' AND recurso_id='$VX'")" "3"
check "0132/seguranca: usuario de OUTRA empresa -> CAMPANHA_NAO_ENCONTRADA" "$(tok "$(rpc $ADM $E9001 9001 "SELECT hub_campanha_visibilidade($VX, false);")")" "CAMPANHA_NAO_ENCONTRADA"
check "0132/seguranca: empresa ativa diferente da da campanha -> FORA_DE_ESCOPO" "$(tok "$(rpc $ADM9 '[9008,9001]' 9001 "SELECT hub_campanha_visibilidade($VX, false);")")" "FORA_DE_ESCOPO"
check "0132/seguranca: sem campanhas.gerir (operador) -> PERMISSAO_NEGADA" "$(tok "$(rpc $OP9 $E9008 9008 "SELECT hub_campanha_visibilidade($VX, false);")")" "PERMISSAO_NEGADA"
check "0132/seguranca: motorista (sem escopo) nao altera -> CAMPANHA_NAO_ENCONTRADA" "$(tok "$(app $V1 "SELECT hub_campanha_visibilidade($VX, false);")")" "CAMPANHA_NAO_ENCONTRADA"
check "0132/seguranca: a recusa nao mudou nada" "$(own "SELECT visivel_app FROM \"Campanha\" WHERE id=$VX")" "t"
check "0132/seguranca: sem EXECUTE para PUBLIC" "$(own "SELECT has_function_privilege('public','hub_campanha_visibilidade(int,boolean)','EXECUTE')::text||has_function_privilege('authenticated','hub_campanha_visibilidade(int,boolean)','EXECUTE')::text")" "falsetrue"
check "0132/seguranca: hub_campanha_visivel segue sem EXECUTE para authenticated" "$(own "SELECT has_function_privilege('authenticated','hub_campanha_visivel(\"Campanha\",int)','EXECUTE')::text")" "false"
check "0132/seguranca: valor NULL -> VALIDACAO" "$(tok "$(rpc $ADM9 $E9008 9008 "SELECT hub_campanha_visibilidade($VX, NULL);")")" "VALIDACAO"
rpc $ADM9 $E9008 9008 "SELECT hub_campanha_cancelar($VK, 'motivo do teste');" >/dev/null
check "0132/seguranca: cancelada recusa o interruptor -> CAMPANHA_SITUACAO_INVALIDA" "$(tok "$(rpc $ADM9 $E9008 9008 "SELECT hub_campanha_visibilidade($VK, true);")")|$(own "SELECT visivel_app FROM \"Campanha\" WHERE id=$VK")" "CAMPANHA_SITUACAO_INVALIDA|f"

echo "--- 0133: parametrizacao (D1 subpraca efetiva · D2 descarte · D3 nota com categorias · D4 lancar em andamento · D5 data do premio) ---"
# Empresas 9010 (D1-D4) e 9011 (D5). Nomes terminam em 'Param'. "Hoje" fixado em 2027-09-03; janela das campanhas 01-03/09.
# Subpraca/origem por entregador (efetiva): Ana LIVRE (ambas vazias) · Beto ORIGEM B (subpraca '' -> origem) · Caio e Dora..Hana ZONA SUL
# (subpraca vence a origem 'IGN') · Iva 'origem c' (subpraca so espacos; origem com espacos nas pontas).
# Turnos JANTAR 18H-22H (4 h), dias 1..3. Ana/Beto/Caio/Iva: normais (aceitas 9/8/7/5 de 10; 3,6 h online). Dora..Hana: dias 1 e 3 normais
# (5/10) e o dia 2 especial: Dora 300 s zerado · Edu 301 s zerado · Fran 120 s com 1 ofertada · Gil zerado SEM leitura de online · Hana 60 s zerado com 2 pedidos.
seed_param() { # <empresa> <base-cnpj> <hash-perf> <hash-fat> <completo 0|1> <n-usuarios>
  local EMP="$1" CB="$2" HC="$3" HF="$4" FULL="$5" U="$6"
  psql_t -q <<SQL >"$TMP/seed133-$EMP.log" 2>&1 || { echo "FAIL: seed 0133 ($EMP)"; cat "$TMP/seed133-$EMP.log"; exit 1; }
INSERT INTO "Usuario" (email, senha_hash, nome) VALUES ('adm$U@example.com','x','Adm $EMP'),('fin$U@example.com','x','Fin $EMP'),('op$U@example.com','x','Op $EMP');
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ((SELECT id FROM "Usuario" WHERE email='adm$U@example.com'), $EMP, (SELECT id FROM "Papel" WHERE nome='admin_entidade'), true),
  ((SELECT id FROM "Usuario" WHERE email='fin$U@example.com'), $EMP, (SELECT id FROM "Papel" WHERE nome='financeiro'), true),
  ((SELECT id FROM "Usuario" WHERE email='op$U@example.com'),  $EMP, (SELECT id FROM "Papel" WHERE nome='operador'), true);
INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo) SELECT m.id, $EMP, true FROM "Modulo" m WHERE m.codigo = 'campanhas';
CREATE TEMP TABLE spp (k int, nome text, sub text, ori text);
INSERT INTO spp VALUES (1,'Ana Param',NULL,NULL),(2,'Beto Param','','ORIGEM B'),(3,'Caio Param','ZONA SUL',NULL),
  (4,'Dora Param','ZONA SUL','IGN'),(5,'Edu Param','ZONA SUL','IGN'),(6,'Fran Param','ZONA SUL','IGN'),(7,'Gil Param','ZONA SUL','IGN'),
  (8,'Hana Param','ZONA SUL','IGN'),(9,'Iva Param','  ','  origem c  ');
DELETE FROM spp WHERE $FULL = 0 AND k > 3;
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) SELECT lpad(($CB + k)::text, 14, '0'), nome FROM spp;
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
  SELECT $EMP, gen_random_uuid(), s.nome, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador = lpad(($CB + s.k)::text, 14, '0')) FROM spp s ORDER BY s.k;
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES ($EMP,'performance',repeat('$HC',64),'completed'),($EMP,'faturamento',repeat('$HF',64),'completed');
CREATE TEMP TABLE pxp (nome text, d int, o int, a int, c int, p int, sec numeric);
INSERT INTO pxp SELECT s.nome, d, 10, s.a, s.a, 8, 12960 FROM (VALUES ('Ana Param',9),('Beto Param',8),('Caio Param',7),('Iva Param',5)) s(nome,a) CROSS JOIN generate_series(1,3) d;
INSERT INTO pxp SELECT n, v.d, 10, 5, 5, 8, 12960 FROM unnest(ARRAY['Dora Param','Edu Param','Fran Param','Gil Param','Hana Param']) n CROSS JOIN (VALUES (1),(3)) v(d);
INSERT INTO pxp VALUES ('Dora Param',2,0,0,0,0,300),('Edu Param',2,0,0,0,0,301),('Fran Param',2,1,0,0,0,120),('Gil Param',2,0,0,0,0,NULL),('Hana Param',2,0,0,0,2,60);
INSERT INTO "PerformanceTurno" (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca, origem,
       corridas_ofertadas, corridas_aceitas, corridas_completadas, pedidos_concluidos, tempo_disponivel, hash_linha)
SELECT $EMP, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('$HC',64)), e.id, ('2027-09-01'::date + p.d - 1), 'JANTAR 18H-22H', interval '4 hours', s.sub, s.ori,
       p.o, p.a, p.c, p.p, CASE WHEN p.sec IS NULL THEN NULL ELSE make_interval(secs => p.sec::float8) END,
       md5(e.id::text||p.d::text||'param')||md5(p.d::text||e.id::text||'param2')
FROM pxp p JOIN spp s ON s.nome = p.nome JOIN "Entregador" e ON e.nome = p.nome AND e.id_empresa = $EMP;
REFRESH MATERIALIZED VIEW mv_performance_dia;
-- faturamento (so na empresa completa): (nome, dia, categoria, valor, turno, subpraca, origem)
CREATE TEMP TABLE fxp (nome text, d int, cat text, v numeric, per text, sub text, ori text);
INSERT INTO fxp SELECT 'Ana Param', d, 'Corridas', 20, 'JANTAR 18H-22H', NULL, NULL FROM generate_series(1,3) d;
INSERT INTO fxp SELECT 'Beto Param', d, 'Outra', 10, 'JANTAR 18H-22H', '', 'ORIGEM B' FROM generate_series(1,3) d;
INSERT INTO fxp VALUES ('Caio Param',1,'Corridas',20,'JANTAR 18H-22H','ZONA SUL',NULL),('Caio Param',2,'Corridas',20,'ALMOCO 11H-14H','ZONA SUL',NULL);
INSERT INTO fxp SELECT n, d, 'Corridas', 10, 'JANTAR 18H-22H', 'ZONA SUL', NULL FROM unnest(ARRAY['Dora Param','Edu Param']) n CROSS JOIN generate_series(1,3) d;
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, periodo, tipo, valor, descricao, subpraca, origem, hash_linha)
SELECT $EMP, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('$HF',64)), e.id, ('2027-09-01'::date + f.d), ('2027-09-01'::date + f.d - 1),
       f.per, 'Credito', f.v, f.cat, f.sub, f.ori, md5(f.nome||f.d||f.cat||f.per||'$EMP')||md5(f.v||f.nome||'fx')
FROM fxp f JOIN "Entregador" e ON e.nome = f.nome AND e.id_empresa = $EMP WHERE $FULL = 1;
SQL
}
seed_param 9010 91000000000000 k l 1 10
seed_param 9011 91100000000000 m n 0 11
ADM10='adm10@example.com'; E9010='[9010]'; ADM11='adm11@example.com'; FIN11='fin11@example.com'; OP11='op11@example.com'; E9011='[9011]'
ENT10() { own "SELECT id FROM \"Entregador\" WHERE nome='$1' AND id_empresa=9010"; }
hoje 2027-09-03

echo "  D1: regra unica no banco"
check "0133/D1: subpraca efetiva (vazia/espacos -> origem; ambas vazias -> LIVRE; subpraca vence a origem; aparou as pontas)" "$(own "SELECT concat_ws(',', hub_subpraca_efetiva(NULL,NULL), hub_subpraca_efetiva('  ','  '), hub_subpraca_efetiva('',' b '), hub_subpraca_efetiva(' x ','y'), hub_subpraca_efetiva(NULL,'origem'))")" "LIVRE,LIVRE,b,x,origem"
check "0133/D1: opcoes de praca = efetivas (LIVRE e origem entram; canonicas em upper; sem linha 'sem praca' sumindo)" "$(rpc $ADM10 $E9010 9010 "SELECT hub_campanha_opcoes(9010,NULL,NULL,NULL)->'pracas';")" '["LIVRE", "ORIGEM B", "ORIGEM C", "ZONA SUL"]'
check "0133/D1: alcance (estimativa nas opcoes) casa pela efetiva: 'livre' = 1 entregador, 'origem b' = 1, 'origem c' = 1, 'zona sul' = 6" "$(for p in livre 'origem b' 'origem c' 'zona sul'; do rpc $ADM10 $E9010 9010 "SELECT hub_campanha_opcoes(9010,ARRAY['$p'],NULL,NULL)->'alcance'->>'rodaram';"; done | paste -sd,)" "1,1,1,6"
check "0133/D1: coluna computada subpraca_efetiva (PostgREST) = a funcao; filtravel pelo authenticated" "$(rpc $ADM10 $E9010 9010 "SELECT count(*) FROM \"PerformanceTurno\" pt WHERE pt.subpraca_efetiva = 'LIVRE';")" "3"
check "0133/D1: view de areas: Ana=LIVRE, Beto=ORIGEM B, Dora=ZONA SUL (a origem IGN nao vira area), Iva=origem c" "$(own "SELECT string_agg(e.nome||'='||a.subpraca, ',' ORDER BY e.nome) FROM hub_areas_por_entregador a JOIN \"Entregador\" e ON e.id=a.entregador_id WHERE e.id_empresa=9010 AND e.nome IN ('Ana Param','Beto Param','Dora Param','Iva Param')")" "Ana Param=LIVRE,Beto Param=ORIGEM B,Dora Param=ZONA SUL,Iva Param=origem c"
check "0133/D1: performance totais filtra pela efetiva (LIVRE=27 completadas, ORIGEM B=24, origem c=15, ZONA SUL=71)" "$(for p in LIVRE 'ORIGEM B' 'origem c' 'ZONA SUL'; do rpc $ADM10 $E9010 9010 "SELECT corridas_completadas FROM hub_performance_totais(9010,'2027-09-01','2027-09-03',NULL,'$p',NULL);"; done | paste -sd,)" "27,24,15,71"
check "0133/D1: performance turnos (lista paginada): 3 turnos da LIVRE e a praca do detalhe sai efetiva" "$(rpc $ADM10 $E9010 9010 "SELECT count(*)||'|'||min(pracas->0->>'subpraca') FROM hub_performance_turnos(9010,'2027-09-01','2027-09-03',NULL,'LIVRE',NULL,50,0);")" "3|LIVRE"
check "0133/D1: performance agrupado por dia filtra pela efetiva (LIVRE: 3 dias)" "$(rpc $ADM10 $E9010 9010 "SELECT count(*) FROM hub_performance_agrupado(9010,'2027-09-01','2027-09-03',NULL,'LIVRE',NULL,'dia');")" "3"
check "0133/D1: faturamento totais filtra pela efetiva (LIVRE = 60.00 da Ana; ORIGEM B = 30.00 do Beto)" "$(for p in LIVRE 'ORIGEM B'; do rpc $ADM10 $E9010 9010 "SELECT total_geral FROM hub_faturamento_totais(9010,'2027-09-02','2027-09-10',NULL,NULL,'$p',NULL);"; done | paste -sd,)" "60.00,30.00"
check "0133/D1: faturamento agrupado por dia filtra pela efetiva (LIVRE: 3 dias)" "$(rpc $ADM10 $E9010 9010 "SELECT count(*) FROM hub_faturamento_agrupado(9010,'2027-09-02','2027-09-10',NULL,NULL,'LIVRE',NULL,'dia');")" "3"

echo "  D2/D3/D1: salvar (descarteTurnoMin, dataPremio, categorias na nota)"
NOTA_T() { body "$1" "${2:-2027-09-01}" "${3:-2027-09-03}" null null null 1 0 0 100 0 "$NOCUT"; }   # nota so de tempo (isola o indicador)
check "0133/D2: descarteTurnoMin fora de 0..60 / nao numerico -> VALIDACAO" "$(for v in 61 -1 '"x"' 2.5; do tok "$(salvar $ADM10 $E9010 9010 NULL "$(NOTA_T Dx1 | jq -c ".descarteTurnoMin=$v")")"; done | paste -sd,)" "VALIDACAO,VALIDACAO,VALIDACAO,VALIDACAO"
check "0133/D5: dataPremio invalida -> VALIDACAO" "$(tok "$(salvar $ADM10 $E9010 9010 NULL "$(NOTA_T Dx2 | jq -c '.dataPremio="31/12/2027"')")")|$(tok "$(salvar $ADM10 $E9010 9010 NULL "$(NOTA_T Dx3 | jq -c '.dataPremio=5')")")" "VALIDACAO|VALIDACAO"
ND5="$(salvar $ADM10 $E9010 9010 NULL "$(NOTA_T 'Nota D5 min')")"
ND0="$(salvar $ADM10 $E9010 9010 NULL "$(NOTA_T 'Nota D0 sem descarte' | jq -c '.descarteTurnoMin=0')")"
check "0133/D2: padrao 5 quando o campo nao vem; 0 desliga; 60 aceito" "$(own "SELECT descarte_turno_min FROM \"Campanha\" WHERE id=$ND5")|$(own "SELECT descarte_turno_min FROM \"Campanha\" WHERE id=$ND0")|$(salvar $ADM10 $E9010 9010 NULL "$(NOTA_T 'Nota D60' | jq -c '.descarteTurnoMin=60')" | grep -cE '^[0-9]+$')" "5|0|1"
check "0133/D2: editar o rascunho SEM o campo mantem o valor (0); com o campo troca" "$(salvar $ADM10 $E9010 9010 "$ND0" "$(NOTA_T 'Nota D0 sem descarte')" >/dev/null; own "SELECT descarte_turno_min FROM \"Campanha\" WHERE id=$ND0")|$(salvar $ADM10 $E9010 9010 "$ND0" "$(NOTA_T 'Nota D0 sem descarte' | jq -c '.descarteTurnoMin=7')" >/dev/null; own "SELECT descarte_turno_min FROM \"Campanha\" WHERE id=$ND0")" "0|7"
salvar $ADM10 $E9010 9010 "$ND0" "$(NOTA_T 'Nota D0 sem descarte' | jq -c '.descarteTurnoMin=0')" >/dev/null
XC_T='{"aceitacao":null,"conclusao":null,"tempo":0.7,"pedidos":null}'
XD5="$(salvar $ADM10 $E9010 9010 NULL "$(xbody 'Extrato D5 min' 2027-09-01 2027-09-03 '["Corridas"]' trabalhados "$XC_T" 3 null)")"
XD0="$(salvar $ADM10 $E9010 9010 NULL "$(xbody 'Extrato D0 sem descarte' 2027-09-01 2027-09-03 '["Corridas"]' trabalhados "$XC_T" 3 null | jq -c '.descarteTurnoMin=0')")"
XL="$(salvar $ADM10 $E9010 9010 NULL "$(xbody 'Extrato LIVRE' 2027-09-01 2027-09-03 '["Corridas"]' trabalhados "$XC_T" 1 null | jq -c '.pracas=["livre"]')")"
NC="$(salvar $ADM10 $E9010 9010 NULL "$(NOTA_T 'Nota com categorias' | jq -c '.categorias=["Corridas"]')")"
NL="$(salvar $ADM10 $E9010 9010 NULL "$(body 'Nota praca LIVRE' 2027-09-01 2027-09-03 '["livre"]' null null 1 0 0 100 0 "$NOCUT")")"
NB="$(salvar $ADM10 $E9010 9010 NULL "$(body 'Nota praca ORIGEM B' 2027-09-01 2027-09-03 '["origem b"]' null null 1 0 0 100 0 "$NOCUT")")"
VF="$(salvar $ADM10 $E9010 9010 NULL "$(body 'Futura ORIGEM B' 2027-09-10 2027-09-14 '["ORIGEM B"]' null null 1 100 0 0 0 "$NOCUT")")"
check "0133/D3: nota com categorias salva (categorias gravadas)" "$(own "SELECT categorias::text FROM \"Campanha\" WHERE id=$NC")" "{Corridas}"
NCF="$(salvar $ADM10 $E9010 9010 NULL "$(NOTA_T 'Nota categoria fantasma' | jq -c '.categorias=["Categoria Fantasma"]')")"
check "0133/D3: lancar valida as categorias da NOTA como as do extrato (categoria sem turno -> OPCAO_DESCONHECIDA)" "$(tok "$(rpc $ADM10 $E9010 9010 "SELECT hub_campanha_lancar($NCF);")")" "OPCAO_DESCONHECIDA"
PAS="$(salvar $ADM10 $E9010 9010 NULL "$(NOTA_T 'Passada' 2027-08-25 2027-09-02)")"
check "0133/D4: lancar com data_fim < hoje -> FIM_NO_PASSADO" "$(tok "$(rpc $ADM10 $E9010 9010 "SELECT hub_campanha_lancar($PAS);")")" "FIM_NO_PASSADO"

echo "  lancar em andamento (hoje 03/09, inicio 01/09): o ranking nasce pronto na mesma transacao (D4)"
for i in $ND5 $ND0 $XD5 $XD0 $XL $NC $NL $NB $VF; do
  check "0133/D4: lancar campanha $i (inicio no passado ou futuro, fim >= hoje)" "$(tok "$(rpc $ADM10 $E9010 9010 "SELECT hub_campanha_lancar($i);")")" ""
done
check "0133/D4: ND5 lancada em andamento JA tem ranking (sem esperar a importacao)" "$(own "SELECT count(*) > 0 FROM \"CampanhaRanking\" WHERE campanha_id=$ND5")|$(own "SELECT dados_ate FROM \"Campanha\" WHERE id=$ND5")" "t|2027-09-03"
check "0133/D4: campanha AGENDADA (inicio futuro) lancada nao calcula nada" "$(own "SELECT count(*) FROM \"CampanhaRanking\" WHERE campanha_id=$VF")" "0"
rkn() { own "SELECT r.turnos||'|'||COALESCE(r.nota::text,'-')||'|'||r.situacao FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$1 AND e.nome='$2' AND e.id_empresa=9010"; }
xrk() { own "SELECT r.situacao||'|'||r.turnos||'|'||COALESCE(r.turnos_validos::text,'-')||'|'||COALESCE(r.valor_centavos::text,'-') FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$1 AND e.nome='$2' AND e.id_empresa=9010"; }

echo "  D2: descarte do turno curto zerado — nota (indicador = tempo)"
check "0133/D2 nota: Dora (300 s zerado) descartada: 2 turnos e tempo SO dos normais (90.00)" "$(rkn $ND5 'Dora Param')" "2|90.00|classificado"
check "0133/D2 nota: BORDA 301 s (Edu) NAO descarta: 3 turnos, o turno entra no tempo (60.70)" "$(rkn $ND5 'Edu Param')" "3|60.70|classificado"
check "0133/D2 nota: 1 ofertada (Fran, 120 s) NAO descarta (60.28)" "$(rkn $ND5 'Fran Param')" "3|60.28|classificado"
check "0133/D2 nota: online SEM leitura (Gil) NAO descarta: 3 turnos, tempo 90.00 (o turno sem leitura nao pesa)" "$(rkn $ND5 'Gil Param')" "3|90.00|classificado"
check "0133/D2 nota: pedidos > 0 (Hana, 60 s zerado) NAO descarta (60.14)" "$(rkn $ND5 'Hana Param')" "3|60.14|classificado"
check "0133/D2 nota: min = 0 DESLIGA: Dora volta a 3 turnos e o turno de 300 s pesa (60.69)" "$(rkn $ND0 'Dora Param')" "3|60.69|classificado"
check "0133/D2: o gatilho recusa mudar descarte_turno_min depois de lancar (congela como as demais regras)" "$(tok "$(ownx "UPDATE \"Campanha\" SET descarte_turno_min=0 WHERE id=$ND5")")" "CAMPANHA_IMUTAVEL"
check "0133/D2: campanha com DEFAULT 5 (as lancadas antes da 0133 ganham 5 sem UPDATE: provado abaixo, na reaplicacao com a coluna recriada)" "$(own "SELECT count(*) FROM \"Campanha\" WHERE descarte_turno_min <> 5 AND id_empresa NOT IN (9010,9011)")" "0"
echo "  D2: descarte — extrato (turnos trabalhados / validos / valor; credito R\$ 10 por dia, criterio: tempo >= 0.7)"
check "0133/D2 extrato: min=5 descarta o turno de 300 s: Dora fica com 2 turnos < minimo 3 -> sem_minimo (valor so dos 2 turnos normais)" "$(xrk $XD5 'Dora Param')" "sem_minimo|2|2|2000"
check "0133/D2 extrato: min=0 desliga: Dora 3 turnos (classificado), 2 validos, valor 2000 (turno curto conta nos trabalhados, nao no valor)" "$(xrk $XD0 'Dora Param')" "classificado|3|2|2000"
check "0133/D2 extrato: BORDA 301 s (Edu) NAO descarta: 3 turnos, 2 validos, valor 2000" "$(xrk $XD5 'Edu Param')" "classificado|3|2|2000"

echo "  D1: praca = subpraca efetiva (nota, extrato, visibilidade, publico)"
check "0133/D1 nota: praca LIVRE (subpraca e origem vazias) so tem a Ana" "$(own "SELECT string_agg(e.nome||'='||r.turnos, ',' ORDER BY e.nome) FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$NL")" "Ana Param=3"
check "0133/D1 nota: praca ORIGEM B (subpraca vazia -> origem) so tem o Beto" "$(own "SELECT string_agg(e.nome||'='||r.turnos, ',' ORDER BY e.nome) FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$NB")" "Beto Param=3"
check "0133/D1 extrato: praca LIVRE so tem a Ana (valor 6000 = 3 x R\$ 20)" "$(own "SELECT string_agg(e.nome||'='||r.valor_centavos, ',' ORDER BY e.nome) FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$XL")" "Ana Param=6000"
check "0133/D1 visibilidade (app): campanha da praca ORIGEM B e visivel para o Beto (turno em ORIGEM B via origem) e NAO para o Caio" "$(app 91000000000002 "SELECT count(*) FROM jsonb_array_elements(hub_motorista_campanhas()) x WHERE x->>'nome'='Futura ORIGEM B';")|$(app 91000000000003 "SELECT count(*) FROM jsonb_array_elements(hub_motorista_campanhas()) x WHERE x->>'nome'='Futura ORIGEM B';")" "1|0"
check "0133/D1 publico do aviso: praca ORIGEM B = so o CNPJ do Beto" "$(own "SELECT hub_campanha_publico_cnpjs(c)::text FROM \"Campanha\" c WHERE id=$NB")" "{91000000000002}"
check "0133/D1: campanha lancada com praca gravada continua casando (valor nao vazio nao mudou): ZONA SUL" "$(own "SELECT count(*) FROM \"PerformanceTurno\" pt WHERE pt.id_empresa=9010 AND upper(hub_subpraca_efetiva(pt.subpraca, pt.origem)) = 'ZONA SUL'")" "$(own "SELECT count(*) FROM \"PerformanceTurno\" pt WHERE pt.id_empresa=9010 AND upper(btrim(pt.subpraca)) = 'ZONA SUL'")"

echo "  D3: nota com categorias (credito que casa em (entregador, dia, turno)) e fechamento fim+3"
check "0133/D3: so conta turno com credito da categoria: Ana 3 · Caio 1 (credito do dia 2 e de OUTRO turno) · Dora 2 (turno curto descartado) · Edu 3 · sem Beto ('Outra') nem Iva (sem credito)" "$(own "SELECT string_agg(e.nome||'='||r.turnos, ',' ORDER BY e.nome) FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$NC")" "Ana Param=3,Caio Param=1,Dora Param=2,Edu Param=3"
check "0133/D3: a mesma janela SEM categorias conta todos os turnos (Beto e Iva aparecem; Caio 3)" "$(own "SELECT count(*)||'|'||(SELECT r2.turnos FROM \"CampanhaRanking\" r2 JOIN \"Entregador\" e2 ON e2.id=r2.entregador_id WHERE r2.campanha_id=$ND5 AND e2.nome='Caio Param')||'|'||bool_or(e.nome='Beto Param') FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$ND5")" "9|3|true"
check "0133/D3: congelamento criado_em <= fechada_em (a mesma funcao do extrato): corte antigo = 0 creditos, sem corte = tem" "$(own "SELECT (SELECT count(*) FROM hub_campanha_creditos_turno(9010,'2027-09-01','2027-09-03',NULL,ARRAY['Corridas'],'2000-01-01'::timestamptz))||'|'||(SELECT count(*) > 0 FROM hub_campanha_creditos_turno(9010,'2027-09-01','2027-09-03',NULL,ARRAY['Corridas'],NULL))")" "0|true"
hoje 2027-09-04
R="$(rpc $ADM10 $E9010 9010 "SELECT hub_campanhas_recalcular_ativas(9010);")"
check "0133/D3 fechamento em fim+1 (hoje 04/09): fecham so as campanhas SEM categorias (ND5, ND0, NL, NB); NC e os 3 extratos so recalculam" "$(printf '%s' "$R" | jq -c '[.recalculadas,.fechadas,(.erros|length)]')" "[4,4,0]"
check "0133/D3: NC (nota com categorias) segue aberta; ND5 fechada" "$(own "SELECT (SELECT fechada_em IS NULL FROM \"Campanha\" WHERE id=$NC)||'|'||(SELECT fechada_em IS NOT NULL FROM \"Campanha\" WHERE id=$ND5)")" "true|true"
hoje 2027-09-06
R="$(rpc $ADM10 $E9010 9010 "SELECT hub_campanhas_recalcular_ativas(9010);")"
check "0133/D3 fim+3 SEM faturamento importado desde fim+3: a nota com categorias NAO fecha (so recalcula)" "$(printf '%s' "$R" | jq -c '[.recalculadas,.fechadas]')|$(own "SELECT fechada_em IS NULL FROM \"Campanha\" WHERE id=$NC")" "[4,0]|t"
own "INSERT INTO \"FaturamentoLancamento\" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, periodo, tipo, valor, descricao, hash_linha, criado_em)
     SELECT 9010, (SELECT id FROM \"ImportacaoArquivo\" WHERE hash_sha256=repeat('l',64)), id, '2027-09-06', '2027-09-03', 'JANTAR 18H-22H', 'Credito', 1, 'Corridas', md5('fat06')||md5('fat06b'), '2027-09-06 15:00:00+00'
     FROM \"Entregador\" WHERE nome='Ana Param' AND id_empresa=9010" >/dev/null
R="$(rpc $ADM10 $E9010 9010 "SELECT hub_campanhas_recalcular_ativas(9010);")"
check "0133/D3 fim+3 COM faturamento importado desde fim+3: a nota com categorias fecha junto dos extratos (0 recalculadas, 4 fechadas)" "$(printf '%s' "$R" | jq -c '[.recalculadas,.fechadas]')|$(own "SELECT fechada_em IS NOT NULL FROM \"Campanha\" WHERE id=$NC")" "[0,4]|t"

echo "  D5: data do premio (empresa 9011: Ana 1o, Beto 2o, Caio 3o; nota de aceitacao)"
hoje 2027-09-03
T5="$(own "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date + 5")"; T6="$(own "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date + 6")"
T7="$(own "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date + 7")"; T9="$(own "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date + 9")"
TM3="$(own "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date - 3")"; TODAY="$(own "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date")"
PD_MIX='[{"posicaoDe":1,"posicaoAte":1,"tipo":"dinheiro","descricao":"R$ 100","valorCentavos":10000},{"posicaoDe":2,"posicaoAte":2,"tipo":"dinheiro","descricao":"R$ 50","valorCentavos":5000},{"posicaoDe":3,"posicaoAte":3,"tipo":"objeto","descricao":"Bag"}]'
PD_DIN='[{"posicaoDe":1,"posicaoAte":3,"tipo":"dinheiro","descricao":"R$ 30","valorCentavos":3000}]'
PBODY() { body "$1" 2027-09-01 2027-09-03 null null null 1 100 0 0 0 "$NOCUT" "$2" | jq -c --arg d "$3" 'if $d == "" then . else .dataPremio=$d end'; }
P1="$(salvar $ADM11 $E9011 9011 NULL "$(PBODY 'Premio 1 misto' "$PD_MIX" "$T5")")"
P2="$(salvar $ADM11 $E9011 9011 NULL "$(PBODY 'Premio 2 passado' "$PD_DIN" "$TM3")")"
P3="$(salvar $ADM11 $E9011 9011 NULL "$(PBODY 'Premio 3 mesma data' "$PD_DIN" "$T5")")"
P4="$(salvar $ADM11 $E9011 9011 NULL "$(PBODY 'Premio 4 outra data' "$PD_DIN" "$T6")")"
P5="$(salvar $ADM11 $E9011 9011 NULL "$(PBODY 'Premio 5 a cancelar' "$PD_DIN" "")")"
check "0133/D5: salvar grava data_premio (rascunho); sem a chave: NULL; editar sem a chave mantem; null limpa" "$(own "SELECT data_premio FROM \"Campanha\" WHERE id=$P1")|$(own "SELECT data_premio IS NULL FROM \"Campanha\" WHERE id=$P5")|$(salvar $ADM11 $E9011 9011 "$P1" "$(PBODY 'Premio 1 misto' "$PD_MIX" "")" >/dev/null; own "SELECT data_premio FROM \"Campanha\" WHERE id=$P1")|$(salvar $ADM11 $E9011 9011 "$P1" "$(PBODY 'Premio 1 misto' "$PD_MIX" "" | jq -c '.dataPremio=null')" >/dev/null; own "SELECT data_premio IS NULL FROM \"Campanha\" WHERE id=$P1")" "$T5|t|$T5|t"
salvar $ADM11 $E9011 9011 "$P1" "$(PBODY 'Premio 1 misto' "$PD_MIX" "$T5")" >/dev/null
for i in $P1 $P2 $P3 $P4 $P5; do rpc $ADM11 $E9011 9011 "SELECT hub_campanha_lancar($i);" >/dev/null; done
rpc $ADM11 $E9011 9011 "SELECT hub_campanha_cancelar($P5,'cancelada no teste 0133');" >/dev/null
hoje 2027-09-04
R="$(rpc $ADM11 $E9011 9011 "SELECT hub_campanhas_recalcular_ativas(9011);")"
check "0133/D5: 4 campanhas (nota, sem categorias) fecham em fim+1; vencedores: Ana 1o, Beto 2o, Caio 3o" "$(printf '%s' "$R" | jq -c '[.recalculadas,.fechadas]')|$(own "SELECT string_agg(e.nome, ',' ORDER BY v.posicao) FROM \"CampanhaVencedor\" v JOIN \"Entregador\" e ON e.id=v.entregador_id WHERE v.campanha_id=$P1")" "[0,4]|Ana Param,Beto Param,Caio Param"
C1=91100000000001; C2=91100000000002; C3=91100000000003
check "0133/D5: 1a exportacao com data_premio futura grava data_pagamento = data_premio (Ana e Beto; o objeto do Caio nao exporta)" "$(rpc $FIN11 $E9011 9011 "$(EXP $P1)")" "$C1|Ana Param|10000|1|$T5|false
$C2|Beto Param|5000|2|$T5|false"
check "0133/D5: a data fica GRAVADA em CampanhaVencedor.data_pagamento" "$(own "SELECT string_agg(posicao||'='||COALESCE(data_pagamento::text,'-'), ',' ORDER BY posicao) FROM \"CampanhaVencedor\" WHERE campanha_id=$P1")" "1=$T5,2=$T5,3=-"
check "0133/D5: hub_campanha_vencedores expoe data_pagamento" "$(rpc $ADM11 $E9011 9011 "SELECT string_agg(posicao||'='||COALESCE(data_pagamento::text,'-'), ',' ORDER BY posicao) FROM hub_campanha_vencedores($P1);")" "1=$T5,2=$T5,3=-"
check "0133/D5: alterar a data APOS lancar e fechar (objeto pendente): permitido, devolve antes/depois" "$(rpc $ADM11 $E9011 9011 "SELECT hub_campanha_alterar_data_premio(9011,$P1,'$T9');" | jq -c '[.antes,.depois,.alterada]')" "[\"$T5\",\"$T9\",true]"
check "0133/D5: a data gravada NAO muda com data_premio (re-download reproduz $T5)" "$(rpc $FIN11 $E9011 9011 "$(EXP $P1)" | cut -d'|' -f5 | paste -sd,)" "$T5,$T5"
check "0133/D5: alterar para o mesmo valor: alterada=false; limpar (NULL) e permitido" "$(rpc $ADM11 $E9011 9011 "SELECT hub_campanha_alterar_data_premio(9011,$P1,'$T9');" | jq -c '.alterada')|$(rpc $ADM11 $E9011 9011 "SELECT hub_campanha_alterar_data_premio(9011,$P1,NULL);" | jq -c '[.antes,.depois]')" "false|[\"$T9\",null]"
rpc $ADM11 $E9011 9011 "SELECT hub_campanha_alterar_data_premio(9011,$P1,'$T9');" >/dev/null
check "0133/D5: o app mostra a data (hub_motorista_campanha.campanha.dataPremio) e nao expoe data_pagamento" "$(app $C1 "SELECT (hub_motorista_campanha($P1)->'campanha'->>'dataPremio')||'|'||(hub_motorista_campanha($P1)::text LIKE '%data_pagamento%' OR hub_motorista_campanha($P1)::text LIKE '%dataPagamento%');")" "$T9|false"
check "0133/D5: hub (detalhe/lista) expoe dataPremio e descarteTurnoMin" "$(rpc $ADM11 $E9011 9011 "SELECT (hub_campanha_detalhe($P1)->>'dataPremio')||'|'||(hub_campanha_detalhe($P1)->>'descarteTurnoMin')||'|'||(SELECT item->>'dataPremio' FROM hub_campanha_listar(9011,NULL) WHERE (item->>'id')::int=$P1);")" "$T9|5|$T9"
check "0133/D5: data_premio no PASSADO -> paga ja (hoje): P2 exporta os 3 com data = hoje" "$(rpc $FIN11 $E9011 9011 "$(EXP $P2)" | cut -d'|' -f5 | paste -sd,)" "$TODAY,$TODAY,$TODAY"
check "0133/D5: alterar recusa se TODOS os premios ja foram pagos/entregues (P2) -> CAMPANHA_SITUACAO_INVALIDA" "$(tok "$(rpc $ADM11 $E9011 9011 "SELECT hub_campanha_alterar_data_premio(9011,$P2,'$T9');")")" "CAMPANHA_SITUACAO_INVALIDA"
R="$(rpc $FIN11 $E9011 9011 "$(EXP $P3)")"
check "0133/D5 colisao de CNPJ na mesma data efetiva (P3 = P1, $T5): Ana e Beto ADIADOS (sem data); Caio carimbado" "$R" "$C1|Ana Param|3000|1|-|true
$C2|Beto Param|3000|2|-|true
$C3|Caio Param|3000|3|$T5|false"
check "0133/D5: o adiado nao foi carimbado (continua pendente)" "$(own "SELECT string_agg(posicao||'='||(exportado_em IS NOT NULL), ',' ORDER BY posicao) FROM \"CampanhaVencedor\" WHERE campanha_id=$P3")" "1=false,2=false,3=true"
rpc $ADM11 $E9011 9011 "SELECT hub_campanha_alterar_data_premio(9011,$P3,'$T7');" >/dev/null
check "0133/D5: adiamento e relativo a data efetiva: com P3 em $T7 nao ha colisao (Ana/Beto $T7); o Caio ja carimbado segue em $T5" "$(rpc $FIN11 $E9011 9011 "$(EXP $P3)" | cut -d'|' -f5,6 | paste -sd,)" "$T7|false,$T7|false,$T5|false"
check "0133/D5: sem colisao na outra data (P4 = $T6): os 3 carimbados em $T6" "$(rpc $FIN11 $E9011 9011 "$(EXP $P4)" | cut -d'|' -f5,6 | paste -sd,)" "$T6|false,$T6|false,$T6|false"
echo "  D5: seguranca e gatilhos"
check "0133/D5 seguranca: operador (sem campanhas.gerir) -> PERMISSAO_NEGADA" "$(tok "$(rpc $OP11 $E9011 9011 "SELECT hub_campanha_alterar_data_premio(9011,$P1,'$T9');")")" "PERMISSAO_NEGADA"
check "0133/D5 seguranca: usuario de OUTRA empresa -> CAMPANHA_NAO_ENCONTRADA" "$(tok "$(rpc $ADM10 $E9010 9010 "SELECT hub_campanha_alterar_data_premio(9010,$P1,'$T9');")")" "CAMPANHA_NAO_ENCONTRADA"
check "0133/D5 seguranca: empresa informada diferente da ativa -> FORA_DE_ESCOPO" "$(tok "$(rpc $ADM11 '[9011,9010]' 9010 "SELECT hub_campanha_alterar_data_premio(9011,$P1,'$T9');")")" "FORA_DE_ESCOPO"
check "0133/D5 seguranca: id de outra empresa com a propria empresa informada -> CAMPANHA_NAO_ENCONTRADA" "$(tok "$(rpc $ADM11 $E9011 9011 "SELECT hub_campanha_alterar_data_premio(9011,$ND5,'$T9');")")" "CAMPANHA_NAO_ENCONTRADA"
check "0133/D5 seguranca: campanha cancelada recusa -> CAMPANHA_SITUACAO_INVALIDA" "$(tok "$(rpc $ADM11 $E9011 9011 "SELECT hub_campanha_alterar_data_premio(9011,$P5,'$T9');")")" "CAMPANHA_SITUACAO_INVALIDA"
check "0133/D5 seguranca: motorista (sem escopo) nao altera" "$(tok "$(app $C1 "SELECT hub_campanha_alterar_data_premio(9011,$P1,'$T9');")")" "FORA_DE_ESCOPO"
check "0133/D5 seguranca: sem EXECUTE para PUBLIC; authenticated tem" "$(own "SELECT has_function_privilege('public','hub_campanha_alterar_data_premio(int,int,date)','EXECUTE')::text||has_function_privilege('authenticated','hub_campanha_alterar_data_premio(int,int,date)','EXECUTE')::text")" "falsetrue"
check "0133/D5 gatilho: data_premio pode mudar depois de lancar (como dono do banco)" "$(ownx "UPDATE \"Campanha\" SET data_premio = data_premio + 1 WHERE id=$P1" | grep -c ERROR)" "0"
own "UPDATE \"Campanha\" SET data_premio = '$T9' WHERE id=$P1" >/dev/null
check "0133/D5 gatilho: qualquer OUTRA coluna segue imutavel (nome, descricao, premio)" "$(tok "$(ownx "UPDATE \"Campanha\" SET nome='Outro' WHERE id=$P1")")|$(tok "$(ownx "UPDATE \"Campanha\" SET descricao='x' WHERE id=$P1")")|$(tok "$(ownx "UPDATE \"CampanhaPremio\" SET descricao='x' WHERE campanha_id=$P1")")" "CAMPANHA_IMUTAVEL|CAMPANHA_IMUTAVEL|CAMPANHA_IMUTAVEL"
check "0133/D5 gatilho do vencedor: data_pagamento liberada (junto de exportado_em); outra coluna segue imutavel" "$(ownx "UPDATE \"CampanhaVencedor\" SET data_pagamento = data_pagamento WHERE campanha_id=$P1 AND posicao=1" | grep -c ERROR)|$(tok "$(ownx "UPDATE \"CampanhaVencedor\" SET premio_id = premio_id + 0, posicao = posicao + 100 WHERE campanha_id=$P1 AND posicao=1")")" "0|CAMPANHA_IMUTAVEL"
check "0133: funcoes internas novas NAO executaveis por authenticated (descartado, creditos, subpraca_efetiva e executavel por ser pura)" "$(own "SELECT has_function_privilege('authenticated','hub_campanha_creditos_turno(int,date,date,int,text[],timestamptz)','EXECUTE')::text||has_function_privilege('public','hub_campanha_turno_descartado(double precision,bigint,bigint,bigint,bigint,int)','EXECUTE')::text||has_function_privilege('authenticated','hub_subpraca_efetiva(text,text)','EXECUTE')::text")" "falsefalsetrue"

echo "--- idempotencia da migration (0129 duas vezes, com dados de extrato presentes) ---"
for i in 1 2; do
  R4="$(psql_relaxed -v ON_ERROR_STOP=1 -q -f - < "$HUB_DIR/migrations/0131_categorias_modo_todas.sql" 2>&1 | grep -c ERROR)"
  check "migration 0131 reaplicada ($i) sem erro (a 0129 nao e mais reaplicavel por cima: a 0131 muda o retorno de hub_campanha_categorias)" "$R4" "0"
done

echo "--- 0130: campanha de NOTA sem leitura de tempo (tempo NULL, nao 100%) ---"
for i in 1 2; do
  R5="$(psql_relaxed -v ON_ERROR_STOP=1 -q -f - < "$HUB_DIR/migrations/0130_campanha_nota_tempo_sem_leitura.sql" 2>&1 | grep -c ERROR)"
  check "migration 0130 aplicada ($i) sem erro (apos reaplicar a 0129, que traz o corpo antigo)" "$R5" "0"
done
check "0130: hub_campanha_recalcular_interno nao e executavel por PUBLIC nem authenticated" "$(own "SELECT has_function_privilege('public','hub_campanha_recalcular_interno(int)','EXECUTE')::text||has_function_privilege('authenticated','hub_campanha_recalcular_interno(int)','EXECUTE')::text")" "falsefalse"
check "0130: corpo vivo tem a guarda de leitura (nao o LEAST com NULLIF)" "$(own "SELECT pg_get_functiondef('hub_campanha_recalcular_interno(integer)'::regprocedure) ~ 'periodo_epoch = 0 THEN NULL'")" "t"
psql_t -q <<'SQL' >"$TMP/seed130.log" 2>&1 || { echo "FAIL: seed 0130"; cat "$TMP/seed130.log"; exit 1; }
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES (9006,'performance',repeat('6',64),'completed'),(9007,'performance',repeat('7',64),'completed');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, dados_entrego_json)
  SELECT e, gen_random_uuid(), n, '{"informacoesEntrega":{"modal":"MOTO"}}'::jsonb
  FROM (VALUES (9006),(9007)) em(e) CROSS JOIN (VALUES ('Sem Leitura'),('Com Leitura')) nm(n);
-- 2 turnos por motorista: 90% de aceitacao; "Sem Leitura" com tempo_disponivel NULL (online_epoch NULL), "Com Leitura" 4h de 4h
INSERT INTO "PerformanceTurno" (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca,
       corridas_ofertadas, corridas_aceitas, corridas_completadas, pedidos_concluidos, tempo_disponivel, hash_linha)
SELECT e.id_empresa, (SELECT id FROM "ImportacaoArquivo" WHERE id_empresa=e.id_empresa AND tipo='performance'), e.id, d::date,
       'JANTAR 18H-22H', interval '4 hours', 'SAO PAULO', 10, 9, 9, 5,
       CASE WHEN e.nome = 'Sem Leitura' THEN NULL ELSE interval '4 hours' END,
       md5(e.id::text||d::text||'t130')||md5(d::text||e.id::text||'t130')
FROM "Entregador" e CROSS JOIN generate_series('2026-12-01'::date,'2026-12-02'::date,'1 day') d
WHERE e.id_empresa IN (9006,9007);
REFRESH MATERIALIZED VIEW mv_performance_dia;
-- (a) peso de tempo 50 + corte de tempo 50%; (b) peso de tempo 50, SEM corte de tempo
INSERT INTO "Campanha" (id_empresa, nome, data_inicio, data_fim, min_turnos, peso_aceitacao, peso_tempo, corte_tempo, criada_por, lancada_por, lancada_em)
VALUES (9006,'Tempo Sem Leitura A','2026-12-01','2026-12-02',1,50,50,0.5,(SELECT id FROM "Usuario" WHERE email='adm@example.com'),(SELECT id FROM "Usuario" WHERE email='adm@example.com'),now()),
       (9007,'Tempo Sem Leitura B','2026-12-01','2026-12-02',1,50,50,NULL,(SELECT id FROM "Usuario" WHERE email='adm@example.com'),(SELECT id FROM "Usuario" WHERE email='adm@example.com'),now());
SQL
hoje 2026-12-03
if [ "${CAMP_NEG:-}" = tempo_leitura ]; then
  patch_fn 'hub_campanha_recalcular_interno(integer)' 's/ent\.periodo_epoch = 0 THEN NULL/ent.periodo_epoch = 0 THEN 1/'
  own "SELECT pg_get_functiondef('hub_campanha_recalcular_interno(integer)'::regprocedure) ~ 'periodo_epoch = 0 THEN 1'" | grep -q t || { echo "ABORTA: reversao tempo_leitura nao esta no corpo vivo — controle OCO"; exit 1; }
  echo "NEG tempo_leitura: tempo sem leitura volta a 100% no corpo vivo (conferido)"
fi
IDA130="$(own "SELECT id FROM \"Campanha\" WHERE nome='Tempo Sem Leitura A'")"; IDB130="$(own "SELECT id FROM \"Campanha\" WHERE nome='Tempo Sem Leitura B'")"
own "SELECT hub_campanha_recalcular_interno($IDA130); SELECT hub_campanha_recalcular_interno($IDB130);" >/dev/null
RK130() { own "SELECT r.situacao||'|'||COALESCE(array_to_string(r.motivo_corte,','),'')||'|'||COALESCE(r.tempo::text,'NULL')||'|'||COALESCE(r.nota::text,'NULL')||'|'||COALESCE(r.nota_hipotetica::text,'NULL') FROM \"CampanhaRanking\" r JOIN \"Entregador\" e ON e.id=r.entregador_id WHERE r.campanha_id=$1 AND e.nome='$2'"; }
check "0130/a: sem leitura de tempo + corte de tempo -> abaixo_corte, motivo tempo, tempo NULL, nota hipotetica so da aceitacao (45)" "$(RK130 $IDA130 'Sem Leitura')" "abaixo_corte|tempo|NULL|NULL|45.00"
check "0130/a: com leitura (4h de 4h) segue classificado, tempo 1, nota 95" "$(RK130 $IDA130 'Com Leitura')" "classificado||1.000000|95.00|NULL"
check "0130/b: sem leitura de tempo e SEM corte -> classificado, tempo NULL, parcela de tempo 0 (nota 45, nao 95)" "$(RK130 $IDB130 'Sem Leitura')" "classificado||NULL|45.00|NULL"
check "0130/b: com leitura -> nota 95 (parcela de tempo cheia)" "$(RK130 $IDB130 'Com Leitura')" "classificado||1.000000|95.00|NULL"

# 0127 NAO e mais reaplicavel por cima da 0129: a 0129 muda o retorno de hub_campanha_ranking (CREATE OR REPLACE
# da 0127 falharia) e o migrate.sh nunca reaplica migration registrada. A idempotencia valida agora e a da 0129 (acima).
echo "--- idempotencia da 0128 ---"
R3="$(psql_relaxed -v ON_ERROR_STOP=1 -q -f - < "$HUB_DIR/migrations/0128_campanhas_excluir_admin.sql" 2>&1 | grep -c ERROR)"
check "migration 0128 reaplicada sem erro" "$R3" "0"

echo "--- idempotencia da 0132 (reaplica por cima das reaplicacoes de 0131/0130, que trazem corpos antigos) ---"
for i in 1 2; do
  R6="$(psql_relaxed -v ON_ERROR_STOP=1 -q -f - < "$HUB_DIR/migrations/0132_campanhas_visibilidade_app.sql" 2>&1 | grep -c ERROR)"
  check "migration 0132 reaplicada ($i) sem erro" "$R6" "0"
done
check "0132: depois de reaplicar, os dados (visivel_app) e o corpo vivo seguem corretos" "$(own "SELECT pg_get_functiondef('hub_campanha_visivel(\"Campanha\",integer)'::regprocedure) ~ 'c[.]visivel_app'")|$(own "SELECT visivel_app FROM \"Campanha\" WHERE id=$VX")" "t|t"

echo "--- idempotencia da 0133 (reaplica por cima das reaplicacoes de 0131/0130/0132, que trazem corpos antigos; coluna descarte recriada COM campanha lancada presente) ---"
N_LANC="$(own "SELECT count(*) FROM \"Campanha\" WHERE lancada_em IS NOT NULL")"
own "ALTER TABLE \"Campanha\" DROP CONSTRAINT campanha_descarte_chk; ALTER TABLE \"Campanha\" DROP COLUMN descarte_turno_min;" >/dev/null
check "0133: coluna descarte_turno_min removida para provar o ADD COLUMN DEFAULT sobre campanhas LANCADAS" "$(own "SELECT count(*) FROM information_schema.columns WHERE table_name='Campanha' AND column_name='descarte_turno_min'")" "0"
for i in 1 2; do
  R7="$(psql_relaxed -v ON_ERROR_STOP=1 -q -f - < "$HUB_DIR/migrations/0133_campanhas_parametrizacao.sql" 2>&1 | grep -c ERROR)"
  check "migration 0133 reaplicada ($i) sem erro" "$R7" "0"
done
check "0133/D2: ADD COLUMN ... DEFAULT 5 sobre $N_LANC campanhas lancadas: sem erro de gatilho e TODAS ficaram com 5 (sem UPDATE)" "$(own "SELECT count(*) FROM \"Campanha\" WHERE lancada_em IS NOT NULL AND descarte_turno_min = 5")" "$N_LANC"
check "0133: depois de reaplicar, os corpos vivos sao os da 0133 (lancar FIM_NO_PASSADO, gatilho com data_premio, nota com descarte, _q de 14 args unico)" "$(own "SELECT (pg_get_functiondef('hub_campanha_lancar(integer)'::regprocedure) ~ 'FIM_NO_PASSADO')::text||(pg_get_functiondef('hub_campanha_imutavel_trg()'::regprocedure) ~ '''data_premio''')::text||(pg_get_functiondef('hub_campanha_recalcular_interno(integer)'::regprocedure) ~ 'hub_campanha_turno_descartado')::text||(SELECT count(*) FROM pg_proc WHERE proname='hub_campanha_turnos_extrato_q')::text")" "truetruetrue1"
check "0133: reaplicar nao mexeu nos dados (ND5 ainda com 9 no ranking; P1 com a data $T9)" "$(own "SELECT (SELECT count(*) FROM \"CampanhaRanking\" WHERE campanha_id=$ND5)||'|'||(SELECT data_premio FROM \"Campanha\" WHERE id=$P1)")" "9|$T9"

echo "===================================================================="
echo "CAMPANHAS-DB${CAMP_NEG:+ (controle negativo: $CAMP_NEG)}: PASS=$passes FAIL=$fails"
if [ -n "${CAMP_NEG:-}" ]; then
  [ $fails -gt 0 ] && echo "controle negativo EFETIVO: o driver reprovou ($fails) sem a protecao" || echo "ATENCAO: controle negativo NAO reprovou nada — controle oco"
  exit 0
fi
echo "===================================================================="
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)

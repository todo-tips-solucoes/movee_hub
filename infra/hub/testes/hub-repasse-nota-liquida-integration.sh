#!/usr/bin/env bash
# =============================================================================
# hub-repasse-nota-liquida-integration.sh — feature repasse-gera-movimento, FASE 2 (migration 0118).
# Stack EFEMERO (hub-test-*): aplica TODAS as migrations e exercita as RPCs como o PostgREST as chamaria
# (SET ROLE authenticated + claims). Nao toca producao. Driver proprio (e nao o do lancamento externo) porque
# aquele fixa `categorias_nota = NULL`; aqui a empresa 6 TEM divisao da nota.
#
# Cenarios: C4 (nota liquida abate a deducao) T01/T02 · C5 (excedente vira transportado_nota negativo) T03 ·
# C5 semana N+1 (buraco da CTE) T04 · configurado e sem credito grava 0 T05 · prévia==congelado==item (SC-002) ·
# T08 idempotencia da 0118 · T09/S5 ACL · alocar_envio_id (S1).
#
# Controles negativos (so em stack de teste, NUNCA em hub_homolog):
#   LE_NEG=sem-0118      -> reaplica a 0117 por cima (funcoes voltam ao corpo antigo)              (T01 T03 T04 T05 + paridade)
#   LE_NEG=sem-excedente -> o excedente da deducao deixa de ir a transportado_nota                  (T03 + nota de N+1)
#   LE_NEG=sem-predicado -> remove `OR transportado_nota <> 0` da CTE linhas                         (T04a)
#   LE_NEG=sem-negativo  -> a nota de semana com remanescente negativo volta a SOMAR o saldo carregado (duplica)       (T04c)
#   LE_NEG=sem-case      -> grava total_nota cru (NULL) em valor_nota, sem o CASE/COALESCE            (T05)
#   LE_NEG=acl-public    -> concede EXECUTE a PUBLIC nas tres funcoes                                  (T09)
#   LE_NEG=sem-grant     -> REVOGA o USAGE de authenticated na sequencia. Prova que o check do grant NAO e oco:
#                           no hub_homolog a 0033 ja concede (a tabela foi criada por ela), logo sem esta
#                           revogacao o check passaria COM e SEM o GRANT da 0118. Em PRODUCAO a EnvioMassa e
#                           LEGADA e o grant NAO existe -- medido 2026-10-28.                        (S1 grant)
#
# Uso: infra/hub/testes/hub-repasse-nota-liquida-integration.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)-$$"
PROJECT="hub-test-$RUNID"
TMP="$(mktemp -d)"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
cleanup() { dc down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou"; exit 1; }
echo "subindo db efemero ($PROJECT)..."
dc up -d --wait db

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
psql_relaxed() { dc exec -T db psql -U "$DB_USER" -d "$DB_NAME" "$@"; }

fails=0; passes=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; passes=$((passes + 1)); else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails + 1)); fi
}

"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate1.log" 2>&1 \
  || { echo "FAIL: migrate"; tail -30 "$TMP/migrate1.log"; exit 1; }
grep -q "0118_repasse_nota_a_emitir.sql" "$TMP/migrate1.log" || { echo "FAIL: 0118 nao aplicada"; exit 1; }

# --- T08 (P3): idempotencia — reaplicar o arquivo INTEIRO nao falha nem muda o corpo de nenhuma funcao -----
MIG="$HUB_DIR/migrations/0118_repasse_nota_a_emitir.sql"
md5_all() { psql_t -tAc "SELECT md5(string_agg(pg_get_functiondef(p.oid), '|' ORDER BY p.proname)) FROM pg_proc p WHERE p.proname IN ('hub_adiantamento_repasse_fechar','hub_adiantamento_repasse','hub_adiantamento_repasse_congelado','hub_repasse_alocar_envio_id');"; }
ACL_ALL() { psql_t -tAc "SELECT string_agg(p.proname||'='||COALESCE(p.proacl::text,'NULL'), '|' ORDER BY p.proname) FROM pg_proc p WHERE p.proname IN ('hub_adiantamento_repasse_fechar','hub_adiantamento_repasse','hub_adiantamento_repasse_congelado','hub_repasse_alocar_envio_id');"; }
M1="$(md5_all)"; A1="$(ACL_ALL)"
psql_t -q -f - < "$MIG" >"$TMP/reapply.log" 2>&1; RC=$?
check "T08 (P3): reaplicar a 0118 inteira (2a vez) nao falha" "$RC" "0"
check "T08 (P3): corpo de TODAS as funcoes identico apos a 2a aplicacao" "$(md5_all)" "$M1"
check "T08 (P3): ACL identica apos a 2a aplicacao" "$(ACL_ALL)" "$A1"
# controle: uma variante SEM `IF NOT EXISTS` TEM de falhar na 2a aplicacao (prova que o teste detecta nao-idempotencia)
sed 's/ADD COLUMN IF NOT EXISTS/ADD COLUMN/' "$MIG" > "$TMP/variante.sql"
cmp -s "$MIG" "$TMP/variante.sql" && { echo "FAIL: variante identica ao original (controle OCO)"; exit 1; }
psql_t -q -f - < "$TMP/variante.sql" >"$TMP/variante.log" 2>&1; RCV=$?
check "T08 (controle): variante sem IF NOT EXISTS FALHA na reaplicacao (o teste de idempotencia nao e oco)" "$([ "$RCV" -ne 0 ] && echo falhou || echo passou)" "falhou"

# --- controles negativos: altera a funcao SO neste stack efemero -------------
patch_fn() { # patch_fn <regprocedure> <sed-expr>
  psql_t -tA -c "SELECT pg_get_functiondef('$1'::regprocedure);" > "$TMP/fn.sql"
  cp "$TMP/fn.sql" "$TMP/fn.orig"
  sed -i "$2" "$TMP/fn.sql"
  cmp -s "$TMP/fn.orig" "$TMP/fn.sql" && { echo "FAIL: patch_fn nao alterou $1 (controle negativo OCO: a expressao nao casa com o corpo vivo)"; exit 1; }
  psql_t -q < "$TMP/fn.sql" >/dev/null
}
FECHAR='hub_adiantamento_repasse_fechar(date)'
case "${LE_NEG:-}" in
  sem-0118)
    psql_t -q -f - < "$HUB_DIR/migrations/0117_lancamento_externo.sql" >"$TMP/neg.log" 2>&1 || { echo "FAIL: sem-0118 nao reaplicou a 0117"; tail -5 "$TMP/neg.log"; exit 1; }
    echo "NEG sem-0118: fechar volta ao corpo antigo? $(psql_t -tAc "SELECT pg_get_functiondef('$FECHAR'::regprocedure) !~ 'nota_a_emitir'") (t esperado)";;
  sem-excedente)
    patch_fn "$FECHAR" 's/ELSE LEAST(b\.base_nota, 0) - (b\.externos_deducao - b\.deducao_aplicada_na_nota)/ELSE LEAST(b.base_nota, 0)/'
    echo "NEG sem-excedente: excedente presente? $(psql_t -tAc "SELECT pg_get_functiondef('$FECHAR'::regprocedure) ~ 'b.externos_deducao - b.deducao_aplicada_na_nota\)'") (f esperado)";;
  sem-predicado)
    patch_fn "$FECHAR" 's/OR COALESCE(sa\.transportado_nota, 0) <> 0)/)/'
    echo "NEG sem-predicado: predicado presente? $(psql_t -tAc "SELECT pg_get_functiondef('$FECHAR'::regprocedure) ~ 'sa.transportado_nota, 0\) <> 0'") (f esperado)";;
  sem-negativo)
    patch_fn "$FECHAR" 's/CASE WHEN r\.remanescente < 0 THEN 0 ELSE r\.saldo_anterior_nota END/r.saldo_anterior_nota/g'
    echo "NEG sem-negativo: guarda de remanescente negativo presente? $(psql_t -tAc "SELECT pg_get_functiondef('$FECHAR'::regprocedure) ~ 'r.remanescente < 0 THEN 0 ELSE r.saldo_anterior_nota'") (f esperado)";;
  sem-case)
    patch_fn "$FECHAR" 's/CASE WHEN v_config\.categorias_nota IS NULL THEN NULL ELSE COALESCE(r\.total_nota, 0) END,/r.total_nota,/'
    echo "NEG sem-case: CASE de valor_nota presente? $(psql_t -tAc "SELECT pg_get_functiondef('$FECHAR'::regprocedure) ~ 'ELSE COALESCE\(r.total_nota, 0\) END'") (f esperado)";;
  sem-grant)
    psql_t -q <<'SQL'
REVOKE USAGE, SELECT ON SEQUENCE "EnvioMassa_id_seq" FROM authenticated;
SQL
    _tem=$(psql_t -tAc "SELECT has_sequence_privilege('authenticated','\"EnvioMassa_id_seq\"','USAGE')")
    [ "$_tem" = "f" ] || { echo "FAIL: REVOKE nao surtiu efeito (controle negativo OCO: ainda $_tem)"; exit 1; }
    echo "NEG sem-grant: authenticated tem USAGE na sequencia? $_tem (f esperado)";;
  acl-public)
    psql_t -q <<'SQL'
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse(date, text, boolean, int, int) TO PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse_congelado(date, text, boolean, int, int) TO PUBLIC;
GRANT EXECUTE ON FUNCTION hub_repasse_alocar_envio_id() TO PUBLIC;
SQL
    echo "NEG acl-public: PUBLIC concedido em alocar? $(psql_t -tAc "SELECT has_function_privilege('hub_web_anon','hub_repasse_alocar_envio_id()','EXECUTE')") (t esperado)";;
esac

# --- fixtures SINTETICAS (CNPJ 9000000000001N, nomes ficticios) --------------
psql_t -v ON_ERROR_STOP=1 <<'SQL' >"$TMP/seed.log" 2>&1
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES
  ('90000000000011','Nota Teste 11'),('90000000000012','Nota Teste 12'),('90000000000013','Nota Teste 13'),('90000000000015','Nota Teste 15'),('90000000000016','Nota Teste 16');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
SELECT 6, gen_random_uuid(), c.nome, c.id FROM "ContaMotorista" c WHERE c.cnpj_prestador LIKE '900000000000_%';
INSERT INTO "Usuario" (email, senha_hash, nome) VALUES ('fin@example.com','x','Fin');
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ((SELECT id FROM "Usuario" WHERE email='fin@example.com'), 6, (SELECT id FROM "Papel" WHERE nome='financeiro_aprovador'), true);
-- semana comeca na SEGUNDA (dia 1). COM categorias_nota: 'Corrida' compoe a nota; 'Gorjeta' e fora da nota.
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato, categorias_nota, desconto_debitos)
VALUES (6, 90, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '23:59', 60.00, 0.35, 'financeiro_lancamento', ARRAY['Corrida'], 'x', 'x {nome}', 1, 2, 'data_lancamento', ARRAY['Corrida','Gorjeta'], ARRAY['Corrida'], true);
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES (6, 'faturamento', repeat('e',64), 'completed');
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
SELECT 6, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('e',64)),
       (SELECT e.id FROM "Entregador" e JOIN "ContaMotorista" c ON c.id=e.motorista_id WHERE c.cnpj_prestador=v.cnpj),
       v.dia::date, v.dia::date, 'Credito', v.valor, v.cat, md5(v.cnpj||v.dia||v.cat)||md5(v.cat||v.dia||v.cnpj)
FROM (VALUES
  ('90000000000011','2026-09-16',100.00,'Corrida'),('90000000000011','2026-09-16',20.00,'Gorjeta'),
  ('90000000000012','2026-09-16',40.00,'Corrida'),('90000000000012','2026-09-16',60.00,'Gorjeta'),
  ('90000000000013','2026-09-16',10.00,'Gorjeta'),
  ('90000000000015','2026-09-16',40.00,'Corrida'),('90000000000015','2026-09-16',60.00,'Gorjeta'),
  ('90000000000015','2026-09-23',50.00,'Corrida'),
  ('90000000000016','2026-09-16',40.00,'Corrida'),('90000000000016','2026-09-16',60.00,'Gorjeta'),
  ('90000000000016','2026-09-23',20.00,'Corrida')
) AS v(cnpj,dia,valor,cat);
-- M16, semana N+1: um DEBITO grande leva o remanescente a NEGATIVO (caixa < 0) com divida de nota carregada
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
SELECT 6, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('e',64)),
       (SELECT e.id FROM "Entregador" e JOIN "ContaMotorista" c ON c.id=e.motorista_id WHERE c.cnpj_prestador='90000000000016'),
       '2026-09-24', '2026-09-24', 'Debito', 100.00, 'Multa', md5('deb16')||md5('16deb');
SQL
[ $? -eq 0 ] || { echo "FAIL: seed"; cat "$TMP/seed.log"; exit 1; }

rpc() { # rpc <sql> -> como financeiro, empresa 6
  psql_relaxed -tA 2>&1 <<SQL | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | grep -v '^{"sub"'
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub',(SELECT id FROM "Usuario" WHERE email='fin@example.com'),'empresa_ativa','6','escopo','[6]'::jsonb)::text, true);
SET ROLE authenticated;
$1
ROLLBACK;
SQL
}
rpcc() {
  psql_relaxed -tA 2>&1 <<SQL | grep -vE '^(BEGIN|COMMIT|ROLLBACK|SET)$' | grep -v '^$' | grep -v '^{"sub"'
BEGIN;
SELECT set_config('request.jwt.claims', jsonb_build_object('sub',(SELECT id FROM "Usuario" WHERE email='fin@example.com'),'empresa_ativa','6','escopo','[6]'::jsonb)::text, true);
SET ROLE authenticated;
$1
COMMIT;
SQL
}
aplicar() { # aplicar <cnpj> <data> <valor> -> ADIANTAMENTO
  rpcc "SELECT idx||':'||situacao FROM hub_lancamento_externo_aplicar('ADIANTAMENTO', '[{\"i\":0,\"cnpj\":\"$1\",\"data\":\"$2\",\"valor\":\"$3\",\"obs\":null}]'::jsonb);"
}
# item <periodo> <cnpj> -> valor_nota|valor_fora|nota_a_emitir|transportado_nota|transportado_fora|valor_pago|remanescente
item() { psql_t -tAc "SELECT COALESCE(i.valor_nota::text,'NULL')||'|'||COALESCE(i.valor_fora_nota::text,'NULL')||'|'||COALESCE(i.nota_a_emitir::text,'NULL')||'|'||i.transportado_nota||'|'||i.transportado_fora||'|'||i.valor_pago||'|'||i.remanescente FROM \"ApuracaoRepasseItem\" i JOIN \"ApuracaoRepasse\" a ON a.id=i.apuracao_id JOIN \"Entregador\" e ON e.id=i.entregador_id JOIN \"ContaMotorista\" c ON c.id=e.motorista_id WHERE a.periodo_inicio='$1' AND c.cnpj_prestador='$2';"; }
# nota nas duas superficies de leitura (to_jsonb: a coluna ausente da NULL em vez de erro)
previa_nota()    { rpc "SELECT COALESCE(round((to_jsonb(t)->>'nota_a_emitir')::numeric,2)::text,'NULL') FROM hub_adiantamento_repasse('$1') t WHERE t.nome='$2';"; }
congelado_nota() { rpc "SELECT COALESCE(round((to_jsonb(t)->>'nota_a_emitir')::numeric,2)::text,'NULL') FROM hub_adiantamento_repasse_congelado('$1') t WHERE t.nome='$2';"; }

# ============ pagos por fora (semana N = 2026-09-14) ============
check "pre: M11 ADIANTAMENTO 30 aplicado" "$(aplicar 90000000000011 2026-09-17 30.00)" "0:APLICADA"
check "pre: M12 ADIANTAMENTO 70 aplicado" "$(aplicar 90000000000012 2026-09-17 70.00)" "0:APLICADA"
check "pre: M15 ADIANTAMENTO 70 aplicado" "$(aplicar 90000000000015 2026-09-17 70.00)" "0:APLICADA"
check "pre: M16 ADIANTAMENTO 70 aplicado" "$(aplicar 90000000000016 2026-09-17 70.00)" "0:APLICADA"

PV11="$(previa_nota 2026-09-14 'Nota Teste 11')"; PV12="$(previa_nota 2026-09-14 'Nota Teste 12')"
check "fechamento da semana N" "$(rpcc "SELECT motoristas FROM hub_adiantamento_repasse_fechar('2026-09-14');")" "5"

# ============ T01/T02 — C4: a deducao abate a NOTA; a gorjeta nao e tocada ============
check "T01 nota liquida abate a deducao (C4): 100 de nota - 30 = 70; remanescente 90; sem transporte" "$(item 2026-09-14 90000000000011)" "100.00|20.00|70.00|0.00|0.00|90.00|90.00"
check "T02 gorjeta intacta com pago por fora (C4): valor_fora_nota 20,00 e transportado_fora 0" "$(item 2026-09-14 90000000000011 | cut -d'|' -f2,5)" "20.00|0.00"
# ============ T03 — C5 semana N: excedente ============
check "T03 excedente zera a nota e vira transportado_nota negativo (C5): nota 40, deducao 70 -> nota_a_emitir 0, transportado_nota -30,00, pago 30" "$(item 2026-09-14 90000000000012)" "40.00|60.00|0.00|-30.00|0.00|30.00|30.00"
# ============ T05 ============
check "T05 configurado e sem credito de nota grava 0, nao NULL: valor_nota 0,00 e nota_a_emitir 0,00" "$(item 2026-09-14 90000000000013)" "0.00|10.00|0.00|0.00|0.00|10.00|10.00"
# ============ SC-002: previa == item == congelado ============
check "SC-002: previa (antes de fechar) devolve o MESMO nota_a_emitir que o fechamento gravou (M11)" "$PV11" "70.00"
check "SC-002: previa (antes de fechar) devolve o MESMO nota_a_emitir que o fechamento gravou (M12 = 0)" "$PV12" "0.00"
check "SC-002: congelado devolve o nota_a_emitir gravado (M11)" "$(congelado_nota 2026-09-14 'Nota Teste 11')" "70.00"

# ============ T04 — C5 semana N+1 (buraco da CTE) ============
PV16b="$(previa_nota 2026-09-21 'Nota Teste 16')"; PV12b="$(previa_nota 2026-09-21 'Nota Teste 12')"; PV15b="$(previa_nota 2026-09-21 'Nota Teste 15')"
check "fechamento da semana N+1 (so quem tem producao ou divida de nota: M12, M15 e M16)" "$(rpcc "SELECT motoristas FROM hub_adiantamento_repasse_fechar('2026-09-21');")" "3"
check "T04a semana N+1 sem producao: o motorista com divida de nota ENTRA (M12) e a divida segue" "$(item 2026-09-21 90000000000012)" "0.00|0.00|0.00|-30.00|0.00|0.00|0.00"
check "T04b semana N+1 com producao: nota 50 - divida 30 = 20 (sem o transporte sairia 50); divida zerada" "$(item 2026-09-21 90000000000015)" "50.00|0.00|20.00|0.00|0.00|50.00|50.00"
check "T04c remanescente NEGATIVO com divida de nota (M16): a nota e so a producao da semana (20,00, SEM somar o saldo -30,00) e a divida segue em transportado_nota (dec-055: nao duplica)" "$(item 2026-09-21 90000000000016)" "20.00|0.00|20.00|-30.00|0.00|0.00|-80.00"
check "SC-002 N+1: previa == fechamento com remanescente negativo (M16 = 20,00)" "$PV16b" "20.00"
check "SC-002 N+1: previa == fechamento (M15 = 20,00)" "$PV15b" "20.00"
check "SC-002 N+1: previa == fechamento (M12 = 0,00)" "$PV12b" "0.00"

# ============ T09 / S5 — ACL ============
SIGS="hub_adiantamento_repasse_fechar(date) hub_adiantamento_repasse(date,text,boolean,integer,integer) hub_adiantamento_repasse_congelado(date,text,boolean,integer,integer) hub_repasse_alocar_envio_id()"
for s in $SIGS; do
  check "T09 ACL: anon SEM EXECUTE em $s" "$(psql_t -tAc "SELECT has_function_privilege('hub_web_anon','$s','EXECUTE')")" "f"
  check "T09 ACL: authenticated COM EXECUTE em $s" "$(psql_t -tAc "SELECT has_function_privilege('authenticated','$s','EXECUTE')")" "t"
  check "T09 ACL: proacl de $s nao tem a entrada de PUBLIC (=X/)" "$(psql_t -tAc "SELECT count(*) FROM pg_proc p, unnest(p.proacl) a WHERE p.oid='$s'::regprocedure AND a::text LIKE '=%'")" "0"
done
# ============ S1 — hub_repasse_alocar_envio_id ============
IDS="$(rpcc "SELECT hub_repasse_alocar_envio_id();" | tr '\n' ' ')"
IDS2="$(rpcc "SELECT hub_repasse_alocar_envio_id();" | tr '\n' ' ')"
check "S1: alocar_envio_id devolve ids estritamente crescentes (authenticated)" "$([ "${IDS%% *}" -lt "${IDS2%% *}" ] 2>/dev/null && echo crescente || echo nao)" "crescente"
check "S1: alocar_envio_id recusado para anon (permission denied)" "$(psql_relaxed -tA 2>&1 <<'SQL' | grep -c 'permission denied'
SET ROLE hub_web_anon;
SELECT hub_repasse_alocar_envio_id();
SQL
)" "1"
check "S1: authenticated MEDIDO com USAGE na sequencia (has_sequence_privilege; producao nao herda o grant da 0033)" "$(psql_t -tAc "SELECT has_sequence_privilege('authenticated','\"EnvioMassa_id_seq\"','USAGE')")" "t"
check "S1: a funcao e SECURITY INVOKER (prosecdef = f)" "$(psql_t -tAc "SELECT prosecdef FROM pg_proc WHERE proname='hub_repasse_alocar_envio_id'")" "f"

echo ""; echo "===================================================================="
echo "RESULTADO: $passes PASS / $fails FAIL"
echo "===================================================================="
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)

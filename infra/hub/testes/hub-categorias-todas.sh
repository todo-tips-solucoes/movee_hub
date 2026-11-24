#!/usr/bin/env bash
# =============================================================================
# hub-categorias-todas.sh — 0131 (categorias do adiantamento: modo "Todas, exceto as marcadas").
# Stack EFEMERO (hub-test-*): aplica TODAS as migrations, reaplica a 0131 2x, roda
# sql/0131-categorias-todas.test.sql numa transacao com ROLLBACK (inclui os casos compartilhados com o
# cliente: frontend_v2/lib/hub/casa-categoria-casos.json) e testa o rollback da 0131. Nao toca producao.
#
# Controle negativo (guarda anti-oco: ABORTA se a reversao nao aplicou):
#   CAT_NEG=modo  -> casa() ignora o token modo:todas (os casos do modo "todas" devem FALHAR)
# CAT_REUSE=<projeto compose ja no ar e migrado> reaproveita o stack (so para desenvolver).
# Uso: infra/hub/testes/hub-categorias-todas.sh
# =============================================================================
set -uo pipefail
HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
PROJECT="${CAT_REUSE:-hub-test-cat-$(date +%s)-$$}"
TMP="$(mktemp -d)"
JSON="$HUB_DIR/../../app_homologacao/frontend_v2/lib/hub/casa-categoria-casos.json"
. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
cleanup() { [ -n "${CAT_REUSE:-}" ] || dc down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
psql_r() { dc exec -T db psql -U "$DB_USER" -d "$DB_NAME" "$@"; }
MIG="$HUB_DIR/migrations/0131_categorias_modo_todas.sql"
ROLL="$HUB_DIR/testes/sql/0131-rollback.sql"
TESTE="$HUB_DIR/testes/sql/0131-categorias-todas.test.sql"
fails=0; passes=0
check() { if [ "$2" = "$3" ]; then echo "PASS: $1"; passes=$((passes+1)); else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails+1)); fi; }
[ -f "$JSON" ] || { echo "FAIL: casos compartilhados ausentes: $JSON"; exit 1; }

if [ -z "${CAT_REUSE:-}" ]; then
  df -h / | awk 'NR==2{print "disco livre: "$4}'
  "$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >/dev/null || { echo "preflight abortou"; exit 1; }
  dc up -d --wait db >/dev/null
  "$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/m1.log" 2>&1 || { echo "FAIL: migrate"; tail -20 "$TMP/m1.log"; exit 1; }
  grep -q "0131_categorias_modo_todas.sql" "$TMP/m1.log" || { echo "FAIL: 0131 nao aplicada"; exit 1; }
fi
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/m2.log" 2>&1
check "migrate.sh 2x: 0131 pulada na 2a corrida" "$(grep -c 'pulada (já aplicada): 0131' "$TMP/m2.log")" "1"
for i in 1 2; do
  check "0131 reaplicada a mao ($i) sem erro" "$(psql_r -q -f - < "$MIG" 2>&1 | grep -c 'ERROR')" "0"
done

if [ "${CAT_NEG:-}" = modo ]; then
  psql_t -tA -c "SELECT pg_get_functiondef('hub_adiantamento_categoria_casa(text,text[])'::regprocedure);" > "$TMP/fn.sql"
  cp "$TMP/fn.sql" "$TMP/fn.orig"
  sed -i "s/WHEN 'modo:todas' = ANY (p_categorias)/WHEN false/" "$TMP/fn.sql"
  cmp -s "$TMP/fn.orig" "$TMP/fn.sql" && { echo "ABORTA: reversao nao alterou o texto (controle OCO)"; exit 1; }
  psql_t -q < "$TMP/fn.sql" >/dev/null
  psql_t -tA -c "SELECT pg_get_functiondef('hub_adiantamento_categoria_casa(text,text[])'::regprocedure) LIKE '%WHEN false%'" | grep -q t || { echo "ABORTA: reversao nao esta no corpo vivo"; exit 1; }
  echo "NEG modo: casa() ignora modo:todas (conferido no corpo vivo)"
fi

# --- testes (transacao com ROLLBACK; NOTICE sai no stderr do psql) ---
{
  echo 'BEGIN;'
  echo 'CREATE TEMP TABLE _json (j jsonb);'
  echo "INSERT INTO _json VALUES (\$json\$$(cat "$JSON")\$json\$);"
  cat "$TESTE"
  echo 'ROLLBACK;'
} | psql_r -q 2>&1 | sed 's/^psql:[^ ]* //' > "$TMP/teste.full"
grep -E 'ERROR:|divergente|casa\(' "$TMP/teste.full" | head -30
grep -E 'NOTICE:  (PASS|FAIL):' "$TMP/teste.full" | sed 's/^NOTICE:  //'
passes=$((passes + $(grep -c 'NOTICE:  PASS:' "$TMP/teste.full")))
erros_sql="$(grep -c 'ERROR:' "$TMP/teste.full")"
fails=$((fails + $(grep -c 'NOTICE:  FAIL:' "$TMP/teste.full") + erros_sql))

if [ -z "${CAT_NEG:-}" ]; then
  echo "--- rollback da 0131 ---"
  OUT="$({ echo 'BEGIN;'; cat <<'SQL'
INSERT INTO "AdiantamentoConfiguracao" SELECT (jsonb_populate_record(NULL::"AdiantamentoConfiguracao", to_jsonb(c) || jsonb_build_object('id', nextval(pg_get_serial_sequence('"AdiantamentoConfiguracao"','id')), 'versao', c.versao + 1, 'fonte_producao','financeiro_lancamento','categorias_producao', ARRAY['modo:todas','Gorjeta']))).* FROM "AdiantamentoConfiguracao" c WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;
SQL
  cat "$ROLL"; echo 'ROLLBACK;'; } | psql_r -q 2>&1)"
  check "rollback RECUSA com config vigente em modo:todas" "$(echo "$OUT" | grep -c 'ROLLBACK_0131_RECUSADO: ha configuracao')" "1"
  OUT="$({ echo 'BEGIN;'; cat <<'SQL'
INSERT INTO "AdiantamentoConfiguracao" SELECT (jsonb_populate_record(NULL::"AdiantamentoConfiguracao", to_jsonb(c) || jsonb_build_object('id', nextval(pg_get_serial_sequence('"AdiantamentoConfiguracao"','id')), 'versao', c.versao + 1, 'categorias_extrato', ARRAY['familia:indicador']))).* FROM "AdiantamentoConfiguracao" c WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1;
SQL
  cat "$ROLL"; echo 'ROLLBACK;'; } | psql_r -q 2>&1)"
  check "rollback RECUSA com config vigente em familia:indicador" "$(echo "$OUT" | grep -c 'ROLLBACK_0131_RECUSADO: ha configuracao')" "1"
  OUT="$({ echo 'BEGIN;'; cat "$ROLL"; cat <<'SQL'
DO $$ BEGIN
  RAISE NOTICE 'R: tokens_ok=% familias=%', COALESCE(to_regprocedure('hub_adiantamento_categorias_tokens_ok(text[])')::text,'NULL'), COALESCE(to_regprocedure('hub_adiantamento_familias()')::text,'NULL');
  RAISE NOTICE 'R: casa_antiga=%', hub_adiantamento_categoria_casa('Gorjeta', ARRAY['modo:todas']);
  RAISE NOTICE 'R: indicador_familia=%', COALESCE(hub_adiantamento_categoria_familia('Percentual atingido de x'), 'NULL');
  RAISE NOTICE 'R: cols=%', (SELECT cardinality(proargnames) FROM pg_proc WHERE oid = 'hub_adiantamento_categorias(text)'::regprocedure);
  RAISE NOTICE 'R: cols_camp=%', (SELECT cardinality(proargnames) FROM pg_proc WHERE oid = 'hub_campanha_categorias()'::regprocedure);
  RAISE NOTICE 'R: checks=%', (SELECT count(*) FROM pg_constraint WHERE conname LIKE 'adiantamentoconfiguracao_categorias_%_tokens_chk');
  RAISE NOTICE 'R: salvar_valida=%', (SELECT prosrc LIKE '%DADOS_INVALIDOS_CATEGORIAS%' FROM pg_proc WHERE oid = 'hub_adiantamento_configuracao_salvar(int,jsonb)'::regprocedure);
  RAISE NOTICE 'R: campanha_ok_modo=%', hub_campanha_categorias_ok(ARRAY['modo:todas']);
END $$;
SQL
  cat "$MIG"; cat <<'SQL'
DO $$ BEGIN RAISE NOTICE 'R2: reaplicada: familias=% casa_todas=%', hub_adiantamento_familias(), hub_adiantamento_categoria_casa('Gorjeta', ARRAY['modo:todas']); END $$;
SQL
  echo 'ROLLBACK;'; } | psql_r -q 2>&1)"
  echo "$OUT" | grep -E 'ERROR|NOTICE:  R2?:' | sed 's/^.*NOTICE:  //'
  check "rollback: sem lista em modo todas roda sem ERRO" "$(echo "$OUT" | grep -c 'ERROR')" "0"
  check "rollback: tokens_ok e familias() removidas" "$(echo "$OUT" | grep -c 'R: tokens_ok=NULL familias=NULL')" "1"
  check "rollback: casa() volta a tratar modo:todas como nome (Gorjeta nao casa)" "$(echo "$OUT" | grep -c 'R: casa_antiga=f')" "1"
  check "rollback: familia indicador some" "$(echo "$OUT" | grep -c 'R: indicador_familia=NULL')" "1"
  check "rollback: seletores voltam ao retorno anterior" "$(echo "$OUT" | grep -cE 'R: cols=5|R: cols_camp=4')" "2"
  check "rollback: 3 CHECKs removidos" "$(echo "$OUT" | grep -c 'R: checks=0')" "1"
  check "rollback: salvar sem a validacao" "$(echo "$OUT" | grep -c 'R: salvar_valida=f')" "1"
  check "rollback: campanha_ok volta ao corpo da 0129 (sem a regra de modo:)" "$(echo "$OUT" | grep -c 'R: campanha_ok_modo=t')" "1"
  check "rollback + reaplicar 0131 volta ao estado novo" "$(echo "$OUT" | grep -c 'R2: reaplicada: familias={familia:promocao,familia:missoes,familia:indicador} casa_todas=t')" "1"
fi

echo "===================================================================="
echo "CATEGORIAS-TODAS${CAT_NEG:+ (controle negativo: $CAT_NEG)}: PASS=$passes FAIL=$fails"
if [ -n "${CAT_NEG:-}" ]; then
  [ $fails -gt 0 ] && echo "controle negativo EFETIVO: reprovou ($fails) sem o ramo modo:todas" || echo "ATENCAO: controle negativo NAO reprovou nada — oco"
  exit 0
fi
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)

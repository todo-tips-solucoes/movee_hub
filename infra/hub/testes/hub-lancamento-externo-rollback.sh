#!/usr/bin/env bash
# =============================================================================
# hub-lancamento-externo-rollback.sh — prova o ROLLBACK da 0117 (RUNBOOK §2.R).
# A 0117 mexe em CINCO funcoes JA VIVAS do repasse (mais a SEXTA, `hub_repasse_lote_avaliar`, H1: CREATE OR REPLACE, sem DROP): fechar (CREATE OR REPLACE, tipo de retorno igual) e QUATRO que ganham a coluna
# `lancamentos_externos` (previa, congelado, app-corrente, app-ultimo-fechado) => DROP + CREATE + GRANT. Dropar a tabela
# nova NAO as devolve ao corpo anterior, e REAPLICAR o corpo salvo NAO basta: o tipo de retorno mudou, entao
# `CREATE OR REPLACE` e recusado, e o DROP apaga os GRANT (0098:30). O procedimento (RUNBOOK §2.R) e: salvar
# pg_get_functiondef + proacl ANTES de aplicar; para voltar, DROP (as quatro) -> reaplicar o salvo -> REVOKE ALL FROM
# PUBLIC + GRANT. Este script prova isso em stack efemero:
#   migra ate 0116 -> salva defs + md5 + ACL -> aplica 0117 -> md5 MUDOU -> rollback -> md5 e ACL IGUAIS aos de antes,
#   sem mencao a LancamentoExterno, sem EXECUTE para PUBLIC, dados da tabela nova intactos.
# Controle negativo: RB_NEG=sem-drop (tenta reaplicar SEM o DROP -> tem de FALHAR) e RB_NEG=sem-grant (nao
# reaplica o GRANT -> o check de ACL tem de FALHAR) e RB_NEG=ida-sem-grant (P25: GRANT perdido na IDA -> o check de ACL pos-0117 tem de FALHAR)
# e RB_NEG=escritor-vivo (MEDIUM 9, rodada 3: o rollback NAO derruba `aplicar`/`excluir` -> o check pos-rollback tem de FALHAR).
# =============================================================================
set -euo pipefail
HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
PROJECT="hub-test-$(date +%s)-$$"
TMP="$(mktemp -d)"
. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes" >&2; exit 2; }
dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
trap 'dc down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >/dev/null || { echo "preflight abortou"; exit 1; }
dc up -d --wait db >/dev/null 2>&1
psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
mig() { "$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" "$@" >"$TMP/m.log" 2>&1 || { echo "FAIL: migrate $*"; tail -15 "$TMP/m.log"; exit 1; }; }
fails=0
ck() { if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails+1)); fi; }
PREVIA='hub_adiantamento_repasse(date,text,boolean,integer,integer)'; FECHAR='hub_adiantamento_repasse_fechar(date)'; APP='hub_adiantamento_repasse_motorista()'
CONG='hub_adiantamento_repasse_congelado(date,text,boolean,integer,integer)'; ULT='hub_adiantamento_repasse_motorista_ultimo_fechado()'
FNS=("$PREVIA" "$FECHAR" "$APP" "$CONG" "$ULT")
# H1 (rodada 2): a SEXTA funcao tocada — `hub_repasse_lote_avaliar` (CREATE OR REPLACE, tipo de retorno igual, ACL so do dono:
# nao tem EXECUTE para authenticated). Fica FORA de FNS de proposito: os checks de FNS exigem 'authenticated=t', que aqui seria falso.
AVAL='hub_repasse_lote_avaliar(bigint[],integer[])'
# as QUATRO que mudam de tipo de retorno (precisam de DROP antes de voltar); `fechar` volta por CREATE OR REPLACE
MUDAM_TIPO=("$PREVIA" "$APP" "$CONG" "$ULT")
md5_fn() { psql_t -tAc "SELECT md5(pg_get_functiondef('$1'::regprocedure));"; }
acl_fn() { psql_t -tAc "SELECT COALESCE(proacl::text,'<nulo>') FROM pg_proc WHERE oid='$1'::regprocedure;"; }
public_exec() { psql_t -tAc "SELECT count(*) FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE p.oid='$1'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE';"; }
save_fn() { psql_t -tAc "SELECT pg_get_functiondef('$1'::regprocedure);" > "$2"; echo ";" >> "$2"; }

mig -t 0116
declare -A OLD_MD5 OLD_ACL
n=0
for f in "${FNS[@]}"; do
  OLD_MD5[$f]="$(md5_fn "$f")"; OLD_ACL[$f]="$(acl_fn "$f")"; save_fn "$f" "$TMP/fn$n.sql"; n=$((n+1))
done
AVAL_MD5="$(md5_fn "$AVAL")"; AVAL_ACL="$(acl_fn "$AVAL")"; save_fn "$AVAL" "$TMP/aval.sql"
ck "pre-0117: o corpo salvo da avaliar do lote (0112) existe e NAO tem a excecao do credito externo" "$([ -s "$TMP/aval.sql" ] && ! grep -q 'lancamentos_externos' "$TMP/aval.sql" && echo sim || echo nao)" "sim"
ck "pre-0117: nenhuma das cinco menciona LancamentoExterno" "$(psql_t -tAc "SELECT count(*) FROM pg_proc WHERE proname IN ('hub_adiantamento_repasse','hub_adiantamento_repasse_fechar','hub_adiantamento_repasse_motorista','hub_adiantamento_repasse_congelado','hub_adiantamento_repasse_motorista_ultimo_fechado') AND prosrc ~ 'LancamentoExterno'")" "0"
ck "pre-0117: as cinco tem EXECUTE para authenticated e NENHUMA para PUBLIC" "$(for f in "${FNS[@]}"; do echo "$(psql_t -tAc "SELECT has_function_privilege('authenticated','$f','EXECUTE')")/$(public_exec "$f")"; done | sort -u)" "t/0"

mig
for f in "${FNS[@]}"; do
  ck "pos-0117: $f MUDOU (md5 diferente)" "$([ "$(md5_fn "$f")" != "${OLD_MD5[$f]}" ] && echo sim || echo nao)" "sim"
done
ck "pos-0117: as cinco seguem com EXECUTE para authenticated e NENHUMA para PUBLIC (o DROP nao deixou a funcao aberta)" "$(for f in "${FNS[@]}"; do echo "$(psql_t -tAc "SELECT has_function_privilege('authenticated','$f','EXECUTE')")/$(public_exec "$f")"; done | sort -u)" "t/0"
ck "pos-0117 (H1): hub_repasse_lote_avaliar MUDOU (md5 diferente) e agora conhece lancamentos_externos" "$([ "$(md5_fn "$AVAL")" != "$AVAL_MD5" ] && psql_t -tAc "SELECT pg_get_functiondef('$AVAL'::regprocedure) ~ 'lancamentos_externos'" | grep -q t && echo sim || echo nao)" "sim"
ck "pos-0117 (MEDIUM 9/rodada 3): aplicar e excluir EXISTEM com EXECUTE para authenticated e NENHUM para PUBLIC" "$(for f in 'hub_lancamento_externo_aplicar(text,jsonb)' 'hub_lancamento_externo_excluir(bigint)'; do echo "$(psql_t -tAc "SELECT has_function_privilege('authenticated','$f','EXECUTE')")/$(public_exec "$f")"; done | sort -u)" "t/0"
ck "pos-0117 (H1): ACL da avaliar IGUAL a de antes (CREATE OR REPLACE nao mexe em GRANT)" "$(acl_fn "$AVAL")" "$AVAL_ACL"
# Controle negativo do P25: RB_NEG=ida-sem-grant simula um GRANT perdido no DROP+CREATE da 0117 (o check de ACL da IDA tem de FALHAR).
[ "${RB_NEG:-}" = "ida-sem-grant" ] && psql_t -q -c "REVOKE EXECUTE ON FUNCTION $PREVIA FROM authenticated;" >/dev/null
# P25: o caminho de IDA tambem tem de provar a ACL (o RUNBOOK manda salva-la; sem comparar, um GRANT perdido no
# DROP+CREATE da 0117 ficaria invisivel ate o rollback). A ACL pos-aplicacao tem de ser a mesma de antes.
for f in "${FNS[@]}"; do
  ck "pos-0117: ACL de $f IGUAL a de antes da 0117 (o DROP+CREATE nao perdeu nem acrescentou GRANT)" "$(acl_fn "$f")" "${OLD_ACL[$f]}"
done
ck "pos-0117: as quatro funcoes devolvem a coluna lancamentos_externos" "$(psql_t -tAc "SELECT count(*) FROM pg_proc p WHERE p.oid IN ('$PREVIA'::regprocedure,'$APP'::regprocedure,'$CONG'::regprocedure,'$ULT'::regprocedure) AND 'lancamentos_externos' = ANY (p.proargnames)")" "4"
# a 0117 so ACRESCENTA ao corpo vivo do app: a unica linha removida e a do v_remanescente (prova que o corpo copiado era o vivo)
psql_t -tAc "SELECT pg_get_functiondef('$APP'::regprocedure)" > "$TMP/app-new.sql"
# o corpo salvo do app e o fn2.sql; o RETURNS TABLE ganhou coluna, entao conta so as linhas de CORPO removidas
REMOVIDAS="$(diff <(sed '$d' "$TMP/fn2.sql") "$TMP/app-new.sql" | grep '^<' | grep -c -E 'v_remanescente :=|RETURN QUERY SELECT true|abaixo_do_minimo boolean|NULL::boolean;|v_total < v_config' || true)"
ck "pos-0117: o corpo do app so ACRESCENTA (so mudam as linhas do remanescente, da lista de colunas e do RETURN)" "$([ "$(diff <(sed '$d' "$TMP/fn2.sql") "$TMP/app-new.sql" | grep -c '^<')" = "$REMOVIDAS" ] && echo sim || echo nao)" "sim"
psql_t -q -c "INSERT INTO \"Usuario\" (email, senha_hash, nome) VALUES ('rb@example.com','x','Rb');" >/dev/null
psql_t -q -c "INSERT INTO \"Entregador\" (id_empresa, id_externo, nome) VALUES (6, gen_random_uuid(), 'Rb Teste');" >/dev/null
psql_t -q -c "INSERT INTO \"LancamentoExterno\" (id_empresa, entregador_id, cnpj_prestador, data_pagamento, tipo, valor, criado_por) SELECT 6, e.id, '90000000000099', '2026-09-17', 'ADIANTAMENTO', 30.00, u.id FROM \"Entregador\" e, \"Usuario\" u WHERE e.nome='Rb Teste' AND u.email='rb@example.com';" >/dev/null

# --- ROLLBACK (RUNBOOK §2.R): DROP das quatro que mudam de tipo -> reaplica o salvo -> REVOKE ALL FROM PUBLIC + GRANT ---
if [ "${RB_NEG:-}" = "sem-drop" ]; then
  # controle negativo: reaplicar SEM o DROP. O Postgres RECUSA mudar o tipo de retorno => o procedimento ingenuo falha.
  n=0; ERR=0
  for f in "${FNS[@]}"; do psql_t -1 -q -f - < "$TMP/fn$n.sql" >/dev/null 2>"$TMP/neg.err" || ERR=$((ERR+1)); n=$((n+1)); done
  echo "NEG sem-drop: reaplicacoes recusadas = $ERR (esperado 4: cannot change return type)"
  grep -m1 "cannot change return type" "$TMP/neg.err" >/dev/null && echo "NEG sem-drop: mensagem 'cannot change return type' presente"
else
  # MESMA forma do RUNBOOK §2.R: UMA transacao (tudo ou nada) com DROP -> corpo salvo -> REVOKE/GRANT
  rb_ok=1
  { echo 'BEGIN;'
    echo "DROP FUNCTION $PREVIA; DROP FUNCTION $APP; DROP FUNCTION $CONG; DROP FUNCTION $ULT;"
    n=0; for f in "${FNS[@]}"; do cat "$TMP/fn$n.sql"; n=$((n+1)); done
    cat "$TMP/aval.sql"   # H1: a sexta, por CREATE OR REPLACE (sem DROP: o tipo de retorno nao mudou)
    for f in "${FNS[@]}"; do
      echo "REVOKE ALL ON FUNCTION $f FROM PUBLIC;"
      [ "${RB_NEG:-}" = "sem-grant" ] || echo "GRANT EXECUTE ON FUNCTION $f TO authenticated;"
    done
    # MEDIUM 9: as funcoes ESCRITORAS caem junto (rollback do SQL sem o da imagem deixava `aplicar` com GRANT: importava, dizia
    # "N aplicadas" e NADA deduzia). Sem a funcao a rota falha alto, em vez de mentir.
    if [ "${RB_NEG:-}" != "escritor-vivo" ]; then
      echo 'DROP FUNCTION IF EXISTS hub_lancamento_externo_aplicar(text,jsonb);'
      echo 'DROP FUNCTION IF EXISTS hub_lancamento_externo_excluir(bigint);'
    fi
    echo 'COMMIT;'
  } > "$TMP/rollback.sql"
  psql_t -q -f - < "$TMP/rollback.sql" >/dev/null || rb_ok=0
  ck "rollback: a transacao unica (DROP + reaplicacao + REVOKE/GRANT) executou sem erro" "$rb_ok" "1"
fi
for f in "${FNS[@]}"; do
  ck "rollback: $f volta ao corpo anterior (md5 identico)" "$(md5_fn "$f")" "${OLD_MD5[$f]}"
  ck "rollback: $f volta a ACL anterior (identica a de antes da 0117)" "$(acl_fn "$f")" "${OLD_ACL[$f]}"
done
ck "rollback (MEDIUM 9): as funcoes ESCRITORAS (aplicar, excluir) NAO existem mais — rollback do SQL nao deixa importar 'com sucesso' sem deduzir" "$(psql_t -tAc "SELECT (to_regprocedure('hub_lancamento_externo_aplicar(text,jsonb)') IS NULL)::text||'|'||(to_regprocedure('hub_lancamento_externo_excluir(bigint)') IS NULL)::text")" "true|true"
ck "rollback (H1): avaliar do lote volta ao corpo da 0112 (md5 identico) e a ACL anterior" "$(md5_fn "$AVAL")|$(acl_fn "$AVAL")" "$AVAL_MD5|$AVAL_ACL"
ck "rollback: nenhuma das cinco menciona LancamentoExterno" "$(psql_t -tAc "SELECT count(*) FROM pg_proc WHERE proname IN ('hub_adiantamento_repasse','hub_adiantamento_repasse_fechar','hub_adiantamento_repasse_motorista','hub_adiantamento_repasse_congelado','hub_adiantamento_repasse_motorista_ultimo_fechado') AND prosrc ~ 'LancamentoExterno'")" "0"
ck "rollback: EXECUTE de authenticated preservado (as cinco)" "$(for f in "${FNS[@]}"; do psql_t -tAc "SELECT has_function_privilege('authenticated','$f','EXECUTE')"; done | sort -u)" "t"
ck "rollback: NENHUMA das cinco ficou com EXECUTE para PUBLIC" "$(for f in "${FNS[@]}"; do public_exec "$f"; done | sort -u)" "0"
ck "rollback: nenhuma das quatro devolve a coluna lancamentos_externos" "$(psql_t -tAc "SELECT count(*) FROM pg_proc p WHERE p.oid IN ('$PREVIA'::regprocedure,'$APP'::regprocedure,'$CONG'::regprocedure,'$ULT'::regprocedure) AND 'lancamentos_externos' = ANY (p.proargnames)")" "0"
ck "rollback: dado da tabela nova intacto (a tabela fica; so deixa de pesar no repasse)" "$(psql_t -tAc 'SELECT count(*) FROM "LancamentoExterno"')" "1"
echo "RESULTADO rollback: $([ $fails -eq 0 ] && echo OK || echo "$fails FAIL")"
exit $([ $fails -eq 0 ] && echo 0 || echo 1)

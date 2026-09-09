#!/usr/bin/env bash
# =============================================================================
# hub-enriquecimento-automatico-integration-homolog.sh — FASE 5 (tasks.md 5.1-
# 5.5) da feature hub-enriquecimento-automatico: integração REAL, SEM MOCK,
# contra o ambiente hub-homolog ISOLADO E PERSISTENTE (mesmo padrão de
# hub-motorista-360-integration-homolog.sh — script NOVO, não edita nenhum dos
# existentes). Cobre quickstart.md Scenarios 10, 11, 12, 13, 14, 16, 17.
# Scenario 15 (reprodução em container descartável) é opcional, fora deste
# backlog.
#
# DESENHO — por que a maioria dos cenários chama o PostgREST DIRETO (via
# lib/hub-postgrest-jwt.js#generateHubPostgrestJWT com a claim
# `origemImportacao: true`) em vez de subir CSV pelo endpoint de importação:
# é EXATAMENTE a chamada que `lib/hub-import-processor.js#upsertEntregadoresDoLote`
# faz (mesmo endpoint `Entregador?on_conflict=id_empresa,id_externo`, mesmo
# `Prefer: resolution=merge-duplicates`, mesma claim) — o parsing/normalização
# do CSV já tem cobertura própria (hub-import-parser.test.js/
# hub-import-normalizer.test.js); o que esta FASE 5 precisa provar é o
# GATILHO da 0060 reagindo à claim real, não o pipeline de upload. Os
# cenários que dependem do CÓDIGO DA ROTA (ordenação do GET, POST/PATCH que
# gravam `dados_entrego_solicitado_manual`) usam sessão HTTP real (login QA),
# porque aí sim o que se prova é o handler Express, não só o gatilho —
# exigem a imagem `hub-backend:homolog` REBUILDADA a partir do código atual
# (a onda que gerou este script rebuildou antes de rodar).
#
# EMPRESAS:
#   9001              — tenant QA real (contas já provisionadas, mesmas da
#                        hub-motorista-360-integration-homolog.sh). Usada só
#                        onde é preciso sessão HTTP autenticada (Scenario 11,
#                        Scenario 16 parte HTTP).
#   970310            — sintética, teto pequeno (Scenario 10).
#   970320            — sintética, NUNCA recebe linha de habilitação até o
#                        passo 4 do Scenario 12 (empresa não habilitada).
#   970330            — sintética, RLS cross-empresa (Scenario 17).
#   970340            — sintética, retroatividade (Scenario 13).
#   970350            — sintética, convivência dos 2 gatilhos (Scenario 14).
# Nenhuma tem FK física em Entregador.id_empresa (confirmado via \d).
#
# ISOLAMENTO/LIMPEZA: id_externo sintético usa o prefixo UUID
# eeeeeeee-0000-0000-0000-* (distinto de dddddddd-... já usado pela suíte
# irmã). Cleanup via superuser em trap (roda mesmo em falha). O ambiente
# hub-homolog NUNCA é derrubado.
#
# Uso: infra/hub/testes/hub-enriquecimento-automatico-integration-homolog.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_HOMOLOG_ENV:-/var/lib/hub_secrets/.env.hub.homolog}"
COMPOSE="$HUB_DIR/compose.hub.homolog.yml"
PROJECT="hub-homolog"
TMP="$(mktemp -d)"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
HUB_DOMAIN="$(get_var HUB_DOMAIN "$ENV_FILE")"; HUB_HTTPS_PORT="$(get_var HUB_HTTPS_PORT "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
psql_val() { psql_t -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }
node_e() { dc exec -T backend node -e "$1" "${@:2}"; }

BASE="https://$HUB_DOMAIN:$HUB_HTTPS_PORT"
RESOLVE="$HUB_DOMAIN:$HUB_HTTPS_PORT:127.0.0.1"
shell_req() { # shell_req <method> <path> <cookiejar> [json-body] -> http_code; body em $TMP/body.json
  local method="$1" path="$2" jar="$3" body="${4:-}"
  if [ -n "$body" ]; then
    curl -sk --resolve "$RESOLVE" -X "$method" -c "$jar" -b "$jar" \
      -H 'Content-Type: application/json' -d "$body" \
      -o "$TMP/body.json" -w '%{http_code}' "$BASE$path"
  else
    curl -sk --resolve "$RESOLVE" -X "$method" -c "$jar" -b "$jar" \
      -o "$TMP/body.json" -w '%{http_code}' "$BASE$path"
  fi
}
jbody() { node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d['$1'] === undefined ? '' : d['$1']))" < "$TMP/body.json"; }

if [ "$(hostname)" != "VPSTodo" ]; then
  echo "ABORTADO: host inesperado '$(hostname)' (esperado VPSTodo)" >&2; exit 2
fi

EMPRESA_9001=9001
EMPRESA_TETO=970310
EMPRESA_SEM_HAB=970320
EMPRESA_RLS_B=970330
EMPRESA_RETRO=970340
EMPRESA_CONVIV=970350
UUID_PREFIX="eeeeeeee-0000-0000-0000-"
UUID_COUNTER_FILE="$TMP/uuid_counter"
echo 0 > "$UUID_COUNTER_FILE"
# next_uuid() é sempre chamada via `$(next_uuid)` (subshell) — um contador em
# variável bash comum NÃO sobrevive a isso (o incremento fica preso na
# subshell). Contador em arquivo persiste entre chamadas.
next_uuid() {
  local n
  n=$(($(cat "$UUID_COUNTER_FILE") + 1))
  echo "$n" > "$UUID_COUNTER_FILE"
  printf '%s%012d' "$UUID_PREFIX" "$n"
}
TS="$(date +%s)"

cleanup_rows() {
  echo
  echo "=== cleanup: removendo linhas sintéticas eeeeeeee-... + empresas 9703xx (superuser $DB_USER) ==="
  psql_t <<SQL >/dev/null
SET session_replication_role = replica;
DELETE FROM "Auditoria" WHERE recurso='Entregador' AND recurso_id IN (
  SELECT id::text FROM "Entregador" WHERE id_externo::text LIKE '$UUID_PREFIX%'
);
UPDATE "Entregador" SET motorista_id = NULL WHERE id_externo::text LIKE '$UUID_PREFIX%';
DELETE FROM "Entregador" WHERE id_externo::text LIKE '$UUID_PREFIX%';
DELETE FROM "ContaMotorista" WHERE cnpj_prestador LIKE '9${TS}%';
DELETE FROM "EnriquecimentoAutomatico" WHERE empresa_id IN
  ($EMPRESA_9001, $EMPRESA_TETO, $EMPRESA_SEM_HAB, $EMPRESA_RLS_B, $EMPRESA_RETRO, $EMPRESA_CONVIV);
SQL
  echo "=== cleanup: concluído ==="
  rm -rf "$TMP"
}
trap cleanup_rows EXIT

fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails+1)); fi; }
checkne() { if [ "$2" != "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (obtido='$2' NÃO deveria ser '$3')"; fails=$((fails+1)); fi; }
check2xx() { case "$2" in 2??) echo "PASS: $1";; *) echo "FAIL: $1 (status HTTP obtido='$2', esperado 2xx)"; fails=$((fails+1));; esac; }

# ── Helpers de importação direta via PostgREST (claim origem_importacao) ───
# importar <empresa> <id_externo1> [id_externo2...] -> imprime status HTTP
importar() {
  local empresa="$1"; shift
  local ids_json
  ids_json="$(printf '%s\n' "$@" | node_e "
const rl=require('fs').readFileSync(0,'utf8').split('\n').filter(Boolean);
process.stdout.write(JSON.stringify(rl.map((id)=>({id_empresa: $empresa, id_externo: id, nome: 'E2E-ENRIQ '+id.slice(-6)}))));
")"
  node_e "
const { generateHubPostgrestJWT } = require('./lib/hub-postgrest-jwt');
async function main(){
  const jwt = generateHubPostgrestJWT({ usuarioId: 1, empresaAtiva: $empresa, escopo: [$empresa], origemImportacao: true });
  const r = await fetch(process.env.POSTGREST_URL + '/Entregador?on_conflict=id_empresa,id_externo', {
    method: 'POST',
    headers: { Authorization: 'Bearer '+jwt, 'Content-Type': 'application/json', Prefer: 'return=representation,resolution=merge-duplicates' },
    body: process.argv[1],
  });
  const txt = await r.text();
  console.log('___STATUS___' + r.status);
  if (r.status >= 300) console.log('___ERRBODY___' + txt);
}
main().catch((e)=>{console.error('SCRIPT_ERROR', e); process.exit(1);});
" "$ids_json" | tee "$TMP/last-importar.log" | grep '___STATUS___' | sed 's/___STATUS___//'
}

# rls_select <escopo_empresa> -> imprime array JSON das linhas visíveis de EnriquecimentoAutomatico
rls_select() {
  local escopo="$1"
  node_e "
const { generateHubPostgrestJWT } = require('./lib/hub-postgrest-jwt');
async function main(){
  const jwt = generateHubPostgrestJWT({ usuarioId: 1, empresaAtiva: $escopo, escopo: [$escopo] });
  const r = await fetch(process.env.POSTGREST_URL + '/EnriquecimentoAutomatico?select=empresa_id', {
    headers: { Authorization: 'Bearer '+jwt },
  });
  const rows = await r.json().catch(()=>[]);
  console.log('___STATUS___'+r.status);
  console.log('___ROWS___'+JSON.stringify(rows.map((x)=>x.empresa_id)));
}
main().catch((e)=>{console.error('SCRIPT_ERROR', e); process.exit(1);});
"
}

# pgrest_write_denied <method> -> imprime status HTTP de um INSERT/UPDATE sem grant
pgrest_write_denied() {
  local method="$1"
  node_e "
const { generateHubPostgrestJWT } = require('./lib/hub-postgrest-jwt');
async function main(){
  const jwt = generateHubPostgrestJWT({ usuarioId: 1, empresaAtiva: $EMPRESA_TETO, escopo: [$EMPRESA_TETO] });
  const opts = { method: '$method', headers: { Authorization: 'Bearer '+jwt, 'Content-Type': 'application/json', Prefer: 'return=representation' } };
  if ('$method' === 'POST') {
    opts.body = JSON.stringify([{ empresa_id: 999999, ativo: true, teto: 1 }]);
    var url = process.env.POSTGREST_URL + '/EnriquecimentoAutomatico';
  } else {
    opts.body = JSON.stringify({ teto: 1 });
    var url = process.env.POSTGREST_URL + '/EnriquecimentoAutomatico?empresa_id=eq.$EMPRESA_TETO';
  }
  const r = await fetch(url, opts);
  console.log('___STATUS___'+r.status);
}
main().catch((e)=>{console.error('SCRIPT_ERROR', e); process.exit(1);});
" | grep '___STATUS___' | sed 's/___STATUS___//'
}

echo "### Setup — habilitação por empresa ###"
psql_t -c "INSERT INTO \"EnriquecimentoAutomatico\" (empresa_id, ativo, teto, desde) VALUES ($EMPRESA_9001, true, 1000, now() - interval '2 days');" >/dev/null
psql_t -c "INSERT INTO \"EnriquecimentoAutomatico\" (empresa_id, ativo, teto, desde) VALUES ($EMPRESA_TETO, true, 3, now() - interval '1 hour');" >/dev/null
psql_t -c "INSERT INTO \"EnriquecimentoAutomatico\" (empresa_id, ativo, teto, desde) VALUES ($EMPRESA_RLS_B, true, 100, now() - interval '1 hour');" >/dev/null
psql_t -c "INSERT INTO \"EnriquecimentoAutomatico\" (empresa_id, ativo, teto, desde) VALUES ($EMPRESA_CONVIV, true, 100, now() - interval '1 hour');" >/dev/null
echo "(EMPRESA_SEM_HAB=$EMPRESA_SEM_HAB e EMPRESA_RETRO=$EMPRESA_RETRO deliberadamente SEM linha por enquanto)"

# =============================================================================
echo; echo "### Scenario 10 (task 5.1) — teto segura a importação grande, excedente não se perde ###"
# =============================================================================
U10_1="$(next_uuid)"; U10_2="$(next_uuid)"; U10_3="$(next_uuid)"; U10_4="$(next_uuid)"
U10_5="$(next_uuid)"; U10_6="$(next_uuid)"; U10_7="$(next_uuid)"
LOTE10=("$U10_1" "$U10_2" "$U10_3" "$U10_4" "$U10_5" "$U10_6" "$U10_7")

st="$(importar "$EMPRESA_TETO" "${LOTE10[@]}")"
check2xx "5.1.1: 1ª importação do lote de 7 (teto=3) não falha (sem 500)" "$st"
pend="$(psql_val "SELECT count(*) FROM \"Entregador\" WHERE id_empresa=$EMPRESA_TETO AND dados_entrego_solicitado_em IS NOT NULL;")"
check "5.1.1: exatamente 3 de 7 ficam pendentes (teto corta dentro do lote)" "$pend" "3"

st="$(importar "$EMPRESA_TETO" "${LOTE10[@]}")"
check2xx "5.1.2: reimportar o mesmo lote não falha" "$st"
pend="$(psql_val "SELECT count(*) FROM \"Entregador\" WHERE id_empresa=$EMPRESA_TETO AND dados_entrego_solicitado_em IS NOT NULL;")"
check "5.1.2: reimportação NÃO aumenta a fila (teto cheio segura)" "$pend" "3"

# drena os 3 pendentes (sem claim de importação -> gatilho não reage)
psql_t -c "UPDATE \"Entregador\" SET dados_entrego_solicitado_em = NULL, dados_entrego_desfecho = 'outra-falha' WHERE id_empresa=$EMPRESA_TETO AND dados_entrego_solicitado_em IS NOT NULL;" >/dev/null
st="$(importar "$EMPRESA_TETO" "${LOTE10[@]}")"
pend="$(psql_val "SELECT count(*) FROM \"Entregador\" WHERE id_empresa=$EMPRESA_TETO AND dados_entrego_solicitado_em IS NOT NULL;")"
check "5.1.2: excedente entra na importação seguinte (mais 3 dos que sobraram)" "$pend" "3"

# drena de novo e reimporta uma 4ª vez -> o único restante (7 - 3 - 3 = 1) deve entrar agora
psql_t -c "UPDATE \"Entregador\" SET dados_entrego_solicitado_em = NULL, dados_entrego_desfecho = 'outra-falha' WHERE id_empresa=$EMPRESA_TETO AND dados_entrego_solicitado_em IS NOT NULL;" >/dev/null
st="$(importar "$EMPRESA_TETO" "${LOTE10[@]}")"
pend="$(psql_val "SELECT count(*) FROM \"Entregador\" WHERE id_empresa=$EMPRESA_TETO AND dados_entrego_solicitado_em IS NOT NULL;")"
check "5.1.3 (SC-001): última leva entra (o 7º e último nunca-tentado é alcançado)" "$pend" "1"
tocados="$(psql_val "SELECT count(*) FROM \"Entregador\" WHERE id_empresa=$EMPRESA_TETO AND id_externo::text LIKE '$UUID_PREFIX%' AND (dados_entrego_desfecho <> 'nunca-tentado' OR dados_entrego_solicitado_em IS NOT NULL);")"
check "5.1.3 (SC-001): soma de enfileirados ao longo de múltiplas importações chega a 100% (7 de 7)" "$tocados" "7"

# =============================================================================
echo; echo "### Scenario 12 (task 5.3.1/5.3.3) — empresa não habilitada não enfileira nada ###"
# =============================================================================
U12_1="$(next_uuid)"; U12_2="$(next_uuid)"; U12_3="$(next_uuid)"
st="$(importar "$EMPRESA_SEM_HAB" "$U12_1" "$U12_2" "$U12_3")"
check2xx "5.3.1: importar para empresa sem linha de habilitação não falha" "$st"
criados="$(psql_val "SELECT count(*) FROM \"Entregador\" WHERE id_empresa=$EMPRESA_SEM_HAB AND id_externo::text LIKE '$UUID_PREFIX%';")"
check "5.3.1: as 3 linhas são criadas normalmente" "$criados" "3"
pend="$(psql_val "SELECT count(*) FROM \"Entregador\" WHERE id_empresa=$EMPRESA_SEM_HAB AND dados_entrego_solicitado_em IS NOT NULL;")"
check "5.3.1/SC-007: 0 enfileirados (fila permanece vazia sem habilitação)" "$pend" "0"

# liga a empresa agora e reimporta a MESMA planilha (ramo DO UPDATE) — os 3
# já existiam ANTES de `desde`, então continuam fora (é o Scenario 13 já
# antecipado pelo próprio quickstart, passo 4).
psql_t -c "INSERT INTO \"EnriquecimentoAutomatico\" (empresa_id, ativo, teto, desde) VALUES ($EMPRESA_SEM_HAB, true, 100, now());" >/dev/null
sleep 1
st="$(importar "$EMPRESA_SEM_HAB" "$U12_1" "$U12_2" "$U12_3")"
pend="$(psql_val "SELECT count(*) FROM \"Entregador\" WHERE id_empresa=$EMPRESA_SEM_HAB AND dados_entrego_solicitado_em IS NOT NULL;")"
check "12.4: reimportar planilha antiga após ligar NÃO enfileira (criado_em < desde)" "$pend" "0"

U12_4="$(next_uuid)"
st="$(importar "$EMPRESA_SEM_HAB" "$U12_4")"
pend="$(psql_val "SELECT count(*) FROM \"Entregador\" WHERE id_empresa=$EMPRESA_SEM_HAB AND dados_entrego_solicitado_em IS NOT NULL;")"
check "12.4: id_externo NOVO após ligar a empresa AGORA enfileira" "$pend" "1"

psql_t -c "UPDATE \"EnriquecimentoAutomatico\" SET ativo=false, atualizado_em=now() WHERE empresa_id=$EMPRESA_SEM_HAB;" >/dev/null
U12_5="$(next_uuid)"
st="$(importar "$EMPRESA_SEM_HAB" "$U12_5")"
pend="$(psql_val "SELECT count(*) FROM \"Entregador\" WHERE id_empresa=$EMPRESA_SEM_HAB AND dados_entrego_solicitado_em IS NOT NULL;")"
check "12.5: desligar de novo — nova importação com id_externo novo volta a NÃO enfileirar (reversão sem deploy)" "$pend" "1"

# =============================================================================
echo; echo "### Scenario 13 (task 5.4) — retroatividade continua fora (recorte 'desde') ###"
# =============================================================================
U13_1="$(next_uuid)"
st="$(importar "$EMPRESA_RETRO" "$U13_1")"
check2xx "5.4: criação do entregador (sem habilitação ainda) não falha" "$st"
criado_em_antes="$(psql_val "SELECT criado_em FROM \"Entregador\" WHERE id_externo='$U13_1';")"
[ -n "$criado_em_antes" ] || { echo "FAIL: criado_em vazio para $U13_1"; fails=$((fails+1)); }
sleep 1
psql_t -c "INSERT INTO \"EnriquecimentoAutomatico\" (empresa_id, ativo, teto, desde) VALUES ($EMPRESA_RETRO, true, 100, now());" >/dev/null
sleep 1
st="$(importar "$EMPRESA_RETRO" "$U13_1")"
sol_em="$(psql_val "SELECT dados_entrego_solicitado_em FROM \"Entregador\" WHERE id_externo='$U13_1';")"
check "5.4.1: entregador com criado_em anterior a 'desde' NÃO é enfileirado, mesmo reimportado" "${sol_em:-VAZIO}" "VAZIO"
criado_em_depois="$(psql_val "SELECT criado_em FROM \"Entregador\" WHERE id_externo='$U13_1';")"
check "5.4.2: criado_em não muda com a reimportação (ramo UPDATE não contorna o recorte)" "$criado_em_depois" "$criado_em_antes"

# =============================================================================
echo; echo "### Scenario 14 (task 5.5.1) — convivência de trg_entregador_protege_nome + trg_entregador_enfileira_import ###"
# =============================================================================
U14_1="$(next_uuid)"
st="$(importar "$EMPRESA_CONVIV" "$U14_1")"
sol_em_14="$(psql_val "SELECT dados_entrego_solicitado_em FROM \"Entregador\" WHERE id_externo='$U14_1';")"
[ -n "$sol_em_14" ] || { echo "FAIL: 5.5.1 setup — $U14_1 deveria ter enfileirado"; fails=$((fails+1)); }
psql_t -c "UPDATE \"Entregador\" SET nome='Nome Editado Manualmente', nome_editado_manualmente=true WHERE id_externo='$U14_1';" >/dev/null
st="$(importar "$EMPRESA_CONVIV" "$U14_1")"
nome_apos="$(psql_val "SELECT nome FROM \"Entregador\" WHERE id_externo='$U14_1';")"
check "5.5.1: nome editado manualmente PERMANECE protegido na reimportação (0025 intacto)" "$nome_apos" "NomeEditadoManualmente"  # psql_val despeja espaços (tr -d)
sol_em_14_apos="$(psql_val "SELECT dados_entrego_solicitado_em FROM \"Entregador\" WHERE id_externo='$U14_1';")"
check "5.5.1: estado de fila (0060) continua obedecendo suas próprias regras (não regride ao reimportar)" "$sol_em_14_apos" "$sol_em_14"

tgorder="$(psql_val "SELECT string_agg(tgname, ',' ORDER BY tgname) FROM pg_trigger WHERE tgrelid = '\"Entregador\"'::regclass AND NOT tgisinternal;")"
check "5.5.3: ordem alfabética dos 2 gatilhos BEFORE UPDATE (campos disjuntos, ordem indiferente)" "$tgorder" "trg_entregador_enfileira_import,trg_entregador_protege_nome"

# =============================================================================
echo; echo "### Scenario 17 (task 5.3.2) — RLS de EnriquecimentoAutomatico ###"
# =============================================================================
OUT_A="$(rls_select "$EMPRESA_TETO")"
STA="$(echo "$OUT_A" | grep '___STATUS___' | sed 's/___STATUS___//')"
ROWSA="$(echo "$OUT_A" | grep '___ROWS___' | sed 's/___ROWS___//')"
check "17: SELECT com escopo=[EMPRESA_TETO] -> 200" "$STA" "200"
check "17: SELECT com escopo=[EMPRESA_TETO] vê SÓ a própria linha" "$ROWSA" "[$EMPRESA_TETO]"

OUT_B="$(rls_select "$EMPRESA_RLS_B")"
ROWSB="$(echo "$OUT_B" | grep '___ROWS___' | sed 's/___ROWS___//')"
check "17: SELECT com escopo=[EMPRESA_RLS_B] vê SÓ a própria linha (nunca a de outra empresa)" "$ROWSB" "[$EMPRESA_RLS_B]"

# a política de SELECT não pode quebrar o gatilho (SECURITY INVOKER lê a
# mesma tabela sob a MESMA RLS) — nova importação em EMPRESA_RLS_B continua
# enfileirando normalmente.
U17_1="$(next_uuid)"
importar "$EMPRESA_RLS_B" "$U17_1" >/dev/null
pend17="$(psql_val "SELECT dados_entrego_solicitado_em IS NOT NULL FROM \"Entregador\" WHERE id_externo='$U17_1';")"
check "17.3: importação de A continua enfileirando normalmente com a RLS de SELECT ativa" "$pend17" "t"

stins="$(pgrest_write_denied POST)"
check "17.4: INSERT em EnriquecimentoAutomatico via PostgREST (JWT authenticated comum) -> negado" "$stins" "403"
stupd="$(pgrest_write_denied PATCH)"
check "17.4: UPDATE em EnriquecimentoAutomatico via PostgREST (JWT authenticated comum) -> negado" "$stupd" "403"

# =============================================================================
echo; echo "### Login QA (empresa 9001) — necessário para Scenario 11 e 16 (código de rota) ###"
# =============================================================================
JAR_ADMIN="$TMP/admin.jar"; JAR_ROBO="$TMP/robo.jar"
st=$(shell_req POST /api/v1/auth/login "$JAR_ADMIN" '{"email":"qa.importacoes@moveelog.local","senha":"Teste@Hub2026"}')
check "login admin_entidade -> 200" "$st" "200"
st=$(shell_req POST /api/v1/me/entidade "$JAR_ADMIN" "{\"empresa_id\":$EMPRESA_9001}")
check "POST /me/entidade (admin, 9001) -> 200" "$st" "200"
st=$(shell_req POST /api/v1/auth/login "$JAR_ROBO" '{"email":"robo-entrego-test@moveelog.local","senha":"Teste@Hub2026"}')
check "login robo_entrego_servico -> 200" "$st" "200"
st=$(shell_req POST /api/v1/me/entidade "$JAR_ROBO" "{\"empresa_id\":$EMPRESA_9001}")
check "POST /me/entidade (robo, 9001) -> 200" "$st" "200"

# =============================================================================
echo; echo "### Scenario 11 (task 5.2) — pedido manual fura a fila (código da rota, imagem rebuildada) ###"
# =============================================================================
U11_MANUAL="$(next_uuid)"
st="$(importar "$EMPRESA_9001" "$U11_MANUAL")"
# consumido antes de habilitar 5 automáticos: "já existia e não estava na fila"
psql_t -c "UPDATE \"Entregador\" SET dados_entrego_solicitado_em=NULL, dados_entrego_desfecho='outra-falha' WHERE id_externo='$U11_MANUAL';" >/dev/null
ENT_MANUAL_ID="$(psql_val "SELECT id FROM \"Entregador\" WHERE id_externo='$U11_MANUAL';")"
[ -n "$ENT_MANUAL_ID" ] || { echo "FAIL: ENT_MANUAL_ID vazio"; fails=$((fails+1)); }

U11_A1="$(next_uuid)"; U11_A2="$(next_uuid)"; U11_A3="$(next_uuid)"; U11_A4="$(next_uuid)"; U11_A5="$(next_uuid)"
st="$(importar "$EMPRESA_9001" "$U11_A1" "$U11_A2" "$U11_A3" "$U11_A4" "$U11_A5")"
check2xx "5.2: importação dos 5 automáticos não falha" "$st"
autom_manual_flag="$(psql_val "SELECT count(*) FROM \"Entregador\" WHERE id_externo IN ('$U11_A1','$U11_A2','$U11_A3','$U11_A4','$U11_A5') AND dados_entrego_solicitado_manual=false AND dados_entrego_solicitado_em IS NOT NULL;")"
check "5.2: os 5 automáticos têm dados_entrego_solicitado_manual=false" "$autom_manual_flag" "5"

st=$(shell_req POST "/api/v1/motoristas/$ENT_MANUAL_ID/entrego-enriquecimento" "$JAR_ADMIN")
check "5.2.1: POST manual /entrego-enriquecimento -> 202" "$st" "202"
manual_flag="$(psql_val "SELECT dados_entrego_solicitado_manual FROM \"Entregador\" WHERE id=$ENT_MANUAL_ID;")"
check "5.2.1: dados_entrego_solicitado_manual gravado true pela rota POST manual" "$manual_flag" "t"

st=$(shell_req GET "/api/v1/robo-entrego/motoristas-para-enriquecer?modo=sob-demanda" "$JAR_ROBO")
check "5.2.1: GET fila sob-demanda -> 200" "$st" "200"
primeiro_id="$(node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String((d.items&&d.items[0]&&d.items[0].id)||''))" < "$TMP/body.json")"
check "5.2.1/5.2.2: o PRIMEIRO item da fila é o pedido MANUAL (fura a fila apesar de ser o último a entrar)" "$primeiro_id" "$ENT_MANUAL_ID"

autom_ainda_pendentes="$(psql_val "SELECT count(*) FROM \"Entregador\" WHERE id_externo IN ('$U11_A1','$U11_A2','$U11_A3','$U11_A4','$U11_A5') AND dados_entrego_solicitado_em IS NOT NULL;")"
check "5.2.3: os 5 automáticos anteriores NÃO são descartados, só adiados (continuam na fila)" "$autom_ainda_pendentes" "5"

st=$(shell_req PATCH "/api/v1/robo-entrego/motoristas/$ENT_MANUAL_ID/entrego-enriquecimento" "$JAR_ROBO" '{"sucesso":true,"dados":{"dadosPessoais":{"nomeCompleto":"E2E-ENRIQ Manual"}},"modo":"sob-demanda"}')
check "5.2: PATCH de fechamento (sucesso:true) do pedido manual -> 200" "$st" "200"
manual_flag_apos="$(psql_val "SELECT dados_entrego_solicitado_manual, dados_entrego_solicitado_em IS NULL FROM \"Entregador\" WHERE id=$ENT_MANUAL_ID;")"
check "quickstart Scenario 11 passo 7: manual volta a false + solicitado_em NULL no MESMO PATCH" "$manual_flag_apos" "f|t"  # psql -A usa | como separador de campo

# =============================================================================
echo; echo "### Scenario 16 (task 5.5.2) — regressão: só a importação alcança o gatilho ###"
# =============================================================================
U16_1="$(next_uuid)"
st="$(importar "$EMPRESA_9001" "$U16_1")"
ENT16_ID="$(psql_val "SELECT id FROM \"Entregador\" WHERE id_externo='$U16_1';")"
sol_em_16_setup="$(psql_val "SELECT dados_entrego_solicitado_em IS NOT NULL FROM \"Entregador\" WHERE id=$ENT16_ID;")"
[ "$sol_em_16_setup" = "t" ] || { echo "FAIL: 5.5.2 setup — $U16_1 deveria ter enfileirado ao criar"; fails=$((fails+1)); }
# volta ao estado "criado após desde, nunca-tentado, fora da fila" (mesma
# técnica não-importadora usada no Scenario 10 para "consumo").
psql_t -c "UPDATE \"Entregador\" SET dados_entrego_solicitado_em=NULL WHERE id=$ENT16_ID;" >/dev/null

st=$(shell_req PATCH "/api/v1/motoristas/$ENT16_ID" "$JAR_ADMIN" '{"nome":"E2E-ENRIQ Regressao Editado"}')
check "16.2a: PATCH /motoristas/:id (edição comum) -> 200" "$st" "200"
sol_a="$(psql_val "SELECT dados_entrego_solicitado_em IS NULL FROM \"Entregador\" WHERE id=$ENT16_ID;")"
check "16.2a: PATCH /motoristas/:id NÃO enfileira (sem claim origem_importacao)" "$sol_a" "t"

st=$(shell_req PATCH "/api/v1/robo-entrego/motoristas/$ENT16_ID/entrego-enriquecimento" "$JAR_ROBO" '{"sucesso":false,"motivoFalha":"TesteRegressaoScenario16","modo":"sob-demanda"}')
check "16.2b: PATCH robo .../entrego-enriquecimento (sucesso:false) -> 200" "$st" "200"
sol_b="$(psql_val "SELECT dados_entrego_solicitado_em IS NULL FROM \"Entregador\" WHERE id=$ENT16_ID;")"
check "16.2b: PATCH do robô fechando tentativa NÃO enfileira (sem claim origem_importacao)" "$sol_b" "t"

psql_t -c "INSERT INTO \"ContaMotorista\" (cnpj_prestador, nome, ativo) VALUES ('9${TS}999', 'E2E-ENRIQ Conta Vinculo', true);" >/dev/null
CONTA16_ID="$(psql_val "SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='9${TS}999';")"
st=$(shell_req POST "/api/v1/motoristas/$ENT16_ID/vinculo" "$JAR_ADMIN" "{\"contaMotoristaId\":$CONTA16_ID}")
check "16.2c: POST /motoristas/:id/vinculo -> 200" "$st" "200"
sol_c="$(psql_val "SELECT dados_entrego_solicitado_em IS NULL FROM \"Entregador\" WHERE id=$ENT16_ID;")"
check "16.2c: POST vínculo NÃO enfileira (sem claim origem_importacao)" "$sol_c" "t"

n_produtores="$(grep -rln 'origemImportacao:[[:space:]]*true' "$HUB_DIR/../../app_homologacao/backend" --include='*.js' 2>/dev/null | grep -v '/tests/' | wc -l | tr -d '[:space:]')"
check "16.4: grep -rn origemImportacao -> um único PRODUTOR (lib/hub-import-processor.js)" "$n_produtores" "1"

echo
echo "=========================================="
if [ "$fails" -eq 0 ]; then
  echo "HUB-ENRIQUECIMENTO-AUTOMATICO-INTEGRATION-HOMOLOG: OK (0 falhas)"
else
  echo "HUB-ENRIQUECIMENTO-AUTOMATICO-INTEGRATION-HOMOLOG: FALHOU ($fails falhas)"
fi
echo "=========================================="
exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"

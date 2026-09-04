#!/usr/bin/env bash
# =============================================================================
# hub-motorista-360-integration-homolog.sh — FASE 8 (tasks.md 8.1) da feature
# hub-motorista-360: integração REAL, SEM MOCK, contra o ambiente hub-homolog
# ISOLADO E PERSISTENTE (mesmo padrão de
# infra/hub/testes/hub-motorista-canonico-e2e-homolog.sh — script novo, não
# reaproveita/edita os existentes). Cobre quickstart.md Scenarios 1, 2, 4, 5
# (parcial — ver nota abaixo), 6, 7.
#
# NÃO sobe stack nova (pedido explícito da onda) — usa o hub-homolog que já
# está no ar (docker compose -p hub-homolog).
#
# Login via 3 contas QA reais já provisionadas (empresa_id=9001):
#   - qa.importacoes@moveelog.local        (admin_entidade — motoristas.editar,
#     motoristas.consultar, motoristas.dados_sensiveis)
#   - qa.motoristas.leitura@moveelog.local (leitura — motoristas.consultar,
#     SEM motoristas.dados_sensiveis)
#   - robo-entrego-test@moveelog.local     (robo_entrego_servico —
#     motoristas.enriquecimento.consultar/.atualizar)
# Senha de todas: Teste@Hub2026 (mesma convenção documentada na memória do
# projeto "acesso teste hub-homolog"; as 2 últimas foram RESETADAS para essa
# senha nesta sessão — não havia registro de senha conhecida — via UPDATE
# direto em "Usuario".senha_hash, ambiente de teste isolado, reversível).
#
# NOTA — Scenario 5 (409 SEM_IDENTIFICADOR_ENTREGO) é coberto APENAS pelo
# unit test existente (tests/hub-motoristas-entrego-enriquecimento-unit.test.js),
# nunca por este script: "Entregador".id_externo é `uuid NOT NULL` desde a
# migration 0010 (nunca alterada) — o estado "sem identificador" que o branch
# 409 do handler verifica é estruturalmente IRREPRODUZÍVEL contra o schema
# real. Este script PROVA isso empiricamente (tentativa de INSERT com
# id_externo NULL, abaixo) em vez de simplesmente pular o caso.
#
# Scenario 3 (backfill) NÃO é reexecutado aqui: já tem ~10 testes unit
# (tests/hub-motorista-vinculo-automatico.test.js, describe "processarBackfill")
# cobrindo relatório/idempotência/resiliência via a MESMA função
# `vincularAutomaticamente` que os Scenarios 1/2 deste script exercitam contra
# DB real — rodar o script de backfill de verdade aqui processaria TODOS os
# "Motorista" com senha setada em hub_homolog_db (ambiente compartilhado por
# outras suítes), risco de efeito colateral fora do escopo desta onda.
#
# ISOLAMENTO/LIMPEZA: dados sintéticos usam nome com prefixo "E2E360 " e
# uuid na faixa reservada dddddddd-0000-0000-0000-* (distinta das faixas já
# usadas por outros scripts). Cleanup via superuser (owner bypassa RLS), em
# trap (roda mesmo em falha). O ambiente hub-homolog NUNCA é derrubado.
#
# Uso: infra/hub/testes/hub-motorista-360-integration-homolog.sh
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
shell_req() { # shell_req <method> <path> <cookiejar> [json-body]  -> imprime http_code, body em $TMP/body.json
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
jhas() { node_e "
function get(o,p){return p.split('.').reduce((a,k)=>(a&&typeof a==='object')?a[k]:undefined,o);}
const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
const path='$1'.split('.');
let cur=d, ok=true;
for (let i=0;i<path.length-1;i++){ if(cur && typeof cur==='object' && Object.prototype.hasOwnProperty.call(cur,path[i])){cur=cur[path[i]];} else {ok=false;break;} }
const last=path[path.length-1];
process.stdout.write(String(ok && cur && typeof cur==='object' && Object.prototype.hasOwnProperty.call(cur,last)));
" < "$TMP/body.json"; }

if [ "$(hostname)" != "VPSTodo" ]; then
  echo "ABORTADO: host inesperado '$(hostname)' (esperado VPSTodo)" >&2; exit 2
fi

EMPRESA=9001
UUID_PREFIX="dddddddd-0000-0000-0000-00000000000"
UUID_V1="${UUID_PREFIX}1"
UUID_V2A="${UUID_PREFIX}2"
UUID_V2B="${UUID_PREFIX}3"
UUID_ENRIQ="${UUID_PREFIX}4"
NOME_PREFIX="E2E360"
TS="$(date +%s)"
CNPJ1="$(printf '%014d' "$TS")"
CNPJ2="$(printf '%014d' "$((TS + 1))")"
NOME1="$NOME_PREFIX Fulano De Tal Um"
NOME2="$NOME_PREFIX Beltrano De Souza Dois"

cleanup_rows() {
  echo
  echo "=== cleanup: removendo linhas sintéticas E2E360 (superuser $DB_USER, owner bypassa RLS) ==="
  psql_t <<SQL >/dev/null
SET session_replication_role = replica;
DELETE FROM "Auditoria" WHERE recurso='Entregador' AND recurso_id IN (
  SELECT id::text FROM "Entregador" WHERE id_empresa = $EMPRESA AND id_externo::text LIKE '$UUID_PREFIX%'
);
UPDATE "Entregador" SET motorista_id = NULL WHERE id_empresa = $EMPRESA AND id_externo::text LIKE '$UUID_PREFIX%';
DELETE FROM "Entregador" WHERE id_empresa = $EMPRESA AND id_externo::text LIKE '$UUID_PREFIX%';
DELETE FROM "ContaMotorista" WHERE cnpj_prestador IN ('$CNPJ1', '$CNPJ2');
DELETE FROM "Motorista" WHERE cnpj_prestador IN ('$CNPJ1', '$CNPJ2');
SQL
  echo "=== cleanup: concluído ==="
  rm -rf "$TMP"
}
trap cleanup_rows EXIT

fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails+1)); fi; }
checkne() { if [ "$2" != "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (obtido='$2' NÃO deveria ser '$3')"; fails=$((fails+1)); fi; }

echo "### Login QA (empresa 9001) — admin_entidade / leitura / robo_entrego_servico ###"
JAR_ADMIN="$TMP/admin.jar"; JAR_LEITURA="$TMP/leitura.jar"; JAR_ROBO="$TMP/robo.jar"
st=$(shell_req POST /api/v1/auth/login "$JAR_ADMIN" '{"email":"qa.importacoes@moveelog.local","senha":"Teste@Hub2026"}')
check "login admin_entidade -> 200" "$st" "200"
st=$(shell_req POST /api/v1/me/entidade "$JAR_ADMIN" "{\"empresa_id\":$EMPRESA}")
check "POST /me/entidade (admin, 9001) -> 200" "$st" "200"

st=$(shell_req POST /api/v1/auth/login "$JAR_LEITURA" '{"email":"qa.motoristas.leitura@moveelog.local","senha":"Teste@Hub2026"}')
check "login leitura -> 200" "$st" "200"
st=$(shell_req POST /api/v1/me/entidade "$JAR_LEITURA" "{\"empresa_id\":$EMPRESA}")
check "POST /me/entidade (leitura, 9001) -> 200" "$st" "200"

st=$(shell_req POST /api/v1/auth/login "$JAR_ROBO" '{"email":"robo-entrego-test@moveelog.local","senha":"Teste@Hub2026"}')
check "login robo_entrego_servico -> 200" "$st" "200"
st=$(shell_req POST /api/v1/me/entidade "$JAR_ROBO" "{\"empresa_id\":$EMPRESA}")
check "POST /me/entidade (robo, 9001) -> 200" "$st" "200"

# ── Prova: Scenario 5 (409) é estruturalmente irreprodutível no schema real ──
echo
echo "### Prova de schema: Entregador.id_externo é NOT NULL (409 real é impossível) ###"
NULLABLE="$(psql_val "SELECT is_nullable FROM information_schema.columns WHERE table_name='Entregador' AND column_name='id_externo';")"
check "Entregador.id_externo is_nullable" "$NULLABLE" "NO"
psql_t -c "INSERT INTO \"Entregador\" (id_empresa, id_externo, nome) VALUES ($EMPRESA, NULL, '$NOME_PREFIX sem-id-externo');" >/dev/null 2>"$TMP/insert-null-err.txt"
INSERT_RC=$?
checkne "INSERT com id_externo NULL falha (constraint NOT NULL, prova que 409 real é dead-code)" "$INSERT_RC" "0"

# ── Scenario 1: vínculo automático — 1 candidato >= 0.9 ─────────────────────
echo
echo "### Scenario 1 — register ativa credencial + vínculo automático (candidato único) ###"
psql_t -c "INSERT INTO \"Entregador\" (id_empresa, id_externo, nome) VALUES ($EMPRESA, '$UUID_V1', '$NOME1');" >/dev/null
ENT1_ID="$(psql_val "SELECT id FROM \"Entregador\" WHERE id_externo='$UUID_V1';")"
[ -n "$ENT1_ID" ] || { echo "FAIL: ENT1_ID vazio"; fails=$((fails+1)); }
psql_t -c "INSERT INTO \"Motorista\" (cnpj_prestador, nome, senha, ativo) VALUES ('$CNPJ1', '$NOME1 (pré-cadastro)', NULL, true);" >/dev/null

REG1="$(node_e "
async function main(){
  const r = await fetch('http://localhost:3000/motorista/register', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({cnpjPrestador: process.argv[1], nome: process.argv[2], senha: 'SenhaSinteticaE2e360#1'})});
  console.log('___R___'+r.status);
}
main();
" "$CNPJ1" "$NOME1")"
check "POST /motorista/register (Scenario 1) -> 201" "$(printf '%s' "$REG1" | grep -o '___R___[0-9]*' | sed 's/___R___//')" "201"

MOTORISTA_ID_1="$(psql_val "SELECT id FROM \"Entregador\" WHERE id=$ENT1_ID AND motorista_id IS NOT NULL;")"
[ -n "$MOTORISTA_ID_1" ] || { echo "FAIL: Entregador $ENT1_ID NÃO recebeu motorista_id (vínculo automático falhou)"; fails=$((fails+1)); }
check "Entregador (Scenario 1) recebeu motorista_id sem ação do gestor" "$([ -n "$MOTORISTA_ID_1" ] && echo sim || echo nao)" "sim"
CONTA1_CNPJ="$(psql_val "SELECT cnpj_prestador FROM \"ContaMotorista\" c JOIN \"Entregador\" e ON e.motorista_id=c.id WHERE e.id=$ENT1_ID;")"
check "ContaMotorista vinculada tem o CNPJ do register" "$CONTA1_CNPJ" "$CNPJ1"

# ── Scenario 2: vínculo automático — 2 candidatos >= 0.9, NÃO vincula ───────
echo
echo "### Scenario 2 — register com 2 candidatos igualmente similares -> NÃO vincula ###"
psql_t -c "INSERT INTO \"Entregador\" (id_empresa, id_externo, nome) VALUES ($EMPRESA, '$UUID_V2A', '$NOME2');" >/dev/null
psql_t -c "INSERT INTO \"Entregador\" (id_empresa, id_externo, nome) VALUES ($EMPRESA, '$UUID_V2B', '$NOME2');" >/dev/null
ENT2A_ID="$(psql_val "SELECT id FROM \"Entregador\" WHERE id_externo='$UUID_V2A';")"
ENT2B_ID="$(psql_val "SELECT id FROM \"Entregador\" WHERE id_externo='$UUID_V2B';")"
psql_t -c "INSERT INTO \"Motorista\" (cnpj_prestador, nome, senha, ativo) VALUES ('$CNPJ2', '$NOME2 (pré-cadastro)', NULL, true);" >/dev/null

REG2="$(node_e "
async function main(){
  const r = await fetch('http://localhost:3000/motorista/register', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({cnpjPrestador: process.argv[1], nome: process.argv[2], senha: 'SenhaSinteticaE2e360#2'})});
  console.log('___R___'+r.status);
}
main();
" "$CNPJ2" "$NOME2")"
check "POST /motorista/register (Scenario 2) -> 201 (cadastro sempre funciona)" "$(printf '%s' "$REG2" | grep -o '___R___[0-9]*' | sed 's/___R___//')" "201"

AMBOS_NULL="$(psql_val "SELECT count(*) FROM \"Entregador\" WHERE id IN ($ENT2A_ID,$ENT2B_ID) AND motorista_id IS NULL;")"
check "ambos os candidatos ambíguos permanecem SEM vínculo (nunca vincula errado)" "$AMBOS_NULL" "2"
CONTA2_EXISTE="$(psql_val "SELECT count(*) FROM \"ContaMotorista\" WHERE cnpj_prestador='$CNPJ2';")"
check "ContaMotorista foi criada mesmo sem vínculo (credencial do app funciona)" "$CONTA2_EXISTE" "1"

# ── Scenario 4/7: RBAC de campo (leitura vs admin_entidade) ────────────────
echo
echo "### Scenario 4/7 — GET /motoristas/:id — máscara de campo por RBAC ###"
JSON_ENRIQ='{"dadosPessoais":{"nomeCompleto":"E2E360 Nome Completo Sintetico","dataNascimento":"1990-01-01","email":"sintetico360@example.invalid","cpf":"SINTETICO-CPF-000.000.000-00","nomeMae":"SINTETICO Mae","nomePai":"SINTETICO Pai","telefone":"+5511900000000"},"documentos":{"rg":"SINTETICO-RG-00.000.000-0","cnh":"SINTETICO-CNH-00000000000"},"contatoEmergencia":{"grauParentesco":"conjuge","nome":"SINTETICO Contato","telefone":"+5511900000001"},"informacoesEntrega":{"operadorLogistico":"SINTETICO Operador","modal":"moto"}}'
psql_t -c "UPDATE \"Entregador\" SET dados_entrego_json = '$JSON_ENRIQ'::jsonb, dados_entrego_enriquecidos_em = now() WHERE id=$ENT1_ID;" >/dev/null

st=$(shell_req GET "/api/v1/motoristas/$ENT1_ID" "$JAR_ADMIN")
check "GET /motoristas/:id (admin_entidade) -> 200" "$st" "200"
check "admin: cnpjPrestador presente" "$(jbody cnpjPrestador)" "$CNPJ1"
check "admin: vinculoCredencialAutomatico=true" "$(jbody vinculoCredencialAutomatico)" "true"
check "admin: has(entregoEnriquecimento.dadosPessoais)=true" "$(jhas entregoEnriquecimento.dadosPessoais)" "true"
check "admin: has(entregoEnriquecimento.contatoEmergencia)=true" "$(jhas entregoEnriquecimento.contatoEmergencia)" "true"
check "admin: has(entregoEnriquecimento.documentos.rg)=true" "$(jhas entregoEnriquecimento.documentos.rg)" "true"
check "admin: has(entregoEnriquecimento.dadosPessoaisBasicos)=true" "$(jhas entregoEnriquecimento.dadosPessoaisBasicos)" "true"

st=$(shell_req GET "/api/v1/motoristas/$ENT1_ID" "$JAR_LEITURA")
check "GET /motoristas/:id (leitura) -> 200" "$st" "200"
check "leitura: cnpjPrestador AINDA presente (não é sensível por FR-013)" "$(jbody cnpjPrestador)" "$CNPJ1"
check "leitura: has(entregoEnriquecimento.dadosPessoaisBasicos)=true (nunca sensível)" "$(jhas entregoEnriquecimento.dadosPessoaisBasicos)" "true"
check "leitura: has(entregoEnriquecimento.documentos.cnh)=true (nunca sensível)" "$(jhas entregoEnriquecimento.documentos.cnh)" "true"
check "leitura: has(entregoEnriquecimento.dadosPessoais)=false (CHAVE AUSENTE, não vazio/null)" "$(jhas entregoEnriquecimento.dadosPessoais)" "false"
check "leitura: has(entregoEnriquecimento.contatoEmergencia)=false (CHAVE AUSENTE)" "$(jhas entregoEnriquecimento.contatoEmergencia)" "false"
check "leitura: has(entregoEnriquecimento.documentos.rg)=false (CHAVE AUSENTE — RG sensível FR-013/FR-014)" "$(jhas entregoEnriquecimento.documentos.rg)" "false"

# ── Scenario 5 (parcial: 202/429 reais) + Scenario 6 (falha preserva dado) ──
echo
echo "### Scenario 5 (202/429) + Scenario 6 (falha não descarta enriquecimento anterior) ###"
psql_t -c "INSERT INTO \"Entregador\" (id_empresa, id_externo, nome) VALUES ($EMPRESA, '$UUID_ENRIQ', '$NOME_PREFIX Enriquecimento');" >/dev/null
ENT_ENRIQ_ID="$(psql_val "SELECT id FROM \"Entregador\" WHERE id_externo='$UUID_ENRIQ';")"

st=$(shell_req POST "/api/v1/motoristas/$ENT_ENRIQ_ID/entrego-enriquecimento" "$JAR_ADMIN")
check "POST entrego-enriquecimento (1º pedido) -> 202" "$st" "202"
check "202: status=pendente" "$(jbody status)" "pendente"
SOLICITADO_1="$(psql_val "SELECT dados_entrego_solicitado_em FROM \"Entregador\" WHERE id=$ENT_ENRIQ_ID;")"
[ -n "$SOLICITADO_1" ] || { echo "FAIL: dados_entrego_solicitado_em não gravado"; fails=$((fails+1)); }

st=$(shell_req POST "/api/v1/motoristas/$ENT_ENRIQ_ID/entrego-enriquecimento" "$JAR_ADMIN")
check "POST entrego-enriquecimento (2º pedido, ainda pendente) -> 429" "$st" "429"
check "429: erro=JA_PENDENTE" "$(jbody erro)" "JA_PENDENTE"

DADOS_SUCESSO='{"dadosPessoais":{"nomeCompleto":"E2E360 Enriquecido","dataNascimento":"1985-05-05","email":"sintetico360b@example.invalid","cpf":"SINTETICO-CPF-111.111.111-11","nomeMae":"SINTETICO Mae B","nomePai":"SINTETICO Pai B","telefone":"+5511900000002"},"documentos":{"rg":"SINTETICO-RG-11.111.111-1","cnh":"SINTETICO-CNH-11111111111"},"contatoEmergencia":{"grauParentesco":"pai","nome":"SINTETICO Contato B","telefone":"+5511900000003"},"informacoesEntrega":{"operadorLogistico":"SINTETICO Operador B","modal":"carro"}}'
st=$(shell_req PATCH "/api/v1/robo-entrego/motoristas/$ENT_ENRIQ_ID/entrego-enriquecimento" "$JAR_ROBO" "{\"sucesso\":true,\"dados\":$DADOS_SUCESSO,\"modo\":\"sob-demanda\"}")
check "PATCH .../entrego-enriquecimento (sucesso:true, worker) -> 200" "$st" "200"

ENRIQ_EM_1="$(psql_val "SELECT dados_entrego_enriquecidos_em FROM \"Entregador\" WHERE id=$ENT_ENRIQ_ID;")"
SOLICITADO_APOS_SUCESSO="$(psql_val "SELECT dados_entrego_solicitado_em FROM \"Entregador\" WHERE id=$ENT_ENRIQ_ID;")"
[ -n "$ENRIQ_EM_1" ] || { echo "FAIL: dados_entrego_enriquecidos_em não gravado após sucesso"; fails=$((fails+1)); }
check "solicitado_em limpo após sucesso do worker" "${SOLICITADO_APOS_SUCESSO:-VAZIO}" "VAZIO"

# 2º ciclo: novo pedido (agora aceito de novo, pois solicitado_em está null) + FALHA do worker
st=$(shell_req POST "/api/v1/motoristas/$ENT_ENRIQ_ID/entrego-enriquecimento" "$JAR_ADMIN")
check "POST entrego-enriquecimento (2º ciclo, após sucesso anterior) -> 202" "$st" "202"

st=$(shell_req PATCH "/api/v1/robo-entrego/motoristas/$ENT_ENRIQ_ID/entrego-enriquecimento" "$JAR_ROBO" '{"sucesso":false,"motivoFalha":"ErroAntibotSuspeito","modo":"sob-demanda"}')
check "PATCH .../entrego-enriquecimento (sucesso:false, worker falhou) -> 200" "$st" "200"

ENRIQ_EM_2="$(psql_val "SELECT dados_entrego_enriquecidos_em FROM \"Entregador\" WHERE id=$ENT_ENRIQ_ID;")"
SOLICITADO_APOS_FALHA="$(psql_val "SELECT dados_entrego_solicitado_em FROM \"Entregador\" WHERE id=$ENT_ENRIQ_ID;")"
CPF_APOS_FALHA="$(psql_val "SELECT dados_entrego_json->'dadosPessoais'->>'cpf' FROM \"Entregador\" WHERE id=$ENT_ENRIQ_ID;")"
check "FR-007: dados_entrego_enriquecidos_em INALTERADO após falha (dado antigo preservado)" "$ENRIQ_EM_2" "$ENRIQ_EM_1"
check "FR-007: dados_entrego_json INALTERADO após falha (cpf da busca anterior preservado)" "$CPF_APOS_FALHA" "SINTETICO-CPF-111.111.111-11"
check "solicitado_em limpo após falha (pedido não fica preso)" "${SOLICITADO_APOS_FALHA:-VAZIO}" "VAZIO"

echo
echo "=========================================="
if [ "$fails" -eq 0 ]; then
  echo "HUB-MOTORISTA-360-INTEGRATION-HOMOLOG: OK (0 falhas)"
else
  echo "HUB-MOTORISTA-360-INTEGRATION-HOMOLOG: FALHOU ($fails falhas)"
fi
echo "=========================================="
exit "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"

#!/usr/bin/env bash
# =============================================================================
# hub-motorista-canonico-e2e-homolog.sh — FASE 7 (tasks.md 7.1) da feature
# hub-motorista-canonico: E2E REAL, SEM MOCK, contra o ambiente hub-homolog
# ISOLADO E PERSISTENTE (mesmo padrão de infra/hub/testes/hub-e2e-homolog.sh
# e hub-shell-e2e-homolog.sh — script novo, não reaproveita/edita os
# existentes). Cobre os smokes deferidos das FASES 1-6 (1.4.3/1.4.4, 2.5.3/
# 2.5.4, 4.5.2, 5.6.2, 6.6.2) + quickstart.md Scenarios 1,2,3,5,6,7,8,9.
#
# Login via conta QA real (qa.importacoes@moveelog.local / Teste@Hub2026,
# empresa_id=9001, papel admin_entidade — memória do projeto
# acesso-teste-hub-homolog.md), NÃO uma conta sintética e2e-teste-* — pedido
# explícito da onda (evita seed de usuário/papel, já existe e já tem as
# permissões motoristas.editar/motoristas.credencial/motoristas.consultar/
# faturamento.consultar).
#
# Requisições passam pela URL HTTPS pública do hub (Traefik + proxy do
# Next `app/api/[...path]/route.ts`), exatamente como o browser faria —
# scenarios 1/2/3/5(parcial)/8 batem no shell. O login do APP MOTORISTA
# (routes/motorista.js POST /motorista/login, scenario 6) é uma rota
# LEGADA fora do prefixo /api/v1 e não passa pelo proxy do hub-shell — bate
# direto no backend (mesmo padrão de dc exec backend node usado pelos
# demais scripts desta pasta para chamadas fora do shell).
#
# ISOLAMENTO/LIMPEZA: dados sintéticos usam nome com prefixo
# "E2E FASE7 " e uuid na faixa reservada ffffffff-0000-0000-0000-*
# (distinta de qualquer faixa usada por outros scripts/seeds). Cleanup via
# superuser (owner bypassa RLS), em trap (roda mesmo em falha). O ambiente
# hub-homolog NUNCA é derrubado.
#
# Uso: infra/hub/testes/hub-motorista-canonico-e2e-homolog.sh
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
jbody_raw() { cat "$TMP/body.json"; }

if [ "$(hostname)" != "VPSTodo" ]; then
  echo "ABORTADO: host inesperado '$(hostname)' (esperado VPSTodo)" >&2; exit 2
fi

EMPRESA=9001
UUID_PREFIX="ffffffff-0000-0000-0000-00000000000"
NOME_PREFIX="E2E FASE7"
# CNPJ sintético com sufixo de timestamp: cada execução deste script bate
# várias vezes em POST /motorista/login (rota real, com rate-limit real —
# loginPerAccountLimiter, max=10 por (IP,CNPJ)/15min). Um CNPJ FIXO faria o
# contador se acumular entre reexecuções deste script dentro da mesma janela
# de 15min e produzir 429 falso-negativo — não é reproduzível de forma
# confiável com valor fixo.
# Exatamente 14 dígitos (formato CNPJ) — necessário para exercitar a
# variante MASCARADA de cnpjEnvioMassaFilter (só monta a máscara para
# entrada de 14 dígitos), usada no teste de correlação de atividades abaixo.
CNPJ_TESTE="$(printf '%014d' "$(date +%s)")"

cleanup_rows() {
  echo
  echo "=== cleanup: removendo linhas sintéticas E2E FASE7 (superuser $DB_USER, owner bypassa RLS) ==="
  psql_t <<SQL >/dev/null
SET session_replication_role = replica;
DELETE FROM "EnvioMassa" WHERE cnpj_prestador IN ('$CNPJ_TESTE', '$CNPJ_MASCARADO');
DELETE FROM "Auditoria" WHERE recurso='Entregador' AND recurso_id IN (
  SELECT id::text FROM "Entregador" WHERE id_empresa = $EMPRESA AND id_externo::text LIKE '$UUID_PREFIX%'
);
UPDATE "Entregador" SET motorista_id = NULL WHERE id_empresa = $EMPRESA AND id_externo::text LIKE '$UUID_PREFIX%';
DELETE FROM "ContaMotorista" WHERE cnpj_prestador = '$CNPJ_TESTE';
DELETE FROM "Entregador" WHERE id_empresa = $EMPRESA AND id_externo::text LIKE '$UUID_PREFIX%';
SQL
  echo "=== cleanup: concluído ==="
  rm -rf "$TMP"
}
trap cleanup_rows EXIT

fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails+1)); fi; }
checkne() { if [ "$2" != "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (obtido='$2' NÃO deveria ser '$3')"; fails=$((fails+1)); fi; }

echo "### Pré-condição: produção Swarm inalterada (Scenario 9, leitura apenas) ###"
PROD_ENV="$(docker service inspect envio-massa-homologacao_backend_homologacao --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}' 2>/dev/null | tr ',' '\n' | grep -iE 'hub_motorista|envio_dry_run|envio_allowlist|entregador_uuid' || true)"
check "Scenario 9: nenhuma env hub-motorista-canonico nos serviços Swarm de produção" "${PROD_ENV:-}" ""

echo
echo "### Login QA (empresa 9001, admin_entidade) -> me/entidade ###"
JAR="$TMP/qa.jar"
T0=$(date +%s)
st=$(shell_req POST /api/v1/auth/login "$JAR" '{"email":"qa.importacoes@moveelog.local","senha":"Teste@Hub2026"}')
check "login QA -> 200" "$st" "200"
st=$(shell_req POST /api/v1/me/entidade "$JAR" "{\"empresa_id\":$EMPRESA}")
check "POST /me/entidade (9001) -> 200" "$st" "200"

# ── Scenario 1 (WS-A): Painel Geral sem 404 ────────────────────────────────
echo
echo "### Scenario 1 — Painel Geral sem 404 ###"
st=$(shell_req GET /hub/dashboard "$JAR")
check "GET /hub/dashboard -> 200 (Painel Geral)" "$st" "200"

# ── Scenario 2 (WS-A): perfil em modal — rota direta também 200 ───────────
echo
echo "### Scenario 2 — /hub/dashboard/perfil direto na URL -> 200 ###"
st=$(shell_req GET /hub/dashboard/perfil "$JAR")
check "GET /hub/dashboard/perfil -> 200" "$st" "200"

# ── Scenario 3 (WS-B): combobox de entregador por nome ────────────────────
echo
echo "### Scenario 3 — GET /api/v1/faturamento/entregadores?busca= ###"
st=$(shell_req GET '/api/v1/faturamento/entregadores?busca=QA%20Motoristas' "$JAR")
check "GET /faturamento/entregadores?busca=QA Motoristas -> 200" "$st" "200"
N_ITEMS="$(node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(Array.isArray(d.items)?d.items.length:-1))" < "$TMP/body.json")"
checkne "busca por nome retorna items[] não-vazio" "$N_ITEMS" "0"
LE20=$(node_e "process.stdout.write(String(Number(process.argv[1])<=20 && Number(process.argv[1])>0))" "$N_ITEMS")
check "busca por nome respeita máx. 20 itens" "$LE20" "true"

st=$(shell_req GET '/api/v1/faturamento/entregadores?busca=QA' "$JAR")
check "busca com <3 letras -> 422 (busca_invalida, faltam caracteres)" "$st" "422"

st=$(shell_req GET '/api/v1/performance/entregadores?busca=QA%20Motoristas' "$JAR")
check "GET /performance/entregadores?busca=... -> 200 (mesma tela repetida — Scenario 3 passo 11)" "$st" "200"
N_ITEMS_PERF="$(node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(Array.isArray(d.items)?d.items.length:-1))" < "$TMP/body.json")"
checkne "busca por nome em Performance retorna items[] não-vazio" "$N_ITEMS_PERF" "0"

# ── Scenario 5 (WS-C): cadastro com uuid ───────────────────────────────────
echo
echo "### Scenario 5 — POST /api/v1/motoristas (uuid obrigatório) ###"
UUID1="${UUID_PREFIX}1"
T_SC5_START=$(date +%s)
st=$(shell_req POST /api/v1/motoristas "$JAR" "{\"nome\":\"$NOME_PREFIX Motorista 1\",\"idExterno\":\"$UUID1\"}")
check "POST /motoristas (uuid válido, novo) -> 201" "$st" "201"
MOTORISTA_ID="$(jbody id)"
[ -n "$MOTORISTA_ID" ] && [ "$MOTORISTA_ID" != "undefined" ] || { echo "FAIL: id do motorista criado ausente na resposta"; fails=$((fails+1)); }
check "resposta ecoa idExterno" "$(jbody idExterno)" "$UUID1"

st=$(shell_req POST /api/v1/motoristas "$JAR" "{\"nome\":\"$NOME_PREFIX Duplicado\",\"idExterno\":\"$UUID1\"}")
check "POST /motoristas (uuid duplicado) -> 409" "$st" "409"
check "409: erro=uuid_duplicado" "$(jbody erro)" "uuid_duplicado"

st=$(shell_req POST /api/v1/motoristas "$JAR" "{\"nome\":\"$NOME_PREFIX Formato Invalido\",\"idExterno\":\"nao-e-um-uuid\"}")
check "POST /motoristas (uuid formato inválido) -> 422" "$st" "422"
check "422 (formato): erro=uuid_invalido" "$(jbody erro)" "uuid_invalido"

st=$(shell_req POST /api/v1/motoristas "$JAR" "{\"nome\":\"$NOME_PREFIX Sem Uuid\"}")
check "POST /motoristas (sem uuid) -> 422 (sempre obrigatório)" "$st" "422"

# ── Scenario 6 (WS-C): credencial de acesso ────────────────────────────────
echo
echo "### Scenario 6 — credencial: criar / login app motorista / reset / desativar ###"
st=$(shell_req POST "/api/v1/motoristas/$MOTORISTA_ID/credencial" "$JAR" "{\"cnpjPrestador\":\"$CNPJ_TESTE\"}")
check "POST /motoristas/:id/credencial (novo) -> 201" "$st" "201"
SENHA_TEMP="$(jbody senhaTemporaria)"
[ -n "$SENHA_TEMP" ] && [ "$SENHA_TEMP" != "undefined" ] || { echo "FAIL: senhaTemporaria ausente na resposta de criação"; fails=$((fails+1)); }

# login do APP MOTORISTA via ContaMotorista (rota legada /motorista/login,
# fora do prefixo /api/v1 — direto no backend, gate
# HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true já ativo neste container).
LOGIN_APP="$(node_e "
async function main(){
  const r = await fetch('http://localhost:3000/motorista/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({cnpjPrestador: process.argv[1], senha: process.argv[2]})});
  const b = await r.json().catch(()=>({}));
  console.log('___R___'+JSON.stringify({status:r.status, cnpjPrestador:b.cnpjPrestador||null, error:b.error||null}));
}
main();
" "$CNPJ_TESTE" "$SENHA_TEMP")"
LOGIN_APP_JSON="$(printf '%s' "$LOGIN_APP" | grep '___R___' | sed 's/^___R___//')"
check "login app motorista com credencial recém-criada -> 200" "$(printf '%s' "$LOGIN_APP_JSON" | node_e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(0,'utf8')).status))")" "200"

st=$(shell_req POST "/api/v1/motoristas/$MOTORISTA_ID/credencial/reset-senha" "$JAR")
check "POST /motoristas/:id/credencial/reset-senha -> 200" "$st" "200"
TOKEN_RESET="$(jbody tokenDefinicao)"
[ -n "$TOKEN_RESET" ] && [ "$TOKEN_RESET" != "undefined" ] || { echo "FAIL: tokenDefinicao ausente na resposta de reset-senha"; fails=$((fails+1)); }
LOGIN_APOS_RESET="$(node_e "
async function main(){
  const r = await fetch('http://localhost:3000/motorista/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({cnpjPrestador: process.argv[1], senha: process.argv[2]})});
  console.log('___R___'+r.status);
}
main();
" "$CNPJ_TESTE" "$SENHA_TEMP")"
check "senha antiga deixa de funcionar imediatamente após reset -> 401" "$(printf '%s' "$LOGIN_APOS_RESET" | grep -o '___R___[0-9]*' | sed 's/___R___//')" "401"

SENHA_NOVA='SenhaNovaE2eFase7#1'
st=$(shell_req POST "/api/v1/motoristas/$MOTORISTA_ID/credencial/reset-senha/definir" "$JAR" "{\"token\":\"$TOKEN_RESET\",\"novaSenha\":\"$SENHA_NOVA\"}")
check "POST /credencial/reset-senha/definir (token válido) -> 200" "$st" "200"

LOGIN_SENHA_NOVA="$(node_e "
async function main(){
  const r = await fetch('http://localhost:3000/motorista/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({cnpjPrestador: process.argv[1], senha: process.argv[2]})});
  console.log('___R___'+r.status);
}
main();
" "$CNPJ_TESTE" "$SENHA_NOVA")"
check "login app motorista com a senha NOVA definida -> 200" "$(printf '%s' "$LOGIN_SENHA_NOVA" | grep -o '___R___[0-9]*' | sed 's/___R___//')" "200"

st=$(shell_req PATCH "/api/v1/motoristas/$MOTORISTA_ID/credencial" "$JAR" '{"ativo":false}')
check "PATCH /motoristas/:id/credencial {ativo:false} -> 200" "$st" "200"
LOGIN_DESATIVADA="$(node_e "
async function main(){
  const r = await fetch('http://localhost:3000/motorista/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({cnpjPrestador: process.argv[1], senha: process.argv[2]})});
  const b = await r.json().catch(()=>({}));
  console.log('___R___'+JSON.stringify({status:r.status}));
}
main();
" "$CNPJ_TESTE" "$SENHA_NOVA")"
check "login com credencial ATIVA=false, senha correta -> 403 (acesso negado por desativação, não por senha)" "$(printf '%s' "$LOGIN_DESATIVADA" | grep '___R___' | sed 's/^___R___//' | node_e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(0,'utf8')).status))")" "403"

st=$(shell_req PATCH "/api/v1/motoristas/$MOTORISTA_ID/credencial" "$JAR" '{"ativo":true}')
check "PATCH /motoristas/:id/credencial {ativo:true} (reativar) -> 200" "$st" "200"
LOGIN_REATIVADA="$(node_e "
async function main(){
  const r = await fetch('http://localhost:3000/motorista/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({cnpjPrestador: process.argv[1], senha: process.argv[2]})});
  console.log('___R___'+r.status);
}
main();
" "$CNPJ_TESTE" "$SENHA_NOVA")"
check "login volta a funcionar após reativar -> 200" "$(printf '%s' "$LOGIN_REATIVADA" | grep -o '___R___[0-9]*' | sed 's/___R___//')" "200"

# Deixa a credencial desativada ao final do cenário (estado limpo p/ o
# próximo assert de auditoria não depender de ordem) — sem impacto: linha é
# removida no cleanup de qualquer forma.
shell_req PATCH "/api/v1/motoristas/$MOTORISTA_ID/credencial" "$JAR" '{"ativo":false}' >/dev/null

T_SC5_END=$(date +%s)
SC005_SEGUNDOS=$((T_SC5_END - T_SC5_START))
echo "SC-005 (7.1.2): cadastro (Scenario 5) + credencial (Scenario 6, criar+login+reset+desativar) combinados = ${SC005_SEGUNDOS}s (via curl, sem tempo de digitação humana — cronômetro de execução do smoke; medição de referência para o teto de 120s, não substitui timing de UI real)"

# ── Scenario 5 (cont.) — editar nome/situação + auditoria ─────────────────
echo
echo "### Scenario 5 (cont.) — PATCH nome/situação + auditoria (quem/quando) ###"
st=$(shell_req PATCH "/api/v1/motoristas/$MOTORISTA_ID" "$JAR" "{\"nome\":\"$NOME_PREFIX Motorista 1 Editado\"}")
check "PATCH /motoristas/:id {nome} -> 200" "$st" "200"
N_AUDIT="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE recurso='Entregador' AND recurso_id='$MOTORISTA_ID'" | tr -d '[:space:]')"
GE1=$(node_e "process.stdout.write(String(Number(process.argv[1])>=1))" "$N_AUDIT")
check "auditoria registrou quem/quando das escritas em Entregador (>=1 linha)" "$GE1" "true"

# ── Scenario 7 (WS-C): atividades read-only por uuid ───────────────────────
echo
echo "### Scenario 7 — atividades correlacionadas por uuid no detalhe ###"
st=$(shell_req GET "/api/v1/motoristas/$MOTORISTA_ID" "$JAR")
check "GET /motoristas/:id -> 200" "$st" "200"
N_ATIV_ANTES="$(node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d.atividades && Array.isArray(d.atividades.items) ? d.atividades.items.length : -1))" < "$TMP/body.json")"
check "detalhe sem atividade ainda: items=[] (edge case, sem erro)" "$N_ATIV_ANTES" "0"

# Insere 1 linha REAL em EnvioMassa correlacionável por entregador_uuid+cnpj
# (dec-048: AND entregador_uuid + cnpj_prestador, bola fechada FASE 6) —
# exercita a correlação de ponta a ponta sem depender do fluxo completo de
# upload+FastAPI (fora do escopo deste smoke; a lógica de escrita do
# entregador_uuid em /validar-nota já tem teste unitário dedicado da FASE 6).
psql_t <<SQL >/dev/null
INSERT INTO "EnvioMassa" (nome, cnpj_prestador, id_empresa, entregador_uuid, numnota, data_emissao, valor, nota_ok, mov_fechado)
VALUES ('$NOME_PREFIX Motorista 1', '$CNPJ_TESTE', $EMPRESA, '$UUID1', 'NF-E2E-FASE7-001', '2026-07-12', 123.45, 'sim', true);
SQL
st=$(shell_req GET "/api/v1/motoristas/$MOTORISTA_ID" "$JAR")
N_ATIV_DEPOIS="$(node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d.atividades && Array.isArray(d.atividades.items) ? d.atividades.items.length : -1))" < "$TMP/body.json")"
check "detalhe pós-insert EnvioMassa correlacionada por uuid: items.length=1" "$N_ATIV_DEPOIS" "1"
TIPO_ATIV="$(node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String((d.atividades.items[0]||{}).tipo||''))" < "$TMP/body.json")"
check "atividade correlacionada tipo=validacao_nf" "$TIPO_ATIV" "validacao_nf"

# Regressão do gap encontrado no code-review de fechamento desta FASE:
# EnvioMassa.cnpj_prestador pode estar gravado no formato MASCARADO
# (XX.XXX.XXX/XXXX-XX, import legado) — a correlação deve achar essa linha
# também, não só a variante dígitos-puro (lib/hub-motoristas-dto.js
# #cnpjEnvioMassaFilter, cópia deliberada de routes/motorista.js:117).
CNPJ_MASCARADO="${CNPJ_TESTE:0:2}.${CNPJ_TESTE:2:3}.${CNPJ_TESTE:5:3}/${CNPJ_TESTE:8:4}-${CNPJ_TESTE:12:2}"
psql_t <<SQL >/dev/null
INSERT INTO "EnvioMassa" (nome, cnpj_prestador, id_empresa, entregador_uuid, numnota, data_emissao, valor, nota_ok, mov_fechado)
VALUES ('$NOME_PREFIX Motorista 1 (cnpj mascarado)', '$CNPJ_MASCARADO', $EMPRESA, '$UUID1', 'NF-E2E-FASE7-002', '2026-07-11', 55.0, 'sim', true);
SQL
st=$(shell_req GET "/api/v1/motoristas/$MOTORISTA_ID" "$JAR")
N_ATIV_MASCARADO="$(node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d.atividades && Array.isArray(d.atividades.items) ? d.atividades.items.length : -1))" < "$TMP/body.json")"
check "correlação também acha linha com cnpj_prestador MASCARADO (regressão do gap de code-review): items.length=2" "$N_ATIV_MASCARADO" "2"

# ── Scenario 8 (roundtrip, borda backend<->frontend) ────────────────────────
echo
echo "### Scenario 8 — roundtrip: shape do payload casa com o contrato ###"
IDEXTERNO_RESP="$(node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d.idExterno||''))" < "$TMP/body.json")"
check "GET /motoristas/:id inclui idExterno (uuid)" "$IDEXTERNO_RESP" "$UUID1"

# ── Scenario 9 (produção inalterada) — pós-checagem, além da pré-checagem ──
echo
echo "### Scenario 9 (pós-execução) — produção Swarm ainda inalterada ###"
PROD_ENV2="$(docker service inspect envio-massa-homologacao_backend_homologacao --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}' 2>/dev/null | tr ',' '\n' | grep -iE 'hub_motorista|envio_dry_run|envio_allowlist|entregador_uuid' || true)"
check "Scenario 9 pós-smoke: ainda nenhuma env hub-motorista-canonico em produção" "${PROD_ENV2:-}" ""
IMG_PROD="$(docker service inspect envio-massa-homologacao_backend_homologacao --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null | cut -d'@' -f1)"
check "Scenario 9: imagem de produção segue :upload-motorista-paginacao (inalterada)" "$IMG_PROD" "registry.todo-tips.com/envio-massa-backend:upload-motorista-paginacao"

echo
if [ "$fails" -eq 0 ]; then
  echo "HUB-MOTORISTA-CANONICO-E2E-HOMOLOG: OK — todos os asserts passaram (FASE 7, quickstart Scenarios 1/2/3/5/6/7/8/9)"
  exit 0
else
  echo "HUB-MOTORISTA-CANONICO-E2E-HOMOLOG: FALHOU — $fails assert(s) falharam"
  exit 1
fi

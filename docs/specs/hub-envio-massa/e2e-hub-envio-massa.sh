#!/usr/bin/env bash
# =============================================================================
# e2e-hub-envio-massa.sh — hub-envio-massa (S8), tasks.md FASE 6 (6.1-6.3) +
# 4.1.8 + 5.1.6 (parcial, ver nota de segurança abaixo). Roda contra um
# ambiente `hub-test-<runid>` EFÊMERO (compose.hub.test.yml) — nunca
# `hub-homolog` compartilhado, nunca `envio-massa-homologacao_*`/
# `chatmasterveloz` (produção real do cliente, CLAUDE.md).
#
# Padrão técnico seguido de infra/hub/testes/hub-performance-integration.sh /
# hub-faturamento-integration.sh (mocks n8n/FastAPI, preflight.sh, migrate.sh,
# cleanup via trap, função check() PASS/FAIL) — mais robustos/atuais que os
# scripts citados no tasks.md original (docs/specs/validacao-xml-lote/,
# docs/specs/grupo-unificado-filiais/), que servem só de referência histórica
# de nomenclatura (orientação do orquestrador-pai desta execução).
#
# ⚠️ ACHADO DE SEGURANÇA (pré-existente, fora do diff desta feature — ver
# relatório final da execução): NENHUM dos dois pontos de "saída externa" do
# fluxo legado é realmente gateado por env var nem passa pelos mocks:
#   - `sendMessage()` (server.js, chamada por `processBatchMessages` a partir
#     de `POST /start-process`) tem URL HARDCODED `https://api.chatmasterveloz.com/...`
#     — NÃO lê `N8N_URL`, NÃO existe `ENVIO_DRY_RUN`/allowlist no código
#     (só existem como env vars documentadas em RUNBOOK.md/.env.hub.*.example,
#     nunca lidas por nenhum `process.env` em server.js).
#   - `POST /validate-xml-batch` tem URL HARDCODED para
#     `https://fastapihomologacao.todo-tips.com/validade_nfse` /
#     `https://fastapihomologacaonexus.todo-tips.com/validade_nfse` (serviços
#     REAIS de produção, os mesmos citados no CLAUDE.md) — NÃO lê
#     `FASTAPI_URL`, nunca roteia para `fastapi-mock`.
# Por isso este script NUNCA deixa nenhuma linha `EnvioMassa.enviado='off'`
# existir em momento algum (todo upload desta suíte grava `enviado='on'`
# explicitamente, e a linha semente da migration 0034 é neutralizada logo
# após o migrate) — isso torna `POST /start-process` seguro de exercitar (o
# loop de `processBatchMessages` não encontra nenhuma linha elegível, então
# `sendMessage` nunca é chamada). E usa SEMPRE um XML que não casa nenhum
# movimento aberto (`sem_movimento`) para exercitar `POST /validate-xml-batch`
# — o código retorna ANTES de chamar a FastAPI nesse caminho (server.js linha
# ~2390-2394, "sem_movimento → NUNCA insere"). Os asserts de 6.2.1/6.2.2 sobre
# `ENVIO_DRY_RUN`/mocks são, portanto, PARCIAIS por construção seletiva do
# cenário de teste, não porque o código realmente gate por env var — os logs
# dos mocks n8n/fastapi ficam vazios porque esses caminhos JAMAIS SÃO
# ALCANÇADOS pelo fluxo exercitado aqui, não porque uma proteção os desviou.
# Ver relatório final para a Decisão que o orquestrador-pai precisa tomar.
#
# Uso: docs/specs/hub-envio-massa/e2e-hub-envio-massa.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/../../../infra/hub" && pwd)"
REPO_DIR="$(cd "$HUB_DIR/../.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)"
PROJECT="hub-test-$RUNID"
TMP="$(mktemp -d)"
EVID_DIR="$REPO_DIR/docs/specs/hub-envio-massa/evidencias"
mkdir -p "$EVID_DIR"
RUN_LOG="$EVID_DIR/e2e-run-$(date -u +%Y%m%dT%H%M%SZ).log"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }

# ACHADO DE AMBIENTE (desta execução, ver relatório da FASE 6): o código
# LEGADO (`postgrestRequest`, server.js) assina o JWT do PostgREST com
# `POSTGREST_API_KEY`, enquanto o PostgREST do hub verifica com
# `PGRST_JWT_SECRET` — em PRODUÇÃO os dois carregam o MESMO valor, mas o
# gen-secrets.sh do hub gerou dois segredos independentes em todos os
# .env.hub.* (confirmado por hash sha256, sem expor valores). Sem alinhar,
# TODA chamada legada ao banco leva 401 do PostgREST — e `/start-process`
# chega a DERRUBAR o processo (updateProcessControl lança dentro do catch
# do handler → unhandled rejection → crash no Node 20). Alinhamos AQUI,
# só para o projeto efêmero (env de shell tem precedência sobre --env-file
# na interpolação do compose) — nenhum arquivo de segredos é modificado.
export POSTGREST_API_KEY="$(get_var PGRST_JWT_SECRET "$ENV_FILE")"
[ -n "$POSTGREST_API_KEY" ] || { echo "PGRST_JWT_SECRET ausente em $ENV_FILE" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
cleanup() { dc down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

# Tudo abaixo é escrito em $RUN_LOG também (evidência 6.3.3), via `tee`.
exec > >(tee -a "$RUN_LOG") 2>&1

echo "=== e2e-hub-envio-massa — projeto=$PROJECT runid=$RUNID $(date -u +%FT%TZ) ==="

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }

echo "subindo db+postgrest+fastapi-mock+n8n-mock+mailpit-mock efêmeros ($PROJECT, tmpfs)…"
dc up -d --wait db
dc up -d --wait postgrest
dc up -d --wait fastapi-mock
dc up -d --wait n8n-mock
dc up -d --wait mailpit-mock
# Cap de memória obrigatório no build (lição de starvation 2026-06-11).
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend (Dockerfile.hub)"; tail -80 "$TMP/build.log"; exit 1; }
dc up -d --wait backend

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
node_e() { dc exec -T backend node -e "$1" "${@:2}"; }
run_node() { dc exec -T backend node - "$@"; }

# O serviço backend de compose.hub.test.yml NÃO tem healthcheck — `up --wait`
# retorna quando o container está "running", ANTES do Express bindar a porta
# 3000. Depois de cada recreate (toggles de flag), aguardar o HTTP aceitar
# conexões (achado do primeiro run: ECONNREFUSED logo após o recreate).
wait_backend() {
  for _i in $(seq 1 30); do
    if dc exec -T backend node -e "fetch('http://localhost:3000/process-status').then(()=>process.exit(0)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "FAIL: backend não voltou a aceitar conexões após recreate" >&2
  return 1
}

fails=0
check() { # check <descricao> <valor-obtido> <valor-esperado>
  if [ "$2" = "$3" ]; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 (obtido='$2' esperado='$3')"
    fails=$((fails + 1))
  fi
}

echo "rodando migrate.sh (0002..0034)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0033_schema_legado_envio_massa.sql" "$TMP/migrate.log" || { echo "FAIL: migration 0033 não aplicada"; cat "$TMP/migrate.log"; exit 1; }
grep -q "0034_seed_legado_envio_massa_teste.sql" "$TMP/migrate.log" || { echo "FAIL: migration 0034 não aplicada"; cat "$TMP/migrate.log"; exit 1; }
echo "PASS: migrations 0033/0034 aplicadas"

# ─────────────────────────────────────────────────────────────────────────────
# Neutralização de segurança: a migration 0034 semeia 1 linha EnvioMassa
# (id_empresa=9001) com enviado='off'/mov_fechado=false — se alguém chamasse
# POST /start-process para a empresa 9001 SEM neutralizar, processBatchMessages
# chamaria sendMessage() de verdade (URL hardcoded real, ver cabeçalho). Vira
# 'on' imediatamente, ANTES de qualquer seed/teste adicional.
# ─────────────────────────────────────────────────────────────────────────────
psql_t -c "UPDATE \"EnvioMassa\" SET enviado='on' WHERE id_empresa=9001 AND enviado='off';" >/dev/null
QTD_OFF_RESTANTE="$(psql_t -tAc "SELECT count(*) FROM \"EnvioMassa\" WHERE enviado='off'" | tr -d '[:space:]')"
check "SEGURANÇA: zero linhas EnvioMassa com enviado='off' após neutralização da seed 0034" "$QTD_OFF_RESTANTE" "0"

# ─────────────────────────────────────────────────────────────────────────────
# Seeds hub-nativos: 3 papéis (leitura/operador/admin_entidade) vinculados à
# empresa legada 9001 (já existe via 0034 — mesmo id do tenant hub de QA,
# resolverGrupoDaEntidade em hub-envio-massa-claims.js precisa achar
# Empresa.id=9001 na tabela LEGADA).
# ─────────────────────────────────────────────────────────────────────────────
SENHA_OK='SenhaSinteticaEnvioMassa#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

E_TESTE=9001

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('envio-massa-leitura@example.test', '$HASH_OK', 'Usuario Teste Envio Massa Leitura', true),
  ('envio-massa-operador@example.test', '$HASH_OK', 'Usuario Teste Envio Massa Operador', true),
  ('envio-massa-admin@example.test', '$HASH_OK', 'Usuario Teste Envio Massa Admin Entidade', true);
SQL
UID_LEITURA="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='envio-massa-leitura@example.test'" | tr -d '[:space:]')"
UID_OPERADOR="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='envio-massa-operador@example.test'" | tr -d '[:space:]')"
UID_ADMIN="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='envio-massa-admin@example.test'" | tr -d '[:space:]')"
PAPEL_LEITURA="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='leitura'" | tr -d '[:space:]')"
PAPEL_OPERADOR="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='operador'" | tr -d '[:space:]')"
PAPEL_ADMIN="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_entidade'" | tr -d '[:space:]')"
for v in UID_LEITURA UID_OPERADOR UID_ADMIN PAPEL_LEITURA PAPEL_OPERADOR PAPEL_ADMIN; do
  [ -n "${!v}" ] || { echo "FAIL: $v não foi criado/resolvido"; exit 1; }
done

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_LEITURA,  $E_TESTE, $PAPEL_LEITURA,  true),
  ($UID_OPERADOR, $E_TESTE, $PAPEL_OPERADOR, true),
  ($UID_ADMIN,    $E_TESTE, $PAPEL_ADMIN,    true);
SQL
echo "PASS: seeds de usuário/papel (leitura/operador/admin_entidade) criados para empresa $E_TESTE"

# 1.1.6 (re-confirmação viva) — matriz papel×ação da migration 0032/0007.
N_GERENCIAR="$(psql_t -tAc "SELECT count(*) FROM \"PapelPermissao\" pp JOIN \"Papel\" p ON p.id=pp.papel_id JOIN \"Permissao\" perm ON perm.id=pp.permissao_id WHERE perm.codigo='envio_massa.gerenciar' AND p.nome IN ('admin_plataforma','admin_entidade')" | tr -d '[:space:]')"
check "migration 0032: envio_massa.gerenciar concedida a admin_plataforma+admin_entidade (2)" "$N_GERENCIAR" "2"
N_GERENCIAR_LEIT_OPER="$(psql_t -tAc "SELECT count(*) FROM \"PapelPermissao\" pp JOIN \"Papel\" p ON p.id=pp.papel_id JOIN \"Permissao\" perm ON perm.id=pp.permissao_id WHERE perm.codigo='envio_massa.gerenciar' AND p.nome IN ('operador','leitura')" | tr -d '[:space:]')"
check "migration 0032: envio_massa.gerenciar NÃO concedida a operador/leitura (0)" "$N_GERENCIAR_LEIT_OPER" "0"

# ─────────────────────────────────────────────────────────────────────────────
# BLOCO A — Script Node único: Cenários 1, 2, 3, 4, 6, 6.1.8, 4.1.8 (hub +
# legado). Um único login por papel (SC-003 — evidência de "login único cobre
# o fluxo inteiro": nenhuma chamada de login intermediária dentro do fluxo do
# Cenário 1).
# ─────────────────────────────────────────────────────────────────────────────
OUT="$(run_node "$SENHA_OK" "$E_TESTE" <<'JS'
const BASE = 'http://localhost:3000';

function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar || {}).map(([k, v]) => `${k}=${v}`).join('; '); }

async function loginHub(email, senha) {
  const r = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) });
  const jar = parseSetCookie(r);
  return { jar, status: r.status };
}
async function loginLegado(email, password) {
  const r = await fetch(`${BASE}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const jar = parseSetCookie(r);
  return { jar, status: r.status };
}
async function trocarEntidade(jar, empresaId) {
  const r = await fetch(`${BASE}/api/v1/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaId }) });
  return { ...jar, ...parseSetCookie(r) };
}
async function getJson(jar, path) {
  const r = await fetch(`${BASE}${path}`, { headers: jar ? { Cookie: cookieHeader(jar) } : {} });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function del(jar, path) {
  const r = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: jar ? { Cookie: cookieHeader(jar) } : {} });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function patchJson(jar, path, data) {
  const r = await fetch(`${BASE}${path}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify(data) });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function postJson(jar, path, data) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify(data || {}) });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

function buildXlsx(rows) {
  const XLSX = require('xlsx');
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// SEMPRE enviado='on' — nunca gerar uma linha elegível para sendMessage()
// real (ver cabeçalho do script, achado de segurança).
function linhaValida(sufixo) {
  return {
    number: '11999990000',
    cnpj_tomador: '11.222.333/0001-81',
    nome: 'Motorista Teste E2E ' + sufixo,
    valor: '150,00',
    cnpj_prestador: '9988877700' + String(sufixo).padStart(4, '0'),
    enviado: 'on',
  };
}

async function uploadXlsx(jar, rows, dtInicial, dtFinal) {
  const buf = buildXlsx(rows);
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'lote-teste.xlsx');
  fd.append('dt_inicial', dtInicial);
  fd.append('dt_final', dtFinal);
  const r = await fetch(`${BASE}/upload`, { method: 'POST', headers: { Cookie: cookieHeader(jar) }, body: fd });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

// XML NFS-e mínimo com CNPJ que NUNCA casa nenhum movimento aberto
// (sem_movimento) — o handler retorna ANTES de chamar a FastAPI real nesse
// caminho (server.js ~2390-2394). NUNCA usar um XML que possa casar um
// movimento real aqui (ver achado de segurança no cabeçalho do script).
function xmlSemMovimento() {
  return '<NFSe><infNFSe><emit><CNPJ>00000000000000</CNPJ><xNome>Ninguem</xNome></emit></infNFSe></NFSe>';
}
async function validateXmlBatch(jar) {
  const fd = new FormData();
  fd.append('xmlFiles', new Blob([xmlSemMovimento()], { type: 'application/xml' }), 'sem-movimento.xml');
  const r = await fetch(`${BASE}/validate-xml-batch`, { method: 'POST', headers: { Cookie: cookieHeader(jar) }, body: fd });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

async function main() {
  const senha = process.argv[2];
  const empresaTeste = Number(process.argv[3]);
  const out = {};

  // ── Cenário 2 + SC-003: login hub SEM chamar /me/entidade -> SEM_ENTIDADE_ATIVA ──
  let jarAdmin0 = (await loginHub('envio-massa-admin@example.test', senha)).jar;
  const rSemEntidade = await getJson(jarAdmin0, '/envio-massa');
  out.cenario2_status = rSemEntidade.status;
  out.cenario2_code = rSemEntidade.body && rSemEntidade.body.error && rSemEntidade.body.error.code;
  out.cenario2_message = rSemEntidade.body && rSemEntidade.body.error && rSemEntidade.body.error.message;

  // Mesma sessão (SC-003: 1 único login), agora seleciona a entidade.
  let jarAdmin = await trocarEntidade(jarAdmin0, empresaTeste);

  // ── Cenário 1: fluxo completo admin_entidade ──────────────────────────────
  const rListaInicial = await getJson(jarAdmin, '/envio-massa');
  out.c1_lista_inicial_status = rListaInicial.status;
  const totalAntes = Array.isArray(rListaInicial.body) ? rListaInicial.body.length : null;

  const rUpload = await uploadXlsx(jarAdmin, [linhaValida(1), linhaValida(2)], '01/07/2026', '31/07/2026');
  out.c1_upload_status = rUpload.status;
  out.c1_upload_success = rUpload.body && rUpload.body.success;

  const rListaPosUpload = await getJson(jarAdmin, '/envio-massa');
  out.c1_lista_pos_upload_len = Array.isArray(rListaPosUpload.body) ? rListaPosUpload.body.length : null;
  out.c1_lista_delta = (totalAntes !== null && out.c1_lista_pos_upload_len !== null) ? (out.c1_lista_pos_upload_len - totalAntes) : null;
  const novoId = Array.isArray(rListaPosUpload.body)
    ? (rListaPosUpload.body.find((r) => String(r.nome || '').includes('Motorista Teste E2E')) || {}).id
    : null;
  out.c1_novo_id_presente = novoId !== null && novoId !== undefined;

  // PATCH — único campo realmente gravável por este endpoint é enviado/retorno_envio_msg_* por tipo.
  const rPatch = await patchJson(jarAdmin, `/update-envio-massa/${novoId}`, { enviado: 'on', mensagem: 'observação de teste E2E', tipo: 'men1' });
  out.c1_patch_status = rPatch.status;

  // start-process — seguro (nenhuma linha enviado='off' existe neste ponto).
  const rStart = await postJson(jarAdmin, '/start-process', {});
  out.c1_start_status = rStart.status;
  const rProcessStatus = await getJson(jarAdmin, '/process-status');
  out.c1_process_status_status = rProcessStatus.status;
  out.c1_process_status_active = rProcessStatus.body && rProcessStatus.body.active;

  // validate-xml-batch — seguro (sem_movimento, nunca chama a FastAPI real).
  const rValidate = await validateXmlBatch(jarAdmin);
  out.c1_validate_status = rValidate.status;
  out.c1_validate_stats_sem_movimento = rValidate.body && rValidate.body.stats && rValidate.body.stats.sem_movimento;
  out.c1_validate_stats_total = rValidate.body && rValidate.body.stats && rValidate.body.stats.total;

  // export-envio-massa — ANTES do close-movimento (filtra mov_fechado=false).
  const rExport = await getJson(jarAdmin, '/export-envio-massa');
  out.c1_export_status = rExport.status;

  // download-xml-movimento — a seed 0034 tem 1 movimento aberto VALIDADO
  // (numnota + nota_ok preenchidos, erro vazio) -> 200 (ZIP); prova que
  // passou pelo gate RBAC e chegou na lógica de negócio.
  const rDownloadXml = await getJson(jarAdmin, '/download-xml-movimento');
  out.c1_download_xml_status = rDownloadXml.status;

  // close-movimento — fecha TODOS os movimentos abertos da empresa.
  const rClose = await postJson(jarAdmin, '/close-movimento', {});
  out.c1_close_status = rClose.status;
  out.c1_close_fechados = rClose.body && rClose.body.fechados;

  // DELETE — em cima de um movimento já fechado (endpoint não filtra mov_fechado).
  const rDelete = await del(jarAdmin, `/envio-massa/${novoId}`);
  out.c1_delete_status = rDelete.status;

  // ── 4.1.8: histórico de importação (sessão hub) ───────────────────────────
  const rImportacoesHub = await getJson(jarAdmin, '/api/v1/importacoes?tipo=envio_massa');
  out.import_hub_status = rImportacoesHub.status;
  const listaImportHub = (rImportacoesHub.body && (rImportacoesHub.body.items || rImportacoesHub.body)) || [];
  out.import_hub_tem_entrada = Array.isArray(listaImportHub) && listaImportHub.length > 0;
  const entradaHub = Array.isArray(listaImportHub) ? listaImportHub[0] : null;
  out.import_hub_tipo = entradaHub && entradaHub.tipo;
  out.import_hub_status_terminal = entradaHub && entradaHub.status;
  out.import_hub_total_linhas = entradaHub && entradaHub.totalLinhas;
  out.import_hub_linhas_validas = entradaHub && entradaHub.linhasValidas;

  // ── Cenário 6: sessão LEGADA (fora do /hub/) — fluxo completo sem nenhum
  // código de erro novo, e SEM gerar entrada de histórico (4.1.8 guard) ─────
  const loginLegadoRes = await loginLegado('qa.envio-massa.matriz@hub-test.local', 'EnvioMassaQA@2026');
  out.c6_login_status = loginLegadoRes.status;
  const jarLegado = loginLegadoRes.jar;

  const rListaLegado = await getJson(jarLegado, '/envio-massa');
  out.c6_lista_status = rListaLegado.status;
  out.c6_lista_erro_code = rListaLegado.body && rListaLegado.body.error && rListaLegado.body.error.code;

  const rUploadLegado = await uploadXlsx(jarLegado, [linhaValida(3)], '01/07/2026', '31/07/2026');
  out.c6_upload_status = rUploadLegado.status;

  const rProcessStatusLegado = await getJson(jarLegado, '/process-status');
  out.c6_process_status_status = rProcessStatusLegado.status;

  const rStartLegado = await postJson(jarLegado, '/start-process', {});
  out.c6_start_status = rStartLegado.status;

  // export ANTES do close (endpoint filtra mov_fechado=false — depois do
  // close não sobra linha aberta e o 404 seria de negócio, não de fluxo).
  const rExportLegado = await getJson(jarLegado, '/export-envio-massa');
  out.c6_export_status = rExportLegado.status;

  const rCloseLegado = await postJson(jarLegado, '/close-movimento', {});
  out.c6_close_status = rCloseLegado.status;

  // ── Cenário 3: papel leitura — GET 200, escrita 403 ───────────────────────
  let jarLeitura0 = (await loginHub('envio-massa-leitura@example.test', senha)).jar;
  let jarLeitura = await trocarEntidade(jarLeitura0, empresaTeste);

  const rC3Get = await getJson(jarLeitura, '/envio-massa');
  out.c3_get_status = rC3Get.status;

  const rC3Upload = await uploadXlsx(jarLeitura, [linhaValida(4)], '01/07/2026', '31/07/2026');
  out.c3_upload_status = rC3Upload.status;
  out.c3_upload_code = rC3Upload.body && rC3Upload.body.error && rC3Upload.body.error.code;

  const rC3Start = await postJson(jarLeitura, '/start-process', {});
  out.c3_start_status = rC3Start.status;

  const rC3Validate = await validateXmlBatch(jarLeitura);
  out.c3_validate_status = rC3Validate.status;

  const rC3Close = await postJson(jarLeitura, '/close-movimento', {});
  out.c3_close_status = rC3Close.status;

  const rC3Delete = await del(jarLeitura, '/envio-massa/999999999');
  out.c3_delete_status = rC3Delete.status;

  const rC3Patch = await patchJson(jarLeitura, '/update-envio-massa/999999999', { enviado: 'on', tipo: 'men1' });
  out.c3_patch_status = rC3Patch.status;

  // ── Cenário 4: papel operador — operar sim, aprovar/fechar não ───────────
  let jarOperador0 = (await loginHub('envio-massa-operador@example.test', senha)).jar;
  let jarOperador = await trocarEntidade(jarOperador0, empresaTeste);

  const rC4Upload = await uploadXlsx(jarOperador, [linhaValida(5)], '01/07/2026', '31/07/2026');
  out.c4_upload_status = rC4Upload.status;

  const rListaPosC4 = await getJson(jarOperador, '/envio-massa');
  const novoIdOperador = Array.isArray(rListaPosC4.body)
    ? (rListaPosC4.body.find((r) => String(r.nome || '').includes('Motorista Teste E2E 5')) || {}).id
    : null;

  const rC4Patch = novoIdOperador
    ? await patchJson(jarOperador, `/update-envio-massa/${novoIdOperador}`, { enviado: 'on', tipo: 'men1' })
    : { status: null };
  out.c4_patch_status = rC4Patch.status;

  const rC4Start = await postJson(jarOperador, '/start-process', {});
  out.c4_start_status = rC4Start.status;

  const rC4Validate = await validateXmlBatch(jarOperador);
  out.c4_validate_status = rC4Validate.status;

  const rC4Close = await postJson(jarOperador, '/close-movimento', {});
  out.c4_close_status = rC4Close.status;

  const rC4Delete = novoIdOperador
    ? await del(jarOperador, `/envio-massa/${novoIdOperador}`)
    : { status: null };
  out.c4_delete_status = rC4Delete.status;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT" | grep -v '___RESULT_JSON___' || true
RESULT_LINE="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$RESULT_LINE" ] || { echo "FAIL: BLOCO A (script Node) não retornou resultado"; echo "$OUT"; exit 1; }
jget() { printf '%s' "$RESULT_LINE" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const v=d['$1']; process.stdout.write(v===null||v===undefined?'':String(v))"; }

echo
echo "── Cenário 2 (SEM_ENTIDADE_ATIVA) — spec.md FR-004 ─────────────────────────"
check "GET /envio-massa sem entidade_ativa -> 403" "$(jget cenario2_status)" "403"
check "GET /envio-massa sem entidade_ativa -> error.code=SEM_ENTIDADE_ATIVA (byte-a-byte, não errorCode)" "$(jget cenario2_code)" "SEM_ENTIDADE_ATIVA"

echo
echo "── Cenário 1 (admin_entidade, fluxo completo) — US1+US2+US3 ────────────────"
check "lista inicial -> 200" "$(jget c1_lista_inicial_status)" "200"
check "upload -> 200" "$(jget c1_upload_status)" "200"
check "upload -> success=true" "$(jget c1_upload_success)" "true"
check "lista pós-upload -> delta de 2 linhas" "$(jget c1_lista_delta)" "2"
check "lista pós-upload -> novo id presente" "$(jget c1_novo_id_presente)" "true"
check "PATCH /update-envio-massa/:id -> 200" "$(jget c1_patch_status)" "200"
check "POST /start-process -> 200 (seguro, zero linhas enviado='off')" "$(jget c1_start_status)" "200"
check "GET /process-status -> 200" "$(jget c1_process_status_status)" "200"
check "GET /process-status -> active=false (processo síncrono já concluiu)" "$(jget c1_process_status_active)" "false"
check "POST /validate-xml-batch -> 200 (seguro, sem_movimento)" "$(jget c1_validate_status)" "200"
check "validate-xml-batch -> stats.total=1" "$(jget c1_validate_stats_total)" "1"
check "validate-xml-batch -> stats.sem_movimento=1 (nunca chamou FastAPI real)" "$(jget c1_validate_stats_sem_movimento)" "1"
check "GET /export-envio-massa (antes do close) -> 200" "$(jget c1_export_status)" "200"
check "GET /download-xml-movimento -> 200 (ZIP — seed 0034 tem movimento validado com numnota+nota_ok)" "$(jget c1_download_xml_status)" "200"
check "POST /close-movimento -> 200" "$(jget c1_close_status)" "200"
check "POST /close-movimento -> fechados=4 (2 do upload + 2 abertos da seed 0034)" "$(jget c1_close_fechados)" "4"
check "DELETE /envio-massa/:id -> 200" "$(jget c1_delete_status)" "200"

echo
echo "── 4.1.8 (histórico de importação, sessão hub) — FR-009/010/011 ───────────"
check "GET /importacoes?tipo=envio_massa -> 200" "$(jget import_hub_status)" "200"
check "histórico: entrada nova presente (sessão hub gera log)" "$(jget import_hub_tem_entrada)" "true"
check "histórico: tipo=envio_massa" "$(jget import_hub_tipo)" "envio_massa"
check "histórico: status terminal = completed (2/2 linhas válidas)" "$(jget import_hub_status_terminal)" "completed"
check "histórico: total_linhas=2" "$(jget import_hub_total_linhas)" "2"
check "histórico: linhas_validas=2" "$(jget import_hub_linhas_validas)" "2"

echo
echo "── Cenário 6 (sessão legada, fora do /hub/) — FR-018/FR-002 ───────────────"
check "POST /login (legado) -> 200" "$(jget c6_login_status)" "200"
check "GET /envio-massa (legado) -> 200" "$(jget c6_lista_status)" "200"
check "GET /envio-massa (legado) -> NUNCA SEM_ENTIDADE_ATIVA/PERMISSAO_INSUFICIENTE" "$(jget c6_lista_erro_code)" ""
check "POST /upload (legado) -> 200" "$(jget c6_upload_status)" "200"
check "GET /process-status (legado) -> 200" "$(jget c6_process_status_status)" "200"
check "POST /start-process (legado) -> 200 (seguro)" "$(jget c6_start_status)" "200"
check "POST /close-movimento (legado) -> 200" "$(jget c6_close_status)" "200"
check "GET /export-envio-massa (legado) -> 200" "$(jget c6_export_status)" "200"

echo
echo "── Cenário 3 (papel leitura) — US3, FR-007/FR-008 ──────────────────────────"
check "GET /envio-massa (leitura) -> 200" "$(jget c3_get_status)" "200"
check "POST /upload (leitura) -> 403" "$(jget c3_upload_status)" "403"
check "POST /upload (leitura) -> error.code=PERMISSAO_INSUFICIENTE" "$(jget c3_upload_code)" "PERMISSAO_INSUFICIENTE"
check "PATCH /update-envio-massa/:id (leitura) -> 403" "$(jget c3_patch_status)" "403"
check "POST /start-process (leitura) -> 403" "$(jget c3_start_status)" "403"
check "POST /validate-xml-batch (leitura) -> 403" "$(jget c3_validate_status)" "403"
check "POST /close-movimento (leitura) -> 403" "$(jget c3_close_status)" "403"
check "DELETE /envio-massa/:id (leitura) -> 403" "$(jget c3_delete_status)" "403"

echo
echo "── Cenário 4 (papel operador) — US3 ─────────────────────────────────────────"
check "POST /upload (operador) -> 200" "$(jget c4_upload_status)" "200"
check "PATCH /update-envio-massa/:id (operador) -> 200" "$(jget c4_patch_status)" "200"
check "POST /start-process (operador) -> 200 (seguro)" "$(jget c4_start_status)" "200"
check "POST /validate-xml-batch (operador) -> 200 (seguro, sem_movimento)" "$(jget c4_validate_status)" "200"
check "POST /close-movimento (operador) -> 403" "$(jget c4_close_status)" "403"
check "DELETE /envio-massa/:id (operador) -> 403" "$(jget c4_delete_status)" "403"

# ─────────────────────────────────────────────────────────────────────────────
# 4.1.8 — flag off (upload não gera entrada) + falha simulada de INSERT do log
# (upload de negócio continua 200 mesmo com o INSERT do log falhando).
# ─────────────────────────────────────────────────────────────────────────────
echo
echo "── 4.1.8 — flag HUB_IMPORT_LOG_ENVIO=off (upload sem log) ─────────────────"
HUB_IMPORT_LOG_ENVIO=off dc up -d --wait backend >"$TMP/recreate-flagoff.log" 2>&1
wait_backend || exit 1
N_IMPORT_ANTES="$(psql_t -tAc "SELECT count(*) FROM \"ImportacaoArquivo\" WHERE tipo='envio_massa'" | tr -d '[:space:]')"
OUT_FLAGOFF="$(run_node "$SENHA_OK" "$E_TESTE" <<'JS'
const BASE = 'http://localhost:3000';
function parseSetCookie(res) { const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; const jar = {}; for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); } return jar; }
function cookieHeader(jar) { return Object.entries(jar || {}).map(([k, v]) => `${k}=${v}`).join('; '); }
async function loginHub(email, senha) { const r = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) }); return parseSetCookie(r); }
async function trocarEntidade(jar, empresaId) { const r = await fetch(`${BASE}/api/v1/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaId }) }); return { ...jar, ...parseSetCookie(r) }; }
function buildXlsx(rows) { const XLSX = require('xlsx'); const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); }
async function uploadXlsx(jar, rows, dtInicial, dtFinal) {
  const buf = buildXlsx(rows);
  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'lote-flagoff.xlsx');
  fd.append('dt_inicial', dtInicial); fd.append('dt_final', dtFinal);
  const r = await fetch(`${BASE}/upload`, { method: 'POST', headers: { Cookie: cookieHeader(jar) }, body: fd });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function main() {
  const senha = process.argv[2]; const empresaTeste = Number(process.argv[3]);
  let jar = await loginHub('envio-massa-admin@example.test', senha);
  jar = await trocarEntidade(jar, empresaTeste);
  const r = await uploadXlsx(jar, [{ number: '11999990000', cnpj_tomador: '11.222.333/0001-81', nome: 'Motorista Flagoff', valor: '10,00', cnpj_prestador: '99888777000106', enviado: 'on' }], '01/07/2026', '31/07/2026');
  console.log('___RESULT_JSON___' + JSON.stringify({ status: r.status, success: r.body && r.body.success }));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
RESULT_FLAGOFF="$(echo "$OUT_FLAGOFF" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
STATUS_FLAGOFF="$(printf '%s' "$RESULT_FLAGOFF" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d.status))" 2>/dev/null)"
check "upload com HUB_IMPORT_LOG_ENVIO=off -> 200 (negócio segue normal)" "$STATUS_FLAGOFF" "200"
N_IMPORT_DEPOIS="$(psql_t -tAc "SELECT count(*) FROM \"ImportacaoArquivo\" WHERE tipo='envio_massa'" | tr -d '[:space:]')"
check "HUB_IMPORT_LOG_ENVIO=off -> nenhuma entrada nova de histórico" "$N_IMPORT_DEPOIS" "$N_IMPORT_ANTES"

# ── Cenário 5 — HUB_RBAC_ENVIO=off (mantendo IMPORT_LOG off deste bloco) ────
echo
echo "── Cenário 5 — HUB_RBAC_ENVIO=off (reversão instantânea) — FR-006/SC-005 ──"
HUB_RBAC_ENVIO=off HUB_IMPORT_LOG_ENVIO=off dc up -d --wait backend >"$TMP/recreate-rbacoff.log" 2>&1
wait_backend || exit 1
OUT_C5="$(run_node "$SENHA_OK" "$E_TESTE" <<'JS'
const BASE = 'http://localhost:3000';
function parseSetCookie(res) { const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; const jar = {}; for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); } return jar; }
function cookieHeader(jar) { return Object.entries(jar || {}).map(([k, v]) => `${k}=${v}`).join('; '); }
async function loginHub(email, senha) { const r = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) }); return parseSetCookie(r); }
async function trocarEntidade(jar, empresaId) { const r = await fetch(`${BASE}/api/v1/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaId }) }); return { ...jar, ...parseSetCookie(r) }; }
function buildXlsx(rows) { const XLSX = require('xlsx'); const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); }
async function uploadXlsx(jar, rows, dtInicial, dtFinal) {
  const buf = buildXlsx(rows);
  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'lote-rbacoff.xlsx');
  fd.append('dt_inicial', dtInicial); fd.append('dt_final', dtFinal);
  const r = await fetch(`${BASE}/upload`, { method: 'POST', headers: { Cookie: cookieHeader(jar) }, body: fd });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function main() {
  const senha = process.argv[2]; const empresaTeste = Number(process.argv[3]);
  let jar = await loginHub('envio-massa-leitura@example.test', senha);
  jar = await trocarEntidade(jar, empresaTeste);
  const r = await uploadXlsx(jar, [{ number: '11999990000', cnpj_tomador: '11.222.333/0001-81', nome: 'Motorista RBACoff', valor: '10,00', cnpj_prestador: '99888777000107', enviado: 'on' }], '01/07/2026', '31/07/2026');
  console.log('___RESULT_JSON___' + JSON.stringify({ status: r.status, success: r.body && r.body.success }));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
RESULT_C5="$(echo "$OUT_C5" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
STATUS_C5="$(printf '%s' "$RESULT_C5" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d.status))" 2>/dev/null)"
check "HUB_RBAC_ENVIO=off: papel leitura POST /upload -> 200 (bloqueio revertido instantaneamente)" "$STATUS_C5" "200"

# 6.2.1/6.2.2 — mocks n8n/fastapi permanecem vazios durante TODA a execução
# (ver achado de segurança no cabeçalho: os caminhos perigosos nunca foram
# alcançados por construção do cenário, não porque uma env var os desviou).
N8N_LOG_LEN="$(dc exec -T n8n-mock wget -qO- http://localhost:8080/_log 2>/dev/null | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d.length))" 2>/dev/null)"
FASTAPI_LOG_LEN="$(dc exec -T fastapi-mock wget -qO- http://localhost:8080/_log 2>/dev/null | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d.length))" 2>/dev/null)"
check "n8n-mock: zero chamadas recebidas (sendMessage não usa n8n — achado de segurança)" "${N8N_LOG_LEN:-0}" "0"
check "fastapi-mock: zero chamadas recebidas (validate-xml-batch usou sem_movimento, nunca chamou FastAPI)" "${FASTAPI_LOG_LEN:-0}" "0"
echo "NOTA 6.2.1/6.2.2/6.2.3: ver cabeçalho deste script e relatório final da execução —"
echo "  os 'zero' acima NÃO comprovam que ENVIO_DRY_RUN gateia o código (ele não é lido"
echo "  em nenhum process.env de server.js); comprovam que o cenário de teste desta"
echo "  suíte foi desenhado para NUNCA alcançar sendMessage()/chamada real à FastAPI,"
echo "  em qualquer estado de HUB_RBAC_ENVIO. Achado registrado para decisão do"
echo "  orquestrador-pai — não marcar 6.2.1/6.2.2/6.2.3 como fechados sem essa leitura."

# Reverte as duas flags para o default (ausente = ligado) antes da suíte legada.
dc up -d --wait backend >"$TMP/recreate-restore.log" 2>&1
wait_backend || exit 1
unset HUB_RBAC_ENVIO HUB_IMPORT_LOG_ENVIO

# ─────────────────────────────────────────────────────────────────────────────
# 4.1.8 — falha simulada do PostgREST no INSERT do log (rename da tabela).
# Ambiente 100% descartável (hub-test-<runid>) — seguro fazer isso aqui.
# ─────────────────────────────────────────────────────────────────────────────
echo
echo "── 4.1.8 — falha simulada de INSERT do log (upload de negócio segue 200) ──"
psql_t -c 'ALTER TABLE "ImportacaoArquivo" RENAME TO "ImportacaoArquivo_tmp_disabled_e2e";' >/dev/null
OUT_FAILSIM="$(run_node "$SENHA_OK" "$E_TESTE" <<'JS'
const BASE = 'http://localhost:3000';
function parseSetCookie(res) { const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; const jar = {}; for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); } return jar; }
function cookieHeader(jar) { return Object.entries(jar || {}).map(([k, v]) => `${k}=${v}`).join('; '); }
async function loginHub(email, senha) { const r = await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) }); return parseSetCookie(r); }
async function trocarEntidade(jar, empresaId) { const r = await fetch(`${BASE}/api/v1/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaId }) }); return { ...jar, ...parseSetCookie(r) }; }
function buildXlsx(rows) { const XLSX = require('xlsx'); const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1'); return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); }
async function uploadXlsx(jar, rows, dtInicial, dtFinal) {
  const buf = buildXlsx(rows);
  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'lote-failsim.xlsx');
  fd.append('dt_inicial', dtInicial); fd.append('dt_final', dtFinal);
  const r = await fetch(`${BASE}/upload`, { method: 'POST', headers: { Cookie: cookieHeader(jar) }, body: fd });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function main() {
  const senha = process.argv[2]; const empresaTeste = Number(process.argv[3]);
  let jar = await loginHub('envio-massa-admin@example.test', senha);
  jar = await trocarEntidade(jar, empresaTeste);
  const r = await uploadXlsx(jar, [{ number: '11999990000', cnpj_tomador: '11.222.333/0001-81', nome: 'Motorista FailSim', valor: '10,00', cnpj_prestador: '99888777000108', enviado: 'on' }], '01/07/2026', '31/07/2026');
  console.log('___RESULT_JSON___' + JSON.stringify({ status: r.status, success: r.body && r.body.success }));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
RESULT_FAILSIM="$(echo "$OUT_FAILSIM" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
STATUS_FAILSIM="$(printf '%s' "$RESULT_FAILSIM" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d.status))" 2>/dev/null)"
check "INSERT do log falhando (tabela renomeada) -> upload de negócio ainda responde 200" "$STATUS_FAILSIM" "200"
psql_t -c 'ALTER TABLE "ImportacaoArquivo_tmp_disabled_e2e" RENAME TO "ImportacaoArquivo";' >/dev/null
N_IMPORT_POS_RESTORE="$(psql_t -tAc "SELECT count(*) FROM \"ImportacaoArquivo\" WHERE tipo='envio_massa' AND nome_arquivo='lote-failsim.xlsx'" | tr -d '[:space:]')"
check "após restaurar a tabela: nenhuma entrada 'lote-failsim.xlsx' (o INSERT realmente falhou, não foi só atrasado)" "$N_IMPORT_POS_RESTORE" "0"

# ─────────────────────────────────────────────────────────────────────────────
# 6.3.1 — suíte legada completa, 100% verde (exceto as 8 falhas pré-existentes
# de motorista-integration.test.js, já documentadas desde a FASE 2/3), e
# git diff confirmando zero alteração em arquivo de teste pré-existente.
# ─────────────────────────────────────────────────────────────────────────────
echo
echo "── 6.3.1 — suíte de testes legada (no HOST, node --test — mesma forma da"
echo "   baseline das FASES 2/3: 466 testes, 458 pass / 8 fail pré-existentes."
echo "   NÃO roda dentro do container backend: o mem_limit de 512m derruba"
echo "   hub-import-processor.test.js com SIGABRT/OOM, um artefato de ambiente"
echo "   que não existe na baseline nem em produção) ─────────────────────────"
(cd "$REPO_DIR/app_homologacao/backend" && npm test) >"$TMP/npm-test.log" 2>&1
NPM_TEST_EXIT=$?
tail -12 "$TMP/npm-test.log"
cp "$TMP/npm-test.log" "$EVID_DIR/npm-test-$(date -u +%Y%m%dT%H%M%SZ).log"
PASS_COUNT="$(grep -oE '# pass [0-9]+' "$TMP/npm-test.log" | tail -1 | grep -oE '[0-9]+')"
FAIL_COUNT="$(grep -oE '# fail [0-9]+' "$TMP/npm-test.log" | tail -1 | grep -oE '[0-9]+')"
echo "npm test: pass=$PASS_COUNT fail=$FAIL_COUNT (exit=$NPM_TEST_EXIT)"
# Guard complementar à baseline dinâmica: pass >= piso não detecta REMOÇÃO de
# suíte da lista `test` do package.json (testes novos compensariam) — conta os
# arquivos tests/* da lista e exige que nunca encolha (26 na S10).
# String(...) impede o node -p de colorizar o número com ANSI (quebraria o -ge)
N_SUITES_TEST="$(node -p "String(require('$REPO_DIR/app_homologacao/backend/package.json').scripts.test.split(/\s+/).filter(function (s) { return s.indexOf('tests/') === 0; }).length)")"
SUITES_OK="$([ "${N_SUITES_TEST:-0}" -ge 26 ] && echo ok || echo "encolheu:${N_SUITES_TEST:-?}")"
check "suíte legada: lista do npm test não encolheu (>= 26 arquivos)" "$SUITES_OK" "ok"
# Baseline dinâmica (correção S10): fases posteriores à S8 acrescentam testes
# novos ao `npm test` legado (na S8 eram 466/458; a S9 elevou para 539/531) —
# o invariante de regressão é "as ÚNICAS falhas são as 8 pré-existentes de
# motorista-integration.test.js", não um total fixo de pass.
PASS_MIN_OK="$([ "${PASS_COUNT:-0}" -ge 458 ] && echo ok || echo "regrediu:${PASS_COUNT:-?}")"
check "suíte legada: pass count >= 458 (baseline S8; suites novas só aumentam)" "$PASS_MIN_OK" "ok"
check "suíte legada: fail count = 8 (mesmas falhas pré-existentes de motorista-integration.test.js)" "${FAIL_COUNT:-?}" "8"

DIFF_ARQUIVOS_TESTE="$(cd "$REPO_DIR" && git diff --name-only main -- 'app_homologacao/backend/tests/*.test.js' | grep -v '^app_homologacao/backend/tests/hub-envio-massa-' || true)"
if [ -z "$DIFF_ARQUIVOS_TESTE" ]; then
  echo "PASS: git diff confirma zero alteração em arquivo de teste pré-existente (só suítes NOVAS hub-envio-massa-*.test.js)"
else
  echo "FAIL: arquivo(s) de teste pré-existente alterado(s):"
  echo "$DIFF_ARQUIVOS_TESTE"
  fails=$((fails + 1))
fi

echo
if [ "$fails" = "0" ]; then
  echo "HUB-ENVIO-MASSA-E2E: OK — todos os asserts passaram (FASE 6: 6.1.2-6.1.8/6.2.1-6.2.3/6.3.1, + 4.1.8)"
else
  echo "HUB-ENVIO-MASSA-E2E: $fails assert(s) FALHARAM" >&2
fi
echo "log completo salvo em: $RUN_LOG"
[ "$fails" = "0" ] && exit 0 || exit 1

#!/usr/bin/env bash
# =============================================================================
# hub-motorista-canonico-credencial-integration.sh — FASE 5 (WS-C Credencial)
# da feature hub-motorista-canonico: POST/PATCH .../credencial,
# .../credencial/reset-senha, .../credencial/reset-senha/definir
# (tasks.md 5.1/5.2/5.3) + login do app motorista via ContaMotorista
# (tasks.md 5.4, HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true), num projeto hub-test
# EFÊMERO (db+postgrest+backend). Nunca toca chatmasterveloz/produção nem o
# hub-homolog. Mesmo padrão de isolamento de
# infra/hub/testes/hub-motorista-canonico-cadastro-integration.sh (login +
# cookie jar via script Node único, `check()` para os asserts).
#
# Cobre:
#   (a) criação de credencial -> 201, sem a chave `senha` na resposta,
#       `senhaTemporaria` presente quando auto-gerada
#   (b) allowlist estrita (mandato S2) — `ativo`/`senhaInicial` fornecida no
#       body de criação: `ativo` do body é IGNORADO (resposta sempre
#       ativo=true); quando `senhaInicial` é fornecida, `senhaTemporaria`
#       NUNCA aparece na resposta (só quando auto-gerada)
#   (c) 409 credencial_existente — mesmo Entregador já tem credencial
#   (d) 409 credencial_existente — cnpj já vinculado a OUTRO Entregador
#   (e) 403 sem `motoristas.credencial` (usuário só com `motoristas.editar`)
#   (f) reset-senha invalida a senha anterior IMEDIATAMENTE (login
#       subsequente com a senha antiga falha) e emite `tokenDefinicao`
#   (g) token expirado (TTL manipulado direto no banco) -> 410 token_expirado
#   (h) token single-use -> segunda tentativa com o mesmo token -> 400
#       token_invalido
#   (i) PATCH ativar/desativar credencial NUNCA afeta `Entregador.ativo` e
#       vice-versa (FR-015/FR-018, independência)
#   (j) login do app motorista (HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true) nega
#       credencial desativada com 403, ANTES de qualquer sucesso
#   (k) bcrypt cost >= 12 (mandato S3) confirmado no hash persistido
#   (l) auditoria gravada para as 4 ações de credencial, SEM senha/token em
#       claro em nenhuma linha (mandato S4)
#
# Uso: infra/hub/testes/hub-motorista-canonico-credencial-integration.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)"
PROJECT="hub-test-$RUNID"
TMP="$(mktemp -d)"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
cleanup() { dc down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }

# tasks.md 5.4 — liga o gate de ambiente do login do app motorista via
# ContaMotorista SÓ neste projeto efêmero (compose.hub.test.yml
# HUB_MOTORISTA_LOGIN_CONTA_ATIVA:-, shell env tem precedência sobre
# --env-file na interpolação do compose). Nenhum outro compose (dev/homolog)
# referencia esta variável nesta fase.
export HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true

echo "subindo db+postgrest+backend efêmeros ($PROJECT, tmpfs, HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true)…"
dc up -d --wait db
dc up -d --wait postgrest
# Cap de memória obrigatório no build (RUNBOOK.md §Build do backend do hub —
# lição de starvation 2026-06-11): DOCKER_BUILDKIT=0 + --memory=2g.
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend (Dockerfile.hub)"; tail -60 "$TMP/build.log"; exit 1; }
dc up -d --wait backend

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
node_e() { dc exec -T backend node -e "$1" "${@:2}"; }
run_node() { dc exec -T backend node - "$@"; }

fails=0
check() { # check <descricao> <valor-obtido> <valor-esperado>
  if [ "$2" = "$3" ]; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 (obtido='$2' esperado='$3')"
    fails=$((fails + 1))
  fi
}

echo "rodando migrate.sh…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0045_conta_motorista_token_reset.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas por completo (0045 ausente)"; cat "$TMP/migrate.log"; exit 1; }

# --- Seed: 2 Usuarios (editor com motoristas.credencial; operador SEM) ------
SENHA_OK='SenhaSinteticaCredencial#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

E_TESTE=940301

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('credencial-editor@example.test', '$HASH_OK', 'Usuario Teste Credencial Editor', true),
  ('credencial-operador@example.test', '$HASH_OK', 'Usuario Teste Credencial Operador', true);
SQL
UID_EDITOR="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='credencial-editor@example.test'" | tr -d '[:space:]')"
UID_OPERADOR="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='credencial-operador@example.test'" | tr -d '[:space:]')"
PAPEL_ADMIN_ENTIDADE="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_entidade'" | tr -d '[:space:]')"
[ -n "$PAPEL_ADMIN_ENTIDADE" ] || { echo "FAIL: seed 0007 não populou o papel 'admin_entidade' esperado"; exit 1; }
PAPEL_OPERADOR="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='operador'" | tr -d '[:space:]')"
[ -n "$PAPEL_OPERADOR" ] || { echo "FAIL: seed 0007 não populou o papel 'operador' esperado"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_EDITOR, $E_TESTE, $PAPEL_ADMIN_ENTIDADE, true),
  ($UID_OPERADOR, $E_TESTE, $PAPEL_OPERADOR, true);
SQL

# --- Seed: 3 Entregadores no escopo da empresa de teste ---------------------
UUID_E1='aaaaaaaa-1111-1111-1111-111111111111'
UUID_E2='bbbbbbbb-2222-2222-2222-222222222222'
UUID_E3='cccccccc-3333-3333-3333-333333333333'
psql_t <<SQL >/dev/null
INSERT INTO "Entregador" (id_empresa, id_externo, nome, ativo) VALUES
  ($E_TESTE, '$UUID_E1', 'Fulano Credencial Um', true),
  ($E_TESTE, '$UUID_E2', 'Beltrano Credencial Dois', true),
  ($E_TESTE, '$UUID_E3', 'Ciclano Credencial Tres', true);
SQL
ID_E1="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_TESTE AND id_externo='$UUID_E1'" | tr -d '[:space:]')"
ID_E2="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_TESTE AND id_externo='$UUID_E2'" | tr -d '[:space:]')"
ID_E3="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_TESTE AND id_externo='$UUID_E3'" | tr -d '[:space:]')"
[ -n "$ID_E1" ] && [ -n "$ID_E2" ] && [ -n "$ID_E3" ] || { echo "FAIL: seed de Entregador não retornou ids"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
# Script Node único: login + troca de entidade + chamadas HTTP (rotas do hub
# em /api/v1/motoristas* e a rota legada /motorista/login).
# ─────────────────────────────────────────────────────────────────────────────
OUT="$(run_node "$SENHA_OK" "$E_TESTE" "$ID_E1" "$ID_E2" "$ID_E3" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
const APP_BASE = 'http://localhost:3000';

function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }

async function login(email, senha) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) });
  return parseSetCookie(r);
}
async function trocarEntidade(jar, empresaId) {
  const r = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaId }) });
  return { ...jar, ...parseSetCookie(r) };
}
async function getJson(jar, path) {
  const r = await fetch(`${BASE}${path}`, { headers: jar ? { Cookie: cookieHeader(jar) } : {} });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function postJson(jar, path, corpo) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(jar ? { Cookie: cookieHeader(jar) } : {}) },
    body: JSON.stringify(corpo),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function patchJson(jar, path, corpo) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(jar ? { Cookie: cookieHeader(jar) } : {}) },
    body: JSON.stringify(corpo),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function motoristaLogin(cnpjPrestador, senha) {
  const r = await fetch(`${APP_BASE}/motorista/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cnpjPrestador, senha }),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

async function main() {
  const senha = process.argv[2];
  const empresaTeste = Number(process.argv[3]);
  const idE1 = Number(process.argv[4]);
  const idE2 = Number(process.argv[5]);
  const idE3 = Number(process.argv[6]);
  const out = {};

  const CNPJ_1 = '11111111000100';
  const CNPJ_2 = '22222222000100';
  const CNPJ_3 = '33333333000100';

  let jarEditor = await login('credencial-editor@example.test', senha);
  jarEditor = await trocarEntidade(jarEditor, empresaTeste);
  let jarOperador = await login('credencial-operador@example.test', senha);
  jarOperador = await trocarEntidade(jarOperador, empresaTeste);

  // (e) 403 sem motoristas.credencial (operador só tem motoristas.editar)
  const rSemPerm = await postJson(jarOperador, `/motoristas/${idE3}/credencial`, { cnpjPrestador: CNPJ_3 });
  out.sem_perm_status = rSemPerm.status;
  out.sem_perm_erro = rSemPerm.body && rSemPerm.body.erro;

  // (a) criação com senha AUTO-gerada -> 201, senhaTemporaria presente, sem `senha`
  const rCriado1 = await postJson(jarEditor, `/motoristas/${idE1}/credencial`, { cnpjPrestador: CNPJ_1 });
  out.criado1_status = rCriado1.status;
  out.criado1_ativo = rCriado1.body && rCriado1.body.ativo;
  out.criado1_tem_senha_temp = !!(rCriado1.body && typeof rCriado1.body.senhaTemporaria === 'string' && rCriado1.body.senhaTemporaria.length > 0);
  out.criado1_sem_chave_senha = !(rCriado1.body && Object.prototype.hasOwnProperty.call(rCriado1.body, 'senha'));
  out.criado1_cnpj_mascarado = rCriado1.body && rCriado1.body.cnpjPrestador;
  const senhaTemp1 = rCriado1.body && rCriado1.body.senhaTemporaria;

  // (b) allowlist — ativo:false no body é ignorado; senhaInicial fornecida -> SEM senhaTemporaria na resposta
  const SENHA_EXPLICITA_2 = 'SenhaExplicitaCredencial1';
  const rCriado2 = await postJson(jarEditor, `/motoristas/${idE2}/credencial`, {
    cnpjPrestador: CNPJ_2, senhaInicial: SENHA_EXPLICITA_2, ativo: false,
  });
  out.criado2_status = rCriado2.status;
  out.criado2_ativo = rCriado2.body && rCriado2.body.ativo;
  out.criado2_sem_senha_temp = !(rCriado2.body && Object.prototype.hasOwnProperty.call(rCriado2.body, 'senhaTemporaria'));

  // (c) 409 credencial_existente — mesmo Entregador já tem credencial
  const rDuplicadoMesmo = await postJson(jarEditor, `/motoristas/${idE1}/credencial`, { cnpjPrestador: CNPJ_1 });
  out.dup_mesmo_status = rDuplicadoMesmo.status;
  out.dup_mesmo_erro = rDuplicadoMesmo.body && rDuplicadoMesmo.body.erro;

  // (d) 409 credencial_existente — cnpj já vinculado a OUTRO Entregador (idE3, ainda sem vínculo)
  const rDuplicadoOutro = await postJson(jarEditor, `/motoristas/${idE3}/credencial`, { cnpjPrestador: CNPJ_1 });
  out.dup_outro_status = rDuplicadoOutro.status;
  out.dup_outro_erro = rDuplicadoOutro.body && rDuplicadoOutro.body.erro;

  // (f) reset-senha: invalida a senha atual IMEDIATAMENTE + emite tokenDefinicao
  const rReset1 = await postJson(jarEditor, `/motoristas/${idE1}/credencial/reset-senha`, {});
  out.reset1_status = rReset1.status;
  out.reset1_ok = rReset1.body && rReset1.body.ok;
  const token1 = rReset1.body && rReset1.body.tokenDefinicao;
  out.reset1_tem_token = typeof token1 === 'string' && token1.length > 0;

  // login com a senha ANTIGA (auto-gerada em (a)) -> deve FALHAR (401), pois
  // a senha já foi zerada pelo reset acima.
  const rLoginSenhaAntiga = await motoristaLogin(CNPJ_1, senhaTemp1);
  out.login_senha_antiga_status = rLoginSenhaAntiga.status;

  // (g) token expirado: SQL abaixo (fora deste script Node) vai manipular
  // token_reset_expira para o passado; aqui só devolvemos token1 para o bash
  // usar depois.
  out.token1_para_expirar = token1;

  console.log('___RESULT_JSON_PARTE1___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT" | grep -v '___RESULT_JSON_PARTE1___' || true
RESULT_LINE_1="$(echo "$OUT" | grep '___RESULT_JSON_PARTE1___' | sed 's/^___RESULT_JSON_PARTE1___//')"
[ -n "$RESULT_LINE_1" ] || { echo "FAIL: script Node (parte 1) não retornou resultado"; echo "$OUT"; exit 1; }
jget1() { printf '%s' "$RESULT_LINE_1" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const v=d['$1']; process.stdout.write(v===null?'null':v===undefined?'undefined':String(v))"; }

check "(e) POST .../credencial sem motoristas.credencial -> 403" "$(jget1 sem_perm_status)" "403"
check "(e) POST .../credencial sem motoristas.credencial -> PERMISSAO_NEGADA" "$(jget1 sem_perm_erro)" "PERMISSAO_NEGADA"

check "(a) criação (senha auto-gerada) -> 201" "$(jget1 criado1_status)" "201"
check "(a) criação -> ativo=true" "$(jget1 criado1_ativo)" "true"
check "(a) criação -> senhaTemporaria presente (auto-gerada)" "$(jget1 criado1_tem_senha_temp)" "true"
check "(a) criação -> resposta NUNCA inclui a chave 'senha'" "$(jget1 criado1_sem_chave_senha)" "true"

check "(b) criação com senhaInicial + ativo:false no body -> 201" "$(jget1 criado2_status)" "201"
check "(b) allowlist — ativo:false do body é IGNORADO, resposta sempre ativo=true" "$(jget1 criado2_ativo)" "true"
check "(b) allowlist — senhaInicial fornecida -> resposta SEM senhaTemporaria" "$(jget1 criado2_sem_senha_temp)" "true"

check "(c) 409 credencial_existente — mesmo Entregador" "$(jget1 dup_mesmo_status)" "409"
check "(c) 409 — erro credencial_existente" "$(jget1 dup_mesmo_erro)" "credencial_existente"

check "(d) 409 credencial_existente — cnpj vinculado a OUTRO Entregador" "$(jget1 dup_outro_status)" "409"
check "(d) 409 — erro credencial_existente" "$(jget1 dup_outro_erro)" "credencial_existente"

check "(f) reset-senha -> 200" "$(jget1 reset1_status)" "200"
check "(f) reset-senha -> ok:true" "$(jget1 reset1_ok)" "true"
check "(f) reset-senha -> tokenDefinicao presente" "$(jget1 reset1_tem_token)" "true"
check "(f) login com senha ANTIGA após reset -> 401 (senha invalidada imediatamente)" "$(jget1 login_senha_antiga_status)" "401"

TOKEN_1="$(jget1 token1_para_expirar)"
[ -n "$TOKEN_1" ] && [ "$TOKEN_1" != "null" ] || { echo "FAIL: token1 ausente — não é possível prosseguir para o teste de expiração"; exit 1; }

# --- (g) token expirado: manipula token_reset_expira direto no banco -------
CNPJ_1='11111111000100'
psql_t -c "UPDATE \"ContaMotorista\" SET token_reset_expira = now() - interval '1 hour' WHERE cnpj_prestador='$CNPJ_1'" >/dev/null

OUT2="$(run_node "$SENHA_OK" "$E_TESTE" "$ID_E1" "$ID_E2" "$TOKEN_1" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
const APP_BASE = 'http://localhost:3000';

function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }
async function login(email, senha) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) });
  return parseSetCookie(r);
}
async function trocarEntidade(jar, empresaId) {
  const r = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaId }) });
  return { ...jar, ...parseSetCookie(r) };
}
async function postJson(jar, path, corpo) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(jar ? { Cookie: cookieHeader(jar) } : {}) },
    body: JSON.stringify(corpo),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function patchJson(jar, path, corpo) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(jar ? { Cookie: cookieHeader(jar) } : {}) },
    body: JSON.stringify(corpo),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function motoristaLogin(cnpjPrestador, senha) {
  const r = await fetch(`${APP_BASE}/motorista/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cnpjPrestador, senha }),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

async function main() {
  const senha = process.argv[2];
  const empresaTeste = Number(process.argv[3]);
  const idE1 = Number(process.argv[4]);
  const idE2 = Number(process.argv[5]);
  const tokenExpirado = process.argv[6];
  const out = {};

  const CNPJ_1 = '11111111000100';

  let jarEditor = await login('credencial-editor@example.test', senha);
  jarEditor = await trocarEntidade(jarEditor, empresaTeste);

  // (g) token expirado -> 410
  const rDefinirExpirado = await postJson(jarEditor, `/motoristas/${idE1}/credencial/reset-senha/definir`, {
    token: tokenExpirado, novaSenha: 'NovaSenhaQualquer1',
  });
  out.definir_expirado_status = rDefinirExpirado.status;
  out.definir_expirado_erro = rDefinirExpirado.body && rDefinirExpirado.body.erro;

  // token bruto/hash inválido (nunca existiu) -> 400
  const rDefinirInvalido = await postJson(jarEditor, `/motoristas/${idE1}/credencial/reset-senha/definir`, {
    token: 'token-que-nunca-existiu-0000', novaSenha: 'NovaSenhaQualquer1',
  });
  out.definir_invalido_status = rDefinirInvalido.status;
  out.definir_invalido_erro = rDefinirInvalido.body && rDefinirInvalido.body.erro;

  // (h) token single-use: gera um token NOVO (válido) e consome 2x
  const rReset2 = await postJson(jarEditor, `/motoristas/${idE1}/credencial/reset-senha`, {});
  const token2 = rReset2.body && rReset2.body.tokenDefinicao;
  const SENHA_FINAL = 'SenhaFinalCredencial1';

  const rDefinir1 = await postJson(jarEditor, `/motoristas/${idE1}/credencial/reset-senha/definir`, {
    token: token2, novaSenha: SENHA_FINAL,
  });
  out.definir1_status = rDefinir1.status;
  out.definir1_ok = rDefinir1.body && rDefinir1.body.ok;

  const rDefinir2 = await postJson(jarEditor, `/motoristas/${idE1}/credencial/reset-senha/definir`, {
    token: token2, novaSenha: 'OutraSenhaQualquer1',
  });
  out.definir2_status = rDefinir2.status;
  out.definir2_erro = rDefinir2.body && rDefinir2.body.erro;

  // Confirma end-to-end: login com a senha FINAL definida funciona (credencial
  // ainda ativa neste ponto).
  const rLoginFinal = await motoristaLogin(CNPJ_1, SENHA_FINAL);
  out.login_final_status = rLoginFinal.status;

  // (i) PATCH ativar/desativar credencial — independência de Entregador.ativo
  const rPatchCredDesativa = await patchJson(jarEditor, `/motoristas/${idE1}/credencial`, { ativo: false });
  out.patch_cred_status = rPatchCredDesativa.status;
  out.patch_cred_ativo = rPatchCredDesativa.body && rPatchCredDesativa.body.ativo;

  // (j) login negado com credencial desativada -> 403 ANTES de qualquer sucesso
  const rLoginDesativado = await motoristaLogin(CNPJ_1, SENHA_FINAL);
  out.login_desativado_status = rLoginDesativado.status;
  out.login_desativado_erro = rLoginDesativado.body && rLoginDesativado.body.error;

  // GET /motoristas/:id (existente) — Entregador.ativo permanece true (PATCH
  // .../credencial nunca toca Entregador).
  const rDetalheE1 = await fetch(`${BASE}/motoristas/${idE1}`, { headers: { Cookie: cookieHeader(jarEditor) } });
  const detalheE1 = await rDetalheE1.json();
  out.entregador1_ativo_apos_desativar_credencial = detalheE1.ativo;

  // Independência reversa: desativar o Entregador2 (via rota já existente)
  // NÃO deve mexer em ContaMotorista.ativo — verificado por psql fora deste
  // script (a rota de credencial não expõe GET, só psql confirma).
  const rPatchEntregador2 = await patchJson(jarEditor, `/motoristas/${idE2}`, { ativo: false });
  out.patch_entregador2_status = rPatchEntregador2.status;
  out.patch_entregador2_ativo = rPatchEntregador2.body && rPatchEntregador2.body.ativo;

  console.log('___RESULT_JSON_PARTE2___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT2" | grep -v '___RESULT_JSON_PARTE2___' || true
RESULT_LINE_2="$(echo "$OUT2" | grep '___RESULT_JSON_PARTE2___' | sed 's/^___RESULT_JSON_PARTE2___//')"
[ -n "$RESULT_LINE_2" ] || { echo "FAIL: script Node (parte 2) não retornou resultado"; echo "$OUT2"; exit 1; }
jget2() { printf '%s' "$RESULT_LINE_2" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const v=d['$1']; process.stdout.write(v===null?'null':v===undefined?'undefined':String(v))"; }

check "(g) definir com token EXPIRADO -> 410" "$(jget2 definir_expirado_status)" "410"
check "(g) definir com token EXPIRADO -> erro token_expirado" "$(jget2 definir_expirado_erro)" "token_expirado"
check "definir com token que nunca existiu -> 400" "$(jget2 definir_invalido_status)" "400"
check "definir com token que nunca existiu -> erro token_invalido" "$(jget2 definir_invalido_erro)" "token_invalido"

check "(h) definir (1a vez, token novo) -> 200" "$(jget2 definir1_status)" "200"
check "(h) definir (1a vez) -> ok:true" "$(jget2 definir1_ok)" "true"
check "(h) definir (2a vez, MESMO token) -> 400 (single-use)" "$(jget2 definir2_status)" "400"
check "(h) definir (2a vez) -> erro token_invalido" "$(jget2 definir2_erro)" "token_invalido"

check "login com a senha FINAL definida -> 200 (credencial ainda ativa)" "$(jget2 login_final_status)" "200"

check "(i) PATCH .../credencial ativo:false -> 200" "$(jget2 patch_cred_status)" "200"
check "(i) PATCH .../credencial -> ativo=false na resposta" "$(jget2 patch_cred_ativo)" "false"
check "(i) Entregador.ativo permanece true após desativar a CREDENCIAL (independência FR-015/018)" "$(jget2 entregador1_ativo_apos_desativar_credencial)" "true"

check "(j) login com credencial DESATIVADA -> 403" "$(jget2 login_desativado_status)" "403"
check "(j) login com credencial DESATIVADA -> mensagem idêntica ao legado" "$(jget2 login_desativado_erro)" "Conta inativa. Entre em contato com o suporte."

check "PATCH /motoristas/:id (Entregador2) ativo:false -> 200" "$(jget2 patch_entregador2_status)" "200"
check "PATCH Entregador2 -> ativo=false na resposta" "$(jget2 patch_entregador2_ativo)" "false"

# --- (i-reverso) independência: ContaMotorista de E2 permanece ativa=true ---
CONTA_E2_ATIVO="$(psql_t -tAc "SELECT cm.ativo FROM \"ContaMotorista\" cm JOIN \"Entregador\" e ON e.motorista_id = cm.id WHERE e.id = $ID_E2" | tr -d '[:space:]')"
check "(i-reverso) ContaMotorista de E2 permanece ativo=true após desativar o ENTREGADOR (independência)" "$CONTA_E2_ATIVO" "t"

# --- (k) bcrypt cost >= 12 (mandato S3) -------------------------------------
HASH_E2="$(psql_t -tAc "SELECT senha FROM \"ContaMotorista\" cm JOIN \"Entregador\" e ON e.motorista_id = cm.id WHERE e.id = $ID_E2" | tr -d '[:space:]')"
case "$HASH_E2" in
  '$2b$12$'*) BCRYPT_COST_OK=yes ;;
  *) BCRYPT_COST_OK=no ;;
esac
check "(k) bcrypt cost=12 confirmado no hash persistido (mandato S3, hash='$HASH_E2')" "$BCRYPT_COST_OK" "yes"

# --- (l) auditoria: 4 ações de credencial gravadas, sem segredo em claro ---
AUD_CRIADA="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE id_empresa=$E_TESTE AND acao='motorista.credencial_criada'" | tr -d '[:space:]')"
AUD_RESET="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE id_empresa=$E_TESTE AND acao='motorista.credencial_reset_iniciado'" | tr -d '[:space:]')"
AUD_DEFINIDA="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE id_empresa=$E_TESTE AND acao='motorista.credencial_senha_definida'" | tr -d '[:space:]')"
AUD_SITUACAO="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE id_empresa=$E_TESTE AND acao='motorista.credencial_situacao_alterada'" | tr -d '[:space:]')"
check "auditoria: motorista.credencial_criada registrada (>=2 eventos)" "$([ "${AUD_CRIADA:-0}" -ge 2 ] && echo yes || echo no)" "yes"
check "auditoria: motorista.credencial_reset_iniciado registrada (>=2 eventos)" "$([ "${AUD_RESET:-0}" -ge 2 ] && echo yes || echo no)" "yes"
check "auditoria: motorista.credencial_senha_definida registrada (>=1 evento)" "$([ "${AUD_DEFINIDA:-0}" -ge 1 ] && echo yes || echo no)" "yes"
check "auditoria: motorista.credencial_situacao_alterada registrada (>=1 evento)" "$([ "${AUD_SITUACAO:-0}" -ge 1 ] && echo yes || echo no)" "yes"

# Nenhum segredo (senhas/tokens conhecidos deste teste) aparece EM CLARO em
# `detalhes` de nenhuma linha de Auditoria desta empresa (mandato S4 —
# defesa em profundidade além do scrub automático de lib/hub-auditoria.js).
SEGREDOS_VAZADOS="$(psql_t -tAc "
  SELECT count(*) FROM \"Auditoria\"
  WHERE id_empresa=$E_TESTE
    AND acao LIKE 'motorista.credencial_%'
    AND (
      detalhes::text LIKE '%SenhaFinalCredencial1%'
      OR detalhes::text LIKE '%SenhaExplicitaCredencial1%'
      OR detalhes::text LIKE '%NovaSenhaQualquer1%'
      OR detalhes::text LIKE '%$TOKEN_1%'
    )
" | tr -d '[:space:]')"
check "auditoria: NENHUMA linha de credencial vaza senha/token em claro (mandato S4)" "${SEGREDOS_VAZADOS:-1}" "0"

echo
if [ "$fails" = "0" ]; then
  echo "HUB-MOTORISTA-CANONICO-CREDENCIAL-INTEGRATION: OK — todos os asserts passaram (FASE 5/credencial)"
  exit 0
else
  echo "HUB-MOTORISTA-CANONICO-CREDENCIAL-INTEGRATION: $fails assert(s) FALHARAM" >&2
  exit 1
fi

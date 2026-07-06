#!/usr/bin/env bash
# =============================================================================
# hub-e2e-homolog.sh — task 6.3 (tasks.md FASE 6): E2E REAL contra o ambiente
# hub-homolog ISOLADO E PERSISTENTE (não tmpfs, não efêmero — diferente das
# suítes hub-{auth,rbac,rls,auditoria}-integration.sh que sobem/derrubam um
# projeto hub-test-<runid> descartável). Cobre quickstart.md Scenarios
# 1/3/4/5/6/7/8/9 (subtasks 6.3.1-6.3.4).
#
# ISOLAMENTO: preflight.sh (allowlist hub-*/hub_*, blocklist de produção) +
# checagem de hostname/projeto ANTES de qualquer escrita — mesma disciplina
# das demais suítes. Toda linha de dado criada usa e-mails/CNPJs/empresa_ids
# marcados `e2e-teste-*` para fácil auditoria e cleanup.
#
# LIMPEZA: ao final (sucesso OU falha), remove EXPLICITAMENTE apenas as linhas
# e2e-teste-* criadas por esta execução via superuser do banco do hub
# (HUB_DB_USER é o *owner* das tabelas — não sofre o REVOKE UPDATE/DELETE
# aplicado só ao role `authenticated` do PostgREST, 0004_auditoria.sql). O
# ambiente hub-homolog NUNCA é derrubado (`down`) por este script — é
# persistente por design (RUNBOOK.md).
#
# Cobre:
#   6.3.1 login -> me -> troca de entidade (US1/US2, Scenarios 1 e 5)
#   6.3.2 troca de senha (recuperar+redefinir) revoga TODAS as sessões
#         (US3, Scenario 8, com 2 sessões ativas simultâneas)
#   6.3.3 5 falhas consecutivas bloqueiam 15 min (US4, Scenario 3) — o tempo de
#         espera é comprimido ajustando `bloqueado_ate` via SQL direto no
#         banco DO HUB (não real 15 min); decisão registrada no state.json
#         da feature (dec-060), não neste script.
#   6.3.4 RLS cross-entidade real via PostgREST direto (Scenario 9, mesmo
#         padrão de hub-rls-integration.sh, mas contra hub-homolog)
#
# Uso: infra/hub/testes/hub-e2e-homolog.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_HOMOLOG_ENV:-/var/lib/hub_secrets/.env.hub.homolog}"
COMPOSE="$HUB_DIR/compose.hub.homolog.yml"
PROJECT="hub-homolog"
TMP="$(mktemp -d)"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }

# --- Sanidade de escopo: hostname + projeto (defesa em profundidade, além do
# preflight) — aborta se algo indicar que estamos fora do hub-homolog. -------
if [ "$(hostname)" != "VPSTodo" ]; then
  echo "ABORTADO: host inesperado '$(hostname)' (esperado VPSTodo)" >&2
  exit 2
fi

cleanup_rows() {
  echo
  echo "=== cleanup: removendo linhas e2e-teste-* (superuser $DB_USER, owner bypassa RLS) ==="
  # Auditoria é imutável por TRIGGER incondicional (0004_auditoria.sql,
  # hub_bloqueia_alteracao_auditoria — bloqueia UPDATE/DELETE mesmo para o
  # DONO da tabela, por design/FR-024). `session_replication_role = replica`
  # (exige superuser, que HUB_DB_USER É — confirmado rolsuper=t) faz o backend
  # do Postgres pular triggers de origem só NESTA sessão psql, sem alterar a
  # definição do trigger nem afetar qualquer outra sessão/role — decisão
  # registrada via state-decisions.sh (dec-061) por ser a única forma de
  # limpar dados sintéticos e2e-teste-* de uma tabela deliberadamente
  # imutável, restrita ao ambiente hub-homolog isolado.
  dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" <<'SQL'
SET session_replication_role = replica;
DELETE FROM "Auditoria"
  WHERE usuario_id IN (SELECT id FROM "Usuario" WHERE email LIKE 'e2e-teste-%')
     OR (detalhes->>'email') LIKE 'e2e-teste-%';
DELETE FROM "SessaoRefresh"
  WHERE usuario_id IN (SELECT id FROM "Usuario" WHERE email LIKE 'e2e-teste-%');
DELETE FROM "UsuarioEntidade"
  WHERE usuario_id IN (SELECT id FROM "Usuario" WHERE email LIKE 'e2e-teste-%');
DELETE FROM "Usuario" WHERE email LIKE 'e2e-teste-%';
SQL
  echo "=== cleanup: concluído ==="
  rm -rf "$TMP"
}
trap cleanup_rows EXIT

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }

echo "garantindo mailpit-mock + backend no ar (idempotente, ambiente PERSISTENTE)…"
dc up -d --wait mailpit-mock
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend (Dockerfile.hub)"; tail -60 "$TMP/build.log"; exit 1; }
dc up -d --wait backend

echo "rodando migrate.sh (idempotente, até 0008)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0008_migracao_empresa_para_usuario.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas"; cat "$TMP/migrate.log"; exit 1; }

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

PAPEL_OPERADOR="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='operador'" | tr -d '[:space:]')"
[ -n "$PAPEL_OPERADOR" ] || { echo "FAIL: seed 0007 não populou o papel 'operador'"; exit 1; }

# empresa_ids sintéticos, faixa exclusiva desta suíte (fora de 91xxxx/92xxxx
# já usadas por hub-rbac/hub-rls-integration.sh, embora sejam projetos
# distintos — reserva própria só por clareza de auditoria).
E_A=940001
E_B=940002

# =============================================================================
# 6.3.1 — login -> me -> troca de entidade (Scenarios 1 e 5)
# =============================================================================
echo
echo "### 6.3.1 — login -> me -> troca de entidade ###"

SENHA_OK='SenhaSinteticaE2eHomolog#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('e2e-teste-login@example.test', '$HASH_OK', 'E2E Login Troca Entidade', true);
SQL
UID_LOGIN="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='e2e-teste-login@example.test'" | tr -d '[:space:]')"
[ -n "$UID_LOGIN" ] || { echo "FAIL: seed de Usuario (6.3.1) falhou"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_LOGIN, $E_A, $PAPEL_OPERADOR, true),
  ($UID_LOGIN, $E_B, $PAPEL_OPERADOR, true);
SQL

OUT1="$(run_node "$SENHA_OK" "$E_A" "$E_B" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }

async function main() {
  const senhaOk = process.argv[2];
  const empresaA = Number(process.argv[3]);
  const empresaB = Number(process.argv[4]);
  const out = {};

  const rLogin = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'e2e-teste-login@example.test', senha: senhaOk }) });
  const bLogin = await rLogin.json();
  let jar = parseSetCookie(rLogin);
  out.login_status = rLogin.status;
  out.login_email = bLogin.usuario && bLogin.usuario.email;

  const rMe1 = await fetch(`${BASE}/me`, { headers: { Cookie: cookieHeader(jar) } });
  const bMe1 = await rMe1.json();
  out.me1_status = rMe1.status;
  out.me1_n_entidades = Array.isArray(bMe1.entidades) ? bMe1.entidades.length : -1;
  out.me1_entidade_ativa = bMe1.entidade_ativa === null ? 'null' : String(bMe1.entidade_ativa);

  const rTroca = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaA }) });
  const bTroca = await rTroca.json();
  out.troca_status = rTroca.status;
  out.troca_entidade_ativa = bTroca.entidade_ativa;
  jar = { ...jar, ...parseSetCookie(rTroca) };

  const rMe2 = await fetch(`${BASE}/me`, { headers: { Cookie: cookieHeader(jar) } });
  const bMe2 = await rMe2.json();
  out.me2_entidade_ativa = bMe2.entidade_ativa;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT1" | grep -v '___RESULT_JSON___' || true
R1="$(echo "$OUT1" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R1" ] || { echo "FAIL: script Node (6.3.1) não retornou resultado"; echo "$OUT1"; exit 1; }
jget1() { printf '%s' "$R1" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d['$1']))"; }

check "6.3.1 login -> 200" "$(jget1 login_status)" "200"
check "6.3.1 login: e-mail correto no corpo" "$(jget1 login_email)" "e2e-teste-login@example.test"
check "6.3.1 GET /me -> 200" "$(jget1 me1_status)" "200"
check "6.3.1 GET /me: 2 entidades vinculadas" "$(jget1 me1_n_entidades)" "2"
check "6.3.1 GET /me: entidade_ativa=null antes da troca" "$(jget1 me1_entidade_ativa)" "null"
check "6.3.1 POST /me/entidade (A) -> 200" "$(jget1 troca_status)" "200"
check "6.3.1 POST /me/entidade: entidade_ativa=A no corpo" "$(jget1 troca_entidade_ativa)" "$E_A"
check "6.3.1 GET /me pós-troca: entidade_ativa=A refletida sem novo login" "$(jget1 me2_entidade_ativa)" "$E_A"

# =============================================================================
# 6.3.2 — troca de senha (recuperar+redefinir) revoga TODAS as sessões
# =============================================================================
echo
echo "### 6.3.2 — recuperar-senha + redefinir-senha revoga TODAS as sessões ###"

SENHA_ANTIGA='SenhaAntigaE2e#Homolog1'
SENHA_NOVA='SenhaNovaE2e#Homolog2'
HASH_ANTIGA="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_ANTIGA" 2>"$TMP/hash-gen2.log" | tr -d '[:space:]')"
[ -n "$HASH_ANTIGA" ] || { echo "FAIL: geração do hash bcrypt (6.3.2) falhou"; cat "$TMP/hash-gen2.log"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('e2e-teste-troca-senha@example.test', '$HASH_ANTIGA', 'E2E Troca Senha', true);
SQL

OUT2="$(run_node "$SENHA_ANTIGA" "$SENHA_NOVA" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }

async function main() {
  const senhaAntiga = process.argv[2];
  const senhaNova = process.argv[3];
  const out = {};

  // 2 sessões simultâneas (2 logins independentes) — prova que a redefinição
  // revoga TODAS, não só a corrente (FR-022/SC-007).
  const rLogin1 = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'e2e-teste-troca-senha@example.test', senha: senhaAntiga }) });
  const jar1 = parseSetCookie(rLogin1);
  out.login1_status = rLogin1.status;

  const rLogin2 = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'e2e-teste-troca-senha@example.test', senha: senhaAntiga }) });
  const jar2 = parseSetCookie(rLogin2);
  out.login2_status = rLogin2.status;

  const rRecuperar = await fetch(`${BASE}/auth/recuperar-senha`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'e2e-teste-troca-senha@example.test' }) });
  const bRecuperar = await rRecuperar.json();
  out.recuperar_status = rRecuperar.status;
  out.recuperar_ok = bRecuperar.ok;

  // resposta idêntica para e-mail inexistente (FR-020) — comparação de corpo
  const rRecuperarInexistente = await fetch(`${BASE}/auth/recuperar-senha`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'e2e-teste-nao-existe@example.test' }) });
  const bRecuperarInexistente = await rRecuperarInexistente.json();
  out.recuperar_bodies_iguais = JSON.stringify(bRecuperar) === JSON.stringify(bRecuperarInexistente) ? 'true' : 'false';

  // token entregue via mock mailpit
  const rLog = await fetch('http://mailpit-mock:8080/_log?to=e2e-teste-troca-senha@example.test');
  const bLog = await rLog.json();
  const ultimo = bLog[bLog.length - 1];
  const m = ultimo && ultimo.text ? ultimo.text.match(/token para redefinir sua senha: ([0-9a-f]+)/) : null;
  const token = m ? m[1] : null;
  out.token_capturado = token ? 'true' : 'false';

  const rRedefinir = await fetch(`${BASE}/auth/redefinir-senha`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, nova_senha: senhaNova }) });
  const bRedefinir = await rRedefinir.json();
  out.redefinir_status = rRedefinir.status;
  out.redefinir_ok = bRedefinir.ok;

  // reuso do MESMO token -> 400 TOKEN_INVALIDO (single-use; token_recuperacao_hash
  // já foi zerado no PATCH acima, então a 2ª tentativa não encontra a linha por
  // hash e cai no ramo "token inexistente" -> 400, não 410 "expirado". Mesmo
  // comportamento já estabelecido e testado em FASE 3, ver
  // hub-auth-integration.sh linha ~268 "reuso do token de recuperação
  // (single-use) -> 400"; quickstart.md Scenario 8 usa a palavra "expirado"
  // de forma imprecisa — o código real (e o teste de FASE 3) usam 400.
  const rRedefinirReuso = await fetch(`${BASE}/auth/redefinir-senha`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, nova_senha: senhaNova }) });
  out.redefinir_reuso_status = rRedefinirReuso.status;

  // login com senha antiga falha
  const rLoginAntiga = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'e2e-teste-troca-senha@example.test', senha: senhaAntiga }) });
  out.login_senha_antiga_status = rLoginAntiga.status;

  // login com senha NOVA funciona
  const rLoginNova = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'e2e-teste-troca-senha@example.test', senha: senhaNova }) });
  out.login_senha_nova_status = rLoginNova.status;

  // AMBOS refreshTokens das 2 sessões anteriores devem estar revogados
  const rRefresh1 = await fetch(`${BASE}/auth/refresh`, { method: 'POST', headers: { Cookie: cookieHeader(jar1) } });
  out.refresh_sessao1_status = rRefresh1.status;
  const rRefresh2 = await fetch(`${BASE}/auth/refresh`, { method: 'POST', headers: { Cookie: cookieHeader(jar2) } });
  out.refresh_sessao2_status = rRefresh2.status;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT2" | grep -v '___RESULT_JSON___' || true
R2="$(echo "$OUT2" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R2" ] || { echo "FAIL: script Node (6.3.2) não retornou resultado"; echo "$OUT2"; exit 1; }
jget2() { printf '%s' "$R2" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d['$1']))"; }

check "6.3.2 login sessão 1 -> 200" "$(jget2 login1_status)" "200"
check "6.3.2 login sessão 2 -> 200" "$(jget2 login2_status)" "200"
check "6.3.2 recuperar-senha (e-mail existente) -> 200" "$(jget2 recuperar_status)" "200"
check "6.3.2 recuperar-senha: ok=true" "$(jget2 recuperar_ok)" "true"
check "6.3.2 recuperar-senha: corpo IDÊNTICO p/ e-mail inexistente (FR-020)" "$(jget2 recuperar_bodies_iguais)" "true"
check "6.3.2 token de redefinição capturado via mailpit-mock" "$(jget2 token_capturado)" "true"
check "6.3.2 redefinir-senha -> 200" "$(jget2 redefinir_status)" "200"
check "6.3.2 redefinir-senha: ok=true" "$(jget2 redefinir_ok)" "true"
check "6.3.2 reuso do MESMO token -> 400 TOKEN_INVALIDO (single-use, paridade c/ FASE 3)" "$(jget2 redefinir_reuso_status)" "400"
check "6.3.2 login com senha ANTIGA falha -> 401" "$(jget2 login_senha_antiga_status)" "401"
check "6.3.2 login com senha NOVA funciona -> 200" "$(jget2 login_senha_nova_status)" "200"
check "6.3.2 refresh sessão 1 (pré-redefinição) revogado -> 401 (FR-022/SC-007)" "$(jget2 refresh_sessao1_status)" "401"
check "6.3.2 refresh sessão 2 (pré-redefinição) revogado -> 401 (TODAS as sessões)" "$(jget2 refresh_sessao2_status)" "401"

# =============================================================================
# 6.3.3 — 5 falhas consecutivas bloqueiam 15 min (compressão via SQL direto)
# =============================================================================
echo
echo "### 6.3.3 — 5 falhas consecutivas -> bloqueio 423 -> desbloqueio via SQL ###"

SENHA_BLOQUEIO='SenhaBloqueioE2e#Homolog3'
HASH_BLOQUEIO="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_BLOQUEIO" 2>"$TMP/hash-gen3.log" | tr -d '[:space:]')"
[ -n "$HASH_BLOQUEIO" ] || { echo "FAIL: geração do hash bcrypt (6.3.3) falhou"; cat "$TMP/hash-gen3.log"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('e2e-teste-bloqueio@example.test', '$HASH_BLOQUEIO', 'E2E Bloqueio', true);
SQL

OUT3="$(run_node "$SENHA_BLOQUEIO" <<'JS'
const BASE = 'http://localhost:3000/api/v1/auth';
async function main() {
  const senhaOk = process.argv[2];
  const out = {};
  const statuses = [];
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${BASE}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'e2e-teste-bloqueio@example.test', senha: 'senha-errada-' + i }) });
    statuses.push(r.status);
  }
  out.falhas_status = statuses.join(',');

  // 6ª tentativa, AGORA com a senha CORRETA -> deve ser 423 (bloqueada), não 200
  const r6 = await fetch(`${BASE}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'e2e-teste-bloqueio@example.test', senha: senhaOk }) });
  out.tentativa6_com_senha_certa_status = r6.status;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT3" | grep -v '___RESULT_JSON___' || true
R3="$(echo "$OUT3" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R3" ] || { echo "FAIL: script Node (6.3.3 fase 1) não retornou resultado"; echo "$OUT3"; exit 1; }
jget3() { printf '%s' "$R3" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d['$1']))"; }

check "6.3.3 5 falhas consecutivas -> todas 401" "$(jget3 falhas_status)" "401,401,401,401,401"
check "6.3.3 6ª tentativa (senha CORRETA) apos 5 falhas -> 423 CONTA_BLOQUEADA" "$(jget3 tentativa6_com_senha_certa_status)" "423"

# Compressão do tempo de espera (decisão registrada no state.json da feature,
# dec-060): ajusta bloqueado_ate para o passado via SQL direto, em vez de
# aguardar 15 min reais.
psql_t <<SQL >/dev/null
UPDATE "Usuario" SET bloqueado_ate = now() - interval '1 minute'
  WHERE email = 'e2e-teste-bloqueio@example.test';
SQL

ST_POS_DESBLOQUEIO="$(run_node "$SENHA_BLOQUEIO" <<'JS'
const BASE = 'http://localhost:3000/api/v1/auth';
async function main() {
  const senhaOk = process.argv[2];
  const r = await fetch(`${BASE}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'e2e-teste-bloqueio@example.test', senha: senhaOk }) });
  process.stdout.write(String(r.status));
}
main();
JS
)"
check "6.3.3 login correto aceito na 1ª tentativa após período de bloqueio expirado" "$ST_POS_DESBLOQUEIO" "200"

# =============================================================================
# 6.3.4 — RLS cross-entidade real via PostgREST direto (Scenario 9)
# =============================================================================
echo
echo "### 6.3.4 — RLS: token com claim da entidade A lendo dados da B -> 0 linhas ###"

UID_RLS="$UID_LOGIN" # reusa o usuário/entidades de 6.3.1 (E_A/E_B já vinculados)

psql_t <<SQL >/dev/null
INSERT INTO "Auditoria" (id_empresa, usuario_id, acao, recurso, detalhes, criado_em) VALUES
  ($E_A, $UID_RLS, 'evento_e2e_a', 'UsuarioEntidade', '{"origem":"e2e-teste-rls"}'::jsonb, now()),
  ($E_B, $UID_RLS, 'evento_e2e_b', 'UsuarioEntidade', '{"origem":"e2e-teste-rls"}'::jsonb, now());
SQL

OUT4="$(run_node "$UID_RLS" "$E_A" "$E_B" <<'JS'
const { generateHubPostgrestJWT } = require('./lib/hub-postgrest-jwt');

async function pg(jwt, path) {
  const r = await fetch(`http://postgrest:3000/${path}`, { headers: jwt ? { Authorization: `Bearer ${jwt}` } : {} });
  const status = r.status;
  const body = await r.json().catch(() => null);
  return { status, body };
}

async function main() {
  const uid = process.argv[2];
  const empresaA = Number(process.argv[3]);
  const empresaB = Number(process.argv[4]);
  const out = {};

  const jwtEscopoA = generateHubPostgrestJWT({ usuarioId: uid, empresaAtiva: empresaA, escopo: [empresaA] });

  const rB = await pg(jwtEscopoA, `Auditoria?id_empresa=eq.${empresaB}&acao=eq.evento_e2e_b`);
  out.cross_b_status = rB.status;
  out.cross_b_len = Array.isArray(rB.body) ? rB.body.length : -1;

  const rA = await pg(jwtEscopoA, `Auditoria?id_empresa=eq.${empresaA}&acao=eq.evento_e2e_a`);
  out.propria_a_status = rA.status;
  out.propria_a_len = Array.isArray(rA.body) ? rA.body.length : -1;
  out.propria_a_snake_case = rA.body && rA.body[0]
    ? Object.prototype.hasOwnProperty.call(rA.body[0], 'id_empresa') && Object.prototype.hasOwnProperty.call(rA.body[0], 'criado_em')
    : false;
  out.propria_a_criado_em_tipo = rA.body && rA.body[0] ? typeof rA.body[0].criado_em : 'ausente';
  out.propria_a_detalhes_tipo = rA.body && rA.body[0] ? typeof rA.body[0].detalhes : 'ausente';

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT4" | grep -v '___RESULT_JSON___' || true
R4="$(echo "$OUT4" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R4" ] || { echo "FAIL: script Node (6.3.4) não retornou resultado"; echo "$OUT4"; exit 1; }
jget4() { printf '%s' "$R4" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d['$1']))"; }

check "6.3.4 PostgREST direto (bypass app): status 200 mesmo pedindo B" "$(jget4 cross_b_status)" "200"
check "6.3.4 PostgREST direto: escopo=[A] lendo B -> 0 linhas (RLS nega, SC-008)" "$(jget4 cross_b_len)" "0"
check "6.3.4 PostgREST direto: escopo=[A] lendo A -> 200" "$(jget4 propria_a_status)" "200"
check "6.3.4 PostgREST direto: escopo=[A] lendo A -> 1 linha (uso legítimo preservado)" "$(jget4 propria_a_len)" "1"
check "6.3.4 shape snake_case (id_empresa/criado_em) — Convenção de Borda" "$(jget4 propria_a_snake_case)" "true"
check "6.3.4 criado_em é string ISO 8601" "$(jget4 propria_a_criado_em_tipo)" "string"
check "6.3.4 detalhes é objeto JSON" "$(jget4 propria_a_detalhes_tipo)" "object"

echo
if [ "$fails" = "0" ]; then
  echo "HUB-E2E-HOMOLOG: OK — todos os asserts passaram (FASE 6.3, quickstart Scenarios 1/3/4/5/6/7/8/9)"
else
  echo "HUB-E2E-HOMOLOG: $fails assert(s) FALHARAM" >&2
  exit 1
fi

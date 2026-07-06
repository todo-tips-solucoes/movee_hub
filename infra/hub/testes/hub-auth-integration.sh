#!/usr/bin/env bash
# =============================================================================
# hub-auth-integration.sh — task 3.1.6/3.2.3/3.3.6 (tasks.md FASE 3): prova E2E
# de /api/v1/auth/* contra um projeto hub-test EFÊMERO e descartável.
# Nunca toca chatmasterveloz/produção — mesmo padrão de isolamento de
# infra/hub/testes/migracao-login-integration.sh (task 2.1.5).
#
# 3 contas de teste ISOLADAS (cada uma com sua própria chave de rate-limit
# IP+e-mail) para que os vários cenários não disputem o mesmo balde do
# limitador (Decision 8/14: mesmo limiter em /login e /recuperar-senha, 10
# tentativas/15min por conta) — achado empírico da 1ª rodada desta suíte.
#
# Cobre:
#   (a) login com sucesso (cookies setados, corpo {usuario:{id,email,nome}})
#   (b) login com senha errada / e-mail inexistente — corpo IDÊNTICO (FR-015)
#   (c) 5 falhas consecutivas -> bloqueia; 6ª tentativa (nova, pós-bloqueio)
#       -> 423 CONTA_BLOQUEADA (FR-017: "bloquear NOVAS tentativas... após 5
#       falhas" — a 5ª falha em si ainda responde 401, ela é quem COMPLETA o
#       limiar; decisão auditável registrada nesta onda)
#   (d) refresh: rotação de token (hash antigo revogado, novo emitido)
#   (e) logout: revoga a sessão corrente (refresh revogado não renova)
#   (f) recuperar-senha: resposta idêntica p/ e-mail existente/inexistente (FR-020);
#       token entregue via mock mailpit (Decision 11)
#   (g) redefinir-senha: token válido troca a senha + revoga TODAS as sessões
#       (FR-022/SC-007); reuso do MESMO token (single-use) -> 400 TOKEN_INVALIDO
#   (h) Auditoria registra login_sucesso/login_falha/logout/recuperacao/redefinicao
#
# Uso: infra/hub/testes/hub-auth-integration.sh
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

echo "subindo db+postgrest+mailpit-mock+backend efêmeros ($PROJECT, tmpfs)…"
dc up -d --wait db
dc up -d --wait postgrest
dc up -d --wait mailpit-mock
# Cap de memória obrigatório no build (RUNBOOK.md §Build do backend do hub —
# lição de starvation 2026-06-11): DOCKER_BUILDKIT=0 + --memory=2g.
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend (Dockerfile.hub)"; tail -60 "$TMP/build.log"; exit 1; }
dc up -d --wait backend

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
node_e() { dc exec -T backend node -e "$1" "${@:2}"; } # node_e '<script>' arg1 arg2...

fails=0
check() { # check <descricao> <valor-obtido> <valor-esperado>
  if [ "$2" = "$3" ]; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 (obtido='$2' esperado='$3')"
    fails=$((fails + 1))
  fi
}

echo "rodando migrate.sh (0002..0008, INCLUSIVE 0006/RLS — FASE 5 já implementada)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0008_migracao_empresa_para_usuario.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas"; cat "$TMP/migrate.log"; exit 1; }

# --- Seed: 3 Usuarios ativos com senha conhecida (hash gerado pelo MESMO módulo
# bcrypt do backend hub — mesma lição de migracao-login-integration.sh: hash
# gerado por libs externas (htpasswd/openssl) usa prefixo incompatível) -------
SENHA_OK='SenhaSintetica#Auth1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('auth-teste@example.test', '$HASH_OK', 'Usuario Teste Auth', true),
  ('auth-bloqueio@example.test', '$HASH_OK', 'Usuario Teste Bloqueio', true),
  ('auth-recuperacao@example.test', '$HASH_OK', 'Usuario Teste Recuperacao', true);
SQL
UID_PRINCIPAL="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='auth-teste@example.test'" | tr -d '[:space:]')"
UID_BLOQUEIO="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='auth-bloqueio@example.test'" | tr -d '[:space:]')"
UID_RECUPERACAO="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='auth-recuperacao@example.test'" | tr -d '[:space:]')"

# ─────────────────────────────────────────────────────────────────────────────
# Cenário 1 — conta `auth-teste`: login/refresh/logout + anti-enumeração
# Script Node único (fetch nativo do Node 20) para stitching de cookies entre
# chamadas sem parsing manual entre processos `docker compose exec` separados.
# ─────────────────────────────────────────────────────────────────────────────
run_node() { dc exec -T backend node - "$@"; }

OUT="$(run_node "$SENHA_OK" <<'JS'
const BASE = 'http://localhost:3000/api/v1/auth';

function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    jar[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function main() {
  // `node - <args>` (script via stdin) desloca argv em 1 posição vs `node -e`:
  // process.argv = [node, '-', ...args] — achado empírico desta suíte.
  const senhaOk = process.argv[2];
  const out = {};

  const rWrong = await fetch(`${BASE}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'auth-teste@example.test', senha: 'senha-errada' }) });
  const bWrong = await rWrong.json();
  const rNoEmail = await fetch(`${BASE}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nao-existe@example.test', senha: 'qualquer' }) });
  const bNoEmail = await rNoEmail.json();
  out.login_wrong_status = rWrong.status;
  out.login_noemail_status = rNoEmail.status;
  out.login_bodies_iguais = JSON.stringify(bWrong) === JSON.stringify(bNoEmail) ? 'true' : 'false';

  const rOk = await fetch(`${BASE}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'auth-teste@example.test', senha: senhaOk }) });
  const bOk = await rOk.json();
  const jarOk = parseSetCookie(rOk);
  out.login_ok_status = rOk.status;
  out.login_ok_email = bOk && bOk.usuario && bOk.usuario.email;
  out.login_ok_tem_access = jarOk.accessToken ? 'true' : 'false';
  out.login_ok_tem_refresh = jarOk.refreshToken ? 'true' : 'false';

  const refreshBrutoOriginal = jarOk.refreshToken;

  const rRefresh = await fetch(`${BASE}/refresh`, { method: 'POST', headers: { Cookie: cookieHeader(jarOk) } });
  const jarRefresh = parseSetCookie(rRefresh);
  out.refresh_status = rRefresh.status;
  out.refresh_novo_token_diferente = jarRefresh.refreshToken && jarRefresh.refreshToken !== refreshBrutoOriginal ? 'true' : 'false';

  const rReplay = await fetch(`${BASE}/refresh`, { method: 'POST', headers: { Cookie: `refreshToken=${refreshBrutoOriginal}` } });
  out.refresh_replay_status = rReplay.status;

  const rLogout = await fetch(`${BASE}/logout`, { method: 'POST', headers: { Cookie: cookieHeader(jarRefresh) } });
  out.logout_status = rLogout.status;

  const rRefreshPosLogout = await fetch(`${BASE}/refresh`, { method: 'POST', headers: { Cookie: cookieHeader(jarRefresh) } });
  out.refresh_pos_logout_status = rRefreshPosLogout.status;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}

main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"

echo "$OUT" | grep -v '___RESULT_JSON___' || true
RESULT_LINE="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$RESULT_LINE" ] || { echo "FAIL: script Node (cenário 1) não retornou resultado"; echo "$OUT"; exit 1; }

jget() { printf '%s' "$RESULT_LINE" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d['$1']))"; }

check "login senha errada -> 401" "$(jget login_wrong_status)" "401"
check "login e-mail inexistente -> 401" "$(jget login_noemail_status)" "401"
check "FR-015: corpos idênticos (senha errada == email inexistente)" "$(jget login_bodies_iguais)" "true"
check "login correto -> 200" "$(jget login_ok_status)" "200"
check "login correto -> usuario.email correto" "$(jget login_ok_email)" "auth-teste@example.test"
check "login correto -> cookie accessToken setado" "$(jget login_ok_tem_access)" "true"
check "login correto -> cookie refreshToken setado" "$(jget login_ok_tem_refresh)" "true"
check "refresh -> 200" "$(jget refresh_status)" "200"
check "refresh -> rotaciona (novo token != antigo)" "$(jget refresh_novo_token_diferente)" "true"
check "replay de refresh já rotacionado -> 401 (Decision 9)" "$(jget refresh_replay_status)" "401"
check "logout -> 200" "$(jget logout_status)" "200"
check "refresh pós-logout -> 401 (sessão revogada não renova, FR-018)" "$(jget refresh_pos_logout_status)" "401"

N_LOGOUT_AUDIT="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE usuario_id=$UID_PRINCIPAL AND acao='logout'" | tr -d '[:space:]')"
check "Auditoria: evento 'logout' gravado com usuario_id correto" "$([ "${N_LOGOUT_AUDIT:-0}" -ge 1 ] 2>/dev/null && echo sim || echo nao)" "sim"

# ─────────────────────────────────────────────────────────────────────────────
# Cenário 2 — conta `auth-bloqueio`: 5 falhas consecutivas -> bloqueio (FR-017)
# Conta ISOLADA (rate-limit key própria) para não competir com o cenário 1.
# ─────────────────────────────────────────────────────────────────────────────
for i in 1 2 3 4 5; do
  ST="$(node_e "
    fetch('http://localhost:3000/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'auth-bloqueio@example.test', senha: 'senha-errada-loop' }) })
      .then(r => { process.stdout.write(String(r.status)); process.exit(0); });
  " | tr -d '[:space:]')"
  if [ "$i" = "5" ]; then
    check "5ª falha consecutiva (completa o limiar) -> 401" "$ST" "401"
  fi
done

BLOQUEADO_ATE="$(psql_t -tAc "SELECT bloqueado_ate IS NOT NULL FROM \"Usuario\" WHERE id = $UID_BLOQUEIO" | tr -d '[:space:]')"
check "bloqueado_ate setado no banco após 5ª falha" "$BLOQUEADO_ATE" "t"

# 6ª tentativa (nova, pós-limiar) — mesmo com a senha CORRETA — deve dar 423
# (não revela que a senha estaria certa durante o bloqueio).
ST_6A="$(node_e "
  fetch('http://localhost:3000/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'auth-bloqueio@example.test', senha: process.argv[1] }) })
    .then(r => { process.stdout.write(String(r.status)); process.exit(0); });
" "$SENHA_OK" | tr -d '[:space:]')"
check "6ª tentativa (nova, pós-bloqueio) com senha CORRETA -> 423 CONTA_BLOQUEADA" "$ST_6A" "423"

# Desbloqueia manualmente (simula expiração da janela) e confirma reset em login OK
psql_t <<SQL >/dev/null
UPDATE "Usuario" SET bloqueado_ate = NULL WHERE id = $UID_BLOQUEIO;
SQL
ST_POS_DESBLOQ="$(node_e "
  fetch('http://localhost:3000/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'auth-bloqueio@example.test', senha: process.argv[1] }) })
    .then(r => { process.stdout.write(String(r.status)); process.exit(0); });
" "$SENHA_OK" | tr -d '[:space:]')"
check "login correto após janela expirar -> 200 (reset)" "$ST_POS_DESBLOQ" "200"
TENTATIVAS_POS_OK="$(psql_t -tAc "SELECT tentativas_login FROM \"Usuario\" WHERE id = $UID_BLOQUEIO" | tr -d '[:space:]')"
check "tentativas_login resetado a 0 após login correto" "$TENTATIVAS_POS_OK" "0"

# ─────────────────────────────────────────────────────────────────────────────
# Cenário 3 — conta `auth-recuperacao`: recuperar-senha + redefinir-senha
# ─────────────────────────────────────────────────────────────────────────────
node_e "
  fetch('http://localhost:3000/api/v1/auth/recuperar-senha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'auth-recuperacao@example.test' }) })
    .then(r => r.json()).then(j => { process.stdout.write(JSON.stringify(j)); process.exit(0); });
" >"$TMP/rec-existe.json" 2>&1

BODY_REC_EXISTE="$(cat "$TMP/rec-existe.json")"
BODY_REC_NAO="$(node_e "
  fetch('http://localhost:3000/api/v1/auth/recuperar-senha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'auth-recuperacao-nao-existe@example.test' }) })
    .then(r => r.json()).then(j => { process.stdout.write(JSON.stringify(j)); process.exit(0); });
")"
check "FR-020: recuperar-senha resposta idêntica (existe vs não existe)" "$BODY_REC_EXISTE" "$BODY_REC_NAO"

sleep 1
MAIL_LOG="$(node_e "
  fetch('http://mailpit-mock:8080/_log?to=' + encodeURIComponent('auth-recuperacao@example.test'))
    .then(r => r.json()).then(j => { process.stdout.write(JSON.stringify(j)); process.exit(0); });
")"
TOKEN_BRUTO="$(printf '%s' "$MAIL_LOG" | node_e "
  const arr = JSON.parse(require('fs').readFileSync(0,'utf8'));
  const last = arr[arr.length - 1];
  const m = last && last.text && last.text.match(/token para redefinir sua senha: ([0-9a-f]+)/);
  process.stdout.write(m ? m[1] : '');
")"
check "token de recuperação extraído do mock mailpit" "$([ -n "$TOKEN_BRUTO" ] && echo sim || echo nao)" "sim"

TEM_EXPIRA="$(psql_t -tAc "SELECT token_recuperacao_expira IS NOT NULL FROM \"Usuario\" WHERE id = $UID_RECUPERACAO" | tr -d '[:space:]')"
check "token_recuperacao_expira setado no banco" "$TEM_EXPIRA" "t"

NOVA_SENHA='NovaSenhaSintetica#2'
ST_REDEF="$(node_e "
  fetch('http://localhost:3000/api/v1/auth/redefinir-senha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: process.argv[1], nova_senha: process.argv[2] }) })
    .then(r => { process.stdout.write(String(r.status)); process.exit(0); });
" "$TOKEN_BRUTO" "$NOVA_SENHA" | tr -d '[:space:]')"
check "redefinir-senha com token válido -> 200" "$ST_REDEF" "200"

TOKEN_NULO_POS="$(psql_t -tAc "SELECT token_recuperacao_hash IS NULL FROM \"Usuario\" WHERE id = $UID_RECUPERACAO" | tr -d '[:space:]')"
check "token_recuperacao_hash invalidado (NULL) após uso (single-use)" "$TOKEN_NULO_POS" "t"

ST_REDEF_REUSO="$(node_e "
  fetch('http://localhost:3000/api/v1/auth/redefinir-senha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: process.argv[1], nova_senha: 'OutraSenha#3' }) })
    .then(r => { process.stdout.write(String(r.status)); process.exit(0); });
" "$TOKEN_BRUTO" | tr -d '[:space:]')"
check "reuso do token de recuperação (single-use) -> 400" "$ST_REDEF_REUSO" "400"

SESSOES_ATIVAS_POS="$(psql_t -tAc "SELECT count(*) FROM \"SessaoRefresh\" WHERE usuario_id=$UID_RECUPERACAO AND revogado_em IS NULL" | tr -d '[:space:]')"
check "FR-022/SC-007: nenhuma SessaoRefresh ativa após redefinir-senha" "$SESSOES_ATIVAS_POS" "0"

ST_LOGIN_NOVA="$(node_e "
  fetch('http://localhost:3000/api/v1/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'auth-recuperacao@example.test', senha: process.argv[1] }) })
    .then(r => { process.stdout.write(String(r.status)); process.exit(0); });
" "$NOVA_SENHA" | tr -d '[:space:]')"
check "login com a NOVA senha pós-redefinição -> 200" "$ST_LOGIN_NOVA" "200"

# ─────────────────────────────────────────────────────────────────────────────
# Auditoria (FR-023) + imutabilidade (defesa em profundidade, reforço 0004)
# ─────────────────────────────────────────────────────────────────────────────
for par in "$UID_PRINCIPAL:login_sucesso" "$UID_BLOQUEIO:login_falha" "$UID_RECUPERACAO:recuperacao_senha_solicitada" "$UID_RECUPERACAO:senha_redefinida"; do
  uid="${par%%:*}"; acao="${par##*:}"
  n="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE usuario_id=$uid AND acao='$acao'" | tr -d '[:space:]')"
  if [ "${n:-0}" -ge 1 ] 2>/dev/null; then
    echo "PASS: Auditoria contém >=1 evento '$acao' (usuario_id=$uid)"
  else
    echo "FAIL: Auditoria SEM evento '$acao' (usuario_id=$uid)"
    fails=$((fails + 1))
  fi
done

UPDATE_ERR="$(psql_t -tAc "UPDATE \"Auditoria\" SET acao='hack' WHERE id = (SELECT id FROM \"Auditoria\" WHERE usuario_id=$UID_PRINCIPAL LIMIT 1)" 2>&1 | grep -c "Auditoria e imutavel" || true)"
check "Auditoria continua imutável (trigger 0004 ainda ativo)" "$([ "$UPDATE_ERR" -ge 1 ] 2>/dev/null && echo sim || echo nao)" "sim"

echo
if [ "$fails" = "0" ]; then
  echo "HUB-AUTH-INTEGRATION: OK — todos os asserts passaram (FASE 3: 3.1/3.2/3.3)"
else
  echo "HUB-AUTH-INTEGRATION: $fails assert(s) FALHARAM" >&2
  exit 1
fi

#!/usr/bin/env bash
# =============================================================================
# hub-shell-e2e-homolog.sh — hub-shell S3, tasks.md FASE 6.2 (parte API/proxy).
# E2E REAL contra o ambiente hub-homolog ISOLADO E PERSISTENTE, exercitando o
# SHELL (frontend_v2) de ponta a ponta: as requisições passam pelo proxy do
# Next (app/api/[...path]/route.ts) via a URL HTTPS pública do hub, exatamente
# como o browser do usuário faria — não batem no backend direto.
#
# Cobre os cenários VERIFICÁVEIS por API desta fase (os cenários de DOM/menu e
# axe rodam em Playwright na imagem mcr.microsoft.com/playwright — arquivo
# separado):
#   6.2.2  GET /api/v1/auditoria SEM auditoria.consultar -> 403 do backend,
#          mesmo item não aparecendo no menu (SC-002). Contraprova: admin_entidade
#          (COM a permissão) -> não-403.
#   6.2.3  (parte API) troca de entidade via POST /me/entidade reflete em /me
#          sem novo login (SC-003).
#   6.2.6  (parte API) login de conta SEM vínculo -> /me com entidades:[] (FR-016).
#
# ISOLAMENTO/LIMPEZA: mesmo padrão de infra/hub/testes/hub-e2e-homolog.sh (S2,
# já revisado): guarda de hostname, e-mails e2e-teste-shell-*@example.test,
# empresa_ids sintéticos em faixa reservada (950001/950002, distinta dos 940001/2
# do script S2), hash bcrypt via `dc exec backend node`, cleanup em trap mesmo
# em falha (superuser owner do banco bypassa RLS). O ambiente NUNCA é derrubado.
#
# Uso: infra/hub/testes/hub-shell-e2e-homolog.sh
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

# Requisição via SHELL (proxy do Next) — URL HTTPS pública, TLS self-signed.
BASE="https://$HUB_DOMAIN:$HUB_HTTPS_PORT"
RESOLVE="$HUB_DOMAIN:$HUB_HTTPS_PORT:127.0.0.1"
shell_req() { # shell_req <method> <path> <cookiejar> [json-body]
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

if [ "$(hostname)" != "VPSTodo" ]; then
  echo "ABORTADO: host inesperado '$(hostname)' (esperado VPSTodo)" >&2; exit 2
fi

cleanup_rows() {
  echo; echo "=== cleanup: removendo linhas e2e-teste-shell-* (owner bypassa RLS) ==="
  dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" <<'SQL'
SET session_replication_role = replica;
DELETE FROM "Auditoria"
  WHERE usuario_id IN (SELECT id FROM "Usuario" WHERE email LIKE 'e2e-teste-shell-%')
     OR (detalhes->>'email') LIKE 'e2e-teste-shell-%';
DELETE FROM "SessaoRefresh"
  WHERE usuario_id IN (SELECT id FROM "Usuario" WHERE email LIKE 'e2e-teste-shell-%');
DELETE FROM "UsuarioEntidade"
  WHERE usuario_id IN (SELECT id FROM "Usuario" WHERE email LIKE 'e2e-teste-shell-%');
DELETE FROM "Usuario" WHERE email LIKE 'e2e-teste-shell-%';
SQL
  echo "=== cleanup: concluído ==="; rm -rf "$TMP"
}
trap cleanup_rows EXIT

fails=0
check() { if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails+1)); fi; }

# ---- seeds --------------------------------------------------------------------
PAPEL_ADMIN="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_entidade'" | tr -d '[:space:]')"
PAPEL_OPER="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='operador'" | tr -d '[:space:]')"
[ -n "$PAPEL_ADMIN" ] && [ -n "$PAPEL_OPER" ] || { echo "FAIL: papeis 0007 ausentes"; exit 1; }

E_A=950001; E_B=950002
SENHA='SenhaShellE2e#Homolog1'
HASH="$(node_e "require('bcrypt').hash(process.argv[1],10).then(h=>{process.stdout.write(h);process.exit(0);});" "$SENHA" 2>"$TMP/h.log" | tr -d '[:space:]')"
[ -n "$HASH" ] || { echo "FAIL: hash bcrypt"; cat "$TMP/h.log"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('e2e-teste-shell-admin@example.test',   '$HASH', 'E2E Shell Admin Entidade', true),
  ('e2e-teste-shell-operador@example.test','$HASH', 'E2E Shell Operador', true),
  ('e2e-teste-shell-sem-vinculo@example.test','$HASH','E2E Shell Sem Vinculo', true);
SQL
UID_ADMIN="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='e2e-teste-shell-admin@example.test'" | tr -d '[:space:]')"
UID_OPER="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='e2e-teste-shell-operador@example.test'" | tr -d '[:space:]')"
[ -n "$UID_ADMIN" ] && [ -n "$UID_OPER" ] || { echo "FAIL: seed Usuario"; exit 1; }

# admin com 2 vínculos (A e B) para o cenário de troca de entidade; operador só A.
psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_ADMIN, $E_A, $PAPEL_ADMIN, true),
  ($UID_ADMIN, $E_B, $PAPEL_ADMIN, true),
  ($UID_OPER,  $E_A, $PAPEL_OPER,  true);
SQL

echo "### 6.2.2 — GET /api/v1/auditoria: operador 403 vs admin_entidade não-403 (SC-002) ###"

# --- operador: login -> seleciona entidade A -> GET /auditoria = 403 ----------
JAR_OP="$TMP/op.jar"
st=$(shell_req POST /api/v1/auth/login "$JAR_OP" '{"email":"e2e-teste-shell-operador@example.test","senha":"'"$SENHA"'"}')
check "6.2.2 login operador via shell -> 200" "$st" "200"
st=$(shell_req POST /api/v1/me/entidade "$JAR_OP" "{\"empresa_id\":$E_A}")
check "6.2.2 operador seleciona entidade A -> 200" "$st" "200"
st=$(shell_req GET /api/v1/auditoria "$JAR_OP")
check "6.2.2 operador GET /auditoria (sem auditoria.consultar) -> 403 (SC-002)" "$st" "403"

# --- admin_entidade: login -> seleciona A -> GET /auditoria = 200 (contraprova)-
JAR_AD="$TMP/ad.jar"
st=$(shell_req POST /api/v1/auth/login "$JAR_AD" '{"email":"e2e-teste-shell-admin@example.test","senha":"'"$SENHA"'"}')
check "6.2.2 login admin_entidade via shell -> 200" "$st" "200"
st=$(shell_req POST /api/v1/me/entidade "$JAR_AD" "{\"empresa_id\":$E_A}")
check "6.2.2 admin seleciona entidade A -> 200" "$st" "200"
st=$(shell_req GET /api/v1/auditoria "$JAR_AD")
check "6.2.2 admin_entidade GET /auditoria (COM auditoria.consultar) -> 200 (contraprova SC-002)" "$st" "200"

echo; echo "### 6.2.3 (API) — troca de entidade reflete em /me sem novo login (SC-003) ###"
st=$(shell_req POST /api/v1/me/entidade "$JAR_AD" "{\"empresa_id\":$E_B}")
check "6.2.3 admin troca para entidade B -> 200" "$st" "200"
st=$(shell_req GET /api/v1/me "$JAR_AD")
ATIVA=$(jq -r '.entidade_ativa // empty' "$TMP/body.json" 2>/dev/null)
check "6.2.3 GET /me reflete entidade_ativa=B após troca, sem novo login (SC-003)" "$ATIVA" "$E_B"

echo; echo "### 6.2.6 (API) — login sem vínculo -> /me com entidades vazias (FR-016) ###"
JAR_SV="$TMP/sv.jar"
st=$(shell_req POST /api/v1/auth/login "$JAR_SV" '{"email":"e2e-teste-shell-sem-vinculo@example.test","senha":"'"$SENHA"'"}')
check "6.2.6 login sem-vínculo via shell -> 200" "$st" "200"
st=$(shell_req GET /api/v1/me "$JAR_SV")
NENT=$(jq -r 'if (.entidades|type)=="array" then (.entidades|length) else -1 end' "$TMP/body.json" 2>/dev/null)
check "6.2.6 GET /me: 0 entidades vinculadas (tela 'sem acesso', FR-016)" "$NENT" "0"

echo
if [ "$fails" = "0" ]; then
  echo "HUB-SHELL-E2E-HOMOLOG: OK — todos os asserts passaram (FASE 6.2 API: SC-002/SC-003/FR-016)"
else
  echo "HUB-SHELL-E2E-HOMOLOG: $fails assert(s) FALHARAM" >&2; exit 1
fi

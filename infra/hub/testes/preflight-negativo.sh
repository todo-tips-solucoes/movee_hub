#!/usr/bin/env bash
# =============================================================================
# preflight-negativo.sh — demonstra que o preflight ABORTA nas 6 combinações
# perigosas da §4.8 (critério de saída G2, item 4). Nenhum container é criado:
# só `docker compose config` roda por baixo.
#
# Uso: infra/hub/testes/preflight-negativo.sh
# Saída: PASS/FAIL por cenário; exit 0 só com 6/6 abortando com o código certo.
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PREFLIGHT="$HUB_DIR/scripts/preflight.sh"
COMPOSE="$HUB_DIR/compose.hub.homolog.yml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Env base VÁLIDO (valores dummy; nunca os reais) — derivado do .example
base_env() {
  cat <<EOF
APP_ENV=homologation
HUB_DOMAIN=hub-homolog.todo-tips.com
HUB_HTTP_PORT=8880
HUB_HTTPS_PORT=8443
HUB_TLS_DIR=$TMP/tls
HUB_DB_NAME=hub_homolog
HUB_DB_USER=hub_homolog
HUB_DB_PASSWORD=dummy-pass-teste
PGRST_JWT_SECRET=dummy-secret-com-mais-de-32-caracteres-ok
JWT_SECRET=dummy-jwt-secret-teste
JWT_REFRESH_SECRET=dummy-refresh-teste
POSTGREST_API_KEY=dummy-api-key-teste
POSTGREST_URL=http://postgrest:3000
FASTAPI_URL=http://fastapi-mock:8080
N8N_URL=http://n8n-mock:8080
N8N_API_TOKEN=hub-homolog-mock-n8n-token
FASTAPI_VALIDATION_TOKEN=hub-homolog-mock-fastapi-token
ENVIO_DRY_RUN=true
ENVIO_REAL_HABILITADO=false
ENVIO_ALLOWLIST=
ENVIO_MAX_MENSAGENS=10
EOF
}
mkdir -p "$TMP/tls"

run_case() { # run_case <num> <descricao> <esperado> <envfile> [compose] [fp_file]
  local num="$1" desc="$2" want="$3" env="$4" compose="${5:-$COMPOSE}" fp="${6:-}"
  local out rc
  if [ -n "$fp" ]; then
    out="$(HUB_PROD_FINGERPRINTS="$fp" "$PREFLIGHT" -f "$compose" -p hub-homolog -e "$env" 2>&1)"
  else
    out="$(HUB_PROD_FINGERPRINTS=/nonexistent "$PREFLIGHT" -f "$compose" -p hub-homolog -e "$env" 2>&1)"
  fi
  rc=$?
  if [ "$rc" = "$want" ]; then
    echo "PASS [$num] $desc → abortou com exit $rc (esperado $want)"
    echo "      $(echo "$out" | grep 'ABORTADO' | head -1)"
    return 0
  else
    echo "FAIL [$num] $desc → exit $rc (esperado $want)"
    echo "$out" | sed 's/^/      /'
    return 1
  fi
}

fails=0

# 1. POSTGREST_URL de produção em env não-produção → 11
base_env | sed 's|^POSTGREST_URL=.*|POSTGREST_URL=https://postgrest.todo-tips.com|' >"$TMP/c1.env"
run_case 1 "POSTGREST_URL de produção com APP_ENV=homologation" 11 "$TMP/c1.env" || fails=$((fails+1))

# 2. Domínio de produção em env não-produção → 12
base_env | sed 's|^HUB_DOMAIN=.*|HUB_DOMAIN=app.moveelog.com.br|' >"$TMP/c2.env"
run_case 2 "domínio moveelog.com.br com APP_ENV=homologation" 12 "$TMP/c2.env" || fails=$((fails+1))

# 3. Token igual ao fingerprint de produção → 13
FAKE_PROD_TOKEN="token-de-producao-simulado-para-teste"
h="$(printf '%s' "$FAKE_PROD_TOKEN" | sha256sum | awk '{print $1}')"
printf '%s  N8N_API_TOKEN\n' "$h" >"$TMP/fp.sha256"
base_env | sed "s|^N8N_API_TOKEN=.*|N8N_API_TOKEN=$FAKE_PROD_TOKEN|" >"$TMP/c3.env"
run_case 3 "N8N_API_TOKEN com hash igual ao fingerprint de produção" 13 "$TMP/c3.env" "$COMPOSE" "$TMP/fp.sha256" || fails=$((fails+1))

# 4. Volume de produção montado → 14
cat >"$TMP/c4-compose.yml" <<'EOF'
services:
  intruso:
    image: alpine:3.20
    volumes:
      - pgadmin_pg_data:/dados
volumes:
  pgadmin_pg_data:
    external: true
    name: pgadmin_pg_data
EOF
base_env >"$TMP/c4.env"
run_case 4 "volume de produção (pgadmin_pg_data) no compose" 14 "$TMP/c4.env" "$TMP/c4-compose.yml" || fails=$((fails+1))

# 5. Proteção inversa: APP_ENV=production com ENVIO_DRY_RUN=true → 15
base_env | sed 's|^APP_ENV=.*|APP_ENV=production|' >"$TMP/c5.env"
run_case 5 "APP_ENV=production com ENVIO_DRY_RUN=true (proteção inversa)" 15 "$TMP/c5.env" || fails=$((fails+1))

# 6. APP_ENV ausente → 10
base_env | grep -v '^APP_ENV=' >"$TMP/c6.env"
run_case 6 "APP_ENV ausente" 10 "$TMP/c6.env" || fails=$((fails+1))

echo
if [ "$fails" = "0" ]; then
  echo "TESTE NEGATIVO: 6/6 combinações perigosas ABORTADAS corretamente"
else
  echo "TESTE NEGATIVO: $fails caso(s) NÃO abortaram como esperado" >&2
  exit 1
fi

#!/usr/bin/env bash
# =============================================================================
# preflight.sh — validação fail-safe ANTES de qualquer `up` do hub (§4.8).
# Aborta (exit != 0) se detectar qualquer possibilidade de alcançar produção.
#
# Uso:
#   infra/hub/scripts/preflight.sh -f <compose.yml> -p <projeto> -e <env-file>
#
# Códigos de saída (usados pelo teste negativo):
#   10 APP_ENV ausente/inválido
#   11 env não-produção com POSTGREST_URL de produção
#   12 env não-produção com domínio de produção (moveelog.com.br)
#   13 token igual ao fingerprint de produção (comparação por hash)
#   14 volume/bind/rede de produção no compose renderizado
#   15 proteção inversa: APP_ENV=production com config de dev
#   16 imagem sem tag explícita ou :latest
#   17 projeto compose fora do escopo hub-
#   18 docker compose config inválido
#   19 uso incorreto / arquivo ausente
#
# NUNCA imprime valores de segredos — só nomes de variáveis e hashes.
# =============================================================================
set -euo pipefail

FP_FILE="${HUB_PROD_FINGERPRINTS:-/var/lib/hub_secrets/prod-fingerprints.sha256}"

COMPOSE_FILE="" PROJECT="" ENV_FILE=""
while getopts "f:p:e:" opt; do
  case "$opt" in
    f) COMPOSE_FILE="$OPTARG" ;;
    p) PROJECT="$OPTARG" ;;
    e) ENV_FILE="$OPTARG" ;;
    *) echo "uso: $0 -f compose.yml -p projeto -e env-file" >&2; exit 19 ;;
  esac
done

fail() { local code="$1"; shift; echo "PREFLIGHT: ABORTADO [$code] $*" >&2; exit "$code"; }
ok()   { echo "PREFLIGHT: ok — $*"; }

[ -n "$COMPOSE_FILE" ] && [ -n "$PROJECT" ] && [ -n "$ENV_FILE" ] || fail 19 "argumentos -f/-p/-e obrigatórios"
[ -f "$COMPOSE_FILE" ] || fail 19 "compose não encontrado: $COMPOSE_FILE"
[ -f "$ENV_FILE" ] || fail 19 "env-file não encontrado: $ENV_FILE"

# --- Escopo do projeto: exceção standing cobre SOMENTE hub-* -----------------
case "$PROJECT" in
  hub-*) ok "projeto '$PROJECT' dentro do escopo hub-*" ;;
  *) fail 17 "projeto '$PROJECT' fora do escopo hub-* (exceção G1 não cobre)" ;;
esac

# --- Leitura segura do env-file (sem source/eval; sem ecoar valores) ---------
get_var() { # get_var NOME → valor (vazio se ausente)
  awk -F= -v k="$1" '$0 !~ /^[[:space:]]*#/ && $1 == k { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

APP_ENV="$(get_var APP_ENV)"
case "$APP_ENV" in
  development|test|homologation|production) ok "APP_ENV=$APP_ENV" ;;
  "") fail 10 "APP_ENV ausente no env-file (obrigatório)" ;;
  *) fail 10 "APP_ENV inválido: '$APP_ENV' (∉ development|test|homologation|production)" ;;
esac

# --- Render do compose (config) ----------------------------------------------
RENDER="$(mktemp)"
trap 'rm -f "$RENDER"' EXIT
if ! docker compose -f "$COMPOSE_FILE" -p "$PROJECT" --env-file "$ENV_FILE" config >"$RENDER" 2>/tmp/preflight-config.err; then
  cat /tmp/preflight-config.err >&2
  fail 18 "docker compose config inválido"
fi
ok "docker compose config válido"

# --- Imagens: tag explícita, nunca latest (§4.5 item 8) ----------------------
while IFS= read -r img; do
  [ -z "$img" ] && continue
  case "$img" in
    *:latest) fail 16 "imagem proibida (latest): $img" ;;
    *:*) : ;;
    *) fail 16 "imagem sem tag explícita: $img" ;;
  esac
done < <(docker compose -f "$COMPOSE_FILE" -p "$PROJECT" --env-file "$ENV_FILE" config --images)
ok "todas as imagens com tag explícita ≠ latest"

if [ "$APP_ENV" != "production" ]; then
  # --- URL do PostgREST/banco de produção -------------------------------------
  for v in POSTGREST_URL PGRST_DB_URI DATABASE_URL; do
    val="$(get_var "$v")"
    if printf '%s' "$val" | grep -Eq 'postgrest\.todo-tips\.com|pgadmin_db|chatmasterveloz'; then
      fail 11 "$v aponta para recurso de produção em APP_ENV=$APP_ENV"
    fi
  done
  ok "nenhuma URL de PostgREST/banco de produção no env"

  # --- Domínio de produção -----------------------------------------------------
  if grep -Ev '^[[:space:]]*#' "$ENV_FILE" | grep -q 'moveelog\.com\.br'; then
    fail 12 "domínio de produção (moveelog.com.br) presente no env em APP_ENV=$APP_ENV"
  fi
  if grep -q 'moveelog\.com\.br' "$RENDER"; then
    fail 12 "domínio de produção (moveelog.com.br) presente no compose renderizado"
  fi
  ok "nenhum domínio de produção"

  # --- Tokens vs fingerprint de produção (comparação por hash, §4.8) ----------
  if [ -f "$FP_FILE" ]; then
    for v in N8N_API_TOKEN FASTAPI_VALIDATION_TOKEN JWT_SECRET JWT_REFRESH_SECRET POSTGREST_API_KEY PGRST_JWT_SECRET; do
      val="$(get_var "$v")"
      [ -z "$val" ] && continue
      # printf builtin do bash (nunca /usr/bin/printf — segredo apareceria em ps)
      h="$(printf '%s' "$val" | sha256sum | awk '{print $1}')"
      if grep -qi "^$h" "$FP_FILE"; then
        fail 13 "$v tem o MESMO hash de um segredo de produção (fingerprint em $FP_FILE)"
      fi
    done
    ok "tokens distintos dos fingerprints de produção ($FP_FILE)"
  else
    echo "PREFLIGHT: AVISO — $FP_FILE ausente; checagem de fingerprint pulada." >&2
    echo "  Operador: registrar hashes de produção com: printf '%s' \"\$TOKEN\" | sha256sum (builtin)" >&2
  fi

  # --- Volumes/binds/redes de produção no compose renderizado -----------------
  if grep -Eq 'pgadmin_pg_data|/var/lib/fastapi_homologacao' "$RENDER"; then
    fail 14 "volume/bind de produção referenciado no compose renderizado"
  fi
  if grep -Eq '^[[:space:]]+name:[[:space:]]+(pgadmin|app_homologacao_default|fastapi_homologacao(_nexus)?|network_main)[[:space:]]*$' "$RENDER"; then
    fail 14 "rede de produção referenciada no compose renderizado"
  fi
  ok "nenhum volume/bind/rede de produção no compose"
else
  # --- Proteção inversa (§4.8): produção com resquício de dev -----------------
  if [ "$(get_var ENVIO_DRY_RUN)" = "true" ]; then
    fail 15 "APP_ENV=production com ENVIO_DRY_RUN=true (config de homolog em produção)"
  fi
  for v in JWT_SECRET JWT_REFRESH_SECRET POSTGREST_API_KEY N8N_API_TOKEN FASTAPI_VALIDATION_TOKEN; do
    val="$(get_var "$v")"
    case "$val" in
      *-dev|*-mock*) fail 15 "APP_ENV=production com credencial de dev/mock em $v" ;;
    esac
  done
  ok "proteção inversa: nenhuma config de dev em produção"
fi

echo "PREFLIGHT: PASSOU — $COMPOSE_FILE (projeto $PROJECT, APP_ENV=$APP_ENV)"

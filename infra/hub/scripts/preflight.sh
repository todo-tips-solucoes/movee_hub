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
#   11 env/compose não-produção com banco/PostgREST de produção
#   12 env/compose não-produção com domínio de produção (moveelog.com.br)
#   13 segredo igual ao fingerprint de produção (comparação por hash)
#   14 volume/bind/rede de produção OU recurso fora da allowlist hub_*
#   15 proteção inversa: APP_ENV=production com config de dev
#   16 imagem sem tag explícita ou :latest (ou nenhuma imagem detectada)
#   17 projeto compose fora do escopo hub-
#   18 docker compose config inválido
#   19 uso incorreto / arquivo ausente
#
# Estratégia dupla (review S1): ALLOWLIST (nomes de volumes/redes devem ser
# hub*; binds só em infra/hub|/var/lib/hub_secrets) + BLOCKLIST compartilhada
# em lib.sh (defesa em profundidade). NUNCA imprime valores de segredos.
# =============================================================================
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

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

gv() { get_var "$1" "$ENV_FILE"; }

# --- Escopo do projeto: exceção standing cobre SOMENTE hub-* -----------------
case "$PROJECT" in
  hub-*) ok "projeto '$PROJECT' dentro do escopo hub-*" ;;
  *) fail 17 "projeto '$PROJECT' fora do escopo hub-* (exceção G1 não cobre)" ;;
esac

APP_ENV="$(gv APP_ENV)"
case "$APP_ENV" in
  development|test|homologation|production) ok "APP_ENV=$APP_ENV" ;;
  "") fail 10 "APP_ENV ausente no env-file (obrigatório)" ;;
  *) fail 10 "APP_ENV inválido: '$APP_ENV' (∉ development|test|homologation|production)" ;;
esac

# --- Render do compose (config) — invocação ÚNICA ----------------------------
RENDER="$(mktemp)"
trap 'rm -f "$RENDER"' EXIT
if ! docker compose -f "$COMPOSE_FILE" -p "$PROJECT" --env-file "$ENV_FILE" config >"$RENDER" 2>/tmp/preflight-config.err; then
  cat /tmp/preflight-config.err >&2
  fail 18 "docker compose config inválido"
fi
ok "docker compose config válido"

# --- Imagens: tag explícita, nunca latest (§4.5 item 8; fail-closed) ---------
IMAGES="$(awk '/^[[:space:]]+image: /{print $2}' "$RENDER" | sort -u)"
[ -n "$IMAGES" ] || fail 16 "nenhuma imagem detectada no compose renderizado (checagem fail-closed)"
while IFS= read -r img; do
  case "$img" in
    *:latest) fail 16 "imagem proibida (latest): $img" ;;
    *:*) : ;;
    *) fail 16 "imagem sem tag explícita: $img" ;;
  esac
done <<<"$IMAGES"
ok "todas as imagens com tag explícita ≠ latest ($(echo "$IMAGES" | wc -l) imagens)"

# --- Allowlist hub_*: todo volume/rede nomeado do compose deve ser hub* ------
while IFS= read -r name; do
  case "$name" in
    hub*) : ;;
    *) fail 14 "recurso nomeado fora da allowlist hub_*: '$name'" ;;
  esac
done < <(grep -E '^[[:space:]]+name: ' "$RENDER" | awk '{print $2}' | tr -d '"' | sort -u)
ok "todos os volumes/redes/projeto nomeados começam com hub"

# --- Allowlist de binds: só infra/hub e /var/lib/hub_secrets ------------------
while IFS= read -r src; do
  allowed=0
  for pfx in $HUB_ALLOWED_BIND_PREFIXES; do
    case "$src" in "$pfx"*) allowed=1 ;; esac
  done
  [ "$allowed" = 1 ] || fail 14 "bind mount fora da allowlist do hub: '$src'"
done < <(grep -E '^[[:space:]]+source: /' "$RENDER" | awk '{print $2}' | tr -d '"' | sort -u)
ok "todos os bind mounts dentro de infra/hub | /var/lib/hub_secrets"

if [ "$APP_ENV" != "production" ]; then
  # --- Banco/PostgREST de produção: env-file INTEIRO + compose renderizado ----
  if grep -Ev '^[[:space:]]*#' "$ENV_FILE" | grep -Eq "$PROD_DB_REGEX"; then
    fail 11 "referência a banco/PostgREST de produção no env-file em APP_ENV=$APP_ENV"
  fi
  if grep -Eq "$PROD_DB_REGEX" "$RENDER"; then
    fail 11 "referência a banco/PostgREST de produção no compose renderizado"
  fi
  ok "nenhuma referência a banco/PostgREST de produção (env + compose)"

  # --- Domínio de produção -----------------------------------------------------
  if grep -Ev '^[[:space:]]*#' "$ENV_FILE" | grep -Eq "$PROD_DOMAIN_REGEX"; then
    fail 12 "domínio de produção (moveelog.com.br) no env-file em APP_ENV=$APP_ENV"
  fi
  if grep -Eq "$PROD_DOMAIN_REGEX" "$RENDER"; then
    fail 12 "domínio de produção (moveelog.com.br) no compose renderizado"
  fi
  ok "nenhum domínio de produção"

  # --- Segredos vs fingerprint de produção (comparação por hash, §4.8) --------
  if [ -f "$FP_FILE" ] && grep -Eqv '^[[:space:]]*(#|$)' "$FP_FILE"; then
    for v in N8N_API_TOKEN FASTAPI_VALIDATION_TOKEN JWT_SECRET JWT_REFRESH_SECRET POSTGREST_API_KEY PGRST_JWT_SECRET HUB_DB_PASSWORD; do
      val="$(gv "$v")"
      [ -z "$val" ] && continue
      # printf builtin do bash (nunca /usr/bin/printf — segredo apareceria em ps)
      h="$(printf '%s' "$val" | sha256sum | awk '{print $1}')"
      if grep -Ev '^[[:space:]]*(#|$)' "$FP_FILE" | grep -qi "^$h"; then
        fail 13 "$v tem o MESMO hash de um segredo de produção (fingerprint em $FP_FILE)"
      fi
    done
    ok "segredos distintos dos fingerprints de produção ($(grep -Ecv '^[[:space:]]*(#|$)' "$FP_FILE") registrados)"
  else
    echo "PREFLIGHT: AVISO — $FP_FILE ausente ou sem entradas; checagem de fingerprint pulada." >&2
    echo "  Operador: registrar hashes de produção com: printf '%s' \"\$TOKEN\" | sha256sum (builtin)" >&2
  fi

  # --- Blocklist de volumes/binds/redes de produção (defesa em profundidade) --
  if grep -Eq "$PROD_MOUNT_REGEX" "$RENDER"; then
    fail 14 "volume/bind de produção referenciado no compose renderizado"
  fi
  for n in $PROD_NETWORKS; do
    if grep -Eq "^[[:space:]]+name:[[:space:]]+\"?$n\"?[[:space:]]*$" "$RENDER"; then
      fail 14 "rede de produção '$n' referenciada no compose renderizado"
    fi
  done
  ok "nenhum volume/bind/rede de produção no compose (blocklist)"
else
  # --- Proteção inversa (§4.8): produção com resquício de dev -----------------
  if [ "$(gv ENVIO_DRY_RUN)" = "true" ]; then
    fail 15 "APP_ENV=production com ENVIO_DRY_RUN=true (config de homolog em produção)"
  fi
  for v in JWT_SECRET JWT_REFRESH_SECRET POSTGREST_API_KEY PGRST_JWT_SECRET HUB_DB_PASSWORD N8N_API_TOKEN FASTAPI_VALIDATION_TOKEN; do
    val="$(gv "$v")"
    case "$val" in
      *-dev|*-mock*) fail 15 "APP_ENV=production com credencial de dev/mock em $v" ;;
    esac
  done
  ok "proteção inversa: nenhuma config de dev em produção"
fi

echo "PREFLIGHT: PASSOU — $COMPOSE_FILE (projeto $PROJECT, APP_ENV=$APP_ENV)"

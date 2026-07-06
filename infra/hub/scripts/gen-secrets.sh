#!/usr/bin/env bash
# =============================================================================
# gen-secrets.sh — gera credenciais NOVAS do hub (§4.4/§4.8) e TLS self-signed.
# Nada é copiado de produção. Saída fora do git: /var/lib/hub_secrets (0700),
# arquivos 0600. Idempotente: não sobrescreve sem --force.
#
# Uso: infra/hub/scripts/gen-secrets.sh [--force]
# =============================================================================
set -euo pipefail

SECRETS_DIR="${HUB_SECRETS_DIR:-/var/lib/hub_secrets}"
REPO_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
HUB_DIR="$REPO_DIR/infra/hub"
FORCE="${1:-}"

umask 077
mkdir -p "$SECRETS_DIR/tls"
chmod 700 "$SECRETS_DIR"

rand() { openssl rand -hex 32; }   # 64 chars hex — atende PGRST_JWT_SECRET ≥32

gen_env() { # gen_env <example> <destino>
  local example="$1" dest="$2"
  if [ -f "$dest" ] && [ "$FORCE" != "--force" ]; then
    echo "mantido (já existe): $dest"
    return 0
  fi
  # Substitui cada __GERAR__ por um segredo novo e independente
  local tmp; tmp="$(mktemp)"
  while IFS= read -r line; do
    while printf '%s' "$line" | grep -q '__GERAR__'; do
      line="${line/__GERAR__/$(rand)}"
    done
    printf '%s\n' "$line"
  done <"$example" >"$tmp"
  mv "$tmp" "$dest"
  chmod 600 "$dest"
  echo "gerado: $dest (0600)"
}

gen_env "$HUB_DIR/.env.hub.dev.example"     "$SECRETS_DIR/.env.hub.dev"
gen_env "$HUB_DIR/.env.hub.test.example"    "$SECRETS_DIR/.env.hub.test"
gen_env "$HUB_DIR/.env.hub.homolog.example" "$SECRETS_DIR/.env.hub.homolog"

# --- TLS self-signed do Traefik do hub (decisão de design S1; ver RUNBOOK) ---
CRT="$SECRETS_DIR/tls/hub-homolog.crt"
KEY="$SECRETS_DIR/tls/hub-homolog.key"
if [ -f "$CRT" ] && [ "$FORCE" != "--force" ]; then
  echo "mantido (já existe): $CRT"
else
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout "$KEY" -out "$CRT" \
    -subj "/CN=hub-homolog.todo-tips.com/O=Hub Frota Homolog" \
    -addext "subjectAltName=DNS:hub-homolog.todo-tips.com,DNS:localhost" \
    >/dev/null 2>&1
  chmod 600 "$KEY" "$CRT"
  echo "gerado: certificado self-signed em $SECRETS_DIR/tls (0600)"
fi

# Placeholder do arquivo de fingerprints de produção (o OPERADOR preenche;
# o agente jamais lê segredos de produção — cláusula pétrea)
FP="$SECRETS_DIR/prod-fingerprints.sha256"
if [ ! -f "$FP" ]; then
  cat >"$FP" <<'EOF'
# Fingerprints (sha256) dos segredos de PRODUÇÃO — preenchido SÓ pelo operador.
# Método (builtin do bash, sem newline, nunca /usr/bin/printf):
#   printf '%s' "$TOKEN" | sha256sum
# Formato: <sha256>  <NOME_DA_VAR>
# Enquanto vazio, o preflight avisa e pula a checagem de fingerprint.
EOF
  chmod 600 "$FP"
  echo "criado placeholder: $FP (operador preenche)"
fi

echo "OK. Segredos em $SECRETS_DIR (fora do git)."

#!/bin/sh
# Roda a execução assistida dentro do container oficial do Playwright.
# Mesmo padrão do docker-run.sh (nunca instala browser no host), mas chama
# execucao-assistida.js — que baixa os CSVs e NÃO importa no hub.
set -eu

DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMG="${ROBO_ENTREGO_PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.62.1-jammy}"
SECRETS="${ROBO_ENTREGO_SECRETS_DIR:-/var/lib/hub_secrets/robo-entrego}"

[ -r "$SECRETS/.env" ] || { echo "❌ não consigo ler $SECRETS/.env (rode com sudo)"; exit 1; }

echo "container : $IMG"
echo "segredos  : $SECRETS"
echo "saída     : $DIR/.execucao-assistida"
echo ""

docker run --rm \
  -v "$DIR:/work" \
  -v "$SECRETS:$SECRETS" \
  -e ROBO_ENTREGO_SECRETS_DIR="$SECRETS" \
  -w /work \
  "$IMG" node scripts/execucao-assistida.js "$@"

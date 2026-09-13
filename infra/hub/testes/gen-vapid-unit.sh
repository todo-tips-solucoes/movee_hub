#!/usr/bin/env bash
# =============================================================================
# gen-vapid-unit.sh — teste unitário de infra/hub/scripts/gen-vapid.sh (tasks.md 1.1.4).
#
# 1 assert: rodar o script duas vezes (sem --force) sobre o mesmo --dest produz
# conteúdo IDÊNTICO (sha256 do arquivo não muda na 2ª execução), mesmo passando
# um --gerado-por diferente na 2ª chamada.
#
# Não toca /var/lib/hub_secrets — roda inteiro num diretório temporário.
# Uso: infra/hub/testes/gen-vapid-unit.sh
# =============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
GEN_VAPID="$REPO_DIR/infra/hub/scripts/gen-vapid.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

DEST="$TMPDIR/vapid.json"

# FASE 5 (tasks.md 5.1) — --subject passou a ser obrigatório (research.md
# Decision 2: contato do operador, exigido pela lib `web-push`). Sem ele o
# script deve falhar.
if "$GEN_VAPID" --gerado-por "operador-a" --dest "$DEST" >/dev/null 2>&1; then
  echo "FAIL: gen-vapid.sh não exigiu --subject" >&2
  exit 1
fi
echo "PASS: gen-vapid.sh recusa rodar sem --subject"

"$GEN_VAPID" --subject "mailto:teste-unitario@example.com" --gerado-por "operador-a" --dest "$DEST" >/dev/null
SHA_ANTES="$(sha256sum "$DEST" | cut -d' ' -f1)"
grep -q '"subject": "mailto:teste-unitario@example.com"' "$DEST" || {
  echo "FAIL: subject não gravado no arquivo" >&2
  exit 1
}

"$GEN_VAPID" --subject "mailto:outro@example.com" --gerado-por "operador-b" --dest "$DEST" >/dev/null
SHA_DEPOIS="$(sha256sum "$DEST" | cut -d' ' -f1)"

if [ "$SHA_ANTES" = "$SHA_DEPOIS" ]; then
  echo "PASS: gen-vapid.sh sem --force não sobrescreve ($SHA_ANTES)"
  exit 0
else
  echo "FAIL: conteúdo mudou sem --force (antes=$SHA_ANTES depois=$SHA_DEPOIS)" >&2
  exit 1
fi

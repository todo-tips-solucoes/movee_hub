#!/usr/bin/env bash
# scripts/docker-run-enriquecimento.sh (hub-motorista-360 FASE 6, tasks.md
# 6.1.1) — wrapper systemd-oneshot para src/enriquecimento.js, mesmo padrão
# de scripts/docker-run.sh (Playwright só dentro do container oficial —
# research.md Decision 2, "nunca instalar browsers no host").
#
# Mutex com a rodada de importação diária (dec-039 — "uma raspagem por vez,
# robô prioritário", FR-005): usa o MESMO $LOCKFILE de docker-run.sh. "Robô
# prioritário" emerge do próprio `flock -n` (non-blocking, ver enriquecimento.js
# cabeçalho): quem já tem o lock corre; o outro desiste na hora e tenta de
# novo no próprio próximo tick — como a importação roda só 3x/dia e o
# enriquecimento sob-demanda a cada poucos minutos, é sempre o enriquecimento
# quem cede, nunca o contrário.
#
# Uso: docker-run-enriquecimento.sh <sob-demanda|semestral>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MODO="${1:?docker-run-enriquecimento: uso: docker-run-enriquecimento.sh <sob-demanda|semestral>}"
case "$MODO" in
  sob-demanda|semestral) ;;
  *) echo "docker-run-enriquecimento: modo inválido '${MODO}' (válidos: sob-demanda, semestral)" >&2; exit 1 ;;
esac

# Mesma versão pinada de docker-run.sh — MUST bater com package-lock.json
# (grep -A2 node_modules/playwright package-lock.json antes de trocar).
PLAYWRIGHT_IMAGE="${ROBO_ENTREGO_PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.62.1-jammy}"

# MESMO path dentro/fora do container e MESMO lockfile de docker-run.sh —
# ver comentário de mutex acima.
SECRETS_DIR="${ROBO_ENTREGO_SECRETS_DIR:-/var/lib/hub_secrets/robo-entrego}"
LOCKFILE="${SECRETS_DIR}/robo-entrego.lock"
CONFLICT_EXIT_CODE=99

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

run_container() {
  docker run --rm \
    -v "${SCRIPT_DIR}:/work" \
    -v "${SECRETS_DIR}:${SECRETS_DIR}" \
    -w /work \
    "$PLAYWRIGHT_IMAGE" \
    "$@"
}

set +e
flock -n -E "$CONFLICT_EXIT_CODE" "$LOCKFILE" \
  docker run --rm \
    -v "${SCRIPT_DIR}:/work" \
    -v "${SECRETS_DIR}:${SECRETS_DIR}" \
    -w /work \
    "$PLAYWRIGHT_IMAGE" \
    node src/enriquecimento.js "--modo=${MODO}"
rc=$?
set -e

if [ "$rc" -eq "$CONFLICT_EXIT_CODE" ]; then
  echo "[docker-run-enriquecimento] lock ocupado (${LOCKFILE}) — outra execução (importação ou enriquecimento) em andamento; registrando pulado_lock" >&2
  run_container node src/enriquecimento.js "--modo=${MODO}" --pulado-lock
  exit 0
fi

exit "$rc"

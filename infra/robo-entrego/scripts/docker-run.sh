#!/usr/bin/env bash
# scripts/docker-run.sh (tasks.md 5.2.1) — wrapper systemd-oneshot que roda
# a rotina inteira dentro do container oficial do Playwright (research.md
# Decision 2 — "nunca instalar browsers no host", mesma convenção de
# infra/hub/testes/hub-shell-e2e-browser.sh).
#
# Mutex real (dec-041, research.md Decision 8): `flock -n -E
# $CONFLICT_EXIT_CODE` envolve o `docker run` INTEIRO — se outra execução já
# detém o lock, este processo nem sobe o container (kernel garante liberação
# automática do lock mesmo se a execução anterior morrer sem limpar nada).
# Só quando o conflito é detectado (`rc == CONFLICT_EXIT_CODE`) rodamos, à
# parte, `index.js --pulado-lock` — rápido, sem Playwright — para registrar
# `resultado: pulado_lock` no log JSON Lines (log-execucao.js é a ÚNICA fonte
# do schema; nunca duplicar o formato aqui em bash). Roda via docker (mesma
# imagem) para não assumir que o HOST tem `node` instalado — zero dependência
# nova de host além do Docker que este wrapper já exige.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Versão pinada — MUST bater com a versão resolvida de `playwright` em
# package-lock.json (driver Node vs. browsers do container: Playwright é
# estrito quanto a isso). Conferir com `grep -A2 node_modules/playwright
# package-lock.json` antes de trocar; reflete package.json ^1.45.0 resolvido
# em 1.62.1 nesta feature (diferente do v1.61.1-jammy usado pelo frontend_v2
# — projetos distintos, cada um pina a própria versão resolvida).
PLAYWRIGHT_IMAGE="${ROBO_ENTREGO_PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.62.1-jammy}"

# ⚠️ src/*.js (LOG_PATH_DEFAULT, STORAGE_STATE_PATH_DEFAULT, ENV_PATH_DEFAULT)
# hardcodam este MESMO caminho absoluto — não é lido de env var pelo Node.
# Só sobrescreva ROBO_ENTREGO_SECRETS_DIR se for testar SÓ o mecanismo de
# lock (o conteúdo dentro do container fica isolado do host quando o
# caminho não bate com os defaults do Node — verificado em bancada:
# `docker run ... -v <scratch>:/var/lib/hub_secrets/robo-entrego ...` é a
# forma correta de redirecionar o secrets dir para teste, mantendo o
# TARGET do mount fixo).
SECRETS_DIR="${ROBO_ENTREGO_SECRETS_DIR:-/var/lib/hub_secrets/robo-entrego}"
LOCKFILE="${SECRETS_DIR}/robo-entrego.lock"
CONFLICT_EXIT_CODE=99

mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"

# Mesmo path DENTRO e FORA do container — data-model.md/log-execucao.js/
# entrego-portal.js/index.js já hardcodam `/var/lib/hub_secrets/robo-entrego/*`
# como default; remapear para outro mountpoint (ex.: /secrets) exigiria
# reintroduzir esses caminhos como parâmetro em 3 módulos só por causa do
# wrapper — mais simples manter o MESMO path dos dois lados (ladder rung 2).
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
    node src/index.js
rc=$?
set -e

if [ "$rc" -eq "$CONFLICT_EXIT_CODE" ]; then
  echo "[docker-run] lock ocupado (${LOCKFILE}) — outra execução em andamento; registrando pulado_lock" >&2
  run_container node src/index.js --pulado-lock
  exit 0
fi

exit "$rc"

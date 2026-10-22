#!/usr/bin/env bash
# scripts/docker-run.sh (tasks.md 5.2.1) — wrapper systemd-oneshot que roda
# a rotina inteira dentro do container oficial do Playwright (research.md
# Decision 2 — "nunca instalar browsers no host", mesma convenção de
# infra/hub/testes/hub-shell-e2e-browser.sh).
#
# Mutex real (dec-041, research.md Decision 8): `flock -w
# $LOCK_WAIT_SECONDS -E $CONFLICT_EXIT_CODE` envolve o `docker run` INTEIRO —
# o kernel garante liberação automática do lock mesmo se a execução anterior
# morrer sem limpar nada.
#
# ⚠️ POR QUE `-w` (esperar) e não `-n` (desistir na hora), desde 2026-10-22:
# este wrapper e o do ENRIQUECIMENTO compartilham o MESMO lock, e os dois
# timers disparam em `:00` — o import em 11/13/14:00:00 (RandomizedDelaySec=120)
# e o enriquecimento em `*:0/5` (RandomizedDelaySec=30). Com `-n`, bastava o
# enriquecimento ganhar a corrida por 1 segundo para o import do tick inteiro
# ser PULADO, e não há novo tick até o dia seguinte. Medido no incidente de
# 22/10: os dois dispararam no MESMO SEGUNDO nas 3 janelas (11:00:12, 13:00:22,
# 14:00:07), 3 de 3 ticks perdidos, e o dia 21 de dados não entrou. A distância
# entre os dois timers vinha encurtando: 37s (18/10), 59s, 14s, 2s, 0s.
# O enriquecimento dura 1-4 s (medido), então esperar resolve; o import tem
# `TimeoutStartUSec=infinity` na unit, então a espera não o mata.
# O timeout ainda existe de propósito: se o lock não liberar em
# $LOCK_WAIT_SECONDS, quem segura não é um enriquecimento normal (drenagem em
# massa, ou um import travado — já houve `falha_total` de ~1 h), e aí
# `pulado_lock` registrado é a resposta certa.
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
# Segundos que o import espera pelo lock antes de registrar `pulado_lock`.
# 60 s = 15x a duração máxima observada do enriquecimento (4 s), que é quem
# colide na prática. Só sobrescreva em teste (scripts/testar-lock.sh usa 2 s
# para provar o timeout sem esperar um minuto).
LOCK_WAIT_SECONDS="${ROBO_ENTREGO_LOCK_WAIT:-60}"

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
flock -w "$LOCK_WAIT_SECONDS" -E "$CONFLICT_EXIT_CODE" "$LOCKFILE" \
  docker run --rm \
    -v "${SCRIPT_DIR}:/work" \
    -v "${SECRETS_DIR}:${SECRETS_DIR}" \
    -w /work \
    "$PLAYWRIGHT_IMAGE" \
    node src/index.js
rc=$?
set -e

if [ "$rc" -eq "$CONFLICT_EXIT_CODE" ]; then
  echo "[docker-run] lock ocupado (${LOCKFILE}) apos esperar ${LOCK_WAIT_SECONDS}s — outra execução em andamento; registrando pulado_lock" >&2
  run_container node src/index.js --pulado-lock
  exit 0
fi

exit "$rc"

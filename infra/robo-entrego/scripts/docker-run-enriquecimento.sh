#!/usr/bin/env bash
# scripts/docker-run-enriquecimento.sh (hub-motorista-360 FASE 6, tasks.md
# 6.1.1) — wrapper systemd-oneshot para src/enriquecimento.js, mesmo padrão
# de scripts/docker-run.sh (Playwright só dentro do container oficial —
# research.md Decision 2, "nunca instalar browsers no host").
#
# Mutex com a rodada de importação diária (dec-039 — "uma raspagem por vez,
# robô prioritário", FR-005): usa o MESMO $LOCKFILE de docker-run.sh.
#
# ⚠️ CORRIGIDO EM 2026-10-22 — a premissa antiga estava errada. Ela dizia:
# "'Robô prioritário' emerge do próprio `flock -n`: quem já tem o lock corre;
# o outro desiste na hora... é sempre o enriquecimento quem cede, nunca o
# contrário." Mas `flock -n` é SIMÉTRICO: dá prioridade a quem CHEGA PRIMEIRO,
# não ao robô. "Sempre o enriquecimento cede" só valeria se ele nunca chegasse
# primeiro — e os dois timers disparam em `:00` (import 11/13/14:00:00 com
# RandomizedDelaySec=120; este, `*:0/5` com 30), então é uma CORRIDA. Quando
# este ganha, é o IMPORT que cede.
#
# Em 22/10 ele ganhou 3 de 3: os três ticks do import saíram `pulado_lock`
# (11:00:12, 13:00:22, 14:00:07 — mesmo segundo do enriquecimento) e o dia 21
# de dados não entrou. O import tem 3 chances por dia; este, 288. Perder uma
# rodada de enriquecimento custa 5 minutos; perder um tick do import custa um
# DIA, e os ADIANTAMENTOS dependem do faturamento que vem nele.
#
# A prioridade agora é EXPLÍCITA, não emergente: este wrapper NÃO INICIA dentro
# da janela de guarda em torno dos horários do import (lidos de config.json, a
# mesma fonte que gera o timer — nunca duplicados aqui). Quem já estava
# rodando segue até o fim; a guarda só impede COMEÇAR.
#
# Dimensionamento da guarda (medido em 22/10):
#   - uma rodada com fila vazia dura 2 s (mediana de 214 rodadas; máx. 6 s) —
#     para essa o `flock -w` do import já bastaria;
#   - uma rodada com FILA é longa: 60 s por motorista
#     (THROTTLE_MS_ENTRE_MOTORISTAS) + renovação de sessão a cada 3 motoristas.
#     A de 17:50 levou ~16 min para 16 motoristas. É esse caso que a guarda
#     existe para evitar, porque nenhum `-w` razoável o cobre.
#   - GUARDA_ANTES=20min cobre a drenagem observada com folga: a última rodada
#     permitida antes das 11h começa 10:39 e, com 16 motoristas, termina 10:55.
#   - O silêncio contínuo máximo é 25 min (20 antes + 5 depois), contra os
#     60 min do refresh token da EntreGô — o keep-alive NÃO morre. Isso importa:
#     sem keep-alive a sessão cai e o próximo import exige o código de 6 dígitos
#     por e-mail (o último login completo foi em 02/10; de lá para cá são 261
#     renovações sem e-mail nenhum).
#
# LIMITE CONHECIDO: fila maior que ~20 motoristas ainda pode invadir a janela se
# a rodada começar pouco antes da guarda. O `flock -w` do import (PR #295) dá a
# margem seguinte, e o `pulado_lock` continua registrado quando nada disso
# alcança.
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
    -e ENRIQ_THROTTLE_MS \
    -w /work \
    "$PLAYWRIGHT_IMAGE" \
    "$@"
}

# ---- guarda de janela do import (robô prioritário, explícito) -------------
# Horários lidos de config.json, a MESMA fonte de scripts/gerar-timer.sh — se o
# operador mudar o horário do import, a guarda acompanha sozinha.
GUARDA_ANTES_MIN="${ROBO_ENTREGO_GUARDA_ANTES_MIN:-20}"
GUARDA_DEPOIS_MIN="${ROBO_ENTREGO_GUARDA_DEPOIS_MIN:-5}"
CONFIG_IMPORT="${SCRIPT_DIR}/config.json"
# `ROBO_ENTREGO_AGORA_HHMM` e `ROBO_ENTREGO_DRY_RUN` existem SÓ para o teste
# (scripts/testar-guarda-janela.sh): sem eles a guarda só poderia ser exercitada
# esperando as 11h, e cada caso exigiria subir o container Playwright.
if [ -n "${ROBO_ENTREGO_AGORA_HHMM:-}" ]; then
  AGORA_MIN=$(( 10#${ROBO_ENTREGO_AGORA_HHMM%%:*} * 60 + 10#${ROBO_ENTREGO_AGORA_HHMM##*:} ))
else
  AGORA_MIN=$(( $(date +%H) * 60 + $(date +%M) ))
fi

if [ "$GUARDA_ANTES_MIN" != "0" ] && [ -r "$CONFIG_IMPORT" ]; then
  # `grep -o` em vez de jq: este wrapper não assume nada além de Docker no host.
  for hhmm in $(grep -oE '"[0-2][0-9]:[0-5][0-9]"' "$CONFIG_IMPORT" | tr -d '"'); do
    h=${hhmm%%:*}; m=${hhmm##*:}
    alvo=$(( 10#$h * 60 + 10#$m ))
    if [ "$AGORA_MIN" -ge $(( alvo - GUARDA_ANTES_MIN )) ] && [ "$AGORA_MIN" -le $(( alvo + GUARDA_DEPOIS_MIN )) ]; then
      echo "[enriquecimento] janela do import ${hhmm} (guarda -${GUARDA_ANTES_MIN}min/+${GUARDA_DEPOIS_MIN}min): nao inicio para nao tomar o lock do robo (dec-039, robo prioritario)" >&2
      exit 0
    fi
  done
fi

if [ -n "${ROBO_ENTREGO_DRY_RUN:-}" ]; then
  echo "[enriquecimento] dry-run: a guarda liberou; sairia para o flock agora" >&2
  exit 0
fi

set +e
flock -n -E "$CONFLICT_EXIT_CODE" "$LOCKFILE" \
  docker run --rm \
    -v "${SCRIPT_DIR}:/work" \
    -v "${SECRETS_DIR}:${SECRETS_DIR}" \
    -e ENRIQ_THROTTLE_MS \
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

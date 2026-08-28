#!/usr/bin/env bash
# scripts/testar-lock.sh (tasks.md 6.3.3, quickstart.md Scenario 7) — duas
# invocações de docker-run.sh quase simultâneas; a mutex real é o `flock -n`
# que docker-run.sh já aplica em volta do `docker run` inteiro (dec-041,
# research.md Decision 8) — este script não reimplementa nada, só dispara
# as 2 invocações e confere o resultado no log JSON Lines.
#
# ROBO_ENTREGO_SECRETS_DIR aponta pra um diretório scratch — NUNCA
# /var/lib/hub_secrets/robo-entrego real (comentário do próprio
# docker-run.sh: "sobrescreva só para testar o mecanismo de lock"). Sem
# credenciais no ambiente, `node src/index.js` falha rápido em
# `lerConfiguracao()` (config incompleta) ANTES de qualquer chamada de
# rede/Playwright — o teste exercita só o mutex, nunca toca o portal real.
#
# A verificação usa a mensagem em stderr ("[docker-run] lock ocupado...",
# só impressa quando `flock -n` retorna CONFLICT_EXIT_CODE=99), NÃO o log
# JSON Lines — achado confirmado nesta rodada (2026-08-28): quando
# ROBO_ENTREGO_SECRETS_DIR difere do default hardcoded em src/*.js
# (LOG_PATH_DEFAULT), a escrita do ramo `--pulado-lock` acontece DENTRO do
# filesystem efêmero do container (`--rm`), nunca visível no host — o
# próprio docker-run.sh já documenta esse comportamento ("o conteúdo
# dentro do container fica isolado do host quando o caminho não bate com
# os defaults do Node"). A mensagem de stderr é emitida pelo WRAPPER bash
# (fora do container) e prova o mesmo fato sem depender desse mount.
#
# Uso: infra/robo-entrego/scripts/testar-lock.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d)"
export ROBO_ENTREGO_SECRETS_DIR="$SCRATCH/hub_secrets/robo-entrego"
trap 'rm -rf "$SCRATCH"' EXIT

echo "=== testar-lock: ROBO_ENTREGO_SECRETS_DIR=$ROBO_ENTREGO_SECRETS_DIR ==="

"$SCRIPT_DIR/scripts/docker-run.sh" >"$SCRATCH/saida-1.log" 2>&1 &
PID1=$!
sleep 0.3
"$SCRIPT_DIR/scripts/docker-run.sh" >"$SCRATCH/saida-2.log" 2>&1 &
PID2=$!

wait "$PID1"; RC1=$?
wait "$PID2"; RC2=$?

echo "--- saida-1 (rc=$RC1) ---"; cat "$SCRATCH/saida-1.log"
echo "--- saida-2 (rc=$RC2) ---"; cat "$SCRATCH/saida-2.log"

CONFLITOS=$(grep -l 'lock ocupado' "$SCRATCH"/saida-*.log 2>/dev/null | wc -l | tr -d ' ')
if [ "${CONFLITOS:-0}" -eq 1 ]; then
  echo "TESTAR-LOCK: OK — exatamente 1 das 2 invocacoes encontrou flock -n ocupado e caiu no ramo --pulado-lock (a outra rodou sem interferencia)"
  exit 0
fi
echo "TESTAR-LOCK: FALHOU — esperava exatamente 1 invocacao com lock ocupado, obteve $CONFLITOS" >&2
exit 1

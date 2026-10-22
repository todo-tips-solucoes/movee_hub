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
#
# ⚠️ REESCRITO em 2026-10-22: até aqui este teste AFIRMAVA o comportamento que
# causou o incidente — ele exigia que 1 das 2 invocações recebesse "lock
# ocupado", o que era verdade com `flock -n` (desistir na hora). Desde a troca
# para `flock -w`, a 2ª invocação ESPERA e roda, e é isso que os cenários abaixo
# provam. Um teste que exige o defeito reprova a correção: por isso ele mudou
# junto, e não depois.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d)"
export ROBO_ENTREGO_SECRETS_DIR="$SCRATCH/hub_secrets/robo-entrego"
LOCKFILE="$ROBO_ENTREGO_SECRETS_DIR/robo-entrego.lock"
trap 'rm -rf "$SCRATCH"' EXIT
FALHAS=0

echo "=== testar-lock: ROBO_ENTREGO_SECRETS_DIR=$ROBO_ENTREGO_SECRETS_DIR ==="

# ---------------------------------------------------------------- cenário A
# Duas invocações quase simultâneas: a 2ª tem de ESPERAR a 1ª e rodar. Com o
# antigo `-n` ela pularia, que é exatamente o defeito de 22/10 (3 de 3 ticks
# perdidos porque o enriquecimento ganhou a corrida por segundos).
echo
echo "--- A: concorrência normal -> ninguem pula (a 2a espera) ---"
"$SCRIPT_DIR/scripts/docker-run.sh" >"$SCRATCH/a1.log" 2>&1 &
PID1=$!
sleep 0.3
"$SCRIPT_DIR/scripts/docker-run.sh" >"$SCRATCH/a2.log" 2>&1 &
PID2=$!
wait "$PID1"; RC1=$?
wait "$PID2"; RC2=$?
PULOU_A=$(grep -l 'lock ocupado' "$SCRATCH"/a[12].log 2>/dev/null | wc -l | tr -d ' ')
echo "    rc: $RC1 / $RC2 | invocacoes que pularam: $PULOU_A (esperado 0)"
if [ "${PULOU_A:-0}" -eq 0 ]; then
  echo "    OK — as duas rodaram; a 2a esperou o lock em vez de desistir"
else
  echo "    FALHOU — alguma invocacao ainda desistiu na hora (o -w nao esta valendo)" >&2
  sed -n '1,5p' "$SCRATCH"/a[12].log >&2
  FALHAS=$((FALHAS+1))
fi

# ---------------------------------------------------------------- cenário B
# O timeout CONTINUA protegendo: com o lock preso por mais tempo que a espera,
# a invocação desiste e registra `pulado_lock`. Usa ROBO_ENTREGO_LOCK_WAIT=2
# para provar em segundos o que o default (60 s) levaria um minuto para mostrar.
echo
echo "--- B: lock preso por 6s e espera de 2s -> pula com pulado_lock ---"
mkdir -p "$ROBO_ENTREGO_SECRETS_DIR"
flock "$LOCKFILE" sleep 6 &
SEGURADOR=$!
sleep 0.5
INICIO=$(date +%s)
ROBO_ENTREGO_LOCK_WAIT=2 "$SCRIPT_DIR/scripts/docker-run.sh" >"$SCRATCH/b.log" 2>&1
RCB=$?
DUR=$(( $(date +%s) - INICIO ))
wait "$SEGURADOR" 2>/dev/null || :
echo "    rc=$RCB | duracao ${DUR}s (esperado >= 2s: ele ESPEROU antes de desistir)"
if grep -q 'lock ocupado' "$SCRATCH/b.log" && [ "$DUR" -ge 2 ]; then
  echo "    OK — esperou os 2s, nao conseguiu o lock e registrou pulado_lock"
  grep -m1 'lock ocupado' "$SCRATCH/b.log" | sed 's/^/      /'
else
  echo "    FALHOU — nao registrou pulado_lock, ou nao esperou o timeout" >&2
  sed -n '1,5p' "$SCRATCH/b.log" >&2
  FALHAS=$((FALHAS+1))
fi

echo
if [ "$FALHAS" -eq 0 ]; then
  echo "TESTAR-LOCK: OK — 2 cenarios, 0 falhas (espera na concorrencia normal; desiste no timeout)"
  exit 0
fi
echo "TESTAR-LOCK: FALHOU — $FALHAS de 2 cenarios" >&2
exit 1

#!/usr/bin/env bash
# scripts/testar-guarda-janela.sh — prova a guarda de janela do import no
# docker-run-enriquecimento.sh ("robô prioritário" EXPLÍCITO, dec-039).
#
# Por que existe: até 22/10 a prioridade do robô era suposta emergir do
# `flock -n`, que é SIMÉTRICO — e no dia 22 o enriquecimento ganhou a corrida
# 3 de 3, o import saiu `pulado_lock` nas três janelas e o dia 21 de dados não
# entrou. A guarda é o que torna a prioridade real; este teste é o que impede
# ela de voltar a ser suposição.
#
# Usa ROBO_ENTREGO_AGORA_HHMM (hora simulada) e ROBO_ENTREGO_DRY_RUN (sai antes
# do flock) para exercitar todos os casos em 1 segundo, sem container e sem
# tocar o lock real.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="$SCRIPT_DIR/scripts/docker-run-enriquecimento.sh"
FALHAS=0

# Os horários vêm de config.json — a MESMA fonte que a guarda lê e que
# gerar-timer.sh usa. Se o operador mudar o config, o teste avisa em vez de
# afirmar contra um horário que não existe mais.
HORARIOS=$(grep -oE '"[0-2][0-9]:[0-5][0-9]"' "$SCRIPT_DIR/config.json" | tr -d '"' | tr '\n' ' ')
echo "horarios do import em config.json: $HORARIOS"
for h in 11:00 13:00 14:00; do
  case " $HORARIOS " in
    *" $h "*) : ;;
    *) echo "AVISO: $h nao esta mais no config.json — os casos deste teste assumem 11/13/14h" >&2 ;;
  esac
done
echo

# caso <hora-simulada> <BLOQUEIA|LIBERA> <por que>
caso() {
  hora="$1"; esperado="$2"; motivo="$3"
  saida=$(ROBO_ENTREGO_AGORA_HHMM="$hora" ROBO_ENTREGO_DRY_RUN=1 "$WRAPPER" sob-demanda 2>&1)
  rc=$?
  obtido="LIBERA"
  printf '%s' "$saida" | grep -q 'janela do import' && obtido="BLOQUEIA"
  if [ "$obtido" = "$esperado" ] && [ "$rc" -eq 0 ]; then
    printf '  OK      %s -> %-8s  %s\n' "$hora" "$obtido" "$motivo"
  else
    printf '  FALHOU  %s -> %-8s (esperado %s, rc=%s)  %s\n' "$hora" "$obtido" "$esperado" "$rc" "$motivo" >&2
    printf '%s\n' "$saida" | sed 's/^/            /' >&2
    FALHAS=$((FALHAS + 1))
  fi
}

echo "--- janela das 11:00, guarda default (-20min / +5min) ---"
caso 10:30 LIBERA   "31 min antes: fora da guarda"
caso 10:39 LIBERA   "21 min antes: ultimo tick permitido (drenagem de 16 min termina 10:55, antes das 11h)"
caso 10:40 BLOQUEIA "20 min antes: borda de entrada da guarda"
caso 10:59 BLOQUEIA "1 min antes: dentro"
caso 11:00 BLOQUEIA "a hora exata do import"
caso 11:05 BLOQUEIA "5 min depois: borda final"
caso 11:06 LIBERA   "6 min depois: a guarda ja passou"
echo
echo "--- as outras janelas do config (13:00 e 14:00) ---"
caso 12:50 BLOQUEIA "10 min antes das 13h"
caso 13:20 LIBERA   "entre as janelas de 13h e 14h: livre"
caso 13:40 BLOQUEIA "20 min antes das 14h"
caso 14:06 LIBERA   "depois da ultima janela do dia"
echo
echo "--- meia-noite e horarios sem guarda nenhuma ---"
caso 00:00 LIBERA   "madrugada: nenhum import por perto"
caso 03:30 LIBERA   "madrugada"
echo
echo "--- valvula de escape: ROBO_ENTREGO_GUARDA_ANTES_MIN=0 desliga a guarda ---"
saida=$(ROBO_ENTREGO_AGORA_HHMM=10:59 ROBO_ENTREGO_GUARDA_ANTES_MIN=0 ROBO_ENTREGO_DRY_RUN=1 "$WRAPPER" sob-demanda 2>&1)
if printf '%s' "$saida" | grep -q 'janela do import'; then
  echo "  FALHOU  guarda=0 deveria LIBERAR e bloqueou" >&2
  FALHAS=$((FALHAS + 1))
else
  echo "  OK      guarda=0 -> LIBERA (o operador pode desligar sem editar codigo)"
fi

echo
if [ "$FALHAS" -eq 0 ]; then
  echo "TESTAR-GUARDA: OK — 0 falhas"
  exit 0
fi
echo "TESTAR-GUARDA: FALHOU — $FALHAS caso(s)" >&2
exit 1

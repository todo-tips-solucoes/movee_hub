#!/usr/bin/env bash
# scripts/gerar-timer.sh (tasks.md 5.2.2, research.md Decision 7) — lê
# config.json (`horarios`, FR-009) e regenera as linhas `OnCalendar=` de
# `robo-entrego.timer` (unit ÚNICA com múltiplos `OnCalendar=`, decisão já
# tomada em Decision 7 — nenhuma unit templated por horário).
#
# Fuso: `horarios` são `HH:MM` em America/Sao_Paulo — mesmo fuso que o
# portal EntreGô usa (ACHADOS-PORTAL.md §3, header `X-Timezone:
# America/Sao_Paulo`) e o que um operador brasileiro naturalmente quer
# dizer ao escrever "06:00" num arquivo de configuração. `systemd.time(7)`
# aceita o fuso como SUFIXO do calendar spec (`OnCalendar=... <TZ>`,
# systemd.time(7) — verificado com `systemd-analyze calendar` neste host) —
# evita
# conversão manual para UTC e a ambiguidade de horário de verão que essa
# conversão manual introduziria (ladder rung 4: feature nativa da
# plataforma, não reinventar).
#
# `systemctl daemon-reload`/instalação ficam DOCUMENTADOS abaixo (impressos
# no fim) — este script NUNCA os executa (rito de produção do projeto; a
# instalação em /etc/systemd/system é ato manual do operador, mesmo padrão
# de infra/producao/README.md).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_JSON="${1:-${SCRIPT_DIR}/config.json}"
TIMER_UNIT="${SCRIPT_DIR}/robo-entrego.timer"

command -v jq >/dev/null 2>&1 || { echo "gerar-timer: jq é necessário" >&2; exit 1; }
[ -f "$CONFIG_JSON" ] || { echo "gerar-timer: config não encontrado em ${CONFIG_JSON}" >&2; exit 1; }

horarios="$(jq -r '.horarios[]?' "$CONFIG_JSON")"
[ -n "$horarios" ] || { echo "gerar-timer: ${CONFIG_JSON} sem .horarios[] (FR-009 exige ao menos 1)" >&2; exit 1; }

while IFS= read -r h; do
  [[ "$h" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] \
    || { echo "gerar-timer: horário inválido '${h}' em ${CONFIG_JSON} (esperado HH:MM)" >&2; exit 1; }
done <<< "$horarios"

{
  echo "# GERADO por scripts/gerar-timer.sh a partir de ${CONFIG_JSON#"$SCRIPT_DIR"/} — não editar OnCalendar= à mão, mudar horário = editar config.json + re-rodar este script (FR-009)."
  echo "[Unit]"
  echo "Description=Dispara a rotina robo-entrego nos horários de config.json"
  echo
  echo "[Timer]"
  while IFS= read -r h; do
    echo "OnCalendar=*-*-* ${h}:00 America/Sao_Paulo"
  done <<< "$horarios"
  echo "Persistent=true"
  echo "# Espalha o disparo — mesmo motivo de infra/producao/backup-producao.timer."
  echo "RandomizedDelaySec=120"
  echo
  echo "[Install]"
  echo "WantedBy=timers.target"
} > "$TIMER_UNIT"

n="$(printf '%s\n' "$horarios" | wc -l)"
echo "gerar-timer: ${TIMER_UNIT} regenerado com ${n} horário(s): $(printf '%s ' $horarios)"
echo
echo "gerar-timer: para aplicar (rito de produção — ato manual do operador, mesmo padrão de infra/producao/README.md):"
echo "  sudo ln -sf ${SCRIPT_DIR}/robo-entrego.service ${SCRIPT_DIR}/robo-entrego.timer /etc/systemd/system/"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable --now robo-entrego.timer"

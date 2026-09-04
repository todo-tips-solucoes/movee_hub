#!/usr/bin/env bash
# scripts/gerar-timer.sh (tasks.md 5.2.2, research.md Decision 7; estendido
# em tasks.md 6.1.1/research.md Decision 8) — gera unit(s) `.timer` a partir
# de um config.json, sem OnCalendar= editado à mão.
#
# 2 schemas suportados no MESMO script (reuso, não duplicação — ladder rung
# 2), detectados pelas chaves presentes no config:
#
#   (a) `.horarios[]` (config.json ORIGINAL do robô de importação diária,
#       já em produção desde 2026-08-28) -> gera SEMPRE `robo-entrego.timer`,
#       comportamento 100% preservado, zero mudança de código deste ramo.
#   (b) `.timers[]` (config NOVO, hub-motorista-360 FASE 6 — tasks.md 6.1.1)
#       -> 1 arquivo `<unit>.timer` por entrada, cada uma com seu próprio
#       `OnCalendar=`/`RandomizedDelaySec`/`Description`. Usado para os 2
#       timers do worker de enriquecimento EntreGô (sob-demanda + semestral,
#       Decision 7/8) — intervalo curto vs. duas vezes ao ano são cadências
#       incompatíveis com uma única unit de `horarios[]` HH:MM diários.
#
# Fuso: specs de calendário devem trazer o próprio sufixo de fuso quando
# fizer sentido (`America/Sao_Paulo` — mesmo fuso do header `X-Timezone` do
# portal EntreGô, ACHADOS-PORTAL.md §3/§9.3) — `systemd.time(7)` aceita o
# fuso como sufixo nativo do calendar spec, evitando conversão manual para
# UTC e a ambiguidade de horário de verão que essa conversão introduziria
# (ladder rung 4: feature nativa da plataforma). Validado neste host com
# `systemd-analyze calendar` quando disponível (ladder rung 4 de novo —
# nunca reimplementar o parser de calendar spec do systemd).
#
# `systemctl daemon-reload`/instalação ficam DOCUMENTADOS no fim (nunca
# executados por este script — rito de produção do projeto; instalação em
# /etc/systemd/system é ato manual do operador, mesmo padrão de
# infra/producao/README.md).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_JSON="${1:-${SCRIPT_DIR}/config.json}"

command -v jq >/dev/null 2>&1 || { echo "gerar-timer: jq é necessário" >&2; exit 1; }
[ -f "$CONFIG_JSON" ] || { echo "gerar-timer: config não encontrado em ${CONFIG_JSON}" >&2; exit 1; }

validar_calendar_spec() {
  # Best-effort: só valida de verdade se o host tiver systemd-analyze
  # (ladder rung 4). Sem ele, segue — o systemd real vai recusar no
  # daemon-reload do operador, que já é o gate de aplicação (nunca este script).
  command -v systemd-analyze >/dev/null 2>&1 || return 0
  systemd-analyze calendar "$1" >/dev/null 2>&1 \
    || { echo "gerar-timer: OnCalendar inválido '${1}' em ${CONFIG_JSON} (systemd-analyze calendar recusou)" >&2; exit 1; }
}

gerar_schema_horarios() {
  local timer_unit="${SCRIPT_DIR}/robo-entrego.timer"
  local horarios
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
  } > "$timer_unit"

  local n
  n="$(printf '%s\n' "$horarios" | wc -l)"
  echo "gerar-timer: ${timer_unit} regenerado com ${n} horário(s): $(printf '%s ' $horarios)"
  echo
  echo "gerar-timer: para aplicar (rito de produção — ato manual do operador, mesmo padrão de infra/producao/README.md):"
  echo "  sudo ln -sf ${SCRIPT_DIR}/robo-entrego.service ${timer_unit} /etc/systemd/system/"
  echo "  sudo systemctl daemon-reload"
  echo "  sudo systemctl enable --now robo-entrego.timer"
}

gerar_schema_timers() {
  local n_timers
  n_timers="$(jq '.timers | length' "$CONFIG_JSON")"
  [ "$n_timers" -gt 0 ] || { echo "gerar-timer: ${CONFIG_JSON} sem .timers[] (tasks.md 6.1.1 exige ao menos 1)" >&2; exit 1; }

  local gerados=()
  for i in $(seq 0 $((n_timers - 1))); do
    local unit description randomized
    unit="$(jq -r ".timers[$i].unit" "$CONFIG_JSON")"
    description="$(jq -r ".timers[$i].description" "$CONFIG_JSON")"
    randomized="$(jq -r ".timers[$i].randomizedDelaySec // 120" "$CONFIG_JSON")"
    [[ "$unit" =~ ^[a-zA-Z0-9._-]+$ ]] \
      || { echo "gerar-timer: unit inválida '${unit}' em ${CONFIG_JSON} (só [a-zA-Z0-9._-])" >&2; exit 1; }

    local oncalendars
    oncalendars="$(jq -r ".timers[$i].onCalendar[]?" "$CONFIG_JSON")"
    [ -n "$oncalendars" ] || { echo "gerar-timer: timer '${unit}' sem .onCalendar[] em ${CONFIG_JSON}" >&2; exit 1; }
    while IFS= read -r oc; do
      validar_calendar_spec "$oc"
    done <<< "$oncalendars"

    local timer_unit="${SCRIPT_DIR}/${unit}.timer"
    {
      echo "# GERADO por scripts/gerar-timer.sh a partir de ${CONFIG_JSON#"$SCRIPT_DIR"/} — não editar OnCalendar= à mão, mudar cadência = editar config-enriquecimento.json + re-rodar este script (tasks.md 6.1.1)."
      echo "[Unit]"
      echo "Description=${description}"
      echo
      echo "[Timer]"
      while IFS= read -r oc; do
        echo "OnCalendar=${oc}"
      done <<< "$oncalendars"
      echo "Persistent=true"
      echo "# Espalha o disparo — mesmo motivo de infra/producao/backup-producao.timer."
      echo "RandomizedDelaySec=${randomized}"
      echo
      echo "[Install]"
      echo "WantedBy=timers.target"
    } > "$timer_unit"
    gerados+=("$timer_unit")
    echo "gerar-timer: ${timer_unit} gerado ($(printf '%s\n' "$oncalendars" | wc -l) OnCalendar)"
  done

  echo
  echo "gerar-timer: para aplicar (rito de produção — ato manual do operador, mesmo padrão de infra/producao/README.md):"
  for t in "${gerados[@]}"; do
    local unit_name svc
    unit_name="$(basename "$t" .timer)"
    svc="${SCRIPT_DIR}/${unit_name}.service"
    echo "  sudo ln -sf ${svc} ${t} /etc/systemd/system/"
  done
  echo "  sudo systemctl daemon-reload"
  for t in "${gerados[@]}"; do
    echo "  sudo systemctl enable --now $(basename "$t")"
  done
}

if jq -e '.horarios' "$CONFIG_JSON" >/dev/null 2>&1; then
  gerar_schema_horarios
elif jq -e '.timers' "$CONFIG_JSON" >/dev/null 2>&1; then
  gerar_schema_timers
else
  echo "gerar-timer: ${CONFIG_JSON} não tem nem .horarios[] nem .timers[] — schema desconhecido" >&2
  exit 1
fi

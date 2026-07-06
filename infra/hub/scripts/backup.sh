#!/usr/bin/env bash
# =============================================================================
# backup.sh — backup manual one-shot (pg_dump -Fc) do banco do hub (§4.6).
# O dump é gravado no volume hub_*_backups via serviço `backup` do compose.
# O backup DIÁRIO automático é feito pelo backup-daemon.sh (serviço backup).
#
# Uso: infra/hub/scripts/backup.sh -f <compose.yml> -p <projeto> -e <env-file>
# =============================================================================
set -euo pipefail

COMPOSE_FILE="" PROJECT="" ENV_FILE=""
while getopts "f:p:e:" opt; do
  case "$opt" in
    f) COMPOSE_FILE="$OPTARG" ;;
    p) PROJECT="$OPTARG" ;;
    e) ENV_FILE="$OPTARG" ;;
    *) echo "uso: $0 -f compose.yml -p projeto -e env-file" >&2; exit 2 ;;
  esac
done
[ -n "$COMPOSE_FILE" ] && [ -n "$PROJECT" ] && [ -n "$ENV_FILE" ] || { echo "argumentos -f/-p/-e obrigatórios" >&2; exit 2; }

STAMP="$(date -u +%Y%m%d_%H%M%S)"
OUT="/backups/\${PGDATABASE}_manual_${STAMP}.dump"

docker compose -f "$COMPOSE_FILE" -p "$PROJECT" --env-file "$ENV_FILE" \
  exec -T backup bash -c "set -euo pipefail; pg_dump -Fc -f $OUT && ls -la $OUT"

echo "backup manual concluído: $OUT (no volume de backups do projeto $PROJECT)"

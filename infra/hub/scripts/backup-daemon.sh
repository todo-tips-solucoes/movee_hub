#!/usr/bin/env bash
# =============================================================================
# backup-daemon.sh — roda DENTRO do container `backup` (postgres:13) do compose
# do hub. Backup diário pg_dump -Fc às BACKUP_HOUR_UTC, retenção
# BACKUP_RETENTION_DAYS dias, em /backups (volume hub_*_backups). §4.6.
# Mantido como container (e não cron do host) para ficar 100% dentro do escopo
# da exceção hub-* — nenhum arquivo de sistema do host é tocado.
# =============================================================================
set -euo pipefail

HOUR="${BACKUP_HOUR_UTC:-03}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"

echo "[backup-daemon] iniciado: diário às ${HOUR}:00 UTC, retenção ${RETENTION}d, db=${PGDATABASE}"

while true; do
  now=$(date -u +%s)
  target=$(date -u -d "today ${HOUR}:00" +%s)
  if [ "$target" -le "$now" ]; then
    target=$(date -u -d "tomorrow ${HOUR}:00" +%s)
  fi
  sleep_s=$((target - now))
  echo "[backup-daemon] próximo backup em ${sleep_s}s ($(date -u -d "@$target" '+%F %T UTC'))"
  sleep "$sleep_s"

  stamp="$(date -u +%Y%m%d_%H%M%S)"
  out="/backups/${PGDATABASE}_${stamp}.dump"
  if pg_dump -Fc -f "$out"; then
    echo "[backup-daemon] OK: $out ($(stat -c%s "$out") bytes)"
  else
    echo "[backup-daemon] ERRO no pg_dump (mantendo loop)" >&2
    rm -f "$out"
  fi

  find /backups -name "${PGDATABASE}_*.dump" -mtime +"$RETENTION" -delete || true
done

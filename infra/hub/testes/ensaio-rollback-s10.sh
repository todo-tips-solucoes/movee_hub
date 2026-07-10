#!/usr/bin/env bash
# =============================================================================
# ensaio-rollback-s10.sh — S10, escopo item 5: ensaio de ROLLBACK de verdade
# no ambiente isolado hub-homolog (voltar imagem + restore testado), com log
# antes/depois. Espelha o §8 do RUNBOOK-CUTOVER.md em escala compose (em
# produção o comando equivalente é `docker service update --image <anterior>`).
#
# Passos:
#   1. ANTES: registra image-id do backend, contagens do banco e smoke.
#   2. Backup real (backup.sh → pg_dump -Fc no volume hub_homolog_backups).
#   3. Restore TESTADO (restore.sh: restaura num banco hub_restore e compara
#      contagens tabela a tabela — nunca toca o banco vivo).
#   4. "Deploy" de uma imagem NOVA sintética (FROM imagem atual + LABEL) no
#      lugar de hub-backend:homolog → recreate → smoke.
#   5. ROLLBACK: re-aponta hub-backend:homolog para a imagem ANTERIOR →
#      recreate → smoke → confirma que o image-id voltou ao registrado no
#      passo 1 e que as contagens do banco não mudaram.
#
# Só recursos hub-* (exceção G1). NUNCA toca envio-massa-homologacao_*/
# chatmasterveloz.
#
# Uso: infra/hub/testes/ensaio-rollback-s10.sh [dir-evidencias]
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$HUB_DIR/../.." && pwd)"
COMPOSE="$HUB_DIR/compose.hub.homolog.yml"
ENV_FILE="${HUB_HOMOLOG_ENV:-/var/lib/hub_secrets/.env.hub.homolog}"
PROJECT="hub-homolog"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
EVID="${1:-$REPO_DIR/docs/plans/hub-frota/evidencias/S10/rollback-$TS}"
mkdir -p "$EVID"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
smoke() { curl -sk -o /dev/null -w '%{http_code}' https://localhost:8443/hub/login; }
img_id() { docker inspect hub_homolog_backend --format '{{.Image}}'; }

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails + 1)); fi
}
contagens() {
  psql_t -tAc "SELECT 'Usuario='||count(*) FROM \"Usuario\""
  psql_t -tAc "SELECT 'Auditoria='||count(*) FROM \"Auditoria\""
  psql_t -tAc "SELECT 'ImportacaoArquivo='||count(*) FROM \"ImportacaoArquivo\""
  psql_t -tAc "SELECT 'FaturamentoLancamento='||count(*) FROM \"FaturamentoLancamento\""
}

{
  echo "═ 1. ANTES (baseline)"
  ID_ANTES="$(img_id)"
  echo "backend image-id ANTES: $ID_ANTES"
  echo "smoke ANTES: HTTP $(smoke)"
  echo "contagens ANTES:"; contagens

  echo
  echo "═ 2. Backup real (backup.sh)"
  "$HUB_DIR/scripts/backup.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE"

  echo
  echo "═ 3. Restore TESTADO (restore.sh — banco hub_restore + comparação de contagens)"
  if "$HUB_DIR/scripts/restore.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE"; then
    echo "PASS: restore testado (contagens conferidas pelo restore.sh)"
  else
    echo "FAIL: restore.sh falhou"; fails=$((fails + 1))
  fi

  echo
  echo "═ 4. Deploy simulado de imagem NOVA (FROM atual + LABEL, tag hub-backend:ensaio-nova)"
  docker tag hub-backend:homolog hub-backend:ensaio-prev
  printf 'FROM hub-backend:homolog\nLABEL com.moveelog.ensaio-s10="nova"\n' \
    | docker build -q -t hub-backend:ensaio-nova - >/dev/null
  docker tag hub-backend:ensaio-nova hub-backend:homolog
  dc up -d --no-build backend >/dev/null 2>&1
  sleep 5
  ID_NOVA="$(img_id)"
  echo "backend image-id com a 'nova': $ID_NOVA"
  [ "$ID_NOVA" != "$ID_ANTES" ] && echo "PASS: imagem efetivamente trocada" \
    || { echo "FAIL: imagem não trocou"; fails=$((fails + 1)); }
  echo "smoke com a 'nova': HTTP $(smoke)"

  echo
  echo "═ 5. ROLLBACK (voltar a imagem anterior — equivalente compose do service update --image <anterior>)"
  docker tag hub-backend:ensaio-prev hub-backend:homolog
  dc up -d --no-build backend >/dev/null 2>&1
  sleep 5
  ID_DEPOIS="$(img_id)"
  echo "backend image-id DEPOIS do rollback: $ID_DEPOIS"
  check "rollback devolve exatamente o image-id anterior" "$ID_DEPOIS" "$ID_ANTES"
  SM="$(smoke)"
  check "smoke pós-rollback = 200" "$SM" "200"
  echo "contagens DEPOIS (devem ser idênticas ao ANTES — nenhum dado tocado):"; contagens

  docker rmi hub-backend:ensaio-nova hub-backend:ensaio-prev >/dev/null 2>&1 || true

  echo
  if [ "$fails" = "0" ]; then
    echo "ENSAIO-ROLLBACK-S10: OK — imagem revertida + restore testado, ambiente íntegro"
  else
    echo "ENSAIO-ROLLBACK-S10: $fails check(s) FALHARAM"
  fi
} 2>&1 | tee "$EVID/rollback-ensaio.log"

# o bloco acima roda em subshell (pipe p/ tee) — $fails não sobrevive; o
# veredito vem do próprio log (FAIL: no início de linha)
FAILS_LOG="$(grep -c '^FAIL' "$EVID/rollback-ensaio.log" | tr -d '[:space:]')"
[ "${FAILS_LOG:-1}" = "0" ] && exit 0 || exit 1

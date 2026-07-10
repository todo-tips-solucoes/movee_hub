#!/usr/bin/env bash
# =============================================================================
# regressao-s10.sh — S10 (regressão geral + preparação de cutover), briefing
# docs/plans/hub-frota/briefings/s10-regressao-cutover.md, escopo item 1:
# agrega TODAS as suítes das fases S2–S9 numa EXECUÇÃO ÚNICA, com log por
# suíte e resumo final. Critério duro do briefing: zero vermelhos e zero
# flakies não explicados.
#
# O que roda (em ordem, sequencial — nunca em paralelo, lição anti-starvation
# 2026-06-11):
#   1. unit          npm run test:hub:unit (host, node --test; inclui
#                    hub-performance-dto.test.js, registrado nesta fase — a
#                    S7 criou o arquivo sem listá-lo no package.json)
#   2. integracao    npm run test:hub:integration (10 wrappers node --test →
#                    cada um orquestra seu próprio projeto hub-test-<runid>
#                    efêmero via infra/hub/testes/hub-*-integration.sh;
#                    inclui hub-performance.test.js, mesmo registro acima)
#   3. suítes .sh das fases sem wrapper node (cada uma com seu próprio
#      isolamento: stack efêmero hub-test-* OU leitura do hub-homolog):
#      auth, rbac, auditoria-admin, importações fase5, RLS importações,
#      migração de login, preflight negativo, isolamento (20 testes S1),
#      E2E homolog (S2), shell E2E homolog (S3), importações E2E homolog (S4)
#   4. E2E completo do envio em massa (S8, 62 asserts):
#      docs/specs/hub-envio-massa/e2e-hub-envio-massa.sh
#   5. Playwright (container mcr.microsoft.com/playwright, nunca no host):
#      browser E2E do shell (axe/menus/sessão) + a11y smokes (S8 e S9)
#   6. scan-auditoria-sensivel.sh (--self-test + varredura real no
#      hub-homolog)
#
# NUNCA toca produção (envio-massa-homologacao_*/chatmasterveloz): só stacks
# efêmeros hub-test-* e o ambiente isolado hub-homolog (exceção G1).
#
# Uso: infra/hub/testes/regressao-s10.sh [dir-evidencias]
#      (default: docs/plans/hub-frota/evidencias/S10/regressao-<ts>/)
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$HUB_DIR/../.." && pwd)"
BACKEND_DIR="$REPO_DIR/app_homologacao/backend"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
EVID="${1:-$REPO_DIR/docs/plans/hub-frota/evidencias/S10/regressao-$TS}"
mkdir -p "$EVID"

HOMOLOG_ENV="${HUB_HOMOLOG_ENV:-/var/lib/hub_secrets/.env.hub.homolog}"
COMPOSE_HOMOLOG="$HUB_DIR/compose.hub.homolog.yml"

NOMES=(); STATUS=(); DUR=()
fails=0

run_suite() { # run_suite <slug> <descricao> <cmd...>
  local slug="$1" desc="$2"; shift 2
  local log="$EVID/$slug.log" ini fim rc
  echo "════ [$(date -u +%H:%M:%SZ)] $slug — $desc"
  ini=$(date +%s)
  ( "$@" ) >"$log" 2>&1; rc=$?
  fim=$(date +%s)
  NOMES+=("$slug"); DUR+=($((fim - ini)))
  if [ "$rc" -eq 0 ]; then
    STATUS+=("PASS")
    echo "     PASS ($((fim - ini))s) — log: $log"
  else
    STATUS+=("FAIL(rc=$rc)")
    fails=$((fails + 1))
    echo "     FAIL rc=$rc ($((fim - ini))s) — últimas linhas de $log:"
    tail -15 "$log" | sed 's/^/     | /'
  fi
}

npm_backend() { (cd "$BACKEND_DIR" && npm run "$1"); }

echo "regressao-s10: evidências em $EVID"
echo "início: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# 1-2. suítes node (host)
run_suite 01-hub-unit          "npm run test:hub:unit (24 arquivos)"          npm_backend test:hub:unit
run_suite 02-hub-integration   "npm run test:hub:integration (10 wrappers → stacks efêmeros)" npm_backend test:hub:integration

# 3. suítes .sh sem wrapper node
run_suite 03-auth              "hub-auth-integration.sh (stack efêmero)"      "$HUB_DIR/testes/hub-auth-integration.sh"
run_suite 04-rbac              "hub-rbac-integration.sh (stack efêmero)"      "$HUB_DIR/testes/hub-rbac-integration.sh"
run_suite 05-auditoria-admin   "hub-auditoria-admin-integration.sh (stack efêmero)" "$HUB_DIR/testes/hub-auditoria-admin-integration.sh"
run_suite 06-import-fase5      "hub-importacoes-fase5-integration.sh (stack efêmero)" "$HUB_DIR/testes/hub-importacoes-fase5-integration.sh"
run_suite 07-rls-importacoes   "hub-rls-importacoes-integration.sh (stack efêmero)" "$HUB_DIR/testes/hub-rls-importacoes-integration.sh"
run_suite 08-migracao-login    "migracao-login-integration.sh (stack efêmero)" "$HUB_DIR/testes/migracao-login-integration.sh"
run_suite 09-preflight-neg     "preflight-negativo.sh (teste negativo S1)"    "$HUB_DIR/testes/preflight-negativo.sh"
run_suite 10-isolamento        "isolamento.sh (20 testes de isolamento S1)"   "$HUB_DIR/testes/isolamento.sh"
run_suite 11-e2e-homolog       "hub-e2e-homolog.sh (S2, hub-homolog)"         "$HUB_DIR/testes/hub-e2e-homolog.sh"
run_suite 12-shell-e2e         "hub-shell-e2e-homolog.sh (S3, hub-homolog)"   "$HUB_DIR/testes/hub-shell-e2e-homolog.sh"
run_suite 13-import-e2e        "hub-importacoes-e2e-homolog.sh (S4, hub-homolog)" "$HUB_DIR/testes/hub-importacoes-e2e-homolog.sh"

# 4. E2E completo do envio em massa (S8, 62 asserts)
run_suite 14-envio-massa-e2e   "e2e-hub-envio-massa.sh (S8, 62 asserts, stack efêmero)" "$REPO_DIR/docs/specs/hub-envio-massa/e2e-hub-envio-massa.sh"

# 5. Playwright (container oficial)
run_suite 15-browser-e2e       "hub-shell-e2e-browser.sh (Playwright: axe/menus/sessão)" "$HUB_DIR/testes/hub-shell-e2e-browser.sh"
run_suite 16-a11y-envio-massa  "hub-envio-massa-a11y-smoke.sh (Playwright a11y S8)" "$HUB_DIR/testes/hub-envio-massa-a11y-smoke.sh"
run_suite 17-a11y-auditoria    "hub-auditoria-admin-a11y-smoke.sh (Playwright a11y S9)" "$HUB_DIR/testes/hub-auditoria-admin-a11y-smoke.sh"

# 6. varredura de dados sensíveis na auditoria (self-test + real)
run_suite 18-scan-selftest     "scan-auditoria-sensivel.sh --self-test"       "$HUB_DIR/scripts/scan-auditoria-sensivel.sh" -f "$COMPOSE_HOMOLOG" -p hub-homolog -e "$HOMOLOG_ENV" --self-test
run_suite 19-scan-real         "scan-auditoria-sensivel.sh (hub-homolog, 500 eventos)" "$HUB_DIR/scripts/scan-auditoria-sensivel.sh" -f "$COMPOSE_HOMOLOG" -p hub-homolog -e "$HOMOLOG_ENV"

# ── resumo ──────────────────────────────────────────────────────────────────
RESUMO="$EVID/resumo.md"
{
  echo "# Regressão S10 — execução única ($TS)"
  echo
  echo "| # | suíte | status | duração (s) |"
  echo "|---|-------|--------|-------------|"
  for i in "${!NOMES[@]}"; do
    echo "| $((i + 1)) | ${NOMES[$i]} | ${STATUS[$i]} | ${DUR[$i]} |"
  done
  echo
  echo "Total de suítes: ${#NOMES[@]} — falhas: $fails"
  echo
  echo "Gerado por infra/hub/testes/regressao-s10.sh em $(date -u +%Y-%m-%dT%H:%M:%SZ)."
} >"$RESUMO"

echo
echo "════ RESUMO (também em $RESUMO)"
for i in "${!NOMES[@]}"; do
  printf '  %-22s %-12s %6ss\n' "${NOMES[$i]}" "${STATUS[$i]}" "${DUR[$i]}"
done

if [ "$fails" = "0" ]; then
  echo "REGRESSAO-S10: OK — ${#NOMES[@]} suítes verdes em execução única"
  exit 0
else
  echo "REGRESSAO-S10: $fails suíte(s) FALHARAM" >&2
  exit 1
fi

#!/usr/bin/env bash
# scripts/testar-fixture-e2e.sh (tasks.md 6.3.1/6.3.2) — roda os 5 cenários
# de quickstart.md (Scenarios 1-5) com um browser Chromium REAL dentro do
# container oficial `mcr.microsoft.com/playwright` (mesma convenção de
# infra/hub/testes/hub-shell-e2e-browser.sh — nunca instalar browser no
# host), contra a fixture/mock do portal EntreGô (test/e2e-fixture/) —
# NUNCA contra o portal real (research.md Decision 2, incidente
# PerimeterX 2026-08-28).
#
# Usa `node --test` (runner nativo do Node) com o `playwright` já
# instalado em node_modules (montado do host) — SEM `npm install` dentro
# do container, então este driver NÃO reescreve package-lock.json (gotcha
# documentado em CLAUDE.md: o bind mount do container reescreve o lockfile
# com outra versão do npm quando `npm install` roda lá dentro).
#
# Uso: infra/robo-entrego/scripts/testar-fixture-e2e.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAYWRIGHT_IMAGE="${ROBO_ENTREGO_PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.62.1-jammy}"

echo "=== testar-fixture-e2e: $PLAYWRIGHT_IMAGE — node --test test/e2e-fixture/scenarios.test.js ==="
docker run --rm --memory=1g \
  -v "${SCRIPT_DIR}:/work" \
  -w /work \
  "$PLAYWRIGHT_IMAGE" \
  node --test test/e2e-fixture/scenarios.test.js

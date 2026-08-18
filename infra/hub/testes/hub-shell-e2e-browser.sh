#!/usr/bin/env bash
# =============================================================================
# hub-shell-e2e-browser.sh — hub-shell S3, tasks.md FASE 6 (onda BROWSER):
# 6.2.1 (ModuleNav difere por papel), 6.2.5 (sessão expira em meio de ação),
# 6.3.1/6.3.2 (axe >=95 nas 6 telas novas). Roda Playwright/@axe-core DENTRO
# da imagem oficial `mcr.microsoft.com/playwright` (versão pinada, Chromium +
# deps de SO já embutidas) — NUNCA `npx playwright install --with-deps`/apt
# no host (bash-guard.sh bloqueia; VPSTodo é produção do cliente).
#
# Seeds efêmeros (contas e2e-teste-shell-browser-*@example.test, empresa_ids
# sintéticos 950101/950102, faixa reservada — distinta de 940001/2 do S2 e
# 950001/2 do driver API hub-shell-e2e-homolog.sh, para não colidir se os 3
# scripts rodarem na mesma janela). Cleanup em `trap`, mesmo em falha
# (superuser do banco bypassa RLS só para a limpeza — mesmo padrão já
# revisado). O ambiente hub-homolog NUNCA é derrubado.
#
# Uso: infra/hub/testes/hub-shell-e2e-browser.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$HUB_DIR/../.." && pwd)"
FRONTEND_DIR="$REPO_DIR/app_homologacao/frontend_v2"
ENV_FILE="${HUB_HOMOLOG_ENV:-/var/lib/hub_secrets/.env.hub.homolog}"
COMPOSE="$HUB_DIR/compose.hub.homolog.yml"
PROJECT="hub-homolog"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.61.1-jammy"
TMP="$(mktemp -d)"
EVID_DIR="$REPO_DIR/docs/plans/hub-frota/evidencias/S3"
mkdir -p "$EVID_DIR"
RUN_LOG="$EVID_DIR/fase6-browser-run-$(date -u +%Y%m%dT%H%M%SZ).log"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
HUB_DOMAIN="$(get_var HUB_DOMAIN "$ENV_FILE")"; HUB_HTTPS_PORT="$(get_var HUB_HTTPS_PORT "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
node_e() { dc exec -T backend node -e "$1" "${@:2}"; }

if [ "$(hostname)" != "VPSTodo" ]; then
  echo "ABORTADO: host inesperado '$(hostname)' (esperado VPSTodo)" >&2; exit 2
fi

echo "=== rito anti-starvation: estado do host ANTES ==="
free -h
swapon --show
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'hub_homolog|envio-massa-homologacao' || true
AVAIL_KB=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
if [ "${AVAIL_KB:-0}" -lt 2097152 ]; then
  echo "ABORTADO: RAM disponível < 2Gi — não prosseguir (lição 2026-06-11)" >&2
  exit 2
fi
for svc in hub_homolog_frontend hub_homolog_backend hub_homolog_traefik envio-massa-homologacao_backend_homologacao envio-massa-homologacao_frontend_v2_homologacao; do
  st="$(docker ps --format '{{.Names}}\t{{.Status}}' | grep "^${svc}" | awk '{print $2}')"
  case "$st" in
    Up*) : ;;
    *) echo "ABORTADO: serviço '$svc' não está Up (obtido: '${st:-ausente}')" >&2; exit 2 ;;
  esac
done
echo "=== rito anti-starvation: OK, prosseguindo ==="

cleanup_rows() {
  echo; echo "=== cleanup: removendo linhas e2e-teste-shell-browser-* (owner bypassa RLS) ==="
  dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" <<'SQL' || true
SET session_replication_role = replica;
DELETE FROM "Auditoria"
  WHERE usuario_id IN (SELECT id FROM "Usuario" WHERE email LIKE 'e2e-teste-shell-browser-%')
     OR (detalhes->>'email') LIKE 'e2e-teste-shell-browser-%';
DELETE FROM "SessaoRefresh"
  WHERE usuario_id IN (SELECT id FROM "Usuario" WHERE email LIKE 'e2e-teste-shell-browser-%');
DELETE FROM "UsuarioEntidade"
  WHERE usuario_id IN (SELECT id FROM "Usuario" WHERE email LIKE 'e2e-teste-shell-browser-%');
DELETE FROM "Usuario" WHERE email LIKE 'e2e-teste-shell-browser-%';
DELETE FROM "ModuloEntidade" WHERE empresa_id IN (950101, 950102);
-- Seed de performance (0051). A ordem importa: os fatos referenciam a
-- importação e o entregador por FK.
DELETE FROM "PerformanceTurno"
  WHERE id_empresa IN (950101, 950102)
    AND importacao_id IN (SELECT id FROM "ImportacaoArquivo"
                          WHERE nome_arquivo = 'e2e-shell-browser-turno.csv');
DELETE FROM "PerformanceMeta" WHERE id_empresa IN (950101, 950102);
DELETE FROM "ImportacaoArquivo" WHERE nome_arquivo = 'e2e-shell-browser-turno.csv';
DELETE FROM "Entregador" WHERE id_empresa IN (950101, 950102) AND nome = 'E2E Turno Duas Pracas';
REFRESH MATERIALIZED VIEW mv_performance_dia;
SQL
  echo "=== cleanup: concluído ==="
  echo "=== estado do host DEPOIS ==="
  free -h
  docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'hub_homolog|envio-massa-homologacao' || true
  rm -rf "$TMP"
}
trap cleanup_rows EXIT

# ---- seeds --------------------------------------------------------------------
PAPEL_ADMIN="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_entidade'" | tr -d '[:space:]')"
PAPEL_OPER="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='operador'" | tr -d '[:space:]')"
[ -n "$PAPEL_ADMIN" ] && [ -n "$PAPEL_OPER" ] || { echo "FAIL: papeis 0007 ausentes"; exit 1; }

E_A=950101; E_B=950102
SENHA='SenhaShellE2eBrowser#Homolog1'
HASH="$(node_e "require('bcrypt').hash(process.argv[1],10).then(h=>{process.stdout.write(h);process.exit(0);});" "$SENHA" 2>"$TMP/h.log" | tr -d '[:space:]')"
[ -n "$HASH" ] || { echo "FAIL: hash bcrypt"; cat "$TMP/h.log"; exit 1; }

# Sufixo único por execução — achado desta onda: routes/hub-auth.js tem
# rate limiter em /auth/login (chave IP:email, max=10/15min). Sem sufixo,
# reexecuções de debug em sequência (mesmo IP, mesmo e-mail) esgotam o
# limite e produzem 429 que nada tem a ver com bugs reais do shell. Com
# e-mail único por execução, cada rodada começa com contador zerado para
# aquela chave (a limpeza em trap continua cobrindo TODOS os sufixos via
# LIKE 'e2e-teste-shell-browser-%').
RUN_SUFFIX="$(date -u +%H%M%S)"
ADMIN_EMAIL="e2e-teste-shell-browser-admin-${RUN_SUFFIX}@example.test"
OPERADOR_EMAIL="e2e-teste-shell-browser-operador-${RUN_SUFFIX}@example.test"

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('$ADMIN_EMAIL',    '$HASH', 'E2E Shell Browser Admin Entidade', true),
  ('$OPERADOR_EMAIL', '$HASH', 'E2E Shell Browser Operador', true);
SQL
UID_ADMIN="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='$ADMIN_EMAIL'" | tr -d '[:space:]')"
UID_OPER="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='$OPERADOR_EMAIL'" | tr -d '[:space:]')"
[ -n "$UID_ADMIN" ] && [ -n "$UID_OPER" ] || { echo "FAIL: seed Usuario"; exit 1; }

# admin com 2 vínculos (ramo "escolha" -> 6.2.1/6.2.5/axe selecionar-entidade);
# operador com 1 único vínculo (ramo "auto-seleção" -> axe dashboard/perfil).
psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_ADMIN, $E_A, $PAPEL_ADMIN, true),
  ($UID_ADMIN, $E_B, $PAPEL_ADMIN, true),
  ($UID_OPER,  $E_A, $PAPEL_OPER,  true);
SQL

# Achado desta onda (o "Nenhum módulo disponível" apareceu no primeiro run
# de verdade — a suíte API S2/S3, hub-shell-e2e-homolog.sh, NUNCA precisou
# disso porque não olha o DOM/ModuleNav): `GET /me` só inclui um módulo em
# `modulos[]` se ELE ESTIVER ATIVO PARA A ENTIDADE (ModuloEntidade.ativo=true,
# routes/hub-me.js linhas 122-133) *E* a pessoa tiver permissão no módulo —
# ter a permissão sozinha (Papel/PapelPermissao) NÃO basta. `950101`/`950102`
# são empresas sintéticas novas, sem nenhuma linha em `ModuloEntidade` — sem
# este seed, ModuleNav fica vazio (`return null`) para QUALQUER papel.
psql_t <<SQL >/dev/null
INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo)
SELECT m.id, e.empresa_id, true
FROM "Modulo" m
CROSS JOIN (VALUES ($E_A), ($E_B)) AS e(empresa_id)
ON CONFLICT (modulo_id, empresa_id) DO UPDATE SET ativo = true;
SQL
# Seed de PERFORMANCE (0051): um turno do MESMO entregador em DUAS sub-praças,
# que é o caso em que a tela mentia — a lista mostrava 25,00% e 12,50% em duas
# linhas, o card mostrava 37,50% para o mesmo dia da mesma pessoa, e a meta
# (cadastrada por praça × TURNO) era julgada duas vezes.
#
# (1h + 30min) / 4h = 37,50%; ofertadas 8+4=12; aceitas 6+2=8 -> 66,67% de
# aceitação, contra a meta de 90% que o seed grava logo abaixo: a linha TEM de
# sair marcada como abaixo da meta, uma vez só.
psql_t <<SQL >/dev/null
INSERT INTO "Entregador" (id_empresa, id_externo, nome, ativo, motorista_id)
VALUES ($E_A, gen_random_uuid(), 'E2E Turno Duas Pracas', true, NULL)
ON CONFLICT DO NOTHING;
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, nome_arquivo, hash_sha256, tamanho_bytes, status)
VALUES ($E_A, 'performance', 'e2e-shell-browser-turno.csv', repeat('c', 64), 10, 'completed_with_errors')
ON CONFLICT DO NOTHING;
SQL
ENT_TURNO="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_A AND nome='E2E Turno Duas Pracas'" | tr -d '[:space:]')"
IMP_TURNO="$(psql_t -tAc "SELECT id FROM \"ImportacaoArquivo\" WHERE id_empresa=$E_A AND nome_arquivo='e2e-shell-browser-turno.csv'" | tr -d '[:space:]')"
[ -n "$ENT_TURNO" ] && [ -n "$IMP_TURNO" ] || { echo "FAIL: seed de performance do E2E"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "PerformanceTurno"
  (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca, praca,
   tempo_disponivel_pct, tempo_disponivel, corridas_ofertadas, corridas_aceitas, corridas_rejeitadas,
   corridas_completadas, corridas_canceladas, pedidos_concluidos, taxas_centavos, hash_linha)
VALUES
  ($E_A, $IMP_TURNO, $ENT_TURNO, CURRENT_DATE - 1, 'ALMOCO 11H30-15H29', '04:00:00', 'E2E ZONA SUL', 'E2E SAO PAULO',
   90.00, '01:00:00', 8, 6, 2, 5, 1, 5, 1500, md5('e2e-shell-browser-multipraca-a')),
  ($E_A, $IMP_TURNO, $ENT_TURNO, CURRENT_DATE - 1, 'ALMOCO 11H30-15H29', '04:00:00', 'E2E CENTRO', 'E2E SAO PAULO',
   20.00, '00:30:00', 4, 2, 2, 2, 0, 2, 500, md5('e2e-shell-browser-multipraca-b'))
ON CONFLICT DO NOTHING;
INSERT INTO "PerformanceMeta" (id_empresa, praca, periodo, indicador, valor)
VALUES ($E_A, 'E2E SAO PAULO', 'ALMOCO 11H30-15H29', 'aceitacao', 0.9000)
ON CONFLICT DO NOTHING;
REFRESH MATERIALIZED VIEW mv_performance_dia;
SQL
echo "=== seeds OK: admin(2 vínculos)=$ADMIN_EMAIL operador(1 vínculo)=$OPERADOR_EMAIL — módulos ativados p/ $E_A/$E_B; turno multi-praça em $E_A ==="

# ---- Playwright dentro da imagem oficial (zero apt/npx install no host) ------
BASE_URL="https://$HUB_DOMAIN:$HUB_HTTPS_PORT"
echo "=== Playwright ($PLAYWRIGHT_IMAGE) contra $BASE_URL (network host + /etc/hosts local) ==="
set -o pipefail
docker run --rm --memory=1g --network host \
  --add-host "$HUB_DOMAIN:127.0.0.1" \
  -e HUB_E2E_BASE_URL="$BASE_URL" \
  -e HUB_E2E_ADMIN_EMAIL="$ADMIN_EMAIL" \
  -e HUB_E2E_OPERADOR_EMAIL="$OPERADOR_EMAIL" \
  -e HUB_E2E_SENHA="$SENHA" \
  -e CI=true \
  -v "$FRONTEND_DIR:/work" \
  -w /work \
  "$PLAYWRIGHT_IMAGE" \
  bash -lc 'npm install --no-audit --no-fund --loglevel=error && npx playwright test -c playwright.config.hub.ts' \
  2>&1 | tee "$RUN_LOG"
PW_EXIT=${PIPESTATUS[0]}
set +o pipefail

# 6.5.1 — prints por papel: o container só enxerga frontend_v2 (bind mount),
# então os specs gravam em tests/e2e-hub-browser/.evidencias/ (dentro do
# mount, visível também no host); copiamos daqui pro diretório canônico de
# evidências da fase, que o container NÃO alcança.
EVID_SRC="$FRONTEND_DIR/tests/e2e-hub-browser/.evidencias"
if [ -d "$EVID_SRC" ]; then
  cp -v "$EVID_SRC"/*.png "$EVID_DIR/" 2>/dev/null || true
  rm -rf "$EVID_SRC"
fi

echo
echo "=== log completo: $RUN_LOG ==="
echo "=== evidências (prints 6.5.1) em: $EVID_DIR ==="
if [ "$PW_EXIT" = "0" ]; then
  echo "HUB-SHELL-E2E-BROWSER: OK — Playwright (6.2.1/6.2.3/6.2.5/6.3) verde"
else
  echo "HUB-SHELL-E2E-BROWSER: Playwright FALHOU (exit=$PW_EXIT)" >&2
fi
exit "$PW_EXIT"

#!/usr/bin/env bash
# =============================================================================
# hub-adiantamentos-categorias-e2e-browser.sh — frente "Categorias do adiantamento: modo
# Todas, exceto as marcadas" (PLANO-CATEGORIAS-TODAS-EXCETO §3 C1-C5, onda W4).
#
# Diferente do hub-adiantamentos-e2e-browser.sh (que stuba TODO o /api no browser), este roda
# contra backend + PostgREST + banco REAIS num stack efêmero hub-test-<runid> (mesmo padrão do
# hub-campanhas-e2e-browser.sh): UM container oficial do Playwright com o frontend_v2 (:3005); cada
# fase é um spec rodado por `docker exec`, e o banco é conferido/mexido ENTRE as fases.
#
#   fase 1  Configurações: aviso âmbar ("Só as marcadas") e azul ("Todas, exceto"); trocar o modo
#           pré-marca Indicadores; marcar mais uma exceção; salvar; reabrir.
#   banco   a lista salva tem modo:todas; modos das outras 2 listas intactos.
#   banco   efeito no dinheiro: a produção do motorista semeado soma a categoria NOVA e exclui
#           Indicadores e a exceção marcada (valor exato), contra o controle da versão anterior.
#   banco   solicitação processada com a config em modo todas guarda o snapshot com os tokens.
#   fase 2  detalhe da solicitação traduzido ("Todas, exceto: …", sem token cru); voltar a
#           "Só as marcadas" limpa as marcações.
#
# E2E_KEEP=1  não derruba o stack no fim (só para depurar; derrube à mão depois).
# Uso: infra/hub/testes/hub-adiantamentos-categorias-e2e-browser.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$HUB_DIR/../.." && pwd)"
FRONTEND_DIR="$REPO_DIR/app_homologacao/frontend_v2"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)-$$"
PROJECT="hub-test-$RUNID"
PW="$PROJECT-pw"
TMP="$(mktemp -d)"
PLAYWRIGHT_IMAGE="mcr.microsoft.com/playwright:v1.61.1-jammy"
EVID_DIR="$REPO_DIR/docs/specs/adiantamento-motorista/evidencias/categorias-todas"
mkdir -p "$EVID_DIR"
RUN_LOG="$EVID_DIR/categorias-e2e-browser-run-$(date -u +%Y%m%dT%H%M%SZ).log"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }
PGRST_JWT_SECRET_VAL="$(get_var PGRST_JWT_SECRET "$ENV_FILE")"
[ -n "$PGRST_JWT_SECRET_VAL" ] || { echo "PGRST_JWT_SECRET ausente em $ENV_FILE" >&2; exit 2; }
export POSTGREST_API_KEY="$PGRST_JWT_SECRET_VAL"

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
own() { psql_t -tAc "$1" 2>&1 | tr -d '\r'; }
node_e() { dc exec -T backend node -e "$1" "${@:2}"; }
worker() { # chama uma função do worker de adiantamentos com a claim certa (como o backend faz)
  psql_t -tA 2>&1 <<SQL | grep -vE '^(BEGIN|COMMIT|SET)$' | grep -v '^$' | grep -v '^{"hub_'
BEGIN;
SELECT set_config('request.jwt.claims', '{"hub_adiantamento_worker":true}', true);
SET ROLE authenticated;
$1
COMMIT;
SQL
}

fails=0; passes=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; passes=$((passes + 1)); else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails + 1)); fi
}

cleanup() {
  echo; echo "=== cleanup ==="
  if [ -n "${E2E_KEEP:-}" ]; then
    echo "E2E_KEEP: stack MANTIDO ($PROJECT, container $PW) — derrube à mão: docker rm -f $PW; docker compose -f $COMPOSE -p $PROJECT --env-file $ENV_FILE down -v --rmi local"
  else
    docker rm -f "$PW" >/dev/null 2>&1 || true
    dc down -v --rmi local --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP"
  echo "=== conferindo package-lock.json (gotcha do container Playwright) ==="
  if ! git -C "$FRONTEND_DIR" diff --quiet -- package-lock.json 2>/dev/null; then
    echo "AVISO: package-lock.json de $FRONTEND_DIR foi alterado pelo container — revertendo" >&2
    git -C "$FRONTEND_DIR" checkout -- package-lock.json
  else
    echo "package-lock.json intacto em $FRONTEND_DIR"
  fi
  echo "=== sobras hub-test-* (deve ser 0) ==="
  docker ps -a --format '{{.Names}}' | grep '^hub-test-' || echo "(nenhum container)"
  docker volume ls --format '{{.Name}}' | grep '^hub-test-' || echo "(nenhum volume)"
  docker network ls --format '{{.Name}}' | grep '^hub-test-' || echo "(nenhuma rede)"
  echo "=== estado do host DEPOIS ==="; free -h; df -h /
}
trap cleanup EXIT

# ------------------------------ guardas de recurso ------------------------------
echo "df -h / e swap antes do build:"; df -h /; swapon --show
AVAIL_KB=$(awk '/MemAvailable/{print $2}' /proc/meminfo)
SWAP_FREE_KB=$(awk '/SwapFree/{print $2}' /proc/meminfo)
DISK_AVAIL_KB=$(df -Pk / | awk 'NR==2{print $4}')
[ "${AVAIL_KB:-0}" -ge 2097152 ] || { echo "ABORTADO: RAM disponível < 2Gi (lição 2026-06-11)" >&2; exit 2; }
[ "${SWAP_FREE_KB:-0}" -ge 1048576 ] || { echo "ABORTADO: swap livre < 1Gi" >&2; exit 2; }
[ "${DISK_AVAIL_KB:-0}" -ge 20971520 ] || { echo "ABORTADO: disco livre em / < 20Gi (lição 2026-08-30)" >&2; exit 2; }

# ------------------------------ stack + seeds + frontend ------------------------------
SENHA='SenhaSinteticaCategorias#1'
ADMIN_EMAIL="cat-admin@example.test"
EMP=6
CNPJ_MOT='90000000000191'
CAT_VELHA='Corrida E2E'; CAT_IND='Percentual atingido de rotas E2E'; CAT_EXC='Bonus Extra E2E'; CAT_NOVA='Incentivo chuva E2E'

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }
mkdir -p "$HUB_DIR/mocks/push-mock/tls"   # bind do compose (sem push-mock neste driver)
echo "subindo db+postgrest efêmeros ($PROJECT, tmpfs)…"
dc up -d --wait db
dc up -d --wait postgrest
echo "rodando migrate.sh (série completa, inclusive a 0131)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1 || { echo "FAIL: migrate"; tail -40 "$TMP/migrate.log"; exit 1; }
grep -q "0131_categorias_modo_todas.sql" "$TMP/migrate.log" || { echo "FAIL: 0131 não aplicada"; tail -40 "$TMP/migrate.log"; exit 1; }
echo "PASS: série de migrations aplicada do zero, com a 0131"
dc kill -s SIGUSR1 postgrest >/dev/null 2>&1 || true

echo "df -h / antes do build do backend:"; df -h /
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend (Dockerfile.hub)"; tail -80 "$TMP/build.log"; exit 1; }
dc up -d --wait backend

HASH="$(node_e "require('bcrypt').hash(process.argv[1],10).then(h=>{process.stdout.write(h);process.exit(0);});" "$SENHA" 2>"$TMP/h1.log" | tr -d '[:space:]')"
[ -n "$HASH" ] || { echo "FAIL: hash bcrypt"; cat "$TMP/h1.log"; exit 1; }
HOJE="$(own "SELECT hub_hoje_sp()")"
echo "hoje (banco) = $HOJE"

# Config v2 COMPLETA (a v1 semeada pela 0070 tem fonte/categorias nulas), modo "Só as marcadas", vigente
# desde 3 dias atrás: a categoria NOVA (1º lançamento hoje) é posterior à revisão; as demais têm 1º lançamento
# há 30 dias. Lançamentos de hoje: Corrida 100 · Indicador 50 · Exceção 20 · Nova 10.
psql_t -q <<SQL >"$TMP/seed.log" 2>&1 || { echo "FAIL: seed"; cat "$TMP/seed.log"; exit 1; }
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES ('$ADMIN_EMAIL','$HASH','E2E Categorias Admin',true);
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo)
  VALUES ((SELECT id FROM "Usuario" WHERE email='$ADMIN_EMAIL'), $EMP, (SELECT id FROM "Papel" WHERE nome='admin_entidade'), true);
INSERT INTO "ContaMotorista" (cnpj_prestador, nome, ativo) VALUES ('$CNPJ_MOT', 'Motorista Categorias E2E', true);
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
  VALUES ($EMP, gen_random_uuid(), 'Motorista Categorias E2E', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='$CNPJ_MOT'));
INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta, entregador_confirmado_id, revisada_em)
  SELECT $EMP, e.id, 'CARGA_INICIAL', 'APROVADA', 'Motorista Categorias E2E', '$CNPJ_MOT', 'PJ', '001', 'Banco do Brasil', '1234', '00012345', '6', 'CORRENTE', e.id, now()
  FROM "Entregador" e WHERE e.motorista_id = (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='$CNPJ_MOT');
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato)
VALUES ($EMP, 2, now() - interval '3 days', 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '23:59', 60.00, 0.35, 'financeiro_lancamento', ARRAY['$CAT_VELHA'], 'entre 17h e 18h de hoje', 'Antecipação {data_producao:DD.MM.AA}_{nome}', 0, 2, 'data_lancamento', ARRAY['$CAT_VELHA']);
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES ($EMP, 'faturamento', repeat('c',64), 'completed');
CREATE TEMP TABLE lanc (dia date, descricao text, valor numeric);
INSERT INTO lanc VALUES
  ('$HOJE'::date,      '$CAT_VELHA', 100), ('$HOJE'::date,      '$CAT_IND', 50), ('$HOJE'::date,      '$CAT_EXC', 20), ('$HOJE'::date, '$CAT_NOVA', 10),
  ('$HOJE'::date - 30, '$CAT_VELHA',  80), ('$HOJE'::date - 30, '$CAT_IND', 40), ('$HOJE'::date - 30, '$CAT_EXC', 15);
INSERT INTO "FaturamentoLancamento" (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha, criado_em)
  SELECT $EMP, (SELECT id FROM "ImportacaoArquivo" WHERE hash_sha256=repeat('c',64)),
         (SELECT e.id FROM "Entregador" e WHERE e.motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='$CNPJ_MOT')),
         l.dia, l.dia, 'Credito', l.valor, l.descricao, md5(l.descricao||l.dia::text)||md5(l.dia::text||l.descricao),
         CASE WHEN l.descricao = '$CAT_NOVA' THEN now() ELSE l.dia::timestamptz END  -- primeira = data de CHEGADA (criado_em), 0131
  FROM lanc l;
SQL
check "seed: config v2 vigente (a última) em modo 'só as marcadas'" "$(own "SELECT versao||'|'||categorias_producao::text FROM \"AdiantamentoConfiguracao\" WHERE id_empresa=$EMP ORDER BY versao DESC LIMIT 1")" "2|{\"$CAT_VELHA\"}"
check "seed: 7 lançamentos de crédito do motorista" "$(own "SELECT count(*) FROM \"FaturamentoLancamento\" WHERE id_empresa=$EMP")" "7"
ENT="$(own "SELECT e.id FROM \"Entregador\" e WHERE e.motorista_id=(SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='$CNPJ_MOT')")"
CFG2="$(own "SELECT id FROM \"AdiantamentoConfiguracao\" WHERE id_empresa=$EMP AND versao=2")"
# o seletor do banco já devolve a família e a 1ª data (0131), que o aviso consome
check "banco: hub_adiantamento_categorias devolve família 'indicador' e primeira=hoje só para a categoria nova" \
  "$(psql_t -tA <<SQL | grep -E '^(Corrida|Percentual|Bonus|Incentivo)' | sort | tr '\n' ' '
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"1","empresa_ativa":"$EMP","escopo":[$EMP]}', true);
SET ROLE authenticated;
SELECT descricao||'|'||COALESCE(familia,'-')||'|'||(primeira = '$HOJE'::date) FROM hub_adiantamento_categorias('financeiro_lancamento');
ROLLBACK;
SQL
)" \
  "Bonus Extra E2E|-|false Corrida E2E|-|false Incentivo chuva E2E|-|true Percentual atingido de rotas E2E|familia:indicador|false "

# --- frontend: container Playwright de pé, build + start dentro dele ---
NET="$(docker network ls --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Name}}' | head -1)"
[ -n "$NET" ] || { echo "FAIL: rede docker do projeto $PROJECT não encontrada"; exit 1; }
docker run -d --name "$PW" --memory=2g --network "$NET" -e CI=true \
  -v "$FRONTEND_DIR:/work" -w /work "$PLAYWRIGHT_IMAGE" tail -f /dev/null >/dev/null || { echo "FAIL: container Playwright"; exit 1; }
echo "df -h / antes do build do frontend:"; df -h /
docker exec -e NODE_ENV=production -e APP_ENV=dev -e BACKEND_URL=http://backend:3000 -e HUB_BACKEND_URL=http://backend:3000/api \
  "$PW" bash -lc 'cd /work && npm run build > /tmp/build-hub.log 2>&1 || { echo BUILD_HUB_FAILED; tail -120 /tmp/build-hub.log; exit 1; }' || exit 1
docker exec -d -e NODE_ENV=production -e APP_ENV=dev -e BACKEND_URL=http://backend:3000 -e HUB_BACKEND_URL=http://backend:3000/api \
  "$PW" bash -lc 'cd /work && npx next start -p 3005 -H 0.0.0.0 > /tmp/start-hub.log 2>&1'
ok=""
for _ in $(seq 1 40); do
  docker exec "$PW" curl -sf -o /dev/null "http://127.0.0.1:3005/hub/login" && { ok=1; break; }
  sleep 1
done
[ -n "$ok" ] || { echo "FRONTEND_NAO_SUBIU"; docker exec "$PW" bash -c 'tail -30 /tmp/start-hub.log'; exit 1; }
echo "frontend no ar (hub :3005)"

PW_PASSED=0; PW_FAILED=0; PW_FLAKY=0; PW_EXIT_ALL=0
roda_fase() { # roda_fase <rótulo> <arquivo-do-spec> [VAR=valor ...]
  local rotulo="$1" arq="$2"; shift 2
  local envs=(-e "HUB_E2E_BASE_URL=http://127.0.0.1:3005" -e "CAT_ADMIN_EMAIL=$ADMIN_EMAIL" -e "CAT_ADMIN_SENHA=$SENHA")
  local v; for v in "$@"; do envs+=(-e "$v"); done
  echo; echo "=== fase $rotulo ($arq) ==="
  local out="$TMP/fase-$rotulo.log"
  docker exec "${envs[@]}" "$PW" bash -lc "cd /work && npx playwright test -c playwright.config.hub-adiantamentos-categorias.ts tests/e2e-hub-adiantamentos-categorias/$arq" 2>&1 | tee "$out"
  local rc=${PIPESTATUS[0]}
  cat "$out" >> "$RUN_LOG"
  local n
  n="$(grep -oE '^ +[0-9]+ passed' "$out" | grep -oE '[0-9]+' | tail -1)"; PW_PASSED=$((PW_PASSED + ${n:-0}))
  n="$(grep -oE '^ +[0-9]+ failed' "$out" | grep -oE '[0-9]+' | tail -1)"; PW_FAILED=$((PW_FAILED + ${n:-0}))
  n="$(grep -oE '^ +[0-9]+ flaky' "$out" | grep -oE '[0-9]+' | tail -1)"; PW_FLAKY=$((PW_FLAKY + ${n:-0}))
  [ "$rc" = "0" ] || PW_EXIT_ALL=1
  return "$rc"
}

# producao_valor <versao> -> "valor|lancamentos|por_categoria" calculado pela função REAL do cálculo
producao() {
  own "SELECT p.valor||'|'||p.lancamentos||'|'||(SELECT string_agg(k||'='||v, ',' ORDER BY k) FROM jsonb_each_text(p.por_categoria) AS x(k,v)) FROM \"AdiantamentoConfiguracao\" c, hub_adiantamento_producao($ENT, '$HOJE'::date, c) p WHERE c.id_empresa=$EMP AND c.versao=$1"
}

# ============================ fase 1: configurações ============================
roda_fase 1 01-config-modo-todas.spec.ts
echo "--- banco depois da fase 1 ---"
check "1/banco: nova versão 3 criada (e só ela)" "$(own "SELECT max(versao)||'/'||count(*) FROM \"AdiantamentoConfiguracao\" WHERE id_empresa=$EMP AND versao >= 2")" "3/2"
check "1/banco: categorias_producao da v3 = modo:todas + Indicadores + exceção marcada (ordem da tela)" \
  "$(own "SELECT categorias_producao::text FROM \"AdiantamentoConfiguracao\" WHERE id_empresa=$EMP AND versao=3")" \
  "{modo:todas,familia:indicador,\"$CAT_EXC\"}"
check "1/banco: lista do extrato e da nota intactas (só a produção mudou de modo)" \
  "$(own "SELECT categorias_extrato::text||'|'||COALESCE(categorias_nota::text,'-') FROM \"AdiantamentoConfiguracao\" WHERE id_empresa=$EMP AND versao=3")" \
  "{\"$CAT_VELHA\"}|-"
check "1/banco: nenhuma lista antiga foi reescrita (v2 continua 'só as marcadas')" "$(own "SELECT categorias_producao::text FROM \"AdiantamentoConfiguracao\" WHERE id_empresa=$EMP AND versao=2")" "{\"$CAT_VELHA\"}"

# (3) efeito no dinheiro: valor exato pela função real, v2 como controle
check "3/dinheiro: v2 (só as marcadas [Corrida]) = 100,00 só da Corrida (controle)" "$(producao 2)" "100.00|1|$CAT_VELHA=100.00"
check "3/dinheiro: v3 (todas, exceto Indicadores e Bonus) = Corrida 100 + Incentivo NOVO 10 = 110,00; sem 50 nem 20" \
  "$(producao 3)" "110.00|2|$CAT_VELHA=100.00,$CAT_NOVA=10.00"
check "3/dinheiro: o que a v3 deixa de fora é exatamente o indicador (50) e a exceção (20)" \
  "$(own "SELECT sum(f.valor) FROM \"FaturamentoLancamento\" f WHERE f.id_empresa=$EMP AND f.data_lancamento='$HOJE' AND f.descricao IN ('$CAT_IND','$CAT_EXC')")" "70.00"

# (5) solicitação feita com a config vigente (v3): processar grava o snapshot com os tokens
psql_t -q <<SQL >"$TMP/sol.log" 2>&1 || { echo "FAIL: seed da solicitação"; cat "$TMP/sol.log"; exit 1; }
INSERT INTO "AdiantamentoSolicitacao" (id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
    data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia)
VALUES ($EMP, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='$CNPJ_MOT'), '$CNPJ_MOT', $ENT,
    (SELECT id FROM "AdiantamentoConfiguracao" WHERE id_empresa=$EMP AND versao=3),
    ('$HOJE'::date + 1), '$HOJE'::date, repeat('a',64), 'AGUARDANDO_PRODUCAO', gen_random_uuid());
SQL
worker "SELECT id, status_para FROM hub_adiantamento_processar(50);" >"$TMP/processar.log"
SOL_ID="$(own "SELECT id FROM \"AdiantamentoSolicitacao\" WHERE cnpj_prestador='$CNPJ_MOT' ORDER BY id DESC LIMIT 1")"
check "5/banco: solicitação processada (saiu de AGUARDANDO_PRODUCAO)" "$(own "SELECT (status <> 'AGUARDANDO_PRODUCAO')::text FROM \"AdiantamentoSolicitacao\" WHERE id=$SOL_ID")" "true"
check "5/banco: snapshot guarda os tokens como estavam no cálculo + produção 110,00" \
  "$(own "SELECT categorias_producao::text||'|'||producao_valor FROM \"AdiantamentoSolicitacao\" WHERE id=$SOL_ID")" \
  "{modo:todas,familia:indicador,\"$CAT_EXC\"}|110.00"

# ============================ fase 2: detalhe + voltar ============================
roda_fase 2 02-detalhe-e-voltar.spec.ts CAT_SOL_ID="$SOL_ID"
check "2/banco: v4 salva em modo 'marcadas' (sem modo:todas), equivalente ao que entrava" "$(own "SELECT max(versao)||'|'||(SELECT categorias_producao::text FROM \"AdiantamentoConfiguracao\" WHERE id_empresa=$EMP AND versao=4) FROM \"AdiantamentoConfiguracao\" WHERE id_empresa=$EMP")" "4|{familia:promocao,familia:missoes,\"$CAT_VELHA\",\"$CAT_NOVA\"}"
check "2/dinheiro: a troca não muda o valor — v4 produz o MESMO que v3 (110,00)" "$(producao 4)" "$(producao 3)"
check "2/dinheiro: v4 = 110,00 exato" "$(producao 4)" "110.00|2|$CAT_VELHA=100.00,$CAT_NOVA=10.00"

# ------------------------------ relatório ------------------------------
echo
echo "=== log completo: $RUN_LOG ==="
echo "Checagens de banco/driver: $passes PASS, $fails FAIL"
echo "Playwright (soma das fases): $PW_PASSED passed, $PW_FAILED failed, $PW_FLAKY flaky"
if [ "$fails" = "0" ] && [ "$PW_EXIT_ALL" = "0" ] && [ "$PW_FAILED" = "0" ]; then
  echo "HUB-ADIANTAMENTOS-CATEGORIAS-E2E-BROWSER: OK"
  exit 0
fi
echo "HUB-ADIANTAMENTOS-CATEGORIAS-E2E-BROWSER: FALHOU (checagens=$fails, playwright_exit=$PW_EXIT_ALL, failed=$PW_FAILED)" >&2
exit 1

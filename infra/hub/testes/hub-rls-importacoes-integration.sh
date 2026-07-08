#!/usr/bin/env bash
# =============================================================================
# hub-rls-importacoes-integration.sh — task 1.4.3 (tasks.md FASE 1 do plano
# hub-importacoes/S4): prova E2E REAL (sem mock) da RLS das 5 tabelas novas
# (migration 0015) — Entregador, ImportacaoArquivo, ImportacaoLinhaErro,
# FaturamentoLancamento, PerformanceTurno. Mesmo padrão de isolamento efêmero
# e mesma técnica de chamada DIRETA ao PostgREST (bypass do Express) de
# infra/hub/testes/hub-rls-integration.sh (S2, task 5.2.4).
#
# Cobre:
#   (a)-(e) cada uma das 5 tabelas: token com escopo=[A] lendo id_empresa=eq.B
#       -> 200 [] (0 linhas, RLS nega); lendo id_empresa=eq.A -> retorna as
#       linhas de A (RLS não quebra uso legítimo)
#   (f) SEM claim de escopo (JWT só com role=authenticated) -> 0 linhas nas
#       5 tabelas (nega-por-padrão puro, FR-028/CHK-equivalente task 1.4.3)
#
# Uso: infra/hub/testes/hub-rls-importacoes-integration.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)"
PROJECT="hub-test-$RUNID"
TMP="$(mktemp -d)"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
cleanup() { dc down -v --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }

echo "subindo db+postgrest+backend efêmeros ($PROJECT, tmpfs)…"
dc up -d --wait db
dc up -d --wait postgrest
dc up -d --wait mailpit-mock
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend (Dockerfile.hub)"; tail -60 "$TMP/build.log"; exit 1; }
dc up -d --wait backend

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
run_node() { dc exec -T backend node - "$@"; }

fails=0
check() { # check <descricao> <valor-obtido> <valor-esperado>
  if [ "$2" = "$3" ]; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 (obtido='$2' esperado='$3')"
    fails=$((fails + 1))
  fi
}

echo "rodando migrate.sh (0002..0016, INCLUSIVE 0015 — RLS hub-importacoes)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0015_rls_importacoes.sql" "$TMP/migrate.log" || { echo "FAIL: 0015 não aplicada"; cat "$TMP/migrate.log"; exit 1; }
grep -q "0016_seed_importacoes_exportar.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas por completo"; cat "$TMP/migrate.log"; exit 1; }

# --- Idempotência: reaplica a série inteira; migrate.sh pula tudo -> no-op.
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate2.log" 2>&1
check "migrate.sh rodado 2x: 0010 idempotente (pulada na 2ª corrida)" "$(grep -c 'pulada (já aplicada): 0010_entregador.sql' "$TMP/migrate2.log")" "1"
check "migrate.sh rodado 2x: 0011 idempotente (pulada na 2ª corrida)" "$(grep -c 'pulada (já aplicada): 0011_importacao_arquivo.sql' "$TMP/migrate2.log")" "1"
check "migrate.sh rodado 2x: 0015 idempotente (pulada na 2ª corrida)" "$(grep -c 'pulada (já aplicada): 0015_rls_importacoes.sql' "$TMP/migrate2.log")" "1"

# --- Seed: 2 entidades sintéticas (A, B), 1 Entregador por entidade,
# 1 ImportacaoArquivo por entidade + linha de erro + 1 fato de cada tipo.
E_A=921001
E_B=921002

psql_t <<SQL >/dev/null
INSERT INTO "Entregador" (id_empresa, id_externo, nome) VALUES
  ($E_A, '11111111-1111-1111-1111-111111111111', 'Entregador A'),
  ($E_B, '22222222-2222-2222-2222-222222222222', 'Entregador B');

INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, hash_sha256, status) VALUES
  ($E_A, 'faturamento', repeat('a', 64), 'completed'),
  ($E_B, 'faturamento', repeat('b', 64), 'completed');

INSERT INTO "ImportacaoLinhaErro" (importacao_id, id_empresa, numero_linha, motivo)
  SELECT id, id_empresa, 1, 'erro sintético rls-test' FROM "ImportacaoArquivo"
  WHERE id_empresa IN ($E_A, $E_B);

INSERT INTO "FaturamentoLancamento"
  (id_empresa, importacao_id, data_lancamento, data_referencia, tipo, valor, descricao, hash_linha)
  SELECT id_empresa, id, '2026-01-01', '2026-01-01', 'Credito', 10.00, 'teste-rls',
         substr(encode(sha256(('fat-' || id_empresa::text)::bytea), 'hex'), 1, 64)
  FROM "ImportacaoArquivo" WHERE id_empresa IN ($E_A, $E_B);

INSERT INTO "PerformanceTurno"
  (id_empresa, importacao_id, entregador_id, data_periodo, periodo, hash_linha)
  SELECT ia.id_empresa, ia.id, e.id, '2026-01-01', 'MANHA',
         substr(encode(sha256(('perf-' || ia.id_empresa::text)::bytea), 'hex'), 1, 64)
  FROM "ImportacaoArquivo" ia JOIN "Entregador" e ON e.id_empresa = ia.id_empresa
  WHERE ia.id_empresa IN ($E_A, $E_B);
SQL

# ─────────────────────────────────────────────────────────────────────────────
# Chamadas DIRETAS ao PostgREST (bypass do Express), de dentro do container
# `backend`, com lib/hub-postgrest-jwt.js — mesmo mecanismo de produção.
# ─────────────────────────────────────────────────────────────────────────────
OUT="$(run_node "$E_A" "$E_B" <<'JS'
const { generateHubPostgrestJWT } = require('./lib/hub-postgrest-jwt');

async function pg(jwt, path) {
  const r = await fetch(`http://postgrest:3000/${path}`, {
    headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
  });
  const status = r.status;
  const body = await r.json().catch(() => null);
  return { status, body };
}

async function main() {
  const [empresaA, empresaB] = process.argv.slice(2).map(Number);
  const out = {};

  const jwtEscopoA = generateHubPostgrestJWT({ empresaAtiva: empresaA, escopo: [empresaA] });
  const jwtSemClaims = generateHubPostgrestJWT({}); // só role=authenticated

  const tabelas = [
    ['Entregador', 'id_empresa'],
    ['ImportacaoArquivo', 'id_empresa'],
    ['ImportacaoLinhaErro', 'id_empresa'],
    ['FaturamentoLancamento', 'id_empresa'],
    ['PerformanceTurno', 'id_empresa'],
  ];

  for (const [tabela, col] of tabelas) {
    const rB = await pg(jwtEscopoA, `${tabela}?${col}=eq.${empresaB}`);
    out[`${tabela}_outro_len`] = Array.isArray(rB.body) ? rB.body.length : -1;

    const rA = await pg(jwtEscopoA, `${tabela}?${col}=eq.${empresaA}`);
    out[`${tabela}_proprio_len`] = Array.isArray(rA.body) ? rA.body.length : -1;

    const rSem = await pg(jwtSemClaims, `${tabela}?${col}=eq.${empresaA}`);
    out[`${tabela}_sem_claims_len`] = Array.isArray(rSem.body) ? rSem.body.length : -1;
  }

  for (const [k, v] of Object.entries(out)) {
    console.log(`${k}=${v}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
JS
)" || { echo "FAIL: script node falhou"; echo "$OUT"; exit 1; }

echo "$OUT" > "$TMP/rls-out.env"
val() { grep "^$1=" "$TMP/rls-out.env" | tail -1 | cut -d= -f2-; }

for t in Entregador ImportacaoArquivo ImportacaoLinhaErro FaturamentoLancamento PerformanceTurno; do
  outro="$(val "${t}_outro_len")"
  proprio="$(val "${t}_proprio_len")"
  sem="$(val "${t}_sem_claims_len")"
  check "$t: escopo=[A] lendo id_empresa=B -> 0 linhas (RLS nega)" "$outro" "0"
  case "$proprio" in
    0|-1|'') check "$t: escopo=[A] lendo id_empresa=A -> retorna linha(s) própria(s)" "$proprio" "ok(>=1)" ;;
    *) check "$t: escopo=[A] lendo id_empresa=A -> retorna linha(s) própria(s)" "ok(>=1)" "ok(>=1)" ;;
  esac
  check "$t: SEM claims (só role=authenticated) -> 0 linhas (nega-por-padrão)" "$sem" "0"
done

echo "--- saída bruta ---"
cat "$TMP/rls-out.env"

if [ "$fails" -eq 0 ]; then
  echo "=== hub-rls-importacoes-integration: TODOS OS TESTES PASSARAM ==="
  exit 0
else
  echo "=== hub-rls-importacoes-integration: $fails FALHA(S) ==="
  exit 1
fi

#!/usr/bin/env bash
# =============================================================================
# hub-auditoria-integration.sh — task 6.2.1 (tasks.md FASE 6): prova E2E REAL
# (sem mock) da imutabilidade da trilha de Auditoria — data-model.md §Auditoria,
# FR-023/FR-024/FR-025, block-001, migrations/0004_auditoria.sql.
#
# Mesmo padrão de isolamento efêmero de infra/hub/testes/hub-rls-integration.sh
# (FASE 5): projeto hub-test-<runid> descartável, tmpfs, nunca toca
# chatmasterveloz/produção.
#
# GAP que este script fecha: tasks.md 1.4.4 ("Teste de integração: INSERT
# permitido, UPDATE/DELETE rejeitados na camada de dados") foi marcada [x] na
# FASE 1 mas não existia nenhum arquivo de teste correspondente no repo até
# esta onda (achado desta auditoria — ver Decisão registrada em execute-task).
#
# Cobre (via PostgREST DIRETO, role authenticated, mesmo mecanismo real):
#   (a) INSERT permitido — grava evento e o retorna com shape correto
#       (snake_case, criado_em ISO 8601, detalhes objeto)
#   (b) UPDATE rejeitado — tentativa de alterar `acao` falha (trigger
#       hub_bloqueia_alteracao_auditoria) E o valor original permanece
#       inalterado (confirmado por leitura pós-tentativa)
#   (c) DELETE rejeitado — tentativa de remover a linha falha E a linha
#       continua existindo (confirmado por leitura pós-tentativa)
#   (d) GRANTs na camada de dados (pg_catalog, via psql direto): role
#       `authenticated` tem SELECT/INSERT mas NÃO tem UPDATE/DELETE em
#       "Auditoria" (REVOKE explícito de 0004, defesa em profundidade #1)
#   (e) scrubDetalhes() ponta-a-ponta: chave proibida ("senha") em `detalhes`
#       nunca chega ao Postgres quando inserida via lib/hub-auditoria.js
#       (registrarAuditoria), não apenas no unit test puro
#
# Uso: infra/hub/testes/hub-auditoria-integration.sh
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

echo "rodando migrate.sh (série completa até 0008)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0004_auditoria.sql" "$TMP/migrate.log" || { echo "FAIL: 0004 não aplicada"; cat "$TMP/migrate.log"; exit 1; }
grep -q "0008_migracao_empresa_para_usuario.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas por completo"; cat "$TMP/migrate.log"; exit 1; }

# --- Seed: 1 usuário para o evento de teste -----------------------------------
E_A=930001
psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('auditoria-int-usuario@example.test', 'x', 'Usuario Auditoria Integration', true);
SQL
UID_A="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='auditoria-int-usuario@example.test'" | tr -d '[:space:]')"
[ -n "$UID_A" ] || { echo "FAIL: seed de Usuario falhou"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
# (a)+(b)+(c): INSERT/UPDATE/DELETE via PostgREST direto, role authenticated
# ─────────────────────────────────────────────────────────────────────────────
OUT="$(run_node "$UID_A" "$E_A" <<'JS'
const { generateHubPostgrestJWT } = require('./lib/hub-postgrest-jwt');
const { registrarAuditoria } = require('./lib/hub-auditoria');

async function pg(jwt, path, opts = {}) {
  const r = await fetch(`http://postgrest:3000/${path}`, {
    ...opts,
    headers: {
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
      ...(opts.body ? { 'Content-Type': 'application/json', Prefer: 'return=representation' } : {}),
      ...(opts.headers || {}),
    },
  });
  const status = r.status;
  const body = await r.json().catch(() => null);
  return { status, body };
}

async function main() {
  const [uidA, empresaAStr] = process.argv.slice(2);
  const empresaA = Number(empresaAStr);
  const out = {};

  const jwtEscopoA = generateHubPostgrestJWT({ usuarioId: uidA, empresaAtiva: empresaA, escopo: [empresaA] });

  // (a) INSERT permitido via registrarAuditoria (mesmo caminho real de produção)
  await registrarAuditoria({
    idEmpresa: empresaA,
    usuarioId: uidA,
    acao: 'evento_auditoria_integration',
    recurso: 'AuditoriaIntegrationTest',
    detalhes: { origem: 'auditoria-integration', senha: 'NUNCA_DEVE_PERSISTIR', ok: true },
    claims: { usuarioId: uidA, empresaAtiva: empresaA, escopo: [empresaA] },
  });

  const rInsert = await pg(jwtEscopoA, `Auditoria?acao=eq.evento_auditoria_integration&order=id.desc&limit=1`);
  out.insert_status = rInsert.status;
  out.insert_len = Array.isArray(rInsert.body) ? rInsert.body.length : -1;
  const row = rInsert.body && rInsert.body[0];
  out.insert_id = row ? row.id : null;
  out.insert_acao = row ? row.acao : null;
  out.insert_criado_em_tipo = row ? typeof row.criado_em : 'ausente';
  out.insert_detalhes_tipo = row ? typeof row.detalhes : 'ausente';
  out.insert_snake_case = row
    ? Object.prototype.hasOwnProperty.call(row, 'id_empresa') && Object.prototype.hasOwnProperty.call(row, 'criado_em')
    : false;
  // (e) scrubDetalhes ponta-a-ponta: chave "senha" NUNCA deve persistir
  out.detalhes_sem_senha = row ? !Object.prototype.hasOwnProperty.call(row.detalhes || {}, 'senha') : false;
  out.detalhes_manteve_ok = row ? row.detalhes && row.detalhes.ok === true : false;

  if (!row) {
    console.log('___RESULT_JSON___' + JSON.stringify(out));
    return;
  }

  // (b) UPDATE rejeitado (trigger bloqueia mesmo com Prefer:return=representation)
  const rUpdate = await pg(jwtEscopoA, `Auditoria?id=eq.${row.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ acao: 'ADULTERADO' }),
  });
  out.update_status = rUpdate.status;

  // confirma que o valor NÃO mudou (mesmo que o UPDATE tenha "aparentado" sucesso)
  const rReadPosUpdate = await pg(jwtEscopoA, `Auditoria?id=eq.${row.id}`);
  const rowPosUpdate = rReadPosUpdate.body && rReadPosUpdate.body[0];
  out.acao_inalterada_pos_update = rowPosUpdate ? rowPosUpdate.acao : null;

  // (c) DELETE rejeitado
  const rDelete = await pg(jwtEscopoA, `Auditoria?id=eq.${row.id}`, { method: 'DELETE' });
  out.delete_status = rDelete.status;

  // confirma que a linha AINDA existe
  const rReadPosDelete = await pg(jwtEscopoA, `Auditoria?id=eq.${row.id}`);
  out.linha_existe_pos_delete = Array.isArray(rReadPosDelete.body) ? rReadPosDelete.body.length : -1;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT" | grep -v '___RESULT_JSON___' || true
R="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R" ] || { echo "FAIL: script Node não retornou resultado"; echo "$OUT"; exit 1; }
jval() { node -e "const d=JSON.parse(process.argv[1]); const v=d[process.argv[2]]; process.stdout.write(v === undefined || v === null ? '' : String(v));" "$R" "$1"; }

check "(a) INSERT via registrarAuditoria -> 200 na leitura" "$(jval insert_status)" "200"
check "(a) INSERT -> 1 linha encontrada" "$(jval insert_len)" "1"
check "(a) acao gravada corretamente" "$(jval insert_acao)" "evento_auditoria_integration"
check "(a) shape snake_case (id_empresa/criado_em)" "$(jval insert_snake_case)" "true"
check "(a) criado_em é string ISO 8601" "$(jval insert_criado_em_tipo)" "string"
check "(a) detalhes é objeto JSON" "$(jval insert_detalhes_tipo)" "object"
check "(e) chave proibida 'senha' NUNCA persistiu (scrubDetalhes ponta-a-ponta)" "$(jval detalhes_sem_senha)" "true"
check "(e) chave permitida 'ok' preservada" "$(jval detalhes_manteve_ok)" "true"
check "(b) UPDATE rejeitado (status != 2xx, trigger bloqueia)" "$(node -e "process.stdout.write(String(Number(process.argv[1]) >= 400))" "$(jval update_status)")" "true"
check "(b) acao permanece INALTERADA após tentativa de UPDATE" "$(jval acao_inalterada_pos_update)" "evento_auditoria_integration"
check "(c) DELETE rejeitado (status != 2xx, trigger bloqueia)" "$(node -e "process.stdout.write(String(Number(process.argv[1]) >= 400))" "$(jval delete_status)")" "true"
check "(c) linha AINDA existe após tentativa de DELETE" "$(jval linha_existe_pos_delete)" "1"

# ─────────────────────────────────────────────────────────────────────────────
# (d) GRANTs na camada de dados — pg_catalog via psql direto (defesa em
# profundidade #1: REVOKE explícito de 0004, independente do trigger)
# ─────────────────────────────────────────────────────────────────────────────
GRANT_SELECT="$(psql_t -tAc "SELECT has_table_privilege('authenticated', '\"Auditoria\"', 'SELECT')" | tr -d '[:space:]')"
GRANT_INSERT="$(psql_t -tAc "SELECT has_table_privilege('authenticated', '\"Auditoria\"', 'INSERT')" | tr -d '[:space:]')"
GRANT_UPDATE="$(psql_t -tAc "SELECT has_table_privilege('authenticated', '\"Auditoria\"', 'UPDATE')" | tr -d '[:space:]')"
GRANT_DELETE="$(psql_t -tAc "SELECT has_table_privilege('authenticated', '\"Auditoria\"', 'DELETE')" | tr -d '[:space:]')"

check "(d) GRANT: authenticated TEM SELECT em Auditoria" "$GRANT_SELECT" "t"
check "(d) GRANT: authenticated TEM INSERT em Auditoria" "$GRANT_INSERT" "t"
check "(d) GRANT: authenticated NÃO TEM UPDATE em Auditoria (REVOKE 0004)" "$GRANT_UPDATE" "f"
check "(d) GRANT: authenticated NÃO TEM DELETE em Auditoria (REVOKE 0004)" "$GRANT_DELETE" "f"

echo
if [ "$fails" = "0" ]; then
  echo "HUB-AUDITORIA-INTEGRATION: OK — todos os asserts passaram (FASE 6: 6.2, fecha gap de evidência de 1.4.4)"
else
  echo "HUB-AUDITORIA-INTEGRATION: $fails assert(s) FALHARAM" >&2
  exit 1
fi

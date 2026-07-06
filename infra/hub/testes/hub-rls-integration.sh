#!/usr/bin/env bash
# =============================================================================
# hub-rls-integration.sh — task 5.2.4 (tasks.md FASE 5): prova E2E REAL (sem
# mock) da camada de RLS de reforço — quickstart.md Scenario 9, FR-026/027/028,
# SC-008. Mesmo padrão de isolamento efêmero de
# infra/hub/testes/hub-rbac-integration.sh (FASE 4), mas aqui o ponto central
# é chamar o PostgREST DIRETAMENTE (via fetch de dentro do container backend,
# contra o hostname `postgrest` na rede do projeto), CONTORNANDO deliberadamente
# os endpoints Express (/api/v1/me etc.) — só assim se prova que a defesa
# funciona por si só, mesmo que a camada de aplicação seja pulada (FR-026).
#
# Cobre:
#   (a) Auditoria: token com escopo=[A] lendo id_empresa=eq.B -> 200 []
#       (zero linhas, RLS nega — não é a query que filtra, é a policy)
#   (b) Auditoria: mesmo token lendo id_empresa=eq.A (a própria entidade do
#       escopo) -> registros de A retornados normalmente (RLS não quebra o
#       uso legítimo)
#   (c) Auditoria: linha global (id_empresa IS NULL) sempre visível,
#       independente do escopo do token (evento sem entidade, ex. login)
#   (d) ModuloEntidade: token com escopo=[A] lendo empresa_id=eq.B -> 0 linhas;
#       lendo empresa_id=eq.A -> retorna
#   (e) UsuarioEntidade: token com sub=usuarioA lendo usuario_id=eq.usuarioB
#       (outra pessoa) -> 0 linhas; lendo o próprio usuario_id -> retorna
#   (f) Requisição SEM claim de escopo/sub (JWT só com role=authenticated,
#       sem sub/empresa_ativa/escopo) -> 0 linhas em TODAS as 3 tabelas
#       (nega-por-padrão puro, FR-028, mesmo sem contornar nada)
#   (g) Shape do JSON de Auditoria bate com contracts/auditoria.md (snake_case,
#       criado_em ISO 8601, detalhes objeto) — Convenção de Borda de plan.md
#
# Uso: infra/hub/testes/hub-rls-integration.sh
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

echo "rodando migrate.sh (0002..0008, INCLUSIVE 0006 — FASE 5)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0006_rls_policies.sql" "$TMP/migrate.log" || { echo "FAIL: 0006 não aplicada"; cat "$TMP/migrate.log"; exit 1; }
grep -q "0008_migracao_empresa_para_usuario.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas por completo"; cat "$TMP/migrate.log"; exit 1; }
grep -q "0009_rls_hardening_indices.sql" "$TMP/migrate.log" || { echo "FAIL: 0009 (correção pós-review) não aplicada"; cat "$TMP/migrate.log"; exit 1; }

# --- Idempotência (task 5.2.3): reaplica a série inteira sobre o MESMO banco;
# migrate.sh pula todas por já registradas em SchemaMigration -> no-op.
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate2.log" 2>&1
IDEMPOTENTE="$(grep -c 'pulada (já aplicada)' "$TMP/migrate2.log" | tr -d '[:space:]')"
check "migrate.sh rodado 2x: 0006 idempotente (pulada na 2ª corrida)" "$(grep -c 'pulada (já aplicada): 0006_rls_policies.sql' "$TMP/migrate2.log")" "1"
check "migrate.sh rodado 2x: 0009 idempotente (pulada na 2ª corrida)" "$(grep -c 'pulada (já aplicada): 0009_rls_hardening_indices.sql' "$TMP/migrate2.log")" "1"

# --- Seed: 2 entidades (A, B), 2 usuários (A, B), vínculos, módulo, auditoria -
E_A=920001
E_B=920002

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('rls-usuario-a@example.test', 'x', 'Usuario RLS A', true),
  ('rls-usuario-b@example.test', 'x', 'Usuario RLS B', true);
SQL
UID_A="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='rls-usuario-a@example.test'" | tr -d '[:space:]')"
UID_B="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='rls-usuario-b@example.test'" | tr -d '[:space:]')"
[ -n "$UID_A" ] && [ -n "$UID_B" ] || { echo "FAIL: seed de Usuario falhou"; exit 1; }

PAPEL_OPERADOR="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='operador'" | tr -d '[:space:]')"
[ -n "$PAPEL_OPERADOR" ] || { echo "FAIL: seed 0007 não populou o papel 'operador'"; exit 1; }

MODULO_DASHBOARD="$(psql_t -tAc "SELECT id FROM \"Modulo\" WHERE codigo='dashboard'" | tr -d '[:space:]')"
[ -n "$MODULO_DASHBOARD" ] || { echo "FAIL: seed 0007 não populou o modulo 'dashboard'"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_A, $E_A, $PAPEL_OPERADOR, true),
  ($UID_B, $E_B, $PAPEL_OPERADOR, true);

INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo) VALUES
  ($MODULO_DASHBOARD, $E_A, true),
  ($MODULO_DASHBOARD, $E_B, true);

INSERT INTO "Auditoria" (id_empresa, usuario_id, acao, recurso, detalhes, criado_em) VALUES
  ($E_A, $UID_A, 'evento_teste_a', 'UsuarioEntidade', '{"origem":"rls-integration"}'::jsonb, now()),
  ($E_B, $UID_B, 'evento_teste_b', 'UsuarioEntidade', '{"origem":"rls-integration"}'::jsonb, now()),
  (NULL, $UID_A, 'login_sucesso', 'Usuario', '{}'::jsonb, now());
SQL

# ─────────────────────────────────────────────────────────────────────────────
# Chamadas DIRETAS ao PostgREST (bypass total do Express), de dentro do
# container `backend` (mesma rede docker do projeto), usando
# lib/hub-postgrest-jwt.js para assinar os JWTs sintéticos do cenário —
# exatamente o mecanismo real de produção (Decision 3), só que aqui
# construímos as claims manualmente para simular os 2 lados do escopo.
# ─────────────────────────────────────────────────────────────────────────────
OUT="$(run_node "$UID_A" "$UID_B" "$E_A" "$E_B" <<'JS'
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
  const [uidA, uidB, empresaA, empresaB] = process.argv.slice(2).map((v, i) => (i < 2 ? v : Number(v)));
  const out = {};

  const jwtEscopoA = generateHubPostgrestJWT({ usuarioId: uidA, empresaAtiva: empresaA, escopo: [empresaA] });
  const jwtSemClaims = generateHubPostgrestJWT({}); // só role=authenticated, sem sub/escopo

  // (a)+(b) Auditoria: escopo=[A] lendo B -> 0; lendo A -> retorna
  const rAudB = await pg(jwtEscopoA, `Auditoria?id_empresa=eq.${empresaB}`);
  out.audit_b_status = rAudB.status;
  out.audit_b_len = Array.isArray(rAudB.body) ? rAudB.body.length : -1;

  const rAudA = await pg(jwtEscopoA, `Auditoria?id_empresa=eq.${empresaA}`);
  out.audit_a_status = rAudA.status;
  out.audit_a_len = Array.isArray(rAudA.body) ? rAudA.body.length : -1;
  out.audit_a_acao = rAudA.body && rAudA.body[0] && rAudA.body[0].acao;
  out.audit_a_criado_em_tipo = rAudA.body && rAudA.body[0] ? typeof rAudA.body[0].criado_em : 'ausente';
  out.audit_a_detalhes_tipo = rAudA.body && rAudA.body[0] ? typeof rAudA.body[0].detalhes : 'ausente';
  out.audit_a_snake_case = rAudA.body && rAudA.body[0]
    ? Object.prototype.hasOwnProperty.call(rAudA.body[0], 'id_empresa') && Object.prototype.hasOwnProperty.call(rAudA.body[0], 'criado_em')
    : false;

  // (c) linha global (id_empresa IS NULL) sempre visível
  const rAudGlobal = await pg(jwtEscopoA, `Auditoria?acao=eq.login_sucesso`);
  out.audit_global_len = Array.isArray(rAudGlobal.body) ? rAudGlobal.body.length : -1;

  // (d) ModuloEntidade: escopo=[A] lendo B -> 0; lendo A -> retorna
  const rModB = await pg(jwtEscopoA, `ModuloEntidade?empresa_id=eq.${empresaB}`);
  out.modulo_b_len = Array.isArray(rModB.body) ? rModB.body.length : -1;
  const rModA = await pg(jwtEscopoA, `ModuloEntidade?empresa_id=eq.${empresaA}`);
  out.modulo_a_len = Array.isArray(rModA.body) ? rModA.body.length : -1;

  // (e) UsuarioEntidade: sub=uidA lendo usuario_id=eq.uidB -> 0; próprio -> retorna
  const rUeB = await pg(jwtEscopoA, `UsuarioEntidade?usuario_id=eq.${uidB}`);
  out.usuarioentidade_outro_len = Array.isArray(rUeB.body) ? rUeB.body.length : -1;
  const rUeA = await pg(jwtEscopoA, `UsuarioEntidade?usuario_id=eq.${uidA}`);
  out.usuarioentidade_proprio_len = Array.isArray(rUeA.body) ? rUeA.body.length : -1;

  // (f) sem claim nenhuma (só role=authenticated) -> nega tudo (exceto Auditoria NULL)
  const rSemClaimsAudA = await pg(jwtSemClaims, `Auditoria?id_empresa=eq.${empresaA}`);
  out.sem_claims_audit_a_len = Array.isArray(rSemClaimsAudA.body) ? rSemClaimsAudA.body.length : -1;
  const rSemClaimsAudGlobal = await pg(jwtSemClaims, `Auditoria?acao=eq.login_sucesso`);
  out.sem_claims_audit_global_len = Array.isArray(rSemClaimsAudGlobal.body) ? rSemClaimsAudGlobal.body.length : -1;
  const rSemClaimsMod = await pg(jwtSemClaims, `ModuloEntidade?empresa_id=eq.${empresaA}`);
  out.sem_claims_modulo_len = Array.isArray(rSemClaimsMod.body) ? rSemClaimsMod.body.length : -1;
  const rSemClaimsUe = await pg(jwtSemClaims, `UsuarioEntidade?usuario_id=eq.${uidA}`);
  out.sem_claims_ue_len = Array.isArray(rSemClaimsUe.body) ? rSemClaimsUe.body.length : -1;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT" | grep -v '___RESULT_JSON___' || true
R="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R" ] || { echo "FAIL: script Node não retornou resultado"; echo "$OUT"; exit 1; }
jval() { node -e "const d=JSON.parse(process.argv[1]); const v=d[process.argv[2]]; process.stdout.write(v === undefined ? '' : String(v));" "$R" "$1"; }

check "(a) Auditoria: escopo=[A] lendo B -> 200" "$(jval audit_b_status)" "200"
check "(a) Auditoria: escopo=[A] lendo B -> 0 linhas (RLS nega, SC-008)" "$(jval audit_b_len)" "0"
check "(b) Auditoria: escopo=[A] lendo A -> 200" "$(jval audit_a_status)" "200"
check "(b) Auditoria: escopo=[A] lendo A -> 1 linha (uso legítimo preservado, FR-026)" "$(jval audit_a_len)" "1"
check "(b) Auditoria: acao correta" "$(jval audit_a_acao)" "evento_teste_a"
check "(g) Auditoria: shape snake_case (id_empresa/criado_em presentes)" "$(jval audit_a_snake_case)" "true"
check "(g) Auditoria: criado_em é string ISO 8601" "$(jval audit_a_criado_em_tipo)" "string"
check "(g) Auditoria: detalhes é objeto JSON" "$(jval audit_a_detalhes_tipo)" "object"
check "(c) Auditoria: linha global (id_empresa NULL) sempre visível" "$(jval audit_global_len)" "1"
check "(d) ModuloEntidade: escopo=[A] lendo B -> 0 linhas" "$(jval modulo_b_len)" "0"
check "(d) ModuloEntidade: escopo=[A] lendo A -> 1 linha" "$(jval modulo_a_len)" "1"
check "(e) UsuarioEntidade: sub=A lendo vínculo de B -> 0 linhas" "$(jval usuarioentidade_outro_len)" "0"
check "(e) UsuarioEntidade: sub=A lendo o próprio -> 1 linha" "$(jval usuarioentidade_proprio_len)" "1"
check "(f) sem claims: Auditoria escopada (A) -> 0 linhas (nega-por-padrão puro)" "$(jval sem_claims_audit_a_len)" "0"
check "(f) sem claims: Auditoria global (NULL) ainda visível" "$(jval sem_claims_audit_global_len)" "1"
check "(f) sem claims: ModuloEntidade -> 0 linhas" "$(jval sem_claims_modulo_len)" "0"
check "(f) sem claims: UsuarioEntidade -> 0 linhas" "$(jval sem_claims_ue_len)" "0"

# ─────────────────────────────────────────────────────────────────────────────
# (h) INSERT em Auditoria — correção pós-review PR #55 (achado #2 / migration
# 0009): o ramo global (id_empresa IS NULL) da policy de INSERT foi fechado a um
# conjunto de `acao` de autenticação. Prova, chamando o PostgREST direto:
#   - forjar evento global com acao ARBITRÁRIA (não-auth) -> REJEITADO (não 201)
#   - evento global com acao de AUTH legítima (login_falha) -> ACEITO (201)
#   - evento in-scope (id_empresa=A) -> ACEITO; out-of-scope (id_empresa=B) -> REJEITADO
# ─────────────────────────────────────────────────────────────────────────────
OUTI="$(run_node "$E_A" "$E_B" <<'JS'
const { generateHubPostgrestJWT } = require('./lib/hub-postgrest-jwt');

async function pgPost(jwt, path, body) {
  const r = await fetch(`http://postgrest:3000/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  return r.status;
}

async function main() {
  const [empresaA, empresaB] = process.argv.slice(2).map(Number);
  const out = {};
  const jwtEscopoA = generateHubPostgrestJWT({ usuarioId: 1, empresaAtiva: empresaA, escopo: [empresaA] });

  out.forjado_global_status = await pgPost(jwtEscopoA, 'Auditoria', { id_empresa: null, acao: 'evento_forjado_global', recurso: 'Ataque', detalhes: {} });
  out.auth_global_status = await pgPost(jwtEscopoA, 'Auditoria', { id_empresa: null, acao: 'login_falha', recurso: 'Usuario', detalhes: {} });
  out.inscope_status = await pgPost(jwtEscopoA, 'Auditoria', { id_empresa: empresaA, acao: 'evento_inscope', recurso: 'X', detalhes: {} });
  out.outscope_status = await pgPost(jwtEscopoA, 'Auditoria', { id_empresa: empresaB, acao: 'evento_outscope', recurso: 'X', detalhes: {} });

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUTI" | grep -v '___RESULT_JSON___' || true
RI="$(echo "$OUTI" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$RI" ] || { echo "FAIL: script Node (INSERT policy) não retornou resultado"; echo "$OUTI"; exit 1; }
ival() { node -e "const d=JSON.parse(process.argv[1]); const v=d[process.argv[2]]; process.stdout.write(v === undefined ? '' : String(v));" "$RI" "$1"; }

check "(#2) INSERT global forjado (acao arbitrária) REJEITADO (status != 201)" "$([ "$(ival forjado_global_status)" != "201" ] && echo sim || echo nao)" "sim"
check "(#2) INSERT global de auth legítima (login_falha) ACEITO -> 201" "$(ival auth_global_status)" "201"
check "(#2) INSERT in-scope (id_empresa=A) ACEITO -> 201" "$(ival inscope_status)" "201"
check "(#2) INSERT out-of-scope (id_empresa=B) REJEITADO (status != 201)" "$([ "$(ival outscope_status)" != "201" ] && echo sim || echo nao)" "sim"

# Confirma no banco que a linha forjada NÃO existe
N_FORJADO="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='evento_forjado_global'" | tr -d '[:space:]')"
check "(#2) linha global forjada NÃO foi persistida no banco" "$N_FORJADO" "0"

echo
if [ "$fails" = "0" ]; then
  echo "HUB-RLS-INTEGRATION: OK — todos os asserts passaram (FASE 5: 5.2, quickstart Scenario 9, SC-008)"
else
  echo "HUB-RLS-INTEGRATION: $fails assert(s) FALHARAM" >&2
  exit 1
fi

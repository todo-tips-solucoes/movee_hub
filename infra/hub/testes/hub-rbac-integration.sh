#!/usr/bin/env bash
# =============================================================================
# hub-rbac-integration.sh — task 4.2.5/4.3.4 (tasks.md FASE 4): prova E2E de
# /api/v1/me, /api/v1/me/entidade e /api/v1/auditoria contra um projeto
# hub-test EFÊMERO e descartável. Mesmo padrão de isolamento de
# infra/hub/testes/hub-auth-integration.sh (FASE 3) — nunca toca
# chatmasterveloz/produção.
#
# Contas ISOLADAS por cenário (mesma lição empírica da suíte de auth: cada
# uma com sua própria chave de rate-limit e seu próprio conjunto de vínculos,
# para os cenários não competirem entre si).
#
# Cobre:
#   (a) GET /me sem cookie -> 401 NAO_AUTENTICADO
#   (b) GET /me com papel 'operador' (1 vínculo) -> entidades/permissoes
#       corretas; entidade_ativa=null antes de qualquer troca (FR-010)
#   (c) GET /auditoria sem grant 'auditoria.consultar' -> 403 PERMISSAO_NEGADA
#       (mesmo com o gate de permissão executando ANTES de qualquer checagem
#       de entidade ativa)
#   (d) POST /me/entidade para entidade vinculada -> 200 + cookie renovado;
#       GET /me subsequente reflete entidade_ativa e cruza módulos ativos
#       com permissões efetivas (contracts/rbac-me.md §GET /me)
#   (e) POST /me/entidade para entidade NÃO vinculada -> 403 SEM_VINCULO
#       (FR-011), sem side-effect (cookie não é reemitido)
#   (f) papel 'admin_entidade' tem 'auditoria.consultar' (união sem
#       admin.gerenciar, seed 0007) -> GET /auditoria 200 após troca de
#       entidade, e o evento troca_entidade_ativa aparece na trilha,
#       escopado pela MESMA entidade (contracts/auditoria.md)
#   (g) pessoa com vínculo a DUAS entidades (papéis diferentes) -> GET /me
#       lista as duas; troca entre as duas funciona; SEM_VINCULO p/ terceira
#   (h) GET /auditoria sem entidade_ativa selecionada -> 200 { eventos: [] }
#       (nega-por-padrão documentado, nunca 500/vazamento cross-tenant)
#
# Uso: infra/hub/testes/hub-rbac-integration.sh
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

echo "subindo db+postgrest+mailpit-mock+backend efêmeros ($PROJECT, tmpfs)…"
dc up -d --wait db
dc up -d --wait postgrest
dc up -d --wait mailpit-mock
# Cap de memória obrigatório no build (RUNBOOK.md §Build do backend do hub —
# lição de starvation 2026-06-11): DOCKER_BUILDKIT=0 + --memory=2g.
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend (Dockerfile.hub)"; tail -60 "$TMP/build.log"; exit 1; }
dc up -d --wait backend

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
node_e() { dc exec -T backend node -e "$1" "${@:2}"; }
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

echo "rodando migrate.sh (0002..0008, INCLUSIVE 0006/RLS — FASE 5 já implementada; seed 0007 inclui papéis/permissões)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0008_migracao_empresa_para_usuario.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas"; cat "$TMP/migrate.log"; exit 1; }

# --- Seed: 3 Usuarios ativos + vínculos RBAC ---------------------------------
SENHA_OK='SenhaSinteticaRbac#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

# empresa_id sintéticos, fora de qualquer faixa real (referência lógica, sem
# FK física a Empresa — data-model.md §UsuarioEntidade).
E_OPERADOR=910001
E_ADMIN=910002
E_MULTI_A=910003
E_MULTI_B=910004
E_NAO_VINCULADA=999999
# Correção pós-review PR #55 (#1): cenário cross-tenant de auditoria
E_CROSS_A=910005   # onde a pessoa tem só 'leitura' (SEM auditoria.consultar)
E_CROSS_B=910006   # onde a pessoa é 'admin_entidade' (COM auditoria.consultar)

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('rbac-operador@example.test', '$HASH_OK', 'Usuario Teste Operador', true),
  ('rbac-admin@example.test', '$HASH_OK', 'Usuario Teste Admin Entidade', true),
  ('rbac-multi@example.test', '$HASH_OK', 'Usuario Teste Multi Entidade', true),
  ('rbac-crosstenant@example.test', '$HASH_OK', 'Usuario Teste Cross Tenant', true);
SQL
UID_OPERADOR="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='rbac-operador@example.test'" | tr -d '[:space:]')"
UID_ADMIN="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='rbac-admin@example.test'" | tr -d '[:space:]')"
UID_MULTI="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='rbac-multi@example.test'" | tr -d '[:space:]')"
UID_CROSS="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='rbac-crosstenant@example.test'" | tr -d '[:space:]')"

PAPEL_OPERADOR="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='operador'" | tr -d '[:space:]')"
PAPEL_ADMIN_ENTIDADE="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_entidade'" | tr -d '[:space:]')"
PAPEL_LEITURA="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='leitura'" | tr -d '[:space:]')"
[ -n "$PAPEL_OPERADOR" ] && [ -n "$PAPEL_ADMIN_ENTIDADE" ] && [ -n "$PAPEL_LEITURA" ] || { echo "FAIL: seed 0007 não populou os papéis esperados"; exit 1; }

MODULO_DASHBOARD="$(psql_t -tAc "SELECT id FROM \"Modulo\" WHERE codigo='dashboard'" | tr -d '[:space:]')"

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_OPERADOR, $E_OPERADOR, $PAPEL_OPERADOR, true),
  ($UID_ADMIN, $E_ADMIN, $PAPEL_ADMIN_ENTIDADE, true),
  ($UID_MULTI, $E_MULTI_A, $PAPEL_LEITURA, true),
  ($UID_MULTI, $E_MULTI_B, $PAPEL_OPERADOR, true),
  ($UID_CROSS, $E_CROSS_A, $PAPEL_LEITURA, true),
  ($UID_CROSS, $E_CROSS_B, $PAPEL_ADMIN_ENTIDADE, true);

INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo) VALUES
  ($MODULO_DASHBOARD, $E_OPERADOR, true);

-- Trilhas distintas por entidade: se o gate vazasse, ao ativar A (só leitura)
-- o usuário leria estes eventos de A. Escopo real inserido nas claims p/ passar
-- pela policy de INSERT (nega-por-padrão + ramo global fechado em 0009).
INSERT INTO "Auditoria" (id_empresa, usuario_id, acao, recurso, detalhes, criado_em) VALUES
  ($E_CROSS_A, $UID_CROSS, 'evento_cross_a', 'UsuarioEntidade', '{"origem":"rbac-crosstenant"}'::jsonb, now()),
  ($E_CROSS_B, $UID_CROSS, 'evento_cross_b', 'UsuarioEntidade', '{"origem":"rbac-crosstenant"}'::jsonb, now());
SQL

# ─────────────────────────────────────────────────────────────────────────────
# (a) GET /me sem cookie -> 401
# ─────────────────────────────────────────────────────────────────────────────
ST_ME_SEM_COOKIE="$(node_e "
  fetch('http://localhost:3000/api/v1/me').then(r => { process.stdout.write(String(r.status)); process.exit(0); });
" | tr -d '[:space:]')"
check "GET /me sem cookie -> 401" "$ST_ME_SEM_COOKIE" "401"

ST_AUDIT_SEM_COOKIE="$(node_e "
  fetch('http://localhost:3000/api/v1/auditoria').then(r => { process.stdout.write(String(r.status)); process.exit(0); });
" | tr -d '[:space:]')"
check "GET /auditoria sem cookie -> 401" "$ST_AUDIT_SEM_COOKIE" "401"

# ─────────────────────────────────────────────────────────────────────────────
# Cenário 1 — rbac-operador: /me, cruzamento de módulos, SEM_VINCULO,
# PERMISSAO_NEGADA em /auditoria (sem o grant, mesmo após escolher entidade)
# ─────────────────────────────────────────────────────────────────────────────
OUT1="$(run_node "$SENHA_OK" "$E_OPERADOR" "$E_NAO_VINCULADA" <<'JS'
const BASE = 'http://localhost:3000/api/v1';

function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    jar[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }

async function main() {
  const senhaOk = process.argv[2];
  const empresaVinculada = process.argv[3];
  const empresaNaoVinculada = process.argv[4];
  const out = {};

  const rLogin = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'rbac-operador@example.test', senha: senhaOk }) });
  let jar = parseSetCookie(rLogin);
  out.login_status = rLogin.status;

  const rMe1 = await fetch(`${BASE}/me`, { headers: { Cookie: cookieHeader(jar) } });
  const bMe1 = await rMe1.json();
  out.me1_status = rMe1.status;
  out.me1_entidade_ativa = bMe1.entidade_ativa === null ? 'null' : String(bMe1.entidade_ativa);
  out.me1_n_entidades = Array.isArray(bMe1.entidades) ? bMe1.entidades.length : -1;
  out.me1_papel = bMe1.entidades && bMe1.entidades[0] && bMe1.entidades[0].papel;
  out.me1_tem_motoristas_consultar = (bMe1.permissoes || []).includes('motoristas.consultar') ? 'true' : 'false';
  out.me1_tem_auditoria_consultar = (bMe1.permissoes || []).includes('auditoria.consultar') ? 'true' : 'false';
  out.me1_modulos_vazio = Array.isArray(bMe1.modulos) && bMe1.modulos.length === 0 ? 'true' : 'false';

  const rAuditSemEntidade = await fetch(`${BASE}/auditoria`, { headers: { Cookie: cookieHeader(jar) } });
  out.audit_sem_grant_status = rAuditSemEntidade.status;

  const rTrocaInvalida = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: Number(empresaNaoVinculada) }) });
  out.troca_invalida_status = rTrocaInvalida.status;
  const bTrocaInvalida = await rTrocaInvalida.json();
  out.troca_invalida_erro = bTrocaInvalida.erro;

  const rTroca = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: Number(empresaVinculada) }) });
  const bTroca = await rTroca.json();
  out.troca_status = rTroca.status;
  out.troca_entidade_ativa = bTroca.entidade_ativa;
  jar = { ...jar, ...parseSetCookie(rTroca) };

  const rMe2 = await fetch(`${BASE}/me`, { headers: { Cookie: cookieHeader(jar) } });
  const bMe2 = await rMe2.json();
  out.me2_entidade_ativa = bMe2.entidade_ativa;
  out.me2_modulos = (bMe2.modulos || []).map((m) => m.codigo).join(',');

  const rAuditComEntidadeSemGrant = await fetch(`${BASE}/auditoria`, { headers: { Cookie: cookieHeader(jar) } });
  out.audit_com_entidade_sem_grant_status = rAuditComEntidadeSemGrant.status;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT1" | grep -v '___RESULT_JSON___' || true
R1="$(echo "$OUT1" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R1" ] || { echo "FAIL: script Node (cenário 1) não retornou resultado"; echo "$OUT1"; exit 1; }
jget1() { printf '%s' "$R1" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d['$1']))"; }

check "login rbac-operador -> 200" "$(jget1 login_status)" "200"
check "GET /me (operador) -> 200" "$(jget1 me1_status)" "200"
check "GET /me: entidade_ativa=null antes de qualquer troca (FR-010)" "$(jget1 me1_entidade_ativa)" "null"
check "GET /me: 1 entidade vinculada" "$(jget1 me1_n_entidades)" "1"
check "GET /me: papel correto (operador)" "$(jget1 me1_papel)" "operador"
check "GET /me: permissao 'motoristas.consultar' presente (operador)" "$(jget1 me1_tem_motoristas_consultar)" "true"
check "GET /me: permissao 'auditoria.consultar' AUSENTE (operador não tem)" "$(jget1 me1_tem_auditoria_consultar)" "false"
check "GET /me: modulos vazio antes de escolher entidade ativa" "$(jget1 me1_modulos_vazio)" "true"
check "GET /auditoria sem grant -> 403 PERMISSAO_NEGADA (mesmo sem entidade ativa)" "$(jget1 audit_sem_grant_status)" "403"
check "POST /me/entidade para empresa NAO vinculada -> 403 SEM_VINCULO (FR-011)" "$(jget1 troca_invalida_status)" "403"
check "POST /me/entidade (não vinculada): erro=SEM_VINCULO" "$(jget1 troca_invalida_erro)" "SEM_VINCULO"
check "POST /me/entidade para empresa vinculada -> 200" "$(jget1 troca_status)" "200"
check "POST /me/entidade: entidade_ativa retornada = solicitada" "$(jget1 troca_entidade_ativa)" "$E_OPERADOR"
check "GET /me pós-troca: entidade_ativa refletida sem novo login (FR-010)" "$(jget1 me2_entidade_ativa)" "$E_OPERADOR"
check "GET /me pós-troca: modulos cruza ModuloEntidade ativo + permissao (dashboard)" "$(jget1 me2_modulos)" "dashboard"
check "GET /auditoria com entidade ativa mas SEM grant -> ainda 403 (permissão >< entidade)" "$(jget1 audit_com_entidade_sem_grant_status)" "403"

# ─────────────────────────────────────────────────────────────────────────────
# Cenário 2 — rbac-admin (admin_entidade tem auditoria.consultar, seed 0007) —
# GET /auditoria 200 pós-troca; evento troca_entidade_ativa aparece na trilha
# ─────────────────────────────────────────────────────────────────────────────
OUT2="$(run_node "$SENHA_OK" "$E_ADMIN" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }

async function main() {
  const senhaOk = process.argv[2];
  const empresa = Number(process.argv[3]);
  const out = {};

  const rLogin = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'rbac-admin@example.test', senha: senhaOk }) });
  let jar = parseSetCookie(rLogin);

  const rMe = await fetch(`${BASE}/me`, { headers: { Cookie: cookieHeader(jar) } });
  const bMe = await rMe.json();
  out.tem_auditoria_consultar = (bMe.permissoes || []).includes('auditoria.consultar') ? 'true' : 'false';
  out.tem_admin_gerenciar = (bMe.permissoes || []).includes('admin.gerenciar') ? 'true' : 'false';

  // Sem entidade ativa ainda: GET /auditoria deve dar 200 com lista vazia
  // (nega-por-padrão documentado — sem entidade ativa não há escopo seguro).
  const rAuditSemEntidade = await fetch(`${BASE}/auditoria`, { headers: { Cookie: cookieHeader(jar) } });
  const bAuditSemEntidade = await rAuditSemEntidade.json();
  out.audit_sem_entidade_status = rAuditSemEntidade.status;
  out.audit_sem_entidade_vazio = Array.isArray(bAuditSemEntidade.eventos) && bAuditSemEntidade.eventos.length === 0 ? 'true' : 'false';

  const rTroca = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresa }) });
  jar = { ...jar, ...parseSetCookie(rTroca) };
  out.troca_status = rTroca.status;

  const rAudit = await fetch(`${BASE}/auditoria`, { headers: { Cookie: cookieHeader(jar) } });
  const bAudit = await rAudit.json();
  out.audit_status = rAudit.status;
  out.audit_tem_troca_entidade = (bAudit.eventos || []).some((e) => e.acao === 'troca_entidade_ativa') ? 'true' : 'false';
  // hub-auditoria-admin (S9) FASE 3.1: envelope evoluiu p/ camelCase na
  // borda (contracts/auditoria-api.md) — id_empresa -> entidadeId.
  out.audit_todos_da_entidade = (bAudit.eventos || []).every((e) => e.entidadeId === empresa) ? 'true' : 'false';

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT2" | grep -v '___RESULT_JSON___' || true
R2="$(echo "$OUT2" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R2" ] || { echo "FAIL: script Node (cenário 2) não retornou resultado"; echo "$OUT2"; exit 1; }
jget2() { printf '%s' "$R2" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d['$1']))"; }

check "admin_entidade: tem 'auditoria.consultar' (seed 0007)" "$(jget2 tem_auditoria_consultar)" "true"
check "admin_entidade: NAO tem 'admin.gerenciar' (exclusivo admin_plataforma)" "$(jget2 tem_admin_gerenciar)" "false"
check "GET /auditoria sem entidade ativa -> 200 (nunca 500)" "$(jget2 audit_sem_entidade_status)" "200"
check "GET /auditoria sem entidade ativa -> eventos=[] (nega-por-padrao)" "$(jget2 audit_sem_entidade_vazio)" "true"
check "POST /me/entidade (admin) -> 200" "$(jget2 troca_status)" "200"
check "GET /auditoria pós-troca (com grant) -> 200" "$(jget2 audit_status)" "200"
check "GET /auditoria contém evento troca_entidade_ativa" "$(jget2 audit_tem_troca_entidade)" "true"
check "GET /auditoria: todos os eventos escopados pela MESMA entidade ativa" "$(jget2 audit_todos_da_entidade)" "true"

N_TROCA_AUDIT_DB="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE usuario_id=$UID_ADMIN AND acao='troca_entidade_ativa' AND id_empresa=$E_ADMIN" | tr -d '[:space:]')"
check "Auditoria (DB): evento troca_entidade_ativa gravado com id_empresa correto" "$([ "${N_TROCA_AUDIT_DB:-0}" -ge 1 ] 2>/dev/null && echo sim || echo nao)" "sim"

# ─────────────────────────────────────────────────────────────────────────────
# Cenário 3 — rbac-multi: 2 vínculos ativos (papéis diferentes) — GET /me
# lista os dois; troca entre eles funciona; 3ª empresa -> SEM_VINCULO
# ─────────────────────────────────────────────────────────────────────────────
OUT3="$(run_node "$SENHA_OK" "$E_MULTI_A" "$E_MULTI_B" "$E_NAO_VINCULADA" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }

async function main() {
  const senhaOk = process.argv[2];
  const empresaA = Number(process.argv[3]);
  const empresaB = Number(process.argv[4]);
  const empresaNaoVinculada = Number(process.argv[5]);
  const out = {};

  const rLogin = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'rbac-multi@example.test', senha: senhaOk }) });
  let jar = parseSetCookie(rLogin);

  const rMe = await fetch(`${BASE}/me`, { headers: { Cookie: cookieHeader(jar) } });
  const bMe = await rMe.json();
  out.n_entidades = Array.isArray(bMe.entidades) ? bMe.entidades.length : -1;
  const empresaIds = (bMe.entidades || []).map((e) => e.empresa_id).sort((a, b) => a - b);
  out.entidades_corretas = JSON.stringify(empresaIds) === JSON.stringify([empresaA, empresaB].sort((a, b) => a - b)) ? 'true' : 'false';

  const rTrocaA = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaA }) });
  jar = { ...jar, ...parseSetCookie(rTrocaA) };
  out.troca_a_status = rTrocaA.status;

  const rTrocaB = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaB }) });
  jar = { ...jar, ...parseSetCookie(rTrocaB) };
  const bTrocaB = await rTrocaB.json();
  out.troca_b_status = rTrocaB.status;
  out.troca_b_entidade_ativa = bTrocaB.entidade_ativa;

  const rTrocaInvalida = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaNaoVinculada }) });
  out.troca_invalida_status = rTrocaInvalida.status;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT3" | grep -v '___RESULT_JSON___' || true
R3="$(echo "$OUT3" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R3" ] || { echo "FAIL: script Node (cenário 3) não retornou resultado"; echo "$OUT3"; exit 1; }
jget3() { printf '%s' "$R3" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d['$1']))"; }

check "GET /me (multi): lista as 2 entidades vinculadas (FR-010)" "$(jget3 n_entidades)" "2"
check "GET /me (multi): empresa_ids batem com o seed" "$(jget3 entidades_corretas)" "true"
check "POST /me/entidade (multi) -> empresa A -> 200" "$(jget3 troca_a_status)" "200"
check "POST /me/entidade (multi) -> troca para empresa B -> 200 (sem novo login)" "$(jget3 troca_b_status)" "200"
check "POST /me/entidade (multi) -> entidade_ativa = B" "$(jget3 troca_b_entidade_ativa)" "$E_MULTI_B"
check "POST /me/entidade (multi) -> 3ª empresa não vinculada -> 403 SEM_VINCULO" "$(jget3 troca_invalida_status)" "403"

# ─────────────────────────────────────────────────────────────────────────────
# Cenário 4 — CROSS-TENANT DE AUDITORIA (correção pós-review PR #55, achado #1)
# Usuário admin_entidade em B (tem auditoria.consultar) + leitura em A (NÃO tem).
# Antes da correção, ativar A e chamar GET /auditoria vazava a trilha de A,
# porque o gate usava a UNIÃO flat (que enxerga auditoria.consultar vindo de B).
# Esperado agora: ativar A -> 403 PERMISSAO_NEGADA; ativar B -> 200 + trilha de B.
# ─────────────────────────────────────────────────────────────────────────────
OUT4="$(run_node "$SENHA_OK" "$E_CROSS_A" "$E_CROSS_B" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }

async function main() {
  const senhaOk = process.argv[2];
  const empresaA = Number(process.argv[3]); // leitura (sem auditoria.consultar)
  const empresaB = Number(process.argv[4]); // admin_entidade (com auditoria.consultar)
  const out = {};

  const rLogin = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'rbac-crosstenant@example.test', senha: senhaOk }) });
  let jar = parseSetCookie(rLogin);

  const rMe = await fetch(`${BASE}/me`, { headers: { Cookie: cookieHeader(jar) } });
  const bMe = await rMe.json();
  // union flat contém auditoria.consultar (vem de B) — comprova que o gate flat sozinho vazaria
  out.uniao_tem_auditoria = (bMe.permissoes || []).includes('auditoria.consultar') ? 'true' : 'false';

  // Ativa A (leitura) e tenta ler auditoria -> deve NEGAR (403)
  const rTrocaA = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaA }) });
  jar = { ...jar, ...parseSetCookie(rTrocaA) };
  const rAudA = await fetch(`${BASE}/auditoria`, { headers: { Cookie: cookieHeader(jar) } });
  out.audit_A_status = rAudA.status;
  const bAudA = await rAudA.json().catch(() => ({}));
  out.audit_A_vazou_evento_a = Array.isArray(bAudA.eventos) && bAudA.eventos.some((e) => e.acao === 'evento_cross_a') ? 'true' : 'false';

  // Ativa B (admin_entidade) e lê auditoria -> 200 + trilha de B
  const rTrocaB = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaB }) });
  jar = { ...jar, ...parseSetCookie(rTrocaB) };
  const rAudB = await fetch(`${BASE}/auditoria`, { headers: { Cookie: cookieHeader(jar) } });
  out.audit_B_status = rAudB.status;
  const bAudB = await rAudB.json().catch(() => ({}));
  out.audit_B_tem_evento_b = Array.isArray(bAudB.eventos) && bAudB.eventos.some((e) => e.acao === 'evento_cross_b') ? 'true' : 'false';
  // hub-auditoria-admin (S9) FASE 3.1: id_empresa -> entidadeId (camelCase).
  out.audit_B_todos_da_entidade = Array.isArray(bAudB.eventos) && bAudB.eventos.every((e) => e.entidadeId === empresaB) ? 'true' : 'false';

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT4" | grep -v '___RESULT_JSON___' || true
R4="$(echo "$OUT4" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R4" ] || { echo "FAIL: script Node (cenário 4 cross-tenant) não retornou resultado"; echo "$OUT4"; exit 1; }
jget4() { printf '%s' "$R4" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d['$1']))"; }

check "(#1) união flat contém auditoria.consultar (vinda de B) — gate flat sozinho vazaria" "$(jget4 uniao_tem_auditoria)" "true"
check "(#1) GET /auditoria com entidade ATIVA=A (só leitura) -> 403 (gate por-entidade)" "$(jget4 audit_A_status)" "403"
check "(#1) trilha de A NÃO vazou ao ativar A sem auditoria.consultar" "$(jget4 audit_A_vazou_evento_a)" "false"
check "(#1) GET /auditoria com entidade ATIVA=B (admin_entidade) -> 200" "$(jget4 audit_B_status)" "200"
check "(#1) trilha de B retornada ao ativar B (uso legítimo preservado)" "$(jget4 audit_B_tem_evento_b)" "true"
check "(#1) todos os eventos em B escopados por B" "$(jget4 audit_B_todos_da_entidade)" "true"

echo
if [ "$fails" = "0" ]; then
  echo "HUB-RBAC-INTEGRATION: OK — todos os asserts passaram (FASE 4: 4.1/4.2/4.3)"
else
  echo "HUB-RBAC-INTEGRATION: $fails assert(s) FALHARAM" >&2
  exit 1
fi

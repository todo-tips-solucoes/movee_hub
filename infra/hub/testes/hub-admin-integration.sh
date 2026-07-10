#!/usr/bin/env bash
# =============================================================================
# hub-admin-integration.sh — task 4.4.8 (tasks.md FASE 4.4): prova E2E de
# /api/v1/admin (módulos por entidade) contra um projeto hub-test EFÊMERO e
# descartável. Mesmo padrão de isolamento de
# infra/hub/testes/hub-papeis-integration.sh — nunca toca
# chatmasterveloz/produção.
#
# Cobre (Cenário 7 do quickstart):
#   (a) sem cookie -> 401
#   (b) admin_entidade (sem claim admin_plataforma) -> 403 PERMISSAO_NEGADA
#       em GET /admin/modulos — nem LEITURA (FR-017/dec-009)
#   (c) admin_plataforma: GET /admin/modulos -> 200, catálogo completo
#   (d) admin_plataforma: GET /admin/entidades/:id/modulos -> estado por
#       entidade, módulo sem linha = habilitado:false
#   (e) PUT desabilitando 'usuarios' para a entidade B -> efeito IMEDIATO:
#       requireModuloAtivo('usuarios') responde 403 MODULO_DESABILITADO na
#       PRÓXIMA chamada de QUALQUER usuário de B, sem esperar TTL (SC-005)
#   (f) guard anti-lockout: PUT 'admin' habilitado:false na PRÓPRIA entidade
#       ativa do chamador -> 409 OPERACAO_BLOQUEADA; para OUTRA entidade
#       permanece permitido -> 200
#   (g) 404 ENTIDADE_NAO_ENCONTRADA / MODULO_NAO_ENCONTRADO
#
# Uso: infra/hub/testes/hub-admin-integration.sh
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
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend (Dockerfile.hub)"; tail -60 "$TMP/build.log"; exit 1; }
dc up -d --wait backend

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
node_e() { dc exec -T backend node -e "$1" "${@:2}"; }
run_node() { dc exec -T backend node - "$@"; }

fails=0
check() {
  if [ "$2" = "$3" ]; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 (obtido='$2' esperado='$3')"
    fails=$((fails + 1))
  fi
}

echo "rodando migrate.sh (todas as migrations, inclusive 0033/0036/0039 — Empresa legado + RLS ModuloEntidade/UsuarioEntidade)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0039_usuarioentidade_escrita_admin.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas até 0039"; cat "$TMP/migrate.log"; exit 1; }

SENHA_OK='SenhaSinteticaAdmin#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

# entidades sintéticas — Empresa legado (0033) precisa de linha real p/
# ENTIDADE_NAO_ENCONTRADA fazer sentido (FK lógica, sem FK física).
E_ADMIN=940001
E_B=940002

psql_t <<SQL >/dev/null
INSERT INTO "Empresa" (id, nome_empresa, email) VALUES
  ($E_ADMIN, 'Entidade Admin Teste', 'admin-entidade-teste@example.test'),
  ($E_B, 'Entidade B Teste', 'entidade-b-teste@example.test')
ON CONFLICT (id) DO NOTHING;
SQL

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('admin-plataforma-modulos@example.test', '$HASH_OK', 'Admin Plataforma Modulos', true),
  ('admin-entidade-modulos@example.test', '$HASH_OK', 'Admin Entidade Modulos', true),
  ('operador-b-modulos@example.test', '$HASH_OK', 'Operador B Modulos', true);
SQL
UID_ADMIN_PLATAFORMA="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='admin-plataforma-modulos@example.test'" | tr -d '[:space:]')"
UID_ADMIN_ENTIDADE="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='admin-entidade-modulos@example.test'" | tr -d '[:space:]')"
UID_OPERADOR_B="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='operador-b-modulos@example.test'" | tr -d '[:space:]')"

PAPEL_ADMIN_PLATAFORMA="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_plataforma'" | tr -d '[:space:]')"
PAPEL_ADMIN_ENTIDADE="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_entidade'" | tr -d '[:space:]')"
PAPEL_OPERADOR="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='operador'" | tr -d '[:space:]')"
MODULO_USUARIOS="$(psql_t -tAc "SELECT id FROM \"Modulo\" WHERE codigo='usuarios'" | tr -d '[:space:]')"
MODULO_ADMIN="$(psql_t -tAc "SELECT id FROM \"Modulo\" WHERE codigo='admin'" | tr -d '[:space:]')"
MODULO_DASHBOARD="$(psql_t -tAc "SELECT id FROM \"Modulo\" WHERE codigo='dashboard'" | tr -d '[:space:]')"
[ -n "$PAPEL_ADMIN_PLATAFORMA" ] && [ -n "$MODULO_USUARIOS" ] && [ -n "$MODULO_ADMIN" ] || { echo "FAIL: seed 0007 incompleto"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_ADMIN_PLATAFORMA, $E_ADMIN, $PAPEL_ADMIN_PLATAFORMA, true),
  ($UID_ADMIN_ENTIDADE, $E_ADMIN, $PAPEL_ADMIN_ENTIDADE, true),
  ($UID_OPERADOR_B, $E_B, $PAPEL_OPERADOR, true);

INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo) VALUES
  ($MODULO_ADMIN, $E_ADMIN, true),
  ($MODULO_USUARIOS, $E_B, true),
  ($MODULO_DASHBOARD, $E_B, true);
SQL

BASE_HELPERS='
function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    jar[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "); }
async function login(email, senha) {
  const r = await fetch("http://localhost:3000/api/v1/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, senha }) });
  let jar = parseSetCookie(r);
  return { status: r.status, jar };
}
async function trocaEntidade(jar, empresaId) {
  const r = await fetch("http://localhost:3000/api/v1/me/entidade", { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaId }) });
  const novoJar = { ...jar, ...parseSetCookie(r) };
  return { status: r.status, jar: novoJar };
}
'

ST_SEM_COOKIE="$(node_e "
  fetch('http://localhost:3000/api/v1/admin/modulos').then(r => { process.stdout.write(String(r.status)); process.exit(0); });
" | tr -d '[:space:]')"
check "GET /admin/modulos sem cookie -> 401" "$ST_SEM_COOKIE" "401"

OUT1="$(run_node "$SENHA_OK" "$E_ADMIN" "$E_B" <<JS
$BASE_HELPERS
async function main() {
  const senhaOk = process.argv[2];
  const empresaAdmin = Number(process.argv[3]);
  const empresaB = Number(process.argv[4]);
  const out = {};

  // --- admin_entidade (sem claim admin_plataforma) -> 403 mesmo em GET ------
  let { jar: jarAE } = await login('admin-entidade-modulos@example.test', senhaOk);
  ({ jar: jarAE } = await trocaEntidade(jarAE, empresaAdmin));
  const rGetAE = await fetch('http://localhost:3000/api/v1/admin/modulos', { headers: { Cookie: cookieHeader(jarAE) } });
  const bGetAE = await rGetAE.json();
  out.get_ae_status = rGetAE.status;
  out.get_ae_erro = bGetAE.erro;

  // --- admin_plataforma: GET /admin/modulos -> 200, catalogo --------------
  let { jar: jarAP } = await login('admin-plataforma-modulos@example.test', senhaOk);
  ({ jar: jarAP } = await trocaEntidade(jarAP, empresaAdmin));
  const rCatalogo = await fetch('http://localhost:3000/api/v1/admin/modulos', { headers: { Cookie: cookieHeader(jarAP) } });
  const bCatalogo = await rCatalogo.json();
  out.catalogo_status = rCatalogo.status;
  out.catalogo_tem_9_modulos = Array.isArray(bCatalogo.modulos) && bCatalogo.modulos.length === 9 ? 'true' : 'false';

  // --- GET /admin/entidades/:id/modulos (entidade B) ------------------------
  const rEstadoB = await fetch(\`http://localhost:3000/api/v1/admin/entidades/\${empresaB}/modulos\`, { headers: { Cookie: cookieHeader(jarAP) } });
  const bEstadoB = await rEstadoB.json();
  out.estado_b_status = rEstadoB.status;
  const usuariosEmB = (bEstadoB.modulos || []).find((m) => m.codigo === 'usuarios');
  out.estado_b_usuarios_habilitado = usuariosEmB && usuariosEmB.habilitado ? 'true' : 'false';
  const envioMassaEmB = (bEstadoB.modulos || []).find((m) => m.codigo === 'envio_massa');
  out.estado_b_envio_massa_habilitado = envioMassaEmB && envioMassaEmB.habilitado ? 'true' : 'false';

  // --- operador-b tem acesso a /usuarios ANTES de desabilitar (deve dar 403
  //     por falta de PERMISSAO, nao por MODULO_DESABILITADO — confirma que a
  //     rota responde e nao 500) --------------------------------------------
  let { jar: jarOpB } = await login('operador-b-modulos@example.test', senhaOk);
  ({ jar: jarOpB } = await trocaEntidade(jarOpB, empresaB));
  const rUsuariosAntes = await fetch('http://localhost:3000/api/v1/usuarios', { headers: { Cookie: cookieHeader(jarOpB) } });
  out.usuarios_antes_status = rUsuariosAntes.status;

  // --- (e) desabilita 'usuarios' para B -> efeito IMEDIATO ------------------
  const rDesabilitar = await fetch(\`http://localhost:3000/api/v1/admin/entidades/\${empresaB}/modulos/usuarios\`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jarAP) },
    body: JSON.stringify({ habilitado: false }),
  });
  const bDesabilitar = await rDesabilitar.json();
  out.desabilitar_status = rDesabilitar.status;
  out.desabilitar_habilitado = bDesabilitar.habilitado;

  const rUsuariosDepois = await fetch('http://localhost:3000/api/v1/usuarios', { headers: { Cookie: cookieHeader(jarOpB) } });
  const bUsuariosDepois = await rUsuariosDepois.json();
  out.usuarios_depois_status = rUsuariosDepois.status;
  out.usuarios_depois_erro = bUsuariosDepois.erro;

  // reabilita (restaura estado, SC-005 passo 5)
  const rReabilitar = await fetch(\`http://localhost:3000/api/v1/admin/entidades/\${empresaB}/modulos/usuarios\`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jarAP) },
    body: JSON.stringify({ habilitado: true }),
  });
  const bReabilitar = await rReabilitar.json();
  out.reabilitar_status = rReabilitar.status;
  out.reabilitar_habilitado = bReabilitar.habilitado;

  const rUsuariosReabilitado = await fetch('http://localhost:3000/api/v1/usuarios', { headers: { Cookie: cookieHeader(jarOpB) } });
  out.usuarios_reabilitado_status = rUsuariosReabilitado.status;

  // --- (f) guard anti-lockout: 'admin' na PROPRIA entidade ativa -> 409 ----
  const rAntiLockout = await fetch(\`http://localhost:3000/api/v1/admin/entidades/\${empresaAdmin}/modulos/admin\`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jarAP) },
    body: JSON.stringify({ habilitado: false }),
  });
  const bAntiLockout = await rAntiLockout.json();
  out.anti_lockout_status = rAntiLockout.status;
  out.anti_lockout_erro = bAntiLockout.erro;

  // desabilitar 'admin' para OUTRA entidade (B) permanece permitido -> 200
  const rDesabilitarAdminB = await fetch(\`http://localhost:3000/api/v1/admin/entidades/\${empresaB}/modulos/admin\`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jarAP) },
    body: JSON.stringify({ habilitado: false }),
  });
  const bDesabilitarAdminB = await rDesabilitarAdminB.json();
  out.desabilitar_admin_b_status = rDesabilitarAdminB.status;

  // --- (g) 404s --------------------------------------------------------------
  const rEntidadeInexistente = await fetch('http://localhost:3000/api/v1/admin/entidades/999999/modulos', { headers: { Cookie: cookieHeader(jarAP) } });
  const bEntidadeInexistente = await rEntidadeInexistente.json();
  out.entidade_inexistente_status = rEntidadeInexistente.status;
  out.entidade_inexistente_erro = bEntidadeInexistente.erro;

  const rModuloInexistente = await fetch(\`http://localhost:3000/api/v1/admin/entidades/\${empresaAdmin}/modulos/codigo_fantasma\`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jarAP) },
    body: JSON.stringify({ habilitado: true }),
  });
  const bModuloInexistente = await rModuloInexistente.json();
  out.modulo_inexistente_status = rModuloInexistente.status;
  out.modulo_inexistente_erro = bModuloInexistente.erro;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT1" | grep -v '___RESULT_JSON___' || true
R1="$(echo "$OUT1" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R1" ] || { echo "FAIL: script Node não retornou resultado"; echo "$OUT1"; exit 1; }
jget() { printf '%s' "$R1" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d['$1']))"; }

check "admin_entidade GET /admin/modulos -> 403 (FR-017, nem leitura)" "$(jget get_ae_status)" "403"
check "admin_entidade -> erro=PERMISSAO_NEGADA" "$(jget get_ae_erro)" "PERMISSAO_NEGADA"
check "admin_plataforma GET /admin/modulos -> 200" "$(jget catalogo_status)" "200"
check "catalogo tem os 9 modulos seedados (0007)" "$(jget catalogo_tem_9_modulos)" "true"
check "GET /admin/entidades/:id/modulos (B) -> 200" "$(jget estado_b_status)" "200"
check "estado B: usuarios habilitado=true (seed do script)" "$(jget estado_b_usuarios_habilitado)" "true"
check "estado B: envio_massa habilitado=false (sem linha, deny-by-default)" "$(jget estado_b_envio_massa_habilitado)" "false"
check "operador-b GET /usuarios ANTES (sem usuarios.gerenciar) -> 403" "$(jget usuarios_antes_status)" "403"
check "PUT desabilitar usuarios(B) -> 200" "$(jget desabilitar_status)" "200"
check "PUT desabilitar -> habilitado=false na resposta" "$(jget desabilitar_habilitado)" "false"
check "operador-b GET /usuarios DEPOIS (modulo desabilitado) -> 403 IMEDIATO (SC-005)" "$(jget usuarios_depois_status)" "403"
check "operador-b GET /usuarios DEPOIS -> erro=MODULO_DESABILITADO" "$(jget usuarios_depois_erro)" "MODULO_DESABILITADO"
check "PUT reabilitar usuarios(B) -> 200" "$(jget reabilitar_status)" "200"
check "PUT reabilitar -> habilitado=true na resposta" "$(jget reabilitar_habilitado)" "true"
check "operador-b GET /usuarios REABILITADO -> volta a 403 por PERMISSAO (nao mais MODULO_DESABILITADO)" "$(jget usuarios_reabilitado_status)" "403"
check "guard anti-lockout: PUT admin=false na PROPRIA entidade ativa -> 409" "$(jget anti_lockout_status)" "409"
check "guard anti-lockout -> erro=OPERACAO_BLOQUEADA" "$(jget anti_lockout_erro)" "OPERACAO_BLOQUEADA"
check "desabilitar admin para OUTRA entidade (B) permanece permitido -> 200" "$(jget desabilitar_admin_b_status)" "200"
check "entidadeId inexistente -> 404" "$(jget entidade_inexistente_status)" "404"
check "entidadeId inexistente -> erro=ENTIDADE_NAO_ENCONTRADA" "$(jget entidade_inexistente_erro)" "ENTIDADE_NAO_ENCONTRADA"
check "codigo de modulo inexistente -> 404" "$(jget modulo_inexistente_status)" "404"
check "codigo de modulo inexistente -> erro=MODULO_NAO_ENCONTRADO" "$(jget modulo_inexistente_erro)" "MODULO_NAO_ENCONTRADO"

N_AUDIT="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='modulo_entidade_alterado' AND id_empresa=$E_B" | tr -d '[:space:]')"
check "Auditoria (DB): evento modulo_entidade_alterado gravado na entidade AFETADA (B)" "$([ "${N_AUDIT:-0}" -ge 2 ] 2>/dev/null && echo sim || echo nao)" "sim"

N_ADMIN_INTACTO="$(psql_t -tAc "SELECT ativo FROM \"ModuloEntidade\" WHERE modulo_id=$MODULO_ADMIN AND empresa_id=$E_ADMIN" | tr -d '[:space:]')"
check "DB: modulo 'admin' da entidade do chamador NAO foi desabilitado (anti-lockout efetivo)" "$N_ADMIN_INTACTO" "t"

echo
if [ "$fails" -eq 0 ]; then
  echo "HUB-ADMIN-INTEGRATION: OK — todos os asserts passaram (FASE 4.4)"
  exit 0
else
  echo "HUB-ADMIN-INTEGRATION: FALHOU — $fails assert(s) falharam"
  exit 1
fi

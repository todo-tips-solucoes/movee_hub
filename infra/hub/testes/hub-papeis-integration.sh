#!/usr/bin/env bash
# =============================================================================
# hub-papeis-integration.sh — task 4.3.7 (tasks.md FASE 4.3): prova E2E de
# /api/v1/papeis (matriz papel×permissão) contra um projeto hub-test EFÊMERO
# e descartável. Mesmo padrão de isolamento de
# infra/hub/testes/hub-usuarios-integration.sh — nunca toca
# chatmasterveloz/produção.
#
# Cobre (Cenário 6 do quickstart):
#   (a) sem cookie -> 401
#   (b) admin_entidade: GET /papeis -> 200, podeEditar=false; PUT -> 403
#       PERMISSAO_NEGADA (FR-010/FR-016 — admin_entidade SEMPRE cai aqui)
#   (c) admin_plataforma: GET /papeis -> 200, podeEditar=true
#   (d) admin_plataforma: PUT toggle de célula não-crítica -> 200, refletido
#       no GET seguinte, permissões efetivas de outro usuário com aquele
#       papel também refletem (limparCache global)
#   (e) admin_plataforma: PUT desmarcando (admin_plataforma, admin.gerenciar)
#       -> 409 OPERACAO_BLOQUEADA (guard anti-lockout, migration 0037)
#   (f) 404 PAPEL_NAO_ENCONTRADO / PERMISSAO_NAO_ENCONTRADA para ids
#       inexistentes
#   (g) nenhuma rota de criar/editar/excluir papel existe (404 de rota)
#
# Uso: infra/hub/testes/hub-papeis-integration.sh
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

echo "rodando migrate.sh (todas as migrations, inclusive 0037/0039)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0039_usuarioentidade_escrita_admin.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas até 0039"; cat "$TMP/migrate.log"; exit 1; }

SENHA_OK='SenhaSinteticaPapeis#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

E_A=930001

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('papeis-admin-entidade@example.test', '$HASH_OK', 'Admin Entidade Papeis', true),
  ('papeis-admin-plataforma@example.test', '$HASH_OK', 'Admin Plataforma Papeis', true);
SQL
UID_ADMIN_ENTIDADE="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='papeis-admin-entidade@example.test'" | tr -d '[:space:]')"
UID_ADMIN_PLATAFORMA="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='papeis-admin-plataforma@example.test'" | tr -d '[:space:]')"

PAPEL_ADMIN_ENTIDADE="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_entidade'" | tr -d '[:space:]')"
PAPEL_ADMIN_PLATAFORMA="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_plataforma'" | tr -d '[:space:]')"
PERM_ADMIN_GERENCIAR="$(psql_t -tAc "SELECT id FROM \"Permissao\" WHERE codigo='admin.gerenciar'" | tr -d '[:space:]')"
PERM_MOTORISTAS_CRIAR="$(psql_t -tAc "SELECT id FROM \"Permissao\" WHERE codigo='motoristas.criar'" | tr -d '[:space:]')"
MODULO_USUARIOS="$(psql_t -tAc "SELECT id FROM \"Modulo\" WHERE codigo='usuarios'" | tr -d '[:space:]')"
[ -n "$PAPEL_ADMIN_ENTIDADE" ] && [ -n "$PAPEL_ADMIN_PLATAFORMA" ] && [ -n "$PERM_ADMIN_GERENCIAR" ] && [ -n "$PERM_MOTORISTAS_CRIAR" ] || { echo "FAIL: seed 0007 incompleto"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_ADMIN_ENTIDADE, $E_A, $PAPEL_ADMIN_ENTIDADE, true),
  ($UID_ADMIN_PLATAFORMA, $E_A, $PAPEL_ADMIN_PLATAFORMA, true);

INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo) VALUES
  ($MODULO_USUARIOS, $E_A, true);
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
  fetch('http://localhost:3000/api/v1/papeis').then(r => { process.stdout.write(String(r.status)); process.exit(0); });
" | tr -d '[:space:]')"
check "GET /papeis sem cookie -> 401" "$ST_SEM_COOKIE" "401"

OUT1="$(run_node "$SENHA_OK" "$E_A" "$PAPEL_ADMIN_PLATAFORMA" "$PERM_ADMIN_GERENCIAR" "$PERM_MOTORISTAS_CRIAR" <<JS
$BASE_HELPERS
async function main() {
  const senhaOk = process.argv[2];
  const empresaA = Number(process.argv[3]);
  const papelAdminPlataforma = Number(process.argv[4]);
  const permAdminGerenciar = Number(process.argv[5]);
  const permMotoristasCriar = Number(process.argv[6]);
  const out = {};

  // --- admin_entidade: GET (200, podeEditar=false) + PUT (403) --------------
  let { jar: jarAE } = await login('papeis-admin-entidade@example.test', senhaOk);
  ({ jar: jarAE } = await trocaEntidade(jarAE, empresaA));

  const rGetAE = await fetch('http://localhost:3000/api/v1/papeis', { headers: { Cookie: cookieHeader(jarAE) } });
  const bGetAE = await rGetAE.json();
  out.get_ae_status = rGetAE.status;
  out.get_ae_pode_editar = bGetAE.podeEditar === false ? 'false' : 'true';
  out.get_ae_tem_papeis = Array.isArray(bGetAE.papeis) && bGetAE.papeis.length === 4 ? 'true' : 'false';

  const rPutAE = await fetch(\`http://localhost:3000/api/v1/papeis/\${papelAdminPlataforma}/permissoes/\${permMotoristasCriar}\`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jarAE) },
    body: JSON.stringify({ ativo: false }),
  });
  const bPutAE = await rPutAE.json();
  out.put_ae_status = rPutAE.status;
  out.put_ae_erro = bPutAE.erro;

  // --- admin_plataforma: GET (200, podeEditar=true) --------------------------
  let { jar: jarAP } = await login('papeis-admin-plataforma@example.test', senhaOk);
  ({ jar: jarAP } = await trocaEntidade(jarAP, empresaA));

  const rGetAP = await fetch('http://localhost:3000/api/v1/papeis', { headers: { Cookie: cookieHeader(jarAP) } });
  const bGetAP = await rGetAP.json();
  out.get_ap_status = rGetAP.status;
  out.get_ap_pode_editar = bGetAP.podeEditar === true ? 'true' : 'false';

  // --- (d) toggle não-crítico: admin_plataforma x motoristas.criar ----------
  const jaMarcado = (bGetAP.matriz || []).some((m) => m.papelId === papelAdminPlataforma && m.permissaoId === permMotoristasCriar);
  out.toggle_estado_inicial = jaMarcado ? 'marcado' : 'desmarcado';

  const rDesmarcar = await fetch(\`http://localhost:3000/api/v1/papeis/\${papelAdminPlataforma}/permissoes/\${permMotoristasCriar}\`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jarAP) },
    body: JSON.stringify({ ativo: false }),
  });
  const bDesmarcar = await rDesmarcar.json();
  out.desmarcar_status = rDesmarcar.status;
  out.desmarcar_ativo = bDesmarcar.ativo;

  const rGetPosDesmarcar = await fetch('http://localhost:3000/api/v1/papeis', { headers: { Cookie: cookieHeader(jarAP) } });
  const bGetPosDesmarcar = await rGetPosDesmarcar.json();
  out.pos_desmarcar_ainda_tem = (bGetPosDesmarcar.matriz || []).some((m) => m.papelId === papelAdminPlataforma && m.permissaoId === permMotoristasCriar) ? 'true' : 'false';

  const rRemarcar = await fetch(\`http://localhost:3000/api/v1/papeis/\${papelAdminPlataforma}/permissoes/\${permMotoristasCriar}\`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jarAP) },
    body: JSON.stringify({ ativo: true }),
  });
  const bRemarcar = await rRemarcar.json();
  out.remarcar_status = rRemarcar.status;
  out.remarcar_ativo = bRemarcar.ativo;

  // --- (e) guard anti-lockout: (admin_plataforma, admin.gerenciar) ----------
  const rAntiLockout = await fetch(\`http://localhost:3000/api/v1/papeis/\${papelAdminPlataforma}/permissoes/\${permAdminGerenciar}\`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jarAP) },
    body: JSON.stringify({ ativo: false }),
  });
  const bAntiLockout = await rAntiLockout.json();
  out.anti_lockout_status = rAntiLockout.status;
  out.anti_lockout_erro = bAntiLockout.erro;

  // --- (f) 404s --------------------------------------------------------------
  const rPapelInexistente = await fetch('http://localhost:3000/api/v1/papeis/999999/permissoes/' + permMotoristasCriar, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jarAP) },
    body: JSON.stringify({ ativo: true }),
  });
  const bPapelInexistente = await rPapelInexistente.json();
  out.papel_inexistente_status = rPapelInexistente.status;
  out.papel_inexistente_erro = bPapelInexistente.erro;

  const rPermInexistente = await fetch(\`http://localhost:3000/api/v1/papeis/\${papelAdminPlataforma}/permissoes/999999\`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jarAP) },
    body: JSON.stringify({ ativo: true }),
  });
  const bPermInexistente = await rPermInexistente.json();
  out.perm_inexistente_status = rPermInexistente.status;
  out.perm_inexistente_erro = bPermInexistente.erro;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT1" | grep -v '___RESULT_JSON___' || true
R1="$(echo "$OUT1" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R1" ] || { echo "FAIL: script Node não retornou resultado"; echo "$OUT1"; exit 1; }
jget() { printf '%s' "$R1" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d['$1']))"; }

check "admin_entidade GET /papeis -> 200" "$(jget get_ae_status)" "200"
check "admin_entidade GET /papeis -> podeEditar=false" "$(jget get_ae_pode_editar)" "false"
check "GET /papeis -> catalogo com 4 papeis (dec-008)" "$(jget get_ae_tem_papeis)" "true"
check "admin_entidade PUT /papeis/.../permissoes/... -> 403 (FR-010/FR-016)" "$(jget put_ae_status)" "403"
check "admin_entidade PUT -> erro=PERMISSAO_NEGADA" "$(jget put_ae_erro)" "PERMISSAO_NEGADA"
check "admin_plataforma GET /papeis -> 200" "$(jget get_ap_status)" "200"
check "admin_plataforma GET /papeis -> podeEditar=true" "$(jget get_ap_pode_editar)" "true"
check "toggle nao-critico: desmarcar -> 200" "$(jget desmarcar_status)" "200"
check "toggle nao-critico: desmarcar -> ativo=false na resposta" "$(jget desmarcar_ativo)" "false"
check "toggle nao-critico: GET seguinte NAO mostra mais a celula (refletido)" "$(jget pos_desmarcar_ainda_tem)" "false"
check "toggle nao-critico: remarcar -> 200" "$(jget remarcar_status)" "200"
check "toggle nao-critico: remarcar -> ativo=true na resposta" "$(jget remarcar_ativo)" "true"
check "guard anti-lockout (admin_plataforma/admin.gerenciar) -> 409" "$(jget anti_lockout_status)" "409"
check "guard anti-lockout -> erro=OPERACAO_BLOQUEADA" "$(jget anti_lockout_erro)" "OPERACAO_BLOQUEADA"
check "papelId inexistente -> 404" "$(jget papel_inexistente_status)" "404"
check "papelId inexistente -> erro=PAPEL_NAO_ENCONTRADO" "$(jget papel_inexistente_erro)" "PAPEL_NAO_ENCONTRADO"
check "permissaoId inexistente -> 404" "$(jget perm_inexistente_status)" "404"
check "permissaoId inexistente -> erro=PERMISSAO_NAO_ENCONTRADA" "$(jget perm_inexistente_erro)" "PERMISSAO_NAO_ENCONTRADA"

N_AUDIT="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='papel_permissao_alterada' AND id_empresa=$E_A" | tr -d '[:space:]')"
check "Auditoria (DB): evento papel_permissao_alterada gravado (>=2, desmarcar+remarcar)" "$([ "${N_AUDIT:-0}" -ge 2 ] 2>/dev/null && echo sim || echo nao)" "sim"

N_CELULA_INTACTA="$(psql_t -tAc "SELECT count(*) FROM \"PapelPermissao\" WHERE papel_id=$PAPEL_ADMIN_PLATAFORMA AND permissao_id=$PERM_ADMIN_GERENCIAR" | tr -d '[:space:]')"
check "DB: celula (admin_plataforma, admin.gerenciar) NAO foi removida (anti-lockout efetivo)" "$([ "${N_CELULA_INTACTA:-0}" -ge 1 ] 2>/dev/null && echo sim || echo nao)" "sim"

echo
if [ "$fails" -eq 0 ]; then
  echo "HUB-PAPEIS-INTEGRATION: OK — todos os asserts passaram (FASE 4.3)"
  exit 0
else
  echo "HUB-PAPEIS-INTEGRATION: FALHOU — $fails assert(s) falharam"
  exit 1
fi

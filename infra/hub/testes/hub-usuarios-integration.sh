#!/usr/bin/env bash
# =============================================================================
# hub-usuarios-integration.sh — task 4.2.9 (tasks.md FASE 4.2): prova E2E de
# /api/v1/usuarios contra um projeto hub-test EFÊMERO e descartável. Mesmo
# padrão de isolamento de infra/hub/testes/hub-rbac-integration.sh — nunca
# toca chatmasterveloz/produção.
#
# Cobre (Cenário 5 do quickstart + isolamento por entidade):
#   (a) sem cookie -> 401 NAO_AUTENTICADO
#   (b) sem 'usuarios.gerenciar' (papel 'operador') -> 403 PERMISSAO_NEGADA
#   (c) admin_entidade: GET /usuarios lista só os vínculos da PRÓPRIA entidade
#   (d) POST /usuarios cria usuário + 1º vínculo em um passo (SC-008);
#       e-mail duplicado -> 409 EMAIL_JA_CADASTRADO; senha fraca -> 400
#       SENHA_FRACA
#   (e) PUT /usuarios/:id edita nome/ativo (CHK033: desativar = ativo:false)
#   (f) POST /usuarios/:id/vinculos cria vínculo adicional; vínculo
#       duplicado -> 409 VINCULO_JA_EXISTE
#   (g) PUT /usuarios/:id/vinculos/:vinculoId troca papelId — reflete nas
#       permissões efetivas SEM esperar TTL (SC-004, invalidarUsuario síncrono)
#   (h) isolamento: admin_entidade da entidade A não vê/edita usuário só
#       vinculado à entidade B (404 USUARIO_NAO_ENCONTRADO, nunca vazamento)
#
# Uso: infra/hub/testes/hub-usuarios-integration.sh
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
check() { # check <descricao> <valor-obtido> <valor-esperado>
  if [ "$2" = "$3" ]; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 (obtido='$2' esperado='$3')"
    fails=$((fails + 1))
  fi
}

echo "rodando migrate.sh (todas as migrations, inclusive 0039 — RLS de escrita em UsuarioEntidade)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0039_usuarioentidade_escrita_admin.sql" "$TMP/migrate.log" || { echo "FAIL: migration 0039 não aplicada"; cat "$TMP/migrate.log"; exit 1; }

# --- Seed: 2 admin_entidade (entidades A/B distintas) + 1 operador ----------
SENHA_OK='SenhaSinteticaUsuarios#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

E_A=920001
E_B=920002

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('usu-admin-a@example.test', '$HASH_OK', 'Admin Entidade A', true),
  ('usu-operador-a@example.test', '$HASH_OK', 'Operador A', true),
  ('usu-alvo-b@example.test', '$HASH_OK', 'Usuario Alvo B', true);
SQL
UID_ADMIN_A="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='usu-admin-a@example.test'" | tr -d '[:space:]')"
UID_OPERADOR_A="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='usu-operador-a@example.test'" | tr -d '[:space:]')"
UID_ALVO_B="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='usu-alvo-b@example.test'" | tr -d '[:space:]')"

PAPEL_ADMIN_ENTIDADE="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_entidade'" | tr -d '[:space:]')"
PAPEL_OPERADOR="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='operador'" | tr -d '[:space:]')"
PAPEL_LEITURA="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='leitura'" | tr -d '[:space:]')"
MODULO_USUARIOS="$(psql_t -tAc "SELECT id FROM \"Modulo\" WHERE codigo='usuarios'" | tr -d '[:space:]')"
[ -n "$PAPEL_ADMIN_ENTIDADE" ] && [ -n "$PAPEL_OPERADOR" ] && [ -n "$MODULO_USUARIOS" ] || { echo "FAIL: seed 0007 não populou papéis/módulo 'usuarios'"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_ADMIN_A, $E_A, $PAPEL_ADMIN_ENTIDADE, true),
  ($UID_OPERADOR_A, $E_A, $PAPEL_OPERADOR, true),
  ($UID_ALVO_B, $E_B, $PAPEL_LEITURA, true);

INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo) VALUES
  ($MODULO_USUARIOS, $E_A, true),
  ($MODULO_USUARIOS, $E_B, true);
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

# ─────────────────────────────────────────────────────────────────────────────
# (a) sem cookie -> 401
# ─────────────────────────────────────────────────────────────────────────────
ST_SEM_COOKIE="$(node_e "
  fetch('http://localhost:3000/api/v1/usuarios').then(r => { process.stdout.write(String(r.status)); process.exit(0); });
" | tr -d '[:space:]')"
check "GET /usuarios sem cookie -> 401" "$ST_SEM_COOKIE" "401"

# ─────────────────────────────────────────────────────────────────────────────
# Cenário principal — admin-a autentica, ativa entidade A, exercita o CRUD
# ─────────────────────────────────────────────────────────────────────────────
OUT1="$(run_node "$SENHA_OK" "$E_A" "$E_B" "$UID_ALVO_B" "$PAPEL_LEITURA" "$PAPEL_OPERADOR" <<JS
$BASE_HELPERS
async function main() {
  const senhaOk = process.argv[2];
  const empresaA = Number(process.argv[3]);
  const empresaB = Number(process.argv[4]);
  const uidAlvoB = Number(process.argv[5]);
  const papelLeitura = Number(process.argv[6]);
  const papelOperador = Number(process.argv[7]);
  const out = {};

  // --- admin-a: login + ativa A ---------------------------------------------
  let { status: loginStatus, jar } = await login('usu-admin-a@example.test', senhaOk);
  out.login_status = loginStatus;
  ({ jar } = await trocaEntidade(jar, empresaA));

  // (b) operador (sem usuarios.gerenciar) -> 403
  const { jar: jarOperador } = await (async () => {
    const l = await login('usu-operador-a@example.test', senhaOk);
    return trocaEntidade(l.jar, empresaA);
  })();
  const rOperador = await fetch('http://localhost:3000/api/v1/usuarios', { headers: { Cookie: cookieHeader(jarOperador) } });
  out.operador_status = rOperador.status;

  // (c) GET /usuarios (admin-a) -> lista só entidade A (admin-a + operador-a)
  const rList1 = await fetch('http://localhost:3000/api/v1/usuarios', { headers: { Cookie: cookieHeader(jar) } });
  const bList1 = await rList1.json();
  out.list1_status = rList1.status;
  out.list1_total = bList1.total;
  out.list1_tem_alvo_b = (bList1.usuarios || []).some((u) => u.id === uidAlvoB) ? 'true' : 'false';

  // (d) POST /usuarios — cria + 1º vínculo
  const rCriar = await fetch('http://localhost:3000/api/v1/usuarios', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ nome: 'Novo Usuario A', email: 'novo-usuario-a@example.test', senha: 'S3nh@Forte', vinculo: { entidadeId: empresaA, papelId: papelOperador } }),
  });
  const bCriar = await rCriar.json();
  out.criar_status = rCriar.status;
  out.criar_tem_vinculo = Array.isArray(bCriar.usuario && bCriar.usuario.vinculos) && bCriar.usuario.vinculos.length === 1 ? 'true' : 'false';
  const novoUsuarioId = bCriar.usuario && bCriar.usuario.id;

  // e-mail duplicado -> 409
  const rDup = await fetch('http://localhost:3000/api/v1/usuarios', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ nome: 'Duplicado', email: 'novo-usuario-a@example.test', senha: 'S3nh@Forte', vinculo: { entidadeId: empresaA, papelId: papelOperador } }),
  });
  const bDup = await rDup.json();
  out.dup_status = rDup.status;
  out.dup_erro = bDup.erro;

  // senha fraca -> 400 SENHA_FRACA
  const rFraca = await fetch('http://localhost:3000/api/v1/usuarios', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ nome: 'Senha Fraca', email: 'senha-fraca@example.test', senha: 'fraca', vinculo: { entidadeId: empresaA, papelId: papelOperador } }),
  });
  const bFraca = await rFraca.json();
  out.fraca_status = rFraca.status;
  out.fraca_erro = bFraca.erro;

  // (h) isolamento — admin-a NÃO vê/edita usuário só vinculado a B
  const rEditarCross = await fetch(\`http://localhost:3000/api/v1/usuarios/\${uidAlvoB}\`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ nome: 'Tentativa Cross Tenant' }),
  });
  const bEditarCross = await rEditarCross.json();
  out.editar_cross_status = rEditarCross.status;
  out.editar_cross_erro = bEditarCross.erro;

  // (f) POST /usuarios/:id/vinculos — cria vínculo adicional p/ novoUsuario em B
  //     (admin-a NÃO é admin_plataforma -> deve ser negado ao tentar vincular a B)
  const rVinculoCrossB = await fetch(\`http://localhost:3000/api/v1/usuarios/\${novoUsuarioId}/vinculos\`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ entidadeId: empresaB, papelId: papelLeitura }),
  });
  const bVinculoCrossB = await rVinculoCrossB.json();
  out.vinculo_cross_b_status = rVinculoCrossB.status;
  out.vinculo_cross_b_erro = bVinculoCrossB.erro;

  // vínculo duplicado (mesma entidade A, já existe) -> 409 VINCULO_JA_EXISTE
  const rVinculoDup = await fetch(\`http://localhost:3000/api/v1/usuarios/\${novoUsuarioId}/vinculos\`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ entidadeId: empresaA, papelId: papelLeitura }),
  });
  const bVinculoDup = await rVinculoDup.json();
  out.vinculo_dup_status = rVinculoDup.status;
  out.vinculo_dup_erro = bVinculoDup.erro;

  // (g) PUT /usuarios/:id/vinculos/:vinculoId — troca papelId p/ leitura,
  //     confirma reflexo IMEDIATO nas permissões efetivas do novo usuário
  //     (SC-004, sem esperar TTL) via login do próprio novo usuário. Roda
  //     ANTES da desativação (e) — precisa que a conta esteja ATIVA para
  //     conseguir logar; a ordem dentro deste script é só sequência de
  //     asserts, não reflete nenhuma dependência real do endpoint.
  const vinculoId = bCriar.usuario.vinculos[0].id;
  const loginAntes = await login('novo-usuario-a@example.test', 'S3nh@Forte');
  const meAntes = await fetch('http://localhost:3000/api/v1/me', { headers: { Cookie: cookieHeader(loginAntes.jar) } });
  const bMeAntes = await meAntes.json();
  out.antes_tem_permissao_operador = (bMeAntes.permissoes || []).includes('motoristas.criar') ? 'true' : 'false';

  const rTrocaPapel = await fetch(\`http://localhost:3000/api/v1/usuarios/\${novoUsuarioId}/vinculos/\${vinculoId}\`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ papelId: papelLeitura }),
  });
  const bTrocaPapel = await rTrocaPapel.json();
  out.troca_papel_status = rTrocaPapel.status;
  out.troca_papel_novo_id = bTrocaPapel.vinculo && bTrocaPapel.vinculo.papelId;

  // Sem novo login (mesmo accessToken de antes) — permissões efetivas devem
  // refletir o papel NOVO imediatamente (invalidarUsuario síncrono, SC-004).
  const meDepois = await fetch('http://localhost:3000/api/v1/me', { headers: { Cookie: cookieHeader(loginAntes.jar) } });
  const bMeDepois = await meDepois.json();
  out.depois_tem_permissao_operador = (bMeDepois.permissoes || []).includes('motoristas.criar') ? 'true' : 'false';

  // (e) PUT /usuarios/:id — edita nome + desativa (CHK033). Roda por ÚLTIMO
  // neste script porque desativar a conta (ativo:false) a impede de logar —
  // faríamos o SC-004 acima falhar por motivo ERRADO (conta_inativa) se
  // viesse antes.
  const rEditar = await fetch(\`http://localhost:3000/api/v1/usuarios/\${novoUsuarioId}\`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ nome: 'Novo Usuario A Editado', ativo: false }),
  });
  const bEditar = await rEditar.json();
  out.editar_status = rEditar.status;
  out.editar_nome = bEditar.usuario && bEditar.usuario.nome;
  out.editar_ativo = bEditar.usuario && bEditar.usuario.ativo;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT1" | grep -v '___RESULT_JSON___' || true
R1="$(echo "$OUT1" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R1" ] || { echo "FAIL: script Node não retornou resultado"; echo "$OUT1"; exit 1; }
jget() { printf '%s' "$R1" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d['$1']))"; }

check "login admin-a -> 200" "$(jget login_status)" "200"
check "operador (sem usuarios.gerenciar) GET /usuarios -> 403" "$(jget operador_status)" "403"
check "GET /usuarios (admin-a) -> 200" "$(jget list1_status)" "200"
check "GET /usuarios (admin-a) -> total=2 (admin-a + operador-a, só entidade A)" "$(jget list1_total)" "2"
check "GET /usuarios (admin-a) -> NAO ve usuario so vinculado a B" "$(jget list1_tem_alvo_b)" "false"
check "POST /usuarios -> 201" "$(jget criar_status)" "201"
check "POST /usuarios -> resposta tem exatamente 1 vinculo" "$(jget criar_tem_vinculo)" "true"
check "POST /usuarios email duplicado -> 409" "$(jget dup_status)" "409"
check "POST /usuarios email duplicado -> erro=EMAIL_JA_CADASTRADO" "$(jget dup_erro)" "EMAIL_JA_CADASTRADO"
check "POST /usuarios senha fraca -> 400" "$(jget fraca_status)" "400"
check "POST /usuarios senha fraca -> erro=SENHA_FRACA" "$(jget fraca_erro)" "SENHA_FRACA"
check "PUT /usuarios/:id -> 200" "$(jget editar_status)" "200"
check "PUT /usuarios/:id -> nome atualizado" "$(jget editar_nome)" "Novo Usuario A Editado"
check "PUT /usuarios/:id -> ativo=false (CHK033, sem DELETE)" "$(jget editar_ativo)" "false"
check "PUT /usuarios/:id cross-tenant (usuario so em B) -> 404" "$(jget editar_cross_status)" "404"
check "PUT /usuarios/:id cross-tenant -> erro=USUARIO_NAO_ENCONTRADO" "$(jget editar_cross_erro)" "USUARIO_NAO_ENCONTRADO"
check "POST vinculos cross-tenant (admin-a tentando B) -> 403" "$(jget vinculo_cross_b_status)" "403"
check "POST vinculos cross-tenant -> erro=PERMISSAO_NEGADA" "$(jget vinculo_cross_b_erro)" "PERMISSAO_NEGADA"
check "POST vinculos duplicado (mesma entidade) -> 409" "$(jget vinculo_dup_status)" "409"
check "POST vinculos duplicado -> erro=VINCULO_JA_EXISTE" "$(jget vinculo_dup_erro)" "VINCULO_JA_EXISTE"
check "novo usuario ANTES da troca: tem permissao de operador" "$(jget antes_tem_permissao_operador)" "true"
check "PUT vinculos/:vinculoId (troca papel) -> 200" "$(jget troca_papel_status)" "200"
check "PUT vinculos/:vinculoId -> papelId novo = leitura" "$(jget troca_papel_novo_id)" "$PAPEL_LEITURA"
check "novo usuario DEPOIS da troca (SEM novo login): permissao de operador SUMIU (SC-004, invalidarUsuario sincrono)" "$(jget depois_tem_permissao_operador)" "false"

N_AUDIT_CRIADO="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='usuario_criado' AND id_empresa=$E_A" | tr -d '[:space:]')"
check "Auditoria (DB): evento usuario_criado gravado" "$([ "${N_AUDIT_CRIADO:-0}" -ge 1 ] 2>/dev/null && echo sim || echo nao)" "sim"
N_AUDIT_EDITADO="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='usuario_editado' AND id_empresa=$E_A" | tr -d '[:space:]')"
check "Auditoria (DB): evento usuario_editado gravado" "$([ "${N_AUDIT_EDITADO:-0}" -ge 1 ] 2>/dev/null && echo sim || echo nao)" "sim"
N_AUDIT_PAPEL="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='usuario_papel_alterado' AND id_empresa=$E_A" | tr -d '[:space:]')"
check "Auditoria (DB): evento usuario_papel_alterado gravado" "$([ "${N_AUDIT_PAPEL:-0}" -ge 1 ] 2>/dev/null && echo sim || echo nao)" "sim"

echo
if [ "$fails" -eq 0 ]; then
  echo "HUB-USUARIOS-INTEGRATION: OK — todos os asserts passaram (FASE 4.2)"
  exit 0
else
  echo "HUB-USUARIOS-INTEGRATION: FALHOU — $fails assert(s) falharam"
  exit 1
fi

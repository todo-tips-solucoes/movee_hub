#!/usr/bin/env bash
# =============================================================================
# hub-motorista-canonico-cadastro-integration.sh — FASE 4 (WS-C Cadastro) da
# feature hub-motorista-canonico: POST /api/v1/motoristas (tasks.md 4.2.6),
# num projeto hub-test EFÊMERO (db+postgrest+backend). Nunca toca
# chatmasterveloz/produção nem o hub-homolog. Mesmo padrão de isolamento de
# infra/hub/testes/hub-motoristas-integration.sh (login + cookie jar via
# script Node único, `check()` para os asserts).
#
# Cobre (contracts/api-motorista-canonico.md §POST /motoristas, FR-012..016):
#   (a) sem autenticação -> 401
#   (b) sem permissão motoristas.editar (usuário de leitura) -> 403
#   (c) nome ausente/vazio -> 422 { erro: 'nome_invalido' }
#   (d) idExterno ausente -> 422 { erro: 'uuid_invalido' } (SEMPRE obrigatório,
#       FR-012/D-C6 — nunca há geração automática, FR-014)
#   (e) idExterno em formato inválido -> 422 { erro: 'uuid_invalido' }
#   (f) cadastro válido -> 201, id numérico, idExterno ecoado, nome, ativo=true
#   (g) idExterno é normalizado para minúsculas (uuid informado em MAIÚSCULAS
#       é aceito e gravado lowercase — mesma convenção de
#       lib/hub-import-processor.js no pipeline de importação)
#   (h) GET /motoristas/:id do recém-criado -> idExterno aparece no detalhe
#       (task 4.1.2, prova end-to-end do select novo)
#   (i) GET /motoristas (lista) -> item criado aparece com idExterno
#       (task 4.1.1, prova end-to-end do select novo)
#   (j) mesmo idExterno cadastrado de novo NA MESMA empresa -> 409
#       { erro: 'uuid_duplicado' } (violação de UNIQUE (id_empresa,
#       id_externo), migration 0010)
#   (k) mesmo idExterno em OUTRA empresa -> 201, SEM conflito (FR-013 edge
#       case — a unicidade é por empresa, não global)
#   (l) mass-assignment/BOPLA (mandato S2) — body com `ativo:false`,
#       `motoristaId`, `id`, `idEmpresa` (apontando para outra empresa)
#       nunca influencia o INSERT: resposta sempre ativo=true (default,
#       nunca o valor do body) e o Entregador criado pertence à empresa do
#       TOKEN (nunca ao idEmpresa forjado no body)
#
# Uso: infra/hub/testes/hub-motorista-canonico-cadastro-integration.sh
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

echo "rodando migrate.sh…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0044_seed_permissao_motoristas_credencial.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas por completo (0044 ausente)"; cat "$TMP/migrate.log"; exit 1; }

# --- Seed: 2 Usuarios (editor com motoristas.editar; leitura SEM) ----------
SENHA_OK='SenhaSinteticaCadastro#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

E_TESTE=940201
E_OUTRA=940202

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('cadastro-editor@example.test', '$HASH_OK', 'Usuario Teste Cadastro Editor', true),
  ('cadastro-leitura@example.test', '$HASH_OK', 'Usuario Teste Cadastro Leitura', true);
SQL
UID_EDITOR="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='cadastro-editor@example.test'" | tr -d '[:space:]')"
UID_LEITURA="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='cadastro-leitura@example.test'" | tr -d '[:space:]')"
PAPEL_OPERADOR="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='operador'" | tr -d '[:space:]')"
[ -n "$PAPEL_OPERADOR" ] || { echo "FAIL: seed 0007 não populou o papel 'operador' esperado"; exit 1; }
PAPEL_LEITURA="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='leitura'" | tr -d '[:space:]')"
[ -n "$PAPEL_LEITURA" ] || { echo "FAIL: seed 0007 não populou o papel 'leitura' esperado"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_EDITOR, $E_TESTE, $PAPEL_OPERADOR, true),
  ($UID_EDITOR, $E_OUTRA, $PAPEL_OPERADOR, true),
  ($UID_LEITURA, $E_TESTE, $PAPEL_LEITURA, true);
SQL

# ─────────────────────────────────────────────────────────────────────────────
# Script Node único: login + troca de entidade + chamadas POST/GET.
# ─────────────────────────────────────────────────────────────────────────────
OUT="$(run_node "$SENHA_OK" "$E_TESTE" "$E_OUTRA" <<'JS'
const BASE = 'http://localhost:3000/api/v1';

function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }

async function login(email, senha) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) });
  return parseSetCookie(r);
}
async function trocarEntidade(jar, empresaId) {
  const r = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresaId }) });
  return { ...jar, ...parseSetCookie(r) };
}
async function getJson(jar, path) {
  const r = await fetch(`${BASE}${path}`, { headers: jar ? { Cookie: cookieHeader(jar) } : {} });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function postJson(jar, path, corpo) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(jar ? { Cookie: cookieHeader(jar) } : {}) },
    body: JSON.stringify(corpo),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

async function main() {
  const senha = process.argv[2];
  const empresaTeste = Number(process.argv[3]);
  const empresaOutra = Number(process.argv[4]);
  const out = {};

  const UUID_1 = '11111111-2222-3333-4444-555555555555';
  const UUID_MAIUSCULO = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';

  // (a) sem autenticação -> 401
  const rSemAuth = await postJson(null, '/motoristas', { nome: 'X', idExterno: UUID_1 });
  out.sem_auth_status = rSemAuth.status;

  let jarEditor = await login('cadastro-editor@example.test', senha);
  jarEditor = await trocarEntidade(jarEditor, empresaTeste);
  let jarLeitura = await login('cadastro-leitura@example.test', senha);
  jarLeitura = await trocarEntidade(jarLeitura, empresaTeste);

  // (b) sem permissão motoristas.editar -> 403
  const rSemPerm = await postJson(jarLeitura, '/motoristas', { nome: 'X', idExterno: UUID_1 });
  out.sem_perm_status = rSemPerm.status;

  // (c) nome ausente -> 422 nome_invalido
  const rSemNome = await postJson(jarEditor, '/motoristas', { idExterno: UUID_1 });
  out.sem_nome_status = rSemNome.status;
  out.sem_nome_erro = rSemNome.body && rSemNome.body.erro;

  // (c) nome vazio/só espaços -> 422 nome_invalido
  const rNomeVazio = await postJson(jarEditor, '/motoristas', { nome: '   ', idExterno: UUID_1 });
  out.nome_vazio_status = rNomeVazio.status;
  out.nome_vazio_erro = rNomeVazio.body && rNomeVazio.body.erro;

  // (d) idExterno ausente -> 422 uuid_invalido
  const rSemUuid = await postJson(jarEditor, '/motoristas', { nome: 'Fulano Sem Uuid' });
  out.sem_uuid_status = rSemUuid.status;
  out.sem_uuid_erro = rSemUuid.body && rSemUuid.body.erro;

  // (e) idExterno em formato inválido -> 422 uuid_invalido
  const rUuidInvalido = await postJson(jarEditor, '/motoristas', { nome: 'Fulano Uuid Invalido', idExterno: 'nao-e-um-uuid' });
  out.uuid_invalido_status = rUuidInvalido.status;
  out.uuid_invalido_erro = rUuidInvalido.body && rUuidInvalido.body.erro;

  // (f) cadastro válido -> 201
  const rCriado = await postJson(jarEditor, '/motoristas', { nome: 'Fulano Recem Cadastrado', idExterno: UUID_1 });
  out.criado_status = rCriado.status;
  out.criado_idExterno = rCriado.body && rCriado.body.idExterno;
  out.criado_nome = rCriado.body && rCriado.body.nome;
  out.criado_ativo = rCriado.body && rCriado.body.ativo;
  const criadoId = rCriado.body && rCriado.body.id;
  out.criado_id_e_numero = typeof criadoId === 'number' ? 'true' : 'false';

  // (g) uuid MAIÚSCULO -> 201, normalizado para minúsculas na resposta
  const rMaiusculo = await postJson(jarEditor, '/motoristas', { nome: 'Beltrano Uuid Maiusculo', idExterno: UUID_MAIUSCULO });
  out.maiusculo_status = rMaiusculo.status;
  out.maiusculo_idExterno = rMaiusculo.body && rMaiusculo.body.idExterno;

  // (h) GET /motoristas/:id do recém-criado -> idExterno no detalhe
  const rDetalhe = await getJson(jarEditor, `/motoristas/${criadoId}`);
  out.detalhe_status = rDetalhe.status;
  out.detalhe_idExterno = rDetalhe.body && rDetalhe.body.idExterno;

  // (i) GET /motoristas (lista) -> item criado aparece com idExterno
  const rLista = await getJson(jarEditor, `/motoristas?nome=${encodeURIComponent('Fulano Recem Cadastrado')}`);
  out.lista_status = rLista.status;
  const itemLista = rLista.body && rLista.body.items && rLista.body.items.find((i) => i.id === criadoId);
  out.lista_idExterno = itemLista ? itemLista.idExterno : null;

  // (j) mesmo idExterno na MESMA empresa -> 409 uuid_duplicado
  const rDuplicado = await postJson(jarEditor, '/motoristas', { nome: 'Outro Nome Mesmo Uuid', idExterno: UUID_1 });
  out.duplicado_status = rDuplicado.status;
  out.duplicado_erro = rDuplicado.body && rDuplicado.body.erro;

  // (k) mesmo idExterno em OUTRA empresa -> 201, sem conflito (FR-013 edge case)
  const jarEditorOutra = await trocarEntidade(jarEditor, empresaOutra);
  const rOutraEmpresa = await postJson(jarEditorOutra, '/motoristas', { nome: 'Mesmo Uuid Outra Empresa', idExterno: UUID_1 });
  out.outra_empresa_status = rOutraEmpresa.status;
  out.outra_empresa_idExterno = rOutraEmpresa.body && rOutraEmpresa.body.idExterno;

  // (l) mass-assignment/BOPLA — ativo/motoristaId/id/idEmpresa do body
  // nunca influenciam o INSERT (mandato S2)
  const UUID_BOPLA = '99999999-8888-7777-6666-555544443333';
  const rBopla = await postJson(jarEditor, '/motoristas', {
    nome: 'Teste Bopla',
    idExterno: UUID_BOPLA,
    ativo: false,
    motoristaId: 999999,
    id: 1,
    idEmpresa: empresaOutra,
  });
  out.bopla_status = rBopla.status;
  out.bopla_ativo = rBopla.body && rBopla.body.ativo;
  const boplaId = rBopla.body && rBopla.body.id;
  // Confirma que o Entregador criado pertence à empresa do TOKEN (empresaTeste
  // após trocar de volta), não ao idEmpresa forjado no body (empresaOutra).
  const jarEditorVolta = await trocarEntidade(jarEditorOutra, empresaTeste);
  const rBoplaDetalhe = await getJson(jarEditorVolta, `/motoristas/${boplaId}`);
  out.bopla_visivel_na_empresa_do_token_status = rBoplaDetalhe.status;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT" | grep -v '___RESULT_JSON___' || true
RESULT_LINE="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$RESULT_LINE" ] || { echo "FAIL: script Node não retornou resultado"; echo "$OUT"; exit 1; }
jget() { printf '%s' "$RESULT_LINE" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const v=d['$1']; process.stdout.write(v===null?'null':v===undefined?'undefined':String(v))"; }

check "(a) POST /motoristas sem cookie -> 401" "$(jget sem_auth_status)" "401"
check "(b) POST /motoristas sem motoristas.editar -> 403" "$(jget sem_perm_status)" "403"
check "(c) nome ausente -> 422" "$(jget sem_nome_status)" "422"
check "(c) nome ausente -> erro nome_invalido" "$(jget sem_nome_erro)" "nome_invalido"
check "(c) nome só espaços -> 422" "$(jget nome_vazio_status)" "422"
check "(c) nome só espaços -> erro nome_invalido" "$(jget nome_vazio_erro)" "nome_invalido"
check "(d) idExterno ausente -> 422 (SEMPRE obrigatório, FR-012/D-C6)" "$(jget sem_uuid_status)" "422"
check "(d) idExterno ausente -> erro uuid_invalido" "$(jget sem_uuid_erro)" "uuid_invalido"
check "(e) idExterno formato inválido -> 422" "$(jget uuid_invalido_status)" "422"
check "(e) idExterno formato inválido -> erro uuid_invalido" "$(jget uuid_invalido_erro)" "uuid_invalido"

check "(f) cadastro válido -> 201" "$(jget criado_status)" "201"
check "(f) cadastro válido -> idExterno ecoado" "$(jget criado_idExterno)" "11111111-2222-3333-4444-555555555555"
check "(f) cadastro válido -> nome ecoado" "$(jget criado_nome)" "Fulano Recem Cadastrado"
check "(f) cadastro válido -> ativo=true (default)" "$(jget criado_ativo)" "true"
check "(f) cadastro válido -> id é numérico" "$(jget criado_id_e_numero)" "true"

check "(g) idExterno MAIÚSCULO -> 201" "$(jget maiusculo_status)" "201"
check "(g) idExterno MAIÚSCULO -> normalizado para minúsculas" "$(jget maiusculo_idExterno)" "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"

check "(h) GET /motoristas/:id do recém-criado -> 200" "$(jget detalhe_status)" "200"
check "(h) GET /motoristas/:id -> idExterno no detalhe (task 4.1.2)" "$(jget detalhe_idExterno)" "11111111-2222-3333-4444-555555555555"

check "(i) GET /motoristas (lista) -> 200" "$(jget lista_status)" "200"
check "(i) GET /motoristas (lista) -> idExterno no item (task 4.1.1)" "$(jget lista_idExterno)" "11111111-2222-3333-4444-555555555555"

check "(j) mesmo idExterno na MESMA empresa -> 409" "$(jget duplicado_status)" "409"
check "(j) mesmo idExterno na MESMA empresa -> erro uuid_duplicado" "$(jget duplicado_erro)" "uuid_duplicado"

check "(k) mesmo idExterno em OUTRA empresa -> 201 (sem conflito, FR-013)" "$(jget outra_empresa_status)" "201"
check "(k) mesmo idExterno em OUTRA empresa -> idExterno ecoado" "$(jget outra_empresa_idExterno)" "11111111-2222-3333-4444-555555555555"

check "(l) BOPLA — cadastro com campos fora da allowlist -> 201 (não recusa a requisição)" "$(jget bopla_status)" "201"
check "(l) BOPLA — ativo do body (false) é IGNORADO, resposta sempre ativo=true" "$(jget bopla_ativo)" "true"
check "(l) BOPLA — Entregador pertence à empresa do TOKEN, não ao idEmpresa forjado" "$(jget bopla_visivel_na_empresa_do_token_status)" "200"

# --- Auditoria: motorista.criado gravada para o cadastro válido (f) --------
AUDITORIA_COUNT="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE id_empresa=$E_TESTE AND acao='motorista.criado'" | tr -d '[:space:]')"
check "auditoria: motorista.criado registrada (>=1 evento na empresa de teste)" "$([ "${AUDITORIA_COUNT:-0}" -ge 1 ] && echo yes || echo no)" "yes"

echo
if [ "$fails" = "0" ]; then
  echo "HUB-MOTORISTA-CANONICO-CADASTRO-INTEGRATION: OK — todos os asserts passaram (FASE 4/POST /motoristas)"
  exit 0
else
  echo "HUB-MOTORISTA-CANONICO-CADASTRO-INTEGRATION: $fails assert(s) FALHARAM" >&2
  exit 1
fi

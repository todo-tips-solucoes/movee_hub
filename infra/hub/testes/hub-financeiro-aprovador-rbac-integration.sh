#!/usr/bin/env bash
# =============================================================================
# hub-financeiro-aprovador-rbac-integration.sh — tasks.md 2.5.1/2.5.2/2.5.4/
# 2.5.5 (repasse-saldo-minimo, F2): prova E2E, com BUILD REAL do backend
# pós-0097/0098, num projeto hub-test EFÊMERO e descartável (mesmo padrão de
# infra/hub/testes/hub-rbac-integration.sh).
#
# Cobre:
#   2.5.1 (F2.1) — `financeiro` puro e `admin_entidade` puro RECUSADOS nas 4
#     rotas de aprovação (POST /repasse/:periodo/fechar, /movimentos,
#     /lotes/:id/confirmacao, /lotes/:id/retorno) com 403 PERMISSAO_NEGADA
#     (o middleware requirePermission roda ANTES de qualquer lógica de
#     negócio — periodo/id fake são inofensivos); e as 2 RPCs diretas no
#     PostgREST (rpc/hub_adiantamento_repasse_fechar,
#     rpc/hub_adiantamento_lote_confirmar) recusadas com HTTP 400 +
#     "PERMISSAO_NEGADA" no corpo (RAISE EXCEPTION em SQL, sem SQLSTATE
#     dedicado -> PostgREST mapeia para 400, NUNCA 403).
#   2.5.2 (F2.2) — `financeiro_aprovador` e `admin_plataforma` passam do
#     mesmo gate nas mesmas 6 chamadas (podem receber outro erro de negócio
#     por causa do periodo/id fake — o que importa é NÃO ser
#     PERMISSAO_NEGADA).
#   2.5.4 (F2.4) — repete as 2 rotas restritas de usuários (POST
#     /usuarios/:id/vinculos papelId=admin_plataforma; PUT /usuarios/:id
#     trocando senha de alvo com vínculo admin_plataforma) agora com build
#     real pós-0097: `admin_entidade` -> 403 PAPEL_RESTRITO + linha
#     `usuario_vinculo_negado` em Auditoria; `admin_plataforma` -> 2xx.
#     (Fecha também 2.1.3 — ver nota no fim: a trava Node é INCONDICIONAL,
#     não gated por migration, então não há estado "antes" observável via
#     integração para esta rota; a prova do furo real foi feita via
#     PostgREST direto em 2.1.2/2.1.5 e via unit test com o guard stubado em
#     tests/hub-usuarios-trava-unit.test.js.)
#   2.4.4 CROSS-TENANT (block-009/dec-075/dec-077) — cenário que reabriu a
#     tarefa 2.4.4 na revisão adversarial 2.5.7: o alvo tem vínculo
#     admin_plataforma ATIVO numa entidade A e vínculo COMUM ativo numa
#     entidade B; um admin_entidade que só existe em B tenta trocar
#     senha/nome/ativo do alvo -> 403 PAPEL_RESTRITO (a correção usa leitura
#     privilegiada em lib/hub-rbac-cache.js#alvoTemPapelRestritoAtivo, que
#     enxerga o alvo em QUALQUER empresa, nunca só na entidade ativa do
#     chamador).
#   2.5.5 (F2.5) — papéis comuns (`operador`, `leitura`) seguem funcionando
#     sem regressão: criar usuário operador, trocar pra leitura, desativar —
#     tudo 2xx.
#
# Uso: infra/hub/testes/hub-financeiro-aprovador-rbac-integration.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
RAIZ="$(cd "$HUB_DIR/../.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)-$$"
PROJECT="hub-test-$RUNID"
TMP="$(mktemp -d)"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
NET="${PROJECT}_default"
cleanup() { dc down -v --rmi local --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; }
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
curl_pg() { docker run --rm --network "$NET" curlimages/curl:8.11.1 -s -o /dev/stdout -w '\nHTTP_STATUS:%{http_code}\n' "$@"; }

fails=0
check() { # check <descricao> <valor-obtido> <valor-esperado>
  if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails + 1)); fi
}
check_ne() { # check_ne <descricao> <valor-obtido> <valor-proibido>
  if [ "$2" != "$3" ]; then echo "PASS: $1 (obtido='$2', != '$3')"; else echo "FAIL: $1 (obtido='$2', deveria ser != '$3')"; fails=$((fails + 1)); fi
}

echo "rodando migrate.sh completo (inclusive 0097+0098)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0098_repasse_saldo_minimo.sql" "$TMP/migrate.log" || { echo "FAIL: 0097/0098 não aplicadas"; cat "$TMP/migrate.log"; exit 1; }

# ── Seed ─────────────────────────────────────────────────────────────────
SENHA_OK='SenhaSinteticaFinRbac#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

E=940001

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('fin-financeiro@example.test',      '$HASH_OK', 'Usuario Financeiro Puro',      true),
  ('fin-adminentidade@example.test',   '$HASH_OK', 'Usuario Admin Entidade Puro',  true),
  ('fin-financeiroaprov@example.test', '$HASH_OK', 'Usuario Financeiro Aprovador', true),
  ('fin-adminplataforma@example.test', '$HASH_OK', 'Usuario Admin Plataforma',     true),
  ('fin-restrito-alvo@example.test',   '$HASH_OK', 'Usuario Alvo Restrito',        true),
  ('fin-operador-alvo@example.test',   '$HASH_OK', 'Usuario Operador Alvo',        true),
  -- controle negativo da 0101: `leitura` tem `envio_massa.consultar` mas NÃO
  -- `envio_massa.enviar`, então a 0047 nunca lhe deu `validacao_xml.validar`
  -- — é quem prova que o gate novo do /validate-xml-batch recusa de verdade.
  ('fin-leitura@example.test',         '$HASH_OK', 'Usuario Leitura',              true);
SQL
UID_FIN="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='fin-financeiro@example.test'" | tr -d '[:space:]')"
UID_ADME="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='fin-adminentidade@example.test'" | tr -d '[:space:]')"
UID_FINA="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='fin-financeiroaprov@example.test'" | tr -d '[:space:]')"
UID_ADMP="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='fin-adminplataforma@example.test'" | tr -d '[:space:]')"
UID_RESTRITO="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='fin-restrito-alvo@example.test'" | tr -d '[:space:]')"
UID_OPER_ALVO="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='fin-operador-alvo@example.test'" | tr -d '[:space:]')"
UID_LEITURA="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='fin-leitura@example.test'" | tr -d '[:space:]')"

PAPEL_FINANCEIRO="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='financeiro'" | tr -d '[:space:]')"
PAPEL_ADMIN_ENTIDADE="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_entidade'" | tr -d '[:space:]')"
PAPEL_FINANCEIRO_APROVADOR="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='financeiro_aprovador'" | tr -d '[:space:]')"
PAPEL_ADMIN_PLATAFORMA="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_plataforma'" | tr -d '[:space:]')"
PAPEL_OPERADOR="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='operador'" | tr -d '[:space:]')"
PAPEL_LEITURA="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='leitura'" | tr -d '[:space:]')"
[ -n "$PAPEL_FINANCEIRO" ] && [ -n "$PAPEL_ADMIN_ENTIDADE" ] && [ -n "$PAPEL_FINANCEIRO_APROVADOR" ] \
  && [ -n "$PAPEL_ADMIN_PLATAFORMA" ] && [ -n "$PAPEL_OPERADOR" ] && [ -n "$PAPEL_LEITURA" ] \
  || { echo "FAIL: seed 0007/0097 não populou os papéis esperados (financeiro_aprovador existe?)"; exit 1; }

MODULO_ADIANTAMENTOS="$(psql_t -tAc "SELECT id FROM \"Modulo\" WHERE codigo='adiantamentos'" | tr -d '[:space:]')"
MODULO_USUARIOS="$(psql_t -tAc "SELECT id FROM \"Modulo\" WHERE codigo='usuarios'" | tr -d '[:space:]')"
# 0101 — os módulos que `financeiro`/`financeiro_aprovador` passaram a
# enxergar. Sem ModuloEntidade ativo o item não aparece no /me nem com a
# permissão concedida (deny-by-default), então o teste precisa dos dois lados.
MODULO_ENVIO_MASSA="$(psql_t -tAc "SELECT id FROM \"Modulo\" WHERE codigo='envio_massa'" | tr -d '[:space:]')"
MODULO_VALIDACAO_XML="$(psql_t -tAc "SELECT id FROM \"Modulo\" WHERE codigo='validacao_xml'" | tr -d '[:space:]')"
MODULO_MOTORISTAS="$(psql_t -tAc "SELECT id FROM \"Modulo\" WHERE codigo='motoristas'" | tr -d '[:space:]')"

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_FIN,        $E, $PAPEL_FINANCEIRO,           true),
  ($UID_ADME,       $E, $PAPEL_ADMIN_ENTIDADE,       true),
  ($UID_FINA,       $E, $PAPEL_FINANCEIRO_APROVADOR, true),
  ($UID_ADMP,       $E, $PAPEL_ADMIN_PLATAFORMA,     true),
  ($UID_RESTRITO,   $E, $PAPEL_ADMIN_PLATAFORMA,     true),
  ($UID_LEITURA,    $E, $PAPEL_LEITURA,              true);
-- $UID_OPER_ALVO (fin-operador-alvo) fica DE PROPÓSITO sem vínculo em $E:
-- é o alvo da concessão de vínculo NOVO em 2.5.4 (POST /usuarios/:id/vinculos).
-- Um alvo que já tivesse vínculo em E daria 409 VINCULO_JA_EXISTE no caminho
-- do admin_plataforma (que passa da trava PAPEL_RESTRITO e chega no check de
-- vínculo existente), mascarando o que o teste quer provar.

INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo) VALUES
  ($MODULO_ADIANTAMENTOS,  $E, true),
  ($MODULO_USUARIOS,       $E, true),
  ($MODULO_ENVIO_MASSA,    $E, true),
  ($MODULO_VALIDACAO_XML,  $E, true),
  ($MODULO_MOTORISTAS,     $E, true);
SQL

# ─────────────────────────────────────────────────────────────────────────
# 2.5.1 / 2.5.2 — as 4 rotas de aprovação, via Node (backend real)
# ─────────────────────────────────────────────────────────────────────────
rodar_4_rotas_aprovacao() { # rodar_4_rotas_aprovacao <email> <senha>
  run_node "$1" "$2" "$E" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }
async function main() {
  const email = process.argv[2];
  const senha = process.argv[3];
  const empresa = Number(process.argv[4]);
  const out = {};

  const rLogin = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) });
  let jar = parseSetCookie(rLogin);
  out.login_status = rLogin.status;

  const rTroca = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresa }) });
  jar = { ...jar, ...parseSetCookie(rTroca) };
  out.troca_status = rTroca.status;

  const H = { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) };
  const rFechar = await fetch(`${BASE}/adiantamentos/repasse/2020-01-01/fechar`, { method: 'POST', headers: H, body: JSON.stringify({ confirmacao: true }) });
  out.fechar_status = rFechar.status;
  out.fechar_body = JSON.stringify(await rFechar.json().catch(() => ({})));

  const rMov = await fetch(`${BASE}/adiantamentos/repasse/2020-01-01/movimentos`, { method: 'POST', headers: H, body: JSON.stringify({ confirmacao: true }) });
  out.movimentos_status = rMov.status;
  out.movimentos_body = JSON.stringify(await rMov.json().catch(() => ({})));

  const rConf = await fetch(`${BASE}/adiantamentos/lotes/999999/confirmacao`, { method: 'POST', headers: H, body: JSON.stringify({}) });
  out.confirmacao_status = rConf.status;
  out.confirmacao_body = JSON.stringify(await rConf.json().catch(() => ({})));

  const rRet = await fetch(`${BASE}/adiantamentos/lotes/999999/retorno`, { method: 'POST', headers: H, body: JSON.stringify({}) });
  out.retorno_status = rRet.status;
  out.retorno_body = JSON.stringify(await rRet.json().catch(() => ({})));

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
}
jget() { printf '%s' "$1" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d['$2']))"; }

# 2.5.1(a) financeiro puro
OUT="$(rodar_4_rotas_aprovacao 'fin-financeiro@example.test' "$SENHA_OK")"
R="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R" ] || { echo "FAIL: script Node (financeiro) não retornou resultado"; echo "$OUT"; exit 1; }
check "2.5.1 financeiro: login -> 200" "$(jget "$R" login_status)" "200"
check "2.5.1 financeiro: POST /me/entidade -> 200" "$(jget "$R" troca_status)" "200"
check "2.5.1 financeiro: POST /repasse/:periodo/fechar -> 403" "$(jget "$R" fechar_status)" "403"
check "2.5.1 financeiro: fechar body erro=PERMISSAO_NEGADA" "$(jget "$R" fechar_body)" '{"erro":"PERMISSAO_NEGADA"}'
check "2.5.1 financeiro: POST /repasse/:periodo/movimentos -> 403" "$(jget "$R" movimentos_status)" "403"
check "2.5.1 financeiro: POST /lotes/:id/confirmacao -> 403" "$(jget "$R" confirmacao_status)" "403"
check "2.5.1 financeiro: POST /lotes/:id/retorno -> 403" "$(jget "$R" retorno_status)" "403"

# 2.5.1(b) admin_entidade puro
OUT="$(rodar_4_rotas_aprovacao 'fin-adminentidade@example.test' "$SENHA_OK")"
R="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R" ] || { echo "FAIL: script Node (admin_entidade) não retornou resultado"; echo "$OUT"; exit 1; }
check "2.5.1 admin_entidade: POST /repasse/:periodo/fechar -> 403" "$(jget "$R" fechar_status)" "403"
check "2.5.1 admin_entidade: POST /repasse/:periodo/movimentos -> 403" "$(jget "$R" movimentos_status)" "403"
check "2.5.1 admin_entidade: POST /lotes/:id/confirmacao -> 403" "$(jget "$R" confirmacao_status)" "403"
check "2.5.1 admin_entidade: POST /lotes/:id/retorno -> 403" "$(jget "$R" retorno_status)" "403"

# 2.5.2(a) financeiro_aprovador — NAO pode dar PERMISSAO_NEGADA
OUT="$(rodar_4_rotas_aprovacao 'fin-financeiroaprov@example.test' "$SENHA_OK")"
R="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R" ] || { echo "FAIL: script Node (financeiro_aprovador) não retornou resultado"; echo "$OUT"; exit 1; }
check_ne "2.5.2 financeiro_aprovador: fechar não é 403" "$(jget "$R" fechar_status)" "403"
check_ne "2.5.2 financeiro_aprovador: movimentos não é 403" "$(jget "$R" movimentos_status)" "403"
check_ne "2.5.2 financeiro_aprovador: confirmacao não é 403" "$(jget "$R" confirmacao_status)" "403"
check_ne "2.5.2 financeiro_aprovador: retorno não é 403" "$(jget "$R" retorno_status)" "403"
echo "  (evidência 2.5.2 financeiro_aprovador — bodies: fechar=$(jget "$R" fechar_body) confirmacao=$(jget "$R" confirmacao_body))"

# 2.5.2(b) admin_plataforma — NAO pode dar PERMISSAO_NEGADA
OUT="$(rodar_4_rotas_aprovacao 'fin-adminplataforma@example.test' "$SENHA_OK")"
R="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R" ] || { echo "FAIL: script Node (admin_plataforma) não retornou resultado"; echo "$OUT"; exit 1; }
check_ne "2.5.2 admin_plataforma: fechar não é 403" "$(jget "$R" fechar_status)" "403"
check_ne "2.5.2 admin_plataforma: movimentos não é 403" "$(jget "$R" movimentos_status)" "403"
check_ne "2.5.2 admin_plataforma: confirmacao não é 403" "$(jget "$R" confirmacao_status)" "403"
check_ne "2.5.2 admin_plataforma: retorno não é 403" "$(jget "$R" retorno_status)" "403"

# ─────────────────────────────────────────────────────────────────────────
# 2.5.1 (RPC direta) — financeiro/admin_entidade via PostgREST puro
# ─────────────────────────────────────────────────────────────────────────
jwt_for() { # jwt_for <sub> <empresaAtiva> <escopoCsv>
  PGRST_JWT_SECRET="$(get_var PGRST_JWT_SECRET "$ENV_FILE")" node -e "
    const { generateHubPostgrestJWT } = require('$RAIZ/app_homologacao/backend/lib/hub-postgrest-jwt');
    process.stdout.write(generateHubPostgrestJWT({ usuarioId: process.argv[1], empresaAtiva: process.argv[2], escopo: process.argv[3].split(',').map(Number) }));
  " "$1" "$2" "$3"
}
rpc_check_negado() { # rpc_check_negado <descricao> <jwt> <path> <payload-json>
  local out st body
  out="$(curl_pg -X POST "http://postgrest:3000/$3" -H "Authorization: Bearer $2" -H "Content-Type: application/json" -d "$4")"
  st="$(printf '%s' "$out" | grep -o 'HTTP_STATUS:[0-9]*' | cut -d: -f2)"
  body="$(printf '%s' "$out" | grep -v HTTP_STATUS)"
  if [ "$st" = "400" ] && printf '%s' "$body" | grep -q "PERMISSAO_NEGADA"; then
    echo "PASS: $1 (HTTP 400 + PERMISSAO_NEGADA no corpo)"
  else
    echo "FAIL: $1 (HTTP $st, corpo=$body)"; fails=$((fails + 1))
  fi
}
rpc_check_passou_gate() { # rpc_check_passou_gate <descricao> <jwt> <path> <payload-json>
  local out st body
  out="$(curl_pg -X POST "http://postgrest:3000/$3" -H "Authorization: Bearer $2" -H "Content-Type: application/json" -d "$4")"
  st="$(printf '%s' "$out" | grep -o 'HTTP_STATUS:[0-9]*' | cut -d: -f2)"
  body="$(printf '%s' "$out" | grep -v HTTP_STATUS)"
  if printf '%s' "$body" | grep -q "PERMISSAO_NEGADA"; then
    echo "FAIL: $1 (deveria passar do gate; corpo=$body)"; fails=$((fails + 1))
  else
    echo "PASS: $1 (HTTP $st, corpo=$body — passou do gate, erro de negócio esperado)"
  fi
}

JWT_FIN="$(jwt_for "$UID_FIN" "$E" "$E")"
JWT_ADME="$(jwt_for "$UID_ADME" "$E" "$E")"
JWT_FINA="$(jwt_for "$UID_FINA" "$E" "$E")"
JWT_ADMP="$(jwt_for "$UID_ADMP" "$E" "$E")"

rpc_check_negado "2.5.1 financeiro RPC repasse_fechar -> 400+PERMISSAO_NEGADA" "$JWT_FIN" "rpc/hub_adiantamento_repasse_fechar" '{"p_periodo_inicio":"2020-01-01"}'
rpc_check_negado "2.5.1 financeiro RPC lote_confirmar -> 400+PERMISSAO_NEGADA" "$JWT_FIN" "rpc/hub_adiantamento_lote_confirmar" '{"p_lote_id":999999,"p_falhas":[]}'
rpc_check_negado "2.5.1 admin_entidade RPC repasse_fechar -> 400+PERMISSAO_NEGADA" "$JWT_ADME" "rpc/hub_adiantamento_repasse_fechar" '{"p_periodo_inicio":"2020-01-01"}'
rpc_check_negado "2.5.1 admin_entidade RPC lote_confirmar -> 400+PERMISSAO_NEGADA" "$JWT_ADME" "rpc/hub_adiantamento_lote_confirmar" '{"p_lote_id":999999,"p_falhas":[]}'

rpc_check_passou_gate "2.5.2 financeiro_aprovador RPC repasse_fechar" "$JWT_FINA" "rpc/hub_adiantamento_repasse_fechar" '{"p_periodo_inicio":"2020-01-01"}'
rpc_check_passou_gate "2.5.2 financeiro_aprovador RPC lote_confirmar" "$JWT_FINA" "rpc/hub_adiantamento_lote_confirmar" '{"p_lote_id":999999,"p_falhas":[]}'
rpc_check_passou_gate "2.5.2 admin_plataforma RPC repasse_fechar" "$JWT_ADMP" "rpc/hub_adiantamento_repasse_fechar" '{"p_periodo_inicio":"2020-01-01"}'
rpc_check_passou_gate "2.5.2 admin_plataforma RPC lote_confirmar" "$JWT_ADMP" "rpc/hub_adiantamento_lote_confirmar" '{"p_lote_id":999999,"p_falhas":[]}'

# ─────────────────────────────────────────────────────────────────────────
# 2.5.4 — rotas restritas de usuários pós-0097 (build real)
# ─────────────────────────────────────────────────────────────────────────
rodar_rotas_restritas_usuarios() { # <email-caller> <senha> <usuarioAlvoVinculos-id> <usuarioAlvoSenha-id>
  run_node "$1" "$2" "$E" "$3" "$4" "$PAPEL_ADMIN_PLATAFORMA" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }
async function main() {
  const email = process.argv[2], senha = process.argv[3], empresa = Number(process.argv[4]);
  const usuarioAlvoVinculos = Number(process.argv[5]), usuarioAlvoSenha = Number(process.argv[6]);
  const papelAdminPlataforma = Number(process.argv[7]);
  const out = {};

  const rLogin = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) });
  let jar = parseSetCookie(rLogin);
  const rTroca = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresa }) });
  jar = { ...jar, ...parseSetCookie(rTroca) };
  const H = { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) };

  const rVinc = await fetch(`${BASE}/usuarios/${usuarioAlvoVinculos}/vinculos`, { method: 'POST', headers: H, body: JSON.stringify({ entidadeId: empresa, papelId: papelAdminPlataforma }) });
  out.vinculos_status = rVinc.status;
  out.vinculos_body = JSON.stringify(await rVinc.json().catch(() => ({})));

  const rSenha = await fetch(`${BASE}/usuarios/${usuarioAlvoSenha}`, { method: 'PUT', headers: H, body: JSON.stringify({ senha: 'NovaSenhaForteX#2' }) });
  out.senha_status = rSenha.status;
  out.senha_body = JSON.stringify(await rSenha.json().catch(() => ({})));

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
}

# admin_entidade tenta conceder admin_plataforma a u_oper_alvo (vínculo novo)
# e trocar a senha de u_restrito (que já TEM vínculo admin_plataforma).
OUT="$(rodar_rotas_restritas_usuarios 'fin-adminentidade@example.test' "$SENHA_OK" "$UID_OPER_ALVO" "$UID_RESTRITO")"
R="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R" ] || { echo "FAIL: script Node (2.5.4 admin_entidade) não retornou resultado"; echo "$OUT"; exit 1; }
check "2.5.4 admin_entidade: POST /usuarios/:id/vinculos papelId=admin_plataforma -> 403" "$(jget "$R" vinculos_status)" "403"
check "2.5.4 admin_entidade: vinculos body erro=PAPEL_RESTRITO" "$(jget "$R" vinculos_body)" '{"erro":"PAPEL_RESTRITO","mensagem":"Somente o administrador da plataforma pode conceder, alterar ou desativar este papel."}'
check "2.5.4 admin_entidade: PUT /usuarios/:id (senha de alvo com vínculo admin_plataforma) -> 403" "$(jget "$R" senha_status)" "403"
check "2.5.4 admin_entidade: senha body erro=PAPEL_RESTRITO" "$(jget "$R" senha_body)" '{"erro":"PAPEL_RESTRITO","mensagem":"Somente o administrador da plataforma pode conceder, alterar ou desativar este papel."}'

N_AUDIT_NEGADO="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE id_empresa=$E AND acao='usuario_vinculo_negado' AND (detalhes->>'motivo')='PAPEL_RESTRITO'" | tr -d '[:space:]')"
check "2.5.4 Auditoria (DB): 2 linhas usuario_vinculo_negado motivo=PAPEL_RESTRITO" "${N_AUDIT_NEGADO:-0}" "2"

# admin_plataforma faz as MESMAS operações -> 2xx
OUT="$(rodar_rotas_restritas_usuarios 'fin-adminplataforma@example.test' "$SENHA_OK" "$UID_OPER_ALVO" "$UID_RESTRITO")"
R="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R" ] || { echo "FAIL: script Node (2.5.4 admin_plataforma) não retornou resultado"; echo "$OUT"; exit 1; }
check "2.5.4 admin_plataforma: POST /usuarios/:id/vinculos papelId=admin_plataforma -> 201" "$(jget "$R" vinculos_status)" "201"
check "2.5.4 admin_plataforma: PUT /usuarios/:id (troca senha alvo restrito) -> 200" "$(jget "$R" senha_status)" "200"

# ─────────────────────────────────────────────────────────────────────────
# 2.4.4 CROSS-TENANT (block-009/dec-075/dec-077, tasks.md 2.4.4 reaberta) —
# o alvo (UID_RESTRITO, admin_plataforma ATIVO em $E) ganha um SEGUNDO
# vínculo COMUM (operador) numa SEGUNDA entidade $E2. Um admin_entidade que
# só existe em $E2 (nunca teve vínculo em $E) tenta trocar senha/nome/ativo
# do alvo -- antes da correção, a trava só enxergava vínculos do alvo NA
# ENTIDADE ATIVA do chamador (empresa_id=eq.entidadeAtiva + claims escopadas
# a ela) e por isso não via o vínculo admin_plataforma em $E, liberando a
# alteração (tomada de conta). Depois da correção
# (lib/hub-rbac-cache.js#alvoTemPapelRestritoAtivo), a leitura da trava é
# privilegiada (sub=alvo) e enxerga QUALQUER empresa -> deve seguir 403.
# ─────────────────────────────────────────────────────────────────────────
E2=940002
psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('fin-adminentidade-b@example.test', '$HASH_OK', 'Usuario Admin Entidade B (cross-tenant)', true);
SQL
UID_ADME_B="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='fin-adminentidade-b@example.test'" | tr -d '[:space:]')"
[ -n "$UID_ADME_B" ] || { echo "FAIL: seed do usuário admin_entidade B (cross-tenant) falhou"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_ADME_B,   $E2, $PAPEL_ADMIN_ENTIDADE, true),
  ($UID_RESTRITO, $E2, $PAPEL_OPERADOR,       true);
-- UID_RESTRITO agora tem DOIS vínculos ATIVOS: admin_plataforma em $E
-- (seed original acima) + operador (comum) em $E2 -- exatamente o cenário
-- descrito na resposta do operador ao block-009 ("alvo com vínculo comum
-- na B, admin_plataforma na A").

INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo) VALUES
  ($MODULO_USUARIOS, $E2, true);
SQL

rodar_put_usuario_cross_tenant() { # <email-caller> <senha> <empresa> <usuarioAlvoId>
  run_node "$1" "$2" "$3" "$4" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }
async function main() {
  const email = process.argv[2], senha = process.argv[3], empresa = Number(process.argv[4]);
  const usuarioAlvoId = Number(process.argv[5]);
  const out = {};

  const rLogin = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) });
  let jar = parseSetCookie(rLogin);
  const rTroca = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresa }) });
  jar = { ...jar, ...parseSetCookie(rTroca) };
  const H = { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) };

  const rSenha = await fetch(`${BASE}/usuarios/${usuarioAlvoId}`, { method: 'PUT', headers: H, body: JSON.stringify({ senha: 'NovaSenhaForteX#4' }) });
  out.senha_status = rSenha.status;
  out.senha_body = JSON.stringify(await rSenha.json().catch(() => ({})));

  const rNome = await fetch(`${BASE}/usuarios/${usuarioAlvoId}`, { method: 'PUT', headers: H, body: JSON.stringify({ nome: 'Nome Trocado Cross Tenant' }) });
  out.nome_status = rNome.status;

  const rAtivo = await fetch(`${BASE}/usuarios/${usuarioAlvoId}`, { method: 'PUT', headers: H, body: JSON.stringify({ ativo: false }) });
  out.ativo_status = rAtivo.status;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
}

OUT="$(rodar_put_usuario_cross_tenant 'fin-adminentidade-b@example.test' "$SENHA_OK" "$E2" "$UID_RESTRITO")"
R="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R" ] || { echo "FAIL: script Node (2.4.4 cross-tenant) não retornou resultado"; echo "$OUT"; exit 1; }
check "2.4.4 CROSS-TENANT: admin_entidade(B) PUT /usuarios/:id senha do alvo (admin_plataforma em A, comum em B) -> 403" "$(jget "$R" senha_status)" "403"
check "2.4.4 CROSS-TENANT: senha body erro=PAPEL_RESTRITO" "$(jget "$R" senha_body)" '{"erro":"PAPEL_RESTRITO","mensagem":"Somente o administrador da plataforma pode conceder, alterar ou desativar este papel."}'
check "2.4.4 CROSS-TENANT: admin_entidade(B) PUT /usuarios/:id nome do alvo -> 403" "$(jget "$R" nome_status)" "403"
check "2.4.4 CROSS-TENANT: admin_entidade(B) PUT /usuarios/:id ativo do alvo -> 403" "$(jget "$R" ativo_status)" "403"

N_AUDIT_CROSS="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE id_empresa=$E2 AND acao='usuario_vinculo_negado' AND (detalhes->>'motivo')='PAPEL_RESTRITO'" | tr -d '[:space:]')"
check "2.4.4 CROSS-TENANT Auditoria (DB): 3 linhas usuario_vinculo_negado em E2 (senha+nome+ativo)" "${N_AUDIT_CROSS:-0}" "3"

# ─────────────────────────────────────────────────────────────────────────
# 2.5.5 — operador/leitura sem regressão (admin_entidade caller)
# ─────────────────────────────────────────────────────────────────────────
OUT="$(run_node 'fin-adminentidade@example.test' "$SENHA_OK" "$E" "$PAPEL_OPERADOR" "$PAPEL_LEITURA" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }
async function main() {
  const email = process.argv[2], senha = process.argv[3], empresa = Number(process.argv[4]);
  const papelOperador = Number(process.argv[5]), papelLeitura = Number(process.argv[6]);
  const out = {};

  const rLogin = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) });
  let jar = parseSetCookie(rLogin);
  const rTroca = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresa }) });
  jar = { ...jar, ...parseSetCookie(rTroca) };
  const H = { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) };

  const rCria = await fetch(`${BASE}/usuarios`, { method: 'POST', headers: H, body: JSON.stringify({ nome: 'Fulano Sem Regressao', email: 'fin-semregressao@example.test', senha: 'SenhaForteY#3', vinculo: { entidadeId: empresa, papelId: papelOperador } }) });
  const bCria = await rCria.json().catch(() => ({}));
  out.criar_status = rCria.status;
  out.novo_usuario_id = bCria.usuario ? bCria.usuario.id : null;
  out.novo_vinculo_id = bCria.usuario && bCria.usuario.vinculo ? bCria.usuario.vinculo.id : null;

  // fallback: se o shape da resposta não trouxer o vinculoId, buscamos via
  // resposta bruta (mantemos o teste resiliente a variações de envelope).
  out.criar_body = JSON.stringify(bCria);

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
R="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R" ] || { echo "FAIL: script Node (2.5.5 criar operador) não retornou resultado"; echo "$OUT"; exit 1; }
check "2.5.5 admin_entidade: POST /usuarios (papel operador) -> 201" "$(jget "$R" criar_status)" "201"
NOVO_UID="$(jget "$R" novo_usuario_id)"
echo "  (2.5.5 evidência criação: $(jget "$R" criar_body))"

# vínculo do usuário recém-criado (via DB — não depende do shape exato da resposta)
NOVO_VINC_ID="$(psql_t -tAc "SELECT id FROM \"UsuarioEntidade\" WHERE usuario_id=$NOVO_UID AND empresa_id=$E" | tr -d '[:space:]')"
[ -n "$NOVO_VINC_ID" ] || { echo "FAIL: vínculo do usuário 2.5.5 não encontrado no DB"; exit 1; }

OUT2="$(run_node 'fin-adminentidade@example.test' "$SENHA_OK" "$E" "$NOVO_VINC_ID" "$PAPEL_LEITURA" \
  "http://localhost:3000/api/v1/usuarios/$NOVO_UID/vinculos/$NOVO_VINC_ID" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }
async function main() {
  const email = process.argv[2], senha = process.argv[3], empresa = Number(process.argv[4]);
  const vinculoId = Number(process.argv[5]), papelLeitura = Number(process.argv[6]);
  const out = {};
  const rLogin = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, senha }) });
  let jar = parseSetCookie(rLogin);
  const rTroca = await fetch(`${BASE}/me/entidade`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) }, body: JSON.stringify({ empresa_id: empresa }) });
  jar = { ...jar, ...parseSetCookie(rTroca) };
  const H = { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) };

  // note: o "usuarioId" da rota /:id/vinculos/:vinculoId — usamos o id do
  // usuário recém-criado, disponível fora deste script; aqui vinculoId já
  // identifica a linha, e a rota também exige o :id do usuário no path —
  // resolvido pelo shell antes de chamar (usuarioId embutido no path).
  const rTrocaPapel = await fetch(process.argv[7], { method: 'PUT', headers: H, body: JSON.stringify({ papelId: papelLeitura }) });
  out.trocar_papel_status = rTrocaPapel.status;

  const rDesativa = await fetch(process.argv[7], { method: 'PUT', headers: H, body: JSON.stringify({ ativo: false }) });
  out.desativar_status = rDesativa.status;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
R2="$(echo "$OUT2" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R2" ] || { echo "FAIL: script Node (2.5.5 trocar/desativar) não retornou resultado"; echo "$OUT2"; exit 1; }
check "2.5.5 admin_entidade: PUT vinculo papelId=leitura -> 200" "$(jget "$R2" trocar_papel_status)" "200"
check "2.5.5 admin_entidade: PUT vinculo ativo=false (desativar) -> 200" "$(jget "$R2" desativar_status)" "200"

# ─────────────────────────────────────────────────────────────────────────
# 0101 — `financeiro` e `financeiro_aprovador` enxergam Envio em Massa,
# Validação XML e Motoristas, em LEITURA (pedido do operador, 2026-09-29).
#
# O que estes asserts protegem: (a) o menu do hub é
# `ModuloEntidade ativo ∩ prefixos das permissões` (hub-me.js) — um dos dois
# lados faltando e o item some sem erro nenhum; (b) o escopo é leitura — se
# `envio_massa.enviar` vazar para o papel, o financeiro passa a poder
# disparar mensagem a motorista, que é irreversível.
# ─────────────────────────────────────────────────────────────────────────
modulos_e_permissoes() { # modulos_e_permissoes <email> <senha>
  run_node "$1" "$2" "$E" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) { const [pair] = c.split(';'); const idx = pair.indexOf('='); jar[pair.slice(0, idx)] = pair.slice(idx + 1); }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }
async function main() {
  const email = process.argv[2], senha = process.argv[3], empresaId = Number(process.argv[4]);
  const out = {};

  const rLogin = await fetch(BASE + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, senha }),
  });
  let jar = parseSetCookie(rLogin);
  out.login_status = rLogin.status;

  const rTroca = await fetch(BASE + '/me/entidade', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ empresa_id: empresaId }),
  });
  jar = { ...jar, ...parseSetCookie(rTroca) };

  const rMe = await fetch(BASE + '/me', { headers: { Cookie: cookieHeader(jar) } });
  const me = await rMe.json();
  const codigos = (me.modulos || []).map((m) => m.codigo);
  const perms = new Set(me.permissoes || []);
  out.me_status = rMe.status;
  for (const c of ['adiantamentos', 'envio_massa', 'validacao_xml', 'motoristas']) {
    out['modulo_' + c] = codigos.includes(c) ? 'true' : 'false';
  }
  for (const p of ['envio_massa.consultar', 'validacao_xml.validar', 'motoristas.listar', 'motoristas.consultar']) {
    out['perm_' + p.replace('.', '_')] = perms.has(p) ? 'true' : 'false';
  }
  // leitura, não operação
  for (const p of ['envio_massa.criar', 'envio_massa.enviar', 'envio_massa.aprovar', 'motoristas.editar', 'motoristas.credencial']) {
    out['negada_' + p.replace('.', '_')] = perms.has(p) ? 'true' : 'false';
  }

  // Gate REAL do XML: sem arquivo o multer responde 400 — o que importa é
  // não ser 403. Um papel sem `validacao_xml.validar` bate em 403 antes.
  const rXml = await fetch('http://localhost:3000/validate-xml-batch', {
    method: 'POST', headers: { Cookie: cookieHeader(jar) },
  });
  out.xml_status = rXml.status;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
}

for PERFIL in financeiro financeiroaprov; do
  OUT="$(modulos_e_permissoes "fin-$PERFIL@example.test" "$SENHA_OK")"
  R="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
  [ -n "$R" ] || { echo "FAIL: script Node (0101 $PERFIL) não retornou resultado"; echo "$OUT"; exit 1; }
  check "0101 $PERFIL: GET /me -> 200" "$(jget "$R" me_status)" "200"
  for M in adiantamentos envio_massa validacao_xml motoristas; do
    check "0101 $PERFIL: modulo '$M' no menu" "$(jget "$R" "modulo_$M")" "true"
  done
  for P in envio_massa_consultar validacao_xml_validar motoristas_listar motoristas_consultar; do
    check "0101 $PERFIL: tem permissao $P" "$(jget "$R" "perm_$P")" "true"
  done
  for P in envio_massa_criar envio_massa_enviar envio_massa_aprovar motoristas_editar motoristas_credencial; do
    check "0101 $PERFIL: NAO tem permissao $P (leitura)" "$(jget "$R" "negada_$P")" "false"
  done
  check "0101 $PERFIL: POST /validate-xml-batch passa do gate (400, nao 403)" "$(jget "$R" xml_status)" "400"
done

# Controle negativo do gate: `leitura` não tem `validacao_xml.validar` (nunca
# teve `envio_massa.enviar`, então a 0047 não o alcançou) -> 403 no MESMO
# endpoint que o financeiro atravessa. Sem este par, um gate que deixasse
# QUALQUER autenticado passar pareceria igualmente verde.
OUT="$(modulos_e_permissoes 'fin-leitura@example.test' "$SENHA_OK")"
R="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$R" ] || { echo "FAIL: script Node (0101 controle leitura) não retornou resultado"; echo "$OUT"; exit 1; }
check "0101 controle (leitura): NAO tem validacao_xml.validar" "$(jget "$R" perm_validacao_xml_validar)" "false"
check "0101 controle (leitura): /validate-xml-batch -> 403" "$(jget "$R" xml_status)" "403"
check "0101 controle (leitura): modulo validacao_xml FORA do menu" "$(jget "$R" modulo_validacao_xml)" "false"

echo
echo "fails=$fails"
if [ "$fails" = "0" ]; then
  echo "HUB-FINANCEIRO-APROVADOR-RBAC-INTEGRATION: OK — 2.5.1/2.5.2/2.5.4/2.4.4-cross-tenant/2.5.5 (tasks.md F2)"
else
  echo "HUB-FINANCEIRO-APROVADOR-RBAC-INTEGRATION: $fails assert(s) FALHARAM" >&2
fi
[ "$fails" -eq 0 ]

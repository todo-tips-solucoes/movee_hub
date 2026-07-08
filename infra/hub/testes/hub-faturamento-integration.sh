#!/usr/bin/env bash
# =============================================================================
# hub-faturamento-integration.sh — tasks.md FASE 3 (3.2.5): prova E2E de
# GET /api/v1/faturamento contra um projeto hub-test EFÊMERO e descartável.
# Mesmo padrão de isolamento de infra/hub/testes/hub-motoristas-integration.sh
# / hub-importacoes-integration.sh — nunca toca chatmasterveloz/produção.
#
# Cobre:
#   (a) sem cookie -> 401
#   (b) lista básica (sem filtro) -> 200, items/total corretos
#   (c) filtros combinados (categoria+data) -> subconjunto correto
#   (d) paginação (page/pageSize) -> slice correto, total NÃO muda com a página
#   (e) período sem dados -> 200 { items:[], total:0 } (FR-012, nunca erro)
#   (f) filtro contraditório (entregadorId + comEntregador=false) -> 400
#   (g) data inválida -> 400
#   (h) sem faturamento.listar (papel sintético sem a permissão) -> 403
#   (i) isolamento multi-tenant: lançamentos de OUTRA entidade nunca aparecem
#   (j) lançamento agregado/bônus (entregador_id NULL) aparece com
#       comEntregador:false, entregadorId/Nome null — nunca omitido (FR-005)
#
# Uso: infra/hub/testes/hub-faturamento-integration.sh
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

echo "rodando migrate.sh (0002..0027)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0027_hub_faturamento_rpc_resumo.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas por completo (0027 ausente)"; cat "$TMP/migrate.log"; exit 1; }

# --- Seed: 2 Usuarios (leitura com faturamento.listar; papel sintético SEM
# a permissão, para o teste de 403) -----------------------------------------
SENHA_OK='SenhaSinteticaFaturamento#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

E_TESTE=950001
E_OUTRA=950002
E_SEM_PERM=950003

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('faturamento-leitura@example.test', '$HASH_OK', 'Usuario Teste Faturamento Leitura', true),
  ('faturamento-sempermissao@example.test', '$HASH_OK', 'Usuario Teste Faturamento Sem Permissao', true);
SQL
UID_LEITURA="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='faturamento-leitura@example.test'" | tr -d '[:space:]')"
UID_SEMPERM="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='faturamento-sempermissao@example.test'" | tr -d '[:space:]')"
PAPEL_LEITURA="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='leitura'" | tr -d '[:space:]')"
[ -n "$PAPEL_LEITURA" ] || { echo "FAIL: seed 0007 não populou o papel 'leitura' esperado"; exit 1; }

# Papel sintético SEM faturamento.listar (os 4 papéis-seed — admin_plataforma/
# admin_entidade/operador/leitura — TODOS concedem faturamento.listar desde a
# migration 0026; para o teste de 403 é preciso um papel próprio,
# is_sistema=false, restrito a uma permissão fora do módulo).
psql_t <<SQL >/dev/null
INSERT INTO "Papel" (nome, escopo, is_sistema) VALUES ('sem_faturamento_teste', 'entidade', false)
ON CONFLICT (nome) DO NOTHING;
INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id FROM "Papel" p, "Permissao" perm
WHERE p.nome = 'sem_faturamento_teste' AND perm.codigo = 'dashboard.consultar'
ON CONFLICT DO NOTHING;
SQL
PAPEL_SEM_PERM="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='sem_faturamento_teste'" | tr -d '[:space:]')"

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_LEITURA, $E_TESTE, $PAPEL_LEITURA, true),
  ($UID_LEITURA, $E_OUTRA, $PAPEL_LEITURA, true),
  ($UID_SEMPERM, $E_SEM_PERM, $PAPEL_SEM_PERM, true);
SQL

# --- Seed: Entregadores + ImportacaoArquivo-cabeçalho fake + fatos --------
psql_t <<SQL >/dev/null
INSERT INTO "Entregador" (id_empresa, id_externo, nome, ativo, motorista_id) VALUES
  ($E_TESTE, gen_random_uuid(), 'Joao Faturamento', true, NULL),
  ($E_TESTE, gen_random_uuid(), 'Maria Faturamento', true, NULL),
  ($E_OUTRA, gen_random_uuid(), 'Entregador De Outro Tenant', true, NULL);
SQL
ENT_JOAO="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_TESTE AND nome='Joao Faturamento'" | tr -d '[:space:]')"
ENT_MARIA="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_TESTE AND nome='Maria Faturamento'" | tr -d '[:space:]')"
ENT_OUTRA="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_OUTRA" | tr -d '[:space:]')"
for v in ENT_JOAO ENT_MARIA ENT_OUTRA; do
  [ -n "${!v}" ] || { echo "FAIL: $v não foi criado"; exit 1; }
done

psql_t <<SQL >/dev/null
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, nome_arquivo, hash_sha256, tamanho_bytes, status)
VALUES
  ($E_TESTE, 'faturamento', 'seed-teste.csv', repeat('a', 64), 10, 'completed_with_errors'),
  ($E_OUTRA, 'faturamento', 'seed-teste-outra.csv', repeat('b', 64), 10, 'completed_with_errors')
ON CONFLICT DO NOTHING;
SQL
IMPORT_ID="$(psql_t -tAc "SELECT id FROM \"ImportacaoArquivo\" WHERE id_empresa=$E_TESTE AND nome_arquivo='seed-teste.csv'" | tr -d '[:space:]')"
IMPORT_ID_OUTRA="$(psql_t -tAc "SELECT id FROM \"ImportacaoArquivo\" WHERE id_empresa=$E_OUTRA AND nome_arquivo='seed-teste-outra.csv'" | tr -d '[:space:]')"
[ -n "$IMPORT_ID" ] && [ -n "$IMPORT_ID_OUTRA" ] || { echo "FAIL: ImportacaoArquivo de teste não foi criada"; exit 1; }

# Fatos em E_TESTE: 2 categorias, 2 entregadores, 1 bônus (entregador_id
# NULL, FR-005), datas espalhadas em julho/2026 (dentro da janela padrão de
# 30 dias quando o teste roda perto dessas datas — os cenários de filtro
# usam `de`/`ate` explícitos, então a data corrente do runner é irrelevante).
psql_t <<SQL >/dev/null
INSERT INTO "FaturamentoLancamento"
  (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, subpraca, praca, periodo, tipo, valor, descricao, hash_linha)
VALUES
  ($E_TESTE, $IMPORT_ID, $ENT_JOAO,  '2026-07-01', '2026-07-01', 'Zona Sul', 'Sao Paulo', 'ALMOCO', 'Credito', 100.00, 'Corridas concluidas', md5('joao-1')),
  ($E_TESTE, $IMPORT_ID, $ENT_JOAO,  '2026-07-02', '2026-07-02', 'Zona Sul', 'Sao Paulo', 'JANTAR',  'Credito', 50.00,  'Corridas concluidas', md5('joao-2')),
  ($E_TESTE, $IMPORT_ID, $ENT_MARIA, '2026-07-03', '2026-07-03', 'Centro',   'Sao Paulo', 'ALMOCO', 'Credito', 80.00,  'Gorjeta',             md5('maria-1')),
  ($E_TESTE, $IMPORT_ID, NULL,       '2026-07-04', '2026-07-04', 'Centro',   'Sao Paulo', NULL,     'Credito', 30.00,  'Bonus semanal',       md5('bonus-1')),
  ($E_OUTRA, $IMPORT_ID_OUTRA, $ENT_OUTRA, '2026-07-01', '2026-07-01', 'Zona Norte', 'Rio', 'ALMOCO', 'Credito', 999.00, 'Nao deve vazar', md5('outra-1'));
SQL

# ─────────────────────────────────────────────────────────────────────────────
# Script Node único: login + troca de entidade + chamadas GET.
# ─────────────────────────────────────────────────────────────────────────────
OUT="$(run_node "$SENHA_OK" "$E_TESTE" "$E_OUTRA" "$E_SEM_PERM" <<'JS'
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

async function main() {
  const senha = process.argv[2];
  const empresaTeste = Number(process.argv[3]);
  const empresaOutra = Number(process.argv[4]);
  const empresaSemPerm = Number(process.argv[5]);
  const out = {};

  // ── sem autenticação: 401 ────────────────────────────────────────────────
  const rSemAuth = await getJson(null, '/faturamento');
  out.sem_auth_status = rSemAuth.status;

  // ── login leitura + entidade ativa ───────────────────────────────────────
  let jarLeitura = await login('faturamento-leitura@example.test', senha);
  jarLeitura = await trocarEntidade(jarLeitura, empresaTeste);

  // (b) lista básica — janela ampla cobrindo todo o seed
  const rLista = await getJson(jarLeitura, '/faturamento?de=2026-07-01&ate=2026-07-04');
  out.lista_status = rLista.status;
  out.lista_total = rLista.body && rLista.body.total;
  out.lista_items_len = rLista.body && rLista.body.items ? rLista.body.items.length : null;

  // (c) filtro por categoria — só "Corridas concluidas" (2 linhas do Joao)
  const rCategoria = await getJson(jarLeitura, '/faturamento?de=2026-07-01&ate=2026-07-04&categoria=Corridas%20concluidas');
  out.categoria_total = rCategoria.body && rCategoria.body.total;

  // (c.2) filtro combinado categoria + data — só 1 linha (joao-1, 2026-07-01)
  const rCombinado = await getJson(jarLeitura, '/faturamento?de=2026-07-01&ate=2026-07-01&categoria=Corridas%20concluidas');
  out.combinado_total = rCombinado.body && rCombinado.body.total;
  out.combinado_valor = rCombinado.body && rCombinado.body.items[0] && rCombinado.body.items[0].valor;

  // (d) paginação — pageSize=2, total já conhecido (4), page=2 tem 2 itens
  const rPag1 = await getJson(jarLeitura, '/faturamento?de=2026-07-01&ate=2026-07-04&pageSize=2&page=1');
  const rPag2 = await getJson(jarLeitura, '/faturamento?de=2026-07-01&ate=2026-07-04&pageSize=2&page=2');
  out.pag1_len = rPag1.body && rPag1.body.items.length;
  out.pag2_len = rPag2.body && rPag2.body.items.length;
  out.pag1_total = rPag1.body && rPag1.body.total;
  out.pag2_total = rPag2.body && rPag2.body.total;

  // (e) período sem dados — nunca erro
  const rVazio = await getJson(jarLeitura, '/faturamento?de=2020-01-01&ate=2020-01-31');
  out.vazio_status = rVazio.status;
  out.vazio_total = rVazio.body && rVazio.body.total;
  out.vazio_items_len = rVazio.body && rVazio.body.items ? rVazio.body.items.length : null;

  // (f) filtro contraditório
  const rContraditorio = await getJson(jarLeitura, '/faturamento?entregadorId=1&comEntregador=false');
  out.contraditorio_status = rContraditorio.status;
  out.contraditorio_erro = rContraditorio.body && rContraditorio.body.erro;

  // (g) data inválida
  const rDataInvalida = await getJson(jarLeitura, '/faturamento?de=2026-02-30');
  out.data_invalida_status = rDataInvalida.status;
  out.data_invalida_erro = rDataInvalida.body && rDataInvalida.body.erro;

  // (h) sem faturamento.listar
  let jarSemPerm = await login('faturamento-sempermissao@example.test', senha);
  jarSemPerm = await trocarEntidade(jarSemPerm, empresaSemPerm);
  const rSemPermissao = await getJson(jarSemPerm, '/faturamento');
  out.sem_permissao_status = rSemPermissao.status;
  out.sem_permissao_erro = rSemPermissao.body && rSemPermissao.body.erro;

  // (i) isolamento multi-tenant — troca para E_OUTRA, filtro amplo, nunca
  // vê o lançamento de $999.00 nem o de E_TESTE
  let jarOutra = await trocarEntidade(jarLeitura, empresaOutra);
  const rOutra = await getJson(jarOutra, '/faturamento?de=2026-07-01&ate=2026-07-04');
  out.outra_total = rOutra.body && rOutra.body.total;
  out.outra_valor = rOutra.body && rOutra.body.items[0] && rOutra.body.items[0].valor;

  // (j) lançamento agregado/bônus (entregador_id NULL) — comEntregador:false,
  // entregadorId/Nome null, NUNCA omitido do filtro amplo (b) — já incluso em
  // lista_total=4; aqui filtra especificamente comEntregador=false.
  const rBonus = await getJson(jarLeitura, '/faturamento?de=2026-07-01&ate=2026-07-04&comEntregador=false');
  out.bonus_total = rBonus.body && rBonus.body.total;
  const bonusItem = rBonus.body && rBonus.body.items && rBonus.body.items[0];
  out.bonus_comEntregador = bonusItem ? String(bonusItem.comEntregador) : null;
  // entregadorId/entregadorNome: NÃO envolver em String() — o valor
  // esperado é o `null` JSON genuíno (ausência de entregador), e
  // `String(null)` produziria a STRING "null" (bug de harness, não de
  // produto) mascarando um eventual regressão real. `jget` já normaliza
  // JSON null/undefined -> string vazia (ver definição abaixo).
  out.bonus_entregadorId = bonusItem ? bonusItem.entregadorId : null;
  out.bonus_entregadorNome = bonusItem ? bonusItem.entregadorNome : null;
  out.bonus_categoria = bonusItem ? bonusItem.categoria : null;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT" | grep -v '___RESULT_JSON___' || true
RESULT_LINE="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$RESULT_LINE" ] || { echo "FAIL: script Node não retornou resultado"; echo "$OUT"; exit 1; }
jget() { printf '%s' "$RESULT_LINE" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const v=d['$1']; process.stdout.write(v===null||v===undefined?'':String(v))"; }

check "GET /faturamento sem cookie -> 401" "$(jget sem_auth_status)" "401"
check "lista básica -> 200" "$(jget lista_status)" "200"
check "lista básica -> total=4 (2 joao + 1 maria + 1 bonus)" "$(jget lista_total)" "4"
check "lista básica -> items.length=4" "$(jget lista_items_len)" "4"
check "filtro categoria='Corridas concluidas' -> total=2" "$(jget categoria_total)" "2"
check "filtro combinado categoria+data -> total=1" "$(jget combinado_total)" "1"
check "filtro combinado -> valor='100.00' (string)" "$(jget combinado_valor)" "100.00"
check "paginação pageSize=2 page=1 -> 2 itens" "$(jget pag1_len)" "2"
check "paginação pageSize=2 page=2 -> 2 itens" "$(jget pag2_len)" "2"
check "paginação -> total NÃO muda entre páginas (page=1)" "$(jget pag1_total)" "4"
check "paginação -> total NÃO muda entre páginas (page=2)" "$(jget pag2_total)" "4"
check "período sem dados -> 200 (FR-012, nunca erro)" "$(jget vazio_status)" "200"
check "período sem dados -> total=0" "$(jget vazio_total)" "0"
check "período sem dados -> items=[]" "$(jget vazio_items_len)" "0"
check "filtro contraditório (entregadorId+comEntregador=false) -> 400" "$(jget contraditorio_status)" "400"
check "filtro contraditório -> erro=FILTRO_CONTRADITORIO" "$(jget contraditorio_erro)" "FILTRO_CONTRADITORIO"
check "data inválida (2026-02-30) -> 400" "$(jget data_invalida_status)" "400"
check "data inválida -> erro=DATA_INVALIDA" "$(jget data_invalida_erro)" "DATA_INVALIDA"
check "sem faturamento.listar (papel sintético) -> 403" "$(jget sem_permissao_status)" "403"
check "sem permissão -> erro=PERMISSAO_NEGADA" "$(jget sem_permissao_erro)" "PERMISSAO_NEGADA"
check "isolamento multi-tenant: E_OUTRA não vê nada de E_TESTE (total=1, só o próprio)" "$(jget outra_total)" "1"
check "isolamento multi-tenant: valor da única linha de E_OUTRA = '999.00'" "$(jget outra_valor)" "999.00"
check "bônus/agregado (comEntregador=false) -> total=1" "$(jget bonus_total)" "1"
check "bônus -> comEntregador=false" "$(jget bonus_comEntregador)" "false"
check "bônus -> entregadorId=null" "$(jget bonus_entregadorId)" ""
check "bônus -> entregadorNome=null" "$(jget bonus_entregadorNome)" ""
check "bônus -> categoria preservada ('Bonus semanal')" "$(jget bonus_categoria)" "Bonus semanal"

echo
if [ "$fails" = "0" ]; then
  echo "HUB-FATURAMENTO-INTEGRATION: OK — todos os asserts passaram (FASE 3: 3.1/3.2)"
else
  echo "HUB-FATURAMENTO-INTEGRATION: $fails assert(s) FALHARAM" >&2
  exit 1
fi

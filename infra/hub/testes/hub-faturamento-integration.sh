#!/usr/bin/env bash
# =============================================================================
# hub-faturamento-integration.sh — tasks.md FASE 3/4 (3.2.5/4.1.5): prova E2E
# de GET /api/v1/faturamento e GET /api/v1/faturamento/resumo contra um
# projeto hub-test EFÊMERO e descartável. Mesmo padrão de isolamento de
# infra/hub/testes/hub-motoristas-integration.sh/hub-importacoes-integration.sh
# — nunca toca chatmasterveloz/produção.
#
# GET /faturamento cobre:
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
# GET /faturamento/resumo cobre (tasks.md 4.1.5):
#   (k) cards sem groupBy -> totalGeral/categoriaMaiorValor/entregadoresDistintos
#   (l) agrupado por dia/categoria/entregador -> soma bate com o total geral
#   (m) empate alfabético no card de categoria (dec-014)
#   (n) período vazio -> cards zerados / grupos:[] (FR-012, nunca erro)
#   (o) groupBy inválido -> 400
#   (p) bucket agregados/bônus aparece com rótulo fixo no agrupado por entregador
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

echo "rodando migrate.sh (0002..0028)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0028_mv_faturamento_dia.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas por completo (0028 ausente)"; cat "$TMP/migrate.log"; exit 1; }

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
  ('faturamento-sempermissao@example.test', '$HASH_OK', 'Usuario Teste Faturamento Sem Permissao', true),
  ('faturamento-exportador@example.test', '$HASH_OK', 'Usuario Teste Faturamento Exportador', true);
SQL
UID_LEITURA="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='faturamento-leitura@example.test'" | tr -d '[:space:]')"
UID_SEMPERM="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='faturamento-sempermissao@example.test'" | tr -d '[:space:]')"
UID_EXPORTADOR="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='faturamento-exportador@example.test'" | tr -d '[:space:]')"
PAPEL_LEITURA="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='leitura'" | tr -d '[:space:]')"
[ -n "$PAPEL_LEITURA" ] || { echo "FAIL: seed 0007 não populou o papel 'leitura' esperado"; exit 1; }
# 'admin_entidade' é um dos 2 únicos papéis-seed com faturamento.exportar
# (0007 concede exportar só a admin_plataforma/admin_entidade — 'leitura'/
# 'operador' NUNCA têm, mesmo padrão de importacoes.exportar/0016) — usado
# nos cenários de export CSV bem-sucedido (q/r/s) abaixo.
PAPEL_ADMIN_ENTIDADE="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_entidade'" | tr -d '[:space:]')"
[ -n "$PAPEL_ADMIN_ENTIDADE" ] || { echo "FAIL: seed 0007 não populou o papel 'admin_entidade' esperado"; exit 1; }

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
  ($UID_SEMPERM, $E_SEM_PERM, $PAPEL_SEM_PERM, true),
  ($UID_EXPORTADOR, $E_TESTE, $PAPEL_ADMIN_ENTIDADE, true);
SQL

# --- Seed: Entregadores + ImportacaoArquivo-cabeçalho fake + fatos --------
psql_t <<SQL >/dev/null
INSERT INTO "Entregador" (id_empresa, id_externo, nome, ativo, motorista_id) VALUES
  ($E_TESTE, gen_random_uuid(), 'Joao Faturamento', true, NULL),
  ($E_TESTE, gen_random_uuid(), 'Maria Faturamento', true, NULL),
  ($E_TESTE, gen_random_uuid(), '@Perigoso Nome', true, NULL),
  ($E_OUTRA, gen_random_uuid(), 'Entregador De Outro Tenant', true, NULL);
SQL
ENT_JOAO="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_TESTE AND nome='Joao Faturamento'" | tr -d '[:space:]')"
ENT_MARIA="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_TESTE AND nome='Maria Faturamento'" | tr -d '[:space:]')"
ENT_INJECAO="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_TESTE AND nome='@Perigoso Nome'" | tr -d '[:space:]')"
ENT_OUTRA="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_OUTRA" | tr -d '[:space:]')"
for v in ENT_JOAO ENT_MARIA ENT_INJECAO ENT_OUTRA; do
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

# Fatos dedicados ao empate alfabético (dec-014, Cenário 3/tasks.md 4.1.5) —
# janela ISOLADA (2026-08-01) para não interferir na soma/contagem dos
# cenários de GET /faturamento acima: 'Alfa' e 'Zeta' somam EXATAMENTE
# 50.00 cada -> categoriaMaiorValor MUST ser 'Alfa' (primeira em ordem
# alfabética entre as empatadas).
psql_t <<SQL >/dev/null
INSERT INTO "FaturamentoLancamento"
  (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, subpraca, praca, periodo, tipo, valor, descricao, hash_linha)
VALUES
  ($E_TESTE, $IMPORT_ID, $ENT_JOAO,  '2026-08-01', '2026-08-01', 'Zona Sul', 'Sao Paulo', 'ALMOCO', 'Credito', 50.00, 'Zeta', md5('empate-zeta')),
  ($E_TESTE, $IMPORT_ID, $ENT_MARIA, '2026-08-01', '2026-08-01', 'Centro',   'Sao Paulo', 'ALMOCO', 'Credito', 50.00, 'Alfa', md5('empate-alfa'));
SQL

# Fato dedicado a CSV injection (FASE 5/tasks.md 5.1.7, Cenário 8) — janela
# ISOLADA (2026-09-01): categoria começa com '=' (fórmula), entregador
# (`@Perigoso Nome`, seed acima) começa com '@'. Ambas as células MUST vir
# neutralizadas (prefixo `'`) no CSV exportado.
psql_t <<SQL >/dev/null
INSERT INTO "FaturamentoLancamento"
  (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, subpraca, praca, periodo, tipo, valor, descricao, hash_linha)
VALUES
  ($E_TESTE, $IMPORT_ID, $ENT_INJECAO, '2026-09-01', '2026-09-01', 'Zona Sul', 'Sao Paulo', 'ALMOCO', 'Credito', 77.00, '=SOMA(A1:A10)', md5('injecao-1'));
SQL

# Follow-up SC-004 (migration 0028): as RPCs de /resumo agora leem da
# mv_faturamento_dia — como os fatos acima entraram por SQL direto (não pelo
# pipeline de importação, que faz o refresh sozinho), refresh explícito aqui
# para os asserts de resumo enxergarem os seeds. O fato de TODOS os asserts
# (k)-(p) abaixo continuarem passando prova a paridade MV × tabela-base.
psql_t -c 'REFRESH MATERIALIZED VIEW mv_faturamento_dia;' >/dev/null

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
async function getCsv(jar, path) {
  const r = await fetch(`${BASE}${path}`, { headers: jar ? { Cookie: cookieHeader(jar) } : {} });
  const text = await r.text();
  return {
    status: r.status,
    text,
    contentType: r.headers.get('content-type'),
    contentDisposition: r.headers.get('content-disposition'),
  };
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

  // ── GET /faturamento/resumo (FASE 4, tasks.md 4.1.5) ────────────────────

  // (k) cards sem groupBy — janela 2026-07-01..04 (joao 150 + maria 80 +
  // bonus 30 = 260.00; maior categoria = 'Corridas concluidas' (150); 2
  // entregadores distintos, bônus/NULL não conta).
  const rCards = await getJson(jarLeitura, '/faturamento/resumo?de=2026-07-01&ate=2026-07-04');
  out.cards_status = rCards.status;
  out.cards_totalGeral = rCards.body && rCards.body.totalGeral;
  out.cards_categoriaMaiorValor = rCards.body && rCards.body.categoriaMaiorValor;
  out.cards_entregadoresDistintos = rCards.body && rCards.body.entregadoresDistintos;

  // (l) agrupado por dia — 4 dias distintos, soma das linhas bate com o total
  const rDia = await getJson(jarLeitura, '/faturamento/resumo?de=2026-07-01&ate=2026-07-04&groupBy=dia');
  out.dia_status = rDia.status;
  out.dia_groupBy = rDia.body && rDia.body.groupBy;
  out.dia_qtd_grupos = rDia.body && rDia.body.grupos ? rDia.body.grupos.length : null;
  out.dia_soma = rDia.body && rDia.body.grupos
    ? rDia.body.grupos.reduce((acc, g) => acc + Number(g.total), 0).toFixed(2)
    : null;

  // agrupado por categoria — 3 grupos (Corridas concluidas/Gorjeta/Bonus semanal)
  const rCategoriaGrp = await getJson(jarLeitura, '/faturamento/resumo?de=2026-07-01&ate=2026-07-04&groupBy=categoria');
  out.categoriaGrp_qtd = rCategoriaGrp.body && rCategoriaGrp.body.grupos ? rCategoriaGrp.body.grupos.length : null;

  // agrupado por entregador — joao/maria (nome via rótulo) + agregados_bonus
  const rEntregadorGrp = await getJson(jarLeitura, '/faturamento/resumo?de=2026-07-01&ate=2026-07-04&groupBy=entregador');
  const grupos = (rEntregadorGrp.body && rEntregadorGrp.body.grupos) || [];
  out.entregadorGrp_qtd = grupos.length;
  const grupoJoao = grupos.find((g) => g.total === '150.00');
  out.entregadorGrp_rotuloJoao = grupoJoao ? grupoJoao.rotulo : null;
  const grupoBonus = grupos.find((g) => g.chave === 'agregados_bonus');
  out.entregadorGrp_rotuloBonus = grupoBonus ? grupoBonus.rotulo : null;
  out.entregadorGrp_totalBonus = grupoBonus ? grupoBonus.total : null;

  // (m) empate alfabético (dec-014) — janela isolada 2026-08-01, 'Alfa' vs
  // 'Zeta' empatados em 50.00 -> vence 'Alfa'
  const rEmpate = await getJson(jarLeitura, '/faturamento/resumo?de=2026-08-01&ate=2026-08-01');
  out.empate_categoriaMaiorValor = rEmpate.body && rEmpate.body.categoriaMaiorValor;

  // (n) período vazio — cards zerados / grupos:[] (FR-012, nunca erro)
  const rCardsVazio = await getJson(jarLeitura, '/faturamento/resumo?de=2020-01-01&ate=2020-01-31');
  out.cardsVazio_status = rCardsVazio.status;
  out.cardsVazio_totalGeral = rCardsVazio.body && rCardsVazio.body.totalGeral;
  out.cardsVazio_categoriaMaiorValor = rCardsVazio.body && rCardsVazio.body.categoriaMaiorValor;
  out.cardsVazio_entregadoresDistintos = rCardsVazio.body && rCardsVazio.body.entregadoresDistintos;

  const rGrupoVazio = await getJson(jarLeitura, '/faturamento/resumo?de=2020-01-01&ate=2020-01-31&groupBy=categoria');
  out.grupoVazio_status = rGrupoVazio.status;
  out.grupoVazio_len = rGrupoVazio.body && rGrupoVazio.body.grupos ? rGrupoVazio.body.grupos.length : null;

  // (o) groupBy inválido -> 400
  const rGroupByInvalido = await getJson(jarLeitura, '/faturamento/resumo?groupBy=mes');
  out.groupByInvalido_status = rGroupByInvalido.status;
  out.groupByInvalido_erro = rGroupByInvalido.body && rGroupByInvalido.body.erro;

  // resumo sem faturamento.consultar -> 403 (mesmo papel sintético do teste (h))
  const rResumoSemPermissao = await getJson(jarSemPerm, '/faturamento/resumo');
  out.resumoSemPermissao_status = rResumoSemPermissao.status;

  // ── GET /faturamento?format=csv (FASE 5, tasks.md 5.1.7) ────────────────
  // Usuário DEDICADO com faturamento.exportar (papel admin_entidade) — o
  // jarLeitura ('leitura') NUNCA teve exportar (0007 original), usado só no
  // cenário negativo (t) abaixo.
  let jarExportador = await login('faturamento-exportador@example.test', senha);
  jarExportador = await trocarEntidade(jarExportador, empresaTeste);

  // (q) export completo bate contagem com a tela — janela 2026-07-01..04,
  // 4 linhas conhecidas (mesma janela do cenário 'lista básica' acima).
  const rCsv = await getCsv(jarExportador, '/faturamento?format=csv&de=2026-07-01&ate=2026-07-04');
  out.csv_status = rCsv.status;
  out.csv_contentType = rCsv.contentType;
  out.csv_contentDisposition = rCsv.contentDisposition;
  const csvLinhas = rCsv.text.split('\r\n').filter((l) => l.length > 0);
  out.csv_cabecalho = csvLinhas[0];
  out.csv_qtd_linhas_dados = csvLinhas.length - 1; // exclui cabeçalho

  // (r) CSV injection neutralizada — janela isolada 2026-09-01: categoria
  // '=SOMA(A1:A10)' e entregadorNome '@Perigoso Nome' MUST vir com prefixo
  // `'` (única ocorrência, sem dupla neutralização).
  const rCsvInjecao = await getCsv(jarExportador, '/faturamento?format=csv&de=2026-09-01&ate=2026-09-01');
  const linhasInjecao = rCsvInjecao.text.split('\r\n').filter((l) => l.length > 0);
  out.csvInjecao_linha_dados = linhasInjecao[1] || null;

  // (s) export vazio — período sem nenhum lançamento -> só cabeçalho, 200
  const rCsvVazio = await getCsv(jarExportador, '/faturamento?format=csv&de=2019-01-01&ate=2019-01-02');
  out.csvVazio_status = rCsvVazio.status;
  const linhasVazio = rCsvVazio.text.split('\r\n').filter((l) => l.length > 0);
  out.csvVazio_qtd_linhas = linhasVazio.length; // só cabeçalho = 1

  // (t) 403 sem faturamento.exportar MESMO COM faturamento.listar — o
  // próprio jarLeitura (papel 'leitura': tem .listar/.consultar, NÃO tem
  // .exportar desde a 0007 original) — Cenário 10 passos 3-4 (bypass da UI).
  const rCsvSemExportar = await getCsv(jarLeitura, '/faturamento?format=csv&de=2026-07-01&ate=2026-07-04');
  out.csvSemExportar_status = rCsvSemExportar.status;
  let csvSemExportarErro = null;
  try { csvSemExportarErro = JSON.parse(rCsvSemExportar.text).erro; } catch { /* ignore */ }
  out.csvSemExportar_erro = csvSemExportarErro;

  // ── GET /faturamento/entregadores (hub-motorista-canonico FASE 2/WS-B,
  // tasks.md 2.1) — busca de entregador por nome, alimenta o
  // EntregadorCombobox. Reusa o seed de Entregadores já criado acima (Joao
  // Faturamento/Maria Faturamento/@Perigoso Nome em E_TESTE, Entregador De
  // Outro Tenant em E_OUTRA) — nenhum seed adicional necessário.

  // (aa) termo < 3 caracteres -> 422 busca_invalida (FR-006, front nem chama)
  const rEntregadoresCurto = await getJson(jarLeitura, '/faturamento/entregadores?busca=jo');
  out.entregadoresCurto_status = rEntregadoresCurto.status;
  out.entregadoresCurto_erro = rEntregadoresCurto.body && rEntregadoresCurto.body.erro;

  // (bb) busca válida escopada — "joa" casa "Joao Faturamento"
  // (case/acento-insensitive via hub_normaliza_nome)
  const rEntregadoresJoa = await getJson(jarLeitura, '/faturamento/entregadores?busca=joa');
  out.entregadoresJoa_status = rEntregadoresJoa.status;
  out.entregadoresJoa_len = rEntregadoresJoa.body && rEntregadoresJoa.body.items ? rEntregadoresJoa.body.items.length : null;
  out.entregadoresJoa_nome = rEntregadoresJoa.body && rEntregadoresJoa.body.items && rEntregadoresJoa.body.items[0] && rEntregadoresJoa.body.items[0].nome;

  // (cc) sem autenticação -> 401
  const rEntregadoresSemAuth = await getJson(null, '/faturamento/entregadores?busca=joa');
  out.entregadoresSemAuth_status = rEntregadoresSemAuth.status;

  // (dd) sem faturamento.listar -> 403 (mesmo papel sintético do teste (h))
  const rEntregadoresSemPermissao = await getJson(jarSemPerm, '/faturamento/entregadores?busca=joa');
  out.entregadoresSemPermissao_status = rEntregadoresSemPermissao.status;

  // (ee) isolamento multi-tenant: E_OUTRA busca "joa" -> NUNCA vê o Joao de
  // E_TESTE (FR-007) — RLS + p_id_empresa dentro do RPC 0042
  const rEntregadoresOutra = await getJson(jarOutra, '/faturamento/entregadores?busca=joa');
  out.entregadoresOutra_status = rEntregadoresOutra.status;
  out.entregadoresOutra_len = rEntregadoresOutra.body && rEntregadoresOutra.body.items ? rEntregadoresOutra.body.items.length : null;

  // (ff) [Gap CHK003 security.md — tasks.md 2.1.5] termo de busca hostil:
  // wildcards LIKE (%, _), aspas simples/duplas e tentativa de SQL — NUNCA
  // 5xx, NUNCA vaza dados fora do escopo, resposta sempre bem-formada. Todo
  // termo tem >=3 caracteres após trim (senão cairia no 422 de (aa), o que
  // mascararia o teste de injeção real contra o RPC parametrizado).
  const termosHostis = ['%%%', '___', 'o\'Neil"', '\'; DROP TABLE "Entregador"--', 'joa%', 'jo_'];
  const statusHostis = [];
  for (const termo of termosHostis) {
    // eslint-disable-next-line no-await-in-loop -- sequencial de propósito
    // (mesmo padrão do resto do script): cada termo hostil é 1 assert
    // independente, não precisa de paralelismo.
    const r = await getJson(jarLeitura, `/faturamento/entregadores?busca=${encodeURIComponent(termo)}`);
    statusHostis.push(r.status);
  }
  out.entregadoresHostis_statusUnicos = [...new Set(statusHostis)].sort().join(',');

  // controle: depois dos termos hostis, a tabela "Entregador" ainda existe e
  // o seed inteiro continua íntegro (a tentativa de DROP TABLE não executou
  // — prova viva de que o termo NUNCA chega como SQL, só como parâmetro)
  const rEntregadoresPosHostil = await getJson(jarLeitura, '/faturamento/entregadores?busca=joa');
  out.entregadoresPosHostil_status = rEntregadoresPosHostil.status;
  out.entregadoresPosHostil_len = rEntregadoresPosHostil.body && rEntregadoresPosHostil.body.items ? rEntregadoresPosHostil.body.items.length : null;

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

# ── GET /faturamento/resumo (FASE 4, tasks.md 4.1.5) ────────────────────────
check "resumo cards -> 200" "$(jget cards_status)" "200"
check "resumo cards -> totalGeral=260.00 (100+50+80+30)" "$(jget cards_totalGeral)" "260.00"
check "resumo cards -> categoriaMaiorValor='Corridas concluidas' (150, sem empate nesta janela)" "$(jget cards_categoriaMaiorValor)" "Corridas concluidas"
check "resumo cards -> entregadoresDistintos=2 (bônus/NULL não conta)" "$(jget cards_entregadoresDistintos)" "2"

check "resumo agrupado por dia -> 200" "$(jget dia_status)" "200"
check "resumo agrupado por dia -> groupBy='dia' ecoado" "$(jget dia_groupBy)" "dia"
check "resumo agrupado por dia -> 4 grupos (4 dias distintos)" "$(jget dia_qtd_grupos)" "4"
check "resumo agrupado por dia -> soma dos grupos bate com totalGeral (260.00)" "$(jget dia_soma)" "260.00"

check "resumo agrupado por categoria -> 3 grupos" "$(jget categoriaGrp_qtd)" "3"

check "resumo agrupado por entregador -> 3 grupos (joao+maria+agregados_bonus)" "$(jget entregadorGrp_qtd)" "3"
check "resumo agrupado por entregador -> rótulo do joao = nome (join Entregador)" "$(jget entregadorGrp_rotuloJoao)" "Joao Faturamento"
check "resumo agrupado por entregador -> rótulo do bucket bônus = 'Agregados/bônus' fixo" "$(jget entregadorGrp_rotuloBonus)" "Agregados/bônus"
check "resumo agrupado por entregador -> total do bucket bônus = 30.00" "$(jget entregadorGrp_totalBonus)" "30.00"

check "empate alfabético (dec-014): 'Alfa' vs 'Zeta' empatados em 50.00 -> vence 'Alfa'" "$(jget empate_categoriaMaiorValor)" "Alfa"

check "resumo cards período vazio -> 200 (FR-012, nunca erro)" "$(jget cardsVazio_status)" "200"
check "resumo cards período vazio -> totalGeral='0.00'" "$(jget cardsVazio_totalGeral)" "0.00"
check "resumo cards período vazio -> categoriaMaiorValor=null" "$(jget cardsVazio_categoriaMaiorValor)" ""
check "resumo cards período vazio -> entregadoresDistintos=0" "$(jget cardsVazio_entregadoresDistintos)" "0"
check "resumo agrupado período vazio -> 200" "$(jget grupoVazio_status)" "200"
check "resumo agrupado período vazio -> grupos=[]" "$(jget grupoVazio_len)" "0"

check "resumo groupBy inválido ('mes') -> 400" "$(jget groupByInvalido_status)" "400"
check "resumo groupBy inválido -> erro=GROUP_BY_INVALIDO" "$(jget groupByInvalido_erro)" "GROUP_BY_INVALIDO"

check "resumo sem faturamento.consultar (papel sintético) -> 403" "$(jget resumoSemPermissao_status)" "403"

# ── GET /faturamento?format=csv (FASE 5, tasks.md 5.1.7) ────────────────────
check "export CSV -> 200" "$(jget csv_status)" "200"
check "export CSV -> Content-Type text/csv; charset=utf-8" "$(jget csv_contentType)" "text/csv; charset=utf-8"
check "export CSV -> Content-Disposition com nome de arquivo esperado" "$(jget csv_contentDisposition)" 'attachment; filename="faturamento-2026-07-01_2026-07-04.csv"'
check "export CSV -> cabeçalho fixo do contrato" "$(jget csv_cabecalho)" "dataReferencia,categoria,valor,entregadorNome,subpraca,praca,periodo"
check "export CSV -> 4 linhas de dados (bate com a tela, mesma janela)" "$(jget csv_qtd_linhas_dados)" "4"

check "export CSV injection -> categoria '=' e entregadorNome '@' neutralizados (prefixo único ')" \
  "$(jget csvInjecao_linha_dados)" "2026-09-01,'=SOMA(A1:A10),77.00,'@Perigoso Nome,Zona Sul,Sao Paulo,ALMOCO"

check "export CSV vazio -> 200 (tasks.md 5.1.6, nunca erro)" "$(jget csvVazio_status)" "200"
check "export CSV vazio -> só a linha de cabeçalho" "$(jget csvVazio_qtd_linhas)" "1"

check "export CSV sem faturamento.exportar (só .listar) -> 403 (Cenário 10 passos 3-4, bypass da UI)" "$(jget csvSemExportar_status)" "403"
check "export CSV sem faturamento.exportar -> erro=PERMISSAO_NEGADA" "$(jget csvSemExportar_erro)" "PERMISSAO_NEGADA"

# ── GET /faturamento/entregadores (hub-motorista-canonico FASE 2/WS-B, tasks.md 2.1) ──
check "busca com 2 caracteres -> 422 busca_invalida (FR-006)" "$(jget entregadoresCurto_status)" "422"
check "busca curta -> erro=busca_invalida" "$(jget entregadoresCurto_erro)" "busca_invalida"
check "busca 'joa' -> 200" "$(jget entregadoresJoa_status)" "200"
check "busca 'joa' -> 1 item (Joao Faturamento)" "$(jget entregadoresJoa_len)" "1"
check "busca 'joa' -> nome='Joao Faturamento'" "$(jget entregadoresJoa_nome)" "Joao Faturamento"
check "GET /faturamento/entregadores sem cookie -> 401" "$(jget entregadoresSemAuth_status)" "401"
check "GET /faturamento/entregadores sem faturamento.listar -> 403" "$(jget entregadoresSemPermissao_status)" "403"
check "isolamento multi-tenant: E_OUTRA busca 'joa' -> 200 (nunca erro, FR-007)" "$(jget entregadoresOutra_status)" "200"
check "isolamento multi-tenant: E_OUTRA busca 'joa' -> 0 itens (Joao é de E_TESTE, nunca vaza)" "$(jget entregadoresOutra_len)" "0"
check "[Gap CHK003] termos hostis (%%%, ___, aspas, DROP TABLE) -> nunca 5xx, sempre 200" "$(jget entregadoresHostis_statusUnicos)" "200"
check "pós-termos-hostis: tabela Entregador íntegra (sem DROP), busca 'joa' continua 200" "$(jget entregadoresPosHostil_status)" "200"
check "pós-termos-hostis: seed intacto, ainda 1 item p/ 'joa'" "$(jget entregadoresPosHostil_len)" "1"

# ── Validação no banco: auditoria 'faturamento.csv_exportado' registrada
# (5.1.5) só para os exports BEM-SUCEDIDOS (q/r/s = 3), NUNCA para o 403 (t)
N_AUDITORIA_CSV="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='faturamento.csv_exportado' AND id_empresa=$E_TESTE" | tr -d '[:space:]')"
check "DB: Auditoria 'faturamento.csv_exportado' registrada 3x (só nos exports bem-sucedidos)" "$N_AUDITORIA_CSV" "3"

# ── mv_faturamento_dia (migration 0028, follow-up SC-004) ────────────────────
# (u) paridade: total agregado da MV = SUM direto na tabela-base, por empresa
# (v) isolamento: SELECT direto na MV como `authenticated` -> permission denied
#     (MV não tem RLS; REVOKE é a barreira — acesso só via RPC)
# (w) isolamento via RPC: escopo do JWT != p_id_empresa -> linha zerada
#     (guard explícito `p_id_empresa = ANY (hub_jwt_escopo_ids())` nas funções
#     SECURITY DEFINER — mesma semântica da RLS de 0027)
# (x) staleness/refresh: fato inserido por SQL só entra no /resumo após
#     hub_faturamento_refresh_mv() (modo concurrent via dblink); refresh com
#     escopo vazio é negado (42501)

# Executa <sql> numa transação como o role do PostgREST, com a claim de
# escopo <escopo-json> na GUC (mesmo mecanismo do PostgREST real).
rpc_como_authenticated() { # rpc_como_authenticated <escopo-json> <sql>
  # psql imprime as tags de comando (BEGIN/SET/ROLLBACK) mesmo com -t —
  # filtra as tags e fica com a ÚLTIMA linha de tupla (o resultado do <sql>;
  # a linha anterior é o retorno do set_config).
  psql_t -tA <<SQL | grep -vE '^(BEGIN|SET|ROLLBACK|COMMIT|RESET)$' | tail -n 1
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"escopo": $1}', true);
$2;
ROLLBACK;
SQL
}

# (u) paridade MV × tabela-base (as duas empresas seedadas)
for EMP in $E_TESTE $E_OUTRA; do
  MV_TOTAL="$(psql_t -tAc "SELECT COALESCE(SUM(total),0)::numeric(12,2)::text FROM mv_faturamento_dia WHERE id_empresa=$EMP" | tr -d '[:space:]')"
  BASE_TOTAL="$(psql_t -tAc "SELECT COALESCE(SUM(valor),0)::numeric(12,2)::text FROM \"FaturamentoLancamento\" WHERE id_empresa=$EMP" | tr -d '[:space:]')"
  check "MV (u): SUM(mv_faturamento_dia) = SUM(FaturamentoLancamento) para empresa $EMP" "$MV_TOTAL" "$BASE_TOTAL"
done
MV_QTD="$(psql_t -tAc "SELECT COALESCE(SUM(quantidade),0) FROM mv_faturamento_dia WHERE id_empresa=$E_TESTE" | tr -d '[:space:]')"
BASE_QTD="$(psql_t -tAc "SELECT count(*) FROM \"FaturamentoLancamento\" WHERE id_empresa=$E_TESTE" | tr -d '[:space:]')"
check "MV (u): SUM(quantidade) = count(*) da tabela-base para empresa $E_TESTE" "$MV_QTD" "$BASE_QTD"

# (v) SELECT direto na MV como authenticated -> permission denied
NEG_SELECT="$(psql_t -tA 2>&1 <<'SQL' || true
BEGIN;
SET LOCAL ROLE authenticated;
SELECT count(*) FROM mv_faturamento_dia;
ROLLBACK;
SQL
)"
case "$NEG_SELECT" in
  *"permission denied"*) check "MV (v): SELECT direto como authenticated -> permission denied" "ok" "ok" ;;
  *) check "MV (v): SELECT direto como authenticated -> permission denied" "$NEG_SELECT" "permission denied" ;;
esac

# (w) RPC com p_id_empresa FORA do escopo do JWT -> linha zerada (nunca vaza)
CROSS_TOTAIS="$(rpc_como_authenticated "[$E_TESTE]" "SELECT total_geral || '|' || COALESCE(categoria_maior_valor,'') || '|' || entregadores_distintos FROM hub_faturamento_totais($E_OUTRA, '2026-07-01', '2026-07-04', NULL, NULL, NULL, NULL)")"
check "MV (w): hub_faturamento_totais de OUTRA empresa (fora do escopo) -> zerado" "$CROSS_TOTAIS" "0.00||0"
CROSS_AGRUPADO="$(rpc_como_authenticated "[$E_TESTE]" "SELECT count(*) FROM hub_faturamento_agrupado($E_OUTRA, '2026-07-01', '2026-07-04', NULL, NULL, NULL, NULL, 'categoria')")"
check "MV (w): hub_faturamento_agrupado de OUTRA empresa (fora do escopo) -> 0 grupos" "$CROSS_AGRUPADO" "0"
# controle positivo: MESMA empresa dentro do escopo -> dado real (via MV)
PROPRIO_TOTAIS="$(rpc_como_authenticated "[$E_OUTRA]" "SELECT total_geral || '|' || categoria_maior_valor || '|' || entregadores_distintos FROM hub_faturamento_totais($E_OUTRA, '2026-07-01', '2026-07-04', NULL, NULL, NULL, NULL)")"
check "MV (w): controle positivo — a própria empresa continua enxergando seus totais" "$PROPRIO_TOTAIS" "999.00|Nao deve vazar|1"
# fallback tabela-base (p_subpraca) mantém o MESMO guard de escopo
CROSS_SUBPRACA="$(rpc_como_authenticated "[$E_TESTE]" "SELECT total_geral FROM hub_faturamento_totais($E_OUTRA, '2026-07-01', '2026-07-04', NULL, NULL, 'Zona Norte', NULL)")"
check "MV (w): fallback por subpraça de OUTRA empresa (fora do escopo) -> zerado" "$CROSS_SUBPRACA" "0.00"

# (x) staleness + refresh: fato NOVO em janela isolada (2026-10-01), inserido
# por SQL APÓS o refresh inicial -> /resumo (MV) ainda não vê; após
# hub_faturamento_refresh_mv() passa a ver. GET /faturamento (tabela-base)
# permanece sempre fresco por construção (lê a tabela, não a MV).
psql_t <<SQL >/dev/null
INSERT INTO "FaturamentoLancamento"
  (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, subpraca, praca, periodo, tipo, valor, descricao, hash_linha)
VALUES
  ($E_TESTE, $IMPORT_ID, $ENT_JOAO, '2026-10-01', '2026-10-01', 'Zona Sul', 'Sao Paulo', 'ALMOCO', 'Credito', 40.00, 'Staleness Teste', md5('staleness-1'));
SQL
STALE_TOTAL="$(rpc_como_authenticated "[$E_TESTE]" "SELECT total_geral FROM hub_faturamento_totais($E_TESTE, '2026-10-01', '2026-10-01', NULL, NULL, NULL, NULL)")"
check "MV (x): fato inserido por SQL ainda NÃO aparece no resumo (MV stale, comportamento documentado)" "$STALE_TOTAL" "0.00"

REFRESH_MODO="$(rpc_como_authenticated "[$E_TESTE]" "SELECT hub_faturamento_refresh_mv()->>'modo'")"
check "MV (x): hub_faturamento_refresh_mv() como authenticated -> modo=concurrent (dblink fora da transação)" "$REFRESH_MODO" "concurrent"

POS_REFRESH_TOTAL="$(rpc_como_authenticated "[$E_TESTE]" "SELECT total_geral FROM hub_faturamento_totais($E_TESTE, '2026-10-01', '2026-10-01', NULL, NULL, NULL, NULL)")"
check "MV (x): após o refresh o fato novo aparece no resumo" "$POS_REFRESH_TOTAL" "40.00"

NEG_REFRESH="$(psql_t -tA 2>&1 <<'SQL' || true
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"escopo": []}', true);
SELECT hub_faturamento_refresh_mv();
ROLLBACK;
SQL
)"
case "$NEG_REFRESH" in
  *"refresh negado"*) check "MV (x): refresh com escopo vazio -> negado (42501)" "ok" "ok" ;;
  *) check "MV (x): refresh com escopo vazio -> negado (42501)" "$NEG_REFRESH" "refresh negado" ;;
esac

echo
if [ "$fails" = "0" ]; then
  echo "HUB-FATURAMENTO-INTEGRATION: OK — todos os asserts passaram (FASE 3/4/5: 3.1/3.2/4.1/5.1; hub-motorista-canonico FASE 2/WS-B: 2.1)"
else
  echo "HUB-FATURAMENTO-INTEGRATION: $fails assert(s) FALHARAM" >&2
  exit 1
fi

#!/usr/bin/env bash
# =============================================================================
# hub-performance-integration.sh — tasks.md FASE 2 (2.2.5): prova E2E de
# GET /api/v1/performance contra um projeto hub-test EFÊMERO e descartável.
# Mesmo padrão de isolamento de infra/hub/testes/hub-faturamento-integration.sh
# (feature-irmã mais próxima, S6) — nunca toca chatmasterveloz/produção.
#
# GET /performance cobre (tasks.md 2.2.5):
#   (a) sem cookie -> 401
#   (b) lista básica (sem filtro) -> 200, items/total corretos
#   (c) filtros combinados (periodo+subpraca+data — Cenário 1) -> subconjunto correto
#   (d) paginação (page/pageSize) -> slice correto, total NÃO muda com a página
#   (e) período sem dados -> 200 { items:[], total:0 } (FR-011, nunca erro — Cenário 6)
#   (f) data inválida (formato E de > ate) -> 400
#   (g) entregadorId inválido -> 400
#   (h) sem performance.listar (papel sintético sem a permissão) -> 403
#   (i) isolamento multi-tenant: turnos de OUTRA entidade nunca aparecem
#   (j) entregadorId/entregadorNome SEMPRE presentes, nunca null (Decision 4)
#   (k) valor de `periodo` fora dos 16 turnos documentados aparece normalmente
#       (Edge Case, Cenário 4 item 4)
#
# GET /performance/resumo e GET /performance?format=csv são cobertos pelos
# scripts das FASES 3/4 (ainda não implementadas nesta execução).
#
# Uso: infra/hub/testes/hub-performance-integration.sh
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

echo "rodando migrate.sh (0002..0030)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0030_hub_performance_rpc_resumo.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas por completo (0030 ausente)"; cat "$TMP/migrate.log"; exit 1; }

# --- Seed: 2 Usuarios (leitura com performance.listar; papel sintético SEM
# a permissão, para o teste de 403) -----------------------------------------
SENHA_OK='SenhaSinteticaPerformance#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

E_TESTE=951001
E_OUTRA=951002
E_SEM_PERM=951003

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('performance-leitura@example.test', '$HASH_OK', 'Usuario Teste Performance Leitura', true),
  ('performance-sempermissao@example.test', '$HASH_OK', 'Usuario Teste Performance Sem Permissao', true),
  ('performance-exportador@example.test', '$HASH_OK', 'Usuario Teste Performance Exportador', true);
SQL
UID_LEITURA="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='performance-leitura@example.test'" | tr -d '[:space:]')"
UID_SEMPERM="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='performance-sempermissao@example.test'" | tr -d '[:space:]')"
UID_EXPORTADOR="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='performance-exportador@example.test'" | tr -d '[:space:]')"
PAPEL_LEITURA="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='leitura'" | tr -d '[:space:]')"
[ -n "$PAPEL_LEITURA" ] || { echo "FAIL: seed 0007 não populou o papel 'leitura' esperado"; exit 1; }
# 'admin_entidade' é um dos 2 únicos papéis-seed com performance.exportar
# (0029 concede exportar só a admin_plataforma/admin_entidade — 'leitura'/
# 'operador' NUNCA têm) — usado no cenário de export CSV bem-sucedido abaixo.
PAPEL_ADMIN_ENTIDADE="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_entidade'" | tr -d '[:space:]')"
[ -n "$PAPEL_ADMIN_ENTIDADE" ] || { echo "FAIL: seed 0007 não populou o papel 'admin_entidade' esperado"; exit 1; }

# Papel sintético SEM performance.listar (os 4 papéis-seed TODOS concedem
# performance.listar desde a migration 0029; para o teste de 403 é preciso um
# papel próprio, is_sistema=false, restrito a uma permissão fora do módulo).
psql_t <<SQL >/dev/null
INSERT INTO "Papel" (nome, escopo, is_sistema) VALUES ('sem_performance_teste', 'entidade', false)
ON CONFLICT (nome) DO NOTHING;
INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id FROM "Papel" p, "Permissao" perm
WHERE p.nome = 'sem_performance_teste' AND perm.codigo = 'dashboard.consultar'
ON CONFLICT DO NOTHING;
SQL
PAPEL_SEM_PERM="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='sem_performance_teste'" | tr -d '[:space:]')"

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
  ($E_TESTE, gen_random_uuid(), 'Joao Performance', true, NULL),
  ($E_TESTE, gen_random_uuid(), 'Maria Performance', true, NULL),
  ($E_TESTE, gen_random_uuid(), '@Perigoso Nome', true, NULL),
  ($E_TESTE, gen_random_uuid(), '''Ja Neutro Nome', true, NULL),
  ($E_OUTRA, gen_random_uuid(), 'Entregador De Outro Tenant', true, NULL);
SQL
ENT_JOAO="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_TESTE AND nome='Joao Performance'" | tr -d '[:space:]')"
ENT_MARIA="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_TESTE AND nome='Maria Performance'" | tr -d '[:space:]')"
ENT_INJECAO="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_TESTE AND nome='@Perigoso Nome'" | tr -d '[:space:]')"
ENT_JANEUTRO="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_TESTE AND nome=E'\\'Ja Neutro Nome'" | tr -d '[:space:]')"
ENT_OUTRA="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_OUTRA" | tr -d '[:space:]')"
for v in ENT_JOAO ENT_MARIA ENT_INJECAO ENT_JANEUTRO ENT_OUTRA; do
  [ -n "${!v}" ] || { echo "FAIL: $v não foi criado"; exit 1; }
done

psql_t <<SQL >/dev/null
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, nome_arquivo, hash_sha256, tamanho_bytes, status)
VALUES
  ($E_TESTE, 'performance', 'seed-teste.csv', repeat('a', 64), 10, 'completed_with_errors'),
  ($E_OUTRA, 'performance', 'seed-teste-outra.csv', repeat('b', 64), 10, 'completed_with_errors')
ON CONFLICT DO NOTHING;
SQL
IMPORT_ID="$(psql_t -tAc "SELECT id FROM \"ImportacaoArquivo\" WHERE id_empresa=$E_TESTE AND nome_arquivo='seed-teste.csv'" | tr -d '[:space:]')"
IMPORT_ID_OUTRA="$(psql_t -tAc "SELECT id FROM \"ImportacaoArquivo\" WHERE id_empresa=$E_OUTRA AND nome_arquivo='seed-teste-outra.csv'" | tr -d '[:space:]')"
[ -n "$IMPORT_ID" ] && [ -n "$IMPORT_ID_OUTRA" ] || { echo "FAIL: ImportacaoArquivo de teste não foi criada"; exit 1; }

# Fatos em E_TESTE: 2 entregadores, 2 subpraças, 1 periodo fora dos 16
# documentados (Edge Case, Cenário 4 item 4), datas espalhadas em julho/2026.
psql_t <<SQL >/dev/null
INSERT INTO "PerformanceTurno"
  (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca, praca,
   tempo_disponivel_pct, corridas_ofertadas, corridas_aceitas, corridas_rejeitadas,
   corridas_completadas, corridas_canceladas, pedidos_concluidos, taxas_centavos, hash_linha)
VALUES
  ($E_TESTE, $IMPORT_ID, $ENT_JOAO, '2026-07-01', 'ALMOCO 11H30-15H29', '03:00:00', 'Zona Sul', 'Sao Paulo',
   80.00, 10, 8, 2, 7, 1, 7, 1000, md5('joao-1')),
  ($E_TESTE, $IMPORT_ID, $ENT_JOAO, '2026-07-02', 'JANTAR 18H00-21H59', '03:00:00', 'Zona Sul', 'Sao Paulo',
   90.00, 10, 9, 1, 9, 0, 9, 2000, md5('joao-2')),
  ($E_TESTE, $IMPORT_ID, $ENT_MARIA, '2026-07-03', 'ALMOCO 11H30-15H29', '02:30:00', 'Centro', 'Sao Paulo',
   70.00, 8, 6, 2, 6, 0, 6, NULL, md5('maria-1')),
  ($E_TESTE, $IMPORT_ID, $ENT_MARIA, '2026-07-04', 'TURNO_INEXISTENTE_XYZ', '01:00:00', 'Centro', 'Sao Paulo',
   60.00, 5, 4, 1, 4, 0, 4, 500, md5('maria-2')),
  ($E_OUTRA, $IMPORT_ID_OUTRA, $ENT_OUTRA, '2026-07-01', 'ALMOCO 11H30-15H29', '03:00:00', 'Zona Norte', 'Rio',
   50.00, 10, 5, 5, 5, 0, 5, 999, md5('outra-1'));
SQL

# Fato dedicado a divisão por zero (Cenário 14, SC-009) — janela ISOLADA
# (2026-07-06): corridas_ofertadas=0 E corridas_aceitas=0 -> taxaAceitacao e
# taxaConclusao MUST ser null (NULLIF), nunca 0/1/exceção.
psql_t <<SQL >/dev/null
INSERT INTO "PerformanceTurno"
  (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca, praca,
   tempo_disponivel_pct, corridas_ofertadas, corridas_aceitas, corridas_rejeitadas,
   corridas_completadas, corridas_canceladas, pedidos_concluidos, taxas_centavos, hash_linha)
VALUES
  ($E_TESTE, $IMPORT_ID, $ENT_JOAO, '2026-07-06', 'ALMOCO 11H30-15H29', '03:00:00', 'Zona Sul', 'Sao Paulo',
   NULL, 0, 0, 0, 0, 0, 0, 0, md5('zero-denominador'));
SQL

# Papel sintético SEM performance.consultar (para o 403 de GET /resumo) —
# reusa o mesmo papel 'sem_performance_teste' (só dashboard.consultar).

# Fato dedicado a CSV injection (FASE 4/tasks.md 4.1.7, Cenário 8) — janela
# ISOLADA (2026-09-01): periodo começa com '=' (fórmula), entregador
# (`@Perigoso Nome`, seed acima) começa com '@'. Ambas as células MUST vir
# neutralizadas (prefixo `'`) no CSV exportado.
psql_t <<SQL >/dev/null
INSERT INTO "PerformanceTurno"
  (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca, praca,
   tempo_disponivel_pct, corridas_ofertadas, corridas_aceitas, corridas_rejeitadas,
   corridas_completadas, corridas_canceladas, pedidos_concluidos, taxas_centavos, hash_linha)
VALUES
  ($E_TESTE, $IMPORT_ID, $ENT_INJECAO, '2026-09-01', '=SOMA(A1:A10)', '02:00:00', 'Zona Sul', 'Sao Paulo',
   85.00, 5, 5, 0, 5, 0, 5, 7700, md5('injecao-1'));
SQL

# Fato dedicado ao gap CHK031 (tasks.md 4.2.2) — janela ISOLADA (2026-09-02):
# entregador (`'Ja Neutro Nome`, seed acima) já começa com apóstrofo. MUST
# vir com um ÚNICO apóstrofo no CSV (sem dupla neutralização).
psql_t <<SQL >/dev/null
INSERT INTO "PerformanceTurno"
  (id_empresa, importacao_id, entregador_id, data_periodo, periodo, duracao, subpraca, praca,
   tempo_disponivel_pct, corridas_ofertadas, corridas_aceitas, corridas_rejeitadas,
   corridas_completadas, corridas_canceladas, pedidos_concluidos, taxas_centavos, hash_linha)
VALUES
  ($E_TESTE, $IMPORT_ID, $ENT_JANEUTRO, '2026-09-02', 'ALMOCO 11H30-15H29', '02:00:00', 'Zona Sul', 'Sao Paulo',
   85.00, 5, 5, 0, 5, 0, 5, 100, md5('ja-neutro-1'));
SQL

# ─────────────────────────────────────────────────────────────────────────────
# Script Node único: login + troca de entidade + chamadas GET.
# ─────────────────────────────────────────────────────────────────────────────
OUT="$(run_node "$SENHA_OK" "$E_TESTE" "$E_OUTRA" "$E_SEM_PERM" "$ENT_JOAO" <<'JS'
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
  const entJoao = Number(process.argv[6]);
  const out = {};

  // ── sem autenticação: 401 ────────────────────────────────────────────────
  const rSemAuth = await getJson(null, '/performance');
  out.sem_auth_status = rSemAuth.status;

  // ── login leitura + entidade ativa ───────────────────────────────────────
  let jarLeitura = await login('performance-leitura@example.test', senha);
  jarLeitura = await trocarEntidade(jarLeitura, empresaTeste);

  // (b) lista básica — janela ampla cobrindo todo o seed
  const rLista = await getJson(jarLeitura, '/performance?de=2026-07-01&ate=2026-07-04');
  out.lista_status = rLista.status;
  out.lista_total = rLista.body && rLista.body.total;
  out.lista_items_len = rLista.body && rLista.body.items ? rLista.body.items.length : null;

  // (c) filtro combinado periodo+subpraca+data (Cenário 1) — só joao-1 (2026-07-01)
  const rCombinado = await getJson(jarLeitura, '/performance?de=2026-07-01&ate=2026-07-01&periodo=ALMOCO%2011H30-15H29&subpraca=Zona%20Sul');
  out.combinado_total = rCombinado.body && rCombinado.body.total;
  out.combinado_taxas = rCombinado.body && rCombinado.body.items[0] && rCombinado.body.items[0].taxas;

  // (d) paginação — pageSize=2, total já conhecido (4), page=2 tem 2 itens
  const rPag1 = await getJson(jarLeitura, '/performance?de=2026-07-01&ate=2026-07-04&pageSize=2&page=1');
  const rPag2 = await getJson(jarLeitura, '/performance?de=2026-07-01&ate=2026-07-04&pageSize=2&page=2');
  out.pag1_len = rPag1.body && rPag1.body.items.length;
  out.pag2_len = rPag2.body && rPag2.body.items.length;
  out.pag1_total = rPag1.body && rPag1.body.total;
  out.pag2_total = rPag2.body && rPag2.body.total;

  // (e) período sem dados — nunca erro (Cenário 6)
  const rVazio = await getJson(jarLeitura, '/performance?de=2020-01-01&ate=2020-01-31');
  out.vazio_status = rVazio.status;
  out.vazio_total = rVazio.body && rVazio.body.total;
  out.vazio_items_len = rVazio.body && rVazio.body.items ? rVazio.body.items.length : null;

  // (f) data inválida (formato) e de > ate
  const rDataInvalida = await getJson(jarLeitura, '/performance?de=2026-02-30');
  out.data_invalida_status = rDataInvalida.status;
  out.data_invalida_erro = rDataInvalida.body && rDataInvalida.body.erro;

  const rDeMaiorAte = await getJson(jarLeitura, '/performance?de=2026-07-10&ate=2026-07-01');
  out.de_maior_ate_status = rDeMaiorAte.status;
  out.de_maior_ate_erro = rDeMaiorAte.body && rDeMaiorAte.body.erro;

  // (g) entregadorId inválido
  const rEntregadorInvalido = await getJson(jarLeitura, '/performance?entregadorId=abc');
  out.entregador_invalido_status = rEntregadorInvalido.status;
  out.entregador_invalido_erro = rEntregadorInvalido.body && rEntregadorInvalido.body.erro;

  // (h) sem performance.listar
  let jarSemPerm = await login('performance-sempermissao@example.test', senha);
  jarSemPerm = await trocarEntidade(jarSemPerm, empresaSemPerm);
  const rSemPermissao = await getJson(jarSemPerm, '/performance');
  out.sem_permissao_status = rSemPermissao.status;
  out.sem_permissao_erro = rSemPermissao.body && rSemPermissao.body.erro;

  // (i) isolamento multi-tenant — troca para E_OUTRA, filtro amplo, nunca
  // vê o turno de E_TESTE
  let jarOutra = await trocarEntidade(jarLeitura, empresaOutra);
  const rOutra = await getJson(jarOutra, '/performance?de=2026-07-01&ate=2026-07-04');
  out.outra_total = rOutra.body && rOutra.body.total;
  out.outra_taxas = rOutra.body && rOutra.body.items[0] && rOutra.body.items[0].taxas;

  // (j) entregadorId/entregadorNome SEMPRE presentes (Decision 4)
  const primeiroItem = rLista.body && rLista.body.items && rLista.body.items[0];
  out.item_entregadorId_tipo = primeiroItem ? typeof primeiroItem.entregadorId : null;
  out.item_entregadorNome_null = primeiroItem ? String(primeiroItem.entregadorNome === null) : null;

  // (k) periodo fora dos 16 turnos documentados aparece normalmente (Edge Case)
  const rPeriodoLivre = await getJson(jarLeitura, '/performance?de=2026-07-04&ate=2026-07-04');
  out.periodoLivre_total = rPeriodoLivre.body && rPeriodoLivre.body.total;
  const itemLivre = rPeriodoLivre.body && rPeriodoLivre.body.items && rPeriodoLivre.body.items[0];
  out.periodoLivre_valor = itemLivre ? itemLivre.periodo : null;

  // ── GET /performance/resumo (FASE 3, tasks.md 3.1.6) ────────────────────

  // (l) cards sem groupBy — janela 2026-07-01..04, 4 linhas conhecidas.
  // corridasCompletadas=7+9+6+4=26; taxaAceitacao=(8+9+6+4)/(10+10+8+5)=
  // 27/33=0.8182 (SC-002: != média simples 0.8125 das taxas individuais);
  // taxaConclusao=26/27=0.9630; tempoDisponivelMedio ponderado=78.42;
  // taxasReais=(1000+2000+0+500)/100=35.00.
  const rCards = await getJson(jarLeitura, '/performance/resumo?de=2026-07-01&ate=2026-07-04');
  out.cards_status = rCards.status;
  out.cards_corridasCompletadas = rCards.body && rCards.body.corridasCompletadas;
  out.cards_taxaAceitacao = rCards.body && rCards.body.taxaAceitacao;
  out.cards_taxaConclusao = rCards.body && rCards.body.taxaConclusao;
  out.cards_tempoDisponivelMedio = rCards.body && rCards.body.tempoDisponivelMedio;
  out.cards_taxasReais = rCards.body && rCards.body.taxasReais;

  // (m) agrupado por dia — 4 dias distintos, soma de corridasCompletadas
  // bate com o total do card (Acceptance Scenario 2 / task 3.1.5)
  const rDia = await getJson(jarLeitura, '/performance/resumo?de=2026-07-01&ate=2026-07-04&groupBy=dia');
  out.dia_status = rDia.status;
  out.dia_groupBy = rDia.body && rDia.body.groupBy;
  out.dia_qtd_grupos = rDia.body && rDia.body.grupos ? rDia.body.grupos.length : null;
  out.dia_soma_completadas = rDia.body && rDia.body.grupos
    ? rDia.body.grupos.reduce((acc, g) => acc + Number(g.corridasCompletadas), 0)
    : null;

  // agrupado por periodo — 3 grupos (ALMOCO/JANTAR/TURNO_INEXISTENTE_XYZ)
  const rPeriodoGrp = await getJson(jarLeitura, '/performance/resumo?de=2026-07-01&ate=2026-07-04&groupBy=periodo');
  out.periodoGrp_qtd = rPeriodoGrp.body && rPeriodoGrp.body.grupos ? rPeriodoGrp.body.grupos.length : null;

  // agrupado por entregador — joao (nome via rótulo) + maria
  const rEntregadorGrp = await getJson(jarLeitura, '/performance/resumo?de=2026-07-01&ate=2026-07-04&groupBy=entregador');
  const gruposEnt = (rEntregadorGrp.body && rEntregadorGrp.body.grupos) || [];
  out.entregadorGrp_qtd = gruposEnt.length;
  const grupoJoao = gruposEnt.find((g) => g.chave === String(entJoao));
  out.entregadorGrp_rotuloJoao = grupoJoao ? grupoJoao.rotulo : null;

  // (n) divisão por zero (Cenário 14, SC-009) — janela isolada 2026-07-06
  const rZero = await getJson(jarLeitura, '/performance/resumo?de=2026-07-06&ate=2026-07-06');
  out.zero_taxaAceitacao = rZero.body ? String(rZero.body.taxaAceitacao) : null;
  out.zero_taxaConclusao = rZero.body ? String(rZero.body.taxaConclusao) : null;

  // (o) período vazio no resumo — cards zerados / grupos:[] (FR-011)
  const rCardsVazio = await getJson(jarLeitura, '/performance/resumo?de=2020-01-01&ate=2020-01-31');
  out.cardsVazio_status = rCardsVazio.status;
  out.cardsVazio_corridasCompletadas = rCardsVazio.body && rCardsVazio.body.corridasCompletadas;
  out.cardsVazio_taxaAceitacao = rCardsVazio.body ? String(rCardsVazio.body.taxaAceitacao) : null;
  out.cardsVazio_taxasReais = rCardsVazio.body && rCardsVazio.body.taxasReais;

  const rGrupoVazio = await getJson(jarLeitura, '/performance/resumo?de=2020-01-01&ate=2020-01-31&groupBy=dia');
  out.grupoVazio_status = rGrupoVazio.status;
  out.grupoVazio_len = rGrupoVazio.body && rGrupoVazio.body.grupos ? rGrupoVazio.body.grupos.length : null;

  // (p) groupBy inválido -> 400
  const rGroupByInvalido = await getJson(jarLeitura, '/performance/resumo?groupBy=turno');
  out.groupByInvalido_status = rGroupByInvalido.status;
  out.groupByInvalido_erro = rGroupByInvalido.body && rGroupByInvalido.body.erro;

  // (q) resumo sem performance.consultar -> 403 (mesmo papel sintético do teste (h))
  const rResumoSemPermissao = await getJson(jarSemPerm, '/performance/resumo');
  out.resumoSemPermissao_status = rResumoSemPermissao.status;

  // ── GET /performance?format=csv (FASE 4, tasks.md 4.1.7) ────────────────
  // Usuário DEDICADO com performance.exportar (papel admin_entidade) — o
  // jarLeitura ('leitura') NUNCA tem exportar (0029), usado só no cenário
  // negativo (u) abaixo.
  let jarExportador = await login('performance-exportador@example.test', senha);
  jarExportador = await trocarEntidade(jarExportador, empresaTeste);

  // (r) export completo bate contagem com a tela — janela 2026-07-01..04,
  // 4 linhas conhecidas (mesma janela do cenário 'lista básica' acima).
  const rCsv = await getCsv(jarExportador, '/performance?format=csv&de=2026-07-01&ate=2026-07-04');
  out.csv_status = rCsv.status;
  out.csv_contentType = rCsv.contentType;
  out.csv_contentDisposition = rCsv.contentDisposition;
  const csvLinhas = rCsv.text.split('\r\n').filter((l) => l.length > 0);
  out.csv_cabecalho = csvLinhas[0];
  out.csv_qtd_linhas_dados = csvLinhas.length - 1; // exclui cabeçalho

  // (s) CSV injection neutralizada — janela isolada 2026-09-01: periodo
  // '=SOMA(A1:A10)' e entregadorNome '@Perigoso Nome' MUST vir com prefixo
  // `'` (única ocorrência, sem dupla neutralização).
  const rCsvInjecao = await getCsv(jarExportador, '/performance?format=csv&de=2026-09-01&ate=2026-09-01');
  const linhasInjecao = rCsvInjecao.text.split('\r\n').filter((l) => l.length > 0);
  out.csvInjecao_linha_dados = linhasInjecao[1] || null;

  // (t) gap CHK031 (tasks.md 4.2.2) — janela isolada 2026-09-02: entregadorNome
  // "'Ja Neutro Nome" JÁ começa com apóstrofo -> MUST permanecer com um ÚNICO
  // apóstrofo no CSV (sem dupla neutralização).
  const rCsvJaNeutro = await getCsv(jarExportador, '/performance?format=csv&de=2026-09-02&ate=2026-09-02');
  const linhasJaNeutro = rCsvJaNeutro.text.split('\r\n').filter((l) => l.length > 0);
  out.csvJaNeutro_linha_dados = linhasJaNeutro[1] || null;

  // (u) export vazio — período sem nenhum turno -> só cabeçalho, 200 (4.1.6)
  const rCsvVazio = await getCsv(jarExportador, '/performance?format=csv&de=2019-01-01&ate=2019-01-02');
  out.csvVazio_status = rCsvVazio.status;
  const linhasVazio = rCsvVazio.text.split('\r\n').filter((l) => l.length > 0);
  out.csvVazio_qtd_linhas = linhasVazio.length; // só cabeçalho = 1

  // (v) 403 sem performance.exportar MESMO COM performance.listar — o próprio
  // jarLeitura (papel 'leitura': tem .listar/.consultar, NÃO tem .exportar
  // desde a 0029) — Cenário 10 passos 3-4 (bypass da UI).
  const rCsvSemExportar = await getCsv(jarLeitura, '/performance?format=csv&de=2026-07-01&ate=2026-07-04');
  out.csvSemExportar_status = rCsvSemExportar.status;
  let csvSemExportarErro = null;
  try { csvSemExportarErro = JSON.parse(rCsvSemExportar.text).erro; } catch { /* ignore */ }
  out.csvSemExportar_erro = csvSemExportarErro;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT" | grep -v '___RESULT_JSON___' || true
RESULT_LINE="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$RESULT_LINE" ] || { echo "FAIL: script Node não retornou resultado"; echo "$OUT"; exit 1; }
jget() { printf '%s' "$RESULT_LINE" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const v=d['$1']; process.stdout.write(v===null||v===undefined?'':String(v))"; }

check "GET /performance sem cookie -> 401" "$(jget sem_auth_status)" "401"
check "lista básica -> 200" "$(jget lista_status)" "200"
check "lista básica -> total=4 (joao-1, joao-2, maria-1, maria-2)" "$(jget lista_total)" "4"
check "lista básica -> items.length=4" "$(jget lista_items_len)" "4"
check "filtro combinado periodo+subpraca+data -> total=1" "$(jget combinado_total)" "1"
check "filtro combinado -> taxas='10.00' (string, 1000 centavos)" "$(jget combinado_taxas)" "10.00"
check "paginação pageSize=2 page=1 -> 2 itens" "$(jget pag1_len)" "2"
check "paginação pageSize=2 page=2 -> 2 itens" "$(jget pag2_len)" "2"
check "paginação -> total NÃO muda entre páginas (page=1)" "$(jget pag1_total)" "4"
check "paginação -> total NÃO muda entre páginas (page=2)" "$(jget pag2_total)" "4"
check "período sem dados -> 200 (FR-011, nunca erro)" "$(jget vazio_status)" "200"
check "período sem dados -> total=0" "$(jget vazio_total)" "0"
check "período sem dados -> items=[]" "$(jget vazio_items_len)" "0"
check "data inválida (2026-02-30) -> 400" "$(jget data_invalida_status)" "400"
check "data inválida -> erro=DATA_INVALIDA" "$(jget data_invalida_erro)" "DATA_INVALIDA"
check "de > ate -> 400" "$(jget de_maior_ate_status)" "400"
check "de > ate -> erro=DATA_INVALIDA" "$(jget de_maior_ate_erro)" "DATA_INVALIDA"
check "entregadorId inválido -> 400" "$(jget entregador_invalido_status)" "400"
check "entregadorId inválido -> erro=ENTREGADOR_ID_INVALIDO" "$(jget entregador_invalido_erro)" "ENTREGADOR_ID_INVALIDO"
check "sem performance.listar (papel sintético) -> 403" "$(jget sem_permissao_status)" "403"
check "sem permissão -> erro=PERMISSAO_NEGADA" "$(jget sem_permissao_erro)" "PERMISSAO_NEGADA"
check "isolamento multi-tenant: E_OUTRA não vê nada de E_TESTE (total=1, só o próprio)" "$(jget outra_total)" "1"
check "isolamento multi-tenant: taxas da única linha de E_OUTRA = '9.99'" "$(jget outra_taxas)" "9.99"
check "entregadorId sempre presente -> tipo number (Decision 4)" "$(jget item_entregadorId_tipo)" "number"
check "entregadorNome sempre presente -> nunca null (Decision 4)" "$(jget item_entregadorNome_null)" "false"
check "periodo fora dos 16 turnos documentados -> total=1 (Edge Case)" "$(jget periodoLivre_total)" "1"
check "periodo fora dos 16 turnos documentados -> texto livre preservado" "$(jget periodoLivre_valor)" "TURNO_INEXISTENTE_XYZ"

# ── GET /performance/resumo (FASE 3, tasks.md 3.1.6) ────────────────────────
check "resumo cards -> 200" "$(jget cards_status)" "200"
check "resumo cards -> corridasCompletadas=26 (7+9+6+4)" "$(jget cards_corridasCompletadas)" "26"
check "resumo cards -> taxaAceitacao=0.8182 (razão de somas 27/33, SC-002: != média simples 0.8125)" "$(jget cards_taxaAceitacao)" "0.8182"
check "resumo cards -> taxaConclusao=0.9630 (26/27)" "$(jget cards_taxaConclusao)" "0.9630"
check "resumo cards -> tempoDisponivelMedio=78.42 (ponderado por duracao)" "$(jget cards_tempoDisponivelMedio)" "78.42"
check "resumo cards -> taxasReais=35.00 ((1000+2000+0+500)/100)" "$(jget cards_taxasReais)" "35.00"

check "resumo agrupado por dia -> 200" "$(jget dia_status)" "200"
check "resumo agrupado por dia -> groupBy='dia' ecoado" "$(jget dia_groupBy)" "dia"
check "resumo agrupado por dia -> 4 grupos (4 dias distintos)" "$(jget dia_qtd_grupos)" "4"
check "resumo agrupado por dia -> soma de corridasCompletadas bate com o card (26, task 3.1.5)" "$(jget dia_soma_completadas)" "26"

check "resumo agrupado por periodo -> 3 grupos (ALMOCO/JANTAR/TURNO_INEXISTENTE_XYZ)" "$(jget periodoGrp_qtd)" "3"

check "resumo agrupado por entregador -> 2 grupos (joao+maria)" "$(jget entregadorGrp_qtd)" "2"
check "resumo agrupado por entregador -> rótulo do joao = nome (join Entregador)" "$(jget entregadorGrp_rotuloJoao)" "Joao Performance"

check "divisão por zero (Cenário 14/SC-009): taxaAceitacao=null (nunca 0/1/exceção)" "$(jget zero_taxaAceitacao)" "null"
check "divisão por zero (Cenário 14/SC-009): taxaConclusao=null" "$(jget zero_taxaConclusao)" "null"

check "resumo cards período vazio -> 200 (FR-011, nunca erro)" "$(jget cardsVazio_status)" "200"
check "resumo cards período vazio -> corridasCompletadas=0" "$(jget cardsVazio_corridasCompletadas)" "0"
check "resumo cards período vazio -> taxaAceitacao=null" "$(jget cardsVazio_taxaAceitacao)" "null"
check "resumo cards período vazio -> taxasReais='0.00'" "$(jget cardsVazio_taxasReais)" "0.00"
check "resumo agrupado período vazio -> 200" "$(jget grupoVazio_status)" "200"
check "resumo agrupado período vazio -> grupos=[]" "$(jget grupoVazio_len)" "0"

check "resumo groupBy inválido ('turno', não é 'periodo' — Decision 12) -> 400" "$(jget groupByInvalido_status)" "400"
check "resumo groupBy inválido -> erro=GROUP_BY_INVALIDO" "$(jget groupByInvalido_erro)" "GROUP_BY_INVALIDO"

check "resumo sem performance.consultar (papel sintético) -> 403" "$(jget resumoSemPermissao_status)" "403"

# ── GET /performance?format=csv (FASE 4, tasks.md 4.1.7/4.2) ────────────────
check "export CSV -> 200" "$(jget csv_status)" "200"
check "export CSV -> Content-Type text/csv; charset=utf-8" "$(jget csv_contentType)" "text/csv; charset=utf-8"
check "export CSV -> Content-Disposition com nome de arquivo esperado" "$(jget csv_contentDisposition)" 'attachment; filename="performance-2026-07-01_2026-07-04.csv"'
check "export CSV -> cabeçalho fixo do contrato" "$(jget csv_cabecalho)" "dataPeriodo,periodo,entregadorNome,subpraca,praca,corridasOfertadas,corridasAceitas,corridasRejeitadas,corridasCompletadas,corridasCanceladas,pedidosConcluidos,tempoDisponivelPct,taxas"
check "export CSV -> 4 linhas de dados (bate com a tela, mesma janela)" "$(jget csv_qtd_linhas_dados)" "4"

check "export CSV injection -> periodo '=' e entregadorNome '@' neutralizados (prefixo único ')" \
  "$(jget csvInjecao_linha_dados)" "2026-09-01,'=SOMA(A1:A10),'@Perigoso Nome,Zona Sul,Sao Paulo,5,5,0,5,0,5,85,77.00"

check "export CSV gap CHK031 -> entregadorNome já iniciado por apóstrofo permanece com prefixo ÚNICO (sem dupla neutralização)" \
  "$(jget csvJaNeutro_linha_dados)" "2026-09-02,ALMOCO 11H30-15H29,'Ja Neutro Nome,Zona Sul,Sao Paulo,5,5,0,5,0,5,85,1.00"

check "export CSV vazio -> 200 (tasks.md 4.1.6, nunca erro)" "$(jget csvVazio_status)" "200"
check "export CSV vazio -> só a linha de cabeçalho" "$(jget csvVazio_qtd_linhas)" "1"

check "export CSV sem performance.exportar (só .listar) -> 403 (Cenário 10 passos 3-4, bypass da UI)" "$(jget csvSemExportar_status)" "403"
check "export CSV sem performance.exportar -> erro=PERMISSAO_NEGADA" "$(jget csvSemExportar_erro)" "PERMISSAO_NEGADA"

# ── Validação no banco: auditoria 'performance.csv_exportado' registrada
# (4.1.5) só para os exports BEM-SUCEDIDOS (r/s/t/u = 4), NUNCA para o 403 (v)
N_AUDITORIA_CSV="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='performance.csv_exportado' AND id_empresa=$E_TESTE" | tr -d '[:space:]')"
check "DB: Auditoria 'performance.csv_exportado' registrada 4x (só nos exports bem-sucedidos)" "$N_AUDITORIA_CSV" "4"

echo
if [ "$fails" = "0" ]; then
  echo "HUB-PERFORMANCE-INTEGRATION: OK — todos os asserts passaram (FASE 2/3/4: 2.2.5/3.1.6/4.1.7/4.2.2)"
else
  echo "HUB-PERFORMANCE-INTEGRATION: $fails assert(s) FALHARAM" >&2
  exit 1
fi

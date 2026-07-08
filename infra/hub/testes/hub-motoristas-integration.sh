#!/usr/bin/env bash
# =============================================================================
# hub-motoristas-integration.sh — tasks.md FASE 3 (3.1.6/3.2.4): prova E2E de
# GET /api/v1/motoristas e GET /api/v1/motoristas/:id contra um projeto
# hub-test EFÊMERO e descartável. Mesmo padrão de isolamento de
# infra/hub/testes/hub-importacoes-integration.sh — nunca toca
# chatmasterveloz/produção.
#
# Cobre:
#   (a) sem autenticação -> 401
#   (b) GET /motoristas sem filtro -> lista com paginação correta, `areas`
#       populada corretamente por linha
#   (c) filtro `nome` SEM acento casando Entregador com nome COM acento
#       (prova de tolerância a acento, `hub-motoristas-dto.js#nomeCasa`)
#   (d) filtro `ativo=false` só retorna o inativo
#   (e) filtro `comVinculo=true`/`false`
#   (f) filtro `area=<subpraca>` retorna só quem tem aquela área
#   (g) usuário de OUTRA id_empresa não vê os Entregadores do tenant de teste
#       (isolamento multi-tenant)
#   (h) GET /motoristas/:id happy path (resumo, areas DESC, vinculo mascarado)
#   (i) GET /motoristas/:id sem motorista_id -> vinculo: null, sem erro
#   (j) GET /motoristas/:id sem nenhum fato associado -> resumo zerado,
#       areas: [], sem erro
#   (k) GET /motoristas/:id fora do escopo (outro tenant) -> 404
#   (l) GET /motoristas/:id inexistente -> 404
#
# FASE 4 (task 4.1) — PATCH /motoristas/:id:
#   (m) PATCH nome -> 200, persiste, seta nomeEditadoManualmente=true,
#       histórico (resumo) intacto (FR-004)
#   (n) PATCH ativo (só situação) -> 200, persiste, NÃO seta
#       nomeEditadoManualmente nem toca nome
#   (o) PATCH nome vazio/só espaços -> 422; corpo sem nenhum campo -> 422
#   (p) PATCH sem permissão `motoristas.editar` (usuário de leitura) -> 403
#   (q) PATCH em Entregador fora do escopo (outro tenant) -> 404
#   (r) PATCH em id inexistente -> 404
#   (s) PATCH com campo fora da allowlist (`motoristaId`) -> 200, campo
#       IGNORADO (nunca chega ao PostgREST, sem efeito colateral no vínculo)
#   Cenário 4: nome editado manualmente sobrevive a um UPDATE de
#     reimportação subsequente (trigger 0019, hub_protege_nome_editado_entregador)
#
# Uso: infra/hub/testes/hub-motoristas-integration.sh
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

echo "rodando migrate.sh (0002..0024)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0024_areas_por_entregador.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas por completo (0024 ausente)"; cat "$TMP/migrate.log"; exit 1; }

echo "confirmando view hub_areas_por_entregador existe e responde vazia (tabelas de fato ainda vazias neste estágio)…"
VIEW_COUNT="$(psql_t -tAc "SELECT count(*) FROM hub_areas_por_entregador" 2>"$TMP/view-check.log" | tr -d '[:space:]')"
[ "$VIEW_COUNT" = "0" ] || { echo "FAIL: view hub_areas_por_entregador não respondeu 0 (obtido='$VIEW_COUNT')"; cat "$TMP/view-check.log"; exit 1; }
echo "PASS: view hub_areas_por_entregador existe e retorna 0 linhas sem erro"

# --- Seed: 2 Usuarios (leitura com motoristas.listar/consultar; papel SEM
# essas permissões, para o teste bônus de 403) ---------------------------
SENHA_OK='SenhaSinteticaMotoristas#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

E_TESTE=940001
E_OUTRA=940002
E_SEM_PERM=940003

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('motoristas-leitura@example.test', '$HASH_OK', 'Usuario Teste Motoristas Leitura', true),
  ('motoristas-sempermissao@example.test', '$HASH_OK', 'Usuario Teste Motoristas Sem Permissao', true),
  ('motoristas-editor@example.test', '$HASH_OK', 'Usuario Teste Motoristas Editor', true);
SQL
UID_LEITURA="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='motoristas-leitura@example.test'" | tr -d '[:space:]')"
UID_SEMPERM="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='motoristas-sempermissao@example.test'" | tr -d '[:space:]')"
UID_EDITOR="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='motoristas-editor@example.test'" | tr -d '[:space:]')"
PAPEL_LEITURA="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='leitura'" | tr -d '[:space:]')"
[ -n "$PAPEL_LEITURA" ] || { echo "FAIL: seed 0007 não populou o papel 'leitura' esperado"; exit 1; }
# 'operador' concede motoristas.editar (0007); 'leitura' NÃO — usado abaixo
# para o teste bônus 403 de PATCH com o MESMO usuário de leitura já criado.
PAPEL_OPERADOR="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='operador'" | tr -d '[:space:]')"
[ -n "$PAPEL_OPERADOR" ] || { echo "FAIL: seed 0007 não populou o papel 'operador' esperado"; exit 1; }

# Papel sintético SEM motoristas.listar/consultar (os 4 papéis-seed de 0007 —
# admin_plataforma/admin_entidade/operador/leitura — TODOS concedem
# motoristas.consultar/listar; para o teste bônus de 403 é preciso um papel
# próprio, is_sistema=false, restrito a uma permissão fora do módulo).
psql_t <<SQL >/dev/null
INSERT INTO "Papel" (nome, escopo, is_sistema) VALUES ('sem_motoristas_teste', 'entidade', false)
ON CONFLICT (nome) DO NOTHING;
INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id FROM "Papel" p, "Permissao" perm
WHERE p.nome = 'sem_motoristas_teste' AND perm.codigo = 'dashboard.consultar'
ON CONFLICT DO NOTHING;
SQL
PAPEL_SEM_PERM="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='sem_motoristas_teste'" | tr -d '[:space:]')"

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_LEITURA, $E_TESTE, $PAPEL_LEITURA, true),
  ($UID_LEITURA, $E_OUTRA, $PAPEL_LEITURA, true),
  ($UID_SEMPERM, $E_SEM_PERM, $PAPEL_SEM_PERM, true),
  ($UID_EDITOR, $E_TESTE, $PAPEL_OPERADOR, true);
SQL

# --- Seed: ContaMotorista + Entregadores + fatos (INSERT direto via psql,
# sem depender de gen-seeds.py) --------------------------------------------
psql_t <<SQL >/dev/null
INSERT INTO "ContaMotorista" (cnpj_prestador, nome, ativo, cadastro_completo)
VALUES ('12345678000195', 'Carlos Pereira', true, true)
ON CONFLICT (cnpj_prestador) DO NOTHING;
SQL
CONTA_ID="$(psql_t -tAc "SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='12345678000195'" | tr -d '[:space:]')"
[ -n "$CONTA_ID" ] || { echo "FAIL: ContaMotorista de teste não foi criada"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "Entregador" (id_empresa, id_externo, nome, ativo, motorista_id) VALUES
  ($E_TESTE, gen_random_uuid(), 'José da Silva', true, NULL),
  ($E_TESTE, gen_random_uuid(), 'Maria Santos', false, NULL),
  ($E_TESTE, gen_random_uuid(), 'Carlos Pereira', true, $CONTA_ID),
  ($E_TESTE, gen_random_uuid(), 'Ana Costa', true, NULL),
  ($E_OUTRA, gen_random_uuid(), 'Entregador De Outro Tenant', true, NULL);
SQL
ENT_JOSE="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_TESTE AND nome='José da Silva'" | tr -d '[:space:]')"
ENT_MARIA="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_TESTE AND nome='Maria Santos'" | tr -d '[:space:]')"
ENT_CARLOS="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_TESTE AND nome='Carlos Pereira'" | tr -d '[:space:]')"
ENT_ANA="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_TESTE AND nome='Ana Costa'" | tr -d '[:space:]')"
ENT_OUTRA="$(psql_t -tAc "SELECT id FROM \"Entregador\" WHERE id_empresa=$E_OUTRA" | tr -d '[:space:]')"
for v in ENT_JOSE ENT_MARIA ENT_CARLOS ENT_ANA ENT_OUTRA; do
  [ -n "${!v}" ] || { echo "FAIL: $v não foi criado"; exit 1; }
done

# Importação-cabeçalho fake (FK obrigatória de Faturamento/Performance) —
# nunca processada de verdade, só ancora as linhas de fato.
psql_t <<SQL >/dev/null
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, nome_arquivo, hash_sha256, tamanho_bytes, status)
VALUES ($E_TESTE, 'faturamento', 'seed-teste.csv', repeat('a', 64), 10, 'completed_with_errors')
ON CONFLICT DO NOTHING;
SQL
IMPORT_ID="$(psql_t -tAc "SELECT id FROM \"ImportacaoArquivo\" WHERE id_empresa=$E_TESTE AND nome_arquivo='seed-teste.csv'" | tr -d '[:space:]')"
[ -n "$IMPORT_ID" ] || { echo "FAIL: ImportacaoArquivo de teste não foi criada"; exit 1; }

# Fatos: José (sem vínculo) com 2 áreas -> prova ordenação DESC/filtro area.
# Carlos (vinculado) com 2 áreas (faturamento+performance) -> prova resumo
# all-time e MAX por subpraça agregando as duas tabelas. Maria/Ana sem fatos.
psql_t <<SQL >/dev/null
INSERT INTO "FaturamentoLancamento"
  (id_empresa, importacao_id, entregador_id, data_lancamento, data_referencia, subpraca, tipo, valor, descricao, hash_linha)
VALUES
  ($E_TESTE, $IMPORT_ID, $ENT_JOSE,   '2026-07-01', '2026-07-01', 'Zona Sul', 'repasse', 100.00, 'seed', md5('jose-1')),
  ($E_TESTE, $IMPORT_ID, $ENT_JOSE,   '2026-05-14', '2026-05-14', 'Centro',   'repasse', 50.00,  'seed', md5('jose-2')),
  ($E_TESTE, $IMPORT_ID, $ENT_CARLOS, '2026-06-10', '2026-06-10', 'Zona Sul', 'repasse', 80.00,  'seed', md5('carlos-1')),
  ($E_TESTE, $IMPORT_ID, $ENT_CARLOS, '2026-06-20', '2026-06-20', 'Zona Sul', 'repasse', 90.00,  'seed', md5('carlos-2')),
  ($E_TESTE, $IMPORT_ID, $ENT_CARLOS, '2026-01-01', '2026-01-01', 'Centro',   'repasse', 30.00,  'seed', md5('carlos-3'));
SQL

psql_t <<SQL >/dev/null
INSERT INTO "PerformanceTurno"
  (id_empresa, importacao_id, entregador_id, data_periodo, periodo, subpraca, hash_linha)
VALUES
  ($E_TESTE, $IMPORT_ID, $ENT_CARLOS, '2026-06-25', 'manha', 'Zona Sul', md5('carlos-perf-1'));
SQL

# ─────────────────────────────────────────────────────────────────────────────
# Script Node único: login + troca de entidade + chamadas GET.
# ─────────────────────────────────────────────────────────────────────────────
OUT="$(run_node "$SENHA_OK" "$E_TESTE" "$E_OUTRA" "$E_SEM_PERM" "$ENT_JOSE" "$ENT_MARIA" "$ENT_CARLOS" "$ENT_ANA" "$ENT_OUTRA" <<'JS'
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
async function patchJson(jar, path, corpo) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
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
  const empresaSemPerm = Number(process.argv[5]);
  const entJose = Number(process.argv[6]);
  const entMaria = Number(process.argv[7]);
  const entCarlos = Number(process.argv[8]);
  const entAna = Number(process.argv[9]);
  const entOutra = Number(process.argv[10]);
  const out = {};

  // (a) sem autenticação -> 401
  const rSemAuth = await getJson(null, '/motoristas');
  out.sem_auth_status = rSemAuth.status;

  let jar = await login('motoristas-leitura@example.test', senha);
  jar = await trocarEntidade(jar, empresaTeste);

  // (b) lista sem filtro -> 4 entregadores do tenant de teste
  const rLista = await getJson(jar, '/motoristas');
  out.lista_status = rLista.status;
  out.lista_total = rLista.body && rLista.body.total;
  out.lista_page = rLista.body && rLista.body.page;
  out.lista_pageSize = rLista.body && rLista.body.pageSize;
  const itemCarlos = rLista.body && rLista.body.items.find((i) => i.id === entCarlos);
  out.lista_carlos_areas = itemCarlos ? JSON.stringify(itemCarlos.areas.slice().sort()) : null;
  out.lista_carlos_comVinculo = itemCarlos ? itemCarlos.comVinculo : null;
  const itemJose = rLista.body && rLista.body.items.find((i) => i.id === entJose);
  out.lista_jose_areas = itemJose ? JSON.stringify(itemJose.areas.slice().sort()) : null;
  out.lista_jose_comVinculo = itemJose ? itemJose.comVinculo : null;

  // (c) filtro nome SEM acento casa "José da Silva"
  const rNome = await getJson(jar, '/motoristas?nome=jose');
  out.nome_status = rNome.status;
  out.nome_total = rNome.body && rNome.body.total;
  out.nome_achou_jose = rNome.body && rNome.body.items.some((i) => i.id === entJose) ? 'true' : 'false';

  // (d) filtro ativo=false -> só Maria
  const rAtivoFalse = await getJson(jar, '/motoristas?ativo=false');
  out.ativo_false_status = rAtivoFalse.status;
  out.ativo_false_total = rAtivoFalse.body && rAtivoFalse.body.total;
  out.ativo_false_id_unico = rAtivoFalse.body && rAtivoFalse.body.items.length === 1 ? rAtivoFalse.body.items[0].id : null;

  // (e) comVinculo=true/false
  const rComVinculoTrue = await getJson(jar, '/motoristas?comVinculo=true');
  out.comvinculo_true_total = rComVinculoTrue.body && rComVinculoTrue.body.total;
  out.comvinculo_true_so_carlos = rComVinculoTrue.body && rComVinculoTrue.body.items.length === 1 && rComVinculoTrue.body.items[0].id === entCarlos ? 'true' : 'false';

  const rComVinculoFalse = await getJson(jar, '/motoristas?comVinculo=false');
  out.comvinculo_false_total = rComVinculoFalse.body && rComVinculoFalse.body.total;
  out.comvinculo_false_sem_carlos = rComVinculoFalse.body && !rComVinculoFalse.body.items.some((i) => i.id === entCarlos) ? 'true' : 'false';

  // (f) filtro area=Centro -> José e Carlos (não Maria/Ana)
  const rArea = await getJson(jar, '/motoristas?area=Centro');
  out.area_status = rArea.status;
  out.area_total = rArea.body && rArea.body.total;
  const idsArea = (rArea.body && rArea.body.items.map((i) => i.id)) || [];
  out.area_tem_jose = idsArea.includes(entJose) ? 'true' : 'false';
  out.area_tem_carlos = idsArea.includes(entCarlos) ? 'true' : 'false';
  out.area_tem_maria = idsArea.includes(entMaria) ? 'true' : 'false';
  out.area_tem_ana = idsArea.includes(entAna) ? 'true' : 'false';

  // (g) isolamento: mesmo usuário, troca para OUTRA entidade -> não vê os
  // Entregadores do tenant de teste (só o próprio, se algum).
  const jarOutra = await trocarEntidade(jar, empresaOutra);
  const rListaOutra = await getJson(jarOutra, '/motoristas');
  out.isolamento_status = rListaOutra.status;
  const idsOutra = (rListaOutra.body && rListaOutra.body.items.map((i) => i.id)) || [];
  out.isolamento_nao_vaza = idsOutra.includes(entJose) || idsOutra.includes(entCarlos) ? 'false' : 'true';
  out.isolamento_ve_proprio = idsOutra.includes(entOutra) ? 'true' : 'false';

  // detalhe: fora do escopo (Entregador do tenant de teste, visto pela
  // entidade OUTRA ativa) -> 404
  const rDetalheForaEscopo = await getJson(jarOutra, `/motoristas/${entJose}`);
  out.detalhe_fora_escopo_status = rDetalheForaEscopo.status;

  // (h) detalhe happy path — Carlos (vinculado, com fatos)
  const rDetalheCarlos = await getJson(jar, `/motoristas/${entCarlos}`);
  out.detalhe_carlos_status = rDetalheCarlos.status;
  const dCarlos = rDetalheCarlos.body || {};
  out.detalhe_carlos_totalFaturamento = dCarlos.resumo && dCarlos.resumo.totalFaturamento;
  out.detalhe_carlos_totalPerformance = dCarlos.resumo && dCarlos.resumo.totalPerformance;
  out.detalhe_carlos_dataMaisRecente = dCarlos.resumo && dCarlos.resumo.dataMaisRecente;
  out.detalhe_carlos_areas_ordem = dCarlos.areas ? JSON.stringify(dCarlos.areas.map((a) => a.subpraca)) : null;
  out.detalhe_carlos_vinculo_nome = dCarlos.vinculo && dCarlos.vinculo.nome;
  out.detalhe_carlos_vinculo_cnpj = dCarlos.vinculo && dCarlos.vinculo.cnpjPrestadorMascarado;

  // (i) detalhe sem vínculo — José
  const rDetalheJose = await getJson(jar, `/motoristas/${entJose}`);
  out.detalhe_jose_status = rDetalheJose.status;
  out.detalhe_jose_vinculo = rDetalheJose.body ? rDetalheJose.body.vinculo : 'ERRO';

  // (j) detalhe sem nenhum fato associado — Ana
  const rDetalheAna = await getJson(jar, `/motoristas/${entAna}`);
  out.detalhe_ana_status = rDetalheAna.status;
  const dAna = rDetalheAna.body || {};
  out.detalhe_ana_totalFaturamento = dAna.resumo && dAna.resumo.totalFaturamento;
  out.detalhe_ana_totalPerformance = dAna.resumo && dAna.resumo.totalPerformance;
  out.detalhe_ana_dataMaisRecente = dAna.resumo && dAna.resumo.dataMaisRecente;
  out.detalhe_ana_areas = dAna.areas ? JSON.stringify(dAna.areas) : null;
  out.detalhe_ana_vinculo = dAna.vinculo === null ? 'null' : JSON.stringify(dAna.vinculo);

  // (k) detalhe fora do escopo (outro tenant) -> 404 (já coberto acima em
  // detalhe_fora_escopo_status, repetido aqui com nome mais explícito)
  const rDetalheOutroTenant = await getJson(jarOutra, `/motoristas/${entCarlos}`);
  out.detalhe_outro_tenant_status = rDetalheOutroTenant.status;

  // (l) detalhe id inexistente -> 404
  const rDetalheInexistente = await getJson(jar, '/motoristas/999999999');
  out.detalhe_inexistente_status = rDetalheInexistente.status;

  // bônus: usuário sem motoristas.listar/consultar -> 403
  let jarSemPerm = await login('motoristas-sempermissao@example.test', senha);
  jarSemPerm = await trocarEntidade(jarSemPerm, empresaSemPerm);
  const rSemPermLista = await getJson(jarSemPerm, '/motoristas');
  out.sem_permissao_lista_status = rSemPermLista.status;
  const rSemPermDetalhe = await getJson(jarSemPerm, `/motoristas/${entJose}`);
  out.sem_permissao_detalhe_status = rSemPermDetalhe.status;

  // ── FASE 4 (task 4.1) — PATCH /motoristas/:id ───────────────────────────
  let jarEditor = await login('motoristas-editor@example.test', senha);
  jarEditor = await trocarEntidade(jarEditor, empresaTeste);

  // (m) PATCH nome -> 200, nome atualizado, nomeEditadoManualmente=true
  const rPatchNome = await patchJson(jarEditor, `/motoristas/${entAna}`, { nome: 'Ana Costa Editada' });
  out.patch_nome_status = rPatchNome.status;
  out.patch_nome_valor = rPatchNome.body && rPatchNome.body.nome;
  out.patch_nome_editado_manualmente = rPatchNome.body && rPatchNome.body.nomeEditadoManualmente;
  // histórico intacto: resumo/areas de Ana continuam zerados (PATCH não toca fatos)
  out.patch_nome_resumo_intacto = rPatchNome.body && rPatchNome.body.resumo
    && rPatchNome.body.resumo.totalFaturamento === 0 && rPatchNome.body.resumo.totalPerformance === 0 ? 'true' : 'false';

  // (n) PATCH ativo (só situação, sem tocar nome) -> 200, nomeEditadoManualmente NÃO muda
  const rPatchAtivo = await patchJson(jarEditor, `/motoristas/${entMaria}`, { ativo: true });
  out.patch_ativo_status = rPatchAtivo.status;
  out.patch_ativo_valor = rPatchAtivo.body && rPatchAtivo.body.ativo;
  out.patch_ativo_nome_inalterado = rPatchAtivo.body && rPatchAtivo.body.nome === 'Maria Santos' ? 'true' : 'false';
  out.patch_ativo_nome_editado_manualmente = rPatchAtivo.body && rPatchAtivo.body.nomeEditadoManualmente;

  // (o) PATCH nome vazio -> 422
  const rPatchInvalido = await patchJson(jarEditor, `/motoristas/${entJose}`, { nome: '   ' });
  out.patch_invalido_status = rPatchInvalido.status;

  // (o.bis) PATCH corpo vazio (nenhum campo) -> 422
  const rPatchVazio = await patchJson(jarEditor, `/motoristas/${entJose}`, {});
  out.patch_vazio_status = rPatchVazio.status;

  // (p) PATCH sem permissão motoristas.editar (usuário de leitura) -> 403
  const rPatchSemPerm = await patchJson(jar, `/motoristas/${entJose}`, { nome: 'Tentativa Nao Autorizada' });
  out.patch_sem_permissao_status = rPatchSemPerm.status;

  // (q) PATCH em Entregador fora do escopo (do outro tenant) -> 404
  const rPatchForaEscopo = await patchJson(jarEditor, `/motoristas/${entOutra}`, { nome: 'Nao Deveria Editar' });
  out.patch_fora_escopo_status = rPatchForaEscopo.status;

  // (r) PATCH em id inexistente -> 404
  const rPatchInexistente = await patchJson(jarEditor, '/motoristas/999999999', { nome: 'X' });
  out.patch_inexistente_status = rPatchInexistente.status;

  // (s) mass-assignment: campos fora da allowlist são ignorados (200, nome
  // persiste, sem efeito colateral) — usa José (nome_editado_manualmente
  // ainda `false` neste ponto: os PATCHs anteriores sobre ele foram 422/403,
  // nenhum tocou o banco) para não conflitar com o Cenário 4 abaixo, que
  // precisa de Ana com EXATAMENTE 1 edição manual prévia (trigger 0019 só
  // protege a partir da 2ª escrita — reeditar de novo aqui reproduziria o
  // mesmo efeito de um "reimport" sobre a própria Ana, poluindo o cenário).
  const rPatchMassAssign = await patchJson(jarEditor, `/motoristas/${entJose}`, { nome: 'Jose Mass Assign', motoristaId: 999999 });
  out.patch_mass_assign_status = rPatchMassAssign.status;
  out.patch_mass_assign_nome = rPatchMassAssign.body && rPatchMassAssign.body.nome;
  out.patch_mass_assign_sem_vinculo = rPatchMassAssign.body && rPatchMassAssign.body.vinculo === null ? 'true' : 'false';

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT" | grep -v '___RESULT_JSON___' || true
RESULT_LINE="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$RESULT_LINE" ] || { echo "FAIL: script Node não retornou resultado"; echo "$OUT"; exit 1; }
jget() { printf '%s' "$RESULT_LINE" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const v=d['$1']; process.stdout.write(v===null?'null':v===undefined?'undefined':String(v))"; }

check "GET /motoristas sem cookie -> 401" "$(jget sem_auth_status)" "401"

check "lista sem filtro -> 200" "$(jget lista_status)" "200"
check "lista sem filtro -> total=4 (José/Maria/Carlos/Ana)" "$(jget lista_total)" "4"
check "lista sem filtro -> page=1" "$(jget lista_page)" "1"
check "lista sem filtro -> pageSize=20 (default)" "$(jget lista_pageSize)" "20"
check "lista -> Carlos.areas=[Centro,Zona Sul] (ordenado alfabeticamente p/ comparação)" "$(jget lista_carlos_areas)" '["Centro","Zona Sul"]'
check "lista -> Carlos.comVinculo=true" "$(jget lista_carlos_comVinculo)" "true"
check "lista -> José.areas=[Centro,Zona Sul]" "$(jget lista_jose_areas)" '["Centro","Zona Sul"]'
check "lista -> José.comVinculo=false" "$(jget lista_jose_comVinculo)" "false"

check "filtro nome=jose (sem acento) -> 200" "$(jget nome_status)" "200"
check "filtro nome=jose -> total=1" "$(jget nome_total)" "1"
check "filtro nome=jose -> encontra 'José da Silva' (tolerância a acento)" "$(jget nome_achou_jose)" "true"

check "filtro ativo=false -> 200" "$(jget ativo_false_status)" "200"
check "filtro ativo=false -> total=1 (só Maria)" "$(jget ativo_false_total)" "1"

check "filtro comVinculo=true -> total=1 (só Carlos)" "$(jget comvinculo_true_total)" "1"
check "filtro comVinculo=true -> item único é Carlos" "$(jget comvinculo_true_so_carlos)" "true"
check "filtro comVinculo=false -> total=3 (José/Maria/Ana)" "$(jget comvinculo_false_total)" "3"
check "filtro comVinculo=false -> não inclui Carlos" "$(jget comvinculo_false_sem_carlos)" "true"

check "filtro area=Centro -> 200" "$(jget area_status)" "200"
check "filtro area=Centro -> total=2 (José+Carlos)" "$(jget area_total)" "2"
check "filtro area=Centro -> inclui José" "$(jget area_tem_jose)" "true"
check "filtro area=Centro -> inclui Carlos" "$(jget area_tem_carlos)" "true"
check "filtro area=Centro -> NÃO inclui Maria" "$(jget area_tem_maria)" "false"
check "filtro area=Centro -> NÃO inclui Ana" "$(jget area_tem_ana)" "false"

check "isolamento multi-tenant -> 200" "$(jget isolamento_status)" "200"
check "isolamento multi-tenant -> não vaza Entregadores do outro tenant" "$(jget isolamento_nao_vaza)" "true"
check "isolamento multi-tenant -> vê o próprio Entregador da entidade ativa" "$(jget isolamento_ve_proprio)" "true"
check "detalhe de Entregador fora do escopo -> 404" "$(jget detalhe_fora_escopo_status)" "404"

check "detalhe Carlos (happy path) -> 200" "$(jget detalhe_carlos_status)" "200"
check "detalhe Carlos -> resumo.totalFaturamento=3" "$(jget detalhe_carlos_totalFaturamento)" "3"
check "detalhe Carlos -> resumo.totalPerformance=1" "$(jget detalhe_carlos_totalPerformance)" "1"
check "detalhe Carlos -> resumo.dataMaisRecente=2026-06-25 (max entre fatur/perf)" "$(jget detalhe_carlos_dataMaisRecente)" "2026-06-25"
check "detalhe Carlos -> areas ordenadas DESC ([Zona Sul, Centro])" "$(jget detalhe_carlos_areas_ordem)" '["Zona Sul","Centro"]'
check "detalhe Carlos -> vinculo.nome" "$(jget detalhe_carlos_vinculo_nome)" "Carlos Pereira"
check "detalhe Carlos -> vinculo.cnpjPrestadorMascarado" "$(jget detalhe_carlos_vinculo_cnpj)" "12.***.***/0001-**"

check "detalhe José (sem vínculo) -> 200" "$(jget detalhe_jose_status)" "200"
check "detalhe José -> vinculo=null" "$(jget detalhe_jose_vinculo)" "null"

check "detalhe Ana (sem nenhum fato) -> 200" "$(jget detalhe_ana_status)" "200"
check "detalhe Ana -> resumo.totalFaturamento=0" "$(jget detalhe_ana_totalFaturamento)" "0"
check "detalhe Ana -> resumo.totalPerformance=0" "$(jget detalhe_ana_totalPerformance)" "0"
check "detalhe Ana -> resumo.dataMaisRecente=null" "$(jget detalhe_ana_dataMaisRecente)" "null"
check "detalhe Ana -> areas=[]" "$(jget detalhe_ana_areas)" "[]"
check "detalhe Ana -> vinculo=null" "$(jget detalhe_ana_vinculo)" "null"

check "detalhe de Entregador de outro tenant (via entidade OUTRA) -> 404" "$(jget detalhe_outro_tenant_status)" "404"
check "detalhe de id inexistente -> 404" "$(jget detalhe_inexistente_status)" "404"

check "usuário sem motoristas.listar -> GET /motoristas 403" "$(jget sem_permissao_lista_status)" "403"
check "usuário sem motoristas.consultar -> GET /motoristas/:id 403" "$(jget sem_permissao_detalhe_status)" "403"

# ── FASE 4 (task 4.1.6) — PATCH /motoristas/:id ──────────────────────────
check "PATCH nome -> 200" "$(jget patch_nome_status)" "200"
check "PATCH nome -> valor persistido" "$(jget patch_nome_valor)" "Ana Costa Editada"
check "PATCH nome -> nomeEditadoManualmente=true" "$(jget patch_nome_editado_manualmente)" "true"
check "PATCH nome -> histórico (resumo) intacto (FR-004)" "$(jget patch_nome_resumo_intacto)" "true"

check "PATCH ativo -> 200" "$(jget patch_ativo_status)" "200"
check "PATCH ativo -> valor persistido" "$(jget patch_ativo_valor)" "true"
check "PATCH ativo -> nome NÃO tocado" "$(jget patch_ativo_nome_inalterado)" "true"
check "PATCH ativo (só situação) -> nomeEditadoManualmente NÃO muda (permanece false)" "$(jget patch_ativo_nome_editado_manualmente)" "false"

check "PATCH nome vazio/só espaços -> 422" "$(jget patch_invalido_status)" "422"
check "PATCH corpo vazio (nenhum campo) -> 422" "$(jget patch_vazio_status)" "422"
check "PATCH sem motoristas.editar (usuário de leitura) -> 403" "$(jget patch_sem_permissao_status)" "403"
check "PATCH em Entregador fora do escopo (outro tenant) -> 404" "$(jget patch_fora_escopo_status)" "404"
check "PATCH em id inexistente -> 404" "$(jget patch_inexistente_status)" "404"

check "PATCH mass-assignment (motoristaId fora da allowlist) -> 200 (ignorado, não quebra)" "$(jget patch_mass_assign_status)" "200"
check "PATCH mass-assignment -> nome persiste normalmente (1ª edição de José)" "$(jget patch_mass_assign_nome)" "Jose Mass Assign"
check "PATCH mass-assignment -> vinculo continua null (motoristaId do corpo NUNCA chega ao PostgREST)" "$(jget patch_mass_assign_sem_vinculo)" "true"

# ── Cenário 4 (task 4.1.6) — sobrevivência à reimportação ────────────────
# Ana tem EXATAMENTE 1 edição manual prévia (PATCH nome, cenário (m) acima) —
# nome_editado_manualmente=true. Simula o pipeline S4 de reimportação fazendo
# um UPDATE direto na linha (mesmo caminho que hub-import-processor.js usaria
# num upsert por id_externo) tentando sobrescrever o nome — o trigger 0019
# (trg_entregador_protege_nome) deve reverter NEW.nome para o valor editado
# manualmente, incondicionalmente, não importa quem fez o UPDATE.
psql_t <<SQL >/dev/null
UPDATE "Entregador" SET nome = 'Nome Vindo Da Reimportacao' WHERE id = $ENT_ANA;
SQL
NOME_APOS_REIMPORT="$(psql_t -tAc "SELECT nome FROM \"Entregador\" WHERE id=$ENT_ANA" | sed 's/[[:space:]]*$//')"
check "Cenário 4: nome editado manualmente sobrevive a UPDATE de reimportação (trigger 0019)" "$NOME_APOS_REIMPORT" "Ana Costa Editada"

echo
if [ "$fails" = "0" ]; then
  echo "HUB-MOTORISTAS-INTEGRATION: OK — todos os asserts passaram (FASE 3: 3.1/3.2; FASE 4: 4.1)"
else
  echo "HUB-MOTORISTAS-INTEGRATION: $fails assert(s) FALHARAM" >&2
  exit 1
fi

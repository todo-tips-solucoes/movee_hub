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
# FASE 5 (tasks.md 5.1/5.2) — GET /motoristas/:id/sugestoes e
# GET /motoristas/contas-elegiveis (quickstart Cenários 5/7/9):
#   (t) sugestoes: entidade elegível -> conta quase-idêntica ao nome do
#       Entregador aparece com similaridade alta, jaVinculadoA=null
#   (u) sugestoes: conta com nome bem diferente (abaixo do limiar 0.3) NUNCA
#       aparece (Clarification Q4/block-002)
#   (v) sugestoes: Entregador JÁ vinculado também responde normalmente
#       (FR-013) — a própria conta vinculada aparece com jaVinculadoA=null
#       (vinculada a si mesmo, não a "outra pessoa")
#   (w) sugestoes: fora do escopo (outro tenant) -> 404; sem permissão -> 403
#   (x) contas-elegiveis: busca manual por termo (`q`) acha conta que a
#       sugestão automática não acharia (nome bem diferente) — FR-009
#   (y) contas-elegiveis: `entregadorId` ausente -> 422; termo abaixo do
#       corte mínimo (1 char) -> items:[] sem erro; fora do escopo -> 404
#   (z) Cenário 9: entidade FORA do grupo Movee -> AMBOS endpoints respondem
#       200, `entidadeElegivel:false`, `items:[]`, sem erro (FR-010/FR-011)
#
# FASE 6 (tasks.md 6.1/6.2) — POST/DELETE /motoristas/:id/vinculo (quickstart
# Cenário 8):
#   (aa) POST vinculo -> 200, persiste (visível em GET /motoristas/:id),
#        auditoria motorista.vinculado gravada
#   (bb) POST vinculo com a MESMA conta em OUTRO Entregador -> 409 CONFLITO,
#        vinculadaA aponta pro Entregador A, motorista_id de B continua NULL
#   (cc) POST vinculo substituindo o vínculo do Entregador A por OUTRA conta,
#        SEM desvincular antes -> 200 em ação única (FR-013)
#   (dd) POST vinculo com contaMotoristaId inexistente (violação de FK) -> 404
#   (ee) POST vinculo com corpo fora da allowlist (sem contaMotoristaId) -> 422
#   (ff) POST vinculo sem motoristas.editar -> 403; fora do escopo -> 404;
#        entidade fora do grupo Movee -> 422 entidade_fora_do_grupo
#   (gg) DELETE vinculo persiste (visível em GET /motoristas/:id ->
#        vinculo:null), auditoria motorista.desvinculado gravada
#   (hh) DELETE vinculo em Entregador que NUNCA teve vínculo -> 204 idempotente
#        (CHK006), sem erro, sem auditoria vazia
#   (ii) DELETE vinculo sem motoristas.editar -> 403
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
  ($UID_EDITOR, $E_TESTE, $PAPEL_OPERADOR, true),
  ($UID_EDITOR, $E_OUTRA, $PAPEL_OPERADOR, true);
SQL
# ($UID_EDITOR também ativo em $E_OUTRA, com motoristas.editar — usado pelo
# Cenário 9/FASE 5 abaixo para exercitar o ramo "entidade fora do grupo
# Movee" em /sugestoes e /contas-elegiveis, que exige motoristas.editar; o
# usuário de leitura já ativo em $E_OUTRA não tem essa permissão.)

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

# --- Seed FASE 5 (5.1/5.2): EmpresaGrupoMovee + ContaMotorista extras -----
# $E_TESTE é elegível (inserido); $E_OUTRA e $E_SEM_PERM deliberadamente NÃO
# (Cenário 9/FR-010/FR-011 — testam o ramo entidadeElegivel:false abaixo).
psql_t <<SQL >/dev/null
INSERT INTO "EmpresaGrupoMovee" (id_empresa) VALUES ($E_TESTE)
ON CONFLICT (id_empresa) DO NOTHING;
SQL

# 3 contas novas: (1) quase-idêntica a "José da Silva" (sugestão automática,
# similaridade alta, jaVinculadoA=null); (2) nome bem diferente (ruído,
# similaridade < 0.3, NUNCA deve aparecer em /sugestoes — corte por limiar);
# (3) nome bem diferente, achável só por busca manual via `q` (FR-009).
psql_t <<SQL >/dev/null
INSERT INTO "ContaMotorista" (cnpj_prestador, nome, ativo, cadastro_completo) VALUES
  ('11122233000144', 'jose  da  silva',          true, true),
  ('55566677000188', 'Zelinda Aparecida Nunes',  true, true),
  ('99988877000166', 'Wagner Souza Bittencourt', true, true)
ON CONFLICT (cnpj_prestador) DO NOTHING;
SQL
CONTA_SUGESTAO_JOSE="$(psql_t -tAc "SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='11122233000144'" | tr -d '[:space:]')"
CONTA_RUIDO="$(psql_t -tAc "SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='55566677000188'" | tr -d '[:space:]')"
CONTA_WAGNER="$(psql_t -tAc "SELECT id FROM \"ContaMotorista\" WHERE cnpj_prestador='99988877000166'" | tr -d '[:space:]')"
for v in CONTA_SUGESTAO_JOSE CONTA_RUIDO CONTA_WAGNER; do
  [ -n "${!v}" ] || { echo "FAIL: $v (seed FASE 5) não foi criada"; exit 1; }
done

# ─────────────────────────────────────────────────────────────────────────────
# Script Node único: login + troca de entidade + chamadas GET.
# ─────────────────────────────────────────────────────────────────────────────
OUT="$(run_node "$SENHA_OK" "$E_TESTE" "$E_OUTRA" "$E_SEM_PERM" "$ENT_JOSE" "$ENT_MARIA" "$ENT_CARLOS" "$ENT_ANA" "$ENT_OUTRA" "$CONTA_SUGESTAO_JOSE" "$CONTA_RUIDO" "$CONTA_WAGNER" <<'JS'
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
async function postJson(jar, path, corpo) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(jar ? { Cookie: cookieHeader(jar) } : {}) },
    body: JSON.stringify(corpo),
  });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function deleteReq(jar, path) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: jar ? { Cookie: cookieHeader(jar) } : {},
  });
  const body = r.status === 204 ? null : await r.json().catch(() => null);
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
  const contaSugestaoJose = Number(process.argv[11]);
  const contaRuido = Number(process.argv[12]);
  const contaWagner = Number(process.argv[13]);
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
  // jarEditor TAMBÉM ativo em empresaOutra (motoristas.editar em ambas —
  // seed UsuarioEntidade acima) — usado pelas checagens de escopo/RLS de
  // FASE 5 abaixo (403 de permissão já é coberto por jarOutra/leitura; aqui
  // precisamos de um usuário COM motoristas.editar, só que na entidade
  // ERRADA, para provar que é a RLS/filtro por id_empresa que barra, não a
  // permissão). trocarEntidade retorna um jar NOVO — não muta `jarEditor`.
  const jarEditorOutra = await trocarEntidade(jarEditor, empresaOutra);

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

  // ── FASE 5 (tasks.md 5.1/5.2) — GET /sugestoes e GET /contas-elegiveis ──
  // Roda ANTES do PATCH mass-assignment (s) abaixo, que muda o nome de José
  // — as sugestões desta seção dependem do nome ORIGINAL "José da Silva"
  // para casar com a conta "jose  da  silva" semeada acima (Cenário 5).

  // (t) sugestoes: entidade elegível -> conta quase-idêntica aparece com
  // similaridade alta e jaVinculadoA=null (Cenário 5.2/5.3, SC-003)
  const rSugestoesJose = await getJson(jarEditor, `/motoristas/${entJose}/sugestoes`);
  out.sugestoes_jose_status = rSugestoesJose.status;
  out.sugestoes_jose_elegivel = rSugestoesJose.body && rSugestoesJose.body.entidadeElegivel;
  const itensSugJose = (rSugestoesJose.body && rSugestoesJose.body.items) || [];
  const candSugestao = itensSugJose.find((i) => i.contaMotoristaId === contaSugestaoJose);
  out.sugestoes_jose_achou_candidato = candSugestao ? 'true' : 'false';
  out.sugestoes_jose_candidato_ja_vinculado = candSugestao ? JSON.stringify(candSugestao.jaVinculadoA) : 'ERRO';
  out.sugestoes_jose_candidato_similaridade_alta = candSugestao && candSugestao.similaridade >= 0.3 ? 'true' : 'false';
  // (u) ruído (nome bem diferente) NUNCA aparece — corte por limiar 0.3
  out.sugestoes_jose_nao_inclui_ruido = itensSugJose.some((i) => i.contaMotoristaId === contaRuido) ? 'false' : 'true';
  // top N <= 10 (FR-007)
  out.sugestoes_jose_top_n_respeitado = itensSugJose.length <= 10 ? 'true' : 'false';

  // (v) Entregador JÁ vinculado (Carlos) também responde normalmente
  // (FR-013) — a própria conta vinculada aparece com jaVinculadoA=null
  // (vinculada a si mesmo, não a "outra pessoa").
  const rSugestoesCarlos = await getJson(jarEditor, `/motoristas/${entCarlos}/sugestoes`);
  out.sugestoes_carlos_status = rSugestoesCarlos.status;
  out.sugestoes_carlos_elegivel = rSugestoesCarlos.body && rSugestoesCarlos.body.entidadeElegivel;
  const itensSugCarlos = (rSugestoesCarlos.body && rSugestoesCarlos.body.items) || [];
  const carlosPropriaConta = itensSugCarlos.find((i) => i.nome === 'Carlos Pereira');
  out.sugestoes_carlos_propria_conta_ja_vinculado = carlosPropriaConta ? JSON.stringify(carlosPropriaConta.jaVinculadoA) : 'ERRO';

  // (w) sugestoes fora do escopo (outro tenant) -> 404. Usa jarEditorOutra
  // (TEM motoristas.editar, só que ativo na entidade ERRADA) para provar que
  // é a RLS/filtro por id_empresa que barra — não a permissão (que já está
  // presente). Usar um usuário de leitura aqui bateria no 403 do middleware
  // de rota antes de alcançar a checagem de escopo, mascarando o que se
  // quer provar.
  const rSugestoesForaEscopo = await getJson(jarEditorOutra, `/motoristas/${entJose}/sugestoes`);
  out.sugestoes_fora_escopo_status = rSugestoesForaEscopo.status;
  // sem permissão (usuário de leitura, SEM motoristas.editar) -> 403
  const rSugestoesSemPerm = await getJson(jar, `/motoristas/${entJose}/sugestoes`);
  out.sugestoes_sem_permissao_status = rSugestoesSemPerm.status;

  // (x) contas-elegiveis: busca manual por termo acha conta que a sugestão
  // automática não acharia (nome bem diferente do Entregador) — FR-009
  const rBuscaWagner = await getJson(jarEditor, `/motoristas/contas-elegiveis?entregadorId=${entJose}&q=wagner`);
  out.busca_wagner_status = rBuscaWagner.status;
  out.busca_wagner_elegivel = rBuscaWagner.body && rBuscaWagner.body.entidadeElegivel;
  const itensBuscaWagner = (rBuscaWagner.body && rBuscaWagner.body.items) || [];
  out.busca_wagner_achou = itensBuscaWagner.some((i) => i.contaMotoristaId === contaWagner) ? 'true' : 'false';
  out.busca_wagner_total = rBuscaWagner.body && rBuscaWagner.body.total;

  // (y) entregadorId ausente -> 422
  const rBuscaSemEntregadorId = await getJson(jarEditor, '/motoristas/contas-elegiveis?q=wagner');
  out.busca_sem_entregadorid_status = rBuscaSemEntregadorId.status;

  // (y.bis) termo abaixo do corte mínimo (1 char) -> items:[] sem erro
  const rBuscaTermoCurto = await getJson(jarEditor, `/motoristas/contas-elegiveis?entregadorId=${entJose}&q=w`);
  out.busca_termo_curto_status = rBuscaTermoCurto.status;
  out.busca_termo_curto_total = rBuscaTermoCurto.body && rBuscaTermoCurto.body.total;
  out.busca_termo_curto_elegivel = rBuscaTermoCurto.body && rBuscaTermoCurto.body.entidadeElegivel;

  // (y.ter) fora do escopo (entregadorId de outro tenant) -> 404
  const rBuscaForaEscopo = await getJson(jarEditor, `/motoristas/contas-elegiveis?entregadorId=${entOutra}&q=wagner`);
  out.busca_fora_escopo_status = rBuscaForaEscopo.status;

  // (z) Cenário 9: entidade FORA do grupo Movee -> AMBOS endpoints 200,
  // entidadeElegivel:false, items:[] (FR-010/FR-011) — reusa jarEditorOutra
  // (já ativo na entidade OUTRA, que não está em EmpresaGrupoMovee) e o
  // próprio Entregador do tenant OUTRA (entOutra, dentro do escopo agora).
  const rSugestoesNaoElegivel = await getJson(jarEditorOutra, `/motoristas/${entOutra}/sugestoes`);
  out.sugestoes_nao_elegivel_status = rSugestoesNaoElegivel.status;
  out.sugestoes_nao_elegivel_elegivel = rSugestoesNaoElegivel.body && rSugestoesNaoElegivel.body.entidadeElegivel;
  out.sugestoes_nao_elegivel_items_vazio = rSugestoesNaoElegivel.body && Array.isArray(rSugestoesNaoElegivel.body.items) && rSugestoesNaoElegivel.body.items.length === 0 ? 'true' : 'false';

  const rBuscaNaoElegivel = await getJson(jarEditorOutra, `/motoristas/contas-elegiveis?entregadorId=${entOutra}&q=wagner`);
  out.busca_nao_elegivel_status = rBuscaNaoElegivel.status;
  out.busca_nao_elegivel_elegivel = rBuscaNaoElegivel.body && rBuscaNaoElegivel.body.entidadeElegivel;
  out.busca_nao_elegivel_total = rBuscaNaoElegivel.body && rBuscaNaoElegivel.body.total;

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

  // ── FASE 6 (tasks.md 6.1/6.2) — POST/DELETE /motoristas/:id/vinculo ─────
  // José e Maria estão AMBOS sem vínculo neste ponto (nenhum PATCH/GET
  // anterior tocou motorista_id). contaSugestaoJose/contaRuido estão livres
  // (nunca usadas em vinculo antes). Cenário 8 do quickstart, passos 1-4.

  // (aa) POST vinculo José<-contaSugestaoJose -> 200, persiste
  const rVinculoJose = await postJson(jarEditor, `/motoristas/${entJose}/vinculo`, { contaMotoristaId: contaSugestaoJose, origem: 'sugestao' });
  out.vinculo_jose_status = rVinculoJose.status;
  out.vinculo_jose_body_contaId = rVinculoJose.body && rVinculoJose.body.vinculo && rVinculoJose.body.vinculo.contaMotoristaId;
  const rDetalheJoseVinculado = await getJson(jarEditor, `/motoristas/${entJose}`);
  out.vinculo_jose_persistiu = rDetalheJoseVinculado.body && rDetalheJoseVinculado.body.vinculo
    && rDetalheJoseVinculado.body.vinculo.contaMotoristaId === contaSugestaoJose ? 'true' : 'false';

  // (bb) POST vinculo Maria<-MESMA contaSugestaoJose -> 409 CONFLITO
  // apontando pro José; motorista_id de Maria continua NULL
  const rVinculoConflito = await postJson(jarEditor, `/motoristas/${entMaria}/vinculo`, { contaMotoristaId: contaSugestaoJose });
  out.vinculo_conflito_status = rVinculoConflito.status;
  out.vinculo_conflito_motivo = rVinculoConflito.body && rVinculoConflito.body.motivo;
  out.vinculo_conflito_vinculadaA_id = rVinculoConflito.body && rVinculoConflito.body.vinculadaA && rVinculoConflito.body.vinculadaA.entregadorId;
  const rDetalheMariaAposConflito = await getJson(jarEditor, `/motoristas/${entMaria}`);
  out.vinculo_conflito_maria_continua_sem_vinculo = rDetalheMariaAposConflito.body && rDetalheMariaAposConflito.body.vinculo === null ? 'true' : 'false';

  // (cc) Substituir vínculo do José por contaRuido, SEM desvincular antes
  // (FR-013 — ação única)
  const rVinculoSubstitui = await postJson(jarEditor, `/motoristas/${entJose}/vinculo`, { contaMotoristaId: contaRuido });
  out.vinculo_substitui_status = rVinculoSubstitui.status;
  out.vinculo_substitui_contaId = rVinculoSubstitui.body && rVinculoSubstitui.body.vinculo && rVinculoSubstitui.body.vinculo.contaMotoristaId;

  // (dd) POST vinculo com contaMotoristaId inexistente -> 404 (FK)
  const rVinculoFkInvalida = await postJson(jarEditor, `/motoristas/${entMaria}/vinculo`, { contaMotoristaId: 999999999 });
  out.vinculo_fk_invalida_status = rVinculoFkInvalida.status;

  // (ee) POST vinculo sem contaMotoristaId no corpo -> 422
  const rVinculoSemCampo = await postJson(jarEditor, `/motoristas/${entMaria}/vinculo`, {});
  out.vinculo_sem_campo_status = rVinculoSemCampo.status;

  // (ff) POST vinculo sem motoristas.editar (usuário de leitura) -> 403
  const rVinculoSemPerm = await postJson(jar, `/motoristas/${entMaria}/vinculo`, { contaMotoristaId: contaWagner });
  out.vinculo_sem_permissao_status = rVinculoSemPerm.status;

  // POST vinculo fora do escopo (Entregador de outro tenant) -> 404
  const rVinculoForaEscopo = await postJson(jarEditor, `/motoristas/${entOutra}/vinculo`, { contaMotoristaId: contaWagner });
  out.vinculo_fora_escopo_status = rVinculoForaEscopo.status;

  // POST vinculo entidade fora do grupo Movee -> 422 entidade_fora_do_grupo
  // (jarEditorOutra: motoristas.editar, ativo na entidade OUTRA, que NÃO
  // está em EmpresaGrupoMovee)
  const rVinculoNaoElegivel = await postJson(jarEditorOutra, `/motoristas/${entOutra}/vinculo`, { contaMotoristaId: contaWagner });
  out.vinculo_nao_elegivel_status = rVinculoNaoElegivel.status;
  out.vinculo_nao_elegivel_motivo = rVinculoNaoElegivel.body && rVinculoNaoElegivel.body.motivo;

  // (gg) DELETE vinculo José (atualmente vinculado a contaRuido, passo cc) ->
  // 204, persiste (GET mostra vinculo:null)
  const rDesvinculoJose = await deleteReq(jarEditor, `/motoristas/${entJose}/vinculo`);
  out.desvinculo_jose_status = rDesvinculoJose.status;
  const rDetalheJoseAposDesvinculo = await getJson(jarEditor, `/motoristas/${entJose}`);
  out.desvinculo_jose_persistiu = rDetalheJoseAposDesvinculo.body && rDetalheJoseAposDesvinculo.body.vinculo === null ? 'true' : 'false';

  // (hh) DELETE vinculo em Maria (NUNCA teve vínculo) -> 204 idempotente
  // (CHK006), sem erro
  const rDesvinculoIdempotente = await deleteReq(jarEditor, `/motoristas/${entMaria}/vinculo`);
  out.desvinculo_idempotente_status = rDesvinculoIdempotente.status;

  // (ii) DELETE vinculo sem motoristas.editar -> 403
  const rDesvinculoSemPerm = await deleteReq(jar, `/motoristas/${entMaria}/vinculo`);
  out.desvinculo_sem_permissao_status = rDesvinculoSemPerm.status;

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

# ── FASE 5 (tasks.md 5.1/5.2) — GET /sugestoes e GET /contas-elegiveis ───
check "sugestoes José -> 200" "$(jget sugestoes_jose_status)" "200"
check "sugestoes José -> entidadeElegivel=true" "$(jget sugestoes_jose_elegivel)" "true"
check "sugestoes José -> achou candidato quase-idêntico ('jose  da  silva')" "$(jget sugestoes_jose_achou_candidato)" "true"
check "sugestoes José -> candidato jaVinculadoA=null" "$(jget sugestoes_jose_candidato_ja_vinculado)" "null"
check "sugestoes José -> candidato com similaridade >= 0.3" "$(jget sugestoes_jose_candidato_similaridade_alta)" "true"
check "sugestoes José -> NÃO inclui conta-ruído (abaixo do limiar 0.3, Clarification Q4)" "$(jget sugestoes_jose_nao_inclui_ruido)" "true"
check "sugestoes José -> top N <= 10 (FR-007)" "$(jget sugestoes_jose_top_n_respeitado)" "true"

check "sugestoes Carlos (JÁ vinculado) -> 200, responde normalmente (FR-013)" "$(jget sugestoes_carlos_status)" "200"
check "sugestoes Carlos -> entidadeElegivel=true" "$(jget sugestoes_carlos_elegivel)" "true"
check "sugestoes Carlos -> própria conta vinculada aparece com jaVinculadoA=null (vinculada a si mesmo)" "$(jget sugestoes_carlos_propria_conta_ja_vinculado)" "null"

check "sugestoes fora do escopo (outro tenant) -> 404" "$(jget sugestoes_fora_escopo_status)" "404"
check "sugestoes sem motoristas.editar (usuário de leitura) -> 403" "$(jget sugestoes_sem_permissao_status)" "403"

check "busca manual q=wagner -> 200" "$(jget busca_wagner_status)" "200"
check "busca manual q=wagner -> entidadeElegivel=true" "$(jget busca_wagner_elegivel)" "true"
check "busca manual q=wagner -> achou conta que a sugestão automática não acharia (FR-009)" "$(jget busca_wagner_achou)" "true"
check "busca manual q=wagner -> total=1" "$(jget busca_wagner_total)" "1"

check "busca manual sem entregadorId -> 422" "$(jget busca_sem_entregadorid_status)" "422"

check "busca manual termo abaixo do corte (1 char) -> 200 sem erro" "$(jget busca_termo_curto_status)" "200"
check "busca manual termo abaixo do corte -> total=0 (sem chamar o RPC)" "$(jget busca_termo_curto_total)" "0"
check "busca manual termo abaixo do corte -> entidadeElegivel=true (só o termo é curto, entidade continua elegível)" "$(jget busca_termo_curto_elegivel)" "true"

check "busca manual entregadorId de outro tenant -> 404" "$(jget busca_fora_escopo_status)" "404"

# ── Cenário 9 (FR-010/FR-011) — entidade FORA do grupo Movee ─────────────
check "sugestoes entidade não-elegível -> 200 (sem erro)" "$(jget sugestoes_nao_elegivel_status)" "200"
check "sugestoes entidade não-elegível -> entidadeElegivel=false" "$(jget sugestoes_nao_elegivel_elegivel)" "false"
check "sugestoes entidade não-elegível -> items=[] " "$(jget sugestoes_nao_elegivel_items_vazio)" "true"

check "busca manual entidade não-elegível -> 200 (sem erro)" "$(jget busca_nao_elegivel_status)" "200"
check "busca manual entidade não-elegível -> entidadeElegivel=false" "$(jget busca_nao_elegivel_elegivel)" "false"
check "busca manual entidade não-elegível -> total=0" "$(jget busca_nao_elegivel_total)" "0"

check "PATCH mass-assignment (motoristaId fora da allowlist) -> 200 (ignorado, não quebra)" "$(jget patch_mass_assign_status)" "200"
check "PATCH mass-assignment -> nome persiste normalmente (1ª edição de José)" "$(jget patch_mass_assign_nome)" "Jose Mass Assign"
check "PATCH mass-assignment -> vinculo continua null (motoristaId do corpo NUNCA chega ao PostgREST)" "$(jget patch_mass_assign_sem_vinculo)" "true"

# ── FASE 6 (tasks.md 6.1/6.2) — POST/DELETE /motoristas/:id/vinculo ──────
check "POST vinculo José<-contaSugestaoJose -> 200" "$(jget vinculo_jose_status)" "200"
check "POST vinculo -> body.vinculo.contaMotoristaId correto" "$(jget vinculo_jose_body_contaId)" "$CONTA_SUGESTAO_JOSE"
check "POST vinculo -> persiste (GET /motoristas/:id reflete)" "$(jget vinculo_jose_persistiu)" "true"

check "POST vinculo Maria<-MESMA conta (Cenário 8 passo 2) -> 409 CONFLITO" "$(jget vinculo_conflito_status)" "409"
check "409 -> motivo=conta_ja_vinculada" "$(jget vinculo_conflito_motivo)" "conta_ja_vinculada"
check "409 -> vinculadaA.entregadorId aponta pro José" "$(jget vinculo_conflito_vinculadaA_id)" "$ENT_JOSE"
check "409 -> Maria.motorista_id continua NULL (sem efeito colateral)" "$(jget vinculo_conflito_maria_continua_sem_vinculo)" "true"

check "POST vinculo substitui José->contaRuido SEM desvincular antes (FR-013, Cenário 8 passo 3) -> 200" "$(jget vinculo_substitui_status)" "200"
check "substituição -> nova conta persistida em 1 ação" "$(jget vinculo_substitui_contaId)" "$CONTA_RUIDO"

check "POST vinculo contaMotoristaId inexistente (violação de FK) -> 404" "$(jget vinculo_fk_invalida_status)" "404"
check "POST vinculo sem contaMotoristaId no corpo -> 422" "$(jget vinculo_sem_campo_status)" "422"
check "POST vinculo sem motoristas.editar (usuário de leitura) -> 403" "$(jget vinculo_sem_permissao_status)" "403"
check "POST vinculo em Entregador fora do escopo (outro tenant) -> 404" "$(jget vinculo_fora_escopo_status)" "404"
check "POST vinculo entidade fora do grupo Movee -> 422" "$(jget vinculo_nao_elegivel_status)" "422"
check "422 -> motivo=entidade_fora_do_grupo" "$(jget vinculo_nao_elegivel_motivo)" "entidade_fora_do_grupo"

check "DELETE vinculo José (tinha vínculo) -> 204 (Cenário 8 passo 4 variante 'com vínculo')" "$(jget desvinculo_jose_status)" "204"
check "DELETE vinculo -> persiste (GET /motoristas/:id -> vinculo:null)" "$(jget desvinculo_jose_persistiu)" "true"
check "DELETE vinculo em Maria (NUNCA teve vínculo, Cenário 8 passo 4) -> 204 idempotente (CHK006)" "$(jget desvinculo_idempotente_status)" "204"
check "DELETE vinculo sem motoristas.editar -> 403" "$(jget desvinculo_sem_permissao_status)" "403"

# ── FASE 6 (tasks.md 6.1.4/6.2.3) — auditoria motorista.vinculado/desvinculado ──
# José recebeu 2 POST /vinculo bem-sucedidos (contaSugestaoJose, depois
# contaRuido via substituição) + 1 DELETE bem-sucedido -> 2 entradas
# motorista.vinculado + 1 motorista.desvinculado. O DELETE idempotente sobre
# Maria (sem vínculo prévio) NUNCA deve gerar entrada de auditoria (no-op).
N_AUD_VINCULADO="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='motorista.vinculado' AND recurso_id='$ENT_JOSE'" | tr -d '[:space:]')"
check "auditoria motorista.vinculado gravada 2x para José (POST inicial + substituição)" "$N_AUD_VINCULADO" "2"
N_AUD_DESVINCULADO_JOSE="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='motorista.desvinculado' AND recurso_id='$ENT_JOSE'" | tr -d '[:space:]')"
check "auditoria motorista.desvinculado gravada 1x para José (DELETE com vínculo)" "$N_AUD_DESVINCULADO_JOSE" "1"
N_AUD_DESVINCULADO_MARIA="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='motorista.desvinculado' AND recurso_id='$ENT_MARIA'" | tr -d '[:space:]')"
check "DELETE idempotente (sem vínculo prévio) NUNCA gera auditoria vazia" "$N_AUD_DESVINCULADO_MARIA" "0"

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
  echo "HUB-MOTORISTAS-INTEGRATION: OK — todos os asserts passaram (FASE 3: 3.1/3.2; FASE 4: 4.1; FASE 5: 5.1/5.2; FASE 6: 6.1/6.2)"
else
  echo "HUB-MOTORISTAS-INTEGRATION: $fails assert(s) FALHARAM" >&2
  exit 1
fi

#!/usr/bin/env bash
# =============================================================================
# hub-importacoes-fase5-integration.sh — tasks.md FASE 5 (5.1-5.8): prova E2E
# dos endpoints de consulta/ação (GET histórico/detalhe/erros/original, POST
# reprocessar/cancelar) contra um projeto hub-test EFÊMERO e descartável.
# Mesmo padrão de isolamento de infra/hub/testes/hub-importacoes-integration.sh
# (FASE 3) — nunca toca chatmasterveloz/produção.
#
# Estratégia de custo: em vez de rodar o pipeline completo (upload+parse+
# processamento) para CADA cenário, a maior parte dos registros é semeada
# DIRETO via SQL (psql) — reproduz exatamente os estados/contadores que os
# testes precisam sem pagar o custo de repetir uploads reais. Só 1 upload
# REAL é feito (para provar o caminho ponta-a-ponta de GET /:id/original
# servindo um arquivo de fato gravado em disco).
#
# Cobre:
#   5.1 — paginação (page/pageSize/total), filtro tipo/status, aguardandoLock
#         derivado (dec-032/CHK013)
#   5.2 — detalhe+contadores; 404 cross-tenant (quickstart Cenário 8)
#   5.3 — erros paginados; ?format=csv com proteção CSV injection (célula
#         "=1+1" -> prefixo '); JSON nunca expõe campo bruto
#   5.4 — download do original (200); leitura sem `exportar` -> 403;
#         arquivo ausente no disco -> 410 (CHK021 resolvido)
#   5.5 — reprocessar: failed->202 pending (limpa erros); completed->409
#   5.6 — cancelar: processing->202 cancelled; completed->409
#   5.7 — Auditoria de reprocessar/cancelada/original_baixado
#   5.8 — matriz de permissão (papel leitura barrado de criar/exportar)
#
# Uso: infra/hub/testes/hub-importacoes-fase5-integration.sh
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

echo "rodando migrate.sh (0002..0018)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0018_dedupe_erro_recuperacao_orfa.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas por completo (0018 ausente)"; cat "$TMP/migrate.log"; exit 1; }

# --- Seed: 3 Usuarios (admin_entidade E_A; leitura E_A; admin_entidade E_B) -
SENHA_OK='SenhaSinteticaFase5#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

E_A=940001
E_B=940002

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('f5-admin@example.test', '$HASH_OK', 'Usuario Teste F5 Admin', true),
  ('f5-leitura@example.test', '$HASH_OK', 'Usuario Teste F5 Leitura', true),
  ('f5-outra@example.test', '$HASH_OK', 'Usuario Teste F5 Outra Entidade', true);
SQL
UID_ADMIN="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='f5-admin@example.test'" | tr -d '[:space:]')"
UID_LEITURA="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='f5-leitura@example.test'" | tr -d '[:space:]')"
UID_OUTRA="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='f5-outra@example.test'" | tr -d '[:space:]')"
PAPEL_ADMIN_ENT="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='admin_entidade'" | tr -d '[:space:]')"
PAPEL_LEITURA="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='leitura'" | tr -d '[:space:]')"
[ -n "$PAPEL_ADMIN_ENT" ] && [ -n "$PAPEL_LEITURA" ] || { echo "FAIL: seed 0007 não populou os papéis esperados"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_ADMIN, $E_A, $PAPEL_ADMIN_ENT, true),
  ($UID_LEITURA, $E_A, $PAPEL_LEITURA, true),
  ($UID_OUTRA, $E_B, $PAPEL_ADMIN_ENT, true);
SQL

# ─────────────────────────────────────────────────────────────────────────────
# Seeds diretos via SQL — ImportacaoArquivo em vários estados/tipos, sem pagar
# o custo de rodar o pipeline completo para cada cenário.
# ─────────────────────────────────────────────────────────────────────────────

# (1) 5 registros extras de E_A/faturamento (para paginação/filtro) + 1
#     pending SOZINHO (aguardandoLock=false) + 1 pending COM sibling
#     processing do MESMO tipo (aguardandoLock=true).
psql_t <<SQL >/dev/null
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, nome_arquivo, hash_sha256, status, total_linhas, linhas_validas, linhas_invalidas, criado_em)
VALUES
  ($E_A, 'faturamento', 'p1.csv', repeat('a',64), 'completed', 10, 10, 0, now() - interval '1 day'),
  ($E_A, 'faturamento', 'p2.csv', repeat('b',64), 'completed', 20, 18, 2, now() - interval '2 day'),
  ($E_A, 'performance', 'p3.csv', repeat('c',64), 'completed', 5, 5, 0, now() - interval '3 day'),
  ($E_A, 'faturamento', 'p4.csv', repeat('d',64), 'failed', 0, 0, 0, now() - interval '4 day'),
  ($E_A, 'faturamento', 'p5-completo.csv', repeat('e',64), 'completed', 3, 3, 0, now() - interval '5 day'),
  ($E_A, 'performance', 'p6-pending-sozinho.csv', repeat('f',64), 'pending', NULL, NULL, NULL, now()),
  ($E_A, 'performance', 'p7-pending-ativo.csv', repeat('1',64), 'pending', NULL, NULL, NULL, now()),
  ($E_A, 'performance', 'p8-processing.csv', repeat('2',64), 'processing', NULL, NULL, NULL, now() - interval '1 hour'),
  ($E_A, 'faturamento', 'p9-para-reprocessar.csv', repeat('3',64), 'failed', 8, 3, 5, now() - interval '6 day'),
  ($E_A, 'faturamento', 'p10-para-reprocessar-409.csv', repeat('4',64), 'completed', 1, 1, 0, now() - interval '7 day'),
  ($E_A, 'faturamento', 'p12-para-cancelar-409.csv', repeat('6',64), 'completed', 1, 1, 0, now() - interval '8 day'),
  ($E_A, 'faturamento', 'p13-original-ausente.csv', repeat('7',64), 'completed', 1, 1, 0, now() - interval '9 day'),
  ($E_B, 'faturamento', 'outraempresa.csv', repeat('9',64), 'completed', 1, 1, 0, now())
SQL

ID_P9_REPROCESSAR="$(psql_t -tAc "SELECT id FROM \"ImportacaoArquivo\" WHERE hash_sha256=repeat('3',64) AND id_empresa=$E_A" | tr -d '[:space:]')"
ID_P10_409="$(psql_t -tAc "SELECT id FROM \"ImportacaoArquivo\" WHERE hash_sha256=repeat('4',64) AND id_empresa=$E_A" | tr -d '[:space:]')"
ID_P11_CANCELAR="$(psql_t -tAc "SELECT id FROM \"ImportacaoArquivo\" WHERE hash_sha256=repeat('2',64) AND id_empresa=$E_A" | tr -d '[:space:]')"
ID_P12_409="$(psql_t -tAc "SELECT id FROM \"ImportacaoArquivo\" WHERE hash_sha256=repeat('6',64) AND id_empresa=$E_A" | tr -d '[:space:]')"
ID_P13_ORIGINAL_AUSENTE="$(psql_t -tAc "SELECT id FROM \"ImportacaoArquivo\" WHERE hash_sha256=repeat('7',64) AND id_empresa=$E_A" | tr -d '[:space:]')"
ID_OUTRA_EMPRESA="$(psql_t -tAc "SELECT id FROM \"ImportacaoArquivo\" WHERE hash_sha256=repeat('9',64) AND id_empresa=$E_B" | tr -d '[:space:]')"
ID_P2_ERROS="$(psql_t -tAc "SELECT id FROM \"ImportacaoArquivo\" WHERE hash_sha256=repeat('b',64) AND id_empresa=$E_A" | tr -d '[:space:]')"

# ImportacaoLinhaErro para p2 (célula maliciosa p/ CSV injection, 5.3.4)
psql_t <<SQL >/dev/null
INSERT INTO "ImportacaoLinhaErro" (importacao_id, id_empresa, numero_linha, motivo, campo, valor_mascarado) VALUES
  ($ID_P2_ERROS, $E_A, 3, 'formato_invalido', 'valor', '=1+1'),
  ($ID_P2_ERROS, $E_A, 7, 'formato_invalido', 'cnpj', '1***********9')
SQL

# ImportacaoLinhaErro "obsoleta" para p9 (deve SUMIR após reprocessar — 5.5.2)
psql_t <<SQL >/dev/null
INSERT INTO "ImportacaoLinhaErro" (importacao_id, id_empresa, numero_linha, motivo, campo, valor_mascarado) VALUES
  ($ID_P9_REPROCESSAR, $E_A, 1, 'erro_obsoleto', 'x', 'a*b')
SQL

# ─────────────────────────────────────────────────────────────────────────────
# Script Node único: login + troca de entidade + chamadas HTTP às rotas FASE 5
# ─────────────────────────────────────────────────────────────────────────────
OUT="$(run_node "$SENHA_OK" "$E_A" "$E_B" "$ID_P9_REPROCESSAR" "$ID_P10_409" "$ID_P11_CANCELAR" "$ID_P12_409" "$ID_P13_ORIGINAL_AUSENTE" "$ID_OUTRA_EMPRESA" "$ID_P2_ERROS" <<'JS'
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
  const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookieHeader(jar) } });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function getRaw(jar, path) {
  const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookieHeader(jar) } });
  const text = await r.text().catch(() => '');
  return { status: r.status, text, contentType: r.headers.get('content-type') || '' };
}
async function postJson(jar, path) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: { Cookie: cookieHeader(jar) } });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
async function upload(jar, { tipo, nomeArquivo, conteudo }) {
  const fd = new FormData();
  fd.append('tipo', tipo);
  fd.append('file', new Blob([Buffer.from(conteudo, 'utf8')], { type: 'text/csv' }), nomeArquivo);
  const r = await fetch(`${BASE}/importacoes`, { method: 'POST', headers: { Cookie: cookieHeader(jar) }, body: fd });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
function sleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

async function main() {
  const senha = process.argv[2];
  const eA = Number(process.argv[3]);
  const eB = Number(process.argv[4]);
  const idP9Reprocessar = Number(process.argv[5]);
  const idP10_409 = Number(process.argv[6]);
  const idP11Cancelar = Number(process.argv[7]);
  const idP12_409 = Number(process.argv[8]);
  const idP13OriginalAusente = Number(process.argv[9]);
  const idOutraEmpresa = Number(process.argv[10]);
  const idP2Erros = Number(process.argv[11]);
  const out = {};

  let jarAdmin = await login('f5-admin@example.test', senha);
  jarAdmin = await trocarEntidade(jarAdmin, eA);
  let jarLeitura = await login('f5-leitura@example.test', senha);
  jarLeitura = await trocarEntidade(jarLeitura, eA);
  let jarOutra = await login('f5-outra@example.test', senha);
  jarOutra = await trocarEntidade(jarOutra, eB);

  // ── upload REAL (para provar GET /:id/original ponta-a-ponta) ───────────
  // Fixture com o HEADER_FATURAMENTO real (não hardcoded) — mesma técnica de
  // infra/hub/testes/hub-import-processor-integration.sh — garante que o
  // processor de fato conclua (completed), não apenas que o upload seja
  // aceito (201).
  const marcador = `Real-${Date.now()}`;
  const camposFaturamento = {
    data_do_lancamento_financeiro: '2026-01-05',
    data_do_periodo_de_referencia: '2026-01-01',
    data_do_repasse: '',
    periodo: 'SEMANAL',
    praca: 'SP',
    subpraca: 'ZonaSul',
    origem: 'App',
    id_da_pessoa_entregadora: '11111111-1111-1111-1111-000000000001',
    recebedor: marcador,
    tipo: 'Credito',
    valor: '100,00',
    descricao: 'Repasse sintetico fase5',
    atingido: '',
    percentual_de_tempo_disponivel: '',
    percentual_de_aceitacao: '',
    percentual_de_conclusao: '',
    criterio_tempo_disponivel: '',
    criterio_rotas_aceitas: '',
    criterio_rotas_concluidas: '',
    margem_fee_porcentagem: '',
  };
  const HEADER_FATURAMENTO = [
    'data_do_lancamento_financeiro', 'data_do_periodo_de_referencia', 'data_do_repasse',
    'periodo', 'praca', 'subpraca', 'origem', 'id_da_pessoa_entregadora', 'recebedor',
    'tipo', 'valor', 'descricao', 'atingido', 'percentual_de_tempo_disponivel',
    'percentual_de_aceitacao', 'percentual_de_conclusao', 'criterio_tempo_disponivel',
    'criterio_rotas_aceitas', 'criterio_rotas_concluidas', 'margem_fee_porcentagem',
  ];
  const linhaCsv = HEADER_FATURAMENTO.map((h) => camposFaturamento[h]).join(';');
  const conteudoUnico = [HEADER_FATURAMENTO.join(';'), linhaCsv, ''].join('\n');
  const rUpload = await upload(jarAdmin, { tipo: 'faturamento', nomeArquivo: 'real.csv', conteudo: conteudoUnico });
  out.upload_status = rUpload.status;
  const idReal = rUpload.body && rUpload.body.id;
  out.id_real = idReal;
  // pequena espera — arquivo pequeno (1 linha) processa quase instantâneo
  await sleep(2000);

  // ── 5.1 lista/paginação/filtro ───────────────────────────────────────────
  const rLista1 = await getJson(jarAdmin, '/importacoes?tipo=faturamento&page=1&pageSize=3');
  out.lista_status = rLista1.status;
  out.lista_items_len = rLista1.body && rLista1.body.items ? rLista1.body.items.length : null;
  out.lista_page = rLista1.body && rLista1.body.page;
  out.lista_pageSize = rLista1.body && rLista1.body.pageSize;
  out.lista_total_gte4 = rLista1.body && rLista1.body.total >= 4 ? 'true' : 'false';
  out.lista_shape_ok = rLista1.body && rLista1.body.items && rLista1.body.items.length > 0
    && Object.prototype.hasOwnProperty.call(rLista1.body.items[0], 'linhasValidas')
    && Object.prototype.hasOwnProperty.call(rLista1.body.items[0], 'dataReferencia')
    && Object.prototype.hasOwnProperty.call(rLista1.body.items[0], 'aguardandoLock')
    ? 'true' : 'false';

  const rListaStatus = await getJson(jarAdmin, '/importacoes?status=failed&pageSize=50');
  out.lista_status_filtro_len = rListaStatus.body && rListaStatus.body.items ? rListaStatus.body.items.length : null;

  // aguardandoLock: performance tem 2 pending + 1 processing -> 1 dos
  // pendings deve ter aguardandoLock=true (o outro sozinho, sem sibling
  // ativo antes de existir o processing, também true — os DOIS pending
  // competem pelo MESMO tipo já ativo (processing) -> ambos true).
  const rListaPerf = await getJson(jarAdmin, '/importacoes?tipo=performance&pageSize=50');
  const pendentesPerf = (rListaPerf.body && rListaPerf.body.items || []).filter((i) => i.status === 'pending');
  out.aguardando_lock_todos_true = pendentesPerf.length >= 2 && pendentesPerf.every((i) => i.aguardandoLock === true) ? 'true' : 'false';

  // leitura TAMBÉM pode listar (tem `consultar`)
  const rListaLeitura = await getJson(jarLeitura, '/importacoes?pageSize=5');
  out.lista_leitura_status = rListaLeitura.status;

  // ── 5.2 detalhe + 404 cross-tenant ──────────────────────────────────────
  const rDetalhe = await getJson(jarAdmin, `/importacoes/${idReal}`);
  out.detalhe_status = rDetalhe.status;
  out.detalhe_tem_contadores = rDetalhe.body && rDetalhe.body.contadores ? 'true' : 'false';
  out.detalhe_status_valor = rDetalhe.body && rDetalhe.body.status;

  const rCrossTenant = await getJson(jarOutra, `/importacoes/${idReal}`);
  out.cross_tenant_status = rCrossTenant.status;

  const r404Inexistente = await getJson(jarAdmin, '/importacoes/999999999');
  out.inexistente_status = r404Inexistente.status;

  // ── 5.3 erros (paginação + csv injection + mascaramento) ────────────────
  const rErrosJson = await getJson(jarAdmin, `/importacoes/${idP2Erros}/erros`);
  out.erros_json_status = rErrosJson.status;
  out.erros_json_total = rErrosJson.body && rErrosJson.body.total;
  const itemMalicioso = rErrosJson.body && rErrosJson.body.items && rErrosJson.body.items.find((i) => i.campo === 'valor');
  out.erros_json_valor_mascarado_intacto = itemMalicioso && itemMalicioso.valorMascarado === '=1+1' ? 'true' : 'false';
  out.erros_json_sem_campo_bruto = itemMalicioso && !Object.prototype.hasOwnProperty.call(itemMalicioso, 'valor_bruto') ? 'true' : 'false';

  const rErrosCsv = await getRaw(jarAdmin, `/importacoes/${idP2Erros}/erros?format=csv`);
  out.erros_csv_status = rErrosCsv.status;
  out.erros_csv_content_type_ok = rErrosCsv.contentType.includes('text/csv') ? 'true' : 'false';
  out.erros_csv_tem_prefixo = rErrosCsv.text.includes("'=1+1") ? 'true' : 'false';

  const rErrosCrossTenant = await getJson(jarOutra, `/importacoes/${idP2Erros}/erros`);
  out.erros_cross_tenant_status = rErrosCrossTenant.status;

  // ── 5.4 download original: 200, 403 (leitura), 410 (ausente) ────────────
  const rOriginalOk = await getRaw(jarAdmin, `/importacoes/${idReal}/original`);
  out.original_ok_status = rOriginalOk.status;
  out.original_ok_tem_conteudo = rOriginalOk.text.includes('Real-') ? 'true' : 'false';

  const rOriginalSemExportar = await getJson(jarLeitura, `/importacoes/${idReal}/original`);
  out.original_sem_exportar_status = rOriginalSemExportar.status;
  out.original_sem_exportar_erro = rOriginalSemExportar.body && rOriginalSemExportar.body.erro;

  const rOriginalAusente = await getJson(jarAdmin, `/importacoes/${idP13OriginalAusente}/original`);
  out.original_ausente_status = rOriginalAusente.status;
  out.original_ausente_erro = rOriginalAusente.body && rOriginalAusente.body.erro;

  // ── 5.5 reprocessar: failed->202 pending (limpa erros); completed->409 ──
  const rReprocessar = await postJson(jarAdmin, `/importacoes/${idP9Reprocessar}/reprocessar`);
  out.reprocessar_status = rReprocessar.status;
  out.reprocessar_body_status = rReprocessar.body && rReprocessar.body.status;

  const rReprocessar409 = await postJson(jarAdmin, `/importacoes/${idP10_409}/reprocessar`);
  out.reprocessar_409_status = rReprocessar409.status;
  out.reprocessar_409_erro = rReprocessar409.body && rReprocessar409.body.error;

  const rReprocessarSemPermissao = await postJson(jarLeitura, `/importacoes/${idP9Reprocessar}/reprocessar`);
  out.reprocessar_sem_permissao_status = rReprocessarSemPermissao.status;

  // ── 5.6 cancelar: processing->202 cancelled; completed->409 ────────────
  const rCancelar = await postJson(jarAdmin, `/importacoes/${idP11Cancelar}/cancelar`);
  out.cancelar_status = rCancelar.status;
  out.cancelar_body_status = rCancelar.body && rCancelar.body.status;

  const rCancelar409 = await postJson(jarAdmin, `/importacoes/${idP12_409}/cancelar`);
  out.cancelar_409_status = rCancelar409.status;
  out.cancelar_409_erro = rCancelar409.body && rCancelar409.body.error;

  const rCancelarSemPermissao = await postJson(jarLeitura, `/importacoes/${idP11Cancelar}/cancelar`);
  out.cancelar_sem_permissao_status = rCancelarSemPermissao.status;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT" | grep -v '___RESULT_JSON___' || true
RESULT_LINE="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$RESULT_LINE" ] || { echo "FAIL: script Node não retornou resultado"; echo "$OUT"; exit 1; }
jget() { printf '%s' "$RESULT_LINE" | node_e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); process.stdout.write(String(d['$1']))"; }

# 5.1
check "GET /importacoes?tipo=faturamento&pageSize=3 -> 200" "$(jget lista_status)" "200"
check "GET /importacoes -> pageSize respeitado (3 itens)" "$(jget lista_items_len)" "3"
check "GET /importacoes -> page=1 no corpo" "$(jget lista_page)" "1"
check "GET /importacoes -> pageSize=3 no corpo" "$(jget lista_pageSize)" "3"
check "GET /importacoes -> total >= 4 (contagem real via Range/count=exact)" "$(jget lista_total_gte4)" "true"
check "GET /importacoes -> shape do item bate o contrato (camelCase + aguardandoLock)" "$(jget lista_shape_ok)" "true"
check "GET /importacoes?status=failed -> filtro de status funciona" "$([ "$(jget lista_status_filtro_len)" -ge 2 ] 2>/dev/null && echo sim || echo nao)" "sim"
check "aguardandoLock=true p/ pending com sibling processing do mesmo tipo (dec-032/CHK013)" "$(jget aguardando_lock_todos_true)" "true"
check "papel leitura TAMBÉM pode listar (tem importacoes.consultar)" "$(jget lista_leitura_status)" "200"

# 5.2
check "GET /importacoes/:id (detalhe) -> 200" "$(jget detalhe_status)" "200"
check "GET /importacoes/:id -> contadores presentes" "$(jget detalhe_tem_contadores)" "true"
check "GET /importacoes/:id -> status=completed (upload real pequeno já processou)" "$(jget detalhe_status_valor)" "completed"
check "GET /importacoes/:id cross-tenant (empresa B lendo id da empresa A) -> 404" "$(jget cross_tenant_status)" "404"
check "GET /importacoes/:id inexistente -> 404" "$(jget inexistente_status)" "404"

# 5.3
check "GET /importacoes/:id/erros (JSON) -> 200" "$(jget erros_json_status)" "200"
check "GET .../erros -> total=2" "$(jget erros_json_total)" "2"
check "GET .../erros JSON -> valorMascarado intacto (=1+1, sem re-escapar em JSON)" "$(jget erros_json_valor_mascarado_intacto)" "true"
check "GET .../erros JSON -> nunca expõe campo bruto" "$(jget erros_json_sem_campo_bruto)" "true"
check "GET .../erros?format=csv -> 200" "$(jget erros_csv_status)" "200"
check "GET .../erros?format=csv -> Content-Type text/csv" "$(jget erros_csv_content_type_ok)" "true"
check "GET .../erros?format=csv -> célula '=1+1' recebe prefixo ' (CSV injection, 5.3.4)" "$(jget erros_csv_tem_prefixo)" "true"
check "GET .../erros cross-tenant -> 404" "$(jget erros_cross_tenant_status)" "404"

# 5.4
check "GET /importacoes/:id/original (admin_entidade, tem exportar) -> 200" "$(jget original_ok_status)" "200"
check "GET .../original -> conteúdo do arquivo real servido" "$(jget original_ok_tem_conteudo)" "true"
check "GET .../original (papel leitura, SEM exportar) -> 403" "$(jget original_sem_exportar_status)" "403"
check "GET .../original 403 -> erro=PERMISSAO_NEGADA" "$(jget original_sem_exportar_erro)" "PERMISSAO_NEGADA"
check "GET .../original (arquivo ausente no disco) -> 410 (CHK021 resolvido)" "$(jget original_ausente_status)" "410"
check "GET .../original 410 -> erro=ARQUIVO_INDISPONIVEL" "$(jget original_ausente_erro)" "ARQUIVO_INDISPONIVEL"

# 5.5
check "POST .../reprocessar (failed) -> 202" "$(jget reprocessar_status)" "202"
check "POST .../reprocessar -> body.status=pending" "$(jget reprocessar_body_status)" "pending"
check "POST .../reprocessar (completed) -> 409 CONFLITO" "$(jget reprocessar_409_status)" "409"
check "POST .../reprocessar 409 -> error=CONFLITO" "$(jget reprocessar_409_erro)" "CONFLITO"
check "POST .../reprocessar (papel leitura, SEM criar) -> 403" "$(jget reprocessar_sem_permissao_status)" "403"

# 5.6
check "POST .../cancelar (processing) -> 202" "$(jget cancelar_status)" "202"
check "POST .../cancelar -> body.status=cancelled" "$(jget cancelar_body_status)" "cancelled"
check "POST .../cancelar (completed) -> 409 CONFLITO" "$(jget cancelar_409_status)" "409"
check "POST .../cancelar 409 -> error=CONFLITO" "$(jget cancelar_409_erro)" "CONFLITO"
check "POST .../cancelar (papel leitura, SEM criar) -> 403" "$(jget cancelar_sem_permissao_status)" "403"

# ─────────────────────────────────────────────────────────────────────────────
# Validações no banco (DB) — 5.5.2 (limpeza de erros obsoletos), 5.7 (Auditoria)
# ─────────────────────────────────────────────────────────────────────────────
N_ERROS_OBSOLETOS="$(psql_t -tAc "SELECT count(*) FROM \"ImportacaoLinhaErro\" WHERE importacao_id=$ID_P9_REPROCESSAR" | tr -d '[:space:]')"
check "DB: reprocessar LIMPOU ImportacaoLinhaErro da tentativa anterior (5.5.2)" "$N_ERROS_OBSOLETOS" "0"

STATUS_P11_DB="$(psql_t -tAc "SELECT status FROM \"ImportacaoArquivo\" WHERE id=$ID_P11_CANCELAR" | tr -d '[:space:]')"
check "DB: p11 (processing) -> status=cancelled persistido" "$STATUS_P11_DB" "cancelled"

N_AUD_REPROCESSADA="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='importacao.reprocessada' AND recurso_id='$ID_P9_REPROCESSAR'" | tr -d '[:space:]')"
check "DB: Auditoria 'importacao.reprocessada' registrada (5.7.1)" "$([ "${N_AUD_REPROCESSADA:-0}" -ge 1 ] 2>/dev/null && echo sim || echo nao)" "sim"

N_AUD_CANCELADA="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='importacao.cancelada' AND recurso_id='$ID_P11_CANCELAR'" | tr -d '[:space:]')"
check "DB: Auditoria 'importacao.cancelada' registrada (5.7.2)" "$([ "${N_AUD_CANCELADA:-0}" -ge 1 ] 2>/dev/null && echo sim || echo nao)" "sim"

ID_REAL="$(jget id_real)"
N_AUD_ORIGINAL="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE acao='importacao.original_baixado' AND recurso_id='$ID_REAL'" | tr -d '[:space:]')"
check "DB: Auditoria 'importacao.original_baixado' registrada (5.7.3)" "$([ "${N_AUD_ORIGINAL:-0}" -ge 1 ] 2>/dev/null && echo sim || echo nao)" "sim"

echo
if [ "$fails" = "0" ]; then
  echo "HUB-IMPORTACOES-FASE5-INTEGRATION: OK — todos os asserts passaram (FASE 5: 5.1-5.8)"
else
  echo "HUB-IMPORTACOES-FASE5-INTEGRATION: $fails assert(s) FALHARAM" >&2
  exit 1
fi

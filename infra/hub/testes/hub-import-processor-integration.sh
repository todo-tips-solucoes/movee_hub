#!/usr/bin/env bash
# =============================================================================
# hub-import-processor-integration.sh — tasks.md FASE 4 (4.2.3/4.3.4/4.4.4/
# 4.6.3): prova E2E do processamento em lote (lib/hub-import-processor.js)
# contra um projeto hub-test EFÊMERO e descartável. Mesmo padrão de
# isolamento de infra/hub/testes/hub-importacoes-integration.sh (FASE 3) —
# nunca toca chatmasterveloz/produção; fixtures 100% sintéticas (nenhum dado
# real de cliente, LGPD).
#
# Cobre:
#   (a) upload faturamento + upload performance (dialetos distintos) ->
#       ambos completed, 100% linhas válidas
#   (b) reimportação da MESMA linha via um arquivo NOVO (bytes diferentes,
#       conteúdo lógico idêntico) -> dedupe por hash_linha, ZERO fatos novos
#       (idempotência de linha — requisito central US2, distinto do dedupe
#       de ARQUIVO já coberto pela FASE 3)
#   (c) cabeçalho errado -> failed, ZERO linhas persistidas (rollback "por
#       construção" — nenhuma linha é inserida antes da decisão de limiar)
#   (d) cancelamento REAL entre lotes: arquivo de 550 linhas (2 lotes:
#       500+50), `UPDATE ImportacaoArquivo SET status='cancelled'` disparado
#       entre os lotes via SQL direto (simula um futuro POST .../cancelar,
#       FASE 5) -> processor para no próximo "ponto seguro", só o 1º lote
#       (500 linhas) foi persistido
#
# Pré-requisito do cenário (d): HUB_IMPORT_TEST_LOTE_DELAY_MS (compose.hub.
# test.yml) — janela de teste OPCIONAL, ausente em dev/homolog/produção.
#
# Uso: infra/hub/testes/hub-import-processor-integration.sh
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

# Janela de teste do cenário (d): delay entre lotes generoso o bastante
# para o script bash (docker exec tem overhead de centenas de ms por
# chamada) conseguir extrair os ids e emitir o UPDATE de cancelamento antes
# do 2º lote (só 50 linhas) terminar. 2 lotes = 2 janelas de 3s = 6s de
# margem total — aceitável para um teste que já leva minutos por causa do
# build Docker.
export HUB_IMPORT_TEST_LOTE_DELAY_MS=3000

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
grep -q "0018_dedupe_erro_recuperacao_orfa.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas por completo"; cat "$TMP/migrate.log"; exit 1; }

# --- Seed: 1 Usuario operador (importacoes.criar) --------------------------
SENHA_OK='SenhaSinteticaProcessor#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

E_OP=940001
# Empresa DEDICADA ao cenário (d) — o mutex (research.md Decision 5 ADENDO)
# serializa por (id_empresa,tipo): se 'grande' competisse pelo mesmo
# (E_OP,'faturamento') dos cenários (a)/(b)/(c), ficaria enfileirado atrás
# deles e poderia terminar de processar (rápido, poucas linhas) ANTES do
# script conseguir emitir o cancelamento — like efetivamente observado numa
# 1ª rodada deste teste. Isolar em outra empresa garante que 'grande' inicia
# o processamento imediatamente após o upload, sem fila.
E_OP2=940002

psql_t <<SQL >/dev/null
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES
  ('processor-operador@example.test', '$HASH_OK', 'Usuario Teste Processor Operador', true);
SQL
UID_OP="$(psql_t -tAc "SELECT id FROM \"Usuario\" WHERE email='processor-operador@example.test'" | tr -d '[:space:]')"
PAPEL_OPERADOR="$(psql_t -tAc "SELECT id FROM \"Papel\" WHERE nome='operador'" | tr -d '[:space:]')"
[ -n "$PAPEL_OPERADOR" ] || { echo "FAIL: seed 0007 não populou o papel 'operador'"; exit 1; }

psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_OP, $E_OP, $PAPEL_OPERADOR, true),
  ($UID_OP, $E_OP2, $PAPEL_OPERADOR, true);
SQL

# ─────────────────────────────────────────────────────────────────────────────
# Script Node único: login + troca de entidade + uploads via FormData nativo.
# Fixtures CSV geradas a partir dos HEADER_* reais (nunca hardcoded) — evita
# drift silencioso entre o teste e o normalizador.
# ─────────────────────────────────────────────────────────────────────────────
OUT="$(run_node "$SENHA_OK" "$E_OP" "$E_OP2" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
const {
  HEADER_FATURAMENTO, HEADER_PERFORMANCE,
} = require('/var/lib/envioMassa_homologacao/app_homologacao/lib/hub-import-normalizer');

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
async function upload(jar, { tipo, nomeArquivo, conteudo, mime }) {
  const bytes = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(conteudo, 'utf8');
  const fd = new FormData();
  fd.append('tipo', tipo);
  fd.append('file', new Blob([bytes], { type: mime || 'text/csv' }), nomeArquivo);
  const r = await fetch(`${BASE}/importacoes`, { method: 'POST', headers: { Cookie: cookieHeader(jar) }, body: fd });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

function uuid(n) {
  const hex = n.toString(16).padStart(12, '0');
  return `11111111-1111-1111-1111-${hex}`;
}

// ── Fixture faturamento: N linhas válidas (dialeto decimal com vírgula) ───
function linhaFaturamento({ idx, valor = '100,00', recebedor, praca = 'SP', descricao }) {
  const campos = {
    data_do_lancamento_financeiro: '2026-01-05',
    data_do_periodo_de_referencia: '2026-01-01',
    data_do_repasse: '',
    periodo: 'SEMANAL',
    praca,
    subpraca: 'ZonaSul',
    origem: 'App',
    id_da_pessoa_entregadora: uuid(idx),
    recebedor: recebedor || `Entregador Sintetico ${idx}`,
    tipo: 'Credito',
    valor,
    descricao: descricao || `Repasse sintetico linha ${idx}`,
    atingido: '',
    percentual_de_tempo_disponivel: '',
    percentual_de_aceitacao: '',
    percentual_de_conclusao: '',
    criterio_tempo_disponivel: '',
    criterio_rotas_aceitas: '',
    criterio_rotas_concluidas: '',
    margem_fee_porcentagem: '',
  };
  return HEADER_FATURAMENTO.map((h) => campos[h]).join(';');
}

function csvFaturamento(nLinhas, opts = {}) {
  const linhas = [];
  for (let i = 1; i <= nLinhas; i += 1) linhas.push(linhaFaturamento({ idx: i, ...opts }));
  return [HEADER_FATURAMENTO.join(';'), ...linhas, ''].join('\n');
}

// ── Fixture performance: N linhas válidas (dialeto decimal com ponto) ─────
function linhaPerformance({ idx }) {
  const campos = {
    data_do_periodo: '2026-01-01',
    periodo: 'MANHA',
    duracao_do_periodo: '04:00:00',
    numero_minimo_de_entregadores_regulares_na_escala: '5',
    tag: '',
    id_da_pessoa_entregadora: uuid(1000 + idx),
    pessoa_entregadora: `Entregador Performance ${idx}`,
    praca: 'SP',
    sub_praca: 'ZonaSul',
    origem: 'App',
    tempo_disponivel_escalado: '95.5',
    tempo_disponivel_absoluto: '03:50:00',
    numero_de_corridas_ofertadas: '20',
    numero_de_corridas_aceitas: '18',
    numero_de_corridas_rejeitadas: '2',
    numero_de_corridas_completadas: '17',
    numero_de_corridas_canceladas_pela_pessoa_entregadora: '1',
    numero_de_pedidos_aceitos_e_concluidos: '17',
    soma_das_taxas_das_corridas_aceitas: '15000',
  };
  return HEADER_PERFORMANCE.map((h) => campos[h]).join(';');
}

function csvPerformance(nLinhas) {
  const linhas = [];
  for (let i = 1; i <= nLinhas; i += 1) linhas.push(linhaPerformance({ idx: i }));
  return [HEADER_PERFORMANCE.join(';'), ...linhas, ''].join('\n');
}

async function main() {
  const senha = process.argv[2];
  const empresaOp = Number(process.argv[3]);
  const empresaOp2 = Number(process.argv[4]);
  const out = {};

  let jar = await login('processor-operador@example.test', senha);
  jar = await trocarEntidade(jar, empresaOp);

  // (a) faturamento — 5 linhas 100% válidas
  const csvFat = csvFaturamento(5, { descricao: 'lote-a-fat' });
  const rFat = await upload(jar, { tipo: 'faturamento', nomeArquivo: 'faturamento-a.csv', conteudo: csvFat });
  out.fat_status = rFat.status;
  out.fat_id = rFat.body && rFat.body.id;

  // (a) performance — 4 linhas 100% válidas
  const csvPerf = csvPerformance(4);
  const rPerf = await upload(jar, { tipo: 'performance', nomeArquivo: 'performance-a.csv', conteudo: csvPerf });
  out.perf_status = rPerf.status;
  out.perf_id = rPerf.body && rPerf.body.id;

  // (b) MESMA linha lógica, arquivo com bytes diferentes: espaço à direita
  // no campo `recebedor` da 1ª linha (nunca vira uma linha de dados a mais
  // — `valorCampo`/normalizador fazem `.trim()`, então o hash_linha
  // computado é IDÊNTICO ao original; só o byte bruto do arquivo muda, o
  // suficiente pra alterar o sha256 do ARQUIVO e bypassar o 409 de dedupe
  // da FASE 3). `replace` de string exata (não regex) — substitui só a 1ª
  // ocorrência, evitando qualquer ambiguidade de casar `$` no meio da linha
  // (o campo `recebedor` NÃO é o último da grade — há 8 campos vazios
  // depois dele — logo um `$` de fim de linha nunca casaria aqui).
  const csvFatDup = csvFat.replace('Entregador Sintetico 1;', 'Entregador Sintetico 1 ;');
  if (csvFatDup === csvFat) throw new Error('fixture (b): replace não encontrou o alvo — csvFatDup ficou idêntico a csvFat');
  const rFatDup = await upload(jar, { tipo: 'faturamento', nomeArquivo: 'faturamento-a-renomeado.csv', conteudo: csvFatDup });
  out.fatdup_status = rFatDup.status;
  out.fatdup_id = rFatDup.body && rFatDup.body.id;

  // (c) cabeçalho errado -> failed, zero linhas
  const csvCabecalhoErrado = ['praca;recebedor;valor', 'SP;Fulano;100,00', ''].join('\n');
  const rCabecalho = await upload(jar, { tipo: 'faturamento', nomeArquivo: 'cabecalho-errado.csv', conteudo: csvCabecalhoErrado });
  out.cabecalho_status = rCabecalho.status;
  out.cabecalho_id = rCabecalho.body && rCabecalho.body.id;

  // (d) cancelamento entre lotes — 550 linhas (2 lotes: 500 + 50). Empresa
  // DEDICADA (empresaOp2): o mutex (Decision 5 ADENDO) serializa por
  // (id_empresa,tipo) — se competisse pelo mesmo (empresaOp,'faturamento')
  // dos cenários acima, ficaria enfileirado e poderia terminar de processar
  // (rápido, poucos lotes) ANTES do script conseguir cancelar.
  let jar2 = await trocarEntidade(jar, empresaOp2);
  const csvGrande = csvFaturamento(550, { descricao: 'lote-d-cancelamento' });
  const rGrande = await upload(jar2, { tipo: 'faturamento', nomeArquivo: 'faturamento-cancelamento.csv', conteudo: csvGrande });
  out.grande_status = rGrande.status;
  out.grande_id = rGrande.body && rGrande.body.id;

  console.log('___RESULT_JSON___' + JSON.stringify(out));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT" | grep -v '___RESULT_JSON___' || true
RESULT_LINE="$(echo "$OUT" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
[ -n "$RESULT_LINE" ] || { echo "FAIL: script Node não retornou resultado"; echo "$OUT"; exit 1; }

# Extração em 1 ÚNICO docker-exec (em vez de 10 chamadas `jget` sequenciais,
# cada uma com overhead de `docker compose exec`): minimiza o tempo entre o
# upload de 'grande' (cenário d) e o início do poll de cancelamento — cada
# exec extra custava ~300-800ms, tempo suficiente para o arquivo de 550
# linhas (numa empresa dedicada, sem fila de mutex) terminar de processar
# ANTES do script conseguir cancelá-lo.
IDS_TSV="$(printf '%s' "$RESULT_LINE" | node_e "
  const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const campos = ['fat_status','fat_id','perf_status','perf_id','fatdup_status','fatdup_id','cabecalho_status','cabecalho_id','grande_status','grande_id'];
  process.stdout.write(campos.map((c) => String(d[c])).join('\t'));
")"
IFS=$'\t' read -r FAT_STATUS_UPLOAD FAT_ID PERF_STATUS_UPLOAD PERF_ID FATDUP_STATUS_UPLOAD FATDUP_ID CABECALHO_STATUS_UPLOAD CABECALHO_ID GRANDE_STATUS_UPLOAD GRANDE_ID <<< "$IDS_TSV"

check "upload faturamento (a) -> 201" "$FAT_STATUS_UPLOAD" "201"
check "upload performance (a) -> 201" "$PERF_STATUS_UPLOAD" "201"
check "upload faturamento duplicado por linha (b) -> 201 (hash de ARQUIVO difere)" "$FATDUP_STATUS_UPLOAD" "201"
check "upload cabeçalho errado (c) -> 201 (validação de header é do PROCESSOR, não do upload)" "$CABECALHO_STATUS_UPLOAD" "201"
check "upload arquivo grande p/ cancelamento (d) -> 201" "$GRANDE_STATUS_UPLOAD" "201"

# ─────────────────────────────────────────────────────────────────────────────
# Polling: processamento é assíncrono (fire-and-forget) — aguarda status
# terminal em cada ImportacaoArquivo antes de checar os efeitos no banco.
# ─────────────────────────────────────────────────────────────────────────────
aguardar_status() { # aguardar_status <id> <timeout_segundos>
  local id="$1" timeout="${2:-30}" decorrido=0 st=""
  while [ "$decorrido" -lt "$timeout" ]; do
    st="$(psql_t -tAc "SELECT status FROM \"ImportacaoArquivo\" WHERE id=$id" | tr -d '[:space:]')"
    case "$st" in
      completed|completed_with_errors|failed|cancelled) printf '%s' "$st"; return 0 ;;
    esac
    sleep 1
    decorrido=$((decorrido + 1))
  done
  printf '%s' "$st"
  return 1
}

# ── (d) DISPARO do cancelamento — feito AGORA, antes de qualquer outra
# checagem/poll (a)/(b)/(c) abaixo. 'grande' está numa empresa DEDICADA
# (empresaOp2, sem fila de mutex) e com HUB_IMPORT_TEST_LOTE_DELAY_MS entre
# lotes (padrão 3000ms) — mas qualquer atraso do script bash aqui (ex.:
# rodar as checagens de (a)/(b)/(c) primeiro, cada uma com overhead de
# `docker exec`) arrisca perder a janela inteira. Por isso o disparo do
# cancelamento é a PRIMEIRA coisa feita após extrair os ids (1 único
# docker-exec acima) — validado empiricamente: sem esta ordem + a janela de
# 3s, a corrida se perdia (arquivo terminava de processar antes do cancel).
decorrido=0
while [ "$decorrido" -lt 40 ]; do
  st="$(psql_t -tAc "SELECT status FROM \"ImportacaoArquivo\" WHERE id=$GRANDE_ID" | tr -d '[:space:]')"
  [ "$st" = "processing" ] && break
  case "$st" in completed|completed_with_errors|failed|cancelled) break ;; esac
  sleep 0.2
  decorrido=$((decorrido + 1))
done
# Emite o cancelamento assim que vê `processing` (ou tenta mesmo assim, caso
# tenha corrido rápido demais — o WHERE status='processing' garante no-op
# seguro se já tiver terminado, sem corromper o resultado do teste).
psql_t -c "UPDATE \"ImportacaoArquivo\" SET status='cancelled' WHERE id=$GRANDE_ID AND status='processing';" >/dev/null

ST_FAT="$(aguardar_status "$FAT_ID" 30)"
check "(a) faturamento processa até status terminal em <=30s" "$ST_FAT" "completed"

ST_PERF="$(aguardar_status "$PERF_ID" 30)"
check "(a) performance processa até status terminal em <=30s" "$ST_PERF" "completed"

N_FAT_ANTES="$(psql_t -tAc "SELECT count(*) FROM \"FaturamentoLancamento\" WHERE importacao_id=$FAT_ID" | tr -d '[:space:]')"
check "(a) 5 linhas de faturamento persistidas (100% válidas)" "$N_FAT_ANTES" "5"

N_PERF="$(psql_t -tAc "SELECT count(*) FROM \"PerformanceTurno\" WHERE importacao_id=$PERF_ID" | tr -d '[:space:]')"
check "(a) 4 linhas de performance persistidas (100% válidas)" "$N_PERF" "4"

ST_FATDUP="$(aguardar_status "$FATDUP_ID" 30)"
check "(b) reimportação por conteúdo idêntico também completa (parse ok)" "$ST_FATDUP" "completed"
N_FATDUP="$(psql_t -tAc "SELECT count(*) FROM \"FaturamentoLancamento\" WHERE importacao_id=$FATDUP_ID" | tr -d '[:space:]')"
check "(b) ZERO fatos novos p/ hash_linha idêntico (dedupe por linha, US2)" "$N_FATDUP" "0"
N_TOTAL_EMPRESA_FAT="$(psql_t -tAc "SELECT count(*) FROM \"FaturamentoLancamento\" WHERE id_empresa=$E_OP" | tr -d '[:space:]')"
check "(b) total de fatos da empresa NÃO cresceu com a reimportação" "$N_TOTAL_EMPRESA_FAT" "5"

ST_CABECALHO="$(aguardar_status "$CABECALHO_ID" 30)"
check "(c) cabeçalho errado -> failed" "$ST_CABECALHO" "failed"
N_CABECALHO="$(psql_t -tAc "SELECT count(*) FROM \"FaturamentoLancamento\" WHERE importacao_id=$CABECALHO_ID" | tr -d '[:space:]')"
check "(c) ZERO linhas persistidas com cabeçalho errado" "$N_CABECALHO" "0"
ERRO_RESUMO="$(psql_t -tAc "SELECT erro_resumo FROM \"ImportacaoArquivo\" WHERE id=$CABECALHO_ID" | tr -d '\n')"
case "$ERRO_RESUMO" in
  *cabeçalho*|*cabecalho*) echo "PASS: (c) erro_resumo explica o motivo (cabeçalho)";;
  *) echo "FAIL: (c) erro_resumo não menciona cabeçalho (obtido: $ERRO_RESUMO)"; fails=$((fails + 1));;
esac

# ── (d) cancelamento entre lotes — o DISPARO já ocorreu logo acima (antes
# das checagens de (a)/(b)/(c)); aqui só aguarda o status terminal refletir
# o efeito e confirma os contadores.
ST_GRANDE="$(aguardar_status "$GRANDE_ID" 30)"
check "(d) cancelamento entre lotes -> status final cancelled" "$ST_GRANDE" "cancelled"
N_GRANDE="$(psql_t -tAc "SELECT count(*) FROM \"FaturamentoLancamento\" WHERE importacao_id=$GRANDE_ID" | tr -d '[:space:]')"
case "$N_GRANDE" in
  500) echo "PASS: (d) exatamente 1 lote (500 linhas) persistido antes da interrupção";;
  550) echo "FAIL: (d) processou os 2 lotes — cancelamento não interrompeu a tempo (corrida perdida; considerar aumentar HUB_IMPORT_TEST_LOTE_DELAY_MS)"; fails=$((fails + 1));;
  *) echo "FAIL: (d) contagem inesperada de linhas persistidas: $N_GRANDE (esperado 500)"; fails=$((fails + 1));;
esac

# ─────────────────────────────────────────────────────────────────────────────
# (e) F13 (pós-review PR #57) — dedupe de ImportacaoLinhaErro (migration
# 0018): sobe 1 arquivo com 1 linha inválida conhecida (gera exatamente 1
# ImportacaoLinhaErro), depois simula um RETRY do MESMO POST diretamente
# contra o Postgres (mesma forma que `inserirLoteErros` faz via PostgREST —
# on_conflict=importacao_id,numero_linha DO NOTHING) e confirma que a
# contagem de linhas de erro NÃO cresce.
# ─────────────────────────────────────────────────────────────────────────────
E_OP3=940003
psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_OP, $E_OP3, $PAPEL_OPERADOR, true);
SQL

OUT_E="$(run_node "$SENHA_OK" "$E_OP3" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
const { HEADER_FATURAMENTO } = require('/var/lib/envioMassa_homologacao/app_homologacao/lib/hub-import-normalizer');

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
async function upload(jar, { tipo, nomeArquivo, conteudo }) {
  const fd = new FormData();
  fd.append('tipo', tipo);
  fd.append('file', new Blob([Buffer.from(conteudo, 'utf8')], { type: 'text/csv' }), nomeArquivo);
  const r = await fetch(`${BASE}/importacoes`, { method: 'POST', headers: { Cookie: cookieHeader(jar) }, body: fd });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}
function linhaValida(idx) {
  const c = {
    data_do_lancamento_financeiro: '2026-01-05', data_do_periodo_de_referencia: '2026-01-01', data_do_repasse: '',
    periodo: 'SEMANAL', praca: 'SP', subpraca: 'ZonaSul', origem: 'App',
    id_da_pessoa_entregadora: `11111111-1111-1111-1111-${idx.toString(16).padStart(12, '0')}`,
    recebedor: `Entregador F13 ${idx}`, tipo: 'Credito', valor: '50,00', descricao: `linha-f13-${idx}`,
    atingido: '', percentual_de_tempo_disponivel: '', percentual_de_aceitacao: '', percentual_de_conclusao: '',
    criterio_tempo_disponivel: '', criterio_rotas_aceitas: '', criterio_rotas_concluidas: '', margem_fee_porcentagem: '',
  };
  return HEADER_FATURAMENTO.map((h) => c[h]).join(';');
}
function linhaInvalida() {
  // recebedor E valor ausentes/inválidos -> 2 erros na MESMA numero_linha
  // (prova que o índice único (importacao_id,numero_linha) — não
  // (importacao_id,numero_linha,campo) — é o comportamento aceito por
  // desenho, ver comentário da migration 0018).
  const c = {
    data_do_lancamento_financeiro: '2026-01-05', data_do_periodo_de_referencia: '2026-01-01', data_do_repasse: '',
    periodo: 'SEMANAL', praca: 'SP', subpraca: 'ZonaSul', origem: 'App',
    id_da_pessoa_entregadora: '', recebedor: '', tipo: 'Credito', valor: 'xx', descricao: 'linha-f13-invalida',
    atingido: '', percentual_de_tempo_disponivel: '', percentual_de_aceitacao: '', percentual_de_conclusao: '',
    criterio_tempo_disponivel: '', criterio_rotas_aceitas: '', criterio_rotas_concluidas: '', margem_fee_porcentagem: '',
  };
  return HEADER_FATURAMENTO.map((h) => c[h]).join(';');
}
async function main() {
  const senha = process.argv[2];
  const empresa = Number(process.argv[3]);
  let jar = await login('processor-operador@example.test', senha);
  jar = await trocarEntidade(jar, empresa);
  const csv = [HEADER_FATURAMENTO.join(';'), linhaValida(1), linhaInvalida(), ''].join('\n');
  const r = await upload(jar, { tipo: 'faturamento', nomeArquivo: 'f13-dedupe.csv', conteudo: csv });
  console.log('___RESULT_JSON___' + JSON.stringify({ status: r.status, id: r.body && r.body.id }));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT_E" | grep -v '___RESULT_JSON___' || true
F13_LINE="$(echo "$OUT_E" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
F13_ID="$(printf '%s' "$F13_LINE" | node_e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).id)")"
check "(e) upload F13 (1 válida + 1 inválida) -> 201" "$(printf '%s' "$F13_LINE" | node_e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)")" "201"

ST_F13="$(aguardar_status "$F13_ID" 30)"
check "(e) F13: importação processa até terminal" "$ST_F13" "completed_with_errors"

N_ERROS_ANTES="$(psql_t -tAc "SELECT count(*) FROM \"ImportacaoLinhaErro\" WHERE importacao_id=$F13_ID" | tr -d '[:space:]')"
echo "INFO: (e) F13 — ${N_ERROS_ANTES} linha(s) de erro após 1ª gravação (importacao_id=$F13_ID)"

# Simula o RETRY: reinsere a MESMA linha de erro já existente, com o MESMO
# on_conflict/DO NOTHING que `inserirLoteErros` usa via PostgREST — prova a
# garantia de fato (índice único da migration 0018), não só que o CLIENTE
# manda o header certo (isso já é coberto pelo unit test).
psql_t <<SQL >/dev/null
INSERT INTO "ImportacaoLinhaErro" (importacao_id, id_empresa, numero_linha, motivo, campo, valor_mascarado)
SELECT importacao_id, id_empresa, numero_linha, motivo, campo, valor_mascarado
FROM "ImportacaoLinhaErro" WHERE importacao_id=$F13_ID
ON CONFLICT (importacao_id, numero_linha) DO NOTHING;
SQL
N_ERROS_DEPOIS="$(psql_t -tAc "SELECT count(*) FROM \"ImportacaoLinhaErro\" WHERE importacao_id=$F13_ID" | tr -d '[:space:]')"
check "(e) F13: retry do mesmo (importacao_id,numero_linha) NÃO duplica (índice único + on_conflict)" "$N_ERROS_DEPOIS" "$N_ERROS_ANTES"

# ─────────────────────────────────────────────────────────────────────────────
# (f) F1.3 (pós-review PR #57) — recuperação de lock órfão no boot: força um
# registro em `processing` via SQL direto (simula um processo morto no meio
# do processamento, sem passar pelo mutex) e chama
# `recuperarImportacoesOrfas` diretamente no backend efêmero (MESMO código
# desta branch, buildado no início deste script) — confirma que ele vira
# `failed` E que o mutex (índice único parcial, 0011) libera: um upload NOVO
# do MESMO (id_empresa,tipo) é aceito e processa normalmente depois.
# ─────────────────────────────────────────────────────────────────────────────
E_OP4=940004
HASH_ORFA="$(printf 'orfa-boot-teste' | sha256sum | cut -d' ' -f1)"
# INSERT sem RETURNING (saída para /dev/null) + SELECT separado para pegar o
# id — `psql -tAc` com RETURNING também imprime o tag de comando ("INSERT 0
# 1") numa linha subsequente; combinado com `tr -d '[:space:]'` isso
# corrompe a captura (ex.: "7INSERT01"). Mesmo padrão já usado acima no
# script para UID_OP/PAPEL_OPERADOR.
psql_t <<SQL >/dev/null
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, nome_arquivo, hash_sha256, status)
VALUES ($E_OP4, 'faturamento', 'orfa-boot-teste.csv', '$HASH_ORFA', 'processing');
SQL
ORFA_ID="$(psql_t -tAc "SELECT id FROM \"ImportacaoArquivo\" WHERE id_empresa=$E_OP4 AND nome_arquivo='orfa-boot-teste.csv'" | tr -d '[:space:]')"
[ -n "$ORFA_ID" ] || { echo "FAIL: (f) não conseguiu inserir a linha órfã sintética"; fails=$((fails + 1)); }

RECUP_OUT="$(dc exec -T backend node -e "
require('./lib/hub-import-processor').recuperarImportacoesOrfas()
  .then((r) => { console.log('___RECUP_JSON___' + JSON.stringify(r)); process.exit(0); })
  .catch((e) => { console.error('RECUP_ERROR', e); process.exit(1); });
" 2>&1)"
echo "$RECUP_OUT" | grep -v '___RECUP_JSON___' || true
RECUP_LINE="$(echo "$RECUP_OUT" | grep '___RECUP_JSON___' | sed 's/^___RECUP_JSON___//')"
[ -n "$RECUP_LINE" ] || { echo "FAIL: (f) recuperarImportacoesOrfas não retornou resultado"; fails=$((fails + 1)); }
RECUP_TOTAL="$(printf '%s' "$RECUP_LINE" | node_e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).totalRecuperadas)" 2>/dev/null)"
case "$RECUP_TOTAL" in
  ''|0) echo "FAIL: (f) totalRecuperadas esperado >=1, obtido '$RECUP_TOTAL'"; fails=$((fails + 1));;
  *) echo "PASS: (f) recuperarImportacoesOrfas recuperou $RECUP_TOTAL importação(ões)";;
esac

ST_ORFA="$(psql_t -tAc "SELECT status FROM \"ImportacaoArquivo\" WHERE id=$ORFA_ID" | tr -d '[:space:]')"
check "(f) linha órfã (processing) -> failed após recuperarImportacoesOrfas" "$ST_ORFA" "failed"
ERRO_ORFA="$(psql_t -tAc "SELECT erro_resumo FROM \"ImportacaoArquivo\" WHERE id=$ORFA_ID" | tr -d '\n')"
case "$ERRO_ORFA" in
  *reinicio*|*reinício*) echo "PASS: (f) erro_resumo explica a recuperação (reinício)";;
  *) echo "FAIL: (f) erro_resumo inesperado: '$ERRO_ORFA'"; fails=$((fails + 1));;
esac

# Mutex liberado: upload NOVO do MESMO (id_empresa,tipo) precisa ser aceito
# (índice único parcial 0011 só bloqueia se ainda houvesse uma linha
# validating/processing — a órfã virou failed, terminal).
psql_t <<SQL >/dev/null
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo) VALUES
  ($UID_OP, $E_OP4, $PAPEL_OPERADOR, true);
SQL
OUT_F="$(run_node "$SENHA_OK" "$E_OP4" <<'JS'
const BASE = 'http://localhost:3000/api/v1';
const { HEADER_FATURAMENTO } = require('/var/lib/envioMassa_homologacao/app_homologacao/lib/hub-import-normalizer');
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
async function main() {
  const senha = process.argv[2];
  const empresa = Number(process.argv[3]);
  let jar = await login('processor-operador@example.test', senha);
  jar = await trocarEntidade(jar, empresa);
  const c = {
    data_do_lancamento_financeiro: '2026-01-05', data_do_periodo_de_referencia: '2026-01-01', data_do_repasse: '',
    periodo: 'SEMANAL', praca: 'SP', subpraca: 'ZonaSul', origem: 'App',
    id_da_pessoa_entregadora: '11111111-1111-1111-1111-000000000f01',
    recebedor: 'Entregador Pos Recuperacao', tipo: 'Credito', valor: '10,00', descricao: 'pos-recuperacao',
    atingido: '', percentual_de_tempo_disponivel: '', percentual_de_aceitacao: '', percentual_de_conclusao: '',
    criterio_tempo_disponivel: '', criterio_rotas_aceitas: '', criterio_rotas_concluidas: '', margem_fee_porcentagem: '',
  };
  const csv = [HEADER_FATURAMENTO.join(';'), HEADER_FATURAMENTO.map((h) => c[h]).join(';'), ''].join('\n');
  const fd = new FormData();
  fd.append('tipo', 'faturamento');
  fd.append('file', new Blob([Buffer.from(csv, 'utf8')], { type: 'text/csv' }), 'pos-recuperacao.csv');
  const r = await fetch(`${BASE}/importacoes`, { method: 'POST', headers: { Cookie: cookieHeader(jar) }, body: fd });
  const body = await r.json().catch(() => null);
  console.log('___RESULT_JSON___' + JSON.stringify({ status: r.status, id: body && body.id }));
}
main().catch((e) => { console.error('SCRIPT_ERROR', e); process.exit(1); });
JS
)"
echo "$OUT_F" | grep -v '___RESULT_JSON___' || true
F_LINE="$(echo "$OUT_F" | grep '___RESULT_JSON___' | sed 's/^___RESULT_JSON___//')"
POS_STATUS="$(printf '%s' "$F_LINE" | node_e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).status)" 2>/dev/null)"
check "(f) upload NOVO do mesmo (id_empresa,tipo) da órfã -> 201 (mutex liberado)" "$POS_STATUS" "201"
POS_ID="$(printf '%s' "$F_LINE" | node_e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).id)" 2>/dev/null)"
if [ -n "$POS_ID" ] && [ "$POS_ID" != "undefined" ] && [ "$POS_ID" != "null" ]; then
  ST_POS="$(aguardar_status "$POS_ID" 30)"
  check "(f) upload pós-recuperação processa normalmente até terminal" "$ST_POS" "completed"
fi

echo
if [ "$fails" = "0" ]; then
  echo "HUB-IMPORT-PROCESSOR-INTEGRATION: OK — todos os asserts passaram (FASE 4: 4.1-4.6 + pós-review PR #57 F1/F5/F13)"
else
  echo "HUB-IMPORT-PROCESSOR-INTEGRATION: $fails assert(s) FALHARAM" >&2
  exit 1
fi

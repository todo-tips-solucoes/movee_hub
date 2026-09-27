#!/usr/bin/env bash
# =============================================================================
# hub-adiantamentos-smoke-full-chain-integration.sh — tasks.md 10.7.1
# (feature "Adiantamento pelo App, Dados Bancários e Exportação Transfeera"):
# fumaça da cadeia INTEIRA do lado do hub, sem simulação nenhuma —
# autentica via HTTP real contra o backend (Dockerfile.hub, build real),
# que fala com o PostgREST/Postgres efêmeros do MESMO stack `hub-test-*`.
# Nenhuma chamada é mockada em nenhuma camada (dec-122: os drivers de
# navegador existentes interceptam `/api/**`; hub-adiantamentos-integration.sh
# chama as RPCs SQL direto, pulando o Node/HTTP — nenhum dos dois exercita a
# corrente inteira junta).
#
# Cobre (10.7.1):
#   - login real (POST /api/v1/auth/login) + troca de entidade
#     (POST /api/v1/me/entidade) — cookies httpOnly de verdade
#   - GET /api/v1/adiantamentos (listar solicitações) via HTTP real
#   - POST /api/v1/adiantamentos/lotes (gerar lote pequeno, 1 item) — exercita
#     Express -> PostgREST -> Postgres -> geração do .xlsx real dentro do Node
#   - GET /api/v1/adiantamentos/lotes/:id/arquivo (baixar o arquivo binário)
#   - confere que o CONTEÚDO do arquivo baixado bate com o que a API informou
#     na criação (quantidade e soma), reaproveitando o MESMO validador que o
#     backend usa (lib/adiantamento-transfeera-xlsx.js#validarPlanilhaTransfeera)
#     — não uma soma reimplementada aqui, e sim o contrato real.
#
# 10.7.2 (equivalente no app motorista) fica EXPLICITAMENTE pendente — fora
# do orçamento desta onda (ver tasks.md 10.7.2).
#
# Uso: infra/hub/testes/hub-adiantamentos-smoke-full-chain-integration.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)-$$"
PROJECT="hub-test-$RUNID"
TMP="$(mktemp -d)"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
cleanup() { dc down -v --rmi local --remove-orphans >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }

echo "subindo db+postgrest+mailpit-mock+backend efêmeros ($PROJECT)…"
dc up -d --wait db
dc up -d --wait postgrest
dc up -d --wait mailpit-mock
# Cap de memória obrigatório no build (RUNBOOK.md — lição de starvation 2026-06-11).
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend (Dockerfile.hub)"; tail -60 "$TMP/build.log"; exit 1; }
dc up -d --wait backend

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }
node_e() { dc exec -T backend node -e "$1" "${@:2}"; }

fails=0
check() { # check <descricao> <valor-obtido> <valor-esperado>
  if [ "$2" = "$3" ]; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 (obtido='$2' esperado='$3')"
    fails=$((fails + 1))
  fi
}

echo "aplicando migrations (série completa, inclui 0070 — módulo adiantamentos + ModuloEntidade empresa 6)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0070_modulo_adiantamentos.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas até 0070"; cat "$TMP/migrate.log"; exit 1; }

SENHA_OK='SenhaSinteticaAdiantamento#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

# --- fixtures: usuário financeiro (empresa 6, papel já seedado pela 0070 com
# as 10 permissões de adiantamentos) + motorista com conta bancária APROVADA
# + 1 solicitação LIBERADA (config v1 da própria 0070, empresa 6) ----------
psql_t -v ON_ERROR_STOP=1 <<SQL >"$TMP/seed.log" 2>&1
INSERT INTO "Usuario" (email, senha_hash, nome, ativo) VALUES ('financeiro.smoke@example.test', '$HASH_OK', 'Financeiro Smoke', true);
INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo)
  VALUES ((SELECT id FROM "Usuario" WHERE email='financeiro.smoke@example.test'), 6, (SELECT id FROM "Papel" WHERE nome='financeiro'), true);
INSERT INTO "ContaMotorista" (cnpj_prestador, nome, ativo) VALUES ('44444444000102', 'Smoke Full Chain', true);
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id)
  VALUES (6, gen_random_uuid(), 'Smoke Full Chain', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='44444444000102'));
INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta, entregador_confirmado_id, revisada_em)
  VALUES (6, (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='44444444000102')), 'CARGA_INICIAL', 'APROVADA', 'Smoke Full Chain', '11122233344', 'PF', '001', 'Banco do Brasil', '1234', '00055555', '9', 'CORRENTE', (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='44444444000102')), now());
INSERT INTO "AdiantamentoSolicitacao" (id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id, data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia, valor_liquido, conta_bancaria_id)
  VALUES (6, (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='44444444000102'), '44444444000102',
    (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='44444444000102')),
    (SELECT id FROM "AdiantamentoConfiguracao" WHERE id_empresa=6 AND versao=1),
    current_date, current_date - 1, repeat('a',64), 'LIBERADA', gen_random_uuid(), 100.00,
    (SELECT id FROM "ContaBancariaMotorista" WHERE entregador_id=(SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='44444444000102')) AND status='APROVADA'));
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed deu erro"; cat "$TMP/seed.log"; exit 1; fi
SOLICITACAO_ID="$(psql_t -tAc "SELECT id FROM \"AdiantamentoSolicitacao\" WHERE cnpj_prestador='44444444000102';" | tr -d '[:space:]')"
[ -n "$SOLICITACAO_ID" ] || { echo "FAIL: solicitação de fixture não foi criada"; exit 1; }
check "seed: solicitação LIBERADA criada (id=$SOLICITACAO_ID)" "0" "0"

# --- cadeia inteira via HTTP real, dentro do container backend (localhost:3000
# ali É o próprio processo Express) — login, troca de entidade, listar,
# gerar lote, baixar arquivo, validar conteúdo com o MESMO validador do
# backend (lib/adiantamento-transfeera-xlsx.js), tudo numa única execução
# Node para não serializar bytes binários por fora do processo. ------------
SMOKE_OUT="$(dc exec -T backend node - "$SENHA_OK" "$SOLICITACAO_ID" <<'JS' 2>&1
'use strict';
function parseSetCookie(res) {
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const jar = {};
  for (const c of raw) {
    const [pair] = c.split(';');
    const idx = pair.indexOf('=');
    jar[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }

async function main() {
  const senha = process.argv[2];
  const solicitacaoId = Number(process.argv[3]);
  const out = {};

  const rLogin = await fetch('http://localhost:3000/api/v1/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'financeiro.smoke@example.test', senha }),
  });
  out.login_status = rLogin.status;
  let jar = parseSetCookie(rLogin);

  const rTroca = await fetch('http://localhost:3000/api/v1/me/entidade', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ empresa_id: 6 }),
  });
  out.troca_status = rTroca.status;
  jar = { ...jar, ...parseSetCookie(rTroca) };

  const rLista = await fetch('http://localhost:3000/api/v1/adiantamentos', { headers: { Cookie: cookieHeader(jar) } });
  const bLista = await rLista.json();
  out.lista_status = rLista.status;
  const itemNaLista = (bLista.itens || []).find((i) => i.id === solicitacaoId);
  out.lista_contem_solicitacao = itemNaLista ? 'true' : 'false';
  out.lista_status_solicitacao = itemNaLista ? itemNaLista.status : null;

  const chave = require('crypto').randomUUID(); // hub_adiantamento_lote_criar exige p_chave uuid
  const rLote = await fetch('http://localhost:3000/api/v1/adiantamentos/lotes', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({
      ids: [solicitacaoId], quantidadeEsperada: 1, totalEsperado: '100.00', chaveIdempotencia: chave,
    }),
  });
  const bLote = await rLote.json();
  out.lote_status = rLote.status;
  out.lote_id = bLote.id;
  out.lote_quantidade = bLote.quantidade;
  out.lote_valor_total = bLote.valorTotal;

  const rArquivo = await fetch(`http://localhost:3000/api/v1/adiantamentos/lotes/${bLote.id}/arquivo`, { headers: { Cookie: cookieHeader(jar) } });
  out.arquivo_status = rArquivo.status;
  out.arquivo_content_type = rArquivo.headers.get('content-type');
  const buf = Buffer.from(await rArquivo.arrayBuffer());
  out.arquivo_bytes = buf.length;

  // Reaproveita o MESMO validador que o backend usa ao criar o lote — não
  // uma soma reimplementada aqui — para conferir que o CONTEÚDO baixado
  // bate com o que a API informou (quantidade e soma, em centavos).
  const { validarPlanilhaTransfeera } = require('./lib/adiantamento-transfeera-xlsx');
  const { paraCentavos } = require('./lib/adiantamento-remanescente');
  const contrato = require('./lib/fixtures/transfeera-contrato.json');
  const validacao = validarPlanilhaTransfeera(buf, contrato, {
    quantidade: bLote.quantidade,
    valorTotal: paraCentavos(bLote.valorTotal),
    idsIntegracao: undefined,
  });
  out.validacao_ok = validacao.ok;
  out.validacao_falhas = validacao.falhas;

  // Detalhe da solicitação COM lote já criado: é o embed
  // `lote:AdiantamentoLote(...)` que o incidente de 2026-09-22 derrubou com
  // `select=*` — o GRANT de AdiantamentoLote é por COLUNA e exclui `arquivo`,
  // então `*` faz o Postgres negar a query inteira (42501). Nenhum unit test
  // pega: eles mockam o PostgREST. Só a cadeia HTTP real pega.
  const rDetalhe = await fetch(`http://localhost:3000/api/v1/adiantamentos/${solicitacaoId}`, { headers: { Cookie: cookieHeader(jar) } });
  out.detalhe_status = rDetalhe.status;
  const bDetalhe = rDetalhe.status === 200 ? await rDetalhe.json() : {};
  out.detalhe_tem_lote = Array.isArray(bDetalhe.lotes) && bDetalhe.lotes.length > 0 ? 'true' : 'false';
  out.detalhe_lote_sem_bytes_do_arquivo = bDetalhe.lotes && bDetalhe.lotes[0]
    ? (bDetalhe.lotes[0].arquivo === undefined ? 'true' : 'false') : 'null';

  process.stdout.write(JSON.stringify(out));
}
main().catch((e) => { console.error('ERRO:', e && e.stack || e); process.exit(1); });
JS
)"
echo "$SMOKE_OUT" > "$TMP/smoke.json"
SMOKE_JSON="$(tail -n1 "$TMP/smoke.json")"

G() { printf '%s' "$SMOKE_JSON" | jq -r --arg k "$1" '.[$k] // "null" | tostring'; }

check "10.7.1: login real -> 200" "$(G login_status)" "200"
check "10.7.1: troca de entidade real -> 200" "$(G troca_status)" "200"
check "10.7.1: GET /adiantamentos (lista real) -> 200" "$(G lista_status)" "200"
check "10.7.1: solicitação de fixture aparece na listagem real" "$(G lista_contem_solicitacao)" "true"
check "10.7.1: status da solicitação na listagem real -> LIBERADA" "$(G lista_status_solicitacao)" "LIBERADA"
check "10.7.1: POST /lotes (gerar lote real, 1 item) -> 201" "$(G lote_status)" "201"
check "10.7.1: lote real -> quantidade=1" "$(G lote_quantidade)" "1"
check "10.7.1: lote real -> valorTotal='100.00' (bate com o esperado enviado)" "$(G lote_valor_total)" "100.00"
check "10.7.1: GET /lotes/:id/arquivo (download real) -> 200" "$(G arquivo_status)" "200"
check "10.7.1: download real -> Content-Type xlsx" "$(G arquivo_content_type)" "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
BYTES="$(G arquivo_bytes)"
check "10.7.1: download real -> arquivo não vazio" "$([ "${BYTES:-0}" -gt 0 ] 2>/dev/null && echo true || echo false)" "true"
check "10.7.1: conteúdo baixado bate com o informado pela API (quantidade e soma, validador real)" "$(G validacao_ok)" "true"

# Incidente 2026-09-22: o detalhe devolvia 500 ("permission denied for table
# AdiantamentoLote") porque o embed pedia `select=*` numa tabela cujo GRANT é
# por COLUNA. O smoke cobria lista e download, mas NÃO o detalhe — foi por esse
# buraco que o defeito chegou à produção.
check "10.7.1: GET /adiantamentos/:id (detalhe real, com lote) -> 200" "$(G detalhe_status)" "200"
check "10.7.1: detalhe real traz o lote no embed" "$(G detalhe_tem_lote)" "true"
check "10.7.1: detalhe real NÃO devolve os bytes do arquivo (dec-023/CHK010)" "$(G detalhe_lote_sem_bytes_do_arquivo)" "true"

echo ""
echo "===================================================================="
echo "RESULTADO: $fails falha(s)"
echo "===================================================================="
echo "$SMOKE_JSON"
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)

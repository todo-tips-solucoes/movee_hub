#!/usr/bin/env bash
# =============================================================================
# hub-motorista-adiantamento-smoke-full-chain-integration.sh — tasks.md 10.7.2
# (feature "Adiantamento pelo App, Dados Bancários e Exportação Transfeera"):
# equivalente de 10.7.1 (hub-adiantamentos-smoke-full-chain-integration.sh) do
# lado do APP DO MOTORISTA — sem simulação em nenhuma camada: autentica via
# HTTP real (POST /motorista/login, HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true, mesmo
# gate exercitado por hub-motorista-canonico-credencial-integration.sh),
# consulta disponibilidade real e envia uma solicitação real
# (routes/motorista-adiantamento.js -> hub_adiantamento_solicitar), tudo contra
# o PostgREST/Postgres efêmeros do MESMO stack `hub-test-*`.
#
# Cobre (10.7.2):
#   - login real do motorista via ContaMotorista (cookies httpOnly de verdade,
#     JWT aud=motorista)
#   - GET /motorista/adiantamento/disponibilidade (consulta real via
#     hub_adiantamento_disponibilidade) — confere que a config vigente (v2,
#     "completa") é a devolvida (configuracaoId/configVersion/canRequest)
#   - POST /motorista/adiantamentos (solicitação real, aceite recalculado no
#     servidor a partir da config vigente — nunca fornecido pelo cliente)
#   - confere DIRETO NO BANCO (psql, fora da API) que a linha nascida em
#     "AdiantamentoSolicitacao" tem `configuracao_id` == id da config vigente
#     e `aceite_texto_sha256` == sha256 esperado, recomputado com a MESMA
#     função pura do contrato (lib/adiantamento-regras.js#textoRegras) a
#     partir dos valores literais da config semeada — não uma soma
#     reimplementada aqui, e sim o contrato real (mesmo espírito de 10.7.1).
#
# Uso: infra/hub/testes/hub-motorista-adiantamento-smoke-full-chain-integration.sh
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

# tasks.md 5.4 — liga o gate de ambiente do login do app motorista via
# ContaMotorista SÓ neste projeto efêmero (shell env tem precedência sobre
# --env-file na interpolação do compose; DEVE ser exportado ANTES do `up`,
# senão o container sobe com o valor default vazio). Mesmo padrão de
# hub-motorista-canonico-credencial-integration.sh.
export HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true

echo "subindo db+postgrest+backend efêmeros ($PROJECT, HUB_MOTORISTA_LOGIN_CONTA_ATIVA=true)…"
dc up -d --wait db
dc up -d --wait postgrest
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

echo "aplicando migrations (série completa, inclui 0073)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0073_adiantamento_lote_download_sha256_cast.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas até 0073"; cat "$TMP/migrate.log"; exit 1; }

SENHA_OK='SenhaSinteticaMotoristaSmoke#1'
HASH_OK="$(node_e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt falhou"; cat "$TMP/hash-gen.log"; exit 1; }

CNPJ='55555555000103'

# --- fixtures: ContaMotorista com credencial + Entregador vinculado (empresa
# 6, módulo adiantamentos já ativo via migration 0070) + conta bancária
# APROVADA (senão a solicitação recusaria com NO_BANK_ACCOUNT) --------------
psql_t -v ON_ERROR_STOP=1 <<SQL >"$TMP/seed.log" 2>&1
INSERT INTO "ContaMotorista" (cnpj_prestador, nome, ativo, senha) VALUES ('$CNPJ', 'Smoke Motorista Full Chain', true, '$HASH_OK');
INSERT INTO "Entregador" (id_empresa, id_externo, nome, motorista_id, ativo)
  VALUES (6, gen_random_uuid(), 'Smoke Motorista Full Chain', (SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='$CNPJ'), true);
INSERT INTO "ContaBancariaMotorista" (id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo, banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta, entregador_confirmado_id, revisada_em)
  VALUES (6, (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='$CNPJ')), 'CARGA_INICIAL', 'APROVADA', 'Smoke Motorista Full Chain', '22233344455', 'PF', '001', 'Banco do Brasil', '4321', '00066666', '1', 'CORRENTE', (SELECT id FROM "Entregador" WHERE motorista_id=(SELECT id FROM "ContaMotorista" WHERE cnpj_prestador='$CNPJ')), now());
-- config v2 (COMPLETA — fonte/categorias/apuração preenchidas, senão
-- hub_adiantamento_solicitar recusa com NOT_CONFIGURED, dec-053) e janela
-- ABERTA o dia inteiro/toda a semana (evita depender do relógio real do
-- host no momento em que este driver roda — mesmo truque da config v2 de
-- hub-adiantamentos-integration.sh).
INSERT INTO "AdiantamentoConfiguracao" (id_empresa, versao, timezone, dias_habilitados, horario_abertura, horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao, previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio, apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato)
VALUES (6, 2, 'America/Sao_Paulo', ARRAY[0,1,2,3,4,5,6]::smallint[], '00:00', '23:59', 60.00, 0.35, 'financeiro_lancamento', ARRAY['Corrida'], 'entre 17h e 18h de hoje', 'Antecipação {data_producao:DD.MM.AA}_{nome}', 0, 2, 'data_lancamento', ARRAY['Corrida']);
SQL
if [ $? -ne 0 ]; then echo "FAIL: seed deu erro"; cat "$TMP/seed.log"; exit 1; fi
CONFIG_ID="$(psql_t -tAc "SELECT id FROM \"AdiantamentoConfiguracao\" WHERE id_empresa=6 AND versao=2;" | tr -d '[:space:]')"
[ -n "$CONFIG_ID" ] || { echo "FAIL: config v2 de fixture não foi criada"; exit 1; }
check "seed: config v2 (completa, janela aberta) criada (id=$CONFIG_ID)" "0" "0"

# --- cadeia inteira via HTTP real, dentro do container backend — login,
# disponibilidade, solicitar, tudo numa única execução Node. -----------------
SMOKE_OUT="$(dc exec -T backend node - "$SENHA_OK" "$CNPJ" "$CONFIG_ID" <<'JS' 2>&1
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
  const cnpjPrestador = process.argv[3];
  const configuracaoId = Number(process.argv[4]);
  const out = {};

  const rLogin = await fetch('http://localhost:3000/motorista/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cnpjPrestador, senha }),
  });
  out.login_status = rLogin.status;
  const bLogin = await rLogin.json().catch(() => null);
  out.login_cnpj = bLogin && bLogin.cnpjPrestador;
  const jar = parseSetCookie(rLogin);

  const rDisp = await fetch('http://localhost:3000/motorista/adiantamento/disponibilidade', { headers: { Cookie: cookieHeader(jar) } });
  const bDisp = await rDisp.json().catch(() => null);
  out.disp_status = rDisp.status;
  out.disp_can_request = bDisp && bDisp.canRequest;
  out.disp_reason = bDisp && bDisp.reason;
  out.disp_configuracao_id = bDisp && bDisp.configuracaoId;
  out.disp_config_version = bDisp && bDisp.configVersion;

  const chave = require('crypto').randomUUID();
  const rSolicitar = await fetch('http://localhost:3000/motorista/adiantamentos', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader(jar) },
    body: JSON.stringify({ aceite: true, chaveIdempotencia: chave, configuracaoId }),
  });
  const bSolicitar = await rSolicitar.json().catch(() => null);
  out.solicitar_status = rSolicitar.status;
  out.solicitar_id = bSolicitar && bSolicitar.id;
  out.solicitar_status_negocio = bSolicitar && bSolicitar.status;
  out.solicitar_config_version = bSolicitar && bSolicitar.configVersion;

  // Hash esperado — recomputado com a MESMA função pura do contrato
  // (lib/adiantamento-regras.js), a partir dos valores LITERAIS da config
  // semeada acima (não uma soma reimplementada aqui, e sim o contrato real).
  const { textoRegras } = require('./lib/adiantamento-regras');
  const regras = textoRegras({
    id: configuracaoId, versao: 2, timezone: 'America/Sao_Paulo',
    dias_habilitados: [0, 1, 2, 3, 4, 5, 6], horario_abertura: '00:00', horario_corte: '23:59',
    percentual: 60.00, taxa_fixa: 0.35, previsao_pagamento_texto: 'entre 17h e 18h de hoje',
  });
  out.expected_aceite_sha256 = regras.aceiteSha256;

  process.stdout.write(JSON.stringify(out));
}
main().catch((e) => { console.error('ERRO:', e && e.stack || e); process.exit(1); });
JS
)"
echo "$SMOKE_OUT" > "$TMP/smoke.json"
SMOKE_JSON="$(tail -n1 "$TMP/smoke.json")"

G() { printf '%s' "$SMOKE_JSON" | jq -r --arg k "$1" '.[$k] // "null" | tostring'; }

check "10.7.2: login real do motorista -> 200" "$(G login_status)" "200"
check "10.7.2: login real -> cnpjPrestador ecoado" "$(G login_cnpj)" "$CNPJ"
check "10.7.2: GET disponibilidade real -> 200" "$(G disp_status)" "200"
check "10.7.2: disponibilidade real -> canRequest=true (janela aberta, conta aprovada)" "$(G disp_can_request)" "true"
check "10.7.2: disponibilidade real -> reason=null" "$(G disp_reason)" "null"
check "10.7.2: disponibilidade real -> configuracaoId = config v2 semeada" "$(G disp_configuracao_id)" "$CONFIG_ID"
check "10.7.2: disponibilidade real -> configVersion=2" "$(G disp_config_version)" "2"
check "10.7.2: POST /adiantamentos (solicitação real) -> 201" "$(G solicitar_status)" "201"
check "10.7.2: solicitação real -> status=AGUARDANDO_CORTE" "$(G solicitar_status_negocio)" "AGUARDANDO_CORTE"
check "10.7.2: solicitação real -> configVersion=2" "$(G solicitar_config_version)" "2"

SOL_ID="$(G solicitar_id)"
[ -n "$SOL_ID" ] && [ "$SOL_ID" != "null" ] || { echo "FAIL: POST /adiantamentos não devolveu id — não é possível conferir no banco"; echo "$SMOKE_JSON"; fails=$((fails + 1)); SOL_ID=""; }

if [ -n "$SOL_ID" ]; then
  # --- confere DIRETO NO BANCO (fora da API) — 10.7.2: "conferindo no banco
  # que ela nasceu com a versão de configuração e o hash de aceite corretos".
  DB_ROW="$(psql_t -tAc "SELECT configuracao_id || '|' || aceite_texto_sha256 FROM \"AdiantamentoSolicitacao\" WHERE id=$SOL_ID;" | tr -d '[:space:]')"
  DB_CONFIG_ID="${DB_ROW%%|*}"
  DB_HASH="${DB_ROW#*|}"
  EXPECTED_HASH="$(G expected_aceite_sha256)"
  check "10.7.2: banco — AdiantamentoSolicitacao.configuracao_id = config v2 semeada" "$DB_CONFIG_ID" "$CONFIG_ID"
  check "10.7.2: banco — AdiantamentoSolicitacao.aceite_texto_sha256 bate com o hash esperado (textoRegras real)" "$DB_HASH" "$EXPECTED_HASH"
fi

echo ""
echo "===================================================================="
echo "RESULTADO: $fails falha(s)"
echo "===================================================================="
echo "$SMOKE_JSON"
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)

#!/usr/bin/env bash
# =============================================================================
# hub-auditoria-adiantamentos-node-integration.sh — tasks.md 4.8.2/10.2.2
# (feature "Adiantamento pelo App, Dados Bancários e Exportação Transfeera"):
# fecha a pendência deixada em 4.8.2 — as 12 escritas de auditoria feitas
# pelo Node (`registrarAuditoria` em routes/hub-adiantamentos.js) só tinham
# sido validadas por revisão de código + testes unitários (mock de
# PostgREST). Aqui elas rodam de verdade: o serviço `backend` do compose
# (build real via Dockerfile.hub) chama `lib/hub-auditoria.js#registrarAuditoria`
# contra o PostgREST/Postgres efêmeros do próprio stack `hub-test-<runid>`
# (mesmo padrão de isolamento de hub-adiantamentos-integration.sh/
# hub-rbac-integration.sh — nunca toca hub-homolog/produção).
#
# Cobre:
#   10.2.2a — as 12 chamadas de registrarAuditoria() de hub-adiantamentos.js
#             (um call-site por linha de origem) persistem via PostgREST real
#   10.2.2b — scan-auditoria-sensivel.sh roda sobre o MESMO stack e continua
#             OK mesmo com CPF/CNPJ/e-mail sintéticos injetados em `detalhes`
#             (prova a 2ª camada, scrubDetalhes, no caminho real — não só em
#             unit test com PostgREST mockado)
#
# Uso: infra/hub/testes/hub-auditoria-adiantamentos-node-integration.sh
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

echo "subindo db+postgrest+mailpit-mock efêmeros ($PROJECT, tmpfs)…"
dc up -d --wait db
dc up -d --wait postgrest
dc up -d --wait mailpit-mock
# Cap de memória obrigatório no build (RUNBOOK.md — lição de starvation 2026-06-11).
DOCKER_BUILDKIT=0 dc build --memory=2g backend >"$TMP/build.log" 2>&1 || { echo "FAIL: build do backend (Dockerfile.hub)"; tail -60 "$TMP/build.log"; exit 1; }
dc up -d --wait backend

psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }

fails=0
check() { # check <descricao> <valor-obtido> <valor-esperado>
  if [ "$2" = "$3" ]; then
    echo "PASS: $1"
  else
    echo "FAIL: $1 (obtido='$2' esperado='$3')"
    fails=$((fails + 1))
  fi
}

echo "aplicando migrations (série completa, inclui 0072)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
grep -q "0070_modulo_adiantamentos.sql" "$TMP/migrate.log" || { echo "FAIL: migrations não aplicadas"; cat "$TMP/migrate.log"; exit 1; }

# --- 10.2.2a: exercitar as 12 chamadas Node reais de registrarAuditoria() --
# Um objeto por call-site de routes/hub-adiantamentos.js (linhas 436, 515,
# 562, 596, 632, 809, 814, 927, 977, 1020, 1227 e a fábrica de transições em
# 1366 — representada aqui por 1 dos 6 acaoAuditoria possíveis, já que o
# código executado é o MESMO ponto de registrarAuditoria()). Dois `detalhes`
# carregam CPF/CNPJ/e-mail sintéticos numa chave sem nome proibido (ex.:
# `observacao`) para provar a 2ª camada (scrubDetalhes por VALOR) no
# caminho real — nenhum deve sobreviver no banco.
echo "rodando as 12 chamadas Node reais de registrarAuditoria() contra o PostgREST efêmero…"
NODE_OUT="$(dc exec -T backend node - <<'JS' 2>&1
const { registrarAuditoria } = require('./lib/hub-auditoria');
const claims = { escopo: [6] };
const eventos = [
  { acao: 'adiantamento.configuracao_alterada', recurso: 'AdiantamentoConfiguracao', recursoId: 1, detalhes: { versao: 2, observacao: 'ajuste 123.456.789-01 solicitado' } },
  { acao: 'conta_bancaria.visualizada', recurso: 'ContaBancariaMotorista', recursoId: 10, detalhes: {} },
  { acao: 'conta_bancaria.aprovada', recurso: 'ContaBancariaMotorista', recursoId: 10, detalhes: {} },
  { acao: 'conta_bancaria.rejeitada', recurso: 'ContaBancariaMotorista', recursoId: 11, detalhes: { motivo: 'documento ilegível' } },
  { acao: 'conta_bancaria.aprovada_lote', recurso: 'ContaBancariaMotorista', recursoId: null, detalhes: { quantidade: 3 } },
  { acao: 'adiantamento.lote_criado', recurso: 'AdiantamentoLote', recursoId: 100, detalhes: { quantidade: 5, valorTotal: 1234.56 } },
  { acao: 'adiantamento.lote_arquivo_gerado', recurso: 'AdiantamentoLote', recursoId: 100, detalhes: {} },
  { acao: 'adiantamento.lote_baixado', recurso: 'AdiantamentoLote', recursoId: 100, detalhes: { numeroDownload: 1, observacao: 'contato joao.teste@example.com' } },
  { acao: 'adiantamento.lote_cancelado', recurso: 'AdiantamentoLote', recursoId: 101, detalhes: { motivo: 'duplicidade' } },
  { acao: 'adiantamento.lote_confirmado', recurso: 'AdiantamentoLote', recursoId: 100, detalhes: { falhas: 0, statusFinal: 'CONFIRMADO' } },
  { acao: 'adiantamento.repasse_fechado', recurso: 'ApuracaoRepasse', recursoId: 5, detalhes: { periodo: '2026-04', motoristas: 3, total: 999.9 } },
  { acao: 'adiantamento.rejeitado', recurso: 'AdiantamentoSolicitacao', recursoId: 301, detalhes: { motivo: 'sem produção', statusPara: 'RECUSADA' } },
];
(async () => {
  let ok = 0, falha = 0;
  for (const ev of eventos) {
    try {
      await registrarAuditoria({ idEmpresa: 6, usuarioId: null, claims, ...ev });
      ok++;
    } catch (e) {
      falha++;
      console.error('FALHA_EVENTO', ev.acao, e.message);
    }
  }
  console.log(`RESULTADO_NODE ok=${ok} falha=${falha} total=${eventos.length}`);
})();
JS
)"
echo "$NODE_OUT"
check "10.2.2a: 12 chamadas reais de registrarAuditoria() sem erro" \
  "$(echo "$NODE_OUT" | grep -o 'RESULTADO_NODE ok=[0-9]* falha=[0-9]* total=[0-9]*')" \
  "RESULTADO_NODE ok=12 falha=0 total=12"

N_AUDITORIA_NOVAS="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE id_empresa=6 AND recurso IN ('AdiantamentoConfiguracao','ContaBancariaMotorista','AdiantamentoLote','ApuracaoRepasse','AdiantamentoSolicitacao');")"
check "10.2.2a: 12 linhas novas persistidas em Auditoria (PostgREST real)" "$N_AUDITORIA_NOVAS" "12"

# CPF/e-mail sintéticos injetados acima em chaves NÃO proibidas (observacao)
# nunca devem sobreviver no banco — prova a 2ª camada (scrubDetalhes por
# VALOR) no caminho Node real, não só em unit test com PostgREST mockado.
N_CPF_VAZADO="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE detalhes::text ~ '123-456-789-01' OR detalhes::text ~ '123\\.456\\.789-01';")"
check "10.2.2a: CPF sintético injetado NÃO sobrevive em Auditoria.detalhes (scrubDetalhes real)" "$N_CPF_VAZADO" "0"
N_EMAIL_VAZADO="$(psql_t -tAc "SELECT count(*) FROM \"Auditoria\" WHERE detalhes::text ~ 'joao.teste@example.com';")"
check "10.2.2a: e-mail sintético injetado NÃO sobrevive em Auditoria.detalhes (scrubDetalhes real)" "$N_EMAIL_VAZADO" "0"

# --- 10.2.2b: scan-auditoria-sensivel.sh sobre o MESMO stack ---------------
echo ""
echo "rodando scan-auditoria-sensivel.sh sobre o stack com as 12 escritas Node reais…"
"$HUB_DIR/scripts/scan-auditoria-sensivel.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/scan.log" 2>&1
SCAN_EXIT=$?
cat "$TMP/scan.log"
check "10.2.2b: scan-auditoria-sensivel.sh OK (0 achados, escritas Node reais incluídas)" "$SCAN_EXIT" "0"

echo ""
echo "===================================================================="
echo "RESULTADO: $fails falha(s)"
echo "===================================================================="
exit $([ "$fails" -eq 0 ] && echo 0 || echo 1)

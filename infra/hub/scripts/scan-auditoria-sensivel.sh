#!/usr/bin/env bash
# =============================================================================
# scan-auditoria-sensivel.sh — hub-auditoria-admin FASE 2.3.4 (CHK006/SC-006)
#
# Mecanismo de checagem AUTOMATIZADA periódica/E2E dos padrões sensíveis
# (CPF/CNPJ/e-mail) já persistidos em `Auditoria.detalhes` no `hub-homolog`
# (ou num projeto efêmero `hub-test-*`) — mesmos padrões-regex de
# `lib/hub-auditoria.js` (`valorContemPadraoSensivel`, task 2.3.1), agora
# expressos como POSIX ERE (`~` do Postgres) para rodar server-side sem
# depender de Node. É a rede de segurança OPERACIONAL que o CHK006 pedia:
# `scrubDetalhes` é a barreira de ESCRITA (aplicação); este script é a
# checagem de VERIFICAÇÃO (auditoria pós-fato) — se algum caminho de escrita
# futuro esquecer de passar por `registrarAuditoria`/`scrubDetalhes`, esta
# varredura pega o vazamento já persistido.
#
# NUNCA toca produção (`chatmasterveloz`) — só o compose+env-file passado
# (hub-homolog ou hub-test-<runid>), mesmo padrão de `-f/-p/-e` de
# migrate.sh/backup.sh.
#
# Uso:
#   scan-auditoria-sensivel.sh -f <compose.yml> -p <projeto> -e <env-file> [-n LIMITE]
#   scan-auditoria-sensivel.sh -f <compose.yml> -p <projeto> -e <env-file> --self-test
#
# Modos:
#   (default)    Varre até LIMITE (default 500) eventos mais recentes de
#                `Auditoria.detalhes` já persistidos; reporta quantos
#                casam algum padrão sensível. 0 achados = OK (exit 0);
#                >=1 achado = REGRESSÃO (exit 1, lista id/acao/recurso —
#                NUNCA imprime o valor sensível em si, só o metadado).
#   --self-test  Autoteste do PRÓPRIO mecanismo de varredura (task 2.3.5):
#                dentro de UMA transação com ROLLBACK (nunca persiste),
#                insere via psql direto (bypass de `scrubDetalhes`,
#                simulando um vazamento hipotético) 3 linhas sintéticas
#                (CPF/CNPJ/e-mail em `detalhes`) + 1 linha limpa, confirma
#                que a varredura DETECTA exatamente as 3 sensíveis e NÃO
#                sinaliza a limpa, e desfaz tudo (ROLLBACK) — nunca precisa
#                de DELETE (que nem é concedido a `authenticated`, migration
#                0004 — aqui rodamos como o role de conexão do container
#                `db`, tipicamente superuser/owner, mas o ROLLBACK evita
#                qualquer necessidade de privilégio de escrita permanente).
#
# Exit codes: 0 limpo/self-test OK; 1 achado(s) real(is) ou self-test falhou;
#             2 uso incorreto/pré-condição ausente.
# =============================================================================
set -euo pipefail

COMPOSE_FILE="" PROJECT="" ENV_FILE="" LIMITE=500 SELF_TEST=0

while [ $# -gt 0 ]; do
  case "$1" in
    -f) COMPOSE_FILE="$2"; shift 2 ;;
    -p) PROJECT="$2"; shift 2 ;;
    -e) ENV_FILE="$2"; shift 2 ;;
    -n) LIMITE="$2"; shift 2 ;;
    --self-test) SELF_TEST=1; shift ;;
    *) echo "uso: $0 -f compose.yml -p projeto -e env-file [-n LIMITE] [--self-test]" >&2; exit 2 ;;
  esac
done
[ -n "$COMPOSE_FILE" ] && [ -n "$PROJECT" ] && [ -n "$ENV_FILE" ] || {
  echo "argumentos -f/-p/-e obrigatórios" >&2; exit 2;
}

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"
DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes no env-file" >&2; exit 2; }

# Defesa em profundidade adicional (independente do preflight do compose
# chamador): recusa explicitamente qualquer env-file/projeto que aponte para
# recursos de produção (blocklist compartilhada de lib.sh).
if printf '%s %s %s' "$COMPOSE_FILE" "$PROJECT" "$DB_NAME" | grep -Eq "$PROD_DB_REGEX"; then
  echo "ERRO: parâmetros apontam para recurso de PRODUÇÃO — abortado (cláusula pétrea)." >&2
  exit 2
fi

dc() { docker compose -f "$COMPOSE_FILE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }

# Mesmos 3 padrões de lib/hub-auditoria.js (task 2.3.1), em POSIX ERE
# (Postgres `~` é POSIX ERE nativo — sem necessidade de módulo extra).
RE_CPF='[0-9]{3}\.?[0-9]{3}\.?[0-9]{3}-?[0-9]{2}'
RE_CNPJ='[0-9]{2}\.?[0-9]{3}\.?[0-9]{3}/?[0-9]{4}-?[0-9]{2}'
RE_EMAIL='[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+'

sql_where_sensivel() {
  # Concatena TODOS os valores de `detalhes` (jsonb_each_text) num único
  # texto por linha de Auditoria, e testa os 3 padrões contra esse texto —
  # evita falso-negativo por o padrão estar partido entre chaves distintas
  # e mantém paridade semântica com `valorContemPadraoSensivel` (testa
  # VALOR por VALOR, mas agregado por linha para 1 query só).
  cat <<SQL
WITH valores AS (
  SELECT a.id, a.acao, a.recurso, string_agg(v.value, ' | ') AS valores_concat
  FROM "Auditoria" a
  LEFT JOIN LATERAL jsonb_each_text(COALESCE(a.detalhes, '{}'::jsonb)) v(key, value) ON true
  GROUP BY a.id, a.acao, a.recurso
)
SELECT id, acao, recurso
FROM valores
WHERE valores_concat ~ '$RE_CPF' OR valores_concat ~ '$RE_CNPJ' OR valores_concat ~ '$RE_EMAIL'
SQL
}

if [ "$SELF_TEST" -eq 1 ]; then
  echo "self-test: inserindo 4 linhas sintéticas (3 sensíveis + 1 limpa) em transação com ROLLBACK…"
  OUT="$(psql_t -tA <<SQL
BEGIN;
INSERT INTO "Auditoria" (acao, recurso, detalhes) VALUES
  ('scan_self_test_cpf', 'ScanSelfTest', '{"nota": "doc 123.456.789-01 encontrado"}'::jsonb),
  ('scan_self_test_cnpj', 'ScanSelfTest', '{"nota": "cnpj 12.345.678/0001-95 encontrado"}'::jsonb),
  ('scan_self_test_email', 'ScanSelfTest', '{"nota": "contato joao@example.com"}'::jsonb),
  ('scan_self_test_limpo', 'ScanSelfTest', '{"nota": "nada sensivel aqui", "total": 42}'::jsonb);
$(sql_where_sensivel)
AND recurso = 'ScanSelfTest';
ROLLBACK;
SQL
)"
  echo "$OUT"
  ACOES_DETECTADAS="$(printf '%s\n' "$OUT" | awk -F'\\|' '{gsub(/ /,"",$2); if ($2 != "") print $2}')"
  n_cpf=0; n_cnpj=0; n_email=0; n_limpo=0
  printf '%s\n' "$ACOES_DETECTADAS" | grep -qx "scan_self_test_cpf" && n_cpf=1
  printf '%s\n' "$ACOES_DETECTADAS" | grep -qx "scan_self_test_cnpj" && n_cnpj=1
  printf '%s\n' "$ACOES_DETECTADAS" | grep -qx "scan_self_test_email" && n_email=1
  printf '%s\n' "$ACOES_DETECTADAS" | grep -qx "scan_self_test_limpo" && n_limpo=1

  ok=1
  [ "$n_cpf" -eq 1 ] && echo "PASS: CPF sintético detectado" || { echo "FAIL: CPF sintético NÃO detectado"; ok=0; }
  [ "$n_cnpj" -eq 1 ] && echo "PASS: CNPJ sintético detectado" || { echo "FAIL: CNPJ sintético NÃO detectado"; ok=0; }
  [ "$n_email" -eq 1 ] && echo "PASS: e-mail sintético detectado" || { echo "FAIL: e-mail sintético NÃO detectado"; ok=0; }
  [ "$n_limpo" -eq 0 ] && echo "PASS: linha limpa NÃO sinalizada (sem falso-positivo)" || { echo "FAIL: linha limpa foi sinalizada (falso-positivo)"; ok=0; }
  echo "self-test: ROLLBACK confirmado — nenhuma linha sintética persistida"

  if [ "$ok" -eq 1 ]; then
    echo "SCAN-AUDITORIA-SENSIVEL SELF-TEST: OK"
    exit 0
  else
    echo "SCAN-AUDITORIA-SENSIVEL SELF-TEST: FALHOU" >&2
    exit 1
  fi
fi

echo "varrendo até $LIMITE eventos mais recentes de Auditoria.detalhes em busca de CPF/CNPJ/e-mail…"
RESULT="$(psql_t -tA <<SQL
WITH recentes AS (
  SELECT id, acao, recurso, detalhes FROM "Auditoria" ORDER BY id DESC LIMIT $LIMITE
),
achados AS (
  SELECT a.id, a.acao, a.recurso
  FROM recentes a
  LEFT JOIN LATERAL jsonb_each_text(COALESCE(a.detalhes, '{}'::jsonb)) v(key, value) ON true
  GROUP BY a.id, a.acao, a.recurso
  HAVING string_agg(v.value, ' | ') ~ '$RE_CPF'
      OR string_agg(v.value, ' | ') ~ '$RE_CNPJ'
      OR string_agg(v.value, ' | ') ~ '$RE_EMAIL'
)
SELECT id, acao, recurso FROM achados ORDER BY id;
SQL
)"

TOTAL=0
if [ -n "$RESULT" ]; then
  TOTAL="$(printf '%s\n' "$RESULT" | grep -c '|' || true)"
fi

if [ "$TOTAL" -eq 0 ]; then
  echo "SCAN-AUDITORIA-SENSIVEL: OK — 0 achados em até $LIMITE eventos (SC-006)"
  exit 0
else
  echo "SCAN-AUDITORIA-SENSIVEL: $TOTAL achado(s) — vazamento de padrão sensível em Auditoria.detalhes" >&2
  echo "$RESULT" | while IFS='|' read -r id acao recurso; do
    echo "  id=$(printf '%s' "$id" | tr -d ' ') acao=$(printf '%s' "$acao" | tr -d ' ') recurso=$(printf '%s' "$recurso" | tr -d ' ') (valor sensível NÃO impresso — inspecionar via psql direto se necessário)" >&2
  done
  exit 1
fi

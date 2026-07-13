#!/usr/bin/env bash
# =============================================================================
# hub-motorista-canonico-fundacao-integration.sh — FASE 3 (WS-C Fundação) da
# feature hub-motorista-canonico: migrations 0043 (ContaMotorista.senha) e
# 0044 (permissão motoristas.credencial), num projeto hub-test EFÊMERO
# (db-only, tmpfs). Nunca toca chatmasterveloz/produção nem o hub-homolog.
#
# Cobre (tasks.md 3.1.2/3.1.3/3.1.4/3.2.3/3.2.4):
#   (a) coluna ContaMotorista.senha criada, nullable, tipo text;
#   (b) idempotência da DDL: re-executar o ALTER TABLE diretamente não falha
#       e não altera o schema (ADD COLUMN IF NOT EXISTS genuíno);
#   (c) idempotência via migrate.sh: aplicar 2x seguidas não duplica linhas
#       em "SchemaMigration" nem falha;
#   (d) grants existentes de "ContaMotorista" (0021, sem lista de colunas)
#       cobrem a coluna nova sem GRANT adicional — role `authenticated`
#       consegue INSERT/UPDATE incluindo `senha`;
#   (e) permissão `motoristas.credencial` existe e é concedida aos papéis
#       admin (admin_plataforma/admin_entidade), NÃO a operador/leitura;
#   (f) independência estrutural das duas permissões (FR-020): `operador`
#       tem `motoristas.editar` SEM `motoristas.credencial` (caso real do
#       seed); e o schema permite o inverso — papel com `motoristas.
#       credencial` SEM `motoristas.editar` (sem FK/CHECK que acople as
#       duas), demonstrado com um papel de teste ad-hoc no banco efêmero.
#
# Uso: infra/hub/testes/hub-motorista-canonico-fundacao-integration.sh
# =============================================================================
set -uo pipefail

HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${HUB_TEST_ENV:-/var/lib/hub_secrets/.env.hub.test}"
COMPOSE="$HUB_DIR/compose.hub.test.yml"
RUNID="$(date +%s)"
PROJECT="hub-test-$RUNID"

. "$HUB_DIR/scripts/lib.sh"
DB_USER="$(get_var HUB_DB_USER "$ENV_FILE")"; DB_NAME="$(get_var HUB_DB_NAME "$ENV_FILE")"
[ -n "$DB_USER" ] && [ -n "$DB_NAME" ] || { echo "HUB_DB_USER/HUB_DB_NAME ausentes em $ENV_FILE" >&2; exit 2; }

dc() { docker compose -f "$COMPOSE" -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }
cleanup() { dc down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT
psql_t() { dc exec -T db psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"; }

fails=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (obtido='$2' esperado='$3')"; fails=$((fails + 1)); fi
}

"$HUB_DIR/scripts/preflight.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" || { echo "preflight abortou — não prossegue"; exit 1; }

echo "subindo db efêmero ($PROJECT, tmpfs)…"
dc up -d --wait db

echo "aplicando migrations (1a vez)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >/dev/null 2>&1 \
  || { echo "FAIL: migrate.sh (1a aplicação)"; exit 1; }

# (a) coluna criada, nullable, tipo text
COL="$(psql_t -tAc "SELECT data_type || ':' || is_nullable FROM information_schema.columns WHERE table_name='ContaMotorista' AND column_name='senha'" | tr -d '[:space:]')"
check "(a) ContaMotorista.senha existe, tipo text, nullable" "$COL" "text:YES"

# (b) idempotência da DDL em si (re-executar diretamente, fora do tracking do migrate.sh)
DDL2="$(psql_t -tAc 'ALTER TABLE "ContaMotorista" ADD COLUMN IF NOT EXISTS senha text NULL' 2>&1)"
check "(b) re-executar ALTER TABLE ADD COLUMN IF NOT EXISTS não falha" "$?" "0"
COL2="$(psql_t -tAc "SELECT data_type || ':' || is_nullable FROM information_schema.columns WHERE table_name='ContaMotorista' AND column_name='senha'" | tr -d '[:space:]')"
check "(b) coluna inalterada após 2a ALTER TABLE" "$COL2" "text:YES"

# (c) idempotência via migrate.sh — contagem de SchemaMigration para as duas
# migrations não duplica numa 2a aplicação
CNT1="$(psql_t -tAc "SELECT count(*) FROM \"SchemaMigration\" WHERE nome IN ('0043_conta_motorista_senha.sql','0044_seed_permissao_motoristas_credencial.sql')" | tr -d '[:space:]')"
check "(c) SchemaMigration registrou as 2 migrations (1a aplicação)" "$CNT1" "2"
echo "aplicando migrations (2a vez, deve ser no-op)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >/dev/null 2>&1 \
  || { echo "FAIL: migrate.sh (2a aplicação)"; exit 1; }
CNT2="$(psql_t -tAc "SELECT count(*) FROM \"SchemaMigration\" WHERE nome IN ('0043_conta_motorista_senha.sql','0044_seed_permissao_motoristas_credencial.sql')" | tr -d '[:space:]')"
check "(c) SchemaMigration NÃO duplica na 2a aplicação (no-op)" "$CNT2" "2"

# (d) grants existentes (0021, sem lista de colunas) cobrem a coluna nova —
# role authenticated consegue INSERT+UPDATE incluindo senha, sem GRANT extra
psql_t >/dev/null <<'SQL'
INSERT INTO "ContaMotorista" (cnpj_prestador, nome) VALUES ('11111111000191', 'QA Fundação FASE3')
ON CONFLICT (cnpj_prestador) DO NOTHING;
SQL
UPD_AUTH="$(psql_t -tAc "SET ROLE authenticated; UPDATE \"ContaMotorista\" SET senha='\$2b\$12\$hashfake' WHERE cnpj_prestador='11111111000191'; SELECT senha FROM \"ContaMotorista\" WHERE cnpj_prestador='11111111000191'" 2>&1 | tail -1 | tr -d '[:space:]')"
check "(d) role authenticated grava/lê senha sem GRANT adicional" "$UPD_AUTH" '$2b$12$hashfake'

# (e) permissão motoristas.credencial existe e concedida só aos papéis admin
PERM_EXISTE="$(psql_t -tAc "SELECT count(*) FROM \"Permissao\" WHERE codigo='motoristas.credencial'" | tr -d '[:space:]')"
check "(e) Permissao 'motoristas.credencial' existe (única linha)" "$PERM_EXISTE" "1"
ADMIN_TEM="$(psql_t -tAc "SELECT count(*) FROM \"PapelPermissao\" pp JOIN \"Papel\" p ON p.id=pp.papel_id JOIN \"Permissao\" perm ON perm.id=pp.permissao_id WHERE perm.codigo='motoristas.credencial' AND p.nome IN ('admin_plataforma','admin_entidade')" | tr -d '[:space:]')"
check "(e) admin_plataforma + admin_entidade têm motoristas.credencial" "$ADMIN_TEM" "2"
NAO_ADMIN_TEM="$(psql_t -tAc "SELECT count(*) FROM \"PapelPermissao\" pp JOIN \"Papel\" p ON p.id=pp.papel_id JOIN \"Permissao\" perm ON perm.id=pp.permissao_id WHERE perm.codigo='motoristas.credencial' AND p.nome IN ('operador','leitura')" | tr -d '[:space:]')"
check "(e) operador/leitura NÃO têm motoristas.credencial" "$NAO_ADMIN_TEM" "0"

# (f) independência estrutural motoristas.editar <-> motoristas.credencial (FR-020)
OPERADOR_EDITAR_SEM_CREDENCIAL="$(psql_t -tAc "SELECT count(*) FROM \"PapelPermissao\" pp JOIN \"Papel\" p ON p.id=pp.papel_id JOIN \"Permissao\" perm ON perm.id=pp.permissao_id WHERE p.nome='operador' AND perm.codigo='motoristas.editar'" | tr -d '[:space:]')"
check "(f) operador tem motoristas.editar SEM motoristas.credencial (caso real)" "$OPERADOR_EDITAR_SEM_CREDENCIAL" "1"
# papel ad-hoc de teste (efêmero, não-sistema): só motoristas.credencial, sem motoristas.editar
psql_t >/dev/null <<'SQL'
INSERT INTO "Papel" (nome, escopo, is_sistema) VALUES ('qa_credencial_only', 'entidade', false)
ON CONFLICT (nome) DO NOTHING;
INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id FROM "Papel" p CROSS JOIN "Permissao" perm
WHERE p.nome = 'qa_credencial_only' AND perm.codigo = 'motoristas.credencial'
ON CONFLICT DO NOTHING;
SQL
INVERSO="$(psql_t -tAc "SELECT (SELECT count(*) FROM \"PapelPermissao\" pp JOIN \"Papel\" p ON p.id=pp.papel_id JOIN \"Permissao\" perm ON perm.id=pp.permissao_id WHERE p.nome='qa_credencial_only' AND perm.codigo='motoristas.credencial') || ':' || (SELECT count(*) FROM \"PapelPermissao\" pp JOIN \"Papel\" p ON p.id=pp.papel_id JOIN \"Permissao\" perm ON perm.id=pp.permissao_id WHERE p.nome='qa_credencial_only' AND perm.codigo='motoristas.editar')" | tr -d '[:space:]')"
check "(f) schema PERMITE credencial SEM editar (sem FK/CHECK acoplando as 2)" "$INVERSO" "1:0"

echo
if [ "$fails" = "0" ]; then
  echo "HUB-MOTORISTA-CANONICO-FUNDACAO-INTEGRATION: OK — todos os asserts passaram (FASE 3/0043+0044)"
  exit 0
else
  echo "HUB-MOTORISTA-CANONICO-FUNDACAO-INTEGRATION: $fails assert(s) FALHARAM" >&2
  exit 1
fi

#!/usr/bin/env bash
# =============================================================================
# migracao-login-integration.sh — task 2.1.5 (tasks.md FASE 2): prova E2E da
# migration 0008_migracao_empresa_para_usuario.sql num projeto hub-test EFEMERO
# e descartável. NUNCA toca chatmasterveloz/Empresa real — "Empresa" aqui é uma
# tabela SINTÉTICA de teste, criada e destruída dentro deste projeto (down -v).
#
# Cobre tasks.md 2.1.5: (a) hash bcrypt preservado (login com hash original
# funciona via bcrypt.compare real, container Node 20 do próprio backend hub);
# (b) conta sem senha (Empresa.pass NULL) não migra (FR-005); (c) reexecução
# direta do arquivo 0008 não duplica linhas (idempotência, FR-004/SC-002);
# (d) UsuarioEntidade vinculado com papel admin_entidade (FR-002, aprovado
# block-002/dec-033).
#
# Uso: infra/hub/testes/migracao-login-integration.sh
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

echo "subindo db+postgrest+backend efêmeros ($PROJECT, tmpfs)…"
dc up -d --wait db
dc up -d --wait postgrest
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

# Hash gerado com o MESMO módulo `bcrypt` (npm, backend Node 20) usado por
# /register e /login em produção — NÃO usar htpasswd/openssl aqui: a lib
# `bcrypt` do Node só reconhece prefixo $2a$/$2b$ e rejeita $2y$ (achado
# empírico durante esta task; hashes reais de Empresa.pass são sempre $2b$
# porque são gerados por este mesmo módulo, então isso nunca afeta dado
# real — só evita um falso-negativo no seed sintético de teste).
SENHA_OK="SenhaSintetica#Teste1"
HASH_OK="$(dc exec -T backend node -e "
  require('bcrypt').hash(process.argv[1], 10).then(h => { process.stdout.write(h); process.exit(0); });
" "$SENHA_OK" 2>"$TMP/hash-gen.log" | tr -d '[:space:]')"
[ -n "$HASH_OK" ] || { echo "FAIL: geração do hash bcrypt (via backend) falhou — abortando"; cat "$TMP/hash-gen.log"; exit 1; }

echo "seed sintético: tabela \"Empresa\" local (2 contas — 1 com senha, 1 sem)…"
psql_t <<SQL >/dev/null
CREATE TABLE "Empresa" (
  id           serial PRIMARY KEY,
  email        text UNIQUE,
  pass         text,
  nome_empresa text,
  id_grupo     int
);
INSERT INTO "Empresa" (email, pass, nome_empresa) VALUES
  ('conta-teste-migravel@example.test', '$HASH_OK', 'Empresa Teste Migravel'),
  ('conta-teste-sem-senha@example.test', NULL, 'Empresa Sem Senha');
SQL

echo "rodando migrate.sh (0002..0008)…"
"$HUB_DIR/scripts/migrate.sh" -f "$COMPOSE" -p "$PROJECT" -e "$ENV_FILE" >"$TMP/migrate.log" 2>&1
if ! grep -q "0008_migracao_empresa_para_usuario.sql" "$TMP/migrate.log"; then
  echo "FAIL: 0008 não apareceu na saída do migrate.sh"; cat "$TMP/migrate.log"; exit 1
fi

# --- Assert 1: Usuario criado só para a conta com senha (FR-001/FR-005) --------
count_migrada="$(psql_t -tAc "SELECT count(*) FROM \"Usuario\" WHERE email='conta-teste-migravel@example.test'" | tr -d '[:space:]')"
check "Usuario criado para a conta com senha (1 linha)" "$count_migrada" "1"

count_sem_senha="$(psql_t -tAc "SELECT count(*) FROM \"Usuario\" WHERE email='conta-teste-sem-senha@example.test'" | tr -d '[:space:]')"
check "conta sem senha NÃO migrada (FR-005)" "$count_sem_senha" "0"

# --- Assert 2: hash bcrypt preservado, byte a byte ------------------------------
hash_gravado="$(psql_t -tAc "SELECT senha_hash FROM \"Usuario\" WHERE email='conta-teste-migravel@example.test'" | tr -d '[:space:]')"
check "hash bcrypt copiado sem recálculo" "$hash_gravado" "$HASH_OK"

# --- Assert 3: UsuarioEntidade com papel admin_entidade (FR-002) ---------------
papel_vinculado="$(psql_t -tAc "
  SELECT p.nome FROM \"UsuarioEntidade\" ue
  JOIN \"Usuario\" u ON u.id = ue.usuario_id
  JOIN \"Papel\" p ON p.id = ue.papel_id
  JOIN \"Empresa\" e ON e.id = ue.empresa_id
  WHERE u.email='conta-teste-migravel@example.test' AND e.email='conta-teste-migravel@example.test'
" | tr -d '[:space:]')"
check "UsuarioEntidade vinculado com papel admin_entidade" "$papel_vinculado" "admin_entidade"

# --- Assert 4: bcrypt.compare REAL (Node 20, mesmo módulo do backend hub) -----
compare_ok="$(dc exec -T backend node -e "
  const bcrypt = require('bcrypt');
  bcrypt.compare(process.argv[1], process.argv[2]).then(ok => { console.log(ok ? 'true' : 'false'); process.exit(0); });
" "$SENHA_OK" "$HASH_OK" 2>"$TMP/bcrypt-compare.log" | tr -d '[:space:]')"
check "bcrypt.compare(senha original, hash copiado) — login legado funciona sem trocar senha" "$compare_ok" "true"

# --- Assert 5: idempotência — reexecução DIRETA do arquivo 0008 não duplica ----
echo "reexecutando 0008 diretamente (fora do controle de SchemaMigration do migrate.sh)…"
psql_t -1 -f - <"$HUB_DIR/migrations/0008_migracao_empresa_para_usuario.sql" >"$TMP/rerun.log" 2>&1
count_pos_rerun="$(psql_t -tAc "SELECT count(*) FROM \"Usuario\" WHERE email='conta-teste-migravel@example.test'" | tr -d '[:space:]')"
check "reexecução direta de 0008 não duplica Usuario (idempotente)" "$count_pos_rerun" "1"

count_ue_pos_rerun="$(psql_t -tAc "
  SELECT count(*) FROM \"UsuarioEntidade\" ue
  JOIN \"Usuario\" u ON u.id = ue.usuario_id
  WHERE u.email='conta-teste-migravel@example.test'
" | tr -d '[:space:]')"
check "reexecução direta de 0008 não duplica UsuarioEntidade" "$count_ue_pos_rerun" "1"

echo
if [ "$fails" = "0" ]; then
  echo "MIGRACAO-LOGIN-INTEGRATION: OK — todos os asserts passaram (task 2.1.5)"
else
  echo "MIGRACAO-LOGIN-INTEGRATION: $fails assert(s) FALHARAM" >&2
  exit 1
fi

#!/usr/bin/env bash
# E2E — cadastro de motorista restrito à base validada (Motorista) + CRUD
# Feature: cadastro-motorista-base-validada
#
# PRÉ-REQUISITOS (executados/garantidos pelo OPERADOR):
#   1) DDL 008 + 008b aplicadas no banco de homologação (chatmasterveloz@pgadmin_db).
#   2) Backend + frontend_v2 com o código desta branch DEPLOYADOS em homologação
#      (docker service update --image).
#   3) Variáveis abaixo preenchidas com dados reais de homologação.
#
# NÃO exercita /validar-nota (dispara validação fiscal real). Cobre: upload→Motorista,
# cadastro na base / fora / já-existe, login, e o CRUD (escopo + BOLA + :id + ativo).
set -uo pipefail

# ── Configuração (preencher) ────────────────────────────────────────────────
API="${API:-https://envmassv2.todo-tips.com/api}"      # painel admin (empresa)
MOTO="${MOTO:-https://appmotorista.todo-tips.com/api}"  # app motorista (ajustar)
ADMIN_EMAIL="${ADMIN_EMAIL:?defina ADMIN_EMAIL}"        # admin de empresa do escopo
ADMIN_SENHA="${ADMIN_SENHA:?defina ADMIN_SENHA}"
CNPJ_NA_BASE="${CNPJ_NA_BASE:?CNPJ (14 dígitos) que existe em Motorista SEM senha (pré-cadastro)}"
CNPJ_FORA="${CNPJ_FORA:?CNPJ (14 dígitos) que NÃO existe em Motorista}"
SENHA_NOVA="${SENHA_NOVA:-Senha#Forte123}"

JAR_ADMIN="$(mktemp)"; JAR_MOTO="$(mktemp)"
pass=0; fail=0
ok(){ echo "  ✅ $1"; pass=$((pass+1)); }
ko(){ echo "  ❌ $1"; fail=$((fail+1)); }
code(){ tail -n1 <<<"$1"; }   # última linha = http_code (curl -w)

echo "== 1. Cadastro com CNPJ FORA da base → 409 (anti-enum), nenhuma conta criada =="
R=$(curl -s -w '\n%{http_code}' -X POST "$MOTO/motorista/register" \
   -H 'Content-Type: application/json' \
   -d "{\"cnpjPrestador\":\"$CNPJ_FORA\",\"nome\":\"Fulano\",\"senha\":\"$SENHA_NOVA\"}")
[ "$(code "$R")" = 409 ] && ok "409 para CNPJ fora da base" || ko "esperava 409, veio $(code "$R")"

echo "== 2. Cadastro com CNPJ NA base (pré-cadastro) → 201 (ativa a senha via UPDATE) =="
R=$(curl -s -w '\n%{http_code}' -X POST "$MOTO/motorista/register" \
   -H 'Content-Type: application/json' \
   -d "{\"cnpjPrestador\":\"$CNPJ_NA_BASE\",\"nome\":\"Motorista Teste\",\"senha\":\"$SENHA_NOVA\"}")
[ "$(code "$R")" = 201 ] && ok "201 ativando pré-cadastro" || ko "esperava 201, veio $(code "$R")"

echo "== 3. Login do motorista recém-cadastrado → 200 =="
R=$(curl -s -w '\n%{http_code}' -c "$JAR_MOTO" -X POST "$MOTO/motorista/login" \
   -H 'Content-Type: application/json' \
   -d "{\"cnpjPrestador\":\"$CNPJ_NA_BASE\",\"senha\":\"$SENHA_NOVA\"}")
[ "$(code "$R")" = 200 ] && ok "login OK" || ko "esperava 200, veio $(code "$R")"

echo "== 4. Re-cadastro do mesmo CNPJ (já tem senha) → 409 (anti-enum) =="
R=$(curl -s -w '\n%{http_code}' -X POST "$MOTO/motorista/register" \
   -H 'Content-Type: application/json' \
   -d "{\"cnpjPrestador\":\"$CNPJ_NA_BASE\",\"nome\":\"X\",\"senha\":\"$SENHA_NOVA\"}")
[ "$(code "$R")" = 409 ] && ok "409 para conta já existente" || ko "esperava 409, veio $(code "$R")"

echo "== 5. Admin login (painel) =="
R=$(curl -s -w '\n%{http_code}' -c "$JAR_ADMIN" -X POST "$API/login" \
   -H 'Content-Type: application/json' \
   -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_SENHA\"}")
[ "$(code "$R")" = 200 ] && ok "admin login OK" || { ko "admin login falhou ($(code "$R"))"; }

echo "== 6. CRUD: listar motoristas do escopo, e o CNPJ cadastrado aparece =="
R=$(curl -s -w '\n%{http_code}' -b "$JAR_ADMIN" "$API/admin/motoristas")
BODY=$(sed '$d' <<<"$R")
[ "$(code "$R")" = 200 ] && ok "GET /admin/motoristas 200" || ko "esperava 200, veio $(code "$R")"
grep -q "$CNPJ_NA_BASE" <<<"$BODY" && ok "motorista do escopo listado" || ko "motorista não apareceu na lista"
grep -qi '"senha"' <<<"$BODY" && ko "VAZOU campo senha no DTO!" || ok "DTO não expõe senha"

MID=$(grep -o "\"id\":[0-9]*,\"cnpj_prestador\":\"$CNPJ_NA_BASE\"" <<<"$BODY" | grep -o '[0-9]\+' | head -n1)
echo "   id do motorista de teste: ${MID:-<não encontrado>}"

echo "== 7. CRUD: :id inválido → 400 =="
R=$(curl -s -w '\n%{http_code}' -b "$JAR_ADMIN" -X PUT "$API/admin/motoristas/abc" \
   -H 'Content-Type: application/json' -d '{"nome":"x"}')
[ "$(code "$R")" = 400 ] && ok "400 para :id não-inteiro" || ko "esperava 400, veio $(code "$R")"

echo "== 8. CRUD: editar nome (PUT) → 200 =="
if [ -n "${MID:-}" ]; then
  R=$(curl -s -w '\n%{http_code}' -b "$JAR_ADMIN" -X PUT "$API/admin/motoristas/$MID" \
     -H 'Content-Type: application/json' -d '{"nome":"Motorista Editado"}')
  [ "$(code "$R")" = 200 ] && ok "PUT nome 200" || ko "esperava 200, veio $(code "$R")"
else ko "sem MID — pulando PUT"; fi

echo "== 9. CRUD: BOLA — editar id absurdo/fora do escopo → 404 genérico =="
R=$(curl -s -w '\n%{http_code}' -b "$JAR_ADMIN" -X PUT "$API/admin/motoristas/99999999" \
   -H 'Content-Type: application/json' -d '{"nome":"x"}')
[ "$(code "$R")" = 404 ] && ok "404 genérico p/ fora do escopo" || ko "esperava 404, veio $(code "$R")"

echo "== 10. CRUD: desativar (soft) → 200 e login do motorista passa a 403 =="
if [ -n "${MID:-}" ]; then
  R=$(curl -s -w '\n%{http_code}' -b "$JAR_ADMIN" -X DELETE "$API/admin/motoristas/$MID")
  [ "$(code "$R")" = 200 ] && ok "DELETE soft 200" || ko "esperava 200, veio $(code "$R")"
  R=$(curl -s -w '\n%{http_code}' -X POST "$MOTO/motorista/login" \
     -H 'Content-Type: application/json' \
     -d "{\"cnpjPrestador\":\"$CNPJ_NA_BASE\",\"senha\":\"$SENHA_NOVA\"}")
  [ "$(code "$R")" = 403 ] && ok "login negado p/ inativo (403)" || ko "esperava 403, veio $(code "$R")"
  # restaurar para reexecuções idempotentes
  curl -s -o /dev/null -b "$JAR_ADMIN" -X PUT "$API/admin/motoristas/$MID" \
     -H 'Content-Type: application/json' -d '{"ativo":true}'
else ko "sem MID — pulando DELETE"; fi

echo
echo "==================== RESULTADO: $pass OK / $fail FALHAS ===================="
rm -f "$JAR_ADMIN" "$JAR_MOTO"
[ "$fail" -eq 0 ]

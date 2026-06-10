#!/usr/bin/env bash
# =============================================================================
# E2E — Corte controlado do Módulo C (flag login_unico_ativo por grupo)
# Homologação. Valida: flag off → filial loga 200; flag on → filial 403, pai 200,
# refresh de filial 403; toggle a quente reversível. NÃO exercita o Módulo A.
#
# Pré-requisitos (operador, em homologação):
#   1. DDL 007 aplicada (coluna Grupo.login_unico_ativo existe, default false).
#   2. Backend deployado com a mudança (grupoLoginUnicoAtivo).
#   3. Uma filial COM SENHA num grupo de teste + o pai desse grupo, credenciais abaixo.
#      (ex.: re-aplicar seed 006 → filial id=12 grupo 2 Movee, senha teste123;
#       pai admin@movee.com.br senha 123456.)
#   4. Capacidade de togglar a flag entre as fases (psql) — ver TOGGLE_ON/OFF.
#
# Uso: editar as variáveis abaixo e rodar fase a fase (o toggle do DB é manual,
# rodado pelo operador, pois o app não expõe rota de ativação — by design).
# =============================================================================
set -uo pipefail

API="${API:-https://envmassapihomologacao.todo-tips.com}"
GRUPO_ID="${GRUPO_ID:-2}"                       # grupo de teste a togglar
FILIAL_EMAIL="${FILIAL_EMAIL:-filial.teste.e2e@movee.com.br}"
FILIAL_PASS="${FILIAL_PASS:-teste123}"
PAI_EMAIL="${PAI_EMAIL:-admin@movee.com.br}"
PAI_PASS="${PAI_PASS:-123456}"

JAR_FILIAL="$(mktemp)"; JAR_PAI="$(mktemp)"
ok=0; fail=0
check(){ local got="$1" exp="$2" name="$3"; if [ "$got" = "$exp" ]; then echo "  ✓ $name ($got)"; ok=$((ok+1)); else echo "  ✗ $name esperado=$exp obtido=$got"; fail=$((fail+1)); fi; }
login(){ curl -s -o /dev/null -w '%{http_code}' -c "$2" -X POST "$API/login" -H 'Content-Type: application/json' -d "{\"email\":\"$1\",\"password\":\"$3\"}"; }
refresh(){ curl -s -o /dev/null -w '%{http_code}' -b "$1" -X POST "$API/token/refresh"; }

echo "== TOGGLE_OFF (operador): UPDATE \"Grupo\" SET login_unico_ativo=false WHERE id=$GRUPO_ID;"
read -rp "   flag OFF aplicada no grupo $GRUPO_ID? [enter] " _
echo "Fase A — flag OFF"
check "$(login "$FILIAL_EMAIL" "$JAR_FILIAL" "$FILIAL_PASS")" 200 "A1 filial loga (corte inativo)"
check "$(login "$PAI_EMAIL" "$JAR_PAI" "$PAI_PASS")"          200 "A2 pai loga"
# guardar refreshToken de filial emitido com flag OFF para o teste de bypass:
echo "  (refreshToken de filial capturado em $JAR_FILIAL para a Fase B)"

echo "== TOGGLE_ON (operador): UPDATE \"Grupo\" SET login_unico_ativo=true WHERE id=$GRUPO_ID;"
read -rp "   flag ON aplicada no grupo $GRUPO_ID? [enter] " _
echo "Fase B — flag ON (a quente, sem redeploy)"
check "$(login "$FILIAL_EMAIL" /dev/null "$FILIAL_PASS")"     403 "B1 filial senha correta → bloqueada"
check "$(login "$FILIAL_EMAIL" /dev/null 'senha_errada__')"   400 "B2 filial senha errada → 400 genérico (anti-enum)"
check "$(login "$PAI_EMAIL" "$JAR_PAI" "$PAI_PASS")"          200 "B3 pai continua logando"
check "$(refresh "$JAR_FILIAL")"                              403 "B4 refresh de refreshToken antigo de filial → bloqueado (LOW-004)"

echo "== TOGGLE_OFF (operador): UPDATE \"Grupo\" SET login_unico_ativo=false WHERE id=$GRUPO_ID;"
read -rp "   flag OFF reaplicada no grupo $GRUPO_ID? [enter] " _
echo "Fase C — rollback a quente"
check "$(login "$FILIAL_EMAIL" /dev/null "$FILIAL_PASS")"     200 "C1 filial volta a logar (reversível)"

rm -f "$JAR_FILIAL" "$JAR_PAI"
echo "== Resultado: $ok ok / $fail fail =="
[ "$fail" -eq 0 ]

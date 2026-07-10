#!/usr/bin/env bash
# =============================================================================
# valida-schema-prod.sh — pré-checagem do RUNBOOK-CUTOVER.md §3: valida um
# `pg_dump --schema-only` do banco REAL de produção (colado pelo operador)
# contra os objetos que a série de migrations 0000–0041 PRESSUPÕE existir.
#
# READ-ONLY sobre o arquivo passado; nada de banco, nada de rede. O dump nunca
# deve ser commitado (nomes de objetos internos) — só o veredito.
#
# Checa:
#   1. Tabelas legadas que as migrations/código pressupõem: Empresa (incl. as
#      colunas do /login: tk/connection_id/workflow_id/sender — o espelho 0033
#      não as tinha, produção PRECISA tê-las), Grupo, EnvioMassa (colunas dos
#      fluxos vivos), ProcessControl, Motorista (cnpj_prestador UNIQUE).
#   2. NENHUMA tabela do hub pré-existente (aplicação parcial anterior).
#   3. Extensões unaccent/pg_trgm: ausentes (0021 cria em public) OU já em
#      public — em outro schema, a 0040 quebra (PARAR).
#   4. Versão do servidor no cabeçalho do dump (paridade postgres 13).
#   5. GRANTs "TO authenticated" presentes (role de aplicação em uso).
#
# Uso: infra/hub/scripts/valida-schema-prod.sh /tmp/schema-prod.sql
# =============================================================================
set -uo pipefail

DUMP="${1:-}"
[ -n "$DUMP" ] && [ -f "$DUMP" ] || { echo "uso: $0 <schema-prod.sql>" >&2; exit 2; }

fails=0
avisos=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; fails=$((fails + 1)); }
warn() { echo "AVISO: $1"; avisos=$((avisos + 1)); }

# extrai "tabela|coluna" de todos os CREATE TABLE do dump
COLS="$(awk '
  /^CREATE TABLE/ {
    t = $0
    sub(/^CREATE TABLE (IF NOT EXISTS )?/, "", t)
    sub(/ \($/, "", t)
    gsub(/"/, "", t); gsub(/^public\./, "", t)
    intab = 1; next
  }
  intab && /^\);/ { intab = 0; next }
  intab {
    line = $0
    sub(/^[ \t]+/, "", line)
    if (line ~ /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|LIKE)/) next
    col = line
    sub(/[ \t].*/, "", col)
    gsub(/"/, "", col)
    if (col != "") print t "|" col
  }
' "$DUMP")"

tem_tabela() { printf '%s\n' "$COLS" | grep -q "^$1|"; }
tem_coluna() { printf '%s\n' "$COLS" | grep -qx "$1|$2"; }

checa_tabela_cols() { # checa_tabela_cols <tabela> <col1,col2,...>
  local t="$1" faltando=""
  if ! tem_tabela "$t"; then fail "tabela \"$t\" AUSENTE"; return; fi
  for c in $(echo "$2" | tr ',' ' '); do
    tem_coluna "$t" "$c" || faltando="$faltando $c"
  done
  if [ -z "$faltando" ]; then
    pass "\"$t\" com todas as colunas pressupostas"
  else
    fail "\"$t\" sem coluna(s):$faltando"
  fi
}

echo "═ 1. Tabelas legadas pressupostas pela série 0000–0041 e pelo código vivo"
checa_tabela_cols Empresa "id,nome_empresa,email,pass,cnpj,id_grupo,tk,connection_id,workflow_id,sender"
checa_tabela_cols Grupo "id,nome,id_empresa_pai,login_unico_ativo"
checa_tabela_cols EnvioMassa "id,number,nome,cnpj_prestador,cnpj_tomador,valor,gorjeta,mensagem1,enviado,retorno_envio_msg_1,numnota,nota_ok,data_emissao,erro_validacao,mov_fechado,id_empresa,dt_inicial,dt_final"
checa_tabela_cols ProcessControl "id,user_id,status,execution_id"
checa_tabela_cols Motorista "id,cnpj_prestador,senha,nome,ativo"
if grep -qE 'UNIQUE.*cnpj_prestador|cnpj_prestador[^,]*UNIQUE' "$DUMP" \
   || grep -qE 'CREATE UNIQUE INDEX.*[Mm]otorista.*cnpj_prestador' "$DUMP"; then
  pass "Motorista.cnpj_prestador tem UNIQUE (base de login do app motorista)"
else
  fail "UNIQUE de Motorista.cnpj_prestador não encontrado"
fi

echo "═ 2. Nenhuma tabela do hub pré-existente"
HUB_TABELAS="SchemaMigration Usuario SessaoRefresh Papel Permissao PapelPermissao Modulo ModuloEntidade UsuarioEntidade Auditoria Entregador ImportacaoArquivo ImportacaoLinhaErro FaturamentoLancamento PerformanceTurno ContaMotorista EmpresaGrupoMovee"
ACHOU_HUB=""
for t in $HUB_TABELAS; do tem_tabela "$t" && ACHOU_HUB="$ACHOU_HUB $t"; done
if grep -q 'mv_faturamento_dia\|mv_performance_dia' "$DUMP"; then ACHOU_HUB="$ACHOU_HUB (MVs)"; fi
if [ -z "$ACHOU_HUB" ]; then
  pass "nenhum objeto do hub no banco (série aplica limpa do zero)"
else
  fail "objetos do hub JÁ EXISTEM:$ACHOU_HUB — investigar aplicação parcial anterior ANTES de prosseguir"
fi

echo "═ 3. Extensões (lição da 0040)"
for ext in unaccent pg_trgm; do
  linha="$(grep -E "CREATE EXTENSION.*\b$ext\b" "$DUMP" | head -1)"
  if [ -z "$linha" ]; then
    pass "extensão $ext ausente (0021 cria em public durante o P2)"
  elif echo "$linha" | grep -q 'WITH SCHEMA public'; then
    pass "extensão $ext já instalada em public"
  else
    fail "extensão $ext instalada FORA de public ($linha) — a 0040 (public.unaccent) quebraria; PARAR"
  fi
done

echo "═ 4. Versão do servidor (paridade com o ensaio: postgres 13)"
VERSAO="$(grep -m1 'Dumped from database version' "$DUMP" | grep -oE '[0-9]+\.[0-9]+' | head -1)"
case "$VERSAO" in
  13.*) pass "postgres $VERSAO (mesma major do ensaio S10)" ;;
  '')   warn "versão não encontrada no cabeçalho do dump — confirmar manualmente" ;;
  *)    warn "postgres $VERSAO ≠ 13.x do ensaio — avaliar antes do go" ;;
esac

echo "═ 5. Role de aplicação"
if grep -q 'TO authenticated' "$DUMP"; then
  pass "GRANTs 'TO authenticated' presentes (role de aplicação em uso — as migrations concedem a ele)"
else
  warn "nenhum GRANT 'TO authenticated' no dump — confirmar o nome do role do PostgREST de produção ANTES do P2 (se for outro, a série exige adaptação)"
fi
echo "  (existência do role em si: conferir com SELECT rolname FROM pg_roles — roles não entram em pg_dump de banco)"

echo
if [ "$fails" = "0" ]; then
  echo "VALIDA-SCHEMA-PROD: OK — schema compatível com a série 0000–0041 ($avisos aviso(s))"
  exit 0
else
  echo "VALIDA-SCHEMA-PROD: $fails FALHA(S), $avisos aviso(s) — NO-GO até resolvidas" >&2
  exit 1
fi

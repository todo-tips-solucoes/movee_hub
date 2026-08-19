#!/usr/bin/env bash
# =============================================================================
# backup-producao-expurgo.sh — exercita o caminho DESTRUTIVO do
# infra/producao/backup-producao.sh contra o hub-homolog, nunca produção.
#
# Existe porque o expurgo da D3b faz `rm -rf` num diretório escolhido por uma
# consulta SQL. A propriedade que o operador comprou ao decidir "extrair as
# linhas rejeitadas antes de expurgar" não pode ser uma frase no README: ela é
# um `NOT EXISTS` na consulta, e ou está provada ou não vale nada.
#
# O que este teste prova:
#   1. importação vencida e SEM pendência é expurgada — o diretório some e a
#      linha é marcada com `arquivo_expurgado_em`;
#   2. importação vencida COM linha rejeitada ainda sem `linha_bruta` NÃO é
#      expurgada — o diretório continua lá e a marca continua nula;
#   3. importação DENTRO do prazo não é tocada, mesmo estando tudo em ordem.
#
# Uso: infra/hub/testes/backup-producao-expurgo.sh
# =============================================================================
set -uo pipefail

DB_CONT_FILTRO=hub_homolog_db
DB_NAME=hub_homolog
DB_USER=hub_homolog
EMP=9099
TMPVOL="$(mktemp -d /tmp/hub-expurgo-teste-XXXXXX)"
falhas=0

psqlt() { docker exec -i "$(docker ps -qf name=$DB_CONT_FILTRO)" psql -U "$DB_USER" -d "$DB_NAME" -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }
psqle() { docker exec -i "$(docker ps -qf name=$DB_CONT_FILTRO)" psql -U "$DB_USER" -d "$DB_NAME" -q -v ON_ERROR_STOP=1 2>&1; }

check() {
  if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (obtido='$2' esperado='$3')"; falhas=$((falhas + 1)); fi
}

limpar() {
  psqle <<SQL >/dev/null
DELETE FROM "ImportacaoLinhaErro" WHERE id_empresa = $EMP;
DELETE FROM "ImportacaoArquivo"   WHERE id_empresa = $EMP;
SQL
  rm -rf "$TMPVOL"
}
trap limpar EXIT

echo "=== seed: 3 importações no cenário de cada regra ==="
psqle <<SQL >/dev/null || { echo "FAIL: seed"; exit 1; }
DELETE FROM "ImportacaoLinhaErro" WHERE id_empresa = $EMP;
DELETE FROM "ImportacaoArquivo"   WHERE id_empresa = $EMP;

-- (A) vencida e limpa -> DEVE ser expurgada
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, nome_arquivo, hash_sha256, tamanho_bytes, status, criado_em)
VALUES ($EMP, 'performance', 'expurgo-a.zip', repeat('a',64), 10, 'completed', now() - interval '2 years');
-- (B) vencida, mas com linha rejeitada SEM linha_bruta -> NÃO pode ser expurgada
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, nome_arquivo, hash_sha256, tamanho_bytes, status, criado_em)
VALUES ($EMP, 'faturamento', 'expurgo-b.zip', repeat('b',64), 10, 'completed_with_errors', now() - interval '2 years');
-- (C) dentro do prazo -> não se toca
INSERT INTO "ImportacaoArquivo" (id_empresa, tipo, nome_arquivo, hash_sha256, tamanho_bytes, status, criado_em)
VALUES ($EMP, 'performance', 'expurgo-c.zip', repeat('c',64), 10, 'completed', now());

INSERT INTO "ImportacaoLinhaErro" (importacao_id, id_empresa, numero_linha, motivo, campo, valor_mascarado, linha_bruta)
SELECT id, $EMP, 9, 'UUID inválido', 'id_da_pessoa_entregadora', '**', NULL
FROM "ImportacaoArquivo" WHERE id_empresa = $EMP AND nome_arquivo = 'expurgo-b.zip';
SQL

ID_A="$(psqlt "SELECT id FROM \"ImportacaoArquivo\" WHERE id_empresa=$EMP AND nome_arquivo='expurgo-a.zip'")"
ID_B="$(psqlt "SELECT id FROM \"ImportacaoArquivo\" WHERE id_empresa=$EMP AND nome_arquivo='expurgo-b.zip'")"
ID_C="$(psqlt "SELECT id FROM \"ImportacaoArquivo\" WHERE id_empresa=$EMP AND nome_arquivo='expurgo-c.zip'")"
[ -n "$ID_A" ] && [ -n "$ID_B" ] && [ -n "$ID_C" ] || { echo "FAIL: seed não criou as importações"; exit 1; }

# Volume falso: um diretório por importação, como o volume real.
for i in "$ID_A" "$ID_B" "$ID_C"; do mkdir -p "$TMPVOL/$i"; echo "conteudo $i" > "$TMPVOL/$i/original.zip"; done

echo "=== roda o expurgo do script real, apontado para o hub-homolog ==="
HUB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$HUB_DIR/.." && pwd)"
DEST_TESTE="$(mktemp -d /tmp/hub-expurgo-dest-XXXXXX)"

BACKUP_DB="$DB_NAME" \
BACKUP_DB_CONT="$DB_CONT_FILTRO" \
BACKUP_DEST="$DEST_TESTE" \
BACKUP_MIN_LIVRE_MB=1 \
BACKUP_VOLUME_MOUNT_OVERRIDE="$TMPVOL" \
"$REPO_DIR/producao/backup-producao.sh" 2>&1 | sed 's/^/    /'

echo "=== asserções ==="
[ -d "$TMPVOL/$ID_A" ] && a_dir=existe || a_dir=apagado
[ -d "$TMPVOL/$ID_B" ] && b_dir=existe || b_dir=apagado
[ -d "$TMPVOL/$ID_C" ] && c_dir=existe || c_dir=apagado

check "(A) vencida e limpa -> diretório APAGADO" "$a_dir" "apagado"
check "(A) vencida e limpa -> marcada com arquivo_expurgado_em" \
  "$(psqlt "SELECT (arquivo_expurgado_em IS NOT NULL)::text FROM \"ImportacaoArquivo\" WHERE id=$ID_A")" "true"

check "(B) linha rejeitada sem linha_bruta -> diretório PRESERVADO" "$b_dir" "existe"
check "(B) linha rejeitada sem linha_bruta -> NÃO marcada como expurgada" \
  "$(psqlt "SELECT (arquivo_expurgado_em IS NULL)::text FROM \"ImportacaoArquivo\" WHERE id=$ID_B")" "true"

check "(C) dentro do prazo -> diretório PRESERVADO" "$c_dir" "existe"
check "(C) dentro do prazo -> NÃO marcada como expurgada" \
  "$(psqlt "SELECT (arquivo_expurgado_em IS NULL)::text FROM \"ImportacaoArquivo\" WHERE id=$ID_C")" "true"

# Controle: preencher linha_bruta libera (B) na execução seguinte. Sem isto o
# teste provaria só que o script não expurga nada, o que passaria com um bug.
echo "=== controle positivo: preenchida a linha_bruta, (B) passa a ser expurgável ==="
psqle <<SQL >/dev/null
UPDATE "ImportacaoLinhaErro" SET linha_bruta = 'linha;crua;recuperada' WHERE importacao_id = $ID_B;
SQL
BACKUP_DB="$DB_NAME" BACKUP_DB_CONT="$DB_CONT_FILTRO" BACKUP_DEST="$DEST_TESTE" \
BACKUP_MIN_LIVRE_MB=1 BACKUP_VOLUME_MOUNT_OVERRIDE="$TMPVOL" \
"$REPO_DIR/producao/backup-producao.sh" >/dev/null 2>&1

[ -d "$TMPVOL/$ID_B" ] && b_dir2=existe || b_dir2=apagado
check "(B) com linha_bruta preenchida -> agora É expurgada" "$b_dir2" "apagado"
check "(C) segue intocada mesmo na 2ª rodada" \
  "$(psqlt "SELECT (arquivo_expurgado_em IS NULL)::text FROM \"ImportacaoArquivo\" WHERE id=$ID_C")" "true"

rm -rf "$DEST_TESTE"
echo
if [ "$falhas" = 0 ]; then
  echo "BACKUP-PRODUCAO-EXPURGO: OK — todas as asserções passaram"
else
  echo "BACKUP-PRODUCAO-EXPURGO: ${falhas} asserção(ões) FALHARAM"; exit 1
fi

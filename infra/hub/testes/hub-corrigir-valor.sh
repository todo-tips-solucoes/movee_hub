#!/usr/bin/env bash
# Driver do teste da 0116 (hub_envio_massa_corrigir_valor) contra o hub-homolog.
#   infra/hub/testes/hub-corrigir-valor.sh                  # normal (migration do arquivo)
#   CONTROLE=sem-guarda   ...  # remove a guarda de nota enviada: casos aprovada tem de falhar
#   CONTROLE=sem-empresa  ...  # remove o filtro id_empresa: caso 'outra' tem de falhar
#   CONTROLE=sem-lock     ...  # remove FOR UPDATE: o teste de concorrencia tem de falhar
# Parte 1: transacao com ROLLBACK. Parte 2 (concorrencia): duas sessoes reais, fixture
# commitada e removida no fim (Auditoria limpa com session_replication_role=replica).
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/../../.." && pwd)"
DB=hub_homolog_db
MIG="$RAIZ/infra/hub/migrations/0116_envio_massa_corrigir_valor.sql"
TESTE="$RAIZ/infra/hub/testes/sql/0116-corrigir-valor.test.sql"
P() { docker exec -i "$DB" sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' _ "$@"; }

mig() {
  case "${CONTROLE:-}" in
    sem-guarda)  sed "s/ELSIF NULLIF(btrim(COALESCE(r.nota_ok/ELSIF false AND NULLIF(btrim(COALESCE(r.nota_ok/" "$MIG" ;;
    sem-empresa) sed "s/WHERE id = v_id AND id_empresa = p_id_empresa FOR UPDATE/WHERE id = v_id FOR UPDATE/" "$MIG" ;;
    sem-lock)    sed "s/ FOR UPDATE;/;/" "$MIG" ;;
    *) cat "$MIG" ;;
  esac
}

echo "== parte 1: unit SQL (rollback)"
{ echo 'BEGIN;'; mig; cat "$TESTE"; echo 'ROLLBACK;'; } | P 2>&1 | grep -E 'NOTICE|ERROR|FALHOU|ASSERT' | sed 's/^psql:[^ ]* //' || true

echo "== parte 2: concorrencia (nota anexada entre leitura e gravacao)"
# a funcao do controle e instalada de verdade so durante o teste e restaurada ao fim
mig | P -q >/dev/null
ID=$(P -Atc "INSERT INTO \"EnvioMassa\" (nome,valor,id_empresa) VALUES ('T0116 conc',100,9001) RETURNING id" | head -1)
# A: anexa a nota e segura a transacao 3s; B: chama a funcao e fica bloqueado na linha
( P -c "BEGIN; UPDATE \"EnvioMassa\" SET nota_ok='N-CONC' WHERE id=$ID; SELECT pg_sleep(3); COMMIT;" >/dev/null ) &
sleep 1
RES=$(P -Atc "SELECT desfecho FROM hub_envio_massa_corrigir_valor(9001, '[{\"id\":$ID,\"valor\":999}]'::jsonb,'conc','tela',NULL)" | head -1)
wait
VAL=$(P -Atc "SELECT valor FROM \"EnvioMassa\" WHERE id=$ID" | head -1)
P -c "SET session_replication_role=replica; DELETE FROM \"Auditoria\" WHERE recurso_id='$ID' AND recurso='EnvioMassa'; DELETE FROM \"EnvioMassa\" WHERE id=$ID;" >/dev/null
cat "$MIG" | P -q >/dev/null   # restaura a funcao oficial
if [ "$RES" = "pulado_nota_enviada" ] && [ "$VAL" = "100" ]; then echo "ok  concorrencia: desfecho=$RES valor=$VAL"; else echo "FALHOU concorrencia: desfecho=$RES valor=$VAL (esperado pulado_nota_enviada/100)"; fi

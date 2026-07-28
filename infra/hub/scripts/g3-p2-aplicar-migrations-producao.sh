#!/usr/bin/env bash
# =============================================================================
# g3-p2-aplicar-migrations-producao.sh — P2 do RUNBOOK-CUTOVER.md §7.
# EXECUTADO PELO OPERADOR na janela do G3 (2026-07-25, escopo: série completa
# 0000–0046; 0033/0034 puladas por pré-registro; 0046 APLICA — decisão do
# operador na véspera). Mesmo mecanismo do migrate.sh: psql -1 (transação por
# arquivo) + ON_ERROR_STOP + registro em "SchemaMigration"; SIGUSR1 no
# PostgREST SÓ com a série completa.
# Usuário do banco: resolvido pela env POSTGRES_USER DENTRO do container.
#
# Ensaio (não-produção): DB_CONT_OVERRIDE=<container> SKIP_SIGUSR1=1 aponta
# para um clone descartável hub_* — usado na janela para validar o script
# contra o restore do dump P1 antes de rodar em produção.
# =============================================================================
set -u

DB_CONT=${DB_CONT_OVERRIDE:-$(docker ps -qf name=pgadmin_db.1)}
[ -n "$DB_CONT" ] || { echo "NO-GO: container do banco não encontrado"; exit 1; }
if [ "${SKIP_SIGUSR1:-0}" != 1 ]; then
  PGRST_CONT=$(docker ps -qf name=pgadmin_postgrest)
  [ -n "$PGRST_CONT" ] || { echo "NO-GO: container pgadmin_postgrest não encontrado"; exit 1; }
fi

echo "== pré-registro das migrations PULADAS (0033/0034) =="
docker exec -i "$DB_CONT" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v ON_ERROR_STOP=1' <<'SQL' \
  || { echo "NO-GO: pré-registro falhou"; exit 1; }
CREATE TABLE IF NOT EXISTS "SchemaMigration" (
  id serial PRIMARY KEY, nome text UNIQUE NOT NULL, aplicado_em timestamptz NOT NULL DEFAULT now());
INSERT INTO "SchemaMigration" (nome) VALUES
  ('0033_schema_legado_envio_massa.sql'),
  ('0034_seed_legado_envio_massa_teste.sql')
ON CONFLICT (nome) DO NOTHING;
SQL

cd /var/lib/envioMassa_homologacao/infra/hub/migrations || exit 1
ok=1
for f in $(ls *.sql | sort); do
  ja=$(docker exec -e MIG="$f" "$DB_CONT" sh -c \
    'psql -U "$POSTGRES_USER" -d chatmasterveloz -tAc "SELECT 1 FROM \"SchemaMigration\" WHERE nome = '\''$MIG'\''"')
  if [ "$ja" = "1" ]; then echo "pulada (já registrada): $f"; continue; fi
  echo "aplicando: $f"
  docker exec -i "$DB_CONT" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v ON_ERROR_STOP=1 -1 -f -' < "$f" \
    || { echo "FALHOU em $f — PARAR (colar o erro para a sessão)"; ok=0; break; }
  docker exec -e MIG="$f" "$DB_CONT" sh -c \
    'psql -U "$POSTGRES_USER" -d chatmasterveloz -c "INSERT INTO \"SchemaMigration\" (nome) VALUES ('\''$MIG'\'') ON CONFLICT DO NOTHING"' >/dev/null
done

if [ "$ok" = 1 ]; then
  if [ "${SKIP_SIGUSR1:-0}" = 1 ]; then
    echo "P2 (ENSAIO) COMPLETO — SIGUSR1 pulado por design"
  else
    docker kill -s SIGUSR1 "$PGRST_CONT" >/dev/null && echo "SIGUSR1 enviado ao PostgREST (reload de schema)"
    echo "P2 COMPLETO — série registrada. Rodar as checagens do P3."
  fi
else
  echo "SIGUSR1 NÃO enviado (série incompleta) — resolver a falha antes"
  exit 1
fi

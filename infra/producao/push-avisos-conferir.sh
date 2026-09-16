#!/usr/bin/env bash
# Confere as entregas dos últimos N avisos em PRODUÇÃO, com latência no servidor.
# Só leitura. Não imprime CNPJ, nome, título, corpo nem endpoint completo — só o
# host do serviço de push.
#
#   bash push-avisos-conferir.sh [N avisos mais recentes; padrão 10]
set -euo pipefail
N=${1:-10}
[[ "$N" =~ ^[0-9]+$ ]] && [ "$N" -ge 1 ] && [ "$N" -le 50 ] || { echo "ABORTA: N de 1 a 50"; exit 1; }
CID=$(docker ps -qf name=pgadmin_db | head -1)
[ -n "$CID" ] || { echo "ABORTA: pgadmin_db não encontrado"; exit 1; }

docker exec -i "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -At -F " | " -v ON_ERROR_STOP=1' <<SQL
SELECT '=== últimos $N avisos';
SELECT 'aviso ' || id, 'status=' || status, 'modo=' || modo_destinatarios,
       'criado=' || to_char(criado_em AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI:SS')
  FROM "Aviso" ORDER BY id DESC LIMIT $N;

SELECT '=== entregas desses avisos por status e serviço de push';
SELECT 'status=' || e.status,
       coalesce(substring(p.endpoint from '^https://([^/]+)/'), '(inscrição removida)'),
       'motivo=' || coalesce(e.motivo, '-'), 'qtd=' || count(*)
  FROM "AvisoEntrega" e LEFT JOIN "PushInscricao" p ON p.id = e.inscricao_id
 WHERE e.aviso_id IN (SELECT id FROM "Aviso" ORDER BY id DESC LIMIT $N)
 GROUP BY e.status, 2, e.motivo ORDER BY 2, 1;

SELECT '=== tempo no servidor: criação do aviso até a entrega aceita (segundos)';
SELECT 'aceitas=' || count(*),
       'mediana=' || coalesce(round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM e.atualizado_em - a.criado_em))::numeric, 1)::text, '-'),
       'p95=' || coalesce(round(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM e.atualizado_em - a.criado_em))::numeric, 1)::text, '-'),
       'max=' || coalesce(round(max(extract(epoch FROM e.atualizado_em - a.criado_em))::numeric, 1)::text, '-')
  FROM "AvisoEntrega" e JOIN "Aviso" a ON a.id = e.aviso_id
 WHERE e.status = 'aceito' AND a.id IN (SELECT id FROM "Aviso" ORDER BY id DESC LIMIT $N);
SQL

echo "=== logs do backend nos últimos 30 min (só contagens)"
L=$(docker service logs --since 30m envio-massa-homologacao_backend_homologacao 2>&1 || true)
echo "PUSH_INDISPONIVEL=$(printf '%s' "$L" | grep -c PUSH_INDISPONIVEL || true) | AUDITORIA_PERDIDA=$(printf '%s' "$L" | grep -c AUDITORIA_PERDIDA || true) | 429 no disparo=$(printf '%s' "$L" | grep -c 'LIMITE_DISPAROS\|Too Many' || true)"

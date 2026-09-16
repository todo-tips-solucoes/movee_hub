#!/usr/bin/env bash
# Panorama das inscrições de push do app motorista, em PRODUÇÃO.
# Só leitura. Não imprime CNPJ, nome nem endpoint completo — só o host do
# serviço de push e a conta em hash.
#
#   bash push-avisos-inscricoes.sh [id_entregador]
#
# Sem argumento: totais por plataforma/serviço/chave + as últimas registradas.
# Com id de Entregador: acrescenta as inscrições daquela conta (é o que diz se
# o aparelho de teste está ativo antes de disparar qualquer coisa).
set -euo pipefail
ID=${1:-}
[ -z "$ID" ] || [[ "$ID" =~ ^[0-9]+$ ]] || { echo "ABORTA: id_entregador deve ser número"; exit 1; }
N_ULTIMAS=8

CID=$(docker ps -qf name=pgadmin_db | head -1)
[ -n "$CID" ] || { echo "ABORTA: pgadmin_db não encontrado"; exit 1; }
psql_() { docker exec -i "$CID" sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -At -F " | " -v ON_ERROR_STOP=1'; }

psql_ <<SQL
SELECT '=== total';
SELECT 'inscricoes=' || count(*), 'contas distintas=' || count(DISTINCT cnpj_prestador) FROM "PushInscricao";

SELECT '=== por plataforma';
SELECT plataforma, count(*) FROM "PushInscricao" GROUP BY 1 ORDER BY 2 DESC;

SELECT '=== por serviço de push';
SELECT coalesce(substring(endpoint from '^https://([^/]+)/'), '(ilegivel)'), count(*)
  FROM "PushInscricao" GROUP BY 1 ORDER BY 2 DESC;

SELECT '=== por chave VAPID (só a atual é alcançada pelo disparo)';
SELECT 'key_id=' || key_id, count(*) FROM "PushInscricao" GROUP BY 1 ORDER BY 2 DESC;

SELECT '=== alcance de um aviso toda_base (contas ativas na ContaMotorista)';
SELECT 'entregas por aviso toda_base=' || count(*)
  FROM "PushInscricao" pi
 WHERE EXISTS (SELECT 1 FROM "ContaMotorista" cm
                WHERE cm.cnpj_prestador = pi.cnpj_prestador AND cm.ativo);

SELECT '=== últimas $N_ULTIMAS inscrições registradas';
SELECT to_char(criado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI:SS'),
       plataforma,
       coalesce(substring(endpoint from '^https://([^/]+)/'), '(ilegivel)'),
       'conta ' || left(md5(cnpj_prestador), 6),
       CASE WHEN key_id = (SELECT key_id FROM "PushInscricao" GROUP BY key_id ORDER BY count(*) DESC LIMIT 1)
            THEN 'chave atual' ELSE 'OUTRA CHAVE (não recebe)' END
  FROM "PushInscricao" ORDER BY criado_em DESC LIMIT $N_ULTIMAS;
SQL

[ -n "$ID" ] || exit 0
psql_ <<SQL
SELECT '=== inscrições da conta do entregador $ID';
SELECT to_char(pi.criado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI:SS'),
       pi.plataforma,
       coalesce(substring(pi.endpoint from '^https://([^/]+)/'), '(ilegivel)')
  FROM "PushInscricao" pi
  JOIN "ContaMotorista" cm ON cm.cnpj_prestador = pi.cnpj_prestador
  JOIN "Entregador" e ON e.motorista_id = cm.id
 WHERE e.id = $ID
 ORDER BY pi.criado_em DESC;
SQL

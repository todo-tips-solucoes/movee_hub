-- 02 — Carga do CPF dos entregadores a partir do enriquecimento EntreGô.
--
-- ⚠️ ARTEFATO PARA O OPERADOR APLICAR MANUALMENTE (rito de produção, CLAUDE.md).
--
-- POR QUE ESTE SCRIPT EXISTE — o briefing dizia só "rodar
-- `SELECT hub_entregador_documento_carregar_do_enriquecimento();`". Isso NÃO
-- funciona por psql: a função (0085) exige `adiantamentos.contas_revisar` e lê
-- o escopo, e as duas coisas vêm das CLAIMS DO JWT. psql não tem JWT, então
-- a chamada crua devolve `ERROR: PERMISSAO_NEGADA` (medido no hub-homolog em
-- 2026-09-21).
--
-- O caminho é simular a sessão de um usuário que TEM a permissão, setando
-- `request.jwt.claims` local à transação. Isso NÃO é bypass:
-- hub_adiantamento_tem_permissao consulta o banco pelo `sub` — se o usuário
-- não tiver a permissão de verdade, continua negado.
--
-- SEGURO POR PADRÃO: sem `-v aplicar=true` roda em SIMULAÇÃO (ROLLBACK) e só
-- mostra quantos documentos gravaria. Idempotente: a função faz
-- `ON CONFLICT (entregador_id) DO NOTHING`, então reaplicar não duplica.
--
-- Pré-requisito: um usuário com papel `financeiro` (ou `admin_entidade`)
-- vinculado à empresa — é o passo 2 do RUNBOOK-GO-LIVE.md.
--
-- Uso (produção — simular primeiro, SEMPRE):
--   DB=$(docker ps -q -f name=pgadmin_db)   # task do Swarm: o sufixo muda a cada restart
--   docker exec -i $DB sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz \
--     -v usuario_id=<ID> -v id_empresa=6' < 02-carga-documentos.sql
--   ... conferir o número, e então:
--   docker exec -i $DB sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz \
--     -v usuario_id=<ID> -v id_empresa=6 -v aplicar=true' < 02-carga-documentos.sql
--
-- Esperado: `gravados_agora` pode ser MENOR que o total de entregadores
-- enriquecidos, e isso NÃO é defeito. Desde a 0085 o trigger
-- `entregador_documento_enriquecimento` grava o documento sozinho a cada
-- enriquecimento; esta função é só o BACKFILL de quem foi enriquecido ANTES
-- da 0085 e não foi re-enriquecido desde então (trigger não é retroativo).

\set ON_ERROR_STOP on

\if :{?usuario_id}
\else
  \echo 'ERRO: informe -v usuario_id=<id do usuário financeiro>'
  \quit
\endif
\if :{?id_empresa}
\else
  \echo 'ERRO: informe -v id_empresa=<id> (grupo Movee = 6)'
  \quit
\endif
\if :{?aplicar}
\else
  \set aplicar false
\endif

BEGIN;

-- A sessão simulada: `true` = local à transação, some no COMMIT/ROLLBACK.
\o /dev/null
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', :'usuario_id', 'empresa_ativa', :id_empresa, 'escopo', json_build_array(:id_empresa))::text,
  true
);
\o

-- Falha com mensagem que diz O QUE fazer, em vez do PERMISSAO_NEGADA cru.
DO $$
BEGIN
  IF NOT hub_adiantamento_tem_permissao('adiantamentos.contas_revisar') THEN
    RAISE EXCEPTION 'O usuário informado não tem adiantamentos.contas_revisar nesta empresa. Confira o vínculo (papel financeiro ou admin_entidade) — passo 2 do runbook.';
  END IF;
END $$;

SELECT count(*) AS ja_tinham_documento
FROM "EntregadorDocumento" WHERE id_empresa = :id_empresa;

SELECT hub_entregador_documento_carregar_do_enriquecimento() AS gravados_agora;

SELECT count(*) AS total_depois
FROM "EntregadorDocumento" WHERE id_empresa = :id_empresa;

\if :aplicar
  COMMIT;
  \echo '>>> APLICADO (COMMIT). Os números acima estão gravados.'
\else
  ROLLBACK;
  \echo '>>> SIMULAÇÃO (ROLLBACK) — nada foi gravado. Se os números fazem sentido, repita com -v aplicar=true'
\endif

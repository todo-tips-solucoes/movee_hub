-- 01 — Diagnóstico do go-live do adiantamento. SOMENTE LEITURA.
--
-- ⚠️ ARTEFATO PARA O OPERADOR. Não grava nada: roda numa transação READ ONLY
-- que termina em ROLLBACK. Pode ser rodado quantas vezes quiser, antes e
-- depois de cada passo do RUNBOOK-GO-LIVE.md, para ver o que mudou.
--
-- POR QUE EXISTE: o briefing de dívida listava "ligar o módulo" como passo 1.
-- A migration 0070 JÁ faz isso (`ModuloEntidade ... ativo=true` para a
-- empresa 6), mas com `ON CONFLICT DO NOTHING` — o mesmo padrão que, no robô
-- EntreGô (001, 2026-08-28), fez NADA ser aplicado enquanto a saída parecia
-- sucesso. Só o banco diz o que de fato está lá. Medir antes de mexer.
--
-- Uso:
--   DB=$(docker ps -q -f name=pgadmin_db)
--   docker exec -i $DB sh -c 'psql -U "$POSTGRES_USER" -d chatmasterveloz -v id_empresa=6' \
--     < 01-diagnostico.sql

\set ON_ERROR_STOP on
\if :{?id_empresa}
\else
  \echo 'ERRO: informe -v id_empresa=<id> (grupo Movee = 6)'
  \quit
\endif

BEGIN READ ONLY;

\echo ''
\echo '== 1. O módulo está ligado para a empresa? =='
SELECT m.codigo, me.empresa_id, me.ativo
FROM "ModuloEntidade" me JOIN "Modulo" m ON m.id = me.modulo_id
WHERE m.codigo = 'adiantamentos' AND me.empresa_id = :id_empresa;
\echo '   (sem linha, ou ativo=f -> o módulo NÃO está ligado)'

\echo ''
\echo '== 2. O papel financeiro existe e tem as permissões do módulo? =='
SELECT p.nome AS papel, count(pe.id) AS permissoes_adiantamento
FROM "Papel" p
LEFT JOIN "PapelPermissao" pp ON pp.papel_id = p.id
LEFT JOIN "Permissao" pe ON pe.id = pp.permissao_id
LEFT JOIN "Modulo" m ON m.id = pe.modulo_id AND m.codigo = 'adiantamentos'
WHERE p.nome IN ('financeiro', 'admin_entidade')
  AND (pe.id IS NULL OR m.id IS NOT NULL)
GROUP BY p.nome ORDER BY p.nome;
\echo '   (esperado: 10 em cada um)'

\echo ''
\echo '== 3. Quem pode operar o adiantamento nesta empresa? =='
SELECT ue.usuario_id, u.email, p.nome AS papel
FROM "UsuarioEntidade" ue
JOIN "Usuario" u ON u.id = ue.usuario_id
JOIN "Papel" p ON p.id = ue.papel_id
WHERE ue.empresa_id = :id_empresa AND p.nome IN ('financeiro', 'admin_entidade')
ORDER BY p.nome, ue.usuario_id;
\echo '   (o usuario_id daqui é o que o 02-carga-documentos.sql pede)'

\echo ''
\echo '== 4. A configuração VIGENTE (a mesma que o sistema usa) =='
SELECT versao, vigente_desde::date,
       fonte_producao,
       categorias_producao,
       apuracao_dia_inicio,
       apuracao_dias_ate_repasse,
       apuracao_data_base,
       repasse_visivel_app
FROM hub_adiantamento_config_vigente(:id_empresa);

\echo ''
\echo '== 5. Documentos dos entregadores (o que a carga do passo 3 vai pegar) =='
SELECT
  count(*) FILTER (WHERE e.dados_entrego_json IS NOT NULL)                       AS enriquecidos,
  count(d.entregador_id)                                                         AS com_documento,
  count(*) FILTER (WHERE e.dados_entrego_json IS NOT NULL AND d.entregador_id IS NULL
                   AND regexp_replace(COALESCE(e.dados_entrego_json->'dadosPessoais'->>'cpf',''), '\D', '', 'g') ~ '^[0-9]{11}$')
                                                                                 AS a_carga_vai_gravar
FROM "Entregador" e
LEFT JOIN "EntregadorDocumento" d ON d.entregador_id = e.id
WHERE e.id_empresa = :id_empresa;

\echo ''
\echo '== VEREDITO — o que ainda trava =='
WITH c AS (SELECT * FROM hub_adiantamento_config_vigente(:id_empresa)),
     mod AS (
       SELECT bool_or(me.ativo) AS ativo FROM "ModuloEntidade" me
       JOIN "Modulo" m ON m.id = me.modulo_id
       WHERE m.codigo = 'adiantamentos' AND me.empresa_id = :id_empresa),
     quem AS (
       SELECT count(*) FILTER (WHERE p.nome = 'financeiro') AS financeiros
       FROM "UsuarioEntidade" ue JOIN "Papel" p ON p.id = ue.papel_id
       WHERE ue.empresa_id = :id_empresa)
SELECT item, situacao FROM (VALUES
  (1, 'módulo ligado',                    CASE WHEN (SELECT ativo FROM mod) THEN 'OK' ELSE 'FALTA — ver runbook passo 1' END),
  (2, 'usuário no papel financeiro',      CASE WHEN (SELECT financeiros FROM quem) > 0 THEN 'OK' ELSE 'FALTA — runbook passo 2' END),
  (3, 'adiantamento: fonte_producao',     CASE WHEN (SELECT fonte_producao FROM c) IS NOT NULL THEN 'OK' ELSE 'FALTA — o motorista recebe indisponível (runbook passo 4)' END),
  (4, 'repasse no app: visível',          CASE WHEN (SELECT repasse_visivel_app FROM c) THEN 'OK' ELSE 'FALTA — runbook passo 4' END),
  (5, 'repasse no app: dia da apuração',  CASE WHEN (SELECT apuracao_dia_inicio FROM c) IS NOT NULL THEN 'OK' ELSE 'FALTA — runbook passo 4 (produção usa 1 = segunda)' END)
) AS v(ordem, item, situacao) ORDER BY ordem;

ROLLBACK;

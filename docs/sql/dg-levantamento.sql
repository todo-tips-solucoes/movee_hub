-- ============================================================================
-- Levantamento dos CNPJs da D&G já cadastrados em "Empresa"
-- Feature: Configuração de UI por tenant (white-label) + Grupo de CNPJs
--
-- Contexto: a coluna de razão social é nome_empresa (confirmado no backend).
-- O classifier bloqueia meu acesso ao banco — rode você e me devolva o resultado
-- (pode colar a saída aqui). Confirme comigo QUAIS CNPJs entram no grupo D&G
-- ANTES de qualquer migração de vínculo.
-- ============================================================================

-- (0) Sanidade: confirmar as colunas reais de "Empresa" antes de tudo.
--     Se nome_empresa não aparecer, me avise para ajustar a query (1).
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'Empresa'
ORDER BY ordinal_position;

-- (1) Candidatos D&G — tolerante a variações de grafia (D&G, D & G, D AND G, DG ...).
--     Ajuste/expanda os termos conforme o que aparecer na saída.
SELECT id,
       nome_empresa AS razao_social,
       email
       -- , cnpj_prestador        -- descomente se a coluna existir (ver query 0)
       -- , endereco, numero, cep -- descomente se existirem e forem úteis
FROM "Empresa"
WHERE nome_empresa ILIKE '%D&G%'
   OR nome_empresa ILIKE '%D & G%'
   OR nome_empresa ILIKE '%D AND G%'
   OR nome_empresa ILIKE 'DG %'
   OR nome_empresa ILIKE 'D G %'
ORDER BY razao_social, id;

-- (2) (Opcional) Volume de movimentos por candidato — ajuda a decidir o "pai"
--     (normalmente o CNPJ com mais histórico vira a matriz do grupo).
--     Rode só depois de validar a lista da query (1).
-- SELECT e.id, e.nome_empresa, COUNT(em.id) AS qtd_movimentos
-- FROM "Empresa" e
-- LEFT JOIN "EnvioMassa" em ON em.id_empresa = e.id
-- WHERE e.id IN ( /* ids confirmados na query (1) */ )
-- GROUP BY e.id, e.nome_empresa
-- ORDER BY qtd_movimentos DESC;

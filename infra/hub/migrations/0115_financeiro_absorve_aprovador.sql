-- 0115 — `financeiro` passa a ter `adiantamentos.pagamento_confirmar`: o perfil
-- comum absorve tudo o que o `financeiro_aprovador` fazia.
--
-- POR QUE: decisão do operador (2026-10-19): "Todos do financeiro podem fazer o
-- que o perfil aprovador faz. O perfil aprovador continua existindo, porém a
-- única coisa que fará diferente é quando tivermos a possibilidade de aprovar
-- pagamento na Transfeera por API — apenas esse perfil pode aprovar o
-- pagamento." Medido em produção: a diferença entre os dois papéis era
-- EXATAMENTE uma permissão (`adiantamentos.pagamento_confirmar`) e o
-- `financeiro` não tinha nada que o aprovador não tivesse.
--
-- ⚠️ O QUE ISSO LIBERA PARA TODO `financeiro`. Não é só "confirmar pagamento":
--   - FECHAR APURAÇÃO da semana — IRREVERSÍVEL: grava o retrato definitivo e
--     NÃO existe botão de reabrir ........ POST /repasse/:periodo/fechar
--   - Gerar notas da semana (cria os movimentos no Envio em Massa)
--                                          POST /repasse/:periodo/movimentos
--   - Importar o retorno da Transfeera ... POST /lotes/:id/retorno
--   - Confirmar pagamento na mão ......... POST /lotes/:id/confirmacao
--   - Alterar o valor mínimo do repasse .. tela de Configurações
--   - "Já foi pago" e "Apagar nota" na tela de pagamentos retidos
--                                          (routes/hub-validacao-xml.js)
--
-- ⚠️ OS DOIS PAPÉIS FICAM IDÊNTICOS DEPOIS DESTA MIGRATION. É INTENCIONAL, não
-- duplicação acidental — NÃO "limpe" um dos dois. O operador mantém o
-- `financeiro_aprovador` para quando existir a aprovação de pagamento na
-- Transfeera por API, que será criada como PERMISSÃO NOVA e exclusiva dele.
-- Enquanto essa permissão não existir, escolher um papel ou outro para um
-- usuário NÃO muda nada.
--
-- Ids resolvidos por nome/código. Idempotente (ON CONFLICT DO NOTHING),
-- aditiva, uma linha, sem DELETE.

INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p
CROSS JOIN "Permissao" perm
WHERE p.nome = 'financeiro'
  AND perm.codigo = 'adiantamentos.pagamento_confirmar'
ON CONFLICT DO NOTHING;

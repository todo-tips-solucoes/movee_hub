-- 0101 — `financeiro` e `financeiro_aprovador` passam a enxergar e usar
-- Envio em Massa (leitura), Validação XML e Motoristas (leitura).
--
-- POR QUE: pedido do operador (2026-09-29). Os dois papéis só viam
-- "Adiantamento" — o menu do hub é `ModuloEntidade ativo ∩ prefixos das
-- permissões efetivas` (routes/hub-me.js), e como a 0070 deu a `financeiro`
-- somente permissões `adiantamentos.*`, nenhum outro módulo aparecia. Quem
-- concilia repasse precisa conferir o movimento do Envio em Massa, validar as
-- NFS-e e abrir a ficha do motorista.
--
-- ESCOPO DECIDIDO PELO OPERADOR — leitura, não operação:
--   - `envio_massa.consultar`  → abre a tela, vê o movimento, exporta CSV.
--     NÃO ganha `.criar` (subir planilha/editar linha), `.enviar` (iniciar e
--     parar disparo) nem `.aprovar` (excluir movimento).
--   - `validacao_xml.validar`  → valida NFS-e em lote.
--   - `motoristas.listar` + `.consultar` → lista e ficha. NÃO ganha
--     `.editar`, `.credencial` (acesso do motorista ao app) nem
--     `.dados_sensiveis`.
--
-- ⚠️ ACOMPANHA UMA MUDANÇA DE CÓDIGO, na mesma entrega: até aqui
-- `/validate-xml-batch` (server.js) era gateado por `envio_massa.enviar` —
-- a 0047 criou `validacao_xml.validar` só para o item aparecer no menu e
-- deixou escrito que um gate próprio viria depois. Sem a troca do gate, dar
-- Validação XML ao financeiro obrigaria a dar também o poder de disparar
-- envio em massa. Ninguém perde acesso na troca: a própria 0047 concedeu
-- `validacao_xml.validar` a TODO papel que já tinha `envio_massa.enviar`.
--
-- ⚠️ `financeiro_aprovador` é tratado EXPLICITAMENTE aqui. Ele nasceu (0097)
-- como cópia PONTUAL de `financeiro`, sem vínculo vivo: permissão nova dada
-- só a `financeiro` não se propaga (CLAUDE.md §"Migrations do hub").
--
-- NÃO mexe em `ModuloEntidade`: habilitar módulo por entidade é outra
-- decisão, de outro dono. Se o módulo não estiver ativo para a entidade, o
-- item continua fora do menu mesmo com a permissão — que é o comportamento
-- deny-by-default desejado.
--
-- Idempotente (ON CONFLICT DO NOTHING), aditiva, sem DELETE: reexecutar não
-- muda nada e nenhum papel perde permissão.

INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p
CROSS JOIN "Permissao" perm
WHERE p.nome IN ('financeiro', 'financeiro_aprovador')
  AND perm.codigo IN (
      'envio_massa.consultar',
      'validacao_xml.validar',
      'motoristas.listar',
      'motoristas.consultar'
  )
ON CONFLICT DO NOTHING;

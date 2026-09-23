-- ROLLBACK da 0093 (vínculo por EnvioMassa).
--
-- Dropa a função. Os VÍNCULOS já criados FICAM — e isso é deliberado:
--   - `Entregador.motorista_id` preenchido é dado de cadastro, não artefato
--     desta migration; desfazer em massa quebraria o adiantamento e o repasse
--     de quem passou a ter CNPJ.
--   - as `ContaMotorista` criadas podem já ter recebido conta bancária,
--     solicitação ou movimento.
--
-- Se for mesmo para desfazer, é decisão à parte e precisa da lista. A trilha
-- está em "Auditoria" (ação `motorista.vinculado_por_envio_massa`), e estes
-- são os vínculos que a função teria criado:
--
--   SELECT e.id, e.nome FROM "Entregador" e
--     JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
--    WHERE e.id_empresa = 6 AND cm.criado_em >= '<data da execução>';

DROP FUNCTION IF EXISTS hub_motorista_vincular_por_envio_massa(int, boolean);

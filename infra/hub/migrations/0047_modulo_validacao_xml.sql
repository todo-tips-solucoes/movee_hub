-- 0047 — Módulo "Validação XML" como item próprio do menu (feedback do
-- operador na validação interativa do hub-uiux-refresh, 2026-08-05): a
-- validação de XML NFSe deixa de ser uma seção embutida na tela de Envio em
-- Massa e vira módulo/rota próprios (`/hub/dashboard/validacao_xml` — a rota
-- resolve pela convenção pura de `moduloParaRota`, sem tocar o frontend do
-- shell).
--
-- Idempotente (ON CONFLICT DO NOTHING em tudo), mesmo padrão de 0007/0032/
-- 0038. O endpoint backend `/validate-xml-batch` continua gateado por
-- `envio_massa.enviar` (separação aqui é de NAVEGAÇÃO/UI, não de RBAC — quem
-- valida XML é o mesmo público que envia); a permissão nova abaixo existe
-- para manter o catálogo modulo↔permissão consistente e permitir um gate
-- próprio no futuro sem nova migration de catálogo.

-- 1. Módulo (ordem 65: entre envio_massa=60 e usuarios=70)
INSERT INTO "Modulo" (codigo, nome, ordem) VALUES
    ('validacao_xml', 'Validação XML', 65)
ON CONFLICT (codigo) DO NOTHING;

-- 2. Permissão de catálogo do módulo
INSERT INTO "Permissao" (codigo, modulo_id)
SELECT 'validacao_xml.validar', id FROM "Modulo" WHERE codigo = 'validacao_xml'
ON CONFLICT (codigo) DO NOTHING;

-- 3. Concessão: todo papel que já tem `envio_massa.enviar` ganha
--    `validacao_xml.validar` (mesmo público — gotcha do snapshot de
--    PapelPermissao documentado em 0026/0029/0032: permissão nova precisa de
--    INSERT explícito para retroagir).
INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT pp.papel_id, perm_nova.id
FROM "PapelPermissao" pp
JOIN "Permissao" perm_envio ON perm_envio.id = pp.permissao_id
  AND perm_envio.codigo = 'envio_massa.enviar'
CROSS JOIN (
    SELECT id FROM "Permissao" WHERE codigo = 'validacao_xml.validar'
) perm_nova
ON CONFLICT DO NOTHING;

-- 4. Habilitação por entidade: toda empresa com `envio_massa` ativo passa a
--    ver também `validacao_xml` (deny-by-default de ModuloEntidade — sem
--    isso o item não aparece no nav de ninguém, mesmo com RBAC concedido;
--    mesmo padrão de 0038).
INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo)
SELECT m_novo.id, me.empresa_id, true
FROM "ModuloEntidade" me
JOIN "Modulo" m_envio ON m_envio.id = me.modulo_id AND m_envio.codigo = 'envio_massa'
CROSS JOIN (
    SELECT id FROM "Modulo" WHERE codigo = 'validacao_xml'
) m_novo
WHERE me.ativo = true
ON CONFLICT (modulo_id, empresa_id) DO NOTHING;

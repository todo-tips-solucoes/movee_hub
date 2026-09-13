-- 0062 — Módulo "Avisos" (Web Push para o app motorista): seed de RBAC do
-- catálogo modulo↔permissão↔papel↔entidade, no mesmo molde exato de
-- 0047_modulo_validacao_xml.sql:16-51 (data-model.md §Seed de RBAC).
--
-- Idempotente (ON CONFLICT DO NOTHING em tudo). A escrita/leitura de negócio
-- em si (tabelas Aviso/AvisoEntrega/PushInscricao/...) já está coberta pelas
-- 11 funções SECURITY DEFINER de 0061_push_avisos.sql — este arquivo só
-- habilita o módulo no nav/RBAC do hub (routes/hub-avisos.js, FASE 4, ainda
-- não existe; middleware/hub-require-modulo.js já consulta este catálogo).
--
-- Concedida apenas aos papéis "admin" (mesmo critério de
-- 0059_seed_permissao_motoristas_dados_sensiveis.sql): disparar aviso para a
-- base de motoristas é ação restrita, não operacional.

-- 1. Módulo (ordem = maior ordem existente + 1; hoje 'admin'=90 é a maior).
INSERT INTO "Modulo" (codigo, nome, ordem) VALUES
    ('avisos', 'Avisos', 91)
ON CONFLICT (codigo) DO NOTHING;

-- 2. Permissões de catálogo do módulo.
INSERT INTO "Permissao" (codigo, modulo_id)
SELECT perm.codigo, m.id
FROM "Modulo" m, (VALUES ('avisos.consultar'), ('avisos.enviar')) AS perm(codigo)
WHERE m.codigo = 'avisos'
ON CONFLICT (codigo) DO NOTHING;

-- 3. Concessão: papéis "admin_plataforma" e "admin_entidade" × as 2
--    permissões novas (padrão exato de 0059).
INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p
CROSS JOIN "Permissao" perm
WHERE p.nome IN ('admin_plataforma', 'admin_entidade')
  AND perm.codigo IN ('avisos.consultar', 'avisos.enviar')
ON CONFLICT DO NOTHING;

-- 4. Habilitação por entidade: só a empresa 6 (grupo Movee — CLAUDE.md
--    §Regras de domínio; o app motorista/push é exclusivo desse grupo).
INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo)
SELECT m.id, 6, true
FROM "Modulo" m
WHERE m.codigo = 'avisos'
ON CONFLICT (modulo_id, empresa_id) DO NOTHING;

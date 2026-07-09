-- 0038 — seeds de habilitação de módulos para QA (S9 — hub-auditoria-admin;
-- plan.md "Plano por fases" passo 1; data-model.md "Objetos NOVOS de banco"
-- Decision 12; contexto operacional vinculante item 6 — QA
-- qa.importacoes@moveelog.local, entidade 9001; tasks.md 1.4).
--
-- Idempotente: INSERT ... ON CONFLICT (modulo_id, empresa_id) DO NOTHING
-- (UNIQUE já existe desde 0003_papel_permissao_modulo.sql).

-- 'usuarios' e 'auditoria' habilitados para TODA entidade com vínculo
-- UsuarioEntidade ativo (necessário para as novas telas aparecerem no nav
-- das entidades já existentes — sem isso, deny-by-default de ModuloEntidade
-- esconderia o nav mesmo com a permissão RBAC concedida).
INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo)
SELECT m.id, ue.empresa_id, true
FROM "Modulo" m
CROSS JOIN (
    SELECT DISTINCT empresa_id
    FROM "UsuarioEntidade"
    WHERE ativo = true
) ue
WHERE m.codigo IN ('usuarios', 'auditoria')
ON CONFLICT (modulo_id, empresa_id) DO NOTHING;

-- 'admin' habilitado só para a entidade QA 9001 (nenhum vínculo
-- admin_plataforma de teste existe ainda no seed de RBAC das fases
-- anteriores — fallback documentado em tasks.md 1.4.3: usar a entidade QA
-- 9001 já estabelecida desde a S4).
INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo)
SELECT m.id, 9001, true
FROM "Modulo" m
WHERE m.codigo = 'admin'
ON CONFLICT (modulo_id, empresa_id) DO NOTHING;

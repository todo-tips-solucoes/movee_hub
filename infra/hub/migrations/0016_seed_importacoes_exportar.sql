-- 0016 — Seed corretivo: permissão `importacoes.exportar` (data-model.md
-- Migration 0016; research.md Decision 2 — gap de permissão real vs plano
-- lógico). Idempotente (ON CONFLICT DO NOTHING). Módulo `importacoes` já
-- existe (seed 0007); só falta a permissão de exportar o arquivo ORIGINAL
-- (GET /importacoes/:id/original), ação sensível/LGPD — por isso concedida
-- SOMENTE a admin_plataforma/admin_entidade, explicitamente NÃO a
-- operador/leitura (mesmo racional de faturamento.exportar/
-- performance.exportar em 0007).

INSERT INTO "Permissao" (codigo, modulo_id)
SELECT 'importacoes.exportar', id FROM "Modulo" WHERE codigo = 'importacoes'
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p
CROSS JOIN "Permissao" perm
WHERE p.nome IN ('admin_plataforma', 'admin_entidade')
  AND perm.codigo = 'importacoes.exportar'
ON CONFLICT DO NOTHING;

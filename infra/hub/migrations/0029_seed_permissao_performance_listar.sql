-- 0029 — Seed corretivo: permissão `performance.listar` (data-model.md
-- Migration 0029; research.md Decision 1; tasks.md hub-performance 1.1).
-- Idempotente (ON CONFLICT DO NOTHING). Módulo `performance` já existe
-- (seed 0007), que só concedeu `performance.consultar`/`performance.exportar`
-- — faltava a permissão de LISTAGEM (FR-008 exige as 3 permissões
-- independentes entre si: listar, consultar/resumo, exportar). Mesmo padrão
-- *exato* de `0026` (faturamento.listar), que resolveu a mesma lacuna para
-- o módulo irmão.
--
-- Concessão: TODOS os 4 papéis-seed recebem `performance.listar` —
-- `admin_plataforma`/`admin_entidade` (que já têm os demais códigos de
-- `performance` via CROSS JOIN original do 0007, mas PapelPermissao foi
-- populada por snapshot, não é view — precisa de INSERT explícito para uma
-- permissão nova) e `operador`/`leitura` (que já têm `performance.consultar`
-- hoje; sem `listar` ficariam capazes de ver o resumo mas não a lista, uma
-- regressão de capacidade). `performance.exportar` continua FORA de
-- `operador`/`leitura` (mesmo padrão já vigente — só os papéis admin
-- exportam).

INSERT INTO "Permissao" (codigo, modulo_id)
SELECT 'performance.listar', id FROM "Modulo" WHERE codigo = 'performance'
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p
CROSS JOIN "Permissao" perm
WHERE p.nome IN ('admin_plataforma', 'admin_entidade', 'operador', 'leitura')
  AND perm.codigo = 'performance.listar'
ON CONFLICT DO NOTHING;

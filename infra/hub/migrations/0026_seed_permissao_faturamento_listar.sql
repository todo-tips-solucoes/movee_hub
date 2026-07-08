-- 0026 — Seed corretivo: permissão `faturamento.listar` (data-model.md
-- Migration 0026; research.md Decision 1; tasks.md hub-faturamento 1.1).
-- Idempotente (ON CONFLICT DO NOTHING). Módulo `faturamento` já existe
-- (seed 0007), que só concedeu `faturamento.consultar`/`faturamento.exportar`
-- — faltava a permissão de LISTAGEM (FR-008 exige as 3 permissões
-- independentes entre si: listar, consultar/resumo, exportar). O mesmo
-- split já existe em `motoristas` (`motoristas.consultar` + `.listar`
-- convivem desde o `0007`).
--
-- Concessão: TODOS os 4 papéis-seed recebem `faturamento.listar` —
-- `admin_plataforma`/`admin_entidade` (que já têm os demais códigos de
-- `faturamento` via CROSS JOIN original do 0007, mas PapelPermissao foi
-- populada por snapshot, não é view — precisa de INSERT explícito para uma
-- permissão nova) e `operador`/`leitura` (que já têm `faturamento.consultar`
-- hoje; sem `listar` ficariam capazes de ver o resumo mas não a lista, uma
-- regressão de capacidade). `faturamento.exportar` continua FORA de
-- `operador`/`leitura` (mesmo padrão já vigente — só os papéis admin
-- exportam).

INSERT INTO "Permissao" (codigo, modulo_id)
SELECT 'faturamento.listar', id FROM "Modulo" WHERE codigo = 'faturamento'
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p
CROSS JOIN "Permissao" perm
WHERE p.nome IN ('admin_plataforma', 'admin_entidade', 'operador', 'leitura')
  AND perm.codigo = 'faturamento.listar'
ON CONFLICT DO NOTHING;

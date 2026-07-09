-- 0032 — Seed: permissão `envio_massa.gerenciar` (data-model.md "Entity:
-- Permissao"; research.md Decision 4/12; spec.md FR-005/FR-008; tasks.md
-- hub-envio-massa 1.1). Idempotente (ON CONFLICT DO NOTHING). Módulo
-- `envio_massa` já existe (seed 0007), que só concedeu
-- `envio_massa.consultar`/`criar`/`enviar`/`aprovar` — faltava o 5º nível
-- administrativo (`gerenciar`) previsto no catálogo de permissões, ainda
-- que nenhum endpoint desta feature seja gateado por ele (research.md
-- Decision 4: "novo caso de uso que o fluxo atual não tem hoje", fora de
-- escopo do S8 — o catálogo só precisa refletir FR-005 corretamente).
--
-- Concessão: SOMENTE `admin_plataforma`/`admin_entidade` recebem
-- `envio_massa.gerenciar` — mesmo padrão de `admin.gerenciar`/
-- `usuarios.gerenciar` em 0007 (ações "gerenciar" nunca vão para
-- `operador`/`leitura`). PapelPermissao foi populada por snapshot no 0007
-- (INSERT, não view) — mesmo `admin_plataforma`/`admin_entidade` tendo
-- CROSS JOIN "todas as permissões" na criação, uma permissão NOVA precisa
-- de INSERT explícito para retroagir (mesmo gotcha documentado em 0026/0029
-- para faturamento.listar/performance.listar).

INSERT INTO "Permissao" (codigo, modulo_id)
SELECT 'envio_massa.gerenciar', id FROM "Modulo" WHERE codigo = 'envio_massa'
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p
CROSS JOIN "Permissao" perm
WHERE p.nome IN ('admin_plataforma', 'admin_entidade')
  AND perm.codigo = 'envio_massa.gerenciar'
ON CONFLICT DO NOTHING;

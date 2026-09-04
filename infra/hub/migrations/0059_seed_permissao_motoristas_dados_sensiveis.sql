-- 0059 — Seed aditivo: permissão `motoristas.dados_sensiveis` (hub-motorista-360,
-- tasks.md 2.3; research.md Decision 10; data-model.md §Permissao; spec.md
-- FR-013). Idempotente (ON CONFLICT DO NOTHING). Mesmo padrão exato de
-- 0044_seed_permissao_motoristas_credencial.sql.
--
-- Cobre a leitura dos dados pessoais sensíveis do EntreGô enriquecidos em
-- "Entregador".dados_entrego_json (migration 0057) — distinta de
-- `motoristas.consultar`/`motoristas.listar` (já existentes), que cobrem
-- apenas os dados operacionais já expostos hoje. Concedida apenas aos
-- papéis "admin" (`admin_plataforma`, `admin_entidade`) — dado pessoal
-- sensível é ação restrita, não operacional (`operador`/`leitura` não
-- recebem).

INSERT INTO "Permissao" (codigo, modulo_id)
SELECT 'motoristas.dados_sensiveis', id FROM "Modulo" WHERE codigo = 'motoristas'
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p
CROSS JOIN "Permissao" perm
WHERE p.nome IN ('admin_plataforma', 'admin_entidade')
  AND perm.codigo = 'motoristas.dados_sensiveis'
ON CONFLICT DO NOTHING;

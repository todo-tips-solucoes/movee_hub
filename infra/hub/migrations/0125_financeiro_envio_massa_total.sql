-- 0125 — `financeiro` e `financeiro_aprovador` passam a ter acesso TOTAL ao
-- módulo Envio em Massa: todas as permissões `envio_massa.*`.
--
-- POR QUE: decisão do operador (2026-11-02), revendo o escopo "só leitura" da
-- 0101. Com o painel legado saindo em 08/11, o financeiro opera o envio em
-- massa pelo hub. Ganha o que faltava:
--   - `envio_massa.criar`     → Importar XLSX (`POST /upload`) e editar linha,
--                               inclusive trocar CNPJ (`PATCH /update-envio-massa`);
--   - `envio_massa.enviar`    → Disparar / Parar;
--   - `envio_massa.gerenciar` → hoje não gateia endpoint nenhum (0032).
-- `consultar` (0101) e `aprovar` (0120) já existiam; o ON CONFLICT os ignora.
--
-- ⚠️ `financeiro_aprovador` é tratado EXPLICITAMENTE: nasceu (0097) como cópia
-- PONTUAL de `financeiro`, sem vínculo vivo (CLAUDE.md §"Migrations do hub").
--
-- Por padrão (`LIKE 'envio_massa.%'`), e não por lista: "acesso total" inclui
-- permissão que existir no módulo na data da execução. Permissão criada DEPOIS
-- desta migration não retroage (PapelPermissao é snapshot) — precisa de INSERT
-- próprio, como a 0032 fez.
--
-- Ids resolvidos por nome/código. Idempotente (ON CONFLICT DO NOTHING),
-- aditiva, sem DELETE. O registro em "SchemaMigration" é feito pelo migrate.sh.

INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p
CROSS JOIN "Permissao" perm
WHERE p.nome IN ('financeiro', 'financeiro_aprovador')
  AND perm.codigo LIKE 'envio_massa.%'
ON CONFLICT DO NOTHING;

-- registrar-migrations-aplicadas.sql
--
-- Reconcilia a tabela "SchemaMigration" do `chatmasterveloz` com o que de
-- fato está aplicado no banco. NÃO altera schema: só registra migrations que
-- foram aplicadas fora do `migrate.sh` e por isso nunca entraram na tabela.
--
-- POR QUE existe:
--   `migrate.sh` aplica E registra. Quando uma migration é aplicada
--   manualmente (`psql -f`), o efeito entra no banco mas o registro não —
--   e a tabela, que existe para responder "até onde este banco foi
--   migrado", passa a mentir.
--
--   Duas ocorrências, ambas verificadas no banco em 2026-09-05:
--
--   - `0054_importa_valores_como_recebidos.sql` (aplicada ~2026-08-30):
--     as constraints CHECK que ela remove (`%corridas%`, `%escala%`) NÃO
--     existem mais em "PerformanceTurno" — efeito presente, registro ausente.
--     Buraco visível na tabela: 0053 tem id=54, 0055 tem id=55, sem 0054.
--
--   - `0057`/`0058`/`0059` (aplicadas 2026-09-04, deploy de hub-motorista-360):
--     aplicadas passo a passo com `psql -f` durante o rito de produção.
--     Verificadas na ocasião: 3 colunas novas em "Entregador", RPC
--     `hub_motoristas_candidatos_por_conta` presente, permissão
--     `motoristas.dados_sensiveis` concedida só a admin_entidade/admin_plataforma.
--
--   Consequência de não registrar: um `migrate.sh` futuro tentaria reaplicar
--   as quatro. Como todas são idempotentes (ADD COLUMN IF NOT EXISTS,
--   CREATE OR REPLACE, DROP CONSTRAINT IF EXISTS, seed com guarda), não
--   quebraria — mas quem lê a tabela para saber o estado do schema é
--   enganado, e é exatamente para isso que ela serve.
--
-- SEGURANÇA DESTE SCRIPT:
--   - `id` NÃO é informado: a coluna tem default `nextval('"SchemaMigration_id_seq"')`
--     e a sequence atribui 57..60 sozinha. Informar `id` explicitamente
--     exigiria `setval` depois, para a sequence não colidir no próximo
--     registro — evitado por construção.
--   - `ON CONFLICT (nome) DO NOTHING` (há UNIQUE em `nome`): reexecutar é
--     no-op. Se alguma dessas linhas já existir, nada acontece.
--   - Roda em transação: ou entram as quatro, ou nenhuma.
--
-- COMO APLICAR (rito de produção, mesmos 5 gates):
--   docker cp docs/plans/hub-motorista-360/registrar-migrations-aplicadas.sql \
--     <container-pgadmin_db>:/tmp/registrar-migrations.sql
--   docker exec <container-pgadmin_db> sh -c \
--     'psql -U "$POSTGRES_USER" -d chatmasterveloz -v ON_ERROR_STOP=1 -f /tmp/registrar-migrations.sql'
--
--   (heredoc colado no terminal colapsa — sempre por arquivo, nunca colando
--    o conteúdo; lição da entrega da migration 0051)

\echo '=== ANTES: ultimas 5 migrations registradas ==='
SELECT id, nome, aplicado_em
FROM "SchemaMigration"
ORDER BY id DESC
LIMIT 5;

BEGIN;

INSERT INTO "SchemaMigration" (nome, aplicado_em) VALUES
  -- Aplicada ~2026-08-30 sem registro. `aplicado_em` é APROXIMADO (data da
  -- entrega em que ela entrou), não medido — o registro é retroativo.
  ('0054_importa_valores_como_recebidos.sql',            '2026-08-30 00:00:00-03'),

  -- Aplicadas em 2026-09-04 no deploy de hub-motorista-360. Horários REAIS
  -- da sessão, conferidos no log do rito.
  ('0057_entregador_entrego_enriquecimento.sql',         '2026-09-04 20:47:00-03'),
  ('0058_rpc_motoristas_candidatos_por_conta.sql',       '2026-09-04 20:50:00-03'),
  ('0059_seed_permissao_motoristas_dados_sensiveis.sql', '2026-09-04 20:53:00-03')
ON CONFLICT (nome) DO NOTHING;

COMMIT;

\echo ''
\echo '=== DEPOIS: as 4 devem aparecer registradas ==='
SELECT id, nome, aplicado_em
FROM "SchemaMigration"
WHERE nome IN (
  '0054_importa_valores_como_recebidos.sql',
  '0057_entregador_entrego_enriquecimento.sql',
  '0058_rpc_motoristas_candidatos_por_conta.sql',
  '0059_seed_permissao_motoristas_dados_sensiveis.sql'
)
ORDER BY id;

\echo ''
\echo '=== SANIDADE: a sequence acompanhou? (proximo id > max atual) ==='
SELECT max(id) AS max_id,
       last_value AS sequence_em,
       (last_value >= max(id)) AS sequence_ok
FROM "SchemaMigration", "SchemaMigration_id_seq"
GROUP BY last_value;

\echo ''
\echo '=== SANIDADE: ha outra migration do repo ainda sem registro? ==='
\echo '(comparar a lista abaixo com: ls infra/hub/migrations/*.sql)'
SELECT count(*) AS total_registradas FROM "SchemaMigration";

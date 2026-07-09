-- 0034 — Seeds SINTÉTICOS do schema legado (0033), exclusivamente no banco
-- isolado do hub (hub_homolog / hub_test_*), recursos hub-* (exceção G1).
-- Objetivo: dar suporte à tarefa 2.2.9 (medição do toggle HUB_RBAC_ENVIO
-- numa rota viva) e à FASE 6 (E2E completo dos 3 papéis) de
-- docs/specs/hub-envio-massa/tasks.md, sem depender de dados reais de
-- produção (que nunca são copiados para o hub — CLAUDE.md).
--
-- Coerência com o tenant hub já seedado (0016/carga-seeds-teste.sh):
--   UsuarioEntidade.empresa_id = 9001 é o tenant hub de QA (usuários
--   qa.importacoes@moveelog.local [admin_entidade] e
--   qa.motoristas.leitura@moveelog.local [leitura] já existem para 9001).
-- O adaptador `hubEnvioMassaClaimsBridge` (middleware/hub-envio-massa-
-- claims.js) resolve `Empresa?id=eq.<entidade_ativa>` na tabela LEGADA —
-- ou seja, a claim `entidade_ativa` do JWT do hub (9001) só resolve grupo/
-- matriz corretamente se existir uma linha "Empresa" legada com id=9001.
-- Por isso o id da Empresa "matriz" abaixo é explicitamente 9001 (mesmo
-- valor do tenant hub), não um serial qualquer.
--
-- Idempotente: todo INSERT usa ON CONFLICT DO NOTHING chaveado por PK/UNIQUE
-- explícita; pode ser reaplicado sem duplicar nem sobrescrever.
--
-- Sem BEGIN/COMMIT explícito (mesmo motivo do 0033 — migrate.sh já wrappa
-- via `psql -1`).

-- pgcrypto só para GERAR os hashes de senha de teste nesta migration
-- (função crypt/gen_salt); não é usado por nenhum código de aplicação.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Empresa "matriz" (id=9001, mesmo id do tenant hub de QA) — sem grupo
--    ainda (id_grupo setado depois que o Grupo existir, evita ciclo de FK
--    entre a criação de Grupo e Empresa).
-- ---------------------------------------------------------------------------
INSERT INTO "Empresa" (id, nome_empresa, email, pass, cnpj, endereco, numero, cep, email_nota, observacao)
VALUES (
  9001,
  'QA Hub Envio Massa - Matriz',
  'qa.envio-massa.matriz@hub-test.local',
  crypt('EnvioMassaQA@2026', gen_salt('bf')),
  '11222333000181',
  'Rua de Teste QA',
  '100',
  '01000-000',
  'financeiro.qa@hub-test.local',
  'Empresa sintética — hub-test/hub-homolog, NUNCA dado real de produção.'
)
ON CONFLICT (id) DO NOTHING;

-- Empresa "filial" (id=9010), associada ao mesmo grupo da matriz depois do
-- passo 2 — cobre o caminho mesmoGrupoQue()/resolveEmpresaAlvo() com grupo.
INSERT INTO "Empresa" (id, nome_empresa, email, pass, cnpj)
VALUES (
  9010,
  'QA Hub Envio Massa - Filial 1',
  'qa.envio-massa.filial1@hub-test.local',
  crypt('EnvioMassaQAFilial@2026', gen_salt('bf')),
  '11222333000262'
)
ON CONFLICT (id) DO NOTHING;

-- Sequence não é avançada automaticamente por INSERT com id explícito;
-- ajusta para qualquer INSERT futuro sem id explícito não colidir.
SELECT setval('"Empresa_id_seq"', GREATEST((SELECT COALESCE(MAX(id), 1) FROM "Empresa"), 1));

-- ---------------------------------------------------------------------------
-- 2. Grupo (pai = matriz 9001); depois vincula a filial via id_grupo.
-- ---------------------------------------------------------------------------
INSERT INTO "Grupo" (id, nome, id_empresa_pai, login_unico_ativo)
VALUES (9001, 'Grupo QA Hub Envio Massa', 9001, false)
ON CONFLICT (id) DO NOTHING;

SELECT setval('"Grupo_id_seq"', GREATEST((SELECT COALESCE(MAX(id), 1) FROM "Grupo"), 1));

UPDATE "Empresa" SET id_grupo = 9001 WHERE id IN (9001, 9010) AND id_grupo IS NULL;

-- ---------------------------------------------------------------------------
-- 3. EnvioMassa — movimentos sintéticos em estados variados, para dar
--    suporte à FASE 6 (E2E: consultar/criar/editar/aprovar/fechar/exportar/
--    validar XML). Todos sob id_empresa=9001 (matriz).
-- ---------------------------------------------------------------------------

-- 3a. Movimento aberto, ainda não validado (só tem cnpj_prestador/nome/valor —
--     nota_ok/numnota/data_emissao vêm da validação, mesmo padrão de produção).
INSERT INTO "EnvioMassa" (
  number, nome, cnpj_prestador, cnpj_tomador, valor, enviado, mov_fechado, id_empresa
)
SELECT '5511999990001', 'Motorista QA Aberto', '12345678000199', '11.222.333/0001-81', 150.00, 'off', false, 9001
WHERE NOT EXISTS (
  SELECT 1 FROM "EnvioMassa"
  WHERE cnpj_prestador = '12345678000199' AND id_empresa = 9001 AND mov_fechado = false
);

-- 3b. Movimento aberto, já validado (nota_ok preenchido, erro_validacao vazio
--     — "válida", mesma regra documentada em CLAUDE.md/memória do projeto).
INSERT INTO "EnvioMassa" (
  number, nome, cnpj_prestador, cnpj_tomador, valor, gorjeta, enviado,
  numnota, nota_ok, data_emissao, erro_validacao, mov_fechado, id_empresa
)
SELECT '5511999990002', 'Motorista QA Validado', '98765432000188', '11.222.333/0001-81', 320.50, 15.00, 'on',
       '12345', 'CHAVE-ACESSO-SINTETICA-0001', '2026-07-01T10:00:00-03:00', '', false, 9001
WHERE NOT EXISTS (
  SELECT 1 FROM "EnvioMassa"
  WHERE cnpj_prestador = '98765432000188' AND id_empresa = 9001 AND numnota = '12345'
);

-- 3c. Movimento já fechado (mov_fechado=true) — cobre /export-envio-massa e
--     paridade de export/estado terminal.
INSERT INTO "EnvioMassa" (
  number, nome, cnpj_prestador, cnpj_tomador, valor, enviado,
  numnota, nota_ok, data_emissao, erro_validacao, mov_fechado, id_empresa
)
SELECT '5511999990003', 'Motorista QA Fechado', '11122233000144', '11.222.333/0001-81', 99.90, 'on',
       '54321', 'CHAVE-ACESSO-SINTETICA-0002', '2026-06-15T09:00:00-03:00', '', true, 9001
WHERE NOT EXISTS (
  SELECT 1 FROM "EnvioMassa"
  WHERE cnpj_prestador = '11122233000144' AND id_empresa = 9001 AND mov_fechado = true
);

-- ---------------------------------------------------------------------------
-- 4. ProcessControl — 1 registro dummy 'inactive' para o "usuário" 9001
--    (updateProcessControl usa user_id = req.user.empresaId, ver
--    server.js:1247-1281).
-- ---------------------------------------------------------------------------
INSERT INTO "ProcessControl" (user_id, status, execution_id)
SELECT 9001, 'inactive', NULL
WHERE NOT EXISTS (SELECT 1 FROM "ProcessControl" WHERE user_id = 9001);

-- ---------------------------------------------------------------------------
-- 5. Motorista — base de login do App Motorista (exclusiva grupo Movee em
--    produção; aqui é só um espelho sintético para o backend legado
--    encontrar CNPJs coerentes com os movimentos acima).
-- ---------------------------------------------------------------------------
INSERT INTO "Motorista" (cnpj_prestador, senha, nome, ativo)
VALUES ('12345678000199', crypt('MotoristaQA@2026', gen_salt('bf')), 'Motorista QA Aberto', true)
ON CONFLICT (cnpj_prestador) DO NOTHING;

-- Pré-cadastro (senha NULL, ainda não ativou o login) — cobre o fluxo de
-- upsertMotoristasFromLote quando o /upload popular a base a partir do lote.
INSERT INTO "Motorista" (cnpj_prestador, senha, nome, ativo)
VALUES ('98765432000188', NULL, 'Motorista QA Validado', true)
ON CONFLICT (cnpj_prestador) DO NOTHING;

NOTIFY pgrst, 'reload schema';

-- =============================================================================
-- Verificação (manual, após aplicar):
--   SELECT id, nome_empresa, cnpj, id_grupo FROM "Empresa" WHERE id IN (9001, 9010);
--   SELECT id, nome, id_empresa_pai FROM "Grupo" WHERE id = 9001;
--   SELECT id, cnpj_prestador, mov_fechado, nota_ok FROM "EnvioMassa" WHERE id_empresa = 9001;
--   SELECT user_id, status FROM "ProcessControl" WHERE user_id = 9001;
--   SELECT cnpj_prestador, senha IS NULL AS pre_cadastro FROM "Motorista";
-- Login legado de teste (painel fora do /hub/, POST /login):
--   matriz: qa.envio-massa.matriz@hub-test.local / EnvioMassaQA@2026
--   filial: qa.envio-massa.filial1@hub-test.local / EnvioMassaQAFilial@2026
-- =============================================================================

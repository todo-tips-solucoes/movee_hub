-- 003 — Concede ao papel `robo_entrego_servico` as permissões da fila de
-- enriquecimento de dados EntreGô (hub-motorista-360, tasks.md FASE 2, 2.4;
-- research.md Decision 11; data-model.md §Permissao).
--
-- ⚠️ ARTEFATO PARA O OPERADOR APLICAR MANUALMENTE — esta pipeline (SDD
-- feature-00c) NUNCA executa este script contra o banco vivo (rito de
-- produção do projeto, CLAUDE.md). Roda DEPOIS de
-- infra/hub/migrations/0059_seed_permissao_motoristas_dados_sensiveis.sql
-- ter sido aplicada (precisa do módulo `motoristas`, já existente) e DEPOIS
-- de 001-usuario-servico-robo-entrego.sql (precisa do papel
-- `robo_entrego_servico`, já existente).
--
-- Uso:
--   psql "$DATABASE_URL" -f infra/robo-entrego/sql/003-permissoes-enriquecimento-robo-entrego.sql
--
-- Permissões concedidas: `motoristas.enriquecimento.consultar` (ler o
-- estado da fila / dados já enriquecidos) e `motoristas.enriquecimento.atualizar`
-- (gravar o resultado do enriquecimento em Entregador.dados_entrego_json) —
-- NUNCA `motoristas.dados_sensiveis` (permissão de leitura HUMANA, 0059) nem
-- `motoristas.credencial`/`motoristas.editar` (fora do escopo deste robô,
-- que só lê/atualiza dados de enriquecimento). Least privilege, mesmo
-- espírito do 001 (papel dedicado, não `operador`).
--
-- Idempotente: `ON CONFLICT DO NOTHING` nos dois INSERTs — reexecutar é
-- um no-op se já aplicado.

\set ON_ERROR_STOP on

DO $$
DECLARE
  _modulo_id int;
  _papel_id  int;
BEGIN
  SELECT id INTO _modulo_id FROM "Modulo" WHERE codigo = 'motoristas';
  IF _modulo_id IS NULL THEN
    RAISE EXCEPTION '003: modulo "motoristas" nao existe — aplique as migrations do hub antes';
  END IF;

  SELECT id INTO _papel_id FROM "Papel" WHERE nome = 'robo_entrego_servico';
  IF _papel_id IS NULL THEN
    RAISE EXCEPTION '003: papel robo_entrego_servico nao existe — aplique o 001 antes';
  END IF;

  INSERT INTO "Permissao" (codigo, modulo_id)
  VALUES ('motoristas.enriquecimento.consultar', _modulo_id),
         ('motoristas.enriquecimento.atualizar', _modulo_id)
  ON CONFLICT (codigo) DO NOTHING;

  INSERT INTO "PapelPermissao" (papel_id, permissao_id)
  SELECT _papel_id, perm.id
  FROM "Permissao" perm
  WHERE perm.codigo IN ('motoristas.enriquecimento.consultar', 'motoristas.enriquecimento.atualizar')
  ON CONFLICT DO NOTHING;

  RAISE NOTICE '003: permissoes motoristas.enriquecimento.consultar/.atualizar concedidas ao papel robo_entrego_servico (id=%)', _papel_id;
END
$$;

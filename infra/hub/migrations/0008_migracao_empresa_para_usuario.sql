-- 0008 — Migração expand-only Empresa.pass → Usuario (data-model.md; tasks.md 2.1;
-- FR-001–FR-005; block-002/dec-033: papel admin_entidade aprovado sem ajustes).
--
-- "Empresa" mora FORA do banco do hub (data-model.md §UsuarioEntidade — FK lógica, não
-- física: em produção o login legado vive em `chatmasterveloz`, um banco Postgres
-- inteiramente separado do banco isolado do hub `hub_homolog`). Por isso esta migration
-- é DEFENSIVA: só executa se uma tabela "Empresa" existir no banco de DESTINO no momento
-- da corrida.
--   - hub_homolog hoje (S2): "Empresa" não existe aqui → bloco é NO-OP seguro (RAISE
--     NOTICE, sem erro). migrate.sh pode rodar 0008 normalmente em qualquer ambiente.
--   - hub-test (task 2.1.5, teste de integração desta feature): um seed de teste cria uma
--     "Empresa" local ANTES do migrate.sh rodar, para provar o fluxo E2E com dados
--     sintéticos (ver infra/hub/testes/migracao-login-integration.sh).
--   - Cutover real (S10+, fora do escopo desta fundação): uma etapa de ETL prévia (não
--     coberta aqui) populará "Empresa" no banco do hub a partir do banco de produção antes
--     desta migration aplicar o expand-only — decisão registrada como dec-036.
--
-- Idempotência (FR-004/SC-002): WHERE NOT EXISTS por email (Usuario) e por par
-- (usuario_id, empresa_id) (UsuarioEntidade) — reexecução manual do arquivo é no-op.
-- Exclusão (FR-005): contas de origem sem "pass" definido (sem meio de autenticar) NUNCA
-- geram Usuario. Login legado (tabela Empresa) não é alterado (FR-003) — esta migration
-- só LÊ Empresa, nunca escreve nela.
DO $$
DECLARE
  _papel_admin_entidade_id int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'Empresa'
  ) THEN
    RAISE NOTICE '0008: tabela "Empresa" ausente neste banco — no-op (nada a migrar)';
    RETURN;
  END IF;

  SELECT id INTO _papel_admin_entidade_id FROM "Papel" WHERE nome = 'admin_entidade';
  IF _papel_admin_entidade_id IS NULL THEN
    RAISE EXCEPTION '0008: papel "admin_entidade" nao encontrado — rode 0007 antes de 0008';
  END IF;

  -- FR-001/FR-005: 1 Usuario por Empresa com login+senha definidos (pass NOT NULL/vazio).
  -- Hash bcrypt COPIADO (nunca recalculado) — quem migra continua autenticando sem trocar
  -- senha (critério de aceite #3).
  INSERT INTO "Usuario" (email, senha_hash, nome, ativo, criado_em, criado_por)
  SELECT e.email,
         e.pass,
         COALESCE(NULLIF(e.nome_empresa, ''), e.email),
         true,
         now(),
         NULL -- criado_por NULL: bootstrap/migração, sem usuário-autor humano (briefing S2)
  FROM "Empresa" e
  WHERE e.pass IS NOT NULL AND e.pass <> ''
    AND e.email IS NOT NULL AND e.email <> ''
    AND NOT EXISTS (SELECT 1 FROM "Usuario" u WHERE u.email = e.email);

  -- FR-002: vincular à MESMA entidade de origem com papel admin_entidade (aprovado
  -- block-002/dec-033). Sem herança/negação (Decision 5) — union de grants é
  -- responsabilidade do cálculo de permissões efetivas, não desta migration.
  INSERT INTO "UsuarioEntidade" (usuario_id, empresa_id, papel_id, ativo)
  SELECT u.id, e.id, _papel_admin_entidade_id, true
  FROM "Empresa" e
  JOIN "Usuario" u ON u.email = e.email
  WHERE e.pass IS NOT NULL AND e.pass <> ''
    AND NOT EXISTS (
      SELECT 1 FROM "UsuarioEntidade" ue
      WHERE ue.usuario_id = u.id AND ue.empresa_id = e.id
    );
END
$$;

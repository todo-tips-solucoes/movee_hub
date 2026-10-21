-- Teste da 0116 (hub_envio_massa_corrigir_valor). Roda em transação com ROLLBACK
-- (ver hub-corrigir-valor.sh). Empresa 9001 = QA; 9010 = "outra empresa".
\set ON_ERROR_STOP on
CREATE TEMP TABLE _ids (k text PRIMARY KEY, id bigint);
DO $$
DECLARE
  k text; v_id bigint;
  -- k: nota_ok, erro_validacao, mov_fechado, empresa
  defs text[][] := ARRAY[
    ['aprovada',  'N1',  NULL, 'f', '9001'],
    ['reprovada', 'N2',  'CNPJ divergente', 'f', '9001'],
    ['sem_nota',  NULL,  NULL, 'f', '9001'],
    ['espacos',   '   ', '  ', 'f', '9001'],
    ['fechado',   NULL,  NULL, 't', '9001'],
    ['outra',     NULL,  NULL, 'f', '9010'],
    ['enviada',   NULL,  NULL, 'f', '9001']];
  i int;
BEGIN
  FOR i IN 1..array_length(defs, 1) LOOP
    INSERT INTO "EnvioMassa" (nome, cnpj_prestador, valor, gorjeta, mensagem1, nota_ok, erro_validacao, mov_fechado, id_empresa, enviado)
    VALUES ('T0116 '||defs[i][1], '11222333000181', 100, 5, 'O valor total para emissao da NF e de R$ 100,00',
            defs[i][2], defs[i][3], defs[i][4]::boolean, defs[i][5]::int,
            CASE WHEN defs[i][1]='enviada' THEN 'on' ELSE 'off' END)
    RETURNING id INTO v_id;
    INSERT INTO _ids VALUES (defs[i][1], v_id);
  END LOOP;
END $$;

CREATE FUNCTION pg_temp.corrige(p_k text, p_empresa int, p_valor numeric, p_usuario int DEFAULT NULL)
RETURNS text LANGUAGE sql AS $$
  SELECT desfecho FROM hub_envio_massa_corrigir_valor(p_empresa,
    jsonb_build_array(jsonb_build_object('id', (SELECT id FROM _ids WHERE k=p_k), 'valor', p_valor,
                      'gorjeta', 5, 'mensagem1', 'O valor total para emissao da NF e de R$ '||p_valor)),
    'motivo de teste 11.222.333/0001-81 fulano@x.com', 'tela', p_usuario)
$$;
CREATE FUNCTION pg_temp.v(p_k text) RETURNS float8 LANGUAGE sql AS $$
  SELECT valor FROM "EnvioMassa" WHERE id=(SELECT id FROM _ids WHERE k=p_k) $$;
CREATE FUNCTION pg_temp.naud(p_k text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM "Auditoria" WHERE acao='movimento_valor_corrigido' AND recurso_id=(SELECT id::text FROM _ids WHERE k=p_k) $$;

DO $$
BEGIN
  -- nota aprovada: pulado, valor preservado, sem auditoria
  ASSERT pg_temp.corrige('aprovada', 9001, 200) = 'pulado_nota_enviada', 'aprovada deveria ser pulada';
  ASSERT pg_temp.v('aprovada') = 100 AND pg_temp.naud('aprovada') = 0, 'aprovada foi alterada/auditada';
  -- nota reprovada: aceita
  ASSERT pg_temp.corrige('reprovada', 9001, 200) = 'atualizado', 'reprovada deveria ser aceita';
  ASSERT pg_temp.v('reprovada') = 200 AND pg_temp.naud('reprovada') = 1, 'reprovada: valor/auditoria';
  -- sem nota: aceita; nota_ok so espacos vale vazio
  ASSERT pg_temp.corrige('sem_nota', 9001, 200) = 'atualizado', 'sem_nota';
  ASSERT pg_temp.corrige('espacos', 9001, 200) = 'atualizado', 'nota_ok so espacos deveria valer vazio';
  -- fechado
  ASSERT pg_temp.corrige('fechado', 9001, 200) = 'pulado_mov_fechado', 'fechado';
  ASSERT pg_temp.v('fechado') = 100, 'fechado alterado';
  -- outra empresa: nao_encontrado, nada alterado
  ASSERT pg_temp.corrige('outra', 9001, 200) = 'nao_encontrado', 'outra empresa vazou';
  ASSERT pg_temp.v('outra') = 100 AND pg_temp.naud('outra') = 0, 'outra empresa alterada';
  -- idempotencia: 2a chamada igual => inalterado, 0 auditoria nova
  ASSERT pg_temp.corrige('sem_nota', 9001, 200) = 'inalterado', 'nao idempotente';
  ASSERT pg_temp.naud('sem_nota') = 1, 'segunda chamada auditou';
  -- autor: NULL no legado; pessoa no hub
  ASSERT (SELECT usuario_id FROM "Auditoria" WHERE recurso_id=(SELECT id::text FROM _ids WHERE k='sem_nota')) IS NULL, 'autor legado nao e NULL';
  ASSERT pg_temp.corrige('enviada', 9001, 300, (SELECT min(id) FROM "Usuario")) = 'atualizado', 'enviada';
  ASSERT (SELECT usuario_id FROM "Auditoria" WHERE recurso_id=(SELECT id::text FROM _ids WHERE k='enviada')) = (SELECT min(id) FROM "Usuario"), 'autor do hub perdido';
  -- msg_valor_antigo: so quando a mensagem ja tinha sido enviada
  ASSERT (SELECT msg_valor_antigo FROM hub_envio_massa_corrigir_valor(9001,
      jsonb_build_array(jsonb_build_object('id',(SELECT id FROM _ids WHERE k='enviada'),'valor',301)),'m','tela',NULL)) , 'msg_valor_antigo deveria ser true';
  -- motivo integral (nao mascarado)
  ASSERT (SELECT detalhes->>'motivo' FROM "Auditoria" WHERE recurso_id=(SELECT id::text FROM _ids WHERE k='sem_nota'))
         = 'motivo de teste 11.222.333/0001-81 fulano@x.com', 'motivo alterado';
  -- so valor/gorjeta/mensagem1 mudam
  ASSERT (SELECT numnota IS NULL AND nota_ok IS NULL AND mov_fechado = false AND dt_inicial IS NULL FROM "EnvioMassa" WHERE id=(SELECT id FROM _ids WHERE k='sem_nota')), 'campo alheio alterado';
  RAISE NOTICE 'ok  0116: 15 asserts (guardas, escopo, idempotencia, autoria, motivo)';
END $$;

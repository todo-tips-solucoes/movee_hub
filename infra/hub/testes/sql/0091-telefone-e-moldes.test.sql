-- Parte 2 de 2 do teste da 0091 (F4-A). Roda DEPOIS da migration, na mesma
-- transação, sobre os fixtures da parte 1.
\set ON_ERROR_STOP on

-- 1. O backfill pega o telefone MAIS RECENTE, ignora lixo e não inventa nada.
DO $$
DECLARE c record; v_bom text; v_lixo text; v_sem text;
BEGIN
  SELECT * INTO c FROM f4_ctx;
  SELECT telefone INTO v_bom  FROM "ContaMotorista" WHERE id = c.cm_bom;
  SELECT telefone INTO v_lixo FROM "ContaMotorista" WHERE id = c.cm_lixo;
  SELECT telefone INTO v_sem  FROM "ContaMotorista" WHERE id = c.cm_sem;

  ASSERT v_bom = '5511900000002',
    format('devia herdar o telefone MAIS RECENTE (…002), veio %s', coalesce(v_bom, 'NULL'));
  ASSERT v_lixo IS NULL,
    format('histórico só com lixo ("55" e telefone formatado) não pode virar telefone, veio %s', v_lixo);
  ASSERT v_sem IS NULL, 'sem histórico, o telefone continua nulo';
  RAISE NOTICE 'ok  backfill: mais recente=% · lixo ignorado · ausente segue nulo', v_bom;

  -- Não cria nem apaga conta.
  ASSERT (SELECT count(*) FROM "ContaMotorista") = (SELECT contas FROM f4_antes),
    'o backfill mexeu na quantidade de contas';
  RAISE NOTICE 'ok  backfill não criou nem apagou conta';
END $$;

-- 2. O CHECK recusa telefone implausível — o hub é dono, então a regra vive nele.
DO $$
DECLARE c record; v_erro text;
BEGIN
  SELECT * INTO c FROM f4_ctx;
  BEGIN
    UPDATE "ContaMotorista" SET telefone = '55' WHERE id = c.cm_sem;
    RAISE EXCEPTION 'FALHOU: o CHECK aceitou "55" como telefone';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ok  CHECK recusa telefone implausível';
  END;
  -- e aceita um válido
  UPDATE "ContaMotorista" SET telefone = '5511912345678' WHERE id = c.cm_sem;
  RAISE NOTICE 'ok  CHECK aceita DDI+DDD+numero';
END $$;

-- 3. Reaplicar o backfill não sobrescreve correção feita pelo hub (idempotência
--    que importa: o hub é o dono, a EnvioMassa não pode "vencer" depois).
DO $$
DECLARE c record; v_depois text;
BEGIN
  SELECT * INTO c FROM f4_ctx;
  UPDATE "ContaMotorista" SET telefone = '5511988887777' WHERE id = c.cm_bom;
  UPDATE "ContaMotorista" cm SET telefone = ult.number
    FROM (SELECT DISTINCT ON (em.cnpj_prestador) em.cnpj_prestador, em.number
            FROM "EnvioMassa" em
           WHERE em.number ~ '^[0-9]{12,13}$' AND em.cnpj_prestador IS NOT NULL
           ORDER BY em.cnpj_prestador, em.created_at DESC) ult
   WHERE cm.telefone IS NULL AND cm.cnpj_prestador = ult.cnpj_prestador;
  SELECT telefone INTO v_depois FROM "ContaMotorista" WHERE id = c.cm_bom;
  ASSERT v_depois = '5511988887777',
    format('reaplicar o backfill sobrescreveu a correção do hub (veio %s)', v_depois);
  RAISE NOTICE 'ok  idempotente: o backfill não vence o que o hub gravou';
END $$;

-- 4. Os moldes: `salvar` carrega entre versões e grava o valor novo.
DO $$
DECLARE v_ver int; v_sub int; v_emp int; v_nova "AdiantamentoConfiguracao";
BEGIN
  SELECT ue.usuario_id, ue.empresa_id INTO v_sub, v_emp
    FROM "UsuarioEntidade" ue
    JOIN "PapelPermissao" pp ON pp.papel_id = ue.papel_id
    JOIN "Permissao" p ON p.id = pp.permissao_id
    JOIN "ModuloEntidade" me ON me.modulo_id = p.modulo_id AND me.empresa_id = ue.empresa_id
   WHERE p.codigo = 'adiantamentos.configurar' AND ue.ativo AND me.ativo
   ORDER BY ue.usuario_id LIMIT 1;
  IF v_sub IS NULL THEN RAISE EXCEPTION 'FALHOU: nenhum usuario com adiantamentos.configurar'; END IF;
  PERFORM set_config('request.jwt.claims',
    format('{"sub":"%s","empresa_ativa":"%s","escopo":[6,%s]}', v_sub, v_emp, v_emp), true);

  SELECT max(versao) INTO v_ver FROM "AdiantamentoConfiguracao" WHERE id_empresa = 6;
  SELECT * INTO v_nova FROM hub_adiantamento_configuracao_salvar(v_ver,
    '{"motivo":"teste F4 moldes","mensagem1Modelo":"Ola {nome}, sua nota e {valor}","mensagem2Modelo":"Gorjeta {gorjeta}"}'::jsonb);
  ASSERT v_nova.mensagem1_modelo = 'Ola {nome}, sua nota e {valor}', 'molde 1 não gravou';
  ASSERT v_nova.mensagem2_modelo = 'Gorjeta {gorjeta}', 'molde 2 não gravou';

  -- salva outra coisa: os moldes têm de sobreviver
  SELECT * INTO v_nova FROM hub_adiantamento_configuracao_salvar(v_nova.versao, '{"motivo":"teste F4 carry"}'::jsonb);
  ASSERT v_nova.mensagem1_modelo = 'Ola {nome}, sua nota e {valor}', 'carry-through do molde 1 falhou';
  ASSERT v_nova.mensagem2_modelo = 'Gorjeta {gorjeta}', 'carry-through do molde 2 falhou';
  -- e o que a F3 trouxe continua vindo junto
  ASSERT v_nova.categorias_nota IS NOT DISTINCT FROM (SELECT categorias_nota FROM "AdiantamentoConfiguracao"
         WHERE id_empresa=6 AND versao = v_nova.versao - 1), 'a 0091 perdeu o carry-through da F3';
  RAISE NOTICE 'ok  moldes: gravam, sobrevivem entre versões, e a F3 segue carregando';
END $$;

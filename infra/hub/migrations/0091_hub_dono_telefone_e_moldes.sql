-- 0091 — F4 (parte A): o hub vira dono do telefone do motorista, e os moldes
-- das mensagens do movimento passam a ser configuráveis.
--
-- POR QUE O TELEFONE: para gerar o movimento na EnvioMassa (F4 parte B) é
-- preciso o `number` — o WhatsApp do motorista. Medido em 2026-09-23: essa
-- coluna é a ÚNICA fonte desse dado no banco inteiro; não existe telefone em
-- "Entregador", "ContaMotorista" nem "Motorista". Decisão do operador
-- (2026-09-23): herdar do último movimento e, daqui em diante, **o hub é o
-- dono** — a unificação dos dados do motorista começa por aqui.
--
-- ⚠️ O DADO DE ORIGEM É SUJO. Em 206.431 linhas com `number`: 9.030 têm
-- comprimento 2 (só "55") e 1.234 têm caracteres não numéricos. Herdar isso
-- seria pior que deixar nulo — um telefone inválido parece preenchido e só
-- falha na hora do disparo. Por isso o backfill só aceita 12 ou 13 dígitos
-- (DDI+DDD+número), e o CHECK mantém a regra viva para quem gravar depois.
-- Cobertura medida com o filtro: **592 de 801** contas (74%). Sem o filtro
-- seriam 801, das quais 209 com lixo.
--
-- ⚠️ O MESMO CNPJ TROCA DE TELEFONE: 1.337 CNPJs têm mais de um `number` no
-- histórico. Por isso o backfill pega o mais RECENTE (`created_at DESC`), e a
-- coluna é atualizável — não é um carimbo de uma vez só.
--
-- `hub_adiantamento_configuracao_salvar` vem da 0090 (a versão viva), com as
-- duas colunas novas no INSERT e o carry-through — mesma armadilha da F3: sem
-- isso, salvar qualquer outro campo apagaria o molde.
--
-- ROLLBACK: infra/hub/testes/sql/0091-rollback.sql (restaura o `salvar` da
-- 0090 e preserva as colunas — dropar apagaria telefone e molde já gravados).

-- 1. Telefone no hub. Aditivo e nulo.
ALTER TABLE "ContaMotorista" ADD COLUMN IF NOT EXISTS telefone text;

COMMENT ON COLUMN "ContaMotorista".telefone IS
  'F4: WhatsApp do motorista, DDI+DDD+numero só dígitos (12 ou 13). O hub é o dono; a EnvioMassa deixa de ser a fonte.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contamotorista_telefone_plausivel') THEN
    ALTER TABLE "ContaMotorista" ADD CONSTRAINT contamotorista_telefone_plausivel
      CHECK (telefone IS NULL OR telefone ~ '^[0-9]{12,13}$');
  END IF;
END $$;

-- 2. Backfill: o telefone MAIS RECENTE de cada CNPJ, só se plausível.
--    Idempotente — só preenche quem está nulo, então reaplicar não sobrescreve
--    o que alguém já corrigiu pelo hub.
UPDATE "ContaMotorista" cm
   SET telefone = ult.number
  FROM (
    SELECT DISTINCT ON (em.cnpj_prestador) em.cnpj_prestador, em.number
      FROM "EnvioMassa" em
     WHERE em.number ~ '^[0-9]{12,13}$' AND em.cnpj_prestador IS NOT NULL
     ORDER BY em.cnpj_prestador, em.created_at DESC
  ) ult
 WHERE cm.telefone IS NULL AND cm.cnpj_prestador = ult.cnpj_prestador;

-- 3. Moldes das mensagens do movimento (decisão do operador: configurável no
--    hub, não copiado do movimento anterior).
ALTER TABLE "AdiantamentoConfiguracao" ADD COLUMN IF NOT EXISTS mensagem1_modelo text;
ALTER TABLE "AdiantamentoConfiguracao" ADD COLUMN IF NOT EXISTS mensagem2_modelo text;

COMMENT ON COLUMN "AdiantamentoConfiguracao".mensagem1_modelo IS
  'F4: molde da mensagem 1 do movimento gerado. Placeholders permitidos (whitelist no backend): {nome}, {valor}, {gorjeta}, {total}, {periodo_inicio}, {periodo_fim}.';
COMMENT ON COLUMN "AdiantamentoConfiguracao".mensagem2_modelo IS
  'F4: molde da mensagem 2 do movimento gerado. Mesma whitelist da mensagem 1.';

-- 4. `salvar` carrega os campos novos entre versões (corpo da 0090).
CREATE OR REPLACE FUNCTION hub_adiantamento_configuracao_salvar(p_versao_esperada int, p_dados jsonb)
RETURNS "AdiantamentoConfiguracao"
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sub   int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_atual "AdiantamentoConfiguracao";
    v_nova  "AdiantamentoConfiguracao";
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.configurar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;
    IF NOT (6 = ANY (hub_jwt_escopo_ids())) THEN RAISE EXCEPTION 'FORA_DO_GRUPO_MOVEE'; END IF;

    -- 11.11 (converge onda-039, FR-023): compara contra a MAIOR versão
    -- gravada (independente de `vigente_desde`), não contra
    -- `hub_adiantamento_config_vigente` (que filtra `vigente_desde <= now()`
    -- e por isso não enxerga uma versão agendada para o futuro). `FOR
    -- UPDATE` fecha a corrida entre o SELECT e o INSERT — dois salvamentos
    -- concorrentes: o segundo cai no `unique_violation` abaixo e recebe
    -- VERSAO_DESATUALIZADA (contrato: lib/hub/adiantamentos-api.ts:40 já
    -- sabe traduzir), nunca DADOS_INVALIDOS genérico.
    SELECT * INTO v_atual FROM "AdiantamentoConfiguracao"
        WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1 FOR UPDATE;
    IF v_atual.versao IS DISTINCT FROM p_versao_esperada THEN
        RAISE EXCEPTION 'VERSAO_DESATUALIZADA';
    END IF;

    BEGIN
        INSERT INTO "AdiantamentoConfiguracao" (
            id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura,
            horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao,
            previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio,
            apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato, categorias_nota,
            mensagem1_modelo, mensagem2_modelo,
            desconto_adiantamentos, desconto_debitos, repasse_visivel_app, criado_por, motivo
        ) VALUES (
            6,
            COALESCE(v_atual.versao, 0) + 1,
            COALESCE((p_dados ->> 'vigenteDesde')::timestamptz, now()),
            COALESCE(p_dados ->> 'timezone', COALESCE(v_atual.timezone, 'America/Sao_Paulo')),
            COALESCE((SELECT array_agg(x::smallint) FROM jsonb_array_elements_text(p_dados -> 'diasHabilitados') x), v_atual.dias_habilitados),
            COALESCE((p_dados ->> 'horarioAbertura')::time, v_atual.horario_abertura),
            COALESCE((p_dados ->> 'horarioCorte')::time, v_atual.horario_corte),
            COALESCE((p_dados ->> 'percentual')::numeric, v_atual.percentual),
            COALESCE((p_dados ->> 'taxaFixa')::numeric, v_atual.taxa_fixa),
            COALESCE(p_dados ->> 'fonteProducao', v_atual.fonte_producao),
            COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(p_dados -> 'categoriasProducao') x), v_atual.categorias_producao),
            COALESCE(p_dados ->> 'previsaoPagamentoTexto', v_atual.previsao_pagamento_texto),
            COALESCE(p_dados ->> 'descricaoPixModelo', v_atual.descricao_pix_modelo),
            COALESCE((p_dados ->> 'apuracaoDiaInicio')::smallint, v_atual.apuracao_dia_inicio),
            COALESCE((p_dados ->> 'apuracaoDiasAteRepasse')::smallint, v_atual.apuracao_dias_ate_repasse),
            COALESCE(p_dados ->> 'apuracaoDataBase', v_atual.apuracao_data_base),
            COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(p_dados -> 'categoriasExtrato') x), v_atual.categorias_extrato),
            -- F3: NULL enquanto ninguém configurar. Sem isso, salvar uma versão
            -- nova perderia a marcação da versão anterior.
            COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(p_dados -> 'categoriasNota') x), v_atual.categorias_nota),
            -- F4: moldes das mensagens do movimento. Mesma razão da F3 — sem o
            -- carry-through, salvar qualquer outro campo apagaria o texto.
            COALESCE(p_dados ->> 'mensagem1Modelo', v_atual.mensagem1_modelo),
            COALESCE(p_dados ->> 'mensagem2Modelo', v_atual.mensagem2_modelo),
            COALESCE((p_dados ->> 'descontoAdiantamentos')::boolean, v_atual.desconto_adiantamentos, true),
            COALESCE((p_dados ->> 'descontoDebitos')::boolean, v_atual.desconto_debitos, false),
            COALESCE((p_dados ->> 'repasseVisivelApp')::boolean, v_atual.repasse_visivel_app, false),
            v_sub,
            p_dados ->> 'motivo'
        ) RETURNING * INTO v_nova;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'VERSAO_DESATUALIZADA';
    END;

    RETURN v_nova;
END;
$$;

-- 0098 — F3: saldo mínimo carregado no repasse semanal.
--
-- Até aqui, um resultado semanal positivo mas pequeno (ex.: R$ 3,00) era
-- pago do mesmo jeito que R$ 3.000,00 — gerando nota fiscal e PIX por
-- centavos. A partir desta migration, um total (semana + saldo carregado de
-- semanas anteriores) menor que o piso mínimo configurado fica RETIDO:
-- entra automaticamente no cálculo da semana seguinte, até ultrapassar o
-- piso, quando é pago de uma vez (FR-013..FR-020, spec.md).
--
-- COLUNAS NOVAS SÃO NULÁVEIS (research.md Decision 7): `NULL` = item
-- fechado ANTES desta regra existir. Um `NOT NULL DEFAULT 0` mentiria — um
-- `valor_pago = 0` num item antigo com `remanescente = 100` foi PAGO (pelo
-- CSV, fora desta função), não retido. `NULL` é a verdade: "a regra não
-- existia". Medido em 2026-09-23: 0 apurações fechadas em produção — o caso
-- legado só aparece em teste, mas o retrato antes/depois tem de continuar
-- idêntico (FR-022).
--
-- ORDEM ESTRITA DE FECHAMENTO (Decision 9): o cálculo do saldo depende da
-- apuração anterior. Fechar fora de ordem (pular uma semana, ou fechar uma
-- semana já superada) corromperia esse encadeamento — `APURACAO_FORA_DE_ORDEM`
-- recusa os dois casos. `pg_advisory_xact_lock` por empresa fecha a corrida
-- de dois fechamentos simultâneos lendo o "último fechado" errado; o lock
-- some sozinho no fim da transação.
--
-- `hub_adiantamento_repasse_fechar` vem da **0092** (a versão viva — mantém
-- assinatura, `CREATE OR REPLACE`). `hub_adiantamento_repasse` e
-- `hub_adiantamento_repasse_motorista` vêm da **0088**;
-- `hub_adiantamento_repasse_congelado` e `..._motorista_ultimo_fechado` vêm
-- da **0086**. As quatro mudam o TIPO DE RETORNO (colunas novas) e por isso
-- exigem `DROP FUNCTION` + `CREATE` + `GRANT` (Postgres não deixa
-- `CREATE OR REPLACE` mudar o shape de uma função `RETURNS TABLE`).
-- `hub_adiantamento_configuracao_salvar` (0091) devolve a linha inteira da
-- tabela — ganha a coluna nova de graça, sem precisar de DROP.
--
-- PISO VIGENTE NO MOMENTO DO FECHAMENTO, NÃO NO INÍCIO DA SEMANA (Decision
-- 12, FR-025a, block-006): `hub_adiantamento_repasse_fechar` lê
-- `repasse_valor_minimo` da config vigente na mesma transação do fechamento
-- e grava o valor usado em `ApuracaoRepasse.piso_aplicado` — só para
-- auditoria (não participa do cálculo de novo). Apurações pré-0098 ficam
-- com `piso_aplicado = NULL`.
--
-- ROLLBACK: infra/hub/testes/sql/0098-rollback.sql — recusa se existir
-- apuração pós-0098 com `valor_transportado > 0` (perderia saldo devido).

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Colunas novas (todas nuláveis — Decision 7).
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE "ApuracaoRepasseItem" ADD COLUMN IF NOT EXISTS saldo_anterior      numeric(12,2);
ALTER TABLE "ApuracaoRepasseItem" ADD COLUMN IF NOT EXISTS saldo_anterior_nota numeric(12,2);
ALTER TABLE "ApuracaoRepasseItem" ADD COLUMN IF NOT EXISTS saldo_anterior_fora numeric(12,2);
ALTER TABLE "ApuracaoRepasseItem" ADD COLUMN IF NOT EXISTS valor_pago          numeric(12,2);
ALTER TABLE "ApuracaoRepasseItem" ADD COLUMN IF NOT EXISTS valor_transportado  numeric(12,2);
ALTER TABLE "ApuracaoRepasseItem" ADD COLUMN IF NOT EXISTS transportado_nota   numeric(12,2);
ALTER TABLE "ApuracaoRepasseItem" ADD COLUMN IF NOT EXISTS transportado_fora   numeric(12,2);

COMMENT ON COLUMN "ApuracaoRepasseItem".saldo_anterior IS
  'F3 (FR-013/FR-016): valor_transportado do item do mesmo entregador na apuração anterior da empresa. NULL = item pré-regra (Decision 7).';
COMMENT ON COLUMN "ApuracaoRepasseItem".valor_pago IS
  'F3 (FR-014/FR-015): o que o financeiro paga nesta semana. NULL = item pré-regra.';
COMMENT ON COLUMN "ApuracaoRepasseItem".valor_transportado IS
  'F3 (FR-014/FR-017): o que fica retido e compõe a semana seguinte (FR-016). NULL = item pré-regra.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'apuracaorepasseitem_saldo_conserva') THEN
    -- FR-014..FR-019: vale só quando valor_pago IS NOT NULL (item pós-regra).
    -- Paga tudo ou retém tudo (nunca os dois); remanescente negativo (D9)
    -- preserva o saldo anterior sem reduzi-lo (FR-019); caso contrário a
    -- conservação é remanescente + saldo_anterior = valor_pago + valor_transportado.
    ALTER TABLE "ApuracaoRepasseItem" ADD CONSTRAINT apuracaorepasseitem_saldo_conserva
      CHECK (
        valor_pago IS NULL OR (
          valor_pago >= 0 AND valor_transportado >= 0
          AND (valor_pago = 0 OR valor_transportado = 0)
          AND (
            (remanescente < 0 AND valor_pago = 0 AND valor_transportado = saldo_anterior)
            OR (remanescente >= 0 AND remanescente + saldo_anterior = valor_pago + valor_transportado)
          )
        )
      );
  END IF;
END $$;

-- Piso por empresa (FR-025, Decision 12).
ALTER TABLE "AdiantamentoConfiguracao"
  ADD COLUMN IF NOT EXISTS repasse_valor_minimo numeric(14,2) NOT NULL DEFAULT 5.50;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'adiantamentoconfiguracao_repasse_valor_minimo_positivo') THEN
    ALTER TABLE "AdiantamentoConfiguracao" ADD CONSTRAINT adiantamentoconfiguracao_repasse_valor_minimo_positivo
      CHECK (repasse_valor_minimo > 0);
  END IF;
END $$;

COMMENT ON COLUMN "AdiantamentoConfiguracao".repasse_valor_minimo IS
  'F3 (FR-025): piso mínimo do repasse semanal, por empresa. Alterar exige adiantamentos.pagamento_confirmar (FR-026).';

-- Retrato do piso usado no fechamento (FR-025a, Decision 12, block-006).
ALTER TABLE "ApuracaoRepasse" ADD COLUMN IF NOT EXISTS piso_aplicado numeric(14,2);

COMMENT ON COLUMN "ApuracaoRepasse".piso_aplicado IS
  'F3 (FR-025a): repasse_valor_minimo vigente NO MOMENTO DO FECHAMENTO (não no início da semana). NULL = apuração pré-0098, sem reprocessamento (FR-022).';

-- ═══════════════════════════════════════════════════════════════════════
-- 2. hub_adiantamento_repasse_fechar (de 0092) — regra de saldo + ordem
--    estrita + piso vigente. Assinatura preservada: CREATE OR REPLACE.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION hub_adiantamento_repasse_fechar(p_periodo_inicio date)
RETURNS TABLE (apuracao_id bigint, motoristas int, total numeric, nao_pagos_no_periodo int)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sub      int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_config   "AdiantamentoConfiguracao";
    v_fim      date;
    v_escopo   int[] := hub_jwt_escopo_ids();
    v_pendencias jsonb;
    v_apuracao_id bigint;
    v_apuracao_anterior_id bigint;
    v_ultimo_periodo date;
    v_motoristas  int;
    v_total       numeric(14,2);
    v_nao_pagos   int;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.pagamento_confirmar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

    -- F3/Decision 9: trava por empresa — sem ela, dois fechamentos
    -- simultâneos de semanas consecutivas leriam o "último fechado" errado.
    -- O lock some sozinho no COMMIT/ROLLBACK da transação.
    PERFORM pg_advisory_xact_lock(6, hashtext('hub_adiantamento_repasse_fechar'));

    -- F3/Decision 9 (FR-021): mesmo período já fechado -> motivo específico
    -- ANTES da checagem de ordem (senão o motivo viria como FORA_DE_ORDEM,
    -- que é sobre outra coisa). Fora de ordem (anterior ou pulando semana)
    -- -> APURACAO_FORA_DE_ORDEM. Empresa sem nenhuma apuração: livre.
    IF EXISTS (SELECT 1 FROM "ApuracaoRepasse" WHERE id_empresa = 6 AND periodo_inicio = p_periodo_inicio) THEN
        RAISE EXCEPTION 'APURACAO_JA_FECHADA';
    END IF;

    SELECT max(periodo_inicio) INTO v_ultimo_periodo FROM "ApuracaoRepasse" WHERE id_empresa = 6;
    IF v_ultimo_periodo IS NOT NULL AND p_periodo_inicio <> v_ultimo_periodo + 7 THEN
        RAISE EXCEPTION 'APURACAO_FORA_DE_ORDEM';
    END IF;

    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(6);
    IF v_config.id IS NULL OR v_config.apuracao_data_base IS NULL THEN
        RAISE EXCEPTION 'APURACAO_NAO_CONFIGURADA';
    END IF;
    v_fim := p_periodo_inicio + 6;

    -- 1.6.3 (dec-043): não fechar enquanto a produção do último dia ainda
    -- puder ser solicitada (D-1 até o corte do dia seguinte).
    IF NOT hub_adiantamento_repasse_pode_fechar(v_config, v_fim, now()) THEN
        RAISE EXCEPTION 'PERIODO_EM_ABERTO';
    END IF;

    SELECT jsonb_object_agg(s.status, s.qtd) INTO v_pendencias
    FROM (
        SELECT status, count(*) AS qtd
        FROM "AdiantamentoSolicitacao"
        WHERE id_empresa = ANY (v_escopo)
          AND data_producao BETWEEN p_periodo_inicio AND v_fim
          AND status IN ('AGUARDANDO_CORTE', 'AGUARDANDO_PRODUCAO', 'LIBERADA', 'EM_LOTE', 'EXPORTADA', 'FALHOU')
        GROUP BY status
    ) s;

    IF v_pendencias IS NOT NULL THEN
        RAISE EXCEPTION 'APURACAO_COM_PENDENCIAS' USING DETAIL = v_pendencias::text;
    END IF;

    -- F3/Decision 12/FR-025a: piso_aplicado grava o valor lido AGORA, dentro
    -- desta mesma transação — nunca o vigente no início da semana.
    BEGIN
        INSERT INTO "ApuracaoRepasse" (id_empresa, periodo_inicio, periodo_fim, data_repasse, configuracao_id, fechado_por, piso_aplicado)
        VALUES (6, p_periodo_inicio, v_fim, v_fim + v_config.apuracao_dias_ate_repasse, v_config.id, v_sub, v_config.repasse_valor_minimo)
        RETURNING id INTO v_apuracao_id;
    EXCEPTION WHEN unique_violation THEN
        -- Defesa em profundidade: o EXISTS acima já cobre o caso comum: isto
        -- só dispara numa corrida que o advisory lock já deveria impedir.
        RAISE EXCEPTION 'APURACAO_JA_FECHADA';
    END;

    -- F3/Decision 9: a apuração da empresa cujo período é exatamente o
    -- anterior (garantido pela checagem de ordem acima) é a fonte do saldo.
    SELECT a.id INTO v_apuracao_anterior_id FROM "ApuracaoRepasse" a
      WHERE a.id_empresa = 6 AND a.periodo_inicio = v_ultimo_periodo;

    WITH creditos AS (
        SELECT f.entregador_id, sum(f.valor) AS total,
               sum(f.valor) FILTER (WHERE v_config.categorias_nota IS NOT NULL
                     AND hub_adiantamento_categoria_casa(f.descricao, v_config.categorias_nota)) AS total_nota,
               sum(f.valor) FILTER (WHERE v_config.categorias_nota IS NOT NULL
                     AND NOT hub_adiantamento_categoria_casa(f.descricao, v_config.categorias_nota)) AS total_fora
        FROM "FaturamentoLancamento" f
        WHERE f.id_empresa = ANY (v_escopo) AND f.tipo = 'Credito'
          AND hub_adiantamento_categoria_casa(f.descricao, COALESCE(v_config.categorias_extrato, ARRAY[]::text[]))
          AND (
              (v_config.apuracao_data_base = 'data_lancamento' AND f.data_lancamento BETWEEN p_periodo_inicio AND v_fim)
              OR (v_config.apuracao_data_base = 'data_referencia' AND f.data_referencia BETWEEN p_periodo_inicio AND v_fim)
          )
        GROUP BY f.entregador_id
    ),
    debitos_cte AS (
        SELECT f.entregador_id, sum(abs(f.valor)) AS total
        FROM "FaturamentoLancamento" f
        WHERE f.id_empresa = ANY (v_escopo) AND f.tipo = 'Debito'
          AND (
              (v_config.apuracao_data_base = 'data_lancamento' AND f.data_lancamento BETWEEN p_periodo_inicio AND v_fim)
              OR (v_config.apuracao_data_base = 'data_referencia' AND f.data_referencia BETWEEN p_periodo_inicio AND v_fim)
          )
        GROUP BY f.entregador_id
    ),
    pagas AS (
        SELECT s.entregador_id, sum(s.valor_bruto) AS total, jsonb_agg(s.id) AS ids
        FROM "AdiantamentoSolicitacao" s
        WHERE s.id_empresa = ANY (v_escopo) AND s.status IN ('PAGA', 'EXPORTADA')
          AND s.data_producao BETWEEN p_periodo_inicio AND v_fim
        GROUP BY s.entregador_id
    ),
    -- F3/Decision 7: saldo transportado da apuração ANTERIOR (NULL numa
    -- apuração pré-0098 => tratado como 0 pelo COALESCE abaixo).
    saldo_ant AS (
        SELECT i.entregador_id, i.valor_transportado, i.transportado_nota, i.transportado_fora
        FROM "ApuracaoRepasseItem" i
        WHERE i.apuracao_id = v_apuracao_anterior_id
    ),
    linhas AS (
        SELECT
            e.id AS entregador_id,
            COALESCE(c.total, 0) AS creditos,
            c.total_nota, c.total_fora,
            CASE WHEN v_config.desconto_adiantamentos THEN COALESCE(p.total, 0) ELSE 0 END AS adiantamentos,
            CASE WHEN v_config.desconto_debitos THEN COALESCE(d.total, 0) ELSE 0 END AS debitos,
            COALESCE(p.ids, '[]'::jsonb) AS solicitacoes_pagas,
            COALESCE(sa.valor_transportado, 0) AS saldo_anterior,
            COALESCE(sa.transportado_nota, 0) AS saldo_anterior_nota,
            COALESCE(sa.transportado_fora, 0) AS saldo_anterior_fora
        FROM "Entregador" e
        LEFT JOIN creditos c ON c.entregador_id = e.id
        LEFT JOIN debitos_cte d ON d.entregador_id = e.id
        LEFT JOIN pagas p ON p.entregador_id = e.id
        LEFT JOIN saldo_ant sa ON sa.entregador_id = e.id
        WHERE e.id_empresa = ANY (v_escopo)
          -- F3/Decision 10: inclui quem só tem saldo anterior, mesmo sem
          -- nenhuma atividade nesta semana. Sem filtro de `ativo` (edge case
          -- da spec: motorista desativado com saldo continua com item).
          AND (c.entregador_id IS NOT NULL OR d.entregador_id IS NOT NULL OR p.entregador_id IS NOT NULL
               OR COALESCE(sa.valor_transportado, 0) > 0)
    ),
    calc AS (
        SELECT l.*, (l.creditos - l.adiantamentos - l.debitos) AS remanescente FROM linhas l
    ),
    -- F3/Decision 8: regra de cálculo por item.
    resultado AS (
        SELECT c.*,
               CASE
                   WHEN c.remanescente < 0 THEN 0::numeric(12,2)
                   WHEN (c.remanescente + c.saldo_anterior) > 0
                        AND (c.remanescente + c.saldo_anterior) < v_config.repasse_valor_minimo THEN 0::numeric(12,2)
                   ELSE (c.remanescente + c.saldo_anterior)
               END AS valor_pago,
               CASE
                   WHEN c.remanescente < 0 THEN c.saldo_anterior
                   WHEN (c.remanescente + c.saldo_anterior) > 0
                        AND (c.remanescente + c.saldo_anterior) < v_config.repasse_valor_minimo
                        THEN (c.remanescente + c.saldo_anterior)
                   ELSE 0::numeric(12,2)
               END AS valor_transportado
        FROM calc c
    ),
    resultado_nota AS (
        SELECT r.*,
               CASE
                   WHEN r.remanescente < 0 THEN r.saldo_anterior_nota
                   WHEN r.valor_pago = 0 AND r.valor_transportado > 0 THEN COALESCE(r.total_nota, 0) + r.saldo_anterior_nota
                   ELSE 0::numeric(12,2)
               END AS transportado_nota,
               CASE
                   WHEN r.remanescente < 0 THEN r.saldo_anterior_fora
                   WHEN r.valor_pago = 0 AND r.valor_transportado > 0 THEN COALESCE(r.total_fora, 0) + r.saldo_anterior_fora
                   ELSE 0::numeric(12,2)
               END AS transportado_fora
        FROM resultado r
    )
    INSERT INTO "ApuracaoRepasseItem" (apuracao_id, id_empresa, entregador_id, creditos, adiantamentos, debitos, remanescente,
                                      valor_nota, valor_fora_nota, detalhe,
                                      saldo_anterior, saldo_anterior_nota, saldo_anterior_fora,
                                      valor_pago, valor_transportado, transportado_nota, transportado_fora)
    SELECT v_apuracao_id, 6, r.entregador_id, r.creditos, r.adiantamentos, r.debitos, r.remanescente,
           r.total_nota, r.total_fora,
           jsonb_build_object('solicitacoesPagas', r.solicitacoes_pagas),
           r.saldo_anterior, r.saldo_anterior_nota, r.saldo_anterior_fora,
           r.valor_pago, r.valor_transportado, r.transportado_nota, r.transportado_fora
    FROM resultado_nota r;

    -- F3/Decision 11: total do fechamento passa a ser o que será PAGO.
    SELECT count(*), COALESCE(sum(i.valor_pago), 0) INTO v_motoristas, v_total
    FROM "ApuracaoRepasseItem" i WHERE i.apuracao_id = v_apuracao_id;

    SELECT count(*) INTO v_nao_pagos
    FROM "AdiantamentoSolicitacao"
    WHERE id_empresa = ANY (v_escopo) AND data_producao BETWEEN p_periodo_inicio AND v_fim
      AND status NOT IN ('PAGA', 'CANCELADA');

    RETURN QUERY SELECT v_apuracao_id, v_motoristas, v_total::numeric, v_nao_pagos;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. hub_adiantamento_repasse (de 0088) — prévia da semana aberta, com
--    saldo/piso PREVISTO (sem gravar nada). Muda o tipo de retorno.
-- ═══════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS hub_adiantamento_repasse(date, text, boolean, int, int);

CREATE FUNCTION hub_adiantamento_repasse(
    p_periodo_inicio date, p_busca text DEFAULT NULL, p_somente_negativos boolean DEFAULT false,
    p_offset int DEFAULT 0, p_limite int DEFAULT 20
)
RETURNS TABLE (
    entregador_id int, nome text, creditos numeric, adiantamentos numeric, debitos numeric,
    remanescente numeric, em_processamento boolean, total bigint,
    total_creditos numeric, total_adiantamentos numeric, total_debitos numeric, total_remanescente numeric,
    saldo_anterior numeric, valor_pago numeric, valor_transportado numeric, retido boolean,
    total_saldo_anterior numeric, total_a_pagar numeric, total_transportado numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_config "AdiantamentoConfiguracao";
    v_fim    date;
    v_escopo int[] := hub_jwt_escopo_ids();
BEGIN
    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(6);
    IF v_config.id IS NULL OR v_config.apuracao_data_base IS NULL THEN
        RAISE EXCEPTION 'APURACAO_NAO_CONFIGURADA';
    END IF;
    v_fim := p_periodo_inicio + 6;

    RETURN QUERY
    WITH creditos AS (
        SELECT f.entregador_id, sum(f.valor) AS total
        FROM "FaturamentoLancamento" f
        WHERE f.id_empresa = ANY (v_escopo) AND f.tipo = 'Credito'
          AND hub_adiantamento_categoria_casa(f.descricao, COALESCE(v_config.categorias_extrato, ARRAY[]::text[]))
          AND (
              (v_config.apuracao_data_base = 'data_lancamento' AND f.data_lancamento BETWEEN p_periodo_inicio AND v_fim)
              OR (v_config.apuracao_data_base = 'data_referencia' AND f.data_referencia BETWEEN p_periodo_inicio AND v_fim)
          )
        GROUP BY f.entregador_id
    ),
    debitos_cte AS (
        SELECT f.entregador_id, sum(abs(f.valor)) AS total
        FROM "FaturamentoLancamento" f
        WHERE f.id_empresa = ANY (v_escopo) AND f.tipo = 'Debito'
          AND (
              (v_config.apuracao_data_base = 'data_lancamento' AND f.data_lancamento BETWEEN p_periodo_inicio AND v_fim)
              OR (v_config.apuracao_data_base = 'data_referencia' AND f.data_referencia BETWEEN p_periodo_inicio AND v_fim)
          )
        GROUP BY f.entregador_id
    ),
    adiant AS (
        SELECT s.entregador_id,
               sum(s.valor_bruto) FILTER (WHERE s.status = 'PAGA')      AS pagos,
               sum(s.valor_bruto) FILTER (WHERE s.status = 'EXPORTADA') AS processando
        FROM "AdiantamentoSolicitacao" s
        WHERE s.id_empresa = ANY (v_escopo) AND s.data_producao BETWEEN p_periodo_inicio AND v_fim
          AND s.status IN ('PAGA', 'EXPORTADA')
        GROUP BY s.entregador_id
    ),
    -- F3/Decision 10 (prévia): saldo transportado da semana FECHADA
    -- imediatamente anterior (p_periodo_inicio - 7). Ainda não fechada (ou
    -- fechada pré-0098) => 0 pelo COALESCE abaixo.
    saldo_ant AS (
        SELECT i.entregador_id, i.valor_transportado
        FROM "ApuracaoRepasseItem" i
        JOIN "ApuracaoRepasse" a ON a.id = i.apuracao_id
        WHERE a.id_empresa = ANY (v_escopo) AND a.periodo_inicio = p_periodo_inicio - 7
    ),
    linhas AS (
        SELECT
            e.id AS entregador_id, e.nome,
            COALESCE(c.total, 0) AS creditos,
            CASE WHEN v_config.desconto_adiantamentos THEN COALESCE(a.pagos, 0) ELSE 0 END AS adiantamentos,
            CASE WHEN v_config.desconto_debitos THEN COALESCE(d.total, 0) ELSE 0 END AS debitos,
            COALESCE(a.processando, 0) > 0 AS em_processamento,
            COALESCE(sa.valor_transportado, 0) AS saldo_anterior
        FROM "Entregador" e
        LEFT JOIN creditos c ON c.entregador_id = e.id
        LEFT JOIN debitos_cte d ON d.entregador_id = e.id
        LEFT JOIN adiant a ON a.entregador_id = e.id
        LEFT JOIN saldo_ant sa ON sa.entregador_id = e.id
        WHERE e.id_empresa = ANY (v_escopo)
          AND (c.entregador_id IS NOT NULL OR d.entregador_id IS NOT NULL OR a.pagos IS NOT NULL
               OR a.processando IS NOT NULL OR COALESCE(sa.valor_transportado, 0) > 0)
          AND (p_busca IS NULL OR hub_normaliza_nome(e.nome) LIKE '%' || hub_normaliza_nome(p_busca) || '%')
    ),
    calc AS (
        SELECT *, (creditos - adiantamentos - debitos) AS remanescente FROM linhas
    ),
    -- F3/Decision 8 (prévia): mesma regra de piso do fechamento, com o piso
    -- VIGENTE AGORA (nada é gravado; é só previsão, Decision 12).
    piso AS (
        SELECT c.*,
               CASE
                   WHEN c.remanescente < 0 THEN 0::numeric
                   WHEN (c.remanescente + c.saldo_anterior) > 0
                        AND (c.remanescente + c.saldo_anterior) < v_config.repasse_valor_minimo THEN 0::numeric
                   ELSE (c.remanescente + c.saldo_anterior)
               END AS valor_pago,
               CASE
                   WHEN c.remanescente < 0 THEN c.saldo_anterior
                   WHEN (c.remanescente + c.saldo_anterior) > 0
                        AND (c.remanescente + c.saldo_anterior) < v_config.repasse_valor_minimo
                        THEN (c.remanescente + c.saldo_anterior)
                   ELSE 0::numeric
               END AS valor_transportado
        FROM calc c
    ),
    filtradas AS (
        SELECT * FROM piso WHERE (NOT p_somente_negativos OR remanescente < 0)
    )
    -- As janelas `OVER ()` são avaliadas sobre TODAS as linhas de
    -- `filtradas`, antes de OFFSET/LIMIT — mesmo cuidado de sempre: os
    -- totais são do período, não da página.
    SELECT f.entregador_id, f.nome, f.creditos, f.adiantamentos, f.debitos, f.remanescente,
           f.em_processamento, count(*) OVER (),
           sum(f.creditos) OVER (), sum(f.adiantamentos) OVER (),
           sum(f.debitos) OVER (), sum(f.remanescente) OVER (),
           f.saldo_anterior, f.valor_pago, f.valor_transportado,
           (f.remanescente >= 0 AND f.valor_pago = 0 AND f.valor_transportado > 0),
           sum(f.saldo_anterior) OVER (), sum(f.valor_pago) OVER (), sum(f.valor_transportado) OVER ()
    FROM filtradas f
    ORDER BY f.nome
    OFFSET p_offset LIMIT p_limite;
END;
$$;

-- DROP apaga o GRANT — refazer.
REVOKE ALL ON FUNCTION hub_adiantamento_repasse(date, text, boolean, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse(date, text, boolean, int, int) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. hub_adiantamento_repasse_congelado (de 0086) — lê as colunas
--    congeladas (NULL num item pré-regra). Muda o tipo de retorno.
-- ═══════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS hub_adiantamento_repasse_congelado(date, text, boolean, int, int);

CREATE FUNCTION hub_adiantamento_repasse_congelado(
    p_periodo_inicio date, p_busca text DEFAULT NULL, p_somente_negativos boolean DEFAULT false,
    p_offset int DEFAULT 0, p_limite int DEFAULT 20
)
RETURNS TABLE (
    entregador_id int, nome text, creditos numeric, adiantamentos numeric, debitos numeric,
    remanescente numeric, em_processamento boolean, total bigint,
    total_creditos numeric, total_adiantamentos numeric, total_debitos numeric, total_remanescente numeric,
    saldo_anterior numeric, valor_pago numeric, valor_transportado numeric, retido boolean,
    total_saldo_anterior numeric, total_a_pagar numeric, total_transportado numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_escopo int[] := hub_jwt_escopo_ids();
BEGIN
    RETURN QUERY
    WITH linhas AS (
        SELECT i.entregador_id, e.nome, i.creditos, i.adiantamentos, i.debitos, i.remanescente,
               i.saldo_anterior, i.valor_pago, i.valor_transportado
        FROM "ApuracaoRepasseItem" i
        JOIN "ApuracaoRepasse" a ON a.id = i.apuracao_id
        JOIN "Entregador" e ON e.id = i.entregador_id
        WHERE a.id_empresa = ANY (v_escopo)
          AND a.periodo_inicio = p_periodo_inicio
          AND (p_busca IS NULL OR hub_normaliza_nome(e.nome) LIKE '%' || hub_normaliza_nome(p_busca) || '%')
    ),
    filtradas AS (
        SELECT * FROM linhas WHERE (NOT p_somente_negativos OR remanescente < 0)
    )
    SELECT f.entregador_id, f.nome, f.creditos, f.adiantamentos, f.debitos, f.remanescente,
           false, count(*) OVER (),
           sum(f.creditos) OVER (), sum(f.adiantamentos) OVER (),
           sum(f.debitos) OVER (), sum(f.remanescente) OVER (),
           f.saldo_anterior, f.valor_pago, f.valor_transportado,
           -- NULL num item pré-regra (valor_pago/valor_transportado NULL)
           -- se propaga aqui de propósito: "não sabemos" é diferente de
           -- "não está retido".
           (f.remanescente >= 0 AND f.valor_pago = 0 AND f.valor_transportado > 0),
           sum(f.saldo_anterior) OVER (), sum(f.valor_pago) OVER (), sum(f.valor_transportado) OVER ()
    FROM filtradas f
    ORDER BY f.nome
    OFFSET p_offset LIMIT p_limite;
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_repasse_congelado(date, text, boolean, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse_congelado(date, text, boolean, int, int) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. hub_adiantamento_repasse_motorista (de 0088) — semana em curso, app
--    do motorista. Muda o tipo de retorno (2 colunas no fim).
-- ═══════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS hub_adiantamento_repasse_motorista();

CREATE FUNCTION hub_adiantamento_repasse_motorista()
RETURNS TABLE (
    visivel       boolean,
    periodo_inicio date,
    periodo_fim   date,
    data_repasse  date,
    situacao      text,
    creditos      numeric(12,2),
    debitos       numeric(12,2),
    remanescente  numeric(12,2),
    negativo      boolean,
    adiantamentos jsonb,
    saldo_anterior   numeric(12,2),
    abaixo_do_minimo boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj        text := hub_jwt_motorista_cnpj();
    v_conta_motorista_id int;
    v_entregador  RECORD;
    v_config      "AdiantamentoConfiguracao";
    v_hoje        date;
    v_inicio      date;
    v_fim         date;
    v_creditos    numeric(12,2) := 0;
    v_debitos     numeric(12,2) := 0;
    v_desconto    numeric(12,2) := 0;
    v_adiant      jsonb := '[]'::jsonb;
    v_fechada     boolean;
    v_saldo_anterior numeric(12,2);
    v_remanescente   numeric(12,2);
    v_total          numeric(12,2);
BEGIN
    IF v_cnpj IS NULL THEN RETURN; END IF;
    SELECT cm.id INTO v_conta_motorista_id FROM "ContaMotorista" cm WHERE cm.cnpj_prestador = v_cnpj;
    IF v_conta_motorista_id IS NULL THEN RETURN; END IF;
    SELECT e.* INTO v_entregador FROM "Entregador" e WHERE e.motorista_id = v_conta_motorista_id;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(v_entregador.id_empresa);
    IF v_config.id IS NULL OR NOT v_config.repasse_visivel_app OR v_config.apuracao_dia_inicio IS NULL THEN
        RETURN QUERY SELECT false, NULL::date, NULL::date, NULL::date, NULL::text,
            NULL::numeric(12,2), NULL::numeric(12,2), NULL::numeric(12,2), NULL::boolean, NULL::jsonb,
            NULL::numeric(12,2), NULL::boolean;
        RETURN;
    END IF;

    -- "Hoje" é o dia em São Paulo (v_config.timezone), nunca `current_date`.
    v_hoje := (now() AT TIME ZONE v_config.timezone)::date;
    v_inicio := v_hoje - ((extract(dow FROM v_hoje)::int - v_config.apuracao_dia_inicio + 7) % 7);
    v_fim := v_inicio + 6;

    SELECT COALESCE(sum(f.valor), 0) INTO v_creditos
    FROM "FaturamentoLancamento" f
    WHERE f.entregador_id = v_entregador.id AND f.tipo = 'Credito'
      AND hub_adiantamento_categoria_casa(f.descricao, COALESCE(v_config.categorias_extrato, ARRAY[]::text[]))
      AND (
          (v_config.apuracao_data_base = 'data_lancamento' AND f.data_lancamento BETWEEN v_inicio AND v_fim)
          OR (v_config.apuracao_data_base = 'data_referencia' AND f.data_referencia BETWEEN v_inicio AND v_fim)
      );

    IF v_config.desconto_debitos THEN
        SELECT COALESCE(sum(abs(f.valor)), 0) INTO v_debitos
        FROM "FaturamentoLancamento" f
        WHERE f.entregador_id = v_entregador.id AND f.tipo = 'Debito'
          AND (
              (v_config.apuracao_data_base = 'data_lancamento' AND f.data_lancamento BETWEEN v_inicio AND v_fim)
              OR (v_config.apuracao_data_base = 'data_referencia' AND f.data_referencia BETWEEN v_inicio AND v_fim)
          );
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', s.id, 'dataProducao', s.data_producao, 'valorBruto', s.valor_bruto,
        'emProcessamento', s.status = 'EXPORTADA'
    ) ORDER BY s.data_producao), '[]'::jsonb) INTO v_adiant
    FROM "AdiantamentoSolicitacao" s
    WHERE s.entregador_id = v_entregador.id AND s.status IN ('PAGA', 'EXPORTADA')
      AND s.data_producao BETWEEN v_inicio AND v_fim;

    IF v_config.desconto_adiantamentos THEN
        SELECT COALESCE(sum(s.valor_bruto), 0) INTO v_desconto
        FROM "AdiantamentoSolicitacao" s
        WHERE s.entregador_id = v_entregador.id AND s.status IN ('PAGA', 'EXPORTADA')
          AND s.data_producao BETWEEN v_inicio AND v_fim;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM "ApuracaoRepasse" ar
        WHERE ar.id_empresa = v_entregador.id_empresa AND ar.periodo_inicio = v_inicio
    ) INTO v_fechada;

    -- F3/Decision 10: saldo transportado da semana fechada imediatamente
    -- anterior. Sem apuração anterior (ou pré-0098) => 0.
    SELECT i.valor_transportado INTO v_saldo_anterior
    FROM "ApuracaoRepasseItem" i
    JOIN "ApuracaoRepasse" a ON a.id = i.apuracao_id
    WHERE i.entregador_id = v_entregador.id AND a.id_empresa = v_entregador.id_empresa
      AND a.periodo_inicio = v_inicio - 7;
    v_saldo_anterior := COALESCE(v_saldo_anterior, 0);

    v_remanescente := (v_creditos - v_desconto - v_debitos);
    v_total := v_remanescente + v_saldo_anterior;

    RETURN QUERY SELECT true, v_inicio, v_fim, v_fim + v_config.apuracao_dias_ate_repasse,
        (CASE WHEN v_fechada THEN 'FECHADA' ELSE 'EM_APURACAO' END)::text,
        v_creditos, v_debitos, v_remanescente, (v_remanescente < 0), v_adiant,
        v_saldo_anterior,
        (v_remanescente >= 0 AND v_total > 0 AND v_total < v_config.repasse_valor_minimo);
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_repasse_motorista() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse_motorista() TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. hub_adiantamento_repasse_motorista_ultimo_fechado (de 0086) — última
--    semana fechada, app do motorista. Muda o tipo de retorno.
-- ═══════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS hub_adiantamento_repasse_motorista_ultimo_fechado();

CREATE FUNCTION hub_adiantamento_repasse_motorista_ultimo_fechado()
RETURNS TABLE (
    periodo_inicio date, periodo_fim date, data_repasse date, fechado_em timestamptz,
    creditos numeric(12,2), adiantamentos numeric(12,2), debitos numeric(12,2),
    remanescente numeric(12,2), negativo boolean,
    saldo_anterior numeric(12,2), valor_pago numeric(12,2), valor_transportado numeric(12,2), retido boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj               text := hub_jwt_motorista_cnpj();
    v_conta_motorista_id int;
    v_entregador         RECORD;
    v_config             "AdiantamentoConfiguracao";
BEGIN
    IF v_cnpj IS NULL THEN RETURN; END IF;
    SELECT cm.id INTO v_conta_motorista_id FROM "ContaMotorista" cm WHERE cm.cnpj_prestador = v_cnpj;
    IF v_conta_motorista_id IS NULL THEN RETURN; END IF;
    SELECT e.* INTO v_entregador FROM "Entregador" e WHERE e.motorista_id = v_conta_motorista_id;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(v_entregador.id_empresa);
    IF v_config.id IS NULL OR NOT v_config.repasse_visivel_app THEN RETURN; END IF;

    RETURN QUERY
    SELECT a.periodo_inicio, a.periodo_fim, a.data_repasse, a.fechado_em,
           i.creditos, i.adiantamentos, i.debitos, i.remanescente,
           i.remanescente < 0,
           i.saldo_anterior, i.valor_pago, i.valor_transportado,
           (i.remanescente >= 0 AND i.valor_pago = 0 AND i.valor_transportado > 0)
    FROM "ApuracaoRepasseItem" i
    JOIN "ApuracaoRepasse" a ON a.id = i.apuracao_id
    WHERE i.entregador_id = v_entregador.id
      AND a.id_empresa = v_entregador.id_empresa
    ORDER BY a.periodo_inicio DESC
    LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_repasse_motorista_ultimo_fechado() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse_motorista_ultimo_fechado() TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 7. hub_adiantamento_configuracao_salvar (de 0091) — carrega/valida o
--    piso; exige `pagamento_confirmar` para alterá-lo (FR-026). Devolve a
--    linha inteira da tabela: sem mudança de shape, CREATE OR REPLACE.
-- ═══════════════════════════════════════════════════════════════════════

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
    v_piso_novo numeric(14,2);
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.configurar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;
    IF NOT (6 = ANY (hub_jwt_escopo_ids())) THEN RAISE EXCEPTION 'FORA_DO_GRUPO_MOVEE'; END IF;

    SELECT * INTO v_atual FROM "AdiantamentoConfiguracao"
        WHERE id_empresa = 6 ORDER BY versao DESC LIMIT 1 FOR UPDATE;
    IF v_atual.versao IS DISTINCT FROM p_versao_esperada THEN
        RAISE EXCEPTION 'VERSAO_DESATUALIZADA';
    END IF;

    -- F3/FR-026 (Decision 12): alterar o piso exige a permissão MAIS
    -- restrita (pagamento_confirmar), não a genérica (configurar) já
    -- checada acima. Repete a checagem de `> 0` do backend em defesa de
    -- profundidade (o CHECK do banco também recusaria, mas com uma
    -- mensagem genérica de constraint em vez do motivo de negócio).
    IF p_dados ? 'repasseValorMinimo' THEN
        v_piso_novo := NULLIF(p_dados ->> 'repasseValorMinimo', '')::numeric;
        IF v_piso_novo IS NULL OR v_piso_novo <= 0 THEN
            RAISE EXCEPTION 'DADOS_INVALIDOS_REPASSE_VALOR_MINIMO';
        END IF;
        IF v_piso_novo IS DISTINCT FROM v_atual.repasse_valor_minimo THEN
            IF NOT hub_adiantamento_tem_permissao('adiantamentos.pagamento_confirmar') THEN
                RAISE EXCEPTION 'PERMISSAO_NEGADA_PISO';
            END IF;
        END IF;
    END IF;

    BEGIN
        INSERT INTO "AdiantamentoConfiguracao" (
            id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura,
            horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao,
            previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio,
            apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato, categorias_nota,
            mensagem1_modelo, mensagem2_modelo, repasse_valor_minimo,
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
            COALESCE((SELECT array_agg(x) FROM jsonb_array_elements_text(p_dados -> 'categoriasNota') x), v_atual.categorias_nota),
            COALESCE(p_dados ->> 'mensagem1Modelo', v_atual.mensagem1_modelo),
            COALESCE(p_dados ->> 'mensagem2Modelo', v_atual.mensagem2_modelo),
            -- F3: sem isso, salvar qualquer outro campo voltaria o piso ao
            -- default (5.50) em vez de manter o valor vigente.
            COALESCE(v_piso_novo, v_atual.repasse_valor_minimo, 5.50),
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

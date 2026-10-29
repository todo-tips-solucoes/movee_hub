-- 0118_repasse_nota_a_emitir.sql
-- Feature `repasse-gera-movimento` — o pago por fora abate tambem a NOTA a emitir, o excedente vira
-- divida no livro da nota (transportado_nota negativo), e a geracao do Envio em Massa ganha o id pre-alocado (S1).
-- Spec: docs/specs/repasse-gera-movimento/ (plan.md F1, data-model.md).
--
-- ORDEM: esta migration vem ANTES do deploy do codigo. O codigo ANTIGO segue funcionando: a coluna e aditiva
-- (NULL nas linhas antigas), as funcoes so GANHAM uma coluna no fim do retorno, o tipo de retorno de `fechar`
-- nao muda. migrate.sh aplica o arquivo em UMA transacao: nada aqui e CONCURRENTLY.
-- IDEMPOTENTE: ADD COLUMN IF NOT EXISTS; CREATE OR REPLACE; DROP FUNCTION IF EXISTS + CREATE + REVOKE/GRANT.
--
-- NAO FAZ, de proposito: nao altera CHECK algum (apuracaorepasseitem_saldo_conserva fica como esta: o excedente
-- vai ao livro da NOTA, que o CHECK nao cobre); nao toca imutabilidade de ApuracaoRepasse/Item (0066:460-478);
-- nao toca as funcoes do app do motorista nem hub_adiantamento_repasse_pode_fechar; zero DDL/GRANT/policy na
-- trilha ApuracaoRepasseMovimento (0092:44, :63); zero SECURITY DEFINER novo.
-- S5 (obrigatorio): REVOKE ALL ... FROM PUBLIC + GRANT EXECUTE ... TO authenticated apos CADA DROP/CREATE.

ALTER TABLE "ApuracaoRepasseItem" ADD COLUMN IF NOT EXISTS nota_a_emitir numeric(12,2);
COMMENT ON COLUMN "ApuracaoRepasseItem".nota_a_emitir IS
  'Nota LIQUIDA a emitir, congelada no fechamento: (total_nota + saldo_anterior_nota) menos a deducao do pago por fora, piso 0. NULL = sem categorias_nota (SEM_DIVISAO) ou item anterior a 0118 (recusa com motivo proprio, nunca usar valor_nota bruto).';

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
    -- 0117 (FR-016/FR-017): lançamentos pagos por fora, agregados por entregador, as
    -- duas direções por FILTER. Tabela DIFERENTE de `debitos_cte` (FaturamentoLancamento):
    -- dupla contagem impossível por construção. Índice idx_lancamentoexterno_empresa_data_entregador.
    externos_cte AS (
        SELECT l.entregador_id,
               sum(l.valor) FILTER (WHERE t.sinal < 0) AS deducoes,
               sum(l.valor) FILTER (WHERE t.sinal > 0) AS creditos
        FROM "LancamentoExterno" l
        JOIN "LancamentoExternoTipo" t ON t.codigo = l.tipo
        WHERE l.id_empresa = ANY (v_escopo)
          AND l.data_pagamento BETWEEN p_periodo_inicio AND v_fim
        GROUP BY l.entregador_id
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
            -- 0117: só a DEDUÇÃO passa pelo gate da flag (um crédito não é desconto, FR-022).
            CASE WHEN v_config.desconto_adiantamentos THEN COALESCE(x.deducoes, 0) ELSE 0 END AS externos_deducao,
            COALESCE(x.creditos, 0) AS externos_credito,
            COALESCE(p.ids, '[]'::jsonb) AS solicitacoes_pagas,
            COALESCE(sa.valor_transportado, 0) AS saldo_anterior,
            COALESCE(sa.transportado_nota, 0) AS saldo_anterior_nota,
            COALESCE(sa.transportado_fora, 0) AS saldo_anterior_fora
        FROM "Entregador" e
        LEFT JOIN creditos c ON c.entregador_id = e.id
        LEFT JOIN debitos_cte d ON d.entregador_id = e.id
        LEFT JOIN pagas p ON p.entregador_id = e.id
        LEFT JOIN externos_cte x ON x.entregador_id = e.id
        LEFT JOIN saldo_ant sa ON sa.entregador_id = e.id
        WHERE e.id_empresa = ANY (v_escopo)
          -- F3/Decision 10: inclui quem só tem saldo anterior, mesmo sem
          -- nenhuma atividade nesta semana. Sem filtro de `ativo` (edge case
          -- da spec: motorista desativado com saldo continua com item).
          AND (c.entregador_id IS NOT NULL OR d.entregador_id IS NOT NULL OR p.entregador_id IS NOT NULL
               OR x.entregador_id IS NOT NULL OR COALESCE(sa.valor_transportado, 0) > 0
               -- 0118 (D3): quem so carrega DIVIDA de nota (transportado_nota negativo) tambem entra.
               OR COALESCE(sa.transportado_nota, 0) <> 0)
    ),
    calc AS (
        SELECT l.*, (l.creditos - l.adiantamentos - l.debitos - l.externos_deducao + l.externos_credito) AS remanescente FROM linhas l
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
    -- 0118 (D2/D3): a deducao do pago por fora entra tambem na PARTE DA NOTA. base_nota = nota da semana +
    -- saldo de nota carregado (negativo = divida da semana anterior); a deducao aplicada nunca passa da
    -- nota positiva disponivel; o excedente vira divida no livro da nota (transportado_nota NEGATIVO).
    nota_base AS (
        SELECT r.*,
               -- remanescente < 0: o saldo de nota carregado NAO entra (dec-055: a 0098 o mantem em transportado_nota
               -- para a PROXIMA nota; soma-lo tambem aqui o duplicaria quando for pago).
               (COALESCE(r.total_nota, 0) + CASE WHEN r.remanescente < 0 THEN 0 ELSE r.saldo_anterior_nota END) AS base_nota,
               LEAST(r.externos_deducao, GREATEST(COALESCE(r.total_nota, 0) + CASE WHEN r.remanescente < 0 THEN 0 ELSE r.saldo_anterior_nota END, 0)) AS deducao_aplicada_na_nota
        FROM resultado r
    ),
    resultado_nota AS (
        SELECT b.*,
               -- NULL (nunca 0) quando nao ha categorias_nota: 0 colidiria com VALOR_ZERO.
               CASE WHEN v_config.categorias_nota IS NULL THEN NULL
                    ELSE GREATEST(b.base_nota, 0) - b.deducao_aplicada_na_nota
               END AS nota_a_emitir,
               CASE
                   -- sem categorias_nota: expressao ORIGINAL da 0117, sem transporte novo (D2).
                   WHEN v_config.categorias_nota IS NULL THEN
                        CASE
                            WHEN b.remanescente < 0 THEN b.saldo_anterior_nota
                            WHEN b.valor_pago = 0 AND b.valor_transportado > 0 THEN COALESCE(b.total_nota, 0) + b.saldo_anterior_nota
                            ELSE 0::numeric(12,2)
                        END
                   -- caixa negativo: o caixa descarta o negativo por contrato (CHECK saldo_conserva); a nota
                   -- segue o caixa e carrega so o saldo anterior (restringir, nao generalizar).
                   WHEN b.remanescente < 0 THEN b.saldo_anterior_nota
                   -- retido pelo piso: a nota fica retida junto, ja liquida da deducao (base - dedutivel total).
                   WHEN b.valor_pago = 0 AND b.valor_transportado > 0 THEN b.base_nota - b.externos_deducao
                   -- pago: a nota parcial sai em nota_a_emitir; sobra apenas a divida (nunca credito).
                   ELSE LEAST(b.base_nota, 0) - (b.externos_deducao - b.deducao_aplicada_na_nota)
               END AS transportado_nota,
               CASE
                   WHEN b.remanescente < 0 THEN b.saldo_anterior_fora
                   WHEN b.valor_pago = 0 AND b.valor_transportado > 0 THEN COALESCE(b.total_fora, 0) + b.saldo_anterior_fora
                   ELSE 0::numeric(12,2)
               END AS transportado_fora
        FROM nota_base b
    )
    INSERT INTO "ApuracaoRepasseItem" (apuracao_id, id_empresa, entregador_id, creditos, adiantamentos, debitos, remanescente,
                                      valor_nota, valor_fora_nota, detalhe,
                                      saldo_anterior, saldo_anterior_nota, saldo_anterior_fora,
                                      valor_pago, valor_transportado, transportado_nota, transportado_fora,
                                      lancamentos_externos, nota_a_emitir)
    SELECT v_apuracao_id, 6, r.entregador_id, r.creditos, r.adiantamentos, r.debitos, r.remanescente,
           -- 0118 (2.bis): NULL passa a significar SO 'sem categorias_nota' (mesma semantica da previa).
           CASE WHEN v_config.categorias_nota IS NULL THEN NULL ELSE COALESCE(r.total_nota, 0) END,
           CASE WHEN v_config.categorias_nota IS NULL THEN NULL ELSE COALESCE(r.total_fora, 0) END,
           jsonb_build_object('solicitacoesPagas', r.solicitacoes_pagas),
           r.saldo_anterior, r.saldo_anterior_nota, r.saldo_anterior_fora,
           r.valor_pago, r.valor_transportado, r.transportado_nota, r.transportado_fora,
           (r.externos_credito - r.externos_deducao),
           r.nota_a_emitir
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

-- ═══ S5: ACL de toda funcao criada/recriada (a ACL antiga some no DROP; PUBLIC aparece como `=X/` no proacl).
REVOKE ALL ON FUNCTION hub_adiantamento_repasse_fechar(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse_fechar(date) TO authenticated;

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
    total_saldo_anterior numeric, total_a_pagar numeric, total_transportado numeric,
    valor_nota numeric, valor_fora_nota numeric,
    lancamentos_externos numeric, total_lancamentos_externos numeric,
    nota_a_emitir numeric
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
        -- 0100: a divisão da nota da PRÓPRIA semana, mesma regra do fechamento
        -- (0092/0098): NULA quando ninguém configurou `categorias_nota`.
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
    -- 0117 (FR-016/FR-017): lançamentos pagos por fora, agregados por entregador, as
    -- duas direções por FILTER. Tabela DIFERENTE de `debitos_cte` (FaturamentoLancamento):
    -- dupla contagem impossível por construção. Índice idx_lancamentoexterno_empresa_data_entregador.
    externos_cte AS (
        SELECT l.entregador_id,
               sum(l.valor) FILTER (WHERE t.sinal < 0) AS deducoes,
               sum(l.valor) FILTER (WHERE t.sinal > 0) AS creditos
        FROM "LancamentoExterno" l
        JOIN "LancamentoExternoTipo" t ON t.codigo = l.tipo
        WHERE l.id_empresa = ANY (v_escopo)
          AND l.data_pagamento BETWEEN p_periodo_inicio AND v_fim
        GROUP BY l.entregador_id
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
        SELECT i.entregador_id, i.valor_transportado, i.transportado_nota
        FROM "ApuracaoRepasseItem" i
        JOIN "ApuracaoRepasse" a ON a.id = i.apuracao_id
        WHERE a.id_empresa = ANY (v_escopo) AND a.periodo_inicio = p_periodo_inicio - 7
    ),
    linhas AS (
        SELECT
            e.id AS entregador_id, e.nome,
            COALESCE(c.total, 0) AS creditos,
            -- W1 (rodada 1 do code review, correção DELIBERADA de código da 0098/0100): a prévia
            -- deduzia só `PAGA`, o fechamento (`pagas`) deduz `PAGA` + `EXPORTADA` e o app
            -- (`hub_motorista_adiantamento_repasse`) também. Quem tinha adiantamento exportado e
            -- não pago via na prévia um remanescente MAIOR do que o fechamento congelava — e o
            -- operador confere a prévia antes de fechar. `em_processamento` segue como informação.
            CASE WHEN v_config.desconto_adiantamentos THEN COALESCE(a.pagos, 0) + COALESCE(a.processando, 0) ELSE 0 END AS adiantamentos,
            CASE WHEN v_config.desconto_debitos THEN COALESCE(d.total, 0) ELSE 0 END AS debitos,
            -- 0117: só a DEDUÇÃO passa pelo gate da flag (um crédito não é desconto, FR-022).
            CASE WHEN v_config.desconto_adiantamentos THEN COALESCE(x.deducoes, 0) ELSE 0 END AS externos_deducao,
            COALESCE(x.creditos, 0) AS externos_credito,
            COALESCE(a.processando, 0) > 0 AS em_processamento,
            COALESCE(sa.valor_transportado, 0) AS saldo_anterior,
            COALESCE(sa.transportado_nota, 0) AS saldo_anterior_nota,
            -- 0 (e não NULL) quando configurado mas sem crédito na semana;
            -- NULL só quando `categorias_nota` não está configurada.
            CASE WHEN v_config.categorias_nota IS NULL THEN NULL ELSE COALESCE(c.total_nota, 0) END AS valor_nota,
            CASE WHEN v_config.categorias_nota IS NULL THEN NULL ELSE COALESCE(c.total_fora, 0) END AS valor_fora_nota
        FROM "Entregador" e
        LEFT JOIN creditos c ON c.entregador_id = e.id
        LEFT JOIN debitos_cte d ON d.entregador_id = e.id
        LEFT JOIN adiant a ON a.entregador_id = e.id
        LEFT JOIN externos_cte x ON x.entregador_id = e.id
        LEFT JOIN saldo_ant sa ON sa.entregador_id = e.id
        WHERE e.id_empresa = ANY (v_escopo)
          AND (c.entregador_id IS NOT NULL OR d.entregador_id IS NOT NULL OR a.pagos IS NOT NULL
               OR a.processando IS NOT NULL OR x.entregador_id IS NOT NULL OR COALESCE(sa.valor_transportado, 0) > 0
               OR COALESCE(sa.transportado_nota, 0) <> 0)
          AND (p_busca IS NULL OR hub_normaliza_nome(e.nome) LIKE '%' || hub_normaliza_nome(p_busca) || '%')
    ),
    calc AS (
        SELECT *, (creditos - adiantamentos - debitos - externos_deducao + externos_credito) AS remanescente FROM linhas
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
    -- 0118: o MESMO liquido que o fechamento vai gravar (SC-002: a tela mostra o que a geracao usara).
    nota AS (
        SELECT p.*,
               CASE WHEN v_config.categorias_nota IS NULL THEN NULL
                    ELSE GREATEST(COALESCE(p.valor_nota, 0) + CASE WHEN p.remanescente < 0 THEN 0 ELSE p.saldo_anterior_nota END, 0)
                         - LEAST(p.externos_deducao, GREATEST(COALESCE(p.valor_nota, 0) + CASE WHEN p.remanescente < 0 THEN 0 ELSE p.saldo_anterior_nota END, 0))
               END AS nota_a_emitir
        FROM piso p
    ),
    filtradas AS (
        SELECT * FROM nota WHERE (NOT p_somente_negativos OR remanescente < 0)
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
           sum(f.saldo_anterior) OVER (), sum(f.valor_pago) OVER (), sum(f.valor_transportado) OVER (),
           f.valor_nota, f.valor_fora_nota,
           (f.externos_credito - f.externos_deducao), sum(f.externos_credito - f.externos_deducao) OVER (),
           f.nota_a_emitir
    FROM filtradas f
    ORDER BY f.nome
    OFFSET p_offset LIMIT p_limite;
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_repasse(date, text, boolean, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse(date, text, boolean, int, int) TO authenticated;

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
    total_saldo_anterior numeric, total_a_pagar numeric, total_transportado numeric,
    valor_nota numeric, valor_fora_nota numeric,
    lancamentos_externos numeric, total_lancamentos_externos numeric,
    nota_a_emitir numeric
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
               i.saldo_anterior, i.valor_pago, i.valor_transportado,
               CASE WHEN cfg.categorias_nota IS NULL THEN NULL ELSE COALESCE(i.valor_nota, 0) END AS valor_nota,
               CASE WHEN cfg.categorias_nota IS NULL THEN NULL ELSE COALESCE(i.valor_fora_nota, 0) END AS valor_fora_nota,
               i.lancamentos_externos,
               -- NULL em item anterior a 0118 e SINAL (o backend recusa com motivo proprio), nunca virar 0.
               CASE WHEN cfg.categorias_nota IS NULL THEN NULL ELSE i.nota_a_emitir END AS nota_a_emitir
        FROM "ApuracaoRepasseItem" i
        JOIN "ApuracaoRepasse" a ON a.id = i.apuracao_id
        LEFT JOIN "AdiantamentoConfiguracao" cfg ON cfg.id = a.configuracao_id
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
           (f.remanescente >= 0 AND f.valor_pago = 0 AND f.valor_transportado > 0),
           sum(f.saldo_anterior) OVER (), sum(f.valor_pago) OVER (), sum(f.valor_transportado) OVER (),
           f.valor_nota, f.valor_fora_nota,
           f.lancamentos_externos, sum(f.lancamentos_externos) OVER (),
           f.nota_a_emitir
    FROM filtradas f
    ORDER BY f.nome
    OFFSET p_offset LIMIT p_limite;
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_repasse_congelado(date, text, boolean, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse_congelado(date, text, boolean, int, int) TO authenticated;

-- ═══ S1: id pre-alocado (dec-038).
-- ATENCAO: em producao a EnvioMassa e a tabela LEGADA (coluna IDENTITY, sequencia sem ACL): o INSERT funciona porque o
-- default IDENTITY nao checa a ACL da sequencia, mas o nextval EXPLICITO de funcao INVOKER checa -> 42501. O grant da
-- 0033:197 so existe onde a tabela foi criada por ela (hub_homolog). Por isso o GRANT abaixo (aditivo, idempotente).
GRANT USAGE, SELECT ON SEQUENCE "EnvioMassa_id_seq" TO authenticated;
CREATE OR REPLACE FUNCTION hub_repasse_alocar_envio_id()
RETURNS bigint
LANGUAGE sql SECURITY INVOKER
SET search_path = public, pg_temp
AS $$ SELECT nextval('"EnvioMassa_id_seq"') $$;

REVOKE ALL ON FUNCTION hub_repasse_alocar_envio_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_repasse_alocar_envio_id() TO authenticated;

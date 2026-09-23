-- 0092 — F4 (parte B): a apuração congela a divisão da nota, e o hub passa a
-- registrar o movimento que gerou.
--
-- POR QUE CONGELAR, E NÃO RECALCULAR NA GERAÇÃO: a nota emitida tem de bater
-- com o que foi apurado e pago. Se a geração recalculasse a partir da config
-- vigente, qualquer mudança em `categorias_nota` entre fechar e gerar faria a
-- nota divergir do repasse — e o repasse já é congelado justamente por isso
-- (`ApuracaoRepasseItem`, 0086: "valores congelados não podem ser reescritos").
--
-- Medido em 2026-09-23: **0 apurações fechadas** em produção, 0 itens
-- congelados. Por isso não há backfill nem migração de histórico — a janela
-- para acertar o formato é agora.
--
-- `valor_nota`/`valor_fora_nota` nascem NULOS quando ninguém configurou
-- `categorias_nota`. A apuração fecha igual; quem recusa (com motivo) é a
-- geração do movimento, em vez de inventar uma divisão que ninguém pediu.
--
-- `hub_adiantamento_repasse_fechar` vem da **0088** (a versão viva — foi
-- redefinida em 0067 → 0082 → 0088; partir da 0067 desfaria duas rodadas de
-- correção). A única diferença é a divisão; o `creditos` e o `remanescente`
-- continuam idênticos.
--
-- ROLLBACK: infra/hub/testes/sql/0092-rollback.sql (restaura o `fechar` da
-- 0088 e preserva colunas e tabela — apagá-las perderia a trilha do que já foi
-- gerado na EnvioMassa, que é justamente o que impede gerar em duplicidade).

-- 1. A divisão congelada no item da apuração. Aditiva e nula.
ALTER TABLE "ApuracaoRepasseItem" ADD COLUMN IF NOT EXISTS valor_nota      numeric(12,2);
ALTER TABLE "ApuracaoRepasseItem" ADD COLUMN IF NOT EXISTS valor_fora_nota numeric(12,2);

COMMENT ON COLUMN "ApuracaoRepasseItem".valor_nota IS
  'F4: parte dos créditos que compõe a base da nota, congelada no fechamento. NULL = `categorias_nota` não estava configurada.';
COMMENT ON COLUMN "ApuracaoRepasseItem".valor_fora_nota IS
  'F4: parte dos créditos que NÃO entra na nota (gorjeta), congelada no fechamento.';

-- 2. A trilha do que o hub gerou. É ela que dá idempotência de verdade: a
--    guarda de "já tem movimento aberto" não basta, porque o movimento pode
--    ser fechado depois e a geração rodaria de novo para a mesma apuração.
CREATE TABLE IF NOT EXISTS "ApuracaoRepasseMovimento" (
    id              bigserial PRIMARY KEY,
    apuracao_id     bigint      NOT NULL REFERENCES "ApuracaoRepasse"(id),
    entregador_id   integer     NOT NULL REFERENCES "Entregador"(id),
    id_empresa      integer     NOT NULL,
    envio_massa_id  bigint      NOT NULL,
    valor           numeric(12,2) NOT NULL,
    gorjeta         numeric(12,2) NOT NULL,
    criado_em       timestamptz NOT NULL DEFAULT now(),
    criado_por      integer,
    CONSTRAINT apuracaorepassemovimento_uniq UNIQUE (apuracao_id, entregador_id)
);

COMMENT ON TABLE "ApuracaoRepasseMovimento" IS
  'F4: um registro por movimento que o hub criou na EnvioMassa. O UNIQUE (apuracao_id, entregador_id) é a idempotência: reexecutar a geração não duplica.';

CREATE INDEX IF NOT EXISTS idx_apuracaorepassemovimento_apuracao
    ON "ApuracaoRepasseMovimento" (apuracao_id);

ALTER TABLE "ApuracaoRepasseMovimento" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS apuracaorepassemovimento_select_por_escopo ON "ApuracaoRepasseMovimento";
CREATE POLICY apuracaorepassemovimento_select_por_escopo ON "ApuracaoRepasseMovimento"
    FOR SELECT USING (id_empresa = ANY (hub_jwt_escopo_ids()));

GRANT SELECT, INSERT ON "ApuracaoRepasseMovimento" TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "ApuracaoRepasseMovimento_id_seq" TO authenticated;

-- 3. O fechamento passa a congelar a divisão (corpo da 0088).
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
    v_motoristas  int;
    v_total       numeric(14,2);
    v_nao_pagos   int;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.pagamento_confirmar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

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

    BEGIN
        INSERT INTO "ApuracaoRepasse" (id_empresa, periodo_inicio, periodo_fim, data_repasse, configuracao_id, fechado_por)
        VALUES (6, p_periodo_inicio, v_fim, v_fim + v_config.apuracao_dias_ate_repasse, v_config.id, v_sub)
        RETURNING id INTO v_apuracao_id;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'APURACAO_JA_FECHADA';
    END;

    WITH creditos AS (
        -- F4: o mesmo `total` de antes, agora acompanhado da divisão que a nota
        -- precisa. Congelar aqui (e não recalcular na geração) é o ponto: se a
        -- configuração mudar entre fechar e gerar, a nota emitida ainda bate
        -- com o que foi apurado e pago.
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
        -- 13.7: alinhado a hub_adiantamento_repasse (0067:1841) e
        -- hub_adiantamento_repasse_motorista (0071:99,107) — mesma janela,
        -- mesmo critério de status.
        SELECT s.entregador_id, sum(s.valor_bruto) AS total, jsonb_agg(s.id) AS ids
        FROM "AdiantamentoSolicitacao" s
        WHERE s.id_empresa = ANY (v_escopo) AND s.status IN ('PAGA', 'EXPORTADA')
          AND s.data_producao BETWEEN p_periodo_inicio AND v_fim
        GROUP BY s.entregador_id
    ),
    linhas AS (
        SELECT
            e.id AS entregador_id,
            COALESCE(c.total, 0) AS creditos,
            c.total_nota, c.total_fora,
            CASE WHEN v_config.desconto_adiantamentos THEN COALESCE(p.total, 0) ELSE 0 END AS adiantamentos,
            CASE WHEN v_config.desconto_debitos THEN COALESCE(d.total, 0) ELSE 0 END AS debitos,
            COALESCE(p.ids, '[]'::jsonb) AS solicitacoes_pagas
        FROM "Entregador" e
        LEFT JOIN creditos c ON c.entregador_id = e.id
        LEFT JOIN debitos_cte d ON d.entregador_id = e.id
        LEFT JOIN pagas p ON p.entregador_id = e.id
        WHERE e.id_empresa = ANY (v_escopo)
          AND (c.entregador_id IS NOT NULL OR d.entregador_id IS NOT NULL OR p.entregador_id IS NOT NULL)
    )
    INSERT INTO "ApuracaoRepasseItem" (apuracao_id, id_empresa, entregador_id, creditos, adiantamentos, debitos, remanescente,
                                      valor_nota, valor_fora_nota, detalhe)
    SELECT v_apuracao_id, 6, l.entregador_id, l.creditos, l.adiantamentos, l.debitos,
           (l.creditos - l.adiantamentos - l.debitos),
           -- NULOS quando ninguém configurou `categorias_nota`: a apuração
           -- fecha igual, e a geração de movimento é que recusa (com motivo),
           -- em vez de inventar uma divisão que ninguém pediu.
           l.total_nota, l.total_fora,
           jsonb_build_object('solicitacoesPagas', l.solicitacoes_pagas)
    FROM linhas l;

    SELECT count(*), COALESCE(sum(i.remanescente), 0) INTO v_motoristas, v_total
    FROM "ApuracaoRepasseItem" i WHERE i.apuracao_id = v_apuracao_id;

    SELECT count(*) INTO v_nao_pagos
    FROM "AdiantamentoSolicitacao"
    WHERE id_empresa = ANY (v_escopo) AND data_producao BETWEEN p_periodo_inicio AND v_fim
      AND status NOT IN ('PAGA', 'CANCELADA');

    RETURN QUERY SELECT v_apuracao_id, v_motoristas, v_total::numeric, v_nao_pagos;
END;
$$;

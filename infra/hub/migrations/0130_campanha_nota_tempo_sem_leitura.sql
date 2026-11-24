-- 0130 — campanha de NOTA: motorista sem leitura de tempo NAO tem tempo 100%.
--
-- DEFEITO (0129, hub_campanha_recalcular_interno, CTE `leit`):
--   LEAST(online_epoch::numeric / NULLIF(periodo_epoch, 0)::numeric, 1)
-- LEAST ignora NULL no Postgres: LEAST(NULL, 1) = 1. Sem leitura de tempo em nenhum turno (soma NULL ou periodo 0)
-- o tempo virava 100%: passava no corte de tempo e levava a pontuacao maxima da parcela. Aceitacao e conclusao sem
-- leitura ja viram NULL (reprovam no corte, 0 na nota); o tempo agora segue a mesma regra do ramo do extrato.
--
-- MEDICAO: em producao (23/11) havia 0 turnos sem leitura de tempo em 30 dias — correcao DEFENSIVA, sem efeito
-- observavel hoje.
--
-- UNICA mudanca no corpo: a expressao de `tempo`. Idempotente (reaplicavel); assinatura e atributos iguais aos da 0129,
-- entao os privilegios sao preservados — o REVOKE ao final repete o estado, nao o altera.

CREATE OR REPLACE FUNCTION hub_campanha_recalcular_interno(p_id int)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_c     "Campanha";
    v_hoje  date := hub_hoje_sp();
    v_ate   date;
    v_t0    timestamptz := clock_timestamp();
    v_cont  jsonb;
    v_max   date;
    v_mesmo boolean;
BEGIN
    SELECT * INTO v_c FROM "Campanha" WHERE id = p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'CAMPANHA_NAO_ENCONTRADA' USING ERRCODE = 'P0002'; END IF;
    -- M2/B1: relida SOB o lock — cancelada/fechada (ou rascunho) entre a seleção e este ponto: sem efeito
    IF v_c.cancelada_em IS NOT NULL OR v_c.fechada_em IS NOT NULL OR v_c.lancada_em IS NULL THEN
        RETURN jsonb_build_object('ignorada', true);
    END IF;
    IF v_c.tipo = 'extrato' THEN
        RETURN hub_campanha_recalcular_extrato(v_c);
    END IF;
    v_ate := LEAST(v_c.data_fim, v_hoje);
    -- Último dia de dado da empresa (até data_fim). O robô importa 3x/dia com o MESMO dia: se `dados_ate`
    -- não andou, `posicao_anterior` é PRESERVADA (senão "subiu N posições desde ontem" zera na 2ª importação).
    SELECT max(mv.data_periodo) INTO v_max FROM mv_performance_dia mv
    WHERE mv.id_empresa = v_c.id_empresa AND mv.data_periodo <= v_c.data_fim;
    v_mesmo := v_c.dados_ate IS NOT NULL AND v_max IS NOT DISTINCT FROM v_c.dados_ate;

    WITH base AS (
        SELECT mv.entregador_id,
               count(*)::int                              AS turnos,
               sum(mv.corridas_ofertadas)::bigint         AS ofertadas,
               sum(mv.corridas_aceitas)::bigint           AS aceitas,
               sum(mv.corridas_completadas)::bigint       AS completadas,
               sum(mv.pedidos_concluidos)::bigint         AS pedidos,
               sum(mv.online_epoch)                       AS online_epoch,
               sum(mv.periodo_epoch)                      AS periodo_epoch
        FROM mv_performance_dia mv
        WHERE mv.id_empresa = v_c.id_empresa
          AND mv.data_periodo BETWEEN v_c.data_inicio AND v_ate
          AND (v_c.turnos IS NULL OR upper(btrim(mv.periodo)) = ANY (v_c.turnos))
          AND (v_c.pracas IS NULL OR (mv.entregador_id, mv.data_periodo, mv.periodo) IN (
                  SELECT pt.entregador_id, pt.data_periodo, pt.periodo
                  FROM "PerformanceTurno" pt
                  WHERE pt.id_empresa = v_c.id_empresa
                    AND pt.data_periodo BETWEEN v_c.data_inicio AND v_ate
                    AND upper(btrim(pt.subpraca)) = ANY (v_c.pracas)))
        GROUP BY mv.entregador_id
    ),
    ent AS (
        SELECT b.*, NULLIF(upper(btrim(e.dados_entrego_json -> 'informacoesEntrega' ->> 'modal')), '') AS modal
        FROM base b JOIN "Entregador" e ON e.id = b.entregador_id
    ),
    -- modal fora de `modais` não entra (nem é gravado); sem modal vira 'sem_modal'
    leit AS (
        SELECT ent.*,
               ent.aceitas::numeric / NULLIF(ent.ofertadas, 0)                       AS aceitacao,
               ent.completadas::numeric / NULLIF(ent.aceitas, 0)                     AS conclusao,
               CASE WHEN ent.online_epoch IS NULL OR ent.periodo_epoch IS NULL OR ent.periodo_epoch = 0 THEN NULL
                    ELSE LEAST(ent.online_epoch::numeric / ent.periodo_epoch::numeric, 1) END    AS tempo
        FROM ent
        WHERE v_c.modais IS NULL OR ent.modal IS NULL OR ent.modal = ANY (v_c.modais)
    ),
    cls AS (
        SELECT l.*,
               array_remove(ARRAY[
                   CASE WHEN v_c.peso_aceitacao > 0 AND v_c.corte_aceitacao IS NOT NULL
                             AND (l.aceitacao IS NULL OR l.aceitacao < v_c.corte_aceitacao) THEN 'aceitacao' END,
                   CASE WHEN v_c.peso_conclusao > 0 AND v_c.corte_conclusao IS NOT NULL
                             AND (l.conclusao IS NULL OR l.conclusao < v_c.corte_conclusao) THEN 'conclusao' END,
                   CASE WHEN v_c.peso_tempo > 0 AND v_c.corte_tempo IS NOT NULL
                             AND (l.tempo IS NULL OR l.tempo < v_c.corte_tempo) THEN 'tempo' END,
                   CASE WHEN v_c.peso_pedidos > 0 AND v_c.corte_pedidos IS NOT NULL
                             AND (l.pedidos IS NULL OR l.pedidos < v_c.corte_pedidos) THEN 'pedidos' END
               ], NULL) AS motivo
        FROM leit l
    ),
    cls2 AS (
        SELECT cls.*,
               CASE WHEN v_c.modais IS NOT NULL AND cls.modal IS NULL THEN 'sem_modal'
                    WHEN cls.turnos < v_c.min_turnos THEN 'sem_minimo'
                    WHEN cardinality(cls.motivo) > 0 THEN 'abaixo_corte'
                    ELSE 'classificado' END AS sit
        FROM cls
    ),
    cls3 AS (
        SELECT cls2.*,
               max(cls2.pedidos) FILTER (WHERE cls2.sit = 'classificado') OVER () AS maxped
        FROM cls2
    ),
    nt AS (
        -- nota (ou nota hipotética) com a MESMA fórmula; pedidos relativo ao líder dos classificados
        SELECT cls3.*,
               round((v_c.peso_aceitacao * COALESCE(cls3.aceitacao, 0) * 100
                    + v_c.peso_conclusao * COALESCE(cls3.conclusao, 0) * 100
                    + v_c.peso_tempo * COALESCE(cls3.tempo, 0) * 100
                    + v_c.peso_pedidos * CASE WHEN cls3.maxped > 0
                                              THEN LEAST(COALESCE(cls3.pedidos, 0)::numeric / cls3.maxped * 100, 100)
                                              ELSE 0 END
                    ) / 100.0, 2) AS nref
        FROM cls3
    ),
    rk AS (
        SELECT nt.entregador_id,
               CASE WHEN nt.sit = 'classificado' THEN
                   row_number() OVER (PARTITION BY nt.sit ORDER BY nt.nref DESC, nt.pedidos DESC NULLS LAST,
                                      nt.tempo DESC NULLS LAST, nt.entregador_id ASC)
               END AS posicao,
               -- 1 + quantos classificados têm nota ESTRITAMENTE maior (empates não empurram)
               CASE WHEN nt.sit = 'abaixo_corte' THEN
                   1 + (count(*) FILTER (WHERE nt.sit = 'classificado') OVER (ORDER BY nt.nref DESC)
                      - count(*) FILTER (WHERE nt.sit = 'classificado') OVER (PARTITION BY nt.nref))
               END AS poship
        FROM nt
        WHERE nt.sit IN ('classificado', 'abaixo_corte')
    ),
    fin AS (
        SELECT nt.*, rk.posicao, rk.poship
        FROM nt LEFT JOIN rk ON rk.entregador_id = nt.entregador_id
    ),
    up AS (
        INSERT INTO "CampanhaRanking" AS r (
            campanha_id, entregador_id, id_empresa, turnos, ofertadas, aceitas, completadas, pedidos,
            online_epoch, periodo_epoch, aceitacao, conclusao, tempo,
            nota, nota_hipotetica, posicao, posicao_hipotetica, situacao, motivo_corte, modal, atualizado_em)
        SELECT v_c.id, f.entregador_id, v_c.id_empresa, f.turnos, f.ofertadas, f.aceitas, f.completadas, f.pedidos,
               f.online_epoch, f.periodo_epoch, round(f.aceitacao, 6), round(f.conclusao, 6), round(f.tempo, 6),
               CASE WHEN f.sit = 'classificado' THEN f.nref END,
               CASE WHEN f.sit = 'abaixo_corte' THEN f.nref END,
               f.posicao, f.poship, f.sit, f.motivo, f.modal, now()
        FROM fin f
        ON CONFLICT (campanha_id, entregador_id) DO UPDATE SET
            id_empresa = EXCLUDED.id_empresa, turnos = EXCLUDED.turnos, ofertadas = EXCLUDED.ofertadas,
            aceitas = EXCLUDED.aceitas, completadas = EXCLUDED.completadas, pedidos = EXCLUDED.pedidos,
            online_epoch = EXCLUDED.online_epoch, periodo_epoch = EXCLUDED.periodo_epoch,
            aceitacao = EXCLUDED.aceitacao, conclusao = EXCLUDED.conclusao, tempo = EXCLUDED.tempo,
            nota = EXCLUDED.nota, nota_hipotetica = EXCLUDED.nota_hipotetica,
            posicao_anterior = CASE WHEN v_mesmo THEN r.posicao_anterior ELSE r.posicao END,
            posicao = EXCLUDED.posicao, posicao_hipotetica = EXCLUDED.posicao_hipotetica,
            situacao = EXCLUDED.situacao, motivo_corte = EXCLUDED.motivo_corte, modal = EXCLUDED.modal,
            atualizado_em = EXCLUDED.atualizado_em
        RETURNING 1
    ),
    del AS (
        DELETE FROM "CampanhaRanking" r
        WHERE r.campanha_id = v_c.id
          AND NOT EXISTS (SELECT 1 FROM fin f WHERE f.entregador_id = r.entregador_id)
        RETURNING 1
    )
    SELECT COALESCE(jsonb_object_agg(s.sit, s.n), '{}'::jsonb)
    INTO v_cont
    FROM (SELECT f.sit, count(*) AS n FROM fin f GROUP BY f.sit) s;

    UPDATE "Campanha" SET dados_ate = v_max WHERE id = v_c.id;

    RETURN jsonb_build_object(
        'classificados', COALESCE((v_cont ->> 'classificado')::int, 0),
        'abaixo_corte',  COALESCE((v_cont ->> 'abaixo_corte')::int, 0),
        'sem_minimo',    COALESCE((v_cont ->> 'sem_minimo')::int, 0),
        'sem_modal',     COALESCE((v_cont ->> 'sem_modal')::int, 0),
        'ms',            round(extract(epoch FROM clock_timestamp() - v_t0) * 1000)
    );
END;
$$;

-- Mesmo estado de privilegios da 0129 (interna: so as funcoes SECURITY DEFINER da familia a chamam).
REVOKE ALL ON FUNCTION hub_campanha_recalcular_interno(int) FROM PUBLIC;

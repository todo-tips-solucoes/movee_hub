-- 0129 — Campanha tipo "Melhor extrato" (soma do faturamento dos turnos validos).
--
-- Plano aprovado: docs/plans/campanhas-motorista/PLANO-MELHOR-EXTRATO.md (§4 modelo, §5 calculo, §7 pilares).
-- Aditiva e idempotente; NAO edita a 0127/0128 (as funcoes sao redefinidas aqui por CREATE OR REPLACE com o
-- corpo vivo + o ramo novo; o comportamento do tipo 'nota' e o mesmo — as linhas existentes sao todas 'nota').
-- O registro em "SchemaMigration" e feito pelo migrate.sh.
--
-- DESVIOS/ESCOLHAS DECLARADAS:
--  * hub_campanha_ranking MUDA o retorno (ganha turnos_validos, valor_centavos): DROP + CREATE (+GRANT).
--    Por isso a 0127 inteira nao pode mais ser reaplicada por cima (CREATE OR REPLACE nao muda retorno);
--    o migrate.sh nunca reaplica migration ja registrada.
--  * hub_campanha_fechar (manual) NAO muda: ja libera so em fim+3 para todos os tipos (0127).
--  * hub_campanha_turnos_extrato e hub_campanha_recalcular_extrato sao INTERNAS: recebem uma linha "Campanha"
--    montada por quem chama — sem REVOKE, um authenticated passaria uma linha forjada e leria outra empresa.
--  * hub_campanha_categorias() exige campanhas.gerir e filtra pela EMPRESA ATIVA (a 0087 so filtra pelo escopo).
--  * extrato: fecha automaticamente so em fim+3 E com faturamento importado a partir de fim+3 (E5); depois de fechada,
--    o faturamento com criado_em > fechada_em nao entra na lista de turnos; tem_valor = existe credito do turno em
--    QUALQUER categoria; familias aceitas apenas 'familia:promocao' e 'familia:missoes'.
--
-- ROLLBACK: nao ha campanha 'extrato' em producao antes do deploy; depois dele, reverter exige apagar/cancelar as
-- 'extrato' e reaplicar os corpos da 0127 (DROP de hub_campanha_ranking antes) + DROP das colunas novas.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Colunas e CHECKs
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE "Campanha" ADD COLUMN IF NOT EXISTS tipo            text NOT NULL DEFAULT 'nota';
ALTER TABLE "Campanha" ADD COLUMN IF NOT EXISTS categorias      text[] NULL;
ALTER TABLE "Campanha" ADD COLUMN IF NOT EXISTS min_turnos_base text NOT NULL DEFAULT 'trabalhados';

-- Categorias: 1..60 itens, cada 1..200 caracteres, sem NULL (nomes EXATOS da descricao ou tokens 'familia:*').
CREATE OR REPLACE FUNCTION hub_campanha_categorias_ok(p text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
    SELECT p IS NOT NULL AND cardinality(p) BETWEEN 1 AND 60
       AND NOT EXISTS (SELECT 1 FROM unnest(p) x WHERE x IS NULL OR char_length(x) NOT BETWEEN 1 AND 200);
$$;

ALTER TABLE "Campanha" DROP CONSTRAINT IF EXISTS campanha_tipo_chk;
ALTER TABLE "Campanha" ADD CONSTRAINT campanha_tipo_chk CHECK (tipo IN ('nota', 'extrato'));
ALTER TABLE "Campanha" DROP CONSTRAINT IF EXISTS campanha_min_turnos_base_chk;
ALTER TABLE "Campanha" ADD CONSTRAINT campanha_min_turnos_base_chk CHECK (
    min_turnos_base IN ('trabalhados', 'validos') AND (tipo = 'extrato' OR min_turnos_base = 'trabalhados'));
ALTER TABLE "Campanha" DROP CONSTRAINT IF EXISTS campanha_categorias_chk;
ALTER TABLE "Campanha" ADD CONSTRAINT campanha_categorias_chk CHECK (
    (tipo = 'nota' AND categorias IS NULL)
    OR (tipo = 'extrato' AND hub_campanha_categorias_ok(categorias)));

ALTER TABLE "Campanha" DROP CONSTRAINT IF EXISTS campanha_pesos_chk;
ALTER TABLE "Campanha" ADD CONSTRAINT campanha_pesos_chk CHECK (
    peso_aceitacao BETWEEN 0 AND 100 AND peso_conclusao BETWEEN 0 AND 100
    AND peso_tempo BETWEEN 0 AND 100 AND peso_pedidos BETWEEN 0 AND 100
    AND ((tipo = 'nota'    AND peso_aceitacao + peso_conclusao + peso_tempo + peso_pedidos = 100)
      OR (tipo = 'extrato' AND peso_aceitacao + peso_conclusao + peso_tempo + peso_pedidos = 0))
);
ALTER TABLE "Campanha" DROP CONSTRAINT IF EXISTS campanha_cortes_chk;
ALTER TABLE "Campanha" ADD CONSTRAINT campanha_cortes_chk CHECK (
    (corte_aceitacao IS NULL OR corte_aceitacao BETWEEN 0 AND 1)
    AND (corte_conclusao IS NULL OR corte_conclusao BETWEEN 0 AND 1)
    AND (corte_tempo IS NULL OR corte_tempo BETWEEN 0 AND 1)
    AND (corte_pedidos IS NULL OR corte_pedidos BETWEEN 1 AND 100000)
    AND ((tipo = 'nota'
          AND (corte_aceitacao IS NULL OR peso_aceitacao > 0)
          AND (corte_conclusao IS NULL OR peso_conclusao > 0)
          AND (corte_tempo IS NULL OR peso_tempo > 0)
          AND (corte_pedidos IS NULL OR peso_pedidos > 0))
      OR (tipo = 'extrato'
          AND num_nonnulls(corte_aceitacao, corte_conclusao, corte_tempo, corte_pedidos) >= 1))
);

-- Gatilho de imutabilidade (0127): NAO muda. As colunas novas nao estao em v_livres, logo nascem imutaveis
-- depois de lancar (to_jsonb(NEW) - v_livres compara tudo o que sobra). Provado no driver.

ALTER TABLE "CampanhaRanking" ADD COLUMN IF NOT EXISTS turnos_validos int NULL;
ALTER TABLE "CampanhaRanking" ADD COLUMN IF NOT EXISTS valor_centavos bigint NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Seletor de categorias (so as que tem turno: a Gorjeta nem aparece)
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION hub_campanha_categorias()
RETURNS TABLE (descricao text, lancamentos bigint, sem_motorista_identificado boolean, familia text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_emp int := NULLIF(hub_jwt_claims() ->> 'empresa_ativa', '')::int;
BEGIN
    PERFORM hub_campanha_autoriza(v_emp, 'campanhas.gerir');
    RETURN QUERY
    SELECT f.descricao, count(*), bool_or(f.entregador_id IS NULL),
           hub_adiantamento_categoria_familia(f.descricao)
    FROM "FaturamentoLancamento" f
    WHERE f.id_empresa = v_emp
      AND f.tipo = 'Credito'
      AND f.data_referencia >= (hub_hoje_sp() - 90)
    GROUP BY f.descricao
    HAVING count(f.entregador_id) > 0
       AND count(NULLIF(btrim(f.periodo), '')) > 0
    ORDER BY f.descricao;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 3. A regra do turno (UMA definicao; ranking e tela do motorista a usam)
-- ═══════════════════════════════════════════════════════════════════════
-- Filtros de periodo/turno/praca/modal IDENTICOS aos da nota (hub_campanha_recalcular_interno, 0127).
-- Valor = creditos das categorias da campanha, pre-agregados por (entregador, dia, turno) e juntados por
-- LEFT JOIN: sem linha de faturamento => tem_valor=false ("aguardando"), nunca "invalido".
-- Leitura ausente (NULL) nao cumpre criterio (fail-closed, como a P1 da nota).
--
-- FORMA (medida sob 900 mil turnos / 300 mil linhas de faturamento): a regra e uma funcao SQL INLINAVEL de argumentos
-- ESCALARES (sem CTE, sem sublink, sem SECURITY DEFINER) — o planner a embute na consulta de quem chama, com os valores
-- reais, e o recalculo agrega sem materializar 180 mil linhas (4 s via funcao plpgsql -> 0,5 s inline). Quem chama:
--   hub_campanha_turnos_extrato(p_c, p_entregador_id)  — assinatura do plano, por entregador (tela do motorista)
--   hub_campanha_recalcular_extrato(p_c)               — agrega por entregador e grava o ranking
-- Interna: sem EXECUTE para authenticated (receberia empresa arbitraria).
DROP FUNCTION IF EXISTS hub_campanha_turnos_extrato("Campanha", int);
DROP FUNCTION IF EXISTS hub_campanha_turnos_extrato_q(int, date, date, int, text[], text[], text[], text[], numeric, numeric, numeric, int);
CREATE OR REPLACE FUNCTION hub_campanha_turnos_extrato_q(
    v_emp int, v_ini date, v_fim date, v_ent int,
    v_turnos text[], v_pracas text[], v_modais text[], v_cats text[],
    c_ace numeric, c_con numeric, c_tem numeric, c_ped int, v_corte timestamptz
)
RETURNS TABLE (
    entregador_id int, data_periodo date, periodo text, modal text,
    ofertadas bigint, aceitas bigint, completadas bigint, online_epoch double precision, periodo_epoch double precision,
    aceitacao double precision, conclusao double precision, tempo double precision, pedidos bigint,
    valor_centavos bigint, tem_valor boolean, valido boolean, motivo text[]
)
LANGUAGE sql STABLE
AS $$
    SELECT t.entregador_id, t.data_periodo, t.periodo, t.modal,
           t.ofertadas, t.aceitas, t.completadas, t.online_epoch, t.periodo_epoch,
           t.aceitacao, t.conclusao, t.tempo, t.pedidos,
           t.valor_centavos, t.tem_valor,
           -- valido = nenhum criterio reprovou. Calculado das 4 flags (barato por turno); `motivo` (array) so e montado
           -- por quem o le — no recalculo a coluna nao e usada e o planner nem a avalia.
           NOT (t.r_ace OR t.r_con OR t.r_tem OR t.r_ped),
           array_remove(ARRAY[
               CASE WHEN t.r_ace THEN 'aceitacao' END, CASE WHEN t.r_con THEN 'conclusao' END,
               CASE WHEN t.r_tem THEN 'tempo' END,     CASE WHEN t.r_ped THEN 'pedidos' END], NULL)
    FROM (
        SELECT l.*,
               -- reprova = corte definido E (leitura ausente OU abaixo do corte)  [fail-closed]
               COALESCE(c_ace IS NOT NULL AND (l.aceitacao IS NULL OR l.aceitacao < c_ace), false) AS r_ace,
               COALESCE(c_con IS NOT NULL AND (l.conclusao IS NULL OR l.conclusao < c_con), false) AS r_con,
               COALESCE(c_tem IS NOT NULL AND (l.tempo IS NULL OR l.tempo < c_tem), false)         AS r_tem,
               COALESCE(c_ped IS NOT NULL AND (l.pedidos IS NULL OR l.pedidos < c_ped), false)     AS r_ped
        FROM (
            SELECT m.entregador_id, m.data_periodo, m.periodo, ent.modal,
                   m.corridas_ofertadas AS ofertadas, m.corridas_aceitas AS aceitas, m.corridas_completadas AS completadas,
                   m.online_epoch, m.periodo_epoch,
                   m.corridas_aceitas::float8 / NULLIF(m.corridas_ofertadas, 0)      AS aceitacao,
                   m.corridas_completadas::float8 / NULLIF(m.corridas_aceitas, 0)    AS conclusao,
                   -- LEAST ignora NULL (LEAST(NULL,1)=1): sem leitura de tempo o turno fica SEM leitura, nao 100%
                   CASE WHEN m.online_epoch IS NULL OR m.periodo_epoch IS NULL OR m.periodo_epoch = 0 THEN NULL
                        ELSE LEAST(m.online_epoch / m.periodo_epoch, 1) END           AS tempo,
                   m.pedidos_concluidos                                               AS pedidos,
                   COALESCE(fat.v, 0)                                                 AS valor_centavos,
                   fat.entregador_id IS NOT NULL                                      AS tem_valor
            FROM mv_performance_dia m
            -- modal UMA vez por entregador (OFFSET 0 impede o planner de reavaliar o jsonb por turno)
            JOIN (SELECT e.id, NULLIF(upper(btrim(e.dados_entrego_json -> 'informacoesEntrega' ->> 'modal')), '') AS modal
                  FROM "Entregador" e
                  WHERE e.id_empresa = v_emp AND (v_ent IS NULL OR e.id = v_ent)
                  OFFSET 0) ent ON ent.id = m.entregador_id
            LEFT JOIN (SELECT f.entregador_id, f.data_referencia, upper(btrim(f.periodo)) AS p,
                              -- valor = so as categorias da campanha; mas a linha existe com credito de QUALQUER categoria
                              -- (tem_valor: o faturamento do turno ja chegou; sem categoria marcada vale 0, nao "aguardando")
                              COALESCE(round(sum(f.valor) FILTER (WHERE hub_adiantamento_categoria_casa(f.descricao, v_cats)) * 100)::bigint, 0) AS v
                       FROM "FaturamentoLancamento" f
                       WHERE f.id_empresa = v_emp AND f.tipo = 'Credito' AND f.entregador_id IS NOT NULL
                         AND f.data_referencia BETWEEN v_ini AND v_fim
                         AND (v_ent IS NULL OR f.entregador_id = v_ent)
                         -- campanha fechada: o faturamento que chegou DEPOIS do fechamento nao entra (lista = ranking congelado)
                         AND (v_corte IS NULL OR f.criado_em <= v_corte)
                       GROUP BY f.entregador_id, f.data_referencia, upper(btrim(f.periodo))) fat
                   ON fat.entregador_id = m.entregador_id AND fat.data_referencia = m.data_periodo
                  AND fat.p = upper(btrim(m.periodo))
            WHERE m.id_empresa = v_emp
              AND m.data_periodo BETWEEN v_ini AND v_fim
              AND (v_ent IS NULL OR m.entregador_id = v_ent)
              AND (v_turnos IS NULL OR upper(btrim(m.periodo)) = ANY (v_turnos))
              -- praca = o turno existe numa praca selecionada (mesmo semi-join da nota; um LEFT JOIN com DISTINCT
              -- levou o planner a nested loop: 600 s sob 900 mil turnos). Sublink nao impede o embutimento (PG 13).
              AND (v_pracas IS NULL OR (m.entregador_id, m.data_periodo, m.periodo) IN (
                      SELECT pt.entregador_id, pt.data_periodo, pt.periodo FROM "PerformanceTurno" pt
                      WHERE pt.id_empresa = v_emp AND pt.data_periodo BETWEEN v_ini AND v_fim
                        AND (v_ent IS NULL OR pt.entregador_id = v_ent)
                        AND upper(btrim(pt.subpraca)) = ANY (v_pracas)))
              AND (v_modais IS NULL OR ent.modal IS NULL OR ent.modal = ANY (v_modais))
        ) l
    ) t;
$$;

-- Assinatura do plano: uma campanha + (opcional) um entregador.
CREATE OR REPLACE FUNCTION hub_campanha_turnos_extrato(p_c "Campanha", p_entregador_id int DEFAULT NULL)
RETURNS TABLE (
    entregador_id int, data_periodo date, periodo text, modal text,
    ofertadas bigint, aceitas bigint, completadas bigint, online_epoch double precision, periodo_epoch double precision,
    aceitacao double precision, conclusao double precision, tempo double precision, pedidos bigint,
    valor_centavos bigint, tem_valor boolean, valido boolean, motivo text[]
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
-- plano por chamada (valores reais): com plano generico a estimativa de linhas despenca e o planner escolhe merge join
SET plan_cache_mode = force_custom_plan
AS $$
#variable_conflict use_column
DECLARE
    v_emp    int    := p_c.id_empresa;
    v_ini    date   := p_c.data_inicio;
    v_fim    date   := LEAST(p_c.data_fim, hub_hoje_sp());
    v_turnos text[] := p_c.turnos;
    v_pracas text[] := p_c.pracas;
    v_modais text[] := p_c.modais;
    v_cats   text[] := p_c.categorias;
    c_ace    numeric := p_c.corte_aceitacao;
    c_con    numeric := p_c.corte_conclusao;
    c_tem    numeric := p_c.corte_tempo;
    c_ped    int     := p_c.corte_pedidos;
BEGIN
    RETURN QUERY
    SELECT * FROM hub_campanha_turnos_extrato_q(v_emp, v_ini, v_fim, p_entregador_id, v_turnos, v_pracas, v_modais,
                                                v_cats, c_ace, c_con, c_tem, c_ped, p_c.fechada_em);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Recalculo do extrato (chamado pelo ramo de hub_campanha_recalcular_interno, JA sob o lock da campanha)
-- ═══════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION hub_campanha_recalcular_extrato(p_c "Campanha")
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
SET plan_cache_mode = force_custom_plan
SET work_mem = '32MB'
AS $$
#variable_conflict use_column
DECLARE
    v_t0     timestamptz := clock_timestamp();
    v_max_mv date;
    v_max_ft date;
    v_max    date;
    v_mesmo  boolean;
    v_cont   jsonb;
    v_emp    int    := p_c.id_empresa;
    v_ini    date   := p_c.data_inicio;
    v_fim    date   := LEAST(p_c.data_fim, hub_hoje_sp());
    v_turnos text[] := p_c.turnos;
    v_pracas text[] := p_c.pracas;
    v_modais text[] := p_c.modais;
    v_cats   text[] := p_c.categorias;
    c_ace    numeric := p_c.corte_aceitacao;
    c_con    numeric := p_c.corte_conclusao;
    c_tem    numeric := p_c.corte_tempo;
    c_ped    int     := p_c.corte_pedidos;
    v_base   text    := p_c.min_turnos_base;
    v_minimo int     := p_c.min_turnos;
    v_cid    int     := p_c.id;
BEGIN
    -- "dados ate" so avanca quando AS DUAS fontes chegaram la (o valor vem do faturamento, 1 dia depois da Performance)
    SELECT max(mv.data_periodo) INTO v_max_mv FROM mv_performance_dia mv
    WHERE mv.id_empresa = v_emp AND mv.data_periodo <= p_c.data_fim;
    SELECT max(f.data_referencia) INTO v_max_ft FROM "FaturamentoLancamento" f
    WHERE f.id_empresa = v_emp AND f.data_referencia <= p_c.data_fim;
    v_max := CASE WHEN v_max_mv IS NULL OR v_max_ft IS NULL THEN NULL ELSE LEAST(v_max_mv, v_max_ft) END;
    v_mesmo := p_c.dados_ate IS NOT NULL AND v_max IS NOT DISTINCT FROM p_c.dados_ate;

    WITH base AS (
        SELECT t.entregador_id, min(t.modal) AS modal,
               count(*)::int                                                   AS turnos,
               (count(*) FILTER (WHERE t.valido))::int                         AS validos,
               COALESCE(sum(t.valor_centavos) FILTER (WHERE t.valido AND t.tem_valor), 0)::bigint AS valor,
               sum(t.ofertadas)::bigint AS ofertadas, sum(t.aceitas)::bigint AS aceitas,
               sum(t.completadas)::bigint AS completadas, sum(t.pedidos)::bigint AS pedidos,
               sum(t.online_epoch) AS online_epoch, sum(t.periodo_epoch) AS periodo_epoch
        FROM hub_campanha_turnos_extrato_q(v_emp, v_ini, v_fim, NULL, v_turnos, v_pracas, v_modais, v_cats,
                                           c_ace, c_con, c_tem, c_ped, p_c.fechada_em) t
        GROUP BY t.entregador_id
    ),
    cls AS (
        SELECT b.*,
               b.aceitas::numeric / NULLIF(b.ofertadas, 0)                                  AS aceitacao,
               b.completadas::numeric / NULLIF(b.aceitas, 0)                                AS conclusao,
               CASE WHEN b.online_epoch IS NULL OR b.periodo_epoch IS NULL OR b.periodo_epoch = 0 THEN NULL
                    ELSE LEAST(b.online_epoch::numeric / b.periodo_epoch::numeric, 1) END    AS tempo,
               CASE WHEN v_modais IS NOT NULL AND b.modal IS NULL THEN 'sem_modal'
                    WHEN (CASE WHEN v_base = 'validos' THEN b.validos ELSE b.turnos END) < v_minimo OR b.validos < 1 THEN 'sem_minimo'
                    ELSE 'classificado' END                                                  AS sit
        FROM base b
    ),
    rk AS (
        -- E6: valor desc, turnos validos desc, id do entregador (posicao sempre unica)
        SELECT c.entregador_id,
               row_number() OVER (ORDER BY c.valor DESC, c.validos DESC, c.entregador_id ASC) AS posicao
        FROM cls c WHERE c.sit = 'classificado'
    ),
    fin AS (
        SELECT c.*, rk.posicao FROM cls c LEFT JOIN rk ON rk.entregador_id = c.entregador_id
    ),
    up AS (
        INSERT INTO "CampanhaRanking" AS r (
            campanha_id, entregador_id, id_empresa, turnos, ofertadas, aceitas, completadas, pedidos,
            online_epoch, periodo_epoch, aceitacao, conclusao, tempo,
            nota, nota_hipotetica, posicao, posicao_hipotetica, situacao, motivo_corte, modal, atualizado_em,
            turnos_validos, valor_centavos)
        SELECT v_cid, f.entregador_id, v_emp, f.turnos, f.ofertadas, f.aceitas, f.completadas, f.pedidos,
               f.online_epoch, f.periodo_epoch, round(f.aceitacao, 6), round(f.conclusao, 6), round(f.tempo, 6),
               NULL, NULL, f.posicao, NULL, f.sit, '{}', f.modal, now(),
               f.validos, f.valor
        FROM fin f
        ON CONFLICT (campanha_id, entregador_id) DO UPDATE SET
            id_empresa = EXCLUDED.id_empresa, turnos = EXCLUDED.turnos, ofertadas = EXCLUDED.ofertadas,
            aceitas = EXCLUDED.aceitas, completadas = EXCLUDED.completadas, pedidos = EXCLUDED.pedidos,
            online_epoch = EXCLUDED.online_epoch, periodo_epoch = EXCLUDED.periodo_epoch,
            aceitacao = EXCLUDED.aceitacao, conclusao = EXCLUDED.conclusao, tempo = EXCLUDED.tempo,
            nota = NULL, nota_hipotetica = NULL,
            posicao_anterior = CASE WHEN v_mesmo THEN r.posicao_anterior ELSE r.posicao END,
            posicao = EXCLUDED.posicao, posicao_hipotetica = NULL,
            situacao = EXCLUDED.situacao, motivo_corte = '{}', modal = EXCLUDED.modal,
            atualizado_em = EXCLUDED.atualizado_em,
            turnos_validos = EXCLUDED.turnos_validos, valor_centavos = EXCLUDED.valor_centavos
        RETURNING 1
    ),
    del AS (
        DELETE FROM "CampanhaRanking" r
        WHERE r.campanha_id = v_cid
          AND NOT EXISTS (SELECT 1 FROM fin f WHERE f.entregador_id = r.entregador_id)
        RETURNING 1
    )
    SELECT COALESCE(jsonb_object_agg(s.sit, s.n), '{}'::jsonb)
    INTO v_cont
    FROM (SELECT f.sit, count(*) AS n FROM fin f GROUP BY f.sit) s;

    UPDATE "Campanha" SET dados_ate = v_max WHERE id = v_cid;

    RETURN jsonb_build_object(
        'classificados', COALESCE((v_cont ->> 'classificado')::int, 0),
        'abaixo_corte',  0,
        'sem_minimo',    COALESCE((v_cont ->> 'sem_minimo')::int, 0),
        'sem_modal',     COALESCE((v_cont ->> 'sem_modal')::int, 0),
        'ms',            round(extract(epoch FROM clock_timestamp() - v_t0) * 1000)
    );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. Funcoes da 0127 redefinidas (corpo vivo + o que o extrato acrescenta)
-- ═══════════════════════════════════════════════════════════════════════

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
               LEAST(ent.online_epoch::numeric / NULLIF(ent.periodo_epoch, 0)::numeric, 1)    AS tempo
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

-- Ranking do hub: ganha turnos_validos e valor_centavos (muda o retorno => DROP + CREATE).
DROP FUNCTION IF EXISTS hub_campanha_ranking(int, text, int, int);
CREATE FUNCTION hub_campanha_ranking(p_id int, p_situacao text, p_limite int, p_offset int)
RETURNS TABLE (
    posicao int, entregador_id int, nome text, modal text, situacao text, turnos int,
    aceitacao numeric, conclusao numeric, tempo numeric, pedidos bigint, nota numeric,
    nota_hipotetica numeric, posicao_hipotetica int, motivo_corte text[], posicao_anterior int,
    turnos_validos int, valor_centavos bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    c        "Campanha";
    v_lim    int := LEAST(GREATEST(COALESCE(p_limite, 50), 1), 200);
    v_off    int := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
    c := hub_campanha_carregar(p_id, 'campanhas.consultar', false);

    RETURN QUERY
    SELECT r.posicao, r.entregador_id, e.nome, r.modal, r.situacao, r.turnos,
           round(r.aceitacao, 4), round(r.conclusao, 4), round(r.tempo, 4), r.pedidos, r.nota,
           r.nota_hipotetica, r.posicao_hipotetica, r.motivo_corte, r.posicao_anterior,
           r.turnos_validos, r.valor_centavos
    FROM (
        SELECT * FROM "CampanhaRanking" x
        WHERE x.campanha_id = c.id AND (p_situacao IS NULL OR x.situacao = p_situacao)
        ORDER BY x.posicao NULLS LAST, x.nota_hipotetica DESC NULLS LAST, x.valor_centavos DESC NULLS LAST,
                 x.turnos DESC, x.entregador_id
        LIMIT v_lim OFFSET v_off
    ) r
    JOIN "Entregador" e ON e.id = r.entregador_id
    ORDER BY r.posicao NULLS LAST, r.nota_hipotetica DESC NULLS LAST, r.valor_centavos DESC NULLS LAST,
             r.turnos DESC, r.entregador_id;
END;
$$;

-- Turnos do PROPRIO motorista na campanha extrato (E7). Identidade so pela sessao (claim de CNPJ).
-- Devolve jsonb: [{data, turno, valido, temValor, valorCentavos, motivos:[{criterio, lido, minimo}]}]
-- (lido/minimo em fracao 0..1 para aceitacao/conclusao/tempo; inteiro para pedidos; lido null = sem leitura).
CREATE OR REPLACE FUNCTION hub_motorista_campanha_turnos(p_campanha_id int)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj text := hub_jwt_motorista_cnpj();
    c      "Campanha";
    v_ent  int;
BEGIN
    IF v_cnpj IS NULL THEN RAISE EXCEPTION 'SEM_VINCULO' USING ERRCODE = 'P0002'; END IF;
    SELECT * INTO c FROM "Campanha" WHERE id = p_campanha_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CAMPANHA_NAO_ENCONTRADA' USING ERRCODE = 'P0002'; END IF;
    SELECT e.id INTO v_ent FROM "Entregador" e JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
    WHERE cm.cnpj_prestador = v_cnpj AND e.id_empresa = c.id_empresa ORDER BY e.id LIMIT 1;
    IF v_ent IS NULL OR NOT hub_campanha_visivel(c, v_ent) THEN
        RAISE EXCEPTION 'CAMPANHA_NAO_ENCONTRADA' USING ERRCODE = 'P0002';
    END IF;
    IF c.tipo <> 'extrato' THEN RETURN '[]'::jsonb; END IF;

    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'data', s.data_periodo, 'turno', s.periodo, 'valido', s.valido,
                   'temValor', s.tem_valor, 'valorCentavos', s.valor_centavos,
                   'motivos', COALESCE((
                       SELECT jsonb_agg(jsonb_build_object(
                           'criterio', m,
                           'lido', CASE m WHEN 'aceitacao' THEN round(s.aceitacao::numeric, 4) WHEN 'conclusao' THEN round(s.conclusao::numeric, 4)
                                          WHEN 'tempo' THEN round(s.tempo::numeric, 4) ELSE s.pedidos END,
                           'minimo', CASE m WHEN 'aceitacao' THEN c.corte_aceitacao WHEN 'conclusao' THEN c.corte_conclusao
                                            WHEN 'tempo' THEN c.corte_tempo ELSE c.corte_pedidos END))
                       FROM unnest(s.motivo) m), '[]'::jsonb))
               ORDER BY s.data_periodo DESC, s.periodo)
        FROM (SELECT * FROM hub_campanha_turnos_extrato(c, v_ent) t
              ORDER BY t.data_periodo DESC, t.periodo LIMIT 300) s), '[]'::jsonb);
END;
$$;


CREATE OR REPLACE FUNCTION hub_campanhas_recalcular_ativas(p_id_empresa int)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_max    date;
    r        RECORD;
    v_recalc int := 0;
    v_fech   int := 0;
    v_erros  int[] := '{}';
    v_fat    boolean;
BEGIN
    IF p_id_empresa IS NULL OR NOT (p_id_empresa = ANY (hub_jwt_escopo_ids())) THEN
        RAISE EXCEPTION 'FORA_DE_ESCOPO' USING ERRCODE = '42501';
    END IF;

    SELECT max(mv.data_periodo) INTO v_max FROM mv_performance_dia mv WHERE mv.id_empresa = p_id_empresa;
    IF v_max IS NULL THEN
        RETURN jsonb_build_object('recalculadas', 0, 'fechadas', 0, 'erros', '[]'::jsonb);
    END IF;

    FOR r IN
        SELECT c.id, c.data_fim, c.tipo FROM "Campanha" c
        WHERE c.id_empresa = p_id_empresa AND c.lancada_em IS NOT NULL
          AND c.cancelada_em IS NULL AND c.fechada_em IS NULL AND c.data_inicio <= v_max
        ORDER BY c.id
    LOOP
        BEGIN
            -- M1: dado cobre E o ultimo dia ja passou. Extrato (0129): so em fim+3 E depois de entrar faturamento
            -- importado a partir de fim+3 (o robo importa Performance ANTES do faturamento na mesma rodada).
            v_fat := true;
            IF r.tipo = 'extrato' THEN
                SELECT EXISTS (SELECT 1 FROM "FaturamentoLancamento" f
                               WHERE f.id_empresa = p_id_empresa AND f.data_referencia >= r.data_fim - 31
                                 AND f.criado_em >= ((r.data_fim + 3)::timestamp AT TIME ZONE 'America/Sao_Paulo'))
                INTO v_fat;
            END IF;
            IF v_max >= r.data_fim AND v_fat AND hub_hoje_sp() >= r.data_fim + 1 + (r.tipo = 'extrato')::int * 2 THEN
                PERFORM hub_campanha_fechar_interno(r.id);
                v_fech := v_fech + 1;
            ELSE
                PERFORM hub_campanha_recalcular_interno(r.id);
                v_recalc := v_recalc + 1;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING 'hub_campanhas_recalcular_ativas: campanha % falhou: %', r.id, SQLERRM;
            v_erros := v_erros || r.id;
        END;
    END LOOP;

    RETURN jsonb_build_object('recalculadas', v_recalc, 'fechadas', v_fech, 'erros', to_jsonb(v_erros));
END;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_item_json(c "Campanha")
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', c.id, 'nome', c.nome, 'situacao', hub_campanha_situacao(c),
        'tipo', c.tipo, 'categorias', to_jsonb(c.categorias), 'minTurnosBase', c.min_turnos_base,
        'dataInicio', c.data_inicio, 'dataFim', c.data_fim,
        'pracas', to_jsonb(c.pracas), 'turnos', to_jsonb(c.turnos), 'modais', to_jsonb(c.modais),
        'minTurnos', c.min_turnos,
        'pesos', jsonb_build_object('aceitacao', c.peso_aceitacao, 'conclusao', c.peso_conclusao,
                                    'tempo', c.peso_tempo, 'pedidos', c.peso_pedidos),
        'contagem', jsonb_build_object(
            'classificado', COALESCE(k.classificado, 0), 'abaixoCorte', COALESCE(k.abaixo_corte, 0),
            'semMinimo', COALESCE(k.sem_minimo, 0), 'semModal', COALESCE(k.sem_modal, 0),
            -- totais do extrato (classificado + sem_minimo), para os cards do hub sem paginar o ranking
            'turnos', COALESCE(k.turnos, 0), 'turnosValidos', COALESCE(k.turnos_validos, 0),
            'valorCentavos', COALESCE(k.valor_centavos, 0)),
        'premiosPendentes', (
            SELECT count(*) FROM "CampanhaVencedor" v JOIN "CampanhaPremio" p ON p.id = v.premio_id
            WHERE v.campanha_id = c.id
              AND ((p.tipo = 'objeto' AND v.entregue_em IS NULL) OR (p.tipo = 'dinheiro' AND v.exportado_em IS NULL))),
        'dadosAte', c.dados_ate)
    FROM (
        SELECT count(*) FILTER (WHERE r.situacao = 'classificado')  AS classificado,
               count(*) FILTER (WHERE r.situacao = 'abaixo_corte')  AS abaixo_corte,
               count(*) FILTER (WHERE r.situacao = 'sem_minimo')    AS sem_minimo,
               count(*) FILTER (WHERE r.situacao = 'sem_modal')     AS sem_modal,
               sum(r.turnos)         FILTER (WHERE r.situacao IN ('classificado','sem_minimo')) AS turnos,
               sum(r.turnos_validos) FILTER (WHERE r.situacao IN ('classificado','sem_minimo')) AS turnos_validos,
               sum(r.valor_centavos) FILTER (WHERE r.situacao IN ('classificado','sem_minimo')) AS valor_centavos
        FROM "CampanhaRanking" r WHERE r.campanha_id = c.id
    ) k;
$$;

CREATE OR REPLACE FUNCTION hub_motorista_campanhas()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj text := hub_jwt_motorista_cnpj();
BEGIN
    IF v_cnpj IS NULL THEN RETURN '[]'::jsonb; END IF;

    RETURN COALESCE((
        SELECT jsonb_agg(s.item ORDER BY (s.fechada) , s.data_fim, s.id)
        FROM (
            SELECT DISTINCT ON (c.id) c.id, c.data_fim, (c.fechada_em IS NOT NULL) AS fechada,
                jsonb_build_object(
                    'id', c.id, 'nome', c.nome, 'tipo', c.tipo, 'situacao', hub_campanha_situacao(c),
                    'dataInicio', c.data_inicio, 'dataFim', c.data_fim,
                    'minhaPosicao', r.posicao,
                    'total', (SELECT count(*) FROM "CampanhaRanking" k WHERE k.campanha_id = c.id AND k.situacao = 'classificado'),
                    'minhaSituacao', r.situacao,
                    'naZonaPremio', COALESCE(r.posicao IS NOT NULL AND EXISTS (
                        SELECT 1 FROM "CampanhaPremio" p WHERE p.campanha_id = c.id AND r.posicao BETWEEN p.posicao_de AND p.posicao_ate), false)
                ) AS item
            FROM "ContaMotorista" cm
            JOIN "Entregador" e ON e.motorista_id = cm.id
            JOIN "Campanha" c ON c.id_empresa = e.id_empresa AND c.lancada_em IS NOT NULL
            LEFT JOIN "CampanhaRanking" r ON r.campanha_id = c.id AND r.entregador_id = e.id
            WHERE cm.cnpj_prestador = v_cnpj
              AND hub_campanha_visivel(c, e.id)
            ORDER BY c.id, e.id
        ) s
    ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION hub_motorista_campanha(p_id int)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj   text := hub_jwt_motorista_cnpj();
    c        "Campanha";
    v_ent    int;
    r        "CampanhaRanking";
    v_eu     jsonb := NULL;
    v_lider  bigint;
    v_acima  jsonb := NULL;
    v_prem   jsonb := NULL;
    v_pp     numeric;
BEGIN
    IF v_cnpj IS NULL THEN RAISE EXCEPTION 'SEM_VINCULO' USING ERRCODE = 'P0002'; END IF;
    IF NOT EXISTS (SELECT 1 FROM "ContaMotorista" cm JOIN "Entregador" e ON e.motorista_id = cm.id
                   WHERE cm.cnpj_prestador = v_cnpj) THEN
        RAISE EXCEPTION 'SEM_VINCULO' USING ERRCODE = 'P0002';
    END IF;

    SELECT * INTO c FROM "Campanha" WHERE id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'CAMPANHA_NAO_ENCONTRADA' USING ERRCODE = 'P0002'; END IF;
    SELECT e.id INTO v_ent FROM "Entregador" e JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
    WHERE cm.cnpj_prestador = v_cnpj AND e.id_empresa = c.id_empresa ORDER BY e.id LIMIT 1;
    -- outra empresa ou invisível: mesmo 404 (não revela existência)
    IF v_ent IS NULL OR NOT hub_campanha_visivel(c, v_ent) THEN
        RAISE EXCEPTION 'CAMPANHA_NAO_ENCONTRADA' USING ERRCODE = 'P0002';
    END IF;

    SELECT max(k.pedidos) INTO v_lider FROM "CampanhaRanking" k
    WHERE k.campanha_id = c.id AND k.situacao = 'classificado';

    SELECT * INTO r FROM "CampanhaRanking" k WHERE k.campanha_id = c.id AND k.entregador_id = v_ent;
    IF FOUND THEN
        IF r.situacao = 'classificado' THEN
            SELECT jsonb_build_object('nome', hub_nome_abreviado(e.nome), 'nota', k.nota) INTO v_acima
            FROM "CampanhaRanking" k JOIN "Entregador" e ON e.id = k.entregador_id
            WHERE k.campanha_id = c.id AND k.situacao = 'classificado' AND k.posicao = r.posicao - 1
              AND c.tipo = 'nota';
            SELECT jsonb_build_object('tipo', p.tipo, 'descricao', p.descricao) INTO v_prem
            FROM "CampanhaPremio" p WHERE p.campanha_id = c.id AND r.posicao BETWEEN p.posicao_de AND p.posicao_ate
            ORDER BY p.posicao_de LIMIT 1;
        END IF;
        v_pp := CASE WHEN COALESCE(v_lider, 0) > 0
                     THEN LEAST(COALESCE(r.pedidos, 0)::numeric / v_lider * 100, 100) ELSE 0 END;
        IF c.tipo = 'extrato' THEN
            -- E7: so o PROPRIO valor/turnos; nada de "faltam R$" nem do vizinho (X2)
            v_eu := jsonb_build_object(
                'situacao', r.situacao, 'posicao', r.posicao, 'posicaoAnterior', r.posicao_anterior,
                'turnos', r.turnos, 'turnosValidos', r.turnos_validos, 'valorCentavos', r.valor_centavos,
                'premio', v_prem,
                'entregueEm', (SELECT v.entregue_em FROM "CampanhaVencedor" v
                               WHERE v.campanha_id = c.id AND v.entregador_id = v_ent));
        ELSE
        v_eu := jsonb_build_object(
            'situacao', r.situacao, 'posicao', r.posicao, 'posicaoAnterior', r.posicao_anterior,
            'nota', r.nota, 'turnos', r.turnos,
            'leituras', jsonb_build_object('aceitacao', round(r.aceitacao, 4), 'conclusao', round(r.conclusao, 4),
                                           'tempo', round(r.tempo, 4), 'pedidos', r.pedidos),
            'notas', jsonb_build_object('aceitacao', round(COALESCE(r.aceitacao, 0) * 100, 2),
                                        'conclusao', round(COALESCE(r.conclusao, 0) * 100, 2),
                                        'tempo', round(COALESCE(r.tempo, 0) * 100, 2),
                                        'pedidos', round(v_pp, 2)),
            'motivoCorte', to_jsonb(r.motivo_corte),
            'notaHipotetica', r.nota_hipotetica, 'posicaoHipotetica', r.posicao_hipotetica,
            'ofertadas', r.ofertadas, 'aceitas', r.aceitas, 'completadas', r.completadas,
            'acima', v_acima, 'premio', v_prem,
            'entregueEm', (SELECT v.entregue_em FROM "CampanhaVencedor" v
                           WHERE v.campanha_id = c.id AND v.entregador_id = v_ent));
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'campanha', jsonb_build_object(
            'id', c.id, 'nome', c.nome, 'descricao', c.descricao, 'situacao', hub_campanha_situacao(c),
            'tipo', c.tipo, 'minTurnosBase', c.min_turnos_base,
            'dataInicio', c.data_inicio, 'dataFim', c.data_fim,
            'pracas', to_jsonb(c.pracas), 'turnos', to_jsonb(c.turnos), 'modais', to_jsonb(c.modais),
            'minTurnos', c.min_turnos,
            'pesos', jsonb_build_object('aceitacao', c.peso_aceitacao, 'conclusao', c.peso_conclusao,
                                        'tempo', c.peso_tempo, 'pedidos', c.peso_pedidos),
            'cortes', jsonb_build_object('aceitacao', c.corte_aceitacao, 'conclusao', c.corte_conclusao,
                                         'tempo', c.corte_tempo, 'pedidos', c.corte_pedidos),
            'dadosAte', c.dados_ate, 'fechadaEm', c.fechada_em),
        'premios', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', p.id, 'posicaoDe', p.posicao_de, 'posicaoAte', p.posicao_ate, 'tipo', p.tipo,
                'descricao', p.descricao, 'valorCentavos', CASE WHEN p.tipo = 'dinheiro' THEN p.valor_centavos END,
                'temFoto', p.foto IS NOT NULL) ORDER BY p.posicao_de)
            FROM "CampanhaPremio" p WHERE p.campanha_id = c.id), '[]'::jsonb),
        'eu', v_eu,
        'lider', CASE WHEN c.tipo = 'extrato' THEN NULL ELSE jsonb_build_object('pedidos', v_lider) END,
        -- só o nome ABREVIADO de terceiros sai daqui
        'top10', CASE WHEN c.tipo = 'extrato' THEN COALESCE((
            -- X2: terceiros so com posicao + nome abreviado. NENHUM campo de valor/nota/turnos/souEu.
            SELECT jsonb_agg(jsonb_build_object('posicao', t.posicao, 'nomeAbreviado', hub_nome_abreviado(t.nome)) ORDER BY t.posicao)
            FROM (SELECT k.posicao, e.nome
                  FROM "CampanhaRanking" k JOIN "Entregador" e ON e.id = k.entregador_id
                  WHERE k.campanha_id = c.id AND k.situacao = 'classificado' AND k.posicao <= 10
                  ORDER BY k.posicao) t), '[]'::jsonb)
        ELSE COALESCE((
            SELECT jsonb_agg(jsonb_build_object('posicao', t.posicao, 'nome', hub_nome_abreviado(t.nome),
                                                'nota', t.nota, 'souEu', t.entregador_id = v_ent) ORDER BY t.posicao)
            FROM (SELECT k.posicao, k.nota, k.entregador_id, e.nome
                  FROM "CampanhaRanking" k JOIN "Entregador" e ON e.id = k.entregador_id
                  WHERE k.campanha_id = c.id AND k.situacao = 'classificado' AND k.posicao <= 10
                  ORDER BY k.posicao) t), '[]'::jsonb) END,
        'totalClassificados', (SELECT count(*) FROM "CampanhaRanking" k
                               WHERE k.campanha_id = c.id AND k.situacao = 'classificado'));
END;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_salvar(p_id_empresa int, p_id int, p_dados jsonb)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sub        int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    c            "Campanha";
    v_id         int;
    v_nome       text := btrim(p_dados ->> 'nome');
    v_desc       text := COALESCE(btrim(p_dados ->> 'descricao'), '');
    v_ini        date;
    v_fim        date;
    v_pracas     text[];
    v_turnos     text[];
    v_modais     text[];
    v_min        int;
    v_pa         int; v_pc int; v_pt int; v_pp int;
    v_ca         numeric(5,4); v_cc numeric(5,4); v_ct numeric(5,4);
    v_cp         int;
    v_avisar     boolean;
    v_premios    jsonb := p_dados -> 'premios';
    v_tipo       text;
    v_cats       text[];
    v_base       text;
BEGIN
    PERFORM hub_campanha_autoriza(p_id_empresa, 'campanhas.gerir');

    IF p_id IS NOT NULL THEN
        c := hub_campanha_carregar(p_id, 'campanhas.gerir', true);
        IF c.id_empresa <> p_id_empresa THEN
            RAISE EXCEPTION 'CAMPANHA_NAO_ENCONTRADA' USING ERRCODE = 'P0002';
        END IF;
        IF c.lancada_em IS NOT NULL THEN
            RAISE EXCEPTION 'CAMPANHA_IMUTAVEL' USING ERRCODE = '55000';
        END IF;
    END IF;

    IF v_nome IS NULL OR char_length(v_nome) NOT BETWEEN 3 AND 120 THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'nome';
    END IF;
    IF char_length(v_desc) > 1000 THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'descricao';
    END IF;

    BEGIN
        v_ini := (p_dados ->> 'dataInicio')::date;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'dataInicio';
    END;
    BEGIN
        v_fim := (p_dados ->> 'dataFim')::date;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'dataFim';
    END;
    IF v_ini IS NULL THEN RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'dataInicio'; END IF;
    IF v_fim IS NULL OR v_fim < v_ini OR v_fim - v_ini > 91 THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'dataFim';
    END IF;

    v_pracas := hub_campanha_lista_json(p_dados -> 'pracas', 'pracas');
    v_turnos := hub_campanha_lista_json(p_dados -> 'turnos', 'turnos');
    v_modais := hub_campanha_lista_json(p_dados -> 'modais', 'modais');

    v_min := hub_campanha_num(p_dados -> 'minTurnos', 'minTurnos', 1, 200, true, true);

    -- 0129: tipo / categorias (nomes EXATOS ou tokens de familia: sem upper/btrim) / base do minimo
    v_tipo := COALESCE(p_dados ->> 'tipo', 'nota');
    IF (p_dados -> 'tipo' IS NOT NULL AND jsonb_typeof(p_dados -> 'tipo') NOT IN ('string', 'null'))
       OR v_tipo NOT IN ('nota', 'extrato') THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'tipo';
    END IF;
    v_base := COALESCE(p_dados ->> 'minTurnosBase', 'trabalhados');
    IF (p_dados -> 'minTurnosBase' IS NOT NULL AND jsonb_typeof(p_dados -> 'minTurnosBase') NOT IN ('string', 'null'))
       OR v_base NOT IN ('trabalhados', 'validos') THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'minTurnosBase';
    END IF;
    IF p_dados -> 'categorias' IS NOT NULL AND jsonb_typeof(p_dados -> 'categorias') <> 'null' THEN
        IF jsonb_typeof(p_dados -> 'categorias') <> 'array'
           OR jsonb_array_length(p_dados -> 'categorias') > 60
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_dados -> 'categorias') e WHERE jsonb_typeof(e) <> 'string') THEN
            RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'categorias';
        END IF;
        SELECT array_agg(DISTINCT x ORDER BY x) INTO v_cats FROM jsonb_array_elements_text(p_dados -> 'categorias') x;
        IF v_cats IS NOT NULL AND (NOT hub_campanha_categorias_ok(v_cats)
           OR EXISTS (SELECT 1 FROM unnest(v_cats) y WHERE y LIKE 'familia:%' AND y NOT IN ('familia:promocao', 'familia:missoes'))) THEN
            RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'categorias';
        END IF;
    END IF;
    IF v_tipo = 'nota' AND v_cats IS NOT NULL THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'categorias';
    END IF;
    IF v_tipo = 'nota' AND v_base <> 'trabalhados' THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'minTurnosBase';
    END IF;
    IF v_tipo = 'extrato' AND v_cats IS NULL THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'categorias';
    END IF;

    -- pesos: ausente = 0; fora de 0..100 ou soma ≠ 100 -> PESOS_INVALIDOS
    v_pa := COALESCE(hub_campanha_num(p_dados #> '{pesos,aceitacao}', 'pesos.aceitacao', -1000, 1000, true, false), 0);
    v_pc := COALESCE(hub_campanha_num(p_dados #> '{pesos,conclusao}', 'pesos.conclusao', -1000, 1000, true, false), 0);
    v_pt := COALESCE(hub_campanha_num(p_dados #> '{pesos,tempo}',     'pesos.tempo',     -1000, 1000, true, false), 0);
    v_pp := COALESCE(hub_campanha_num(p_dados #> '{pesos,pedidos}',   'pesos.pedidos',   -1000, 1000, true, false), 0);
    IF LEAST(v_pa, v_pc, v_pt, v_pp) < 0 OR GREATEST(v_pa, v_pc, v_pt, v_pp) > 100 OR v_pa + v_pc + v_pt + v_pp <> 100 * (v_tipo = 'nota')::int THEN
        RAISE EXCEPTION 'PESOS_INVALIDOS' USING ERRCODE = '22023';
    END IF;

    v_ca := round(hub_campanha_num(p_dados #> '{cortes,aceitacao}', 'cortes.aceitacao', 0, 1, false, false), 4);
    v_cc := round(hub_campanha_num(p_dados #> '{cortes,conclusao}', 'cortes.conclusao', 0, 1, false, false), 4);
    v_ct := round(hub_campanha_num(p_dados #> '{cortes,tempo}',     'cortes.tempo',     0, 1, false, false), 4);
    v_cp := hub_campanha_num(p_dados #> '{cortes,pedidos}', 'cortes.pedidos', 1, 100000, true, false);
    IF v_tipo = 'nota' AND ((v_ca IS NOT NULL AND v_pa = 0) OR (v_cc IS NOT NULL AND v_pc = 0)
       OR (v_ct IS NOT NULL AND v_pt = 0) OR (v_cp IS NOT NULL AND v_pp = 0)) THEN
        RAISE EXCEPTION 'CORTE_SEM_PESO' USING ERRCODE = '22023';
    END IF;
    -- extrato: o criterio do turno e o proprio corte; sem nenhum, todo turno valeria
    IF v_tipo = 'extrato' AND num_nonnulls(v_ca, v_cc, v_ct, v_cp) = 0 THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'cortes';
    END IF;

    IF jsonb_typeof(p_dados -> 'avisar') = 'boolean' THEN v_avisar := (p_dados ->> 'avisar')::boolean;
    ELSIF p_dados -> 'avisar' IS NULL THEN v_avisar := true;
    ELSE RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'avisar';
    END IF;

    -- prêmios: 1..20 faixas
    IF v_premios IS NULL OR jsonb_typeof(v_premios) <> 'array' OR jsonb_array_length(v_premios) NOT BETWEEN 1 AND 20 THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'premios';
    END IF;
    BEGIN
        PERFORM 1 FROM hub_campanha_premios_in(v_premios);
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'premios';
    END;
    IF EXISTS (
        SELECT 1 FROM hub_campanha_premios_in(v_premios)
        WHERE de IS NULL OR ate IS NULL OR de < 1 OR de > ate OR ate > 500
           OR tipo IS NULL OR tipo NOT IN ('objeto', 'dinheiro')
           OR descricao IS NULL OR char_length(descricao) NOT BETWEEN 1 AND 200
           OR (tipo = 'dinheiro' AND (valor IS NULL OR valor NOT BETWEEN 1 AND 500000))
           OR (tipo = 'objeto' AND valor IS NOT NULL AND valor < 0)
    ) THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'premios';
    END IF;
    IF EXISTS (SELECT 1 FROM hub_campanha_premios_in(v_premios) i WHERE i.id IS NOT NULL GROUP BY i.id HAVING count(*) > 1) THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'premios';   -- B6: id de prêmio repetido
    END IF;
    IF EXISTS (
        SELECT 1 FROM hub_campanha_premios_in(v_premios) a JOIN hub_campanha_premios_in(v_premios) b
          ON a.n < b.n AND a.de <= b.ate AND b.de <= a.ate
    ) THEN
        RAISE EXCEPTION 'FAIXAS_SOBREPOSTAS' USING ERRCODE = '22023';
    END IF;

    IF p_id IS NULL THEN
        INSERT INTO "Campanha" (
            id_empresa, nome, descricao, data_inicio, data_fim, pracas, turnos, modais, min_turnos,
            peso_aceitacao, peso_conclusao, peso_tempo, peso_pedidos,
            corte_aceitacao, corte_conclusao, corte_tempo, corte_pedidos, avisar, criada_por,
            tipo, categorias, min_turnos_base)
        VALUES (
            p_id_empresa, v_nome, v_desc, v_ini, v_fim, v_pracas, v_turnos, v_modais, v_min,
            v_pa, v_pc, v_pt, v_pp, v_ca, v_cc, v_ct, v_cp, v_avisar, v_sub,
            v_tipo, v_cats, v_base)
        RETURNING id INTO v_id;
    ELSE
        v_id := p_id;
        UPDATE "Campanha" SET
            nome = v_nome, descricao = v_desc, data_inicio = v_ini, data_fim = v_fim,
            pracas = v_pracas, turnos = v_turnos, modais = v_modais, min_turnos = v_min,
            peso_aceitacao = v_pa, peso_conclusao = v_pc, peso_tempo = v_pt, peso_pedidos = v_pp,
            corte_aceitacao = v_ca, corte_conclusao = v_cc, corte_tempo = v_ct, corte_pedidos = v_cp,
            avisar = v_avisar, tipo = v_tipo, categorias = v_cats, min_turnos_base = v_base
        WHERE id = v_id;
    END IF;

    -- Prêmios: o que veio com `id` desta campanha é ATUALIZADO (a foto sobrevive); o resto é criado;
    -- o que ficou de fora é apagado. Rascunho apenas (o gatilho recusa qualquer escrita após lançar).
    DELETE FROM "CampanhaPremio" pr
    WHERE pr.campanha_id = v_id AND pr.id NOT IN (SELECT i.id FROM hub_campanha_premios_in(v_premios) i WHERE i.id IS NOT NULL);
    UPDATE "CampanhaPremio" pr SET posicao_de = i.de, posicao_ate = i.ate, tipo = i.tipo,
           descricao = i.descricao, valor_centavos = i.valor
    FROM hub_campanha_premios_in(v_premios) i
    WHERE pr.campanha_id = v_id AND pr.id = i.id;
    INSERT INTO "CampanhaPremio" (campanha_id, id_empresa, posicao_de, posicao_ate, tipo, descricao, valor_centavos)
    SELECT v_id, p_id_empresa, i.de, i.ate, i.tipo, i.descricao, i.valor
    FROM hub_campanha_premios_in(v_premios) i
    WHERE i.id IS NULL OR NOT EXISTS (SELECT 1 FROM "CampanhaPremio" pr WHERE pr.id = i.id AND pr.campanha_id = v_id);

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_lancar(p_id int)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    c        "Campanha";
    v_sub    int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_op     jsonb;
    v_ativas int;
BEGIN
    c := hub_campanha_carregar(p_id, 'campanhas.gerir', true);
    IF hub_campanha_situacao(c) <> 'rascunho' THEN
        RAISE EXCEPTION 'CAMPANHA_SITUACAO_INVALIDA' USING ERRCODE = '55000';
    END IF;
    IF c.data_inicio < hub_hoje_sp() THEN
        RAISE EXCEPTION 'INICIO_NO_PASSADO' USING ERRCODE = '22023';
    END IF;

    -- prêmios: 1..20, sem sobreposição (revalida; o rascunho só passa pela RPC de salvar, mas é barato)
    IF NOT EXISTS (SELECT 1 FROM "CampanhaPremio" WHERE campanha_id = c.id) THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'premios';
    END IF;
    IF EXISTS (SELECT 1 FROM "CampanhaPremio" a JOIN "CampanhaPremio" b
                 ON a.campanha_id = b.campanha_id AND a.id < b.id AND a.posicao_de <= b.posicao_ate AND b.posicao_de <= a.posicao_ate
               WHERE a.campanha_id = c.id) THEN
        RAISE EXCEPTION 'FAIXAS_SOBREPOSTAS' USING ERRCODE = '22023';
    END IF;

    v_op := hub_campanha_opcoes(c.id_empresa, c.pracas, c.turnos, c.modais);
    IF (c.pracas IS NOT NULL AND EXISTS (
            SELECT 1 FROM unnest(c.pracas) x WHERE NOT (v_op -> 'pracas') ? x))
       OR (c.turnos IS NOT NULL AND EXISTS (
            SELECT 1 FROM unnest(c.turnos) x WHERE NOT (v_op -> 'turnos') ? x))
       OR (c.modais IS NOT NULL AND EXISTS (
            SELECT 1 FROM unnest(c.modais) x WHERE NOT (v_op -> 'modais') ? x)) THEN
        RAISE EXCEPTION 'OPCAO_DESCONHECIDA' USING ERRCODE = '22023';
    END IF;

    -- 0129: categoria salva que nao existe mais (nem nome com turno, nem token de familia conhecido) -> recusa
    IF c.tipo = 'extrato' AND EXISTS (
        SELECT 1 FROM unnest(c.categorias) x
        WHERE x NOT IN ('familia:promocao', 'familia:missoes')
          AND (x LIKE 'familia:%'
               OR NOT EXISTS (SELECT 1 FROM hub_campanha_categorias() k WHERE k.descricao = x))) THEN
        RAISE EXCEPTION 'OPCAO_DESCONHECIDA' USING ERRCODE = '22023';
    END IF;

    IF c.peso_pedidos > 0 AND COALESCE((v_op ->> 'cobertura_pedidos')::numeric, 0) < 0.95 THEN
        RAISE EXCEPTION 'PEDIDOS_SEM_COBERTURA' USING ERRCODE = '22023';
    END IF;

    -- teto A11 (serializado por entidade para duas chamadas simultâneas não furarem o teto)
    PERFORM pg_advisory_xact_lock(c.id_empresa, hashtext('hub_campanha_teto'));
    SELECT count(*) INTO v_ativas FROM "Campanha"
    WHERE id_empresa = c.id_empresa AND lancada_em IS NOT NULL AND cancelada_em IS NULL AND fechada_em IS NULL;
    IF v_ativas >= 10 THEN
        RAISE EXCEPTION 'TETO_CAMPANHAS_ATIVAS' USING ERRCODE = '55000';
    END IF;

    UPDATE "Campanha" SET lancada_em = now(), lancada_por = v_sub WHERE id = c.id;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. EXECUTE
-- ═══════════════════════════════════════════════════════════════════════
-- Internas: so as funcoes SECURITY DEFINER da propria familia as chamam.
REVOKE ALL ON FUNCTION hub_campanha_turnos_extrato_q(int, date, date, int, text[], text[], text[], text[], numeric, numeric, numeric, int, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION hub_campanha_turnos_extrato("Campanha", int)    FROM PUBLIC;
REVOKE ALL ON FUNCTION hub_campanha_recalcular_extrato("Campanha")     FROM PUBLIC;
REVOKE ALL ON FUNCTION hub_campanha_recalcular_interno(int)            FROM PUBLIC;
REVOKE ALL ON FUNCTION hub_campanha_item_json("Campanha")              FROM PUBLIC;

DO $$
DECLARE
    f text;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'hub_campanha_categorias()',
        'hub_campanha_ranking(int, text, int, int)',
        'hub_motorista_campanha_turnos(int)',
        'hub_campanha_salvar(int, int, jsonb)',
        'hub_campanha_lancar(int)',
        'hub_campanhas_recalcular_ativas(int)',
        'hub_motorista_campanhas()',
        'hub_motorista_campanha(int)'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
    END LOOP;
END
$$;

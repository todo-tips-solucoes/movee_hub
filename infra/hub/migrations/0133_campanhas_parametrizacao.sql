-- 0133 — Campanhas: parametrizacao (subpraca efetiva no hub inteiro, descarte de turno curto, nota com categorias,
-- lancar campanha em andamento, data do premio).
--
-- Plano aprovado (26/11/2026): docs/plans/campanhas-motorista/PLANO-AJUSTES-PARAMETRIZACAO.md (D1-D5).
-- Aditiva e idempotente. NAO edita migration aplicada: toda funcao e redefinida por CREATE OR REPLACE (ou DROP + CREATE
-- quando o retorno/assinatura muda) a partir do corpo VIVO — a ULTIMA redefinicao da serie, nunca a primeira:
--   hub_campanha_salvar / _visivel / _item_json / hub_motorista_campanha / trigger de imutabilidade  <- 0132
--   hub_campanha_lancar                                                                              <- 0131
--   hub_campanha_recalcular_interno                                                                  <- 0130
--   hub_campanha_turnos_extrato(_q) / recalcular_extrato / hub_campanhas_recalcular_ativas           <- 0129
--   hub_campanha_opcoes / _publico_cnpjs / _vencedores / _marcar_exportado / trigger do vencedor     <- 0127
--   hub_performance_(totais|agrupado|turnos) / hub_faturamento_(totais|agrupado) / view de areas     <- dump do banco com 0001..0132
-- O registro em "SchemaMigration" e feito pelo migrate.sh.
--
-- O QUE MUDA
--  D1  hub_subpraca_efetiva(subpraca, origem) = COALESCE(NULLIF(btrim(subpraca),''), NULLIF(btrim(origem),''), 'LIVRE'),
--      IMMUTABLE, UMA definicao. Usada em: opcoes/alcance/publico/visibilidade/semi-join da nota e do extrato (campanhas
--      seguem aplicando upper() por cima), filtro p_subpraca e `pracas` das RPCs de performance, filtro p_subpraca das RPCs
--      de faturamento e a view hub_areas_por_entregador. Indices de expressao em "PerformanceTurno" (exato e upper) e
--      "FaturamentoLancamento". Funcoes de coluna computada `subpraca_efetiva` (PostgREST) para o backend filtrar/exibir o valor
--      ja resolvido nas listas de tabela. Valor nao vazio nunca muda: campanha lancada com praca gravada continua casando.
--  D2  "Campanha".descarte_turno_min smallint NOT NULL DEFAULT 5 (0..60; 0 desliga). ADD COLUMN ... DEFAULT = sem UPDATE
--      (o gatilho de imutabilidade nao dispara): as lancadas ganham 5 min por decisao do operador. Predicado UNICO
--      hub_campanha_turno_descartado(), reusado pela nota e pelo extrato.
--  D3  A nota aceita `categorias` (CHECK relaxado). Com categorias o turno so conta se ha credito que casa
--      (hub_campanha_creditos_turno, a MESMA funcao do extrato) e a nota herda fechamento fim+3 com faturamento importado desde
--      fim+3 e o congelamento criado_em <= fechada_em. O fechamento MANUAL ja era fim+3 para todos os tipos (0127).
--  D4  Lancar recusa so data_fim < hoje (FIM_NO_PASSADO) e, com data_inicio <= hoje, recalcula na mesma transacao.
--  D5  "Campanha".data_premio (livre no gatilho) + hub_campanha_alterar_data_premio; "CampanhaVencedor".data_pagamento
--      (livre no gatilho do vencedor) gravada na 1a exportacao = GREATEST(data_premio, hoje SP).
--
-- ATENCOES
--  * hub_campanha_turnos_extrato_q GANHA um argumento (v_desc): a assinatura de 13 argumentos e DROPada.
--  * hub_campanha_vencedores GANHA a coluna data_pagamento: DROP + CREATE (+GRANT).
--  * 2 indices novos em "PerformanceTurno" e 1 em "FaturamentoLancamento": CREATE INDEX comum (bloqueia escrita durante a
--    construcao). Janela curta (milhares de linhas em producao). Os indices por coluna crua (0020/0051) ficam: nao removidos aqui.
--  * hub_campanha_marcar_exportado segue usando o dia SP de now() (nao hub_hoje_sp()), como a 0127.
--
-- ROLLBACK (so apos nenhuma campanha usar os recursos novos): reaplicar os corpos de 0127/0129/0130/0131/0132/dump das funcoes
-- acima (DROP de hub_campanha_turnos_extrato_q de 14 args e hub_campanha_creditos_turno antes) e, se preciso, DROP das colunas
-- descarte_turno_min/data_premio/data_pagamento e dos indices/funcoes novos. Nenhum dado de produto depende deles antes do uso.

-- migrate.sh aplica a migration em transacao unica: nao esperar lock indefinidamente (DDL em tabelas de fato).
SET LOCAL lock_timeout = '10s';

-- ═══════════════════════════════════════════════════════════════════════
-- 1. D1 — subpraca efetiva (UMA regra, no banco)
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION hub_subpraca_efetiva(p_subpraca text, p_origem text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
    SELECT COALESCE(NULLIF(btrim(p_subpraca), ''), NULLIF(btrim(p_origem), ''), 'LIVRE');
$$;
REVOKE ALL ON FUNCTION hub_subpraca_efetiva(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_subpraca_efetiva(text, text) TO authenticated;

-- Colunas computadas do PostgREST (`?subpraca_efetiva=eq.X`, `select=subpraca_efetiva`): o backend recebe o valor JA resolvido,
-- sem reimplementar a regra. SQL inlinavel => o planner casa a expressao com os indices abaixo.
CREATE OR REPLACE FUNCTION subpraca_efetiva(pt "PerformanceTurno")
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$ SELECT hub_subpraca_efetiva(pt.subpraca, pt.origem); $$;
CREATE OR REPLACE FUNCTION subpraca_efetiva(fl "FaturamentoLancamento")
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$ SELECT hub_subpraca_efetiva(fl.subpraca, fl.origem); $$;
REVOKE ALL ON FUNCTION subpraca_efetiva("PerformanceTurno") FROM PUBLIC;
REVOKE ALL ON FUNCTION subpraca_efetiva("FaturamentoLancamento") FROM PUBLIC;
GRANT EXECUTE ON FUNCTION subpraca_efetiva("PerformanceTurno") TO authenticated;
GRANT EXECUTE ON FUNCTION subpraca_efetiva("FaturamentoLancamento") TO authenticated;

-- (id_empresa, efetiva, data): filtro EXATO das RPCs de performance e varredura "solta" das opcoes.
CREATE INDEX IF NOT EXISTS idx_performance_empresa_subpraca_ef_data
    ON "PerformanceTurno" (id_empresa, hub_subpraca_efetiva(subpraca, origem), data_periodo);
-- (id_empresa, upper(efetiva), data): o semi-join das campanhas (que comparam upper) — um EXISTS correlacionado ja foi
-- medido a 1,5 s e recusado (0127); o indice exato acima nao serve a comparacao por upper().
CREATE INDEX IF NOT EXISTS idx_performance_empresa_subpraca_efu_data
    ON "PerformanceTurno" (id_empresa, upper(hub_subpraca_efetiva(subpraca, origem)), data_periodo);
-- filtro p_subpraca do fallback das RPCs de faturamento (por data_lancamento, 0055)
CREATE INDEX IF NOT EXISTS idx_faturamento_empresa_subpraca_ef_data
    ON "FaturamentoLancamento" (id_empresa, hub_subpraca_efetiva(subpraca, origem), data_lancamento);

-- View de areas (Faturamento + Performance + motoristas): a coluna continua `subpraca`, agora o valor efetivo (nunca NULL).
-- SEGURANCA: a view roda com o privilegio do DONO (sem security_invoker no PG13) e as tabelas nao tem FORCE RLS; o predicado de escopo
-- (o mesmo das policies de 0015) fica na propria view, senao `authenticated` leria subpracas de outras empresas.
CREATE OR REPLACE VIEW hub_areas_por_entregador AS
SELECT entregador_id, subpraca, MAX(data) AS data_mais_recente
FROM (
    SELECT entregador_id, hub_subpraca_efetiva(subpraca, origem) AS subpraca, data_referencia AS data
    FROM "FaturamentoLancamento"
    WHERE id_empresa = ANY (hub_jwt_escopo_ids())
    UNION ALL
    SELECT entregador_id, hub_subpraca_efetiva(subpraca, origem) AS subpraca, data_periodo AS data
    FROM "PerformanceTurno"
    WHERE id_empresa = ANY (hub_jwt_escopo_ids())
) t
GROUP BY entregador_id, subpraca;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Colunas e CHECKs (D2, D3, D5)
-- ═══════════════════════════════════════════════════════════════════════

-- D2: DEFAULT 5 preenche as lancadas em andamento sem UPDATE (fast default, nenhum gatilho de linha dispara).
-- Campanhas JA FECHADAS antes da 0133 foram apuradas SEM descarte: ficam com 0 (desligado) para que a lista de turnos do app
-- (recalculada na leitura) nao divirja do ranking congelado. MIGRACAO DE DADO CONTROLADA: o gatilho de imutabilidade e desabilitado
-- SO para este UPDATE e reabilitado em seguida, dentro do bloco e apenas na 1a aplicacao (coluna ainda inexistente): reaplicar a
-- migration depois nunca zera campanhas fechadas depois da 0133.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = 'public' AND table_name = 'Campanha' AND column_name = 'descarte_turno_min') THEN
        ALTER TABLE "Campanha" ADD COLUMN descarte_turno_min smallint NOT NULL DEFAULT 5;
        ALTER TABLE "Campanha" DISABLE TRIGGER trg_campanha_imutavel;
        UPDATE "Campanha" SET descarte_turno_min = 0 WHERE fechada_em IS NOT NULL;
        ALTER TABLE "Campanha" ENABLE TRIGGER trg_campanha_imutavel;
    END IF;
END
$$;
ALTER TABLE "Campanha" DROP CONSTRAINT IF EXISTS campanha_descarte_chk;
ALTER TABLE "Campanha" ADD CONSTRAINT campanha_descarte_chk CHECK (descarte_turno_min BETWEEN 0 AND 60);

-- D5
ALTER TABLE "Campanha" ADD COLUMN IF NOT EXISTS data_premio date NULL;
ALTER TABLE "CampanhaVencedor" ADD COLUMN IF NOT EXISTS data_pagamento date NULL;

-- D3: a nota aceita categorias (nomes exatos ou tokens de familia, mesma validacao do extrato); NULL = todos os turnos.
ALTER TABLE "Campanha" DROP CONSTRAINT IF EXISTS campanha_categorias_chk;
ALTER TABLE "Campanha" ADD CONSTRAINT campanha_categorias_chk CHECK (
    (tipo = 'nota' AND (categorias IS NULL OR hub_campanha_categorias_ok(categorias)))
    OR (tipo = 'extrato' AND hub_campanha_categorias_ok(categorias)));

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Gatilhos de imutabilidade (data_premio e data_pagamento passam a ser livres)
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION hub_campanha_imutavel_trg()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    -- única coisa que pode mudar depois de lançada; coluna nova nasce IMUTÁVEL por padrão
    -- 0133: data_premio (D5) é livre; descarte_turno_min NÃO é (congela ao lançar como as demais regras)
    v_livres text[] := ARRAY['cancelada_por', 'cancelada_em', 'motivo_cancelamento', 'fechada_em',
                             'dados_ate', 'aviso_inicio_em', 'aviso_fim_em',
                             'visivel_app',
                             'data_premio'];
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.lancada_em IS NOT NULL THEN
            RAISE EXCEPTION 'CAMPANHA_IMUTAVEL' USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.lancada_em IS NULL THEN
        RETURN NEW;   -- rascunho: livre
    END IF;

    -- cancelada/fechada não voltam atrás
    IF (OLD.cancelada_em IS NOT NULL AND NEW.cancelada_em IS DISTINCT FROM OLD.cancelada_em)
       OR (OLD.fechada_em IS NOT NULL AND NEW.fechada_em IS DISTINCT FROM OLD.fechada_em) THEN
        RAISE EXCEPTION 'CAMPANHA_IMUTAVEL' USING ERRCODE = '55000';
    END IF;

    IF (to_jsonb(NEW) - v_livres) IS DISTINCT FROM (to_jsonb(OLD) - v_livres) THEN
        RAISE EXCEPTION 'CAMPANHA_IMUTAVEL' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_vencedor_trg()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_livres text[] := ARRAY['entregue_em', 'entregue_por', 'observacao', 'exportado_em',
                             'data_pagamento'];
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'CAMPANHA_IMUTAVEL' USING ERRCODE = '55000';
    END IF;
    IF (to_jsonb(NEW) - v_livres) IS DISTINCT FROM (to_jsonb(OLD) - v_livres) THEN
        RAISE EXCEPTION 'CAMPANHA_IMUTAVEL' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. D2 — predicado UNICO de descarte do turno curto zerado
-- ═══════════════════════════════════════════════════════════════════════
-- Descartado <=> online lido E <= min*60 s E nenhuma corrida ofertada/aceita/completada E nenhum pedido.
-- Online sem leitura (NULL) NAO descarta (conservador); min = 0 desliga. NUNCA devolve NULL (usado em NOT ... no WHERE).
-- Nota e extrato a usam sobre as colunas de mv_performance_dia (o grao do turno).
CREATE OR REPLACE FUNCTION hub_campanha_turno_descartado(
    p_online double precision, p_ofertadas bigint, p_aceitas bigint, p_completadas bigint, p_pedidos bigint, p_min int
)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
    SELECT COALESCE(
        p_min > 0 AND p_online IS NOT NULL AND p_online <= p_min * 60
        AND p_ofertadas = 0 AND p_aceitas = 0 AND p_completadas = 0 AND COALESCE(p_pedidos, 0) = 0,
        false);
$$;
REVOKE ALL ON FUNCTION hub_campanha_turno_descartado(double precision, bigint, bigint, bigint, bigint, int) FROM PUBLIC;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. Creditos do faturamento por (entregador, dia, turno) — UMA definicao (extrato: valor; nota com categorias: casamento)
-- ═══════════════════════════════════════════════════════════════════════
-- v    = soma dos creditos das categorias da campanha (centavos); a linha existe com credito de QUALQUER categoria
-- casa = existe credito de categoria que casa (hub_adiantamento_categoria_casa)
-- v_corte: campanha fechada => o faturamento que chegou DEPOIS do fechamento nao entra (lista = ranking congelado)
-- SQL inlinavel (STABLE, sem SECURITY DEFINER): o planner a embute com os valores reais. Interna (sem EXECUTE publico).
CREATE OR REPLACE FUNCTION hub_campanha_creditos_turno(
    v_emp int, v_ini date, v_fim date, v_ent int, v_cats text[], v_corte timestamptz
)
RETURNS TABLE (entregador_id int, data_referencia date, p text, v bigint, casa boolean)
LANGUAGE sql STABLE
AS $$
    SELECT f.entregador_id, f.data_referencia, upper(btrim(f.periodo)),
           COALESCE(round(sum(f.valor) FILTER (WHERE hub_adiantamento_categoria_casa(f.descricao, v_cats)) * 100)::bigint, 0),
           COALESCE(bool_or(hub_adiantamento_categoria_casa(f.descricao, v_cats)), false)
    FROM "FaturamentoLancamento" f
    WHERE f.id_empresa = v_emp AND f.tipo = 'Credito' AND f.entregador_id IS NOT NULL
      AND f.data_referencia BETWEEN v_ini AND v_fim
      AND (v_ent IS NULL OR f.entregador_id = v_ent)
      AND (v_corte IS NULL OR f.criado_em <= v_corte)
    GROUP BY f.entregador_id, f.data_referencia, upper(btrim(f.periodo));
$$;
REVOKE ALL ON FUNCTION hub_campanha_creditos_turno(int, date, date, int, text[], timestamptz) FROM PUBLIC;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. Extrato (corpo VIVO da 0129 + subpraca efetiva + descarte + creditos reaproveitados)
-- ═══════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS hub_campanha_turnos_extrato("Campanha", int);
DROP FUNCTION IF EXISTS hub_campanha_turnos_extrato_q(int, date, date, int, text[], text[], text[], text[], numeric, numeric, numeric, int, timestamptz);
CREATE OR REPLACE FUNCTION hub_campanha_turnos_extrato_q(
    v_emp int, v_ini date, v_fim date, v_ent int,
    v_turnos text[], v_pracas text[], v_modais text[], v_cats text[],
    c_ace numeric, c_con numeric, c_tem numeric, c_ped int, v_corte timestamptz, v_desc int
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
            -- valor/tem_valor vem de hub_campanha_creditos_turno (a mesma funcao que a nota com categorias usa)
            LEFT JOIN hub_campanha_creditos_turno(v_emp, v_ini, v_fim, v_ent, v_cats, v_corte) fat
                   ON fat.entregador_id = m.entregador_id AND fat.data_referencia = m.data_periodo
                  AND fat.p = upper(btrim(m.periodo))
            WHERE m.id_empresa = v_emp
              AND m.data_periodo BETWEEN v_ini AND v_fim
              AND (v_ent IS NULL OR m.entregador_id = v_ent)
              -- D2: turno curto zerado nao entra (nem indicador, nem turnos trabalhados/validos, nem valor)
              AND NOT hub_campanha_turno_descartado(m.online_epoch, m.corridas_ofertadas, m.corridas_aceitas,
                                                    m.corridas_completadas, m.pedidos_concluidos, v_desc)
              AND (v_turnos IS NULL OR upper(btrim(m.periodo)) = ANY (v_turnos))
              -- praca = o turno existe numa praca selecionada (mesmo semi-join da nota; um LEFT JOIN com DISTINCT
              -- levou o planner a nested loop: 600 s sob 900 mil turnos). Sublink nao impede o embutimento (PG 13).
              AND (v_pracas IS NULL OR (m.entregador_id, m.data_periodo, m.periodo) IN (
                      SELECT pt.entregador_id, pt.data_periodo, pt.periodo FROM "PerformanceTurno" pt
                      WHERE pt.id_empresa = v_emp AND pt.data_periodo BETWEEN v_ini AND v_fim
                        AND (v_ent IS NULL OR pt.entregador_id = v_ent)
                        AND upper(hub_subpraca_efetiva(pt.subpraca, pt.origem)) = ANY (v_pracas)))
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
    v_desc   int     := p_c.descarte_turno_min;
BEGIN
    RETURN QUERY
    SELECT * FROM hub_campanha_turnos_extrato_q(v_emp, v_ini, v_fim, p_entregador_id, v_turnos, v_pracas, v_modais,
                                                v_cats, c_ace, c_con, c_tem, c_ped, p_c.fechada_em, v_desc);
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
    v_desc   int     := p_c.descarte_turno_min;
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
                                           c_ace, c_con, c_tem, c_ped, p_c.fechada_em, v_desc) t
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
-- 7. Nota (corpo VIVO da 0130 + subpraca efetiva + descarte + categorias)
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION hub_campanha_recalcular_interno(p_id int)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
-- plano por chamada (valores reais): o semi-join de praca/categorias depende deles
SET plan_cache_mode = force_custom_plan
AS $$
#variable_conflict use_column
DECLARE
    v_c     "Campanha";
    v_hoje  date := hub_hoje_sp();
    v_ate   date;
    v_t0    timestamptz := clock_timestamp();
    v_cont  jsonb;
    v_max   date;
    v_max_ft date;
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
    -- D3: com categorias o valor vem do faturamento (1 dia depois da Performance): "dados ate" so avanca quando as DUAS fontes chegaram
    IF v_c.categorias IS NOT NULL THEN
        SELECT max(f.data_referencia) INTO v_max_ft FROM "FaturamentoLancamento" f
        WHERE f.id_empresa = v_c.id_empresa AND f.data_referencia <= v_c.data_fim;
        v_max := CASE WHEN v_max IS NULL OR v_max_ft IS NULL THEN NULL ELSE LEAST(v_max, v_max_ft) END;
    END IF;
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
                    AND upper(hub_subpraca_efetiva(pt.subpraca, pt.origem)) = ANY (v_c.pracas)))
          -- D2: turno curto zerado nao entra em indicador nem em turnos trabalhados (predicado unico, o mesmo do extrato)
          AND NOT hub_campanha_turno_descartado(mv.online_epoch, mv.corridas_ofertadas, mv.corridas_aceitas,
                                                mv.corridas_completadas, mv.pedidos_concluidos, v_c.descarte_turno_min)
          -- D3: com categorias o turno so conta se ha credito que casa (mesma funcao do extrato)
          AND (v_c.categorias IS NULL OR (mv.entregador_id, mv.data_periodo, upper(btrim(mv.periodo))) IN (
                  SELECT cr.entregador_id, cr.data_referencia, cr.p
                  FROM hub_campanha_creditos_turno(v_c.id_empresa, v_c.data_inicio, v_ate, NULL, v_c.categorias, v_c.fechada_em) cr
                  WHERE cr.casa))
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
        SELECT c.id, c.data_fim, c.tipo, c.categorias FROM "Campanha" c
        WHERE c.id_empresa = p_id_empresa AND c.lancada_em IS NOT NULL
          AND c.cancelada_em IS NULL AND c.fechada_em IS NULL AND c.data_inicio <= v_max
        ORDER BY c.id
    LOOP
        BEGIN
            -- M1: dado cobre E o ultimo dia ja passou. Extrato (0129) e nota COM categorias (0133): so em fim+3 E depois de entrar faturamento
            -- importado a partir de fim+3 (o robo importa Performance ANTES do faturamento na mesma rodada).
            v_fat := true;
            IF r.tipo = 'extrato' OR r.categorias IS NOT NULL THEN
                SELECT EXISTS (SELECT 1 FROM "FaturamentoLancamento" f
                               WHERE f.id_empresa = p_id_empresa AND f.data_referencia >= r.data_fim - 31
                                 AND f.criado_em >= ((r.data_fim + 3)::timestamp AT TIME ZONE 'America/Sao_Paulo'))
                INTO v_fat;
            END IF;
            IF v_max >= r.data_fim AND v_fat AND hub_hoje_sp() >= r.data_fim + 1 + (r.tipo = 'extrato' OR r.categorias IS NOT NULL)::int * 2 THEN
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

-- ═══════════════════════════════════════════════════════════════════════
-- 8. Opcoes, publico e visibilidade (subpraca efetiva)
-- ═══════════════════════════════════════════════════════════════════════

-- Opções do formulário + cobertura de pedidos + alcance (CONTRATOS §6).
CREATE OR REPLACE FUNCTION hub_campanha_opcoes(p_id_empresa int, p_pracas text[], p_turnos text[], p_modais text[])
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_hoje    date := hub_hoje_sp();
    v_d30     date := hub_hoje_sp() - 29;
    v_d60     date := hub_hoje_sp() - 59;
    v_pracas  text[] := (SELECT array_agg(DISTINCT upper(btrim(x))) FROM unnest(p_pracas) x);
    v_turnos  text[] := (SELECT array_agg(DISTINCT upper(btrim(x))) FROM unnest(p_turnos) x);
    v_modais  text[] := (SELECT array_agg(DISTINCT upper(btrim(x))) FROM unnest(p_modais) x);
    j_pracas  jsonb;
    j_turnos  jsonb;
    j_modais  jsonb;
    v_cob     numeric;
    v_rodaram int;
    v_sem     int;
BEGIN
    PERFORM hub_campanha_autoriza(p_id_empresa, 'campanhas.gerir');

    -- Distintos por varredura de indice "solta" (CTE recursiva: 1 sonda por valor distinto, nao por linha) sobre os indices que
    -- ja existem: (id_empresa, upper(subpraca efetiva), data_periodo) em "PerformanceTurno" (0133) e (id_empresa, periodo, ...)
    -- na MV; a janela de 60 dias e uma sonda EXISTS por valor. 0133: praca = subpraca efetiva (vazia -> origem -> 'LIVRE'),
    -- ja canonica (upper); nunca NULL, entao nao ha "linha sem praca" que suma das opcoes.
    SELECT COALESCE(jsonb_agg(s.x ORDER BY s.x), '[]'::jsonb) INTO j_pracas
    FROM (
        SELECT r.v AS x
        FROM (
            WITH RECURSIVE r AS (
                (SELECT upper(hub_subpraca_efetiva(pt.subpraca, pt.origem)) AS v FROM "PerformanceTurno" pt
                 WHERE pt.id_empresa = p_id_empresa
                 ORDER BY upper(hub_subpraca_efetiva(pt.subpraca, pt.origem)) LIMIT 1)
                UNION ALL
                SELECT (SELECT upper(hub_subpraca_efetiva(pt.subpraca, pt.origem)) FROM "PerformanceTurno" pt
                        WHERE pt.id_empresa = p_id_empresa AND upper(hub_subpraca_efetiva(pt.subpraca, pt.origem)) > r.v
                        ORDER BY upper(hub_subpraca_efetiva(pt.subpraca, pt.origem)) LIMIT 1)
                FROM r WHERE r.v IS NOT NULL
            )
            SELECT r.v FROM r WHERE r.v IS NOT NULL
        ) r
        WHERE EXISTS (SELECT 1 FROM "PerformanceTurno" pt
                      WHERE pt.id_empresa = p_id_empresa AND upper(hub_subpraca_efetiva(pt.subpraca, pt.origem)) = r.v
                        AND pt.data_periodo >= v_d60)
    ) s;

    SELECT COALESCE(jsonb_agg(s.x ORDER BY s.x), '[]'::jsonb) INTO j_turnos
    FROM (
        SELECT DISTINCT upper(btrim(r.v)) AS x
        FROM (
            WITH RECURSIVE r AS (
                (SELECT mv.periodo AS v FROM mv_performance_dia mv
                 WHERE mv.id_empresa = p_id_empresa ORDER BY mv.periodo LIMIT 1)
                UNION ALL
                SELECT (SELECT mv.periodo FROM mv_performance_dia mv
                        WHERE mv.id_empresa = p_id_empresa AND mv.periodo > r.v ORDER BY mv.periodo LIMIT 1)
                FROM r WHERE r.v IS NOT NULL
            )
            SELECT r.v FROM r WHERE r.v IS NOT NULL
        ) r
        WHERE NULLIF(btrim(r.v), '') IS NOT NULL
          AND EXISTS (SELECT 1 FROM mv_performance_dia mv
                      WHERE mv.id_empresa = p_id_empresa AND mv.periodo = r.v AND mv.data_periodo >= v_d60)
    ) s;

    -- modais: entregadores da empresa com turno nos últimos 60 dias (uma sonda por entregador)
    SELECT COALESCE(jsonb_agg(s.x ORDER BY s.x), '[]'::jsonb) INTO j_modais
    FROM (SELECT DISTINCT NULLIF(upper(btrim(e.dados_entrego_json -> 'informacoesEntrega' ->> 'modal')), '') AS x
          FROM "Entregador" e
          WHERE e.id_empresa = p_id_empresa
            AND EXISTS (SELECT 1 FROM mv_performance_dia mv
                        WHERE mv.id_empresa = p_id_empresa AND mv.entregador_id = e.id AND mv.data_periodo >= v_d60)) s
    WHERE s.x IS NOT NULL;

    -- Público dos últimos 30 dias (mesmo recorte do recálculo; praça por semi-join, nunca EXISTS correlacionado).
    -- Agrega POR ENTREGADOR antes de juntar (2k linhas no join em vez de 180k).
    WITH t AS (
        SELECT mv.entregador_id, count(*) AS n, count(mv.pedidos_concluidos) AS np
        FROM mv_performance_dia mv
        WHERE mv.id_empresa = p_id_empresa AND mv.data_periodo BETWEEN v_d30 AND v_hoje
          AND (v_turnos IS NULL OR upper(btrim(mv.periodo)) = ANY (v_turnos))
          AND (v_pracas IS NULL OR (mv.entregador_id, mv.data_periodo, mv.periodo) IN (
                  SELECT pt.entregador_id, pt.data_periodo, pt.periodo FROM "PerformanceTurno" pt
                  WHERE pt.id_empresa = p_id_empresa AND pt.data_periodo BETWEEN v_d30 AND v_hoje
                    AND upper(hub_subpraca_efetiva(pt.subpraca, pt.origem)) = ANY (v_pracas)))
        GROUP BY mv.entregador_id
    ),
    m AS (
        SELECT t.*, NULLIF(upper(btrim(e.dados_entrego_json -> 'informacoesEntrega' ->> 'modal')), '') AS modal
        FROM t JOIN "Entregador" e ON e.id = t.entregador_id
    )
    SELECT
        (sum(np) FILTER (WHERE v_modais IS NULL OR modal = ANY (v_modais)))::numeric
            / NULLIF(sum(n) FILTER (WHERE v_modais IS NULL OR modal = ANY (v_modais)), 0),
        count(*) FILTER (WHERE v_modais IS NULL OR modal = ANY (v_modais)),
        count(*) FILTER (WHERE modal IS NULL)
    INTO v_cob, v_rodaram, v_sem
    FROM m;

    RETURN jsonb_build_object(
        'pracas', j_pracas, 'turnos', j_turnos, 'modais', j_modais,
        'cobertura_pedidos', round(v_cob, 4),
        'alcance', jsonb_build_object('rodaram', COALESCE(v_rodaram, 0), 'sem_modal', COALESCE(v_sem, 0))
    );
END;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_publico_cnpjs(c "Campanha")
RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(array_agg(DISTINCT cm.cnpj_prestador), '{}')
    FROM "Entregador" e
    JOIN "ContaMotorista" cm ON cm.id = e.motorista_id AND cm.ativo
    WHERE e.id_empresa = c.id_empresa AND e.ativo
      AND (c.modais IS NULL
           OR upper(btrim(e.dados_entrego_json -> 'informacoesEntrega' ->> 'modal')) = ANY (c.modais))
      AND (c.pracas IS NULL OR e.id IN (
              SELECT pt.entregador_id FROM "PerformanceTurno" pt
              WHERE pt.id_empresa = c.id_empresa AND pt.data_periodo >= hub_hoje_sp() - 59
                AND upper(hub_subpraca_efetiva(pt.subpraca, pt.origem)) = ANY (c.pracas)));
$$;

CREATE OR REPLACE FUNCTION hub_campanha_visivel(c "Campanha", p_entregador_id int)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT c.lancada_em IS NOT NULL
       AND c.cancelada_em IS NULL
       -- 0132: interruptor do operador; oculta = some do app inteiro (lista, card, detalhe, turnos, foto)
       AND c.visivel_app
       -- B8: o módulo `campanhas` tem de estar ATIVO na empresa da campanha (desligar o módulo some do app)
       AND EXISTS (SELECT 1 FROM "ModuloEntidade" me JOIN "Modulo" m ON m.id = me.modulo_id
                   WHERE m.codigo = 'campanhas' AND me.empresa_id = c.id_empresa AND me.ativo)
       AND (c.fechada_em IS NULL OR c.fechada_em >= now() - interval '30 days')
       AND (c.pracas IS NULL
            OR EXISTS (SELECT 1 FROM "CampanhaRanking" r WHERE r.campanha_id = c.id AND r.entregador_id = p_entregador_id)
            OR EXISTS (SELECT 1 FROM "PerformanceTurno" pt
                       WHERE pt.id_empresa = c.id_empresa AND pt.entregador_id = p_entregador_id
                         AND pt.data_periodo >= hub_hoje_sp() - 59
                         AND upper(hub_subpraca_efetiva(pt.subpraca, pt.origem)) = ANY (c.pracas)));
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 9. Salvar e lancar (D2/D3/D4/D5)
-- ═══════════════════════════════════════════════════════════════════════

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
    v_visivel    boolean;
    v_desc_min   int;
    v_data_premio date;
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
        IF v_cats IS NOT NULL AND NOT hub_campanha_categorias_ok(v_cats) THEN
            RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'categorias';
        END IF;
    END IF;
    -- 0133 (D3): a nota aceita categorias (NULL = todos os turnos); a validacao acima e a mesma do extrato
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

    -- 0132: visivelApp (ausente: INSERT = false, UPDATE = mantem o valor atual; nao-boolean = VALIDACAO)
    IF jsonb_typeof(p_dados -> 'visivelApp') = 'boolean' THEN v_visivel := (p_dados ->> 'visivelApp')::boolean;
    ELSIF p_dados -> 'visivelApp' IS NULL OR jsonb_typeof(p_dados -> 'visivelApp') = 'null' THEN
        v_visivel := CASE WHEN p_id IS NULL THEN false ELSE c.visivel_app END;   -- ausente: nasce oculta; edicao mantem
    ELSE RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'visivelApp';
    END IF;

    -- 0133 (D2): descarte do turno curto zerado, em minutos (0 = desliga). Ausente: INSERT = 5, edicao = mantem.
    v_desc_min := hub_campanha_num(p_dados -> 'descarteTurnoMin', 'descarteTurnoMin', 0, 60, true, false);
    IF v_desc_min IS NULL THEN v_desc_min := CASE WHEN p_id IS NULL THEN 5 ELSE c.descarte_turno_min END; END IF;

    -- 0133 (D5): data do premio (opcional). Chave ausente: INSERT = sem data, edicao = mantem; null = sem data.
    IF p_dados ? 'dataPremio' THEN
        IF jsonb_typeof(p_dados -> 'dataPremio') = 'null' THEN
            v_data_premio := NULL;
        ELSIF jsonb_typeof(p_dados -> 'dataPremio') <> 'string' THEN
            RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'dataPremio';
        ELSE
            BEGIN
                v_data_premio := (p_dados ->> 'dataPremio')::date;
            EXCEPTION WHEN OTHERS THEN
                RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'dataPremio';
            END;
        END IF;
    ELSE
        v_data_premio := CASE WHEN p_id IS NULL THEN NULL ELSE c.data_premio END;
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
            tipo, categorias, min_turnos_base, visivel_app, descarte_turno_min, data_premio)
        VALUES (
            p_id_empresa, v_nome, v_desc, v_ini, v_fim, v_pracas, v_turnos, v_modais, v_min,
            v_pa, v_pc, v_pt, v_pp, v_ca, v_cc, v_ct, v_cp, v_avisar, v_sub,
            v_tipo, v_cats, v_base, v_visivel, v_desc_min, v_data_premio)
        RETURNING id INTO v_id;
        IF v_visivel THEN PERFORM hub_campanha_auditar_visibilidade(v_id, false, true); END IF;
    ELSE
        v_id := p_id;
        UPDATE "Campanha" SET
            nome = v_nome, descricao = v_desc, data_inicio = v_ini, data_fim = v_fim,
            pracas = v_pracas, turnos = v_turnos, modais = v_modais, min_turnos = v_min,
            peso_aceitacao = v_pa, peso_conclusao = v_pc, peso_tempo = v_pt, peso_pedidos = v_pp,
            corte_aceitacao = v_ca, corte_conclusao = v_cc, corte_tempo = v_ct, corte_pedidos = v_cp,
            avisar = v_avisar, tipo = v_tipo, categorias = v_cats, min_turnos_base = v_base,
            visivel_app = v_visivel, descarte_turno_min = v_desc_min, data_premio = v_data_premio
        WHERE id = v_id;
        IF v_visivel IS DISTINCT FROM c.visivel_app THEN
            PERFORM hub_campanha_auditar_visibilidade(v_id, c.visivel_app, v_visivel);
        END IF;
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
    v_max    date;
BEGIN
    c := hub_campanha_carregar(p_id, 'campanhas.gerir', true);
    IF hub_campanha_situacao(c) <> 'rascunho' THEN
        RAISE EXCEPTION 'CAMPANHA_SITUACAO_INVALIDA' USING ERRCODE = '55000';
    END IF;
    -- 0133 (D4): campanha em andamento pode ser lancada; so recusa a que ja terminou
    IF c.data_fim < hub_hoje_sp() THEN
        RAISE EXCEPTION 'FIM_NO_PASSADO' USING ERRCODE = '22023';
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
    -- 0133 (D3): vale para extrato e para nota com categorias
    IF c.categorias IS NOT NULL AND EXISTS (
        SELECT 1 FROM unnest(c.categorias) x
        WHERE x <> ALL (hub_adiantamento_familias())
          AND (x LIKE 'familia:%' OR x LIKE 'modo:%'
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

    -- 0133 (D4): ja comecou E ja ha dado do periodo => o ranking nasce pronto (mesma transacao). Mesma regra de
    -- hub_campanhas_recalcular_ativas (data_inicio <= ultimo dia com dado): inicio = hoje sem dado do dia nao grava dados_ate < inicio.
    SELECT max(mv.data_periodo) INTO v_max FROM mv_performance_dia mv WHERE mv.id_empresa = c.id_empresa;
    IF c.data_inicio <= hub_hoje_sp() AND c.data_inicio <= v_max THEN
        PERFORM hub_campanha_recalcular_interno(c.id);
    END IF;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 10. Leitura (hub e app): data_premio / descarte_turno_min / data_pagamento
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION hub_campanha_item_json(c "Campanha")
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', c.id, 'nome', c.nome, 'situacao', hub_campanha_situacao(c),
        'visivelApp', c.visivel_app,
        'dataPremio', c.data_premio, 'descarteTurnoMin', c.descarte_turno_min,
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
                'dataPagamento', (SELECT COALESCE(v.data_pagamento, (v.exportado_em AT TIME ZONE 'America/Sao_Paulo')::date)
                              FROM "CampanhaVencedor" v WHERE v.campanha_id = c.id AND v.entregador_id = v_ent),
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
            'dataPagamento', (SELECT COALESCE(v.data_pagamento, (v.exportado_em AT TIME ZONE 'America/Sao_Paulo')::date)
                              FROM "CampanhaVencedor" v WHERE v.campanha_id = c.id AND v.entregador_id = v_ent),
                'entregueEm', (SELECT v.entregue_em FROM "CampanhaVencedor" v
                           WHERE v.campanha_id = c.id AND v.entregador_id = v_ent));
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'campanha', jsonb_build_object(
            'id', c.id, 'nome', c.nome, 'descricao', c.descricao, 'situacao', hub_campanha_situacao(c),
            'tipo', c.tipo, 'minTurnosBase', c.min_turnos_base,
            'dataInicio', c.data_inicio, 'dataFim', c.data_fim, 'dataPremio', c.data_premio,
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
                  ORDER BY k.posicao) t), '[]'::jsonb) END);
END;
$$;

DROP FUNCTION IF EXISTS hub_campanha_vencedores(int);
CREATE FUNCTION hub_campanha_vencedores(p_id int)
RETURNS TABLE (
    posicao int, entregador_id int, nome text, cnpj text, nota numeric, premio_id int, premio_tipo text,
    premio_descricao text, valor_centavos int, entregue_em timestamptz, entregue_por_nome text,
    observacao text, exportado_em timestamptz, data_pagamento date
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    c "Campanha";
BEGIN
    c := hub_campanha_carregar(p_id, 'campanhas.consultar', false);
    RETURN QUERY
    SELECT v.posicao, v.entregador_id, e.nome, cm.cnpj_prestador, r.nota, p.id, p.tipo, p.descricao,
           p.valor_centavos, v.entregue_em, u.nome, v.observacao, v.exportado_em,
           -- 0133: data gravada na 1a exportacao; linha exportada antes da 0133 cai no dia SP do carimbo
           COALESCE(v.data_pagamento, (v.exportado_em AT TIME ZONE 'America/Sao_Paulo')::date)
    FROM "CampanhaVencedor" v
    JOIN "CampanhaPremio" p ON p.id = v.premio_id
    JOIN "Entregador" e ON e.id = v.entregador_id
    LEFT JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
    LEFT JOIN "CampanhaRanking" r ON r.campanha_id = v.campanha_id AND r.entregador_id = v.entregador_id
    LEFT JOIN "Usuario" u ON u.id = v.entregue_por
    WHERE v.campanha_id = c.id
    ORDER BY v.posicao;
END;
$$;
REVOKE ALL ON FUNCTION hub_campanha_vencedores(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_campanha_vencedores(int) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 11. D5 — data do premio
-- ═══════════════════════════════════════════════════════════════════════

-- Troca (ou limpa) a data do premio. Qualquer situacao menos cancelada; recusa se TODOS os premios ja foram pagos/entregues.
-- Devolve antes/depois: a auditoria e do backend (este RPC nao grava em "Auditoria").
CREATE OR REPLACE FUNCTION hub_campanha_alterar_data_premio(p_id_empresa int, p_campanha_id int, p_data date)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    c       "Campanha";
    v_tot   int;
    v_pend  int;
BEGIN
    PERFORM hub_campanha_autoriza(p_id_empresa, 'campanhas.gerir');
    c := hub_campanha_carregar(p_campanha_id, 'campanhas.gerir', true);
    IF c.id_empresa <> p_id_empresa THEN
        RAISE EXCEPTION 'CAMPANHA_NAO_ENCONTRADA' USING ERRCODE = 'P0002';
    END IF;
    IF c.cancelada_em IS NOT NULL THEN
        RAISE EXCEPTION 'CAMPANHA_SITUACAO_INVALIDA' USING ERRCODE = '55000';
    END IF;

    SELECT count(*),
           count(*) FILTER (WHERE (p.tipo = 'objeto' AND v.entregue_em IS NULL)
                               OR (p.tipo = 'dinheiro' AND v.exportado_em IS NULL))
    INTO v_tot, v_pend
    FROM "CampanhaVencedor" v JOIN "CampanhaPremio" p ON p.id = v.premio_id
    WHERE v.campanha_id = c.id;
    IF v_tot > 0 AND v_pend = 0 THEN
        RAISE EXCEPTION 'CAMPANHA_SITUACAO_INVALIDA' USING ERRCODE = '55000';
    END IF;

    IF c.data_premio IS DISTINCT FROM p_data THEN
        UPDATE "Campanha" SET data_premio = p_data WHERE id = c.id;
    END IF;
    RETURN jsonb_build_object('campanhaId', c.id, 'nome', c.nome,
                              'antes', c.data_premio, 'depois', p_data,
                              'alterada', c.data_premio IS DISTINCT FROM p_data);
END;
$$;
REVOKE ALL ON FUNCTION hub_campanha_alterar_data_premio(int, int, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_campanha_alterar_data_premio(int, int, date) TO authenticated;

-- Planilha de premios em DINHEIRO (so vencedores com CNPJ; sem CNPJ nao volta).
-- A1: `data_pagamento` e GRAVADA em "CampanhaVencedor" na 1a exportacao = GREATEST(data_premio, hoje SP) (sem data_premio: hoje SP);
--     baixar de novo reproduz a MESMA data mesmo que data_premio mude depois. Linha exportada antes da 0133 (sem a coluna
--     gravada) cai no dia SP do exportado_em.
-- A2: vencedor cujo CNPJ ja tem outro premio de dinheiro exportado na MESMA data efetiva (qualquer campanha da empresa) e carimbado
--     no proximo dia livre (+1, +2... ate 31 dias); so se nao houver dia livre volta com adiado = true e data_pagamento NULL.
--     O lock por empresa serializa duas exportacoes simultaneas (senao as duas passariam pela checagem).
CREATE OR REPLACE FUNCTION hub_campanha_marcar_exportado(p_id int)
RETURNS TABLE (cnpj text, nome text, valor_centavos int, posicao int, data_pagamento date, adiado boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    c          "Campanha";
    r          RECORD;
    v_hoje     date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
    v_data     date;
    v_conflito boolean;
    v_em       timestamptz;
    v_dpg      date;
    v_dia      date;
    i          int;
BEGIN
    c := hub_campanha_carregar(p_id, 'campanhas.entregar', true);
    IF c.cancelada_em IS NOT NULL THEN
        RAISE EXCEPTION 'CAMPANHA_SITUACAO_INVALIDA' USING ERRCODE = '55000';
    END IF;
    PERFORM pg_advisory_xact_lock(c.id_empresa, hashtext('hub_campanha_exportar'));
    -- data efetiva de quem for carimbado agora: data do premio no futuro = espera; no passado (ou sem data) = hoje
    v_data := GREATEST(COALESCE(c.data_premio, v_hoje), v_hoje);

    FOR r IN
        SELECT v.posicao AS pos, cm.cnpj_prestador AS cnpj, e.nome AS nome, p.valor_centavos AS valor,
               v.exportado_em AS em, v.data_pagamento AS dpg
        FROM "CampanhaVencedor" v
        JOIN "CampanhaPremio" p ON p.id = v.premio_id AND p.tipo = 'dinheiro'
        JOIN "Entregador" e ON e.id = v.entregador_id
        JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
        WHERE v.campanha_id = c.id
        ORDER BY v.posicao
    LOOP
        v_em := r.em;
        v_dpg := r.dpg;
        IF v_em IS NULL THEN
            -- colisao de CNPJ na data efetiva: carimba no PROXIMO DIA LIVRE (+1, +2, ... ate 31 dias); esgotado => adiado
            v_dia := NULL;
            FOR i IN 0..31 LOOP
                SELECT EXISTS (
                    SELECT 1 FROM "CampanhaVencedor" x
                    JOIN "CampanhaPremio" xp ON xp.id = x.premio_id AND xp.tipo = 'dinheiro'
                    JOIN "Entregador" xe ON xe.id = x.entregador_id
                    JOIN "ContaMotorista" xc ON xc.id = xe.motorista_id
                    WHERE x.id_empresa = c.id_empresa AND xc.cnpj_prestador = r.cnpj
                      AND x.exportado_em IS NOT NULL
                      AND COALESCE(x.data_pagamento, (x.exportado_em AT TIME ZONE 'America/Sao_Paulo')::date) = v_data + i
                ) INTO v_conflito;
                IF NOT v_conflito THEN
                    v_dia := v_data + i;
                    EXIT;
                END IF;
            END LOOP;
            IF v_dia IS NULL THEN
                RETURN QUERY SELECT r.cnpj, r.nome, r.valor, r.pos, NULL::date, true;
                CONTINUE;
            END IF;
            UPDATE "CampanhaVencedor" SET exportado_em = now(), data_pagamento = v_dia
            WHERE campanha_id = c.id AND posicao = r.pos
            RETURNING exportado_em, data_pagamento INTO v_em, v_dpg;
        END IF;
        v_dpg := COALESCE(v_dpg, (v_em AT TIME ZONE 'America/Sao_Paulo')::date);
        RETURN QUERY SELECT r.cnpj, r.nome, r.valor, r.pos, v_dpg, false;
    END LOOP;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 12. D1 nas RPCs de performance e faturamento (corpo VIVO do banco; unica mudanca: a comparacao de p_subpraca e o
--     agrupamento/exibicao da subpraca do turno passam por hub_subpraca_efetiva; em totais/agrupado o EXISTS correlacionado vira
-- semi-join, mesmo resultado, para o indice de expressao servir)
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION hub_performance_totais(p_id_empresa integer, p_de date, p_ate date, p_periodo text, p_subpraca text, p_entregador_id integer)
 RETURNS TABLE(corridas_completadas integer, taxa_aceitacao text, taxa_conclusao text, tempo_disponivel_medio text, taxas_reais text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF p_id_empresa IS NULL OR NOT (p_id_empresa = ANY (hub_jwt_escopo_ids())) THEN
        RETURN QUERY SELECT 0::int, NULL::text, NULL::text, NULL::text,
                            (0::numeric(12,2))::text;
        RETURN;
    END IF;

    RETURN QUERY
    WITH filtro AS (
        SELECT mv.corridas_ofertadas   AS f_ofertadas,
               mv.corridas_aceitas     AS f_aceitas,
               mv.corridas_completadas AS f_completadas,
               mv.taxas_centavos       AS f_taxas,
               mv.online_epoch         AS f_online,
               mv.periodo_epoch        AS f_periodo
        FROM mv_performance_dia mv
        WHERE mv.id_empresa = p_id_empresa
          AND mv.data_periodo BETWEEN p_de AND p_ate
          AND (p_periodo IS NULL OR mv.periodo = p_periodo)
          AND (p_entregador_id IS NULL OR mv.entregador_id = p_entregador_id)
          -- 0133: semi-join (como hub_performance_turnos e as campanhas) em vez do EXISTS correlacionado: com o indice de
          -- expressao (id_empresa, efetiva, data_periodo) a subconsulta roda UMA vez (hashed) em vez de uma sonda por linha da MV
          -- (medido sob 900 mil turnos). Mesmo conjunto de linhas: IN (...) = existe turno daquele grao na sub-praca.
          AND (p_subpraca IS NULL OR (mv.entregador_id, mv.data_periodo, mv.periodo) IN (
                  SELECT pt.entregador_id, pt.data_periodo, pt.periodo FROM "PerformanceTurno" pt
                  WHERE pt.id_empresa = p_id_empresa
                    AND hub_subpraca_efetiva(pt.subpraca, pt.origem) = p_subpraca
                    AND pt.data_periodo BETWEEN p_de AND p_ate))
    )
    SELECT
        COALESCE((SELECT SUM(f.f_completadas) FROM filtro f), 0)::int,
        (
            SELECT (SUM(f.f_aceitas)::numeric / NULLIF(SUM(f.f_ofertadas), 0))::numeric(6,4)::text
            FROM filtro f
        ),
        (
            SELECT (SUM(f.f_completadas)::numeric / NULLIF(SUM(f.f_aceitas), 0))::numeric(6,4)::text
            FROM filtro f
        ),
        (
            SELECT (SUM(f.f_online) / NULLIF(SUM(f.f_periodo), 0) * 100)::numeric(6,2)::text
            FROM filtro f
        ),
        (COALESCE((SELECT SUM(f.f_taxas) FROM filtro f), 0)::numeric / 100)::numeric(12,2)::text;
END;
$function$;

CREATE OR REPLACE FUNCTION hub_performance_agrupado(p_id_empresa integer, p_de date, p_ate date, p_periodo text, p_subpraca text, p_entregador_id integer, p_group_by text)
 RETURNS TABLE(chave text, quantidade integer, corridas_completadas integer, taxa_aceitacao text, taxa_conclusao text, tempo_disponivel_medio text, taxas_reais text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF p_id_empresa IS NULL OR NOT (p_id_empresa = ANY (hub_jwt_escopo_ids())) THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH filtro AS (
        SELECT
            CASE p_group_by
                WHEN 'dia'        THEN mv.data_periodo::text
                WHEN 'periodo'    THEN mv.periodo
                WHEN 'entregador' THEN mv.entregador_id::text
            END AS chave_calc,
            mv.quantidade           AS f_quantidade,
            mv.corridas_ofertadas   AS f_ofertadas,
            mv.corridas_aceitas     AS f_aceitas,
            mv.corridas_completadas AS f_completadas,
            mv.taxas_centavos       AS f_taxas,
            mv.online_epoch         AS f_online,
            mv.periodo_epoch        AS f_periodo
        FROM mv_performance_dia mv
        WHERE mv.id_empresa = p_id_empresa
          AND mv.data_periodo BETWEEN p_de AND p_ate
          AND (p_periodo IS NULL OR mv.periodo = p_periodo)
          AND (p_entregador_id IS NULL OR mv.entregador_id = p_entregador_id)
          -- 0133: semi-join (como hub_performance_turnos e as campanhas) em vez do EXISTS correlacionado: com o indice de
          -- expressao (id_empresa, efetiva, data_periodo) a subconsulta roda UMA vez (hashed) em vez de uma sonda por linha da MV
          -- (medido sob 900 mil turnos). Mesmo conjunto de linhas: IN (...) = existe turno daquele grao na sub-praca.
          AND (p_subpraca IS NULL OR (mv.entregador_id, mv.data_periodo, mv.periodo) IN (
                  SELECT pt.entregador_id, pt.data_periodo, pt.periodo FROM "PerformanceTurno" pt
                  WHERE pt.id_empresa = p_id_empresa
                    AND hub_subpraca_efetiva(pt.subpraca, pt.origem) = p_subpraca
                    AND pt.data_periodo BETWEEN p_de AND p_ate))
    )
    SELECT
        f.chave_calc,
        SUM(f.f_quantidade)::int,
        SUM(f.f_completadas)::int,
        (SUM(f.f_aceitas)::numeric / NULLIF(SUM(f.f_ofertadas), 0))::numeric(6,4)::text,
        (SUM(f.f_completadas)::numeric / NULLIF(SUM(f.f_aceitas), 0))::numeric(6,4)::text,
        (SUM(f.f_online) / NULLIF(SUM(f.f_periodo), 0) * 100)::numeric(6,2)::text,
        (SUM(f.f_taxas)::numeric / 100)::numeric(12,2)::text
    FROM filtro f
    WHERE f.chave_calc IS NOT NULL
    GROUP BY f.chave_calc;
END;
$function$;

CREATE OR REPLACE FUNCTION hub_performance_turnos(p_id_empresa integer, p_de date, p_ate date, p_periodo text, p_subpraca text, p_entregador_id integer, p_limit integer, p_offset integer)
 RETURNS TABLE(entregador_id integer, entregador_nome text, data_periodo date, periodo text, praca text, corridas_ofertadas bigint, corridas_aceitas bigint, corridas_rejeitadas bigint, corridas_completadas bigint, corridas_canceladas bigint, pedidos_concluidos bigint, taxas_centavos bigint, tempo_disponivel_periodo_pct text, pracas jsonb, total_turnos bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_total bigint;
BEGIN
    -- Fora do escopo: ZERO linhas, nunca erro (mesmo contrato das irmãs) —
    -- um 500 diria ao chamador que a empresa existe.
    IF p_id_empresa IS NULL OR NOT (p_id_empresa = ANY (hub_jwt_escopo_ids())) THEN
        RETURN;
    END IF;

    -- A contagem é resolvida ANTES, em variável, e não como subconsulta na
    -- lista de saída: assim cada caso usa o seu caminho, e o total não é
    -- recalculado por linha da página.
    --
    -- Os dois ramos contam LINHAS DA MV — nunca a tabela-base. Contar turnos
    -- distintos em `PerformanceTurno` daria o mesmo número quase sempre e um
    -- número MAIOR que a lista enquanto a MV estivesse defasada, o que
    -- apareceria como "página vazia com total > 0".
    IF p_subpraca IS NULL THEN
        SELECT COUNT(*) INTO v_total
        FROM mv_performance_dia mv
        WHERE mv.id_empresa = p_id_empresa
          AND mv.data_periodo BETWEEN p_de AND p_ate
          AND (p_periodo IS NULL OR mv.periodo = p_periodo)
          AND (p_entregador_id IS NULL OR mv.entregador_id = p_entregador_id);
    ELSE
        -- `IN (subconsulta)` e não `EXISTS` correlacionado: o EXISTS obriga uma
        -- sonda por turno do período (270k sondas = 1,5s medidos); o `IN` deixa
        -- o planejador montar UM semi-join de hash contra as linhas daquela
        -- sub-praça na janela, que o índice acima entrega prontas.
        SELECT COUNT(*) INTO v_total
        FROM mv_performance_dia mv
        WHERE mv.id_empresa = p_id_empresa
          AND mv.data_periodo BETWEEN p_de AND p_ate
          AND (p_periodo IS NULL OR mv.periodo = p_periodo)
          AND (p_entregador_id IS NULL OR mv.entregador_id = p_entregador_id)
          AND (mv.entregador_id, mv.data_periodo, mv.periodo) IN (
                SELECT pt.entregador_id, pt.data_periodo, pt.periodo
                FROM "PerformanceTurno" pt
                WHERE pt.id_empresa   = p_id_empresa
                  AND hub_subpraca_efetiva(pt.subpraca, pt.origem) = p_subpraca
                  AND pt.data_periodo BETWEEN p_de AND p_ate);
    END IF;

    RETURN QUERY
    WITH pagina AS (
        SELECT
            mv.entregador_id                          AS f_entregador_id,
            mv.data_periodo                           AS f_data,
            mv.periodo                                AS f_periodo,
            mv.corridas_ofertadas                     AS f_ofertadas,
            mv.corridas_aceitas                       AS f_aceitas,
            mv.corridas_rejeitadas                    AS f_rejeitadas,
            mv.corridas_completadas                   AS f_completadas,
            mv.corridas_canceladas                    AS f_canceladas,
            mv.pedidos_concluidos                     AS f_pedidos,
            mv.taxas_centavos                         AS f_taxas,
            (mv.online_epoch / NULLIF(mv.periodo_epoch, 0) * 100)::numeric(6,2) AS f_tempo
        FROM mv_performance_dia mv
        WHERE mv.id_empresa = p_id_empresa
          AND mv.data_periodo BETWEEN p_de AND p_ate
          AND (p_periodo IS NULL OR mv.periodo = p_periodo)
          AND (p_entregador_id IS NULL OR mv.entregador_id = p_entregador_id)
          AND (p_subpraca IS NULL OR EXISTS (
                  SELECT 1 FROM "PerformanceTurno" pt
                  WHERE pt.id_empresa    = mv.id_empresa
                    AND pt.entregador_id = mv.entregador_id
                    AND pt.data_periodo  = mv.data_periodo
                    AND pt.periodo       = mv.periodo
                    AND hub_subpraca_efetiva(pt.subpraca, pt.origem) = p_subpraca))
        -- Ordem do índice unique, lida de trás para frente (ver (a) acima).
        ORDER BY mv.data_periodo DESC, mv.periodo DESC, mv.entregador_id DESC
        LIMIT  COALESCE(NULLIF(p_limit, 0), 20)
        OFFSET COALESCE(p_offset, 0)
    )
    SELECT
        p.f_entregador_id::int,
        e.nome,
        p.f_data,
        p.f_periodo,
        det.praca_predominante,
        p.f_ofertadas,
        p.f_aceitas,
        p.f_rejeitadas,
        p.f_completadas,
        p.f_canceladas,
        p.f_pedidos,
        p.f_taxas,
        p.f_tempo::text,
        COALESCE(det.lista, '[]'::jsonb),
        v_total
    FROM pagina p
    LEFT JOIN "Entregador" e
           ON e.id = p.f_entregador_id
          AND e.id_empresa = p_id_empresa
    LEFT JOIN LATERAL (
        SELECT
            jsonb_agg(jsonb_build_object(
                'subpraca',            x.subpraca,
                'praca',               x.praca,
                'tempoDisponivelPct',  x.tempo_pct,
                'corridasOfertadas',   x.ofertadas,
                'corridasAceitas',     x.aceitas,
                'corridasCompletadas', x.completadas,
                'taxasCentavos',       x.taxas
            ) ORDER BY x.tempo_pct DESC NULLS LAST, x.ofertadas DESC, x.subpraca ASC)
                                                                       AS lista,
            -- A meta é por PRAÇA × turno, e o turno pode atravessar praças.
            -- O veredito precisa de UMA praça: a PREDOMINANTE — mais tempo
            -- online, desempate por ofertadas e depois pelo nome da
            -- sub-praça. Com uma praça só (a esmagadora maioria) é
            -- exatamente o que a tela já fazia por linha.
            (array_agg(x.praca
                ORDER BY x.tempo_pct DESC NULLS LAST, x.ofertadas DESC, x.subpraca ASC))[1]
                                                                       AS praca_predominante
        FROM (
            SELECT
                hub_subpraca_efetiva(pt.subpraca, pt.origem) AS subpraca,
                pt.praca,
                -- Soma da coluna gerada de 0050 (% do período POR LINHA, já
                -- somável entre praças do mesmo turno). `CASE` antes do
                -- `LEAST` porque LEAST IGNORA NULL: sem esse guard, a
                -- sub-praça sem leitura nenhuma sairia com 100% — ausência
                -- virando nota máxima, a mesma armadilha que 0050 documenta.
                CASE
                    WHEN SUM(pt.tempo_disponivel_periodo_pct) IS NULL THEN NULL
                    ELSE LEAST(SUM(pt.tempo_disponivel_periodo_pct), 100::numeric)
                END                                    AS tempo_pct,
                SUM(pt.corridas_ofertadas)::bigint     AS ofertadas,
                SUM(pt.corridas_aceitas)::bigint       AS aceitas,
                SUM(pt.corridas_completadas)::bigint   AS completadas,
                SUM(COALESCE(pt.taxas_centavos, 0))::bigint AS taxas
            FROM "PerformanceTurno" pt
            WHERE pt.id_empresa    = p_id_empresa
              AND pt.entregador_id = p.f_entregador_id
              AND pt.data_periodo  = p.f_data
              AND pt.periodo       = p.f_periodo
            GROUP BY hub_subpraca_efetiva(pt.subpraca, pt.origem), pt.praca
        ) x
    ) det ON true
    ORDER BY p.f_data DESC, p.f_periodo DESC, p.f_entregador_id DESC;
END;
$function$;

CREATE OR REPLACE FUNCTION hub_faturamento_totais(p_id_empresa integer, p_de date, p_ate date, p_categoria text, p_entregador_id integer, p_subpraca text, p_com_entregador boolean)
 RETURNS TABLE(total_geral text, categoria_maior_valor text, entregadores_distintos integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF p_id_empresa IS NULL OR NOT (p_id_empresa = ANY (hub_jwt_escopo_ids())) THEN
        RETURN QUERY SELECT 0::numeric(12,2)::text, NULL::text, 0::int;
        RETURN;
    END IF;

    IF p_subpraca IS NULL THEN
        RETURN QUERY
        WITH filtro AS (
            SELECT mv.descricao AS f_descricao,
                   mv.entregador_id AS f_entregador_id,
                   mv.total AS f_total
            FROM mv_faturamento_dia mv
            WHERE mv.id_empresa = p_id_empresa
              AND mv.data_lancamento BETWEEN p_de AND p_ate
              AND (p_categoria IS NULL OR mv.descricao = p_categoria)
              AND (p_entregador_id IS NULL OR mv.entregador_id = p_entregador_id)
              AND (p_com_entregador IS NULL OR mv.com_entregador = p_com_entregador)
        )
        SELECT
            COALESCE((SELECT SUM(f_total) FROM filtro), 0)::numeric(12,2)::text,
            (
                SELECT f_descricao FROM filtro
                GROUP BY f_descricao
                ORDER BY SUM(f_total) DESC, f_descricao ASC
                LIMIT 1
            ),
            (SELECT COUNT(DISTINCT f_entregador_id) FROM filtro)::int;
    ELSE
        -- Fallback (filtro por sub-praça — dimensão fora da MV).
        RETURN QUERY
        WITH filtro AS (
            SELECT fl.descricao AS f_descricao,
                   fl.entregador_id AS f_entregador_id,
                   fl.valor AS f_valor
            FROM "FaturamentoLancamento" fl
            WHERE fl.id_empresa = p_id_empresa
              AND fl.data_lancamento BETWEEN p_de AND p_ate
              AND (p_categoria IS NULL OR fl.descricao = p_categoria)
              AND (p_entregador_id IS NULL OR fl.entregador_id = p_entregador_id)
              AND hub_subpraca_efetiva(fl.subpraca, fl.origem) = p_subpraca
              AND (
                    p_com_entregador IS NULL
                    OR (p_com_entregador AND fl.entregador_id IS NOT NULL)
                    OR (NOT p_com_entregador AND fl.entregador_id IS NULL)
                  )
        )
        SELECT
            COALESCE((SELECT SUM(f_valor) FROM filtro), 0)::numeric(12,2)::text,
            (
                SELECT f_descricao FROM filtro
                GROUP BY f_descricao
                ORDER BY SUM(f_valor) DESC, f_descricao ASC
                LIMIT 1
            ),
            (SELECT COUNT(DISTINCT f_entregador_id) FROM filtro)::int;
    END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION hub_faturamento_agrupado(p_id_empresa integer, p_de date, p_ate date, p_categoria text, p_entregador_id integer, p_subpraca text, p_com_entregador boolean, p_group_by text)
 RETURNS TABLE(chave text, total text, quantidade integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
    IF p_id_empresa IS NULL OR NOT (p_id_empresa = ANY (hub_jwt_escopo_ids())) THEN
        RETURN;
    END IF;

    IF p_subpraca IS NULL THEN
        RETURN QUERY
        WITH filtro AS (
            SELECT
                CASE p_group_by
                    WHEN 'dia'        THEN mv.data_lancamento::text
                    WHEN 'categoria'  THEN mv.descricao
                    WHEN 'entregador' THEN COALESCE(mv.entregador_id::text, 'agregados_bonus')
                END AS chave_calc,
                mv.total AS f_total,
                mv.quantidade AS f_quantidade
            FROM mv_faturamento_dia mv
            WHERE mv.id_empresa = p_id_empresa
              AND mv.data_lancamento BETWEEN p_de AND p_ate
              AND (p_categoria IS NULL OR mv.descricao = p_categoria)
              AND (p_entregador_id IS NULL OR mv.entregador_id = p_entregador_id)
              AND (p_com_entregador IS NULL OR mv.com_entregador = p_com_entregador)
        )
        SELECT
            chave_calc,
            SUM(f_total)::numeric(12,2)::text,
            SUM(f_quantidade)::int
        FROM filtro
        WHERE chave_calc IS NOT NULL
        GROUP BY chave_calc;
    ELSE
        RETURN QUERY
        WITH filtro AS (
            SELECT
                CASE p_group_by
                    WHEN 'dia'        THEN fl.data_lancamento::text
                    WHEN 'categoria'  THEN fl.descricao
                    WHEN 'entregador' THEN COALESCE(fl.entregador_id::text, 'agregados_bonus')
                END AS chave_calc,
                fl.valor AS f_valor
            FROM "FaturamentoLancamento" fl
            WHERE fl.id_empresa = p_id_empresa
              AND fl.data_lancamento BETWEEN p_de AND p_ate
              AND (p_categoria IS NULL OR fl.descricao = p_categoria)
              AND (p_entregador_id IS NULL OR fl.entregador_id = p_entregador_id)
              AND hub_subpraca_efetiva(fl.subpraca, fl.origem) = p_subpraca
              AND (
                    p_com_entregador IS NULL
                    OR (p_com_entregador AND fl.entregador_id IS NOT NULL)
                    OR (NOT p_com_entregador AND fl.entregador_id IS NULL)
                  )
        )
        SELECT
            chave_calc,
            SUM(f_valor)::numeric(12,2)::text,
            COUNT(*)::int
        FROM filtro
        WHERE chave_calc IS NOT NULL
        GROUP BY chave_calc;
    END IF;
END;
$function$;

-- ═══════════════════════════════════════════════════════════════════════
-- 13. EXECUTE: internas sem acesso publico (o mesmo estado da 0129); CREATE OR REPLACE preserva o ACL das demais
-- ═══════════════════════════════════════════════════════════════════════
REVOKE ALL ON FUNCTION hub_campanha_turnos_extrato_q(int, date, date, int, text[], text[], text[], text[], numeric, numeric, numeric, int, timestamptz, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION hub_campanha_turnos_extrato("Campanha", int)    FROM PUBLIC;
REVOKE ALL ON FUNCTION hub_campanha_recalcular_extrato("Campanha")     FROM PUBLIC;
REVOKE ALL ON FUNCTION hub_campanha_recalcular_interno(int)            FROM PUBLIC;
REVOKE ALL ON FUNCTION hub_campanha_item_json("Campanha")              FROM PUBLIC;
REVOKE ALL ON FUNCTION hub_campanha_publico_cnpjs("Campanha")          FROM PUBLIC;
REVOKE ALL ON FUNCTION hub_campanha_visivel("Campanha", int)           FROM PUBLIC;
-- ═══════════════════════════════════════════════════════════════════════
-- 14. Recalculo das campanhas em andamento (a regra de descarte/praca mudou: ranking e lista do app nao divergem ate a proxima importacao)
-- ═══════════════════════════════════════════════════════════════════════
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT id FROM "Campanha" WHERE lancada_em IS NOT NULL AND cancelada_em IS NULL AND fechada_em IS NULL ORDER BY id LOOP
        BEGIN
            PERFORM hub_campanha_recalcular_interno(r.id);
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING '0133: recalculo da campanha % falhou: %', r.id, SQLERRM;
        END;
    END LOOP;
END
$$;

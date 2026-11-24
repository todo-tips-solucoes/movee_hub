\set ON_ERROR_STOP on
BEGIN;
-- ROLLBACK da 0131 (categorias: modo "Todas, exceto as marcadas" + familia Indicadores).
--
-- ATENCAO (plano §7): a casa() antiga leria 'modo:todas' como NOME de categoria e as excecoes virariam as UNICAS
-- categorias que contam. Por isso o bloco 1 ABORTA se qualquer configuracao VIGENTE/agendada/recalculavel
-- ou campanha tiver token `modo:` ou `familia:indicador`. O operador volta as listas para "So as marcadas"
-- pela tela (e tira o indicador das campanhas) ANTES de desfazer. Nada e apagado por este script.
--
-- Restaura as definicoes anteriores: casa()/familia() da 0087, configuracao_salvar da 0111, hub_adiantamento_categorias
-- da 0087, hub_campanha_categorias/_ok/salvar/lancar da 0129. Remove os 3 CHECKs, tokens_ok() e familias().
-- Idempotente.

DO $$
BEGIN
    -- Configuracao que ainda pode CALCULAR com a lista: a vigente de cada empresa (regra de hub_adiantamento_config_vigente),
    -- qualquer versao agendada (vigente_desde > now()) e a referenciada por solicitacao ainda recalculavel
    -- (AGUARDANDO_CORTE / AGUARDANDO_PRODUCAO: hub_adiantamento_recalcular e o worker releem a configuracao dela).
    IF EXISTS (
        SELECT 1 FROM "AdiantamentoConfiguracao" c
        WHERE (c.id IN (SELECT DISTINCT ON (v.id_empresa) v.id FROM "AdiantamentoConfiguracao" v
                        WHERE v.vigente_desde <= now() ORDER BY v.id_empresa, v.vigente_desde DESC, v.versao DESC)
               OR c.vigente_desde > now()
               OR c.id IN (SELECT s.configuracao_id FROM "AdiantamentoSolicitacao" s WHERE s.status IN ('AGUARDANDO_CORTE', 'AGUARDANDO_PRODUCAO')))
          AND EXISTS (SELECT 1 FROM unnest(COALESCE(c.categorias_producao, '{}') || COALESCE(c.categorias_extrato, '{}')
                                           || COALESCE(c.categorias_nota, '{}')) x
                      WHERE x LIKE 'modo:%' OR x = 'familia:indicador')
    ) THEN
        RAISE EXCEPTION 'ROLLBACK_0131_RECUSADO: ha configuracao vigente, agendada ou de solicitacao recalculavel com modo:todas/familia:indicador — volte a lista para "So as marcadas" pela tela';
    END IF;
    IF EXISTS (SELECT 1 FROM "Campanha" k
               WHERE k.categorias IS NOT NULL
                 AND EXISTS (SELECT 1 FROM unnest(k.categorias) x WHERE x LIKE 'modo:%' OR x = 'familia:indicador')) THEN
        RAISE EXCEPTION 'ROLLBACK_0131_RECUSADO: ha campanha com modo:/familia:indicador — troque as categorias antes';
    END IF;
END $$;

ALTER TABLE "AdiantamentoConfiguracao" DROP CONSTRAINT IF EXISTS adiantamentoconfiguracao_categorias_producao_tokens_chk;
ALTER TABLE "AdiantamentoConfiguracao" DROP CONSTRAINT IF EXISTS adiantamentoconfiguracao_categorias_extrato_tokens_chk;
ALTER TABLE "AdiantamentoConfiguracao" DROP CONSTRAINT IF EXISTS adiantamentoconfiguracao_categorias_nota_tokens_chk;

CREATE OR REPLACE FUNCTION hub_adiantamento_categoria_familia(p_descricao text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        -- "Promoção -" com c/ç/Ç/� e a/ã/Ã/�. Exige o hífen: "Promocao entregador" NÃO entra.
        WHEN p_descricao ~* ('^promo[c' || chr(231) || chr(199) || chr(65533) || ']'
                             || '[a' || chr(227) || chr(195) || chr(65533) || ']o\s*-')
            THEN 'familia:promocao'
        -- "MISSOES"/"Missões"/"Miss�es" como palavra inteira no início.
        WHEN p_descricao ~* ('^miss[o' || chr(245) || chr(213) || chr(65533) || ']es\y')
            THEN 'familia:missoes'
    END;
$$;

CREATE OR REPLACE FUNCTION hub_adiantamento_categoria_casa(p_descricao text, p_categorias text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
    SELECT COALESCE(
        p_descricao = ANY (p_categorias)
        OR hub_adiantamento_categoria_familia(p_descricao) = ANY (p_categorias),
        false);
$$;

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
            desconto_adiantamentos, desconto_debitos, repasse_visivel_app,
            notas_pendentes_corte_modo, notas_pendentes_corte_dias, notas_pendentes_corte_data,
            criado_por, motivo
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
            -- 0111: corte das notas pendentes do motorista. Sem isto, salvar qualquer
            -- outro campo voltaria o corte ao default em vez de manter o vigente.
            COALESCE(p_dados ->> 'notasPendentesCorteModo', v_atual.notas_pendentes_corte_modo, 'data'),
            COALESCE((p_dados ->> 'notasPendentesCorteDias')::int, v_atual.notas_pendentes_corte_dias, 90),
            COALESCE((p_dados ->> 'notasPendentesCorteData')::date, v_atual.notas_pendentes_corte_data, DATE '2026-07-20'),
            v_sub,
            p_dados ->> 'motivo'
        ) RETURNING * INTO v_nova;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'VERSAO_DESATUALIZADA';
    END;

    RETURN v_nova;
END;
$$;

CREATE OR REPLACE FUNCTION hub_campanha_categorias_ok(p text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
    SELECT p IS NOT NULL AND cardinality(p) BETWEEN 1 AND 60
       AND NOT EXISTS (SELECT 1 FROM unnest(p) x WHERE x IS NULL OR char_length(x) NOT BETWEEN 1 AND 200);
$$;

DROP FUNCTION IF EXISTS hub_adiantamento_categorias(text);
CREATE FUNCTION hub_adiantamento_categorias(p_fonte text DEFAULT NULL)
RETURNS TABLE (descricao text, lancamentos bigint, sem_motorista_identificado boolean, familia text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT f.descricao, count(*), bool_or(f.entregador_id IS NULL),
           hub_adiantamento_categoria_familia(f.descricao)
    FROM "FaturamentoLancamento" f
    WHERE f.id_empresa = ANY (hub_jwt_escopo_ids())
      AND f.tipo = 'Credito'
      AND f.data_referencia >= ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 90)
    GROUP BY f.descricao
    HAVING count(f.entregador_id) > 0
    ORDER BY f.descricao;
$$;
REVOKE ALL ON FUNCTION hub_adiantamento_categorias(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_categorias(text) TO authenticated;

DROP FUNCTION IF EXISTS hub_campanha_categorias();
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
REVOKE ALL ON FUNCTION hub_campanha_categorias() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_campanha_categorias() TO authenticated;

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

DROP FUNCTION IF EXISTS hub_adiantamento_categorias_tokens_ok(text[]);
DROP FUNCTION IF EXISTS hub_adiantamento_familias();

COMMIT;

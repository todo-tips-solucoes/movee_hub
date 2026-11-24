-- 0131 — Categorias do adiantamento: modo "Todas, exceto as marcadas" + familia "Indicadores".
--
-- Plano aprovado: docs/plans/adiantamento-motorista/PLANO-CATEGORIAS-TODAS-EXCETO.md (§4 modelo, §6 pilares, §7 rollback).
-- Aditiva e idempotente, sem coluna nova. NAO edita migration aplicada: as funcoes sao redefinidas aqui por CREATE OR
-- REPLACE (ou DROP + CREATE quando o retorno muda) com o corpo VIVO + a mudanca.
--
-- O QUE MUDA
--  * O modo vive na PROPRIA lista, como token (igual as familias da 0087):
--      ['modo:todas','familia:indicador','Gorjeta'] = todas as categorias EXCETO indicadores e Gorjeta
--      ['Corridas concluidas','familia:promocao']   = so essas (como hoje; listas existentes nao mudam)
--    So `hub_adiantamento_categoria_casa` muda: todos os chamadores (producao, extrato e nota do repasse,
--    apuracao, campanha extrato) a herdam. Verificado na definicao VIVA: nenhum filtra com `= ANY` direto.
--  * hub_adiantamento_familias(): fonte unica das familias no banco (usada pela validacao e pela campanha).
--  * Familia 'familia:indicador' = nome que comeca com "Percentual atingido" (indicador, nao dinheiro do entregador).
--  * hub_adiantamento_categorias_tokens_ok(text[]): `modo:` so 'modo:todas' (no maximo 1); `familia:` so as de
--    familias(); sem NULL. Usada em CHECK das 3 listas e no salvar (erro DADOS_INVALIDOS_CATEGORIAS).
--  * Campanha: aceita as familias de familias() (inclui indicador) e RECUSA `modo:` (VALIDACAO/categorias).
--  * hub_adiantamento_categorias(text) e hub_campanha_categorias() ganham a coluna `primeira date`
--    (DATA DE CHEGADA: min(criado_em em America/Sao_Paulo) das linhas da janela de 90 dias por data_referencia;
--    nao min(data_referencia), senao a importacao D-1 nunca dispara o aviso de categoria nova) -> DROP + CREATE com os mesmos GRANTs e a mesma checagem de escopo.
--
-- ATENCAO NO CORPO DA casa(): `NOT (a OR b)` com `b` NULL (categoria avulsa tem familia NULL) daria NULL e a categoria
-- SUMIRIA do modo "todas". Por isso cada comparacao e embrulhada em COALESCE(.., false).
--
-- ROLLBACK: infra/hub/testes/sql/0131-rollback.sql (recusa se houver lista em modo:todas ou familia:indicador).

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Familias, familia(), casa(), validacao de tokens
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION hub_adiantamento_familias()
RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $$
    SELECT ARRAY['familia:promocao', 'familia:missoes', 'familia:indicador']::text[];
$$;

-- Ramos de promocao e missoes IDENTICOS aos da 0087; so entra o de indicador.
CREATE OR REPLACE FUNCTION hub_adiantamento_categoria_familia(p_descricao text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_descricao ~* ('^promo[c' || chr(231) || chr(199) || chr(65533) || ']'
                             || '[a' || chr(227) || chr(195) || chr(65533) || ']o\s*-')
            THEN 'familia:promocao'
        WHEN p_descricao ~* ('^miss[o' || chr(245) || chr(213) || chr(65533) || ']es\y')
            THEN 'familia:missoes'
        -- "Percentual atingido de rotas completas / hora online / garantido": indicador, nao dinheiro.
        -- ILIKE (nao regex): mais barato por linha; "Percentual atingido ..." com um espaco, como chega do relatorio.
        WHEN p_descricao ILIKE 'percentual atingido%'
            THEN 'familia:indicador'
    END;
$$;

-- modo:todas -> tudo ENTRA, menos o nome exato e a familia listados (excecoes). Sem o token: como na 0087.
-- NULL/vazio/descricao NULL -> false.
CREATE OR REPLACE FUNCTION hub_adiantamento_categoria_casa(p_descricao text, p_categorias text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
    SELECT COALESCE(
        CASE WHEN 'modo:todas' = ANY (p_categorias)
             THEN p_descricao IS NOT NULL
                  AND NOT (COALESCE(p_descricao = ANY (p_categorias), false)
                           OR COALESCE(hub_adiantamento_categoria_familia(p_descricao) = ANY (p_categorias), false))
             ELSE p_descricao = ANY (p_categorias)
                  OR hub_adiantamento_categoria_familia(p_descricao) = ANY (p_categorias)
        END,
        false);
$$;

CREATE OR REPLACE FUNCTION hub_adiantamento_categorias_tokens_ok(p text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
    SELECT p IS NULL OR (
        NOT EXISTS (SELECT 1 FROM unnest(p) x WHERE x IS NULL)
        AND (SELECT count(*) FROM unnest(p) x WHERE x LIKE 'modo:%') <= 1
        AND NOT EXISTS (SELECT 1 FROM unnest(p) x WHERE x LIKE 'modo:%' AND x <> 'modo:todas')
        AND NOT EXISTS (SELECT 1 FROM unnest(p) x WHERE x LIKE 'familia:%' AND x <> ALL (hub_adiantamento_familias()))
    );
$$;

-- CHECK nas 3 listas. Se algum dado antigo violar, entra NOT VALID (vale para linhas novas) com aviso.
DO $$
DECLARE
    c text;
    v_ruins bigint;
BEGIN
    FOREACH c IN ARRAY ARRAY['categorias_producao', 'categorias_extrato', 'categorias_nota'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'adiantamentoconfiguracao_' || c || '_tokens_chk') THEN
            EXECUTE format('SELECT count(*) FROM "AdiantamentoConfiguracao" WHERE NOT hub_adiantamento_categorias_tokens_ok(%I)', c)
                INTO v_ruins;
            EXECUTE format('ALTER TABLE "AdiantamentoConfiguracao" ADD CONSTRAINT %I CHECK (hub_adiantamento_categorias_tokens_ok(%I))%s',
                           'adiantamentoconfiguracao_' || c || '_tokens_chk', c,
                           CASE WHEN v_ruins > 0 THEN ' NOT VALID' ELSE '' END);
            IF v_ruins > 0 THEN
                RAISE WARNING '0131: % linha(s) antigas de % violam a regra de tokens; CHECK criado NOT VALID', v_ruins, c;
            END IF;
        END IF;
    END LOOP;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Salvar da configuracao (corpo VIVO da 0111 + validacao dos tokens)
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

    -- 0131: tokens das 3 listas (modo:todas, familia:*). Token desconhecido e RECUSADO: no modo "todas" uma
    -- excecao com erro de digitacao faria contar dinheiro que nao devia.
    IF (p_dados ? 'categoriasProducao' AND jsonb_typeof(p_dados -> 'categoriasProducao') <> 'array')
       OR (p_dados ? 'categoriasExtrato' AND jsonb_typeof(p_dados -> 'categoriasExtrato') <> 'array')
       OR (p_dados ? 'categoriasNota' AND jsonb_typeof(p_dados -> 'categoriasNota') <> 'array') THEN
        RAISE EXCEPTION 'DADOS_INVALIDOS_CATEGORIAS';
    END IF;
    IF NOT hub_adiantamento_categorias_tokens_ok((SELECT array_agg(x) FROM jsonb_array_elements_text(p_dados -> 'categoriasProducao') x))
       OR NOT hub_adiantamento_categorias_tokens_ok((SELECT array_agg(x) FROM jsonb_array_elements_text(p_dados -> 'categoriasExtrato') x))
       OR NOT hub_adiantamento_categorias_tokens_ok((SELECT array_agg(x) FROM jsonb_array_elements_text(p_dados -> 'categoriasNota') x)) THEN
        RAISE EXCEPTION 'DADOS_INVALIDOS_CATEGORIAS';
    END IF;

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

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Seletores de categoria: ganham `primeira` (muda o retorno -> DROP + CREATE + GRANT)
-- ═══════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS hub_adiantamento_categorias(text);
CREATE FUNCTION hub_adiantamento_categorias(p_fonte text DEFAULT NULL)
RETURNS TABLE (descricao text, lancamentos bigint, sem_motorista_identificado boolean, familia text, primeira date)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT f.descricao, count(*), bool_or(f.entregador_id IS NULL),
           hub_adiantamento_categoria_familia(f.descricao), (min(f.criado_em) AT TIME ZONE 'America/Sao_Paulo')::date
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
CREATE FUNCTION hub_campanha_categorias()
RETURNS TABLE (descricao text, lancamentos bigint, sem_motorista_identificado boolean, familia text, primeira date)
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
           hub_adiantamento_categoria_familia(f.descricao), (min(f.criado_em) AT TIME ZONE 'America/Sao_Paulo')::date
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

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Campanha: familias vem de hub_adiantamento_familias(); `modo:` recusado
-- ═══════════════════════════════════════════════════════════════════════

-- 1..60 itens, 1..200 caracteres, sem NULL; token `familia:` so de familias(); NENHUM `modo:` (a campanha nao tem o modo).
CREATE OR REPLACE FUNCTION hub_campanha_categorias_ok(p text[])
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
    SELECT p IS NOT NULL AND cardinality(p) BETWEEN 1 AND 60
       AND NOT EXISTS (SELECT 1 FROM unnest(p) x WHERE x IS NULL OR char_length(x) NOT BETWEEN 1 AND 200)
       AND NOT EXISTS (SELECT 1 FROM unnest(p) x WHERE x LIKE 'modo:%')
       AND NOT EXISTS (SELECT 1 FROM unnest(p) x WHERE x LIKE 'familia:%' AND x <> ALL (hub_adiantamento_familias()));
$$;

-- (corpo VIVO da 0129; unica mudanca: a validacao de familia sai daqui e fica em hub_campanha_categorias_ok)
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
        IF v_cats IS NOT NULL AND NOT hub_campanha_categorias_ok(v_cats) THEN
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

-- (corpo VIVO da 0129; unica mudanca: familias aceitas = hub_adiantamento_familias(); `modo:` tambem e recusado)
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
END;
$$;

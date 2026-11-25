-- 0132 — Campanhas: interruptor de visibilidade no app + so a posicao do motorista (sem o total).
--
-- Plano aprovado (24/11/2026): docs/plans/campanhas-motorista/PLANO-VISIBILIDADE-APP.md (P1-P7, secao 4).
-- Aditiva e idempotente. NAO edita migration aplicada: as funcoes sao redefinidas por CREATE OR REPLACE com o
-- corpo VIVO (0127 / 0129 / 0131) + a mudanca. O registro em "SchemaMigration" e feito pelo migrate.sh.
--
--  * Campanha.visivel_app (default false: toda campanha nasce oculta). MUTAVEL depois de lancar (entra em v_livres).
--  * hub_campanha_visivel: + AND c.visivel_app -> uma regra so; lista, card, detalhe, turnos e foto obedecem.
--  * Push de inicio so com visivel_app (sai na 1a varredura em que estiver visivel no periodo);
--    push de fim so se visivel no fechamento (aviso_fim_em e marcado nos dois casos).
--  * hub_campanha_visibilidade(p_id, p_visivel): troca auditada (Auditoria), empresa ativa + campanhas.gerir.
--  * hub_campanha_salvar aceita visivelApp; hub_campanha_item_json devolve visivelApp.
--  * hub_motorista_campanha SEM totalClassificados; hub_motorista_campanhas SEM total (e sem o count(*)).
--
-- ROLLBACK: reaplicar as definicoes de 0127/0129/0131 destas funcoes e, se preciso, DROP da coluna/funcao nova
-- (nenhum dado depende dela; hoje ha 0 campanhas em producao).

ALTER TABLE "Campanha" ADD COLUMN IF NOT EXISTS visivel_app boolean NOT NULL DEFAULT false;

-- Auditoria da troca de visibilidade: UM so ponto (RPC do interruptor e salvar do formulario). Interna.
CREATE OR REPLACE FUNCTION hub_campanha_auditar_visibilidade(p_id int, p_de boolean, p_para boolean)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    INSERT INTO "Auditoria" (id_empresa, usuario_id, acao, recurso, recurso_id, detalhes)
    SELECT c.id_empresa, NULLIF(hub_jwt_claims() ->> 'sub', '')::int, 'campanha.visibilidade', 'Campanha', c.id::text,
           jsonb_build_object('de', p_de, 'para', p_para, 'nome', c.nome)
    FROM "Campanha" c WHERE c.id = p_id;
$$;

REVOKE ALL ON FUNCTION hub_campanha_auditar_visibilidade(int, boolean, boolean) FROM PUBLIC;

CREATE OR REPLACE FUNCTION hub_campanha_imutavel_trg()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    -- única coisa que pode mudar depois de lançada; coluna nova nasce IMUTÁVEL por padrão
    v_livres text[] := ARRAY['cancelada_por', 'cancelada_em', 'motivo_cancelamento', 'fechada_em',
                             'dados_ate', 'aviso_inicio_em', 'aviso_fim_em',
                             'visivel_app'];
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
                         AND upper(btrim(pt.subpraca)) = ANY (c.pracas)));
$$;


CREATE OR REPLACE FUNCTION hub_campanhas_avisar_inicio()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    r        RECORD;
    c        "Campanha";
    v_cnpjs  text[];
    v_n      int := 0;
BEGIN
    IF NOT hub_jwt_push_worker() THEN
        RAISE EXCEPTION 'PERMISSAO_NEGADA' USING ERRCODE = '42501';
    END IF;

    FOR r IN
        SELECT id FROM "Campanha"
        WHERE lancada_em IS NOT NULL AND cancelada_em IS NULL AND avisar AND visivel_app AND aviso_inicio_em IS NULL
          AND hub_hoje_sp() BETWEEN data_inicio AND data_fim
          -- M3: no dia de início só a partir das 08:00 de SP (não acordar o motorista à meia-noite)
          AND (hub_hoje_sp() > data_inicio OR hub_hora_sp() >= time '08:00')
        ORDER BY id
        FOR UPDATE SKIP LOCKED
    LOOP
        SELECT * INTO c FROM "Campanha" WHERE id = r.id;
        v_cnpjs := hub_campanha_publico_cnpjs(c);
        IF cardinality(v_cnpjs) > 0 THEN
            PERFORM hub_notificacao_enfileirar(
                c.id_empresa, 'empresa', ARRAY[c.id_empresa], v_cnpjs, 'sistema',
                'Nova campanha',
                left('A campanha ' || c.nome, 120) || ' começou. Veja como participar.',
                '/campanhas/' || c.id::text);
            v_n := v_n + 1;
        END IF;
        UPDATE "Campanha" SET aviso_inicio_em = now() WHERE id = r.id;
    END LOOP;
    RETURN v_n;
END;
$$;


CREATE OR REPLACE FUNCTION hub_campanha_fechar_interno(p_id int)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    c       "Campanha";
    v_cnpjs text[];
BEGIN
    SELECT * INTO c FROM "Campanha" WHERE id = p_id FOR UPDATE;
    IF NOT FOUND OR c.fechada_em IS NOT NULL OR c.cancelada_em IS NOT NULL OR c.lancada_em IS NULL THEN RETURN; END IF;

    PERFORM hub_campanha_recalcular_interno(p_id);

    INSERT INTO "CampanhaVencedor" (campanha_id, posicao, id_empresa, entregador_id, premio_id)
    SELECT r.campanha_id, r.posicao, r.id_empresa, r.entregador_id, p.id
    FROM "CampanhaRanking" r
    JOIN "CampanhaPremio" p ON p.campanha_id = r.campanha_id AND r.posicao BETWEEN p.posicao_de AND p.posicao_ate
    WHERE r.campanha_id = p_id AND r.situacao = 'classificado'
    ON CONFLICT (campanha_id, posicao) DO NOTHING;

    UPDATE "Campanha" SET fechada_em = now() WHERE id = p_id;

    IF c.avisar AND c.aviso_fim_em IS NULL THEN
        SELECT COALESCE(array_agg(DISTINCT cm.cnpj_prestador), '{}') INTO v_cnpjs
        FROM "CampanhaRanking" r
        JOIN "Entregador" e ON e.id = r.entregador_id
        JOIN "ContaMotorista" cm ON cm.id = e.motorista_id AND cm.ativo
        WHERE r.campanha_id = p_id;
        -- 0132: oculta no fechamento = sem push; aviso_fim_em e marcado abaixo do mesmo jeito (nao sai depois)
        IF c.visivel_app AND cardinality(v_cnpjs) > 0 THEN
            PERFORM hub_notificacao_enfileirar(
                c.id_empresa, 'empresa', ARRAY[c.id_empresa], v_cnpjs, 'sistema',
                'Resultado da campanha',
                left('A campanha ' || c.nome, 120) || ' terminou. Veja sua posição.',
                '/campanhas/' || c.id::text);
        END IF;
        UPDATE "Campanha" SET aviso_fim_em = now() WHERE id = p_id;
    END IF;
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
    v_visivel    boolean;
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

    -- 0132: visivelApp (ausente: INSERT = false, UPDATE = mantem o valor atual; nao-boolean = VALIDACAO)
    IF jsonb_typeof(p_dados -> 'visivelApp') = 'boolean' THEN v_visivel := (p_dados ->> 'visivelApp')::boolean;
    ELSIF p_dados -> 'visivelApp' IS NULL OR jsonb_typeof(p_dados -> 'visivelApp') = 'null' THEN
        v_visivel := CASE WHEN p_id IS NULL THEN false ELSE c.visivel_app END;   -- ausente: nasce oculta; edicao mantem
    ELSE RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'visivelApp';
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
            tipo, categorias, min_turnos_base, visivel_app)
        VALUES (
            p_id_empresa, v_nome, v_desc, v_ini, v_fim, v_pracas, v_turnos, v_modais, v_min,
            v_pa, v_pc, v_pt, v_pp, v_ca, v_cc, v_ct, v_cp, v_avisar, v_sub,
            v_tipo, v_cats, v_base, v_visivel)
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
            visivel_app = v_visivel
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


CREATE OR REPLACE FUNCTION hub_campanha_item_json(c "Campanha")
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', c.id, 'nome', c.nome, 'situacao', hub_campanha_situacao(c),
        'visivelApp', c.visivel_app,
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
                  ORDER BY k.posicao) t), '[]'::jsonb) END);
END;
$$;

-- Troca do interruptor: qualquer situacao menos cancelada (rascunho incluso). So grava e audita se mudou.
CREATE OR REPLACE FUNCTION hub_campanha_visibilidade(p_id int, p_visivel boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    c "Campanha";
BEGIN
    c := hub_campanha_carregar(p_id, 'campanhas.gerir', true);
    IF p_visivel IS NULL THEN
        RAISE EXCEPTION 'VALIDACAO' USING ERRCODE = '22023', DETAIL = 'visivel';
    END IF;
    IF c.cancelada_em IS NOT NULL THEN
        RAISE EXCEPTION 'CAMPANHA_SITUACAO_INVALIDA' USING ERRCODE = '55000';
    END IF;
    IF c.visivel_app IS DISTINCT FROM p_visivel THEN
        UPDATE "Campanha" SET visivel_app = p_visivel WHERE id = c.id;
        PERFORM hub_campanha_auditar_visibilidade(c.id, c.visivel_app, p_visivel);
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION hub_campanha_visibilidade(int, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_campanha_visibilidade(int, boolean) TO authenticated;

-- 0067 — Funções, trigger de transições e RPCs da feature "Adiantamento pelo
-- App, Dados Bancários e Exportação Transfeera" (tasks.md 1.2;
-- contracts/sql-rpc.md; data-model.md §State Transitions). Depende de 0066
-- (tabelas, incluindo ApuracaoRepasse/ApuracaoRepasseItem e o estado
-- ENCERRADA, acrescentados por D-23). CRIA `hub_adiantamento_repasse_fechar`
-- e `hub_adiantamento_encerrar_falha` — desbloqueadas por D-23 (operador
-- 2026-09-17), que resolveu CHK025/tarefa 4.5: fechamento recusado
-- (409 APURACAO_COM_PENDENCIAS) enquanto houver solicitação não-finalizada
-- no período; novo estado terminal ENCERRADA via FALHOU->ENCERRADA. NÃO cria
-- `hub_notificacao_*` nem a versão
-- final de `hub_adiantamento_notificar` — dependem de "NotificacaoMotorista"
-- e das colunas `Aviso.origem/categoria`, que só existem a partir de 0068
-- (FASE 5); aqui `hub_adiantamento_notificar` é um stub no-op documentado,
-- substituído (`CREATE OR REPLACE`) por 0068.
--
-- 1.6 (onda-007/008, dec-043 — revisão da sessão pai sobre esta migration):
-- ajustada no lugar, já que só existiu em stacks efêmeros hub-test-* até
-- aqui (regra 3 da execução).
--   1.6.1 `hub_adiantamento_recalcular` passa a exigir `AGUARDANDO_PRODUCAO`
--   (antes aceitava também LIBERADA/INELEGIVEL — violava edge #24 e a tabela
--   de transições); o cálculo produção→bruto→líquido→snapshot foi extraído
--   para a função interna `hub_adiantamento_calcular_liberacao`, reusada
--   pelo tick.
--   1.6.2 CRIA as RPCs do worker (`hub_adiantamento_processar`,
--   `_lote_orfaos`, `_expurgo_arquivos`) — adiadas na versão anterior desta
--   migration para quando `lib/adiantamento-worker.js` (FASE 3) fosse
--   escrito; entram aqui porque a 3.3 só as chama e o contrato
--   (`sql-rpc.md §Worker`) já as descrevia sem nenhuma tarefa que as criasse.
--   1.6.3 `hub_adiantamento_repasse_fechar` passa a recusar
--   `PERIODO_EM_ABERTO` enquanto a produção do último dia da janela ainda
--   puder ser solicitada (D-1 até o corte do dia seguinte) — antes fechava
--   mesmo com o período corrente ainda em curso.
--
-- Convenções herdadas (padrão 0061_push_avisos.sql, 0006_rls_policies.sql):
--   toda função de negócio é `SECURITY DEFINER SET search_path = public,
--   pg_temp`; `REVOKE ALL … FROM PUBLIC` + `GRANT EXECUTE … TO authenticated`
--   só nas funções chamadas via PostgREST (app/hub) — as "internas" (1.2.1)
--   ficam SEM grant, chamadas função-a-função sob o mesmo dono (ignora o
--   REVOKE, mesmo raciocínio de hub_aviso_alcance em 0061). Erros de negócio
--   saem como `RAISE EXCEPTION '<CODIGO>'`.
--
-- Claims usadas (contracts/sql-rpc.md §Claims): `motorista_cnpj` (app),
-- `sub`/`empresa_ativa`/`escopo` (hub), `hub_adiantamento_worker` (nova,
-- FASE 3).

-- ═══════════════════════════════════════════════════════════════════════
-- 1.2.1 — Funções internas (sem GRANT a `authenticated`)
-- ═══════════════════════════════════════════════════════════════════════

-- hub_jwt_adiantamento_worker() — claim booleana do tick/worker (FASE 3),
-- mesmo padrão de hub_jwt_push_worker (0061:32-37). Ainda sem nenhum caller
-- nesta migration; existe desde já para a claim poder ser testada em
-- isolamento (tasks.md 3.4.2) e para 0068+ não precisar recriá-la.
CREATE OR REPLACE FUNCTION hub_jwt_adiantamento_worker()
RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE((hub_jwt_claims() ->> 'hub_adiantamento_worker')::boolean, false);
$$;

-- hub_adiantamento_integration_id — "ADV-NNNNNN"; sem truncar para ids
-- >= 1.000.000 (plan.md "lpad trunca" — lpad(p_id::text,6,'0') com um texto
-- de 7+ dígitos devolveria só os últimos 6, por isso o ramo sem lpad acima
-- do limite).
CREATE OR REPLACE FUNCTION hub_adiantamento_integration_id(p_id bigint)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_id < 1000000 THEN 'ADV-' || lpad(p_id::text, 6, '0')
        ELSE 'ADV-' || p_id::text
    END;
$$;

-- hub_adiantamento_mascarar — helper de mascaramento (dec-023, CHK010);
-- não está nos 7 nomes de contracts/sql-rpc.md §Internas, mas é utilitário
-- privado no mesmo espírito de hub_normaliza_nome (0021) — sem GRANT.
CREATE OR REPLACE FUNCTION hub_adiantamento_mascarar(p_valor text, p_visiveis int DEFAULT 4)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_valor IS NULL THEN NULL
        WHEN char_length(p_valor) <= p_visiveis THEN repeat('*', char_length(p_valor))
        ELSE repeat('*', char_length(p_valor) - p_visiveis) || right(p_valor, p_visiveis)
    END;
$$;

-- hub_adiantamento_config_vigente — maior vigente_desde <= now() da empresa.
CREATE OR REPLACE FUNCTION hub_adiantamento_config_vigente(p_id_empresa int)
RETURNS "AdiantamentoConfiguracao"
LANGUAGE sql STABLE
AS $$
    SELECT c.*
    FROM "AdiantamentoConfiguracao" c
    WHERE c.id_empresa = p_id_empresa AND c.vigente_desde <= now()
    ORDER BY c.vigente_desde DESC, c.versao DESC
    LIMIT 1;
$$;

-- hub_adiantamento_config_completa — extraída para uso em _disponibilidade
-- (informativo) E _solicitar (bloqueio, dec-053/FR-025): fonte/categorias
-- da produção e os 3 campos de apuração semanal (Q-B2/Q-B3) preenchidos.
CREATE OR REPLACE FUNCTION hub_adiantamento_config_completa(p_config "AdiantamentoConfiguracao")
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
    SELECT p_config.fonte_producao IS NOT NULL
        AND (
            p_config.fonte_producao = 'performance_taxas'
            OR (p_config.categorias_producao IS NOT NULL AND cardinality(p_config.categorias_producao) > 0)
        )
        AND p_config.apuracao_dia_inicio IS NOT NULL
        AND p_config.apuracao_dias_ate_repasse IS NOT NULL
        AND p_config.apuracao_data_base IS NOT NULL;
$$;

-- hub_adiantamento_janela — fronteiras no fuso da versão (research.md
-- Decision 2): abertura <= agora < corte; D-1 calendário puro (R-01, sem
-- dia útil/feriado). `p_instante` só vem de now() nas RPCs públicas — nenhum
-- caller aceita horário do cliente (edge #27).
CREATE OR REPLACE FUNCTION hub_adiantamento_janela(p_config "AdiantamentoConfiguracao", p_instante timestamptz)
RETURNS TABLE (
    data_solicitacao date,
    data_producao    date,
    dia_habilitado   boolean,
    antes_abertura   boolean,
    apos_corte       boolean
)
LANGUAGE sql STABLE
AS $$
    SELECT
        (p_instante AT TIME ZONE p_config.timezone)::date AS data_solicitacao,
        (p_instante AT TIME ZONE p_config.timezone)::date - 1 AS data_producao,
        extract(dow FROM (p_instante AT TIME ZONE p_config.timezone))::smallint = ANY (p_config.dias_habilitados) AS dia_habilitado,
        (p_instante AT TIME ZONE p_config.timezone)::time < p_config.horario_abertura AS antes_abertura,
        (p_instante AT TIME ZONE p_config.timezone)::time >= p_config.horario_corte AS apos_corte;
$$;

-- hub_adiantamento_producao — disponibilidade + valor da fonte configurada
-- (research.md Decision 7/8). `disponivel=false` sempre que a fonte não
-- está configurada, não há nenhuma linha da fonte na data, OU há
-- ImportacaoArquivo do tipo correspondente em andamento — dissociado de
-- "produção = 0" (que é um resultado válido, tratado por quem chama como
-- SEM_PRODUCAO, R-09).
CREATE OR REPLACE FUNCTION hub_adiantamento_producao(
    p_entregador_id int,
    p_data          date,
    p_config        "AdiantamentoConfiguracao"
)
RETURNS TABLE (
    disponivel    boolean,
    valor         numeric(12,2),
    lancamentos   int,
    por_categoria jsonb
)
LANGUAGE plpgsql STABLE
AS $$
#variable_conflict use_column
DECLARE
    v_id_empresa       int;
    v_tipo_importacao  text;
    v_bloqueada        boolean;
    v_existe           boolean;
    v_valor            numeric(12,2) := 0;
    v_qtd              int := 0;
    v_por_cat          jsonb := '{}'::jsonb;
BEGIN
    SELECT e.id_empresa INTO v_id_empresa FROM "Entregador" e WHERE e.id = p_entregador_id;

    IF p_config.fonte_producao IS NULL THEN
        RETURN QUERY SELECT false, 0::numeric(12,2), 0, '{}'::jsonb;
        RETURN;
    END IF;

    v_tipo_importacao := CASE
        WHEN p_config.fonte_producao IN ('financeiro_lancamento', 'financeiro_referencia') THEN 'faturamento'
        ELSE 'performance'
    END;

    IF v_tipo_importacao = 'faturamento' THEN
        SELECT EXISTS (
            SELECT 1 FROM "FaturamentoLancamento" f
            WHERE f.id_empresa = v_id_empresa
              AND ((p_config.fonte_producao = 'financeiro_lancamento' AND f.data_lancamento = p_data)
                OR (p_config.fonte_producao = 'financeiro_referencia' AND f.data_referencia = p_data))
        ) INTO v_existe;
    ELSE
        SELECT EXISTS (
            SELECT 1 FROM "PerformanceTurno" pt
            WHERE pt.id_empresa = v_id_empresa AND pt.data_periodo = p_data
        ) INTO v_existe;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM "ImportacaoArquivo" ia
        WHERE ia.id_empresa = v_id_empresa AND ia.tipo = v_tipo_importacao
          AND ia.status IN ('pending', 'validating', 'processing')
    ) INTO v_bloqueada;

    IF NOT v_existe OR v_bloqueada THEN
        RETURN QUERY SELECT false, 0::numeric(12,2), 0, '{}'::jsonb;
        RETURN;
    END IF;

    IF v_tipo_importacao = 'faturamento' THEN
        SELECT COALESCE(sum(f.valor), 0), count(*)
        INTO v_valor, v_qtd
        FROM "FaturamentoLancamento" f
        WHERE f.id_empresa = v_id_empresa AND f.entregador_id = p_entregador_id
          AND f.tipo = 'Credito' AND f.descricao = ANY (p_config.categorias_producao)
          AND ((p_config.fonte_producao = 'financeiro_lancamento' AND f.data_lancamento = p_data)
            OR (p_config.fonte_producao = 'financeiro_referencia' AND f.data_referencia = p_data));

        SELECT COALESCE(jsonb_object_agg(sub.descricao, sub.total::text), '{}'::jsonb)
        INTO v_por_cat
        FROM (
            SELECT f.descricao, sum(f.valor) AS total
            FROM "FaturamentoLancamento" f
            WHERE f.id_empresa = v_id_empresa AND f.entregador_id = p_entregador_id
              AND f.tipo = 'Credito' AND f.descricao = ANY (p_config.categorias_producao)
              AND ((p_config.fonte_producao = 'financeiro_lancamento' AND f.data_lancamento = p_data)
                OR (p_config.fonte_producao = 'financeiro_referencia' AND f.data_referencia = p_data))
            GROUP BY f.descricao
        ) sub;
    ELSE
        SELECT COALESCE(round(sum(pt.taxas_centavos) / 100.0, 2), 0), count(*)
        INTO v_valor, v_qtd
        FROM "PerformanceTurno" pt
        WHERE pt.id_empresa = v_id_empresa AND pt.entregador_id = p_entregador_id AND pt.data_periodo = p_data;

        -- [PROPOSTA]: performance_taxas não tem "categorias" (PerformanceTurno
        -- não tem coluna descricao); por_categoria vira uma única chave.
        v_por_cat := jsonb_build_object('performance_taxas', v_valor::text);
    END IF;

    RETURN QUERY SELECT true, v_valor, v_qtd, v_por_cat;
END;
$$;

-- hub_adiantamento_bruto_liquido — arredondamento meio-para-cima (D-06/R-07)
-- extraído de dentro de `hub_adiantamento_calcular_liberacao` (3.7.1) para
-- ser reusado por `hub_adiantamento_disponibilidade` na prévia `estimate` —
-- sem repetir a fórmula e sem herdar o `RAISE EXCEPTION 'NO_BANK_ACCOUNT'`
-- de `calcular_liberacao` (a prévia não pode derrubar a leitura por falta de
-- conta aprovada: isso já aparece como `reason` à parte).
CREATE OR REPLACE FUNCTION hub_adiantamento_bruto_liquido(p_valor_producao numeric, p_config "AdiantamentoConfiguracao")
RETURNS TABLE (bruto numeric(12,2), liquido numeric(12,2))
LANGUAGE sql IMMUTABLE
AS $$
    SELECT round(p_valor_producao * p_config.percentual / 100, 2) AS bruto,
           round(p_valor_producao * p_config.percentual / 100, 2) - p_config.taxa_fixa AS liquido;
$$;

-- hub_adiantamento_elegibilidade — 3.8.1 (revisão da sessão pai, dec-076):
-- mesma regra de `hub_adiantamento_calcular_liberacao` (produção zero ->
-- SEM_PRODUCAO; líquido <= 0 -> VALOR_INSUFICIENTE), extraída para ser
-- reusada pela prévia de `_disponibilidade` sem duplicar a comparação —
-- antes disso, a prévia devolvia `estimate.net` negativo (produção
-- baixa/taxa alta) sem sinalizar que a solicitação real cairia em
-- INELEGIVEL, e o mesmo bug alcançava até produção=0 (líquido = 0 - taxa,
-- sempre negativo com taxa_fixa > 0).
CREATE OR REPLACE FUNCTION hub_adiantamento_elegibilidade(p_valor_producao numeric, p_liquido numeric)
RETURNS TABLE (elegivel boolean, motivo text)
LANGUAGE sql IMMUTABLE
AS $$
    SELECT (p_valor_producao <> 0 AND p_liquido > 0),
           CASE WHEN p_valor_producao = 0 THEN 'SEM_PRODUCAO'
                WHEN p_liquido <= 0 THEN 'VALOR_INSUFICIENTE'
                ELSE NULL END;
$$;

-- hub_adiantamento_calcular_liberacao — 1.6.1: cálculo puro (produção →
-- bruto meio para cima → líquido → snapshot da conta aprovada →
-- LIBERADA/INELEGIVEL), extraído para ser reusado por
-- `hub_adiantamento_recalcular` (ação manual) e por
-- `hub_adiantamento_processar` (tick, 1.6.2). Não faz nenhum UPDATE — quem
-- chama decide as colunas a gravar e como tratar "produção indisponível"
-- (`disponivel = false`): o recalcular levanta `PRODUCAO_INDISPONIVEL`
-- (ação explícita do financeiro, falha e não muda nada — edge #24); o tick
-- marca `AGUARDANDO_PRODUCAO` com `tentativas_producao + 1` e tenta de novo
-- no próximo tick, indefinidamente (edge #7/#23). Sem conta aprovada no
-- momento em que liberaria (raro — `hub_adiantamento_solicitar` já exige
-- conta aprovada na criação), levanta `NO_BANK_ACCOUNT` — mesmo código que
-- o recalcular sempre expôs; o tick captura por linha (ver
-- hub_adiantamento_processar) para não derrubar o lote inteiro.
CREATE OR REPLACE FUNCTION hub_adiantamento_calcular_liberacao(
    p_entregador_id int,
    p_data_producao date,
    p_config        "AdiantamentoConfiguracao"
)
RETURNS TABLE (
    disponivel         boolean,
    valor_bruto        numeric(12,2),
    valor_liquido      numeric(12,2),
    novo_status        text,
    motivo             text,
    conta_bancaria_id  bigint,
    prod_valor         numeric(12,2),
    prod_lancamentos   int,
    prod_por_categoria jsonb
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_prod    RECORD;
    v_bruto   numeric(12,2);
    v_liquido numeric(12,2);
    v_status  text;
    v_motivo  text;
    v_elegivel boolean;
    v_conta_bancaria_id bigint;
BEGIN
    SELECT * INTO v_prod FROM hub_adiantamento_producao(p_entregador_id, p_data_producao, p_config);

    IF NOT v_prod.disponivel THEN
        RETURN QUERY SELECT false, NULL::numeric(12,2), NULL::numeric(12,2), NULL::text, NULL::text,
            NULL::bigint, v_prod.valor, v_prod.lancamentos, v_prod.por_categoria;
        RETURN;
    END IF;

    -- Arredondamento meio-para-cima (D-06/R-07): round(numeric,2) do
    -- Postgres já arredonda empates para longe do zero — via o helper
    -- extraído (3.7.1), reusado também pela prévia de `_disponibilidade`.
    SELECT bl.bruto, bl.liquido INTO v_bruto, v_liquido
    FROM hub_adiantamento_bruto_liquido(v_prod.valor, p_config) bl;

    -- 3.8.1: mesma regra de `hub_adiantamento_elegibilidade`, reusada pela
    -- prévia de `_disponibilidade` (sem duplicar a comparação aqui). Alias
    -- `e.` obrigatório: `motivo` também é OUT param desta função (RETURNS
    -- TABLE), e sem `#variable_conflict use_column` um `motivo` desqualificado
    -- é ambíguo entre a variável e a coluna do retorno de `_elegibilidade`.
    SELECT e.elegivel, e.motivo INTO v_elegivel, v_motivo
    FROM hub_adiantamento_elegibilidade(v_prod.valor, v_liquido) e;

    IF NOT v_elegivel THEN
        v_status := 'INELEGIVEL';
    ELSE
        -- R-10: ao liberar, snapshot da conta APROVADA vigente.
        SELECT cb.id INTO v_conta_bancaria_id
        FROM "ContaBancariaMotorista" cb WHERE cb.entregador_id = p_entregador_id AND cb.status = 'APROVADA';
        IF v_conta_bancaria_id IS NULL THEN
            RAISE EXCEPTION 'NO_BANK_ACCOUNT';
        END IF;
        v_status := 'LIBERADA'; v_motivo := NULL;
    END IF;

    RETURN QUERY SELECT true, v_bruto, v_liquido, v_status, v_motivo, v_conta_bancaria_id,
        v_prod.valor, v_prod.lancamentos, v_prod.por_categoria;
END;
$$;

-- hub_adiantamento_transicao_valida — tabela de transições da máquina de
-- estados de AdiantamentoSolicitacao (data-model.md §State Transitions,
-- PLANO §11.1). Lista fechada e literal.
CREATE OR REPLACE FUNCTION hub_adiantamento_transicao_valida(p_de text, p_para text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
    SELECT (p_de, p_para) IN (
        ('AGUARDANDO_CORTE',    'CANCELADA'),
        ('AGUARDANDO_CORTE',    'AGUARDANDO_PRODUCAO'),
        ('AGUARDANDO_CORTE',    'INELEGIVEL'),
        ('AGUARDANDO_CORTE',    'LIBERADA'),
        ('AGUARDANDO_PRODUCAO', 'LIBERADA'),
        ('AGUARDANDO_PRODUCAO', 'INELEGIVEL'),
        ('AGUARDANDO_PRODUCAO', 'REJEITADA'),
        ('LIBERADA',            'REJEITADA'),
        ('LIBERADA',            'EM_LOTE'),
        ('EM_LOTE',             'LIBERADA'),
        ('EM_LOTE',             'EXPORTADA'),
        ('EXPORTADA',           'LIBERADA'),
        ('EXPORTADA',           'PAGA'),
        ('EXPORTADA',           'FALHOU'),
        ('FALHOU',              'LIBERADA'),
        -- D-23 (operador 2026-09-17): falha que não será mais paga — estado
        -- terminal novo, motivo obrigatório (CHECK em 0066).
        ('FALHOU',              'ENCERRADA')
    );
$$;

-- hub_adiantamento_notificar — STUB da FASE 1: "NotificacaoMotorista" e as
-- colunas "Aviso".origem/categoria só existem a partir de 0068 (FASE 5,
-- plan.md Project Structure). Corpo substituído por 0068 via CREATE OR
-- REPLACE — as RPCs desta migration já chamam a assinatura final, sem
-- precisar mexer de novo nelas na FASE 5. Até lá, é no-op deliberado.
CREATE OR REPLACE FUNCTION hub_adiantamento_notificar(p_solicitacao_id bigint, p_evento text)
RETURNS void
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
BEGIN
    RETURN;
END;
$$;

-- hub_adiantamento_tem_permissao — segunda barreira de RBAC (dec-023,
-- security CHK006): mesma leitura de UsuarioEntidade/PapelPermissao/
-- Permissao que backend/lib/hub-rbac-cache.js:carregarPermissoesDoBanco faz
-- no Node, e confere que o módulo está ativo para a empresa_ativa.
CREATE OR REPLACE FUNCTION hub_adiantamento_tem_permissao(p_codigo text)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sub     int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_empresa int := NULLIF(hub_jwt_claims() ->> 'empresa_ativa', '')::int;
BEGIN
    IF v_sub IS NULL OR v_empresa IS NULL THEN
        RETURN false;
    END IF;

    RETURN EXISTS (
        SELECT 1
        FROM "UsuarioEntidade" ue
        JOIN "PapelPermissao" pp ON pp.papel_id = ue.papel_id
        JOIN "Permissao" perm ON perm.id = pp.permissao_id
        JOIN "ModuloEntidade" me ON me.modulo_id = perm.modulo_id AND me.empresa_id = ue.empresa_id
        WHERE ue.usuario_id = v_sub
          AND ue.empresa_id = v_empresa
          AND ue.ativo
          AND me.ativo
          AND perm.codigo = p_codigo
    );
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 1.2.2 — Trigger de transição de AdiantamentoSolicitacao.status
-- ═══════════════════════════════════════════════════════════════════════

-- Roda dentro das funções SECURITY DEFINER que fazem UPDATE ... SET status
-- (current_user já é o dono da tabela nesse contexto) — não precisa ser
-- SECURITY DEFINER ela mesma para conseguir inserir em AdiantamentoEvento
-- (que não tem GRANT INSERT a `authenticated`).
CREATE OR REPLACE FUNCTION hub_adiantamento_solicitacao_transicao_trigger()
RETURNS trigger
LANGUAGE plpgsql
AS $$
#variable_conflict use_column
DECLARE
    v_ator_tipo       text;
    v_ator_usuario_id int;
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT hub_adiantamento_transicao_valida(OLD.status, NEW.status) THEN
            RAISE EXCEPTION 'TRANSICAO_INVALIDA';
        END IF;

        IF hub_jwt_motorista_cnpj() IS NOT NULL THEN
            v_ator_tipo := 'motorista';
            v_ator_usuario_id := NULL;
        ELSIF NULLIF(hub_jwt_claims() ->> 'sub', '') IS NOT NULL THEN
            v_ator_tipo := 'usuario';
            v_ator_usuario_id := (hub_jwt_claims() ->> 'sub')::int;
        ELSE
            v_ator_tipo := 'sistema';
            v_ator_usuario_id := NULL;
        END IF;

        INSERT INTO "AdiantamentoEvento" (solicitacao_id, id_empresa, status_de, status_para, ator_tipo, ator_usuario_id)
        VALUES (NEW.id, NEW.id_empresa, OLD.status, NEW.status, v_ator_tipo, v_ator_usuario_id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_adiantamentosolicitacao_transicao ON "AdiantamentoSolicitacao";
CREATE TRIGGER trg_adiantamentosolicitacao_transicao
    BEFORE UPDATE OF status ON "AdiantamentoSolicitacao"
    FOR EACH ROW
    EXECUTE FUNCTION hub_adiantamento_solicitacao_transicao_trigger();

-- ═══════════════════════════════════════════════════════════════════════
-- 1.2.3 — RPCs do app do motorista (claims motorista_cnpj + escopo)
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION hub_adiantamento_disponibilidade()
RETURNS TABLE (
    vinculado             boolean,
    modulo_ativo          boolean,
    configuracao_id       bigint,
    configuracao_completa boolean,
    dias_habilitados      smallint[],
    horario_abertura      time,
    horario_corte         time,
    percentual            numeric,
    taxa_fixa             numeric,
    previsao_pagamento_texto text,
    dia_habilitado        boolean,
    antes_abertura        boolean,
    apos_corte            boolean,
    data_solicitacao      date,
    data_producao         date,
    conta_aprovada        jsonb,
    conta_pendente        jsonb,
    solicitacao_do_dia    jsonb,
    motivo_indisponivel   text,
    -- 3.7.1/3.7.3 (revisão da sessão pai, dec-071): `configuracao_versao` é a
    -- versão de EXIBIÇÃO (protótipo M06/M15 mostra "versão 3"), distinta de
    -- `configuracao_id` (PK, identificador enviado em `_solicitar`/`POST
    -- /adiantamentos`) — os dois eixos nunca foram o mesmo número na prática
    -- (dec-069 corrigiu a fiação para o PK; esta correção só separa exibição
    -- de identificador, não desfaz aquela). `estimate` é a prévia D-1
    -- (produção→bruto→líquido) exigida por PLANO §16.1/protótipo M03/M06.
    configuracao_versao  int,
    estimate             jsonb
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
    v_janela             RECORD;
    v_completa           boolean;
    v_modulo_ativo       boolean;
    v_aprovada           "ContaBancariaMotorista";
    v_pendente           "ContaBancariaMotorista";
    v_sol                "AdiantamentoSolicitacao";
    v_prod               RECORD;
    v_bruto              numeric(12,2);
    v_liquido            numeric(12,2);
    v_elegivel           boolean;
    v_estimate           jsonb;
BEGIN
    IF v_cnpj IS NULL THEN
        RETURN QUERY SELECT false, false, NULL::bigint, false, NULL::smallint[], NULL::time, NULL::time,
            NULL::numeric, NULL::numeric, NULL::text, false, false, false, NULL::date, NULL::date,
            NULL::jsonb, NULL::jsonb, NULL::jsonb, 'NAO_AUTENTICADO'::text, NULL::int, NULL::jsonb;
        RETURN;
    END IF;

    SELECT cm.id INTO v_conta_motorista_id FROM "ContaMotorista" cm WHERE cm.cnpj_prestador = v_cnpj AND cm.ativo;
    IF v_conta_motorista_id IS NULL THEN
        RETURN QUERY SELECT false, false, NULL::bigint, false, NULL::smallint[], NULL::time, NULL::time,
            NULL::numeric, NULL::numeric, NULL::text, false, false, false, NULL::date, NULL::date,
            NULL::jsonb, NULL::jsonb, NULL::jsonb, 'NOT_LINKED'::text, NULL::int, NULL::jsonb;
        RETURN;
    END IF;

    SELECT e.* INTO v_entregador FROM "Entregador" e WHERE e.motorista_id = v_conta_motorista_id AND e.ativo LIMIT 1;
    IF NOT FOUND THEN
        RETURN QUERY SELECT false, false, NULL::bigint, false, NULL::smallint[], NULL::time, NULL::time,
            NULL::numeric, NULL::numeric, NULL::text, false, false, false, NULL::date, NULL::date,
            NULL::jsonb, NULL::jsonb, NULL::jsonb, 'NOT_LINKED'::text, NULL::int, NULL::jsonb;
        RETURN;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM "ModuloEntidade" me JOIN "Modulo" m ON m.id = me.modulo_id
        WHERE me.empresa_id = v_entregador.id_empresa AND m.codigo = 'adiantamentos' AND me.ativo AND m.ativo
    ) INTO v_modulo_ativo;

    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(v_entregador.id_empresa);
    IF v_config.id IS NULL THEN
        RETURN QUERY SELECT true, v_modulo_ativo, NULL::bigint, false, NULL::smallint[], NULL::time, NULL::time,
            NULL::numeric, NULL::numeric, NULL::text, false, false, false, NULL::date, NULL::date,
            NULL::jsonb, NULL::jsonb, NULL::jsonb, 'NOT_CONFIGURED'::text, NULL::int, NULL::jsonb;
        RETURN;
    END IF;

    v_completa := hub_adiantamento_config_completa(v_config);

    SELECT * INTO v_janela FROM hub_adiantamento_janela(v_config, now());

    SELECT * INTO v_aprovada FROM "ContaBancariaMotorista" WHERE entregador_id = v_entregador.id AND status = 'APROVADA';
    SELECT * INTO v_pendente FROM "ContaBancariaMotorista" WHERE entregador_id = v_entregador.id AND status = 'PENDENTE';
    SELECT * INTO v_sol FROM "AdiantamentoSolicitacao"
        WHERE entregador_id = v_entregador.id AND data_solicitacao = v_janela.data_solicitacao AND status <> 'CANCELADA';

    -- 3.7.1: prévia D-1 via as próprias funções internas (sem GRANT novo —
    -- chamadas de dentro de uma SECURITY DEFINER já autorizada); nunca
    -- levanta exceção por falta de conta aprovada (isso é `reason` à parte,
    -- não impede a prévia financeira de aparecer).
    SELECT * INTO v_prod FROM hub_adiantamento_producao(v_entregador.id, v_janela.data_producao, v_config);
    v_bruto := NULL; v_liquido := NULL; v_elegivel := NULL;
    IF v_prod.disponivel THEN
        SELECT bl.bruto, bl.liquido INTO v_bruto, v_liquido FROM hub_adiantamento_bruto_liquido(v_prod.valor, v_config) bl;
        -- 3.8.1 (dec-076): mesma regra de `hub_adiantamento_calcular_liberacao`
        -- (via `hub_adiantamento_elegibilidade`, sem duplicar a fórmula) —
        -- produção 0 ou líquido <= 0 já cairia em INELEGIVEL ao solicitar; a
        -- prévia não pode devolver `net` negativo sem sinalizar isso, senão o
        -- app mostraria um valor a receber que nunca vai existir.
        SELECT elegivel INTO v_elegivel FROM hub_adiantamento_elegibilidade(v_prod.valor, v_liquido);
    END IF;
    v_estimate := jsonb_build_object(
        'available', v_prod.disponivel,
        'production', CASE WHEN v_prod.disponivel THEN v_prod.valor ELSE NULL END,
        'gross', v_bruto,
        'fee', v_config.taxa_fixa,
        'net', CASE WHEN v_elegivel IS FALSE THEN NULL ELSE v_liquido END,
        'eligible', v_elegivel,
        'final', false
    );

    RETURN QUERY SELECT
        true, v_modulo_ativo, v_config.id, v_completa,
        v_config.dias_habilitados, v_config.horario_abertura, v_config.horario_corte,
        v_config.percentual, v_config.taxa_fixa, v_config.previsao_pagamento_texto,
        v_janela.dia_habilitado, v_janela.antes_abertura, v_janela.apos_corte,
        v_janela.data_solicitacao, v_janela.data_producao,
        CASE WHEN v_aprovada.id IS NULL THEN NULL ELSE hub_conta_bancaria_mascarar(v_aprovada) END,
        CASE WHEN v_pendente.id IS NULL THEN NULL ELSE hub_conta_bancaria_mascarar(v_pendente) END,
        CASE WHEN v_sol.id IS NULL THEN NULL ELSE (to_jsonb(v_sol) - 'aceite_texto_sha256') END,
        NULL::text,
        v_config.versao, v_estimate;
END;
$$;

-- hub_adiantamento_solicitar — revalida R-02..R-05 com now(); idempotente
-- por (conta_motorista_id, chave); violação do índice único do dia vira
-- ALREADY_REQUESTED (edge #11, FR-001/FR-050).
CREATE OR REPLACE FUNCTION hub_adiantamento_solicitar(
    p_configuracao_id bigint,
    p_aceite_sha256   text,
    p_chave           uuid
)
RETURNS TABLE (id bigint, status text, reutilizado boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj               text := hub_jwt_motorista_cnpj();
    v_conta_motorista_id int;
    v_entregador         RECORD;
    v_vigente            "AdiantamentoConfiguracao";
    v_janela             RECORD;
    v_existente           RECORD;
    v_novo_id            bigint;
BEGIN
    IF v_cnpj IS NULL THEN
        RAISE EXCEPTION 'NAO_AUTENTICADO';
    END IF;

    SELECT cm.id INTO v_conta_motorista_id FROM "ContaMotorista" cm WHERE cm.cnpj_prestador = v_cnpj AND cm.ativo;
    IF v_conta_motorista_id IS NULL THEN
        RAISE EXCEPTION 'NOT_LINKED';
    END IF;

    SELECT s.id, s.status INTO v_existente
    FROM "AdiantamentoSolicitacao" s
    WHERE s.conta_motorista_id = v_conta_motorista_id AND s.chave_idempotencia = p_chave;
    IF FOUND THEN
        RETURN QUERY SELECT v_existente.id, v_existente.status, true;
        RETURN;
    END IF;

    SELECT e.* INTO v_entregador FROM "Entregador" e WHERE e.motorista_id = v_conta_motorista_id AND e.ativo LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NOT_LINKED';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM "ModuloEntidade" me JOIN "Modulo" m ON m.id = me.modulo_id
        WHERE me.empresa_id = v_entregador.id_empresa AND m.codigo = 'adiantamentos' AND me.ativo AND m.ativo
    ) THEN
        RAISE EXCEPTION 'MODULO_DESABILITADO';
    END IF;

    SELECT * INTO v_vigente FROM hub_adiantamento_config_vigente(v_entregador.id_empresa);
    IF v_vigente.id IS NULL OR v_vigente.id IS DISTINCT FROM p_configuracao_id THEN
        RAISE EXCEPTION 'VERSAO_DESATUALIZADA';
    END IF;

    -- FR-025/dec-053: bloqueia novas solicitações enquanto a config vigente
    -- não estiver completa (fonte/categorias da produção + apuração
    -- semanal, Q-B2/Q-B3) — antes só _disponibilidade calculava isso
    -- (informativo); _solicitar não impedia a criação.
    IF NOT hub_adiantamento_config_completa(v_vigente) THEN
        RAISE EXCEPTION 'NOT_CONFIGURED';
    END IF;

    SELECT * INTO v_janela FROM hub_adiantamento_janela(v_vigente, now());
    IF NOT v_janela.dia_habilitado THEN
        RAISE EXCEPTION 'DAY_NOT_ALLOWED';
    ELSIF v_janela.antes_abertura THEN
        RAISE EXCEPTION 'BEFORE_OPENING';
    ELSIF v_janela.apos_corte THEN
        RAISE EXCEPTION 'AFTER_CUTOFF';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM "ContaBancariaMotorista" WHERE entregador_id = v_entregador.id AND status = 'APROVADA') THEN
        IF EXISTS (SELECT 1 FROM "ContaBancariaMotorista" WHERE entregador_id = v_entregador.id AND status = 'PENDENTE') THEN
            RAISE EXCEPTION 'BANK_ACCOUNT_PENDING';
        ELSE
            RAISE EXCEPTION 'NO_BANK_ACCOUNT';
        END IF;
    END IF;

    IF p_aceite_sha256 IS NULL OR char_length(p_aceite_sha256) <> 64 THEN
        RAISE EXCEPTION 'ACEITE_INVALIDO';
    END IF;

    BEGIN
        INSERT INTO "AdiantamentoSolicitacao" (
            id_empresa, conta_motorista_id, cnpj_prestador, entregador_id, configuracao_id,
            data_solicitacao, data_producao, aceite_texto_sha256, status, chave_idempotencia
        ) VALUES (
            v_entregador.id_empresa, v_conta_motorista_id, v_cnpj, v_entregador.id, v_vigente.id,
            v_janela.data_solicitacao, v_janela.data_producao, p_aceite_sha256, 'AGUARDANDO_CORTE', p_chave
        ) RETURNING "AdiantamentoSolicitacao".id INTO v_novo_id;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'ALREADY_REQUESTED';
    END;

    INSERT INTO "AdiantamentoEvento" (solicitacao_id, id_empresa, status_de, status_para, ator_tipo)
    VALUES (v_novo_id, v_entregador.id_empresa, NULL, 'AGUARDANDO_CORTE', 'motorista');

    PERFORM hub_adiantamento_notificar(v_novo_id, 'criada');

    RETURN QUERY SELECT v_novo_id, 'AGUARDANDO_CORTE'::text, false;
END;
$$;

-- hub_adiantamento_cancelar — só do próprio CNPJ, AGUARDANDO_CORTE e antes
-- do corte da versão da própria solicitação (R-12).
CREATE OR REPLACE FUNCTION hub_adiantamento_cancelar(p_id bigint)
RETURNS TABLE (id bigint, status text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj   text := hub_jwt_motorista_cnpj();
    v_sol    "AdiantamentoSolicitacao";
    v_config "AdiantamentoConfiguracao";
    v_janela RECORD;
BEGIN
    IF v_cnpj IS NULL THEN
        RAISE EXCEPTION 'NAO_AUTENTICADO';
    END IF;

    SELECT * INTO v_sol FROM "AdiantamentoSolicitacao" WHERE id = p_id AND cnpj_prestador = v_cnpj;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NAO_ENCONTRADA';
    END IF;
    IF v_sol.status <> 'AGUARDANDO_CORTE' THEN
        RAISE EXCEPTION 'TRANSICAO_INVALIDA';
    END IF;

    SELECT * INTO v_config FROM "AdiantamentoConfiguracao" WHERE id = v_sol.configuracao_id;
    SELECT * INTO v_janela FROM hub_adiantamento_janela(v_config, now());
    IF v_janela.apos_corte THEN
        RAISE EXCEPTION 'AFTER_CUTOFF';
    END IF;

    UPDATE "AdiantamentoSolicitacao" SET status = 'CANCELADA' WHERE id = p_id;

    RETURN QUERY SELECT p_id, 'CANCELADA'::text;
END;
$$;

CREATE OR REPLACE FUNCTION hub_adiantamento_listar_motorista(p_pagina int DEFAULT 1, p_tamanho_pagina int DEFAULT 20)
RETURNS TABLE (
    id bigint, status text, data_solicitacao date, data_producao date,
    valor_bruto numeric, valor_liquido numeric, motivo_status text, total bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj  text := hub_jwt_motorista_cnpj();
    v_total bigint;
BEGIN
    IF v_cnpj IS NULL THEN RETURN; END IF;

    SELECT count(*) INTO v_total FROM "AdiantamentoSolicitacao" s WHERE s.cnpj_prestador = v_cnpj;

    RETURN QUERY
    SELECT s.id, s.status, s.data_solicitacao, s.data_producao, s.valor_bruto, s.valor_liquido, s.motivo_status, v_total
    FROM "AdiantamentoSolicitacao" s
    WHERE s.cnpj_prestador = v_cnpj
    ORDER BY s.data_solicitacao DESC
    LIMIT GREATEST(p_tamanho_pagina, 1) OFFSET GREATEST(p_pagina - 1, 0) * GREATEST(p_tamanho_pagina, 1);
END;
$$;

-- 3.7.2 (revisão da sessão pai, dec-071): devolve o RETRATO gravado com a
-- solicitação — a versão da config aceita (`configuracao_versao`/
-- `previsao_pagamento_texto`, via o FK imutável `configuracao_id` — cada
-- config é uma linha nova, nunca editada) e a conta snapshot
-- (`conta_bancaria_id`, só gravada a partir do cálculo — LIBERADA em
-- diante). Antes disso `conta_bancaria_mascarada` é `null`: não existe
-- retrato ainda, e mostrar a conta ATUALMENTE aprovada seria inventar um
-- dado que pode nunca ter sido o que valeu nesta solicitação
-- (Constitution VI) — nunca a config/conta correntes.
CREATE OR REPLACE FUNCTION hub_adiantamento_detalhe_motorista(p_id bigint)
RETURNS TABLE (solicitacao jsonb, eventos jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj   text := hub_jwt_motorista_cnpj();
    v_sol    "AdiantamentoSolicitacao";
    v_config "AdiantamentoConfiguracao";
    v_conta  "ContaBancariaMotorista";
    v_extra  jsonb;
BEGIN
    IF v_cnpj IS NULL THEN RETURN; END IF;

    SELECT * INTO v_sol FROM "AdiantamentoSolicitacao" WHERE id = p_id AND cnpj_prestador = v_cnpj;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT * INTO v_config FROM "AdiantamentoConfiguracao" WHERE id = v_sol.configuracao_id;
    IF v_sol.conta_bancaria_id IS NOT NULL THEN
        SELECT * INTO v_conta FROM "ContaBancariaMotorista" WHERE id = v_sol.conta_bancaria_id;
    END IF;

    v_extra := jsonb_build_object(
        'configuracao_versao', v_config.versao,
        'previsao_pagamento_texto', v_config.previsao_pagamento_texto,
        'conta_bancaria_mascarada', CASE WHEN v_conta.id IS NULL THEN NULL ELSE hub_conta_bancaria_mascarar(v_conta) END
    );

    RETURN QUERY
    SELECT
        (to_jsonb(v_sol) - 'aceite_texto_sha256') || v_extra,
        COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'statusDe', ev.status_de, 'statusPara', ev.status_para,
                'ocorridoEm', ev.ocorrido_em, 'motivo', ev.motivo
            ) ORDER BY ev.ocorrido_em)
            FROM "AdiantamentoEvento" ev WHERE ev.solicitacao_id = p_id
        ), '[]'::jsonb);
END;
$$;

-- hub_adiantamento_mascarar_email — 3.2/dec-074: máscara "xx••••@•••.tld"
-- (mesma do protótipo M12/M13: "jo••••@•••.com") — só o prefixo de 2
-- caracteres do local-part e a extensão do domínio ficam visíveis.
CREATE OR REPLACE FUNCTION hub_adiantamento_mascarar_email(p_email text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_email IS NULL THEN NULL
        ELSE left(split_part(p_email, '@', 1), 2) || '••••@•••' || substring(p_email FROM '\.[^.@]*$')
    END;
$$;

-- hub_conta_bancaria_mascarar — usada tanto pelo app (própria conta) quanto
-- pelo hub (listagem sem `contas_revisar`); mascaramento no SQL (dec-023).
-- `chavePixTipo`/`emailComprovante` (3.2/dec-074): lacunas reais de dado que
-- faltavam para `GET /motorista/conta-bancaria` (contracts/motorista-api.md)
-- — `chavePixTipo` sai cru (é só o enum, não revela a chave);
-- `emailComprovante` sai mascarado (nunca o e-mail completo, mesmo sendo o
-- dono da própria conta — mesma politica de "nunca dado cru fora da revisão
-- dedicada" que já vale para conta/documento).
-- `origem` (correção onda-017, FASE 4/4.3): faltava no jsonb — hub-api.md
-- exige `ContaMascarada.origem` (`GET /contas`) e `aprovar-lote` (Q-N5)
-- precisa distinguir `CARGA_INICIAL` das demais para elegibilidade. 0067 só
-- existiu em stacks efêmeros até aqui (mesmo critério da correção 1.6/dec-053)
-- — ajustada no lugar.
CREATE OR REPLACE FUNCTION hub_conta_bancaria_mascarar(p_conta "ContaBancariaMotorista")
RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $$
    SELECT jsonb_build_object(
        'id', p_conta.id,
        'status', p_conta.status,
        'origem', p_conta.origem,
        'titularNome', p_conta.titular_nome,
        'titularDocumento', hub_adiantamento_mascarar(p_conta.titular_documento, 2),
        'bancoCodigo', p_conta.banco_codigo,
        'bancoNome', p_conta.banco_nome,
        'agencia', p_conta.agencia,
        'conta', hub_adiantamento_mascarar(p_conta.conta, 2),
        'contaDigito', p_conta.conta_digito,
        'tipoConta', p_conta.tipo_conta,
        'chavePixTipo', p_conta.chave_pix_tipo,
        'emailComprovante', hub_adiantamento_mascarar_email(p_conta.email_comprovante),
        'alertas', p_conta.alertas,
        'motivoRejeicao', p_conta.motivo_rejeicao,
        'solicitadaEm', p_conta.solicitada_em,
        'revisadaEm', p_conta.revisada_em
    );
$$;

CREATE OR REPLACE FUNCTION hub_conta_bancaria_motorista()
RETURNS TABLE (aprovada jsonb, pendente jsonb, ultima_rejeitada jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj         text := hub_jwt_motorista_cnpj();
    v_entregador_id int;
    v_aprovada     "ContaBancariaMotorista";
    v_pendente     "ContaBancariaMotorista";
    v_rejeitada    "ContaBancariaMotorista";
BEGIN
    IF v_cnpj IS NULL THEN RETURN; END IF;

    SELECT e.id INTO v_entregador_id
    FROM "Entregador" e JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
    WHERE cm.cnpj_prestador = v_cnpj;
    IF v_entregador_id IS NULL THEN RETURN; END IF;

    SELECT * INTO v_aprovada FROM "ContaBancariaMotorista" WHERE entregador_id = v_entregador_id AND status = 'APROVADA';
    SELECT * INTO v_pendente FROM "ContaBancariaMotorista" WHERE entregador_id = v_entregador_id AND status = 'PENDENTE';
    SELECT * INTO v_rejeitada FROM "ContaBancariaMotorista"
        WHERE entregador_id = v_entregador_id AND status = 'REJEITADA'
        ORDER BY revisada_em DESC NULLS LAST LIMIT 1;

    RETURN QUERY SELECT
        CASE WHEN v_aprovada.id IS NULL THEN NULL ELSE hub_conta_bancaria_mascarar(v_aprovada) END,
        CASE WHEN v_pendente.id IS NULL THEN NULL ELSE hub_conta_bancaria_mascarar(v_pendente) END,
        CASE WHEN v_rejeitada.id IS NULL THEN NULL ELSE hub_conta_bancaria_mascarar(v_rejeitada) END;
END;
$$;

-- hub_conta_bancaria_solicitar — revalida formatos via os próprios CHECKs da
-- tabela (0066); DV completo (CPF/CNPJ) é responsabilidade de
-- backend/lib/adiantamento-conta.js (FASE 2, Project Structure) — não
-- duplicado aqui (ponytail: uma fonte só do algoritmo de dígito
-- verificador). Cancela a PENDENTE anterior antes de inserir a nova (só uma
-- PENDENTE por entregador, índice único parcial de 0066).
CREATE OR REPLACE FUNCTION hub_conta_bancaria_solicitar(p_dados jsonb)
RETURNS TABLE (id bigint, status text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj        text := hub_jwt_motorista_cnpj();
    v_entregador  RECORD;
    v_alertas     jsonb := '[]'::jsonb;
    v_novo_id     bigint;
    v_titular_tipo text;
BEGIN
    IF v_cnpj IS NULL THEN
        RAISE EXCEPTION 'NAO_AUTENTICADO';
    END IF;

    SELECT e.*, cm.nome AS conta_nome INTO v_entregador
    FROM "Entregador" e JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
    WHERE cm.cnpj_prestador = v_cnpj AND cm.ativo AND e.ativo;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NOT_LINKED';
    END IF;

    v_titular_tipo := CASE WHEN char_length(p_dados ->> 'titularDocumento') = 14 THEN 'PJ' ELSE 'PF' END;

    IF hub_normaliza_nome(p_dados ->> 'titularNome') <> hub_normaliza_nome(v_entregador.conta_nome) THEN
        v_alertas := v_alertas || jsonb_build_array('TITULAR_DIFERENTE');
    END IF;

    UPDATE "ContaBancariaMotorista" SET status = 'CANCELADA'
    WHERE entregador_id = v_entregador.id AND status = 'PENDENTE';

    INSERT INTO "ContaBancariaMotorista" (
        id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo,
        banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta,
        chave_pix_tipo, chave_pix, email_comprovante, alertas
    ) VALUES (
        v_entregador.id_empresa, v_entregador.id, 'APP', 'PENDENTE',
        btrim(p_dados ->> 'titularNome'), p_dados ->> 'titularDocumento', v_titular_tipo,
        p_dados ->> 'bancoCodigo', p_dados ->> 'bancoNome', p_dados ->> 'agencia',
        p_dados ->> 'conta', p_dados ->> 'contaDigito', p_dados ->> 'tipoConta',
        NULLIF(p_dados ->> 'chavePixTipo', ''), NULLIF(p_dados ->> 'chavePix', ''),
        NULLIF(p_dados ->> 'emailComprovante', ''), v_alertas
    ) RETURNING "ContaBancariaMotorista".id INTO v_novo_id;

    RETURN QUERY SELECT v_novo_id, 'PENDENTE'::text;
END;
$$;

-- hub_adiantamento_repasse_motorista — previsão do período corrente; vazio
-- se repasse_visivel_app = false (D-13).
CREATE OR REPLACE FUNCTION hub_adiantamento_repasse_motorista()
RETURNS TABLE (visivel boolean, periodo_inicio date, periodo_fim date, data_repasse date, previsao numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj        text := hub_jwt_motorista_cnpj();
    v_conta_motorista_id int;
    v_entregador  RECORD;
    v_config      "AdiantamentoConfiguracao";
    v_inicio      date;
    v_fim         date;
    v_pagos       numeric;
BEGIN
    IF v_cnpj IS NULL THEN RETURN; END IF;
    SELECT cm.id INTO v_conta_motorista_id FROM "ContaMotorista" cm WHERE cm.cnpj_prestador = v_cnpj;
    IF v_conta_motorista_id IS NULL THEN RETURN; END IF;
    SELECT e.* INTO v_entregador FROM "Entregador" e WHERE e.motorista_id = v_conta_motorista_id;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(v_entregador.id_empresa);
    IF v_config.id IS NULL OR NOT v_config.repasse_visivel_app OR v_config.apuracao_dia_inicio IS NULL THEN
        RETURN QUERY SELECT false, NULL::date, NULL::date, NULL::date, NULL::numeric;
        RETURN;
    END IF;

    v_inicio := current_date - ((extract(dow FROM current_date)::int - v_config.apuracao_dia_inicio + 7) % 7);
    v_fim := v_inicio + 6;

    SELECT COALESCE(sum(s.valor_bruto), 0) INTO v_pagos
    FROM "AdiantamentoSolicitacao" s
    WHERE s.entregador_id = v_entregador.id AND s.status IN ('PAGA', 'EXPORTADA')
      AND s.data_producao BETWEEN v_inicio AND v_fim;

    RETURN QUERY SELECT true, v_inicio, v_fim, v_fim + v_config.apuracao_dias_ate_repasse, v_pagos;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- 1.2.4/1.2.5/1.2.6 — RPCs do hub (claims sub, empresa_ativa, escopo)
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION hub_adiantamento_rejeitar(p_id bigint, p_motivo text)
RETURNS TABLE (id bigint, status text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sol "AdiantamentoSolicitacao";
BEGIN
    SELECT * INTO v_sol FROM "AdiantamentoSolicitacao" WHERE id = p_id AND id_empresa = ANY (hub_jwt_escopo_ids());
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_OBRIGATORIO'; END IF;
    IF v_sol.status NOT IN ('LIBERADA', 'AGUARDANDO_PRODUCAO') THEN RAISE EXCEPTION 'TRANSICAO_INVALIDA'; END IF;

    UPDATE "AdiantamentoSolicitacao" SET status = 'REJEITADA', motivo_status = p_motivo WHERE id = p_id;
    PERFORM hub_adiantamento_notificar(p_id, 'rejeitada');
    RETURN QUERY SELECT p_id, 'REJEITADA'::text;
END;
$$;

-- hub_adiantamento_recalcular — reusa hub_adiantamento_calcular_liberacao
-- (1.6.1); ação explícita do financeiro, nunca automática (edge #24,
-- snapshot). Só em AGUARDANDO_PRODUCAO: LIBERADA já tem o snapshot
-- calculado (recalcular reescreveria um valor já usado em `lote_previa`/
-- `lote_criar` — edge #24) e INELEGIVEL é terminal (a tabela de transições
-- não tem `INELEGIVEL->LIBERADA` nem o inverso).
CREATE OR REPLACE FUNCTION hub_adiantamento_recalcular(p_id bigint)
RETURNS TABLE (id bigint, status text, valor_liquido numeric)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sol    "AdiantamentoSolicitacao";
    v_config "AdiantamentoConfiguracao";
    v_calc   RECORD;
BEGIN
    SELECT * INTO v_sol FROM "AdiantamentoSolicitacao" WHERE id = p_id AND id_empresa = ANY (hub_jwt_escopo_ids());
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;
    IF v_sol.status <> 'AGUARDANDO_PRODUCAO' THEN
        RAISE EXCEPTION 'TRANSICAO_INVALIDA';
    END IF;

    SELECT * INTO v_config FROM "AdiantamentoConfiguracao" WHERE id = v_sol.configuracao_id;
    SELECT * INTO v_calc FROM hub_adiantamento_calcular_liberacao(v_sol.entregador_id, v_sol.data_producao, v_config);

    IF NOT v_calc.disponivel THEN
        RAISE EXCEPTION 'PRODUCAO_INDISPONIVEL';
    END IF;

    UPDATE "AdiantamentoSolicitacao" SET
        fonte_producao = v_config.fonte_producao,
        categorias_producao = v_config.categorias_producao,
        producao_valor = v_calc.prod_valor,
        producao_lancamentos = v_calc.prod_lancamentos,
        producao_por_categoria = v_calc.prod_por_categoria,
        percentual = v_config.percentual,
        valor_bruto = v_calc.valor_bruto,
        taxa = v_config.taxa_fixa,
        valor_liquido = v_calc.valor_liquido,
        calculado_em = now(),
        status = v_calc.novo_status,
        motivo_status = v_calc.motivo,
        conta_bancaria_id = COALESCE(v_calc.conta_bancaria_id, conta_bancaria_id)
    WHERE id = p_id;

    RETURN QUERY SELECT p_id, v_calc.novo_status, v_calc.valor_liquido;
END;
$$;

-- hub_adiantamento_encerrar — AGUARDANDO_PRODUCAO -> INELEGIVEL (financeiro
-- desiste de esperar a produção).
CREATE OR REPLACE FUNCTION hub_adiantamento_encerrar(p_id bigint, p_motivo text)
RETURNS TABLE (id bigint, status text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sol "AdiantamentoSolicitacao";
BEGIN
    SELECT * INTO v_sol FROM "AdiantamentoSolicitacao" WHERE id = p_id AND id_empresa = ANY (hub_jwt_escopo_ids());
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;
    IF v_sol.status <> 'AGUARDANDO_PRODUCAO' THEN RAISE EXCEPTION 'TRANSICAO_INVALIDA'; END IF;
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_OBRIGATORIO'; END IF;

    UPDATE "AdiantamentoSolicitacao" SET status = 'INELEGIVEL', motivo_status = p_motivo WHERE id = p_id;
    PERFORM hub_adiantamento_notificar(p_id, 'encerrada');
    RETURN QUERY SELECT p_id, 'INELEGIVEL'::text;
END;
$$;

-- hub_adiantamento_atualizar_conta — resolve a pendência CONTA_ALTERADA
-- (R-10): atualiza o snapshot para a conta APROVADA vigente, sem mudar
-- status (registra o evento manualmente, já que o trigger só dispara em
-- mudança de status).
CREATE OR REPLACE FUNCTION hub_adiantamento_atualizar_conta(p_id bigint, p_motivo text)
RETURNS TABLE (id bigint, conta_bancaria_id bigint)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sol   "AdiantamentoSolicitacao";
    v_conta "ContaBancariaMotorista";
BEGIN
    SELECT * INTO v_sol FROM "AdiantamentoSolicitacao" WHERE id = p_id AND id_empresa = ANY (hub_jwt_escopo_ids());
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;
    IF v_sol.status <> 'LIBERADA' THEN RAISE EXCEPTION 'TRANSICAO_INVALIDA'; END IF;

    SELECT * INTO v_conta FROM "ContaBancariaMotorista" WHERE entregador_id = v_sol.entregador_id AND status = 'APROVADA';
    IF NOT FOUND THEN RAISE EXCEPTION 'NO_BANK_ACCOUNT'; END IF;

    UPDATE "AdiantamentoSolicitacao" SET conta_bancaria_id = v_conta.id WHERE id = p_id;

    INSERT INTO "AdiantamentoEvento" (solicitacao_id, id_empresa, status_de, status_para, ator_tipo, ator_usuario_id, motivo, dados)
    VALUES (p_id, v_sol.id_empresa, v_sol.status, v_sol.status,
            'usuario', NULLIF(hub_jwt_claims() ->> 'sub', '')::int, p_motivo,
            jsonb_build_object('acao', 'atualizar_conta', 'contaBancariaId', v_conta.id));

    RETURN QUERY SELECT p_id, v_conta.id;
END;
$$;

-- hub_adiantamento_reprocessar — R-14: só de FALHOU, motivo obrigatório,
-- volta a LIBERADA (segunda barreira: 'reprocessar').
CREATE OR REPLACE FUNCTION hub_adiantamento_reprocessar(p_id bigint, p_motivo text)
RETURNS TABLE (id bigint, status text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sol "AdiantamentoSolicitacao";
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.reprocessar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

    SELECT * INTO v_sol FROM "AdiantamentoSolicitacao" WHERE id = p_id AND id_empresa = ANY (hub_jwt_escopo_ids());
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;
    IF v_sol.status <> 'FALHOU' THEN RAISE EXCEPTION 'TRANSICAO_INVALIDA'; END IF;
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_OBRIGATORIO'; END IF;

    UPDATE "AdiantamentoSolicitacao" SET status = 'LIBERADA', motivo_status = NULL WHERE id = p_id;

    UPDATE "AdiantamentoEvento" SET motivo = p_motivo
    WHERE id = (
        SELECT ev.id FROM "AdiantamentoEvento" ev
        WHERE ev.solicitacao_id = p_id AND ev.status_para = 'LIBERADA'
        ORDER BY ev.id DESC LIMIT 1
    );

    RETURN QUERY SELECT p_id, 'LIBERADA'::text;
END;
$$;

-- hub_adiantamento_encerrar_falha — D-23 (operador 2026-09-17): FALHOU ->
-- ENCERRADA quando a falha não será mais paga; motivo obrigatório; mesma
-- autoridade que decide sobre falhas ('reprocessar'); notifica o motorista
-- ("pagamento não realizado"). A auditoria (`adiantamento.encerrado_sem_pagamento`)
-- é responsabilidade da rota Node (FASE 4, contracts/hub-api.md), não desta RPC.
CREATE OR REPLACE FUNCTION hub_adiantamento_encerrar_falha(p_id bigint, p_motivo text)
RETURNS TABLE (id bigint, status text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sol "AdiantamentoSolicitacao";
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.reprocessar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

    SELECT * INTO v_sol FROM "AdiantamentoSolicitacao" WHERE id = p_id AND id_empresa = ANY (hub_jwt_escopo_ids());
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;
    IF v_sol.status <> 'FALHOU' THEN RAISE EXCEPTION 'TRANSICAO_INVALIDA'; END IF;
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_OBRIGATORIO'; END IF;

    UPDATE "AdiantamentoSolicitacao" SET status = 'ENCERRADA', motivo_status = p_motivo WHERE id = p_id;
    PERFORM hub_adiantamento_notificar(p_id, 'encerrada_sem_pagamento');

    RETURN QUERY SELECT p_id, 'ENCERRADA'::text;
END;
$$;

-- hub_adiantamento_configuracao_salvar — N+1 (merge com a vigente: só os
-- campos presentes em p_dados sobrescrevem); id_empresa fixo = 6 (dec-022,
-- escopo de grupo só na empresa-pai).
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

    SELECT * INTO v_atual FROM hub_adiantamento_config_vigente(6);
    IF v_atual.versao IS DISTINCT FROM p_versao_esperada THEN
        RAISE EXCEPTION 'VERSAO_DESATUALIZADA';
    END IF;

    INSERT INTO "AdiantamentoConfiguracao" (
        id_empresa, versao, vigente_desde, timezone, dias_habilitados, horario_abertura,
        horario_corte, percentual, taxa_fixa, fonte_producao, categorias_producao,
        previsao_pagamento_texto, descricao_pix_modelo, apuracao_dia_inicio,
        apuracao_dias_ate_repasse, apuracao_data_base, categorias_extrato,
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
        COALESCE((p_dados ->> 'descontoAdiantamentos')::boolean, v_atual.desconto_adiantamentos, true),
        COALESCE((p_dados ->> 'descontoDebitos')::boolean, v_atual.desconto_debitos, false),
        COALESCE((p_dados ->> 'repasseVisivelApp')::boolean, v_atual.repasse_visivel_app, false),
        v_sub,
        p_dados ->> 'motivo'
    ) RETURNING * INTO v_nova;

    RETURN v_nova;
END;
$$;

CREATE OR REPLACE FUNCTION hub_adiantamento_categorias(p_fonte text DEFAULT NULL)
RETURNS TABLE (descricao text, lancamentos bigint, sem_motorista_identificado boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT f.descricao, count(*), bool_or(f.entregador_id IS NULL)
    FROM "FaturamentoLancamento" f
    WHERE f.id_empresa = ANY (hub_jwt_escopo_ids())
      AND f.tipo = 'Credito'
      AND f.data_referencia >= (current_date - 90)
    GROUP BY f.descricao
    ORDER BY f.descricao;
$$;

-- 7.11.1 (dec-105): H06 do protótipo aprovado filtra também por origem,
-- alertas, motorista (nome ou documento) e banco — parâmetros novos
-- acrescentados APÓS os 3 originais (posição importa para chamadas
-- posicionais como a do driver de integração).
CREATE OR REPLACE FUNCTION hub_conta_bancaria_listar(
    p_status text DEFAULT NULL, p_pagina int DEFAULT 1, p_tamanho_pagina int DEFAULT 20,
    p_origem text DEFAULT NULL, p_sem_alertas boolean DEFAULT NULL,
    p_busca text DEFAULT NULL, p_banco text DEFAULT NULL
)
RETURNS TABLE (dados jsonb, total bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_escopo int[] := hub_jwt_escopo_ids();
    v_total  bigint;
BEGIN
    SELECT count(*) INTO v_total FROM "ContaBancariaMotorista" cb
    WHERE cb.id_empresa = ANY (v_escopo)
      AND (p_status IS NULL OR cb.status = p_status)
      AND (p_origem IS NULL OR cb.origem = p_origem)
      AND (p_sem_alertas IS NULL OR p_sem_alertas = (jsonb_array_length(cb.alertas) = 0))
      AND (p_banco IS NULL OR cb.banco_codigo = p_banco)
      AND (p_busca IS NULL OR p_busca = '' OR
           hub_normaliza_nome(cb.titular_nome) LIKE '%' || hub_normaliza_nome(p_busca) || '%' OR
           cb.titular_documento LIKE '%' || NULLIF(regexp_replace(p_busca, '\D', '', 'g'), '') || '%');

    RETURN QUERY
    SELECT hub_conta_bancaria_mascarar(cb), v_total
    FROM "ContaBancariaMotorista" cb
    WHERE cb.id_empresa = ANY (v_escopo)
      AND (p_status IS NULL OR cb.status = p_status)
      AND (p_origem IS NULL OR cb.origem = p_origem)
      AND (p_sem_alertas IS NULL OR p_sem_alertas = (jsonb_array_length(cb.alertas) = 0))
      AND (p_banco IS NULL OR cb.banco_codigo = p_banco)
      AND (p_busca IS NULL OR p_busca = '' OR
           hub_normaliza_nome(cb.titular_nome) LIKE '%' || hub_normaliza_nome(p_busca) || '%' OR
           cb.titular_documento LIKE '%' || NULLIF(regexp_replace(p_busca, '\D', '', 'g'), '') || '%')
    ORDER BY cb.solicitada_em DESC
    LIMIT GREATEST(p_tamanho_pagina, 1) OFFSET GREATEST(p_pagina - 1, 0) * GREATEST(p_tamanho_pagina, 1);
END;
$$;

CREATE OR REPLACE FUNCTION hub_conta_bancaria_detalhe(p_id bigint, p_completo boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_conta "ContaBancariaMotorista";
BEGIN
    SELECT * INTO v_conta FROM "ContaBancariaMotorista" WHERE id = p_id AND id_empresa = ANY (hub_jwt_escopo_ids());
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;

    IF p_completo THEN
        IF NOT hub_adiantamento_tem_permissao('adiantamentos.contas_revisar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;
        RETURN jsonb_build_object(
            'id', v_conta.id, 'status', v_conta.status, 'origem', v_conta.origem, 'titularNome', v_conta.titular_nome,
            'titularDocumento', v_conta.titular_documento, 'titularTipo', v_conta.titular_tipo,
            'bancoCodigo', v_conta.banco_codigo, 'bancoNome', v_conta.banco_nome,
            'agencia', v_conta.agencia, 'conta', v_conta.conta, 'contaDigito', v_conta.conta_digito,
            'tipoConta', v_conta.tipo_conta, 'chavePixTipo', v_conta.chave_pix_tipo,
            'chavePix', v_conta.chave_pix, 'emailComprovante', v_conta.email_comprovante,
            'alertas', v_conta.alertas, 'motivoRejeicao', v_conta.motivo_rejeicao,
            'solicitadaEm', v_conta.solicitada_em, 'revisadaEm', v_conta.revisada_em,
            -- 7.5.2 (spec.md US3/FR-018): a revisão dedicada exige "confirmar
            -- explicitamente o entregador vinculado" — a tela precisa do nome
            -- para exibir, e do id para reenviar como entregadorConfirmadoId
            -- (data-model.md: aprovar exige entregador_confirmado_id =
            -- entregador_id). 0067 só existiu em stacks efêmeros até aqui
            -- (mesmo critério de "ajuste no lugar" já usado nesta migration).
            'entregadorId', v_conta.entregador_id,
            'entregadorNome', (SELECT e.nome FROM "Entregador" e WHERE e.id = v_conta.entregador_id)
        );
    END IF;

    RETURN hub_conta_bancaria_mascarar(v_conta);
END;
$$;

CREATE OR REPLACE FUNCTION hub_conta_bancaria_aprovar(p_id bigint, p_entregador_confirmado_id int)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_conta "ContaBancariaMotorista";
    v_sub   int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.contas_revisar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

    SELECT * INTO v_conta FROM "ContaBancariaMotorista" WHERE id = p_id AND id_empresa = ANY (hub_jwt_escopo_ids()) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;
    IF v_conta.status <> 'PENDENTE' THEN RAISE EXCEPTION 'TRANSICAO_INVALIDA'; END IF;
    IF p_entregador_confirmado_id IS NULL OR p_entregador_confirmado_id <> v_conta.entregador_id THEN
        RAISE EXCEPTION 'DADOS_INVALIDOS';
    END IF;

    UPDATE "ContaBancariaMotorista" SET status = 'SUBSTITUIDA', revisada_em = now(), revisada_por = v_sub
    WHERE entregador_id = v_conta.entregador_id AND status = 'APROVADA';

    UPDATE "ContaBancariaMotorista"
    SET status = 'APROVADA', entregador_confirmado_id = p_entregador_confirmado_id, revisada_em = now(), revisada_por = v_sub
    WHERE id = p_id;

    PERFORM hub_adiantamento_notificar(NULL, 'conta_aprovada', v_conta.entregador_id);

    RETURN jsonb_build_object('id', p_id, 'status', 'APROVADA');
END;
$$;

CREATE OR REPLACE FUNCTION hub_conta_bancaria_rejeitar(p_id bigint, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_conta "ContaBancariaMotorista";
    v_sub   int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.contas_revisar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_OBRIGATORIO'; END IF;

    SELECT * INTO v_conta FROM "ContaBancariaMotorista" WHERE id = p_id AND id_empresa = ANY (hub_jwt_escopo_ids()) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;
    IF v_conta.status <> 'PENDENTE' THEN RAISE EXCEPTION 'TRANSICAO_INVALIDA'; END IF;

    UPDATE "ContaBancariaMotorista"
    SET status = 'REJEITADA', motivo_rejeicao = p_motivo, revisada_em = now(), revisada_por = v_sub
    WHERE id = p_id;

    PERFORM hub_adiantamento_notificar(NULL, 'conta_rejeitada', v_conta.entregador_id);

    RETURN jsonb_build_object('id', p_id, 'status', 'REJEITADA');
END;
$$;

-- hub_conta_bancaria_aprovar_lote — bulk; confirma com o próprio
-- entregador_id de cada conta (sem passo de conferência individual — ação
-- em massa deliberadamente mais permissiva, mesma barreira 'contas_revisar');
-- item problemático não impede os demais (mesmo espírito do edge #14).
-- Correção onda-017 (FASE 4/4.3.5, hub-api.md §Contas bancárias, Q-N5): a
-- versão original tentava aprovar QUALQUER id (só falhava dentro de
-- `hub_conta_bancaria_aprovar` se o status já não fosse PENDENTE) — o
-- contrato exige elegibilidade explícita (`origem=CARGA_INICIAL`, `PENDENTE`,
-- sem `alertas`) e um motivo por id ignorado, nenhum dos dois existia. 0067
-- só existiu em stacks efêmeros até aqui (mesmo critério de dec-053/1.6) —
-- ajustada no lugar; `aprovada`/`motivo_ignorada` substitui o antigo
-- `status` textual (a rota Node monta `{aprovadas, ignoradas:[{id,motivo}]}`
-- a partir desta tabela, sem round-trip extra).
CREATE OR REPLACE FUNCTION hub_conta_bancaria_aprovar_lote(p_ids bigint[])
RETURNS TABLE (id bigint, aprovada boolean, motivo_ignorada text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_id    bigint;
    v_conta "ContaBancariaMotorista";
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.contas_revisar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

    FOREACH v_id IN ARRAY p_ids LOOP
        SELECT * INTO v_conta FROM "ContaBancariaMotorista" cb
        WHERE cb.id = v_id AND cb.id_empresa = ANY (hub_jwt_escopo_ids());
        IF NOT FOUND THEN
            RETURN QUERY SELECT v_id, false, 'NAO_ENCONTRADA'::text;
            CONTINUE;
        END IF;
        IF v_conta.origem <> 'CARGA_INICIAL' THEN
            RETURN QUERY SELECT v_id, false, 'ORIGEM_INVALIDA'::text;
            CONTINUE;
        END IF;
        IF v_conta.status <> 'PENDENTE' THEN
            RETURN QUERY SELECT v_id, false, 'STATUS_INVALIDO'::text;
            CONTINUE;
        END IF;
        IF v_conta.alertas IS NOT NULL AND jsonb_array_length(v_conta.alertas) > 0 THEN
            RETURN QUERY SELECT v_id, false, 'COM_ALERTAS'::text;
            CONTINUE;
        END IF;

        BEGIN
            PERFORM hub_conta_bancaria_aprovar(v_id, v_conta.entregador_id);
            RETURN QUERY SELECT v_id, true, NULL::text;
        EXCEPTION WHEN OTHERS THEN
            RETURN QUERY SELECT v_id, false, 'ERRO_APROVACAO'::text;
        END;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION hub_adiantamento_lote_previa(p_ids bigint[])
RETURNS TABLE (solicitacao_id bigint, apta boolean, motivo_pendencia text, valor_liquido numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
    RETURN QUERY
    SELECT
        s.id,
        (s.status = 'LIBERADA' AND s.valor_liquido > 0 AND s.conta_bancaria_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM "AdiantamentoLoteItem" li WHERE li.solicitacao_id = s.id AND li.situacao IN ('incluido', 'pago'))),
        CASE
            WHEN EXISTS (SELECT 1 FROM "AdiantamentoLoteItem" li WHERE li.solicitacao_id = s.id AND li.situacao IN ('incluido', 'pago')) THEN 'JA_EM_LOTE'
            WHEN s.status <> 'LIBERADA' THEN 'STATUS_' || s.status
            WHEN s.valor_liquido IS NULL OR s.valor_liquido <= 0 THEN 'VALOR_INVALIDO'
            ELSE NULL
        END,
        s.valor_liquido
    FROM "AdiantamentoSolicitacao" s
    WHERE s.id = ANY (p_ids) AND s.id_empresa = ANY (hub_jwt_escopo_ids());
END;
$$;

-- hub_adiantamento_lote_criar — trava FOR UPDATE em ordem de id (1.2.5,
-- evita deadlock com outra criação concorrente que compartilhe ids); a
-- revalidação de "já em outro lote" acontece SOB o lock, então a segunda
-- transação concorrente só a enxerga depois que a primeira committa — quem
-- chega depois recebe SOLICITACOES_EM_OUTRO_LOTE (edge #17, 1.2.8).
CREATE OR REPLACE FUNCTION hub_adiantamento_lote_criar(
    p_ids bigint[], p_quantidade_esperada int, p_total_esperado numeric, p_chave uuid
)
RETURNS TABLE (id bigint, status text, quantidade int, valor_total numeric, reutilizado boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sub          int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_empresa      int := NULLIF(hub_jwt_claims() ->> 'empresa_ativa', '')::int;
    v_existente    RECORD;
    v_ordenados    bigint[];
    v_conflitantes bigint[];
    v_qtd          int;
    v_total        numeric(14,2);
    v_lote_id      bigint;
    v_linha        int := 3;
    v_row          RECORD;
    v_config       "AdiantamentoConfiguracao";
    v_descricao    text;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.lote_criar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;
    IF v_sub IS NULL THEN RAISE EXCEPTION 'NAO_AUTENTICADO'; END IF;
    IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN RAISE EXCEPTION 'DADOS_INVALIDOS'; END IF;

    SELECT l.id, l.status, l.quantidade, l.valor_total INTO v_existente
    FROM "AdiantamentoLote" l WHERE l.criado_por = v_sub AND l.chave_idempotencia = p_chave;
    IF FOUND THEN
        RETURN QUERY SELECT v_existente.id, v_existente.status, v_existente.quantidade, v_existente.valor_total, true;
        RETURN;
    END IF;

    IF cardinality(p_ids) > 5000 THEN
        RAISE EXCEPTION 'LOTE_ACIMA_DO_LIMITE';
    END IF;

    SELECT array_agg(x ORDER BY x) INTO v_ordenados FROM unnest(p_ids) x;
    PERFORM 1 FROM "AdiantamentoSolicitacao" WHERE id = ANY (v_ordenados) ORDER BY id FOR UPDATE;

    SELECT array_agg(li.solicitacao_id) INTO v_conflitantes
    FROM "AdiantamentoLoteItem" li
    WHERE li.solicitacao_id = ANY (p_ids) AND li.situacao IN ('incluido', 'pago');
    IF v_conflitantes IS NOT NULL THEN
        RAISE EXCEPTION 'SOLICITACOES_EM_OUTRO_LOTE' USING DETAIL = array_to_json(v_conflitantes)::text;
    END IF;

    SELECT count(*), COALESCE(sum(s.valor_liquido), 0)
    INTO v_qtd, v_total
    FROM "AdiantamentoSolicitacao" s
    WHERE s.id = ANY (p_ids) AND s.id_empresa = ANY (hub_jwt_escopo_ids())
      AND s.status = 'LIBERADA' AND s.valor_liquido > 0 AND s.conta_bancaria_id IS NOT NULL;

    IF v_qtd IS DISTINCT FROM cardinality(p_ids)
       OR v_qtd IS DISTINCT FROM p_quantidade_esperada
       OR v_total IS DISTINCT FROM p_total_esperado::numeric(14,2) THEN
        RAISE EXCEPTION 'PREVIA_DESATUALIZADA';
    END IF;

    INSERT INTO "AdiantamentoLote" (id_empresa, status, criado_por, chave_idempotencia, quantidade, valor_total)
    VALUES (COALESCE(v_empresa, 6), 'GERANDO', v_sub, p_chave, v_qtd, v_total)
    RETURNING "AdiantamentoLote".id INTO v_lote_id;

    FOR v_row IN
        SELECT
            s.id                 AS solicitacao_id,
            s.id_empresa         AS solicitacao_id_empresa,
            s.data_producao      AS solicitacao_data_producao,
            s.configuracao_id    AS solicitacao_configuracao_id,
            s.valor_liquido      AS solicitacao_valor_liquido,
            cb.id                AS conta_id,
            cb.titular_nome      AS conta_titular_nome,
            cb.titular_documento AS conta_titular_documento,
            cb.banco_nome        AS conta_banco_nome,
            cb.agencia           AS conta_agencia,
            cb.conta             AS conta_numero,
            cb.conta_digito      AS conta_digito,
            cb.tipo_conta        AS conta_tipo_conta,
            cb.email_comprovante AS conta_email
        FROM "AdiantamentoSolicitacao" s
        JOIN "ContaBancariaMotorista" cb ON cb.id = s.conta_bancaria_id
        WHERE s.id = ANY (v_ordenados)
        ORDER BY s.id
    LOOP
        SELECT * INTO v_config FROM "AdiantamentoConfiguracao" WHERE id = v_row.solicitacao_configuracao_id;
        v_descricao := left(
            replace(
                replace(v_config.descricao_pix_modelo, '{data_producao:DD.MM.AA}', to_char(v_row.solicitacao_data_producao, 'DD.MM.YY')),
                '{nome}', v_row.conta_titular_nome
            ), 140
        );

        INSERT INTO "AdiantamentoLoteItem" (
            lote_id, solicitacao_id, id_empresa, linha, col_nome, col_documento, col_email,
            col_banco, col_agencia, col_conta, col_digito, col_tipo_conta, valor,
            col_id_integracao, col_descricao_pix, conta_bancaria_id, situacao
        ) VALUES (
            v_lote_id, v_row.solicitacao_id, v_row.solicitacao_id_empresa, v_linha,
            v_row.conta_titular_nome, hub_adiantamento_mascarar(v_row.conta_titular_documento, 2),
            COALESCE(v_row.conta_email, ''), v_row.conta_banco_nome, v_row.conta_agencia,
            v_row.conta_numero, v_row.conta_digito,
            CASE v_row.conta_tipo_conta WHEN 'CORRENTE' THEN 'Conta Corrente' ELSE 'Conta Poupança' END,
            v_row.solicitacao_valor_liquido, hub_adiantamento_integration_id(v_row.solicitacao_id), v_descricao,
            v_row.conta_id, 'incluido'
        );

        UPDATE "AdiantamentoSolicitacao" SET status = 'EM_LOTE' WHERE id = v_row.solicitacao_id;

        v_linha := v_linha + 1;
    END LOOP;

    RETURN QUERY SELECT v_lote_id, 'GERANDO'::text, v_qtd, v_total::numeric, false;
END;
$$;

CREATE OR REPLACE FUNCTION hub_adiantamento_lote_arquivo(
    p_lote_id bigint, p_arquivo text, p_sha256 char(64), p_bytes int, p_nome text
)
RETURNS TABLE (id bigint, status text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_lote     "AdiantamentoLote";
    v_bytes    bytea;
    v_sha_calc text;
BEGIN
    SELECT * INTO v_lote FROM "AdiantamentoLote" WHERE id = p_lote_id AND id_empresa = ANY (hub_jwt_escopo_ids()) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;
    IF v_lote.status <> 'GERANDO' THEN RAISE EXCEPTION 'TRANSICAO_INVALIDA'; END IF;

    v_bytes := decode(p_arquivo, 'base64');
    v_sha_calc := encode(sha256(v_bytes), 'hex');
    IF v_sha_calc <> lower(p_sha256) THEN
        RAISE EXCEPTION 'SHA256_DIVERGENTE';
    END IF;

    UPDATE "AdiantamentoLote"
    SET status = 'GERADO', arquivo = v_bytes, arquivo_sha256 = v_sha_calc,
        arquivo_bytes = p_bytes, arquivo_nome = p_nome, gerado_em = now()
    WHERE id = p_lote_id;

    RETURN QUERY SELECT p_lote_id, 'GERADO'::text;
END;
$$;

CREATE OR REPLACE FUNCTION hub_adiantamento_lote_download(p_lote_id bigint)
RETURNS TABLE (arquivo_base64 text, sha256 text, nome text, downloads int)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_lote  "AdiantamentoLote";
    v_ids   bigint[];
    v_solid bigint;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.exportar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

    SELECT * INTO v_lote FROM "AdiantamentoLote" WHERE id = p_lote_id AND id_empresa = ANY (hub_jwt_escopo_ids()) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;
    IF v_lote.status NOT IN ('GERADO', 'EXPORTADO', 'CONCLUIDO', 'CONCLUIDO_COM_FALHAS') OR v_lote.arquivo IS NULL THEN
        RAISE EXCEPTION 'ARQUIVO_INDISPONIVEL';
    END IF;

    IF v_lote.status = 'GERADO' THEN
        UPDATE "AdiantamentoLote" SET status = 'EXPORTADO', primeiro_download_em = now(), downloads = downloads + 1
        WHERE id = p_lote_id;

        SELECT array_agg(li.solicitacao_id) INTO v_ids FROM "AdiantamentoLoteItem" li WHERE li.lote_id = p_lote_id;
        UPDATE "AdiantamentoSolicitacao" SET status = 'EXPORTADA' WHERE id = ANY (v_ids);
        -- 5.2 (FASE 5): notifica CADA solicitação exportada — "lote_exportado"
        -- é um evento por-solicitação, não um NULL/fan-out inventado dentro
        -- de hub_adiantamento_notificar (assinatura permanece (id, evento)).
        FOREACH v_solid IN ARRAY COALESCE(v_ids, ARRAY[]::bigint[]) LOOP
            PERFORM hub_adiantamento_notificar(v_solid, 'lote_exportado');
        END LOOP;
    ELSE
        UPDATE "AdiantamentoLote" SET downloads = downloads + 1 WHERE id = p_lote_id;
    END IF;

    RETURN QUERY SELECT encode(v_lote.arquivo, 'base64'), v_lote.arquivo_sha256, v_lote.arquivo_nome, (v_lote.downloads + 1);
END;
$$;

CREATE OR REPLACE FUNCTION hub_adiantamento_lote_cancelar(p_lote_id bigint, p_motivo text, p_nao_enviado boolean DEFAULT false)
RETURNS TABLE (id bigint, status text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_lote "AdiantamentoLote";
    v_sub  int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_ids  bigint[];
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.reprocessar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;
    IF p_motivo IS NULL OR btrim(p_motivo) = '' THEN RAISE EXCEPTION 'MOTIVO_OBRIGATORIO'; END IF;

    SELECT * INTO v_lote FROM "AdiantamentoLote" WHERE id = p_lote_id AND id_empresa = ANY (hub_jwt_escopo_ids()) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;

    IF v_lote.status IN ('GERANDO', 'GERADO') THEN
        NULL;
    ELSIF v_lote.status = 'EXPORTADO' THEN
        IF p_nao_enviado IS NOT TRUE THEN
            RAISE EXCEPTION 'CONFIRMACAO_NAO_ENVIADO_OBRIGATORIA';
        END IF;
    ELSE
        RAISE EXCEPTION 'TRANSICAO_INVALIDA';
    END IF;

    UPDATE "AdiantamentoLote"
    SET status = 'CANCELADO', cancelado_em = now(), cancelado_por = v_sub, cancelado_motivo = p_motivo,
        nao_enviado_declarado = p_nao_enviado
    WHERE id = p_lote_id;

    UPDATE "AdiantamentoLoteItem" SET situacao = 'cancelado' WHERE lote_id = p_lote_id AND situacao = 'incluido';

    SELECT array_agg(li.solicitacao_id) INTO v_ids FROM "AdiantamentoLoteItem" li
    WHERE li.lote_id = p_lote_id AND li.situacao = 'cancelado';
    UPDATE "AdiantamentoSolicitacao" SET status = 'LIBERADA' WHERE id = ANY (COALESCE(v_ids, ARRAY[]::bigint[])) AND status IN ('EM_LOTE', 'EXPORTADA');

    RETURN QUERY SELECT p_lote_id, 'CANCELADO'::text;
END;
$$;

CREATE OR REPLACE FUNCTION hub_adiantamento_lote_confirmar(p_lote_id bigint, p_falhas jsonb DEFAULT '[]')
RETURNS TABLE (id bigint, status text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_lote        "AdiantamentoLote";
    v_sub         int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_falha_ids   bigint[];
    v_pagas_ids   bigint[];
    v_falhas_count int;
    v_status_final text;
    v_solid       bigint;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.pagamento_confirmar') THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

    SELECT * INTO v_lote FROM "AdiantamentoLote" WHERE id = p_lote_id AND id_empresa = ANY (hub_jwt_escopo_ids()) FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;
    IF v_lote.status <> 'EXPORTADO' THEN RAISE EXCEPTION 'TRANSICAO_INVALIDA'; END IF;

    SELECT array_agg((f ->> 'id')::bigint) INTO v_falha_ids FROM jsonb_array_elements(COALESCE(p_falhas, '[]'::jsonb)) f;

    UPDATE "AdiantamentoLoteItem" li
    SET situacao = 'falhou', situacao_motivo = f ->> 'motivo', situacao_em = now(), situacao_por = v_sub, origem_situacao = 'manual'
    FROM jsonb_array_elements(COALESCE(p_falhas, '[]'::jsonb)) f
    WHERE li.lote_id = p_lote_id AND li.solicitacao_id = (f ->> 'id')::bigint AND li.situacao = 'incluido';

    UPDATE "AdiantamentoLoteItem"
    SET situacao = 'pago', situacao_em = now(), situacao_por = v_sub, origem_situacao = 'manual'
    WHERE lote_id = p_lote_id AND situacao = 'incluido';

    UPDATE "AdiantamentoSolicitacao" SET status = 'FALHOU'
    WHERE id = ANY (COALESCE(v_falha_ids, ARRAY[]::bigint[])) AND status = 'EXPORTADA';

    SELECT array_agg(li.solicitacao_id) INTO v_pagas_ids FROM "AdiantamentoLoteItem" li
    WHERE li.lote_id = p_lote_id AND li.situacao = 'pago';
    UPDATE "AdiantamentoSolicitacao" SET status = 'PAGA'
    WHERE id = ANY (COALESCE(v_pagas_ids, ARRAY[]::bigint[])) AND status = 'EXPORTADA';

    SELECT count(*) INTO v_falhas_count FROM "AdiantamentoLoteItem" WHERE lote_id = p_lote_id AND situacao = 'falhou';
    v_status_final := CASE WHEN v_falhas_count > 0 THEN 'CONCLUIDO_COM_FALHAS' ELSE 'CONCLUIDO' END;

    UPDATE "AdiantamentoLote" SET status = v_status_final, concluido_em = now() WHERE id = p_lote_id;

    -- 5.2 (FASE 5): "pagamento realizado" e "pagamento falhou" são eventos
    -- distintos por solicitação (FR-013) — não um único 'lote_confirmado'
    -- agregado, que misturaria as duas mensagens.
    FOREACH v_solid IN ARRAY COALESCE(v_falha_ids, ARRAY[]::bigint[]) LOOP
        PERFORM hub_adiantamento_notificar(v_solid, 'lote_falhou');
    END LOOP;
    FOREACH v_solid IN ARRAY COALESCE(v_pagas_ids, ARRAY[]::bigint[]) LOOP
        PERFORM hub_adiantamento_notificar(v_solid, 'lote_pago');
    END LOOP;

    RETURN QUERY SELECT p_lote_id, v_status_final;
END;
$$;

-- hub_adiantamento_repasse — listagem (R-15/R-16); NÃO fecha nada (RPC de
-- fechamento bloqueada, ver cabeçalho do arquivo).
CREATE OR REPLACE FUNCTION hub_adiantamento_repasse(
    p_periodo_inicio date, p_busca text DEFAULT NULL, p_somente_negativos boolean DEFAULT false,
    p_offset int DEFAULT 0, p_limite int DEFAULT 20
)
RETURNS TABLE (
    entregador_id int, nome text, creditos numeric, adiantamentos numeric, debitos numeric,
    remanescente numeric, em_processamento boolean, total bigint
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
          AND f.descricao = ANY (COALESCE(v_config.categorias_extrato, ARRAY[]::text[]))
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
    linhas AS (
        SELECT
            e.id AS entregador_id, e.nome,
            COALESCE(c.total, 0) AS creditos,
            CASE WHEN v_config.desconto_adiantamentos THEN COALESCE(a.pagos, 0) ELSE 0 END AS adiantamentos,
            CASE WHEN v_config.desconto_debitos THEN COALESCE(d.total, 0) ELSE 0 END AS debitos,
            COALESCE(a.processando, 0) > 0 AS em_processamento
        FROM "Entregador" e
        LEFT JOIN creditos c ON c.entregador_id = e.id
        LEFT JOIN debitos_cte d ON d.entregador_id = e.id
        LEFT JOIN adiant a ON a.entregador_id = e.id
        WHERE e.id_empresa = ANY (v_escopo)
          AND (c.entregador_id IS NOT NULL OR d.entregador_id IS NOT NULL OR a.pagos IS NOT NULL OR a.processando IS NOT NULL)
          AND (p_busca IS NULL OR hub_normaliza_nome(e.nome) LIKE '%' || hub_normaliza_nome(p_busca) || '%')
    ),
    calc AS (
        SELECT *, (creditos - adiantamentos - debitos) AS remanescente FROM linhas
    ),
    filtradas AS (
        SELECT * FROM calc WHERE (NOT p_somente_negativos OR remanescente < 0)
    )
    SELECT f.entregador_id, f.nome, f.creditos, f.adiantamentos, f.debitos, f.remanescente,
           f.em_processamento, count(*) OVER ()
    FROM filtradas f
    ORDER BY f.nome
    OFFSET p_offset LIMIT p_limite;
END;
$$;

-- hub_adiantamento_repasse_fechar — D-23 (operador 2026-09-17): recusa
-- (APURACAO_COM_PENDENCIAS, com a contagem por status) enquanto existir
-- solicitação com data_producao no período em status NÃO finalizado
-- (AGUARDANDO_CORTE, AGUARDANDO_PRODUCAO, LIBERADA, EM_LOTE, EXPORTADA,
-- FALHOU). Finalizados (não bloqueiam): PAGA, REJEITADA, INELEGIVEL,
-- CANCELADA, ENCERRADA. Trava por período: UNIQUE(id_empresa,periodo_inicio)
-- em ApuracaoRepasse -> segunda tentativa do mesmo período vira
-- APURACAO_JA_FECHADA (unique_violation). Desconta o BRUTO das PAGA no
-- período (R-15/R-16, D-11/D-12 inalterados) — mesma fonte de cálculo de
-- hub_adiantamento_repasse (listagem), sem duplicar a query aqui: fechar
-- também popula o `detalhe` com os ids das solicitações PAGA descontadas.
-- hub_adiantamento_repasse_pode_fechar — 1.6.3: a produção do último dia da
-- janela (v_fim) ainda pode ser solicitada no dia seguinte, até o corte
-- (D-1 calendário), então fechar antes disso deixaria adiantamento sem
-- desconto (furaria a D-23). Recusa enquanto o instante for anterior a
-- (v_fim + 1) + horario_corte, no fuso da configuração vigente. `p_instante`
-- injetável para teste de fronteira (mesmo padrão de hub_adiantamento_janela)
-- — a RPC pública sempre chama com `now()`.
CREATE OR REPLACE FUNCTION hub_adiantamento_repasse_pode_fechar(
    p_config   "AdiantamentoConfiguracao",
    p_fim      date,
    p_instante timestamptz
)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT p_instante >= (((p_fim + 1) + p_config.horario_corte) AT TIME ZONE p_config.timezone);
$$;

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
        SELECT f.entregador_id, sum(f.valor) AS total
        FROM "FaturamentoLancamento" f
        WHERE f.id_empresa = ANY (v_escopo) AND f.tipo = 'Credito'
          AND f.descricao = ANY (COALESCE(v_config.categorias_extrato, ARRAY[]::text[]))
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
        WHERE s.id_empresa = ANY (v_escopo) AND s.status = 'PAGA'
          AND s.data_producao BETWEEN p_periodo_inicio AND v_fim
        GROUP BY s.entregador_id
    ),
    linhas AS (
        SELECT
            e.id AS entregador_id,
            COALESCE(c.total, 0) AS creditos,
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
    INSERT INTO "ApuracaoRepasseItem" (apuracao_id, id_empresa, entregador_id, creditos, adiantamentos, debitos, remanescente, detalhe)
    SELECT v_apuracao_id, 6, l.entregador_id, l.creditos, l.adiantamentos, l.debitos,
           (l.creditos - l.adiantamentos - l.debitos),
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

-- ═══════════════════════════════════════════════════════════════════════
-- 1.6.2 — RPCs do worker (claim `hub_adiantamento_worker`). As três recusam
-- `PERMISSAO_NEGADA` sem a claim; a claim só é montada por
-- `lib/adiantamento-worker.js` (FASE 3), nunca a partir de dado de
-- requisição (contracts/sql-rpc.md §Worker).
-- ═══════════════════════════════════════════════════════════════════════

-- hub_adiantamento_corte_passou — 1.6.5 (dec-047): o corte do tick precisa
-- considerar o DIA da solicitação, não só a hora do dia — comparar apenas
-- `(now() AT TIME ZONE tz)::time >= horario_corte` faz uma solicitação de um
-- dia anterior ainda em AGUARDANDO_CORTE (tick parado ou backend reiniciado)
-- esperar até o corte do dia CORRENTE em vez de já ter passado do dela.
-- Mesma forma de `hub_adiantamento_repasse_pode_fechar` (1.6.3). `p_instante`
-- injetável para teste de fronteira; `hub_adiantamento_processar` sempre
-- chama com `now()`.
CREATE OR REPLACE FUNCTION hub_adiantamento_corte_passou(
    p_data_solicitacao date,
    p_horario_corte     time,
    p_timezone          text,
    p_instante          timestamptz
)
RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT p_instante >= ((p_data_solicitacao + p_horario_corte) AT TIME ZONE p_timezone);
$$;

-- hub_adiantamento_processar — tick de 60s (3.3.1). Usa a configuração DA
-- SOLICITAÇÃO (não a vigente da empresa) e o fuso dela, mais o DIA da
-- solicitação (1.6.5, `hub_adiantamento_corte_passou`), para decidir se o
-- corte já passou. Distinto de `hub_adiantamento_janela` (usada só na
-- criação, onde data_solicitacao é sempre hoje por construção).
-- `FOR UPDATE SKIP LOCKED` evita processar a mesma solicitação duas vezes em
-- corridas concorrentes do tick (1.6.4). Cada linha roda num bloco
-- EXCEPTION próprio: uma falha isolada (ex.: `NO_BANK_ACCOUNT`, raríssimo —
-- `hub_adiantamento_solicitar` já exige conta aprovada na criação) não
-- derruba o processamento do lote inteiro; a linha fica como estava e tenta
-- de novo no próximo tick.
CREATE OR REPLACE FUNCTION hub_adiantamento_processar(p_limite int DEFAULT 200)
RETURNS TABLE (id bigint, id_empresa int, status_para text, resultado jsonb)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row    RECORD;
    v_config "AdiantamentoConfiguracao";
    v_calc   RECORD;
    v_status_para text;
    v_resultado   jsonb;
BEGIN
    IF NOT hub_jwt_adiantamento_worker() THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

    FOR v_row IN
        SELECT s.*
        FROM "AdiantamentoSolicitacao" s
        JOIN "AdiantamentoConfiguracao" c ON c.id = s.configuracao_id
        WHERE (s.status = 'AGUARDANDO_CORTE' AND hub_adiantamento_corte_passou(s.data_solicitacao, c.horario_corte, c.timezone, now()))
           OR s.status = 'AGUARDANDO_PRODUCAO'
        ORDER BY s.id
        LIMIT p_limite
        FOR UPDATE OF s SKIP LOCKED
    LOOP
        SELECT * INTO v_config FROM "AdiantamentoConfiguracao" c WHERE c.id = v_row.configuracao_id;

        BEGIN
            SELECT * INTO v_calc FROM hub_adiantamento_calcular_liberacao(v_row.entregador_id, v_row.data_producao, v_config);

            IF NOT v_calc.disponivel THEN
                -- R-08/R-09, edge #7/#23: sem dado da fonte na data OU
                -- importação em andamento — tenta de novo indefinidamente.
                UPDATE "AdiantamentoSolicitacao" s2
                SET status = 'AGUARDANDO_PRODUCAO', tentativas_producao = tentativas_producao + 1
                WHERE s2.id = v_row.id;
                v_status_para := 'AGUARDANDO_PRODUCAO';
                v_resultado := jsonb_build_object('motivo', 'PRODUCAO_INDISPONIVEL', 'tentativas', v_row.tentativas_producao + 1);
            ELSE
                UPDATE "AdiantamentoSolicitacao" s2 SET
                    fonte_producao = v_config.fonte_producao,
                    categorias_producao = v_config.categorias_producao,
                    producao_valor = v_calc.prod_valor,
                    producao_lancamentos = v_calc.prod_lancamentos,
                    producao_por_categoria = v_calc.prod_por_categoria,
                    percentual = v_config.percentual,
                    valor_bruto = v_calc.valor_bruto,
                    taxa = v_config.taxa_fixa,
                    valor_liquido = v_calc.valor_liquido,
                    calculado_em = now(),
                    status = v_calc.novo_status,
                    motivo_status = v_calc.motivo,
                    conta_bancaria_id = COALESCE(v_calc.conta_bancaria_id, s2.conta_bancaria_id)
                WHERE s2.id = v_row.id;
                PERFORM hub_adiantamento_notificar(v_row.id, CASE WHEN v_calc.novo_status = 'LIBERADA' THEN 'liberada' ELSE 'inelegivel' END);
                v_status_para := v_calc.novo_status;
                v_resultado := jsonb_build_object('motivo', v_calc.motivo, 'valorLiquido', v_calc.valor_liquido);
            END IF;
        EXCEPTION WHEN OTHERS THEN
            -- [PROPOSTA] caso não previsto pelos edges #7/#23 (ex.:
            -- NO_BANK_ACCOUNT surgido entre a solicitação e o tick): não
            -- muda o status nem derruba o lote; auditoria via `resultado`.
            v_status_para := v_row.status;
            v_resultado := jsonb_build_object('erro', SQLERRM);
        END;

        RETURN QUERY SELECT v_row.id, v_row.id_empresa, v_status_para, v_resultado;
    END LOOP;
END;
$$;

-- hub_adiantamento_lote_orfaos — 3.3.2: `GERANDO` há mais de p_minutos
-- (default 5) → `CANCELADO` (`falha_geracao`); as solicitações do lote
-- voltam a `LIBERADA` (mesmo join de `hub_adiantamento_lote_cancelar`).
CREATE OR REPLACE FUNCTION hub_adiantamento_lote_orfaos(p_minutos int DEFAULT 5)
RETURNS TABLE (id bigint, id_empresa int)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_lote RECORD;
    v_ids  bigint[];
BEGIN
    IF NOT hub_jwt_adiantamento_worker() THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

    FOR v_lote IN
        SELECT l.id, l.id_empresa
        FROM "AdiantamentoLote" l
        WHERE l.status = 'GERANDO' AND l.criado_em < now() - make_interval(mins => p_minutos)
        ORDER BY l.id
        FOR UPDATE SKIP LOCKED
    LOOP
        UPDATE "AdiantamentoLote" l2
        SET status = 'CANCELADO', cancelado_em = now(), cancelado_motivo = 'falha_geracao'
        WHERE l2.id = v_lote.id;

        UPDATE "AdiantamentoLoteItem" SET situacao = 'cancelado' WHERE lote_id = v_lote.id AND situacao = 'incluido';

        SELECT array_agg(li.solicitacao_id) INTO v_ids FROM "AdiantamentoLoteItem" li
        WHERE li.lote_id = v_lote.id AND li.situacao = 'cancelado';
        UPDATE "AdiantamentoSolicitacao" s2 SET status = 'LIBERADA'
        WHERE s2.id = ANY (COALESCE(v_ids, ARRAY[]::bigint[])) AND s2.status = 'EM_LOTE';

        RETURN QUERY SELECT v_lote.id, v_lote.id_empresa;
    END LOOP;
END;
$$;

-- hub_adiantamento_expurgo_arquivos — 3.3.3/FR-052: zera `arquivo` (mantendo
-- `arquivo_sha256`/`arquivo_bytes` e o snapshot das linhas em
-- `AdiantamentoLoteItem`) de lotes concluídos ou cancelados há mais de
-- p_dias (default 90), contados a partir de `concluido_em`/`cancelado_em`
-- (plan.md: "expurgo 90 dias após concluir/cancelar").
CREATE OR REPLACE FUNCTION hub_adiantamento_expurgo_arquivos(p_dias int DEFAULT 90)
RETURNS TABLE (id bigint, id_empresa int)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT hub_jwt_adiantamento_worker() THEN RAISE EXCEPTION 'PERMISSAO_NEGADA'; END IF;

    RETURN QUERY
    UPDATE "AdiantamentoLote" l
    SET arquivo = NULL, arquivo_expurgado_em = now()
    WHERE l.arquivo IS NOT NULL
      AND l.arquivo_expurgado_em IS NULL
      AND (
          (l.status IN ('CONCLUIDO', 'CONCLUIDO_COM_FALHAS') AND l.concluido_em < now() - make_interval(days => p_dias))
          OR (l.status = 'CANCELADO' AND l.cancelado_em < now() - make_interval(days => p_dias))
      )
    RETURNING l.id, l.id_empresa;
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════
-- Fail-closed (mesmo precedente 0041/0061): nenhum papel de aplicação
-- executa por padrão — só `authenticated`, e só nas funções chamadas via
-- PostgREST. As internas (1.2.1) e os helpers de mascaramento/composição
-- (hub_adiantamento_mascarar, hub_conta_bancaria_mascarar,
-- hub_jwt_adiantamento_worker) ficam SEM grant — chamadas só função-a-função.
-- ═══════════════════════════════════════════════════════════════════════

REVOKE ALL ON FUNCTION hub_adiantamento_disponibilidade() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_disponibilidade() TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_solicitar(bigint, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_solicitar(bigint, text, uuid) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_cancelar(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_cancelar(bigint) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_listar_motorista(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_listar_motorista(int, int) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_detalhe_motorista(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_detalhe_motorista(bigint) TO authenticated;

REVOKE ALL ON FUNCTION hub_conta_bancaria_motorista() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_conta_bancaria_motorista() TO authenticated;

REVOKE ALL ON FUNCTION hub_conta_bancaria_solicitar(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_conta_bancaria_solicitar(jsonb) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_repasse_motorista() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse_motorista() TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_rejeitar(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_rejeitar(bigint, text) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_recalcular(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_recalcular(bigint) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_encerrar(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_encerrar(bigint, text) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_atualizar_conta(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_atualizar_conta(bigint, text) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_reprocessar(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_reprocessar(bigint, text) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_configuracao_salvar(int, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_configuracao_salvar(int, jsonb) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_categorias(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_categorias(text) TO authenticated;

REVOKE ALL ON FUNCTION hub_conta_bancaria_listar(text, int, int, text, boolean, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_conta_bancaria_listar(text, int, int, text, boolean, text, text) TO authenticated;

REVOKE ALL ON FUNCTION hub_conta_bancaria_detalhe(bigint, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_conta_bancaria_detalhe(bigint, boolean) TO authenticated;

REVOKE ALL ON FUNCTION hub_conta_bancaria_aprovar(bigint, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_conta_bancaria_aprovar(bigint, int) TO authenticated;

REVOKE ALL ON FUNCTION hub_conta_bancaria_rejeitar(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_conta_bancaria_rejeitar(bigint, text) TO authenticated;

REVOKE ALL ON FUNCTION hub_conta_bancaria_aprovar_lote(bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_conta_bancaria_aprovar_lote(bigint[]) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_lote_previa(bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_lote_previa(bigint[]) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_lote_criar(bigint[], int, numeric, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_lote_criar(bigint[], int, numeric, uuid) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_lote_arquivo(bigint, text, char, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_lote_arquivo(bigint, text, char, int, text) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_lote_download(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_lote_download(bigint) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_lote_cancelar(bigint, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_lote_cancelar(bigint, text, boolean) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_lote_confirmar(bigint, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_lote_confirmar(bigint, jsonb) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_repasse(date, text, boolean, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse(date, text, boolean, int, int) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_encerrar_falha(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_encerrar_falha(bigint, text) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_repasse_fechar(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse_fechar(date) TO authenticated;

-- 1.6.2: as três RPCs do worker também recebem GRANT a `authenticated` —
-- PostgREST sempre chama com esse role; a barreira real é a claim
-- `hub_adiantamento_worker` conferida dentro de cada função (mesmo padrão
-- de hub_push_reivindicar/hub_push_registrar_resultado/hub_push_expurgo em
-- 0061).
REVOKE ALL ON FUNCTION hub_adiantamento_processar(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_processar(int) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_lote_orfaos(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_lote_orfaos(int) TO authenticated;

REVOKE ALL ON FUNCTION hub_adiantamento_expurgo_arquivos(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_expurgo_arquivos(int) TO authenticated;

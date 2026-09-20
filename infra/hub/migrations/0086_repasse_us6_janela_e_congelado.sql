-- 0086 — Repasse semanal (US6): janela de fechamento alinhada (A1) e leitura
-- do valor congelado depois do fechamento (A4/A3).
--
-- Origem: docs/plans/adiantamento-repasse-us6/BRIEFING.md, os 3 achados que a
-- 3ª passada do `converge` deixou fora da feature `adiantamento-motorista`
-- (dec-185). Decisões do operador em 2026-09-19:
--   A1 -> a gravação RECUSA janela desalinhada (erro explícito) e a tela passa
--         a sugerir a semana certa;
--   A4 -> período fechado mostra o valor CONGELADO, rotulado "fechado em X";
--   A3 -> o app do motorista exibe os débitos e a última semana fechada.
--
-- NOTA DE MÉTODO: esta migration NÃO reescreve `hub_adiantamento_repasse_fechar`
-- (0082) nem `hub_adiantamento_repasse` (0083). São ~170 linhas de SQL de
-- dinheiro já auditadas por revisão adversarial; transcrevê-las para inserir
-- uma validação e um desvio é o jeito clássico de introduzir um erro de
-- dinheiro. A validação vai num GATILHO sobre a tabela (ponto exato da escrita
-- irreversível, e protege qualquer gravador), e a leitura do congelado vai
-- numa FUNÇÃO NOVA que as rotas escolhem chamar.

-- ---------------------------------------------------------------------------
-- A1 — a janela fechada precisa ser a semana configurada
-- ---------------------------------------------------------------------------
-- `hub_adiantamento_repasse_fechar` calcula `fim := inicio + 6` a partir do
-- que o CHAMADOR mandou, sem nunca olhar `apuracao_dia_inicio`. O caminho do
-- motorista (`hub_adiantamento_repasse_motorista`, 0083) alinha:
--   inicio := hoje - ((dow(hoje) - apuracao_dia_inicio + 7) % 7)
-- Resultado: em 6 dos 7 dias possíveis, a janela que a tela do hub sugere
-- fechar NÃO é a semana que o motorista está vendo. E `ApuracaoRepasse` é
-- imutável por gatilho (0066:463) — fechar errado não tem desfazer.
--
-- A conferência usa a configuração REFERENCIADA na própria linha
-- (`NEW.configuracao_id`), não a vigente no instante da gravação: é a que fica
-- registrada como tendo regido aquele fechamento, então é contra ela que o
-- período tem de fazer sentido.
CREATE OR REPLACE FUNCTION hub_apuracao_repasse_valida_janela()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_dia_inicio smallint;
BEGIN
    SELECT c.apuracao_dia_inicio INTO v_dia_inicio
    FROM "AdiantamentoConfiguracao" c WHERE c.id = NEW.configuracao_id;

    -- Sem dia de início configurado não há como validar. Fail-closed: recusa,
    -- nunca "passa porque não deu para conferir".
    IF v_dia_inicio IS NULL THEN
        RAISE EXCEPTION 'APURACAO_NAO_CONFIGURADA'
            USING DETAIL = 'apuracao_dia_inicio ausente na configuração ' || NEW.configuracao_id;
    END IF;

    IF extract(dow FROM NEW.periodo_inicio)::int <> v_dia_inicio THEN
        RAISE EXCEPTION 'PERIODO_DESALINHADO'
            USING DETAIL = format(
                'periodo_inicio %s cai no dia %s da semana; a apuração começa no dia %s',
                NEW.periodo_inicio, extract(dow FROM NEW.periodo_inicio)::int, v_dia_inicio
            );
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS apuracaorepasse_janela_chk ON "ApuracaoRepasse";
CREATE TRIGGER apuracaorepasse_janela_chk
    BEFORE INSERT ON "ApuracaoRepasse"
    FOR EACH ROW EXECUTE FUNCTION hub_apuracao_repasse_valida_janela();

-- ---------------------------------------------------------------------------
-- A4 — ler o que foi congelado, em vez de recalcular um período já fechado
-- ---------------------------------------------------------------------------
-- `hub_adiantamento_repasse_fechar` grava uma linha por motorista em
-- `ApuracaoRepasseItem` (0082) e NADA nunca lê de volta: `GET /repasse` e
-- `/repasse/exportar` recalculam ao vivo mesmo depois do fechamento. Um
-- lançamento retroativo entra e o número exibido deixa de ser o que foi
-- apurado.
--
-- Mesmas colunas de `hub_adiantamento_repasse` (0083), para a rota trocar uma
-- pela outra sem remapear nada. `em_processamento` é sempre false: o
-- fechamento é RECUSADO com `APURACAO_COM_PENDENCIAS` enquanto existir
-- solicitação EXPORTADA no período (0082), logo um período fechado não tem o
-- que estar em processamento.
CREATE OR REPLACE FUNCTION hub_adiantamento_repasse_congelado(
    p_periodo_inicio date, p_busca text DEFAULT NULL, p_somente_negativos boolean DEFAULT false,
    p_offset int DEFAULT 0, p_limite int DEFAULT 20
)
RETURNS TABLE (
    entregador_id int, nome text, creditos numeric, adiantamentos numeric, debitos numeric,
    remanescente numeric, em_processamento boolean, total bigint,
    total_creditos numeric, total_adiantamentos numeric, total_debitos numeric, total_remanescente numeric
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
        SELECT i.entregador_id, e.nome, i.creditos, i.adiantamentos, i.debitos, i.remanescente
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
    -- Janelas `OVER ()` avaliadas antes de OFFSET/LIMIT: os totais são do
    -- PERÍODO, não da página. Mesmo cuidado da 0083 — somar a página no Node
    -- já produziu "Total (137 motoristas) · R$ <soma de 20>" nesta tela.
    SELECT f.entregador_id, f.nome, f.creditos, f.adiantamentos, f.debitos, f.remanescente,
           false, count(*) OVER (),
           sum(f.creditos) OVER (), sum(f.adiantamentos) OVER (),
           sum(f.debitos) OVER (), sum(f.remanescente) OVER ()
    FROM filtradas f
    ORDER BY f.nome
    OFFSET p_offset LIMIT p_limite;
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_repasse_congelado(date, text, boolean, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse_congelado(date, text, boolean, int, int) TO authenticated;

-- ---------------------------------------------------------------------------
-- A3 — a última semana fechada, para o app do motorista
-- ---------------------------------------------------------------------------
-- `hub_adiantamento_repasse_motorista` mostra sempre a semana que contém HOJE.
-- O fechamento só pode ocorrer depois que a semana termina — quando fecha, o
-- motorista já está vendo a semana seguinte. Ou seja: hoje ele NUNCA vê uma
-- semana fechada, e portanto nunca vê o valor que de fato vai receber.
--
-- Esta função devolve a apuração fechada mais recente DELE: o valor congelado
-- e a data do repasse. Sem linha quando ele não tem nenhuma.
CREATE OR REPLACE FUNCTION hub_adiantamento_repasse_motorista_ultimo_fechado()
RETURNS TABLE (
    periodo_inicio date, periodo_fim date, data_repasse date, fechado_em timestamptz,
    creditos numeric(12,2), adiantamentos numeric(12,2), debitos numeric(12,2),
    remanescente numeric(12,2), negativo boolean
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
    -- Mesma cadeia de identificação de hub_adiantamento_repasse_motorista
    -- (0083): CNPJ do JWT -> ContaMotorista -> Entregador. Sem linha em
    -- qualquer elo que falte.
    IF v_cnpj IS NULL THEN RETURN; END IF;
    SELECT cm.id INTO v_conta_motorista_id FROM "ContaMotorista" cm WHERE cm.cnpj_prestador = v_cnpj;
    IF v_conta_motorista_id IS NULL THEN RETURN; END IF;
    SELECT e.* INTO v_entregador FROM "Entregador" e WHERE e.motorista_id = v_conta_motorista_id;
    IF NOT FOUND THEN RETURN; END IF;

    -- Mesmo portão do repasse ao vivo: se a empresa não expõe repasse no app,
    -- não expõe o fechado também.
    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(v_entregador.id_empresa);
    IF v_config.id IS NULL OR NOT v_config.repasse_visivel_app THEN RETURN; END IF;

    RETURN QUERY
    SELECT a.periodo_inicio, a.periodo_fim, a.data_repasse, a.fechado_em,
           i.creditos, i.adiantamentos, i.debitos, i.remanescente,
           i.remanescente < 0
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

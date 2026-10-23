-- 0117_lancamento_externo.sql
-- Feature `lancamento-externo` — importar valores pagos POR FORA do sistema e
-- fazê-los compor o repasse da semana que contém a data do pagamento.
-- Spec: docs/specs/lancamento-externo/spec.md · Plan: docs/plans/lancamento-externo/
--
-- ORDEM DE APLICAÇÃO: esta migration vem ANTES do deploy do código (o código
-- novo pede a tabela e as funções; o código ANTIGO não conhece nada daqui e
-- segue funcionando — todo acréscimo é aditivo e com default neutro).
--
-- migrate.sh aplica o arquivo em UMA transação (scripts/migrate.sh:46-73), logo
-- nada aqui pode ser CONCURRENTLY.
--
-- O QUE ESTA MIGRATION *NÃO* FAZ, de propósito:
--   • não altera nenhum CHECK existente (o trade-off aceito pelo operador foi
--     mexer no cálculo, não enfraquecer restrição — spec §Fora de Escopo);
--   • não unifica as 5 cópias da fórmula de início de semana que já existem na
--     série (0071:66, 0083:182, 0088:291, 0089:57). O helper novo abaixo é usado
--     só pelo código novo; refatorar as 5 obrigaria a redeployar 5 funções de
--     dinheiro vivas sem nenhum requisito pedindo — dívida NOMEADA, não paga.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Tipo do lançamento — tabela de lookup, não enum nem CHECK
-- ═══════════════════════════════════════════════════════════════════════
-- FR-011/FR-012/FR-013. O SINAL mora aqui e em nenhum outro lugar: um registro
-- com tipo e sentido incoerentes é IMPOSSÍVEL de gravar porque a linha de
-- lançamento não tem coluna de sinal para contradizer. Tipo novo (FR-013) =
-- um INSERT nesta tabela, sem DDL e sem redesenho — era a razão de D1.
CREATE TABLE IF NOT EXISTS "LancamentoExternoTipo" (
    codigo     text PRIMARY KEY,
    sinal      smallint NOT NULL,
    descricao  text NOT NULL,
    CONSTRAINT lancamentoexternotipo_sinal_chk CHECK (sinal IN (-1, 1))
);

COMMENT ON TABLE "LancamentoExternoTipo" IS
  'FR-011/FR-013: tipos de valor pago por fora. `sinal` -1 deduz do repasse, +1 soma. Tipo novo = INSERT, sem DDL.';

INSERT INTO "LancamentoExternoTipo" (codigo, sinal, descricao) VALUES
    ('ADIANTAMENTO',   -1, 'Adiantamento pago por fora do sistema: deduz do repasse da semana'),
    ('AJUSTE_CREDITO',  1, 'Acerto a favor do motorista: soma ao repasse da semana')
ON CONFLICT (codigo) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. LancamentoExterno — append-only
-- ═══════════════════════════════════════════════════════════════════════
-- Modelo seguindo o padrão vigente (0108_repasse_lote.sql:12-49): chave
-- sequencial, empresa obrigatória, autoria, restrições NOMEADAS, índice
-- idempotente.
--
-- `entregador_id` é resolvido do CNPJ no MOMENTO do import e GRAVADO. Resolver
-- no cálculo seria pior em duas frentes: (a) toda rodada de repasse pagaria um
-- join a mais; (b) uma reconstrução futura do vínculo por similaridade de nome
-- (como a 0093 fez) mudaria em silêncio a entrada de uma apuração JÁ CONGELADA.
-- O CNPJ fica gravado junto porque é ele a chave de idempotência (D6/FR-026) e
-- a prova de autoria do que o financeiro digitou.
CREATE TABLE IF NOT EXISTS "LancamentoExterno" (
    id              bigserial PRIMARY KEY,
    id_empresa      int NOT NULL,
    entregador_id   int NOT NULL REFERENCES "Entregador"(id),
    cnpj_prestador  text NOT NULL,
    data_pagamento  date NOT NULL,
    tipo            text NOT NULL REFERENCES "LancamentoExternoTipo"(codigo),
    valor           numeric(12,2) NOT NULL,
    observacao      text NULL,
    criado_por      int NOT NULL REFERENCES "Usuario"(id),
    criado_em       timestamptz NOT NULL DEFAULT now(),

    -- FR-026-IDEMP (D6): no máximo um lançamento de cada tipo, por motorista,
    -- por dia. Sem TTL — o efeito é dinheiro, logo é permanente. É também o que
    -- transforma reenvio do arquivo inteiro em operação segura (US3).
    CONSTRAINT lancamentoexterno_idempotencia_uniq
        UNIQUE (id_empresa, cnpj_prestador, data_pagamento, tipo),

    -- FR-006/D2: valor SEMPRE positivo; o sentido vem do tipo, nunca do sinal.
    CONSTRAINT lancamentoexterno_valor_positivo_chk CHECK (valor > 0),
    -- FR-005: 14 dígitos após normalização (a máscara é removida na borda).
    CONSTRAINT lancamentoexterno_cnpj_14_chk CHECK (cnpj_prestador ~ '^[0-9]{14}$'),
    -- FR-008: 500 caracteres, sem truncamento silencioso.
    CONSTRAINT lancamentoexterno_observacao_tam_chk
        CHECK (observacao IS NULL OR char_length(observacao) <= 500),
    -- FR-048: piso da faixa de data. O teto (hoje+1) NÃO entra em CHECK porque
    -- `now()` não é imutável; ele é validado na borda (JS) e, de novo, na função de
    -- aplicação (recusa de LINHA, nunca exceção — a RPC é chamável direto pelo PostgREST).
    CONSTRAINT lancamentoexterno_data_piso_chk CHECK (data_pagamento >= DATE '2024-01-01')
);

COMMENT ON TABLE "LancamentoExterno" IS
  'Valor pago por fora do sistema a um motorista (FR-001..FR-029). Não se edita; a ÚNICA exclusão é hub_lancamento_externo_excluir (semana aberta, com rastro em LancamentoExternoExclusao — FR-056).';
COMMENT ON COLUMN "LancamentoExterno".data_pagamento IS
  'FR-014/D4: QUANDO o dinheiro saiu do caixa. A semana é a que CONTÉM esta data — sem o deslocamento de -1 dia do adiantamento do app.';
COMMENT ON COLUMN "LancamentoExterno".entregador_id IS
  'Resolvido do CNPJ no import e gravado: o congelado de uma apuração nunca muda se o vínculo for reconstruído depois.';

-- FR-042-PERF/SC-009: a rotina de repasse varre a semana inteira da empresa.
-- Colunas na ordem igualdade -> faixa -> agrupamento (Supabase
-- query-composite-indexes: "place equality columns first, range columns last"),
-- e `entregador_id` no fim porque é por ele que a CTE agrupa.
-- Esta é exatamente a lacuna que 0066:224-225 deixou aberta e que FR-042 proíbe
-- repetir.
CREATE INDEX IF NOT EXISTS idx_lancamentoexterno_empresa_data_entregador
    ON "LancamentoExterno" (id_empresa, data_pagamento, entregador_id);

-- FK sem índice é varredura na checagem de integridade (Supabase
-- schema-foreign-key-indexes). `entregador_id` já é coberto como 3ª coluna só
-- para o caso com os dois primeiros filtros; um índice próprio cobre o uso
-- isolado (ex.: auditar um motorista).
CREATE INDEX IF NOT EXISTS idx_lancamentoexterno_entregador
    ON "LancamentoExterno" (entregador_id);

-- ═══════════════════════════════════════════════════════════════════════
-- 3. RLS — a camada de dados é PÚBLICA (PostgREST exposto)
-- ═══════════════════════════════════════════════════════════════════════
-- FR-036: leitura restrita ao escopo; escrita SÓ por caminho privilegiado.
-- Nenhum GRANT de INSERT/UPDATE/DELETE é concedido a `authenticated` — a única
-- porta de escrita é a função SECURITY DEFINER da seção 5.
ALTER TABLE "LancamentoExterno" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LancamentoExternoTipo" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lancamentoexterno_select_por_escopo ON "LancamentoExterno";
-- Forma IDÊNTICA à de toda a série (0066:450, 0108:115). MEDIDO em
-- hub_homolog (PG 13.23): a forma recomendada pelo guia Supabase
-- (security-rls-performance, "wrap functions in SELECT") NÃO se aplica a
-- função que devolve array — `= ANY ((SELECT hub_jwt_escopo_ids()))` é parseado
-- como a forma SUBQUERY de ANY e falha com
-- `ERROR: operator does not exist: integer = integer[]`.
-- O ganho de InitPlan também não teria beneficiário aqui: o caminho quente
-- (CTE do repasse) roda dentro de função SECURITY DEFINER, que não passa por
-- RLS; a listagem da rodada 3 (6.1) também é SECURITY DEFINER e não passa por esta policy. A forma correta para
-- array seria `IN (SELECT unnest(...))` — registrada como dívida de repo no
-- plano, não aplicada pontualmente só aqui.
CREATE POLICY lancamentoexterno_select_por_escopo ON "LancamentoExterno"
    FOR SELECT USING (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS lancamentoexternotipo_select_todos ON "LancamentoExternoTipo";
-- Tabela de domínio (2 linhas, sem dado de ninguém): leitura liberada a quem
-- está autenticado, para a tela montar o seletor de tipo (FR-010).
CREATE POLICY lancamentoexternotipo_select_todos ON "LancamentoExternoTipo"
    FOR SELECT USING (true);

GRANT SELECT ON "LancamentoExterno" TO authenticated;
GRANT SELECT ON "LancamentoExternoTipo" TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON "LancamentoExterno" FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON "LancamentoExternoTipo" FROM authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Início da semana — UM lugar
-- ═══════════════════════════════════════════════════════════════════════
-- `apuracao_dia_inicio` é `extract(dow)`: domingo=0 ... sábado=6
-- (0066:92 restringe a 0..6; 0086:43-60 valida o alinhamento do período).
-- A fórmula é a MESMA já usada 5x na série; aqui ela ganha nome para o código
-- novo não criar a 6ª cópia.
CREATE OR REPLACE FUNCTION hub_apuracao_semana_de(p_data date, p_dia_inicio smallint)
RETURNS date
LANGUAGE sql IMMUTABLE STRICT
AS $$
    SELECT p_data - ((extract(dow FROM p_data)::int - p_dia_inicio + 7) % 7);
$$;

COMMENT ON FUNCTION hub_apuracao_semana_de(date, smallint) IS
  'FR-014/FR-015: início da semana de apuração que CONTÉM p_data, derivado da configuração (nunca fixo em código). Mesma fórmula de 0071:66/0083:182/0088:291/0089:57.';

REVOKE ALL ON FUNCTION hub_apuracao_semana_de(date, smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_apuracao_semana_de(date, smallint) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 5.0 Auxiliares internos (NÃO concedidos a `authenticated`: só as funções
-- SECURITY DEFINER abaixo as chamam)
-- ─────────────────────────────────────────────────────────────────────────
-- A semana que contém `p_data` já foi FECHADA? Um lugar só para `aplicar`, `excluir` e `listar`: a
-- regra "semana fechada é imutável" (FR-020) não pode divergir entre escrever, apagar e mostrar.
-- `OR` por contenção: se `apuracao_dia_inicio` mudou DEPOIS de uma apuração, a semana derivada hoje pode não
-- coincidir com o `periodo_inicio` antigo — e a data cairia numa semana já congelada sem ninguém notar.
CREATE OR REPLACE FUNCTION hub_lancamento_externo_semana_fechada(p_data date, p_dia_inicio smallint)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (SELECT 1 FROM "ApuracaoRepasse" a
                   WHERE a.id_empresa = 6
                     AND (a.periodo_inicio = hub_apuracao_semana_de(p_data, p_dia_inicio)
                          OR p_data BETWEEN a.periodo_inicio AND a.periodo_fim));
$$;
REVOKE ALL ON FUNCTION hub_lancamento_externo_semana_fechada(date, smallint) FROM PUBLIC;

-- ALTO 2 (rodada 3): remanescente da semana de UM motorista, ANTES do saldo anterior e do piso: a MESMA
-- conta da prévia e do fechamento (`creditos - adiantamentos - debitos - externos_deducao + externos_credito`,
-- com os mesmos gates de flag). É o "líquido disponível" contra o qual uma dedução é conferida: uma
-- dedução maior que ele deixaria o remanescente NEGATIVO, e o negativo NÃO transporta (`valor_transportado =
-- saldo_anterior`) — o excedente sumiria numa tabela append-only, quebrando SC-001 (zero centavo).
-- ⚠️ Cópia deliberada da conta (mesmo motivo do helper de semana: refatorar as funções vivas de dinheiro não é
-- requisito); o driver de integração AFIRMA igualdade com o `remanescente` da prévia, que é o que impede a deriva.
CREATE OR REPLACE FUNCTION hub_lancamento_externo_liquido(p_entregador_id int, p_inicio date, p_config "AdiantamentoConfiguracao")
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        COALESCE((SELECT sum(f.valor) FROM "FaturamentoLancamento" f
                  WHERE f.id_empresa = 6 AND f.entregador_id = p_entregador_id AND f.tipo = 'Credito'
                    AND hub_adiantamento_categoria_casa(f.descricao, COALESCE(p_config.categorias_extrato, ARRAY[]::text[]))
                    AND ((p_config.apuracao_data_base = 'data_lancamento' AND f.data_lancamento BETWEEN p_inicio AND p_inicio + 6)
                      OR (p_config.apuracao_data_base = 'data_referencia' AND f.data_referencia BETWEEN p_inicio AND p_inicio + 6))), 0)
      - CASE WHEN p_config.desconto_adiantamentos THEN
            COALESCE((SELECT sum(s.valor_bruto) FROM "AdiantamentoSolicitacao" s
                      WHERE s.id_empresa = 6 AND s.entregador_id = p_entregador_id AND s.status IN ('PAGA', 'EXPORTADA')
                        AND s.data_producao BETWEEN p_inicio AND p_inicio + 6), 0)
        ELSE 0 END
      - CASE WHEN p_config.desconto_debitos THEN
            COALESCE((SELECT sum(abs(f.valor)) FROM "FaturamentoLancamento" f
                      WHERE f.id_empresa = 6 AND f.entregador_id = p_entregador_id AND f.tipo = 'Debito'
                        AND ((p_config.apuracao_data_base = 'data_lancamento' AND f.data_lancamento BETWEEN p_inicio AND p_inicio + 6)
                          OR (p_config.apuracao_data_base = 'data_referencia' AND f.data_referencia BETWEEN p_inicio AND p_inicio + 6))), 0)
        ELSE 0 END
      + COALESCE((SELECT sum(CASE WHEN t.sinal > 0 THEN l.valor
                                  WHEN p_config.desconto_adiantamentos THEN -l.valor
                                  ELSE 0 END)
                  FROM "LancamentoExterno" l JOIN "LancamentoExternoTipo" t ON t.codigo = l.tipo
                  WHERE l.id_empresa = 6 AND l.entregador_id = p_entregador_id
                    AND l.data_pagamento BETWEEN p_inicio AND p_inicio + 6), 0);
$$;
REVOKE ALL ON FUNCTION hub_lancamento_externo_liquido(int, date, "AdiantamentoConfiguracao") FROM PUBLIC;

-- ═══════════════════════════════════════════════════════════════════════
-- 5. Aplicação do arquivo — única porta de escrita
-- ═══════════════════════════════════════════════════════════════════════
-- FR-034 (permissão), FR-035 (escopo do token), FR-036 (caminho privilegiado),
-- FR-020 (semana fechada recusa só a linha), FR-027/FR-028 (idempotência),
-- FR-041 (serializado contra o fechamento).
--
-- Devolve UMA linha por linha de entrada, com a situação nomeada (FR-032). Quem
-- chama agrega por motivo e NUNCA devolve CNPJ (FR-031).
DROP FUNCTION IF EXISTS hub_lancamento_externo_aplicar(text, jsonb);

CREATE FUNCTION hub_lancamento_externo_aplicar(p_tipo text, p_linhas jsonb)
RETURNS TABLE (idx int, situacao text, liquido numeric)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_sub      int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_escopo   int[] := hub_jwt_escopo_ids();
    v_config   "AdiantamentoConfiguracao";
    v_sinal    smallint;
    v_linha    jsonb;
    v_idx      int;
    v_cnpj     text;
    v_data     date;
    v_valor    numeric(12,2);
    v_bruto    numeric;
    v_ord      bigint;
    v_obs      text;
    v_entregador_id int;
    v_semana   date;
    v_existente numeric(12,2);
    v_liquido  numeric;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.pagamento_confirmar') THEN
        RAISE EXCEPTION 'PERMISSAO_NEGADA';
    END IF;

    -- FR-010/FR-011: o tipo vem da tela e vale para o arquivo todo. Tipo fora
    -- do domínio é erro de ARQUIVO (não de linha): aborta sem gravar nada.
    SELECT t.sinal INTO v_sinal FROM "LancamentoExternoTipo" t WHERE t.codigo = p_tipo;
    IF v_sinal IS NULL THEN RAISE EXCEPTION 'TIPO_INVALIDO'; END IF;

    -- ⚠️ GATE DE ESCOPO — achado do gate owasp-security (BOLA / API1 / ASI03).
    -- A apuração é SEMPRE da empresa 6 (`0098:142/145/179/190/306` fixam 6 na
    -- função), então tudo aqui grava 6. Sem esta checagem, um usuário de OUTRA
    -- empresa (escopo [9002], por exemplo) resolveria um `entregador_id` do
    -- PRÓPRIO escopo e a linha seria gravada como lançamento da empresa 6 —
    -- escrita cross-tenant, injetando dedução na apuração de outro tenant e
    -- apontando para um entregador que não é dela.
    -- Fail-closed: quem não alcança a 6 não escreve nada.
    IF NOT (6 = ANY (v_escopo)) THEN RAISE EXCEPTION 'FORA_DE_ESCOPO'; END IF;

    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(6);
    IF v_config.id IS NULL OR v_config.apuracao_dia_inicio IS NULL THEN
        RAISE EXCEPTION 'APURACAO_NAO_CONFIGURADA';
    END IF;

    -- FR-041: MESMA trava do fechamento (0098:135). Sem ela, o fechamento
    -- poderia congelar o retrato entre a checagem "semana aberta" e o INSERT,
    -- gravando um lançamento que nunca teria efeito. O lock é de transação:
    -- some no COMMIT/ROLLBACK.
    PERFORM pg_advisory_xact_lock(6, hashtext('hub_adiantamento_repasse_fechar'));

    FOR v_linha, v_ord IN SELECT e.value, e.ordinality FROM jsonb_array_elements(p_linhas) WITH ORDINALITY e
    LOOP
        -- P8: o cast de `data`/`valor` ANTES da recusa abortava o LOTE inteiro com uma exceção
        -- de sintaxe ('2026-13-45', 'abc', 1e20 => numeric overflow). A RPC é chamável direto
        -- pelo PostgREST, então o promessa "recusa só a linha" tem de valer aqui também.
        v_idx  := CASE WHEN v_linha ->> 'i' ~ '^[0-9]{1,9}$' THEN (v_linha ->> 'i')::int ELSE (v_ord - 1)::int END;
        v_cnpj := v_linha ->> 'cnpj';
        v_obs  := NULLIF(v_linha ->> 'obs', '');
        v_data := NULL; v_bruto := NULL;
        BEGIN
            v_data := (v_linha ->> 'data')::date;
        EXCEPTION WHEN OTHERS THEN v_data := NULL;
        END;
        BEGIN
            v_bruto := (v_linha ->> 'valor')::numeric;
        EXCEPTION WHEN OTHERS THEN v_bruto := NULL;
        END;
        IF v_data IS NULL THEN
            RETURN QUERY SELECT v_idx, 'DATA_INVALIDA'::text, NULL::numeric;
            CONTINUE;
        END IF;
        IF v_bruto IS NULL THEN
            RETURN QUERY SELECT v_idx, 'VALOR_INVALIDO'::text, NULL::numeric;
            CONTINUE;
        END IF;

        -- FR-048 / dec-026 (defesa em profundidade): a RPC é chamável direto pelo PostgREST por
        -- quem tem `pagamento_confirmar`, sem passar pelo leitor JS. As faixas valem aqui também,
        -- como RECUSA DE LINHA (mesmos tokens do JS) — nunca `CHECK`/exceção, que abortaria o lote.
        IF v_data < DATE '2024-01-01'
           OR v_data > (now() AT TIME ZONE v_config.timezone)::date + 1 THEN
            RETURN QUERY SELECT v_idx, 'DATA_FORA_DA_FAIXA'::text, NULL::numeric;
            CONTINUE;
        END IF;
        IF v_bruto <= 0 THEN
            RETURN QUERY SELECT v_idx, 'VALOR_INVALIDO'::text, NULL::numeric;
            CONTINUE;
        END IF;
        IF v_bruto > 5000.00 THEN
            RETURN QUERY SELECT v_idx, 'VALOR_ACIMA_DO_TETO'::text, NULL::numeric;
            CONTINUE;
        END IF;
        -- o cast para numeric(12,2) arredonda calado (100.005 -> 100.01); aqui é recusa.
        IF v_bruto <> round(v_bruto, 2) THEN
            RETURN QUERY SELECT v_idx, 'VALOR_FRACAO_DE_CENTAVO'::text, NULL::numeric;
            CONTINUE;
        END IF;
        v_valor := v_bruto::numeric(12,2);
        IF v_obs IS NOT NULL AND char_length(v_obs) > 500 THEN
            RETURN QUERY SELECT v_idx, 'OBSERVACAO_MUITO_LONGA'::text, NULL::numeric;
            CONTINUE;
        END IF;

        -- FR-023/FR-024/FR-025: CNPJ alcança no máximo um motorista
        -- (ContaMotorista.cnpj_prestador UNIQUE em 0021:20 + vínculo único em
        -- 0021:57-58). Sem vínculo => recusa DA LINHA, nunca do arquivo.
        -- `e.id_empresa = 6`, NÃO `= ANY (v_escopo)`: a linha é gravada como
        -- lançamento da empresa 6, logo o entregador tem de ser DA 6. Resolver
        -- contra o escopo e gravar como 6 era a 2ª metade do achado de escopo
        -- misturado — um escopo [6, 9002] resolveria entregador da 9002 e o
        -- gravaria na apuração da 6. Os dois lados usam o MESMO número.
        SELECT e.id INTO v_entregador_id
        FROM "Entregador" e
        JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
        WHERE cm.cnpj_prestador = v_cnpj
          AND e.id_empresa = 6;

        IF v_entregador_id IS NULL THEN
            RETURN QUERY SELECT v_idx, 'CNPJ_SEM_MOTORISTA'::text, NULL::numeric;
            CONTINUE;
        END IF;

        -- H5 (revisão rodada 2): a IDEMPOTÊNCIA vem ANTES da janela da semana. Na ordem inversa, o
        -- reenvio de uma linha JÁ APLICADA numa semana depois fechada voltava `SEMANA_JA_FECHADA`, byte a byte
        -- igual ao de uma linha NUNCA aplicada — o operador lia "perdi as 40", relançava na semana seguinte e
        -- o motorista era deduzido duas vezes. FR-027: mesma chave + mesmo valor é SEMPRE `JA_APLICADO`.
        -- FR-027/FR-028: mesma chave e mesmo valor => JA_APLICADO (nada muda);
        -- mesma chave e valor diferente => recusa, preservando o original.
        -- O sistema NUNCA sobrescreve um lançamento.
        SELECT l.valor INTO v_existente
        FROM "LancamentoExterno" l
        WHERE l.id_empresa = 6 AND l.cnpj_prestador = v_cnpj
          AND l.data_pagamento = v_data AND l.tipo = p_tipo;

        IF v_existente IS NOT NULL THEN
            RETURN QUERY SELECT v_idx,
                CASE WHEN v_existente = v_valor THEN 'JA_APLICADO' ELSE 'VALOR_DIVERGENTE' END::text, NULL::numeric;
            CONTINUE;
        END IF;

        -- FR-014/FR-020: a semana é a que CONTÉM a data do pagamento. Já
        -- fechada => recusa só a linha.
        v_semana := hub_apuracao_semana_de(v_data, v_config.apuracao_dia_inicio);
        -- `OR` por contenção: se `apuracao_dia_inicio` mudou DEPOIS de uma apuração, a semana
        -- derivada hoje pode não coincidir com o `periodo_inicio` antigo — e a linha entraria
        -- numa semana já congelada, sem efeito e sem aviso. A contenção fecha esse furo.
        IF hub_lancamento_externo_semana_fechada(v_data, v_config.apuracao_dia_inicio) THEN
            RETURN QUERY SELECT v_idx, 'SEMANA_JA_FECHADA'::text, NULL::numeric;
            CONTINUE;
        END IF;

        -- P3: semana ANTERIOR à primeira apuração passa piso e teto mas nunca pode ser fechada
        -- (`fechar` exige max+7, sem pular semana) => linha fantasma eterna numa tabela
        -- append-only. Com zero apuração, qualquer semana ainda é alcançável: não recusa.
        IF v_semana < (SELECT min(a.periodo_inicio) FROM "ApuracaoRepasse" a WHERE a.id_empresa = 6) THEN
            RETURN QUERY SELECT v_idx, 'SEMANA_ANTERIOR_A_APURACAO'::text, NULL::numeric;
            CONTINUE;
        END IF;

        -- ALTO 2 (rodada 3, decisão do operador 2026-10-23): a DEDUÇÃO que excede o líquido disponível é RECUSADA
        -- (a linha, nunca o arquivo), nomeando o líquido para o operador saber quanto cabe. Sem isto o excedente
        -- desaparece: remanescente negativo => valor_pago 0 e o negativo NÃO transporta. ORDEM DE APLICAÇÃO: o líquido
        -- é lido do banco NO MOMENTO da linha, logo já desconta as linhas ANTERIORES do mesmo arquivo (e de arquivos
        -- anteriores) que foram gravadas — duas deduções do mesmo motorista na mesma semana disputam o mesmo saldo,
        -- na ordem do arquivo. Um AJUSTE_CREDITO importado ANTES eleva o líquido; importado depois, não reabre
        -- linha já recusada. Só vale com a flag `desconto_adiantamentos` ligada (desligada, a dedução nem pesa
        -- no repasse e o aviso de FR-049 já cobre). Crédito (sinal > 0) nunca é recusado por isto.
        IF v_sinal < 0 AND v_config.desconto_adiantamentos THEN
            v_liquido := greatest(hub_lancamento_externo_liquido(v_entregador_id, v_semana, v_config), 0);
            IF v_valor > v_liquido THEN
                RETURN QUERY SELECT v_idx, 'VALOR_EXCEDE_LIQUIDO'::text, v_liquido;
                CONTINUE;
            END IF;
        END IF;

        INSERT INTO "LancamentoExterno"
            (id_empresa, entregador_id, cnpj_prestador, data_pagamento, tipo, valor, observacao, criado_por)
        VALUES (6, v_entregador_id, v_cnpj, v_data, p_tipo, v_valor, v_obs, v_sub);

        RETURN QUERY SELECT v_idx, 'APLICADA'::text, NULL::numeric;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION hub_lancamento_externo_aplicar(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_lancamento_externo_aplicar(text, jsonb) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. Resumo da semana — alimenta o aviso de FR-049
-- ═══════════════════════════════════════════════════════════════════════
-- Só CONTAGEM e TOTAL: nenhum dado identificável sai daqui (FR-031).
-- `flag_desconto_ligada` vem da configuração vigente para a tela poder avisar
-- quando houver dedução numa semana em que a flag está desligada.
-- A2 (rodada 4): o resumo também diz QUANTOS motoristas com lançamento por fora na semana estão com remanescente
-- NEGATIVO agora e QUANTO evaporaria no fechamento. A guarda do `aplicar` só vale no instante do import: débito de
-- faturamento que chega depois (o robô importa 11h/13h/14h) ou a flag ligada com a semana aberta invalidam o que foi
-- conferido. Decisão de desenho do operador: o fechamento NÃO recusa (fechar é irreversível e a segunda não pode
-- travar) — INFORMA, e a tela exige confirmação explícita. Independe da flag. O tipo de retorno muda: DROP antes.
DROP FUNCTION IF EXISTS hub_lancamento_externo_resumo(date);
CREATE FUNCTION hub_lancamento_externo_resumo(p_periodo_inicio date)
RETURNS TABLE (
    qtd_deducao   int,
    total_deducao numeric(12,2),
    qtd_credito   int,
    total_credito numeric(12,2),
    flag_desconto_ligada boolean,
    qtd_negativo   int,
    total_negativo numeric(12,2)
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_escopo int[] := hub_jwt_escopo_ids();
    v_config "AdiantamentoConfiguracao";
    v_fim    date;
    v_neg_qtd   int := 0;
    v_neg_total numeric(12,2) := 0;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.pagamentos_consultar') THEN
        RAISE EXCEPTION 'PERMISSAO_NEGADA';
    END IF;
    -- H-escopo (rodada 2): FR-034/dec-036 exigem o MESMO gate da prévia, e a prévia
    -- (`hub_adiantamento_repasse`) NÃO levanta FORA_DE_ESCOPO — as linhas já são filtradas por
    -- `id_empresa = ANY (v_escopo)`. Um gate mais estreito aqui faria o aviso falhar numa entidade
    -- cuja prévia funciona. P9 continua valendo para a FLAG: a configuração lida é SEMPRE a da empresa 6,
    -- então quem não alcança a 6 NÃO recebe a flag dela (vem `false` = o aviso aparece, o lado seguro).
    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(6);
    IF v_config.id IS NULL THEN RAISE EXCEPTION 'APURACAO_NAO_CONFIGURADA'; END IF;
    v_fim := p_periodo_inicio + 6;

    -- A2: o líquido é o da empresa 6 (a apuração é só dela); quem não a alcança não vê nada daqui.
    IF 6 = ANY (v_escopo) THEN
        SELECT count(*)::int, COALESCE(sum(-x.liq), 0)::numeric(12,2) INTO v_neg_qtd, v_neg_total
        FROM (SELECT hub_lancamento_externo_liquido(d.entregador_id, p_periodo_inicio, v_config) AS liq
              FROM (-- Rodada 5b (A1): quem TEVE lançamento externo na semana, não só quem tem — um motorista cujos lançamentos
                    -- foram todos excluídos (dedução primeiro, crédito depois) fecha negativo e é justamente o que o aviso
                    -- precisa ver. O rastro de exclusão (LancamentoExternoExclusao) guarda quem teve.
                    SELECT l.entregador_id FROM "LancamentoExterno" l
                    WHERE l.id_empresa = 6 AND l.data_pagamento BETWEEN p_periodo_inicio AND v_fim
                    UNION
                    SELECT e.entregador_id FROM "LancamentoExternoExclusao" e
                    WHERE e.id_empresa = 6 AND e.data_pagamento BETWEEN p_periodo_inicio AND v_fim) d) x
        WHERE x.liq < 0;
    END IF;

    RETURN QUERY
    SELECT
        COALESCE(count(*) FILTER (WHERE t.sinal < 0), 0)::int,
        COALESCE(sum(l.valor) FILTER (WHERE t.sinal < 0), 0)::numeric(12,2),
        COALESCE(count(*) FILTER (WHERE t.sinal > 0), 0)::int,
        COALESCE(sum(l.valor) FILTER (WHERE t.sinal > 0), 0)::numeric(12,2),
        (6 = ANY (v_escopo)) AND v_config.desconto_adiantamentos,
        v_neg_qtd, v_neg_total
    FROM "LancamentoExterno" l
    JOIN "LancamentoExternoTipo" t ON t.codigo = l.tipo
    WHERE l.id_empresa = ANY (v_escopo)
      AND l.data_pagamento BETWEEN p_periodo_inicio AND v_fim;
END;
$$;

REVOKE ALL ON FUNCTION hub_lancamento_externo_resumo(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_lancamento_externo_resumo(date) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 6.1 Listagem e EXCLUSÃO de lançamento (autorizadas pelo operador em 2026-10-23, rodada 3)
-- ═══════════════════════════════════════════════════════════════════════
-- Até aqui o lançamento aplicado era insalvável (REVOKE de escrita + nenhuma função que apague): valor errado
-- ou pagamento em duplicidade no mesmo dia não tinha correção. A porta de saída é UMA função SECURITY DEFINER,
-- com a mesma permissão da importação, a mesma trava do fechamento e RASTRO: a linha apagada é copiada para
-- "LancamentoExternoExclusao" na MESMA transação (quem, quando, o quê e o valor que havia).
--
-- 🔴 REGRA INEGOCIÁVEL: lançamento de semana FECHADA não se exclui. O valor está congelado em
-- "ApuracaoRepasseItem"; apagar a origem deixaria o congelado e a tabela divergentes (a mesma classe de
-- divergência que já custou três defeitos nesta frente). Fail-closed: `SEMANA_JA_FECHADA`.
-- Excluir reabre a chave de idempotência (era o ponto): depois de excluir, reenviar a mesma linha volta a ser
-- `APLICADA`. A semana aberta recalcula sozinha (a prévia lê a tabela viva). E excluir um CRÉDITO pode derrubar o
-- líquido do motorista abaixo de zero (rodada 4, A1: crédito 100 + dedução 100 aceita; excluir o crédito => -100
-- que NÃO transporta e some). Por isso a exclusão de crédito é simétrica à guarda do `aplicar`: se o líquido
-- ficar negativo, RECUSA (`EXCLUSAO_DEIXA_LIQUIDO_NEGATIVO`) — a guarda é de UM passo (apagar a dedução e depois o crédito é possível; quem enxerga o resultado é o aviso do fechamento, que conta também quem teve lançamento excluído).
CREATE TABLE IF NOT EXISTS "LancamentoExternoExclusao" (
    id              bigserial PRIMARY KEY,
    lancamento_id   bigint NOT NULL,           -- o `id` que a linha TINHA (sem FK: ela deixou de existir)
    id_empresa      int NOT NULL,
    entregador_id   int NOT NULL REFERENCES "Entregador"(id),
    cnpj_prestador  text NOT NULL,
    data_pagamento  date NOT NULL,
    tipo            text NOT NULL,
    valor           numeric(12,2) NOT NULL,
    observacao      text NULL,
    criado_por      int NOT NULL,
    criado_em       timestamptz NOT NULL,
    excluido_por    int NOT NULL REFERENCES "Usuario"(id),
    excluido_em     timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE "LancamentoExternoExclusao" IS
  'Rastro das exclusões de "LancamentoExterno" (append-only): cópia da linha apagada + quem e quando excluiu.';
CREATE INDEX IF NOT EXISTS idx_lancamentoexternoexclusao_entregador ON "LancamentoExternoExclusao" (entregador_id);
-- M8 (rodada 4): NENHUM leitor do produto lê esta tabela, e ela guarda `cnpj_prestador` — dado que a listagem
-- (`hub_lancamento_externo_listar`) deliberadamente NÃO expõe. O SELECT por escopo anterior tinha gate MAIS FRACO que
-- a listagem (qualquer `authenticated` do escopo 6, sem permissão). Menor privilégio: sem acesso do PostgREST; o
-- rastro é lido por quem opera o banco (auditoria) e, se um dia o produto precisar dele, nasce uma função com gate.
ALTER TABLE "LancamentoExternoExclusao" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lancamentoexternoexclusao_select_por_escopo ON "LancamentoExternoExclusao";
REVOKE ALL ON "LancamentoExternoExclusao" FROM authenticated;
REVOKE ALL ON SEQUENCE "LancamentoExternoExclusao_id_seq" FROM authenticated;

-- Rodada 4: ganha `semana_fechada` (M3: a tela rotulava "Semana fechada" também quando a causa era permissão); o
-- tipo de retorno muda, então DROP antes.
DROP FUNCTION IF EXISTS hub_lancamento_externo_listar(date, text, int, int);
CREATE FUNCTION hub_lancamento_externo_listar(
    p_periodo_inicio date, p_busca text DEFAULT NULL, p_offset int DEFAULT 0, p_limite int DEFAULT 50
)
RETURNS TABLE (
    id bigint, entregador_nome text, tipo text, sinal smallint, data_pagamento date, valor numeric(12,2),
    observacao text, criado_em timestamptz, criado_por_nome text, excluivel boolean, total bigint,
    semana_fechada boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_escopo int[] := hub_jwt_escopo_ids();
    v_config "AdiantamentoConfiguracao";
    v_pode   boolean;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.pagamentos_consultar') THEN
        RAISE EXCEPTION 'PERMISSAO_NEGADA';
    END IF;
    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(6);
    IF v_config.id IS NULL THEN RAISE EXCEPTION 'APURACAO_NAO_CONFIGURADA'; END IF;
    -- `excluivel` é só uma DICA de tela: quem decide é `excluir` (mesma permissão de escrita, escopo, semana).
    v_pode := (6 = ANY (v_escopo)) AND hub_adiantamento_tem_permissao('adiantamentos.pagamento_confirmar');

    RETURN QUERY
    WITH pagina AS (
        SELECT l.id, e.nome AS entregador_nome, l.tipo, t.sinal, l.data_pagamento, l.valor, l.observacao,
               l.criado_em, u.nome AS criado_por_nome, count(*) OVER () AS total
        FROM "LancamentoExterno" l
        JOIN "LancamentoExternoTipo" t ON t.codigo = l.tipo
        JOIN "Entregador" e ON e.id = l.entregador_id
        LEFT JOIN "Usuario" u ON u.id = l.criado_por
        WHERE l.id_empresa = ANY (v_escopo)
          AND l.data_pagamento BETWEEN p_periodo_inicio AND p_periodo_inicio + 6
          AND (p_busca IS NULL OR hub_normaliza_nome(e.nome) LIKE '%' || hub_normaliza_nome(p_busca) || '%')
        ORDER BY l.data_pagamento DESC, e.nome, l.id
        OFFSET greatest(p_offset, 0) LIMIT least(greatest(p_limite, 1), 200)
    )
    SELECT p.id, p.entregador_nome, p.tipo, p.sinal, p.data_pagamento, p.valor, p.observacao, p.criado_em,
           p.criado_por_nome,
           COALESCE(v_pode AND NOT hub_lancamento_externo_semana_fechada(p.data_pagamento, v_config.apuracao_dia_inicio), false),
           p.total,
           hub_lancamento_externo_semana_fechada(p.data_pagamento, v_config.apuracao_dia_inicio)
    FROM pagina p
    ORDER BY p.data_pagamento DESC, p.entregador_nome, p.id;
END;
$$;
REVOKE ALL ON FUNCTION hub_lancamento_externo_listar(date, text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_lancamento_externo_listar(date, text, int, int) TO authenticated;

CREATE OR REPLACE FUNCTION hub_lancamento_externo_excluir(p_id bigint)
RETURNS TABLE (lancamento_id bigint, tipo_excluido text, valor_excluido numeric, data_excluida date)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_sub    int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_escopo int[] := hub_jwt_escopo_ids();
    v_config "AdiantamentoConfiguracao";
    v_l      "LancamentoExterno";
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.pagamento_confirmar') THEN
        RAISE EXCEPTION 'PERMISSAO_NEGADA';
    END IF;
    -- Mesmo gate de escopo do `aplicar` (a apuração é sempre da empresa 6): quem não a alcança não apaga nada.
    IF NOT (6 = ANY (v_escopo)) THEN RAISE EXCEPTION 'FORA_DE_ESCOPO'; END IF;
    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(6);
    IF v_config.id IS NULL OR v_config.apuracao_dia_inicio IS NULL THEN
        RAISE EXCEPTION 'APURACAO_NAO_CONFIGURADA';
    END IF;

    -- MESMA trava do fechamento e da importação: sem ela, o fechamento congelaria a semana entre a checagem
    -- "semana aberta" e o DELETE, e a exclusão apagaria a origem de um valor já congelado.
    PERFORM pg_advisory_xact_lock(6, hashtext('hub_adiantamento_repasse_fechar'));

    SELECT * INTO v_l FROM "LancamentoExterno" l WHERE l.id = p_id AND l.id_empresa = 6 FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'LANCAMENTO_NAO_ENCONTRADO'; END IF;

    IF hub_lancamento_externo_semana_fechada(v_l.data_pagamento, v_config.apuracao_dia_inicio) THEN
        RAISE EXCEPTION 'SEMANA_JA_FECHADA';
    END IF;

    INSERT INTO "LancamentoExternoExclusao"
        (lancamento_id, id_empresa, entregador_id, cnpj_prestador, data_pagamento, tipo, valor, observacao,
         criado_por, criado_em, excluido_por)
    VALUES (v_l.id, v_l.id_empresa, v_l.entregador_id, v_l.cnpj_prestador, v_l.data_pagamento, v_l.tipo, v_l.valor,
            v_l.observacao, v_l.criado_por, v_l.criado_em, v_sub);
    DELETE FROM "LancamentoExterno" WHERE id = v_l.id;

    -- A1 (rodada 4): excluir CRÉDITO reduz o líquido; se ele ficar negativo o excedente evapora no fechamento.
    -- Fail-closed (a exceção desfaz o INSERT de rastro e o DELETE acima). Dedução excluída só AUMENTA o líquido.
    -- Rodada 5 (C3): a guarda só vale quando EXISTE uma dedução de `LancamentoExterno` que pese no líquido e que o
    -- operador consiga apagar (é a única que `excluir` alcança; o HINT manda apagá-la). Dedução do app
    -- (AdiantamentoSolicitacao) e Debito de FaturamentoLancamento não são apagáveis aqui: considerá-las trancava o
    -- crédito para sempre (semana aberta: esta guarda; fechada: SEMANA_JA_FECHADA). Com a flag
    -- `desconto_adiantamentos` desligada a dedução externa nem pesa no líquido, então apagá-la não ajudaria.
    IF (SELECT t.sinal FROM "LancamentoExternoTipo" t WHERE t.codigo = v_l.tipo) > 0
       AND v_config.desconto_adiantamentos
       AND EXISTS (SELECT 1 FROM "LancamentoExterno" x JOIN "LancamentoExternoTipo" xt ON xt.codigo = x.tipo
                   WHERE x.id_empresa = 6 AND x.entregador_id = v_l.entregador_id AND xt.sinal < 0
                     AND x.data_pagamento BETWEEN hub_apuracao_semana_de(v_l.data_pagamento, v_config.apuracao_dia_inicio)
                                              AND hub_apuracao_semana_de(v_l.data_pagamento, v_config.apuracao_dia_inicio) + 6)
       AND hub_lancamento_externo_liquido(v_l.entregador_id,
               hub_apuracao_semana_de(v_l.data_pagamento, v_config.apuracao_dia_inicio), v_config) < 0 THEN
        RAISE EXCEPTION 'EXCLUSAO_DEIXA_LIQUIDO_NEGATIVO'
            USING HINT = 'Existe dedução (lançamento pago por fora) que só cabe por causa deste crédito: apagar a dedução e depois este crédito é permitido, mas o líquido pode fechar negativo e o excedente não será pago nem transportado: confira o aviso ao fechar a semana.';
    END IF;

    RETURN QUERY SELECT v_l.id, v_l.tipo, v_l.valor::numeric, v_l.data_pagamento;
END;
$$;
REVOKE ALL ON FUNCTION hub_lancamento_externo_excluir(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_lancamento_externo_excluir(bigint) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 7. Rastro do lançamento externo no item CONGELADO
-- ═══════════════════════════════════════════════════════════════════════
-- FR-019 + auditabilidade do retrato imutável: sem esta coluna, o item fechado
-- teria `remanescente <> creditos - adiantamentos - debitos` e a diferença
-- ficaria SEM EXPLICAÇÃO para sempre.
--
-- UMA coluna, com o efeito LÍQUIDO e JÁ APÓS o gate da flag (negativo = dedução,
-- positivo = crédito) — é exatamente o valor que entrou no remanescente.
-- DEFAULT 0 é o default seguro: quem não usa a feature tem 0 e a aritmética é
-- byte-a-byte a de hoje (FR-021/SC-008).
-- ADD COLUMN não é UPDATE: os bloqueios de imutabilidade de 0066:443-470
-- (REVOKE UPDATE/DELETE + trigger) não são tocados nem enfraquecidos.
ALTER TABLE "ApuracaoRepasseItem"
    ADD COLUMN IF NOT EXISTS lancamentos_externos numeric(12,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN "ApuracaoRepasseItem".lancamentos_externos IS
  'FR-016/FR-018: efeito líquido dos lançamentos pagos por fora, já após o gate de `desconto_adiantamentos`. Negativo deduz, positivo soma. 0 = empresa sem a feature.';

-- O CHECK `apuracaorepasseitem_saldo_conserva` (0098:71-81) NÃO é alterado:
-- ele amarra `remanescente + saldo_anterior = valor_pago + valor_transportado`
-- e não envolve as parcelas que compõem o remanescente. Verificado: não existe
-- nenhum CHECK ligando remanescente a creditos/adiantamentos/debitos.

-- ═════════════════════════════════════════════════════════════════
-- 8. O termo entra nas funções VIVAS do repasse (FR-016/FR-017/FR-018)
-- ═════════════════════════════════════════════════════════════════
-- Definições vivas (research Decision 1): prévia = 0100:26, fechamento = 0098:111.
-- (0098:321-444 e 0071:104 são versões MORTAS da prévia: alterá-las deixaria a
-- prévia divergindo do fechamento.) Corpo = a versão viva, byte a byte, mais SÓ
-- o termo novo: `externos_cte`, as duas colunas no `linhas`, o termo no
-- `remanescente` (o piso é testado DEPOIS dele, logo o crédito entra antes do
-- piso: R$ 4 + R$ 3 = R$ 7 recebe, FR-018) e, no fechamento, a gravação do
-- efeito líquido em `lancamentos_externos`. As assinaturas NÃO mudam; o tipo de retorno NÃO
-- muda em `fechar` => CREATE OR REPLACE preserva os GRANT; nas OUTRAS QUATRO o tipo de retorno
-- GANHA a coluna `lancamentos_externos` => `CREATE OR REPLACE` é recusado e o caminho é
-- DROP FUNCTION + CREATE FUNCTION + GRANT (8.1 a 8.5 abaixo). Há uma janela entre o DROP e o
-- GRANT: tudo roda na transação do `migrate.sh`, então nenhuma sessão a enxerga, e o DROP apaga a
-- ACL antiga (0098:30) — por isso cada CREATE é seguido do seu `GRANT EXECUTE ... TO authenticated`.
--
-- SÃO CINCO funções vivas (FR-022 nomeia os pontos: prévia, fechamento e DETALHE POR MOTORISTA,
-- `0098:515`, mais o congelado e o último fechado do APP). A 3ª (8.3, abaixo) é a que o APP DO MOTORISTA lê:
-- sem ela o motorista veria um remanescente e receberia outro. Esta omissão foi pega por
-- revisão independente, não pelo autor — o mesmo defeito de §0.1 do RUNBOOK ("feature escrita,
-- caminho não ligado") reaparecendo dentro da própria correção.

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
               OR x.entregador_id IS NOT NULL OR COALESCE(sa.valor_transportado, 0) > 0)
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
    resultado_nota AS (
        SELECT r.*,
               CASE
                   WHEN r.remanescente < 0 THEN r.saldo_anterior_nota
                   WHEN r.valor_pago = 0 AND r.valor_transportado > 0 THEN COALESCE(r.total_nota, 0) + r.saldo_anterior_nota
                   ELSE 0::numeric(12,2)
               END AS transportado_nota,
               CASE
                   WHEN r.remanescente < 0 THEN r.saldo_anterior_fora
                   WHEN r.valor_pago = 0 AND r.valor_transportado > 0 THEN COALESCE(r.total_fora, 0) + r.saldo_anterior_fora
                   ELSE 0::numeric(12,2)
               END AS transportado_fora
        FROM resultado r
    )
    INSERT INTO "ApuracaoRepasseItem" (apuracao_id, id_empresa, entregador_id, creditos, adiantamentos, debitos, remanescente,
                                      valor_nota, valor_fora_nota, detalhe,
                                      saldo_anterior, saldo_anterior_nota, saldo_anterior_fora,
                                      valor_pago, valor_transportado, transportado_nota, transportado_fora,
                                      lancamentos_externos)
    SELECT v_apuracao_id, 6, r.entregador_id, r.creditos, r.adiantamentos, r.debitos, r.remanescente,
           r.total_nota, r.total_fora,
           jsonb_build_object('solicitacoesPagas', r.solicitacoes_pagas),
           r.saldo_anterior, r.saldo_anterior_nota, r.saldo_anterior_fora,
           r.valor_pago, r.valor_transportado, r.transportado_nota, r.transportado_fora,
           (r.externos_credito - r.externos_deducao)
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
    lancamentos_externos numeric, total_lancamentos_externos numeric
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
        SELECT i.entregador_id, i.valor_transportado
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
               OR a.processando IS NOT NULL OR x.entregador_id IS NOT NULL OR COALESCE(sa.valor_transportado, 0) > 0)
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
    filtradas AS (
        SELECT * FROM piso WHERE (NOT p_somente_negativos OR remanescente < 0)
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
           (f.externos_credito - f.externos_deducao), sum(f.externos_credito - f.externos_deducao) OVER ()
    FROM filtradas f
    ORDER BY f.nome
    OFFSET p_offset LIMIT p_limite;
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_repasse(date, text, boolean, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse(date, text, boolean, int, int) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 8.3 hub_adiantamento_repasse_motorista() — semana em curso, APP do motorista
-- ─────────────────────────────────────────────────────────────────────────
-- Corpo = a versão viva (0098:515-627, byte a byte) mais SÓ o termo externo:
-- `v_externo_deducao` (sob o MESMO gate `desconto_adiantamentos`, FR-022) e
-- `v_externo_credito` (sem gate: crédito não é desconto). O piso (`abaixo_do_minimo`)
-- é calculado DEPOIS do remanescente, logo o crédito entra antes dele (FR-018).
-- Tipo de retorno MUDA (coluna `lancamentos_externos`) => DROP + CREATE + GRANT.
DROP FUNCTION IF EXISTS hub_adiantamento_repasse_motorista();

CREATE FUNCTION hub_adiantamento_repasse_motorista()
RETURNS TABLE (
    visivel       boolean,
    periodo_inicio date,
    periodo_fim   date,
    data_repasse  date,
    situacao      text,
    creditos      numeric(12,2),
    debitos       numeric(12,2),
    remanescente  numeric(12,2),
    negativo      boolean,
    adiantamentos jsonb,
    saldo_anterior   numeric(12,2),
    abaixo_do_minimo boolean,
    lancamentos_externos numeric(12,2)
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_cnpj        text := hub_jwt_motorista_cnpj();
    v_conta_motorista_id int;
    v_entregador  RECORD;
    v_config      "AdiantamentoConfiguracao";
    v_hoje        date;
    v_inicio      date;
    v_fim         date;
    v_creditos    numeric(12,2) := 0;
    v_debitos     numeric(12,2) := 0;
    v_desconto    numeric(12,2) := 0;
    v_externo_deducao numeric(12,2) := 0;
    v_externo_credito numeric(12,2) := 0;
    v_adiant      jsonb := '[]'::jsonb;
    v_fechada     boolean;
    v_saldo_anterior numeric(12,2);
    v_remanescente   numeric(12,2);
    v_total          numeric(12,2);
BEGIN
    IF v_cnpj IS NULL THEN RETURN; END IF;
    SELECT cm.id INTO v_conta_motorista_id FROM "ContaMotorista" cm WHERE cm.cnpj_prestador = v_cnpj;
    IF v_conta_motorista_id IS NULL THEN RETURN; END IF;
    SELECT e.* INTO v_entregador FROM "Entregador" e WHERE e.motorista_id = v_conta_motorista_id;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(v_entregador.id_empresa);
    IF v_config.id IS NULL OR NOT v_config.repasse_visivel_app OR v_config.apuracao_dia_inicio IS NULL THEN
        RETURN QUERY SELECT false, NULL::date, NULL::date, NULL::date, NULL::text,
            NULL::numeric(12,2), NULL::numeric(12,2), NULL::numeric(12,2), NULL::boolean, NULL::jsonb,
            NULL::numeric(12,2), NULL::boolean, NULL::numeric(12,2);
        RETURN;
    END IF;

    -- "Hoje" é o dia em São Paulo (v_config.timezone), nunca `current_date`.
    v_hoje := (now() AT TIME ZONE v_config.timezone)::date;
    v_inicio := v_hoje - ((extract(dow FROM v_hoje)::int - v_config.apuracao_dia_inicio + 7) % 7);
    v_fim := v_inicio + 6;

    SELECT COALESCE(sum(f.valor), 0) INTO v_creditos
    FROM "FaturamentoLancamento" f
    WHERE f.entregador_id = v_entregador.id AND f.tipo = 'Credito'
      AND hub_adiantamento_categoria_casa(f.descricao, COALESCE(v_config.categorias_extrato, ARRAY[]::text[]))
      AND (
          (v_config.apuracao_data_base = 'data_lancamento' AND f.data_lancamento BETWEEN v_inicio AND v_fim)
          OR (v_config.apuracao_data_base = 'data_referencia' AND f.data_referencia BETWEEN v_inicio AND v_fim)
      );

    IF v_config.desconto_debitos THEN
        SELECT COALESCE(sum(abs(f.valor)), 0) INTO v_debitos
        FROM "FaturamentoLancamento" f
        WHERE f.entregador_id = v_entregador.id AND f.tipo = 'Debito'
          AND (
              (v_config.apuracao_data_base = 'data_lancamento' AND f.data_lancamento BETWEEN v_inicio AND v_fim)
              OR (v_config.apuracao_data_base = 'data_referencia' AND f.data_referencia BETWEEN v_inicio AND v_fim)
          );
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', s.id, 'dataProducao', s.data_producao, 'valorBruto', s.valor_bruto,
        'emProcessamento', s.status = 'EXPORTADA'
    ) ORDER BY s.data_producao), '[]'::jsonb) INTO v_adiant
    FROM "AdiantamentoSolicitacao" s
    WHERE s.entregador_id = v_entregador.id AND s.status IN ('PAGA', 'EXPORTADA')
      AND s.data_producao BETWEEN v_inicio AND v_fim;

    IF v_config.desconto_adiantamentos THEN
        SELECT COALESCE(sum(s.valor_bruto), 0) INTO v_desconto
        FROM "AdiantamentoSolicitacao" s
        WHERE s.entregador_id = v_entregador.id AND s.status IN ('PAGA', 'EXPORTADA')
          AND s.data_producao BETWEEN v_inicio AND v_fim;
    END IF;

    -- 0117 (FR-016/FR-017/FR-022): lançamentos pagos por fora da SEMANA EM CURSO. Mesma tabela,
    -- mesma janela e mesmo gate que prévia e fechamento — três pontos, uma regra.
    SELECT COALESCE(sum(l.valor) FILTER (WHERE t.sinal < 0), 0), COALESCE(sum(l.valor) FILTER (WHERE t.sinal > 0), 0)
      INTO v_externo_deducao, v_externo_credito
    FROM "LancamentoExterno" l
    JOIN "LancamentoExternoTipo" t ON t.codigo = l.tipo
    WHERE l.entregador_id = v_entregador.id
      AND l.data_pagamento BETWEEN v_inicio AND v_fim;
    IF NOT v_config.desconto_adiantamentos THEN v_externo_deducao := 0; END IF;

    SELECT EXISTS (
        SELECT 1 FROM "ApuracaoRepasse" ar
        WHERE ar.id_empresa = v_entregador.id_empresa AND ar.periodo_inicio = v_inicio
    ) INTO v_fechada;

    -- F3/Decision 10: saldo transportado da semana fechada imediatamente
    -- anterior. Sem apuração anterior (ou pré-0098) => 0.
    SELECT i.valor_transportado INTO v_saldo_anterior
    FROM "ApuracaoRepasseItem" i
    JOIN "ApuracaoRepasse" a ON a.id = i.apuracao_id
    WHERE i.entregador_id = v_entregador.id AND a.id_empresa = v_entregador.id_empresa
      AND a.periodo_inicio = v_inicio - 7;
    v_saldo_anterior := COALESCE(v_saldo_anterior, 0);

    v_remanescente := (v_creditos - v_desconto - v_debitos - v_externo_deducao + v_externo_credito);
    v_total := v_remanescente + v_saldo_anterior;

    RETURN QUERY SELECT true, v_inicio, v_fim, v_fim + v_config.apuracao_dias_ate_repasse,
        (CASE WHEN v_fechada THEN 'FECHADA' ELSE 'EM_APURACAO' END)::text,
        v_creditos, v_debitos, v_remanescente, (v_remanescente < 0), v_adiant,
        v_saldo_anterior,
        (v_remanescente >= 0 AND v_total > 0 AND v_total < v_config.repasse_valor_minimo),
        (v_externo_credito - v_externo_deducao);
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_repasse_motorista() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse_motorista() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 8.4 hub_adiantamento_repasse_congelado — semana FECHADA no hub (corpo = 0100:172-232)
-- ─────────────────────────────────────────────────────────────────────────
-- Lê o CONGELADO: acrescenta só `i.lancamentos_externos` (já gravado pelo fechamento) e o total.
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
    lancamentos_externos numeric, total_lancamentos_externos numeric
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
               i.lancamentos_externos
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
           f.lancamentos_externos, sum(f.lancamentos_externos) OVER ()
    FROM filtradas f
    ORDER BY f.nome
    OFFSET p_offset LIMIT p_limite;
END;
$$;

REVOKE ALL ON FUNCTION hub_adiantamento_repasse_congelado(date, text, boolean, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_repasse_congelado(date, text, boolean, int, int) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────
-- 8.5 hub_adiantamento_repasse_motorista_ultimo_fechado — última semana FECHADA no APP (0098:639-681)
-- ─────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS hub_adiantamento_repasse_motorista_ultimo_fechado();

CREATE FUNCTION hub_adiantamento_repasse_motorista_ultimo_fechado()
RETURNS TABLE (
    periodo_inicio date, periodo_fim date, data_repasse date, fechado_em timestamptz,
    creditos numeric(12,2), adiantamentos numeric(12,2), debitos numeric(12,2),
    remanescente numeric(12,2), negativo boolean,
    saldo_anterior numeric(12,2), valor_pago numeric(12,2), valor_transportado numeric(12,2), retido boolean,
    lancamentos_externos numeric(12,2)
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
    IF v_cnpj IS NULL THEN RETURN; END IF;
    SELECT cm.id INTO v_conta_motorista_id FROM "ContaMotorista" cm WHERE cm.cnpj_prestador = v_cnpj;
    IF v_conta_motorista_id IS NULL THEN RETURN; END IF;
    SELECT e.* INTO v_entregador FROM "Entregador" e WHERE e.motorista_id = v_conta_motorista_id;
    IF NOT FOUND THEN RETURN; END IF;

    SELECT * INTO v_config FROM hub_adiantamento_config_vigente(v_entregador.id_empresa);
    IF v_config.id IS NULL OR NOT v_config.repasse_visivel_app THEN RETURN; END IF;

    RETURN QUERY
    SELECT a.periodo_inicio, a.periodo_fim, a.data_repasse, a.fechado_em,
           i.creditos, i.adiantamentos, i.debitos, i.remanescente,
           i.remanescente < 0,
           i.saldo_anterior, i.valor_pago, i.valor_transportado,
           (i.remanescente >= 0 AND i.valor_pago = 0 AND i.valor_transportado > 0),
           i.lancamentos_externos
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


-- ═════════════════════════════════════════════════════════════════
-- 9. Lote do repasse: crédito externo NÃO exige nota (H1, rodada 2 — decisão do operador 2026-10-23)
-- ═════════════════════════════════════════════════════════════════
-- ⚠️ INVERTE UMA INVARIANTE: até aqui valia faturado >= pago (todo valor a pagar vinha de produção, e
-- produção gera `EnvioMassa`). Um `AJUSTE_CREDITO` para motorista SEM produção na semana dá
-- remanescente = valor_pago = crédito, sem movimento nenhum: "Gerar notas" recusa `VALOR_ZERO` e o
-- lote devolvia `NOTA_PENDENTE`/`apta=false` PARA SEMPRE ("aguarde o motorista enviar a nota"),
-- que o motorista não tem como satisfazer.
--
-- Mudança MÍNIMA sobre a versão viva (0112): o item entra no SELECT com `creditos` e `lancamentos_externos`,
-- e o `NOTA_PENDENTE` por `total = 0` deixa de valer quando `creditos = 0 AND lancamentos_externos > 0`.
--   - crédito PURO (sem produção)  -> apta (se tiver conta), paga o crédito, sem EnvioMassa;
--   - semana MISTA (produção + crédito) -> continua exigindo a nota DA PRODUÇÃO (aprovadas = total);
--     o lote paga `valor_pago` inteiro (produção + crédito);
--   - ADIANTAMENTO (dedução) -> NÃO muda: a nota é da produção e o pagamento é líquido.
-- Assinatura e tipo de retorno iguais => CREATE OR REPLACE preserva os GRANT.
-- ROLLBACK: reaplicar a função da 0112 (o `hub-lancamento-externo-rollback.sh` prova).

CREATE OR REPLACE FUNCTION hub_repasse_lote_avaliar(p_apuracoes bigint[], p_entregadores int[])
RETURNS TABLE (
    apuracao_id bigint, entregador_id int, entregador_nome text,
    periodo_inicio date, periodo_fim date, id_empresa int,
    valor_pago numeric, conta_bancaria_id bigint, apta boolean, motivo_pendencia text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH base AS (
        SELECT i.apuracao_id, i.entregador_id, ent.nome AS entregador_nome,
               ar.periodo_inicio, ar.periodo_fim, ar.fechado_em, i.id_empresa,
               i.valor_pago, i.creditos, i.lancamentos_externos, cb.id AS conta_id,
               mov.total, mov.aprovadas, mov.reprovadas, mov.conciliadas,
               EXISTS (SELECT 1 FROM "RepasseLoteItem" li
                       WHERE li.apuracao_id = i.apuracao_id AND li.entregador_id = i.entregador_id
                         AND li.situacao IN ('incluido', 'pago')) AS em_lote
        FROM "ApuracaoRepasseItem" i
        JOIN "ApuracaoRepasse" ar ON ar.id = i.apuracao_id
        JOIN "Entregador" ent ON ent.id = i.entregador_id
        LEFT JOIN "ContaBancariaMotorista" cb
               ON cb.entregador_id = i.entregador_id AND cb.status = 'APROVADA'
        LEFT JOIN LATERAL (
            -- conjunto UNIDO, distinto por id de EnvioMassa (UNION deduplica: o
            -- mesmo movimento nos dois caminhos conta UMA vez). A linha da
            -- trilha entra mesmo sem EnvioMassa (excluída pelo legado): o LEFT
            -- JOIN abaixo a mantém no total e fora das aprovadas = NOTA_PENDENTE.
            SELECT count(u.eid) AS total,
                   count(em.id) FILTER (WHERE NULLIF(btrim(em.nota_ok, E' \t\r\n'), '') IS NOT NULL
                                          AND NULLIF(btrim(em.erro_validacao, E' \t\r\n'), '') IS NULL) AS aprovadas,
                   count(em.id) FILTER (WHERE NULLIF(btrim(em.erro_validacao, E' \t\r\n'), '') IS NOT NULL) AS reprovadas,
                   count(em.id) FILTER (WHERE em.conciliada_em IS NOT NULL) AS conciliadas
            FROM (
                -- (a) hub: trilha de "Gerar notas da semana"
                SELECT m.envio_massa_id AS eid
                FROM "ApuracaoRepasseMovimento" m
                WHERE m.apuracao_id = i.apuracao_id AND m.entregador_id = i.entregador_id
                UNION
                -- (b) planilha: CNPJ do entregador + período da apuração, SEMPRE
                -- no escopo (a RLS da EnvioMassa é USING (true): não filtra nada).
                -- Período = dia de dt_inicial/dt_final == periodo_inicio/fim,
                -- escrito como faixa para usar o índice (mesmo resultado de ::date).
                SELECT em2.id
                FROM "ContaMotorista" cm
                JOIN "EnvioMassa" em2 ON em2.cnpj_prestador = cm.cnpj_prestador
                WHERE cm.id = ent.motorista_id
                  AND em2.id_empresa = ANY (hub_jwt_escopo_ids())
                  AND em2.dt_inicial >= ar.periodo_inicio AND em2.dt_inicial < ar.periodo_inicio + 1
                  AND em2.dt_final   >= ar.periodo_fim    AND em2.dt_final   < ar.periodo_fim + 1
            ) u
            LEFT JOIN "EnvioMassa" em ON em.id = u.eid
        ) mov ON true
        WHERE i.id_empresa = ANY (hub_jwt_escopo_ids())
          AND (
              (p_apuracoes IS NULL AND i.valor_pago > 0)
              OR EXISTS (SELECT 1 FROM unnest(p_apuracoes, p_entregadores) AS par(a, e)
                         WHERE par.a = i.apuracao_id AND par.e = i.entregador_id)
          )
    ), motivo AS (
        SELECT b.*,
            CASE
                WHEN b.em_lote THEN 'JA_EM_LOTE'
                WHEN b.conciliadas > 0 THEN 'JA_PAGO_CONCILIADO'
                WHEN b.fechado_em IS NULL THEN 'APURACAO_ABERTA'
                WHEN b.valor_pago IS NULL OR b.valor_pago <= 0 THEN 'VALOR_INVALIDO'
                WHEN b.reprovadas > 0 THEN 'NOTA_REPROVADA'
                -- H1: sem movimento (total = 0) a nota é pendente, EXCETO para crédito externo puro
                -- (nenhuma produção no item e `lancamentos_externos > 0`): não há nota a emitir.
                -- ALTO 1 (rodada 3): a dispensa vale SÓ para o próprio crédito. `valor_pago = remanescente +
                -- saldo_anterior`: sem o último termo, R$ 0,01 de crédito destravava qualquer saldo retido de
                -- PRODUÇÃO sem nota (W1 produz R$ 5,00 sem nota e fica retido; W2 recebe um crédito de R$ 0,01 e
                -- pagava R$ 5,01). `valor_pago <= lancamentos_externos` <=> nada além do crédito está sendo pago.
                -- Escolhida em vez de `saldo_anterior = 0` por não depender de ler outra coluna do item e por
                -- continuar certa se o piso mudar; e NÃO por `saldo_anterior_nota`, que é NULL/0 quando
                -- `categorias_nota` não está configurada (a dispensa abriria exatamente no caso sem classificação).
                -- Efeito colateral aceito: crédito + saldo transportado numa semana SEM produção volta a
                -- NOTA_PENDENTE, igual a um saldo transportado sozinho já é hoje (0112) — não é regressão.
                WHEN b.aprovadas < b.total
                     OR (b.total = 0 AND NOT (b.creditos = 0 AND b.lancamentos_externos > 0
                                              AND b.valor_pago <= b.lancamentos_externos)) THEN 'NOTA_PENDENTE'
                WHEN b.conta_id IS NULL THEN 'SEM_CONTA'
                ELSE NULL
            END AS m
        FROM base b
    )
    SELECT apuracao_id, entregador_id, entregador_nome, periodo_inicio, periodo_fim, id_empresa,
           valor_pago, conta_id, (m IS NULL), m
    FROM motivo
    -- modo "listar": quem já está em lote ativo não é candidato, é histórico
    WHERE NOT (p_apuracoes IS NULL AND em_lote)
$$;

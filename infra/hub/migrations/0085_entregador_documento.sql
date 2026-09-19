-- =============================================================================
-- 0085 — CPF do entregador em campo próprio, para fechar a metade descoberta do
-- alerta `DOCUMENTO_DIFERENTE` (0084).
--
-- POR QUÊ: a 0084 só consegue conferir conta de titular PJ, porque o hub tinha
-- apenas o CNPJ do prestador (`ContaMotorista.cnpj_prestador`). Medido no
-- retorno real do parceiro (2026-09-18): de 3.843 pagamentos, **2.008 foram
-- para conta PF** e 1.835 para PJ — ou seja, a maioria caía justamente no caso
-- sem verificação. Decisão do operador em 2026-09-18.
--
-- POR QUE TABELA SEPARADA, e não uma coluna em "Entregador":
--   `GRANT SELECT, INSERT, UPDATE ON "Entregador" TO authenticated` (0010:31) é
--   de TABELA INTEIRA. Uma coluna `cpf` ali seria (a) legível por qualquer
--   usuário autenticado dentro do escopo — inclusive por filtro no PostgREST,
--   exatamente o oráculo cego que a revisão de segurança achou em `de`/`ate` e
--   que a 0083 corrigiu — e (b) ESCRITA por ele, o que permitiria alterar o CPF
--   para casar com a conta e anular a própria conferência.
--   Esta tabela segue o padrão que o módulo já usa para o dado mais sensível
--   ("ContaBancariaMotorista", 0066:354/402): RLS habilitada, NENHUMA política,
--   NENHUM GRANT. Nega tudo por padrão; só função SECURITY DEFINER alcança.
--
-- O CPF NUNCA sai por API. Ele existe para ser COMPARADO dentro do banco; não
-- há função de leitura que o devolva, nem mascarado. Quem precisa ver dado
-- pessoal do entregador continua usando o caminho de sempre
-- (`dados_entrego_json`, atrás de permissão de dado sensível).
-- =============================================================================

CREATE TABLE IF NOT EXISTS "EntregadorDocumento" (
    entregador_id int PRIMARY KEY REFERENCES "Entregador"(id) ON DELETE CASCADE,
    id_empresa    int NOT NULL,
    cpf           text NOT NULL,
    origem        text NOT NULL,
    criado_em     timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT entregadordocumento_cpf_chk CHECK (cpf ~ '^[0-9]{11}$'),
    CONSTRAINT entregadordocumento_origem_chk CHECK (origem IN ('CARGA_INICIAL', 'ENRIQUECIMENTO'))
);

ALTER TABLE "EntregadorDocumento" ENABLE ROW LEVEL SECURITY;
-- Sem POLICY e sem GRANT, deliberadamente: RLS com zero políticas nega tudo,
-- inclusive para `authenticated`. Só as funções SECURITY DEFINER abaixo entram.

-- --- gravação ----------------------------------------------------------------
-- Idempotente por entregador. `CARGA_INICIAL` tem precedência sobre
-- `ENRIQUECIMENTO`: a planilha é conferida pelo operador, o enriquecimento vem
-- de portal de terceiro. Sem isso, uma re-execução do robô poderia sobrescrever
-- o dado conferido pelo humano com o dado do portal.
CREATE OR REPLACE FUNCTION hub_entregador_documento_gravar(
    p_entregador_id int, p_cpf text, p_origem text
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_cpf      text := regexp_replace(COALESCE(p_cpf, ''), '\D', '', 'g');
    v_empresa  int;
    v_origem_atual text;
BEGIN
    -- Dois chamadores legítimos, cada um com sua credencial: o worker da carga
    -- inicial (mesma claim de `hub_conta_bancaria_carga_inicial`, 0072:58) e o
    -- usuário que revisa contas. Nenhum outro entra.
    IF NOT (hub_jwt_carga_inicial_worker()
            OR hub_adiantamento_tem_permissao('adiantamentos.contas_revisar')) THEN
        RAISE EXCEPTION 'PERMISSAO_NEGADA';
    END IF;
    IF v_cpf !~ '^[0-9]{11}$' THEN
        RETURN false;  -- entrada sem CPF utilizável: silenciosamente ignorada
    END IF;
    IF p_origem NOT IN ('CARGA_INICIAL', 'ENRIQUECIMENTO') THEN
        RAISE EXCEPTION 'DADOS_INVALIDOS';
    END IF;

    -- O worker da carga não tem escopo na claim (é booleana, hub-postgrest-jwt.js:119)
    -- e a RPC irmã `hub_conta_bancaria_carga_inicial` (0072) também resolve a
    -- empresa a partir do próprio Entregador. Usuário humano, ao contrário,
    -- fica restrito ao escopo dele.
    IF hub_jwt_carga_inicial_worker() THEN
        SELECT e.id_empresa INTO v_empresa FROM "Entregador" e WHERE e.id = p_entregador_id;
    ELSE
        SELECT e.id_empresa INTO v_empresa FROM "Entregador" e
        WHERE e.id = p_entregador_id AND e.id_empresa = ANY (hub_jwt_escopo_ids());
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;

    SELECT origem INTO v_origem_atual FROM "EntregadorDocumento" WHERE entregador_id = p_entregador_id;
    IF v_origem_atual = 'CARGA_INICIAL' AND p_origem = 'ENRIQUECIMENTO' THEN
        RETURN false;  -- não rebaixa a fonte conferida pelo operador
    END IF;

    INSERT INTO "EntregadorDocumento" (entregador_id, id_empresa, cpf, origem)
    VALUES (p_entregador_id, v_empresa, v_cpf, p_origem)
    ON CONFLICT (entregador_id) DO UPDATE
      SET cpf = EXCLUDED.cpf, origem = EXCLUDED.origem, atualizado_em = now();
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION hub_entregador_documento_gravar(int, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_entregador_documento_gravar(int, text, text) TO authenticated;

-- --- carga a partir do que o enriquecimento JÁ guardou -----------------------
-- QUANDO USAR ESTA, E NÃO O GATILHO: o gatilho mais abaixo cobre o fluxo daqui
-- para frente (todo enriquecimento novo alimenta sozinho). Esta função existe
-- para o ESTOQUE — os entregadores já enriquecidos ANTES de a 0085 existir,
-- cujo `dados_entrego_json` não vai ser reescrito tão cedo. Roda UMA vez, na
-- janela do deploy, por um usuário com `adiantamentos.contas_revisar`:
--     SELECT hub_entregador_documento_carregar_do_enriquecimento();
-- Devolve quantos gravou. É idempotente: rodar de novo não duplica nem
-- sobrescreve (ON CONFLICT DO NOTHING).
-- `Entregador.dados_entrego_json -> 'dadosPessoais' ->> 'cpf'` (0057:28) é
-- gravado pelo robô da EntreGô (infra/robo-entrego/src/busca-pessoa-entrego.js).
-- Idempotente: só insere o que ainda não existe, nunca rebaixa CARGA_INICIAL.
CREATE OR REPLACE FUNCTION hub_entregador_documento_carregar_do_enriquecimento()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_qtd int := 0;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.contas_revisar') THEN
        RAISE EXCEPTION 'PERMISSAO_NEGADA';
    END IF;

    WITH candidatos AS (
        SELECT e.id, e.id_empresa,
               regexp_replace(COALESCE(e.dados_entrego_json -> 'dadosPessoais' ->> 'cpf', ''), '\D', '', 'g') AS cpf
        FROM "Entregador" e
        WHERE e.id_empresa = ANY (hub_jwt_escopo_ids())
          AND e.dados_entrego_json IS NOT NULL
    ), validos AS (
        SELECT * FROM candidatos WHERE cpf ~ '^[0-9]{11}$'
    ), gravados AS (
        INSERT INTO "EntregadorDocumento" (entregador_id, id_empresa, cpf, origem)
        SELECT v.id, v.id_empresa, v.cpf, 'ENRIQUECIMENTO' FROM validos v
        ON CONFLICT (entregador_id) DO NOTHING
        RETURNING 1
    )
    SELECT count(*) INTO v_qtd FROM gravados;
    RETURN v_qtd;
END;
$$;

REVOKE ALL ON FUNCTION hub_entregador_documento_carregar_do_enriquecimento() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_entregador_documento_carregar_do_enriquecimento() TO authenticated;

-- --- alimentação automática a cada enriquecimento -----------------------------
-- O robô grava `dados_entrego_json` por PATCH DIRETO na tabela "Entregador"
-- (routes/hub-robo-entrego.js:249), não por RPC — então gatilho é o único ponto
-- que pega TODO caminho de escrita, inclusive os futuros, sem depender de
-- ninguém lembrar de chamar função nenhuma. `SECURITY DEFINER` é obrigatório:
-- quem faz o PATCH é `authenticated`, que não tem direito algum nesta tabela.
CREATE OR REPLACE FUNCTION hub_entregador_documento_do_enriquecimento()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_cpf text;
BEGIN
    v_cpf := regexp_replace(
        COALESCE(NEW.dados_entrego_json -> 'dadosPessoais' ->> 'cpf', ''), '\D', '', 'g');

    IF v_cpf ~ '^[0-9]{11}$' THEN
        INSERT INTO "EntregadorDocumento" (entregador_id, id_empresa, cpf, origem)
        VALUES (NEW.id, NEW.id_empresa, v_cpf, 'ENRIQUECIMENTO')
        ON CONFLICT (entregador_id) DO UPDATE
            SET cpf = EXCLUDED.cpf, atualizado_em = now()
            -- nunca rebaixa o dado conferido pelo operador na planilha
            WHERE "EntregadorDocumento".origem <> 'CARGA_INICIAL';
    END IF;
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    -- DELIBERADO: o trabalho primário deste PATCH é registrar o enriquecimento
    -- do motorista. O CPF é subproduto. Falhar o PATCH por causa dele quebraria
    -- o robô (que roda sozinho de hora em hora) para ganhar um campo auxiliar —
    -- troca ruim. A ausência aparece como cobertura menor do alerta, nunca como
    -- import quebrado.
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS entregador_documento_enriquecimento ON "Entregador";
CREATE TRIGGER entregador_documento_enriquecimento
AFTER INSERT OR UPDATE OF dados_entrego_json ON "Entregador"
FOR EACH ROW
WHEN (NEW.dados_entrego_json IS NOT NULL)
EXECUTE FUNCTION hub_entregador_documento_do_enriquecimento();

-- --- o alerta passa a cobrir também o titular PF ------------------------------
-- Mesma assinatura de 0084, então CREATE OR REPLACE mantém os GRANTs.
CREATE OR REPLACE FUNCTION hub_conta_bancaria_solicitar(p_dados jsonb)
RETURNS TABLE (id bigint, status text, id_empresa int)
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
    v_doc_titular text;
    v_cpf_entregador text;
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

    v_doc_titular := regexp_replace(COALESCE(p_dados ->> 'titularDocumento', ''), '\D', '', 'g');

    IF v_titular_tipo = 'PJ' THEN
        -- 0084: titular PJ confere contra o CNPJ do prestador.
        IF v_doc_titular <> regexp_replace(COALESCE(v_cnpj, ''), '\D', '', 'g') THEN
            v_alertas := v_alertas || jsonb_build_array('DOCUMENTO_DIFERENTE');
        END IF;
    ELSE
        -- 0085: titular PF confere contra o CPF do entregador, QUANDO conhecido.
        -- Sem CPF cadastrado não há alerta — é a mesma ausência de sinal de
        -- antes da 0085, nunca um falso positivo que inundaria a fila de
        -- revisão e tiraria conta legítima da aprovação em massa.
        SELECT cpf INTO v_cpf_entregador FROM "EntregadorDocumento"
        WHERE entregador_id = v_entregador.id;
        IF v_cpf_entregador IS NOT NULL AND v_doc_titular <> v_cpf_entregador THEN
            v_alertas := v_alertas || jsonb_build_array('DOCUMENTO_DIFERENTE');
        END IF;
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

    RETURN QUERY SELECT v_novo_id, 'PENDENTE'::text, v_entregador.id_empresa;
END;
$$;

-- =============================================================================
-- 0084 — Revisão de segurança independente (2026-09-18), pós-merge do PR #182.
--
-- (a) `hub_conta_bancaria_solicitar` alertava divergência só do NOME do
--     titular (`TITULAR_DIFERENTE`, 0074:352). O DOCUMENTO nunca era comparado
--     com o do próprio motorista, embora `v_cnpj` já esteja à mão. Uma conta
--     cadastrada pelo app com o nome do motorista e o documento de um terceiro
--     nascia com a lista de alertas VAZIA — e conta sem alerta é exatamente o
--     que o fluxo de revisão trata como "limpa".
--
--     LIMITE REAL, deliberado e documentado: o hub **não guarda o CPF** do
--     motorista. `ContaMotorista` tem `cnpj_prestador`, `nome` e `ativo`
--     (CLAUDE.md §"Regras de domínio"), e `Entregador` não tem documento
--     nenhum. Logo:
--       - titular PJ (14 dígitos): dá para conferir. Se o CNPJ do titular não
--         é o CNPJ do prestador, é divergência objetiva -> alerta.
--       - titular PF (11 dígitos): NÃO dá para conferir, porque não existe
--         CPF do motorista no banco para comparar. Alertar em toda conta PF
--         transformaria o alerta em ruído (e, como `hub_conta_bancaria_aprovar_lote`
--         recusa qualquer conta com alerta, tiraria TODA conta PF da aprovação
--         em massa da carga inicial, que é justamente o caso de uso dela).
--         Fica coberto pelo `TITULAR_DIFERENTE` quando o NOME também diverge;
--         o caso "nome do motorista + CPF de terceiro" segue sem sinal
--         automático — registrado como pendência de produto, porque a solução
--         exige passar a guardar o CPF do motorista, o que é decisão de dado
--         pessoal e não cabe a uma migration decidir.
--
-- (b) `hub_adiantamento_tem_permissao` (0067:401) e `hub_jwt_motorista_id_empresa`
--     (0069:43) eram as duas únicas SECURITY DEFINER do módulo sem o par
--     REVOKE/GRANT que as outras 20+ têm. Sem cenário de exploração conhecido
--     (as duas só derivam informação da claim de quem chama), mas o próprio
--     0068:417-423 registra por escrito por que a convenção existe: sem REVOKE,
--     o default do Postgres é EXECUTE para PUBLIC.
-- =============================================================================

-- --- (a) alerta DOCUMENTO_DIFERENTE ------------------------------------------
-- Mesma assinatura de 0074 (RETURNS TABLE inalterado), então CREATE OR REPLACE
-- basta e os GRANTs de 0074:386-387 sobrevivem. Corpo idêntico ao de 0074
-- exceto pelo bloco de alerta novo, marcado abaixo.
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

    -- 0084 (a): divergência de DOCUMENTO, só no caso verificável (titular PJ).
    -- `regexp_replace` garante a comparação por dígitos, independente de o
    -- cliente mandar com ou sem pontuação (lib/adiantamento-conta.js já
    -- normaliza na entrada, mas a RPC não pode depender disso).
    v_doc_titular := regexp_replace(COALESCE(p_dados ->> 'titularDocumento', ''), '\D', '', 'g');
    IF v_titular_tipo = 'PJ'
       AND v_doc_titular <> regexp_replace(COALESCE(v_cnpj, ''), '\D', '', 'g') THEN
        v_alertas := v_alertas || jsonb_build_array('DOCUMENTO_DIFERENTE');
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

-- --- (b) convenção REVOKE/GRANT nas duas que faltavam -------------------------
REVOKE ALL ON FUNCTION hub_adiantamento_tem_permissao(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_adiantamento_tem_permissao(text) TO authenticated;

REVOKE ALL ON FUNCTION hub_jwt_motorista_id_empresa() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_jwt_motorista_id_empresa() TO authenticated;

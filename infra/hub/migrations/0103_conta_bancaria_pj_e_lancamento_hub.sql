-- 0103 — conta bancária: só CORRENTE, e o hub passa a poder lançar a conta.
--
-- Regra de negócio (decidida pelo operador em 2026-10-05):
--   1. o motorista só cadastra conta CNPJ pelo app, e nunca poupança;
--   2. se ele precisar de conta PESSOA FÍSICA, pede ao operador, que lança pelo
--      hub — é a única porta para PF a partir de agora;
--   3. poupança não entra por porta nenhuma.
--
-- O que muda aqui:
--   a) `origem` passa a aceitar 'HUB' (hoje só 'APP' e 'CARGA_INICIAL');
--   b) CHECK que impede POUPANCA em linhas NOVAS — `NOT VALID` de propósito:
--      existem 3 contas poupança gravadas (2 PENDENTE, 1 CANCELADA, medido em
--      05/10) e validar o histórico faria a migration falhar. O operador decidiu
--      deixar o que já existe como está;
--   c) `hub_conta_bancaria_lancar` — o operador cadastra/corrige a conta de um
--      entregador, inclusive PF.
--
-- O que NÃO muda, de propósito: as 24 contas PF já existentes (20 PENDENTE +
-- 2 APROVADA + 2 CANCELADA) seguem como estão. A regra nova vale para o que
-- chegar de agora em diante.

-- (a) --------------------------------------------------------------------
ALTER TABLE "ContaBancariaMotorista" DROP CONSTRAINT IF EXISTS contabancariamotorista_origem_chk;
ALTER TABLE "ContaBancariaMotorista"
  ADD CONSTRAINT contabancariamotorista_origem_chk
  CHECK (origem = ANY (ARRAY['APP'::text, 'CARGA_INICIAL'::text, 'HUB'::text]));

-- (b) --------------------------------------------------------------------
ALTER TABLE "ContaBancariaMotorista" DROP CONSTRAINT IF EXISTS contabancariamotorista_sem_poupanca_chk;
ALTER TABLE "ContaBancariaMotorista"
  ADD CONSTRAINT contabancariamotorista_sem_poupanca_chk
  CHECK (tipo_conta = 'CORRENTE') NOT VALID;

-- (c) --------------------------------------------------------------------
-- Lançamento pelo hub. Mesma forma das irmãs `hub_conta_bancaria_aprovar` /
-- `_rejeitar`: permissão `adiantamentos.contas_revisar` (quem já decide sobre
-- conta), escopo por `hub_jwt_escopo_ids`, trava a linha, substitui a anterior.
--
-- Nasce APROVADA: quem lança é exatamente quem aprovaria, e um passo de
-- "aprovar o que eu mesmo acabei de digitar" só adiciona clique. `revisada_por`
-- e `revisada_em` ficam carimbados, então a trilha não se perde.
--
-- DV de CPF/CNPJ continua sendo responsabilidade do backend
-- (`lib/adiantamento-conta.js`) — uma fonte só do algoritmo, como já era na
-- `hub_conta_bancaria_solicitar`.
CREATE OR REPLACE FUNCTION hub_conta_bancaria_lancar(p_dados jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_sub          int := NULLIF(hub_jwt_claims() ->> 'sub', '')::int;
    v_entregador   "Entregador";
    v_novo_id      bigint;
    v_titular_tipo text;
    v_documento    text := p_dados ->> 'titularDocumento';
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.contas_revisar') THEN
        RAISE EXCEPTION 'PERMISSAO_NEGADA';
    END IF;

    SELECT * INTO v_entregador FROM "Entregador"
     WHERE id = (p_dados ->> 'entregadorId')::int
       AND id_empresa = ANY (hub_jwt_escopo_ids())
     FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NAO_ENCONTRADA'; END IF;

    -- Poupança não entra por porta nenhuma — nem por esta, que é a das exceções.
    IF (p_dados ->> 'tipoConta') <> 'CORRENTE' THEN RAISE EXCEPTION 'POUPANCA_NAO_PERMITIDA'; END IF;

    v_titular_tipo := CASE WHEN char_length(v_documento) = 14 THEN 'PJ' ELSE 'PF' END;

    -- Mesma ordem da aprovação: cancela o que estava pendente, aposenta a
    -- aprovada, insere a nova já aprovada.
    UPDATE "ContaBancariaMotorista" SET status = 'CANCELADA', revisada_em = now(), revisada_por = v_sub
     WHERE entregador_id = v_entregador.id AND status = 'PENDENTE';
    UPDATE "ContaBancariaMotorista" SET status = 'SUBSTITUIDA', revisada_em = now(), revisada_por = v_sub
     WHERE entregador_id = v_entregador.id AND status = 'APROVADA';

    INSERT INTO "ContaBancariaMotorista" (
        id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo,
        banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta,
        chave_pix_tipo, chave_pix, email_comprovante, alertas,
        entregador_confirmado_id, revisada_em, revisada_por
    ) VALUES (
        v_entregador.id_empresa, v_entregador.id, 'HUB', 'APROVADA',
        btrim(p_dados ->> 'titularNome'), v_documento, v_titular_tipo,
        p_dados ->> 'bancoCodigo', p_dados ->> 'bancoNome', p_dados ->> 'agencia',
        p_dados ->> 'conta', p_dados ->> 'contaDigito', p_dados ->> 'tipoConta',
        NULLIF(p_dados ->> 'chavePixTipo', ''), NULLIF(p_dados ->> 'chavePix', ''),
        NULLIF(p_dados ->> 'emailComprovante', ''), '[]'::jsonb,
        v_entregador.id, now(), v_sub
    ) RETURNING "ContaBancariaMotorista".id INTO v_novo_id;

    -- O motorista precisa saber que a conta dele mudou — ele não pediu esta.
    PERFORM hub_adiantamento_notificar(NULL, 'conta_aprovada', v_entregador.id);

    RETURN jsonb_build_object('id', v_novo_id, 'status', 'APROVADA', 'titularTipo', v_titular_tipo);
END;
$$;

REVOKE ALL ON FUNCTION hub_conta_bancaria_lancar(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_conta_bancaria_lancar(jsonb) TO authenticated;

-- (d) --------------------------------------------------------------------
-- Busca de entregador para o lançamento acima. Vive em adiantamentos (e não em
-- motoristas) de propósito: quem lança conta tem `adiantamentos.contas_revisar`
-- e não necessariamente `motoristas.listar`, que é de outro módulo.
--
-- O CNPJ volta MASCARADO — para escolher a pessoa certa bastam nome e os
-- últimos dígitos, e documento completo não precisa trafegar numa busca.
CREATE OR REPLACE FUNCTION hub_entregador_buscar(p_busca text)
RETURNS TABLE (
    id int,
    nome text,
    documento_mascarado text,
    tem_conta_aprovada boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_busca text := btrim(coalesce(p_busca, ''));
    v_digitos text := regexp_replace(coalesce(p_busca, ''), '\D', '', 'g');
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.contas_revisar') THEN
        RAISE EXCEPTION 'PERMISSAO_NEGADA';
    END IF;
    -- Menos de 3 caracteres devolveria quase a base inteira; a tela também
    -- segura, mas a regra tem de viver aqui (o cliente não é a trava).
    IF char_length(v_busca) < 3 THEN RETURN; END IF;

    RETURN QUERY
    SELECT e.id,
           e.nome,
           CASE WHEN cm.cnpj_prestador IS NULL THEN NULL
                ELSE '**.***.***/' || right(cm.cnpj_prestador, 6)
           END,
           EXISTS (SELECT 1 FROM "ContaBancariaMotorista" cb
                    WHERE cb.entregador_id = e.id AND cb.status = 'APROVADA')
      FROM "Entregador" e
      LEFT JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
     WHERE e.id_empresa = ANY (hub_jwt_escopo_ids())
       AND e.ativo
       AND (
            hub_normaliza_nome(e.nome) LIKE '%' || hub_normaliza_nome(v_busca) || '%'
            OR (char_length(v_digitos) >= 3 AND cm.cnpj_prestador LIKE '%' || v_digitos || '%')
           )
     ORDER BY e.nome
     LIMIT 20;
END;
$$;

REVOKE ALL ON FUNCTION hub_entregador_buscar(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_entregador_buscar(text) TO authenticated;

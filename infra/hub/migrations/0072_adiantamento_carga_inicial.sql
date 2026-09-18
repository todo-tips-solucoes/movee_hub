-- 0072 — RPC de carga inicial de contas bancárias (tasks.md FASE 8, 8.1.7 —
-- gap identificado onda-030 desta feature). "ContaBancariaMotorista" é
-- RLS-only, sem GRANT algum a `authenticated` (0066:23-25, dec-023): só
-- funções SECURITY DEFINER tocam a tabela. `hub_conta_bancaria_solicitar`
-- (0067:927) não serve à carga em massa — fixa `origem='APP'` e exige um
-- `motorista_cnpj` vinculado via "ContaMotorista"; o script de carga
-- (scripts/carga-contas-bancarias.js) casa pelo `Entregador.id_externo`
-- (UUID da planilha do operador), sem CNPJ do app disponível.
--
-- RPC nova, gated por claim interna booleana — mesmo padrão de
-- `hub_jwt_adiantamento_worker` (0067:54)/`hub_jwt_push_worker` (0061):
-- NUNCA a partir de dado de requisição, emitida só por
-- `scripts/carga-contas-bancarias.js` (lib/hub-postgrest-jwt.js,
-- claim `cargaInicialWorker`).
--
-- Idempotência (tasks.md 8.1.6): pré-checagem de conta já existente
-- (PENDENTE ou APROVADA) para o entregador + `ON CONFLICT` no índice
-- parcial `uniq_contabancariamotorista_pendente` (0066:165-166) como
-- defesa adicional — reexecutar a carga sobre o mesmo arquivo não duplica.
--
-- Verificado nesta onda (onda-030) rodando as 72 migrations em sequência
-- num container `postgres:13` efêmero (mesma versão do compose do hub),
-- descartado ao final — NÃO num stack hub-test-*/hub-homolog (fora do
-- orçamento da onda; nenhum compose subido, nenhum arquivo alheio tocado).
-- Confirmado: `authenticated` sem a claim -> PERMISSAO_NEGADA; entregador
-- inexistente -> ENTREGADOR_NAO_ENCONTRADO; 1ª chamada cria (criada=true),
-- 2ª chamada sobre o MESMO entregador não duplica (criada=false, 1 única
-- linha na tabela); `authenticated` continua SEM SELECT direto em
-- "ContaBancariaMotorista" (dec-023 intacto). Falta rodar
-- `infra/hub/scripts/migrate.sh` contra um stack hub-test-* de verdade
-- (FASE 10.2) antes da corrida real do operador — isso ainda não foi feito.

CREATE OR REPLACE FUNCTION hub_jwt_carga_inicial_worker()
RETURNS boolean
LANGUAGE sql STABLE
AS $$
    SELECT COALESCE((hub_jwt_claims() ->> 'hub_carga_inicial_worker')::boolean, false);
$$;

-- hub_conta_bancaria_carga_inicial — cria 1 conta PENDENTE/origem
-- CARGA_INICIAL para o entregador dado, sem aprovar automaticamente
-- (FR-048). `p_dados` já vem validado e normalizado pelo Node
-- (lib/adiantamento-conta.js: DV, COMPE, agência 4 dígitos, conta, dígito) —
-- esta função não reabre validação de formato, só a idempotência e a
-- permissão (mesmo raciocínio de `hub_conta_bancaria_solicitar`, que também
-- confia no formato já validado pelo caller).
CREATE OR REPLACE FUNCTION hub_conta_bancaria_carga_inicial(p_entregador_id int, p_dados jsonb)
RETURNS TABLE (id bigint, criada boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_entregador RECORD;
    v_existente  bigint;
    v_novo_id    bigint;
BEGIN
    IF NOT hub_jwt_carga_inicial_worker() THEN
        RAISE EXCEPTION 'PERMISSAO_NEGADA';
    END IF;

    SELECT e.* INTO v_entregador FROM "Entregador" e WHERE e.id = p_entregador_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ENTREGADOR_NAO_ENCONTRADO';
    END IF;

    SELECT c.id INTO v_existente FROM "ContaBancariaMotorista" c
    WHERE c.entregador_id = p_entregador_id AND c.status IN ('PENDENTE', 'APROVADA')
    ORDER BY c.solicitada_em DESC LIMIT 1;
    IF v_existente IS NOT NULL THEN
        RETURN QUERY SELECT v_existente, false;
        RETURN;
    END IF;

    INSERT INTO "ContaBancariaMotorista" (
        id_empresa, entregador_id, origem, status, titular_nome, titular_documento, titular_tipo,
        banco_codigo, banco_nome, agencia, conta, conta_digito, tipo_conta
    ) VALUES (
        v_entregador.id_empresa, p_entregador_id, 'CARGA_INICIAL', 'PENDENTE',
        btrim(p_dados ->> 'titularNome'), p_dados ->> 'titularDocumento', p_dados ->> 'titularTipo',
        p_dados ->> 'bancoCodigo', p_dados ->> 'bancoNome', p_dados ->> 'agencia',
        p_dados ->> 'conta', p_dados ->> 'contaDigito', p_dados ->> 'tipoConta'
    )
    ON CONFLICT (entregador_id) WHERE status = 'PENDENTE' DO NOTHING
    RETURNING "ContaBancariaMotorista".id INTO v_novo_id;

    IF v_novo_id IS NULL THEN
        -- Corrida concorrente inseriu entre a pré-checagem e o INSERT
        -- (defesa adicional; o script real roda serial, sem concorrência).
        SELECT c.id INTO v_novo_id FROM "ContaBancariaMotorista" c
        WHERE c.entregador_id = p_entregador_id AND c.status = 'PENDENTE';
        RETURN QUERY SELECT v_novo_id, false;
        RETURN;
    END IF;

    RETURN QUERY SELECT v_novo_id, true;
END;
$$;

-- Fail-closed (mesmo precedente 0041/0061/0067): hub_jwt_carga_inicial_worker
-- fica SEM grant — chamada só função-a-função. Só a RPC pública recebe GRANT.
REVOKE ALL ON FUNCTION hub_conta_bancaria_carga_inicial(int, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_conta_bancaria_carga_inicial(int, jsonb) TO authenticated;

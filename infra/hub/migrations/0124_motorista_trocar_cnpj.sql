-- 0124 — Troca de CNPJ do motorista numa transação só (frente motorista-cadastro-hub, F3).
--
-- Por quê: a troca vivia em server.js (migrarCnpjMotorista) e (1) nunca tocava a ContaMotorista,
-- (2) gravava os movimentos ANTES do pré-check de conflito (409 deixava dado meio migrado) e
-- (3) só pegava a grafia de dígitos da EnvioMassa. Agora o painel legado (PATCH /update-envio-massa)
-- e o hub (PATCH /motoristas/:id/credencial/cnpj) chamam ESTA função.
--
-- DEPENDE DA 0123: a troca na ContaMotorista é levada à Motorista pelo gatilho G2, e a troca
-- na Motorista (conta ausente) é levada à conta pelo G4. Esta função NÃO escreve na Motorista
-- quando existe a conta, de propósito: uma só regra de sincronia, no gatilho.
--
-- Ordem: valida -> PRÉ-CHECA conflito (conta e Motorista do CNPJ novo, nas duas grafias) -> só então
-- escreve. Conflito = SQLSTATE 23505 / mensagem 'CNPJ_CONFLITO' (PostgREST responde 409), sem
-- nenhuma escrita. Fusão de contas é destrutiva e fica fora: o operador usa "Trocar" (vínculo).
-- Erros (mensagem = código, lida pelo backend): CNPJ_INVALIDO (22023), EMPRESA_FORA_DO_GRUPO (42501),
-- CNPJ_NAO_ENCONTRADO (P0002: o CNPJ antigo não tem conta vinculada nem movimento DESTA empresa),
-- CNPJ_CONFLITO (23505).
--
-- Escopo: só grupo Movee (empresa 6 + filiais, mesma regra de mesmoGrupoQue: Grupo.id_empresa_pai=6
-- ->  Empresa.id_grupo). Movimentos: TODOS os da empresa p_id_empresa com o CNPJ antigo, nas duas
-- grafias (EnvioMassa guarda dígitos e pontuada). Movimento pontuado do CNPJ antigo NÃO é normalizado
-- além disso (destrutivo, só fechados) — apenas migra para o CNPJ novo em dígitos.
-- Sem conta e sem Motorista para o CNPJ antigo: cria o pré-cadastro do CNPJ novo (nome '', sem senha),
-- que é o que o legado já fazia, para o motorista poder se cadastrar no app.
-- Conta bancária PJ NÃO é tocada: só sinaliza (contaBancariaPjDesatualizada) para a tela avisar.
--
-- SECURITY DEFINER + EnvioMassa/Motorista/ContaMotorista sem RLS por empresa: p_id_empresa é a
-- fronteira de tenant. O chamador MUST obtê-lo de resolveEmpresaAlvo (legado) ou da entidade ativa
-- do token (hub), nunca do corpo; a função ainda exige que o CNPJ antigo pertença à empresa.
-- GRANT só a authenticated (padrão da 0116); REVOKE de PUBLIC.
-- Aditiva e idempotente (CREATE OR REPLACE). Nenhuma tabela/coluna nova.
-- ROLLBACK: DROP FUNCTION IF EXISTS hub_motorista_trocar_cnpj(text, text, int);

CREATE OR REPLACE FUNCTION hub_motorista_trocar_cnpj(
    p_cnpj_antigo text,
    p_cnpj_novo   text,
    p_id_empresa  int
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_antigo    text := regexp_replace(coalesce(p_cnpj_antigo, ''), '\D', '', 'g');
    v_novo      text := regexp_replace(coalesce(p_cnpj_novo, ''), '\D', '', 'g');
    v_pont_ant  text;
    v_pont_novo text;
    v_tem_conta boolean;
    v_tem_mot   boolean;
    v_conta     int := 0;
    v_mot       int := 0;
    v_mov       int := 0;
    v_precad    boolean := false;
    v_pj        boolean := false;
BEGIN
    IF v_antigo !~ '^[0-9]{14}$' OR v_novo !~ '^[0-9]{14}$' THEN
        RAISE EXCEPTION 'CNPJ_INVALIDO' USING ERRCODE = '22023';
    END IF;

    IF NOT (p_id_empresa = 6 OR EXISTS (
            SELECT 1 FROM "Empresa" e JOIN "Grupo" g ON g.id = e.id_grupo
             WHERE e.id = p_id_empresa AND g.id_empresa_pai = 6)) THEN
        RAISE EXCEPTION 'EMPRESA_FORA_DO_GRUPO' USING ERRCODE = '42501';
    END IF;

    IF v_antigo = v_novo THEN
        RETURN jsonb_build_object('inalterado', true, 'conta', 0, 'motorista', 0, 'movimentos', 0,
                                  'motoristaPrecadastroCriado', false, 'contaBancariaPjDesatualizada', false);
    END IF;

    v_pont_ant  := substr(v_antigo,1,2)||'.'||substr(v_antigo,3,3)||'.'||substr(v_antigo,6,3)||'/'||substr(v_antigo,9,4)||'-'||substr(v_antigo,13,2);
    v_pont_novo := substr(v_novo,1,2)||'.'||substr(v_novo,3,3)||'.'||substr(v_novo,6,3)||'/'||substr(v_novo,9,4)||'-'||substr(v_novo,13,2);

    -- o CNPJ antigo tem de ser DESTA empresa (conta vinculada a um Entregador dela ou movimento dela)
    IF NOT (EXISTS (SELECT 1 FROM "EnvioMassa" em
                     WHERE em.id_empresa = p_id_empresa AND em.cnpj_prestador IN (v_antigo, v_pont_ant))
            OR EXISTS (SELECT 1 FROM "Entregador" en JOIN "ContaMotorista" cm ON cm.id = en.motorista_id
                        WHERE en.id_empresa = p_id_empresa AND cm.cnpj_prestador = v_antigo)) THEN
        RAISE EXCEPTION 'CNPJ_NAO_ENCONTRADO' USING ERRCODE = 'P0002';
    END IF;

    -- PRÉ-CHECK de conflito: nada é escrito antes disto
    IF EXISTS (SELECT 1 FROM "ContaMotorista" WHERE cnpj_prestador IN (v_novo, v_pont_novo))
       OR EXISTS (SELECT 1 FROM "Motorista" WHERE cnpj_prestador IN (v_novo, v_pont_novo)) THEN
        RAISE EXCEPTION 'CNPJ_CONFLITO' USING ERRCODE = '23505';
    END IF;

    v_tem_conta := EXISTS (SELECT 1 FROM "ContaMotorista" WHERE cnpj_prestador = v_antigo);
    v_tem_mot   := EXISTS (SELECT 1 FROM "Motorista" WHERE cnpj_prestador IN (v_antigo, v_pont_ant));
    v_pj        := EXISTS (SELECT 1 FROM "ContaBancariaMotorista"
                            WHERE titular_tipo = 'PJ' AND titular_documento = v_antigo
                              AND status IN ('PENDENTE', 'APROVADA'));

    IF v_tem_conta THEN
        -- o gatilho G2 (0123) leva a troca à Motorista
        UPDATE "ContaMotorista" SET cnpj_prestador = v_novo, atualizado_em = now()
         WHERE cnpj_prestador = v_antigo;
        GET DIAGNOSTICS v_conta = ROW_COUNT;
        IF v_tem_mot AND EXISTS (SELECT 1 FROM "Motorista" WHERE cnpj_prestador = v_novo) THEN
            v_mot := 1;
        END IF;
    ELSIF v_tem_mot THEN
        -- sem conta: o gatilho G4 (0123) não tem o que levar
        UPDATE "Motorista" SET cnpj_prestador = v_novo WHERE cnpj_prestador IN (v_antigo, v_pont_ant);
        GET DIAGNOSTICS v_mot = ROW_COUNT;
    ELSE
        INSERT INTO "Motorista" (cnpj_prestador, nome, ativo) VALUES (v_novo, '', true)
        ON CONFLICT (cnpj_prestador) DO NOTHING;
        v_precad := true;
    END IF;

    UPDATE "EnvioMassa" SET cnpj_prestador = v_novo
     WHERE id_empresa = p_id_empresa AND cnpj_prestador IN (v_antigo, v_pont_ant);
    GET DIAGNOSTICS v_mov = ROW_COUNT;

    RETURN jsonb_build_object('inalterado', false, 'conta', v_conta, 'motorista', v_mot, 'movimentos', v_mov,
                              'motoristaPrecadastroCriado', v_precad, 'contaBancariaPjDesatualizada', v_pj);
END
$$;

REVOKE ALL ON FUNCTION hub_motorista_trocar_cnpj(text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_motorista_trocar_cnpj(text, text, int) TO authenticated;

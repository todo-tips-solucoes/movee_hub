-- 0093 — vincular o entregador ao seu CNPJ usando a EnvioMassa como fonte.
--
-- O PROBLEMA, medido em produção em 2026-09-23: a empresa 6 tem **925
-- entregadores sem vínculo** com `ContaMotorista`. Sem CNPJ não há nota, e a
-- F4 (gerar o movimento da semana) só alcançava 330 de 824 motoristas. Não é
-- limitação de código — é cadastro.
--
-- A PONTE: o nome. `EnvioMassa` tem `nome` + `cnpj_prestador` de anos de
-- planilha; `Entregador` tem o nome vindo da EntreGô. Casando por
-- `hub_normaliza_nome` (0021/0040 — a MESMA normalização que o vínculo manual
-- da 0023 já usa, para os dois concordarem):
--
--   753 casam com UM cnpj e sem homônimo  -> vinculáveis
--    92 ambíguos (mesmo nome, CNPJs diferentes)
--    80 sem nenhum casamento
--
-- POR QUE ISSO É SEGURO O BASTANTE, e onde para de ser:
--   - só casa quando o nome leva a **exatamente um** CNPJ. Dois CNPJs para o
--     mesmo nome é homônimo entre pessoas diferentes, e um palpite aqui vira
--     nota emitida no CNPJ errado — esses ficam de fora, para revisão humana.
--   - só casa quando o nome é **único entre os entregadores** da empresa.
--     Medido: 0 homônimos internos hoje, mas a guarda fica, porque o próximo
--     import pode trazer um.
--   - `ContaMotorista.cnpj_prestador` é UNIQUE e `Entregador.motorista_id` é
--     UNIQUE parcial: uma conta pertence a UM entregador. Quando a conta já
--     está com outro, a função recusa em vez de falhar (1 caso hoje).
--
-- NÃO É AUTOMÁTICA: a função só age quando chamada, e nasce em `p_aplicar =
-- false` (simulação). Vincular 753 motoristas de uma vez é ato que o operador
-- decide, com o relatório na frente.
--
-- ROLLBACK: infra/hub/testes/sql/0093-rollback.sql (dropa a função; os
-- vínculos já criados FICAM — desfazê-los exige decisão à parte, e a trilha
-- em "Auditoria" diz quais foram).

CREATE OR REPLACE FUNCTION hub_motorista_vincular_por_envio_massa(
    p_id_empresa int,
    p_aplicar    boolean DEFAULT false
)
RETURNS TABLE (
    acao       text,
    quantidade bigint
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_criadas    bigint := 0;
    v_vinculadas bigint := 0;
    r            record;
    v_conta_id   int;
BEGIN
    IF NOT hub_adiantamento_tem_permissao('adiantamentos.configurar') THEN
        RAISE EXCEPTION 'PERMISSAO_NEGADA';
    END IF;
    IF NOT (p_id_empresa = ANY (hub_jwt_escopo_ids())) THEN
        RAISE EXCEPTION 'FORA_DO_ESCOPO';
    END IF;

    CREATE TEMP TABLE IF NOT EXISTS _vinculo_plano (
        entregador_id int, nome text, cnpj text, conta_id int, situacao text
    ) ON COMMIT DROP;
    DELETE FROM _vinculo_plano;

    INSERT INTO _vinculo_plano (entregador_id, nome, cnpj, conta_id, situacao)
    WITH orfaos AS (
        SELECT e.id, e.nome, hub_normaliza_nome(e.nome) AS chave
          FROM "Entregador" e
         WHERE e.id_empresa = p_id_empresa AND e.motorista_id IS NULL AND e.nome IS NOT NULL
    ),
    -- Homônimo DENTRO da base: se dois entregadores têm o mesmo nome, casar
    -- por nome pode dar o CNPJ de um ao outro.
    homonimos AS (
        SELECT hub_normaliza_nome(nome) AS chave
          FROM "Entregador" WHERE id_empresa = p_id_empresa AND nome IS NOT NULL
         GROUP BY 1 HAVING count(*) > 1
    ),
    em AS (
        SELECT hub_normaliza_nome(nome) AS chave, cnpj_prestador
          FROM "EnvioMassa"
         WHERE nome IS NOT NULL AND cnpj_prestador IS NOT NULL
         GROUP BY 1, 2
    ),
    casado AS (
        SELECT o.id, o.nome, o.chave,
               count(DISTINCT em.cnpj_prestador) AS cnpjs,
               min(em.cnpj_prestador)            AS cnpj
          FROM orfaos o LEFT JOIN em ON em.chave = o.chave
         GROUP BY o.id, o.nome, o.chave
    )
    SELECT c.id, c.nome, c.cnpj, cm.id,
           CASE
             WHEN c.cnpjs = 0 THEN 'SEM_CASAMENTO'
             WHEN c.cnpjs > 1 THEN 'AMBIGUO'
             WHEN c.chave IN (SELECT chave FROM homonimos) THEN 'HOMONIMO_INTERNO'
             WHEN cm.id IS NOT NULL AND e2.id IS NOT NULL THEN 'CONTA_JA_VINCULADA'
             WHEN cm.id IS NOT NULL THEN 'VINCULAR_CONTA_EXISTENTE'
             ELSE 'CRIAR_CONTA_E_VINCULAR'
           END
      FROM casado c
      LEFT JOIN "ContaMotorista" cm ON cm.cnpj_prestador = c.cnpj
      LEFT JOIN "Entregador" e2 ON e2.motorista_id = cm.id;

    IF p_aplicar THEN
        -- Um a um, e não em massa, porque cada caso pode esbarrar num UNIQUE
        -- (dois órfãos com o mesmo CNPJ numa corrida) e um erro não pode
        -- derrubar a rodada inteira.
        FOR r IN SELECT * FROM _vinculo_plano
                  WHERE situacao IN ('CRIAR_CONTA_E_VINCULAR', 'VINCULAR_CONTA_EXISTENTE')
        LOOP
            BEGIN
                IF r.conta_id IS NULL THEN
                    -- Telefone junto: o hub é o dono desse dado desde a 0091, e
                    -- criar a conta sem ele obrigaria um segundo backfill.
                    INSERT INTO "ContaMotorista" (cnpj_prestador, nome, telefone)
                    SELECT r.cnpj, r.nome,
                           (SELECT em2.number FROM "EnvioMassa" em2
                             WHERE em2.cnpj_prestador = r.cnpj AND em2.number ~ '^[0-9]{12,13}$'
                             ORDER BY em2.created_at DESC LIMIT 1)
                    RETURNING id INTO v_conta_id;
                    v_criadas := v_criadas + 1;
                ELSE
                    v_conta_id := r.conta_id;
                END IF;

                UPDATE "Entregador" SET motorista_id = v_conta_id
                 WHERE id = r.entregador_id AND motorista_id IS NULL;
                v_vinculadas := v_vinculadas + 1;
            EXCEPTION WHEN unique_violation THEN
                UPDATE _vinculo_plano SET situacao = 'CONFLITO_NA_GRAVACAO'
                 WHERE entregador_id = r.entregador_id;
            END;
        END LOOP;
    END IF;

    RETURN QUERY
    SELECT p.situacao, count(*) FROM _vinculo_plano p GROUP BY p.situacao
    UNION ALL SELECT 'CONTAS_CRIADAS', v_criadas
    UNION ALL SELECT 'VINCULOS_FEITOS', v_vinculadas
    ORDER BY 1;
END;
$$;

REVOKE ALL ON FUNCTION hub_motorista_vincular_por_envio_massa(int, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_motorista_vincular_por_envio_massa(int, boolean) TO authenticated;

-- 0102 — vincular Entregador ao CNPJ usando a base `Motorista` como fonte.
--
-- POR QUE EXISTE: a 0093 casa `Entregador` contra `EnvioMassa` e resolveu a
-- maior parte dos órfãos. Mas há uma SEGUNDA fonte de CNPJ no sistema que ela
-- nunca olhou — a tabela `Motorista`, o pré-cadastro que alimenta o login e a
-- validação de nota do app do motorista. Medido em 2026-10-05, na empresa 6:
--
--   20 entregadores sem vínculo casam por nome normalizado com EXATAMENTE 1
--   CNPJ em `Motorista` (15 deles com movimento nos últimos 30 dias,
--   R$ 9.091,35) — e nenhum deles é homônimo dentro da própria base.
--
-- NÃO É AUTOMÁTICA e nasce em simulação: `p_aplicar = false` por padrão, igual
-- à 0093. Chamar com `true` é decisão de quem opera.
--
-- DUPLICAÇÃO DELIBERADA: esta função repete a forma da 0093 em vez de
-- parametrizar a fonte. A 0093 já rodou em produção e está validada; mexer nela
-- para ganhar um parâmetro arriscaria o que já funciona, por elegância.
--
-- O QUE ELA NÃO FAZ, de propósito:
--   - não toca em quem casa com 2+ CNPJs (medido: 22 entregadores, R$ 67.438 —
--     são 2 CNPJs de empresas diferentes, da mesma pessoa, AMBOS com histórico
--     de uso em 21 dos 22 casos. Escolher o errado emite nota no CNPJ errado;
--     isso é decisão humana, não heurística);
--   - não toca em homônimo dentro da base (dois entregadores, mesmo nome);
--   - não cria CNPJ nenhum: só liga o que já está cadastrado.
--
-- ROLLBACK: os vínculos criados FICAM (são cadastro). A trilha de quais foram
-- está no retorno da função e no backup que o script de execução faz antes.
-- Para dropar só a função: DROP FUNCTION hub_motorista_vincular_por_base_motorista(int, boolean);

CREATE OR REPLACE FUNCTION hub_motorista_vincular_por_base_motorista(
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

    CREATE TEMP TABLE IF NOT EXISTS _vinculo_plano_mot (
        entregador_id int, nome text, cnpj text, conta_id int, situacao text
    ) ON COMMIT DROP;
    DELETE FROM _vinculo_plano_mot;

    INSERT INTO _vinculo_plano_mot (entregador_id, nome, cnpj, conta_id, situacao)
    WITH orfaos AS (
        SELECT e.id, e.nome, hub_normaliza_nome(e.nome) AS chave
          FROM "Entregador" e
         WHERE e.id_empresa = p_id_empresa AND e.motorista_id IS NULL AND e.nome IS NOT NULL
    ),
    homonimos AS (
        SELECT hub_normaliza_nome(nome) AS chave
          FROM "Entregador" WHERE id_empresa = p_id_empresa AND nome IS NOT NULL
         GROUP BY 1 HAVING count(*) > 1
    ),
    mot AS (
        SELECT hub_normaliza_nome(nome) AS chave, cnpj_prestador
          FROM "Motorista"
         WHERE nome IS NOT NULL AND cnpj_prestador IS NOT NULL
         GROUP BY 1, 2
    ),
    casado AS (
        SELECT o.id, o.nome, o.chave,
               count(DISTINCT m.cnpj_prestador) AS cnpjs,
               min(m.cnpj_prestador)            AS cnpj
          FROM orfaos o LEFT JOIN mot m ON m.chave = o.chave
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
        FOR r IN SELECT * FROM _vinculo_plano_mot
                  WHERE situacao IN ('CRIAR_CONTA_E_VINCULAR', 'VINCULAR_CONTA_EXISTENTE')
        LOOP
            BEGIN
                IF r.conta_id IS NULL THEN
                    -- telefone: mesma origem da 0093 (EnvioMassa pelo CNPJ). A
                    -- tabela `Motorista` não guarda telefone.
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
                UPDATE _vinculo_plano_mot SET situacao = 'CONFLITO_NA_GRAVACAO'
                 WHERE entregador_id = r.entregador_id;
            END;
        END LOOP;
    END IF;

    RETURN QUERY
    SELECT p.situacao, count(*) FROM _vinculo_plano_mot p GROUP BY p.situacao
    UNION ALL SELECT 'CONTAS_CRIADAS', v_criadas
    UNION ALL SELECT 'VINCULOS_FEITOS', v_vinculadas;
END;
$$;

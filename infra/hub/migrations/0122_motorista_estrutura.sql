-- 0122 — estrutura de "Motorista" / "ContaMotorista": CNPJ sempre 14 digitos, `atualizado_em` que de fato muda,
-- dono unico por token de reset, e a correcao da 0102.
--
-- POR QUE (frente motorista-cadastro-hub):
--   E1  nada impedia CNPJ pontuado ou de tamanho errado nas duas tabelas; os gatilhos da 0123 casam as linhas por
--       IGUALDADE de CNPJ, entao uma grafia diferente cria linha duplicada (a UNIQUE nao pega). CHECK `NOT VALID`
--       (so valida linha nova/alterada, sem varrer) seguido de `VALIDATE` (varre; as tabelas tem poucos
--       milhares de linhas). Com `psql -1` o ACCESS EXCLUSIVE do ADD CONSTRAINT vale ATE O COMMIT, entao o VALIDATE
--       tambem roda com a tabela bloqueada para leitura; por isso o lock_timeout abaixo. O VALIDATE FALHA se sobrar CNPJ fora do padrao: rode a 0121 antes
--       (ela normaliza o que nao colide) e trate as colisoes listadas em D4/D4b do diagnostico.
--   E3  `ContaMotorista.atualizado_em` existia mas nada o atualizava; `Motorista` nem tinha a coluna. Sem isso nao
--       ha "quem mudou por ultimo" para decidir senha divergente. ADD COLUMN com DEFAULT now() (volatil nao,
--       STABLE: fast default, sem reescrever a tabela) + gatilho BEFORE UPDATE. O PostgREST precisa recarregar o
--       schema (migrate.sh manda SIGUSR1).
--   E4  indice unico PARCIAL em `token_reset_hash`: o lookup de /motorista/definir-senha passa a ter dono unico
--       (e deixa de ser varredura).
--   E2  `hub_motorista_vincular_por_base_motorista` (0102, definicao viva e unica) usava `Motorista.cnpj_prestador`
--       CRU: um CNPJ pontuado criaria a conta pontuada, e o telefone so era buscado na grafia crua da EnvioMassa
--       (a base tem as duas). Agora normaliza para 14 digitos e busca as duas grafias. Mesma assinatura e retorno
--       => CREATE OR REPLACE preserva os GRANTs.
--
-- Idempotente. ROLLBACK: ALTER TABLE ... DROP CONSTRAINT motorista_cnpj_14 / contamotorista_cnpj_14;
-- DROP TRIGGER trg_*_atualizado_em; DROP FUNCTION hub_trg_touch_atualizado_em(); DROP INDEX idx_conta_motorista_token_reset;
-- reaplicar a funcao da 0102. A coluna `Motorista.atualizado_em` pode ficar (aditiva).

SET LOCAL lock_timeout = '5s';

-- E1 -----------------------------------------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'motorista_cnpj_14'
                   AND conrelid = '"Motorista"'::regclass) THEN
        ALTER TABLE "Motorista"
            ADD CONSTRAINT motorista_cnpj_14 CHECK (cnpj_prestador ~ '^[0-9]{14}$') NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contamotorista_cnpj_14'
                   AND conrelid = '"ContaMotorista"'::regclass) THEN
        ALTER TABLE "ContaMotorista"
            ADD CONSTRAINT contamotorista_cnpj_14 CHECK (cnpj_prestador ~ '^[0-9]{14}$') NOT VALID;
    END IF;
END $$;

ALTER TABLE "Motorista" VALIDATE CONSTRAINT motorista_cnpj_14;
ALTER TABLE "ContaMotorista" VALIDATE CONSTRAINT contamotorista_cnpj_14;

-- E3 -----------------------------------------------------------------------------------------------------------
ALTER TABLE "Motorista" ADD COLUMN IF NOT EXISTS atualizado_em timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION hub_trg_touch_atualizado_em()
RETURNS trigger LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $f$
BEGIN
    NEW.atualizado_em := now();
    RETURN NEW;
END
$f$;

DROP TRIGGER IF EXISTS trg_motorista_atualizado_em ON "Motorista";
CREATE TRIGGER trg_motorista_atualizado_em BEFORE UPDATE ON "Motorista"
    FOR EACH ROW EXECUTE FUNCTION hub_trg_touch_atualizado_em();

DROP TRIGGER IF EXISTS trg_contamotorista_atualizado_em ON "ContaMotorista";
CREATE TRIGGER trg_contamotorista_atualizado_em BEFORE UPDATE ON "ContaMotorista"
    FOR EACH ROW EXECUTE FUNCTION hub_trg_touch_atualizado_em();

-- E4 -----------------------------------------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_conta_motorista_token_reset
    ON "ContaMotorista" (token_reset_hash) WHERE token_reset_hash IS NOT NULL;

-- E2 — definicao VIVA e unica: 0102 (nenhuma migration posterior a redefine). Unico delta: CTE `mot` normalizada
-- (14 digitos) e telefone buscado nas duas grafias da EnvioMassa.
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
        -- E2: CNPJ normalizado para 14 digitos (a conta nunca nasce pontuada); o que nao fecha 14 digitos nao casa
        SELECT hub_normaliza_nome(nome) AS chave,
               regexp_replace(cnpj_prestador, '\D', '', 'g') AS cnpj_prestador
          FROM "Motorista"
         WHERE nome IS NOT NULL AND cnpj_prestador IS NOT NULL
           AND length(regexp_replace(cnpj_prestador, '\D', '', 'g')) = 14
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
                    -- telefone: mesma origem da 0093 (EnvioMassa pelo CNPJ, agora nas DUAS grafias). A
                    -- tabela `Motorista` nao guarda telefone.
                    INSERT INTO "ContaMotorista" (cnpj_prestador, nome, telefone)
                    SELECT r.cnpj, r.nome,
                           (SELECT em2.number FROM "EnvioMassa" em2
                             WHERE em2.cnpj_prestador IN (r.cnpj,
                                       substr(r.cnpj, 1, 2) || '.' || substr(r.cnpj, 3, 3) || '.' ||
                                       substr(r.cnpj, 6, 3) || '/' || substr(r.cnpj, 9, 4) || '-' ||
                                       substr(r.cnpj, 13, 2))
                               AND em2.number ~ '^[0-9]{12,13}$'
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

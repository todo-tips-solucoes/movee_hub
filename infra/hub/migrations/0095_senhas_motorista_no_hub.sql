-- 0095 — as senhas do motorista passam a viver no hub, e o CNPJ do hub volta a
-- ser só dígitos.
--
-- CONTEXTO (incidente 2026-09-23/24): o operador não conseguiu entrar no app do
-- motorista. A investigação mostrou que o login está íntegro — um motorista de
-- teste com senha conhecida entrou com HTTP 200 —, mas expôs dois problemas
-- reais de dados:
--
--   1. Existem DOIS sistemas de senha. O login do app usa `Motorista.senha`
--      (legado, 801 preenchidas). O hub usa `ContaMotorista.senha`, que estava
--      com **0 de 1.456** preenchidas. Enquanto isso for verdade, ligar
--      `HUB_MOTORISTA_LOGIN_CONTA_ATIVA` derruba o acesso de TODO MUNDO.
--   2. O reset de senha do hub (`POST /motoristas/:id/credencial/reset-senha`)
--      zera a senha na `ContaMotorista` — a tabela que o login NÃO usa. Ele não
--      repõe acesso de ninguém hoje. Esta migration não corrige isso; corrige a
--      base de dados para que a correção do fluxo faça sentido.
--
-- O QUE ESTA MIGRATION FAZ
--
-- (1) Normaliza `ContaMotorista.cnpj_prestador` para só dígitos. Duas contas
--     nasceram pontuadas na execução do vínculo (0093) porque a `EnvioMassa`
--     guarda o CNPJ em duas grafias. O login normaliza o que o motorista digita
--     para dígitos, então um CNPJ pontuado no hub NUNCA casaria. Conferido:
--     normalizar não cria duplicata (0 colisões).
--
-- (2) Copia o HASH do legado para o hub, casando por CNPJ normalizado. É o
--     mesmo bcrypt (`$2b$` nos 801), então o motorista continua entrando com a
--     senha que já usa — ninguém precisa saber nenhuma senha, e nada é
--     redefinido. **Só preenche onde o hub está NULO**: senha já definida no
--     hub é mais recente que a do legado e não pode ser sobrescrita.
--
-- (3) Corrige `hub_motorista_vincular_por_envio_massa` (0093) para normalizar o
--     CNPJ na origem, senão o problema (1) volta no próximo vínculo.
--
-- O QUE ESTA MIGRATION **NÃO** FAZ
--   - não liga o flag do login (decisão do operador, e exige o fluxo de reset
--     resolvido antes);
--   - não muda nada no caminho legado: o login continua funcionando exatamente
--     como hoje. Esta migration é **inerte** para quem usa o app agora.
--
-- ROLLBACK: infra/hub/testes/sql/0095-rollback.sql — restaura a função da 0093.
-- As senhas copiadas FICAM: são credenciais válidas, e apagá-las não devolve
-- nada a ninguém (o legado continua sendo a fonte do login).

-- 1. CNPJ do hub só com dígitos.
UPDATE "ContaMotorista"
   SET cnpj_prestador = regexp_replace(cnpj_prestador, '[^0-9]', '', 'g')
 WHERE cnpj_prestador ~ '[^0-9]';

-- 2. Hash do legado -> hub, só onde o hub está nulo.
UPDATE "ContaMotorista" cm
   SET senha = m.senha
  FROM "Motorista" m
 WHERE cm.senha IS NULL
   AND m.senha IS NOT NULL
   AND regexp_replace(m.cnpj_prestador, '[^0-9]', '', 'g') = cm.cnpj_prestador;

-- 3. O vínculo passa a normalizar o CNPJ na origem (corpo da 0093 + normalização).
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
        -- ⚠️ A `EnvioMassa` guarda o CNPJ em DUAS grafias (só dígitos até
        -- out/2025, pontuado depois). Sem normalizar aqui, o mesmo CNPJ conta
        -- como dois e a conta nasce pontuada — foi o que aconteceu com 2 contas
        -- na execução de 2026-09-23. `ContaMotorista` guarda só dígitos, e é
        -- assim que o login normaliza o que o motorista digita.
        SELECT hub_normaliza_nome(nome) AS chave,
               regexp_replace(cnpj_prestador, '[^0-9]', '', 'g') AS cnpj_prestador
          FROM "EnvioMassa"
         WHERE nome IS NOT NULL AND cnpj_prestador IS NOT NULL
           AND regexp_replace(cnpj_prestador, '[^0-9]', '', 'g') <> ''
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
                             WHERE regexp_replace(em2.cnpj_prestador, '[^0-9]', '', 'g') = r.cnpj
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

-- correcao-listas-motorista-20261101.sql — correção ÚNICA das listas do gate da frente
-- motorista-cadastro-hub (PR #308), com as regras decididas pelo operador em 2026-11-01:
--   * vínculo (C2): vale o CNPJ do ENVIO EM MASSA (último movimento do Entregador);
--   * senha (C3b e resets vencidos): vale a que mantém o acesso ao app = a do LEGADO
--     ("Motorista", que o login lê);
--   * ativo divergente (C3d): era a conta antiga do Thiago; resolve-se ao re-vincular.
--
-- Rodar com psql --single-transaction -v ON_ERROR_STOP=1, passando as quantidades esperadas
-- (medidas antes, só leitura):
--   -v exp_a=8 -v exp_b=14 -v exp_c3b=8 -v exp_reset_senha=15 -v exp_reset_token=18 -v exp_c3d=1
-- Qualquer quantidade diferente aborta ANTES de escrever. As checagens finais abortam a
-- transação inteira se sobrar algum caso. Não apaga nenhuma linha. Não imprime hash nem CNPJ
-- completo. Cada alteração vai para "Auditoria" (acao motorista.correcao_listas_20261101).
--
-- Precisa das migrations 0120–0124 (gatilhos G2/G3/G4 da 0123 e a GUC hub.sync_motorista).
-- ROLLBACK: restaurar do pg_dump -t "Motorista" -t "ContaMotorista" -t "Entregador" tirado antes.

SET LOCAL lock_timeout = '5s';

SELECT set_config('corr.exp_a', :'exp_a', true), set_config('corr.exp_b', :'exp_b', true),
       set_config('corr.exp_c3b', :'exp_c3b', true), set_config('corr.exp_reset_senha', :'exp_reset_senha', true),
       set_config('corr.exp_reset_token', :'exp_reset_token', true), set_config('corr.exp_c3d', :'exp_c3d', true);

-- C2: Entregador vinculado a CNPJ diferente do último movimento (pareamento exato por id_externo).
CREATE TEMP TABLE c2 ON COMMIT DROP AS
WITH ult AS (
    SELECT DISTINCT ON (coalesce(em.entregador_uuid, em.uuid)) coalesce(em.entregador_uuid, em.uuid) AS eu,
           regexp_replace(em.cnpj_prestador, '\D', '', 'g') AS y
      FROM "EnvioMassa" em
     WHERE coalesce(em.entregador_uuid, em.uuid) IS NOT NULL AND em.cnpj_prestador IS NOT NULL
     ORDER BY coalesce(em.entregador_uuid, em.uuid), em.created_at DESC)
SELECT e.id AS eid, e.id_empresa, cm.id AS cid, cm.cnpj_prestador AS x, u.y,
       alvo.id AS alvo_id,
       EXISTS (SELECT 1 FROM "Entregador" e2 WHERE e2.motorista_id = alvo.id) AS alvo_ocupada,
       (SELECT m.senha IS NULL FROM "Motorista" m WHERE m.cnpj_prestador = u.y) AS legy_sem_senha,
       CASE WHEN alvo.id IS NOT NULL THEN 'A' ELSE 'B' END AS cls
  FROM "Entregador" e
  JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
  JOIN ult u ON u.eu = e.id_externo
  LEFT JOIN "ContaMotorista" alvo ON alvo.cnpj_prestador = u.y
 WHERE u.y <> cm.cnpj_prestador AND u.y ~ '^[0-9]{14}$';

DO $$
DECLARE
    n_a int := (SELECT count(*) FROM c2 WHERE cls = 'A');
    n_b int := (SELECT count(*) FROM c2 WHERE cls = 'B');
    n_ocupada int := (SELECT count(*) FROM c2 WHERE cls = 'A' AND alvo_ocupada);
    n_b_com_senha int := (SELECT count(*) FROM c2 WHERE cls = 'B' AND legy_sem_senha IS FALSE);
    n_c3b int := (SELECT count(*) FROM "ContaMotorista" c JOIN "Motorista" m ON m.cnpj_prestador = c.cnpj_prestador
                   WHERE c.senha IS NOT NULL AND m.senha IS NOT NULL AND c.senha <> m.senha);
    n_rs int := (SELECT count(*) FROM "ContaMotorista" c JOIN "Motorista" m ON m.cnpj_prestador = c.cnpj_prestador
                  WHERE c.senha IS NULL AND m.senha IS NOT NULL AND c.token_reset_hash IS NOT NULL AND c.token_reset_expira < now());
    n_rt int := (SELECT count(*) FROM "ContaMotorista" WHERE token_reset_hash IS NOT NULL AND token_reset_expira < now());
    n_c3d int := (SELECT count(*) FROM "ContaMotorista" c JOIN "Motorista" m ON m.cnpj_prestador = c.cnpj_prestador
                   WHERE c.ativo IS DISTINCT FROM m.ativo);
BEGIN
    RAISE NOTICE 'medido: A=% B=% C3b=% reset_senha=% reset_token=% C3d=%', n_a, n_b, n_c3b, n_rs, n_rt, n_c3d;
    IF n_a <> current_setting('corr.exp_a')::int OR n_b <> current_setting('corr.exp_b')::int
       OR n_c3b <> current_setting('corr.exp_c3b')::int OR n_rs <> current_setting('corr.exp_reset_senha')::int
       OR n_rt <> current_setting('corr.exp_reset_token')::int OR n_c3d <> current_setting('corr.exp_c3d')::int THEN
        RAISE EXCEPTION 'quantidades diferentes do esperado — nada foi escrito';
    END IF;
    IF n_ocupada > 0 THEN RAISE EXCEPTION 'há % conta(s)-alvo já vinculada(s) a outro Entregador — decisão manual', n_ocupada; END IF;
    IF n_b_com_senha > 0 THEN RAISE EXCEPTION 'há % legado(s) no CNPJ novo COM senha no grupo B — decisão manual', n_b_com_senha; END IF;
END $$;

-- Auditoria antes das escritas (registra o que será feito, sem segredo).
INSERT INTO "Auditoria" (id_empresa, usuario_id, acao, recurso, recurso_id, detalhes)
SELECT c2.id_empresa, NULL, 'motorista.correcao_listas_20261101', 'ContaMotorista', c2.cid::text,
       jsonb_build_object('regra', CASE cls WHEN 'A' THEN 'C2_revinculo' ELSE 'C2_troca_cnpj' END,
                          'entregadorId', c2.eid, 'contaAlvoId', c2.alvo_id,
                          'cnpjAnterior', left(c2.x, 2) || '**********' || right(c2.x, 2),
                          'cnpjEnvioMassa', left(c2.y, 2) || '**********' || right(c2.y, 2))
  FROM c2;
INSERT INTO "Auditoria" (id_empresa, usuario_id, acao, recurso, recurso_id, detalhes)
SELECT NULL, NULL, 'motorista.correcao_listas_20261101', 'ContaMotorista', c.id::text,
       jsonb_build_object('regra', CASE WHEN c.senha IS NOT NULL THEN 'C3b_senha_do_legado' ELSE 'reset_vencido_senha_do_legado' END)
  FROM "ContaMotorista" c JOIN "Motorista" m ON m.cnpj_prestador = c.cnpj_prestador
 WHERE m.senha IS NOT NULL
   AND ((c.senha IS NOT NULL AND c.senha <> m.senha)
     OR (c.senha IS NULL AND c.token_reset_hash IS NOT NULL AND c.token_reset_expira < now()));

-- 1. Senhas: vale a do legado (é a que o login aceita hoje). O G2 tenta devolver ao legado, mas o
--    valor já é igual (IS DISTINCT FROM) — nada muda lá.
UPDATE "ContaMotorista" c SET senha = m.senha
  FROM "Motorista" m
 WHERE m.cnpj_prestador = c.cnpj_prestador AND m.senha IS NOT NULL
   AND ((c.senha IS NOT NULL AND c.senha <> m.senha)
     OR (c.senha IS NULL AND c.token_reset_hash IS NOT NULL AND c.token_reset_expira < now()));

-- 2. Tokens de reset vencidos: não servem para nada e bloqueiam o /register (coluna fora do G2).
UPDATE "ContaMotorista" SET token_reset_hash = NULL, token_reset_expira = NULL
 WHERE token_reset_hash IS NOT NULL AND token_reset_expira < now();

-- 3. Grupo A: re-vincular o Entregador à conta que já existe no CNPJ do envio em massa (G3 sincroniza).
UPDATE "Entregador" e SET motorista_id = c2.alvo_id FROM c2 WHERE c2.cls = 'A' AND e.id = c2.eid;

--    C3d: conta antiga que ficou sem uso, ativa no hub e inativa no legado -> inativa nos dois.
INSERT INTO "Auditoria" (id_empresa, usuario_id, acao, recurso, recurso_id, detalhes)
SELECT c2.id_empresa, NULL, 'motorista.correcao_listas_20261101', 'ContaMotorista', c.id::text,
       jsonb_build_object('regra', 'C3d_conta_antiga_inativada')
  FROM "ContaMotorista" c JOIN c2 ON c2.cid = c.id AND c2.cls = 'A'
 WHERE c.ativo AND EXISTS (SELECT 1 FROM "Motorista" m WHERE m.cnpj_prestador = c.cnpj_prestador AND NOT m.ativo);
UPDATE "ContaMotorista" c SET ativo = false
  FROM c2
 WHERE c2.cls = 'A' AND c.id = c2.cid AND c.ativo
   AND EXISTS (SELECT 1 FROM "Motorista" m WHERE m.cnpj_prestador = c.cnpj_prestador AND NOT m.ativo);

-- 4. Grupo B: a conta passa para o CNPJ do envio em massa. O legado já tem um pré-cadastro (sem
--    senha) nesse CNPJ, então o G2 NÃO pode renomear a linha antiga (colidiria): a GUC 'legado'
--    o desliga só nesta instrução. Em seguida, o pré-cadastro recebe a senha que o motorista já
--    usa (a do legado antigo; sem ela, a da conta) e o G4 a confirma na conta.
SELECT set_config('hub.sync_motorista', 'legado', true);
UPDATE "ContaMotorista" c SET cnpj_prestador = c2.y FROM c2 WHERE c2.cls = 'B' AND c.id = c2.cid;
SELECT set_config('hub.sync_motorista', '', true);

UPDATE "Motorista" my SET senha = src.senha
  FROM (SELECT c2.y, coalesce(mx.senha, c.senha) AS senha
          FROM c2 JOIN "ContaMotorista" c ON c.id = c2.cid
          LEFT JOIN "Motorista" mx ON mx.cnpj_prestador = c2.x
         WHERE c2.cls = 'B') src
 WHERE my.cnpj_prestador = src.y AND my.senha IS NULL AND src.senha IS NOT NULL;

-- 5. Conferência final: sobrou algum caso? Aborta a transação inteira se sim.
DO $$
DECLARE r record;
BEGIN
    SELECT
      (SELECT count(*) FROM "Entregador" e JOIN c2 ON c2.eid = e.id JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
        WHERE cm.cnpj_prestador <> c2.y) AS c2_resta,
      (SELECT count(*) FROM "ContaMotorista" c JOIN "Motorista" m ON m.cnpj_prestador = c.cnpj_prestador
        WHERE c.senha IS DISTINCT FROM m.senha AND m.senha IS NOT NULL) AS senha_resta,
      (SELECT count(*) FROM "ContaMotorista" WHERE token_reset_hash IS NOT NULL AND token_reset_expira < now()) AS token_resta,
      (SELECT count(*) FROM "ContaMotorista" c JOIN "Motorista" m ON m.cnpj_prestador = c.cnpj_prestador
        WHERE c.ativo IS DISTINCT FROM m.ativo) AS ativo_resta,
      (SELECT count(*) FROM c2 JOIN "ContaMotorista" c ON c.id = c2.cid
        LEFT JOIN "Motorista" mx ON mx.cnpj_prestador = c2.x
        JOIN "Motorista" my ON my.cnpj_prestador = c2.y
        WHERE c2.cls = 'B' AND coalesce(mx.senha, c.senha) IS DISTINCT FROM my.senha) AS b_senha_nao_levada
    INTO r;
    RAISE NOTICE 'restam: C2=% senha=% token=% ativo=% B_sem_senha_levada=%',
        r.c2_resta, r.senha_resta, r.token_resta, r.ativo_resta, r.b_senha_nao_levada;
    IF r.c2_resta + r.senha_resta + r.token_resta + r.ativo_resta + r.b_senha_nao_levada > 0 THEN
        RAISE EXCEPTION 'conferência final falhou — transação desfeita';
    END IF;
END $$;

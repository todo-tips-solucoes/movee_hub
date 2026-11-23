-- 0128 — Campanhas: excluir rascunho + `admin_plataforma` no módulo.
--
-- POR QUE (pedido do operador, 2026-11-23):
--  (1) um rascunho de teste ficaria na lista para sempre; `authenticated` não tem DELETE direto
--      em "Campanha", então a exclusão é uma RPC;
--  (2) `admin_plataforma` recebeu "todas as permissões" só no seed 0007; cada permissão nova é
--      concedida a ele EXPLICITAMENTE (0016, 0026, 0029, 0032, 0062, 0070). A 0127 não o incluiu.
--      A checagem das RPCs (escopo + empresa_ativa + permissão) já o atende pelo vínculo dele
--      na entidade ativa: basta o grant.
--
-- EXCLUSÃO: física, só de RASCUNHO. Lançada/cancelada/encerrada → CAMPANHA_IMUTAVEL (55000):
-- o gatilho da 0127 também recusa o DELETE de lançada, mas o teste explícito dá o erro certo
-- antes de qualquer efeito. "CampanhaPremio" e "CampanhaRanking" saem em cascata; rascunho
-- nunca tem vencedor.
--
-- Aditiva e idempotente (ON CONFLICT DO NOTHING / CREATE OR REPLACE). O registro em
-- "SchemaMigration" é feito pelo migrate.sh.

INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p
CROSS JOIN "Permissao" perm
WHERE p.nome = 'admin_plataforma'
  AND perm.codigo IN ('campanhas.consultar', 'campanhas.gerir', 'campanhas.entregar')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION hub_campanha_excluir(p_id int)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    c "Campanha";
BEGIN
    c := hub_campanha_carregar(p_id, 'campanhas.gerir', true);
    IF c.lancada_em IS NOT NULL THEN
        RAISE EXCEPTION 'CAMPANHA_IMUTAVEL' USING ERRCODE = '55000';
    END IF;
    DELETE FROM "Campanha" WHERE id = c.id;
    RETURN jsonb_build_object('id', c.id, 'nome', c.nome);
END;
$$;

REVOKE ALL ON FUNCTION hub_campanha_excluir(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_campanha_excluir(int) TO authenticated;

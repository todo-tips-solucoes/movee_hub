-- 0037 — RPC hub_papel_permissao_set: matriz papel×permissão, com guard
-- anti-lockout (S9 — hub-auditoria-admin; plan.md "Plano por fases" passo 1;
-- data-model.md "Entity: Papel / Permissao / PapelPermissao"; research.md
-- Decision 5; contracts/papeis-api.md "PUT /papeis/:papelId/permissoes/
-- :permissaoId" — finding M2 do gate owasp; tasks.md 1.3).
--
-- Idempotente: CREATE OR REPLACE FUNCTION + REVOKE/GRANT são reexecutáveis
-- sem erro.
--
-- SECURITY DEFINER: a checagem de autorização vive DENTRO da função (não no
-- GRANT — REVOKE ALL FROM PUBLIC + GRANT EXECUTE TO authenticated abaixo).
-- A DELETE de uma célula da matriz é feita INTERNAMENTE pela função (dono),
-- nunca via GRANT DELETE direto em "PapelPermissao" para o role
-- `authenticated` (nenhum GRANT DELETE existe nessa tabela desde 0003 — não
-- alterado aqui).
CREATE OR REPLACE FUNCTION hub_papel_permissao_set(
    p_papel_id     int,
    p_permissao_id int,
    p_ativo        boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT hub_jwt_admin_plataforma() THEN
        RAISE EXCEPTION 'hub_papel_permissao_set: exclusivo de admin_plataforma'
            USING ERRCODE = '42501';
    END IF;

    -- Guard anti-lockout (finding M2 do gate owasp): jamais permitir
    -- desmarcar a célula (papel=admin_plataforma, permissao=admin.gerenciar)
    -- — removeria a permissão de administração do próprio papel de
    -- plataforma, deixando o sistema sem administração recuperável exceto
    -- via psql direto.
    IF p_ativo = false
       AND EXISTS (
            SELECT 1
            FROM "Papel" pa
            JOIN "Permissao" pe ON pe.id = p_permissao_id
            WHERE pa.id = p_papel_id
              AND pa.nome = 'admin_plataforma'
              AND pe.codigo = 'admin.gerenciar'
       )
    THEN
        RAISE EXCEPTION 'hub_papel_permissao_set: operacao bloqueada (anti-lockout admin_plataforma/admin.gerenciar)'
            USING ERRCODE = '42501';
    END IF;

    IF p_ativo THEN
        INSERT INTO "PapelPermissao" (papel_id, permissao_id)
        VALUES (p_papel_id, p_permissao_id)
        ON CONFLICT DO NOTHING;
    ELSE
        DELETE FROM "PapelPermissao"
        WHERE papel_id = p_papel_id
          AND permissao_id = p_permissao_id;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION hub_papel_permissao_set(int, int, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION hub_papel_permissao_set(int, int, boolean) TO authenticated;

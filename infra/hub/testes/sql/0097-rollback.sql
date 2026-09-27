-- ROLLBACK da 0097 (papel financeiro_aprovador + trava de papel restrito em
-- UsuarioEntidade). tasks.md 2.3.1/2.3.2.
--
-- Recusa (RAISE EXCEPTION, mensagem clara, ERRCODE 42501) se existir vínculo
-- ATIVO com financeiro_aprovador — remover o papel derrubaria o acesso de
-- quem já foi promovido. A checagem roda ANTES de qualquer DROP/DELETE
-- (nenhum efeito colateral quando recusa). Sem ela, o mesmo cenário ainda
-- falharia via FK (UsuarioEntidade.papel_id -> Papel.id) ao tentar
-- `DELETE FROM "Papel"`, mas com uma mensagem genérica de constraint em vez
-- do motivo de negócio.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM "UsuarioEntidade" ue
        JOIN "Papel" p ON p.id = ue.papel_id
        WHERE p.nome = 'financeiro_aprovador' AND ue.ativo = true
    ) THEN
        RAISE EXCEPTION 'rollback 0097 recusado: existe vinculo ATIVO com o papel financeiro_aprovador -- desative-o (ou promova para outro papel) antes de reverter'
            USING ERRCODE = '42501';
    END IF;
END $$;

-- Políticas de UsuarioEntidade voltam ao corpo vigente da 0039 (sem a
-- condição de papel restrito) — precisa rodar ANTES do DROP FUNCTION
-- abaixo (as policies de 0097 referenciam hub_papel_restrito; Postgres
-- recusaria dropar a função enquanto uma policy depender dela).
DROP POLICY IF EXISTS usuarioentidade_insert_admin ON "UsuarioEntidade";
CREATE POLICY usuarioentidade_insert_admin ON "UsuarioEntidade"
    FOR INSERT
    WITH CHECK (
        hub_jwt_admin_plataforma()
        OR empresa_id = ANY (hub_jwt_escopo_ids())
    );

DROP POLICY IF EXISTS usuarioentidade_update_admin ON "UsuarioEntidade";
CREATE POLICY usuarioentidade_update_admin ON "UsuarioEntidade"
    FOR UPDATE
    USING (
        hub_jwt_admin_plataforma()
        OR empresa_id = ANY (hub_jwt_escopo_ids())
    )
    WITH CHECK (
        hub_jwt_admin_plataforma()
        OR empresa_id = ANY (hub_jwt_escopo_ids())
    );

-- Devolve o GRANT INSERT, UPDATE de 0003:58 nas quatro tabelas da matriz.
GRANT INSERT, UPDATE ON "Papel", "PapelPermissao", "Permissao", "Modulo" TO authenticated;

-- Remove as permissões do papel novo e o papel em si (ordem: FK
-- PapelPermissao.papel_id -> Papel.id primeiro).
DELETE FROM "PapelPermissao"
WHERE papel_id = (SELECT id FROM "Papel" WHERE nome = 'financeiro_aprovador');

DELETE FROM "Papel" WHERE nome = 'financeiro_aprovador';

-- Helper hub_papel_restrito: só depois das policies acima já não usarem mais.
DROP FUNCTION IF EXISTS hub_papel_restrito(int);

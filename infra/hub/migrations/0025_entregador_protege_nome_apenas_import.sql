-- 0025 — Entregador: restringe a proteção de nome editado manualmente
-- SOMENTE à sobrescrita vinda da reimportação S4 (hub-motoristas, tasks.md
-- 8.2.4, block-004/dec-048). Decisão do operador (2026-07-08, resposta ao
-- bloqueio block-004): a reedição manual pelo próprio operador deve SEMPRE
-- ser permitida, quantas vezes forem necessárias — o PATCH /motoristas/:id
-- já re-carimba nome_editado_manualmente=true a cada edição
-- (routes/hub-motoristas.js, lib/hub-motoristas-dto.js#validarPatchMotorista).
--
-- O trigger trg_entregador_protege_nome (migration 0019) bloqueava
-- INCONDICIONALMENTE qualquer UPDATE de `nome` assim que
-- nome_editado_manualmente=true — inclusive um 2º/3º PATCH manual do
-- próprio operador (achado da tarefa 4.1, reconfirmado empiricamente no
-- Cenário 4 do quickstart, que só exercitava 1 edição seguida de
-- reimportação — nunca uma 2ª edição manual).
--
-- Mecanismo: distinguir o CAMINHO de origem do UPDATE (pipeline de
-- reimportação S4 vs PATCH manual do operador) via claim JWT
-- `origem_importacao`. PostgREST expõe as claims do JWT como o GUC
-- `request.jwt.claims` — mesmo mecanismo já usado por `hub_boot_recovery`
-- (migration 0018) para distinguir o job de recuperação de boot de uma
-- requisição de usuário comum. A claim `origem_importacao` só é emitida por
-- lib/hub-import-processor.js#upsertEntregadoresDoLote (nunca pelo handler
-- de PATCH manual em routes/hub-motoristas.js) — ver
-- lib/hub-postgrest-jwt.js.
--
-- Comportamento resultante:
--   (a) PATCH manual (sem a claim) -> SEMPRE atualiza `nome`, mesmo que
--       nome_editado_manualmente já seja true (reedição indefinida).
--   (b) Reimportação S4 (com a claim) sobre um Entregador com
--       nome_editado_manualmente=true -> nome protegido (NEW.nome reverte
--       para OLD.nome), como antes.
--   (c) Reimportação S4 sobre um Entregador com
--       nome_editado_manualmente=false -> nome é atualizado normalmente
--       (inalterado por esta migration — a condição já exigia
--       OLD.nome_editado_manualmente antes).
--
-- Idempotente (CREATE OR REPLACE FUNCTION); expand-only (Constitution) —
-- nenhuma coluna/tabela é alterada, só a função do trigger 0019 é
-- substituída (o próprio trigger, criado em 0019, continua apontando para
-- esta função por nome — não precisa de novo CREATE TRIGGER). Aplicada por
-- migrate.sh só no hub_homolog_db (nunca em chatmasterveloz/produção
-- legada).

CREATE OR REPLACE FUNCTION hub_jwt_origem_importacao()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE((hub_jwt_claims() ->> 'origem_importacao')::boolean, false);
$$;

CREATE OR REPLACE FUNCTION hub_protege_nome_editado_entregador()
RETURNS trigger AS $$
BEGIN
    -- Só protege contra sobrescrita vinda do pipeline de reimportação (S4,
    -- claim origem_importacao=true) — qualquer outro caller (PATCH manual
    -- do operador, sem a claim) sempre pode alterar o nome, mesmo que
    -- nome_editado_manualmente já esteja true (decisão do operador,
    -- block-004/dec-048: reedição manual sem limite).
    IF OLD.nome_editado_manualmente AND hub_jwt_origem_importacao() THEN
        NEW.nome := OLD.nome;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

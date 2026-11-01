-- 0123 — sincroniza "ContaMotorista" (hub) <-> "Motorista" (legado) NO BANCO. Ponte ate o login do app migrar
-- para o hub (o gate HUB_MOTORISTA_LOGIN_CONTA_ATIVA segue DESLIGADO em producao: o login ainda le "Motorista").
--
-- POR QUE (frente motorista-cadastro-hub, decisao do operador 2026-10-31): a credencial criada no hub nao entrava
-- no app (o espelho em codigo fazia PATCH que afetava 0 linhas e devolvia "ok"), desativar no hub nao bloqueava o
-- login, e a troca de CNPJ so chegava a um dos lados. Cinco arquivos JS, duas RPCs SQL e psql manual escrevem
-- nessas tabelas: so o banco cobre todos. Atomico: ou as duas tabelas mudam ou nenhuma.
--
-- ACOPLAMENTO INVISIVEL (o integrador deve registra-lo no CLAUDE.md, secao das migrations do hub). Um UPDATE em uma das tabelas passa a escrever na outra.
--
-- QUATRO GATILHOS
--   G1 BEFORE INSERT em ContaMotorista: conta que nasce SEM senha ADOTA a do legado (e nasce inativa se o legado
--      esta inativo). Sem isto, o /register (grava a senha em "Motorista" e DEPOIS cria a conta sem senha pelo
--      vinculo automatico) teria a senha apagada pelo G2.
--   G2 AFTER INSERT/UPDATE em ContaMotorista -> legado. Em UPDATE, propaga so o campo que MUDOU (senha, ativo,
--      nome, CNPJ). NULL de senha so propaga em UPDATE explicito (o reset do hub), nunca em INSERT. Cria a linha
--      legada quando falta, com senha e CNPJ do grupo Movee.
--   G3 AFTER INSERT/UPDATE OF motorista_id em Entregador: o vinculo chega DEPOIS de a conta ser criada (outra
--      transacao); so entao o CNPJ e reconhecivel como Movee. Garante a linha legada.
--   G4 AFTER UPDATE em Motorista -> conta (TEMPORARIO: dropar quando /register e a troca de CNPJ deixarem de
--      escrever em "Motorista"). Nunca cria conta (quem cria e o vinculo do hub).
--
-- REGRAS
--   * Grupo Movee = empresa 6 + filiais (Grupo.id_empresa_pai = 6): a mesma de mesmoGrupoQue (routes/grupo.js).
--     So esse grupo ganha INSERT em "Motorista" (o app motorista e exclusivo dele) e so com senha.
--   * Anti-laco em duas camadas: GUC de transacao `hub.sync_motorista` ('conta'|'legado') e `IS DISTINCT FROM`
--     em todo UPDATE propagado.
--   * Colisao de UNIQUE de CNPJ ABORTA a escrita inteira (23505, fail-closed de proposito).
--   * Divergencia que ja existe (senha diferente, ativo divergente) NAO e resolvida aqui — ver a lista do gate.
--   * SECURITY DEFINER + search_path fixo: "Entregador" tem RLS por escopo e o legado escreve sem claim de
--     escopo. O dono da funcao deve ser o dono das tabelas (RLS nao vale para o dono sem FORCE).
--     NENHUM GRANT novo; REVOKE de PUBLIC nas funcoes.
--
-- Idempotente. Pre-requisitos: 0121 (alinha o passado) e 0122 (CNPJ de 14 digitos, `atualizado_em`).
-- ROLLBACK (nenhum dado e apagado): DROP TRIGGER trg_conta_adota_senha_legado, trg_conta_para_legado ON
--   "ContaMotorista"; DROP TRIGGER trg_entregador_vinculo_legado ON "Entregador"; DROP TRIGGER trg_legado_para_conta
--   ON "Motorista"; DROP FUNCTION hub_conta_adota_senha_legado(), hub_trg_conta_para_legado(),
--   hub_trg_entregador_vinculo_legado(), hub_trg_legado_para_conta(), hub_motorista_garante_legado(int),
--   hub_cnpj_do_grupo_movee(text), hub_empresas_grupo_movee();

-- empresas do grupo Movee, mesma regra de mesmoGrupoQue (Grupo/Empresa vivos, NAO a allowlist EmpresaGrupoMovee)
CREATE OR REPLACE FUNCTION hub_empresas_grupo_movee()
RETURNS SETOF bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $f$
    SELECT 6::bigint
    UNION
    SELECT e.id FROM "Empresa" e JOIN "Grupo" g ON g.id = e.id_grupo WHERE g.id_empresa_pai = 6
$f$;

-- o CNPJ e de motorista do grupo Movee? (vinculo de Entregador numa empresa do grupo OU movimento nelas; a
-- EnvioMassa guarda as duas grafias, e o IN usa o indice da 0094)
CREATE OR REPLACE FUNCTION hub_cnpj_do_grupo_movee(p_cnpj text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $f$
    SELECT EXISTS (SELECT 1 FROM "Entregador" e JOIN "ContaMotorista" cm ON cm.id = e.motorista_id
                    WHERE cm.cnpj_prestador = p_cnpj
                      AND e.id_empresa IN (SELECT hub_empresas_grupo_movee()))
        OR EXISTS (SELECT 1 FROM "EnvioMassa" em
                    WHERE em.cnpj_prestador IN (p_cnpj,
                              substr(p_cnpj, 1, 2) || '.' || substr(p_cnpj, 3, 3) || '.' || substr(p_cnpj, 6, 3) || '/' ||
                              substr(p_cnpj, 9, 4) || '-' || substr(p_cnpj, 13, 2))
                      AND em.id_empresa IN (SELECT hub_empresas_grupo_movee()))
$f$;

-- cria a linha legada quando falta: so com senha, CNPJ de 14 digitos e do grupo Movee. Nunca altera linha existente.
CREATE OR REPLACE FUNCTION hub_motorista_garante_legado(p_conta_id int)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $f$
DECLARE c record;
BEGIN
    SELECT cnpj_prestador, senha, ativo,
           nullif(nullif(btrim(nome), ''), '(sem nome)') AS nome
      INTO c FROM "ContaMotorista" WHERE id = p_conta_id;
    IF NOT FOUND OR c.senha IS NULL OR c.cnpj_prestador !~ '^[0-9]{14}$' THEN RETURN; END IF;
    IF EXISTS (SELECT 1 FROM "Motorista" WHERE cnpj_prestador = c.cnpj_prestador) THEN RETURN; END IF;
    IF NOT hub_cnpj_do_grupo_movee(c.cnpj_prestador) THEN RETURN; END IF;

    PERFORM set_config('hub.sync_motorista', 'conta', true);
    INSERT INTO "Motorista" (cnpj_prestador, senha, nome, ativo)
    VALUES (c.cnpj_prestador, c.senha, c.nome, c.ativo)
    ON CONFLICT (cnpj_prestador) DO NOTHING;
    PERFORM set_config('hub.sync_motorista', '', true);
END
$f$;

-- G1 ------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hub_conta_adota_senha_legado()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $f$
DECLARE m record;
BEGIN
    SELECT senha, ativo INTO m FROM "Motorista" WHERE cnpj_prestador = NEW.cnpj_prestador;
    IF FOUND THEN
        IF NEW.senha IS NULL THEN NEW.senha := m.senha; END IF;
        -- fail-closed: a conta nova nunca reativa quem o legado desativou
        IF NOT m.ativo THEN NEW.ativo := false; END IF;
    END IF;
    RETURN NEW;
END
$f$;

DROP TRIGGER IF EXISTS trg_conta_adota_senha_legado ON "ContaMotorista";
CREATE TRIGGER trg_conta_adota_senha_legado BEFORE INSERT ON "ContaMotorista"
    FOR EACH ROW EXECUTE FUNCTION hub_conta_adota_senha_legado();

-- G2 ------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hub_trg_conta_para_legado()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $f$
DECLARE v_nome text := nullif(nullif(btrim(NEW.nome), ''), '(sem nome)');
BEGIN
    IF current_setting('hub.sync_motorista', true) = 'legado' THEN RETURN NULL; END IF;

    IF TG_OP = 'UPDATE' THEN
        PERFORM set_config('hub.sync_motorista', 'conta', true);
        IF NEW.cnpj_prestador IS DISTINCT FROM OLD.cnpj_prestador THEN
            -- unique_violation propaga: a escrita inteira aborta (fail-closed)
            UPDATE "Motorista" SET cnpj_prestador = NEW.cnpj_prestador
             WHERE cnpj_prestador = OLD.cnpj_prestador;
        END IF;
        IF NEW.senha IS DISTINCT FROM OLD.senha THEN
            UPDATE "Motorista" SET senha = NEW.senha
             WHERE cnpj_prestador = NEW.cnpj_prestador AND senha IS DISTINCT FROM NEW.senha;
        END IF;
        IF NEW.ativo IS DISTINCT FROM OLD.ativo THEN
            UPDATE "Motorista" SET ativo = NEW.ativo
             WHERE cnpj_prestador = NEW.cnpj_prestador AND ativo IS DISTINCT FROM NEW.ativo;
        END IF;
        IF v_nome IS NOT NULL AND NEW.nome IS DISTINCT FROM OLD.nome THEN
            UPDATE "Motorista" SET nome = v_nome
             WHERE cnpj_prestador = NEW.cnpj_prestador AND nome IS DISTINCT FROM v_nome;
        END IF;
        PERFORM set_config('hub.sync_motorista', '', true);
    END IF;

    PERFORM hub_motorista_garante_legado(NEW.id);
    RETURN NULL;
END
$f$;

DROP TRIGGER IF EXISTS trg_conta_para_legado ON "ContaMotorista";
CREATE TRIGGER trg_conta_para_legado
    AFTER INSERT OR UPDATE OF senha, ativo, nome, cnpj_prestador ON "ContaMotorista"
    FOR EACH ROW EXECUTE FUNCTION hub_trg_conta_para_legado();

-- G3 ------------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hub_trg_entregador_vinculo_legado()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $f$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.motorista_id IS NOT DISTINCT FROM NEW.motorista_id THEN RETURN NULL; END IF;
    PERFORM hub_motorista_garante_legado(NEW.motorista_id);
    RETURN NULL;
END
$f$;

DROP TRIGGER IF EXISTS trg_entregador_vinculo_legado ON "Entregador";
CREATE TRIGGER trg_entregador_vinculo_legado
    AFTER INSERT OR UPDATE OF motorista_id ON "Entregador"
    FOR EACH ROW WHEN (NEW.motorista_id IS NOT NULL)
    EXECUTE FUNCTION hub_trg_entregador_vinculo_legado();

-- G4 (TEMPORARIO) -----------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hub_trg_legado_para_conta()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $f$
BEGIN
    IF current_setting('hub.sync_motorista', true) = 'conta' THEN RETURN NULL; END IF;

    PERFORM set_config('hub.sync_motorista', 'legado', true);
    IF NEW.cnpj_prestador IS DISTINCT FROM OLD.cnpj_prestador THEN
        -- unique_violation propaga (fail-closed)
        UPDATE "ContaMotorista" SET cnpj_prestador = NEW.cnpj_prestador
         WHERE cnpj_prestador = OLD.cnpj_prestador;
    END IF;
    -- so o campo que MUDOU (como o G2): uma divergencia antiga em outro campo nao e resolvida por tabela
    IF NEW.senha IS DISTINCT FROM OLD.senha THEN
        UPDATE "ContaMotorista" SET senha = NEW.senha
         WHERE cnpj_prestador = NEW.cnpj_prestador AND senha IS DISTINCT FROM NEW.senha;
    END IF;
    IF NEW.ativo IS DISTINCT FROM OLD.ativo THEN
        UPDATE "ContaMotorista" SET ativo = NEW.ativo
         WHERE cnpj_prestador = NEW.cnpj_prestador AND ativo IS DISTINCT FROM NEW.ativo;
    END IF;
    PERFORM set_config('hub.sync_motorista', '', true);
    RETURN NULL;
END
$f$;

DROP TRIGGER IF EXISTS trg_legado_para_conta ON "Motorista";
CREATE TRIGGER trg_legado_para_conta
    AFTER UPDATE OF senha, ativo, cnpj_prestador ON "Motorista"
    FOR EACH ROW EXECUTE FUNCTION hub_trg_legado_para_conta();

REVOKE ALL ON FUNCTION
    hub_empresas_grupo_movee(), hub_cnpj_do_grupo_movee(text), hub_motorista_garante_legado(int),
    hub_conta_adota_senha_legado(), hub_trg_conta_para_legado(), hub_trg_entregador_vinculo_legado(),
    hub_trg_legado_para_conta()
FROM PUBLIC;

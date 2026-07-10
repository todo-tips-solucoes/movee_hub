-- 0041 — D5 (decisão do operador, 2026-07-10): retenção de auditoria de
-- 12 MESES com expurgo MENSAL.
--
-- Desenho (preserva a imutabilidade em duas camadas da 0004):
--   (a) o trigger de imutabilidade ganha UMA exceção estreita e auditável:
--       DELETE passa somente quando a transação corrente setou o GUC
--       hub.expurgo_em_andamento='on' — e o ÚNICO ponto que o seta é
--       hub_auditoria_expurgo() abaixo. UPDATE continua bloqueado
--       incondicionalmente; DELETE manual (mesmo superuser via psql)
--       continua bloqueado como antes.
--   (b) hub_auditoria_expurgo(retencao) — SECURITY DEFINER (dono), SEM grant
--       a `authenticated` (nenhum caminho de API pode expurgar): apaga
--       eventos com criado_em anterior ao corte, registra um META-EVENTO
--       global ('auditoria_expurgo', com contagem/retenção/corte) na própria
--       trilha e retorna o número de linhas removidas. Retenção mínima de
--       1 mês (guarda contra chamada acidental com intervalo ínfimo).
--
-- Agendamento: hub-homolog → backup-daemon.sh (expurgo mensal SÓ após o
-- backup diário do dia ter sucesso — o dump retém os eventos expurgados);
-- produção → cron mensal do operador pós-cutover (RUNBOOK-CUTOVER.md §11).
--
-- Índice de suporte (criado_em) já existe desde a 0004. Idempotente
-- (CREATE OR REPLACE). search_path fixado na função (lição da 0040:
-- funções do hub são search_path-safe).

CREATE OR REPLACE FUNCTION hub_bloqueia_alteracao_auditoria()
RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE'
       AND current_setting('hub.expurgo_em_andamento', true) = 'on' THEN
        RETURN OLD;  -- exceção D5: só dentro de hub_auditoria_expurgo()
    END IF;
    RAISE EXCEPTION 'Auditoria e imutavel: UPDATE/DELETE bloqueados (FR-024; expurgo somente via hub_auditoria_expurgo — D5)';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION hub_auditoria_expurgo(p_retencao interval DEFAULT interval '12 months')
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    n bigint;
    corte timestamptz := now() - p_retencao;
BEGIN
    IF p_retencao < interval '1 month' THEN
        RAISE EXCEPTION 'hub_auditoria_expurgo: retencao minima de 1 mes (recebido %)', p_retencao;
    END IF;

    PERFORM set_config('hub.expurgo_em_andamento', 'on', true);  -- escopo: transação
    DELETE FROM "Auditoria" WHERE criado_em < corte;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM set_config('hub.expurgo_em_andamento', 'off', true);

    -- meta-auditoria: todo expurgo deixa rastro GLOBAL na própria trilha
    -- (SECURITY DEFINER/dono ignora RLS — policy de INSERT não se aplica aqui)
    INSERT INTO "Auditoria" (id_empresa, usuario_id, acao, recurso, detalhes)
    VALUES (NULL, NULL, 'auditoria_expurgo', 'Auditoria',
            jsonb_build_object('removidos', n,
                               'retencao', p_retencao::text,
                               'corte', corte));
    RETURN n;
END;
$$;

-- fail-closed: nenhum role de aplicação executa o expurgo; só o role de
-- manutenção (dono/superuser via psql — backup-daemon/cron do operador)
REVOKE ALL ON FUNCTION hub_auditoria_expurgo(interval) FROM PUBLIC;

-- 0060 — Enfileiramento automático de entregador novo + desfecho da
-- tentativa de enriquecimento (hub-enriquecimento-automatico, tasks.md
-- 2.1; data-model.md §Entregador/§EnriquecimentoAutomatico/§Trigger novo;
-- spec.md FR-001..FR-014).
--
-- ATENÇÃO — aplicada e provada SOMENTE no ambiente isolado `hub_homolog`
-- nesta entrega (dec-022/H1, `plan.md` §Fora de escopo). O gatilho criado
-- aqui não é ativado por si só: ele só passa a enfileirar depois de uma
-- linha em "EnriquecimentoAutomatico" com ativo=true (ato de runbook,
-- separado deste deploy, FR-013). O cutover em produção (chatmasterveloz)
-- fica condicionado à definição prévia do prazo de retenção/expurgo de
-- CPF/RG/CNH (dívida dec-038/`0057`) — ver tasks.md 2.3 e spec.md FR-013.
--
-- Duas colunas novas em "Entregador":
--   dados_entrego_desfecho — desfecho da última tentativa de
--     enriquecimento, 4 valores mutuamente exclusivos (FR-005/FR-006).
--   dados_entrego_solicitado_manual — origem do pedido pendente
--     (true=clique do operador, false=automático); discrimina a
--     prioridade de FR-011. Só tem significado enquanto
--     dados_entrego_solicitado_em IS NOT NULL.
--
-- Backfill: linhas já enriquecidas (dados_entrego_enriquecidos_em IS NOT
-- NULL) recebem desfecho='sucesso' — sem isso o campo mentiria (SC-002).
-- Loteado por lote de id (achado owasp-security M3): evita lock longo
-- numa tabela viva. Tentativas que FALHARAM antes desta feature não podem
-- ser reconstruídas (não existia coluna) e permanecem 'nunca-tentado' —
-- subnotificação honesta, aceita (research.md Decision 4).
--
-- Tabela nova "EnriquecimentoAutomatico": habilitação + teto por empresa
-- (FR-010/FR-012/FR-013). GRANT SELECT + RLS, SEM grant de escrita — ligar
-- é ato de banco (runbook), nunca de API (research.md Decision 9).
--
-- Índice parcial novo: idx_entregador_fila_enriquecimento, sobre o mesmo
-- predicado que o gatilho consulta para o teto e que o consumidor lê a
-- cada 5 min.
--
-- Gatilho novo: hub_entregador_enfileira_import(), BEFORE INSERT OR
-- UPDATE ... FOR EACH ROW (dec-017 — gatilho de linha, não de statement;
-- refutado empiricamente que ele não enxergaria as linhas irmãs do mesmo
-- INSERT — enxerga, via SPI/command counter, data-model.md §Evidência
-- empírica). SECURITY INVOKER declarado explicitamente + search_path
-- fixo (achado owasp-security L1). Só dispara para a claim
-- origem_importacao (emitida só por lib/hub-import-processor.js) — o
-- POST manual de motorista nunca enfileira.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS, CREATE TABLE/INDEX IF NOT
-- EXISTS, CREATE OR REPLACE FUNCTION, DROP TRIGGER IF EXISTS + CREATE
-- TRIGGER, DROP POLICY IF EXISTS + CREATE POLICY. Rodar duas vezes
-- seguidas produz 0 erro na segunda (tasks.md 2.1.9).

-- (1)/(2) Colunas novas em "Entregador".
ALTER TABLE "Entregador"
    ADD COLUMN IF NOT EXISTS dados_entrego_desfecho text NOT NULL DEFAULT 'nunca-tentado'
        CONSTRAINT entregador_dados_entrego_desfecho_check
        CHECK (dados_entrego_desfecho IN
               ('nunca-tentado', 'pessoa-nao-encontrada', 'outra-falha', 'sucesso')),
    ADD COLUMN IF NOT EXISTS dados_entrego_solicitado_manual boolean NOT NULL DEFAULT false;

-- (3) Backfill loteado: quem já foi enriquecido com sucesso não pode
-- continuar marcado 'nunca-tentado'. Idempotente por construção — a
-- segunda execução não encontra mais linhas a atualizar (WHERE já exclui
-- o que essa mesma migration corrigiu).
DO $$
DECLARE
    _lote  CONSTANT int := 5000;
    _linhas int;
BEGIN
    LOOP
        UPDATE "Entregador"
           SET dados_entrego_desfecho = 'sucesso'
         WHERE id IN (
             SELECT id
               FROM "Entregador"
              WHERE dados_entrego_enriquecidos_em IS NOT NULL
                AND dados_entrego_desfecho = 'nunca-tentado'
              LIMIT _lote
         );
        GET DIAGNOSTICS _linhas = ROW_COUNT;
        EXIT WHEN _linhas = 0;
    END LOOP;
END;
$$;

-- (4)/(5) Tabela nova de habilitação/teto por empresa.
CREATE TABLE IF NOT EXISTS "EnriquecimentoAutomatico" (
    empresa_id    int PRIMARY KEY,
    ativo         boolean NOT NULL DEFAULT false,
    teto          int NOT NULL DEFAULT 100 CHECK (teto > 0),
    desde         timestamptz NOT NULL DEFAULT now(),
    atualizado_em timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON "EnriquecimentoAutomatico" TO authenticated;

ALTER TABLE "EnriquecimentoAutomatico" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS enriquecimentoautomatico_select_por_escopo
    ON "EnriquecimentoAutomatico";
CREATE POLICY enriquecimentoautomatico_select_por_escopo
    ON "EnriquecimentoAutomatico"
    FOR SELECT
    USING (empresa_id = ANY (hub_jwt_escopo_ids()));

-- (6) Índice parcial — mesmo predicado consultado pelo gatilho (teto) e
-- pelo consumidor (leitura da fila a cada 5 min).
CREATE INDEX IF NOT EXISTS idx_entregador_fila_enriquecimento
    ON "Entregador" (id_empresa, dados_entrego_solicitado_em)
 WHERE dados_entrego_solicitado_em IS NOT NULL;

-- (7)/(8) Função + gatilho do enfileiramento automático.
CREATE OR REPLACE FUNCTION hub_entregador_enfileira_import()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
    cfg       record;
    pendentes int;
BEGIN
    -- (1) Só o pipeline de importação enfileira. A claim é assinada pelo
    -- backend (lib/hub-postgrest-jwt.js) e emitida exclusivamente por
    -- lib/hub-import-processor.js:341-344 — cliente nenhum a forja. O POST
    -- manual de motorista não a emite, então não enfileira.
    IF NOT hub_jwt_origem_importacao() THEN
        RETURN NEW;
    END IF;

    -- (2) Linha ainda virgem: nunca enfileirada, nunca enriquecida, nenhuma
    -- tentativa registrada. É o que impede reimportação de mexer em quem já
    -- está na fila, em quem já foi enriquecido ou em quem já falhou (FR-002).
    IF NEW.dados_entrego_solicitado_em     IS NOT NULL
       OR NEW.dados_entrego_enriquecidos_em IS NOT NULL
       OR NEW.dados_entrego_desfecho        <> 'nunca-tentado' THEN
        RETURN NEW;
    END IF;

    -- (3) Empresa habilitada (FR-012). Sem linha, ou com ativo=false, nada
    -- acontece — nega por padrão, e nenhum erro é emitido.
    SELECT teto, desde INTO cfg
      FROM "EnriquecimentoAutomatico"
     WHERE empresa_id = NEW.id_empresa
       AND ativo;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- (4) Recorte de retroatividade (FR-002): entregador que já existia antes
    -- de a empresa ser habilitada nunca é alcançado, nem pelo ramo de UPDATE.
    IF NEW.criado_em < cfg.desde THEN
        RETURN NEW;
    END IF;

    -- (5) Teto por empresa (FR-010). A contagem enxerga as linhas irmãs já
    -- processadas neste mesmo comando (ver data-model.md §Evidência
    -- empírica), então o corte é exato dentro de um lote — o excedente
    -- simplesmente não é carimbado, e volta a ser candidato na importação
    -- seguinte.
    SELECT count(*) INTO pendentes
      FROM "Entregador"
     WHERE id_empresa = NEW.id_empresa
       AND dados_entrego_solicitado_em IS NOT NULL;

    IF pendentes < cfg.teto THEN
        NEW.dados_entrego_solicitado_em := now();
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_entregador_enfileira_import ON "Entregador";
CREATE TRIGGER trg_entregador_enfileira_import
    BEFORE INSERT OR UPDATE ON "Entregador"
    FOR EACH ROW
    EXECUTE FUNCTION hub_entregador_enfileira_import();

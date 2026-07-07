-- 0017 — GRANT DELETE + policy RLS de DELETE em `ImportacaoLinhaErro`
-- (tasks.md FASE 5, task 5.5.2; research.md Decision 6/dec-010; contracts/
-- importacoes-api.md POST .../reprocessar). Idempotente.
--
-- CONTEXTO/CORREÇÃO: 0012/0015 documentavam `ImportacaoLinhaErro` como
-- "fato imutável, append-only" e por isso NÃO concediam DELETE/UPDATE — essa
-- decisão foi tomada ANTES do clarify de FASE 0 fechar o desenho de
-- reprocessamento. research.md Decision 6 (dec-010, score 3) e tasks.md 5.5.2
-- fixam o comportamento definitivo: reprocessar `failed`/`cancelled` REUSA o
-- MESMO `ImportacaoArquivo.id` (não cria um novo — colidiria com
-- `UNIQUE(id_empresa,tipo,hash_sha256)`), o que exige *limpar* os erros da
-- tentativa anterior antes de rodar de novo (senão o histórico de erros
-- acumularia entradas duplicadas/obsoletas de tentativas descartadas).
-- `FaturamentoLancamento`/`PerformanceTurno` continuam SEM DELETE — o reparse
-- do mesmo arquivo produz o MESMO `hash_linha`, e `ON CONFLICT ... DO NOTHING`
-- já torna reprocessar idempotente para os fatos sem precisar apagar nada.
--
-- Escopo do DELETE fica scoped por `importacao_id=eq.<id>` na query do
-- caller (routes/hub-importacoes.js) — a policy abaixo só garante que a
-- linha pertence à entidade correta (mesmo padrão das demais policies desta
-- tabela, 0015).

GRANT DELETE ON "ImportacaoLinhaErro" TO authenticated;

DROP POLICY IF EXISTS importacaolinhaerro_delete_por_escopo ON "ImportacaoLinhaErro";
CREATE POLICY importacaolinhaerro_delete_por_escopo ON "ImportacaoLinhaErro"
    FOR DELETE
    USING (id_empresa = ANY (hub_jwt_escopo_ids()));

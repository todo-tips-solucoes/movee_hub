-- 0024 — View agregada `hub_areas_por_entregador` (S5 / hub-motoristas, FASE
-- 3, tasks.md item emergente sob 3.1.2/3.2.1 — ver nota em tasks.md). Gap
-- identificado ao implementar GET /motoristas (lista): data-model.md só
-- descreve a agregação de áreas distintas para UM entregador_id por vez
-- (§Área de atuação, "Áreas distintas do detalhe"). A lista precisa da MESMA
-- agregação para VÁRIOS entregadores de uma vez (evitar N+1 query por linha
-- e evitar puxar as linhas de fato cruas para o Node). Idempotente
-- (CREATE OR REPLACE VIEW).
--
-- RLS: a view NÃO tem policy própria — Postgres aplica a RLS das tabelas
-- BASE ("FaturamentoLancamento"/"PerformanceTurno", já cobertas desde 0015)
-- de acordo com o role/sessão que EXECUTA a query (não o dono da view), já
-- que a view não é SECURITY DEFINER nem tem security_barrier especial —
-- comportamento padrão de view simples no Postgres. Validado empiricamente
-- via teste de integração (infra/hub/testes/hub-motoristas-integration.sh):
-- usuário escopado a uma id_empresa só enxerga áreas de Entregadores da
-- própria empresa ao consultar a view via PostgREST.

CREATE OR REPLACE VIEW hub_areas_por_entregador AS
SELECT entregador_id, subpraca, MAX(data) AS data_mais_recente
FROM (
    SELECT entregador_id, subpraca, data_referencia AS data
    FROM "FaturamentoLancamento" WHERE subpraca IS NOT NULL
    UNION ALL
    SELECT entregador_id, subpraca, data_periodo AS data
    FROM "PerformanceTurno" WHERE subpraca IS NOT NULL
) t
GROUP BY entregador_id, subpraca;

GRANT SELECT ON hub_areas_por_entregador TO authenticated;

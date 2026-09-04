-- 0058 — RPC hub_motoristas_candidatos_por_conta: casamento de nome na
-- direção INVERSA à 0023 (hub-motorista-360, tasks.md 2.2; research.md
-- Decision 12; data-model.md §Function hub_motoristas_candidatos_por_conta;
-- contracts/vinculo-automatico.md). Idempotente (CREATE OR REPLACE
-- FUNCTION). Aplicada por migrate.sh, que registra em "SchemaMigration" e
-- envia SIGUSR1 ao PostgREST.
--
-- Mesmo padrão exato de hub_motoristas_candidatos(p_entregador_id)
-- (migration 0023): SECURITY INVOKER (nao DEFINER) — roda com os
-- privilegios do role authenticated chamador, a RLS de "Entregador" (0010)
-- se aplica normalmente dentro da funcao, nenhum bypass de isolamento
-- multi-tenant. Elegibilidade de grupo (FR-010/FR-011) resolvida DENTRO da
-- funcao via JOIN "EmpresaGrupoMovee": entidade fora do grupo nunca chega
-- ao resultado (RLS + JOIN filtram para 0 linhas).
--
-- Direcao invertida (research.md Decision 12): parte de um
-- "ContaMotorista" (CNPJ recem-ativado no legado) e busca "Entregador"
-- candidatos SEM vinculo (motorista_id IS NULL) por similaridade de nome —
-- o hook automatico (FR-009) e o backfill (FR-012) partem de uma conta, nao
-- de um entregador, o oposto da 0023.
--
-- Piso de retorno desta funcao e 0.3 — o MESMO piso permissivo da 0023,
-- usado hoje so para SUGERIR candidatos a um humano escolher. O threshold
-- de decisao do vinculo AUTOMATICO (>= 0.9, exatamente 1 candidato) NAO
-- esta nesta funcao — e aplicado pela aplicacao chamadora (FASE 3, ainda
-- nao implementada nesta onda), exatamente como o proprio piso de 0.3 da
-- 0023 nunca decidiu vinculo sozinho. Nao confundir os dois numeros.

CREATE OR REPLACE FUNCTION hub_motoristas_candidatos_por_conta(p_conta_motorista_id int)
RETURNS TABLE (
    entregador_id int, nome text, id_empresa int, similaridade real
)
LANGUAGE sql STABLE SECURITY INVOKER AS $$
    WITH alvo AS (
        SELECT nome FROM "ContaMotorista" WHERE id = p_conta_motorista_id
    )
    SELECT e.id, e.nome, e.id_empresa,
           similarity(hub_normaliza_nome(e.nome), hub_normaliza_nome(alvo.nome))
    FROM alvo
    JOIN "Entregador" e ON e.motorista_id IS NULL
    JOIN "EmpresaGrupoMovee" g ON g.id_empresa = e.id_empresa
    WHERE similarity(hub_normaliza_nome(e.nome), hub_normaliza_nome(alvo.nome)) >= 0.3
    ORDER BY 4 DESC
    LIMIT 10;
$$;

GRANT EXECUTE ON FUNCTION hub_motoristas_candidatos_por_conta(int) TO authenticated;

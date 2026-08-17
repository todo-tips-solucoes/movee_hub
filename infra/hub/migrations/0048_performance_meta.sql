-- 0048 — Metas de performance por praça × turno (impeccable r24, parte 2).
--
-- Decisão do operador (2026-08-16): o que torna um número "ruim" na tela de
-- performance é estar abaixo de uma META CONTRATUAL, e essa meta varia por
-- praça E por turno — almoço e madrugada não se comparam, e cada praça tem
-- realidade própria. Editável pelo ADMIN DA ENTIDADE (cada empresa define as
-- suas), não só pela plataforma.
--
-- Três indicadores, os mesmos que a tela já exibe:
--   aceitacao         — corridas aceitas / ofertadas
--   conclusao         — corridas completadas / aceitas
--   tempo_disponivel  — % do turno em que o entregador esteve disponível
--
-- ⚠️ ARMADILHA DE UNIDADE, e ela é por fator 100. A API de performance NÃO usa
-- uma escala só (contracts/performance-api.md, research.md Decision 7):
--   - `taxaAceitacao`/`taxaConclusao` vêm como FRAÇÃO 0..1  ("0.8333")
--   - `tempoDisponivelMedio`/`tempoDisponivelPct` vêm em PERCENTUAL 0..100
--     ("87.42")
-- Aqui TODAS as metas são gravadas como FRAÇÃO 0..1, com CHECK que impede
-- gravar 90 no lugar de 0.9. Quem compara com `tempo_disponivel` divide o
-- valor da API por 100 ANTES — está assim em lib/hub-performance-meta.js e há
-- teste para isso. Guardar cada indicador na unidade da sua origem pareceria
-- mais "fiel" e seria a receita para somar laranja com maçã.
--
-- Escopo/RLS: mesmo padrão de 0006/0015 — `hub_jwt_escopo_ids()`, nega por
-- padrão quando a claim `escopo` está ausente.
--
-- DELETE é concedido de propósito, ao contrário de `Usuario`/`ModuloEntidade`
-- (onde "desativar é toggle, nunca DELETE" porque a linha é histórico). Uma
-- meta é CONFIGURAÇÃO: retirá-la significa "esta praça/turno não tem patamar
-- acordado", e um registro fantasma com `ativo=false` diria a mesma coisa
-- gastando uma coluna e um caso a mais em toda leitura. A troca fica na
-- trilha de auditoria, gravada pela rota.

CREATE TABLE IF NOT EXISTS "PerformanceMeta" (
    id             serial PRIMARY KEY,
    id_empresa     integer NOT NULL,
    praca          text    NOT NULL,
    periodo        text    NOT NULL,
    indicador      text    NOT NULL,
    valor          numeric(5,4) NOT NULL,
    criado_em      timestamptz NOT NULL DEFAULT now(),
    atualizado_em  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT performancemeta_indicador_chk
        CHECK (indicador IN ('aceitacao', 'conclusao', 'tempo_disponivel')),
    -- 0..1 e não 0..100: ver a armadilha de unidade no cabeçalho. Um `90`
    -- digitado onde se queria 90% quebra aqui, na fronteira, em vez de virar
    -- uma meta 100× maior que qualquer valor real e reprovar a operação
    -- inteira em silêncio.
    CONSTRAINT performancemeta_valor_chk CHECK (valor >= 0 AND valor <= 1)
);

-- Um patamar por cruzamento. O upsert da rota depende desta unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_performance_meta_cruzamento
    ON "PerformanceMeta" (id_empresa, praca, periodo, indicador);

-- Leitura da tela de performance: todas as metas da entidade de uma vez
-- (a comparação é por linha, então o cliente carrega o conjunto e casa).
CREATE INDEX IF NOT EXISTS idx_performance_meta_empresa
    ON "PerformanceMeta" (id_empresa);

ALTER TABLE "PerformanceMeta" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS performancemeta_select_por_escopo ON "PerformanceMeta";
CREATE POLICY performancemeta_select_por_escopo ON "PerformanceMeta"
    FOR SELECT
    USING (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS performancemeta_insert_por_escopo ON "PerformanceMeta";
CREATE POLICY performancemeta_insert_por_escopo ON "PerformanceMeta"
    FOR INSERT
    WITH CHECK (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS performancemeta_update_por_escopo ON "PerformanceMeta";
CREATE POLICY performancemeta_update_por_escopo ON "PerformanceMeta"
    FOR UPDATE
    USING (id_empresa = ANY (hub_jwt_escopo_ids()))
    WITH CHECK (id_empresa = ANY (hub_jwt_escopo_ids()));

DROP POLICY IF EXISTS performancemeta_delete_por_escopo ON "PerformanceMeta";
CREATE POLICY performancemeta_delete_por_escopo ON "PerformanceMeta"
    FOR DELETE
    USING (id_empresa = ANY (hub_jwt_escopo_ids()));

GRANT SELECT, INSERT, UPDATE, DELETE ON "PerformanceMeta" TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE "PerformanceMeta_id_seq" TO authenticated;

-- Permissão nova. O catálogo FIXO é o de PAPÉIS ("nenhum papel novo pode ser
-- criado", dec-008) — permissões novas por migration são prática estabelecida
-- desde 0016/0026/0044, e é o que este seed faz.
--
-- Concedida a `admin_plataforma` e `admin_entidade`: a decisão do operador é
-- que cada empresa define as próprias metas. `operador` e `leitura` não
-- recebem — ver a meta na tela de performance só exige
-- `performance.consultar`, que eles já têm.
INSERT INTO "Permissao" (codigo, modulo_id)
SELECT 'performance.metas_gerenciar', id FROM "Modulo" WHERE codigo = 'performance'
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p
CROSS JOIN "Permissao" perm
WHERE p.nome IN ('admin_plataforma', 'admin_entidade')
  AND perm.codigo = 'performance.metas_gerenciar'
ON CONFLICT DO NOTHING;

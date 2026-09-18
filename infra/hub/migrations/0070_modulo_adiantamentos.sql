-- 0070 — Módulo "Adiantamentos" (adiantamento pelo app do motorista): módulo,
-- 10 permissões, papel `financeiro`, concessões e versão 1 de
-- "AdiantamentoConfiguracao" — mesmo molde de 0062_modulo_avisos.sql
-- (que segue 0047_modulo_validacao_xml.sql:16-51), com um papel novo
-- (PLANO §12.8, data-model.md §Papel/§AdiantamentoConfiguracao).
--
-- Idempotente (ON CONFLICT DO NOTHING em tudo). Tabelas/funções de negócio
-- já existem (0066/0067/0069) — este arquivo só habilita RBAC/nav e semeia
-- a config inicial; as rotas do hub (backend/routes/hub-adiantamentos.js)
-- ainda não existem (FASE 3/4).

-- 1. Módulo (ordem 35 — Q-N15: "depois de Faturamento", que é ordem 30).
INSERT INTO "Modulo" (codigo, nome, ordem) VALUES
    ('adiantamentos', 'Adiantamentos', 35)
ON CONFLICT (codigo) DO NOTHING;

-- 2. As 10 permissões de catálogo do módulo (contracts/hub-api.md §Permissões
--    por rota; spec.md FR-045/FR-046).
INSERT INTO "Permissao" (codigo, modulo_id)
SELECT perm.codigo, m.id
FROM "Modulo" m, (VALUES
    ('adiantamentos.consultar'),
    ('adiantamentos.gerenciar'),
    ('adiantamentos.configurar'),
    ('adiantamentos.contas_consultar'),
    ('adiantamentos.contas_revisar'),
    ('adiantamentos.pagamentos_consultar'),
    ('adiantamentos.lote_criar'),
    ('adiantamentos.exportar'),
    ('adiantamentos.reprocessar'),
    ('adiantamentos.pagamento_confirmar')
) AS perm(codigo)
WHERE m.codigo = 'adiantamentos'
ON CONFLICT (codigo) DO NOTHING;

-- 3. Papel novo `financeiro` (escopo entidade, is_sistema — PLANO §12.8).
INSERT INTO "Papel" (nome, escopo, is_sistema) VALUES
    ('financeiro', 'entidade', true)
ON CONFLICT (nome) DO NOTHING;

-- 4. Concessão: só `financeiro`, `admin_plataforma` e `admin_entidade` — as
--    10 permissões inteiras (nenhum outro papel por padrão, fail-closed,
--    FR-046). `operador`/`leitura` NÃO recebem nada deste módulo.
INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p
CROSS JOIN "Permissao" perm
JOIN "Modulo" m ON m.id = perm.modulo_id AND m.codigo = 'adiantamentos'
WHERE p.nome IN ('financeiro', 'admin_plataforma', 'admin_entidade')
ON CONFLICT DO NOTHING;

-- 5. Habilitação por entidade: só a empresa 6 (grupo Movee — CLAUDE.md
--    §Regras de domínio; app motorista/adiantamento é exclusivo desse grupo).
INSERT INTO "ModuloEntidade" (modulo_id, empresa_id, ativo)
SELECT m.id, 6, true
FROM "Modulo" m
WHERE m.codigo = 'adiantamentos'
ON CONFLICT (modulo_id, empresa_id) DO NOTHING;

-- 6. Versão 1 de "AdiantamentoConfiguracao" (empresa 6) com os valores de
--    D-04 (janela seg–sáb 09:00–15:00), D-05 (taxa R$ 0,35), D-06/PLANO §299
--    (percentual 60%), D-21 (modelo da Descrição Pix) e Q-N2 (previsão de
--    pagamento). Os campos de Q-B2 (apuração) e Q-B3 (fonte/categorias da
--    produção) ficam NULOS — FR-025 exige que o módulo recuse solicitações
--    até o financeiro preenchê-los (ver hub_adiantamento_disponibilidade e
--    hub_adiantamento_solicitar em 0067, corrigida nesta onda — dec-053).
--    `criado_por` NULL: não há usuário humano nesta versão semeada.
INSERT INTO "AdiantamentoConfiguracao" (
    id_empresa, versao, timezone, dias_habilitados,
    horario_abertura, horario_corte, percentual, taxa_fixa,
    previsao_pagamento_texto, descricao_pix_modelo,
    criado_por, motivo
) VALUES (
    6, 1, 'America/Sao_Paulo', ARRAY[1,2,3,4,5,6]::smallint[],
    '09:00'::time, '15:00'::time, 60.00, 0.35,
    'entre 17h e 18h de hoje', 'Antecipação entregador mei {data_producao:DD.MM.AA}_{nome}',
    NULL, 'Versão inicial semeada pela migration 0070 (D-04/D-05/D-06/D-21/Q-N2). Fonte/categorias da produção (Q-B3) e janela de apuração semanal (Q-B2) pendentes — financeiro preenche no go-live (F12).'
)
ON CONFLICT (id_empresa, versao) DO NOTHING;

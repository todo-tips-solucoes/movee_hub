-- 0007 — Seed de papéis, permissões e módulos (data-model.md §Papel is_sistema,
-- FR-008; checklists/security.md CHK006/CHK027; tasks.md 1.5).
--
-- ATENÇÃO — PROPOSTA PENDENTE DE VALIDAÇÃO HUMANA (task 1.5.3 / CHK027):
-- a matriz papéis×permissões abaixo é uma PROPOSTA do agente, registrada como
-- bloqueio humano (bloqueios.sh) para o dono do produto aprovar/ajustar antes
-- da FASE 4 (RBAC/middleware que consome estes códigos de permissão). O seed
-- roda agora (idempotente) para permitir testar a MECÂNICA (schema, GRANTs,
-- PostgREST) — os dados aqui podem ser ajustados por uma migration corretiva
-- se o operador pedir mudança na composição papel→permissão.
--
-- Módulos: canônicos por spec.md FR-007 + data-model.md §Modulo (dashboard,
-- motoristas, faturamento, performance, importacoes, envio_massa, usuarios,
-- auditoria, admin) — NÃO o conjunto de tasks.md 1.5.1 ("atendimento, ..."),
-- que diverge do FR-007/data-model.md ratificados no /plan (reconciliação
-- dec-032; tasks.md 1.5.1 tem uma imprecisão de redação).

INSERT INTO "Modulo" (codigo, nome, ordem) VALUES
    ('dashboard',    'Painel Geral',          10),
    ('motoristas',   'Motoristas',            20),
    ('faturamento',  'Faturamento',           30),
    ('performance',  'Performance',           40),
    ('importacoes',  'Importações',           50),
    ('envio_massa',  'Envio em Massa',        60),
    ('usuarios',     'Gestão de Usuários',    70),
    ('auditoria',    'Auditoria',             80),
    ('admin',        'Administração',        90)
ON CONFLICT (codigo) DO NOTHING;

-- Permissões (formato modulo.acao — FR-007). Conjunto mínimo por módulo,
-- suficiente para os fluxos já previstos nesta fundação e nas próximas
-- (auditoria.consultar é referenciada literalmente por hub-me.js/4.3.2).
INSERT INTO "Permissao" (codigo, modulo_id)
SELECT v.codigo, m.id
FROM (VALUES
    ('dashboard.consultar',    'dashboard'),
    ('motoristas.consultar',   'motoristas'),
    ('motoristas.listar',      'motoristas'),
    ('motoristas.criar',       'motoristas'),
    ('motoristas.editar',      'motoristas'),
    ('motoristas.excluir',     'motoristas'),
    ('motoristas.importar',    'motoristas'),
    ('motoristas.exportar',    'motoristas'),
    ('faturamento.consultar',  'faturamento'),
    ('faturamento.exportar',   'faturamento'),
    ('performance.consultar',  'performance'),
    ('performance.exportar',   'performance'),
    ('importacoes.consultar',  'importacoes'),
    ('importacoes.criar',      'importacoes'),
    ('importacoes.importar',   'importacoes'),
    ('envio_massa.consultar',  'envio_massa'),
    ('envio_massa.criar',      'envio_massa'),
    ('envio_massa.enviar',     'envio_massa'),
    ('envio_massa.aprovar',    'envio_massa'),
    ('usuarios.consultar',     'usuarios'),
    ('usuarios.listar',        'usuarios'),
    ('usuarios.criar',         'usuarios'),
    ('usuarios.editar',        'usuarios'),
    ('usuarios.excluir',       'usuarios'),
    ('usuarios.gerenciar',     'usuarios'),
    ('auditoria.consultar',    'auditoria'),
    ('admin.gerenciar',        'admin')
) AS v(codigo, modulo_codigo)
JOIN "Modulo" m ON m.codigo = v.modulo_codigo
ON CONFLICT (codigo) DO NOTHING;

-- 4 papéis-seed obrigatórios (FR-008), todos is_sistema=true (protegidos de
-- exclusão acidental em S3+).
INSERT INTO "Papel" (nome, escopo, is_sistema) VALUES
    ('admin_plataforma', 'global',   true),
    ('admin_entidade',   'entidade', true),
    ('operador',         'entidade', true),
    ('leitura',          'entidade', true)
ON CONFLICT (nome) DO NOTHING;

-- admin_plataforma: TODAS as permissões (administração da plataforma inteira)
INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p CROSS JOIN "Permissao" perm
WHERE p.nome = 'admin_plataforma'
ON CONFLICT DO NOTHING;

-- admin_entidade: todas as permissões EXCETO administração da plataforma
-- (admin.gerenciar é exclusivo de admin_plataforma)
INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p CROSS JOIN "Permissao" perm
WHERE p.nome = 'admin_entidade'
  AND perm.codigo <> 'admin.gerenciar'
ON CONFLICT DO NOTHING;

-- operador: uso operacional do dia a dia — consulta/cria/edita/importa/envia,
-- SEM gestão de usuários, auditoria ou aprovação de envio em massa
INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p CROSS JOIN "Permissao" perm
WHERE p.nome = 'operador'
  AND perm.codigo IN (
    'dashboard.consultar',
    'motoristas.consultar', 'motoristas.listar', 'motoristas.criar',
    'motoristas.editar', 'motoristas.importar', 'motoristas.exportar',
    'faturamento.consultar',
    'performance.consultar',
    'importacoes.consultar', 'importacoes.criar', 'importacoes.importar',
    'envio_massa.consultar', 'envio_massa.criar', 'envio_massa.enviar'
  )
ON CONFLICT DO NOTHING;

-- leitura: apenas consulta, nenhuma escrita
INSERT INTO "PapelPermissao" (papel_id, permissao_id)
SELECT p.id, perm.id
FROM "Papel" p CROSS JOIN "Permissao" perm
WHERE p.nome = 'leitura'
  AND perm.codigo IN (
    'dashboard.consultar',
    'motoristas.consultar', 'motoristas.listar',
    'faturamento.consultar',
    'performance.consultar',
    'importacoes.consultar',
    'envio_massa.consultar'
  )
ON CONFLICT DO NOTHING;

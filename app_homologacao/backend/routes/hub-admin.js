// hub-auditoria-admin (S9) — routes/hub-admin.js
//
// GET /api/v1/admin/modulos, GET /api/v1/admin/entidades/:id/modulos,
// PUT /api/v1/admin/entidades/:id/modulos/:codigo. TODAS as rotas
// EXCLUSIVAS de admin_plataforma (FR-017/dec-009) — admin_entidade não tem
// acesso a NENHUMA rota deste router, nem leitura.
// Ref: docs/specs/hub-auditoria-admin/contracts/admin-modulos-api.md,
// spec.md FR-007/FR-008/FR-013/FR-017, tasks.md FASE 4.4.
//
// Arquivo 100% NOVO. `requireModuloAtivo('admin')` + `requirePermission(
// 'admin.gerenciar')` aplicados a TODAS as rotas — dupla barreira com a RLS
// de escrita/leitura ampliada de `ModuloEntidade` (migrations 0036/0036),
// exclusiva do claim `admin_plataforma`.
'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');

const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const {
  obterPermissoesEfetivasPorEntidade,
  usuarioEhAdminPlataforma,
  invalidarEntidadeModulos,
} = require('../lib/hub-rbac-cache');
const { requirePermission } = require('../middleware/hub-require-permission');
const { requireModuloAtivo } = require('../middleware/hub-require-modulo');
const { registrarAuditoria } = require('../lib/hub-auditoria');

const router = express.Router();

const CODIGO_MODULO_RE = /^[a-z0-9_]+$/;

// ────────────────────────────────────────────────────────────────────────────
// Helpers (mesmo padrão de routes/hub-usuarios.js/hub-papeis.js)
// ────────────────────────────────────────────────────────────────────────────

function decodificarAccessToken(accessToken) {
  if (!accessToken) return null;
  try {
    return jwt.verify(accessToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (_e) {
    return null;
  }
}

/**
 * Resolve payload+entidadeAtiva e EXIGE admin_plataforma (FR-017 —
 * "leitura E escrita exclusivas do admin_plataforma", diferente das demais
 * rotas hub: aqui não basta a permissão `admin.gerenciar` na entidade
 * ativa, o vínculo com o papel global precisa estar confirmado). Envia a
 * resposta de erro e retorna `null` em caso de falha (401/403); retorna o
 * contexto em caso de sucesso.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<{payload:object, entidadeAtiva:number}|null>}
 */
async function resolverContextoAdmin(req, res) {
  const accessToken = req.cookies && req.cookies.accessToken;
  const payload = decodificarAccessToken(accessToken);
  if (!payload || !payload.sub) {
    res.status(401).json({ erro: 'NAO_AUTENTICADO' });
    return null;
  }
  const entidadeAtiva = payload.entidade_ativa ? Number(payload.entidade_ativa) : null;
  if (!entidadeAtiva) {
    res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    return null;
  }
  const permsEntidade = await obterPermissoesEfetivasPorEntidade(payload.sub, entidadeAtiva);
  if (!permsEntidade.has('admin.gerenciar')) {
    res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    return null;
  }
  const isAdminPlataforma = await usuarioEhAdminPlataforma(payload.sub);
  if (!isAdminPlataforma) {
    // FR-017/dec-009: admin_entidade NUNCA acessa este router, mesmo que um
    // dia ganhasse `admin.gerenciar` por engano de seed — segunda barreira.
    res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    return null;
  }
  return { payload, entidadeAtiva };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /admin/modulos (task 4.4.2) — catálogo completo da plataforma
// ────────────────────────────────────────────────────────────────────────────

router.get('/modulos', requireModuloAtivo('admin'), requirePermission('admin.gerenciar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdmin(req, res);
    if (!ctx) return;

    // Modulo: catálogo global, sem RLS — GRANT SELECT já existe desde 0003.
    const modulos = await hubPostgrestRequest('Modulo?select=id,codigo,nome,ordem,ativo&order=ordem.asc');
    return res.status(200).json({
      modulos: (modulos || []).map((m) => ({ id: m.id, codigo: m.codigo, nome: m.nome, ordem: m.ordem, ativo: m.ativo })),
    });
  } catch (e) {
    console.error('[hub-admin] erro em GET /admin/modulos:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /admin/entidades/:id/modulos (task 4.4.3) — estado por entidade,
// QUALQUER entidade (visão global via claim admin_plataforma)
// ────────────────────────────────────────────────────────────────────────────

router.get('/entidades/:id/modulos', requireModuloAtivo('admin'), requirePermission('admin.gerenciar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdmin(req, res);
    if (!ctx) return;

    const entidadeIdParam = Number(req.params.id);
    if (!Number.isInteger(entidadeIdParam)) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }

    const empresas = await hubPostgrestRequest(`Empresa?id=eq.${entidadeIdParam}&select=id`);
    if (!empresas || empresas.length === 0) {
      return res.status(404).json({ erro: 'ENTIDADE_NAO_ENCONTRADA' });
    }

    const claims = { usuarioId: ctx.payload.sub, empresaAtiva: entidadeIdParam, escopo: [entidadeIdParam], adminPlataforma: true };
    const [catalogo, habilitados] = await Promise.all([
      hubPostgrestRequest('Modulo?select=id,codigo,nome,ordem,ativo&order=ordem.asc'),
      hubPostgrestRequest(`ModuloEntidade?empresa_id=eq.${entidadeIdParam}&select=modulo_id,ativo`, 'GET', null, claims),
    ]);

    // Módulo sem linha em ModuloEntidade = habilitado:false (deny by default,
    // contracts/admin-modulos-api.md).
    const habilitadoPorModuloId = new Map((habilitados || []).map((h) => [h.modulo_id, h.ativo]));

    return res.status(200).json({
      entidadeId: entidadeIdParam,
      modulos: (catalogo || [])
        .filter((m) => m.ativo)
        .map((m) => ({
          moduloId: m.id, codigo: m.codigo, nome: m.nome, habilitado: habilitadoPorModuloId.get(m.id) === true,
        })),
    });
  } catch (e) {
    console.error('[hub-admin] erro em GET /admin/entidades/:id/modulos:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// PUT /admin/entidades/:id/modulos/:codigo (task 4.4.4/4.4.5/4.4.6) — toggle
// via UPSERT (nunca DELETE), guard anti-lockout do módulo 'admin' na
// entidade ATIVA do próprio chamador
// ────────────────────────────────────────────────────────────────────────────

router.put(
  '/entidades/:id/modulos/:codigo',
  requireModuloAtivo('admin'),
  requirePermission('admin.gerenciar'),
  async (req, res) => {
    try {
      const ctx = await resolverContextoAdmin(req, res);
      if (!ctx) return;

      const entidadeIdParam = Number(req.params.id);
      const codigo = req.params.codigo;
      if (!Number.isInteger(entidadeIdParam) || typeof codigo !== 'string' || !CODIGO_MODULO_RE.test(codigo)) {
        return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
      }
      const { habilitado } = req.body || {};
      if (typeof habilitado !== 'boolean') {
        return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
      }

      const empresas = await hubPostgrestRequest(`Empresa?id=eq.${entidadeIdParam}&select=id`);
      if (!empresas || empresas.length === 0) {
        return res.status(404).json({ erro: 'ENTIDADE_NAO_ENCONTRADA' });
      }
      const modulos = await hubPostgrestRequest(`Modulo?codigo=eq.${encodeURIComponent(codigo)}&select=id,codigo`);
      if (!modulos || modulos.length === 0) {
        return res.status(404).json({ erro: 'MODULO_NAO_ENCONTRADO' });
      }
      const moduloId = modulos[0].id;

      // Guard anti-lockout (gate owasp, finding M3): desabilitar 'admin' na
      // PRÓPRIA entidade ativa do chamador travaria a recuperação exceto via
      // psql. Desabilitar 'admin' para OUTRAS entidades permanece permitido.
      if (codigo === 'admin' && habilitado === false && entidadeIdParam === ctx.entidadeAtiva) {
        return res.status(409).json({ erro: 'OPERACAO_BLOQUEADA' });
      }

      const claims = { usuarioId: ctx.payload.sub, empresaAtiva: entidadeIdParam, escopo: [entidadeIdParam], adminPlataforma: true };
      await hubPostgrestRequest(
        'ModuloEntidade?on_conflict=modulo_id,empresa_id',
        'POST',
        { modulo_id: moduloId, empresa_id: entidadeIdParam, ativo: habilitado },
        claims,
        { resolution: 'merge-duplicates' }
      );

      // Efeitos colaterais obrigatórios (contracts/admin-modulos-api.md):
      // (1) invalidarEntidadeModulos SÍNCRONO — próximo request de QUALQUER
      //     usuário da entidade já vê requireModuloAtivo responder 403
      //     MODULO_DESABILITADO, mesmo com sessão ativa (FR-008/SC-005);
      // (2) GET /me reflete de graça (consulta ModuloEntidade direto, sem
      //     cache próprio — nenhuma ação adicional necessária aqui);
      // (3) auditoria, id_empresa = ENTIDADE AFETADA (não a do chamador).
      invalidarEntidadeModulos(entidadeIdParam);

      await registrarAuditoria({
        idEmpresa: entidadeIdParam,
        usuarioId: ctx.payload.sub,
        acao: 'modulo_entidade_alterado',
        recurso: 'ModuloEntidade',
        recursoId: moduloId,
        detalhes: { codigo, habilitado },
        ip: req.ip,
        claims,
      });

      return res.status(200).json({ entidadeId: entidadeIdParam, codigo, habilitado });
    } catch (e) {
      console.error('[hub-admin] erro em PUT /admin/entidades/:id/modulos/:codigo:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
  }
);

module.exports = { router };

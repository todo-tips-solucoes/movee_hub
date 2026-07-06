// hub-fundacoes (FASE 4) — routes/hub-me.js
//
// GET /api/v1/me, POST /api/v1/me/entidade, GET /api/v1/auditoria.
// Ref: docs/specs/hub-fundacoes/contracts/rbac-me.md, contracts/auditoria.md,
// tasks.md FASE 4 (4.2/4.3), research.md Decisions 5/7/12/13.
//
// Arquivo 100% NOVO — nenhuma linha de server.js legado é editada (Decision 2).
// Exporta DOIS routers: `router` (montado em /api/v1/me) e `auditoriaRouter`
// (montado em /api/v1/auditoria) — mesma convenção de módulo único cobrindo
// mais de um path já usada em routes/branding.js (brandingTomadorRouter).
'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');

const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const { obterPermissoesEfetivas } = require('../lib/hub-rbac-cache');
const { registrarAuditoria } = require('../lib/hub-auditoria');
const { requirePermission } = require('../middleware/hub-require-permission');

const router = express.Router();
const auditoriaRouter = express.Router();

// ────────────────────────────────────────────────────────────────────────────
// Constantes / helpers (mesmo padrão de routes/hub-auth.js — cookie
// accessToken httpOnly/sameSite=strict/secure conforme ambiente)
// ────────────────────────────────────────────────────────────────────────────

const ACCESS_TOKEN_TTL = '15m';
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const AUDITORIA_LIMIT_DEFAULT = 50;
const AUDITORIA_LIMIT_MAX = 200;

function cookiesSaoSeguras() {
  return process.env.APP_ENV !== 'dev';
}

function decodificarAccessToken(accessToken) {
  if (!accessToken) return null;
  try {
    // Decision 12 — pinagem de algoritmo obrigatória em TODO jwt.verify do hub.
    return jwt.verify(accessToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (_e) {
    return null;
  }
}

function gerarAccessToken(payloadBase) {
  return jwt.sign(payloadBase, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_TTL });
}

function setAccessTokenCookie(res, accessToken) {
  res.cookie('accessToken', accessToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure: cookiesSaoSeguras(),
    maxAge: ACCESS_TOKEN_TTL_MS,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/me (task 4.2.2)
//
// Auth: accessToken válido — requirePermission NÃO se aplica aqui (qualquer
// usuário autenticado pode consultar o próprio perfil, contracts/rbac-me.md).
// ────────────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const accessToken = req.cookies && req.cookies.accessToken;
  const payload = decodificarAccessToken(accessToken);
  if (!payload || !payload.sub) {
    return res.status(401).json({ erro: 'NAO_AUTENTICADO' });
  }

  try {
    const usuarios = await hubPostgrestRequest(`Usuario?id=eq.${payload.sub}&select=id,email,nome,ativo`);
    if (!usuarios || usuarios.length === 0 || !usuarios[0].ativo) {
      return res.status(401).json({ erro: 'NAO_AUTENTICADO' });
    }
    const usuario = usuarios[0];

    const vinculos = await hubPostgrestRequest(
      `UsuarioEntidade?usuario_id=eq.${payload.sub}&ativo=eq.true&select=empresa_id,ativo,papel:Papel(nome)`
    );
    const entidades = (vinculos || []).map((v) => ({
      empresa_id: v.empresa_id,
      papel: v.papel ? v.papel.nome : null,
      ativo: v.ativo,
    }));

    // Edge Case (FR-013): se a entidade da claim não é mais um vínculo ATIVO
    // (perda de acesso concedida por um administrador enquanto a sessão
    // seguia aberta), degrada para null na resposta — reflete na próxima
    // consulta ao /me, sem exigir novo login.
    let entidadeAtiva = payload.entidade_ativa || null;
    if (entidadeAtiva && !entidades.some((e) => e.empresa_id === entidadeAtiva)) {
      entidadeAtiva = null;
    }

    const permissoesEfetivas = await obterPermissoesEfetivas(payload.sub);

    // contracts/rbac-me.md: "módulos habilitados para a entidade ativa
    // (ModuloEntidade.ativo=true) CRUZADOS com as permissões efetivas da
    // pessoa" — um módulo só aparece se, além de habilitado para a entidade,
    // a pessoa tiver PELO MENOS UMA permissão `<codigo_modulo>.<acao>` (evita
    // expor na navegação um módulo para o qual a pessoa não tem nenhuma ação
    // concedida, mesmo que o módulo esteja ativo para a entidade).
    let modulos = [];
    if (entidadeAtiva) {
      const modulosEntidade = await hubPostgrestRequest(
        `ModuloEntidade?empresa_id=eq.${entidadeAtiva}&ativo=eq.true&select=modulo:Modulo(codigo,nome,icone,ordem,ativo)`
      );
      const prefixosComPermissao = new Set(
        [...permissoesEfetivas].map((codigo) => codigo.split('.')[0])
      );
      modulos = (modulosEntidade || [])
        .map((m) => m.modulo)
        .filter((m) => m && m.ativo && prefixosComPermissao.has(m.codigo))
        .sort((a, b) => a.ordem - b.ordem);
    }

    return res.status(200).json({
      usuario: { id: usuario.id, email: usuario.email, nome: usuario.nome },
      entidades,
      entidade_ativa: entidadeAtiva,
      modulos,
      permissoes: Array.from(permissoesEfetivas),
    });
  } catch (e) {
    console.error('[hub-me] erro em GET /me:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/me/entidade (task 4.2.3) — troca de entidade ativa (FR-010/011)
// ────────────────────────────────────────────────────────────────────────────

router.post('/entidade', async (req, res) => {
  const ip = req.ip;
  const accessToken = req.cookies && req.cookies.accessToken;
  const payload = decodificarAccessToken(accessToken);
  if (!payload || !payload.sub) {
    return res.status(401).json({ erro: 'NAO_AUTENTICADO' });
  }

  try {
    const empresaIdBruto = req.body && req.body.empresa_id;
    const empresaId = Number(empresaIdBruto);
    if (empresaIdBruto === undefined || empresaIdBruto === null || !Number.isInteger(empresaId)) {
      return res.status(400).json({ erro: 'EMPRESA_ID_INVALIDO' });
    }

    // FR-011: recusa quando a pessoa não tem UsuarioEntidade ATIVO para o
    // empresa_id solicitado — resolvido server-side, nunca confiando no corpo
    // da requisição além do id a validar (Princípio II).
    const vinculos = await hubPostgrestRequest(
      `UsuarioEntidade?usuario_id=eq.${payload.sub}&empresa_id=eq.${empresaId}&ativo=eq.true&select=id,empresa_id`
    );
    if (!vinculos || vinculos.length === 0) {
      return res.status(403).json({ erro: 'SEM_VINCULO' });
    }

    // Reemite o accessToken com a claim de entidade ativa atualizada — sem
    // exigir novo login (FR-010). O JWT do PostgREST (Decision 3) passa a
    // carregar `empresa_ativa` = este valor a partir da próxima FASE (5.1).
    const novoAccessToken = gerarAccessToken({
      sub: payload.sub,
      email: payload.email,
      entidade_ativa: empresaId,
    });
    setAccessTokenCookie(res, novoAccessToken);

    await registrarAuditoria({
      usuarioId: payload.sub,
      idEmpresa: empresaId,
      acao: 'troca_entidade_ativa',
      recurso: 'UsuarioEntidade',
      recursoId: vinculos[0].id,
      ip,
    });

    return res.status(200).json({ entidade_ativa: empresaId });
  } catch (e) {
    console.error('[hub-me] erro em POST /me/entidade:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/auditoria (task 4.3.2) — protegido por requirePermission
// ────────────────────────────────────────────────────────────────────────────

auditoriaRouter.get('/', requirePermission('auditoria.consultar'), async (req, res) => {
  try {
    const accessToken = req.cookies && req.cookies.accessToken;
    const payload = decodificarAccessToken(accessToken);
    const entidadeAtiva = payload && payload.entidade_ativa ? Number(payload.entidade_ativa) : null;

    // contracts/auditoria.md: "Escopado pela entidade ativa da sessão... nunca
    // por id vindo do corpo/query do cliente". Sem entidade ativa selecionada
    // não há como escopar com segurança a consulta — postura nega-por-padrão
    // (mesmo espírito de FR-028): retorna lista vazia em vez de arriscar
    // vazamento cross-tenant, até que o cliente chame POST /me/entidade.
    if (!entidadeAtiva) {
      return res.status(200).json({ eventos: [] });
    }

    const filtros = [`id_empresa=eq.${entidadeAtiva}`];

    const { desde, ate, acao } = req.query;
    if (desde) filtros.push(`criado_em=gte.${encodeURIComponent(desde)}`);
    if (ate) filtros.push(`criado_em=lte.${encodeURIComponent(ate)}`);
    if (acao) filtros.push(`acao=eq.${encodeURIComponent(acao)}`);

    const limitParsed = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(limitParsed) && limitParsed > 0
      ? Math.min(limitParsed, AUDITORIA_LIMIT_MAX)
      : AUDITORIA_LIMIT_DEFAULT;

    filtros.push('order=criado_em.desc');
    filtros.push(`limit=${limit}`);
    filtros.push('select=id,id_empresa,usuario_id,acao,recurso,recurso_id,detalhes,ip,criado_em');

    const eventos = await hubPostgrestRequest(`Auditoria?${filtros.join('&')}`);
    return res.status(200).json({ eventos: eventos || [] });
  } catch (e) {
    console.error('[hub-me] erro em GET /auditoria:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

module.exports = {
  router,
  auditoriaRouter,
  // exportados para testes unitários
  decodificarAccessToken,
  gerarAccessToken,
};

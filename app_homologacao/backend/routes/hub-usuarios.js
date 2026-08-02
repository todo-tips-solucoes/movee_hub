// hub-auditoria-admin (S9) — routes/hub-usuarios.js
//
// GET/POST/PUT /api/v1/usuarios, POST/PUT /api/v1/usuarios/:id/vinculos.
// Ref: docs/specs/hub-auditoria-admin/contracts/usuarios-api.md, spec.md
// FR-009/FR-011, tasks.md FASE 4.2.
//
// Arquivo 100% NOVO — nenhuma linha de server.js legado é editada (mesmo
// padrão de routes/hub-faturamento.js/hub-motoristas.js). Todas as rotas sob
// requireModuloAtivo('usuarios') + requirePermission('usuarios.gerenciar') +
// checagem por-entidade (obterPermissoesEfetivasPorEntidade). Escopo:
// admin_entidade opera SOMENTE a entidade_ativa; admin_plataforma (claim)
// opera qualquer entidade.
'use strict';

const express = require('express');
const bcrypt = require('bcrypt');

const { decodificarAccessToken } = require('../lib/hub-access-token');
const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const {
  obterPermissoesEfetivasPorEntidade,
  usuarioEhAdminPlataforma,
  invalidarUsuario,
} = require('../lib/hub-rbac-cache');
const { requirePermission } = require('../middleware/hub-require-permission');
const { requireModuloAtivo } = require('../middleware/hub-require-modulo');
const { registrarAuditoria } = require('../lib/hub-auditoria');

const router = express.Router();

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ────────────────────────────────────────────────────────────────────────────
// Helpers puros (testáveis sem PostgREST real)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mesma regra de força de senha do painel (contracts/usuarios-api.md
 * "isStrongPassword, padrão do painel") —
 * app_homologacao/frontend_v2/app/register/page.tsx:60:
 * `v.length >= 6 && /[A-Z]/.test(v) && /\d/.test(v)`. Espelhada aqui
 * server-side (POST /usuarios e PUT /usuarios/:id nunca confiam só na
 * validação client-side).
 * @param {*} senha
 * @returns {boolean}
 */
function isStrongPassword(senha) {
  return typeof senha === 'string' && senha.length >= 6 && /[A-Z]/.test(senha) && /\d/.test(senha);
}

/**
 * Paginação de `GET /usuarios` (contracts/usuarios-api.md): `page` >= 1
 * default 1; `pageSize` 1..100 default 20. Mesmo padrão de
 * `parsePaginacaoAuditoria` em routes/hub-me.js. NUNCA lança.
 * @param {object} query
 * @returns {{page:number, pageSize:number}}
 */
function parsePaginacaoUsuarios(query) {
  const q = query || {};
  const pageParsed = parseInt(q.page, 10);
  const page = Number.isFinite(pageParsed) && pageParsed >= 1 ? pageParsed : 1;
  const pageSizeParsed = parseInt(q.pageSize, 10);
  const pageSize = Number.isFinite(pageSizeParsed) && pageSizeParsed >= 1
    ? Math.min(pageSizeParsed, PAGE_SIZE_MAX)
    : PAGE_SIZE_DEFAULT;
  return { page, pageSize };
}

/**
 * Resolve a entidade-ALVO da operação a partir de um parâmetro opcional
 * (`entidadeId` do query/body) — contracts/usuarios-api.md "SÓ
 * admin_plataforma pode divergir da ativa". `entidadeIdParam === null`
 * significa "não informado" -> usa a entidade ativa da sessão. Sem o claim
 * `admin_plataforma`, qualquer divergência responde 403 PERMISSAO_NEGADA e
 * retorna `undefined` (sentinela de erro já respondido — distinto de um
 * `entidadeId` válido, que é sempre um número).
 * @param {import('express').Response} res
 * @param {{entidadeAtiva:number, isAdminPlataforma:boolean}} ctx
 * @param {number|null} entidadeIdParam
 * @returns {number|undefined}
 */
function resolverEntidadeAlvo(res, ctx, entidadeIdParam) {
  if (entidadeIdParam === null) return ctx.entidadeAtiva;
  if (!ctx.isAdminPlataforma && entidadeIdParam !== ctx.entidadeAtiva) {
    res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    return undefined;
  }
  return entidadeIdParam;
}

/**
 * Resolve payload+entidadeAtiva+isAdminPlataforma do accessToken e confirma
 * que a ENTIDADE ATIVA concede `usuarios.gerenciar` (mesmo padrão de
 * routes/hub-faturamento.js#resolverContextoEntidade). Envia a resposta de
 * erro e retorna `null` em caso de falha (401/403); retorna o contexto em
 * caso de sucesso.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<{payload:object, entidadeAtiva:number,
 *   isAdminPlataforma:boolean}|null>}
 */
async function resolverContexto(req, res) {
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
  if (!permsEntidade.has('usuarios.gerenciar')) {
    res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    return null;
  }
  const isAdminPlataforma = await usuarioEhAdminPlataforma(payload.sub);
  return { payload, entidadeAtiva, isAdminPlataforma };
}

/**
 * Claims padrão de `hubPostgrestRequest` para uma operação escopada à
 * entidade `entidadeAlvo` — inclui `adminPlataforma` só quando verificado
 * no request corrente (nunca de input do cliente, gate owasp).
 * @param {{payload:object, isAdminPlataforma:boolean}} ctx
 * @param {number} entidadeAlvo
 * @returns {object}
 */
function montarClaims(ctx, entidadeAlvo) {
  const claims = { usuarioId: ctx.payload.sub, empresaAtiva: entidadeAlvo, escopo: [entidadeAlvo] };
  if (ctx.isAdminPlataforma) claims.adminPlataforma = true;
  return claims;
}

// ────────────────────────────────────────────────────────────────────────────
// GET /usuarios (task 4.2.2)
// ────────────────────────────────────────────────────────────────────────────

router.get('/', requireModuloAtivo('usuarios'), requirePermission('usuarios.gerenciar'), async (req, res) => {
  try {
    const ctx = await resolverContexto(req, res);
    if (!ctx) return;

    const entidadeIdBruto = req.query.entidadeId;
    let entidadeIdParam = null;
    if (entidadeIdBruto !== undefined && entidadeIdBruto !== '') {
      const parsed = Number(entidadeIdBruto);
      if (!Number.isInteger(parsed)) return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
      entidadeIdParam = parsed;
    }
    const entidadeAlvo = resolverEntidadeAlvo(res, ctx, entidadeIdParam);
    if (entidadeAlvo === undefined) return;

    const busca = typeof req.query.busca === 'string' ? req.query.busca.trim().toLowerCase() : '';
    const { page, pageSize } = parsePaginacaoUsuarios(req.query);

    const claims = montarClaims(ctx, entidadeAlvo);
    // UNIQUE(usuario_id, empresa_id) garante NO MÁXIMO 1 vínculo por pessoa
    // nesta entidade — a listagem abaixo é naturalmente 1 linha == 1 pessoa.
    const linhas = await hubPostgrestRequest(
      `UsuarioEntidade?empresa_id=eq.${entidadeAlvo}&select=id,ativo,papel:Papel(id,nome),usuario:Usuario(id,nome,email,ativo)`,
      'GET', null, claims
    );

    let usuarios = (linhas || [])
      .filter((v) => v && v.usuario)
      .map((v) => ({
        id: v.usuario.id,
        nome: v.usuario.nome,
        email: v.usuario.email,
        ativo: v.usuario.ativo,
        vinculo: {
          id: v.id,
          entidadeId: entidadeAlvo,
          papelId: v.papel ? v.papel.id : null,
          papel: v.papel ? v.papel.nome : null,
          ativo: v.ativo,
        },
      }));

    if (busca) {
      usuarios = usuarios.filter(
        (u) => (u.nome || '').toLowerCase().includes(busca) || (u.email || '').toLowerCase().includes(busca)
      );
    }
    usuarios.sort((a, b) => (a.nome || '').localeCompare(b.nome || ''));

    const total = usuarios.length;
    const from = (page - 1) * pageSize;
    const pagina = usuarios.slice(from, from + pageSize).map((u) => ({
      id: u.id, nome: u.nome, email: u.email, ativo: u.ativo, vinculos: [u.vinculo],
    }));

    return res.status(200).json({ usuarios: pagina, total, page, pageSize });
  } catch (e) {
    console.error('[hub-usuarios] erro em GET /usuarios:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /usuarios (task 4.2.3) — cria usuário + 1º vínculo em um passo (SC-008)
// ────────────────────────────────────────────────────────────────────────────

router.post('/', requireModuloAtivo('usuarios'), requirePermission('usuarios.gerenciar'), async (req, res) => {
  try {
    const ctx = await resolverContexto(req, res);
    if (!ctx) return;

    const { nome, email, senha, vinculo } = req.body || {};
    if (!nome || typeof nome !== 'string' || !nome.trim()) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }
    if (!email || typeof email !== 'string' || !EMAIL_RE.test(email)) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }
    if (!isStrongPassword(senha)) {
      return res.status(400).json({ erro: 'SENHA_FRACA' });
    }
    if (!vinculo || typeof vinculo !== 'object') {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }
    const entidadeIdParam = Number(vinculo.entidadeId);
    const papelIdParam = Number(vinculo.papelId);
    if (!Number.isInteger(entidadeIdParam) || !Number.isInteger(papelIdParam)) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }
    const entidadeAlvo = resolverEntidadeAlvo(res, ctx, entidadeIdParam);
    if (entidadeAlvo === undefined) return;

    // papelId existe no catálogo fixo? (dec-008 — Papel sem RLS, sem claims)
    const papeis = await hubPostgrestRequest(`Papel?id=eq.${papelIdParam}&select=id,nome`);
    if (!papeis || papeis.length === 0) {
      return res.status(400).json({ erro: 'PAPEL_NAO_ENCONTRADO' });
    }

    const emailNormalizado = email.trim();
    const existentes = await hubPostgrestRequest(`Usuario?email=eq.${encodeURIComponent(emailNormalizado)}&select=id`);
    if (existentes && existentes.length > 0) {
      return res.status(409).json({ erro: 'EMAIL_JA_CADASTRADO' });
    }

    const senhaHash = await bcrypt.hash(senha, 10);
    let criados;
    try {
      criados = await hubPostgrestRequest('Usuario', 'POST', {
        nome: nome.trim(), email: emailNormalizado, senha_hash: senhaHash, ativo: true,
      });
    } catch (e) {
      if (e.status === 409) return res.status(409).json({ erro: 'EMAIL_JA_CADASTRADO' });
      throw e;
    }
    const novoUsuario = criados && criados[0];
    if (!novoUsuario) {
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }

    const claims = montarClaims(ctx, entidadeAlvo);
    let novoVinculo;
    try {
      const vinculosCriados = await hubPostgrestRequest('UsuarioEntidade', 'POST', {
        usuario_id: novoUsuario.id, empresa_id: entidadeAlvo, papel_id: papelIdParam, ativo: true,
      }, claims);
      novoVinculo = vinculosCriados && vinculosCriados[0];
    } catch (e) {
      if (e.status === 409) return res.status(409).json({ erro: 'VINCULO_JA_EXISTE' });
      throw e;
    }

    invalidarUsuario(novoUsuario.id);

    // Auditoria: NUNCA senha/hash em `detalhes` (scrub por chave já cobre,
    // mas nem sequer incluímos aqui — defesa em profundidade). E-mail
    // também fica de fora de propósito (dec-029, scrubDetalhes por VALOR).
    await registrarAuditoria({
      idEmpresa: entidadeAlvo,
      usuarioId: ctx.payload.sub,
      acao: 'usuario_criado',
      recurso: 'Usuario',
      recursoId: novoUsuario.id,
      detalhes: { nome: nome.trim(), papelId: papelIdParam, papel: papeis[0].nome },
      ip: req.ip,
      claims,
    });

    return res.status(201).json({
      usuario: {
        id: novoUsuario.id,
        nome: novoUsuario.nome,
        email: novoUsuario.email,
        vinculos: novoVinculo
          ? [{ id: novoVinculo.id, entidadeId: entidadeAlvo, papelId: papelIdParam, papel: papeis[0].nome, ativo: true }]
          : [],
      },
    });
  } catch (e) {
    console.error('[hub-usuarios] erro em POST /usuarios:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// PUT /usuarios/:id (task 4.2.4) — edita nome/ativo/senha (CHK033: desativar
// é `ativo:false`, JAMAIS DELETE de linha)
// ────────────────────────────────────────────────────────────────────────────

router.put('/:id', requireModuloAtivo('usuarios'), requirePermission('usuarios.gerenciar'), async (req, res) => {
  try {
    const ctx = await resolverContexto(req, res);
    if (!ctx) return;

    const usuarioId = Number(req.params.id);
    if (!Number.isInteger(usuarioId)) return res.status(400).json({ erro: 'DADOS_INVALIDOS' });

    // Confirma vínculo VISÍVEL no escopo do chamador — 404 se fora do
    // escopo (não vaza existência cross-tenant, contracts/usuarios-api.md).
    const filtroEscopo = ctx.isAdminPlataforma ? '' : `&empresa_id=eq.${ctx.entidadeAtiva}`;
    const claimsLeitura = montarClaims(ctx, ctx.entidadeAtiva);
    const vinculosVisiveis = await hubPostgrestRequest(
      `UsuarioEntidade?usuario_id=eq.${usuarioId}${filtroEscopo}&select=id`,
      'GET', null, claimsLeitura
    );
    if (!vinculosVisiveis || vinculosVisiveis.length === 0) {
      return res.status(404).json({ erro: 'USUARIO_NAO_ENCONTRADO' });
    }

    const { nome, ativo, senha } = req.body || {};
    const patch = {};
    if (nome !== undefined) {
      if (typeof nome !== 'string' || !nome.trim()) return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
      patch.nome = nome.trim();
    }
    if (ativo !== undefined) {
      if (typeof ativo !== 'boolean') return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
      patch.ativo = ativo;
    }
    if (senha !== undefined) {
      if (!isStrongPassword(senha)) return res.status(400).json({ erro: 'SENHA_FRACA' });
      patch.senha_hash = await bcrypt.hash(senha, 10);
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }

    const atualizados = await hubPostgrestRequest(`Usuario?id=eq.${usuarioId}`, 'PATCH', patch);
    const usuarioAtualizado = atualizados && atualizados[0];
    if (!usuarioAtualizado) {
      return res.status(404).json({ erro: 'USUARIO_NAO_ENCONTRADO' });
    }

    invalidarUsuario(usuarioId);

    await registrarAuditoria({
      idEmpresa: ctx.entidadeAtiva,
      usuarioId: ctx.payload.sub,
      acao: 'usuario_editado',
      recurso: 'Usuario',
      recursoId: usuarioId,
      detalhes: { camposAlterados: Object.keys(patch).filter((k) => k !== 'senha_hash') },
      ip: req.ip,
      claims: claimsLeitura,
    });

    return res.status(200).json({
      usuario: {
        id: usuarioAtualizado.id, nome: usuarioAtualizado.nome, email: usuarioAtualizado.email, ativo: usuarioAtualizado.ativo,
      },
    });
  } catch (e) {
    console.error('[hub-usuarios] erro em PUT /usuarios/:id:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /usuarios/:id/vinculos (task 4.2.5) — novo vínculo a usuário existente
// ────────────────────────────────────────────────────────────────────────────

router.post('/:id/vinculos', requireModuloAtivo('usuarios'), requirePermission('usuarios.gerenciar'), async (req, res) => {
  try {
    const ctx = await resolverContexto(req, res);
    if (!ctx) return;

    const usuarioId = Number(req.params.id);
    if (!Number.isInteger(usuarioId)) return res.status(400).json({ erro: 'DADOS_INVALIDOS' });

    const { entidadeId, papelId } = req.body || {};
    const entidadeIdParam = Number(entidadeId);
    const papelIdParam = Number(papelId);
    if (!Number.isInteger(entidadeIdParam) || !Number.isInteger(papelIdParam)) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }
    const entidadeAlvo = resolverEntidadeAlvo(res, ctx, entidadeIdParam);
    if (entidadeAlvo === undefined) return;

    const papeis = await hubPostgrestRequest(`Papel?id=eq.${papelIdParam}&select=id,nome`);
    if (!papeis || papeis.length === 0) return res.status(400).json({ erro: 'PAPEL_NAO_ENCONTRADO' });

    const usuariosExistentes = await hubPostgrestRequest(`Usuario?id=eq.${usuarioId}&select=id`);
    if (!usuariosExistentes || usuariosExistentes.length === 0) {
      return res.status(404).json({ erro: 'USUARIO_NAO_ENCONTRADO' });
    }

    const claims = montarClaims(ctx, entidadeAlvo);
    const existentes = await hubPostgrestRequest(
      `UsuarioEntidade?usuario_id=eq.${usuarioId}&empresa_id=eq.${entidadeAlvo}&select=id`,
      'GET', null, claims
    );
    if (existentes && existentes.length > 0) {
      return res.status(409).json({ erro: 'VINCULO_JA_EXISTE' });
    }

    let novoVinculo;
    try {
      const criados = await hubPostgrestRequest('UsuarioEntidade', 'POST', {
        usuario_id: usuarioId, empresa_id: entidadeAlvo, papel_id: papelIdParam, ativo: true,
      }, claims);
      novoVinculo = criados && criados[0];
    } catch (e) {
      if (e.status === 409) return res.status(409).json({ erro: 'VINCULO_JA_EXISTE' });
      throw e;
    }

    invalidarUsuario(usuarioId);

    await registrarAuditoria({
      idEmpresa: entidadeAlvo,
      usuarioId: ctx.payload.sub,
      acao: 'usuario_vinculo_criado',
      recurso: 'UsuarioEntidade',
      recursoId: novoVinculo ? novoVinculo.id : null,
      detalhes: { usuarioAlvoId: usuarioId, papelId: papelIdParam, papel: papeis[0].nome },
      ip: req.ip,
      claims,
    });

    return res.status(201).json({
      vinculo: { id: novoVinculo.id, entidadeId: entidadeAlvo, papelId: papelIdParam, papel: papeis[0].nome, ativo: true },
    });
  } catch (e) {
    console.error('[hub-usuarios] erro em POST /usuarios/:id/vinculos:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// PUT /usuarios/:id/vinculos/:vinculoId (task 4.2.6) — troca papelId e/ou
// ativo (nunca DELETE — CHK033)
// ────────────────────────────────────────────────────────────────────────────

router.put('/:id/vinculos/:vinculoId', requireModuloAtivo('usuarios'), requirePermission('usuarios.gerenciar'), async (req, res) => {
  try {
    const ctx = await resolverContexto(req, res);
    if (!ctx) return;

    const usuarioId = Number(req.params.id);
    const vinculoId = Number(req.params.vinculoId);
    if (!Number.isInteger(usuarioId) || !Number.isInteger(vinculoId)) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }

    const { papelId, ativo } = req.body || {};
    const patch = {};
    let papelNome = null;
    if (papelId !== undefined) {
      const papelIdParam = Number(papelId);
      if (!Number.isInteger(papelIdParam)) return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
      const papeis = await hubPostgrestRequest(`Papel?id=eq.${papelIdParam}&select=id,nome`);
      if (!papeis || papeis.length === 0) return res.status(400).json({ erro: 'PAPEL_NAO_ENCONTRADO' });
      patch.papel_id = papelIdParam;
      papelNome = papeis[0].nome;
    }
    if (ativo !== undefined) {
      if (typeof ativo !== 'boolean') return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
      patch.ativo = ativo;
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }

    // Localiza o vínculo DENTRO do escopo do chamador (nunca cross-tenant).
    const filtroEscopo = ctx.isAdminPlataforma ? '' : `&empresa_id=eq.${ctx.entidadeAtiva}`;
    const claimsLeitura = montarClaims(ctx, ctx.entidadeAtiva);
    const vinculosVisiveis = await hubPostgrestRequest(
      `UsuarioEntidade?id=eq.${vinculoId}&usuario_id=eq.${usuarioId}${filtroEscopo}&select=id,empresa_id,ativo,papel_id`,
      'GET', null, claimsLeitura
    );
    if (!vinculosVisiveis || vinculosVisiveis.length === 0) {
      return res.status(404).json({ erro: 'USUARIO_NAO_ENCONTRADO' });
    }
    const vinculoAtual = vinculosVisiveis[0];

    const claims = montarClaims(ctx, vinculoAtual.empresa_id);
    const atualizados = await hubPostgrestRequest(`UsuarioEntidade?id=eq.${vinculoId}`, 'PATCH', patch, claims);
    const vinculoAtualizado = atualizados && atualizados[0];
    if (!vinculoAtualizado) {
      return res.status(404).json({ erro: 'USUARIO_NAO_ENCONTRADO' });
    }

    // FR-011/SC-004 — SÍNCRONO, antes da resposta (fecha o gap: invalidarUsuario
    // existe desde a S2 mas estava órfão até esta feature).
    invalidarUsuario(usuarioId);

    if (patch.papel_id !== undefined) {
      await registrarAuditoria({
        idEmpresa: vinculoAtual.empresa_id,
        usuarioId: ctx.payload.sub,
        acao: 'usuario_papel_alterado',
        recurso: 'UsuarioEntidade',
        recursoId: vinculoId,
        detalhes: {
          usuarioAlvoId: usuarioId, papelAnteriorId: vinculoAtual.papel_id, papelNovoId: patch.papel_id, papelNovo: papelNome,
        },
        ip: req.ip,
        claims,
      });
    }
    if (patch.ativo !== undefined) {
      await registrarAuditoria({
        idEmpresa: vinculoAtual.empresa_id,
        usuarioId: ctx.payload.sub,
        acao: 'usuario_vinculo_desativado',
        recurso: 'UsuarioEntidade',
        recursoId: vinculoId,
        detalhes: { usuarioAlvoId: usuarioId, ativo: patch.ativo },
        ip: req.ip,
        claims,
      });
    }

    return res.status(200).json({
      vinculo: {
        id: vinculoAtualizado.id, entidadeId: vinculoAtualizado.empresa_id, papelId: vinculoAtualizado.papel_id, ativo: vinculoAtualizado.ativo,
      },
    });
  } catch (e) {
    console.error('[hub-usuarios] erro em PUT /usuarios/:id/vinculos/:vinculoId:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

module.exports = {
  router,
  // exportados para testes unitários
  isStrongPassword,
  parsePaginacaoUsuarios,
  resolverEntidadeAlvo,
};

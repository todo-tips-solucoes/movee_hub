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

const {
  decodificarAccessToken,
  lerAccessTokenDoRequest,
  COOKIE_ACCESS,
} = require('../lib/hub-access-token');
const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const {
  obterPermissoesEfetivas,
  obterPermissoesEfetivasPorEntidade,
  usuarioEhAdminPlataforma,
} = require('../lib/hub-rbac-cache');
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

// hub-auditoria-admin (S9) FASE 3.1 — contracts/auditoria-api.md "Query params"
const AUDITORIA_PAGE_SIZE_DEFAULT = 20;
const AUDITORIA_PAGE_SIZE_MAX = 100;
const VOCABULARIO_FECHADO_RE = /^[a-z0-9_]+$/;
const DATA_ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function cookiesSaoSeguras() {
  return process.env.APP_ENV !== 'dev';
}

function gerarAccessToken(payloadBase) {
  return jwt.sign(payloadBase, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: ACCESS_TOKEN_TTL });
}

function setAccessTokenCookie(res, accessToken) {
  res.cookie(COOKIE_ACCESS, accessToken, {
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
  const accessToken = lerAccessTokenDoRequest(req);
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

    // FASE 5 (0006_rls_policies.sql): UsuarioEntidade é escopada por
    // `usuario_id = claim.sub` (não por escopo/empresa_ativa) — listamos
    // TODOS os vínculos ativos da pessoa, não só o da entidade ativa.
    const vinculos = await hubPostgrestRequest(
      `UsuarioEntidade?usuario_id=eq.${payload.sub}&ativo=eq.true&select=empresa_id,ativo,papel:Papel(nome)`,
      'GET',
      null,
      { usuarioId: payload.sub }
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
      // FASE 5: ModuloEntidade é escopada por `empresa_id ∈ claim.escopo`
      // (research.md Decision 3/4) — passamos empresa_ativa/escopo = a
      // própria entidade selecionada.
      const modulosEntidade = await hubPostgrestRequest(
        `ModuloEntidade?empresa_id=eq.${entidadeAtiva}&ativo=eq.true&select=modulo:Modulo(codigo,nome,icone,ordem,ativo)`,
        'GET',
        null,
        { usuarioId: payload.sub, empresaAtiva: entidadeAtiva, escopo: [entidadeAtiva] }
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
  const accessToken = lerAccessTokenDoRequest(req);
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
    // FASE 5: UsuarioEntidade é escopada por `usuario_id = claim.sub`.
    const vinculos = await hubPostgrestRequest(
      `UsuarioEntidade?usuario_id=eq.${payload.sub}&empresa_id=eq.${empresaId}&ativo=eq.true&select=id,empresa_id`,
      'GET',
      null,
      { usuarioId: payload.sub }
    );
    if (!vinculos || vinculos.length === 0) {
      return res.status(403).json({ erro: 'SEM_VINCULO' });
    }

    // Reemite o accessToken com a claim de entidade ativa atualizada — sem
    // exigir novo login (FR-010). O JWT do PostgREST (Decision 3) carrega
    // `empresa_ativa`/`escopo` a partir desta FASE (5.1).
    const novoAccessToken = gerarAccessToken({
      sub: payload.sub,
      email: payload.email,
      entidade_ativa: empresaId,
    });
    setAccessTokenCookie(res, novoAccessToken);

    // A trilha de auditoria deste evento JÁ carrega id_empresa=empresaId
    // (Auditoria é coberta por RLS na FASE 5) — o vínculo acabou de ser
    // validado acima, então passamos a claim de escopo real para o INSERT
    // não ser negado pela policy nega-por-padrão (FR-028).
    await registrarAuditoria({
      usuarioId: payload.sub,
      idEmpresa: empresaId,
      acao: 'troca_entidade_ativa',
      recurso: 'UsuarioEntidade',
      recursoId: vinculos[0].id,
      ip,
      claims: { usuarioId: payload.sub, empresaAtiva: empresaId, escopo: [empresaId] },
    });

    return res.status(200).json({ entidade_ativa: empresaId });
  } catch (e) {
    console.error('[hub-me] erro em POST /me/entidade:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/auditoria — helpers puros (hub-auditoria-admin S9, FASE 3.1)
//
// Extraídos como funções puras/testáveis (mesmo padrão de
// routes/hub-faturamento.js#montarFiltrosQuery/parsePaginacao em
// lib/hub-faturamento-dto.js) — sem I/O, sem exceção, cobertos por
// tests/hub-me-auditoria-query-unit.test.js sem precisar de PostgREST real.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Valida + normaliza os query params de `GET /auditoria` (contracts/
 * auditoria-api.md "Query params" + hardening owasp finding M1/A05):
 * vocabulário fechado ANTES de compor a URL do PostgREST — `acao`/`recurso`
 * casam `^[a-z0-9_]+$`, `usuarioId`/`entidadeId` `Number.isInteger`,
 * `de`/`ate` ISO `YYYY-MM-DD`. `de > ate` -> `PERIODO_INVALIDO` (edge case da
 * spec). NUNCA lança — retorna `{ ok:false, erro }` em vez disso.
 * @param {object} query - `req.query`
 * @returns {{ok:true, acao:string|null, usuarioId:number|null,
 *   recurso:string|null, de:string|null, ate:string|null,
 *   entidadeId:number|null}|{ok:false, erro:string}}
 */
function parseFiltrosAuditoria(query) {
  const q = query || {};

  let acao = null;
  if (q.acao !== undefined && q.acao !== '') {
    if (typeof q.acao !== 'string' || !VOCABULARIO_FECHADO_RE.test(q.acao)) {
      return { ok: false, erro: 'PARAMETRO_INVALIDO' };
    }
    acao = q.acao;
  }

  let recurso = null;
  if (q.recurso !== undefined && q.recurso !== '') {
    if (typeof q.recurso !== 'string' || !VOCABULARIO_FECHADO_RE.test(q.recurso)) {
      return { ok: false, erro: 'PARAMETRO_INVALIDO' };
    }
    recurso = q.recurso;
  }

  let usuarioId = null;
  if (q.usuarioId !== undefined && q.usuarioId !== '') {
    const parsed = Number(q.usuarioId);
    if (!Number.isInteger(parsed)) {
      return { ok: false, erro: 'PARAMETRO_INVALIDO' };
    }
    usuarioId = parsed;
  }

  let entidadeId = null;
  if (q.entidadeId !== undefined && q.entidadeId !== '') {
    const parsed = Number(q.entidadeId);
    if (!Number.isInteger(parsed)) {
      return { ok: false, erro: 'PARAMETRO_INVALIDO' };
    }
    entidadeId = parsed;
  }

  let de = null;
  if (q.de !== undefined && q.de !== '') {
    if (typeof q.de !== 'string' || !DATA_ISO_RE.test(q.de)) {
      return { ok: false, erro: 'PARAMETRO_INVALIDO' };
    }
    de = q.de;
  }

  let ate = null;
  if (q.ate !== undefined && q.ate !== '') {
    if (typeof q.ate !== 'string' || !DATA_ISO_RE.test(q.ate)) {
      return { ok: false, erro: 'PARAMETRO_INVALIDO' };
    }
    ate = q.ate;
  }

  if (de && ate && de > ate) {
    return { ok: false, erro: 'PERIODO_INVALIDO' };
  }

  return { ok: true, acao, usuarioId, recurso, de, ate, entidadeId };
}

/**
 * Paginação de `GET /auditoria` (contracts/auditoria-api.md): `page` >= 1
 * default 1; `pageSize` 1..100 default 20. Mesmo padrão de
 * `parsePaginacao` em lib/hub-faturamento-dto.js. NUNCA lança.
 * @param {object} query - `req.query`
 * @returns {{page:number, pageSize:number, from:number, to:number}}
 */
function parsePaginacaoAuditoria(query) {
  const q = query || {};
  const pageParsed = parseInt(q.page, 10);
  const page = Number.isFinite(pageParsed) && pageParsed >= 1 ? pageParsed : 1;

  const pageSizeParsed = parseInt(q.pageSize, 10);
  const pageSize = Number.isFinite(pageSizeParsed) && pageSizeParsed >= 1
    ? Math.min(pageSizeParsed, AUDITORIA_PAGE_SIZE_MAX)
    : AUDITORIA_PAGE_SIZE_DEFAULT;

  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  return { page, pageSize, from, to };
}

/**
 * Filtros PostgREST COMUNS a `GET /auditoria`, independentes do escopo
 * (admin_entidade vs admin_plataforma — FASE 3.2). TODO valor passa por
 * `encodeURIComponent` (hardening owasp finding M1/A05) — nunca interpola
 * input bruto na query string do PostgREST.
 * @param {ReturnType<typeof parseFiltrosAuditoria>} f - já com `ok:true`
 * @returns {string[]}
 */
function montarFiltrosComunsAuditoria(f) {
  const filtros = [];
  if (f.acao) filtros.push(`acao=eq.${encodeURIComponent(f.acao)}`);
  if (f.recurso) filtros.push(`recurso=eq.${encodeURIComponent(f.recurso)}`);
  if (f.usuarioId !== null) filtros.push(`usuario_id=eq.${encodeURIComponent(f.usuarioId)}`);
  if (f.de) filtros.push(`criado_em=gte.${encodeURIComponent(`${f.de}T00:00:00.000Z`)}`);
  if (f.ate) filtros.push(`criado_em=lte.${encodeURIComponent(`${f.ate}T23:59:59.999Z`)}`);
  return filtros;
}

/**
 * Monta a cláusula de filtros PostgREST de `GET /auditoria` para o escopo
 * `admin_entidade` (sem claim `admin_plataforma`, FASE 3.2) — SEMPRE forçado
 * a `id_empresa=eq.<entidadeAtiva>`, independente de qualquer `entidadeId`
 * do query (o caller já rejeita com 403 antes de chegar aqui quando
 * `entidadeId` diverge — task 3.2.4).
 * @param {number} entidadeAtiva
 * @param {ReturnType<typeof parseFiltrosAuditoria>} f - já com `ok:true`
 * @returns {string[]}
 */
function montarFiltrosQueryAuditoria(entidadeAtiva, f) {
  return [`id_empresa=eq.${entidadeAtiva}`, ...montarFiltrosComunsAuditoria(f)];
}

/**
 * Monta a cláusula de filtros PostgREST de `GET /auditoria` para o escopo
 * `admin_plataforma` (com claim, FASE 3.2/US2): sem `entidadeId` no query,
 * NENHUM filtro de `id_empresa` é aplicado — vê todas as entidades +
 * eventos globais (`id_empresa IS NULL`), backstop pela RLS
 * (`hub_jwt_admin_plataforma()`, migration 0035); com `entidadeId`, filtra
 * só aquela entidade (qualquer uma — sem checagem de vínculo, visão global).
 * @param {ReturnType<typeof parseFiltrosAuditoria>} f - já com `ok:true`
 * @returns {string[]}
 */
function montarFiltrosQueryAuditoriaGlobal(f) {
  const filtros = f.entidadeId !== null ? [`id_empresa=eq.${f.entidadeId}`] : [];
  return [...filtros, ...montarFiltrosComunsAuditoria(f)];
}

/**
 * Mapper snake_case (PostgREST) -> camelCase (borda) de 1 evento de
 * auditoria (plan.md "Convenções de Borda" — sem ORM/auto-mapping, campo a
 * campo). `detalhes` já chega scrubbed do backend (FR-004/SC-006,
 * lib/hub-auditoria.js#scrubDetalhes) — este mapper NÃO re-serializa nada
 * sensível, só troca as chaves do envelope.
 * @param {object} row - linha crua do PostgREST (snake_case)
 * @returns {object} evento camelCase (contracts/auditoria-api.md "Response 200")
 */
function mapEventoAuditoria(row) {
  return {
    id: row.id,
    entidadeId: row.id_empresa,
    usuarioId: row.usuario_id,
    acao: row.acao,
    recurso: row.recurso,
    recursoId: row.recurso_id,
    detalhes: row.detalhes,
    ip: row.ip,
    criadoEm: row.criado_em,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/auditoria (task 4.3.2, evoluído FASE 3.1/3.2) — protegido por
// requirePermission
// ────────────────────────────────────────────────────────────────────────────

auditoriaRouter.get('/', requirePermission('auditoria.consultar'), async (req, res) => {
  try {
    const accessToken = lerAccessTokenDoRequest(req);
    const payload = decodificarAccessToken(accessToken);
    const entidadeAtiva = payload && payload.entidade_ativa ? Number(payload.entidade_ativa) : null;

    // contracts/auditoria-api.md: "Escopado pela entidade ativa da sessão...
    // nunca por id vindo do corpo/query do cliente". Sem entidade ativa
    // selecionada não há como escopar com segurança a consulta — postura
    // nega-por-padrão (mesmo espírito de FR-028): retorna lista vazia em vez
    // de arriscar vazamento cross-tenant, até que o cliente chame
    // POST /me/entidade. (FASE 3.3 preserva este comportamento.)
    if (!entidadeAtiva) {
      return res.status(200).json({ eventos: [], total: 0 });
    }

    // Correção pós-review PR #55 (achado #1 — leitura cross-tenant): o gate de
    // `requirePermission('auditoria.consultar')` acima valida contra a UNIÃO
    // achatada dos vínculos (barreira grossa: nega quem não tem a permissão em
    // NENHUMA entidade). Mas a consulta é escopada pela entidade ATIVA — então
    // é ESSA entidade que precisa conceder `auditoria.consultar`. Sem esta
    // segunda verificação, alguém com o grant só na empresa B leria a trilha da
    // empresa A ao ativá-la (onde tem apenas leitura). Verificação por-entidade
    // (mesma para admin_plataforma — sua PRÓPRIA linha de UsuarioEntidade na
    // entidade ativa já concede `auditoria.consultar`, contracts/auditoria-api.md):
    const permsEntidade = await obterPermissoesEfetivasPorEntidade(payload.sub, entidadeAtiva);
    if (!permsEntidade.has('auditoria.consultar')) {
      return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    }

    const f = parseFiltrosAuditoria(req.query);
    if (!f.ok) {
      return res.status(400).json({ erro: f.erro });
    }

    // FASE 3.2 — escopo por papel (contracts/auditoria-api.md "Escopo"):
    // resolvido no request corrente, nunca de input do cliente (gate owasp,
    // menor privilégio — lib/hub-postgrest-jwt.js#adminPlataforma).
    const isAdminPlataforma = await usuarioEhAdminPlataforma(payload.sub);

    if (!isAdminPlataforma && f.entidadeId !== null && f.entidadeId !== entidadeAtiva) {
      // 3.2.4 — admin_entidade tentando ver outra entidade -> nunca cross-tenant.
      return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    }

    const { page, pageSize, from, to } = parsePaginacaoAuditoria(req.query);

    // 3.2.3 — sem o claim: SEMPRE forçado à entidade ativa (ignora/rejeita
    // `entidadeId` divergente, já tratado acima). Com o claim: sem
    // `entidadeId` vê todas as entidades + eventos globais; com `entidadeId`
    // filtra só aquela entidade (US2).
    const filtros = isAdminPlataforma
      ? montarFiltrosQueryAuditoriaGlobal(f)
      : montarFiltrosQueryAuditoria(entidadeAtiva, f);
    filtros.push('order=criado_em.desc,id.desc');
    filtros.push('select=id,id_empresa,usuario_id,acao,recurso,recurso_id,detalhes,ip,criado_em');

    const claims = { usuarioId: payload.sub, empresaAtiva: entidadeAtiva, escopo: [entidadeAtiva] };
    // 3.2.5 — claim `admin_plataforma` SÓ emitida depois de `usuarioEhAdminPlataforma`
    // verificar o vínculo real no request corrente (defesa em profundidade:
    // habilita o backstop da RLS, migration 0035, além do filtro de aplicação acima).
    if (isAdminPlataforma) {
      claims.adminPlataforma = true;
    }

    // Página além do total -> `eventos: []`, 200 (nunca erro, tasks.md
    // 3.1.4) — comportamento natural do Range do PostgREST, sem caminho especial.
    const { data: linhas, total } = await hubPostgrestRequest(
      `Auditoria?${filtros.join('&')}`,
      'GET',
      null,
      claims,
      { count: true, range: { from, to } }
    );

    return res.status(200).json({
      eventos: (linhas || []).map(mapEventoAuditoria),
      total: total || 0,
      page,
      pageSize,
    });
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
  parseFiltrosAuditoria,
  parsePaginacaoAuditoria,
  montarFiltrosComunsAuditoria,
  montarFiltrosQueryAuditoria,
  montarFiltrosQueryAuditoriaGlobal,
  mapEventoAuditoria,
};

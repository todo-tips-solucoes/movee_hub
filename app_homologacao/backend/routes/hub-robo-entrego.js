// robo-entrego (tasks.md FASE 2, 2.1) — routes/hub-robo-entrego.js
//
// POST /api/v1/robo-entrego/eventos — endpoint de auditoria NOVO, proposto
// em docs/specs/robo-entrego/contracts/hub-api.md §POST
// /api/v1/robo-entrego/eventos. Fecha o gap de research.md Decision 9: FR-013
// exige registrar toda falha definitiva na auditoria do hub, mas não havia
// endpoint público de escrita em `Auditoria` (só `GET /api/v1/auditoria`,
// leitura, routes/hub-me.js).
//
// Auth: cookie hub_accessToken + permissão importacoes.criar (reusa a mesma
// permissão já concedida ao usuário de serviço — nenhuma permissão nova).
// Mesmo padrão de resolução de entidade_ativa de routes/hub-importacoes.js
// (dupla checagem: requirePermission no nível de rota = barreira grossa;
// obterPermissoesEfetivasPorEntidade dentro do handler = a entidade ATIVA
// precisa conceder o grant, não só a união achatada).
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const { decodificarAccessToken, lerAccessTokenDoRequest } = require('../lib/hub-access-token');
const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const { obterPermissoesEfetivasPorEntidade } = require('../lib/hub-rbac-cache');
const { registrarAuditoria } = require('../lib/hub-auditoria');
const { requirePermission } = require('../middleware/hub-require-permission');

// hub-motorista-360 FASE 5 (tasks.md 5.2) — fila de enriquecimento EntreGô
// consumida por infra/robo-entrego/ (contracts/entrego-enriquecimento.md §2).
// `robo_entrego_servico` (mesmo usuário de serviço do POST /eventos acima)
// autentica pelo MESMO cookie hub_accessToken — nenhum mecanismo de auth
// novo, só 2 permissões novas (`motoristas.enriquecimento.consultar`/
// `.atualizar`, script 003-permissoes-enriquecimento-robo-entrego.sql).

/** Só dígitos, do início ao fim (mesmo padrão de routes/hub-motoristas.js#idValido). */
function idValido(raw) {
  return typeof raw === 'string' && /^\d+$/.test(raw);
}

// Tamanho do lote por chamada — não é fato de negócio nem foi fixado por
// spec/research (research.md Decision 7 deixa só o throttle ENTRE motoristas
// como `[PROPOSTA]` quantificada, 60s, spec.md FR-016); default de
// engenharia, pequeno o bastante para não represar a fila atrás de UM motorista
// lento/antibot (mesmo espírito de POLL_TIMEOUT_MS_DEFAULT em hub-client.js).
const LOTE_ENRIQUECIMENTO_DEFAULT = 20;

// FR-016: seletor da rotina semestral — motorista nunca enriquecido
// (`dados_entrego_enriquecidos_em IS NULL`) não entra aqui por desenho: o
// comparador `lt.<agora-6meses>` do PostgREST nunca casa contra NULL (mesma
// nota já registrada em data-model.md §Entregador — "nunca buscado" segue
// gate de id_externo/pedido sob demanda, não desta rotina).
const SEIS_MESES_MS = 6 * 30 * 24 * 60 * 60 * 1000;

// Allowlist fechada (contracts/hub-api.md — gate owasp-security, achado
// MEDIUM, research.md Decision 9). Qualquer outro valor -> 422 INVALIDO.
const ACOES_PERMITIDAS = new Set([
  'robo_entrego.sucesso',
  'robo_entrego.falha_definitiva',
  'robo_entrego.suspeita_antibot',
  'robo_entrego.falha_configuracao',
]);

// Mesmo hardening recomendado em contracts/hub-api.md: reusa o
// authRateLimiter de routes/hub-auth.js (defesa barata contra uso indevido
// da credencial de serviço para flood de uma tabela imutável). Chave por
// usuário autenticado (não por IP+email — aqui não há campo `email` no
// corpo) para não travar outros usuários atrás do mesmo IP/proxy.
const roboEntregoRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const payload = decodificarAccessToken(lerAccessTokenDoRequest(req));
    return payload && payload.sub ? String(payload.sub) : req.ip;
  },
  handler: (_req, res) => {
    res.status(429).json({ erro: 'Muitas requisições. Tente novamente mais tarde.' });
  },
});

const router = express.Router();

router.post('/eventos', roboEntregoRateLimiter, requirePermission('importacoes.criar'), async (req, res) => {
  const payload = decodificarAccessToken(lerAccessTokenDoRequest(req));
  if (!payload || !payload.sub) {
    return res.status(401).json({ erro: 'NAO_AUTENTICADO' });
  }

  // id_empresa SEMPRE da claim de entidade ativa (Princípio II) — nunca do
  // corpo da requisição (mesmo padrão de hub-importacoes.js:224-227).
  const entidadeAtiva = payload.entidade_ativa ? Number(payload.entidade_ativa) : null;
  if (!entidadeAtiva) {
    return res.status(400).json({ erro: 'ENTIDADE_NAO_SELECIONADA' });
  }

  const { acao, detalhes } = req.body || {};
  if (typeof acao !== 'string' || !ACOES_PERMITIDAS.has(acao)) {
    return res.status(422).json({ erro: 'INVALIDO', motivo: 'acao fora da allowlist' });
  }

  try {
    // Correção de padrão (mesma de hub-importacoes.js, pós-review PR #55):
    // o requirePermission acima só valida a UNIÃO achatada de grants; como o
    // registro é escopado pela entidade ATIVA, é ESSA entidade que precisa
    // conceder importacoes.criar.
    const permsEntidade = await obterPermissoesEfetivasPorEntidade(payload.sub, entidadeAtiva);
    if (!permsEntidade.has('importacoes.criar')) {
      return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    }

    // registrarAuditoria já aplica scrubDetalhes internamente (lib/hub-auditoria.js)
    // — nenhuma credencial/token passa adiante mesmo se vier em `detalhes`.
    await registrarAuditoria({
      idEmpresa: entidadeAtiva,
      usuarioId: payload.sub,
      acao,
      recurso: 'RoboEntrego',
      detalhes: detalhes && typeof detalhes === 'object' ? detalhes : {},
      ip: req.ip,
      claims: { usuarioId: payload.sub, empresaAtiva: entidadeAtiva, escopo: [entidadeAtiva] },
    });

    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error('[hub-robo-entrego] erro em POST /robo-entrego/eventos:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /motoristas-para-enriquecer — fila consumida pelo worker (task 5.2.1)
// ────────────────────────────────────────────────────────────────────────────

router.get(
  '/motoristas-para-enriquecer',
  roboEntregoRateLimiter,
  requirePermission('motoristas.enriquecimento.consultar'),
  async (req, res) => {
    const payload = decodificarAccessToken(lerAccessTokenDoRequest(req));
    if (!payload || !payload.sub) {
      return res.status(401).json({ erro: 'NAO_AUTENTICADO' });
    }
    const entidadeAtiva = payload.entidade_ativa ? Number(payload.entidade_ativa) : null;
    if (!entidadeAtiva) {
      return res.status(400).json({ erro: 'ENTIDADE_NAO_SELECIONADA' });
    }

    const modo = req.query.modo;
    if (modo !== 'sob-demanda' && modo !== 'semestral') {
      return res.status(422).json({ erro: 'INVALIDO', motivo: 'modo deve ser sob-demanda ou semestral' });
    }

    try {
      const permsEntidade = await obterPermissoesEfetivasPorEntidade(payload.sub, entidadeAtiva);
      if (!permsEntidade.has('motoristas.enriquecimento.consultar')) {
        return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
      }

      // claims -> JWT do PostgREST -> RLS (entregador_select_por_escopo,
      // migration 0015) confina o SELECT a `id_empresa` da entidade ativa do
      // token de serviço automaticamente (contracts/entrego-enriquecimento.md
      // §2 — "nunca bypass de RLS"), mesmo mecanismo já usado em toda rota do
      // hub — nenhum filtro id_empresa explícito na querystring abaixo.
      const claims = { usuarioId: payload.sub, empresaAtiva: entidadeAtiva, escopo: [entidadeAtiva] };

      const filtro = modo === 'sob-demanda'
        ? 'dados_entrego_solicitado_em=not.is.null&order=dados_entrego_solicitado_em.asc'
        : `dados_entrego_enriquecidos_em=lt.${encodeURIComponent(new Date(Date.now() - SEIS_MESES_MS).toISOString())}&order=dados_entrego_enriquecidos_em.asc`;

      const linhas = await hubPostgrestRequest(
        `Entregador?${filtro}&select=id,id_externo&limit=${LOTE_ENRIQUECIMENTO_DEFAULT}`,
        'GET', null, claims
      );

      const items = (linhas || []).map((l) => ({ id: l.id, idExterno: l.id_externo }));
      return res.status(200).json({ items });
    } catch (e) {
      console.error('[hub-robo-entrego] erro em GET /robo-entrego/motoristas-para-enriquecer:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
  }
);

// ────────────────────────────────────────────────────────────────────────────
// PATCH /motoristas/:id/entrego-enriquecimento — grava o resultado (task 5.2.2)
// ────────────────────────────────────────────────────────────────────────────

router.patch(
  '/motoristas/:id/entrego-enriquecimento',
  roboEntregoRateLimiter,
  requirePermission('motoristas.enriquecimento.atualizar'),
  async (req, res) => {
    const payload = decodificarAccessToken(lerAccessTokenDoRequest(req));
    if (!payload || !payload.sub) {
      return res.status(401).json({ erro: 'NAO_AUTENTICADO' });
    }
    const entidadeAtiva = payload.entidade_ativa ? Number(payload.entidade_ativa) : null;
    if (!entidadeAtiva) {
      return res.status(400).json({ erro: 'ENTIDADE_NAO_SELECIONADA' });
    }
    if (!idValido(req.params.id)) {
      return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    }
    const id = parseInt(req.params.id, 10);

    const { sucesso, dados, motivoFalha, modo } = req.body || {};
    if (typeof sucesso !== 'boolean') {
      return res.status(422).json({ erro: 'INVALIDO', motivo: 'sucesso (boolean) é obrigatório' });
    }

    try {
      const permsEntidade = await obterPermissoesEfetivasPorEntidade(payload.sub, entidadeAtiva);
      if (!permsEntidade.has('motoristas.enriquecimento.atualizar')) {
        return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
      }

      const claims = { usuarioId: payload.sub, empresaAtiva: entidadeAtiva, escopo: [entidadeAtiva] };

      // FR-007 (quickstart Scenario 6): falha NUNCA descarta um
      // dados_entrego_json de uma busca anterior bem-sucedida — só limpa o
      // pedido pendente. Sucesso sobrescreve (FR-016 — sem versionamento).
      const patchBody = sucesso
        ? {
          dados_entrego_json: dados && typeof dados === 'object' ? dados : null,
          dados_entrego_enriquecidos_em: new Date().toISOString(),
          dados_entrego_solicitado_em: null,
        }
        : { dados_entrego_solicitado_em: null };

      // Verificação de linhas afetadas (contract §2 — "0 linhas afetadas
      // MUST responder 404, nunca 200/204 silencioso"): sem filtro
      // id_empresa explícito de propósito — é a RLS (escopo do token de
      // serviço) que decide se a linha existe/pertence; return=representation
      // (default de hubPostgrestRequest, `returnMinimal` NÃO passado) devolve
      // a linha afetada (ou array vazio) para essa checagem.
      const linhas = await hubPostgrestRequest(
        `Entregador?id=eq.${id}`,
        'PATCH', patchBody, claims
      );
      if (!linhas || linhas.length === 0) {
        return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
      }

      // detalhes NUNCA inclui `dados` (payload sensível) — só metadados de
      // execução (contract §2). scrubDetalhes() dentro de registrarAuditoria
      // é defesa adicional, não substitui esta disciplina.
      await registrarAuditoria({
        idEmpresa: entidadeAtiva,
        usuarioId: payload.sub,
        acao: sucesso ? 'motorista.entrego_enriquecido' : 'motorista.entrego_enriquecimento_falhou',
        recurso: 'Entregador',
        recursoId: id,
        detalhes: {
          modo: typeof modo === 'string' ? modo : undefined,
          motivoFalha: !sucesso && typeof motivoFalha === 'string' ? motivoFalha : undefined,
        },
        claims,
      });

      return res.status(200).json({ ok: true });
    } catch (e) {
      console.error('[hub-robo-entrego] erro em PATCH /robo-entrego/motoristas/:id/entrego-enriquecimento:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
  }
);

module.exports = { router, ACOES_PERMITIDAS };

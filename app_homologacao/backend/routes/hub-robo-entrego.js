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
const { obterPermissoesEfetivasPorEntidade } = require('../lib/hub-rbac-cache');
const { registrarAuditoria } = require('../lib/hub-auditoria');
const { requirePermission } = require('../middleware/hub-require-permission');

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

module.exports = { router, ACOES_PERMITIDAS };

/**
 * campanhas do motorista — routes/motorista-campanhas.js
 *
 * Rotas do APP (`/motorista/campanhas*`; o proxy do app expõe como `/api/motorista/...`).
 * Montado dentro do router `/motorista` COM `authenticateMotorista` (mesmo padrão de
 * routes/motorista-adiantamento.js), então `req.motorista.cnpjPrestador` já existe aqui.
 *
 * Identidade (Constitution II): NENHUM id de identidade (motorista, entregador, empresa) é lido de
 * corpo/query/parâmetro — só `req.motorista.cnpjPrestador` → claim `motoristaCnpj`; as RPCs resolvem
 * o entregador a partir dela. Os ids da URL são de campanha/prêmio, e a RPC confere a visibilidade.
 * O nome completo de terceiros nunca sai das RPCs do motorista (só "Aline R.").
 * Contrato: docs/plans/campanhas-motorista/CONTRATOS.md §6–§7.
 */

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const dto = require('../lib/campanha-dto');

const router = express.Router();

const INT4_MAX = 2147483647;
const idValido = (raw) => typeof raw === 'string' && /^\d{1,10}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= INT4_MAX;

// Leitura do app: 200/15 min por cnpj (a Início chama lista + detalhe + fotos).
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.motorista && req.motorista.cnpjPrestador) || req.ip,
  handler: (_req, res) => { res.status(429).json({ erro: 'LIMITE_EXCEDIDO' }); },
});

const claimsMotorista = (req) => ({ motoristaCnpj: req.motorista.cnpjPrestador });
const rpc = (nome, corpo, req) => hubPostgrestRequest(`rpc/${nome}`, 'POST', corpo, claimsMotorista(req));

/** Token de negócio da RPC → HTTP do contrato; infra → 502 INDISPONIVEL (nunca mascara regra de negócio). */
function responderErro(res, rotulo, e) {
  const m = dto.mapearErroRpc(e);
  if (m) return res.status(m.status).json({ erro: m.erro });
  console.error(`[motorista-campanhas] erro em ${rotulo}:`, e && e.message);
  return res.status(502).json({ erro: 'INDISPONIVEL' });
}

router.get('/campanhas', limiter, async (req, res) => {
  try {
    const itens = await rpc('hub_motorista_campanhas', {}, req);
    return res.status(200).json({ itens: dto.camelizar(Array.isArray(itens) ? itens : []) });
  } catch (e) {
    return responderErro(res, 'GET /campanhas', e);
  }
});

router.get('/campanhas/:id', limiter, async (req, res) => {
  if (!idValido(req.params.id)) return res.status(404).json({ erro: 'CAMPANHA_NAO_ENCONTRADA' });
  try {
    const r = await rpc('hub_motorista_campanha', { p_id: Number(req.params.id) }, req);
    if (!r) return res.status(404).json({ erro: 'CAMPANHA_NAO_ENCONTRADA' });
    return res.status(200).json(dto.camelizar(r));
  } catch (e) {
    return responderErro(res, 'GET /campanhas/:id', e);
  }
});

router.get('/campanhas/:id/premios/:premioId/foto', limiter, async (req, res) => {
  if (!idValido(req.params.id) || !idValido(req.params.premioId)) {
    return res.status(404).json({ erro: 'CAMPANHA_NAO_ENCONTRADA' });
  }
  try {
    const linhas = await rpc('hub_motorista_campanha_foto', { p_campanha_id: Number(req.params.id), p_premio_id: Number(req.params.premioId) }, req);
    return dto.enviarFoto(res, Array.isArray(linhas) ? linhas[0] : null);
  } catch (e) {
    return responderErro(res, 'GET /campanhas/:id/premios/:premioId/foto', e);
  }
});

module.exports = { router };

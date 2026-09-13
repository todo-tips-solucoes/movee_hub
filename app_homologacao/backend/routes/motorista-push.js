/**
 * push-motorista — routes/motorista-push.js (FASE 3, tasks.md 3.1)
 *
 * Rotas de push do app motorista: chave pública VAPID, inscrição/revogação/
 * estado do aparelho e leitura de um aviso pelo destinatário. Montado dentro
 * do router `/motorista` COM `authenticateMotorista` (mesmo padrão de
 * `brandingTomadorRouter`, `server.js:2820`) — `req.motorista.cnpjPrestador`
 * já está setado quando estas rotas rodam.
 *
 * Identidade (FR-003): `cnpj`/`cnpjPrestador`/`motoristaId`/`empresa` no
 * corpo ou na query são sempre ignorados — nenhum handler abaixo lê essas
 * chaves; a identidade usada nas RPCs vem exclusivamente de
 * `req.motorista.cnpjPrestador` (claim `motorista_cnpj`, gerada em
 * `lib/hub-postgrest-jwt.js`).
 *
 * Logs (FR-031): nunca o `endpoint` completo, nem `p256dh`/`auth` — só os 8
 * primeiros hex do `endpoint_hash`.
 *
 * Ref: contracts/motorista-push.md, data-model.md §Claims/§Funções
 * (migration 0061), tasks.md FASE 3.
 */

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const { validarInscricaoPush, validarEndpointUrl } = require('../lib/hub-push-endpoint');
const { getKeyAtual } = require('../lib/hub-push-vapid');
// FASE 5 (tasks.md 5.4) — extraído para lib/hub-push-log.js: hash/log
// seguro agora compartilhados com lib/hub-push-worker.js (mesma regra de
// redação, FR-031), em vez de duplicados.
const { endpointHash, logErro } = require('../lib/hub-push-log');

const router = express.Router();

const ESTADOS_VALIDOS = ['ativas', 'bloqueadas', 'ios_sem_instalacao', 'sem_suporte', 'nao_ativadas'];
const PLATAFORMAS_VALIDAS = ['android', 'ios', 'desktop_outros'];
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * FR-027: 30 requisições/15min por `cnpjPrestador`, somando inscrição,
 * revogação e estado. `keyGenerator` cai para `req.ip` só se o middleware
 * de auth não tiver rodado (nunca deveria acontecer nesta montagem).
 */
const pushLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.motorista && req.motorista.cnpjPrestador) || req.ip,
  handler: (_req, res) => {
    res.status(429).json({ erro: 'LIMITE_EXCEDIDO' });
  },
});

// GET /motorista/push/chave-publica
router.get('/push/chave-publica', (req, res) => {
  try {
    const { chavePublica, keyId } = getKeyAtual();
    res.json({ chavePublica, keyId });
  } catch (e) {
    res.status(503).json({ erro: 'PUSH_INDISPONIVEL' });
  }
});

// PUT /motorista/push/inscricao
router.put('/push/inscricao', pushLimiter, async (req, res) => {
  let chaveAtual;
  try {
    chaveAtual = getKeyAtual();
  } catch (e) {
    return res.status(503).json({ erro: 'PUSH_INDISPONIVEL' });
  }

  const corpo = (req.body && typeof req.body === 'object') ? req.body : {};
  const resultado = validarInscricaoPush(corpo);
  if (!resultado.ok) {
    if (resultado.erro === 'ENDPOINT_NAO_PERMITIDO') {
      return res.status(400).json({ erro: 'ENDPOINT_NAO_PERMITIDO' });
    }
    return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: resultado.motivo });
  }

  if (typeof corpo.keyId !== 'string' || corpo.keyId === '') {
    return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'keyId' });
  }
  if (!PLATAFORMAS_VALIDAS.includes(corpo.plataforma)) {
    return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'plataforma' });
  }
  if (typeof corpo.dispositivoId !== 'string' || !UUID_REGEX.test(corpo.dispositivoId)) {
    return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'dispositivoId' });
  }
  if (corpo.keyId !== chaveAtual.keyId) {
    return res.status(409).json({ erro: 'CHAVE_DESATUALIZADA' });
  }

  const hash = endpointHash(resultado.endpoint);
  try {
    await hubPostgrestRequest(
      'rpc/hub_push_inscricao_registrar',
      'POST',
      {
        p_endpoint: resultado.endpoint,
        p_endpoint_hash: hash,
        p_p256dh: resultado.p256dh,
        p_auth: resultado.auth,
        p_key_id: corpo.keyId,
        p_plataforma: corpo.plataforma,
        p_dispositivo_id: corpo.dispositivoId,
      },
      { motoristaCnpj: req.motorista.cnpjPrestador },
      { returnMinimal: true },
    );
    res.status(204).end();
  } catch (e) {
    logErro('falha ao registrar inscricao', e, hash);
    res.status(502).json({ erro: 'INDISPONIVEL' });
  }
});

// POST /motorista/push/inscricao/revogar
router.post('/push/inscricao/revogar', pushLimiter, async (req, res) => {
  const corpo = (req.body && typeof req.body === 'object') ? req.body : {};
  const endpointResult = validarEndpointUrl(corpo.endpoint);
  if (!endpointResult.ok) {
    return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'endpoint' });
  }
  if (typeof corpo.dispositivoId !== 'string' || !UUID_REGEX.test(corpo.dispositivoId)) {
    return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'dispositivoId' });
  }

  const hash = endpointHash(corpo.endpoint);
  try {
    await hubPostgrestRequest(
      'rpc/hub_push_inscricao_revogar',
      'POST',
      { p_endpoint_hash: hash, p_dispositivo_id: corpo.dispositivoId },
      { motoristaCnpj: req.motorista.cnpjPrestador },
      { returnMinimal: true },
    );
    res.status(204).end();
  } catch (e) {
    logErro('falha ao revogar inscricao', e, hash);
    res.status(502).json({ erro: 'INDISPONIVEL' });
  }
});

// PUT /motorista/push/estado
router.put('/push/estado', pushLimiter, async (req, res) => {
  const corpo = (req.body && typeof req.body === 'object') ? req.body : {};
  if (typeof corpo.dispositivoId !== 'string' || !UUID_REGEX.test(corpo.dispositivoId)) {
    return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'dispositivoId' });
  }
  if (!ESTADOS_VALIDOS.includes(corpo.estado)) {
    return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'estado' });
  }
  if (!PLATAFORMAS_VALIDAS.includes(corpo.plataforma)) {
    return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'plataforma' });
  }

  try {
    await hubPostgrestRequest(
      'rpc/hub_push_estado_reportar',
      'POST',
      { p_dispositivo_id: corpo.dispositivoId, p_estado: corpo.estado, p_plataforma: corpo.plataforma },
      { motoristaCnpj: req.motorista.cnpjPrestador },
      { returnMinimal: true },
    );
    res.status(204).end();
  } catch (e) {
    logErro('falha ao reportar estado', e, null);
    res.status(502).json({ erro: 'INDISPONIVEL' });
  }
});

// GET /motorista/avisos/:id
router.get('/avisos/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ erro: 'AVISO_NAO_DISPONIVEL' });
  }

  try {
    const linhas = await hubPostgrestRequest(
      'rpc/hub_aviso_para_motorista',
      'POST',
      { p_aviso_id: id },
      { motoristaCnpj: req.motorista.cnpjPrestador },
    );
    if (!Array.isArray(linhas) || linhas.length === 0) {
      return res.status(404).json({ erro: 'AVISO_NAO_DISPONIVEL' });
    }
    const aviso = linhas[0];
    res.json({
      id: aviso.id,
      titulo: aviso.titulo,
      corpo: aviso.corpo,
      enviadoEm: aviso.criado_em,
    });
  } catch (e) {
    logErro('falha ao buscar aviso', e, null);
    res.status(502).json({ erro: 'INDISPONIVEL' });
  }
});

module.exports = { router };

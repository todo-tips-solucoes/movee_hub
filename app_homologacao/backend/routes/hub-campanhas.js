/**
 * hub-campanhas — routes/hub-campanhas.js
 *
 * Campanhas do motorista (módulo `campanhas` do hub), montado em `/api/v1/hub/campanhas`.
 * Contrato: docs/plans/campanhas-motorista/CONTRATOS.md §5–§7.
 *
 * Cadeia por rota: requireModuloAtivo('campanhas') → requirePermission(...) → (rate limit de
 * escrita, por USUÁRIO) → reconferência da permissão NA ENTIDADE ATIVA do token. A entidade
 * vem SEMPRE do token (`entidade_ativa`), nunca do corpo/query (Constitution II); o corpo é
 * lido por whitelist em `lib/campanha-dto.js`, então um `idEmpresa` forjado é ignorado.
 * Toda regra de negócio (imutabilidade, teto, cálculo) mora nas RPCs; aqui só traduz.
 *
 * Corpo binário da foto: `express.raw` NA ROTA (o `express.json()` global de 100 KB roda antes
 * do router e não toca em image/*).
 */

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const { decodificarAccessToken, lerAccessTokenDoRequest } = require('../lib/hub-access-token');
const { requireModuloAtivo } = require('../middleware/hub-require-modulo');
const { requirePermission } = require('../middleware/hub-require-permission');
const { obterPermissoesEfetivasPorEntidade } = require('../lib/hub-rbac-cache');
const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const { registrarAuditoria } = require('../lib/hub-auditoria');
const { escaparCelulaCsvInjection, quotarCelulaCsv } = require('../lib/hub-csv');
const dto = require('../lib/campanha-dto');

const router = express.Router();

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const INT4_MAX = 2147483647;
const CSV_LOTE = 1000;
const CSV_MAX_LINHAS = 50000;

const idValido = (raw) => typeof raw === 'string' && /^\d{1,10}$/.test(raw) && Number(raw) >= 1 && Number(raw) <= INT4_MAX;

// Escrita: 60/15 min por USUÁRIO (nunca por IP: vários operadores atrás do mesmo NAT).
const escritaRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const payload = decodificarAccessToken(lerAccessTokenDoRequest(req));
    return payload && payload.sub ? String(payload.sub) : req.ip;
  },
  handler: (_req, res) => { res.status(429).json({ erro: 'LIMITE_EXCEDIDO' }); },
});

/** payload + entidade ativa + reconferência da permissão NA entidade. Responde o erro e devolve `null` se falhar. */
async function resolverContexto(req, res, permissao) {
  const payload = decodificarAccessToken(lerAccessTokenDoRequest(req));
  if (!payload || !payload.sub) {
    res.status(401).json({ erro: 'NAO_AUTENTICADO' });
    return null;
  }
  const entidadeAtiva = payload.entidade_ativa ? Number(payload.entidade_ativa) : null;
  if (!entidadeAtiva) {
    res.status(400).json({ erro: 'ENTIDADE_NAO_SELECIONADA' });
    return null;
  }
  const perms = await obterPermissoesEfetivasPorEntidade(payload.sub, entidadeAtiva);
  if (!perms.has(permissao)) {
    res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    return null;
  }
  const claims = { usuarioId: payload.sub, empresaAtiva: entidadeAtiva, escopo: [entidadeAtiva] };
  return { payload, entidadeAtiva, claims };
}

function responderErro(res, rotulo, e) {
  const m = dto.mapearErroRpc(e);
  if (m) return res.status(m.status).json(m.campo ? { erro: m.erro, campo: m.campo } : { erro: m.erro });
  console.error(`[hub-campanhas] erro em ${rotulo}:`, e && e.message);
  return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
}

/**
 * Monta a cadeia padrão de uma rota. `fn(ctx, req, res)` faz o trabalho; exceções viram HTTP.
 * `extras` = middlewares entre o rate limit e o handler (ex.: parser binário).
 */
function rota(rotulo, permissao, fn, { escrita = false, extras = [] } = {}) {
  return [
    requireModuloAtivo('campanhas'),
    requirePermission(permissao),
    ...(escrita ? [escritaRateLimiter] : []),
    ...extras,
    async (req, res) => {
      try {
        const ctx = await resolverContexto(req, res, permissao);
        if (!ctx) return undefined;
        return await fn(ctx, req, res);
      } catch (e) {
        return responderErro(res, rotulo, e);
      }
    },
  ];
}

const rpc = (nome, corpo, claims) => hubPostgrestRequest(`rpc/${nome}`, 'POST', corpo, claims);

function auditar(ctx, acao, recursoId, detalhes) {
  return registrarAuditoria({
    idEmpresa: ctx.entidadeAtiva,
    usuarioId: ctx.payload.sub,
    acao,
    recurso: 'Campanha',
    recursoId,
    detalhes: detalhes || {},
    claims: ctx.claims,
  });
}

const naoEncontrada = (res) => res.status(404).json({ erro: 'CAMPANHA_NAO_ENCONTRADA' });
const validacao = (res, campo, token = 'VALIDACAO') => res.status(422).json({ erro: token, campo });

function paginaDe(query) {
  const p = parseInt(query && query.pagina, 10);
  return Number.isInteger(p) && p >= 1 ? Math.min(p, 100000) : 1;
}

// ─── Opções do formulário ──────────────────────────────────────────────────
router.get('/opcoes', ...rota('GET /opcoes', 'campanhas.gerir', async (ctx, req, res) => {
  const listas = {};
  for (const k of ['pracas', 'turnos', 'modais']) {
    listas[k] = dto.lerListaQuery(req.query[k]);
    if (listas[k] === undefined) return validacao(res, k);
  }
  const r = await rpc('hub_campanha_opcoes', {
    p_id_empresa: ctx.entidadeAtiva, p_pracas: listas.pracas, p_turnos: listas.turnos, p_modais: listas.modais,
  }, ctx.claims);
  return res.status(200).json(dto.camelizar(r || {}));
}));

// ─── Categorias de faturamento (extrato) ───────────────────────────────────
// Declarada ANTES de `/:id` (e `categorias` não é um id válido de qualquer forma).
router.get('/categorias', ...rota('GET /categorias', 'campanhas.gerir', async (ctx, req, res) => {
  const linhas = await rpc('hub_campanha_categorias', {}, ctx.claims);
  return res.status(200).json({ itens: (linhas || []).map(dto.linhaCategoria) });
}));

// ─── Lista ─────────────────────────────────────────────────────────────────
router.get('/', ...rota('GET /', 'campanhas.consultar', async (ctx, req, res) => {
  const s = req.query.situacao;
  if (s !== undefined && !dto.SITUACOES_CAMPANHA.includes(s)) return validacao(res, 'situacao');
  const linhas = await rpc('hub_campanha_listar', { p_id_empresa: ctx.entidadeAtiva, p_situacao: s || null }, ctx.claims);
  return res.status(200).json({ itens: (linhas || []).map(dto.itemLista) });
}));

// ─── Criar / editar (rascunho) ─────────────────────────────────────────────
async function salvar(ctx, req, res, id) {
  const v = dto.validarFormulario(req.body);
  if (!v.ok) return validacao(res, v.campo, v.token);
  const novoId = await rpc('hub_campanha_salvar', { p_id_empresa: ctx.entidadeAtiva, p_id: id, p_dados: v.dados }, ctx.claims);
  const idFinal = Number(novoId);
  await auditar(ctx, id === null ? 'campanha.criada' : 'campanha.editada', idFinal, {
    nome: v.dados.nome, premios: v.dados.premios.length,
  });
  return res.status(id === null ? 201 : 200).json({ id: idFinal });
}

router.post('/', ...rota('POST /', 'campanhas.gerir', (ctx, req, res) => salvar(ctx, req, res, null), { escrita: true }));

router.put('/:id', ...rota('PUT /:id', 'campanhas.gerir', (ctx, req, res) => {
  if (!idValido(req.params.id)) return naoEncontrada(res);
  return salvar(ctx, req, res, Number(req.params.id));
}, { escrita: true }));

// ─── Transições ────────────────────────────────────────────────────────────
router.post('/:id/lancar', ...rota('POST /:id/lancar', 'campanhas.gerir', async (ctx, req, res) => {
  if (!idValido(req.params.id)) return naoEncontrada(res);
  if (!req.body || req.body.confirmo !== true) return res.status(422).json({ erro: 'CONFIRMACAO_AUSENTE' });
  const id = Number(req.params.id);
  await rpc('hub_campanha_lancar', { p_id: id }, ctx.claims);
  await auditar(ctx, 'campanha.lancada', id);
  return res.status(204).end();
}, { escrita: true }));

router.post('/:id/cancelar', ...rota('POST /:id/cancelar', 'campanhas.gerir', async (ctx, req, res) => {
  if (!idValido(req.params.id)) return naoEncontrada(res);
  const motivo = req.body && typeof req.body.motivo === 'string' ? req.body.motivo.trim() : '';
  if (Array.from(motivo).length < 5 || Array.from(motivo).length > 500) return validacao(res, 'motivo');
  const id = Number(req.params.id);
  await rpc('hub_campanha_cancelar', { p_id: id, p_motivo: motivo }, ctx.claims);
  await auditar(ctx, 'campanha.cancelada', id, { motivo });
  return res.status(204).end();
}, { escrita: true }));

// Interruptor de visibilidade no app (mutável mesmo depois de lançar; a RPC recusa cancelada e audita).
router.patch('/:id/visibilidade', ...rota('PATCH /:id/visibilidade', 'campanhas.gerir', async (ctx, req, res) => {
  if (!idValido(req.params.id)) return naoEncontrada(res);
  if (!req.body || typeof req.body.visivel !== 'boolean') return validacao(res, 'visivel');
  const id = Number(req.params.id);
  await rpc('hub_campanha_visibilidade', { p_id: id, p_visivel: req.body.visivel }, ctx.claims);
  return res.status(200).json({ id, visivelApp: req.body.visivel });
}, { escrita: true }));

router.delete('/:id', ...rota('DELETE /:id', 'campanhas.gerir', async (ctx, req, res) => {
  if (!idValido(req.params.id)) return naoEncontrada(res);
  const id = Number(req.params.id);
  const r = await rpc('hub_campanha_excluir', { p_id: id }, ctx.claims);
  await auditar(ctx, 'campanha.excluida', id, { id, nome: r && r.nome });
  return res.status(204).end();
}, { escrita: true }));

router.post('/:id/fechar', ...rota('POST /:id/fechar', 'campanhas.gerir', async (ctx, req, res) => {
  if (!idValido(req.params.id)) return naoEncontrada(res);
  const id = Number(req.params.id);
  await rpc('hub_campanha_fechar', { p_id: id }, ctx.claims);
  await auditar(ctx, 'campanha.fechada', id, { manual: true });
  return res.status(204).end();
}, { escrita: true }));

// ─── Detalhe ───────────────────────────────────────────────────────────────
router.get('/:id', ...rota('GET /:id', 'campanhas.consultar', async (ctx, req, res) => {
  if (!idValido(req.params.id)) return naoEncontrada(res);
  const r = await rpc('hub_campanha_detalhe', { p_id: Number(req.params.id) }, ctx.claims);
  if (!r) return naoEncontrada(res);
  return res.status(200).json(dto.detalhe(r));
}));

// ─── Ranking ───────────────────────────────────────────────────────────────
router.get('/:id/ranking', ...rota('GET /:id/ranking', 'campanhas.consultar', async (ctx, req, res) => {
  if (!idValido(req.params.id)) return naoEncontrada(res);
  const situacao = req.query.situacao === undefined ? 'classificado' : req.query.situacao;
  if (!dto.SITUACOES_RANKING.includes(situacao)) return validacao(res, 'situacao');
  const id = Number(req.params.id);
  const pagina = paginaDe(req.query);
  const [linhas, contagem] = await Promise.all([
    rpc('hub_campanha_ranking', {
      p_id: id, p_situacao: situacao, p_limite: dto.POR_PAGINA, p_offset: (pagina - 1) * dto.POR_PAGINA,
    }, ctx.claims),
    rpc('hub_campanha_ranking_contagem', { p_id: id }, ctx.claims),
  ]);
  return res.status(200).json({
    itens: (linhas || []).map(dto.linhaRanking),
    contagem: dto.camelizar(contagem || {}),
    pagina,
    porPagina: dto.POR_PAGINA,
  });
}));

const CSV_CABECALHO = [
  'Posição', 'Nome', 'Modal', 'Situação', 'Turnos', 'Aceitação', 'Conclusão', 'Tempo', 'Pedidos', 'Nota',
  'Nota hipotética', 'Posição hipotética', 'Motivo do corte', 'Posição anterior',
];
// Extrato: sem nota; turnos válidos e valor somado no lugar.
const CSV_CABECALHO_EXTRATO = [
  'Posição', 'Nome', 'Modal', 'Situação', 'Turnos válidos', 'Trabalhados', 'Valor somado', 'Posição anterior',
];
const brl = (c) => (c === null || c === undefined ? '' : (c / 100).toFixed(2).replace('.', ','));

const celulaCsv = (v) => quotarCelulaCsv(escaparCelulaCsvInjection(v));

router.get('/:id/ranking.csv', ...rota('GET /:id/ranking.csv', 'campanhas.consultar', async (ctx, req, res) => {
  if (!idValido(req.params.id)) return naoEncontrada(res);
  const id = Number(req.params.id);
  // Lê TUDO antes de abrir a resposta: um erro de RPC no meio viraria CSV truncado com 200.
  const todas = [];
  for (let offset = 0; offset < CSV_MAX_LINHAS; offset += CSV_LOTE) {
    // eslint-disable-next-line no-await-in-loop
    const lote = await rpc('hub_campanha_ranking', { p_id: id, p_situacao: null, p_limite: CSV_LOTE, p_offset: offset }, ctx.claims);
    const linhas = lote || [];
    todas.push(...linhas.map(dto.linhaRanking));
    if (linhas.length < CSV_LOTE) break;
  }
  const det = await rpc('hub_campanha_detalhe', { p_id: id }, ctx.claims);
  if (!det) return naoEncontrada(res);
  const extrato = det.tipo === 'extrato';
  const corpo = [(extrato ? CSV_CABECALHO_EXTRATO : CSV_CABECALHO).map(celulaCsv).join(',')];
  for (const r of todas) {
    corpo.push((extrato
      ? [r.posicao, r.nome, r.modal, r.situacao, r.turnosValidos, r.turnos, brl(r.valorCentavos), r.posicaoAnterior]
      : [r.posicao, r.nome, r.modal, r.situacao, r.turnos, r.aceitacao, r.conclusao, r.tempo, r.pedidos, r.nota,
        r.notaHipotetica, r.posicaoHipotetica, r.motivoCorte.join(' '), r.posicaoAnterior]
    ).map(celulaCsv).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="campanha-${id}-ranking.csv"`);
  return res.status(200).send(`${corpo.join('\r\n')}\r\n`);
}));

// ─── Vencedores, entrega, planilha ─────────────────────────────────────────
router.get('/:id/vencedores', ...rota('GET /:id/vencedores', 'campanhas.consultar', async (ctx, req, res) => {
  if (!idValido(req.params.id)) return naoEncontrada(res);
  const id = Number(req.params.id);
  const linhas = (await rpc('hub_campanha_vencedores', { p_id: id }, ctx.claims)) || [];
  // Extrato: a RPC devolve `nota` NULL; o valor somado vem do ranking (casado por entregador).
  let porEntregador = null;
  if (linhas.length && linhas.every((l) => l.nota === null || l.nota === undefined)) {
    porEntregador = new Map();
    const quer = new Set(linhas.map((l) => l.entregador_id));
    for (let offset = 0; offset < 500 && porEntregador.size < quer.size; offset += 200) {
      // eslint-disable-next-line no-await-in-loop
      const lote = (await rpc('hub_campanha_ranking', { p_id: id, p_situacao: 'classificado', p_limite: 200, p_offset: offset }, ctx.claims)) || [];
      for (const r of lote) if (quer.has(r.entregador_id)) porEntregador.set(r.entregador_id, r);
      if (lote.length < 200) break;
    }
  }
  return res.status(200).json({ itens: linhas.map((l) => dto.linhaVencedor(l, porEntregador)) });
}));

router.post('/:id/vencedores/:posicao/entrega', ...rota('POST /:id/vencedores/:posicao/entrega', 'campanhas.entregar', async (ctx, req, res) => {
  if (!idValido(req.params.id) || !/^\d{1,3}$/.test(req.params.posicao)) return naoEncontrada(res);
  let obs = null;
  if (req.body && req.body.observacao !== undefined && req.body.observacao !== null) {
    if (typeof req.body.observacao !== 'string') return validacao(res, 'observacao');
    obs = req.body.observacao.trim() || null;
    if (obs && Array.from(obs).length > 500) return validacao(res, 'observacao');
  }
  const id = Number(req.params.id);
  const posicao = Number(req.params.posicao);
  await rpc('hub_campanha_registrar_entrega', { p_id: id, p_posicao: posicao, p_observacao: obs }, ctx.claims);
  await auditar(ctx, 'campanha.entrega_registrada', id, { posicao });
  return res.status(204).end();
}, { escrita: true }));

// POST (não GET): a chamada carimba `exportado_em`. O download repetido reproduz as mesmas linhas e datas.
router.post('/:id/premios-dinheiro.xlsx', ...rota('POST /:id/premios-dinheiro.xlsx', 'campanhas.entregar', async (ctx, req, res) => {
  if (!idValido(req.params.id)) return naoEncontrada(res);
  const id = Number(req.params.id);
  const venc = await rpc('hub_campanha_marcar_exportado', { p_id: id }, ctx.claims);
  const aoa = dto.linhasPlanilhaPremios(venc, id);
  const adiados = dto.contarAdiados(venc);
  await auditar(ctx, 'campanha.planilha_exportada', id, { linhas: aoa.length - 1, adiados });
  res.setHeader('Content-Type', XLSX_MIME);
  res.setHeader('Content-Disposition', `attachment; filename="premios-campanha-${id}.xlsx"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Premios-Adiados', String(adiados));
  return res.status(200).send(dto.planilhaPremiosBuffer(aoa));
}, { escrita: true }));

// ─── Foto do prêmio ────────────────────────────────────────────────────────
// Limite 600 KB só aqui; a validação real (≤ 512000 e bytes iniciais) é do DTO.
const rawFoto = express.raw({ type: dto.MIMES_IMAGEM, limit: '600kb' });
const lerFoto = (req, res, next) => rawFoto(req, res, (err) => {
  if (err) return res.status(422).json({ erro: 'FOTO_INVALIDA' });
  return next();
});

router.put('/:id/premios/:premioId/foto', ...rota('PUT /:id/premios/:premioId/foto', 'campanhas.gerir', async (ctx, req, res) => {
  if (!idValido(req.params.id) || !idValido(req.params.premioId)) return naoEncontrada(res);
  const mime = dto.detectarImagem(req.body);
  const declarado = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!mime || mime !== declarado) return res.status(422).json({ erro: 'FOTO_INVALIDA' });
  const id = Number(req.params.id);
  const premioId = Number(req.params.premioId);
  await rpc('hub_campanha_premio_foto_salvar', { p_campanha_id: id, p_premio_id: premioId, p_mime: mime, p_base64: req.body.toString('base64') }, ctx.claims);
  await auditar(ctx, 'campanha.foto_salva', id, { premioId, bytes: req.body.length });
  return res.status(204).end();
}, { escrita: true, extras: [lerFoto] }));

router.get('/:id/premios/:premioId/foto', ...rota('GET /:id/premios/:premioId/foto', 'campanhas.consultar', async (ctx, req, res) => {
  if (!idValido(req.params.id) || !idValido(req.params.premioId)) return naoEncontrada(res);
  const linhas = await rpc('hub_campanha_premio_foto', { p_campanha_id: Number(req.params.id), p_premio_id: Number(req.params.premioId) }, ctx.claims);
  return dto.enviarFoto(res, Array.isArray(linhas) ? linhas[0] : null);
}));

module.exports = { router };

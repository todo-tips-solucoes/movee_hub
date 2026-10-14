// hub — routes/hub-validacao-xml.js
//
// GET /api/v1/validacao-xml/regularizadas — notas que o motorista enviou
// DEPOIS do fechamento do movimento (EnvioMassa.regularizada_em, migration
// 0107, gravada por POST /motorista/notas-pendentes/...).
//
// Por que existe: o pagamento retido é liberado por UMA PESSOA — não há gate
// automático entre nota e pagamento. Sem esta lista o motorista regulariza e
// ninguém é avisado.
//
// Permissão: `validacao_xml.validar` (a única do módulo). Criar uma
// `.consultar` exigiria migration e espelho MANUAL na matriz papel×permissão;
// o papel `financeiro_aprovador` (0097) nasceu como CÓPIA do `financeiro`, sem
// vínculo vivo, então permissão nova dada a um não chega ao outro em silêncio.
// Quem valida XML é quem lida com notas.
//
// POST/DELETE /regularizadas/:id/ja-pago e POST /regularizadas/:id/apagar-nota
// (migration 0113): o financeiro resolve um retido pela tela. "Já foi pago"
// reusa conciliada_em (o lote do repasse, 0112, bloqueia com JA_PAGO_CONCILIADO);
// "Apagar nota" desvincula a nota e o movimento volta a pendente no app.
// Permissão: `adiantamentos.pagamento_confirmar` — é decisão sobre dinheiro.
'use strict';

const express = require('express');

const { decodificarAccessToken, lerAccessTokenDoRequest } = require('../lib/hub-access-token');
const { obterPermissoesEfetivasPorEntidade, usuarioEhAdminPlataforma } = require('../lib/hub-rbac-cache');
const { requirePermission } = require('../middleware/hub-require-permission');
const { requireModuloAtivo } = require('../middleware/hub-require-modulo');
const rateLimit = require('express-rate-limit');
const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const { registrarAuditoria } = require('../lib/hub-auditoria');
const { mesmoGrupoQue } = require('./grupo');
const { corteNotasPendentes } = require('./motorista');

const router = express.Router();

const GRUPO_MOVEE_ID = 6;
const LIMITE_REGULARIZADAS = 100;
const PERMISSAO_ACAO = 'adiantamentos.pagamento_confirmar';
const ORIGEM_MANUAL = 'MANUAL';
// Colunas que o envio da nota grava: a FastAPI (nota_ok, numnota, data_emissao,
// dataEnvio, erro_validacao — /var/lib/fastapi_homologacao/app/main.py,
// update_postgrest_data) e o backend (regularizada_em — routes/motorista.js).
const COLUNAS_NOTA = ['nota_ok', 'erro_validacao', 'numnota', 'data_emissao', 'dataEnvio', 'regularizada_em'];
const SELECT_ITEM = 'id,id_empresa,nome,cnpj_prestador,valor,dt_inicial,dt_final,regularizada_em,nota_ok,erro_validacao,numnota,data_emissao,dataEnvio,mov_fechado,conciliada_em,conciliada_origem,pago_manual';

const acaoRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const payload = decodificarAccessToken(lerAccessTokenDoRequest(req));
    return payload && payload.sub ? String(payload.sub) : req.ip;
  },
  handler: (_req, res) => res.status(429).json({ erro: 'LIMITE_EXCEDIDO' }),
});

/**
 * "Aprovada" = `nota_ok` preenchido E `erro_validacao` vazio. O serviço de
 * validação grava `nota_ok` (URL do XML) mesmo quando a nota é REPROVADA,
 * então `nota_ok` sozinho não prova aprovação (ver routes/motorista.js).
 * @param {{nota_ok?:*, erro_validacao?:*}} row
 * @returns {boolean}
 */
function notaAprovada(row) {
  const temNotaOk = row.nota_ok != null && String(row.nota_ok).trim() !== '';
  const temErro = row.erro_validacao != null && String(row.erro_validacao).trim() !== '';
  return temNotaOk && !temErro;
}

/**
 * Linha da EnvioMassa -> DTO. `nota_ok` (URL do XML) NÃO sai daqui.
 * `corte` (YYYY-MM-DD) diz se o motorista conseguiria reenviar pelo app caso a
 * nota seja apagada; sem corte, `podeReenviarNoApp` fica null.
 */
function mapRegularizada(row, corte = null) {
  const manual = row.conciliada_origem === ORIGEM_MANUAL;
  const pm = row.pago_manual || {};
  return {
    id: row.id,
    nome: row.nome,
    cnpjPrestador: row.cnpj_prestador,
    valor: row.valor,
    dtInicial: row.dt_inicial,
    dtFinal: row.dt_final,
    regularizadaEm: row.regularizada_em,
    notaAprovada: notaAprovada(row),
    numeroNota: row.numnota == null ? null : String(row.numnota),
    jaPago: row.conciliada_em
      ? {
        em: row.conciliada_em,
        manual,
        por: manual ? pm.nome || null : null,
        referencia: manual ? pm.referencia || null : null,
      }
      : null,
    podeReenviarNoApp: corte ? String(row.dt_inicial || '').slice(0, 10) >= corte : null,
  };
}

/** Texto livre curto: tira caracteres de controle, apara e limita. */
function textoCurto(v, max = 200) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/**
 * Resolve payload + entidade ativa + escopo de empresas. Responde o erro e
 * devolve `null` quando falha. `escopo === null` = admin da plataforma
 * (todas as empresas); senão, lista de ids (grupo Movee expande para as filiais).
 */
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
  const isAdminPlataforma = await usuarioEhAdminPlataforma(payload.sub);

  let escopo = null;
  if (!isAdminPlataforma) {
    if (entidadeAtiva === GRUPO_MOVEE_ID) {
      // `mesmoGrupoQue` é fail-safe: se a expansão falha por infra, `cache.ids`
      // fica vazio e degradamos para a empresa solo (nunca para "todas").
      const cache = {};
      await mesmoGrupoQue(entidadeAtiva, GRUPO_MOVEE_ID, cache);
      escopo = cache.ids ? [...cache.ids] : [entidadeAtiva];
    } else {
      escopo = [entidadeAtiva];
    }
  }

  const claims = { usuarioId: payload.sub, empresaAtiva: entidadeAtiva, escopo: escopo || [entidadeAtiva] };
  if (isAdminPlataforma) claims.adminPlataforma = true;
  return { claims, escopo };
}

router.get(
  '/regularizadas',
  requireModuloAtivo('validacao_xml'),
  requirePermission('validacao_xml.validar'),
  async (req, res) => {
    try {
      const ctx = await resolverContexto(req, res, 'validacao_xml.validar');
      if (!ctx) return;

      const partes = ['regularizada_em=not.is.null'];
      // 🔴 FILTRO DE ESCOPO EXPLÍCITO, DE PROPÓSITO. A `EnvioMassa` tem RLS
      // ligado, mas a policy é `policy_envioemmassa ... USING (true)`: ela NÃO
      // filtra nada, qualquer role autenticado vê todos os tenants. Confiar no
      // RLS faria o operador da Movee ver regularizações de outros clientes —
      // erro que não dá erro, a tela só mostra demais. Não "simplifique".
      if (ctx.escopo) partes.push(`id_empresa=in.(${ctx.escopo.join(',')})`);
      partes.push(`select=${SELECT_ITEM}`);
      partes.push('order=regularizada_em.desc');

      const { data, total } = await hubPostgrestRequest(
        `EnvioMassa?${partes.join('&')}`, 'GET', null, ctx.claims,
        { count: true, range: { from: 0, to: LIMITE_REGULARIZADAS - 1 } }
      );
      const corte = await corteNotasPendentes();
      const itens = (data || []).slice(0, LIMITE_REGULARIZADAS).map((r) => mapRegularizada(r, corte));
      return res.status(200).json({ itens, total: total ?? itens.length, limite: LIMITE_REGULARIZADAS });
    } catch (e) {
      console.error('[hub-validacao-xml] erro em GET /regularizadas:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
  }
);

// ── Ações do financeiro sobre um retido ─────────────────────────────────────

/** Filtro comum: o movimento é um retido (fechado + regularizado) no escopo. */
function filtroRetido(id, escopo) {
  const partes = [`id=eq.${id}`, 'regularizada_em=not.is.null', 'mov_fechado=is.true'];
  // 🔴 escopo EXPLÍCITO: a RLS da EnvioMassa é USING (true) (ver GET acima).
  if (escopo) partes.push(`id_empresa=in.(${escopo.join(',')})`);
  return partes.join('&');
}

/**
 * Contexto + leitura do retido. Responde 4xx e devolve null quando falha.
 * @returns {Promise<null|{ctx:object, id:number, row:object, filtro:string}>}
 */
async function carregarRetido(req, res) {
  const ctx = await resolverContexto(req, res, PERMISSAO_ACAO);
  if (!ctx) return null;
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'id inválido' });
    return null;
  }
  const filtro = filtroRetido(id, ctx.escopo);
  const rows = await hubPostgrestRequest(`EnvioMassa?${filtro}&select=${SELECT_ITEM}`, 'GET', null, ctx.claims);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) {
    res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    return null;
  }
  return { ctx, id, row, filtro };
}

/** Nome de quem age, para a tela. Best-effort: sem nome, segue com null. */
async function nomeDoUsuario(claims) {
  try {
    const u = await hubPostgrestRequest(`Usuario?id=eq.${Number(claims.usuarioId)}&select=nome`, 'GET', null, claims);
    return (Array.isArray(u) && u[0] && u[0].nome) || null;
  } catch {
    return null;
  }
}

/** PATCH protegido pelo mesmo filtro + guarda de estado; 0 linhas = mudou no meio. */
async function patchRetido(filtro, guarda, corpo, claims) {
  const rows = await hubPostgrestRequest(`EnvioMassa?${filtro}&${guarda}&select=${SELECT_ITEM}`, 'PATCH', corpo, claims);
  return Array.isArray(rows) ? rows[0] || null : null;
}

const guardaAcao = [requireModuloAtivo('validacao_xml'), requirePermission(PERMISSAO_ACAO), acaoRateLimiter, express.json({ limit: '4kb' })];

router.post('/regularizadas/:id/ja-pago', ...guardaAcao, async (req, res) => {
  try {
    const r = await carregarRetido(req, res);
    if (!r) return;
    if (r.row.conciliada_em) return res.status(409).json({ erro: 'JA_MARCADO_COMO_PAGO' });
    const referencia = textoCurto(req.body && req.body.referencia);
    const agora = new Date().toISOString();
    const pagoManual = {
      usuario_id: Number(r.ctx.claims.usuarioId),
      nome: await nomeDoUsuario(r.ctx.claims),
      referencia: referencia || null,
      em: agora,
    };
    const novo = await patchRetido(r.filtro, 'conciliada_em=is.null',
      { conciliada_em: agora, conciliada_origem: ORIGEM_MANUAL, pago_manual: pagoManual }, r.ctx.claims);
    if (!novo) return res.status(409).json({ erro: 'ESTADO_MUDOU' });
    await registrarAuditoria({
      idEmpresa: r.ctx.claims.empresaAtiva,
      usuarioId: r.ctx.claims.usuarioId,
      acao: 'retido_marcado_ja_pago',
      recurso: 'EnvioMassa',
      recursoId: r.id,
      detalhes: { referencia: referencia || null, valor: r.row.valor, numeroNota: r.row.numnota == null ? null : String(r.row.numnota) },
      claims: r.ctx.claims,
    });
    return res.status(200).json({ item: mapRegularizada(novo, await corteNotasPendentes()) });
  } catch (e) {
    console.error('[hub-validacao-xml] erro em POST /regularizadas/:id/ja-pago:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.delete('/regularizadas/:id/ja-pago', ...guardaAcao, async (req, res) => {
  try {
    const r = await carregarRetido(req, res);
    if (!r) return;
    if (!r.row.conciliada_em) return res.status(409).json({ erro: 'NAO_MARCADO_COMO_PAGO' });
    // Conciliação por planilha (UNECONT:) não se desfaz pela tela: tem rollback próprio.
    if (r.row.conciliada_origem !== ORIGEM_MANUAL) return res.status(409).json({ erro: 'CONCILIACAO_NAO_MANUAL' });
    const novo = await patchRetido(r.filtro, `conciliada_origem=eq.${ORIGEM_MANUAL}`,
      { conciliada_em: null, conciliada_origem: null, pago_manual: null }, r.ctx.claims);
    if (!novo) return res.status(409).json({ erro: 'ESTADO_MUDOU' });
    await registrarAuditoria({
      idEmpresa: r.ctx.claims.empresaAtiva,
      usuarioId: r.ctx.claims.usuarioId,
      acao: 'retido_ja_pago_desfeito',
      recurso: 'EnvioMassa',
      recursoId: r.id,
      detalhes: { antes: r.row.pago_manual || null },
      claims: r.ctx.claims,
    });
    return res.status(200).json({ item: mapRegularizada(novo, await corteNotasPendentes()) });
  } catch (e) {
    console.error('[hub-validacao-xml] erro em DELETE /regularizadas/:id/ja-pago:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.post('/regularizadas/:id/apagar-nota', ...guardaAcao, async (req, res) => {
  try {
    const r = await carregarRetido(req, res);
    if (!r) return;
    const motivo = textoCurto(req.body && req.body.motivo);
    if (!motivo) return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'Informe o motivo.' });
    if (r.row.conciliada_em) return res.status(409).json({ erro: 'MARCADO_COMO_PAGO' });
    const antes = Object.fromEntries(COLUNAS_NOTA.map((c) => [c, r.row[c] ?? null]));
    const limpar = Object.fromEntries(COLUNAS_NOTA.map((c) => [c, null]));
    const notaApagada = {
      antes,
      motivo,
      usuario_id: Number(r.ctx.claims.usuarioId),
      nome: await nomeDoUsuario(r.ctx.claims),
      em: new Date().toISOString(),
    };
    // A guarda `conciliada_em=is.null` fecha a corrida com um "Já foi pago" simultâneo:
    // 0 linhas devolvidas = alguém mudou o movimento entre a leitura e a escrita.
    const rows = await hubPostgrestRequest(`EnvioMassa?${r.filtro}&conciliada_em=is.null&select=id`, 'PATCH',
      { ...limpar, nota_apagada: notaApagada }, r.ctx.claims);
    if (!Array.isArray(rows) || rows.length === 0) return res.status(409).json({ erro: 'ESTADO_MUDOU' });
    await registrarAuditoria({
      idEmpresa: r.ctx.claims.empresaAtiva,
      usuarioId: r.ctx.claims.usuarioId,
      acao: 'retido_nota_apagada',
      recurso: 'EnvioMassa',
      recursoId: r.id,
      // A URL do XML fica em EnvioMassa.nota_apagada (o scrub da auditoria a omitiria).
      detalhes: { motivo, valor: r.row.valor, numeroNota: antes.numnota == null ? null : String(antes.numnota) },
      claims: r.ctx.claims,
    });
    const corte = await corteNotasPendentes();
    return res.status(200).json({ id: r.id, podeReenviarNoApp: String(r.row.dt_inicial || '').slice(0, 10) >= corte });
  } catch (e) {
    console.error('[hub-validacao-xml] erro em POST /regularizadas/:id/apagar-nota:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

module.exports = { router, notaAprovada, mapRegularizada, LIMITE_REGULARIZADAS, COLUNAS_NOTA };

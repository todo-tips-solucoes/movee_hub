/**
 * hub — routes/hub-repasse-lotes.js (PLANO-F5-LOTE-REPASSE §3.2)
 *
 * Ciclo de pagamento do repasse semanal: prévia -> lote -> arquivo Transfeera
 * -> confirmação (XLSX de retorno ou manual) -> concluído. Espelha o bloco
 * "Lotes de pagamento" de routes/hub-adiantamentos.js (mesma cadeia de guarda,
 * mesmo transporte XLSX binário no retorno, mesmo mapeamento de erro das RPCs);
 * as RPCs são `hub_repasse_lote_*` (migration 0108).
 *
 * Montado em `/api/v1/adiantamentos/repasse` (server.js) — o mesmo prefixo de
 * `GET /repasse`, porque o repasse vive no módulo `adiantamentos`. Zero
 * permissão nova (D5): reusa as do adiantamento.
 *
 * Reusado do adiantamento: XLSX (`montarPlanilhaTransfeera` + contrato),
 * parser do retorno (`casarComItensDoLote` com `{ prefixo: 'REP' }` — SEM o
 * prefixo explícito o default é 'ADV' e nenhuma linha casa), DTOs.
 * Aqui a chave de casamento é o id do `RepasseLoteItem` (`REP-<item_id>`, D8);
 * o lib a devolve em `solicitacaoId` — é só o nome do campo, trate como item.
 *
 * 🔴 Escopo explícito (`id_empresa=in.(...)`) em TODA leitura direta: o RLS
 * da EnvioMassa é `USING (true)` e não separa tenant (ver hub-validacao-xml.js).
 * 🔴 Os bytes de `arquivo` nunca saem numa listagem — só pela RPC de download.
 */
'use strict';

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const { decodificarAccessToken, lerAccessTokenDoRequest } = require('../lib/hub-access-token');
const { requireModuloAtivo } = require('../middleware/hub-require-modulo');
const { requirePermission } = require('../middleware/hub-require-permission');
const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const { registrarAuditoria } = require('../lib/hub-auditoria');
const { dinheiro, mapLote, mapLoteItem } = require('../lib/adiantamento-dto');
const { montarPlanilhaTransfeera, validarPlanilhaTransfeera, renderizarDescricaoPix } = require('../lib/adiantamento-transfeera-xlsx');
const { paraCentavos } = require('../lib/adiantamento-remanescente');
const { partesNoFuso, dataISO } = require('../lib/adiantamento-regras');
const {
  RetornoTransfeeraParseError, XLSX_MIME, lerXlsx, casarComItensDoLote,
} = require('../lib/adiantamento-retorno-transfeera');
const contratoTransfeera = require('../lib/fixtures/transfeera-contrato.json');
const { resolverContextoAdiantamentos } = require('./hub-adiantamentos');

const router = express.Router();

const PREFIXO_ID_INTEGRACAO = 'REP';
const TIMEZONE_LOTE = 'America/Sao_Paulo';
const PAGE_SIZE_PADRAO = 20;
const PAGE_SIZE_MAX = 100;
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mesma lista do GRANT SELECT por coluna de "RepasseLote": sem `arquivo`.
const SELECT_LOTE = 'id,id_empresa,status,criado_por,criado_em,chave_idempotencia,'
  + 'quantidade,valor_total,arquivo_nome,arquivo_sha256,arquivo_bytes,'
  + 'arquivo_expurgado_em,gerado_em,primeiro_download_em,downloads,'
  + 'cancelado_em,cancelado_por,cancelado_motivo,nao_enviado_declarado,concluido_em';
const STATUS_LOTE = ['GERANDO', 'GERADO', 'EXPORTADO', 'CONCLUIDO', 'CONCLUIDO_COM_FALHAS', 'CANCELADO'];

// ── Rate limiters próprios (contadores NÃO compartilhados com o adiantamento) ──
function limiterPorUsuario(max) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const payload = decodificarAccessToken(lerAccessTokenDoRequest(req));
      return payload && payload.sub ? String(payload.sub) : req.ip;
    },
    handler: (_req, res) => res.status(429).json({ erro: 'LIMITE_EXCEDIDO' }),
  });
}
// 120 (no adiantamento são 30): lá a prévia nasce de ação explícita; aqui a tela a chama em todo
// mount da aba Repasse, e 30 estouram só navegando de volta.
const previaRateLimiter = limiterPorUsuario(120);
const loteRateLimiter = limiterPorUsuario(30);
const retornoRateLimiter = limiterPorUsuario(10);

// ── Helpers puros (exportados para teste) ──────────────────────────────────

function idValido(raw) {
  return typeof raw === 'string' && /^\d+$/.test(raw);
}

function motivoValido(raw) {
  return typeof raw === 'string' && raw.trim().length >= 3 && raw.trim().length <= 500;
}

function mensagemDeErro(e) {
  return String((e && e.body) || (e && e.message) || '');
}

function detailDoErro(e) {
  try {
    const corpo = JSON.parse((e && e.body) || '');
    return typeof corpo.details === 'string' ? corpo.details : null;
  } catch {
    return null;
  }
}

function parsePaginacao(query) {
  let page = parseInt(query && query.page, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  let pageSize = parseInt(query && query.pageSize, 10);
  if (!Number.isInteger(pageSize) || pageSize < 1) pageSize = PAGE_SIZE_PADRAO;
  if (pageSize > PAGE_SIZE_MAX) pageSize = PAGE_SIZE_MAX;
  return { page, pageSize };
}

/** Corpo do POST /lotes e da prévia: dois arrays paralelos (o contrato da RPC, sem conversão — ~54 KB para
 * 5000 pares; o formato [{apuracaoId,entregadorId}] daria 210 KB e estouraria o express.json()
 * global de 100 KB). Sem teto de tamanho: a RPC recusa com LOTE_ACIMA_DO_LIMITE (-> 422).
 * Devolve `null` se válido, ou o `motivo` do 400. */
function motivoParesInvalidos(apuracoes, entregadores) {
  const positivos = (a) => Array.isArray(a) && a.every((n) => Number.isInteger(n) && n > 0);
  if (!positivos(apuracoes) || !positivos(entregadores) || apuracoes.length === 0
    || apuracoes.length !== entregadores.length) return 'itens';
  const vistos = new Set();
  for (let i = 0; i < apuracoes.length; i += 1) {
    const par = `${apuracoes[i]}:${entregadores[i]}`;
    if (vistos.has(par)) return `itens: par ${par} (apuracao:entregador) repetido`;
    vistos.add(par);
  }
  return null;
}

/** Mapeia o `RAISE EXCEPTION '<CODIGO>'` da RPC para a resposta HTTP.
 * `null` = erro não reconhecido (quem chama responde 500). */
function traduzirErroRpc(e) {
  const msg = mensagemDeErro(e);
  if (msg.includes('NAO_ENCONTRADA')) return { status: 404, corpo: { erro: 'NAO_ENCONTRADO' } };
  if (msg.includes('PERMISSAO_NEGADA')) return { status: 403, corpo: { erro: 'PERMISSAO_NEGADA' } };
  if (msg.includes('LOTE_ACIMA_DO_LIMITE')) return { status: 422, corpo: { erro: 'LOTE_ACIMA_DO_LIMITE' } };
  if (msg.includes('PREVIA_DESATUALIZADA')) return { status: 409, corpo: { erro: 'PREVIA_DESATUALIZADA' } };
  if (msg.includes('ITENS_EM_OUTRO_LOTE')) {
    // DETAIL = 'apuracao:entregador,apuracao:entregador,...'
    const ids = (detailDoErro(e) || '').split(',').filter(Boolean).map((par) => {
      const [apuracaoId, entregadorId] = par.split(':').map(Number);
      return { apuracaoId, entregadorId };
    });
    return { status: 409, corpo: { erro: 'ITENS_EM_OUTRO_LOTE', ids } };
  }
  if (msg.includes('CONFIRMACAO_NAO_ENVIADO_OBRIGATORIA')) return { status: 409, corpo: { erro: 'CONFIRMACAO_NAO_ENVIADO_OBRIGATORIA' } };
  if (msg.includes('TRANSICAO_INVALIDA')) return { status: 409, corpo: { erro: 'TRANSICAO_INVALIDA' } };
  if (msg.includes('ITEM_FORA_DO_LOTE')) return { status: 400, corpo: { erro: 'DADOS_INVALIDOS', motivo: 'falhas' } };
  if (msg.includes('MOTIVO_OBRIGATORIO')) return { status: 400, corpo: { erro: 'DADOS_INVALIDOS', motivo: 'motivo' } };
  if (msg.includes('DADOS_INVALIDOS')) return { status: 400, corpo: { erro: 'DADOS_INVALIDOS' } };
  return null;
}

function responderErroRpc(res, e, rota) {
  const t = traduzirErroRpc(e);
  if (t) return res.status(t.status).json(t.corpo);
  console.error(`[hub-repasse-lotes] erro em ${rota}:`, e.message);
  return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
}

/** Retorno da prévia: elegíveis e bloqueadas (com o motivo, D3). */
function montarRespostaPrevia(rows) {
  const linha = (r) => ({
    apuracaoId: r.apuracao_id,
    entregadorId: r.entregador_id,
    motorista: r.entregador_nome,
    periodoInicio: r.periodo_inicio,
    periodoFim: r.periodo_fim,
    valor: dinheiro(r.valor_pago),
  });
  const aptasRows = rows.filter((r) => r.apta === true);
  const total = aptasRows.reduce((acc, r) => acc + paraCentavos(r.valor_pago), 0);
  return {
    aptas: aptasRows.map(linha),
    bloqueadas: rows.filter((r) => r.apta !== true).map((r) => ({ ...linha(r), motivo: r.motivo_pendencia })),
    quantidadeApta: aptasRows.length,
    totalApto: dinheiro((total / 100).toFixed(2)),
  };
}

function nomeArquivoRepasse(dataCriacaoISO, numeroLote) {
  return `transfeera_repasse_${dataCriacaoISO}_lote-${String(numeroLote).padStart(6, '0')}.xlsx`;
}

/** Texto livre do arquivo do parceiro: SANEAR, não recusar. Este motivo não é
 * digitado por quem pode corrigi-lo — recusar o arquivo inteiro porque o
 * parceiro mandou um código de 2 letras bloquearia a conciliação legítima.
 * Corta no teto e completa o piso, dando ao banco o contrato 3..500. */
function sanearMotivoDoArquivo(raw) {
  const texto = (typeof raw === 'string' ? raw : '').trim().slice(0, 500);
  return motivoValido(texto) ? texto : `Devolvida pelo parceiro (motivo não informado: "${texto}")`.slice(0, 500);
}

/** Itens do lote (`id`, `col_id_integracao`, `situacao`, `valor`) -> formato do lib. */
function itensParaCasamento(itensRaw) {
  return itensRaw.map((i) => ({
    solicitacaoId: i.id, // chave de casamento do repasse = id do RepasseLoteItem
    colIdIntegracao: i.col_id_integracao,
    situacao: i.situacao,
    valorCentavos: paraCentavos(i.valor),
  }));
}

/** Casa o retorno (XLSX) com os itens do lote. `aplicaveis[].solicitacaoId` = id do item. */
function casarRetornoRepasse(linhasRetorno, itensRaw) {
  return casarComItensDoLote(linhasRetorno, itensParaCasamento(itensRaw), { prefixo: PREFIXO_ID_INTEGRACAO });
}

/** Ponto único de escrita de situação: UMA chamada atômica. A RPC marca as
 * `falhas` ([{id, motivo}], id = item) e paga todo o resto ainda `incluido`. */
async function confirmarLote(id, falhas, origem, claims) {
  await hubPostgrestRequest('rpc/hub_repasse_lote_confirmar', 'POST',
    { p_lote_id: id, p_falhas: falhas, p_origem: origem }, claims);
}

async function lerLote(id, claims) {
  const linhas = await hubPostgrestRequest(
    `RepasseLote?id=eq.${id}&id_empresa=in.(${claims.escopo.join(',')})&select=${SELECT_LOTE}`, 'GET', null, claims
  );
  return (Array.isArray(linhas) && linhas[0]) || null;
}

function mapItemRepasse(row) {
  return { ...mapLoteItem(row), apuracaoId: row.apuracao_id, entregadorId: row.entregador_id };
}

// ── Rotas ──────────────────────────────────────────────────────────────────

router.post('/lotes/previa', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.pagamentos_consultar'), previaRateLimiter, async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.pagamentos_consultar');
    if (!ctx) return;
    const { claims } = ctx;
    const { apuracoes, entregadores } = (req.body && typeof req.body === 'object') ? req.body : {};
    // Ambos ausentes = todas as elegíveis (a RPC aceita NULL); presentes, validados; só um = 400.
    let params = { p_apuracoes: null, p_entregadores: null };
    if (apuracoes !== undefined || entregadores !== undefined) {
      const motivo = motivoParesInvalidos(apuracoes, entregadores);
      if (motivo) return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo });
      params = { p_apuracoes: apuracoes, p_entregadores: entregadores };
    }
    const rows = await hubPostgrestRequest('rpc/hub_repasse_lote_previa', 'POST', params, claims);
    return res.status(200).json(montarRespostaPrevia(rows || []));
  } catch (e) {
    return responderErroRpc(res, e, 'POST /lotes/previa');
  }
});

router.post('/lotes', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.lote_criar'), loteRateLimiter, async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.lote_criar');
    if (!ctx) return;
    const { claims, entidadeAtiva, payload } = ctx;
    const corpo = (req.body && typeof req.body === 'object') ? req.body : {};
    const { apuracoes, entregadores, quantidadeEsperada, totalEsperado, chaveIdempotencia } = corpo;
    const motivoPares = motivoParesInvalidos(apuracoes, entregadores);
    if (motivoPares) return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: motivoPares });
    const arrays = { p_apuracoes: apuracoes, p_entregadores: entregadores };
    if (
      !Number.isInteger(quantidadeEsperada)
      || typeof totalEsperado !== 'string' || !/^\d+\.\d{2}$/.test(totalEsperado)
      || typeof chaveIdempotencia !== 'string' || !RE_UUID.test(chaveIdempotencia)
    ) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }

    let resultado;
    // 2 tentativas: a 2ª só ocorre se a 1ª perdeu a corrida na UNIQUE de
    // idempotência (23505); aí o vencedor já commitou e a RPC devolve `reutilizado`.
    for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
      try {
        const linhas = await hubPostgrestRequest('rpc/hub_repasse_lote_criar', 'POST', {
          ...arrays, p_quantidade_esperada: quantidadeEsperada, p_total_esperado: totalEsperado, p_chave: chaveIdempotencia,
        }, claims);
        resultado = Array.isArray(linhas) && linhas[0];
        break;
      } catch (e) {
        if (mensagemDeErro(e).includes('23505') && tentativa === 1) continue;
        return responderErroRpc(res, e, 'POST /lotes');
      }
    }
    if (!resultado) return res.status(500).json({ erro: 'ERRO_SERVIDOR' });

    // Gera + valida + grava o xlsx só na criação DE FATO (não no reenvio idempotente).
    if (!resultado.reutilizado) {
      try {
        // `hub_repasse_lote_criar` grava o modelo BRUTO em `col_descricao_pix`; quem renderiza E
        // VALIDA (recusa placeholder fora da allowlist — o texto vai a um sistema de pagamento de
        // terceiro) é o Node. Se lançar, o catch abaixo cancela o lote.
        const itensBrutos = await hubPostgrestRequest(
          `RepasseLoteItem?lote_id=eq.${resultado.id}&id_empresa=in.(${claims.escopo.join(',')})&select=*,apuracao:ApuracaoRepasse(periodo_fim)&order=linha.asc`,
          'GET', null, claims
        );
        const itensLote = (itensBrutos || []).map((item) => ({
          ...item,
          col_descricao_pix: renderizarDescricaoPix(item.col_descricao_pix, {
            nome: item.col_nome,
            // no repasse, {data_producao:DD.MM.AA} = FIM do período apurado (o nome vem do adiantamento)
            dataProducaoISO: item.apuracao && item.apuracao.periodo_fim,
          }),
        }));
        const buffer = montarPlanilhaTransfeera(itensLote, contratoTransfeera);
        const validacao = validarPlanilhaTransfeera(buffer, contratoTransfeera, {
          quantidade: resultado.quantidade, valorTotal: paraCentavos(resultado.valor_total),
          idsIntegracao: itensLote.map((i) => i.col_id_integracao),
        });
        if (!validacao.ok) throw new Error(`VALIDACAO_PLANILHA_FALHOU:${validacao.falhas.join(',')}`);

        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        // O container roda em UTC: `toISOString()` nomearia o arquivo com o dia seguinte entre 21h e 00h BRT.
        const { ano, mes, dia } = partesNoFuso(new Date(), TIMEZONE_LOTE);
        await hubPostgrestRequest('rpc/hub_repasse_lote_arquivo', 'POST', {
          p_lote_id: resultado.id, p_arquivo: buffer.toString('base64'), p_sha256: sha256,
          p_bytes: buffer.length, p_nome: nomeArquivoRepasse(dataISO(ano, mes, dia), resultado.id),
          // persiste a descrição já renderizada/validada (o que mapLoteItem exibe depois)
          p_itens: itensLote.map((i) => ({ id: i.id, descricao: i.col_descricao_pix })),
        }, claims);
      } catch (e) {
        console.error('[hub-repasse-lotes] falha ao gerar arquivo do lote — cancelando:', e.message);
        try {
          await hubPostgrestRequest('rpc/hub_repasse_lote_cancelar', 'POST',
            { p_lote_id: resultado.id, p_motivo: 'falha_geracao', p_nao_enviado: false }, claims);
        } catch (e2) {
          console.error('[hub-repasse-lotes] falha ao cancelar lote após falha de geração:', e2.message);
        }
        return res.status(500).json({ erro: 'FALHA_GERACAO_ARQUIVO' });
      }

      await registrarAuditoria({
        idEmpresa: entidadeAtiva, usuarioId: payload.sub, acao: 'repasse.lote_criado',
        recurso: 'RepasseLote', recursoId: resultado.id,
        detalhes: { quantidade: resultado.quantidade, valorTotal: resultado.valor_total }, claims,
      });
    }

    const loteFinal = await lerLote(resultado.id, claims);
    return res.status(resultado.reutilizado ? 200 : 201).json(loteFinal ? mapLote(loteFinal) : null);
  } catch (e) {
    console.error('[hub-repasse-lotes] erro inesperado em POST /lotes:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.get('/lotes', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.pagamentos_consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.pagamentos_consultar');
    if (!ctx) return;
    const { claims } = ctx;
    const { page, pageSize } = parsePaginacao(req.query);
    const from = (page - 1) * pageSize;

    const partes = [`id_empresa=in.(${claims.escopo.join(',')})`];
    if (typeof req.query.status === 'string' && req.query.status.trim()) {
      // Allowlist: o valor iria cru para a querystring do PostgREST.
      const lista = req.query.status.split(',').map((s) => s.trim().toUpperCase()).filter((s) => STATUS_LOTE.includes(s));
      if (!lista.length) return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'status' });
      partes.push(`status=in.(${lista.join(',')})`);
    }
    partes.push(`select=${SELECT_LOTE}`, 'order=criado_em.desc');

    const { data: linhas, total } = await hubPostgrestRequest(
      `RepasseLote?${partes.join('&')}`, 'GET', null, claims, { count: true, range: { from, to: from + pageSize - 1 } }
    );
    return res.status(200).json({ itens: (linhas || []).map(mapLote), total, page, pageSize });
  } catch (e) {
    console.error('[hub-repasse-lotes] erro em GET /lotes:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.get('/lotes/:id', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.pagamentos_consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.pagamentos_consultar');
    if (!ctx) return;
    const { claims } = ctx;
    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = Number(req.params.id);

    const row = await lerLote(id, claims);
    if (!row) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const itens = await hubPostgrestRequest(
      `RepasseLoteItem?lote_id=eq.${id}&id_empresa=in.(${claims.escopo.join(',')})&select=*&order=linha.asc`, 'GET', null, claims
    );
    return res.status(200).json({ ...mapLote(row), itens: (itens || []).map(mapItemRepasse) });
  } catch (e) {
    console.error('[hub-repasse-lotes] erro em GET /lotes/:id:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.get('/lotes/:id/arquivo', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.exportar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.exportar');
    if (!ctx) return;
    const { claims, entidadeAtiva, payload } = ctx;
    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = Number(req.params.id);
    // Fora do escopo = 404 (não vaza existência); a RPC sozinha não filtra por escopo do chamador aqui.
    if (!(await lerLote(id, claims))) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });

    let resultado;
    try {
      const linhas = await hubPostgrestRequest('rpc/hub_repasse_lote_download', 'POST', { p_lote_id: id }, claims);
      resultado = Array.isArray(linhas) && linhas[0];
    } catch (e) {
      const msg = mensagemDeErro(e);
      if (msg.includes('ARQUIVO_EXPURGADO')) {
        let expurgadoEm = null;
        try { expurgadoEm = JSON.parse(detailDoErro(e) || 'null'); } catch { expurgadoEm = null; }
        return res.status(410).json({ erro: 'ARQUIVO_INDISPONIVEL', motivo: 'expurgado_por_retencao', expurgadoEm });
      }
      if (msg.includes('ARQUIVO_INDISPONIVEL')) return res.status(409).json({ erro: 'ARQUIVO_INDISPONIVEL' });
      return responderErroRpc(res, e, 'GET /lotes/:id/arquivo');
    }
    if (!resultado) return res.status(410).json({ erro: 'ARQUIVO_INDISPONIVEL' });

    const buffer = Buffer.from(resultado.arquivo_base64, 'base64');
    // Confere o sha256 antes de enviar; nunca logar bytes nem hash.
    if (crypto.createHash('sha256').update(buffer).digest('hex') !== resultado.sha256) {
      console.error('[hub-repasse-lotes] integridade do arquivo do lote %s divergiu do sha256 esperado', id);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }

    await registrarAuditoria({
      idEmpresa: entidadeAtiva, usuarioId: payload.sub, acao: 'repasse.lote_baixado',
      recurso: 'RepasseLote', recursoId: id, detalhes: { numeroDownload: resultado.downloads }, claims,
    });

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${resultado.nome}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.status(200).send(buffer);
  } catch (e) {
    console.error('[hub-repasse-lotes] erro inesperado em GET /lotes/:id/arquivo:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.post('/lotes/:id/cancelar', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.reprocessar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.reprocessar');
    if (!ctx) return;
    const { claims, entidadeAtiva, payload } = ctx;
    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = Number(req.params.id);
    const corpo = (req.body && typeof req.body === 'object') ? req.body : {};
    const motivo = typeof corpo.motivo === 'string' ? corpo.motivo.trim() : undefined;
    if (!motivoValido(motivo)) return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'motivo' });
    if (!(await lerLote(id, claims))) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });

    try {
      await hubPostgrestRequest('rpc/hub_repasse_lote_cancelar', 'POST',
        { p_lote_id: id, p_motivo: motivo, p_nao_enviado: corpo.naoEnviadoATransfeera === true }, claims);
    } catch (e) {
      return responderErroRpc(res, e, 'POST /lotes/:id/cancelar');
    }

    await registrarAuditoria({
      idEmpresa: entidadeAtiva, usuarioId: payload.sub, acao: 'repasse.lote_cancelado',
      recurso: 'RepasseLote', recursoId: id, detalhes: { motivo }, claims,
    });
    const loteFinal = await lerLote(id, claims);
    return res.status(200).json(loteFinal ? mapLote(loteFinal) : { id });
  } catch (e) {
    console.error('[hub-repasse-lotes] erro inesperado em POST /lotes/:id/cancelar:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

/** Confirmação manual: `falhas: [{id, motivo}]` (id = item do lote); todo item
 * ainda `incluido` que NÃO está em `falhas` é marcado pago — mesma semântica
 * do adiantamento, para os dialogs poderem ser reusados. */
router.post('/lotes/:id/confirmacao', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.pagamento_confirmar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.pagamento_confirmar');
    if (!ctx) return;
    const { claims, entidadeAtiva, payload } = ctx;
    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = Number(req.params.id);
    const corpo = (req.body && typeof req.body === 'object') ? req.body : {};
    const falhas = Array.isArray(corpo.falhas) ? corpo.falhas : [];
    if (!falhas.every((f) => f && Number.isInteger(f.id) && motivoValido(f.motivo))) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'falhas' });
    }
    // Dois motivos para o mesmo item = requisição malformada; recusar, nunca escolher um.
    const repetido = falhas.find((f, i) => falhas.findIndex((g) => g.id === f.id) !== i);
    if (repetido) return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: `falhas: id ${repetido.id} repetido` });

    const itensRaw = await hubPostgrestRequest(
      `RepasseLoteItem?lote_id=eq.${id}&id_empresa=in.(${claims.escopo.join(',')})&select=id,situacao`, 'GET', null, claims
    );
    if (!itensRaw || !itensRaw.length) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const incluidos = new Set(itensRaw.filter((i) => i.situacao === 'incluido').map((i) => i.id));
    if (incluidos.size === 0) return res.status(409).json({ erro: 'TRANSICAO_INVALIDA' });
    if (!falhas.every((f) => incluidos.has(f.id))) return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'falhas' });

    const idsFalha = new Set(falhas.map((f) => f.id));
    const pagos = [...incluidos].filter((i) => !idsFalha.has(i));
    try {
      await confirmarLote(id, falhas.map((f) => ({ id: f.id, motivo: f.motivo.trim() })), 'manual', claims);
    } catch (e) {
      return responderErroRpc(res, e, 'POST /lotes/:id/confirmacao');
    }

    await registrarAuditoria({
      idEmpresa: entidadeAtiva, usuarioId: payload.sub, acao: 'repasse.lote_confirmado',
      recurso: 'RepasseLote', recursoId: id, detalhes: { pagos: pagos.length, falhas: falhas.length }, claims,
    });
    const loteFinal = await lerLote(id, claims);
    return res.status(200).json(loteFinal ? mapLote(loteFinal) : { id });
  } catch (e) {
    console.error('[hub-repasse-lotes] erro inesperado em POST /lotes/:id/confirmacao:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// O corpo chega como XLSX BINÁRIO (`express.raw`), não JSON: o `express.json()`
// global (100 KB) roda ANTES do router e daria 413 a qualquer arquivo real
// (incidente de 2026-10-01, ver hub-adiantamentos.js). NUNCA subir o limite
// global — o parser fica AQUI, depois de módulo+permissão. Outro Content-Type
// (inclusive `text/csv`) não casa o parser e vira 400 FORMATO_INVALIDO.
router.post('/lotes/:id/retorno', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.pagamento_confirmar'), retornoRateLimiter, express.raw({ limit: '10mb', type: [XLSX_MIME] }), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.pagamento_confirmar');
    if (!ctx) return;
    const { claims, entidadeAtiva, payload } = ctx;
    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = Number(req.params.id);
    // Outro content-type cai aqui como `{}` (o parser não casou) e vira 400, nunca 500.
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ erro: 'ARQUIVO_INVALIDO', motivo: 'FORMATO_INVALIDO' });
    }

    let linhasRetorno;
    try {
      linhasRetorno = lerXlsx(req.body);
    } catch (e) {
      if (e instanceof RetornoTransfeeraParseError) return res.status(400).json({ erro: 'ARQUIVO_INVALIDO', motivo: e.motivo });
      // Só mensagem constante + e.name: o `message` do SheetJS pode ecoar conteúdo do arquivo.
      console.error('[hub-repasse-lotes] erro ao ler o XLSX em POST /lotes/:id/retorno:', e && e.name);
      return res.status(400).json({ erro: 'ARQUIVO_INVALIDO', motivo: 'FORMATO_INVALIDO' });
    }

    const itensRaw = await hubPostgrestRequest(
      `RepasseLoteItem?lote_id=eq.${id}&id_empresa=in.(${claims.escopo.join(',')})&select=id,col_id_integracao,situacao,valor`,
      'GET', null, claims
    );
    if (!itensRaw || !itensRaw.length) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });

    let casamento;
    try {
      casamento = casarRetornoRepasse(linhasRetorno, itensRaw);
    } catch (e) {
      // LINHA_DUPLICADA conflitante: o arquivo inteiro é recusado.
      if (e instanceof RetornoTransfeeraParseError) return res.status(400).json({ erro: 'ARQUIVO_INVALIDO', motivo: e.motivo });
      throw e;
    }
    const { aplicaveis, ignoradas, faltantes } = casamento;
    // Nunca aplica parcialmente: item `incluido` sem resolução no arquivo seria pago por omissão.
    // `ignoradas` cruas carregam nomes de terceiros do arquivo do parceiro: só a contagem por motivo sai.
    const ignoradasPorMotivo = [...ignoradas.reduce((acc, i) => {
      acc.set(i.motivo, (acc.get(i.motivo) || 0) + 1);
      return acc;
    }, new Map())].map(([motivo, total]) => ({ motivo, total })).sort((a, b) => b.total - a.total);
    // O 409 leva o diagnóstico: linha ignorada de item `incluido` (VALOR_AMBIGUO etc.) vira faltante.
    if (faltantes.length > 0) return res.status(409).json({ erro: 'RETORNO_INCOMPLETO', faltantes, ignoradasPorMotivo });

    const falhas = aplicaveis.filter((a) => a.status === 'Devolvida')
      .map((a) => ({ id: a.solicitacaoId, motivo: sanearMotivoDoArquivo(a.motivo) }));

    if (aplicaveis.length > 0) {
      try {
        await confirmarLote(id, falhas, 'retorno', claims);
      } catch (e) {
        return responderErroRpc(res, e, 'POST /lotes/:id/retorno');
      }
    }

    // Toda tentativa que chega aqui é auditada, inclusive `aplicadas: 0` (owasp A09).
    await registrarAuditoria({
      idEmpresa: entidadeAtiva, usuarioId: payload.sub, acao: 'repasse.retorno_importado',
      recurso: 'RepasseLote', recursoId: id,
      detalhes: { aplicadas: aplicaveis.length, falhas: falhas.length, ignoradas: ignoradas.length }, claims,
    });

    return res.status(200).json({ aplicadas: aplicaveis.length, ignoradas: ignoradas.length, ignoradasPorMotivo });
  } catch (e) {
    console.error('[hub-repasse-lotes] erro inesperado em POST /lotes/:id/retorno:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

module.exports = {
  router,
  motivoParesInvalidos,
  traduzirErroRpc,
  montarRespostaPrevia,
  nomeArquivoRepasse,
  sanearMotivoDoArquivo,
  casarRetornoRepasse,
};

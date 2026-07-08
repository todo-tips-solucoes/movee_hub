// hub-faturamento (S6 do hub de frota) — routes/hub-faturamento.js
//
// GET /api/v1/faturamento (lista paginada, JSON e `?format=csv`) e
// GET /api/v1/faturamento/resumo (cards/agregados) — FASE 3/4/5 (tasks.md
// 3.2/4.1/5.1). Ref: docs/specs/hub-faturamento/contracts/faturamento-api.md,
// data-model.md, research.md.
//
// Arquivo 100% NOVO — nenhuma linha de server.js legado é editada (mesmo
// padrão de routes/hub-importacoes.js/hub-motoristas.js). id_empresa SEMPRE
// resolvido da claim `entidade_ativa` do accessToken (Princípio II) — nunca
// da query/corpo. Superfície 100% leitura sobre `FaturamentoLancamento`
// (FR-011) — nenhum INSERT/UPDATE/DELETE nesta rota.
'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');

const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const { obterPermissoesEfetivas, obterPermissoesEfetivasPorEntidade } = require('../lib/hub-rbac-cache');
const { requirePermission } = require('../middleware/hub-require-permission');
const { registrarAuditoria } = require('../lib/hub-auditoria');
const { escaparCelulaCsvInjection, quotarCelulaCsv } = require('../lib/hub-csv');
const {
  parseFiltros,
  parsePaginacao,
  mapFaturamentoListItem,
  groupByValido,
  mapResumoCards,
  mapResumoAgrupado,
  CHAVE_AGREGADOS_BONUS,
} = require('../lib/hub-faturamento-dto');

const router = express.Router();

// Export CSV (research.md Decision 5) — lote de LEITURA paginada, não de
// escrita (LOTE_EXPORT_CSV=1000; conservador dentro da faixa já validada em
// produção pelo pipeline de importação, §12.6 do plano técnico usa 500 para
// ESCRITA — 1.000 para leitura paginada é só um número maior de itens por
// página do mesmo mecanismo Range, não um padrão novo).
const LOTE_EXPORT_CSV = 1000;
const CABECALHO_CSV = ['dataReferencia', 'categoria', 'valor', 'entregadorNome', 'subpraca', 'praca', 'periodo'];

// ────────────────────────────────────────────────────────────────────────────
// Helpers (DUPLICADOS deliberadamente — mesmo padrão de routes/hub-importacoes.js
// e routes/hub-motoristas.js: cada arquivo de rota do hub mantém sua própria
// cópia destes helpers pequenos, sem import cross-domain)
// ────────────────────────────────────────────────────────────────────────────

function decodificarAccessToken(accessToken) {
  if (!accessToken) return null;
  try {
    // Pinagem de algoritmo obrigatória (owasp-security) em TODO jwt.verify do hub.
    return jwt.verify(accessToken, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (_e) {
    return null;
  }
}

/**
 * Resolve payload+entidadeAtiva+claims do accessToken e confirma que a
 * ENTIDADE ATIVA concede `permissao` (não só a união flat já barrada pelo
 * `requirePermission` de nível de rota — mesmo padrão de
 * routes/hub-importacoes.js#resolverContextoEntidade / routes/hub-motoristas.js).
 * Envia a resposta de erro e retorna `null` em caso de falha (401/400/403);
 * retorna o contexto em caso de sucesso.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} permissao - ex.: `faturamento.listar`
 * @returns {Promise<{payload:object, entidadeAtiva:number, claims:object,
 *   permissoes:Set<string>}|null>}
 */
async function resolverContextoEntidade(req, res, permissao) {
  const accessToken = req.cookies && req.cookies.accessToken;
  const payload = decodificarAccessToken(accessToken);
  if (!payload || !payload.sub) {
    res.status(401).json({ erro: 'NAO_AUTENTICADO' });
    return null;
  }
  const entidadeAtiva = payload.entidade_ativa ? Number(payload.entidade_ativa) : null;
  if (!entidadeAtiva) {
    res.status(400).json({ erro: 'ENTIDADE_NAO_SELECIONADA' });
    return null;
  }
  const permsEntidade = await obterPermissoesEfetivasPorEntidade(payload.sub, entidadeAtiva);
  if (!permsEntidade.has(permissao)) {
    res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    return null;
  }
  const claims = { usuarioId: payload.sub, empresaAtiva: entidadeAtiva, escopo: [entidadeAtiva] };
  return { payload, entidadeAtiva, claims, permissoes: permsEntidade };
}

/**
 * Monta a cláusula de filtros PostgREST comum a `GET /faturamento` e
 * `GET /faturamento/resumo`, a partir do resultado já validado de
 * `parseFiltros` (contracts/faturamento-api.md — mesmos filtros nos 2
 * endpoints). Sempre inclui `id_empresa=eq.<entidadeAtiva>` (Princípio II).
 * @param {number} entidadeAtiva
 * @param {ReturnType<import('../lib/hub-faturamento-dto').parseFiltros>} f
 * @returns {string[]}
 */
function montarFiltrosQuery(entidadeAtiva, f) {
  const filtros = [
    `id_empresa=eq.${entidadeAtiva}`,
    `data_referencia=gte.${f.de}`,
    `data_referencia=lte.${f.ate}`,
  ];
  if (f.categoria) filtros.push(`descricao=eq.${encodeURIComponent(f.categoria)}`);
  if (f.entregadorId !== null) filtros.push(`entregador_id=eq.${f.entregadorId}`);
  if (f.subpraca) filtros.push(`subpraca=eq.${encodeURIComponent(f.subpraca)}`);
  if (f.comEntregador === true) filtros.push('entregador_id=not.is.null');
  else if (f.comEntregador === false) filtros.push('entregador_id=is.null');
  return filtros;
}

/**
 * Neutraliza + quota (RFC 4180) 1 célula de texto livre do CSV de
 * faturamento. Aplicado a TODO campo de texto livre potencialmente
 * influenciado pelo arquivo original importado (categoria/entregadorNome/
 * subpraca/praca/periodo) — FR-007 exige "toda célula", não só as 2
 * citadas nominalmente em tasks.md 5.1.4 (categoria/entregadorNome); os
 * demais campos de texto livre do mesmo registro recebem a MESMA proteção
 * por construção, defesa em profundidade sem custo adicional (mesma função
 * já reusada em `lib/hub-csv.js`). `dataReferencia`/`valor` NÃO passam por
 * aqui — formato fixo (`YYYY-MM-DD` / decimal, nunca começam com
 * `= + - @`, gerados pelo próprio backend, nunca texto livre do usuário).
 * @param {string|null} valor
 * @returns {string}
 */
function celulaCsv(valor) {
  return quotarCelulaCsv(escaparCelulaCsvInjection(valor === null || valor === undefined ? '' : valor));
}

/**
 * `GET /faturamento?format=csv` — export streaming em lotes de
 * `LOTE_EXPORT_CSV` linhas (research.md Decision 5): busca 1 lote via
 * paginação `Range` do PostgREST, converte para linhas CSV, `res.write()`,
 * descarta o lote da memória antes do próximo — o corpo completo do CSV
 * NUNCA existe de uma vez no processo (FR-006). Filtro vazio -> arquivo só
 * com cabeçalho, `200` (tasks.md 5.1.6 — nunca erro).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} entidadeAtiva
 * @param {object} claims
 * @param {object} payload - do accessToken (`payload.sub` -> auditoria)
 * @param {ReturnType<import('../lib/hub-faturamento-dto').parseFiltros>} f
 */
async function exportarCsv(req, res, entidadeAtiva, claims, payload, f) {
  const filtrosBase = montarFiltrosQuery(entidadeAtiva, f);
  filtrosBase.push('order=data_referencia.desc,id.desc');
  filtrosBase.push(
    'select=data_referencia,descricao,valor::text,entregador_id,subpraca,praca,periodo,entregador:Entregador(nome)'
  );

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="faturamento-${f.de}_${f.ate}.csv"`);
  res.write(`${CABECALHO_CSV.join(',')}\r\n`);

  let from = 0;
  let totalLinhas = 0;
  for (;;) {
    const to = from + LOTE_EXPORT_CSV - 1;
    // eslint-disable-next-line no-await-in-loop -- paginação SEQUENCIAL é
    // intencional (Decision 5): 1 lote de cada vez, nunca em paralelo —
    // é exatamente isso que limita a memória a ~1 lote, não ao total do
    // período.
    const lote = await hubPostgrestRequest(
      `FaturamentoLancamento?${filtrosBase.join('&')}`,
      'GET', null, claims,
      { range: { from, to } }
    );
    const linhas = lote || [];
    if (linhas.length === 0) break;

    let bloco = '';
    for (const row of linhas) {
      const comEntregador = row.entregador_id !== null && row.entregador_id !== undefined;
      const entregadorNome = comEntregador && row.entregador ? row.entregador.nome : '';
      bloco += [
        row.data_referencia,
        celulaCsv(row.descricao),
        row.valor,
        celulaCsv(entregadorNome),
        celulaCsv(row.subpraca),
        celulaCsv(row.praca),
        celulaCsv(row.periodo),
      ].join(',') + '\r\n';
    }
    res.write(bloco);
    totalLinhas += linhas.length;

    if (linhas.length < LOTE_EXPORT_CSV) break; // último lote (parcial)
    from += LOTE_EXPORT_CSV;
  }

  // 5.1.5 — auditoria só no SUCESSO (arquivo completo já foi escrito ao
  // cliente), best-effort mas aguardado (mesmo padrão de
  // routes/hub-importacoes.js#original_baixado). Nenhum dado sensível em
  // `detalhes` — só metadados do filtro aplicado e a contagem.
  await registrarAuditoria({
    idEmpresa: entidadeAtiva,
    usuarioId: payload.sub,
    acao: 'faturamento.csv_exportado',
    recurso: 'FaturamentoLancamento',
    recursoId: null,
    detalhes: {
      de: f.de, ate: f.ate, categoria: f.categoria, entregadorId: f.entregadorId,
      subpraca: f.subpraca, comEntregador: f.comEntregador, totalLinhas,
    },
    ip: req.ip,
    claims,
  });

  return res.end();
}

// ────────────────────────────────────────────────────────────────────────────
// GET /faturamento — lista paginada de lançamentos (JSON; `?format=csv` —
// task 5.1) — task 3.2
// ────────────────────────────────────────────────────────────────────────────

router.get('/', requirePermission('faturamento.listar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'faturamento.listar');
    if (!ctx) return;
    const { payload, entidadeAtiva, claims } = ctx;

    const f = parseFiltros(req.query);
    if (!f.ok) {
      return res.status(400).json({ erro: f.erro });
    }

    if (req.query.format === 'csv') {
      // Decision 9 — checagem INLINE e EXPLÍCITA de `faturamento.exportar`
      // (união flat, `req.hubUsuarioId` setado pelo `requirePermission` de
      // nível de rota) ANTES de qualquer query ao PostgREST — ter
      // `faturamento.listar` NUNCA autoriza extrair o arquivo.
      const permissoesFlat = await obterPermissoesEfetivas(req.hubUsuarioId);
      if (!permissoesFlat.has('faturamento.exportar')) {
        return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
      }
      return exportarCsv(req, res, entidadeAtiva, claims, payload, f);
    }

    const { page, pageSize, from, to } = parsePaginacao(req.query);

    const filtros = montarFiltrosQuery(entidadeAtiva, f);
    filtros.push('order=data_referencia.desc,id.desc');
    filtros.push(
      'select=id,data_referencia,data_lancamento,data_repasse,descricao,valor::text,'
      + 'entregador_id,subpraca,praca,periodo,entregador:Entregador(nome)'
    );

    // FR-012 (tratado de forma idêntica ao filtro vazio de importações/
    // motoristas): período/filtro vazio NUNCA é erro — resposta 200 com
    // items:[] e total:0. Não há necessidade de um caminho especial: a
    // query PostgREST já retorna 0 linhas naturalmente quando o filtro não
    // casa nada, e o `count=exact` já reporta total:0 nesse caso.
    const { data: linhas, total } = await hubPostgrestRequest(
      `FaturamentoLancamento?${filtros.join('&')}`,
      'GET', null, claims,
      { count: true, range: { from, to } }
    );

    return res.status(200).json({
      items: (linhas || []).map(mapFaturamentoListItem),
      total: total || 0,
      page,
      pageSize,
    });
  } catch (e) {
    console.error('[hub-faturamento] erro em GET /faturamento:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

/**
 * Monta o corpo do `POST /rpc/hub_faturamento_totais|hub_faturamento_agrupado`
 * — TODOS os parâmetros SEMPRE presentes (as funções SQL não têm `DEFAULT`,
 * migration 0027), filtros ausentes viram `null` explícito (a própria RPC
 * já trata `p_x IS NULL` como "sem filtro", research.md Decision 2).
 * @param {number} entidadeAtiva
 * @param {ReturnType<import('../lib/hub-faturamento-dto').parseFiltros>} f
 * @returns {object}
 */
function montarParamsRpc(entidadeAtiva, f) {
  return {
    p_id_empresa: entidadeAtiva,
    p_de: f.de,
    p_ate: f.ate,
    p_categoria: f.categoria,
    p_entregador_id: f.entregadorId,
    p_subpraca: f.subpraca,
    p_com_entregador: f.comEntregador,
  };
}

/**
 * Resolve `Entregador.nome` para o subconjunto de `chave`s numéricas
 * (ids) presentes num resultado de `hub_faturamento_agrupado` com
 * `groupBy=entregador` — NUNCA a tabela inteira, só os ids que de fato
 * aparecem no agrupamento, escopados por `entidadeAtiva` (defesa em
 * profundidade complementar à RLS, mesmo padrão de
 * `routes/hub-motoristas.js#entregadorExisteNoEscopo`).
 * @param {Array<{chave:string}>} grupos
 * @param {number} entidadeAtiva
 * @param {object} claims
 * @returns {Promise<Map<string,string>>}
 */
async function resolverNomesEntregadores(grupos, entidadeAtiva, claims) {
  const ids = [...new Set(
    (grupos || [])
      .map((g) => g.chave)
      .filter((chave) => chave !== CHAVE_AGREGADOS_BONUS)
  )];
  if (ids.length === 0) return new Map();
  const linhas = await hubPostgrestRequest(
    `Entregador?id=in.(${ids.join(',')})&id_empresa=eq.${entidadeAtiva}&select=id,nome`,
    'GET', null, claims
  );
  const mapa = new Map();
  for (const row of linhas || []) {
    mapa.set(String(row.id), row.nome);
  }
  return mapa;
}

// ────────────────────────────────────────────────────────────────────────────
// GET /faturamento/resumo — cards (sem groupBy) / agregados (com groupBy) —
// task 4.1
// ────────────────────────────────────────────────────────────────────────────

router.get('/resumo', requirePermission('faturamento.consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'faturamento.consultar');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    const f = parseFiltros(req.query);
    if (!f.ok) {
      return res.status(400).json({ erro: f.erro });
    }

    const groupByBruto = req.query.groupBy;
    if (groupByBruto !== undefined && !groupByValido(groupByBruto)) {
      return res.status(400).json({ erro: 'GROUP_BY_INVALIDO' });
    }

    if (!groupByBruto) {
      // FR-003 — cards. A RPC já retorna 1 linha zerada (COALESCE/subquery
      // vazia) quando não há lançamento no filtro — FR-012 satisfeito sem
      // caminho especial aqui (mapResumoCards ainda cobre defensivamente
      // um retorno vazio inesperado).
      const linhas = await hubPostgrestRequest(
        'rpc/hub_faturamento_totais', 'POST',
        montarParamsRpc(entidadeAtiva, f), claims
      );
      return res.status(200).json(mapResumoCards(linhas && linhas[0]));
    }

    // FR-004 — agregado por dia/categoria/entregador.
    const linhasAgrupado = await hubPostgrestRequest(
      'rpc/hub_faturamento_agrupado', 'POST',
      { ...montarParamsRpc(entidadeAtiva, f), p_group_by: groupByBruto }, claims
    );
    const grupos = linhasAgrupado || [];
    const nomeMap = groupByBruto === 'entregador'
      ? await resolverNomesEntregadores(grupos, entidadeAtiva, claims)
      : new Map();

    return res.status(200).json({
      groupBy: groupByBruto,
      grupos: mapResumoAgrupado(grupos, groupByBruto, nomeMap),
    });
  } catch (e) {
    console.error('[hub-faturamento] erro em GET /faturamento/resumo:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

module.exports = { router, resolverContextoEntidade, montarFiltrosQuery, montarParamsRpc };

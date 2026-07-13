// hub-performance (S7 do hub de frota) — routes/hub-performance.js
//
// GET /api/v1/performance (lista paginada, JSON e `?format=csv`) e
// GET /api/v1/performance/resumo (cards/agregados) — FASE 2/3/4 (tasks.md
// 2.2/3.1/4.1). Ref: docs/specs/hub-performance/contracts/performance-api.md,
// data-model.md, research.md.
//
// Arquivo 100% NOVO — nenhuma linha de server.js legado é editada (mesmo
// padrão de routes/hub-faturamento.js/hub-importacoes.js/hub-motoristas.js).
// id_empresa SEMPRE resolvido da claim `entidade_ativa` do accessToken
// (Princípio II) — nunca da query/corpo. Superfície 100% leitura sobre
// `PerformanceTurno` (FR-010) — nenhum INSERT/UPDATE/DELETE nesta rota.
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
  mapPerformanceListItem,
  formatarTaxasReais,
  groupByValido,
  mapResumoCards,
  mapResumoAgrupado,
} = require('../lib/hub-performance-dto');
const {
  TERMO_BUSCA_ENTREGADOR_MIN_CHARS,
  termoBuscaValido,
  buscarEntregadoresPorNome,
} = require('../lib/hub-motoristas-similaridade');

const router = express.Router();

// Export CSV (research.md Decision 5, reuso de hub-faturamento) — lote de
// LEITURA paginada, não de escrita.
const LOTE_EXPORT_CSV = 1000;
const CABECALHO_CSV = [
  'dataPeriodo', 'periodo', 'entregadorNome', 'subpraca', 'praca',
  'corridasOfertadas', 'corridasAceitas', 'corridasRejeitadas', 'corridasCompletadas',
  'corridasCanceladas', 'pedidosConcluidos', 'tempoDisponivelPct', 'taxas',
];

// ────────────────────────────────────────────────────────────────────────────
// Helpers (DUPLICADOS deliberadamente — mesmo padrão de routes/hub-faturamento.js
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
 * routes/hub-faturamento.js#resolverContextoEntidade).
 * Envia a resposta de erro e retorna `null` em caso de falha (401/400/403);
 * retorna o contexto em caso de sucesso.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} permissao - ex.: `performance.listar`
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
 * Monta a cláusula de filtros PostgREST comum a `GET /performance` e
 * `GET /performance/resumo`, a partir do resultado já validado de
 * `parseFiltros` (contracts/performance-api.md — mesmos filtros nos 2
 * endpoints). Sempre inclui `id_empresa=eq.<entidadeAtiva>` (Princípio II)
 * e filtra por `data_periodo` (a "data do turno", Cenário 5).
 * @param {number} entidadeAtiva
 * @param {ReturnType<import('../lib/hub-performance-dto').parseFiltros>} f
 * @returns {string[]}
 */
function montarFiltrosQuery(entidadeAtiva, f) {
  const filtros = [
    `id_empresa=eq.${entidadeAtiva}`,
    `data_periodo=gte.${f.de}`,
    `data_periodo=lte.${f.ate}`,
  ];
  if (f.periodo) filtros.push(`periodo=eq.${encodeURIComponent(f.periodo)}`);
  if (f.subpraca) filtros.push(`subpraca=eq.${encodeURIComponent(f.subpraca)}`);
  if (f.entregadorId !== null) filtros.push(`entregador_id=eq.${f.entregadorId}`);
  return filtros;
}

/**
 * Neutraliza + quota (RFC 4180) 1 célula de texto livre do CSV de
 * performance. Aplicado a TODO campo de texto livre potencialmente
 * influenciado pelo arquivo original importado (periodo/entregadorNome/
 * subpraca/praca) — FR-007 (mesmo padrão de routes/hub-faturamento.js).
 * `dataPeriodo`/campos numéricos NÃO passam por aqui — formato fixo,
 * gerados pelo próprio backend, nunca texto livre do usuário.
 * @param {string|null} valor
 * @returns {string}
 */
function celulaCsv(valor) {
  return quotarCelulaCsv(escaparCelulaCsvInjection(valor === null || valor === undefined ? '' : valor));
}

/**
 * `GET /performance?format=csv` — export streaming em lotes de
 * `LOTE_EXPORT_CSV` linhas (research.md Decision 5): busca 1 lote via
 * paginação `Range` do PostgREST, converte para linhas CSV, `res.write()`,
 * descarta o lote da memória antes do próximo — o corpo completo do CSV
 * NUNCA existe de uma vez no processo (FR-006). Filtro vazio -> arquivo só
 * com cabeçalho, `200` (tasks.md 4.1.6 — nunca erro).
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} entidadeAtiva
 * @param {object} claims
 * @param {object} payload - do accessToken (`payload.sub` -> auditoria)
 * @param {ReturnType<import('../lib/hub-performance-dto').parseFiltros>} f
 */
async function exportarCsv(req, res, entidadeAtiva, claims, payload, f) {
  const filtrosBase = montarFiltrosQuery(entidadeAtiva, f);
  filtrosBase.push('order=data_periodo.desc,id.desc');
  filtrosBase.push(
    'select=data_periodo,periodo,subpraca,praca,corridas_ofertadas,corridas_aceitas,'
    + 'corridas_rejeitadas,corridas_completadas,corridas_canceladas,pedidos_concluidos,'
    + 'tempo_disponivel_pct,taxas_centavos,entregador:Entregador(nome)'
  );

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="performance-${f.de}_${f.ate}.csv"`);
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
      `PerformanceTurno?${filtrosBase.join('&')}`,
      'GET', null, claims,
      { range: { from, to } }
    );
    const linhas = lote || [];
    if (linhas.length === 0) break;

    let bloco = '';
    for (const row of linhas) {
      const entregadorNome = row.entregador ? row.entregador.nome : '';
      const tempoDisponivelPct = row.tempo_disponivel_pct === null || row.tempo_disponivel_pct === undefined
        ? ''
        : row.tempo_disponivel_pct;
      bloco += [
        row.data_periodo,
        celulaCsv(row.periodo),
        celulaCsv(entregadorNome),
        celulaCsv(row.subpraca),
        celulaCsv(row.praca),
        row.corridas_ofertadas,
        row.corridas_aceitas,
        row.corridas_rejeitadas,
        row.corridas_completadas,
        row.corridas_canceladas,
        row.pedidos_concluidos === null || row.pedidos_concluidos === undefined ? '' : row.pedidos_concluidos,
        tempoDisponivelPct,
        formatarTaxasReais(row.taxas_centavos),
      ].join(',') + '\r\n';
    }
    res.write(bloco);
    totalLinhas += linhas.length;

    if (linhas.length < LOTE_EXPORT_CSV) break; // último lote (parcial)
    from += LOTE_EXPORT_CSV;
  }

  // 4.1.5 — auditoria só no SUCESSO (arquivo completo já foi escrito ao
  // cliente), best-effort mas aguardado (mesmo padrão de
  // routes/hub-faturamento.js#exportarCsv). Nenhum dado sensível em
  // `detalhes` — só metadados do filtro aplicado e a contagem.
  await registrarAuditoria({
    idEmpresa: entidadeAtiva,
    usuarioId: payload.sub,
    acao: 'performance.csv_exportado',
    recurso: 'PerformanceTurno',
    recursoId: null,
    detalhes: {
      de: f.de, ate: f.ate, periodo: f.periodo, subpraca: f.subpraca,
      entregadorId: f.entregadorId, totalLinhas,
    },
    ip: req.ip,
    claims,
  });

  return res.end();
}

// ────────────────────────────────────────────────────────────────────────────
// GET /performance — lista paginada de turnos (JSON; `?format=csv` —
// task 4.1) — task 2.2
// ────────────────────────────────────────────────────────────────────────────

router.get('/', requirePermission('performance.listar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'performance.listar');
    if (!ctx) return;
    const { payload, entidadeAtiva, claims } = ctx;

    const f = parseFiltros(req.query);
    if (!f.ok) {
      return res.status(400).json({ erro: f.erro });
    }

    if (req.query.format === 'csv') {
      // Decision 9 — checagem INLINE e EXPLÍCITA de `performance.exportar`
      // (união flat, `req.hubUsuarioId` setado pelo `requirePermission` de
      // nível de rota) ANTES de qualquer query ao PostgREST — ter
      // `performance.listar` NUNCA autoriza extrair o arquivo.
      const permissoesFlat = await obterPermissoesEfetivas(req.hubUsuarioId);
      if (!permissoesFlat.has('performance.exportar')) {
        return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
      }
      return exportarCsv(req, res, entidadeAtiva, claims, payload, f);
    }

    const { page, pageSize, from, to } = parsePaginacao(req.query);

    const filtros = montarFiltrosQuery(entidadeAtiva, f);
    filtros.push('order=data_periodo.desc,id.desc');
    filtros.push(
      'select=id,data_periodo,periodo,entregador_id,subpraca,praca,corridas_ofertadas,'
      + 'corridas_aceitas,corridas_rejeitadas,corridas_completadas,corridas_canceladas,'
      + 'pedidos_concluidos,tempo_disponivel_pct,taxas_centavos,entregador:Entregador(nome)'
    );

    // FR-011: período/filtro vazio NUNCA é erro — resposta 200 com
    // items:[] e total:0. A query PostgREST já retorna 0 linhas
    // naturalmente quando o filtro não casa nada, e `count=exact` já
    // reporta total:0 nesse caso (mesmo padrão de hub-faturamento).
    const { data: linhas, total } = await hubPostgrestRequest(
      `PerformanceTurno?${filtros.join('&')}`,
      'GET', null, claims,
      { count: true, range: { from, to } }
    );

    return res.status(200).json({
      items: (linhas || []).map(mapPerformanceListItem),
      total: total || 0,
      page,
      pageSize,
    });
  } catch (e) {
    console.error('[hub-performance] erro em GET /performance:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /performance/areas — subpraças distintas visíveis à entidade ativa
// (uiux-hub pós-F4: alimenta o combobox do filtro "Subpraça", no lugar do
// campo de texto livre). Mesma fonte do endpoint homônimo de motoristas: a
// view `hub_areas_por_entregador` (0024, união de FaturamentoLancamento +
// PerformanceTurno), consultada com os claims do usuário — a RLS das tabelas
// base já limita à empresa do escopo.
// ────────────────────────────────────────────────────────────────────────────

router.get('/areas', requirePermission('performance.listar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'performance.listar');
    if (!ctx) return;
    const { claims } = ctx;

    const linhas = await hubPostgrestRequest(
      'hub_areas_por_entregador?select=subpraca',
      'GET', null, claims
    );
    const distintas = [...new Set((linhas || [])
      .map((row) => row && row.subpraca)
      .filter((s) => typeof s === 'string' && s.trim() !== ''))];
    distintas.sort((a, b) => a.localeCompare(b, 'pt-BR'));

    return res.status(200).json({ areas: distintas });
  } catch (e) {
    console.error('[hub-performance] erro em GET /performance/areas:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /performance/entregadores — busca de entregador por nome
// (hub-motorista-canonico FASE 2 / WS-B, tasks.md 2.2, contracts/
// api-motorista-canonico.md §WS-B — espelho de routes/hub-faturamento.js,
// mesma validação/parametrização/limite, gate `performance.listar`).
// ────────────────────────────────────────────────────────────────────────────

router.get('/entregadores', requirePermission('performance.listar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'performance.listar');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    const busca = typeof req.query.busca === 'string' ? req.query.busca : '';
    if (!termoBuscaValido(busca, TERMO_BUSCA_ENTREGADOR_MIN_CHARS)) {
      return res.status(422).json({ erro: 'busca_invalida' });
    }

    const items = await buscarEntregadoresPorNome(entidadeAtiva, busca.trim(), claims);
    return res.status(200).json({ items });
  } catch (e) {
    console.error('[hub-performance] erro em GET /performance/entregadores:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

/**
 * Monta o corpo do `POST /rpc/hub_performance_totais|hub_performance_agrupado`
 * — TODOS os parâmetros SEMPRE presentes (as funções SQL não têm `DEFAULT`,
 * migration 0030), filtros ausentes viram `null` explícito (a própria RPC
 * já trata `p_x IS NULL` como "sem filtro").
 * @param {number} entidadeAtiva
 * @param {ReturnType<import('../lib/hub-performance-dto').parseFiltros>} f
 * @returns {object}
 */
function montarParamsRpc(entidadeAtiva, f) {
  return {
    p_id_empresa: entidadeAtiva,
    p_de: f.de,
    p_ate: f.ate,
    p_periodo: f.periodo,
    p_subpraca: f.subpraca,
    p_entregador_id: f.entregadorId,
  };
}

/**
 * Resolve `Entregador.nome` para o subconjunto de `chave`s numéricas
 * (ids) presentes num resultado de `hub_performance_agrupado` com
 * `groupBy=entregador` — NUNCA a tabela inteira, só os ids que de fato
 * aparecem no agrupamento, escopados por `entidadeAtiva` (defesa em
 * profundidade complementar à RLS, mesmo padrão de
 * routes/hub-faturamento.js#resolverNomesEntregadores).
 * @param {Array<{chave:string}>} grupos
 * @param {number} entidadeAtiva
 * @param {object} claims
 * @returns {Promise<Map<string,string>>}
 */
async function resolverNomesEntregadores(grupos, entidadeAtiva, claims) {
  const ids = [...new Set((grupos || []).map((g) => g.chave))];
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
// GET /performance/resumo — cards (sem groupBy) / agregados (com groupBy) —
// task 3.1
// ────────────────────────────────────────────────────────────────────────────

router.get('/resumo', requirePermission('performance.consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'performance.consultar');
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
      // FR-003 — cards. A RPC já retorna 1 linha zerada quando não há
      // turno no filtro — FR-011 satisfeito sem caminho especial aqui
      // (mapResumoCards ainda cobre defensivamente um retorno vazio
      // inesperado).
      const linhas = await hubPostgrestRequest(
        'rpc/hub_performance_totais', 'POST',
        montarParamsRpc(entidadeAtiva, f), claims
      );
      return res.status(200).json(mapResumoCards(linhas && linhas[0]));
    }

    // FR-004 — agregado por dia/período/entregador.
    const linhasAgrupado = await hubPostgrestRequest(
      'rpc/hub_performance_agrupado', 'POST',
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
    console.error('[hub-performance] erro em GET /performance/resumo:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

module.exports = { router, resolverContextoEntidade, montarFiltrosQuery, montarParamsRpc };

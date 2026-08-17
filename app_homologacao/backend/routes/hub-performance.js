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

const { decodificarAccessToken, lerAccessTokenDoRequest } = require('../lib/hub-access-token');
const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const { obterPermissoesEfetivas, obterPermissoesEfetivasPorEntidade } = require('../lib/hub-rbac-cache');
const { requirePermission } = require('../middleware/hub-require-permission');
const { requireModuloAtivo } = require('../middleware/hub-require-modulo');
const { registrarAuditoria } = require('../lib/hub-auditoria');
const { escaparCelulaCsvInjection, quotarCelulaCsv } = require('../lib/hub-csv');
const {
  validarMeta,
  chaveMeta,
  metaAplicavel,
  avaliarRegistro,
} = require('../lib/hub-performance-meta');
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
// impeccable r24: as três últimas colunas levam o JULGAMENTO para dentro do
// arquivo. O CSV é o artefato que vai para a conversa com o parceiro logístico,
// e até aqui ele saía sem a informação de meta — a tela reprovava um turno e o
// arquivo que embasava a cobrança não dizia nada disso.
//
// Metas em PERCENTUAL (0..100), não em fração: a coluna vizinha
// `tempoDisponivelPct` já está nessa escala, e quem abre no Excel lê
// porcentagem. Vazio = não há meta para aquele cruzamento (nem específica nem
// padrão) — ausência, nunca zero.
const CABECALHO_CSV = [
  'dataPeriodo', 'periodo', 'entregadorNome', 'subpraca', 'praca',
  'corridasOfertadas', 'corridasAceitas', 'corridasRejeitadas', 'corridasCompletadas',
  'corridasCanceladas', 'pedidosConcluidos', 'tempoDisponivelPct', 'taxas',
  'metaAceitacaoPct', 'metaConclusaoPct', 'metaTempoDisponivelPct', 'abaixoDaMeta',
];

/** Teto de metas lidas de uma vez — a tela carrega esta lista a cada abertura. */
const LIMITE_METAS = 500;

/** Fração 0..1 -> percentual com 2 casas, ou vazio quando não há meta. */
function metaParaCsv(fracao) {
  return fracao === undefined ? '' : (Math.round(fracao * 10000) / 100).toFixed(2);
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers de domínio (DUPLICADOS deliberadamente com routes/hub-faturamento.js:
// `montarFiltrosQuery`/`montarParamsRpc` são específicos da forma de cada
// tabela e divergem, então cada rota mantém a sua cópia).
//
// `decodificarAccessToken` NÃO entra nessa regra — a pinagem de algoritmo é um
// controle de segurança e vive em `lib/hub-access-token.js`, fonte única.
// ────────────────────────────────────────────────────────────────────────────

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
  const accessToken = lerAccessTokenDoRequest(req);
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
    + 'tempo_disponivel_periodo_pct,taxas_centavos,entregador:Entregador(nome)'
  );

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="performance-${f.de}_${f.ate}.csv"`);
  // Metas carregadas UMA vez, antes do streaming: são poucas por entidade, e
  // buscá-las por lote multiplicaria a consulta pelo número de lotes.
  // Falha aqui NÃO derruba o export — o arquivo sai sem julgamento, com as
  // colunas de meta vazias, que é honesto (ausência, não aprovação).
  let metasPorChave = new Map();
  try {
    const linhasMeta = await hubPostgrestRequest(
      `PerformanceMeta?id_empresa=eq.${entidadeAtiva}&select=praca,periodo,indicador,valor&limit=${LIMITE_METAS}`,
      'GET',
      null,
      claims
    );
    metasPorChave = new Map(
      (Array.isArray(linhasMeta) ? linhasMeta : []).map((m) => [
        chaveMeta(m.praca, m.periodo, m.indicador),
        Number.parseFloat(m.valor),
      ])
    );
  } catch (e) {
    console.error('[hub-performance] metas indisponíveis no export CSV (colunas vazias):', e.message);
  }

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
      const tempoDisponivelPct = row.tempo_disponivel_periodo_pct === null
        || row.tempo_disponivel_periodo_pct === undefined
        ? ''
        : row.tempo_disponivel_periodo_pct;
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
        metaParaCsv(metaAplicavel(metasPorChave, row.praca, row.periodo, 'aceitacao')),
        metaParaCsv(metaAplicavel(metasPorChave, row.praca, row.periodo, 'conclusao')),
        metaParaCsv(metaAplicavel(metasPorChave, row.praca, row.periodo, 'tempo_disponivel')),
        // Lista os indicadores abaixo da meta, separados por `;` — vírgula
        // seria o separador do próprio CSV. Vazio = nada abaixo, e é
        // distinguível de "sem meta" porque as colunas de meta ficam vazias.
        celulaCsv(
          avaliarRegistro(row, metasPorChave)
            .filter((a) => a.abaixo)
            .map((a) => a.indicador)
            .join(';')
        ),
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

router.get('/', requireModuloAtivo('performance'), requirePermission('performance.listar'), async (req, res) => {
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
      + 'pedidos_concluidos,tempo_disponivel_periodo_pct,taxas_centavos,entregador:Entregador(nome)'
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

router.get('/areas', requireModuloAtivo('performance'), requirePermission('performance.listar'), async (req, res) => {
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

router.get('/entregadores', requireModuloAtivo('performance'), requirePermission('performance.listar'), async (req, res) => {
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

router.get('/resumo', requireModuloAtivo('performance'), requirePermission('performance.consultar'), async (req, res) => {
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


// ---------------------------------------------------------------------------
// Metas por praça × turno (impeccable r24 parte 2, migration 0048)
//
// Decisão do operador (2026-08-16): o patamar é contratual, varia por praça E
// turno, e quem define é o ADMIN DA ENTIDADE — daí a permissão própria
// `performance.metas_gerenciar`, separada de `performance.consultar` (ver a
// meta na tela não é o mesmo que mudá-la).
//
// LER as metas exige só `performance.consultar`: a tela de performance precisa
// delas para marcar quem está abaixo, e negar a leitura a quem já vê os
// números tornaria a marcação impossível sem ganhar nenhuma proteção.
//
// `requireModuloAtivo('performance')` nas três: estas são as PRIMEIRAS rotas
// de ESCRITA do módulo, e sem o gate desativar o módulo para uma entidade
// deixaria de ter efeito justamente onde passa a haver escrita — apontado por
// revisão adversarial em 2026-08-16. As rotas de LEITURA pré-existentes deste
// módulo (e as de motoristas/faturamento) seguem sem o gate: é lacuna anterior
// a esta feature, declarada e não corrigida aqui para não misturar escopo.
// ---------------------------------------------------------------------------

const COLUNAS_META = 'id,praca,periodo,indicador,valor,atualizado_em';

router.get('/metas', requireModuloAtivo('performance'), requirePermission('performance.consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'performance.consultar');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    // Sem barra inicial: o helper faz `${baseUrl}/${endpoint}` e uma barra
    // aqui produz `//PerformanceMeta`, que o PostgREST rejeita com PGRST125
    // ("Invalid path"). Todos os endpoints do repo são nomes de tabela nus.
    const linhas = await hubPostgrestRequest(
      `PerformanceMeta?id_empresa=eq.${entidadeAtiva}&select=${COLUNAS_META}`
      + '&order=praca.asc,periodo.asc,indicador.asc'
      // Teto explícito: a tela de Performance carrega esta lista a CADA
      // abertura, para qualquer um com `performance.consultar`. Sem limite, um
      // admin da própria entidade que cadastrasse metas em massa degradaria a
      // tela para os colegas. 500 é folga larga sobre o teto plausível
      // (10 praças × 7 turnos × 3 indicadores = 210).
      + `&limit=${LIMITE_METAS}`,
      'GET',
      null,
      claims
    );

    return res.json({
      metas: (Array.isArray(linhas) ? linhas : []).map((l) => ({
        id: l.id,
        praca: l.praca,
        periodo: l.periodo,
        indicador: l.indicador,
        // `valor` é numeric no banco e chega como string do PostgREST. Sai
        // como string pelo mesmo motivo do resto do hub: quem formata é a
        // tela, e converter aqui abriria espaço para perda de precisão sem
        // nenhum ganho.
        valor: String(l.valor),
        atualizadoEm: l.atualizado_em,
      })),
    });
  } catch (e) {
    console.error('[hub-performance] erro em GET /performance/metas:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.put('/metas', requireModuloAtivo('performance'), requirePermission('performance.metas_gerenciar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'performance.metas_gerenciar');
    if (!ctx) return;
    const { entidadeAtiva, claims, payload } = ctx;

    const v = validarMeta(req.body);
    if (!v.ok) return res.status(400).json({ erro: v.erro });
    const { praca, periodo, indicador, valor } = v.meta;

    // Upsert pela unique (id_empresa, praca, periodo, indicador) da 0048:
    // definir a meta duas vezes é a mesma operação, não um erro.
    const linhas = await hubPostgrestRequest(
      'PerformanceMeta?on_conflict=id_empresa,praca,periodo,indicador',
      'POST',
      { id_empresa: entidadeAtiva, praca, periodo, indicador, valor, atualizado_em: new Date().toISOString() },
      claims,
      // `resolution` e não um header cru: `hubPostgrestRequest` monta o
      // `Prefer` internamente e IGNORA qualquer `opts.headers` — passar o
      // header à mão seria silenciosamente descartado, e o upsert viraria um
      // INSERT que estoura chave duplicada na segunda gravação.
      { resolution: 'merge-duplicates' }
    );

    const salva = Array.isArray(linhas) ? linhas[0] : linhas;

    await registrarAuditoria({
      idEmpresa: entidadeAtiva,
      usuarioId: payload && payload.sub ? Number(payload.sub) : null,
      acao: 'performance_meta_definida',
      recurso: 'PerformanceMeta',
      recursoId: salva ? salva.id : null,
      detalhes: { praca, periodo, indicador, valor },
      ip: req.ip,
      claims,
    });

    return res.json({
      meta: {
        id: salva ? salva.id : null,
        praca,
        periodo,
        indicador,
        // Do BANCO, não do request: a coluna é `numeric(5,4)` e coage a escala
        // na gravação. Devolver o número que o cliente mandou faria a tela
        // mostrar um valor logo após salvar e outro depois de recarregar.
        valor: salva ? String(salva.valor) : String(valor),
        atualizadoEm: salva ? salva.atualizado_em : null,
      },
    });
  } catch (e) {
    console.error('[hub-performance] erro em PUT /performance/metas:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.delete('/metas/:id', requireModuloAtivo('performance'), requirePermission('performance.metas_gerenciar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'performance.metas_gerenciar');
    if (!ctx) return;
    const { entidadeAtiva, claims, payload } = ctx;

    // `/^\d+$/` antes do parseInt: `parseInt('7abc')` devolve 7 e `parseInt('1e3')`
    // devolve 1 — a rota apagaria uma meta que o cliente não pediu e a auditoria
    // registraria o número normalizado, não o que veio na URL.
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ erro: 'ID_INVALIDO' });
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ erro: 'ID_INVALIDO' });

    // `id_empresa` no filtro além do id: a RLS já barra fora do escopo, mas
    // depender só dela faria um id de outra entidade responder 204 sem apagar
    // nada — silêncio que o operador leria como sucesso.
    const apagadas = await hubPostgrestRequest(
      `PerformanceMeta?id=eq.${id}&id_empresa=eq.${entidadeAtiva}&select=${COLUNAS_META}`,
      'DELETE',
      null,
      claims
      // `return=representation` já é o padrão do helper — é ele que faz o
      // DELETE devolver a linha apagada, que é como se distingue "apagou" de
      // "não existia".
    );

    const linha = Array.isArray(apagadas) ? apagadas[0] : null;
    if (!linha) return res.status(404).json({ erro: 'META_NAO_ENCONTRADA' });

    await registrarAuditoria({
      idEmpresa: entidadeAtiva,
      usuarioId: payload && payload.sub ? Number(payload.sub) : null,
      acao: 'performance_meta_removida',
      recurso: 'PerformanceMeta',
      recursoId: id,
      detalhes: { praca: linha.praca, periodo: linha.periodo, indicador: linha.indicador },
      ip: req.ip,
      claims,
    });

    return res.status(204).end();
  } catch (e) {
    console.error('[hub-performance] erro em DELETE /performance/metas/:id:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

module.exports = { router, resolverContextoEntidade, montarFiltrosQuery, montarParamsRpc };

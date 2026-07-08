// hub-motoristas (S5 do hub de frota) — routes/hub-motoristas.js
//
// GET /api/v1/motoristas (lista paginada) e GET /api/v1/motoristas/:id
// (detalhe) — FASE 3 (tasks.md 3.1/3.2). Ref:
// docs/specs/hub-motoristas/contracts/motoristas-api.md, data-model.md,
// research.md.
//
// Arquivo 100% NOVO — nenhuma linha de server.js legado é editada (mesmo
// padrão de routes/hub-importacoes.js/hub-me.js). id_empresa SEMPRE
// resolvido da claim `entidade_ativa` do accessToken (Princípio II) — nunca
// da query/corpo.
//
// DECISÃO — filtro de nome (tolerante a acento) e filtro de área resolvidos
// no NODE, não empurrados ao PostgREST: PostgREST não expõe filtro nativo
// tolerante a acento sobre `Entregador.nome` sem uma migration adicional
// (computed field). Para não multiplicar migrations além do necessário
// (data-model.md/tasks.md desta fase já cobre a agregação de áreas via
// migration 0024), o handler de GET /motoristas:
//   1. empurra ao PostgREST os filtros baratos/exatos (id_empresa sempre,
//      ativo=eq. se informado, motorista_id is/is-not null se `comVinculo`
//      informado) — o conjunto resultante já é limitado ao escopo do
//      tenant, nunca "toda a tabela";
//   2. busca o mapa de áreas por entregador via a view `hub_areas_por_entregador`
//      (migration 0024), filtrando `entregador_id=in.(<ids-do-conjunto-candidato>)`
//      para nunca puxar dados de outros tenants;
//   3. aplica em JS o filtro de `nome` (normalizado — remove acento/caixa,
//      `lib/hub-motoristas-dto.js#nomeCasa`) e de `area` (`areaCasa`);
//   4. pagina em JS APÓS todos os filtros — `total` é o tamanho do array já
//      filtrado, o slice de página é o único array que sai pela API. Isso
//      ainda satisfaz "paginação calculada no lado do sistema" (contrato):
//      o filtro/paginação inteiros acontecem no backend, antes da resposta.
'use strict';

const express = require('express');
const jwt = require('jsonwebtoken');

const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const { obterPermissoesEfetivasPorEntidade } = require('../lib/hub-rbac-cache');
const { requirePermission } = require('../middleware/hub-require-permission');
const {
  parsePaginacao,
  nomeCasa,
  areaCasa,
  agruparAreasPorEntregador,
  mapMotoristaListItem,
  mapMotoristaDetalhe,
} = require('../lib/hub-motoristas-dto');

const router = express.Router();

// ────────────────────────────────────────────────────────────────────────────
// Helpers (DUPLICADOS deliberadamente — mesmo padrão de routes/hub-importacoes.js
// e routes/hub-me.js: cada arquivo de rota do hub mantém sua própria cópia
// destes helpers pequenos, sem import cross-domain)
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

/** Só dígitos, do início ao fim — mesmo padrão de routes/hub-importacoes.js
 * (`parseInt('123abc', 10)` retorna 123, ignora lixo à direita). */
function idValido(raw) {
  return typeof raw === 'string' && /^\d+$/.test(raw);
}

/**
 * Resolve payload+entidadeAtiva+claims do accessToken e confirma que a
 * ENTIDADE ATIVA concede `permissao` (não só a união flat já barrada pelo
 * `requirePermission` de nível de rota — mesmo padrão de
 * routes/hub-importacoes.js#resolverContextoEntidade / GET /auditoria em
 * routes/hub-me.js). Envia a resposta de erro e retorna `null` em caso de
 * falha (401/400/403); retorna o contexto em caso de sucesso.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} permissao - ex.: `motoristas.listar`
 * @returns {Promise<{payload:object, entidadeAtiva:number, claims:object}|null>}
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
  return { payload, entidadeAtiva, claims };
}

/**
 * Busca o mapa de áreas por entregador (view `hub_areas_por_entregador`,
 * migration 0024) só para os ids informados — nunca a view inteira.
 * @param {number[]} entregadorIds
 * @param {object} claims
 * @returns {Promise<Map<number, Array<{subpraca:string, dataMaisRecente:string}>>>}
 */
async function buscarAreasPorEntregador(entregadorIds, claims) {
  if (!entregadorIds || entregadorIds.length === 0) return new Map();
  const linhas = await hubPostgrestRequest(
    `hub_areas_por_entregador?entregador_id=in.(${entregadorIds.join(',')})`
    + '&select=entregador_id,subpraca,data_mais_recente',
    'GET', null, claims
  );
  return agruparAreasPorEntregador(linhas || []);
}

// ────────────────────────────────────────────────────────────────────────────
// GET /motoristas — lista paginada (task 3.1)
// ────────────────────────────────────────────────────────────────────────────

router.get('/', requirePermission('motoristas.listar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'motoristas.listar');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    const { nome, area } = req.query;
    const ativoQuery = req.query.ativo;
    const comVinculoQuery = req.query.comVinculo;
    const { page, pageSize } = parsePaginacao(req.query);

    // 1. filtros baratos/exatos empurrados ao PostgREST (sempre escopado por
    // id_empresa — Princípio II).
    const filtros = [`id_empresa=eq.${entidadeAtiva}`];
    if (ativoQuery === 'true' || ativoQuery === 'false') {
      filtros.push(`ativo=eq.${ativoQuery}`);
    }
    if (comVinculoQuery === 'true') {
      filtros.push('motorista_id=not.is.null');
    } else if (comVinculoQuery === 'false') {
      filtros.push('motorista_id=is.null');
    }
    filtros.push('order=nome.asc');
    filtros.push('select=id,nome,ativo,motorista_id');

    const candidatos = await hubPostgrestRequest(
      `Entregador?${filtros.join('&')}`,
      'GET', null, claims
    );
    const linhas = candidatos || [];

    // 3.1.3 — estado vazio: nunca erro.
    if (linhas.length === 0) {
      return res.status(200).json({ items: [], total: 0, page, pageSize });
    }

    // 2. mapa de áreas SÓ para os candidatos já filtrados por escopo.
    const areasMap = await buscarAreasPorEntregador(linhas.map((r) => r.id), claims);

    // 3. filtro de nome/área em JS (tolerante a acento/caixa).
    const filtrados = linhas.filter((row) => {
      const areasDoRow = areasMap.get(row.id) || [];
      return nomeCasa(nome, row.nome) && areaCasa(area, areasDoRow);
    });

    // 4. paginação em JS, após todos os filtros.
    const total = filtrados.length;
    const inicio = (page - 1) * pageSize;
    const pagina = filtrados.slice(inicio, inicio + pageSize);

    const items = pagina.map((row) => mapMotoristaListItem(row, areasMap.get(row.id) || []));

    return res.status(200).json({ items, total, page, pageSize });
  } catch (e) {
    console.error('[hub-motoristas] erro em GET /motoristas:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /motoristas/:id — detalhe com indicadores all-time (task 3.2)
// ────────────────────────────────────────────────────────────────────────────

router.get('/:id', requirePermission('motoristas.consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'motoristas.consultar');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = parseInt(req.params.id, 10);

    // 3.2.2 — 404 se fora do escopo do token: filtro explícito por
    // id_empresa (defesa em profundidade — RLS já nega a linha via escopo).
    // Embed nativo do PostgREST via FK física Entregador.motorista_id ->
    // ContaMotorista(id) (migration 0021) — confirmado empiricamente no
    // teste de integração.
    const linhas = await hubPostgrestRequest(
      `Entregador?id=eq.${id}&id_empresa=eq.${entidadeAtiva}`
      + '&select=id,nome,ativo,nome_editado_manualmente,motorista_id,'
      + 'ContaMotorista(id,nome,cnpj_prestador)',
      'GET', null, claims
    );
    if (!linhas || linhas.length === 0) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const row = linhas[0];
    // PostgREST embed 1:1 via FK única pode devolver objeto único ou array
    // de 1 elemento dependendo da versão/config — normaliza para objeto.
    if (Array.isArray(row.ContaMotorista)) {
      row.ContaMotorista = row.ContaMotorista[0] || null;
    }

    // 3.2.3 — Entregador sem histórico de importação: `areas`/`resumo`
    // zerados, sem erro (as queries abaixo naturalmente retornam vazio/0).
    const areasMap = await buscarAreasPorEntregador([id], claims);
    const areas = areasMap.get(id) || [];

    // Resumo de indicadores all-time (data-model.md §Resumo de indicadores):
    // 1 query por tabela, combinando count=exact (header Content-Range) com
    // a linha mais recente (order+limit via range 0-0) — nenhuma linha de
    // fato crua além da 1 necessária para `dataMaisRecente`.
    const fatur = await hubPostgrestRequest(
      `FaturamentoLancamento?entregador_id=eq.${id}&id_empresa=eq.${entidadeAtiva}`
      + '&select=data_referencia&order=data_referencia.desc',
      'GET', null, claims,
      { count: true, range: { from: 0, to: 0 } }
    );
    const perf = await hubPostgrestRequest(
      `PerformanceTurno?entregador_id=eq.${id}&id_empresa=eq.${entidadeAtiva}`
      + '&select=data_periodo&order=data_periodo.desc',
      'GET', null, claims,
      { count: true, range: { from: 0, to: 0 } }
    );

    const dataFatur = fatur.data && fatur.data[0] ? fatur.data[0].data_referencia : null;
    const dataPerf = perf.data && perf.data[0] ? perf.data[0].data_periodo : null;
    let dataMaisRecente = null;
    if (dataFatur && dataPerf) {
      dataMaisRecente = dataFatur >= dataPerf ? dataFatur : dataPerf;
    } else {
      dataMaisRecente = dataFatur || dataPerf || null;
    }

    const resumo = {
      totalFaturamento: fatur.total || 0,
      totalPerformance: perf.total || 0,
      dataMaisRecente,
    };

    return res.status(200).json(mapMotoristaDetalhe(row, areas, resumo));
  } catch (e) {
    console.error('[hub-motoristas] erro em GET /motoristas/:id:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

module.exports = {
  router,
  // exportados para testes unitários
  resolverContextoEntidade,
  idValido,
};

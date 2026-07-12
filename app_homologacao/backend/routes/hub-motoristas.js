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
const { registrarAuditoria } = require('../lib/hub-auditoria');
const {
  parsePaginacao,
  nomeCasa,
  areaCasa,
  agruparAreasPorEntregador,
  mapMotoristaListItem,
  mapMotoristaDetalhe,
  validarPatchMotorista,
  validarVinculoBody,
  mascararCnpj,
} = require('../lib/hub-motoristas-dto');
const {
  termoBuscaValido,
  buscarCandidatos,
  buscarContasElegiveis,
} = require('../lib/hub-motoristas-similaridade');

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

/**
 * `true` se `id` referencia um `Entregador` DENTRO do escopo (`id_empresa`)
 * da entidade ativa do token — mesmo padrão de defesa em profundidade já
 * usado por `buscarDetalheMotorista`/`PATCH /:id` (filtro explícito por
 * `id_empresa`, complementar à RLS). Usado por `/:id/sugestoes` e
 * `/contas-elegiveis` (via `entregadorId`) para produzir `404` ANTES de
 * chamar o RPC de similaridade/busca — dec-038 (FASE 5).
 * @param {number} id
 * @param {number} entidadeAtiva
 * @param {object} claims
 * @returns {Promise<boolean>}
 */
async function entregadorExisteNoEscopo(id, entidadeAtiva, claims) {
  const linhas = await hubPostgrestRequest(
    `Entregador?id=eq.${id}&id_empresa=eq.${entidadeAtiva}&select=id`,
    'GET', null, claims
  );
  return !!(linhas && linhas.length > 0);
}

/**
 * `true` se a entidade ativa (`id_empresa`) pertence ao grupo elegível para
 * vínculo (`EmpresaGrupoMovee`, migration 0022 — allowlist global, sem RLS,
 * `GRANT SELECT ... TO authenticated`). Query direta e barata (chave
 * primária), resolvida ANTES do RPC para poder responder `entidadeElegivel:
 * false` sem executar `hub_motoristas_candidatos`/`hub_motoristas_busca`
 * (FR-011, dec-038 — distinção entre "0 linhas porque não-elegível" e "0
 * linhas porque não há candidatos" fica explícita no backend, não inferida
 * do resultado vazio do RPC).
 * @param {number} entidadeAtiva
 * @param {object} claims
 * @returns {Promise<boolean>}
 */
async function entidadeEhElegivel(entidadeAtiva, claims) {
  const linhas = await hubPostgrestRequest(
    `EmpresaGrupoMovee?id_empresa=eq.${entidadeAtiva}&select=id_empresa`,
    'GET', null, claims
  );
  return !!(linhas && linhas.length > 0);
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
// GET /motoristas/areas — subpraças distintas visíveis à entidade ativa
// (uiux-hub pós-F4: alimenta o combobox do filtro "Área" da lista, no lugar
// do campo de texto livre). Lê a view `hub_areas_por_entregador` (0024) com
// os claims do usuário — a RLS das tabelas base já limita à empresa do
// escopo (validado em hub-motoristas-integration.sh). DECLARADA ANTES de
// `GET /:id` (mesma restrição de ordem descrita em /contas-elegiveis).
// ────────────────────────────────────────────────────────────────────────────

router.get('/areas', requirePermission('motoristas.listar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'motoristas.listar');
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
    console.error('[hub-motoristas] erro em GET /motoristas/areas:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /motoristas/contas-elegiveis — busca manual de conta de acesso (task 5.2)
//
// DECLARADA ANTES de `GET /:id` deliberadamente: Express casa rotas na ordem
// de registro — se `/:id` viesse primeiro, `/contas-elegiveis` seria
// capturada como `req.params.id = 'contas-elegiveis'` (e falharia em
// `idValido`, nunca alcançando este handler). Mesma restrição vale para
// qualquer rota literal de 1 segmento futura sob `/motoristas/*`.
// ────────────────────────────────────────────────────────────────────────────

router.get('/contas-elegiveis', requirePermission('motoristas.editar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'motoristas.editar');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    // `entregadorId` obrigatório (contracts/motoristas-api.md §contas-elegiveis)
    // — ancora a checagem de escopo/elegibilidade no mesmo Entregador do
    // fluxo de vínculo. Ausente/malformado -> 422 (erro de parâmetro de
    // requisição, distinto do 404 de "existe mas fora do escopo").
    if (!idValido(req.query.entregadorId)) {
      return res.status(422).json({ erro: 'INVALIDO' });
    }
    const entregadorId = parseInt(req.query.entregadorId, 10);

    // 404 fora do escopo (Decision 11) — mesma regra de `/:id/sugestoes`.
    const existe = await entregadorExisteNoEscopo(entregadorId, entidadeAtiva, claims);
    if (!existe) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });

    const { page, pageSize, from } = parsePaginacao(req.query);

    // entidadeElegivel=false -> lista vazia sem erro (FR-011), sem chamar o RPC.
    const elegivel = await entidadeEhElegivel(entidadeAtiva, claims);
    if (!elegivel) {
      return res.status(200).json({ items: [], total: 0, page, pageSize, entidadeElegivel: false });
    }

    // `q` abaixo do mínimo (2 chars, dec-038/termoBuscaValido) -> lista vazia
    // sem erro, mesmo padrão de "estado vazio claro" do resto do módulo —
    // evita golpear o RPC com um termo vazio/de 1 caractere antes mesmo de a
    // pessoa usuária terminar de digitar.
    const termoBruto = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!termoBuscaValido(termoBruto)) {
      return res.status(200).json({ items: [], total: 0, page, pageSize, entidadeElegivel: true });
    }

    const { items, total } = await buscarContasElegiveis(entregadorId, termoBruto, pageSize, from, claims);
    return res.status(200).json({ items, total, page, pageSize, entidadeElegivel: true });
  } catch (e) {
    console.error('[hub-motoristas] erro em GET /motoristas/contas-elegiveis:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /motoristas/:id — detalhe com indicadores all-time (task 3.2)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Busca 1 Entregador (escopado por `id_empresa`) + embed `ContaMotorista` +
 * areas + resumo de indicadores all-time e monta o shape de detalhe do
 * contrato (`GET /motoristas/:id`). Extraído para ser reusado por
 * `PATCH /motoristas/:id` (task 4.1 — "Response 200: mesmo shape do
 * detalhe", contracts/motoristas-api.md §PATCH), evitando duplicar as 3
 * queries (Entregador+embed, áreas, resumo) entre os dois handlers.
 * @returns {Promise<object|null>} `null` se `id` fora do escopo/inexistente.
 */
async function buscarDetalheMotorista(id, entidadeAtiva, claims) {
  // 404 se fora do escopo do token: filtro explícito por id_empresa (defesa
  // em profundidade — RLS já nega a linha via escopo). Embed nativo do
  // PostgREST via FK física Entregador.motorista_id -> ContaMotorista(id)
  // (migration 0021) — confirmado empiricamente no teste de integração.
  const linhas = await hubPostgrestRequest(
    `Entregador?id=eq.${id}&id_empresa=eq.${entidadeAtiva}`
    + '&select=id,nome,ativo,nome_editado_manualmente,motorista_id,'
    + 'ContaMotorista(id,nome,cnpj_prestador)',
    'GET', null, claims
  );
  if (!linhas || linhas.length === 0) return null;
  const row = linhas[0];
  // PostgREST embed 1:1 via FK única pode devolver objeto único ou array
  // de 1 elemento dependendo da versão/config — normaliza para objeto.
  if (Array.isArray(row.ContaMotorista)) {
    row.ContaMotorista = row.ContaMotorista[0] || null;
  }

  // Entregador sem histórico de importação: `areas`/`resumo` zerados, sem
  // erro (as queries abaixo naturalmente retornam vazio/0).
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

  return mapMotoristaDetalhe(row, areas, resumo);
}

router.get('/:id', requirePermission('motoristas.consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'motoristas.consultar');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = parseInt(req.params.id, 10);

    const detalhe = await buscarDetalheMotorista(id, entidadeAtiva, claims);
    if (!detalhe) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });

    return res.status(200).json(detalhe);
  } catch (e) {
    console.error('[hub-motoristas] erro em GET /motoristas/:id:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// GET /motoristas/:id/sugestoes — candidatos por semelhança de nome (task 5.1)
// ────────────────────────────────────────────────────────────────────────────

router.get('/:id/sugestoes', requirePermission('motoristas.editar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'motoristas.editar');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = parseInt(req.params.id, 10);

    // 404 fora do escopo (Decision 11) — Entregador já vinculado TAMBÉM
    // responde normalmente aqui (permite trocar — FR-013); não há checagem
    // de "já vinculado" nesta rota.
    const existe = await entregadorExisteNoEscopo(id, entidadeAtiva, claims);
    if (!existe) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });

    // entidadeElegivel=false -> items:[] sem erro (FR-011), sem chamar o RPC.
    const elegivel = await entidadeEhElegivel(entidadeAtiva, claims);
    if (!elegivel) {
      return res.status(200).json({ items: [], entidadeElegivel: false });
    }

    // RPC hub_motoristas_candidatos já resolve corte top-10 + limiar 0.3
    // (migration 0023, Decision 10) — este handler nunca reimplementa a
    // lógica de similaridade.
    const items = await buscarCandidatos(id, claims);
    return res.status(200).json({ items, entidadeElegivel: true });
  } catch (e) {
    console.error('[hub-motoristas] erro em GET /motoristas/:id/sugestoes:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// PATCH /motoristas/:id — editar nome/situação com allowlist estrita (task 4.1)
// ────────────────────────────────────────────────────────────────────────────

router.patch('/:id', requirePermission('motoristas.editar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'motoristas.editar');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = parseInt(req.params.id, 10);

    // Allowlist estrita — só `nome`/`ativo` do corpo cru chegam ao PostgREST
    // (guarda anti mass-assignment/BOPLA, research.md Decision 12).
    const validado = validarPatchMotorista(req.body);
    if (!validado.ok) {
      return res.status(422).json({ erro: 'INVALIDO' });
    }

    // 404 fora do escopo ANTES do PATCH — filtro explícito por id_empresa
    // (defesa em profundidade, mesmo padrão de GET /:id); evita um PATCH
    // "no-op" silencioso contra 0 linhas de outro tenant.
    const existente = await hubPostgrestRequest(
      `Entregador?id=eq.${id}&id_empresa=eq.${entidadeAtiva}&select=id`,
      'GET', null, claims
    );
    if (!existente || existente.length === 0) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });

    // Único UPDATE (nome/ativo/nome_editado_manualmente juntos, FR-004) —
    // nunca toca FaturamentoLancamento/PerformanceTurno.
    await hubPostgrestRequest(
      `Entregador?id=eq.${id}&id_empresa=eq.${entidadeAtiva}`,
      'PATCH', validado.patch, claims,
      { returnMinimal: true }
    );

    await registrarAuditoria({
      idEmpresa: entidadeAtiva,
      usuarioId: ctx.payload.sub,
      acao: 'motorista.editado',
      recurso: 'Entregador',
      recursoId: id,
      detalhes: { camposAlterados: validado.camposAlterados },
      claims,
    });

    const detalhe = await buscarDetalheMotorista(id, entidadeAtiva, claims);
    if (!detalhe) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });

    return res.status(200).json(detalhe);
  } catch (e) {
    console.error('[hub-motoristas] erro em PATCH /motoristas/:id:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /motoristas/:id/vinculo — criar ou substituir vínculo (task 6.1)
//
// FR-013: se o Entregador já tinha vínculo, substitui em uma única ação —
// nenhuma chamada de desvínculo prévia é exigida (o handler nunca checa o
// motorista_id atual antes de sobrescrever). NUNCA automático — este
// endpoint só é alcançado por ação explícita da pessoa usuária (a
// confirmação humana em si é responsabilidade da UI, FASE 7); o backend
// apenas garante que a operação é idempotente-substitutiva e auditada.
// ────────────────────────────────────────────────────────────────────────────

router.post('/:id/vinculo', requirePermission('motoristas.editar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'motoristas.editar');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = parseInt(req.params.id, 10);

    // Allowlist estrita (Decision 12, mesmo padrão do PATCH) — só
    // `contaMotoristaId` influencia o UPDATE; `origem` é lida só para a
    // auditoria (lib/hub-motoristas-dto.js#validarVinculoBody).
    const validado = validarVinculoBody(req.body);
    if (!validado.ok) {
      return res.status(422).json({ erro: 'INVALIDO' });
    }
    const { contaMotoristaId, origem } = validado;

    // 404 fora do escopo (Decision 11, mesmo padrão de /sugestoes/PATCH).
    const existe = await entregadorExisteNoEscopo(id, entidadeAtiva, claims);
    if (!existe) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });

    // 422 entidade fora do grupo elegível (FR-010/FR-011 Edge Case) — mesmo
    // que `contaMotoristaId` exista no banco (contracts/motoristas-api.md
    // §POST vinculo).
    const elegivel = await entidadeEhElegivel(entidadeAtiva, claims);
    if (!elegivel) {
      return res.status(422).json({ erro: 'INVALIDO', motivo: 'entidade_fora_do_grupo' });
    }

    // FK: `contaMotoristaId` precisa existir em `ContaMotorista` -> 404
    // (distinto do 409 de conflito abaixo — contrato §POST vinculo, "404 ...
    // OU contaMotoristaId inexistente").
    const contaLinhas = await hubPostgrestRequest(
      `ContaMotorista?id=eq.${contaMotoristaId}&select=id,nome,cnpj_prestador`,
      'GET', null, claims
    );
    if (!contaLinhas || contaLinhas.length === 0) {
      return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    }
    const conta = contaLinhas[0];

    // Conflito (FR-012): a conta já vinculada a OUTRO Entregador. Consultado
    // ANTES do UPDATE para poder informar o nome no 409 amigável (contrato
    // — "motivo consultado antes de tentar o UPDATE"). Escopado
    // explicitamente por `id_empresa` (defesa em profundidade, RLS já filtra
    // por escopo) — só enxerga conflito DENTRO do tenant da entidade ativa;
    // um conflito cross-tenant (índice único é GLOBAL sobre `motorista_id`)
    // é pego pelo catch abaixo, sem expor dados de outro tenant.
    const conflitoLinhas = await hubPostgrestRequest(
      `Entregador?motorista_id=eq.${contaMotoristaId}&id=neq.${id}`
      + `&id_empresa=eq.${entidadeAtiva}&select=id,nome`,
      'GET', null, claims
    );
    if (conflitoLinhas && conflitoLinhas.length > 0) {
      return res.status(409).json({
        erro: 'CONFLITO',
        motivo: 'conta_ja_vinculada',
        vinculadaA: { entregadorId: conflitoLinhas[0].id, nome: conflitoLinhas[0].nome },
      });
    }

    try {
      await hubPostgrestRequest(
        `Entregador?id=eq.${id}&id_empresa=eq.${entidadeAtiva}`,
        'PATCH', { motorista_id: contaMotoristaId }, claims,
        { returnMinimal: true }
      );
    } catch (updateErr) {
      // Defesa em profundidade: violação do índice único não detectada pelo
      // pre-check acima (conflito cross-tenant, invisível pela RLS — o
      // índice único é GLOBAL e a checagem de constraint do Postgres não
      // respeita RLS). Sem visibilidade sobre a linha conflitante
      // (isolamento multi-tenant, Constitution II), o 409 aqui NUNCA expõe
      // entregadorId/nome de outro tenant.
      if (updateErr && updateErr.status === 409) {
        return res.status(409).json({ erro: 'CONFLITO', motivo: 'conta_ja_vinculada' });
      }
      throw updateErr;
    }

    await registrarAuditoria({
      idEmpresa: entidadeAtiva,
      usuarioId: ctx.payload.sub,
      acao: 'motorista.vinculado',
      recurso: 'Entregador',
      recursoId: id,
      detalhes: { contaMotoristaId, origem },
      claims,
    });

    return res.status(200).json({
      id,
      vinculo: {
        contaMotoristaId: conta.id,
        nome: conta.nome,
        cnpjPrestadorMascarado: mascararCnpj(conta.cnpj_prestador),
      },
    });
  } catch (e) {
    console.error('[hub-motoristas] erro em POST /motoristas/:id/vinculo:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// DELETE /motoristas/:id/vinculo — desfazer vínculo (task 6.2, fecha CHK006)
//
// Semântica idempotente (CHK006 — contracts/motoristas-api.md §DELETE
// vinculo): chamar sobre um Entregador que já está sem vínculo é um no-op
// que retorna `204` sem erro (não `404`) — o estado-alvo do DELETE
// ("Entregador sem vínculo") já está satisfeito, consistente com a
// semântica REST padrão de idempotência (RFC 7231 §4.2.2, chamadas
// repetidas produzem o mesmo efeito). Auditoria `motorista.
// desvinculado` só é registrada quando havia de fato um vínculo antes
// (no-op nunca gera entrada de auditoria vazia).
// ────────────────────────────────────────────────────────────────────────────

router.delete('/:id/vinculo', requirePermission('motoristas.editar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'motoristas.editar');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = parseInt(req.params.id, 10);

    // 404 fora do escopo — filtro explícito por id_empresa (defesa em
    // profundidade, mesmo padrão de GET/PATCH /:id).
    const linhas = await hubPostgrestRequest(
      `Entregador?id=eq.${id}&id_empresa=eq.${entidadeAtiva}&select=id,motorista_id`,
      'GET', null, claims
    );
    if (!linhas || linhas.length === 0) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const contaMotoristaIdAnterior = linhas[0].motorista_id;

    // No-op idempotente (CHK006): já sem vínculo -> 204 direto, sem UPDATE
    // nem auditoria.
    if (contaMotoristaIdAnterior === null || contaMotoristaIdAnterior === undefined) {
      return res.status(204).end();
    }

    await hubPostgrestRequest(
      `Entregador?id=eq.${id}&id_empresa=eq.${entidadeAtiva}`,
      'PATCH', { motorista_id: null }, claims,
      { returnMinimal: true }
    );

    await registrarAuditoria({
      idEmpresa: entidadeAtiva,
      usuarioId: ctx.payload.sub,
      acao: 'motorista.desvinculado',
      recurso: 'Entregador',
      recursoId: id,
      detalhes: { contaMotoristaIdAnterior },
      claims,
    });

    return res.status(204).end();
  } catch (e) {
    console.error('[hub-motoristas] erro em DELETE /motoristas/:id/vinculo:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

module.exports = {
  router,
  // exportados para testes unitários
  resolverContextoEntidade,
  idValido,
};

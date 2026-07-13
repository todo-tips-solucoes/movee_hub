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
const bcrypt = require('bcrypt');
const crypto = require('crypto');

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
  validarCriacaoMotorista,
  validarVinculoBody,
  mascararCnpj,
  validarCriacaoCredencialBody,
  validarPatchCredencialBody,
  validarDefinirSenhaCredencialBody,
  parsePaginacaoAtividades,
  montarAtividades,
  cnpjEnvioMassaFilter,
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
    // FASE 4 (task 4.1.1): id_externo (uuid) exposto como `idExterno` nos
    // DTOs de listagem (FR-016).
    filtros.push('select=id,nome,ativo,motorista_id,id_externo');

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
/**
 * FASE 6 (task 6.4) — histórico de atividades correlacionadas por uuid
 * (data-model.md §Entity Atividade, dec-046/dec-048). União read-only de 3
 * fontes:
 *   - FaturamentoLancamento/PerformanceTurno: já correlacionadas por
 *     `entregador_id` (FK física) — escopadas por `id_empresa` (RLS +
 *     filtro explícito, mesmo padrão do resumo all-time).
 *   - EnvioMassa (validação de NF, schema legado espelhado no hub — SEM
 *     RLS, 0006_rls_policies.sql): correlacionada por `entregador_uuid`
 *     (migration 0046) **E** `cnpj_prestador` da conta vinculada (dec-048 —
 *     fecha risco de colisão de uuid entre empresas, já que
 *     `Entregador.id_externo` só é único POR empresa). Sem vínculo
 *     (`contaMotorista` null) não há `cnpj_prestador` para correlacionar —
 *     fonte fica vazia legitimamente (não é erro).
 * Performance (task 6.4.5): 3 contagens exatas (count=exact + range 0-0,
 * índice em coluna de correlação já existe — 0013/0014/0046) para o
 * `total`; cada fonte busca só o topo `offset+limit` (ordenado desc) —
 * nunca a tabela inteira, mesmo sem limite fixo de período/quantidade
 * (FR-022).
 * @param {number} id - Entregador.id
 * @param {string|null} idExterno - Entregador.id_externo (uuid)
 * @param {object|null} contaMotorista - embed já resolvido (cnpj_prestador)
 * @param {number} entidadeAtiva
 * @param {object} claims
 * @param {number} offset
 * @param {number} limit
 * @returns {Promise<{items:object[], total:number, offset:number, limit:number}>}
 */
async function buscarAtividadesMotorista(id, idExterno, contaMotorista, entidadeAtiva, claims, offset, limit) {
  const janela = offset + limit;
  // Guard nas DUAS variáveis interpoladas na URL da EnvioMassa (review-task
  // de fechamento, finding #3): sem `idExterno` o filtro viraria
  // `entregador_uuid=eq.null` — sintaxe inválida para o tipo uuid no
  // Postgres, derrubando o GET /:id inteiro com 500. Entregador com
  // `id_externo` nulo é raro (backfill da 0010), mas o gate correto é nas
  // duas pontas da correlação (uuid E cnpj), não só no cnpj.
  const cnpjPrestadorVinculo = idExterno
    ? (contaMotorista && contaMotorista.cnpj_prestador)
    : null;

  const faturCount = await hubPostgrestRequest(
    `FaturamentoLancamento?entregador_id=eq.${id}&id_empresa=eq.${entidadeAtiva}&select=id`,
    'GET', null, claims, { count: true, range: { from: 0, to: 0 } }
  );
  const perfCount = await hubPostgrestRequest(
    `PerformanceTurno?entregador_id=eq.${id}&id_empresa=eq.${entidadeAtiva}&select=id`,
    'GET', null, claims, { count: true, range: { from: 0, to: 0 } }
  );
  const validCount = cnpjPrestadorVinculo
    ? await hubPostgrestRequest(
      `EnvioMassa?entregador_uuid=eq.${encodeURIComponent(idExterno)}`
      + `&${cnpjEnvioMassaFilter(cnpjPrestadorVinculo)}&select=id`,
      'GET', null, claims, { count: true, range: { from: 0, to: 0 } }
    )
    : { total: 0 };

  const total = (faturCount.total || 0) + (perfCount.total || 0) + (validCount.total || 0);

  if (janela <= 0) {
    return montarAtividades([], [], [], total, offset, limit);
  }

  const faturRows = await hubPostgrestRequest(
    `FaturamentoLancamento?entregador_id=eq.${id}&id_empresa=eq.${entidadeAtiva}`
    + `&select=data_referencia,descricao,valor&order=data_referencia.desc&limit=${janela}`,
    'GET', null, claims
  );
  const perfRows = await hubPostgrestRequest(
    `PerformanceTurno?entregador_id=eq.${id}&id_empresa=eq.${entidadeAtiva}`
    + `&select=data_periodo,periodo,subpraca&order=data_periodo.desc&limit=${janela}`,
    'GET', null, claims
  );
  const validRows = cnpjPrestadorVinculo
    ? await hubPostgrestRequest(
      `EnvioMassa?entregador_uuid=eq.${encodeURIComponent(idExterno)}`
      + `&${cnpjEnvioMassaFilter(cnpjPrestadorVinculo)}`
      + `&select=data_emissao,criado_em:created_at,numnota,valor&order=created_at.desc&limit=${janela}`,
      'GET', null, claims
    )
    : [];

  return montarAtividades(faturRows || [], perfRows || [], validRows || [], total, offset, limit);
}

async function buscarDetalheMotorista(id, entidadeAtiva, claims, atividadesOpts) {
  // 404 se fora do escopo do token: filtro explícito por id_empresa (defesa
  // em profundidade — RLS já nega a linha via escopo). Embed nativo do
  // PostgREST via FK física Entregador.motorista_id -> ContaMotorista(id)
  // (migration 0021) — confirmado empiricamente no teste de integração.
  // FASE 4 (task 4.1.2): id_externo (uuid) exposto como `idExterno` no
  // detalhe (FR-016). FASE 5 (task 5.5): `ContaMotorista.ativo` incluído no
  // embed — aditivo, campo já existente desde 0021_conta_motorista.sql —
  // para a UI de "Ativar/Desativar credencial" (routes/hub-motoristas.js
  // §PATCH /:id/credencial) refletir o estado REAL da credencial em vez de
  // adivinhar/assumir um default no cliente.
  const linhas = await hubPostgrestRequest(
    `Entregador?id=eq.${id}&id_empresa=eq.${entidadeAtiva}`
    + '&select=id,nome,ativo,nome_editado_manualmente,motorista_id,id_externo,'
    + 'ContaMotorista(id,nome,cnpj_prestador,ativo)',
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

  // FASE 6 (task 6.4) — seção "Atividades". `atividadesOpts` é opcional
  // (PATCH /:id reusa esta função e não precisa da janela paginada — mesmo
  // padrão de reuso já documentado no cabeçalho desta função); default
  // offset=0/limit=20 quando ausente.
  const { offset: atividadesOffset, limit: atividadesLimit } = atividadesOpts || { offset: 0, limit: 20 };
  const atividades = await buscarAtividadesMotorista(
    id, row.id_externo, row.ContaMotorista, entidadeAtiva, claims, atividadesOffset, atividadesLimit
  );

  return mapMotoristaDetalhe(row, areas, resumo, atividades);
}

router.get('/:id', requirePermission('motoristas.consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'motoristas.consultar');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = parseInt(req.params.id, 10);
    const atividadesOpts = parsePaginacaoAtividades(req.query);

    const detalhe = await buscarDetalheMotorista(id, entidadeAtiva, claims, atividadesOpts);
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
// POST /motoristas — cadastro manual com uuid obrigatório (task 4.2)
//
// Allowlist estrita do corpo (mandato S2 — BOPLA/mass assignment):
// `lib/hub-motoristas-dto.js#validarCriacaoMotorista` só lê `nome` +
// `idExterno` do corpo cru — qualquer outra chave (`ativo`, `motoristaId`,
// `id`, `idEmpresa`, etc.) nunca é lida, nunca chega ao PostgREST.
// `id_empresa` é SEMPRE resolvido do contexto do token
// (`resolverContextoEntidade`), nunca do corpo (Princípio II). Sem
// verificação de duplicidade PRÉVIA por SELECT: a UNIQUE (id_empresa,
// id_externo) do banco (migration 0010) é a fonte de verdade — a violação é
// mapeada para 409 amigável DEPOIS do INSERT (mesmo padrão de defesa em
// profundidade de `POST /:id/vinculo` acima, evita corrida entre o
// pre-check e o INSERT). FR-012..FR-014.
// ────────────────────────────────────────────────────────────────────────────

router.post('/', requirePermission('motoristas.editar'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'motoristas.editar');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    const validado = validarCriacaoMotorista(req.body);
    if (!validado.ok) {
      return res.status(422).json({ erro: validado.erro });
    }
    const { nome, idExterno } = validado;

    let criados;
    try {
      criados = await hubPostgrestRequest(
        'Entregador', 'POST',
        { nome, id_externo: idExterno, id_empresa: entidadeAtiva, ativo: true },
        claims
      );
    } catch (e) {
      // Violação de UNIQUE (id_empresa, id_externo) -> 409 amigável
      // (contracts/api-motorista-canonico.md §POST /motoristas). PostgREST
      // já mapeia unique_violation (23505) para HTTP 409 nativamente —
      // mesmo padrão de POST /usuarios (routes/hub-usuarios.js).
      if (e && e.status === 409) {
        return res.status(409).json({ erro: 'uuid_duplicado' });
      }
      throw e;
    }
    const novo = criados && criados[0];
    if (!novo) {
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }

    await registrarAuditoria({
      idEmpresa: entidadeAtiva,
      usuarioId: ctx.payload.sub,
      acao: 'motorista.criado',
      recurso: 'Entregador',
      recursoId: novo.id,
      detalhes: { idExterno },
      claims,
    });

    return res.status(201).json({
      id: novo.id,
      idExterno: novo.id_externo,
      nome: novo.nome,
      ativo: novo.ativo,
    });
  } catch (e) {
    console.error('[hub-motoristas] erro em POST /motoristas:', e.message);
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
      `ContaMotorista?id=eq.${contaMotoristaId}&select=id,nome,cnpj_prestador,ativo`,
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
        ativo: !!conta.ativo,
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

// ────────────────────────────────────────────────────────────────────────────
// Credencial de acesso ao app do motorista (FASE 5 — tasks.md 5.1/5.2/5.3;
// contracts/api-motorista-canonico.md §WS-C Credencial). Todas as rotas
// abaixo exigem `motoristas.credencial` — permissão distinta de
// `motoristas.editar` (seed 0044): gestão de credencial é ação sensível
// (define/reseta segredo de acesso ao app), separada do cadastro/edição
// operacional do Entregador.
// ────────────────────────────────────────────────────────────────────────────

// mandato S3 (research.md) — cost >= 12, LITERAL. NÃO reusar o cost=10 do
// legado de `Usuario`/`Motorista` (bcrypt mais barato, aceitável em 2020,
// insuficiente para hardware atual).
const CREDENCIAL_BCRYPT_COST = 12;

// CHK011/tasks.md 5.2.2 — MESMO valor do fluxo legado `recuperar-senha`/
// `redefinir-senha` (routes/hub-auth.js#RECUPERACAO_TOKEN_TTL_MS = 1 hora).
// Documentado aqui em vez de importado: os dois arquivos mantêm cada um sua
// própria cópia de constantes pequenas (mesmo padrão de duplicação
// deliberada descrito no cabeçalho deste arquivo) — o valor precisa
// permanecer IDÊNTICO por decisão de produto (espelhar o legado), não por
// acoplamento de código.
const CREDENCIAL_TOKEN_RESET_TTL_MS = 60 * 60 * 1000; // 1 hora

/**
 * SHA-256 hex do token bruto de reset de senha — NUNCA persiste o token em
 * claro (mesmo padrão de `hashToken()` em routes/hub-auth.js).
 * @param {string} tokenBruto
 * @returns {string}
 */
function hashTokenResetCredencial(tokenBruto) {
  return crypto.createHash('sha256').update(tokenBruto).digest('hex');
}

/**
 * 256 bits de entropia via `crypto.randomBytes` (NUNCA `Math.random()`/uuid
 * v4 para segredo criptográfico) — mesmo padrão de `gerarTokenBruto()` em
 * routes/hub-auth.js.
 * @returns {string}
 */
function gerarTokenResetCredencial() {
  return crypto.randomBytes(32).toString('hex');
}

// ────────────────────────────────────────────────────────────────────────────
// POST /motoristas/:id/credencial — criar credencial (task 5.1)
// ────────────────────────────────────────────────────────────────────────────

router.post('/:id/credencial', requirePermission('motoristas.credencial'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'motoristas.credencial');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = parseInt(req.params.id, 10);

    // Allowlist estrita (5.1.2, mandato S2) — só `cnpjPrestador`/`senhaInicial`
    // influenciam esta rota; `ativo` (ou qualquer outra chave) do corpo é
    // ignorado, nunca lido.
    const validado = validarCriacaoCredencialBody(req.body);
    if (!validado.ok) {
      return res.status(422).json({ erro: validado.erro });
    }
    const { cnpjPrestador, senhaInicial } = validado;

    // 1. 404 fora do escopo — filtro explícito por id_empresa (defesa em
    // profundidade, mesmo padrão de GET/PATCH /:id).
    const entregadorLinhas = await hubPostgrestRequest(
      `Entregador?id=eq.${id}&id_empresa=eq.${entidadeAtiva}&select=id,nome,motorista_id`,
      'GET', null, claims
    );
    if (!entregadorLinhas || entregadorLinhas.length === 0) {
      return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    }
    const entregador = entregadorLinhas[0];

    // 2. já tem credencial (ContaMotorista.senha IS NOT NULL) vinculada a
    // ESTE Entregador -> 409.
    if (entregador.motorista_id) {
      const vinculadaAtual = await hubPostgrestRequest(
        `ContaMotorista?id=eq.${entregador.motorista_id}&select=id,senha`,
        'GET', null, claims
      );
      if (vinculadaAtual && vinculadaAtual[0] && vinculadaAtual[0].senha) {
        return res.status(409).json({ erro: 'credencial_existente' });
      }
    }

    // 3. ContaMotorista por cnpj_prestador informado — se já vinculada a
    // OUTRO Entregador (dentro do escopo), 409 sem vazar qual entregador
    // (mesmo espírito do 409 defensivo de POST /:id/vinculo).
    const contasPorCnpj = await hubPostgrestRequest(
      `ContaMotorista?cnpj_prestador=eq.${encodeURIComponent(cnpjPrestador)}&select=id,nome`,
      'GET', null, claims
    );
    const contaExistente = contasPorCnpj && contasPorCnpj[0];
    if (contaExistente) {
      const vinculoOutro = await hubPostgrestRequest(
        `Entregador?motorista_id=eq.${contaExistente.id}&id=neq.${id}`
        + `&id_empresa=eq.${entidadeAtiva}&select=id`,
        'GET', null, claims
      );
      if (vinculoOutro && vinculoOutro.length > 0) {
        return res.status(409).json({ erro: 'credencial_existente' });
      }
    }

    // 4. senha em claro: do body se veio válida (validada acima, >=8
    // chars), senão gerada (alta entropia, ~12 chars via base64url de 9
    // bytes aleatórios).
    let senhaGerada = false;
    let senhaEmClaro = senhaInicial;
    if (!senhaEmClaro) {
      senhaEmClaro = crypto.randomBytes(9).toString('base64url');
      senhaGerada = true;
    }

    // 5. bcrypt cost >= 12 (mandato S3).
    const hash = await bcrypt.hash(senhaEmClaro, CREDENCIAL_BCRYPT_COST);

    // 6. PATCH se a conta já existia (reaproveita cadastro), POST se não.
    let conta;
    if (contaExistente) {
      await hubPostgrestRequest(
        `ContaMotorista?id=eq.${contaExistente.id}`, 'PATCH', { senha: hash }, claims,
        { returnMinimal: true }
      );
      conta = contaExistente;
    } else {
      const criados = await hubPostgrestRequest(
        'ContaMotorista', 'POST',
        { cnpj_prestador: cnpjPrestador, nome: entregador.nome, ativo: true, senha: hash },
        claims
      );
      conta = criados && criados[0];
      if (!conta) return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }

    // 7. vincular Entregador -> conta, se ainda não apontava para ela
    // (mesmo idioma de PATCH em POST /:id/vinculo).
    if (entregador.motorista_id !== conta.id) {
      await hubPostgrestRequest(
        `Entregador?id=eq.${id}&id_empresa=eq.${entidadeAtiva}`, 'PATCH', { motorista_id: conta.id }, claims,
        { returnMinimal: true }
      );
    }

    // 8. auditoria — NUNCA a senha (mandato S4, defesa em profundidade além
    // do scrub automático de lib/hub-auditoria.js).
    await registrarAuditoria({
      idEmpresa: entidadeAtiva,
      usuarioId: ctx.payload.sub,
      acao: 'motorista.credencial_criada',
      recurso: 'ContaMotorista',
      recursoId: conta.id,
      detalhes: { contaMotoristaId: conta.id },
      claims,
    });

    // 9. resposta — NUNCA a chave `senha`; `senhaTemporaria` só quando
    // AUTO-gerada (nunca ecoa uma senha que o próprio caller já sabia).
    const resposta = { id: conta.id, cnpjPrestador: mascararCnpj(cnpjPrestador), ativo: true };
    if (senhaGerada) {
      resposta.senhaTemporaria = senhaEmClaro;
    }
    return res.status(201).json(resposta);
  } catch (e) {
    console.error('[hub-motoristas] erro em POST /motoristas/:id/credencial:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /motoristas/:id/credencial/reset-senha — iniciar reset (task 5.2)
//
// Invalida a senha atual IMEDIATAMENTE (`senha: null`) — próximo login falha
// (mesma semântica de `if (!motorista.senha)` já existente no login legado,
// routes/motorista.js) — e emite um token de definição de nova senha
// (single-use, TTL de 1h, 256 bits — ver constantes acima).
// ────────────────────────────────────────────────────────────────────────────

router.post('/:id/credencial/reset-senha', requirePermission('motoristas.credencial'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'motoristas.credencial');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = parseInt(req.params.id, 10);

    // 404 se fora do escopo OU sem credencial vinculada (motivo mais
    // preciso que 409 aqui: não há nada de "conflito", só nada para
    // resetar).
    const linhas = await hubPostgrestRequest(
      `Entregador?id=eq.${id}&id_empresa=eq.${entidadeAtiva}&select=id,motorista_id`,
      'GET', null, claims
    );
    if (!linhas || linhas.length === 0 || !linhas[0].motorista_id) {
      return res.status(404).json({ erro: 'credencial_inexistente' });
    }
    const contaMotoristaId = linhas[0].motorista_id;

    const tokenBruto = gerarTokenResetCredencial();
    const tokenHash = hashTokenResetCredencial(tokenBruto);
    const expira = new Date(Date.now() + CREDENCIAL_TOKEN_RESET_TTL_MS);

    await hubPostgrestRequest(
      `ContaMotorista?id=eq.${contaMotoristaId}`, 'PATCH',
      { senha: null, token_reset_hash: tokenHash, token_reset_expira: expira.toISOString() },
      claims, { returnMinimal: true }
    );

    // Auditoria — NUNCA o token (mandato S4).
    await registrarAuditoria({
      idEmpresa: entidadeAtiva,
      usuarioId: ctx.payload.sub,
      acao: 'motorista.credencial_reset_iniciado',
      recurso: 'ContaMotorista',
      recursoId: contaMotoristaId,
      detalhes: { contaMotoristaId },
      claims,
    });

    // `tokenDefinicao` devolvido uma ÚNICA vez, diretamente na resposta:
    // diferente do fluxo `recuperar-senha` de Usuario (que "envia" por
    // e-mail mock), não existe canal de e-mail para o motorista — o
    // operador que aciona esta rota repassa o token à pessoa motorista por
    // fora do sistema (WhatsApp/telefone/presencial).
    return res.status(200).json({ ok: true, tokenDefinicao: tokenBruto });
  } catch (e) {
    console.error('[hub-motoristas] erro em POST /motoristas/:id/credencial/reset-senha:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// POST /motoristas/:id/credencial/reset-senha/definir — resgatar o token
// (GAP-FILL, CHK011/tasks.md 5.2.2)
//
// tasks.md 5.2 só descreve a rota que GERA o token de reset
// (`POST .../reset-senha`, acima). Sem um endpoint que CONSOME esse token,
// ele nunca teria semântica testável de expiração/single-use — o próprio
// CHK011 exige TTL + entropia + single-use CONCRETOS e VERIFICÁVEIS por
// teste (não só "documentados"). Esta rota fecha esse gap: consome o
// `tokenDefinicao` devolvido por `.../reset-senha` e define a senha nova.
// Mantida sob o MESMO gate (`motoristas.credencial`) — não abre superfície
// pública nova (só quem já pode gerenciar a credencial do motorista pode
// consumir o token de definição; o motorista em si não chama esta rota do
// hub, só o operador, que repassa a senha definida por fora do sistema —
// mesmo modelo operacional do `tokenDefinicao` acima).
// ────────────────────────────────────────────────────────────────────────────

router.post('/:id/credencial/reset-senha/definir', requirePermission('motoristas.credencial'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'motoristas.credencial');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = parseInt(req.params.id, 10);

    // Allowlist estrita: só `token`/`novaSenha` — validação de FORMATO
    // apenas (a de NEGÓCIO — hash bate? expirou? — é feita abaixo).
    const validado = validarDefinirSenhaCredencialBody(req.body);
    if (!validado.ok) {
      return res.status(422).json({ erro: validado.erro });
    }
    const { token, novaSenha } = validado;

    const linhas = await hubPostgrestRequest(
      `Entregador?id=eq.${id}&id_empresa=eq.${entidadeAtiva}&select=id,motorista_id`,
      'GET', null, claims
    );
    if (!linhas || linhas.length === 0 || !linhas[0].motorista_id) {
      return res.status(404).json({ erro: 'credencial_inexistente' });
    }
    const contaMotoristaId = linhas[0].motorista_id;

    const contas = await hubPostgrestRequest(
      `ContaMotorista?id=eq.${contaMotoristaId}&select=id,token_reset_hash,token_reset_expira`,
      'GET', null, claims
    );
    const conta = contas && contas[0];

    // token ausente/hash não bate -> 400 (nunca revela QUAL parte falhou —
    // mesmo espírito anti-enumeração do resto do hub).
    if (!conta || !conta.token_reset_hash || hashTokenResetCredencial(token) !== conta.token_reset_hash) {
      return res.status(400).json({ erro: 'token_invalido' });
    }
    // expirado -> 410 (distinto de 400: prova que o token EXISTIU e bateu,
    // só não está mais dentro do TTL).
    if (!conta.token_reset_expira || new Date(conta.token_reset_expira) < new Date()) {
      return res.status(410).json({ erro: 'token_expirado' });
    }

    const hash = await bcrypt.hash(novaSenha, CREDENCIAL_BCRYPT_COST);

    // Single-use: hash/expira zerados no MESMO UPDATE que grava a senha
    // nova — uma segunda tentativa com o mesmo token não encontra mais
    // token_reset_hash para comparar.
    await hubPostgrestRequest(
      `ContaMotorista?id=eq.${contaMotoristaId}`, 'PATCH',
      { senha: hash, token_reset_hash: null, token_reset_expira: null },
      claims, { returnMinimal: true }
    );

    await registrarAuditoria({
      idEmpresa: entidadeAtiva,
      usuarioId: ctx.payload.sub,
      acao: 'motorista.credencial_senha_definida',
      recurso: 'ContaMotorista',
      recursoId: contaMotoristaId,
      detalhes: { contaMotoristaId },
      claims,
    });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[hub-motoristas] erro em POST /motoristas/:id/credencial/reset-senha/definir:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// PATCH /motoristas/:id/credencial — ativar/desativar (task 5.3)
//
// Independência (FR-015/FR-018, clarify Q3): esta rota SÓ toca
// `ContaMotorista.ativo` — nunca `Entregador.ativo` e vice-versa (PATCH
// /motoristas/:id, acima, só toca `Entregador`). Confirmado por teste
// unitário/integração (tasks.md 5.3.4).
// ────────────────────────────────────────────────────────────────────────────

router.patch('/:id/credencial', requirePermission('motoristas.credencial'), async (req, res) => {
  try {
    const ctx = await resolverContextoEntidade(req, res, 'motoristas.credencial');
    if (!ctx) return;
    const { entidadeAtiva, claims } = ctx;

    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = parseInt(req.params.id, 10);

    // Allowlist estrita — só `ativo` (5.3.1).
    const validado = validarPatchCredencialBody(req.body);
    if (!validado.ok) {
      return res.status(422).json({ erro: validado.erro });
    }

    const linhas = await hubPostgrestRequest(
      `Entregador?id=eq.${id}&id_empresa=eq.${entidadeAtiva}&select=id,motorista_id`,
      'GET', null, claims
    );
    if (!linhas || linhas.length === 0 || !linhas[0].motorista_id) {
      return res.status(404).json({ erro: 'credencial_inexistente' });
    }
    const contaMotoristaId = linhas[0].motorista_id;

    await hubPostgrestRequest(
      `ContaMotorista?id=eq.${contaMotoristaId}`, 'PATCH', { ativo: validado.ativo }, claims,
      { returnMinimal: true }
    );

    await registrarAuditoria({
      idEmpresa: entidadeAtiva,
      usuarioId: ctx.payload.sub,
      acao: 'motorista.credencial_situacao_alterada',
      recurso: 'ContaMotorista',
      recursoId: contaMotoristaId,
      detalhes: { ativo: validado.ativo },
      claims,
    });

    return res.status(200).json({ id: contaMotoristaId, ativo: validado.ativo });
  } catch (e) {
    console.error('[hub-motoristas] erro em PATCH /motoristas/:id/credencial:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

module.exports = {
  router,
  // exportados para testes unitários
  resolverContextoEntidade,
  idValido,
};

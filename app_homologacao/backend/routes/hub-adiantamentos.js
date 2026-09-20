/**
 * adiantamento-motorista — routes/hub-adiantamentos.js (tasks.md FASE 4)
 *
 * Rotas do hub para o módulo Adiantamentos: solicitações (4.1), configuração
 * (4.2), contas bancárias (4.3), lotes de pagamento (4.4) e repasse (4.6).
 * Montado em `/api/v1/adiantamentos` (server.js, 4.9), sem middleware na
 * montagem — cada rota abaixo roda a cadeia de guarda completa.
 *
 * Cadeia de guarda (contracts/hub-api.md §Parte 2), nesta ordem em TODA rota:
 *   1. requireModuloAtivo('adiantamentos') -> 401 sem sessão / 403 MODULO_DESABILITADO
 *   2. requirePermission('adiantamentos.<acao>') -> 403 PERMISSAO_NEGADA (união flat)
 *   3. resolverContextoAdiantamentos: reconfere a MESMA permissão na ENTIDADE
 *      ATIVA do token (mesmo padrão de hub-avisos.js/hub-motoristas.js)
 *   4. segunda barreira SQL: toda RPC sensível chama `hub_adiantamento_tem_permissao`
 *      (contracts/sql-rpc.md) — dec-023, fecha 1.4.4/1.4.5 (paridade Node/SQL)
 *
 * Escopo (dec-022, DIFERENTE do módulo de avisos — plan.md §Constitution
 * Check II): grupo inteiro (todas as filiais) SÓ quando a entidade ativa é a
 * empresa-pai 6; para uma filial, o escopo é `[entidadeAtiva]`. Nenhuma
 * checagem `FORA_DO_GRUPO_MOVEE` aqui — o módulo `adiantamentos` só é
 * ativado (`ModuloEntidade`) para empresas do grupo Movee (mesmo raciocínio
 * de `derivarReason` em routes/motorista-adiantamento.js), então qualquer
 * `entidadeAtiva` que atravesse `requireModuloAtivo` já pertence ao grupo.
 *
 * Máscaras de conta bancária: as RPCs `hub_conta_bancaria_listar`/`_detalhe`
 * (sem `completo`) JÁ devolvem jsonb mascarado no formato `hub_adiantamento_mascarar`
 * (asteriscos + 2 dígitos finais) — DIFERENTE do formato `••••NNNN-D`/
 * `***.***.***-41` usado em `lib/adiantamento-dto.js` (que espera a linha
 * CRUA da tabela, indisponível aqui: RLS não dá `SELECT` direto em
 * `"ContaBancariaMotorista"`). Por isso este arquivo usa `mapContaMascaradaHub`
 * (local, abaixo) para o caminho mascarado, e só cai em `mapContaCompleta`
 * (lib/adiantamento-dto.js) quando a RPC devolve a linha CRUA
 * (`hub_conta_bancaria_detalhe(p_completo=true)`, permissão `contas_revisar`).
 *
 * Erros de negócio: as RPCs levantam `RAISE EXCEPTION '<CODIGO>'`; traduzidos
 * via `mensagemDeErro`/checagem por substring (mesmo padrão de
 * routes/motorista-adiantamento.js e routes/hub-avisos.js).
 *
 * Ref: contracts/hub-api.md, contracts/sql-rpc.md, data-model.md, tasks.md FASE 4.
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');

const { decodificarAccessToken, lerAccessTokenDoRequest } = require('../lib/hub-access-token');
const { requireModuloAtivo } = require('../middleware/hub-require-modulo');
const { requirePermission } = require('../middleware/hub-require-permission');
const { obterPermissoesEfetivasPorEntidade } = require('../lib/hub-rbac-cache');
const { mesmoGrupoQue } = require('./grupo');
const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const { registrarAuditoria } = require('../lib/hub-auditoria');
const {
  dinheiro, formatarSequencial, formatarBancoCodigoNome, pontuarDocumentoMascarado,
  rotuloStatusAdiantamento, mapConfiguracao, mapContaCompleta, mapSolicitacaoResumo,
  mapEvento, mapLote, mapLoteItem,
} = require('../lib/adiantamento-dto');
const {
  montarPlanilhaTransfeera, validarPlanilhaTransfeera, nomeArquivoTransfeera, renderizarDescricaoPix,
} = require('../lib/adiantamento-transfeera-xlsx');
const { serializarCsvRemanescente, paraCentavos, formatarCentavos } = require('../lib/adiantamento-remanescente');
const {
  RetornoTransfeeraParseError, lerCsv: lerRetornoTransfeeraCsv, casarComItensDoLote,
} = require('../lib/adiantamento-retorno-transfeera');
const { partesNoFuso, dataISO } = require('../lib/adiantamento-regras');
const contratoTransfeera = require('../lib/fixtures/transfeera-contrato.json');

const router = express.Router();

const GRUPO_MOVEE_ID = 6;
// 11.19: mesmo valor fixo já usado em routes/motorista-adiantamento.js
// (TIMEZONE_PADRAO) — a coluna `timezone` da configuração tem CHECK
// restrito a 'America/Sao_Paulo' (migrations/0066), então não há
// necessidade de buscar a config vigente só para isto.
const TIMEZONE_LOTE = 'America/Sao_Paulo';
const PAGE_SIZE_PADRAO = 20;
const PAGE_SIZE_MAX = 100;
const LOTE_LIMITE_IDS = 5000;

// 10.7.1 (fumaça full-chain): `"AdiantamentoLote"` só tem GRANT SELECT POR
// COLUNA para `authenticated`, excluindo `arquivo` (dec-023/CHK010,
// infra/hub/migrations/0066_adiantamento_tabelas.sql ~394-400 — os bytes só
// saem pela RPC de download). `select=*` do PostgREST expande para TODAS as
// colunas da tabela, inclusive `arquivo`, e o Postgres nega a query inteira
// ("permission denied for table AdiantamentoLote") — nenhum unit test (que
// mocka hubPostgrestRequest) ou o driver de integração (que chama as RPCs
// SECURITY DEFINER direto, nunca faz `select=*` via PostgREST) exercitava
// essa leitura real; só apareceu ao rodar a cadeia HTTP inteira contra
// PostgREST de verdade. Lista IDÊNTICA ao GRANT, sem `arquivo`.
const SELECT_LOTE = 'id,id_empresa,status,criado_por,criado_em,chave_idempotencia,'
  + 'quantidade,valor_total,arquivo_nome,arquivo_sha256,arquivo_bytes,'
  + 'arquivo_expurgado_em,gerado_em,primeiro_download_em,downloads,'
  + 'cancelado_em,cancelado_por,cancelado_motivo,nao_enviado_declarado,concluido_em';

// Enum real de AdiantamentoSolicitacao.status (CHECK
// `adiantamentosolicitacao_status_chk`, infra/hub/migrations/0066:200-203) —
// fonte do filtro `status`/`exportado`/`pago`/`pendencia` de `GET /` (4.1.1).
const TODOS_STATUS = [
  'AGUARDANDO_CORTE', 'AGUARDANDO_PRODUCAO', 'LIBERADA', 'EM_LOTE', 'EXPORTADA',
  'PAGA', 'FALHOU', 'INELEGIVEL', 'REJEITADA', 'CANCELADA', 'ENCERRADA',
];
// R-13 (PLANO §16.2): "Exportado ≠ pago" — `exportado=true` cobre tudo que já
// passou pelo 1º download do lote (EXPORTADA) e o que veio depois dela.
const STATUS_EXPORTADO = ['EXPORTADA', 'PAGA', 'FALHOU', 'ENCERRADA'];
const STATUS_PAGO = ['PAGA'];
// `pendencia` [ADAPTADO — a validar]: única pendência representada por um
// STATUS próprio hoje é FALHOU (a pendência CONTA_ALTERADA de R-10 não é um
// status, é sinalizada só quando o financeiro abre o detalhe — não há coluna
// barata para filtrar isso na listagem sem uma query por linha).
const STATUS_PENDENCIA = ['FALHOU'];

function complementoStatus(subset) {
  return TODOS_STATUS.filter((s) => !subset.includes(s));
}

/** Resolve o filtro `status=in.(...)` combinando `status` (CSV) + booleans
 * `exportado`/`pago`/`pendencia` por interseção — nunca emite a mesma chave
 * de querystring duas vezes (4.1.1). `null` = sem restrição. */
function resolverFiltroStatus({
  status, exportado, pago, pendencia,
}) {
  let atual = null;
  const aplicar = (conjunto) => {
    atual = atual === null ? conjunto : atual.filter((s) => conjunto.includes(s));
  };
  if (typeof status === 'string' && status.trim() !== '') {
    const lista = status.split(',').map((s) => s.trim().toUpperCase()).filter((s) => TODOS_STATUS.includes(s));
    if (lista.length) aplicar(lista);
  }
  if (exportado === 'true') aplicar(STATUS_EXPORTADO);
  if (exportado === 'false') aplicar(complementoStatus(STATUS_EXPORTADO));
  if (pago === 'true') aplicar(STATUS_PAGO);
  if (pago === 'false') aplicar(complementoStatus(STATUS_PAGO));
  if (pendencia === 'true') aplicar(STATUS_PENDENCIA);
  if (pendencia === 'false') aplicar(complementoStatus(STATUS_PENDENCIA));
  return atual;
}

// Enum real de AdiantamentoLote.status (CHECK `adiantamentolote_status_chk`,
// infra/hub/migrations/0066:261-263) — allowlist do filtro `status` de
// `GET /lotes`, mesmo papel que `TODOS_STATUS` faz em `resolverFiltroStatus`.
const STATUS_LOTE = ['GERANDO', 'GERADO', 'EXPORTADO', 'CONCLUIDO', 'CONCLUIDO_COM_FALHAS', 'CANCELADO'];

const RE_DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Valida o intervalo `de`/`ate` das listagens ANTES de ele virar filtro do
 * PostgREST. Sem isso os dois entravam crus (sem validação e sem encode) na
 * querystring montada por `partes.join('&')`: bastava `&cnpj_prestador=like.12*`
 * no valor para anexar um filtro próprio e deduzir o documento dígito a
 * dígito pela contagem de resultados — o `GRANT SELECT` é da tabela inteira
 * (0066:388), então só permissão de leitura já bastava para derrotar a
 * máscara do módulo. Vazio/ausente continua significando "sem filtro".
 * Devolve `{ erro: 'de'|'ate' }` no formato de `motivo` de DADOS_INVALIDOS. */
function validarIntervaloDatas(query) {
  const de = typeof query.de === 'string' ? query.de.trim() : '';
  const ate = typeof query.ate === 'string' ? query.ate.trim() : '';
  if (de && !RE_DATA_ISO.test(de)) return { erro: 'de' };
  if (ate && !RE_DATA_ISO.test(ate)) return { erro: 'ate' };
  return { de, ate };
}

/** Pendências [ADAPTADO] de uma solicitação — hoje só `FALHOU` é
 * representável sem query extra por linha (ver `STATUS_PENDENCIA` acima). */
function pendenciasDaSolicitacao(row) {
  return row.status === 'FALHOU' ? ['FALHOU'] : [];
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers de domínio (DUPLICADOS deliberadamente — mesmo padrão de
// routes/hub-avisos.js/routes/hub-motoristas.js: cada arquivo de rota do hub
// mantém sua própria cópia de helpers pequenos, sem import cross-domain).
// ────────────────────────────────────────────────────────────────────────────

function idValido(raw) {
  return typeof raw === 'string' && /^\d+$/.test(raw);
}

function parsePaginacao(query) {
  let page = parseInt(query && query.page, 10);
  if (!Number.isInteger(page) || page < 1) page = 1;
  let pageSize = parseInt(query && query.pageSize, 10);
  if (!Number.isInteger(pageSize) || pageSize < 1) pageSize = PAGE_SIZE_PADRAO;
  if (pageSize > PAGE_SIZE_MAX) pageSize = PAGE_SIZE_MAX;
  return { page, pageSize };
}

function mensagemDeErro(e) {
  return String((e && e.body) || (e && e.message) || '');
}

/** Campo `details` do JSON de erro do PostgREST (schema padrão
 * `{code,details,hint,message}`, mesmo formato do `PostgrestError` do
 * supabase-js) — usado quando a RPC anexa dado estruturado via
 * `RAISE EXCEPTION '<CODIGO>' USING DETAIL = <jsonb-ou-array>::text`
 * (contracts/sql-rpc.md: `SOLICITACOES_EM_OUTRO_LOTE` traz os ids,
 * `APURACAO_COM_PENDENCIAS` traz a contagem por status). `null` se o corpo
 * não for o JSON esperado ou não tiver `details`. */
function detailDoErro(e) {
  try {
    const corpo = JSON.parse((e && e.body) || '');
    return typeof corpo.details === 'string' ? corpo.details : null;
  } catch {
    return null;
  }
}

/**
 * 11.23/FR-050: `hub_adiantamento_lote_criar` faz check-then-act (SELECT de
 * existência + INSERT, não atômico) sem handler de `unique_violation` no
 * INSERT — dois cliques concorrentes com a MESMA `chaveIdempotencia` fazem o
 * perdedor da corrida (UNIQUE `adiantamentolote_idempotencia_uniq`) receber
 * 23505 do PostgREST em vez do 200 idempotente. Mesmo padrão de
 * `routes/hub-avisos.js:115` (`isCorridaChaveIdempotencia`/dec-097): detecta
 * a corrida para retentar UMA vez — na 2ª chamada o SELECT do topo da RPC já
 * vê a linha do vencedor commitada e devolve `reutilizado:true`.
 * @param {Error & {body?: string}} e
 */
function isCorridaChaveIdempotenciaLote(e) {
  const corpo = String((e && e.body) || '');
  return corpo.includes('23505') || corpo.includes('adiantamentolote_idempotencia_uniq');
}

function motivoValido(raw) {
  return typeof raw === 'string' && raw.trim().length >= 3 && raw.trim().length <= 500;
}

/** `ContaMascarada` (hub-api.md) a partir do jsonb camelCase JÁ mascarado
 * pelo SQL (`hub_conta_bancaria_mascarar`/`hub_conta_bancaria_listar`/
 * `hub_conta_bancaria_detalhe` sem `completo`) — ver nota de topo do
 * arquivo. `pontuarDocumentoMascarado` funciona aqui porque
 * `hub_adiantamento_mascarar` preserva o comprimento original (11/14). */
function mapContaMascaradaHub(j) {
  if (!j) return null;
  return {
    id: j.id,
    status: j.status,
    origem: j.origem,
    banco: formatarBancoCodigoNome(j.bancoCodigo, j.bancoNome),
    agencia: j.agencia,
    contaMascarada: `${j.conta}-${j.contaDigito}`,
    tipoConta: j.tipoConta,
    titularNome: j.titularNome,
    documentoMascarado: pontuarDocumentoMascarado(j.titularDocumento),
    alertas: j.alertas || [],
    motivoRejeicao: j.motivoRejeicao ?? null,
    solicitadaEm: j.solicitadaEm,
    revisadaEm: j.revisadaEm,
  };
}

/** Converte o jsonb CRU camelCase de `hub_conta_bancaria_detalhe(p_completo=true)`
 * para o formato snake_case que `mapContaCompleta` (lib/adiantamento-dto.js)
 * espera — reusa o mapper existente em vez de duplicar a lógica de máscara. */
function rowCompletaSnakeCase(j) {
  return {
    id: j.id,
    status: j.status,
    origem: j.origem,
    banco_nome: j.bancoNome,
    agencia: j.agencia,
    conta: j.conta,
    conta_digito: j.contaDigito,
    tipo_conta: j.tipoConta,
    titular_nome: j.titularNome,
    titular_documento: j.titularDocumento,
    chave_pix_tipo: j.chavePixTipo,
    chave_pix: j.chavePix,
    email_comprovante: j.emailComprovante,
    alertas: j.alertas || [],
    motivo_rejeicao: j.motivoRejeicao,
    solicitada_em: j.solicitadaEm,
    revisada_em: j.revisadaEm,
    entregador_id: j.entregadorId,
    entregador_nome: j.entregadorNome,
  };
}

/**
 * Resolve payload+entidadeAtiva+claims do accessToken e confirma que a
 * ENTIDADE ATIVA concede `permissao` (passo 3 da cadeia de guarda). Escopo
 * (dec-022): grupo inteiro só quando `entidadeAtiva === GRUPO_MOVEE_ID`;
 * filial vê só a própria empresa. Envia a resposta de erro e retorna `null`
 * em qualquer falha; retorna o contexto em caso de sucesso.
 * @returns {Promise<{payload:object, entidadeAtiva:number, claims:object}|null>}
 */
async function resolverContextoAdiantamentos(req, res, permissao) {
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

  const permsEntidade = await obterPermissoesEfetivasPorEntidade(payload.sub, entidadeAtiva);
  if (!permsEntidade.has(permissao)) {
    res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
    return null;
  }

  let escopo;
  if (entidadeAtiva === GRUPO_MOVEE_ID) {
    // 10.7.1 (fumaça full-chain): `mesmoGrupoQue` é fail-safe e devolve
    // `false` sem popular `cache.ids` quando a resolução de grupo falha por
    // infra (PostgREST/JWT) — `[...grupoCache.ids]` incondicional então
    // lança TypeError (`grupoCache.ids is not iterable`) e derruba a
    // requisição inteira com 500. Como `entidadeAtiva` já É GRUPO_MOVEE_ID
    // aqui, degradar para o escopo solo (em vez de 403, ao contrário de
    // hub-avisos.js que checa pertencimento de uma entidade possivelmente
    // diferente) preserva a função básica quando só a EXPANSÃO do grupo falha.
    const grupoCache = {};
    await mesmoGrupoQue(entidadeAtiva, GRUPO_MOVEE_ID, grupoCache);
    escopo = grupoCache.ids ? [...grupoCache.ids] : [entidadeAtiva];
  } else {
    escopo = [entidadeAtiva];
  }

  const claims = { usuarioId: payload.sub, empresaAtiva: entidadeAtiva, escopo };
  return { payload, entidadeAtiva, claims };
}

// FR-027-like (mesmo padrão de hub-avisos.js) — prévia e criação de lote,
// 30/15min cada (contracts/hub-api.md: "[PROPOSTA]; PLANO §20 não fixa").
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
// 11.28/contrato-rate-limit-lotes: eram a MESMA instância para as duas
// rotas — o balde de 30/15min era somado entre prévia e criação, em vez de
// "cada" (hub-api.md:53). Duas instâncias independentes, uma por rota.
const previaRateLimiter = limiterPorUsuario(30);
const loteRateLimiter = limiterPorUsuario(30);
// Revisão de segurança 2026-09-18: `GET /repasse/exportar` materializa até
// 100.000 linhas (p_limite) e monta o CSV inteiro em memória, e era a única
// das rotas caras sem limitador. Em produção o banco do hub divide o Postgres
// com o envio em massa, então uma rajada aqui — nem precisa ser má-fé: um
// painel de BI recarregando basta — degrada o produto legado junto. Balde
// próprio, para não competir com a prévia nem com a criação de lote (11.28).
const exportarRepasseRateLimiter = limiterPorUsuario(30);

// ════════════════════════════════════════════════════════════════════════
// 4.1 — Solicitações
// ════════════════════════════════════════════════════════════════════════

router.get('/', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.consultar');
    if (!ctx) return;
    const { claims } = ctx;

    const { page, pageSize } = parsePaginacao(req.query);
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const datas = validarIntervaloDatas(req.query);
    if (datas.erro) return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: datas.erro });

    const partes = [`id_empresa=in.(${claims.escopo.join(',')})`];
    if (datas.de) partes.push(`data_solicitacao=gte.${datas.de}`);
    if (datas.ate) partes.push(`data_solicitacao=lte.${datas.ate}`);
    const statusFiltro = resolverFiltroStatus(req.query);
    if (statusFiltro) partes.push(`status=in.(${statusFiltro.join(',')})`);

    let embed = 'entregador:Entregador(nome)';
    if (typeof req.query.busca === 'string' && req.query.busca.trim()) {
      const termo = req.query.busca.trim();
      if (/^\d+$/.test(termo)) {
        partes.push(`id=eq.${termo}`);
      } else {
        embed = 'entregador:Entregador!inner(nome)';
        partes.push(`entregador.nome=ilike.*${encodeURIComponent(termo.replace(/[*%]/g, ''))}*`);
      }
    }

    const ordem = req.query.ordem === 'antigo' ? 'asc' : 'desc';
    partes.push(`select=*,${embed}`);
    partes.push(`order=data_solicitacao.${ordem}`);

    const { data: linhas, total } = await hubPostgrestRequest(
      `AdiantamentoSolicitacao?${partes.join('&')}`, 'GET', null, claims, { count: true, range: { from, to } }
    );
    const rows = linhas || [];

    const idsPagina = rows.map((r) => r.id);
    let loteMap = new Map();
    if (idsPagina.length) {
      const itensLote = await hubPostgrestRequest(
        `AdiantamentoLoteItem?solicitacao_id=in.(${idsPagina.join(',')})&situacao=in.(incluido,pago)&select=solicitacao_id,lote_id`,
        'GET', null, claims
      );
      loteMap = new Map((itensLote || []).map((i) => [i.solicitacao_id, i.lote_id]));
    }

    const itens = rows.map((row) => mapSolicitacaoResumo({
      ...row,
      pendencias: pendenciasDaSolicitacao(row),
      lote_id: loteMap.get(row.id) ?? null,
    }));

    return res.status(200).json({ itens, total, page, pageSize });
  } catch (e) {
    console.error('[hub-adiantamentos] erro em GET /:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});


// ════════════════════════════════════════════════════════════════════════
// 4.2 — Configuração
// ════════════════════════════════════════════════════════════════════════

router.get('/configuracoes', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.consultar');
    if (!ctx) return;
    const { claims } = ctx;

    const linhas = await hubPostgrestRequest(
      `AdiantamentoConfiguracao?id_empresa=eq.${GRUPO_MOVEE_ID}&select=*,criador:Usuario(nome)&order=versao.desc`,
      'GET', null, claims
    );
    const rows = linhas || [];
    if (!rows.length) return res.status(200).json({ vigente: null, historico: [] });

    const agora = new Date();
    const vigenteRow = rows.find((r) => new Date(r.vigente_desde) <= agora) || rows[0];

    return res.status(200).json({
      vigente: mapConfiguracao(vigenteRow),
      historico: rows.map((r) => ({
        versao: r.versao,
        vigenteDesde: r.vigente_desde,
        criadoPor: r.criador ? { id: r.criado_por, nome: r.criador.nome } : r.criado_por,
        criadoEm: r.vigente_desde,
        motivo: r.motivo,
      })),
    });
  } catch (e) {
    console.error('[hub-adiantamentos] erro em GET /configuracoes:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.get('/configuracoes/categorias', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.consultar');
    if (!ctx) return;
    const { claims } = ctx;
    const fonte = typeof req.query.fonte === 'string' && req.query.fonte ? req.query.fonte : null;

    const linhas = await hubPostgrestRequest('rpc/hub_adiantamento_categorias', 'POST', { p_fonte: fonte }, claims);
    return res.status(200).json({
      itens: (linhas || []).map((r) => ({
        descricao: r.descricao,
        lancamentos: Number(r.lancamentos) || 0,
        semMotoristaIdentificado: r.sem_motorista_identificado === true,
      })),
    });
  } catch (e) {
    console.error('[hub-adiantamentos] erro em GET /configuracoes/categorias:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.put('/configuracoes', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.configurar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.configurar');
    if (!ctx) return;
    const { claims, entidadeAtiva, payload } = ctx;

    const corpo = (req.body && typeof req.body === 'object') ? req.body : {};
    if (!Number.isInteger(corpo.versaoEsperada)) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'versaoEsperada' });
    }

    // dec-015/Constitution II: só os campos do contrato seguem — sem mass
    // assignment de `req.body` cru para a RPC (mesmo padrão de S6/CHK019 já
    // aplicado em routes/motorista-adiantamento.js#3.2.6).
    const CAMPOS = [
      'vigenteDesde', 'motivo', 'diasHabilitados', 'horarioAbertura', 'horarioCorte', 'percentual', 'taxaFixa',
      'fonteProducao', 'categoriasProducao', 'previsaoPagamentoTexto', 'descricaoPixModelo', 'apuracaoDiaInicio',
      'apuracaoDiasAteRepasse', 'apuracaoDataBase', 'categoriasExtrato', 'descontoAdiantamentos', 'descontoDebitos',
      'repasseVisivelApp',
    ];
    const dados = {};
    for (const campo of CAMPOS) {
      if (corpo[campo] !== undefined) dados[campo] = corpo[campo];
    }

    // 11.12 (converge onda-040, FR-024): "antes" é a linha vigente ANTES do
    // salvamento — a mesma que a RPC vai comparar via CAS (FOR UPDATE), então
    // se a RPC aceitar a versão esperada, esta leitura não está desatualizada.
    // Best-effort: falha aqui não pode travar o salvamento (auditoria nunca é
    // mais crítica que a operação que audita, dec-dominante de 11.9).
    let linhaAntes = null;
    let leituraAntesFalhou = false;
    try {
      const atuais = await hubPostgrestRequest(
        `AdiantamentoConfiguracao?id_empresa=eq.${GRUPO_MOVEE_ID}&order=versao.desc&limit=1`,
        'GET', null, claims
      );
      linhaAntes = Array.isArray(atuais) ? (atuais[0] || null) : null;
    } catch (e) {
      console.error('[hub-adiantamentos] falha ao ler config vigente p/ auditoria antes/depois:', e.message);
      leituraAntesFalhou = true;
    }

    let novaLinha;
    try {
      const linhas = await hubPostgrestRequest(
        'rpc/hub_adiantamento_configuracao_salvar',
        'POST', { p_versao_esperada: corpo.versaoEsperada, p_dados: dados }, claims
      );
      novaLinha = Array.isArray(linhas) ? linhas[0] : linhas;
    } catch (e) {
      const msg = mensagemDeErro(e);
      if (msg.includes('VERSAO_DESATUALIZADA')) return res.status(409).json({ erro: 'VERSAO_DESATUALIZADA' });
      if (msg.includes('PERMISSAO_NEGADA')) return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
      if (msg.includes('FORA_DO_GRUPO_MOVEE')) return res.status(403).json({ erro: 'FORA_DO_GRUPO_MOVEE' });
      console.error('[hub-adiantamentos] erro em PUT /configuracoes:', e.message);
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }
    if (!novaLinha) return res.status(500).json({ erro: 'ERRO_SERVIDOR' });

    // Diff real antes/depois (FR-024) — só os campos que de fato mudaram, e
    // não o payload submetido (que inclui reenvio idêntico e nunca inclui o
    // que foi omitido/herdado via COALESCE na RPC).
    const CAMPOS_COLUNA = [
      'vigente_desde', 'motivo', 'dias_habilitados', 'horario_abertura', 'horario_corte', 'percentual', 'taxa_fixa',
      'fonte_producao', 'categorias_producao', 'previsao_pagamento_texto', 'descricao_pix_modelo', 'apuracao_dia_inicio',
      'apuracao_dias_ate_repasse', 'apuracao_data_base', 'categorias_extrato', 'desconto_adiantamentos', 'desconto_debitos',
      'repasse_visivel_app',
    ];
    // 12.2 (converge onda-044, FR-024): quando a leitura de `linhaAntes`
    // falhou, não há "antes" real para comparar — gravar `null` para os 18
    // campos afirmaria que cada um veio de nulo (dado inventado, pior que
    // registrar a ausência). Neste caso a trilha grava só o "depois"
    // submetido + `antesIndisponivel: true`, nunca um "antes" fabricado.
    const antes = {};
    const depois = {};
    if (leituraAntesFalhou) {
      for (const campo of CAMPOS_COLUNA) {
        depois[campo] = novaLinha[campo] ?? null;
      }
    } else {
      for (const campo of CAMPOS_COLUNA) {
        const valorAntes = linhaAntes ? (linhaAntes[campo] ?? null) : null;
        const valorDepois = novaLinha[campo] ?? null;
        if (JSON.stringify(valorAntes) !== JSON.stringify(valorDepois)) {
          antes[campo] = valorAntes;
          depois[campo] = valorDepois;
        }
      }
    }

    await registrarAuditoria({
      idEmpresa: entidadeAtiva,
      usuarioId: payload.sub,
      acao: 'adiantamento.configuracao_alterada',
      recurso: 'AdiantamentoConfiguracao',
      recursoId: novaLinha.id,
      detalhes: leituraAntesFalhou
        ? { versao: novaLinha.versao, antes, depois, antesIndisponivel: true }
        : { versao: novaLinha.versao, antes, depois },
      claims,
    });

    return res.status(201).json(mapConfiguracao(novaLinha));
  } catch (e) {
    console.error('[hub-adiantamentos] erro inesperado em PUT /configuracoes:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// 4.3 — Contas bancárias
// ════════════════════════════════════════════════════════════════════════

router.get('/contas', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.contas_consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.contas_consultar');
    if (!ctx) return;
    const { claims } = ctx;
    const { page, pageSize } = parsePaginacao(req.query);
    const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : null;
    // 7.11.1 (dec-105): H06 do protótipo filtra também por origem, alertas,
    // motorista (nome ou documento) e banco — 1.735 contas na carga inicial
    // tornam esses filtros essenciais para o financeiro.
    const origem = typeof req.query.origem === 'string' && req.query.origem ? req.query.origem : null;
    const semAlertas = req.query.semAlertas === 'true' ? true : (req.query.semAlertas === 'false' ? false : null);
    const busca = typeof req.query.busca === 'string' && req.query.busca.trim() ? req.query.busca.trim() : null;
    const banco = typeof req.query.banco === 'string' && req.query.banco ? req.query.banco : null;

    const linhas = await hubPostgrestRequest(
      'rpc/hub_conta_bancaria_listar', 'POST',
      {
        p_status: status, p_pagina: page, p_tamanho_pagina: pageSize,
        p_origem: origem, p_sem_alertas: semAlertas, p_busca: busca, p_banco: banco,
      }, claims
    );
    const rows = linhas || [];
    const total = rows.length ? Number(rows[0].total) : 0;
    return res.status(200).json({ itens: rows.map((r) => mapContaMascaradaHub(r.dados)), total, page, pageSize });
  } catch (e) {
    console.error('[hub-adiantamentos] erro em GET /contas:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.get('/contas/:id', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.contas_consultar'), async (req, res) => {
  try {
    const completo = req.query.completo === 'true';
    const permissaoNecessaria = completo ? 'adiantamentos.contas_revisar' : 'adiantamentos.contas_consultar';
    const ctx = await resolverContextoAdiantamentos(req, res, permissaoNecessaria);
    if (!ctx) return;
    const { claims, entidadeAtiva, payload } = ctx;
    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = Number(req.params.id);

    let jsonb;
    try {
      const resultado = await hubPostgrestRequest(
        'rpc/hub_conta_bancaria_detalhe', 'POST', { p_id: id, p_completo: completo }, claims
      );
      jsonb = Array.isArray(resultado) ? resultado[0] : resultado;
    } catch (e) {
      const msg = mensagemDeErro(e);
      if (msg.includes('NAO_ENCONTRADA')) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
      if (msg.includes('PERMISSAO_NEGADA')) return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
      console.error('[hub-adiantamentos] erro em GET /contas/:id:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
    if (!jsonb) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });

    if (completo) {
      // 11.9 (converge onda-039, FR-019): `registrarAuditoria` é fail-open
      // por decisão deliberada (lib/hub-auditoria.js — "falhar fechado
      // faria uma indisponibilidade da auditoria derrubar o LOGIN"), correta
      // para os 38 chamadores que protegem acesso/sessão. Mas revelar dado
      // bancário completo SEM garantia de que a revelação ficou registrada
      // contradiz FR-019 ("registrando que a visualização completa
      // ocorreu"). Único endpoint tornado fail-closed: se a auditoria não
      // confirmar `ok:true`, o dado NÃO é devolvido — reusa o contrato
      // `{ok, erro}` que a função já expõe, sem alterar o comportamento
      // fail-open dos demais 38 chamadores.
      const auditoria = await registrarAuditoria({
        idEmpresa: entidadeAtiva,
        usuarioId: payload.sub,
        acao: 'conta_bancaria.visualizada',
        recurso: 'ContaBancariaMotorista',
        recursoId: id,
        detalhes: {},
        claims,
      });
      if (!auditoria.ok) {
        console.error('[hub-adiantamentos] GET /contas/:id?completo=true fail-closed: auditoria não confirmada:', auditoria.erro);
        return res.status(503).json({ erro: 'INDISPONIVEL' });
      }
      res.set('Cache-Control', 'no-store');
      return res.status(200).json(mapContaCompleta(rowCompletaSnakeCase(jsonb)));
    }
    return res.status(200).json(mapContaMascaradaHub(jsonb));
  } catch (e) {
    console.error('[hub-adiantamentos] erro inesperado em GET /contas/:id:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.post('/contas/:id/aprovar', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.contas_revisar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.contas_revisar');
    if (!ctx) return;
    const { claims, entidadeAtiva, payload } = ctx;
    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = Number(req.params.id);
    const entregadorConfirmadoId = req.body && req.body.entregadorConfirmadoId;
    if (!Number.isInteger(entregadorConfirmadoId) || entregadorConfirmadoId <= 0) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'entregadorConfirmadoId' });
    }

    let resultado;
    try {
      resultado = await hubPostgrestRequest(
        'rpc/hub_conta_bancaria_aprovar', 'POST',
        { p_id: id, p_entregador_confirmado_id: entregadorConfirmadoId }, claims
      );
    } catch (e) {
      const msg = mensagemDeErro(e);
      if (msg.includes('NAO_ENCONTRADA')) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
      if (msg.includes('TRANSICAO_INVALIDA')) return res.status(409).json({ erro: 'TRANSICAO_INVALIDA' });
      if (msg.includes('DADOS_INVALIDOS')) return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
      if (msg.includes('PERMISSAO_NEGADA')) return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
      console.error('[hub-adiantamentos] erro em POST /contas/:id/aprovar:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }

    await registrarAuditoria({
      idEmpresa: entidadeAtiva, usuarioId: payload.sub, acao: 'conta_bancaria.aprovada',
      recurso: 'ContaBancariaMotorista', recursoId: id, detalhes: {}, claims,
    });
    return res.status(200).json(Array.isArray(resultado) ? resultado[0] : resultado);
  } catch (e) {
    console.error('[hub-adiantamentos] erro inesperado em POST /contas/:id/aprovar:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.post('/contas/:id/rejeitar', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.contas_revisar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.contas_revisar');
    if (!ctx) return;
    const { claims, entidadeAtiva, payload } = ctx;
    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = Number(req.params.id);
    const motivo = req.body && typeof req.body.motivo === 'string' ? req.body.motivo.trim() : undefined;
    if (!motivoValido(motivo)) return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'motivo' });

    let resultado;
    try {
      resultado = await hubPostgrestRequest('rpc/hub_conta_bancaria_rejeitar', 'POST', { p_id: id, p_motivo: motivo }, claims);
    } catch (e) {
      const msg = mensagemDeErro(e);
      if (msg.includes('NAO_ENCONTRADA')) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
      if (msg.includes('TRANSICAO_INVALIDA')) return res.status(409).json({ erro: 'TRANSICAO_INVALIDA' });
      if (msg.includes('MOTIVO_OBRIGATORIO')) return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'motivo' });
      if (msg.includes('PERMISSAO_NEGADA')) return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
      console.error('[hub-adiantamentos] erro em POST /contas/:id/rejeitar:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }

    await registrarAuditoria({
      idEmpresa: entidadeAtiva, usuarioId: payload.sub, acao: 'conta_bancaria.rejeitada',
      recurso: 'ContaBancariaMotorista', recursoId: id, detalhes: { motivo }, claims,
    });
    return res.status(200).json(Array.isArray(resultado) ? resultado[0] : resultado);
  } catch (e) {
    console.error('[hub-adiantamentos] erro inesperado em POST /contas/:id/rejeitar:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.post('/contas/aprovar-lote', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.contas_revisar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.contas_revisar');
    if (!ctx) return;
    const { claims, entidadeAtiva, payload } = ctx;

    const ids = req.body && req.body.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > LOTE_LIMITE_IDS || !ids.every((n) => Number.isInteger(n) && n > 0)) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'ids' });
    }

    let resultado;
    try {
      resultado = await hubPostgrestRequest('rpc/hub_conta_bancaria_aprovar_lote', 'POST', { p_ids: ids }, claims);
    } catch (e) {
      const msg = mensagemDeErro(e);
      if (msg.includes('PERMISSAO_NEGADA')) return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
      console.error('[hub-adiantamentos] erro em POST /contas/aprovar-lote:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
    const linhas = resultado || [];
    const aprovadas = linhas.filter((l) => l.aprovada === true).length;
    const ignoradas = linhas.filter((l) => l.aprovada !== true).map((l) => ({ id: l.id, motivo: l.motivo_ignorada }));

    if (aprovadas > 0) {
      await registrarAuditoria({
        idEmpresa: entidadeAtiva, usuarioId: payload.sub, acao: 'conta_bancaria.aprovada_lote',
        recurso: 'ContaBancariaMotorista', recursoId: null, detalhes: { quantidade: aprovadas }, claims,
      });
    }
    return res.status(200).json({ aprovadas, ignoradas });
  } catch (e) {
    console.error('[hub-adiantamentos] erro inesperado em POST /contas/aprovar-lote:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// 4.4 — Lotes de pagamento
// ════════════════════════════════════════════════════════════════════════

/** `LinhaPrevia`/item apto — busca entregador+conta_bancaria_id em lote (1
 * query) e formata a conta com o jsonb MASCARADO por id único (ponytail:
 * loop de chamadas RPC por conta única — se a seleção crescer a ponto de
 * ter milhares de contas distintas na mesma prévia, trocar por uma RPC de
 * lote dedicada; hoje a seleção real é de dezenas). */
async function montarLinhasPrevia(aptas, claims) {
  if (!aptas.length) return [];
  const ids = aptas.map((a) => a.solicitacao_id);
  const solicitacoes = await hubPostgrestRequest(
    `AdiantamentoSolicitacao?id=in.(${ids.join(',')})&select=id,conta_bancaria_id,entregador:Entregador(nome)`,
    'GET', null, claims
  );
  const porId = new Map((solicitacoes || []).map((s) => [s.id, s]));

  const contaCache = new Map();
  async function contaDe(contaId) {
    if (!contaId) return null;
    if (!contaCache.has(contaId)) {
      const resultado = await hubPostgrestRequest(
        'rpc/hub_conta_bancaria_detalhe', 'POST', { p_id: contaId, p_completo: false }, claims
      );
      contaCache.set(contaId, Array.isArray(resultado) ? resultado[0] : resultado);
    }
    return contaCache.get(contaId);
  }

  const linhas = [];
  for (const apta of aptas) {
    const sol = porId.get(apta.solicitacao_id);
    const conta = sol ? await contaDe(sol.conta_bancaria_id) : null;
    linhas.push({
      id: apta.solicitacao_id,
      integrationId: formatarSequencial(apta.solicitacao_id, 'ADV-'),
      motorista: sol && sol.entregador ? sol.entregador.nome : null,
      valor: dinheiro(apta.valor_liquido),
      bancoAgenciaContaMascarados: conta ? `Ag. ${conta.agencia} · ${conta.tipoConta} ${conta.conta}-${conta.contaDigito}` : null,
    });
  }
  return linhas;
}

router.post('/lotes/previa', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.pagamentos_consultar'), previaRateLimiter, async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.pagamentos_consultar');
    if (!ctx) return;
    const { claims } = ctx;
    const ids = req.body && req.body.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > LOTE_LIMITE_IDS || !ids.every((n) => Number.isInteger(n) && n > 0)) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'ids' });
    }
    const idsUnicos = [...new Set(ids)];

    const linhas = await hubPostgrestRequest('rpc/hub_adiantamento_lote_previa', 'POST', { p_ids: idsUnicos }, claims);
    const rows = linhas || [];
    const aptasRows = rows.filter((r) => r.apta === true);
    const pendentesRows = rows.filter((r) => r.apta !== true);
    if (idsUnicos.length !== ids.length) {
      // Duplicatas na própria seleção (edge — DUPLICADA_NA_SELECAO): as que
      // sobrarem fora do conjunto único viram pendência, sem duplicar linha.
      for (const id of ids) {
        if (ids.indexOf(id) !== ids.lastIndexOf(id) && !pendentesRows.find((p) => p.solicitacao_id === id)) {
          pendentesRows.push({ solicitacao_id: id, motivo_pendencia: 'DUPLICADA_NA_SELECAO' });
        }
      }
    }

    const aptas = await montarLinhasPrevia(aptasRows, claims);
    const totalApto = aptasRows.reduce((acc, r) => acc + Number(r.valor_liquido || 0), 0);

    return res.status(200).json({
      selecionadas: ids.length,
      aptas,
      pendentes: pendentesRows.map((r) => ({ id: r.solicitacao_id, pendencias: [r.motivo_pendencia].filter(Boolean) })),
      quantidadeApta: aptasRows.length,
      totalApto: dinheiro(totalApto.toFixed(2)),
    });
  } catch (e) {
    console.error('[hub-adiantamentos] erro em POST /lotes/previa:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.post('/lotes', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.lote_criar'), loteRateLimiter, async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.lote_criar');
    if (!ctx) return;
    const { claims, entidadeAtiva, payload } = ctx;
    const corpo = (req.body && typeof req.body === 'object') ? req.body : {};
    const { ids, quantidadeEsperada, totalEsperado, chaveIdempotencia } = corpo;
    // 13.1: NAO checar `ids.length > LOTE_LIMITE_IDS` aqui — a RPC
    // (0076:65) ja aplica o mesmo limite 5000 e responde com o erro de
    // negocio LOTE_ACIMA_DO_LIMITE (-> 422 abaixo). Checar o mesmo limite
    // aqui antes faria o excesso virar 400 DADOS_INVALIDOS, tornando o 422
    // documentado (hub-api.md:127, quickstart.md:100) inalcancavel.
    if (
      !Array.isArray(ids) || ids.length === 0 || !ids.every((n) => Number.isInteger(n) && n > 0)
      || !Number.isInteger(quantidadeEsperada) || typeof totalEsperado !== 'string' || !/^\d+\.\d{2}$/.test(totalEsperado)
      || typeof chaveIdempotencia !== 'string'
    ) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
    }

    let resultado;
    // 11.23: no máximo 2 tentativas — a 2ª só ocorre se a 1ª colidiu na
    // UNIQUE de idempotência (perdedor da corrida); por essa altura o
    // vencedor já commitou, então a 2ª chamada cai direto no ramo "já
    // existe" (SELECT do topo da RPC) sem 3ª tentativa possível.
    for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
      try {
        const linhas = await hubPostgrestRequest(
          'rpc/hub_adiantamento_lote_criar', 'POST',
          {
            p_ids: ids, p_quantidade_esperada: quantidadeEsperada, p_total_esperado: totalEsperado, p_chave: chaveIdempotencia,
          }, claims
        );
        resultado = Array.isArray(linhas) && linhas[0];
        break;
      } catch (e) {
        const msg = mensagemDeErro(e);
        if (msg.includes('LOTE_ACIMA_DO_LIMITE')) return res.status(422).json({ erro: 'LOTE_ACIMA_DO_LIMITE' });
        if (msg.includes('SOLICITACOES_EM_OUTRO_LOTE')) {
          let ids2 = [];
          try { ids2 = JSON.parse(detailDoErro(e) || '[]'); } catch { ids2 = []; }
          return res.status(409).json({ erro: 'SOLICITACOES_EM_OUTRO_LOTE', ids: ids2 });
        }
        if (msg.includes('PREVIA_DESATUALIZADA')) return res.status(409).json({ erro: 'PREVIA_DESATUALIZADA' });
        if (msg.includes('DADOS_INVALIDOS')) return res.status(400).json({ erro: 'DADOS_INVALIDOS' });
        if (msg.includes('PERMISSAO_NEGADA')) return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
        if (isCorridaChaveIdempotenciaLote(e) && tentativa === 1) continue;
        console.error('[hub-adiantamentos] erro em POST /lotes:', e.message);
        return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
      }
    }
    if (!resultado) return res.status(500).json({ erro: 'ERRO_SERVIDOR' });

    // Gera + valida + grava o xlsx só na criação DE FATO (não no reenvio
    // idempotente — `reutilizado`), mesmo espírito de dec-097 (hub-avisos.js).
    if (!resultado.reutilizado) {
      try {
        // 11.16/FR-055-descricao-pix: `hub_adiantamento_lote_criar` para de
        // interpolar `descricao_pix_modelo` — grava o modelo BRUTO (ainda
        // com os placeholders) em `col_descricao_pix`. Quem renderiza e
        // VALIDA (recusa placeholder desconhecido) é o Node, reusando
        // `renderizarDescricaoPix` — a SQL nunca fez essa validação.
        const itensBrutos = await hubPostgrestRequest(
          `AdiantamentoLoteItem?lote_id=eq.${resultado.id}&select=*,solicitacao:AdiantamentoSolicitacao(data_producao)&order=linha.asc`,
          'GET', null, claims
        );
        const itensLote = (itensBrutos || []).map((item) => ({
          ...item,
          col_descricao_pix: renderizarDescricaoPix(item.col_descricao_pix, {
            nome: item.col_nome,
            dataProducaoISO: item.solicitacao && item.solicitacao.data_producao,
          }),
        }));
        const buffer = montarPlanilhaTransfeera(itensLote, contratoTransfeera);
        const validacao = validarPlanilhaTransfeera(buffer, contratoTransfeera, {
          quantidade: resultado.quantidade, valorTotal: paraCentavos(resultado.valor_total),
          idsIntegracao: itensLote.map((i) => i.col_id_integracao),
        });
        if (!validacao.ok) throw new Error(`VALIDACAO_PLANILHA_FALHOU:${validacao.falhas.join(',')}`);

        const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
        // 11.19: o container roda em UTC — `toISOString()`/`current_date`
        // nomeariam o arquivo com o dia seguinte entre 21h e 00h BRT.
        // A data de criação do lote sai do fuso da configuração (contrato
        // `contrato-nome-arquivo`), igual a `adiantamento-regras.js` faz
        // para "hoje" em routes/motorista-adiantamento.js.
        const { ano, mes, dia } = partesNoFuso(new Date(), TIMEZONE_LOTE);
        const nomeArquivo = nomeArquivoTransfeera(dataISO(ano, mes, dia), formatarSequencial(resultado.id));
        await hubPostgrestRequest(
          'rpc/hub_adiantamento_lote_arquivo', 'POST',
          {
            p_lote_id: resultado.id, p_arquivo: buffer.toString('base64'), p_sha256: sha256,
            p_bytes: buffer.length, p_nome: nomeArquivo,
            // persiste a descrição já renderizada/validada (o que mapLoteItem exibe depois)
            p_itens: itensLote.map((i) => ({ id: i.id, descricao: i.col_descricao_pix })),
          }, claims
        );
      } catch (e) {
        console.error('[hub-adiantamentos] falha ao gerar arquivo do lote — cancelando:', e.message);
        try {
          await hubPostgrestRequest(
            'rpc/hub_adiantamento_lote_cancelar', 'POST',
            { p_lote_id: resultado.id, p_motivo: 'falha_geracao', p_nao_enviado: false }, claims
          );
        } catch (e2) {
          console.error('[hub-adiantamentos] falha ao cancelar lote após falha de geração:', e2.message);
        }
        return res.status(500).json({ erro: 'FALHA_GERACAO_ARQUIVO' });
      }

      await registrarAuditoria({
        idEmpresa: entidadeAtiva, usuarioId: payload.sub, acao: 'adiantamento.lote_criado',
        recurso: 'AdiantamentoLote', recursoId: resultado.id,
        detalhes: { quantidade: resultado.quantidade, valorTotal: resultado.valor_total }, claims,
      });
      await registrarAuditoria({
        idEmpresa: entidadeAtiva, usuarioId: payload.sub, acao: 'adiantamento.lote_arquivo_gerado',
        recurso: 'AdiantamentoLote', recursoId: resultado.id, detalhes: {}, claims,
      });
    }

    const linhasFinal = await hubPostgrestRequest(`AdiantamentoLote?id=eq.${resultado.id}&select=${SELECT_LOTE}`, 'GET', null, claims);
    const loteFinal = Array.isArray(linhasFinal) && linhasFinal[0];
    return res.status(resultado.reutilizado ? 200 : 201).json(loteFinal ? mapLote(loteFinal) : null);
  } catch (e) {
    console.error('[hub-adiantamentos] erro inesperado em POST /lotes:', e.message);
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
    const to = from + pageSize - 1;

    const datas = validarIntervaloDatas(req.query);
    if (datas.erro) return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: datas.erro });

    const partes = [`id_empresa=in.(${claims.escopo.join(',')})`];
    if (datas.de) partes.push(`criado_em=gte.${datas.de}`);
    if (datas.ate) partes.push(`criado_em=lte.${datas.ate}`);
    if (typeof req.query.status === 'string' && req.query.status.trim()) {
      // Allowlist (mesma razão de `validarIntervaloDatas`): o valor ia cru
      // para a querystring do PostgREST.
      const lista = req.query.status.split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => STATUS_LOTE.includes(s));
      if (!lista.length) return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'status' });
      partes.push(`status=in.(${lista.join(',')})`);
    }
    partes.push(`select=${SELECT_LOTE}`);
    partes.push('order=criado_em.desc');

    const { data: linhas, total } = await hubPostgrestRequest(
      `AdiantamentoLote?${partes.join('&')}`, 'GET', null, claims, { count: true, range: { from, to } }
    );
    return res.status(200).json({ itens: (linhas || []).map(mapLote), total, page, pageSize });
  } catch (e) {
    console.error('[hub-adiantamentos] erro em GET /lotes:', e.message);
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

    const linhas = await hubPostgrestRequest(
      `AdiantamentoLote?id=eq.${id}&id_empresa=in.(${claims.escopo.join(',')})&select=${SELECT_LOTE}`, 'GET', null, claims
    );
    const row = Array.isArray(linhas) && linhas[0];
    if (!row) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });

    const [itensLinhas, historicoLinhas] = await Promise.all([
      hubPostgrestRequest(`AdiantamentoLoteItem?lote_id=eq.${id}&select=*&order=linha.asc`, 'GET', null, claims),
      hubPostgrestRequest(
        `AdiantamentoEvento?lote_id=eq.${id}&select=status_de,status_para,ocorrido_em,ator_tipo,ator_usuario_id,motivo&order=ocorrido_em.asc`,
        'GET', null, claims
      ),
    ]);

    return res.status(200).json({
      ...mapLote(row),
      // FASE 11 (converge onda-037, 11.7): reusa mapLoteItem (lib/adiantamento-dto.js)
      // em vez de reconstruir o item na mão — o map inline anterior concatenava
      // col_conta/col_digito CRUS sob o nome `contaMascarada` (vazamento de
      // número de conta completo numa lista, FR-019/SC-006); mapLoteItem aplica
      // a máscara de verdade (contaMascarada()/documentoMascarado(), lib/adiantamento-conta.js).
      itens: (itensLinhas || []).map(mapLoteItem),
      historico: (historicoLinhas || []).map(mapEvento),
    });
  } catch (e) {
    console.error('[hub-adiantamentos] erro em GET /lotes/:id:', e.message);
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

    let resultado;
    try {
      const linhas = await hubPostgrestRequest('rpc/hub_adiantamento_lote_download', 'POST', { p_lote_id: id }, claims);
      resultado = Array.isArray(linhas) && linhas[0];
    } catch (e) {
      const msg = mensagemDeErro(e);
      if (msg.includes('NAO_ENCONTRADA')) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
      // 13.3: expurgo por retenção (0080) é distinto de "indisponível por
      // status" — mesmo shape de resposta já usado em routes/hub-importacoes.js
      // para `arquivo_expurgado_em` (D3b/CHK021).
      if (msg.includes('ARQUIVO_EXPURGADO')) {
        let expurgadoEm = null;
        try { expurgadoEm = JSON.parse(detailDoErro(e) || 'null'); } catch { expurgadoEm = null; }
        return res.status(410).json({ erro: 'ARQUIVO_INDISPONIVEL', motivo: 'expurgado_por_retencao', expurgadoEm });
      }
      if (msg.includes('ARQUIVO_INDISPONIVEL')) return res.status(409).json({ erro: 'ARQUIVO_INDISPONIVEL' });
      if (msg.includes('PERMISSAO_NEGADA')) return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
      console.error('[hub-adiantamentos] erro em GET /lotes/:id/arquivo:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
    if (!resultado) return res.status(410).json({ erro: 'ARQUIVO_INDISPONIVEL' });

    const buffer = Buffer.from(resultado.arquivo_base64, 'base64');
    // 13.4 (FR-030): conferir o sha256 antes de enviar, como o contrato já
    // promete (hub-api.md:161) — nunca logar os bytes nem o hash no erro.
    const shaCalculado = crypto.createHash('sha256').update(buffer).digest('hex');
    if (shaCalculado !== resultado.sha256) {
      console.error('[hub-adiantamentos] integridade do arquivo do lote %s divergiu do sha256 esperado', id);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }

    await registrarAuditoria({
      idEmpresa: entidadeAtiva, usuarioId: payload.sub, acao: 'adiantamento.lote_baixado',
      recurso: 'AdiantamentoLote', recursoId: id, detalhes: { numeroDownload: resultado.downloads }, claims,
    });

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${resultado.nome}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.status(200).send(buffer);
  } catch (e) {
    console.error('[hub-adiantamentos] erro inesperado em GET /lotes/:id/arquivo:', e.message);
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
    const naoEnviado = corpo.naoEnviadoATransfeera === true;

    let resultado;
    try {
      const linhas = await hubPostgrestRequest(
        'rpc/hub_adiantamento_lote_cancelar', 'POST',
        { p_lote_id: id, p_motivo: motivo, p_nao_enviado: naoEnviado }, claims
      );
      resultado = Array.isArray(linhas) && linhas[0];
    } catch (e) {
      const msg = mensagemDeErro(e);
      if (msg.includes('NAO_ENCONTRADA')) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
      if (msg.includes('MOTIVO_OBRIGATORIO')) return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'motivo' });
      if (msg.includes('CONFIRMACAO_NAO_ENVIADO_OBRIGATORIA')) return res.status(409).json({ erro: 'CONFIRMACAO_NAO_ENVIADO_OBRIGATORIA' });
      if (msg.includes('TRANSICAO_INVALIDA')) return res.status(409).json({ erro: 'TRANSICAO_INVALIDA' });
      if (msg.includes('PERMISSAO_NEGADA')) return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
      console.error('[hub-adiantamentos] erro em POST /lotes/:id/cancelar:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
    if (!resultado) return res.status(500).json({ erro: 'ERRO_SERVIDOR' });

    await registrarAuditoria({
      idEmpresa: entidadeAtiva, usuarioId: payload.sub, acao: 'adiantamento.lote_cancelado',
      recurso: 'AdiantamentoLote', recursoId: id, detalhes: { motivo }, claims,
    });

    const linhasFinal = await hubPostgrestRequest(`AdiantamentoLote?id=eq.${id}&select=${SELECT_LOTE}`, 'GET', null, claims);
    const loteFinal = Array.isArray(linhasFinal) && linhasFinal[0];
    return res.status(200).json(loteFinal ? mapLote(loteFinal) : { id, status: resultado.status });
  } catch (e) {
    console.error('[hub-adiantamentos] erro inesperado em POST /lotes/:id/cancelar:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.post('/lotes/:id/confirmacao', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.pagamento_confirmar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.pagamento_confirmar');
    if (!ctx) return;
    const { claims, entidadeAtiva, payload } = ctx;
    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = Number(req.params.id);
    const corpo = (req.body && typeof req.body === 'object') ? req.body : {};
    const falhas = Array.isArray(corpo.falhas) ? corpo.falhas : [];
    // 11.17/FR-033: reusa `motivoValido` (já usado pelo cancelar, :ver acima)
    // em vez de só `typeof === 'string'` — sem isso, motivo:'' passava.
    if (!falhas.every((f) => f && Number.isInteger(f.id) && motivoValido(f.motivo))) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'falhas' });
    }

    let resultado;
    try {
      const linhas = await hubPostgrestRequest(
        'rpc/hub_adiantamento_lote_confirmar', 'POST', { p_lote_id: id, p_falhas: falhas }, claims
      );
      resultado = Array.isArray(linhas) && linhas[0];
    } catch (e) {
      const msg = mensagemDeErro(e);
      if (msg.includes('NAO_ENCONTRADA')) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
      // Corpo pediu FALHOU para solicitação que não é item deste lote — a RPC
      // recusa o conjunto inteiro (migration 0083). É defeito do pedido, não
      // de estado: 400 com o mesmo `motivo` da validação de `falhas` acima.
      if (msg.includes('SOLICITACAO_FORA_DO_LOTE')) return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'falhas' });
      if (msg.includes('TRANSICAO_INVALIDA')) return res.status(409).json({ erro: 'TRANSICAO_INVALIDA' });
      if (msg.includes('PERMISSAO_NEGADA')) return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
      console.error('[hub-adiantamentos] erro em POST /lotes/:id/confirmacao:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
    if (!resultado) return res.status(500).json({ erro: 'ERRO_SERVIDOR' });

    await registrarAuditoria({
      idEmpresa: entidadeAtiva, usuarioId: payload.sub, acao: 'adiantamento.lote_confirmado',
      recurso: 'AdiantamentoLote', recursoId: id, detalhes: { falhas: falhas.length, statusFinal: resultado.status }, claims,
    });

    const linhasFinal = await hubPostgrestRequest(`AdiantamentoLote?id=eq.${id}&select=${SELECT_LOTE}`, 'GET', null, claims);
    const loteFinal = Array.isArray(linhasFinal) && linhasFinal[0];
    return res.status(200).json(loteFinal ? mapLote(loteFinal) : { id, status: resultado.status });
  } catch (e) {
    console.error('[hub-adiantamentos] erro inesperado em POST /lotes/:id/confirmacao:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// FASE 9 — Importador de retorno da Transfeera (9.1.3)
// ════════════════════════════════════════════════════════════════════════

/**
 * `POST /lotes/:id/retorno` — aplica o arquivo de retorno da Transfeera
 * sobre UM lote: casa cada linha pelo `ID de integração` (nunca por nome ou
 * valor, 9.1.2) e reusa a MESMA RPC de confirmação manual
 * (`hub_adiantamento_lote_confirmar`, já usada por `/lotes/:id/confirmacao`
 * acima) para aplicar `Finalizada` -> paga e `Devolvida` -> falhou (motivo
 * literal do arquivo, sem tradução — 9.1.4). Corpo: `{csvBase64}` (mesma
 * convenção de transporte binário/texto em JSON já usada por
 * `hub_adiantamento_lote_arquivo` acima, `p_arquivo` base64).
 *
 * Nunca aplica parcialmente: se sobrar item `incluido` do lote sem
 * resolução no arquivo (sem linha, status desconhecido ou valor
 * divergente), a RPC não é chamada — ela marcaria "tudo que não é falha"
 * como pago, o que incluiria esse item por omissão (409
 * `RETORNO_INCOMPLETO`, com os ids faltantes).
 *
 * Idempotência (9.1.5): reimportar o mesmo arquivo depois de aplicado não
 * chama a RPC de novo (todos os itens já saíram de `incluido` ->
 * `casarComItensDoLote` devolve `aplicaveis:[]`) e relata tudo em
 * `ignoradas` com motivo `JA_APLICADO`.
 *
 * [ADAPTADO — gap conhecido] `hub_adiantamento_lote_confirmar` sempre grava
 * `origem_situacao='manual'` (infra/hub/migrations/0067:1753-1758); o
 * schema já reserva `'retorno'` para este caminho (data-model.md
 * AdiantamentoLoteItem.origem_situacao: "retorno só na F9"), mas distinguir
 * as duas origens exige uma nova RPC/migration — fora das 8 subtarefas
 * desta FASE (nenhuma migration está listada em 9.1.1-9.1.8). Registrado
 * como acompanhamento, não bloqueia a aplicação.
 */
// Revisão de segurança 2026-09-18: teto de corpo PRÓPRIO desta rota. O
// `express.json()` global (server.js:220) fica em 100 KB e NÃO deve subir —
// ele está montado antes de toda autenticação, então aumentá-lo daria a
// qualquer um na internet o direito de fazer o processo parsear corpos
// grandes. Aqui os 5 MB só existem para um usuário autenticado e com
// `pagamento_confirmar`. Dimensionado junto com `MAX_LINHAS_RETORNO`
// (10.000 linhas ≈ 2 MB de CSV ≈ 2,7 MB em base64) — sobra folga.
router.post('/lotes/:id/retorno', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.pagamento_confirmar'), express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.pagamento_confirmar');
    if (!ctx) return;
    const { claims, entidadeAtiva, payload } = ctx;
    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = Number(req.params.id);
    const corpo = (req.body && typeof req.body === 'object') ? req.body : {};
    if (typeof corpo.csvBase64 !== 'string' || !corpo.csvBase64) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'csvBase64' });
    }

    let linhasCsv;
    try {
      const texto = Buffer.from(corpo.csvBase64, 'base64').toString('utf-8');
      linhasCsv = lerRetornoTransfeeraCsv(texto);
    } catch (e) {
      if (e instanceof RetornoTransfeeraParseError) return res.status(400).json({ erro: 'ARQUIVO_INVALIDO', motivo: e.motivo });
      console.error('[hub-adiantamentos] erro ao ler CSV em POST /lotes/:id/retorno:', e.message);
      return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'csvBase64' });
    }

    const itensRaw = await hubPostgrestRequest(
      `AdiantamentoLoteItem?lote_id=eq.${id}&id_empresa=in.(${claims.escopo.join(',')})&select=solicitacao_id,col_id_integracao,situacao,valor`,
      'GET', null, claims,
    );
    if (!itensRaw || !itensRaw.length) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });

    const itensLote = itensRaw.map((i) => ({
      solicitacaoId: i.solicitacao_id,
      colIdIntegracao: i.col_id_integracao,
      situacao: i.situacao,
      valorCentavos: paraCentavos(i.valor),
    }));

    let casamento;
    try {
      casamento = casarComItensDoLote(linhasCsv, itensLote);
    } catch (e) {
      // `LINHA_DUPLICADA`: o mesmo ADV-<id> veio duas vezes com conteúdo
      // conflitante — o arquivo inteiro é recusado, nunca se escolhe uma das
      // linhas (uma `Devolvida` duplicando uma `Finalizada` marcaria FALHOU
      // um adiantamento já pago).
      if (e instanceof RetornoTransfeeraParseError) return res.status(400).json({ erro: 'ARQUIVO_INVALIDO', motivo: e.motivo });
      throw e;
    }
    const { aplicaveis, ignoradas, faltantes } = casamento;
    if (faltantes.length > 0) {
      return res.status(409).json({ erro: 'RETORNO_INCOMPLETO', faltantes });
    }

    // Revisão de segurança 2026-09-18: o `motivo` aqui vem do texto livre do
    // arquivo do parceiro — era a única das cinco chamadas de confirmação que
    // não passava por `motivoValido` (as outras: :723, :1143, :1190, :1662).
    // SANEAR, não recusar: diferente das outras quatro, este motivo não é
    // digitado por um usuário que pode corrigi-lo — recusar o arquivo inteiro
    // porque o parceiro mandou um código de 2 letras bloquearia a conciliação
    // de um retorno legítimo. Então cortamos no teto e completamos o piso,
    // garantindo ao banco o mesmo contrato (3..500) das demais.
    const sanearMotivoDoArquivo = (raw) => {
      const texto = (typeof raw === 'string' ? raw : '').trim().slice(0, 500);
      return motivoValido(texto) ? texto : `Devolvida pelo parceiro (motivo não informado: "${texto}")`.slice(0, 500);
    };

    const falhas = aplicaveis
      .filter((a) => a.status === 'Devolvida')
      .map((a) => ({ id: a.solicitacaoId, motivo: sanearMotivoDoArquivo(a.motivo) }));

    if (aplicaveis.length > 0) {
      try {
        await hubPostgrestRequest(
          'rpc/hub_adiantamento_lote_confirmar', 'POST', { p_lote_id: id, p_falhas: falhas }, claims,
        );
      } catch (e) {
        const msg = mensagemDeErro(e);
        if (msg.includes('NAO_ENCONTRADA')) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
        if (msg.includes('TRANSICAO_INVALIDA')) return res.status(409).json({ erro: 'TRANSICAO_INVALIDA' });
        if (msg.includes('PERMISSAO_NEGADA')) return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
        console.error('[hub-adiantamentos] erro em POST /lotes/:id/retorno:', e.message);
        return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
      }

      await registrarAuditoria({
        idEmpresa: entidadeAtiva, usuarioId: payload.sub, acao: 'adiantamento.retorno_importado',
        recurso: 'AdiantamentoLote', recursoId: id,
        detalhes: { aplicadas: aplicaveis.length, falhas: falhas.length, ignoradas: ignoradas.length }, claims,
      });
    }

    return res.status(200).json({ aplicadas: aplicaveis.length, ignoradas });
  } catch (e) {
    console.error('[hub-adiantamentos] erro inesperado em POST /lotes/:id/retorno:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// 4.6 — Repasse
// ════════════════════════════════════════════════════════════════════════

function periodoFimDe(periodoInicio) {
  const d = new Date(`${periodoInicio}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 6);
  return d.toISOString().slice(0, 10);
}

/** `naoPagosNoPeriodo` [ADAPTADO]: `hub_adiantamento_repasse` (listagem) NÃO
 * devolve esta contagem — só `hub_adiantamento_repasse_fechar` (RPC que
 * FECHA o período) a calcula, e não pode ser chamada aqui só para ler. Conta
 * direto via PostgREST (`count:true`, sem trazer linhas) — mesmo critério de
 * "NAO finalizado" documentado em contracts/sql-rpc.md §repasse_fechar. */
async function contarNaoPagosNoPeriodo(periodoInicio, periodoFim, claims) {
  const NAO_FINALIZADOS = ['AGUARDANDO_CORTE', 'AGUARDANDO_PRODUCAO', 'LIBERADA', 'EM_LOTE', 'EXPORTADA', 'FALHOU'];
  const { total } = await hubPostgrestRequest(
    `AdiantamentoSolicitacao?id_empresa=in.(${claims.escopo.join(',')})`
    + `&data_producao=gte.${periodoInicio}&data_producao=lte.${periodoFim}&status=in.(${NAO_FINALIZADOS.join(',')})`
    + '&select=id',
    'GET', null, claims, { count: true, range: { from: 0, to: 0 } }
  );
  return total;
}

/** A4 (US6, briefing adiantamento-repasse-us6): a apuração fechada do período,
 * ou `null` se ainda está aberto. Decide QUAL RPC de repasse chamar — a que lê
 * o valor congelado em `ApuracaoRepasseItem` ou a que recalcula ao vivo.
 *
 * Por que a escolha é aqui e não dentro da RPC: `hub_adiantamento_repasse`
 * (0083) tem ~80 linhas de SQL de dinheiro já auditadas por revisão
 * adversarial, e reescrevê-las só para acrescentar um desvio é como se
 * introduz um erro de dinheiro. Para uma LEITURA o custo de errar é mostrar
 * número errado, não destruir dado — diferente da validação de janela do A1,
 * que ficou num gatilho sobre a tabela justamente por ser escrita irreversível. */
async function buscarApuracaoFechada(periodoInicio, claims) {
  const linhas = await hubPostgrestRequest(
    `ApuracaoRepasse?id_empresa=in.(${claims.escopo.join(',')})&periodo_inicio=eq.${periodoInicio}`
    + '&select=id,data_repasse,fechado_em',
    'GET', null, claims
  );
  return (Array.isArray(linhas) && linhas[0]) || null;
}

router.get('/repasse', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.pagamentos_consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.pagamentos_consultar');
    if (!ctx) return;
    const { claims } = ctx;
    const periodo = typeof req.query.periodo === 'string' && req.query.periodo ? req.query.periodo : null;
    if (!periodo || !/^\d{4}-\d{2}-\d{2}$/.test(periodo)) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'periodo' });
    }
    const { page, pageSize } = parsePaginacao(req.query);
    const busca = typeof req.query.busca === 'string' && req.query.busca ? req.query.busca : null;
    const somenteNegativos = req.query.somenteNegativos === 'true';
    const fim = periodoFimDe(periodo);

    // A ordem importa: saber se o período fechou é o que decide qual RPC
    // chamar. Período fechado devolve o CONGELADO (o que foi apurado);
    // período aberto recalcula ao vivo, como sempre.
    const apuracao = await buscarApuracaoFechada(periodo, claims);

    let linhas;
    try {
      linhas = await hubPostgrestRequest(
        apuracao ? 'rpc/hub_adiantamento_repasse_congelado' : 'rpc/hub_adiantamento_repasse', 'POST',
        {
          p_periodo_inicio: periodo, p_busca: busca, p_somente_negativos: somenteNegativos,
          p_offset: (page - 1) * pageSize, p_limite: pageSize,
        }, claims
      );
    } catch (e) {
      const msg = mensagemDeErro(e);
      if (msg.includes('APURACAO_NAO_CONFIGURADA')) return res.status(409).json({ erro: 'APURACAO_NAO_CONFIGURADA' });
      console.error('[hub-adiantamentos] erro em GET /repasse:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
    const rows = linhas || [];
    const total = rows.length ? Number(rows[0].total) : 0;

    const naoPagosNoPeriodo = await contarNaoPagosNoPeriodo(periodo, fim, claims);

    // Os totais vêm do PERÍODO INTEIRO, calculados pela própria RPC em
    // janela `sum(...) OVER ()` (migration 0083) — antes eram somados aqui
    // sobre `rows`, que é a PÁGINA (20 linhas por padrão), e apareciam na
    // tela ao lado de `motoristas: total`, que sempre foi a contagem do
    // período: "Total (137 motorista(s)) · R$ <soma de 20>" na tela onde se
    // decide fechar a apuração. `paraCentavos` (2.7.1/dec-063) continua
    // sendo a única conversão para centavos — o numeric do Postgres já é
    // exato, aqui é só para reusar `formatarCentavos` sem dividir float.
    const totalDoPeriodo = (campo) => formatarCentavos(rows.length ? paraCentavos(rows[0][campo] ?? 0) : 0);

    return res.status(200).json({
      periodo: {
        inicio: periodo,
        fim,
        dataRepasse: apuracao ? apuracao.data_repasse : null,
        situacao: apuracao ? 'fechado' : 'aberto',
        // A4: a tela rotula "fechado em X" e, com isso, o usuário sabe que o
        // número exibido é o congelado daquele instante — não o de agora.
        fechadoEm: apuracao ? apuracao.fechado_em : null,
      },
      totais: {
        creditos: totalDoPeriodo('total_creditos'),
        adiantamentos: totalDoPeriodo('total_adiantamentos'),
        debitos: totalDoPeriodo('total_debitos'),
        remanescente: totalDoPeriodo('total_remanescente'),
        motoristas: total,
      },
      itens: rows.map((r) => ({
        entregadorId: r.entregador_id,
        nome: r.nome,
        creditos: dinheiro(r.creditos),
        adiantamentos: dinheiro(r.adiantamentos),
        debitos: dinheiro(r.debitos),
        remanescente: dinheiro(r.remanescente),
        negativo: Number(r.remanescente) < 0,
        emProcessamento: r.em_processamento === true,
      })),
      naoPagosNoPeriodo,
      total,
      page,
      pageSize,
    });
  } catch (e) {
    console.error('[hub-adiantamentos] erro inesperado em GET /repasse:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.get('/repasse/exportar', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.pagamentos_consultar'), exportarRepasseRateLimiter, async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.pagamentos_consultar');
    if (!ctx) return;
    const { claims } = ctx;
    const periodo = typeof req.query.periodo === 'string' && req.query.periodo ? req.query.periodo : null;
    if (!periodo || !/^\d{4}-\d{2}-\d{2}$/.test(periodo)) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'periodo' });
    }
    const fim = periodoFimDe(periodo);

    // Mesma regra do `GET /repasse`: período fechado exporta o CONGELADO. Sem
    // isso, a planilha exportada depois do fechamento poderia divergir dos
    // números que a própria tela mostrou no momento de fechar.
    const apuracao = await buscarApuracaoFechada(periodo, claims);

    let linhas;
    try {
      linhas = await hubPostgrestRequest(
        apuracao ? 'rpc/hub_adiantamento_repasse_congelado' : 'rpc/hub_adiantamento_repasse', 'POST',
        {
          p_periodo_inicio: periodo, p_busca: null, p_somente_negativos: false, p_offset: 0, p_limite: 100000,
        }, claims
      );
    } catch (e) {
      const msg = mensagemDeErro(e);
      if (msg.includes('APURACAO_NAO_CONFIGURADA')) return res.status(409).json({ erro: 'APURACAO_NAO_CONFIGURADA' });
      console.error('[hub-adiantamentos] erro em GET /repasse/exportar:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
    const rows = linhas || [];
    // `serializarCsvRemanescente` já escapa (`escaparCelulaCsvInjection`) e
    // converte reais->centavos (`paraCentavos`) internamente — passar valor
    // já mascarado ou pré-multiplicado por 100 duplicaria a conversão.
    const csv = serializarCsvRemanescente(rows.map((r) => ({
      entregadorId: r.entregador_id,
      nome: r.nome,
      creditos: r.creditos,
      adiantamentos: r.adiantamentos,
      debitos: r.debitos,
      remanescente: r.remanescente,
    })));

    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="repasse-${periodo}_${fim}.csv"`,
    });
    return res.status(200).send(csv);
  } catch (e) {
    console.error('[hub-adiantamentos] erro inesperado em GET /repasse/exportar:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

router.post('/repasse/:periodo/fechar', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.pagamento_confirmar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.pagamento_confirmar');
    if (!ctx) return;
    const { claims, entidadeAtiva, payload } = ctx;
    const periodo = req.params.periodo;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodo)) return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'periodo' });
    if (!(req.body && req.body.confirmacao === true)) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'confirmacao' });
    }

    let resultado;
    try {
      const linhas = await hubPostgrestRequest('rpc/hub_adiantamento_repasse_fechar', 'POST', { p_periodo_inicio: periodo }, claims);
      resultado = Array.isArray(linhas) && linhas[0];
    } catch (e) {
      const msg = mensagemDeErro(e);
      if (msg.includes('APURACAO_COM_PENDENCIAS')) {
        let detalhe = {};
        try { detalhe = JSON.parse(detailDoErro(e) || '{}'); } catch { detalhe = {}; }
        return res.status(409).json({ erro: 'APURACAO_COM_PENDENCIAS', detalhe });
      }
      if (msg.includes('APURACAO_JA_FECHADA')) return res.status(409).json({ erro: 'APURACAO_JA_FECHADA' });
      if (msg.includes('APURACAO_NAO_CONFIGURADA')) return res.status(409).json({ erro: 'APURACAO_NAO_CONFIGURADA' });
      if (msg.includes('PERIODO_EM_ABERTO')) return res.status(409).json({ erro: 'PERIODO_EM_ABERTO' });
      // A1: o gatilho da 0086 recusa fechar uma janela que não começa no
      // `apuracao_dia_inicio` configurado. `ApuracaoRepasse` é imutável, então
      // a recusa é deliberadamente explícita em vez de realinhar em silêncio —
      // o operador precisa saber que pediu outra semana.
      if (msg.includes('PERIODO_DESALINHADO')) {
        return res.status(409).json({ erro: 'PERIODO_DESALINHADO', detalhe: detailDoErro(e) || null });
      }
      if (msg.includes('PERMISSAO_NEGADA')) return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
      console.error('[hub-adiantamentos] erro em POST /repasse/:periodo/fechar:', e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
    if (!resultado) return res.status(500).json({ erro: 'ERRO_SERVIDOR' });

    await registrarAuditoria({
      idEmpresa: entidadeAtiva, usuarioId: payload.sub, acao: 'adiantamento.repasse_fechado',
      recurso: 'ApuracaoRepasse', recursoId: resultado.apuracao_id,
      detalhes: { periodo, motoristas: resultado.motoristas, total: resultado.total }, claims,
    });

    return res.status(201).json({
      apuracaoId: resultado.apuracao_id,
      motoristas: resultado.motoristas,
      total: dinheiro(resultado.total),
      naoPagosNoPeriodo: resultado.nao_pagos_no_periodo,
    });
  } catch (e) {
    console.error('[hub-adiantamentos] erro inesperado em POST /repasse/:periodo/fechar:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

// ════════════════════════════════════════════════════════════════════════
// GET /:id e as 6 transicoes de 4.1 — DECLARADAS POR ULTIMO (mesmo motivo de
// routes/hub-avisos.js: 'GET /:id' com 1 segmento colidiria com as rotas
// literais de 1 segmento das secoes seguintes — /configuracoes, /contas,
// /lotes, /repasse — se viesse antes delas; Express casa a PRIMEIRA rota
// registrada que bater o shape, entao /:id 'roubaria' essas 4 rotas GET).
// ════════════════════════════════════════════════════════════════════════

// tasks.md 11.26/contrato-SolicitacaoDetalhe: montagem completa do detalhe
// (resumo + calculo + contaMascarada + eventos[] + lotes[]), compartilhada
// entre `GET /:id` e as 6 transições da fábrica abaixo — todas devolviam só
// o resumo (mapSolicitacaoResumo) via ESTE MESMO ponto de releitura,
// contradizendo o `SolicitacaoDetalhe` que `contracts/hub-api.md` declara
// para a resposta. Retorna `null` quando a solicitação não existe/está fora
// do escopo (mesma checagem `id_empresa=in.(escopo)` de antes).
async function montarSolicitacaoDetalhe(id, claims) {
  const linhas = await hubPostgrestRequest(
    `AdiantamentoSolicitacao?id=eq.${id}&id_empresa=in.(${claims.escopo.join(',')})&select=*,entregador:Entregador(nome)`,
    'GET', null, claims
  );
  const row = Array.isArray(linhas) && linhas[0];
  if (!row) return null;

  const [configLinhas, eventosLinhas, lotesLinhas] = await Promise.all([
    hubPostgrestRequest(`AdiantamentoConfiguracao?id=eq.${row.configuracao_id}&select=versao`, 'GET', null, claims),
    hubPostgrestRequest(
      `AdiantamentoEvento?solicitacao_id=eq.${id}&select=status_de,status_para,ocorrido_em,ator_tipo,ator_usuario_id,motivo&order=ocorrido_em.asc`,
      'GET', null, claims
    ),
    hubPostgrestRequest(
      `AdiantamentoLoteItem?solicitacao_id=eq.${id}&select=situacao,lote:AdiantamentoLote(*)&order=id.asc`,
      'GET', null, claims
    ),
  ]);

  let contaMascarada = null;
  if (row.conta_bancaria_id) {
    const contaResultado = await hubPostgrestRequest(
      'rpc/hub_conta_bancaria_detalhe', 'POST',
      { p_id: row.conta_bancaria_id, p_completo: false }, claims
    );
    const jsonb = Array.isArray(contaResultado) ? contaResultado[0] : contaResultado;
    contaMascarada = mapContaMascaradaHub(jsonb);
  }

  const versaoConfiguracao = (Array.isArray(configLinhas) && configLinhas[0] && configLinhas[0].versao) ?? null;
  const loteAtivo = (lotesLinhas || []).find((li) => li.situacao === 'incluido' || li.situacao === 'pago');

  const resumo = mapSolicitacaoResumo({
    ...row,
    pendencias: pendenciasDaSolicitacao(row),
    lote_id: loteAtivo ? loteAtivo.lote.id : null,
  });

  return {
    ...resumo,
    calculo: {
      fonte: row.fonte_producao,
      categorias: row.categorias_producao,
      producao: dinheiro(row.producao_valor),
      porCategoria: row.producao_por_categoria,
      percentual: row.percentual === null || row.percentual === undefined ? null : Number(row.percentual),
      bruto: dinheiro(row.valor_bruto),
      taxa: dinheiro(row.taxa),
      liquido: dinheiro(row.valor_liquido),
      calculadoEm: row.calculado_em,
      versaoConfiguracao,
    },
    contaMascarada,
    eventos: (eventosLinhas || []).map(mapEvento),
    lotes: (lotesLinhas || []).map((li) => mapLote(li.lote)),
  };
}

router.get('/:id', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.consultar'), async (req, res) => {
  try {
    const ctx = await resolverContextoAdiantamentos(req, res, 'adiantamentos.consultar');
    if (!ctx) return;
    const { claims } = ctx;
    if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    const id = Number(req.params.id);

    const detalhe = await montarSolicitacaoDetalhe(id, claims);
    if (!detalhe) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });

    return res.status(200).json(detalhe);
  } catch (e) {
    console.error('[hub-adiantamentos] erro em GET /:id:', e.message);
    return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
  }
});

/** Fábrica das 6 transições simples de 4.1 (rejeitar/recalcular/encerrar/
 * atualizar-conta/reprocessar/encerrar-falha) — mesma forma de chamada
 * (RPC(p_id[, p_motivo]) -> reler detalhe simplificado), erro comum
 * traduzido de forma idêntica; evita repetir 6 handlers quase idênticos. */
function criarHandlerTransicao({
  permissao, rpc, exigeMotivo, acaoAuditoria, recursoAuditoria = 'AdiantamentoSolicitacao',
}) {
  return async (req, res) => {
    try {
      const ctx = await resolverContextoAdiantamentos(req, res, `adiantamentos.${permissao}`);
      if (!ctx) return;
      const { claims, entidadeAtiva, payload } = ctx;
      if (!idValido(req.params.id)) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
      const id = Number(req.params.id);

      const motivo = req.body && typeof req.body.motivo === 'string' ? req.body.motivo.trim() : undefined;
      if (exigeMotivo && !motivoValido(motivo)) {
        return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'motivo' });
      }

      const params = { p_id: id };
      if (exigeMotivo) params.p_motivo = motivo;

      let resultado;
      try {
        const linhas = await hubPostgrestRequest(`rpc/${rpc}`, 'POST', params, claims);
        resultado = Array.isArray(linhas) && linhas[0];
      } catch (e) {
        const msg = mensagemDeErro(e);
        if (msg.includes('NAO_ENCONTRADA')) return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
        if (msg.includes('MOTIVO_OBRIGATORIO')) return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'motivo' });
        if (msg.includes('TRANSICAO_INVALIDA')) return res.status(409).json({ erro: 'TRANSICAO_INVALIDA' });
        if (msg.includes('PRODUCAO_INDISPONIVEL')) return res.status(409).json({ erro: 'PRODUCAO_INDISPONIVEL' });
        if (msg.includes('NO_BANK_ACCOUNT')) return res.status(409).json({ erro: 'NO_BANK_ACCOUNT' });
        if (msg.includes('PERMISSAO_NEGADA')) return res.status(403).json({ erro: 'PERMISSAO_NEGADA' });
        console.error(`[hub-adiantamentos] erro em ${rpc}:`, e.message);
        return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
      }
      if (!resultado) {
        console.error(`[hub-adiantamentos] ${rpc} não devolveu linha`);
        return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
      }

      await registrarAuditoria({
        idEmpresa: entidadeAtiva,
        usuarioId: payload.sub,
        acao: acaoAuditoria,
        recurso: recursoAuditoria,
        recursoId: id,
        detalhes: { motivo, statusPara: resultado.status },
        claims,
      });

      // tasks.md 11.26/contrato-SolicitacaoDetalhe: reler o detalhe completo
      // (mesma montagem de GET /:id), não só o resumo — o contrato declara
      // `SolicitacaoDetalhe` como resposta destas transições.
      const detalhe = await montarSolicitacaoDetalhe(id, claims);
      if (!detalhe) return res.status(500).json({ erro: 'ERRO_SERVIDOR' });

      return res.status(200).json(detalhe);
    } catch (e) {
      console.error(`[hub-adiantamentos] erro inesperado em ${rpc}:`, e.message);
      return res.status(500).json({ erro: 'ERRO_SERVIDOR' });
    }
  };
}

router.post(
  '/:id/rejeitar', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.gerenciar'),
  criarHandlerTransicao({ permissao: 'gerenciar', rpc: 'hub_adiantamento_rejeitar', exigeMotivo: true, acaoAuditoria: 'adiantamento.rejeitado' })
);
router.post(
  '/:id/recalcular', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.gerenciar'),
  criarHandlerTransicao({ permissao: 'gerenciar', rpc: 'hub_adiantamento_recalcular', exigeMotivo: false, acaoAuditoria: 'adiantamento.recalculado' })
);
router.post(
  '/:id/encerrar', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.gerenciar'),
  criarHandlerTransicao({ permissao: 'gerenciar', rpc: 'hub_adiantamento_encerrar', exigeMotivo: true, acaoAuditoria: 'adiantamento.encerrado' })
);
router.post(
  '/:id/atualizar-conta', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.gerenciar'),
  criarHandlerTransicao({ permissao: 'gerenciar', rpc: 'hub_adiantamento_atualizar_conta', exigeMotivo: true, acaoAuditoria: 'adiantamento.conta_atualizada' })
);
router.post(
  '/:id/reprocessar', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.reprocessar'),
  criarHandlerTransicao({ permissao: 'reprocessar', rpc: 'hub_adiantamento_reprocessar', exigeMotivo: true, acaoAuditoria: 'adiantamento.reprocessado' })
);
router.post(
  '/:id/encerrar-falha', requireModuloAtivo('adiantamentos'), requirePermission('adiantamentos.reprocessar'),
  criarHandlerTransicao({ permissao: 'reprocessar', rpc: 'hub_adiantamento_encerrar_falha', exigeMotivo: true, acaoAuditoria: 'adiantamento.encerrado_sem_pagamento' })
);

module.exports = {
  router,
  resolverContextoAdiantamentos,
  resolverFiltroStatus,
  mapContaMascaradaHub,
  rotuloStatusAdiantamento,
};

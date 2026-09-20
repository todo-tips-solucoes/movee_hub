/**
 * adiantamento-motorista — routes/motorista-adiantamento.js (tasks.md FASE 3, 3.1)
 *
 * Rotas de disponibilidade/regras/solicitação/histórico/cancelamento do
 * adiantamento no app motorista. Montado dentro do router `/motorista` COM
 * `authenticateMotorista` (mesmo padrão de `motoristaPushRoutes`,
 * `server.js`) — `req.motorista.cnpjPrestador` já está setado quando estas
 * rotas rodam.
 *
 * Identidade (FR-003, Constitution II): nenhum id de conta, entregador ou
 * empresa é aceito do corpo ou da query em nenhum handler abaixo — a
 * identidade usada nas RPCs vem exclusivamente de
 * `req.motorista.cnpjPrestador` (claim `motorista_cnpj`, `lib/hub-postgrest-jwt.js`).
 * As próprias funções SQL (`infra/hub/migrations/0067_adiantamento_funcoes.sql`)
 * resolvem entregador/empresa a partir dessa claim — nunca de parâmetro.
 *
 * Erros de negócio: as RPCs levantam `RAISE EXCEPTION '<CODIGO>'`; o Node
 * traduz para `{erro:'<CODIGO>'}` (mesmo padrão de `routes/hub-avisos.js`,
 * `isCorridaChaveIdempotencia`/checagem por `e.body`/`e.message`). Erro de
 * infra (timeout, PostgREST fora do ar) cai sempre em 502 `INDISPONIVEL`
 * (3.1.7) — nunca confundido com erro de negócio.
 *
 * Ref: contracts/motorista-api.md §Parte 2 (disponibilidade..cancelar);
 * contracts/sql-rpc.md §App do motorista; Spec §FR-001..§FR-014.
 */

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const { hubPostgrestRequest } = require('../lib/hub-postgrest');
const { registrarAuditoria } = require('../lib/hub-auditoria');
const { mesmoGrupoQue } = require('./grupo');
const { textoRegras, nextAvailableAt } = require('../lib/adiantamento-regras');
const {
  dinheiro, formatarSequencial, rotuloStatusAdiantamento, formatarBancoCodigoNome, pontuarDocumentoMascarado,
} = require('../lib/adiantamento-dto');
const { validarContaBancaria } = require('../lib/adiantamento-conta');
const bancosFixture = require('../lib/fixtures/bancos-compe.json');

const router = express.Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Único valor permitido pelo CHECK `adiantamentoconfiguracao_timezone_chk`
// (infra/hub/migrations/0066_adiantamento_tabelas.sql:76) — não é fabricado,
// é a única constante que a coluna pode assumir hoje.
const TIMEZONE_PADRAO = 'America/Sao_Paulo';

/**
 * FR-050/PLANO §20: 10 requisições/15min por `cnpjPrestador`, compartilhado
 * entre solicitar e cancelar (§Regras comuns de contracts/motorista-api.md:
 * "solicitar e cancelar 10/15 min"). Mesmo padrão de `routes/motorista-push.js`.
 */
const solicitarCancelarLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.motorista && req.motorista.cnpjPrestador) || req.ip,
  handler: (_req, res) => {
    res.status(429).json({ erro: 'LIMITE_EXCEDIDO' });
  },
});

/** 3.2.4/PLANO §20: 5 requisições/15min por `cnpjPrestador` — só a ESCRITA
 * (`POST /conta-bancaria/solicitacoes`); leituras (`GET /conta-bancaria`,
 * `GET /bancos`) não têm limiter próprio (§Regras comuns de
 * contracts/motorista-api.md: "Leituras seguem sem limiter próprio"). */
const contaBancariaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.motorista && req.motorista.cnpjPrestador) || req.ip,
  handler: (_req, res) => {
    res.status(429).json({ erro: 'LIMITE_EXCEDIDO' });
  },
});

function logErro(rota, e) {
  console.error(`[motorista-adiantamento] erro em ${rota}:`, e && e.message);
}

/** Mensagem de erro (corpo HTTP do PostgREST ou `Error#message`) — mesma
 * técnica de `routes/hub-avisos.js` (`isCorridaChaveIdempotencia`) para casar
 * o `RAISE EXCEPTION '<CODIGO>'` das RPCs. */
function mensagemDeErro(e) {
  return String((e && e.body) || (e && e.message) || '');
}

const claimsMotorista = (req) => ({ motoristaCnpj: req.motorista.cnpjPrestador });

// --- 3.1.1 GET /adiantamento/disponibilidade --------------------------------

/**
 * Ordem de avaliação do contrato: módulo → grupo → vínculo → configuração →
 * conta bancária → dia → horário → solicitação do dia. Duas adaptações à
 * ordem literal, forçadas pelo que a RPC consegue calcular (nunca fabricado):
 *  - vínculo é checado ANTES de módulo: sem `Entregador` resolvido a RPC não
 *    sabe a `id_empresa` do motorista, logo não pode avaliar módulo/empresa
 *    nenhuma — `hub_adiantamento_disponibilidade` (0067:478-499) retorna
 *    `modulo_ativo=false` como valor de preenchimento nesse branch, não como
 *    sinal real.
 *  - "grupo" (`OUTSIDE_GROUP`) não existe como checagem própria na RPC: o
 *    módulo `adiantamentos` só é ativado (`ModuloEntidade`) para empresas do
 *    grupo Movee (data-model.md: "escopo do grupo Movee"), então uma empresa
 *    fora do grupo já cai em `MODULE_DISABLED` — não há sinal SQL distinto
 *    para reproduzir `OUTSIDE_GROUP` sem inventar uma checagem nova aqui.
 */
function derivarReason(row, foraDoGrupo) {
  if (!row.vinculado) return 'NOT_LINKED';
  if (!row.modulo_ativo) return 'MODULE_DISABLED';
  // 11.1 (converge onda-039, FR-001): defesa em profundidade — a
  // elegibilidade de grupo hoje depende inteiramente de `ModuloEntidade` só
  // estar ativado (`m.codigo = 'adiantamentos'`) para empresas do grupo
  // Movee; se alguém ativar por engano para outra empresa, `modulo_ativo`
  // sozinho não pega. Só é alcançável quando o módulo JÁ está ativo (senão
  // MODULE_DISABLED, acima, já é o motivo certo).
  if (foraDoGrupo) return 'OUTSIDE_GROUP';
  if (row.motivo_indisponivel === 'NOT_CONFIGURED' || !row.configuracao_completa) return 'NOT_CONFIGURED';
  if (!row.conta_aprovada) return row.conta_pendente ? 'BANK_ACCOUNT_PENDING' : 'NO_BANK_ACCOUNT';
  if (!row.dia_habilitado) return 'DAY_NOT_ALLOWED';
  if (row.antes_abertura) return 'BEFORE_OPENING';
  if (row.apos_corte) return 'AFTER_CUTOFF';
  if (row.solicitacao_do_dia) return 'ALREADY_REQUESTED';
  return null;
}

/** `bankAccount` do contrato (`{status, bank, masked}`) a partir do jsonb já
 * mascarado por `hub_conta_bancaria_mascarar` (0067:736-756) — NÃO remascara
 * (os dados brutos nunca chegam a este processo: `"ContaBancariaMotorista"`
 * tem RLS sem política/GRANT SELECT, só as funções SECURITY DEFINER tocam a
 * tabela). `conta`/`titularDocumento` desse jsonb já saem mascarados no
 * formato SQL (`hub_adiantamento_mascarar`, `*` + 2 visíveis) — diferente do
 * formato `••••NNNN-D` de `lib/adiantamento-conta.js#contaMascarada` (que
 * exige dígitos crus, indisponíveis aqui). */
function mapBankAccountResumo(contaJsonb) {
  if (!contaJsonb) return null;
  return {
    status: contaJsonb.status,
    bank: `${contaJsonb.bancoCodigo} – ${contaJsonb.bancoNome}`,
    masked: `Ag. ${contaJsonb.agencia} · ${contaJsonb.tipoConta} ${contaJsonb.conta}-${contaJsonb.contaDigito}`,
  };
}

router.get('/adiantamento/disponibilidade', async (req, res) => {
  let linhas;
  try {
    linhas = await hubPostgrestRequest('rpc/hub_adiantamento_disponibilidade', 'POST', {}, claimsMotorista(req));
  } catch (e) {
    logErro('GET /adiantamento/disponibilidade', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }

  const row = Array.isArray(linhas) && linhas[0];
  if (!row) {
    logErro('GET /adiantamento/disponibilidade', new Error('RPC não devolveu linha'));
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }

  const foraDoGrupo = row.modulo_ativo && !(await mesmoGrupoQue(row.id_empresa, 6, {}));
  const reason = derivarReason(row, foraDoGrupo);
  const configParaRegras = {
    timezone: TIMEZONE_PADRAO,
    dias_habilitados: row.dias_habilitados || [],
    horario_abertura: row.horario_abertura,
  };

  res.json({
    canRequest: reason === null,
    reason,
    requestDate: row.data_solicitacao,
    productionDate: row.data_producao,
    timezone: TIMEZONE_PADRAO,
    openingTime: typeof row.horario_abertura === 'string' ? row.horario_abertura.slice(0, 5) : row.horario_abertura,
    cutoffTime: typeof row.horario_corte === 'string' ? row.horario_corte.slice(0, 5) : row.horario_corte,
    enabledDays: row.dias_habilitados || [],
    percentage: row.percentual === null || row.percentual === undefined ? null : Number(row.percentual),
    fee: dinheiro(row.taxa_fixa),
    paymentForecast: row.previsao_pagamento_texto,
    // reason !== null (não pode solicitar agora) é quando a próxima
    // oportunidade importa; com reason nulo o app já mostra "pode solicitar".
    nextAvailableAt: reason !== null && row.horario_abertura && (row.dias_habilitados || []).length
      ? nextAvailableAt(configParaRegras, new Date())
      : null,
    // 3.7.1 (revisão da sessão pai, dec-071): `hub_adiantamento_disponibilidade`
    // agora devolve `estimate` (reusa `hub_adiantamento_producao`/
    // `hub_adiantamento_bruto_liquido` internamente, sem GRANT novo).
    // 3.8.1 (dec-076): `eligible:false` (produção 0 ou líquido <= 0, mesma
    // regra de `hub_adiantamento_calcular_liberacao`) já vem com `net: null`
    // do SQL — o app mostra "não liberado" em vez de um valor negativo.
    estimate: row.estimate
      ? {
        available: row.estimate.available,
        production: dinheiro(row.estimate.production),
        gross: dinheiro(row.estimate.gross),
        fee: dinheiro(row.estimate.fee),
        net: dinheiro(row.estimate.net),
        eligible: row.estimate.eligible,
        final: false,
      }
      : null,
    bankAccount: mapBankAccountResumo(row.conta_aprovada || row.conta_pendente),
    todayRequest: row.solicitacao_do_dia
      ? {
        id: row.solicitacao_do_dia.id,
        status: row.solicitacao_do_dia.status,
        integrationId: formatarSequencial(row.solicitacao_do_dia.id, 'ADV-'),
      }
      : null,
    // 3.7.3 (revisão da sessão pai, dec-071): configVersion = versão de
    // EXIBIÇÃO (protótipo mostra "versão 3"); configuracaoId = PK, o
    // identificador ecoado em POST /adiantamentos (vira p_configuracao_id).
    configVersion: row.configuracao_versao,
    configuracaoId: row.configuracao_id,
  });
});

// --- 3.1.2 GET /adiantamento/regras -----------------------------------------

router.get('/adiantamento/regras', async (req, res) => {
  let linhas;
  try {
    linhas = await hubPostgrestRequest('rpc/hub_adiantamento_disponibilidade', 'POST', {}, claimsMotorista(req));
  } catch (e) {
    logErro('GET /adiantamento/regras', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }

  const row = Array.isArray(linhas) && linhas[0];
  if (!row) {
    logErro('GET /adiantamento/regras', new Error('RPC não devolveu linha'));
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }

  // Sem vínculo/configuração vigente não há regras para montar — o contrato
  // não documenta um erro específico para esta rota (proposta ainda a
  // validar); reusa o mesmo shape de "solicitação indisponível" já
  // documentado para POST /adiantamentos, em vez de inventar um código novo.
  const foraDoGrupo = row.modulo_ativo && !(await mesmoGrupoQue(row.id_empresa, 6, {}));
  const reason = derivarReason(row, foraDoGrupo);
  if (!row.vinculado || !row.configuracao_id) {
    return res.status(409).json({ erro: 'SOLICITACAO_INDISPONIVEL', motivo: reason });
  }

  const regras = textoRegras({
    id: row.configuracao_id,
    versao: row.configuracao_versao,
    timezone: TIMEZONE_PADRAO,
    dias_habilitados: row.dias_habilitados || [],
    horario_abertura: row.horario_abertura,
    horario_corte: row.horario_corte,
    percentual: row.percentual,
    taxa_fixa: row.taxa_fixa,
    previsao_pagamento_texto: row.previsao_pagamento_texto,
  });

  res.json(regras);
});

// --- Detalhe compartilhado (POST criar/cancelar + GET :id) ------------------

/** `SolicitacaoDetalhe` do app (contracts/motorista-api.md `GET /adiantamentos/:id`)
 * a partir de `hub_adiantamento_detalhe_motorista` — usado depois de criar,
 * depois de cancelar e no GET direto (mesmo shape nos três, R-06/contrato). */
function mapDetalheMotorista(sol, eventos) {
  return {
    id: sol.id,
    integrationId: formatarSequencial(sol.id, 'ADV-'),
    status: sol.status,
    motivoStatus: sol.motivo_status,
    dataSolicitacao: sol.data_solicitacao,
    dataProducao: sol.data_producao,
    solicitadaEm: sol.solicitada_em,
    // 3.7.3 (revisão da sessão pai, dec-071): configVersion = versão de
    // EXIBIÇÃO (`configuracao_versao`, gravada com a solicitação — nunca a
    // vigente atual).
    configVersion: sol.configuracao_versao,
    calculo: sol.calculado_em
      ? {
        producao: dinheiro(sol.producao_valor),
        percentual: sol.percentual === null || sol.percentual === undefined ? null : Number(sol.percentual),
        bruto: dinheiro(sol.valor_bruto),
        taxa: dinheiro(sol.taxa),
        liquido: dinheiro(sol.valor_liquido),
        fonte: sol.fonte_producao,
        calculadoEm: sol.calculado_em,
      }
      : null,
    // 3.7.2 (revisão da sessão pai, dec-071): retrato gravado com a
    // solicitação — `hub_adiantamento_detalhe_motorista` devolve a conta
    // snapshot (`conta_bancaria_id`, só existe a partir do cálculo — LIBERADA
    // em diante; `null` antes disso, nunca a conta atualmente aprovada) e o
    // texto de previsão da CONFIG usada na solicitação (`configuracao_id`,
    // imutável — nunca a vigente atual).
    contaMascarada: sol.conta_bancaria_mascarada ? mapBankAccountResumo(sol.conta_bancaria_mascarada) : null,
    previsaoPagamento: sol.previsao_pagamento_texto,
    timeline: (eventos || []).map((ev) => ({
      etapa: rotuloStatusAdiantamento(ev.statusPara),
      status: ev.statusPara,
      ocorridoEm: ev.ocorridoEm,
      motivo: ev.motivo,
    })),
  };
}

async function buscarDetalhe(id, claims) {
  const linhas = await hubPostgrestRequest('rpc/hub_adiantamento_detalhe_motorista', 'POST', { p_id: id }, claims);
  const row = Array.isArray(linhas) && linhas[0];
  if (!row || !row.solicitacao) return null;
  return mapDetalheMotorista(row.solicitacao, row.eventos);
}

// --- 3.1.3 POST /adiantamentos ----------------------------------------------

router.post('/adiantamentos', solicitarCancelarLimiter, async (req, res) => {
  const corpo = (req.body && typeof req.body === 'object') ? req.body : {};

  if (corpo.aceite !== true) {
    return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'aceite' });
  }
  if (typeof corpo.chaveIdempotencia !== 'string' || !UUID_REGEX.test(corpo.chaveIdempotencia)) {
    return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'chaveIdempotencia' });
  }
  // 3.7.3 (revisão da sessão pai, dec-071): o corpo envia o IDENTIFICADOR
  // (`configuracaoId`, PK) — `configVersion` (versão de exibição) não serve
  // pra amarrar a solicitação porque não é única por empresa ao longo do
  // tempo da mesma forma que o PK é (nem é o que `p_configuracao_id` espera).
  if (!Number.isInteger(corpo.configuracaoId) || corpo.configuracaoId <= 0) {
    return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'configuracaoId' });
  }

  const claims = claimsMotorista(req);

  // O hash de aceite NUNCA vem do cliente (só `aceite:true`) — o servidor
  // recalcula a partir da config vigente (mesma função pura usada em
  // GET /adiantamento/regras), para nunca confiar em prova de aceite
  // fabricável pelo cliente (R-05).
  let disponibilidadeLinhas;
  try {
    disponibilidadeLinhas = await hubPostgrestRequest('rpc/hub_adiantamento_disponibilidade', 'POST', {}, claims);
  } catch (e) {
    logErro('POST /adiantamentos (disponibilidade)', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }
  const dispRow = Array.isArray(disponibilidadeLinhas) && disponibilidadeLinhas[0];
  if (!dispRow) {
    logErro('POST /adiantamentos (disponibilidade)', new Error('RPC não devolveu linha'));
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }

  // 11.1 (converge onda-039, FR-001): mesma defesa em profundidade do GET
  // /adiantamento/disponibilidade — checa ANTES de chamar
  // hub_adiantamento_solicitar (que só valida MODULO_DESABILITADO, não
  // grupo). `dispRow` já foi buscado acima, sem round-trip extra.
  if (dispRow.modulo_ativo && !(await mesmoGrupoQue(dispRow.id_empresa, 6, {}))) {
    return res.status(409).json({ erro: 'SOLICITACAO_INDISPONIVEL', motivo: 'OUTSIDE_GROUP' });
  }

  if (dispRow.configuracao_id !== corpo.configuracaoId) {
    // Mesmo sem chamar a RPC: já sabemos que não é a vigente (evita gastar o
    // limiter/uma tentativa com uma config que a própria RPC recusaria).
    return res.status(409).json({ erro: 'VERSAO_DESATUALIZADA' });
  }

  const regras = textoRegras({
    id: dispRow.configuracao_id,
    versao: dispRow.configuracao_versao,
    timezone: TIMEZONE_PADRAO,
    dias_habilitados: dispRow.dias_habilitados || [],
    horario_abertura: dispRow.horario_abertura,
    horario_corte: dispRow.horario_corte,
    percentual: dispRow.percentual,
    taxa_fixa: dispRow.taxa_fixa,
    previsao_pagamento_texto: dispRow.previsao_pagamento_texto,
  });

  let resultado;
  try {
    const linhas = await hubPostgrestRequest(
      'rpc/hub_adiantamento_solicitar',
      'POST',
      { p_configuracao_id: corpo.configuracaoId, p_aceite_sha256: regras.aceiteSha256, p_chave: corpo.chaveIdempotencia },
      claims,
    );
    resultado = Array.isArray(linhas) && linhas[0];
  } catch (e) {
    const msg = mensagemDeErro(e);
    const configParaRegras = {
      timezone: TIMEZONE_PADRAO,
      dias_habilitados: dispRow.dias_habilitados || [],
      horario_abertura: dispRow.horario_abertura,
    };
    // reasons da disponibilidade (contrato: "qualquer reason da
    // disponibilidade, inclui ALREADY_REQUESTED"); MODULO_DESABILITADO (SQL)
    // -> MODULE_DISABLED (enum JSON), único nome que diverge entre as duas
    // camadas.
    const REASONS_SOLICITACAO_INDISPONIVEL = {
      MODULO_DESABILITADO: 'MODULE_DISABLED',
      NOT_LINKED: 'NOT_LINKED',
      NOT_CONFIGURED: 'NOT_CONFIGURED',
      DAY_NOT_ALLOWED: 'DAY_NOT_ALLOWED',
      BEFORE_OPENING: 'BEFORE_OPENING',
      AFTER_CUTOFF: 'AFTER_CUTOFF',
      BANK_ACCOUNT_PENDING: 'BANK_ACCOUNT_PENDING',
      NO_BANK_ACCOUNT: 'NO_BANK_ACCOUNT',
      ALREADY_REQUESTED: 'ALREADY_REQUESTED',
    };
    const codigoSql = Object.keys(REASONS_SOLICITACAO_INDISPONIVEL).find((codigo) => msg.includes(codigo));
    if (codigoSql) {
      return res.status(409).json({
        erro: 'SOLICITACAO_INDISPONIVEL',
        motivo: REASONS_SOLICITACAO_INDISPONIVEL[codigoSql],
        // 11.3 (converge onda-039, FR-003): mesma guarda do GET
        // /adiantamento/disponibilidade — sem dia habilitado,
        // nextAvailableAt() fabrica hoje+8 (limite interno de tentativas),
        // uma data em que nada abre. Sem dia configurado, não há "próxima
        // oportunidade" a indicar.
        nextAvailableAt: configParaRegras.horario_abertura && (configParaRegras.dias_habilitados || []).length
          ? nextAvailableAt(configParaRegras, new Date())
          : null,
      });
    }
    if (msg.includes('VERSAO_DESATUALIZADA')) {
      return res.status(409).json({ erro: 'VERSAO_DESATUALIZADA' });
    }
    logErro('POST /adiantamentos (solicitar)', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }

  if (!resultado) {
    logErro('POST /adiantamentos (solicitar)', new Error('RPC não devolveu linha'));
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }

  // FASE 11 (converge onda-037, 11.10/FR-047): trilha de auditoria da ação do
  // motorista — só na criação DE FATO (não no reenvio idempotente,
  // `reutilizado`), mesmo padrão de `hub-adiantamentos.js` (POST /lotes).
  // `idEmpresa`/`claims` habilitam a policy `auditoria_insert_por_escopo`
  // (migration 0069, ramo "ações iniciadas pelo motorista"); `hub_adiantamento_solicitar`
  // passou a devolver `id_empresa` na migration 0074 exatamente para isto.
  if (!resultado.reutilizado) {
    await registrarAuditoria({
      idEmpresa: resultado.id_empresa,
      acao: 'adiantamento.solicitado',
      recurso: 'AdiantamentoSolicitacao',
      recursoId: resultado.id,
      detalhes: { configuracaoId: corpo.configuracaoId },
      claims,
    });
  }

  let detalhe;
  try {
    detalhe = await buscarDetalhe(resultado.id, claims);
  } catch (e) {
    logErro('POST /adiantamentos (detalhe)', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }
  if (!detalhe) {
    logErro('POST /adiantamentos (detalhe)', new Error('detalhe não encontrado logo após criação'));
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }

  res.status(resultado.reutilizado ? 200 : 201).json(detalhe);
});

// --- 3.1.4 GET /adiantamentos?pagina= e GET /adiantamentos/:id -------------

router.get('/adiantamentos', async (req, res) => {
  let pagina = 1;
  if (req.query.pagina !== undefined) {
    pagina = Number(req.query.pagina);
    if (!Number.isInteger(pagina) || pagina < 1) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'pagina' });
    }
  }
  const porPagina = 20;

  let linhas;
  try {
    linhas = await hubPostgrestRequest(
      'rpc/hub_adiantamento_listar_motorista',
      'POST',
      { p_pagina: pagina, p_tamanho_pagina: porPagina },
      claimsMotorista(req),
    );
  } catch (e) {
    logErro('GET /adiantamentos', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }

  const linhasArr = Array.isArray(linhas) ? linhas : [];
  res.json({
    itens: linhasArr.map((row) => ({
      id: row.id,
      integrationId: formatarSequencial(row.id, 'ADV-'),
      dataSolicitacao: row.data_solicitacao,
      dataProducao: row.data_producao,
      status: row.status,
      statusRotulo: rotuloStatusAdiantamento(row.status),
      valorLiquido: dinheiro(row.valor_liquido),
    })),
    // Página vazia (sem solicitação nela) não devolve `total` (a RPC embute
    // `total` só nas linhas que existem) — 0 é o fallback honesto para "não
    // sabemos" quando não há linha nenhuma para ler o total de.
    total: linhasArr.length ? Number(linhasArr[0].total) : 0,
    pagina,
    porPagina,
  });
});

router.get('/adiantamentos/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
  }

  let detalhe;
  try {
    detalhe = await buscarDetalhe(id, claimsMotorista(req));
  } catch (e) {
    logErro('GET /adiantamentos/:id', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }
  if (!detalhe) {
    return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
  }
  res.json(detalhe);
});

// --- 3.1.5 POST /adiantamentos/:id/cancelar ---------------------------------

router.post('/adiantamentos/:id/cancelar', solicitarCancelarLimiter, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
  }
  const claims = claimsMotorista(req);

  let resultadoCancelar;
  try {
    const linhas = await hubPostgrestRequest('rpc/hub_adiantamento_cancelar', 'POST', { p_id: id }, claims);
    resultadoCancelar = Array.isArray(linhas) && linhas[0];
  } catch (e) {
    const msg = mensagemDeErro(e);
    if (msg.includes('NAO_ENCONTRADA')) {
      return res.status(404).json({ erro: 'NAO_ENCONTRADO' });
    }
    // "depois do corte" (edge #22) é bundlado em TRANSICAO_INVALIDA pelo
    // próprio contrato ("409 TRANSICAO_INVALIDA fora de AGUARDANDO_CORTE ou
    // depois do corte") — mesmo HTTP/código para os dois.
    if (msg.includes('TRANSICAO_INVALIDA') || msg.includes('AFTER_CUTOFF')) {
      return res.status(409).json({ erro: 'TRANSICAO_INVALIDA' });
    }
    logErro('POST /adiantamentos/:id/cancelar', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }

  // FASE 11 (converge onda-037, 11.10/FR-047): ver comentário equivalente em
  // POST /adiantamentos acima. `hub_adiantamento_cancelar` devolve `id_empresa`
  // desde a migration 0074.
  if (resultadoCancelar) {
    await registrarAuditoria({
      idEmpresa: resultadoCancelar.id_empresa,
      acao: 'adiantamento.cancelado',
      recurso: 'AdiantamentoSolicitacao',
      recursoId: id,
      claims,
    });
  }

  let detalhe;
  try {
    detalhe = await buscarDetalhe(id, claims);
  } catch (e) {
    logErro('POST /adiantamentos/:id/cancelar (detalhe)', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }
  if (!detalhe) {
    logErro('POST /adiantamentos/:id/cancelar (detalhe)', new Error('detalhe não encontrado logo após cancelar'));
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }
  res.json(detalhe);
});

// --- 3.2 conta bancária e bancos ---------------------------------------------

/** `ContaBancariaAppResumo` (contracts/motorista-api.md `GET /conta-bancaria`)
 * a partir do jsonb já mascarado por `hub_conta_bancaria_mascarar` (3.2/dec-074:
 * `chavePixTipo` cru e `emailComprovante` mascarado já vêm prontos do SQL;
 * `banco`/`contaMascarada`/`documentoMascarado` são só reformatação de campos
 * que o SQL já mascarou — nunca dígito cru chega a este processo). */
function mapContaBancariaAppResumo(contaJsonb) {
  if (!contaJsonb) return null;
  return {
    id: contaJsonb.id,
    status: contaJsonb.status,
    banco: formatarBancoCodigoNome(contaJsonb.bancoCodigo, contaJsonb.bancoNome),
    agencia: contaJsonb.agencia,
    contaMascarada: `${contaJsonb.conta}-${contaJsonb.contaDigito}`,
    tipoConta: contaJsonb.tipoConta,
    titularNome: contaJsonb.titularNome,
    documentoMascarado: pontuarDocumentoMascarado(contaJsonb.titularDocumento),
    chavePixTipo: contaJsonb.chavePixTipo,
    emailComprovante: contaJsonb.emailComprovante,
    solicitadaEm: contaJsonb.solicitadaEm,
    motivoRejeicao: contaJsonb.motivoRejeicao,
  };
}

// --- 3.2.1 GET /conta-bancaria ------------------------------------------------

router.get('/conta-bancaria', async (req, res) => {
  let linhas;
  try {
    linhas = await hubPostgrestRequest('rpc/hub_conta_bancaria_motorista', 'POST', {}, claimsMotorista(req));
  } catch (e) {
    logErro('GET /conta-bancaria', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }
  const row = Array.isArray(linhas) && linhas[0];
  if (!row) {
    logErro('GET /conta-bancaria', new Error('RPC não devolveu linha'));
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }
  res.json({
    aprovada: mapContaBancariaAppResumo(row.aprovada),
    pendente: mapContaBancariaAppResumo(row.pendente),
    ultimaRejeicao: mapContaBancariaAppResumo(row.ultima_rejeitada),
  });
});

// --- 3.2.2 POST /conta-bancaria/solicitacoes ---------------------------------

router.post('/conta-bancaria/solicitacoes', contaBancariaLimiter, async (req, res) => {
  // 3.2.6/S6/CHK019: só os campos do contrato, já validados e normalizados —
  // nunca `req.body` cru repassado para a RPC (sem mass assignment).
  const validacao = validarContaBancaria(req.body);
  if (!validacao.valido) {
    return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: validacao.motivo });
  }

  const claims = claimsMotorista(req);

  // 12.1 (converge onda-044, FR-015): mesma defesa em profundidade das
  // outras três rotas (disponibilidade/regras/POST adiantamentos) —
  // `hub_conta_bancaria_solicitar` só valida NOT_LINKED, não módulo nem
  // grupo. Sem isto, módulo ativo por engano para empresa fora do grupo
  // Movee ainda criava ContaBancariaMotorista PENDENTE.
  let dispRow;
  try {
    const dispLinhas = await hubPostgrestRequest('rpc/hub_adiantamento_disponibilidade', 'POST', {}, claims);
    dispRow = Array.isArray(dispLinhas) && dispLinhas[0];
  } catch (e) {
    logErro('POST /conta-bancaria/solicitacoes (disponibilidade)', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }
  if (!dispRow) {
    logErro('POST /conta-bancaria/solicitacoes (disponibilidade)', new Error('RPC não devolveu linha'));
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }
  if (dispRow.modulo_ativo && !(await mesmoGrupoQue(dispRow.id_empresa, 6, {}))) {
    return res.status(409).json({ erro: 'SOLICITACAO_INDISPONIVEL', motivo: 'OUTSIDE_GROUP' });
  }

  let resultado;
  try {
    const linhas = await hubPostgrestRequest(
      'rpc/hub_conta_bancaria_solicitar',
      'POST',
      { p_dados: validacao.dados },
      claims,
    );
    resultado = Array.isArray(linhas) && linhas[0];
  } catch (e) {
    const msg = mensagemDeErro(e);
    if (msg.includes('NOT_LINKED')) {
      return res.status(409).json({ erro: 'SOLICITACAO_INDISPONIVEL', motivo: 'NOT_LINKED' });
    }
    logErro('POST /conta-bancaria/solicitacoes', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }
  if (!resultado) {
    logErro('POST /conta-bancaria/solicitacoes', new Error('RPC não devolveu linha'));
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }

  // FASE 11 (converge onda-037, 11.10/FR-047): ver comentário equivalente em
  // POST /adiantamentos acima. `hub_conta_bancaria_solicitar` sempre cria uma
  // PENDENTE nova (sem idempotência a checar) e devolve `id_empresa` desde a
  // migration 0074. `detalhes` fica vazio de propósito — dado bancário/CPF
  // nunca entra em auditoria (scrubDetalhes só cobre chave/padrão conhecidos;
  // mais seguro não escrever o campo do que confiar só no scrub).
  await registrarAuditoria({
    idEmpresa: resultado.id_empresa,
    acao: 'conta_bancaria.solicitada',
    recurso: 'ContaBancariaMotorista',
    recursoId: resultado.id,
    claims,
  });

  // FR-017/edge #9-#10: a PENDENTE recém-criada nunca toca a APROVADA
  // anterior (garantido em `hub_conta_bancaria_solicitar`, 0067) — a releitura
  // abaixo só busca o retrato mascarado da PENDENTE para a resposta 201
  // (mesmo padrão de `buscarDetalhe` após `hub_adiantamento_solicitar`).
  let contaLinhas;
  try {
    contaLinhas = await hubPostgrestRequest('rpc/hub_conta_bancaria_motorista', 'POST', {}, claims);
  } catch (e) {
    logErro('POST /conta-bancaria/solicitacoes (releitura)', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }
  const contaRow = Array.isArray(contaLinhas) && contaLinhas[0];
  res.status(201).json(mapContaBancariaAppResumo(contaRow && contaRow.pendente));
});

// --- 3.2.3 GET /bancos --------------------------------------------------------

router.get('/bancos', (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const todos = bancosFixture.bancos || [];
  const filtrados = q ? todos.filter((b) => b.codigo.startsWith(q) || b.nome.toLowerCase().includes(q)) : todos;
  res.json({ itens: filtrados.slice(0, 20).map((b) => ({ codigo: b.codigo, nome: b.nome })) });
});

// --- FASE 5 (5.4) — central de notificações ---------------------------------
// Ref: contracts/motorista-api.md §Notificações; contracts/sql-rpc.md "App
// do motorista" (hub_notificacao_*, 0068). Mesmo padrão de tradução de erro/
// paginação das rotas acima.

const CATEGORIAS_NOTIFICACAO = new Set(['adiantamento', 'pagamento', 'conta_bancaria', 'sistema', 'aviso']);

// 5.4.4 (defesa em profundidade): "NotificacaoMotorista".link já tem CHECK na
// allowlist no banco (0068) — esta é uma SEGUNDA barreira, no Node, antes de
// repassar o valor ao cliente. Nunca confia cegamente no que a RPC devolveu;
// um `link` fora da lista (dado antigo, RPC futura com bug) sai como `null`
// em vez de vazar um valor não esperado para o app navegar.
const LINK_ALLOWLIST_FIXO = new Set(['/adiantamento', '/conta-bancaria', '/repasse']);
const LINK_ALLOWLIST_REGEX = [/^\/adiantamento\/\d+$/, /^\/avisos\/\d+$/];

function linkPermitidoOuNulo(link) {
  if (typeof link !== 'string' || !link) return null;
  if (LINK_ALLOWLIST_FIXO.has(link)) return link;
  if (LINK_ALLOWLIST_REGEX.some((re) => re.test(link))) return link;
  return null;
}

function mapNotificacao(row) {
  return {
    id: row.id,
    categoria: row.categoria,
    titulo: row.titulo,
    corpo: row.corpo,
    link: linkPermitidoOuNulo(row.link),
    criadaEm: row.criada_em,
    lida: row.lida === true,
  };
}

router.get('/notificacoes', async (req, res) => {
  let pagina = 1;
  if (req.query.pagina !== undefined) {
    pagina = Number(req.query.pagina);
    if (!Number.isInteger(pagina) || pagina < 1) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'pagina' });
    }
  }

  let categoria = null;
  if (req.query.categoria !== undefined) {
    if (typeof req.query.categoria !== 'string' || !CATEGORIAS_NOTIFICACAO.has(req.query.categoria)) {
      return res.status(400).json({ erro: 'DADOS_INVALIDOS', motivo: 'categoria' });
    }
    categoria = req.query.categoria;
  }

  const naoLidas = req.query.naoLidas === 'true' ? true : null;
  const porPagina = 20;

  let linhas;
  try {
    linhas = await hubPostgrestRequest(
      'rpc/hub_notificacao_listar',
      'POST',
      { p_pagina: pagina, p_categoria: categoria, p_nao_lidas: naoLidas },
      claimsMotorista(req),
    );
  } catch (e) {
    logErro('GET /notificacoes', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }

  const linhasArr = Array.isArray(linhas) ? linhas : [];
  res.json({
    itens: linhasArr.map(mapNotificacao),
    total: linhasArr.length ? Number(linhasArr[0].total) : 0,
    pagina,
    porPagina,
  });
});

router.get('/notificacoes/nao-lidas', async (req, res) => {
  let linhas;
  try {
    linhas = await hubPostgrestRequest('rpc/hub_notificacao_nao_lidas', 'POST', {}, claimsMotorista(req));
  } catch (e) {
    logErro('GET /notificacoes/nao-lidas', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }
  const row = Array.isArray(linhas) && linhas[0];
  res.json({ total: row ? Number(row.total) : 0 });
});

router.post('/notificacoes/:id/lida', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(404).json({ erro: 'NAO_ENCONTRADA' });
  }

  try {
    await hubPostgrestRequest('rpc/hub_notificacao_marcar_lida', 'POST', { p_id: id }, claimsMotorista(req));
  } catch (e) {
    const msg = mensagemDeErro(e);
    if (msg.includes('NAO_ENCONTRADA')) {
      return res.status(404).json({ erro: 'NAO_ENCONTRADA' });
    }
    logErro('POST /notificacoes/:id/lida', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }
  res.status(204).end();
});

router.post('/notificacoes/lidas', async (req, res) => {
  try {
    await hubPostgrestRequest('rpc/hub_notificacao_marcar_todas', 'POST', {}, claimsMotorista(req));
  } catch (e) {
    logErro('POST /notificacoes/lidas', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }
  res.status(204).end();
});

// --- 3.9 GET /repasse ---------------------------------------------------
// contracts/motorista-api.md §GET /motorista/repasse; infra/hub/migrations/
// 0071_repasse_motorista_detalhe.sql (RPC estendida — gap identificado
// onda-019, tasks.md 3.9). 404 NAO_DISPONIVEL quando `visivel=false`
// (repasse_visivel_app=false ou apuração não configurada, D-13) — a tela
// (6.6.3) trata isso como "não renderizar", não como erro.
router.get('/repasse', async (req, res) => {
  let linhas;
  let fechadas;
  try {
    // A3 (US6): a RPC ao vivo mostra sempre a semana que contém HOJE, e o
    // fechamento só ocorre depois que a semana termina — então o motorista
    // nunca via uma semana fechada, ou seja, nunca via o valor que de fato
    // vai receber. `ultimoFechado` traz a apuração congelada mais recente
    // dele. Best-effort: é informação ADICIONAL, e não pode derrubar a tela
    // do repasse corrente se falhar.
    [linhas, fechadas] = await Promise.all([
      hubPostgrestRequest('rpc/hub_adiantamento_repasse_motorista', 'POST', {}, claimsMotorista(req)),
      hubPostgrestRequest('rpc/hub_adiantamento_repasse_motorista_ultimo_fechado', 'POST', {}, claimsMotorista(req))
        .catch((e) => { logErro('GET /repasse (ultimo fechado)', e); return null; }),
    ]);
  } catch (e) {
    logErro('GET /repasse', e);
    return res.status(502).json({ erro: 'INDISPONIVEL' });
  }

  const row = Array.isArray(linhas) && linhas[0];
  if (!row || !row.visivel) {
    return res.status(404).json({ erro: 'NAO_DISPONIVEL' });
  }
  const fechado = Array.isArray(fechadas) && fechadas[0];

  res.json({
    periodoInicio: row.periodo_inicio,
    periodoFim: row.periodo_fim,
    dataRepasse: row.data_repasse,
    situacao: row.situacao,
    creditos: dinheiro(row.creditos),
    adiantamentos: (row.adiantamentos || []).map((a) => ({
      id: a.id,
      integrationId: formatarSequencial(a.id, 'ADV-'),
      dataProducao: a.dataProducao,
      valorBruto: dinheiro(a.valorBruto),
      emProcessamento: a.emProcessamento,
    })),
    debitos: dinheiro(row.debitos),
    remanescente: dinheiro(row.remanescente),
    negativo: row.negativo,
    // `null` quando o motorista ainda não tem nenhuma semana fechada — a tela
    // simplesmente não renderiza a seção, sem mensagem de erro.
    ultimoFechado: fechado ? {
      periodoInicio: fechado.periodo_inicio,
      periodoFim: fechado.periodo_fim,
      dataRepasse: fechado.data_repasse,
      fechadoEm: fechado.fechado_em,
      creditos: dinheiro(fechado.creditos),
      adiantamentos: dinheiro(fechado.adiantamentos),
      debitos: dinheiro(fechado.debitos),
      remanescente: dinheiro(fechado.remanescente),
      negativo: fechado.negativo,
    } : null,
  });
});

module.exports = { router };

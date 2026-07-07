/**
 * hub-import-normalizer.js — dois dialetos de normalização, faturamento e
 * performance (tasks.md FASE 2, 2.2/2.3). Ref: research.md Decision 3;
 * data-model.md Entity FaturamentoLancamento/PerformanceTurno; plano técnico
 * §7.2/§7.3/§10.
 *
 * Cada `normalizarLinhaFaturamento`/`normalizarLinhaPerformance` recebe os
 * campos JÁ splitados de uma linha (ver hub-import-parser.js) + o índice do
 * cabeçalho, e devolve:
 *   { valores: {...colunas exatas da tabela destino...}, erros: [...],
 *     avisos: [...] }
 * `erros` = falha PONTUAL da linha (vira `ImportacaoLinhaErro`, FASE 4.5;
 * conta para o limiar de >50% de invalidas, FASE 4.4). `avisos` = domínio
 * novo/inesperado que NÃO bloqueia a linha (briefing "Gotchas": categoria
 * nova em `descricao` ou `tipo` novo = warning, não erro; consistência de
 * corridas ofertadas/aceitas/rejeitadas = warning se violar, matriz §10.1).
 *
 * DECISÕES DE IMPLEMENTAÇÃO (registradas como Decisao auditável no
 * fechamento da onda, state-decisions.sh):
 *   - `praca`: a matriz (data-model.md) só define UMA coluna `praca` (text)
 *     no destino — não existe coluna própria para a "zona" extraída do
 *     sufixo "(ZONA)". Ingestão fiel (D4): o texto completo (trim) é
 *     preservado em `praca` SEM remover o sufixo "(ZONA)" (removê-lo
 *     perderia informação sem lugar para ir). `extrairZonaDePraca` abaixo
 *     IMPLEMENTA a extração pedida em 2.2.2 como capacidade utilitária
 *     (disponível para FASE 4+/relatórios futuros), sem que isso implique
 *     descartar o texto original da coluna persistida.
 *   - UUID: validado por FORMATO genérico (8-4-4-4-12 hex), não
 *     estritamente v4 — a doc descreve o dado observado como "UUID v4" mas
 *     essa é uma observação empírica de amostra (plano técnico §7.2), não
 *     uma constraint de negócio; validar por versão rejeitaria um UUID
 *     legítimo não-v4 vindo de uma exportação futura da plataforma parceira.
 */

'use strict';

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Não-guloso (research.md descreve `[\d.,]+` guloso, mas isso capturaria a
// vírgula separadora de "MIN: 30.0, INTER: 33" dentro do 1º grupo — "30.0,"
// em vez de "30.0" — quebrando normalizarDecimalVirgula, que trataria a
// vírgula sobrante como separador decimal. `+?` não-guloso + `\s*,\s*`
// explícito entre os grupos captura só o número, preservando a intenção da
// regra (Decision 3) sem esse efeito colateral.
const REGEX_MARGEM_FEE = /MIN:\s*([\d.,]+?)\s*,\s*INTER:\s*([\d.,]+)/i;
const REGEX_HHMMSS = /^(\d{1,4}):([0-5]\d):([0-5]\d)$/;
const REGEX_ZONA_SUFIXO = /^(.*)\s-\s(.+)\s\(ZONA\)$/i;

const TIPOS_LANCAMENTO_CONHECIDOS = ['Credito', 'Debito'];

const HEADER_FATURAMENTO = [
  'data_do_lancamento_financeiro',
  'data_do_periodo_de_referencia',
  'data_do_repasse',
  'periodo',
  'praca',
  'subpraca',
  'origem',
  'id_da_pessoa_entregadora',
  'recebedor',
  'tipo',
  'valor',
  'descricao',
  'atingido',
  'percentual_de_tempo_disponivel',
  'percentual_de_aceitacao',
  'percentual_de_conclusao',
  'criterio_tempo_disponivel',
  'criterio_rotas_aceitas',
  'criterio_rotas_concluidas',
  'margem_fee_porcentagem',
];

const HEADER_PERFORMANCE = [
  'data_do_periodo',
  'periodo',
  'duracao_do_periodo',
  'numero_minimo_de_entregadores_regulares_na_escala',
  'tag',
  'id_da_pessoa_entregadora',
  'pessoa_entregadora',
  'praca',
  'sub_praca',
  'origem',
  'tempo_disponivel_escalado',
  'tempo_disponivel_absoluto',
  'numero_de_corridas_ofertadas',
  'numero_de_corridas_aceitas',
  'numero_de_corridas_rejeitadas',
  'numero_de_corridas_completadas',
  'numero_de_corridas_canceladas_pela_pessoa_entregadora',
  'numero_de_pedidos_aceitos_e_concluidos',
  'soma_das_taxas_das_corridas_aceitas',
];

/** Campos (chaves de `valores`) usados no cálculo do hash_linha — ver
 * hub-import-hash.js. Ordem estável (não reordenar sem migrar hashes). */
const CAMPOS_HASH_FATURAMENTO = [
  'data_lancamento', 'data_referencia', 'data_repasse', 'periodo', 'praca',
  'subpraca', 'origem', 'id_externo', 'recebedor', 'tipo', 'valor',
  'descricao', 'atingido', 'pct_tempo_disponivel', 'pct_aceitacao',
  'pct_conclusao', 'criterio_tempo_disponivel', 'criterio_rotas_aceitas',
  'criterio_rotas_concluidas', 'margem_fee_raw', 'margem_fee_min',
  'margem_fee_inter',
];

const CAMPOS_HASH_PERFORMANCE = [
  'data_periodo', 'periodo', 'duracao', 'min_entregadores_escala', 'tag',
  'id_externo', 'pessoa_entregadora', 'praca', 'subpraca', 'origem',
  'tempo_disponivel_pct', 'tempo_disponivel', 'corridas_ofertadas',
  'corridas_aceitas', 'corridas_rejeitadas', 'corridas_completadas',
  'corridas_canceladas', 'pedidos_concluidos', 'taxas_centavos',
];

function normalizarNomeHeader(campo) {
  return (campo === null || campo === undefined ? '' : String(campo)).trim().toLowerCase();
}

/** Constrói um mapa {nomeHeader: indice} a partir da linha de cabeçalho. */
function indiceHeader(camposHeader) {
  const idx = {};
  (camposHeader || []).forEach((campo, i) => {
    idx[normalizarNomeHeader(campo)] = i;
  });
  return idx;
}

/**
 * Valida que o cabeçalho recebido bate EXATAMENTE (nome + ordem, após
 * trim/lowercase) com o esperado para o tipo — falha aqui é ESTRUTURAL
 * (research.md Decision 7 / tasks.md 4.4): cabeçalho errado => `failed`,
 * zero linhas persistidas.
 */
function validarHeader(camposHeader, tipo) {
  const esperado = tipo === 'faturamento' ? HEADER_FATURAMENTO : HEADER_PERFORMANCE;
  const recebido = (camposHeader || []).map(normalizarNomeHeader);
  const valido = recebido.length === esperado.length && esperado.every((h, i) => recebido[i] === h);
  return { valido, esperado, recebido };
}

function valorCampo(campos, idx, nomeHeader) {
  const i = idx[nomeHeader];
  if (i === undefined || i >= campos.length || campos[i] === undefined) return '';
  return String(campos[i]).trim();
}

/**
 * Decimal com VÍRGULA (faturamento, Decision 3): remove separador de milhar
 * `.` ANTES de trocar `,`→`.` — mas SÓ quando há vírgula no valor (senão o
 * `.` já É o separador decimal, ex.: capturas do regex de margem_fee que
 * às vezes vêm em formato ponto — "MIN: 30.0, INTER: 33").
 * Retorna `null` para vazio/inválido (2.2.1, 2.2.5).
 */
function normalizarDecimalVirgula(valorBruto) {
  if (valorBruto === null || valorBruto === undefined) return null;
  const str = String(valorBruto).trim();
  if (str === '') return null;
  const semMilhar = str.includes(',') ? str.replace(/\./g, '').replace(',', '.') : str;
  const numero = Number(semMilhar);
  return Number.isFinite(numero) ? numero : null;
}

/** Decimal com PONTO direto (performance, Decision 3) — sem transformação. */
function normalizarDecimalPonto(valorBruto) {
  if (valorBruto === null || valorBruto === undefined) return null;
  const str = String(valorBruto).trim();
  if (str === '') return null;
  const numero = Number(str);
  return Number.isFinite(numero) ? numero : null;
}

/** Extrai a zona do sufixo "... - <ZONA> (ZONA)" quando presente (2.2.2). */
function extrairZonaDePraca(pracaBruta) {
  const trimmed = (pracaBruta || '').trim();
  const match = trimmed.match(REGEX_ZONA_SUFIXO);
  if (match) {
    return { praca: trimmed, zonaExtraida: match[2].trim() };
  }
  return { praca: trimmed || null, zonaExtraida: null };
}

/** margem_fee_porcentagem (só faturamento): raw sempre gravado; min/inter só
 * se a regex casar — regex não casar NÃO é erro de linha (2.2.3, D4). */
function normalizarMargemFee(valorBruto) {
  const raw = valorBruto === null || valorBruto === undefined ? '' : String(valorBruto).trim();
  if (raw === '') return { raw: null, min: null, inter: null };
  const match = raw.match(REGEX_MARGEM_FEE);
  if (!match) return { raw, min: null, inter: null };
  return {
    raw,
    min: normalizarDecimalVirgula(match[1]),
    inter: normalizarDecimalVirgula(match[2]),
  };
}

/** `HH:MM:SS` → validado para virar `interval` do Postgres (aceita string
 * como está; Postgres interpreta "HH:MM:SS" nativamente). Horas com até 4
 * dígitos (duração acumulada pode passar de 24h, não é hora do relógio). */
function normalizarDuracaoHHMMSS(valorBruto) {
  const str = valorBruto === null || valorBruto === undefined ? '' : String(valorBruto).trim();
  if (str === '') return { valor: null, valido: true };
  const match = REGEX_HHMMSS.test(str);
  return { valor: match ? str : null, valido: match };
}

function uuidValido(str) {
  return REGEX_UUID.test(str);
}

function parseIntCampo(valorBruto) {
  const str = valorBruto === null || valorBruto === undefined ? '' : String(valorBruto).trim();
  if (str === '') return null;
  if (!/^-?\d+$/.test(str)) return null;
  return parseInt(str, 10);
}

/**
 * Normaliza 1 linha do CSV de FATURAMENTO (2.2). `campos` = array já
 * splitado pelo parser; `idx` = índice de cabeçalho (indiceHeader()).
 */
function normalizarLinhaFaturamento(campos, idx) {
  const erros = [];
  const avisos = [];
  const bruto = {};
  HEADER_FATURAMENTO.forEach((h) => {
    bruto[h] = valorCampo(campos, idx, h);
  });

  const dataLancamento = bruto.data_do_lancamento_financeiro || null;
  const dataReferencia = bruto.data_do_periodo_de_referencia || null;
  const dataRepasse = bruto.data_do_repasse || null;
  if (!dataLancamento) erros.push({ campo: 'data_lancamento', motivo: 'campo obrigatório ausente' });
  if (!dataReferencia) erros.push({ campo: 'data_referencia', motivo: 'campo obrigatório ausente' });

  const { praca } = extrairZonaDePraca(bruto.praca);
  const subpraca = bruto.subpraca || null;
  const origem = bruto.origem || null;
  const periodo = bruto.periodo ? bruto.periodo.toUpperCase() : null;

  const idExternoBruto = bruto.id_da_pessoa_entregadora || '';
  let idExterno = null;
  if (idExternoBruto !== '') {
    if (uuidValido(idExternoBruto)) {
      idExterno = idExternoBruto.toLowerCase();
    } else {
      erros.push({ campo: 'id_da_pessoa_entregadora', motivo: 'UUID inválido', valorBruto: idExternoBruto });
    }
  }
  // Ausência de UUID NÃO é erro (4,5% legítimo — bônus agregados, §7.5).

  const recebedor = bruto.recebedor || null;
  if (!recebedor) erros.push({ campo: 'recebedor', motivo: 'campo obrigatório ausente' });

  const tipo = bruto.tipo || '';
  if (!tipo) {
    erros.push({ campo: 'tipo', motivo: 'campo obrigatório ausente' });
  } else if (!TIPOS_LANCAMENTO_CONHECIDOS.includes(tipo)) {
    avisos.push({ campo: 'tipo', motivo: `valor de tipo desconhecido: ${tipo}` });
  }

  const valor = normalizarDecimalVirgula(bruto.valor);
  if (valor === null || !(valor > 0)) {
    erros.push({ campo: 'valor', motivo: 'valor deve ser numérico e > 0', valorBruto: bruto.valor });
  }

  const descricao = bruto.descricao || '';
  if (!descricao) erros.push({ campo: 'descricao', motivo: 'campo obrigatório ausente' });

  const camposFaixa = [
    ['atingido', bruto.atingido],
    ['pct_tempo_disponivel', bruto.percentual_de_tempo_disponivel],
    ['pct_aceitacao', bruto.percentual_de_aceitacao],
    ['pct_conclusao', bruto.percentual_de_conclusao],
    ['criterio_tempo_disponivel', bruto.criterio_tempo_disponivel],
    ['criterio_rotas_aceitas', bruto.criterio_rotas_aceitas],
    ['criterio_rotas_concluidas', bruto.criterio_rotas_concluidas],
  ];
  const valoresFaixa = {};
  camposFaixa.forEach(([campo, valorBruto]) => {
    const v = normalizarDecimalVirgula(valorBruto);
    if (v !== null && (v < 0 || v > 1000)) {
      erros.push({ campo, motivo: 'fora da faixa 0-1000', valorBruto });
      valoresFaixa[campo] = null;
    } else {
      valoresFaixa[campo] = v;
    }
  });

  const margemFee = normalizarMargemFee(bruto.margem_fee_porcentagem);

  const valores = {
    data_lancamento: dataLancamento,
    data_referencia: dataReferencia,
    data_repasse: dataRepasse,
    periodo,
    praca,
    subpraca,
    origem,
    id_externo: idExterno,
    recebedor,
    tipo: tipo || null,
    valor,
    descricao: descricao || null,
    atingido: valoresFaixa.atingido,
    pct_tempo_disponivel: valoresFaixa.pct_tempo_disponivel,
    pct_aceitacao: valoresFaixa.pct_aceitacao,
    pct_conclusao: valoresFaixa.pct_conclusao,
    criterio_tempo_disponivel: valoresFaixa.criterio_tempo_disponivel,
    criterio_rotas_aceitas: valoresFaixa.criterio_rotas_aceitas,
    criterio_rotas_concluidas: valoresFaixa.criterio_rotas_concluidas,
    margem_fee_raw: margemFee.raw,
    margem_fee_min: margemFee.min,
    margem_fee_inter: margemFee.inter,
  };

  return { valores, erros, avisos };
}

/**
 * Normaliza 1 linha do CSV de PERFORMANCE (2.3). UUID é OBRIGATÓRIO aqui
 * (diferente de faturamento) — ausência é erro de linha (2.3.6).
 */
function normalizarLinhaPerformance(campos, idx) {
  const erros = [];
  const avisos = [];
  const bruto = {};
  HEADER_PERFORMANCE.forEach((h) => {
    bruto[h] = valorCampo(campos, idx, h);
  });

  const dataPeriodo = bruto.data_do_periodo || null;
  if (!dataPeriodo) erros.push({ campo: 'data_periodo', motivo: 'campo obrigatório ausente' });

  const periodo = bruto.periodo ? bruto.periodo.toUpperCase() : null;
  if (!periodo) erros.push({ campo: 'periodo', motivo: 'campo obrigatório ausente' });

  const duracaoInfo = normalizarDuracaoHHMMSS(bruto.duracao_do_periodo);
  if (!duracaoInfo.valido) {
    erros.push({ campo: 'duracao', motivo: 'formato HH:MM:SS inválido', valorBruto: bruto.duracao_do_periodo });
  }

  const minEntregadoresEscala = parseIntCampo(bruto.numero_minimo_de_entregadores_regulares_na_escala);
  if (minEntregadoresEscala === null || minEntregadoresEscala < 0) {
    erros.push({
      campo: 'min_entregadores_escala',
      motivo: 'inteiro >= 0 obrigatório',
      valorBruto: bruto.numero_minimo_de_entregadores_regulares_na_escala,
    });
  }

  const tag = bruto.tag || null;

  const idExternoBruto = bruto.id_da_pessoa_entregadora || '';
  let idExterno = null;
  if (idExternoBruto === '') {
    erros.push({ campo: 'id_da_pessoa_entregadora', motivo: 'UUID obrigatório ausente' });
  } else if (!uuidValido(idExternoBruto)) {
    erros.push({ campo: 'id_da_pessoa_entregadora', motivo: 'UUID inválido', valorBruto: idExternoBruto });
  } else {
    idExterno = idExternoBruto.toLowerCase();
  }

  const pessoaEntregadora = bruto.pessoa_entregadora || '';
  if (!pessoaEntregadora) erros.push({ campo: 'pessoa_entregadora', motivo: 'campo obrigatório ausente' });

  const { praca } = extrairZonaDePraca(bruto.praca);
  if (!praca) erros.push({ campo: 'praca', motivo: 'campo obrigatório ausente' });
  const subpraca = bruto.sub_praca || null;
  const origem = bruto.origem || null;

  const tempoDisponivelPct = normalizarDecimalPonto(bruto.tempo_disponivel_escalado);
  if (tempoDisponivelPct === null || tempoDisponivelPct < 0 || tempoDisponivelPct > 150) {
    erros.push({
      campo: 'tempo_disponivel_pct',
      motivo: 'fora da faixa 0-150',
      valorBruto: bruto.tempo_disponivel_escalado,
    });
  }

  const tempoDisponivelInfo = normalizarDuracaoHHMMSS(bruto.tempo_disponivel_absoluto);
  if (!tempoDisponivelInfo.valido) {
    erros.push({
      campo: 'tempo_disponivel',
      motivo: 'formato HH:MM:SS inválido',
      valorBruto: bruto.tempo_disponivel_absoluto,
    });
  }

  const corridasOfertadas = parseIntCampo(bruto.numero_de_corridas_ofertadas);
  const corridasAceitas = parseIntCampo(bruto.numero_de_corridas_aceitas);
  const corridasRejeitadas = parseIntCampo(bruto.numero_de_corridas_rejeitadas);
  const corridasCompletadas = parseIntCampo(bruto.numero_de_corridas_completadas);
  const corridasCanceladas = parseIntCampo(bruto.numero_de_corridas_canceladas_pela_pessoa_entregadora);

  [
    ['corridas_ofertadas', corridasOfertadas, bruto.numero_de_corridas_ofertadas],
    ['corridas_aceitas', corridasAceitas, bruto.numero_de_corridas_aceitas],
    ['corridas_rejeitadas', corridasRejeitadas, bruto.numero_de_corridas_rejeitadas],
    ['corridas_completadas', corridasCompletadas, bruto.numero_de_corridas_completadas],
    ['corridas_canceladas', corridasCanceladas, bruto.numero_de_corridas_canceladas_pela_pessoa_entregadora],
  ].forEach(([campo, valor, valorBruto]) => {
    if (valor === null || valor < 0) {
      erros.push({ campo, motivo: 'inteiro >= 0 obrigatório', valorBruto });
    }
  });

  // Consistência (matriz §10.1): aceitas+rejeitadas <= ofertadas; completadas
  // <= aceitas — WARNING se violar, NÃO erro de linha (não bloqueia).
  if (
    corridasOfertadas !== null && corridasAceitas !== null && corridasRejeitadas !== null &&
    corridasAceitas + corridasRejeitadas > corridasOfertadas
  ) {
    avisos.push({ campo: 'corridas_aceitas', motivo: 'aceitas+rejeitadas > ofertadas' });
  }
  if (corridasCompletadas !== null && corridasAceitas !== null && corridasCompletadas > corridasAceitas) {
    avisos.push({ campo: 'corridas_completadas', motivo: 'completadas > aceitas' });
  }

  const pedidosConcluidos = parseIntCampo(bruto.numero_de_pedidos_aceitos_e_concluidos);
  const taxasCentavos = parseIntCampo(bruto.soma_das_taxas_das_corridas_aceitas);
  if (taxasCentavos === null || taxasCentavos < 0) {
    erros.push({
      campo: 'taxas_centavos',
      motivo: 'inteiro >= 0 obrigatório (centavos, sem divisão)',
      valorBruto: bruto.soma_das_taxas_das_corridas_aceitas,
    });
  }

  const valores = {
    data_periodo: dataPeriodo,
    periodo,
    duracao: duracaoInfo.valor,
    min_entregadores_escala: minEntregadoresEscala,
    tag,
    id_externo: idExterno,
    pessoa_entregadora: pessoaEntregadora || null,
    praca,
    subpraca,
    origem,
    tempo_disponivel_pct: tempoDisponivelPct,
    tempo_disponivel: tempoDisponivelInfo.valor,
    corridas_ofertadas: corridasOfertadas,
    corridas_aceitas: corridasAceitas,
    corridas_rejeitadas: corridasRejeitadas,
    corridas_completadas: corridasCompletadas,
    corridas_canceladas: corridasCanceladas,
    pedidos_concluidos: pedidosConcluidos,
    taxas_centavos: taxasCentavos,
  };

  return { valores, erros, avisos };
}

module.exports = {
  HEADER_FATURAMENTO,
  HEADER_PERFORMANCE,
  CAMPOS_HASH_FATURAMENTO,
  CAMPOS_HASH_PERFORMANCE,
  TIPOS_LANCAMENTO_CONHECIDOS,
  indiceHeader,
  validarHeader,
  normalizarDecimalVirgula,
  normalizarDecimalPonto,
  extrairZonaDePraca,
  normalizarMargemFee,
  normalizarDuracaoHHMMSS,
  uuidValido,
  parseIntCampo,
  normalizarLinhaFaturamento,
  normalizarLinhaPerformance,
};

'use strict';

/**
 * Leitor do layout de 5 colunas dos "pagos por fora" (feature lancamento-externo).
 *
 *   CNPJ | Data do pagamento | Valor | Nome | Observação
 *
 * Modo de falha FECHADO (FR-007/FR-047): na dúvida a linha é recusada com um
 * motivo-token estável; nada é adivinhado e nenhum conteúdo de célula vai para
 * o motivo (a planilha é do financeiro e a célula pode ter dado de terceiro).
 * `Nome` é lido só para existir no contrato: nunca é interpretado nem devolvido.
 *
 * O teto por linha mora AQUI e nunca em `CHECK` (dec-026): em `CHECK` a violação
 * viraria exceção de transação (aborta o lote) em vez de recusa-de-linha.
 */
const XLSX = require('xlsx');
const { lerPlanilha } = require('./xlsx-import-core');
const { paraCentavos, formatarCentavos } = require('./adiantamento-remanescente');

const CABECALHO_ESPERADO = ['CNPJ', 'Data do pagamento', 'Valor', 'Nome', 'Observação'];
const MAX_LINHAS = 10000;
const OBSERVACAO_MAX = 500;
const DATA_PISO = '2024-01-01';
/** Guard-rail de digitação (dec-026), não limite de negócio. Em centavos. */
const TETO_CENTAVOS = 500000;
const TIPOS = ['ADIANTAMENTO', 'AJUSTE_CREDITO'];

class LancamentoExternoParseError extends Error {
  constructor(message, motivo) {
    super(message);
    this.name = 'LancamentoExternoParseError';
    this.motivo = motivo;
  }
}
const parseErro = (motivo, msg) => new LancamentoExternoParseError(msg || motivo, motivo);

// Os textos acionáveis para o operador (um por motivo) moram no FRONTEND (`lib/hub/lancamento-externo.ts`,
// `MOTIVO_LINHA`): a resposta da rota só carrega o TOKEN e a contagem. Antes havia aqui uma tabela `MENSAGENS`
// que nada importava (código morto, e o teste a validava no lugar da que o operador lê). O teste
// `lancamento-externo-unit` agora cruza os tokens que a RPC e este leitor emitem com a tabela do frontend.

const pad = (n) => String(n).padStart(2, '0');

/** Soma 1 dia a um 'YYYY-MM-DD' (aritmética de calendário em UTC, sem fuso). */
function maisUmDia(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function hojeSaoPaulo() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

const ehDataReal = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

/** @returns {{iso:string}|{motivo:string}} */
function lerData(cel, date1904) {
  if (typeof cel === 'number') {
    if (date1904 === null) return { motivo: 'EPOCH_ILEGIVEL' };
    // API oficial do SheetJS (FR-046): componentes de calendário, fração de dia ignorada.
    const p = XLSX.SSF.parse_date_code(cel, { date1904 });
    if (!p) return { motivo: 'DATA_INVALIDA' };
    return { iso: `${String(p.y).padStart(4, '0')}-${pad(p.m)}-${pad(p.d)}` };
  }
  const t = String(cel).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  let y; let mo; let d;
  if (m) { [, y, mo, d] = m.map(Number); } else {
    m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
    if (!m) return { motivo: 'DATA_INVALIDA' };
    d = Number(m[1]); mo = Number(m[2]); y = Number(m[3]);
  }
  if (!ehDataReal(y, mo, d)) return { motivo: 'DATA_INVALIDA' };
  return { iso: `${String(y).padStart(4, '0')}-${pad(mo)}-${pad(d)}` };
}

/** @returns {{centavos:number}|{motivo:string}} */
function lerValor(cel) {
  let n;
  let txt;
  if (typeof cel === 'number') {
    if (!Number.isFinite(cel) || cel <= 0) return { motivo: 'VALOR_INVALIDO' };
    n = cel; txt = String(cel);
  } else {
    let t = String(cel).trim().replace(/^R\$\s*/, '');
    if (/^\d{1,3}(?:\.\d{3})+$/.test(t)) return { motivo: 'VALOR_AMBIGUO' };
    if (/^\d{1,3}(?:\.\d{3})+,\d+$/.test(t)) t = t.replace(/\./g, '');
    t = t.replace(/,/g, '.');
    if (!/^\d+(?:\.\d+)?$/.test(t)) return { motivo: 'VALOR_INVALIDO' };
    n = Number(t); txt = t;
    if (!Number.isFinite(n) || n <= 0) return { motivo: 'VALOR_INVALIDO' };
  }
  // FR-047: o gate roda ANTES de `paraCentavos`, que arredonda calado (100.005 -> 100,01).
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return { motivo: 'VALOR_FRACAO_DE_CENTAVO' };
  const centavos = paraCentavos(txt);
  if (centavos <= 0) return { motivo: 'VALOR_INVALIDO' };
  if (centavos > TETO_CENTAVOS) return { motivo: 'VALOR_ACIMA_DO_TETO' };
  return { centavos };
}

/**
 * @param {Buffer} buffer
 * @param {{hoje?: string}} [opts] `hoje` = 'YYYY-MM-DD' (injetável para teste).
 * @returns {{validas: Array<{i:number,linha:number,cnpj:string,data:string,valor:string,obs:string|null}>,
 *            recusadas: Array<{i:number,motivo:string}>, date1904: boolean|null}}
 * Lança `LancamentoExternoParseError` para erro de ARQUIVO (nada é aplicado).
 */
function lerLancamentos(buffer, { hoje = hojeSaoPaulo() } = {}) {
  const { linhas, numeros, date1904 } = lerPlanilha(buffer, {
    cabecalhoEsperado: CABECALHO_ESPERADO, maxLinhas: MAX_LINHAS, erro: parseErro, cabecalhoTolerante: true, areaReal: true,
  });
  return interpretarLinhas(linhas, date1904, hoje, numeros);
}

/** Separado para o epoch ilegível (`date1904 === null`) ser testável: o SheetJS
 * sempre popula o campo num XLSX real, então o ramo só se alcança por aqui. */
function interpretarLinhas(linhas, date1904, hoje, numeros) {
  const limite = maisUmDia(hoje);
  const validas = [];
  const recusadas = [];
  const vistas = new Set();

  linhas.forEach((linha, i) => {
    const cel = (k) => (linha[k] === undefined || linha[k] === null ? '' : linha[k]);
    const recusa = (motivo) => recusadas.push({ i, motivo });
    const numLinha = numeros ? numeros[i] : i + 2;

    // Coluna "Geral" do Excel guarda 00.000.000/0001-92 como o NÚMERO 192: o zero da frente
    // não sobrevive. Sem recompor, todo motorista de raiz iniciada em 0 fica sem dedução e o
    // repasse paga duas vezes. Pior caso do padStart: CNPJ curto digitado migra de CNPJ_INVALIDO
    // para CNPJ_SEM_MOTORISTA — outra recusa, nunca um caminho novo para dado errado entrar.
    const c0 = cel(0);
    // O gate conta DÍGITOS: só inteiro seguro de no máx. 14 dígitos é recomposto. Sem isso `1e21`
    // ("1e+21") virava "0000000001e+21" e passava por ter 14 CARACTERES.
    const cnpj = typeof c0 === 'number'
      ? (Number.isSafeInteger(c0) && c0 > 0 && /^\d{1,14}$/.test(String(c0)) ? String(c0).padStart(14, '0') : '')
      : String(c0).replace(/\D/g, '');
    if (cnpj.length !== 14) return recusa('CNPJ_INVALIDO');

    const dt = lerData(cel(1), date1904);
    if (dt.motivo) return recusa(dt.motivo);
    if (dt.iso < DATA_PISO || dt.iso > limite) return recusa('DATA_FORA_DA_FAIXA');

    const v = lerValor(cel(2));
    if (v.motivo) return recusa(v.motivo);

    const obsTxt = String(cel(4)).trim();
    if (Array.from(obsTxt).length > OBSERVACAO_MAX) return recusa('OBSERVACAO_MUITO_LONGA');

    const chave = `${cnpj}|${dt.iso}`;
    if (vistas.has(chave)) return recusa('DUPLICADA_NO_ARQUIVO');
    vistas.add(chave);

    validas.push({
      i, linha: numLinha, cnpj, data: dt.iso, valor: formatarCentavos(v.centavos), obs: obsTxt === '' ? null : obsTxt,
    });
  });
  return { validas, recusadas, date1904 };
}

/** [{motivo,total}] ordenado por total desc, depois motivo — só contagem (FR-031). */
function contarPorMotivo(motivos) {
  const mapa = new Map();
  motivos.forEach((m) => mapa.set(m, (mapa.get(m) || 0) + 1));
  return [...mapa].map(([motivo, total]) => ({ motivo, total }))
    .sort((a, b) => b.total - a.total || a.motivo.localeCompare(b.motivo));
}

module.exports = {
  LancamentoExternoParseError, CABECALHO_ESPERADO, MAX_LINHAS, TETO_CENTAVOS, TIPOS,
  lerLancamentos, interpretarLinhas, contarPorMotivo,
};

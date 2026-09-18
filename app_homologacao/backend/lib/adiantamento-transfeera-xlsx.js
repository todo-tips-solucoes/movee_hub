/**
 * adiantamento-transfeera-xlsx.js — helpers PUROS (sem I/O de rede) de
 * montagem/validação do arquivo de exportação Transfeera e do modelo de
 * descrição Pix do módulo Adiantamento (tasks.md FASE 2, 2.3).
 *
 * Ref: contracts/transfeera-xlsx.md §Funções; Spec §FR-028, §FR-029, §FR-055;
 * plan.md §Segurança S5; data-model.md AdiantamentoLoteItem/AdiantamentoConfiguracao.
 *
 * `itens` recebidos por `montarPlanilhaTransfeera` são o snapshot JÁ
 * formatado (`AdiantamentoLoteItem`, campos `col_*` snake_case) — nenhum
 * campo de código (banco/agência/conta/dígito) passa por `Number()` em
 * nenhum ponto deste arquivo; a única conversão numérica é a coluna I
 * (`valor`, moeda — contrato exige tipo `n`).
 */

'use strict';

const XLSX = require('xlsx');
const { paraCentavos } = require('./adiantamento-remanescente');

const LIMITE_DESCRICAO_PIX = 140;
const COLUNAS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];
const COL_VALOR_INDEX = 8; // coluna I (0-based)
const COLUNAS_OBRIGATORIAS_INDEX = [0, 1, 3, 4, 5, 6, 7, 8, 9]; // A,B,D,E,F,G,H,I,J

// --- Descrição Pix (2.3.3) --------------------------------------------------

const REGEX_PLACEHOLDER = /\{([^}]*)\}/g;
const PLACEHOLDERS_PERMITIDOS = new Set(['nome', 'data_producao', 'data_producao:DD.MM.AA']);

/** `"AAAA-MM-DD"` -> `"DD.MM.AA"` (formato do modelo, D-21). */
function formatarDataProducaoDDMMAA(dataISO) {
  const [ano, mes, dia] = String(dataISO).split('-');
  return `${dia}.${mes}.${String(ano).slice(-2)}`;
}

/**
 * Renderiza `descricao_pix_modelo` (`AdiantamentoConfiguracao.descricao_pix_modelo`)
 * — só aceita os placeholders `{nome}` e `{data_producao}`/`{data_producao:DD.MM.AA}`
 * (D-21, Q-N11). Qualquer outro `{...}` no modelo é recusado (lança): a
 * configuração é editável por um operador do hub e o texto vai para um
 * arquivo enviado a um sistema de pagamento de terceiro — interpolar campo
 * arbitrário seria vazamento de dado não previsto (S5, security).
 * Resultado sempre cortado em `LIMITE_DESCRICAO_PIX` caracteres (edge #28).
 */
function renderizarDescricaoPix(modelo, { nome, dataProducaoISO }) {
  const texto = String(modelo ?? '').replace(REGEX_PLACEHOLDER, (match, chave) => {
    if (!PLACEHOLDERS_PERMITIDOS.has(chave)) {
      throw new Error(`descricao_pix_modelo: placeholder nao permitido "{${chave}}"`);
    }
    return chave === 'nome' ? String(nome ?? '') : formatarDataProducaoDDMMAA(dataProducaoISO);
  });
  return texto.slice(0, LIMITE_DESCRICAO_PIX);
}

// --- Nome do arquivo (2.3.4, Q-N19) -----------------------------------------

/** `transfeera_adiantamentos_<AAAA-MM-DD>_lote-<NNNNNN>.xlsx` — número do
 * lote com 6 dígitos, sem truncar acima disso (Q-N19). */
function nomeArquivoTransfeera(dataCriacaoISO, numeroLote) {
  const lote = String(numeroLote).padStart(6, '0');
  return `transfeera_adiantamentos_${dataCriacaoISO}_lote-${lote}.xlsx`;
}

// --- Montagem (2.3.1) --------------------------------------------------------

/**
 * Monta o buffer .xlsx do lote a partir do snapshot já formatado dos itens
 * (`AdiantamentoLoteItem`) e da estrutura do contrato (fixture
 * `lib/fixtures/transfeera-contrato.json`). Uma aba, mescla `A1:L1`, 12
 * cabeçalhos — nenhum campo de código passa por `Number()`.
 */
function montarPlanilhaTransfeera(itens, contrato) {
  if (!Array.isArray(itens) || itens.length === 0) {
    throw new Error('montarPlanilhaTransfeera: itens vazio');
  }

  const linhas = itens.map((item) => [
    item.col_nome,
    item.col_documento,
    item.col_email || '',
    item.col_banco,
    item.col_agencia,
    item.col_conta,
    item.col_digito,
    item.col_tipo_conta,
    Number(item.valor), // única coluna numérica do contrato (moeda, tipo 'n')
    item.col_id_integracao,
    item.col_data_agendamento || '',
    item.col_descricao_pix,
  ]);

  const aoa = [[contrato.linha1Texto], contrato.cabecalhos, ...linhas];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!merges'] = [XLSX.utils.decode_range(contrato.mesclagemLinha1)];

  for (let i = 0; i < linhas.length; i += 1) {
    const ref = XLSX.utils.encode_cell({ r: i + 2, c: COL_VALOR_INDEX });
    if (ws[ref]) ws[ref].z = '"R$" #,##0.00';
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, contrato.aba);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// --- Validação (2.3.2) -------------------------------------------------------

/**
 * Relê o buffer gerado e confere contra o contrato + os totais esperados.
 * Retorna `{ok, falhas:[codigo]}` — nunca lança; quem chama decide se
 * cancela o lote (`falha_geracao`, FR-029).
 */
function validarPlanilhaTransfeera(buffer, contrato, { quantidade, valorTotal, idsIntegracao } = {}) {
  const falhas = [];
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    return { ok: false, falhas: ['ARQUIVO_ILEGIVEL'] };
  }

  if (wb.SheetNames.length !== 1 || wb.SheetNames[0] !== contrato.aba) {
    falhas.push('ABA_INVALIDA');
    return { ok: false, falhas }; // sem aba certa, nada mais é conferível
  }
  const ws = wb.Sheets[contrato.aba];

  const merges = ws['!merges'] || [];
  const mesclada = merges.find((m) => m.s.r === 0 && m.s.c === 0 && m.e.r === 0 && m.e.c === 11);
  if (!mesclada) falhas.push('MESCLA_INVALIDA');

  const cabecalhos = COLUNAS.map((col) => (ws[`${col}2`] ? String(ws[`${col}2`].v) : null));
  if (JSON.stringify(cabecalhos) !== JSON.stringify(contrato.cabecalhos)) falhas.push('CABECALHOS_INVALIDOS');
  // nada além da coluna L (linha 2)
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
  if (range.e.c > 11) falhas.push('CABECALHOS_INVALIDOS');

  const linhasDados = Math.max(0, range.e.r - 1); // linha 3 em diante
  if (typeof quantidade === 'number' && linhasDados !== quantidade) falhas.push('QUANTIDADE_DIVERGENTE');

  let somaCentavos = 0;
  const idsEncontrados = [];
  for (let r = 2; r <= range.e.r; r += 1) {
    for (const idx of COLUNAS_OBRIGATORIAS_INDEX) {
      const ref = XLSX.utils.encode_cell({ r, c: idx });
      const cell = ws[ref];
      if (!cell || cell.v === '' || cell.v == null) falhas.push('OBRIGATORIO_VAZIO');
    }
    for (const idx of [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11]) {
      const ref = XLSX.utils.encode_cell({ r, c: idx });
      const cell = ws[ref];
      if (cell && cell.t !== 's') falhas.push('TIPO_CELULA_INVALIDO');
    }
    const valorRef = XLSX.utils.encode_cell({ r, c: COL_VALOR_INDEX });
    const valorCell = ws[valorRef];
    if (valorCell) {
      if (valorCell.t !== 'n') falhas.push('TIPO_CELULA_INVALIDO');
      somaCentavos += paraCentavos(valorCell.v);
    }
    const idRef = XLSX.utils.encode_cell({ r, c: 9 });
    if (ws[idRef]) idsEncontrados.push(String(ws[idRef].v));
  }

  if (typeof valorTotal === 'number' && somaCentavos !== valorTotal) falhas.push('SOMA_DIVERGENTE');

  if (Array.isArray(idsIntegracao)) {
    const unicos = new Set(idsEncontrados);
    const esperados = new Set(idsIntegracao);
    const mesmoConjunto = unicos.size === idsEncontrados.length && idsEncontrados.length === esperados.size && idsEncontrados.every((id) => esperados.has(id));
    if (!mesmoConjunto) falhas.push('ID_DUPLICADO_OU_INESPERADO');
  }

  return { ok: falhas.length === 0, falhas: [...new Set(falhas)] };
}

module.exports = {
  montarPlanilhaTransfeera,
  validarPlanilhaTransfeera,
  renderizarDescricaoPix,
  formatarDataProducaoDDMMAA,
  nomeArquivoTransfeera,
};

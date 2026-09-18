/**
 * adiantamento-retorno-transfeera.js — helpers PUROS (sem I/O de rede) do
 * importador de retorno da Transfeera (tasks.md FASE 9, 9.1.1/9.1.2).
 *
 * Ref: tasks.md §FASE 9 (contrato REAL observado no arquivo do operador,
 * 2026-09-18, dec-129); Spec §FR-031..FR-036; data-model.md
 * AdiantamentoLoteItem.origem_situacao.
 *
 * Casamento é SEMPRE por `ID de integração` (padrão `ADV-<id>` do nosso
 * exportador, `formatarSequencial` em lib/adiantamento-dto.js) — nunca por
 * nome ou valor (decisão do operador, risco de marcar o adiantamento de
 * outra pessoa). Nenhuma coluna do CSV é inventada: o `motivo` de uma falha
 * é sempre o texto LITERAL da coluna `Motivo da falha` (ou, na ausência
 * dela, o `Código de erro` cru) — sem tabela de tradução.
 */

'use strict';

const XLSX = require('xlsx');
const { paraCentavos } = require('./adiantamento-remanescente');

const CABECALHO_ESPERADO = [
  'ID da transferência', 'ID de integração', 'Status', 'Valor', 'Pago em', 'Criado em',
  'Método de pagamento', 'Código Bancário', 'Nome do recebedor', 'CPF/CNPJ do recebedor',
  'Tipo de chave Pix do recebedor', 'Chave Pix', 'Número da conta', 'Número da agência',
  'Tipo de conta', 'Código do banco', 'Nome do banco', 'ID do lote', 'Nome do lote',
  'Recibo bancário', 'Recibo Transfeera', 'Código de erro', 'Motivo da falha',
];

const STATUS_CONHECIDOS = new Set(['Finalizada', 'Devolvida']);
const REGEX_ID_INTEGRACAO = /^ADV-(\d+)$/;

class RetornoTransfeeraParseError extends Error {
  constructor(message, motivo) {
    super(message);
    this.name = 'RetornoTransfeeraParseError';
    this.motivo = motivo;
  }
}

/** Lê o CSV (texto já decodificado, BOM incluso ou não) e devolve as linhas
 * normalizadas (9.1.1). Usa o `xlsx` (já dependência do projeto) como parser
 * CSV RFC4180 — `raw:false` preserva o texto exatamente como está na
 * célula (sem cortar zeros à esquerda de código de banco/agência, sem
 * converter `Valor` para float). Lança `RetornoTransfeeraParseError` se o
 * cabeçalho não bater com o contrato observado. */
function lerCsv(texto) {
  const wb = XLSX.read(String(texto ?? ''), { type: 'string' });
  const nomeAba = wb.SheetNames[0];
  const ws = nomeAba ? wb.Sheets[nomeAba] : null;
  const linhas = ws
    ? XLSX.utils.sheet_to_json(ws, {
      header: 1, defval: '', raw: false, blankrows: false,
    })
    : [];
  if (!linhas.length) throw new RetornoTransfeeraParseError('CSV vazio', 'ARQUIVO_VAZIO');

  const cabecalho = linhas[0].map((c) => String(c).trim());
  if (JSON.stringify(cabecalho) !== JSON.stringify(CABECALHO_ESPERADO)) {
    throw new RetornoTransfeeraParseError('Cabeçalho não confere com o contrato observado', 'CABECALHO_INVALIDO');
  }

  return linhas.slice(1).map((linha) => normalizarLinha(cabecalho, linha));
}

function normalizarLinha(cabecalho, linha) {
  const obj = {};
  cabecalho.forEach((nome, i) => {
    obj[nome] = linha[i] !== undefined && linha[i] !== null ? String(linha[i]).trim() : '';
  });
  const idIntegracao = obj['ID de integração'] || '';
  const status = obj.Status || '';
  const valorTexto = obj.Valor || '';
  return {
    idIntegracao,
    status,
    statusConhecido: STATUS_CONHECIDOS.has(status),
    valorCentavos: valorTexto !== '' ? paraCentavos(valorTexto) : null,
    codigoErro: obj['Código de erro'] || '',
    motivoFalha: obj['Motivo da falha'] || '',
  };
}

/** `ADV-000123` -> `123`; `null` se não casa o padrão do nosso exportador
 * (vazio, texto livre ou qualquer outro formato). */
function extrairIdSolicitacao(idIntegracao) {
  const m = REGEX_ID_INTEGRACAO.exec(String(idIntegracao ?? '').trim());
  return m ? Number(m[1]) : null;
}

/** Motivo literal (nunca inventado/traduzido) de uma linha `Devolvida`:
 * a coluna `Motivo da falha` do próprio arquivo; se vier vazia, cai para o
 * `Código de erro` cru; nunca uma string fixa fabricada por nós. */
function motivoLiteral(linha) {
  return linha.motivoFalha || linha.codigoErro || linha.status;
}

/**
 * Casa as linhas normalizadas do CSV com os itens de UM lote (9.1.2).
 * `itensLote`: [{solicitacaoId, colIdIntegracao, situacao, valorCentavos}]
 * (situacao ∈ AdiantamentoLoteItem.situacao).
 *
 * Devolve:
 *  - `aplicaveis`: linhas que podem ser aplicadas — `{solicitacaoId, status, motivo}`
 *    (`motivo` só preenchido quando `status==='Devolvida'`)
 *  - `ignoradas`: `{idIntegracao, motivo}` — nunca aplicadas; motivos:
 *    `ID_INTEGRACAO_INVALIDO` (vazio/texto livre/fora do padrão ADV-<id>),
 *    `NAO_PERTENCE_AO_LOTE` (id válido mas não é item deste lote),
 *    `JA_APLICADO` (item já saiu de `incluido` — idempotência, 9.1.5),
 *    `STATUS_DESCONHECIDO:<valor>` (nem Finalizada nem Devolvida — nunca
 *    adivinha, 9.1 nota),
 *    `VALOR_DIVERGENTE` (valor da linha ≠ valor do item — nunca casa por
 *    valor, mas confere como sanidade antes de aplicar por id)
 *  - `faltantes`: `solicitacaoId[]` — itens `incluido` do lote sem NENHUMA
 *    linha aplicável no arquivo (arquivo incompleto para este lote); quem
 *    chama NÃO deve aplicar parcialmente enquanto houver faltante (a RPC de
 *    confirmação marca "tudo que não é falha" como pago — aplicar com
 *    faltantes marcaria item sem retorno como pago por omissão)
 */
function casarComItensDoLote(linhasNormalizadas, itensLote) {
  const porIdIntegracao = new Map(itensLote.map((it) => [it.colIdIntegracao, it]));
  const aplicaveis = [];
  const ignoradas = [];

  for (const linha of linhasNormalizadas) {
    const idSolicitacao = extrairIdSolicitacao(linha.idIntegracao);
    if (idSolicitacao === null) {
      ignoradas.push({ idIntegracao: linha.idIntegracao, motivo: 'ID_INTEGRACAO_INVALIDO' });
      continue;
    }
    const item = porIdIntegracao.get(linha.idIntegracao);
    if (!item) {
      ignoradas.push({ idIntegracao: linha.idIntegracao, motivo: 'NAO_PERTENCE_AO_LOTE' });
      continue;
    }
    if (item.situacao !== 'incluido') {
      ignoradas.push({ idIntegracao: linha.idIntegracao, motivo: 'JA_APLICADO' });
      continue;
    }
    if (!linha.statusConhecido) {
      ignoradas.push({ idIntegracao: linha.idIntegracao, motivo: `STATUS_DESCONHECIDO:${linha.status}` });
      continue;
    }
    if (linha.valorCentavos !== item.valorCentavos) {
      ignoradas.push({ idIntegracao: linha.idIntegracao, motivo: 'VALOR_DIVERGENTE' });
      continue;
    }
    aplicaveis.push({
      solicitacaoId: item.solicitacaoId,
      status: linha.status,
      motivo: linha.status === 'Devolvida' ? motivoLiteral(linha) : null,
    });
  }

  const idsAplicaveis = new Set(aplicaveis.map((a) => a.solicitacaoId));
  const faltantes = itensLote
    .filter((it) => it.situacao === 'incluido' && !idsAplicaveis.has(it.solicitacaoId))
    .map((it) => it.solicitacaoId);

  return { aplicaveis, ignoradas, faltantes };
}

module.exports = {
  RetornoTransfeeraParseError,
  CABECALHO_ESPERADO,
  STATUS_CONHECIDOS,
  lerCsv,
  extrairIdSolicitacao,
  casarComItensDoLote,
};

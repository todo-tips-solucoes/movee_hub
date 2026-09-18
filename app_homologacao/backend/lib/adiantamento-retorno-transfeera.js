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

const { paraCentavos } = require('./adiantamento-remanescente');

/** Teto de linhas do arquivo de retorno (revisão de segurança 2026-09-18).
 * Um lote vai a `LOTE_LIMITE_IDS` = 5000 itens; o dobro cobre reenvio e
 * concatenação de exports do mesmo período com folga, e impede que um arquivo
 * adulterado faça o processo montar estrutura arbitrariamente grande antes de
 * qualquer validação de negócio. Dimensionado junto com o `express.json({
 * limit })` da rota `POST /lotes/:id/retorno`. */
const MAX_LINHAS_RETORNO = 10000;

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

/**
 * Divisor CSV RFC4180 (revisão de segurança 2026-09-18). ANTES isto era
 * `XLSX.read(texto, {type:'string'})`: para ler um CSV, todo o sniffing de
 * formato do SheetJS (zip/XLSX, HTML, XML, Lotus…) rodava sobre bytes vindos
 * de terceiro, ANTES de o cabeçalho ser conferido — e `xlsx@0.18.5` tem duas
 * advisories HIGH (prototype pollution, ReDoS) sem correção publicada no npm.
 * Para CSV a biblioteca é desnecessária.
 *
 * Mantém o comportamento que o parser antigo dava com `raw:false` +
 * `blankrows:false`: cada célula é TEXTO puro (zeros à esquerda de agência e
 * código de banco preservados, `Valor` nunca vira float) e linha totalmente
 * vazia é descartada. Trata aspas com vírgula, quebra de linha e `""` dentro
 * do campo — o arquivo real do parceiro usa aspas.
 *
 * NOTA: o `XLSX.read` de `lib/adiantamento-transfeera-xlsx.js` continua e deve
 * continuar — ali o servidor relê a planilha que ele mesmo acabou de gerar,
 * para conferir integridade; nenhum byte de terceiro chega lá.
 */
function dividirCsvRfc4180(texto, maxLinhas) {
  const s = String(texto ?? '').replace(/^﻿/, '');
  const linhas = [];
  let linha = [];
  let campo = '';
  let emAspas = false;

  const fecharLinha = () => {
    linha.push(campo);
    campo = '';
    const vazia = linha.every((c) => c === '');
    linha = vazia ? [] : linha;
    if (!vazia) {
      linhas.push(linha);
      linha = [];
      if (linhas.length > maxLinhas) {
        throw new RetornoTransfeeraParseError(
          `Arquivo com mais de ${maxLinhas} linhas`, 'ARQUIVO_MUITO_GRANDE',
        );
      }
    }
  };

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (emAspas) {
      if (c === '"') {
        if (s[i + 1] === '"') { campo += '"'; i += 1; } else { emAspas = false; }
      } else {
        campo += c;
      }
    } else if (c === '"') {
      emAspas = true;
    } else if (c === ',') {
      linha.push(campo);
      campo = '';
    } else if (c === '\n') {
      fecharLinha();
    } else if (c !== '\r') {
      campo += c;
    }
  }
  if (campo !== '' || linha.length > 0) fecharLinha();

  return linhas;
}

/** Lê o CSV (texto já decodificado, BOM incluso ou não) e devolve as linhas
 * normalizadas (9.1.1). Lança `RetornoTransfeeraParseError` se o cabeçalho
 * não bater com o contrato observado — a conferência acontece ANTES de
 * qualquer normalização de linha. */
function lerCsv(texto) {
  const linhas = dividirCsvRfc4180(texto, MAX_LINHAS_RETORNO);
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

/** Remove linhas repetidas do MESMO `ID de integração` e recusa o arquivo
 * quando as repetições não dizem a mesma coisa.
 *
 * Sem isso, duas linhas `ADV-<id>` entravam as duas em `aplicaveis`: como a
 * `situacao` comparada no laço é a do snapshot em memória (que não muda
 * dentro do laço), nenhuma das duas era vista como `JA_APLICADO`. Rio
 * abaixo, a RPC aplica as falhas antes de marcar "o que sobrou" como pago,
 * então uma `Devolvida` duplicando uma `Finalizada` vencia em qualquer
 * ordem — o adiantamento pago pela Transfeera ficava FALHOU em silêncio.
 *
 * Repetições idênticas (mesmo status, valor e motivo) são só ruído do
 * arquivo: deduplica. Repetições que divergem em qualquer um desses campos
 * são ambíguas e NUNCA são resolvidas por escolha nossa — o arquivo inteiro
 * é recusado com `LINHA_DUPLICADA`. Linhas sem id no padrão `ADV-<id>`
 * passam intactas (várias em branco são normais; todas viram
 * `ID_INTEGRACAO_INVALIDO`). */
function deduplicarPorIdIntegracao(linhas) {
  const assinaturaPorId = new Map();
  const unicas = [];
  for (const linha of linhas) {
    if (extrairIdSolicitacao(linha.idIntegracao) === null) {
      unicas.push(linha);
      continue;
    }
    const assinatura = `${linha.status}|${linha.valorCentavos}|${motivoLiteral(linha)}`;
    const anterior = assinaturaPorId.get(linha.idIntegracao);
    if (anterior === undefined) {
      assinaturaPorId.set(linha.idIntegracao, assinatura);
      unicas.push(linha);
      continue;
    }
    if (anterior !== assinatura) {
      throw new RetornoTransfeeraParseError(
        `Linha duplicada com conteúdo conflitante para ${linha.idIntegracao}`, 'LINHA_DUPLICADA'
      );
    }
  }
  return unicas;
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

  // Lança `RetornoTransfeeraParseError('LINHA_DUPLICADA')` — ver acima.
  for (const linha of deduplicarPorIdIntegracao(linhasNormalizadas)) {
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

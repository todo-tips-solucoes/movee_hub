/**
 * adiantamento-retorno-transfeera.js — helpers PUROS (sem I/O de rede) do
 * importador de retorno da Transfeera (tasks.md FASE 9; retorno-transfeera-xlsx).
 *
 * O retorno é um XLSX de 21 colunas (a Transfeera deixou de entregar o CSV de
 * 23 colunas). Casamento é SEMPRE por `ID integração` (padrão `<PREFIXO>-<id>`
 * do nosso exportador; prefixo `ADV` = adiantamento, default, via
 * `formatarSequencial` em lib/adiantamento-dto.js; `REP` = repasse — o chamador
 * passa `{ prefixo }`) — nunca por nome ou valor (decisão do operador, risco de
 * marcar o adiantamento de outra pessoa). Nenhuma coluna é inventada: o `motivo`
 * de uma devolução é sempre o texto LITERAL da coluna `Motivo` — sem tabela de
 * tradução.
 *
 * Ref: spec docs/specs/retorno-transfeera-xlsx; tasks.md §FASE 9 (contrato
 * observado no arquivo do operador, 2026-09-18, dec-129).
 */

'use strict';

const { lerPlanilha } = require('./xlsx-import-core');
const { paraCentavos } = require('./adiantamento-remanescente');

/** Mime do corpo da rota de retorno — constante ÚNICA (as duas rotas importam). */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Teto de linhas do arquivo de retorno (revisão de segurança 2026-09-18).
 * Um lote vai a `LOTE_LIMITE_IDS` = 5000 itens; o dobro cobre reenvio e
 * concatenação de exports do mesmo período com folga, e impede que um arquivo
 * adulterado faça o processo montar estrutura arbitrariamente grande antes de
 * qualquer validação de negócio. Dimensionado junto com o `express.raw({
 * limit })` da rota `POST /lotes/:id/retorno`. */
const MAX_LINHAS_RETORNO = 10000;

/** As 21 colunas do XLSX, na ordem do arquivo real (fixture
 * `tests/fixtures/retorno-transfeera-21col-exemplo.xlsx`). Só 4 são lidas:
 * `ID integração`, `Status`, `Valor` e `Motivo` — o resto existe para provar
 * que o arquivo é este e não outro. */
const CABECALHO_ESPERADO = [
  'Valor', 'Favorecido', 'Comprovante Transfeera', 'Comprovante Banco', 'Status', 'ID integração',
  'Motivo', 'CPF ou CNPJ', 'Email', 'Banco', 'Agência', 'Conta', 'Dígito da conta',
  'Tipo de Conta (Corrente ou Poupança)', 'Nome do lote', 'Data transferido', 'Banco de saída',
  'Data de agendamento', 'Tentativas de pagamento', 'Tipo da chave PIX', 'Chave PIX',
];
const COL = Object.fromEntries(['ID integração', 'Status', 'Valor', 'Motivo'].map((n) => [n, CABECALHO_ESPERADO.indexOf(n)]));

/** Rótulos de `Status` medidos: `FINALIZADO` (XLSX), `Finalizada`/`Devolvida`
 * (CSV da mesma fornecedora). Nenhum outro é adivinhado. */
const STATUS_CONHECIDOS = new Set(['FINALIZADO', 'Finalizada', 'Devolvida']);
const PREFIXO_PADRAO = 'ADV';

/** Regex `^<PREFIXO>-(\d+)$`. O prefixo nunca vem de input de cliente, mas um
 * malformado falha alto (TypeError) em vez de casar errado ou injetar regex. */
const REGEX_POR_PREFIXO = new Map();

function regexIdIntegracao(prefixo) {
  if (typeof prefixo !== 'string' || !/^[A-Z]{2,8}$/.test(prefixo)) {
    throw new TypeError(`prefixo de ID de integração inválido: ${String(prefixo)}`);
  }
  // Memoizado: esta função roda 2x por linha do retorno e um lote vai a 5000
  // linhas — sem o cache seriam 10 mil `new RegExp` por importação de retorno.
  // O Map tem no máximo um punhado de entradas (os prefixos são constantes do
  // nosso próprio exportador), então não cresce sem limite.
  let re = REGEX_POR_PREFIXO.get(prefixo);
  if (!re) {
    re = new RegExp(`^${prefixo}-(\\d+)$`);
    REGEX_POR_PREFIXO.set(prefixo, re);
  }
  return re;
}

class RetornoTransfeeraParseError extends Error {
  constructor(message, motivo) {
    super(message);
    this.name = 'RetornoTransfeeraParseError';
    this.motivo = motivo;
  }
}

const parseErro = (motivo, msg) => new RetornoTransfeeraParseError(msg || motivo, motivo);

/** Lê o XLSX do retorno (primeira aba) e devolve as linhas normalizadas.
 * Lança `RetornoTransfeeraParseError` — o cabeçalho (21 colunas, nome e ordem)
 * é conferido ANTES de interpretar qualquer linha. Ordem barato -> caro: só um
 * ZIP dentro dos tetos chega ao `XLSX.read`, que assim nunca "fareja" CSV/HTML/
 * XML de terceiro (a razão do leitor CSV próprio de 2026-09-18). Nada é
 * executado: sem fórmula, sem HTML, sem estilos; célula é sempre `String(v)`. */
function lerXlsx(buffer) {
  const { linhas } = lerPlanilha(buffer, {
    cabecalhoEsperado: CABECALHO_ESPERADO, maxLinhas: MAX_LINHAS_RETORNO, erro: parseErro,
  });
  return linhas.map(normalizarLinha);
}

/** Posicional: a coluna existe pelo cabeçalho, nunca pelo conteúdo da linha
 * (célula vazia no meio não desloca as seguintes — `defval:''` a preenche). */
function normalizarLinha(linha) {
  const cel = (i) => (linha[i] !== undefined && linha[i] !== null ? String(linha[i]).trim() : '');
  const status = cel(COL.Status);
  const valorTexto = cel(COL.Valor);
  return {
    idIntegracao: cel(COL['ID integração']),
    status,
    statusConhecido: STATUS_CONHECIDOS.has(status),
    valorCentavos: valorTexto !== '' ? paraCentavos(valorTexto) : null,
    // Milhar sem decimais ("1.234"): `paraCentavos` lê 1,23, o BR leria 1.234,00 —
    // erro de 1000x. Validado AQUI (borda), nunca em `paraCentavos`: ela é
    // compartilhada com o remanescente do adiantamento, onde "1.234" pode ser 1,234.
    valorAmbiguoTexto: /^-?\d{1,3}(?:\.\d{3})+$/.test(valorTexto) ? valorTexto : null,
    motivoFalha: cel(COL.Motivo),
  };
}

/** Rótulo seguro de um `Status` desconhecido (FR-014): só letras, dígitos, espaço
 * e `._-`, no máximo 40 caracteres. O valor vem de terceiro e aparece numa lista
 * curta na tela (`rotuloIgnorada`). */
const rotuloStatus = (s) => String(s).replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40);

/** `ADV-000123` -> `123` (com `{ prefixo: 'REP' }`, `REP-000123` -> `123`);
 * `null` se não casa o padrão do nosso exportador para o prefixo (default
 * `ADV`; vazio, texto livre ou qualquer outro formato). */
function extrairIdSolicitacao(idIntegracao, { prefixo = PREFIXO_PADRAO } = {}) {
  const m = regexIdIntegracao(prefixo).exec(String(idIntegracao ?? '').trim());
  return m ? Number(m[1]) : null;
}

/** Motivo literal (nunca inventado/traduzido) de uma linha `Devolvida`:
 * a coluna `Motivo` do próprio arquivo; se vier vazia, o próprio status;
 * nunca uma string fixa fabricada por nós. */
function motivoLiteral(linha) {
  return linha.motivoFalha || linha.status;
}

/** Remove linhas repetidas do MESMO `ID de integração` e recusa o arquivo
 * quando as repetições não dizem a mesma coisa.
 *
 * Sem isso, duas linhas `<PREFIXO>-<id>` entravam as duas em `aplicaveis`: como a
 * `situacao` comparada no laço é a do snapshot em memória (que não muda
 * dentro do laço), nenhuma das duas era vista como `JA_APLICADO`. Rio
 * abaixo, a RPC aplica as falhas antes de marcar "o que sobrou" como pago,
 * então uma `Devolvida` duplicando uma `Finalizada` vencia em qualquer
 * ordem — o adiantamento pago pela Transfeera ficava FALHOU em silêncio.
 *
 * Repetições idênticas (mesmo status, valor e motivo) são só ruído do
 * arquivo: deduplica. Repetições que divergem em qualquer um desses campos
 * são ambíguas e NUNCA são resolvidas por escolha nossa — o arquivo inteiro
 * é recusado com `LINHA_DUPLICADA`. Linhas sem id no padrão `<PREFIXO>-<id>`
 * passam intactas (várias em branco são normais; todas viram
 * `ID_INTEGRACAO_INVALIDO`). */
function deduplicarPorIdIntegracao(linhas, opcoes) {
  const assinaturaPorId = new Map();
  const unicas = [];
  for (const linha of linhas) {
    if (extrairIdSolicitacao(linha.idIntegracao, opcoes) === null) {
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
 * Casa as linhas normalizadas do XLSX com os itens de UM lote (9.1.2).
 * `itensLote`: [{solicitacaoId, colIdIntegracao, situacao, valorCentavos}]
 * (situacao ∈ AdiantamentoLoteItem.situacao).
 * `opcoes.prefixo` (default `'ADV'`; `'REP'` para lotes de repasse) define o
 * padrão `<PREFIXO>-<id>` aceito no `ID de integração`.
 *
 * Devolve:
 *  - `aplicaveis`: linhas que podem ser aplicadas — `{solicitacaoId, status, motivo}`
 *    (`motivo` só preenchido quando `status==='Devolvida'`)
 *  - `ignoradas`: `{idIntegracao, motivo}` — nunca aplicadas; motivos:
 *    `ID_INTEGRACAO_INVALIDO` (vazio/texto livre/fora do padrão <PREFIXO>-<id>),
 *    `NAO_PERTENCE_AO_LOTE` (id válido mas não é item deste lote),
 *    `JA_APLICADO` (item já saiu de `incluido` — idempotência, 9.1.5),
 *    `STATUS_DESCONHECIDO:<valor>` (nem FINALIZADO/Finalizada nem Devolvida — nunca
 *    adivinha, 9.1 nota),
 *    `VALOR_AMBIGUO:<texto>` (célula `1.234`, ponto de milhar sem decimais: pode ser
 *    R$ 1.234,00 ou 1,23 — o sistema não adivinha; falha fechada com diagnóstico próprio),
 *    `VALOR_DIVERGENTE` (valor da linha ≠ valor do item — nunca casa por
 *    valor, mas confere como sanidade antes de aplicar por id)
 *  - `faltantes`: `solicitacaoId[]` — itens `incluido` do lote sem NENHUMA
 *    linha aplicável no arquivo (arquivo incompleto para este lote); quem
 *    chama NÃO deve aplicar parcialmente enquanto houver faltante (a RPC de
 *    confirmação marca "tudo que não é falha" como pago — aplicar com
 *    faltantes marcaria item sem retorno como pago por omissão)
 */
function casarComItensDoLote(linhasNormalizadas, itensLote, { prefixo = PREFIXO_PADRAO } = {}) {
  const opcoes = { prefixo };
  const porIdIntegracao = new Map(itensLote.map((it) => [it.colIdIntegracao, it]));
  const aplicaveis = [];
  const ignoradas = [];

  // Lança `RetornoTransfeeraParseError('LINHA_DUPLICADA')` — ver acima.
  for (const linha of deduplicarPorIdIntegracao(linhasNormalizadas, opcoes)) {
    const idSolicitacao = extrairIdSolicitacao(linha.idIntegracao, opcoes);
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
      ignoradas.push({ idIntegracao: linha.idIntegracao, motivo: `STATUS_DESCONHECIDO:${rotuloStatus(linha.status)}` });
      continue;
    }
    if (linha.valorAmbiguoTexto) {
      ignoradas.push({ idIntegracao: linha.idIntegracao, motivo: `VALOR_AMBIGUO:${rotuloStatus(linha.valorAmbiguoTexto)}` });
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
  XLSX_MIME,
  lerXlsx,
  extrairIdSolicitacao,
  casarComItensDoLote,
};

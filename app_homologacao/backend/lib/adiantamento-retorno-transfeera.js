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

const XLSX = require('xlsx');
const { paraCentavos } = require('./adiantamento-remanescente');

/** Mime do corpo da rota de retorno — constante ÚNICA (as duas rotas importam). */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Tetos do ZIP, conferidos no diretório central ANTES de o SheetJS tocar nos
 * bytes: deflate chega a ~1000:1, então 10 MB comprimidos podem ser GB. 32 MiB
 * = 4x o pior caso legítimo (10.000 linhas sem compressão ≈ 8,2 MB). */
const MAX_BYTES_DESCOMPRIMIDOS = 32 * 1024 * 1024;
const MAX_ENTRADAS_ZIP = 100;

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

/** Confere o diretório central do ZIP (EOCD nos últimos 65.557 bytes) SEM
 * descomprimir nada: soma os tamanhos *declarados* e recusa bomba de
 * descompressão antes de o SheetJS tocar nos bytes. ZIP64 e EOCD ausente são
 * `FORMATO_INVALIDO` (um retorno de ~1 MB nunca precisa de ZIP64). */
function conferirTetoZip(buf) {
  const SIG_EOCD = 0x06054b50;
  const SIG_CENTRAL = 0x02014b50;
  const inicio = Math.max(0, buf.length - 65557);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < inicio || eocd + 22 > buf.length || buf.readUInt32LE(eocd) !== SIG_EOCD) {
    throw parseErro('FORMATO_INVALIDO', 'ZIP sem diretório central');
  }
  const entradas = buf.readUInt16LE(eocd + 10);
  const tamanhoDir = buf.readUInt32LE(eocd + 12);
  const offsetDir = buf.readUInt32LE(eocd + 16);
  if (entradas === 0xffff || tamanhoDir === 0xffffffff || offsetDir === 0xffffffff) {
    throw parseErro('FORMATO_INVALIDO', 'ZIP64 não suportado');
  }
  if (entradas > MAX_ENTRADAS_ZIP) throw parseErro('ARQUIVO_MUITO_GRANDE', 'Entradas demais no ZIP');
  if (offsetDir + tamanhoDir > eocd) throw parseErro('FORMATO_INVALIDO', 'Diretório central fora do arquivo');

  let pos = offsetDir;
  let total = 0;
  for (let i = 0; i < entradas; i += 1) {
    if (pos + 46 > eocd || buf.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw parseErro('FORMATO_INVALIDO', 'Entrada de ZIP corrompida');
    }
    const tamanho = buf.readUInt32LE(pos + 24);
    if (tamanho === 0xffffffff) throw parseErro('FORMATO_INVALIDO', 'ZIP64 não suportado');
    total += tamanho;
    if (total > MAX_BYTES_DESCOMPRIMIDOS) throw parseErro('ARQUIVO_MUITO_GRANDE', 'Conteúdo descomprimido acima do teto');
    pos += 46 + buf.readUInt16LE(pos + 28) + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
  }
}

/** Lê o XLSX do retorno (primeira aba) e devolve as linhas normalizadas.
 * Lança `RetornoTransfeeraParseError` — o cabeçalho (21 colunas, nome e ordem)
 * é conferido ANTES de interpretar qualquer linha. Ordem barato -> caro: só um
 * ZIP dentro dos tetos chega ao `XLSX.read`, que assim nunca "fareja" CSV/HTML/
 * XML de terceiro (a razão do leitor CSV próprio de 2026-09-18). Nada é
 * executado: sem fórmula, sem HTML, sem estilos; célula é sempre `String(v)`. */
function lerXlsx(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw parseErro('FORMATO_INVALIDO', 'Corpo vazio');
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw parseErro('FORMATO_INVALIDO', 'Não é um ZIP');
  conferirTetoZip(buffer);

  let wb;
  try {
    wb = XLSX.read(buffer, {
      type: 'buffer', sheetRows: MAX_LINHAS_RETORNO + 2, cellFormula: false, cellHTML: false, cellStyles: false, cellDates: false, bookDeps: false, bookProps: false,
    });
  } catch {
    // A mensagem do SheetJS pode ecoar conteúdo de terceiro: nunca propagar.
    throw parseErro('FORMATO_INVALIDO', 'Planilha ilegível');
  }
  const ws = wb.SheetNames && wb.SheetNames.length ? wb.Sheets[wb.SheetNames[0]] : null;
  if (!ws) throw parseErro('FORMATO_INVALIDO', 'Planilha sem aba');

  // `sheetRows` corta a leitura; `!fullref` guarda o tamanho REAL (cobre linhas
  // em branco que empurram dados para além do corte).
  const ref = ws['!fullref'] || ws['!ref'];
  if (ref && XLSX.utils.decode_range(ref).e.r > MAX_LINHAS_RETORNO) {
    throw parseErro('ARQUIVO_MUITO_GRANDE', `Arquivo com mais de ${MAX_LINHAS_RETORNO} linhas`);
  }

  // `blankrows:false` não descarta linha de células "" (o `defval` as conta como
  // preenchidas), então a linha em branco é filtrada aqui, depois da leitura.
  const linhas = XLSX.utils.sheet_to_json(ws, {
    header: 1, raw: true, defval: '', blankrows: false,
  }).filter((l) => l.some((c) => String(c).trim() !== ''));
  if (!linhas.length) throw parseErro('ARQUIVO_VAZIO', 'Planilha vazia');

  const cabecalho = linhas[0].map((c) => String(c).trim());
  if (JSON.stringify(cabecalho) !== JSON.stringify(CABECALHO_ESPERADO)) {
    throw parseErro('CABECALHO_INVALIDO', 'Cabeçalho não confere com o contrato observado');
  }
  if (linhas.length === 1) throw parseErro('ARQUIVO_VAZIO', 'Planilha só com cabeçalho');

  return linhas.slice(1).map(normalizarLinha);
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

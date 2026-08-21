/**
 * hub-import-parser.js — leitura/streaming/seleção por tipo (tasks.md FASE 2,
 * 2.1). Ref: research.md Decision 3; plan.md §Plano por fases item 2;
 * briefing s4-pipeline-importacoes.md.
 *
 * Responsabilidades desta camada (deliberadamente SEM regra de negócio —
 * isso é `hub-import-normalizer.js`):
 *   - strip do BOM UTF-8 inicial (2.1.1)
 *   - split de linha por `;` (2.1.1)
 *   - iteração por streaming linha-a-linha (2.1.2)
 *   - seleção de dialeto por `tipo` vindo do multipart, SEM sniffing (2.1.3)
 *   - extração seguro de ZIP de 1 entrada (2.1.4, delega a hub-import-zip.js)
 *
 * Nota sobre "streaming" e ZIP: a extração de ZIP (2.1.4) exige acesso ao
 * Central Directory, que fica no FIM do arquivo — isso é inerente ao formato
 * ZIP (não há como ler o diretório central sem ter o arquivo completo à
 * disposição para acesso aleatório) e não é uma escolha de implementação.
 * Por isso `resolverConteudoCsv` recebe um Buffer já completo quando a
 * origem é `.zip`. O requisito de streaming (2.1.2 — "sem carregar arquivo
 * inteiro em memória") vale para a fase SEGUINTE, mais cara: o parse
 * linha-a-linha do CSV (potencialmente milhares de linhas) NUNCA materializa
 * o conteúdo inteiro como uma única string via `.split('\n')` — usa
 * `readline` sobre um Readable stream, processando conforme os chunks
 * chegam (ver `iterarLinhas`).
 */

'use strict';

const readline = require('readline');
const { Readable } = require('stream');
const {
  extractSingleEntryZip,
  extractSingleEntryZipAsync,
  inspecionarEntrada,
  HubImportZipError,
} = require('./hub-import-zip');

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_UTF8_CHAR = '﻿';
const DELIMITADOR = ';';
const MAX_ZIP_DESCOMPRIMIDO_BYTES = 100 * 1024 * 1024;
const TIPOS_SUPORTADOS = ['faturamento', 'performance'];

class HubImportParseError extends Error {
  constructor(message, motivo) {
    super(message);
    this.name = 'HubImportParseError';
    this.motivo = motivo;
  }
}

/** Remove o BOM UTF-8 inicial de um Buffer ou string (2.1.1). Idempotente. */
function stripBom(entrada) {
  if (Buffer.isBuffer(entrada)) {
    if (entrada.length >= 3 && entrada.subarray(0, 3).equals(BOM_UTF8)) {
      return entrada.subarray(3);
    }
    return entrada;
  }
  if (typeof entrada === 'string' && entrada.charCodeAt(0) === 0xfeff) {
    return entrada.slice(1);
  }
  return entrada;
}

/** Remove aspas ENVOLVENTES de 1 campo já splitado. O dialeto real da
 * plataforma parceira representa campo vazio como `""` (aspas literais) —
 * sem este passo, `""` chega ao normalizer como string de 2 chars e, no
 * `id_da_pessoa_entregadora`, falha como "UUID inválido" quando o vazio
 * legítimo (recebedor agregado, ex.: franquia) não é erro. Aspas internas
 * escapadas RFC 4180 (`""` -> `"`) também são resolvidas. */
function desasparCampo(campo) {
  if (campo.length >= 2 && campo[0] === '"' && campo[campo.length - 1] === '"') {
    return campo.slice(1, -1).replace(/""/g, '"');
  }
  return campo;
}

/** Split de uma linha CSV pelo delimitador `;` (2.1.1) + desaspagem por
 * campo. Sem parsing de aspas complexo (delimitador DENTRO de aspas não
 * existe no dialeto real — plano técnico §7.1); o que existe de fato são
 * campos vazios quotados `""`, tratados por `desasparCampo`. */
function splitLinhaCsv(linha, delimitador = DELIMITADOR) {
  if (linha === '' || linha === undefined || linha === null) return [];
  // Remove eventual \r residual (arquivos podem ter CRLF que o readline já
  // trata, mas defesa em profundidade contra CR solto no meio do buffer).
  const semCr = linha.endsWith('\r') ? linha.slice(0, -1) : linha;
  return semCr.split(delimitador).map(desasparCampo);
}

function ehZip(nomeArquivo) {
  return typeof nomeArquivo === 'string' && /\.zip$/i.test(nomeArquivo.trim());
}

/**
 * Resolve o Buffer do CSV a processar (2.1.3 + 2.1.4): se `nomeArquivo`
 * indicar `.zip`, extrai a entrada única com segurança; senão assume que o
 * próprio buffer já é o CSV.
 */
function resolverConteudoCsv(buffer, { nomeArquivo, maxZipDescomprimidoBytes = MAX_ZIP_DESCOMPRIMIDO_BYTES } = {}) {
  if (!ehZip(nomeArquivo)) {
    return buffer;
  }
  try {
    const { conteudo } = extractSingleEntryZip(buffer, {
      maxUncompressedBytes: maxZipDescomprimidoBytes,
    });
    return conteudo;
  } catch (err) {
    if (err instanceof HubImportZipError) {
      throw new HubImportParseError(err.message, err.motivo);
    }
    throw err;
  }
}

/**
 * F2 (pós-review PR #57) — versão ASSÍNCRONA de `resolverConteudoCsv`: a
 * descompressão do ZIP (única parte cara de CPU) roda via
 * `zlib.inflateRaw` promisificado em vez de `inflateRawSync`, não
 * bloqueando o event loop. Usada pelo processor (fire-and-forget, fora do
 * ciclo de request/response); a rota de upload usa `validarZipLeve`
 * (abaixo), que nem chega a inflar.
 * @returns {Promise<Buffer>}
 */
async function resolverConteudoCsvAsync(buffer, { nomeArquivo, maxZipDescomprimidoBytes = MAX_ZIP_DESCOMPRIMIDO_BYTES } = {}) {
  if (!ehZip(nomeArquivo)) {
    return buffer;
  }
  try {
    const { conteudo } = await extractSingleEntryZipAsync(buffer, {
      maxUncompressedBytes: maxZipDescomprimidoBytes,
    });
    return conteudo;
  } catch (err) {
    if (err instanceof HubImportZipError) {
      throw new HubImportParseError(err.message, err.motivo);
    }
    throw err;
  }
}

/**
 * F2 (pós-review PR #57) — validação BARATA de upload: se `nomeArquivo` for
 * `.zip`, confirma que tem EXATAMENTE 1 entrada, nome seguro (sem path
 * traversal) e tamanho DECLARADO dentro do limite — tudo via
 * `inspecionarEntrada` (hub-import-zip.js), que NUNCA chama `zlib.inflate*`
 * (o inflate de até 100MB fica só para o processor, fora do ciclo de
 * request). Se não for `.zip`, no-op (CSV puro não tem custo de
 * descompressão a evitar). Lança `HubImportParseError` na mesma taxonomia
 * de motivos que `resolverConteudoCsv` (o caller/rota não precisa
 * distinguir).
 * @returns {void}
 * @throws {HubImportParseError}
 */
function validarZipLeve(buffer, { nomeArquivo, maxZipDescomprimidoBytes = MAX_ZIP_DESCOMPRIMIDO_BYTES } = {}) {
  if (!ehZip(nomeArquivo)) return;
  try {
    inspecionarEntrada(buffer, { maxUncompressedBytes: maxZipDescomprimidoBytes });
  } catch (err) {
    if (err instanceof HubImportZipError) {
      throw new HubImportParseError(err.message, err.motivo);
    }
    throw err;
  }
}

/**
 * Itera linhas de um Readable stream (2.1.2 — streaming linha-a-linha).
 * Usa `readline` sobre o stream: cada linha é processada assim que chega,
 * SEM buffer intermediário do conteúdo inteiro. O BOM (se presente) é
 * removido só da primeira linha.
 *
 * @returns {AsyncGenerator<{numeroLinha: number, bruta: string, campos: string[]}>}
 */
async function* iterarLinhas(stream, { delimitador = DELIMITADOR } = {}) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let numeroLinha = 0;
  let primeira = true;
  for await (const linhaBruta of rl) {
    numeroLinha += 1;
    let linha = linhaBruta;
    if (primeira) {
      linha = stripBom(linha);
      primeira = false;
    }
    if (linha === '') continue; // linha vazia (ex.: última linha do arquivo)
    yield { numeroLinha, bruta: linha, campos: splitLinhaCsv(linha, delimitador) };
  }
}

/**
 * Envolve um Buffer/string já em memória (ex.: pós-extração de ZIP) num
 * Readable, para reusar `iterarLinhas`. NÃO faz streaming real neste ponto
 * (o conteúdo já está inteiro em memória — ver nota de topo do arquivo);
 * emite como um único chunk, deixando o `readline` fazer o parse
 * linha-a-linha de forma incremental a partir daí.
 */
function bufferParaStream(buffer) {
  const chunk = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer), 'utf8');
  return Readable.from([chunk]);
}

function validarTipo(tipo) {
  if (!TIPOS_SUPORTADOS.includes(tipo)) {
    throw new HubImportParseError(`Tipo de importação desconhecido: ${JSON.stringify(tipo)}`, 'tipo_invalido');
  }
  return tipo;
}

module.exports = {
  HubImportParseError,
  stripBom,
  splitLinhaCsv,
  resolverConteudoCsv,
  resolverConteudoCsvAsync,
  validarZipLeve,
  iterarLinhas,
  bufferParaStream,
  validarTipo,
  ehZip,
  TIPOS_SUPORTADOS,
  MAX_ZIP_DESCOMPRIMIDO_BYTES,
  DELIMITADOR,
  BOM_UTF8_CHAR,
};

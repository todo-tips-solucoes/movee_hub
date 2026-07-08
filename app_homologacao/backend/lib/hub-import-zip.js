/**
 * hub-import-zip.js — extração segura de ZIP de exatamente 1 entrada
 * (tasks.md 2.1.4, research.md Decision 3, briefing s4 §Escopo "ZIP seguro").
 *
 * Implementação PRÓPRIA (sem dependência nova): o backend do hub roda 100%
 * via PostgREST/HTTP (research.md Decision 5 ADENDO — sem `pg` direto, sem
 * superfície de conexão nova); adicionar uma lib de terceiros só para ler ZIP
 * (`adm-zip`/`yauzl`/etc.) introduziria uma dependência de supply-chain nova
 * para um formato simples e bem documentado. `zlib` (core do Node, sempre
 * presente) já expõe `inflateRawSync`, suficiente para o método DEFLATE — o
 * único usado pelos ZIPs reais da plataforma parceira (Decision 3, análise
 * §7.1 do plano técnico). Parsing manual do End-Of-Central-Directory +
 * Central Directory + Local File Header (formato PKZIP público, estável há
 * décadas).
 *
 * Defesas aplicadas (blast-radius / LGPD — CLAUDE.md, briefing §Regras):
 *   - EXATAMENTE 1 entrada (rejeita 0 ou >1) — nunca processa arquivos extras
 *     escondidos num ZIP.
 *   - path traversal: nome da entrada nunca é usado como path de disco (nem
 *     aqui, nem no chamador) — mas ainda assim validamos e rejeitamos nomes
 *     com `..`, path absoluto ou driveletter, como defesa em profundidade.
 *   - tamanho descomprimido: verificado ANTES de descomprimir (campo do
 *     Central Directory) E durante a descompressão via `maxOutputLength`
 *     (protege contra cabeçalho forjado que mentiria sobre o tamanho real —
 *     "zip bomb").
 *
 * ── F2 (pós-review PR #57) — inspeção BARATA separada da materialização
 * PESADA ──────────────────────────────────────────────────────────────────
 * `inspecionarEntrada` faz TODA a validação estrutural (EOCD, contagem de
 * entradas, path traversal, tamanho DECLARADO) sem nunca chamar
 * `zlib.inflate*` — é só leitura de campos de tamanho fixo do buffer
 * (O(1), independente do tamanho do arquivo). `materializarSync`/
 * `materializarAsync` fazem a descompressão de fato (a única operação cara
 * de CPU aqui) — a versão async usa `zlib.inflateRaw` via `promisify` para
 * não travar o event loop com um ZIP de ~100MB numa thread de request HTTP.
 * `routes/hub-importacoes.js` (validação do upload, precisa responder 201
 * rápido) usa só `inspecionarEntrada`; `lib/hub-import-processor.js`
 * (fire-and-forget, já fora do request/response cycle) usa
 * `extractSingleEntryZipAsync` (inspeciona + materializa async).
 * `extractSingleEntryZip` (síncrono) é mantido só por compatibilidade com
 * quem já dependia dele (mantém a API antiga intacta).
 */

'use strict';

const zlib = require('zlib');
const { promisify } = require('node:util');

const inflateRawAsync = promisify(zlib.inflateRaw);

class HubImportZipError extends Error {
  constructor(message, motivo) {
    super(message);
    this.name = 'HubImportZipError';
    this.motivo = motivo;
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const EOCD_MAX_COMMENT = 65535;
const COMPRESSAO_STORE = 0;
const COMPRESSAO_DEFLATE = 8;

/** Busca o registro EOCD a partir do fim do buffer (comentário de tamanho variável). */
function localizarEocd(buffer) {
  if (buffer.length < EOCD_MIN_SIZE) return -1;
  const inicio = Math.max(0, buffer.length - EOCD_MIN_SIZE - EOCD_MAX_COMMENT);
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= inicio; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      return i;
    }
  }
  return -1;
}

/** Rejeita nomes de entrada que tentem escapar do diretório de destino. */
function nomeEhSeguro(nome) {
  if (!nome || typeof nome !== 'string') return false;
  if (nome.includes('\0')) return false;
  const normalizado = nome.replace(/\\/g, '/');
  if (normalizado.startsWith('/') || /^[A-Za-z]:/.test(normalizado)) return false;
  const partes = normalizado.split('/');
  if (partes.some((p) => p === '..')) return false;
  if (normalizado.trim() === '') return false;
  return true;
}

/**
 * F2 — inspeção BARATA (sem inflar): valida EOCD, contagem de entradas,
 * path traversal e tamanho DECLARADO; devolve tudo que a materialização
 * precisa para descomprimir depois, sem nunca ter chamado zlib. O(1) em
 * relação ao tamanho real do conteúdo comprimido (só lê campos fixos +
 * calcula um subarray, que é uma VIEW sobre o buffer original, não uma
 * cópia).
 * @param {Buffer} buffer - conteúdo bruto do arquivo .zip
 * @param {{maxUncompressedBytes?: number}} options
 * @returns {{nome: string, metodoCompressao: number, dadosComprimidos: Buffer, tamanhoDescomprimidoDeclarado: number, maxUncompressedBytes: number}}
 */
function inspecionarEntrada(buffer, options = {}) {
  const maxUncompressedBytes = options.maxUncompressedBytes || 100 * 1024 * 1024;

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new HubImportZipError('ZIP vazio ou inválido', 'zip_invalido');
  }

  const eocdOffset = localizarEocd(buffer);
  if (eocdOffset === -1) {
    throw new HubImportZipError(
      'ZIP inválido: fim de diretório central (EOCD) não encontrado',
      'zip_invalido'
    );
  }

  const totalEntradas = buffer.readUInt16LE(eocdOffset + 10);
  const tamanhoDiretorioCentral = buffer.readUInt32LE(eocdOffset + 12);
  const offsetDiretorioCentral = buffer.readUInt32LE(eocdOffset + 16);

  if (totalEntradas !== 1) {
    throw new HubImportZipError(
      `ZIP deve conter exatamente 1 entrada (encontradas: ${totalEntradas})`,
      'zip_multiplas_entradas'
    );
  }

  if (
    offsetDiretorioCentral < 0 ||
    offsetDiretorioCentral + tamanhoDiretorioCentral > buffer.length
  ) {
    throw new HubImportZipError('ZIP inválido: diretório central corrompido', 'zip_invalido');
  }

  const pos = offsetDiretorioCentral;
  if (buffer.readUInt32LE(pos) !== CENTRAL_DIR_SIGNATURE) {
    throw new HubImportZipError(
      'ZIP inválido: assinatura de diretório central ausente',
      'zip_invalido'
    );
  }

  const metodoCompressao = buffer.readUInt16LE(pos + 10);
  const tamanhoComprimido = buffer.readUInt32LE(pos + 20);
  const tamanhoDescomprimido = buffer.readUInt32LE(pos + 24);
  const tamanhoNome = buffer.readUInt16LE(pos + 28);
  const offsetHeaderLocal = buffer.readUInt32LE(pos + 42);

  if (pos + 46 + tamanhoNome > buffer.length) {
    throw new HubImportZipError('ZIP inválido: entrada de diretório central corrompida', 'zip_invalido');
  }
  const nomeEntrada = buffer.toString('utf8', pos + 46, pos + 46 + tamanhoNome);

  if (!nomeEhSeguro(nomeEntrada)) {
    throw new HubImportZipError(
      `ZIP contém nome de entrada inseguro: ${JSON.stringify(nomeEntrada)}`,
      'zip_path_traversal'
    );
  }

  // Defesa em profundidade #1 (barata): tamanho DECLARADO no Central
  // Directory > limite -> rejeita SEM nunca ter tentado descomprimir. Um
  // cabeçalho forjado que MENTISSE dizendo um tamanho pequeno ainda é pego
  // depois, na materialização, via `maxOutputLength` (defesa #2).
  if (tamanhoDescomprimido > maxUncompressedBytes) {
    throw new HubImportZipError(
      `ZIP descomprime para ${tamanhoDescomprimido} bytes, acima do limite de ${maxUncompressedBytes} bytes`,
      'zip_tamanho_excedido'
    );
  }

  if (offsetHeaderLocal < 0 || offsetHeaderLocal + 30 > buffer.length) {
    throw new HubImportZipError('ZIP inválido: cabeçalho de arquivo local corrompido', 'zip_invalido');
  }
  if (buffer.readUInt32LE(offsetHeaderLocal) !== LOCAL_FILE_SIGNATURE) {
    throw new HubImportZipError(
      'ZIP inválido: assinatura de arquivo local ausente',
      'zip_invalido'
    );
  }

  const tamanhoNomeLocal = buffer.readUInt16LE(offsetHeaderLocal + 26);
  const tamanhoExtraLocal = buffer.readUInt16LE(offsetHeaderLocal + 28);
  const inicioDados = offsetHeaderLocal + 30 + tamanhoNomeLocal + tamanhoExtraLocal;
  const fimDados = inicioDados + tamanhoComprimido;

  if (fimDados > buffer.length) {
    throw new HubImportZipError(
      'ZIP inválido: dados comprimidos ultrapassam o fim do arquivo',
      'zip_invalido'
    );
  }

  if (metodoCompressao !== COMPRESSAO_STORE && metodoCompressao !== COMPRESSAO_DEFLATE) {
    throw new HubImportZipError(
      `Método de compressão ZIP não suportado: ${metodoCompressao}`,
      'zip_metodo_nao_suportado'
    );
  }

  return {
    nome: nomeEntrada,
    metodoCompressao,
    dadosComprimidos: buffer.subarray(inicioDados, fimDados), // view, sem copiar
    tamanhoDescomprimidoDeclarado: tamanhoDescomprimido,
    maxUncompressedBytes,
  };
}

/** Checagem final pós-descompressão (defesa #2 — protege contra cabeçalho
 * que mentisse um tamanho pequeno; `maxOutputLength` do zlib já teria
 * abortado antes, isto é redundância barata). */
function checarTamanhoFinal(conteudo, maxUncompressedBytes) {
  if (conteudo.length > maxUncompressedBytes) {
    throw new HubImportZipError(
      `ZIP descomprimido (${conteudo.length} bytes) excede o limite de ${maxUncompressedBytes} bytes`,
      'zip_tamanho_excedido'
    );
  }
}

/** Materializa (descomprime) SÍNCRONO — CPU-bound, bloqueia o event loop
 * pelo tempo da descompressão. Usar só fora do ciclo request/response
 * (F2 — ver cabeçalho do arquivo). */
function materializarSync(info) {
  const { metodoCompressao, dadosComprimidos, maxUncompressedBytes } = info;
  let conteudo;
  if (metodoCompressao === COMPRESSAO_STORE) {
    conteudo = Buffer.from(dadosComprimidos);
  } else {
    try {
      conteudo = zlib.inflateRawSync(dadosComprimidos, { maxOutputLength: maxUncompressedBytes });
    } catch (err) {
      throw new HubImportZipError(
        `Falha ao descomprimir ZIP (corrupção ou tamanho além do limite permitido): ${err.message}`,
        'zip_descompressao_falhou'
      );
    }
  }
  checarTamanhoFinal(conteudo, maxUncompressedBytes);
  return conteudo;
}

/** Materializa (descomprime) ASSÍNCRONO (F2) — `zlib.inflateRaw` via
 * `promisify`, NÃO trava o event loop numa thread de request HTTP (a
 * descompressão de fato roda na threadpool do libuv). */
async function materializarAsync(info) {
  const { metodoCompressao, dadosComprimidos, maxUncompressedBytes } = info;
  let conteudo;
  if (metodoCompressao === COMPRESSAO_STORE) {
    conteudo = Buffer.from(dadosComprimidos);
  } else {
    try {
      conteudo = await inflateRawAsync(dadosComprimidos, { maxOutputLength: maxUncompressedBytes });
    } catch (err) {
      throw new HubImportZipError(
        `Falha ao descomprimir ZIP (corrupção ou tamanho além do limite permitido): ${err.message}`,
        'zip_descompressao_falhou'
      );
    }
  }
  checarTamanhoFinal(conteudo, maxUncompressedBytes);
  return conteudo;
}

/**
 * Extrai a única entrada de um ZIP com defesas de tamanho e path traversal
 * (versão SÍNCRONA — mantida por compatibilidade; ver F2 no cabeçalho do
 * arquivo para quando usar cada variante).
 * @param {Buffer} buffer - conteúdo bruto do arquivo .zip
 * @param {{maxUncompressedBytes?: number}} options
 * @returns {{nome: string, conteudo: Buffer}}
 */
function extractSingleEntryZip(buffer, options = {}) {
  const info = inspecionarEntrada(buffer, options);
  return { nome: info.nome, conteudo: materializarSync(info) };
}

/**
 * Extrai a única entrada de um ZIP — versão ASSÍNCRONA (F2). Mesmas defesas
 * de `extractSingleEntryZip`, mas a descompressão não bloqueia o event
 * loop. Usada pelo processor (fire-and-forget, fora do ciclo de request).
 * @param {Buffer} buffer
 * @param {{maxUncompressedBytes?: number}} options
 * @returns {Promise<{nome: string, conteudo: Buffer}>}
 */
async function extractSingleEntryZipAsync(buffer, options = {}) {
  const info = inspecionarEntrada(buffer, options);
  return { nome: info.nome, conteudo: await materializarAsync(info) };
}

module.exports = {
  extractSingleEntryZip,
  extractSingleEntryZipAsync,
  inspecionarEntrada,
  HubImportZipError,
  nomeEhSeguro,
};

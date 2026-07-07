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
 */

'use strict';

const zlib = require('zlib');

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
 * Extrai a única entrada de um ZIP com defesas de tamanho e path traversal.
 * @param {Buffer} buffer - conteúdo bruto do arquivo .zip
 * @param {{maxUncompressedBytes?: number}} options
 * @returns {{nome: string, conteudo: Buffer}}
 */
function extractSingleEntryZip(buffer, options = {}) {
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

  const dadosComprimidos = buffer.subarray(inicioDados, fimDados);
  let conteudo;

  if (metodoCompressao === COMPRESSAO_STORE) {
    conteudo = Buffer.from(dadosComprimidos);
  } else if (metodoCompressao === COMPRESSAO_DEFLATE) {
    try {
      conteudo = zlib.inflateRawSync(dadosComprimidos, {
        maxOutputLength: maxUncompressedBytes,
      });
    } catch (err) {
      throw new HubImportZipError(
        `Falha ao descomprimir ZIP (corrupção ou tamanho além do limite permitido): ${err.message}`,
        'zip_descompressao_falhou'
      );
    }
  } else {
    throw new HubImportZipError(
      `Método de compressão ZIP não suportado: ${metodoCompressao}`,
      'zip_metodo_nao_suportado'
    );
  }

  if (conteudo.length > maxUncompressedBytes) {
    throw new HubImportZipError(
      `ZIP descomprimido (${conteudo.length} bytes) excede o limite de ${maxUncompressedBytes} bytes`,
      'zip_tamanho_excedido'
    );
  }

  return { nome: nomeEntrada, conteudo };
}

module.exports = {
  extractSingleEntryZip,
  HubImportZipError,
  nomeEhSeguro,
};

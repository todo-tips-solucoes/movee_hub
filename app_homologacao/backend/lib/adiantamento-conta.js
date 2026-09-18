/**
 * adiantamento-conta.js — helpers PUROS (sem I/O) de validação e máscara de
 * dados bancários do módulo Adiantamento (tasks.md FASE 2, 2.2).
 *
 * Cross-referência FR-016 x FR-055 (security CHK018, 2.2.6): o MESMO formato
 * de agência (4 dígitos, `normalizarAgencia`) e banco (3 dígitos COMPE,
 * `validarBanco`) validado aqui no envio (FR-016) é o formato gravado na
 * conta e reexportado linha a linha para a Transfeera (FR-055) — não há
 * conversão numérica em nenhum ponto do caminho (`sem Number()` em campo de
 * código: agência, conta, dígito e código do banco trafegam sempre como
 * string, do formulário ao arquivo).
 *
 * Ref: contracts/motorista-api.md §POST conta-bancaria/solicitacoes;
 * Spec §FR-015, §FR-016, §FR-019, §FR-055; data-model.md ContaBancariaMotorista;
 * security CHK009, CHK018.
 */

'use strict';

const bancosFixture = require('./fixtures/bancos-compe.json');

const BANCOS_POR_CODIGO = new Map(bancosFixture.bancos.map((b) => [b.codigo, b]));

const REGEX_DIGITO_CONTA = /^[0-9]$/; // `X` só liberado após V-3 (data-model.md)
const REGEX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REGEX_TELEFONE = /^\d{10,11}$/; // DDD + número, só dígitos (sem +55)
const REGEX_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TIPOS_CHAVE_PIX = ['CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'ALEATORIA'];
const TIPOS_CONTA = ['CORRENTE', 'POUPANCA'];

function somenteDigitos(valor) {
  return String(valor == null ? '' : valor).replace(/\D/g, '');
}

// --- CPF/CNPJ (dígito verificador, 2.2.1) -----------------------------------

function calcularDvCpf(base9) {
  let soma = 0;
  for (let i = 0; i < 9; i += 1) soma += base9[i] * (10 - i);
  const dv1 = soma % 11 < 2 ? 0 : 11 - (soma % 11);
  const base10 = [...base9, dv1];
  soma = 0;
  for (let i = 0; i < 10; i += 1) soma += base10[i] * (11 - i);
  const dv2 = soma % 11 < 2 ? 0 : 11 - (soma % 11);
  return [dv1, dv2];
}

function calcularDvCnpj(base12) {
  const pesos1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let soma = 0;
  for (let i = 0; i < 12; i += 1) soma += base12[i] * pesos1[i];
  const dv1 = soma % 11 < 2 ? 0 : 11 - (soma % 11);
  const base13 = [...base12, dv1];
  const pesos2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  soma = 0;
  for (let i = 0; i < 13; i += 1) soma += base13[i] * pesos2[i];
  const dv2 = soma % 11 < 2 ? 0 : 11 - (soma % 11);
  return [dv1, dv2];
}

/**
 * Valida CPF (11) ou CNPJ (14) por dígito verificador, aceitando entrada
 * mascarada (edge #16). Rejeita sequências de dígito repetido
 * (`00000000000`, `11111111111`, …): a fórmula de DV padrão dá "válido" para
 * elas por construção matemática — checagem adicional universal em toda
 * implementação de referência de CPF/CNPJ, não uma regra fabricada.
 */
function validarDocumento(valorComOuSemMascara) {
  const digitos = somenteDigitos(valorComOuSemMascara);
  if (digitos.length === 11) {
    if (/^(\d)\1{10}$/.test(digitos)) return { valido: false, tipo: 'PF', documento: digitos };
    const base = digitos.slice(0, 9).split('').map(Number);
    const [dv1, dv2] = calcularDvCpf(base);
    return { valido: digitos === `${base.join('')}${dv1}${dv2}`, tipo: 'PF', documento: digitos };
  }
  if (digitos.length === 14) {
    if (/^(\d)\1{13}$/.test(digitos)) return { valido: false, tipo: 'PJ', documento: digitos };
    const base = digitos.slice(0, 12).split('').map(Number);
    const [dv1, dv2] = calcularDvCnpj(base);
    return { valido: digitos === `${base.join('')}${dv1}${dv2}`, tipo: 'PJ', documento: digitos };
  }
  return { valido: false, tipo: null, documento: digitos };
}

// --- Banco / agência / conta (2.2.2, 2.2.3) ---------------------------------

/** Banco pertence à lista oficial COMPE (`lib/fixtures/bancos-compe.json`).
 * `codigo` MUST ser string de 3 dígitos — nunca convertido para número
 * (perderia zero à esquerda, ex.: banco 001). */
function validarBanco(codigo) {
  if (typeof codigo !== 'string' || !/^\d{3}$/.test(codigo)) return { valido: false };
  const banco = BANCOS_POR_CODIGO.get(codigo);
  return banco ? { valido: true, nome: banco.nome } : { valido: false };
}

/** Normaliza agência para 4 dígitos com zero à esquerda (FR-016/FR-055).
 * Entrada: só dígitos, 1 a 4 caracteres — qualquer caractere não-dígito
 * (letra, pontuação) é RECUSADO (`null`), nunca removido em silêncio (2.6.3:
 * `validarConta` já recusa em vez de limpar; agência segue o mesmo padrão).
 * String o tempo todo — nunca `Number()`/`parseInt()`. */
function normalizarAgencia(valor) {
  const str = typeof valor === 'string' ? valor : String(valor ?? '');
  if (!/^\d{1,4}$/.test(str)) return null;
  return str.padStart(4, '0');
}

/** Conta: 1–20 dígitos, zeros preservados byte-a-byte (edge #21). Recusa
 * qualquer caractere não-dígito — sem tentativa de "limpar" a entrada. */
function validarConta(valor) {
  const str = typeof valor === 'string' ? valor : String(valor ?? '');
  return /^\d{1,20}$/.test(str) ? { valido: true, conta: str } : { valido: false };
}

/** Dígito da conta: exatamente 1 caractere `[0-9]` (data-model.md: `X` só
 * após V-3; o formulário de hoje aceita só dígito). */
function validarDigitoConta(valor) {
  const str = typeof valor === 'string' ? valor : String(valor ?? '');
  return REGEX_DIGITO_CONTA.test(str);
}

// --- PIX / e-mail (2.2.4) ---------------------------------------------------

function validarChavePix(tipo, chave) {
  if (!TIPOS_CHAVE_PIX.includes(tipo)) return false;
  switch (tipo) {
    case 'CPF':
      return validarDocumento(chave).valido && validarDocumento(chave).tipo === 'PF';
    case 'CNPJ':
      return validarDocumento(chave).valido && validarDocumento(chave).tipo === 'PJ';
    case 'EMAIL':
      return typeof chave === 'string' && chave.length <= 254 && REGEX_EMAIL.test(chave);
    case 'TELEFONE':
      return REGEX_TELEFONE.test(somenteDigitos(chave));
    case 'ALEATORIA':
      return REGEX_UUID_V4.test(String(chave || ''));
    default:
      return false;
  }
}

function validarEmailComprovante(valor) {
  return typeof valor === 'string' && valor.length > 0 && valor.length <= 254 && REGEX_EMAIL.test(valor);
}

// --- Máscaras de exibição (2.2.5) -------------------------------------------

/** Mesma lógica de fronteira de `hub_adiantamento_mascarar` (SQL): valor
 * inteiro mascarado quando `length <= visiveis`; senão, máscara + últimos
 * `visiveis` caracteres. */
function mascararGenerico(valor, visiveis, charMascara) {
  const str = String(valor ?? '');
  if (str.length <= visiveis) return charMascara.repeat(str.length);
  return charMascara.repeat(str.length - visiveis) + str.slice(-visiveis);
}

/** `documentoMascarado`: pontuação de CPF/CNPJ com os últimos 2 dígitos
 * visíveis (ex.: CPF "***.***.***-41", CNPJ "**.***.*** / ****-99") — para as
 * listas do hub (FR-019, security CHK009). */
function documentoMascarado(documento) {
  const digitos = somenteDigitos(documento);
  const m = mascararGenerico(digitos, 2, '*');
  if (digitos.length === 11) return `${m.slice(0, 3)}.${m.slice(3, 6)}.${m.slice(6, 9)}-${m.slice(9, 11)}`;
  if (digitos.length === 14) return `${m.slice(0, 2)}.${m.slice(2, 5)}.${m.slice(5, 8)}/${m.slice(8, 12)}-${m.slice(12, 14)}`;
  return m;
}

/** `contaMascarada`: últimos 4 dígitos visíveis + dígito (ex.: `••••4521-7`). */
function contaMascarada(conta, digito) {
  return `${mascararGenerico(conta, 4, '•')}-${digito}`;
}

// --- Validação agregada (payload de POST conta-bancaria/solicitacoes) ------

const CAMPOS_CHAVE_PIX = new Set(TIPOS_CHAVE_PIX);
const CAMPOS_TIPO_CONTA = new Set(TIPOS_CONTA);

/**
 * Valida o payload inteiro de `POST /motorista/conta-bancaria/solicitacoes`,
 * na ordem dos campos do contrato. Recusa no PRIMEIRO campo inválido com
 * `{valido:false, motivo:<nomeDoCampoNoContrato>}` (FR-016) — nunca agrega
 * vários erros num payload só, seguindo o padrão `{erro:'DADOS_INVALIDOS',
 * motivo}` do resto da API.
 */
function validarContaBancaria(dados) {
  dados = dados || {};
  const erro = (motivo) => ({ valido: false, motivo });

  const titularNome = typeof dados.titularNome === 'string' ? dados.titularNome.trim() : '';
  if (titularNome.length < 1 || titularNome.length > 120) return erro('titularNome');

  const doc = validarDocumento(dados.titularDocumento);
  if (!doc.valido) return erro('titularDocumento');

  const banco = validarBanco(dados.bancoCodigo);
  if (!banco.valido) return erro('bancoCodigo');

  const agencia = normalizarAgencia(dados.agencia);
  if (!agencia) return erro('agencia');

  const conta = validarConta(dados.conta);
  if (!conta.valido) return erro('conta');

  if (!validarDigitoConta(dados.contaDigito)) return erro('contaDigito');

  if (!CAMPOS_TIPO_CONTA.has(dados.tipoConta)) return erro('tipoConta');

  // Tipos numéricos (CPF/CNPJ/TELEFONE) são gravados só com dígitos — nunca a
  // entrada mascarada (2.6.3). EMAIL e ALEATORIA são gravados como recebidos.
  const TIPOS_CHAVE_SO_DIGITOS = new Set(['CPF', 'CNPJ', 'TELEFONE']);
  let chavePixTipo = null;
  let chavePix = null;
  if (dados.chavePixTipo != null && dados.chavePixTipo !== '') {
    if (!CAMPOS_CHAVE_PIX.has(dados.chavePixTipo)) return erro('chavePixTipo');
    if (!validarChavePix(dados.chavePixTipo, dados.chavePix)) return erro('chavePix');
    chavePixTipo = dados.chavePixTipo;
    chavePix = TIPOS_CHAVE_SO_DIGITOS.has(chavePixTipo) ? somenteDigitos(dados.chavePix) : dados.chavePix;
  }

  let emailComprovante = null;
  if (dados.emailComprovante != null && dados.emailComprovante !== '') {
    if (!validarEmailComprovante(dados.emailComprovante)) return erro('emailComprovante');
    emailComprovante = dados.emailComprovante;
  }

  return {
    valido: true,
    dados: {
      titularNome,
      titularDocumento: doc.documento,
      titularTipo: doc.tipo,
      bancoCodigo: dados.bancoCodigo,
      bancoNome: banco.nome,
      agencia,
      conta: conta.conta,
      contaDigito: String(dados.contaDigito),
      tipoConta: dados.tipoConta,
      chavePixTipo,
      chavePix,
      emailComprovante,
    },
  };
}

module.exports = {
  validarDocumento,
  validarBanco,
  normalizarAgencia,
  validarConta,
  validarDigitoConta,
  validarChavePix,
  validarEmailComprovante,
  documentoMascarado,
  contaMascarada,
  validarContaBancaria,
};

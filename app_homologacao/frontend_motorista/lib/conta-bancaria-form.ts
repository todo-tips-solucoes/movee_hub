/**
 * adiantamento-motorista — lib/conta-bancaria-form.ts (tasks.md 6.4.3)
 *
 * Validação/máscara PURAS do formulário de conta bancária do app — mesma
 * bateria de formatos de `backend/lib/adiantamento-conta.js` (DV de
 * CPF/CNPJ, agência de 4 dígitos, dígito da conta, PIX por tipo), para o
 * motorista ver o erro ANTES de enviar (o backend valida de novo, é a
 * fonte de verdade). Diferença deliberada (CHK018, orientação da onda):
 * `validarBanco` NUNCA duplica o fixture de bancos do backend — recebe a
 * lista AO VIVO de `buscarBancos()` por parâmetro (injeção de dependência).
 *
 * Ref: contracts/motorista-api.md §POST conta-bancaria/solicitacoes;
 * Spec §FR-015, §FR-016; security CHK018.
 */

const REGEX_DIGITO_CONTA = /^[0-9]$/;
const REGEX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REGEX_TELEFONE = /^\d{10,11}$/;
const REGEX_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TipoChavePix = 'CPF' | 'CNPJ' | 'EMAIL' | 'TELEFONE' | 'ALEATORIA';
export type TipoConta = 'CORRENTE' | 'POUPANCA';
export type TipoDocumento = 'PF' | 'PJ' | null;

export interface BancoOpcao {
  codigo: string;
  nome: string;
}

export interface ResultadoDocumento {
  valido: boolean;
  tipo: TipoDocumento;
  documento: string;
}

function somenteDigitos(valor: string | null | undefined): string {
  return String(valor ?? '').replace(/\D/g, '');
}

function calcularDvCpf(base9: number[]): [number, number] {
  let soma = 0;
  for (let i = 0; i < 9; i += 1) soma += base9[i] * (10 - i);
  const dv1 = soma % 11 < 2 ? 0 : 11 - (soma % 11);
  const base10 = [...base9, dv1];
  soma = 0;
  for (let i = 0; i < 10; i += 1) soma += base10[i] * (11 - i);
  const dv2 = soma % 11 < 2 ? 0 : 11 - (soma % 11);
  return [dv1, dv2];
}

function calcularDvCnpj(base12: number[]): [number, number] {
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

/** Valida CPF (11) ou CNPJ (14) por dígito verificador, aceitando entrada
 * mascarada. Rejeita sequências de dígito repetido (mesma checagem do
 * backend — a fórmula de DV padrão dá "válido" para elas por construção). */
export function validarDocumento(valorComOuSemMascara: string): ResultadoDocumento {
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

/** Banco pertence à lista VIVA recebida por parâmetro (nunca um fixture
 * local) — `codigo` sempre string de 3 dígitos, nunca convertido a número. */
export function validarBanco(codigo: string, bancosDisponiveis: BancoOpcao[]): boolean {
  if (typeof codigo !== 'string' || !/^\d{3}$/.test(codigo)) return false;
  return bancosDisponiveis.some((b) => b.codigo === codigo);
}

/** Normaliza agência para 4 dígitos com zero à esquerda. Entrada: só
 * dígitos, 1 a 4 caracteres — qualquer outro caractere é RECUSADO (`null`). */
export function normalizarAgencia(valor: string): string | null {
  const str = String(valor ?? '');
  if (!/^\d{1,4}$/.test(str)) return null;
  return str.padStart(4, '0');
}

/** Conta: 1–20 dígitos, zeros preservados byte-a-byte. */
export function validarConta(valor: string): boolean {
  return /^\d{1,20}$/.test(String(valor ?? ''));
}

/** Dígito da conta: exatamente 1 caractere `[0-9]`. */
export function validarDigitoConta(valor: string): boolean {
  return REGEX_DIGITO_CONTA.test(String(valor ?? ''));
}

export function validarChavePix(tipo: TipoChavePix, chave: string): boolean {
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

export function validarEmailComprovante(valor: string): boolean {
  return typeof valor === 'string' && valor.length > 0 && valor.length <= 254 && REGEX_EMAIL.test(valor);
}

export interface DadosFormularioContaBancaria {
  titularNome: string;
  titularDocumento: string;
  bancoCodigo: string;
  agencia: string;
  conta: string;
  contaDigito: string;
  tipoConta: TipoConta;
  chavePixTipo?: TipoChavePix | '';
  chavePix?: string;
  emailComprovante?: string;
}

export type ResultadoValidacaoForm = { valido: true } | { valido: false; motivo: string };

/** Mesma ordem de campos de `validarContaBancaria` do backend — recusa no
 * PRIMEIRO campo inválido com `{valido:false, motivo:<nomeDoCampo>}`, para o
 * app apontar o mesmo campo que o backend apontaria (FR-016). */
export function validarFormularioContaBancaria(
  dados: DadosFormularioContaBancaria,
  bancosDisponiveis: BancoOpcao[],
): ResultadoValidacaoForm {
  const erro = (motivo: string): ResultadoValidacaoForm => ({ valido: false, motivo });

  const titularNome = dados.titularNome.trim();
  if (titularNome.length < 1 || titularNome.length > 120) return erro('titularNome');

  if (!validarDocumento(dados.titularDocumento).valido) return erro('titularDocumento');

  if (!validarBanco(dados.bancoCodigo, bancosDisponiveis)) return erro('bancoCodigo');

  if (!normalizarAgencia(dados.agencia)) return erro('agencia');

  if (!validarConta(dados.conta)) return erro('conta');

  if (!validarDigitoConta(dados.contaDigito)) return erro('contaDigito');

  if (dados.tipoConta !== 'CORRENTE' && dados.tipoConta !== 'POUPANCA') return erro('tipoConta');

  if (dados.chavePixTipo) {
    if (!validarChavePix(dados.chavePixTipo, dados.chavePix ?? '')) return erro('chavePix');
  }

  if (dados.emailComprovante) {
    if (!validarEmailComprovante(dados.emailComprovante)) return erro('emailComprovante');
  }

  return { valido: true };
}

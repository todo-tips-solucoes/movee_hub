// lancamento-externo — cliente tipado das duas rotas de "pagos por fora"
// (docs/specs/lancamento-externo/contracts/import-lancamento-externo.md §1 e §3).
// DTOs em camelCase (a conversão do payload da RPC é do backend). A resposta NUNCA
// traz CNPJ/nome: só contagem por motivo (FR-031) — por isso nada aqui os modela.

import { HubApiError, criarRequest, mensagemPorCodigo, codigoDoErro } from './api';
import { XLSX_MIME } from './retorno-xlsx';
import { formatBRL } from '@/lib/utils';

export type TipoLancamentoExterno = 'ADIANTAMENTO' | 'AJUSTE_CREDITO';

export const TIPOS_LANCAMENTO_EXTERNO: { value: TipoLancamentoExterno; label: string }[] = [
  { value: 'ADIANTAMENTO', label: 'Adiantamento (deduz do repasse)' },
  { value: 'AJUSTE_CREDITO', label: 'Crédito (soma ao repasse)' },
];

export class LancamentoExternoApiError extends HubApiError {
  readonly name = 'LancamentoExternoApiError';
  constructor(status: number, message: string, codigo?: string, public readonly motivo?: string) {
    super(status, message, codigo);
  }
}

const MENSAGENS: Record<string, string> = {
  PERMISSAO_NEGADA: 'Você não tem permissão para esta ação.',
  FORA_DE_ESCOPO: 'Esta ação só vale para a empresa principal do grupo.',
  APURACAO_NAO_CONFIGURADA: 'A apuração do repasse ainda não está configurada.',
  ARQUIVO_INVALIDO: 'O arquivo não está no formato esperado.',
  PERIODO_INVALIDO: 'Período inválido.',
  LANCAMENTO_NAO_ENCONTRADO: 'Este lançamento não existe mais (talvez já tenha sido excluído). Atualize a lista.',
  SEMANA_JA_FECHADA: 'A semana deste lançamento já foi fechada: o valor está congelado no repasse e não pode ser excluído.',
  EXCLUSAO_DEIXA_LIQUIDO_NEGATIVO: 'Este crédito sustenta uma dedução do mesmo motorista na semana: excluí-lo faria o excedente sumir do repasse. Apagar a dedução e depois o crédito é possível, mas o líquido pode fechar negativo: confira o aviso ao fechar a semana.',
  ID_INVALIDO: 'Lançamento inválido.',
  LIMITE_EXCEDIDO: 'Muitas tentativas em pouco tempo. Aguarde alguns minutos.',
  ERRO_SERVIDOR: 'Erro no servidor. Tente novamente.',
};

const request = criarRequest(
  (status, body) =>
    new LancamentoExternoApiError(
      status, mensagemPorCodigo(MENSAGENS, body, status), codigoDoErro(body),
      typeof body.motivo === 'string' ? body.motivo : undefined,
    ),
);

export interface MotivoContado { motivo: string; total: number }
/** Linha de DEDUÇÃO recusada por exceder o líquido da semana: `linha` é a linha da PLANILHA (cabeçalho = 1). */
export interface ExcedenteLiquido { linha: number; valor: string; liquido: string }
export interface ImportarLancamentosResponse {
  aplicadas: number;
  ignoradas: number;
  ignoradasPorMotivo: MotivoContado[];
  /** Ausente em servidor antigo. Limitado a 50; o total de recusas por esse motivo vem em `ignoradasPorMotivo`. */
  excedentes?: ExcedenteLiquido[];
}
export interface LancamentoExternoItem {
  id: number;
  motorista: string;
  tipo: TipoLancamentoExterno | string;
  sinal: number;
  dataPagamento: string;
  valor: string;
  observacao: string | null;
  criadoEm: string;
  criadoPor: string | null;
  excluivel: boolean;
  /** M3: distingue "semana fechada" de "sem permissão" quando `excluivel` é false. Obrigatório: sem ele a tela chutaria um dos dois. */
  semanaFechada: boolean;
}
export interface ListaLancamentosExternos { itens: LancamentoExternoItem[]; total: number }
export interface ResumoLancamentosExternos {
  qtdDeducao: number;
  totalDeducao: number;
  qtdCredito: number;
  totalCredito: number;
  flagDescontoLigada: boolean;
  /** A2: motoristas com remanescente negativo na semana e o total que não seria pago nem transportado. */
  qtdNegativo: number | null; // null = servidor não informou: o diálogo de fechar trata como desconhecido (exige confirmação)
  totalNegativo: number | null;
}

/** Corpo cru (`ArrayBuffer`) em `XLSX_MIME` — o `tipo` vai na querystring porque o corpo É o arquivo. */
export async function importarLancamentosExternos(tipo: TipoLancamentoExterno, xlsx: ArrayBuffer): Promise<ImportarLancamentosResponse> {
  return request<ImportarLancamentosResponse>(
    `/adiantamentos/repasse/lancamentos-externos?tipo=${encodeURIComponent(tipo)}`,
    { method: 'POST', headers: { 'Content-Type': XLSX_MIME }, body: xlsx },
  );
}

export async function obterResumoLancamentosExternos(periodo: string): Promise<ResumoLancamentosExternos> {
  return request<ResumoLancamentosExternos>(`/adiantamentos/repasse/lancamentos-externos/resumo?periodo=${encodeURIComponent(periodo)}`);
}

export async function listarLancamentosExternos(
  periodo: string, opcoes: { busca?: string; offset?: number; limite?: number } = {},
): Promise<ListaLancamentosExternos> {
  const q = new URLSearchParams({ periodo });
  if (opcoes.busca) q.set('busca', opcoes.busca);
  if (opcoes.offset) q.set('offset', String(opcoes.offset));
  if (opcoes.limite) q.set('limite', String(opcoes.limite));
  return request<ListaLancamentosExternos>(`/adiantamentos/repasse/lancamentos-externos?${q.toString()}`);
}

/** Semana fechada é recusada pelo servidor (409 SEMANA_JA_FECHADA); o botão da tela só reflete `excluivel`. */
export async function excluirLancamentoExterno(id: number): Promise<void> {
  await request<unknown>(`/adiantamentos/repasse/lancamentos-externos/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
}

/** Frase do contrato (a chave única) — o teste de backend confere que ela é esta, literalmente. */
export const UM_POR_DIA = 'É um lançamento por motorista, por dia e por tipo. Se houve dois pagamentos no mesmo dia, some-os numa única linha ANTES de enviar o arquivo.';

/** Motivos de recusa de LINHA (contrato §1) em português. Desconhecido aparece cru, sem texto inventado. */
const MOTIVO_LINHA: Record<string, string> = {
  CNPJ_INVALIDO: 'CNPJ inválido (precisa ter 14 dígitos)',
  CNPJ_SEM_MOTORISTA: 'CNPJ sem motorista cadastrado',
  DATA_INVALIDA: 'Data ilegível',
  DATA_FORA_DA_FAIXA: 'Data fora da faixa aceita',
  EPOCH_ILEGIVEL: 'Não foi possível ler a época de datas do arquivo',
  VALOR_INVALIDO: 'Valor inválido ou menor ou igual a zero',
  VALOR_AMBIGUO: 'Valor ambíguo (ponto de milhar sem decimais)',
  VALOR_FRACAO_DE_CENTAVO: 'Valor com fração de centavo',
  VALOR_ACIMA_DO_TETO: 'Valor acima do teto de R$ 5.000,00 por linha',
  OBSERVACAO_MUITO_LONGA: 'Observação com mais de 500 caracteres',
  VALOR_EXCEDE_LIQUIDO: 'Dedução maior que o líquido da semana do motorista: o excedente sumiria do repasse, então a linha não foi aplicada',
  SEMANA_JA_FECHADA: 'Semana já fechada',
  SEMANA_ANTERIOR_A_APURACAO: 'Semana anterior à primeira apuração (nunca poderia ser fechada)',
  JA_APLICADO: 'Já lançado antes (mesmo valor)',
  VALOR_DIVERGENTE: `Já existe lançamento deste tipo para este CNPJ nesta data com valor diferente: o original foi mantido e o repasse NÃO deduz o valor desta linha. ${UM_POR_DIA} Um lançamento já aplicado não é alterado por novo arquivo: abra "Ver pagos por fora", exclua o lançamento errado e reenvie a linha correta.`,
  DUPLICADA_NO_ARQUIVO: `Esta linha repete o CNPJ e a data de outra linha do arquivo: só a primeira foi aplicada e o repasse NÃO deduz o valor desta. ${UM_POR_DIA}`,
};
export const rotuloMotivoLinha = (m: string) => MOTIVO_LINHA[m] ?? m;

/** "Linha 7: R$ 100,00 excede o líquido disponível de R$ 30,00" — o operador precisa saber quanto cabe. */
export const textoExcedente = (e: ExcedenteLiquido) =>
  `Linha ${e.linha}: ${formatBRL(Number(e.valor))} excede o líquido disponível de ${formatBRL(Number(e.liquido))}`;

/** Motivos de recusa do ARQUIVO inteiro (nada foi aplicado). */
const MOTIVO_ARQUIVO: Record<string, string> = {
  CABECALHO_INVALIDO: 'O cabeçalho não confere. Use as colunas, nesta ordem: CNPJ, Data do pagamento, Valor, Nome, Observação (maiúsculas, acento e coluna vazia sobrando não importam).',
  FORMATO_INVALIDO: 'O arquivo não é uma planilha XLSX válida.',
  ARQUIVO_VAZIO: 'O arquivo não tem nenhuma linha de dados.',
  ARQUIVO_MUITO_GRANDE: 'O arquivo tem mais de 10.000 linhas. Divida em partes menores. Se a planilha tem poucas linhas, copie os dados para uma planilha nova: o Excel guarda a "área usada" depois de apagar linhas.',
  TIPO_INVALIDO: 'Escolha o tipo do lançamento.',
};
export const mensagemErroArquivo = (e: LancamentoExternoApiError) =>
  (e.motivo && MOTIVO_ARQUIVO[e.motivo]) || e.message;

/** Parcela "pago por fora" da decomposição do repasse (valor LÍQUIDO: negativo = dedução).
 * Zero/ausente vira "—"; o sinal é explícito para a conta fechar à vista. */
export function formatarParcelaExterna(valor: string | null | undefined): string {
  const n = Number(valor);
  if (!valor || !Number.isFinite(n) || n === 0) return '—';
  return `${n < 0 ? '−' : '+'} ${formatBRL(Math.abs(n))}`;
}
